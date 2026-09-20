import { beforeEach, describe, expect, it } from "vitest";
import type { InboxItem } from "../lib/githubTasks";
import type { LinkedWorkItem, Session } from "../lib/session";
import type { SessionSummary } from "../lib/sessionStore";
import {
  buildBoardCards,
  cardAttentionLines,
  cardColumn,
  columnCards,
  columnUnits,
  deriveColumn,
  itemMatchesTicketKey,
  ticketKeys,
  type ColumnUnit,
} from "./boardData";
import {
  addCardToGroup,
  addLocalCard,
  addTask,
  archiveTasks,
  createGroup,
  deleteGroup,
  hideCards,
  loadBoard,
  placeColumnOrder,
  removeCardFromGroup,
  removeLocalCard,
  removeTask,
  renameGroup,
  renameLocalCard,
  unarchiveAll,
  unplaceCard,
  updateTask,
  type BoardTask,
} from "./boardStore";

// boardStore persists to localStorage + notifies on window — node has neither.
const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};

function item(partial: Partial<InboxItem> & Pick<InboxItem, "provider" | "number">): InboxItem {
  return {
    kind: "issue",
    title: `Item ${partial.number}`,
    url: `https://example.test/${partial.number}`,
    state: "open",
    updatedAt: "2025-01-01T00:00:00Z",
    labels: [],
    assignees: [],
    draft: false,
    repo: "acme/app",
    projectPath: "/repo",
    ...partial,
  };
}

function linked(partial: Partial<LinkedWorkItem> = {}): LinkedWorkItem {
  return {
    kind: "issue",
    repo: "acme/app",
    number: 42,
    url: "https://github.com/acme/app/issues/42",
    ...partial,
  };
}

function liveSession(partial: Partial<Session> = {}): Session {
  return {
    id: "s1",
    harness: "claude",
    model: "m",
    modelSettings: {},
    runtimeMode: "supervised",
    title: "Work",
    cwd: "/repo",
    blocks: [],
    ...partial,
  };
}

function task(partial: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "t1",
    title: "Task",
    links: [],
    workstreams: [],
    createdAt: 1,
    ...partial,
  };
}

