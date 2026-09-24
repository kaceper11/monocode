import { checkState, type DeliverySnapshot } from "./delivery";
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
  indexByWorkItem,
  relatedFromIndex,
  linkedWorkItemNeedsAccount,
  linkedWorkItemFromInboxItem,
  linkedWorkItemInboxKey,
  sessionWorkItems,
  workItemIdentity,
} from "../sessions/model/sessionWorkItem";
import type { LinkedSessionUpdate } from "../inbox/model/linkedSessionUpdates";
import { boardStatusKey, type BoardProviderStatus } from "./boardStore";
import type {
  BoardColumnId,
  BoardGroup,
  BoardLocalCard,
  BoardPlacement,
  BoardTask,
  Snooze,
} from "./boardStore";

/** Column header dot — literal classes so Tailwind keeps them. Custom
 * columns fall back to a neutral dot. */
const COLUMN_DOTS: Record<string, string> = {
  todo: "bg-content/40",
  progress: "bg-emerald-400",
  review: "bg-amber-400",
  done: "bg-accent",
};
export const columnDot = (id: string) =>
  COLUMN_DOTS[id] ?? "bg-content/30";

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

/** A PR item discovered for a card — matched by ticket key or a direct
 * ticket link. */
type BoardLinkedPr = {
  id: string;
  provider?: InboxProvider;
  identifier?: string;
  title: string;
  url?: string;
  state?: string;
  draft?: boolean;
  updatedAt?: string;
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
  pr?: {
    provider?: InboxProvider;
    number: number;
    title: string;
    url: string;
    state: string;
    /** `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED`. */
    reviewDecision?: string;
    /** Review threads still unresolved. */
    unresolvedThreads?: number;
    draft?: boolean;
    /** Provider-side update time (ISO) — recency signal for merges. */
    updatedAt?: string;
    /** Provider mergeability — `clean` | `behind` | `blocked` |
     * `conflicts` | `unstable`. */
    mergeState?: string;
  };
  /** Commits the lane's base has that the branch lacks — "behind main". */
  behind?: number;
  ciTotal: number;
  ciFailing: number;
  ciRunning: number;
  /** Mid-merge (`MERGE_HEAD` present) — surfaces the conflict resolver. */
  merging?: boolean;
  /** Probe failure — deleted worktree, missing `gh`, auth. */
  probeError?: string;
  ciError?: string;
  ciBlocked?: boolean;
};

export type WorkstreamStatus = {
  delivery?: DeliverySnapshot;
  requestKey?: string;
  fetchedAt?: number;
  ciError?: string;
  provider?: InboxProvider;
  pr: GitPr | null;
  checks: GitPrCheck[];
  merging?: boolean;
  /** Commits the resolved base is ahead — local refs only, no fetch. */
  behind?: number;
  error?: string;
};

