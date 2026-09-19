import { describe, expect, it } from "vitest";
import { AcpSubagents } from "./acpSubagents";
import { acpEventsFromUpdate } from "./acpProtocol";
import { eventsFromAcpUpdate as fxEvents } from "./fxProtocol";
import { eventsFromAcpUpdate as grokEvents } from "./grokProtocol";
import { applyHarnessEvent } from "./apply";
import { newSession } from "../session";
import type { HarnessEvent } from "./types";

describe.each([
  ["fx", fxEvents],
  ["grok", grokEvents],
] as const)("%s subagents", (provider, parse) => {
  it("names delegated work and merges child tool updates without leaking prose", () => {
    const router = new AcpSubagents();
    let session = newSession(provider, "/repo");
    const push = (update: Record<string, unknown>) => {
      const params = { sessionId: "parent", update };
      for (const event of router.route(params, parse(params)))
        session = applyHarnessEvent(session, event);
    };
    push({
      sessionUpdate: "tool_call",
      toolCallId: "spawn",
      kind: "other",
      title: "Task",
      status: "in_progress",
      rawInput: {
        _toolName: "task",
        description: "Check auth",
        model: "review-model",
      },
    });
    const meta = { parentToolCallId: "spawn" };
    push({
      sessionUpdate: "agent_message_chunk",
      _meta: meta,
      content: { type: "text", text: "Checking " },
    });
    push({
      sessionUpdate: "agent_message_chunk",
      _meta: meta,
      content: { type: "text", text: "auth." },
    });
    push({
      sessionUpdate: "tool_call",
      _meta: meta,
      toolCallId: "read",
      kind: "read",
      title: "Read auth.ts",
      status: "in_progress",
    });
    // Sparse completions may omit the parent metadata entirely.
    push({
      sessionUpdate: "tool_call_update",
      toolCallId: "read",
      status: "completed",
    });
    push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Parent answer" },
    });
    const block = session.blocks.find(
      (entry) => entry.tool?.callId === "spawn",
    )!;
    expect(block.tool?.kind).toBe("agent");
    expect(block.agentRun?.model).toBe("review-model");
    expect(block.text).toBe("Check auth");
    expect(block.agentRun?.steps).toHaveLength(2);
    expect(block.agentRun?.steps[0].text).toBe("Checking auth.");
    expect(block.agentRun?.steps[1].status).toBe("completed");
    expect(
      session.blocks
        .filter((entry) => entry.role === "assistant")
        .map((entry) => entry.text),
    ).toEqual(["Parent answer"]);
    expect(session.blocks.some((entry) => entry.tool?.callId === "read")).toBe(
      false,
    );
  });
});

