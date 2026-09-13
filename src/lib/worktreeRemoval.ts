import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "./paths";
import { forgetRemovedWorktree, type RecentProject } from "./recents";
import {
  lastWorkingCopyUse,
  setWorkingCopyHidden,
  workingCopyName,
  type RepositoryFamily,
  type WorkingCopy,
} from "./repositoryFamilies";

/**
 * An app-owned process bound to a worktree, reported by the backend at
 * preflight time. `kind` is `agent` or `terminal` today; saved-command runs
 * join with their own kind once the command host reports its cwd.
 */
export type BoundProcess = {
  kind: string;
  id: string;
  cwd: string;
  label: string;
};

export type RemovalEntry = WorkingCopy & { users: string[] };

/** Fresh on-demand evidence for one worktree — `git_worktree_safety`.
 * Never polled; removal re-derives its own checks. */
export type WorktreeSafety = {
  /** Execution host of the repository family: `macos`/`windows`/`linux` or
   * `wsl:<distribution>`. */
  host: string;
  /** Fresh inventory entry for the reviewed target. */
  entry: RemovalEntry;
  dirty: boolean;
  /** Agents and terminals bound to the target checkout. */
  processes: BoundProcess[];
  /** Usable alternative checkouts, inventory order. */
  siblings: RemovalEntry[];
};

/**
 * Ordered switch targets for removing `target` while it is selected:
 * healthy sibling checkouts by most recent recorded use, then the
 * accessible main checkout. The target itself, missing checkouts and
 * prunable registrations can never receive the active context; locked and
 * detached-HEAD checkouts stay eligible — locks block removal, not use.
 */
export function removalFallbacks(
  target: string,
  candidates: RemovalEntry[],
  recents: RecentProject[],
): RemovalEntry[] {
  const usable = candidates.filter(
    (entry) =>
      pathKey(entry.path) !== pathKey(target) &&
      !entry.missing &&
      !entry.prunable,
  );
  const siblings = usable
    .filter((entry) => !entry.main)
    .sort(
      (a, b) =>
        (lastWorkingCopyUse(b, recents) ?? 0) -
          (lastWorkingCopyUse(a, recents) ?? 0) ||
        a.path.localeCompare(b.path),
    );
  return [...siblings, ...usable.filter((entry) => entry.main)];
}

/** One skipped bulk-removal row: the entry and why it cannot join a batch
 * delete. `safety` is absent when the preflight itself failed. */
export type BulkSkip = {
  entry: RemovalEntry;
  reason: string;
  safety?: WorktreeSafety;
};

/**
 * Partitions fresh `git_worktree_safety` results into removable entries and
 * per-entry skip reasons. Bulk removal only ever takes clean, unprotected
 * checkouts — dirty, process-bound, locked, detached, missing or main
 * entries stay behind for individual review (force removal and
 * stopProcesses keep their one-at-a-time flows).
 */
export function bulkRemovalPlan(safeties: readonly WorktreeSafety[]): {
  removable: WorktreeSafety[];
  skipped: BulkSkip[];
} {
  const removable: WorktreeSafety[] = [];
  const skipped: BulkSkip[] = [];
  for (const safety of safeties) {
    const entry = safety.entry;
    const reason = entry.main
      ? "The main checkout is protected"
      : entry.missing
        ? "Folder is missing — restore or repair it"
        : entry.prunable
          ? "Stale registration — repair from a surviving checkout"
          : entry.locked
            ? `Locked: ${entry.locked}`
            : !entry.branch
              ? "Detached HEAD"
              : safety.processes.length
                ? `${safety.processes.length} ${
                    safety.processes.length === 1 ? "process" : "processes"
                  } running — review to stop them`
                : safety.dirty
                  ? "Uncommitted, untracked or ignored files"
                  : null;
    if (reason) skipped.push({ entry, reason, safety });
    else removable.push(safety);
  }
  return { removable, skipped };
}