function summary(partial: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "st1",
    cwd: "/repo",
    harness: "claude",
    model: "m",
    runtimeMode: "supervised",
    title: "Stored",
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

beforeEach(() => {
  storage.clear();
  localStorage.removeItem("monocode.board.v1");
});

describe("buildBoardCards", () => {
  it("keeps provider identity distinct for the same number", () => {
    const cards = buildBoardCards({
      items: [
        item({ provider: "github", number: 12, kind: "issue" }),
        item({ provider: "azure", number: 12, kind: "issue", id: "a12" }),
        item({ provider: "github", number: 12, kind: "pr" }),
      ],
      sessions: [],
      summaries: [],
    });
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((card) => card.id)).size).toBe(3);
  });

  it("turns ci-kind deliveries into branch badges, not cards", () => {
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azure",
          kind: "ci",
          number: 7,
          state: "failed",
          delivery: {
            kind: "ci",
            project: "p",
            repository: "r",
            branch: "refs/heads/feat-x",
            commit: "c",
            author: "a",
            accountId: "acct",
          },
        }),
      ],
      sessions: [
        liveSession({
          id: "s1",
          branch: "feat-x",
          linkedWorkItem: linked(),
        }),
      ],
      summaries: [],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.ciFailing).toBe(1);
    expect(cards[0]!.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("joins a live session onto the matching item card", () => {
    const cards = buildBoardCards({
      items: [item({ provider: "github", number: 42, kind: "issue" })],
      sessions: [liveSession({ id: "s1", linkedWorkItem: linked(), busy: true })],
      summaries: [summary({ id: "s1", linkedWorkItem: linked() })],
    });
    expect(cards).toHaveLength(1);
    // The stored twin must not double-attach.
    expect(cards[0]!.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(cards[0]!.sessions[0]!.live).toBe(true);
    expect(cards[0]!.sessions[0]!.busy).toBe(true);
  });

  it("creates a card for a linked item that has no inbox row", () => {
    const cards = buildBoardCards({
      items: [],
      sessions: [],
      summaries: [summary({ id: "st1", linkedWorkItem: linked() })],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind).toBe("item");
    expect(cards[0]!.sessions[0]!.id).toBe("st1");
  });

  it("makes unlinked live sessions their own progress cards", () => {
    const cards = buildBoardCards({
      items: [],
      sessions: [
        liveSession({ id: "s1" }),
        liveSession({ id: "ask", inboxAsk: { key: "k" } as never }),
        liveSession({ id: "worker", orchestrationLeadId: "lead" }),
      ],
      summaries: [],
    });
    expect(cards.map((card) => card.id)).toEqual(["session:s1"]);
    expect(cards[0]!.derived).toBe("progress");
  });

  it("absorbs linked tickets and binds workstream sessions on task cards", () => {
    const link = linked({
      provider: "jira",
      identifier: "PROJ-123",
      url: "https://jira.test/browse/PROJ-123",
      id: "j1",
    });
    const cards = buildBoardCards({
      items: [
        item({
          provider: "jira",
          number: 0,
          id: "j1",
          identifier: "PROJ-123",
          url: "https://jira.test/browse/PROJ-123",
          title: "Auth fix",
        }),
      ],
      sessions: [
        liveSession({
          id: "s1",
          worktreeCwd: "/repo-wt",
          branch: "mc/proj-123-auth",
        }),
      ],
      summaries: [],
      tasks: [
        task({
          links: [link],
          workstreams: [
            {
              id: "w1",
              projectPath: "/repo",
              branch: "mc/proj-123-auth",
              base: "main",
              worktreePath: "/repo-wt",
              sessionIds: ["s1"],
            },
          ],
        }),
      ],
    });
    // The ticket card folds into the task — no standalone duplicate.
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.kind).toBe("task");
    expect(card.tickets![0]!.title).toBe("Auth fix");
    expect(card.tickets![0]!.identifier).toBe("PROJ-123");
    const row = card.workstreams![0]!;
    expect(row.session?.id).toBe("s1");
    expect(row.worktreePath).toBe("/repo-wt");
    expect(card.derived).toBe("progress");
  });

  it("resolves every conversation bound to a workstream, live first", () => {
    const cards = buildBoardCards({
      items: [],
      sessions: [
        liveSession({ id: "s2", worktreeCwd: "/repo-wt", branch: "mc/x" }),
      ],
      summaries: [
        { id: "s1", title: "older chat", cwd: "/repo-wt" } as never,
      ],
      tasks: [
        task({
          links: [linked({ provider: "jira", identifier: "T-1", id: "j1" })],
          workstreams: [
            {
              id: "w1",
              projectPath: "/repo",
              branch: "mc/x",
              base: "main",
              worktreePath: "/repo-wt",
              sessionIds: ["s1", "s2"],
            },
          ],
        }),
      ],
    });
    const row = cards[0]!.workstreams![0]!;
    // Both bound conversations resolve in binding order…
    expect(row.sessions.map((ref) => ref.id)).toEqual(["s1", "s2"]);
    // …and the live one is the row's display ref.
    expect(row.session?.id).toBe("s2");
  });

  it("discovers pull requests carrying a linked ticket's key", () => {
    const link = linked({
      provider: "jira",
      identifier: "PROJ-123",
      url: "https://jira.test/browse/PROJ-123",
      id: "j1",
    });
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azure",
          kind: "pr",
          number: 9,
          title: "PROJ-123 auth fix",
          url: "https://az.test/pr/9",
          state: "active",
        }),
      ],
      sessions: [],
      summaries: [],
      tasks: [task({ links: [link] })],
    });
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.prs).toHaveLength(1);
    expect(card.prs![0]!.title).toBe("PROJ-123 auth fix");
    expect(card.prs![0]!.via).toBe("key");
    // An open discovered PR pushes the task into review.
    expect(card.derived).toBe("review");
  });

  it("badges task cards with CI deliveries on workstream branches", () => {
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azure",
          kind: "ci",
          number: 7,
          state: "failed",
          delivery: {
            kind: "ci",
            project: "p",
            repository: "r",
            branch: "refs/heads/mc/proj-123",
            commit: "c",
            author: "a",
            accountId: "acct",
          },
        }),
      ],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          workstreams: [
            {
              id: "w1",
              projectPath: "/repo",
              branch: "mc/proj-123",
              base: "main",
            },
          ],
        }),
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind).toBe("task");
    expect(cards[0]!.ciFailing).toBe(1);
  });

  it("projects probed PR + checks onto workstream rows", () => {
    const cards = buildBoardCards({
      items: [],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          workstreams: [
            { id: "w1", projectPath: "/repo", branch: "mc/x", base: "main" },
          ],
        }),
      ],
      workstreamStatus: new Map([
        [
          "w1",
          {
            pr: { number: 5, title: "PR", url: "https://gh.test/pr/5", state: "open" },
            checks: [
              { name: "build", state: "FAILURE", bucket: "fail", url: "" },
              { name: "lint", state: "PENDING", bucket: "pending", url: "" },
            ],
          },
        ],
      ]),
    });
    const row = cards[0]!.workstreams![0]!;
    expect(row.pr?.number).toBe(5);
    expect(row.ciTotal).toBe(2);
    expect(row.ciFailing).toBe(1);
    expect(row.ciRunning).toBe(1);
    expect(cards[0]!.derived).toBe("review");
  });

  it("keeps a linked ticket off the board twice when its item is missing", () => {
    const cards = buildBoardCards({
      items: [],
      sessions: [],
      summaries: [
        summary({ id: "st1", linkedWorkItem: linked({ id: "g1" }) }),
      ],
      tasks: [task({ links: [linked({ id: "g1" })] })],
    });
    // The stored session joins the task card; no orphan item card.
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind).toBe("task");
    expect(cards[0]!.sessions[0]!.id).toBe("st1");
  });

  it("does not join PRs whose ticket key only matches as a substring", () => {
    const link = linked({
      provider: "jira",
      identifier: "PROJ-123",
      url: "https://jira.test/browse/PROJ-123",
      id: "j1",
    });
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azure",
          kind: "pr",
          number: 9,
          title: "PROJ-1234 unrelated",
          url: "https://az.test/pr/9",
          state: "active",
        }),
        item({
          provider: "azure",
          kind: "pr",
          number: 10,
          title: "APROJ-123 unrelated",
          url: "https://az.test/pr/10",
          state: "active",
        }),
        item({
          provider: "azure",
          kind: "pr",
          number: 11,
          title: "Fix (PROJ-123) auth",
          url: "https://az.test/pr/11",
          state: "active",
        }),
      ],
      sessions: [],
      summaries: [],
      tasks: [task({ links: [link] })],
    });
    const card = cards.find((entry) => entry.kind === "task")!;
    expect(card.prs).toHaveLength(1);
    expect(card.prs![0]!.title).toContain("PROJ-123");
    // The two near-miss PRs stay standalone cards.
    expect(cards.filter((entry) => entry.kind !== "task")).toHaveLength(2);
  });

  it("derives done for a ticketless task once its PRs are closed", () => {
    const base = {
      items: [],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          workstreams: [
            { id: "w1", projectPath: "/repo", branch: "mc/x", base: "main" },
          ],
        }),
      ],
    };
    const closed = buildBoardCards({
      ...base,
      workstreamStatus: new Map([
        [
          "w1",
          {
            pr: { number: 5, title: "PR", url: "https://gh.test/pr/5", state: "closed" },
            checks: [],
          },
        ],
      ]),
    });
    expect(closed[0]!.derived).toBe("done");
    // No tickets and no PRs yet — nothing is done, the task just sits.
    expect(buildBoardCards(base)[0]!.derived).toBe("todo");
  });

  it("does not pin a task in progress on a dormant stored session", () => {
    const cards = buildBoardCards({
      items: [],
      sessions: [],
      summaries: [summary({ id: "s1" })],
      tasks: [
        task({
          workstreams: [
            {
              id: "w1",
              projectPath: "/repo",
              branch: "mc/x",
              base: "main",
              sessionIds: ["s1"],
            },
          ],
        }),
      ],
    });
    const card = cards[0]!;
    expect(card.sessions[0]!.live).toBe(false);
    expect(card.derived).toBe("todo");
  });

  it("projects a probe failure onto the workstream row", () => {
    const cards = buildBoardCards({
      items: [],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          workstreams: [
            { id: "w1", projectPath: "/repo", branch: "mc/x", base: "main" },
          ],
        }),
      ],
      workstreamStatus: new Map([
        ["w1", { pr: null, checks: [], error: "not a git repository" }],
      ]),
    });
    expect(cards[0]!.workstreams![0]!.probeError).toBe("not a git repository");
  });
});

