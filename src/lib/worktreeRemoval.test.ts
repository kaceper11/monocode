import { describe, expect, it } from "vitest";
import {
  bulkRemovalPlan,
  removalFallbacks,
  type RemovalEntry,
  type WorktreeSafety,
} from "./worktreeRemoval";
import type { RecentProject } from "./recents";

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
