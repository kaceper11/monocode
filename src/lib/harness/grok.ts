import { nativeModelId } from "../models";
import { AcpSubagents } from "./acpSubagents";
import type { RuntimeMode } from "../session";
import { AcpClient, type AcpHandlers } from "./acp";
import type { JsonRpcId } from "./jsonRpc";
import {
  killChild,
  resolveGrokBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  AUTH_HELP,
  askQuestionResponse,
  askQuestionsFromAcp,
  asRecord,
  contextWindowFromSetup,
  currentModelId,
  eventsFromAcpUpdate,
  grokAuthError,
  grokAuthMethodId,
  grokEffort,
  grokPromptBlocks,
  grokSessionNewParams,
  grokSpawnArgs,
  permissionOptionId,
  permissionRequestFromAcp,
  pickAutoOption,
  planFromExitPlan,
  sessionIdFromResult,
} from "./grokProtocol";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  HarnessSessionInput,
  SendTurnInput,
  SteerTurnInput,
} from "./types";
import { questionPromptTitle, type UserQuestionReply } from "../userQuestion";

/** A parked permission request, kept with enough context to re-decide it when
 * the access mode changes mid-conversation. */
type PendingApproval = {
  kind?: string;
  optionIds: string[];
  resolve: (decision: ApprovalDecision) => void;
};

type Live = {
  subagents: AcpSubagents;
  acp: AcpClient;
  acpSessionId: string;
  cwd: string;
  modelId: string;
  contextWindow?: number;
  muteUpdates: boolean;
  cancelled: boolean;
  fullAccess: boolean;
  /** Server `autoMode` was requested at `session/new` and can't be revoked live. */
  autoMode: boolean;
  planning: boolean;
  runtimeMode: RuntimeMode;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<string, PendingApproval>;
  questions: Map<string, (reply: UserQuestionReply) => void>;
  /** Synthetic requestId source for ACP requests with non-numeric ids. */
  nextRequestId: number;
  turns: Promise<void>;
};

type Resume = {
  acpSessionId: string;
  cwd: string;
};

const INIT_TIMEOUT_MS = 12_000;
const AUTH_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 45_000;
const CONTROL_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();

/**
 * Live Grok Build adapter. Spawns `grok agent stdio` and talks ACP.
 * Grok accepts ACP image blocks despite advertising image: false.
 */
export async function sendGrokTurn(input: SendTurnInput): Promise<void> {
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
      // Posture applies when the queued turn actually runs — applying it at
      // enqueue time would flip the running turn's permission handling.
      live.runtimeMode = input.runtimeMode;
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await applyModelSelection(live, input);
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
    if (liveByThread.get(input.sessionId) === live) {
      await stopGrokSession(input.sessionId);
    }
    throw error;
  }
}

export async function compactGrokContext(
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
        await live.acp.request(
          "_x.ai/compact_conversation",
          { sessionId: live.acpSessionId },
          PROMPT_TIMEOUT_MS,
        );
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

export async function steerGrokTurn(_input: SteerTurnInput): Promise<void> {
  throw new Error("Grok Build does not support steering an in-flight turn");
}

export function respondGrokApproval(
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
 * Apply a UI access-mode change. Grok's `yoloMode`/`autoMode` flags are fixed
 * at `session/new`, so a live switch loosens through our own auto-answers —
 * the server still sends its asks and we grant them. Tightening away from
 * full-access cannot claw back a yolo session, so `fullAccess` stays stale and
 * `ensureLive` respawns on the next turn.
 */
export function setGrokRuntimeMode(
  sessionId: string,
  runtimeMode: RuntimeMode,
): void {
  const live = liveByThread.get(sessionId);
  if (!live || live.runtimeMode === runtimeMode) return;
  live.runtimeMode = runtimeMode;
  if (!live.planning) {
    // Looser modes are emulated by our own auto-answers, so record them as
    // established and skip a pointless respawn. Tightening keeps the stale
    // spawn flags, which makes ensureLive respawn to revoke them.
    if (runtimeMode === "full-access") live.fullAccess = true;
    if (runtimeMode === "auto") live.autoMode = true;
  }
  for (const [key, pending] of live.approvals) {
    if (!pickAutoOption(runtimeMode, pending.kind, pending.optionIds)) {
      continue;
    }
    live.approvals.delete(key);
    pending.resolve("allow");
  }
}

export function respondGrokQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
) {
  liveByThread.get(sessionId)?.questions.get(String(requestId))?.(reply);
}

export async function cancelGrokTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  for (const [, pending] of live.approvals) pending.resolve("deny");
  live.approvals.clear();
  for (const [, resolve] of live.questions) resolve({ kind: "skipped" });
  live.questions.clear();
  await live.acp
    .notify("session/cancel", { sessionId: live.acpSessionId })
    .catch(() => undefined);
  live.acp.rejectPending(new Error("cancelled"));
}

export async function stopGrokSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.muteUpdates = true;
    for (const [, pending] of live.approvals) pending.resolve("deny");
    live.approvals.clear();
    for (const [, resolve] of live.questions) resolve({ kind: "skipped" });
    live.questions.clear();
  }
  live?.acp.close();
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetGrokSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopGrokSession(sessionId);
}