describe("ticketKeys + itemMatchesTicketKey", () => {
  it("extracts Jira/Linear-style keys and Azure AB# marks", () => {
    expect(
      ticketKeys(linked({ provider: "jira", identifier: "TEAM-7" })),
    ).toEqual(["TEAM-7"]);
    expect(
      ticketKeys(linked({ provider: "azure", number: 55 })),
    ).toEqual(["AB#55"]);
  });

  it("matches on non-alphanumeric boundaries", () => {
    const hit = item({ title: "Fix (PROJ-123) auth" });
    const longer = item({ title: "PROJ-1234 auth" });
    const prefixed = item({ title: "APROJ-123 auth" });
    expect(itemMatchesTicketKey(hit, "PROJ-123")).toBe(true);
    expect(itemMatchesTicketKey(longer, "PROJ-123")).toBe(false);
    expect(itemMatchesTicketKey(prefixed, "PROJ-123")).toBe(false);
    const azure = item({ provider: "azure", title: "Fix AB#123" });
    const azureLonger = item({ provider: "azure", title: "Fix AB#1234" });
    expect(itemMatchesTicketKey(azure, "AB#123")).toBe(true);
    expect(itemMatchesTicketKey(azureLonger, "AB#123")).toBe(false);
  });
});

describe("deriveColumn", () => {
  it("maps provider and session signals to columns", () => {
    const session = { id: "s", title: "t", busy: false, needsInput: false, live: true };
    expect(
      deriveColumn({ kind: "item", state: "closed", sessions: [] }),
    ).toBe("done");
    expect(
      deriveColumn({ kind: "item", itemKind: "pr", state: "open", sessions: [] }),
    ).toBe("review");
    expect(
      deriveColumn({ kind: "item", state: "open", sessions: [session] }),
    ).toBe("progress");
    expect(
      deriveColumn({ kind: "item", stateType: "started", sessions: [] }),
    ).toBe("progress");
    expect(
      deriveColumn({ kind: "item", state: "open", sessions: [] }),
    ).toBe("todo");
  });

  it("tasks: unfetched ticket chips can't block done, known ones decide", () => {
    const chip = (state?: string) => ({ key: "k", title: "t", ...(state ? { state } : {}) });
    // One fetched done ticket + one link-only chip → done.
    expect(
      deriveColumn({
        kind: "task",
        tickets: [chip("closed"), chip()],
        prs: [],
        workstreams: [],
        sessions: [],
      }),
    ).toBe("done");
    // All tickets unfetched → nothing verifiably done → stays todo.
    expect(
      deriveColumn({
        kind: "task",
        tickets: [chip(), chip()],
        prs: [],
        workstreams: [],
        sessions: [],
      }),
    ).toBe("todo");
    // A fetched open ticket still blocks done.
    expect(
      deriveColumn({
        kind: "task",
        tickets: [chip("closed"), chip("open")],
        prs: [],
        workstreams: [],
        sessions: [],
      }),
    ).toBe("todo");
    // Ticketless task with a closed PR → done; fresh empty task → todo.
    expect(
      deriveColumn({
        kind: "task",
        tickets: [],
        prs: [
          {
            id: "p",
            title: "pr",
            state: "merged",
            via: "link" as const,
          },
        ],
        workstreams: [],
        sessions: [],
      }),
    ).toBe("done");
    expect(
      deriveColumn({
        kind: "task",
        tickets: [],
        prs: [],
        workstreams: [],
        sessions: [],
      }),
    ).toBe("todo");
  });
});

