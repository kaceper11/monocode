import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { clearInboxCache, type InboxItem } from "./githubTasks";
import { inboxRelationship, type InboxRelationship } from "./inboxFilters";
import { invoke } from "@tauri-apps/api/core";
import { recordInboxSelfActivity } from "./inboxSelfActivity";

export type JiraProject = {
  id: string;
  key: string;
  name: string;
};

export type JiraIssue = {
  parent?: JiraIssue;
  site?: string;
  account?: string;
  provider: "jira";
  kind: "jira";
  id: string;
  identifier: string;
  number: number;
  title: string;
  url: string;
  state: string;
  /** Jira status category: `new`, `indeterminate` or `done`. */
  stateType: string;
  updatedAt: string;
  labels: { name: string; color: string }[];
  assignees: { login: string; avatarUrl?: string }[];
  draft: boolean;
  repo: string;
  teamId: string;
  teamName: string;
  projectPath: string;
};

export type JiraIssueDetails = {
  attachments?: { id: string; name: string; mimeType: string }[];
  body: string;
  author: string;
  authorAvatarUrl?: string;
};

export type JiraIssueComment = {
  id: string;
  kind: string;
  author: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt: string;
  url: string;
  state: string;
  path: string;
  line: number | null;
  resolved: boolean;
  threadId: string;
  replies: JiraIssueComment[];
};

export type JiraIssueThread = {
  comments: JiraIssueComment[];
  truncated: boolean;
  reviewDecision: string;
  baseRefName: string;
  headRefName: string;
};

export type JiraStatus = {
  connected: boolean;
  site: string;
  email: string;
  account: string;
  accountId: string;
  capabilities: string[];
};

const PROJECT_IDS_KEY = "monocode.jiraHiddenProjects";
export const JIRA_CHANGE_EVENT = "monocode:jira-change";

// Keyed by issue key (ENG-42): the REST paths and browse URLs both take it.
const detailsByKey = new Map<string, JiraIssueDetails>();
const threadByKey = new Map<string, JiraIssueThread>();
const threadInflight = new Map<string, Promise<JiraIssueThread>>();

let cacheGeneration = 0;

export function clearJiraCache() {
  cacheGeneration += 1;
  detailsByKey.clear();
  threadByKey.clear();
  threadInflight.clear();
}

let connectionBridge: Promise<UnlistenFn | null> | null = null;
function connectionChanged() {
  clearInboxCache();
  window.dispatchEvent(
    new CustomEvent(JIRA_CHANGE_EVENT, { detail: "connection" }),
  );
}
function watchConnection() {
  return (connectionBridge ??= listen(
    JIRA_CHANGE_EVENT,
    connectionChanged,
  ).catch(() => {
    connectionBridge = null;
    return null;
  }));
}
import.meta.hot?.dispose(() => {
  void connectionBridge?.then((unlisten) => unlisten?.());
});
export async function jiraConnected(): Promise<JiraStatus> {
  await watchConnection();
  return invoke<JiraStatus>("jira_status");
}

export async function saveJiraConfig(config: {
  site: string;
  email: string;
  token: string;
}): Promise<JiraStatus> {
  const observing = await watchConnection();
  const status = await invoke<JiraStatus>("jira_set_config", {
    site: config.site.trim(),
    email: config.email.trim(),
    token: config.token.trim(),
  });
  clearJiraCache();
  if (!observing) connectionChanged();
  return status;
}

export async function disconnectJira(): Promise<JiraStatus> {
  const observing = await watchConnection();
  const status = await invoke<JiraStatus>("jira_set_config", {
    site: "",
    email: "",
    token: "",
  });
  clearJiraCache();
  if (!observing) connectionChanged();
  return status;
}

export function listJiraProjects(): Promise<JiraProject[]> {
  return invoke<JiraProject[]>("jira_list_projects");
}

