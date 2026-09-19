import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  GithubWorkItemDetails,
  GithubWorkItemThread,
  InboxItem,
} from "./githubTasks";

export type JiraStatus = {
  connected: boolean;
  site: string;
  account: string;
  accountId: string;
  /** Atlassian products verified for the saved credential. Empty means the
   * connection predates capability tracking — treat as unknown. */
  capabilities: string[];
};
export type JiraOption = { id: string; name: string };
export type JiraFilter = { project: string; filter: string; assigned: boolean };
export const DEFAULT_JIRA_FILTER: JiraFilter = {
  project: "",
  filter: "",
  assigned: true,
};
export const JIRA_CHANGE_EVENT = "monocode:jira-change";
const FILTER_KEY = "monocode.jiraFilter";
export function jiraFilterCacheKey(): string {
  try {
    return localStorage.getItem(FILTER_KEY) ?? "";
  } catch {
    return "";
  }
}
let generation = 0;
const details = new Map<string, GithubWorkItemDetails>();
const threads = new Map<string, GithubWorkItemThread>();
function connectionChanged() {
  generation++;
  details.clear();
  threads.clear();
  window.dispatchEvent(new CustomEvent(JIRA_CHANGE_EVENT, { detail: "connection" }));
}
let connectionBridge: Promise<UnlistenFn | null> | null = null;
function watchConnection() {
  return connectionBridge ??= listen(JIRA_CHANGE_EVENT, connectionChanged).catch(() => {
    connectionBridge = null;
    return null;
  });
}
import.meta.hot?.dispose(() => { void connectionBridge?.then(unlisten => unlisten?.()); });

export async function jiraConnected(): Promise<JiraStatus> {
  await watchConnection();
  return invoke("jira_status");
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
export async function saveJiraConfig(
  site: string,
  email: string,
  token: string,
): Promise<JiraStatus> {
  const observing = await watchConnection();
  const status = await invoke<JiraStatus>("jira_set_config", {
    site,
    email,
    token,
  });
  // Native broadcasts invalidate every window, including the caller.
  if (!observing) connectionChanged();
  return status;
}
export function loadJiraFilter(site: string): JiraFilter {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null");
    if (saved?.site !== site) return DEFAULT_JIRA_FILTER;
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

type JiraNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: JiraNode[];
  content?: JiraNode[];
};
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");
}
function safeLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return null;
  }
}

/** Common ADF blocks become existing Markdown; media remains an explicit placeholder. */
export function jiraMarkdown(value: unknown): string {
  let remaining = 64_000;
  let nodes = 0;
  let truncated = typeof value === "string" && value.length > 64_000;
  function render(node: JiraNode, depth: number): string {
    if (!node || typeof node !== "object") return "";
    if (depth > 32 || remaining <= 0 || ++nodes > 10_000) {
      truncated = true;
      return "";
    }
    if (node.type === "text") {
      const raw =
        typeof node.text === "string" ? node.text.slice(0, remaining) : "";
      remaining -= raw.length;
      let text = escapeMarkdown(raw);
      for (const mark of Array.isArray(node.marks) ? node.marks : []) {
        if (mark.type === "strong") text = `**${text}**`;
        if (mark.type === "em") text = `_${text}_`;
        if (mark.type === "strike") text = `~~${text}~~`;
        if (mark.type === "code") text = `\`\`${raw.replace(/`/g, "ˋ")}\`\``;
        if (mark.type === "link") {
          const url = safeLink(mark.attrs?.href);
          if (url) text = `[${text}](${url})`;
        }
      }
      return text;
    }
    const children = Array.isArray(node.content) ? node.content : [];
    const body = children.map((child) => render(child, depth + 1)).join("");
    switch (node.type) {
      case "hardBreak":
        return "\n";
      case "paragraph":
        return `${body}\n\n`;
      case "heading":
        return `${"#".repeat(Math.max(1, Math.min(6, Number(node.attrs?.level) || 1)))} ${body}\n\n`;
      case "bulletList":
        return `${body}\n`;
      case "orderedList": {
        let index = Math.max(1, Number(node.attrs?.order) || 1);
        return `${body.replace(/^- /gm, () => `${index++}. `)}\n`;
      }
      case "listItem":
        return `- ${body.trim().replace(/\n/g, "\n  ")}\n`;
      case "blockquote":
        return `${body
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`;
      case "codeBlock":
        return `\`\`\`\n${children
          .map((child) =>
            typeof child.text === "string" ? child.text.slice(0, 64_000) : "",
          )
          .join("")
          .replace(/```/g, "ˋˋˋ")}\n\`\`\`\n\n`;
      case "rule":
        return "\n---\n";
      case "mention":
        return escapeMarkdown(String(node.attrs?.text ?? "Mention"));
      case "emoji":
        return escapeMarkdown(
          String(node.attrs?.text ?? node.attrs?.shortName ?? ""),
        );
      case "inlineCard": {
        const url = safeLink(node.attrs?.url);
        return url ? `[Link](${url})` : "[Link unavailable]";
      }
      case "media":
        return "[Attachment — open in Jira]";
      case "tableCell":
      case "tableHeader":
        return `${body.trim()} | `;
      case "tableRow":
        return `${body}\n`;
      default:
        return body;
    }
  }
  const text =
    typeof value === "string"
      ? escapeMarkdown(value.slice(0, 64_000))
      : render(value as JiraNode, 0);
  return `${text.slice(0, 64_000).trim()}${truncated || remaining <= 0 || text.length > 64_000 ? "\n\n[Truncated — open in Jira for full content]" : ""}`;
}