describe("cardColumn + columnCards", () => {
  it("manual placement wins over derivation; locals keep their own column", () => {
    const cards = buildBoardCards({
      items: [
        item({ provider: "github", number: 1, state: "closed" }),
        item({ provider: "github", number: 2 }),
      ],
      sessions: [],
      summaries: [],
      locals: [
        { id: "local:x", title: "Note", column: "review", order: 0, createdAt: 1 },
      ],
    });
    const done = cards.find((card) => card.identifier === "#1")!;
    const open = cards.find((card) => card.identifier === "#2")!;
    expect(cardColumn(done, {})).toBe("done");
    expect(cardColumn(done, { [done.id]: { column: "todo", order: 0 } })).toBe(
      "todo",
    );
    const local = cards.find((card) => card.kind === "local")!;
    expect(cardColumn(local, { [local.id]: { column: "done", order: 0 } })).toBe(
      "review",
    );
    expect(
      columnCards(cards, "todo", { [done.id]: { column: "todo", order: 0 } }, []),
    ).toHaveLength(2);
    expect(cardColumn(open, {})).toBe("todo");
  });

  it("sorts placed cards first by order, then the rest by recency", () => {
    const cards = buildBoardCards({
      items: [
        item({ provider: "github", number: 1, updatedAt: "2025-01-01T00:00:00Z" }),
        item({ provider: "github", number: 2, updatedAt: "2025-02-01T00:00:00Z" }),
        item({ provider: "github", number: 3, updatedAt: "2025-03-01T00:00:00Z" }),
      ],
      sessions: [],
      summaries: [],
    });
    const [one, two, three] = cards;
    const ordered = columnCards(cards, "todo", { [one!.id]: { column: "todo", order: 0 } }, []);
    expect(ordered.map((card) => card.id)).toEqual([one!.id, three!.id, two!.id]);
  });
});

