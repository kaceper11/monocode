import { useSavedProjects } from "../projects/model/savedProjects";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Popover } from "../../shared/ui/Popover";
import { LinkedIssueRow } from "./LinkedIssueRow";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import {
  ChartBreakoutSquare,
  ChevronDown,
  ExternalLink,
  FolderTree,
  GitBranch,
  PanelRight,
  Plus,
  X,
} from "../../shared/ui/icons";
import {
  pathKey,
  prettyCwd,
  projectName,
} from "../../shared/lib/paths";
import { sessionWorkCwd, type Session } from "../sessions/model/session";
import {
  taskWideSessionIds,
  boardFromSnapshot,
  boardSnapshot,
  subscribeBoard,
  type BoardTask,
  type TaskWorkstream,
} from "./boardStore";
import { NewTaskDialog, type NewTaskSpec } from "./NewTaskDialog";
import {
  attachTaskSession,
  detachTaskSession,
  DOCK_TASK_EVENT,
  OPEN_TASK_EVENT,
  sameExecutionHost,
  sessionTaskBindings,
  taskSessionCheckout,
} from "./taskSession";

/** Pick-row meta: up to two issue identifiers (then +N) and the lane count. */
const pickMeta = (task: BoardTask) => {
  const ids = task.links.map((link) => link.identifier).filter(Boolean);
  return [
    ...ids.slice(0, 2),
    ...(ids.length > 2 ? [`+${ids.length - 2}`] : []),
    `${task.workstreams.length} ${task.workstreams.length === 1 ? "repository" : "repositories"}`,
  ].join(" · ");
};

const button =
  "rounded px-2 py-1 text-[11px] text-content/65 hover:bg-content/8 focus-visible:outline focus-visible:outline-accent disabled:opacity-40";

