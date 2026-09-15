import { modelContextWindow, nativeModelId } from "../models";
import type { RuntimeMode } from "../session";
import { taskListFromToolInput } from "../taskList";
import {
  execChild,
  freeHarnessPort,
  killChild,
  resolveOpenCodeBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  OpenCodeClient,
  OpenCodeHttpError,
  type OpenCodeSession,
} from "./opencodeClient";
import {
  appendOpenCodeAssistantTextDelta,
  asRecord,
  buildOpenCodePermissionRules,
  compareSemver,
  contextUsedFromMessageInfo,
  detailFromToolPart,
  eventSessionId,
  isOpenCodeNotFound,
  openCodeChildSessionId,
  mergeOpenCodeAssistantText,
  MINIMUM_OPENCODE_VERSION,
  KNOWN_HIDDEN_AGENTS,
  parseOpenCodeModelSlug,
  parseOpenCodeVersion,
  parseServerUrlFromOutput,
  permissionTitle,
  previewFromToolPart,
  sessionErrorMessage,
  stringField,
  textDeltaEvent,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toolKindFromName,
  type OpenCodePart,
} from "./opencodeProtocol";
import {
  composeToolTitle,
  extractShellCommand,
  extractSkillName,
} from "./preview";
import { streamTextDelta } from "./streamText";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  HarnessSessionInput,
  SendTurnInput,
  SteerTurnInput,
} from "./types";
import {
  questionPromptTitle,
  questionsFromUnknown,
  selectedAnswerLabels,
  type UserQuestion,
  type UserQuestionReply,
} from "../userQuestion";

type PendingApproval = {
  id: string;
  /** Server permission name — decides whether a new mode covers this ask. */
  permission: string;
  resolve: (decision: ApprovalDecision) => void;
};

type PendingQuestion = {
  id: string;
  questions: UserQuestion[];
  resolve: (reply: UserQuestionReply) => void;
};

type Live = {
  client: OpenCodeClient;
  openCodeSessionId: string;
  cwd: string;
  runtimeMode: RuntimeMode;
  planning: boolean;
  /** Effective rule set last confirmed on the server — retries dedupe on it. */
  appliedRuntimeMode?: RuntimeMode;
  modeUpdates: Promise<void>;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, PendingApproval>;
  questions: Map<number, PendingQuestion>;
  visibleQuestionId: number | null;
  nextApprovalUiId: number;
  sessionParentById: Map<string, string | undefined>;
  /** Child session id -> the agent tool row that spawned it. */
  subagentSessions: Map<string, string>;
  subagentModels: Map<string, string>;
  /** Child parts that arrived before their row was known. */
  pendingSubagent: Map<string, OpenCodePart[]>;
  partById: Map<string, OpenCodePart>;
  partOwnerById: Map<string, string>;
  partsByMessage: Map<string, Set<string>>;
  completedParts: Map<string, number>;
  completedPartBytes: number;
  retiredPartIds: Set<string>;
  completedSubagents: Set<string>;
  emittedTextByPartId: Map<string, string>;
  messageRoleById: Map<string, "user" | "assistant" | "hidden">;
  cancelled: boolean;
  cancelVersion: number;
  muteUpdates: boolean;
  /** The server process exited — replies to parked asks have nowhere to go. */
  serverDead: boolean;
  turns: Promise<void>;
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  turnEndPending: boolean;
  activeTurn: boolean;
};

type Resume = {
  sessionId: string;
  cwd: string;
};

const SERVER_TIMEOUT_MS = 30_000;
const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();
const startingByThread = new Map<
  string,
  { controller: AbortController; promise: Promise<Live> }
>();

let resolveOpenCodeBinaryImpl: (cwd?: string) => Promise<{ path: string }> =
  resolveOpenCodeBinary;

/** Test seam. */
export function setOpenCodeBinaryResolver(
  fn: () => Promise<{ path: string }>,
): void {
  resolveOpenCodeBinaryImpl = fn;
}

export async function sendOpenCodeTurn(input: SendTurnInput): Promise<void> {
  const beforeStart = liveByThread.get(input.sessionId);
  const beforeVersion = beforeStart?.cancelVersion;
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  if (beforeStart && beforeStart.cancelVersion !== beforeVersion) return;
  const cancelVersion = live.cancelVersion;
  live.onEvent = input.onEvent;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      if (
        liveByThread.get(input.sessionId) !== live ||
        live.cancelVersion !== cancelVersion
      )
        return;
      // Posture applies when the queued turn actually runs — applying it at
      // enqueue time would flip the running turn's permission handling.
      live.planning = input.intent === "plan";
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await applyOpenCodeRuntimeMode(live, input.runtimeMode);
        let update: Promise<void>;
        do {
          update = live.modeUpdates;
          await update;
        } while (update !== live.modeUpdates);
        if (
          live.cancelled ||
          live.muteUpdates ||
          liveByThread.get(input.sessionId) !== live
        )
          return;
        await runTurn(live, input);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

export async function compactOpenCodeContext(
  input: CompactContextInput,
): Promise<void> {
  const beforeStart = liveByThread.get(input.sessionId);
  const beforeVersion = beforeStart?.cancelVersion;
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  if (beforeStart && beforeStart.cancelVersion !== beforeVersion) return;
  const cancelVersion = live.cancelVersion;
  const model = parseOpenCodeModelSlug(nativeModelId(input.model, input.cwd));
  if (!model) {
    throw new Error(
      "OpenCode models use provider/model ids. Wait for the catalog to load, then pick a model.",
    );
  }
  live.onEvent = input.onEvent;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      if (
        liveByThread.get(input.sessionId) !== live ||
        live.cancelVersion !== cancelVersion
      )
        return;
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await runCompaction(live, model);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

export function canSteerOpenCodeSession(sessionId: string): boolean {
  const live = liveByThread.get(sessionId);
  return !!live?.activeTurn && !live.cancelled && !live.muteUpdates;
}

export async function steerOpenCodeTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live?.activeTurn) throw new Error("No active turn to steer");

  const parsed = parseOpenCodeModelSlug(nativeModelId(input.model, input.cwd));
  if (!parsed) {
    throw new Error(
      "OpenCode models use provider/model ids. Wait for the catalog to load, then pick a model.",
    );
  }

  const parts = [
    ...(input.text.trim()
      ? [{ type: "text" as const, text: input.text.trim() }]
      : []),
    ...toOpenCodeFileParts(input.attachments),
  ];
  if (parts.length === 0) return;

  await live.client.promptAsync({
    sessionID: live.openCodeSessionId,
    model: parsed,
    agent: input.modelSettings?.agent,
    variant: input.modelSettings?.variant,
    parts,
  });
}

