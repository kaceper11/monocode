import { basename } from "./fs";
import { pathKey, prettyCwd, wslLocation } from "./paths";
import {
  loadProjects,
  repositoryDisplayName,
  type ProjectRecord,
  type ProjectRepository,
} from "./projects";
import type { LinkedWorkItem } from "./session";
import {
  allAzurePrAssociations,
  azurePrKey,
  unbindAzurePrSession,
} from "./azureRepos";
import {
  allCiSources,
  ciKey,
  unbindCiSourceSession,
} from "./azurePipelines";
import {
  deleteTaskPrDraft,
  deleteTaskPrDraftsFor,
  listTaskPrDrafts,
  taskPrRowKey,
} from "./taskPrs";
import { parseGithubWorkItemUrl } from "./sessionWorkItem";
import {
  ensureDeliveryWatcher,
  unwatchDeliveryScope,
  watchGithubPrUrl,
  type DeliverySurvival,
  type DeliveryWatcherSource,
} from "./watchers";
import {
  ATTENTION_ACTION,
  emitAttention,
  resolveAttention,
} from "./attention";

const KEY = "monocode.taskWorkspaces.v1";
const EVENT = "monocode:task-workspaces-changed";
/** Opens the task details sheet — the App-level listener owns the modal. */
export const OPEN_TASK_DETAILS = "monocode:open-task-details";
/** CustomEvent<string> carrying a task id — opens its PRs sheet. */
export const OPEN_TASK_PRS = "monocode:open-task-prs";
const MAX_TASKS = 100;
const MAX_ATTEMPTS = 20;
const MAX_CHILDREN = 50;
const MAX_BRIEF = 8_000;
const MAX_TASK_NAME = 300;
const MAX_TICKET_TEXT = 500;
const MAX_TICKET_CONTEXT = 4_000;
const MAX_ADDITIONAL_ITEMS = 20;

/**
 * Per-child launch lifecycle. `pending` children are actionable but have no
 * session yet (prepare-later or not launched); `ready` children have at least
 * one session; `failed` retains the launch error for retry. A child only
 * moves forward — retry re-runs just the unresolved launch steps.
 */
export type TaskChildLaunchState = "pending" | "working" | "ready" | "failed";

/**
 * One candidate solution set for a task. Every task has at least its primary
 * attempt (`PRIMARY_ATTEMPT_ID`); additional attempts are parallel solution
 * sets whose children each materialize their own worktree and branch — Git
 * never checks one branch out in two worktrees of the same repository.
 */
export type TaskAttempt = {
  id: string;
  label?: string;
  createdAt: number;
  /** User verdict; absent while the attempt is still in play. */
  status?: "chosen" | "discarded";
};

/** Stable id of every task's first attempt. Fresh tasks and the legacy
 * backfill share it, so a stored child never needs a generated fallback. */
export const PRIMARY_ATTEMPT_ID = "primary";

/**
 * Exact routing identity for one repository's share of one attempt. Provider,
 * account and remote mappings are not copied here — they resolve through the
 * existing per-repository stores keyed by this identity.
 */
export type TaskChild = {
  id: string;
  /** `ProjectRepository.id` — never a name or path. */
  repositoryId: string;
  /** Owning attempt — always set after sanitize; `PRIMARY_ATTEMPT_ID` for
   * tasks that never grew a second attempt. */
  attemptId: string;
  /** Chosen working copy (host-qualified); absent while prepared later. */
  workingCopy?: string;
  /** New-worktree creation inputs recorded at review time. `branch` also
   * holds the short name of an `existingBranch` child. */
  branch?: string;
  baseRef?: string;
  baseCommit?: string;
  /** Full `refs/heads/…` ref of an existing local branch whose worktree the
   * task adds at launch — the branch itself is never created or removed. */
  existingBranch?: string;
  responsibility?: string;
  /** Ordinary session ids; sessions themselves stay single-cwd. */
  sessionIds: string[];
  launch: { state: TaskChildLaunchState; error?: string };
};

/** Lightweight parent record grouping repository children under one task. */
export type TaskWorkspace = {
  id: string;
  /** `ProjectRecord.id` — the task never outlives its project boundary. */
  projectId: string;
  name: string;
  /** Optional linked provider ticket; local tasks have none. */
  ticket?: LinkedWorkItem;
  brief?: string;
  /** Candidate solution sets; always ≥1 after sanitize — `attempts[0]` is the
   * primary attempt every child defaults to. */
  attempts: TaskAttempt[];
  children: TaskChild[];
  /** The task's session — one conversation roots at the primary child's
   * working copy and can work every child. Legacy tasks may instead carry
   * per-child `sessionIds`. */
  sessionIds?: string[];
  /** Session the shared brief was delivered to — guards resend after a
   * failed submit or a replacement session. */
  briefSentFor?: string;
  lastActiveChildId?: string;
  createdAt: number;
  archived?: boolean;
};

/** Creation-time per-repository draft collected by the task sheet. */
export type TaskChildDraft = {
  repositoryId: string;
  /** Target attempt; absent → the task's primary attempt. */
  attemptId?: string;
  mode: "worktree" | "branch" | "existing" | "later";
  /** For `worktree`: reviewed base + new branch + target path. */
  baseRef?: string;
  baseCommit?: string;
  branch?: string;
  path?: string;
  /** For `branch`: the full `refs/heads/…` ref of an existing local branch
   * with no worktree; `baseCommit` is its reviewed tip and `path` the new
   * worktree location. */
  existingBranch?: string;
  /** For `existing`: the chosen copy. */
  workingCopy?: string;
  responsibility?: string;
};

/**
 * Children currently being launched in this window. A stored `working`
 * launch state is only honored while one of these markers is live — anything
 * left over from a closed window (crash, reload) normalizes back to
 * actionable `pending` on the next read.
 */
const launchingChildren = new Set<string>();

/** Marks a child launch as in flight. Returns false when already running. */
export function markTaskChildLaunching(
  taskId: string,
  childId: string,
): boolean {
  const key = `${taskId}:${childId}`;
  if (launchingChildren.has(key)) return false;
  launchingChildren.add(key);
  // A marker changes how `working` sanitizes — drop the cached read.
  invalidateTaskCache();
  return true;
}

export function unmarkTaskChildLaunching(taskId: string, childId: string) {
  launchingChildren.delete(`${taskId}:${childId}`);
  invalidateTaskCache();
}

export function isTaskChildLaunching(taskId: string, childId: string) {
  return launchingChildren.has(`${taskId}:${childId}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const cleanString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function cleanStrings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry) continue;
    if (!out.includes(entry)) out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}

const PROVIDERS = new Set(["github", "linear", "gitlab", "jira", "azure"]);

/** Bounded copy of a provider ticket — untrusted storage/provider text never
 * lands unbounded, and `additionalItems` is itself validated, deduped
 * (url+account) and capped rather than trusted wholesale. */
function cleanTicket(value: unknown): LinkedWorkItem | undefined {
  if (!isRecord(value)) return undefined;
  const url = cleanString(value.url);
  const kind = value.kind === "issue" || value.kind === "pr" ? value.kind : null;
  if (!url || url.length > 2048 || !/^https:\/\//i.test(url) || !kind)
    return undefined;
  const text = (field: unknown, cap: number) => {
    const cleaned = cleanString(field);
    return cleaned ? cleaned.slice(0, cap) : undefined;
  };
  const item: LinkedWorkItem = {
    kind,
    repo: cleanString(value.repo)?.slice(0, 250) ?? "",
    number: Number.isFinite(value.number) ? (value.number as number) : 0,
    url,
  };
  const provider = cleanString(value.provider);
  if (provider && PROVIDERS.has(provider))
    item.provider = provider as LinkedWorkItem["provider"];
  const account = text(value.account, 200);
  if (account) item.account = account;
  const identifier = text(value.identifier, 120);
  if (identifier) item.identifier = identifier;
  const id = text(value.id, 120);
  if (id) item.id = id;
  const site = text(value.site, 500);
  if (site && /^https?:\/\//i.test(site)) item.site = site;
  const title = text(value.title, MAX_TICKET_TEXT);
  if (title) item.title = title;
  const context = text(value.context, MAX_TICKET_CONTEXT);
  if (context) item.context = context;
  if (Array.isArray(value.additionalItems)) {
    const seen = new Set([`${url}\0${item.account ?? ""}`]);
    const items: LinkedWorkItem[] = [];
    for (const raw of value.additionalItems) {
      // Nested items never carry items of their own — recursion stays flat,
      // matching the session sanitizer's shape.
      const extra = isRecord(raw)
        ? cleanTicket({ ...raw, additionalItems: undefined })
        : undefined;
      if (!extra) continue;
      const key = `${extra.url}\0${extra.account ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(extra);
      if (items.length >= MAX_ADDITIONAL_ITEMS) break;
    }
    if (items.length) item.additionalItems = items;
  }
  return item;
}

