// Compatibility imports for existing session, Board and Confluence consumers.
// All Jira IO and rendering now use the upstream Inbox client.
export { JIRA_CHANGE_EVENT, atlassianCapable, jiraConnected, jiraOptions,
  loadJiraFilter, saveJiraFilter, loadJiraRelationship, jiraFilterCacheKey,
  DEFAULT_JIRA_FILTER, jiraIssueSnapshot,
  type JiraStatus, type JiraOption, type JiraFilter } from "../../inbox/model/jira";
import type { InboxItem } from "../../inbox/model/githubTasks";
import { jiraIssueDetails, jiraIssueThread, peekJiraIssueDetails, peekJiraIssueThread } from "../../inbox/model/jira";
const issueKey = (item: Pick<InboxItem, "identifier" | "id">) => item.identifier || item.id || "";
export const jiraDetails = (item: InboxItem) => jiraIssueDetails(issueKey(item), item);
export const peekJiraDetails = (item: InboxItem) => peekJiraIssueDetails(issueKey(item), item);
export const peekJiraThread = (item: InboxItem) => {
  const thread = peekJiraIssueThread(issueKey(item), item);
  return thread ? { ...thread, commits: [] } : null;
};
export const jiraThread = async (item: InboxItem, force = false) => ({
  ...await jiraIssueThread(issueKey(item), { force, scope: item }), commits: [],
});
