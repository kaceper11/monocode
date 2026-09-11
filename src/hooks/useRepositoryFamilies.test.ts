import { afterEach, expect, it, vi } from "vitest";
import { discoverRepositoryFamilies } from "./useRepositoryFamilies";
import {
  getVerifiedFamilies,
  publishRepositoryFamilies,
  subscribeRepositoryFamilies,
  type RepositoryFamily,
} from "../lib/repositoryFamilies";
const family = (path: string): RepositoryFamily => ({
  commonDir: `${path}/.git`,
  checkout: path,
  worktrees: [],
});
afterEach(() => publishRepositoryFamilies(new Map()));

it("reuses cached families, publishes before a slow repository, and drops unused cache", async () => {
  publishRepositoryFamilies(
    new Map([
      ["/cached", family("/cached")],
      ["/unused", family("/unused")],
    ]),
  );
  let finish!: (value: RepositoryFamily) => void;
  const slow = new Promise<RepositoryFamily>((resolve) => {
    finish = resolve;
  });
  const probe = vi.fn((path: string) =>
    path === "/slow" ? slow : Promise.resolve(family(path)),
  );
  const done = discoverRepositoryFamilies(
    ["/new", "/cached", "/slow"],
    probe,
    () => false,
  );
  await vi.waitFor(() => expect(getVerifiedFamilies().has("/new")).toBe(true));
  expect(getVerifiedFamilies().has("/cached")).toBe(true);
  expect(getVerifiedFamilies().has("/unused")).toBe(false);
  expect(probe.mock.calls.map(([path]) => path)).toEqual(["/new", "/slow"]);
  finish(family("/slow"));
  await done;
});

it("refreshes only active cached ownership and discards stale aliases on failure", async () => {
  const previous = family("/main");
  publishRepositoryFamilies(
    new Map([
      ["/main", previous],
      ["/child", previous],
      ["/other", family("/other")],
    ]),
  );
  const probe = vi.fn(async () => {
    throw new Error("Unavailable");
  });
  await discoverRepositoryFamilies(
    ["/child", "/other"],
    probe,
    () => false,
    "/child",
  );
  expect(probe).toHaveBeenCalledTimes(1);
  expect([...getVerifiedFamilies().keys()]).toEqual(["/other"]);
});

it("does not publish cancelled discovery or overwrite concurrent updates to another family", async () => {
  let finish!: (value: RepositoryFamily) => void;
  let cancelled = false;
  const done = discoverRepositoryFamilies(
    ["/new"],
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => cancelled,
  );
  publishRepositoryFamilies(new Map([["/other", family("/other")]]));
  finish(family("/new"));
  await done;
  expect([...getVerifiedFamilies().keys()]).toEqual(["/other", "/new"]);
  const pending = discoverRepositoryFamilies(
    ["/later"],
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => cancelled,
  );
  cancelled = true;
  finish(family("/later"));
  await pending;
  expect(getVerifiedFamilies().has("/later")).toBe(false);
});

it("keeps the newest probe result when responses arrive out of order", async () => {
  const worktree = {
    path: "/repo-wt",
    head: "abc",
    branch: "task",
    main: false,
    missing: false,
    locked: null,
    prunable: null,
  };
  const stale = family("/repo");
  const fresh = { ...family("/repo"), worktrees: [worktree] };
  let finishOld!: (value: RepositoryFamily) => void;
  const first = discoverRepositoryFamilies(
    ["/repo"],
    () =>
      new Promise<RepositoryFamily>((resolve) => {
        finishOld = resolve;
      }),
    () => false,
    "/repo",
  );
  // A newer probe for the same family resolves while the first is in flight.
  const second = discoverRepositoryFamilies(
    ["/repo"],
    () => Promise.resolve(fresh),
    () => false,
    "/repo",
  );
  await second;
  expect(getVerifiedFamilies().get("/repo")?.worktrees).toHaveLength(1);
  finishOld(stale);
  await first;
  // The late, stale response must not clobber the newer publish.
  expect(getVerifiedFamilies().get("/repo")?.worktrees).toHaveLength(1);
});

it("never drops a recent subfolder alias while refreshing a sibling checkout", async () => {
  const initial = {
    ...family("/main"),
    worktrees: ["/main", "/branch"].map((path) => ({
      path,
      head: "abc",
      branch: "main",
      main: path === "/main",
      missing: false,
      locked: null,
      prunable: null,
    })),
  };
  publishRepositoryFamilies(
    new Map(
      ["/main", "/branch", "/main/src-tauri"].map((path) => [path, initial]),
    ),
  );
  const snapshots: boolean[] = [];
  const unsubscribe = subscribeRepositoryFamilies(() =>
    snapshots.push(getVerifiedFamilies().has("/main/src-tauri")),
  );
  let finish!: (value: RepositoryFamily) => void;
  const probe = vi.fn((path: string) =>
    path === "/main/src-tauri"
      ? new Promise<RepositoryFamily>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ ...initial, checkout: path }),
  );
  try {
    const done = discoverRepositoryFamilies(
      ["/branch", "/main", "/main/src-tauri"],
      probe,
      () => false,
      "/branch",
    );
    await vi.waitFor(() =>
      expect(probe).toHaveBeenCalledWith("/main/src-tauri"),
    );
    expect(snapshots.every(Boolean)).toBe(true);
    finish(initial);
    await done;
    expect(snapshots.every(Boolean)).toBe(true);
    expect(getVerifiedFamilies().get("/branch")?.checkout).toBe("/branch");
  } finally {
    unsubscribe();
  }
});
