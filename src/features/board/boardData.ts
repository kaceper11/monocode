import {
  inboxItemKey,
  inboxItemRef,
  type InboxItem,
  type InboxProvider,
} from "../inbox/model/githubTasks";
import type { GitPr, GitPrCheck } from "../../platform/tauri/fs";
import {
  sessionDisplayTitle,
  sessionNeedsInput,
  type LinkedWorkItem,
  type Session,
} from "../sessions/model/session";
import type { SessionSummary } from "../sessions/data/sessionStore";
import {
  inboxItemMatchesLinkedWorkItem,
  linkedWorkItemFromInboxItem,
  linkedWorkItemInboxKey,
  sessionWorkItems,
} from "../sessions/model/sessionWorkItem";
import type { LinkedSessionUpdate } from "../inbox/model/linkedSessionUpdates";
import type {
  BoardColumnId,
  BoardGroup,
  BoardLocalCard,
  BoardPlacement,
  BoardTask,
} from "./boardStore";

/** Group chip palette — literal classes so Tailwind keeps them. `color` on a
 * `BoardGroup` indexes this list; the store cycles indices on creation.
 * `card` is a faint border+tint wash so grouped tasks read as one colour. */
export const GROUP_SWATCHES: readonly {
  dot: string;
  chip: string;
  card: string;
}[] = [
  {
    dot: "bg-sky-400",
    chip: "bg-sky-400/12 text-sky-300",
    card: "border-sky-400/30 bg-sky-400/[0.05]",
  },
  {
    dot: "bg-emerald-400",
    chip: "bg-emerald-400/12 text-emerald-300",
    card: "border-emerald-400/30 bg-emerald-400/[0.05]",
  },
  {
    dot: "bg-amber-400",
    chip: "bg-amber-400/12 text-amber-300",
    card: "border-amber-400/30 bg-amber-400/[0.05]",
  },
  {
    dot: "bg-rose-400",
    chip: "bg-rose-400/12 text-rose-300",
    card: "border-rose-400/30 bg-rose-400/[0.05]",
  },
  {
    dot: "bg-violet-400",
    chip: "bg-violet-400/12 text-violet-300",
    card: "border-violet-400/30 bg-violet-400/[0.05]",
  },
  {
    dot: "bg-cyan-400",
    chip: "bg-cyan-400/12 text-cyan-300",
    card: "border-cyan-400/30 bg-cyan-400/[0.05]",
  },
  {
    dot: "bg-orange-400",
    chip: "bg-orange-400/12 text-orange-300",
    card: "border-orange-400/30 bg-orange-400/[0.05]",
  },
  {
    dot: "bg-pink-400",
    chip: "bg-pink-400/12 text-pink-300",
    card: "border-pink-400/30 bg-pink-400/[0.05]",
  },
];

/** Palette entry for a stored group color index. */
export function groupSwatch(color: number) {
  return GROUP_SWATCHES[color % GROUP_SWATCHES.length];
}

/** Traffic-light dot for a session ref — shared by card, panel and tray. */
export function sessionDotClass(session: {
  busy: boolean;
  needsInput: boolean;
}): string {
  if (session.needsInput) return "bg-amber-400";
  if (session.busy) return "bg-emerald-400";
  return "bg-content/25";
}

/**
 * Pure snapshot join for the board — the same discipline as the inbox's
 * my-work modules: every input is an already-fetched record, nothing here
 * performs IO. A card is one unit of work: a provider item (ticket or PR),
 * a session doing unlinked work, or a board-local note. Sessions attach to
 * item cards instead of spawning their own.
 */

type BoardCardSession = {
  id: string;
  title: string;
  busy: boolean;
  needsInput: boolean;
  /** Live session row vs a stored summary — only live rows can be busy. */
  live: boolean;
};

/** One ticket chip on a task card — resolved from the inbox fetch when the
 * item is present, else rendered from the stored link. */
type BoardTicketChip = {
  /** `linkedWorkItemInboxKey` — used to unlink. */
  key: string;
  provider?: InboxProvider;
  identifier?: string;
  title: string;
  url?: string;
  state?: string;
  stateType?: string;
  kind?: "issue" | "pr";
};

