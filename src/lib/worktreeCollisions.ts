import { pathKey } from "./paths";
import type { RecentProject } from "./recents";
import {
  lastWorkingCopyUse,
  type WorkingCopy,
} from "./repositoryFamilies";

/**
 * A working copy counts as live while work in it is recent: a bound session
 * reported by `git_worktrees` (`lastUsed`, the newest session `updated_at`)
 * or a recent open in this window. `users` lists every session ever bound —
 * bindings are never cleared — so it feeds peer labels only, never liveness.
 * Colder copies never get a status read.
 */
export const COLLISION_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export type CollisionPeer = {
  /** Sibling working copy path. */
  path: string;
  /** Working copy display name (branch or folder). */
  name: string;
  /** Bound session titles, most recently active first. */
  sessions: string[];
  /**
   * The peer's change is already committed on their branch (not present in
   * their working tree) — the overlap survives even if their diff looks clean.
   */
  committed?: boolean;
};

export type CollisionFile = {
  /** Repository-relative path changed in more than one live copy. */
  relative: string;
  peers: CollisionPeer[];
};

/** One live working copy with its changed relative paths. */
export type CollisionCopy = {
  path: string;
  name: string;
  sessions: readonly string[];
  /** Uncommitted (working-tree) relative paths. */
  files: ReadonlySet<string>;
  /** Committed on this branch since the merge-base with the default branch. */
  committed: ReadonlySet<string>;
};

export function workingCopyLive(
  copy: WorkingCopy,
  recents: RecentProject[],
  now = Date.now(),
): boolean {
  const used = lastWorkingCopyUse(copy, recents);
  return used !== null && now - used <= COLLISION_RECENT_MS;
}

/** `users` entries arrive as "title (session-id)" — show only the title. */
export function sessionLabel(user: string): string {
  return user.replace(
    /\s\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/i,
    "",
  );
}

/**
 * Path-level overlap between live copies of one repository family. Each
 * affected copy maps to its shared files; every file lists the sibling copies
 * (name + bound session titles) that also changed it. A shared path is a hint
 * to look, not a merge prediction.
 */
export function intersectWorkingCopies(
  copies: readonly CollisionCopy[],
): Map<string, CollisionFile[]> {
  const owners = new Map<string, CollisionCopy[]>();
  for (const copy of copies) {
    for (const relative of new Set([...copy.files, ...copy.committed])) {
      const list = owners.get(relative);
      if (list) list.push(copy);
      else owners.set(relative, [copy]);
    }
  }
  const result = new Map<string, CollisionFile[]>();
  for (const [relative, changed] of owners) {
    if (changed.length < 2) continue;
    for (const copy of changed) {
      const key = pathKey(copy.path);
      const peers = changed
        .filter((other) => pathKey(other.path) !== key)
        .map((other) => ({
          path: other.path,
          name: other.name,
          sessions: [...other.sessions],
          // Committed-only on the peer's side — their working tree looks clean.
          committed: !other.files.has(relative) || undefined,
        }))
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
        );
      if (!peers.length) continue;
      const files = result.get(key) ?? [];
      files.push({ relative, peers });
      result.set(key, files);
    }
  }
  for (const files of result.values()) {
    files.sort((a, b) => a.relative.localeCompare(b.relative));
  }
  return result;
}

/** Accessible badge text — the count and sibling names, never color-only. */
export function collisionLabel(files: readonly CollisionFile[]): string {
  const names = [
    ...new Set(files.flatMap((file) => file.peers.map((peer) => peer.name))),
  ];
  const count = files.length;
  const where = names.length ? ` in ${names.join(", ")}` : "";
  return `${count} ${count === 1 ? "file" : "files"} also changed${where}`;
}

export function sameCollisionMap(
  a: ReadonlyMap<string, readonly CollisionFile[]>,
  b: ReadonlyMap<string, readonly CollisionFile[]>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, files] of a) {
    const other = b.get(key);
    if (!other || files.length !== other.length) return false;
    for (let i = 0; i < files.length; i += 1) {
      const left = files[i];
      const right = other[i];
      if (
        left.relative !== right.relative ||
        left.peers.length !== right.peers.length ||
        left.peers.some(
          (peer, j) =>
            peer.path !== right.peers[j].path ||
            peer.name !== right.peers[j].name ||
            peer.sessions.length !== right.peers[j].sessions.length ||
            peer.sessions.some(
              (session, k) => session !== right.peers[j].sessions[k],
            ),
        )
      ) {
        return false;
      }
    }
  }
  return true;
}