/** Short name for a switch destination: branch name, `main`, or basename. */
export function removalFallbackLabel(
  entry: WorkingCopy,
  family?: RepositoryFamily,
): string {
  if (family) return workingCopyName(entry, family);
  return (
    entry.branch?.replace(/^refs\/(heads|remotes)\//, "") ??
    (entry.main
      ? "main"
      : (entry.path.split("/").filter(Boolean).pop() ?? entry.path))
  );
}

/**
 * Focus the session/terminal behind a bound-process row. App owns the
 * lookup; deep UI dispatches instead of threading a callback through the
 * rail. Mirrors the existing open-session event pattern.
 */
export const OPEN_BOUND_PROCESS = "monocode:open-bound-process";

export function openBoundProcess(process: BoundProcess) {
  window.dispatchEvent(
    new CustomEvent(OPEN_BOUND_PROCESS, { detail: process }),
  );
}

/** Opens the worktree manager for the family containing `cwd`, optionally
 * focused on one checkout's detail (`path`), pre-checked into select mode
 * (`select`), or straight into the reviewed removal confirmation
 * (`action: "remove"`, requires `path`). */
export const OPEN_WORKTREE_MANAGER = "monocode:open-worktree-manager";

export type WorktreeManagerRequest = {
  cwd: string;
  path?: string;
  select?: string[];
  action?: "remove";
};

export function openWorktreeManager(request: WorktreeManagerRequest) {
  window.dispatchEvent(
    new CustomEvent(OPEN_WORKTREE_MANAGER, { detail: request }),
  );
}

/**
 * Fresh `git_worktree_safety` per target — the batch version of the
 * single-removal preflight. A target that changed state or left the
 * inventory fails into the review list instead of aborting the batch.
 * `contextFor` resolves each target to a path inside its repository family.
 */
export async function preflightWorktrees(
  targets: readonly RemovalEntry[],
  contextFor: (path: string) => string,
): Promise<{
  results: { target: RemovalEntry; safety: WorktreeSafety }[];
  failed: BulkSkip[];
}> {
  const results: { target: RemovalEntry; safety: WorktreeSafety }[] = [];
  const failed: BulkSkip[] = [];
  for (const target of targets) {
    try {
      results.push({
        target,
        safety: await invoke<WorktreeSafety>("git_worktree_safety", {
          cwd: contextFor(target.path),
          path: target.path,
        }),
      });
    } catch (error) {
      failed.push({ entry: target, reason: String(error) });
    }
  }
  return { results, failed };
}

/**
 * Sequential `git_worktree_remove` over an already-reviewed plan — never
 * force, never stopping processes. `contextFor` must return a surviving
 * family member (a removed target can never host the next call);
 * `fallbackFor` resolves the rail/bookkeeping replacement per removed path
 * and receives the full removed set to compute survivors from.
 * Callers notify Git changes for each context they passed.
 */
export async function executeWorktreeRemovals(input: {
  removable: readonly WorktreeSafety[];
  contextFor: (path: string) => string;
  fallbackFor: (path: string, removed: readonly string[]) => string;
}): Promise<{
  removed: string[];
  failures: { entry: RemovalEntry; message: string }[];
}> {
  const removed: string[] = [];
  const failures: { entry: RemovalEntry; message: string }[] = [];
  for (const safety of input.removable) {
    try {
      await invoke("git_worktree_remove", {
        cwd: input.contextFor(safety.entry.path),
        path: safety.entry.path,
        head: safety.entry.head,
        reviewed: null,
        stopProcesses: null,
      });
      removed.push(safety.entry.path);
    } catch (error) {
      failures.push({ entry: safety.entry, message: String(error) });
    }
  }
  for (const path of removed) {
    try {
      forgetRemovedWorktree(path, input.fallbackFor(path, removed));
      setWorkingCopyHidden(path, false);
    } catch {
      // Bookkeeping is best-effort (localStorage quota) — a throw here
      // must not strand a finished batch in its "removing" phase.
    }
  }
  return { removed, failures };
}
