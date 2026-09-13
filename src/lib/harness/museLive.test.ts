import { describe, expect, it, vi, beforeEach } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code: number | null) => void) | undefined;
let onStderr: ((line: string) => void) | undefined;

vi.mock("./child", () => ({
  resolveMuseBinary: async () => ({ path: "/fake/muse" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    exit: (c: number | null) => void,
    stderr?: (l: string) => void,
  ) => {
    onLine = line;
    onExit = exit;
    onStderr = stderr;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const {
  sendMuseTurn,
  steerMuseTurn,
  cancelMuseTurn,
  compactMuseContext,
  respondMuseApproval,
  respondMuseQuestion,
  stopMuseSession,
  bindMuseSession,
  __museTestReset,
} = await import("./muse");
import type { HarnessEvent } from "./types";

const INIT_RESULT = {
  schema: { version: 1, fingerprint: "sha256:test" },
  serverInfo: { name: "muse", version: "1.1.1" },
};

const parse = () => sent.map((s) => JSON.parse(s));
const byMethod = (method: string) => parse().filter((m) => m.method === method);
const lastByMethod = (method: string) => byMethod(method).at(-1);
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for ${label}; sent=${JSON.stringify(
      parse().map((m) => m.method ?? `reply:${m.id}`),
    )}`,
  );
};

function reply(id: number | string, result: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
function fail(id: number | string, error: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, error }));
}
function notify(method: string, params: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", method, params }));
}
function serverRequest(id: number, method: string, params: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

const baseInput = (events: HarnessEvent[], text: string, id = "t1") => ({
  sessionId: id,
  cwd: "/repo",
  model: "muse:default",
  modelSettings: {},
  runtimeMode: "supervised" as const,
  text,
  attachments: [],
  onEvent: (e: HarnessEvent) => events.push(e),
});

const replied = new Set<number | string>();

/** Answer any pending session/set* control requests, then turn/start's ack. */
async function flushControls() {
  for (let i = 0; i < 200; i++) {
    const pending = parse().filter(
      (m) => m.method?.startsWith("session/set") && !replied.has(m.id),
    );
    for (const m of pending) {
      replied.add(m.id);
      reply(m.id, {});
    }
    if (byMethod("turn/start").length > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for turn/start");
}

/** Drive a session through initialize + session/start + turn/start ack. */
async function startTurn(events: HarnessEvent[], text: string, id: string) {
  const turn = sendMuseTurn(baseInput(events, text, id) as never);
  await waitFor(() => byMethod("initialize").length > 0, "initialize");
  expect(byMethod("initialize")[0].params.capabilities.userInputDialogs).toBe(
    true,
  );
  reply(byMethod("initialize")[0].id, INIT_RESULT);
  await waitFor(() => byMethod("session/start").length > 0, "session/start");
  const startMsg = lastByMethod("session/start")!;
  expect(startMsg.params.workspaceRoot).toBe("/repo");
  reply(startMsg.id, { session: { sessionId: "MS1" }, viewCursor: "c0" });
  await flushControls();
  const turnMsg = lastByMethod("turn/start")!;
  reply(turnMsg.id, {
    commandId: turnMsg.params.commandId,
    disposition: "started",
    startedNewTurn: true,
    status: "accepted",
    turnId: "T1",
  });
  return { turn, turnId: "T1" };
}

describe("muse live turn sequence", () => {
  beforeEach(() => {
    sent.length = 0;
    replied.clear();
    onStderr = undefined;
    __museTestReset();
  });

  it("starts a session, sets the approval mode, and streams a turn", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "t1");

    // supervised maps to promptUnmatched on session/start.
    expect(lastByMethod("session/start")!.params.approvalMode).toBe(
      "promptUnmatched",
    );
    // commandId must be a UUIDv7 the server accepts.
    expect(lastByMethod("turn/start")!.params.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "i1", kind: "agentMessage", status: "inProgress", text: "" },
    });
    notify("item/delta", {
      sessionId: "MS1",
      itemId: "i1",
      field: "text",
      delta: "hi there",
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: {
        itemId: "i1",
        kind: "agentMessage",
        status: "completed",
        text: "hi there",
      },
    });
    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;

    expect(events.some((e) => e.type === "session.started")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "session.providerBound" && e.providerSessionId === "MS1",
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "message.delta" && e.text === "hi there"),
    ).toBe(true);
    expect(events.some((e) => e.type === "message.completed")).toBe(true);
    await stopMuseSession("t1");
  });

  it("maps tool items and context usage to block events", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "list files", "t2");

    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/started", {
      sessionId: "MS1",
      item: {
        itemId: "i9",
        kind: "toolCall",
        status: "inProgress",
        tool: "bash",
        args: JSON.stringify({ command: "ls -la" }),
      },
    });
    notify("item/delta", {
      sessionId: "MS1",
      itemId: "i9",
      field: "output",
      delta: "total 12",
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: {
        itemId: "i9",
        kind: "toolCall",
        status: "completed",
        tool: "bash",
        visibleOutput: "total 12",
      },
    });
    notify("session/contextUsage", {
      sessionId: "MS1",
      usedTokens: 1200,
      windowTokens: 200000,
      pressure: "low",
    });
    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;

    const started = events.find((e) => e.type === "tool.started");
    expect(started).toMatchObject({ callId: "i9", kind: "execute" });
    const updated = events.find(
      (e) => e.type === "tool.updated" && e.detail?.includes("total 12"),
    );
    expect(updated).toBeDefined();
    expect(
      events.some(
        (e) => e.type === "context" && e.used === 1200 && e.window === 200000,
      ),
    ).toBe(true);
    await stopMuseSession("t2");
  });

  it("surfaces an approval request and answers it with approval/decide", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "run tests", "t3");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });

    serverRequest(77, "approval/request", {
      approvalId: "a1",
      sessionId: "MS1",
      turnId: "T1",
      itemId: "i2",
      toolCallId: "call_2",
      toolName: "bash",
      rawArgs: JSON.stringify({ command: "npm test" }),
      currentRequirementId: { approvalId: "a1", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "ch-allow", label: "Allow once", decision: "approved", scope: "once" },
        { choiceId: "ch-deny", label: "Deny", decision: "denied", scope: "once" },
      ],
      subject: { kind: "shell", command: "npm test" },
    });
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );
    // The server request itself gets an immediate {} acknowledgement.
    expect(parse().some((m) => m.id === 77 && "result" in m)).toBe(true);

    respondMuseApproval("t3", 1, "allow");
    await waitFor(
      () => byMethod("approval/decide").length > 0,
      "approval/decide",
    );
    const decide = lastByMethod("approval/decide")!;
    expect(decide.params).toMatchObject({
      approvalId: "a1",
      choiceId: "ch-allow",
      sessionId: "MS1",
      requirementId: { approvalId: "a1", sourceIndex: 0 },
    });
    reply(decide.id, {
      approvalId: "a1",
      commandId: decide.params.commandId,
      status: "accepted",
      terminal: true,
    });
    expect(
      events.some(
        (e) => e.type === "approval.resolved" && e.decision === "allow",
      ),
    ).toBe(true);

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("t3");
  });

  it("re-asks when Muse reports a stale approval requirement", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "run tests", "t7");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });

    serverRequest(81, "approval/request", {
      approvalId: "a2",
      sessionId: "MS1",
      turnId: "T1",
      itemId: "i4",
      toolCallId: "call_4",
      toolName: "bash",
      rawArgs: "{}",
      currentRequirementId: { approvalId: "a2", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "ch-allow", label: "Allow", decision: "approved", scope: "once" },
      ],
      subject: { kind: "shell", command: "npm test" },
    });
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "first approval.requested",
    );
    respondMuseApproval("t7", 1, "allow");
    await waitFor(
      () => byMethod("approval/decide").length > 0,
      "approval/decide",
    );
    fail(lastByMethod("approval/decide")!.id, {
      code: -32000,
      message: "requirement stale",
      data: { kind: "approvalRequirementStale" },
    });
    await waitFor(
      () =>
        events.filter((e) => e.type === "approval.requested").length === 2,
      "second approval.requested",
    );
    const second = events
      .filter((e) => e.type === "approval.requested")
      .at(-1)!;
    expect(second.requestId).not.toBe(1);

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("t7");
  });

  it("converts a userInput request into a question and answers it", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "pick one", "t4");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });

    serverRequest(88, "userInput/request", {
      userInputId: "u1",
      sessionId: "MS1",
      turnId: "T1",
      itemId: "i3",
      toolCallId: "call_3",
      toolName: "request_user_input",
      questions: [
        {
          id: "q1",
          header: "Pick",
          question: "Which option?",
          selection: { mode: "single", minSelections: 1, maxSelections: 1 },
          options: [{ label: "Alpha" }, { label: "Beta" }],
        },
      ],
    });
    await waitFor(
      () => events.some((e) => e.type === "question.asked"),
      "question.asked",
    );
    const asked = events.find((e) => e.type === "question.asked")!;
    expect(asked.questions[0].prompt).toBe("Which option?");
    expect(asked.questions[0].options.map((o) => o.label)).toEqual([
      "Alpha",
      "Beta",
    ]);

    respondMuseQuestion("t4", asked.requestId, {
      kind: "answered",
      answers: { q1: ["Alpha"] },
    });
    await waitFor(
      () => byMethod("userInput/answer").length > 0,
      "userInput/answer",
    );
    expect(lastByMethod("userInput/answer")!.params).toMatchObject({
      sessionId: "MS1",
      userInputId: "u1",
      answers: [{ questionId: "q1", selectedLabel: "Alpha" }],
    });
    expect(
      events.some(
        (e) => e.type === "question.resolved" && e.decision === "answered",
      ),
    ).toBe(true);

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("t4");
  });

  it("sends userInput/cancel when the question is skipped", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "pick one", "t8");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });

    serverRequest(89, "userInput/request", {
      userInputId: "u2",
      sessionId: "MS1",
      turnId: "T1",
      itemId: "i5",
      toolCallId: "call_5",
      toolName: "request_user_input",
      questions: [
        {
          id: "q1",
          question: "Continue?",
          selection: { mode: "single" },
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    });
    await waitFor(
      () => events.some((e) => e.type === "question.asked"),
      "question.asked",
    );
    respondMuseQuestion("t8", 1, { kind: "skipped" });
    await waitFor(
      () => byMethod("userInput/cancel").length > 0,
      "userInput/cancel",
    );
    expect(lastByMethod("userInput/cancel")!.params.userInputId).toBe("u2");

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("t8");
  });

  it("cancel interrupts the active turn and drops pending requests", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "run tests", "t6");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });

    serverRequest(91, "approval/request", {
      approvalId: "a3",
      sessionId: "MS1",
      turnId: "T1",
      itemId: "i6",
      toolCallId: "call_6",
      toolName: "bash",
      rawArgs: "{}",
      currentRequirementId: { approvalId: "a3", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "ch-allow", label: "Allow", decision: "approved", scope: "once" },
      ],
      subject: { kind: "shell", command: "rm -rf x" },
    });
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );

    await cancelMuseTurn("t6");
    await turn;
    await waitFor(
      () =>
        byMethod("turn/interrupt").some((m) => m.params.turnId === "T1"),
      "turn/interrupt",
    );
    // A late approval update must not re-prompt after cancellation.
    const before = events.filter((e) => e.type === "approval.requested").length;
    notify("approval/updated", {
      approvalId: "a3",
      sessionId: "MS1",
      currentRequirementId: { approvalId: "a3", sourceIndex: 1 },
      availableChoices: [],
    });
    serverRequest(92, "approval/request", {
      approvalId: "a4",
      sessionId: "MS1",
      turnId: "T1",
      itemId: "i7",
      toolCallId: "call_7",
      toolName: "bash",
      rawArgs: "{}",
      currentRequirementId: { approvalId: "a4", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "ch-allow", label: "Allow", decision: "approved", scope: "once" },
      ],
      subject: { kind: "shell", command: "rm -rf y" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(
      events.filter((e) => e.type === "approval.requested").length,
    ).toBe(before);
    await stopMuseSession("t6");
  });

  it("resumes a parked session with session/resume instead of session/start", async () => {
    const events: HarnessEvent[] = [];
    const first = await startTurn(events, "hey", "t5");
    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await first.turn;
    await stopMuseSession("t5");

    sent.length = 0;
    const turn2 = sendMuseTurn(baseInput(events, "back again", "t5") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize 2");
    reply(byMethod("initialize")[0].id, INIT_RESULT);
    await waitFor(
      () => byMethod("session/resume").length > 0,
      "session/resume",
    );
    const resumeMsg = lastByMethod("session/resume")!;
    expect(resumeMsg.params.sessionId).toBe("MS1");
    expect(byMethod("session/start")).toHaveLength(0);
    reply(resumeMsg.id, {
      session: { sessionId: "MS1" },
      history: {},
      pendingRequests: [],
      viewCursor: "c1",
    });
    await flushControls();
    const turnMsg = lastByMethod("turn/start")!;
    reply(turnMsg.id, {
      commandId: turnMsg.params.commandId,
      disposition: "started",
      startedNewTurn: true,
      status: "accepted",
      turnId: "T2",
    });
    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T2",
      terminal: "completed",
    });
    await turn2;
    await stopMuseSession("t5");
  });

  it("bindMuseSession seeds resume state for a restored thread", async () => {
    bindMuseSession("t9", "MS-RESTORED", "/repo");
    const events: HarnessEvent[] = [];
    const turn = sendMuseTurn(baseInput(events, "hello", "t9") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, INIT_RESULT);
    await waitFor(
      () => byMethod("session/resume").length > 0,
      "session/resume",
    );
    expect(lastByMethod("session/resume")!.params.sessionId).toBe(
      "MS-RESTORED",
    );
    reply(lastByMethod("session/resume")!.id, {
      session: { sessionId: "MS-RESTORED" },
      history: {},
      pendingRequests: [],
      viewCursor: "c1",
    });
    await flushControls();
    const turnMsg = lastByMethod("turn/start")!;
    reply(turnMsg.id, {
      commandId: turnMsg.params.commandId,
      disposition: "started",
      startedNewTurn: true,
      status: "accepted",
      turnId: "T9",
    });
    notify("turn/completed", {
      sessionId: "MS-RESTORED",
      turnId: "T9",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("t9");
  });

  it("falls back to session/start when resume reports the session missing", async () => {
    bindMuseSession("t10", "MS-GONE", "/repo");
    const events: HarnessEvent[] = [];
    const turn = sendMuseTurn(baseInput(events, "hello", "t10") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, INIT_RESULT);
    await waitFor(
      () => byMethod("session/resume").length > 0,
      "session/resume",
    );
    fail(lastByMethod("session/resume")!.id, {
      code: -32000,
      message: "session not found",
      data: { kind: "sessionNotFound" },
    });
    await waitFor(() => byMethod("session/start").length > 0, "session/start");
    reply(lastByMethod("session/start")!.id, {
      session: { sessionId: "MS-NEW" },
      viewCursor: "c0",
    });
    await waitFor(() => byMethod("turn/start").length > 0, "turn/start");
    const turnMsg = lastByMethod("turn/start")!;
    reply(turnMsg.id, {
      commandId: turnMsg.params.commandId,
      disposition: "started",
      startedNewTurn: true,
      status: "accepted",
      turnId: "T10",
    });
    notify("turn/completed", {
      sessionId: "MS-NEW",
      turnId: "T10",
      terminal: "completed",
    });
    await turn;
    expect(
      events.some(
        (e) =>
          e.type === "session.providerBound" &&
          e.providerSessionId === "MS-NEW",
      ),
    ).toBe(true);
    await stopMuseSession("t10");
  });

  it("routes a child exit to the running turn's listener", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "t4b");
    onExit!(1);
    await turn.catch(() => undefined);
    expect(events.some((e) => e.type === "session.ended")).toBe(true);
  });

  it("settles a compaction when the compaction item completes", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "tc");
    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;

    const compact = compactMuseContext(
      baseInput(events, "", "tc") as never,
    );
    await waitFor(() => byMethod("session/compact").length > 0, "compact");
    reply(lastByMethod("session/compact")!.id, {
      commandId: "x",
      status: "accepted",
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "c1", kind: "compaction", status: "completed" },
    });
    await compact;
    await stopMuseSession("tc");
  });

  it("surfaces a pending approval re-issued during session/resume", async () => {
    const events: HarnessEvent[] = [];
    const first = await startTurn(events, "hey", "tr");
    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await first.turn;
    await stopMuseSession("tr");

    sent.length = 0;
    const turn2 = sendMuseTurn(baseInput(events, "again", "tr") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, INIT_RESULT);
    await waitFor(
      () => byMethod("session/resume").length > 0,
      "session/resume",
    );
    // The host re-issues the pending request while resume is in flight.
    serverRequest(97, "approval/request", {
      approvalId: "a9",
      sessionId: "MS1",
      turnId: "T0",
      itemId: "iR",
      currentRequirementId: { approvalId: "a9", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "ch-allow", decision: "approved", scope: "once" },
        { choiceId: "ch-deny", decision: "denied", scope: "once" },
      ],
      subject: { kind: "shell", command: "deploy" },
    });
    reply(lastByMethod("session/resume")!.id, {
      session: { sessionId: "MS1" },
      history: {},
      pendingRequests: [{ kind: "approval", approvalId: "a9", viewCursor: "c1" }],
      viewCursor: "c1",
    });
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested after resume",
    );

    await flushControls();
    reply(lastByMethod("turn/start")!.id, {
      commandId: lastByMethod("turn/start")!.params.commandId,
      disposition: "started",
      status: "accepted",
      turnId: "T9",
    });
    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T9",
      terminal: "completed",
    });
    await turn2;
    await stopMuseSession("tr");
  });

  it("dedupes a re-issued approval/request for the same approvalId", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "run", "td");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });

    const params = {
      approvalId: "aD",
      sessionId: "MS1",
      turnId: "T1",
      itemId: "iD",
      currentRequirementId: { approvalId: "aD", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "ch-allow", decision: "approved", scope: "once" },
      ],
      subject: { kind: "shell", command: "make" },
    };
    serverRequest(98, "approval/request", params);
    serverRequest(99, "approval/request", {
      ...params,
      currentRequirementId: { approvalId: "aD", sourceIndex: 1 },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(
      events.filter((e) => e.type === "approval.requested").length,
    ).toBe(1);

    respondMuseApproval("td", 1, "allow");
    await waitFor(
      () => byMethod("approval/decide").length > 0,
      "approval/decide",
    );
    // The refreshed requirement token is what gets decided.
    expect(lastByMethod("approval/decide")!.params.requirementId).toEqual({
      approvalId: "aD",
      sourceIndex: 1,
    });

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("td");
  });

  it("auto-denies an approval during a plan turn", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendMuseTurn({
      ...baseInput(events, "plan it", "tp"),
      intent: "plan",
    } as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, INIT_RESULT);
    await waitFor(() => byMethod("session/start").length > 0, "session/start");
    const startMsg = lastByMethod("session/start")!;
    expect(startMsg.params.approvalMode).toBe("denyUnmatched");
    reply(startMsg.id, { session: { sessionId: "MSP" }, viewCursor: "c0" });
    await waitFor(() => byMethod("turn/start").length > 0, "turn/start");
    reply(lastByMethod("turn/start")!.id, {
      commandId: lastByMethod("turn/start")!.params.commandId,
      disposition: "started",
      status: "accepted",
      turnId: "TP",
    });
    notify("turn/started", { sessionId: "MSP", turnId: "TP" });

    serverRequest(96, "approval/request", {
      approvalId: "aP",
      sessionId: "MSP",
      turnId: "TP",
      itemId: "iP",
      currentRequirementId: { approvalId: "aP", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "ch-allow", decision: "approved", scope: "once" },
        { choiceId: "ch-deny", decision: "denied", scope: "once" },
      ],
      subject: { kind: "shell", command: "rm -rf build" },
    });
    await waitFor(
      () => byMethod("approval/decide").length > 0,
      "approval/decide",
    );
    expect(lastByMethod("approval/decide")!.params.choiceId).toBe("ch-deny");
    expect(events.some((e) => e.type === "approval.requested")).toBe(false);

    notify("turn/completed", {
      sessionId: "MSP",
      turnId: "TP",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("tp");
  });

  it("settles the turn wait when Muse retracts the submission", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "tx");
    notify("turn/retracted", { sessionId: "MS1", turnId: "T1" });
    await expect(turn).rejects.toThrow(/retracted/);
    await stopMuseSession("tx");
  });

  it("rejects an in-flight compaction when the turn is cancelled", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "tcc");
    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;

    const compact = compactMuseContext(baseInput(events, "", "tcc") as never);
    await waitFor(
      () => byMethod("session/compact").length > 0,
      "session/compact",
    );
    reply(lastByMethod("session/compact")!.id, { status: "accepted" });
    await cancelMuseTurn("tcc");
    await expect(compact).rejects.toThrow();
    await stopMuseSession("tcc");
  });

  it("seals the message when its item completes instead of waiting for the turn gate", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "t11");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/started", {
      sessionId: "MS1",
      item: {
        itemId: "i1",
        kind: "agentMessage",
        status: "inProgress",
        text: "",
      },
    });
    notify("item/delta", {
      sessionId: "MS1",
      itemId: "i1",
      field: "text",
      delta: "done early",
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: {
        itemId: "i1",
        kind: "agentMessage",
        status: "completed",
        text: "done early",
      },
    });
    // Muse holds turn/completed behind its end-of-turn gate (~60s while
    // reminder children drain). The finished message must not stay "typing"
    // for the whole gate.
    await waitFor(
      () => events.some((e) => e.type === "message.completed"),
      "message.completed",
    );

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("t11");
  });

  it("renders reminder children as a status line, never a tool row", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "tr1");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/started", {
      sessionId: "MS1",
      item: {
        itemId: "rc1",
        kind: "reminderChild",
        status: "inProgress",
        fallbackText: "Reminder child session",
      },
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "rc1", kind: "reminderChild", status: "completed" },
    });
    await waitFor(
      () => events.some((e) => e.type === "status"),
      "reminder status",
    );
    expect(
      events.some(
        (e) =>
          e.type === "status" && e.text === "Reminder child session",
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "tool.started")).toBe(false);
    expect(events.some((e) => e.type === "tool.updated")).toBe(false);

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("tr1");
  });

  it("settles the send when the end-of-turn drain begins", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "td1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "inProgress" },
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "completed" },
    });
    // The drain's reminder child opens after the answer: the send must
    // resolve without waiting out turn/completed.
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "rc1", kind: "reminderChild", status: "inProgress" },
    });
    await waitFor(() => settled, "drain settle");
    expect(
      events.some(
        (e) =>
          e.type === "status" &&
          e.text.includes("memory/reminder bookkeeping"),
      ),
    ).toBe(true);

    // The trailing turn/completed still lands; nothing double-settles.
    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("td1");
  });

  it("settles on single-shot reminder children observed during the drain", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "td2");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "inProgress" },
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "completed" },
    });
    // Echo-fast children arrive as item/completed only — the event itself
    // while no real item is open is drain evidence.
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "rc1", kind: "reminderChild", status: "completed" },
    });
    await waitFor(() => settled, "single-shot drain settle");
    await stopMuseSession("td2");
  });

  it("does not settle on turn-start recall before any real item", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "td3");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    // Memory recall runs before the model call: a reminder child while no
    // real item has completed must not free the turn.
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "rc0", kind: "reminderChild", status: "inProgress" },
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "rc0", kind: "reminderChild", status: "completed" },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "inProgress" },
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "completed" },
    });
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "rc1", kind: "reminderChild", status: "inProgress" },
    });
    await waitFor(() => settled, "drain settle after answer");
    await stopMuseSession("td3");
  });

  it("does not settle while a real item is still open", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "td4");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "inProgress" },
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "completed" },
    });
    // A mid-turn reminder child while a tool call runs is not the drain.
    notify("item/started", {
      sessionId: "MS1",
      item: {
        itemId: "c1",
        kind: "toolCall",
        status: "inProgress",
        tool: "bash",
      },
    });
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "rc1", kind: "reminderChild", status: "inProgress" },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    notify("item/completed", {
      sessionId: "MS1",
      item: {
        itemId: "c1",
        kind: "toolCall",
        status: "completed",
        tool: "bash",
      },
    });
    await waitFor(() => settled, "settle once real work closes");
    await stopMuseSession("td4");
  });

  it("holds drain settlement while a model retry is pending", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "td5");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "inProgress" },
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "completed" },
    });
    notify("turn/retryScheduled", {
      sessionId: "MS1",
      turnId: "T1",
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      retryDelayMs: 5000,
    });
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "rc1", kind: "reminderChild", status: "inProgress" },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    // The retry produces real work; once it closes with the reminder child
    // still open, the drain is real and the send settles.
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "m2", kind: "agentMessage", status: "inProgress" },
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "m2", kind: "agentMessage", status: "completed" },
    });
    await waitFor(() => settled, "settle after retried work closes");
    await stopMuseSession("td5");
  });

  it("still waits out a drain that emits no reminder items", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "td6");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "inProgress" },
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "completed" },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await waitFor(() => settled, "backstop settle");
    await stopMuseSession("td6");
  });

  it("keeps the drained turn as the steer/interrupt target", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "td7");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/completed", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "completed" },
    });
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "rc1", kind: "reminderChild", status: "inProgress" },
    });
    // The send resolves on the drain, but the turn still runs host-side:
    // steer/interrupt must keep addressing T1 until turn/completed lands.
    await turn;
    const steer = steerMuseTurn({
      sessionId: "td7",
      cwd: "/repo",
      model: "muse:default",
      text: "one more thing",
    });
    await waitFor(() => byMethod("turn/steer").length > 0, "turn/steer");
    const steerMsg = lastByMethod("turn/steer")!;
    expect(steerMsg.params.expectedTurnId).toBe("T1");
    reply(steerMsg.id, { commandId: steerMsg.params.commandId, disposition: "queued" });
    await steer;
    await stopMuseSession("td7");
  });

  it("ignores routine stderr lines that merely contain auth-like words", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "t12");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });

    onStderr!("INFO oauth token refresh scheduled");
    onStderr!("WARN authorized scopes: repo, workflow");
    onStderr!("DEBUG credential store locked");
    onStderr!("WARN sandbox denied read on /etc/shadow");
    await new Promise((r) => setTimeout(r, 10));
    expect(events.some((e) => e.type === "session.error")).toBe(false);

    onStderr!("error: not authenticated");
    await waitFor(
      () => events.some((e) => e.type === "session.error"),
      "session.error",
    );

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("t12");
  });

  it("stopping the session resolves an in-flight send without an error", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "t13");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    await stopMuseSession("t13");
    // The send resolves quietly instead of surfacing "Muse session stopped".
    await turn;
    expect(events.some((e) => e.type === "session.error")).toBe(false);
  });

  it("does not unqueue a turn that started before its wait registered", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendMuseTurn(baseInput(events, "hey", "t14") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, INIT_RESULT);
    await waitFor(() => byMethod("session/start").length > 0, "session/start");
    reply(lastByMethod("session/start")!.id, {
      session: { sessionId: "MS1" },
      viewCursor: "c0",
    });
    await flushControls();
    const turnMsg = lastByMethod("turn/start")!;
    // A queued ack followed by turn/started landing before waitTurn runs:
    // the turn is active, so cancelling must interrupt it — not unqueue it.
    reply(turnMsg.id, {
      commandId: turnMsg.params.commandId,
      disposition: "queued",
      turnId: "TQ",
    });
    notify("turn/started", { sessionId: "MS1", turnId: "TQ" });
    await new Promise((r) => setTimeout(r, 10));

    await cancelMuseTurn("t14");
    expect(
      byMethod("turn/interrupt").some((m) => m.params.turnId === "TQ"),
    ).toBe(true);
    expect(byMethod("turn/unqueue")).toHaveLength(0);
    await turn;
    await stopMuseSession("t14");
  });

  it("folds a subagent child session into agent steps on its row", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "explore auth", "ts1");
    const childPages = () =>
      byMethod("view/page").filter((m) => m.params.sessionId === "CHILD1");

    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/started", {
      sessionId: "MS1",
      item: {
        itemId: "sa1",
        kind: "subagent",
        childSessionId: "CHILD1",
        objective: "Map the auth flow",
        agentPath: "/agents/explorer.md",
        role: "research",
        status: "inProgress",
        revision: 1,
      },
    });

    // The child session is paged first, then tailed at the last seen cursor.
    await waitFor(() => childPages().length > 0, "child view/page");
    reply(childPages()[0].id, {
      events: [
        {
          method: "item/started",
          params: {
            sessionId: "CHILD1",
            viewCursor: "k1",
            item: {
              itemId: "cm1",
              kind: "agentMessage",
              status: "inProgress",
              revision: 1,
            },
          },
        },
        {
          method: "item/started",
          params: {
            sessionId: "CHILD1",
            viewCursor: "k2",
            item: {
              itemId: "ct1",
              kind: "toolCall",
              tool: "read",
              args: JSON.stringify({ path: "auth.ts" }),
              status: "inProgress",
              revision: 1,
            },
          },
        },
      ],
      nextCursor: "k2",
    });
    await waitFor(() => childPages().length > 1, "second child page");
    reply(childPages()[1].id, { events: [], nextCursor: null });
    await waitFor(
      () =>
        byMethod("view/subscribe").some(
          (m) => m.params.sessionId === "CHILD1",
        ),
      "child view/subscribe",
    );
    const sub = byMethod("view/subscribe").find(
      (m) => m.params.sessionId === "CHILD1",
    )!;
    expect(sub.params.after).toBe("k2");
    reply(sub.id, { viewCursor: "k3" });

    // Live child events land as steps on the sa1 row, not as transcript items.
    notify("item/delta", {
      sessionId: "CHILD1",
      viewCursor: "k4",
      itemId: "cm1",
      field: "text",
      delta: "Reading auth.ts",
    });
    notify("item/completed", {
      sessionId: "CHILD1",
      viewCursor: "k5",
      item: {
        itemId: "ct1",
        kind: "toolCall",
        tool: "read",
        args: JSON.stringify({ path: "auth.ts" }),
        status: "completed",
        revision: 2,
      },
    });

    // The parent's own message stream is untouched by child prose.
    notify("item/started", {
      sessionId: "MS1",
      item: { itemId: "m1", kind: "agentMessage", status: "inProgress" },
    });
    notify("item/delta", {
      sessionId: "MS1",
      itemId: "m1",
      field: "text",
      delta: "Parent answer",
    });
    notify("item/completed", {
      sessionId: "MS1",
      item: {
        itemId: "m1",
        kind: "agentMessage",
        status: "completed",
        text: "Parent answer",
      },
    });

    // The terminal revision drains the tail, then unsubscribes the child.
    notify("item/completed", {
      sessionId: "MS1",
      item: {
        itemId: "sa1",
        kind: "subagent",
        childSessionId: "CHILD1",
        status: "completed",
        result: {
          summary: "auth flow mapped",
          artifactRefs: [],
          evidenceRefs: [],
        },
        revision: 2,
      },
    });
    await waitFor(() => childPages().length > 2, "child drain page");
    reply(childPages()[2].id, { events: [], nextCursor: null });
    await waitFor(
      () =>
        byMethod("view/unsubscribe").some(
          (m) => m.params.sessionId === "CHILD1",
        ),
      "child view/unsubscribe",
    );

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;

    const steps = events.filter((e) => e.type === "agent.step");
    expect(steps.some((s) => s.callId === "sa1" && s.kind === "tool" &&
      s.status === "completed")).toBe(true);
    expect(
      steps.some(
        (s) =>
          s.callId === "sa1" &&
          s.kind === "message" &&
          s.text === "Reading auth.ts",
      ),
    ).toBe(true);
    expect(
      steps.every(
        (s) => s.agentName === "Explorer" && s.agentType === "research",
      ),
    ).toBe(true);
    // Child items never become top-level blocks; the parent row carries the
    // terminal summary and the assistant text stays the parent's own.
    expect(
      events.some((e) => e.type === "tool.started" && e.callId === "ct1"),
    ).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === "tool.updated" &&
          e.callId === "sa1" &&
          e.detail === "auth flow mapped",
      ),
    ).toBe(true);
    const deltas = events
      .filter((e) => e.type === "message.delta")
      .map((e) => (e as { text: string }).text);
    expect(deltas).toEqual(["Parent answer"]);
    await stopMuseSession("ts1");
  });
});
