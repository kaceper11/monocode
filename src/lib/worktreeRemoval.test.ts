import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  bulkRemovalPlan,
  executeWorktreeRemovals,
  OPEN_WORKTREE_MANAGER,
  openWorktreeManager,
  preflightWorktrees,
  removalFallbacks,
  type RemovalEntry,
  type WorktreeSafety,
} from "./worktreeRemoval";
import {
  staleWorkingCopy,
  STALE_WORKING_COPY_AGE,
} from "./repositoryFamilies";
import type { RecentProject } from "./recents";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// recents/hidden bookkeeping persists through localStorage — an in-memory
// stub keeps node-env tests on the real code path.
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
});

const entry = (
  path: string,
  over: Partial<RemovalEntry> = {},
): RemovalEntry => ({
  path,
  head: "head",
  branch: `refs/heads/${path.split("/").pop()}`,
  main: false,
  missing: false,
  locked: null,
  prunable: null,
  users: [],
  ...over,
});

const recents = (...paths: [string, number][]): RecentProject[] =>
  paths.map(([path, openedAt]) => ({ path, openedAt }));

describe("removalFallbacks", () => {
  it("prefers the most recently used healthy sibling", () => {
    const old = entry("/repo/wt-old", { lastUsed: 100 });
    const recent = entry("/repo/wt-recent", { lastUsed: 200 });
    const main = entry("/repo", { main: true, branch: "refs/heads/main" });
    const result = removalFallbacks(
      "/repo/wt-target",
      [old, main, recent],
      [],
    );
    expect(result.map((e) => e.path)).toEqual([
      "/repo/wt-recent",
      "/repo/wt-old",
      "/repo",
    ]);
  });

  it("ranks by recents when no session activity is recorded", () => {
    const a = entry("/repo/wt-a");
    const b = entry("/repo/wt-b");
    const result = removalFallbacks(
      "/repo/wt-target",
      [a, b],
      recents(["/repo/wt-b", 500]),
    );
    expect(result[0].path).toBe("/repo/wt-b");
  });

  it("falls back to the accessible main checkout", () => {
    const main = entry("/repo", { main: true, branch: "refs/heads/main" });
    expect(removalFallbacks("/repo/wt-target", [main], [])).toEqual([main]);
    expect(removalFallbacks("/repo/wt-target", [], [])).toEqual([]);
  });

  it("excludes the target and unhealthy candidates", () => {
    const target = entry("/repo/wt-target");
    const missing = entry("/repo/wt-missing", { missing: true });
    const prunable = entry("/repo/wt-prunable", { prunable: "gone" });
    const main = entry("/repo", { main: true, branch: "refs/heads/main" });
    const result = removalFallbacks(
      target.path,
      [target, missing, prunable, main],
      [],
    );
    expect(result.map((e) => e.path)).toEqual(["/repo"]);
  });

  it("accepts locked and detached checkouts as switch destinations", () => {
    const locked = entry("/repo/wt-locked", { locked: "reason" });
    const detached = entry("/repo/wt-detached", { branch: null });
    const main = entry("/repo", { main: true, branch: "refs/heads/main" });
    const result = removalFallbacks(
      "/repo/wt-target",
      [locked, detached, main],
      [],
    );
    // Siblings still rank ahead of main even without a branch.
    expect(result.map((e) => e.path)).toEqual([
      "/repo/wt-detached",
      "/repo/wt-locked",
      "/repo",
    ]);
  });

  it("never treats a WSL path as a host-path match", () => {
    const wsl = entry("//wsl.localhost/Debian/repo", {
      branch: "refs/heads/wsl",
    });
    const host = entry("/repo", { main: true, branch: "refs/heads/main" });
    const result = removalFallbacks("/repo/wt-target", [wsl, host], []);
    expect(result.map((e) => e.path)).toEqual([
      "//wsl.localhost/Debian/repo",
      "/repo",
    ]);
    // A WSL target only matches the identical WSL path — not a host path.
    expect(
      removalFallbacks(
        "//wsl.localhost/Debian/repo",
        [wsl, host],
        [],
      ).map((e) => e.path),
    ).toEqual(["/repo"]);
  });
});

describe("bulkRemovalPlan", () => {
  const safety = (
    path: string,
    over: Partial<RemovalEntry> = {},
    rest: Partial<WorktreeSafety> = {},
  ): WorktreeSafety => ({
    host: "macos",
    entry: entry(path, over),
    dirty: false,
    processes: [],
    siblings: [],
    ...rest,
  });

  it("passes clean checkouts through as removable", () => {
    const { removable, skipped } = bulkRemovalPlan([
      safety("/repo/wt-a"),
      safety("/repo/wt-b"),
    ]);
    expect(removable.map((row) => row.entry.path)).toEqual([
      "/repo/wt-a",
      "/repo/wt-b",
    ]);
    expect(skipped).toEqual([]);
  });

  it("skips each protected state with its own reason", () => {
    const { removable, skipped } = bulkRemovalPlan([
      safety("/repo", { main: true }),
      safety("/repo/wt-missing", { missing: true }),
      safety("/repo/wt-prunable", { prunable: "gone" }),
      safety("/repo/wt-locked", { locked: "editor" }),
      safety("/repo/wt-detached", { branch: null }),
      safety("/repo/wt-dirty", {}, { dirty: true }),
      safety(
        "/repo/wt-busy",
        {},
        {
          processes: [
            { kind: "agent", id: "1", cwd: "/repo/wt-busy", label: "agent" },
            { kind: "terminal", id: "2", cwd: "/repo/wt-busy", label: "sh" },
          ],
        },
      ),
    ]);
    expect(removable).toEqual([]);
    expect(skipped.map((row) => row.reason)).toEqual([
      "The main checkout is protected",
      "Folder is missing — restore or repair it",
      "Stale registration — repair from a surviving checkout",
      "Locked: editor",
      "Detached HEAD",
      "Uncommitted, untracked or ignored files",
      "2 processes running — review to stop them",
    ]);
  });

  it("partitions a mixed batch without losing order", () => {
    const { removable, skipped } = bulkRemovalPlan([
      safety("/repo/wt-ok"),
      safety("/repo/wt-dirty", {}, { dirty: true }),
      safety("/repo/wt-also-ok"),
    ]);
    expect(removable.map((row) => row.entry.path)).toEqual([
      "/repo/wt-ok",
      "/repo/wt-also-ok",
    ]);
    expect(skipped.map((row) => row.entry.path)).toEqual([
      "/repo/wt-dirty",
    ]);
  });
});

