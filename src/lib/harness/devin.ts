import { nativeModelId } from "../models";
import { pathKey } from "../paths";
import type { RuntimeMode } from "../session";
import type { UserQuestion, UserQuestionReply } from "../userQuestion";
import { questionPromptTitle } from "../userQuestion";
import { AcpClient, type AcpHandlers } from "./acp";
import {
  killChild,
  resolveDevinBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  AUTH_HELP,
  DEVIN_CLIENT_CAPABILITIES,
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
  devinModeIdsFromConfig,
  devinModesFromSetup,
  devinModelConfigId,
  devinPermissionOptionId,
  devinPermissionRequest,
  devinPromptBlocks,
  devinSpawnArgs,
  sessionIdFromResult,
  stringField,
  type DevinConfigOption,
  type DevinElicitField,
} from "./devinProtocol";
import {
  type CommandContext,
  type NativeCommand,
  type NativeCommandProvider,
} from "./nativeCommands";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  HarnessSessionInput,
  SendTurnInput,
  SteerTurnInput,
} from "./types";

type PendingQuestion = {
  resolve: (reply: UserQuestionReply) => void;
  questions: UserQuestion[];
  fields: DevinElicitField[];
};

type Live = {
  threadId: string;
  acp: AcpClient;
  acpSessionId: string;
  cwd: string;
  modelConfigId: string;
  configOptions: DevinConfigOption[];
  modeIds: string[];
  currentModeId?: string;
  commands: NativeCommand[];
  /** `session/prompt` calls Devin is still answering (main turn plus steers). */
  promptInFlight: number;
  muteUpdates: boolean;
  cancelled: boolean;
  runtimeMode: RuntimeMode;
  planning: boolean;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, (decision: ApprovalDecision) => void>;
  questions: Map<number, PendingQuestion>;
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
const commandListeners = new Map<
  string,
  Set<(commands: NativeCommand[]) => void>
>();

/**
 * Live Devin CLI adapter. Spawns `devin acp` and talks Agent Client Protocol.
 * Devin absorbs a `session/prompt` sent mid-turn as a steer/follow-up, so the
 * steer path writes directly instead of joining the serialized turn queue.
 */
export async function sendDevinTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.runtimeMode = input.runtimeMode;
  live.planning = input.intent === "plan";
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
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
    // A failed turn leaves Devin's transport state unknowable. Keep the
    // provider session id but recycle the child so the next turn resumes.
    if (liveByThread.get(input.sessionId) === live) {
      await stopDevinSession(input.sessionId);
    }
    throw error;
  }
}

export async function compactDevinContext(
  input: CompactContextInput,
): Promise<void> {
  let live = liveByThread.get(input.sessionId);
  if (!live || live.cwd !== input.cwd) {
    live = await ensureLive(input);
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        live.onEvent({ type: "status", text: "Compacting context…" });
        live.promptInFlight += 1;
        try {
          await live.acp.request(
            "session/prompt",
            {
              sessionId: live.acpSessionId,
              prompt: [{ type: "text", text: "/compact" }],
            },
            PROMPT_TIMEOUT_MS,
          );
        } finally {
          live.promptInFlight -= 1;
        }
        if (live.cancelled) return;
        live.onEvent({ type: "message.completed" });
        live.onEvent({ type: "reasoning.completed" });
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  try {
    await live.turns;
  } catch (error) {
    if (liveByThread.get(input.sessionId) === live) {
      await stopDevinSession(input.sessionId);
    }
    throw error;
  }
}

/**
 * Devin accepts `session/prompt` while a turn is running and folds it into
 * the same turn as a steer. Only reachable from the busy path; without a live
 * child there is nothing to steer.
 */
export async function steerDevinTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live || live.cwd !== input.cwd) {
    throw new Error("No active Devin session to steer");
  }
  const blocks = devinPromptBlocks(input.text, input.attachments);
  if (blocks.length === 0) return;
  live.promptInFlight += 1;
  let finished = false;
  try {
    await live.acp.request(
      "session/prompt",
      { sessionId: live.acpSessionId, prompt: blocks },
      PROMPT_TIMEOUT_MS,
    );
    finished = true;
  } finally {
    live.promptInFlight -= 1;
  }
  // A steer that ran as its own turn must still close the streaming blocks;
  // when it folded into a running turn that turn's prompt emits them instead.
  if (finished && !live.cancelled && live.promptInFlight === 0) {
    live.onEvent({ type: "message.completed" });
    live.onEvent({ type: "reasoning.completed" });
  }
}

