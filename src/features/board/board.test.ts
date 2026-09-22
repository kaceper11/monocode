import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composePrBody,
  laneProblem,
  prHeadRemoteRef,
  prIsOpen,
  renderPrBody,
  resolveConflictPrompt,
} from "./taskOps";
import type { InboxItem } from "../inbox/model/githubTasks";
import type { LinkedWorkItem, Session } from "../sessions/model/session";
import type { SessionSummary } from "../sessions/data/sessionStore";
import {
  attentionScore,
  buildBoardCards,
  cardAttentionLines,
  cardColumn,
  columnCards,
  columnUnits,
  deriveColumn,
  dropOrder,
  isCardSnoozed,
  itemCardKey,
  itemMatchesTicketKey,
  lanePrSignal,
  snoozeWakeKey,
  ticketKeys,
  type ColumnUnit,
} from "./boardData";
import { buildStandup } from "./standup";
import { defaultReviewProject } from "./ReviewLocallyDialog";
import {
  addColumn,
  addLocalCard,
  addTask,
  archiveTasks,
  createGroup,
  deleteGroup,
  hideCards,
  loadBoard,
  pinCard,
  placeColumnOrder,
  removeCardFromGroup,
  removeColumn,
  removeLocalCard,
  removeTask,
  renameColumn,
  renameGroup,
  renameLocalCard,
  setCardGroups,
  snoozeCard,
  unarchiveAll,
  unplaceCard,
  unsnoozeCard,
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
        item({ provider: "azuredevops", number: 12, kind: "issue", id: "a12" }),
        item({ provider: "github", number: 12, kind: "pr" }),
      ],
      sessions: [],
      summaries: [],
    });
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((card) => card.id)).size).toBe(3);
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
          provider: "azuredevops",
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
    // An open discovered PR pushes the task into review.
    expect(card.derived).toBe("review");
  });

  it("renders the default PR template with tickets, siblings and branches", () => {
    const t = task({
      title: "Auth rework",
      links: [linked({ identifier: "ENG-9", title: "Auth bug" })],
      workstreams: [
        { id: "w1", projectPath: "/a", branch: "mc/auth-a", base: "main" },
        { id: "w2", projectPath: "/b", branch: "mc/auth-b", base: "main" },
      ],
    });
    const body = renderPrBody(t, t.workstreams[0]!, ["https://x/pr/2"], "main");
    expect(body).toBe(
      [
        "Part of task: **Auth rework**",
        "",
        "Tickets:",
        "- ENG-9 — Auth bug (https://github.com/acme/app/issues/42)",
        "",
        "Related pull requests:",
        "- https://x/pr/2",
        "",
        "Related branches:",
        "- `mc/auth-b`",
      ].join("\n"),
    );
  });

  it("composePrBody prepends the lane description and guarantees sibling links", () => {
    const t = task({
      title: "Auth rework",
      workstreams: [
        { id: "w1", projectPath: "/a", branch: "mc/auth-a", base: "main" },
        { id: "w2", projectPath: "/b", branch: "mc/auth-b", base: "main" },
      ],
    });
    const opts = {
      descriptions: new Map([
        ["w1", "Reworks the API auth flow"],
        ["w2", "Updates the web login form"],
      ]),
    };
    const first = composePrBody(
      t,
      t.workstreams[0]!,
      ["https://x/pr/2"],
      "main",
      opts,
    );
    const second = composePrBody(
      t,
      t.workstreams[1]!,
      ["https://x/pr/1"],
      "main",
      opts,
    );
    // Each lane's own text leads — the bodies differ.
    expect(first).toMatch(/^Reworks the API auth flow\n\n/);
    expect(second).toMatch(/^Updates the web login form\n\n/);
    // Cross-links survive even when the template drops {prs}.
    const stripped = composePrBody(
      t,
      t.workstreams[0]!,
      ["https://x/pr/2"],
      "main",
      { ...opts, body: "Part of task: **{task}**" },
    );
    expect(stripped).toContain("Related pull requests:\n- https://x/pr/2");
    // No description, no siblings → just the template render.
    expect(composePrBody(t, t.workstreams[0]!, [], "main")).toBe(
      "Part of task: **Auth rework**\n\nRelated branches:\n- `mc/auth-b`",
    );
  });

  it("drops empty template sections and substitutes lane tokens", () => {
    const t = task({
      title: "Solo",
      workstreams: [
        { id: "w1", projectPath: "/a", branch: "mc/x", base: "main" },
      ],
    });
    // No links, no siblings, one lane — only the task line survives.
    expect(renderPrBody(t, t.workstreams[0]!, [], "main")).toBe(
      "Part of task: **Solo**",
    );
    // Custom template — unknown tokens pass through untouched.
    expect(
      renderPrBody(t, t.workstreams[0]!, [], "release/1.2", "{branch} → {base} {nope}"),
    ).toBe("mc/x → release/1.2 {nope}");
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

  it("joins an Azure PR to its workstream lane by sourceRefName", () => {
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azuredevops",
          kind: "pr",
          number: 77,
          title: "Azure PR",
          url: "https://dev.azure.com/acme/p/_git/r/pullrequest/77",
          repo: "acme/repo",
          sourceRefName: "refs/heads/mc/x",
          targetRefName: "refs/heads/main",
        }),
      ],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          workstreams: [
            { id: "w1", projectPath: "/repo", branch: "mc/x", base: "main" },
          ],
        }),
      ],
    });
    // Absorbed — no standalone item card.
    expect(cards).toHaveLength(1);
    const row = cards[0]!.workstreams![0]!;
    expect(row.pr).toEqual({
      number: 77,
      title: "Azure PR",
      url: "https://dev.azure.com/acme/p/_git/r/pullrequest/77",
      state: "open",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    // And not duplicated into the discovered-PR chips.
    expect(cards[0]!.prs).toEqual([]);
  });

  it("keeps the probed PR when an Azure item also matches the lane", () => {
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azuredevops",
          kind: "pr",
          number: 77,
          title: "Stale title",
          url: "https://dev.azure.com/acme/p/_git/r/pullrequest/77",
          repo: "acme/repo",
          sourceRefName: "refs/heads/mc/x",
        }),
      ],
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
            pr: { number: 77, title: "Fresh", url: "https://x", state: "open" },
            checks: [],
          },
        ],
      ]),
    });
    // Still absorbed — and the fresher probe row is not overwritten.
    expect(cards).toHaveLength(1);
    expect(cards[0]!.workstreams![0]!.pr?.title).toBe("Fresh");
  });

  it("breaks a shared branch-name tie by repo when joining a PR", () => {
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azuredevops",
          kind: "pr",
          number: 77,
          title: "Azure PR",
          url: "https://dev.azure.com/acme/p/_git/app/pullrequest/77",
          repo: "acme/app",
          sourceRefName: "refs/heads/mc/x",
        }),
      ],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          id: "t1",
          title: "App lane",
          workstreams: [
            { id: "w1", projectPath: "/code/app", branch: "mc/x", base: "main" },
          ],
        }),
        task({
          id: "t2",
          title: "Other lane",
          workstreams: [
            {
              id: "w2",
              projectPath: "/code/other",
              branch: "mc/x",
              base: "main",
            },
          ],
        }),
      ],
    });
    const app = cards.find((entry) => entry.task?.id === "t1")!;
    const other = cards.find((entry) => entry.task?.id === "t2")!;
    expect(app.workstreams![0]!.pr?.number).toBe(77);
    expect(other.workstreams![0]!.pr).toBeUndefined();
  });

  it("leaves a shared-branch PR standalone when no lane's repo matches", () => {
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azuredevops",
          kind: "pr",
          number: 77,
          repo: "acme/third",
          sourceRefName: "refs/heads/mc/x",
        }),
      ],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          id: "t1",
          workstreams: [
            { id: "w1", projectPath: "/code/app", branch: "mc/x", base: "main" },
          ],
        }),
        task({
          id: "t2",
          workstreams: [
            {
              id: "w2",
              projectPath: "/code/other",
              branch: "mc/x",
              base: "main",
            },
          ],
        }),
      ],
    });
    // Ambiguous — no lane claims it, so it stands alone rather than
    // poisoning the wrong lane.
    expect(cards.filter((entry) => entry.kind === "task")).toHaveLength(2);
    const itemCard = cards.find((entry) => entry.kind === "item")!;
    expect(itemCard.item?.number).toBe(77);
    for (const entry of cards)
      for (const row of entry.workstreams ?? [])
        expect(row.pr).toBeUndefined();
  });

  it("does not join an Azure PR on a different branch", () => {
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azuredevops",
          kind: "pr",
          number: 77,
          sourceRefName: "refs/heads/other",
        }),
      ],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          workstreams: [
            { id: "w1", projectPath: "/repo", branch: "mc/x", base: "main" },
          ],
        }),
      ],
    });
    expect(cards).toHaveLength(2);
    expect(cards[0]!.workstreams![0]!.pr).toBeUndefined();
  });

  it("does not branch-join an Azure PR when two lanes claim the branch", () => {
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azuredevops",
          kind: "pr",
          number: 77,
          url: "https://dev.azure.com/acme/p/_git/r/pullrequest/77",
          sourceRefName: "refs/heads/mc/x",
        }),
      ],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          id: "ta",
          title: "A",
          workstreams: [
            { id: "w1", projectPath: "/a", branch: "mc/x", base: "main" },
          ],
        }),
        task({
          id: "tb",
          title: "B",
          workstreams: [
            { id: "w2", projectPath: "/b", branch: "mc/x", base: "main" },
          ],
        }),
      ],
    });
    // The join can't tell which repo's PR this is — better standalone than wrong.
    expect(cards).toHaveLength(3);
    expect(cards[0]!.workstreams![0]!.pr).toBeUndefined();
    expect(cards[1]!.workstreams![0]!.pr).toBeUndefined();
  });

  it("does not branch-join a lone lane when the PR's repo differs", () => {
    // One candidate lane is not enough — a same-named branch in another
    // repo is a different change; the PR stays a standalone card.
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azuredevops",
          kind: "pr",
          number: 77,
          repo: "p/other-repo",
          url: "https://dev.azure.com/acme/p/_git/other-repo/pullrequest/77",
          sourceRefName: "refs/heads/mc/x",
        }),
      ],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          id: "ta",
          title: "A",
          workstreams: [
            { id: "w1", projectPath: "/code/app", branch: "mc/x", base: "main" },
          ],
        }),
      ],
    });
    expect(cards).toHaveLength(2);
    expect(cards[0]!.workstreams![0]!.pr).toBeUndefined();
  });

  it("keeps a second same-branch Azure PR as a discovered chip", () => {
    const cards = buildBoardCards({
      items: [
        item({
          provider: "azuredevops",
          kind: "pr",
          number: 77,
          title: "First",
          url: "https://dev.azure.com/acme/p/_git/repo/pullrequest/77",
          repo: "acme/repo",
          sourceRefName: "refs/heads/mc/x",
        }),
        item({
          provider: "azuredevops",
          kind: "pr",
          number: 88,
          title: "Second",
          url: "https://dev.azure.com/acme/p/_git/repo/pullrequest/88",
          repo: "acme/repo",
          sourceRefName: "refs/heads/mc/x",
        }),
      ],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          workstreams: [
            { id: "w1", projectPath: "/repo", branch: "mc/x", base: "main" },
          ],
        }),
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.workstreams![0]!.pr?.number).toBe(77);
    expect(cards[0]!.prs!.map((pr) => pr.title)).toEqual(["Second"]);
  });

  it("projects branch pipeline checks onto standalone Azure PR cards", () => {
    const prItem = item({
      provider: "azuredevops",
      kind: "pr",
      number: 9,
      repo: "p/r",
      sourceRefName: "refs/heads/feature",
    });
    const cards = buildBoardCards({
      items: [prItem],
      sessions: [],
      summaries: [],
      cardChecks: new Map([
        [
          itemCardKey(prItem),
          [
            { name: "build", state: "succeeded", bucket: "pass", url: "" },
            { name: "tests", state: "failed", bucket: "fail", url: "" },
          ],
        ],
      ]),
    });
    expect(cards[0]!.ciTotal).toBe(2);
    expect(cards[0]!.ciFailing).toBe(1);
    expect(cards[0]!.ciRunning).toBe(0);
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
          provider: "azuredevops",
          kind: "pr",
          number: 9,
          title: "PROJ-1234 unrelated",
          url: "https://az.test/pr/9",
          state: "active",
        }),
        item({
          provider: "azuredevops",
          kind: "pr",
          number: 10,
          title: "APROJ-123 unrelated",
          url: "https://az.test/pr/10",
          state: "active",
        }),
        item({
          provider: "azuredevops",
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

  it("marks a mid-merge workstream row for conflict resolution", () => {
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
        ["w1", { pr: null, checks: [], merging: true }],
      ]),
    });
    expect(cards[0]!.workstreams![0]!.merging).toBe(true);
  });

  it("conflict prompt keeps both sides and commits the merge", () => {
    const prompt = resolveConflictPrompt({ branch: "mc/x", base: "main" });
    expect(prompt).toContain("`main`");
    expect(prompt).toContain("`mc/x`");
    expect(prompt).toMatch(/combining both sides/);
    expect(prompt).toMatch(/commit the merge/);
  });

  it("laneProblem flags each pre-submit failure mode", () => {
    const row = { branch: "mc/x", worktreePath: "/repo/.wt/mc-x" };
    const pf = {
      head: "mc/x",
      baseRef: "origin/main",
      baseBranch: "main",
      baseOnRemote: true,
      ahead: 3,
      headPushed: true,
      hasRemote: true,
    };
    expect(laneProblem(row, "main", pf)).toBeNull();
    expect(laneProblem({ branch: "mc/x" }, "main", pf)).toMatch(/No worktree/);
    expect(laneProblem(row, "main", { ...pf, head: "other" })).toMatch(
      /Worktree is on other/,
    );
    expect(laneProblem(row, "main", { ...pf, head: null })).toMatch(
      /detached HEAD/,
    );
    expect(laneProblem(row, "main", { ...pf, hasRemote: false })).toMatch(
      /No git remote/,
    );
    expect(laneProblem(row, "gone", { ...pf, baseRef: null })).toMatch(
      /doesn't exist/,
    );
    expect(
      laneProblem(row, "main", { ...pf, baseRef: "main", baseOnRemote: false }),
    ).toMatch(/isn't on the remote/);
    // Remote-qualified pick of the lane's own branch.
    expect(
      laneProblem(row, "origin/mc/x", {
        ...pf,
        baseRef: "origin/mc/x",
        baseBranch: "mc/x",
      }),
    ).toMatch(/same branch/);
    expect(laneProblem(row, "main", { ...pf, ahead: 0 })).toMatch(
      /No commits ahead/,
    );
    // A "HEAD" base resolved by preflight — messages name the real target.
    expect(laneProblem(row, "HEAD", { ...pf, ahead: 0 })).toMatch(
      /ahead of main/,
    );
    expect(
      laneProblem(row, "HEAD", { ...pf, baseRef: null, baseBranch: "" }),
    ).toMatch(/resolve a base/i);
    // Closed/merged PRs don't block creation; unknown state stays safe.
    expect(prIsOpen("open")).toBe(true);
    expect(prIsOpen("active")).toBe(true);
    expect(prIsOpen("CLOSED")).toBe(false);
    expect(prIsOpen("merged")).toBe(false);
    expect(prIsOpen("")).toBe(true);
  });
});

