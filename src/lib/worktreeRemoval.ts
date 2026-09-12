import { pathKey } from "./paths";
import type { RecentProject } from "./recents";
import {
  lastWorkingCopyUse,
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