describe("ACP child routing", () => {
  it("buffers children until the matching row exists, even with simultaneous spawns", () => {
    const router = new AcpSubagents();
    const child = (id: string, text: string): HarnessEvent[] =>
      router.route(
        { update: { _meta: { cursor: { parentToolCallId: id } } } },
        [{ type: "message.delta", text }],
      );
    expect(child("b", "Second child")).toEqual([]);
    expect(child("a", "First child")).toEqual([]);
    const start = (callId: string) =>
      router.route({}, [
        { type: "tool.updated", callId, kind: "agent", title: callId },
      ]);
    expect(start("a")).toEqual([
      expect.objectContaining({ callId: "a", type: "tool.updated" }),
      expect.objectContaining({
        callId: "a",
        type: "agent.step",
        text: "First child",
      }),
    ]);
    expect(start("b")[1]).toMatchObject({ callId: "b", text: "Second child" });
  });

  it("keeps nested work on its ancestor and suppresses child context and completion", () => {
    const router = new AcpSubagents();
    router.route({}, [
      { type: "tool.started", callId: "root", title: "Explore", kind: "agent" },
    ]);
    router.route({ parentToolCallId: "root" }, [
      { type: "tool.started", callId: "nested", title: "Task", kind: "agent" },
    ]);
    const params = { parentToolCallId: "nested" };
    expect(
      router.route(params, [
        { type: "message.delta", text: "Nested answer" },
      ])[0],
    ).toMatchObject({ type: "agent.step", callId: "root" });
    expect(
      router.route(params, [
        { type: "context", used: 999 },
        { type: "message.completed" },
        { type: "session.ended" },
      ]),
    ).toEqual([]);
  });

  it("replaces whole prose snapshots and starts a new step after tools", () => {
    const router = new AcpSubagents();
    router.route({}, [{ type: "tool.started", callId: "a", title: "Explore" }]);
    const params = {
      update: { sessionUpdate: "agent_message", parentToolCallId: "a" },
    };
    const first = router.route(params, [
      { type: "message.delta", text: "Hello" },
    ])[0];
    const repeated = router.route(params, [
      { type: "message.delta", text: "Hello again" },
    ])[0];
    expect(repeated).toMatchObject({ ...first, text: "Hello again" });
    router.route(params, [
      { type: "tool.started", callId: "t", title: "Read" },
    ]);
    expect(
      router.route(params, [{ type: "message.delta", text: "Done" }])[0],
    ).not.toMatchObject({ stepId: (first as { stepId: string }).stepId });
  });

  it("links Devin child updates through subagent_started run ids", () => {
    const router = new AcpSubagents();
    let session = newSession("devin", "/repo");
    const push = (update: Record<string, unknown>) => {
      const params = { sessionId: "parent", update };
      for (const event of router.route(params, acpEventsFromUpdate(params))) {
        session = applyHarnessEvent(session, event);
      }
    };
    // The run_subagent call names the run it created; the update itself is
    // not marked as a child.
    push({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      kind: "other",
      title: "run_subagent",
      status: "in_progress",
      _meta: {
        "cognition.ai/subagent_started": {
          agentId: "agent-7",
          runId: "run-9",
          task: "Review the diff",
          profile: "reviewer",
          model: "devin-review",
        },
      },
      rawInput: { _toolName: "run_subagent", task: "Review the diff" },
    });
    const ctx = {
      "cognition.ai/subagent_context": {
        parentAgentId: "agent-7",
        runId: "run-9",
      },
    };
    push({
      sessionUpdate: "agent_message_chunk",
      _meta: ctx,
      content: { type: "text", text: "Scanning " },
    });
    push({
      sessionUpdate: "agent_message_chunk",
      _meta: ctx,
      content: { type: "text", text: "diff hunks." },
    });
    push({
      sessionUpdate: "tool_call",
      _meta: ctx,
      toolCallId: "read-1",
      kind: "read",
      title: "Read auth.ts",
      status: "in_progress",
    });
    push({
      sessionUpdate: "tool_call_update",
      _meta: ctx,
      toolCallId: "read-1",
      status: "completed",
    });
    push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Parent answer" },
    });

    const block = session.blocks.find(
      (entry) => entry.tool?.callId === "call-1",
    )!;
    expect(block.tool?.kind).toBe("agent");
    expect(block.text).toBe("Review the diff");
    expect(block.agentRun?.model).toBe("devin-review");
    expect(block.agentRun?.steps).toHaveLength(2);
    expect(block.agentRun?.steps[0].text).toBe("Scanning diff hunks.");
    expect(block.agentRun?.steps[1]).toMatchObject({
      kind: "tool",
      status: "completed",
    });
    expect(
      session.blocks.some((entry) => entry.tool?.callId === "read-1"),
    ).toBe(false);
    expect(
      session.blocks
        .filter((entry) => entry.role === "assistant")
        .map((entry) => entry.text),
    ).toEqual(["Parent answer"]);
  });

  it("resolves flat subagent/agent_id attributes and copilot meta parents", () => {
    const router = new AcpSubagents();
    router.route(
      {
        update: {
          sessionUpdate: "tool_call",
          _meta: { "subagent/agent_id": "agent-8" },
        },
      },
      [
        {
          type: "tool.started",
          callId: "call-2",
          title: "Spawn",
          kind: "agent",
        },
      ],
    );
    expect(
      router.route(
        { update: { _meta: { "subagent/agent_id": "agent-8" } } },
        [{ type: "message.delta", text: "attribute link" }],
      ),
    ).toEqual([
      expect.objectContaining({
        type: "agent.step",
        callId: "call-2",
        text: "attribute link",
      }),
    ]);

    router.route({}, [
      {
        type: "tool.started",
        callId: "call-3",
        title: "Delegate",
        kind: "agent",
      },
    ]);
    expect(
      router.route(
        { update: { _meta: { copilot: { parentToolCallId: "call-3" } } } },
        [{ type: "message.delta", text: "copilot child" }],
      ),
    ).toEqual([
      expect.objectContaining({
        type: "agent.step",
        callId: "call-3",
        text: "copilot child",
      }),
    ]);
  });
});
