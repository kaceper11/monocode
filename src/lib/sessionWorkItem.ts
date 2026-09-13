import { gitPrStatus } from "./fs";
import {
  githubRepo,
  inboxIdentityKey,
  type InboxItem,
  type InboxComposerCard,
  type GithubTaskKind,
} from "./githubTasks";
import type { LinkedWorkItem } from "./session";
import type { GeneratedWorkItemHint } from "./sessionTitle";

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
  if (!validNumber(item.number) || item.kind === "ci") return null;
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
  };
}

export function inboxItemMatchesLinkedWorkItem(
  item: InboxItem,
  linked: LinkedWorkItem,
): boolean {
  return (
    item.provider === (linked.provider ?? "github") &&
    (linked.provider && linked.provider !== "github"
      ? item.url === linked.url &&
        (!linked.account || item.account === linked.account)
      : (!linked.account || item.account === linked.account) &&
        item.kind === linked.kind &&
        item.number === linked.number &&
        item.repo.trim().toLowerCase() === linked.repo.trim().toLowerCase())
  );
}

/** Same key used by Inbox selection, without synthesizing a full Inbox item. */
export function linkedWorkItemInboxKey(linked: LinkedWorkItem): string {
  return `${linked.provider ?? "github"}:${inboxIdentityKey({ ...linked, id: linked.identifier })}`;
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

export function addSessionWorkItems<
  T extends { linkedWorkItem?: LinkedWorkItem },
>(session: T, incoming: LinkedWorkItem[]): T {
  const links = [...sessionWorkItems(session)];
  for (const item of incoming) {
    const index = links.findIndex(
      (link) =>
        link.url === item.url &&
        (link.account ?? "") === (item.account ?? ""),
    );
    if (index < 0) links.push(item);
    else
      links[index] = {
        ...links[index],
        ...item,
        ...(item.account || links[index].account
          ? { account: item.account || links[index].account }
          : {}),
      };
  }
  if (links.length > 20)
    throw new Error("A conversation can link up to 20 tickets.");
  if (!links.length) return session;
  const [first, ...rest] = boundLinkedContexts(links).map(
    ({ additionalItems: _extra, ...item }) => item,
  );
  return {
    ...session,
    linkedWorkItem: {
      ...first,
      ...(rest.length ? { additionalItems: rest } : {}),
    },
  };
}

export function removeSessionWorkItem<T extends { linkedWorkItem?: LinkedWorkItem }>(session: T, item: LinkedWorkItem): T {
  const remaining = sessionWorkItems(session).filter(link =>
    link.url !== item.url || ((link.account ?? "") !== (item.account ?? "")));
  return addSessionWorkItems({ ...session, linkedWorkItem: undefined }, remaining);
}


export const OPEN_INBOX_WORK_ITEM = "monocode:open-inbox-work-item";

/** Conversation cards navigate internally; provider URLs remain reference data. */
export function openInboxCard(card: InboxComposerCard) {
  const github = card.provider === "github" ? parseGithubWorkItemUrl(card.url) : null;
  const number = github?.number ?? Number(card.identifier.match(/\d+$/)?.[0]);
  if (!validNumber(number)) return;
  const item: LinkedWorkItem = { provider: card.provider, account: card.account, kind: card.kind === "pr" ? "pr" : "issue", repo: github?.repo ?? card.source, number, url: card.url, identifier: card.identifier, title: card.title };
  window.dispatchEvent(new CustomEvent(OPEN_INBOX_WORK_ITEM, { detail: item }));
}

/** Keep saved descriptions within one shared budget, including incremental additions. */
export function boundLinkedContexts(links: LinkedWorkItem[]): LinkedWorkItem[] {
  const budget = Math.floor(32_000 / (links.filter(link => link.context).length || 1));
  const notice = "\n\n_Snapshot truncated to the shared context limit._";
  return links.map(link => link.context && link.context.length > budget
    ? { ...link, context: link.context.slice(0, budget - notice.length) + notice }
    : link);
}

const workItemIdentity = (item: InboxItem | LinkedWorkItem) => JSON.stringify([
  item.provider ?? "github",
  !item.provider || item.provider === "github" ? [item.repo.trim().toLowerCase(), item.kind, item.number] : item.url,
]);

export type WorkItemIndex<T> = Map<string, Map<string, Set<T>>>;

/**
 * Entities indexed by their linked-work-item identities — one pass for a
 * whole caller's lookups. Account-scoped exactly like
 * {@link inboxItemMatchesLinkedWorkItem}: an unscoped link joins every
 * account, a scoped link only its own.
 */
export function indexByWorkItem<T>(
  entities: readonly T[],
  linksOf: (entity: T) => LinkedWorkItem[],
): WorkItemIndex<T> {
  const index: WorkItemIndex<T> = new Map();
  for (const entity of entities) for (const link of linksOf(entity)) {
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
  item: InboxItem,
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

/** Related sessions for every item in one indexed pass — same matching as
 * {@link relatedSessionsForInboxItem} without the per-row rescan. */
export function inboxRelatedSessionMap<T extends { linkedWorkItem?: LinkedWorkItem }>(
  items: readonly InboxItem[],
  sessions: readonly T[],
): Map<InboxItem, T[]> {
  const index = indexByWorkItem(sessions, sessionWorkItems);
  return new Map(items.map(item => [item, relatedFromIndex(item, index)]));
}

/** Index links once instead of scanning all sessions for every visible Inbox row. */
export function inboxRelatedSessionCounts<T extends { linkedWorkItem?: LinkedWorkItem }>(items: readonly InboxItem[], sessions: readonly T[]): Map<InboxItem, number> {
  const map = inboxRelatedSessionMap(items, sessions);
  return new Map([...map].map(([item, related]) => [item, related.length]));
}
