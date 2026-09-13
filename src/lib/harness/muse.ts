import { nativeModelId, setHarnessModels } from "../models";
import type { RuntimeMode, ToolPreview } from "../session";
import {
  questionPromptTitle,
  type UserQuestion,
  type UserQuestionReply,
} from "../userQuestion";
import {
  killChild,
  resolveMuseBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import { JsonRpcClient, type JsonRpcId } from "./jsonRpc";
import {
  asRecord,
  isMuseSessionMissing,
  MUSE_AUTH_HELP,
  MUSE_AUTH_PATTERN,
  museAnswerParts,
  museApprovalFromParams,
  museApprovalMode,
  museApprovalRefresh,
  museAuthError,
  museCheckInitialize,
  museChoiceFor,
  museContextEvent,
  museDeltaEvent,
  museErrorKind,
  museGoalText,
  museInitializeParams,
  museItemEvent,
  museItemStatus,
  museModelsFromList,
  musePostureKey,
  museReasoningEffort,
  museResolvedDecision,
  museSessionIdFromResult,
  museSpawnArgs,
  museTodoListEvent,
  museTurnError,
  museTurnInput,
  museUserInputFromParams,
  newCommandId,
  stringField,
  type MuseApprovalChoice,
  type MuseItemState,
  type MuseUserInput,
} from "./museProtocol";
import {
  MuseSubagentTrails,
  museSubagentMeta,
  type FollowedMuseChild,
  type MuseSubagentMeta,
} from "./museSubagents";
import { acquireSharedStart } from "./liveStart";
import { markTurn } from "../turnTiming";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  HarnessSessionInput,
  SendTurnInput,
  SteerTurnInput,
} from "./types";

const INIT_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_MS = 30 * 60_000;
const COMPACT_TIMEOUT_MS = 60_000;
const MAX_FINISHED_TURNS = 32;

type PendingApproval = {
  approvalId: string;
  sessionId: string;
  itemId: string;
  requirementId: { approvalId: string; sourceIndex: number };
  choices: MuseApprovalChoice[];
  title: string;
  kind?: string;
  preview?: ToolPreview;
  /** Set once the user answered; a later stale-requirement error re-asks. */
  decidedLocally?: "allow" | "deny";
};

type PendingQuestion = {
  userInputId: string;
  sessionId: string;
  questions: UserQuestion[];
  raw: MuseUserInput["raw"];
};

type TurnWait = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Live = {
  rpc: JsonRpcClient;
  /** MonoCode session id (child-process key). */
  sessionId: string;
  /** MSP session id. */
  museSessionId: string;
  cwd: string;
  runtimeMode: RuntimeMode;
  planning: boolean;
  /** Spawn-flag signature; a change requires a fresh `muse serve`. */
  postureKey: string;
  stopping: boolean;
  onEvent: (event: HarnessEvent) => void;
  items: Map<string, MuseItemState>;
  /** Followed `subagent` child sessions rendered as agent.step trails. */
  subagents: MuseSubagentTrails;
  approvals: Map<number, PendingApproval>;
  approvalUiById: Map<string, number>;
  questions: Map<number, PendingQuestion>;
  questionUiById: Map<string, number>;
  nextUiId: number;
  turnWaits: Map<string, TurnWait>;
  /** Terminal results that arrived before the ack's waiter was registered. */
  finishedTurns: Map<string, Error | undefined>;
  activeTurnId: string | null;
  queuedTurnIds: Set<string>;
  appliedModelId: string;
  appliedMode: string;
  cancelled: boolean;
  muteUpdates: boolean;
  turns: Promise<void>;
  gapNotified: boolean;
  lastGoal: string | undefined;
  compactionWait: { resolve: () => void; reject: (e: Error) => void } | null;
  /** Throttles model/list re-warms triggered by route failures. */
  catalogRefreshedAt: number;
  /** A non-bookkeeping item reached terminal — enables drain detection. */
  hasCompletedReal: boolean;
  /** A reminderChild event arrived while no real item was open. */
  reminderIdleSeen: boolean;
  /** A model retry is scheduled; its real item has not started yet. */
  retryPending: boolean;
  /** The turn whose wait already resolved on drain detection. */
  drainSettledFor: string | null;
};

type Resume = {
  museSessionId: string;
  cwd: string;
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();
/** In-flight cold starts: a prewarm and a send share one spawn. */
const startingByThread = new Map<string, Promise<Live>>();

export async function sendMuseTurn(input: SendTurnInput): Promise<void> {
  const live = await acquireLive(input);
  if (cancelledThreads.delete(input.sessionId)) return;
  live.onEvent = input.onEvent;
  const turn = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.runtimeMode = input.runtimeMode;
      live.planning = input.intent === "plan";
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await runTurn(live, input);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  live.turns = turn.then(
    () => undefined,
    () => undefined,
  );
  await turn;
}

export async function compactMuseContext(
  input: CompactContextInput,
): Promise<void> {
  // A compact carries no intent; reuse the running host even when its spawn
  // posture came from a plan turn, rather than recycling mid-session.
  const existing = liveByThread.get(input.sessionId);
  const live =
    existing && existing.cwd === input.cwd
      ? existing
      : await acquireLive(input);
  if (cancelledThreads.delete(input.sessionId)) return;
  live.onEvent = input.onEvent;
  const work = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await runCompaction(live);
      } catch (error) {
        // A turn cancel rejects the compact; tearing the session down does
        // not — it resolves quietly like the send path.
        if (live.stopping) return;
        throw error;
      }
    });
  live.turns = work.then(
    () => undefined,
    () => undefined,
  );
  await work;
}

export async function steerMuseTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live) throw new Error("No active Muse session");
  if (live.cwd !== input.cwd) {
    throw new Error("Muse session moved to a different workspace");
  }
  const turnId = live.activeTurnId;
  if (!turnId) throw new Error("No active Muse turn to steer");
  const parts = museTurnInput(input.text, input.attachments ?? []);
  if (parts.length === 0) return;
  const params: Record<string, unknown> = {
    commandId: newCommandId(),
    sessionId: live.museSessionId,
    expectedTurnId: turnId,
    input: parts,
  };
  const effort = museReasoningEffort(input.modelSettings);
  if (effort) params.reasoningEffort = effort;
  await live.rpc.request("turn/steer", params, CONTROL_TIMEOUT_MS);
}

/**
 * Apply a UI access-mode change to a running host: push the wire-selected
 * approval mode and settle parked asks the new mode auto-decides. The sandbox
 * posture (`--disable-sandbox`) is a spawn flag the stale postureKey turns
 * into a respawn on the next turn.
 */
