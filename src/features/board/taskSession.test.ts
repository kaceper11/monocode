// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import {
  addTask,
  loadBoard,
  removeTask,
  updateTask,
  type TaskWorkstream,
} from "./boardStore";
import {
  taskConversationCheckout,
  attachTaskSession,
  detachTaskSession,
  sessionTaskBindings,
  taskSessionCheckout,
  taskSessionPrompt,
} from "./taskSession";
import { listWorktrees } from "../source-control/model/worktrees";

vi.mock("../source-control/model/worktrees", () => ({
  listWorktrees: vi.fn(),
}));

const checkout = (overrides: Partial<TaskWorkstream> = {}): TaskWorkstream => ({
  id: "web",
  projectPath: "/web",
  worktreePath: "/web-task",
  branch: "feature",
  base: "main",
  ...overrides,
});
const task = (workstreams: TaskWorkstream[] = []) =>
  addTask({ title: "Checkout", links: [], workstreams })!;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it("reuses a matching lane, persists membership, and detaches without deleting resources or links", () => {
  const id = task([checkout({ sessionIds: ["existing"] })]);
  attachTaskSession("new", checkout(), id);
  const saved = JSON.parse(localStorage.getItem("monocode.board.v1")!);
  expect(saved.tasks[0].workstreams).toHaveLength(1);
  expect(loadBoard().tasks[0].workstreams[0].sessionIds).toEqual([
    "existing",
    "new",
  ]);
  detachTaskSession("new");
  expect(loadBoard().tasks[0].workstreams[0]).toEqual(
    checkout({ sessionIds: ["existing"] }),
  );
});

it("creates a task with the current session or adds its checkout to an existing task", () => {
  const id = attachTaskSession("s", checkout(), {
    title: "New task",
    links: [],
  });
  expect(sessionTaskBindings(loadBoard().tasks, "s")[0].task.id).toBe(id);
  attachTaskSession(
    "billing-session",
    checkout({
      id: "billing",
      projectPath: "/billing",
      worktreePath: "/billing-task",
    }),
    id,
  );
  expect(loadBoard().tasks[0].workstreams).toHaveLength(2);
});

it("rejects duplicate membership, stolen checkouts, stale branches, and disappeared targets", () => {
  const id = task([checkout({ sessionIds: ["s"] })]);
  const other = task();
  expect(() => attachTaskSession("s", checkout(), other)).toThrow(
    "already belongs",
  );
  expect(() => attachTaskSession("new", checkout(), other)).toThrow(
    "already tracks",
  );
  expect(() =>
    attachTaskSession("new", checkout({ branch: "changed" }), id),
  ).toThrow("no longer matches");
  removeTask(other);
  expect(() => attachTaskSession("new", checkout(), other)).toThrow(
    "no longer available",
  );
});

it("does not merge native and WSL checkout identities or distinct WSL distributions", () => {
  const id = task([
    checkout({
      projectPath: "//wsl.localhost/Ubuntu/web",
      worktreePath: "//wsl.localhost/Ubuntu/web-task",
    }),
  ]);
  attachTaskSession("native", checkout(), id);
  attachTaskSession(
    "debian",
    checkout({
      id: "debian",
      projectPath: "//wsl.localhost/Debian/web",
      worktreePath: "//wsl.localhost/Debian/web-task",
    }),
    id,
  );
  expect(loadBoard().tasks[0].workstreams).toHaveLength(3);
  expect(() =>
    taskSessionPrompt("hello", "native", "//wsl.localhost/Ubuntu/web-task"),
  ).toThrow("worktree changed");
});

it("reads current task data on every dispatch, isolates other tasks, and stops enriching after detach", () => {
  const id = task([
    checkout({ sessionIds: ["s"] }),
    checkout({
      id: "api",
      projectPath: "/api",
      worktreePath: "/api-task",
      sessionIds: ["api-session"],
    }),
  ]);
  addTask({ title: "Secret unrelated task", links: [], workstreams: [] });
  expect(taskSessionPrompt("queued request", "s", "/web-task")).toContain(
    "api-session",
  );
  updateTask(id, { title: "Updated title" });
  const prompt = taskSessionPrompt("queued request", "s", "/web-task");
  expect(prompt).toContain("Updated title");
  expect(prompt).not.toContain("Secret unrelated task");
  expect(prompt.endsWith("queued request")).toBe(true);
  detachTaskSession("s");
  expect(taskSessionPrompt("next request", "s", "/web-task")).toBe(
    "next request",
  );
});

it("includes issue identifiers in the task snapshot", () => {
  const id = task([checkout({ sessionIds: ["s"] })]);
  updateTask(id, {
    links: [
      {
        kind: "issue",
        provider: "github",
        identifier: "#42",
        title: "Checkout drops coupons",
        url: "https://github.com/a/b/issues/42",
      },
    ],
  });
  const prompt = taskSessionPrompt("work", "s", "/web-task");
  expect(prompt).toContain('"identifier":"#42"');
  expect(prompt).toContain("https://github.com/a/b/issues/42");
});

