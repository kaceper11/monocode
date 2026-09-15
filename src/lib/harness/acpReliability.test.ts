import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, SendTurnInput } from "./types";

const wire = vi.hoisted(() => ({
  listeners: new Map<string, (line: string) => void>(),
  sent: [] as {
    thread: string;
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  }[],
  spawned: [] as string[],
  holdInitialize: false,
  holdMode: false,
  modeSetup: false,
  holdPrompt: false,
  rejectLoad: false,
  rejectModel: false,
  ignoreModel: false,
  stopReason: "end_turn",
  resolveGate: undefined as Promise<void> | undefined,
}));
vi.mock("./child", () => {
  const resolve = async () => {
    await wire.resolveGate;
    return { path: "/fake/agent" };
  };
  return {
    resolveDevinBinary: resolve,
    resolveCopilotBinary: resolve,
    resolveCursorBinary: resolve,
    resolveGrokBinary: resolve,
    resolveFxBinary: resolve,
    spawnChild: async (thread: string) => {
      wire.spawned.push(thread);
    },
    unwatchChild: (thread: string) => {
      wire.listeners.delete(thread);
    },
    killChild: async () => undefined,
    watchChild: (thread: string, line: (line: string) => void) => {
      wire.listeners.set(thread, line);
    },
    writeChild: async (thread: string, line: string) => {
      const msg = JSON.parse(line);
      wire.sent.push({ thread, ...msg });
      if (!msg.method || msg.id == null) return;
      if (wire.holdInitialize && msg.method === "initialize") return;
      if (wire.holdMode && msg.method === "session/set_mode") return;
      if (wire.holdPrompt && msg.method === "session/prompt") return;
      let result: unknown = {};
      let error: { code: number; message: string } | undefined;
      if (msg.method === "initialize")
        result = { agentCapabilities: { loadSession: true } };
      if (
        ["session/new", "session/load", "session/resume"].includes(msg.method)
      ) {
        result = setup(thread);
        if (wire.rejectLoad && msg.method !== "session/new")
          error = { code: -32000, message: "saved session unavailable" };
      }
      if (
        ["session/set_model", "session/set_config_option"].includes(msg.method)
      ) {
        if (wire.rejectModel)
          error = { code: -32000, message: "model unavailable" };
        else if (wire.ignoreModel) result = setup(thread);
        else
          result = {
            configOptions: [
              {
                id: msg.params.configId ?? "model",
                currentValue: msg.params.value ?? msg.params.modelId,
              },
            ],
          };
      }
      if (msg.method === "session/prompt")
        result = { stopReason: wire.stopReason };
      queueMicrotask(() =>
        wire.listeners.get(thread)?.(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            ...(error ? { error } : { result }),
          }),
        ),
      );
    },
  };
});
vi.mock("./cursorStore", () => ({
  readStoredCursorToolCalls: async () => [],
  readStoredCursorSubagentRuns: async () => [],
}));
const providers = [
  {
    id: "devin",
    model: "swe-2",
    ...(await import("./devin").then((m) => ({
      send: m.sendDevinTurn,
      stop: m.stopDevinSession,
      forget: m.forgetDevinSession,
      cancel: m.cancelDevinTurn,
      bind: m.bindDevinSession,
    }))),
  },
  {
    id: "copilot",
    model: "gpt-5.4",
    ...(await import("./copilot").then((m) => ({
      send: m.sendCopilotTurn,
      stop: m.stopCopilotSession,
      forget: m.forgetCopilotSession,
      cancel: m.cancelCopilotTurn,
      bind: m.bindCopilotSession,
    }))),
  },
  {
    id: "cursor",
    model: "composer-2.5",
    ...(await import("./cursor").then((m) => ({
      send: m.sendCursorTurn,
      stop: m.stopCursorSession,
      forget: m.forgetCursorSession,
      cancel: m.cancelCursorTurn,
      bind: m.bindCursorSession,
    }))),
  },
  {
    id: "grok",
    model: "grok-4.6",
    ...(await import("./grok").then((m) => ({
      send: m.sendGrokTurn,
      stop: m.stopGrokSession,
      forget: m.forgetGrokSession,
      cancel: m.cancelGrokTurn,
      bind: m.bindGrokSession,
    }))),
  },
  {
    id: "fx",
    model: "zai/glm-5.2",
    ...(await import("./fx").then((m) => ({
      send: m.sendFxTurn,
      stop: m.stopFxSession,
      forget: m.forgetFxSession,
      cancel: m.cancelFxTurn,
      bind: m.bindFxSession,
    }))),
  },
];
function setup(thread: string) {
  const provider = providers.find((p) => thread.startsWith(p.id))!;
  return {
    sessionId: `S-${thread}`,
    ...(wire.modeSetup ? { modes: {
      currentModeId: "normal",
      availableModes: ["normal", provider.id === "devin" ? "smart" : "autonomous", "plan"].map((id) => ({ id })),
    } } : {}),
    configOptions: [
      { id: "model", category: "model", currentValue: provider.model },
    ],
    models: {
      currentModelId: provider.model,
      availableModels: [{ modelId: provider.model }],
    },
  };
}
let sequence = 0;
const cleanup: (() => Promise<void>)[] = [];
function input(
  provider: (typeof providers)[number],
  events: HarnessEvent[] = [],
): SendTurnInput {
  const sessionId = `${provider.id}-${++sequence}`;
  cleanup.push(() => provider.forget(sessionId));
  return {
    sessionId,
    cwd: "/repo",
    model: `${provider.id}:${provider.model}`,
    runtimeMode: "supervised",
    text: "hello",
    attachments: [],
    modelSettings: {},
    onEvent: (event) => events.push(event),
  };
}
const methods = (thread: string) =>
  wire.sent.filter((m) => m.thread === thread).map((m) => m.method);
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Expected adapter progress");
}
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  wire.sent.length = 0;
  wire.spawned.length = 0;
  wire.holdInitialize = false;
  wire.holdMode = false;
  wire.modeSetup = false;
  wire.holdPrompt = false;
  wire.rejectLoad = false;
  wire.rejectModel = false;
  wire.ignoreModel = false;
  wire.stopReason = "end_turn";
  wire.resolveGate = undefined;
  vi.useRealTimers();
});

