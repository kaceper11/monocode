// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  addRepositoryToProject,
  ensureProjectForPath,
  loadProjects,
} from "./projects";
import type { RepositoryFamily } from "./repositoryFamilies";
import {
  addTaskAttempt,
  addTaskChildren,
  archiveTask,
  attemptForChild,
  childForRepository,
  composeTaskPrompt,
  composeTaskSessionPrompt,
  composeTaskUpdateNotice,
  createTask,
  isTaskChildLaunching,
  linkTaskSession,
  linkTicketToTask,
  liveTaskSessionIds,
  loadTaskWorkspaces,
  markTaskChildLaunching,
  PRIMARY_ATTEMPT_ID,
  pruneTaskSession,
  recordTaskActiveChild,
  removeTask,
  removeTaskAttempt,
  removeTaskChild,
  reviseTask,
  setTaskAttemptStatus,
  suggestTaskBranch,
  taskAttemptLabel,
  taskChildRepoLabel,
  taskChildrenForWorkingCopy,
  taskForSession,
  taskHostConflict,
  taskMatchesQuery,
  taskOwnedChildForWorkingCopy,
  taskOwnsCheckout,
  tasksForProject,
  unmarkTaskChildLaunching,
  updateTask,
  updateTaskChild,
} from "./taskWorkspaces";
import {
  ensureDeliveryWatcher,
  loadWatchers,
  saveWatcher,
  updateWatcher,
  watchGithubPrUrl,
} from "./watchers";
import {
  allAzurePrAssociations,
  saveAzurePrAssociation,
  type AzurePrAssociation,
} from "./azureRepos";
import { listTaskPrDrafts, saveTaskPrDraft, taskPrRowKey } from "./taskPrs";

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
              repositoryId: "r2",
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

  it("keeps a working launch while a live in-flight marker owns it", () => {
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
          ],
        },
      ]),
    );
    markTaskChildLaunching("t1", "c1");
    try {
      const [task] = loadTaskWorkspaces();
      expect(task.children[0].launch.state).toBe("working");
    } finally {
      unmarkTaskChildLaunching("t1", "c1");
    }
    // The marker gone — the next read normalizes back to actionable.
    expect(loadTaskWorkspaces()[0].children[0].launch.state).toBe("pending");
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

  it("rejects a new task past the storage cap instead of dropping it", () => {
    const seeded = Array.from({ length: 100 }, (_, i) => ({
      id: `t${i}`,
      projectId: "p1",
      name: `Task ${i}`,
      children: [
        {
          id: `c${i}`,
          repositoryId: "r1",
          sessionIds: [],
          launch: { state: "pending" },
        },
      ],
      sessionIds: [],
      createdAt: i,
    }));
    localStorage.setItem("monocode.taskWorkspaces.v1", JSON.stringify(seeded));
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    expect(() =>
      createTask({
        projectId: project.id,
        name: "X",
        children: [later(repo.id)],
      }),
    ).toThrow("up to 100 tasks");
    expect(loadTaskWorkspaces()).toHaveLength(100);
  });

  it("rejects mixed execution hosts", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
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
            repositoryId: lib.id,
            mode: "existing",
            workingCopy: "//wsl.localhost/Ubuntu/home/me/lib",
          },
        ],
      }),
    ).toThrow(/different execution hosts/);
  });

  it("rejects the same repository twice in one attempt", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    expect(() =>
      createTask({
        projectId: project.id,
        name: "X",
        children: [later(repo.id), later(repo.id)],
      }),
    ).toThrow("already in this task");
  });

  it("creates a child that attaches an existing branch to a new worktree", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "Fix",
      children: [
        {
          repositoryId: repo.id,
          mode: "branch",
          existingBranch: "refs/heads/topic",
          baseCommit: "def4567890",
          path: "/tmp/app-topic",
        },
      ],
    });
    const [child] = task.children;
    expect(child.existingBranch).toBe("refs/heads/topic");
    // The short name feeds prompts, labels and branch uniqueness.
    expect(child.branch).toBe("topic");
    expect(child.baseCommit).toBe("def4567890");
    // No base ref — the branch is never created, so no creation inputs.
    expect(child.baseRef).toBeUndefined();
    expect(child.workingCopy).toBe("/tmp/app-topic");
    expect(taskOwnsCheckout(child)).toBe(true);
    const prompt = composeTaskSessionPrompt(task, project);
    expect(prompt).toContain("branch: topic");
    expect(prompt).not.toContain("(from");
  });

  it("rejects branch children missing a local ref, tip or location", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    expect(() =>
      createTask({
        projectId: project.id,
        name: "X",
        children: [{ repositoryId: repo.id, mode: "branch", path: "/tmp/x" }],
      }),
    ).toThrow("branch and location");
    expect(() =>
      createTask({
        projectId: project.id,
        name: "X",
        children: [
          {
            repositoryId: repo.id,
            mode: "branch",
            // A remote-tracking ref is not a local branch to attach.
            existingBranch: "refs/remotes/origin/topic",
            baseCommit: "abc123",
            path: "/tmp/x",
          },
        ],
      }),
    ).toThrow("local branch");
  });

  it("counts an existing-branch child in branch uniqueness", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        {
          repositoryId: repo.id,
          mode: "branch",
          existingBranch: "refs/heads/topic",
          baseCommit: "abc123",
          path: "/tmp/app-topic",
        },
      ],
    });
    const second = addTaskAttempt(task.id, "retry");
    expect(() =>
      addTaskChildren(task.id, [
        {
          repositoryId: repo.id,
          attemptId: second.id,
          mode: "worktree",
          baseRef: "refs/heads/main",
          baseCommit: "abc123",
          // `topic` and `refs/heads/topic` are the same branch to Git.
          branch: "topic",
          path: "/tmp/app-topic-2",
        },
      ]),
    ).toThrow("already used for this repository");
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

