import type { AttentionItem } from "./attention";
import {
  ciKey,
  ciMatches,
  ciState,
  ciUrl,
  type CiSource,
} from "./azurePipelines";
import {
  azurePrKey,
  azurePrUrl,
  parseAzurePrLocation,
  type AzurePrAssociation,
  type AzurePrTarget,
} from "./azureRepos";
import { basename, type GitPr } from "./fs";
import type { InboxItem } from "./githubTasks";
import { pathKey } from "./paths";
import { repositoryDisplayName, type ProjectRecord } from "./projects";
import { sessionWorkCwd, type HarnessId, type LinkedWorkItem } from "./session";
import type { SessionSummary } from "./sessionStore";
import {
  inboxItemMatchesLinkedWorkItem,
  indexByWorkItem,
  relatedFromIndex,
  sessionWorkItems,
} from "./sessionWorkItem";
import {
  childDeliveryRows,
  taskSessionIds,
  type DeliveryStores,
} from "./taskDelivery";
import { taskPrRowKey, type TaskPrDraft } from "./taskPrs";
import type { TaskChild, TaskWorkspace } from "./taskWorkspaces";

/**
 * Ticket → "my work" join (#my-work inbox slice). Everything here is a pure
 * client-side join over already-fetched snapshots: the session links the
 * inbox already computes, task workspaces and PR drafts in local storage,
 * saved Azure PR/CI associations, the branch-PR cache, and the derived
 * attention queue. Nothing in this module performs IO — the caller owns the
 * snapshots and bumps them through the existing change events.
 *
 * Provider identity stays explicit throughout: GitHub PRs dedupe by
 * host/repo/number, Azure PRs by site/account/project/repository/number —
 * the same PR number in two repositories or accounts never collapses, and
 * GitHub checks are never inferred from Azure Pipelines or vice versa.
 */

export type InboxMyWorkSession = {
  sessionId: string;
  title: string;
  harness: HarnessId;
  cwd: string;
  /** waiting > working > archived > idle — live ids come from App's sets. */
  state: "waiting" | "working" | "archived" | "idle";
  /** Owning task when the session belongs to one. */
  taskName?: string;
};

export type InboxMyWorkPr = {
  /** Stable dedupe identity — host+repo+number for GitHub, the full Azure
   * target tuple for Azure. */
  key: string;
  provider: "github" | "azure";
  /** `owner/repo` for GitHub, `project/repository` for Azure, or the task
   * child's repository label when the provider URL did not parse. */
  repo: string;
  number?: number;
  title: string;
  url: string;
  state?: string;
  draft?: boolean;
  /** Source branch, when known (Azure source ref or the child's branch). */
  head?: string;
  /** An Azure reviewer voted against — the PR waits on the author. */
  needsAttention: boolean;
  /** Canonical Azure identity — present for association-backed rows. */
  azureTarget?: AzurePrTarget;
  /** Session rooted at the producing checkout — set when the row can open
   * the in-app delivery view instead of falling back to the provider URL. */
  sessionId?: string;
  cwd?: string;
  branch?: string;
  /** CI bound to the producing checkout — Azure pipeline rows for either
   * provider, or GitHub check state derived from watcher attention. */
  ci?: { count: number; failing: boolean; running: boolean; label: string };
};

export type InboxMyWorkCi = {
  key: string;
  /** Azure Pipelines only — the sole CI provider with saved local sources. */
  provider: "azure";
  name: string;
  projectName: string;
  state: string;
  failing: boolean;
  running: boolean;
  url?: string;
  runNumber?: string;
  sessionId?: string;
  cwd: string;
  branch: string;
};

export type InboxMyWork = {
  sessions: InboxMyWorkSession[];
  prs: InboxMyWorkPr[];
  ci: InboxMyWorkCi[];
  /** Queue rows bound to this ticket's sessions, checkouts or PRs. */
  attention: AttentionItem[];
  /** False rows stay calm — no badges, no detail section. */
  hasWork: boolean;
};

/** Snapshots the caller already holds. Every field is optional — the join
 * degrades to whatever is present rather than fetching. */