describe("ticketKeys + itemMatchesTicketKey", () => {
  it("extracts Jira/Linear-style keys and Azure AB# marks", () => {
    expect(
      ticketKeys(linked({ provider: "jira", identifier: "TEAM-7" })),
    ).toEqual(["TEAM-7"]);
    expect(
      ticketKeys(linked({ provider: "azuredevops", number: 55 })),
    ).toEqual(["AB#55"]);
  });

  it("matches on non-alphanumeric boundaries", () => {
    const hit = item({ title: "Fix (PROJ-123) auth" });
    const longer = item({ title: "PROJ-1234 auth" });
    const prefixed = item({ title: "APROJ-123 auth" });
    expect(itemMatchesTicketKey(hit, "PROJ-123")).toBe(true);
    expect(itemMatchesTicketKey(longer, "PROJ-123")).toBe(false);
    expect(itemMatchesTicketKey(prefixed, "PROJ-123")).toBe(false);
    const azure = item({ provider: "azuredevops", title: "Fix AB#123" });
    const azureLonger = item({ provider: "azuredevops", title: "Fix AB#1234" });
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

  it("pinned cards sort first, ahead of placed and unplaced cards", () => {
    const cards = buildBoardCards({
      items: [
        item({ provider: "github", number: 1, updatedAt: "2025-03-01T00:00:00Z" }),
        item({ provider: "github", number: 2, updatedAt: "2025-02-01T00:00:00Z" }),
        item({ provider: "github", number: 3, updatedAt: "2025-01-01T00:00:00Z" }),
      ],
      sessions: [],
      summaries: [],
    });
    const [one, two, three] = cards;
    // Three is pinned, one placed — pin wins even over explicit placement.
    const ordered = columnCards(
      cards,
      "todo",
      {
        [one!.id]: { column: "todo", order: 0 },
        [three!.id]: { column: "todo", order: 5, pinned: true },
      },
      [],
    );
    expect(ordered.map((card) => card.id)).toEqual([
      three!.id,
      one!.id,
      two!.id,
    ]);
  });
});

describe("pinning", () => {
  it("pins an unplaced card to the column top and back", () => {
    pinCard("item:x", "todo", true);
    let store = loadBoard();
    expect(store.placements["item:x"]).toEqual({
      column: "todo",
      order: -1024,
      pinned: true,
      placedAt: expect.any(Number),
    });
    pinCard("item:x", "todo", false);
    store = loadBoard();
    // Unpin keeps the position — Reset removes the placement entirely.
    expect(store.placements["item:x"]).toEqual({
      column: "todo",
      order: -1024,
      placedAt: expect.any(Number),
    });
  });

  it("pins a local card and lands it above everything in the column", () => {
    const id = addLocalCard("note")!;
    placeColumnOrder("todo", ["item:a", "item:b"]);
    pinCard(id, "todo", true);
    const store = loadBoard();
    const local = store.locals.find((card) => card.id === id)!;
    expect(local.pinned).toBe(true);
    expect(local.order).toBeLessThan(0);
    pinCard(id, "todo", false);
    expect(loadBoard().locals.find((card) => card.id === id)!.pinned).toBe(
      undefined,
    );
  });

  it("keeps the pinned flag through a column drop", () => {
    pinCard("item:x", "todo", true);
    placeColumnOrder("todo", ["item:a", "item:x", "item:b"]);
    expect(loadBoard().placements["item:x"]!.pinned).toBe(true);
  });

  it("surfaces a pinned member at the top of its group wrapper", () => {
    const groupId = createGroup("work")!;
    const cards = buildBoardCards({
      items: [
        item({ provider: "github", number: 1 }),
        item({ provider: "github", number: 2 }),
      ],
      sessions: [],
      summaries: [],
    });
    const [first, second] = cards;
    const withGroups = cards.map((card) => ({
      ...card,
      groups:
        card.id === first!.id || card.id === second!.id
          ? [{ id: groupId, name: "work", color: 0 }]
          : [],
    }));
    const ordered = columnCards(
      withGroups,
      "todo",
      {
        [first!.id]: { column: "todo", order: 0 },
        [second!.id]: { column: "todo", order: 1, pinned: true },
      },
      [],
    );
    const units = columnUnits(ordered);
    expect(units[0]!.type).toBe("group");
    if (units[0]!.type === "group") {
      expect(units[0]!.cards[0]!.id).toBe(second!.id);
    }
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

  it("adds, renames, and removes custom columns", () => {
    const id = addColumn("QA")!;
    expect(id).toMatch(/^col:/);
    // Customs slot between review and done.
    expect(loadBoard().columns.map((c) => c.id)).toEqual([
      "todo",
      "progress",
      "review",
      id,
      "done",
    ]);

    renameColumn(id, "QA review");
    expect(loadBoard().columns.find((c) => c.id === id)!.label).toBe(
      "QA review",
    );

    // Cards placed in the column survive as placements.
    placeColumnOrder(id, ["item:x"]);
    expect(loadBoard().placements["item:x"]!.column).toBe(id);
    const localId = addLocalCard("note")!;
    placeColumnOrder(id, [localId]);

    removeColumn(id);
    const store = loadBoard();
    expect(store.columns.some((c) => c.id === id)).toBe(false);
    // Placement pruned; the orphaned local lands back in todo.
    expect(store.placements["item:x"]).toBeUndefined();
    expect(store.locals.find((c) => c.id === localId)!.column).toBe("todo");
  });

  it("moves a deleted column's cards to a chosen column", () => {
    const id = addColumn("QA")!;
    placeColumnOrder(id, ["item:x", "item:y"]);
    const localId = addLocalCard("note")!;
    placeColumnOrder(id, [localId]);
    // Existing content in the destination keeps its spot; moved cards append.
    placeColumnOrder("review", ["item:there"]);

    removeColumn(id, "review");
    const store = loadBoard();
    expect(store.columns.some((c) => c.id === id)).toBe(false);
    const orders = [
      store.placements["item:x"]!.order,
      store.placements["item:y"]!.order,
      store.locals.find((c) => c.id === localId)!.order,
    ];
    expect(store.placements["item:x"]!.column).toBe("review");
    expect(store.placements["item:y"]!.column).toBe("review");
    expect(store.locals.find((c) => c.id === localId)!.column).toBe("review");
    // Appended after the destination's existing card, in move order.
    expect(Math.min(...orders)).toBeGreaterThan(
      store.placements["item:there"]!.order,
    );
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("keeps pins when a deleted column's cards move", () => {
    const id = addColumn("QA")!;
    pinCard("item:x", id, true);
    const localId = addLocalCard("note")!;
    pinCard(localId, id, true);

    removeColumn(id, "review");
    const store = loadBoard();
    expect(store.placements["item:x"]).toMatchObject({
      column: "review",
      pinned: true,
    });
    expect(store.locals.find((c) => c.id === localId)).toMatchObject({
      column: "review",
      pinned: true,
    });
  });

  it("appends locals moved by column delete instead of keeping stale order", () => {
    const id = addColumn("QA")!;
    const localId = addLocalCard("note")!;
    placeColumnOrder(id, [localId]);
    const anchor = addLocalCard("anchor")!; // sits in todo

    removeColumn(id); // no target → todo
    const moved = loadBoard().locals.find((c) => c.id === localId)!;
    const existing = loadBoard().locals.find((c) => c.id === anchor)!;
    expect(moved.column).toBe("todo");
    expect(moved.order).toBeGreaterThan(existing.order);
  });

  it("clamps unpinned drops below the pinned prefix", () => {
    const pinned = new Set(["a", "b"]);
    // Dropping above the pinned block lands right below it.
    expect(dropOrder(["a", "b", "c"], pinned, "x", 0)).toEqual([
      "a",
      "b",
      "x",
      "c",
    ]);
    // Inside the free region the index is honored.
    expect(dropOrder(["a", "b", "c"], pinned, "x", 3)).toEqual([
      "a",
      "b",
      "c",
      "x",
    ]);
    // A still-pinned dragged card (cross-column drop) keeps its index —
    // the sort renders it at the top anyway.
    expect(dropOrder(["a", "b"], new Set(["x"]), "x", 2)).toEqual([
      "a",
      "b",
      "x",
    ]);
  });

  it("falls back to derived columns for a bogus delete target", () => {
    const id = addColumn("QA")!;
    placeColumnOrder(id, ["item:x"]);
    removeColumn(id, "col:gone");
    expect(loadBoard().placements["item:x"]).toBeUndefined();
  });

  it("refuses to remove built-in columns", () => {
    removeColumn("done");
    expect(loadBoard().columns.map((c) => c.id)).toEqual([
      "todo",
      "progress",
      "review",
      "done",
    ]);
  });

  it("keeps stored custom columns and placements across loads", () => {
    storage.set(
      "monocode.board.v1",
      JSON.stringify({
        columns: [
          { id: "col:a", label: "Blocked" },
          { id: "done", label: "Shipped" }, // renamed default survives
          { id: "col:a", label: "dupe" }, // dupes drop
          { id: "", label: "no id" },
        ],
        placements: {
          x: { column: "col:a", order: 0 },
          y: { column: "gone", order: 0 },
        },
      }),
    );
    const store = loadBoard();
    expect(store.columns.map((c) => c.id)).toEqual([
      "todo",
      "progress",
      "review",
      "col:a",
      "done",
    ]);
    expect(store.columns.find((c) => c.id === "done")!.label).toBe("Shipped");
    expect(store.placements.x!.column).toBe("col:a");
    // Placement into a deleted column is pruned.
    expect(store.placements.y).toBeUndefined();
  });

  it("ignores drops into unknown columns", () => {
    placeColumnOrder("col:nope", ["item:x"]);
    expect(loadBoard().placements["item:x"]).toBeUndefined();
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

  it("addTask keeps only group ids that exist", () => {
    const a = createGroup("Backend")!;
    const id = addTask({
      title: "T",
      links: [],
      workstreams: [],
      groupIds: [a, "gone"],
    });
    expect(loadBoard().tasks.find((t) => t.id === id)!.groupIds).toEqual([a]);
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

  it("sets/removes non-task card groups via cardGroups, deduped", () => {
    const a = createGroup("Backend")!;
    const b = createGroup("Ops")!;
    setCardGroups("item:x", [a, a]); // no dup
    expect(loadBoard().cardGroups["item:x"]).toEqual([a]);
    setCardGroups("item:x", [b, a]); // first id is primary
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
    setCardGroups(localId, [g]);
    setCardGroups("item:x", [g]);
    deleteGroup(g);
    expect(loadBoard().cardGroups).toEqual({});

    const g2 = createGroup("Ops2")!;
    setCardGroups(localId, [g2]);
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

});

describe("column age (placedAt)", () => {
  it("sets on entry, survives same-column reorders and pins, resets on moves", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const id = addTask({ title: "A", links: [], workstreams: [] })!;
      const other = addTask({ title: "B", links: [], workstreams: [] })!;
      placeColumnOrder("todo", [id, other]);
      expect(loadBoard().placements[id]!.placedAt).toBe(1000);

      // Reorder inside the column — entry time is preserved.
      vi.setSystemTime(2000);
      placeColumnOrder("todo", [other, id]);
      expect(loadBoard().placements[id]!.placedAt).toBe(1000);

      // Pinning inside the column keeps the age too.
      vi.setSystemTime(3000);
      pinCard(id, "todo", true);
      expect(loadBoard().placements[id]!.placedAt).toBe(1000);
      expect(loadBoard().placements[id]!.pinned).toBe(true);

      // A real move restarts the clock.
      vi.setSystemTime(4000);
      placeColumnOrder("progress", [id]);
      expect(loadBoard().placements[id]!.placedAt).toBe(4000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps local cards on creation and on column moves", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(5000);
      const id = addLocalCard("note")!;
      expect(loadBoard().locals[0]!.placedAt).toBe(5000);
      vi.setSystemTime(9000);
      placeColumnOrder("done", [id]);
      expect(loadBoard().locals[0]!.placedAt).toBe(9000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("snooze", () => {
  const cardAt = (partial: Parameters<typeof buildBoardCards>[0]) =>
    buildBoardCards(partial)[0]!;

  it("hides until the deadline, then lets the card back", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const card = cardAt({ items: [item({ provider: "github", number: 1 })], sessions: [], summaries: [] });
      snoozeCard(card.id, { until: 20_000 });
      expect(loadBoard().snoozed[card.id]).toEqual({ until: 20_000 });
      expect(isCardSnoozed(card, loadBoard().snoozed[card.id], 15_000)).toBe(true);
      expect(isCardSnoozed(card, loadBoard().snoozed[card.id], 20_000)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes early when the card's actionable fingerprint changes", () => {
    const before = cardAt({ items: [item({ provider: "github", number: 1 })], sessions: [], summaries: [] });
    const wake = snoozeWakeKey(before);
    snoozeCard(before.id, { wake });
    expect(isCardSnoozed(before, { wake })).toBe(true);
    // CI failure flips the fingerprint — the card resurfaces.
    const failing = { ...before, ciFailing: 1 };
    expect(isCardSnoozed(failing, { wake })).toBe(false);
  });

  it("rejects a condition-less snooze and unsnooze restores", () => {
    const card = cardAt({ items: [item({ provider: "github", number: 1 })], sessions: [], summaries: [] });
    // {} has no wake condition — permanent dismissal is hideCards' job.
    snoozeCard(card.id, {});
    expect(loadBoard().snoozed[card.id]).toBeUndefined();
    snoozeCard(card.id, { until: Date.now() + 60_000 });
    expect(loadBoard().snoozed[card.id]).toBeDefined();
    unsnoozeCard(card.id);
    expect(loadBoard().snoozed[card.id]).toBeUndefined();
  });
});

describe("attention signals", () => {
  it("ranks needs-input over failing CI over a quiet card", () => {
    const [inputCard] = buildBoardCards({
      items: [item({ provider: "github", number: 1 })],
      sessions: [
        liveSession({
          id: "s1",
          linkedWorkItem: linked({ number: 1, url: "https://example.test/1" }),
        }),
      ],
      summaries: [],
    });
    // needsInput lives on the session join — fake it via the card shape.
    const needy = {
      ...inputCard!,
      sessions: [{ ...inputCard!.sessions[0]!, needsInput: true, live: true }],
    };
    const quiet = buildBoardCards({
      items: [item({ provider: "github", number: 2 })],
      sessions: [],
      summaries: [],
    })[0]!;
    const ci = { ...quiet, ciFailing: 2 };
    expect(attentionScore(needy)).toBeGreaterThan(attentionScore(ci));
    expect(attentionScore(ci)).toBeGreaterThan(attentionScore(quiet));
    expect(attentionScore(quiet)).toBe(0);
  });

  it("flags changes-requested review decisions and open threads", () => {
    const cards = buildBoardCards({
      items: [],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          id: "t1",
          workstreams: [
            {
              id: "w1",
              projectPath: "/repo",
              branch: "feat",
              base: "main",
              worktreePath: "/repo/.wt/feat",
              sessionIds: [],
            },
          ],
        }),
      ],
      workstreamStatus: new Map([
        [
          "w1",
          {
            pr: {
              number: 9,
              title: "PR",
              url: "https://example.test/pr/9",
              state: "open",
              reviewDecision: "CHANGES_REQUESTED",
              unresolvedThreads: 3,
            },
            checks: [],
          },
        ],
      ]),
    });
    const lines = cardAttentionLines(cards[0]!);
    expect(lines).toContain("Changes requested");
    expect(lines).toContain("3 open threads");
    expect(attentionScore(cards[0]!)).toBeGreaterThanOrEqual(9);
  });

  const laneCard = (
    pr: Partial<NonNullable<BoardCard["workstreams"]>[number]["pr"]>,
    checks: { bucket: string; name?: string; state?: string }[] = [],
  ) =>
    buildBoardCards({
      items: [],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          id: "t1",
          workstreams: [
            {
              id: "w1",
              projectPath: "/repo",
              branch: "feat",
              base: "main",
              worktreePath: "/repo/.wt/feat",
              sessionIds: [],
            },
          ],
        }),
      ],
      workstreamStatus: new Map([
        [
          "w1",
          {
            pr: {
              number: 9,
              title: "PR",
              url: "https://example.test/pr/9",
              state: "open",
              ...pr,
            },
            checks: checks.map((check, index) => ({
              name: check.name ?? `ci/${index}`,
              state: check.state ?? check.bucket,
              bucket: check.bucket,
              url: "",
            })),
          },
        ],
      ]),
    })[0]!;

  it("reports ready only when clean and nothing outstanding", () => {
    // clean merge state alone isn't enough — checks/votes/threads gate it.
    // Threads must be a probed zero: an unknown count isn't "no threads".
    const clean = { mergeState: "clean", unresolvedThreads: 0 };
    expect(lanePrSignal(laneCard(clean).workstreams![0]!)).toBe("ready");
    expect(
      lanePrSignal(laneCard({ mergeState: "clean" }).workstreams![0]!),
    ).toBeNull();
    expect(
      lanePrSignal(
        laneCard(clean, [{ bucket: "fail" }]).workstreams![0]!,
      ),
    ).toBeNull();
    expect(
      lanePrSignal(
        laneCard(clean, [{ bucket: "pending" }]).workstreams![0]!,
      ),
    ).toBeNull();
    expect(
      lanePrSignal(
        laneCard({ ...clean, reviewDecision: "CHANGES_REQUESTED" })
          .workstreams![0]!,
      ),
    ).toBeNull();
    expect(
      lanePrSignal(
        laneCard({ ...clean, unresolvedThreads: 2 }).workstreams![0]!,
      ),
    ).toBeNull();
    // Drafts and closed PRs never report a signal.
    expect(
      lanePrSignal(laneCard({ ...clean, draft: true }).workstreams![0]!),
    ).toBeNull();
    expect(
      lanePrSignal(
        laneCard({ ...clean, state: "merged" }).workstreams![0]!,
      ),
    ).toBeNull();
    // Awaiting review isn't ready — Azure can't distinguish optional from
    // required reviewers, and GitHub's `clean` wouldn't co-occur anyway.
    expect(
      lanePrSignal(
        laneCard({ ...clean, reviewDecision: "REVIEW_REQUIRED" })
          .workstreams![0]!,
      ),
    ).toBeNull();
  });

  it("surfaces provider merge conflicts and blocks", () => {
    expect(
      lanePrSignal(laneCard({ mergeState: "conflicts" }).workstreams![0]!),
    ).toBe("conflicts");
    expect(
      lanePrSignal(laneCard({ mergeState: "blocked" }).workstreams![0]!),
    ).toBe("blocked");
    // `unstable` (checks failing) is already covered by the CI signal.
    expect(
      lanePrSignal(laneCard({ mergeState: "unstable" }).workstreams![0]!),
    ).toBeNull();
    // Provider-side staleness has its own signal (local `behind` can't
    // reach lanes without a worktree).
    expect(
      lanePrSignal(laneCard({ mergeState: "behind" }).workstreams![0]!),
    ).toBe("behind");
    expect(
      cardAttentionLines(laneCard({ mergeState: "behind" })),
    ).toContain("Behind base");
    const card = laneCard({ mergeState: "conflicts" });
    expect(cardAttentionLines(card)).toContain("Merge conflicts");
    expect(
      cardAttentionLines(laneCard({ mergeState: "blocked" })),
    ).toContain("Merge blocked");
    expect(
      cardAttentionLines(
        laneCard({ mergeState: "clean", unresolvedThreads: 0 }),
      ),
    ).toContain("Ready to merge");
    expect(attentionScore(laneCard({ mergeState: "conflicts" }))).toBeGreaterThan(
      attentionScore(
        laneCard({ mergeState: "clean", unresolvedThreads: 0 }),
      ),
    );
    expect(
      attentionScore(
        laneCard({ mergeState: "clean", unresolvedThreads: 0 }),
      ),
    ).toBeGreaterThan(attentionScore(laneCard({})));
  });

  it("wakes a snoozed card when the merge state flips", () => {
    const before = laneCard({ mergeState: "blocked" });
    const wake = snoozeWakeKey(before);
    expect(
      isCardSnoozed(laneCard({ mergeState: "clean" }), { wake }),
    ).toBe(false);
  });

  it("says 'Ticket closed' when every linked ticket is done", () => {
    const cards = buildBoardCards({
      items: [item({ provider: "github", number: 42, kind: "issue", state: "closed" })],
      sessions: [],
      summaries: [],
      tasks: [task({ id: "t1", links: [linked({ number: 42 })] })],
    });
    const card = cards.find((entry) => entry.kind === "task")!;
    // All-closed tickets derive to Done — the nudge fires only when the
    // card's EFFECTIVE column is elsewhere (e.g. manually held in flight).
    expect(card.derived).toBe("done");
    expect(cardAttentionLines(card)).not.toContain("Ticket closed");
    expect(cardAttentionLines(card, "progress")).toContain("Ticket closed");
    // A ticket with no provider state can't claim "closed" either.
    const unknown = buildBoardCards({
      items: [],
      sessions: [],
      summaries: [],
      tasks: [task({ id: "t2", links: [linked({ number: 77 })] })],
    }).find((entry) => entry.kind === "task")!;
    expect(cardAttentionLines(unknown, "progress")).not.toContain(
      "Ticket closed",
    );
  });
});

describe("review locally", () => {
  it("maps providers to their PR head refs", () => {
    expect(prHeadRemoteRef("github", 7)).toBe("refs/pull/7/head");
    expect(prHeadRemoteRef("gitlab", 7)).toBe("refs/merge-requests/7/head");
    // Azure exposes no PR head ref — the author's source branch is the
    // real head; the merge ref is the only fallback.
    expect(
      prHeadRemoteRef("azuredevops", 7, "refs/heads/feature-x"),
    ).toBe("refs/heads/feature-x");
    expect(prHeadRemoteRef("azuredevops", 7)).toBe("refs/pull/7/merge");
  });

  it("prefers the item's own project, then a unique repo-name match", () => {
    const recents = [
      { path: "/code/app", name: "app" },
      { path: "/code/other", name: "other" },
    ] as never[];
    const pr = item({ provider: "github", number: 3, kind: "pr", projectPath: "/code/app" });
    expect(defaultReviewProject(pr, recents)).toBe("/code/app");
    // projectPath missing → unique basename match wins.
    const orphan = item({ provider: "github", number: 3, kind: "pr", projectPath: "", repo: "acme/other" });
    expect(defaultReviewProject(orphan, recents)).toBe("/code/other");
    // Ambiguous basename → no silent pick.
    const ambiguous = item({ provider: "github", number: 3, kind: "pr", projectPath: "", repo: "acme/app" });
    expect(
      defaultReviewProject(ambiguous, [
        { path: "/a/app", name: "app" },
        { path: "/b/app", name: "app" },
      ] as never[]),
    ).toBe("");
  });
});

describe("buildStandup", () => {
  it("reports done, in-flight, and planned work", () => {
    const now = Date.now();
    const todoItem = item({ provider: "github", number: 1, title: "Todo thing" });
    const flightItem = item({ provider: "github", number: 2, title: "Flight thing" });
    const cards = buildBoardCards({
      items: [todoItem, flightItem],
      sessions: [],
      summaries: [],
      tasks: [
        task({ id: "done1", title: "Shipped fix" }),
        task({
          id: "merged1",
          title: "Merged work",
          workstreams: [
            {
              id: "w1",
              projectPath: "/repo",
              branch: "feat",
              base: "main",
              worktreePath: "/repo/.wt",
              sessionIds: [],
            },
          ],
        }),
      ],
      workstreamStatus: new Map([
        [
          "w1",
          {
            pr: {
              number: 5,
              title: "PR five",
              url: "https://example.test/pr/5",
              state: "merged",
              updatedAt: new Date(now - 3600_000).toISOString(),
            },
            checks: [],
          },
        ],
      ]),
    });
    const placements = {
      done1: { column: "done", order: 0, placedAt: now - 3600_000 },
      // The lane's PR merged but the task is still in flight elsewhere —
      // the merge is its own reportable line.
      merged1: { column: "progress", order: 0, placedAt: now - 7200_000 },
      [itemCardKey(todoItem)]: { column: "todo", order: 0, placedAt: now },
      [itemCardKey(flightItem)]: {
        column: "progress",
        order: 0,
        placedAt: now,
      },
    } as never;
    const report = buildStandup({ cards, placements, locals: [], now });
    expect(report).toContain("### Done / merged");
    expect(report).toContain("Shipped fix");
    expect(report).toContain("PR #5 merged");
    expect(report).toContain("### In flight");
    expect(report).toContain("Flight thing");
    expect(report).toContain("Merged work");
    expect(report).toContain("### Plan");
    expect(report).toContain("Todo thing");
  });

  it("omits empty sections and stale merges", () => {
    const now = Date.now();
    const cards = buildBoardCards({
      items: [],
      sessions: [],
      summaries: [],
      tasks: [
        task({
          id: "old1",
          title: "Old merge",
          workstreams: [
            {
              id: "w1",
              projectPath: "/repo",
              branch: "feat",
              base: "main",
              worktreePath: "/repo/.wt",
              sessionIds: [],
            },
          ],
        }),
      ],
      workstreamStatus: new Map([
        [
          "w1",
          {
            pr: {
              number: 5,
              title: "PR",
              url: "https://example.test/pr/5",
              state: "merged",
              // Merged a week ago — outside the standup window.
              updatedAt: new Date(now - 7 * 24 * 3600_000).toISOString(),
            },
            checks: [],
          },
        ],
      ]),
    });
    // Task parked in flight — the week-old merge doesn't qualify.
    const report = buildStandup({
      cards,
      placements: {
        old1: { column: "progress", order: 0, placedAt: now },
      } as never,
      locals: [],
      now,
    });
    expect(report).not.toContain("Done / merged");
    expect(report).not.toContain("PR #5");
    expect(report).toContain("Old merge");
  });
});
