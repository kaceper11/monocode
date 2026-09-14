// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  OPEN_COMMANDS_SHEET,
  deleteReusableCommand,
  joinRelativeCwd,
  loadReusableCommands,
  moveReusableCommand,
  openCommandsSheet,
  resolveCommandGroup,
  resolveCommandTarget,
  saveReusableCommand,
  type CommandsSheetRequest,
} from "./projectCommands";
import type { ProjectRecord } from "./projects";
import type { TaskWorkspace } from "./taskWorkspaces";

beforeEach(() => {
  localStorage.clear();
});

const project = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "p1",
  anchor: "/tmp/app",
  lastPath: "/tmp/app",
  repositories: [
    { id: "r1", commonDir: "/tmp/app/.git", anchor: "/tmp/app" },
    { id: "r2", commonDir: "/tmp/lib/.git", anchor: "/tmp/lib" },
  ],
  sets: [],
  commands: [],
  commandGroups: [],
  ...overrides,
});

const child = (
  id: string,
  repositoryId: string,
  workingCopy?: string,
): TaskWorkspace["children"][number] => ({
  id,
  repositoryId,
  attemptId: "primary",
  ...(workingCopy ? { workingCopy } : {}),
  sessionIds: [],
  launch: { state: "ready" },
});

const task = (
  children: TaskWorkspace["children"],
  overrides: Partial<TaskWorkspace> = {},
): TaskWorkspace => ({
  id: "t1",
  projectId: "p1",
  name: "Task",
  attempts: [{ id: "primary", createdAt: 0 }],
  children,
  createdAt: 0,
  ...overrides,
});

describe("joinRelativeCwd", () => {
  it("joins a subdirectory onto the resolved root", () => {
    expect(joinRelativeCwd("/tmp/app", "packages/web")).toEqual({
      cwd: "/tmp/app/packages/web",
    });
    expect(joinRelativeCwd("/tmp/app/", "./a//b")).toEqual({
      cwd: "/tmp/app/a/b",
    });
    expect(joinRelativeCwd("/tmp/app", "")).toEqual({ cwd: "/tmp/app" });
  });

  it("rejects absolute paths and escapes", () => {
    expect(joinRelativeCwd("/tmp/app", "/etc")).toHaveProperty("error");
    expect(joinRelativeCwd("/tmp/app", "~/x")).toHaveProperty("error");
    expect(joinRelativeCwd("/tmp/app", "C:/x")).toHaveProperty("error");
    expect(joinRelativeCwd("/tmp/app", "../up")).toHaveProperty("error");
    expect(joinRelativeCwd("/tmp/app", "a/../../up")).toHaveProperty("error");
  });

  it("preserves host-qualified WSL roots", () => {
    expect(
      joinRelativeCwd("//wsl.localhost/Ubuntu/home/me/app", "pkg"),
    ).toEqual({ cwd: "//wsl.localhost/Ubuntu/home/me/app/pkg" });
  });

  it("normalizes Windows separators on every platform", () => {
    // A saved `apps\web` is a Windows-style relative dir — not a literal
    // backslash directory — wherever the command later runs.
    expect(joinRelativeCwd("/tmp/app", "apps\\web")).toEqual({
      cwd: "/tmp/app/apps/web",
    });
    expect(joinRelativeCwd("/tmp/app", "apps\\..\\up")).toHaveProperty(
      "error",
    );
  });
});

describe("resolveCommandTarget", () => {
  it("runs a bound command in the repository's exact task worktree", () => {
    const target = resolveCommandTarget({
      command: { repositoryId: "r2" },
      project: project(),
      task: task([
        child("c1", "r1", "/tmp/worktrees/t1-app"),
        child("c2", "r2", "//wsl.localhost/Ubuntu/tmp/worktrees/t1-lib"),
      ]),
    });
    expect(target).toEqual({
      cwd: "//wsl.localhost/Ubuntu/tmp/worktrees/t1-lib",
      source: "task",
      label: "lib",
    });
  });

  it("errors when the bound repository is not part of the task", () => {
    const target = resolveCommandTarget({
      command: { repositoryId: "r2" },
      project: project(),
      task: task([child("c1", "r1", "/tmp/worktrees/t1-app")]),
    });
    expect(target).toHaveProperty("error");
  });

  it("errors when the task child has no working copy yet", () => {
    const target = resolveCommandTarget({
      command: { repositoryId: "r1" },
      project: project(),
      task: task([child("c1", "r1")]),
    });
    expect(target).toHaveProperty("error");
  });

  it("falls back to the repository anchor without a task", () => {
    const target = resolveCommandTarget({
      command: { repositoryId: "r2" },
      project: project(),
      task: null,
    });
    expect(target).toEqual({
      cwd: "/tmp/lib",
      source: "repository",
      label: "lib",
    });
  });

  it("prefers the task's last-active child for unbound commands", () => {
    const target = resolveCommandTarget({
      command: {},
      project: project(),
      task: task(
        [
          child("c1", "r1", "/tmp/worktrees/t1-app"),
          child("c2", "r2", "/tmp/worktrees/t1-lib"),
        ],
        { lastActiveChildId: "c2" },
      ),
    });
    expect(target).toEqual({ cwd: "/tmp/worktrees/t1-lib", source: "task" });
  });

  it("uses the project folder for unbound commands without a task", () => {
    const target = resolveCommandTarget({
      command: {},
      project: project({ lastPath: "/tmp/app" }),
      task: null,
    });
    expect(target).toEqual({ cwd: "/tmp/app", source: "project" });
  });

  it("applies a relative subdirectory after task resolution", () => {
    const target = resolveCommandTarget({
      command: { repositoryId: "r1", relativeCwd: "packages/web" },
      project: project(),
      task: task([child("c1", "r1", "/tmp/worktrees/t1-app")]),
    });
    expect(target).toMatchObject({
      cwd: "/tmp/worktrees/t1-app/packages/web",
      source: "task",
    });
  });

  it("errors on an unknown repository and a project with no folder", () => {
    expect(
      resolveCommandTarget({
        command: { repositoryId: "gone" },
        project: project(),
        task: null,
      }),
    ).toHaveProperty("error");
    expect(
      resolveCommandTarget({
        command: {},
        project: project({
          anchor: undefined,
          lastPath: undefined,
          repositories: [],
        }),
        task: null,
      }),
    ).toHaveProperty("error");
  });

  it("runs reusable commands in the launch folder for unstored projects", () => {
    // A rail entry that is not a stored project has no record — the folder
    // the menu was opened on is the root.
    expect(
      resolveCommandTarget({
        command: {},
        task: null,
        fallbackCwd: "/tmp/scratch",
      }),
    ).toEqual({ cwd: "/tmp/scratch", source: "project" });
    expect(
      resolveCommandTarget({
        command: { relativeCwd: "pkg" },
        task: null,
        fallbackCwd: "/tmp/scratch",
      }),
    ).toEqual({ cwd: "/tmp/scratch/pkg", source: "project" });
    // Without it, there is still no silent fallback.
    expect(
      resolveCommandTarget({ command: {}, task: null }),
    ).toHaveProperty("error");
  });
});