describe.each(providers)("$id ACP recovery", (provider) => {
  it("deduplicates cold starts and serializes their prompts", async () => {
    const turn = input(provider);
    await Promise.all([
      provider.send(turn),
      provider.send({ ...turn, text: "follow up" }),
    ]);
    expect(wire.spawned).toEqual([turn.sessionId]);
    expect(
      methods(turn.sessionId).filter((m) => m === "session/prompt"),
    ).toHaveLength(2);
  });
  it("cancels a handshake without waiting for a provider response", async () => {
    wire.holdInitialize = true;
    const turn = input(provider);
    const running = provider.send(turn);
    const rejected = expect(running).rejects.toThrow(/cancelled/i);
    await until(() => methods(turn.sessionId).includes("initialize"));
    await provider.cancel(turn.sessionId);
    await rejected;
    expect(methods(turn.sessionId)).not.toContain("session/prompt");
  });
  it("does not spawn after removal during binary discovery", async () => {
    let release!: () => void;
    wire.resolveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = input(provider);
    const running = provider.send(turn);
    const rejected = expect(running).rejects.toThrow(/cancelled/i);
    await provider.forget(turn.sessionId);
    release();
    await rejected;
    expect(wire.spawned).toEqual([]);
  });
  it("preserves a failed resume binding and never creates an empty replacement", async () => {
    const turn = input(provider);
    provider.bind(turn.sessionId, "saved", turn.cwd);
    wire.rejectLoad = true;
    await expect(provider.send(turn)).rejects.toThrow(/preserved/);
    expect(methods(turn.sessionId)).not.toContain("session/new");
    expect(methods(turn.sessionId)).not.toContain("session/prompt");
    wire.rejectLoad = false;
    await provider.send(turn);
    expect(methods(turn.sessionId)).not.toContain("session/new");
    expect(methods(turn.sessionId)).toContain("session/prompt");
  });
  it("surfaces a non-success terminal stop reason", async () => {
    const events: HarnessEvent[] = [];
    const turn = input(provider, events);
    wire.stopReason = "max_tokens";
    await provider.send(turn);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.error",
        message: expect.stringMatching(/token limit/),
      }),
    );
  });
});

