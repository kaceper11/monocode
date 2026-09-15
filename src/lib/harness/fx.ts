import {
  acpStopReasonMessage,
  acpUnsupportedControl,
  acpAssertConfigApplied,
  type AcpPermissionOption,
  AcpClient,
  acpAutoOption,
  type AcpHandlers,
} from "./acp";
import { acquireSharedStart } from "./liveStart";
import { nativeModelId } from "../models";
import { AcpSubagents } from "./acpSubagents";
import type { RuntimeMode } from "../session";
import type { JsonRpcId } from "./jsonRpc";
import {
  killChild,
  resolveFxBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  eventsFromAcpUpdate,
  extractModelConfigId,
  fxModeId,
  fxPromptBlocks,
  permissionOptionId,
  permissionRequestFromAcp,
  readConfigOptions,
  resolveSettingConfigId,
  sessionIdFromResult,
  type SessionConfigOption,
} from "./fxProtocol";
import type {
  ApprovalDecision,
  HarnessEvent,
  SendTurnInput,
  SteerTurnInput,
} from "./types";

type SessionSetupResult = {
  sessionId?: string;
  session_id?: string;
  configOptions?: unknown;
};

type PendingApproval = {
  kind?: string;
  optionIds: string[];
  options?: AcpPermissionOption[];
  resolve: (decision: ApprovalDecision) => void;
};

type Live = {
  subagents: AcpSubagents;
  acp: AcpClient;
  acpSessionId: string;
  cwd: string;
  modelConfigId: string;
  configOptions: SessionConfigOption[];
  muteUpdates: boolean;
  cancelled: boolean;
  runtimeMode: RuntimeMode;
  planning: boolean;
  /** Last modeId the provider confirmed, so repeats skip the wire call. */
  appliedModeId?: string;
  approvals: Map<number, PendingApproval>;
  nextRequestId: number;
  onEvent: (event: HarnessEvent) => void;
  turnGeneration: number;
  turns: Promise<void>;
};

type Resume = {
  acpSessionId: string;
  cwd: string;
};

// fx answers `initialize` in well under a second when it can reach a
// credential. A long wait means it is blocked reading the macOS Keychain, not
// working — so fail fast with something actionable instead of stalling.
const INIT_TIMEOUT_MS = 12_000;
const SESSION_TIMEOUT_MS = 45_000;
const CONTROL_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;

const AUTH_HELP =
  "fx has no Vercel AI Gateway credential it can read from here. " +
  "Run `fx login` (or `fx setup`) in a terminal, or export AI_GATEWAY_API_KEY " +
  "so it does not depend on the macOS Keychain.";

/** fx rejects `initialize` itself when it cannot read a credential. */
function fxStartupError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (/needs access|AI Gateway|API key|Keychain/i.test(detail)) {
    return new Error(`${detail.trim()}\n\n${AUTH_HELP}`);
  }
  if (/timed out/i.test(detail)) {
    return new Error(
      `fx did not answer initialize within ${INIT_TIMEOUT_MS / 1000}s. ${AUTH_HELP}`,
    );
  }
  return new Error(`fx did not start. ${detail}`);
}

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();
const startingClients = new Map<string, AcpClient>();

/**
 * Live fx adapter. Spawns `fx acp` and talks Agent Client Protocol.
 * Image/audio prompt blocks are not supported; the composer hides attachments.
 */
export async function sendFxTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await acquireLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  const generation = live.turnGeneration;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      if (liveByThread.get(input.sessionId) !== live || live.turnGeneration !== generation) return;
      live.onEvent = input.onEvent;
      // Posture applies when the queued turn actually runs — applying it at
      // enqueue time would flip the running turn's permission handling.
      live.runtimeMode = input.runtimeMode;
      live.planning = input.intent === "plan";
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await applyModelSelection(live, input);
        if (live.cancelled) return;
        await applyRuntimeMode(
          live,
          input.runtimeMode,
          input.intent === "plan",
        );
        if (live.cancelled) return;
        await prompt(live, input);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  try {
    await live.turns;
  } catch (error) {
    // A timed-out or failed turn leaves fx's process state unknowable. Keep
    // its provider session id, but recycle the child so the next turn can
    // resume instead of inheriting a permanently wedged transport.
    if (liveByThread.get(input.sessionId) === live) {
      await stopFxSession(input.sessionId, true);
    }
    throw error;
  }
}

