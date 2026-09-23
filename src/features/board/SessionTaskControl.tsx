import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Popover } from "../../shared/ui/Popover";
import {
  CheckCircle,
  ChevronDown,
  ExternalLink,
  GitBranch,
  Plus,
  X,
} from "../../shared/ui/icons";
import { pathKey, prettyCwd, projectName } from "../../shared/lib/paths";
import { sessionWorkCwd, type Session } from "../sessions/model/session";
import {
  boardFromSnapshot,
  boardSnapshot,
  subscribeBoard,
  type TaskWorkstream,
} from "./boardStore";
import { NewTaskDialog, type NewTaskSpec } from "./NewTaskDialog";
import {
  attachTaskSession,
  detachTaskSession,
  OPEN_TASK_EVENT,
  sessionTaskBindings,
  taskSessionCheckout,
} from "./taskSession";

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
  const primary = binding?.task.primarySessionId === session.id;
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
    if (binding?.task.archived) {
      setOpen(true);
      return;
    }
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
      });
      setCreating(null);
      setOpen(false);
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
          <CheckCircle
            aria-hidden
            className={`size-3.5 shrink-0 ${binding ? "text-accent" : "text-content/35"}`}
            strokeWidth={1.75}
          />
          <span className="truncate font-medium">
            {binding
              ? binding.task.title
              : bindings.length
                ? "Resolve task association"
                : "Add to task"}
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
            className="ml-auto hidden min-w-0 items-center gap-1 truncate text-[10px] text-content/40 @sm:flex"
            title={cwd}
          >
            <GitBranch aria-hidden className="size-3 shrink-0" />
            {primary
              ? `${binding.task.workstreams.length} working copies`
              : currentWorkstream?.branch}
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
          autoFocus={bindings.length > 0}
          tabIndex={-1}
        >
          <div className="flex flex-col text-[12px]">
            <div className="border-b border-content/8 px-3.5 py-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-content/40">
                {binding ? "Shared task" : "Organize this conversation"}
              </div>
              <div className="font-medium leading-snug text-content">
                {binding ? binding.task.title : "Add to a task"}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-content/50">
                {binding
                  ? binding.task.archived
                    ? "Archived task. Context is no longer added to messages."
                    : primary
                      ? "One conversation across this task’s working copies. Provider approvals still apply."
                      : "Task context is included with your next message."
                  : "Keep related agents and working copies together."}
              </p>
            </div>
            {binding ? (
              <>
                <div className="px-3.5 py-3">
                  <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-content/40">
                    <span>Working copies</span>
                    <span className="rounded bg-content/6 px-1.5 py-px">
                      {binding.task.workstreams.length}
                    </span>
                  </div>
                  <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                    {binding.task.workstreams.map((ws) => {
                      const current = ws.id === currentWorkstream?.id;
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
                              className={`shrink-0 text-[10px] ${current ? "text-accent" : "text-content/40"}`}
                            >
                              {current
                                ? primary
                                  ? "Starting directory"
                                  : "This session"
                                : primary
                                  ? "Task working copy"
                                  : `${ws.sessionIds?.length ?? 0} ${(ws.sessionIds?.length ?? 0) === 1 ? "session" : "sessions"}`}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-content/55">
                            <GitBranch
                              aria-hidden
                              className="size-3 shrink-0"
                            />
                            <span className="truncate">{ws.branch}</span>
                          </div>
                          <div
                            className="mt-0.5 truncate text-[10px] text-content/35"
                            title={ws.worktreePath}
                          >
                            {ws.worktreePath
                              ? prettyCwd(ws.worktreePath)
                              : "Working copy not prepared"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {binding.task.links.length ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {binding.task.links.map((link, index) => (
                        <span
                          key={index}
                          className="max-w-full truncate rounded bg-content/6 px-1.5 py-0.5 text-[10px] text-content/55"
                          title={link.title}
                        >
                          {link.identifier ?? link.title ?? link.url}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </>
            ) : bindings.length ? (
              <p className="px-3.5 py-3 text-content/60">
                This session has conflicting task bindings. Detach it before
                choosing a task.
              </p>
            ) : (
              <div className="p-2">
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
                            attachTaskSession(session.id, checkout, task.id);
                            setOpen(false);
                            trigger.current?.focus();
                          })
                        }
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-content/6 focus-visible:bg-content/6 disabled:opacity-40"
                      >
                        <CheckCircle
                          aria-hidden
                          className="size-3.5 shrink-0 text-content/35"
                        />
                        <span className="min-w-0 flex-1 truncate text-content/80">
                          {task.title}
                        </span>
                        <span className="text-[10px] text-content/35">
                          {task.workstreams.length} worktrees
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
                    <button
                      type="button"
                      className={`${button} flex items-center gap-1.5`}
                      onClick={openTask}
                    >
                      <ExternalLink aria-hidden className="size-3" />
                      Open on Board
                    </button>
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
