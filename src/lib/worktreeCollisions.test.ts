import { describe, expect, it } from "vitest";
import {
  COLLISION_RECENT_MS,
  collisionLabel,
  intersectWorkingCopies,
  sameCollisionMap,
  sessionLabel,
  workingCopyLive,
  type CollisionCopy,
} from "./worktreeCollisions";
import type { WorkingCopy } from "./repositoryFamilies";

function copy(
  path: string,
  files: string[],
  name = path.split("/").pop()!,
  sessions: string[] = [],
  committed: string[] = [],
): CollisionCopy {
  return {
    path,
    name,
    sessions,
    files: new Set(files),
    committed: new Set(committed),
  };
}

function worktree(path: string, extra: Partial<WorkingCopy> = {}): WorkingCopy {
  return {
    path,
    head: "abc",
    branch: null,
    main: false,
    missing: false,
    locked: null,
    prunable: null,
    ...extra,
  };
}

describe("intersectWorkingCopies", () => {
  it("flags both copies that changed the same relative path", () => {
    const result = intersectWorkingCopies([
      copy("/repo", ["src/a.ts", "src/only-main.ts"], "main", ["Fix A"]),
      copy("/repo-wt", ["src/a.ts", "src/only-wt.ts"], "feature", ["Fix B"]),
    ]);
    expect([...result.keys()].sort()).toEqual(["/repo", "/repo-wt"]);
    expect(result.get("/repo")).toEqual([
      {
        relative: "src/a.ts",
        peers: [{ path: "/repo-wt", name: "feature", sessions: ["Fix B"] }],
      },
    ]);
    expect(result.get("/repo-wt")![0].peers).toEqual([
      { path: "/repo", name: "main", sessions: ["Fix A"] },
    ]);
  });

  it("stays empty when no path is shared", () => {
    const result = intersectWorkingCopies([
      copy("/repo", ["src/a.ts"]),
      copy("/repo-wt", ["src/b.ts"]),
    ]);
    expect(result.size).toBe(0);
  });

  it("does not collide on same file name in different directories", () => {
    const result = intersectWorkingCopies([
      copy("/repo", ["src/a/index.ts"]),
      copy("/repo-wt", ["src/b/index.ts"]),
    ]);
    expect(result.size).toBe(0);
  });

  it("pairs only the copies that actually share each file", () => {
    const result = intersectWorkingCopies([
      copy("/a", ["x.ts", "shared.ts"], "a"),
      copy("/b", ["x.ts", "shared.ts", "y.ts"], "b"),
      copy("/c", ["y.ts"], "c"),
    ]);
    expect(result.get("/a")!.map((f) => f.relative)).toEqual([
      "shared.ts",
      "x.ts",
    ]);
    expect(result.get("/a")!.every((f) => f.peers.length === 1 && f.peers[0].name === "b")).toBe(true);
    expect(result.get("/b")!.map((f) => f.relative)).toEqual([
      "shared.ts",
      "x.ts",
      "y.ts",
    ]);
    expect(result.get("/b")!.find((f) => f.relative === "y.ts")!.peers[0].name).toBe("c");
    expect(result.get("/c")![0]).toEqual({
      relative: "y.ts",
      peers: [{ path: "/b", name: "b", sessions: [] }],
    });
  });

  it("never lists a copy as its own peer when paths repeat", () => {
    const result = intersectWorkingCopies([
      copy("/repo", ["x.ts"], "a"),
      copy("/repo", ["x.ts"], "a"),
      copy("/other", ["z.ts"], "b"),
    ]);
    expect(result.size).toBe(0);
  });

  it("flags committed-ahead overlap and marks the committed-only peer", () => {
    const result = intersectWorkingCopies([
      copy("/repo", ["src/a.ts"], "main"),
      copy("/repo-wt", [], "feature", [], ["src/a.ts"]),
    ]);
    const onMain = result.get("/repo")!;
    expect(onMain).toHaveLength(1);
    expect(onMain[0].peers[0]).toMatchObject({
      path: "/repo-wt",
      committed: true,
    });
    // The committing side sees the peer's uncommitted change too.
    const onWt = result.get("/repo-wt")!;
    expect(onWt[0].peers[0].committed).toBeUndefined();
  });

  it("produces deterministic file and peer ordering", () => {
    const result = intersectWorkingCopies([
      copy("/b", ["z.ts", "a.ts"], "beta"),
      copy("/c", ["z.ts", "a.ts"], "alpha"),
      copy("/a", ["z.ts", "a.ts"], "main"),
    ]);
    const files = result.get("/a")!;
    expect(files.map((f) => f.relative)).toEqual(["a.ts", "z.ts"]);
    expect(files[0].peers.map((p) => p.name)).toEqual(["alpha", "beta"]);
  });
});

