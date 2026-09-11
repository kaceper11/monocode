// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  addRepositoryToProject,
  ensureProjectForPath,
  loadProjects,
} from "./projects";
import type { RepositoryFamily } from "./repositoryFamilies";
import {
  archiveTask,
  composeTaskPrompt,
  createTask,
  loadTaskWorkspaces,
  recordTaskActiveChild,
  removeTask,
  removeTaskChild,
  suggestTaskBranch,
  taskChildrenForWorkingCopy,
  taskForSession,
  taskHostConflict,
  tasksForProject,
  updateTaskChild,
} from "./taskWorkspaces";

function family(commonDir: string, checkout: string): RepositoryFamily {
  return {
    commonDir,
    checkout,
    worktrees: [
      {
        path: checkout,
        head: "main",
        branch: "main",
        main: true,
        missing: false,
        locked: null,
        prunable: null,
      },
    ],
  };
}

function projectWith(...paths: string[]) {
  const project = ensureProjectForPath(
    paths[0],
    family(`${paths[0]}/.git`, paths[0]),
  );
  for (const path of paths.slice(1))
    addRepositoryToProject(project.id, {
      commonDir: `${path}/.git`,
      anchor: path,
    });
  return loadProjects().find((entry) => entry.id === project.id)!;
}

const later = (repositoryId: string) => ({
  repositoryId,
  mode: "later" as const,
});

beforeEach(() => {
  localStorage.clear();
});

describe("loadTaskWorkspaces", () => {
  it("returns nothing for missing or malformed storage", () => {
    expect(loadTaskWorkspaces()).toEqual([]);
    localStorage.setItem("monocode.taskWorkspaces.v1", "not json");
    expect(loadTaskWorkspaces()).toEqual([]);
    localStorage.setItem(
      "monocode.taskWorkspaces.v1",
      JSON.stringify([{ id: "t1" }, "junk", null]),
    );
    expect(loadTaskWorkspaces()).toEqual([]);
  });

  it("normalizes an interrupted working launch back to pending", () => {
    localStorage.setItem(
      "monocode.taskWorkspaces.v1",
      JSON.stringify([
        {
          id: "t1",
          projectId: "p1",
          name: "Task",
          children: [
            {
              id: "c1",
              repositoryId: "r1",
              sessionIds: [],
              launch: { state: "working" },
            },
            {
              id: "c2",
              repositoryId: "r1",
              sessionIds: ["s1"],
              launch: { state: "ready" },
            },
          ],
        },
      ]),
    );
    const [task] = loadTaskWorkspaces();
    expect(task.children[0].launch.state).toBe("pending");
    expect(task.children[1].launch.state).toBe("ready");
  });

  it("drops children and tasks that fail validation", () => {
    localStorage.setItem(
      "monocode.taskWorkspaces.v1",
      JSON.stringify([
        { id: "t1", projectId: "p1", name: "Keep", children: [] },
        {
          id: "t2",
          projectId: "p1",
          name: "Also keep",
          children: [
            { id: "c1", repositoryId: "r1", sessionIds: [], launch: {} },
            { repositoryId: "r2" },
          ],
        },
      ]),
    );
    const tasks = loadTaskWorkspaces();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].children).toHaveLength(1);
  });
});

describe("createTask", () => {
  it("creates children with exact routing identities", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "Checkout",
      brief: "Shared brief",
      children: [
        {
          repositoryId: repo.id,
          mode: "worktree",
          baseRef: "refs/heads/main",
          baseCommit: "abc123",
          branch: "checkout",
          path: "/tmp/app-checkout",
          responsibility: "UI only",
        },
        later(lib.id),
      ],
    });
    expect(task.children).toHaveLength(2);
    const [first, second] = task.children;
    expect(first.repositoryId).toBe(repo.id);
    expect(first.workingCopy).toBe("/tmp/app-checkout");
    expect(first.baseRef).toBe("refs/heads/main");
    expect(first.launch.state).toBe("pending");
    expect(second.workingCopy).toBeUndefined();
    expect(second.sessionIds).toEqual([]);
  });

  it("rejects empty selections, unknown repositories and bad names", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    expect(() =>
      createTask({ projectId: project.id, name: "  ", children: [later(repo.id)] }),
    ).toThrow("task name");
    expect(() =>
      createTask({ projectId: project.id, name: "X", children: [] }),
    ).toThrow("at least one repository");
    expect(() =>
      createTask({
        projectId: project.id,
        name: "X",
        children: [later("gone")],
      }),
    ).toThrow("no longer in this project");
  });

  it("rejects worktree children missing base, branch or location", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    expect(() =>
      createTask({
        projectId: project.id,
        name: "X",
        children: [
          { repositoryId: repo.id, mode: "worktree", branch: "b" },
        ],
      }),
    ).toThrow("base, branch and location");
    expect(() =>
      createTask({
        projectId: project.id,
        name: "X",
        children: [{ repositoryId: repo.id, mode: "existing" }],
      }),
    ).toThrow("Choose a working copy");
  });

  it("rejects mixed execution hosts", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    expect(() =>
      createTask({
        projectId: project.id,
        name: "X",
        children: [
          {
            repositoryId: repo.id,
            mode: "existing",
            workingCopy: "/tmp/app-copy",
          },
          {
            repositoryId: repo.id,
            mode: "existing",
            workingCopy: "//wsl.localhost/Ubuntu/home/me/app",
          },
        ],
      }),
    ).toThrow(/different execution hosts/);
  });
});

