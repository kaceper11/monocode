import {
  hasLiveCatalog,
  modelsFor,
  nativeModelId,
  setHarnessModels,
} from "../models";
import { pathKey } from "../paths";
import type { RuntimeMode } from "../session";
import type { UserQuestionReply } from "../userQuestion";
import { questionPromptTitle } from "../userQuestion";
import {
  acpAuthError,
  acpAutoOption,
  acpCommandsFromUpdate,
  acpConfigOptions,
  acpCurrentModelId,
  acpElicitation,
  acpElicitationResult,
  acpEventsFromUpdate,
  acpModeId,
  acpModeIdsFromConfig,
  acpModesFromSetup,
  acpModelConfigId,
  acpPermissionOptionId,
  acpPermissionRequest,
  acpPromptBlocks,
  asRecord,
  sessionIdFromResult,
  stringField,
  AcpClient,
  type AcpConfigOption,
  type AcpHandlers,
} from "./acp";
import type { JsonRpcId } from "./jsonRpc";
import {
  killChild,
  resolveCopilotBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  AUTH_HELP,
  COPILOT_AUTH_PATTERN,
  COPILOT_CLIENT_CAPABILITIES,
  copilotCurrentModelId,
  copilotEffortFromSettings,
  copilotModelsFromSetup,
  copilotSpawnArgs,
  copilotStopReasonMessage,
} from "./copilotProtocol";
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

/** A parked permission request, kept with enough context to re-decide it when
 * the access mode changes mid-conversation. */
type PendingApproval = {
  kind?: string;
  optionIds: string[];
  resolve: (decision: ApprovalDecision) => void;
};

type Live = {
  threadId: string;
  acp: AcpClient;
  acpSessionId: string;
  cwd: string;
  /** Reasoning effort this child was launched with (`--effort` is fixed). */
  launchEffort?: string;
  /** Last model the session reported or we set via `session/set_model`. */
  currentModelId?: string;
  /**
   * Set once `session/set_model` succeeds: currentModelId is authoritative
   * because the model config option can keep reporting a stale value.
   */
  modelPinned: boolean;
  /**
   * The model config option's value at pin time. Only that exact stale echo
   * is ignored while pinned; a third value means the server really moved.
   */
  pinnedConfigValue?: string;
  /** Synthetic requestId source for ACP requests with non-numeric ids. */
  nextRequestId: number;
  modelConfigId: string;
  configOptions: AcpConfigOption[];
  modeIds: string[];
  currentModeId?: string;
  commands: NativeCommand[];
  /** `session/prompt` calls Copilot is still answering (main turn plus steers). */
  promptInFlight: number;
  muteUpdates: boolean;
  cancelled: boolean;
  runtimeMode: RuntimeMode;
  planning: boolean;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<string, PendingApproval>;
  questions: Map<string, (reply: UserQuestionReply) => void>;
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
/**
 * Threads whose Copilot build rejected the `--effort` launch flag; their
 * sessions run at the CLI's default effort until forgotten.
 */
const effortUnsupportedThreads = new Set<string>();
const commandListeners = new Map<
  string,
  Set<(commands: NativeCommand[]) => void>
>();

/**
 * Live GitHub Copilot CLI adapter. Spawns `copilot --acp --stdio` and talks
 * Agent Client Protocol. Reasoning effort is a server-launch flag, so an
 * effort change recycles this session's child and reloads its ACP session.
 *
 * The session lifecycle, cancel/stop, approval, elicitation, and command
 * plumbing deliberately mirror devin.ts — keep fixes to those shared
 * mechanics in sync between the two files.
 */
export async function sendCopilotTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      // Posture is set when this send actually runs so a queued turn does
      // not flip the running turn's auto-permission behavior mid-flight.
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
    // A failed turn leaves Copilot's transport state unknowable. Keep the
    // provider session id but recycle the child so the next turn resumes.
    if (liveByThread.get(input.sessionId) === live) {
      await stopCopilotSession(input.sessionId);
    }
    throw error;
  }
}

export async function compactCopilotContext(
  input: CompactContextInput,
): Promise<void> {
  let live = liveByThread.get(input.sessionId);
  if (!live || pathKey(live.cwd) !== pathKey(input.cwd)) {
    try {
      live = await ensureLive(input);
    } catch (error) {
      cancelledThreads.delete(input.sessionId);
      throw error;
    }
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
      await stopCopilotSession(input.sessionId);
    }
    throw error;
  }
}

