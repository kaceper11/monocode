import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInboxCache,
  githubWorkItem,
  inboxItemKey,
  type GithubWorkItem,
  type InboxItem,
} from "./githubTasks";
import {
  inboxRelatedSessionCounts,
  removeSessionWorkItem,
  addSessionWorkItems,
  sessionWorkItems,
  inboxItemMatchesLinkedWorkItem,
  linkedWorkItemInboxKey,
  linkedWorkItemFromInboxItem,
  parseGithubWorkItemUrl,
  relatedSessionsForInboxItem,
  resolveLinkedWorkItem,
} from "./sessionWorkItem";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  clearInboxCache();
  vi.mocked(invoke).mockReset();
});

describe("session work items", () => {
  it("parses a GitHub pull request URL without repository lookup", () => {
    expect(
      parseGithubWorkItemUrl(
        "Please review https://github.com/openai/codex/pull/321?diff=split",
      ),
    ).toEqual({
      kind: "pr",
      repo: "openai/codex",
      number: 321,
      url: "https://github.com/openai/codex/pull/321",
    });
  });

  it("creates a stable link from a GitHub Inbox item", () => {
    const item = {
      provider: "github",
      kind: "issue",
      repo: "openai/codex",
      number: 12,
      url: "https://github.com/openai/codex/issues/12",
    } as InboxItem;
    const linked = linkedWorkItemFromInboxItem(item);
    expect(linked).toEqual({
      kind: "issue",
      repo: "openai/codex",
      number: 12,
      url: "https://github.com/openai/codex/issues/12",
    });
    expect(inboxItemMatchesLinkedWorkItem(item, linked!)).toBe(true);
    expect(linkedWorkItemInboxKey(linked!)).toBe(inboxItemKey(item));
  });

  it("resolves an explicit PR number against the session repository", async () => {
    vi.mocked(invoke).mockResolvedValue("openai/codex");

    await expect(
      resolveLinkedWorkItem("Please fix PR #42", "/tmp/codex", null),
    ).resolves.toEqual({
      kind: "pr",
      repo: "openai/codex",
      number: 42,
      url: "https://github.com/openai/codex/pull/42",
    });
    expect(invoke).toHaveBeenCalledWith("git_github_repo", {
      cwd: "/tmp/codex",
    });
  });

  it("fetches an exact cache miss once and reuses that result", async () => {
    const result: GithubWorkItem = {
      kind: "pr",
      repo: "openai/codex",
      number: 42,
      title: "Faster linked navigation",
      url: "https://github.com/openai/codex/pull/42",
      state: "open",
      updatedAt: "2026-09-09T12:00:00Z",
      labels: [],
      assignees: [],
      draft: false,
    };
    vi.mocked(invoke).mockResolvedValue(result);

    await expect(
      githubWorkItem("/tmp/codex", "openai/codex", "pr", 42),
    ).resolves.toEqual(result);
    await expect(
      githubWorkItem("/tmp/codex", "openai/codex", "pr", 42),
    ).resolves.toEqual(result);

    const refreshed = { ...result, updatedAt: "2026-09-09T12:01:00Z" };
    vi.mocked(invoke).mockResolvedValueOnce(refreshed);
    await expect(
      githubWorkItem("/tmp/codex", "openai/codex", "pr", 42, {
        force: true,
      }),
    ).resolves.toEqual(refreshed);
    await expect(
      githubWorkItem("/tmp/codex", "openai/codex", "pr", 42),
    ).resolves.toEqual(refreshed);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith("git_github_work_item", {
      cwd: "/tmp/codex",
      repo: "openai/codex",
      kind: "pr",
      number: 42,
    });
  });

  it("does not associate a Linear Inbox item", () => {
    expect(
      linkedWorkItemFromInboxItem({
        provider: "linear",
        kind: "linear",
        number: 12,
        repo: "",
      } as InboxItem),
    ).toBeNull();
  });

  it("finds sessions related to the same GitHub Inbox item", () => {
    const item = {
      provider: "github",
      kind: "pr",
      repo: "Acme/App",
      number: 42,
    } as InboxItem;
    const matching = {
      id: "matching",
      linkedWorkItem: {
        kind: "pr" as const,
        repo: "acme/app",
        number: 42,
        url: "https://github.com/acme/app/pull/42",
      },
    };
    const sessions = [
      matching,
      {
        id: "other-number",
        linkedWorkItem: { ...matching.linkedWorkItem, number: 43 },
      },
      {
        id: "other-kind",
        linkedWorkItem: {
          ...matching.linkedWorkItem,
          kind: "issue" as const,
        },
      },
      { id: "unlinked" },
    ];

    expect(relatedSessionsForInboxItem(item, sessions)).toEqual([matching]);
    expect(
      relatedSessionsForInboxItem(
        { ...item, provider: "linear", kind: "linear" } as InboxItem,
        sessions,
      ),
    ).toEqual([]);
  });
});

it("keeps account-less and identified links distinct", () => {
  const first = { kind: "issue" as const, repo: "a/b", number: 8, url: "https://github.com/a/b/issues/8" };
  const session = { linkedWorkItem: first };
  const next = addSessionWorkItems(session, [{ ...first, account: "alice" }, { ...first, number: 13, url: "https://github.com/a/b/issues/13", account: "alice" }]);
  expect(sessionWorkItems(next)).toHaveLength(3);
  expect(next.linkedWorkItem.account).toBeUndefined();
  expect(relatedSessionsForInboxItem({ provider: "github", kind: "issue", repo: "a/b", number: 13, account: "alice" } as InboxItem, [next])).toEqual([next]);
  expect(sessionWorkItems(addSessionWorkItems(next, [{ ...first, account: "bob" }]))).toHaveLength(4);
  const removed = removeSessionWorkItem(next, first);
  expect(sessionWorkItems(removed).map(link => link.number)).toEqual([8, 13]);
  expect(sessionWorkItems(removeSessionWorkItem(removed, sessionWorkItems(removed)[0]))).toHaveLength(1);
});

it("bounds the combined snapshot size after twenty incremental links", () => {
  let session: { linkedWorkItem?: import("./session").LinkedWorkItem } = {};
  for (let number = 1; number <= 20; number++) {
    session = addSessionWorkItems(session, [{kind: "issue", repo: "a/b", number, url: `https://github.com/a/b/issues/${number}`, context: "x".repeat(32_000)}]);
  }
  const links = sessionWorkItems(session);
  expect(links).toHaveLength(20);
  expect(links.reduce((sum, link) => sum + (link.context?.length ?? 0), 0)).toBeLessThanOrEqual(32_000);
  expect(links.every(link => link.context?.includes("Snapshot truncated"))).toBe(true);
});

it("indexes related counts without changing account and legacy matching", () => {
  const items = Array.from({ length: 100 }, (_, number) => ({ provider: "github", kind: "issue", repo: "a/b", number, url: `https://github.com/a/b/issues/${number}`, account: number % 2 ? "alice" : "bob" }) as InboxItem);
  const sessions = Array.from({ length: 100 }, (_, i) => ({ linkedWorkItem: {
    kind: "issue" as const, repo: "a/b", number: i % 50, url: `https://github.com/a/b/issues/${i % 50}`, account: i % 3 ? "alice" : undefined,
  } }));
  const counts = inboxRelatedSessionCounts(items, sessions);
  for (const item of items) expect(counts.get(item)).toBe(relatedSessionsForInboxItem(item, sessions).length);
});