/** A PR item discovered for a card — matched by ticket key or workstream
 * branch, or probed on a workstream's checkout. */
type BoardLinkedPr = {
  id: string;
  provider?: InboxProvider;
  identifier?: string;
  title: string;
  url?: string;
  state?: string;
  draft?: boolean;
  /** Which signal attached it. */
  via: "link" | "branch" | "key" | "workstream";
};

/** One repo lane of a task card: branch/worktree + bound sessions + PR/CI. */
export type BoardWorkstreamRow = {
  id: string;
  projectPath: string;
  branch: string;
  base: string;
  worktreePath?: string;
  /** All bound session ids — a lane can hold multiple conversations. */
  sessionIds: string[];
  /** Resolved refs for `sessionIds`, binding order. */
  sessions: BoardCardSession[];
  /** Primary display ref — first live session, else first bound. */
  session?: BoardCardSession;
  pr?: { number: number; title: string; url: string; state: string };
  ciTotal: number;
  ciFailing: number;
  ciRunning: number;
  /** Probe failure — deleted worktree, missing `gh`, auth. */
  probeError?: string;
};

export type WorkstreamStatus = {
  pr: GitPr | null;
  checks: GitPrCheck[];
  error?: string;
};

export type BoardCard = {
  /** Stable identity — provider work-item key, `session:<id>`, `local:<id>`,
   * `task:<id>`. */
  id: string;
  kind: "item" | "session" | "local" | "task";
  title: string;
  provider?: InboxProvider;
  identifier?: string;
  url?: string;
  repo?: string;
  projectPath?: string;
  itemKind?: "issue" | "pr";
  state?: string;
  stateType?: string;
  draft?: boolean;
  /** GitLab to-do reason — why the provider says this needs you. */
  attentionReason?: string;
  /** Source inbox row when the card came from a fetch. */
  item?: InboxItem;
  /** Task cards: the stored record. */
  task?: BoardTask;
  /** Task cards: linked tickets (live item data when fetched). */
  tickets?: BoardTicketChip[];
  /** Task cards: resolved group labels (name + palette index). */
  groups?: { id: string; name: string; color: number }[];
  /** Task cards: repo lanes with session/PR/CI status. */
  workstreams?: BoardWorkstreamRow[];
  /** Discovered pull requests (absorbed provider items). */
  prs?: BoardLinkedPr[];
  sessions: BoardCardSession[];
  /** A joined session's linked item changed since it was last seen. */
  hasUpdate: boolean;
  /** Check runs on workstream PRs — populated by `probeWorkstream`. */
  ciTotal: number;
  ciFailing: number;
  ciRunning: number;
  updatedAt: number;
  /** Column without a manual placement — informational, view overrides. */
  derived: BoardColumnId;
};

type BoardInput = {
  items: readonly InboxItem[];
  /** Live sessions — busy/needsInput state only exists here. */
  sessions: readonly Session[];
  /** Stored summaries with work-item links (inbox-related set). */
  summaries: readonly SessionSummary[];
  /** `linkedSessionUpdates` output keyed by session id. */
  updates?: ReadonlyMap<string, LinkedSessionUpdate>;
  locals?: readonly BoardLocalCard[];
  tasks?: readonly BoardTask[];
  groups?: readonly BoardGroup[];
  /** Non-task card id → group ids (store's `cardGroups` slice). */
  cardGroups?: Readonly<Record<string, readonly string[]>>;
  /** workstreamId → probed PR + checks for its worktree. */
  workstreamStatus?: ReadonlyMap<string, WorkstreamStatus>;
};

const DONE_STATES = new Set([
  "closed",
  "merged",
  "completed",
  "abandoned",
  "declined",
  "resolved",
  "done",
  "removed",
  "inactive",
]);
const DONE_STATE_TYPES = new Set(["completed", "canceled"]);

function itemCardKey(item: InboxItem): string {
  const linked = linkedWorkItemFromInboxItem(item);
  if (linked) return `item:${linkedWorkItemInboxKey(linked)}`;
  return `item:${item.provider}:${item.url}`;
}

function linkedCardKey(linked: LinkedWorkItem): string {
  return `item:${linkedWorkItemInboxKey(linked)}`;
}

