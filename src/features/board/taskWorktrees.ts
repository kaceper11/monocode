import { pathKey, isEqualOrInside } from "../../shared/lib/paths";
import { gitTaskBranch } from "../../platform/tauri/fs";
import { getSession } from "../sessions/data/sessionStore";
import { sessionWorkCwd, type Session } from "../sessions/model/session";
import {
  createWorktree,
  listWorktrees,
  renameWorktreeBranchExplicit,
  worktreeSessionIds,
  type Worktree,
} from "../source-control/model/worktrees";
import { taskBranchChoice } from "../source-control/hooks/useProjectBranches";
import {
  loadBoard,
  taskSessionIds,
  taskWideSessionIds,
  updateTask,
  type BoardTask,
} from "./boardStore";
import { withTaskGitLock } from "./TaskGitActions";

export type TaskWorktreeTarget = {
  projectPath: string;
  path?: string;
  branch: string;
  base: string;
  taskId?: string;
  laneId?: string;
  prUrl?: string;
  /** Edit task refuses actions against a stale baseline, just as Save does. */
  expectedTask?: BoardTask;
};
export type TaskWorktreeAction =
  | {
      kind: "create";
      target: TaskWorktreeTarget;
      branch: string;
      base: string;
      existing: boolean;
    }
  | { kind: "switch" | "rename"; target: TaskWorktreeTarget; branch: string }
  | { kind: "delete"; target: TaskWorktreeTarget };
export type TaskWorktreeResult = {
  tree?: Worktree;
  base?: string;
  task?: BoardTask;
  removedSessionIds?: string[];
};
export type TaskWorktreeActionHandler = (
  action: TaskWorktreeAction,
) => Promise<TaskWorktreeResult>;

/** Validate both paths and branch claims against the latest Board, including archived tasks. */
export function assertTaskWorktreeAvailable(
  target: TaskWorktreeTarget,
  path?: string,
  branch = target.branch,
) {
  const tasks = loadBoard().tasks;
  const task = tasks.find((task) => task.id === target.taskId);
  if (
    target.expectedTask &&
    JSON.stringify(task) !== JSON.stringify(target.expectedTask)
  )
    throw new Error(
      "Task changed while this editor was open. Reopen it before continuing.",
    );
  if (target.taskId && (!task || task.archived))
    throw new Error("This task is no longer available.");
  for (const task of tasks)
    for (const lane of task.workstreams) {
      if (task.id === target.taskId && lane.id === target.laneId) continue;
      if (
        (path &&
          lane.worktreePath &&
          pathKey(path) === pathKey(lane.worktreePath)) ||
        (pathKey(lane.projectPath) === pathKey(target.projectPath) &&
          lane.branch === branch)
      )
        throw new Error(
          "Another task or repository row already owns this working copy or branch.",
        );
    }
}