describe.each(providers.filter((p) => p.id !== "copilot"))(
  "$id explicit selection",
  (provider) => {
    it("does not prompt after model rejection", async () => {
      const turn = input(provider);
      await provider.send(turn);
      wire.sent.length = 0;
      wire.rejectModel = true;
      await expect(
        provider.send({ ...turn, model: `${provider.id}:different` }),
      ).rejects.toThrow(/model unavailable/);
      expect(methods(turn.sessionId)).not.toContain("session/prompt");
    });
  },
);

describe.each(
  providers.filter((p) => ["devin", "cursor", "fx"].includes(p.id)),
)("$id config confirmation", (provider) => {
  it("rejects a model write the provider ignored", async () => {
    const turn = input(provider);
    await provider.send(turn);
    wire.sent.length = 0;
    wire.ignoreModel = true;
    await expect(
      provider.send({ ...turn, model: `${provider.id}:different` }),
    ).rejects.toThrow(/did not apply/);
    expect(methods(turn.sessionId)).not.toContain("session/prompt");
  });
});

it("bounds Cursor's otherwise silent initialize request", async () => {
  vi.useFakeTimers();
  wire.holdInitialize = true;
  const provider = providers.find((p) => p.id === "cursor")!;
  const turn = input(provider);
  const rejected = expect(provider.send(turn)).rejects.toThrow(
    /initialize timed out/,
  );
  await until(() => methods(turn.sessionId).includes("initialize"));
  await vi.advanceTimersByTimeAsync(15_001);
  await rejected;
  expect(methods(turn.sessionId)).not.toContain("session/prompt");
});

import {
  acpAutoOption,
  acpElicitation,
  acpElicitationResult,
  acpPermissionOptionId,
  acpPermissionRequest,
} from "./acp";
import { AcpSubagents } from "./acpSubagents";
import { respondCursorQuestion } from "./cursor";

it("uses opaque permission ids according to their advertised kind", () => {
  const request = acpPermissionRequest({
    options: [
      { optionId: "choice-1", kind: "allow_once" },
      { optionId: "choice-2", kind: "reject_once" },
    ],
  });
  expect(acpAutoOption("auto", "mcp", request.optionIds, request.options)).toBe(
    "choice-1",
  );
  expect(
    acpPermissionOptionId("allow", request.optionIds, request.options),
  ).toBe("choice-1");
  expect(
    acpPermissionOptionId("deny", request.optionIds, request.options),
  ).toBe("choice-2");
});

it("preserves numeric elicitation types and rejects invalid numeric replies", () => {
  const parsed = acpElicitation({
    requestedSchema: {
      properties: {
        count: { type: "integer", minimum: 1, maximum: 10 },
        ratio: { type: "number" },
      },
    },
  })!;
  expect(
    acpElicitationResult(
      { kind: "answered", answers: {}, custom: { count: "3", ratio: "0.5" } },
      parsed.questions,
      parsed.fields,
    ),
  ).toEqual({ action: "accept", content: { count: 3, ratio: 0.5 } });
  for (const count of ["no", "2.5", "11", "Infinity"]) {
    expect(() =>
      acpElicitationResult(
        { kind: "answered", answers: {}, custom: { count } },
        parsed.questions,
        parsed.fields,
      ),
    ).toThrow(/Invalid integer/);
  }
  expect(() =>
    acpElicitation({
      requestedSchema: { properties: { complex: { type: "object" } } },
    }),
  ).toThrow(/Unsupported/);
});