describe("addTaskChildren", () => {
  it("appends new children and returns them for launch", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    const added = addTaskChildren(task.id, [later(lib.id)]);
    expect(added).toHaveLength(1);
    expect(added[0].repositoryId).toBe(lib.id);
    expect(added[0].launch.state).toBe("pending");
    expect(
      loadTaskWorkspaces().find((entry) => entry.id === task.id)?.children,
    ).toHaveLength(2);
  });

  it("rejects repositories already in the task or not in the project", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    expect(() => addTaskChildren(task.id, [later(repo.id)])).toThrow(
      "already in this task",
    );
    expect(() => addTaskChildren(task.id, [later("gone")])).toThrow(
      "no longer in this project",
    );
    // Nothing was appended on failure.
    expect(
      loadTaskWorkspaces().find((entry) => entry.id === task.id)?.children,
    ).toHaveLength(1);
    expect(addTaskChildren(task.id, [])).toEqual([]);
  });
});

describe("attempts", () => {
  it("stamps children into the primary attempt and stores its record", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0].id).toBe(PRIMARY_ATTEMPT_ID);
    expect(task.children[0].attemptId).toBe(PRIMARY_ATTEMPT_ID);
  });

  it("backfills a primary attempt for tasks written before it existed", () => {
    localStorage.setItem(
      "monocode.taskWorkspaces.v1",
      JSON.stringify([
        {
          id: "t1",
          projectId: "p1",
          name: "Legacy",
          children: [
            {
              id: "c1",
              repositoryId: "r1",
              attemptId: "gone",
              sessionIds: [],
              launch: { state: "ready" },
            },
          ],
        },
      ]),
    );
    const [task] = loadTaskWorkspaces();
    expect(task.attempts[0].id).toBe(PRIMARY_ATTEMPT_ID);
    // A dangling attempt id remaps to the primary instead of stranding the row.
    expect(task.children[0].attemptId).toBe(PRIMARY_ATTEMPT_ID);
    expect(attemptForChild(task, task.children[0])?.id).toBe(
      PRIMARY_ATTEMPT_ID,
    );
  });

  it("adds attempts, targets children at them and protects the primary", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id), later(lib.id)],
    });
    const second = addTaskAttempt(task.id, "Minimal diff");
    expect(second.label).toBe("Minimal diff");
    // The same repository is allowed in another attempt…
    const added = addTaskChildren(task.id, [
      {
        repositoryId: repo.id,
        attemptId: second.id,
        mode: "worktree",
        baseRef: "refs/heads/main",
        baseCommit: "def456",
        branch: "x-minimal",
        path: "/tmp/app-minimal",
      },
    ]);
    expect(added[0].attemptId).toBe(second.id);
    // …but never twice inside one attempt, and unknown attempts refuse.
    expect(() =>
      addTaskChildren(task.id, [later(repo.id)]),
    ).toThrow("already in this task");
    expect(() =>
      addTaskChildren(task.id, [
        { ...later(lib.id), attemptId: "nope" },
      ]),
    ).toThrow("no longer in this task");
    expect(() => removeTaskAttempt(task.id, PRIMARY_ATTEMPT_ID)).toThrow(
      /primary attempt/i,
    );
    removeTaskAttempt(task.id, second.id);
    const [stored] = loadTaskWorkspaces();
    expect(stored.attempts).toHaveLength(1);
    expect(stored.children.every((c) => c.attemptId === PRIMARY_ATTEMPT_ID)).toBe(
      true,
    );
  });

  it("refuses removals that would leave the task without checkouts", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    const second = addTaskAttempt(task.id);
    addTaskChildren(task.id, [{ ...later(lib.id), attemptId: second.id }]);
    removeTaskChild(task.id, task.children[0].id);
    // The second attempt now holds the only checkout — removing it would
    // strand the task record and its sessions on sanitize.
    expect(() => removeTaskAttempt(task.id, second.id)).toThrow(
      /last checkouts/,
    );
    const [stored] = loadTaskWorkspaces();
    expect(() =>
      removeTaskChild(stored.id, stored.children[0].id),
    ).toThrow(/last repository checkout/);
    expect(loadTaskWorkspaces()).toHaveLength(1);
  });

  it("requires a distinct branch per repository across attempts", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        {
          repositoryId: repo.id,
          mode: "worktree",
          baseRef: "refs/heads/main",
          baseCommit: "abc123",
          branch: "x",
          path: "/tmp/app-x",
        },
      ],
    });
    const second = addTaskAttempt(task.id);
    expect(() =>
      addTaskChildren(task.id, [
        {
          repositoryId: repo.id,
          attemptId: second.id,
          mode: "worktree",
          baseRef: "refs/heads/main",
          baseCommit: "abc123",
          branch: "x",
          path: "/tmp/app-x2",
        },
      ]),
    ).toThrow(/already used/);
    // A different branch in the second attempt is fine.
    expect(
      addTaskChildren(task.id, [
        {
          repositoryId: repo.id,
          attemptId: second.id,
          mode: "worktree",
          baseRef: "refs/heads/main",
          baseCommit: "abc123",
          branch: "x-minimal",
          path: "/tmp/app-x2",
        },
      ]),
    ).toHaveLength(1);
  });

  it("dedupes checkout pairs and repins a moved primary id on load", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    localStorage.setItem(
      "monocode.taskWorkspaces.v1",
      JSON.stringify([
        {
          id: "t1",
          projectId: project.id,
          name: "Legacy",
          attempts: [
            { id: "a2", createdAt: 1 },
            { id: "a3", createdAt: 2 },
          ],
          children: [
            {
              id: "c1",
              repositoryId: repo.id,
              attemptId: "a2",
              sessionIds: [],
              launch: { state: "ready" },
            },
            {
              id: "c2",
              repositoryId: repo.id,
              attemptId: "a3",
              sessionIds: [],
              launch: { state: "ready" },
            },
            {
              id: "c3",
              repositoryId: repo.id,
              attemptId: "gone",
              sessionIds: [],
              launch: { state: "ready" },
            },
          ],
        },
      ]),
    );
    const [task] = loadTaskWorkspaces();
    // attempts[0] is the primary attempt even when stored under another id.
    expect(task.attempts[0].id).toBe(PRIMARY_ATTEMPT_ID);
    // "a2" and "gone" both remap onto primary — the manufactured
    // (primary, r1) duplicate is dropped instead of bricking later writes.
    expect(task.children.map((child) => child.id)).toEqual(["c1", "c2"]);
    expect(task.children[0].attemptId).toBe(PRIMARY_ATTEMPT_ID);
    expect(task.children[1].attemptId).toBe("a3");
    // The record stays writable — a leftover duplicate would trip the
    // pair check on every subsequent revision.
    const revised = reviseTask(task.id, {
      name: "Renamed",
      keepRepositoryIds: [repo.id],
      responsibilities: new Map(),
      additions: [],
    });
    expect(revised.name).toBe("Renamed");
  });

  it("records attempt verdicts without touching children", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    const second = addTaskAttempt(task.id);
    setTaskAttemptStatus(task.id, second.id, "discarded");
    let [stored] = loadTaskWorkspaces();
    expect(stored.attempts[1].status).toBe("discarded");
    setTaskAttemptStatus(task.id, second.id);
    [stored] = loadTaskWorkspaces();
    expect(stored.attempts[1].status).toBeUndefined();
  });

  it("routes repository lookups to the primary attempt by default", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    const second = addTaskAttempt(task.id);
    const added = addTaskChildren(task.id, [
      { ...later(repo.id), attemptId: second.id },
    ]);
    const [stored] = loadTaskWorkspaces();
    expect(childForRepository(stored, repo.id)?.attemptId).toBe(
      PRIMARY_ATTEMPT_ID,
    );
    expect(childForRepository(stored, repo.id, second.id)?.id).toBe(
      added[0].id,
    );
  });

  it("prefers a prepared checkout over an unprepared primary child", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    const second = addTaskAttempt(task.id);
    const added = addTaskChildren(task.id, [
      {
        repositoryId: repo.id,
        attemptId: second.id,
        mode: "existing",
        workingCopy: "/tmp/app-wt",
      },
    ]);
    const [stored] = loadTaskWorkspaces();
    // The primary child is unprepared — the attempt-2 copy is usable.
    expect(childForRepository(stored, repo.id)?.id).toBe(added[0].id);
    // An explicit attempt still resolves its own row.
    expect(childForRepository(stored, repo.id, second.id)?.id).toBe(
      added[0].id,
    );
    expect(
      childForRepository(stored, repo.id, PRIMARY_ATTEMPT_ID)?.id,
    ).toBe(stored.children[0].id);
  });

  it("disambiguates labels only for repositories that span attempts", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    const [stored] = loadTaskWorkspaces();
    expect(taskChildRepoLabel(stored, stored.children[0])).toBe("app");
    const second = addTaskAttempt(task.id, "Variant B");
    // A second attempt on a *different* repository adds no labels.
    addTaskChildren(task.id, [{ ...later(lib.id), attemptId: second.id }]);
    const [withLib] = loadTaskWorkspaces();
    expect(taskChildRepoLabel(withLib, withLib.children[0])).toBe("app");
    expect(taskChildRepoLabel(withLib, withLib.children[1])).toBe("lib");
    // Only once the same repository spans attempts do labels appear.
    addTaskChildren(task.id, [{ ...later(repo.id), attemptId: second.id }]);
    const [multi] = loadTaskWorkspaces();
    expect(taskAttemptLabel(multi, second.id)).toBe("Variant B");
    expect(taskChildRepoLabel(multi, multi.children[0])).toContain(
      "Attempt 1",
    );
    expect(taskChildRepoLabel(multi, multi.children[2])).toContain(
      "Variant B",
    );
    expect(taskChildRepoLabel(multi, multi.children[1])).toBe("lib");
  });

  it("marks task-created checkouts without mistaking borrowed copies", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        {
          repositoryId: repo.id,
          mode: "worktree",
          baseRef: "refs/heads/main",
          baseCommit: "abc123",
          branch: "x",
          path: "/tmp/app-x",
        },
        { repositoryId: lib.id, mode: "existing", workingCopy: "/tmp/lib" },
      ],
    });
    expect(taskOwnsCheckout(task.children[0])).toBe(true);
    expect(taskOwnsCheckout(task.children[1])).toBe(false);
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

  it("resolves a task-level session to its host child", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id), later(lib.id)],
    });
    updateTask(task.id, (current) => ({
      ...current,
      sessionIds: ["task-session"],
      lastActiveChildId: lib.id ? current.children[1].id : undefined,
    }));
    const found = taskForSession("task-session");
    expect(found?.task.id).toBe(task.id);
    expect(found?.child.repositoryId).toBe(lib.id);
  });

  it("pins the host child to the session's actual working copy", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id), later(lib.id)],
    });
    const [first, second] = task.children;
    updateTaskChild(task.id, first.id, { workingCopy: "/tmp/app-wt" });
    updateTaskChild(task.id, second.id, { workingCopy: "/tmp/lib-wt" });
    // lastActiveChildId points at lib — but the session runs in app's copy.
    updateTask(task.id, (current) => ({
      ...current,
      sessionIds: ["task-session"],
      lastActiveChildId: second.id,
    }));
    expect(
      taskForSession("task-session", "/tmp/app-wt")?.child.id,
    ).toBe(first.id);
    // A cwd no child owns falls back to lastActiveChildId.
    expect(
      taskForSession("task-session", "/tmp/elsewhere")?.child.id,
    ).toBe(second.id);
  });
});

