import { describe, expect, it } from "vitest";
import { MuseSubagentTrails, museSubagentMeta } from "./museSubagents";
import { applyHarnessEvent } from "./apply";
import { newSession } from "../session";

const itemStarted = (item: Record<string, unknown>, cursor = "c1") => ({
  sessionId: "child",
  viewCursor: cursor,
  item,
});

describe("museSubagentMeta", () => {
  it("names the run from the agent path leaf and role", () => {
    expect(
      museSubagentMeta({
        agentPath: "/agents/code/explorer.md",
        role: "research",
      }),
    ).toEqual({ name: "Explorer", type: "research" });
    expect(museSubagentMeta({ role: "reviewer" })).toEqual({
      type: "reviewer",
    });
    expect(museSubagentMeta({})).toEqual({});
  });
});

describe("MuseSubagentTrails", () => {
  it("folds child items into agent steps without touching the parent stream", () => {
    const trails = new MuseSubagentTrails();
    trails.register("child", "call-1", {
      name: "Explorer",
      type: "research",
    });
    let session = newSession("muse", "/repo");
    const apply = (method: string, params: unknown) => {
      for (const event of trails.route("child", method, params).events) {
        session = applyHarnessEvent(session, event);
      }
    };
    session = applyHarnessEvent(session, {
      type: "tool.started",
      callId: "call-1",
      title: "Map the auth flow",
      kind: "agent",
      status: "in_progress",
    });

    apply(
      "item/started",
      itemStarted({
        itemId: "m1",
        kind: "agentMessage",
        status: "inProgress",
        revision: 1,
      }),
    );
    apply("item/delta", {
      viewCursor: "c2",
      itemId: "m1",
      field: "text",
      delta: "Reading ",
    });
    apply("item/delta", {
      viewCursor: "c3",
      itemId: "m1",
      field: "text",
      delta: "auth.ts",
    });
    apply(
      "item/started",
      itemStarted(
        {
          itemId: "t1",
          kind: "toolCall",
          tool: "read",
          args: JSON.stringify({ path: "auth.ts" }),
          status: "inProgress",
          revision: 1,
        },
        "c4",
      ),
    );
    apply(
      "item/completed",
      itemStarted(
        {
          itemId: "t1",
          kind: "toolCall",
          tool: "read",
          args: JSON.stringify({ path: "auth.ts" }),
          status: "completed",
          revision: 2,
        },
        "c5",
      ),
    );
    apply("item/delta", {
      viewCursor: "c6",
      itemId: "m1",
      field: "text",
      delta: " — done",
    });
    apply(
      "item/completed",
      itemStarted(
        {
          itemId: "m1",
          kind: "agentMessage",
          status: "completed",
          text: "Reading auth.ts — done",
          revision: 2,
        },
        "c7",
      ),
    );

    const block = session.blocks.find(
      (entry) => entry.tool?.callId === "call-1",
    )!;
    expect(block.tool?.kind).toBe("agent");
    expect(block.agentRun?.name).toBe("Explorer");
    expect(block.agentRun?.agentType).toBe("research");
    // One prose step per message item, one row per tool call.
    expect(block.agentRun?.steps).toHaveLength(2);
    expect(block.agentRun?.steps[0]).toMatchObject({
      kind: "message",
      text: "Reading auth.ts — done",
    });
    expect(block.agentRun?.steps[1]).toMatchObject({
      kind: "tool",
      toolKind: "read",
      status: "completed",
    });
    // Child activity never lands as top-level transcript blocks.
    expect(
      session.blocks.some((entry) => entry.tool?.callId === "t1"),
    ).toBe(false);
    expect(
      session.blocks.filter((entry) => entry.role === "assistant"),
    ).toHaveLength(0);
  });

  it("routes nested subagent sessions onto the same root row", () => {
    const trails = new MuseSubagentTrails();
    trails.register("child", "call-1");
    const routed = trails.route(
      "child",
      "item/started",
      itemStarted({
        itemId: "sub1",
        kind: "subagent",
        childSessionId: "grandchild",
        agentPath: "/agents/reviewer.md",
        role: "review",
        status: "inProgress",
        revision: 1,
      }),
    );
    expect(routed.follow).toEqual([
      {
        sessionId: "grandchild",
        callId: "call-1",
        meta: { name: "Reviewer", type: "review" },
      },
    ]);
    trails.register("grandchild", "call-1", { name: "Reviewer" });
    const deep = trails.route("grandchild", "item/delta", {
      viewCursor: "g1",
      itemId: "gm1",
      field: "text",
      delta: "deep work",
    });
    // Deltas need the item opened first — start it, then re-send.
    trails.route(
      "grandchild",
      "item/started",
      itemStarted(
        { itemId: "gm1", kind: "agentMessage", status: "inProgress" },
        "g0",
      ),
    );
    const again = trails.route("grandchild", "item/delta", {
      viewCursor: "g1",
      itemId: "gm1",
      field: "text",
      delta: "deep work",
    });
    expect(deep.events).toEqual([]);
    expect(again.events).toEqual([
      expect.objectContaining({
        type: "agent.step",
        callId: "call-1",
        kind: "message",
        text: "deep work",
      }),
    ]);
  });

  it("ignores unregistered sessions and caps the followed set", () => {
    const trails = new MuseSubagentTrails();
    expect(
      trails.route("unknown", "item/started", itemStarted({ itemId: "x" }))
        .events,
    ).toEqual([]);
    for (let i = 0; i < 20; i += 1) {
      trails.register(`child-${i}`, `call-${i}`);
    }
    expect(trails.get("child-15")).toBeDefined();
    expect(trails.get("child-19")).toBeUndefined();
  });
  it("bounds retained prose while a child remains followed", () => {
    const trails = new MuseSubagentTrails();
    trails.register("child", "root");
    for (let i = 0; i < 300; i++) {
      trails.route("child", "item/completed", { item: { itemId: `message-${i}`, kind: "agentMessage", text: "x".repeat(9000), status: "completed" } });
    }
    expect(trails.get("child")!.prose.size).toBe(128);
    expect(trails.get("child")!.prose.get("message-299")!.text).toHaveLength(8000);
  });

});
