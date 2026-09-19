import { atlassianCapable, jiraConnected, listJiraIssues, jiraFilterCacheKey } from "./jira";
import { azureConnected, listAzureItems, azureFilterCacheKey } from "./azure";
import { listAzureDelivery } from "./azureInbox";
import type { InboxItem, InboxListResult } from "./githubTasks";

export function inboxIntegrationCacheKey(): string {
  return `${jiraFilterCacheKey()}:${azureFilterCacheKey()}`;
}

/** Add the selected service integrations without replacing upstream listing. */
export async function listInboxIntegrations(state: "open" | "all"): Promise<InboxListResult> {
  const [jira, azure] = await Promise.all([listJira(state), listAzure(state)]);
  return { items: [...jira.items, ...azure.items], errors: { ...jira.errors, ...azure.errors } };
}

async function listJira(state: "open" | "all"): Promise<InboxListResult> {
  try {
    const status = await jiraConnected();
    if (!status.connected) return { items: [], errors: { jira: "Connect Jira Cloud in Settings to see assigned issues." } };
    const items = atlassianCapable(status, "Jira")
      ? await listJiraIssues(status.site, state, status.accountId)
      : [];
    return { items, errors: {} };
  } catch (error) {
    return { items: [], errors: { jira: errorMessage(error) } };
  }
}

async function listAzure(state: "open" | "all"): Promise<InboxListResult> {
  try {
    const status = await azureConnected();
    if (!status.connected) return { items: [], errors: { azure: "Connect Azure DevOps in Settings to see work items." } };
    const [boards, delivery] = await Promise.allSettled([listAzureItems(status), listAzureDelivery(status, state)]);
    const items: InboxItem[] = [];
    const failures: string[] = [];
    if (boards.status === "fulfilled") items.push(...boards.value);
    else failures.push(`Boards: ${errorMessage(boards.reason)}`);
    if (delivery.status === "fulfilled") {
      items.push(...delivery.value.items);
      failures.push(...delivery.value.errors);
    } else failures.push(`Delivery: ${errorMessage(delivery.reason)}`);
    return { items, errors: failures.length ? { azure: failures.join(" ") } : {} };
  } catch (error) {
    return { items: [], errors: { azure: errorMessage(error) } };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
