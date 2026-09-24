import { useState, useSyncExternalStore, type ReactNode } from "react";
import { gitRefreshBranches, gitTaskBranch } from "../../platform/tauri/fs";
import { pathKey, projectName } from "../../shared/lib/paths";
import { loadBoard } from "./boardStore";
import { TaskActionFeedback } from "./TaskActionFeedback";
import { Download, LoaderCircle, MoreHorizontal, RefreshCw } from "../../shared/ui/icons";

import { Popover } from "../../shared/ui/Popover";
import { LAYER } from "../../shared/lib/layers";

type Target = { id?: string; projectPath: string; worktreePath?: string; branch: string; base: string; blocked?: boolean };
const pending = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
const publish = () => { revision++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useTaskGitBusy(paths: readonly string[]): boolean {
  useSyncExternalStore(subscribe, () => revision);
  return paths.some(path => pending.has(pathKey(path)));
}

/** The same guarded Git operations for draft rows, saved lanes and bulk actions. */
export function TaskGitActions({ targets, all = false, disabled = false, onDone, children, layer = LAYER.popover }: {
  children?: ReactNode; targets: readonly Target[]; all?: boolean; disabled?: boolean; onDone?: () => void; layer?: number;
}) {
  const gitBusy = useTaskGitBusy(targets.map(target => target.projectPath));
  const [results, setResults] = useState<{ name: string; error?: string; message: string }[]>([]);
  const [running, setRunning] = useState("");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const busy = !!running || gitBusy;
  const run = async (action: "fetch" | "pull") => {
    if (busy || disabled) return;
    setAnchor(null);
    const unique = [...new Map(targets.filter(t => t.projectPath).map(t => [
      pathKey(action === "fetch" ? t.projectPath : t.worktreePath || t.projectPath), t,
    ])).values()];
    const keys = unique.map(t => pathKey(t.projectPath));
    if (keys.some(key => pending.has(key))) return;
    keys.forEach(key => pending.add(key)); publish();
    setRunning(action); setResults([]);
    try {
      for (const target of unique) {
        const name = projectName(target.projectPath);
        try {
          if (action === "fetch") await gitRefreshBranches(target.projectPath);
          else {
            if (target.id) {
              const current = loadBoard().tasks.flatMap(task => task.workstreams).find(row => row.id === target.id);
              if (!current || current.branch !== target.branch || current.worktreePath !== target.worktreePath || current.projectPath !== target.projectPath)
                throw new Error("Working copy binding changed. Refresh before retrying.");
            }
            if (!target.worktreePath) throw new Error("Select an existing working copy first");
            if (target.blocked) throw new Error("Agent is working in this task or working copy");
            await gitTaskBranch(target.worktreePath, target.branch, target.branch, target.base, "update");
          }
          setResults(rows => [...rows, { name, message: action === "fetch" ? "Fetch completed" : "Pull completed" }]);
        } catch (error) {
          setResults(rows => [...rows, { name, message: action === "fetch" ? "Fetch failed" : "Pull failed", error: String(error) }]);
        }
      }
      onDone?.();
    } finally {
      keys.forEach(key => pending.delete(key)); publish(); setRunning("");
    }
  };
  const label = all ? "Actions for all repositories" : `Git actions for ${projectName(targets[0]?.projectPath ?? "repository")}`;
  const buttonClass = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-content/75 hover:bg-content/6 focus-visible:outline-accent disabled:opacity-35";
  return <div className="w-full min-w-0 text-[11px]">
    <div className="flex items-center gap-1.5">
      {children}
      <span className="flex-1" />
      {running && <span role="status" className="text-content/45">{running === "fetch" ? "Fetching…" : "Pulling…"}</span>}
      <button type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={!!anchor} disabled={disabled || busy || !targets.some(t => t.projectPath)} onClick={event => setAnchor(anchor ? null : event.currentTarget)} className="grid size-7 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/6 hover:text-content focus-visible:outline-accent disabled:opacity-35">
        {running ? <LoaderCircle className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-4" />}
      </button>
    </div>
    {anchor && <Popover anchor={anchor} align="end" width={192} layer={layer} role="menu" aria-label={label} onDismiss={() => setAnchor(null)} className="bg-background-base p-1">
      <button type="button" role="menuitem" title="Fetch remote branches without changing your working copy" className={buttonClass} disabled={disabled || busy} onClick={() => void run("fetch")}><RefreshCw className="size-3.5 shrink-0" />{all ? "Fetch all" : "Fetch"}</button>
      <button type="button" role="menuitem" title="Pull from the tracked upstream · fast-forward only" className={buttonClass} disabled={disabled || busy || !targets.some(t => t.worktreePath && !t.blocked)} onClick={() => void run("pull")}><Download className="size-3.5 shrink-0" />{all ? "Pull all" : "Pull"}</button>
      <p className="px-2 pb-1 pt-0.5 text-[10px] text-content/35">Pull uses fast-forward only</p>
    </Popover>}
    {results.map((result, index) => <TaskActionFeedback key={index}
      title={`${result.name}: ${result.message}`} message={result.error}
      error={!!result.error} onDismiss={() => setResults(rows => rows.filter((_, i) => i !== index))} />)}
  </div>;
}