/**
 * Apply a UI access-mode change to the running server session: push fresh
 * permission rules over `updateSession` and settle parked asks the new rules
 * already allow.
 */
export function setOpenCodeRuntimeMode(
  sessionId: string,
  runtimeMode: RuntimeMode,
): void {
  const live = liveByThread.get(sessionId);
  if (!live) return;
  void applyOpenCodeRuntimeMode(live, runtimeMode).catch(
    async (error: unknown) => {
      if (live.muteUpdates) return;
      if (liveByThread.get(sessionId) !== live) return;
      live.onEvent({
        type: "session.error",
        message: `Could not change OpenCode permissions: ${error instanceof Error ? error.message : String(error)}`,
      });
      await disposeOpenCodeSession(sessionId);
    },
  );
}

function applyOpenCodeRuntimeMode(
  live: Live,
  runtimeMode: RuntimeMode,
): Promise<void> {
  live.runtimeMode = runtimeMode;
  const effective = live.planning ? "supervised" : runtimeMode;
  const update = live.modeUpdates
    .catch(() => undefined)
    .then(async () => {
      if (live.muteUpdates || live.serverDead)
        throw new Error("OpenCode session stopped");
      if (live.appliedRuntimeMode !== effective) {
        await live.client.updateSession(live.openCodeSessionId, {
          permission: buildOpenCodePermissionRules(effective),
        });
        live.appliedRuntimeMode = effective;
      }
      // Only the latest confirmed UI posture can release parked operations.
      if (live.runtimeMode !== runtimeMode || live.planning || live.muteUpdates)
        return;
      for (const [uiId, pending] of live.approvals) {
        if (!openCodeAutoAllow(runtimeMode, pending.permission)) continue;
        live.approvals.delete(uiId);
        pending.resolve("allow");
      }
    });
  live.modeUpdates = update;
  return update;
}

/** Would the new mode's generated rules let this permission through unasked? */
function openCodeAutoAllow(
  runtimeMode: RuntimeMode,
  permission: string,
): boolean {
  return buildOpenCodePermissionRules(runtimeMode).some(
    (rule) =>
      rule.action === "allow" &&
      (rule.permission === "*" || rule.permission === permission),
  );
}

export function respondOpenCodeApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.approvals.get(requestId);
  if (!pending) return;
  pending.resolve(decision);
}

export function respondOpenCodeQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.questions.get(requestId);
  if (!pending) return;
  pending.resolve(reply);
}

export async function cancelOpenCodeTurn(sessionId: string): Promise<void> {
  startingByThread.get(sessionId)?.controller.abort();
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelVersion += 1;
  live.cancelled = true;
  live.muteUpdates = true;
  for (const [, pending] of live.approvals) pending.resolve("deny");
  live.approvals.clear();
  for (const [, pending] of live.questions)
    pending.resolve({ kind: "skipped" });
  live.questions.clear();
  // The visible turn settles at Stop press — the abort below only tells the
  // server and must not hold the turn open for the wire round-trip.
  finishActiveTurn(live, [
    { type: "message.completed" },
    { type: "reasoning.completed" },
  ]);
  try {
    await live.client.abortSession(live.openCodeSessionId);
  } catch (error) {
    if (liveByThread.get(sessionId) === live) {
      live.onEvent({ type: "session.error", message: `Could not confirm OpenCode stopped: ${error instanceof Error ? error.message : String(error)}` });
      await disposeOpenCodeSession(sessionId);
    }
  }
}

export async function stopOpenCodeSession(sessionId: string): Promise<void> {
  const starting = startingByThread.get(sessionId);
  starting?.controller.abort();
  const live = liveByThread.get(sessionId);
  if (live) live.cancelVersion += 1;
  await disposeOpenCodeSession(sessionId);
  await starting?.promise.catch(() => undefined);
}

async function disposeOpenCodeSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.muteUpdates = true;
    live.cancelled = true;
    for (const [, pending] of live.approvals) pending.resolve("deny");
    live.approvals.clear();
    for (const [, pending] of live.questions)
      pending.resolve({ kind: "skipped" });
    live.questions.clear();
    live.activeTurn = false;
    live.turnDone?.();
    live.turnDone = null;
    live.turnFailed = null;
    // Retire both native resources before yielding: a delayed HTTP abort must
    // not let a replacement start before this host's eventual kill.
    const closing = live.client.closeEvents(sessionId);
    unwatchChild(sessionId);
    await Promise.all([closing, killChild(sessionId).catch(() => undefined)]);
  }
}

export async function forgetOpenCodeSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopOpenCodeSession(sessionId);
}

export function bindOpenCodeSession(
  threadId: string,
  providerSessionId: string,
  cwd: string,
): void {
  const sessionId = providerSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { sessionId, cwd });
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const pending = startingByThread.get(input.sessionId);
  if (pending) {
    const alreadyStopped = pending.controller.signal.aborted;
    try {
      await pending.promise;
    } catch (error) {
      if (!alreadyStopped) throw error;
    }
    return ensureLive(input);
  }
  const controller = new AbortController();
  const promise = prepareLive(input, controller.signal);
  startingByThread.set(input.sessionId, { controller, promise });
  try {
    return await promise;
  } finally {
    if (startingByThread.get(input.sessionId)?.promise === promise)
      startingByThread.delete(input.sessionId);
  }
}

