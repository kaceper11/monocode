import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { basename } from "../lib/fs";
import { prettyCwd } from "../lib/paths";
import {
  projectsSnapshot,
  repositoryDisplayName,
  subscribeProjects,
} from "../lib/projects";
import {
  repositoryForChild,
  subscribeTaskWorkspaces,
  taskForSession,
  taskWorkspacesSnapshot,
  type TaskChild,
  type TaskWorkspace,
} from "../lib/taskWorkspaces";
import { Popover } from "./Popover";
import {
  Check,
  ChevronDown,
  Task,
  CircleAlert,
  CircleDot,
  Loader,
} from "./icons";

function childRepoName(task: TaskWorkspace, child: TaskChild): string {
  const repo = repositoryForChild(task, child);
  return repo
    ? repositoryDisplayName(repo)
    : child.workingCopy
      ? basename(child.workingCopy)
      : "Repository";
}

/**
 * Session-scope chip: shows that the session is one repository child of a
 * task and opens a switcher across the task's children. Sessions stay
 * single-cwd — switching changes which session you look at, never the
 * session's working copy.
 */
export function TaskScopeChip({
  sessionId,
  cwd,
  needsInputIds,
  onOpenChild,
  onRetryChild,
}: {
  sessionId: string;
  /** The session's actual working copy — the host child is derived from
   * it, not from whichever child was last clicked. */
  cwd?: string;
  needsInputIds?: ReadonlySet<string>;
  onOpenChild?: (taskId: string, childId: string) => void;
  onRetryChild?: (taskId: string, childId: string) => void;
}) {
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const projectsRaw = useSyncExternalStore(subscribeProjects, projectsSnapshot);
  const scope = useMemo(
    () => taskForSession(sessionId, cwd),
    // Stores re-read on every write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, cwd, tasksRaw, projectsRaw],
  );
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!scope) return null;
  const { task, child } = scope;
  const anyNeedsInput =
    task.sessionIds?.some((id) => needsInputIds?.has(id)) ||
    task.children.some((entry) =>
      entry.sessionIds.some((id) => needsInputIds?.has(id)),
    );
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-content/10 px-3 text-[12px]">
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        title={`Task · ${task.name}`}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 items-center gap-1.5 text-content/65 hover:text-content"
      >
        <Task
          aria-hidden="true"
          className="size-3.5 shrink-0 text-content/50"
          strokeWidth={1.75}
        />
        <span className="truncate">{task.name}</span>
        <span className="shrink-0 text-content/40">
          · {childRepoName(task, child)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 shrink-0 text-content/50"
          strokeWidth={1.75}
        />
        {anyNeedsInput ? (
          <span
            title="A repository in this task needs input"
            className="size-1.5 shrink-0 rounded-full bg-amber-400"
          />
        ) : null}
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          onDismiss={() => setOpen(false)}
          width={280}
          className="overflow-hidden"
        >
          <p className="truncate border-b border-content/10 px-2.5 py-2 text-[11px] text-content/45">
            {task.name}
            {task.ticket?.identifier ? ` · ${task.ticket.identifier}` : ""}
          </p>
          <div className="max-h-56 overflow-y-auto overscroll-none px-1.5 py-1.5">
            {task.children.map((entry) => {
              const current = entry.id === child.id;
              const needsInput =
                (current &&
                  task.sessionIds?.some((id) => needsInputIds?.has(id))) ||
                entry.sessionIds.some((id) => needsInputIds?.has(id));
              // "Ready" = the copy is prepared (or a legacy per-child
              // session exists); the task's own session is separate.
              const ready =
                entry.sessionIds.length > 0 ||
                entry.launch.state === "ready";
              const failed = entry.launch.state === "failed";
              return (
                <div key={entry.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={!ready}
                    onClick={() => {
                      setOpen(false);
                      onOpenChild?.(task.id, entry.id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/5 disabled:opacity-50"
                  >
                  {entry.launch.state === "failed" ? (
                    <CircleAlert
                      className="size-3.5 shrink-0 text-red-400"
                      strokeWidth={1.75}
                    />
                  ) : entry.launch.state === "working" ? (
                    <Loader className="size-3.5 shrink-0 animate-spin text-content/50" />
                  ) : ready ? (
                    <Check
                      className="size-3.5 shrink-0 text-emerald-400"
                      strokeWidth={2}
                    />
                  ) : (
                    <CircleDot className="size-3.5 shrink-0 text-content/30" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    {childRepoName(task, entry)}
                  </span>
                  {needsInput ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
                  ) : null}
                  <span className="shrink-0 truncate text-[10px] text-content/40">
                    {current
                      ? "Current"
                      : ready
                        ? ""
                        : entry.workingCopy
                          ? prettyCwd(entry.workingCopy)
                          : "Prepare later"}
                  </span>
                  </button>
                  {(failed ||
                    (!ready &&
                      entry.launch.state !== "working" &&
                      entry.workingCopy)) &&
                  onRetryChild ? (
                    <button
                      type="button"
                      title={
                        entry.launch.error ??
                        (failed ? "Retry launch" : "Start this repository")
                      }
                      onClick={() => {
                        setOpen(false);
                        onRetryChild(task.id, entry.id);
                      }}
                      className="shrink-0 rounded-md px-1.5 py-1 text-[10px] text-content/60 hover:bg-content/8 hover:text-content"
                    >
                      {failed ? "Retry" : "Start"}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
