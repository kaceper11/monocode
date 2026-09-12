import { useCallback, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { gitDiffFiles, subscribeGitChanged } from "../lib/fs";
import { isEqualOrInside, pathKey } from "../lib/paths";
import { loadRecents } from "../lib/recents";
import {
  getVerifiedFamilies,
  subscribeRepositoryFamilies,
  workingCopyName,
  type RepositoryFamily,
  type WorkingCopy,
} from "../lib/repositoryFamilies";
import {
  intersectWorkingCopies,
  sameCollisionMap,
  sessionLabel,
  workingCopyLive,
  type CollisionFile,
} from "../lib/worktreeCollisions";

/**
 * Shared worktree-collision cache. Tracking starts with the first consumer
 * and stops with the last; while active it reconciles verified repository
 * families on git-change notifications, family republishes and window focus —
 * never on a timer. Families are grouped into collision domains by repo
 * identity (root commit), so separate clones of one lineage count together;
 * a domain with fewer than two usable copies is skipped before any status
 * read, and only live copies (recent bound session or recent use) pay for
 * `git_diff_files`/`git_branch_changed_files` calls. Detection is read-only.
 */

type CopyState = {
  path: string;
  name: string;
  /** Member family (commonDir key) that contributed this copy. */
  member: string;
  /** Bound session titles for the badge detail. */
  sessions: string[];
  live: boolean;
  /** Changed relative paths; null until the first status read lands. */
  files: Set<string> | null;
  /** Paths committed on this branch ahead of the default-branch merge-base. */
  committed: Set<string>;
  dirty: boolean;
  inFlight: boolean;
  pending: boolean;
};

type DomainState = {
  key: string;
  /** Member families (commonDir key → family) sharing this repo identity. */
  members: Map<string, RepositoryFamily>;
  copies: Map<string, CopyState>;
  /** Last published pathKey(copy) → overlapping files. */
  result: Map<string, CollisionFile[]>;
  refreshing: boolean;
  refreshQueued: boolean;
};

const domains = new Map<string, DomainState>();
/** Aggregate of every tracked domain, keyed by working-copy pathKey. */
const published = new Map<string, CollisionFile[]>();
let version = 0;
const versionListeners = new Set<() => void>();
let consumers = 0;
let unsubscribeGit: (() => void) | null = null;
let unsubscribeFamilies: (() => void) | null = null;
let onResume: (() => void) | null = null;
let reconcileTimer = 0;

export function worktreeCollisionVersion(): number {
  return version;
}

/** Last published overlap for a working-copy path — never fetches. */
export function peekWorktreeCollision(
  path: string,
): readonly CollisionFile[] | null {
  const direct = published.get(pathKey(path));
  if (direct) return direct;
  // A session cwd can sit inside a copy's subdirectory.
  for (const [key, files] of published) {
    if (isEqualOrInside(path, key)) return files;
  }
  return null;
}

export function subscribeWorktreeCollisionVersion(listener: () => void) {
  versionListeners.add(listener);
  attach();
  return () => {
    versionListeners.delete(listener);
    release();
  };
}

function usableCopies(worktrees: readonly WorkingCopy[]): WorkingCopy[] {
  // Missing, locked and prunable copies cannot hold live work — skip quietly.
  return worktrees.filter(
    (copy) => !copy.missing && !copy.prunable && !copy.locked,
  );
}

/** Families sharing a root commit form one collision domain. */
function domainKey(family: RepositoryFamily): string {
  return family.identity ?? `dir:${pathKey(family.commonDir)}`;
}

function notify() {
  version += 1;
  for (const listener of versionListeners) listener();
}

function publishDomain(state: DomainState, next: Map<string, CollisionFile[]>) {
  if (sameCollisionMap(state.result, next)) return;
  for (const key of state.result.keys()) {
    if (!next.has(key)) published.delete(key);
  }
  for (const [key, files] of next) published.set(key, files);
  state.result = next;
  notify();
}

function dropDomain(state: DomainState) {
  domains.delete(state.key);
  if (!state.result.size) return;
  for (const key of state.result.keys()) published.delete(key);
  notify();
}

function recompute(state: DomainState) {
  const live = [...state.copies.values()].filter(
    (copy) => copy.live && copy.files !== null,
  );
  publishDomain(
    state,
    live.length >= 2
      ? intersectWorkingCopies(
          live.map((copy) => ({
            path: copy.path,
            name: copy.name,
            sessions: copy.sessions,
            files: copy.files!,
            committed: copy.committed,
          })),
        )
      : new Map(),
  );
}

async function fetchCopy(state: DomainState, copy: CopyState) {
  if (copy.inFlight) {
    copy.pending = true;
    return;
  }
  copy.inFlight = true;
  try {
    const [index, committed] = await Promise.all([
      gitDiffFiles(copy.path),
      invoke<string[]>("git_branch_changed_files", {
        cwd: copy.path,
      }).catch(() => null),
    ]);
    copy.files = new Set(index.files.map((file) => file.relative));
    // Keep the last known committed set on failure — it is evidence too.
    if (committed === null) copy.dirty = true;
    else copy.committed = new Set(committed);
  } catch {
    /* keep the last known list — a failed read must not clear real evidence;
       stay dirty so the next trigger retries */
    copy.dirty = true;
  } finally {
    copy.inFlight = false;
    if (domains.get(state.key) !== state) return;
    recompute(state);
    if (copy.pending) {
      copy.pending = false;
      if (copy.live) {
        copy.dirty = true;
        void fetchCopy(state, copy);
      }
    }
  }
}

function fetchDirty(state: DomainState) {
  // Stay quiet while hidden; the focus resume drains the dirty flags.
  if (typeof document !== "undefined" && document.hidden) return;
  for (const copy of state.copies.values()) {
    if (!copy.live || !copy.dirty) continue;
    copy.dirty = false;
    void fetchCopy(state, copy);
  }
}

/** Re-read one member's copy membership and session binding. */
async function refreshMember(
  state: DomainState,
  memberKey: string,
  family: RepositoryFamily,
  recents: ReturnType<typeof loadRecents>,
  now: number,
) {
  const member = usableCopies(family.worktrees)[0]?.path ?? family.checkout;
  let worktrees: readonly WorkingCopy[];
  try {
    // One `git worktree list` + indexed session lookups per member; the
    // per-copy `users`/`lastUsed` carry the session binding we flag on.
    worktrees = await invoke<WorkingCopy[]>("git_worktrees", { cwd: member });
  } catch {
    // The family's own inventory has no session binding — falling back to
    // it would flicker every bound copy to non-live. Keep the last state.
    return;
  }
  if (domains.get(state.key) !== state) return;
  const seen = new Set<string>();
  for (const copy of usableCopies(worktrees)) {
    const key = pathKey(copy.path);
    seen.add(key);
    const live = workingCopyLive(copy, recents, now);
    const existing = state.copies.get(key);
    if (existing) {
      existing.name = workingCopyName(copy, family);
      existing.member = memberKey;
      if (copy.users) existing.sessions = copy.users.map(sessionLabel);
      if (existing.live !== live) {
        existing.live = live;
        if (!live) existing.files = null;
        // Always refetch on relive — a fetch that landed while the copy
        // was non-live may be stale.
        else existing.dirty = true;
      }
    } else {
      state.copies.set(key, {
        path: copy.path,
        name: workingCopyName(copy, family),
        member: memberKey,
        sessions: (copy.users ?? []).map(sessionLabel),
        live,
        files: null,
        committed: new Set(),
        dirty: live,
        inFlight: false,
        pending: false,
      });
    }
  }
  for (const [key, copy] of [...state.copies]) {
    if (copy.member === memberKey && !seen.has(key)) state.copies.delete(key);
  }
}

/** Re-read copy membership and session binding, then refresh stale files. */
async function refreshStructure(state: DomainState) {
  if (state.refreshing) {
    state.refreshQueued = true;
    return;
  }
  state.refreshing = true;
  try {
    const recents = loadRecents();
    const now = Date.now();
    for (const [memberKey, family] of state.members) {
      await refreshMember(state, memberKey, family, recents, now);
      if (domains.get(state.key) !== state) return;
    }
    fetchDirty(state);
    recompute(state);
  } finally {
    state.refreshing = false;
    const queued = state.refreshQueued;
    state.refreshQueued = false;
    if (queued && domains.get(state.key) === state) {
      void refreshStructure(state);
    }
  }
}

/** Reconcile tracked domains against the verified family set. */
function reconcileAll() {
  const wanted = new Map<string, Map<string, RepositoryFamily>>();
  for (const family of getVerifiedFamilies().values()) {
    const key = domainKey(family);
    const members = wanted.get(key) ?? new Map();
    members.set(pathKey(family.commonDir), family);
    wanted.set(key, members);
  }
  // Zero cost until a domain actually holds two usable copies.
  for (const [key, members] of [...wanted]) {
    let usable = 0;
    for (const family of members.values()) {
      usable += usableCopies(family.worktrees).length;
    }
    if (usable < 2) wanted.delete(key);
  }
  for (const state of [...domains.values()]) {
    if (!wanted.has(state.key)) dropDomain(state);
  }
  for (const [key, members] of wanted) {
    let state = domains.get(key);
    if (!state) {
      state = {
        key,
        members: new Map(),
        copies: new Map(),
        result: new Map(),
        refreshing: false,
        refreshQueued: false,
      };
      domains.set(key, state);
    }
    let dropped = false;
    for (const memberKey of [...state.members.keys()]) {
      if (members.has(memberKey)) continue;
      dropped = true;
      state.members.delete(memberKey);
      for (const [copyKey, copy] of [...state.copies]) {
        if (copy.member === memberKey) state.copies.delete(copyKey);
      }
    }
    for (const [memberKey, family] of members) {
      state.members.set(memberKey, family);
    }
    // A removed member's copies must leave the published result even when
    // the surviving members' structure refresh fails.
    if (dropped) recompute(state);
    void refreshStructure(state);
  }
}

function scheduleReconcile() {
  window.clearTimeout(reconcileTimer);
  reconcileTimer = window.setTimeout(reconcileAll, 40);
}

function markDirty(copy: CopyState) {
  if (!copy.live) return;
  if (copy.inFlight) copy.pending = true;
  else copy.dirty = true;
}

function onGitChanged(changed?: string) {
  if (!changed) {
    for (const state of domains.values()) {
      for (const copy of state.copies.values()) markDirty(copy);
      fetchDirty(state);
    }
    return;
  }
  const family = getVerifiedFamilies().get(pathKey(changed));
  const state = family ? domains.get(domainKey(family)) : undefined;
  if (family && state) {
    let matched = false;
    let cold = false;
    for (const copy of state.copies.values()) {
      if (isEqualOrInside(changed, copy.path)) {
        matched = true;
        if (!copy.live) cold = true;
        markDirty(copy);
      }
    }
    if (matched) {
      // A change inside a cold copy often means a session just bound to it —
      // re-read bindings so liveness catches up without waiting for focus.
      if (cold) void refreshStructure(state);
      fetchDirty(state);
      return;
    }
    // A changed path inside the domain we do not track yet — e.g. a worktree
    // created mid-turn. Refresh structure only when it sits in a usable
    // member; a locked member's churn is not worth a `git worktree list`.
    if (
      usableCopies(family.worktrees).some((copy) =>
        isEqualOrInside(changed, copy.path),
      )
    ) {
      void refreshStructure(state);
    }
    return;
  }
  if (family) {
    // Not tracked — only reconcile when the domain could reach two usable
    // copies; otherwise a lone family's churn would re-read every domain.
    const key = domainKey(family);
    let usable = 0;
    for (const other of getVerifiedFamilies().values()) {
      if (domainKey(other) === key) {
        usable += usableCopies(other.worktrees).length;
      }
    }
    if (usable >= 2) scheduleReconcile();
    return;
  }
  // Not a verified member path; a session cwd can sit inside a copy.
  for (const state of domains.values()) {
    for (const copy of state.copies.values()) {
      if (isEqualOrInside(changed, copy.path)) {
        markDirty(copy);
        fetchDirty(state);
        return;
      }
    }
  }
}

function onFamiliesChanged() {
  scheduleReconcile();
}

function attach() {
  consumers += 1;
  if (consumers !== 1) return;
  unsubscribeGit = subscribeGitChanged(onGitChanged);
  unsubscribeFamilies = subscribeRepositoryFamilies(onFamiliesChanged);
  onResume = () => {
    if (typeof document === "undefined" || document.hidden) return;
    // A revert or commit outside the app fires no event — re-read live
    // copies on focus the same way useGitFileStatuses does.
    for (const state of domains.values()) {
      for (const copy of state.copies.values()) markDirty(copy);
      fetchDirty(state);
    }
    scheduleReconcile();
  };
  window.addEventListener("focus", onResume);
  document.addEventListener("visibilitychange", onResume);
  reconcileAll();
}

function release() {
  consumers = Math.max(0, consumers - 1);
  if (consumers !== 0) return;
  unsubscribeGit?.();
  unsubscribeFamilies?.();
  if (onResume) {
    window.removeEventListener("focus", onResume);
    document.removeEventListener("visibilitychange", onResume);
  }
  unsubscribeGit = null;
  unsubscribeFamilies = null;
  onResume = null;
  window.clearTimeout(reconcileTimer);
  domains.clear();
  published.clear();
}

/** Overlapping files for one working-copy path, or null when none. */
export function useWorktreeCollision(
  path: string | undefined | null,
): readonly CollisionFile[] | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeWorktreeCollisionVersion(listener),
    [],
  );
  const getSnapshot = useCallback(
    () => (path ? peekWorktreeCollision(path) : null),
    [path],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