describe("reviseTask", () => {
  it("commits rename, removals, responsibilities and additions together", () => {
    const project = projectWith("/tmp/app", "/tmp/lib", "/tmp/ext");
    const [repo, lib, ext] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "Old",
      children: [later(repo.id), later(lib.id)],
    });
    const [first] = task.children;
    const next = reviseTask(task.id, {
      name: "New name",
      keepRepositoryIds: [repo.id],
      responsibilities: new Map([[first.id, "Owns UI"]]),
      additions: [
        {
          repositoryId: ext.id,
          mode: "existing",
          workingCopy: "/tmp/ext-copy",
        },
      ],
    });
    expect(next.name).toBe("New name");
    expect(next.children.map((child) => child.repositoryId)).toEqual([
      repo.id,
      ext.id,
    ]);
    expect(next.children[0].id).toBe(first.id);
    expect(next.children[0].responsibility).toBe("Owns UI");
    expect(next.children[1].workingCopy).toBe("/tmp/ext-copy");
  });

  it("persists nothing when an addition fails validation", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "Old",
      children: [later(repo.id), later(lib.id)],
    });
    // Adding a repository that's still selected must fail — and must not
    // leave the rename or the (zero) removals half-saved.
    expect(() =>
      reviseTask(task.id, {
        name: "Renamed",
        keepRepositoryIds: [repo.id],
        responsibilities: new Map(),
        additions: [later(repo.id)],
      }),
    ).toThrow("already in this task");
    const [stored] = loadTaskWorkspaces();
    expect(stored.name).toBe("Old");
    expect(stored.children).toHaveLength(2);
  });

  it("refuses to edit an archived task", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "Old",
      children: [later(repo.id)],
    });
    archiveTask(task.id);
    expect(() =>
      reviseTask(task.id, {
        name: "Renamed",
        keepRepositoryIds: [repo.id],
        responsibilities: new Map(),
        additions: [],
      }),
    ).toThrow("archived");
    expect(loadTaskWorkspaces()[0].name).toBe("Old");
  });

  it("drops lastActiveChildId when that child is removed", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id), later(lib.id)],
    });
    recordTaskActiveChild(task.id, task.children[1].id);
    const next = reviseTask(task.id, {
      name: "X",
      keepRepositoryIds: [repo.id],
      responsibilities: new Map(),
      additions: [],
    });
    expect(next.lastActiveChildId).toBeUndefined();
    expect(next.children).toHaveLength(1);
  });
});