export type InboxMyWorkInput = {
  sessions?: readonly SessionSummary[];
  /** Live sessions mid-turn. */
  busySessionIds?: ReadonlySet<string>;
  /** Live sessions blocked on an approval/question. */
  needsInputSessionIds?: ReadonlySet<string>;
  tasks?: readonly TaskWorkspace[];
  /** `loadProjects()` output — resolves child repository labels. */
  projects?: readonly ProjectRecord[];
  /** `listTaskPrDrafts()` output — parsed once per render pass. */
  prDrafts?: Readonly<Record<string, TaskPrDraft>>;
  /** `deliveryStores()` output — saved Azure PR + CI links, parsed once. */
  stores?: DeliveryStores;
  /** `visibleAttention(...)` output — the queue as the user sees it. */
  attention?: readonly AttentionItem[];
  /** Observed head for a checkout (diff-stats peek) — never fetches. */
  branchForCwd?: (cwd: string) => string | null | undefined;
  /** Cached GitHub PR for a checkout+branch — never fetches. */
  githubPrFor?: (cwd: string, branch: string | null | undefined) => GitPr | null;
};

const MAX_SESSION_ROWS = 12;
const MAX_DELIVERY_ROWS = 20;
const MAX_ATTENTION_ROWS = 12;

const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, "");

const capitalize = (value: string) =>
  value ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value;

function githubPrIdentity(
  url: string,
): { host: string; repo: string; number: number } | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 4 || parts[2] !== "pull") return null;
    const number = Number(parts[3]);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return {
      host: parsed.hostname.toLowerCase(),
      repo: `${parts[0]}/${parts[1]}`.toLowerCase(),
      number,
    };
  } catch {
    return null;
  }
}

/** Loose Azure identity — everything the URL proves, account aside. Two
 * records merge only when the account ids agree or one side is unknown. */
function azureLooseKey(target: {
  site: string;
  project: string;
  repository: string;
  number: number;
}): string {
  return `${target.site}|${target.project}|${target.repository}|${target.number}`;
}

/** Ticket links a task carries — primary plus additional, same shape a
 * session's `linkedWorkItem` uses. */
function taskWorkItems(task: TaskWorkspace): LinkedWorkItem[] {
  const first = task.ticket;
  return first ? [first, ...(first.additionalItems ?? [])] : [];
}

type MutablePr = InboxMyWorkPr & {
  /** Azure account id when the row knows it — merge guard for loose keys. */
  accountId?: string;
  /** Loose key for account-agnostic Azure merges. */
  looseKey?: string;
  /** Child/session scopes that already contributed to `ci` — merging the
   * same checkout twice would double-count its pipelines. */
  ciScopes: Set<string>;
};

type WorkAccumulator = {
  sessions: Map<string, InboxMyWorkSession>;
  sessionCwdKeys: Set<string>;
  sessionIds: Set<string>;
  prs: MutablePr[];
  ci: InboxMyWorkCi[];
};

function ciRowState(row: CiSource): { state: string; failing: boolean; running: boolean } {
  const run = row.last?.run;
  if (!run || !ciMatches(run))
    return { state: "Unknown", failing: false, running: false };
  const state = ciState(run.status, run.result);
  return {
    state,
    failing: state === "Failed",
    running: state === "Queued" || state === "Running" || state === "Cancelling",
  };
}

function mergePr(into: MutablePr, from: Partial<InboxMyWorkPr>) {
  if (!into.title && from.title) into.title = from.title;
  if (!into.state && from.state) into.state = from.state;
  if (into.draft === undefined && from.draft !== undefined)
    into.draft = from.draft;
  if (!into.head && from.head) into.head = from.head;
  if (!into.azureTarget && from.azureTarget) into.azureTarget = from.azureTarget;
  if (!into.sessionId && from.sessionId) into.sessionId = from.sessionId;
  if (!into.cwd && from.cwd) into.cwd = from.cwd;
  if (!into.branch && from.branch) into.branch = from.branch;
  into.needsAttention ||= from.needsAttention === true;
}

/** Registers a PR under its canonical identity; merges into an existing row
 * when the identity matches — same provider+repo+number, and for Azure the
 * same account (or an unknown account merging into the known one). */