function sanitizeAttempt(value: unknown): TaskAttempt | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id);
  if (!id) return null;
  const label = cleanString(value.label);
  const status = cleanString(value.status);
  return {
    id,
    ...(label ? { label: label.slice(0, 200) } : {}),
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : Date.now(),
    ...(status === "chosen" || status === "discarded" ? { status } : {}),
  };
}

function sanitizeChild(
  value: unknown,
  taskId: string,
  attemptIds: ReadonlySet<string>,
  primaryAttemptId: string,
): TaskChild | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id);
  const repositoryId = cleanString(value.repositoryId);
  if (!id || !repositoryId) return null;
  const attemptId = cleanString(value.attemptId);
  const launch = isRecord(value.launch) ? value.launch : {};
  const state = cleanString(launch.state);
  return {
    id,
    repositoryId,
    // A child pointing at a gone attempt falls back to the primary one —
    // dangling attempt ids never strand a checkout row.
    attemptId:
      attemptId && attemptIds.has(attemptId) ? attemptId : primaryAttemptId,
    ...(cleanString(value.workingCopy)
      ? { workingCopy: cleanString(value.workingCopy) }
      : {}),
    ...(cleanString(value.branch) ? { branch: cleanString(value.branch) } : {}),
    ...(cleanString(value.baseRef) ? { baseRef: cleanString(value.baseRef) } : {}),
    ...(cleanString(value.baseCommit)
      ? { baseCommit: cleanString(value.baseCommit) }
      : {}),
    ...(cleanString(value.existingBranch)
      ? { existingBranch: cleanString(value.existingBranch) }
      : {}),
    ...(cleanString(value.responsibility)
      ? { responsibility: cleanString(value.responsibility) }
      : {}),
    sessionIds: cleanStrings(value.sessionIds, 20),
    launch: {
      // `working` survives only while a launch marker is live in this
      // window; an interrupted launch becomes actionable `pending` again.
      state:
        state === "ready" || state === "failed"
          ? state
          : state === "working" && isTaskChildLaunching(taskId, id)
            ? "working"
            : "pending",
      ...(cleanString(launch.error)
        ? { error: cleanString(launch.error) }
        : {}),
    },
  };
}

function sanitizeTask(value: unknown): TaskWorkspace | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id);
  const projectId = cleanString(value.projectId);
  const name = cleanString(value.name)?.slice(0, MAX_TASK_NAME);
  if (!id || !projectId || !name) return null;
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : Date.now();
  const attempts: TaskAttempt[] = [];
  for (const raw of Array.isArray(value.attempts) ? value.attempts : []) {
    const attempt = sanitizeAttempt(raw);
    if (!attempt || attempts.some((entry) => entry.id === attempt.id)) continue;
    attempts.push(attempt);
    if (attempts.length >= MAX_ATTEMPTS) break;
  }
  // Tasks written before attempts existed get the shared primary id — no
  // generated value, so an unsaved reload stays identical. The first
  // attempt is always the primary one: pin its id so the protection below
  // holds even for hand-edited records, dropping a stray later "primary".
  if (!attempts.length)
    attempts.push({ id: PRIMARY_ATTEMPT_ID, createdAt });
  else if (attempts[0].id !== PRIMARY_ATTEMPT_ID) {
    const stray = attempts.findIndex(
      (attempt, index) => index > 0 && attempt.id === PRIMARY_ATTEMPT_ID,
    );
    if (stray >= 0) attempts.splice(stray, 1);
    attempts[0] = { ...attempts[0], id: PRIMARY_ATTEMPT_ID };
  }
  const attemptIds = new Set(attempts.map((attempt) => attempt.id));
  const seenPairs = new Set<string>();
  const seenPaths = new Set<string>();
  const seenBranches = new Set<string>();
  const children = Array.isArray(value.children)
    ? value.children
        .map((child) => sanitizeChild(child, id, attemptIds, attempts[0].id))
        .filter((child): child is TaskChild => child !== null)
        .filter((child) => {
          // One child per (attempt, repository). The write paths enforce
          // this; storage re-enforces it because the dangling-attempt remap
          // above can manufacture a pair. Dedupe before the MAX_CHILDREN
          // trim so a dropped duplicate can't evict a real checkout.
          const pair = `${child.attemptId}\0${child.repositoryId}`;
          if (seenPairs.has(pair)) return false;
          seenPairs.add(pair);
          // Hand-edited or legacy-corrupt storage can double-claim a
          // checkout or branch — drop the later binding, matching the
          // write-path invariants in assertUniqueChildBindings.
          if (child.workingCopy) {
            const key = pathKey(child.workingCopy);
            if (seenPaths.has(key)) return false;
            seenPaths.add(key);
          }
          if (child.branch) {
            const normalized = child.branch.replace(/^refs\/heads\//, "");
            const key = `${child.repositoryId}\0${normalized}`;
            if (seenBranches.has(key)) return false;
            seenBranches.add(key);
          }
          return true;
        })
        .slice(0, MAX_CHILDREN)
    : [];
  if (!children.length) return null;
  const lastActiveChildId = cleanString(value.lastActiveChildId);
  return {
    id,
    projectId,
    name,
    ...(cleanTicket(value.ticket) ? { ticket: cleanTicket(value.ticket) } : {}),
    ...(cleanString(value.brief)
      ? { brief: cleanString(value.brief)!.slice(0, MAX_BRIEF) }
      : {}),
    attempts,
    children,
    sessionIds: cleanStrings(value.sessionIds, 20),
    ...(cleanString(value.briefSentFor)
      ? { briefSentFor: cleanString(value.briefSentFor) }
      : {}),
    ...(children.some((child) => child.id === lastActiveChildId)
      ? { lastActiveChildId }
      : {}),
    createdAt,
    ...(value.archived === true ? { archived: true } : {}),
  };
}

/** The parsed store is cached on the raw snapshot — `taskForSession` and
 * friends run per row per render, and none should re-parse the same JSON.
 * Marker changes (launch start/finish) invalidate explicitly since they
 * alter sanitize output without touching storage. */
let tasksCacheRaw: string | null | undefined;
let tasksCache: TaskWorkspace[] = [];
/** Serialized copy kept after a failed write — snapshot/read truth must not
 * diverge from the in-memory record while storage stays full/denied. */
let memoryRaw: string | null = null;

function invalidateTaskCache() {
  tasksCacheRaw = undefined;
}