describe("pruneTaskSession", () => {
  it("detaches a deleted session from task and child references", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id), later(lib.id)],
    });
    updateTaskChild(task.id, task.children[0].id, {
      sessionIds: ["child-session"],
    });
    updateTask(task.id, (current) => ({
      ...current,
      sessionIds: ["task-session"],
    }));
    pruneTaskSession("task-session");
    let [stored] = loadTaskWorkspaces();
    expect(stored.sessionIds).toEqual([]);
    expect(stored.children[0].sessionIds).toEqual(["child-session"]);
    pruneTaskSession("child-session");
    [stored] = loadTaskWorkspaces();
    expect(stored.children[0].sessionIds).toEqual([]);
  });
});

describe("launch markers", () => {
  it("rejects a second in-flight launch of the same child", () => {
    expect(markTaskChildLaunching("t", "c")).toBe(true);
    expect(markTaskChildLaunching("t", "c")).toBe(false);
    expect(isTaskChildLaunching("t", "c")).toBe(true);
    expect(markTaskChildLaunching("t", "other")).toBe(true);
    unmarkTaskChildLaunching("t", "c");
    expect(isTaskChildLaunching("t", "c")).toBe(false);
    expect(markTaskChildLaunching("t", "c")).toBe(true);
    unmarkTaskChildLaunching("t", "c");
    unmarkTaskChildLaunching("t", "other");
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

  it("task session prompt names every repository's copy and job", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "Checkout",
      brief: "Rebuild the checkout flow.",
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
    const prompt = composeTaskSessionPrompt(task, project);
    expect(prompt).toContain("working copy: /tmp/app-checkout");
    expect(prompt).toContain("branch: checkout (from main @ abc1234567)");
    expect(prompt).toContain("Responsibility: UI only");
    // The sibling child is listed too — one session covers all repos.
    expect(prompt).toContain("no working copy prepared yet");
    expect(prompt).toContain("separate checkouts");
  });
});

describe("taskMatchesQuery", () => {
  const build = () => {
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
    return { task, project };
  };

  it("matches name, brief, ticket and repository fields", () => {
    const { task, project } = build();
    for (const query of [
      "checkout", // name, ticket title, branch
      "BOOK-217", // ticket identifier
      "issues/217", // ticket url
      "rebuild the checkout", // brief
      "lib", // repository display name
      "app-checkout", // working copy path
      "ui only", // responsibility
    ]) {
      expect(taskMatchesQuery(task, query, project), query).toBe(true);
    }
  });

  it("matches additional ticket items and attempt labels", () => {
    const { task, project } = build();
    linkTicketToTask(task.id, {
      kind: "issue",
      repo: "acme/shop",
      number: 88,
      url: "https://github.com/acme/shop/issues/88",
      identifier: "OPS-88",
      title: "Ops follow-up",
    });
    const linked = loadTaskWorkspaces().find((row) => row.id === task.id)!;
    expect(taskMatchesQuery(linked, "OPS-88", project)).toBe(true);
    expect(taskMatchesQuery(linked, "ops follow", project)).toBe(true);
  });

  it("matches tokens across different fields", () => {
    const { task, project } = build();
    // "book-217" is the ticket identifier, "ui" only appears in the
    // responsibility — the pair must still match.
    expect(taskMatchesQuery(task, "book-217 ui", project)).toBe(true);
    expect(taskMatchesQuery(task, "checkout nope", project)).toBe(false);
  });

  it("returns true for empty queries and false for misses", () => {
    const { task, project } = build();
    expect(taskMatchesQuery(task, "  ", project)).toBe(true);
    expect(taskMatchesQuery(task, "unrelated", project)).toBe(false);
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

describe("delivery watcher teardown", () => {
  const autoGhPr = (cwd: string, number: number, sessionId?: string) =>
    ensureDeliveryWatcher({
      kind: "github-pr",
      cwd,
      repo: "acme/app",
      number,
      ...(sessionId ? { sessionId } : {}),
    });
  const autoCi = (cwd: string, sessionId?: string) =>
    ensureDeliveryWatcher({
      kind: "azure-ci",
      target: {
        site: "https://dev.azure.com/team",
        accountId: "a",
        project: "p",
        definition: 5,
        repositoryId: "r",
        repositoryType: "TfsGit",
        repositoryUrl: "u",
      },
      definitionName: "Tests",
      remote: "u",
      cwd,
      branch: "feat",
      ...(sessionId ? { sessionId } : {}),
    });

  const association = (
    cwd: string,
    session: string,
  ): AzurePrAssociation => ({
    target: {
      site: "https://dev.azure.com/team",
      accountId: "a",
      project: "p",
      repository: "r",
      number: 7,
    },
    account: "Ada",
    cwd,
    branch: "feat",
    sourceSessionId: session,
    revision: "s:t",
    projectName: "P",
    repositoryName: "R",
    pr: {
      pullRequestId: 7,
      title: "Review me",
      status: "active",
      sourceRefName: "refs/heads/feat",
      targetRefName: "refs/heads/main",
      reviewers: [],
    },
  });

  it("lifts a task's auto watchers on archive and restores them on unarchive", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
      ],
    });
    const childId = task.children[0].id;
    updateTaskChild(task.id, childId, { sessionIds: ["s1"] });
    // Links saved through the real paths, bound to the child's copy+session —
    // the association and the draft both register their watcher on write.
    saveAzurePrAssociation(
      association("/tmp/app-copy", "s1"),
      "/tmp/app-copy",
      "feat",
      "s1",
    );
    saveTaskPrDraft(task.id, childId, {
      target: "main",
      title: "T",
      body: "",
      result: {
        provider: "github",
        url: "https://github.com/acme/app/pull/3",
        title: "T",
        number: 3,
      },
    });
    watchGithubPrUrl("/tmp/app-copy", "https://github.com/acme/app/pull/3", "s1");
    autoGhPr("/tmp/app-copy", 5, "s1"); // session-bound, nothing stored
    autoGhPr("/elsewhere", 4, "s9"); // unrelated
    expect(loadWatchers()).toHaveLength(4);
    archiveTask(task.id);
    expect(loadWatchers().map((watcher) => watcher.source)).toEqual([
      expect.objectContaining({ cwd: "/elsewhere" }),
    ]);
    // Un-archiving re-registers watchers for links that stayed saved — the
    // bare session-bound watcher without a stored link stays gone.
    archiveTask(task.id, false);
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(3);
    expect(watchers.map((watcher) => watcher.source.kind).sort()).toEqual([
      "azure-pr",
      "github-pr",
      "github-pr",
    ]);
    expect(watchers.every((watcher) => watcher.auto)).toBe(true);
  });

  it("lifts a removed task's watchers and keeps hand-made ones", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
      ],
    });
    autoGhPr("/tmp/app-copy", 3);
    saveWatcher({
      name: "Manual",
      source: { kind: "github-pr", cwd: "/tmp/app-copy", repo: "acme/app", number: 8 },
      enabled: true,
      mode: "notify",
      intervalSec: 300,
      cooldownSec: 900,
    });
    removeTask(task.id);
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].name).toBe("Manual");
  });

  it("lifts only the removed child's scope", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
        { repositoryId: lib.id, mode: "existing", workingCopy: "/tmp/lib-copy" },
      ],
    });
    autoGhPr("/tmp/app-copy", 3);
    autoGhPr("/tmp/lib-copy", 4);
    removeTaskChild(task.id, task.children[0].id);
    expect(loadWatchers().map((watcher) => watcher.source)).toEqual([
      expect.objectContaining({ cwd: "/tmp/lib-copy" }),
    ]);
  });

  it("lifts session-bound watchers when the session is pruned", () => {
    autoGhPr("/tmp/app-copy", 3, "s1");
    autoGhPr("/tmp/app-copy", 4, "s2");
    pruneTaskSession("s1");
    expect(loadWatchers().map((watcher) => watcher.source)).toEqual([
      expect.objectContaining({ sessionId: "s2" }),
    ]);
  });

  it("keeps a pruned session's watcher when another scope still links the delivery", () => {
    const assoc = association("/tmp/app-copy", "s2");
    // The watcher is bound to s1; the stored link lives under s2.
    saveWatcher({
      name: "Auto",
      source: {
        kind: "azure-pr",
        target: assoc.target,
        projectName: "P",
        repositoryName: "R",
        cwd: "/tmp/app-copy",
        branch: "feat",
        sessionId: "s1",
      },
      enabled: true,
      mode: "notify",
      auto: true,
      intervalSec: 300,
      cooldownSec: 900,
    });
    const watcher = loadWatchers()[0];
    updateWatcher(watcher.id, (row) => ({ ...row, seen: ["k1"] }));
    saveAzurePrAssociation(assoc, "/tmp/app-copy", "feat", "s2");
    // ensureDeliveryWatcher dedupes — the s1-bound watcher already covers it.
    expect(loadWatchers()).toHaveLength(1);
    pruneTaskSession("s1");
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].id).toBe(watcher.id);
    expect(watchers[0].source).toEqual(
      expect.objectContaining({ sessionId: "s2" }),
    );
    expect(watchers[0].seen).toEqual(["k1"]);
  });

  it("keeps a pruned session's watcher session-less while its link stays", () => {
    const assoc = association("/tmp/app-copy", "s1");
    saveAzurePrAssociation(assoc, "/tmp/app-copy", "feat", "s1");
    expect(loadWatchers()).toHaveLength(1);
    pruneTaskSession("s1");
    // The stored link survives with the dead owner stripped, so the watcher
    // follows it — rebound to nobody rather than to a deleted session.
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].source).not.toHaveProperty("sessionId");
    expect(allAzurePrAssociations()[0].sourceSessionId).toBeUndefined();
  });

  it("never rebinds a watcher to a deleted session", () => {
    const assoc = association("/tmp/app-copy", "s1");
    saveAzurePrAssociation(assoc, "/tmp/app-copy", "feat", "s1");
    saveAzurePrAssociation(
      { ...assoc, sourceSessionId: "s2" },
      "/tmp/app-copy",
      "feat",
      "s2",
    );
    expect(loadWatchers()[0].source).toEqual(
      expect.objectContaining({ sessionId: "s1" }),
    );
    pruneTaskSession("s1");
    expect(loadWatchers()[0].source).toEqual(
      expect.objectContaining({ sessionId: "s2" }),
    );
    pruneTaskSession("s2");
    // s1's row was unbound when s1 was pruned — nothing points back at a
    // dead session; the session-less twins collapse to one covering row.
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].source).not.toHaveProperty("sessionId");
    expect(allAzurePrAssociations()).toHaveLength(1);
  });

  it("does not count an archived task's draft as coverage", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
      ],
    });
    const childId = task.children[0].id;
    updateTaskChild(task.id, childId, { sessionIds: ["s9"] });
    saveTaskPrDraft(task.id, childId, {
      target: "main",
      title: "T",
      body: "",
      result: {
        provider: "github",
        url: "https://github.com/acme/app/pull/9",
        title: "T",
        number: 9,
      },
    });
    archiveTask(task.id);
    // The parked task's draft must not keep another session's watcher alive.
    watchGithubPrUrl("/tmp/app-copy", "https://github.com/acme/app/pull/9", "s1");
    pruneTaskSession("s1");
    expect(loadWatchers()).toHaveLength(0);
  });

  it("keeps a watcher covered by a live session at a torn checkout", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
      ],
    });
    updateTaskChild(task.id, task.children[0].id, { sessionIds: ["s1"] });
    // s9 is a live session elsewhere — its stored link shares the checkout.
    saveAzurePrAssociation(
      association("/tmp/app-copy", "s9"),
      "/tmp/app-copy",
      "feat",
      "s9",
    );
    removeTask(task.id);
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].source).toEqual(
      expect.objectContaining({ sessionId: "s9" }),
    );
  });

  it("keeps a github-pr watcher covered by a task's saved PR result", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
      ],
    });
    const childId = task.children[0].id;
    updateTaskChild(task.id, childId, { sessionIds: ["s2"] });
    saveTaskPrDraft(task.id, childId, {
      target: "main",
      title: "T",
      body: "",
      result: {
        provider: "github",
        url: "https://github.com/acme/app/pull/9",
        title: "T",
        number: 9,
      },
    });
    // The watcher is bound to an ad-hoc session at the same checkout.
    watchGithubPrUrl("/tmp/app-copy", "https://github.com/acme/app/pull/9", "s1");
    pruneTaskSession("s1");
    const watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].source).toEqual(
      expect.objectContaining({ sessionId: "s2" }),
    );
    // Removing the task doesn't lift it — the surviving session still owns
    // the link. Pruning that session finally drops the watcher.
    removeTask(task.id);
    expect(loadWatchers()).toHaveLength(1);
    pruneTaskSession("s2");
    expect(loadWatchers()).toHaveLength(0);
  });

  it("keeps a foreign live session's watcher through archive/unarchive", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
      ],
    });
    saveAzurePrAssociation(
      association("/tmp/app-copy", "foreign"),
      "/tmp/app-copy",
      "feat",
      "foreign",
    );
    // The foreign session is live — its stored link still covers the
    // delivery, so archiving this task doesn't lift the watcher.
    archiveTask(task.id);
    let watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].source).toEqual(
      expect.objectContaining({ sessionId: "foreign" }),
    );
    // Un-archiving must not stack a second watcher over the kept one.
    archiveTask(task.id, false);
    watchers = loadWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].source.kind).toBe("azure-pr");
  });

  it("lifts watchers for children dropped by reviseTask", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
        { repositoryId: lib.id, mode: "existing", workingCopy: "/tmp/lib-copy" },
      ],
    });
    autoGhPr("/tmp/app-copy", 3);
    autoGhPr("/tmp/lib-copy", 4);
    reviseTask(task.id, {
      name: "X",
      keepRepositoryIds: [repo.id],
      responsibilities: new Map(),
      additions: [],
    });
    expect(loadWatchers().map((watcher) => watcher.source)).toEqual([
      expect.objectContaining({ cwd: "/tmp/app-copy" }),
    ]);
  });

  it("lifts watchers for children of a removed attempt", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
      ],
    });
    const attempt = addTaskAttempt(task.id, "Second");
    addTaskChildren(task.id, [
      {
        repositoryId: lib.id,
        attemptId: attempt.id,
        mode: "existing",
        workingCopy: "/tmp/lib-copy",
      },
    ]);
    autoGhPr("/tmp/app-copy", 3);
    autoGhPr("/tmp/lib-copy", 4);
    removeTaskAttempt(task.id, attempt.id);
    expect(loadWatchers().map((watcher) => watcher.source)).toEqual([
      expect.objectContaining({ cwd: "/tmp/app-copy" }),
    ]);
  });
});