/** `null` means do not filter by project. `[]` means every known project is hidden. */
export function jiraProjectIdsForFetch(
  projects: readonly JiraProject[],
  hiddenIds: readonly string[],
): string[] | null {
  if (hiddenIds.length === 0) return null;
  const hidden = new Set(hiddenIds);
  const visible = projects
    .filter((project) => !hidden.has(project.id))
    .map((project) => project.id);
  if (visible.length === projects.length) return null;
  return visible;
}

export async function listJiraIssues(query: {
  assignedToMe: boolean;
  state: "open" | "all";
  projectIds: string[];
  limit?: number;
  relationship?: Exclude<InboxRelationship, "reviewing">;
}): Promise<JiraIssue[]> {
  const status = await jiraConnected();
  const filter = loadJiraFilter(status.site);
  const generation = cacheGeneration;
  const issues = await invoke<JiraIssue[]>("jira_list_issues", {
    assignedToMe: query.assignedToMe,
    state: query.state,
    projectIds: query.projectIds,
    limit: query.limit,
    project: filter.project,
    filter: filter.filter,
    relationship: query.relationship,
  });
  if (generation !== cacheGeneration)
    throw new Error("Jira connection changed. Refresh and retry.");
  return issues;
}

export type JiraScope = { site?: string; account?: string };
function scopedKey(key: string, scope?: JiraScope) {
  return scope ? JSON.stringify([scope.site, scope.account, key]) : key;
}
async function requestScope(scope?: JiraScope) {
  if (scope) {
    if (!scope.site || !scope.account)
      throw new Error("Refresh and reselect the Jira ticket for this account.");
    return { site: scope.site, accountId: scope.account };
  }
  const status = await jiraConnected();
  return { site: status.site, accountId: status.accountId };
}
function retain<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
}

export function peekJiraIssueDetails(
  key: string,
  scope?: JiraScope,
): JiraIssueDetails | null {
  return detailsByKey.get(scopedKey(key, scope)) ?? null;
}

export async function jiraIssueDetails(
  key: string,
  scope?: JiraScope,
): Promise<JiraIssueDetails> {
  const generation = cacheGeneration;
  const details = await invoke<JiraIssueDetails>("jira_issue_details", {
    key,
    ...(await requestScope(scope)),
  });
  if (generation !== cacheGeneration)
    throw new Error("Jira connection changed. Refresh and retry.");
  retain(detailsByKey, scopedKey(key, scope), details);
  return details;
}

export function peekJiraIssueThread(
  key: string,
  scope?: JiraScope,
): JiraIssueThread | null {
  return threadByKey.get(scopedKey(key, scope)) ?? null;
}

export async function jiraIssueThread(
  key: string,
  options?: { force?: boolean; scope?: JiraScope },
): Promise<JiraIssueThread> {
  const cacheKey = scopedKey(key, options?.scope);
  const scope = await requestScope(options?.scope);
  if (options?.force) {
    threadByKey.delete(cacheKey);
    threadInflight.delete(cacheKey);
  }
  const pending = threadInflight.get(cacheKey);
  if (pending) return pending;
  const generation = cacheGeneration;
  const promise = invoke<JiraIssueThread>("jira_issue_thread", {
    key,
    ...scope,
  })
    .then((thread) => {
      if (
        generation === cacheGeneration &&
        threadInflight.get(cacheKey) === promise
      ) {
        retain(threadByKey, cacheKey, thread);
      }
      if (generation !== cacheGeneration)
        throw new Error("Jira connection changed. Refresh and retry.");
      return thread;
    })
    .finally(() => {
      if (threadInflight.get(cacheKey) === promise)
        threadInflight.delete(cacheKey);
    });
  threadInflight.set(cacheKey, promise);
  return promise;
}

export async function jiraIssueComment(
  issue: { id: string; key: string } & JiraScope,
  body: string,
): Promise<string> {
  const url = await invoke<string>("jira_issue_comment", {
    key: issue.key,
    ...(await requestScope(issue)),
    body: body.trim(),
  });
  threadByKey.delete(scopedKey(issue.key, issue));
  threadInflight.delete(scopedKey(issue.key, issue));
  recordInboxSelfActivity({ provider: "jira", kind: "jira", id: issue.id, site: issue.site, account: issue.account });
  return url;
}