/**
 * Copilot accepts `session/prompt` while a turn is running and folds it into
 * the same turn as a steer. Only reachable from the busy path; without a live
 * child there is nothing to steer.
 */
export async function steerCopilotTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live || pathKey(live.cwd) !== pathKey(input.cwd)) {
    throw new Error("No active Copilot session to steer");
  }
  const blocks = acpPromptBlocks(input.text, input.attachments);
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

export function respondCopilotApproval(
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
 * Apply a UI access-mode change: push `session/set_mode` to the provider and
 * settle parked asks the new mode auto-answers so they do not linger for the
 * user.
 */
export function setCopilotRuntimeMode(
  sessionId: string,
  runtimeMode: RuntimeMode,
): void {
  const live = liveByThread.get(sessionId);
  if (!live) return;
  const changed = live.runtimeMode !== runtimeMode;
  live.runtimeMode = runtimeMode;
  void applyRuntimeMode(live, runtimeMode, live.planning).catch(
    () => undefined,
  );
  if (!changed) return;
  for (const [key, pending] of live.approvals) {
    if (!acpAutoOption(runtimeMode, pending.kind, pending.optionIds)) {
      continue;
    }
    live.approvals.delete(key);
    pending.resolve("allow");
  }
}

export function respondCopilotQuestion(
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

export async function cancelCopilotTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  settlePending(live);
  await live.acp
    .notify("session/cancel", { sessionId: live.acpSessionId })
    .catch(() => undefined);
  live.acp.rejectPending(new Error("cancelled"));
}

export async function stopCopilotSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    // Mark the in-flight turn cancelled so an intentional stop does not
    // surface "Copilot exited" as a session error.
    live.cancelled = true;
    live.muteUpdates = true;
    clearCommands(live);
    settlePending(live);
  }
  live?.acp.close();
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetCopilotSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  effortUnsupportedThreads.delete(sessionId);
  await stopCopilotSession(sessionId);
}

export function bindCopilotSession(
  threadId: string,
  acpSessionId: string,
  cwd: string,
): void {
  const sessionId = acpSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { acpSessionId: sessionId, cwd });
}

