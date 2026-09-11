// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskScopeChip } from "./TaskScopeChip";
import {
  createTask,
  loadTaskWorkspaces,
  markTaskChildLaunching,
  unmarkTaskChildLaunching,
  updateTask,
  updateTaskChild,
} from "../lib/taskWorkspaces";
import { ensureProjectForPath } from "../lib/projects";
import type { RepositoryFamily } from "../lib/repositoryFamilies";

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
    children: [
      ...current.children,
      {
        id: "child-2",
        repositoryId: repo.id,
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
          sessionId: "task-session",
          cwd: "/tmp/app-wt",
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
    await act(async () => {
      root.render(
        createElement(TaskScopeChip, {
          sessionId: "task-session",
          cwd: "/tmp/app-wt",
        }),
      );
    });
    markTaskChildLaunching(taskId, secondId);
    await act(async () => {
      updateTaskChild(taskId, secondId, { launch: { state: "working" } });
    });
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

  it("renders nothing for a session no task owns", async () => {
    seedTask();
    await act(async () => {
      root.render(createElement(TaskScopeChip, { sessionId: "stray" }));
    });
    expect(host.innerHTML).toBe("");
    expect(loadTaskWorkspaces()).toHaveLength(1);
  });
});
