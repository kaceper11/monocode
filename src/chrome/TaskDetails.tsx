import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { basename } from "../lib/fs";
import { pathKey, prettyCwd } from "../lib/paths";
import { projectsSnapshot, subscribeProjects } from "../lib/projects";
import {
  getVerifiedFamilies,
  healthyFamilyMember,
} from "../lib/repositoryFamilies";
import { openWorktreeManager } from "../lib/worktreeRemoval";
import { modalSwap } from "./Modal";
import {
  loadTaskWorkspaces,
  OPEN_TASK_PRS,
  projectForTask,
  repositoryForChild,
  subscribeTaskWorkspaces,
  taskAttemptLabel,
  taskChildPrepared,
  taskChildRepoLabel,
  taskChildRepoName,
  taskForSession,
  taskOwnsCheckout,
  taskSessionIds,
  taskWorkspacesSnapshot,
  type TaskChild,
  type TaskWorkspace,
} from "../lib/taskWorkspaces";
import { childDeliveryLinks, deliveryFromLinks } from "../lib/taskDelivery";
import { useDeliveryStores } from "../hooks/useDeliveryStores";
import { azurePrUrl } from "../lib/azureRepos";
import { ciMatches, ciState, ciUrl } from "../lib/azurePipelines";
import {
  loadTaskChildCi,
  peekTaskChildCi,
  subscribeTaskCiVersion,
  taskChildCiLoading,
  taskCiVersion,
  type TaskCiFix,
  type TaskDeliveryRef,
} from "../lib/taskCi";
import {
  listTaskPrDrafts,
  subscribeTaskPrs,
  taskPrRowKey,
  taskPrsSnapshot,
} from "../lib/taskPrs";
import { OPEN_INBOX_WORK_ITEM, sessionWorkItems } from "../lib/sessionWorkItem";
import type { LinkedWorkItem } from "../lib/session";
import { sessionDisplayTitle, sessionWorkCwd } from "../lib/session";
import type { SessionSummary } from "../lib/sessionStore";
import {
  diffStatsVersion,
  peekProjectDiffStats,
  subscribeDiffStatsVersion,
} from "../hooks/useProjectDiffStats";
import {
  branchPrVersion,
  cachedBranchPr,
  subscribeBranchPrVersion,
} from "../hooks/useBranchPr";
import { Modal } from "./Modal";
import { HarnessIcon } from "./HarnessIcon";
import { InboxProviderMark } from "./InboxProviderMark";
import { DeliveryBadges, TaskChildStateIcon } from "./TaskScopeChip";
import {
  ChevronRight,
  CircleDashed,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Wrench,
} from "./icons";

/** Tickets linked to the task itself plus to any of its conversations —
 * deduped on provider+url+account, task ticket first. */
