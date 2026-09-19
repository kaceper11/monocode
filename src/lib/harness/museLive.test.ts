import { describe, expect, it, vi, beforeEach } from "vitest";

const sent: string[] = [];
const resolveMuseBinary = vi.fn(async () => ({ path: "/fake/muse" }));
const spawnChild = vi.fn(async () => undefined);
const killChild = vi.fn(async () => undefined);
let onLine: ((line: string) => void) | undefined;
let onExit: ((code: number | null) => void) | undefined;
let onStderr: ((line: string) => void) | undefined;

vi.mock("./child", () => ({
  resolveMuseBinary,
  spawnChild,
  killChild,
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
  setMuseRuntimeMode,
  stopMuseSession,
  bindMuseSession,
  __museTestReset,
} = await import("./muse");
import type { HarnessEvent } from "./types";
import { newSession } from "../session";
import { applyHarnessEvent } from "./apply";

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

/** Successful Stop waits for the provider's control acknowledgement. */
async function cancelAndAcknowledge(sessionId: string) {
  const count = byMethod("turn/interrupt").length;
  const cancel = cancelMuseTurn(sessionId);
  await waitFor(() => byMethod("turn/interrupt").length > count, "interrupt");
  reply(lastByMethod("turn/interrupt")!.id, {});
  await cancel;
}

/** Drive a session through initialize + session/start + turn/start ack. */
async function startTurn(events: HarnessEvent[], text: string, id: string, beforeAck?: () => Promise<void>, runtimeMode: "auto" | "supervised" = "supervised") {
  const turn = sendMuseTurn({ ...baseInput(events, text, id), runtimeMode });
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
  await beforeAck?.();
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
    resolveMuseBinary.mockReset().mockResolvedValue({ path: "/fake/muse" });
    spawnChild.mockClear();
    killChild.mockClear();
    replied.clear();
    onStderr = undefined;
    __museTestReset();
  });

  it("rejects a startup request flood without dispatching a turn", async () => {
    const turn = sendMuseTurn(baseInput([], "must not run", "startup-flood"));
    void turn.catch(() => undefined);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    for (let index = 0; index < 257; index++) {
      serverRequest(1000 + index, "approval/request", { approvalId: `a-${index}` });
    }
    reply(lastByMethod("initialize")!.id, INIT_RESULT);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(byMethod("session/start")).toHaveLength(0);
    await expect(turn).rejects.toThrow(/startup request limit/);
    expect(killChild).toHaveBeenCalled();
  });

  it.each([undefined, "unknown"])("rejects an unrecognized terminal state (%s)", async terminal => {
    const { turn } = await startTurn([], "first", "unknown-terminal");
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal });
    await expect(turn).rejects.toThrow(/unrecognized terminal state/);
    await stopMuseSession("unknown-terminal");
  });

  it("retains an early compaction failure until admission is acknowledged", async () => {
    const { turn } = await startTurn([], "first", "compact-early");
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await turn;
    const compact = compactMuseContext(baseInput([], "", "compact-early"));
    const rejected = expect(compact).rejects.toThrow("compaction failed");
    await waitFor(() => byMethod("session/compact").length > 0, "compact");
    notify("item/completed", { sessionId: "MS1", item: { itemId: "compact", kind: "compaction", status: "failed", failureReason: "compaction failed" } });
    await new Promise(resolve => setTimeout(resolve, 10));
    reply(lastByMethod("session/compact")!.id, { status: "accepted" });
    await rejected;
    await stopMuseSession("compact-early");
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
    await waitFor(() => events.some(e => e.type === "approval.resolved" && e.decision === "allow"), "approval accepted");

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("t3");
  });

  it("auto-decides a parked non-MCP approval on a mid-conversation change", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "run tests", "t3b");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });

    serverRequest(78, "approval/request", {
      approvalId: "a2",
      sessionId: "MS1",
      turnId: "T1",
      itemId: "i3",
      toolCallId: "call_3",
      toolName: "bash",
      rawArgs: JSON.stringify({ command: "npm test" }),
      currentRequirementId: { approvalId: "a2", sourceIndex: 0 },
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

    setMuseRuntimeMode("t3b", "full-access");
    // Full-access pushes allowAll to the provider and settles the parked ask.
    await waitFor(
      () => byMethod("session/setApprovalMode").length > 0,
      "setApprovalMode",
    );
    expect(lastByMethod("session/setApprovalMode")!.params.mode).toBe(
      "allowAll",
    );
    reply(lastByMethod("session/setApprovalMode")!.id, {});
    await waitFor(
      () => byMethod("approval/decide").length > 0,
      "approval/decide",
    );
    const decide = lastByMethod("approval/decide")!;
    expect(decide.params).toMatchObject({
      approvalId: "a2",
      choiceId: "ch-allow",
    });
    reply(decide.id, {
      approvalId: "a2",
      commandId: decide.params.commandId,
      status: "accepted",
      terminal: true,
    });
    await waitFor(() => events.some(e => e.type === "approval.resolved" && e.decision === "allow"), "approval accepted");

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("t3b");
  });

  it("auto-decides an MCP approval under full-access", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendMuseTurn({
      ...baseInput(events, "create a ticket", "t3m"),
      runtimeMode: "full-access",
    } as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, INIT_RESULT);
    await waitFor(() => byMethod("session/start").length > 0, "session/start");
    // Full access wires allowAll — MCP consent is admitted like the real CLIs.
    expect(lastByMethod("session/start")!.params.approvalMode).toBe("allowAll");
    reply(lastByMethod("session/start")!.id, {
      session: { sessionId: "MS1" },
      viewCursor: "c0",
    });
    await flushControls();
    reply(lastByMethod("turn/start")!.id, {
      commandId: lastByMethod("turn/start")!.params.commandId,
      disposition: "started",
      startedNewTurn: true,
      status: "accepted",
      turnId: "T1",
    });
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });

    serverRequest(78, "approval/request", {
      approvalId: "aMcp",
      sessionId: "MS1",
      turnId: "T1",
      itemId: "i9",
      toolCallId: "call_mcp",
      toolName: "mcp__jira__create_issue",
      rawArgs: "{}",
      currentRequirementId: { approvalId: "aMcp", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "ch-allow", label: "Allow", decision: "approved", scope: "once" },
        { choiceId: "ch-deny", label: "Deny", decision: "denied", scope: "once" },
      ],
      subject: { kind: "mcp" },
    });
    // A residual ask that still arrives gets auto-decided, never parked.
    await waitFor(
      () => byMethod("approval/decide").length > 0,
      "approval/decide",
    );
    expect(events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(lastByMethod("approval/decide")!.params).toMatchObject({
      approvalId: "aMcp",
      choiceId: "ch-allow",
    });

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("t3m");
  });

  it.each(["approval/updated", "approval/requested"])(
    "keeps a newer requirement pending after an old decision succeeds (%s)",
    async (method) => {
      const events: HarnessEvent[] = [];
      const { turn } = await startTurn(events, "run tests", "approval-revision");
      const approval = {
        approvalId: "revision", sessionId: "MS1", itemId: "tool",
        currentRequirementId: { approvalId: "revision", sourceIndex: 0 },
        availableChoices: [
          { choiceId: "allow", decision: "approved", scope: "once" },
          { choiceId: "deny", decision: "denied", scope: "once" },
        ],
        subject: { kind: "shell", command: "npm test" },
      };
      notify("approval/requested", approval);
      const first = events.filter((e) => e.type === "approval.requested").at(-1)!;
      respondMuseApproval("approval-revision", first.requestId, "allow");
      const oldDecision = lastByMethod("approval/decide")!;
      notify(method, {
        ...approval,
        currentRequirementId: { approvalId: "revision", sourceIndex: 1 },
      });
      const second = events.filter((e) => e.type === "approval.requested").at(-1)!;
      expect(second.requestId).not.toBe(first.requestId);
      reply(oldDecision.id, {});
      await Promise.resolve();
      await Promise.resolve();
      expect(events.some((e) => e.type === "approval.resolved" && e.requestId === second.requestId)).toBe(false);
      respondMuseApproval("approval-revision", first.requestId, "allow");
      expect(byMethod("approval/decide")).toHaveLength(1);
      respondMuseApproval("approval-revision", second.requestId, "deny");
      expect(lastByMethod("approval/decide")!.params).toMatchObject({
        requirementId: { approvalId: "revision", sourceIndex: 1 }, choiceId: "deny",
      });
      reply(lastByMethod("approval/decide")!.id, {});
      notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
      await turn;
      await stopMuseSession("approval-revision");
    },
  );

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
    expect(events.some(e => e.type === "question.resolved")).toBe(false);
    reply(lastByMethod("userInput/answer")!.id, {});
    await waitFor(() => events.some(e => e.type === "question.resolved" && e.decision === "answered"), "answer accepted");

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

    await cancelAndAcknowledge("t6");
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

  it("preserves a missing resume binding instead of starting an empty conversation", async () => {
    bindMuseSession("missing-resume", "MS-GONE", "/repo");
    const turn = sendMuseTurn(baseInput([], "hello", "missing-resume"));
    void turn.catch(() => undefined);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(lastByMethod("initialize")!.id, INIT_RESULT);
    await waitFor(() => byMethod("session/resume").length > 0, "resume");
    fail(lastByMethod("session/resume")!.id, { code: -32000, message: "session not found", data: { kind: "sessionNotFound" } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(byMethod("session/start")).toHaveLength(0);
    await expect(turn).rejects.toThrow(/binding was preserved/);
    expect(byMethod("turn/start")).toHaveLength(0);
    await stopMuseSession("missing-resume");
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

  it("dedupes a re-issued approval/request for the same requirement", async () => {
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
    serverRequest(99, "approval/request", params);
    await new Promise((r) => setTimeout(r, 10));
    expect(
      events.filter((e) => e.type === "approval.requested").length,
    ).toBe(1);

    respondMuseApproval("td", 1, "allow");
    await waitFor(
      () => byMethod("approval/decide").length > 0,
      "approval/decide",
    );
    expect(lastByMethod("approval/decide")!.params.requirementId).toEqual({
      approvalId: "aD",
      sourceIndex: 0,
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
    const rejected = expect(compact).rejects.toThrow();
    await cancelAndAcknowledge("tcc");
    await rejected;
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

  it("keeps turn-start reminder bookkeeping silent and out of transcript rows", async () => {
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
    expect(events.some((e) => e.type === "tool.started")).toBe(false);
    expect(events.some((e) => e.type === "tool.updated")).toBe(false);
    expect(events.some((e) => e.type === "status")).toBe(false);

    notify("turn/completed", {
      sessionId: "MS1",
      turnId: "T1",
      terminal: "completed",
    });
    await turn;
    await stopMuseSession("tr1");
  });

  it.each(["started", "completed"])("waits for the authoritative terminal event after reminder %s", async phase => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "hey", "bookkeeping");
    let settled = false;
    void turn.then(() => { settled = true; });
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/completed", { sessionId: "MS1", item: { itemId: "answer", kind: "agentMessage", status: "completed", text: "Done" } });
    notify(`item/${phase}`, { sessionId: "MS1", item: { itemId: "reminder", kind: "reminderChild", status: phase === "started" ? "inProgress" : "completed" } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(events.some(event => event.type === "message.completed")).toBe(true);
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await turn;
    await stopMuseSession("bookkeeping");
  });

  it("keeps a follow-up queued until the previous host turn really completes", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "first", "bookkeeping-queue");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("item/completed", { sessionId: "MS1", item: { itemId: "answer", kind: "agentMessage", status: "completed" } });
    notify("item/started", { sessionId: "MS1", item: { itemId: "reminder", kind: "reminderChild", status: "inProgress" } });
    const next = sendMuseTurn(baseInput(events, "follow up", "bookkeeping-queue"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(byMethod("turn/start")).toHaveLength(1);
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await turn;
    await waitFor(() => byMethod("turn/start").length === 2, "follow-up after terminal");
    const request = lastByMethod("turn/start")!;
    reply(request.id, { turnId: "T2", disposition: "started" });
    notify("turn/completed", { sessionId: "MS1", turnId: "T2", terminal: "completed" });
    await next;
    await stopMuseSession("bookkeeping-queue");
  });

  it("does not let a late completed turn seal the next response", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "first", "late");
    notify("turn/started", { sessionId: "MS1", turnId: "T1" });
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await turn;
    events.length = 0;
    const next = sendMuseTurn(baseInput(events, "second", "late"));
    await waitFor(() => byMethod("turn/start").length === 2, "second turn");
    const request = lastByMethod("turn/start")!;
    reply(request.id, { turnId: "T2", disposition: "started" });
    notify("turn/started", { sessionId: "MS1", turnId: "T2" });
    let settled = false;
    void next.then(() => { settled = true; });
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await new Promise(r => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(events.some(e => e.type === "message.completed")).toBe(false);
    notify("turn/completed", { sessionId: "MS1", turnId: "T2", terminal: "completed" });
    await next;
    await stopMuseSession("late");
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

    await cancelAndAcknowledge("t14");
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
  it.each(["cancel", "remove"])("fences %s before binary resolution without spawning", async action => {
    let resolve!: (result: { path: string }) => void;
    resolveMuseBinary.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const events: HarnessEvent[] = [];
    const turn = sendMuseTurn(baseInput(events, "never run", "startup"));
    await waitFor(() => !!resolve, "binary resolution");
    if (action === "cancel") await cancelMuseTurn("startup");
    else await stopMuseSession("startup");
    resolve({ path: "/fake/muse" });
    await turn;
    expect(spawnChild).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("recycles the owned host when Stop races the turn/start acknowledgement", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "never run", "admission", () => cancelMuseTurn("admission"));
    await turn;
    expect(killChild).toHaveBeenCalledOnce();
    await expect(steerMuseTurn({ sessionId: "admission", cwd: "/repo", model: "muse:default", text: "late" })).rejects.toThrow("No active Muse session");
    notify("item/started", { sessionId: "MS1", item: { itemId: "late", kind: "agentMessage", text: "hidden" } });
    expect(events.some(e => e.type === "message.delta")).toBe(false);
  });

  it.each([["model", -32602], ["mode", -32602], ["model", -32601], ["mode", -32601]] as const)("does not send when a required %s selection is rejected (%s)", async (setting, code) => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "first", "settings", undefined, setting === "mode" ? "auto" : "supervised");
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await turn;
    const input = { ...baseInput(events, "must not send", "settings"), model: setting === "model" ? "muse:unavailable" : "muse:default", runtimeMode: "supervised" as const };
    const next = sendMuseTurn(input);
    const rejected = expect(next).rejects.toThrow("selection rejected");
    const method = setting === "model" ? "session/setModel" : "session/setApprovalMode";
    await waitFor(() => byMethod(method).length > 0, method);
    fail(lastByMethod(method)!.id, { code, message: "selection rejected" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(byMethod("turn/start")).toHaveLength(1);
    await rejected;
    expect(byMethod("turn/start")).toHaveLength(1);
    await stopMuseSession("settings");
  });

  it("stops the host if a live access-mode change is rejected", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "first", "mode-error");
    setMuseRuntimeMode("mode-error", "auto");
    await waitFor(() => byMethod("session/setApprovalMode").length > 0, "mode request");
    fail(lastByMethod("session/setApprovalMode")!.id, { code: -32602, message: "mode rejected" });
    await turn;
    expect(killChild).toHaveBeenCalled();
    expect(events.some(e => e.type === "session.error" && e.message.includes("mode rejected"))).toBe(true);
  });

  it("keeps rejected approval decisions actionable until accepted", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "first", "decision-retry");
    notify("approval/requested", {
      approvalId: "retry-a", sessionId: "MS1", itemId: "cmd", toolName: "bash", title: "Run command",
      currentRequirementId: { approvalId: "retry-a", sourceIndex: 0 },
      availableChoices: [{ choiceId: "allow", decision: "approved", scope: "once" }, { choiceId: "deny", decision: "denied", scope: "once" }],
    });
    const asked = events.find(e => e.type === "approval.requested");
    expect(asked?.type).toBe("approval.requested");
    if (asked?.type !== "approval.requested") throw new Error("approval missing");
    respondMuseApproval("decision-retry", asked.requestId, "allow");
    await waitFor(() => byMethod("approval/decide").length === 1, "first decision");
    fail(lastByMethod("approval/decide")!.id, { code: -32602, message: "try another choice" });
    await waitFor(() => events.some(e => e.type === "status" && e.text.includes("try another choice")), "decision rejection");
    expect(events.some(e => e.type === "approval.resolved")).toBe(false);
    respondMuseApproval("decision-retry", asked.requestId, "deny");
    await waitFor(() => byMethod("approval/decide").length === 2, "retry decision");
    reply(lastByMethod("approval/decide")!.id, {});
    await waitFor(() => events.some(e => e.type === "approval.resolved" && e.decision === "deny"), "confirmed decision");
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await turn;
    await stopMuseSession("decision-retry");
  });

  it("keeps rejected question answers actionable until accepted", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "first", "answer-retry");
    notify("userInput/requested", { sessionId: "MS1", userInputId: "retry-q", questions: [{ id: "q", question: "Which?", options: [{ label: "One" }] }] });
    const asked = events.find(e => e.type === "question.asked");
    if (asked?.type !== "question.asked") throw new Error("question missing");
    const answer = { kind: "answered" as const, answers: { q: ["One"] } };
    respondMuseQuestion("answer-retry", asked.requestId, answer);
    await waitFor(() => byMethod("userInput/answer").length === 1, "first answer");
    fail(lastByMethod("userInput/answer")!.id, { code: -32602, message: "answer rejected" });
    await waitFor(() => events.some(e => e.type === "status" && e.text.includes("answer rejected")), "answer rejection");
    expect(events.some(e => e.type === "question.resolved")).toBe(false);
    respondMuseQuestion("answer-retry", asked.requestId, answer);
    await waitFor(() => byMethod("userInput/answer").length === 2, "retry answer");
    reply(lastByMethod("userInput/answer")!.id, {});
    await waitFor(() => events.some(e => e.type === "question.resolved"), "answer accepted");
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await turn;
    await stopMuseSession("answer-retry");
  });

  it("retains an approval if the selected decision has no offered choice", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "first", "missing-choice");
    notify("approval/requested", { approvalId: "no-allow", sessionId: "MS1", itemId: "cmd", toolName: "bash", currentRequirementId: { approvalId: "no-allow", sourceIndex: 0 }, availableChoices: [{ choiceId: "deny", decision: "denied", scope: "once" }] });
    const asked = events.find(e => e.type === "approval.requested");
    if (asked?.type !== "approval.requested") throw new Error("approval missing");
    respondMuseApproval("missing-choice", asked.requestId, "allow");
    expect(byMethod("approval/decide")).toHaveLength(0);
    expect(events.some(e => e.type === "approval.resolved")).toBe(false);
    respondMuseApproval("missing-choice", asked.requestId, "deny");
    await waitFor(() => byMethod("approval/decide").length === 1, "offered denial");
    reply(lastByMethod("approval/decide")!.id, {});
    await waitFor(() => events.some(e => e.type === "approval.resolved" && e.decision === "deny"), "accepted denial");
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await turn;
    await stopMuseSession("missing-choice");
  });

  it("releases nested subscriptions so later children remain visible", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "delegate", "nested");
    const answerPage = async (child: string, count: number) => {
      await waitFor(() => byMethod("view/page").filter(m => m.params.sessionId === child).length >= count, "child page");
      reply(byMethod("view/page").filter(m => m.params.sessionId === child)[count - 1].id, { events: [], nextCursor: null });
    };
    const subscribe = async (child: string) => {
      await answerPage(child, 1);
      await waitFor(() => byMethod("view/subscribe").some(m => m.params.sessionId === child), "child subscribe");
      reply(byMethod("view/subscribe").find(m => m.params.sessionId === child)!.id, {});
    };
    notify("item/started", { sessionId: "MS1", item: { itemId: "root", kind: "subagent", childSessionId: "ROOT", status: "inProgress" } });
    await subscribe("ROOT");
    for (let i = 0; i < 20; i++) {
      const child = `NESTED-${i}`;
      const item = { itemId: `nested-${i}`, kind: "subagent", childSessionId: child, status: "inProgress" };
      notify("item/started", { sessionId: "ROOT", item });
      await subscribe(child);
      notify("item/started", { sessionId: child, item: { itemId: "answer", kind: "agentMessage", text: `work-${i}`, status: "inProgress" } });
      notify("item/completed", { sessionId: "ROOT", item: { ...item, status: "completed" } });
      await answerPage(child, 2);
      await waitFor(() => byMethod("view/unsubscribe").some(m => m.params.sessionId === child), "nested unsubscribe");
      reply(byMethod("view/unsubscribe").find(m => m.params.sessionId === child)!.id, {});
    }
    expect(events.some(e => e.type === "agent.step" && e.callId === "root" && e.text === "work-19")).toBe(true);
    notify("item/completed", { sessionId: "MS1", item: { itemId: "root", kind: "subagent", childSessionId: "ROOT", status: "completed" } });
    await answerPage("ROOT", 2);
    await waitFor(() => byMethod("view/unsubscribe").some(m => m.params.sessionId === "ROOT"), "root unsubscribe");
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await turn;
    await stopMuseSession("nested");
  });

  it("does not dispatch an already queued send after cancellation", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "first", "cancel-queue");
    const queued = sendMuseTurn(baseInput(events, "queued", "cancel-queue"));
    await cancelMuseTurn("cancel-queue");
    await Promise.all([turn, queued]);
    expect(byMethod("turn/start")).toHaveLength(1);
    await stopMuseSession("cancel-queue");
  });

  it("still reports a real startup error after cleanup", async () => {
    const turn = sendMuseTurn(baseInput([], "test", "start-error"));
    const rejected = expect(turn).rejects.toThrow("initialize denied");
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    fail(lastByMethod("initialize")!.id, { code: -32602, message: "initialize denied" });
    await rejected;
    expect(killChild).toHaveBeenCalled();
    expect(byMethod("turn/start")).toHaveLength(0);
  });

  it("cannot bind a session after removal during the handshake", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendMuseTurn(baseInput(events, "never run", "removed"));
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(lastByMethod("initialize")!.id, INIT_RESULT);
    await waitFor(() => byMethod("session/start").length > 0, "session start");
    const start = lastByMethod("session/start")!;
    await stopMuseSession("removed");
    reply(start.id, { session: { sessionId: "REMOVED" } });
    await turn;
    expect(events.some(e => e.type === "session.providerBound")).toBe(false);
    expect(byMethod("turn/start")).toHaveLength(0);
  });

  it("stops instead of replaying an answer whose delivery timed out", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "first", "uncertain-answer");
    notify("userInput/requested", { sessionId: "MS1", userInputId: "uncertain", questions: [{ id: "q", question: "Which?", options: [{ label: "One" }] }] });
    const asked = events.find(e => e.type === "question.asked");
    if (asked?.type !== "question.asked") throw new Error("question missing");
    vi.useFakeTimers();
    try {
      respondMuseQuestion("uncertain-answer", asked.requestId, { kind: "answered", answers: { q: ["One"] } });
      await vi.advanceTimersByTimeAsync(60_000);
      await turn;
      expect(killChild).toHaveBeenCalled();
      expect(byMethod("userInput/answer")).toHaveLength(1);
      expect(events.some(e => e.type === "session.error" && e.message.includes("did not confirm"))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("allows a new send while a cancelled binary resolution is still pending", async () => {
    let resolve!: (result: { path: string }) => void;
    resolveMuseBinary.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const original = sendMuseTurn(baseInput([], "old", "new-after-stop"));
    await waitFor(() => !!resolve, "old resolution");
    await cancelMuseTurn("new-after-stop");
    const next = await startTurn([], "new", "new-after-stop");
    resolve({ path: "/fake/muse" });
    await original;
    expect(spawnChild).toHaveBeenCalledOnce();
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await next.turn;
    await stopMuseSession("new-after-stop");
  });


  it("reconciles a rapid Auto to Supervised change before applying another turn", async () => {
    const { turn } = await startTurn([], "hold", "race-mode");
    setMuseRuntimeMode("race-mode", "auto");
    await waitFor(() => byMethod("session/setApprovalMode").length === 1, "auto request");
    const auto = lastByMethod("session/setApprovalMode")!;
    setMuseRuntimeMode("race-mode", "supervised");
    expect(byMethod("session/setApprovalMode")).toHaveLength(1);
    reply(auto.id, { effectiveMode: { mode: "onRequest" } });
    await waitFor(() => byMethod("session/setApprovalMode").length === 2, "restore supervised");
    expect(lastByMethod("session/setApprovalMode")!.params.mode).toBe("promptUnmatched");
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "completed" });
    await turn;
    const next = sendMuseTurn(baseInput([], "next", "race-mode"));
    await new Promise(r => setTimeout(r, 10));
    expect(byMethod("turn/start")).toHaveLength(1);
    reply(lastByMethod("session/setApprovalMode")!.id, { effectiveMode: { mode: "promptUnmatched" } });
    await waitFor(() => byMethod("turn/start").length === 2, "next turn");
    reply(lastByMethod("turn/start")!.id, { disposition: "started", turnId: "T2" });
    notify("turn/completed", { sessionId: "MS1", turnId: "T2", terminal: "completed" });
    await next;
    await stopMuseSession("race-mode");
  });

  it("retains the original resume identity after a transient failure", async () => {
    bindMuseSession("resume-fail", "MS-original", "/repo");
    const first = sendMuseTurn(baseInput([], "retry", "resume-fail"));
    const rejected = expect(first).rejects.toThrow("temporarily unavailable");
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(lastByMethod("initialize")!.id, INIT_RESULT);
    await waitFor(() => byMethod("session/resume").length > 0, "resume");
    fail(lastByMethod("session/resume")!.id, { code: -32603, message: "temporarily unavailable" });
    await rejected;
    sent.length = 0;
    const retry = sendMuseTurn(baseInput([], "retry", "resume-fail"));
    await waitFor(() => byMethod("initialize").length > 0, "retry initialize");
    reply(lastByMethod("initialize")!.id, INIT_RESULT);
    await waitFor(() => byMethod("session/resume").length > 0, "retry resume");
    expect(lastByMethod("session/resume")!.params.sessionId).toBe("MS-original");
    expect(byMethod("session/start")).toHaveLength(0);
    reply(lastByMethod("session/resume")!.id, { session: { sessionId: "MS-original" } });
    await flushControls();
    reply(lastByMethod("turn/start")!.id, { disposition: "started", turnId: "T-retry" });
    notify("turn/completed", { sessionId: "MS-original", turnId: "T-retry", terminal: "completed" });
    await retry;
    await stopMuseSession("resume-fail");
  });

  it.each(["rejected", "unanswered"])("retires the host for an %s interruption and preserves resume", async outcome => {
    const { turn } = await startTurn([], "hold", "stop-failure");
    await new Promise(r => setTimeout(r, 0));
    vi.useFakeTimers();
    try {
      const cancel = cancelMuseTurn("stop-failure");
      if (outcome === "rejected") {
        fail(lastByMethod("turn/interrupt")!.id, { code: -32603, message: "interrupt failed" });
      } else {
        await vi.advanceTimersByTimeAsync(15_001);
      }
      await cancel;
      await turn;
      expect(killChild).toHaveBeenCalledOnce();
      await expect(steerMuseTurn({ sessionId: "stop-failure", cwd: "/repo", model: "muse:default", text: "late" })).rejects.toThrow("No active Muse session");
    } finally { vi.useRealTimers(); }
    sent.length = 0;
    const retry = sendMuseTurn(baseInput([], "retry", "stop-failure"));
    await waitFor(() => byMethod("initialize").length > 0, "retry initialize");
    reply(lastByMethod("initialize")!.id, INIT_RESULT);
    await waitFor(() => byMethod("session/resume").length > 0, "retry resume");
    expect(lastByMethod("session/resume")!.params.sessionId).toBe("MS1");
    await stopMuseSession("stop-failure");
    await retry;
  });

  it("does not dispatch a new send before Stop is acknowledged", async () => {
    const { turn } = await startTurn([], "hold", "stop-wait");
    await new Promise(r => setTimeout(r, 0));
    const cancel = cancelMuseTurn("stop-wait");
    notify("turn/completed", { sessionId: "MS1", turnId: "T1", terminal: "cancelled" });
    const next = sendMuseTurn(baseInput([], "next", "stop-wait"));
    await new Promise(r => setTimeout(r, 10));
    expect(byMethod("turn/start")).toHaveLength(1);
    reply(lastByMethod("turn/interrupt")!.id, {});
    await cancel;
    await turn;
    await waitFor(() => byMethod("turn/start").length === 2, "next turn");
    reply(lastByMethod("turn/start")!.id, { disposition: "started", turnId: "T2" });
    notify("turn/completed", { sessionId: "MS1", turnId: "T2", terminal: "completed" });
    await next;
    await stopMuseSession("stop-wait");
  });

  it.each(["rejected", "unanswered"])("retires the host when queued work is not reclaimed (%s)", async outcome => {
    const turn = sendMuseTurn(baseInput([], "queued on host", "unqueue-failure"));
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(lastByMethod("initialize")!.id, INIT_RESULT);
    await waitFor(() => byMethod("session/start").length > 0, "session start");
    reply(lastByMethod("session/start")!.id, { session: { sessionId: "MS1" } });
    await flushControls();
    notify("turn/started", { sessionId: "MS1", turnId: "T-existing" });
    reply(lastByMethod("turn/start")!.id, { disposition: "queued", turnId: "T-queued" });
    await new Promise(r => setTimeout(r, 0));
    vi.useFakeTimers();
    try {
      const cancel = cancelMuseTurn("unqueue-failure");
      expect(lastByMethod("turn/interrupt")!.params.turnId).toBe("T-existing");
      expect(lastByMethod("turn/unqueue")!.params.turnId).toBe("T-queued");
      reply(lastByMethod("turn/interrupt")!.id, {});
      if (outcome === "rejected") {
        fail(lastByMethod("turn/unqueue")!.id, { code: -32603, message: "unqueue failed" });
      } else {
        await vi.advanceTimersByTimeAsync(15_001);
      }
      await cancel;
      await turn;
      expect(killChild).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("does not let a late Stop response retire a replacement host", async () => {
    const old = await startTurn([], "old", "stop-replaced");
    await new Promise(r => setTimeout(r, 0));
    const cancel = cancelMuseTurn("stop-replaced");
    const oldLine = onLine!;
    const request = lastByMethod("turn/interrupt")!;
    await stopMuseSession("stop-replaced");
    await Promise.all([cancel, old.turn]);
    sent.length = 0;
    const next = sendMuseTurn(baseInput([], "new", "stop-replaced"));
    await waitFor(() => byMethod("initialize").length > 0, "new initialize");
    reply(lastByMethod("initialize")!.id, INIT_RESULT);
    await waitFor(() => byMethod("session/resume").length > 0, "new resume");
    reply(lastByMethod("session/resume")!.id, { session: { sessionId: "MS1" } });
    await flushControls();
    reply(lastByMethod("turn/start")!.id, { disposition: "started", turnId: "T-new" });
    oldLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "late interrupt failure" } }));
    await new Promise(r => setTimeout(r, 0));
    expect(killChild).toHaveBeenCalledOnce();
    notify("turn/completed", { sessionId: "MS1", turnId: "T-new", terminal: "completed" });
    await next;
    await stopMuseSession("stop-replaced");
  });

  it("shares one resumed host for sends waiting on a failed Stop", async () => {
    const old = await startTurn([], "old", "cancel-shared");
    await new Promise(r => setTimeout(r, 0));
    const cancel = cancelMuseTurn("cancel-shared");
    const first = sendMuseTurn(baseInput([], "one", "cancel-shared"));
    const second = sendMuseTurn(baseInput([], "two", "cancel-shared"));
    fail(lastByMethod("turn/interrupt")!.id, { code: -32603, message: "interrupt failed" });
    await Promise.all([cancel, old.turn]);
    await waitFor(() => byMethod("initialize").length === 2, "one new initialize");
    reply(lastByMethod("initialize")!.id, INIT_RESULT);
    await waitFor(() => byMethod("session/resume").length === 1, "resume");
    reply(lastByMethod("session/resume")!.id, { session: { sessionId: "MS1" } });
    await waitFor(() => byMethod("session/setApprovalMode").length > 0, "mode");
    reply(lastByMethod("session/setApprovalMode")!.id, {});
    for (const count of [2, 3]) {
      await waitFor(() => byMethod("turn/start").length === count, "serialized send");
      const turnId = `T${count}`;
      reply(lastByMethod("turn/start")!.id, { disposition: "started", turnId });
      notify("turn/completed", { sessionId: "MS1", turnId, terminal: "completed" });
    }
    await Promise.all([first, second]);
    expect(spawnChild).toHaveBeenCalledTimes(2);
    await stopMuseSession("cancel-shared");
  });

  it.each(["live", "resume"])("serializes simultaneous questions from %s and preserves queued deadlines", async source => {
    const events: HarnessEvent[] = [];
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const request = (id: string) => ({ sessionId: "MS1", userInputId: id, turnId: "T1", autoResolutionMs: 60_000, questions: [{ id, question: `${id}?`, options: [{ label: "Yes" }], selection: { mode: "single" } }] });
    let turn: Promise<void> | undefined;
    const state = () => events.reduce(applyHarnessEvent, newSession("muse:default"));
    try {
      if (source === "resume") {
        bindMuseSession("question-queue", "MS1", "/repo");
        turn = sendMuseTurn(baseInput(events, "resume questions", "question-queue"));
        await waitFor(() => byMethod("initialize").length > 0, "initialize");
        reply(lastByMethod("initialize")!.id, INIT_RESULT);
        await waitFor(() => byMethod("session/resume").length > 0, "resume");
        for (const [index, id] of ["first", "second", "expired", "last"].entries()) serverRequest(800 + index, "userInput/request", request(id));
        reply(lastByMethod("session/resume")!.id, { session: { sessionId: "MS1" } });
        await flushControls();
        reply(lastByMethod("turn/start")!.id, { disposition: "started", turnId: "T1" });
      } else {
        ({ turn } = await startTurn(events, "ask questions", "question-queue"));
        for (const id of ["first", "second", "expired", "last"]) notify("userInput/requested", request(id));
      }
      expect(events.filter(e => e.type === "question.asked")).toHaveLength(1);
      expect(state().pendingQuestion?.questions[0].id).toBe("first");
      const deadline = now + 60_000;
      now += 10_000;
      // A queued prompt may settle at the provider before becoming visible.
      notify("userInput/settled", { sessionId: "MS1", userInputId: "expired", outcome: "cancelled" });
      expect(state().pendingQuestion?.questions[0].id).toBe("first");
      respondMuseQuestion("question-queue", state().pendingQuestion!.requestId, { kind: "skipped" });
      fail(lastByMethod("userInput/cancel")!.id, { code: -32602, message: "retry question" });
      await waitFor(() => events.some(e => e.type === "status" && e.text.includes("retry question")), "rejected decision");
      expect(state().pendingQuestion?.questions[0].id).toBe("first");
      respondMuseQuestion("question-queue", state().pendingQuestion!.requestId, { kind: "skipped" });
      reply(lastByMethod("userInput/cancel")!.id, {});
      await waitFor(() => state().pendingQuestion?.questions[0].id === "second", "second question");
      expect(state().pendingQuestion?.autoResolveAt).toBe(deadline);
      // Duplicate server settlement must not advance twice.
      notify("userInput/settled", { sessionId: "MS1", userInputId: "first", outcome: "cancelled" });
      expect(state().pendingQuestion?.questions[0].id).toBe("second");
      notify("userInput/settled", { sessionId: "MS1", userInputId: "second", outcome: "answered" });
      expect(state().pendingQuestion?.questions[0].id).toBe("last");
      notify("userInput/requested", request("must-not-show-on-stop"));
      const askedBeforeStop = events.filter(e => e.type === "question.asked").length;
      await stopMuseSession("question-queue");
      expect(state().pendingQuestion).toBeUndefined();
      expect(events.filter(e => e.type === "question.asked")).toHaveLength(askedBeforeStop);
      await turn;
    } finally {
      clock.mockRestore();
      await stopMuseSession("question-queue");
      await turn;
    }
  });
});
