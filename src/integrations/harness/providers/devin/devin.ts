import { AcpClient, type AcpHandlers } from "../../core/acp.ts";
import { acpAssertConfigApplied, type AcpPermissionOption } from "../../core/acpProtocol.ts";
import { findModel, nativeModelId } from "../../../../features/sessions/model/models.ts";
import { pathKey } from "../../../../shared/lib/paths.ts";
import type { RuntimeMode } from "../../../../features/sessions/model/session.ts";
import type { UserQuestionReply } from "../../../../features/sessions/model/userQuestion.ts";
import { questionPromptTitle } from "../../../../features/sessions/model/userQuestion.ts";
import { AcpSubagents } from "../../core/acpSubagents.ts";
import type { JsonRpcId } from "../../core/jsonRpc.ts";
import {
  killChild,
  resolveDevinBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child.ts";
import {
  AUTH_HELP,
  DEVIN_CLIENT_CAPABILITIES,
  DEVIN_CLIENT_INFO,
  asRecord,
  devinAuthError,
  devinAutoOption,
  devinCommandsFromUpdate,
  devinConfigOptions,
  devinCurrentModelId,
  devinElicitation,
  devinElicitationResult,
  devinEventsFromUpdate,
  devinModeId,
  devinModeConfigOption,
  devinModeIdsFromConfig,
  devinModesFromSetup,
  devinModelConfigId,
  devinModelSelectionForUid,
  devinPermissionOptionId,
  devinPermissionRequest,
  devinPromptBlocks,
  devinSpawnArgs,
  devinStopReasonMessage,
  isDevinAuthMessage,
  sessionIdFromResult,
  stringField,
  type DevinConfigOption,
} from "./devinProtocol";
import {
  type CommandContext,
  type NativeCommand,
  type NativeCommandProvider,
} from "../../core/nativeCommands.ts";
import { acquireSharedStart } from "../../core/liveStart.ts";
import { resolveSettingConfigId } from "../antigravity/antigravityProtocol.ts";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  HarnessSessionInput,
  SendTurnInput,
  SteerTurnInput,
} from "../../core/types.ts";

/** A parked permission request, kept with enough context to re-decide it when
 * the access mode changes mid-conversation. */
type PendingApproval = {
  kind?: string;
  optionIds: string[];
  options?: AcpPermissionOption[];
  resolve: (decision: ApprovalDecision) => void;
};

type Live = {
  threadId: string;
  acp: AcpClient;
  acpSessionId: string;
  cwd: string;
  /** run_subagent child activity routed onto its parent's transcript row. */
  subagents: AcpSubagents;
  modelConfigId: string;
  configOptions: DevinConfigOption[];
  /** UI request sequence independent of provider wire ids. */
  nextRequestId: number;
  modeIds: string[];
  currentModeId?: string;
  desiredModeId?: string;
  modeUpdates: Promise<void>;
  commands: NativeCommand[];
  promptInFlight: number;
  promptEpoch: number;
  muteUpdates: boolean;
  cancelled: boolean;
  runtimeMode: RuntimeMode;
  planning: boolean;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<string, PendingApproval>;
  questions: Map<string, (reply: UserQuestionReply) => void>;
  turnGeneration: number;
  turns: Promise<void>;
};

type Resume = {
  acpSessionId: string;
  cwd: string;
};

const INIT_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 45_000;
const CONTROL_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();
const startingClients = new Map<string, AcpClient>();
const commandListeners = new Map<
  string,
  Set<(commands: NativeCommand[]) => void>
>();

/** Live Devin ACP adapter. Follow-ups use the existing serialized turn queue. */
export async function sendDevinTurn(input: SendTurnInput): Promise<void> {
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
      // Posture is set when this send actually runs so a queued turn does
      // not flip the running turn's auto-permission behavior mid-flight.
      live.runtimeMode = input.runtimeMode;
      live.planning = input.intent === "plan";
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await applyModelSelection(live, input);
        if (live.cancelled) return;
        await applyRuntimeMode(live, input.sessionId, input.runtimeMode, input.intent === "plan");
        if (live.cancelled) return;
        input.onAccepted?.();
        await prompt(live, input);
        await live.acp.waitForPrompts();
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  try {
    await live.turns;
  } catch (error) {
    // A failed turn leaves Devin's transport state unknowable. Keep the
    // provider session id but recycle the child so the next turn resumes.
    if (liveByThread.get(input.sessionId) === live) {
      await stopDevinSession(input.sessionId, true);
    }
    throw error;
  }
}

