import { slash } from "./paths";
import {
  MAX_COMMAND_STEPS,
  MAX_COMMAND_TEXT,
  repositoryDisplayName,
  sanitizeSteps,
  type CommandStep,
  type ProjectCommand,
  type ProjectRecord,
} from "./projects";
import {
  childForRepository,
  preferredTaskChild,
  type TaskChild,
  type TaskWorkspace,
} from "./taskWorkspaces";

/**
 * A command saved outside a project — the reusable counterpart to
 * `ProjectCommand`. It has no repository binding; it runs in the task's
 * primary working copy or the project folder it was launched from.
 */
export type ReusableCommand = {
  id: string;
  name: string;
  command: string;
  /** Directory relative to the resolved root. */
  relativeCwd?: string;
  /** When set, the steps run in order and `command` is display text only. */
  steps?: CommandStep[];
};

const KEY = "monocode.projectCommands.v1";
const EVENT = "monocode:project-commands-changed";
const MAX_COMMANDS = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function sanitizeReusable(value: unknown): ReusableCommand | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (!id || !name || !command) return null;
  const relativeCwd =
    typeof value.relativeCwd === "string" ? value.relativeCwd.trim() : "";
  const steps = sanitizeSteps(value.steps);
  return {
    id: id.slice(0, 128),
    name: name.slice(0, 200),
    command: command.slice(0, MAX_COMMAND_TEXT),
    ...(relativeCwd ? { relativeCwd: relativeCwd.slice(0, 500) } : {}),
    ...(steps ? { steps } : {}),
  };
}

export function loadReusableCommands(): ReusableCommand[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: ReusableCommand[] = [];
    for (const item of parsed) {
      const command = sanitizeReusable(item);
      if (!command || seen.has(command.id)) continue;
      seen.add(command.id);
      out.push(command);
      if (out.length >= MAX_COMMANDS) break;
    }
    return out;
  } catch {
    return [];
  }
}

function saveReusableCommands(commands: ReusableCommand[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(commands.slice(0, MAX_COMMANDS)));
  } catch {
    /* storage full or unavailable */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(EVENT));
  }
}

export function reusableCommandsSnapshot(): string | null {
  return localStorage.getItem(KEY);
}