type IssueResponse = {
  id: string;
  key: string;
  fields: {
    summary?: string;
    updated?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    project?: { id?: string; name?: string; key?: string };
    labels?: string[];
    assignee?: { displayName?: string };
    description?: unknown;
    attachment?: { id: string; filename: string; mimeType: string }[];
    creator?: { displayName?: string };
  };
};
export function jiraIssue(site: string, issue: IssueResponse): InboxItem {
  const f = issue.fields;
  return {
    provider: "jira",
    kind: "jira",
    id: issue.id,
    identifier: issue.key,
    number: Number(issue.key.split("-").slice(-1)[0]) || 0,
    title: f.summary ?? issue.key,
    url: `${site}/browse/${encodeURIComponent(issue.key)}`,
    site,
    state: f.status?.name ?? "Unknown",
    stateType: f.status?.statusCategory?.key ?? "unknown",
    updatedAt: f.updated ?? "",
    projectId: f.project?.id ?? "",
    projectName: f.project?.name ?? f.project?.key ?? "",
    labels: (f.labels ?? []).slice(0, 20).map((name) => ({ name, color: "" })),
    assignees: f.assignee?.displayName
      ? [{ login: f.assignee.displayName }]
      : [],
    repo: "",
    projectPath: "",
    draft: false,
  };
}
export async function listJiraIssues(
  site: string,
  state: "open" | "all",
  accountId: string,
  filter?: JiraFilter,
): Promise<InboxItem[]> {
  const before = generation;
  const result = await invoke<{ site: string; issues: IssueResponse[] }>(
    "jira_list_issues",
    { site, state, accountId, ...(filter ?? loadJiraFilter(site)) },
  );
  if (before !== generation)
    throw new Error("Jira connection changed. Refresh and retry.");
  return result.issues.map((issue) => ({ ...jiraIssue(result.site, issue), account: accountId }));
}
function key(item: Pick<InboxItem, "site" | "id" | "account">) {
  return JSON.stringify([item.account, item.site, item.id]);
}
function retain<T>(cache: Map<string, T>, id: string, value: T) {
  cache.delete(id);
  cache.set(id, value);
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
}
/** Single-issue read used to refresh linked sessions outside the Inbox listing. */
export async function jiraIssueSnapshot(
  site: string,
  id: string,
  accountId: string,
): Promise<InboxItem> {
  const before = generation;
  const response = await invoke<IssueResponse>("jira_issue_snapshot", {
    site,
    id,
    accountId,
  });
  if (before !== generation)
    throw new Error("Jira connection changed. Refresh and retry.");
  return { ...jiraIssue(site, response), account: accountId };
}

export function peekJiraDetails(item: InboxItem) {
  return details.get(key(item)) ?? null;
}
export function peekJiraThread(item: InboxItem) {
  return threads.get(key(item)) ?? null;
}
export async function jiraDetails(
  item: InboxItem,
): Promise<GithubWorkItemDetails> {
  const before = generation;
  const response = await invoke<IssueResponse>("jira_issue_content", {
    site: item.site,
    id: item.id,
    accountId: item.account ?? "",
    comments: false,
  });
  if (before !== generation)
    throw new Error("Jira connection changed. Refresh and retry.");
  const result = {
    body: jiraMarkdown(response.fields.description),
    author: response.fields.creator?.displayName ?? "",
    attachments: (response.fields.attachment ?? [])
      .slice(0, 200)
      .filter((file) => /^\d+$/.test(file.id))
      .map((file) => ({
        id: file.id,
        name: file.filename,
        mimeType: file.mimeType,
      })),
  };
  retain(details, key(item), result);
  return result;
}
export async function jiraThread(
  item: Pick<InboxItem, "site" | "id" | "url" | "account">,
): Promise<GithubWorkItemThread> {
  const before = generation;
  const response = await invoke<{
    total: number;
    comments: {
      id: string;
      body: unknown;
      created: string;
      author?: { displayName?: string };
    }[];
  }>("jira_issue_content", { site: item.site, id: item.id, accountId: item.account ?? "", comments: true });
  if (before !== generation)
    throw new Error("Jira connection changed. Refresh and retry.");
  const result: GithubWorkItemThread = {
    comments: response.comments
      .slice(0, 50)
      .reverse()
      .map((comment) => ({
        id: comment.id,
        body: jiraMarkdown(comment.body),
        author: comment.author?.displayName ?? "Unknown",
        createdAt: comment.created,
        url: item.url,
        kind: "comment",
        state: "",
        path: "",
        line: null,
        resolved: false,
        threadId: "",
        replies: [],
      })),
    commits: [],
    truncated: response.total > response.comments.length,
    reviewDecision: "",
    baseRefName: "",
    headRefName: "",
  };
  retain(threads, key(item), result);
  return result;
}
