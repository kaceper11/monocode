// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubPrState, GithubWorkItemComment } from "./githubTasks";
import type { Watcher } from "./watchers";
import { pollWatcherSource } from "./watcherPoll";

const { prState, workItemThread } = vi.hoisted(() => ({
  prState: vi.fn(),
  workItemThread: vi.fn(),
}));

vi.mock("./githubTasks", () => ({
  FAILING_CHECK_CONCLUSIONS: [
    "failure",
    "timed_out",
    "action_required",
    "startup_failure",
    "cancelled",
  ],
  githubPrState: prState,
  githubWorkItemThread: workItemThread,
  listGithubWorkItems: vi.fn().mockResolvedValue([]),
}));

const SOURCE = {
  kind: "github-pr" as const,
  repo: "acme/app",
  number: 42,
  cwd: "/repo",
};

const WATCHER: Watcher = {
  id: "w1",
  name: "PR 42",
  source: SOURCE,
  enabled: true,
  mode: "notify",
  intervalSec: 300,
  cooldownSec: 900,
  seen: [],
  history: [],
  nextPollAt: 0,
  failures: 0,
  idleStreak: 0,
  createdAt: 0,
};

const comment = (
  id: string,
  kind: string,
  resolved: boolean,
): GithubWorkItemComment => ({
  id,
  kind,
  author: "reviewer",
  body: "note",
  createdAt: "2025-01-01T00:00:00Z",
  url: "",
  state: "",
  path: "",
  line: null,
  resolved,
  threadId: `t-${id}`,
  replies: [],
});

const state = (over: Partial<GithubPrState> = {}): GithubPrState => ({
  number: 42,
  title: "Add feature",
  url: "https://github.com/acme/app/pull/42",
  state: "OPEN",
  headRefOid: "abc123",
  headRefName: "feature-x",
  baseRefName: "main",
  mergeStateStatus: "CLEAN",
  reviewDecision: "",
  isDraft: false,
  checks: [],
  ...over,
});

const thread = (comments: GithubWorkItemComment[]) => ({
  comments,
  truncated: false,
  reviewDecision: "",
  baseRefName: "main",
  headRefName: "feature-x",
});

beforeEach(() => {
  prState.mockReset();
  workItemThread.mockReset();
  prState.mockResolvedValue(state());
  workItemThread.mockResolvedValue(thread([]));
});

describe("github-pr adapter", () => {
  it("counts unresolved review_comment threads, not review submissions", async () => {
    workItemThread.mockResolvedValue(
      thread([
        // A top-level review submission — `resolved` is always false on
        // these and they can never resolve, so they must not count.
        comment("r1", "review", false),
        comment("c1", "review_comment", true),
        comment("c2", "review_comment", false),
      ]),
    );
    const poll = await pollWatcherSource(WATCHER);
    const row = poll.conditions.find((c) => c.key.startsWith("gh-comments:"));
    expect(row?.item.title).toBe("PR #42 — 1 unresolved review comment");
    expect(row?.item.action?.kind).toBe("github-pr-comments");
  });

  it("emits no comments row when every inline thread is resolved", async () => {
    workItemThread.mockResolvedValue(
      thread([comment("c1", "review_comment", true)]),
    );
    const poll = await pollWatcherSource(WATCHER);
    expect(
      poll.conditions.some((c) => c.key.startsWith("gh-comments:")),
    ).toBe(false);
  });

  it("labels a changes-requested review when no inline threads are open", async () => {
    prState.mockResolvedValue(state({ reviewDecision: "CHANGES_REQUESTED" }));
    const poll = await pollWatcherSource(WATCHER);
    const row = poll.conditions.find((c) => c.key.startsWith("gh-comments:"));
    expect(row?.item.title).toBe("PR #42 — changes requested");
    expect(row?.item.detail).toBe("Changes requested");
  });

  it("forces a fresh thread read — the cache has no TTL", async () => {
    await pollWatcherSource(WATCHER);
    expect(workItemThread).toHaveBeenCalledWith("/repo", "pr", 42, {
      force: true,
    });
  });

  it("reports a non-open PR as done so the engine retires the watcher", async () => {
    prState.mockResolvedValue(state({ state: "MERGED" }));
    const merged = await pollWatcherSource(WATCHER);
    expect(merged.conditions).toEqual([]);
    expect(merged.done?.kind).toBe("pr-done");
    expect(merged.done?.title).toBe("PR #42 — merged");
    expect(merged.done?.action).toMatchObject({
      kind: "open-url",
      url: "https://github.com/acme/app/pull/42",
    });
    prState.mockResolvedValue(state({ state: "CLOSED" }));
    expect((await pollWatcherSource(WATCHER)).done?.title).toBe(
      "PR #42 — closed",
    );
  });

  it("binds update-branch to the head branch and the PR base", async () => {
    prState.mockResolvedValue(state({ mergeStateStatus: "BEHIND" }));
    const poll = await pollWatcherSource(WATCHER);
    const row = poll.conditions.find((c) => c.key.startsWith("gh-behind:"));
    expect(row?.item.kind).toBe("pr-behind");
    expect(row?.item.action).toMatchObject({
      kind: "update-branch",
      cwd: "/repo",
      branch: "feature-x",
      base: "main",
    });
  });

  it("emits conflicts with a stable signature per head revision", async () => {
    prState.mockResolvedValue(state({ mergeStateStatus: "DIRTY" }));
    const poll = await pollWatcherSource(WATCHER);
    const row = poll.conditions.find((c) => c.key.startsWith("gh-conflicts:"));
    expect(row?.item.kind).toBe("pr-conflicts");
    expect(row?.signature).toBe("DIRTY:abc123");
  });

  it("orders failing check names in the signature so reordering is a no-op", async () => {
    const checks = [
      { name: "lint", status: "completed", conclusion: "failure", url: "", outputTitle: "", outputText: "" },
      { name: "build", status: "completed", conclusion: "failure", url: "", outputTitle: "", outputText: "" },
    ];
    prState
      .mockResolvedValueOnce(state({ checks }))
      .mockResolvedValueOnce(state({ checks: [...checks].reverse() }));
    const first = await pollWatcherSource(WATCHER);
    const second = await pollWatcherSource(WATCHER);
    const sig = (p: typeof first) =>
      p.conditions.find((c) => c.key.startsWith("gh-ci:"))?.signature;
    expect(sig(first)).toBe("abc123:build=failure,lint=failure");
    expect(sig(second)).toBe(sig(first));
  });

  it("fails rather than trust a PR resolved through a repointed remote", async () => {
    prState.mockResolvedValue(
      state({ url: "https://github.com/other/repo/pull/42" }),
    );
    await expect(pollWatcherSource(WATCHER)).rejects.toThrow(
      /no longer points at acme\/app/,
    );
  });
});
