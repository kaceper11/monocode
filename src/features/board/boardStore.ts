import type { LinkedWorkItem } from "../sessions/model/session";
import type { InboxTimeFilter } from "../inbox/model/inboxFilters";
import { pathKey } from "../../shared/lib/paths";

/** Group-filter sentinel for cards with no group assigned. */
export const UNGROUPED = "__ungrouped__";

/**
 * The board's own records — manual column placements, board-local cards,
 * and tasks. Everything else on a card is derived live in boardData.ts; this
 * store only holds what the user changed by hand, so provider/task state
 * never forks.
 */
/** Column ids are plain strings — the four defaults are fixed, custom
 * columns get `col:…` ids from `newEntityId`. */
export type BoardColumnId = string;

export type BoardColumn = {
  id: BoardColumnId;
  label: string;
};

/** The built-in statuses — always present, always in this order around the
 * custom columns (todo → progress → review → customs → done). Only custom
 * columns can be deleted. */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  { id: "todo", label: "Todo" },
  { id: "progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

/** Ids that can't be deleted — derivation/archive logic keys on them. */
export const DEFAULT_COLUMN_IDS = new Set<string>(
  BOARD_COLUMNS.map((column) => column.id),
);

/** A card that lives only on the board — no provider item, no session. */
export type BoardLocalCard = {
  id: string;
  title: string;
  column: BoardColumnId;
  order: number;
  createdAt: number;
  /** Pinned cards sort to the top of their column (and group wrapper). */
  pinned?: boolean;
  /** When the card entered its column — powers the "in progress 6d" age. */
  placedAt?: number;
};

/** User-dragged position for a derived card. `order` sorts within a column —
 * lower first; drops compute midpoints between neighbours. */
export type BoardPlacement = {
  column: BoardColumnId;
  order: number;
  pinned?: boolean;
  /** When the card entered its column — reordering within a column
   * preserves it, a cross-column move resets it. */
  placedAt?: number;
};

/** A snoozed card returns when `until` passes or its wake fingerprint
 * changes — whichever comes first. A snooze must name at least one wake
 * condition; a condition-less "hide forever" is what `hidden` is for. */
export type Snooze = {
  /** Epoch ms — card reappears after this. */
  until?: number;
  /** `snoozeWakeKey(card)` at snooze time — a provider/CI/session change
   * wakes the card early. */
  wake?: string;
};

/** One repo lane of a task: a branch on a worktree (or the main checkout)
 * with an optional bound session. */
export type TaskWorkstream = {
  id: string;
  projectPath: string;
  branch: string;
  base: string;
  worktreePath?: string;
  /** Pinned provider PR — review lanes fetch `pr/<N>` branches that never
   * match the PR's real head name, so probes target this url directly. */
  prUrl?: string;
  /** Bound sessions — a lane can hold multiple conversations. First is
   * treated as primary on the board card. */
  sessionIds?: string[];
};

/**
 * A task links tickets to the workstreams doing them. It owns linkage only —
 * ticket state, PRs and CI are always read live in boardData.ts.
 */
export type BoardTask = {
  id: string;
  title: string;
  links: LinkedWorkItem[];
  workstreams: TaskWorkstream[];
  /** User-defined grouping labels — ids into `Store.groups`. */
  groupIds?: string[];
  createdAt: number;
  archived?: boolean;
};

/** A named grouping label. `color` indexes `GROUP_SWATCHES` in boardData —
 * stored so a rename/delete of another group never shifts its hue. */
export type BoardGroup = {
  id: string;
  name: string;
  color: number;
};

/** The board's whole filter-bar state — saved filters store and restore
 * this wholesale, so every criterion the toolbar controls lives here. */
export type BoardFilterSpec = {
  /** Project path, "" = all projects. */
  project: string;
  /** Group ids, plus UNGROUPED for cards with no group. */
  groups: string[];
  /** Narrows the provider fetch itself, not just the view. */
  mineOnly: boolean;
  time: InboxTimeFilter;
  /** Item kinds to hide; task/local/session cards always pass. */
  hiddenKinds: ("issue" | "pr")[];
  /** Only cards that need action. */
  actionOnly: boolean;
  /** Sort each column by attention score — a sort, but saved as part of
   * the view like the filters it travels with. */
  attentionFirst: boolean;
};

export type SavedBoardFilter = {
  id: string;
  name: string;
  spec: BoardFilterSpec;
};

export const DEFAULT_BOARD_FILTER: BoardFilterSpec = {
  project: "",
  groups: [],
  mineOnly: true,
  time: "all",
  hiddenKinds: [],
  actionOnly: false,
  attentionFirst: false,
};

type Store = {
  placements: Record<string, BoardPlacement>;
  locals: BoardLocalCard[];
  tasks: BoardTask[];
  groups: BoardGroup[];
  /** Ordered columns — defaults plus user-added statuses. */
  columns: readonly BoardColumn[];
  /** Dismissed derived-card ids (items/archived rows) — hidden until
   * restored via `unarchiveAll`. */
  hidden: string[];
  /** Temporarily hidden cards — return on `until` or a wake-key change. */
  snoozed: Record<string, Snooze>;
  /** Non-task card id → group ids. Tasks carry `groupIds` on their record;
   * derived cards (items/locals) keep membership here keyed by card id. */
  cardGroups: Record<string, string[]>;
  /** User-saved filter combinations, in creation order. */
  filters: SavedBoardFilter[];
};

const KEY = "monocode.board.v1";
const EVENT = "monocode:board-changed";
const MAX_PLACEMENTS = 500;
const MAX_LOCALS = 100;
export const MAX_TASKS = 100;
const MAX_LINKS = 20;
export const MAX_WORKSTREAMS = 12;
const MAX_GROUPS = 24;
export const MAX_TASK_GROUPS = 8;
const MAX_HIDDEN = 500;
const MAX_CARD_GROUPS = 200;
const MAX_TEXT = 300;
const MAX_GROUP_NAME = 48;
const MAX_SAVED_FILTERS = 20;
const MAX_FILTER_NAME = 48;
const MAX_COLUMNS = 12;
const MAX_COLUMN_LABEL = 24;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const cleanString = (value: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

const cleanOrder = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const cleanColumn = (
  value: unknown,
  ids: ReadonlySet<string>,
): BoardColumnId | null =>
  typeof value === "string" && ids.has(value) ? value : null;

const cleanNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const newEntityId = (prefix: string) =>
  `${prefix}:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const PROVIDER_IDS = new Set([
  "github",
  "gitlab",
  "linear",
  "jira",
  "azuredevops",
]);

function cleanLinkedItem(value: unknown, depth = 0): LinkedWorkItem | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === "issue" || value.kind === "pr" ? value.kind : null;
  const url = cleanString(value.url, 600);
  if (!kind || !url) return null;
  // Fork-era boards persisted Azure links as "azure"; normalize to upstream's
  // "azuredevops" provider id.
  const rawProvider =
    value.provider === "azure" ? "azuredevops" : value.provider;
  const provider =
    typeof rawProvider === "string" && PROVIDER_IDS.has(rawProvider)
      ? (rawProvider as LinkedWorkItem["provider"])
      : undefined;
  const additionalItems =
    depth === 0 && Array.isArray(value.additionalItems)
      ? value.additionalItems
          .map((entry) => cleanLinkedItem(entry, 1))
          .filter((entry): entry is LinkedWorkItem => entry !== null)
          .slice(0, MAX_LINKS)
      : undefined;
  return {
    kind,
    url,
    repo: cleanString(value.repo) ?? "",
    number: cleanNumber(value.number) ?? 0,
    ...(provider ? { provider } : {}),
    ...(cleanString(value.account) ? { account: cleanString(value.account) } : {}),
    ...(cleanString(value.identifier)
      ? { identifier: cleanString(value.identifier) }
      : {}),
    ...(cleanString(value.id, 120) ? { id: cleanString(value.id, 120) } : {}),
    ...(cleanString(value.site, 300)
      ? { site: cleanString(value.site, 300) }
      : {}),
    ...(cleanString(value.title) ? { title: cleanString(value.title) } : {}),
    ...(additionalItems?.length ? { additionalItems } : {}),
  };
}

function sanitizeTasks(value: unknown): BoardTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: BoardTask[] = [];
  // Live and archived cap separately — `addTask` only counts live tasks,
  // so a shared cap would silently drop whichever task landed last.
  let live = 0;
  let archived = 0;
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const isArchived = raw.archived === true;
    if ((isArchived ? archived : live) >= MAX_TASKS) continue;
    const id = cleanString(raw.id, 120);
    const title = cleanString(raw.title);
    if (!id || !title) continue;
    const links = Array.isArray(raw.links)
      ? raw.links
          .map((entry) => cleanLinkedItem(entry))
          .filter((entry): entry is LinkedWorkItem => entry !== null)
      : [];
    const workstreams: TaskWorkstream[] = [];
    if (Array.isArray(raw.workstreams)) {
      for (const ws of raw.workstreams) {
        if (workstreams.length >= MAX_WORKSTREAMS) break;
        if (!isRecord(ws)) continue;
        const wsId = cleanString(ws.id, 120);
        const projectPath = cleanString(ws.projectPath, 600);
        const branch = cleanString(ws.branch, 200);
        if (!wsId || !projectPath || !branch) continue;
        // `sessionId` (string) predates `sessionIds` — fold it in ahead of
        // the list so the newest-8 trim can't displace a real session for it.
        const sessionIds = [
          ws.sessionId,
          ...(Array.isArray(ws.sessionIds) ? ws.sessionIds : []),
        ]
          .map((entry) => cleanString(entry, 120))
          .filter((entry): entry is string => !!entry)
          .filter((entry, index, list) => list.indexOf(entry) === index)
          // Writers append — keep the newest, not the oldest.
          .slice(-8);
        workstreams.push({
          id: wsId,
          projectPath,
          branch,
          base: cleanString(ws.base, 200) ?? "HEAD",
          ...(cleanString(ws.worktreePath, 600)
            ? { worktreePath: cleanString(ws.worktreePath, 600) }
            : {}),
          ...(cleanString(ws.prUrl, 600)
            ? { prUrl: cleanString(ws.prUrl, 600) }
            : {}),
          ...(sessionIds.length ? { sessionIds } : {}),
        });
      }
    }
    const groupIds = Array.isArray(raw.groupIds)
      ? raw.groupIds
          .map((entry) => cleanString(entry, 120))
          .filter((entry): entry is string => !!entry)
          .filter((entry, index, list) => list.indexOf(entry) === index)
          .slice(0, MAX_TASK_GROUPS)
      : [];
    tasks.push({
      id,
      title,
      links,
      workstreams,
      ...(groupIds.length ? { groupIds } : {}),
      createdAt: cleanNumber(raw.createdAt) ?? Date.now(),
      ...(isArchived ? { archived: true } : {}),
    });
    if (isArchived) archived++;
    else live++;
  }
  return tasks;
}

const BOARD_TIME_IDS = new Set<string>(["all", "today", "7d", "30d"]);
const BOARD_KIND_IDS = new Set<string>(["issue", "pr"]);

/** Coerces anything into a complete spec — missing/corrupt fields fall back
 * to defaults so an old or hand-edited record still applies cleanly. */
function cleanFilterSpec(value: unknown): BoardFilterSpec {
  const raw = isRecord(value) ? value : {};
  const groups = Array.isArray(raw.groups)
    ? raw.groups
        .map((entry) => cleanString(entry, 120))
        .filter((entry): entry is string => !!entry)
        .filter((entry, index, list) => list.indexOf(entry) === index)
        .slice(0, MAX_GROUPS + 1)
    : [];
  const hiddenKinds = Array.isArray(raw.hiddenKinds)
    ? raw.hiddenKinds
        .filter(
          (entry): entry is "issue" | "pr" =>
            typeof entry === "string" && BOARD_KIND_IDS.has(entry),
        )
        .filter((entry, index, list) => list.indexOf(entry) === index)
    : [];
  return {
    project: cleanString(raw.project, 600) ?? "",
    groups,
    mineOnly: raw.mineOnly !== false,
    time:
      typeof raw.time === "string" && BOARD_TIME_IDS.has(raw.time)
        ? (raw.time as InboxTimeFilter)
        : "all",
    hiddenKinds,
    actionOnly: raw.actionOnly === true,
    attentionFirst: raw.attentionFirst === true,
  };
}

function sanitizeFilters(value: unknown): SavedBoardFilter[] {
  if (!Array.isArray(value)) return [];
  const filters: SavedBoardFilter[] = [];
  for (const raw of value) {
    if (filters.length >= MAX_SAVED_FILTERS) break;
    if (!isRecord(raw)) continue;
    const id = cleanString(raw.id, 120);
    const name = cleanString(raw.name, MAX_FILTER_NAME);
    if (!id || !name) continue;
    filters.push({ id, name, spec: cleanFilterSpec(raw.spec) });
  }
  return filters;
}

function sanitizeGroups(value: unknown): BoardGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: BoardGroup[] = [];
  for (const raw of value) {
    if (groups.length >= MAX_GROUPS) break;
    if (!isRecord(raw)) continue;
    const id = cleanString(raw.id, 120);
    const name = cleanString(raw.name, MAX_GROUP_NAME);
    if (!id || !name) continue;
    const color =
      typeof raw.color === "number" && Number.isFinite(raw.color)
        ? Math.max(0, Math.floor(raw.color))
        : 0;
    groups.push({ id, name, color });
  }
  return groups;
}

/** Stored column list normalized to `todo → progress → review → customs →
 * done`. Missing defaults are injected; customs keep their stored order and
 * can only live between review and done. */
function sanitizeColumns(value: unknown): BoardColumn[] {
  const stored = new Map<string, BoardColumn>();
  const customs: BoardColumn[] = [];
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (!isRecord(raw)) continue;
      const id = cleanString(raw.id, 60);
      const label = cleanString(raw.label, MAX_COLUMN_LABEL);
      if (!id || !label || stored.has(id)) continue;
      const column = { id, label };
      stored.set(id, column);
      if (
        !DEFAULT_COLUMN_IDS.has(id) &&
        customs.length < MAX_COLUMNS - BOARD_COLUMNS.length
      )
        customs.push(column);
    }
  }
  // Defaults hold their canonical slots; customs live between review and
  // done — the same slot `addColumn` writes.
  const get = (id: BoardColumnId) =>
    stored.get(id) ?? BOARD_COLUMNS.find((column) => column.id === id)!;
  return [get("todo"), get("progress"), get("review"), ...customs, get("done")];
}

function sanitizeStore(value: unknown): Store {
  const placements: Record<string, BoardPlacement> = {};
  const locals: BoardLocalCard[] = [];
  let tasks: BoardTask[] = [];
  let groups: BoardGroup[] = [];
  let filters: SavedBoardFilter[] = [];
  const hidden: string[] = [];
  const snoozed: Record<string, Snooze> = {};
  const cardGroups: Record<string, string[]> = {};
  const columns = isRecord(value) ? sanitizeColumns(value.columns) : null;
  const columnIds = new Set((columns ?? BOARD_COLUMNS).map((c) => c.id));
  if (isRecord(value)) {
    if (isRecord(value.placements)) {
      for (const [key, raw] of Object.entries(value.placements)) {
        if (Object.keys(placements).length >= MAX_PLACEMENTS) break;
        if (!key || key.length > 300 || !isRecord(raw)) continue;
        const column = cleanColumn(raw.column, columnIds);
        if (!column) continue;
        placements[key] = {
          column,
          order: cleanOrder(raw.order),
          ...(raw.pinned === true ? { pinned: true } : {}),
          ...(cleanNumber(raw.placedAt) !== undefined
            ? { placedAt: cleanNumber(raw.placedAt) }
            : {}),
        };
      }
    }
    if (Array.isArray(value.locals)) {
      for (const raw of value.locals) {
        if (locals.length >= MAX_LOCALS) break;
        if (!isRecord(raw)) continue;
        const id = cleanString(raw.id, 120);
        const title = cleanString(raw.title);
        const column = cleanColumn(raw.column, columnIds) ?? "todo";
        if (!id || !title) continue;
        locals.push({
          id,
          title,
          column,
          order: cleanOrder(raw.order),
          createdAt:
            typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
              ? raw.createdAt
              : Date.now(),
          ...(raw.pinned === true ? { pinned: true } : {}),
          ...(cleanNumber(raw.placedAt) !== undefined
            ? { placedAt: cleanNumber(raw.placedAt) }
            : {}),
        });
      }
    }
    tasks = sanitizeTasks(value.tasks);
    groups = sanitizeGroups(value.groups);
    filters = sanitizeFilters(value.filters);
    if (Array.isArray(value.hidden)) {
      for (const entry of value.hidden) {
        if (hidden.length >= MAX_HIDDEN) break;
        const id = cleanString(entry, 300);
        if (id && !hidden.includes(id)) hidden.push(id);
      }
    }
    if (isRecord(value.snoozed)) {
      for (const [key, raw] of Object.entries(value.snoozed)) {
        if (Object.keys(snoozed).length >= MAX_HIDDEN) break;
        if (!key || key.length > 300 || !isRecord(raw)) continue;
        const until = cleanNumber(raw.until);
        const wake = cleanString(raw.wake, 600);
        if (until === undefined && !wake) continue;
        // Already-expired snoozes are done sleeping.
        if (until !== undefined && until <= Date.now()) continue;
        snoozed[key] = {
          ...(until !== undefined ? { until } : {}),
          ...(wake ? { wake } : {}),
        };
      }
    }
    if (isRecord(value.cardGroups)) {
      for (const [cardId, raw] of Object.entries(value.cardGroups)) {
        if (Object.keys(cardGroups).length >= MAX_CARD_GROUPS) break;
        if (!cardId || cardId.length > 300 || !Array.isArray(raw)) continue;
        const ids = raw
          .map((entry) => cleanString(entry, 120))
          .filter((entry): entry is string => !!entry)
          .filter((entry, index, list) => list.indexOf(entry) === index)
          .slice(0, MAX_TASK_GROUPS);
        if (ids.length) cardGroups[cardId] = ids;
      }
    }
  }
  // Drop references to groups that no longer exist.
  const valid = new Set(groups.map((group) => group.id));
  tasks = tasks.map((task) =>
    task.groupIds?.length
      ? {
          ...task,
          groupIds: task.groupIds.filter((id) => valid.has(id)),
        }
      : task,
  );
  for (const cardId of Object.keys(cardGroups)) {
    cardGroups[cardId] = cardGroups[cardId].filter((id) => valid.has(id));
    if (!cardGroups[cardId].length) delete cardGroups[cardId];
  }
  filters = filters.map((filter) => ({
    ...filter,
    spec: {
      ...filter.spec,
      groups: filter.spec.groups.filter(
        (id) => id === UNGROUPED || valid.has(id),
      ),
    },
  }));
  return {
    placements,
    locals,
    tasks,
    groups,
    columns: columns ?? [...BOARD_COLUMNS],
    hidden,
    snoozed,
    cardGroups,
    filters,
  };
}

let memoryRaw: string | null = null;

function readRaw(): string | null {
  if (memoryRaw !== null) return memoryRaw;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const EMPTY_STORE: Store = {
  placements: {},
  locals: [],
  tasks: [],
  groups: [],
  columns: BOARD_COLUMNS,
  hidden: [],
  snoozed: {},
  cardGroups: {},
  filters: [],
};

export function loadBoard(): Store {
  const raw = readRaw();
  if (!raw) return EMPTY_STORE;
  try {
    return sanitizeStore(JSON.parse(raw));
  } catch {
    return EMPTY_STORE;
  }
}

function writeStore(store: Store) {
  const raw = JSON.stringify(store);
  try {
    localStorage.setItem(KEY, raw);
    memoryRaw = null;
  } catch {
    // Quota/denied storage — keep the session's in-memory record.
    memoryRaw = raw;
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Raw snapshot for useSyncExternalStore — stable until a write lands. */
export function boardSnapshot(): string | null {
  return readRaw();
}

export function boardFromSnapshot(raw: string | null): Store {
  if (!raw) return EMPTY_STORE;
  try {
    return sanitizeStore(JSON.parse(raw));
  } catch {
    return EMPTY_STORE;
  }
}

export function subscribeBoard(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Persist one column's full visible order after a drop. Every listed card
 * gets a sequential placement (or a local-card move), so the stored order
 * always matches what the user just saw — no midpoint drift to repair.
 * Ids absent from the list keep their placements; other columns untouched.
 */
export function placeColumnOrder(
  column: BoardColumnId,
  orderedIds: readonly string[],
) {
  const store = loadBoard();
  if (!store.columns.some((entry) => entry.id === column)) return;
  const now = Date.now();
  const placements = { ...store.placements };
  const localIds = new Set(store.locals.map((card) => card.id));
  let index = 0;
  const locals = store.locals.map((card) => {
    const position = orderedIds.indexOf(card.id);
    if (position < 0) return card;
    // A reorder inside the column keeps its entry time — only a real
    // move restarts the age clock.
    return {
      ...card,
      column,
      order: position * 1024,
      placedAt: card.column === column ? (card.placedAt ?? now) : now,
    };
  });
  for (const id of orderedIds) {
    if (localIds.has(id)) {
      index += 1;
      continue;
    }
    const prior = placements[id];
    placements[id] = {
      column,
      order: index * 1024,
      ...(prior?.pinned ? { pinned: true } : {}),
      placedAt: prior?.column === column ? (prior.placedAt ?? now) : now,
    };
    index += 1;
  }
  writeStore({ ...store, placements, locals });
}

/** Pin a card to the top of a column — and to the top of its group wrapper,
 * since pinned members sort first. Pinning an unplaced card writes a
 * placement at the column's top; unpinning clears the flag but keeps the
 * position (Reset removes the placement entirely). */
export function pinCard(
  cardId: string,
  column: BoardColumnId,
  pinned: boolean,
) {
  const store = loadBoard();
  if (!store.columns.some((entry) => entry.id === column)) return;
  const topOrder = pinned
    ? Math.min(
        0,
        ...Object.values(store.placements)
          .filter((p) => p.column === column)
          .map((p) => p.order),
        ...store.locals
          .filter((c) => c.column === column)
          .map((c) => c.order),
      ) - 1024
    : 0;
  if (store.locals.some((card) => card.id === cardId)) {
    writeStore({
      ...store,
      locals: store.locals.map((card) =>
        card.id === cardId
          ? {
              ...card,
              pinned: pinned || undefined,
              ...(pinned
                ? {
                    column,
                    order: topOrder,
                    placedAt:
                      card.column === column
                        ? (card.placedAt ?? Date.now())
                        : Date.now(),
                  }
                : {}),
            }
          : card,
      ),
    });
    return;
  }
  const placements = { ...store.placements };
  const existing = placements[cardId];
  if (pinned) {
    placements[cardId] = {
      column,
      order: topOrder,
      pinned: true,
      // Pinning isn't a move — keep the column-entry time unless the
      // pin also carried the card across columns.
      placedAt:
        existing?.column === column
          ? (existing.placedAt ?? Date.now())
          : Date.now(),
    };
  } else if (existing?.pinned) {
    placements[cardId] = {
      column: existing.column,
      order: existing.order,
      ...(existing.placedAt !== undefined
        ? { placedAt: existing.placedAt }
        : {}),
    };
  } else {
    return;
  }
  writeStore({ ...store, placements });
}

/** Back to the derived column — clears both placement and ordering. */
export function unplaceCard(cardId: string) {
  const store = loadBoard();
  if (!(cardId in store.placements)) return;
  const placements = { ...store.placements };
  delete placements[cardId];
  writeStore({ ...store, placements });
}

export function addLocalCard(title: string): string | null {
  const cleaned = title.trim().slice(0, MAX_TEXT);
  if (!cleaned) return null;
  const store = loadBoard();
  const id = newEntityId("local");
  const topOrder = store.locals
    .filter((card) => card.column === "todo")
    .reduce((min, card) => Math.min(min, card.order), 0);
  writeStore({
    ...store,
    locals: [
      ...store.locals,
      {
        id,
        title: cleaned,
        column: "todo",
        order: topOrder - 1024,
        createdAt: Date.now(),
        placedAt: Date.now(),
      },
    ],
  });
  return id;
}

export function removeLocalCard(id: string) {
  const store = loadBoard();
  const cardGroups = { ...store.cardGroups };
  delete cardGroups[id];
  const snoozed = { ...store.snoozed };
  delete snoozed[id];
  writeStore({
    ...store,
    locals: store.locals.filter((card) => card.id !== id),
    // A locally-archived card leaves `hidden`/`snoozed` entries — prune.
    hidden: store.hidden.filter((entry) => entry !== id),
    cardGroups,
    snoozed,
  });
}

export function renameLocalCard(id: string, title: string) {
  const cleaned = title.trim().slice(0, MAX_TEXT);
  if (!cleaned) return;
  const store = loadBoard();
  if (!store.locals.some((card) => card.id === id)) return;
  writeStore({
    ...store,
    locals: store.locals.map((card) =>
      card.id === id ? { ...card, title: cleaned } : card,
    ),
  });
}

// --- archive --------------------------------------------------------------

/** Dismiss derived cards (provider items, etc.) — they re-derive every
 * refresh, so "archive" is a hidden-id list rather than a flag on a record. */
export function hideCards(ids: readonly string[]) {
  if (!ids.length) return;
  const store = loadBoard();
  const merged = [...store.hidden];
  for (const id of ids)
    if (merged.length < MAX_HIDDEN && !merged.includes(id)) merged.push(id);
  writeStore({ ...store, hidden: merged });
}

/** Snooze a card — it disappears until `snooze.until` passes or its wake
 * fingerprint (`snoozeWakeKey` at snooze time) changes, e.g. a CI flip or
 * a new review. An empty snooze has no wake condition — permanent
 * dismissal is `hideCards`. */
export function snoozeCard(cardId: string, snooze: Snooze) {
  if (snooze.until === undefined && !snooze.wake) return;
  const store = loadBoard();
  if (
    !(cardId in store.snoozed) &&
    Object.keys(store.snoozed).length >= MAX_HIDDEN
  )
    return;
  writeStore({
    ...store,
    snoozed: { ...store.snoozed, [cardId]: snooze },
  });
}

export function unsnoozeCard(cardId: string) {
  const store = loadBoard();
  if (!(cardId in store.snoozed)) return;
  const snoozed = { ...store.snoozed };
  delete snoozed[cardId];
  writeStore({ ...store, snoozed });
}

/** Restore everything archived: hidden derived cards + archived tasks. */
export function unarchiveAll() {
  const store = loadBoard();
  // Restoring past the live cap would push tasks off the board on the next
  // sanitize — restore only what fits, leave the overflow archived.
  let live = store.tasks.filter((task) => !task.archived).length;
  writeStore({
    ...store,
    hidden: [],
    snoozed: {},
    tasks: store.tasks.map((task) => {
      if (!task.archived || live >= MAX_TASKS) return task;
      live++;
      return { ...task, archived: false };
    }),
  });
}

/** Archive several tasks in one write — bulk moves like "archive done". */
export function archiveTasks(ids: readonly string[]) {
  if (!ids.length) return;
  const wanted = new Set(ids);
  const store = loadBoard();
  if (!store.tasks.some((task) => wanted.has(task.id) && !task.archived))
    return;
  // A full archive pool can't take more — overflow would be dropped on
  // the next sanitize, so those tasks stay live instead of lost.
  let archived = store.tasks.filter((task) => task.archived).length;
  writeStore({
    ...store,
    tasks: store.tasks.map((task) => {
      if (!wanted.has(task.id) || task.archived || archived >= MAX_TASKS)
        return task;
      archived++;
      return { ...task, archived: true };
    }),
  });
}

export function addTask(input: {
  title: string;
  links: LinkedWorkItem[];
  workstreams: TaskWorkstream[];
  groupIds?: string[];
}): string | null {
  const title = input.title.trim().slice(0, MAX_TEXT);
  if (!title) return null;
  const store = loadBoard();
  // Archived tasks don't render — matching the callers' pre-check, they
  // don't count toward the cap either.
  if (store.tasks.filter((task) => !task.archived).length >= MAX_TASKS)
    return null;
  const id = newEntityId("task");
  const groupIds = (input.groupIds ?? [])
    .filter((groupId) => store.groups.some((group) => group.id === groupId))
    .slice(0, MAX_TASK_GROUPS);
  writeStore({
    ...store,
    tasks: [
      ...store.tasks,
      {
        id,
        title,
        links: input.links.slice(0, MAX_LINKS),
        workstreams: input.workstreams.slice(0, MAX_WORKSTREAMS),
        ...(groupIds.length ? { groupIds } : {}),
        createdAt: Date.now(),
      },
    ],
  });
  return id;
}

/** Shallow patch; array fields replace wholesale. Pass an updater to
 * compose against the stored task rather than a render-time copy, so
 * edits aren't clobbered by async writes in between. Unknown id is a no-op. */
export function updateTask(
  id: string,
  patch:
    | Partial<Omit<BoardTask, "id">>
    | ((task: BoardTask) => Partial<Omit<BoardTask, "id">>),
) {
  const store = loadBoard();
  if (!store.tasks.some((task) => task.id === id)) return;
  writeStore({
    ...store,
    tasks: store.tasks.map((task) =>
      task.id === id
        ? { ...task, ...(typeof patch === "function" ? patch(task) : patch), id }
        : task,
    ),
  });
}

export function removeTask(id: string) {
  const store = loadBoard();
  if (!store.tasks.some((task) => task.id === id)) return;
  const placements = { ...store.placements };
  delete placements[id];
  const snoozed = { ...store.snoozed };
  delete snoozed[id];
  writeStore({
    ...store,
    tasks: store.tasks.filter((task) => task.id !== id),
    placements,
    snoozed,
  });
}

// --- groups --------------------------------------------------------------

/** Number of swatches in `GROUP_SWATCHES` (boardData) — `color` cycles. */
const GROUP_COLOR_COUNT = 8;

export function createGroup(name: string): string | null {
  const cleaned = name.trim().slice(0, MAX_GROUP_NAME);
  if (!cleaned) return null;
  const store = loadBoard();
  if (store.groups.length >= MAX_GROUPS) return null;
  const id = newEntityId("grp");
  // Cycle past the highest index in use so colors don't collide after
  // deletions reshuffle `groups.length`.
  const color =
    (store.groups.reduce((max, group) => Math.max(max, group.color), -1) + 1) %
    GROUP_COLOR_COUNT;
  writeStore({
    ...store,
    groups: [...store.groups, { id, name: cleaned, color }],
  });
  return id;
}

export function renameGroup(id: string, name: string) {
  const cleaned = name.trim().slice(0, MAX_GROUP_NAME);
  if (!cleaned) return;
  const store = loadBoard();
  if (!store.groups.some((group) => group.id === id)) return;
  writeStore({
    ...store,
    groups: store.groups.map((group) =>
      group.id === id ? { ...group, name: cleaned } : group,
    ),
  });
}

/** Deletes the group and strips it from every task and card that
 * referenced it. */
export function deleteGroup(id: string) {
  const store = loadBoard();
  if (!store.groups.some((group) => group.id === id)) return;
  const cardGroups: Record<string, string[]> = {};
  for (const [cardId, ids] of Object.entries(store.cardGroups)) {
    const kept = ids.filter((entry) => entry !== id);
    if (kept.length) cardGroups[cardId] = kept;
  }
  writeStore({
    ...store,
    groups: store.groups.filter((group) => group.id !== id),
    tasks: store.tasks.map((task) =>
      task.groupIds?.includes(id)
        ? {
            ...task,
            groupIds: task.groupIds.filter((entry) => entry !== id),
          }
        : task,
    ),
    cardGroups,
  });
}

export function removeCardFromGroup(cardId: string, groupId: string) {
  const store = loadBoard();
  const current = store.cardGroups[cardId];
  if (!current?.includes(groupId)) return;
  const next = current.filter((id) => id !== groupId);
  const cardGroups = { ...store.cardGroups };
  if (next.length) cardGroups[cardId] = next;
  else delete cardGroups[cardId];
  writeStore({ ...store, cardGroups });
}

/** Replace a non-task card's group membership wholesale — callers compute
 * the merged list (first id is primary: the wrapper the card renders in). */
export function setCardGroups(cardId: string, ids: readonly string[]) {
  const store = loadBoard();
  const valid = new Set(store.groups.map((group) => group.id));
  const next = [...new Set(ids)]
    .filter((id) => valid.has(id))
    .slice(0, MAX_TASK_GROUPS);
  const cardGroups = { ...store.cardGroups };
  if (next.length) cardGroups[cardId] = next;
  else delete cardGroups[cardId];
  writeStore({ ...store, cardGroups });
}

// --- columns -------------------------------------------------------------

/** Add a custom status column, inserted before Done. Returns its id. */
export function addColumn(label: string): string | null {
  const cleaned = label.trim().slice(0, MAX_COLUMN_LABEL);
  if (!cleaned) return null;
  const store = loadBoard();
  if (store.columns.length >= MAX_COLUMNS) return null;
  const column = { id: newEntityId("col"), label: cleaned };
  const columns = [...store.columns];
  const doneIndex = columns.findIndex((entry) => entry.id === "done");
  columns.splice(doneIndex < 0 ? columns.length : doneIndex, 0, column);
  writeStore({ ...store, columns });
  return column.id;
}

export function renameColumn(id: string, label: string) {
  const cleaned = label.trim().slice(0, MAX_COLUMN_LABEL);
  if (!cleaned) return;
  const store = loadBoard();
  if (!store.columns.some((column) => column.id === id)) return;
  writeStore({
    ...store,
    columns: store.columns.map((column) =>
      column.id === id ? { ...column, label: cleaned } : column,
    ),
  });
}

/** Deletes a custom column — defaults refuse. With `target`, its cards move
 * to that column appended at the end; otherwise placements drop (cards fall
 * back to their derived column) and local cards move to Todo. */
export function removeColumn(id: string, target?: string) {
  if (DEFAULT_COLUMN_IDS.has(id)) return;
  const store = loadBoard();
  if (!store.columns.some((column) => column.id === id)) return;
  const destination =
    target && target !== id && store.columns.some((c) => c.id === target)
      ? target
      : undefined;
  // Moved cards append after the destination's content — the fallback for
  // local cards is Todo, so that's the baseline when no target was picked.
  const appendTo = destination ?? "todo";
  let order = Math.max(
    0,
    ...Object.values(store.placements)
      .filter((p) => p.column === appendTo)
      .map((p) => p.order),
    ...store.locals
      .filter((c) => c.column === appendTo)
      .map((c) => c.order),
  );
  const placements: Record<string, BoardPlacement> = {};
  const now = Date.now();
  for (const [cardId, placement] of Object.entries(store.placements)) {
    if (placement.column !== id) placements[cardId] = placement;
    else if (destination)
      placements[cardId] = {
        column: destination,
        order: (order += 1024),
        ...(placement.pinned ? { pinned: true } : {}),
        placedAt: now,
      };
  }
  writeStore({
    ...store,
    columns: store.columns.filter((column) => column.id !== id),
    placements,
    locals: store.locals.map((card) =>
      card.column === id
        ? { ...card, column: appendTo, order: (order += 1024), placedAt: now }
        : card,
    ),
  });
}

// --- saved filters ---------------------------------------------------------

/** Field-by-field compare — groups/kinds are sets (order is incidental) and
 * the project compares by path key so case/trailing-slash noise doesn't
 * make an identical filter look different. */
export function sameBoardFilterSpec(
  a: BoardFilterSpec,
  b: BoardFilterSpec,
): boolean {
  const ids = (list: readonly string[]) => [...list].sort().join("\n");
  return (
    pathKey(a.project) === pathKey(b.project) &&
    a.mineOnly === b.mineOnly &&
    a.time === b.time &&
    a.actionOnly === b.actionOnly &&
    a.attentionFirst === b.attentionFirst &&
    ids(a.groups) === ids(b.groups) &&
    ids(a.hiddenKinds) === ids(b.hiddenKinds)
  );
}

/** Save `spec` under `name`. A name that already exists (case-insensitive)
 * overwrites that filter — that's how a saved filter's criteria get edited.
 * Returns the filter's id, or null when the name is empty or the cap hit. */
export function saveBoardFilter(
  name: string,
  spec: BoardFilterSpec,
): string | null {
  const cleaned = name.trim().slice(0, MAX_FILTER_NAME);
  if (!cleaned) return null;
  const store = loadBoard();
  const valid = new Set(store.groups.map((group) => group.id));
  const clean = cleanFilterSpec(spec);
  clean.groups = clean.groups.filter(
    (id) => id === UNGROUPED || valid.has(id),
  );
  const existing = store.filters.find(
    (filter) => filter.name.toLowerCase() === cleaned.toLowerCase(),
  );
  if (existing) {
    writeStore({
      ...store,
      filters: store.filters.map((filter) =>
        filter.id === existing.id
          ? { ...filter, name: cleaned, spec: clean }
          : filter,
      ),
    });
    return existing.id;
  }
  if (store.filters.length >= MAX_SAVED_FILTERS) return null;
  const id = newEntityId("flt");
  writeStore({
    ...store,
    filters: [...store.filters, { id, name: cleaned, spec: clean }],
  });
  return id;
}

export function renameBoardFilter(id: string, name: string) {
  const cleaned = name.trim().slice(0, MAX_FILTER_NAME);
  if (!cleaned) return;
  const store = loadBoard();
  if (!store.filters.some((filter) => filter.id === id)) return;
  writeStore({
    ...store,
    filters: store.filters.map((filter) =>
      filter.id === id ? { ...filter, name: cleaned } : filter,
    ),
  });
}

export function deleteBoardFilter(id: string) {
  const store = loadBoard();
  if (!store.filters.some((filter) => filter.id === id)) return;
  writeStore({
    ...store,
    filters: store.filters.filter((filter) => filter.id !== id),
  });
}
