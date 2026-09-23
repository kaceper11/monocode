import type { SessionFolder } from "../sessions/model/sessionFolders";
import type { BoardTask } from "./boardStore";

/** A derived sidebar view, never persisted as or written back to user folders. */
export function taskSessionFolders(
  tasks: readonly BoardTask[],
  collapsed: ReadonlySet<string>,
): SessionFolder[] {
  const idsForTask = (task: BoardTask) => [
    ...new Set([
      ...(task.primarySessionId ? [task.primarySessionId] : []),
      ...task.workstreams.flatMap((ws) => ws.sessionIds ?? []),
    ]),
  ];
  const membership = new Map<string, number>();
  for (const task of tasks)
    for (const id of idsForTask(task))
      membership.set(id, (membership.get(id) ?? 0) + 1);
  return tasks.flatMap((task) => {
    const sessionIds = idsForTask(task).filter(
      (id) => membership.get(id) === 1,
    );
    if (!sessionIds.length) return [];
    const id = `task-group:${task.id}`;
    return [
      {
        id,
        name: `${task.title}${task.archived ? " (archived)" : ""}`,
        sessionIds,
        collapsed: collapsed.has(id),
      },
    ];
  });
}

export function withTaskSessionFolders(
  folders: SessionFolder[],
  tasks: SessionFolder[],
): SessionFolder[] {
  const assigned = new Set(tasks.flatMap((task) => task.sessionIds));
  return [
    ...tasks,
    ...folders.map((folder) => ({
      ...folder,
      sessionIds: folder.sessionIds.filter((id) => !assigned.has(id)),
    })),
  ];
}