describe("cardAttentionLines", () => {
  it("surfaces input, CI, and update signals in that order", () => {
    const card = buildBoardCards({
      items: [item({ provider: "github", number: 42 })],
      sessions: [
        liveSession({
          id: "s1",
          linkedWorkItem: linked(),
          pendingQuestion: { id: "q" } as never,
        }),
      ],
      summaries: [],
      updates: new Map([["s1", { sessionId: "s1" } as never]]),
    })[0]!;
    card.ciFailing = 1;
    const lines = cardAttentionLines(card);
    expect(lines[0]).toBe("1 session needs input");
    expect(lines).toContain("CI failing");
    expect(lines).toContain("New activity");
  });
});

describe("boardStore", () => {
  it("creates, moves, and removes local cards", () => {
    const id = addLocalCard("Follow up on release")!;
    expect(id).toMatch(/^local:/);
    expect(loadBoard().locals[0]!.column).toBe("todo");

    placeColumnOrder("progress", ["item:a", id, "item:b"]);
    const store = loadBoard();
    expect(store.locals[0]!.column).toBe("progress");
    expect(store.placements["item:a"]!.order).toBe(0);
    expect(store.placements["item:b"]!.order).toBe(2048);

    unplaceCard("item:a");
    expect(loadBoard().placements["item:a"]).toBeUndefined();

    removeLocalCard(id);
    expect(loadBoard().locals).toHaveLength(0);
  });

  it("stores tasks alongside placements and locals", () => {
    const id = addTask({
      title: "Auth rollout",
      links: [linked()],
      workstreams: [
        {
          id: "w1",
          projectPath: "/repo",
          branch: "mc/auth",
          base: "main",
          worktreePath: "/repo-wt",
          sessionIds: ["s1"],
        },
      ],
    });
    expect(id).toBeTruthy();
    let store = loadBoard();
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0]!.workstreams[0]!.sessionIds).toEqual(["s1"]);

    // Drag ordering must not clobber tasks.
    placeColumnOrder("todo", ["item:a", id!]);
    store = loadBoard();
    expect(store.tasks).toHaveLength(1);
    expect(store.placements[id!]!.column).toBe("todo");

    updateTask(id!, { title: "Auth v2", archived: true });
    store = loadBoard();
    expect(store.tasks[0]!.title).toBe("Auth v2");
    expect(store.tasks[0]!.archived).toBe(true);

    removeTask(id!);
    expect(loadBoard().tasks).toHaveLength(0);
  });

  it("sanitizes malformed tasks without dropping the rest", () => {
    storage.set(
      "monocode.board.v1",
      JSON.stringify({
        tasks: [
          { title: "no id" },
          {
            id: "t1",
            title: "kept",
            links: [
              { kind: "issue", url: "https://x.test/1" },
              { kind: "bogus" },
            ],
            workstreams: [
              { id: "w1", projectPath: "/r", branch: "mc/x" },
              { id: "", projectPath: "/r" },
            ],
            createdAt: 5,
          },
        ],
      }),
    );
    const store = loadBoard();
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0]!.links).toHaveLength(1);
    expect(store.tasks[0]!.workstreams[0]!.base).toBe("HEAD");
  });

  it("drops malformed persisted state instead of throwing", () => {
    storage.set(
      "monocode.board.v1",
      JSON.stringify({
        placements: { a: { column: "bogus", order: 1 }, b: { column: "done" } },
        locals: [{ id: "", title: "x" }, { id: "ok", title: "y", column: "review" }],
      }),
    );
    const store = loadBoard();
    expect(store.placements.a).toBeUndefined();
    expect(store.placements.b!.column).toBe("done");
    expect(store.locals).toHaveLength(1);
  });
});

