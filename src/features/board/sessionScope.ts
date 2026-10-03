import {
  taskSessionIds,
  taskWideSessionIds,
  type BoardTask,
  type TaskWorkstream,
} from "./boardStore";
import { pathKey, projectName } from "../../shared/lib/paths";
import {
  compareSessionSummaries,
  historyWithLiveSessions,
  summaryFromSession,
} from "../sessions/data/sessionHistory";
import { sessionNeedsInput, type Session } from "../sessions/model/session";
import { shouldPersistSession } from "../sessions/data/sessionStore";
import type { OrchestrationRun } from "../orchestration/model/orchestration";
import type { SessionSummary } from "../sessions/data/sessionStore";

export type SessionListScope =
  { kind: "all" } | { kind: "adhoc" } | { kind: "task"; taskId: string; workstreamId?: string };
export function scopedSessions(
  sessions: readonly SessionSummary[],
  tasks: readonly BoardTask[],
  scope: SessionListScope,
): SessionSummary[] {
  if (scope.kind === "all") return [...sessions];
  const ids = new Set(
    tasks
      .filter((task) => scope.kind !== "task" || task.id === scope.taskId)
      .flatMap(task => scope.kind === "task" && scope.workstreamId
        ? [...taskWideSessionIds(task), ...(task.workstreams.find(lane => lane.id === scope.workstreamId)?.sessionIds ?? [])]
        : taskSessionIds(task)),
  );
  return sessions.filter((session) =>
    scope.kind === "task" ? ids.has(session.id) : !ids.has(session.id),
  );
}
type SessionBinding = {
  task: BoardTask;
  wide: boolean;
  lane?: TaskWorkstream;
  conflict: boolean;
};

// Called once per rendered session row — building the membership map once per
// `tasks` snapshot keeps each row a Map lookup instead of an O(tasks) scan.
const bindingCache = new WeakMap<
  readonly BoardTask[],
  Map<string, SessionBinding>
>();

function sessionBindings(tasks: readonly BoardTask[]) {
  let map = bindingCache.get(tasks);
  if (map) return map;
  map = new Map();
  for (const task of tasks) {
    for (const id of taskSessionIds(task)) {
      const entry = map.get(id);
      if (entry) entry.conflict = true;
      else map.set(id, { task, wide: false, conflict: false });
    }
    for (const id of taskWideSessionIds(task)) {
      const entry = map.get(id);
      if (entry?.task === task) entry.wide = true;
    }
    for (const ws of task.workstreams)
      for (const id of ws.sessionIds ?? []) {
        const entry = map.get(id);
        if (entry?.task === task) {
          if (!entry.lane) entry.lane = ws;
          else if (entry.lane !== ws) entry.conflict = true;
        }
      }
  }
  bindingCache.set(tasks, map);
  return map;
}

export function sessionScopeLabel(
  tasks: readonly BoardTask[],
  session: Pick<SessionSummary, "id" | "cwd" | "branch">,
  includeTask = true,
): string {
  const binding = sessionBindings(tasks).get(session.id);
  if (!binding) return `Ad hoc · ${projectName(session.cwd)}`;
  if (binding.conflict) return "Conflicting task membership";
  const { task, wide, lane } = binding;
  return `${includeTask ? `${task.title}${task.archived ? " (archived)" : ""} · ` : ""}${wide ? "All repositories" : `${projectName(lane?.projectPath ?? session.cwd)}${lane?.branch || session.branch ? ` · ${lane?.branch ?? session.branch}` : ""}`}`;
}

export function projectSessionSummaries(
  history: SessionSummary[],
  sessions: Session[],
  paths: readonly string[],
  runs: readonly OrchestrationRun[] = [],
): SessionSummary[] {
  const result = new Map(
    paths
      .flatMap((cwd) =>
        historyWithLiveSessions(history, sessions, cwd, {}, runs),
      )
      .map((session) => [session.id, session]),
  );
  // Persisted workers outlive `runs` — exclude them the same way
  // historyWithLiveSessions does, or a finished worker double-lists.
  const workerIds = new Set([
    ...runs.flatMap((run) => run.tasks.map((task) => task.sessionId)),
    ...history.flatMap(
      (row) => row.orchestration?.tasks.map((task) => task.sessionId) ?? [],
    ),
  ]);
  for (const session of sessions) {
    if (
      session.inboxAsk ||
      session.orchestrationLeadId ||
      workerIds.has(session.id) ||
      !paths.some((path) => pathKey(path) === pathKey(session.cwd)) ||
      (!shouldPersistSession(session) &&
        !(session.busy || sessionNeedsInput(session)))
    )
      continue;
    if (!result.has(session.id))
      result.set(session.id, summaryFromSession(session));
  }
  return [...result.values()].sort(compareSessionSummaries);
}