describe("staleWorkingCopy", () => {
  const NOW = 100 * 86_400_000;
  const stale = NOW - STALE_WORKING_COPY_AGE - 1;

  it("flags known activity older than the stale age", () => {
    expect(staleWorkingCopy(entry("/repo/wt"), stale, NOW)).toBe(true);
    expect(staleWorkingCopy(entry("/repo/wt"), NOW - 1000, NOW)).toBe(false);
  });

  it("never treats unknown activity as stale", () => {
    expect(staleWorkingCopy(entry("/repo/wt"), null, NOW)).toBe(false);
  });

  it("protects main, locked, missing and prunable copies regardless of age", () => {
    for (const over of [
      { main: true },
      { locked: "reason" },
      { missing: true },
      { prunable: "gone" },
    ] satisfies Partial<RemovalEntry>[])
      expect(staleWorkingCopy(entry("/repo/wt", over), stale, NOW)).toBe(false);
  });
});

describe("preflightWorktrees", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("returns safeties and converts per-target failures to skips", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        host: "macos",
        entry: entry("/repo/wt-a"),
        dirty: false,
        processes: [],
        siblings: [],
      } satisfies WorktreeSafety)
      .mockRejectedValueOnce(new Error("not a worktree"));
    const { results, failed } = await preflightWorktrees(
      [entry("/repo/wt-a"), entry("/repo/gone")],
      () => "/repo",
    );
    expect(results.map((row) => row.safety.entry.path)).toEqual([
      "/repo/wt-a",
    ]);
    expect(results[0].target.path).toBe("/repo/wt-a");
    expect(failed).toHaveLength(1);
    expect(failed[0].entry.path).toBe("/repo/gone");
    expect(failed[0].reason).toContain("not a worktree");
    expect(invoke).toHaveBeenNthCalledWith(2, "git_worktree_safety", {
      cwd: "/repo",
      path: "/repo/gone",
    });
  });
});

describe("executeWorktreeRemovals", () => {
  const safety = (path: string): WorktreeSafety => ({
    host: "macos",
    entry: entry(path),
    dirty: false,
    processes: [],
    siblings: [],
  });

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    storage.clear();
  });

  it("removes sequentially without force or process stops", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const { removed, failures } = await executeWorktreeRemovals({
      removable: [safety("/repo/wt-a"), safety("/repo/wt-b")],
      contextFor: () => "/repo",
      fallbackFor: () => "/repo",
    });
    expect(removed).toEqual(["/repo/wt-a", "/repo/wt-b"]);
    expect(failures).toEqual([]);
    expect(invoke).toHaveBeenNthCalledWith(2, "git_worktree_remove", {
      cwd: "/repo",
      path: "/repo/wt-b",
      head: "head",
      reviewed: null,
      stopProcesses: null,
    });
  });

  it("keeps going past a failure and reports it for review", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("working copy is dirty"))
      .mockResolvedValueOnce(undefined);
    const fallbacks: [string, readonly string[]][] = [];
    const { removed, failures } = await executeWorktreeRemovals({
      removable: [
        safety("/repo/wt-a"),
        safety("/repo/wt-b"),
        safety("/repo/wt-c"),
      ],
      contextFor: () => "/repo",
      fallbackFor: (path, removedPaths) => {
        fallbacks.push([path, removedPaths]);
        return "/repo";
      },
    });
    expect(removed).toEqual(["/repo/wt-a", "/repo/wt-c"]);
    expect(failures).toHaveLength(1);
    expect(failures[0].entry.path).toBe("/repo/wt-b");
    expect(failures[0].message).toContain("dirty");
    // Bookkeeping sees the full removed set so survivors resolve correctly.
    expect(fallbacks).toEqual([
      ["/repo/wt-a", ["/repo/wt-a", "/repo/wt-c"]],
      ["/repo/wt-c", ["/repo/wt-a", "/repo/wt-c"]],
    ]);
  });
});

describe("openWorktreeManager", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("dispatches the request on the window event", () => {
    const seen: Event[] = [];
    vi.stubGlobal("window", {
      dispatchEvent: (event: Event) => {
        seen.push(event);
        return true;
      },
    });
    openWorktreeManager({
      cwd: "/repo",
      path: "/repo/wt-a",
      action: "remove",
    });
    expect(seen).toHaveLength(1);
    const event = seen[0] as CustomEvent;
    expect(event.type).toBe(OPEN_WORKTREE_MANAGER);
    expect(event.detail).toEqual({
      cwd: "/repo",
      path: "/repo/wt-a",
      action: "remove",
    });
  });
});
