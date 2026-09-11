import { describe, expect, it } from "vitest";
import {
  devinAutoOption,
  devinCommandsFromUpdate,
  devinConfigOptions,
  devinCurrentModelId,
  devinElicitation,
  devinElicitationResult,
  devinEventsFromUpdate,
  devinModeId,
  devinModeIdsFromConfig,
  devinModesFromSetup,
  devinModelsFromConfig,
  devinModelsFromOutput,
  devinPermissionOptionId,
  devinPermissionRequest,
  devinPromptBlocks,
  sessionIdFromResult,
} from "./devinProtocol";

const DEVIN_MODES = ["accept-edits", "smart", "ask", "plan", "bypass"];

const SESSION_NEW = {
  sessionId: "sess-1",
  modes: {
    currentModeId: "accept-edits",
    availableModes: DEVIN_MODES.map((id) => ({ id, name: id })),
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "claude-sonnet-5-medium",
      options: [
        {
          value: "claude-sonnet-5-medium",
          name: "Claude Sonnet 5 Medium",
          _meta: { "cognition.ai/contextWindow": 1_000_000 },
        },
        { value: "swe-2-high", name: "SWE 2 High" },
      ],
    },
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "accept-edits",
      options: DEVIN_MODES.map((id) => ({ value: id, name: id })),
    },
  ],
};

describe("devinModeId", () => {
  it("maps MonoCode runtime modes onto advertised Devin modes only", () => {
    expect(devinModeId("supervised", false, DEVIN_MODES)).toBe("accept-edits");
    expect(devinModeId("auto-accept-edits", false, DEVIN_MODES)).toBe(
      "accept-edits",
    );
    expect(devinModeId("auto", false, DEVIN_MODES)).toBe("smart");
    expect(devinModeId("full-access", false, DEVIN_MODES)).toBe("bypass");
    expect(devinModeId("supervised", true, DEVIN_MODES)).toBe("plan");
    expect(devinModeId("full-access", true, DEVIN_MODES)).toBe("plan");
  });

  it("returns undefined when nothing suitable is advertised", () => {
    expect(devinModeId("full-access", false, ["accept-edits"])).toBeUndefined();
    expect(devinModeId("auto", false, ["accept-edits", "ask"])).toBeUndefined();
    expect(devinModeId("supervised", false, ["bypass"])).toBeUndefined();
    expect(devinModeId("auto", false, [])).toBeUndefined();
  });

  it("prefers a real supervised mode when Devin advertises one", () => {
    expect(
      devinModeId("supervised", false, ["normal", "accept-edits"]),
    ).toBe("normal");
  });
});

describe("devinConfigOptions + models", () => {
  it("reads the dynamic model select from session/new configOptions", () => {
    const options = devinConfigOptions(SESSION_NEW.configOptions);
    expect(options).toHaveLength(2);
    expect(devinCurrentModelId(options)).toBe("claude-sonnet-5-medium");
    const models = devinModelsFromConfig(options);
    expect(models).toEqual([
      {
        id: "devin:claude-sonnet-5-medium",
        harness: "devin",
        name: "Claude Sonnet 5 Medium",
        nativeId: "claude-sonnet-5-medium",
        contextWindow: 1_000_000,
      },
      {
        id: "devin:swe-2-high",
        harness: "devin",
        name: "SWE 2 High",
        nativeId: "swe-2-high",
      },
    ]);
  });

  it("reads modes from the setup modes block and the mode config option", () => {
    expect(devinModesFromSetup(SESSION_NEW)).toEqual({
      currentModeId: "accept-edits",
      availableModeIds: DEVIN_MODES,
    });
    expect(devinModeIdsFromConfig(devinConfigOptions(SESSION_NEW.configOptions))).toEqual(
      DEVIN_MODES,
    );
  });

  it("parses `devin models list --format json` output", () => {
    const models = devinModelsFromOutput(
      JSON.stringify({
        families: [
          {
            family_label: "Claude Opus 5",
            family_uid: "claude-opus-5",
            slug: "claude-opus-5",
            aliases: ["opus"],
            variants: [
              {
                model_uid: "claude-opus-5-medium",
                label: "Claude Opus 5 Medium",
                max_context_tokens: 1_000_000,
              },
              { model_uid: "claude-opus-5-low", label: "Claude Opus 5 Low" },
            ],
          },
        ],
      }),
    );
    expect(models.map((m) => m.nativeId)).toEqual([
      "claude-opus-5",
      "claude-opus-5-medium",
      "claude-opus-5-low",
    ]);
    expect(models[1].contextWindow).toBe(1_000_000);
    expect(models[1].id).toBe("devin:claude-opus-5-medium");
  });

  it("returns no models from junk output", () => {
    expect(devinModelsFromOutput("not json")).toEqual([]);
    expect(devinModelsFromOutput("{}")).toEqual([]);
  });
});

