// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskDetailsPanel } from "./TaskDetailsPanel";
import { addTask, loadBoard } from "./boardStore";
import { worktreeOnBranch } from "./taskOps";
import { gitTaskBranch } from "../../platform/tauri/fs";
import type { BoardCard } from "./boardData";

vi.mock("../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../platform/tauri/fs")>()),
  subscribeGitChanged: vi.fn(() => () => {}),
  gitTaskBranch: vi.fn(async () => "feature/checkout"),
}));
vi.mock("./taskOps", async (original) => ({
  ...(await original<typeof import("./taskOps")>()),
  worktreeOnBranch: vi.fn(async () => null),
}));

let root: Root;
let host: HTMLDivElement;

const sectionOrder = () =>
  [...document.querySelectorAll("#task-pane-overview h3")].map(
    (h) => h.textContent,
  );

const baseProps = {
  lanes: [],
  items: [],
  recents: [],
  sessions: [],
  wsStatus: new Map(),
  busyAction: new Set<string>(),
  results: new Map(),
  onDismissResult: vi.fn(),
  onClose: vi.fn(),
  onOpenSession: vi.fn(),
  onSessionCreated: vi.fn(),
  onSendToSession: vi.fn(async () => true),
  onHandoff: vi.fn(),
  onPrepareWorktree: vi.fn(async () => "/copy"),
  onSpawnSession: vi.fn(async () => ({
    sessionId: "s-new",
    worktreePath: "/copy",
  })),
  onUpdateBranches: vi.fn(),
  onUpdateWorkstream: vi.fn(),
  onSubmitPrs: vi.fn(async () => {}),
  onCleanupWorkstream: vi.fn(async () => {}),
} as const;

const render = async (
  card: BoardCard,
  props: Partial<Parameters<typeof TaskDetailsPanel>[0]> = {},
) =>
  act(async () =>
    root.render(
      createElement(TaskDetailsPanel, { ...baseProps, card, ...props }),
    ),
  );

const taskCard = (task: BoardCard["task"], extra: Partial<BoardCard> = {}): BoardCard => ({
  id: `task:${task!.id}`,
  kind: "task",
  title: task!.title,
  task,
  workstreams: task!.workstreams.map((ws) => ({
    ...ws,
    sessionIds: [],
    sessions: [],
    ciTotal: 0,
    ciFailing: 0,
    ciRunning: 0,
  })),
  sessions: [],
  groups: [],
  prs: [],
  hasUpdate: false,
  ciTotal: 0,
  ciFailing: 0,
  ciRunning: 0,
  updatedAt: 0,
  derived: "todo",
  ...extra,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("leads with linked issues, then conversations, then repository lanes", async () => {
  await act(async () => {
    addTask({
      title: "Checkout rework",
      links: [
        {
          kind: "issue",
          provider: "github",
          identifier: "#42",
          title: "Checkout drops coupons",
          url: "https://github.com/a/b/issues/42",
        },
      ],
      workstreams: [
        {
          id: "ws-1",
          projectPath: "/repo",
          branch: "feature/checkout",
          base: "main",
        },
      ],
    });
  });
  const task = loadBoard().tasks[0];
  await render(
    taskCard(task, {
      tickets: [
        {
          key: "k",
          provider: "github",
          identifier: "#42",
          title: "Checkout drops coupons",
          url: "https://github.com/a/b/issues/42",
          state: "Open",
          kind: "issue",
        },
      ],
    }),
  );

  const labels = sectionOrder();
  expect(labels).toEqual([
    "Issues",
    "Groups",
    "Conversations",
    "Repositories",
  ]);
  // Issue identity is on the row, not hidden behind the edit dialog.
  const overview = document.getElementById("task-pane-overview")!;
  expect(overview.textContent).toContain("#42");
  expect(overview.textContent).toContain("Checkout drops coupons");
  // The lane carries its branch identity prominently — branch → base in mono.
  const branchLine = overview.querySelector(".font-mono");
  expect(branchLine?.textContent).toBe("feature/checkout");
  expect(branchLine?.parentElement?.textContent).toContain("→ main");
});

it("lets the user dismiss a lane's action result", async () => {
  await act(async () => {
    addTask({
      title: "Checkout rework",
      links: [],
      workstreams: [
        {
          id: "ws-1",
          projectPath: "/repo",
          branch: "feature/checkout",
          base: "main",
        },
      ],
    });
  });
  const task = loadBoard().tasks[0];
  const wsId = task.workstreams[0].id;
  const onDismissResult = vi.fn();
  await render(taskCard(task), {
    onDismissResult,
    results: new Map([
      [wsId, { workstreamId: wsId, ok: true, message: "Merged main" }],
    ]),
  });

  const banner = [...document.querySelectorAll('[role="status"]')].find(
    (el) => el.textContent?.includes("Update completed"),
  );
  expect(banner?.textContent).toContain("Merged main");
  await act(async () =>
    banner!.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss message"]',
    )!.click(),
  );
  expect(onDismissResult).toHaveBeenCalledWith(wsId);
});

it("opens the selected conversation through onOpenSession", async () => {
  await act(async () => {
    addTask({
      title: "Checkout rework",
      links: [],
      primarySessionId: "s-primary",
      workstreams: [],
    });
  });
  const task = loadBoard().tasks[0];
  const onOpenSession = vi.fn();
  await render(taskCard(task), { onOpenSession });

  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((el) => el.textContent === "Open")!
      .click(),
  );
  expect(onOpenSession).toHaveBeenCalledWith("s-primary");
});