/** Provider commands exist only inside a live Copilot session. */
export const copilotCommandProvider: NativeCommandProvider = {
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

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  // `--effort` is fixed when the server starts, so a reasoning change is the
  // one selection that must recycle this session's child (the ACP session is
  // reloaded afterwards when the server supports it). A build that rejected
  // the flag once keeps launching without it.
  const effort = effortUnsupportedThreads.has(input.sessionId)
    ? undefined
    : copilotEffortFromSettings(input.modelSettings);
  const existing = liveByThread.get(input.sessionId);
  if (
    existing &&
    pathKey(existing.cwd) === pathKey(input.cwd) &&
    existing.launchEffort === effort
  ) {
    // Posture stays with the running turn; a queued send stamps its own
    // runtimeMode/planning when its task actually starts.
    existing.onEvent = input.onEvent;
    return existing;
  }
  if (existing) {
    await stopCopilotSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canLoad = resume != null && pathKey(resume.cwd) === pathKey(input.cwd);
  if (resume && !canLoad) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveCopilotBinary(input.cwd);
  const handlers: AcpHandlers = {};
  const acp = new AcpClient(input.sessionId, handlers);
  const liveRef: { current: Live | null } = { current: null };
  // The server may emit session/update (commands, mode, config, or the
  // session/load transcript replay) before the live record exists; buffer
  // everything and replay it once installed — live.muteUpdates then decides
  // which of the replayed events reach the UI.
  const earlyNotifications: { method: string; params: unknown }[] = [];
  let childExited = false;

  handlers.onNotification = (method, params) => {
    const live = liveRef.current;
    if (!live) {
      earlyNotifications.push({ method, params });
      return;
    }
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
    void handleRequest(live, id, method, params).catch((err) => {
      console.debug("[monocode] copilot request handler failed", err);
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
      childExited = true;
      acp.close(new Error("Copilot exited"));
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
      console.debug("[monocode] copilot stderr", line);
      if (COPILOT_AUTH_PATTERN.test(line)) {
        emit({
          type: "session.error",
          message: `${line.trim()}\n\n${AUTH_HELP}`,
        });
      }
    },
  );

  try {
    await spawnChild(input.sessionId, path, copilotSpawnArgs(effort), input.cwd);
  } catch (error) {
    unwatchChild(input.sessionId);
    throw error;
  }

  try {
    let initResult: unknown;
    try {
      initResult = await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: COPILOT_CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        INIT_TIMEOUT_MS,
      );
    } catch (error) {
      throw copilotAuthError(error);
    }
    const agentCaps = asRecord(asRecord(initResult)?.agentCapabilities);
    const supportsLoad = agentCaps?.loadSession === true;

    let setup: unknown;
    let acpSessionId: string | undefined;
    let didLoad = false;

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
        console.debug("[monocode] copilot session/load failed", loadError);
        // The failed load may have replayed the old session's transcript;
        // drop it so it is not echoed unmuted into the fresh session.
        earlyNotifications.length = 0;
        setup = undefined;
        acpSessionId = undefined;
        didLoad = false;
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
        throw copilotAuthError(error);
      }
      acpSessionId = sessionIdFromResult(setup);
    }
    if (!acpSessionId) throw new Error("Copilot did not return a session id");

    const configOptions = acpConfigOptions(asRecord(setup)?.configOptions);
    const modes = acpModesFromSetup(setup);
    // The setup response carries the same model data as the catalog probe;
    // publishing it keeps the picker fresh without an extra ACP session.
    // copilotModelsFromSetup always returns the Default entry, so a
    // length-1 result means the server advertised nothing real.
    const discovered = copilotModelsFromSetup(setup);
    if (discovered.length > 1) {
      setHarnessModels("copilot", discovered, input.cwd);
    }
    const live: Live = {
      threadId: input.sessionId,
      acp,
      acpSessionId,
      cwd: input.cwd,
      launchEffort: effort,
      currentModelId: copilotCurrentModelId(setup, configOptions),
      modelPinned: false,
      nextRequestId: 1_000_000_000,
      modelConfigId: acpModelConfigId(configOptions),
      configOptions,
      modeIds: modes.availableModeIds.length
        ? modes.availableModeIds
        : acpModeIdsFromConfig(configOptions),
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
    for (const early of earlyNotifications) {
      handleNotification(live, early.method, early.params);
    }
    return live;
  } catch (error) {
    // A cancel that landed mid-handshake must survive the cleanup below —
    // stopCopilotSession clears cancelledThreads, so keep it for the caller's
    // consume-check and never retry a turn the user already stopped.
    const wasCancelled = cancelledThreads.has(input.sessionId);
    // `--effort` rejection looks like the child dying mid-handshake; an ACP
    // error or timeout with the process still running is unrelated to it.
    const flagSuspect = Boolean(effort) && childExited;
    acp.close(error instanceof Error ? error : new Error(String(error)));
    await stopCopilotSession(input.sessionId);
    // Re-check after the cleanup await — a cancel can land while stopping.
    if (wasCancelled || cancelledThreads.has(input.sessionId)) {
      cancelledThreads.add(input.sessionId);
      throw error;
    }
    if (flagSuspect && !effortUnsupportedThreads.has(input.sessionId)) {
      effortUnsupportedThreads.add(input.sessionId);
      const live = await ensureLive(input);
      live.onEvent({
        type: "session.error",
        message: `This Copilot CLI does not support --effort=${effort}; running at the default effort.`,
      });
      return live;
    }
    throw error;
  }
}

/**
 * `session/set_model` is the standard switch; older Copilot builds that lack
 * it fall back to the advertised `model` config option.
 */