function addPr(
  acc: WorkAccumulator,
  byKey: Map<string, MutablePr>,
  byLoose: Map<string, MutablePr>,
  pr: MutablePr,
): MutablePr {
  const existing =
    byKey.get(pr.key) ??
    (pr.looseKey ? byLoose.get(pr.looseKey) : undefined);
  if (existing) {
    // A loose hit is only valid when account identity does not conflict.
    const conflict =
      pr.key !== existing.key &&
      existing.accountId !== undefined &&
      pr.accountId !== undefined &&
      existing.accountId !== pr.accountId;
    if (!conflict) {
      mergePr(existing, pr);
      if (!existing.accountId && pr.accountId) {
        existing.accountId = pr.accountId;
        existing.azureTarget = pr.azureTarget ?? existing.azureTarget;
        byKey.set(pr.key, existing);
      }
      for (const scope of pr.ciScopes) existing.ciScopes.add(scope);
      return existing;
    }
  }
  byKey.set(pr.key, pr);
  // First registration wins the loose slot — a conflicting second account
  // keeps its own row rather than hijacking the merge target.
  if (pr.looseKey && !byLoose.has(pr.looseKey)) byLoose.set(pr.looseKey, pr);
  acc.prs.push(pr);
  return pr;
}

function mergeCiScope(
  pr: MutablePr,
  scope: string,
  ci: { count: number; failing: boolean; running: boolean; label: string },
) {
  if (pr.ciScopes.has(scope)) return;
  pr.ciScopes.add(scope);
  if (!ci.count && !ci.failing) return;
  const current = pr.ci ?? {
    count: 0,
    failing: false,
    running: false,
    label: "",
  };
  pr.ci = {
    count: current.count + ci.count,
    failing: current.failing || ci.failing,
    running: current.running || ci.running,
    label:
      current.failing || ci.failing
        ? "CI failing"
        : current.running || ci.running
          ? "CI running"
          : current.label || ci.label,
  };
}

function ciSummary(rows: readonly CiSource[]): {
  count: number;
  failing: boolean;
  running: boolean;
  label: string;
} {
  let failing = false;
  let running = false;
  let last = "";
  for (const row of rows) {
    const state = ciRowState(row);
    if (state.failing) failing = true;
    else if (state.running) running = true;
    if (state.state !== "Unknown") last = state.state;
  }
  return {
    count: rows.length,
    failing,
    running,
    label: failing ? "CI failing" : running ? "CI running" : last,
  };
}

/** Session rooted at a checkout — any known session whose delivery view can
 * show this child's PRs/pipelines, not just ticket-linked ones. */
function sessionAtCwd(
  sessionsByCwd: Map<string, SessionSummary[]>,
  cwd: string,
): SessionSummary | undefined {
  return sessionsByCwd.get(pathKey(cwd))?.[0];
}

function azurePrRow(row: AzurePrAssociation): MutablePr {
  const pr = row.pr;
  const status = pr.status.toLowerCase();
  return {
    key: `azure:${azurePrKey(row.target)}`,
    looseKey: azureLooseKey(row.target),
    accountId: row.target.accountId,
    provider: "azure",
    repo: `${row.projectName || row.target.project}/${row.repositoryName || row.target.repository}`,
    number: row.target.number,
    title: pr.title,
    url: azurePrUrl(row.target),
    state: pr.isDraft
      ? "Draft"
      : status === "active"
        ? "Active"
        : capitalize(pr.status),
    draft: pr.isDraft === true,
    head: shortRef(pr.sourceRefName),
    needsAttention: pr.reviewers.some((reviewer) => reviewer.vote < 0),
    azureTarget: row.target,
    sessionId: row.sourceSessionId,
    cwd: row.cwd,
    branch: row.branch,
    ciScopes: new Set(),
  };
}

function githubPrRow(
  pr: GitPr,
  cwd: string,
  branch: string | undefined,
  fallbackRepo: string,
): MutablePr {
  const identity = githubPrIdentity(pr.url);
  const repo = identity?.repo ?? fallbackRepo;
  return {
    key: identity
      ? `github:${identity.host}/${identity.repo}/${identity.number}`
      : `url:github:${pr.url.toLowerCase()}`,
    provider: "github",
    repo,
    number: identity?.number ?? pr.number,
    title: pr.title,
    url: pr.url,
    state: capitalize(pr.state),
    head: branch,
    needsAttention: false,
    cwd,
    branch,
    ciScopes: new Set(),
  };
}

