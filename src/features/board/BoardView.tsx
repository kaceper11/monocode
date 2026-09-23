import { JIRA_CHANGE_EVENT } from "../inbox/model/jira";
import { inboxIntegrationCacheKey } from "../sessions/model/inboxIntegrations";
import { AgentHandoffDialog, type HandoffKind } from "./AgentHandoffDialog";
import { currentDeliveryStatuses, deliveryKey, type SendToSession } from "./delivery";
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
  CircleDot,
  Clock,
  Folder,
  GitPullRequest,
  ListBullet,
  ListFilter,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
  Zap,
} from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import { SecondaryButton } from "../../shared/ui/SecondaryButton";
import { ProjectLogoIcon } from "../projects/ui/ProjectLogoIcon";
import { ProjectMascot } from "../projects/ui/ProjectMascot";
import { useTabGroupLogos } from "../projects/hooks/useTabGroupLogos";
import {
  inboxProjectsForRail,
  listInboxItems,
  peekInboxList,
  inboxItemKey,
  type InboxItem,
  type InboxProvider,
  type InboxProviderErrors,
  type InboxQuery,
} from "../inbox/model/githubTasks";
import {
  INBOX_SOURCE_LABELS,
  visibleInboxSources,
  type InboxTimeFilter,
} from "../inbox/model/inboxFilters";
import { timeFilterStart } from "../sessions/model/sessionFilters";
import { IS_MAC } from "../../platform/tauri/platform";
import { pathKey, projectKey, projectName } from "../../shared/lib/paths";
import { looksLikeProject, sameProjectPath, type RecentProject } from "../projects/model/recents";
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
import {
  inboxItemMatchesLinkedWorkItem,
  linkedWorkItemFromInboxItem,
} from "../sessions/model/sessionWorkItem";
import { setGrabbing, suppressTextSelection } from "../../shared/lib/drag";
import { azureDevOpsBranchChecks } from "../inbox/model/azureDevOps";
import type { GitPrCheck } from "../../platform/tauri/fs";
import {
  attentionScore,
  buildBoardCards,
  boardLinkFromInboxItem,
  boardStatusOptions,
  matchesBoardStatuses,
  cardColumn,
  columnCards,
  columnDot,
  columnUnits,
  dropOrder,
  groupSwatch,
  isCardSnoozed,
  lanePrSignal,
  sessionDotClass,
  snoozeWakeKey,
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
  shortError,
  updateWorkstreamFromBase,
  type WorkstreamResult,
} from "./taskOps";
import { standupSections } from "./standup";
import { StandupDialog } from "./StandupDialog";
import { ReviewLocallyDialog } from "./ReviewLocallyDialog";
import type { PrSubmit } from "./CreatePrsDialog";
import {
  addColumn,
  addLocalCard,
  addTask,
  archiveTasks,
  boardFromSnapshot,
  boardSnapshot,
  boardStatusKey,
  createGroup,
  DEFAULT_BOARD_FILTER,
  DEFAULT_COLUMN_IDS,
  deleteBoardFilter,
  deleteGroup,
  hideCards,
  loadBoard,
  MAX_TASK_GROUPS,
  MAX_TASKS,
  MAX_WORKSTREAMS,
  newEntityId,
  pinCard,
  placeColumnOrder,
  removeCardFromGroup,
  removeColumn,
  removeLocalCard,
  renameBoardFilter,
  renameColumn,
  renameGroup,
  sameBoardFilterSpec,
  saveBoardFilter,
  setCardGroups,
  snoozeCard,
  subscribeBoard,
  UNGROUPED,
  unarchiveAll,
  unplaceCard,
  unsnoozeCard,
  updateTask,
  type BoardColumn,
  type BoardColumnId,
  type BoardFilterSpec,
  type BoardProviderStatus,
  type BoardGroup,
  type SavedBoardFilter,
  type TaskWorkstream,
} from "./boardStore";

const DRAG_THRESHOLD = 5;

const BOARD_TIME_OPTIONS: { id: InboxTimeFilter; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
];

type DragState = {
  cardId: string;
  /** Pointer position and grab offset — the overlay follows the cursor at the
   * point the card was picked up, not glued to its corner. */
  x: number;
  y: number;
  offX: number;
  offY: number;
  w: number;
  active: boolean;
  /** Escape set this mid-drag — pointerup still eats its release click but
   * commits nothing. */
  cancelled: boolean;
  overColumn: BoardColumnId | null;
  overIndex: number;
  /** Group wrapper under the pointer — dropping a task on it joins the
   * group. */
  overGroup: string | null;
};

// Presentation snapshots survive navigation. Mutations still probe live delivery state.
let boardStatusSnapshot: {
  scope: string;
  statuses: ReadonlyMap<string, WorkstreamStatus>;
} | undefined;
let boardChecksSnapshot: {
  scope: string;
  checks: ReadonlyMap<string, GitPrCheck[]>;
} | undefined;

