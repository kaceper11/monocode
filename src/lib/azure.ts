import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  GithubWorkItemDetails,
  GithubWorkItemThread,
  InboxItem,
} from "./githubTasks";

export type AzureStatus = {
  connected: boolean;
  site: string;
  project: string;
  account: string;
  accountId?: string;
  capabilities: string[];
};
export type AzureFilter = { project: string; query: string; assigned: boolean };
export type AzureOption = { id: string; name: string };
export const AZURE_CHANGE_EVENT = "monocode:azure-change";
const FILTER_KEY = "monocode.azureFilter";
let generation = 0;
const details = new Map<string, GithubWorkItemDetails>();
const threads = new Map<string, GithubWorkItemThread>();
function connectionChanged() {
  generation++;
  details.clear();
  threads.clear();
  window.dispatchEvent(new CustomEvent(AZURE_CHANGE_EVENT, { detail: "connection" }));
}
let connectionBridge: Promise<UnlistenFn | null> | null = null;
function watchConnection() {
  return connectionBridge ??= listen(AZURE_CHANGE_EVENT, connectionChanged).catch(() => {
    connectionBridge = null;
    return null;
  });
}
import.meta.hot?.dispose(() => { void connectionBridge?.then(unlisten => unlisten?.()); });
export async function azureConnected() {
  await watchConnection();
  return invoke<AzureStatus>("azure_status");
}
export async function saveAzureConfig(
  site: string,
  project: string,
  token: string,
) {
  const observing = await watchConnection();
  const status = await invoke<AzureStatus>("azure_set_config", {
    site,
    project,
    token,
  });
  // Native broadcasts invalidate every window, including the caller.
  if (!observing) connectionChanged();
  return status;
}
export function azureFilterCacheKey() {
  try {
    return localStorage.getItem(FILTER_KEY) ?? "";
  } catch {
    return "";
  }
}
export function loadAzureFilter(site: string, project: string): AzureFilter {
  try {
    const saved = JSON.parse(azureFilterCacheKey() || "{}")[site];
    return {
      project:
        typeof saved?.project === "string" && saved.project
          ? saved.project
          : project,
      query: typeof saved?.query === "string" ? saved.query : "",
      assigned: saved?.assigned !== false,
    };
  } catch {
    return { project, query: "", assigned: true };
  }
}
export function saveAzureFilter(site: string, filter: AzureFilter) {
  try {
    const saved = JSON.parse(azureFilterCacheKey() || "{}");
    localStorage.setItem(
      FILTER_KEY,
      JSON.stringify(
        Object.fromEntries([
          ...Object.entries(saved)
            .filter(([key]) => key !== site)
            .slice(-19),
          [site, filter],
        ]),
      ),
    );
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new Event(AZURE_CHANGE_EVENT));
}
export function azureOptions(site: string, project: string, queries: boolean, accountId: string) {
  return invoke<AzureOption[]>("azure_options", { site, project, queries, accountId });
}