function draftPrRow(
  draft: TaskPrDraft,
  fallbackRepo: string,
  head: string | undefined,
): MutablePr | null {
  const result = draft.result;
  if (!result) return null;
  if (result.provider === "azure") {
    const target =
      result.azureTarget ??
      (() => {
        try {
          const location = parseAzurePrLocation(result.url);
          return location.number ? { ...location, accountId: "" } : null;
        } catch {
          return null;
        }
      })();
    if (target) {
      const accountId = target.accountId || undefined;
      return {
        key: `azure:${azurePrKey(target)}`,
        looseKey: azureLooseKey(target),
        accountId,
        provider: "azure",
        repo: `${target.project}/${target.repository}`,
        number: target.number,
        title: result.title || draft.title,
        url: result.url,
        state: draft.draft ? "Draft" : undefined,
        draft: draft.draft || undefined,
        head,
        needsAttention: false,
        azureTarget: accountId ? target : undefined,
        cwd: undefined,
        ciScopes: new Set(),
      };
    }
    return {
      key: `url:azure:${result.url.toLowerCase()}`,
      provider: "azure",
      repo: fallbackRepo,
      number: result.number,
      title: result.title || draft.title,
      url: result.url,
      state: draft.draft ? "Draft" : undefined,
      draft: draft.draft || undefined,
      head,
      needsAttention: false,
      ciScopes: new Set(),
    };
  }
  const identity = githubPrIdentity(result.url);
  return {
    key: identity
      ? `github:${identity.host}/${identity.repo}/${identity.number}`
      : `url:github:${result.url.toLowerCase()}`,
    provider: "github",
    repo: identity?.repo ?? fallbackRepo,
    number: identity?.number ?? result.number,
    title: result.title || draft.title,
    url: result.url,
    state: draft.draft ? "Draft" : undefined,
    draft: draft.draft || undefined,
    head,
    needsAttention: false,
    ciScopes: new Set(),
  };
}

function ciRow(source: CiSource): InboxMyWorkCi {
  const { state, failing, running } = ciRowState(source);
  let url: string | undefined;
  try {
    url = ciUrl(source.target, source.last?.run.id);
  } catch {
    url = undefined;
  }
  return {
    key: `ci:${ciKey(source.target)}|${pathKey(source.cwd)}|${source.branch}|${source.session ?? ""}`,
    provider: "azure",
    name: source.definitionName,
    projectName: source.projectName,
    state,
    failing,
    running,
    url,
    runNumber: source.last?.run.number,
    sessionId: source.session,
    cwd: source.cwd,
    branch: source.branch,
  };
}

/** Child-level join: PR drafts/results + saved Azure links + cached GitHub
 * PR for one task child checkout. */
function joinChild(
  acc: WorkAccumulator,
  task: TaskWorkspace,
  child: TaskChild,
  input: InboxMyWorkInput,
  repoLabel: string,
  byKey: Map<string, MutablePr>,
  byLoose: Map<string, MutablePr>,
  ciSeen: Set<string>,
  prsByCwd: Map<string, AzurePrAssociation[]>,
  ciByCwd: Map<string, CiSource[]>,
  sessionsByCwd: Map<string, SessionSummary[]>,
) {
  const cwd = child.workingCopy;
  if (!cwd) return;
  const branch = input.branchForCwd?.(cwd) ?? child.branch;
  const rows = childDeliveryRows(
    task,
    child,
    [branch, child.branch],
    {
      prs: prsByCwd.get(pathKey(cwd)) ?? [],
      ci: ciByCwd.get(pathKey(cwd)) ?? [],
    },
  );
  const session = sessionAtCwd(sessionsByCwd, cwd);
  const scope = `task:${task.id}:${child.id}`;
  const summary = ciSummary(rows.ci);
  for (const row of rows.ci) {
    const record = ciRow(row);
    if (ciSeen.has(record.key)) continue;
    ciSeen.add(record.key);
    if (!record.sessionId) record.sessionId = session?.id;
    acc.ci.push(record);
  }
  for (const row of rows.prs) {
    const pr = addPr(acc, byKey, byLoose, azurePrRow(row));
    if (!pr.sessionId) pr.sessionId = row.sourceSessionId ?? session?.id;
    mergeCiScope(pr, scope, summary);
  }
  const github = input.githubPrFor?.(cwd, branch);
  if (github && github.state.toLowerCase() === "open") {
    const pr = addPr(
      acc,
      byKey,
      byLoose,
      githubPrRow(github, cwd, branch, repoLabel),
    );
    if (!pr.sessionId) pr.sessionId = session?.id;
    mergeCiScope(pr, scope, summary);
  }
  const draft = input.prDrafts?.[taskPrRowKey(task.id, child.id)];
  const drafted = draft ? draftPrRow(draft, repoLabel, branch ?? child.branch) : null;
  if (drafted) {
    if (!drafted.cwd) drafted.cwd = cwd;
    if (!drafted.branch) drafted.branch = branch ?? child.branch;
    const pr = addPr(acc, byKey, byLoose, drafted);
    if (!pr.sessionId) pr.sessionId = session?.id;
    mergeCiScope(pr, scope, summary);
  }
}

