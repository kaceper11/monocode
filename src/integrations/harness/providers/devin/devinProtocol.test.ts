import { describe, expect, it } from "vitest";
import {
  devinAuthError,
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
  devinModelSelectionForUid,
  devinModelsFromConfig,
  devinModelsFromOutput,
  devinPermissionOptionId,
  devinPermissionRequest,
  devinPromptBlocks,
  isDevinAuthMessage,
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
        { value: "claude-sonnet-5-low", name: "Claude Sonnet 5 Low" },
        { value: "claude-sonnet-5-high", name: "Claude Sonnet 5 High" },
        { value: "claude-sonnet-5-max", name: "Claude Sonnet 5 Max" },
        { value: "swe-2-high", name: "SWE-2 High" },
        { value: "swe-2-medium", name: "SWE-2 Medium" },
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
    expect(devinModeId("full-access", false, ["smart", "plan"])).toBeUndefined();
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
  it("groups the model select into one row per model with a reasoning setting", () => {
    const options = devinConfigOptions(SESSION_NEW.configOptions);
    expect(options).toHaveLength(2);
    expect(devinCurrentModelId(options)).toBe("claude-sonnet-5-medium");
    const models = devinModelsFromConfig(options);
    expect(models).toEqual([
      {
        id: "devin:claude-sonnet-5",
        harness: "devin",
        name: "Claude Sonnet 5",
        nativeId: "claude-sonnet-5-medium",
        contextWindow: 1_000_000,
        settings: [
          {
            id: "reasoning",
            label: "Reasoning",
            kind: "select",
            value: "claude-sonnet-5-medium",
            options: [
              { value: "claude-sonnet-5-low", label: "Low" },
              { value: "claude-sonnet-5-medium", label: "Medium" },
              { value: "claude-sonnet-5-high", label: "High" },
              { value: "claude-sonnet-5-max", label: "Max" },
            ],
          },
        ],
      },
      {
        id: "devin:swe-2",
        harness: "devin",
        name: "SWE-2",
        nativeId: "swe-2-high",
        settings: [
          {
            id: "reasoning",
            label: "Reasoning",
            kind: "select",
            value: "swe-2-high",
            options: [
              { value: "swe-2-medium", label: "Medium" },
              { value: "swe-2-high", label: "High" },
            ],
          },
        ],
      },
    ]);
  });

  it("keeps speed, context and sidekick combinations as separate models", () => {
    const models = devinModelsFromConfig(
      devinConfigOptions([
        {
          id: "model",
          type: "select",
          options: [
            { value: "claude-opus-5-low", name: "Claude Opus 5 Low" },
            { value: "claude-opus-5-high", name: "Claude Opus 5 High" },
            { value: "claude-opus-5-low-fast", name: "Claude Opus 5 Low Fast" },
            {
              value: "claude-opus-5-high-fast",
              name: "Claude Opus 5 High Fast",
            },
            { value: "glm-5-2", name: "GLM-5.2 High" },
            { value: "glm-5-2-none-1m", name: "GLM-5.2 No Thinking 1M" },
            {
              value: "fusion-a-high-sidekick-b-medium",
              name: "Fusion (Claude Fable 5.1 High + SWE-2 Medium)",
            },
            {
              value: "fusion-a-low-sidekick-b-medium",
              name: "Fusion (Claude Fable 5.1 Low + SWE-2 Medium)",
            },
          ],
        },
      ]),
    );
    expect(models.map((model) => model.name)).toEqual([
      "Claude Opus 5",
      "Claude Opus 5 Fast",
      "GLM-5.2",
      "GLM-5.2 1M",
      "Fusion (Claude Fable 5.1 + SWE-2 Medium)",
    ]);
    // A label like "GLM-5.2 High" still exposes the level even when the uid
    // itself carries no level suffix.
    expect(models[2]!.nativeId).toBe("glm-5-2");
    const fusion = models[4]!;
    const reasoning = fusion.settings?.find(
      (setting) => setting.id === "reasoning",
    );
    expect(reasoning?.options).toEqual([
      { value: "fusion-a-low-sidekick-b-medium", label: "Low" },
      { value: "fusion-a-high-sidekick-b-medium", label: "High" },
    ]);
  });

  it("maps a reported model uid back to its group and reasoning value", () => {
    const options = devinConfigOptions(SESSION_NEW.configOptions);
    expect(devinModelSelectionForUid(options, "claude-sonnet-5-max")).toEqual({
      id: "devin:claude-sonnet-5",
      reasoning: "claude-sonnet-5-max",
    });
    expect(
      devinModelSelectionForUid(options, "claude-sonnet-5-medium"),
    ).toEqual({ id: "devin:claude-sonnet-5", reasoning: "claude-sonnet-5-medium" });
    expect(devinModelSelectionForUid(options, "unknown-uid")).toEqual({
      id: "devin:unknown-uid",
    });
  });

  it("keeps 'X Thinking' variants selectable alongside 'X' labels", () => {
    const models = devinModelsFromConfig(
      devinConfigOptions([
        {
          id: "model",
          type: "select",
          options: [
            { value: "sol-high", name: "Sol High" },
            { value: "sol-high-thinking", name: "Sol High Thinking" },
            { value: "sol-max", name: "Sol Max Thinking" },
          ],
        },
      ]),
    );
    // "Sol High" and "Sol High Thinking" collapse to the same level word —
    // both uids stay selectable with a disambiguated label, and "Max
    // Thinking" folds into the Sol group as Max.
    expect(models).toHaveLength(1);
    const reasoning = models[0]!.settings?.find(
      (setting) => setting.id === "reasoning",
    );
    expect(reasoning?.options).toEqual([
      { value: "sol-high", label: "High (sol-high)" },
      { value: "sol-high-thinking", label: "High (sol-high-thinking)" },
      { value: "sol-max", label: "Max" },
    ]);
  });

  it("parses spelled-out and lowercase level words, and falls back to the uid", () => {
    const models = devinModelsFromConfig(
      devinConfigOptions([
        {
          id: "model",
          type: "select",
          options: [
            { value: "a-xhigh", name: "Model A Extra High" },
            { value: "a-low", name: "model a low" },
            // Labels without a level word — the uid suffix carries it.
            { value: "b-medium", name: "Second choice" },
            { value: "b-high", name: "First choice" },
          ],
        },
      ]),
    );
    const a = models.find((model) => model.id === "devin:model-a");
    expect(
      a?.settings?.find((setting) => setting.id === "reasoning")?.options,
    ).toEqual([
      { value: "a-low", label: "Low" },
      { value: "a-xhigh", label: "Extra High" },
    ]);
    // With no level word in either label, both uids still group under the
    // uid-derived descriptor.
    const b = models.find((model) => model.name === "b");
    expect(
      b?.settings?.find((setting) => setting.id === "reasoning")?.options,
    ).toEqual([
      { value: "b-medium", label: "Medium" },
      { value: "b-high", label: "High" },
    ]);
  });

  it("keeps grouped reasoning options past the raw choice cap", () => {
    // More raw choices than the old pre-group cap — truncating before
    // grouping would drop the Tail family entirely.
    const options = Array.from({ length: 300 }, (_, index) => ({
      value: `filler-${index}-high`,
      name: "Filler High",
    }));
    options.push(
      { value: "tail-low", name: "Tail Low" },
      { value: "tail-max", name: "Tail Max" },
    );
    const models = devinModelsFromConfig(
      devinConfigOptions([{ id: "model", type: "select", options }]),
    );
    const tail = models.find((model) => model.name === "Tail");
    expect(
      tail?.settings?.find((setting) => setting.id === "reasoning")?.options,
    ).toEqual([
      { value: "tail-low", label: "Low" },
      { value: "tail-max", label: "Max" },
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
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "devin:claude-opus-5",
      name: "Claude Opus 5",
      nativeId: "claude-opus-5-medium",
      contextWindow: 1_000_000,
    });
    expect(
      models[0].settings?.find((setting) => setting.id === "reasoning")
        ?.options,
    ).toEqual([
      { value: "claude-opus-5-low", label: "Low" },
      { value: "claude-opus-5-medium", label: "Medium" },
    ]);
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

describe("isDevinAuthMessage", () => {
  it("ignores routine stderr logs mentioning login-shell env snapshots", () => {
    expect(
      isDevinAuthMessage(
        "2026-09-11T21:12:24.021390Z  INFO toolbox::tools::exec::login_shell_env: var_count=90 captured login-shell env snapshot from '/bin/zsh'",
      ),
    ).toBe(false);
    expect(isDevinAuthMessage("INFO spawned devin acp")).toBe(false);
    expect(isDevinAuthMessage("authorizing local port")).toBe(false);
  });

  it("matches real sign-in failures", () => {
    expect(isDevinAuthMessage("Error: not signed in")).toBe(true);
    expect(isDevinAuthMessage("You are not authenticated")).toBe(true);
    expect(isDevinAuthMessage("authentication required")).toBe(true);
    expect(isDevinAuthMessage("401 Unauthorized")).toBe(true);
    expect(isDevinAuthMessage("please run `devin auth login`")).toBe(true);
    expect(isDevinAuthMessage("Please log in to continue")).toBe(true);
    // Reversed phrasing and logged-out states count too.
    expect(isDevinAuthMessage("token expired")).toBe(true);
    expect(isDevinAuthMessage("session has expired")).toBe(true);
    expect(isDevinAuthMessage("credentials have expired")).toBe(true);
    expect(isDevinAuthMessage("signed out — sign in again")).toBe(true);
  });

  it("ignores unrelated permission and service errors", () => {
    expect(isDevinAuthMessage("permission denied: /etc/shadow")).toBe(false);
    expect(isDevinAuthMessage("rm: cannot remove: Permission denied")).toBe(
      false,
    );
    expect(isDevinAuthMessage("sandbox forbidden syscall")).toBe(false);
    expect(isDevinAuthMessage("upstream 403 on artifact upload")).toBe(false);
    expect(isDevinAuthMessage("request denied by sandbox policy")).toBe(false);
  });

  it("devinAuthError appends the auth hint for auth failures and timeouts", () => {
    expect(
      devinAuthError(new Error("session/new timed out")).message,
    ).toContain("devin auth login");
    expect(devinAuthError(new Error("spawn failed")).message).toBe(
      "Devin did not start. spawn failed",
    );
    expect(devinAuthError(new Error("401 Unauthorized")).message).toContain(
      "devin auth login",
    );
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