async function prepareLive(
  input: HarnessSessionInput,
  signal: AbortSignal,
): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    existing.onEvent = input.onEvent;
    return existing;
  }
  if (existing) {
    resumeByThread.delete(input.sessionId);
    await disposeOpenCodeSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canResume = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  signal.throwIfAborted();
  const { path } = await resolveOpenCodeBinaryImpl(input.cwd);
  signal.throwIfAborted();
  await assertOpenCodeVersion(path, input.cwd);
  signal.throwIfAborted();

  const liveRef: { current: Live | null } = { current: null };
  let serverUrl = "";
  let serverExited: number | null | undefined;

  watchChild(
    input.sessionId,
    (line) => {
      const parsed = parseServerUrlFromOutput(line);
      if (parsed) serverUrl = parsed;
    },
    (code) => {
      serverExited = code;
      if (liveByThread.get(input.sessionId) === liveRef.current)
        liveByThread.delete(input.sessionId);
      const live = liveRef.current;
      if (!live?.muteUpdates) {
        (live?.onEvent ?? input.onEvent)({ type: "session.ended", code });
      }
      if (live) {
        live.muteUpdates = true;
        live.serverDead = true;
        // Parked asks and questions must settle — their awaiters otherwise
        // hang on a dead server and the UI cards never close.
        for (const pending of live.approvals.values()) pending.resolve("deny");
        live.approvals.clear();
        for (const pending of live.questions.values())
          pending.resolve({ kind: "skipped" });
        live.questions.clear();
      }
      live?.turnFailed?.(new Error("OpenCode server exited"));
      if (live) {
        live.turnDone = null;
        live.turnFailed = null;
      }
    },
    (line) => {
      const parsed = parseServerUrlFromOutput(line);
      if (parsed) serverUrl = parsed;
    },
  );

  try {
    const port = await freeHarnessPort();
    signal.throwIfAborted();
    await spawnChild(
      input.sessionId,
      path,
      ["serve", `--hostname=127.0.0.1`, `--port=${port}`],
      input.cwd,
    );
    signal.throwIfAborted();
    const url = await waitForServerUrl(
      () => serverUrl,
      () => serverExited,
      SERVER_TIMEOUT_MS,
    );
    signal.throwIfAborted();
    const client = new OpenCodeClient(url, input.cwd);
    const planning = input.intent === "plan";
    const resolved = await resolveSession(client, {
      resume: canResume ? resume : undefined,
      runtimeMode: input.runtimeMode,
      planning,
      cwd: input.cwd,
    });
    signal.throwIfAborted();

    const live: Live = {
      client,
      openCodeSessionId: resolved.session.id,
      cwd: input.cwd,
      runtimeMode: input.runtimeMode,
      planning,
      appliedRuntimeMode: resolved.appliedMode,
      modeUpdates: Promise.resolve(),
      onEvent: input.onEvent,
      approvals: new Map(),
      questions: new Map(),
      visibleQuestionId: null,
      nextApprovalUiId: 1,
      sessionParentById: new Map(),
      subagentSessions: new Map(),
      subagentModels: new Map(),
      pendingSubagent: new Map(),
      partById: new Map(),
      partOwnerById: new Map(),
      partsByMessage: new Map(),
      completedParts: new Map(),
      completedPartBytes: 0,
      retiredPartIds: new Set(),
      completedSubagents: new Set(),
      emittedTextByPartId: new Map(),
      messageRoleById: new Map(),
      cancelled: false,
      cancelVersion: 0,
      muteUpdates: false,
      serverDead: false,
      turns: Promise.resolve(),
      turnDone: null,
      turnFailed: null,
      turnEndPending: false,
      activeTurn: false,
    };
    liveRef.current = live;
    liveByThread.set(input.sessionId, live);
    resumeByThread.set(input.sessionId, {
      sessionId: resolved.session.id,
      cwd: input.cwd,
    });

    await client.subscribeEvents(
      input.sessionId,
      (event) => {
        if (live.muteUpdates) {
          // A late ask arriving between cancel and abort still holds a
          // server request open — decline it before dropping the event.
          declineLateAsk(live, event);
          return;
        }
        const turn = live.turnDone;
        void handleEvent(live, event).catch((error: unknown) => {
          if (live.muteUpdates || live.turnDone !== turn) return;
          // Failed ancestry lookups or replies must end the turn visibly;
          // otherwise a child can remain blocked on an unanswered request.
          live.onEvent({
            type: "session.error",
            message: `Could not route OpenCode event: ${error instanceof Error ? error.message : String(error)}`,
          });
          finishActiveTurn(live);
        });
      },
      (error) => {
        if (live.muteUpdates || live.cancelled) return;
        const message =
          error?.trim() || "OpenCode event stream ended unexpectedly.";
        // prompt_async has no response body to await; the SSE stream is its
        // only completion channel. Reusing a Live after this point accepts the
        // next prompt but can never observe it, which looks like a dead thread.
        liveByThread.delete(input.sessionId);
        const failed = live.turnFailed;
        live.turnDone = null;
        live.turnFailed = null;
        live.muteUpdates = true;
        for (const pending of live.approvals.values()) pending.resolve("deny");
        live.approvals.clear();
        for (const pending of live.questions.values())
          pending.resolve({ kind: "skipped" });
        live.questions.clear();
        unwatchChild(input.sessionId);
        void killChild(input.sessionId)
          .catch(() => undefined)
          .then(() => {
            if (failed) {
              failed(new Error(message));
            } else {
              live.onEvent({ type: "session.error", message });
            }
          });
      },
    );

    signal.throwIfAborted();
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: resolved.session.id,
    });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    const live = liveRef.current;
    if (live) {
      live.muteUpdates = true;
      await live.client.closeEvents(input.sessionId);
    }
    if (liveByThread.get(input.sessionId) === live)
      liveByThread.delete(input.sessionId);
    unwatchChild(input.sessionId);
    await killChild(input.sessionId).catch(() => undefined);
    throw error;
  }
}