it("bounds completed child routing state while preserving a recent child's steps", () => {
  const router = new AcpSubagents();
  for (let i = 0; i < 1_000; i++) {
    const parent = `parent-${i}`;
    router.route({}, [
      {
        type: "tool.updated",
        callId: parent,
        kind: "agent",
        status: "in_progress",
      },
    ]);
    router.route({ parentToolCallId: parent }, [
      { type: "tool.updated", callId: `child-${i}`, status: "completed" },
    ]);
    router.route({ parentToolCallId: parent }, [
      { type: "message.delta", text: "result" },
    ]);
    router.route({}, [
      { type: "tool.updated", callId: parent, status: "completed" },
    ]);
  }
  const retained = router as unknown as {
    tools: Set<string>;
    owners: Map<string, string>;
    prose: Map<string, unknown>;
  };
  expect(retained.tools.size).toBeLessThanOrEqual(256);
  expect(retained.owners.size).toBeLessThanOrEqual(256);
  expect(retained.prose.size).toBeLessThanOrEqual(256);
  expect(
    router.route({ parentToolCallId: "parent-999" }, [
      { type: "message.delta", text: " late" },
    ]),
  ).toContainEqual(
    expect.objectContaining({
      type: "agent.step",
      callId: "parent-999",
      text: "result late",
    }),
  );
});

it("does not silently acknowledge a typed Cursor answer it cannot transmit", async () => {
  const provider = providers.find((p) => p.id === "cursor")!;
  const events: HarnessEvent[] = [];
  const turn = input(provider, events);
  await provider.send(turn);
  wire.listeners.get(turn.sessionId)!(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 777,
      method: "cursor/ask_question",
      params: {
        questions: [
          {
            id: "q",
            prompt: "Which option?",
            allowCustom: true,
            options: [
              { id: "a", label: "A" },
              { id: "other", label: "Other" },
            ],
          },
        ],
      },
    }),
  );
  await until(() => events.some((event) => event.type === "question.asked"));
  respondCursorQuestion(turn.sessionId, 777, {
    kind: "answered",
    answers: { q: ["__custom__"] },
    custom: { q: "typed answer" },
  });
  await until(() => events.some((event) => event.type === "question.error"));
  expect(wire.sent.some((message) => message.id === 777)).toBe(false);
  expect(events.some((event) => event.type === "question.resolved")).toBe(
    false,
  );
  respondCursorQuestion(turn.sessionId, 777, {
    kind: "answered",
    answers: { q: ["a"] },
  });
  await until(() => wire.sent.some((message) => message.id === 777));
  expect(wire.sent.find((message) => message.id === 777)?.result).toEqual({
    outcome: {
      outcome: "answered",
      answers: [{ questionId: "q", selectedOptionIds: ["a"] }],
    },
  });
});

import { respondDevinQuestion } from "./devin";
import { respondCopilotQuestion } from "./copilot";