export function setMuseRuntimeMode(
  sessionId: string,
  runtimeMode: RuntimeMode,
): void {
  const live = liveByThread.get(sessionId);
  if (!live) return;
  const changed = live.runtimeMode !== runtimeMode;
  live.runtimeMode = runtimeMode;
  const mode = museApprovalMode(runtimeMode, live.planning);
  if (mode !== live.appliedMode) {
    void live.rpc
      .request(
        "session/setApprovalMode",
        { commandId: newCommandId(), mode, sessionId: live.museSessionId },
        CONTROL_TIMEOUT_MS,
      )
      .then(() => {
        live.appliedMode = mode;
      })
      .catch((error: unknown) => {
        try {
          ignoreUnsupportedControl("session/setApprovalMode", error);
        } catch {
          // A wedged transport is recycled by the next turn's ensureLive.
        }
      });
  }
  if (!changed) return;
  for (const [uiId, pending] of live.approvals) {
    if (pending.decidedLocally) continue;
    const auto = museAutoDecision(runtimeMode, live.planning, pending.kind);
    if (auto) respondMuseApproval(sessionId, uiId, auto);
  }
}

export function respondMuseApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.approvals.get(requestId);
  if (!live || !pending) return;
  if (pending.decidedLocally) return;
  pending.decidedLocally = decision;
  live.onEvent({ type: "approval.resolved", requestId, decision });
  const choice = museChoiceFor(decision, pending.choices);
  if (!choice) {
    live.onEvent({
      type: "status",
      text: `Muse offered no ${decision === "allow" ? "approval" : "denial"} choice for this request.`,
    });
    live.approvals.delete(requestId);
    live.approvalUiById.delete(pending.approvalId);
    return;
  }
  void live.rpc
    .request(
      "approval/decide",
      {
        approvalId: pending.approvalId,
        choiceId: choice.choiceId,
        commandId: newCommandId(),
        requirementId: pending.requirementId,
        sessionId: pending.sessionId,
      },
      CONTROL_TIMEOUT_MS,
    )
    .then(() => {
      // Accepted; a later approval/resolved (if any) is already deduped.
      live.approvals.delete(requestId);
      live.approvalUiById.delete(pending.approvalId);
    })
    .catch((error: unknown) => {
      const kind = museErrorKind(error);
      if (
        kind === "approvalAlreadyResolved" ||
        kind === "approvalNotFound"
      ) {
        live.approvals.delete(requestId);
        live.approvalUiById.delete(pending.approvalId);
        return;
      }
      if (kind === "approvalRequirementStale") {
        // The requirement raced ahead to a new stage; never replay the click
        // onto a stage the user did not review — re-ask instead.
        live.onEvent({
          type: "status",
          text: "That approval advanced to a new stage; answer the refreshed prompt.",
        });
        pending.decidedLocally = undefined;
        const freshId = live.nextUiId++;
        live.approvals.delete(requestId);
        live.approvals.set(freshId, pending);
        live.approvalUiById.set(pending.approvalId, freshId);
        live.onEvent({
          type: "approval.requested",
          requestId: freshId,
          title: pending.title,
          kind: pending.kind,
          callId: pending.itemId,
          ...(pending.preview ? { preview: pending.preview } : {}),
        });
        return;
      }
      live.onEvent({
        type: "status",
        text: `Muse rejected the decision: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    });
}

export function respondMuseQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.questions.get(requestId);
  if (!live || !pending) return;
  live.questions.delete(requestId);
  live.questionUiById.delete(pending.userInputId);
  live.onEvent({
    type: "question.resolved",
    requestId,
    decision: reply.kind === "answered" ? "answered" : "skipped",
  });
  const answers = museAnswerParts(reply, pending.questions, pending.raw);
  const request = answers
    ? live.rpc.request(
        "userInput/answer",
        {
          answers,
          commandId: newCommandId(),
          sessionId: pending.sessionId,
          userInputId: pending.userInputId,
        },
        CONTROL_TIMEOUT_MS,
      )
    : live.rpc.request(
        "userInput/cancel",
        {
          commandId: newCommandId(),
          reason: "Declined in MonoCode",
          sessionId: pending.sessionId,
          userInputId: pending.userInputId,
        },
        CONTROL_TIMEOUT_MS,
      );
  void request.catch((error: unknown) => {
    const kind = museErrorKind(error);
    if (kind === "userInputAlreadySettled" || kind === "userInputNotFound") {
      return;
    }
    live.onEvent({
      type: "status",
      text: `Muse rejected the answer: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  });
}

/**
 * The user started answering a timed prompt. The client-side countdown is
 * cleared; Muse's own auto-resolution still applies and lands through
 * `userInput/settled`.
 */
export function keepMuseQuestionOpen(sessionId: string, requestId: number): void {
  const live = liveByThread.get(sessionId);
  if (!live || !live.questions.has(requestId)) return;
  live.onEvent({ type: "question.updated", requestId });
}

export async function cancelMuseTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  clearPending(live);
  live.compactionWait?.reject(new Error("Muse turn cancelled"));
  live.compactionWait = null;
  const active = live.activeTurnId;
  const queued = [...live.queuedTurnIds];
  settleAllTurns(live, undefined);
  if (active) {
    void live.rpc
      .request(
        "turn/interrupt",
        {
          commandId: newCommandId(),
          sessionId: live.museSessionId,
          turnId: active,
        },
        CONTROL_TIMEOUT_MS,
      )
      .catch(() => undefined);
  }
  for (const turnId of queued) {
    void live.rpc
      .request(
        "turn/unqueue",
        {
          commandId: newCommandId(),
          sessionId: live.museSessionId,
          turnId,
        },
        CONTROL_TIMEOUT_MS,
      )
      .catch(() => undefined);
  }
}

export async function stopMuseSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.stopping = true;
    live.cancelled = true;
    live.muteUpdates = true;
    clearPending(live);
    settleAllTurns(live, new Error("Muse session stopped"));
    live.compactionWait?.reject(new Error("Muse session stopped"));
    live.compactionWait = null;
    live.rpc.close();
  }
  // Only kill a child this adapter owns — after a harness switch another
  // adapter may hold a live child under the same session id.
  if (live || startingByThread.has(sessionId)) {
    unwatchChild(sessionId);
    await killChild(sessionId).catch(() => undefined);
  }
}

export async function forgetMuseSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopMuseSession(sessionId);
}

export function bindMuseSession(
  threadId: string,
  providerSessionId: string,
  cwd: string,
): void {
  const museSessionId = providerSessionId.trim();
  if (!threadId || !museSessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { museSessionId, cwd });
}