async function resolveSession(
  client: OpenCodeClient,
  input: {
    resume?: Resume;
    runtimeMode: RuntimeMode;
    planning: boolean;
    cwd: string;
  },
): Promise<{ session: OpenCodeSession; appliedMode?: RuntimeMode }> {
  const applied = input.planning ? "supervised" : input.runtimeMode;
  const permission = buildOpenCodePermissionRules(applied);
  if (input.resume) {
    try {
      const adopted = await client.getSession(input.resume.sessionId);
      if (!adopted.directory || sameDirectory(adopted.directory, input.cwd)) {
        await client.updateSession(adopted.id, { permission });
        return { session: adopted, appliedMode: applied };
      }
      const forked = await client.forkSession(adopted.id, input.cwd);
      await client.updateSession(forked.id, { permission });
      return { session: forked, appliedMode: applied };
    } catch (error) {
      if (!isOpenCodeNotFound(error) && !isHttpNotFound(error)) throw error;
    }
  }
  return {
    session: await client.createSession({ permission }),
    appliedMode: applied,
  };
}

async function runTurn(live: Live, input: SendTurnInput): Promise<void> {
  const parsed = parseOpenCodeModelSlug(nativeModelId(input.model, input.cwd));
  if (!parsed) {
    throw new Error(
      "OpenCode models use provider/model ids. Wait for the catalog to load, then pick a model.",
    );
  }
  const parts = [
    ...(input.text.trim()
      ? [{ type: "text" as const, text: input.text.trim() }]
      : []),
    ...toOpenCodeFileParts(input.attachments),
  ];
  if (parts.length === 0) return;

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  live.activeTurn = true;
  settlePendingTurn(live);

  try {
    await live.client.promptAsync({
      sessionID: live.openCodeSessionId,
      model: parsed,
      agent: openCodeAgentForTurn(input),
      variant: input.modelSettings?.variant,
      parts,
    });
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
    live.activeTurn = false;
    live.turnDone = null;
    live.turnFailed = null;
  }
}

async function runCompaction(
  live: Live,
  model: { providerID: string; modelID: string },
): Promise<void> {
  // Unlike prompt_async, summarize responds only after the compaction pass.
  // Keep this outside the normal turn latch: its eventual session.status=idle
  // must not become a pending completion for the next user turn.
  await live.client.summarizeSession(live.openCodeSessionId, model);
}

/** Best-effort rejection for asks that arrive after the live is muted. */
function declineLateAsk(live: Live, event: Record<string, unknown>): void {
  if (live.serverDead) return;
  const properties = asRecord(event.properties);
  const id =
    stringField(properties, "id") ?? stringField(properties, "requestID");
  if (!id) return;
  if (event.type === "permission.asked") {
    void live.client.replyPermission(id, "reject").catch(() => undefined);
  } else if (event.type === "question.asked") {
    void live.client.rejectQuestion(id).catch(() => undefined);
  }
}

