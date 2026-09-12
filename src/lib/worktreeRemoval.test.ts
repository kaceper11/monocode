import { describe, expect, it } from "vitest";
import { removalFallbacks, type RemovalEntry } from "./worktreeRemoval";
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
