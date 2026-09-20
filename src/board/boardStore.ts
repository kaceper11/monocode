import type { LinkedWorkItem } from "../lib/session";

/**
 * The board's own records — manual column placements, board-local cards,
 * and tasks. Everything else on a card is derived live in boardData.ts; this
 * store only holds what the user changed by hand, so provider/task state
 * never forks.
 */
export type BoardColumnId = "todo" | "progress" | "review" | "done";

export const BOARD_COLUMNS: readonly {
  id: BoardColumnId;
  label: string;
}[] = [
  { id: "todo", label: "Todo" },
  { id: "progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

/** A card that lives only on the board — no provider item, no session. */
export type BoardLocalCard = {
  id: string;
  title: string;
  column: BoardColumnId;
  order: number;
  createdAt: number;
};

/** User-dragged position for a derived card. `order` sorts within a column —
 * lower first; drops compute midpoints between neighbours. */
export type BoardPlacement = {
  column: BoardColumnId;
  order: number;
};

/** One repo lane of a task: a branch on a worktree (or the main checkout)
 * with an optional bound session. */
export type TaskWorkstream = {
  id: string;
  projectPath: string;
  branch: string;
  base: string;
  worktreePath?: string;
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

type Store = {
  placements: Record<string, BoardPlacement>;
  locals: BoardLocalCard[];
  tasks: BoardTask[];
  groups: BoardGroup[];
  /** Dismissed derived-card ids (items/archived rows) — hidden until
   * restored via `unarchiveAll`. */
  hidden: string[];
  /** Non-task card id → group ids. Tasks carry `groupIds` on their record;
   * derived cards (items/locals) keep membership here keyed by card id. */
  cardGroups: Record<string, string[]>;
};

const KEY = "monocode.board.v1";
const EVENT = "monocode:board-changed";
const MAX_PLACEMENTS = 500;
const MAX_LOCALS = 100;
const MAX_TASKS = 100;
const MAX_LINKS = 20;
const MAX_WORKSTREAMS = 12;
const MAX_GROUPS = 24;
const MAX_TASK_GROUPS = 8;
const MAX_HIDDEN = 500;
const MAX_CARD_GROUPS = 200;
const MAX_TEXT = 300;
const MAX_GROUP_NAME = 48;

const COLUMN_IDS = new Set<string>(BOARD_COLUMNS.map((column) => column.id));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const cleanString = (value: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

const cleanOrder = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const cleanColumn = (value: unknown): BoardColumnId | null =>
  typeof value === "string" && COLUMN_IDS.has(value)
    ? (value as BoardColumnId)
    : null;

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
  "azure",
]);

function cleanLinkedItem(value: unknown, depth = 0): LinkedWorkItem | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === "issue" || value.kind === "pr" ? value.kind : null;
  const url = cleanString(value.url, 600);
  if (!kind || !url) return null;
  const provider =
    typeof value.provider === "string" && PROVIDER_IDS.has(value.provider)
      ? (value.provider as LinkedWorkItem["provider"])
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
  for (const raw of value) {
    if (tasks.length >= MAX_TASKS) break;
    if (!isRecord(raw)) continue;
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
        // `sessionId` (string) predates `sessionIds` — fold it in.
        const sessionIds = [
          ...(Array.isArray(ws.sessionIds) ? ws.sessionIds : []),
          ws.sessionId,
        ]
          .map((entry) => cleanString(entry, 120))
          .filter((entry): entry is string => !!entry)
          .filter((entry, index, list) => list.indexOf(entry) === index)
          .slice(0, 8);
        workstreams.push({
          id: wsId,
          projectPath,
          branch,
          base: cleanString(ws.base, 200) ?? "HEAD",
          ...(cleanString(ws.worktreePath, 600)
            ? { worktreePath: cleanString(ws.worktreePath, 600) }
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
      ...(raw.archived === true ? { archived: true } : {}),
    });
  }
  return tasks;
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

function sanitizeStore(value: unknown): Store {
  const placements: Record<string, BoardPlacement> = {};
  const locals: BoardLocalCard[] = [];
  let tasks: BoardTask[] = [];
  let groups: BoardGroup[] = [];
  const hidden: string[] = [];
  const cardGroups: Record<string, string[]> = {};
  if (isRecord(value)) {
    if (isRecord(value.placements)) {
      for (const [key, raw] of Object.entries(value.placements)) {
        if (Object.keys(placements).length >= MAX_PLACEMENTS) break;
        if (!key || key.length > 300 || !isRecord(raw)) continue;
        const column = cleanColumn(raw.column);
        if (!column) continue;
        placements[key] = { column, order: cleanOrder(raw.order) };
      }
    }
    if (Array.isArray(value.locals)) {
      for (const raw of value.locals) {
        if (locals.length >= MAX_LOCALS) break;
        if (!isRecord(raw)) continue;
        const id = cleanString(raw.id, 120);
        const title = cleanString(raw.title);
        const column = cleanColumn(raw.column) ?? "todo";
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
        });
      }
    }
    tasks = sanitizeTasks(value.tasks);
    groups = sanitizeGroups(value.groups);
    if (Array.isArray(value.hidden)) {
      for (const entry of value.hidden) {
        if (hidden.length >= MAX_HIDDEN) break;
        const id = cleanString(entry, 300);
        if (id && !hidden.includes(id)) hidden.push(id);
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
  return { placements, locals, tasks, groups, hidden, cardGroups };
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
  hidden: [],
  cardGroups: {},
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
  const placements = { ...store.placements };
  const localIds = new Set(store.locals.map((card) => card.id));
  let index = 0;
  const locals = store.locals.map((card) => {
    const position = orderedIds.indexOf(card.id);
    return position >= 0
      ? { ...card, column, order: position * 1024 }
      : card;
  });
  for (const id of orderedIds) {
    if (localIds.has(id)) {
      index += 1;
      continue;
    }
    placements[id] = { column, order: index * 1024 };
    index += 1;
  }
  writeStore({ ...store, placements, locals });
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
      },
    ],
  });
  return id;
}