export async function compactDevinContext(
  input: CompactContextInput,
): Promise<void> {
  let live = liveByThread.get(input.sessionId);
  if (!live || pathKey(live.cwd) !== pathKey(input.cwd)) {
    try {
      live = await acquireLive(input);
    } catch (error) {
      cancelledThreads.delete(input.sessionId);
      throw error;
    }
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  const generation = live.turnGeneration;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      if (liveByThread.get(input.sessionId) !== live || live.turnGeneration !== generation) return;
      live.onEvent = input.onEvent;
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await applyModelSelection(live, input);
        if (live.cancelled) return;
        live.onEvent({ type: "status", text: "Compacting context…" });
        await prompt(live, { ...input, text: "/compact", attachments: [] });
        await live.acp.waitForPrompts();
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  try {
    await live.turns;
  } catch (error) {
    if (liveByThread.get(input.sessionId) === live) {
      await stopDevinSession(input.sessionId, true);
    }
    throw error;
  }
}

export async function steerDevinTurn(_input: SteerTurnInput): Promise<void> {
  throw new Error("Devin does not support steering an in-flight ACP turn");
}

export function respondDevinApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
) {
  liveByThread
    .get(sessionId)
    ?.approvals.get(String(requestId))
    ?.resolve(decision);
}

/**
 * Apply a UI access-mode change through the provider config option and
 * settle parked asks the new mode auto-answers so they do not linger for the
 * user.
 */
export function setDevinRuntimeMode(
  sessionId: string,
  runtimeMode: RuntimeMode,
): void {
  const live = liveByThread.get(sessionId);
  if (!live) return;
  const changed = live.runtimeMode !== runtimeMode;
  live.runtimeMode = runtimeMode;
  const generation = live.turnGeneration;
  void applyRuntimeMode(live, sessionId, runtimeMode, live.planning).then(() => {
    if (!changed || !requestIsActive(live) || live.turnGeneration !== generation ||
        live.runtimeMode !== runtimeMode) return;
    for (const [key, pending] of live.approvals) {
      if (!devinAutoOption(runtimeMode, pending.kind, pending.optionIds, pending.options)) continue;
      live.approvals.delete(key);
      pending.resolve("allow");
    }
  }).catch((error: unknown) => {
    if (liveByThread.get(sessionId) !== live || live.cancelled || live.muteUpdates ||
        live.turnGeneration !== generation || live.runtimeMode !== runtimeMode) return;
    live.onEvent({ type: "session.error", message: error instanceof Error ? error.message : String(error) });
  });
}

export function respondDevinQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
) {
  liveByThread.get(sessionId)?.questions.get(String(requestId))?.(reply);
}

/** Settle parked approvals/questions so handlers can't outlive the child. */
function settlePending(live: Live) {
  for (const [, pending] of live.approvals) pending.resolve("deny");
  live.approvals.clear();
  for (const [, resolve] of live.questions) resolve({ kind: "skipped" });
  live.questions.clear();
}

/** Push the empty command set so slash menus drop a dead session's commands. */
function clearCommands(live: Live) {
  live.commands = [];
  const listeners = commandListeners.get(
    commandContextKey({ sessionId: live.threadId, cwd: live.cwd }),
  );
  for (const listener of listeners ?? []) listener(live.commands);
}

export async function cancelDevinTurn(sessionId: string): Promise<void> {
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
  settlePending(live);
  live.acp.rejectPending(new Error("cancelled"));
  await live.acp
    .notify("session/cancel", { sessionId: live.acpSessionId })
    .catch(() => undefined);
}

export async function stopDevinSession(sessionId: string, internal = false): Promise<void> {
  if (!internal && startingByThread.has(sessionId)) cancelledThreads.add(sessionId);
  else cancelledThreads.delete(sessionId);
  const starting = startingClients.get(sessionId);
  starting?.close(new Error("cancelled"));
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    // Mark the in-flight turn cancelled so an intentional stop does not
    // surface "Devin exited" as a session error.
    live.cancelled = true;
    live.muteUpdates = true;
    clearCommands(live);
    settlePending(live);
  }
  live?.acp.close();
  // Only kill a child this adapter owns — after a harness switch another
  // adapter may hold a live child under the same session id.
  if (live || starting) {
    unwatchChild(sessionId);
    await killChild(sessionId).catch(() => undefined);
  }
}