/** All Git IO stays behind existing locks and app-owned session/removal lifecycles. */
export async function runTaskWorktreeAction(
  action: TaskWorktreeAction,
  host: {
    sessions: () => readonly Session[];
    renameSessionBranches: (
      ids: readonly string[],
      branch: string,
    ) => Promise<void>;
    remove: (
      cwd: string,
      path: string,
      force: boolean,
      keepSessions: boolean,
    ) => Promise<unknown>;
    lockSessions: (
      ids: readonly string[],
      path: string,
      run: () => Promise<TaskWorktreeResult>,
    ) => Promise<TaskWorktreeResult>;
  },
): Promise<TaskWorktreeResult> {
  const { target } = action;
  return withTaskGitLock(
    target.projectPath,
    `worktree ${action.kind}`,
    async () => {
      const choice =
        action.kind === "switch" ? taskBranchChoice(action.branch) : undefined;
      const branch =
        action.kind === "delete"
          ? target.branch
          : (choice?.branch ?? action.branch.trim());
      assertTaskWorktreeAvailable(target, target.path, branch);
      const listed = await listWorktrees(target.projectPath);
      assertTaskWorktreeAvailable(target, target.path, branch);
      if (action.kind === "create") {
        const occupied = listed.worktrees.find(
          (tree) => tree.branch === branch,
        );
        if (occupied)
          throw new Error(
            "This branch already has a working copy. Select it from the picker.",
          );
        const tree = await createWorktree(
          target.projectPath,
          branch,
          action.base,
          action.existing,
        );
        return { tree };
      }
      const tree = listed.worktrees.find(
        (tree) => target.path && pathKey(tree.path) === pathKey(target.path),
      );
      if (!tree || tree.missing || tree.prunable)
        throw new Error(
          "Working copy unavailable. Refresh or detach its binding.",
        );
      if (tree.isMain)
        throw new Error(
          "Use the project controls to change the main checkout.",
        );
      if (tree.locked) throw new Error("Unlock this worktree in Git first.");
      if (tree.branch !== target.branch)
        throw new Error(
          "The working copy branch changed. Refresh before retrying.",
        );
      const task = loadBoard().tasks.find((task) => task.id === target.taskId);
      const ids = worktreeSessionIds(tree, host.sessions());
      const guardedIds = [
        ...new Set([...ids, ...(task ? taskSessionIds(task) : [])]),
      ];
      for (const id of guardedIds) {
        const session =
          host.sessions().find((session) => session.id === id) ??
          (await getSession(id));
        if (!session)
          throw new Error(
            "A conversation using this copy could not be checked. Reopen it before continuing.",
          );
        if (session.busy || session.worktreePreparing)
          throw new Error(
            "Wait for the working agents before changing this copy.",
          );
      }
      const validate = () => {
        assertTaskWorktreeAvailable(target, tree.path, branch);
        if (
          host
            .sessions()
            .some(
              (session) =>
                (guardedIds.includes(session.id) ||
                  isEqualOrInside(sessionWorkCwd(session), tree.path)) &&
                (session.busy || session.worktreePreparing),
            )
        )
          throw new Error(
            "An agent started working. Wait before changing this copy.",
          );
      };
      const apply = async (): Promise<TaskWorktreeResult> => {
        validate();
        let updated: Worktree | undefined;
        let changed = false;
        try {
          if (action.kind === "delete") {
            await host.remove(target.projectPath, tree.path, true, true);
            changed = true;
          } else if (action.kind === "rename") {
            updated = await renameWorktreeBranchExplicit(
              target.projectPath,
              tree.path,
              target.branch,
              branch,
            );
            changed = true;
            await host.renameSessionBranches(ids, branch);
          } else {
            if (tree.dirty !== false)
              throw new Error(
                "Commit or stash changes and refresh before switching branches.",
              );
            if (
              listed.worktrees.some(
                (other) =>
                  other.branch === branch &&
                  pathKey(other.path) !== pathKey(tree.path),
              )
            )
              throw new Error(
                "This branch is checked out elsewhere. Select that working copy instead.",
              );
            const actual = await gitTaskBranch(
              tree.path,
              target.branch,
              action.branch,
              choice?.base ?? target.base,
              "switch",
            );
            changed = true;
            updated = { ...tree, branch: actual };
            await host.renameSessionBranches(ids, actual);
          }
          // Check drift after awaited IO; never overwrite another editor's task changes.
          assertTaskWorktreeAvailable(target, tree.path, branch);
          if (task)
            updateTask(task.id, (current) => ({
              workstreams: current.workstreams.map((lane) => {
                if (
                  !lane.worktreePath ||
                  pathKey(lane.worktreePath) !== pathKey(tree.path)
                )
                  return lane;
                return action.kind === "delete"
                  ? {
                      ...lane,
                      worktreePath: undefined,
                      prUrl: lane.prUrl ?? target.prUrl,
                      sessionIds: (lane.sessionIds ?? []).filter(
                        (id) => !ids.includes(id),
                      ),
                    }
                  : {
                      ...lane,
                      branch: updated!.branch!,
                      ...(choice?.base ? { base: choice.base } : {}),
                      prUrl: undefined,
                    };
              }),
              ...(action.kind === "delete"
                ? {
                    taskSessionIds: (current.taskSessionIds ?? []).filter(
                      (id) => !ids.includes(id),
                    ),
                    primarySessionId: ids.includes(
                      current.primarySessionId ?? "",
                    )
                      ? undefined
                      : current.primarySessionId,
                  }
                : {}),
            }));
          return {
            tree: updated,
            ...(choice?.base ? { base: choice.base } : {}),
            task: loadBoard().tasks.find((task) => task.id === target.taskId),
            ...(action.kind === "delete" ? { removedSessionIds: ids } : {}),
          };
        } catch (error) {
          throw new Error(
            `${String(error)}${changed ? ` Git ${action.kind} completed in ${tree.path}; refresh the task before continuing.` : ""}`,
          );
        }
      };
      // Removal has its own session reservation and checkpoint recovery in App.
      return action.kind === "delete"
        ? apply()
        : host.lockSessions(guardedIds, tree.path, apply);
    },
  );
}