describe("resolveCommandGroup", () => {
  it("runs resolvable members and reports the rest", () => {
    const commands: ProjectRecord["commands"] = [
      { id: "a", name: "A", command: "npm run dev", repositoryId: "r1" },
      { id: "b", name: "B", command: "npm test", repositoryId: "r2" },
    ];
    const { runs, failures } = resolveCommandGroup({
      commands,
      project: project(),
      task: task([child("c1", "r1", "/tmp/worktrees/t1-app")]),
    });
    expect(runs.map((entry) => entry.command.id)).toEqual(["a"]);
    expect(runs[0].target.cwd).toBe("/tmp/worktrees/t1-app");
    expect(failures.map((entry) => entry.command.id)).toEqual(["b"]);
  });
});

describe("reusable commands", () => {
  it("saves, reorders and deletes", () => {
    saveReusableCommand({ name: "Dev", command: "npm run dev" });
    saveReusableCommand({ name: "Test", command: "npm test" });
    const [dev, test] = loadReusableCommands();
    expect(dev.name).toBe("Dev");
    moveReusableCommand(test.id, -1);
    expect(loadReusableCommands().map((item) => item.name)).toEqual([
      "Test",
      "Dev",
    ]);
    deleteReusableCommand(dev.id);
    expect(loadReusableCommands().map((item) => item.id)).toEqual([test.id]);
  });

  it("validates input and drops malformed stored entries", () => {
    expect(
      saveReusableCommand({ name: " ", command: "x" }).error,
    ).toBeTruthy();
    localStorage.setItem(
      "monocode.projectCommands.v1",
      JSON.stringify([
        { id: "ok", name: "Dev", command: "npm run dev" },
        { id: "bad" },
      ]),
    );
    expect(loadReusableCommands().map((item) => item.id)).toEqual(["ok"]);
  });

  it("saves sequential steps and drops malformed ones on load", () => {
    const { error } = saveReusableCommand({
      name: "Maintenance",
      command: "docker system prune -f\nwsl --shutdown",
      steps: [
        { command: "docker system prune -f" },
        { command: "wsl --shutdown", host: "native" },
      ],
    });
    expect(error).toBeUndefined();
    expect(loadReusableCommands()[0].steps).toEqual([
      { command: "docker system prune -f" },
      { command: "wsl --shutdown", host: "native" },
    ]);
    // A stored host that is not "native" is sanitized away.
    localStorage.setItem(
      "monocode.projectCommands.v1",
      JSON.stringify([
        {
          id: "c1",
          name: "X",
          command: "x",
          steps: [{ command: "a", host: "wsl" }, { command: " " }],
        },
      ]),
    );
    expect(loadReusableCommands()[0].steps).toEqual([{ command: "a" }]);
    // Steps mode with nothing to run is an error, not a silent plain save.
    expect(
      saveReusableCommand({
        name: "Empty",
        command: "x",
        steps: [{ command: " " }],
      }).error,
    ).toBeTruthy();
  });
});

describe("openCommandsSheet", () => {
  it("dispatches the open event with the request detail", () => {
    const seen: CommandsSheetRequest[] = [];
    const listener = (event: Event) =>
      seen.push((event as CustomEvent<CommandsSheetRequest>).detail);
    window.addEventListener(OPEN_COMMANDS_SHEET, listener);
    openCommandsSheet({ projectId: "p1", focus: "checks" });
    window.removeEventListener(OPEN_COMMANDS_SHEET, listener);
    expect(seen).toEqual([{ projectId: "p1", focus: "checks" }]);
  });
});