export function removeLocalCard(id: string) {
  const store = loadBoard();
  const cardGroups = { ...store.cardGroups };
  delete cardGroups[id];
  writeStore({
    ...store,
    locals: store.locals.filter((card) => card.id !== id),
    // A locally-archived card leaves a `hidden` entry — prune it.
    hidden: store.hidden.filter((entry) => entry !== id),
    cardGroups,
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

/** Restore everything archived: hidden derived cards + archived tasks. */
export function unarchiveAll() {
  const store = loadBoard();
  writeStore({
    ...store,
    hidden: [],
    tasks: store.tasks.map((task) =>
      task.archived ? { ...task, archived: false } : task,
    ),
  });
}

/** Archive several tasks in one write — bulk moves like "archive done". */
export function archiveTasks(ids: readonly string[]) {
  if (!ids.length) return;
  const wanted = new Set(ids);
  const store = loadBoard();
  if (!store.tasks.some((task) => wanted.has(task.id) && !task.archived))
    return;
  writeStore({
    ...store,
    tasks: store.tasks.map((task) =>
      wanted.has(task.id) ? { ...task, archived: true } : task,
    ),
  });
}

export function addTask(input: {
  title: string;
  links: LinkedWorkItem[];
  workstreams: TaskWorkstream[];
}): string | null {
  const title = input.title.trim().slice(0, MAX_TEXT);
  if (!title) return null;
  const store = loadBoard();
  if (store.tasks.length >= MAX_TASKS) return null;
  const id = newEntityId("task");
  writeStore({
    ...store,
    tasks: [
      ...store.tasks,
      {
        id,
        title,
        links: input.links.slice(0, MAX_LINKS),
        workstreams: input.workstreams.slice(0, MAX_WORKSTREAMS),
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
  writeStore({
    ...store,
    tasks: store.tasks.filter((task) => task.id !== id),
    placements,
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

/** Group a non-task card (item/local). Prepends so the group becomes
 * primary — a drop onto a wrapper lands the card inside it. */
export function addCardToGroup(cardId: string, groupId: string) {
  const store = loadBoard();
  if (!store.groups.some((group) => group.id === groupId)) return;
  const current = store.cardGroups[cardId] ?? [];
  if (current.includes(groupId)) return;
  writeStore({
    ...store,
    cardGroups: {
      ...store.cardGroups,
      [cardId]: [groupId, ...current].slice(0, MAX_TASK_GROUPS),
    },
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

/** Replace a non-task card's group membership wholesale — drag drops treat
 * the wrapper as the card's single home. */
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