it("creates another task conversation beside the primary one", async () => {
  await act(async () => {
    addTask({
      title: "Checkout rework",
      links: [],
      primarySessionId: "s-primary",
      workstreams: [
        {
          id: "ws-1",
          projectPath: "/repo",
          branch: "feature/checkout",
          base: "main",
          worktreePath: "/copy",
        },
      ],
    });
  });
  const task = loadBoard().tasks[0];
  const onSpawnSession = vi.fn(async () => ({
    sessionId: "s-new",
    worktreePath: "/copy",
  }));
  const onSessionCreated = vi.fn();
  await render(taskCard(task), { onSpawnSession, onSessionCreated });

  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((el) => el.textContent === "New conversation")!
      .click(),
  );
  expect(onSpawnSession).toHaveBeenCalledWith(
    expect.objectContaining({ worktreePath: "/copy" }),
  );
  const stored = loadBoard().tasks[0];
  // Task-wide binding; the existing primary is untouched.
  expect(stored.primarySessionId).toBe("s-primary");
  expect(stored.taskSessionIds).toEqual(["s-new"]);
  expect(onSessionCreated).toHaveBeenCalledWith("s-new");
});

it("surfaces a spawn failure instead of silently doing nothing", async () => {
  await act(async () => {
    addTask({
      title: "Checkout rework",
      links: [],
      workstreams: [
        {
          id: "ws-1",
          projectPath: "/repo",
          branch: "feature/checkout",
          base: "main",
          worktreePath: "/copy",
        },
      ],
    });
  });
  const task = loadBoard().tasks[0];
  const onSpawnSession = vi.fn(async () => {
    throw new Error("Worktree is gone");
  });
  await render(taskCard(task), { onSpawnSession });

  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((el) => el.textContent === "New conversation")!
      .click(),
  );
  expect(document.body.textContent).toContain("Worktree is gone");
  expect(loadBoard().tasks[0].taskSessionIds ?? []).toEqual([]);
});

it("pulls the lane's own upstream — never the base branch", async () => {
  await act(async () => {
    addTask({
      title: "Checkout rework",
      links: [],
      workstreams: [
        {
          id: "ws-1",
          projectPath: "/repo",
          branch: "feature/checkout",
          base: "main",
          worktreePath: "/copy",
        },
      ],
    });
  });
  const task = loadBoard().tasks[0];
  vi.mocked(gitTaskBranch).mockClear();
  await render(taskCard(task));
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        'button[aria-label*="repo repository"]',
      )!
      .click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((el) => el.textContent === "Pull")!
      .click(),
  );
  expect(gitTaskBranch).toHaveBeenCalledWith(
    "/copy",
    "feature/checkout",
    "",
    "main",
    "update",
  );
});

it("routes to Edit task when no lane has a working copy", async () => {
  await act(async () => {
    addTask({
      title: "Checkout rework",
      links: [],
      workstreams: [
        {
          id: "ws-1",
          projectPath: "/repo",
          branch: "feature/checkout",
          base: "main",
        },
      ],
    });
  });
  const task = loadBoard().tasks[0];
  const onSpawnSession = vi.fn();
  await render(taskCard(task), { onSpawnSession });

  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((el) => el.textContent === "New conversation")!
      .click(),
  );
  expect(onSpawnSession).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Edit task");
});

it("surfaces the bind offer from a collapsed lane's Prepare worktree", async () => {
  await act(async () => {
    addTask({
      title: "Checkout rework",
      links: [],
      workstreams: [
        {
          id: "ws-1",
          projectPath: "/repo",
          branch: "feature/checkout",
          base: "main",
        },
      ],
    });
  });
  const task = loadBoard().tasks[0];
  vi.mocked(worktreeOnBranch).mockResolvedValue({
    path: "/existing-copy",
  } as Awaited<ReturnType<typeof worktreeOnBranch>>);
  const onPrepareWorktree = vi.fn(async () => "/existing-copy");
  await render(taskCard(task), { onPrepareWorktree });

  // The lane is collapsed — the clash offer must still be reachable.
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((el) => el.textContent === "Prepare worktree")!
      .click(),
  );
  const offer = [...document.querySelectorAll('[role="status"]')].find((el) =>
    el.textContent?.includes("Worktree exists"),
  );
  expect(offer?.textContent).toContain("/existing-copy");
  await act(async () =>
    offer!.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(onPrepareWorktree).toHaveBeenCalledWith(
    expect.objectContaining({ worktreePath: "/existing-copy" }),
  );
  expect(loadBoard().tasks[0].workstreams[0].worktreePath).toBe(
    "/existing-copy",
  );
});

it("opens a repository workspace through navigation without preparing or dispatching work", async () => {
  const id = addTask({ title: "Task", links: [], workstreams: [{ id: "lane", projectPath: "/repo", worktreePath: "/copy", branch: "feature", base: "main" }] })!;
  const task = loadBoard().tasks.find(task => task.id === id)!;
  const open = vi.fn();
  await render(taskCard(task), { onOpenWorkingCopy: open });
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Open working copy"))!;
  await act(async () => button.click());
  expect(open).toHaveBeenCalledExactlyOnceWith(id, "lane");
});
