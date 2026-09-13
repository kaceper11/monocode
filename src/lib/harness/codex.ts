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
  mapCodexNotification,
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
import { joinStreamText, snapshotRemainder } from "./streamText";
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
  /** Consent that must carry the user's decision even under full-access. */
  mustPrompt?: boolean;
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
  muteUpdates: boolean;
  activeTurnId: string | null;
  turns: Promise<void>;
  /** Resolves when the current turn completes (or is cancelled). */
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  /** turn/completed arrived before runTurn registered turnDone. */
  turnEndPending: boolean;
  emittedAssistant: string;
  emittedReasoning: string;
  /** The model the bound thread reports; backstops a placeholder picker id. */
  threadModel: string;
  /** Server requests received before the live session was bound. */
  earlyRequests: { id: JsonRpcId; method: string; params: unknown }[];
};

type Resume = {
  threadId: string;
  cwd: string;
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();

let resolveCodexBinaryImpl: (cwd?: string) => Promise<{ path: string }> =
  resolveCodexBinary;

/** Test seam. */
export function setCodexBinaryResolver(
  fn: () => Promise<{ path: string }>,
): void {
  resolveCodexBinaryImpl = fn;
}

export async function sendCodexTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await acquireLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
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
  let live: Live;
  try {
    live = await acquireLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
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

export async function steerCodexTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live) throw new Error("No active Codex session");
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
    if (pending.mustPrompt) continue;
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

export function keepCodexQuestionOpen(sessionId: string, requestId: number): void {
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
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  clearServerRequests(live);
  const turnId = live.activeTurnId;
  if (turnId) {
    await live.rpc
      .request("turn/interrupt", {
        threadId: live.threadId,
        turnId,
      })
      .catch(() => undefined);
  }
  finishActiveTurn(live, [
    { type: "message.completed" },
    { type: "reasoning.completed" },
  ]);
}

export async function stopCodexSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
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
  if (live || startingByThread.has(sessionId)) {
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
  await acquireLive(input, true);
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    existing.onEvent = input.onEvent;
    return existing;
  }
  if (existing) {
    resumeByThread.delete(input.sessionId);
    await stopCodexSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canResume = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveCodexBinaryImpl(input.cwd);
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

  await spawnChild(input.sessionId, path, ["app-server"], input.cwd);
  markTurn(input.sessionId, "codex spawned");

  try {
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
      muteUpdates: didResume,
      activeTurnId: null,
      turns: Promise.resolve(),
      turnDone: null,
      turnFailed: null,
      turnEndPending: false,
      emittedAssistant: "",
      emittedReasoning: "",
      threadModel,
      earlyRequests,
    };
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
    await stopCodexSession(input.sessionId);
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

  live.emittedAssistant = "";
  live.emittedReasoning = "";

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
    if (turnId) {
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
  live.emittedAssistant = "";
  live.emittedReasoning = "";
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
  // Child requests use this connection too, but their transcript and lifecycle
  // notifications must not change the parent's turn or clear its approvals.
  const threadId = stringField(rec, "threadId");
  if (threadId && threadId !== live.threadId) return;
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
  const snapshot = method === "item/completed";
  for (const event of mapped.events) {
    if (event.type === "message.delta") {
      publishCodexText(live, "assistant", event.text, snapshot);
      continue;
    }
    if (event.type === "reasoning.delta") {
      publishCodexText(live, "reasoning", event.text, snapshot);
      continue;
    }
    live.onEvent(event);
  }
  if (mapped.activeTurnId !== undefined) {
    live.activeTurnId = mapped.activeTurnId;
  }
  if (mapped.turnCompleted) {
    finishActiveTurn(live);
  }
}

function publishCodexText(
  live: Live,
  role: "assistant" | "reasoning",
  text: string,
  snapshot: boolean,
): void {
  const already =
    role === "assistant" ? live.emittedAssistant : live.emittedReasoning;
  const emit = snapshot ? snapshotRemainder(already, text) : text;
  if (!emit) return;
  if (role === "assistant") {
    live.emittedAssistant = joinStreamText(already, emit);
    live.onEvent({ type: "message.delta", text: emit });
    return;
  }
  live.emittedReasoning = joinStreamText(already, emit);
  live.onEvent({ type: "reasoning.delta", text: emit });
}

function finishActiveTurn(live: Live, extraEvents: HarnessEvent[] = []): void {
  clearServerRequests(live);
  live.turnEndPending = false;
  live.activeTurnId = null;
  live.emittedAssistant = "";
  live.emittedReasoning = "";
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
    const uiId = live.nextApprovalUiId++;
    const pending = waitApproval(live, uiId, id, "permissions", threadId, true);
    // MCP consent must carry the user's decision, including in Full Access.
    live.onEvent({
      type: "approval.requested",
      requestId: uiId,
      kind: "other",
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
  mustPrompt = false,
): Promise<ApprovalOutcome> {
  return new Promise<ApprovalOutcome>((resolve) => {
    live.approvals.set(uiId, { rpcId, threadId, kind, mustPrompt, resolve });
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
}

export function __codexTestResumeMap(): Map<string, Resume> {
  return resumeByThread;
}