export function subscribeReusableCommands(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
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

export function saveReusableCommand(
  draft: Omit<ReusableCommand, "id">,
  commandId?: string,
): { error?: string } {
  const name = draft.name.trim().slice(0, 200);
  const command = draft.command.trim().slice(0, MAX_COMMAND_TEXT);
  if (!name) return { error: "Name the command." };
  const relativeCwd = draft.relativeCwd?.trim().slice(0, 500);
  const steps = draft.steps
    ?.map((step) => ({
      command: step.command.trim().slice(0, MAX_COMMAND_TEXT),
      ...(step.host === "native" ? { host: "native" as const } : {}),
    }))
    .filter((step) => step.command)
    .slice(0, MAX_COMMAND_STEPS);
  if (draft.steps && !steps?.length)
    return { error: "Add a step or turn steps off." };
  if (!command) return { error: "Enter the command to run." };
  const commands = loadReusableCommands();
  if (commandId && !commands.some((item) => item.id === commandId))
    return { error: "That command no longer exists." };
  if (!commandId && commands.length >= MAX_COMMANDS)
    return { error: `You already have ${MAX_COMMANDS} reusable commands.` };
  const entry: ReusableCommand = {
    id: commandId ?? crypto.randomUUID(),
    name,
    command,
    ...(relativeCwd ? { relativeCwd } : {}),
    ...(steps?.length ? { steps } : {}),
  };
  const index = commandId
    ? commands.findIndex((item) => item.id === commandId)
    : -1;
  const list =
    index >= 0
      ? commands.map((item) => (item.id === commandId ? entry : item))
      : [...commands, entry];
  saveReusableCommands(list);
  return {};
}

export function deleteReusableCommand(commandId: string): void {
  saveReusableCommands(
    loadReusableCommands().filter((item) => item.id !== commandId),
  );
}

export function moveReusableCommand(commandId: string, delta: -1 | 1): void {
  const commands = loadReusableCommands();
  const index = commands.findIndex((item) => item.id === commandId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= commands.length) return;
  const next = [...commands];
  [next[index], next[target]] = [next[target], next[index]];
  saveReusableCommands(next);
}

/** Where a command will run — resolved at click time, never cached. */
export type ResolvedCommandTarget = {
  /** Host-qualified cwd for the PTY — exact worktree or repository anchor. */
  cwd: string;
  /** What the cwd is rooted at — shown so the target is never ambiguous. */
  source: "task" | "repository" | "project";
  /** Repository display name when the command is bound to one. */
  label?: string;
};

/**
 * Joins a saved `relativeCwd` onto a resolved root. The result must stay
 * inside the root: absolute paths, drive letters, `~` and `..` segments are
 * rejected — a command can never silently escape its worktree.
 */
export function joinRelativeCwd(
  base: string,
  relative: string | undefined,
): { cwd: string } | { error: string } {
  // Saved relative dirs normalize separators on every platform — a stored
  // `apps\web` is a Windows-style path, not a literal backslash directory.
  const rel = slash((relative ?? "").replace(/\\/g, "/")).trim();
  if (!rel) return { cwd: base };
  if (rel.startsWith("/") || rel.startsWith("~") || /^[A-Za-z]:/.test(rel))
    return { error: "The directory must be relative." };
  const segments = rel.split("/").filter((part) => part && part !== ".");
  if (segments.some((part) => part === ".."))
    return { error: "The directory cannot leave the worktree." };
  return {
    cwd: segments.length
      ? `${base.replace(/\/+$/, "")}/${segments.join("/")}`
      : base,
  };
}

function taskPrimaryChild(task: TaskWorkspace) {
  return (
    task.children.find(
      (child) => child.id === task.lastActiveChildId && child.workingCopy,
    ) ??
    preferredTaskChild(task, (child) => Boolean(child.workingCopy)) ??
    task.children[0]
  );
}

/**
 * Resolves where a command runs. Bound commands follow their repository: in a
 * task that means the child's exact task worktree — never the project root or
 * another child's copy. Unbound commands use the task's primary copy, then
 * the project folder. Failures are explicit; nothing falls back silently.
 */
export function resolveCommandTarget(input: {
  command: { repositoryId?: string; relativeCwd?: string };
  project?: ProjectRecord;
  task?: TaskWorkspace | null;
  /** Run in this specific child — the copy a session actually worked in —
   * rather than the task's primary child. Bound commands keep their
   * repository but take the child's attempt. */
  child?: TaskChild;
  /** Folder a reusable command was launched from when no project owns it. */
  fallbackCwd?: string;
}): ResolvedCommandTarget | { error: string } {
  const { command, project, task } = input;
  let base: string | undefined;
  let source: ResolvedCommandTarget["source"] = "project";
  let label: string | undefined;

  if (command.repositoryId) {
    const repo = project?.repositories.find(
      (entry) => entry.id === command.repositoryId,
    );
    if (!repo) {
      return { error: "The repository this command targets left the project." };
    }
    label = repositoryDisplayName(repo);
    if (task) {
      // A `child` input means "the copy this session worked in" — an attempt
      // without one is an honest miss, not a reason to run in another
      // attempt's checkout.
      const child = childForRepository(
        task,
        command.repositoryId,
        input.child?.attemptId,
        Boolean(input.child?.attemptId),
      );
      if (!child) {
        return {
          error: input.child?.attemptId
            ? `This attempt has no copy of ${label} yet.`
            : `${label} is not part of task “${task.name}”.`,
        };
      }
      if (!child.workingCopy) {
        return {
          error: `${label} has no working copy in “${task.name}” yet.`,
        };
      }
      base = child.workingCopy;
      source = "task";
    } else {
      base = repo.anchor;
      source = "repository";
    }
  } else if (task) {
    const child = input.child ?? taskPrimaryChild(task);
    if (!child?.workingCopy) {
      return { error: `Task “${task.name}” has no working copy yet.` };
    }
    base = child.workingCopy;
    source = "task";
  } else {
    base =
      project?.lastPath ??
      project?.anchor ??
      project?.repositories[0]?.anchor ??
      input.fallbackCwd;
    source = "project";
  }

  if (!base) return { error: "This project has no folder to run commands in." };
  const joined = joinRelativeCwd(base, command.relativeCwd);
  if ("error" in joined) return joined;
  return {
    cwd: joined.cwd,
    source,
    ...(label ? { label } : {}),
  };
}

/**
 * Resolves every member of a command group. Members that cannot resolve are
 * reported — never skipped silently — and the rest still run, so one stale
 * command cannot hold the group hostage.
 */
export function resolveCommandGroup(input: {
  commands: readonly ProjectCommand[];
  project?: ProjectRecord;
  task?: TaskWorkspace | null;
  fallbackCwd?: string;
}): {
  runs: { command: ProjectCommand; target: ResolvedCommandTarget }[];
  failures: { command: ProjectCommand; error: string }[];
} {
  const runs: { command: ProjectCommand; target: ResolvedCommandTarget }[] = [];
  const failures: { command: ProjectCommand; error: string }[] = [];
  for (const command of input.commands) {
    const target = resolveCommandTarget({
      command,
      project: input.project,
      task: input.task,
      fallbackCwd: input.fallbackCwd,
    });
    if ("error" in target) failures.push({ command, error: target.error });
    else runs.push({ command, target });
  }
  return { runs, failures };
}

/** Fired on `window` to open a project's saved-commands sheet — surfaces
 * emit, App hosts. */
export const OPEN_COMMANDS_SHEET = "monocode:open-commands-sheet";

export type CommandsSheetRequest = {
  projectId: string;
  /** Scroll a section into view — a check row's Configure lands on its
   * controls instead of the top of the command list. */
  focus?: "checks";
};

export function openCommandsSheet(request: CommandsSheetRequest) {
  window.dispatchEvent(
    new CustomEvent<CommandsSheetRequest>(OPEN_COMMANDS_SHEET, {
      detail: request,
    }),
  );
}