describe("taskHostConflict", () => {
  it("treats native paths as one host and each WSL distribution as its own", () => {
    expect(taskHostConflict(["/tmp/a", "/tmp/b"])).toBeNull();
    expect(
      taskHostConflict([
        "//wsl.localhost/Ubuntu/a",
        "//wsl.localhost/Ubuntu/b",
      ]),
    ).toBeNull();
    expect(
      taskHostConflict(["/tmp/a", "//wsl.localhost/Ubuntu/b"]),
    ).toMatch(/different execution hosts/);
    expect(
      taskHostConflict([
        "//wsl.localhost/Ubuntu/a",
        "//wsl.localhost/Debian/b",
      ]),
    ).toMatch(/different execution hosts/);
    expect(taskHostConflict([undefined, "/tmp/a"])).toBeNull();
  });
});

describe("task child updates", () => {
  it("records session ids, launch state and last active child", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    const childId = task.children[0].id;
    updateTaskChild(task.id, childId, {
      workingCopy: "/tmp/app-work",
      sessionIds: ["s1"],
      launch: { state: "ready" },
    });
    recordTaskActiveChild(task.id, childId);
    const [stored] = loadTaskWorkspaces();
    expect(stored.children[0].sessionIds).toEqual(["s1"]);
    expect(stored.children[0].launch.state).toBe("ready");
    expect(stored.lastActiveChildId).toBe(childId);
  });

  it("keeps failed launch errors for targeted retry", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    const childId = task.children[0].id;
    updateTaskChild(task.id, childId, {
      launch: { state: "failed", error: "branch exists" },
    });
    const [stored] = loadTaskWorkspaces();
    expect(stored.children[0].launch.error).toBe("branch exists");
  });

  it("removes only the association, never sessions or copies", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id), later(lib.id)],
    });
    removeTaskChild(task.id, task.children[0].id);
    let [stored] = loadTaskWorkspaces();
    expect(stored.children).toHaveLength(1);
    archiveTask(task.id);
    expect(tasksForProject(project.id)).toHaveLength(0);
    removeTask(task.id);
    expect(loadTaskWorkspaces()).toEqual([]);
  });
});

describe("taskForSession", () => {
  it("finds the owning child by session id", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    updateTaskChild(task.id, task.children[0].id, { sessionIds: ["s1"] });
    expect(taskForSession("s1")?.task.id).toBe(task.id);
    expect(taskForSession("unknown")).toBeNull();
  });
});

describe("taskChildrenForWorkingCopy", () => {
  it("reports concurrent writers from other active tasks only", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const first = createTask({
      projectId: project.id,
      name: "One",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
      ],
    });
    const second = createTask({
      projectId: project.id,
      name: "Two",
      children: [later(repo.id)],
    });
    expect(
      taskChildrenForWorkingCopy("/tmp/app-copy").map(
        (entry) => entry.task.name,
      ),
    ).toEqual(["One"]);
    // The owning task does not count itself.
    expect(
      taskChildrenForWorkingCopy("/tmp/app-copy", undefined, first.id),
    ).toEqual([]);
    // Archived tasks release the working copy.
    archiveTask(first.id);
    expect(taskChildrenForWorkingCopy("/tmp/app-copy")).toEqual([]);
    void second;
  });
});

describe("composeTaskPrompt", () => {
  it("carries the shared brief, own responsibility and exact identity", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "Checkout",
      brief: "Rebuild the checkout flow.",
      ticket: {
        kind: "issue",
        repo: "acme/shop",
        number: 217,
        url: "https://github.com/acme/shop/issues/217",
        identifier: "BOOK-217",
        title: "Checkout",
      },
      children: [
        {
          repositoryId: repo.id,
          mode: "worktree",
          baseRef: "refs/heads/main",
          baseCommit: "abc1234567",
          branch: "checkout",
          path: "/tmp/app-checkout",
          responsibility: "UI only",
        },
        later(lib.id),
      ],
    });
    const [first, second] = task.children;
    const prompt = composeTaskPrompt(task, first, repo);
    expect(prompt).toContain("# Checkout");
    expect(prompt).toContain("BOOK-217");
    expect(prompt).toContain("Rebuild the checkout flow.");
    expect(prompt).toContain("Working copy: /tmp/app-checkout");
    expect(prompt).toContain("checkout (from main @ abc1234567)");
    expect(prompt).toContain("Your responsibility: UI only");
    // The other child's identity never leaks into this session's brief.
    expect(prompt).not.toContain(lib.anchor);
    expect(prompt).not.toContain("/tmp/lib");
    const second_prompt = composeTaskPrompt(task, second, lib);
    expect(second_prompt).not.toContain("UI only");
    expect(second_prompt).toContain("out of scope");
  });
});

describe("suggestTaskBranch", () => {
  it("slugs the task name and stays unique against existing refs", () => {
    const refs = [
      { name: "refs/heads/main" },
      { name: "refs/heads/checkout-redesign" },
      { name: "refs/heads/checkout-redesign-2" },
    ];
    expect(suggestTaskBranch("Checkout redesign!", refs)).toBe(
      "checkout-redesign-3",
    );
    expect(suggestTaskBranch("Fix — auth", refs)).toBe("fix-auth");
    expect(suggestTaskBranch("", [])).toBe("task");
  });
});
