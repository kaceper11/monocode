import {
  leafIds,
  type TaskWorkspace,
  type WorkspaceTab,
} from "../workspace/model/layout";
import {
  taskSessionIds,
  taskWideSessionIds,
  type BoardTask,
} from "./boardStore";

/** Workspace ownership is presentation state, never permission to edit a checkout. */
const ownershipCache = new WeakMap<
  readonly BoardTask[],
  WeakMap<WorkspaceTab, TaskWorkspace | undefined>
>();
export function taskTabWorkspace(
  tab: WorkspaceTab,
  tasks: readonly BoardTask[],
): TaskWorkspace | undefined {
  let cache = ownershipCache.get(tasks);
  if (!cache) {
    cache = new WeakMap();
    ownershipCache.set(tasks, cache);
  }
  if (cache.has(tab)) return cache.get(tab);
  const owner = deriveTaskTabWorkspace(tab, tasks);
  cache.set(tab, owner);
  return owner;
}

function deriveTaskTabWorkspace(
  tab: WorkspaceTab,
  tasks: readonly BoardTask[],
): TaskWorkspace | undefined {
  const ids = leafIds(tab.layout);
  const owners = tasks.filter(
    (task) =>
      !task.archived && taskSessionIds(task).some((id) => ids.includes(id)),
  );
  if (owners.length > 1) return undefined;
  // Detached conversations become ad hoc. Only file/terminal-only tabs may
  // retain authored presentation ownership without a bound conversation.
  const paneIds = new Set(
    [...tab.editorPanes, ...(tab.terminalPanes ?? [])].map((pane) => pane.id),
  );
  if (!owners.length && ids.some((id) => !paneIds.has(id))) return undefined;
  const task =
    owners[0] ??
    tasks.find(
      (task) => !task.archived && task.id === tab.taskWorkspace?.taskId,
    );
  if (!task) return undefined;
  if (taskWideSessionIds(task).some((id) => ids.includes(id)))
    return { taskId: task.id };
  const lanes = task.workstreams.filter((lane) =>
    lane.sessionIds?.some((id) => ids.includes(id)),
  );
  if (lanes.length === 1) return { taskId: task.id, workstreamId: lanes[0].id };
  if (lanes.length > 1) return { taskId: task.id };
  const pinned = tab.taskWorkspace;
  if (!pinned || pinned.taskId !== task.id) return undefined;
  if (
    pinned.workstreamId &&
    !task.workstreams.some((lane) => lane.id === pinned.workstreamId)
  )
    return { taskId: task.id };
  return pinned;
}

export function taskWorkspaceTabs(
  tabs: readonly WorkspaceTab[],
  tasks: readonly BoardTask[],
  scope: TaskWorkspace,
): WorkspaceTab[] {
  return tabs.filter((tab) => {
    const owner = taskTabWorkspace(tab, tasks);
    return (
      owner?.taskId === scope.taskId &&
      (!scope.workstreamId ||
        !owner.workstreamId ||
        owner.workstreamId === scope.workstreamId)
    );
  });
}

/** Remembered navigation targets must still belong to the selected view. */
export function taskWorkspaceTarget(
  tabs: readonly WorkspaceTab[],
  tasks: readonly BoardTask[],
  scope: TaskWorkspace,
  remembered?: string,
): WorkspaceTab | undefined {
  const visible = taskWorkspaceTabs(tabs, tasks, scope);
  return (
    visible.find((tab) => tab.id === remembered) ??
    (scope.workstreamId
      ? visible.find(
          (tab) =>
            taskTabWorkspace(tab, tasks)?.workstreamId === scope.workstreamId,
        )
      : visible.find((tab) => !taskTabWorkspace(tab, tasks)?.workstreamId))
  );
}