/** Board owns both the association and its UI; the session remains unchanged. */
export function SessionTaskControl({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(subscribeBoard, boardSnapshot);
  const tasks = useMemo(() => boardFromSnapshot(snapshot).tasks, [snapshot]);
  const bindings = useMemo(
    () => sessionTaskBindings(tasks, session.id),
    [tasks, session.id],
  );
  const binding = bindings.length === 1 ? bindings[0] : undefined;
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<TaskWorkstream | null>(null);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const latest = useRef(session);
  latest.current = session;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const cwd = sessionWorkCwd(session);
  const taskWide =
    !!binding && taskWideSessionIds(binding.task).includes(session.id);
  const { projects } = useSavedProjects(session.cwd);
  const project = projects.find(
    (project) => project.id === binding?.task.projectId,
  );
  const [attachScope, setAttachScope] = useState<"task" | "repository">("task");
  const currentWorkstream =
    binding?.workstream ??
    binding?.task.workstreams.find(
      (ws) => ws.worktreePath && pathKey(ws.worktreePath) === pathKey(cwd),
    );
  const unavailable =
    !!session.worktreeRemoved ||
    !!session.worktreePreparing ||
    (session.workspaceMode === "worktree" && !session.worktreeCwd);

  const openTask = () => {
    if (binding)
      window.dispatchEvent(
        new CustomEvent(OPEN_TASK_EVENT, { detail: binding.task.id }),
      );
    setOpen(false);
  };
  const close = () => {
    if (working.current) return;
    setOpen(false);
    setCreating(null);
    setError("");
    setQuery("");
    trigger.current?.focus();
  };
  const run = async (action: (checkout: TaskWorkstream) => void) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    const owner = latest.current;
    try {
      const checkout = await taskSessionCheckout(owner);
      if (!mounted.current) return;
      const current = latest.current;
      if (
        current.id !== owner.id ||
        pathKey(current.cwd) !== pathKey(owner.cwd) ||
        pathKey(sessionWorkCwd(current)) !== pathKey(sessionWorkCwd(owner)) ||
        current.workspaceMode !== owner.workspaceMode ||
        current.worktreeRemoved ||
        current.worktreePreparing
      )
        throw new Error(
          "The session's working copy changed. Open task options again.",
        );
      action(checkout);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const create = (spec: NewTaskSpec) =>
    void run((checkout) => {
      if (
        !creating ||
        checkout.worktreePath !== creating.worktreePath ||
        checkout.branch !== creating.branch
      )
        throw new Error(
          "The working copy changed. Cancel and create the task again.",
        );
      attachTaskSession(session.id, checkout, {
        title: spec.title,
        links: spec.links,
        groupIds: spec.groupIds,
        projectId: spec.projectId,
      });
      setCreating(null);
      // Inline close — close() refuses while `working` is still set (it
      // clears in run's finally, after this callback returns).
      setOpen(false);
      setError("");
      setQuery("");
      trigger.current?.focus();
    });

  return (
    <>
      <div
        data-session-task-header
        className="@container flex h-9 min-w-0 shrink-0 items-center gap-2 border-b border-stroke px-3"
        data-no-drag
      >
        <button
          ref={trigger}
          type="button"
          aria-label={
            binding ? `Task context: ${binding.task.title}` : "Add to task"
          }
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setError("");
            setOpen(!open);
          }}
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-content/65 outline-none hover:bg-content/7 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
        >
          <ChartBreakoutSquare
            aria-hidden
            className={`size-3.5 shrink-0 ${binding ? "text-accent" : "text-content/35"}`}
            strokeWidth={1.75}
          />
          <span className="truncate font-medium">
            {binding
              ? `${project ? `${project.name} / ` : ""}Task · ${binding.task.title}`
              : bindings.length
                ? "Resolve task association"
                : `Ad hoc · ${projectName(session.cwd)}`}
          </span>
          {binding?.task.archived ? (
            <span className="text-content/40">Archived</span>
          ) : null}
          <ChevronDown
            aria-hidden
            className="size-3 shrink-0 text-content/35"
          />
        </button>
        {binding ? (
          <span
            className="ml-auto flex shrink-0 items-center gap-1 truncate text-[10px] text-content/55"
            title={cwd}
          >
            <GitBranch aria-hidden className="size-3 shrink-0" />
            {taskWide
              ? "All repositories"
              : currentWorkstream
                ? `${projectName(currentWorkstream.projectPath)} · ${currentWorkstream.branch}`
                : projectName(session.cwd)}
          </span>
        ) : null}
      </div>
      {open && !creating ? (
        <Popover
          anchor={trigger}
          side="bottom"
          align="start"
          width={360}
          maxHeight={480}
          role="dialog"
          aria-label={binding ? "Task context" : "Add to task"}
          onDismiss={close}
          // The scope SearchableSelect's menu portals to body — it isn't an
          // "outside" click, and it must not dismiss this popover.
          ignore="[data-dialog-popover]"
          autoFocus={bindings.length > 0}
          tabIndex={-1}
        >
          <div className="flex flex-col text-[12px]">
            <div className="border-b border-content/8 px-3.5 py-3">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-content/40">
                <ChartBreakoutSquare
                  aria-hidden
                  className="size-3 shrink-0"
                  strokeWidth={1.75}
                />
                {binding ? (project?.name ?? "Task") : "Ad hoc conversation"}
              </div>
              <div className="font-medium leading-snug text-content">
                {binding ? binding.task.title : "Add to a task"}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-content/50">
                {binding
                  ? binding.task.archived
                    ? "Archived task. Context is no longer added to messages."
                    : taskWide
                      ? "One conversation across this task’s working copies. Provider approvals still apply."
                      : "Task context is included with your next message."
                  : "Keep related agents and working copies together."}
              </p>
              {binding && binding.task.links.length ? (
                <div
                  role="group"
                  className="mt-2 flex flex-col"
                  aria-label="Linked issues"
                >
                  {/* cleanLinkedItem guarantees a non-empty url on board data. */}
                  {binding.task.links.map((link, index) => (
                    <LinkedIssueRow key={index} issue={link} />
                  ))}
                </div>
              ) : null}
            </div>
            {binding ? (
              <>
                <div className="px-3.5 py-3">
                  <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-content/40">
                    <span>Repositories</span>
                    <span className="rounded bg-content/6 px-1.5 py-px">
                      {binding.task.workstreams.length}
                    </span>
                  </div>
                  <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                    {binding.task.workstreams.map((ws) => {
                      const current = ws.id === currentWorkstream?.id;
                      const sameHost = sameExecutionHost(
                        cwd,
                        ws.worktreePath,
                      );
                      // Task-wide sessions can work in any lane's copy — they
                      // count toward occupancy everywhere.
                      const occupied = new Set([
                        ...(ws.sessionIds ?? []),
                        ...taskWideSessionIds(binding.task),
                      ]).size;
                      const status = !ws.worktreePath
                        ? "Not prepared"
                        : current
                          ? taskWide
                            ? "Starting directory"
                            : "This session"
                          : taskWide
                            ? "Task working copy"
                            : occupied
                              ? `${occupied} ${occupied === 1 ? "session" : "sessions"}${sameHost ? "" : " · other host"}`
                              : sameHost
                                ? "Prepared"
                                : "Different host";
                      return (
                        <div
                          key={ws.id}
                          className={`rounded-lg px-2.5 py-2 ${current ? "border border-accent/15 bg-accent/5" : "border border-transparent"}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-medium text-content/85">
                              {projectName(ws.projectPath)}
                            </span>
                            <span
                              className={`shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${current ? "bg-accent/12 text-accent" : "text-content/45"}`}
                            >
                              {status}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-content/55">
                            <GitBranch
                              aria-hidden
                              className="size-3 shrink-0"
                            />
                            <span className="min-w-0 truncate font-mono text-content/70">
                              {ws.branch}
                            </span>
                            {ws.base ? (
                              <span className="min-w-0 truncate text-content/35">
                                → {ws.base}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-content/35">
                            {ws.worktreePath ? (
                              <FolderTree
                                aria-hidden
                                className="size-3 shrink-0"
                              />
                            ) : null}
                            <span
                              className="truncate"
                              title={ws.worktreePath}
                            >
                              {ws.worktreePath
                                ? prettyCwd(ws.worktreePath)
                                : "Working copy not prepared"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : bindings.length ? (
              <p className="px-3.5 py-3 text-content/60">
                This session has conflicting task bindings. Detach it before
                choosing a task.
              </p>
            ) : (
              <div className="p-2">
                <div className="mb-2 flex items-center justify-between gap-2 px-1 text-[11px] text-content/65">
                  <span>Scope</span>
                  <SearchableSelect
                    label="Conversation scope"
                    value={attachScope}
                    onChange={(value) =>
                      setAttachScope(value as "task" | "repository")
                    }
                    options={[
                      { value: "task", label: "All task repositories" },
                      { value: "repository", label: "Current repository" },
                    ]}
                    searchable={false}
                    variant="pill"
                    align="end"
                  />
                </div>
                <input
                  autoFocus
                  aria-label="Search tasks"
                  placeholder="Find a task…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="mb-1.5 h-8 w-full rounded-md border border-content/10 bg-content/4 px-2 text-[12px] text-content outline-none placeholder:text-content/35 focus:border-accent/40"
                />
                <div className="max-h-48 overflow-y-auto">
                  {tasks
                    .filter(
                      (task) =>
                        !task.archived &&
                        task.title.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        aria-label={`Attach to ${task.title}`}
                        disabled={busy || unavailable}
                        onClick={() =>
                          void run((checkout) => {
                            attachTaskSession(
                              session.id,
                              checkout,
                              task.id,
                              attachScope,
                            );
                            setOpen(false);
                            trigger.current?.focus();
                          })
                        }
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-content/6 focus-visible:bg-content/6 disabled:opacity-40"
                      >
                        <ChartBreakoutSquare
                          aria-hidden
                          className="size-3.5 shrink-0 text-content/35"
                          strokeWidth={1.75}
                        />
                        <span className="min-w-0 flex-1 truncate text-content/80">
                          {task.title}
                        </span>
                        <span className="min-w-0 max-w-[45%] truncate text-[10px] text-content/35">
                          {pickMeta(task)}
                        </span>
                      </button>
                    ))}
                  {!tasks.some(
                    (task) =>
                      !task.archived &&
                      task.title.toLowerCase().includes(query.toLowerCase()),
                  ) ? (
                    <p className="px-2 py-3 text-[11px] text-content/40">
                      No matching tasks.
                    </p>
                  ) : null}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 border-t border-content/8 p-2">
              {bindings.length ? (
                <>
                  {binding && !binding.task.archived ? (
                    <span className="flex items-center gap-0.5">
                      <button
                        type="button"
                        className={`${button} flex items-center gap-1.5`}
                        onClick={openTask}
                      >
                        <ExternalLink aria-hidden className="size-3" />
                        Open on Board
                      </button>
                      <button
                        type="button"
                        title="Dock the task panel beside this conversation"
                        className={`${button} flex items-center gap-1.5`}
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent(DOCK_TASK_EVENT, {
                              detail: binding.task.id,
                            }),
                          );
                          setOpen(false);
                          trigger.current?.focus();
                        }}
                      >
                        <PanelRight aria-hidden className="size-3" />
                        Dock panel
                      </button>
                    </span>
                  ) : (
                    <span />
                  )}
                  <button
                    type="button"
                    className={`${button} flex items-center gap-1.5`}
                    disabled={busy}
                    onClick={() => {
                      detachTaskSession(session.id);
                      setOpen(false);
                      trigger.current?.focus();
                    }}
                  >
                    <X aria-hidden className="size-3" />
                    Detach
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={`${button} flex w-full items-center gap-1.5 text-left`}
                  disabled={busy || unavailable}
                  onClick={() => void run(setCreating)}
                >
                  <Plus aria-hidden className="size-3.5" />
                  New task from this session
                </button>
              )}
            </div>
            {unavailable && !bindings.length ? (
              <p className="px-3.5 pb-3 text-[11px] text-content/50">
                Choose an existing working copy first.
              </p>
            ) : null}
            {busy ? (
              <p role="status" className="px-3.5 pb-3 text-content/50">
                Checking working copy…
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="px-3.5 pb-3 text-red-300">
                {error}
              </p>
            ) : null}
          </div>
        </Popover>
      ) : null}
      {open && creating ? (
        <NewTaskDialog
          items={[]}
          recents={[]}
          lanes={tasks.flatMap((task) => task.workstreams)}
          busy={busy}
          error={error}
          initialTitle={session.title}
          fixedWorkstream={creating}
          // Anchor project resolution to the workstream's repo — without it
          // the dialog falls back to the globally active saved project.
          initialProject={creating.projectPath}
          initialLinks={
            session.linkedWorkItem
              ? [
                  session.linkedWorkItem,
                  ...(session.linkedWorkItem.additionalItems ?? []),
                ]
              : []
          }
          onSubmit={create}
          onCancel={close}
        />
      ) : null}
    </>
  );
}