async function handleEvent(
  live: Live,
  event: Record<string, unknown>,
): Promise<void> {
  const type = typeof event.type === "string" ? event.type : "";
  const properties = asRecord(event.properties) ?? {};
  // Session lifecycle events establish ancestry, including nested subagents.
  // Record them before applying the parent transcript's session filter.
  if (type === "session.created" || type === "session.updated") {
    const info = asRecord(properties.info);
    const id = stringField(info, "id");
    if (id) {
      const parentId = stringField(info, "parentID");
      live.sessionParentById.set(id, parentId);
      trimMetadata(live);
    }
    return;
  }

  const payloadSessionId = eventSessionId(event);
  if (payloadSessionId && payloadSessionId !== live.openCodeSessionId) {
    if (
      type === "message.updated" ||
      type === "message.part.updated" ||
      type === "message.part.delta"
    ) {
      handleSubagentEvent(live, payloadSessionId, type, properties);
      trimPartCache(live);
      return;
    }
    if (type === "session.status" && asRecord(properties.status)?.type === "idle") {
      completeSessionParts(live, payloadSessionId);
    }
    // Only blocking interactions are forwarded otherwise. In particular, a
    // child's idle/error event must never finish the parent's active turn.
    if (type !== "permission.asked" && type !== "question.asked") return;
    const turn = live.turnDone;
    if (!(await isDescendantSession(live, payloadSessionId))) return;
    if (live.muteUpdates || live.turnDone !== turn) return;
  }

  switch (type) {
    case "message.updated": {
      const info = asRecord(properties.info);
      const id = stringField(info, "id");
      const role = stringField(info, "role");
      const agent = stringField(info, "agent");
      const hidden = agent != null && KNOWN_HIDDEN_AGENTS.has(agent);
      if (id && (role === "user" || role === "assistant")) {
        live.messageRoleById.set(id, hidden ? "hidden" : role);
        for (const partId of live.partsByMessage.get(id) ?? []) {
          const part = live.partById.get(partId);
          if (part) {
            if (role === "assistant" && !hidden) emitAssistantText(live, part);
            retainPart(live, live.openCodeSessionId, part);
          }
        }
        trimMetadata(live);
      }
      // A compaction assistant's usage describes the summarization call, not
      // the rebuilt context. Keep the previous meter value until a real turn
      // reports the post-compaction window level.
      if (role === "assistant" && !hidden) emitContext(live, info);
      break;
    }
    case "message.removed": {
      const messageID = stringField(properties, "messageID");
      if (messageID) {
        for (const partId of [...(live.partsByMessage.get(messageID) ?? [])]) removePart(live, partId);
        live.messageRoleById.delete(messageID);
      }
      break;
    }
    case "message.part.removed": {
      const partID = stringField(properties, "partID");
      if (partID) removePart(live, partID);
      break;
    }
    case "message.part.delta": {
      const partID = stringField(properties, "partID");
      const delta = streamTextDelta(properties.delta);
      if (!partID || !delta || live.retiredPartIds.has(partID)) break;
      const existing = live.partById.get(partID);
      if (!existing || roleForPart(live, existing) !== "assistant") break;
      const previous =
        live.emittedTextByPartId.get(partID) ?? existing.text ?? "";
      const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(
        previous,
        delta,
      );
      live.emittedTextByPartId.set(partID, nextText);
      if (existing.type === "text" || existing.type === "reasoning") {
        retainPart(live, live.openCodeSessionId, { ...existing, text: nextText });
      }
      const mapped = textDeltaEvent(existing, deltaToEmit);
      if (mapped) live.onEvent(mapped);
      break;
    }
    case "message.part.updated": {
      const part = parsePart(properties.part);
      if (!part || live.retiredPartIds.has(part.id)) break;
      retainPart(live, live.openCodeSessionId, part);
      if (roleForPart(live, part) === "assistant") {
        emitAssistantText(live, part);
      }
      if (part.type === "tool") emitTool(live, part);
      break;
    }
    case "permission.asked": {
      const id =
        stringField(properties, "id") ?? stringField(properties, "requestID");
      if (!id) break;
      if ([...live.approvals.values()].some((pending) => pending.id === id)) break;
      const permission = stringField(properties, "permission") ?? "tool";
      const patterns = Array.isArray(properties.patterns)
        ? properties.patterns.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      const metadata = asRecord(properties.metadata) ?? {};
      const callId =
        stringField(asRecord(properties.tool), "callID") ??
        stringField(properties, "callID") ??
        stringField(properties, "toolCallId") ??
        stringField(metadata, "callID") ??
        stringField(metadata, "toolCallId");
      const uiId = live.nextApprovalUiId++;
      const kind = toolKindFromName(permission);
      const preview =
        previewFromToolPart({
          id,
          type: "tool",
          tool: permission,
          state: {
            ...metadata,
            input:
              metadata.input ??
              (patterns[0] ? { path: patterns[0] } : undefined),
          },
        }) ??
        (patterns[0]
          ? previewFromToolPart({
              id,
              type: "tool",
              tool: permission,
              state: { input: { path: patterns[0], pattern: patterns[0] } },
            })
          : undefined);
      const title =
        composeToolTitle({
          kind,
          title: permissionTitle(permission, patterns),
          command:
            extractShellCommand(metadata.input) ??
            (permission === "bash" ? patterns[0] : undefined),
          skill: extractSkillName(metadata.input),
          path: preview?.path,
          query: preview?.query,
          previewKind: preview?.kind,
        }) || permissionTitle(permission, patterns);
      if (live.planning) {
        const decision =
          kind === "read" || kind === "search" ? "allow" : "deny";
        await live.client.replyPermission(
          id,
          toOpenCodePermissionReply(decision),
        );
        break;
      }
      const pending = waitApproval(live, uiId, id, permission);
      if (callId) {
        live.onEvent({
          type: "tool.updated",
          callId,
          title,
          kind,
          preview,
        });
      }
      live.onEvent({
        type: "approval.requested",
        requestId: uiId,
        title,
        kind,
        callId,
        preview,
      });
      await pending;
      break;
    }
    case "question.asked": {
      const id =
        stringField(properties, "id") ?? stringField(properties, "requestID");
      if (!id) break;
      if ([...live.questions.values()].some((pending) => pending.id === id)) break;
      const questions = questionsFromUnknown(properties);
      const uiId = live.nextApprovalUiId++;
      const pending = waitQuestion(live, uiId, id, questions);
      showNextQuestion(live);
      await pending;
      break;
    }
    case "session.status": {
      const status = asRecord(properties.status);
      const statusType = stringField(status, "type");
      if (statusType === "retry") {
        const message = stringField(status, "message");
        if (message) live.onEvent({ type: "status", text: message });
        break;
      }
      if (statusType === "idle") completeSessionParts(live, live.openCodeSessionId);
      if (statusType === "idle" && live.activeTurn) {
        finishActiveTurn(live, [
          { type: "message.completed" },
          { type: "reasoning.completed" },
        ]);
      }
      break;
    }
    case "session.error": {
      const message = sessionErrorMessage(properties.error);
      live.onEvent({ type: "session.error", message });
      finishActiveTurn(live);
      break;
    }
    default:
      break;
  }
  trimPartCache(live);
}

async function isDescendantSession(
  live: Live,
  sessionId: string,
): Promise<boolean> {
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  while (current && !visited.has(current)) {
    if (current === live.openCodeSessionId) return true;
    visited.add(current);
    if (!live.sessionParentById.has(current)) {
      // Resumed children may predate the SSE subscription. Resolve their
      // ancestry from the server instead of relying on session.created alone.
      const session = await live.client.getSession(current);
      live.sessionParentById.set(current, session.parentID);
      trimMetadata(live);
    }
    current = live.sessionParentById.get(current);
  }
  return false;
}

export function openCodeAgentForTurn(input: {
  intent?: SendTurnInput["intent"];
  modelSettings?: Record<string, string>;
}): string | undefined {
  if (input.intent === "plan") return "plan";
  if (input.intent === "build") return "build";
  const configured = input.modelSettings?.agent?.trim();
  return configured && configured !== "plan" ? configured : "build";
}

/**
 * OpenCode reports tokens per assistant message but not the window, so the
 * window comes from the catalog entry for the model that produced it.
 */