export function respondDevinApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
) {
  liveByThread.get(sessionId)?.approvals.get(requestId)?.(decision);
}

export function respondDevinQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
) {
  liveByThread.get(sessionId)?.questions.get(requestId)?.resolve(reply);
}

export async function cancelDevinTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  for (const [, resolve] of live.approvals) resolve("deny");
  live.approvals.clear();
  for (const [, pending] of live.questions) pending.resolve({ kind: "skipped" });
  live.questions.clear();
  await live.acp
    .notify("session/cancel", { sessionId: live.acpSessionId })
    .catch(() => undefined);
  live.acp.rejectPending(new Error("cancelled"));
}

export async function stopDevinSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.muteUpdates = true;
    for (const [, resolve] of live.approvals) resolve("deny");
    live.approvals.clear();
    for (const [, pending] of live.questions)
      pending.resolve({ kind: "skipped" });
    live.questions.clear();
  }
  live?.acp.close();
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
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
  return `${context.sessionId ?? ""}${pathKey(context.cwd)}`;
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    existing.onEvent = input.onEvent;
    existing.runtimeMode = input.runtimeMode;
    return existing;
  }
  if (existing) {
    await stopDevinSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canLoad = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveDevinBinary(input.cwd);
  const handlers: AcpHandlers = {};
  const acp = new AcpClient(input.sessionId, handlers);
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
    void handleRequest(live, id, method, params);
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
      liveByThread.delete(input.sessionId);
      emit({ type: "session.ended", code });
    },
    (line) => {
      console.debug("[monocode] devin stderr", line);
      if (/log ?in|sign ?in|not authenticated|unauthori/i.test(line)) {
        emit({
          type: "session.error",
          message: `${line.trim()}\n\n${AUTH_HELP}`,
        });
      }
    },
  );

  await spawnChild(input.sessionId, path, devinSpawnArgs(), input.cwd);

  try {
    let initResult: unknown;
    try {
      initResult = await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: DEVIN_CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
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

    if (canLoad && resume && supportsLoad) {
      muteGate.current = true;
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
        console.debug("[monocode] devin session/load failed", loadError);
        setup = undefined;
        acpSessionId = undefined;
        didLoad = false;
      } finally {
        muteGate.current = false;
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
        throw devinAuthError(error);
      }
      acpSessionId = sessionIdFromResult(setup);
    }
    if (!acpSessionId) throw new Error("Devin did not return a session id");

    const configOptions = devinConfigOptions(asRecord(setup)?.configOptions);
    const modes = devinModesFromSetup(setup);
    const live: Live = {
      threadId: input.sessionId,
      acp,
      acpSessionId,
      cwd: input.cwd,
      modelConfigId: devinModelConfigId(configOptions),
      configOptions,
      modeIds: modes.availableModeIds.length
        ? modes.availableModeIds
        : devinModeIdsFromConfig(configOptions),
      currentModeId: modes.currentModeId,
      commands: [],
      promptInFlight: 0,
      muteUpdates: didLoad,
      cancelled: false,
      runtimeMode: input.runtimeMode,
      planning: input.intent === "plan",
      onEvent: input.onEvent,
      approvals: new Map(),
      questions: new Map(),
      turns: Promise.resolve(),
    };
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
    await stopDevinSession(input.sessionId);
    throw error;
  }
}

async function applyModelSelection(
  live: Live,
  input: HarnessSessionInput,
): Promise<void> {
  const base = nativeModelId(input.model, input.cwd).trim();
  if (!base) return;
  const current = live.configOptions.find(
    (option) => option.id === live.modelConfigId,
  )?.currentValue;
  if (current === base) return;
  await setConfigOption(live, live.modelConfigId, base).catch(
    (error: unknown) => {
      ignoreUnsupportedControl("set_config_option", error);
    },
  );
}

async function applyRuntimeMode(
  live: Live,
  runtimeMode: RuntimeMode,
  planning = false,
): Promise<void> {
  const wanted = devinModeId(runtimeMode, planning, live.modeIds);
  if (!wanted || wanted === live.currentModeId) return;
  await live.acp
    .request(
      "session/set_mode",
      { sessionId: live.acpSessionId, modeId: wanted },
      CONTROL_TIMEOUT_MS,
    )
    .then(() => {
      live.currentModeId = wanted;
    })
    .catch((error: unknown) => {
      ignoreUnsupportedControl("set_mode", error);
    });
}

