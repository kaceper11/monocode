import { describe, expect, it } from "vitest";
import {
  STALE_WORKTREE_AGE,
  worktreeCleanupAttention,
} from "./attentionSources";
import type { RecentProject } from "./recents";
import type { RepositoryFamily, WorkingCopy } from "./repositoryFamilies";

const NOW = 100 * 86_400_000;

const copy = (path: string, over: Partial<WorkingCopy> = {}): WorkingCopy => ({
  path,
  head: "head",
  branch: `refs/heads/${path.split("/").pop()}`,
  main: false,
  missing: false,
  locked: null,
  prunable: null,
  ...over,
});

const family = (...worktrees: WorkingCopy[]): RepositoryFamily => ({
  commonDir: "/repo/.git",
  checkout: "/repo",
  worktrees,
});

const recents = (...paths: [string, number][]): RecentProject[] =>
  paths.map(([path, openedAt]) => ({ path, openedAt }));

const staleCopy = (path: string) =>
  copy(path, { lastUsed: NOW - STALE_WORKTREE_AGE - 86_400_000 });

describe("worktreeCleanupAttention", () => {
  it("emits one row per family for copies past the stale age", () => {
    const rows = worktreeCleanupAttention({
      families: new Map([
        ["/repo", family(copy("/repo", { main: true }), staleCopy("/repo/wt-a"))],
      ]),
      recents: [],
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("worktree");
    expect(rows[0].key).toBe("worktree-stale:/repo/.git");
    expect(rows[0].title).toBe("repo · 1 stale working copy");
    expect(rows[0].action).toEqual({
      kind: "open-worktrees",
      cwd: "/repo",
      paths: ["/repo/wt-a"],
    });
    expect(rows[0].cwd).toBe("/repo");
  });

  it("flags missing and prunable copies regardless of age", () => {
    const rows = worktreeCleanupAttention({
      families: new Map([
        [
          "/repo",
          family(
            copy("/repo", { main: true }),
            copy("/repo/wt-missing", { missing: true }),
            copy("/repo/wt-prunable", { prunable: "gone" }),
          ),
        ],
      ]),
      recents: [],
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("2 stale");
    expect(rows[0].detail).toContain("2 missing or stale on disk");
    // Missing/prunable paths ride the action too — they land in the
    // manager's review list, never in a batch.
    expect(rows[0].action).toMatchObject({
      paths: ["/repo/wt-missing", "/repo/wt-prunable"],
    });
  });

  it("never treats unknown activity as stale", () => {
    const rows = worktreeCleanupAttention({
      families: new Map([
        [
          "/repo",
          family(
            copy("/repo", { main: true }),
            copy("/repo/wt-fresh"),
            copy("/repo/wt-recent", { lastUsed: NOW - 86_400_000 }),
          ),
        ],
      ]),
      recents: [],
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("picks up staleness from recent-project opens too", () => {
    const rows = worktreeCleanupAttention({
      families: new Map([
        ["/repo", family(copy("/repo", { main: true }), copy("/repo/wt-a"))],
      ]),
      recents: recents(["/repo/wt-a", NOW - STALE_WORKTREE_AGE - 1]),
      now: NOW,
    });
    expect(rows).toHaveLength(1);
  });

  it("excludes hidden, locked, main and the currently open copy", () => {
    const rows = worktreeCleanupAttention({
      families: new Map([
        [
          "/repo",
          family(
            copy("/repo", { main: true }),
            staleCopy("/repo/wt-hidden"),
            staleCopy("/repo/wt-open"),
          ),
        ],
      ]),
      recents: [],
      hidden: ["/repo/wt-hidden"],
      currentCwd: "/repo/wt-open",
      now: NOW,
    });
    expect(rows).toEqual([]);
    // Locked copies are never stale — they already block removal.
    const locked = family(
      copy("/repo", { main: true }),
      copy("/repo/wt-locked", {
        locked: "x",
        lastUsed: NOW - STALE_WORKTREE_AGE * 2,
      }),
    );
    expect(
      worktreeCleanupAttention({
        families: new Map([["/repo", locked]]),
        recents: [],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("dedupes families reachable through several map keys", () => {
    const shared = family(copy("/repo", { main: true }), staleCopy("/repo/wt-a"));
    const rows = worktreeCleanupAttention({
      families: new Map([
        ["/repo", shared],
        ["/repo/wt-a", shared],
      ]),
      recents: [],
      now: NOW,
    });
    expect(rows).toHaveLength(1);
  });

  it("dedupes distinct probe objects sharing one common dir", () => {
    // Alias keys publish a separate RepositoryFamily for the same commonDir.
    const rows = worktreeCleanupAttention({
      families: new Map([
        ["/repo", family(copy("/repo", { main: true }), staleCopy("/repo/wt-a"))],
        [
          "/repo/wt-a/sub",
          {
            ...family(copy("/repo", { main: true }), staleCopy("/repo/wt-a")),
          },
        ],
      ]),
      recents: [],
      now: NOW,
    });
    expect(rows).toHaveLength(1);
  });

  it("folds session activity into staleness", () => {
    // Family inventory lacks session joins until the worktree panel joins
    // them — a copy stale by recents but with a live session stays quiet.
    const rows = worktreeCleanupAttention({
      families: new Map([
        ["/repo", family(copy("/repo", { main: true }), staleCopy("/repo/wt-a"))],
      ]),
      recents: [],
      sessionActivity: new Map([["/repo/wt-a", NOW - 60_000]]),
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("excludes the worktree containing the current cwd, not just an exact match", () => {
    const rows = worktreeCleanupAttention({
      families: new Map([
        ["/repo", family(copy("/repo", { main: true }), staleCopy("/repo/wt-a"))],
      ]),
      recents: [],
      currentCwd: "/repo/wt-a/src/nested",
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("keeps a stable signature until the stale set changes", () => {
    const input = () => ({
      families: new Map([
        ["/repo", family(copy("/repo", { main: true }), staleCopy("/repo/wt-a"))],
      ]),
      recents: [] as RecentProject[],
      now: NOW,
    });
    const first = worktreeCleanupAttention(input())[0];
    const again = worktreeCleanupAttention(input())[0];
    expect(again.signature).toBe(first.signature);
    expect(again.key).toBe(first.key);
    // Adding a second stale copy changes the signature — muted rows resurface.
    const changed = worktreeCleanupAttention({
      ...input(),
      families: new Map([
        [
          "/repo",
          family(
            copy("/repo", { main: true }),
            staleCopy("/repo/wt-a"),
            staleCopy("/repo/wt-b"),
          ),
        ],
      ]),
    })[0];
    expect(changed.signature).not.toBe(first.signature);
  });
});
