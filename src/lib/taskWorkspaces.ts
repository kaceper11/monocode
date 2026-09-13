import { pathKey, prettyCwd, wslLocation } from "./paths";
import {
  loadProjects,
  type ProjectRecord,
  type ProjectRepository,
} from "./projects";
import type { LinkedWorkItem } from "./session";
import { allAzurePrAssociations, azurePrKey } from "./azureRepos";
import { allCiSources, ciKey } from "./azurePipelines";
import { listTaskPrDrafts, taskPrRowKey } from "./taskPrs";
import { parseGithubWorkItemUrl } from "./sessionWorkItem";
import {
  ensureDeliveryWatcher,
  unwatchDeliveryScope,
  watchGithubPrUrl,
  type DeliverySurvival,
  type DeliveryWatcherSource,
} from "./watchers";

const KEY = "monocode.taskWorkspaces.v1";
const EVENT = "monocode:task-workspaces-changed";
const MAX_TASKS = 100;
const MAX_ATTEMPTS = 20;
const MAX_CHILDREN = 50;

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
  /** New-worktree creation inputs recorded at review time. */
  branch?: string;
  baseRef?: string;
  baseCommit?: string;
  /** Intended merge target (e.g. the parent feature branch) — display only. */
  mergeTarget?: string;
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
  mode: "worktree" | "existing" | "main" | "later";
  /** For `worktree`: reviewed base + new branch + target path. */
  baseRef?: string;
  baseCommit?: string;
  branch?: string;
  path?: string;
  /** For `existing`/`main`: the chosen copy. */
  workingCopy?: string;
  mergeTarget?: string;
  responsibility?: string;
  /** Required when the chosen copy already has writers or an active task. */
  sharedCopyAccepted?: boolean;
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
    ...(cleanString(value.mergeTarget)
      ? { mergeTarget: cleanString(value.mergeTarget) }
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
  const name = cleanString(value.name);
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
  const children = Array.isArray(value.children)
    ? value.children
        .map((child) => sanitizeChild(child, id, attemptIds, attempts[0].id))
        .filter((child): child is TaskChild => child !== null)
        .filter((child) => {
          // One child per (attempt, repository). The write paths enforce
          // this; storage re-enforces it because the dangling-attempt remap
          // above can manufacture a pair. Dedupe before the MAX_CHILDREN
          // trim so a dropped duplicate can't evict a real checkout.
          const pair = `${child.attemptId}${child.repositoryId}`;
          if (seenPairs.has(pair)) return false;
          seenPairs.add(pair);
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
    ...(isRecord(value.ticket)
      ? { ticket: value.ticket as LinkedWorkItem }
      : {}),
    ...(cleanString(value.brief) ? { brief: cleanString(value.brief) } : {}),
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

function invalidateTaskCache() {
  tasksCacheRaw = undefined;
}

export function loadTaskWorkspaces(): TaskWorkspace[] {
  try {
    const raw = localStorage.getItem(KEY);
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

function saveTaskWorkspaces(tasks: TaskWorkspace[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(tasks.slice(0, MAX_TASKS)));
  } catch {
    /* storage full or unavailable — keep the in-memory record */
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
  return localStorage.getItem(KEY);
}

export function tasksForProject(
  projectId: string,
  tasks: readonly TaskWorkspace[] = loadTaskWorkspaces(),
): TaskWorkspace[] {
  return tasks
    .filter((task) => task.projectId === projectId && !task.archived)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Distinct execution hosts are never mixed: native vs WSL distribution. */
export function taskHostKey(path: string): string {
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
  for (const child of children) {
    const key = `${child.attemptId}${child.repositoryId}`;
    if (seen.has(key))
      throw new Error("A selected repository is already in this task");
    seen.add(key);
    if (child.branch) {
      // `refs/heads/x` and `x` are the same branch to Git.
      const normalized = child.branch.replace(/^refs\/heads\//, "");
      const branchKey = `${child.repositoryId} ${normalized}`;
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
            draft.mode === "worktree" ? draft.path : draft.workingCopy,
          );
    const createsWorktree = draft.mode === "worktree";
    const branch = cleanString(draft.branch);
    const baseRef = cleanString(draft.baseRef);
    const baseCommit = cleanString(draft.baseCommit);
    if (createsWorktree && (!baseRef || !baseCommit || !branch || !workingCopy))
      throw new Error(
        `Choose a base, branch and location for ${repositoryDisplay(repository)}`,
      );
    if (!createsWorktree && draft.mode !== "later" && !workingCopy)
      throw new Error(
        `Choose a working copy for ${repositoryDisplay(repository)}`,
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
      ...(cleanString(draft.mergeTarget)
        ? { mergeTarget: cleanString(draft.mergeTarget) }
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
  const name = input.name.trim();
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
  const conflict = taskHostConflict(
    children.map((child) => child.workingCopy),
  );
  if (conflict) throw new Error(conflict);
  // The store trims to MAX_TASKS from the tail — without this the new task
  // would be silently dropped instead of saved.
  if (loadTaskWorkspaces().length >= MAX_TASKS)
    throw new Error(`You can have up to ${MAX_TASKS} tasks`);
  const task: TaskWorkspace = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    name,
    ...(input.ticket ? { ticket: input.ticket } : {}),
    ...(cleanString(input.brief) ? { brief: cleanString(input.brief) } : {}),
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
  updateTask(taskId, (current) => {
    if (!current.ticket) return { ...current, ticket };
    if (
      current.ticket.url === ticket.url ||
      (current.ticket.additionalItems ?? []).some(
        (entry) => entry.url === ticket.url,
      )
    )
      return current;
    return {
      ...current,
      ticket: {
        ...current.ticket,
        additionalItems: [...(current.ticket.additionalItems ?? []), ticket],
      },
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
  tasks[index] = next;
  saveTaskWorkspaces(tasks);
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
  },
): TaskWorkspace {
  const existing = loadTaskWorkspaces().find((entry) => entry.id === taskId);
  if (!existing) throw new Error("Task no longer exists");
  const project = projectForTask(existing);
  if (!project) throw new Error("Project no longer exists");
  const name = revision.name.trim();
  if (!name) throw new Error("Enter a task name");
  const dropped: TaskChild[] = [];
  const next = updateTask(taskId, (current) => {
    const kept = current.children.filter((child) =>
      revision.keepRepositoryIds.includes(child.repositoryId),
    );
    dropped.push(
      ...current.children.filter(
        (child) => !revision.keepRepositoryIds.includes(child.repositoryId),
      ),
    );
    const drafts = revision.additions.filter(
      (child) => child && child.repositoryId,
    );
    if (!kept.length && !drafts.length)
      throw new Error("Select at least one repository");
    if (kept.length + drafts.length > MAX_CHILDREN)
      throw new Error(`A task supports up to ${MAX_CHILDREN} repositories`);
    const added = buildTaskChildren(project, drafts, current.attempts);
    assertUniqueChildBindings([...kept, ...added]);
    const conflict = taskHostConflict(
      [...kept, ...added].map((child) => child.workingCopy),
    );
    if (conflict) throw new Error(conflict);
    return {
      ...current,
      name,
      ticket: revision.ticket,
      brief: cleanString(revision.brief),
      children: [
        ...kept.map((child) => {
          const resp = cleanString(revision.responsibilities.get(child.id));
          return { ...child, responsibility: resp };
        }),
        ...added,
      ],
      ...(kept.some((child) => child.id === current.lastActiveChildId)
        ? {}
        : { lastActiveChildId: undefined }),
    };
  });
  if (!next) throw new Error("Task no longer exists");
  for (const child of dropped) teardownDeliveryScope(childDeliveryScope(child));
  return next;
}

export function updateTaskChild(
  taskId: string,
  childId: string,
  patch: Partial<TaskChild>,
): TaskWorkspace | undefined {
  return updateTask(taskId, (task) => ({
    ...task,
    children: task.children.map((child) =>
      child.id === childId ? { ...child, ...patch } : child,
    ),
  }));
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
    [...task.children, ...added].map((child) => child.workingCopy),
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
  teardownDeliveryScope({
    sessionIds: dropped.flatMap((child) => child.sessionIds),
    cwds: dropped.flatMap((child) =>
      child.workingCopy ? [child.workingCopy] : [],
    ),
  });
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
): TaskChild | undefined {
  const matches = task.children.filter(
    (child) => child.repositoryId === repositoryId,
  );
  if (!matches.length) return undefined;
  if (attemptId)
    return (
      matches.find((child) => child.attemptId === attemptId) ?? matches[0]
    );
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
 * existing/main copy — `branch`+`base` are only recorded for worktree-mode
 * children. Cleanup offers must use this, never path heuristics. */
export function taskOwnsCheckout(child: TaskChild): boolean {
  return Boolean(child.branch && child.baseRef);
}

export function recordTaskActiveChild(taskId: string, childId: string) {
  updateTask(taskId, (task) =>
    task.children.some((child) => child.id === childId)
      ? { ...task, lastActiveChildId: childId }
      : task,
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

const childDeliveryScope = (child: TaskChild) => ({
  sessionIds: child.sessionIds,
  cwds: child.workingCopy ? [child.workingCopy] : [],
});

type DeliveryScope = {
  sessionIds?: readonly string[];
  cwds?: readonly string[];
};

/** A stored link still covering the delivery from OUTSIDE the torn-down
 * scope keeps its watcher. Rows bound to the scope itself don't count —
 * they stay on disk but their owner is gone. Coverage can't span
 * checkouts, so a shared working copy still loses the watcher. */
function deliveryLinkedOutsideScope(scope: DeliveryScope) {
  const sessionIds = new Set(scope.sessionIds ?? []);
  const cwds = new Set((scope.cwds ?? []).map(pathKey));
  const bound = (cwd: string, sessions: readonly (string | undefined)[]) =>
    cwds.has(pathKey(cwd)) ||
    sessions.some((id) => id !== undefined && sessionIds.has(id));
  return (source: DeliveryWatcherSource): DeliverySurvival => {
    if (source.kind === "azure-pr") {
      const key = azurePrKey(source.target);
      const row = allAzurePrAssociations().find(
        (row) =>
          row?.target &&
          azurePrKey(row.target) === key &&
          pathKey(row.cwd) === pathKey(source.cwd) &&
          row.branch === source.branch &&
          !bound(row.cwd, [row.sourceSessionId]),
      );
      return row ? { sessionId: row.sourceSessionId } : false;
    }
    if (source.kind === "azure-ci") {
      const key = ciKey(source.target);
      const row = allCiSources().find(
        (row) =>
          row?.target &&
          ciKey(row.target) === key &&
          pathKey(row.cwd) === pathKey(source.cwd) &&
          row.branch === source.branch &&
          !bound(row.cwd, [row.session]),
      );
      return row ? { sessionId: row.session } : false;
    }
    // github-pr — coverage comes from another task child's saved PR result.
    const drafts = listTaskPrDrafts();
    for (const task of loadTaskWorkspaces()) {
      for (const child of task.children) {
        if (
          !child.workingCopy ||
          pathKey(child.workingCopy) !== pathKey(source.cwd) ||
          bound(child.workingCopy, [
            ...(task.sessionIds ?? []),
            ...child.sessionIds,
          ])
        )
          continue;
        const result = drafts[taskPrRowKey(task.id, child.id)]?.result;
        if (result?.provider !== "github") continue;
        const parsed = parseGithubWorkItemUrl(result.url);
        if (
          parsed?.kind !== "pr" ||
          parsed.repo.toLowerCase() !== source.repo.toLowerCase() ||
          parsed.number !== source.number
        )
          continue;
        return { sessionId: child.sessionIds[0] ?? task.sessionIds?.[0] };
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
  if (task) teardownDeliveryScope(taskDeliveryScope(task));
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
  if (removed) teardownDeliveryScope(childDeliveryScope(removed));
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
  teardownDeliveryScope({ sessionIds: [sessionId] });
}

/** Reverse lookup — which task child owns an ordinary session. `cwd` is
 * the session's actual working copy: a task-level session reports the
 * child it is rooted in rather than whatever `lastActiveChildId` says. */
export function taskForSession(
  sessionId: string,
  cwd?: string,
  tasks: readonly TaskWorkspace[] = loadTaskWorkspaces(),
): { task: TaskWorkspace; child: TaskChild } | null {
  for (const task of tasks) {
    if (task.archived) continue;
    const child = task.children.find((entry) =>
      entry.sessionIds.includes(sessionId),
    );
    if (child) return { task, child };
    // A task-level session displays its host child — the repository the
    // conversation is rooted at.
    if (task.sessionIds?.includes(sessionId)) {
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
      return { task, child: host };
    }
  }
  return null;
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
  const key = pathKey(path);
  const out: { task: TaskWorkspace; child: TaskChild }[] = [];
  for (const task of tasks) {
    if (task.archived || task.id === excludeTaskId) continue;
    for (const child of task.children)
      if (child.workingCopy && pathKey(child.workingCopy) === key)
        out.push({ task, child });
  }
  return out;
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

/** `repo/branch` display label for a child — repo name falls back to the
 * working-copy basename when the repository record is gone. */
export function taskChildRepoLabel(
  task: TaskWorkspace,
  child: TaskChild,
  project?: ProjectRecord,
): string {
  const repo = repositoryForChild(task, child, project);
  const repoName = repo
    ? repositoryDisplay(repo)
    : child.workingCopy
      ? (prettyCwd(child.workingCopy)
          .split("/")
          .filter(Boolean)
          .pop() ?? child.workingCopy)
      : "Repository";
  const base = child.branch ? `${repoName}/${child.branch}` : repoName;
  // The same repository under two attempts needs the attempt label;
  // otherwise it adds noise without disambiguating.
  return repoAcrossAttempts(task, child.repositoryId)
    ? `${base} · ${taskAttemptLabel(task, child.attemptId)}`
    : base;
}

function repositoryDisplay(repository: ProjectRepository): string {
  return (
    repository.label ??
    prettyCwd(repository.anchor).split("/").filter(Boolean).pop() ??
    repository.anchor
  );
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
    const repository = project
      ? repositoryOf(project, child.repositoryId)
      : undefined;
    const name = repository
      ? repositoryDisplay(repository)
      : child.repositoryId;
    const parts = [`- ${name}`];
    if (child.workingCopy) parts.push(`working copy: ${child.workingCopy}`);
    else parts.push("no working copy prepared yet");
    if (child.branch) {
      const base = child.baseRef
        ? ` (from ${child.baseRef.replace(/^refs\/(heads|remotes)\//, "")}${child.baseCommit ? ` @ ${child.baseCommit.slice(0, 10)}` : ""})`
        : "";
      parts.push(`branch: ${child.branch}${base}`);
      if (child.mergeTarget) parts.push(`merge target: ${child.mergeTarget}`);
    }
    if (repoAcrossAttempts(task, child.repositoryId))
      parts.push(`attempt: ${taskAttemptLabel(task, child.attemptId)}`);
    lines.push(parts.join(" — "));
    if (child.responsibility?.trim())
      lines.push(`  Responsibility: ${child.responsibility.trim()}`);
  }
  lines.push(
    "",
    "Work in each repository's own working copy — they are separate checkouts, not copies of each other.",
  );
  return lines.join("\n").trim();
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
  const name = repository ? repositoryDisplay(repository) : child.repositoryId;
  lines.push(`Repository: ${name}`);
  if (child.workingCopy) lines.push(`Working copy: ${child.workingCopy}`);
  if (child.branch) {
    const base = child.baseRef
      ? ` (from ${child.baseRef.replace(/^refs\/(heads|remotes)\//, "")}${child.baseCommit ? ` @ ${child.baseCommit.slice(0, 10)}` : ""})`
      : "";
    lines.push(`Branch: ${child.branch}${base}`);
    if (child.mergeTarget)
      lines.push(`Merge target: ${child.mergeTarget}`);
  }
  if (repoAcrossAttempts(task, child.repositoryId))
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
