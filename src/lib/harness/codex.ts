import { nativeModelId, setCatalogError, setHarnessModels } from "../models";
import type { RuntimeMode } from "../session";
import { questionPromptTitle, type UserQuestionReply } from "../userQuestion";
import {
  killChild,
  resolveCodexBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  asRecord,
  buildThreadStartParams,
  buildTurnStartParams,
  buildTurnSteerParams,
  isRecoverableThreadResumeError,
  mapApprovalRequest,
  codexSubagentStates,
  codexSubagentThreadIds,
  mapCodexNotification,
  mapCodexSubagentSteps,
  stringField,
  toCodexApprovalDecision,
  type CodexApprovalKind,
} from "./codexProtocol";
import { JsonRpcClient, type JsonRpcId } from "./jsonRpc";
import {
  CODEX_SIGN_IN_ERROR,
  codexAccountSignedOut,
  listCodexModels,
} from "./codexCatalog";
import { codexQuestions, codexQuestionResponse } from "./codexQuestions";
import { codexMcpConfirmation } from "./codexElicitation";
import { snapshotRemainder } from "./streamText";
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

type ApprovalOutcome = ApprovalDecision | "cancelled";

type PendingApproval = {
  rpcId: JsonRpcId;
  threadId: string;
  kind: CodexApprovalKind;
  resolve: (decision: ApprovalOutcome) => void;
};

type PendingQuestion = {
  rpcId: JsonRpcId;
  threadId: string;
  event: Extract<HarnessEvent, { type: "question.asked" }>;
  isBlocking: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (reply: UserQuestionReply | "cancelled") => void;
};

// Match Codex's non-blocking question policy: a minute of grace, then a
// minute of countdown. Interaction keeps the question open for the user.
const QUESTION_AUTO_RESOLVE_MS = 120_000;

type Live = {
  rpc: JsonRpcClient;
  threadId: string;
  cwd: string;
  runtimeMode: RuntimeMode;
  planning: boolean;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, PendingApproval>;
  questions: Map<number, PendingQuestion>;
  visibleQuestionId: number | null;
  nextApprovalUiId: number;
  cancelled: boolean;
  cancellation: Promise<void> | null;
  cancelGeneration: number;
  muteUpdates: boolean;
  activeTurnId: string | null;
  completedTurnIds: Set<string>;
  turns: Promise<void>;
  /** Resolves when the current turn completes (or is cancelled). */
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  /** turn/completed arrived before runTurn registered turnDone. */
  turnEndPending: boolean;
  emittedText: Map<string, string>;
  /** The model the bound thread reports; backstops a placeholder picker id. */
  threadModel: string;
  /** Server requests received before the live session was bound. */
  earlyRequests: { id: JsonRpcId; method: string; params: unknown }[];
  /** Child thread id -> the agent tool row that spawned it. */
  subagentThreads: Map<string, string>;
  /** Child notifications that arrived before their row was known. */
  pendingSubagent: Map<string, Array<{ method: string; params: unknown; bytes: number }>>;
  pendingSubagentBytes: number;
  /** Agent rows still running, by call id, with the name to settle them under. */
  openAgentRows: Map<string, string>;
};