/** Best display ref for a card: Jira/Azure identifier, else #number. */
function cardIdentifier(item: InboxItem): string | undefined {
  if (item.identifier?.trim()) return item.identifier.trim();
  if (item.provider === "github" || item.provider === "gitlab")
    return `#${item.number}`;
  return undefined;
}

/**
 * The provider's own column sense, normalized across the five sources:
 * GitHub/GitLab/Linear `state`, Linear `stateType`, Jira status text, Azure
 * Boards state. Returns null when the provider hasn't moved it out of the
 * backlog — the board then falls back to session signals.
 */
function providerStage(item: {
  state?: string;
  stateType?: string;
}): "done" | "progress" | "review" | null {
  const state = (item.state ?? "").trim().toLowerCase();
  const stateType = (item.stateType ?? "").trim().toLowerCase();
  if (DONE_STATES.has(state) || DONE_STATE_TYPES.has(stateType))
    return "done";
  if (/review|verify|validate|qa\b/.test(state)) return "review";
  if (
    stateType === "started" ||
    /progress|active|doing|development/.test(state)
  )
    return "progress";
  return null;
}

/** Column a card lands in before any manual placement. */
export function deriveColumn(
  card: Pick<
    BoardCard,
    | "kind"
    | "itemKind"
    | "state"
    | "stateType"
    | "sessions"
    | "tickets"
    | "prs"
    | "workstreams"
  >,
): BoardColumnId {
  if (card.kind === "local") return "todo";
  if (card.kind === "task") {
    const tickets = card.tickets ?? [];
    const openPrs = (card.prs ?? []).filter((pr) => prIsOpen(pr.state));
    // Only probed PRs count — an unprobed row has no PR, not an unknown one.
    const workstreamPrs = (card.workstreams ?? []).filter(
      (ws) => ws.pr && prIsOpen(ws.pr.state),
    );
    // A task is done when everything it tracks is done: all linked tickets
    // closed and no open PR left standing. Link-only ticket chips carry no
    // provider state — they can't claim done, but an unfetched ticket also
    // can't block it; the fetched ones decide. A ticketless task falls back
    // to its discovered PRs — but only once one exists, so a fresh task
    // isn't born done.
    const trackedPrs =
      (card.prs ?? []).length +
      (card.workstreams ?? []).filter((ws) => ws.pr).length;
    const knownTickets = tickets.filter(
      (ticket) => ticket.state || ticket.stateType,
    );
    const ticketsDone = knownTickets.length
      ? knownTickets.every((ticket) => providerStage(ticket) === "done")
      : !tickets.length && trackedPrs > 0;
    const prsDone =
      (card.prs ?? []).every((pr) => !prIsOpen(pr.state)) &&
      (card.workstreams ?? []).every((ws) => !ws.pr || !prIsOpen(ws.pr.state));
    if (ticketsDone && prsDone) return "done";
    if (openPrs.length || workstreamPrs.length) return "review";
    // Only a live session means work in progress — a stored bound session
    // is dormant work.
    if (card.sessions.some((session) => session.live)) return "progress";
    return "todo";
  }
  const stage = providerStage(card);
  if (stage === "done") return "done";
  // An open/active PR lives in Review whether or not anyone is watching it —
  // that is where its comments and checks land.
  if (card.itemKind === "pr" && (!stage || stage === "progress"))
    return "review";
  if (stage === "review") return "review";
  if (card.sessions.length > 0) return "progress";
  if (stage === "progress") return "progress";
  return "todo";
}

const prIsOpen = (state?: string) => {
  const value = (state ?? "").trim().toLowerCase();
  // Unknown — assume open so the PR stays visible.
  if (!value) return true;
  return !DONE_STATES.has(value);
};

/** Where a card actually sits — manual placement beats derivation. Local
 * cards store their column on the record, surfaced as `derived`. */
export function cardColumn(
  card: BoardCard,
  placements: Readonly<Record<string, BoardPlacement>>,
): BoardColumnId {
  return card.kind === "local"
    ? card.derived
    : (placements[card.id]?.column ?? card.derived);
}

