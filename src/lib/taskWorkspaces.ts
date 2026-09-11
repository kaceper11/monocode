import { pathKey, prettyCwd, wslLocation } from "./paths";
import {
  loadProjects,
  type ProjectRecord,
  type ProjectRepository,
} from "./projects";
import type { LinkedWorkItem } from "./session";

const KEY = "monocode.taskWorkspaces.v1";
const EVENT = "monocode:task-workspaces-changed";
const MAX_TASKS = 100;
const MAX_CHILDREN = 50;

/**
 * Per-child launch lifecycle. `pending` children are actionable but have no
 * session yet (prepare-later or not launched); `ready` children have at least
 * one session; `failed` retains the launch error for retry. A child only
 * moves forward — retry re-runs just the unresolved launch steps.
 */
export type TaskChildLaunchState = "pending" | "working" | "ready" | "failed";

/**
 * Exact routing identity for one repository's share of a task. Provider,
 * account and remote mappings are not copied here — they resolve through the
 * existing per-repository stores keyed by this identity.
 */
export type TaskChild = {
  id: string;
  /** `ProjectRepository.id` — never a name or path. */
  repositoryId: string;
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

function sanitizeChild(value: unknown, taskId: string): TaskChild | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id);
  const repositoryId = cleanString(value.repositoryId);
  if (!id || !repositoryId) return null;
  const launch = isRecord(value.launch) ? value.launch : {};
  const state = cleanString(launch.state);
  return {
    id,
    repositoryId,
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
  const children = Array.isArray(value.children)
    ? value.children
        .map((child) => sanitizeChild(child, id))
        .filter((child): child is TaskChild => child !== null)
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
    children,
    sessionIds: cleanStrings(value.sessionIds, 20),
    ...(cleanString(value.briefSentFor)
      ? { briefSentFor: cleanString(value.briefSentFor) }
      : {}),
    ...(children.some((child) => child.id === lastActiveChildId)
      ? { lastActiveChildId }
      : {}),
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : Date.now(),
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
/** Validates child drafts against a project and builds child records. */
function buildTaskChildren(
  project: ProjectRecord,
  drafts: readonly TaskChildDraft[],
): TaskChild[] {
  return drafts.map((draft) => {
    const repository = repositoryOf(project, draft.repositoryId);
    if (!repository)
      throw new Error("A selected repository is no longer in this project");
    const workingCopy =
      draft.mode === "later"
        ? undefined
        : cleanString(
            draft.mode === "worktree" ? draft.path : draft.workingCopy,
          );
    const createsWorktree = draft.mode === "worktree";
    if (createsWorktree && (!draft.baseRef || !draft.baseCommit || !draft.branch || !draft.path))
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
      ...(workingCopy ? { workingCopy } : {}),
      ...(createsWorktree
        ? {
            branch: draft.branch!,
            baseRef: draft.baseRef!,
            baseCommit: draft.baseCommit!,
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
  const children = buildTaskChildren(project, drafts);
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
  const next = updateTask(taskId, (current) => {
    const kept = current.children.filter((child) =>
      revision.keepRepositoryIds.includes(child.repositoryId),
    );
    const drafts = revision.additions.filter(
      (child) => child && child.repositoryId,
    );
    const owned = new Set(kept.map((child) => child.repositoryId));
    for (const draft of drafts)
      if (owned.has(draft.repositoryId))
        throw new Error("A selected repository is already in this task");
    if (!kept.length && !drafts.length)
      throw new Error("Select at least one repository");
    if (kept.length + drafts.length > MAX_CHILDREN)
      throw new Error(`A task supports up to ${MAX_CHILDREN} repositories`);
    const added = buildTaskChildren(project, drafts);
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
  const owned = new Set(task.children.map((child) => child.repositoryId));
  for (const draft of valid)
    if (owned.has(draft.repositoryId))
      throw new Error("A selected repository is already in this task");
  if (task.children.length + valid.length > MAX_CHILDREN)
    throw new Error(`A task supports up to ${MAX_CHILDREN} repositories`);
  const added = buildTaskChildren(project, valid);
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

export function recordTaskActiveChild(taskId: string, childId: string) {
  updateTask(taskId, (task) =>
    task.children.some((child) => child.id === childId)
      ? { ...task, lastActiveChildId: childId }
      : task,
  );
}

/** Removes the task record only — sessions, worktrees and branches stay. */
export function removeTask(taskId: string) {
  saveTaskWorkspaces(
    loadTaskWorkspaces().filter((task) => task.id !== taskId),
  );
}

export function archiveTask(taskId: string, archived = true) {
  updateTask(taskId, (task) => ({ ...task, archived }));
}

/** Drops the child association; its sessions, copies and branches stay. */
export function removeTaskChild(taskId: string, childId: string) {
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
        task.children.find((entry) => entry.workingCopy) ??
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
  return child.branch ? `${repoName}/${child.branch}` : repoName;
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
