import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { basename } from "../lib/fs";
import { pathKey, prettyCwd } from "../lib/paths";
import {
  projectsSnapshot,
  repositoryDisplayName,
  subscribeProjects,
} from "../lib/projects";
import { getVerifiedFamilies } from "../lib/repositoryFamilies";
import { openWorktreeManager } from "../lib/worktreeRemoval";
import {
  loadTaskWorkspaces,
  projectForTask,
  repositoryForChild,
  subscribeTaskWorkspaces,
  taskAttemptLabel,
  taskChildRepoLabel,
  taskOwnsCheckout,
  taskWorkspacesSnapshot,
  type TaskChild,
  type TaskWorkspace,
} from "../lib/taskWorkspaces";
import {
  childDelivery,
  childDeliveryLinks,
  deliveryStores,
} from "../lib/taskDelivery";
import {
  AZURE_PR_ASSOCIATIONS_CHANGED,
  azurePrUrl,
} from "../lib/azureRepos";
import {
  AZURE_CI_SOURCES_CHANGED,
  ciState,
  ciUrl,
} from "../lib/azurePipelines";
import {
  listTaskPrDrafts,
  subscribeTaskPrs,
  taskPrRowKey,
  taskPrsSnapshot,
} from "../lib/taskPrs";
import {
  OPEN_INBOX_WORK_ITEM,
  sessionWorkItems,
} from "../lib/sessionWorkItem";
import type { LinkedWorkItem } from "../lib/session";
import { sessionDisplayTitle } from "../lib/session";
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
import { DeliveryBadges } from "./TaskScopeChip";
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader,
  Pencil,
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
  const ids = new Set([
    ...(task.sessionIds ?? []),
    ...task.children.flatMap((child) => child.sessionIds),
  ]);
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

function LaunchStateIcon({ child }: { child: TaskChild }) {
  if (child.launch.state === "failed")
    return (
      <CircleAlert className="size-3.5 shrink-0 text-red-400" strokeWidth={1.75} />
    );
  if (child.launch.state === "working")
    return (
      <Loader className="size-3.5 shrink-0 animate-spin text-content/50" />
    );
  if (child.sessionIds.length || child.launch.state === "ready")
    return <Check className="size-3.5 shrink-0 text-emerald-400" strokeWidth={2} />;
  return <CircleDot className="size-3.5 shrink-0 text-content/30" />;
}

/**
 * Task details sheet — a read-only rollup of everything a task touches:
 * linked tickets, per-repository working copies, saved PR and CI links, and
 * conversations. Renders saved/cached state only; it never fetches provider
 * data or launches children (opening a child delegates to `onOpenChild`).
 */
