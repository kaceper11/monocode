import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IconButton, OverlayNav } from "../../app/shell/TitleBar";
import { WindowControls } from "../../app/shell/WindowControls";
import { InboxProviderMark } from "../inbox/ui/InboxProviderMark";
import {
  Archive,
  ChartBreakoutSquare,
  Check,
  ChevronDown,
  Folder,
  ListFilter,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tag,
  X,
} from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { ProjectLogoIcon } from "../projects/ui/ProjectLogoIcon";
import { ProjectMascot } from "../projects/ui/ProjectMascot";
import { useTabGroupLogos } from "../projects/hooks/useTabGroupLogos";
import {
  inboxProjectsForRail,
  listInboxItems,
  peekInboxList,
  type InboxItem,
  type InboxProvider,
  type InboxProviderErrors,
} from "../inbox/model/githubTasks";
import {
  INBOX_SOURCE_LABELS,
  visibleInboxSources,
} from "../inbox/model/inboxFilters";
import { IS_MAC } from "../../platform/tauri/platform";
import { projectKey, projectName } from "../../shared/lib/paths";
import { sameProjectPath, type RecentProject } from "../projects/model/recents";
import type { LinkedWorkItem, Session } from "../sessions/model/session";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
} from "../workspace/model/tabGroups";
import type { SessionSummary } from "../sessions/data/sessionStore";
import {
  linkedSessionUpdates,
  linkedWorkItemUpdateKey,
} from "../inbox/model/linkedSessionUpdates";
import { linkedSessionSeenAt } from "../inbox/model/linkedSessionSeen";
import { linkedWorkItemFromInboxItem } from "../sessions/model/sessionWorkItem";
import { setGrabbing, suppressTextSelection } from "../../shared/lib/drag";
import {
  buildBoardCards,
  cardColumn,
  columnCards,
  columnUnits,
  groupSwatch,
  sessionDotClass,
  type BoardCard,
  type WorkstreamStatus,
} from "./boardData";
import { BoardCardView, type BoardCardAction } from "./BoardCard";
import {
  NewTaskDialog,
  type NewTaskSpec,
  type TaskWorkstreamSpec,
} from "./NewTaskDialog";
import { CardDetailsPanel, TaskDetailsPanel } from "./TaskDetailsPanel";
import { useInboxConnections } from "./useInboxConnections";
import {
  createTaskPrs,
  probeWorkstream,
  updateWorkstreamFromBase,
  type WorkstreamResult,
} from "./taskOps";
import {
  addLocalCard,
  addTask,
  archiveTasks,
  BOARD_COLUMNS,
  boardFromSnapshot,
  boardSnapshot,
  createGroup,
  deleteGroup,
  hideCards,
  loadBoard,
  newEntityId,
  placeColumnOrder,
  removeCardFromGroup,
  removeLocalCard,
  renameGroup,
  setCardGroups,
  subscribeBoard,
  unarchiveAll,
  unplaceCard,
  updateTask,
  type BoardColumnId,
  type BoardGroup,
  type TaskWorkstream,
} from "./boardStore";

const COLUMN_DOT: Record<BoardColumnId, string> = {
  todo: "bg-content/40",
  progress: "bg-emerald-400",
  review: "bg-amber-400",
  done: "bg-accent",
};

const DRAG_THRESHOLD = 5;
const BOARD_QUERY = {
  assignedToMe: true,
  state: "all" as const,
  search: "",
};
/** Group-filter sentinel for cards with no group assigned. */
const UNGROUPED = "__ungrouped__";

type DragState = {
  cardId: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Pointer position and grab offset — the overlay follows the cursor at the
   * point the card was picked up, not glued to its corner. */
  x: number;
  y: number;
  offX: number;
  offY: number;
  w: number;
  active: boolean;
  overColumn: BoardColumnId | null;
  overIndex: number;
  /** Group wrapper under the pointer — dropping a task on it joins the
   * group. */
  overGroup: string | null;
};

