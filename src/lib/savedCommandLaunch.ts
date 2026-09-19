import { newTerminalFile, type FilePaneTab } from "./layout";
import { pathKey } from "./paths";
import {
  readSavedCommands,
  resolveSavedCommand,
  savedCommandsSnapshot,
  type CommandDestination,
} from "./savedCommands";
import {
  queueSavedCommandRun,
  savedCommandRunsSnapshot,
} from "./savedCommandRun";

export type SavedCommandLaunch = {
  ids: string[];
  snapshot: string;
  destination: CommandDestination;
};
/** Resolve the entire explicit selection before creating any terminal intent. */
export function prepareSavedCommandLaunch(
  request: SavedCommandLaunch,
  current: CommandDestination,
): { files: FilePaneTab[]; focusId: string } {
  if (
    pathKey(current.projectCwd) !== pathKey(request.destination.projectCwd) ||
    pathKey(current.worktreeCwd) !== pathKey(request.destination.worktreeCwd)
  )
    throw new Error(
      "The selected project or working copy changed. Reopen saved commands.",
    );
  if (request.snapshot !== savedCommandsSnapshot())
    throw new Error("Saved commands changed. Review the selection again.");
  if (
    !request.ids.length ||
    request.ids.length > 100 ||
    new Set(request.ids).size !== request.ids.length
  )
    throw new Error("Choose up to 100 distinct saved commands.");
  const store = readSavedCommands(request.snapshot);
  const resolved = request.ids.map((id) => {
    const command = store.commands.find((command) => command.id === id);
    if (!command) throw new Error("A selected command was deleted.");
    return { command, ...resolveSavedCommand(command, current) };
  });
  const files: FilePaneTab[] = [];
  let focusId = "";
  for (const run of resolved) {
    const existing = savedCommandRunsSnapshot().find(
      (entry) =>
        entry.commandId === run.command.id &&
        pathKey(entry.projectCwd) === pathKey(current.projectCwd) &&
        pathKey(entry.cwd) === pathKey(run.cwd) &&
        ["queued", "running"].includes(entry.status),
    );
    if (existing) {
      focusId = existing.terminalId;
      continue;
    }
    const file = newTerminalFile(run.cwd, run.command.name, current.projectCwd);
    queueSavedCommandRun({
      terminalId: file.id,
      commandId: run.command.id,
      projectCwd: current.projectCwd,
      name: run.command.name,
      cwd: run.cwd,
      steps: run.steps,
    });
    files.push(file);
    focusId = file.id;
  }
  return { files, focusId };
}
