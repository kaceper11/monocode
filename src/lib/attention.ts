import type { InboxItem, InboxProvider } from "./githubTasks";
import type { LinkedWorkItem } from "./session";
import type { AgentContext } from "./agentContext";
import type { ConnectableInboxSource } from "./inboxFilters";
import type { RepairEvidence } from "./repair";
import type { AzurePrTarget } from "./azureRepos";
import type { CiTarget } from "./azurePipelines";

/**
 * The shared attention contract (#76, #23, #24). One row in the queue equals
 * one *condition* waiting on the user — not one event. Producers either
 * derive items fresh from live state (approvals, finished sessions,
 * reminders, repair records) or emit them into the persisted store
 * (watchers, schedules). Rows clear only when the underlying condition
 * resolves or is dismissed; dispatching a quick action never clears a row.
 *
 * `signature` fingerprints the state that matters — snooze and dismiss bind
 * to it, so a row resurfaces only when the underlying state actually
 * changes, never on a timer alone.
 */

export type AttentionKind =
  | "approval" // agent approval or question pending
  | "finished" // agent finished, result unreviewed
  | "reminder" // session reminder fired
  | "repair" // repair blocked/uncertain or completed-unread
  | "ticket" // new or newly assigned ticket
  | "ticket-update" // new comment/update on a watched ticket
  | "pr-review" // PR awaiting the user's review
  | "pr-comments" // new review comments on the user's PR
  | "ci-failure" // failing CI on the user's PR/branch
  | "pr-behind" // PR behind the default branch
  | "pr-conflicts" // PR has merge conflicts
  | "pr-done" // PR reached a terminal state (merged/closed)
  | "schedule" // scheduled-run outcome (ran/skipped/missed/failed)
  | "worktree" // stale/missing working copies worth cleaning up
  | "watcher"; // watcher lifecycle row: source errors with a reconnect affordance

/** Lower sorts first. */
export type AttentionUrgency = 0 | 1 | 2;
export const ATTENTION_URGENT = 0; // needs input now (approval/question/reminder)
export const ATTENTION_ACTION = 1; // action available (fix CI, update branch, start work)
export const ATTENTION_INFO = 2; // informational (ticket update, outcome)

/** What a row's quick action does — resolved at click time in App, never at
 * produce time, so bindings always re-validate against live state. The
 * `*-comments` / `*-ci` actions are lazy repair bindings: the dispatcher
 * rebuilds fresh evidence (repair.ts) at click time rather than trusting the
 * poll-time snapshot. */
export type AttentionAction =
  | { kind: "open-session"; sessionId: string }
  | { kind: "open-changes"; sessionId: string }
  | { kind: "open-item"; item: LinkedWorkItem }
  | { kind: "start-task"; item: InboxItem }
  | {
      kind: "open-delivery";
      sessionId: string;
      delivery: "pr" | "ci";
      provider: "github" | "azure";
      prUrl?: string;
    }
  | { kind: "send-context"; context: AgentContext; sessionId?: string }
  | { kind: "repair"; evidence: RepairEvidence; context: AgentContext }
  | {
      kind: "azure-pr-comments";
      target: AzurePrTarget;
      projectName: string;
      repositoryName: string;
      cwd: string;
      branch: string;
      sessionId?: string;
    }
  | {
      kind: "github-pr-comments";
      cwd: string;
      repo: string;
      number: number;
      sessionId?: string;
    }
  | {
      kind: "azure-ci-fix";
      target: CiTarget;
      definitionName: string;
      remote: string;
      cwd: string;
      branch: string;
      runId: number;
      sessionId?: string;
    }
  | {
      kind: "github-ci-fix";
      cwd: string;
      repo: string;
      number: number;
      sessionId?: string;
    }
  | {
      kind: "update-branch";
      cwd: string;
      /** The checkout's expected branch — verified before mutating. */
      branch?: string;
      /** The PR's base branch — merged/rebased in, not the repo default. */
      base?: string;
      sessionId?: string;
    }
  | { kind: "open-automations"; watcherId?: string }
  | { kind: "reconnect"; source: ConnectableInboxSource }
  /** Opens the worktree manager for the family containing `cwd`. */
  | { kind: "open-worktrees"; cwd: string }
  | { kind: "open-url"; url: string };

