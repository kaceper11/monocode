// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { addTask, loadBoard, updateTask } from "./boardStore";
import {
  assertTaskCopySelection,
  detachTaskWorkingCopy,
  runTaskWorktreeAction,
  type TaskWorktreeTarget,
} from "./taskWorktrees";
import {
  createWorktree,
  listWorktrees,
  renameWorktreeBranchExplicit,
  type Worktree,
} from "../source-control/model/worktrees";
import { gitTaskBranch } from "../../platform/tauri/fs";
import { getSession } from "../sessions/data/sessionStore";
import type { Session } from "../sessions/model/session";

vi.mock("../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../platform/tauri/fs")>()),
  gitTaskBranch: vi.fn(),
}));
vi.mock("../sessions/data/sessionStore", () => ({ getSession: vi.fn() }));
vi.mock("../source-control/model/worktrees", async (original) => ({
  ...(await original<typeof import("../source-control/model/worktrees")>()),
  listWorktrees: vi.fn(),
  createWorktree: vi.fn(),
  renameWorktreeBranchExplicit: vi.fn(),
}));
const tree: Worktree = {
  path: "/copy",
  branch: "feature",
  head: "abc",
  isMain: false,
  missing: false,
  prunable: false,
  locked: false,
  dirty: false,
  unpushed: 0,
  sessionIds: ["chat"],
};
const chat = {
  id: "chat",
  cwd: "/repo",
  worktreeCwd: "/copy",
  branch: "feature",
  busy: false,
} as Session;
let sessions: Session[];
let target: TaskWorktreeTarget;
let host: Parameters<typeof runTaskWorktreeAction>[1];
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  sessions = [chat];
  addTask({
    title: "Task",
    links: [],
    workstreams: [
      {
        id: "lane",
        projectPath: "/repo",
        worktreePath: "/copy",
        branch: "feature",
        base: "main",
        sessionIds: ["chat"],
        prUrl: "https://example/pr/1",
      },
    ],
  });
  const task = loadBoard().tasks[0];
  target = {
    taskId: task.id,
    laneId: "lane",
    projectPath: "/repo",
    path: "/copy",
    branch: "feature",
    base: "main",
    expectedTask: task,
  };
  vi.mocked(listWorktrees).mockResolvedValue({
    worktrees: [tree],
    defaultRoot: "/copies",
  });
  vi.mocked(getSession).mockResolvedValue(chat);
  vi.mocked(renameWorktreeBranchExplicit).mockResolvedValue({
    ...tree,
    branch: "renamed",
  });
  vi.mocked(gitTaskBranch).mockResolvedValue("other");
  vi.mocked(createWorktree).mockResolvedValue({
    ...tree,
    path: "/new",
    branch: "new",
  });
  host = {
    sessions: () => sessions,
    renameSessionBranches: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    lockSessions: vi.fn(async (_ids, _path, run) => run()),
  };
});
it("renames a manual branch and reconciles task metadata without moving conversations", async () => {
  const result = await runTaskWorktreeAction(
    { kind: "rename", target, branch: "renamed" },
    host,
  );
  expect(renameWorktreeBranchExplicit).toHaveBeenCalledWith(
    "/repo",
    "/copy",
    "feature",
    "renamed",
  );
  expect(host.renameSessionBranches).toHaveBeenCalledWith(["chat"], "renamed");
  expect(host.lockSessions).toHaveBeenCalledWith(
    ["chat"],
    "/copy",
    expect.any(Function),
  );
  expect(result.task?.workstreams[0]).toMatchObject({
    branch: "renamed",
    worktreePath: "/copy",
    sessionIds: ["chat"],
  });
  expect(result.task?.workstreams[0].prUrl).toBeUndefined();
  expect(chat.worktreeCwd).toBe("/copy");
});
it("switches using an exact remote base and clears stale delivery identity", async () => {
  await runTaskWorktreeAction(
    { kind: "switch", target, branch: "refs/remotes/origin/other" },
    host,
  );
  expect(gitTaskBranch).toHaveBeenCalledWith(
    "/copy",
    "feature",
    "refs/remotes/origin/other",
    "origin/other",
    "switch",
  );
  expect(loadBoard().tasks[0].workstreams[0]).toMatchObject({
    branch: "other",
    base: "origin/other",
  });
});
it.each([
  { ...tree, isMain: true },
  { ...tree, locked: true },
  { ...tree, missing: true },
  { ...tree, prunable: true },
  { ...tree, branch: "changed" },
  { ...tree, branch: null },
])(
  "refuses mutation of protected, unavailable, or changed copies: %j",
  async (stale) => {
    vi.mocked(listWorktrees).mockResolvedValue({
      worktrees: [stale],
      defaultRoot: "/",
    });
    await expect(
      runTaskWorktreeAction(
        { kind: "rename", target, branch: "renamed" },
        host,
      ),
    ).rejects.toThrow();
    expect(renameWorktreeBranchExplicit).not.toHaveBeenCalled();
  },
);
it.each([true, null])(
  "requires a known clean checkout before switching: %s",
  async (dirty) => {
    vi.mocked(listWorktrees).mockResolvedValue({
      worktrees: [{ ...tree, dirty }],
      defaultRoot: "/",
    });
    await expect(
      runTaskWorktreeAction({ kind: "switch", target, branch: "other" }, host),
    ).rejects.toThrow("Commit or stash");
    expect(gitTaskBranch).not.toHaveBeenCalled();
  },
);
it("offers occupied branches through copy selection instead of switching twice", async () => {
  vi.mocked(listWorktrees).mockResolvedValue({
    worktrees: [
      tree,
      { ...tree, path: "/other", branch: "other", sessionIds: [] },
    ],
    defaultRoot: "/",
  });
  await expect(
    runTaskWorktreeAction({ kind: "switch", target, branch: "other" }, host),
  ).rejects.toThrow("Select that working copy");
  expect(gitTaskBranch).not.toHaveBeenCalled();
});
it("rejects ownership races and stale editor baselines before Git mutations", async () => {
  vi.mocked(listWorktrees).mockImplementationOnce(async () => {
    addTask({
      title: "Owner",
      links: [],
      workstreams: [
        { id: "other", projectPath: "/repo", branch: "renamed", base: "main" },
      ],
    });
    return { worktrees: [tree], defaultRoot: "/" };
  });
  await expect(
    runTaskWorktreeAction({ kind: "rename", target, branch: "renamed" }, host),
  ).rejects.toThrow("already owns");
  expect(renameWorktreeBranchExplicit).not.toHaveBeenCalled();
  updateTask(target.taskId!, { title: "Changed elsewhere" });
  await expect(
    runTaskWorktreeAction({ kind: "delete", target }, host),
  ).rejects.toThrow("Task changed");
  expect(host.remove).not.toHaveBeenCalled();
});
it("blocks live and task-wide agents, including a start during the final reservation", async () => {
  sessions = [{ ...chat, busy: true }];
  await expect(
    runTaskWorktreeAction({ kind: "rename", target, branch: "renamed" }, host),
  ).rejects.toThrow("working agents");
  sessions = [chat];
  vi.mocked(host.lockSessions).mockImplementationOnce(
    async (_ids, _path, run) => {
      sessions = [{ ...chat, worktreePreparing: true }];
      return run();
    },
  );
  await expect(
    runTaskWorktreeAction({ kind: "rename", target, branch: "renamed" }, host),
  ).rejects.toThrow("agent started");
  expect(renameWorktreeBranchExplicit).not.toHaveBeenCalled();
});
it("keeps conversation records and commits while explicitly deleting files and detaching memberships", async () => {
  updateTask(target.taskId!, {
    primarySessionId: "chat",
    taskSessionIds: ["chat"],
  });
  target.expectedTask = loadBoard().tasks[0];
  const result = await runTaskWorktreeAction({ kind: "delete", target }, host);
  expect(host.remove).toHaveBeenCalledWith("/repo", "/copy", true, true);
  expect(result.task?.workstreams[0]).toMatchObject({
    branch: "feature",
    prUrl: "https://example/pr/1",
  });
  expect(result.task?.workstreams[0].worktreePath).toBeUndefined();
  expect(result.task?.primarySessionId).toBeUndefined();
  expect(result.task?.taskSessionIds ?? []).toEqual([]);
  expect(host.renameSessionBranches).not.toHaveBeenCalled();
});
it("does not detach the task after failed removal", async () => {
  vi.mocked(host.remove).mockRejectedValueOnce(
    new Error("Open files block deletion"),
  );
  await expect(
    runTaskWorktreeAction({ kind: "delete", target }, host),
  ).rejects.toThrow("Open files");
  expect(loadBoard().tasks[0]).toEqual(target.expectedTask);
});
it("preserves unrelated concurrent edits and reports a completed Git action", async () => {
  vi.mocked(renameWorktreeBranchExplicit).mockImplementationOnce(async () => {
    updateTask(target.taskId!, { title: "Concurrent title" });
    return { ...tree, branch: "renamed" };
  });
  await expect(
    runTaskWorktreeAction({ kind: "rename", target, branch: "renamed" }, host),
  ).rejects.toThrow("Git rename completed");
  expect(loadBoard().tasks[0].title).toBe("Concurrent title");
});
it("creates a separate copy without binding the task and refuses occupied branches", async () => {
  const result = await runTaskWorktreeAction(
    {
      kind: "create",
      target,
      branch: "new",
      base: "origin/main",
      existing: false,
    },
    host,
  );
  expect(createWorktree).toHaveBeenCalledWith(
    "/repo",
    "new",
    "origin/main",
    false,
  );
  expect(result.tree?.path).toBe("/new");
  expect(loadBoard().tasks[0]).toEqual(target.expectedTask);
  await expect(
    runTaskWorktreeAction(
      {
        kind: "create",
        target,
        branch: "feature",
        base: "HEAD",
        existing: true,
      },
      host,
    ),
  ).rejects.toThrow("Select it from the picker");
});
it("requires explicit conversation detachment when selecting another copy", async () => {
  await expect(
    assertTaskCopySelection(target, "/other", sessions),
  ).rejects.toThrow("Detach conversations");
  const detached = await detachTaskWorkingCopy(target, sessions);
  expect(detached.task?.workstreams[0].sessionIds ?? []).toEqual([]);
  expect(detached.task?.workstreams[0].worktreePath).toBeUndefined();
  expect(chat.worktreeCwd).toBe("/copy");
});