describe("workingCopyLive", () => {
  const now = Date.now();

  it("is live while a bound session stayed recently active", () => {
    const copy = worktree("/repo", {
      users: ["Fix (id)"],
      lastUsed: now - 60_000,
    });
    expect(workingCopyLive(copy, [], now)).toBe(true);
  });

  it("goes cold on stale or missing session evidence", () => {
    // `users` lists every session ever bound; bindings are never cleared, so
    // a stale lastUsed must not pin a copy as live forever.
    const stale = worktree("/repo", {
      users: ["Old work (id)"],
      lastUsed: now - COLLISION_RECENT_MS - 60_000,
    });
    expect(workingCopyLive(stale, [], now)).toBe(false);
    expect(
      workingCopyLive(worktree("/repo", { users: ["No timestamp (id)"] }), [], now),
    ).toBe(false);
  });

  it("is live when used inside the recent window", () => {
    const copy = worktree("/repo", { lastUsed: now - 60_000 });
    expect(workingCopyLive(copy, [], now)).toBe(true);
  });

  it("is live on a recent rail opening without session evidence", () => {
    const copy = worktree("/repo");
    expect(
      workingCopyLive(copy, [{ path: "/repo", openedAt: now - 60_000 }], now),
    ).toBe(true);
  });

  it("is cold without sessions or recent use", () => {
    const copy = worktree("/repo", {
      lastUsed: now - COLLISION_RECENT_MS - 60_000,
    });
    expect(workingCopyLive(copy, [], now)).toBe(false);
    expect(workingCopyLive(worktree("/repo"), [], now)).toBe(false);
  });
});

describe("sessionLabel", () => {
  it("strips the appended session id", () => {
    expect(
      sessionLabel("codex · fix tests (8f7c9a2b-1c3d-4e5f-9a0b-c1d2e3f4a5b6)"),
    ).toBe("codex · fix tests");
  });

  it("keeps a parenthetical title that is not a session id", () => {
    expect(sessionLabel("claude · fix bug (PROJ-1)")).toBe(
      "claude · fix bug (PROJ-1)",
    );
  });
});

describe("collisionLabel", () => {
  it("names the count and sibling copies", () => {
    const files = intersectWorkingCopies([
      copy("/repo", ["a.ts", "b.ts"], "main"),
      copy("/repo-wt", ["a.ts", "b.ts"], "feature"),
    ]).get("/repo")!;
    expect(collisionLabel(files)).toBe("2 files also changed in feature");
  });

  it("uses singular for one file", () => {
    const files = intersectWorkingCopies([
      copy("/repo", ["a.ts"], "main"),
      copy("/repo-wt", ["a.ts"], "feature"),
    ]).get("/repo")!;
    expect(collisionLabel(files)).toBe("1 file also changed in feature");
  });
});

describe("sameCollisionMap", () => {
  it("detects clearing and reappearing overlaps", () => {
    const first = intersectWorkingCopies([
      copy("/repo", ["a.ts"], "main"),
      copy("/repo-wt", ["a.ts"], "feature"),
    ]);
    const resolved = intersectWorkingCopies([
      copy("/repo", ["a.ts"], "main"),
      copy("/repo-wt", [], "feature"),
    ]);
    expect(sameCollisionMap(first, resolved)).toBe(false);
    expect(sameCollisionMap(first, new Map())).toBe(false);
    const again = intersectWorkingCopies([
      copy("/repo", ["a.ts"], "main"),
      copy("/repo-wt", ["a.ts"], "feature"),
    ]);
    expect(sameCollisionMap(first, again)).toBe(true);
  });
});
