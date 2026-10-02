// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import {
  readSavedProjects,
  saveSavedProject,
  deleteSavedProject,
  savedProjectForCwd,
} from "./savedProjects";
import { addTask, loadBoard } from "../../board/boardStore";
beforeEach(() => localStorage.clear());
it("saves editable repository compositions and presets without changing task membership", () => {
  const project = {
    id: "services",
    name: "Services",
    members: ["/api", "/web"],
    presets: [{ id: "backend", name: "Backend", members: ["/api"] }],
  };
  saveSavedProject(project);
  addTask({
    projectId: project.id,
    title: "Fix",
    links: [],
    workstreams: [
      {
        id: "api",
        projectPath: "/api",
        branch: "main",
        base: "HEAD",
        worktreePath: "/api",
      },
    ],
  });
  const task = loadBoard().tasks[0];
  saveSavedProject({
    ...project,
    name: "Server",
    members: ["/server"],
    presets: [],
  });
  expect(readSavedProjects()[0]).toMatchObject({
    name: "Server",
    members: ["/server"],
    presets: [],
  });
  expect(loadBoard().tasks[0]).toEqual(task);
  deleteSavedProject(project.id);
  expect(readSavedProjects()).toEqual([]);
  expect(loadBoard().tasks[0]).toEqual(task);
});
it("bounds and normalizes members while preserving execution-host identity", () => {
  expect(readSavedProjects("broken")).toEqual([]);
  saveSavedProject({
    id: "mixed",
    name: " Mixed ",
    members: ["/repo", "/repo/", "remote://one/repo", "remote://two/repo"],
    presets: [{ id: "subset", name: "Subset", members: ["/missing", "/repo"] }],
  });
  expect(readSavedProjects()[0]).toEqual({
    id: "mixed",
    name: "Mixed",
    members: ["/repo", "remote://one/repo", "remote://two/repo"],
    presets: [{ id: "subset", name: "Subset", members: ["/repo"] }],
  });
  expect(() =>
    saveSavedProject({
      id: "invalid",
      name: "",
      members: ["/repo"],
      presets: [],
    }),
  ).toThrow();
  expect(readSavedProjects()).toHaveLength(1);
});
it("selects the active project only while the cwd belongs to it", () => {
  const project = {
    id: "p",
    name: "P",
    members: ["/api", "/web"],
    presets: [],
  };
  // No cwd context: the last-used project is the creation default.
  expect(savedProjectForCwd([project], "p")).toBe(project);
  expect(savedProjectForCwd([project], "p", "/api")).toBe(project);
  expect(savedProjectForCwd([project], "p", "/api/")).toBe(project);
  // A cwd outside the membership selects nothing — never a stale claim.
  expect(savedProjectForCwd([project], "p", "/other")).toBeUndefined();
  expect(savedProjectForCwd([project], "q", "/api")).toBeUndefined();
  expect(savedProjectForCwd([project], null)).toBeUndefined();
});
it("reports the 100-project cap separately from validation failures", () => {
  for (let i = 0; i < 100; i++)
    saveSavedProject({ id: `p${i}`, name: `P${i}`, members: ["/r"], presets: [] });
  expect(() =>
    saveSavedProject({
      id: "overflow",
      name: "Overflow",
      members: ["/r"],
      presets: [],
    }),
  ).toThrow("Saved projects are limited to 100.");
  // Editing an existing project still works at the cap — and an entry that
  // normalizes empty keeps the validation error even at the cap.
  saveSavedProject({ id: "p0", name: "Renamed", members: ["/r"], presets: [] });
  expect(readSavedProjects()[0].name).toBe("Renamed");
  expect(() =>
    saveSavedProject({ id: "p0", name: " ", members: [], presets: [] }),
  ).toThrow("Choose a project name and at least one repository.");
});