export async function forgetDevinSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopDevinSession(sessionId);
}

export function bindDevinSession(
  threadId: string,
  acpSessionId: string,
  cwd: string,
): void {
  const sessionId = acpSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { acpSessionId: sessionId, cwd });
}

/** Provider commands exist only inside a live Devin session. */
export const devinCommandProvider: NativeCommandProvider = {
  rawSlashCommands: true,
  async discover(context) {
    const live = context.sessionId
      ? liveByThread.get(context.sessionId)
      : undefined;
    if (
      live &&
      pathKey(live.cwd) === pathKey(context.cwd)
    ) {
      return live.commands;
    }
    return [];
  },
  subscribe(context, onCommands) {
    const key = commandContextKey(context);
    let listeners = commandListeners.get(key);
    if (!listeners) commandListeners.set(key, (listeners = new Set()));
    listeners.add(onCommands);
    const live = context.sessionId
      ? liveByThread.get(context.sessionId)
      : undefined;
    if (
      live?.commands.length &&
      pathKey(live.cwd) === pathKey(context.cwd)
    ) {
      onCommands(live.commands);
    }
    return () => {
      listeners.delete(onCommands);
      if (!listeners.size) commandListeners.delete(key);
    };
  },
};

function commandContextKey(context: CommandContext): string {
  return `${context.sessionId ?? ""}\n${pathKey(context.cwd)}`;
}

/** In-flight cold starts: a prewarm and a send share one spawn. */
const startingByThread = new Map<string, Promise<Live>>();

/** ensureLive wrapper that dedupes concurrent cold starts of one thread. */
async function acquireLive(
  input: HarnessSessionInput,
  keepExisting = false,
): Promise<Live> {
  return acquireSharedStart(
    input.sessionId,
    liveByThread,
    startingByThread,
    () => ensureLive(input),
    keepExisting,
  );
}

/**
 * Warm the provider session ahead of a prompt. No-ops when a live host
 * already serves the thread so a prewarm cannot steal a running turn's
 * event sink — or recycle the host a racing send just spawned.
 */