export type AttentionItem = {
  /** Stable identity of the condition — same condition → same key. */
  key: string;
  kind: AttentionKind;
  /** One-line label, e.g. "PR #12 — 3 new review comments". */
  title: string;
  /** What changed, when cheaply known: "comment", "status → In Progress". */
  detail?: string;
  urgency: AttentionUrgency;
  /** Last state-change timestamp; recency ordering and display. */
  at: number;
  /** Fingerprint of the underlying state; snooze/dismiss bind to it. */
  signature: string;
  provider?: InboxProvider;
  account?: string;
  repo?: string;
  /** Owning checkout. */
  cwd?: string;
  /** Owning session, where known. */
  sessionId?: string;
  /** Provider revision / commit / run id the row was produced from. */
  revision?: string;
  /** External reference link — validated before opening, never fetched. */
  url?: string;
  action?: AttentionAction;
  /** Which producer emitted this — "watcher"/"schedule" rows are persisted;
   * derived rows are computed from live state and never stored. */
  source?: { kind: "watcher" | "schedule"; id: string };
};

export type AttentionMuteMode = "snooze" | "dismiss";
export type AttentionMute = {
  signature: string;
  mode: AttentionMuteMode;
  at: number;
};

const KEY = "monocode.attention.v1";
export const ATTENTION_CHANGED = "monocode:attention-changed";
/** Persisted watcher/schedule rows cap; derived rows are never stored. */
const MAX_ITEMS = 200;
/** Mute memory cap — evicted oldest-first so it cannot grow unboundedly. */
const MAX_MUTED = 500;
const MAX_TEXT = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const clean = (value: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Truncate on code points — `.slice` can split a surrogate pair and leave
  // a lone surrogate that renders as.
  return trimmed.length > max ? [...trimmed].slice(0, max).join("") : trimmed;
};

const KINDS: AttentionKind[] = [
  "approval",
  "finished",
  "reminder",
  "repair",
  "ticket",
  "ticket-update",
  "pr-review",
  "pr-comments",
  "ci-failure",
  "pr-behind",
  "pr-conflicts",
  "pr-done",
  "schedule",
  "worktree",
  "watcher",
];

const PROVIDERS: InboxProvider[] = [
  "github",
  "linear",
  "gitlab",
  "jira",
  "azure",
];

const ACTION_KINDS = new Set([
  "open-session",
  "open-changes",
  "open-item",
  "start-task",
  "open-delivery",
  "send-context",
  "repair",
  "azure-pr-comments",
  "github-pr-comments",
  "azure-ci-fix",
  "github-ci-fix",
  "update-branch",
  "open-automations",
  "reconnect",
  "open-worktrees",
  "open-url",
]);

/** Persisted actions are rebuilt by the dispatcher — they only carry binding
 * fields — so a corrupt store must not smuggle oversized payloads or
 * non-web URLs through the queue. */
function sanitizeAction(value: unknown): AttentionAction | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !ACTION_KINDS.has(value.kind)
  ) {
    return undefined;
  }
  if (value.kind === "open-url") {
    const url = clean(value.url, 2000);
    if (!url || !/^https?:\/\//i.test(url)) return undefined;
    return { kind: "open-url", url };
  }
  try {
    if (JSON.stringify(value).length > 8000) return undefined;
  } catch {
    return undefined;
  }
  return value as unknown as AttentionAction;
}