/** Session-scope join: a linked session working a ticket directly (no task)
 * still binds the saved Azure links and branch PR for its own checkout. */
function joinSessionDelivery(
  acc: WorkAccumulator,
  session: SessionSummary,
  input: InboxMyWorkInput,
  repoLabel: string,
  byKey: Map<string, MutablePr>,
  byLoose: Map<string, MutablePr>,
  ciSeen: Set<string>,
  prsByCwd: Map<string, AzurePrAssociation[]>,
  ciByCwd: Map<string, CiSource[]>,
) {
  const cwd = sessionWorkCwd(session);
  const key = pathKey(cwd);
  const branch = input.branchForCwd?.(cwd) ?? session.branch;
  if (!branch) return;
  const scoped = (saved: string | undefined) =>
    saved === undefined || saved === session.id;
  const prRows = (prsByCwd.get(key) ?? []).filter(
    (row) =>
      scoped(row.sourceSessionId) &&
      (row.branch === branch ||
        shortRef(row.pr.sourceRefName) === branch) &&
      row.pr.status.toLowerCase() === "active",
  );
  const ciRows = (ciByCwd.get(key) ?? []).filter(
    (row) =>
      scoped(row.session) &&
      (row.branch === branch ||
        shortRef(row.last?.run.branch ?? "") === branch),
  );
  const scope = `session:${session.id}`;
  const summary = ciSummary(ciRows);
  for (const row of ciRows) {
    const record = ciRow(row);
    if (ciSeen.has(record.key)) continue;
    ciSeen.add(record.key);
    if (!record.sessionId) record.sessionId = session.id;
    acc.ci.push(record);
  }
  for (const row of prRows) {
    const pr = addPr(acc, byKey, byLoose, azurePrRow(row));
    if (!pr.sessionId) pr.sessionId = session.id;
    mergeCiScope(pr, scope, summary);
  }
  const github = input.githubPrFor?.(cwd, branch);
  if (github && github.state.toLowerCase() === "open") {
    const pr = addPr(
      acc,
      byKey,
      byLoose,
      githubPrRow(github, cwd, branch, repoLabel),
    );
    if (!pr.sessionId) pr.sessionId = session.id;
    mergeCiScope(pr, scope, summary);
  }
}

function attentionMatches(
  item: InboxItem,
  row: AttentionItem,
  acc: WorkAccumulator,
  cwds: Set<string>,
  prByGithub: Map<string, MutablePr>,
  prByAzure: Map<string, MutablePr>,
  prByUrl: Map<string, MutablePr>,
): boolean {
  if (row.sessionId && acc.sessionIds.has(row.sessionId)) return true;
  if (row.url && row.url === item.url) return true;
  if (row.url && prByUrl.has(row.url.toLowerCase())) return true;
  if (row.cwd && cwds.has(pathKey(row.cwd))) return true;
  const action = row.action;
  if (!action) return false;
  switch (action.kind) {
    case "open-session":
    case "open-changes":
    case "open-delivery":
      return acc.sessionIds.has(action.sessionId);
    case "open-item":
      return inboxItemMatchesLinkedWorkItem(item, action.item);
    case "start-task":
      return (
        action.item.provider === item.provider &&
        action.item.url === item.url
      );
    case "github-pr-comments":
    case "github-ci-fix":
      return prByGithub.has(
        `${action.repo.trim().toLowerCase()}|${action.number}`,
      );
    case "azure-pr-comments":
      return prByAzure.has(azureLooseKey(action.target));
    case "azure-ci-fix":
      return cwds.has(pathKey(action.cwd));
    default:
      return false;
  }
}

