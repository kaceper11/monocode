import type { InboxItem } from "./githubTasks";
import { githubWorkItem } from "./githubTasks";
import { azureConnected, azureItemSnapshot } from "./azure";
import {
  parseAzurePrLocation,
  readAzurePrActivity,
  type AzurePrTarget,
} from "./azureRepos";
import { jiraConnected, jiraIssueSnapshot } from "./jira";
import type { LinkedWorkItem } from "./session";
import { linkedWorkItemNeedsAccount } from "./sessionWorkItem";

const providerOf = (linked: LinkedWorkItem) => linked.provider ?? "github";

async function azurePrTarget(
  linked: LinkedWorkItem,
): Promise<AzurePrTarget | null> {
  try {
    const location = parseAzurePrLocation(linked.url);
    if (!linked.account) return null;
    const accountId = linked.account;
    return { ...location, accountId };
  } catch {
    return null;
  }
}

function azurePrSnapshotState(status: string): {
  state: string;
  stateType: string;
} {
  const normalized = status.trim().toLowerCase();
  if (normalized === "completed") return { state: "merged", stateType: "completed" };
  if (normalized === "abandoned") return { state: "closed", stateType: "removed" };
  if (normalized === "active") return { state: "open", stateType: "inProgress" };
  return { state: "unknown", stateType: "unknown" };
}

async function azurePrSnapshot(
  linked: LinkedWorkItem,
): Promise<InboxItem | null> {
  const target = await azurePrTarget(linked);
  if (!target) return null;
  const { pr, activityDates } = await readAzurePrActivity(target);
  const { state, stateType } = azurePrSnapshotState(pr.status);
  const latest = [...activityDates, pr.closedDate ?? "", pr.creationDate ?? ""]
    .reduce((latest, stamp) => {
      const timestamp = Date.parse(stamp);
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
    }, 0);
  const updatedAt = latest ? new Date(latest).toISOString() : "";
  return {
    provider: "azure",
    account: target.accountId,
    kind: "pr",
    id: String(pr.pullRequestId),
    number: pr.pullRequestId,
    identifier: `PR #${pr.pullRequestId}`,
    title: pr.title,
    url: linked.url,
    site: target.site,
    state,
    stateType,
    updatedAt,
    labels: [],
    assignees: [],
    draft: Boolean(pr.isDraft),
    repo: pr.repositoryName || linked.repo,
    projectName: pr.projectName || "",
    projectPath: "",
  };
}

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
      case "azure": {
        if (linked.kind === "pr") return await azurePrSnapshot(linked);
        const id = linked.id ?? String(linked.number);
        const status = await azureConnected();
        const site = linked.site ?? status.site;
        if (!status.connected || !site || !status.accountId || (linked.account && linked.account !== status.accountId)) return null;
        return await azureItemSnapshot(site, id, status.accountId);
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
