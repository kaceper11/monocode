// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  publishRepositoryFamilies,
  type RepositoryFamily,
  type WorkingCopy,
} from "../lib/repositoryFamilies";
import { notifyGitChanged } from "../lib/fs";
import {
  peekWorktreeCollision,
  useWorktreeCollision,
} from "./useWorktreeCollisions";

let worktrees: WorkingCopy[] = [];
let worktreesByCwd: Record<string, WorkingCopy[]> = {};
let statusFiles: Record<string, string[]> = {};
let branchFiles: Record<string, string[]> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { cwd?: string }) => {
    const cwd = args?.cwd ?? "";
    if (command === "git_worktrees") return worktreesByCwd[cwd] ?? worktrees;
    if (command === "git_branch_changed_files") return branchFiles[cwd] ?? [];
    if (command === "git_diff_files") {
      const cwd = args?.cwd ?? "";
      return {
        branch: null,
        files: (statusFiles[cwd] ?? []).map((relative) => ({
          path: `${cwd}/${relative}`,
          relative,
          status: "modified",
          additions: 1,
          deletions: 0,
          staged: false,
          unstaged: true,
        })),
        additions: 0,
        deletions: 0,
        remote: null,
        upstream: null,
        defaultBranch: null,
        ahead: 0,
        behind: 0,
        aheadOfDefault: 0,
      };
    }
    throw new Error(`unexpected invoke ${command}`);
  }),
}));

function worktree(path: string, branch: string, users: string[] = []): WorkingCopy {
  return {
    path,
    head: "abc",
    branch: `refs/heads/${branch}`,
    main: false,
    missing: false,
    locked: null,
    prunable: null,
    users,
    // The backend reports last_used as the newest bound session's updated_at.
    lastUsed: users.length ? Date.now() : null,
  };
}

function publish(...paths: string[]) {
  const family: RepositoryFamily = {
    commonDir: `${paths[0]}/.git`,
    checkout: paths[0],
    worktrees,
  };
  publishRepositoryFamilies(
    new Map(paths.map((path) => [path, family] as const)),
  );
}

function publishClones(
  identity: string | null,
  ...families: RepositoryFamily[]
) {
  for (const family of families) family.identity = identity;
  publishRepositoryFamilies(
    new Map(
      families.flatMap((family) =>
        family.worktrees.map((copy) => [copy.path, family] as const),
      ),
    ),
  );
}

function Fixture() {
  useWorktreeCollision("/repo");
  useWorktreeCollision("/repo-wt");
  return null;
}

beforeEach(() => {
  worktrees = [];
  worktreesByCwd = {};
  statusFiles = {};
  branchFiles = {};
  localStorage.clear();
  vi.mocked(invoke).mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  publishRepositoryFamilies(new Map());
  vi.unstubAllGlobals();
});

