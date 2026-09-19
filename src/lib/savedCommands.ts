import { pathKey, slash } from "./paths";

export type SavedCommandStep = { command: string; host?: "native" };
export type LegacyCommandScope = {
  projectId: string;
  name: string;
  repositoryId?: string;
  suggestedCwd?: string;
};
export type SavedCommand = {
  id: string;
  name: string;
  command: string;
  relativeCwd?: string;
  steps?: SavedCommandStep[];
  /** Upstream project path; omitted for reusable commands. */
  projectCwd?: string;
  /** Explicit fixed destination; omitted for the selected working copy. */
  targetCwd?: string;
  /** Never executable until the owner chooses a current scope/destination. */
  legacy?: LegacyCommandScope;
};
export type SavedCommandGroup = {
  id: string;
  name: string;
  commandIds: string[];
  projectCwd?: string;
  legacy?: LegacyCommandScope;
};
export type SavedCommands = {
  commands: SavedCommand[];
  groups: SavedCommandGroup[];
};
export type CommandDestination = { projectCwd: string; worktreeCwd: string };
export const MAX_COMMAND_TEXT = 4_000;
export const MAX_COMMAND_STEPS = 12;
const KEY = "monocode.savedCommands.v1";
const LEGACY_REUSABLE = "monocode.projectCommands.v1";
const LEGACY_PROJECTS = "monocode.projects.v1";
const EVENT = "monocode:saved-commands-changed";
// Preserve the old 100 projects × 100 commands, plus 50 reusable commands.
const MAX_COMMANDS = 10_050;
const MAX_GROUPS = 5_000;
const invalid = () =>
  new Error(
    "Saved command data is invalid. Its original stored content has been preserved.",
  );
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw invalid();
  return value;
}
function optional(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : text(value, max);
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value;
}
function scope(value: unknown): LegacyCommandScope | undefined {
  if (value === undefined) return undefined;
  const item = record(value);
  return {
    projectId: text(item.projectId, 128),
    name: text(item.name, 200),
    ...(item.repositoryId !== undefined
      ? { repositoryId: text(item.repositoryId, 128) }
      : {}),
    ...(item.suggestedCwd !== undefined
      ? { suggestedCwd: text(item.suggestedCwd, 4096) }
      : {}),
  };
}
function common(value: Record<string, unknown>) {
  const legacy = scope(value.legacy);
  const projectCwd = optional(value.projectCwd, 4096);
  if (legacy && projectCwd !== undefined) throw invalid();
  return {
    id: text(value.id, 512),
    name: text(value.name, 200),
    ...(projectCwd !== undefined ? { projectCwd } : {}),
    ...(legacy ? { legacy } : {}),
  };
}
function command(value: unknown): SavedCommand {
  const item = record(value);
  const base = common(item);
  const steps =
    item.steps === undefined
      ? undefined
      : list(item.steps, MAX_COMMAND_STEPS).map((value) => {
          const step = record(value);
          if (step.host !== undefined && step.host !== "native")
            throw invalid();
          return {
            command: text(step.command, MAX_COMMAND_TEXT),
            ...(step.host === "native" ? { host: "native" as const } : {}),
          };
        });
  if (steps && !steps.length) throw invalid();
  if (base.legacy && item.targetCwd !== undefined) throw invalid();
  return {
    ...base,
    command: text(item.command, MAX_COMMAND_TEXT),
    ...(item.relativeCwd !== undefined
      ? { relativeCwd: text(item.relativeCwd, 500) }
      : {}),
    ...(item.targetCwd !== undefined
      ? { targetCwd: text(item.targetCwd, 4096) }
      : {}),
    ...(steps ? { steps } : {}),
  };
}
function group(value: unknown): SavedCommandGroup {
  const item = record(value);
  const ids = list(item.commandIds, 100).map((id) => text(id, 512));
  if (!ids.length || new Set(ids).size !== ids.length) throw invalid();
  return { ...common(item), commandIds: ids };
}
function validate(value: unknown): SavedCommands {
  const item = record(value);
  const commands = list(item.commands, MAX_COMMANDS).map(command);
  const groups = list(item.groups, MAX_GROUPS).map(group);
  if (
    new Set(commands.map((item) => item.id)).size !== commands.length ||
    new Set(groups.map((item) => item.id)).size !== groups.length
  )
    throw invalid();
  return { commands, groups };
}