describe("reviseTask setups", () => {
  it("configures a deferred child in place — id and responsibility stay", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id), later(lib.id)],
    });
    const deferred = task.children[1];
    const next = reviseTask(task.id, {
      name: "X",
      keepRepositoryIds: [repo.id, lib.id],
      responsibilities: new Map([[deferred.id, "Owns lib"]]),
      additions: [],
      setups: new Map([
        [
          deferred.id,
          {
            repositoryId: lib.id,
            mode: "existing",
            workingCopy: "/tmp/lib-copy",
          },
        ],
      ]),
    });
    const [first, second] = next.children;
    expect(second.id).toBe(deferred.id);
    expect(second.workingCopy).toBe("/tmp/lib-copy");
    expect(second.responsibility).toBe("Owns lib");
    // A setup child launches fresh — it never carries a stale launch state.
    expect(second.launch.state).toBe("pending");
    expect(first.id).toBe(task.children[0].id);
  });

  it("resets a failed launch back to pending through setup", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
    });
    const child = task.children[0];
    updateTaskChild(task.id, child.id, {
      workingCopy: "/tmp/gone",
      launch: { state: "failed", error: "missing" },
    });
    const next = reviseTask(task.id, {
      name: "X",
      keepRepositoryIds: [repo.id],
      responsibilities: new Map(),
      additions: [],
      setups: new Map([
        [
          child.id,
          { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/back" },
        ],
      ]),
    });
    expect(next.children[0].workingCopy).toBe("/tmp/back");
    expect(next.children[0].launch.state).toBe("pending");
    expect(next.children[0].launch.error).toBeUndefined();
  });
});