it("flags both sibling copies and clears when either side resolves", async () => {
  worktrees = [
    worktree("/repo", "main", [
      "codex · main work (11111111-2222-3333-4444-555555555555)",
    ]),
    worktree("/repo-wt", "feature", [
      "codex · feature work (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)",
    ]),
  ];
  statusFiles = {
    "/repo": ["src/app.ts"],
    "/repo-wt": ["src/app.ts", "README.md"],
  };
  publish("/repo", "/repo-wt");
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await vi.waitFor(() =>
      expect(peekWorktreeCollision("/repo")).toHaveLength(1),
    );
    expect(peekWorktreeCollision("/repo")).toEqual([
      {
        relative: "src/app.ts",
        peers: [
          {
            path: "/repo-wt",
            name: "feature",
            sessions: ["codex · feature work"],
          },
        ],
      },
    ]);
    expect(peekWorktreeCollision("/repo-wt")![0].peers[0]).toMatchObject({
      path: "/repo",
      name: "main",
      sessions: ["codex · main work"],
    });

    statusFiles["/repo-wt"] = ["README.md"];
    await act(async () => notifyGitChanged("/repo-wt"));
    await vi.waitFor(() =>
      expect(peekWorktreeCollision("/repo")).toBeNull(),
    );
    expect(peekWorktreeCollision("/repo-wt")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("reads no file status when no copy has a live session or recent use", async () => {
  worktrees = [worktree("/repo", "main"), worktree("/repo-wt", "feature")];
  statusFiles = { "/repo": ["a.ts"], "/repo-wt": ["a.ts"] };
  publish("/repo", "/repo-wt");
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await vi.waitFor(() =>
      expect(
        vi.mocked(invoke).mock.calls.some(([c]) => c === "git_worktrees"),
      ).toBe(true),
    );
    expect(
      vi.mocked(invoke).mock.calls.filter(([c]) => c === "git_diff_files"),
    ).toHaveLength(0);
    expect(peekWorktreeCollision("/repo")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("does no work at all for single-checkout families", async () => {
  worktrees = [
    worktree("/repo", "main", [
      "codex · main work (11111111-2222-3333-4444-555555555555)",
    ]),
  ];
  statusFiles = { "/repo": ["a.ts"] };
  publish("/repo");
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => notifyGitChanged("/repo"));
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(peekWorktreeCollision("/repo")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("refetches a copy that becomes live again", async () => {
  worktrees = [
    worktree("/repo", "main", ["main work (11111111-2222-3333-4444-555555555555)"]),
    worktree("/repo-wt", "feature", ["feature work (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)"]),
  ];
  statusFiles = { "/repo": ["src/app.ts"], "/repo-wt": ["src/app.ts"] };
  publish("/repo", "/repo-wt");
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await vi.waitFor(() =>
      expect(peekWorktreeCollision("/repo")).toHaveLength(1),
    );
    const reads = () =>
      vi.mocked(invoke).mock.calls.filter(([c]) => c === "git_diff_files")
        .length;
    const before = reads();

    // Session unbinds → copy goes non-live → badge clears.
    worktrees = [
      worktree("/repo", "main", ["main work (11111111-2222-3333-4444-555555555555)"]),
      worktree("/repo-wt", "feature"),
    ];
    await act(async () => publish("/repo", "/repo-wt"));
    await vi.waitFor(() =>
      expect(peekWorktreeCollision("/repo")).toBeNull(),
    );

    // Files changed while the copy was non-live; reliving must refetch.
    statusFiles["/repo-wt"] = ["other.ts"];
    worktrees = [
      worktree("/repo", "main", ["main work (11111111-2222-3333-4444-555555555555)"]),
      worktree("/repo-wt", "feature", ["feature work (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)"]),
    ];
    await act(async () => publish("/repo", "/repo-wt"));
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(peekWorktreeCollision("/repo")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("skips locked copies even when they share a changed file", async () => {
  worktrees = [
    worktree("/repo", "main", ["main work (11111111-2222-3333-4444-555555555555)"]),
    { ...worktree("/repo-locked", "locked-branch", ["old work (bbbbbbbb-2222-3333-4444-555555555555)"]), locked: "locked" },
    worktree("/repo-wt", "feature", ["feature work (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)"]),
  ];
  statusFiles = {
    "/repo": ["a.ts"],
    "/repo-locked": ["a.ts"],
    "/repo-wt": ["b.ts"],
  };
  publish("/repo", "/repo-wt", "/repo-locked");
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await vi.waitFor(() =>
      expect(
        vi.mocked(invoke).mock.calls.some(([c]) => c === "git_worktrees"),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(
        vi.mocked(invoke).mock.calls.some(
          ([c, args]) =>
            c === "git_diff_files" &&
            (args as { cwd?: string })?.cwd === "/repo-wt",
        ),
      ).toBe(true),
    );
    expect(
      vi.mocked(invoke).mock.calls.some(
        ([c, args]) =>
          c === "git_diff_files" &&
          (args as { cwd?: string })?.cwd === "/repo-locked",
      ),
    ).toBe(false);
    expect(peekWorktreeCollision("/repo")).toBeNull();
    expect(peekWorktreeCollision("/repo-locked")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("flags committed-ahead files a sibling already landed", async () => {
  worktrees = [
    worktree("/repo", "main", ["main work (11111111-2222-3333-4444-555555555555)"]),
    worktree("/repo-wt", "feature", ["feature work (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)"]),
  ];
  statusFiles = { "/repo": ["src/app.ts"], "/repo-wt": [] };
  branchFiles = { "/repo-wt": ["src/app.ts"] };
  publish("/repo", "/repo-wt");
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await vi.waitFor(() =>
      expect(peekWorktreeCollision("/repo")).toHaveLength(1),
    );
    expect(peekWorktreeCollision("/repo")![0].peers[0]).toMatchObject({
      path: "/repo-wt",
      committed: true,
    });
  } finally {
    await act(async () => root.unmount());
  }
});

it("joins separate clones of one repo into a collision domain", async () => {
  const cloneA = worktree("/cloneA", "main", ["a work (11111111-2222-3333-4444-555555555555)"]);
  const cloneB = worktree("/cloneB", "feature", ["b work (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)"]);
  worktreesByCwd = { "/cloneA": [cloneA], "/cloneB": [cloneB] };
  statusFiles = { "/cloneA": ["src/app.ts"], "/cloneB": ["src/app.ts"] };
  publishClones(
    "root-commit",
    { commonDir: "/cloneA/.git", checkout: "/cloneA", worktrees: [cloneA] },
    { commonDir: "/cloneB/.git", checkout: "/cloneB", worktrees: [cloneB] },
  );
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        createElement(() => {
          useWorktreeCollision("/cloneA");
          useWorktreeCollision("/cloneB");
          return null;
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(peekWorktreeCollision("/cloneA")).toHaveLength(1),
    );
    expect(peekWorktreeCollision("/cloneA")![0].peers[0].path).toBe("/cloneB");
    expect(peekWorktreeCollision("/cloneB")).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps unrelated repos in separate domains", async () => {
  const cloneA = worktree("/cloneA", "main", ["a work (11111111-2222-3333-4444-555555555555)"]);
  const cloneB = worktree("/cloneB", "feature", ["b work (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)"]);
  worktreesByCwd = { "/cloneA": [cloneA], "/cloneB": [cloneB] };
  statusFiles = { "/cloneA": ["src/app.ts"], "/cloneB": ["src/app.ts"] };
  publishClones(
    null,
    { commonDir: "/cloneA/.git", checkout: "/cloneA", worktrees: [cloneA] },
    { commonDir: "/cloneB/.git", checkout: "/cloneB", worktrees: [cloneB] },
  );
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        createElement(() => {
          useWorktreeCollision("/cloneA");
          useWorktreeCollision("/cloneB");
          return null;
        }),
      ),
    );
    // Single-copy domains never pay for a status read.
    await act(async () => notifyGitChanged("/cloneA"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    expect(
      vi.mocked(invoke).mock.calls.some(([c]) => c === "git_diff_files"),
    ).toBe(false);
    expect(peekWorktreeCollision("/cloneA")).toBeNull();
    expect(peekWorktreeCollision("/cloneB")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