export function loadHiddenJiraProjectIds(): string[] {
  try {
    const raw = localStorage.getItem(PROJECT_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
  } catch {
    return [];
  }
}

export function saveHiddenJiraProjectIds(ids: string[]) {
  try {
    localStorage.setItem(PROJECT_IDS_KEY, JSON.stringify(ids));
  } catch {
    // private mode / quota
  }
  notifyJiraChange();
}

export function notifyJiraChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(JIRA_CHANGE_EVENT));
}

export type JiraOption = { id: string; name: string };
export type JiraFilter = {
  project: string;
  filter: string;
  assigned: boolean;
  relationship?: Exclude<InboxRelationship, "reviewing">;
};
export const DEFAULT_JIRA_FILTER: JiraFilter = {
  project: "",
  filter: "",
  assigned: true,
  relationship: "related",
};
const FILTER_KEY = "monocode.jiraFilter";
export function jiraFilterCacheKey(): string {
  try {
    return localStorage.getItem(FILTER_KEY) ?? "";
  } catch {
    return "";
  }
}
export function loadJiraRelationship(): Exclude<
  InboxRelationship,
  "reviewing"
> {
  try {
    const value = inboxRelationship(
      JSON.parse(jiraFilterCacheKey() || "null")?.relationship,
    );
    return value === "reviewing" ? "related" : value;
  } catch {
    return "related";
  }
}
/** Capability gating: an empty list means the connection predates capability
 * tracking — treat the product as unknown and let requests decide. */
export function atlassianCapable(
  status: Pick<JiraStatus, "capabilities">,
  product: "Jira" | "Confluence",
): boolean {
  const capabilities = status.capabilities ?? [];
  return !capabilities.length || capabilities.includes(product);
}
export function loadJiraFilter(site: string): JiraFilter {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null");
    if (saved?.site !== site) return DEFAULT_JIRA_FILTER;
    const relationship = inboxRelationship(saved.relationship);
    return {
      project:
        typeof saved.project === "string" && /^\d*$/.test(saved.project)
          ? saved.project
          : "",
      filter:
        typeof saved.filter === "string" && /^\d*$/.test(saved.filter)
          ? saved.filter
          : "",
      assigned: saved.assigned !== false,
      relationship: relationship === "reviewing" ? "related" : relationship,
    };
  } catch {
    return DEFAULT_JIRA_FILTER;
  }
}
export function saveJiraFilter(site: string, filter: JiraFilter) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ site, ...filter }));
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new Event(JIRA_CHANGE_EVENT));
}
export async function jiraOptions(
  site: string,
  favorites: boolean,
  accountId: string,
): Promise<JiraOption[]> {
  return invoke("jira_options", { site, favorites, accountId });
}

/** Preserve site/account identity on existing Board and session records. */
export function jiraIssueToInboxItem(issue: JiraIssue): InboxItem {
  return { ...issue, projectId: issue.teamId, projectName: issue.teamName };
}
export async function jiraIssueSnapshot(
  site: string,
  id: string,
  accountId: string,
): Promise<InboxItem> {
  const generation = cacheGeneration;
  const issue = await invoke<JiraIssue>("jira_issue_snapshot", {
    site,
    id,
    accountId,
  });
  if (generation !== cacheGeneration)
    throw new Error("Jira connection changed. Refresh and retry.");
  return jiraIssueToInboxItem(issue);
}

/** Show a saved single-project choice accurately until the user changes it. */
export function effectiveHiddenJiraProjects(
  projects: readonly JiraProject[],
  hiddenIds: readonly string[],
  legacyProject: string,
): string[] {
  return legacyProject
    ? projects
        .filter(
          (project) =>
            project.id !== legacyProject || hiddenIds.includes(project.id),
        )
        .map((project) => project.id)
    : [...hiddenIds];
}