function taskWorkItems(
  task: TaskWorkspace,
  sessions: readonly SessionSummary[],
): LinkedWorkItem[] {
  const items: LinkedWorkItem[] = [];
  const seen = new Set<string>();
  const push = (item: LinkedWorkItem | undefined) => {
    if (!item) return;
    const key = `${item.provider ?? "github"}${item.url}${item.account ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  push(task.ticket);
  for (const item of task.ticket?.additionalItems ?? []) push(item);
  const ids = taskSessionIds(task);
  for (const session of sessions) {
    if (!ids.has(session.id)) continue;
    for (const item of sessionWorkItems(session)) push(item);
  }
  return items;
}

const openExternal = (url: string) => {
  if (/^https?:\/\//i.test(url)) void openUrl(url).catch(() => {});
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="px-4 pb-3">
      <h3 className="pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-content/40">
        {title}
      </h3>
      <div className="flex flex-col gap-px">{children}</div>
    </section>
  );
}

/**
 * Task details sheet — a read-only rollup of everything a task touches:
 * linked tickets, per-repository working copies, PR/MR and CI rows, and
 * conversations. Saved links render immediately; GitHub checks and GitLab
 * MR pipelines load on demand per prepared child (deduped, no polling).
 * Rows open the provider's review surface in the task's conversation via
 * `onOpenDelivery`; it never launches children (that's `onStart`/`onOpenChild`).
 */
export function TaskDetails({
  taskId,
  sessions,
  needsInputIds,
  busySessionIds,
  onClose,
  onOpenSession,
  onOpenChild,
  onRetryChild,
  onStart,
  onEdit,
  onFixCi,
  onOpenDelivery,
  onNewConversation,
  onSyncBranches,
}: {
  taskId: string;
  sessions: readonly SessionSummary[];
  /** Sessions waiting on the user — drives the attention section and the
   * per-conversation state badge. */
  needsInputIds?: ReadonlySet<string>;
  /** Sessions mid-turn — the "Working" conversation badge. */
  busySessionIds?: ReadonlySet<string>;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenChild?: (taskId: string, childId: string) => void;
  /** Re-runs a failed child's launch — distinct from Open, which only
   * reaches an already-live session. */
  onRetryChild?: (taskId: string, childId: string) => void;
  /** Prepares every actionable child and starts the task's session — the
   * explicit launch verb for a task with no live conversation. */
  onStart?: (taskId: string) => void;
  /** Edit the task — a child id opens that child's working-copy setup. */
  onEdit?: (taskId: string, childId?: string) => void;
  /** Send a CI failure's repair evidence to the task's session. */
  onFixCi?: (task: TaskWorkspace, fix: TaskCiFix) => void;
  /** Open a row's review surface (PR comments, checks, pipeline jobs) as a
   * tab inside the task's conversation workspace. May be async — the sheet
   * shows an "Opening review…" status while it resolves. */
  onOpenDelivery?: (
    task: TaskWorkspace,
    child: TaskChild,
    ref: TaskDeliveryRef,
  ) => void | Promise<void>;
  /** Start another conversation rooted in a child's working copy — the
   * handler links the session to the task and carries title + ticket. */
  onNewConversation?: (taskId: string, childId: string) => void;
  /** Merge the remote default into every linked working copy — conflicts
   * route to each copy's owning agent. */
  onSyncBranches?: (taskId: string) => void;
}) {
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const projectsRaw = useSyncExternalStore(subscribeProjects, projectsSnapshot);
  const prsRaw = useSyncExternalStore(subscribeTaskPrs, taskPrsSnapshot);
  const statsV = useSyncExternalStore(
    subscribeDiffStatsVersion,
    diffStatsVersion,
  );
  const branchPrV = useSyncExternalStore(
    subscribeBranchPrVersion,
    branchPrVersion,
  );
  const ciV = useSyncExternalStore(subscribeTaskCiVersion, taskCiVersion);
  const stores = useDeliveryStores();

  const task = useMemo(
    () => loadTaskWorkspaces().find((entry) => entry.id === taskId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskId, tasksRaw],
  );

  // Per-child rollup: observed branch, delivery links and PR drafts — all
  // from peeks/saved stores so the sheet never triggers Git or provider IO.
  const rows = useMemo(() => {
    if (!task) return [];
    const project = projectForTask(task);
    const drafts = listTaskPrDrafts();
    return task.children.map((child) => {
      const branch = child.workingCopy
        ? (peekProjectDiffStats(child.workingCopy)?.branch ?? child.branch)
        : child.branch;
      const githubPr =
        child.workingCopy && branch
          ? cachedBranchPr(child.workingCopy, branch)
          : null;
      const links = childDeliveryLinks(
        task,
        child,
        [branch, child.branch],
        githubPr,
        stores,
      );
      return {
        child,
        repo: repositoryForChild(task, child, project),
        branch,
        links,
        delivery: deliveryFromLinks(links),
        draft: drafts[taskPrRowKey(task.id, child.id)],
        ci: peekTaskChildCi(child.workingCopy, branch),
        ciLoading: taskChildCiLoading(child.workingCopy, branch),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, projectsRaw, prsRaw, statsV, branchPrV, ciV, stores]);

  // The sheet's one fetch: live CI (GitHub checks, GitLab pipeline) per
  // checkout, once per open. Saved Azure links need no load — they are kept
  // fresh by their watchers.
  const ciRequested = useRef(new Set<string>());
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [newConvOpen, setNewConvOpen] = useState(false);
  useEffect(() => {
    for (const row of rows) {
      const { child, branch } = row;
      if (!child.workingCopy || !branch) continue;
      const key = `${child.workingCopy}${branch}`;
      if (ciRequested.current.has(key)) continue;
      ciRequested.current.add(key);
      loadTaskChildCi(child.workingCopy, branch, row.links.githubPr?.number);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const tickets = useMemo(
    () => (task ? taskWorkItems(task, sessions) : []),
    [task, sessions],
  );

  const conversations = useMemo(() => {
    if (!task) return { resolved: [] as SessionSummary[], missing: 0 };
    const ids: string[] = [];
    for (const id of task.sessionIds ?? []) if (!ids.includes(id)) ids.push(id);
    for (const child of task.children)
      for (const id of child.sessionIds) if (!ids.includes(id)) ids.push(id);
    const byId = new Map(sessions.map((entry) => [entry.id, entry]));
    const recorded = ids
      .map((id) => byId.get(id))
      .filter((entry): entry is SessionSummary => Boolean(entry));
    // Sessions rooted in a task-owned worktree belong here even when they
    // arrived without a link — the copy exists for this task's work. A
    // session recorded on another task stays with it.
    const ownedPaths = new Set(
      task.children
        .filter((child) => child.workingCopy && taskOwnsCheckout(child))
        .map((child) => pathKey(child.workingCopy!)),
    );
    const seen = new Set(ids);
    const extras = sessions.filter((session) => {
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      if (!ownedPaths.has(pathKey(sessionWorkCwd(session)))) return false;
      const owner = taskForSession(session.id);
      return !owner || owner.task.id === task.id;
    });
    return {
      resolved: [...recorded, ...extras],
      missing: ids.length - recorded.length,
      // The launch session — the one the task brief went to.
      primaryId: task.sessionIds?.[0],
    };
  }, [task, sessions]);

  if (!task) return null;
  const project = projectForTask(task);
  const multiAttempt = task.attempts.length > 1;
  // One open at a time — the async mount (session resolve, branch probe,
  // provider target) has no progress of its own, so the sheet says so.
  const openDelivery = onOpenDelivery
    ? (child: TaskChild, ref: TaskDeliveryRef) => {
        if (deliveryBusy) return;
        setDeliveryBusy(true);
        void Promise.resolve(onOpenDelivery(task, child, ref)).finally(() =>
          setDeliveryBusy(false),
        );
      }
    : undefined;

  // "Needs attention" — the sheet's actionable layer. Same rows appear in
  // their detail sections below; this list is the compact "what waits on
  // you" rollup so nothing actionable is buried mid-sheet.
  type AttentionItem = {
    key: string;
    icon: React.ReactNode;
    title: string;
    meta: string;
    open?: () => void;
    action?: React.ReactNode;
  };
  const attention: AttentionItem[] = [];
  if (!task.archived) {
    for (const session of conversations.resolved) {
      if (!needsInputIds?.has(session.id)) continue;
      attention.push({
        key: `wait:${session.id}`,
        icon: (
          <HarnessIcon
            harness={session.harness}
            className="size-3.5 shrink-0"
          />
        ),
        title: sessionDisplayTitle(session.title, session.harness),
        meta: "Waiting on you",
        open: onOpenSession
          ? () => {
              onClose();
              onOpenSession(session.id);
            }
          : undefined,
      });
    }
    for (const { child, links, ci } of rows) {
      const repo = taskChildRepoLabel(task, child, project);
      const failIcon = (
        <CircleDashed
          className="size-3.5 shrink-0 text-red-400"
          strokeWidth={1.75}
        />
      );
      const reviewIcon = (
        <GitPullRequest
          className="size-3.5 shrink-0 text-amber-400"
          strokeWidth={1.75}
        />
      );
      for (const assoc of links.prs) {
        if (assoc.pr.status.toLowerCase() !== "active") continue;
        if (!assoc.pr.reviewers.some((reviewer) => reviewer.vote < 0)) continue;
        attention.push({
          key: `pr:${child.id}:${assoc.target.number}`,
          icon: reviewIcon,
          title: `#${assoc.pr.pullRequestId} ${assoc.pr.title}`,
          meta: `Review feedback · ${repo}`,
          open: openDelivery
            ? () => openDelivery(child, { kind: "pr" })
            : undefined,
        });
      }
      for (const source of links.ci) {
        const run = source.last?.run;
        if (!run || run.result !== "failed" || !ciMatches(run)) continue;
        attention.push({
          key: `ci:${child.id}:${source.definitionName}`,
          icon: failIcon,
          title: source.definitionName,
          meta: `CI failing · ${repo}`,
          open: openDelivery
            ? () => openDelivery(child, { kind: "ci" })
            : undefined,
          action: onFixCi ? (
            <FixButton
              title="Send this run's failed job to the task's agent"
              onClick={() => onFixCi(task, { kind: "azure", source, run })}
            />
          ) : undefined,
        });
      }
      if (ci?.github) {
        const gh = ci.github;
        const failing = gh.checks.filter(
          (check) => check.state === "Failed" || check.state === "Cancelled",
        );
        if (failing.length)
          attention.push({
            key: `ghci:${child.id}`,
            icon: failIcon,
            title: `Checks · PR #${gh.number}`,
            meta: `${failing.length} failing · ${repo}`,
            open: openDelivery
              ? () =>
                  openDelivery(child, {
                    kind: "pr",
                    provider: "github",
                    repo: gh.repo || undefined,
                    number: gh.number,
                  })
              : undefined,
            action:
              gh.prState.toUpperCase() === "OPEN" &&
              gh.repo &&
              onFixCi &&
              child.workingCopy ? (
                <FixButton
                  title="Send the failing checks to the task's agent"
                  onClick={() =>
                    onFixCi(task, {
                      kind: "github",
                      cwd: child.workingCopy!,
                      repo: gh.repo,
                      number: gh.number,
                    })
                  }
                />
              ) : undefined,
          });
      }
      if (ci?.gitlab?.pipeline) {
        const gl = ci.gitlab;
        const pipeline = ci.gitlab.pipeline;
        if (pipeline.state === "Failed" || pipeline.state === "Cancelled")
          attention.push({
            key: `glci:${child.id}`,
            icon: failIcon,
            title: `Pipeline #${pipeline.id} · !${gl.mrNumber}`,
            meta: `${pipeline.state} · ${repo}`,
            open:
              openDelivery && gl.repo
                ? () =>
                    openDelivery(child, {
                      kind: "pr",
                      provider: "gitlab",
                      repo: gl.repo,
                      number: gl.mrNumber,
                    })
                : undefined,
            action:
              gl.mrState === "open" &&
              gl.repo &&
              onFixCi &&
              child.workingCopy ? (
                <FixButton
                  title="Send this pipeline failure to the task's agent"
                  onClick={() =>
                    onFixCi(task, {
                      kind: "gitlab",
                      cwd: child.workingCopy!,
                      repo: gl.repo,
                      number: gl.mrNumber,
                    })
                  }
                />
              ) : undefined,
          });
      }
    }
  }

  // Children whose recorded working copy can host another conversation.
  const newConvTargets = rows.filter(({ child }) => child.workingCopy);

  const description = [
    task.ticket?.identifier,
    project?.name,
    `${task.children.length} ${task.children.length === 1 ? "repository" : "repositories"}`,
    task.archived ? "archived" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Modal
      title={task.name}
      description={description}
      size="lg"
      className="max-h-[80vh]"
      onClose={onClose}
    >
      {deliveryBusy ? (
        <p role="status" className="px-3 py-1 text-[11px] text-content/50">
          Opening review…
        </p>
      ) : null}
      {attention.length ? (
        <Section title="Needs attention">
          {attention.map((item) => (
            <PrRow
              key={item.key}
              icon={item.icon}
              title={item.title}
              meta={item.meta}
              onOpen={item.open}
              action={item.action}
            />
          ))}
        </Section>
      ) : null}
      {tickets.length ? (
        <Section title="Tickets">
          {tickets.map((item) => (
            <button
              key={`${item.provider ?? "github"}${item.url}${item.account ?? ""}`}
              type="button"
              title={item.url}
              onClick={() => {
                onClose();
                window.dispatchEvent(
                  new CustomEvent(OPEN_INBOX_WORK_ITEM, { detail: item }),
                );
              }}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            >
              <InboxProviderMark
                provider={item.provider ?? "github"}
                className="size-3.5 shrink-0"
              />
              <span className="shrink-0 font-medium text-content/70">
                {item.identifier || `#${item.number}`}
              </span>
              <span className="min-w-0 flex-1 truncate text-content/60">
                {item.title ?? item.url}
              </span>
            </button>
          ))}
        </Section>
      ) : null}

      <Section title="Working copies">
        {rows.map(({ child, repo, branch, delivery }) => {
          const name = taskChildRepoName(task, child, project);
          const ready = taskChildPrepared(child);
          const failed = child.launch.state === "failed";
          // "Set up" configures a child saved without a copy in the edit
          // sheet; "Retry" re-runs a failed launch; "Start"/"Open" reaches
          // or creates the session. In-flight launches and archived tasks
          // launch nothing — a ready child's Open still reaches its session.
          const actionable = child.launch.state !== "working";
          const launchable = actionable && !task.archived;
          return (
            <div key={child.id} className="rounded-md px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <TaskChildStateIcon child={child} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-content">
                  {name}
                  {multiAttempt ? (
                    <span className="text-content/40">
                      {" "}
                      · {taskAttemptLabel(task, child.attemptId)}
                    </span>
                  ) : null}
                </span>
                <DeliveryBadges delivery={delivery} />
                {launchable && !child.workingCopy && onEdit ? (
                  <button
                    type="button"
                    title="Choose a working copy for this repository"
                    onClick={() => {
                      modalSwap();
                      onClose();
                      onEdit(task.id, child.id);
                    }}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-accent hover:bg-content/8"
                  >
                    Set up
                  </button>
                ) : launchable && failed && onRetryChild ? (
                  <button
                    type="button"
                    title={child.launch.error ?? "Retry launch"}
                    onClick={() => {
                      onClose();
                      onRetryChild(task.id, child.id);
                    }}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-content/60 hover:bg-content/8 hover:text-content"
                  >
                    Retry
                  </button>
                ) : (ready ? actionable : launchable) && onOpenChild ? (
                  <button
                    type="button"
                    title={
                      ready
                        ? "Open the task's session"
                        : "Prepare the working copy and start the session"
                    }
                    onClick={() => {
                      onClose();
                      onOpenChild(task.id, child.id);
                    }}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-content/60 hover:bg-content/8 hover:text-content"
                  >
                    {ready ? "Open" : "Start"}
                  </button>
                ) : null}
                {child.workingCopy ? (
                  <button
                    type="button"
                    title="Worktree details and cleanup"
                    aria-label={`Manage worktree ${name}`}
                    className="shrink-0 rounded-md p-0.5 text-content/40 hover:bg-content/8 hover:text-content"
                    onClick={() => {
                      const path = child.workingCopy!;
                      // Any healthy family member hosts the manager's Git
                      // calls — never the target; the repository anchor is
                      // the fallback.
                      const context =
                        healthyFamilyMember(
                          getVerifiedFamilies().get(pathKey(path)),
                          new Set([pathKey(path)]),
                        ) ??
                        repo?.anchor ??
                        path;
                      modalSwap();
                      onClose();
                      openWorktreeManager({ cwd: context, path });
                    }}
                  >
                    <ChevronRight className="size-3.5" strokeWidth={1.75} />
                  </button>
                ) : null}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-3 pl-5 text-[11px] text-content/45">
                {branch ? (
                  <span className="flex min-w-0 items-center gap-1">
                    <GitBranch
                      className="size-2.5 shrink-0"
                      strokeWidth={1.75}
                    />
                    <span className="truncate" title={branch}>
                      {branch}
                    </span>
                  </span>
                ) : null}
                <span
                  className="min-w-0 flex-1 truncate"
                  title={
                    child.workingCopy
                      ? prettyCwd(child.workingCopy)
                      : "No working copy chosen yet — Set up picks one"
                  }
                >
                  {child.workingCopy
                    ? prettyCwd(child.workingCopy)
                    : "Not set up yet"}
                </span>
                <span
                  className="shrink-0 text-content/35"
                  title={
                    taskOwnsCheckout(child)
                      ? "Created by this task — cleanup can remove it"
                      : "An existing checkout the task uses but does not own"
                  }
                >
                  {taskOwnsCheckout(child)
                    ? "task worktree"
                    : "shared checkout"}
                </span>
              </div>
              {child.launch.state === "failed" && child.launch.error ? (
                <p
                  className="mt-0.5 truncate pl-5 text-[11px] text-red-400/90"
                  title={child.launch.error}
                >
                  {child.launch.error}
                </p>
              ) : null}
            </div>
          );
        })}
      </Section>

      {rows.some(
        (row) =>
          row.links.prs.length ||
          row.links.githubPr ||
          row.ci?.gitlab ||
          row.draft,
      ) ? (
        <Section title="Pull requests">
          {rows.flatMap(({ child, links, draft, ci }) => {
            const label = taskChildRepoLabel(task, child, project);
            const entries: React.ReactNode[] = [];
            const seenUrls = new Set<string>();
            for (const assoc of links.prs) {
              let url: string | undefined;
              try {
                url = azurePrUrl(assoc.target);
              } catch {
                url = undefined;
              }
              seenUrls.add(url ?? "");
              const attention = assoc.pr.reviewers.some(
                (reviewer) => reviewer.vote < 0,
              );
              entries.push(
                <PrRow
                  key={`az:${child.id}:${assoc.target.number}`}
                  title={`#${assoc.pr.pullRequestId} ${assoc.pr.title}`}
                  meta={`${assoc.pr.status}${attention ? " · needs attention" : ""} · ${label}`}
                  url={url}
                  onOpen={
                    openDelivery
                      ? () => openDelivery(child, { kind: "pr" })
                      : undefined
                  }
                />,
              );
            }
            if (links.githubPr) {
              seenUrls.add(links.githubPr.url);
              entries.push(
                <PrRow
                  key={`gh:${links.githubPr.url}`}
                  title={`#${links.githubPr.number} ${links.githubPr.title}`}
                  meta={`${links.githubPr.state} · ${label}`}
                  url={links.githubPr.url}
                  onOpen={
                    openDelivery
                      ? () =>
                          openDelivery(child, {
                            kind: "pr",
                            provider: "github",
                            number: links.githubPr!.number,
                          })
                      : undefined
                  }
                />,
              );
            }
            if (ci?.gitlab) {
              const gl = ci.gitlab;
              seenUrls.add(gl.mrUrl);
              entries.push(
                <PrRow
                  key={`gl:${gl.mrUrl}`}
                  title={`!${gl.mrNumber} ${gl.mrTitle}`}
                  meta={`${gl.mrState} · ${label}`}
                  url={gl.mrUrl}
                  onOpen={
                    openDelivery && gl.repo
                      ? () =>
                          openDelivery(child, {
                            kind: "pr",
                            provider: "gitlab",
                            repo: gl.repo,
                            number: gl.mrNumber,
                          })
                      : undefined
                  }
                />,
              );
            }
            if (draft?.result && !seenUrls.has(draft.result.url)) {
              entries.push(
                <PrRow
                  key={`draft:${draft.result.url}`}
                  title={draft.result.title}
                  meta={`created via ${draft.result.provider} · ${label}`}
                  url={draft.result.url}
                />,
              );
            } else if (draft && !draft.result) {
              entries.push(
                <PrRow
                  key={`draft:${child.id}`}
                  title={draft.title || "Pull request draft"}
                  meta={`draft, not created · ${label}`}
                  muted
                />,
              );
            }
            return entries;
          })}
        </Section>
      ) : null}

      {rows.some(
        (row) =>
          row.links.ci.length ||
          row.ci?.github ||
          row.ci?.gitlab?.pipeline ||
          row.ciLoading,
      ) ? (
        <Section title="CI">
          {rows.flatMap(({ child, links, ci, ciLoading }) => {
            const repo = taskChildRepoLabel(task, child, project);
            const stateIcon = (state: string | null) => (
              <CircleDashed
                className={`size-3.5 shrink-0 ${state === "Failed" ? "text-red-400" : state === "Running" || state === "Queued" ? "text-amber-400" : "text-content/50"}`}
                strokeWidth={1.75}
              />
            );
            const out: React.ReactNode[] = [];
            // Saved Azure links — watcher-kept, one row per pipeline.
            for (const source of links.ci) {
              const run = source.last?.run;
              const state = run ? ciState(run.status, run.result) : null;
              let url: string | undefined;
              try {
                url = ciUrl(source.target, run?.id);
              } catch {
                url = undefined;
              }
              out.push(
                <PrRow
                  key={`ci:${child.id}:${source.definitionName}`}
                  icon={stateIcon(state)}
                  title={source.definitionName}
                  meta={`${[state, repo].filter(Boolean).join(" · ")}`}
                  url={url}
                  onOpen={
                    openDelivery
                      ? () => openDelivery(child, { kind: "ci" })
                      : undefined
                  }
                  action={
                    run &&
                    run.result === "failed" &&
                    ciMatches(run) &&
                    onFixCi ? (
                      <FixButton
                        title="Send this run's failed job to the task's agent"
                        onClick={() =>
                          onFixCi(task, { kind: "azure", source, run })
                        }
                      />
                    ) : undefined
                  }
                />,
              );
            }
            // GitHub check runs on the branch PR's head — failing checks get
            // their own rows since they carry the repair links.
            if (ci?.github) {
              const gh = ci.github;
              const checks = gh.checks;
              // Failed + cancelled are the repair's actionable set — matching
              // FAILING_CHECK_CONCLUSIONS, which githubCiRepair re-checks.
              const failing = checks.filter(
                (check) =>
                  check.state === "Failed" || check.state === "Cancelled",
              );
              const cancelled = checks.filter(
                (check) => check.state === "Cancelled",
              ).length;
              const running = checks.filter(
                (check) =>
                  check.state === "Running" || check.state === "Queued",
              ).length;
              const passing = checks.filter(
                (check) => check.state === "Passed",
              ).length;
              const summary =
                [
                  failing.length - cancelled
                    ? `${failing.length - cancelled} failing`
                    : "",
                  cancelled ? `${cancelled} cancelled` : "",
                  running ? `${running} running` : "",
                  passing ? `${passing} passed` : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "No checks reported";
              out.push(
                <PrRow
                  key={`ghci:${child.id}`}
                  icon={stateIcon(
                    failing.length - cancelled
                      ? "Failed"
                      : cancelled
                        ? "Cancelled"
                        : running
                          ? "Running"
                          : passing
                            ? "Passed"
                            : null,
                  )}
                  title={`Checks · PR #${gh.number}`}
                  meta={`${[summary, repo].filter(Boolean).join(" · ")}`}
                  url={gh.url}
                  onOpen={
                    openDelivery
                      ? () =>
                          openDelivery(child, {
                            kind: "pr",
                            provider: "github",
                            repo: gh.repo || undefined,
                            number: gh.number,
                          })
                      : undefined
                  }
                  action={
                    failing.length &&
                    gh.prState.toUpperCase() === "OPEN" &&
                    gh.repo &&
                    onFixCi &&
                    child.workingCopy ? (
                      <FixButton
                        title="Send the failing checks to the task's agent"
                        onClick={() =>
                          onFixCi(task, {
                            kind: "github",
                            cwd: child.workingCopy!,
                            repo: gh.repo,
                            number: gh.number,
                          })
                        }
                      />
                    ) : undefined
                  }
                />,
              );
              for (const [index, check] of failing.slice(0, 10).entries())
                out.push(
                  <PrRow
                    key={`ghci:${child.id}:${index}:${check.name}`}
                    icon={
                      <CircleDashed
                        className="size-3.5 shrink-0 text-red-400/70"
                        strokeWidth={1.75}
                      />
                    }
                    title={check.name}
                    meta={check.state}
                    url={check.url}
                    muted
                  />,
                );
            }
            // GitLab head pipeline on the branch's merge request — the
            // review opens the MR surface, which hosts GitLab's pipeline.
            if (ci?.gitlab?.pipeline) {
              const gl = ci.gitlab;
              const pipeline = ci.gitlab.pipeline;
              out.push(
                <PrRow
                  key={`glci:${child.id}`}
                  icon={stateIcon(pipeline.state)}
                  title={`Pipeline #${pipeline.id} · !${gl.mrNumber}`}
                  meta={`${[pipeline.state, repo].filter(Boolean).join(" · ")}`}
                  url={pipeline.url ?? gl.mrUrl}
                  onOpen={
                    openDelivery && gl.repo
                      ? () =>
                          openDelivery(child, {
                            kind: "pr",
                            provider: "gitlab",
                            repo: gl.repo,
                            number: gl.mrNumber,
                          })
                      : undefined
                  }
                  action={
                    (pipeline.state === "Failed" ||
                      pipeline.state === "Cancelled") &&
                    gl.mrState === "open" &&
                    gl.repo &&
                    onFixCi &&
                    child.workingCopy ? (
                      <FixButton
                        title="Send this pipeline failure to the task's agent"
                        onClick={() =>
                          onFixCi(task, {
                            kind: "gitlab",
                            cwd: child.workingCopy!,
                            repo: gl.repo,
                            number: gl.mrNumber,
                          })
                        }
                      />
                    ) : undefined
                  }
                />,
              );
            }
            if (ciLoading && !ci)
              out.push(
                <p
                  key={`ci-loading:${child.id}`}
                  className="px-2 py-1 text-[11px] text-content/40"
                >
                  Checking CI for {repo}…
                </p>,
              );
            return out;
          })}
        </Section>
      ) : null}

      {conversations.resolved.length ||
      conversations.missing ||
      (onNewConversation && !task.archived && newConvTargets.length) ? (
        <Section title="Conversations">
          {conversations.resolved.map((session) => {
            const state = session.archived
              ? "archived"
              : needsInputIds?.has(session.id)
                ? "waiting"
                : busySessionIds?.has(session.id)
                  ? "working"
                  : "idle";
            return (
              <button
                key={session.id}
                type="button"
                disabled={!onOpenSession}
                onClick={() => {
                  onClose();
                  onOpenSession?.(session.id);
                }}
                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
                <HarnessIcon
                  harness={session.harness}
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">
                  {sessionDisplayTitle(session.title, session.harness)}
                </span>
                {conversations.resolved.length > 1 &&
                session.id === conversations.primaryId ? (
                  <span
                    title="The task's launch conversation — the brief went here"
                    className="shrink-0 rounded-full border border-content/10 px-1.5 py-px text-[9px] text-content/45"
                  >
                    primary
                  </span>
                ) : null}
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-content/40">
                  {state === "waiting" ? (
                    <>
                      <span className="size-1.5 rounded-full bg-amber-400" />
                      Waiting on you
                    </>
                  ) : state === "working" ? (
                    <>
                      <span className="size-1.5 rounded-full bg-emerald-400" />
                      Working
                    </>
                  ) : state === "archived" ? (
                    "Archived"
                  ) : (
                    "Idle"
                  )}
                </span>
                <span className="shrink-0 truncate text-[10px] text-content/40">
                  {basename(session.worktreeCwd ?? session.cwd)}
                </span>
              </button>
            );
          })}
          {conversations.missing ? (
            <p className="px-2 py-1 text-[11px] text-content/40">
              {conversations.missing} saved{" "}
              {conversations.missing === 1 ? "conversation" : "conversations"}{" "}
              no longer in history
            </p>
          ) : null}
          {onNewConversation && !task.archived && newConvTargets.length ? (
            <div>
              <button
                type="button"
                aria-expanded={
                  newConvTargets.length > 1 ? newConvOpen : undefined
                }
                onClick={() => {
                  if (newConvTargets.length === 1) {
                    onClose();
                    onNewConversation(task.id, newConvTargets[0].child.id);
                    return;
                  }
                  setNewConvOpen((value) => !value);
                }}
                title={
                  newConvTargets.length === 1
                    ? `New conversation in ${prettyCwd(newConvTargets[0].child.workingCopy!)}`
                    : "Pick the working copy for the new conversation"
                }
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-content/60 hover:bg-content/5 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
                <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">
                  New conversation
                </span>
                {newConvTargets.length > 1 ? (
                  <ChevronRight
                    className={`size-3.5 shrink-0 text-content/35 transition-transform ${newConvOpen ? "rotate-90" : ""}`}
                    strokeWidth={1.75}
                  />
                ) : null}
              </button>
              {newConvOpen && newConvTargets.length > 1
                ? newConvTargets.map(({ child }) => (
                    <button
                      key={child.id}
                      type="button"
                      title={prettyCwd(child.workingCopy!)}
                      onClick={() => {
                        onClose();
                        onNewConversation(task.id, child.id);
                      }}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-left text-[12px] text-content hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {taskChildRepoLabel(task, child, project)}
                      </span>
                      <span className="shrink-0 truncate text-[10px] text-content/40">
                        {basename(child.workingCopy!)}
                      </span>
                    </button>
                  ))
                : null}
            </div>
          ) : null}
        </Section>
      ) : null}

      {task.brief?.trim() ? (
        <Section title="Brief">
          <p className="whitespace-pre-wrap rounded-md px-2 py-1.5 text-[12px] leading-relaxed text-content/60">
            {task.brief.trim()}
          </p>
        </Section>
      ) : null}

      <div className="flex items-center gap-1 border-t border-content/10 px-3 py-2">
        {onStart &&
        !task.archived &&
        !conversations.resolved.length &&
        task.children.some(
          (child) =>
            child.launch.state === "pending" ||
            child.launch.state === "failed" ||
            // All ready but the session is gone — Start recreates it.
            child.launch.state === "ready",
        ) ? (
          <FooterButton
            icon={<Play className="size-3.5 shrink-0" strokeWidth={1.75} />}
            label="Start task"
            title="Prepare working copies and start the agent session"
            onClick={() => {
              onClose();
              onStart(task.id);
            }}
          />
        ) : null}
        {!task.archived ? (
          <FooterButton
            icon={
              <GitPullRequest
                className="size-3.5 shrink-0"
                strokeWidth={1.75}
              />
            }
            label="Create pull requests…"
            onClick={() => {
              modalSwap();
              onClose();
              window.dispatchEvent(
                new CustomEvent(OPEN_TASK_PRS, { detail: task.id }),
              );
            }}
          />
        ) : null}
        {onSyncBranches &&
        !task.archived &&
        task.children.some((child) => child.workingCopy) ? (
          <FooterButton
            icon={
              <RefreshCw className="size-3.5 shrink-0" strokeWidth={1.75} />
            }
            label="Sync all branches"
            title="Fetch and merge the remote default into every linked working copy — conflicts go to each copy's agent"
            onClick={() => onSyncBranches(task.id)}
          />
        ) : null}
        {onEdit && !task.archived ? (
          <FooterButton
            icon={<Pencil className="size-3.5 shrink-0" strokeWidth={1.75} />}
            label="Edit task…"
            onClick={() => {
              modalSwap();
              onClose();
              onEdit(task.id);
            }}
          />
        ) : null}
      </div>
    </Modal>
  );
}

