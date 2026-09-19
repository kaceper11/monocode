import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "./fs";
import { killPty, readyPtyEvents, spawnPty } from "./pty";
import { commandDirectory, type SavedCommandStep } from "./savedCommands";

export type SavedCommandRun = {
  terminalId: string;
  commandId: string;
  projectCwd: string;
  name: string;
  cwd: string;
  steps: SavedCommandStep[];
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  done: number;
  error?: string;
};
type Entry = {
  value: SavedCommandRun;
  consumed: boolean;
  owner?: symbol;
  pending?: Promise<void>;
  stop?: () => Promise<void>;
};
// Execution intent is deliberately not persisted: restoring a terminal cannot
// rerun a command whose previous delivery is unknown.
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let snapshot: readonly SavedCommandRun[] = [];
function changed() {
  snapshot = [...entries.values()].map((entry) => entry.value);
  listeners.forEach((listener) => listener());
}
export const savedCommandRunsSnapshot = () => snapshot;
export function subscribeSavedCommandRuns(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function queueSavedCommandRun(
  value: Omit<SavedCommandRun, "status" | "done">,
) {
  if (entries.has(value.terminalId))
    throw new Error("This terminal already owns a saved command.");
  entries.set(value.terminalId, {
    value: {
      ...value,
      steps: value.steps.map((step) => ({ ...step })),
      status: "queued",
      done: 0,
    },
    consumed: false,
  });
  changed();
}
/** Only ownerless queued entries need App-level cleanup; mounted runs own disposal. */
export function pruneQueuedSavedCommands(isOpen: (id: string) => boolean) {
  let removed = false;
  for (const [id, entry] of entries) {
    if (!entry.owner && !isOpen(id)) {
      entries.delete(id);
      removed = true;
    }
  }
  if (removed) changed();
}

export async function stopSavedCommandRun(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  if (!entry.stop) {
    entry.consumed = true;
    entry.value = { ...entry.value, status: "stopped" };
    changed();
    return;
  }
  await entry.stop();
}

/** Adapter for a mounted upstream terminal; owns only this saved sequence. */
export function bindSavedCommandRun(
  id: string,
  notice: (text: string) => void,
  size: () => { cols: number; rows: number },
) {
  const entry = entries.get(id);
  if (!entry) return undefined;
  const owner = Symbol(id);
  entry.owner = owner;
  let closed = false;
  let stopped = false;
  let exit: ((code: number | null) => void) | undefined;
  const live = () => !closed && entry.owner === owner;
  const update = (patch: Partial<SavedCommandRun>) => {
    if (!live()) return;
    entry.value = { ...entry.value, ...patch };
    changed();
  };
  const shell = () => {
    const { cols, rows } = size();
    return (entry.pending = spawnPty(id, entry.value.cwd, cols, rows));
  };
  entry.stop = async () => {
    if (!live() || !["queued", "running"].includes(entry.value.status)) return;
    stopped = true;
    entry.consumed = true;
    await entry.pending?.catch(() => undefined);
    if (!live()) return;
    try {
      // Keep the mounted terminal's existing subscriptions while stopping its PTY.
      await invoke("pty_kill", { id });
      update({ status: "stopped" });
      exit?.(null);
    } catch (reason) {
      update({ error: `Could not stop: ${String(reason)}` });
      throw reason;
    }
  };
  return {
    async start(cwd: string): Promise<void> {
      // StrictMode's throwaway mount must not consume or dispatch intent.
      await Promise.resolve();
      await entry.pending?.catch(() => undefined);
      if (!live()) return;
      try {
        if (cwd !== entry.value.cwd)
          throw new Error(
            "Saved command destination changed before the terminal opened.",
          );
        await readyPtyEvents();
      } catch (reason) {
        if (live()) {
          entry.consumed = true;
          update({ status: "failed", error: String(reason) });
        }
        throw reason;
      }
      if (!live()) return;
      if (entry.consumed) {
        if (entry.value.status === "running")
          update({
            status: "stopped",
            error: "Terminal remounted; the command was not replayed.",
          });
        await shell();
        return;
      }
      entry.consumed = true;
      let ready = false;
      let resolveReady!: () => void;
      let rejectReady!: (reason: unknown) => void;
      const first = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const markReady = () => {
        if (!ready) {
          ready = true;
          resolveReady();
        }
      };
      void (async () => {
        try {
          for (let index = 0; index < entry.value.steps.length; index++) {
            if (!live() || stopped) break;
            const step = entry.value.steps[index];
            const dir =
              step.host === "native"
                ? commandDirectory(await homeDir())
                : entry.value.cwd;
            if (!live() || stopped) break;
            update({ status: "running", done: index, error: undefined });
            notice(
              `── step ${index + 1}/${entry.value.steps.length}${step.host === "native" ? " (OS host)" : ""}: ${step.command}`,
            );
            const exited = new Promise<number | null>((resolve) => {
              exit = resolve;
            });
            const { cols, rows } = size();
            entry.pending = invoke("pty_spawn", {
              id,
              cwd: dir,
              cols,
              rows,
              exec: step.command,
            });
            await entry.pending;
            markReady();
            const code = await exited;
            exit = undefined;
            if (!live() || stopped) break;
            if (code !== 0)
              throw new Error(
                code === null
                  ? `Step ${index + 1} was interrupted.`
                  : `Step ${index + 1} failed (${code}).`,
              );
            update({ done: index + 1 });
          }
          if (live()) {
            update({ status: stopped ? "stopped" : "completed" });
            notice(stopped ? "── command stopped" : "── all steps finished");
          }
        } catch (reason) {
          if (live()) {
            const error =
              reason instanceof Error ? reason.message : String(reason);
            update({ status: "failed", error });
            notice(error);
          }
        } finally {
          exit = undefined;
          if (live()) {
            try {
              await shell();
              markReady();
            } catch (reason) {
              update({
                error: `Could not reopen the shell: ${String(reason)}`,
              });
              notice(`Could not reopen the shell: ${String(reason)}`);
              if (!ready) rejectReady(reason);
            }
          } else markReady();
        }
      })();
      return first;
    },
    exited(code: number | null): boolean {
      if (!live() || !exit) return false;
      exit(code);
      return true;
    },
    async dispose(): Promise<void> {
      if (closed) return;
      closed = true;
      stopped = true;
      exit?.(null);
      await entry.pending?.catch(() => undefined);
      if (entry.owner !== owner) return;
      entries.delete(id);
      changed();
      await killPty(id);
    },
  };
}
