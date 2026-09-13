import { describe, expect, it } from "vitest";
import { newSession } from "./session";
import type { SessionSummary } from "./sessionStore";
import {
  conversationRowsFrom,
  flattenGrouped,
  groupHits,
  hitsFromContentMatches,
  hitsFromSessionSearch,
  mergeHits,
  searchConversationTitles,
  searchRecentProjects,
  searchSessionMessages,
  searchTasks,
  snippetAround,
  type AppSearchHit,
} from "./appSearch";
import type { TaskWorkspace } from "./taskWorkspaces";

function summary(
  id: string,
  cwd: string,
  title: string,
  updatedAt = 1,
): SessionSummary {
  return {
    id,
    cwd,
    harness: "cursor",
    model: "gpt-5",
    runtimeMode: "supervised",
    title,
    createdAt: updatedAt,
    updatedAt,
    additions: 0,
    deletions: 0,
  };
}

describe("snippetAround", () => {
  it("keeps a short string", () => {
    expect(snippetAround("hello world", "hello")).toBe("hello world");
  });

  it("trims around a later match", () => {
    const text = `${"alpha ".repeat(20)}sidebar chips ${"omega ".repeat(20)}`;
    const snippet = snippetAround(text, "sidebar");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet).toContain("sidebar chips");
  });
});

describe("searchConversationTitles", () => {
  it("fuzzy-matches display titles", () => {
    const hits = searchConversationTitles(
      [
        {
          id: "s1",
          cwd: "/tmp/a",
          harness: "cursor",
          title: "cursor · Fix sidebar search",
          updatedAt: 10,
        },
        {
          id: "s2",
          cwd: "/tmp/a",
          harness: "cursor",
          title: "cursor · Unrelated",
          updatedAt: 11,
        },
      ],
      "side srch",
    );
    expect(hits.map((hit) => hit.sessionId)).toEqual(["s1"]);
    expect(hits[0]?.title).toBe("Fix sidebar search");
  });
});

describe("searchSessionMessages", () => {
  it("finds matching user and assistant text", () => {
    const session = newSession("cursor", "/tmp/a");
    session.blocks = [
      { id: "u1", role: "user", text: "Please search the sidebar filter chips" },
      { id: "a1", role: "assistant", text: "Opening the explorer next." },
      { id: "r1", role: "reasoning", text: "sidebar internals" },
    ];
    const hits = searchSessionMessages(
      [
        {
          id: session.id,
          cwd: session.cwd,
          harness: session.harness,
          title: session.title,
          updatedAt: 1,
          blocks: session.blocks,
        },
      ],
      "sidebar",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.blockId).toBe("u1");
    expect(hits[0]?.preview.toLowerCase()).toContain("sidebar");
  });
});

describe("searchRecentProjects", () => {
  it("matches project folder names", () => {
    const hits = searchRecentProjects(
      [
        { path: "/Users/me/code/agent-terminal", openedAt: 2 },
        { path: "/Users/me/code/other", openedAt: 1 },
      ],
      "agent term",
    );
    expect(hits.map((hit) => hit.name)).toEqual(["agent-terminal"]);
  });
});

describe("merge and group", () => {
  it("dedupes by id and keeps the higher score", () => {
    const low: AppSearchHit = {
      id: "conversation:s1",
      kind: "conversation",
      sessionId: "s1",
      cwd: "/tmp/a",
      harness: "cursor",
      title: "One",
      updatedAt: 1,
      score: 4,
      positions: [],
    };
    const high = { ...low, score: 20, title: "Better" };
    const merged = mergeHits([low], [high]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ title: "Better", score: 20 });
  });

  it("limits each section for the all scope", () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      id: `file:${index}`,
      kind: "file" as const,
      path: `/tmp/a/${index}.ts`,
      relative: `${index}.ts`,
      name: `${index}.ts`,
      score: 10,
      positions: [],
    }));
    const grouped = groupHits(files, "all");
    expect(grouped.files).toHaveLength(10);
    expect(flattenGrouped(grouped)).toHaveLength(10);
  });

  it("hides non-file hits in the files scope", () => {
    const grouped = groupHits(
      [
        {
          id: "project:/tmp/a",
          kind: "project",
          path: "/tmp/a",
          name: "a",
          score: 10,
          positions: [],
        },
        {
          id: "file:1",
          kind: "file",
          path: "/tmp/a/one.ts",
          relative: "one.ts",
          name: "one.ts",
          score: 8,
          positions: [],
        },
      ],
      "files",
    );
    expect(grouped.projects).toHaveLength(0);
    expect(grouped.files).toHaveLength(1);
  });
});