function readTaskRaw(): string | null {
  if (memoryRaw !== null) return memoryRaw;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function loadTaskWorkspaces(): TaskWorkspace[] {
  try {
    const raw = readTaskRaw();
    if (raw === tasksCacheRaw) return tasksCache;
    const parsed = raw ? JSON.parse(raw) : null;
    tasksCache = Array.isArray(parsed)
      ? parsed
          .map(sanitizeTask)
          .filter((task): task is TaskWorkspace => task !== null)
          .slice(0, MAX_TASKS)
      : [];
    tasksCacheRaw = raw;
    return tasksCache;
  } catch {
    return [];
  }
}

const STORE_QUOTA_ATTENTION_KEY = "task-store:quota";

function saveTaskWorkspaces(tasks: TaskWorkspace[]) {
  const serialized = JSON.stringify(tasks.slice(0, MAX_TASKS));
  try {
    localStorage.setItem(KEY, serialized);
    memoryRaw = null;
    // The write echo: readers see this serialized copy, no re-parse needed.
    tasksCache = tasks.slice(0, MAX_TASKS);
    tasksCacheRaw = serialized;
    resolveAttention(STORE_QUOTA_ATTENTION_KEY);
  } catch {
    /* storage full or unavailable — keep the in-memory record, but say so. */
    memoryRaw = serialized;
    tasksCache = tasks.slice(0, MAX_TASKS);
    tasksCacheRaw = serialized;
    emitAttention({
      key: STORE_QUOTA_ATTENTION_KEY,
      kind: "watcher",
      title: "Couldn't save tasks — local storage is full",
      detail:
        "Task changes are kept in memory only and disappear on restart.",
      urgency: ATTENTION_ACTION,
      at: Date.now(),
      signature: "quota",
    });
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeTaskWorkspaces(listener: () => void) {
  const handler = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", handler);
  };
}

/** Raw snapshot for useSyncExternalStore — stable until a write lands. */
export function taskWorkspacesSnapshot(): string | null {
  return readTaskRaw();
}

export function tasksForProject(
  projectId: string,
  tasks: readonly TaskWorkspace[] = loadTaskWorkspaces(),
): TaskWorkspace[] {
  return tasks
    .filter((task) => task.projectId === projectId && !task.archived)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Rail/search filter: does this task match `query`? Checks the name, ticket
 * fields, brief, repository names, working copies and branch/attempt labels
 * — already-loaded records only, never Git or provider IO.
 */
export function taskMatchesQuery(
  task: TaskWorkspace,
  query: string,
  project: ProjectRecord | undefined = projectForTask(task),
): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const fields: (string | undefined)[] = [
    task.name,
    task.brief,
    task.ticket?.identifier,
    task.ticket?.title,
    task.ticket?.url,
    ...(task.ticket?.additionalItems ?? []).flatMap((item) => [
      item.identifier,
      item.title,
      item.url,
    ]),
  ];
  for (const attempt of task.attempts) fields.push(attempt.label);
  for (const child of task.children) {
    const repo = repositoryForChild(task, child, project);
    fields.push(
      repo ? repositoryDisplayName(repo) : undefined,
      child.workingCopy,
      child.branch,
      child.responsibility,
    );
  }
  // Every token must appear somewhere — "book-217 checkout" spans the ticket
  // identifier and the branch name.
  return tokens.every((token) =>
    fields.some(
      (field) => field !== undefined && field.toLowerCase().includes(token),
    ),
  );
}

/** Distinct execution hosts are never mixed: native vs WSL distribution. */
function taskHostKey(path: string): string {
  const location = wslLocation(path);
  return location ? `wsl:${location.distribution.toLowerCase()}` : "native";
}

/** Returns the host-mix error message, or null when children share one host. */
export function taskHostConflict(
  paths: readonly (string | undefined)[],
): string | null {
  const hosts = new Map<string, string>();
  for (const path of paths) {
    if (!path) continue;
    const key = taskHostKey(path);
    if (!hosts.has(key)) hosts.set(key, path);
  }
  if (hosts.size <= 1) return null;
  const labels = [...hosts.entries()].map(([key, path]) =>
    key === "native" ? `native (${prettyCwd(path)})` : `${key} (${path})`,
  );
  return `Selected repositories resolve to different execution hosts: ${labels.join(" vs ")}. Choose repositories on one host — paths and credentials are never translated across hosts.`;
}

function repositoryOf(
  project: ProjectRecord | undefined,
  repositoryId: string,
): ProjectRepository | undefined {
  return project?.repositories.find((repo) => repo.id === repositoryId);
}

/** Host-check inputs for a child set: each working copy plus its
 * repository's anchor, so a copy typed on the wrong host conflicts at
 * write time instead of failing `git_path` at launch. */
function childHostPaths(
  project: ProjectRecord | undefined,
  children: readonly TaskChild[],
): (string | undefined)[] {
  return children.flatMap((child) => [
    child.workingCopy,
    repositoryOf(project, child.repositoryId)?.anchor,
  ]);
}

/**
 * Creates a task from reviewed drafts. Throws on an empty selection, unknown
 * repository ids or a mixed-host working-copy set. Draft inputs are copied
 * verbatim — nothing is inferred from names or tickets.
 */
/** One child per (attempt, repository), and one recorded branch per
 * repository — a repository can repeat across attempts but never twice
 * inside one attempt, and Git checks a branch out in at most one worktree. */
function assertUniqueChildBindings(children: readonly TaskChild[]) {
  const seen = new Set<string>();
  const seenBranches = new Set<string>();
  const seenPaths = new Set<string>();
  for (const child of children) {
    const key = `${child.attemptId}\0${child.repositoryId}`;
    if (seen.has(key))
      throw new Error("A selected repository is already in this task");
    seen.add(key);
    if (child.workingCopy) {
      // Two children pointing at one checkout share Git state silently —
      // delivery, cleanup and sessions would double-claim the same path.
      const key = pathKey(child.workingCopy);
      if (seenPaths.has(key))
        throw new Error(
          `Working copy ${prettyCwd(child.workingCopy)} is already used in this task`,
        );
      seenPaths.add(key);
    }
    if (child.branch) {
      // `refs/heads/x` and `x` are the same branch to Git.
      const normalized = child.branch.replace(/^refs\/heads\//, "");
      const branchKey = `${child.repositoryId}\0${normalized}`;
      if (seenBranches.has(branchKey))
        throw new Error(
          `Branch ${child.branch} is already used for this repository in another attempt`,
        );
      seenBranches.add(branchKey);
    }
  }
}

/** Validates child drafts against a project and builds child records. */
function buildTaskChildren(
  project: ProjectRecord,
  drafts: readonly TaskChildDraft[],
  attempts: readonly TaskAttempt[],
): TaskChild[] {
  return drafts.map((draft) => {
    const repository = repositoryOf(project, draft.repositoryId);
    if (!repository)
      throw new Error("A selected repository is no longer in this project");
    const requested = cleanString(draft.attemptId);
    if (requested && !attempts.some((attempt) => attempt.id === requested))
      throw new Error("A selected attempt is no longer in this task");
    const attemptId = requested ?? attempts[0]?.id ?? PRIMARY_ATTEMPT_ID;
    const workingCopy =
      draft.mode === "later"
        ? undefined
        : cleanString(
            draft.mode === "worktree" || draft.mode === "branch"
              ? draft.path
              : draft.workingCopy,
          );
    const createsWorktree = draft.mode === "worktree";
    const attachesBranch = draft.mode === "branch";
    const branch = cleanString(draft.branch);
    const baseRef = cleanString(draft.baseRef);
    const baseCommit = cleanString(draft.baseCommit);
    const existingBranch = cleanString(draft.existingBranch);
    if (createsWorktree && (!baseRef || !baseCommit || !branch || !workingCopy))
      throw new Error(
        `Choose a base, branch and location for ${repositoryDisplayName(repository)}`,
      );
    if (
      attachesBranch &&
      (!existingBranch?.startsWith("refs/heads/") || !baseCommit || !workingCopy)
    )
      throw new Error(
        `Choose a local branch and location for ${repositoryDisplayName(repository)}`,
      );
    if (
      !createsWorktree &&
      !attachesBranch &&
      draft.mode !== "later" &&
      !workingCopy
    )
      throw new Error(
        `Choose a working copy for ${repositoryDisplayName(repository)}`,
      );
    return {
      id: crypto.randomUUID(),
      repositoryId: draft.repositoryId,
      attemptId,
      ...(workingCopy ? { workingCopy } : {}),
      ...(createsWorktree
        ? {
            branch: branch!,
            baseRef: baseRef!,
            baseCommit: baseCommit!,
          }
        : {}),
      ...(attachesBranch
        ? {
            // `branch` keeps the short name so prompts, labels and branch
            // uniqueness behave the same as for a created worktree.
            branch: existingBranch!.replace(/^refs\/heads\//, ""),
            existingBranch: existingBranch!,
            baseCommit: baseCommit!,
          }
        : {}),
      ...(cleanString(draft.responsibility)
        ? { responsibility: cleanString(draft.responsibility) }
        : {}),
      sessionIds: [],
      launch: { state: "pending" as const },
    };
  });
}

export function createTask(input: {
  projectId: string;
  name: string;
  ticket?: LinkedWorkItem;
  brief?: string;
  children: TaskChildDraft[];
}): TaskWorkspace {
  const name = input.name.trim().slice(0, MAX_TASK_NAME);
  if (!name) throw new Error("Enter a task name");
  const project = loadProjects().find(
    (entry) => entry.id === input.projectId,
  );
  if (!project) throw new Error("Project no longer exists");
  const drafts = input.children.filter(
    (child) => child && child.repositoryId,
  );
  if (!drafts.length) throw new Error("Select at least one repository");
  if (drafts.length > MAX_CHILDREN)
    throw new Error(`A task supports up to ${MAX_CHILDREN} repositories`);
  const primary: TaskAttempt = { id: PRIMARY_ATTEMPT_ID, createdAt: Date.now() };
  const children = buildTaskChildren(project, drafts, [primary]);
  assertUniqueChildBindings(children);
  const conflict = taskHostConflict(childHostPaths(project, children));
  if (conflict) throw new Error(conflict);
  // The store trims to MAX_TASKS from the tail — without this the new task
  // would be silently dropped instead of saved.
  if (loadTaskWorkspaces().length >= MAX_TASKS)
    throw new Error(`You can have up to ${MAX_TASKS} tasks`);
  const task: TaskWorkspace = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    name,
    ...(cleanTicket(input.ticket) ? { ticket: cleanTicket(input.ticket) } : {}),
    ...(cleanString(input.brief)
      ? { brief: cleanString(input.brief)!.slice(0, MAX_BRIEF) }
      : {}),
    attempts: [primary],
    children,
    sessionIds: [],
    createdAt: Date.now(),
  };
  saveTaskWorkspaces([...loadTaskWorkspaces(), task]);
  return task;
}

/** Links an inbox item onto a task — as the primary ticket when none is set,
 * otherwise deduped into `additionalItems`. */
export function linkTicketToTask(
  taskId: string,
  ticket: LinkedWorkItem,
): void {
  const clean = cleanTicket(ticket);
  if (!clean) return;
  updateTask(taskId, (current) => {
    if (current.archived) return current;
    if (!current.ticket) return { ...current, ticket: clean };
    const same = (entry: LinkedWorkItem) =>
      entry.url === clean.url &&
      (entry.account ?? "") === (clean.account ?? "");
    if (
      same(current.ticket) ||
      (current.ticket.additionalItems ?? []).some(same)
    )
      return current;
    const additional = [
      ...(current.ticket.additionalItems ?? []),
      clean,
    ].slice(0, MAX_ADDITIONAL_ITEMS);
    return {
      ...current,
      ticket: { ...current.ticket, additionalItems: additional },
    };
  });
}

export function updateTask(
  taskId: string,
  update: (task: TaskWorkspace) => TaskWorkspace,
): TaskWorkspace | undefined {
  const tasks = loadTaskWorkspaces();
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return undefined;
  const next = update(tasks[index]);
  // Any children change re-validates the binding invariants — updateTask is
  // otherwise an unguarded seam around assertUniqueChildBindings.
  if (next.children !== tasks[index].children)
    assertUniqueChildBindings(next.children);
  // Copy before writing — mutating the cached array in place would leave the
  // snapshot-keyed indexes serving pre-write maps after a failed save.
  const updated = [...tasks];
  updated[index] = next;
  saveTaskWorkspaces(updated);
  return next;
}

/** Atomic edit: metadata, kept-child responsibilities and additions are
 * validated together and persist in one write — a failed add never leaves
 * removals or a rename half-saved. */
export function reviseTask(
  taskId: string,
  revision: {
    name: string;
    ticket?: LinkedWorkItem;
    brief?: string;
    /** Repository ids whose existing children stay in the task. */
    keepRepositoryIds: readonly string[];
    /** Edited responsibilities for kept children, keyed by child id. */
    responsibilities: ReadonlyMap<string, string>;
    /** Drafts for repositories being added. */
    additions: readonly TaskChildDraft[];
    /** Re-drafted copy fields for kept children, keyed by child id — the
     * "set up" path for children saved without a working copy. The child id,
     * responsibility and links stay; the launch resets to pending. */
    setups?: ReadonlyMap<string, TaskChildDraft>;
  },
): TaskWorkspace {
  const existing = loadTaskWorkspaces().find((entry) => entry.id === taskId);
  if (!existing) throw new Error("Task no longer exists");
  // Archived tasks are read-only — unarchive before editing.
  if (existing.archived) throw new Error("Task is archived");
  const project = projectForTask(existing);
  if (!project) throw new Error("Project no longer exists");
  const name = revision.name.trim().slice(0, MAX_TASK_NAME);
  if (!name) throw new Error("Enter a task name");
  const dropped: TaskChild[] = [];
  const next = updateTask(taskId, (current) => {
    // A child with a launch in flight can't be dropped — the run's final
    // write would land on a child that no longer exists, orphaning a worktree
    // it may have just created. It survives the revision; the sheet can only
    // offer removal once the launch settles.
    const launchable = (child: TaskChild) =>
      revision.keepRepositoryIds.includes(child.repositoryId) ||
      isTaskChildLaunching(taskId, child.id);
    const kept = current.children.filter(launchable);
    dropped.push(...current.children.filter((child) => !launchable(child)));
    const drafts = revision.additions.filter(
      (child) => child && child.repositoryId,
    );
    if (!kept.length && !drafts.length)
      throw new Error("Select at least one repository");
    if (kept.length + drafts.length > MAX_CHILDREN)
      throw new Error(`A task supports up to ${MAX_CHILDREN} repositories`);
    const added = buildTaskChildren(project, drafts, current.attempts);
    const revised = kept.map((child) => {
      const resp = cleanString(revision.responsibilities.get(child.id));
      const setup = revision.setups?.get(child.id);
      // A setup draft for a different repository would rebind the child —
      // the store doesn't trust the map keying.
      if (!setup || setup.repositoryId !== child.repositoryId)
        return { ...child, responsibility: resp };
      // Re-run the draft's copy fields through the same validation a fresh
      // child gets — the id and responsibility are preserved; the session
      // binding is not (it pointed at the old copy).
      const [built] = buildTaskChildren(project, [setup], current.attempts);
      return {
        ...child,
        workingCopy: built.workingCopy,
        branch: built.branch,
        baseRef: built.baseRef,
        baseCommit: built.baseCommit,
        existingBranch: built.existingBranch,
        // The copy is rebound — sessions rooted at the old path must not be
        // treated as covering the new one.
        sessionIds: [],
        launch: { state: "pending" as const },
        // The setup form's Responsibility input writes the draft — honor it;
        // a blank field keeps the existing value rather than wiping it.
        responsibility: built.responsibility ?? resp,
      };
    });
    assertUniqueChildBindings([...revised, ...added]);
    const conflict = taskHostConflict(
      childHostPaths(project, [...revised, ...added]),
    );
    if (conflict) throw new Error(conflict);
    return {
      ...current,
      name,
      ticket: cleanTicket(revision.ticket),
      brief: cleanString(revision.brief)?.slice(0, MAX_BRIEF),
      children: [...revised, ...added],
      ...(revised.some((child) => child.id === current.lastActiveChildId)
        ? {}
        : { lastActiveChildId: undefined }),
    };
  });
  if (!next) throw new Error("Task no longer exists");
  // Draft rows die before teardown — a saved PR result still counts as
  // coverage. The child's sessions survive removal — tear down by checkout
  // only so watchers a live session owns stay covered.
  teardownDroppedChildren(taskId, dropped);
  return next;
}

export function updateTaskChild(
  taskId: string,
  childId: string,
  patch: Partial<TaskChild>,
): TaskWorkspace | undefined {
  // Identity fields can create same-path/branch collisions the launch path
  // assumes are impossible — patches carrying them re-validate the set.
  const bindsCopy =
    "workingCopy" in patch ||
    "branch" in patch ||
    "repositoryId" in patch ||
    "attemptId" in patch;
  return updateTask(taskId, (task) => {
    const next = {
      ...task,
      children: task.children.map((child) =>
        child.id === childId ? { ...child, ...patch } : child,
      ),
    };
    if (bindsCopy) assertUniqueChildBindings(next.children);
    return next;
  });
}

/** Adds new repository children to an existing task. Same validation as
 * createTask; returns the added children so the caller can launch them. */
export function addTaskChildren(
  taskId: string,
  drafts: readonly TaskChildDraft[],
): TaskChild[] {
  const task = loadTaskWorkspaces().find((entry) => entry.id === taskId);
  if (!task) throw new Error("Task no longer exists");
  const project = projectForTask(task);
  if (!project) throw new Error("Project no longer exists");
  const valid = drafts.filter((child) => child && child.repositoryId);
  if (!valid.length) return [];
  if (task.children.length + valid.length > MAX_CHILDREN)
    throw new Error(`A task supports up to ${MAX_CHILDREN} repositories`);
  const added = buildTaskChildren(project, valid, task.attempts);
  assertUniqueChildBindings([...task.children, ...added]);
  const conflict = taskHostConflict(
    childHostPaths(project, [...task.children, ...added]),
  );
  if (conflict) throw new Error(conflict);
  updateTask(taskId, (current) => ({
    ...current,
    children: [...current.children, ...added],
  }));
  return added;
}

/**
 * Adds a parallel solution attempt. Children join it through
 * `addTaskChildren`/`reviseTask` drafts carrying `attemptId`; each child
 * then materializes its own worktree and branch.
 */
export function addTaskAttempt(taskId: string, label?: string): TaskAttempt {
  const task = loadTaskWorkspaces().find((entry) => entry.id === taskId);
  if (!task) throw new Error("Task no longer exists");
  if (task.attempts.length >= MAX_ATTEMPTS)
    throw new Error(`A task supports up to ${MAX_ATTEMPTS} attempts`);
  const cleanLabel = cleanString(label);
  const attempt: TaskAttempt = {
    id: crypto.randomUUID(),
    ...(cleanLabel ? { label: cleanLabel.slice(0, 200) } : {}),
    createdAt: Date.now(),
  };
  updateTask(taskId, (current) => ({
    ...current,
    attempts: [...current.attempts, attempt],
  }));
  return attempt;
}

/** Drops an attempt and its children — sessions, working copies and branches
 * stay. The primary attempt cannot be removed; mark it discarded instead. */
export function removeTaskAttempt(taskId: string, attemptId: string) {
  const task = loadTaskWorkspaces().find((entry) => entry.id === taskId);
  if (!task) throw new Error("Task no longer exists");
  if (attemptId === task.attempts[0]?.id)
    throw new Error(
      "The primary attempt cannot be removed — mark it discarded instead.",
    );
  if (!task.attempts.some((attempt) => attempt.id === attemptId))
    throw new Error("Attempt no longer exists");
  // A task without checkouts is dropped by sanitize — refuse to strand its
  // record and session references instead of removing it silently.
  if (!task.children.some((child) => child.attemptId !== attemptId))
    throw new Error(
      "This attempt holds the task's last checkouts — remove the task instead.",
    );
  const dropped = task.children.filter(
    (child) => child.attemptId === attemptId,
  );
  // Draft rows die first so teardown coverage checks can't re-anchor to them.
  teardownDroppedChildren(taskId, dropped);
  updateTask(taskId, (current) => {
    const removed = new Set(
      current.children
        .filter((child) => child.attemptId === attemptId)
        .map((child) => child.id),
    );
    return {
      ...current,
      attempts: current.attempts.filter(
        (attempt) => attempt.id !== attemptId,
      ),
      children: current.children.filter(
        (child) => child.attemptId !== attemptId,
      ),
      ...(current.lastActiveChildId && removed.has(current.lastActiveChildId)
        ? { lastActiveChildId: undefined }
        : {}),
    };
  });
}

/** Marks an attempt chosen or discarded — omit `status` to keep it in
 * play. Its children, sessions and checkouts are untouched either way. */
export function setTaskAttemptStatus(
  taskId: string,
  attemptId: string,
  status?: "chosen" | "discarded",
) {
  updateTask(taskId, (current) => ({
    ...current,
    attempts: current.attempts.map((attempt) =>
      attempt.id === attemptId ? { ...attempt, status } : attempt,
    ),
  }));
}

/** The attempt a child belongs to — falls back to the primary attempt. */
export function attemptForChild(
  task: TaskWorkspace,
  child: TaskChild,
): TaskAttempt | undefined {
  return (
    task.attempts.find((attempt) => attempt.id === child.attemptId) ??
    task.attempts[0]
  );
}

/** Display label for an attempt — its name, or "Attempt N" by position. */
export function taskAttemptLabel(
  task: TaskWorkspace,
  attemptId: string,
): string {
  const index = task.attempts.findIndex((attempt) => attempt.id === attemptId);
  const label = index >= 0 ? task.attempts[index].label?.trim() : undefined;
  return label || `Attempt ${index >= 0 ? index + 1 : 1}`;
}

/** One repository's child for an attempt. An explicit `attemptId` asks for
 * that attempt's row (falling back to any match); without one the lookup
 * prefers a usable copy — the primary attempt's prepared checkout, then
 * any prepared checkout, then the primary row itself. */
export function childForRepository(
  task: TaskWorkspace,
  repositoryId: string,
  attemptId?: string,
  /** Strict mode: an attempt with no copy of this repository is an honest
   * miss, never another attempt's checkout. */
  strict?: boolean,
): TaskChild | undefined {
  const matches = task.children.filter(
    (child) => child.repositoryId === repositoryId,
  );
  if (!matches.length) return undefined;
  if (attemptId) {
    const own = matches.find((child) => child.attemptId === attemptId);
    return strict ? own : (own ?? matches[0]);
  }
  const primary = task.attempts[0]?.id;
  return (
    matches.find(
      (child) => child.attemptId === primary && child.workingCopy,
    ) ??
    matches.find((child) => child.workingCopy) ??
    matches.find((child) => child.attemptId === primary) ??
    matches[0]
  );
}

/** Deterministic representative pick: prefer the primary attempt's matching
 * child, then any match. For "the task's copy of repo X" style lookups. */
export function preferredTaskChild(
  task: TaskWorkspace,
  match: (child: TaskChild) => boolean,
): TaskChild | undefined {
  const primary = task.attempts[0]?.id;
  return (
    task.children.find(
      (child) => child.attemptId === primary && match(child),
    ) ?? task.children.find(match)
  );
}

/** True when the task created this checkout rather than borrowing an
 * existing/main copy — recorded for worktree-mode children (`branch`+`base`)
 * and existing-branch children (`existingBranch`), whose worktree the task
 * adds even though the branch itself stays user-owned. Cleanup offers must
 * use this, never path heuristics. */
export function taskOwnsCheckout(child: TaskChild): boolean {
  return Boolean((child.branch && child.baseRef) || child.existingBranch);
}

export function recordTaskActiveChild(taskId: string, childId: string) {
  updateTask(taskId, (task) =>
    task.children.some((child) => child.id === childId)
      ? { ...task, lastActiveChildId: childId }
      : task,
  );
}

/** Attaches an existing session to a task's conversation list — appended
 * after recorded ids so the launch conversation (`sessionIds[0]`) stays
 * primary. */
export function linkTaskSession(taskId: string, sessionId: string) {
  updateTask(taskId, (task) => {
    const ids = task.sessionIds ?? [];
    // Match the load-time bound — in-memory state must agree with what a
    // reload keeps.
    if (ids.includes(sessionId) || ids.length >= 20) return task;
    return { ...task, sessionIds: [...ids, sessionId] };
  });
}

/** The task-owned child claiming a path — a session created inside a
 * task-made worktree is work on that task and attaches to it. Borrowed
 * copies (`existing`/`main` children) never claim: the path is the user's
 * and sessions there are not necessarily task work. */
export function taskOwnedChildForWorkingCopy(
  path: string,
): { task: TaskWorkspace; child: TaskChild } | undefined {
  return taskChildrenForWorkingCopy(path).find((entry) =>
    taskOwnsCheckout(entry.child),
  );
}

/** Sessions and working copies a task's produced PR/CI links are bound to —
 * the scope its auto watchers live in. */
function taskDeliveryScope(task: TaskWorkspace) {
  return {
    sessionIds: [
      ...(task.sessionIds ?? []),
      ...task.children.flatMap((child) => child.sessionIds),
    ],
    cwds: task.children.flatMap((child) =>
      child.workingCopy ? [child.workingCopy] : [],
    ),
  };
}

type DeliveryScope = {
  sessionIds?: readonly string[];
  cwds?: readonly string[];
};

/** Teardown for children leaving a task. Draft rows die first so coverage
 * checks can't re-anchor to them; teardown is checkout-scoped because the
 * child's sessions outlive the binding — watchers a live session owns stay
 * covered. */
function teardownDroppedChildren(
  taskId: string,
  children: readonly TaskChild[],
) {
  for (const child of children) deleteTaskPrDraft(taskId, child.id);
  teardownDeliveryScope({
    cwds: children.flatMap((child) =>
      child.workingCopy ? [child.workingCopy] : [],
    ),
  });
}

/** A stored link still covering the delivery from OUTSIDE the torn-down
 * scope keeps its watcher. Rows bound to the scope itself don't count —
 * they stay on disk but their owner is gone. A live session owner keeps
 * its link meaningful even at a torn-down checkout (the working copy stays
 * on disk); session-less or dead-owner rows count only at surviving
 * checkouts, and archived-task owners never count. */
function deliveryLinkedOutsideScope(scope: DeliveryScope) {
  const tornSessions = new Set(scope.sessionIds ?? []);
  const tornCwds = new Set((scope.cwds ?? []).map(pathKey));
  const tasks = loadTaskWorkspaces();
  const associations = allAzurePrAssociations();
  const ciSources = allCiSources();
  const drafts = listTaskPrDrafts();
  const archivedSessions = new Set(
    tasks
      .filter((task) => task.archived)
      .flatMap((task) => [
        ...(task.sessionIds ?? []),
        ...task.children.flatMap((child) => child.sessionIds),
      ]),
  );
  const live = (session?: string) =>
    session !== undefined &&
    !tornSessions.has(session) &&
    !archivedSessions.has(session);
  const inScope = (cwd: string, session?: string) =>
    (session !== undefined && tornSessions.has(session)) ||
    (tornCwds.has(pathKey(cwd)) && !live(session));
  const covers = (cwd: string, session?: string) =>
    !inScope(cwd, session) && (session === undefined || live(session));
  return (source: DeliveryWatcherSource): DeliverySurvival => {
    if (source.kind === "azure-pr") {
      const key = azurePrKey(source.target);
      const row = associations.find(
        (row) =>
          azurePrKey(row.target) === key &&
          pathKey(row.cwd) === pathKey(source.cwd) &&
          row.branch === source.branch &&
          covers(row.cwd, row.sourceSessionId),
      );
      return row ? { sessionId: row.sourceSessionId } : false;
    }
    if (source.kind === "azure-ci") {
      const key = ciKey(source.target);
      const row = ciSources.find(
        (row) =>
          ciKey(row.target) === key &&
          pathKey(row.cwd) === pathKey(source.cwd) &&
          row.branch === source.branch &&
          covers(row.cwd, row.session),
      );
      return row ? { sessionId: row.session } : false;
    }
    // github-pr — the watcher's own live session covers it first (a session
    // that linked the PR and is still around keeps its watcher), then a live
    // task child's saved PR result.
    if (
      source.kind === "github-pr" &&
      source.sessionId &&
      covers(source.cwd, source.sessionId)
    )
      return { sessionId: source.sessionId };
    for (const task of tasks) {
      if (task.archived) continue;
      for (const child of task.children) {
        if (
          !child.workingCopy ||
          pathKey(child.workingCopy) !== pathKey(source.cwd)
        )
          continue;
        const owner =
          child.sessionIds.find(live) ?? task.sessionIds?.find(live);
        if (tornCwds.has(pathKey(child.workingCopy)) && !owner) continue;
        const result = drafts[taskPrRowKey(task.id, child.id)]?.result;
        if (result?.provider !== "github") continue;
        const parsed = parseGithubWorkItemUrl(result.url);
        if (
          parsed?.kind !== "pr" ||
          parsed.repo.toLowerCase() !== source.repo.toLowerCase() ||
          parsed.number !== source.number
        )
          continue;
        return { sessionId: owner };
      }
    }
    return false;
  };
}

/** Scope teardown that keeps watchers whose delivery another live scope
 * still links — e.g. pruning one session when a sibling session's stored
 * row covers the same PR at this checkout. */
function teardownDeliveryScope(scope: DeliveryScope) {
  unwatchDeliveryScope(scope, deliveryLinkedOutsideScope(scope));
}

/** Un-archiving restores the task's produced-delivery watchers from the
 * links that stayed saved — symmetric with the teardown above. Links whose
 * watcher the user removed by hand stay uncovered: `ensureDeliveryWatcher`
 * sees no watcher and re-adds one, which is the intent here. */
function rewatchDeliveryScope(task: TaskWorkspace) {
  const sessionIds = new Set(taskDeliveryScope(task).sessionIds);
  const cwds = new Set(
    task.children.flatMap((child) =>
      child.workingCopy ? [pathKey(child.workingCopy)] : [],
    ),
  );
  const bound = (cwd: string, session?: string) =>
    (session !== undefined && sessionIds.has(session)) ||
    cwds.has(pathKey(cwd));
  for (const row of allAzurePrAssociations()) {
    if (row.pr.status !== "active" || !bound(row.cwd, row.sourceSessionId))
      continue;
    ensureDeliveryWatcher({
      kind: "azure-pr",
      target: row.target,
      projectName: row.projectName,
      repositoryName: row.repositoryName,
      cwd: row.cwd,
      branch: row.branch,
      // Rows matched on cwd alone can carry a dead or foreign session —
      // only bind owners this task still holds.
      ...(row.sourceSessionId && sessionIds.has(row.sourceSessionId)
        ? { sessionId: row.sourceSessionId }
        : {}),
    });
  }
  for (const row of allCiSources()) {
    if (!bound(row.cwd, row.session)) continue;
    ensureDeliveryWatcher({
      kind: "azure-ci",
      target: row.target,
      definitionName: row.definitionName,
      remote: row.remote,
      cwd: row.cwd,
      branch: row.branch,
      ...(row.session && sessionIds.has(row.session)
        ? { sessionId: row.session }
        : {}),
    });
  }
  const drafts = listTaskPrDrafts();
  for (const child of task.children) {
    const result = drafts[taskPrRowKey(task.id, child.id)]?.result;
    if (result?.provider === "github" && child.workingCopy)
      watchGithubPrUrl(
        child.workingCopy,
        result.url,
        child.sessionIds[0] ?? task.sessionIds?.[0],
      );
  }
}

/** Removes the task record only — sessions, worktrees and branches stay. */
export function removeTask(taskId: string) {
  const task = loadTaskWorkspaces().find((entry) => entry.id === taskId);
  if (task) {
    // Draft rows die first — a saved PR result still counts as coverage, so
    // teardown must run after they're gone or watchers re-anchor to a row
    // that's about to disappear.
    deleteTaskPrDraftsFor(taskId);
    // The task's sessions outlive it — tearing down by session id would kill
    // watchers a live session still owns. Scope the teardown to checkouts:
    // rows bound to a surviving session keep their coverage.
    teardownDeliveryScope({
      cwds: task.children.flatMap((child) =>
        child.workingCopy ? [child.workingCopy] : [],
      ),
    });
  }
  saveTaskWorkspaces(
    loadTaskWorkspaces().filter((entry) => entry.id !== taskId),
  );
}

export function archiveTask(taskId: string, archived = true) {
  const task = loadTaskWorkspaces().find((entry) => entry.id === taskId);
  if (task) {
    if (archived) teardownDeliveryScope(taskDeliveryScope(task));
    else rewatchDeliveryScope(task);
  }
  updateTask(taskId, (task) => ({ ...task, archived }));
}

/** Drops the child association; its sessions, copies and branches stay.
 * A task keeps at least one checkout — remove the task itself instead. */
export function removeTaskChild(taskId: string, childId: string) {
  const task = loadTaskWorkspaces().find((entry) => entry.id === taskId);
  if (!task) throw new Error("Task no longer exists");
  if (!task.children.some((child) => child.id !== childId))
    throw new Error(
      "This is the task's last repository checkout — remove the task instead.",
    );
  const removed = task.children.find((child) => child.id === childId);
  if (removed) teardownDroppedChildren(taskId, [removed]);
  updateTask(taskId, (task) => ({
    ...task,
    children: task.children.filter((child) => child.id !== childId),
    ...(task.lastActiveChildId === childId
      ? { lastActiveChildId: undefined }
      : {}),
  }));
}

/** Detaches a deleted session from every task — task-level and per-child
 * references both. Without this a dead id blocks reopening forever. */
export function pruneTaskSession(sessionId: string) {
  const tasks = loadTaskWorkspaces();
  let changed = false;
  const next = tasks.map((task) => {
    const sessionIds = (task.sessionIds ?? []).filter(
      (id) => id !== sessionId,
    );
    let childChanged = false;
    const children = task.children.map((child) => {
      if (!child.sessionIds.includes(sessionId)) return child;
      childChanged = true;
      return {
        ...child,
        sessionIds: child.sessionIds.filter((id) => id !== sessionId),
      };
    });
    if (sessionIds.length === (task.sessionIds ?? []).length && !childChanged)
      return task;
    changed = true;
    return { ...task, sessionIds, children };
  });
  if (changed) saveTaskWorkspaces(next);
  // Stored links keep their delivery but drop the dead owner — otherwise a
  // stale row could cover a watcher and rebind it to a session that no
  // longer exists.
  unbindAzurePrSession(sessionId);
  unbindCiSourceSession(sessionId);
  teardownDeliveryScope({ sessionIds: [sessionId] });
}

/** sessionId → owning task, rebuilt only when the store snapshot changes.
 * Session cards each ask for their scope — without the index every card
 * rescans every task and child on every render. First writer wins, matching
 * the scan order `taskForSession` used to apply. */
let sessionIndexCache:
  | { tasks: readonly TaskWorkspace[]; map: Map<string, TaskWorkspace> }
  | undefined;

function sessionTaskIndex(
  tasks: readonly TaskWorkspace[],
): Map<string, TaskWorkspace> {
  if (sessionIndexCache?.tasks === tasks) return sessionIndexCache.map;
  const map = new Map<string, TaskWorkspace>();
  for (const task of tasks) {
    if (task.archived) continue;
    for (const id of task.sessionIds ?? []) {
      if (!map.has(id)) map.set(id, task);
    }
    for (const child of task.children)
      for (const id of child.sessionIds)
        if (!map.has(id)) map.set(id, task);
  }
  sessionIndexCache = { tasks, map };
  return map;
}

/** working-copy pathKey → claiming children, same snapshot-keyed caching. */
let copyIndexCache:
  | {
      tasks: readonly TaskWorkspace[];
      map: Map<string, { task: TaskWorkspace; child: TaskChild }[]>;
    }
  | undefined;

function workingCopyIndex(
  tasks: readonly TaskWorkspace[],
): Map<string, { task: TaskWorkspace; child: TaskChild }[]> {
  if (copyIndexCache?.tasks === tasks) return copyIndexCache.map;
  const map = new Map<string, { task: TaskWorkspace; child: TaskChild }[]>();
  for (const task of tasks) {
    if (task.archived) continue;
    for (const child of task.children) {
      if (!child.workingCopy) continue;
      const key = pathKey(child.workingCopy);
      const list = map.get(key);
      const claim = { task, child };
      if (list) list.push(claim);
      else map.set(key, [claim]);
    }
  }
  copyIndexCache = { tasks, map };
  return map;
}

/** Every session a task owns — the task-level conversation plus legacy
 * per-child ids. */
export function taskSessionIds(task: TaskWorkspace): Set<string> {
  const ids = new Set(task.sessionIds);
  for (const child of task.children)
    for (const id of child.sessionIds) ids.add(id);
  return ids;
}

/** Recorded ids that resolve to live sessions — "N conversations" labels
 * and multi-conversation routing count these, not stale records that only
 * prune on open. */
export function liveTaskSessionIds(
  task: TaskWorkspace,
  live: ReadonlySet<string>,
): string[] {
  return [...taskSessionIds(task)].filter((id) => live.has(id));
}

/** The session a task is reachable through — its own task-level session
 * first, else the first child-owned one (legacy per-repo sessions). */
export function firstTaskSessionId(task: TaskWorkspace): string | undefined {
  return (
    task.sessionIds?.[0] ??
    task.children.find((child) => child.sessionIds.length)?.sessionIds[0]
  );
}

export function taskForSession(
  sessionId: string,
  cwd?: string,
  tasks: readonly TaskWorkspace[] = loadTaskWorkspaces(),
): { task: TaskWorkspace; child: TaskChild } | null {
  const task = sessionTaskIndex(tasks).get(sessionId);
  if (!task) return null;
  const child = task.children.find((entry) =>
    entry.sessionIds.includes(sessionId),
  );
  if (child) return { task, child };
  // A task-level session displays its host child — the repository the
  // conversation is rooted at.
  const keyed = cwd ? pathKey(cwd) : undefined;
  const host =
    (keyed
      ? task.children.find(
          (entry) =>
            entry.workingCopy && pathKey(entry.workingCopy) === keyed,
        )
      : undefined) ??
    task.children.find((entry) => entry.id === task.lastActiveChildId) ??
    preferredTaskChild(task, (entry) => Boolean(entry.workingCopy)) ??
    task.children[0];
  return host ? { task, child: host } : null;
}

/** A send originating from a task-owned session preselects that task as the
 * destination; anything else leaves the choice to the picker. */
export function taskDestinationForSession(
  sessionId: string | undefined,
): { kind: "task"; taskId: string } | undefined {
  if (!sessionId) return undefined;
  const found = taskForSession(sessionId);
  return found && !found.task.archived
    ? { kind: "task", taskId: found.task.id }
    : undefined;
}

/**
 * Task children already claiming a working copy — concurrent-writer evidence.
 * Returns every non-archived task child bound to the exact path.
 */
export function taskChildrenForWorkingCopy(
  path: string,
  tasks: readonly TaskWorkspace[] = loadTaskWorkspaces(),
  excludeTaskId?: string,
): { task: TaskWorkspace; child: TaskChild }[] {
  const claims = workingCopyIndex(tasks).get(pathKey(path)) ?? [];
  return excludeTaskId
    ? claims.filter((claim) => claim.task.id !== excludeTaskId)
    : claims;
}

export function projectForTask(task: TaskWorkspace): ProjectRecord | undefined {
  return loadProjects().find((entry) => entry.id === task.projectId);
}

export function repositoryForChild(
  task: TaskWorkspace,
  child: TaskChild,
  project: ProjectRecord | undefined = projectForTask(task),
): ProjectRepository | undefined {
  return repositoryOf(project, child.repositoryId);
}

/** True only when this repository is checked out under more than one
 * attempt — the sole case where an attempt label disambiguates anything. */
function repoAcrossAttempts(
  task: TaskWorkspace,
  repositoryId: string,
): boolean {
  return (
    new Set(
      task.children
        .filter((child) => child.repositoryId === repositoryId)
        .map((child) => child.attemptId),
    ).size > 1
  );
}

/** Display name for a child's repository — the record's name, else the
 * working-copy basename, else a placeholder for a copy-less child. */
export function taskChildRepoName(
  task: TaskWorkspace,
  child: TaskChild,
  project?: ProjectRecord,
): string {
  const repo = repositoryForChild(task, child, project);
  return repo
    ? repositoryDisplayName(repo)
    : child.workingCopy
      ? basename(child.workingCopy)
      : "Repository";
}

/** `repo/branch` display label for a child — repo name falls back to the
 * working-copy basename when the repository record is gone. */
export function taskChildRepoLabel(
  task: TaskWorkspace,
  child: TaskChild,
  project?: ProjectRecord,
): string {
  const repoName = taskChildRepoName(task, child, project);
  const base = child.branch ? `${repoName}/${child.branch}` : repoName;
  // The same repository under two attempts needs the attempt label;
  // otherwise it adds noise without disambiguating.
  return repoAcrossAttempts(task, child.repositoryId)
    ? `${base} · ${taskAttemptLabel(task, child.attemptId)}`
    : base;
}

/** A child the agent can actually work in — its copy is verified ready, or a
 * session already owns it. A pending/failed child may still carry a recorded
 * path that doesn't exist yet. */
export function taskChildPrepared(child: TaskChild): boolean {
  return child.launch.state === "ready" || child.sessionIds.length > 0;
}

/** Per-child prompt fields shared by the session prompt, the update notice
 * and the legacy per-child brief — copy state, branch/base, attempt. */
function childPromptParts(
  task: TaskWorkspace,
  child: TaskChild,
  project: ProjectRecord | undefined,
): string {
  const repository = project
    ? repositoryOf(project, child.repositoryId)
    : undefined;
  const name = repository ? repositoryDisplayName(repository) : child.repositoryId;
  const parts = [`- ${name}`];
  if (child.workingCopy) {
    parts.push(`working copy: ${child.workingCopy}`);
    // A recorded path is only real once launch prepared it — pending and
    // failed children must not read as existing checkouts.
    if (child.launch.state === "failed")
      parts.push(
        `preparation failed${child.launch.error ? `: ${child.launch.error}` : ""}`,
      );
    else if (!taskChildPrepared(child)) parts.push("not prepared yet");
  } else {
    parts.push("no working copy prepared yet");
  }
  if (child.branch) {
    const base = child.baseRef
      ? ` (from ${child.baseRef.replace(/^refs\/(heads|remotes)\//, "")}${child.baseCommit ? ` @ ${child.baseCommit.slice(0, 10)}` : ""})`
      : "";
    parts.push(`branch: ${child.branch}${base}`);
  }
  // Any multi-attempt task labels each child's attempt — a repo unique to a
  // later attempt is still parallel work the label should mark.
  if (task.attempts.length > 1)
    parts.push(`attempt: ${taskAttemptLabel(task, child.attemptId)}`);
  return parts.join(" — ");
}

function childResponsibilityLine(child: TaskChild): string | undefined {
  return child.responsibility?.trim()
    ? `  Responsibility: ${child.responsibility.trim()}`
    : undefined;
}

/** The one task session's prompt — names every repository's working copy,
 * branch and responsibility so the agent can work across them. */
export function composeTaskSessionPrompt(
  task: TaskWorkspace,
  project: ProjectRecord | undefined,
): string {
  const lines = [`# ${task.name}`, ""];
  const tickets = [
    task.ticket,
    ...(task.ticket?.additionalItems ?? []),
  ].filter((ticket): ticket is LinkedWorkItem => Boolean(ticket));
  if (tickets.length) {
    const labels = tickets.map((ticket) =>
      [ticket.identifier, ticket.title, ticket.url]
        .filter(Boolean)
        .join(" — "),
    );
    if (labels.length === 1) lines.push(`Ticket: ${labels[0]}`, "");
    else lines.push("Tickets:", ...labels.map((label) => `- ${label}`), "");
  }
  if (task.brief?.trim()) lines.push(task.brief.trim(), "");
  lines.push("Repositories:");
  for (const child of task.children) {
    lines.push(childPromptParts(task, child, project));
    const resp = childResponsibilityLine(child);
    if (resp) lines.push(resp);
  }
  lines.push(
    "",
    "Work in each repository's own working copy — they are separate checkouts, not copies of each other.",
  );
  return lines.join("\n").trim();
}

/** Post-launch delta for the task session — the brief describes the set as
 * it was at launch, so repository changes since then are restated compactly. */
export function composeTaskUpdateNotice(
  task: TaskWorkspace,
  project: ProjectRecord | undefined,
): string {
  const lines = [`The task "${task.name}" was updated.`];
  const tickets = [
    task.ticket,
    ...(task.ticket?.additionalItems ?? []),
  ].filter((ticket): ticket is LinkedWorkItem => Boolean(ticket));
  if (tickets.length) {
    const labels = tickets.map((ticket) =>
      [ticket.identifier, ticket.title, ticket.url]
        .filter(Boolean)
        .join(" — "),
    );
    if (labels.length === 1) lines.push(`Linked ticket: ${labels[0]}`);
    else lines.push("Linked tickets:", ...labels.map((label) => `- ${label}`));
  }
  if (task.brief?.trim()) lines.push(`Brief: ${task.brief.trim()}`);
  lines.push("The current repository set:");
  for (const child of task.children) {
    lines.push(childPromptParts(task, child, project));
    const resp = childResponsibilityLine(child);
    if (resp) lines.push(resp);
  }
  lines.push("Work in each repository's own working copy.");
  return lines.join("\n");
}

/**
 * Legacy per-child prompt: shared brief + this child's responsibility + exact
 * identity. Kept for children of pre-existing per-repo-session tasks.
 */
export function composeTaskPrompt(
  task: TaskWorkspace,
  child: TaskChild,
  repository: ProjectRepository | undefined,
): string {
  const lines = [`# ${task.name}`, ""];
  const tickets = [
    task.ticket,
    ...(task.ticket?.additionalItems ?? []),
  ].filter((ticket): ticket is LinkedWorkItem => Boolean(ticket));
  if (tickets.length) {
    const labels = tickets.map((ticket) =>
      [ticket.identifier, ticket.title, ticket.url]
        .filter(Boolean)
        .join(" — "),
    );
    if (labels.length === 1) lines.push(`Ticket: ${labels[0]}`, "");
    else lines.push("Tickets:", ...labels.map((label) => `- ${label}`), "");
  }
  if (task.brief?.trim()) lines.push(task.brief.trim(), "");
  const name = repository ? repositoryDisplayName(repository) : child.repositoryId;
  lines.push(`Repository: ${name}`);
  if (child.workingCopy) {
    lines.push(`Working copy: ${child.workingCopy}`);
    if (child.launch.state === "failed")
      lines.push(
        `Preparation failed${child.launch.error ? `: ${child.launch.error}` : ""}`,
      );
    else if (!taskChildPrepared(child)) lines.push("Not prepared yet.");
  }
  if (child.branch) {
    const base = child.baseRef
      ? ` (from ${child.baseRef.replace(/^refs\/(heads|remotes)\//, "")}${child.baseCommit ? ` @ ${child.baseCommit.slice(0, 10)}` : ""})`
      : "";
    lines.push(`Branch: ${child.branch}${base}`);
  }
  if (task.attempts.length > 1)
    lines.push(`Attempt: ${taskAttemptLabel(task, child.attemptId)}`);
  if (child.responsibility?.trim())
    lines.push("", `Your responsibility: ${child.responsibility.trim()}`);
  lines.push(
    "",
    "Work only in this working copy. Other task repositories are out of scope for this session.",
  );
  return lines.join("\n");
}

/** Branch suggestion for a task worktree, unique against existing refs. */
export function suggestTaskBranch(
  taskName: string,
  refs: readonly { name: string }[],
): string {
  const base =
    taskName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  let suggestion = base;
  for (
    let n = 2;
    refs.some((ref) => ref.name === `refs/heads/${suggestion}`);
    n++
  )
    suggestion = `${base}-${n}`;
  return suggestion;
}