export async function steerFxTurn(_input: SteerTurnInput): Promise<void> {
  throw new Error("fx does not support steering an in-flight turn");
}

/** MCP asks park for the user where the mode still prompts; the rest are answered locally. */
export function respondFxApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
) {
  const live = liveByThread.get(sessionId);
  const pending = live?.approvals.get(requestId);
  if (!pending) return;
  live!.approvals.delete(requestId);
  pending.resolve(decision);
}

/** Push a UI access-mode change to the provider now rather than next turn. */
export function setFxRuntimeMode(
  sessionId: string,
  runtimeMode: RuntimeMode,
): void {
  const live = liveByThread.get(sessionId);
  if (!live) return;
  const changed = live.runtimeMode !== runtimeMode;
  live.runtimeMode = runtimeMode;
  void applyRuntimeMode(live, runtimeMode, live.planning).catch((error: unknown) => {
    live.onEvent({ type: "session.error", message: error instanceof Error ? error.message : String(error) });
  });
  if (!changed) return;
  // Settle parked asks the new mode would auto-answer; the rest stay parked.
  for (const [requestId, pending] of live.approvals) {
    if (acpAutoOption(runtimeMode, pending.kind, pending.optionIds, pending.options)) {
      live.approvals.delete(requestId);
      pending.resolve("allow");
    }
  }
}

export async function cancelFxTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    const starting = startingClients.get(sessionId);
    if (starting) {
      starting.close(new Error("cancelled"));
      unwatchChild(sessionId);
      await killChild(sessionId).catch(() => undefined);
    }
    return;
  }
  live.turnGeneration += 1;
  live.cancelled = true;
  live.muteUpdates = true;
  for (const [, pending] of live.approvals) pending.resolve("deny");
  live.approvals.clear();
  live.acp.rejectPending(new Error("cancelled"));
  await live.acp
    .notify("session/cancel", { sessionId: live.acpSessionId })
    .catch(() => undefined);
}

export async function stopFxSession(sessionId: string, internal = false): Promise<void> {
  if (!internal && startingByThread.has(sessionId)) cancelledThreads.add(sessionId);
  else cancelledThreads.delete(sessionId);
  const starting = startingClients.get(sessionId);
  starting?.close(new Error("cancelled"));
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.cancelled = true;
    live.muteUpdates = true;
    for (const [, pending] of live.approvals) pending.resolve("deny");
    live.approvals.clear();
  }
  live?.acp.close();
  if (live || starting) {
    unwatchChild(sessionId);
    await killChild(sessionId).catch(() => undefined);
  }
}

export async function forgetFxSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopFxSession(sessionId);
}

export function bindFxSession(
  threadId: string,
  acpSessionId: string,
  cwd: string,
): void {
  const sessionId = acpSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { acpSessionId: sessionId, cwd });
}

const startingByThread = new Map<string, Promise<Live>>();

function acquireLive(input: Parameters<typeof ensureLive>[0]): Promise<Live> {
  return acquireSharedStart(input.sessionId, liveByThread, startingByThread, () => ensureLive(input));
}