type Resume = {
  threadId: string;
  cwd: string;
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();
const START_CANCELLED = new Error("Codex session stopped during startup");
const startupByThread = new Map<string, { cancelled: boolean; rpc?: JsonRpcClient }>();

let resolveCodexBinaryImpl: (cwd?: string) => Promise<{ path: string }> =
  resolveCodexBinary;

/** Test seam. */
export function setCodexBinaryResolver(
  fn: () => Promise<{ path: string }>,
): void {
  resolveCodexBinaryImpl = fn;
}

export async function sendCodexTurn(input: SendTurnInput): Promise<void> {
  const previous = liveByThread.get(input.sessionId);
  const previousGeneration = previous?.cancelGeneration;
  let live: Live;
  try {
    live = await acquireLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    if (error === START_CANCELLED) return;
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;
  if (previous === live && previous.cancelGeneration !== previousGeneration) return;
  const generation = live.cancelGeneration;

  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      if (liveByThread.get(input.sessionId) !== live || live.cancelGeneration !== generation) return;
      live.onEvent = input.onEvent;
      live.runtimeMode = input.runtimeMode;
      live.planning = input.intent === "plan";
      live.cancelled = false;
      live.muteUpdates = false;
      flushEarlyRequests(live);
      try {
        await runTurn(live, input);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

export async function compactCodexContext(
  input: CompactContextInput,
): Promise<void> {
  const previous = liveByThread.get(input.sessionId);
  const previousGeneration = previous?.cancelGeneration;
  let live: Live;
  try {
    live = await acquireLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    if (error === START_CANCELLED) return;
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;
  if (previous === live && previous.cancelGeneration !== previousGeneration) return;
  const generation = live.cancelGeneration;

  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      if (liveByThread.get(input.sessionId) !== live || live.cancelGeneration !== generation) return;
      live.onEvent = input.onEvent;
      live.cancelled = false;
      live.muteUpdates = false;
      flushEarlyRequests(live);
      try {
        await runCompaction(live);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

export function canSteerCodexSession(sessionId: string): boolean {
  const live = liveByThread.get(sessionId);
  return !!live?.activeTurnId && !live.cancelled && !live.muteUpdates;
}

export async function steerCodexTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live || live.cwd !== input.cwd) throw new Error("No active Codex session in this workspace");
  const turnId = live.activeTurnId;
  if (!turnId) throw new Error("No active turn to steer");

  const params = buildTurnSteerParams({
    threadId: live.threadId,
    expectedTurnId: turnId,
    prompt: input.text.trim() || undefined,
    attachments: input.attachments,
  });
  if (
    !params.input ||
    (Array.isArray(params.input) && params.input.length === 0)
  ) {
    return;
  }

  await live.rpc.request("turn/steer", params);
}

/**
 * Apply a UI access-mode change to the live thread: parked approvals the new
 * mode would have answered itself are settled immediately. The running turn's
 * server-side sandbox/approval policy was fixed at `turn/start`; the mode
 * fully applies to new approval requests and to the next turn's policy.
 */
export function setCodexRuntimeMode(
  sessionId: string,
  runtimeMode: RuntimeMode,
): void {
  const live = liveByThread.get(sessionId);
  if (!live || live.runtimeMode === runtimeMode) return;
  live.runtimeMode = runtimeMode;
  for (const [uiId, pending] of live.approvals) {
    const decision = autoApproval(runtimeMode, pending.kind);
    if (!decision) continue;
    live.approvals.delete(uiId);
    pending.resolve(decision);
  }
}

export function respondCodexApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.approvals.get(requestId);
  if (!pending) return;
  pending.resolve(decision);
}

export function respondCodexQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
): void {
  liveByThread.get(sessionId)?.questions.get(requestId)?.resolve(reply);
}

export function keepCodexQuestionOpen(
  sessionId: string,
  requestId: number,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.questions.get(requestId);
  if (!live || !pending || pending.timer === undefined) return;
  clearTimeout(pending.timer);
  pending.timer = undefined;
  live.onEvent({ type: "question.updated", requestId });
}

function clearServerRequests(live: Live): void {
  for (const pending of live.approvals.values()) pending.resolve("cancelled");
  for (const pending of live.questions.values()) {
    clearTimeout(pending.timer);
    pending.resolve("cancelled");
  }
  live.approvals.clear();
  live.questions.clear();
  live.visibleQuestionId = null;
}

function showNextQuestion(live: Live): void {
  if (
    live.visibleQuestionId !== null &&
    live.questions.has(live.visibleQuestionId)
  )
    return;
  const next = live.questions.entries().next().value;
  live.visibleQuestionId = next?.[0] ?? null;
  if (next) {
    const pending = next[1];
    if (!pending.isBlocking) {
      pending.event.autoResolveAt = Date.now() + QUESTION_AUTO_RESOLVE_MS;
      pending.timer = setTimeout(
        () => pending.resolve({ kind: "skipped" }),
        QUESTION_AUTO_RESOLVE_MS,
      );
    }
    live.onEvent(pending.event);
  }
}

export async function cancelCodexTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    if (startupByThread.has(sessionId)) await stopCodexSession(sessionId);
    return;
  }
  if (live.cancellation) return live.cancellation;
  live.cancelGeneration += 1;
  live.cancelled = true;
  live.muteUpdates = true;
  // Admission has no interruptible ID yet; close the owned host so the
  // acknowledged request cannot execute after Stop. Resume stays available.
  if (!live.activeTurnId) {
    await stopCodexSession(sessionId);
    return;
  }
  clearServerRequests(live);
  const turnId = live.activeTurnId;
  // The visible turn settles at Stop press — the interrupt below only tells
  // the host and must not hold the UI open for the wire round-trip. The
  // remembered id keeps a late turn/completed from sealing the next turn.
  rememberCompletedTurn(live, turnId);
  finishActiveTurn(live, [
    { type: "message.completed" },
    { type: "reasoning.completed" },
  ]);
  const work = (async () => {
    try {
      await live.rpc.request("turn/interrupt", {
        threadId: live.threadId,
        turnId,
      }, 15_000);
    } catch {
      // A rejected or unconfirmed Stop must not leave hidden execution alive.
      if (liveByThread.get(sessionId) === live) await stopCodexSession(sessionId);
    }
  })();
  live.cancellation = work;
  // Awaiters see the work through `live.cancellation`; the detached cleanup
  // chain must not surface a second unhandled rejection.
  void work
    .finally(() => {
      if (live.cancellation === work) live.cancellation = null;
    })
    .catch(() => undefined);
}

export async function stopCodexSession(sessionId: string): Promise<void> {
  const startup = startupByThread.get(sessionId);
  if (startup) {
    startup.cancelled = true;
    startup.rpc?.close(START_CANCELLED);
    startingByThread.delete(sessionId);
  }
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.cancelGeneration += 1;
    live.muteUpdates = true;
    live.cancelled = true;
    clearServerRequests(live);
    live.turnDone?.();
    live.turnDone = null;
    live.turnFailed = null;
    live.rpc.close();
  }
  // Only kill a child this adapter owns — after a harness switch another
  // adapter may hold a live child under the same session id.
  if (live || startup || startingByThread.has(sessionId)) {
    unwatchChild(sessionId);
    await killChild(sessionId).catch(() => undefined);
  }
}