describe("unique working-copy bindings", () => {
  it("rejects two children claiming the same path", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    expect(() =>
      createTask({
        projectId: project.id,
        name: "X",
        children: [
          { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/same" },
          { repositoryId: lib.id, mode: "existing", workingCopy: "/tmp/same" },
        ],
      }),
    ).toThrow();
  });

  it("rejects a setup colliding with a sibling's copy", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/same" },
        later(lib.id),
      ],
    });
    const deferred = task.children[1];
    expect(() =>
      reviseTask(task.id, {
        name: "X",
        keepRepositoryIds: [repo.id, lib.id],
        responsibilities: new Map(),
        additions: [],
        setups: new Map([
          [
            deferred.id,
            {
              repositoryId: lib.id,
              mode: "existing",
              workingCopy: "/tmp/same",
            },
          ],
        ]),
      }),
    ).toThrow();
  });
});

describe("ticket sanitation", () => {
  it("drops tickets without a usable url and bounds stored text", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const bad = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
      ticket: {
        kind: "issue",
        repo: "r",
        number: 1,
        url: "javascript:alert(1)",
        title: "bad",
      },
    });
    expect(bad.ticket).toBeUndefined();
    const huge = createTask({
      projectId: project.id,
      name: "Y",
      children: [later(repo.id)],
      ticket: {
        kind: "issue",
        repo: "r",
        number: 2,
        url: "https://example.com/2",
        title: "t".repeat(1000),
        context: "c".repeat(10000),
      },
    });
    expect(huge.ticket?.title).toHaveLength(500);
    expect(huge.ticket?.context).toHaveLength(4000);
  });

  it("dedupes additional items by url and account together", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const item = (account?: string) => ({
      kind: "issue" as const,
      repo: "r",
      number: 7,
      url: "https://example.com/7",
      ...(account ? { account } : {}),
    });
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [later(repo.id)],
      ticket: {
        kind: "issue",
        repo: "r",
        number: 1,
        url: "https://example.com/1",
        additionalItems: [
          item("acc-a"),
          // Same url, same account — a duplicate.
          item("acc-a"),
          // Same url under a different account is a different ticket.
          item("acc-b"),
          item(),
        ],
      },
    });
    const extra = task.ticket?.additionalItems ?? [];
    expect(extra).toHaveLength(3);
    expect(extra.map((entry) => entry.account)).toEqual([
      "acc-a",
      "acc-b",
      undefined,
    ]);
  });
});