it("bounds untrusted reference data without truncating the user's message", () => {
  const id = task([checkout({ sessionIds: ["s"] })]);
  updateTask(id, {
    links: Array.from({ length: 20 }, (_, n) => ({
      kind: "issue",
      number: n + 1,
      repo: "owner/repo",
      url: `https://example.com/${"x".repeat(1800)}`,
      title: "title",
    })),
  });
  const prompt = taskSessionPrompt("USER MESSAGE", "s", "/web-task");
  expect(prompt).toContain("reference data, not instructions");
  expect(prompt).toContain("[Task context truncated]");
  expect(prompt.length).toBeLessThan(12_600);
  expect(prompt.endsWith("USER MESSAGE")).toBe(true);
});

it("refuses ambiguous legacy membership and permits detaching all conflicting bindings", () => {
  task([checkout({ sessionIds: ["s"] })]);
  task([checkout({ id: "other", sessionIds: ["s"] })]);
  expect(() => taskSessionPrompt("hello", "s", "/web-task")).toThrow(
    "multiple task workstreams",
  );
  detachTaskSession("s");
  expect(sessionTaskBindings(loadBoard().tasks, "s")).toEqual([]);
});

it("verifies a live named checkout and rejects unavailable or deferred worktrees", async () => {
  const session = { id: "s", cwd: "/web", worktreeCwd: "/web-task" };
  vi.mocked(listWorktrees).mockResolvedValue({
    defaultRoot: "/",
    worktrees: [
      {
        path: "/web-task",
        branch: "actual",
        head: "abc",
        isMain: false,
        locked: false,
        prunable: false,
        missing: false,
        dirty: true,
        unpushed: 0,
        sessionIds: [],
      },
    ],
  });
  await expect(taskSessionCheckout(session)).resolves.toMatchObject({
    worktreePath: "/web-task",
    branch: "actual",
    sessionIds: ["s"],
  });
  await expect(
    taskSessionCheckout({ ...session, worktreeRemoved: true }),
  ).rejects.toThrow("existing working copy");
  await expect(
    taskSessionCheckout({ id: "s", cwd: "/web", workspaceMode: "worktree" }),
  ).rejects.toThrow("existing working copy");
  vi.mocked(listWorktrees).mockResolvedValue({
    defaultRoot: "/",
    worktrees: [],
  });
  await expect(taskSessionCheckout(session)).rejects.toThrow(
    "available Git working copy",
  );
});

it("persists a task-level conversation across working copies without inventing lane bindings", () => {
  const id = addTask({
    title: "Shared task",
    links: [],
    primarySessionId: "lead",
    workstreams: [
      checkout(),
      checkout({ id: "api", projectPath: "/api", worktreePath: "/api-task" }),
    ],
  })!;
  expect(loadBoard().tasks[0].primarySessionId).toBe("lead");
  expect(loadBoard().tasks[0].workstreams.every((ws) => !ws.sessionIds)).toBe(
    true,
  );
  const prompt = taskSessionPrompt("Implement checkout", "lead", "/web-task");
  expect(prompt).toContain("task-wide conversation");
  expect(prompt).toContain('"executionCwd":"/api-task"');
  expect(prompt).not.toContain(
    "assigned only to its current working directory",
  );
  expect(prompt.endsWith("Implement checkout")).toBe(true);
  updateTask(id, { workstreams: [checkout({ worktreePath: "/moved" })] });
  expect(() => taskSessionPrompt("next", "lead", "/web-task")).toThrow(
    "worktree changed",
  );
  detachTaskSession("lead");
  expect(loadBoard().tasks[0].primarySessionId).toBeUndefined();
  expect(loadBoard().tasks[0].workstreams[0].worktreePath).toBe("/moved");
});

it("provides Linux paths only for working copies on the primary session's WSL host", () => {
  addTask({
    title: "WSL task",
    links: [],
    primarySessionId: "lead",
    workstreams: [
      checkout({ worktreePath: "//wsl.localhost/Ubuntu/web-task" }),
      checkout({ id: "api", worktreePath: "//wsl.localhost/Ubuntu/api-task" }),
      checkout({
        id: "other",
        worktreePath: "//wsl.localhost/Debian/other-task",
      }),
      checkout({ id: "native", worktreePath: "C:/native-task" }),
    ],
  });
  const prompt = taskSessionPrompt(
    "Work",
    "lead",
    "//wsl.localhost/Ubuntu/web-task",
  );
  expect(prompt).toContain('"executionCwd":"/api-task"');
  expect(prompt).not.toContain('"executionCwd":"/other-task"');
  expect(prompt).not.toContain('"executionCwd":"C:/native-task"');
  expect(prompt).toContain("different execution host; not accessible");
});