async function applyModelSelection(
  live: Live,
  input: HarnessSessionInput,
): Promise<void> {
  const base = nativeModelId(input.model, input.cwd).trim();
  if (!base) return;
  // A probed catalog replaces the placeholder list, so an id that no longer
  // resolves (removed, or disabled by plan/org policy) must not degrade into
  // a `set_model` for the stale slug — require an explicit replacement.
  if (
    hasLiveCatalog("copilot", input.cwd) &&
    !modelsFor("copilot", input.cwd).some(
      (model) => model.id === input.model || model.nativeId === base,
    )
  ) {
    const message = `Copilot does not offer ${base} on this account — it may be disabled by plan or organization policy. Pick another model before sending.`;
    live.onEvent({ type: "session.error", message });
    throw new Error(message);
  }
  const current =
    live.currentModelId ?? acpCurrentModelId(live.configOptions);
  // While pinned, the config option may still report a different model —
  // a stale echo or a real out-of-band revert; the cases are indistinguishable,
  // so re-assert the pinned choice (idempotent) rather than trust either.
  const reported = acpCurrentModelId(live.configOptions);
  const unconfirmed =
    live.modelPinned && reported != null && reported !== base;
  if (current === base && !unconfirmed) return;
  // The config option may keep reporting this pre-write value after the
  // switch; record it so config_option_update can tell a stale echo apart
  // from the server genuinely moving to a third model.
  const staleConfigValue = acpCurrentModelId(live.configOptions);
  try {
    await live.acp.request(
      "session/set_model",
      { sessionId: live.acpSessionId, modelId: base },
      CONTROL_TIMEOUT_MS,
    );
    live.currentModelId = base;
    live.modelPinned = true;
    live.pinnedConfigValue = staleConfigValue;
    return;
  } catch (error) {
    if (!isUnsupportedControl(error)) {
      const message = modelApplyError(base, error);
      live.onEvent({ type: "session.error", message });
      throw error;
    }
  }
  // Older servers only expose `model` as a config option.
  let verified = false;
  try {
    verified = await setConfigOption(live, live.modelConfigId, base);
  } catch (error) {
    if (isUnsupportedControl(error)) {
      // Neither control exists on this build — the explicit selection cannot
      // be honored, so fail rather than run the turn on a different model.
      const message = `Copilot cannot switch to ${base}: this build supports neither session/set_model nor the model config option.`;
      live.onEvent({ type: "session.error", message });
      throw new Error(message);
    }
    const message = modelApplyError(base, error);
    live.onEvent({ type: "session.error", message });
    throw error;
  }
  // A config write the server ignored (e.g. a disabled choice) reports
  // success but returns configOptions with currentValue unchanged; only a
  // refreshed option list can confirm or contradict the switch.
  if (verified) {
    const applied = acpCurrentModelId(live.configOptions);
    if (applied && applied !== base) {
      const message = `Copilot did not switch to ${base} (still on ${applied}). The model may be disabled for this account.`;
      live.onEvent({ type: "session.error", message });
      throw new Error(message);
    }
  }
  live.currentModelId = base;
  live.modelPinned = true;
  live.pinnedConfigValue = staleConfigValue;
}

function modelApplyError(modelId: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return /not available|disabled|denied|policy|entitle|authoriz/i.test(detail)
    ? `${detail.trim()} The model ${modelId} may be disabled by your Copilot plan or organization policy.`
    : detail;
}

async function applyRuntimeMode(
  live: Live,
  runtimeMode: RuntimeMode,
  planning = false,
): Promise<void> {
  const wanted = acpModeId(runtimeMode, planning, live.modeIds);
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

/** Returns true when the response carried a refreshed config option list. */
async function setConfigOption(
  live: Live,
  configId: string,
  value: string,
): Promise<boolean> {
  const result = await live.acp.request(
    "session/set_config_option",
    { sessionId: live.acpSessionId, configId, value },
    CONTROL_TIMEOUT_MS,
  );
  const next = asRecord(result)?.configOptions;
  if (next) {
    live.configOptions = acpConfigOptions(next);
    return true;
  }
  return false;
}

async function prompt(live: Live, input: SendTurnInput): Promise<void> {
  try {
    const blocks = acpPromptBlocks(input.text, input.attachments);
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
    const message = copilotStopReasonMessage(
      stringField(asRecord(result), "stopReason") ?? "",
    );
    if (message) {
      live.onEvent({ type: "session.error", message });
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
      message: COPILOT_AUTH_PATTERN.test(detail)
        ? `${detail.trim()}\n\n${AUTH_HELP}`
        : detail,
    });
    throw error;
  }
}

function isUnsupportedControl(error: unknown): boolean {
  if ((error as { code?: number } | null)?.code === -32601) return true;
  const detail = error instanceof Error ? error.message : String(error);
  return /method not found|not implemented|unknown method/i.test(detail);
}

