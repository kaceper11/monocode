import type { InboxRelationship } from "../../inbox/model/inboxFilters";
import {
  atlassianCapable,
  jiraConnected,
  listJiraIssues,
  jiraFilterCacheKey,
  loadJiraFilter,
} from "./jira";
import type { InboxListResult } from "../../inbox/model/githubTasks";

export function inboxIntegrationCacheKey(): string {
  return jiraFilterCacheKey();
}

/** Add the selected service integrations without replacing upstream listing. */
export async function listInboxIntegrations(
  state: "open" | "all",
  assignedToMe: boolean,
  relationship?: Exclude<InboxRelationship, "reviewing">,
): Promise<InboxListResult> {
  return listJira(state, assignedToMe, relationship);
}

async function listJira(
  state: "open" | "all",
  assignedToMe: boolean,
  relationship?: Exclude<InboxRelationship, "reviewing">,
): Promise<InboxListResult> {
  try {
    const status = await jiraConnected();
    if (!status.connected)
      return {
        items: [],
        errors: {
          jira: "Connect Jira Cloud in Settings to see assigned issues.",
        },
      };
    // Explicit Inbox choices are independent of the shared flag. Legacy
    // callers such as Board retain their assigned-only behavior.
    const stored = loadJiraFilter(status.site);
    const items = atlassianCapable(status, "Jira")
      ? await listJiraIssues(status.site, state, status.accountId, {
          ...stored,
          relationship,
          assigned: stored.assigned || assignedToMe,
        })
      : [];
    return { items, errors: {} };
  } catch (error) {
    return { items: [], errors: { jira: errorMessage(error) } };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