function sanitizeItem(value: unknown): AttentionItem | null {
  if (!isRecord(value)) return null;
  const key = clean(value.key, 300);
  const title = clean(value.title, 240);
  const signature = clean(value.signature, 300);
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
  if (!key || !title || !signature || !at) return null;
  const kind = KINDS.includes(value.kind as AttentionKind)
    ? (value.kind as AttentionKind)
    : "watcher";
  const urgency =
    value.urgency === 0 || value.urgency === 1 || value.urgency === 2
      ? value.urgency
      : ATTENTION_INFO;
  const provider = PROVIDERS.includes(value.provider as InboxProvider)
    ? (value.provider as InboxProvider)
    : undefined;
  const sourceKind = isRecord(value.source) ? value.source.kind : undefined;
  const sourceId = isRecord(value.source)
    ? clean(value.source.id, 128)
    : undefined;
  const source: AttentionItem["source"] =
    (sourceKind === "watcher" || sourceKind === "schedule") && sourceId
      ? { kind: sourceKind, id: sourceId }
      : undefined;
  return {
    key,
    kind,
    title,
    ...(clean(value.detail, 240) ? { detail: clean(value.detail, 240) } : {}),
    urgency,
    at,
    signature,
    ...(provider ? { provider } : {}),
    ...(clean(value.account, 200) ? { account: clean(value.account, 200) } : {}),
    ...(clean(value.repo, 300) ? { repo: clean(value.repo, 300) } : {}),
    ...(clean(value.cwd, 2000) ? { cwd: clean(value.cwd, 2000) } : {}),
    ...(clean(value.sessionId, 128) ? { sessionId: clean(value.sessionId, 128) } : {}),
    ...(clean(value.revision, 400) ? { revision: clean(value.revision, 400) } : {}),
    ...(clean(value.url, 2000) ? { url: clean(value.url, 2000) } : {}),
    // `action` is carried for emitted rows but rebuilt by the dispatcher —
    // trust only its serializable binding fields at click time.
    ...(sanitizeAction(value.action) ? { action: sanitizeAction(value.action)! } : {}),
    ...(source ? { source } : {}),
  };
}

type Store = {
  items: AttentionItem[];
  muted: Record<string, AttentionMute>;
};

function sanitizeStore(value: unknown): Store {
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  if (isRecord(value) && Array.isArray(value.items)) {
    // Keep the newest rows — an over-cap store would otherwise drop the
    // freshest emits and preserve stale ones.
    for (const raw of value.items.slice(-MAX_ITEMS)) {
      const item = sanitizeItem(raw);
      if (!item || seen.has(item.key)) continue;
      seen.add(item.key);
      items.push(item);
    }
  }
  const muted: Record<string, AttentionMute> = {};
  if (isRecord(value) && isRecord(value.muted)) {
    for (const [key, entry] of Object.entries(value.muted)) {
      if (Object.keys(muted).length >= MAX_MUTED) break;
      if (!isRecord(entry)) continue;
      const signature = clean(entry.signature, 300);
      const mode =
        entry.mode === "snooze" || entry.mode === "dismiss" ? entry.mode : null;
      const at =
        typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0;
      if (!key || key.length > 300 || !signature || !mode || !at) continue;
      muted[key] = { signature, mode, at };
    }
  }
  return { items, muted };
}

/** In-memory fallback once a write has failed (quota/denied storage) — keeps
 * emits, mutes, and the render snapshot consistent for the session. */
let memoryRaw: string | null = null;
let writeFailed = false;

function parseStore(raw: string | null): Store {
  if (!raw) return { items: [], muted: {} };
  try {
    return sanitizeStore(JSON.parse(raw));
  } catch {
    return { items: [], muted: {} };
  }
}

function readStore(): Store {
  if (writeFailed && memoryRaw) return parseStore(memoryRaw);
  try {
    return parseStore(localStorage.getItem(KEY));
  } catch {
    return { items: [], muted: {} };
  }
}

function writeStore(store: Store) {
  const raw = JSON.stringify(store);
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // Storage full or unavailable — serve reads from memory this session.
    writeFailed = true;
    memoryRaw = raw;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ATTENTION_CHANGED));
  }
}

/** Raw snapshot for useSyncExternalStore — stable until a write lands. */
export function attentionSnapshot(): string | null {
  if (writeFailed && memoryRaw) return memoryRaw;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return memoryRaw;
  }
}

/** Parse a snapshot string — memoize on the raw string so renders stay cheap. */
export function attentionStoreFromSnapshot(raw: string | null): Store {
  return parseStore(raw);
}

