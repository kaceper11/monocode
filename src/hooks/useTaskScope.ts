import { useSyncExternalStore } from "react";
import {
  subscribeTaskWorkspaces,
  taskForSession,
  taskWorkspacesSnapshot,
  type TaskChild,
  type TaskWorkspace,
} from "../lib/taskWorkspaces";

export type TaskScope = { task: TaskWorkspace; child: TaskChild };

/** Task scope for a session, live against the task store. `cwd` pins the
 * displayed child to the copy the session actually runs in. Returns null
 * for sessions no task owns. */
export function useTaskScope(
  sessionId: string | undefined,
  cwd?: string,
): TaskScope | null {
  useSyncExternalStore(subscribeTaskWorkspaces, taskWorkspacesSnapshot);
  return sessionId ? taskForSession(sessionId, cwd) : null;
}