export async function prewarmDevinSession(
  input: HarnessSessionInput,
): Promise<void> {
  if (liveByThread.has(input.sessionId)) return;
  await acquireLive(input, true);
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (existing && pathKey(existing.cwd) === pathKey(input.cwd)) {
    // Posture stays with the running turn; a queued send stamps its own
    // runtimeMode/planning when its task actually starts.
    return existing;
  }
  if (existing) {
    await stopDevinSession(input.sessionId, true);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canLoad = resume != null && pathKey(resume.cwd) === pathKey(input.cwd);
  if (resume && !canLoad) {
    resumeByThread.delete(input.sessionId);
  }

  if (cancelledThreads.has(input.sessionId)) throw new Error("cancelled");
  const { path } = await resolveDevinBinary(input.cwd);
  if (cancelledThreads.has(input.sessionId)) throw new Error("cancelled");
  const handlers: AcpHandlers = {};
  const acp = new AcpClient(input.sessionId, handlers);
  startingClients.set(input.sessionId, acp);
  const liveRef: { current: Live | null } = { current: null };
  // The server may emit session/update (commands, mode, config, or the
  // session/load transcript replay) before the live record exists; buffer
  // everything and replay it once installed — live.muteUpdates then decides
  // which of the replayed events reach the UI.
  const earlyNotifications: { method: string; params: unknown }[] = [];
  let earlyNotificationChars = 0;
  /** Dedupes repeated identical auth-error stderr lines into one block. */
  let lastAuthLine: string | undefined;

  handlers.onNotification = (method, params) => {
    const live = liveRef.current;
    if (!live) {
      // Bound startup replay; fail visibly instead of silently dropping events.
      earlyNotificationChars += JSON.stringify({ method, params }).length;
      if (earlyNotifications.length >= 256 || earlyNotificationChars > 4 * 1024 * 1024) {
        acp.close(new Error("Agent exceeded the startup notification limit"));
        earlyNotifications.length = 0;
        return;
      }
      earlyNotifications.push({ method, params });
      return;
    }
    handleNotification(live, method, params);
  };
  handlers.onRequest = (id, method, params) => {
    const live = liveRef.current;
    if (method === "_cognition.ai/request_diagnostics") {
      void acp.respond(id, {}).catch(() => undefined);
      return;
    }
    if (!live) {
      if (method === "session/request_permission" || method === "elicitation/create") {
        void acp.respond(id, method === "session/request_permission"
          ? { outcome: { outcome: "cancelled" } } : { action: "cancel" }).catch(() => undefined);
        return;
      }
      void acp
        .respondError(id, {
          code: -32601,
          message: `Method not found: ${method}`,
        })
        .catch(() => undefined);
      return;
    }
    void handleRequest(live, id, method, params).catch((err) => {
      console.debug("[monocode] devin request handler failed", err);
      emit({ type: "session.error", message: err instanceof Error ? err.message : String(err) });
      void acp
        .respondError(id, { code: -32603, message: "Internal error" })
        .catch(() => undefined);
    });
  };

  // These handlers outlive the turn that created them; routing through the
  // live record keeps exit/stderr events on the current turn's listener.
  const emit = (event: HarnessEvent) => {
    (liveRef.current?.onEvent ?? input.onEvent)(event);
  };

  watchChild(
    input.sessionId,
    (line) => acp.pushLine(line),
    (code) => {
      acp.close(new Error("Devin exited"));
      const live = liveByThread.get(input.sessionId);
      liveByThread.delete(input.sessionId);
      if (live) {
        live.muteUpdates = true;
        clearCommands(live);
        settlePending(live);
      }
      emit({ type: "session.ended", code });
    },
    (line) => {
      console.debug("[monocode] devin stderr", line);
      if (isDevinAuthMessage(line) && line !== lastAuthLine) {
        lastAuthLine = line;
        emit({
          type: "session.error",
          message: `${line.trim()}\n\n${AUTH_HELP}`,
        });
      }
    },
  );

  try {
    await spawnChild(input.sessionId, path, devinSpawnArgs(), input.cwd, undefined, "devin");
  } catch (error) {
    unwatchChild(input.sessionId);
    acp.close(error instanceof Error ? error : new Error(String(error)));
    startingClients.delete(input.sessionId);
    throw error;
  }

  try {
    if (cancelledThreads.has(input.sessionId)) throw new Error("cancelled");
    let initResult: unknown;
    try {
      initResult = await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: DEVIN_CLIENT_CAPABILITIES,
          clientInfo: DEVIN_CLIENT_INFO,
        },
        INIT_TIMEOUT_MS,
      );
    } catch (error) {
      throw devinAuthError(error);
    }
    const agentCaps = asRecord(asRecord(initResult)?.agentCapabilities);
    const supportsLoad = agentCaps?.loadSession === true;

    let setup: unknown;
    let acpSessionId: string | undefined;
    let didLoad = false;

    if (canLoad && !supportsLoad) throw new Error("This agent cannot resume the saved conversation. Its binding was preserved; start a new chat to continue without its context.");
    if (canLoad && resume && supportsLoad) {
      try {
        setup = await acp.request(
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
      } catch (loadError) {
        throw new Error(`Could not resume the saved conversation; its binding was preserved. ${loadError instanceof Error ? loadError.message : String(loadError)}`);
      }
    }

    if (!acpSessionId) {
      try {
        setup = await acp.request(
          "session/new",
          { cwd: input.cwd, mcpServers: [] },
          SESSION_TIMEOUT_MS,
        );
      } catch (error) {
        throw devinAuthError(error, "create a session");
      }
      acpSessionId = sessionIdFromResult(setup);
    }
    if (!acpSessionId) throw new Error("Devin did not return a session id");

    const configOptions = devinConfigOptions(asRecord(setup)?.configOptions);
    const modes = devinModesFromSetup(setup);
    const configMode = devinModeConfigOption(configOptions)?.currentValue;
    const live: Live = {
      threadId: input.sessionId,
      acp,
      acpSessionId,
      cwd: input.cwd,
      subagents: new AcpSubagents(),
      modelConfigId: devinModelConfigId(configOptions),
      configOptions,
      nextRequestId: 1_000_000_000,
      modeIds: modes.availableModeIds.length
        ? modes.availableModeIds
        : devinModeIdsFromConfig(configOptions),
      currentModeId: typeof configMode === "string" ? configMode : modes.currentModeId,
      modeUpdates: Promise.resolve(),
      commands: [],
      promptInFlight: 0,
      promptEpoch: 0,
      muteUpdates: didLoad,
      cancelled: false,
      runtimeMode: input.runtimeMode,
      planning: input.intent === "plan",
      onEvent: input.onEvent,
      approvals: new Map(),
      questions: new Map(),
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
    for (const early of earlyNotifications.splice(0)) {
      handleNotification(live, early.method, early.params);
    }
    return live;
  } catch (error) {
    // Keep a mid-handshake cancel marker for the caller's consume-check.
    const wasCancelled = cancelledThreads.has(input.sessionId);
    acp.close(error instanceof Error ? error : new Error(String(error)));
    await stopDevinSession(input.sessionId, true);
    if (startingClients.get(input.sessionId) === acp) startingClients.delete(input.sessionId);
    if (wasCancelled) cancelledThreads.add(input.sessionId);
    throw error;
  }
}

async function applyModelSelection(
  live: Live,
  input: HarnessSessionInput,
): Promise<void> {
  // Devin folds the reasoning level into the model uid. The picker's
  // `reasoning` setting carries the chosen variant's uid — apply it only when
  // it belongs to the selected model's group.
  const reasoning = input.modelSettings?.reasoning?.trim();
  const offered = findModel(input.model, input.cwd)
    ?.settings?.find((setting) => setting.id === "reasoning")
    ?.options.some((option) => option.value === reasoning);
  const base = (reasoning && offered
    ? reasoning
    : nativeModelId(input.model, input.cwd)
  ).trim();
  if (base) await setConfigOption(live, live.modelConfigId, base);
  for (const [settingId, value] of Object.entries(input.modelSettings ?? {})) {
    // Grouped reasoning is a concrete model uid, not a second config write.
    if (settingId === "reasoning" && offered) continue;
    const configId = resolveSettingConfigId(live.configOptions, settingId);
    if (!configId || configId === "provider" || configId === live.modelConfigId ||
        configId === devinModeConfigOption(live.configOptions)?.id) continue;
    await setConfigOption(live, configId, value);
  }
}

async function applyRuntimeMode(
  live: Live,
  sessionId: string,
  runtimeMode: RuntimeMode,
  planning = false,
): Promise<void> {
  const modeOption = devinModeConfigOption(live.configOptions);
  const advertised = modeOption ? modeOption.options.map((choice) => choice.value) : live.modeIds;
  const desired = devinModeId(runtimeMode, planning, advertised);
  if (!desired) throw new Error(`Devin does not advertise the ${planning ? "plan" : runtimeMode} permission mode.`);
  live.desiredModeId = desired;
  const generation = live.turnGeneration;
  const current = () => liveByThread.get(sessionId) === live &&
    !live.cancelled && !live.muteUpdates && live.turnGeneration === generation;
  // Read the latest selection after the previous write, not its old confirmed cache.
  live.modeUpdates = live.modeUpdates.catch(() => undefined).then(async () => {
    if (!current()) return;
    const wanted = live.desiredModeId;
    if (!wanted || wanted === live.currentModeId) return;
    try {
      const option = devinModeConfigOption(live.configOptions);
      if (option) {
        await setConfigOption(live, option.id, wanted);
      } else {
        await live.acp.request(
          "session/set_mode",
          { sessionId: live.acpSessionId, modeId: wanted },
          CONTROL_TIMEOUT_MS,
        );
      }
    } catch (error) {
      // A timeout/cancel may lose the acknowledgement after the provider applied it.
      live.currentModeId = undefined;
      const option = devinModeConfigOption(live.configOptions);
      if (option) option.currentValue = undefined;
      if (!current() || wanted !== live.desiredModeId) return;
      throw error;
    }
    if (current()) live.currentModeId = wanted;
    else live.currentModeId = undefined;
  });
  // A selection made during preparation must also settle before prompting.
  let pending: Promise<void>;
  do {
    pending = live.modeUpdates;
    await pending;
  } while (current() && pending !== live.modeUpdates);
}

async function setConfigOption(
  live: Live,
  configId: string,
  value: string | boolean,
): Promise<void> {
  const option = live.configOptions.find((entry) => entry.id === configId);
  if (option?.type === "boolean") {
    if (value !== true && value !== false && value !== "true" && value !== "false") {
      throw new Error(`Invalid boolean value for Devin ${configId}.`);
    }
    value = value === true || value === "true";
  }
  if (option?.currentValue === value) return;
  const result = await live.acp.request(
    "session/set_config_option",
    { sessionId: live.acpSessionId, configId, value,
      ...(option?.type === "boolean" ? { type: "boolean" } : {}) },
    CONTROL_TIMEOUT_MS,
  );
  const next = asRecord(result)?.configOptions;
  if (next) {
    mergeConfigOptions(live, devinConfigOptions(next));
    acpAssertConfigApplied(live.configOptions, configId, value);
  }
}

async function prompt(live: Live, input: SendTurnInput): Promise<void> {
  try {
    const blocks = devinPromptBlocks(input.text, input.attachments);
    if (blocks.length === 0) return;
    live.promptInFlight += 1;
    live.promptEpoch += 1;
    let result: unknown;
    try {
      result = await live.acp.request(
        "session/prompt",
        {
          sessionId: live.acpSessionId,
          prompt: blocks,
        },
        PROMPT_TIMEOUT_MS,
      );
    } finally {
      live.promptInFlight -= 1;
      settlePending(live);
    }
    if (live.cancelled) return;
    const stopMessage = devinStopReasonMessage(
      stringField(asRecord(result), "stopReason") ?? "",
    );
    if (stopMessage) {
      live.onEvent({ type: "session.error", message: stopMessage });
    }
    if (live.promptInFlight === 0) {
      live.onEvent({ type: "message.completed" });
      live.onEvent({ type: "reasoning.completed" });
    }
  } catch (error) {
    if (live.cancelled) return;
    const detail = error instanceof Error ? error.message : String(error);
    live.onEvent({
      type: "session.error",
      message: isDevinAuthMessage(detail)
        ? `${detail.trim()}\n\n${AUTH_HELP}`
        : detail,
    });
    throw error;
  }
}

function mergeConfigOptions(live: Live, incoming: DevinConfigOption[]): void {
  for (const option of incoming) {
    const at = live.configOptions.findIndex((entry) => entry.id === option.id);
    if (at >= 0) live.configOptions[at] = option;
    else live.configOptions.push(option);
  }
  live.modelConfigId = devinModelConfigId(live.configOptions);
  const mode = devinModeConfigOption(live.configOptions)?.currentValue;
  if (typeof mode === "string") live.currentModeId = mode;
}

function requestIsActive(live: Live, params?: unknown): boolean {
  const sessionId = stringField(asRecord(params) ?? {}, "sessionId");
  return liveByThread.get(live.threadId) === live && live.promptInFlight > 0 &&
    !live.cancelled && !live.muteUpdates && (!sessionId || sessionId === live.acpSessionId);
}

function handleNotification(live: Live, method: string, params: unknown) {
  if (method !== "session/update") return;
  const rec = asRecord(params);
  const update = asRecord(rec?.update) ?? rec;
  // Late stdout from a recycled child can deliver updates for the dead ACP
  // session; only this session's updates may touch live state.
  const sessionId =
    stringField(rec ?? {}, "sessionId") ?? stringField(update ?? {}, "sessionId");
  if (sessionId && sessionId !== live.acpSessionId) return;
  const kind = String(
    update?.sessionUpdate ?? update?.session_update ?? update?.type ?? "",
  );

  if (kind === "available_commands_update") {
    live.commands = devinCommandsFromUpdate(params);
    const listeners = commandListeners.get(
      commandContextKey({ sessionId: live.threadId, cwd: live.cwd }),
    );
    for (const listener of listeners ?? []) listener(live.commands);
    return;
  }

  if (kind === "current_mode_update") {
    const modeId =
      stringField(update ?? {}, "currentModeId") ??
      stringField(update ?? {}, "current_mode_id");
    if (modeId) live.currentModeId = modeId;
    return;
  }

  if (kind === "config_option_update") {
    const previous = devinCurrentModelId(live.configOptions);
    const incoming = devinConfigOptions(
      update?.configOptions ?? update?.config_options,
    );
    if (incoming.length) {
      mergeConfigOptions(live, incoming);
      const current = devinCurrentModelId(live.configOptions);
      if (current && current !== previous && !live.muteUpdates) {
        const selection = devinModelSelectionForUid(live.configOptions, current, live.cwd);
        live.onEvent({
          type: "session.configChanged",
          model: selection.id,
          ...(selection.reasoning
            ? { modelSettings: { reasoning: selection.reasoning } }
            : {}),
        });
      }
    }
    return;
  }

  // Replays (session/load) and muted windows still update the state above;
  // only transcript events are suppressed.
  if (live.muteUpdates) return;
  for (const event of live.subagents.route(
    params,
    devinEventsFromUpdate(params),
  )) {
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
  if (method === "elicitation/create") {
    const epoch = live.promptEpoch;
    await live.acp.queueQuestion((cancelled) => handleElicitation(live, id, params,
      cancelled || epoch !== live.promptEpoch));
    return;
  }
  await live.acp
    .respondError(id, {
      code: -32601,
      message: `Method not found: ${method}`,
    })
    .catch(() => undefined);
}

async function handlePermission(live: Live, id: JsonRpcId, params: unknown) {
  const request = devinPermissionRequest(params);
  const epoch = live.promptEpoch;
  const active = () => requestIsActive(live, params) && live.promptEpoch === epoch;
  if (!active()) {
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
    const readOnly = request.kind === "read" || request.kind === "search";
    const optionId = devinPermissionOptionId(
      readOnly ? "allow" : "deny",
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

  const auto = devinAutoOption(
    live.runtimeMode,
    request.kind,
    request.optionIds,
    request.options,
  );
  if (auto) {
    await live.acp
      .respond(id, {
        outcome: { outcome: "selected", optionId: auto },
      })
      .catch(() => undefined);
    return;
  }

  // Keep UI identity independent of both string and numeric wire request ids.
  const requestId = ++live.nextRequestId;
  live.onEvent({
    type: "approval.requested",
    requestId,
    title: request.title,
    kind: request.kind,
    callId: request.callId,
    preview: request.preview,
  });

  const key = String(requestId);
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    live.approvals.set(key, {
      kind: request.kind,
      optionIds: request.optionIds,
      options: request.options,
      resolve,
    });
  });
  live.approvals.delete(key);
  live.onEvent({ type: "approval.resolved", requestId, decision });

  const optionId = active() ? devinPermissionOptionId(decision, request.optionIds, request.options) : undefined;
  await live.acp
    .respond(
      id,
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    )
    .catch(() => undefined);
}

async function handleElicitation(live: Live, id: JsonRpcId, params: unknown, cancelled = false) {
  const epoch = live.promptEpoch;
  const active = () => !cancelled && requestIsActive(live, params) && live.promptEpoch === epoch;
  const parsed = active() ? devinElicitation(params) : null;
  if (!parsed) {
    await live.acp
      .respond(id, { action: "cancel" })
      .catch(() => undefined);
    return;
  }
  const requestId = ++live.nextRequestId;
  live.onEvent({
    type: "question.asked",
    requestId,
    title: parsed.title ?? questionPromptTitle(parsed.questions),
    questions: parsed.questions,
  });

  const key = String(requestId);
  while (true) {
    const reply = await new Promise<UserQuestionReply>((resolve) => {
      live.questions.set(key, resolve);
    });
    live.questions.delete(key);
    let result: Record<string, unknown>;
    try {
      result = active() ? devinElicitationResult(reply, parsed.questions, parsed.fields) : { action: "cancel" };
    } catch (error) {
      live.onEvent({ type: "question.error", requestId, message: error instanceof Error ? error.message : String(error) });
      // Keep the same form and request open so the user can correct the value.
      continue;
    }
    live.onEvent({
      type: "question.resolved",
      requestId,
      decision: result.action === "accept" ? "answered" : "skipped",
    });
    await live.acp.respond(id, result).catch(() => undefined);
    return;
  }
}