export type BoardCard = {
  /** Presentation-only hierarchy; underlying task records retain their owners. */
  members?: BoardCard[];
  relatedItems?: InboxItem[];
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

/** Read the provider states, never the card's derived/manual column. */
export function boardCardStatuses(card: BoardCard): BoardProviderStatus[] {
  return [card, ...(card.tickets ?? []), ...(card.prs ?? []),
    ...(card.workstreams ?? []).flatMap((row) => row.pr ? [row.pr] : []),
  ].flatMap(({ provider, state }) =>
    provider && state?.trim() ? [{ provider, state: state.trim() }] : [],
  );
}

export function boardStatusOptions(
  cards: readonly BoardCard[],
  selected: readonly BoardProviderStatus[],
): BoardProviderStatus[] {
  const options = new Map<string, BoardProviderStatus>();
  for (const status of [...selected, ...cards.flatMap(boardCardStatuses)]) {
    options.set(boardStatusKey(status), status);
  }
  return [...options.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.state.localeCompare(b.state),
  );
}

export function matchesBoardStatuses(
  card: BoardCard,
  selected: ReadonlySet<string>,
): boolean {
  return !selected.size || boardCardStatuses(card).some((status) =>
    selected.has(boardStatusKey(status)),
  );
}

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
  /** cardId → pipeline checks for standalone Azure PR cards — probed by
   * `azureDevOpsBranchChecks` since they have no worktree to probe. */
  cardChecks?: ReadonlyMap<string, GitPrCheck[]>;
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

export function itemCardKey(item: InboxItem): string {
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
export function providerStage(item: {
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
    // A PR linked as a ticket chip is still a PR — it belongs in Review
    // and blocks Done like any discovered/lane PR.
    const linkedPrs = tickets.filter((ticket) => ticket.kind === "pr");
    const openPrs = [...(card.prs ?? []), ...linkedPrs].filter((pr) =>
      prIsOpen(pr.state),
    );
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
      linkedPrs.every((pr) => !prIsOpen(pr.state)) &&
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

/** Open-ish PR states — unknown counts as open so badges stay honest.
 * Denylist (not allowlist): an unrecognized provider state still gets
 * review/CI attention rather than silently treated as done. */
export const prIsOpen = (state?: string) => {
  const value = (state ?? "").trim().toLowerCase();
  if (!value) return true;
  return !DONE_STATES.has(value);
};

/** Provider mergeability signal for one lane's open PR. `ready` requires a
 * clean merge state plus nothing else outstanding — GitHub's `clean`
 * already encodes branch protection (reviews, checks, up-to-date), but
 * Azure's `succeeded` only covers conflicts, so votes/threads/checks are
 * verified explicitly for both. `REVIEW_REQUIRED` isn't ready: Azure
 * synthesizes it for assigned-but-unvoted reviewers, which a
 * conflicts-only `mergeStatus` can't rule out. Threads must be a known
 * zero — a failed count probe isn't "no threads". Drafts never signal. */
export function lanePrSignal(
  row: Pick<BoardWorkstreamRow, "pr" | "ciFailing" | "ciRunning" | "ciError" | "ciBlocked" | "probeError">,
): "ready" | "conflicts" | "blocked" | "behind" | null {
  const pr = row.pr;
  if (!pr || !prIsOpen(pr.state) || pr.draft) return null;
  if (pr.mergeState === "conflicts") return "conflicts";
  if (pr.mergeState === "blocked") return "blocked";
  if (pr.mergeState === "behind") return "behind";
  if (
    pr.mergeState === "clean" &&
    !row.ciFailing &&
    !row.ciRunning &&
    !row.ciError && !row.ciBlocked && !row.probeError &&
    pr.reviewDecision !== "CHANGES_REQUESTED" &&
    pr.reviewDecision !== "REVIEW_REQUIRED" &&
    pr.unresolvedThreads === 0
  )
    return "ready";
  return null;
}

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

/** One-line attention phrases for a card, most actionable first. `column`
 * is the card's effective column — the ticket-closed nudge only makes sense
 * outside Done (defaults to the derived column when omitted). */
export function cardAttentionLines(
  card: BoardCard,
  column?: BoardColumnId,
): string[] {
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
  // Lane PRs carrying a review verdict or unresolved threads.
  const changesRequested = (card.workstreams ?? []).filter(
    (row) => row.pr && prIsOpen(row.pr.state) && row.pr.reviewDecision === "CHANGES_REQUESTED",
  ).length;
  if (changesRequested)
    lines.push(
      changesRequested === 1 ? "Changes requested" : `Changes requested ×${changesRequested}`,
    );
  const unresolved = (card.workstreams ?? []).reduce(
    (sum, row) => sum + (row.pr && prIsOpen(row.pr.state) ? (row.pr.unresolvedThreads ?? 0) : 0),
    0,
  );
  if (unresolved)
    lines.push(unresolved === 1 ? "1 open thread" : `${unresolved} open threads`);
  // Provider-side mergeability — conflicts/blocks are problems, "ready" is
  // the positive counterpart answering "what can I land right now".
  const signals = (card.workstreams ?? []).map(lanePrSignal);
  const conflicts = signals.filter((signal) => signal === "conflicts").length;
  const blocked = signals.filter((signal) => signal === "blocked").length;
  if (conflicts)
    lines.push(conflicts === 1 ? "Merge conflicts" : `Merge conflicts ×${conflicts}`);
  if (blocked)
    lines.push(blocked === 1 ? "Merge blocked" : `Merge blocked ×${blocked}`);
  // Provider-side staleness — the lane's own `behind` count covers
  // worktree lanes; this reaches cleaned ones too.
  const behind = signals.filter((signal) => signal === "behind").length;
  if (behind)
    lines.push(behind === 1 ? "Behind base" : `Behind base ×${behind}`);
  const ready = signals.filter((signal) => signal === "ready").length;
  if (ready)
    lines.push(ready === 1 ? "Ready to merge" : `Ready to merge ×${ready}`);
  // Tickets closed but the card isn't done — the leftover PR/lane still
  // needs a decision. Only tickets carrying a provider state count — an
  // unfetched ticket can't claim "closed".
  const knownTickets = (card.tickets ?? []).filter(
    (ticket) => ticket.state || ticket.stateType,
  );
  if (
    card.kind === "task" &&
    (column ?? card.derived) !== "done" &&
    knownTickets.length &&
    knownTickets.every((ticket) => providerStage(ticket) === "done")
  )
    lines.push("Ticket closed");
  if (card.hasUpdate) lines.push("New activity");
  if (card.attentionReason) lines.push(card.attentionReason);
  const working = card.sessions.filter((session) => session.busy).length;
  if (working)
    lines.push(working === 1 ? "Working" : `${working} sessions working`);
  if (card.ciRunning && !working)
    lines.push(card.ciRunning === 1 ? "CI running" : `CI running ×${card.ciRunning}`);
  return lines;
}

/** How urgently a card needs eyes — drives the attention-first sort.
 * Pinned still wins; this only reorders inside each pinned/placed bucket. */
export function attentionScore(card: BoardCard): number {
  let score = 0;
  if (card.sessions.some((session) => session.needsInput)) score += 8;
  if (card.ciFailing) score += 6;
  if (
    (card.workstreams ?? []).some(
      (row) => row.pr && prIsOpen(row.pr.state) && row.pr.reviewDecision === "CHANGES_REQUESTED",
    )
  )
    score += 5;
  if (
    (card.workstreams ?? []).some(
      (row) => row.pr && prIsOpen(row.pr.state) && (row.pr.unresolvedThreads ?? 0) > 0,
    )
  )
    score += 4;
  if ((card.workstreams ?? []).some((row) => row.merging)) score += 4;
  if (
    (card.workstreams ?? []).some((row) => {
      const signal = lanePrSignal(row);
      return signal === "conflicts" || signal === "blocked";
    })
  )
    score += 5;
  if ((card.workstreams ?? []).some((row) => lanePrSignal(row) === "behind"))
    score += 3;
  // A mergeable PR still needs someone to land it — actionable, but below
  // the real problems.
  if ((card.workstreams ?? []).some((row) => lanePrSignal(row) === "ready"))
    score += 2;
  if (card.hasUpdate) score += 2;
  if (card.ciRunning) score += 1;
  return score;
}

/** Fingerprint of a card's actionable state — stored on snooze; any change
 * (CI flip, review verdict, session needing input, provider update) wakes
 * the card early. */
export function snoozeWakeKey(card: BoardCard): string {
  return [
    card.item?.updatedAt ?? "",
    card.state ?? "",
    // Ticket close/reopen flips — a linked ticket going done is exactly
    // the activity a snoozed card should wake for.
    (card.tickets ?? [])
      .map((ticket) => ticket.state ?? ticket.stateType ?? "")
      .join(","),
    (card.workstreams ?? [])
      .map(
        (row) =>
          `${row.pr?.state ?? ""}:${row.pr?.reviewDecision ?? ""}:${row.pr?.unresolvedThreads ?? ""}:${row.pr?.mergeState ?? ""}:${row.ciFailing}:${row.merging ? 1 : 0}`,
      )
      .join(","),
    // Discovered PRs — state flips (merged/closed), not just the count.
    (card.prs ?? []).map((pr) => pr.state ?? "").join(","),
    card.sessions
      .map((session) => `${session.busy ? 1 : 0}${session.needsInput ? 1 : 0}`)
      .join(","),
    String(card.ciFailing),
    String(card.hasUpdate),
    String(card.prs?.length ?? 0),
  ].join("|");
}

/** Is the card still asleep? A snooze hides while BOTH clocks hold: the
 * `until` time hasn't passed AND the `wake` fingerprint is unchanged.
 * Either lapse wakes the card (expired entries get swept on next write). */
export function isCardSnoozed(
  card: BoardCard,
  snooze: Snooze | undefined,
  now = Date.now(),
): boolean {
  if (!snooze) return false;
  if (snooze.until !== undefined && now >= snooze.until) return false;
  if (snooze.wake !== undefined && snooze.wake !== snoozeWakeKey(card))
    return false;
  return true;
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

export const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Boundary pattern for a ticket key — matches `PROJ-123` but not
 * `PROJ-1234` or `APROJ-123`. The join loop precompiles one per key per
 * refresh (`taskPatterns`); `itemMatchesTicketKey` compiles per call —
 * fine for its test/diagnostic callers, wrong for a hot path. */
const ticketKeyPattern = (key: string) =>
  new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(key)}(?![0-9])`, "i");

/** Whether an inbox item references a ticket key — in its identifier, title,
 * or URL. */
export function itemMatchesTicketKey(item: InboxItem, key: string): boolean {
  const haystack = [item.identifier, item.title, item.url]
    .filter(Boolean)
    .join("\n");
  return ticketKeyPattern(key).test(haystack);
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

function linkedPrFromItem(item: InboxItem): BoardLinkedPr {
  const linked = linkedWorkItemFromInboxItem(item);
  return {
    id: linked ? `item:${linkedWorkItemInboxKey(linked)}` : `item:${item.url}`,
    provider: item.provider,
    ...(cardIdentifier(item) ? { identifier: cardIdentifier(item) } : {}),
    title: item.title,
    ...(item.url ? { url: item.url } : {}),
    ...(item.state ? { state: item.state } : {}),
    ...(item.draft ? { draft: true } : {}),
    ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
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
    relatedItems: [item],
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
    tickets: task.links.flatMap(link => sessionWorkItems({ linkedWorkItem: link })).map(ticketChipFromLink),
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
  const taskCards: MutableCard[] = [];
  const taskBySession = new Map<string, { card: MutableCard; workstreamId?: string }>();
  /** Lowercase workstream branch → candidate lanes — Azure PRs join by
   * `sourceRefName`. Several lanes can share a branch name across repos, so
   * the item's repo name breaks the tie before a lane is trusted. */
  const taskByBranch = new Map<
    string,
    { card: MutableCard; workstreamId: string; repo: string }[]
  >();
  // Compiled once per key — the PR join tests every pattern per item.
  const taskPatterns = new Map<MutableCard, RegExp[]>();
  const groupById = new Map(
    (input.groups ?? []).map((group) => [group.id, group] as const),
  );

  for (const task of input.tasks ?? []) {
    if (task.archived) continue;
    const card = newTaskCard(task, groupById);
    cards.set(card.id, card);
    taskCards.push(card);
    if (task.primarySessionId) taskBySession.set(task.primarySessionId, { card });
    taskPatterns.set(
      card,
      task.links.flatMap(link => sessionWorkItems({ linkedWorkItem: link })).flatMap(ticketKeys).map(ticketKeyPattern),
    );
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
      row.ciError = status?.ciError || (status?.fetchedAt && Date.now() - status.fetchedAt > 60_000 ? "CI status is stale" : undefined);
      row.ciBlocked = status?.checks.some(c => ["unknown", "blocked", "canceled"].includes(checkState(c)));
      if (status?.merging) row.merging = true;
      if (status?.behind) row.behind = status.behind;
      if (status?.pr) {
        row.pr = {
          provider: status.provider,
          number: status.pr.number,
          title: status.pr.title,
          url: status.pr.url,
          state: status.pr.state,
          ...(status.pr.reviewDecision
            ? { reviewDecision: status.pr.reviewDecision }
            : {}),
          ...(status.pr.unresolvedThreads !== undefined
            ? { unresolvedThreads: status.pr.unresolvedThreads }
            : {}),
          ...(status.pr.draft ? { draft: true } : {}),
          ...(status.pr.updatedAt ? { updatedAt: status.pr.updatedAt } : {}),
          ...(status.pr.mergeState ? { mergeState: status.pr.mergeState } : {}),
        };
      }
      for (const check of status?.checks ?? []) {
        row.ciTotal += 1;
        const state = checkCiState(check);
        if (state === "failing") row.ciFailing += 1;
        else if (state === "running") row.ciRunning += 1;
      }
      card.workstreamRows.set(ws.id, row);
      const laneBranch = ws.branch.replace(/^refs\/heads\//, "").toLowerCase();
      if (laneBranch) {
        const lanes = taskByBranch.get(laneBranch) ?? [];
        lanes.push({
          card,
          workstreamId: ws.id,
          repo:
            ws.projectPath
              .split(/[\\/]/)
              .filter(Boolean)
              .pop()
              ?.toLowerCase() ?? "",
        });
        taskByBranch.set(laneBranch, lanes);
      }
      for (const sessionId of ws.sessionIds ?? [])
        taskBySession.set(sessionId, { card, workstreamId: ws.id });
    }
  }

  const sessionsById = new Map([...input.summaries.filter(s => !s.archived), ...input.sessions].map(s => [s.id, s]));
  const taskLinks = (card: MutableCard) => {
    const task = card.task!;
    const ids = new Set([task.primarySessionId, ...task.workstreams.flatMap(ws => ws.sessionIds ?? [])]);
    return [...task.links.flatMap(link => sessionWorkItems({ linkedWorkItem: link })),
      ...[...ids].flatMap(id => id && sessionsById.has(id) ? sessionWorkItems(sessionsById.get(id)!) : [])];
  };
  const tasksByItem = indexByWorkItem(taskCards, taskLinks);

  /** Fold a fetched item into its task card — refresh the ticket chip, put
   * a branch-matched PR on its lane, or add the PR to the discovered list.
   * `via` says which join matched. */
  const absorbItem = (
    card: MutableCard,
    item: InboxItem,
    via: "link" | "branch" | "key",
    workstreamId?: string,
  ): boolean => {
    if (via === "link") {
      card.relatedItems ??= [];
      if (!card.relatedItems.some(row => inboxItemKey(row) === inboxItemKey(item))) card.relatedItems.push(item);
      for (const link of taskLinks(card)) {
        if (!inboxItemMatchesLinkedWorkItem(item, link)) continue;
        const key = linkedWorkItemInboxKey(link);
        const index = card.tickets!.findIndex(ticket => ticket.key === key);
        if (index >= 0) card.tickets![index] = { ...ticketChipFromItem(item), key };
        else card.tickets!.push({ ...ticketChipFromItem(item), key });
      }
      return true;
    }
    if (item.kind === "pr") {
      // A branch-matched PR is the lane's own — show it on the row (a probe
      // result wins; it's fresher) rather than as a discovered chip.
      if (via === "branch" && workstreamId) {
        const row = card.workstreamRows.get(workstreamId);
        if (row && !row.pr) {
          row.pr = {
            provider: item.provider,
            number: item.number,
            title: item.title,
            url: item.url ?? "",
            state: item.state ?? "",
            ...(item.draft ? { draft: true } : {}),
            ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
          };
          return true;
        }
        // Same PR already on the row — dedupe; a *different* one falls
        // through to the discovered list rather than vanishing.
        if (row?.pr?.number === item.number) return true;
      }
      const pr = linkedPrFromItem(item);
      if (!card.prs!.some((entry) => entry.id === pr.id)) card.prs!.push(pr);
      return true;
    }
    return false;
  };

  const taskForItem = (
    item: InboxItem,
  ):
    | { card: MutableCard; via: "link" | "branch" | "key"; workstreamId?: string }
    | undefined => {
    if (item.kind !== "pr") return undefined;
    // Azure/GitLab PRs carry `sourceRefName` — a match on a workstream's
    // branch is the lane's own pull request, more precise than a guess.
    const source = item.sourceRefName
      ?.replace(/^refs\/heads\//, "")
      .toLowerCase();
    if (source) {
      const lanes = taskByBranch.get(source) ?? [];
      // The item's `owner/repo`/`project/repo` basename vs the lane's
      // project dir disambiguates shared branch names — and when known it
      // must match even a lone candidate: a same-named branch in another
      // repo is a different change entirely.
      const repo = item.repo?.split("/").pop()?.toLowerCase() ?? "";
      const candidates = repo
        ? lanes.filter((entry) => entry.repo === repo)
        : lanes;
      const lane = candidates.length === 1 ? candidates[0] : undefined;
      if (lane)
        return {
          card: lane.card,
          via: "branch",
          workstreamId: lane.workstreamId,
        };
    }
    // A PR joins a task when it carries one of the task's ticket keys.
    // Patterns compile once per card — not once per (item × key).
    const haystack = [item.identifier, item.title, item.url]
      .filter(Boolean)
      .join("\n");
    for (const [card, patterns] of taskPatterns) {
      if (patterns.some((pattern) => pattern.test(haystack)))
        return { card, via: "key" };
    }
    return undefined;
  };

  for (const item of input.items) {
    const direct = relatedFromIndex(item, tasksByItem);
    if (direct.length) {
      for (const card of direct) absorbItem(card, item, "link");
      continue;
    }
    const task = taskForItem(item);
    if (task && absorbItem(task.card, item, task.via, task.workstreamId))
      continue;
    const card = newItemCard(item);
    // Standalone Azure PR cards get their branch pipeline badges from the
    // board's `azureDevOpsBranchChecks` probe.
    for (const check of input.cardChecks?.get(card.id) ?? []) {
      card.ciTotal += 1;
      const state = checkCiState(check);
      if (state === "failing") card.ciFailing += 1;
      else if (state === "running") card.ciRunning += 1;
    }
    if (!cards.has(card.id)) cards.set(card.id, card);
  }

  const liveIds = new Set(input.sessions.map((session) => session.id));

  const attachToCard = (
    linked: LinkedWorkItem,
    ref: BoardCardSession,
    cwd?: string,
  ) => {
    const tasks = linkedWorkItemNeedsAccount(linked) ? [] : relatedFromIndex(linked, tasksByItem);
    if (tasks.length) {
      for (const task of tasks) pushSession(task, ref);
      return tasks[0];
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
    // Task-owned conversations remain reachable even when the history query
    // only returned sessions with ticket links.
    if (card.task?.primarySessionId && !card.sessionIds.has(card.task.primarySessionId)) {
      pushSession(card, { id: card.task.primarySessionId, title: card.task.title, live: false, busy: false, needsInput: false });
    }
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

  const result = [...cards.values()].map((mutable) => {
    const card = toCard(mutable);
    // Non-task cards carry membership in the store's cardGroups map — tasks
    // already resolved theirs from `groupIds` in newTaskCard.
    if (!card.groups?.length) {
      const resolved = resolveCardGroups(input.cardGroups?.[card.id], groupById);
      if (resolved.length) card.groups = resolved;
    }
    return card;
  });
  return groupRelatedCards(result, input.items);
}

/** Stable parent identity includes connection scope, never a ticket number alone. */
function hierarchyKey(item: InboxItem): string {
  return JSON.stringify([item.account ?? "", workItemIdentity(item)]);
}

export function boardCardMembers(cards: readonly BoardCard[]): BoardCard[] {
  return cards.flatMap(card => [card, ...(card.members ?? [])]);
}

function groupRelatedCards(cards: BoardCard[], items: readonly InboxItem[]): BoardCard[] {
  const families = new Map<string, { parent: InboxItem; items: InboxItem[] }>();
  const loaded = new Map(items.map(item => [hierarchyKey(item), item]));
  const parentOf = (child: InboxItem): InboxItem | undefined => child.parent ? {
    ...child.parent, parent: undefined, provider: child.provider, account: child.account,
    site: child.site, projectPath: child.projectPath,
  } : undefined;
  const cyclic = (child: InboxItem) => {
    const seen = new Set<string>();
    let current: InboxItem | undefined = child;
    while (current) {
      const key = hierarchyKey(current);
      if (seen.has(key)) return true;
      seen.add(key);
      const parent = parentOf(current);
      current = parent ? loaded.get(hierarchyKey(parent)) : undefined;
    }
    return false;
  };
  for (const child of items) {
    if (!child.parent || child.kind === "pr" || cyclic(child)) continue;
    if ((child.parent.provider && child.parent.provider !== child.provider) ||
        (child.parent.account && child.parent.account !== child.account) ||
        (child.parent.site && child.parent.site !== child.site)) continue;
    const parent: InboxItem = { ...child.parent, parent: undefined, provider: child.provider,
      account: child.account, site: child.site, projectPath: child.projectPath };
    if (!parent.url || parent.kind === "pr" || hierarchyKey(parent) === hierarchyKey(child)) continue;
    const key = hierarchyKey(parent);
    const family = families.get(key) ?? { parent, items: [parent] };
    family.items.push(child); families.set(key, family);
  }
  // Two explicit local tasks for the same provider item also share one wrapper.
  for (const item of items) {
    const owners = cards.filter(card => card.task && card.relatedItems?.some(row => hierarchyKey(row) === hierarchyKey(item)));
    if (owners.length > 1 && !item.parent && !families.has(hierarchyKey(item)))
      families.set(hierarchyKey(item), { parent: item, items: [item] });
  }
  const consumed = new Set<string>();
  const grouped: BoardCard[] = [];
  for (const [key, family] of [...families].sort(([a], [b]) => a.localeCompare(b))) {
    const keys = new Set(family.items.map(hierarchyKey));
    const members = cards.filter(card => !consumed.has(card.id) && (
      (card.relatedItems ?? (card.item ? [card.item] : [])).some(item => keys.has(hierarchyKey(item))) ||
      card.task?.links.flatMap(link => sessionWorkItems({ linkedWorkItem: link })).some(link =>
        family.items.some(item => inboxItemMatchesLinkedWorkItem(item, link)))
    ));
    if (!members.length) continue;
    members.forEach(card => consumed.add(card.id));
    // Keep missing parent context accessible, without pretending it matched the query.
    if (!members.some(card => card.item && hierarchyKey(card.item) === key)) {
      members.push(toCard(newItemCard({ ...family.parent, planningContextOnly: true })));
    }
    const tasks = members.filter(card => card.kind === "task");
    const representative = tasks.length === 1 ? tasks[0] : toCard(newItemCard(family.parent));
    const unique = <T,>(rows: T[], id: (row: T) => string) => [...new Map(rows.map(row => [id(row), row])).values()];
    const workstreams = unique(members.flatMap(card => card.workstreams ?? []), row => row.id);
    const states = members.map(card => card.derived);
    grouped.push({ ...representative,
      id: tasks.length === 1 ? representative.id : `hierarchy:${key}`,
      members, relatedItems: unique(family.items, hierarchyKey),
      tickets: unique([...members.flatMap(card => card.tickets ?? []), ...family.items.map(ticketChipFromItem)], row => row.key),
      sessions: unique(members.flatMap(card => card.sessions), row => row.id), workstreams,
      prs: unique(members.flatMap(card => card.prs ?? []), row => row.id),
      groups: unique(members.flatMap(card => card.groups ?? []), row => row.id),
      hasUpdate: members.some(card => card.hasUpdate),
      ciTotal: workstreams.reduce((n, row) => n + row.ciTotal, 0),
      ciFailing: workstreams.reduce((n, row) => n + row.ciFailing, 0),
      ciRunning: workstreams.reduce((n, row) => n + row.ciRunning, 0),
      updatedAt: Math.max(...members.map(card => card.updatedAt)),
      derived: states.includes("review") ? "review" : states.includes("progress") ? "progress" : states.every(state => state === "done") ? "done" : "todo",
    });
  }
  return [...cards.filter(card => !consumed.has(card.id)), ...grouped];
}

/** Column contents: pinned cards first (their placement order decides among
 * them — pinning writes a topmost order), then placed cards keep their
 * order, derived cards fall to the bottom sorted by recency. */
export function columnCards(
  cards: readonly BoardCard[],
  column: BoardColumnId,
  placements: Readonly<Record<string, BoardPlacement>>,
  locals: readonly BoardLocalCard[],
): BoardCard[] {
  const localOrder = new Map(locals.map((card) => [card.id, card]));
  const pinned = (card: BoardCard) =>
    card.kind === "local"
      ? localOrder.get(card.id)?.pinned === true
      : placements[card.id]?.pinned === true;
  return cards
    .filter((card) => cardColumn(card, placements) === column)
    .sort((a, b) => {
      const aPin = pinned(a);
      const bPin = pinned(b);
      if (aPin !== bPin) return aPin ? -1 : 1;
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

/** Splice `cardId` into the column's `ordered` ids at `index`. Pinned cards
 * hold the column's top regardless of order — a drop marker above them
 * can't be honored, so an unpinned card's index clamps below the pinned
 * prefix (marker and commit then agree). `pinned` is the effective set —
 * a pinned card being repositioned is unpinned by the caller first. */
export function dropOrder(
  ordered: readonly string[],
  pinned: ReadonlySet<string>,
  cardId: string,
  index: number,
): string[] {
  const rest = ordered.filter((id) => id !== cardId);
  const firstFree = rest.findIndex((id) => !pinned.has(id));
  const bound = firstFree < 0 ? rest.length : firstFree;
  const at = pinned.has(cardId)
    ? Math.min(index, rest.length)
    : Math.max(Math.min(index, rest.length), bound);
  const ids = [...rest];
  ids.splice(at, 0, cardId);
  return ids;
}