function ignoreUnsupportedControl(method: string, error: unknown): void {
  console.debug(`[monocode] copilot ${method} failed`, error);
  const detail = error instanceof Error ? error.message : String(error);
  if (/timed out|not running|exited|closed|pipe/i.test(detail)) throw error;
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

  // Copilot re-sends the full command set whenever it changes; each update is
  // a complete replacement, never a delta.
  if (kind === "available_commands_update") {
    live.commands = acpCommandsFromUpdate("copilot", params);
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
    const previous =
      live.currentModelId ?? acpCurrentModelId(live.configOptions);
    const next = acpConfigOptions(
      update?.configOptions ?? update?.config_options,
    );
    if (next.length) {
      live.configOptions = next;
      const current = acpCurrentModelId(next);
      if (live.modelPinned) {
        if (current && current === live.currentModelId) {
          // The server confirms the pinned model.
          live.modelPinned = false;
          live.pinnedConfigValue = undefined;
        } else if (current && current !== live.pinnedConfigValue) {
          // Neither the pinned model nor the stale pre-write echo — the
          // server moved on its own (CLI change, deprecation); trust it.
          live.modelPinned = false;
          live.pinnedConfigValue = undefined;
          live.currentModelId = current;
          if (!live.muteUpdates) {
            live.onEvent({
              type: "session.configChanged",
              model: `copilot:${current}`,
            });
          }
        }
        // current === pinnedConfigValue: stale echo — ignore it. If the
        // server really reverted, applyModelSelection re-asserts the pinned
        // choice on the next turn.
        if (current && current === live.pinnedConfigValue) {
          console.debug(
            "[monocode] copilot ignoring stale model echo",
            current,
          );
        }
      } else if (current && current !== previous) {
        live.currentModelId = current;
        if (!live.muteUpdates) {
          live.onEvent({
            type: "session.configChanged",
            model: `copilot:${current}`,
          });
        }
      }
    }
    return;
  }

  // Replays (session/load) and muted windows still update the state above;
  // only transcript events are suppressed.
  if (live.muteUpdates) return;
  for (const event of acpEventsFromUpdate(params)) {
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

async function handlePermission(live: Live, id: JsonRpcId, params: unknown) {
  const request = acpPermissionRequest(params);
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
    const readOnly = request.kind === "read" || request.kind === "search";
    const optionId = acpPermissionOptionId(
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

  const auto = acpAutoOption(
    live.runtimeMode,
    request.kind,
    request.optionIds,
  );
  if (auto) {
    await live.acp
      .respond(id, {
        outcome: { outcome: "selected", optionId: auto },
      })
      .catch(() => undefined);
    return;
  }

  // The UI needs a numeric requestId; give non-numeric ACP ids a synthetic
  // one (large, so it cannot collide with server-chosen numeric ids).
  const requestId = typeof id === "number" ? id : (live.nextRequestId += 1);
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
      resolve,
    });
  });
  live.approvals.delete(key);
  live.onEvent({ type: "approval.resolved", requestId, decision });

  const optionId = acpPermissionOptionId(decision, request.optionIds);
  await live.acp
    .respond(
      id,
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    )
    .catch(() => undefined);
}

async function handleElicitation(live: Live, id: JsonRpcId, params: unknown) {
  const parsed = acpElicitation(params);
  if (!parsed || live.cancelled || live.muteUpdates) {
    await live.acp
      .respond(id, { action: "cancel" })
      .catch(() => undefined);
    return;
  }
  const requestId = typeof id === "number" ? id : (live.nextRequestId += 1);
  live.onEvent({
    type: "question.asked",
    requestId,
    title: parsed.title ?? questionPromptTitle(parsed.questions),
    questions: parsed.questions,
  });

  const key = String(requestId);
  const reply = await new Promise<UserQuestionReply>((resolve) => {
    live.questions.set(key, resolve);
  });
  live.questions.delete(key);
  live.onEvent({
    type: "question.resolved",
    requestId,
    decision: reply.kind === "answered" ? "answered" : "skipped",
  });

  await live.acp
    .respond(id, acpElicitationResult(reply, parsed.questions, parsed.fields))
    .catch(() => undefined);
}

function copilotAuthError(error: unknown, verb = "start"): Error {
  return acpAuthError("Copilot", AUTH_HELP, error, verb);
}
