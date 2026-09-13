// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { removeProjectData } from "./projectData";
import {
  ensureDeliveryWatcher,
  loadWatchers,
  saveWatcher,
} from "./watchers";
import {
  createTask,
  loadTaskWorkspaces,
  updateTaskChild,
} from "./taskWorkspaces";
import { addRepositoryToProject, ensureProjectForPath, loadProjects } from "./projects";
import type { RepositoryFamily } from "./repositoryFamilies";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const family = (checkout: string): RepositoryFamily => ({
  commonDir: `${checkout}/.git`,
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
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it("purging a project prunes its sessions off tasks and lifts their watchers", async () => {
  vi.mocked(invoke).mockImplementation((command: string) => {
    if (command === "session_list_by_project")
      return Promise.resolve([{ id: "s1" }]);
    return Promise.resolve(undefined);
  });
  const project = ensureProjectForPath("/tmp/app", family("/tmp/app"));
  const [repo] = loadProjects().find((p) => p.id === project.id)!.repositories;
  const task = createTask({
    projectId: project.id,
    name: "X",
    children: [
      { repositoryId: repo.id, mode: "existing", workingCopy: "/tmp/app-copy" },
    ],
  });
  updateTaskChild(task.id, task.children[0].id, { sessionIds: ["s1"] });
  ensureDeliveryWatcher({
    kind: "github-pr",
    cwd: "/tmp/app-copy",
    repo: "acme/app",
    number: 3,
    sessionId: "s1",
  });
  saveWatcher({
    name: "Manual",
    source: {
      kind: "github-pr",
      cwd: "/other",
      repo: "acme/lib",
      number: 8,
      sessionId: "s9",
    },
    enabled: true,
    mode: "notify",
    intervalSec: 300,
    cooldownSec: 900,
  });
  await removeProjectData("/tmp/app");
  // The deleted session came off the task, its auto watcher is gone, and
  // unrelated watchers survive.
  expect(
    loadTaskWorkspaces()[0].children[0].sessionIds,
  ).toEqual([]);
  const watchers = loadWatchers();
  expect(watchers).toHaveLength(1);
  expect(watchers[0].name).toBe("Manual");
});
