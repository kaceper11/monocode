// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskScopeChip } from "./TaskScopeChip";
import {
  createTask,
  loadTaskWorkspaces,
  markTaskChildLaunching,
  taskForSession,
  unmarkTaskChildLaunching,
  updateTask,
  updateTaskChild,
} from "../lib/taskWorkspaces";
import { ensureProjectForPath } from "../lib/projects";
import { saveCiSources } from "../lib/azurePipelines";
import type { RepositoryFamily } from "../lib/repositoryFamilies";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { cwd?: string }) =>
    command === "git_diff_stats"
      ? args?.cwd === "/tmp/lib-wt"
        ? { files: 2, additions: 5, deletions: 1, branch: "feat/lib" }
        : { files: 0, additions: 0, deletions: 0, branch: "main" }
      : null,
  ),
}));

/** A task whose own session is rooted in `first` while lastActiveChildId
 * points at `second` — the chip should follow the cwd, not the click. */
function seedTask() {
  const project = ensureProjectForPath("/tmp/app", {
    commonDir: "/tmp/app/.git",
    checkout: "/tmp/app",
    worktrees: [],
  } as RepositoryFamily);
  const [repo] = project.repositories;
  const task = createTask({
    projectId: project.id,
    name: "Checkout",
    children: [
      { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-wt" },
    ],
  });
  updateTask(task.id, (current) => ({
    ...current,
    // A second checkout of the same repository is legal only under its
    // own attempt — one child per (attempt, repository).
    attempts: [...current.attempts, { id: "a2", createdAt: Date.now() }],
    children: [
      ...current.children,
      {
        id: "child-2",
        repositoryId: repo.id,
        attemptId: "a2",
        workingCopy: "/tmp/lib-wt",
        sessionIds: [],
        launch: { state: "pending" as const },
      },
    ],
    sessionIds: ["task-session"],
    lastActiveChildId: "child-2",
  }));
  return { taskId: task.id, secondId: "child-2" };
}

describe("TaskScopeChip", () => {
  let host: HTMLDivElement;
  let root: Root;

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
    localStorage.clear();
  });

  it("marks the child matching the session's working copy as Current", async () => {
    seedTask();
    await act(async () => {
      root.render(
        createElement(TaskScopeChip, {
          scope: taskForSession("task-session", "/tmp/app-wt"),
        }),
      );
    });
    const chip = host.querySelector("button");
    expect(chip?.textContent).toContain("Checkout");
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The cwd-matched child is Current; lastActiveChildId's row shows its
    // own working-copy path instead.
    const rows = [...document.body.querySelectorAll("button")].map(
      (el) => el.textContent ?? "",
    );
    const current = rows.find((text) => text.includes("Current"));
    expect(current).toBeTruthy();
    expect(current).not.toContain("lib-wt");
    expect(rows.some((text) => text.includes("lib-wt"))).toBe(true);
  });

  it("shows a launching child as working, not as a dead Start button", async () => {
    const { taskId, secondId } = seedTask();
    const rerender = async () => {
      await act(async () => {
        root.render(
          createElement(TaskScopeChip, {
            scope: taskForSession("task-session", "/tmp/app-wt"),
          }),
        );
      });
    };
    await rerender();
    markTaskChildLaunching(taskId, secondId);
    await act(async () => {
      updateTaskChild(taskId, secondId, { launch: { state: "working" } });
    });
    // The pane re-derives scope from the store on each write — mirror that.
    await rerender();
    try {
      const chip = host.querySelector("button");
      await act(async () => {
        chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      // A live working launch keeps its spinner — no dead "Start" button.
      expect(document.body.textContent).not.toContain("Start");
      expect(document.body.querySelector(".animate-spin")).toBeTruthy();
    } finally {
      unmarkTaskChildLaunching(taskId, secondId);
    }
  });

  it("shows branch, change stats and delivery badges per child", async () => {
    const { taskId, secondId } = seedTask();
    await act(async () =>
      updateTaskChild(taskId, secondId, {
        branch: "feat/lib",
        launch: { state: "ready" },
      }),
    );
    // A failed pipeline linked to the second child under the task session.
    const target = {
      site: "https://dev.azure.com/team",
      accountId: "ada",
      project: "project",
      definition: 7,
      repositoryId: "team/lib",
      repositoryType: "TfsGit",
      repositoryUrl: "https://dev.azure.com/team/project/_git/lib",
    };
    saveCiSources(
      [
        {
          target,
          cwd: "/tmp/lib-wt",
          branch: "feat/lib",
          session: "task-session",
          remote: target.repositoryUrl,
          definitionName: "Unit tests",
          projectName: "Project",
          last: {
            commit: "abc",
            checkedAt: 1,
            run: {
              id: 9,
              number: "1",
              status: "completed",
              result: "failed",
              branch: "refs/heads/feat/lib",
              commit: "abc",
              queuedAt: "2024-01-01T00:00:00Z",
              revision: "abc",
              match: "exact" as const,
            },
          },
        },
      ],
      "/tmp/lib-wt",
      "feat/lib",
      "task-session",
    );
    await act(async () => {
      root.render(
        createElement(TaskScopeChip, {
          scope: taskForSession("task-session", "/tmp/app-wt"),
        }),
      );
    });
    // The collapsed chip flags the failing pipeline even before opening.
    expect(host.querySelector(".bg-red-400")).toBeTruthy();
    const chip = host.querySelector("button");
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const body = document.body.textContent ?? "";
    // Branch comes from live stats or the recorded child branch.
    expect(body).toContain("feat/lib");
    // Diff stats for the prepared child.
    expect(body).toContain("+5");
    expect(body).toContain("−1");
    // Failing-CI badge on the child's row.
    expect(
      document.body.querySelector('[title="A linked pipeline failed"]'),
    ).toBeTruthy();
  });

  it("renders nothing for a session no task owns", async () => {
    seedTask();
    await act(async () => {
      root.render(
        createElement(TaskScopeChip, {
          scope: taskForSession("stray", undefined),
        }),
      );
    });
    expect(host.innerHTML).toBe("");
    expect(loadTaskWorkspaces()).toHaveLength(1);
  });
});
