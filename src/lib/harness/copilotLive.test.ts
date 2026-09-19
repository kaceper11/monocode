import { describe, expect, it, vi, beforeEach } from "vitest";

const sent: string[] = [];
const spawned: { command: string; args: string[]; cwd: string }[] = [];
const killed: string[] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code: number | null) => void) | undefined;
let onStderr: ((line: string) => void) | undefined;

vi.mock("./child", () => ({
  resolveCopilotBinary: async () => ({ path: "/fake/copilot" }),
  spawnChild: async (
    _id: string,
    command: string,
    args: string[],
    cwd: string,
  ) => {
    spawned.push({ command, args, cwd });
  },
  killChild: async (id: string) => {
    killed.push(id);
  },
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    exit: (c: number | null) => void,
    stderr?: (line: string) => void,
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
  sendCopilotTurn,
  prewarmCopilotSession,
  steerCopilotTurn,
  cancelCopilotTurn,
  respondCopilotApproval,
  respondCopilotQuestion,
  setCopilotRuntimeMode,
  stopCopilotSession,
  copilotCommandProvider,
} = await import("./copilot");
import type { HarnessEvent } from "./types";
import { resetHarnessModelOverlays, setHarnessModels } from "../models";

const SETUP = {
  sessionId: "C1",
  models: {
    currentModelId: "gpt-4.1",
    availableModels: [
      { modelId: "gpt-4.1", name: "GPT-4.1" },
      { modelId: "gpt-5", name: "GPT-5" },
    ],
  },
  modes: {
    currentModeId: "autonomous",
    availableModes: ["normal", "autonomous", "plan"].map((id) => ({
      id,
      name: id,
    })),
  },
  configOptions: [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: "gpt-4.1",
      options: [
        { value: "gpt-4.1", name: "GPT-4.1" },
        { value: "gpt-5", name: "GPT-5" },
      ],
    },
  ],
};

function reply(id: number, result: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
function fail(id: number, code: number, message: string) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}
function notify(update: unknown) {
  onLine!(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "C1", update },
    }),
  );
}
const parse = () => sent.map((s) => JSON.parse(s));
const byMethod = (method: string) => parse().filter((m) => m.method === method);
const lastByMethod = (method: string) => byMethod(method).at(-1);
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for ${label}; sent=${JSON.stringify(parse().map((m) => m.method ?? `reply:${m.id}`))}`,
  );
};

/** Drive a turn up to the unanswered session/prompt. */
async function startTurn(
  events: HarnessEvent[],
  id: string,
  overrides: Record<string, unknown> = {},
) {
  const turn = sendCopilotTurn({
    sessionId: id,
    cwd: "/repo",
    model: "copilot:default",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "hey",
    attachments: [],
    onEvent: (e: HarnessEvent) => events.push(e),
    ...overrides,
  } as never);
  await waitFor(() => byMethod("initialize").length > 0, "initialize");
  reply(byMethod("initialize")[0].id, {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
  await waitFor(() => byMethod("session/new").length > 0, "session/new");
  const newMsg = lastByMethod("session/new")!;
  expect(newMsg.params.cwd).toBe(overrides.cwd ?? "/repo");
  reply(newMsg.id, SETUP);
  return { turn };
}

describe("copilot live turn", () => {
  beforeEach(() => {
    sent.length = 0;
    spawned.length = 0;
    killed.length = 0;
  });

  it("shares a cold start between prewarm and Send", async () => {
    const warm = prewarmCopilotSession({
      sessionId: "warm-send", cwd: "/repo", model: "copilot:default",
      runtimeMode: "auto", onEvent: () => {},
    });
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "warm-send", { runtimeMode: "auto" });
    await warm;
    await waitFor(() => byMethod("session/prompt").length === 1, "prompt");
    expect(spawned).toHaveLength(1);
    expect(byMethod("initialize")).toHaveLength(1);
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ready" } });
    reply(lastByMethod("session/prompt").id, { stopReason: "end_turn" });
    await turn;
    expect(events.some(event => event.type === "message.delta" && event.text === "ready")).toBe(true);
    await stopCopilotSession("warm-send");
  });

  it.each([false, true])("waits for the final follow-up result (failed=%s)", async (failed) => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, `main-first-${failed}`, { runtimeMode: "auto" });
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const first = lastByMethod("session/prompt").id;
    const steer = steerCopilotTurn({ sessionId: `main-first-${failed}`, cwd: "/repo", model: "copilot:default", text: "second" });
    await waitFor(() => byMethod("session/prompt").length === 2, "steer");
    let settled = false;
    void turn.then(() => { settled = true; });
    reply(first, { stopReason: "end_turn" });
    await new Promise(r => setTimeout(r, 0));
    expect(settled).toBe(false);
    reply(lastByMethod("session/prompt").id, { stopReason: failed ? "max_tokens" : "end_turn" });
    await steer;
    await turn;
    expect(events.some(e => e.type === "session.error")).toBe(failed);
    await stopCopilotSession(`main-first-${failed}`);
  });

  it("launches --acp --stdio with the chosen effort and streams a turn", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t1", {
      modelSettings: { effort: "high" },
    });
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe("/fake/copilot");
    expect(spawned[0].args).toEqual(["--acp", "--stdio", "--effort=high"]);
    expect(spawned[0].cwd).toBe("/repo");

    // copilot:default has no native id, so no model write happens.
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    expect(lastByMethod("session/set_mode")!.params).toMatchObject({
      sessionId: "C1",
      modeId: "normal",
    });
    reply(lastByMethod("session/set_mode")!.id, {});
    expect(byMethod("session/set_model")).toHaveLength(0);

    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt")!.id;

    // A malformed line must not break the stream.
    onLine!("this is not json");
    notify({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking…" },
    });
    notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi there" },
    });
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Read README",
      kind: "read",
      status: "completed",
    });
    reply(promptId, { stopReason: "end_turn" });
    await turn;

    expect(events.some((e) => e.type === "session.started")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "session.providerBound" && e.providerSessionId === "C1",
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "reasoning.delta" && e.text === "thinking…"),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "message.delta" && e.text === "hi there"),
    ).toBe(true);
    expect(events.some((e) => e.type === "tool.updated")).toBe(true);
    expect(events.some((e) => e.type === "message.completed")).toBe(true);
    await stopCopilotSession("t1");
  });

  it("applies the selected model with session/set_model, separately from effort", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t2", { model: "copilot:gpt-5" });
    await waitFor(
      () => byMethod("session/set_model").length > 0,
      "set_model",
    );
    expect(lastByMethod("session/set_model")!.params).toMatchObject({
      sessionId: "C1",
      modelId: "gpt-5",
    });
    reply(lastByMethod("session/set_model")!.id, {});
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("t2");
  });

  it("falls back to the model config option when set_model is unsupported", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t3", { model: "copilot:gpt-5" });
    await waitFor(
      () => byMethod("session/set_model").length > 0,
      "set_model",
    );
    fail(lastByMethod("session/set_model")!.id, -32601, "Method not found");
    await waitFor(
      () => byMethod("session/set_config_option").length > 0,
      "set_config_option",
    );
    expect(lastByMethod("session/set_config_option")!.params).toMatchObject({
      sessionId: "C1",
      configId: "model",
      value: "gpt-5",
    });
    // The server echoes the refreshed options with the applied currentValue.
    reply(lastByMethod("session/set_config_option")!.id, {
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "gpt-5",
          options: SETUP.configOptions[0].options,
        },
      ],
    });
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("t3");
  });

  it("recycles only its own child when the launch-scoped effort changes", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t4", {
      modelSettings: { effort: "high" },
    });
    expect(spawned[0].args).toContain("--effort=high");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await turn;

    sent.length = 0;
    const second = sendCopilotTurn({
      sessionId: "t4",
      cwd: "/repo",
      model: "copilot:default",
      modelSettings: { effort: "low" },
      runtimeMode: "supervised",
      text: "again",
      attachments: [],
      onEvent: (e: HarnessEvent) => events.push(e),
    } as never);
    await waitFor(() => spawned.length === 2, "respawn");
    expect(killed).toEqual(["t4"]);
    expect(spawned[1].args).toContain("--effort=low");

    // The stored Copilot session is reloaded on the fresh child.
    await waitFor(() => byMethod("initialize").length > 0, "initialize 2");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/load").length > 0, "session/load");
    expect(lastByMethod("session/load")!.params).toMatchObject({
      sessionId: "C1",
      cwd: "/repo",
    });
    expect(byMethod("session/new")).toHaveLength(0);
    reply(lastByMethod("session/load")!.id, SETUP);
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode 2");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt 2");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await second;
    await stopCopilotSession("t4");
  });

  it("replaces the advertised command set instead of appending", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t5");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");

    notify({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: "Review changes" },
        { name: "explain", description: "Explain code" },
      ],
    });
    await waitFor(
      async () =>
        (await copilotCommandProvider.discover({
          sessionId: "t5",
          cwd: "/repo",
        })).length === 2,
      "commands",
    );
    notify({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "tests", description: "Run tests" }],
    });
    const commands = await copilotCommandProvider.discover({
      sessionId: "t5",
      cwd: "/repo",
    });
    expect(commands.map((c) => c.name)).toEqual(["tests"]);

    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("t5");
  });

  it("surfaces a permission request in supervised mode and resolves it", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t6");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt")!.id;

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "session/request_permission",
        params: {
          sessionId: "C1",
          toolCall: {
            toolCallId: "call_9",
            title: "Ran npm test",
            kind: "execute",
            status: "pending",
            rawInput: { command: "npm test" },
          },
          options: [
            { optionId: "allow_once", name: "Allow once" },
            { optionId: "reject_once", name: "Reject" },
          ],
        },
      }),
    );
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );
    respondCopilotApproval("t6", events.find((e) => e.type === "approval.requested")!.requestId, "allow");
    await waitFor(
      () => parse().some((m) => m.id === 77 && m.result),
      "permission response",
    );
    const response = parse().find((m) => m.id === 77 && m.result);
    expect(response!.result.outcome.optionId).toBe("allow_once");
    expect(events.some((e) => e.type === "approval.resolved")).toBe(true);

    reply(promptId, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("t6");
  });

  it("pushes the new mode and settles a parked approval on a mid-conversation change", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t14");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt")!.id;

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 78,
        method: "session/request_permission",
        params: {
          sessionId: "C1",
          toolCall: {
            toolCallId: "call_10",
            title: "Ran npm test",
            kind: "execute",
            status: "pending",
            rawInput: { command: "npm test" },
          },
          options: [
            { optionId: "allow_once", name: "Allow once" },
            { optionId: "reject_once", name: "Reject" },
          ],
        },
      }),
    );
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );

    // supervised -> auto pushes the advertised autonomous mode and the
    // parked approval is auto-answered without another UI round trip.
    setCopilotRuntimeMode("t14", "auto");
    await waitFor(
      () => byMethod("session/set_mode").length > 1,
      "set_mode auto",
    );
    expect(lastByMethod("session/set_mode")!.params.modeId).toBe(
      "autonomous",
    );
    reply(lastByMethod("session/set_mode")!.id, {});

    await waitFor(
      () => parse().some((m) => m.id === 78 && m.result),
      "permission response",
    );
    const response = parse().find((m) => m.id === 78 && m.result);
    expect(response!.result.outcome.optionId).toBe("allow_once");
    expect(
      events.some(
        (e) => e.type === "approval.resolved" && e.decision === "allow",
      ),
    ).toBe(true);

    reply(promptId, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("t14");
  });

  it("routes elicitation requests to the question UI", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t7");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt")!.id;

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 91,
        method: "elicitation/create",
        params: {
          message: "Pick a target",
          requestedSchema: {
            type: "object",
            properties: {
              target: {
                type: "string",
                title: "Deploy target",
                enum: ["staging", "prod"],
              },
            },
          },
        },
      }),
    );
    await waitFor(
      () => events.some((e) => e.type === "question.asked"),
      "question.asked",
    );
    respondCopilotQuestion("t7", events.find((e) => e.type === "question.asked")!.requestId, {
      kind: "answered",
      answers: { target: ["prod"] },
    });
    await waitFor(
      () => parse().some((m) => m.id === 91 && m.result),
      "elicitation response",
    );
    const response = parse().find((m) => m.id === 91 && m.result);
    expect(response!.result).toEqual({
      action: "accept",
      content: { target: "prod" },
    });

    reply(promptId, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("t7");
  });

  it("surfaces a non-end_turn stop reason and still completes", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t8");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "max_tokens" });
    await turn;
    expect(
      events.some(
        (e) => e.type === "session.error" && /token limit/.test(e.message),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "message.completed")).toBe(true);
    await stopCopilotSession("t8");
  });

  it("cancel sends session/cancel and releases a pending approval", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t9");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 88,
        method: "session/request_permission",
        params: {
          sessionId: "C1",
          toolCall: { toolCallId: "call_2", title: "Ran npm test", kind: "execute" },
          options: [
            { optionId: "allow_once", name: "Allow once" },
            { optionId: "reject_once", name: "Reject" },
          ],
        },
      }),
    );
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );

    await cancelCopilotTurn("t9");
    await turn.catch(() => undefined);

    expect(
      parse().some(
        (m) => m.method === "session/cancel" && m.params?.sessionId === "C1",
      ),
    ).toBe(true);
    const response = parse().find((m) => m.id === 88 && m.result);
    expect(response).toBeDefined();
    expect(
      events.some(
        (e) => e.type === "approval.resolved" && e.decision === "deny",
      ),
    ).toBe(true);
    await stopCopilotSession("t9");
  });

  it("fails visibly when the server reports the model unavailable", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t12", {
      model: "copilot:gpt-5",
    });
    await waitFor(() => byMethod("session/set_model").length > 0, "set_model");
    fail(
      lastByMethod("session/set_model")!.id,
      -32603,
      'Model "gpt-5" is not available',
    );
    await expect(turn).rejects.toThrow(/not available/i);
    expect(
      events.some(
        (e) =>
          e.type === "session.error" && /disabled.*policy/i.test(e.message),
      ),
    ).toBe(true);
    expect(byMethod("session/prompt")).toHaveLength(0);
    await stopCopilotSession("t12");
  });

  it("fails when a config-option model write is silently ignored", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t13", {
      model: "copilot:gpt-5",
    });
    await waitFor(() => byMethod("session/set_model").length > 0, "set_model");
    fail(lastByMethod("session/set_model")!.id, -32601, "Method not found");
    await waitFor(
      () => byMethod("session/set_config_option").length > 0,
      "set_config_option",
    );
    // Success response, but currentValue never moved — the choice was refused.
    reply(lastByMethod("session/set_config_option")!.id, {
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "gpt-4.1",
          options: SETUP.configOptions[0].options,
        },
      ],
    });
    await expect(turn).rejects.toThrow(/did not switch/);
    expect(byMethod("session/prompt")).toHaveLength(0);
    await stopCopilotSession("t13");
  });

  it("rejects a model that disappeared from the probed catalog", async () => {
    setHarnessModels("copilot", [
      {
        id: "copilot:gpt-4.1",
        harness: "copilot",
        name: "GPT-4.1",
        nativeId: "gpt-4.1",
      },
    ]);
    try {
      const events: HarnessEvent[] = [];
      const { turn } = await startTurn(events, "t11", {
        model: "copilot:removed-model",
      });
      await expect(turn).rejects.toThrow(/does not offer/);
      expect(
        events.some(
          (e) =>
            e.type === "session.error" && /does not offer/.test(e.message),
        ),
      ).toBe(true);
      // The stale id was never sent to the session.
      expect(byMethod("session/set_model")).toHaveLength(0);
      expect(byMethod("session/prompt")).toHaveLength(0);
    } finally {
      resetHarnessModelOverlays();
      await stopCopilotSession("t11");
    }
  });

  it("routes a child exit to the running turn's listener", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t10");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    onExit!(1);
    await turn.catch(() => undefined);
    expect(events.some((e) => e.type === "session.ended")).toBe(true);
  });

  it("keeps command updates that arrive before session/new resolves", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendCopilotTurn({
      sessionId: "t20",
      cwd: "/repo",
      model: "copilot:default",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "hey",
      attachments: [],
      onEvent: (e: HarnessEvent) => events.push(e),
    } as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: {},
    });
    // The server pushes its command set before session/new resolves.
    notify({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: "Review changes" }],
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(lastByMethod("session/new")!.id, SETUP);
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    expect(
      await copilotCommandProvider.discover({
        sessionId: "t20",
        cwd: "/repo",
      }),
    ).toHaveLength(1);
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("t20");
  });

  it("fails visibly when the server cannot switch models at all", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t21", {
      model: "copilot:gpt-5",
    });
    await waitFor(() => byMethod("session/set_model").length > 0, "set_model");
    fail(lastByMethod("session/set_model")!.id, -32601, "Method not found");
    await waitFor(
      () => byMethod("session/set_config_option").length > 0,
      "set_config_option",
    );
    fail(
      lastByMethod("session/set_config_option")!.id,
      -32601,
      "Method not found",
    );
    await expect(turn).rejects.toThrow(/supports neither/);
    expect(
      events.some(
        (e) =>
          e.type === "session.error" && /cannot switch/.test(e.message),
      ),
    ).toBe(true);
    expect(byMethod("session/prompt")).toHaveLength(0);
    await stopCopilotSession("t21");
  });

  it("keeps the set_model choice when a stale config_option_update arrives", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t22", {
      model: "copilot:gpt-5",
    });
    await waitFor(() => byMethod("session/set_model").length > 0, "set_model");
    reply(lastByMethod("session/set_model")!.id, {});
    // The model config option still reports the old value; it must not
    // revert the pinned selection or rewrite the session model.
    notify({
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "gpt-4.1",
          options: SETUP.configOptions[0].options,
        },
      ],
    });
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await turn;
    expect(events.some((e) => e.type === "session.configChanged")).toBe(false);

    // The config option still reports the stale pre-write model while
    // pinned, so the next turn re-asserts the choice once — a real
    // out-of-band revert and a stale echo are indistinguishable.
    sent.length = 0;
    const second = sendCopilotTurn({
      sessionId: "t22",
      cwd: "/repo",
      model: "copilot:gpt-5",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "again",
      attachments: [],
      onEvent: (e: HarnessEvent) => events.push(e),
    } as never);
    await waitFor(() => byMethod("session/set_model").length > 0, "set_model 2");
    expect(byMethod("session/set_model")).toHaveLength(1);
    reply(lastByMethod("session/set_model")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt 2");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await second;
    await stopCopilotSession("t22");
  });

  it("settles a pending approval when the child exits", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t23");
    const turnDone = turn.catch(() => undefined);
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: {
          sessionId: "C1",
          toolCall: {
            toolCallId: "call_7",
            title: "Ran npm test",
            kind: "execute",
          },
          options: [
            { optionId: "allow_once", name: "Allow once" },
            { optionId: "reject_once", name: "Reject" },
          ],
        },
      }),
    );
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );

    onExit!(1);
    await waitFor(
      () =>
        events.some(
          (e) => e.type === "approval.resolved" && e.decision === "deny",
        ),
      "approval.resolved",
    );
    await turnDone;
    expect(events.some((e) => e.type === "session.ended")).toBe(true);
  });

  it("answers a permission request that carries a string JSON-RPC id", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t28");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "req_abc",
        method: "session/request_permission",
        params: {
          sessionId: "C1",
          toolCall: {
            toolCallId: "call_9",
            title: "Ran npm test",
            kind: "execute",
          },
          options: [
            { optionId: "allow_once", name: "Allow once" },
            { optionId: "reject_once", name: "Reject" },
          ],
        },
      }),
    );
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );
    const requested = events.find((e) => e.type === "approval.requested");
    expect(requested?.type).toBe("approval.requested");
    if (requested?.type !== "approval.requested") return;
    // The UI-facing id is a real number — NaN would wedge the approval card.
    expect(Number.isFinite(requested.requestId)).toBe(true);
    respondCopilotApproval("t28", requested.requestId, "allow");
    await waitFor(
      () => parse().some((m) => m.id === "req_abc" && m.result),
      "permission response",
    );
    // The wire response echoes the server's raw string id.
    const response = parse().find((m) => m.id === "req_abc");
    expect(response?.result?.outcome?.outcome).toBe("selected");
    expect(
      events.some(
        (e) => e.type === "approval.resolved" && e.decision === "allow",
      ),
    ).toBe(true);

    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("t28");
  });

  it("keeps string and numeric wire approvals distinct in the UI", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "approval-id-collision");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    for (const id of ["opaque-request", 1_000_000_001]) {
      onLine!(JSON.stringify({
        jsonrpc: "2.0", id, method: "session/request_permission",
        params: {
          sessionId: "C1",
          toolCall: { toolCallId: String(id), title: "Run command", kind: "execute" },
          options: [{ optionId: "allow_once" }, { optionId: "reject_once" }],
        },
      }));
    }
    await waitFor(() => events.filter((e) => e.type === "approval.requested").length === 2, "two approvals");
    const requests = events.filter((e) => e.type === "approval.requested");
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    respondCopilotApproval("approval-id-collision", requests[1].requestId, "deny");
    respondCopilotApproval("approval-id-collision", requests[0].requestId, "allow");
    await waitFor(() => parse().filter((m) => m.result?.outcome).length === 2, "distinct responses");
    expect(parse().find((m) => m.id === "opaque-request")?.result.outcome.optionId).toBe("allow_once");
    expect(parse().find((m) => m.id === 1_000_000_001)?.result.outcome.optionId).toBe("reject_once");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("approval-id-collision");
  });

  it("retries without --effort when the CLI rejects the flag", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendCopilotTurn({
      sessionId: "t24",
      cwd: "/repo",
      model: "copilot:default",
      modelSettings: { effort: "high" },
      runtimeMode: "supervised",
      text: "hey",
      attachments: [],
      onEvent: (e: HarnessEvent) => events.push(e),
    } as never);
    await waitFor(() => spawned.length === 1, "spawn");
    expect(spawned[0].args).toContain("--effort=high");
    // Only explicit flag rejection permits retrying with default effort.
    onStderr!("error: unknown option '--effort=high'");
    onExit!(2);
    await waitFor(() => spawned.length === 2, "respawn");
    expect(spawned[1].args).toEqual(["--acp", "--stdio"]);

    // sent still holds the dead client's initialize; answer the fresh one.
    await waitFor(() => byMethod("initialize").length >= 2, "initialize 2");
    reply(lastByMethod("initialize")!.id, {
      protocolVersion: 1,
      agentCapabilities: {},
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(lastByMethod("session/new")!.id, SETUP);
    await waitFor(
      () =>
        events.some(
          (e) => e.type === "session.error" && /--effort/.test(e.message),
        ),
      "effort warning",
    );
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("t24");

    // A later checkout/host must try its own CLI capabilities.
    sent.length = 0;
    const next = await startTurn(events, "t24", { cwd: "/other-repo", modelSettings: { effort: "high" } });
    expect(spawned.at(-1)!.args).toContain("--effort=high");
    await waitFor(() => byMethod("session/set_mode").length > 0, "mode on new host");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt on new host");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await next.turn;
    await stopCopilotSession("t24");
  });

  it("does not retry without --effort when the handshake fails while the child lives", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendCopilotTurn({
      sessionId: "t25",
      cwd: "/repo",
      model: "copilot:default",
      modelSettings: { effort: "high" },
      runtimeMode: "supervised",
      text: "hey",
      attachments: [],
      onEvent: (e: HarnessEvent) => events.push(e),
    } as never);
    const settled = turn.catch(() => undefined);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    // An ACP error response with the process still running is not a flag
    // rejection — no silent downgrade to the default effort.
    fail(lastByMethod("initialize")!.id, -32000, "authentication required");
    await settled;
    await new Promise((r) => setTimeout(r, 20));
    expect(spawned).toHaveLength(1);
    expect(
      events.some(
        (e) => e.type === "session.error" && /--effort/.test(e.message),
      ),
    ).toBe(false);
    await stopCopilotSession("t25");
  });

  it("preserves explicit effort when an unrelated startup failure kills the child", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendCopilotTurn({
      sessionId: "unrelated-startup-exit", cwd: "/repo", model: "copilot:default",
      modelSettings: { effort: "high" }, runtimeMode: "supervised", text: "hello",
      attachments: [], onEvent: (event) => events.push(event),
    });
    void turn.catch(() => undefined);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    onStderr!("Authentication required");
    onExit!(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned).toHaveLength(1);
    await expect(turn).rejects.toThrow(/exited/);
    expect(events.some((event) => event.type === "session.error" && /does not support --effort/.test(event.message))).toBe(false);
    await stopCopilotSession("unrelated-startup-exit");
  });

  it("does not retry the turn when a cancel lands during a failed handshake", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendCopilotTurn({
      sessionId: "t26",
      cwd: "/repo",
      model: "copilot:default",
      modelSettings: { effort: "high" },
      runtimeMode: "supervised",
      text: "hey",
      attachments: [],
      onEvent: (e: HarnessEvent) => events.push(e),
    } as never);
    const settled = turn.catch(() => undefined);
    await waitFor(() => spawned.length === 1, "spawn");
    await cancelCopilotTurn("t26");
    // The flag rejection fires after the user already stopped the session.
    onExit!(2);
    await settled;
    await new Promise((r) => setTimeout(r, 20));
    expect(spawned).toHaveLength(1);
    await stopCopilotSession("t26");
  });

  it("follows the server when a config_option_update moves past the pinned model", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t27", {
      model: "copilot:gpt-5",
    });
    await waitFor(() => byMethod("session/set_model").length > 0, "set_model");
    reply(lastByMethod("session/set_model")!.id, {});
    // A third value — neither the pinned model nor the stale pre-write echo —
    // means the server really changed models; adopt it and report it.
    notify({
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "claude-sonnet-4.5",
          options: [
            ...SETUP.configOptions[0].options,
            { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
          ],
        },
      ],
    });
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.type === "session.configChanged" &&
            e.model === "copilot:claude-sonnet-4.5",
        ),
      "configChanged",
    );
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await turn;
    await stopCopilotSession("t27");
  });

  it("keeps the running turn's posture when a plan turn is queued behind it", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await startTurn(events, "t29");
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt")!.id;

    // Queue a plan turn behind the still-running supervised turn. Its
    // intent must not flip the running turn's permission posture.
    const queued = sendCopilotTurn({
      sessionId: "t29",
      cwd: "/repo",
      model: "copilot:default",
      modelSettings: {},
      runtimeMode: "supervised",
      intent: "plan",
      text: "then plan the refactor",
      attachments: [],
      onEvent: (e: HarnessEvent) => events.push(e),
    } as never);

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 91,
        method: "session/request_permission",
        params: {
          sessionId: "C1",
          toolCall: {
            toolCallId: "call_9",
            title: "Ran rm -rf build",
            kind: "execute",
            status: "pending",
            rawInput: { command: "rm -rf build" },
          },
          options: [
            { optionId: "allow_once", name: "Allow" },
            { optionId: "reject_once", name: "Reject" },
          ],
        },
      }),
    );
    // Supervised posture: the write request goes to the user. A leaked plan
    // posture would auto-deny it without an approval.requested event.
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );
    expect(parse().some((m) => m.id === 91)).toBe(false);
    respondCopilotApproval("t29", events.find((e) => e.type === "approval.requested")!.requestId, "deny");
    await waitFor(
      () => parse().some((m) => m.id === 91 && m.result),
      "permission response",
    );

    reply(promptId, { stopReason: "end_turn" });
    await turn;

    // The queued plan turn applies its own mode before prompting.
    await waitFor(
      () => byMethod("session/set_mode").length === 2,
      "set_mode for queued turn",
    );
    expect(lastByMethod("session/set_mode")!.params.modeId).toBe("plan");
    reply(lastByMethod("session/set_mode")!.id, {});
    await waitFor(
      () => byMethod("session/prompt").length === 2,
      "queued prompt",
    );
    reply(lastByMethod("session/prompt")!.id, { stopReason: "end_turn" });
    await queued;
    await stopCopilotSession("t29");
  });
});