/** One-line attention phrases for a card, most actionable first. */
export function cardAttentionLines(card: BoardCard): string[] {
  const lines: string[] = [];
  const needsInput = card.sessions.filter((session) => session.needsInput);
  if (needsInput.length)
    lines.push(
      needsInput.length === 1
        ? "1 session needs input"
        : `${needsInput.length} sessions need input`,
    );
  if (card.ciFailing)
    lines.push(card.ciFailing === 1 ? "CI failing" : `CI failing ×${card.ciFailing}`);
  if (card.hasUpdate) lines.push("New activity");
  if (card.attentionReason) lines.push(card.attentionReason);
  const working = card.sessions.filter((session) => session.busy).length;
  if (working)
    lines.push(working === 1 ? "Working" : `${working} sessions working`);
  if (card.ciRunning && !working)
    lines.push(card.ciRunning === 1 ? "CI running" : `CI running ×${card.ciRunning}`);
  return lines;
}

type MutableCard = BoardCard & {
  sessionIds: Set<string>;
  /** task cards: workstream rows keyed by workstream id. */
  workstreamRows: Map<string, BoardWorkstreamRow>;
};

function toCard(mutable: MutableCard): BoardCard {
  const {
    sessionIds: _sessionIds,
    workstreamRows: _workstreamRows,
    ...card
  } = mutable;
  return card;
}

function pushSession(card: MutableCard, ref: BoardCardSession) {
  if (card.sessionIds.has(ref.id)) return;
  card.sessionIds.add(ref.id);
  card.sessions.push(ref);
}

/**
 * The searchable key a ticket leaves in foreign PR titles and branches:
 * Jira/Linear identifiers (`PROJ-123`) and Azure `AB#<id>`/`#<id>` marks.
 * GitHub/GitLab links don't need one — their identity join is exact.
 */