async function ensureLive(input: SendTurnInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    return existing;
  }
  if (existing) {
    resumeByThread.delete(input.sessionId);
    await stopFxSession(input.sessionId, true);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canLoad = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  if (cancelledThreads.has(input.sessionId)) throw new Error("cancelled");
  const { path } = await resolveFxBinary(input.cwd);
  if (cancelledThreads.has(input.sessionId)) throw new Error("cancelled");
  const handlers: AcpHandlers = {};
  const acp = new AcpClient(input.sessionId, handlers);
  startingClients.set(input.sessionId, acp);
  const liveRef: { current: Live | null } = { current: null };
  const muteGate = { current: false };

  handlers.onNotification = (method, params) => {
    if (muteGate.current) return;
    const live = liveRef.current;
    if (!live || live.muteUpdates) return;
    handleNotification(live, method, params);
  };
  handlers.onRequest = (id, method, params) => {
    const live = liveRef.current;
    if (!live) {
      void acp
        .respondError(id, {
          code: -32601,
          message: `Method not found: ${method}`,
        })
        .catch(() => undefined);
      return;
    }
    void handleRequest(live, id, method, params).catch((error) => {
      console.debug("[monocode] fx request handler failed", error);
      (liveRef.current?.onEvent ?? input.onEvent)({ type: "session.error", message: error instanceof Error ? error.message : String(error) });
      void acp
        .respondError(id, { code: -32603, message: "Internal error" })
        .catch(() => undefined);
    });
  };

  // ensureLive runs once per session, so these handlers outlive the turn that
  // created them. Routing through the live record keeps them on the *current*
  // turn's listener — capturing `input.onEvent` meant every exit and stderr
  // error after turn 1 was addressed to a finished turn and silently dropped,
  // leaving the session spinning on "Working…" forever.
  const emit = (event: HarnessEvent) => {
    (liveRef.current?.onEvent ?? input.onEvent)(event);
  };

  watchChild(
    input.sessionId,
    (line) => acp.pushLine(line),
    (code) => {
      acp.close(new Error("fx exited"));
      liveByThread.delete(input.sessionId);
      const live = liveRef.current;
      if (live) {
        // Exit settles parked asks so the provider request and the UI card
        // both close instead of lingering on a dead child.
        for (const [, pending] of live.approvals) pending.resolve("deny");
        live.approvals.clear();
      }
      emit({ type: "session.ended", code });
    },
    (line) => {
      console.debug("[monocode] fx stderr", line);
      if (/Fx needs access|AI Gateway|not start/i.test(line)) {
        emit({ type: "session.error", message: line.trim() });
      }
    },
  );

  try {
    await spawnChild(input.sessionId, path, fxSpawnArgs(input.model, input.cwd), input.cwd);

    if (cancelledThreads.has(input.sessionId)) throw new Error("cancelled");
    try {
      await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        INIT_TIMEOUT_MS,
      );
    } catch (error) {
      throw fxStartupError(error);
    }

    let setup: SessionSetupResult | undefined;
    let acpSessionId: string | undefined;
    let didLoad = false;

    if (canLoad && resume) {
      try {
        setup = await acp.request<SessionSetupResult>(
          "session/resume",
          { sessionId: resume.acpSessionId },
          SESSION_TIMEOUT_MS,
        );
        acpSessionId = sessionIdFromResult(setup) ?? resume.acpSessionId;
        didLoad = true;
      } catch (error) {
        if (!acpUnsupportedControl(error)) throw new Error(`Could not resume the saved conversation; its binding was preserved. ${error instanceof Error ? error.message : String(error)}`);
        muteGate.current = true;
        try {
          setup = await acp.request<SessionSetupResult>(
            "session/load",
            {
              sessionId: resume.acpSessionId,
              cwd: input.cwd,
              mcpServers: [],
            },
            SESSION_TIMEOUT_MS,
          );
          acpSessionId = sessionIdFromResult(setup) ?? resume.acpSessionId;
          didLoad = true;
        } catch (error) {
          throw new Error(`Could not load the saved conversation; its binding was preserved. ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          muteGate.current = false;
        }
      }
    }

    if (!acpSessionId) {
      setup = await acp.request<SessionSetupResult>(
        "session/new",
        { cwd: input.cwd, mcpServers: [] },
        SESSION_TIMEOUT_MS,
      );
      acpSessionId = sessionIdFromResult(setup);
    }
    if (!acpSessionId) throw new Error("fx did not return a session id");

    const configOptions = readConfigOptions(setup?.configOptions);
    const live: Live = {
      subagents: new AcpSubagents(),
      acp,
      acpSessionId,
      cwd: input.cwd,
      modelConfigId: extractModelConfigId(configOptions),
      configOptions,
      muteUpdates: didLoad,
      cancelled: false,
      runtimeMode: input.runtimeMode,
      planning: input.intent === "plan",
      approvals: new Map(),
      nextRequestId: 1_000_000,
      onEvent: input.onEvent,
      turnGeneration: 0,
      turns: Promise.resolve(),
    };
    if (cancelledThreads.has(input.sessionId)) throw new Error("cancelled");
    startingClients.delete(input.sessionId);
    liveRef.current = live;
    liveByThread.set(input.sessionId, live);
    resumeByThread.set(input.sessionId, {
      acpSessionId,
      cwd: input.cwd,
    });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: acpSessionId,
    });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    acp.close(error instanceof Error ? error : new Error(String(error)));
    await stopFxSession(input.sessionId, true);
    if (startingClients.get(input.sessionId) === acp) startingClients.delete(input.sessionId);
    throw error;
  }
}

async function applyModelSelection(
  live: Live,
  input: SendTurnInput,
): Promise<void> {
  const base = nativeModelId(input.model, input.cwd);
  const settings = input.modelSettings ?? {};
  const modelConfigId =
    live.modelConfigId === "provider" ? "model" : live.modelConfigId;

  await setConfigOption(live, modelConfigId, base);

  for (const [settingId, value] of Object.entries(settings)) {
    const configId = resolveSettingConfigId(live.configOptions, settingId);
    if (!configId || configId === "provider") throw new Error(`fx does not support the selected ${settingId} setting.`);
    await setConfigOption(live, configId, value);
  }
}

async function applyRuntimeMode(
  live: Live,
  runtimeMode: RuntimeMode,
  planning = false,
): Promise<void> {
  // Unsupported mode control is non-fatal because handlePermission remains a
  // backstop. Transport failures and timeouts are rethrown so the wedged child
  // is recycled rather than leaving this turn pending forever.
  const modeId = planning ? "ask" : fxModeId(runtimeMode);
  if (modeId === live.appliedModeId) return;
  await live.acp
    .request(
      "session/set_mode",
      {
        sessionId: live.acpSessionId,
        modeId,
      },
      CONTROL_TIMEOUT_MS,
    )
    .then(() => {
      live.appliedModeId = modeId;
    })
    .catch((error: unknown) => {
      ignoreUnsupportedControl("set_mode", error);
    });
}

async function setConfigOption(
  live: Live,
  configId: string,
  value: string | boolean,
): Promise<void> {
  const encoded = String(value);
  const current = live.configOptions.find((option) => option.id === configId);
  if (current && String(current.currentValue ?? "") === encoded) return;

  const result = await live.acp.request<SessionSetupResult>(
    "session/set_config_option",
    {
      sessionId: live.acpSessionId,
      configId,
      value: encoded,
    },
    CONTROL_TIMEOUT_MS,
  );
  if (result?.configOptions) {
    live.configOptions = readConfigOptions(result.configOptions);
    acpAssertConfigApplied(live.configOptions, configId, value);
    live.modelConfigId = extractModelConfigId(live.configOptions);
  }
}

function fxSpawnArgs(model: string, cwd?: string): string[] {
  const native = nativeModelId(model, cwd).trim();
  return native ? ["acp", "--model", native] : ["acp"];
}

async function prompt(live: Live, input: SendTurnInput): Promise<void> {
  try {
    const blocks = fxPromptBlocks(input.text);
    if (blocks.length === 0) return;
    const result = await live.acp.request<{ stopReason?: string }>(
      "session/prompt",
      {
        sessionId: live.acpSessionId,
        prompt: blocks,
      },
      PROMPT_TIMEOUT_MS,
    );
    if (live.cancelled) return;
    const stopMessage = acpStopReasonMessage("Fx", result?.stopReason ?? "");
    if (stopMessage) live.onEvent({ type: "session.error", message: stopMessage });
    live.onEvent({ type: "message.completed" });
    live.onEvent({ type: "reasoning.completed" });
  } catch (error) {
    if (live.cancelled) return;
    const detail = error instanceof Error ? error.message : String(error);
    live.onEvent({
      type: "session.error",
      message: /needs access|AI Gateway|API key|Keychain/i.test(detail)
        ? `${detail.trim()}\n\n${AUTH_HELP}`
        : detail,
    });
    throw error;
  }
}

function ignoreUnsupportedControl(method: string, error: unknown): void {
  console.debug(`[monocode] fx ${method} failed`, error);
  if (!acpUnsupportedControl(error)) throw error;
}

function handleNotification(live: Live, method: string, params: unknown) {
  if (method !== "session/update") return;
  for (const event of live.subagents.route(params, eventsFromAcpUpdate(params))) {
    live.onEvent(event);
  }
}

async function handleRequest(
  live: Live,
  id: JsonRpcId,
  method: string,
  params: unknown,
) {
  if (method === "session/request_permission") {
    await handlePermission(live, id, params);
    return;
  }
  await live.acp
    .respondError(id, {
      code: -32601,
      message: `Method not found: ${method}`,
    })
    .catch(() => undefined);
}

/**
 * fx polices its own permissions in `code` mode, so only asks it considers
 * elevated reach us. Supervised still parks them for the user; auto-accept-
 * edits auto-allows edits; auto and full-access answer everything locally.
 */
async function handlePermission(live: Live, id: JsonRpcId, params: unknown) {
  const request = permissionRequestFromAcp(params);
  if (live.cancelled || live.muteUpdates) {
    // A request landing after cancel/stop must still be answered — the
    // server holds its turn open until it gets a response.
    await live.acp
      .respond(id, { outcome: { outcome: "cancelled" } })
      .catch(() => undefined);
    return;
  }
  if (request.callId) {
    live.onEvent({
      type: "tool.updated",
      callId: request.callId,
      title: request.title,
      kind: request.kind,
      preview: request.preview,
    });
  }
  if (live.planning) {
    const optionId = permissionOptionId(
      request.kind === "read" || request.kind === "search" ? "allow" : "deny",
      request.optionIds,
      request.options,
    );
    await live.acp
      .respond(
        id,
        optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } },
      )
      .catch(() => undefined);
    return;
  }
  const auto = acpAutoOption(
    live.runtimeMode,
    request.kind,
    request.optionIds,
    request.options,
  );
  if (auto) {
    await live.acp
      .respond(id, { outcome: { outcome: "selected", optionId: auto } })
      .catch(() => undefined);
    return;
  }

  const requestId = typeof id === "number" ? id : (live.nextRequestId += 1);
  live.onEvent({
    type: "approval.requested",
    requestId,
    title: request.title,
    kind: request.kind,
    callId: request.callId,
    preview: request.preview,
  });
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    live.approvals.set(requestId, {
      kind: request.kind,
      optionIds: request.optionIds,
      options: request.options,
      resolve,
    });
  });
  live.approvals.delete(requestId);
  live.onEvent({ type: "approval.resolved", requestId, decision });
  const optionId = live.cancelled || live.muteUpdates ? undefined : permissionOptionId(decision, request.optionIds, request.options);
  await live.acp
    .respond(
      id,
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    )
    .catch(() => undefined);
}
