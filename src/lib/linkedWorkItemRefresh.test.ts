import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { refreshLinkedWorkItem } from "./linkedWorkItemRefresh";
import type { LinkedWorkItem } from "./session";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => { vi.mocked(invoke).mockReset(); });

it.each([['jira', 'issue'], ['azure', 'issue'], ['azure', 'pr']] as const)("never chooses the current account for an unbound legacy %s %s", async (provider, kind) => {
  vi.mocked(invoke).mockResolvedValue({ connected: true, accountId: "new-account", site: "https://dev.azure.com/team" });
  expect(await refreshLinkedWorkItem("/repo", {
    provider, kind, repo: "repo", number: 7, id: "7",
    url: "https://dev.azure.com/team/project/_git/repo/pullrequest/7",
  })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it.each(["jira", "azure"] as const)("does not relabel another %s account's data as the saved account", async provider => {
  const site = provider === "jira" ? "https://team.atlassian.net" : "https://dev.azure.com/team";
  const linked: LinkedWorkItem = { provider, kind: "issue", repo: "", number: 7, id: "7", url: `${site}/items/7`, site, account: "account-a" };
  vi.mocked(invoke).mockResolvedValue({ connected: true, site, accountId: "account-b", account: "Same display name" });
  expect(await refreshLinkedWorkItem("/repo", linked)).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([method]) => method)).toEqual([`${provider}_status`]);
});

it("contains a failed Azure PR read so other linked items can refresh", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("Account changed"));
  const linked: LinkedWorkItem = {
    provider: "azure", kind: "pr", repo: "repo", number: 7,
    account: "account-a", url: "https://dev.azure.com/team/project/_git/repo/pullrequest/7",
  };
  expect(await refreshLinkedWorkItem("/repo", linked)).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("reads all bounded Azure activity stamps once and compares actual times", async () => {
  const target = { provider: "azure" as const, kind: "pr" as const, repo: "repo", number: 7,
    account: "account-a", url: "https://dev.azure.com/team/project/_git/repo/pullrequest/7" };
  vi.mocked(invoke).mockImplementation(async (_method, args) => {
    expect(args).toMatchObject({ section: "activity", target: { accountId: "account-a", number: 7 } });
    return { pr: { pullRequestId: 7, title: "Review", status: "future", creationDate: "2026-09-13T09:00:00Z" },
      activityDates: ["invalid", "2026-09-13T11:00:00+03:00", "2026-09-13T10:00:00Z"] };
  });
  expect(await refreshLinkedWorkItem("/repo", target)).toMatchObject({
    account: "account-a", state: "unknown", updatedAt: "2026-09-13T10:00:00.000Z",
  });
  expect(invoke).toHaveBeenCalledTimes(1);
});