/** Template contents stay inert, including image/frame loads; never attach this template. */
export function azureMarkdown(html: unknown): string {
  if (typeof html !== "string") return "";
  const template = document.createElement("template");
  template.innerHTML = html.slice(0, 128_000);
  let nodes = 0;
  const escape = (s: string) => s.replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");
  function render(node: Node, depth = 0): string {
    if (++nodes > 10_000 || depth > 32) return "";
    if (node.nodeType === 3) return escape(node.textContent ?? "");
    if (!(node instanceof Element)) return "";
    const tag = node.tagName.toLowerCase();
    if (
      [
        "script",
        "style",
        "iframe",
        "object",
        "embed",
        "svg",
        "math",
        "template",
      ].includes(tag)
    )
      return "";
    if (tag === "img")
      return `[Image: ${escape(node.getAttribute("alt") || "see attachments")}]`;
    const body = Array.from(node.childNodes)
      .map((n) => render(n, depth + 1))
      .join("");
    if (tag === "br") return "\n";
    if (["p", "div", "section", "table", "tr", "ul", "ol"].includes(tag))
      return `${body}\n\n`;
    if (tag === "li") return `- ${body.trim()}\n`;
    if (["strong", "b"].includes(tag)) return `**${body}**`;
    if (["em", "i"].includes(tag)) return `_${body}_`;
    if (/^h[1-6]$/.test(tag))
      return `${"#".repeat(Number(tag[1]))} ${body}\n\n`;
    if (tag === "a") {
      try {
        const url = new URL(node.getAttribute("href") ?? "");
        if (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        )
          return `[${body}](${url.href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
      } catch {
        /* preserve text without unsafe href */
      }
    }
    return body;
  }
  const result = Array.from(template.content.childNodes)
    .map((n) => render(n))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return (
    result.slice(0, 64_000) +
    (html.length > 128_000 || result.length > 64_000 || nodes > 10_000
      ? "\n\n[Truncated — open in Azure DevOps for full content]"
      : "")
  );
}
type WorkItem = {
  id: number;
  stateCategory?: string;
  fields: Record<string, unknown>;
  attachments?: { id: string; name: string; mimeType: string }[];
  relations?: {
    rel: string;
    url: string;
    attributes?: { name?: string; resourceSize?: number };
  }[];
};
const field = (item: WorkItem, name: string) =>
  typeof item.fields[name] === "string" ? (item.fields[name] as string) : "";
export function azureItem(site: string, item: WorkItem): InboxItem {
  const project = field(item, "System.TeamProject");
  const type = field(item, "System.WorkItemType") || "Work item";
  const assignee = item.fields["System.AssignedTo"] as
    { displayName?: string } | undefined;
  return {
    provider: "azure",
    kind: "azure",
    id: String(item.id),
    number: item.id,
    identifier: `${type} ${item.id}`,
    title: field(item, "System.Title"),
    site,
    url: `${site}/${encodeURIComponent(project).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}/_workitems/edit/${item.id}`,
    projectName: project,
    projectId: project,
    state: field(item, "System.State") || "Unknown",
    stateType: item.stateCategory ?? "unknown",
    updatedAt: field(item, "System.ChangedDate"),
    labels: field(item, "System.Tags")
      .split(";")
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((name) => ({ name, color: "" })),
    assignees: assignee?.displayName ? [{ login: assignee.displayName }] : [],
    repo: "",
    projectPath: "",
    draft: false,
  };
}
export async function listAzureItems(
  status: AzureStatus,
  filter?: AzureFilter,
): Promise<InboxItem[]> {
  const before = generation;
  const result = await invoke<{ site: string; items: WorkItem[] }>(
    "azure_list_items",
    {
      site: status.site,
      accountId: status.accountId ?? "",
      ...(filter ?? loadAzureFilter(status.site, status.project)),
    },
  );
  if (generation !== before)
    throw new Error("Azure connection changed. Refresh and retry.");
  return result.items.map((item) => ({ ...azureItem(result.site, item), account: status.accountId }));
}
function retain<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
}
function itemCacheKey(item: Pick<InboxItem, "account" | "url">): string {
  return JSON.stringify([item.account, item.url]);
}
export const peekAzureDetails = (item: InboxItem) =>
  details.get(itemCacheKey(item)) ?? null;
export const peekAzureThread = (item: InboxItem) =>
  threads.get(itemCacheKey(item)) ?? null;
export function azureDescription(item: WorkItem) {
  return [
    "System.Description",
    "Microsoft.VSTS.TCM.ReproSteps",
    "Microsoft.VSTS.Common.AcceptanceCriteria",
  ]
    .map((name) => {
      const body = azureMarkdown(field(item, name));
      return body && name !== "System.Description"
        ? `### ${name.endsWith("ReproSteps") ? "Reproduction steps" : "Acceptance criteria"}\n\n${body}`
        : body;
    })
    .filter(Boolean)
    .join("\n\n");
}
/** Single work-item read used to refresh linked sessions outside the Inbox listing. */
export async function azureItemSnapshot(
  site: string,
  id: string,
  accountId: string,
): Promise<InboxItem> {
  const before = generation;
  const raw = await invoke<WorkItem>("azure_item_content", {
    site,
    id,
    accountId,
    discussion: false,
  });
  if (before !== generation)
    throw new Error("Azure connection changed. Refresh and retry.");
  return { ...azureItem(site, raw), account: accountId };
}

export async function azureDetails(
  item: InboxItem,
): Promise<GithubWorkItemDetails> {
  const before = generation;
  const raw = await invoke<WorkItem>("azure_item_content", {
    site: item.site,
    id: item.id,
    accountId: item.account ?? "",
    discussion: false,
  });
  if (before !== generation)
    throw new Error("Azure connection changed. Refresh and retry.");
  const result = {
    body: azureDescription(raw),
    author:
      (raw.fields["System.CreatedBy"] as { displayName?: string })
        ?.displayName ?? "",
    attachments: raw.attachments ?? [],
  };
  retain(details, itemCacheKey(item), result);
  return result;
}
export async function azureThread(
  item: Pick<InboxItem, "site" | "id" | "url" | "account">,
): Promise<GithubWorkItemThread> {
  const before = generation;
  const raw = await invoke<{
    more: boolean;
    attachments?: GithubWorkItemDetails["attachments"];
    comments: {
      id?: number;
      commentId?: number;
      text: string;
      renderedText?: string;
      format?: string;
      createdBy?: { displayName?: string };
      createdDate: string;
    }[];
  }>("azure_item_content", { site: item.site, id: item.id, accountId: item.account ?? "", discussion: true });
  if (before !== generation)
    throw new Error("Azure connection changed. Refresh and retry.");
  const result: GithubWorkItemThread = {
    attachments: raw.attachments ?? [],
    comments: raw.comments
      .slice(0, 50)
      .reverse()
      .map((c) => ({
        id: String(c.id ?? c.commentId),
        body:
          c.format === "markdown" && !c.renderedText
            ? c.text
            : azureMarkdown(c.renderedText ?? c.text),
        author: c.createdBy?.displayName ?? "Unknown",
        createdAt: c.createdDate,
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
    truncated: raw.more,
    reviewDecision: "",
    baseRefName: "",
    headRefName: "",
  };
  retain(threads, itemCacheKey(item), result);
  return result;
}
