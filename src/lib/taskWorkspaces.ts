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

function sanitizeChild(value: unknown): TaskChild | null {
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
      // A `working` launch was interrupted by the reload — it becomes
      // actionable `pending` again; only `ready`/`failed` persist.
      state: state === "ready" || state === "failed" ? state : "pending",
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
        .map(sanitizeChild)
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

export function loadTaskWorkspaces(): TaskWorkspace[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeTask)
      .filter((task): task is TaskWorkspace => task !== null)
      .slice(0, MAX_TASKS);
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
  const children: TaskChild[] = drafts.map((draft) => {
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
  const conflict = taskHostConflict(
    children.map((child) => child.workingCopy),
  );
  if (conflict) throw new Error(conflict);
  const task: TaskWorkspace = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    name,
    ...(input.ticket ? { ticket: input.ticket } : {}),
    ...(cleanString(input.brief) ? { brief: cleanString(input.brief) } : {}),
    children,
    createdAt: Date.now(),
  };
  saveTaskWorkspaces([...loadTaskWorkspaces(), task]);
  return task;
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

/** Reverse lookup — which task child owns an ordinary session. */
export function taskForSession(
  sessionId: string,
  tasks: readonly TaskWorkspace[] = loadTaskWorkspaces(),
): { task: TaskWorkspace; child: TaskChild } | null {
  for (const task of tasks) {
    if (task.archived) continue;
    const child = task.children.find((entry) =>
      entry.sessionIds.includes(sessionId),
    );
    if (child) return { task, child };
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
): ProjectRepository | undefined {
  return repositoryOf(projectForTask(task), child.repositoryId);
}

function repositoryDisplay(repository: ProjectRepository): string {
  return (
    repository.label ??
    prettyCwd(repository.anchor).split("/").filter(Boolean).pop() ??
    repository.anchor
  );
}

/**
 * One session's prompt: shared brief + this child's responsibility + exact
 * identity. It deliberately never references sibling working copies.
 */
export function composeTaskPrompt(
  task: TaskWorkspace,
  child: TaskChild,
  repository: ProjectRepository | undefined,
): string {
  const lines = [`# ${task.name}`, ""];
  if (task.ticket?.title || task.ticket?.identifier || task.ticket?.url) {
    const ticket = [
      task.ticket.identifier,
      task.ticket.title,
      task.ticket.url,
    ]
      .filter(Boolean)
      .join(" — ");
    lines.push(`Ticket: ${ticket}`, "");
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
