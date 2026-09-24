import { gitPrStatus } from "../../../platform/tauri/fs";
import {
  githubRepo,
  inboxIdentityKey,
  type InboxItem,
  type InboxProvider,
  type GithubTaskKind,
} from "../../inbox/model/githubTasks";
import type { LinkedWorkItem } from "./session";
import type { GeneratedWorkItemHint } from "./sessionTitle";

/** Fork-era sessions persisted Azure links as "azure"; upstream's provider is "azuredevops". */
const providerOf = (item: { provider?: string }): InboxProvider =>
  item.provider === "azure"
    ? "azuredevops"
    : ((item.provider ?? "github") as InboxProvider);

const GITHUB_URL_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/(\d+)\b/i;

function validNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function githubUrl(repo: string, kind: GithubTaskKind, number: number): string {
  return `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`;
}

export function parseGithubWorkItemUrl(message: string): LinkedWorkItem | null {
  const match = GITHUB_URL_RE.exec(message);
  if (!match) return null;
  const number = Number(match[4]);
  if (!validNumber(number)) return null;
  const repo = `${match[1]}/${match[2]}`;
  const kind = match[3].toLowerCase() === "pull" ? "pr" : "issue";
  return { kind, repo, number, url: githubUrl(repo, kind, number) };
}

function explicitHint(message: string): GeneratedWorkItemHint | null {
  const patterns: Array<[GithubTaskKind, RegExp]> = [
    ["pr", /\b(?:pr|pull\s+request)\s*#?\s*(\d+)\b/i],
    ["issue", /\bissue\s*#?\s*(\d+)\b/i],
  ];
  for (const [kind, pattern] of patterns) {
    const match = pattern.exec(message);
    const number = Number(match?.[1]);
    if (match && validNumber(number)) return { kind, number };
  }
  return null;
}

function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function repoFromGithubUrl(url: string): string | null {
  const match = GITHUB_URL_RE.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

function referencesCurrentPr(message: string): boolean {
  return /\b(?:this|the|current)\s+(?:pr|pull\s+request)\b/i.test(message);
}

/** Resolve explicit first-message context to one stable GitHub identity. */
export async function resolveLinkedWorkItem(
  message: string,
  cwd: string,
  generatedHint: GeneratedWorkItemHint | null,
): Promise<LinkedWorkItem | null> {
  const fromUrl = parseGithubWorkItemUrl(message);
  if (fromUrl) return fromUrl;

  const hint = explicitHint(message) ?? generatedHint;
  if (hint && validNumber(hint.number)) {
    try {
      const repo = await githubRepo(cwd);
      if (!validRepo(repo)) return null;
      return {
        ...hint,
        repo,
        url: githubUrl(repo, hint.kind, hint.number),
      };
    } catch {
      return null;
    }
  }

  if (!referencesCurrentPr(message)) return null;
  try {
    const pr = await gitPrStatus(cwd);
    if (!pr || !validNumber(pr.number)) return null;
    const repo = repoFromGithubUrl(pr.url) ?? (await githubRepo(cwd));
    if (!validRepo(repo)) return null;
    return {
      kind: "pr",
      repo,
      number: pr.number,
      url: pr.url || githubUrl(repo, "pr", pr.number),
    };
  } catch {
    return null;
  }
}

export function linkedWorkItemFromInboxItem(
  item: InboxItem,
): LinkedWorkItem | null {
  if (!validNumber(item.number)) return null;
  if (item.provider === "github") {
    if ((item.kind !== "issue" && item.kind !== "pr") || !validRepo(item.repo))
      return null;
    return {
      ...(item.account ? { account: item.account } : {}),
      kind: item.kind,
      repo: item.repo,
      number: item.number,
      url: item.url || githubUrl(item.repo, item.kind, item.number),
    };
  }
  if (item.provider !== "jira" && item.provider !== "azuredevops") return null;
  try {
    const url = new URL(item.url);
    if (url.protocol !== "https:" || url.username || url.password) return null;
  } catch {
    return null;
  }
  return {
    provider: item.provider,
    account: item.account,
    kind: item.kind === "pr" ? "pr" : "issue",
    repo: item.repo,
    number: item.number,
    url: item.url,
    identifier: item.identifier,
    title: item.title,
    ...(item.id ? { id: item.id } : {}),
    ...(item.site ? { site: item.site } : {}),
  };
}

/** Restore the GitHub identity persisted on an event-triggered automation run. */
export function linkedWorkItemFromAutomationEvent(run: {
  trigger: string;
  eventKind?: string;
  eventKey?: string;
}): LinkedWorkItem | null {
  if (run.trigger !== "event" || run.eventKind !== "github") return null;
  const match = /^github:(pr|issue):([^/:]+\/[^/:]+):([1-9]\d*)$/i.exec(
    run.eventKey?.trim() ?? "",
  );
  if (!match) return null;
  const number = Number(match[3]);
  if (!validNumber(number)) return null;
  const kind = match[1].toLowerCase() === "pr" ? "pr" : "issue";
  const repo = match[2];
  if (!validRepo(repo)) return null;
  return { kind, repo, number, url: githubUrl(repo, kind, number) };
}

export function inboxItemMatchesLinkedWorkItem(
  item: InboxItem,
  linked: LinkedWorkItem,
): boolean {
  return !linkedWorkItemNeedsAccount(linked) &&
    workItemIdentity(item) === workItemIdentity(linked) &&
    (!linked.account || item.account === linked.account);
}

/** Same key used by Inbox selection, without synthesizing a full Inbox item. */
export function linkedWorkItemInboxKey(linked: LinkedWorkItem): string {
  return `${providerOf(linked)}:${inboxIdentityKey(linked)}`;
}

/** Find local sessions whose persisted GitHub identity matches an Inbox row. */
export function relatedSessionsForInboxItem<
  T extends { linkedWorkItem?: LinkedWorkItem },
>(item: InboxItem, sessions: readonly T[]): T[] {
  return sessions.filter((session) =>
    sessionWorkItems(session).some((linked) =>
      inboxItemMatchesLinkedWorkItem(item, linked),
    ),
  );
}

/** Flatten old single-link records and new explicitly linked bundles. */
export function sessionWorkItems(session: {
  linkedWorkItem?: LinkedWorkItem;
}): LinkedWorkItem[] {
  const first = session.linkedWorkItem;
  return first ? [first, ...(first.additionalItems ?? [])] : [];
}

/** Earlier fork links did not save connection identity. Rebind only by user choice. */
export function linkedWorkItemNeedsAccount(item: LinkedWorkItem): boolean {
  return item.provider === "jira" && !item.account;
}

export function bindLinkedWorkItemAccount(
  saved: LinkedWorkItem,
  target: LinkedWorkItem,
  account: string,
  site: string,
): LinkedWorkItem {
  if (!account || !linkedWorkItemNeedsAccount(target)) return saved;
  const key = linkedWorkItemInboxKey(target);
  const bind = (item: LinkedWorkItem) => linkedWorkItemNeedsAccount(item) && linkedWorkItemInboxKey(item) === key
    ? { ...item, account, site }
    : item;
  const primary = bind(saved);
  const additional = saved.additionalItems?.map(bind);
  return additional?.some((item, index) => item !== saved.additionalItems![index])
    ? { ...primary, additionalItems: additional }
    : primary;
}

/** Keep saved descriptions within one shared budget, including incremental additions. */
export function boundLinkedContexts(links: LinkedWorkItem[]): LinkedWorkItem[] {
  const budget = Math.floor(32_000 / (links.filter(link => link.context).length || 1));
  const notice = "\n\n_Snapshot truncated to the shared context limit._";
  return links.map(link => link.context && link.context.length > budget
    ? { ...link, context: link.context.slice(0, budget - notice.length) + notice }
    : link);
}

/** Azure work-item ids are organization-wide; HTML links may include a project or omit it. */
function azureWorkItemIdentity(item: InboxItem | LinkedWorkItem): string {
  try {
    const url = new URL(item.url);
    if (url.protocol !== "https:" || url.username || url.password) return item.url;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const host = url.hostname.toLowerCase();
    const organization = host === "dev.azure.com" ? parts.shift()?.toLowerCase()
      : host.endsWith(".visualstudio.com") ? host.slice(0, -".visualstudio.com".length) : undefined;
    const marker = parts.findIndex(part => part.toLowerCase() === "_workitems");
    const id = parts[marker + 2];
    if (organization && item.kind === "issue" && marker >= 0 &&
        parts[marker + 1]?.toLowerCase() === "edit" && /^\d+$/.test(id ?? "") && Number(id) === item.number)
      return JSON.stringify([organization, "issue", item.number]);
  } catch { /* Unrecognized links retain exact identity; never join by number alone. */ }
  return item.url;
}

const workItemIdentity = (item: InboxItem | LinkedWorkItem) => JSON.stringify([
  providerOf(item),
  providerOf(item) === "github" ? [item.repo.trim().toLowerCase(), item.kind, item.number] : providerOf(item) === "azuredevops" ? azureWorkItemIdentity(item) : item.url,
]);

export type WorkItemIndex<T> = Map<string, Map<string, Set<T>>>;

/**
 * Entities indexed by their linked-work-item identities — one pass for a
 * whole caller's lookups. Account-scoped exactly like
 * {@link inboxItemMatchesLinkedWorkItem}: upstream unscoped links join every
 * account; legacy Jira links require an explicit account first.
 */
export function indexByWorkItem<T>(
  entities: readonly T[],
  linksOf: (entity: T) => LinkedWorkItem[],
): WorkItemIndex<T> {
  const index: WorkItemIndex<T> = new Map();
  for (const entity of entities) for (const link of linksOf(entity)) {
    if (linkedWorkItemNeedsAccount(link)) continue;
    const key = workItemIdentity(link);
    let accounts = index.get(key);
    if (!accounts) index.set(key, accounts = new Map());
    const account = link.account || "";
    let related = accounts.get(account);
    if (!related) accounts.set(account, related = new Set());
    related.add(entity);
  }
  return index;
}

/** Entities related to one item from a prebuilt {@link indexByWorkItem}. */
export function relatedFromIndex<T>(
  item: InboxItem | LinkedWorkItem,
  index: WorkItemIndex<T>,
): T[] {
  const accounts = index.get(workItemIdentity(item));
  return [
    ...new Set([
      ...(accounts?.get("") ?? []),
      ...(accounts?.get(item.account || "") ?? []),
    ]),
  ];
}