export function TaskDetails({
  taskId,
  sessions,
  onClose,
  onOpenSession,
  onOpenChild,
  onEdit,
}: {
  taskId: string;
  sessions: readonly SessionSummary[];
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenChild?: (taskId: string, childId: string) => void;
  onEdit?: (taskId: string) => void;
}) {
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const projectsRaw = useSyncExternalStore(subscribeProjects, projectsSnapshot);
  const prsRaw = useSyncExternalStore(subscribeTaskPrs, taskPrsSnapshot);
  const statsV = useSyncExternalStore(subscribeDiffStatsVersion, diffStatsVersion);
  const branchPrV = useSyncExternalStore(subscribeBranchPrVersion, branchPrVersion);
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
    const stores = deliveryStores();
    const drafts = listTaskPrDrafts();
    return task.children.map((child) => {
      const branch = child.workingCopy
        ? (peekProjectDiffStats(child.workingCopy)?.branch ?? child.branch)
        : child.branch;
      const githubPr =
        child.workingCopy && branch
          ? cachedBranchPr(child.workingCopy, branch)
          : null;
      return {
        child,
        repo: repositoryForChild(task, child, project),
        branch,
        links: childDeliveryLinks(
          task,
          child,
          [branch, child.branch],
          githubPr,
          stores,
        ),
        delivery: childDelivery(
          task,
          child,
          [branch, child.branch],
          githubPr,
          stores,
        ),
        draft: drafts[taskPrRowKey(task.id, child.id)],
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, projectsRaw, prsRaw, statsV, branchPrV, deliveryTick]);

  const tickets = useMemo(
    () => (task ? taskWorkItems(task, sessions) : []),
    [task, sessions],
  );

  const conversations = useMemo(() => {
    if (!task) return { resolved: [] as SessionSummary[], missing: 0 };
    const ids: string[] = [];
    for (const id of task.sessionIds ?? []) if (!ids.includes(id)) ids.push(id);
    for (const child of task.children)
      for (const id of child.sessionIds)
        if (!ids.includes(id)) ids.push(id);
    const byId = new Map(sessions.map((entry) => [entry.id, entry]));
    const resolved = ids
      .map((id) => byId.get(id))
      .filter((entry): entry is SessionSummary => Boolean(entry));
    return { resolved, missing: ids.length - resolved.length };
  }, [task, sessions]);

  if (!task) return null;
  const project = projectForTask(task);
  const multiAttempt = task.attempts.length > 1;

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
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
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
          const name = repo
            ? repositoryDisplayName(repo)
            : child.workingCopy
              ? basename(child.workingCopy)
              : "Repository";
          const ready =
            child.sessionIds.length > 0 || child.launch.state === "ready";
          // "Start" prepares and launches a never-prepared child; only an
          // in-flight launch is unactionable.
          const openable = child.launch.state !== "working";
          return (
            <div key={child.id} className="rounded-md px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <LaunchStateIcon child={child} />
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
                {openable && onOpenChild ? (
                  <button
                    type="button"
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
                      const usable = (
                        getVerifiedFamilies().get(pathKey(path))
                          ?.worktrees ?? []
                      ).filter(
                        (entry) =>
                          !entry.missing &&
                          !entry.prunable &&
                          pathKey(entry.path) !== pathKey(path),
                      );
                      const context =
                        usable.find((entry) => entry.main)?.path ??
                        usable[0]?.path ??
                        repo?.anchor ??
                        path;
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
                    <GitBranch className="size-2.5 shrink-0" strokeWidth={1.75} />
                    <span className="truncate">{branch}</span>
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate">
                  {child.workingCopy
                    ? prettyCwd(child.workingCopy)
                    : "Not prepared yet"}
                </span>
                <span className="shrink-0 text-content/35">
                  {taskOwnsCheckout(child) ? "task worktree" : "shared checkout"}
                </span>
              </div>
              {child.launch.state === "failed" && child.launch.error ? (
                <p className="mt-0.5 truncate pl-5 text-[11px] text-red-400/90">
                  {child.launch.error}
                </p>
              ) : null}
            </div>
          );
        })}
      </Section>

      {rows.some((row) => row.links.prs.length || row.links.githubPr || row.draft) ? (
        <Section title="Pull requests">
          {rows.flatMap(({ child, links, draft }) => {
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

      {rows.some((row) => row.links.ci.length) ? (
        <Section title="CI pipelines">
          {rows.flatMap(({ child, links }) =>
            links.ci.map((source) => {
              const run = source.last?.run;
              const state = run ? ciState(run.status, run.result) : null;
              let url: string | undefined;
              try {
                url = ciUrl(source.target, run?.id);
              } catch {
                url = undefined;
              }
              return (
                <PrRow
                  key={`ci:${child.id}:${source.definitionName}`}
                  icon={
                    <CircleDashed
                      className={`size-3.5 shrink-0 ${state === "Failed" ? "text-red-400" : state === "Running" || state === "Queued" ? "text-amber-400" : "text-content/50"}`}
                      strokeWidth={1.75}
                    />
                  }
                  title={source.definitionName}
                  meta={`${[state, taskChildRepoLabel(task, child, project)].filter(Boolean).join(" · ")}`}
                  url={url}
                />
              );
            }),
          )}
        </Section>
      ) : null}

      {conversations.resolved.length || conversations.missing ? (
        <Section title="Conversations">
          {conversations.resolved.map((session) => (
            <button
              key={session.id}
              type="button"
              disabled={!onOpenSession}
              onClick={() => {
                onClose();
                onOpenSession?.(session.id);
              }}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5 disabled:opacity-50"
            >
              <HarnessIcon harness={session.harness} className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {sessionDisplayTitle(session.title, session.harness)}
              </span>
              <span className="shrink-0 truncate text-[10px] text-content/40">
                {basename(session.worktreeCwd ?? session.cwd)}
              </span>
            </button>
          ))}
          {conversations.missing ? (
            <p className="px-2 py-1 text-[11px] text-content/40">
              {conversations.missing} saved{" "}
              {conversations.missing === 1 ? "conversation" : "conversations"}{" "}
              no longer in history
            </p>
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
        <FooterButton
          icon={
            <GitPullRequest className="size-3.5 shrink-0" strokeWidth={1.75} />
          }
          label="Create pull requests…"
          onClick={() => {
            onClose();
            window.dispatchEvent(
              new CustomEvent("monocode:open-task-prs", { detail: task.id }),
            );
          }}
        />
        {onEdit ? (
          <FooterButton
            icon={<Pencil className="size-3.5 shrink-0" strokeWidth={1.75} />}
            label="Edit task…"
            onClick={() => {
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
}: {
  title: string;
  meta: string;
  url?: string;
  icon?: React.ReactNode;
  muted?: boolean;
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
      {url ? (
        <ExternalLink className="size-3 shrink-0 text-content/35" strokeWidth={1.75} />
      ) : null}
    </>
  );
  if (!url)
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]">
        {body}
      </div>
    );
  return (
    <button
      type="button"
      title={url}
      onClick={() => openExternal(url)}
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-content/5"
    >
      {body}
    </button>
  );
}

function FooterButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-content/60 hover:bg-content/8 hover:text-content"
    >
      {icon}
      {label}
    </button>
  );
}