export function subscribeAttention(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener(ATTENTION_CHANGED, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ATTENTION_CHANGED, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Persisted (emitted) attention rows — watcher and schedule output only. */
export function emittedAttention(): AttentionItem[] {
  return readStore().items;
}

/**
 * Insert or update emitted rows in one store read/write — a poll group can
 * produce dozens of conditions, so batching avoids a stringify+event storm
 * per row. Same key → the row updates in place; a new signature refreshes
 * `at` and resurfaces muted rows, a replayed signature preserves the
 * original timestamp.
 */
export function emitAttentionAll(items: AttentionItem[]) {
  if (!items.length) return;
  const store = readStore();
  const prevByKey = new Map(store.items.map((row) => [row.key, row]));
  const incoming = new Set(items.map((item) => item.key));
  const merged = store.items.filter((row) => !incoming.has(row.key));
  const written = new Set<string>();
  for (const raw of items) {
    const next = sanitizeItem(raw);
    if (!next || written.has(next.key)) continue;
    written.add(next.key);
    const previous = prevByKey.get(next.key);
    // A replay of the same state must not churn ordering or defeat mutes —
    // keep the first-seen timestamp when the signature has not moved.
    merged.push(
      previous && previous.signature === next.signature
        ? { ...next, at: previous.at }
        : next,
    );
  }
  // Evict the oldest rows first; mute entries for them go too.
  while (merged.length > MAX_ITEMS) {
    const oldest = merged.reduce((a, b) => (a.at <= b.at ? a : b));
    merged.splice(merged.indexOf(oldest), 1);
    delete store.muted[oldest.key];
  }
  writeStore({ ...store, items: merged });
}

/** Single-row convenience over {@link emitAttentionAll}. */
export function emitAttention(item: AttentionItem) {
  emitAttentionAll([item]);
}

/** The condition resolved — the row disappears and its mute state drops. */
export function resolveAttention(key: string) {
  const store = readStore();
  const items = store.items.filter((row) => row.key !== key);
  if (items.length === store.items.length && !(key in store.muted)) return;
  const muted = { ...store.muted };
  delete muted[key];
  writeStore({ items, muted });
}

/** Resolve every emitted row matching `predicate` — used by watchers that
 * observe a condition cleared (green run, merged PR). */
export function resolveAttentionWhere(
  predicate: (item: AttentionItem) => boolean,
) {
  const store = readStore();
  const gone = new Set(
    store.items.filter(predicate).map((row) => row.key),
  );
  if (!gone.size) return;
  const items = store.items.filter((row) => !gone.has(row.key));
  const muted = { ...store.muted };
  for (const key of gone) delete muted[key];
  writeStore({ items, muted });
}

export function snoozeAttention(key: string, signature: string) {
  muteAttention(key, signature, "snooze");
}

export function dismissAttention(key: string, signature: string) {
  muteAttention(key, signature, "dismiss");
}

function muteAttention(
  key: string,
  signature: string,
  mode: AttentionMuteMode,
) {
  const store = readStore();
  const muted = { ...store.muted, [key]: { signature, mode, at: Date.now() } };
  const keys = Object.keys(muted);
  if (keys.length > MAX_MUTED) {
    for (const evict of keys
      .sort((a, b) => muted[a].at - muted[b].at)
      .slice(0, keys.length - MAX_MUTED)) {
      delete muted[evict];
    }
  }
  writeStore({ ...store, muted });
}

/** Remove a row from the store entirely — for dismiss of emitted rows where
 * the underlying event can never recur with a different signature. */
export function removeAttention(key: string) {
  const store = readStore();
  if (!store.items.some((row) => row.key === key) && !(key in store.muted)) {
    return;
  }
  const items = store.items.filter((row) => row.key !== key);
  const muted = { ...store.muted };
  delete muted[key];
  writeStore({ items, muted });
}

/**
 * A row is hidden while its mute entry matches the current signature. When
 * the underlying state changes, the signature changes and the row resurfaces
 * — snoozed or dismissed alike, per #76's "no reappear without a state
 * change".
 */
export function isAttentionMuted(
  item: AttentionItem,
  muted: Record<string, AttentionMute>,
): boolean {
  return muted[item.key]?.signature === item.signature;
}

/** Sort by urgency then recency — the queue's single ordering rule. */
export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => a.urgency - b.urgency || b.at - a.at);
}

/** Merge derived + emitted rows, apply mutes, sort. The queue's one read. */
export function visibleAttention(
  derived: AttentionItem[],
  store: Store = readStore(),
): AttentionItem[] {
  const keys = new Set(store.items.map((row) => row.key));
  // Emitted rows win on key collision — a watcher row outranks a derived one
  // only when they describe the same condition.
  const merged = [
    ...derived.filter((row) => !keys.has(row.key)),
    ...store.items,
  ];
  return sortAttention(
    merged.filter((row) => !isAttentionMuted(row, store.muted)),
  );
}