export async function forgetCodexSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopCodexSession(sessionId);
}

export function bindCodexSession(
  threadId: string,
  providerSessionId: string,
  cwd: string,
): void {
  const providerThreadId = providerSessionId.trim();
  if (!threadId || !providerThreadId || !cwd.trim()) return;
  resumeByThread.set(threadId, { threadId: providerThreadId, cwd });
}

/** In-flight cold starts: a prewarm and a send share one spawn. */
const startingByThread = new Map<string, Promise<Live>>();

/** ensureLive wrapper that dedupes concurrent cold starts of one thread. */
async function acquireLive(
  input: HarnessSessionInput,
  keepExisting = false,
): Promise<Live> {
  const cancellation = liveByThread.get(input.sessionId)?.cancellation;
  if (cancellation) await cancellation;
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
export async function prewarmCodexSession(
  input: HarnessSessionInput,
): Promise<void> {
  if (liveByThread.has(input.sessionId)) return;
  try { await acquireLive(input, true); } catch (error) {
    if (error !== START_CANCELLED) throw error;
  }
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    return existing;
  }
  if (existing) {
    resumeByThread.delete(input.sessionId);
    await stopCodexSession(input.sessionId);
  }

  const startup: { cancelled: boolean; rpc?: JsonRpcClient } = { cancelled: false };
  startupByThread.set(input.sessionId, startup);
  try {
    return await startLive(input, startup);
  } catch (error) {
    if (startup.cancelled) throw START_CANCELLED;
    throw error;
  } finally {
    if (startupByThread.get(input.sessionId) === startup) startupByThread.delete(input.sessionId);
  }
}

