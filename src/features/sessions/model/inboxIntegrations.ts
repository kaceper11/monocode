import {
  atlassianCapable,
  jiraConnected,
  listJiraIssues,
  jiraFilterCacheKey,
} from "./jira";
import type { InboxListResult } from "../../inbox/model/githubTasks";

export function inboxIntegrationCacheKey(): string {
  return jiraFilterCacheKey();
}

/** Add the selected service integrations without replacing upstream listing. */
export async function listInboxIntegrations(
  state: "open" | "all",
): Promise<InboxListResult> {
  return listJira(state);
}

async function listJira(state: "open" | "all"): Promise<InboxListResult> {
  try {
    const status = await jiraConnected();
    if (!status.connected)
      return {
        items: [],
        errors: {
          jira: "Connect Jira Cloud in Settings to see assigned issues.",
        },
      };
    const items = atlassianCapable(status, "Jira")
      ? await listJiraIssues(status.site, state, status.accountId)
      : [];
    return { items, errors: {} };
  } catch (error) {
    return { items: [], errors: { jira: errorMessage(error) } };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