export function BoardView({
  besideRail = false,
  recents,
  cwd,
  sessions,
  linkedSessions,
  onClose,
  onToggleSidebar,
  onOpenSession,
  onStartItem,
  onSendToSession,
  onSpawnSession,
  onBindSession,
}: {
  besideRail?: boolean;
  recents: RecentProject[];
  cwd: string;
  /** Live sessions — busy/needsInput state only exists on these rows. */
  sessions: Session[];
  /** Stored summaries with work-item links (`inboxRelatedSessions`). */
  linkedSessions: SessionSummary[];
  onClose: () => void;
  onToggleSidebar: () => void;
  onOpenSession: (sessionId: string) => void;
  onStartItem: (item: InboxItem) => void;
  onSendToSession: (sessionId: string, text: string) => void;
  /** Create a worktree (when needed) + a bound live session for a workstream. */
  onSpawnSession: (
    spec: TaskWorkstreamSpec & {
      title: string;
      links: LinkedWorkItem[];
    },
  ) => Promise<{ sessionId: string; worktreePath: string }>;
  /** Attach a work-item link to an existing live session. */
  onBindSession: (sessionId: string, linked: LinkedWorkItem | null) => void;
}) {
  const boardRaw = useSyncExternalStore(subscribeBoard, boardSnapshot);
  const board = useMemo(() => boardFromSnapshot(boardRaw), [boardRaw]);

  const projects = useMemo(
    () => inboxProjectsForRail(recents, cwd),
    [recents, cwd],
  );
  const connections = useInboxConnections();
  const query = BOARD_QUERY;

  const [items, setItems] = useState<InboxItem[]>(
    () => peekInboxList(projects, query)?.items ?? [],
  );
  const [errors, setErrors] = useState<InboxProviderErrors>(
    () => peekInboxList(projects, query)?.errors ?? {},
  );
  const [fetching, setFetching] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const cached = peekInboxList(projects, query);
    if (cached) {
      setItems(cached.items);
      setErrors(cached.errors);
    }
    setFetching(true);
    void listInboxItems(projects, query, { force: refresh > 0 })
      .then(
        (result) => {
          if (cancelled) return;
          setItems(result.items);
          setErrors(result.errors);
        },
        () => {},
      )
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projects, query, refresh]);

  // linkedSessionUpdates needs a provider-keyed item map — same keys the
  // linked-session seen tracking uses.
  const workItemMap = useMemo(() => {
    const map = new Map<string, InboxItem>();
    for (const item of items) {
      const linked = linkedWorkItemFromInboxItem(item);
      if (linked) map.set(linkedWorkItemUpdateKey(linked), item);
    }
    return map;
  }, [items]);

  const updates = useMemo(
    () => linkedSessionUpdates(linkedSessions, workItemMap, linkedSessionSeenAt),
    [linkedSessions, workItemMap],
  );

  // 30s polling while the board is open and the tab is visible.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        setRefresh((value) => value + 1);
      }
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Per-workstream PR + checks probe — refreshed with the inbox tick. The
  // effect keys on a serialization of probe inputs so unrelated board-store
  // writes (drags, placements) don't refire the git/CI fan-out.
  const probeStreams = useMemo(
    () =>
      board.tasks.flatMap((task) =>
        task.archived ? [] : task.workstreams.filter((ws) => ws.worktreePath),
      ),
    [board.tasks],
  );
  const probeKey = probeStreams
    .map((ws) => `${ws.id}:${ws.worktreePath}:${ws.branch}`)
    .join("\n");
  const probeRef = useRef(probeStreams);
  useEffect(() => {
    probeRef.current = probeStreams;
  });
  const [wsStatus, setWsStatus] = useState<
    ReadonlyMap<string, WorkstreamStatus>
  >(new Map());
  useEffect(() => {
    let cancelled = false;
    const streams = probeRef.current;
    if (!streams.length) {
      setWsStatus(new Map());
      return;
    }
    void Promise.allSettled(
      streams.map(
        async (ws) => [ws.id, await probeWorkstream(ws)] as const,
      ),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<string, WorkstreamStatus>();
      for (const result of results) {
        if (result.status === "fulfilled" && result.value[1]) {
          next.set(result.value[0], result.value[1]);
        }
      }
      setWsStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [probeKey, refresh]);

  const cards = useMemo(
    () =>
      buildBoardCards({
        items,
        sessions,
        summaries: linkedSessions,
        updates,
        locals: board.locals,
        tasks: board.tasks,
        groups: board.groups,
        cardGroups: board.cardGroups,
        workstreamStatus: wsStatus,
      }),
    [
      items,
      sessions,
      linkedSessions,
      updates,
      board.locals,
      board.tasks,
      board.groups,
      wsStatus,
    ],
  );

  // --- filters -----------------------------------------------------------
  const [search, setSearch] = useState("");
  const [hiddenProviders, setHiddenProviders] = useState<InboxProvider[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  // Group filter — group ids, plus `UNGROUPED` for cards with no group.
  const [groupFilter, setGroupFilter] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [actionOnly, setActionOnly] = useState(false);
  const [projectPickerAnchor, setProjectPickerAnchor] =
    useState<HTMLElement | null>(null);
  const [groupPickerAnchor, setGroupPickerAnchor] =
    useState<HTMLElement | null>(null);
  const [projectSearch, setProjectSearch] = useState("");

  const visibleSources = useMemo(
    () => visibleInboxSources(connections),
    [connections],
  );

  // The fetch layer reports "Connect X in Settings" hints for providers that
  // were never configured — that's inbox onboarding copy, not a board error.
  // Only failures from sources the user actually connected belong here.
  const visibleErrorEntries = useMemo(
    () =>
      Object.entries(errors).filter(([provider]) =>
        visibleSources.includes(provider as InboxProvider),
      ),
    [errors, visibleSources],
  );

  const filtered = useMemo(() => {
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hidden = new Set(hiddenProviders);
    const hiddenCards = new Set(board.hidden);
    return cards.filter((card) => {
      if (hiddenCards.has(card.id)) return false;
      if (card.provider && hidden.has(card.provider)) return false;
      // Cards without a project (locals, linked-only items) pass any filter.
      // Tasks match when any workstream lives in the filtered project.
      if (projectFilter) {
        const projectsOf = new Set(
          [card.projectPath, ...(card.workstreams ?? []).map((w) => w.projectPath)]
            .filter((p): p is string => Boolean(p)),
        );
        if (projectsOf.size && ![...projectsOf].some((p) => p === projectFilter))
          return false;
      }
      if (groupFilter.size) {
        const cardGroupIds = card.groups ?? [];
        const pass =
          cardGroupIds.some((group) => groupFilter.has(group.id)) ||
          (groupFilter.has(UNGROUPED) && !cardGroupIds.length);
        if (!pass) return false;
      }
      if (
        actionOnly &&
        !card.hasUpdate &&
        !card.ciFailing &&
        !card.attentionReason &&
        !card.sessions.some((session) => session.needsInput)
      )
        return false;
      if (!tokens.length) return true;
      const fields = [
        card.title,
        card.identifier,
        card.repo,
        card.url,
        ...card.sessions.map((session) => session.title),
        ...(card.tickets ?? []).flatMap((ticket) => [
          ticket.title,
          ticket.identifier,
        ]),
        ...(card.workstreams ?? []).flatMap((ws) => [
          ws.branch,
          projectName(ws.projectPath),
        ]),
      ];
      return tokens.every((token) =>
        fields.some((field) => field?.toLowerCase().includes(token)),
      );
    });
  }, [
    cards,
    search,
    hiddenProviders,
    projectFilter,
    groupFilter,
    actionOnly,
    board.hidden,
  ]);

  // Deleted groups shouldn't linger in the filter — they'd match nothing
  // but still count in the button badge.
  useEffect(() => {
    const valid = new Set(board.groups.map((group) => group.id));
    if ([...groupFilter].some((id) => id !== UNGROUPED && !valid.has(id))) {
      setGroupFilter(
        new Set(
          [...groupFilter].filter(
            (id) => id === UNGROUPED || valid.has(id),
          ),
        ),
      );
    }
  }, [board.groups, groupFilter]);

  // --- drag --------------------------------------------------------------
  const [drag, setDrag] = useState<DragState | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  // Unlinked live sessions leave the columns — they're running agents, not
  // work items. The tray below renders them compactly instead.
  const sessionCards = useMemo(
    () => filtered.filter((card) => card.kind === "session"),
    [filtered],
  );
  const columnSource = useMemo(
    () => filtered.filter((card) => card.kind !== "session"),
    [filtered],
  );
  const cardsByColumn = useMemo(() => {
    const map = new Map<BoardColumnId, BoardCard[]>();
    for (const column of BOARD_COLUMNS) {
      map.set(
        column.id,
        columnCards(columnSource, column.id, board.placements, board.locals),
      );
    }
    return map;
  }, [columnSource, board.placements, board.locals]);

  // Archived = dismissed derived cards + archived tasks — restored together.
  const archivedCount =
    board.hidden.length +
    board.tasks.filter((task) => task.archived).length;

  // Drop indices are measured against the column's VISUAL order — group
  // wrappers pull non-contiguous members together, so the DOM order is the
  // flattened unit order, not raw columnList order.
  const dropCard = useCallback(
    (cardId: string, column: BoardColumnId, index: number) => {
      const ordered = columnUnits(cardsByColumn.get(column) ?? []).flatMap(
        (unit) => (unit.type === "group" ? unit.cards : [unit.card]),
      );
      const without = ordered
        .map((card) => card.id)
        .filter((id) => id !== cardId);
      without.splice(Math.min(index, without.length), 0, cardId);
      placeColumnOrder(column, without);
    },
    [cardsByColumn],
  );
  // The drag's window listeners outlive renders — a poll refresh mid-drag
  // would leave the captured dropCard computing against stale columns.
  const dropCardRef = useRef(dropCard);
  dropCardRef.current = dropCard;

  // The card the drag overlay renders.
  const dragCard = useMemo(() => {
    if (!drag?.active) return null;
    for (const list of cardsByColumn.values()) {
      const card = list.find((entry) => entry.id === drag.cardId);
      if (card) return card;
    }
    return null;
  }, [drag?.active, drag?.cardId, cardsByColumn]);

  const onDragStart = useCallback(
    (card: BoardCard, event: React.PointerEvent) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = (
        event.currentTarget as HTMLElement
      ).getBoundingClientRect();
      const state: DragState = {
        cardId: card.id,
        pointerId: event.pointerId,
        startX,
        startY,
        x: startX,
        y: startY,
        offX: startX - rect.left,
        offY: startY - rect.top,
        w: rect.width,
        active: false,
        overColumn: null,
        overIndex: -1,
        overGroup: null,
      };
      let releaseSuppress: (() => void) | null = null;

      const locate = (clientX: number, clientY: number) => {
        const root = boardRef.current;
        if (!root) return;
        const hit = document.elementFromPoint(clientX, clientY);
        state.overGroup =
          hit?.closest<HTMLElement>("[data-board-group]")?.dataset
            .boardGroup ?? null;
        const element = hit?.closest<HTMLElement>("[data-board-column]");
        if (!element) {
          state.overColumn = null;
          state.overIndex = -1;
          return;
        }
        const column = element.dataset.boardColumn as BoardColumnId;
        state.overColumn = column;
        const rows = [
          ...element.querySelectorAll<HTMLElement>("[data-board-card]"),
        ].filter((row) => row.dataset.boardCard !== card.id);
        state.overIndex = rows.findIndex(
          (row) =>
            clientY < row.getBoundingClientRect().top + row.offsetHeight / 2,
        );
        if (state.overIndex < 0) state.overIndex = rows.length;
      };

      const onMove = (move: globalThis.PointerEvent) => {
        if (move.pointerId !== event.pointerId) return;
        // A pointerup lost off-window leaves buttons at 0 — the gesture is
        // over, don't let a later hover commit a phantom drop.
        if (!move.buttons) {
          cleanup();
          return;
        }
        if (
          !state.active &&
          Math.hypot(move.clientX - startX, move.clientY - startY) >
            DRAG_THRESHOLD
        ) {
          state.active = true;
          setGrabbing(true);
          releaseSuppress = suppressTextSelection();
        }
        if (!state.active) return;
        state.x = move.clientX;
        state.y = move.clientY;
        locate(move.clientX, move.clientY);
        setDrag({ ...state });
      };
      const onUp = (up: globalThis.PointerEvent) => {
        if (up.pointerId !== event.pointerId) return;
        cleanup();
        if (state.active && state.overColumn && state.overIndex >= 0) {
          dropCardRef.current(card.id, state.overColumn, state.overIndex);
          // Groups are positional: a drop ON a wrapper moves the card into
          // that group, a drop OUTSIDE every wrapper removes it from the
          // group it was in. Dropping back on its own wrapper just reorders —
          // secondary memberships survive that.
          if (card.kind === "task" && card.task) {
            const current = card.task.groupIds ?? [];
            if (state.overGroup && state.overGroup !== current[0]) {
              updateTask(card.task.id, { groupIds: [state.overGroup] });
            } else if (!state.overGroup && current.length) {
              updateTask(card.task.id, { groupIds: [] });
            }
          } else if (card.kind === "item" || card.kind === "local") {
            const current = loadBoard().cardGroups[card.id] ?? [];
            if (state.overGroup && state.overGroup !== current[0]) {
              setCardGroups(card.id, [state.overGroup]);
            } else if (!state.overGroup && current.length) {
              setCardGroups(card.id, []);
            }
          }
        }
        if (state.active) {
          // A drag-release still fires click on the pressed element — eat it
          // so dropping a card doesn't also open it or hit a chip. The
          // listener expires next tick: if that click never comes (released
          // off-window) it must not eat the user's next real click.
          const eat = (click: MouseEvent) => {
            click.preventDefault();
            click.stopPropagation();
          };
          window.addEventListener("click", eat, { capture: true });
          setTimeout(
            () => window.removeEventListener("click", eat, { capture: true }),
            0,
          );
        }
      };
      // pointercancel = the browser/OS took the gesture (touch scroll,
      // interruption) — abort without committing a drop.
      const onCancel = (cancel: globalThis.PointerEvent) => {
        if (cancel.pointerId !== event.pointerId) return;
        cleanup();
      };
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape") return;
        key.preventDefault();
        cleanup();
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        setGrabbing(false);
        releaseSuppress?.();
        setDrag(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
    [],
  );

  // --- actions -----------------------------------------------------------
  // Dispatch needs a live (loaded) session — stored summaries can't take a
  // turn, so fix/comment actions stay hidden until a session is open.
  const firstLiveSession = (card: BoardCard) =>
    card.sessions.find((session) => session.live);
  const sendToFirstLive = (card: BoardCard, text: string) => {
    const session = firstLiveSession(card);
    if (!session) return;
    onSendToSession(session.id, text);
    onOpenSession(session.id);
  };

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const selectedCard = useMemo(
    () =>
      selectedCardId
        ? (cards.find((card) => card.id === selectedCardId) ?? null)
        : null,
    [cards, selectedCardId],
  );

  const onCardAction = useCallback(
    (card: BoardCard, action: BoardCardAction) => {
      switch (action.kind) {
        case "open-session":
          onOpenSession(action.sessionId);
          return;
        case "open-task":
          // Fresh panel, fresh results — stale per-workstream outcomes from
          // a previously viewed card must not bleed into this one's rows.
          setActionResults(new Map());
          setSelectedCardId(card.id);
          return;
        case "start":
          if (card.item) onStartItem(card.item);
          return;
        case "open-url":
          if (card.url) void openUrl(card.url);
          return;
        case "fix-ci": {
          const ref = card.identifier ?? card.title;
          sendToFirstLive(
            card,
            `CI is failing for ${ref}${card.url ? ` (${card.url})` : ""}. ` +
              `Please investigate the failing checks, fix the cause, and verify.`,
          );
          return;
        }
        case "comments": {
          const ref = card.identifier ?? card.title;
          sendToFirstLive(
            card,
            `There is new review activity on ${ref}${
              card.url ? ` (${card.url})` : ""
            }. Please read the latest comments and address them.`,
          );
          return;
        }
        case "ungroup":
          if (card.kind === "task" && card.task) {
            updateTask(card.task.id, (current) => ({
              groupIds: (current.groupIds ?? []).filter(
                (id) => id !== action.groupId,
              ),
            }));
          } else {
            removeCardFromGroup(card.id, action.groupId);
          }
          return;
        case "reset":
          unplaceCard(card.id);
          return;
        case "archive":
          if (card.kind === "task" && card.task) {
            archiveTasks([card.task.id]);
          } else {
            hideCards([card.id]);
          }
          return;
        case "promote": {
          // The record's own column — not the filtered view, so a card
          // promoted while filtered out still returns to its slot.
          setPromoteFrom({
            id: card.id,
            title: card.title,
            column: cardColumn(card, board.placements),
          });
          setTaskError("");
          setTaskDialogOpen(true);
          return;
        }
        case "remove":
          removeLocalCard(card.id);
          return;
      }
    },
    [board.placements, onOpenSession, onSendToSession, onStartItem],
  );

  // --- task creation + details ---------------------------------------------
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  /** Local card being promoted — consumed when the task is created. */
  const [promoteFrom, setPromoteFrom] = useState<{
    id: string;
    title: string;
    column?: BoardColumnId;
  } | null>(null);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionResults, setActionResults] = useState<
    ReadonlyMap<string, WorkstreamResult>
  >(new Map());

  const onCreateTask = useCallback(
    async (spec: NewTaskSpec) => {
      setTaskBusy(true);
      setTaskError("");
      const workstreams: TaskWorkstream[] = [];
      const errors: string[] = [];
      const failed = new Map<string, WorkstreamResult>();
      for (const ws of spec.workstreams) {
        try {
          const spawned = await onSpawnSession({
            ...ws,
            title: spec.title,
            links: spec.links,
          });
          workstreams.push({
            id: newEntityId("ws"),
            projectPath: ws.projectPath,
            branch: ws.branch,
            base: ws.base,
            worktreePath: spawned.worktreePath,
            sessionIds: [spawned.sessionId],
          });
        } catch (error) {
          const message = `${projectName(ws.projectPath)}: ${String(error)}`;
          errors.push(message);
          // Keep a row so the failed lane is visible and retryable from details.
          const stubId = newEntityId("ws");
          failed.set(stubId, {
            workstreamId: stubId,
            ok: false,
            message,
          });
          workstreams.push({
            id: stubId,
            projectPath: ws.projectPath,
            branch: ws.branch,
            base: ws.base,
          });
        }
      }
      setTaskBusy(false);
      // Total failure keeps the dialog open — no phantom task to resubmit.
      if (errors.length === spec.workstreams.length && errors.length) {
        setTaskError(errors.join(" · "));
        return;
      }
      // Failed lanes stay on the task as rows without a worktree — the
      // details panel's "Create worktree" retries them.
      const id = addTask({ title: spec.title, links: spec.links, workstreams });
      if (!id) {
        // The board is full — don't orphan the worktrees we just created.
        setTaskError("Board is full — remove a task first");
        return;
      }
      setTaskDialogOpen(false);
      setSelectedCardId(id);
      // A promoted local card is consumed — the task takes its exact slot.
      if (promoteFrom) {
        removeLocalCard(promoteFrom.id);
        if (promoteFrom.column) {
          const ordered = columnCards(
            cards.filter((entry) => entry.kind !== "session"),
            promoteFrom.column,
            board.placements,
            board.locals,
          ).map((entry) => entry.id);
          const at = ordered.indexOf(promoteFrom.id);
          if (at >= 0) ordered.splice(at, 1, id);
          else ordered.push(id);
          placeColumnOrder(promoteFrom.column, ordered);
        }
        setPromoteFrom(null);
      }
      // Surface partial spawn failures on their workstream rows.
      if (failed.size) setActionResults(failed);
    },
    [onSpawnSession, promoteFrom, cards, board.placements, board.locals],
  );

  const refreshNow = useCallback(() => setRefresh((value) => value + 1), []);

  const runTaskOp = useCallback(
    async (
      busyKey: string,
      run: () => Promise<WorkstreamResult[]>,
    ) => {
      setActionBusy(busyKey);
      try {
        const results = await run();
        setActionResults((current) => {
          const next = new Map(current);
          for (const result of results) next.set(result.workstreamId, result);
          return next;
        });
      } finally {
        setActionBusy(null);
        refreshNow();
      }
    },
    [refreshNow],
  );

  const taskOpsHandlers = useMemo(() => {
    if (!selectedCard?.task) return null;
    const task = selectedCard.task;
    const run = (
      busyKey: string,
      workstreams: TaskWorkstream[],
      op: (ws: TaskWorkstream) => Promise<WorkstreamResult>,
    ) =>
      runTaskOp(busyKey, async () => {
        const settled = await Promise.allSettled(
          workstreams.map(async (ws) => op(ws)),
        );
        return settled.map((entry, index) =>
          entry.status === "fulfilled"
            ? entry.value
            : {
                workstreamId: workstreams[index].id,
                ok: false,
                message: String(entry.reason),
              },
        );
      });
    return {
      onClose: () => setSelectedCardId(null),
      onOpenSession,
      onSpawnSession: async (spec: TaskWorkstreamSpec) =>
        onSpawnSession({ ...spec, title: task.title, links: task.links }),
      onBindSession,
      onCreatePrs: () => runTaskOp("prs", () => createTaskPrs(task, wsStatus)),
      onUpdateBranches: () =>
        run("merge", task.workstreams, (ws) =>
          updateWorkstreamFromBase(ws),
        ),
      onCreateWorkstreamPr: (wsId: string) =>
        runTaskOp(`pr:${wsId}`, async () =>
          // Full task context — `only` restricts creation, so the body still
          // lists sibling branches and existing sibling PRs.
          createTaskPrs(task, wsStatus, new Set([wsId])),
        ),
      onUpdateWorkstream: (wsId: string) =>
        run(`merge:${wsId}`, task.workstreams.filter((ws) => ws.id === wsId), (ws) =>
          updateWorkstreamFromBase(ws),
        ),
    };
  }, [
    selectedCard,
    wsStatus,
    runTaskOp,
    onSpawnSession,
    onBindSession,
    onOpenSession,
  ]);

  const [newCardTitle, setNewCardTitle] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Board popovers/menus preventDefault their own Escape — reaching here
      // means the board itself closes. preventDefault stops the app-level
      // handler from also reading this keypress as "stop the focused agent".
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="region"
      aria-label="Board"
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-stroke"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <ChartBreakoutSquare
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-content">Board</span>
          <label className="relative ml-2 flex min-w-0 max-w-56 flex-1 items-center">
            <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter cards…"
              aria-label="Filter cards"
              className="h-7 w-full rounded-md bg-content/6 pl-7 pr-2 text-[12px] text-content outline-none placeholder:text-content/40 focus:ring-1 focus:ring-accent/40"
            />
          </label>
        </div>
        <div className="flex shrink-0 items-center gap-1 px-2">
          {visibleSources.map((provider) => {
            const hidden = hiddenProviders.includes(provider);
            return (
              <button
                key={provider}
                type="button"
                title={`${hidden ? "Show" : "Hide"} ${INBOX_SOURCE_LABELS[provider]}`}
                aria-pressed={!hidden}
                aria-label={`${INBOX_SOURCE_LABELS[provider]} cards`}
                className={`grid size-7 place-items-center rounded-md transition-opacity hover:bg-content/8 ${
                  hidden ? "opacity-30" : "opacity-80"
                }`}
                onClick={() =>
                  setHiddenProviders((current) =>
                    hidden
                      ? current.filter((entry) => entry !== provider)
                      : [...current, provider],
                  )
                }
              >
                <InboxProviderMark provider={provider} className="size-3.5" />
              </button>
            );
          })}
          <button
            type="button"
            aria-label="Filter by project"
            title={projectFilter ? projectName(projectFilter) : "All projects"}
            className={`flex h-7 max-w-44 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium ${
              projectFilter
                ? "bg-accent/12 text-content"
                : "text-content/55 hover:bg-content/8 hover:text-content"
            }`}
            onClick={(event) => {
              setProjectSearch("");
              setProjectPickerAnchor(event.currentTarget);
            }}
          >
            {projectFilter ? (
              <BoardProjectMark path={projectFilter} />
            ) : (
              <Folder
                className="size-3.5 shrink-0 text-content/40"
                strokeWidth={1.75}
              />
            )}
            <span className="min-w-0 truncate">
              {projectFilter ? projectName(projectFilter) : "All projects"}
            </span>
            <ChevronDown
              className="size-3 shrink-0 text-content/35"
              strokeWidth={2}
            />
          </button>
          <button
            type="button"
            aria-label="Filter by group"
            title={
              groupFilter.size
                ? `${groupFilter.size} group${groupFilter.size > 1 ? "s" : ""} selected`
                : "Filter by group"
            }
            className={`flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium ${
              groupFilter.size
                ? "bg-accent/12 text-content"
                : "text-content/55 hover:bg-content/8 hover:text-content"
            }`}
            onClick={(event) =>
              setGroupPickerAnchor(event.currentTarget as HTMLElement)
            }
          >
            <Tag
              className="size-3.5 shrink-0 text-content/40"
              strokeWidth={1.75}
            />
            <span className="min-w-0 truncate">
              {groupFilter.size ? `Groups · ${groupFilter.size}` : "Groups"}
            </span>
            <ChevronDown
              className="size-3 shrink-0 text-content/35"
              strokeWidth={2}
            />
          </button>
          <button
            type="button"
            title="New task"
            className="flex h-7 items-center gap-1 rounded-md bg-accent/12 px-1.5 text-[11px] font-medium text-accent hover:bg-accent/20"
            onClick={() => {
              setTaskError("");
              setPromoteFrom(null);
              setTaskDialogOpen(true);
            }}
          >
            <Plus className="size-3.5" strokeWidth={2} />
            Task
          </button>
          <button
            type="button"
            aria-pressed={actionOnly}
            title="Only cards that need action"
            className={`flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium ${
              actionOnly
                ? "bg-accent/15 text-accent"
                : "text-content/50 hover:bg-content/8 hover:text-content"
            }`}
            onClick={() => setActionOnly((value) => !value)}
          >
            <ListFilter className="size-3.5" strokeWidth={1.75} />
            Action
          </button>
          <IconButton
            label="Refresh"
            onClick={refreshNow}
          >
            {fetching ? (
              <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <RefreshCw className="size-3.5" strokeWidth={1.75} />
            )}
          </IconButton>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          ref={boardRef}
          className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 sm:grid-cols-2 xl:grid-cols-4"
        >
        {BOARD_COLUMNS.map((column) => {
          const columnList = cardsByColumn.get(column.id) ?? [];
          const units = columnUnits(columnList);
          // `drag.overIndex` counts rows with the dragged card removed, in
          // DOM order — which is the flattened unit order once group
          // wrappers pull members together.
          const orderedList = units.flatMap((unit) =>
            unit.type === "group" ? unit.cards : [unit.card],
          );
          const visibleIds = drag?.cardId
            ? orderedList.filter((card) => card.id !== drag.cardId)
            : orderedList;
          const visibleIndex = new Map(
            visibleIds.map((card, index) => [card.id, index] as const),
          );
          const renderCard = (card: BoardCard, grouped = false) => (
            <BoardCardView
              key={card.id}
              card={card}
              manual={
                card.kind !== "local" &&
                board.placements[card.id] !== undefined
              }
              dragging={drag?.active === true && drag.cardId === card.id}
              dropTarget={
                drag?.active === true &&
                drag.overColumn === column.id &&
                drag.overIndex === visibleIndex.get(card.id)
              }
              grouped={grouped}
              onAction={onCardAction}
              onDragStart={onDragStart}
            />
          );
          return (
            <section
              key={column.id}
              data-board-column={column.id}
              aria-label={column.label}
              className={`group/col flex min-h-24 min-w-0 flex-col rounded-xl border border-content/8 bg-content/[0.02] ${
                drag?.active && drag.overColumn === column.id
                  ? "ring-1 ring-accent/40"
                  : ""
              }`}
            >
              <header className="flex h-8 shrink-0 items-center gap-1.5 px-2.5">
                <span
                  aria-hidden
                  className={`size-1.5 rounded-full ${COLUMN_DOT[column.id]}`}
                />
                <h2 className="text-[12px] font-medium text-content/80">
                  {column.label}
                </h2>
                <span className="text-[11px] text-content/40">
                  {columnList.length}
                </span>
                {column.id === "done" && columnList.length ? (
                  <button
                    type="button"
                    title="Archive the cards shown in Done"
                    aria-label="Archive the cards shown in Done"
                    className="ml-auto grid size-5 place-items-center rounded text-content/35 hover:bg-content/10 hover:text-content"
                    onClick={() => {
                      const taskIds: string[] = [];
                      const hideIds: string[] = [];
                      for (const card of columnList) {
                        if (card.kind === "task" && card.task) {
                          taskIds.push(card.task.id);
                        } else {
                          hideIds.push(card.id);
                        }
                      }
                      archiveTasks(taskIds);
                      hideCards(hideIds);
                    }}
                  >
                    <Archive className="size-3" strokeWidth={1.75} />
                  </button>
                ) : null}
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {units.map((unit) =>
                  unit.type === "group" ? (
                    <div
                      key={unit.group.id}
                      data-board-group={unit.group.id}
                      className={`rounded-xl border p-1.5 ${
                        groupSwatch(unit.group.color).card
                      } ${
                        drag?.active &&
                        drag.overGroup === unit.group.id &&
                        dragCard &&
                        dragCard.kind !== "session"
                          ? "ring-1 ring-accent/60"
                          : ""
                      }`}
                    >
                      <p className="mb-1.5 flex items-center gap-1.5 px-1">
                        <span
                          aria-hidden
                          className={`size-1.5 shrink-0 rounded-full ${
                            groupSwatch(unit.group.color).dot
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-content/60">
                          {unit.group.name}
                        </span>
                        <span className="shrink-0 text-[10px] text-content/35">
                          {unit.cards.length}
                        </span>
                      </p>
                      <div className="flex flex-col gap-1.5">
                        {unit.cards.map((card) => renderCard(card, true))}
                      </div>
                    </div>
                  ) : (
                    renderCard(unit.card)
                  ),
                )}
                {drag?.active &&
                drag.overColumn === column.id &&
                drag.overIndex >= visibleIds.length ? (
                  <div
                    aria-hidden
                    className="h-0.5 shrink-0 rounded bg-accent"
                  />
                ) : null}
                {column.id === "todo" ? (
                  <form
                    className="mt-auto pt-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (addLocalCard(newCardTitle)) setNewCardTitle("");
                    }}
                  >
                    <label className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-content/40 focus-within:bg-content/6 focus-within:text-content/60">
                      <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
                      <input
                        value={newCardTitle}
                        onChange={(event) =>
                          setNewCardTitle(event.target.value)
                        }
                        placeholder="Add a card"
                        aria-label="Add a local card"
                        className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/40"
                      />
                    </label>
                  </form>
                ) : null}
                {!columnList.length && column.id !== "todo" ? (
                  <p className="px-2 pb-3 text-[11px] text-content/30">
                    Nothing here
                  </p>
                ) : null}
                {column.id === "done" && archivedCount ? (
                  <button
                    type="button"
                    className="mx-1 mb-1 flex h-6 items-center justify-center rounded-md text-[10px] text-content/35 hover:bg-content/6 hover:text-content/60"
                    onClick={unarchiveAll}
                  >
                    Restore {archivedCount} archived
                  </button>
                ) : null}
              </div>
            </section>
          );
        })}
        </div>
        {selectedCard ? (
          selectedCard.kind === "task" && taskOpsHandlers ? (
            <TaskDetailsPanel
            card={selectedCard}
            items={items}
            recents={recents}
            sessions={sessions}
            busyAction={actionBusy ?? ""}
            results={actionResults}
            onClose={taskOpsHandlers.onClose}
            onOpenSession={taskOpsHandlers.onOpenSession}
            onSpawnSession={taskOpsHandlers.onSpawnSession}
            onBindSession={taskOpsHandlers.onBindSession}
            onCreatePrs={taskOpsHandlers.onCreatePrs}
            onUpdateBranches={taskOpsHandlers.onUpdateBranches}
            onCreateWorkstreamPr={taskOpsHandlers.onCreateWorkstreamPr}
            onUpdateWorkstream={taskOpsHandlers.onUpdateWorkstream}
          />
          ) : (
            <CardDetailsPanel
              card={selectedCard}
              onClose={() => setSelectedCardId(null)}
              onOpenSession={onOpenSession}
              onStartItem={
                selectedCard.item
                  ? () => onStartItem(selectedCard.item!)
                  : undefined
              }
              onPromote={
                selectedCard.kind === "local"
                  ? () => {
                      setPromoteFrom({
                        id: selectedCard.id,
                        title: selectedCard.title,
                        column: cardColumn(selectedCard, board.placements),
                      });
                      setTaskError("");
                      setTaskDialogOpen(true);
                    }
                  : undefined
              }
              onRemove={
                selectedCard.kind === "local"
                  ? () => removeLocalCard(selectedCard.id)
                  : undefined
              }
            />
          )
        ) : null}
      </div>
      {drag?.active && dragCard ? (
        // Floating copy of the card under the pointer. pointer-events-none
        // keeps elementFromPoint hit-testing the columns beneath it.
        <div
          aria-hidden
          className="pointer-events-none fixed z-[70] -rotate-1 shadow-lg shadow-black/30"
          style={{
            left: drag.x - drag.offX,
            top: drag.y - drag.offY,
            width: drag.w,
          }}
        >
          <BoardCardView
            card={dragCard}
            manual={false}
            dragging={false}
            dropTarget={false}
            onAction={() => {}}
            onDragStart={() => {}}
          />
        </div>
      ) : null}
      {sessionCards.length ? (
        // Running agents not bound to any task — compact tray instead of
        // column cards, so the board stays about work items.
        <div
          aria-label="Unbound sessions"
          className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-stroke px-3 py-1.5"
        >
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-content/40">
            Sessions
          </span>
          {sessionCards.map((card) =>
            card.sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                title={
                  session.needsInput
                    ? `${session.title} — waiting on you`
                    : session.busy
                      ? `${session.title} — working`
                      : session.title
                }
                className="flex max-w-56 shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-content/60 outline-none hover:bg-content/8 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
                onClick={() => onOpenSession(session.id)}
              >
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${sessionDotClass(session)}`}
                />
                <span className="truncate">{session.title}</span>
              </button>
            )),
          )}
        </div>
      ) : null}
      {projectPickerAnchor ? (
        <Popover
          anchor={projectPickerAnchor}
          onDismiss={() => setProjectPickerAnchor(null)}
          width={256}
        >
          <div className="p-1.5">
            <input
              autoFocus
              value={projectSearch}
              onChange={(event) => setProjectSearch(event.target.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
              className="mb-1 h-7 w-full rounded-md bg-content/6 px-2 text-[12px] text-content outline-none placeholder:text-content/40 focus:ring-1 focus:ring-accent/40"
            />
            <ProjectPickRow
              label="All projects"
              selected={!projectFilter}
              onPick={() => {
                setProjectFilter("");
                setProjectPickerAnchor(null);
              }}
            />
            {recents
              .filter(
                (project) =>
                  !projectSearch ||
                  projectName(project.path)
                    .toLowerCase()
                    .includes(projectSearch.toLowerCase()) ||
                  project.path
                    .toLowerCase()
                    .includes(projectSearch.toLowerCase()),
              )
              .map((project) => (
                <ProjectPickRow
                  key={project.path}
                  label={projectName(project.path)}
                  mark={<BoardProjectMark path={project.path} />}
                  selected={sameProjectPath(project.path, projectFilter)}
                  onPick={() => {
                    setProjectFilter(project.path);
                    setProjectPickerAnchor(null);
                  }}
                />
              ))}
          </div>
        </Popover>
      ) : null}
      {groupPickerAnchor ? (
        <GroupFilterPopover
          anchor={groupPickerAnchor}
          groups={board.groups}
          filter={groupFilter}
          onToggle={(id) =>
            setGroupFilter((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onClear={() => {
            setGroupFilter(new Set());
            setGroupPickerAnchor(null);
          }}
          onClose={() => setGroupPickerAnchor(null)}
        />
      ) : null}
      {taskDialogOpen ? (
        <NewTaskDialog
          items={items}
          recents={recents}
          busy={taskBusy}
          error={taskError}
          initialTitle={promoteFrom?.title}
          onSubmit={onCreateTask}
          onCancel={() => {
            setTaskDialogOpen(false);
            setPromoteFrom(null);
          }}
        />
      ) : null}
      {visibleErrorEntries.length ? (
        <div className="shrink-0 border-t border-stroke px-3 py-1.5 text-[10px] text-content/40">
          {visibleErrorEntries
            .map(([provider, message]) => `${provider}: ${message}`)
            .join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

/** Sidebar-style project mark — logo when set, colored mascot otherwise. */
function BoardProjectMark({ path }: { path: string }) {
  const logos = useTabGroupLogos();
  const key = projectKey(path);
  const name = projectName(path);
  const logo = resolveTabGroupLogo(key, logos);
  if (logo) {
    return (
      <ProjectLogoIcon
        path={logo}
        className="size-3.5 shrink-0 rounded-sm"
        imageClassName="size-3.5"
      />
    );
  }
  return (
    <ProjectMascot
      project={name}
      color={resolveTabGroupColor(
        key,
        loadTabGroupColors(),
        loadTabGroupCustomColors(),
        name,
      )}
      name={resolveTabGroupMascot(key, loadTabGroupMascots())}
      className="size-3.5 shrink-0"
    />
  );
}

/** Groups filter + editor — toggle which groups filter the board, and
 * create/rename/delete the shared list in place. */
function GroupFilterPopover({
  anchor,
  groups,
  filter,
  onToggle,
  onClear,
  onClose,
}: {
  anchor: HTMLElement;
  groups: BoardGroup[];
  filter: ReadonlySet<string>;
  onToggle: (groupId: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newName, setNewName] = useState("");
  return (
    <Popover anchor={anchor} onDismiss={onClose} width={236}>
      <div className="p-1.5" role="group" aria-label="Filter by group">
        {groups.map((group) => {
          const swatch = groupSwatch(group.color);
          const selected = filter.has(group.id);
          return (
            <div
              key={group.id}
              className="group flex items-center gap-0.5 rounded-md hover:bg-content/6"
            >
              {renaming === group.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  aria-label={`Rename ${group.name}`}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      renameGroup(group.id, renameValue);
                      setRenaming(null);
                    } else if (event.key === "Escape") {
                      setRenaming(null);
                    }
                  }}
                  onBlur={() => {
                    renameGroup(group.id, renameValue);
                    setRenaming(null);
                  }}
                  className="h-7 min-w-0 flex-1 rounded bg-content/8 px-2 text-[12px] text-content outline-none focus:ring-1 focus:ring-accent/50"
                />
              ) : (
                <>
                  <button
                    type="button"
                    aria-pressed={selected}
                    className={`flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[12px] ${
                      selected ? "text-content" : "text-content/70 hover:text-content"
                    }`}
                    onClick={() => onToggle(group.id)}
                  >
                    <span
                      aria-hidden
                      className={`size-2 shrink-0 rounded-full ${swatch.dot}`}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {group.name}
                    </span>
                    {selected ? (
                      <Check
                        className="size-3.5 shrink-0 text-accent"
                        strokeWidth={2.5}
                      />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${group.name}`}
                    className="grid size-5 shrink-0 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => {
                      setRenaming(group.id);
                      setRenameValue(group.name);
                    }}
                  >
                    <Pencil className="size-3" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete group ${group.name}`}
                    className="mr-1 grid size-5 shrink-0 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => deleteGroup(group.id)}
                  >
                    <X className="size-3" strokeWidth={1.75} />
                  </button>
                </>
              )}
            </div>
          );
        })}
        <button
          type="button"
          aria-pressed={filter.has(UNGROUPED)}
          className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] ${
            filter.has(UNGROUPED)
              ? "bg-accent/12 text-content"
              : "text-content/70 hover:bg-content/6 hover:text-content"
          }`}
          onClick={() => onToggle(UNGROUPED)}
        >
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full border border-content/30"
          />
          <span className="min-w-0 flex-1 truncate text-content/60">
            Ungrouped
          </span>
          {filter.has(UNGROUPED) ? (
            <Check className="size-3.5 shrink-0 text-accent" strokeWidth={2.5} />
          ) : null}
        </button>
        {!groups.length ? (
          <p className="px-2 py-1.5 text-[11px] text-content/40">
            No groups yet — create one to tag tasks.
          </p>
        ) : null}
        {filter.size ? (
          <button
            type="button"
            className="mt-1 flex h-7 w-full items-center justify-center rounded-md border-t border-stroke pt-1 text-[11px] text-content/50 hover:bg-content/6 hover:text-content"
            onClick={onClear}
          >
            Clear filter
          </button>
        ) : null}
        <label className="mt-1 flex h-7 items-center gap-1.5 border-t border-stroke px-1.5 pt-1 text-content/40 focus-within:text-content/60">
          <Plus className="size-3 shrink-0" strokeWidth={2} />
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (createGroup(newName)) setNewName("");
            }}
            placeholder="New group…"
            aria-label="New group name"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/40"
          />
        </label>
      </div>
    </Popover>
  );
}

function ProjectPickRow({
  label,
  mark,
  selected,
  onPick,
}: {
  label: string;
  mark?: React.ReactNode;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] ${
        selected
          ? "bg-accent/12 text-content"
          : "text-content/70 hover:bg-content/6 hover:text-content"
      }`}
      onClick={onPick}
    >
      {mark ?? (
        <Folder className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? (
        <span aria-hidden className="size-1.5 rounded-full bg-accent" />
      ) : null}
    </button>
  );
}