describe("groups", () => {
  it("creates, renames and deletes groups, stripping task references", () => {
    const taskId = addTask({ title: "T", links: [], workstreams: [] });
    const a = createGroup("Backend")!;
    const b = createGroup("Frontend")!;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // Colors cycle — no two consecutive groups share a swatch.
    const [ga, gb] = loadBoard().groups;
    expect(ga!.color).not.toBe(gb!.color);

    updateTask(taskId!, { groupIds: [a, b] });
    renameGroup(a, "API work");
    let store = loadBoard();
    expect(store.groups.find((g) => g.id === a)!.name).toBe("API work");

    deleteGroup(a);
    store = loadBoard();
    expect(store.groups).toHaveLength(1);
    expect(store.tasks[0]!.groupIds).toEqual([b]);
  });

  it("sanitizes group refs pointing at missing groups", () => {
    storage.set(
      "monocode.board.v1",
      JSON.stringify({
        groups: [{ id: "g1", name: "Kept", color: 2 }],
        tasks: [
          {
            id: "t1",
            title: "T",
            links: [],
            workstreams: [],
            groupIds: ["g1", "gone", 42],
            createdAt: 1,
          },
        ],
      }),
    );
    const store = loadBoard();
    expect(store.tasks[0]!.groupIds).toEqual(["g1"]);
  });

  it("resolves card.groups from task groupIds", () => {
    const cards = buildBoardCards({
      items: [],
      sessions: [],
      summaries: [],
      tasks: [task({ groupIds: ["g1", "missing"] })],
      groups: [{ id: "g1", name: "Backend", color: 0 }],
    });
    const card = cards.find((entry) => entry.kind === "task")!;
    expect(card.groups).toEqual([{ id: "g1", name: "Backend", color: 0 }]);
  });

  it("adds/removes non-task cards via cardGroups, deduped and prepended", () => {
    const a = createGroup("Backend")!;
    const b = createGroup("Ops")!;
    addCardToGroup("item:x", a);
    addCardToGroup("item:x", a); // no dup
    addCardToGroup("item:x", b); // prepend — newest is primary
    expect(loadBoard().cardGroups["item:x"]).toEqual([b, a]);
    removeCardFromGroup("item:x", b);
    removeCardFromGroup("item:x", a);
    expect(loadBoard().cardGroups["item:x"]).toBeUndefined();
  });

  it("sanitizes cardGroups refs to missing groups and drops empty keys", () => {
    storage.set(
      "monocode.board.v1",
      JSON.stringify({
        groups: [{ id: "g1", name: "Kept", color: 0 }],
        cardGroups: {
          "item:x": ["g1", "gone", 7],
          "item:y": ["gone"],
          "item:z": "not-an-array",
        },
      }),
    );
    const store = loadBoard();
    expect(store.cardGroups["item:x"]).toEqual(["g1"]);
    expect(store.cardGroups["item:y"]).toBeUndefined();
    expect(store.cardGroups["item:z"]).toBeUndefined();
  });

  it("deleteGroup strips cardGroups refs; removeLocalCard prunes its entry", () => {
    const localId = addLocalCard("note")!;
    const g = createGroup("Ops")!;
    addCardToGroup(localId, g);
    addCardToGroup("item:x", g);
    deleteGroup(g);
    expect(loadBoard().cardGroups).toEqual({});

    const g2 = createGroup("Ops2")!;
    addCardToGroup(localId, g2);
    removeLocalCard(localId);
    expect(loadBoard().cardGroups[localId]).toBeUndefined();
  });

  it("resolves groups onto item and local cards; they cluster in columnUnits", () => {
    const base = buildBoardCards({
      items: [item({ provider: "github", number: 7 })],
      sessions: [],
      summaries: [],
    });
    const itemCard = base.find((entry) => entry.kind === "item")!;
    const cards = buildBoardCards({
      items: [item({ provider: "github", number: 7 })],
      sessions: [],
      summaries: [],
      tasks: [task({ id: "t1", groupIds: ["g1"] })],
      locals: [
        { id: "l1", title: "note", column: "todo", order: 0, createdAt: 1 },
      ],
      groups: [{ id: "g1", name: "A", color: 0 }],
      cardGroups: { [itemCard.id]: ["g1"], l1: ["g1"] },
    });
    const grouped = cards.filter((card) => card.groups?.length);
    expect(grouped.map((card) => card.kind).sort()).toEqual([
      "item",
      "local",
      "task",
    ]);
    const units = columnUnits(cards);
    expect(units).toHaveLength(1);
    expect(units[0]!.type).toBe("group");
    expect(
      (units[0] as Extract<ColumnUnit, { type: "group" }>).cards,
    ).toHaveLength(3);
  });
});