describe("prompt honesty", () => {
  it("never claims a recorded path exists before launch prepares it", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        {
          repositoryId: repo.id,
          mode: "worktree",
          baseRef: "refs/heads/main",
          baseCommit: "abc1234567",
          branch: "checkout",
          path: "/tmp/app-checkout",
        },
      ],
    });
    const child = task.children[0];
    // Pending: the path is a target, not an existing checkout.
    let prompt = composeTaskSessionPrompt(task, project);
    expect(prompt).toContain("working copy: /tmp/app-checkout");
    expect(prompt).toContain("not prepared yet");
    // Failed: the prompt must not read as a usable checkout.
    updateTaskChild(task.id, child.id, {
      launch: { state: "failed", error: "branch exists" },
    });
    prompt = composeTaskSessionPrompt(loadTaskWorkspaces()[0], project);
    expect(prompt).toContain("preparation failed: branch exists");
    expect(prompt).not.toContain("not prepared yet");
    // Ready: the bare path line stands on its own.
    updateTaskChild(task.id, child.id, { launch: { state: "ready" } });
    prompt = composeTaskSessionPrompt(loadTaskWorkspaces()[0], project);
    expect(prompt).toContain("working copy: /tmp/app-checkout");
    expect(prompt).not.toContain("not prepared yet");
    expect(prompt).not.toContain("preparation failed");
  });
});