function emitContext(live: Live, info: Record<string, unknown> | null): void {
  const used = contextUsedFromMessageInfo(info);
  if (used === undefined) return;
  const providerID = stringField(info, "providerID");
  const modelID = stringField(info, "modelID");
  const window =
    providerID && modelID
      ? modelContextWindow(`opencode:${providerID}/${modelID}`, live.cwd)
      : undefined;
  live.onEvent({ type: "context", used, ...(window ? { window } : {}) });
}

function emitAssistantText(live: Live, part: OpenCodePart): void {
  const text = part.text;
  if (text === undefined) return;
  const previous = live.emittedTextByPartId.get(part.id);
  const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(
    previous,
    text,
  );
  live.emittedTextByPartId.set(part.id, latestText);
  const mapped = textDeltaEvent(part, deltaToEmit);
  if (mapped) live.onEvent(mapped);
}

function emitTool(live: Live, part: OpenCodePart): void {
  const callId = part.callID ?? part.id;
  const tool = part.tool ?? "tool";
  const state = part.state ?? {};
  const status = typeof state.status === "string" ? state.status : "pending";
  const kind = toolKindFromName(tool);
  const preview = previewFromToolPart(part);
  const title =
    composeToolTitle({
      kind,
      title: (typeof state.title === "string" && state.title) || tool,
      command: extractShellCommand(state.input),
      skill: extractSkillName(state.input),
      path: preview?.path,
      query: preview?.query,
      previewKind: preview?.kind,
    }) ||
    (typeof state.title === "string" && state.title) ||
    tool;
  const detail = detailFromToolPart(part);
  const tasks = taskListFromToolInput(tool, state.input);
  if (tasks) live.onEvent({ type: "tasks.updated", items: tasks });
  if (status === "pending") {
    live.onEvent({
      type: "tool.started",
      callId,
      title,
      kind,
      status: "pending",
      preview,
    });
    if (kind === "agent") trackSubagentRow(live, callId, part);
    return;
  }
  live.onEvent({
    type: status === "pending" ? "tool.started" : "tool.updated",
    callId,
    title,
    kind,
    status:
      status === "error"
        ? "failed"
        : status === "completed"
          ? "completed"
          : status,
    detail:
      detail ??
      (status === "error"
        ? kind === "agent"
          ? "Subagent failed."
          : "Tool failed."
        : undefined),
    preview,
  });
  // Bind after creating the parent block: replayed steps need an owner.
  if (kind === "agent") trackSubagentRow(live, callId, part);
}

/** How many parts an unidentified child may bank before its row is known. */
const MAX_PENDING_SUBAGENT = 64;

/**
 * Task metadata names the child session. Arrival order is not an identity:
 * concurrent tasks can create their sessions in any order.
 */
function trackSubagentRow(
  live: Live,
  callId: string,
  part: OpenCodePart,
): void {
  const named = openCodeChildSessionId(part);
  if (named && named !== live.openCodeSessionId) {
    bindSubagentSession(live, named, callId);
    if (part.state?.status === "completed" || part.state?.status === "error") {
      live.completedSubagents.add(named);
      completeSessionParts(live, named);
      while (live.completedSubagents.size > 64) {
        const oldest = live.completedSubagents.values().next().value!;
        live.completedSubagents.delete(oldest);
        live.subagentSessions.delete(oldest);
        live.subagentModels.delete(oldest);
        live.sessionParentById.delete(oldest);
        completeSessionParts(live, oldest);
      }
    }
  }
}

function bindSubagentSession(
  live: Live,
  sessionId: string,
  callId: string,
): void {
  if (live.subagentSessions.get(sessionId) === callId) return;
  live.subagentSessions.set(sessionId, callId);
  const model = live.subagentModels.get(sessionId);
  if (model) live.onEvent({ type: "tool.updated", callId, kind: "agent", agentModel: model });
  const backlog = live.pendingSubagent.get(sessionId);
  live.pendingSubagent.delete(sessionId);
  for (const part of backlog ?? []) emitSubagentStep(live, callId, sessionId, part);
}

function handleSubagentEvent(
  live: Live,
  sessionId: string,
  type: string,
  properties: Record<string, unknown>,
): void {
  // The server broadcasts other sessions too. Only retain known descendants.
  let ancestor: string | undefined = sessionId;
  const visited = new Set<string>();
  while (ancestor && !visited.has(ancestor)) {
    if (ancestor === live.openCodeSessionId || live.subagentSessions.has(ancestor)) break;
    visited.add(ancestor);
    ancestor = live.sessionParentById.get(ancestor);
  }
  if (!ancestor || visited.has(ancestor)) return;
  if (type === "message.updated") {
    const info = asRecord(properties.info);
    const id = stringField(info, "id");
    const role = stringField(info, "role");
    const agent = stringField(info, "agent");
    const model = stringField(info, "modelID");
    // Nested agents share the outer trail, but have their own model.
    if (role === "assistant" && model && !(agent && KNOWN_HIDDEN_AGENTS.has(agent)) &&
        live.sessionParentById.get(sessionId) === live.openCodeSessionId) {
      live.subagentModels.set(sessionId, model);
      const callId = live.subagentSessions.get(sessionId);
      if (callId) live.onEvent({ type: "tool.updated", callId, kind: "agent", agentModel: model });
    }
    if (id && (role === "user" || role === "assistant")) {
      live.messageRoleById.set(id, agent && KNOWN_HIDDEN_AGENTS.has(agent) ? "hidden" : role);
      // Message metadata may follow the first part on a resumed stream.
      for (const partId of live.partsByMessage.get(id) ?? []) {
        const part = live.partById.get(partId);
        if (part) {
          mirrorSubagentPart(live, sessionId, part);
          retainPart(live, sessionId, part);
        }
      }
      trimMetadata(live);
    }
    return;
  }
  let part = type === "message.part.updated" ? parsePart(properties.part) : null;
  if (type === "message.part.delta") {
    const id = stringField(properties, "partID");
    const existing = id ? live.partById.get(id) : undefined;
    const delta = streamTextDelta(properties.delta);
    if (existing && delta && (existing.type === "text" || existing.type === "reasoning")) {
      part = { ...existing, text: (existing.text ?? "") + delta };
    }
  }
  if (!part || live.retiredPartIds.has(part.id)) return;
  retainPart(live, sessionId, part);
  mirrorSubagentPart(live, sessionId, part);
}

