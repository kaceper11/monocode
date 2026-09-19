import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInboxCache,
  githubPrAction,
  githubWorkItem,
  inboxItemKey,
  type GithubWorkItem,
  type InboxItem,
} from "./githubTasks";
import {
  indexByWorkItem,
  bindLinkedWorkItemAccount,
  relatedFromIndex,
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

  it("runs a pull request action and caches the refreshed result", async () => {
    const merged: GithubWorkItem = {
      kind: "pr",
      repo: "openai/codex",
      number: 42,
      title: "Faster linked navigation",
      url: "https://github.com/openai/codex/pull/42",
      state: "merged",
      updatedAt: "2026-09-09T12:05:00Z",
      labels: [],
      assignees: [],
      draft: false,
    };
    vi.mocked(invoke).mockResolvedValue(merged);

    await expect(
      githubPrAction("/tmp/codex", "openai/codex", 42, "squash"),
    ).resolves.toEqual(merged);
    await expect(
      githubWorkItem("/tmp/codex", "openai/codex", "pr", 42),
    ).resolves.toEqual(merged);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("git_github_pr_action", {
      cwd: "/tmp/codex",
      repo: "openai/codex",
      number: 42,
      action: "squash",
    });
  });

  it("does not associate a Linear Inbox item", () => {
    expect(
      linkedWorkItemFromInboxItem({
        provider: "linear",
        kind: "linear",
        number: 12,
        repo: "",
        url: "https://linear.app/team/issue/ENG-12",
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

it("indexes related counts without changing account and legacy matching", () => {
  const items = Array.from({ length: 100 }, (_, number) => ({ provider: "github", kind: "issue", repo: "a/b", number, url: `https://github.com/a/b/issues/${number}`, account: number % 2 ? "alice" : "bob" }) as InboxItem);
  const sessions = Array.from({ length: 100 }, (_, i) => ({ linkedWorkItem: {
    kind: "issue" as const, repo: "a/b", number: i % 50, url: `https://github.com/a/b/issues/${i % 50}`, account: i % 3 ? "alice" : undefined,
  } }));
  const index = indexByWorkItem(sessions, sessionWorkItems);
  for (const item of items) expect(relatedFromIndex(item, index).length).toBe(relatedSessionsForInboxItem(item, sessions).length);
});


it.each(["jira", "azure"] as const)("requires explicit account binding for legacy %s links in both matching paths", provider => {
  const linked = { provider, kind: "issue" as const, number: 7, repo: "", url: "https://example.test/items/7" };
  const item = { ...linked, account: "chosen" } as InboxItem;
  const session = { linkedWorkItem: linked };
  expect(inboxItemMatchesLinkedWorkItem(item, linked)).toBe(false);
  expect(relatedFromIndex(item, indexByWorkItem([session], sessionWorkItems))).toEqual([]);
  const bound = bindLinkedWorkItemAccount(linked, linked, "chosen", "https://example.test");
  expect(bound).toMatchObject({ ...linked, account: "chosen", site: "https://example.test" });
  expect(inboxItemMatchesLinkedWorkItem(item, bound)).toBe(true);
  expect(bindLinkedWorkItemAccount(bound, linked, "another", "https://example.test")).toBe(bound);
});

it("rebinds only the chosen legacy link and retains saved context and other links", () => {
  const linked = { provider: "jira" as const, kind: "issue" as const, repo: "", number: 7, url: "https://example.test/items/7", context: "saved description" };
  const root = { kind: "issue" as const, repo: "org/repo", number: 1, url: "https://github.com/org/repo/issues/1", additionalItems: [linked] };
  const bound = bindLinkedWorkItemAccount(root, linked, "chosen", "https://example.test");
  expect(bound).toMatchObject({ ...root, additionalItems: [{ ...linked, account: "chosen", site: "https://example.test" }] });
  expect(root.additionalItems[0]).toBe(linked);
  expect(bindLinkedWorkItemAccount(root, { ...linked, url: "https://example.test/items/8" }, "chosen", "https://example.test")).toBe(root);
});