describe("composeTaskUpdateNotice", () => {
  it("restates name, ticket and the repository set", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "Checkout",
      ticket: {
        kind: "issue",
        repo: "r",
        number: 3,
        url: "https://example.com/3",
        identifier: "APP-3",
      },
      brief: "Do the thing.",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
        later(lib.id),
      ],
    });
    const notice = composeTaskUpdateNotice(task, project);
    expect(notice).toContain('"Checkout"');
    expect(notice).toContain("APP-3");
    expect(notice).toContain("Do the thing.");
    expect(notice).toContain("/tmp/app-copy");
    expect(notice).toContain("no working copy prepared yet");
  });
});

describe("task PR draft cleanup", () => {
  it("drops a child's draft when the child is removed", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/a" },
        { repositoryId: lib.id, mode: "existing", workingCopy: "/tmp/b" },
      ],
    });
    const [first, second] = task.children;
    saveTaskPrDraft(task.id, first.id, { title: "one" });
    saveTaskPrDraft(task.id, second.id, { title: "two" });
    expect(Object.keys(listTaskPrDrafts())).toHaveLength(2);
    removeTaskChild(task.id, first.id);
    expect(listTaskPrDrafts()[taskPrRowKey(task.id, first.id)]).toBeUndefined();
    expect(listTaskPrDrafts()[taskPrRowKey(task.id, second.id)]).toBeDefined();
  });

  it("drops every draft when the task is removed", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/a" },
      ],
    });
    saveTaskPrDraft(task.id, task.children[0].id, { title: "one" });
    removeTask(task.id);
    expect(listTaskPrDrafts()).toEqual({});
  });

  it("drops drafts for repositories removed by reviseTask", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/a" },
        { repositoryId: lib.id, mode: "existing", workingCopy: "/tmp/b" },
      ],
    });
    saveTaskPrDraft(task.id, task.children[0].id, { title: "one" });
    saveTaskPrDraft(task.id, task.children[1].id, { title: "two" });
    reviseTask(task.id, {
      name: "X",
      keepRepositoryIds: [lib.id],
      responsibilities: new Map(),
      additions: [],
    });
    const rows = listTaskPrDrafts();
    expect(rows[taskPrRowKey(task.id, task.children[0].id)]).toBeUndefined();
    expect(rows[taskPrRowKey(task.id, task.children[1].id)]).toBeDefined();
  });
});

describe("linkTaskSession", () => {
  const worktreeDraft = (repositoryId: string) => ({
    repositoryId,
    mode: "worktree" as const,
    baseRef: "refs/heads/main",
    baseCommit: "abc123",
    branch: "topic",
    path: "/tmp/app-topic",
  });

  it("appends to the task's conversations, keeping the primary first", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [worktreeDraft(repo.id)],
    });
    updateTask(task.id, (current) => ({
      ...current,
      sessionIds: ["primary"],
    }));
    linkTaskSession(task.id, "scratch");
    linkTaskSession(task.id, "scratch");
    const stored = loadTaskWorkspaces().find(
      (entry) => entry.id === task.id,
    )!;
    expect(stored.sessionIds).toEqual(["primary", "scratch"]);
    expect(taskForSession("scratch")?.task.id).toBe(task.id);
  });

  it("drops from the list when the session is pruned", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [worktreeDraft(repo.id)],
    });
    linkTaskSession(task.id, "scratch");
    pruneTaskSession("scratch");
    const stored = loadTaskWorkspaces().find(
      (entry) => entry.id === task.id,
    )!;
    expect(stored.sessionIds ?? []).not.toContain("scratch");
  });
});

describe("liveTaskSessionIds", () => {
  const worktreeDraft = (repositoryId: string) => ({
    repositoryId,
    mode: "worktree" as const,
    baseRef: "refs/heads/main",
    baseCommit: "abc123",
    branch: "topic",
    path: "/tmp/app-topic",
  });

  it("drops recorded ids that no live session resolves", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [worktreeDraft(repo.id)],
    });
    linkTaskSession(task.id, "primary");
    linkTaskSession(task.id, "extra");
    const stored = loadTaskWorkspaces().find(
      (entry) => entry.id === task.id,
    )!;
    const live = new Set(["primary"]);
    expect(liveTaskSessionIds(stored, live)).toEqual(["primary"]);
    expect(liveTaskSessionIds(stored, new Set(["primary", "extra"]))).toEqual([
      "primary",
      "extra",
    ]);
    expect(liveTaskSessionIds(stored, new Set())).toEqual([]);
  });
});

describe("taskOwnedChildForWorkingCopy", () => {
  it("claims a task-owned worktree but not a borrowed copy", () => {
    const project = projectWith("/tmp/app", "/tmp/lib");
    const [repo, lib] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        {
          repositoryId: repo.id,
          mode: "worktree",
          baseRef: "refs/heads/main",
          baseCommit: "abc123",
          branch: "topic",
          path: "/tmp/app-topic",
        },
        {
          repositoryId: lib.id,
          mode: "existing",
          workingCopy: "/tmp/lib",
        },
      ],
    });
    const [owned] = task.children;
    expect(taskOwnedChildForWorkingCopy("/tmp/app-topic")?.child.id).toBe(
      owned.id,
    );
    // A borrowed existing copy is the user's — sessions there stay free.
    expect(taskOwnedChildForWorkingCopy("/tmp/lib")).toBeUndefined();
    expect(taskOwnedChildForWorkingCopy("/tmp/none")).toBeUndefined();
  });

  it("ignores copies on archived tasks", () => {
    const project = projectWith("/tmp/app");
    const [repo] = project.repositories;
    const task = createTask({
      projectId: project.id,
      name: "X",
      children: [
        {
          repositoryId: repo.id,
          mode: "worktree",
          baseRef: "refs/heads/main",
          baseCommit: "abc123",
          branch: "topic",
          path: "/tmp/app-topic",
        },
      ],
    });
    archiveTask(task.id);
    expect(taskOwnedChildForWorkingCopy("/tmp/app-topic")).toBeUndefined();
  });
});
