import { expect, it } from "vitest";
import { repositoryScopes, selectedRepository } from "./repositoryScope";
import { tasksForProject } from "../../board/SidebarTasksSection";
const task = {
  id: "task",
  projectId: "services",
  title: "Task",
  links: [],
  createdAt: 1,
  primarySessionId: "session",
  workstreams: [
    {
      id: "api",
      projectPath: "/api",
      worktreePath: "/api-fix",
      branch: "feature",
      base: "main",
    },
    {
      id: "web",
      projectPath: "/web",
      worktreePath: "/web",
      branch: "main",
      base: "main",
    },
    { id: "missing", projectPath: "/other", branch: "fix", base: "main" },
  ],
};
const project = {
  id: "services",
  name: "Services",
  members: ["/api", "/web"],
  presets: [],
};
it("uses task-bound checkouts ahead of project defaults and keeps selection in that scope", () => {
  const scope = repositoryScopes([task], "session", project);
  expect(scope.key).toBe("task");
  expect(selectedRepository(scope.repositories, "/api-fix")?.id).toBe("api");
  expect(selectedRepository(scope.repositories, "/api-fix", "web")?.cwd).toBe(
    "/web",
  );
  expect(
    selectedRepository(scope.repositories, "/api-fix", "missing")?.id,
  ).toBe("api");
  expect(
    repositoryScopes([task], "other", project).repositories.map(
      (repo) => repo.cwd,
    ),
  ).toEqual(["/api", "/web"]);
  expect(repositoryScopes([task], "other").repositories).toEqual([]);
});
it("lists sessionless tasks for their saved project without grouping conversations", () => {
  const sessionless = { ...task, primarySessionId: undefined, workstreams: [] };
  expect(tasksForProject([sessionless], "/api", project)).toEqual([
    sessionless,
  ]);
  expect(
    tasksForProject([{ ...task, archived: true }], "/api", project),
  ).toEqual([]);
  expect(tasksForProject([task], "/web")).toEqual([task]);
});
