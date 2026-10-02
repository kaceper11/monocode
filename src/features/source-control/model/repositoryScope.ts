import { taskSessionIds, type BoardTask } from "../../board/boardStore";
import type { SavedProject } from "../../projects/model/savedProjects";
import { pathKey, projectName } from "../../../shared/lib/paths";
export type GitRepositoryScope = {
  id: string;
  projectPath: string;
  cwd?: string;
  label: string;
};
export function repositoryScopes(
  tasks: readonly BoardTask[],
  sessionId?: string,
  project?: SavedProject,
): { key: string; repositories: GitRepositoryScope[] } {
  const task = sessionId
    ? tasks.find(
        (task) => !task.archived && taskSessionIds(task).includes(sessionId),
      )
    : undefined;
  if (task)
    return {
      key: task.id,
      repositories: task.workstreams.map((ws) => ({
        id: ws.id,
        projectPath: ws.projectPath,
        cwd: ws.worktreePath,
        label: `${projectName(ws.projectPath)} · ${ws.branch}${ws.worktreePath ? "" : " · no checkout"}`,
      })),
    };
  if (project)
    return {
      key: project.id,
      repositories: project.members.map((path) => ({
        id: pathKey(path),
        projectPath: path,
        cwd: path,
        label: projectName(path),
      })),
    };
  return { key: "", repositories: [] };
}
export function selectedRepository(
  repositories: GitRepositoryScope[],
  cwd: string,
  id?: string,
) {
  return (
    repositories.find((repo) => repo.id === id && repo.cwd) ??
    repositories.find(
      (repo) => repo.cwd && pathKey(repo.cwd) === pathKey(cwd),
    ) ??
    repositories.find((repo) => repo.cwd)
  );
}
