import { basename } from "./fs";
import type { FilePaneTab } from "./layout";

export type TerminalMetaPatch = {
  title?: string;
  cwd?: string;
  /** `null` clears a running command; omit to leave it unchanged. */
  foreground?: string | null;
  /** Partial update to the bound saved command — merged, not replaced. */
  command?: Partial<import("./layout").TerminalCommand>;
};

/** Default tab label from the working directory. */
export function defaultTerminalTitle(cwd: string): string {
  const name = basename(cwd);
  if (!name || name === "/") return "Terminal";
  return name;
}

/** Tab label: dynamic title (process or directory) stored on `path`. */
export function terminalTabLabel(file: FilePaneTab): string {
  return file.path?.trim() || defaultTerminalTitle(file.cwd);
}

/** Apply a live PTY title / cwd / foreground patch. */
export function applyTerminalMeta(
  file: FilePaneTab,
  patch: TerminalMetaPatch,
): FilePaneTab {
  if (!file.terminal) return file;
  const path = patch.title ?? file.path;
  const cwd = patch.cwd ?? file.cwd;
  const foreground =
    patch.foreground === undefined
      ? file.foreground
      : (patch.foreground?.trim() || undefined);
  let command = file.command;
  if (patch.command && file.command) {
    const merged = { ...file.command, ...patch.command };
    if (
      merged.presetId === file.command.presetId &&
      merged.name === file.command.name &&
      merged.text === file.command.text &&
      merged.steps === file.command.steps &&
      merged.runId === file.command.runId &&
      merged.launched === file.command.launched &&
      merged.failed === file.command.failed &&
      merged.step?.runId === file.command.step?.runId &&
      merged.step?.done === file.command.step?.done
    ) {
      command = file.command;
    } else {
      command = merged;
    }
  }
  if (
    path === file.path &&
    cwd === file.cwd &&
    foreground === file.foreground &&
    command === file.command
  ) {
    return file;
  }
  return {
    ...file,
    path,
    cwd,
    foreground,
    command,
  };
}

/** Status-bar chip copy: `vite`, or `vite · jest`, or `vite ×2`. */
export function runningTerminalChipLabel(processes: string[]): string {
  if (processes.length === 0) return "";
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const process of processes) {
    if (!counts.has(process)) order.push(process);
    counts.set(process, (counts.get(process) ?? 0) + 1);
  }
  return order
    .map((name) => {
      const n = counts.get(name) ?? 1;
      return n > 1 ? `${name} ×${n}` : name;
    })
    .join(" · ");
}

const OSC_CWD =
  /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g;

function decodeOscPath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Scan PTY output for OSC 7 cwd reports from shell integration. */
export function scanOscCwd(
  chunk: string,
  buffer: string,
): { cwd?: string; rest: string } {
  const merged = buffer + chunk;
  let cwd: string | undefined;
  let last = 0;
  for (const match of merged.matchAll(OSC_CWD)) {
    const index = match.index ?? 0;
    const path = decodeOscPath(match[1] ?? "");
    if (path) cwd = path;
    last = index + match[0].length;
  }
  const tail = merged.slice(last);
  const rest = tail.length > 256 ? tail.slice(-256) : tail;
  return { cwd, rest };
}