async function startLive(
  input: HarnessSessionInput,
  startup: { cancelled: boolean; rpc?: JsonRpcClient },
): Promise<Live> {
  const assertStarting = () => {
    if (startup.cancelled) throw START_CANCELLED;
  };
  const resume = resumeByThread.get(input.sessionId);
  const canResume = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveCodexBinaryImpl(input.cwd);
  assertStarting();
  markTurn(input.sessionId, "codex binary resolved");
  const liveRef: { current: Live | null } = { current: null };
  // Requests can race session binding (e.g. a pending approval re-issued by
  // thread/resume). The app-server awaits our response, so they are buffered
  // and dispatched once the session is live and unmuted — never left hanging.
  const earlyRequests: { id: JsonRpcId; method: string; params: unknown }[] =
    [];

  const rpc = new JsonRpcClient(
    input.sessionId,
    {
      onNotification: (method, params) => {
        const live = liveRef.current;
        if (!live || live.muteUpdates) return;
        handleNotification(live, method, params);
      },
      onRequest: (id, method, params) => {
        const live = liveRef.current;
        // The external clock can be requested before thread/start or resume
        // returns, so it must not depend on the live session being bound.
        if (method === "currentTime/read") {
          void rpc
            .respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) })
            .catch(() => undefined);
          return;
        }
        if (!live) {
          earlyRequests.push({ id, method, params });
          return;
        }
        const turn = live.turnDone;
        void handleServerRequest(live, id, method, params).catch(
          (error: unknown) => {
            if (live.muteUpdates || live.turnDone !== turn) return;
            const failure =
              error instanceof Error ? error : new Error(String(error));
            if (live.turnFailed) {
              live.turnFailed(failure);
            } else {
              live.onEvent({
                type: "session.error",
                message: failure.message,
              });
            }
          },
        );
      },
    },
    { includeJsonrpc: false, label: "codex" },
  );

  startup.rpc = rpc;
  assertStarting();

  watchChild(
    input.sessionId,
    (line) => rpc.pushLine(line),
    (code) => {
      rpc.close(new Error("Codex app-server exited"));
      liveByThread.delete(input.sessionId);
      const live = liveRef.current;
      if (!live?.muteUpdates) {
        (live?.onEvent ?? input.onEvent)({ type: "session.ended", code });
      }
      live?.turnFailed?.(new Error("Codex app-server exited"));
      if (live) {
        clearServerRequests(live);
        live.turnDone = null;
        live.turnFailed = null;
      }
    },
  );

  try {
    await spawnChild(input.sessionId, path, ["app-server"], input.cwd);
    assertStarting();
    markTurn(input.sessionId, "codex spawned");
    await rpc.request("initialize", {
      clientInfo: {
        name: "monocode",
        title: "MonoCode",
        version: "0.1.0",
      },
      capabilities: {
        // Required by collaborationMode (including Plan); currentTime/read is
        // handled above even while the thread is starting or resuming.
        experimentalApi: true,
      },
    });
    await rpc.notify("initialized", undefined);
    markTurn(input.sessionId, "codex initialized");

    const model = nativeModelId(input.model, input.cwd);
    const serviceTier = input.modelSettings?.serviceTier;

    let threadId: string | undefined;
    let threadModel = "";
    let didResume = false;

    if (canResume && resume) {
      try {
        const opened = await rpc.request<{
          thread?: { id?: string; model?: string };
        }>("thread/resume", {
          threadId: resume.threadId,
          ...buildThreadStartParams({
            cwd: input.cwd,
            runtimeMode: input.runtimeMode,
            model,
            serviceTier,
          }),
        });
        threadId = opened.thread?.id ?? resume.threadId;
        threadModel = opened.thread?.model ?? "";
        didResume = true;
      } catch (error) {
        if (!isRecoverableThreadResumeError(error)) throw error;
        threadId = undefined;
      }
    }

    if (!threadId) {
      const opened = await rpc.request<{
        thread?: { id?: string; model?: string };
      }>(
        "thread/start",
        buildThreadStartParams({
          cwd: input.cwd,
          runtimeMode: input.runtimeMode,
          model,
          serviceTier,
        }),
      );
      threadId = opened.thread?.id?.trim();
      threadModel = opened.thread?.model ?? "";
    }

    if (!threadId) throw new Error("Codex did not return a thread id");
    markTurn(
      input.sessionId,
      didResume ? "codex thread resumed" : "codex thread started",
    );

    const live: Live = {
      rpc,
      threadId,
      cwd: input.cwd,
      runtimeMode: input.runtimeMode,
      planning: input.intent === "plan",
      onEvent: input.onEvent,
      approvals: new Map(),
      questions: new Map(),
      visibleQuestionId: null,
      nextApprovalUiId: 1,
      cancelled: false,
      cancellation: null,
      cancelGeneration: 0,
      muteUpdates: didResume,
      activeTurnId: null,
      completedTurnIds: new Set(),
      turns: Promise.resolve(),
      turnDone: null,
      turnFailed: null,
      turnEndPending: false,
      emittedText: new Map(),
      threadModel,
      earlyRequests,
      subagentThreads: new Map(),
      pendingSubagent: new Map(),
      pendingSubagentBytes: 0,
      openAgentRows: new Map(),
    };
    assertStarting();
    liveRef.current = live;
    liveByThread.set(input.sessionId, live);
    resumeByThread.set(input.sessionId, {
      threadId,
      cwd: input.cwd,
    });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: threadId,
    });
    live.onEvent({ type: "session.started" });
    void populateCatalog(input.sessionId, live);
    return live;
  } catch (error) {
    rpc.close(error instanceof Error ? error : new Error(String(error)));
    if (!startup.cancelled) {
      if (startupByThread.get(input.sessionId) === startup) startupByThread.delete(input.sessionId);
      await stopCodexSession(input.sessionId);
    }
    throw error;
  }
}


/**
 * The session's app-server already answers account/read and model/list, so the
 * picker catalog can be warmed from it instead of booting a second Codex
 * process. Best-effort: catalog work must never fail a live session.
 */
async function populateCatalog(sessionId: string, live: Live): Promise<void> {
  try {
    // No per-request timers: the session close rejects any pending reuse work.
    const account = await live.rpc
      .request<{ account?: unknown; requiresOpenaiAuth?: boolean }>(
        "account/read",
        {},
      )
      .catch(() => null);
    if (liveByThread.get(sessionId) !== live) return;
    if (codexAccountSignedOut(account)) {
      setCatalogError("codex", CODEX_SIGN_IN_ERROR, live.cwd);
      return;
    }
    const models = await listCodexModels(live.rpc, 0);
    if (liveByThread.get(sessionId) === live) {
      setHarnessModels("codex", models, live.cwd);
    }
  } catch {
    // A turn in flight is never interrupted by catalog reuse.
  }
}