export function bindGrokSession(
  threadId: string,
  acpSessionId: string,
  cwd: string,
): void {
  const sessionId = acpSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { acpSessionId: sessionId, cwd });
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const wantPlanning = input.intent === "plan";
  const wantFullAccess = input.runtimeMode === "full-access" && !wantPlanning;
  const wantAutoMode = input.runtimeMode === "auto" && !wantPlanning;
  const existing = liveByThread.get(input.sessionId);
  if (
    existing &&
    existing.cwd === input.cwd &&
    existing.fullAccess === wantFullAccess &&
    existing.autoMode === wantAutoMode &&
    existing.planning === wantPlanning
  ) {
    existing.onEvent = input.onEvent;
    return existing;
  }
  if (existing) {
    await stopGrokSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canLoad = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveGrokBinary(input.cwd);
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
    void handleRequest(live, id, method, params).catch((error) => {
      console.debug("[monocode] grok request handler failed", error);
      void acp
        .respondError(id, { code: -32603, message: "Internal error" })
        .catch(() => undefined);
    });
  };

  const emit = (event: HarnessEvent) => {
    (liveRef.current?.onEvent ?? input.onEvent)(event);
  };

  watchChild(
    input.sessionId,
    (line) => acp.pushLine(line),
    (code) => {
      acp.close(new Error("Grok Build exited"));
      const live = liveByThread.get(input.sessionId);
      liveByThread.delete(input.sessionId);
      if (live) {
        // Exit settles parked asks so the provider request and the UI card
        // both close instead of lingering on a dead child.
        live.muteUpdates = true;
        for (const [, pending] of live.approvals) pending.resolve("deny");
        live.approvals.clear();
        for (const [, resolve] of live.questions)
          resolve({ kind: "skipped" });
        live.questions.clear();
      }
      emit({ type: "session.ended", code });
    },
    (line) => {
      console.debug("[monocode] grok stderr", line);
      if (/not authenticated|Authentication required|XAI_API_KEY/i.test(line)) {
        emit({
          type: "session.error",
          message: `${line.trim()}\n\n${AUTH_HELP}`,
        });
      }
    },
  );

  await spawnChild(
    input.sessionId,
    path,
    grokSpawnArgs({
      model: input.model,
      effort: grokEffort(input.modelSettings),
      fullAccess: wantFullAccess,
      plan: wantPlanning,
    }),
    input.cwd,
  );

  try {
    let init: unknown;
    try {
      init = await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        INIT_TIMEOUT_MS,
      );
    } catch (error) {
      throw grokAuthError(error);
    }

    const methodId = grokAuthMethodId(init);
    if (methodId) {
      await acp
        .request(
          "authenticate",
          { methodId, _meta: { headless: true } },
          AUTH_TIMEOUT_MS,
        )
        .catch((error: unknown) => {
          console.debug("[monocode] grok authenticate", error);
        });
    }

    let setup: unknown;
    let acpSessionId: string | undefined;
    let didLoad = false;

    if (canLoad && resume) {
      try {
        setup = await acp.request(
          "session/resume",
          { sessionId: resume.acpSessionId },
          SESSION_TIMEOUT_MS,
        );
        acpSessionId = sessionIdFromResult(setup) ?? resume.acpSessionId;
        didLoad = true;
      } catch {
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
        } catch {
          setup = undefined;
          acpSessionId = undefined;
          didLoad = false;
        } finally {
          muteGate.current = false;
        }
      }
    }

    if (!acpSessionId) {
      try {
        setup = await acp.request(
          "session/new",
          grokSessionNewParams(input.cwd, input.runtimeMode),
          SESSION_TIMEOUT_MS,
        );
      } catch (error) {
        throw grokAuthError(error);
      }
      acpSessionId = sessionIdFromResult(setup);
    }
    if (!acpSessionId)
      throw new Error("Grok Build did not return a session id");

    const live: Live = {
      subagents: new AcpSubagents(),
      acp,
      acpSessionId,
      cwd: input.cwd,
      modelId: currentModelId(setup) ?? nativeModelId(input.model, input.cwd),
      contextWindow:
        contextWindowFromSetup(setup) ?? contextWindowFromSetup(init),
      muteUpdates: didLoad,
      cancelled: false,
      fullAccess: wantFullAccess,
      autoMode: wantAutoMode,
      planning: wantPlanning,
      runtimeMode: input.runtimeMode,
      onEvent: input.onEvent,
      approvals: new Map(),
      questions: new Map(),
      nextRequestId: 1_000_000_000,
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
    await stopGrokSession(input.sessionId);
    throw error;
  }
}