function PrRow({
  title,
  meta,
  url,
  icon,
  muted,
  action,
  onOpen,
}: {
  title: string;
  meta: string;
  url?: string;
  icon?: React.ReactNode;
  muted?: boolean;
  /** Trailing affordance (e.g. Fix) — kept out of the open-link button. */
  action?: React.ReactNode;
  /** In-app review surface — the row's primary action when provided; the
   * external link then demotes to a trailing icon button. */
  onOpen?: () => void;
}) {
  const body = (
    <>
      {icon ?? (
        <GitPullRequest
          className={`size-3.5 shrink-0 ${muted ? "text-content/35" : "text-content/50"}`}
          strokeWidth={1.75}
        />
      )}
      <span
        className={`min-w-0 flex-1 truncate ${muted ? "text-content/45" : "text-content"}`}
      >
        {title}
      </span>
      <span className="shrink-0 truncate text-[10px] text-content/40">
        {meta}
      </span>
      {!onOpen && url ? (
        <ExternalLink
          className="size-3 shrink-0 text-content/35"
          strokeWidth={1.75}
        />
      ) : null}
    </>
  );
  const rowClass =
    "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent";
  if (!url && !onOpen)
    return (
      <div className={rowClass}>
        {body}
        {action}
      </div>
    );
  return (
    <div className="flex min-w-0 items-center rounded-md hover:bg-content/5">
      <button
        type="button"
        title={onOpen ? "Open review" : url}
        onClick={onOpen ?? (() => openExternal(url ?? ""))}
        className={`${rowClass} flex-1`}
      >
        {body}
      </button>
      {onOpen && url ? (
        <button
          type="button"
          title={url}
          onClick={() => openExternal(url)}
          className="shrink-0 rounded p-1 text-content/40 hover:bg-content/10 hover:text-content/70"
        >
          <ExternalLink className="size-3" strokeWidth={1.75} />
        </button>
      ) : null}
      {action ? <span className="shrink-0 pr-1.5">{action}</span> : null}
    </div>
  );
}

/** Small trailing repair affordance for a failing CI row. */
function FixButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-accent hover:bg-content/8"
    >
      <Wrench className="size-3" strokeWidth={1.75} />
      Fix
    </button>
  );
}

function FooterButton({
  icon,
  label,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-content/60 hover:bg-content/8 hover:text-content"
    >
      {icon}
      {label}
    </button>
  );
}
