import { describe, expect, it, vi, beforeEach } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code: number | null) => void) | undefined;

vi.mock("./child", () => ({
  resolveDevinBinary: async () => ({ path: "/fake/devin" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    exit: (c: number | null) => void,
  ) => {
    onLine = line;
    onExit = exit;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const {
  sendDevinTurn,
  steerDevinTurn,
  cancelDevinTurn,
  respondDevinApproval,
  setDevinRuntimeMode,
  stopDevinSession,
} = await import("./devin");
import type { HarnessEvent } from "./types";
import {
  resetHarnessModelOverlays,
  setHarnessModels,
} from "../models";

const MODES = ["accept-edits", "smart", "ask", "plan", "bypass"];

const SETUP = {
  sessionId: "S1",
  modes: {
    currentModeId: "smart",
    availableModes: MODES.map((id) => ({ id, name: id })),
  },
  configOptions: [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: "swe-2",
      options: [{ value: "swe-2", name: "SWE 2" }],
    },
  ],
};

function reply(id: number, result: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
function notify(update: unknown) {
  onLine!(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "S1", update },
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

const baseInput = (events: HarnessEvent[], text: string, id = "t1") => ({
  sessionId: id,
  cwd: "/repo",
  model: "devin:default",
  modelSettings: {},
  runtimeMode: "supervised" as const,
  text,
  attachments: [],
  onEvent: (e: HarnessEvent) => events.push(e),
});

describe("devin live turn sequence", () => {
  beforeEach(() => {
    sent.length = 0;
    resetHarnessModelOverlays();
  });

  it("starts a session, applies the advertised supervised mode, and streams a turn", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn(baseInput(events, "hey") as never);

    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    const newMsg = byMethod("session/new")[0];
    expect(newMsg.params.cwd).toBe("/repo");
    reply(newMsg.id, SETUP);

    // supervised maps to accept-edits; the session is in smart, so it switches.
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode");
    expect(lastByMethod("session/set_mode").params).toMatchObject({
      sessionId: "S1",
      modeId: "accept-edits",
    });
    reply(lastByMethod("session/set_mode").id, {});

    // devin:default has no nativeId, so no model config write happens.
    expect(byMethod("session/set_config_option")).toHaveLength(0);

    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt").id;
    notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi there" },
    });
    reply(promptId, { stopReason: "end_turn" });
    await turn;

    expect(events.some((e) => e.type === "session.started")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "session.providerBound" && e.providerSessionId === "S1",
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.type === "message.delta" && e.text === "hi there",
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "message.completed")).toBe(true);
    await stopDevinSession("t1");
  });

  it("steers an in-flight turn with a second session/prompt", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn(baseInput(events, "first", "t2") as never);

    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
    });
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const mainPromptId = lastByMethod("session/prompt").id;

    // While the main prompt is unanswered, a steer is its own session/prompt.
    const steer = steerDevinTurn({
      sessionId: "t2",
      cwd: "/repo",
      model: "devin:default",
      text: "also check the tests",
      attachments: [],
    } as never);
    await waitFor(
      () => byMethod("session/prompt").length === 2,
      "steer prompt",
    );
    const steerPromptId = lastByMethod("session/prompt").id;
    expect(byMethod("session/prompt")[1].params.prompt[0].text).toBe(
      "also check the tests",
    );

    reply(steerPromptId, { stopReason: "end_turn" });
    await steer;
    reply(mainPromptId, { stopReason: "end_turn" });
    await turn;
    await stopDevinSession("t2");
  });

  it("surfaces a permission request in supervised mode and resolves it", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn(baseInput(events, "run tests", "t3") as never);

    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
    });
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt").id;

    notify({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Ran npm test",
      kind: "execute",
      status: "pending",
      rawInput: { command: "npm test" },
    });
    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "session/request_permission",
        params: {
          sessionId: "S1",
          toolCall: {
            toolCallId: "call_1",
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
    respondDevinApproval("t3", 77, "allow");
    await waitFor(
      () => parse().some((m) => m.id === 77 && m.result),
      "permission response",
    );
    const response = parse().find((m) => m.id === 77 && m.result);
    expect(response.result.outcome.optionId).toBe("allow_once");
    expect(events.some((e) => e.type === "approval.resolved")).toBe(true);

    reply(promptId, { stopReason: "end_turn" });
    await turn;
    await stopDevinSession("t3");
  });

  it("pushes the new mode and settles a parked approval on a mid-conversation change", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn(baseInput(events, "run tests", "t12") as never);

    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
    });
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt").id;

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "session/request_permission",
        params: {
          sessionId: "S1",
          toolCall: {
            toolCallId: "call_1",
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

    setDevinRuntimeMode("t12", "full-access");
    await waitFor(
      () => byMethod("session/set_mode").length > 0,
      "session/set_mode",
    );
    const setMode = lastByMethod("session/set_mode")!;
    expect(setMode.params.modeId).toBe("bypass");
    reply(setMode.id, {});

    await waitFor(
      () => parse().some((m) => m.id === 77 && m.result),
      "permission response",
    );
    const response = parse().find((m) => m.id === 77 && m.result);
    expect(response.result.outcome.optionId).toBe("allow_once");
    expect(
      events.some(
        (e) => e.type === "approval.resolved" && e.decision === "allow",
      ),
    ).toBe(true);

    reply(promptId, { stopReason: "end_turn" });
    await turn;
    await stopDevinSession("t12");
  });

  it("answers a permission request that carries a string JSON-RPC id", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn(baseInput(events, "run tests", "t7") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
    });
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt").id;

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "req_abc",
        method: "session/request_permission",
        params: {
          sessionId: "S1",
          toolCall: {
            toolCallId: "call_3",
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
    respondDevinApproval("t7", requested.requestId, "allow");
    await waitFor(
      () => parse().some((m) => m.id === "req_abc" && m.result),
      "permission response",
    );
    // The wire response echoes the server's raw string id.
    const response = parse().find((m) => m.id === "req_abc");
    expect(response?.result?.outcome?.optionId).toBe("allow_once");

    reply(promptId, { stopReason: "end_turn" });
    await turn;
    await stopDevinSession("t7");
  });

  it("resumes a parked session with session/load instead of session/new", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn(baseInput(events, "hey", "t5") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
    });
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt").id, { stopReason: "end_turn" });
    await turn;
    await stopDevinSession("t5");

    sent.length = 0;
    const turn2 = sendDevinTurn(baseInput(events, "back again", "t5") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize 2");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(
      () => byMethod("session/load").length > 0,
      "session/load",
    );
    const loadMsg = lastByMethod("session/load");
    expect(loadMsg.params).toMatchObject({ sessionId: "S1", cwd: "/repo" });
    expect(byMethod("session/new")).toHaveLength(0);
    reply(loadMsg.id, SETUP);
    await waitFor(() => byMethod("session/set_mode").length > 0, "set_mode 2");
    reply(lastByMethod("session/set_mode").id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt 2");
    reply(lastByMethod("session/prompt").id, { stopReason: "end_turn" });
    await turn2;
    await stopDevinSession("t5");
  });

  it("cancel sends session/cancel and releases a pending approval", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn(baseInput(events, "run tests", "t6") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
    });
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");

    // Park the turn on a supervised permission prompt, then cancel.
    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 88,
        method: "session/request_permission",
        params: {
          sessionId: "S1",
          toolCall: {
            toolCallId: "call_2",
            title: "Ran npm test",
            kind: "execute",
            status: "pending",
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

    await cancelDevinTurn("t6");
    await turn.catch(() => undefined);

    expect(
      parse().some(
        (m) =>
          m.method === "session/cancel" && m.params?.sessionId === "S1",
      ),
    ).toBe(true);
    // The pending permission was answered (denied) rather than left hanging.
    const response = parse().find((m) => m.id === 88 && m.result);
    expect(response).toBeDefined();
    expect(
      events.some(
        (e) => e.type === "approval.resolved" && e.decision === "deny",
      ),
    ).toBe(true);
    await stopDevinSession("t6");
  });

  it("routes a child exit to the running turn's listener", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn(baseInput(events, "hey", "t4") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
    });
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    onExit!(1);
    await turn.catch(() => undefined);
    expect(events.some((e) => e.type === "session.ended")).toBe(true);
  });

  it("writes the reasoning variant uid and maps reported models back to the group", async () => {
    const modelOptions = [
      { value: "swe-2-medium", name: "SWE-2 Medium" },
      { value: "swe-2-high", name: "SWE-2 High" },
    ];
    const setup = {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "swe-2-medium",
          options: modelOptions,
        },
      ],
    };
    setHarnessModels("devin", [
      {
        id: "devin:swe-2",
        harness: "devin",
        name: "SWE-2",
        nativeId: "swe-2-medium",
        settings: [
          {
            id: "reasoning",
            label: "Reasoning",
            kind: "select",
            value: "swe-2-medium",
            options: [
              { value: "swe-2-medium", label: "Medium" },
              { value: "swe-2-high", label: "High" },
            ],
          },
        ],
      },
    ]);

    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn({
      ...baseInput(events, "hey", "t9"),
      model: "devin:swe-2",
      modelSettings: { reasoning: "swe-2-high" },
    } as never);

    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, setup);

    // High reasoning → the `swe-2-high` variant uid, not a reassembled base.
    await waitFor(
      () => byMethod("session/set_config_option").length > 0,
      "set_config_option",
    );
    expect(lastByMethod("session/set_config_option").params).toMatchObject({
      sessionId: "S1",
      configId: "model",
      value: "swe-2-high",
    });
    reply(lastByMethod("session/set_config_option").id, {});

    // Devin reporting the applied value maps back to the group id + reasoning.
    notify({
      sessionUpdate: "config_option_update",
      configOptions: [
        { ...setup.configOptions[0], currentValue: "swe-2-high" },
      ],
    });
    await waitFor(
      () => events.some((e) => e.type === "session.configChanged"),
      "configChanged",
    );
    const changed = events.find((e) => e.type === "session.configChanged");
    expect(changed).toMatchObject({
      model: "devin:swe-2",
      modelSettings: { reasoning: "swe-2-high" },
    });

    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt").id, { stopReason: "end_turn" });
    await turn;
    await stopDevinSession("t9");
  });

  it("ignores a reasoning uid the selected model does not offer", async () => {
    setHarnessModels("devin", [
      {
        id: "devin:swe-2",
        harness: "devin",
        name: "SWE-2",
        nativeId: "swe-2-medium",
        settings: [
          {
            id: "reasoning",
            label: "Reasoning",
            kind: "select",
            value: "swe-2-medium",
            options: [
              { value: "swe-2-medium", label: "Medium" },
              { value: "swe-2-high", label: "High" },
            ],
          },
        ],
      },
    ]);

    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn({
      ...baseInput(events, "hey", "t8"),
      model: "devin:swe-2",
      modelSettings: { reasoning: "other-model-high" },
    } as never);

    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
    });

    // The foreign uid is not offered by swe-2 → the base variant is sent.
    await waitFor(
      () => byMethod("session/set_config_option").length > 0,
      "set_config_option",
    );
    expect(lastByMethod("session/set_config_option").params).toMatchObject({
      sessionId: "S1",
      configId: "model",
      value: "swe-2-medium",
    });
    reply(lastByMethod("session/set_config_option").id, {});
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    reply(lastByMethod("session/prompt").id, { stopReason: "end_turn" });
    await turn;
    await stopDevinSession("t8");
  });

  it("keeps the running turn's posture when a plan turn is queued behind it", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn(baseInput(events, "run tests", "t10") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
    });
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt").id;

    // Queue a plan turn behind the still-running supervised turn. Its
    // intent must not flip the running turn's permission posture.
    const queued = sendDevinTurn({
      ...baseInput(events, "then plan the refactor", "t10"),
      intent: "plan",
    } as never);

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 91,
        method: "session/request_permission",
        params: {
          sessionId: "S1",
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
    // Supervised posture: the write request goes to the user. If the queued
    // plan posture had leaked, it would auto-deny instead.
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );
    respondDevinApproval("t10", 91, "deny");
    await waitFor(
      () => parse().some((m) => m.id === 91 && m.result),
      "permission response",
    );

    reply(promptId, { stopReason: "end_turn" });
    await turn;

    // The queued plan turn now applies its own mode before prompting.
    await waitFor(
      () => byMethod("session/set_mode").length > 0,
      "set_mode for queued turn",
    );
    expect(lastByMethod("session/set_mode").params.modeId).toBe("plan");
    reply(lastByMethod("session/set_mode").id, {});
    await waitFor(
      () => byMethod("session/prompt").length === 2,
      "queued prompt",
    );
    reply(lastByMethod("session/prompt").id, { stopReason: "end_turn" });
    await queued;
    await stopDevinSession("t10");
  });

  it("keeps the running turn's posture when a full-access send is queued", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendDevinTurn(baseInput(events, "run tests", "t11") as never);
    await waitFor(() => byMethod("initialize").length > 0, "initialize");
    reply(byMethod("initialize")[0].id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    await waitFor(() => byMethod("session/new").length > 0, "session/new");
    reply(byMethod("session/new")[0].id, {
      ...SETUP,
      modes: { ...SETUP.modes, currentModeId: "accept-edits" },
    });
    await waitFor(() => byMethod("session/prompt").length > 0, "prompt");
    const promptId = lastByMethod("session/prompt").id;

    // Queue a full-access send behind the running supervised turn. Its
    // runtimeMode must not auto-approve the running turn's requests.
    const queued = sendDevinTurn({
      ...baseInput(events, "then clean up", "t11"),
      runtimeMode: "full-access",
    } as never);

    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 92,
        method: "session/request_permission",
        params: {
          sessionId: "S1",
          toolCall: {
            toolCallId: "call_10",
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
    // If the queued posture had leaked, full-access would auto-allow this
    // write request and approval.requested would never surface.
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );
    expect(parse().some((m) => m.id === 92)).toBe(false);
    respondDevinApproval("t11", 92, "allow");
    await waitFor(
      () => parse().some((m) => m.id === 92 && m.result),
      "permission response",
    );

    reply(promptId, { stopReason: "end_turn" });
    await turn;

    // The queued send applies its own mode before prompting.
    await waitFor(
      () => byMethod("session/set_mode").length > 0,
      "set_mode for queued turn",
    );
    reply(lastByMethod("session/set_mode").id, {});
    await waitFor(
      () => byMethod("session/prompt").length === 2,
      "queued prompt",
    );
    reply(lastByMethod("session/prompt").id, { stopReason: "end_turn" });
    await queued;
    await stopDevinSession("t11");
  });
});