it.each(["devin", "copilot"])(
  "%s keeps invalid numeric questions open for correction",
  async (id) => {
    const provider = providers.find((p) => p.id === id)!;
    const respond =
      id === "devin" ? respondDevinQuestion : respondCopilotQuestion;
    const events: HarnessEvent[] = [];
    const turn = input(provider, events);
    await provider.send(turn);
    wire.listeners.get(turn.sessionId)!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 778,
        method: "elicitation/create",
        params: {
          requestedSchema: {
            properties: {
              count: {
                type: "integer",
                minimum: 1,
                exclusiveMaximum: 10,
                multipleOf: 2,
              },
            },
          },
        },
      }),
    );
    await until(() => events.some((event) => event.type === "question.asked"));
    for (const count of ["9007199254740993", "10", "3"]) {
      const priorErrors = events.filter(
        (event) => event.type === "question.error",
      ).length;
      respond(turn.sessionId, 778, {
        kind: "answered",
        answers: {},
        custom: { count },
      });
      await until(
        () =>
          events.filter((event) => event.type === "question.error").length >
          priorErrors,
      );
      expect(events.some((event) => event.type === "question.resolved")).toBe(
        false,
      );
      expect(wire.sent.some((message) => message.id === 778)).toBe(false);
    }
    respond(turn.sessionId, 778, {
      kind: "answered",
      answers: {},
      custom: { count: "4" },
    });
    await until(() => wire.sent.some((message) => message.id === 778));
    expect(wire.sent.find((message) => message.id === 778)?.result).toEqual({
      action: "accept",
      content: { count: 4 },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "question.resolved",
        decision: "answered",
      }),
    );
  },
);

it.each(providers)(
  "$id discards queued turns on cancel and accepts a later new turn",
  async (provider) => {
    const turn = input(provider);
    wire.holdPrompt = true;
    const first = provider.send(turn);
    await until(() => methods(turn.sessionId).includes("session/prompt"));
    const queued = provider.send({
      ...turn,
      text: "queued before cancellation",
    });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await provider.cancel(turn.sessionId);
    await Promise.all([first, queued]);
    expect(
      methods(turn.sessionId).filter((method) => method === "session/prompt"),
    ).toHaveLength(1);
    wire.holdPrompt = false;
    await provider.send({ ...turn, text: "new turn after cancellation" });
    expect(
      methods(turn.sessionId).filter((method) => method === "session/prompt"),
    ).toHaveLength(2);
  },
);

import { respondGrokQuestion } from "./grok";
import { applyHarnessEvent } from "./apply";
import { newSession } from "../session";
import { buildQuestionReply } from "../userQuestion";