/** ensureLive wrapper: a pending cancel must not leak past a failed startup. */
async function acquireLive(
  input: HarnessSessionInput,
  keepExisting = false,
): Promise<Live> {
  try {
    return await acquireSharedStart(
      input.sessionId,
      liveByThread,
      startingByThread,
      () => ensureLive(input),
      keepExisting,
    );
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
}

/**
 * Warm the provider session ahead of a prompt. No-ops when a live host
 * already serves the thread so a prewarm cannot steal a running turn's
 * event sink — or recycle the host a racing send just spawned.
 */
export async function prewarmMuseSession(
  input: HarnessSessionInput,
): Promise<void> {
  if (liveByThread.has(input.sessionId)) return;
  await acquireLive(input, true);
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const planning = input.intent === "plan";
  const posture = musePostureKey(input.runtimeMode, planning);
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd && existing.postureKey === posture) {
    existing.onEvent = input.onEvent;
    return existing;
  }
  // A different cwd or sandbox posture cannot be applied to a running host:
  // recycle the process and resume the durable session on the new host.
  if (existing) {
    // A turn cut by the recycle resolves quietly; leave a transcript marker
    // so the truncated answer is not mistaken for a completed one.
    if (existing.activeTurnId || existing.turnWaits.size > 0) {
      existing.onEvent({
        type: "status",
        text: "Muse session restarted to apply new settings.",
      });
    }
    await stopMuseSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canResume = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveMuseBinary(input.cwd);
  markTurn(input.sessionId, "muse binary resolved");
  const liveRef: { current: Live | null } = { current: null };
  // session/resume re-issues pending approvals/questions as server requests
  // before `live` is bound; hold them until the session object exists.
  const earlyRequests: { method: string; params: unknown }[] = [];

  const rpc = new JsonRpcClient(
    input.sessionId,
    {
      onNotification: (method, params) => {
        const live = liveRef.current;
        if (!live) return;
        handleNotification(live, method, params);
      },
      onRequest: (id, method, params) => {
        const live = liveRef.current;
        if (!live) {
          if (method === "approval/request" || method === "userInput/request") {
            earlyRequests.push({ method, params });
            void rpc.respond(id, {}).catch(() => undefined);
          } else {
            void rpc
              .respondError(id, {
                code: -32601,
                message: `Unsupported method: ${method}`,
              })
              .catch(() => undefined);
          }
          return;
        }
        void handleServerRequest(live, rpc, id, method, params).catch(
          () => undefined,
        );
      },
    },
    { includeJsonrpc: true, label: "muse" },
  );

  watchChild(
    input.sessionId,
    (line) => rpc.pushLine(line),
    (code) => {
      rpc.close(new Error("Muse host exited"));
      const live = liveRef.current;
      if (liveByThread.get(input.sessionId) === live) {
        liveByThread.delete(input.sessionId);
      }
      if (!live || live.stopping) return;
      live.muteUpdates = true;
      settleAllTurns(live, new Error("Muse host exited"));
      clearPending(live);
      live.compactionWait?.reject(new Error("Muse host exited"));
      live.onEvent({ type: "session.ended", code });
    },
    (line) => {
      console.debug(`[muse ${input.sessionId}] stderr`, line);
      if (MUSE_AUTH_PATTERN.test(line)) {
        const live = liveRef.current;
        if (!live || live.muteUpdates) return;
        live.onEvent({
          type: "session.error",
          message: `${line.trim()}\n\n${MUSE_AUTH_HELP}`,
        });
      }
    },
  );

  try {
    await spawnChild(
      input.sessionId,
      path,
      museSpawnArgs({
        planning,
        fullAccess: input.runtimeMode === "full-access",
      }),
      input.cwd,
    );
    markTurn(input.sessionId, "muse spawned");

    try {
      const result = await rpc.request(
        "initialize",
        museInitializeParams(),
        INIT_TIMEOUT_MS,
      );
      const info = museCheckInitialize(result);
      console.debug(
        `[muse ${input.sessionId}] host ${info.serverVersion}` +
          (info.fingerprint ? ` schema ${info.fingerprint}` : ""),
      );
    } catch (error) {
      throw museAuthError(error, "start");
    }
    void rpc.notify("initialized");
    markTurn(input.sessionId, "muse initialized");

    // "muse:default" is the picker placeholder, not a servable model id.
    const wantedModel = museNativeModel(input.model, input.cwd);
    const mode = museApprovalMode(input.runtimeMode, planning);

    let museSessionId: string | undefined;
    let resumed = false;
    if (canResume && resume) {
      try {
        const result = await rpc.request(
          "session/resume",
          {
            commandId: newCommandId(),
            sessionId: resume.museSessionId,
            excludeItems: true,
          },
          SESSION_TIMEOUT_MS,
        );
        museSessionId =
          museSessionIdFromResult(result) ?? resume.museSessionId;
        // resume carries no mode/model; the stored session keeps its own.
        resumed = museSessionId != null;
      } catch (error) {
        if (!isMuseSessionMissing(error)) {
          // A resume that fails for another reason would retry the same
          // doomed session on every turn; drop it before surfacing.
          resumeByThread.delete(input.sessionId);
          throw error;
        }
        museSessionId = undefined;
      }
    }

    if (!museSessionId) {
      try {
        const params: Record<string, unknown> = {
          commandId: newCommandId(),
          workspaceRoot: input.cwd,
          approvalMode: mode,
        };
        if (wantedModel) params.modelId = wantedModel;
        const result = await rpc.request(
          "session/start",
          params,
          SESSION_TIMEOUT_MS,
        );
        museSessionId = museSessionIdFromResult(result);
      } catch (error) {
        throw museAuthError(error, "start a session");
      }
    }
    if (!museSessionId) {
      throw new Error("Muse did not return a session id");
    }
    markTurn(input.sessionId, resumed ? "muse resumed" : "muse session started");

    const live: Live = {
      rpc,
      sessionId: input.sessionId,
      museSessionId,
      cwd: input.cwd,
      runtimeMode: input.runtimeMode,
      planning,
      postureKey: posture,
      stopping: false,
      onEvent: input.onEvent,
      items: new Map(),
      subagents: new MuseSubagentTrails(),
      approvals: new Map(),
      approvalUiById: new Map(),
      questions: new Map(),
      questionUiById: new Map(),
      nextUiId: 1,
      turnWaits: new Map(),
      finishedTurns: new Map(),
      activeTurnId: null,
      queuedTurnIds: new Set(),
      // A resumed session keeps its stored mode/model; the empty seeds force
      // the first turn to push the user's current selections over the wire.
      appliedModelId: resumed ? "" : (wantedModel ?? ""),
      appliedMode: resumed ? "" : mode,
      cancelled: false,
      muteUpdates: false,
      turns: Promise.resolve(),
      gapNotified: false,
      lastGoal: undefined,
      compactionWait: null,
      catalogRefreshedAt: 0,
      hasCompletedReal: false,
      reminderIdleSeen: false,
      retryPending: false,
      drainSettledFor: null,
    };
    liveRef.current = live;
    liveByThread.set(input.sessionId, live);
    resumeByThread.set(input.sessionId, {
      museSessionId,
      cwd: input.cwd,
    });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: museSessionId,
    });
    live.onEvent({ type: "session.started" });
    // Requests the host re-issued during resume now have a session to render.
    for (const early of earlyRequests.splice(0)) {
      dispatchServerRequest(live, early.method, early.params);
    }
    void populateCatalog(live);
    return live;
  } catch (error) {
    rpc.close(error instanceof Error ? error : new Error(String(error)));
    liveRef.current = null;
    await stopMuseSession(input.sessionId);
    throw error;
  }
}