describe("hitsFromSessionSearch", () => {
  it("normalizes harness titles", () => {
    const hits = hitsFromSessionSearch([
      {
        kind: "conversation",
        sessionId: "s1",
        cwd: "/tmp/a",
        harness: "cursor",
        title: "cursor · Fix search",
        updatedAt: 1,
        preview: "",
      },
      {
        kind: "message",
        sessionId: "s1",
        cwd: "/tmp/a",
        harness: "cursor",
        title: "cursor · Fix search",
        updatedAt: 1,
        blockId: "u1",
        role: "user",
        preview: "search chips",
      },
    ]);
    expect(hits[0]).toMatchObject({
      kind: "conversation",
      title: "Fix search",
    });
    expect(hits[1]).toMatchObject({
      kind: "message",
      blockId: "u1",
      preview: "search chips",
    });
  });
});

describe("hitsFromContentMatches", () => {
  it("keeps line and preview", () => {
    const hits = hitsFromContentMatches([
      {
        path: "/tmp/a/App.tsx",
        relative: "src/App.tsx",
        line: 12,
        column: 4,
        preview: "const searchOpen = true;",
      },
    ]);
    expect(hits[0]).toMatchObject({
      kind: "content",
      name: "App.tsx",
      line: 12,
      preview: "const searchOpen = true;",
    });
  });
});

describe("conversationRowsFrom", () => {
  it("prefers live session titles over history", () => {
    const live = newSession("cursor", "/tmp/a");
    live.id = "s1";
    live.title = "cursor · Live title";
    const rows = conversationRowsFrom(
      [summary("s1", "/tmp/a", "cursor · Old title", 5)],
      [live],
    );
    expect(rows).toEqual([
      expect.objectContaining({ id: "s1", title: "cursor · Live title" }),
    ]);
  });
});

describe("searchTasks", () => {
  const task = (over: Partial<TaskWorkspace> = {}): TaskWorkspace => ({
    id: "t1",
    projectId: "p1",
    name: "Checkout",
    attempts: [{ id: "primary", createdAt: 1 }],
    children: [
      {
        id: "c1",
        repositoryId: "r1",
        attemptId: "primary",
        workingCopy: "/tmp/app-checkout",
        branch: "checkout",
        sessionIds: [],
        launch: { state: "ready" },
      },
    ],
    sessionIds: [],
    createdAt: 100,
    ...over,
  });
  // No project lookup — repository labels degrade to ids, which is fine.
  const noProject = () => undefined;

  it("matches name and ticket fields with highlight positions", () => {
    const hits = searchTasks(
      [
        task({
          ticket: {
            kind: "issue",
            repo: "acme/shop",
            number: 217,
            url: "https://github.com/acme/shop/issues/217",
            identifier: "BOOK-217",
            title: "Checkout",
          },
        }),
      ],
      "book",
      noProject,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: "task",
      taskId: "t1",
      name: "Checkout",
      archived: false,
    });
    expect(hits[0].detail).toContain("BOOK-217");
  });

  it("falls back to the wider field set and flags archived tasks", () => {
    const hits = searchTasks(
      [task({ archived: true })],
      "app-checkout", // only the working copy path matches
      noProject,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].archived).toBe(true);
    expect(hits[0].positions).toEqual([]);
  });

  it("returns nothing when no field matches", () => {
    expect(
      searchTasks([task()], "unrelated", noProject),
    ).toEqual([]);
    expect(searchTasks([task()], "  ", noProject)).toEqual([]);
  });

  it("groups task hits under the tasks bucket with scope limits", () => {
    const taskHit: AppSearchHit = {
      id: "task:t1",
      kind: "task",
      taskId: "t1",
      name: "Checkout",
      detail: "BOOK-217",
      archived: false,
      createdAt: 1,
      score: 10,
      positions: [],
    };
    expect(groupHits([taskHit], "tasks").tasks).toHaveLength(1);
    expect(groupHits([taskHit], "files").tasks).toHaveLength(0);
    expect(flattenGrouped(groupHits([taskHit], "all"))).toContain(taskHit);
  });
});
