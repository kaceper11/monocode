// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  changeSavedCommands,
  commandDirectory,
  readSavedCommands,
  resolveSavedCommand,
  resolveSavedCommandGroup,
  savedCommandsSnapshot,
} from "./savedCommands";
const current = "monocode.savedCommands.v1";
const reusable = "monocode.projectCommands.v1";
const projects = "monocode.projects.v1";
const destination = { projectCwd: "/repo", worktreeCwd: "/repo-worktree" };
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
it("recovers commands/groups with collision-free identities and preserves original stores", async () => {
  const oldReusable = JSON.stringify([
    { id: "dev", name: "Reusable", command: " npm run dev \n" },
  ]);
  const oldProjects = JSON.stringify([
    {
      id: "project",
      name: "Old project",
      anchor: "/repo",
      repositories: [
        {
          id: "repo",
          anchor: "//wsl.localhost/Ubuntu/home/dev/repo",
          commonDir: "unneeded",
        },
      ],
      commands: [
        {
          id: "dev",
          name: "Dev",
          repositoryId: "repo",
          command: "display",
          relativeCwd: "apps/web",
          steps: [
            { command: "npm test" },
            { command: "wsl --shutdown", host: "native" },
          ],
        },
      ],
      commandGroups: [{ id: "all", name: "All", commandIds: ["dev"] }],
      verify: { mode: "fix", commandId: "dev" },
    },
  ]);
  localStorage.setItem(reusable, oldReusable);
  localStorage.setItem(projects, oldProjects);
  const store = readSavedCommands();
  expect(localStorage.getItem(current)).toBeNull();
  expect(store.commands[0].command).toBe(" npm run dev \n");
  expect(store.commands[0].id).not.toBe(store.commands[1].id);
  expect(store.commands[1].legacy?.suggestedCwd).toBe(
    "//wsl.localhost/Ubuntu/home/dev/repo",
  );
  expect(store.groups[0].commandIds).toEqual([store.commands[1].id]);
  expect(() => resolveSavedCommand(store.commands[1], destination)).toThrow(
    /legacy/,
  );
  expect(() =>
    resolveSavedCommandGroup(store.groups[0], store, destination),
  ).toThrow(/legacy/);
  await changeSavedCommands(savedCommandsSnapshot(), (store) => ({
    commands: store.commands.map((command) => ({
      ...command,
      legacy: undefined,
      projectCwd: destination.projectCwd,
    })),
    groups: store.groups.map((group) => ({
      ...group,
      legacy: undefined,
      projectCwd: destination.projectCwd,
    })),
  }));
  const adopted = readSavedCommands();
  expect(
    resolveSavedCommandGroup(adopted.groups[0], adopted, destination),
  ).toMatchObject([
    {
      cwd: "/repo-worktree/apps/web",
      steps: [
        { command: "npm test" },
        { command: "wsl --shutdown", host: "native" },
      ],
    },
  ]);
  expect(localStorage.getItem(reusable)).toBe(oldReusable);
  expect(localStorage.getItem(projects)).toBe(oldProjects);
});
it("does not substitute a project anchor for a missing repository binding", () => {
  localStorage.setItem(
    projects,
    JSON.stringify([
      {
        id: "p",
        anchor: "/wrong",
        commands: [
          { id: "c", name: "C", command: "test", repositoryId: "missing" },
        ],
        commandGroups: [],
      },
    ]),
  );
  const command = readSavedCommands().commands[0];
  expect(command.legacy?.repositoryId).toBe("missing");
  expect(command.legacy?.suggestedCwd).toBeUndefined();
  expect(() => resolveSavedCommand(command, destination)).toThrow(/legacy/);
});
it("binds project and host explicitly, with contained relative cwd", () => {
  const command = {
    id: "c",
    name: "C",
    command: "npm test",
    projectCwd: "/repo",
    relativeCwd: "apps\\web",
  };
  expect(resolveSavedCommand(command, destination).cwd).toBe(
    "/repo-worktree/apps/web",
  );
  expect(
    resolveSavedCommand(
      { ...command, targetCwd: "//wsl.localhost/Ubuntu/home/Repo" },
      destination,
    ).cwd,
  ).toBe("//wsl.localhost/Ubuntu/home/Repo/apps/web");
  expect(() =>
    resolveSavedCommand(command, {
      ...destination,
      projectCwd: "//wsl.localhost/Ubuntu/repo",
    }),
  ).toThrow(/another project/);
  for (const relative of [
    "..",
    "a/../b",
    "/tmp",
    "C:\\temp",
    "~",
    "x\nshutdown",
  ])
    expect(() => commandDirectory("/repo", relative)).toThrow(/subdirectory/);
  expect(() => commandDirectory("relative", "subdir")).toThrow(/absolute/);
});
it("rejects invalid/unknown host data, stale saves and failed writes without overwriting old data", async () => {
  localStorage.setItem(
    reusable,
    JSON.stringify([
      {
        id: "c",
        name: "C",
        command: "test",
        steps: [{ command: "test", host: "remote" }],
      },
    ]),
  );
  await expect(
    changeSavedCommands(savedCommandsSnapshot(), () => ({
      commands: [],
      groups: [],
    })),
  ).rejects.toThrow(/preserved/);
  expect(localStorage.getItem(current)).toBeNull();
  localStorage.clear();
  const old = savedCommandsSnapshot();
  await changeSavedCommands(old, () => ({
    commands: [{ id: "c", name: "C", command: "test" }],
    groups: [],
  }));
  await expect(
    changeSavedCommands(old, () => ({ commands: [], groups: [] })),
  ).rejects.toThrow(/another window/);
  const before = savedCommandsSnapshot();
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  await expect(
    changeSavedCommands(before, () => ({ commands: [], groups: [] })),
  ).rejects.toThrow(/Quota/);
  expect(savedCommandsSnapshot()).toBe(before);
});
it("preserves deleted-member evidence and refuses partial group dispatch", () => {
  const store = {
    commands: [{ id: "c", name: "C", command: "test" }],
    groups: [{ id: "g", name: "G", commandIds: ["c", "deleted"] }],
  };
  localStorage.setItem(current, JSON.stringify({ version: 1, ...store }));
  expect(readSavedCommands()).toEqual(store);
  expect(() =>
    resolveSavedCommandGroup(store.groups[0], store, destination),
  ).toThrow(/deleted/);
});
it("retains intentionally empty stores and refuses duplicate command IDs", async () => {
  await changeSavedCommands(savedCommandsSnapshot(), () => ({
    commands: [],
    groups: [],
  }));
  expect(readSavedCommands()).toEqual({ commands: [], groups: [] });
  const command = { id: "c", name: "C", command: "test" };
  await expect(
    changeSavedCommands(savedCommandsSnapshot(), () => ({
      commands: [command, command],
      groups: [],
    })),
  ).rejects.toThrow(/preserved/);
});