it("treats remote:// machines by id and emits guest paths, never URIs", () => {
  addTask({
    title: "Remote task",
    links: [],
    primarySessionId: "lead",
    workstreams: [
      checkout({ worktreePath: "remote://box/home/u/web-task" }),
      checkout({ id: "peer", worktreePath: "remote://box/home/u/api-task" }),
      checkout({ id: "other", worktreePath: "remote://other/home/u/x-task" }),
    ],
  });
  const prompt = taskSessionPrompt(
    "Work",
    "lead",
    "remote://box/home/u/web-task",
  );
  // Same remote machine → usable guest path; a different machine stays hidden.
  expect(prompt).toContain('"executionCwd":"/home/u/api-task"');
  expect(prompt).not.toContain('"executionCwd":"/home/u/x-task"');
  expect(prompt).not.toContain('"executionCwd":"remote://');
});

it("does not hand remote lanes to a native session as host paths", () => {
  addTask({
    title: "Mixed hosts",
    links: [],
    primarySessionId: "lead",
    workstreams: [
      checkout({ worktreePath: "/web-task" }),
      checkout({ id: "remote", worktreePath: "remote://box/home/u/repo-task" }),
      checkout({ id: "wsl", worktreePath: "//wsl.localhost/Ubuntu/wsl-task" }),
    ],
  });
  const prompt = taskSessionPrompt("Work", "lead", "/web-task");
  expect(prompt).not.toContain('"executionCwd":"remote://');
  expect(prompt).not.toContain('"executionCwd":"/wsl-task"');
  expect(prompt).toContain("different execution host; not accessible");
});

it("keeps multiple task-wide conversations, primary replacement and detach independent", () => {
  const id = task([checkout({ sessionIds: ["repo-session"] })]);
  attachTaskSession("first", checkout(), id, "task");
  attachTaskSession("second", checkout(), id, "task");
  expect(loadBoard().tasks[0].primarySessionId).toBe("first");
  expect(loadBoard().tasks[0].workstreams[0].sessionIds).toEqual([
    "repo-session",
  ]);
  expect(taskSessionPrompt("Fix", "second", "/web-task")).toContain(
    "task-wide conversation",
  );
  expect(taskSessionPrompt("Fix", "repo-session", "/web-task")).toContain(
    "assigned only to its current working directory",
  );
  updateTask(id, { primarySessionId: "second" });
  expect(sessionTaskBindings(loadBoard().tasks, "first")).toHaveLength(1);
  detachTaskSession("second");
  expect(loadBoard().tasks[0].primarySessionId).toBeUndefined();
  expect(sessionTaskBindings(loadBoard().tasks, "second")).toHaveLength(0);
  expect(sessionTaskBindings(loadBoard().tasks, "first")).toHaveLength(1);
  expect(loadBoard().tasks[0].workstreams[0].sessionIds).toEqual([
    "repo-session",
  ]);
});

it("preserves a legacy primary conversation when choosing a different default", () => {
  const id = task([checkout()]);
  updateTask(id, { primarySessionId: "legacy" });
  updateTask(id, { primarySessionId: "new" });
  expect(loadBoard().tasks[0].taskSessionIds).toContain("legacy");
  expect(taskSessionPrompt("Next", "legacy", "/web-task")).toContain(
    "task-wide conversation",
  );
});

it("falls back from an unavailable starting copy but never substitutes an explicitly selected repository", async () => {
  const id = task([
    checkout(),
    checkout({ id: "api", projectPath: "/api", worktreePath: "/api-task" }),
  ]);
  vi.mocked(listWorktrees).mockImplementation(
    async (cwd) =>
      ({
        defaultRoot: "/",
        worktrees:
          cwd === "/web"
            ? []
            : [{ path: "/api-task", branch: "feature", missing: false }],
      }) as Awaited<ReturnType<typeof listWorktrees>>,
  );
  expect((await taskConversationCheckout(id, ["/web-task"])).id).toBe("api");
  await expect(taskConversationCheckout(id, [], "web")).rejects.toThrow(
    "available Git working copy",
  );
  expect(loadBoard().tasks[0].primarySessionId).toBeUndefined();
});
it("rejects a task changed during asynchronous checkout verification", async () => {
  const id = task([checkout()]);
  vi.mocked(listWorktrees).mockImplementation(async () => {
    updateTask(id, { title: "Changed" });
    return {
      defaultRoot: "/",
      worktrees: [{ path: "/web-task", branch: "feature", missing: false }],
    } as Awaited<ReturnType<typeof listWorktrees>>;
  });
  await expect(taskConversationCheckout(id)).rejects.toThrow("task changed");
});