/** The session's own host already answers model/list; warm the picker from it. */
async function populateCatalog(live: Live): Promise<void> {
  // Route-flap and session-bound refreshes share this throttle.
  const now = Date.now();
  if (now - live.catalogRefreshedAt < 30_000) return;
  live.catalogRefreshedAt = now;
  try {
    const result = await live.rpc.request(
      "model/list",
      { sessionId: live.museSessionId },
      SESSION_TIMEOUT_MS,
    );
    if (liveByThread.get(live.sessionId) !== live) return;
    const models = museModelsFromList(result);
    if (models.length > 0) setHarnessModels("muse", models, live.cwd);
  } catch {
    // Catalog refresh is best-effort; never fail a live session for it.
  }
}

/** The placeholder row resolves to no model; real rows send their native id. */
function museNativeModel(model: string, cwd: string): string | undefined {
  if (model === "muse:default") return undefined;
  const native = nativeModelId(model, cwd);
  return native || undefined;
}

async function runTurn(live: Live, input: SendTurnInput): Promise<void> {
  // Model and approval mode are independent session settings; issue them
  // together so a resumed turn pays one round trip, not two.
  const native = museNativeModel(input.model, input.cwd);
  const mode = museApprovalMode(live.runtimeMode, live.planning);
  const controls: Promise<void>[] = [];
  if (native && native !== live.appliedModelId) {
    controls.push(
      live.rpc
        .request(
          "session/setModel",
          {
            commandId: newCommandId(),
            model: { modelId: native },
            sessionId: live.museSessionId,
          },
          CONTROL_TIMEOUT_MS,
        )
        .then(() => {
          live.appliedModelId = native;
        })
        .catch((error: unknown) =>
          ignoreUnsupportedControl("session/setModel", error),
        ),
    );
  }
  if (mode !== live.appliedMode) {
    controls.push(
      live.rpc
        .request(
          "session/setApprovalMode",
          { commandId: newCommandId(), mode, sessionId: live.museSessionId },
          CONTROL_TIMEOUT_MS,
        )
        .then(() => {
          live.appliedMode = mode;
        })
        .catch((error: unknown) =>
          ignoreUnsupportedControl("session/setApprovalMode", error),
        ),
    );
  }
  if (controls.length) {
    await Promise.all(controls);
    markTurn(live.sessionId, "muse controls applied");
  }
  // The parallel controls widened the cancel window — check again before
  // launching a turn the user already stopped.
  if (live.cancelled) return;

  const parts = museTurnInput(input.text, input.attachments ?? []);
  if (parts.length === 0) return;

  const commandId = newCommandId();
  const params: Record<string, unknown> = {
    commandId,
    ifBusy: "queue",
    input: parts,
    sessionId: live.museSessionId,
  };
  const effort = museReasoningEffort(input.modelSettings);
  if (effort) params.reasoningEffort = effort;

  let ack: unknown;
  try {
    ack = await live.rpc.request("turn/start", params, CONTROL_TIMEOUT_MS);
  } catch (error) {
    if (live.cancelled) return;
    if (!live.muteUpdates) {
      live.onEvent({
        type: "session.error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  const rec = asRecord(ack);
  const turnId = stringField(rec, "turnId");
  markTurn(live.sessionId, "muse turn/start ack");
  if (!turnId) {
    throw new Error("Muse turn/start returned no turn id");
  }
  const disposition = stringField(rec, "disposition");
  // Seed the active id from the ack so a steer landing before turn/started
  // still reaches the running turn.
  if (disposition === "started") live.activeTurnId = turnId;
  await waitTurn(live, turnId, disposition);
}

/** A host may lack a control; only transport failures should fail the turn. */
function ignoreUnsupportedControl(method: string, error: unknown): void {
  console.debug(`[muse] ${method} failed`, error);
  const detail = error instanceof Error ? error.message : String(error);
  if (/timed out|not running|exited|closed|pipe/i.test(detail)) throw error;
}

async function runCompaction(live: Live): Promise<void> {
  // Register the settle hook before the request: a fast item/completed must
  // not beat it.
  const done = new Promise<void>((resolve, reject) => {
    live.compactionWait = { resolve, reject };
  });
  const timer = setTimeout(() => {
    const wait = live.compactionWait;
    live.compactionWait = null;
    wait?.reject(
      new Error("Muse did not report compaction completion"),
    );
  }, COMPACT_TIMEOUT_MS);
  try {
    const result = await live.rpc.request(
      "session/compact",
      { commandId: newCommandId(), sessionId: live.museSessionId },
      CONTROL_TIMEOUT_MS,
    );
    const status = stringField(asRecord(result), "status");
    if (status !== "accepted") {
      throw new Error(
        `Muse declined to compact (${status ?? "no status"})`,
      );
    }
    // The ack is admission only; the compaction item's terminal event
    // settles the wait.
    await done;
  } finally {
    clearTimeout(timer);
    live.compactionWait = null;
  }
}

/**
 * Resolve when the acked turn reaches a terminal view event. `steered`
 * input was absorbed by the running turn, so it waits on that turn instead.
 */
function waitTurn(
  live: Live,
  turnId: string,
  disposition: string | undefined,
): Promise<void> {
  const targetId =
    disposition === "steered" ? live.activeTurnId : turnId;
  if (!targetId) return Promise.resolve();
  // A steered submission can target a turn that already has a registered
  // wait; both callers settle on the same terminal event.
  const existing = live.turnWaits.get(targetId);
  if (existing) return existing.promise;
  // A terminal event can land before this registration — and before an
  // exit — so check the recorded outcomes first.
  const finished = live.finishedTurns.get(targetId);
  if (live.finishedTurns.delete(targetId)) {
    if (finished instanceof Error) return Promise.reject(finished);
    return Promise.resolve();
  }
  // The host can exit between the turn/start ack and this registration.
  if (live.rpc.isClosed) {
    return Promise.reject(new Error("Muse host exited"));
  }
  // A turn/started landing between the ack and this registration already
  // marked the turn active; it must not sit in the unqueue set.
  if (disposition === "queued" && live.activeTurnId !== turnId) {
    live.queuedTurnIds.add(turnId);
  }
  const wait: TurnWait = {} as TurnWait;
  wait.promise = new Promise<void>((resolve, reject) => {
    wait.timer = setTimeout(() => {
      live.turnWaits.delete(targetId);
      live.queuedTurnIds.delete(targetId);
      if (live.activeTurnId === targetId) live.activeTurnId = null;
      reject(new Error("Muse turn timed out"));
    }, TURN_TIMEOUT_MS);
    wait.resolve = () => {
      clearTimeout(wait.timer);
      resolve();
    };
    wait.reject = (error) => {
      clearTimeout(wait.timer);
      reject(error);
    };
  });
  live.turnWaits.set(targetId, wait);
  return wait.promise;
}

/**
 * Resolve a turn's registered wait without clearing `activeTurnId` — the
 * turn still runs host-side (draining), so steer and interrupt must keep
 * their target until the real turn/completed lands.
 */
function resolveTurnWait(live: Live, turnId: string, outcome: Error | undefined): void {
  const wait = live.turnWaits.get(turnId);
  if (wait) {
    live.turnWaits.delete(turnId);
    if (outcome) wait.reject(outcome);
    else wait.resolve();
    return;
  }
  if (live.finishedTurns.size >= MAX_FINISHED_TURNS) {
    const oldest = live.finishedTurns.keys().next().value;
    if (oldest !== undefined) live.finishedTurns.delete(oldest);
  }
  live.finishedTurns.set(turnId, outcome);
}

/** turn/completed and turn/unqueued settle the matching waiter. */
function settleTurn(live: Live, turnId: string, outcome: Error | undefined): void {
  live.queuedTurnIds.delete(turnId);
  if (live.activeTurnId === turnId) live.activeTurnId = null;
  const wait = live.turnWaits.get(turnId);
  if (wait) {
    live.turnWaits.delete(turnId);
    if (outcome) wait.reject(outcome);
    else wait.resolve();
    return;
  }
  if (live.finishedTurns.size >= MAX_FINISHED_TURNS) {
    const oldest = live.finishedTurns.keys().next().value;
    if (oldest !== undefined) live.finishedTurns.delete(oldest);
  }
  live.finishedTurns.set(turnId, outcome);
}

function settleAllTurns(live: Live, outcome: Error | undefined): void {
  const waits = [...live.turnWaits.values()];
  live.turnWaits.clear();
  live.activeTurnId = null;
  live.queuedTurnIds.clear();
  for (const wait of waits) {
    clearTimeout(wait.timer);
    if (outcome) wait.reject(outcome);
    else wait.resolve();
  }
}

/** Pending prompts must leave the UI settled, not just forgotten. */
function clearPending(live: Live): void {
  for (const [requestId, pending] of live.approvals) {
    if (!pending.decidedLocally) {
      live.onEvent({
        type: "approval.resolved",
        requestId,
        decision: "cancelled",
      });
    }
  }
  for (const requestId of live.questions.keys()) {
    live.onEvent({
      type: "question.resolved",
      requestId,
      decision: "cancelled",
    });
  }
  live.approvals.clear();
  live.approvalUiById.clear();
  live.questions.clear();
  live.questionUiById.clear();
}

function emit(live: Live, events: HarnessEvent[]): void {
  if (live.muteUpdates) return;
  for (const event of events) live.onEvent(event);
}

/**
 * Open items by visibility class. `reminderChild` is memory bookkeeping;
 * the `userMessage` echo is not work either. Everything else — including
 * unknown kinds — counts as real work for drain detection.
 */
function openWorkCounts(live: Live): { real: number; reminders: number } {
  let real = 0;
  let reminders = 0;
  for (const state of live.items.values()) {
    if (state.kind === "reminderChild") {
      reminders += 1;
    } else if (state.kind !== "userMessage") {
      real += 1;
    }
  }
  return { real, reminders };
}

/**
 * `turn/completed` trails the answer while Muse drains memory/reminder child
 * sessions (the eot gate — ~60s on real models), and the wire exposes no
 * "answer is done" signal. A drain is detected by shape instead: a real item
 * already completed, no non-bookkeeping item is still open, and reminder
 * children are running (or were observed while the real set was empty).
 * Turn-start recall cannot trip it — no real item has completed yet — and a
 * scheduled model retry holds it off until the retry's real item starts.
 * `turn/completed` stays the backstop for drains that emit no reminder items;
 * a late `terminal: "failed"` still surfaces through its own session.error.
 */
function settleOnDrain(live: Live): void {
  const turnId = live.activeTurnId;
  if (!turnId || live.retryPending || live.drainSettledFor === turnId) return;
  const { real, reminders } = openWorkCounts(live);
  if (
    real > 0 ||
    !live.hasCompletedReal ||
    (reminders === 0 && !live.reminderIdleSeen)
  ) {
    return;
  }
  live.drainSettledFor = turnId;
  if (!live.muteUpdates) {
    live.onEvent({ type: "message.completed" });
    live.onEvent({ type: "reasoning.completed" });
    live.onEvent({
      type: "status",
      text: "Muse is finishing up — memory/reminder bookkeeping.",
    });
  }
  resolveTurnWait(live, turnId, undefined);
}

/**
 * Record drain evidence from an item notification after `museItemEvent` has
 * applied it. A reminderChild event while no real item is open marks the
 * drain even when the child completes too fast to sit in `items`.
 */
function noteDrainEvidence(
  live: Live,
  item: unknown,
  phase: "started" | "updated" | "completed",
): void {
  const kind = stringField(asRecord(item), "kind") ?? "";
  if (kind !== "reminderChild") {
    if (kind !== "userMessage" && kind !== "") {
      // A real item starting means a scheduled retry has produced work again.
      if (phase === "started") live.retryPending = false;
      if (phase === "completed") live.hasCompletedReal = true;
    }
    return;
  }
  if (live.hasCompletedReal && openWorkCounts(live).real === 0) {
    live.reminderIdleSeen = true;
  }
}

// ---- Subagent child-session trails ----

const CHILD_PAGE_LIMIT = 200;
/** History walk on subscribe; beyond this the live tail keeps going. */
const CHILD_PAGE_MAX = 8;
/** Gap fills and post-completion drains stay short — deltas are ephemeral. */
const CHILD_DRAIN_PAGE_MAX = 4;

/**
 * A main-session `subagent` item owns a child session. Follow it on every
 * phase — `childSessionId` can appear late — and close the follow on the
 * item's terminal revision with a final drain.
 */
function noteSubagentItem(
  live: Live,
  item: unknown,
  phase: "started" | "updated" | "completed",
): void {
  const rec = asRecord(item);
  if (!rec || stringField(rec, "kind") !== "subagent") return;
  const itemId = stringField(rec, "itemId");
  const childSessionId = stringField(rec, "childSessionId");
  if (childSessionId && itemId) {
    followChildSession(live, childSessionId, itemId, museSubagentMeta(rec));
  }
  if (phase === "completed" && childSessionId) {
    void endChildSession(live, childSessionId);
  }
}

/** Notifications carrying a followed child session id land here. */
function handleChildNotification(
  live: Live,
  sessionId: string,
  method: string,
  params: unknown,
): void {
  const child = live.subagents.get(sessionId);
  if (!child) return;
  if (method === "view/gap") {
    void fillChildGap(live, sessionId, params);
    return;
  }
  const routed = live.subagents.route(sessionId, method, params);
  emit(live, routed.events);
  for (const next of routed.follow) {
    followChildSession(live, next.sessionId, next.callId, next.meta);
  }
}

function followChildSession(
  live: Live,
  childSessionId: string,
  callId: string,
  meta?: MuseSubagentMeta,
): void {
  if (!childSessionId || childSessionId === live.museSessionId) return;
  const child = live.subagents.register(childSessionId, callId, meta);
  if (!child) return;
  void backfillChild(live, childSessionId, child);
}

/**
 * Page the child's durable history first, then subscribe at the last seen
 * cursor: the server replays `(after, head]` before any live event, so the
 * sequence is gapless and needs no buffering (tdd SS4.7.1). Per-item state
 * folds replayed revisions to their unseen remainder.
 */
async function backfillChild(
  live: Live,
  childSessionId: string,
  child: FollowedMuseChild,
): Promise<void> {
  await pageChild(live, childSessionId, child, { maxPages: CHILD_PAGE_MAX });
  if (child.ended) return;
  try {
    const result = asRecord(
      await live.rpc.request(
        "view/subscribe",
        {
          sessionId: childSessionId,
          ...(child.cursor ? { after: child.cursor } : {}),
        },
        CONTROL_TIMEOUT_MS,
      ),
    );
    const head = stringField(result, "viewCursor");
    if (head) child.cursor = head;
  } catch (error) {
    console.debug("[monocode] muse view/subscribe failed", error);
  }
}

/**
 * Forward `view/page` walk. `until` stops the walk at a named cursor (gap
 * fill); without it the walk runs to the view head (`nextCursor: null`).
 */
async function pageChild(
  live: Live,
  childSessionId: string,
  child: FollowedMuseChild,
  opts: { cursor?: string; until?: string; maxPages: number },
): Promise<void> {
  let cursor = opts.cursor ?? child.cursor;
  try {
    for (let page = 0; page < opts.maxPages; page += 1) {
      const result = asRecord(
        await live.rpc.request(
          "view/page",
          {
            sessionId: childSessionId,
            direction: "forward",
            limit: CHILD_PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
          },
          CONTROL_TIMEOUT_MS,
        ),
      );
      const events = Array.isArray(result?.events) ? result.events : [];
      let reached = false;
      for (const entry of events) {
        const notification = asRecord(entry);
        if (!notification) continue;
        const routed = live.subagents.route(
          childSessionId,
          stringField(notification, "method") ?? "",
          notification.params,
        );
        emit(live, routed.events);
        for (const next of routed.follow) {
          followChildSession(live, next.sessionId, next.callId, next.meta);
        }
        if (
          opts.until &&
          stringField(asRecord(notification.params), "viewCursor") ===
            opts.until
        ) {
          reached = true;
          break;
        }
      }
      const next = result?.nextCursor;
      if (typeof next === "string" && next) child.cursor = next;
      if (reached || typeof next !== "string" || !next) break;
      cursor = next;
    }
  } catch (error) {
    console.debug("[monocode] muse view/page failed", error);
  }
}

/** `view/gap` names the hole exactly; page (after, next] forward. */
async function fillChildGap(
  live: Live,
  sessionId: string,
  params: unknown,
): Promise<void> {
  const child = live.subagents.get(sessionId);
  const rec = asRecord(params);
  const after = stringField(rec, "after");
  const until = stringField(rec, "next");
  if (!child || !after) return;
  await pageChild(live, sessionId, child, {
    cursor: after,
    until,
    maxPages: CHILD_DRAIN_PAGE_MAX,
  });
}

/** The parent item is terminal: drain what remains, then stop following. */
async function endChildSession(
  live: Live,
  childSessionId: string,
): Promise<void> {
  const child = live.subagents.get(childSessionId);
  if (!child || child.ended) return;
  child.ended = true;
  try {
    await pageChild(live, childSessionId, child, {
      maxPages: CHILD_DRAIN_PAGE_MAX,
    });
  } finally {
    live.subagents.unregister(childSessionId);
    await live.rpc
      .request(
        "view/unsubscribe",
        { sessionId: childSessionId },
        CONTROL_TIMEOUT_MS,
      )
      .catch(() => undefined);
  }
}

function handleNotification(live: Live, method: string, params: unknown): void {
  const rec = asRecord(params);
  const sessionId = stringField(rec, "sessionId");
  if (sessionId && sessionId !== live.museSessionId) {
    handleChildNotification(live, sessionId, method, params);
    return;
  }

  switch (method) {
    case "item/started":
      emit(live, museItemEvent(rec?.item, "started", live.items));
      noteDrainEvidence(live, rec?.item, "started");
      noteSubagentItem(live, rec?.item, "started");
      settleOnDrain(live);
      return;
    case "item/updated":
      emit(live, museItemEvent(rec?.item, "updated", live.items));
      noteDrainEvidence(live, rec?.item, "updated");
      noteSubagentItem(live, rec?.item, "updated");
      settleOnDrain(live);
      return;
    case "item/completed": {
      const item = asRecord(rec?.item);
      const events = museItemEvent(item, "completed", live.items);
      const itemKind = stringField(item, "kind");
      // item/completed is the item's authoritative terminal revision, but
      // turn/completed can trail it by ~60s while Muse drains reminder-child
      // tasks (eot gate). Seal the stream here so a finished answer does not
      // render as still typing for the whole gate.
      if (itemKind === "agentMessage") {
        events.push({ type: "message.completed" });
      } else if (itemKind === "reasoning") {
        events.push({ type: "reasoning.completed" });
      }
      if (item && itemKind === "compaction") {
        const status = stringField(item, "status");
        const outcome = museItemStatus(status, true);
        if (outcome === "failed" || outcome === "cancelled") {
          live.compactionWait?.reject(
            new Error(
              stringField(item, "failureReason") ??
                `Muse compaction ${status ?? outcome}`,
            ),
          );
        } else {
          live.compactionWait?.resolve();
        }
        live.compactionWait = null;
      }
      emit(live, events);
      noteDrainEvidence(live, item, "completed");
      noteSubagentItem(live, item, "completed");
      settleOnDrain(live);
      return;
    }
    case "item/delta":
      emit(live, museDeltaEvent(rec, live.items));
      return;
    case "turn/started": {
      const turnId = stringField(rec, "turnId");
      if (turnId) {
        live.activeTurnId = turnId;
        live.queuedTurnIds.delete(turnId);
        live.hasCompletedReal = false;
        live.reminderIdleSeen = false;
        live.retryPending = false;
        live.drainSettledFor = null;
      }
      return;
    }
    case "turn/completed": {
      const turnId = stringField(rec, "turnId");
      if (!turnId) return;
      const terminal = stringField(rec, "terminal") ?? "completed";
      // Prompts the host forgot to settle must not outlive the turn.
      clearPending(live);
      if (terminal === "failed") {
        const error = museTurnError(rec) ?? new Error("Muse turn failed");
        if (!live.muteUpdates) {
          live.onEvent({ type: "message.completed" });
          live.onEvent({ type: "reasoning.completed" });
          live.onEvent({ type: "session.error", message: error.message });
        }
        settleTurn(live, turnId, error);
        return;
      }
      if (!live.muteUpdates) {
        live.onEvent({ type: "message.completed" });
        live.onEvent({ type: "reasoning.completed" });
        if (terminal === "cancelled") {
          live.onEvent({
            type: "status",
            text: "Muse cancelled the turn.",
          });
        }
      }
      settleTurn(live, turnId, undefined);
      return;
    }
    case "turn/unqueued": {
      const turnId = stringField(rec, "turnId");
      if (!turnId) return;
      if (!live.muteUpdates) {
        live.onEvent({
          type: "status",
          text: "Muse removed the queued turn.",
        });
      }
      settleTurn(live, turnId, undefined);
      return;
    }
    case "turn/retracted": {
      const turnId = stringField(rec, "turnId");
      emit(live, [
        { type: "status", text: "Muse retracted the submitted prompt." },
      ]);
      // A retracted submission never completes; settle its waiter.
      if (turnId) {
        settleTurn(
          live,
          turnId,
          new Error("Muse retracted the submitted prompt."),
        );
      }
      return;
    }
    case "turn/retryScheduled": {
      // A model retry is pending: all real items may be closed during the
      // backoff without the turn being done — hold off drain settlement
      // until the retry's real item starts.
      live.retryPending = true;
      const attempt = rec?.attempt;
      const next = rec?.nextAttempt;
      const max = rec?.maxAttempts;
      const delay = rec?.retryDelayMs;
      const reason = stringField(rec, "reason");
      const seconds =
        typeof delay === "number" && Number.isFinite(delay)
          ? ` in ${Math.round(delay / 1000)}s`
          : "";
      const label =
        typeof attempt === "number" && typeof next === "number"
          ? `attempt ${next}${typeof max === "number" ? `/${max}` : ""}`
          : "the model call";
      emit(live, [
        {
          type: "status",
          text: `Muse is retrying ${label}${seconds}${reason ? `: ${reason}` : "."}`,
        },
      ]);
      return;
    }
    case "approval/requested":
      handleApprovalRequested(live, params);
      return;
    case "approval/updated": {
      const refresh = museApprovalRefresh(params);
      if (!refresh) return;
      const uiId = live.approvalUiById.get(refresh.approvalId);
      const pending = uiId != null ? live.approvals.get(uiId) : undefined;
      if (pending && !pending.decidedLocally) {
        pending.requirementId = refresh.requirementId;
        if (refresh.choices.length > 0) pending.choices = refresh.choices;
      }
      return;
    }
    case "approval/resolved": {
      const approvalId = stringField(rec, "approvalId");
      const uiId = approvalId
        ? live.approvalUiById.get(approvalId)
        : undefined;
      if (uiId == null) return;
      const pending = live.approvals.get(uiId);
      live.approvals.delete(uiId);
      if (approvalId) live.approvalUiById.delete(approvalId);
      if (pending?.decidedLocally) return;
      live.onEvent({
        type: "approval.resolved",
        requestId: uiId,
        decision: museResolvedDecision(rec?.decision),
      });
      return;
    }
    case "userInput/requested":
      handleUserInputRequested(live, params);
      return;
    case "userInput/settled": {
      const userInputId = stringField(rec, "userInputId");
      const uiId = userInputId
        ? live.questionUiById.get(userInputId)
        : undefined;
      if (uiId == null) return;
      live.questions.delete(uiId);
      if (userInputId) live.questionUiById.delete(userInputId);
      live.onEvent({
        type: "question.resolved",
        requestId: uiId,
        decision:
          rec?.outcome === "answered" || rec?.outcome === "clarified"
            ? "answered"
            : "cancelled",
      });
      return;
    }
    case "session/todoListChanged": {
      const event = museTodoListEvent(params);
      if (event) emit(live, [event]);
      return;
    }
    case "session/goalChanged": {
      const text = museGoalText(params);
      if (text && text !== live.lastGoal) {
        live.lastGoal = text;
        emit(live, [{ type: "status", text }]);
      }
      return;
    }
    case "session/contextUsage": {
      const event = museContextEvent(params);
      if (event) emit(live, [event]);
      return;
    }
    case "session/modelChanged": {
      const modelId = stringField(rec, "modelId");
      if (modelId) {
        live.appliedModelId = modelId;
        emit(live, [
          { type: "session.configChanged", model: `muse:${modelId}` },
        ]);
      }
      return;
    }
    case "session/approvalModeChanged": {
      const mode = stringField(rec, "mode");
      if (mode) live.appliedMode = mode;
      return;
    }
    case "session/modelRouteUnserved": {
      const modelId = stringField(rec, "modelId");
      emit(live, [
        {
          type: "status",
          text: `Muse can no longer serve ${modelId ?? "the selected model"}; pick another model.`,
        },
      ]);
      // The unservable model should leave the picker.
      void populateCatalog(live);
      return;
    }
    case "session/branchChanged": {
      const branch = stringField(rec, "branch");
      if (branch) {
        emit(live, [{ type: "status", text: `Branch: ${branch}` }]);
      }
      return;
    }
    case "view/gap": {
      if (!live.gapNotified) {
        live.gapNotified = true;
        emit(live, [
          {
            type: "status",
            text: "Muse dropped transcript events (view gap); some entries may be missing.",
          },
        ]);
      }
      return;
    }
    default:
      // Unknown notifications are additive by contract; skip them.
      return;
  }
}

/** Re-issued pending requests after resume arrive as server→client requests. */
async function handleServerRequest(
  live: Live,
  rpc: JsonRpcClient,
  id: JsonRpcId,
  method: string,
  params: unknown,
): Promise<void> {
  if (method === "approval/request" || method === "userInput/request") {
    const acked = await rpc.respond(id, {}).then(
      () => true,
      () => false,
    );
    if (acked && !live.cancelled) dispatchServerRequest(live, method, params);
    return;
  }
  await rpc
    .respondError(id, {
      code: -32601,
      message: `Unsupported method: ${method}`,
    })
    .catch(() => undefined);
}

function dispatchServerRequest(
  live: Live,
  method: string,
  params: unknown,
): void {
  if (method === "approval/request") {
    handleApprovalRequested(live, params);
  } else if (method === "userInput/request") {
    handleUserInputRequested(live, params);
  }
}

function handleApprovalRequested(live: Live, params: unknown): void {
  const approval = museApprovalFromParams(params);
  if (!approval || approval.sessionId !== live.museSessionId) {
    // Cannot render or decide a request without a requirement token; say so
    // instead of leaving the host waiting on an invisible prompt.
    if (stringField(asRecord(params), "approvalId") && !live.muteUpdates) {
      live.onEvent({
        type: "status",
        text: "Muse asked for an approval in a form MonoCode cannot render.",
      });
    }
    return;
  }
  if (live.cancelled || live.muteUpdates) return;
  // A re-issued request for the same approval updates the pending entry;
  // it must not stack a second row or orphan the first.
  const knownId = live.approvalUiById.get(approval.approvalId);
  if (knownId != null) {
    const known = live.approvals.get(knownId);
    if (known && !known.decidedLocally) {
      known.requirementId = approval.requirementId;
      if (approval.choices.length > 0) known.choices = approval.choices;
    }
    return;
  }
  const uiId = live.nextUiId++;
  const pending: PendingApproval = {
    approvalId: approval.approvalId,
    sessionId: approval.sessionId,
    itemId: approval.itemId,
    requirementId: approval.requirementId,
    choices: approval.choices,
    title: approval.title,
    kind: approval.kind,
    preview: approval.preview,
  };
  live.approvals.set(uiId, pending);
  live.approvalUiById.set(approval.approvalId, uiId);
  // Refresh the gated tool row so the approval joins it by item id.
  live.onEvent({
    type: "tool.updated",
    callId: approval.itemId,
    title: approval.title,
    kind: approval.kind,
    ...(approval.preview ? { preview: approval.preview } : {}),
  });
  const auto = museAutoDecision(live.runtimeMode, live.planning, approval.kind);
  if (auto) {
    respondMuseApproval(live.sessionId, uiId, auto);
    return;
  }
  live.onEvent({
    type: "approval.requested",
    requestId: uiId,
    title: approval.title,
    kind: approval.kind,
    callId: approval.itemId,
    ...(approval.preview ? { preview: approval.preview } : {}),
  });
}

/**
 * Residual prompts that still arrive under an automated mode get answered
 * client-side, mirroring Codex/Devin: full-access allows everything,
 * auto-accept-edits allows file changes but still asks for commands, and a
 * plan turn allows reads/searches while denying everything else.
 */
function museAutoDecision(
  runtimeMode: RuntimeMode,
  planning: boolean,
  kind: string | undefined,
): ApprovalDecision | null {
  if (planning) {
    return kind === "read" || kind === "search" ? "allow" : "deny";
  }
  if (runtimeMode === "full-access") return "allow";
  if (runtimeMode === "auto-accept-edits" && kind === "edit") return "allow";
  return null;
}

function handleUserInputRequested(live: Live, params: unknown): void {
  const prompt = museUserInputFromParams(params);
  if (!prompt || prompt.sessionId !== live.museSessionId) {
    // A prompt with no renderable question still expects a settlement.
    const rec = asRecord(params);
    const userInputId = stringField(rec, "userInputId");
    const sessionId = stringField(rec, "sessionId");
    if (userInputId && sessionId === live.museSessionId) {
      if (!live.muteUpdates) {
        live.onEvent({
          type: "status",
          text: "Muse asked a question MonoCode cannot render; declining it.",
        });
      }
      void live.rpc
        .request(
          "userInput/cancel",
          {
            commandId: newCommandId(),
            reason: "Not renderable in MonoCode",
            sessionId,
            userInputId,
          },
          CONTROL_TIMEOUT_MS,
        )
        .catch(() => undefined);
    }
    return;
  }
  if (live.cancelled || live.muteUpdates) return;
  // Same approval dedupe: a re-issued request updates, never duplicates.
  const knownId = live.questionUiById.get(prompt.userInputId);
  if (knownId != null) {
    const known = live.questions.get(knownId);
    if (known) {
      known.questions = prompt.questions;
      known.raw = prompt.raw;
    }
    return;
  }
  const uiId = live.nextUiId++;
  live.questions.set(uiId, {
    userInputId: prompt.userInputId,
    sessionId: prompt.sessionId,
    questions: prompt.questions,
    raw: prompt.raw,
  });
  live.questionUiById.set(prompt.userInputId, uiId);
  live.onEvent({
    type: "question.asked",
    requestId: uiId,
    title: questionPromptTitle(prompt.questions),
    questions: prompt.questions,
    ...(prompt.itemId ? { callId: prompt.itemId } : {}),
    ...(prompt.autoResolveAt ? { autoResolveAt: prompt.autoResolveAt } : {}),
  });
}

/** Exported for tests. */
export function __museTestReset(): void {
  liveByThread.clear();
  resumeByThread.clear();
  cancelledThreads.clear();
}