async function runTurn(live: Live, input: SendTurnInput): Promise<void> {
  // The picker's "Default" entry resolves to an empty native id; sending ""
  // in collaborationMode.settings.model is schema-valid but the server then
  // rejects the model call. Fall back to the model the thread reports.
  const model = nativeModelId(input.model, input.cwd) || live.threadModel;
  const effort = input.modelSettings?.reasoningEffort;
  const serviceTier = input.modelSettings?.serviceTier;

  const params = buildTurnStartParams({
    threadId: live.threadId,
    runtimeMode: input.runtimeMode,
    prompt: input.text.trim() || undefined,
    attachments: input.attachments,
    model,
    effort,
    serviceTier,
    intent: input.intent,
  });

  if (Array.isArray(params.input) && params.input.length === 0) {
    return;
  }

  live.emittedText.clear();

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  settlePendingTurn(live);

  try {
    const response = await live.rpc.request<{ turn?: { id?: string } }>(
      "turn/start",
      params,
    );
    markTurn(input.sessionId, "codex turn/start ack");
    const turnId = response.turn?.id;
    if (turnId && live.turnDone) {
      live.activeTurnId = live.activeTurnId ?? turnId;
    }
    settlePendingTurn(live);
    await turnPromise;
  } catch (error) {
    if (live.cancelled) return;
    live.onEvent({
      type: "session.error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    live.turnDone = null;
    live.turnFailed = null;
  }
}

async function runCompaction(live: Live): Promise<void> {
  live.emittedText.clear();
  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  settlePendingTurn(live);

  try {
    await live.rpc.request("thread/compact/start", {
      threadId: live.threadId,
    });
    settlePendingTurn(live);
    await turnPromise;
  } finally {
    live.turnDone = null;
    live.turnFailed = null;
  }
}

function handleNotification(live: Live, method: string, params: unknown): void {
  const rec = asRecord(params);
  if (method === "serverRequest/resolved") {
    for (const pending of live.approvals.values()) {
      if (
        pending.rpcId === rec?.requestId &&
        pending.threadId === rec?.threadId
      )
        pending.resolve("cancelled");
    }
    for (const pending of live.questions.values()) {
      if (
        pending.rpcId === rec?.requestId &&
        pending.threadId === rec?.threadId
      )
        pending.resolve("cancelled");
    }
    return;
  }
  // Child threads share this connection. Their lifecycle must not touch the
  // parent's turn or clear its approvals, but what they do is the inside of a
  // subagent — mirror it onto the row that spawned them.
  const threadId =
    stringField(rec, "threadId") ??
    (method === "thread/started"
      ? stringField(asRecord(rec?.thread), "id")
      : undefined);
  if (threadId && threadId !== live.threadId) {
    handleSubagentNotification(live, threadId, method, params);
    return;
  }
  const eventTurnId = stringField(rec, "turnId") ?? stringField(asRecord(rec?.turn), "id");
  if (eventTurnId && live.completedTurnIds.has(eventTurnId)) return;
  if ((method === "turn/completed" || method === "turn/aborted") &&
      eventTurnId && live.activeTurnId && eventTurnId !== live.activeTurnId) return;
  // A Codex turn is a sequence of items. Completing an agentMessage does not
  // mean the turn is over — more tools and messages can still arrive. Only
  // turn/completed (and turn/aborted) settle sendCodexTurn, which is what the
  // UI uses for busy / stop / "Working for".
  const mapped = mapCodexNotification(method, params);
  if (mapped.diagnostic) {
    console.debug(
      `[monocode] codex ${live.threadId} ${method}`,
      mapped.diagnostic,
    );
  }
  // Codex describes one spawned agent through more than one item type. The
  // first row to name a child thread owns it; a later item for the same thread
  // would otherwise stand up a second agent that never does anything.
  const duplicate = bindSubagentThreads(live, method, rec);
  const snapshot = method === "item/completed";
  for (const event of mapped.events) {
    if (duplicate && duplicateAgentRow(event)) continue;
    trackAgentRow(live, event);
    if (event.type === "message.delta") {
      publishCodexText(live, "assistant", event.text, snapshot, stringField(rec, "itemId") ?? stringField(asRecord(rec?.item), "id"));
      continue;
    }
    if (event.type === "reasoning.delta") {
      publishCodexText(live, "reasoning", event.text, snapshot, stringField(rec, "itemId") ?? stringField(asRecord(rec?.item), "id"));
      continue;
    }
    live.onEvent(event);
  }
  if (snapshot) {
    const item = asRecord(rec?.item);
    const role = item?.type === "agentMessage" ? "assistant" : item?.type === "reasoning" ? "reasoning" : undefined;
    if (role) {
      live.emittedText.delete(`${role}:${stringField(item, "id") ?? "current"}`);
      live.emittedText.delete(`${role}:current`);
    }
  }
  // Metadata and steps can arrive before the spawn. Create its row first.
  for (const childId of codexSubagentThreadIds(asRecord(rec?.item) ?? {})) {
    const owner = live.subagentThreads.get(childId);
    if (!owner) continue;
    const backlog = live.pendingSubagent.get(childId);
    live.pendingSubagent.delete(childId);
    for (const pending of backlog ?? []) {
      live.pendingSubagentBytes -= pending.bytes;
      emitSubagentSteps(live, owner, pending.method, pending.params);
    }
  }
  settleSubagentRows(live, rec);
  if (mapped.activeTurnId !== undefined) {
    live.activeTurnId = mapped.activeTurnId;
  }
  if (mapped.turnCompleted) {
    rememberCompletedTurn(live, eventTurnId ?? live.activeTurnId);
    finishActiveTurn(live);
  }
}

/**
 * How many notifications a not-yet-identified child thread may bank. Codex can
 * stream a subagent's first calls before the spawn item reports which thread it
 * created, and those calls are the most interesting ones — but an unrecognised
 * thread must not be able to grow this without bound.
 */
const MAX_PENDING_SUBAGENT = 64;

/**
 * Learns which agent row a child thread belongs to.
 * Returns true when every thread this item names already belongs to another
 * row, which makes the item a second description of an agent we already show.
 */
function bindSubagentThreads(
  live: Live,
  method: string,
  rec: Record<string, unknown> | null,
): boolean {
  if (method !== "item/started" && method !== "item/completed") return false;
  const item = asRecord(rec?.item);
  if (!item) return false;
  const itemType = stringField(item, "type") ?? "";
  if (itemType !== "subAgentActivity" && itemType !== "collabAgentToolCall") {
    return false;
  }
  const callId = stringField(item, "id");
  if (!callId) return false;
  const children = codexSubagentThreadIds(item).filter(
    (childId) => childId !== live.threadId,
  );
  let claimed = 0;
  for (const childId of children) {
    const owner = live.subagentThreads.get(childId);
    if (owner) {
      const model = stringField(item, "model");
      if (model && item.tool === "spawnAgent")
        live.onEvent({
          type: "tool.updated",
          callId: owner,
          kind: "agent",
          agentModel: model,
        });
      if (owner !== callId) claimed += 1;
      continue;
    }
    if (live.subagentThreads.size >= 128) {
      const retired = [...live.subagentThreads].find(([, row]) => !live.openAgentRows.has(row));
      if (retired) live.subagentThreads.delete(retired[0]);
      else continue;
    }
    live.subagentThreads.set(childId, callId);
  }
  return children.length > 0 && claimed === children.length;
}

/**
 * An agent row for a child thread another row already owns. A failure still
 * gets its row — the reason a run died is the one thing worth a line of its
 * own — but a duplicate "running" or "done" is just noise.
 */
function duplicateAgentRow(event: HarnessEvent): boolean {
  if (event.type !== "tool.started" && event.type !== "tool.updated") {
    return false;
  }
  return event.kind === "agent" && event.status !== "failed";
}

/**
 * A child thread's notification. Until the spawn item says which row the thread
 * belongs to, keep it: dropping it loses the opening moves of the run.
 */
function handleSubagentNotification(
  live: Live,
  threadId: string,
  method: string,
  params: unknown,
): void {
  const callId = live.subagentThreads.get(threadId);
  if (callId) {
    emitSubagentSteps(live, callId, method, params);
    return;
  }
  if (
    method !== "item/started" &&
    method !== "item/completed" &&
    method !== "thread/started"
  )
    return;
  const backlog = live.pendingSubagent.get(threadId) ?? [];
  const bytes = JSON.stringify(params ?? null).length * 2;
  if (backlog.length >= MAX_PENDING_SUBAGENT || bytes > 64 * 1024 ||
      live.pendingSubagentBytes + bytes > 1024 * 1024 ||
      (!live.pendingSubagent.has(threadId) && live.pendingSubagent.size >= 64)) return;
  backlog.push({ method, params, bytes });
  live.pendingSubagentBytes += bytes;
  live.pendingSubagent.set(threadId, backlog);
}

function emitSubagentSteps(
  live: Live,
  callId: string,
  method: string,
  params: unknown,
): void {
  for (const event of mapCodexSubagentSteps(callId, method, params)) {
    live.onEvent(event);
  }
}

/** Remembers an agent row while it runs, so the turn can close it out. */
function trackAgentRow(live: Live, event: HarnessEvent): void {
  if (event.type !== "tool.started" && event.type !== "tool.updated") return;
  if (event.kind !== "agent") return;
  if (event.status === "in_progress" || event.status === "pending") {
    live.openAgentRows.set(event.callId, event.title ?? "Subagent");
    return;
  }
  live.openAgentRows.delete(event.callId);
}

/**
 * Settles spawned agents from the per-agent state a collab item reports. The
 * spawn call returns immediately; this is the first word on whether the agent
 * it started actually finished.
 */
function settleSubagentRows(
  live: Live,
  rec: Record<string, unknown> | null,
): void {
  const item = asRecord(rec?.item);
  if (!item) return;
  for (const state of codexSubagentStates(item)) {
    const callId = live.subagentThreads.get(state.threadId);
    const title = callId ? live.openAgentRows.get(callId) : undefined;
    if (!callId || !title) continue;
    live.openAgentRows.delete(callId);
    live.onEvent({
      type: "tool.updated",
      callId,
      title,
      kind: "agent",
      status: state.status,
      ...(state.message ? { detail: state.message } : {}),
    });
  }
}

/**
 * A turn cannot end with an agent still working. Codex does not always report
 * a closing state for every child, and a row left running would hop forever.
 */
function closeOpenAgentRows(live: Live): void {
  for (const [callId, title] of live.openAgentRows) {
    live.onEvent({
      type: "tool.updated",
      callId,
      title,
      kind: "agent",
      status: "completed",
    });
  }
  live.openAgentRows.clear();
}

function publishCodexText(
  live: Live,
  role: "assistant" | "reasoning",
  text: string,
  snapshot: boolean,
  itemId?: string,
): void {
  const keyed = `${role}:${itemId ?? "current"}`;
  const key = snapshot && !live.emittedText.has(keyed) && live.emittedText.has(`${role}:current`) ? `${role}:current` : keyed;
  const already = live.emittedText.get(key) ?? "";
  const emit = snapshot ? snapshotRemainder(already, text) : text;
  if (snapshot) live.emittedText.delete(key);
  else {
    if (live.emittedText.size >= 64 && !live.emittedText.has(key)) {
      live.emittedText.delete(live.emittedText.keys().next().value!);
    }
    live.emittedText.set(key, already + emit);
  }
  if (emit) live.onEvent({ type: role === "assistant" ? "message.delta" : "reasoning.delta", text: emit });
}

/** Keep recent terminal identities across admissions, including successful Stops. */
function rememberCompletedTurn(live: Live, turnId: string | null | undefined): void {
  if (!turnId || live.completedTurnIds.has(turnId)) return;
  if (live.completedTurnIds.size >= 64) {
    live.completedTurnIds.delete(live.completedTurnIds.values().next().value!);
  }
  live.completedTurnIds.add(turnId);
}

function finishActiveTurn(live: Live, extraEvents: HarnessEvent[] = []): void {
  clearServerRequests(live);
  closeOpenAgentRows(live);
  live.pendingSubagent.clear();
  live.pendingSubagentBytes = 0;
  live.turnEndPending = false;
  live.activeTurnId = null;
  live.emittedText.clear();
  for (const event of extraEvents) {
    live.onEvent(event);
  }
  const done = live.turnDone;
  const failed = live.turnFailed;
  live.turnDone = null;
  live.turnFailed = null;
  if (done) {
    done();
    return;
  }
  if (!failed) {
    live.turnEndPending = true;
  }
}

function settlePendingTurn(live: Live): void {
  if (!live.turnEndPending || !live.turnDone) return;
  finishActiveTurn(live);
}

/** Dispatch server requests buffered while the session was binding. */
function flushEarlyRequests(live: Live): void {
  const pending = live.earlyRequests.splice(0);
  for (const req of pending) {
    void handleServerRequest(live, req.id, req.method, req.params).catch(
      (error: unknown) => {
        void live.rpc
          .respondError(req.id, {
            code: -32603,
            message:
              error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      },
    );
  }
}

async function handleServerRequest(
  live: Live,
  id: JsonRpcId,
  method: string,
  params: unknown,
): Promise<void> {
  const threadId = stringField(asRecord(params), "threadId") ?? live.threadId;
  if (method === "item/tool/requestUserInput") {
    if (live.cancelled || live.muteUpdates) {
      await live.rpc.respond(id, { answers: {} });
      return;
    }
    let questions;
    try {
      questions = codexQuestions(params);
    } catch (error) {
      live.onEvent({
        type: "status",
        text: error instanceof Error ? error.message : String(error),
      });
      await live.rpc.respond(id, { answers: {} });
      return;
    }
    const uiId = live.nextApprovalUiId++;
    const event: Extract<HarnessEvent, { type: "question.asked" }> = {
      type: "question.asked",
      requestId: uiId,
      title: questionPromptTitle(questions),
      questions,
      callId: stringField(asRecord(params), "itemId"),
    };
    const outcome = new Promise<UserQuestionReply | "cancelled">((resolve) => {
      live.questions.set(uiId, {
        rpcId: id,
        threadId,
        event,
        resolve,
        // Older servers omit this field and must keep their blocking behavior.
        isBlocking: asRecord(params)?.isBlocking !== false,
      });
    }).finally(() => {
      clearTimeout(live.questions.get(uiId)?.timer);
      live.questions.delete(uiId);
    });
    showNextQuestion(live);
    const reply = await outcome;
    live.onEvent({
      type: "question.resolved",
      requestId: uiId,
      decision:
        reply === "cancelled"
          ? "cancelled"
          : reply.kind === "answered"
            ? "answered"
            : "skipped",
    });
    showNextQuestion(live);
    if (reply !== "cancelled")
      await live.rpc.respond(id, codexQuestionResponse(questions, reply));
    return;
  }

  if (method === "mcpServer/elicitation/request") {
    const confirmation = codexMcpConfirmation(params);
    if (!confirmation || live.cancelled || live.muteUpdates) {
      if (!live.cancelled && !live.muteUpdates)
        live.onEvent({
          type: "status",
          text: "This MCP server requested a form or browser sign-in that MonoCode does not support yet. Complete it in the server's own interface.",
        });
      await live.rpc.respond(id, {
        action: "cancel",
        content: null,
        _meta: null,
      });
      return;
    }
    if (live.planning) {
      // Plan turns surface no prompts — decline like the other approval paths.
      await live.rpc.respond(id, {
        action: "decline",
        content: null,
        _meta: null,
      });
      return;
    }
    if (live.runtimeMode === "full-access") {
      // Full access covers MCP consent the same way the CLI's own bypass
      // modes do — elicitation requests are accepted without a prompt.
      await live.rpc.respond(id, {
        action: "accept",
        content: confirmation.content,
        _meta: null,
      });
      return;
    }
    const uiId = live.nextApprovalUiId++;
    const pending = waitApproval(live, uiId, id, "permissions", threadId);
    live.onEvent({
      type: "approval.requested",
      requestId: uiId,
      kind: "mcp",
      title: confirmation.title,
    });
    const decision = await pending;
    live.onEvent({ type: "approval.resolved", requestId: uiId, decision });
    if (decision !== "cancelled")
      await live.rpc.respond(id, {
        action: decision === "allow" ? "accept" : "decline",
        content: decision === "allow" ? confirmation.content : null,
        _meta: null,
      });
    return;
  }

  const uiId = live.nextApprovalUiId++;
  const mapped = mapApprovalRequest(method, params, uiId);
  if (!mapped) {
    // An empty success or invented denial hides protocol incompatibility.
    live.onEvent({
      type: "status",
      text: `Unsupported Codex request: ${method}`,
    });
    await live.rpc.respondError(id, {
      code: -32601,
      message: `Unsupported method: ${method}`,
    });
    return;
  }

  if (live.planning || live.cancelled || live.muteUpdates) {
    // Plan turns run in a non-escalating read-only sandbox. If an older
    // app-server still asks for broader access, deny it silently instead of
    // leaking a Supervised approval prompt into the user's selected mode.
    if (method === "item/permissions/requestApproval") {
      await live.rpc.respond(id, { permissions: {} }).catch(() => undefined);
    } else {
      await live.rpc
        .respond(id, {
          decision: toCodexApprovalDecision("deny", mapped.kind),
        })
        .catch(() => undefined);
    }
    return;
  }

  if (method === "item/permissions/requestApproval") {
    // Auto-deny extra permission grants in supervised; allow in full-access.
    if (live.runtimeMode === "full-access") {
      const rec = asRecord(params);
      const permissions = rec?.permissions ?? {};
      await live.rpc.respond(id, {
        scope: "session",
        permissions,
      });
      return;
    }
    if (live.runtimeMode === "supervised") {
      const pending = waitApproval(live, uiId, id, mapped.kind, threadId);
      live.onEvent(mapped.event);
      const decision = await pending;
      live.onEvent({
        type: "approval.resolved",
        requestId: uiId,
        decision,
      });
      if (decision === "cancelled") return;
      if (decision === "allow") {
        const rec = asRecord(params);
        await live.rpc.respond(id, {
          scope: "turn",
          permissions: rec?.permissions ?? {},
        });
      } else {
        await live.rpc.respond(id, { permissions: {} });
      }
      return;
    }
    // auto / auto-accept: grant requested permissions for the turn.
    const rec = asRecord(params);
    await live.rpc.respond(id, {
      scope: "turn",
      permissions: rec?.permissions ?? {},
    });
    return;
  }

  const auto = autoApproval(live.runtimeMode, mapped.kind);
  if (auto) {
    await live.rpc.respond(id, {
      decision: toCodexApprovalDecision(auto, mapped.kind),
    });
    return;
  }

  const pending = waitApproval(live, uiId, id, mapped.kind, threadId);
  live.onEvent(mapped.event);
  const decision = await pending;
  live.onEvent({
    type: "approval.resolved",
    requestId: uiId,
    decision,
  });
  if (decision === "cancelled") return;
  await live.rpc.respond(id, {
    decision: toCodexApprovalDecision(decision, mapped.kind),
  });
}

function waitApproval(
  live: Live,
  uiId: number,
  rpcId: JsonRpcId,
  kind: CodexApprovalKind,
  threadId: string,
): Promise<ApprovalOutcome> {
  return new Promise<ApprovalOutcome>((resolve) => {
    live.approvals.set(uiId, { rpcId, threadId, kind, resolve });
  }).finally(() => {
    live.approvals.delete(uiId);
  });
}

function autoApproval(
  runtimeMode: RuntimeMode,
  kind: CodexApprovalKind,
): ApprovalDecision | null {
  if (runtimeMode === "supervised") return null;
  if (runtimeMode === "full-access") return "allow";
  if (runtimeMode === "auto") {
    // auto_review is set on the server; still prompt if Codex asks.
    return null;
  }
  // auto-accept-edits: auto file changes, ask for commands.
  if (kind === "file-change") return "allow";
  return null;
}

/** Exported for tests. */
export function __codexTestReset(): void {
  liveByThread.clear();
  resumeByThread.clear();
  cancelledThreads.clear();
  startupByThread.clear();
}

export function __codexTestResumeMap(): Map<string, Resume> {
  return resumeByThread;
}

/** Bounded-state inspection for regression tests. */
export function __codexTestRetained(sessionId: string) {
  const live = liveByThread.get(sessionId);
  return { children: live?.subagentThreads.size ?? 0, pending: live?.pendingSubagent.size ?? 0, bytes: live?.pendingSubagentBytes ?? 0, completedTurns: live?.completedTurnIds.size ?? 0 };
}
