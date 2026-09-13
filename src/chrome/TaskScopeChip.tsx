import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { basename } from "../lib/fs";
import { prettyCwd } from "../lib/paths";
import {
  projectsSnapshot,
  repositoryDisplayName,
  subscribeProjects,
} from "../lib/projects";
import {
  OPEN_TASK_DETAILS,
  repositoryForChild,
  subscribeTaskWorkspaces,
  taskForSession,
  taskWorkspacesSnapshot,
  type TaskChild,
  type TaskWorkspace,
} from "../lib/taskWorkspaces";
import {
  childDelivery,
  deliveryStores,
  type DeliveryStores,
} from "../lib/taskDelivery";
import { AZURE_PR_ASSOCIATIONS_CHANGED } from "../lib/azureRepos";
import { AZURE_CI_SOURCES_CHANGED } from "../lib/azurePipelines";
import {
  diffStatsVersion,
  peekProjectDiffStats,
  subscribeDiffStatsVersion,
  useProjectDiffStats,
} from "../hooks/useProjectDiffStats";
import {
  branchPrVersion,
  cachedBranchPr,
  subscribeBranchPrVersion,
  useCachedBranchPr,
} from "../hooks/useBranchPr";
import { Popover } from "./Popover";
import {
  Check,
  ChevronDown,
  Task,
  CircleAlert,
  CircleDashed,
  CircleDot,
  GitBranch,
  GitPullRequest,
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

/** Delivery badges for a child row: linked PRs and CI pipelines, colored
 * only when they need attention. Compact icons, never provider payloads. */
export function DeliveryBadges({
  delivery,
}: {
  delivery: { prs: number; prNeedsAttention: boolean; ci: number; ciRunning: boolean; ciFailing: boolean };
}) {
  return (
    <>
      {delivery.prs ? (
        <span
          title={
            delivery.prNeedsAttention
              ? `${delivery.prs} pull request${delivery.prs === 1 ? "" : "s"} · needs attention`
              : `${delivery.prs} pull request${delivery.prs === 1 ? "" : "s"}`
          }
          className={`flex shrink-0 items-center gap-0.5 ${
            delivery.prNeedsAttention ? "text-red-400" : "text-content/45"
          }`}
        >
          <GitPullRequest className="size-3" strokeWidth={1.75} />
          {delivery.prs > 1 ? (
            <span className="tabular-nums">{delivery.prs}</span>
          ) : null}
        </span>
      ) : null}
      {delivery.ci ? (
        <span
          title={
            delivery.ciFailing
              ? "A linked pipeline failed"
              : delivery.ciRunning
                ? "A linked pipeline is running"
                : `${delivery.ci} pipeline${delivery.ci === 1 ? "" : "s"}`
          }
          className={`flex shrink-0 items-center gap-0.5 ${
            delivery.ciFailing
              ? "text-red-400"
              : delivery.ciRunning
                ? "text-amber-400"
                : "text-content/45"
          }`}
        >
          <CircleDashed className="size-3" strokeWidth={1.75} />
          {delivery.ci > 1 ? (
            <span className="tabular-nums">{delivery.ci}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

function TaskChildRow({
  task,
  entry,
  current,
  needsInput,
  stores,
  onOpen,
  onRetry,
}: {
  task: TaskWorkspace;
  entry: TaskChild;
  current: boolean;
  needsInput: boolean;
  stores: DeliveryStores;
  onOpen?: () => void;
  onRetry?: () => void;
}) {
  const ready =
    entry.sessionIds.length > 0 || entry.launch.state === "ready";
  const failed = entry.launch.state === "failed";
  // Rows only mount while the popover is open — stats subscribe on sight.
  const stats = useProjectDiffStats(
    entry.workingCopy ?? "",
    !!entry.workingCopy,
  );
  const branch = stats?.branch ?? entry.branch;
  const githubPr = useCachedBranchPr(entry.workingCopy ?? "", branch);
  const delivery = useMemo(
    () => childDelivery(task, entry, [branch, entry.branch], githubPr, stores),
    [task, entry, branch, githubPr, stores],
  );
  const detail =
    branch || (stats?.files ?? 0) > 0 || delivery.prs > 0 || delivery.ci > 0;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={!ready}
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/5 disabled:opacity-50"
      >
        <span className="flex min-w-0 items-center gap-2 self-stretch">
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
          <DeliveryBadges delivery={delivery} />
          <span className="shrink-0 truncate text-[10px] text-content/40">
            {current
              ? "Current"
              : ready
                ? ""
                : entry.workingCopy
                  ? prettyCwd(entry.workingCopy)
                  : "Prepare later"}
          </span>
        </span>
        {detail ? (
          <span className="mt-0.5 flex min-w-0 items-center gap-2 self-stretch pl-5 text-[10px] text-content/45">
            {branch ? (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranch className="size-2.5 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{branch}</span>
              </span>
            ) : null}
            {stats?.files ? (
              <span className="shrink-0 tabular-nums">
                <span className="text-emerald-400/80">+{stats.additions}</span>
                {" "}
                <span className="text-red-400/80">−{stats.deletions}</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      {(failed ||
        (!ready && entry.launch.state !== "working" && entry.workingCopy)) &&
      onRetry ? (
        <button
          type="button"
          title={
            entry.launch.error ??
            (failed ? "Retry launch" : "Start this repository")
          }
          onClick={onRetry}
          className="shrink-0 rounded-md px-1.5 py-1 text-[10px] text-content/60 hover:bg-content/8 hover:text-content"
        >
          {failed ? "Retry" : "Start"}
        </button>
      ) : null}
    </div>
  );
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
  // Re-read saved provider links when they change so badges stay current.
  const [deliveryTick, setDeliveryTick] = useState(0);
  useEffect(() => {
    const bump = () => setDeliveryTick((value) => value + 1);
    window.addEventListener(AZURE_PR_ASSOCIATIONS_CHANGED, bump);
    window.addEventListener(AZURE_CI_SOURCES_CHANGED, bump);
    return () => {
      window.removeEventListener(AZURE_PR_ASSOCIATIONS_CHANGED, bump);
      window.removeEventListener(AZURE_CI_SOURCES_CHANGED, bump);
    };
  }, []);
  const stores = useMemo(
    () => deliveryStores(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deliveryTick],
  );
  const anchor = useRef<HTMLButtonElement>(null);
  // Re-derive when a stats or PR cache publish lands — the peeks below never
  // subscribe or fetch, so the ticks are what keep the dot honest.
  const statsV = useSyncExternalStore(
    subscribeDiffStatsVersion,
    diffStatsVersion,
  );
  const prV = useSyncExternalStore(subscribeBranchPrVersion, branchPrVersion);
  // Task-level attention: a linked pipeline failed or PR needs the author —
  // derived from saved links and already-cached data only; the closed chip
  // never fetches.
  const taskAttention = useMemo(
    () =>
      scope
        ? scope.task.children.some((entry) => {
            if (!entry.workingCopy) return false;
            const branch =
              peekProjectDiffStats(entry.workingCopy)?.branch ?? entry.branch;
            const delivery = childDelivery(
              scope.task,
              entry,
              [branch, entry.branch],
              cachedBranchPr(entry.workingCopy, branch),
              stores,
            );
            return delivery.ciFailing || delivery.prNeedsAttention;
          })
        : false,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, stores, tasksRaw, statsV, prV],
  );
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
        ) : taskAttention ? (
          <span
            title="A linked pipeline failed or a pull request needs attention"
            className="size-1.5 shrink-0 rounded-full bg-red-400"
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
              const ready =
                entry.sessionIds.length > 0 ||
                entry.launch.state === "ready";
              const failed = entry.launch.state === "failed";
              return (
                <TaskChildRow
                  key={entry.id}
                  task={task}
                  entry={entry}
                  current={current}
                  needsInput={!!needsInput}
                  stores={stores}
                  onOpen={
                    ready
                      ? () => {
                          setOpen(false);
                          onOpenChild?.(task.id, entry.id);
                        }
                      : undefined
                  }
                  onRetry={
                    (failed ||
                      (!ready &&
                        entry.launch.state !== "working" &&
                        entry.workingCopy)) &&
                    onRetryChild
                      ? () => {
                          setOpen(false);
                          onRetryChild(task.id, entry.id);
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
          <div className="border-t border-content/10 px-1.5 py-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(
                  new CustomEvent(OPEN_TASK_DETAILS, { detail: task.id }),
                );
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
            >
              <Task
                aria-hidden="true"
                className="size-3.5 shrink-0 text-content/50"
                strokeWidth={1.75}
              />
              Task details…
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(
                  new CustomEvent("monocode:open-task-prs", {
                    detail: task.id,
                  }),
                );
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
            >
              <GitPullRequest
                aria-hidden="true"
                className="size-3.5 shrink-0 text-content/50"
                strokeWidth={1.75}
              />
              Create pull requests…
            </button>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