describe("columnUnits", () => {
  it("clusters same-group task cards into one unit at the first member's spot", () => {
    const cards = buildBoardCards({
      items: [],
      sessions: [],
      summaries: [],
      tasks: [
        task({ id: "t1", groupIds: ["g1"] }),
        task({ id: "t2" }),
        task({ id: "t3", groupIds: ["g1"] }),
        task({ id: "t4", groupIds: ["g2"] }),
      ],
      groups: [
        { id: "g1", name: "A", color: 0 },
        { id: "g2", name: "B", color: 1 },
      ],
    });
    const units = columnUnits(cards);
    expect(units.map((unit) => unit.type)).toEqual([
      "group",
      "card",
      "group",
    ]);
    const g1 = units[0] as Extract<ColumnUnit, { type: "group" }>;
    expect(g1.group.id).toBe("g1");
    expect(g1.cards.map((card) => card.id)).toEqual(["t1", "t3"]);
    expect(units[1]).toMatchObject({ type: "card", card: { id: "t2" } });
  });
});

describe("archive + local rename", () => {
  it("hides derived card ids; unarchiveAll restores them and tasks", () => {
    hideCards(["item:github:x", "item:github:x", ""]);
    expect(loadBoard().hidden).toEqual(["item:github:x"]);
    const id = addTask({ title: "T", links: [], workstreams: [] })!;
    updateTask(id, { archived: true });
    unarchiveAll();
    const store = loadBoard();
    expect(store.hidden).toEqual([]);
    expect(store.tasks[0]!.archived).toBeUndefined();
  });

  it("renames a local card", () => {
    const id = addLocalCard("Old")!;
    renameLocalCard(id, "New name");
    expect(loadBoard().locals[0]!.title).toBe("New name");
    renameLocalCard(id, "   ");
    expect(loadBoard().locals[0]!.title).toBe("New name");
  });

  it("archiveTasks batches; removing a local card prunes its hidden entry", () => {
    const a = addTask({ title: "A", links: [], workstreams: [] })!;
    const b = addTask({ title: "B", links: [], workstreams: [] })!;
    const c = addTask({ title: "C", links: [], workstreams: [] })!;
    archiveTasks([a, b, "task:missing"]);
    const store = loadBoard();
    expect(store.tasks.find((t) => t.id === a)!.archived).toBe(true);
    expect(store.tasks.find((t) => t.id === b)!.archived).toBe(true);
    expect(store.tasks.find((t) => t.id === c)!.archived).toBeUndefined();

    // A local card dismissed via hideCards leaves no stale id after removal.
    const local = addLocalCard("note")!;
    hideCards([local]);
    removeLocalCard(local);
    expect(loadBoard().hidden).toEqual([]);

    // Removing a task clears its placement too.
    placeColumnOrder("done", [c]);
    removeTask(c);
    expect(loadBoard().placements[c]).toBeUndefined();
  });
});