async function setConfigOption(
  live: Live,
  configId: string,
  value: string,
): Promise<void> {
  const result = await live.acp.request(
    "session/set_config_option",
    { sessionId: live.acpSessionId, configId, value },
    CONTROL_TIMEOUT_MS,
  );
  const next = asRecord(result)?.configOptions;
  if (next) live.configOptions = devinConfigOptions(next);
}

async function prompt(live: Live, input: SendTurnInput): Promise<void> {
  try {
    const blocks = devinPromptBlocks(input.text, input.attachments);
    if (blocks.length === 0) return;
    live.promptInFlight += 1;
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
    }
    if (live.cancelled) return;
    if (stringField(asRecord(result), "stopReason") === "refusal") {
      live.onEvent({
        type: "session.error",
        message: "Devin declined this turn.",
      });
    }
    // A folded steer may still be streaming; whichever prompt resolves last
    // closes the blocks.
    if (live.promptInFlight === 0) {
      live.onEvent({ type: "message.completed" });
      live.onEvent({ type: "reasoning.completed" });
    }
  } catch (error) {
    if (live.cancelled) return;
    const detail = error instanceof Error ? error.message : String(error);
    live.onEvent({
      type: "session.error",
      message: /log ?in|sign ?in|auth|credential|unauthori/i.test(detail)
        ? `${detail.trim()}\n\n${AUTH_HELP}`
        : detail,
    });
    throw error;
  }
}

function ignoreUnsupportedControl(method: string, error: unknown): void {
  console.debug(`[monocode] devin ${method} failed`, error);
  const detail = error instanceof Error ? error.message : String(error);
  if (/timed out|not running|exited|closed|pipe/i.test(detail)) throw error;
}

function handleNotification(live: Live, method: string, params: unknown) {
  if (method !== "session/update") return;
  const rec = asRecord(params);
  const update = asRecord(rec?.update) ?? rec;
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
    const next = devinConfigOptions(
      update?.configOptions ?? update?.config_options,
    );
    if (next.length) {
      live.configOptions = next;
      const current = devinCurrentModelId(next);
      if (current && current !== previous) {
        live.onEvent({
          type: "session.configChanged",
          model: `devin:${current}`,
        });
      }
    }
    return;
  }

  for (const event of devinEventsFromUpdate(params)) {
    live.onEvent(event);
  }
}

async function handleRequest(
  live: Live,
  id: number,
  method: string,
  params: unknown,
) {
  if (method === "session/request_permission") {
    await handlePermission(live, id, params);
    return;
  }
  if (method === "elicitation/create") {
    await handleElicitation(live, id, params);
    return;
  }
  await live.acp
    .respondError(id, {
      code: -32601,
      message: `Method not found: ${method}`,
    })
    .catch(() => undefined);
}

async function handlePermission(live: Live, id: number, params: unknown) {
  const request = devinPermissionRequest(params);
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
  );
  if (auto) {
    await live.acp.respond(id, {
      outcome: { outcome: "selected", optionId: auto },
    });
    return;
  }

  live.onEvent({
    type: "approval.requested",
    requestId: id,
    title: request.title,
    kind: request.kind,
    callId: request.callId,
    preview: request.preview,
  });

  const decision = await new Promise<ApprovalDecision>((resolve) => {
    live.approvals.set(id, resolve);
  });
  live.approvals.delete(id);
  live.onEvent({ type: "approval.resolved", requestId: id, decision });

  const optionId = devinPermissionOptionId(decision, request.optionIds);
  await live.acp
    .respond(
      id,
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    )
    .catch(() => undefined);
}

async function handleElicitation(live: Live, id: number, params: unknown) {
  const parsed = devinElicitation(params);
  if (!parsed) {
    await live.acp
      .respond(id, { action: "cancel" })
      .catch(() => undefined);
    return;
  }
  live.onEvent({
    type: "question.asked",
    requestId: id,
    title: parsed.title ?? questionPromptTitle(parsed.questions),
    questions: parsed.questions,
  });

  const reply = await new Promise<UserQuestionReply>((resolve) => {
    live.questions.set(id, {
      resolve,
      questions: parsed.questions,
      fields: parsed.fields,
    });
  });
  const pending = live.questions.get(id);
  live.questions.delete(id);
  live.onEvent({
    type: "question.resolved",
    requestId: id,
    decision: reply.kind === "answered" ? "answered" : "skipped",
  });

  await live.acp
    .respond(
      id,
      devinElicitationResult(
        reply,
        pending?.questions ?? parsed.questions,
        pending?.fields ?? parsed.fields,
      ),
    )
    .catch(() => undefined);
}