describe("devinEventsFromUpdate", () => {
  const wrap = (update: unknown) => ({ sessionId: "S1", update });

  it("maps agent message chunks to message deltas", () => {
    expect(
      devinEventsFromUpdate(
        wrap({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        }),
      ),
    ).toEqual([{ type: "message.delta", text: "hello" }]);
  });

  it("maps thought chunks to reasoning deltas", () => {
    expect(
      devinEventsFromUpdate(
        wrap({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        }),
      ),
    ).toEqual([{ type: "reasoning.delta", text: "thinking" }]);
  });

  it("maps a shell tool_call with cognition preview metadata", () => {
    const events = devinEventsFromUpdate(
      wrap({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Ran echo",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "echo hi" },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool.updated",
      callId: "call_1",
      kind: "execute",
      status: "in_progress",
    });
    expect(events[0].title).toContain("echo hi");
  });

  it("maps tool_call_update content to tool detail", () => {
    const events = devinEventsFromUpdate(
      wrap({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "hi" } }],
      }),
    );
    expect(events[0]).toMatchObject({
      type: "tool.updated",
      callId: "call_1",
      status: "completed",
      detail: "hi",
    });
  });

  it("maps plan entries to a task list", () => {
    expect(
      devinEventsFromUpdate(
        wrap({
          sessionUpdate: "plan",
          entries: [
            { content: "inspect", status: "in_progress" },
            { content: "edit", status: "pending" },
          ],
        }),
      ),
    ).toEqual([
      {
        type: "tasks.updated",
        items: [
          { text: "inspect", status: "in_progress" },
          { text: "edit", status: "pending" },
        ],
      },
    ]);
  });

  it("maps usage_update to a context event", () => {
    expect(
      devinEventsFromUpdate(
        wrap({ sessionUpdate: "usage_update", used: 1200, size: 128_000 }),
      ),
    ).toEqual([{ type: "context", used: 1200, window: 128_000 }]);
  });

  it("ignores user echoes and session_info updates", () => {
    expect(
      devinEventsFromUpdate(
        wrap({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "hi" },
        }),
      ),
    ).toEqual([]);
    expect(
      devinEventsFromUpdate(
        wrap({ sessionUpdate: "session_info_update", title: "t" }),
      ),
    ).toEqual([]);
  });
});

describe("devinCommandsFromUpdate", () => {
  it("reads available commands with input hints and reserved-name escapes", () => {
    const commands = devinCommandsFromUpdate({
      sessionId: "S1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "status", description: "Show session statistics" },
          {
            name: "plan",
            description: "Switch to Plan mode",
            input: { hint: "[prompt]" },
          },
        ],
      },
    });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      name: "status",
      invocation: "status",
      source: "devin",
    });
    // `plan` collides with a reserved MonoCode command name.
    expect(commands[1]).toMatchObject({
      name: "plan",
      invocation: "devin:plan",
      inputHint: "[prompt]",
    });
  });
});

