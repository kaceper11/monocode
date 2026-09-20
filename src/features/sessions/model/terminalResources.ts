import { invoke } from "@tauri-apps/api/core";
import type { FilePaneTab, WorkspaceTab } from "../../workspace/model/layout.ts";
import type { ProjectTerminalDock } from "../../projects/model/projectTerminal.ts";
import { sameProjectPath } from "../../projects/model/recents.ts";
import { terminalTabLabel } from "../../terminal/model/terminalTab.ts";
import {
  savedCommandRunsSnapshot,
  stopSavedCommandRun,
} from "./savedCommandRun";

export type FooterTerminal = {
  id: string;
  title: string;
  cwd: string;
  foreground: string | null;
  paneId?: string;
};
export type PtyResource = {
  id: string;
  generation: string | null;
  alive: boolean;
  host: "native" | "wsl";
  distro: string | null;
  cpuPct: number | null;
  rssBytes: number | null;
  processes: number | null;
  workload: boolean;
  top: string | null;
  error: string | null;
};

/** Current project dock and reachable workspace terminals. Other project docks
 * remain under their original project navigation and close ownership. */
export function footerTerminals(
  docks: ProjectTerminalDock[],
  tabs: WorkspaceTab[],
  projectPath: string,
): FooterTerminal[] {
  const result = new Map<string, FooterTerminal>();
  const add = (file: FilePaneTab, paneId?: string) => {
    if (file.terminal && !result.has(file.id))
      result.set(file.id, {
        id: file.id,
        title: terminalTabLabel(file),
        cwd: file.cwd,
        foreground: file.foreground ?? null,
        paneId,
      });
  };
  for (const dock of docks)
    if (sameProjectPath(dock.projectPath, projectPath))
      for (const file of dock.pane.files) add(file);
  for (const tab of tabs)
    for (const pane of tab.terminalPanes ?? [])
      for (const file of pane.files) add(file, pane.id);
  return [...result.values()];
}

// Shared by mounts in this window: reopening/changing scope must not overlap
// a prior native sample. Closed/hidden waiters never dispatch a queued request.
let pending: Promise<unknown> | null = null;
export async function sampleTerminalResources(
  ids: string[],
  active: () => boolean,
): Promise<PtyResource[] | null> {
  while (pending) await pending.catch(() => undefined);
  if (!active()) return null;
  const request = invoke<PtyResource[]>("pty_resources", { ids });
  pending = request;
  try {
    return await request;
  } finally {
    if (pending === request) pending = null;
  }
}

export async function stopTerminalWorkload(
  row: Pick<PtyResource, "id" | "generation">,
  active: () => boolean,
): Promise<void> {
  const run = savedCommandRunsSnapshot().find(
    (run) =>
      run.terminalId === row.id &&
      (run.status === "queued" || run.status === "running"),
  );
  while (pending) await pending.catch(() => undefined);
  if (!active()) return;
  // Cancelling just one PTY step would allow a successful exit to advance the
  // saved sequence. Its existing owner must cancel the entire run instead.
  const operation = run
    ? stopSavedCommandRun(row.id)
    : row.generation
      ? invoke<void>("pty_kill_workload", {
          id: row.id,
          generation: row.generation,
        })
      : Promise.reject(
          new Error(
            "Terminal identity is unavailable; refresh before stopping.",
          ),
        );
  pending = operation;
  try {
    await operation;
  } finally {
    if (pending === operation) pending = null;
  }
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
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