/**
 * One thing a subagent did, mirrored onto its row. Until the child's session
 * is tied to a row the part is kept, because a task's opening moves arrive
 * before OpenCode reports the session it created for them.
 */
function mirrorSubagentPart(
  live: Live,
  sessionId: string,
  part: OpenCodePart,
): void {
  const callId = live.subagentSessions.get(sessionId);
  if (callId) {
    emitSubagentStep(live, callId, sessionId, part);
    return;
  }
  if (part.type !== "tool" && part.type !== "text" && part.type !== "reasoning") return;
  const backlog = live.pendingSubagent.get(sessionId) ?? [];
  const index = backlog.findIndex((entry) => entry.id === part.id);
  if (index >= 0) backlog[index] = part;
  else backlog.push(part);
  if (backlog.length > MAX_PENDING_SUBAGENT) backlog.shift();
  if (!live.pendingSubagent.has(sessionId) && live.pendingSubagent.size >= 32) {
    live.pendingSubagent.delete(live.pendingSubagent.keys().next().value!);
  }
  live.pendingSubagent.set(sessionId, backlog);
}

function emitSubagentStep(
  live: Live,
  callId: string,
  sessionId: string,
  part: OpenCodePart,
): void {
  if (part.messageID && !live.messageRoleById.has(part.messageID)) return;
  if (roleForPart(live, part) !== "assistant") return;
  if (part.type === "text" || part.type === "reasoning") {
    const text = part.text?.trim();
    if (!text) return;
    live.onEvent({
      type: "agent.step",
      callId,
      stepId: `${sessionId}:${part.id}`,
      kind: part.type === "reasoning" ? "reasoning" : "message",
      text,
    });
    return;
  }
  if (part.type !== "tool") return;
  const tool = part.tool ?? "tool";
  const state = part.state ?? {};
  const status = typeof state.status === "string" ? state.status : "pending";
  const kind = toolKindFromName(tool);
  const preview = previewFromToolPart(part);
  const title =
    composeToolTitle({
      kind,
      title: (typeof state.title === "string" && state.title) || tool,
      command: extractShellCommand(state.input),
      skill: extractSkillName(state.input),
      path: preview?.path,
      query: preview?.query,
      previewKind: preview?.kind,
    }) ||
    (typeof state.title === "string" && state.title) ||
    tool;
  live.onEvent({
    type: "agent.step",
    callId,
    stepId: `${sessionId}:${part.callID ?? part.id}`,
    kind: "tool",
    text: title,
    toolKind: kind,
    status:
      status === "error"
        ? "failed"
        : status === "completed"
          ? "completed"
          : "in_progress",
    ...(preview ? { preview } : {}),
  });
  if (kind === "agent") trackSubagentRow(live, callId, part);
}

async function waitApproval(
  live: Live,
  uiId: number,
  id: string,
  permission: string,
): Promise<void> {
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    live.approvals.set(uiId, { id, permission, resolve });
  });
  live.approvals.delete(uiId);
  live.onEvent({ type: "approval.resolved", requestId: uiId, decision });
  // Cancel/stop still deliver the deny — the server is alive and holds the
  // permission request open. Exit settles after the server is gone.
  if (live.serverDead) return;
  await live.client.replyPermission(id, toOpenCodePermissionReply(decision));
}

async function waitQuestion(
  live: Live,
  uiId: number,
  id: string,
  questions: UserQuestion[],
): Promise<void> {
  const reply = await new Promise<UserQuestionReply>((resolve) => {
    live.questions.set(uiId, { id, questions, resolve });
  });
  live.questions.delete(uiId);
  live.onEvent({
    type: "question.resolved",
    requestId: uiId,
    decision: reply.kind,
  });
  if (live.serverDead) return;
  showNextQuestion(live);
  if (reply.kind !== "answered") {
    await live.client.rejectQuestion(id);
    return;
  }
  const answers = questions.map((question) =>
    selectedAnswerLabels(question, reply),
  );
  await live.client.replyQuestion(id, answers);
}

function showNextQuestion(live: Live): void {
  if (live.muteUpdates || live.cancelled) return;
  if (
    live.visibleQuestionId !== null &&
    live.questions.has(live.visibleQuestionId)
  )
    return;
  const next = live.questions.entries().next().value;
  live.visibleQuestionId = next?.[0] ?? null;
  if (!next) return;
  const [requestId, { questions }] = next;
  live.onEvent({
    type: "question.asked",
    requestId,
    title: questionPromptTitle(questions) || "OpenCode question",
    questions,
  });
}

function finishActiveTurn(live: Live, extraEvents: HarnessEvent[] = []): void {
  live.turnEndPending = false;
  live.activeTurn = false;
  for (const event of extraEvents) live.onEvent(event);
  const done = live.turnDone;
  const failed = live.turnFailed;
  live.turnDone = null;
  live.turnFailed = null;
  if (done) {
    done();
    return;
  }
  if (!failed) live.turnEndPending = true;
}

function settlePendingTurn(live: Live): void {
  if (!live.turnEndPending || !live.turnDone) return;
  finishActiveTurn(live);
}

// Keep active streams intact; finalized replay state has a fixed memory budget.
const MAX_COMPLETED_PARTS = 256;
const MAX_COMPLETED_PART_BYTES = 1_000_000;
const MAX_RETIRED_PART_IDS = 2_048;