async function applyModelSelection(
  live: Live,
  input: HarnessSessionInput,
): Promise<void> {
  const base = nativeModelId(input.model, input.cwd);
  if (base && base !== live.modelId) {
    await live.acp
      .request(
        "session/set_model",
        { sessionId: live.acpSessionId, modelId: base },
        CONTROL_TIMEOUT_MS,
      )
      .then(() => {
        live.modelId = base;
      })
      .catch((error: unknown) => {
        ignoreUnsupportedControl("set_model", error);
      });
  }

  const effort = grokEffort(input.modelSettings);
  if (!effort) return;
  await live.acp
    .request(
      "session/set_mode",
      { sessionId: live.acpSessionId, modeId: effort },
      CONTROL_TIMEOUT_MS,
    )
    .catch((error: unknown) => {
      ignoreUnsupportedControl("set_mode", error);
    });
}

async function prompt(live: Live, input: SendTurnInput): Promise<void> {
  try {
    const blocks = grokPromptBlocks(input.text, input.attachments);
    if (blocks.length === 0) return;
    await live.acp.request(
      "session/prompt",
      {
        sessionId: live.acpSessionId,
        prompt: blocks,
      },
      PROMPT_TIMEOUT_MS,
    );
    if (live.cancelled) return;
    live.onEvent({ type: "message.completed" });
    live.onEvent({ type: "reasoning.completed" });
  } catch (error) {
    if (live.cancelled) return;
    const detail = error instanceof Error ? error.message : String(error);
    live.onEvent({
      type: "session.error",
      message: /auth|login|credential|api key|XAI_API_KEY/i.test(detail)
        ? `${detail.trim()}\n\n${AUTH_HELP}`
        : detail,
    });
    throw error;
  }
}

function ignoreUnsupportedControl(method: string, error: unknown): void {
  console.debug(`[monocode] grok ${method} failed`, error);
  const detail = error instanceof Error ? error.message : String(error);
  if (/timed out|not running|exited|closed|pipe/i.test(detail)) throw error;
}

function handleNotification(live: Live, method: string, params: unknown) {
  const updateParams =
    method === "session/update"
      ? params
      : method === "_x.ai/session_notification" ||
          method === "x.ai/session_notification"
        ? unwrapSessionNotification(params)
        : null;
  if (!updateParams) return;
  for (const event of live.subagents.route(updateParams, eventsFromAcpUpdate(updateParams))) {
    if (
      event.type === "context" &&
      event.window == null &&
      live.contextWindow
    ) {
      live.onEvent({ ...event, window: live.contextWindow });
    } else {
      live.onEvent(event);
    }
  }
}

function unwrapSessionNotification(params: unknown): unknown {
  const rec = asRecord(params);
  if (!rec) return params;
  if (rec.update != null || rec.sessionUpdate != null) return rec;
  const nested = asRecord(rec.notification) ?? asRecord(rec.payload);
  return nested ?? rec;
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
  if (
    method === "_x.ai/ask_user_question" ||
    method === "x.ai/ask_user_question"
  ) {
    await handleAskQuestion(live, id, params);
    return;
  }
  if (method === "_x.ai/exit_plan_mode" || method === "x.ai/exit_plan_mode") {
    const plan = planFromExitPlan(params);
    if (plan) live.onEvent({ type: "plan", text: plan });
    await live.acp
      // End the provider-owned plan turn without approving implementation.
      // MonoCode's separate Build turn is the only approval boundary.
      .respond(id, { outcome: "abandoned" })
      .catch(() => undefined);
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
    const readOnly = request.kind === "read" || request.kind === "search";
    const optionId = permissionOptionId(
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

  const auto = pickAutoOption(
    live.runtimeMode,
    request.kind,
    request.optionIds,
  );
  if (auto) {
    await live.acp
      .respond(id, { outcome: { outcome: "selected", optionId: auto } })
      .catch(() => undefined);
    return;
  }

  // The UI needs a numeric requestId; non-numeric ACP ids get a synthetic
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

  const decision = await new Promise<ApprovalDecision>((resolve) => {
    live.approvals.set(String(requestId), {
      kind: request.kind,
      optionIds: request.optionIds,
      resolve,
    });
  });
  live.approvals.delete(String(requestId));
  live.onEvent({ type: "approval.resolved", requestId, decision });

  const optionId = permissionOptionId(decision, request.optionIds);
  await live.acp
    .respond(
      id,
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    )
    .catch(() => undefined);
}

async function handleAskQuestion(live: Live, id: JsonRpcId, params: unknown) {
  if (live.cancelled || live.muteUpdates) {
    // ask_user_question's wire shape is flat — not the permission envelope.
    await live.acp
      .respond(id, { outcome: "skip_interview" })
      .catch(() => undefined);
    return;
  }
  const questions = askQuestionsFromAcp(params);
  const requestId = typeof id === "number" ? id : (live.nextRequestId += 1);
  live.onEvent({
    type: "question.asked",
    requestId,
    title: questionPromptTitle(questions),
    questions,
  });

  const reply = await new Promise<UserQuestionReply>((resolve) => {
    live.questions.set(String(requestId), resolve);
  });
  live.questions.delete(String(requestId));
  live.onEvent({
    type: "question.resolved",
    requestId,
    decision: reply.kind,
  });

  await live.acp
    .respond(id, askQuestionResponse(reply, questions))
    .catch(() => undefined);
}
