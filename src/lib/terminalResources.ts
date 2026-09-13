import type { FilePaneTab, WorkspaceTab } from "./layout";
import type { ProjectTerminalDock } from "./projectTerminal";
import type { PtyResource } from "./pty";
import { sameProjectPath } from "./recents";
import { terminalTabLabel } from "./terminalTab";

/** One row in the terminal manager — a tab plus its live process stats. */
export type TerminalRow = {
  id: string;
  title: string;
  cwd: string;
  foreground: string | null;
  /** A live PTY exists; exited tabs stay listed but can't be killed. */
  alive: boolean;
  workload: boolean;
  cpuPct: number | null;
  rssBytes: number | null;
  processes: number;
  top: string | null;
  host: "native" | "wsl";
  distro: string | null;
};

/** The chip's light row model before stats arrive — one per terminal tab. */
export type FooterTerminal = {
  id: string;
  title: string;
  cwd: string;
  foreground: string | null;
};

/** Terminal tabs reachable from the current view: the project's dock plus
 * every workspace pane. Docks of other projects stay out — navigating to
 * them would open a dock the current project doesn't show. */
export function footerTerminals(
  docks: ProjectTerminalDock[],
  tabs: WorkspaceTab[],
  projectPath: string | null,
): FooterTerminal[] {
  const files: FilePaneTab[] = [];
  if (projectPath) {
    for (const dock of docks) {
      if (sameProjectPath(dock.projectPath, projectPath)) {
        files.push(...dock.pane.files);
      }
    }
  }
  for (const tab of tabs) {
    for (const pane of tab.terminalPanes ?? []) {
      files.push(...pane.files);
    }
  }
  const terminals: FooterTerminal[] = [];
  for (const file of files) {
    if (!file.terminal) continue;
    terminals.push({
      id: file.id,
      title: terminalTabLabel(file),
      cwd: file.cwd,
      foreground: file.foreground ?? null,
    });
  }
  return terminals;
}

/** `resources` is null until the first sample lands — rows read as
 * alive with unknown stats instead of flashing "exited" on open. */
export function mergeTerminalRows(
  terminals: FooterTerminal[],
  resources: PtyResource[] | null,
): TerminalRow[] {
  const byId = new Map((resources ?? []).map((entry) => [entry.id, entry]));
  return terminals.map((terminal) => {
    const stat = byId.get(terminal.id);
    return {
      id: terminal.id,
      title: terminal.title,
      cwd: terminal.cwd,
      foreground: terminal.foreground,
      alive: resources === null ? true : !!stat,
      workload: stat?.workload ?? false,
      cpuPct: stat?.cpuPct ?? null,
      rssBytes: stat?.rssBytes ?? null,
      processes: stat?.processes ?? 0,
      top: stat?.top ?? null,
      host: stat?.host ?? "native",
      distro: stat?.distro ?? null,
    };
  });
}

export function formatCpu(pct: number | null): string {
  if (pct == null) return "—";
  if (pct < 0.05) return "0%";
  if (pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

export function formatMem(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
