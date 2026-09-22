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
): Promise<InboxListResult> {
  return listJira(state, assignedToMe);
}

async function listJira(
  state: "open" | "all",
  assignedToMe: boolean,
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
    // The shared "my work" flag narrows Jira too — a wider stored filter
    // (e.g. a saved filter, which clears `assigned`) must not leak
    // unassigned tickets into an assigned-only listing like the board's.
    const stored = loadJiraFilter(status.site);
    const items = atlassianCapable(status, "Jira")
      ? await listJiraIssues(status.site, state, status.accountId, {
          ...stored,
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