const SESSION_STATE_RANK: Record<InboxMyWorkSession["state"], number> = {
  waiting: 0,
  working: 1,
  idle: 2,
  archived: 3,
};

/**
 * The whole per-item join. `items` are the visible inbox rows; the returned
 * map only holds items with actual linked work.
 */
export function inboxMyWorkForItems(
  items: readonly InboxItem[],
  input: InboxMyWorkInput,
): Map<InboxItem, InboxMyWork> {
  const sessions = input.sessions ?? [];
  const tasks = (input.tasks ?? []).filter((task) => !task.archived);
  const stores = input.stores ?? { prs: [], ci: [] };
  const attention = input.attention ?? [];

  // One indexed pass over session links — the same identities the related-
  // session counts use, so "my work" never disagrees with them.
  const sessionIndex = indexByWorkItem(sessions, sessionWorkItems);
  const taskIndex = indexByWorkItem(tasks, taskWorkItems);

  // sessionId → owning task; children resolve per session cwd below.
  const taskBySessionId = new Map<string, TaskWorkspace>();
  for (const task of tasks)
    for (const id of taskSessionIds(task))
      if (!taskBySessionId.has(id)) taskBySessionId.set(id, task);

  // Saved provider links by checkout path — each child/session then sees a
  // bounded slice instead of rescanning both stores.
  const prsByCwd = new Map<string, AzurePrAssociation[]>();
  for (const row of stores.prs) {
    const key = pathKey(row.cwd);
    const list = prsByCwd.get(key);
    if (list) list.push(row);
    else prsByCwd.set(key, [row]);
  }
  const ciByCwd = new Map<string, CiSource[]>();
  for (const row of stores.ci) {
    const key = pathKey(row.cwd);
    const list = ciByCwd.get(key);
    if (list) list.push(row);
    else ciByCwd.set(key, [row]);
  }

  const projectsById = new Map(
    (input.projects ?? []).map((project) => [project.id, project]),
  );

  // Sessions by working copy — PR/CI rows use one rooted at the producing
  // checkout so the delivery view opens in the right context.
  const sessionsByCwd = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = pathKey(sessionWorkCwd(session));
    const list = sessionsByCwd.get(key);
    if (list) list.push(session);
    else sessionsByCwd.set(key, [session]);
  }

  const out = new Map<InboxItem, InboxMyWork>();
  for (const item of items) {
    const related = relatedFromIndex(item, sessionIndex);
    const ticketTasks = relatedFromIndex(item, taskIndex);
    const ownerTasks = new Map<string, TaskWorkspace>();
    for (const task of ticketTasks) ownerTasks.set(task.id, task);
    for (const session of related) {
      const task = taskBySessionId.get(session.id);
      if (task) ownerTasks.set(task.id, task);
    }
    const itemTasks = [...ownerTasks.values()];

    const acc: WorkAccumulator = {
      sessions: new Map(),
      sessionCwdKeys: new Set(),
      sessionIds: new Set(),
      prs: [],
      ci: [],
    };
    for (const session of related.slice(0, MAX_SESSION_ROWS)) {
      const task = taskBySessionId.get(session.id);
      const state = input.needsInputSessionIds?.has(session.id)
        ? "waiting"
        : input.busySessionIds?.has(session.id)
          ? "working"
          : session.archived
            ? "archived"
            : "idle";
      acc.sessions.set(session.id, {
        sessionId: session.id,
        title: session.title,
        harness: session.harness,
        cwd: sessionWorkCwd(session),
        state,
        taskName: task?.name,
      });
    }
    for (const session of related) acc.sessionIds.add(session.id);
    for (const task of itemTasks)
      for (const id of taskSessionIds(task)) acc.sessionIds.add(id);
    for (const session of related)
      acc.sessionCwdKeys.add(pathKey(sessionWorkCwd(session)));

    const byKey = new Map<string, MutablePr>();
    const byLoose = new Map<string, MutablePr>();
    const ciSeen = new Set<string>();
    const cwds = new Set(acc.sessionCwdKeys);

    for (const task of itemTasks) {
      const project = projectsById.get(task.projectId);
      for (const child of task.children) {
        if (child.workingCopy) cwds.add(pathKey(child.workingCopy));
        const repository = project?.repositories.find(
          (entry) => entry.id === child.repositoryId,
        );
        const repoLabel = repository
          ? repositoryDisplayName(repository)
          : child.workingCopy
            ? basename(child.workingCopy)
            : child.repositoryId;
        joinChild(
          acc,
          task,
          child,
          input,
          repoLabel,
          byKey,
          byLoose,
          ciSeen,
          prsByCwd,
          ciByCwd,
          sessionsByCwd,
        );
      }
    }
    for (const session of related) {
      // Sessions whose owning task already covered their checkout skip the
      // session-scope pass — the task child join saw the same links.
      const owned = taskBySessionId.get(session.id);
      if (
        owned &&
        owned.children.some(
          (child) =>
            child.workingCopy &&
            pathKey(child.workingCopy) === pathKey(sessionWorkCwd(session)),
        )
      )
        continue;
      const repo =
        session.repo ?? (basename(sessionWorkCwd(session)) || sessionWorkCwd(session));
      joinSessionDelivery(
        acc,
        session,
        input,
        repo,
        byKey,
        byLoose,
        ciSeen,
        prsByCwd,
        ciByCwd,
      );
    }

    const prByGithub = new Map<string, MutablePr>();
    const prByAzure = new Map<string, MutablePr>();
    const prByUrl = new Map<string, MutablePr>();
    for (const pr of acc.prs) {
      if (pr.url) prByUrl.set(pr.url.toLowerCase(), pr);
      if (pr.provider === "github" && pr.number !== undefined)
        prByGithub.set(`${pr.repo.toLowerCase()}|${pr.number}`, pr);
      else if (pr.provider === "azure" && pr.azureTarget)
        prByAzure.set(azureLooseKey(pr.azureTarget), pr);
    }

    const seen = new Set<string>();
    const bound = attention
      .filter((row) =>
        attentionMatches(item, row, acc, cwds, prByGithub, prByAzure, prByUrl),
      )
      .filter((row) => (seen.has(row.key) ? false : (seen.add(row.key), true)))
      .slice(0, MAX_ATTENTION_ROWS);

    // GitHub check failures arrive as watcher attention rows bound by
    // repo+number — fold them into the matching PR's CI state.
    for (const row of bound) {
      const action = row.action;
      if (action?.kind !== "github-ci-fix" || row.kind !== "ci-failure")
        continue;
      const pr = prByGithub.get(
        `${action.repo.trim().toLowerCase()}|${action.number}`,
      );
      if (pr) {
        mergeCiScope(pr, `attn:${row.key}`, {
          count: 0,
          failing: true,
          running: false,
          label: "Checks failing",
        });
      }
    }

    const sortedSessions = [...acc.sessions.values()].sort(
      (a, b) => SESSION_STATE_RANK[a.state] - SESSION_STATE_RANK[b.state],
    );
    const prs: InboxMyWorkPr[] = acc.prs
      .slice(0, MAX_DELIVERY_ROWS)
      .map(
        ({
          ciScopes: _ciScopes,
          accountId: _accountId,
          looseKey: _looseKey,
          ...pr
        }) => pr,
      );
    const ci = acc.ci.slice(0, MAX_DELIVERY_ROWS);
    const hasWork = Boolean(
      sortedSessions.length || prs.length || ci.length || bound.length,
    );
    if (!hasWork) continue;
    out.set(item, {
      sessions: sortedSessions,
      prs,
      ci,
      attention: bound,
      hasWork,
    });
  }
  return out;
}
