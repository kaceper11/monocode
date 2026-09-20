import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { refreshLinkedWorkItem } from "./linkedWorkItemRefresh";
import type { LinkedWorkItem } from "./session";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => { vi.mocked(invoke).mockReset(); });

it("never chooses the current account for an unbound legacy jira issue", async () => {
  vi.mocked(invoke).mockResolvedValue({ connected: true, accountId: "new-account", site: "https://team.atlassian.net" });
  expect(await refreshLinkedWorkItem("/repo", {
    provider: "jira", kind: "issue", repo: "", number: 7, id: "ENG-7",
    url: "https://team.atlassian.net/browse/ENG-7",
  })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it("does not relabel another jira account's data as the saved account", async () => {
  const site = "https://team.atlassian.net";
  const linked: LinkedWorkItem = { provider: "jira", kind: "issue", repo: "", number: 7, id: "ENG-7", url: `${site}/browse/ENG-7`, site, account: "account-a" };
  vi.mocked(invoke).mockResolvedValue({ connected: true, site, accountId: "account-b", account: "Same display name" });
  expect(await refreshLinkedWorkItem("/repo", linked)).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([method]) => method)).toEqual(["jira_status"]);
});

it.each(["azure", "azuredevops"] as const)("refreshes a linked %s item through the configured organization", async (provider) => {
  const linked: LinkedWorkItem = {
    provider: provider as LinkedWorkItem["provider"], kind: "issue", repo: "repo", number: 7,
    url: "https://dev.azure.com/team/project/_workitems/edit/7",
  };
  vi.mocked(invoke).mockImplementation(async (method) => {
    if (method === "azure_devops_status")
      return { connected: true, url: "https://dev.azure.com/team", organization: "team" };
    if (method === "azure_devops_list_work_items")
      return [
        { kind: "issue", number: 7, title: "Linked", url: linked.url, state: "Active", updatedAt: "2026-09-13T10:00:00Z", labels: [], assignees: [], draft: false, repo: "repo", attentionReason: "" },
        { kind: "issue", number: 8, title: "Other", url: "https://dev.azure.com/team/project/_workitems/edit/8", state: "New", updatedAt: "", labels: [], assignees: [], draft: false, repo: "repo", attentionReason: "" },
      ];
    throw new Error(`unexpected ${method}`);
  });
  expect(await refreshLinkedWorkItem("/repo", linked)).toMatchObject({
    provider: "azuredevops", number: 7, title: "Linked", state: "Active",
    updatedAt: "2026-09-13T10:00:00Z",
  });
});

it("contains a failed Azure DevOps read so other linked items can refresh", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("Connection changed"));
  const linked: LinkedWorkItem = {
    provider: "azuredevops", kind: "pr", repo: "repo", number: 7,
    url: "https://dev.azure.com/team/project/_git/repo/pullrequest/7",
  };
  expect(await refreshLinkedWorkItem("/repo", linked)).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});