describe("session link join", () => {
  it("attaches a session to a task when the stored link's key drifts but the url matches", () => {
    // Task stores a Jira-flavoured link; the session carries the same url
    // without a provider — the identity keys differ, the url doesn't.
    const url = "https://jira.test/browse/ABC-1";
    const cards = buildBoardCards({
      items: [],
      sessions: [
        liveSession({
          id: "s1",
          linkedWorkItem: linked({
            kind: "issue",
            repo: "",
            number: 0,
            url,
            provider: undefined,
          }),
        }),
      ],
      summaries: [],
      tasks: [
        task({
          id: "t1",
          links: [
            linked({
              kind: "issue",
              provider: "jira",
              repo: "",
              number: 0,
              url,
            }),
          ],
        }),
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind).toBe("task");
    expect(cards[0]!.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("badges cancelled delivery runs as neither failing nor running", () => {
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azure",
          kind: "ci",
          number: 9,
          state: "canceled",
          delivery: {
            kind: "ci",
            project: "p",
            repository: "r",
            branch: "refs/heads/feat-y",
            commit: "c",
            author: "a",
            accountId: "acct",
          },
        }),
      ],
      sessions: [
        liveSession({ id: "s1", branch: "feat-y", linkedWorkItem: linked() }),
      ],
      summaries: [],
    });
    expect(cards[0]!.ciTotal).toBe(1);
    expect(cards[0]!.ciFailing).toBe(0);
    expect(cards[0]!.ciRunning).toBe(0);
  });
});