function retainPart(live: Live, owner: string, part: OpenCodePart): void {
  live.partById.set(part.id, part);
  live.partOwnerById.set(part.id, owner);
  if (part.messageID) {
    let ids = live.partsByMessage.get(part.messageID);
    if (!ids) live.partsByMessage.set(part.messageID, (ids = new Set()));
    ids.add(part.id);
  }
  if ((!part.messageID || live.messageRoleById.has(part.messageID)) &&
      (part.time?.end != null || part.state?.status === "completed" || part.state?.status === "error" || live.completedParts.has(part.id) || live.completedSubagents.has(owner) || (owner === live.openCodeSessionId && !live.activeTurn))) {
    completePart(live, part);
  }
}

function completePart(live: Live, part: OpenCodePart): void {
  const bytes = (part.text?.length ?? 0) * 2 + (part.state ? JSON.stringify(part.state).length * 2 : 0);
  live.completedPartBytes += bytes - (live.completedParts.get(part.id) ?? 0);
  live.completedParts.set(part.id, bytes);
}

function completeSessionParts(live: Live, sessionId: string): void {
  for (const [id, owner] of live.partOwnerById) {
    if (owner === sessionId) completePart(live, live.partById.get(id)!);
  }
  trimPartCache(live);
}

function removePart(live: Live, id: string): void {
  const part = live.partById.get(id);
  live.partById.delete(id);
  live.partOwnerById.delete(id);
  live.emittedTextByPartId.delete(id);
  live.completedPartBytes -= live.completedParts.get(id) ?? 0;
  live.completedParts.delete(id);
  if (part?.messageID) {
    const ids = live.partsByMessage.get(part.messageID);
    ids?.delete(id);
    if (!ids?.size) {
      live.partsByMessage.delete(part.messageID);
    }
  }
  for (const [sessionId, parts] of live.pendingSubagent) {
    const remaining = parts.filter((entry) => entry.id !== id);
    if (remaining.length) live.pendingSubagent.set(sessionId, remaining);
    else live.pendingSubagent.delete(sessionId);
  }
  // ponytail: suppress 2048 recently retired part IDs; durable replay belongs in provider history.
  live.retiredPartIds.add(id);
  if (live.retiredPartIds.size > MAX_RETIRED_PART_IDS) live.retiredPartIds.delete(live.retiredPartIds.values().next().value!);
}

function trimPartCache(live: Live): void {
  while (live.completedParts.size > MAX_COMPLETED_PARTS || live.completedPartBytes > MAX_COMPLETED_PART_BYTES) {
    const id = live.completedParts.keys().next().value;
    if (id === undefined) break;
    removePart(live, id);
  }
}

function trimMetadata(live: Live): void {
  for (const id of live.messageRoleById.keys()) {
    if (live.messageRoleById.size <= 1_024) break;
    if (!live.partsByMessage.has(id)) live.messageRoleById.delete(id);
  }
  for (const id of live.subagentModels.keys()) {
    if (live.subagentModels.size <= 512) break;
    if (!live.subagentSessions.has(id)) live.subagentModels.delete(id);
  }
  for (const id of live.sessionParentById.keys()) {
    if (live.sessionParentById.size <= 512) break;
    if (id !== live.openCodeSessionId && !live.subagentSessions.has(id)) live.sessionParentById.delete(id);
  }
}

/** Test seam: expose retention counts, never transcript contents. */
export function __openCodeRetainedState(sessionId: string) {
  const live = liveByThread.get(sessionId);
  return live ? { parts: live.partById.size, completed: live.completedParts.size, bytes: live.completedPartBytes,
    emitted: live.emittedTextByPartId.size, messages: live.messageRoleById.size, retired: live.retiredPartIds.size } : undefined;
}

function parsePart(value: unknown): OpenCodePart | null {
  const rec = asRecord(value);
  const id = stringField(rec, "id");
  const type = stringField(rec, "type");
  if (!rec || !id || !type) return null;
  return {
    id,
    type,
    messageID: stringField(rec, "messageID"),
    callID: stringField(rec, "callID"),
    tool: stringField(rec, "tool"),
    text: typeof rec.text === "string" ? rec.text : undefined,
    time: asRecord(rec.time) as OpenCodePart["time"],
    state: asRecord(rec.state) ?? undefined,
  };
}

function roleForPart(
  live: Live,
  part: Pick<OpenCodePart, "messageID" | "type">,
): "assistant" | "user" | "hidden" | undefined {
  if (part.messageID) {
    const known = live.messageRoleById.get(part.messageID);
    return known;
  }
  return part.type === "tool" ||
    part.type === "text" ||
    part.type === "reasoning"
    ? "assistant"
    : undefined;
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\/+$/, "").replace(/\\/g, "/");
  return normalize(left) === normalize(right);
}

function isHttpNotFound(error: unknown): boolean {
  return error instanceof OpenCodeHttpError && error.status === 404;
}

const versionCheckedPaths = new Set<string>();

async function assertOpenCodeVersion(path: string, cwd: string): Promise<void> {
  if (versionCheckedPaths.has(path)) return;
  const output = await execChild(path, ["--version"], cwd).catch(() => "");
  const version = parseOpenCodeVersion(output);
  if (!version) {
    throw new Error(
      `Unable to determine OpenCode version. MonoCode requires v${MINIMUM_OPENCODE_VERSION} or newer.`,
    );
  }
  if (compareSemver(version, MINIMUM_OPENCODE_VERSION) < 0) {
    throw new Error(
      `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
    );
  }
  versionCheckedPaths.add(path);
}

function waitForServerUrl(
  read: () => string,
  exited: () => number | null | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const url = read();
      if (url) {
        resolve(url);
        return;
      }
      if (exited() !== undefined) {
        reject(
          new Error(
            `OpenCode server exited before startup completed (code: ${String(exited())}).`,
          ),
        );
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("Timed out waiting for OpenCode server"));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Exported for tests. */
export function __openCodeTestReset(): void {
  liveByThread.clear();
  startingByThread.clear();
  resumeByThread.clear();
  cancelledThreads.clear();
  versionCheckedPaths.clear();
}