const questionProviders = [
  { id: "devin", method: "elicitation/create", respond: respondDevinQuestion },
  { id: "copilot", method: "elicitation/create", respond: respondCopilotQuestion },
  { id: "cursor", method: "cursor/ask_question", respond: respondCursorQuestion },
  { id: "grok", method: "_x.ai/ask_user_question", respond: respondGrokQuestion },
];
function ask(thread: string, id: number, method: string) {
  const params = method === "elicitation/create"
    ? { requestedSchema: { type: "object", properties: { q: { type: "string", enum: ["yes", "no"] } } } }
    : { questions: [{ id: "q", prompt: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }] };
  wire.listeners.get(thread)!(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

describe.each(questionProviders)("$id overlapping questions", ({ id, method, respond }) => {
  it("presents every request in order without losing the first form", async () => {
    const provider = providers.find((p) => p.id === id)!;
    const events: HarnessEvent[] = [];
    const turn = input(provider, events);
    await provider.send(turn);
    ask(turn.sessionId, 801, method);
    ask(turn.sessionId, 802, method);
    await until(() => events.some((event) => event.type === "question.asked"));
    let session = events.reduce(applyHarnessEvent, newSession(provider.id, turn.cwd));
    expect(session.pendingQuestion?.requestId).toBe(801);
    expect(events.filter((event) => event.type === "question.asked")).toHaveLength(1);
    respond(turn.sessionId, 801, { kind: "answered", answers: { q: ["yes"] } });
    await until(() => events.filter((event) => event.type === "question.asked").length === 2);
    session = events.reduce(applyHarnessEvent, newSession(provider.id, turn.cwd));
    expect(session.pendingQuestion?.requestId).toBe(802);
    respond(turn.sessionId, 802, { kind: "answered", answers: { q: ["no"] } });
    await until(() => wire.sent.some((message) => message.id === 802));
    session = events.reduce(applyHarnessEvent, newSession(provider.id, turn.cwd));
    expect(session.pendingQuestion).toBeUndefined();
    expect(wire.sent.filter((message) => [801, 802].includes(message.id ?? 0))).toHaveLength(2);
  });

  it("cancels visible and queued requests without exposing a cancelled form on the next turn", async () => {
    const provider = providers.find((p) => p.id === id)!;
    const events: HarnessEvent[] = [];
    const turn = input(provider, events);
    wire.holdPrompt = true;
    const running = provider.send(turn);
    await until(() => methods(turn.sessionId).includes("session/prompt"));
    ask(turn.sessionId, 803, method);
    if (method === "elicitation/create") {
      // Even an unsupported queued form must be cancelled before parsing it.
      wire.listeners.get(turn.sessionId)!(JSON.stringify({ jsonrpc: "2.0", id: 804, method,
        params: { requestedSchema: { properties: { nested: { type: "object" } } } },
      }));
    } else ask(turn.sessionId, 804, method);
    await until(() => events.some((event) => event.type === "question.asked"));
    const cancelled = provider.cancel(turn.sessionId);
    wire.holdPrompt = false;
    await Promise.all([running, cancelled, provider.send({ ...turn, text: "new turn" })]);
    await until(() => wire.sent.some((message) => message.id === 804));
    expect(events.filter((event) => event.type === "question.asked")).toHaveLength(1);
    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(wire.sent.filter((message) => [803, 804].includes(message.id ?? 0))).toHaveLength(2);
  });
});

it.each([false, true])("Cursor never approves a plan automatically (cancelled=%s)", async (cancelled) => {
  const provider = providers.find((p) => p.id === "cursor")!;
  const events: HarnessEvent[] = [];
  const turn = { ...input(provider, events), intent: "plan" as const };
  wire.holdPrompt = true;
  const running = provider.send(turn);
  await until(() => methods(turn.sessionId).includes("session/prompt"));
  if (cancelled) {
    await provider.cancel(turn.sessionId);
    await running;
  }
  wire.listeners.get(turn.sessionId)!(JSON.stringify({
    jsonrpc: "2.0", id: 805, method: "cursor/create_plan",
    params: { toolCallId: "plan-tool", plan: "Change implementation" },
  }));
  await until(() => wire.sent.some((message) => message.id === 805));
  expect(wire.sent.find((message) => message.id === 805)?.result).toEqual({
    outcome: cancelled ? { outcome: "cancelled" } : {
      outcome: "rejected",
      reason: "Review the plan in MonoCode and start a Build turn to approve implementation.",
    },
  });
  expect(events.some((event) => event.type === "plan")).toBe(!cancelled);
  if (!cancelled) {
    await provider.cancel(turn.sessionId);
    await running;
  }
});

it.each(["devin", "copilot"])("%s keeps a form open when a required field is skipped", async (id) => {
  const provider = providers.find((p) => p.id === id)!;
  const respond = id === "devin" ? respondDevinQuestion : respondCopilotQuestion;
  const events: HarnessEvent[] = [];
  const turn = input(provider, events);
  await provider.send(turn);
  wire.listeners.get(turn.sessionId)!(JSON.stringify({
    jsonrpc: "2.0", id: 806, method: "elicitation/create",
    params: { requestedSchema: {
      type: "object", required: ["host", "port"],
      properties: { host: { type: "string" }, port: { type: "integer" }, note: { type: "string" } },
    } },
  }));
  await until(() => events.some((event) => event.type === "question.asked"));
  const asked = events.find((event) => event.type === "question.asked")!;
  // QuestionForm's per-field Skip submits the earlier answers through this builder.
  respond(turn.sessionId, 806, buildQuestionReply(asked.questions, {}, { host: "example.com" }));
  await until(() => events.some((event) => event.type === "question.error"));
  expect(events.some((event) => event.type === "question.resolved")).toBe(false);
  expect(wire.sent.some((message) => message.id === 806)).toBe(false);
  respond(turn.sessionId, 806, buildQuestionReply(asked.questions, {}, { host: "example.com", port: "443" }));
  await until(() => wire.sent.some((message) => message.id === 806));
  expect(wire.sent.find((message) => message.id === 806)?.result).toEqual({
    action: "accept", content: { host: "example.com", port: 443 },
  });
});

it("supports titled MCP multiselect choices and preserves their wire values", () => {
  const parsed = acpElicitation({ requestedSchema: {
    type: "object", required: ["colors"], properties: { colors: {
      type: "array", maxItems: 1, items: { anyOf: [{ const: "#FF0000", title: "Red" }, { const: "#00FF00", title: "Green" }] },
    } },
  } })!;
  expect(parsed.questions[0]).toMatchObject({ multiSelect: true, allowCustom: false, options: [
    { id: "#FF0000", label: "Red" }, { id: "#00FF00", label: "Green" },
  ] });
  expect(acpElicitationResult({ kind: "answered", answers: { colors: ["#00FF00"] } }, parsed.questions, parsed.fields))
    .toEqual({ action: "accept", content: { colors: ["#00FF00"] } });
  expect(() => acpElicitationResult({ kind: "answered", answers: { colors: ["#FF0000", "#00FF00"] } }, parsed.questions, parsed.fields))
    .toThrow(/Invalid number of selections/);
});

import { setDevinRuntimeMode } from "./devin";
import { setCopilotRuntimeMode } from "./copilot";

const modeProviders = [
  { id: "devin", auto: "smart", setMode: setDevinRuntimeMode },
  { id: "copilot", auto: "autonomous", setMode: setCopilotRuntimeMode },
];
const modeRequests = (thread: string) => wire.sent.filter((message) =>
  message.thread === thread && message.method === "session/set_mode");
function modeReply(thread: string, index: number, rejected = false) {
  const id = modeRequests(thread)[index].id;
  wire.listeners.get(thread)!(JSON.stringify({ jsonrpc: "2.0", id,
    ...(rejected ? { error: { code: -32000, message: "mode rejected" } } : { result: {} }),
  }));
}

describe.each(modeProviders)("$id latest runtime mode", ({ id, auto, setMode }) => {
  it("serializes an in-flight Auto to Supervised reversal", async () => {
    wire.modeSetup = true;
    const provider = providers.find((p) => p.id === id)!;
    const turn = input(provider);
    wire.holdPrompt = true;
    const running = provider.send(turn);
    await until(() => methods(turn.sessionId).includes("session/prompt"));
    wire.holdMode = true;
    setMode(turn.sessionId, "auto");
    await until(() => modeRequests(turn.sessionId).length === 1);
    setMode(turn.sessionId, "supervised");
    expect(modeRequests(turn.sessionId)).toHaveLength(1);
    modeReply(turn.sessionId, 0);
    await until(() => modeRequests(turn.sessionId).length === 2);
    expect(modeRequests(turn.sessionId).map((message) => message.params?.modeId)).toEqual([auto, "normal"]);
    modeReply(turn.sessionId, 1);
    await provider.cancel(turn.sessionId);
    await running;
  });

  it("waits for a preparation-time mode reversal before sending the prompt", async () => {
    wire.modeSetup = true;
    wire.holdMode = true;
    const provider = providers.find((p) => p.id === id)!;
    const turn = { ...input(provider), runtimeMode: "auto" as const };
    const running = provider.send(turn);
    await until(() => modeRequests(turn.sessionId).length === 1);
    setMode(turn.sessionId, "supervised");
    modeReply(turn.sessionId, 0);
    await until(() => modeRequests(turn.sessionId).length === 2);
    expect(methods(turn.sessionId)).not.toContain("session/prompt");
    modeReply(turn.sessionId, 1);
    await running;
    expect(modeRequests(turn.sessionId).map((message) => message.params?.modeId)).toEqual([auto, "normal"]);
  });

  it("reconciles the latest choice after an obsolete mode write fails", async () => {
    wire.modeSetup = true;
    const provider = providers.find((p) => p.id === id)!;
    const events: HarnessEvent[] = [];
    const turn = input(provider, events);
    await provider.send(turn);
    wire.holdMode = true;
    setMode(turn.sessionId, "auto");
    await until(() => modeRequests(turn.sessionId).length === 1);
    setMode(turn.sessionId, "supervised");
    modeReply(turn.sessionId, 0, true);
    await until(() => modeRequests(turn.sessionId).length === 2);
    expect(modeRequests(turn.sessionId)[1].params?.modeId).toBe("normal");
    modeReply(turn.sessionId, 1);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(events.some((event) => event.type === "session.error")).toBe(false);
  });

  it("does not cache a rejected mode and lets the same selection retry", async () => {
    wire.modeSetup = true;
    const provider = providers.find((p) => p.id === id)!;
    const events: HarnessEvent[] = [];
    const turn = input(provider, events);
    await provider.send(turn);
    wire.holdMode = true;
    setMode(turn.sessionId, "auto");
    await until(() => modeRequests(turn.sessionId).length === 1);
    modeReply(turn.sessionId, 0, true);
    await until(() => events.some((event) => event.type === "session.error"));
    setMode(turn.sessionId, "auto");
    await until(() => modeRequests(turn.sessionId).length === 2);
    expect(modeRequests(turn.sessionId).map((message) => message.params?.modeId)).toEqual([auto, auto]);
    modeReply(turn.sessionId, 1);
  });

  it.each(["cancel", "stop"] as const)("invalidates stale queued mode writes on %s before a replacement turn", async (action) => {
    wire.modeSetup = true;
    const provider = providers.find((p) => p.id === id)!;
    const events: HarnessEvent[] = [];
    const turn = input(provider, events);
    wire.holdPrompt = true;
    const running = provider.send(turn);
    await until(() => methods(turn.sessionId).includes("session/prompt"));
    wire.holdMode = true;
    setMode(turn.sessionId, "auto");
    await until(() => modeRequests(turn.sessionId).length === 1);
    setMode(turn.sessionId, "supervised");
    const oldLine = wire.listeners.get(turn.sessionId)!;
    const oldId = modeRequests(turn.sessionId)[0].id;
    await provider[action](turn.sessionId);
    await running;
    wire.holdMode = false;
    wire.holdPrompt = false;
    await provider.send({ ...turn, text: "replacement turn" });
    oldLine(JSON.stringify({ jsonrpc: "2.0", id: oldId, result: {} }));
    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(modeRequests(turn.sessionId).map((message) => message.params?.modeId))
      .toEqual(action === "cancel" ? [auto, "normal"] : [auto]);
  });
});

it.each([false, true])("Grok preserves the Build boundary and suppresses cancelled plan output (cancelled=%s)", async (cancelled) => {
  const provider = providers.find((p) => p.id === "grok")!;
  const events: HarnessEvent[] = [];
  const turn = { ...input(provider, events), intent: "plan" as const };
  wire.holdPrompt = true;
  const running = provider.send(turn);
  await until(() => methods(turn.sessionId).includes("session/prompt"));
  if (cancelled) {
    await provider.cancel(turn.sessionId);
    await running;
  }
  wire.listeners.get(turn.sessionId)!(JSON.stringify({ jsonrpc: "2.0", id: 909,
    method: "_x.ai/exit_plan_mode", params: { plan: "Proposed changes" },
  }));
  await until(() => wire.sent.some((message) => message.id === 909));
  expect(wire.sent.find((message) => message.id === 909)?.result).toEqual({ outcome: "abandoned" });
  expect(events.some((event) => event.type === "plan")).toBe(!cancelled);
  if (!cancelled) {
    await provider.cancel(turn.sessionId);
    await running;
  }
});