/** Binding edits never move conversations; their checkout must stay an explicit membership choice. */
export async function assertTaskCopySelection(
  target: TaskWorktreeTarget,
  path: string,
  sessions: readonly Session[],
) {
  assertTaskWorktreeAvailable(target, path);
  const task = loadBoard().tasks.find((task) => task.id === target.taskId);
  const lane = task?.workstreams.find((lane) => lane.id === target.laneId);
  if (
    !task ||
    !lane ||
    !lane.worktreePath ||
    pathKey(lane.worktreePath) === pathKey(path)
  )
    return;
  for (const id of [
    ...new Set([...(lane.sessionIds ?? []), ...taskWideSessionIds(task)]),
  ]) {
    const session =
      sessions.find((session) => session.id === id) ?? (await getSession(id));
    if (
      !session ||
      pathKey(sessionWorkCwd(session)) === pathKey(lane.worktreePath)
    )
      throw new Error(
        "Detach conversations using the original copy in Edit task before choosing another copy. Their history and checkout are kept.",
      );
  }
}

/** Explicit detach removes membership, not files or conversation history. */
export async function detachTaskWorkingCopy(
  target: TaskWorktreeTarget,
  sessions: readonly Session[],
): Promise<TaskWorktreeResult> {
  const task = loadBoard().tasks.find((task) => task.id === target.taskId);
  if (!task) throw new Error("This task is no longer available.");
  const before = JSON.stringify(task);
  const ids: string[] = [];
  for (const id of taskSessionIds(task)) {
    const session =
      sessions.find((session) => session.id === id) ?? (await getSession(id));
    if (!session)
      throw new Error(
        "Open unavailable conversations in Edit task and detach them explicitly first.",
      );
    if (session.busy || session.worktreePreparing)
      throw new Error(
        "Wait for the working agents before detaching this copy.",
      );
    if (target.path && isEqualOrInside(sessionWorkCwd(session), target.path))
      ids.push(id);
  }
  const current = loadBoard().tasks.find((task) => task.id === target.taskId);
  if (JSON.stringify(current) !== before)
    throw new Error("Task changed. Reopen its controls before continuing.");
  assertTaskWorktreeAvailable(target, target.path);
  updateTask(task.id, {
    workstreams: task.workstreams.map((lane) =>
      lane.id === target.laneId
        ? {
            ...lane,
            worktreePath: undefined,
            sessionIds: (lane.sessionIds ?? []).filter(
              (id) => !ids.includes(id),
            ),
          }
        : lane,
    ),
    taskSessionIds: (task.taskSessionIds ?? []).filter(
      (id) => !ids.includes(id),
    ),
    primarySessionId: ids.includes(task.primarySessionId ?? "")
      ? undefined
      : task.primarySessionId,
  });
  return {
    task: loadBoard().tasks.find((entry) => entry.id === task.id),
    removedSessionIds: ids,
  };
}