describe("devin permission handling", () => {
  const params = {
    sessionId: "S1",
    toolCall: {
      toolCallId: "call_9",
      title: "Ran rm -rf build",
      kind: "execute",
      status: "pending",
      rawInput: { command: "rm -rf build" },
    },
    options: [
      { optionId: "allow_once", name: "Allow once" },
      { optionId: "allow_always", name: "Always allow" },
      { optionId: "reject_once", name: "Reject" },
    ],
  };

  it("extracts title, kind, callId and option ids", () => {
    const request = devinPermissionRequest(params);
    expect(request.callId).toBe("call_9");
    expect(request.kind).toBe("execute");
    expect(request.optionIds).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ]);
    expect(request.title).toContain("rm -rf build");
  });

  it("supervised and auto-accept-edits leave execute prompts to the user", () => {
    expect(
      devinAutoOption("supervised", "execute", params.options.map((o) => o.optionId)),
    ).toBeNull();
    expect(
      devinAutoOption(
        "auto-accept-edits",
        "execute",
        params.options.map((o) => o.optionId),
      ),
    ).toBeNull();
    expect(
      devinAutoOption(
        "auto-accept-edits",
        "edit",
        params.options.map((o) => o.optionId),
      ),
    ).toBe("allow_once");
  });

  it("auto allows once, full-access prefers allow-always", () => {
    const ids = params.options.map((o) => o.optionId);
    expect(devinAutoOption("auto", "execute", ids)).toBe("allow_once");
    expect(devinAutoOption("full-access", "execute", ids)).toBe("allow_always");
  });

  it("maps allow/deny decisions onto the offered option ids", () => {
    const ids = params.options.map((o) => o.optionId);
    expect(devinPermissionOptionId("allow", ids)).toBe("allow_once");
    expect(devinPermissionOptionId("deny", ids)).toBe("reject_once");
  });
});

describe("devin elicitation", () => {
  const params = {
    message: "Pick a target",
    requestedSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: {
          type: "string",
          title: "Deploy target",
          enum: ["staging", "prod"],
          enumNames: ["Staging", "Production"],
        },
        confirmed: { type: "boolean", title: "Proceed?" },
        notes: { type: "string", title: "Notes" },
      },
    },
  };

  it("maps schema properties to UserQuestions with wire values", () => {
    const parsed = devinElicitation(params);
    expect(parsed?.title).toBe("Pick a target");
    expect(parsed?.questions.map((q) => q.id)).toEqual([
      "target",
      "confirmed",
      "notes",
    ]);
    const [target, confirmed, notes] = parsed!.questions;
    expect(target.options.map((o) => o.label)).toEqual([
      "Staging",
      "Production",
    ]);
    expect(target.allowCustom).toBe(false);
    expect(confirmed.options.map((o) => o.id)).toEqual(["yes", "no"]);
    expect(notes.allowCustom).toBe(true);
    expect(parsed?.fields[0].values).toEqual({
      staging: "staging",
      prod: "prod",
    });
    expect(parsed?.fields[1].values).toEqual({ yes: true, no: false });
  });

  it("builds an accept result carrying schema values", () => {
    const parsed = devinElicitation(params)!;
    const result = devinElicitationResult(
      {
        kind: "answered",
        answers: { target: ["prod"], confirmed: ["yes"] },
        custom: { notes: "hotfix" },
      },
      parsed.questions,
      parsed.fields,
    );
    expect(result).toEqual({
      action: "accept",
      content: { target: "prod", confirmed: true, notes: "hotfix" },
    });
  });

  it("cancels when the user skips", () => {
    const parsed = devinElicitation(params)!;
    expect(
      devinElicitationResult(
        { kind: "skipped" },
        parsed.questions,
        parsed.fields,
      ),
    ).toEqual({ action: "cancel" });
  });
});

describe("misc", () => {
  it("reads the session id from camelCase and snake_case results", () => {
    expect(sessionIdFromResult({ sessionId: "a" })).toBe("a");
    expect(sessionIdFromResult({ session_id: "b" })).toBe("b");
    expect(sessionIdFromResult({})).toBeUndefined();
  });

  it("builds prompt blocks with text and image attachments", () => {
    const blocks = devinPromptBlocks("hi", [
      {
        id: "1",
        name: "a.png",
        mimeType: "image/png",
        kind: "image",
        data: "aGk=",
      } as never,
    ]);
    expect(blocks[0]).toEqual({ type: "text", text: "hi" });
    expect(blocks[1]).toMatchObject({ type: "image", data: "aGk=" });
  });
});
