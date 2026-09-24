import { useCallback, useSyncExternalStore } from "react";
import { gitBranches, subscribeGitChanged, type GitBranches } from "../../../platform/tauri/fs";

export type ProjectBranchesState = {
  branches: GitBranches | null;
  /** First lookup for this cwd has finished, repo or not. */
  settled: boolean;
};

const PENDING: ProjectBranchesState = { branches: null, settled: false };

type Entry = {
  cwd: string;
  state: ProjectBranchesState;
  listeners: Set<() => void>;
  inFlight: boolean;
  invalidated: boolean;
  unsubscribeGit: (() => void) | null;
  onResume: (() => void) | null;
};

const entries = new Map<string, Entry>();

function branchesEqual(a: GitBranches | null, b: GitBranches | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.current !== b.current ||
    a.detached !== b.detached ||
    a.branches.length !== b.branches.length
  ) {
    return false;
  }
  return a.branches.every((branch, index) => {
    const other = b.branches[index];
    return (
      other != null &&
      branch.name === other.name &&
      branch.current === other.current &&
      branch.remote === other.remote
    );
  });
}

function entryFor(cwd: string): Entry {
  const existing = entries.get(cwd);
  if (existing) return existing;
  const entry: Entry = {
    cwd,
    state: PENDING,
    listeners: new Set(),
    inFlight: false,
    invalidated: false,
    unsubscribeGit: null,
    onResume: null,
  };
  entries.set(cwd, entry);
  return entry;
}

function publish(entry: Entry, branches: GitBranches | null) {
  // `settled` still has to flip on a lookup that found nothing, so an
  // unchanged `null` is only a no-op once the first one has landed.
  if (entry.state.settled && branchesEqual(entry.state.branches, branches)) {
    return;
  }
  entry.state = { branches, settled: true };
  for (const listener of entry.listeners) listener();
}

async function load(entry: Entry, force = false) {
  if (entry.inFlight) { entry.invalidated ||= force; return; }
  if (!force && document.hidden) return;
  entry.inFlight = true;
  try {
    publish(entry, await gitBranches(entry.cwd));
  } catch {
    publish(entry, null);
  } finally {
    entry.inFlight = false;
    if (entry.invalidated) { entry.invalidated = false; void load(entry, true); }
  }
}

function start(entry: Entry) {
  if (entry.onResume) return;
  void load(entry, true);
  entry.onResume = () => {
    if (!document.hidden) void load(entry, true);
  };
  window.addEventListener("focus", entry.onResume);
  document.addEventListener("visibilitychange", entry.onResume);
  entry.unsubscribeGit = subscribeGitChanged(entry.onResume);
}

function stop(entry: Entry) {
  if (entry.onResume) {
    window.removeEventListener("focus", entry.onResume);
    document.removeEventListener("visibilitychange", entry.onResume);
  }
  entry.unsubscribeGit?.();
  entry.onResume = null;
  entry.unsubscribeGit = null;
}

/** Branch list plus whether git has answered yet, for callers that must not
 *  confuse "still looking" with "not a repo". */
export function useProjectBranchesState(
  cwd: string,
  enabled: boolean,
): ProjectBranchesState {
  const active = enabled && Boolean(cwd) && cwd !== "~";
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!active) return () => undefined;
      const entry = entryFor(cwd);
      entry.listeners.add(listener);
      if (entry.listeners.size === 1) start(entry);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) stop(entry);
      };
    },
    [active, cwd],
  );
  const getSnapshot = useCallback(() => {
    return active ? entryFor(cwd).state : PENDING;
  }, [active, cwd]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useProjectBranches(
  cwd: string,
  enabled: boolean,
): GitBranches | null {
  return useProjectBranchesState(cwd, enabled).branches;
}

/** Cached branch list without subscribing — for submit-time checks inside
 * event handlers (e.g. "is this typed name an existing local branch?"). */
export function peekProjectBranches(cwd: string): GitBranches | null {
  return entries.get(cwd)?.state.branches ?? null;
}

/** Select options for the repo's LOCAL branches only — adoptable targets.
 * Remote-qualified names would create a new local branch instead. */
export function localBranchOptions(
  branches: GitBranches | null,
): { value: string; label: string }[] {
  return (branches?.branches ?? [])
    .filter((branch) => !branch.remote)
    .map((branch) => ({ value: branch.name, label: branch.name }));
}

/** Remote choices retain their fully qualified ref so remotes never collide. */
export function taskBranchOptions(branches: GitBranches | null, claimed: ReadonlySet<string> = new Set()) {
  const locals = new Set((branches?.branches ?? []).filter(b => !b.remote).map(b => b.name));
  return (branches?.branches ?? []).map(branch => ({
    value: branch.remote ? `refs/remotes/${branch.remote}/${branch.name}` : branch.name,
    label: `${branch.remote ? `${branch.remote}/` : ""}${branch.name}${claimed.has(branch.name) ? " — used by another task" : branch.remote && locals.has(branch.name) ? " — local branch exists; select it to update" : ""}`,
    disabled: claimed.has(branch.name) || !!branch.remote && locals.has(branch.name),
  }));
}
export function taskBranchChoice(value: string): { branch: string; base?: string } {
  if (value.startsWith("refs/remotes/")) return { branch: value.split("/").slice(3).join("/"), base: value };
  return { branch: value };
}