export function BoardView({
  taskRequest,
  newTaskRequest,
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
  onPrepareWorktree,
  onBindSession,
  onRemoveWorktree,
}: {
  taskRequest?: { id: string } | null;
  newTaskRequest?: { item: InboxItem } | null;
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
  onSendToSession: SendToSession;
  onPrepareWorktree: (spec: TaskWorkstreamSpec) => Promise<string>;
  /** Create a worktree (when needed) + a bound live session for a workstream. */
  onSpawnSession: (
    spec: TaskWorkstreamSpec & {
      title: string;
      links: LinkedWorkItem[];
    },
  ) => Promise<{ sessionId: string; worktreePath: string }>;
  /** Attach a work-item link to an existing live session. */
  onBindSession: (sessionId: string, linked: LinkedWorkItem | null) => void;
  /** App-level worktree removal — session detach, persist guards, and
   * open-file checks live there; the model helper alone bypasses them. */
  onRemoveWorktree: (
    cwd: string,
    path: string,
    force: boolean,
    keepSessions?: boolean,
  ) => Promise<unknown>;
}) {
  const boardRaw = useSyncExternalStore(subscribeBoard, boardSnapshot);
  const board = useMemo(() => boardFromSnapshot(boardRaw), [boardRaw]);

  const projects = useMemo(
    () => inboxProjectsForRail(recents, cwd),
    [recents, cwd],
  );
  const connections = useInboxConnections();
  // Fetch-level "my work" filter — every provider honors it; off shows the wider listing.
  const [mineOnly, setMineOnly] = useState(true);
  const query = useMemo<InboxQuery>(
    () => ({ assignedToMe: mineOnly, state: "all", search: "" }),
    [mineOnly],
  );

  const [items, setItems] = useState<InboxItem[]>(
    () => peekInboxList(projects, query)?.items ?? [],
  );
  const [errors, setErrors] = useState<InboxProviderErrors>(
    () => peekInboxList(projects, query)?.errors ?? {},
  );
  const [fetching, setFetching] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === "connection") {
        setItems(items => items.filter(item => item.provider !== "jira"));
      }
      setRefresh(value => value + 1);
    };
    window.addEventListener(JIRA_CHANGE_EVENT, changed);
    return () => window.removeEventListener(JIRA_CHANGE_EVENT, changed);
  }, []);

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
    const onVisible = () => { if (document.visibilityState === "visible") setRefresh(value => value + 1); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  // Per-workstream PR + checks probe — refreshed with the inbox tick. The
  // effect keys on a serialization of probe inputs so unrelated board-store
  // writes (drags, placements) don't refire the git/CI fan-out.
  const probeStreams = useMemo(
    () =>
      board.tasks.flatMap((task) =>
        task.archived
          ? []
          : // A cleaned-up lane keeps probing its pinned PR from the
            // project root — the merged record shouldn't vanish.
            task.workstreams.filter((ws) => ws.worktreePath || ws.prUrl),
      ),
    [board.tasks],
  );
  // Every lane on the board, archived included — a worktree or branch serves
  // one lane board-wide; claims must see other tasks' lanes too.
  const boardLanes = useMemo(
    () => board.tasks.flatMap((task) => task.workstreams),
    [board.tasks],
  );
  const probeKey = probeStreams
    .map(
      (ws) =>
        deliveryKey(ws),
    )
    .join("\n");
  const probeRef = useRef(probeStreams);
  useEffect(() => {
    probeRef.current = probeStreams;
  });
  const statusScope = inboxIntegrationCacheKey();
  const [probedStatus, setWsStatus] = useState<
    ReadonlyMap<string, WorkstreamStatus>
  >(() =>
    boardStatusSnapshot?.scope === statusScope
      ? boardStatusSnapshot.statuses
      : new Map(),
  );
  const wsStatus = useMemo(
    () => currentDeliveryStatuses(
      probeStreams,
      boardStatusSnapshot?.scope === statusScope ? probedStatus : new Map(),
    ),
    [probeStreams, probedStatus, statusScope],
  );
  useEffect(() => {
    let cancelled = false;
    if (boardStatusSnapshot?.scope !== statusScope) setWsStatus(new Map());
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
        if (result.status !== "fulfilled" || !result.value[1]) continue;
        const status = result.value[1];
        // A failed request cannot establish the current revision. Do not carry
        // another checkout's or an older revision's green checks forward.
        next.set(result.value[0], status);
      }
      boardStatusSnapshot = { scope: statusScope, statuses: next };
      setWsStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [probeKey, refresh, statusScope]);

  const checksScope = JSON.stringify([
    statusScope,
    items
      .filter(item => item.provider === "azuredevops" && item.kind === "pr")
      .map(item => [inboxItemKey(item), item.repo, item.sourceRefName, item.updatedAt]),
  ]);
  const [cardChecks, setCardChecks] = useState<
    ReadonlyMap<string, GitPrCheck[]>
  >(() =>
    boardChecksSnapshot?.scope === checksScope
      ? boardChecksSnapshot.checks
      : new Map(),
  );

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
        cardChecks: boardChecksSnapshot?.scope === checksScope ? cardChecks : new Map(),
      }),
    [
      items,
      sessions,
      linkedSessions,
      updates,
      board.locals,
      board.tasks,
      board.groups,
      board.cardGroups,
      wsStatus,
      cardChecks,
      checksScope,
    ],
  );

  // Standalone Azure PR cards have no worktree — probe their branch's
  // pipeline builds by repo + sourceRefName + PR number. Targets are item
  // cards, so anything a task absorbed is skipped for free. The effect keys
  // on a serialization so unrelated board-store writes don't refire.
  const azureCheckTargets = useMemo(
    () =>
      cards.filter(
        (card) =>
          card.kind === "item" &&
          card.provider === "azuredevops" &&
          card.itemKind === "pr" &&
          card.item?.repo &&
          card.item.sourceRefName,
      ),
    [cards],
  );
  const azureCheckKey = azureCheckTargets
    .map(
      (card) =>
        `${card.id}:${card.item!.repo}:${card.item!.sourceRefName}:${card.item!.number}`,
    )
    .join("\n");
  const azureCheckRef = useRef(azureCheckTargets);
  useEffect(() => {
    azureCheckRef.current = azureCheckTargets;
  });
  useEffect(() => {
    let cancelled = false;
    const targets = azureCheckRef.current;
    if (boardChecksSnapshot?.scope !== checksScope) setCardChecks(new Map());
    if (!targets.length) {
      setCardChecks(new Map());
      return;
    }
    void Promise.allSettled(
      targets.map(
        async (card) =>
          [
            card.id,
            await azureDevOpsBranchChecks(
              card.item!.repo!,
              card.item!.sourceRefName!,
              card.item!.number,
            ),
          ] as const,
      ),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<string, GitPrCheck[]>();
      for (const result of results)
        if (result.status === "fulfilled")
          next.set(result.value[0], result.value[1]);
      boardChecksSnapshot = { scope: checksScope, checks: next };
      setCardChecks(next);
    });
    return () => {
      cancelled = true;
    };
  }, [azureCheckKey, refresh, checksScope]);

  // --- filters -----------------------------------------------------------
  const [search, setSearch] = useState("");
  const [hiddenProviders, setHiddenProviders] = useState<InboxProvider[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  // Group filter — group ids, plus `UNGROUPED` for cards with no group.
  const [groupFilter, setGroupFilter] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [actionOnly, setActionOnly] = useState(false);
  // Attention-first is a per-column sort, but it lives in the same spec so a
  // saved filter restores the ordering too.
  const [attentionFirst, setAttentionFirst] = useState(false);
  // Item kinds to hide (issues vs pull requests) — task/local cards always
  // pass; the filter trims standalone provider cards.
  const [hiddenKinds, setHiddenKinds] = useState<
    ReadonlySet<"issue" | "pr">
  >(new Set());
  const [statuses, setStatuses] = useState<BoardProviderStatus[]>([]);
  const statusOptions = useMemo(
    () => boardStatusOptions(cards, statuses),
    [cards, statuses],
  );
  const [timeFilter, setTimeFilter] = useState<InboxTimeFilter>("all");
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  // Column editor popover — rename/delete the target column, or flip to
  // add mode for a new one.
  const [columnEdit, setColumnEdit] = useState<{
    anchor: HTMLElement;
    column: BoardColumn;
  } | null>(null);

  // The whole filter-bar state as one spec — what a saved filter stores and
  // what applying one writes back.
  const currentSpec = useMemo<BoardFilterSpec>(
    () => ({
      project: projectFilter,
      groups: [...groupFilter],
      mineOnly,
      time: timeFilter,
      hiddenKinds: [...hiddenKinds],
      statuses,
      actionOnly,
      attentionFirst,
    }),
    [
      projectFilter,
      groupFilter,
      mineOnly,
      timeFilter,
      hiddenKinds,
      statuses,
      actionOnly,
      attentionFirst,
    ],
  );
  const applySpec = useCallback((spec: BoardFilterSpec) => {
    setProjectFilter(spec.project);
    setGroupFilter(new Set(spec.groups));
    setMineOnly(spec.mineOnly);
    setTimeFilter(spec.time);
    setHiddenKinds(new Set(spec.hiddenKinds));
    setStatuses(spec.statuses);
    setActionOnly(spec.actionOnly);
    setAttentionFirst(spec.attentionFirst);
  }, []);
  const filtersActive = !sameBoardFilterSpec(
    currentSpec,
    DEFAULT_BOARD_FILTER,
  );
  // The last explicitly applied saved filter — kept while the user tweaks
  // criteria (the panel marks it modified rather than dropping it).
  const [appliedFilterId, setAppliedFilterId] = useState<string | null>(null);
  // An exact spec match always wins — if the state matches another saved
  // filter, that is the view being shown. Otherwise the applied id holds.
  const activeFilter =
    board.filters.find((filter) =>
      sameBoardFilterSpec(filter.spec, currentSpec),
    ) ?? board.filters.find((filter) => filter.id === appliedFilterId);
  const applyFilter = useCallback(
    (filter: SavedBoardFilter | null) => {
      setAppliedFilterId(filter?.id ?? null);
      applySpec(filter?.spec ?? DEFAULT_BOARD_FILTER);
    },
    [applySpec],
  );

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
    const selectedStatuses = new Set(statuses.map(boardStatusKey));
    const hidden = new Set(hiddenProviders);
    const hiddenCards = new Set(board.hidden);
    const timeStart =
      timeFilter === "all" ? 0 : timeFilterStart(timeFilter, Date.now());
    return cards.filter((card) => {
      if (hiddenCards.has(card.id)) return false;
      if (!matchesBoardStatuses(card, selectedStatuses)) return false;
      // Snoozed — until the time passes or the wake fingerprint changes.
      if (isCardSnoozed(card, board.snoozed[card.id])) return false;
      if (card.provider && hidden.has(card.provider)) return false;
      // The updated window trims provider noise (e.g. ancient done items);
      // tasks, locals and link-only cards are board state and always pass.
      if (timeStart && card.item && card.updatedAt < timeStart) return false;
      if (
        hiddenKinds.size > 0 &&
        card.kind === "item" &&
        card.itemKind &&
        hiddenKinds.has(card.itemKind)
      )
        return false;
      // Cards without a project (locals, linked-only items) pass any filter.
      // Tasks match when any workstream lives in the filtered project.
      if (projectFilter) {
        const projectsOf = new Set(
          [card.projectPath, ...(card.workstreams ?? []).map((w) => w.projectPath)]
            .filter((p): p is string => Boolean(p)),
        );
        if (
          projectsOf.size &&
          ![...projectsOf].some((p) => sameProjectPath(p, projectFilter))
        )
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
        !card.sessions.some((session) => session.needsInput) &&
        // Lane merge signals ("Ready", "Conflicts") and probe failures are
        // actionable too — the filter must see what the card can show.
        !(card.workstreams ?? []).some(
          (row) => lanePrSignal(row) || row.probeError,
        )
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
    statuses,
    hiddenKinds,
    timeFilter,
    projectFilter,
    groupFilter,
    actionOnly,
    board.hidden,
    board.snoozed,
  ]);

  // Still-asleep snoozed cards — surfaced as a quiet restore affordance.
  const snoozedIds = useMemo(
    () =>
      cards
        .filter((card) => isCardSnoozed(card, board.snoozed[card.id]))
        .map((card) => card.id),
    [cards, board.snoozed],
  );

  // Deleted groups shouldn't linger in the filter — they'd match nothing
  // but still mark the spec as filtered.
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
  const pinnedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const card of board.locals) if (card.pinned) ids.add(card.id);
    for (const [id, placement] of Object.entries(board.placements))
      if (placement.pinned) ids.add(id);
    return ids;
  }, [board.locals, board.placements]);
  const cardsByColumn = useMemo(() => {
    const map = new Map<BoardColumnId, BoardCard[]>();
    for (const column of board.columns) {
      let list = columnCards(
        columnSource,
        column.id,
        board.placements,
        board.locals,
      );
      if (attentionFirst) {
        // Pinned keep their hand-set order; everything else ranks by
        // attention score (stable — equal scores keep board order).
        const pinned = list.filter((card) => pinnedIds.has(card.id));
        const rest = list
          .filter((card) => !pinnedIds.has(card.id))
          .map((card, index) => ({ card, index, score: attentionScore(card) }))
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .map((entry) => entry.card);
        list = [...pinned, ...rest];
      }
      map.set(column.id, list);
    }
    return map;
  }, [
    columnSource,
    board.columns,
    board.placements,
    board.locals,
    pinnedIds,
    attentionFirst,
  ]);
  /** cardId → when it entered its column — feeds the card age chip. */
  const placedAts = useMemo(() => {
    const map = new Map<string, number>();
    for (const card of board.locals)
      if (card.placedAt) map.set(card.id, card.placedAt);
    for (const [id, placement] of Object.entries(board.placements))
      if (placement.placedAt) map.set(id, placement.placedAt);
    return map;
  }, [board.locals, board.placements]);

  // Canonical card list for report/placement consumers — unfiltered and in
  // board order. `columnSource` is presentation: writing its filtered or
  // attention-sorted order back would freeze a transient view as truth.
  const canonicalByColumn = useMemo(() => {
    const hidden = new Set(board.hidden);
    const pool = cards.filter(
      (card) =>
        card.kind !== "session" &&
        !hidden.has(card.id) &&
        !isCardSnoozed(card, board.snoozed[card.id]),
    );
    const map = new Map<BoardColumnId, BoardCard[]>();
    for (const column of board.columns)
      map.set(
        column.id,
        columnCards(pool, column.id, board.placements, board.locals),
      );
    return map;
  }, [cards, board.hidden, board.snoozed, board.columns, board.placements, board.locals]);

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
      const pinned = new Set(pinnedIds);
      // A pinned card dragged inside its own column is an explicit
      // reposition — drop the pin rather than snapping back to the top.
      // (Dragged to ANOTHER column it lands pinned at that column's top.)
      const from = [...cardsByColumn.entries()].find(([, list]) =>
        list.some((card) => card.id === cardId),
      )?.[0];
      if (pinned.has(cardId) && from === column) {
        pinCard(cardId, column, false);
        pinned.delete(cardId);
      }
      placeColumnOrder(
        column,
        dropOrder(
          ordered.map((card) => card.id),
          pinned,
          cardId,
          index,
        ),
      );
    },
    [cardsByColumn, pinnedIds],
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
        x: startX,
        y: startY,
        offX: startX - rect.left,
        offY: startY - rect.top,
        w: rect.width,
        active: false,
        cancelled: false,
        overColumn: null,
        overIndex: -1,
        overGroup: null,
      };
      let releaseSuppress: (() => void) | null = null;

      // A drag-release still fires click on the pressed element — eat it so
      // dropping (or releasing after Escape) doesn't also open the card or
      // hit a chip. The listener expires next tick: if that click never
      // comes (released off-window) it must not eat the next real click.
      const eatReleaseClick = () => {
        const eat = (click: MouseEvent) => {
          click.preventDefault();
          click.stopPropagation();
        };
        window.addEventListener("click", eat, { capture: true });
        setTimeout(
          () => window.removeEventListener("click", eat, { capture: true }),
          0,
        );
      };

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
        if (
          state.active &&
          !state.cancelled &&
          state.overColumn &&
          state.overIndex >= 0
        ) {
          dropCardRef.current(card.id, state.overColumn, state.overIndex);
          // Groups are memberships, not containers: a drop ON a wrapper
          // promotes that group to primary (the wrapper the card renders
          // under) while keeping every other membership. A drop OUTSIDE
          // every wrapper removes only the primary — secondary groups keep
          // the card grouped. Dropping back on its own wrapper reorders.
          const over = state.overGroup;
          const current =
            card.kind === "task" && card.task
              ? (card.task.groupIds ?? [])
              : card.kind === "item" || card.kind === "local"
                ? (loadBoard().cardGroups[card.id] ?? [])
                : null;
          if (current) {
            const next = over
              ? over === current[0]
                ? current
                : [over, ...current.filter((id) => id !== over)].slice(
                    0,
                    MAX_TASK_GROUPS,
                  )
              : current.slice(1);
            const changed =
              next.length !== current.length ||
              next.some((id, index) => id !== current[index]);
            if (changed) {
              if (card.kind === "task" && card.task)
                updateTask(card.task.id, { groupIds: next });
              else setCardGroups(card.id, next);
            }
          }
        }
        if (state.active) eatReleaseClick();
      };
      // pointercancel = the browser/OS took the gesture (touch scroll,
      // interruption) — abort without committing a drop. No click follows.
      const onCancel = (cancel: globalThis.PointerEvent) => {
        if (cancel.pointerId !== event.pointerId) return;
        cleanup();
      };
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape") return;
        key.preventDefault();
        if (!state.active) {
          cleanup();
          return;
        }
        // Cancel the drag but keep pointerup/pointercancel armed — the
        // release still fires a click on the card, which onUp eats.
        state.cancelled = true;
        state.overColumn = null;
        state.overGroup = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("keydown", onKey, true);
        setGrabbing(false);
        releaseSuppress?.();
        releaseSuppress = null;
        setDrag(null);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        setGrabbing(false);
        releaseSuppress?.();
        releaseSuppress = null;
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
  const [handoff, setHandoff] = useState<{ workstreams: TaskWorkstream[]; taskId?: string; kind: HandoffKind; title: string; links: LinkedWorkItem[] } | null>(null);
  const openHandoff = useCallback((card: BoardCard, kind: HandoffKind, workstreamId?: string) => {
    if (card.task) {
      setHandoff({workstreams: card.task.workstreams.filter(w => !workstreamId || w.id === workstreamId), taskId: card.task.id, kind, title: card.title, links: card.task.links});
      return;
    }
    const ids = new Set(card.sessions.map(s => s.id));
    const candidates = [...sessions, ...linkedSessions.filter(s => !sessions.some(live => live.id === s.id))].filter(s => ids.has(s.id) && !s.worktreeRemoved);
    const rows = new Map<string, TaskWorkstream>();
    for (const session of candidates) {
      const cwd = session.worktreeCwd || session.cwd;
      const row = rows.get(cwd);
      if (row) row.sessionIds!.push(session.id);
      else rows.set(cwd, {id: session.id, projectPath: session.cwd, worktreePath: cwd, branch: session.branch || "", base: "HEAD", sessionIds:[session.id], prUrl: card.itemKind === "pr" ? card.url : undefined, prProvider: card.provider === "github" || card.provider === "gitlab" || card.provider === "azuredevops" ? card.provider : undefined});
    }
    setHandoff({workstreams:[...rows.values()],kind,title:card.title,links:[]});
  }, [sessions, linkedSessions]);

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  useEffect(() => {
    if (taskRequest) setSelectedCardId(taskRequest.id);
  }, [taskRequest]);
  /** PR inbox item being checked out into a review lane. */
  const [reviewItem, setReviewItem] = useState<InboxItem | null>(null);
  const [standupOpen, setStandupOpen] = useState(false);
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
        case "open-prs": {
          const urls = new Set<string>();
          for (const pr of card.prs ?? []) if (pr.url) urls.add(pr.url);
          for (const row of card.workstreams ?? [])
            if (row.pr?.url) urls.add(row.pr.url);
          for (const url of urls) void openUrl(url);
          return;
        }
        case "review-locally": {
          if (!card.item) return;
          // A task already tracking this PR gets surfaced instead of
          // spawning a duplicate review lane. Links can nest via
          // `additionalItems` — flatten before matching. Archived tasks are
          // invisible — they must not win the dedupe.
          const existing = loadBoard().tasks.find(
            (task) =>
              !task.archived &&
              task.links
                .flatMap((link) => [link, ...(link.additionalItems ?? [])])
                .some((link) =>
                  inboxItemMatchesLinkedWorkItem(card.item!, link),
                ),
          );
          if (existing) setSelectedCardId(existing.id);
          else setReviewItem(card.item);
          return;
        }
        case "snooze":
          snoozeCard(card.id, {
            until: action.until,
            wake: action.wakeOnChange ? snoozeWakeKey(card) : undefined,
          });
          return;
        case "fix-ci": openHandoff(card, "ci"); return;
        case "comments": openHandoff(card, "comments"); return;
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
        case "pin":
          pinCard(
            card.id,
            cardColumn(card, board.placements),
            !pinnedIds.has(card.id),
          );
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
          setTaskFromInbox(null);
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
    [
      board.placements,
      pinnedIds,
      onOpenSession,
      onSendToSession,
      onStartItem,
      openHandoff,
    ],
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
  const [taskFromInbox, setTaskFromInbox] = useState<InboxItem | null>(null);
  useEffect(() => {
    if (!newTaskRequest) return;
    setTaskFromInbox(newTaskRequest.item);
    setPromoteFrom(null);
    setTaskError("");
    setTaskDialogOpen(true);
  }, [newTaskRequest]);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (!createdSessionId || !sessions.some(session => session.id === createdSessionId)) return;
    setCreatedSessionId(null);
    onOpenSession(createdSessionId);
  }, [createdSessionId, sessions, onOpenSession]);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionResults, setActionResults] = useState<
    ReadonlyMap<string, WorkstreamResult>
  >(new Map());

  const onCreateTask = useCallback(
    async (spec: NewTaskSpec) => {
      // Reject a full board before preparing any working copies.
      // Archived tasks don't render — they shouldn't count toward the cap.
      if (loadBoard().tasks.filter((task) => !task.archived).length >= MAX_TASKS) {
        setTaskError("Board is full — archive some tasks first.");
        return;
      }
      setTaskBusy(true);
      setTaskError("");
      const workstreams: TaskWorkstream[] = [];
      const errors: string[] = [];
      const failed = new Map<string, WorkstreamResult>();
      // Paths the spec binds rather than creates — failure cleanup must
      // never remove a pre-existing worktree the user only pointed at.
      const boundPaths = new Set(
        spec.workstreams
          .map((ws) => ws.worktreePath)
          .filter((path): path is string => !!path)
          .map(pathKey),
      );
      // A failed lane stays on the task as a row without a worktree — the
      // details panel's "Create worktree" retries it.
      const failLane = (ws: TaskWorkstreamSpec, reason: string) => {
        const message = `${projectName(ws.projectPath)}: ${reason}`;
        errors.push(message);
        const stubId = newEntityId("ws");
        failed.set(stubId, { workstreamId: stubId, ok: false, message });
        workstreams.push({
          id: stubId,
          projectPath: ws.projectPath,
          branch: ws.branch,
          base: ws.base,
        });
      };
      // A branch lives in one worktree and a worktree serves one lane —
      // sibling rows and other tasks' lanes both count as claims.
      const claimed = (ws: TaskWorkstreamSpec) => {
        const takes = (lane: {
          projectPath: string;
          branch: string;
          worktreePath?: string;
        }) =>
          sameProjectPath(lane.projectPath, ws.projectPath) &&
          (lane.branch === ws.branch ||
            (!!ws.worktreePath &&
              !!lane.worktreePath &&
              pathKey(lane.worktreePath) === pathKey(ws.worktreePath)));
        return (
          workstreams.some(takes) ||
          loadBoard().tasks.some((task) => task.workstreams.some(takes))
        );
      };
      for (const ws of spec.workstreams) {
        if (workstreams.length >= MAX_WORKSTREAMS) {
          failLane(ws, `a task can hold at most ${MAX_WORKSTREAMS} lanes`);
          continue;
        }
        if (claimed(ws)) {
          failLane(ws, `a lane already tracks ${ws.branch}`);
          continue;
        }
        try {
          const worktreePath = await onPrepareWorktree(ws);
          workstreams.push({
            id: newEntityId("ws"),
            projectPath: ws.projectPath,
            branch: ws.branch,
            base: ws.base,
            worktreePath,
          });
        } catch (error) {
          failLane(ws, shortError(error));
        }
      }
      // Total failure keeps the dialog open — no phantom task to resubmit.
      if (errors.length === spec.workstreams.length && errors.length) {
        setTaskBusy(false);
        setTaskError(errors.join(" · "));
        return;
      }
      // Failed lanes stay on the task as rows without a worktree — the
      // details panel's "Create worktree" retries them.
      const id = addTask({
        title: spec.title,
        links: spec.links,
        workstreams,
        groupIds: spec.groupIds,
      });
      if (!id) {
        // The board filled since the pre-check — remove newly prepared
        // worktrees, never the existing working copies the user selected.
        // Awaited so a resubmit can't collide with a still-registered copy.
        await Promise.allSettled(
          workstreams
            .filter(
              (ws) =>
                ws.worktreePath && !boundPaths.has(pathKey(ws.worktreePath)),
            )
            .map((ws) =>
              onRemoveWorktree(ws.projectPath, ws.worktreePath!, false, true),
            ),
        );
        setTaskBusy(false);
        setTaskError("Board is full — remove a task first");
        return;
      }
      let primarySessionId: string | undefined;
      const primary = workstreams.find((ws) => ws.worktreePath);
      if (primary) {
        try {
          const spawned = await onSpawnSession({ ...primary, title: spec.title, links: spec.links });
          primarySessionId = spawned.sessionId;
          updateTask(id, { primarySessionId });
        } catch (error) {
          failed.set(primary.id, { workstreamId: primary.id, ok: false, message: `Task session: ${shortError(error)}` });
        }
      }
      setTaskBusy(false);
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
      // Keep partial preparation or session failures visible on the Board.
      if (failed.size) setActionResults(failed);
      else setCreatedSessionId(primarySessionId ?? null);
    },
    [
      onSpawnSession,
      onPrepareWorktree,
      onRemoveWorktree,
      promoteFrom,
      cards,
      board.placements,
      board.locals,
    ],
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
      onSendToSession,
      onSpawnSession: async (spec: TaskWorkstreamSpec) =>
        onSpawnSession({ ...spec, title: task.title, links: task.links }),
      onBindSession,
      onSubmitPrs: (only: ReadonlySet<string>, opts: PrSubmit) =>
        runTaskOp("prs", async () => {
          // A chosen target is the lane's base going forward — persist it so
          // "Update branches" merges from the same branch the PR targets.
          updateTask(task.id, (current) => ({
            workstreams: current.workstreams.map((ws) =>
              opts.bases.has(ws.id)
                ? { ...ws, base: opts.bases.get(ws.id)! }
                : ws,
            ),
          }));
          // Full task context — `only` restricts creation, so bodies still
          // list sibling branches and existing sibling PRs.
          return createTaskPrs(task, wsStatus, only, {
            title: opts.title,
            body: opts.body,
            bases: opts.bases,
            descriptions: opts.descriptions,
            draft: opts.draft,
          });
        }),
      onUpdateBranches: () =>
        run("merge", task.workstreams, (ws) =>
          updateWorkstreamFromBase(ws),
        ),
      onUpdateWorkstream: (wsId: string) =>
        run(`merge:${wsId}`, task.workstreams.filter((ws) => ws.id === wsId), (ws) =>
          updateWorkstreamFromBase(ws),
        ),
      onCleanupWorkstream: (wsId: string) =>
        runTaskOp(`cleanup:${wsId}`, async () => {
          const ws = task.workstreams.find((entry) => entry.id === wsId);
          if (!ws?.worktreePath) return [];
          // keepSessions — bound sessions are stale but their records
          // aren't the lane's to delete.
          await onRemoveWorktree(ws.projectPath, ws.worktreePath, false, true);
          // Pin the PR so the lane keeps probing it via the project
          // root — clearing the worktree must not erase the record.
          const prUrl = ws.prUrl ?? (wsStatus.get(wsId)?.pr?.url || undefined);
          updateTask(task.id, (current) => ({
            workstreams: current.workstreams.map((entry) =>
              entry.id === wsId
                ? { ...entry, worktreePath: undefined, prUrl }
                : entry,
            ),
          }));
          return [];
        }),
    };
  }, [
    selectedCard,
    wsStatus,
    runTaskOp,
    onSpawnSession,
    onBindSession,
    onOpenSession,
    onSendToSession,
    onRemoveWorktree,
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
            aria-label="Board filters"
            aria-pressed={filtersActive}
            title={
              activeFilter
                ? `Saved filter: ${activeFilter.name}`
                : "Board filters"
            }
            className={`flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium ${
              filtersActive
                ? "bg-accent/15 text-accent"
                : "text-content/50 hover:bg-content/8 hover:text-content"
            }`}
            onClick={(event) => setFilterAnchor(event.currentTarget)}
          >
            <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
            <span className="min-w-0 max-w-36 truncate">
              {activeFilter?.name ?? "Filters"}
            </span>
            <ChevronDown
              className="size-3 shrink-0 text-content/35"
              strokeWidth={2}
            />
          </button>
          {snoozedIds.length ? (
            <button
              type="button"
              title={`${snoozedIds.length} snoozed — click to wake them all`}
              className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-content/50 hover:bg-content/8 hover:text-content"
              onClick={() => snoozedIds.forEach(unsnoozeCard)}
            >
              <Clock className="size-3.5" strokeWidth={1.75} />
              {snoozedIds.length}
            </button>
          ) : null}
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-content/10" />
          <IconButton
            label="Standup report"
            onClick={() => setStandupOpen(true)}
          >
            <ListBullet className="size-3.5" strokeWidth={1.75} />
          </IconButton>
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
          <button
            type="button"
            title="New task"
            aria-label="New task"
            className="flex h-7 items-center gap-1 rounded-md bg-accent/12 px-1.5 text-[11px] font-medium text-accent hover:bg-accent/20"
            onClick={() => {
              setTaskError("");
              setPromoteFrom(null);
              setTaskFromInbox(null);
              setTaskDialogOpen(true);
            }}
          >
            <Plus className="size-3.5" strokeWidth={2} />
            Task
          </button>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          ref={boardRef}
          className="flex min-h-0 min-w-0 flex-1 items-stretch gap-3 overflow-auto p-3"
        >
        {board.columns.map((column) => {
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
          const renderCard = (card: BoardCard, inGroup?: string) => (
            <BoardCardView
              key={card.id}
              card={card}
              column={column.id}
              columns={board.columns}
              manual={
                card.kind !== "local" &&
                board.placements[card.id] !== undefined
              }
              pinned={pinnedIds.has(card.id)}
              placedAt={placedAts.get(card.id)}
              dragging={drag?.active === true && drag.cardId === card.id}
              dropTarget={
                drag?.active === true &&
                drag.overColumn === column.id &&
                drag.overIndex === visibleIndex.get(card.id)
              }
              inGroup={inGroup}
              onAction={onCardAction}
              onDragStart={onDragStart}
            />
          );
          return (
            <section
              key={column.id}
              data-board-column={column.id}
              aria-label={column.label}
              className={`group/col flex min-h-24 min-w-64 flex-1 flex-col rounded-xl border border-content/8 bg-content/[0.02] ${
                drag?.active && drag.overColumn === column.id
                  ? "ring-1 ring-accent/40"
                  : ""
              }`}
            >
              <header className="flex h-8 shrink-0 items-center gap-1.5 px-2.5">
                <span
                  aria-hidden
                  className={`size-1.5 rounded-full ${columnDot(column.id)}`}
                />
                <h2 className="min-w-0 truncate text-[12px] font-medium text-content/80">
                  {column.label}
                </h2>
                <span className="text-[11px] text-content/40">
                  {columnList.length}
                </span>
                <span className="ml-auto flex items-center gap-0.5">
                {column.id === "done" && columnList.length ? (
                  <button
                    type="button"
                    title="Archive the cards shown in Done"
                    aria-label="Archive the cards shown in Done"
                    className="grid size-5 place-items-center rounded text-content/35 hover:bg-content/10 hover:text-content"
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
                <button
                  type="button"
                  title={`Edit column ${column.label}`}
                  aria-label={`Edit column ${column.label}`}
                  className="grid size-5 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover/col:opacity-100 focus-visible:opacity-100"
                  onClick={(event) =>
                    setColumnEdit({
                      anchor: event.currentTarget,
                      column,
                    })
                  }
                >
                  <Pencil className="size-3" strokeWidth={1.75} />
                </button>
                </span>
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
                        {unit.cards.map((card) =>
                          renderCard(card, unit.group.id),
                        )}
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
              onHandoff={(id, kind) => openHandoff(selectedCard!, kind, id)}
            key={selectedCard.id}
            card={selectedCard}
            lanes={boardLanes}
            items={items}
            recents={recents}
            sessions={sessions}
            busyAction={actionBusy ?? ""}
            results={actionResults}
            onClose={taskOpsHandlers.onClose}
            onOpenSession={taskOpsHandlers.onOpenSession}
            onSessionCreated={setCreatedSessionId}
            onSendToSession={taskOpsHandlers.onSendToSession}
            onSpawnSession={taskOpsHandlers.onSpawnSession}
            onPrepareWorktree={onPrepareWorktree}
            onBindSession={taskOpsHandlers.onBindSession}
            wsStatus={wsStatus}
            onUpdateBranches={taskOpsHandlers.onUpdateBranches}
            onUpdateWorkstream={taskOpsHandlers.onUpdateWorkstream}
            onSubmitPrs={taskOpsHandlers.onSubmitPrs}
            onCleanupWorkstream={taskOpsHandlers.onCleanupWorkstream}
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
                      setTaskFromInbox(null);
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
            column={drag.overColumn ?? "todo"}
            columns={board.columns}
            manual={false}
            pinned={false}
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
      {filterAnchor ? (
        <BoardFiltersPopover
          anchor={filterAnchor}
          recents={recents}
          groups={board.groups}
          saved={board.filters}
          statusOptions={statusOptions}
          spec={currentSpec}
          appliedId={appliedFilterId}
          onSpec={applySpec}
          onApply={applyFilter}
          onClose={() => setFilterAnchor(null)}
        />
      ) : null}
      {columnEdit ? (
        <ColumnPopover
          anchor={columnEdit.anchor}
          column={columnEdit.column}
          cardCount={
            // Unfiltered — a delete moves every card in the column, not
            // just the ones passing the current filter.
            cards.filter(
              (card) =>
                cardColumn(card, board.placements) === columnEdit.column.id,
            ).length
          }
          columns={board.columns}
          onClose={() => setColumnEdit(null)}
        />
      ) : null}
      {taskDialogOpen ? (
        <NewTaskDialog
          items={taskFromInbox ? [taskFromInbox, ...items.filter(item => inboxItemKey(item) !== inboxItemKey(taskFromInbox))] : items}
          recents={recents}
          lanes={boardLanes}
          busy={taskBusy}
          error={taskError}
          key={taskFromInbox ? inboxItemKey(taskFromInbox) : "new-task"}
          initialTitle={taskFromInbox?.title ?? promoteFrom?.title}
          initialLinks={taskFromInbox ? [boardLinkFromInboxItem(taskFromInbox)].filter((link): link is LinkedWorkItem => !!link) : undefined}
          initialProject={taskFromInbox ? (looksLikeProject(taskFromInbox.projectPath) ? taskFromInbox.projectPath : undefined) : looksLikeProject(cwd) ? cwd : undefined}
          onSubmit={onCreateTask}
          onCancel={() => {
            setTaskDialogOpen(false);
            setPromoteFrom(null);
          }}
        />
      ) : null}
      {handoff && <AgentHandoffDialog key={`${handoff.taskId || handoff.title}:${handoff.kind}:${handoff.workstreams.map(w => w.id).join()}`} workstreams={handoff.workstreams} taskId={handoff.taskId} kind={handoff.kind} sessions={sessions} onSend={onSendToSession} onClose={() => setHandoff(null)} onSpawn={async ws => {
        const created = await onSpawnSession({...ws, title: handoff.title, links: handoff.links});
        if (handoff.taskId) updateTask(handoff.taskId, current => ({workstreams: current.workstreams.map(w => w.id === ws.id ? {...w, sessionIds: [...new Set([...(w.sessionIds || []), created.sessionId])]} : w)}));
        return created;
      }}/>}
      {reviewItem ? (
        <ReviewLocallyDialog
          item={reviewItem}
          recents={recents}
          reviewColumnIds={(canonicalByColumn.get("review") ?? []).map(
            (card) => card.id,
          )}
          onSpawnSession={onSpawnSession}
          onSendToSession={onSendToSession}
          onRemoveWorktree={onRemoveWorktree}
          onCreated={setSelectedCardId}
          onClose={() => setReviewItem(null)}
        />
      ) : null}
      {standupOpen ? (
        <StandupDialog
          sections={standupSections({
            // The report covers the whole board (filters are view-only),
            // in canonical column order — pinned and manual order carry.
            cards: [...canonicalByColumn.values()].flat(),
            placements: board.placements,
            locals: board.locals,
          })}
          openUrl={(url) => void openUrl(url)}
          onClose={() => setStandupOpen(false)}
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

const FILTER_SECTION =
  "px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content/40";

/** All board filters in one popover: project, groups, fetch/view filters,
 * the action/attention switches — plus the saved-filter list. Pick a saved
 * filter to apply it (click again to clear); a diverged applied filter keeps
 * its name and offers an Update chip — pencil renames, X deletes, and the
 * save input stores the current spec (reusing a name overwrites it). */
function BoardFiltersPopover({
  anchor,
  recents,
  groups,
  saved,
  statusOptions,
  spec,
  appliedId,
  onSpec,
  onApply,
  onClose,
}: {
  anchor: HTMLElement;
  recents: RecentProject[];
  groups: BoardGroup[];
  saved: SavedBoardFilter[];
  statusOptions: BoardProviderStatus[];
  spec: BoardFilterSpec;
  appliedId: string | null;
  onSpec: (spec: BoardFilterSpec) => void;
  onApply: (filter: SavedBoardFilter | null) => void;
  onClose: () => void;
}) {
  const [projectSearch, setProjectSearch] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  // Inline rename — saved filters and groups share the one input slot.
  const [rename, setRename] = useState<{
    kind: "filter" | "group";
    id: string;
    value: string;
  } | null>(null);

  const toggleGroup = (id: string) =>
    onSpec({
      ...spec,
      groups: spec.groups.includes(id)
        ? spec.groups.filter((entry) => entry !== id)
        : [...spec.groups, id],
    });
  const toggleKind = (kind: "issue" | "pr") =>
    onSpec({
      ...spec,
      hiddenKinds: spec.hiddenKinds.includes(kind)
        ? spec.hiddenKinds.filter((entry) => entry !== kind)
        : [...spec.hiddenKinds, kind],
    });
  const commitRename = () => {
    if (!rename) return;
    if (rename.kind === "filter") renameBoardFilter(rename.id, rename.value);
    else renameGroup(rename.id, rename.value);
    setRename(null);
  };
  const dirty = !sameBoardFilterSpec(spec, DEFAULT_BOARD_FILTER);
  const projectRows = recents.filter(
    (project) =>
      !projectSearch ||
      projectName(project.path)
        .toLowerCase()
        .includes(projectSearch.toLowerCase()) ||
      project.path.toLowerCase().includes(projectSearch.toLowerCase()),
  );

  const renameInput = (
    <input
      autoFocus
      value={rename?.value ?? ""}
      aria-label={rename?.kind === "filter" ? "Rename filter" : "Rename group"}
      onChange={(event) =>
        setRename((current) =>
          current ? { ...current, value: event.target.value } : current,
        )
      }
      onKeyDown={(event) => {
        if (event.key === "Enter") commitRename();
        else if (event.key === "Escape") setRename(null);
      }}
      onBlur={commitRename}
      className="h-7 min-w-0 flex-1 rounded bg-content/8 px-2 text-[12px] text-content outline-none focus:ring-1 focus:ring-accent/50"
    />
  );

  return (
    <Popover
      anchor={anchor}
      onDismiss={onClose}
      ignore="[data-dialog-popover]"
      width={320}
      maxHeight={560}
      aria-label="Board filters"
      className="overflow-y-auto"
    >
      <div className="p-1.5" role="group" aria-label="Board filters">
        <div className="mb-1 flex items-center justify-between border-b border-content/8 px-2 pb-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content/40">
            Filters
          </span>
          {dirty ? (
            <button
              type="button"
              className="text-[11px] font-medium text-content/50 transition-colors hover:text-content"
              onClick={() => onApply(null)}
            >
              Clear
            </button>
          ) : null}
        </div>

        {saved.length > 0 ? (
          <BoardFilterSection
            label="Saved views"
            summary={
              saved.find(
                (filter) =>
                  filter.id === appliedId ||
                  sameBoardFilterSpec(filter.spec, spec),
              )?.name ?? `${saved.length} saved`
            }
          >
            {saved.map((filter) => {
              const exact = sameBoardFilterSpec(filter.spec, spec);
              const applied = exact || filter.id === appliedId;
              // Applied but criteria since changed — offer to write the current
              // spec back instead of dropping the filter's active state.
              const modified = filter.id === appliedId && !exact;
              return (
                <div
                  key={filter.id}
                  className="group flex items-center gap-0.5 rounded-md hover:bg-content/6"
                >
                  {rename?.kind === "filter" && rename.id === filter.id ? (
                    renameInput
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-pressed={applied}
                        title={
                          exact
                            ? `${filter.name} applied — click to clear`
                            : modified
                              ? `${filter.name} applied, modified — click to restore it`
                              : `Apply filter ${filter.name}`
                        }
                        className={`flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[12px] ${
                          applied
                            ? "text-content"
                            : "text-content/70 hover:text-content"
                        }`}
                        onClick={() => onApply(exact ? null : filter)}
                      >
                        <ListFilter
                          className="size-3 shrink-0 text-content/40"
                          strokeWidth={1.75}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {filter.name}
                        </span>
                        {exact ? (
                          <Check
                            className="size-3.5 shrink-0 text-accent"
                            strokeWidth={2.5}
                          />
                        ) : null}
                      </button>
                      {modified ? (
                        <button
                          type="button"
                          title="Update this filter with the current settings"
                          className="shrink-0 rounded px-1 text-[10px] font-medium text-accent hover:bg-accent/15"
                          onClick={() => saveBoardFilter(filter.name, spec)}
                        >
                          Update
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`Rename filter ${filter.name}`}
                        className="grid size-5 shrink-0 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={() =>
                          setRename({
                            kind: "filter",
                            id: filter.id,
                            value: filter.name,
                          })
                        }
                      >
                        <Pencil className="size-3" strokeWidth={1.75} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete filter ${filter.name}`}
                        className="mr-1 grid size-5 shrink-0 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={() => deleteBoardFilter(filter.id)}
                      >
                        <X className="size-3" strokeWidth={1.75} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </BoardFilterSection>
        ) : null}
        <div className="border-b border-content/8 py-1.5">
          <BoardFilterRow
            label="Assigned to me"
            checked={spec.mineOnly}
            onClick={() => onSpec({ ...spec, mineOnly: !spec.mineOnly })}
          />
          <BoardFilterRow
            label="Needs action only"
            checked={spec.actionOnly}
            icon={
              <ListFilter className="size-3.5 shrink-0" strokeWidth={1.75} />
            }
            onClick={() => onSpec({ ...spec, actionOnly: !spec.actionOnly })}
          />
        </div>
        <BoardFilterSection
          label="Provider status"
          summary={
            spec.statuses.length
              ? spec.statuses
                  .map(
                    (status) =>
                      `${INBOX_SOURCE_LABELS[status.provider]}: ${status.state}`,
                  )
                  .join(", ")
              : "All statuses"
          }
        >
          <BoardFilterRow
            label="All statuses"
            checked={!spec.statuses.length}
            onClick={() => onSpec({ ...spec, statuses: [] })}
          />
          <div className="max-h-48 overflow-y-auto">
            {Object.entries(INBOX_SOURCE_LABELS).map(([provider, label]) => {
              const options = statusOptions.filter(
                (status) => status.provider === provider,
              );
              if (!options.length) return null;
              return (
                <div
                  key={provider}
                  role="group"
                  aria-label={`${label} statuses`}
                >
                  <p className="px-2 py-1 text-[11px] text-content/40">
                    {label}
                  </p>
                  {options.map((status) => {
                    const key = boardStatusKey(status);
                    const checked = spec.statuses.some(
                      (entry) => boardStatusKey(entry) === key,
                    );
                    return (
                      <BoardFilterRow
                        key={key}
                        label={status.state}
                        checked={checked}
                        onClick={() =>
                          onSpec({
                            ...spec,
                            statuses: checked
                              ? spec.statuses.filter(
                                  (entry) => boardStatusKey(entry) !== key,
                                )
                              : [...spec.statuses, status],
                          })
                        }
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
          {!statusOptions.length ? (
            <p className="px-2 py-1 text-[11px] text-content/40">
              No provider statuses loaded.
            </p>
          ) : null}
        </BoardFilterSection>
        <BoardFilterSection
          label="Project"
          summary={spec.project ? projectName(spec.project) : "All projects"}
        >
          {recents.length > 5 ? (
            <input
              value={projectSearch}
              onChange={(event) => setProjectSearch(event.target.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
              className="mb-1 h-7 w-full rounded-md bg-content/6 px-2 text-[12px] text-content outline-none placeholder:text-content/40 focus:ring-1 focus:ring-accent/40"
            />
          ) : null}
          <ProjectPickRow
            label="All projects"
            selected={!spec.project}
            onPick={() => onSpec({ ...spec, project: "" })}
          />
          <div className="max-h-36 overflow-y-auto">
            {projectRows.map((project) => (
              <ProjectPickRow
                key={project.path}
                label={projectName(project.path)}
                mark={<BoardProjectMark path={project.path} />}
                selected={sameProjectPath(project.path, spec.project)}
                onPick={() => onSpec({ ...spec, project: project.path })}
              />
            ))}
          </div>
        </BoardFilterSection>
        <BoardFilterSection
          label="Groups"
          summary={
            spec.groups.length
              ? spec.groups
                  .map((id) =>
                    id === UNGROUPED
                      ? "Ungrouped"
                      : (groups.find((group) => group.id === id)?.name ?? id),
                  )
                  .join(", ")
              : "All groups"
          }
        >
          <div className="max-h-36 overflow-y-auto">
            {groups.map((group) => {
              const swatch = groupSwatch(group.color);
              const selected = spec.groups.includes(group.id);
              return (
                <div
                  key={group.id}
                  className="group flex items-center gap-0.5 rounded-md hover:bg-content/6"
                >
                  {rename?.kind === "group" && rename.id === group.id ? (
                    renameInput
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-pressed={selected}
                        className={`flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[12px] ${
                          selected
                            ? "text-content"
                            : "text-content/70 hover:text-content"
                        }`}
                        onClick={() => toggleGroup(group.id)}
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
                        onClick={() =>
                          setRename({
                            kind: "group",
                            id: group.id,
                            value: group.name,
                          })
                        }
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
          </div>
          <button
            type="button"
            aria-pressed={spec.groups.includes(UNGROUPED)}
            className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] ${
              spec.groups.includes(UNGROUPED)
                ? "text-content"
                : "text-content/70 hover:bg-content/6 hover:text-content"
            }`}
            onClick={() => toggleGroup(UNGROUPED)}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full border border-content/30"
            />
            <span className="min-w-0 flex-1 truncate text-content/60">
              Ungrouped
            </span>
            {spec.groups.includes(UNGROUPED) ? (
              <Check
                className="size-3.5 shrink-0 text-accent"
                strokeWidth={2.5}
              />
            ) : null}
          </button>
          {!groups.length ? (
            <p className="px-2 py-1.5 text-[11px] text-content/40">
              No groups yet — create one to tag tasks.
            </p>
          ) : null}
          <label className="mt-0.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-content/40 focus-within:bg-content/6 focus-within:text-content/60">
            <Plus className="size-3 shrink-0" strokeWidth={2} />
            <input
              value={newGroup}
              onChange={(event) => setNewGroup(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                if (createGroup(newGroup)) setNewGroup("");
              }}
              placeholder="New group…"
              aria-label="New group name"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/40"
            />
          </label>
        </BoardFilterSection>
        <BoardFilterSection
          label="Display"
          summary={[
            BOARD_TIME_OPTIONS.find((option) => option.id === spec.time)?.label,
            spec.hiddenKinds.length === 2
              ? "No items"
              : spec.hiddenKinds.includes("pr")
                ? "Issues"
                : spec.hiddenKinds.includes("issue")
                  ? "Pull requests"
                  : "All types",
            ...(spec.attentionFirst ? ["Attention first"] : []),
          ].join(" · ")}
        >
          <div className="flex items-center justify-between gap-2 px-2 py-1 text-[12px] text-content/70">
            <span>Updated</span>
            <SearchableSelect
              label="Updated"
              value={spec.time}
              options={BOARD_TIME_OPTIONS.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
              onChange={(value) =>
                onSpec({ ...spec, time: value as InboxTimeFilter })
              }
              variant="row"
              searchable={false}
              align="end"
            />
          </div>
          <p className={FILTER_SECTION}>Type</p>
          <BoardFilterRow
            label="Issues"
            checked={!spec.hiddenKinds.includes("issue")}
            icon={
              <CircleDot className="size-3.5 shrink-0" strokeWidth={1.75} />
            }
            onClick={() => toggleKind("issue")}
          />
          <BoardFilterRow
            label="Pull requests"
            checked={!spec.hiddenKinds.includes("pr")}
            icon={
              <GitPullRequest
                className="size-3.5 shrink-0"
                strokeWidth={1.75}
              />
            }
            onClick={() => toggleKind("pr")}
          />
          <p className={FILTER_SECTION}>Sort</p>
          <BoardFilterRow
            label="Attention first"
            checked={spec.attentionFirst}
            icon={<Zap className="size-3.5 shrink-0" strokeWidth={1.75} />}
            onClick={() =>
              onSpec({ ...spec, attentionFirst: !spec.attentionFirst })
            }
          />
        </BoardFilterSection>
        <div className="mt-1 border-t border-content/8 pt-1.5">
          {saving ? (
            <form
              className="flex items-center gap-1 px-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (saveBoardFilter(saveName, spec)) {
                  setSaveName("");
                  setSaving(false);
                }
              }}
            >
              <input
                autoFocus
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
                placeholder="View name…"
                aria-label="Save current filters as"
                className="h-8 min-w-0 flex-1 rounded-md bg-content/6 px-2 text-[12px] text-content outline-none placeholder:text-content/40 focus:ring-1 focus:ring-accent/50"
              />
              <SecondaryButton type="submit" disabled={!saveName.trim()}>
                Save
              </SecondaryButton>
              <IconButton
                label="Cancel saving view"
                onClick={() => setSaving(false)}
              >
                <X className="size-3.5" strokeWidth={1.75} />
              </IconButton>
            </form>
          ) : (
            <div className="flex justify-end px-1 pb-0.5">
              <SecondaryButton onClick={() => setSaving(true)}>
                <Plus className="size-3.5" strokeWidth={1.75} /> Save view…
              </SecondaryButton>
            </div>
          )}
        </div>
      </div>
    </Popover>
  );
}

function BoardFilterSection({
  label,
  summary,
  children,
}: {
  label: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group/section border-b border-content/8 last:border-0">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors hover:bg-content/5 group-open/section:bg-content/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 font-medium text-content/80">{label}</span>
        <span
          title={summary}
          className="min-w-0 flex-1 truncate text-right text-[11px] text-content/45"
        >
          {summary}
        </span>
        <ChevronDown
          aria-hidden
          className="size-3 shrink-0 text-content/40 transition-transform group-open/section:rotate-180"
        />
      </summary>
      <div className="pb-2">{children}</div>
    </details>
  );
}

function BoardFilterRow({
  label,
  checked,
  icon,
  onClick,
}: {
  label: string;
  checked: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] leading-none text-content/75 transition-colors hover:bg-content/5 hover:text-content focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked ? (
        <Check className="size-3 shrink-0 text-accent" strokeWidth={2} />
      ) : null}
    </button>
  );
}

/** Column editor — name field for add/rename; custom columns also get a
 * delete row. Defaults can't be removed (derivation + archive key on them)
 * but can be renamed. */
function ColumnPopover({
  anchor,
  column,
  cardCount,
  columns,
  onClose,
}: {
  anchor: HTMLElement;
  column: BoardColumn;
  /** Cards currently sitting in `column` — shown when deleting it. */
  cardCount: number;
  /** All columns, to offer move destinations on delete. */
  columns: readonly BoardColumn[];
  onClose: () => void;
}) {
  const [name, setName] = useState(column.label);
  // Edit mode starts on the existing column; "New column" flips it to add.
  const [adding, setAdding] = useState(false);
  // "" → cards return to their status columns; anything else is a column id.
  const [target, setTarget] = useState("");
  const deletable = !adding && !DEFAULT_COLUMN_IDS.has(column.id);
  const submit = () => {
    if (!name.trim()) return;
    if (!adding) renameColumn(column.id, name);
    else addColumn(name);
    onClose();
  };
  return (
    <Popover
      anchor={anchor}
      align="start"
      width={208}
      onDismiss={onClose}
      aria-label={!adding ? `Edit column ${column.label}` : "Add column"}
      className="p-1.5"
    >
      <input
        autoFocus
        value={name}
        aria-label="Column name"
        placeholder={adding ? "New column name" : "Column name"}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          else if (event.key === "Escape") onClose();
        }}
        className="h-7 w-full rounded bg-content/8 px-2 text-[12px] text-content outline-none focus:ring-1 focus:ring-accent/50"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!name.trim()}
          className="h-7 flex-1 rounded-md bg-accent/15 text-[12px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
          onClick={submit}
        >
          {adding ? "Add column" : "Rename"}
        </button>
        {deletable ? (
          <button
            type="button"
            aria-label={`Delete column ${column.label}`}
            className="grid h-7 w-9 place-items-center rounded-md text-red-300/80 hover:bg-red-400/10 hover:text-red-300"
            onClick={() => {
              removeColumn(column.id, target || undefined);
              onClose();
            }}
          >
            <Trash2 className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {deletable && cardCount > 0 ? (
        <div className="mt-1.5 border-t border-content/8 pt-1.5">
          <p className="px-0.5 pb-1 text-[10px] text-content/45">
            Move {cardCount} {cardCount === 1 ? "card" : "cards"} to
          </p>
          <div role="radiogroup" aria-label="Move cards to" className="max-h-36 overflow-y-auto">
            {[
              { id: "", label: "Their status columns" },
              ...columns.filter((entry) => entry.id !== column.id),
            ].map((entry) => (
              <button
                key={entry.id || "auto"}
                type="button"
                role="radio"
                aria-checked={target === entry.id}
                className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] ${
                  target === entry.id
                    ? "bg-accent/12 text-content"
                    : "text-content/70 hover:bg-content/6 hover:text-content"
                }`}
                onClick={() => setTarget(entry.id)}
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    entry.id ? columnDot(entry.id) : "border border-content/40"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {!adding ? (
        <button
          type="button"
          className="mt-1 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[12px] text-content/50 hover:bg-content/8 hover:text-content"
          onClick={() => {
            setAdding(true);
            setName("");
          }}
        >
          <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
          New column
        </button>
      ) : null}
      {!adding && !deletable ? (
        <p className="mt-1.5 px-0.5 text-[10px] text-content/35">
          Built-in columns can't be removed.
        </p>
      ) : null}
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