/** Reads preserve both old stores, including unrelated old project policy. */
export function savedCommandsSnapshot(): string {
  try {
    const current = localStorage.getItem(KEY);
    return current !== null
      ? `current:${current}`
      : `legacy:${JSON.stringify([localStorage.getItem(LEGACY_REUSABLE), localStorage.getItem(LEGACY_PROJECTS)])}`;
  } catch {
    return "unavailable:";
  }
}
export function readSavedCommands(
  snapshot = savedCommandsSnapshot(),
): SavedCommands {
  if (!snapshot.startsWith("current:") && !snapshot.startsWith("legacy:"))
    throw new Error("Saved command storage is unavailable.");
  try {
    if (snapshot.startsWith("current:")) {
      const item = record(JSON.parse(snapshot.slice(8)));
      if (item.version !== 1) throw invalid();
      return validate(item);
    }
    const raw = list(JSON.parse(snapshot.slice(7)), 2);
    if (
      raw.length !== 2 ||
      raw.some((value) => value !== null && typeof value !== "string")
    )
      throw invalid();
    const reusable =
      raw[0] === null ? [] : list(JSON.parse(raw[0] as string), 50);
    const projects =
      raw[1] === null ? [] : list(JSON.parse(raw[1] as string), 100);
    const commands = reusable.map((value) => {
      const item = record(value);
      // The old reusable schema never had a project/repository/host binding.
      if (
        item.repositoryId !== undefined ||
        item.projectCwd !== undefined ||
        item.targetCwd !== undefined ||
        item.legacy !== undefined
      )
        throw invalid();
      return command({
        ...item,
        id: JSON.stringify(["reusable", text(item.id, 128)]),
      });
    });
    const groups: SavedCommandGroup[] = [];
    for (const value of projects) {
      const project = record(value);
      const projectId = text(project.id, 128);
      const name = optional(project.name, 200) ?? projectId;
      const repos =
        project.repositories === undefined
          ? []
          : list(project.repositories, 50).map(record);
      const legacyId = (id: unknown) =>
        JSON.stringify(["project", projectId, text(id, 128)]);
      const entries =
        project.commands === undefined ? [] : list(project.commands, 100);
      for (const value of entries) {
        const item = record(value);
        const repositoryId = optional(item.repositoryId, 128);
        const repo =
          repositoryId === undefined
            ? undefined
            : repos.find((repo) => repo.id === repositoryId);
        const suggestedCwd = optional(
          repositoryId === undefined ? project.anchor : repo?.anchor,
          4096,
        );
        commands.push(
          command({
            id: legacyId(item.id),
            name: item.name,
            command: item.command,
            relativeCwd: item.relativeCwd,
            steps: item.steps,
            legacy: {
              projectId,
              name,
              ...(repositoryId !== undefined ? { repositoryId } : {}),
              ...(suggestedCwd !== undefined ? { suggestedCwd } : {}),
            },
          }),
        );
      }
      for (const value of project.commandGroups === undefined
        ? []
        : list(project.commandGroups, 50)) {
        const item = record(value);
        groups.push(
          group({
            id: legacyId(item.id),
            name: item.name,
            commandIds: list(item.commandIds, 100).map(legacyId),
            legacy: { projectId, name },
          }),
        );
      }
    }
    return validate({ commands, groups });
  } catch (reason) {
    if (reason instanceof SyntaxError) throw invalid();
    throw reason;
  }
}
export function subscribeSavedCommands(listener: () => void): () => void {
  const changed = (event: StorageEvent) => {
    if (
      event.key === null ||
      [KEY, LEGACY_REUSABLE, LEGACY_PROJECTS].includes(event.key)
    )
      listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", changed);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", changed);
  };
}
export async function changeSavedCommands(
  expected: string,
  change: (store: SavedCommands) => SavedCommands,
): Promise<string> {
  const write = () => {
    if (savedCommandsSnapshot() !== expected)
      throw new Error(
        "Saved commands changed in another window. Reopen the command before saving.",
      );
    const store = validate(change(readSavedCommands(expected)));
    localStorage.setItem(KEY, JSON.stringify({ version: 1, ...store }));
    window.dispatchEvent(new Event(EVENT));
    return savedCommandsSnapshot();
  };
  return navigator.locks ? navigator.locks.request(KEY, write) : write();
}

export function commandDirectory(base: string, relative?: string): string {
  const root = slash(text(base, 4096));
  if (
    (!root.startsWith("/") && !/^[A-Za-z]:\//.test(root)) ||
    root.split("/").includes("..")
  )
    throw new Error("Choose an absolute working-copy directory.");
  const rel = (relative ?? "").replace(/\\/g, "/").trim();
  if (
    rel.startsWith("/") ||
    rel.startsWith("~") ||
    /^[A-Za-z]:/.test(rel) ||
    rel.split("/").includes("..") ||
    /[\x00-\x1f\x7f]/.test(rel)
  )
    throw new Error(
      "The subdirectory must stay inside the chosen working copy.",
    );
  const parts = rel.split("/").filter((part) => part && part !== ".");
  return parts.length ? `${root.replace(/\/+$/, "")}/${parts.join("/")}` : root;
}
export function resolveSavedCommand(
  value: SavedCommand,
  destination: CommandDestination,
): { cwd: string; steps: SavedCommandStep[] } {
  const item = command(value);
  if (item.legacy)
    throw new Error(
      "Choose a current project and destination for this legacy command first.",
    );
  if (
    item.projectCwd &&
    pathKey(item.projectCwd) !== pathKey(destination.projectCwd)
  )
    throw new Error("This command belongs to another project.");
  return {
    cwd: commandDirectory(
      item.targetCwd ?? destination.worktreeCwd,
      item.relativeCwd,
    ),
    steps: item.steps ?? [{ command: item.command }],
  };
}
export function resolveSavedCommandGroup(
  value: SavedCommandGroup,
  store: SavedCommands,
  destination: CommandDestination,
) {
  const item = group(value);
  if (item.legacy)
    throw new Error("Choose a current project for this legacy group first.");
  if (
    item.projectCwd &&
    pathKey(item.projectCwd) !== pathKey(destination.projectCwd)
  )
    throw new Error("This group belongs to another project.");
  // Resolve the whole selection before dispatch; a missing member is never silently skipped.
  return item.commandIds.map((id) => {
    const command = store.commands.find((command) => command.id === id);
    if (!command)
      throw new Error(
        "A command in this group was deleted. Edit the group before running it.",
      );
    return { command, ...resolveSavedCommand(command, destination) };
  });
}