export function ticketKeys(link: LinkedWorkItem): string[] {
  const keys: string[] = [];
  const text = `${link.identifier ?? ""} ${link.title ?? ""}`;
  const key = text.match(/[A-Za-z][A-Za-z0-9]+-\d+/);
  if (key) keys.push(key[0].toUpperCase());
  // Azure PRs reference work items as `AB#<id>` in titles/branches.
  if (link.provider === "azuredevops" && link.number > 0)
    keys.push(`AB#${link.number}`);
  return keys;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether an inbox item references a ticket key — in its identifier, title,
 * or URL. Matched on non-alphanumeric boundaries so `PROJ-123` doesn't join
 * `PROJ-1234` or `APROJ-123`. */
export function itemMatchesTicketKey(item: InboxItem, key: string): boolean {
  const haystack = [item.identifier, item.title, item.url]
    .filter(Boolean)
    .join("\n");
  return new RegExp(
    `(^|[^A-Za-z0-9])${escapeRegExp(key)}(?![0-9])`,
    "i",
  ).test(haystack);
}

/**
 * A task link for any provider. `linkedWorkItemFromInboxItem` only covers
 * GitHub/Jira/Azure — sessions don't carry Linear/GitLab work items yet —
 * but board links need every source, so this keeps the item's identity
 * fields verbatim and `inboxIdentityKey` produces the match key.
 */
export function boardLinkFromInboxItem(
  item: InboxItem,
): LinkedWorkItem | null {
  if (!item.url) return null;
  const linked = linkedWorkItemFromInboxItem(item);
  if (linked) return linked;
  return {
    provider: item.provider,
    kind: item.kind === "pr" ? "pr" : "issue",
    url: item.url,
    repo: item.repo ?? "",
    number: item.number,
    ...(item.account ? { account: item.account } : {}),
    ...(item.identifier ? { identifier: item.identifier } : {}),
    ...(item.id ? { id: item.id } : {}),
    ...(item.site ? { site: item.site } : {}),
    ...(item.title ? { title: item.title } : {}),
  };
}

/** Inbox rows that can become task links, query-filtered — shared by the
 * new-task dialog and the details panel's ticket picker. */
export function boardTicketOptions(
  items: readonly InboxItem[],
  query: string,
  exclude?: ReadonlySet<string>,
  limit = 60,
): { item: InboxItem; linked: LinkedWorkItem }[] {
  const normalized = query.trim().toLowerCase();
  return items
    .map((item) => ({ item, linked: boardLinkFromInboxItem(item) }))
    .filter(
      (entry): entry is { item: InboxItem; linked: LinkedWorkItem } =>
        entry.linked !== null &&
        !exclude?.has(linkedWorkItemInboxKey(entry.linked)) &&
        (!normalized ||
          `${entry.item.title} ${inboxItemRef(entry.item)} ${entry.item.repo ?? ""} ${entry.item.projectName ?? ""}`
            .toLowerCase()
            .includes(normalized)),
    )
    .slice(0, limit);
}

/** The first link carries the rest as `additionalItems` — the bundle shape
 * sessions persist, shared by the spawn and bind paths. */
export function linkBundleFromLinks(
  links: readonly LinkedWorkItem[],
): LinkedWorkItem | null {
  const [primary, ...rest] = links;
  return primary
    ? { ...primary, ...(rest.length ? { additionalItems: rest } : {}) }
    : null;
}

function ticketChipFromItem(item: InboxItem): BoardTicketChip {
  const linked = linkedWorkItemFromInboxItem(item);
  return {
    key: inboxItemKey(item),
    provider: item.provider,
    ...(cardIdentifier(item) ? { identifier: cardIdentifier(item) } : {}),
    title: item.title,
    ...(item.url ? { url: item.url } : {}),
    ...(item.state ? { state: item.state } : {}),
    ...(item.stateType ? { stateType: item.stateType } : {}),
    kind: linked?.kind ?? (item.kind === "pr" ? "pr" : "issue"),
  };
}

function ticketChipFromLink(link: LinkedWorkItem): BoardTicketChip {
  return {
    key: linkedWorkItemInboxKey(link),
    ...(link.provider ? { provider: link.provider } : {}),
    ...(link.identifier ? { identifier: link.identifier } : {}),
    title: link.title ?? link.identifier ?? link.url,
    ...(link.url ? { url: link.url } : {}),
    kind: link.kind,
  };
}

function linkedPrFromItem(item: InboxItem, via: BoardLinkedPr["via"]): BoardLinkedPr {
  const linked = linkedWorkItemFromInboxItem(item);
  return {
    id: linked ? `item:${linkedWorkItemInboxKey(linked)}` : `item:${item.url}`,
    provider: item.provider,
    ...(cardIdentifier(item) ? { identifier: cardIdentifier(item) } : {}),
    title: item.title,
    ...(item.url ? { url: item.url } : {}),
    ...(item.state ? { state: item.state } : {}),
    ...(item.draft ? { draft: true } : {}),
    via,
  };
}

function checkCiState(check: GitPrCheck): "failing" | "running" | "other" {
  const bucket = check.bucket.toLowerCase();
  const state = check.state.toLowerCase();
  if (bucket === "fail" || bucket === "cancel" || /fail|error|timed/.test(state))
    return "failing";
  if (bucket === "pending" || /pending|progress|queued|wait|expected|required/.test(state))
    return "running";
  return "other";
}

function newItemCard(item: InboxItem): MutableCard {
  const linked = linkedWorkItemFromInboxItem(item);
  return {
    id: itemCardKey(item),
    kind: "item",
    title: item.title,
    provider: item.provider,
    ...(cardIdentifier(item) ? { identifier: cardIdentifier(item) } : {}),
    url: item.url || linked?.url,
    ...(item.repo ? { repo: item.repo } : {}),
    ...(item.projectPath ? { projectPath: item.projectPath } : {}),
    itemKind: linked?.kind ?? (item.kind === "pr" ? "pr" : "issue"),
    ...(item.state ? { state: item.state } : {}),
    ...(item.stateType ? { stateType: item.stateType } : {}),
    ...(item.draft ? { draft: true } : {}),
    ...(item.attentionReason
      ? { attentionReason: item.attentionReason }
      : {}),
    item,
    sessions: [],
    hasUpdate: false,
    ciTotal: 0,
    ciFailing: 0,
    ciRunning: 0,
    updatedAt: Date.parse(item.updatedAt) || 0,
    derived: "todo",
    sessionIds: new Set(),
    workstreamRows: new Map(),
  };
}

const resolveCardGroups = (
  ids: readonly string[] | undefined,
  groups: ReadonlyMap<string, BoardGroup>,
) =>
  (ids ?? [])
    .map((id) => groups.get(id))
    .filter((group): group is BoardGroup => group !== undefined)
    .map((group) => ({ id: group.id, name: group.name, color: group.color }));

function newTaskCard(
  task: BoardTask,
  groups: ReadonlyMap<string, BoardGroup>,
): MutableCard {
  const resolved = resolveCardGroups(task.groupIds, groups);
  return {
    // `task.id` already carries the `task:` prefix — use it verbatim so
    // placement keys don't double up.
    id: task.id,
    kind: "task",
    title: task.title,
    task,
    tickets: task.links.map(ticketChipFromLink),
    ...(resolved.length ? { groups: resolved } : {}),
    prs: [],
    sessions: [],
    hasUpdate: false,
    ciTotal: 0,
    ciFailing: 0,
    ciRunning: 0,
    updatedAt: task.createdAt,
    derived: "todo",
    sessionIds: new Set(),
    workstreamRows: new Map(),
  };
}

function newLinkedCard(linked: LinkedWorkItem): MutableCard {
  return {
    id: linkedCardKey(linked),
    kind: "item",
    title: linked.title ?? linked.identifier ?? linked.url,
    ...(linked.provider ? { provider: linked.provider } : {}),
    ...(linked.identifier ? { identifier: linked.identifier } : {}),
    ...(linked.url ? { url: linked.url } : {}),
    ...(linked.repo ? { repo: linked.repo } : {}),
    itemKind: linked.kind,
    sessions: [],
    hasUpdate: false,
    ciTotal: 0,
    ciFailing: 0,
    ciRunning: 0,
    updatedAt: 0,
    derived: "todo",
    sessionIds: new Set(),
    workstreamRows: new Map(),
  };
}

/**
 * Assemble cards from the snapshots the caller already holds.
 *
 * `sessions` are live rows (busy/needsInput known); `summaries` add stored
 * sessions with links that aren't live — a summary whose id is live is
 * skipped so the row never double-counts. Tasks absorb the items and
 * sessions their links/workstreams point at, and discover PRs whose branch
 * or title carries a linked ticket's key.
 */
export function buildBoardCards(input: BoardInput): BoardCard[] {
  const cards = new Map<string, MutableCard>();

  // --- task cards + lookup indexes -------------------------------------
  const taskByLink = new Map<string, MutableCard>();
  const taskBySession = new Map<string, { card: MutableCard; workstreamId?: string }>();
  const taskKeys = new Map<MutableCard, string[]>();
  const groupById = new Map(
    (input.groups ?? []).map((group) => [group.id, group] as const),
  );

  for (const task of input.tasks ?? []) {
    if (task.archived) continue;
    const card = newTaskCard(task, groupById);
    cards.set(card.id, card);
    taskKeys.set(card, task.links.flatMap(ticketKeys));
    for (const link of task.links) {
      taskByLink.set(linkedWorkItemInboxKey(link), card);
      if (link.url) taskByLink.set(link.url, card);
    }
    for (const ws of task.workstreams) {
      const row: BoardWorkstreamRow = {
        id: ws.id,
        projectPath: ws.projectPath,
        branch: ws.branch,
        base: ws.base,
        ...(ws.worktreePath ? { worktreePath: ws.worktreePath } : {}),
        sessionIds: ws.sessionIds ?? [],
        sessions: [],
        ciTotal: 0,
        ciFailing: 0,
        ciRunning: 0,
      };
      const status = input.workstreamStatus?.get(ws.id);
      if (status?.error) row.probeError = status.error;
      if (status?.pr) {
        row.pr = {
          number: status.pr.number,
          title: status.pr.title,
          url: status.pr.url,
          state: status.pr.state,
        };
      }
      for (const check of status?.checks ?? []) {
        row.ciTotal += 1;
        const state = checkCiState(check);
        if (state === "failing") row.ciFailing += 1;
        else if (state === "running") row.ciRunning += 1;
      }
      card.workstreamRows.set(ws.id, row);
      for (const sessionId of ws.sessionIds ?? [])
        taskBySession.set(sessionId, { card, workstreamId: ws.id });
    }
  }

  /** Fold a fetched item into its task card — refresh the ticket chip or
   * add the PR to the discovered list. `via` says which join matched. */
  const absorbItem = (
    card: MutableCard,
    item: InboxItem,
    via: "link" | "branch" | "key",
  ): boolean => {
    const key = inboxItemKey(item);
    const index = (card.tickets ?? []).findIndex((t) => t.key === key);
    if (index >= 0) {
      card.tickets![index] = ticketChipFromItem(item);
      return true;
    }
    if (item.kind === "pr") {
      const pr = linkedPrFromItem(item, via);
      if (!card.prs!.some((entry) => entry.id === pr.id)) card.prs!.push(pr);
      return true;
    }
    return false;
  };

  const taskForItem = (
    item: InboxItem,
  ): { card: MutableCard; via: "link" | "branch" | "key" } | undefined => {
    // Links were built through `boardLinkFromInboxItem`, whose key is the
    // item's own identity — this catches every provider, not just the
    // three `linkedWorkItemFromInboxItem` covers.
    const direct =
      taskByLink.get(inboxItemKey(item)) ??
      (item.url ? taskByLink.get(item.url) : undefined);
    if (direct) return { card: direct, via: "link" };
    if (item.kind !== "pr") return undefined;
    // A PR joins a task when it carries one of the task's ticket keys.
    for (const [card, keys] of taskKeys) {
      if (keys.some((key) => itemMatchesTicketKey(item, key)))
        return { card, via: "key" };
    }
    return undefined;
  };

  for (const item of input.items) {
    const task = taskForItem(item);
    if (task && absorbItem(task.card, item, task.via)) continue;
    const card = newItemCard(item);
    if (!cards.has(card.id)) cards.set(card.id, card);
  }

  const liveIds = new Set(input.sessions.map((session) => session.id));

  const attachToCard = (
    linked: LinkedWorkItem,
    ref: BoardCardSession,
    cwd?: string,
  ) => {
    // A session linked to a task ticket belongs on the task card. The url
    // fallback catches key drift between the link the task stored and the
    // link a session carries (e.g. provider/account filled in later).
    const task =
      taskByLink.get(linkedWorkItemInboxKey(linked)) ??
      (linked.url ? taskByLink.get(linked.url) : undefined);
    if (task) {
      pushSession(task, ref);
      return task;
    }
    let card: MutableCard | undefined;
    for (const candidate of cards.values()) {
      if (
        candidate.item &&
        inboxItemMatchesLinkedWorkItem(candidate.item, linked)
      ) {
        card = candidate;
        break;
      }
    }
    if (!card) {
      const key = linkedCardKey(linked);
      card = cards.get(key) ?? newLinkedCard(linked);
      if (!card.projectPath && cwd) card.projectPath = cwd;
      cards.set(key, card);
    }
    pushSession(card, ref);
    return card;
  };

  const sessionRef = (
    session: { id: string; title: string; harness: Session["harness"] },
    live: boolean,
    source?: Session,
  ): BoardCardSession => ({
    id: session.id,
    title: sessionDisplayTitle(session.title, session.harness),
    busy: live && source ? source.busy === true : false,
    needsInput: live && source ? sessionNeedsInput(source) : false,
    live,
  });

  for (const session of input.sessions) {
    // Live rows are never archived; inboxAsk is a transient composer and
    // orchestration workers surface under their lead, not as cards.
    if (session.inboxAsk || session.orchestrationLeadId) continue;
    const ref = sessionRef(session, true, session);
    const bound = taskBySession.get(session.id);
    if (bound) {
      pushSession(bound.card, ref);
      continue;
    }
    const links = sessionWorkItems(session);
    if (!links.length) {
      const card: MutableCard = {
        id: `session:${session.id}`,
        kind: "session",
        title: ref.title,
        projectPath: session.cwd,
        sessions: [ref],
        hasUpdate: false,
        ciTotal: 0,
        ciFailing: 0,
        ciRunning: 0,
        // Live rows carry no persisted timestamp; recency is a tiebreak only.
        updatedAt: Date.now(),
        derived: "progress",
        sessionIds: new Set([session.id]),
        workstreamRows: new Map(),
      };
      cards.set(card.id, card);
      continue;
    }
    for (const linked of links) {
      attachToCard(linked, ref, session.cwd);
    }
  }

  for (const summary of input.summaries) {
    if (
      summary.archived ||
      summary.orchestrationLeadId ||
      liveIds.has(summary.id)
    )
      continue;
    const ref = sessionRef(summary, false);
    const bound = taskBySession.get(summary.id);
    if (bound) {
      pushSession(bound.card, ref);
      continue;
    }
    for (const linked of sessionWorkItems(summary)) {
      attachToCard(linked, ref, summary.cwd);
    }
  }

  for (const card of cards.values()) {
    // Resolve each lane's bound refs in binding order; the card's own
    // `sessions` list already collected exactly these via taskBySession.
    const refsById = new Map(card.sessions.map((ref) => [ref.id, ref]));
    for (const row of card.workstreamRows.values()) {
      row.sessions = row.sessionIds
        .map((id) => refsById.get(id))
        .filter((ref): ref is BoardCardSession => !!ref);
      row.session = row.sessions.find((ref) => ref.live) ?? row.sessions[0];
    }
    card.hasUpdate = card.sessions.some(
      (session) => input.updates?.has(session.id) === true,
    );
    // Task cards also fold workstream CI into the card-level badges.
    if (card.kind === "task") {
      for (const row of card.workstreamRows.values()) {
        card.ciTotal += row.ciTotal;
        card.ciFailing += row.ciFailing;
        card.ciRunning += row.ciRunning;
      }
      card.workstreams = [...card.workstreamRows.values()];
    }
    card.derived = deriveColumn(card);
  }

  for (const local of input.locals ?? []) {
    const card: MutableCard = {
      id: local.id,
      kind: "local",
      title: local.title,
      sessions: [],
      hasUpdate: false,
      ciTotal: 0,
      ciFailing: 0,
      ciRunning: 0,
      updatedAt: local.createdAt,
      derived: local.column,
      sessionIds: new Set(),
      workstreamRows: new Map(),
    };
    cards.set(card.id, card);
  }

  return [...cards.values()].map((mutable) => {
    const card = toCard(mutable);
    // Non-task cards carry membership in the store's cardGroups map — tasks
    // already resolved theirs from `groupIds` in newTaskCard.
    if (!card.groups?.length) {
      const resolved = resolveCardGroups(input.cardGroups?.[card.id], groupById);
      if (resolved.length) card.groups = resolved;
    }
    return card;
  });
}

/** Column contents: placed cards keep their order, derived cards fall to
 * the bottom sorted by recency. */
export function columnCards(
  cards: readonly BoardCard[],
  column: BoardColumnId,
  placements: Readonly<Record<string, BoardPlacement>>,
  locals: readonly BoardLocalCard[],
): BoardCard[] {
  const localOrder = new Map(locals.map((card) => [card.id, card]));
  return cards
    .filter((card) => cardColumn(card, placements) === column)
    .sort((a, b) => {
      const aPlaced = placements[a.id] ?? localOrder.get(a.id);
      const bPlaced = placements[b.id] ?? localOrder.get(b.id);
      if (aPlaced && bPlaced) return aPlaced.order - bPlaced.order;
      if (aPlaced) return -1;
      if (bPlaced) return 1;
      return b.updatedAt - a.updatedAt;
    });
}

/** Render units for a column: task cards sharing a first group cluster into
 * one unit so the view can draw a shared coloured wrapper. The wrapper sits
 * at its earliest member's position — manual ordering still applies between
 * units, and a foreign card dropped "inside" a group lands after the wrapper. */
export type ColumnUnit =
  | { type: "card"; card: BoardCard }
  | {
      type: "group";
      group: { id: string; name: string; color: number };
      cards: BoardCard[];
    };

export function columnUnits(cards: readonly BoardCard[]): ColumnUnit[] {
  const units: ColumnUnit[] = [];
  const byGroup = new Map<string, Extract<ColumnUnit, { type: "group" }>>();
  for (const card of cards) {
    const group = card.groups?.[0];
    if (!group) {
      units.push({ type: "card", card });
      continue;
    }
    const existing = byGroup.get(group.id);
    if (existing) {
      existing.cards.push(card);
    } else {
      const unit: Extract<ColumnUnit, { type: "group" }> = {
        type: "group",
        group,
        cards: [card],
      };
      byGroup.set(group.id, unit);
      units.push(unit);
    }
  }
  return units;
}
