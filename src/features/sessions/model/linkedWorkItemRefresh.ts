import type { InboxItem } from "../../inbox/model/githubTasks";
import { githubWorkItem } from "../../inbox/model/githubTasks";
import {
  azureDevOpsConnected,
  azureDevOpsRepo,
  listAzureDevOpsWorkItems,
  type AzureDevOpsKind,
} from "../../inbox/model/azureDevOps";
import { jiraConnected, jiraIssueSnapshot } from "./jira";
import type { LinkedWorkItem } from "./session";
import { linkedWorkItemNeedsAccount } from "./sessionWorkItem";

const providerOf = (linked: LinkedWorkItem) =>
  (linked.provider as string) === "azure"
    ? "azuredevops"
    : linked.provider ?? "github";

/**
 * Refresh one linked item when it does not appear in the Inbox listing —
 * e.g. assigned to someone else, filtered out, or in a closed state. Returns
 * null when the provider cannot identify or read it.
 */
export async function refreshLinkedWorkItem(
  cwd: string,
  linked: LinkedWorkItem,
): Promise<InboxItem | null> {
  if (linkedWorkItemNeedsAccount(linked)) return null;
  try {
    switch (providerOf(linked)) {
      case "gitlab":
      case "linear":
        return null;
      case "jira": {
        const id = linked.id ?? linked.identifier;
        const status = await jiraConnected();
        const site = linked.site ?? status.site;
        if (!status.connected || !status.accountId || (linked.account && linked.account !== status.accountId)) return null;
        if (!id || !site) return null;
        return await jiraIssueSnapshot(site, id, status.accountId);
      }
      case "azuredevops": {
        const status = await azureDevOpsConnected();
        if (!status.connected || !linked.number) return null;
        const kind: AzureDevOpsKind = linked.kind === "pr" ? "pr" : "issue";
        const repo = linked.repo || (cwd ? await azureDevOpsRepo(cwd) : "");
        if (!repo) return null;
        const items = await listAzureDevOpsWorkItems(cwd, {
          kind,
          assignedToMe: false,
          state: "all",
          limit: 500,
        });
        const item = items.find(
          (entry) =>
            entry.number === linked.number && entry.repo === repo,
        );
        return item
          ? { ...item, provider: "azuredevops", repo, projectPath: "" }
          : null;
      }
      default: {
        const item = await githubWorkItem(
          cwd,
          linked.repo,
          linked.kind,
          linked.number,
          { force: true },
        );
        return { ...item, provider: "github", projectPath: "" };
      }
    }
  } catch {
    return null;
  }
}
