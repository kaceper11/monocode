import { WslBadge } from "./WslBadge";
import { dropVerifyForProject } from "../lib/verify";
import {
  Archive,
  BellOff,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  GitBranch,
  GitPullRequest,
  ImagePlus,
  Inbox,
  MoreHorizontal,
  Pin,
  PinOff,
  File,
  Plus,
  Search,
  SquarePlus,
  Task,
  Settings,
  Terminal,
  Trash2,
  Zap,
} from "./icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  probeRepositoryFamily,
  useRepositoryFamilies,
} from "../hooks/useRepositoryFamilies";
import {
  groupRailProjectsByMembership,
  loadProjects,
  projectContainsPath,
  projectsSnapshot,
  recordProjectLastPath,
  repositoryDisplayName,
  subscribeProjects,
  deleteProject,
  familyForRepository,
  projectRailKey,
  isProjectRailKey,
  renameProject,
  type ProjectRecord,
} from "../lib/projects";
import { ProjectRepositories } from "./ProjectRepositories";
import {
  groupRepositoryFamilies,
  workingCopyName,
  workingCopyAge,
  lastWorkingCopyUse,
  hiddenWorkingCopies,
  hiddenWorkingCopiesSnapshot,
  setWorkingCopyHidden,
  subscribeWorkingCopyPreferences,
  type RepositoryFamily,
  type WorkingCopy,
} from "../lib/repositoryFamilies";
import { copyText } from "../lib/clipboard";
import { openWorktreeManager } from "../lib/worktreeRemoval";
import { useDragResize } from "../hooks/useDragResize";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import {
  diffStatsVersion,
  peekProjectDiffStats,
  subscribeDiffStatsVersion,
  useProjectDiffStats,
} from "../hooks/useProjectDiffStats";
import {
  branchPrVersion,
  cachedBranchPr,
  subscribeBranchPrVersion,
} from "../hooks/useBranchPr";
import {
  peekWorktreeCollision,
  subscribeWorktreeCollisionVersion,
  worktreeCollisionVersion,
} from "../hooks/useWorktreeCollisions";
import { useAnimatedReorder } from "../hooks/useAnimatedReorder";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import {
  loadProjectRailWidth,
  PROJECT_RAIL_WIDTH_DEFAULT,
  PROJECT_RAIL_WIDTH_MAX,
  PROJECT_RAIL_WIDTH_MIN,
  saveProjectRailWidth,
} from "../lib/appearance";
import { basename, revealPath, type GitDiffStats } from "../lib/fs";
import { IS_MAC, IS_WIN, MOD } from "../lib/platform";
import {
  pathKey,
  prettyCwd,
  projectKey,
  projectName,
  wslLocation,
} from "../lib/paths";
import {
  collectRailProjects,
  loadPinnedProjects,
  loadRecents,
  loadProjectRailOrder,
  projectRailSections,
  sameProjectPath,
  savePinnedProjects,
  saveProjectRailOrder,
  syncProjectRailOrder,
  subscribeRemovedWorktree,
  type RecentProject,
} from "../lib/recents";
import type { RailProjectItem } from "../lib/projects";
import {
  TAB_GROUP_COLORS,
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupColorIndex,
  resolveTabGroupCustomColor,
  resolveTabGroupLabel,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
  saveTabGroupColor,
  saveTabGroupCustomColor,
  saveTabGroupLabel,
  saveTabGroupMascot,
  tabGroupColor,
} from "../lib/tabGroups";
import {
  createProjectGroup,
  loadProjectGroupAssignments,
  loadProjectGroups,
  projectGroupIdForPath,
  saveProjectGroupAssignments,
  saveProjectGroups,
  type ProjectGroup,
} from "../lib/projectGroups";
import type { LiveAgent } from "../lib/liveAgents";
import { LiveAgentsPreview } from "./LiveAgentsPreview";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { ProjectBackgroundDialog } from "./ProjectBackgroundDialog";
import { ProjectMascot } from "./ProjectMascot";
import { RailAction, RailSearch } from "./RailAction";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DevModeSlot, TabVisitNav } from "./TitleBar";
import { SidebarUpdateFooter } from "./SidebarUpdate";
import type { InstalledUpdate } from "../lib/updateNotice";
import { SettingsNav } from "./SettingsRail";
import { Shimmer } from "../surfaces/Shimmer";
import { TabGroupMenu, type TabGroupMenuExtraItem } from "./TabGroupMenu";
import { TerminalSpinner } from "./TerminalSpinner";
import { WorktreeCollisionBadge } from "./WorktreeCollisionBadge";
import { ExplorerMenu, type ExplorerMenuItem } from "./ExplorerMenu";
import { TaskWorktreesSheet } from "./TaskWorktreesSheet";
import { WorktreePanel } from "./WorktreePicker";
import {
  archiveTask,
  OPEN_TASK_DETAILS,
  repositoryForChild,
  subscribeTaskWorkspaces,
  taskChildPrepared,
  taskChildrenForWorkingCopy,
  taskForSession,
  taskMatchesQuery,
  taskSessionIds,
  liveTaskSessionIds,
  taskWorkspacesSnapshot,
  loadTaskWorkspaces,
  projectForTask,
  type TaskChild,
  type TaskWorkspace,
} from "../lib/taskWorkspaces";
import {
  childDelivery,
  taskDeliveryOverview,
  taskStatusSegments,
  type DeliveryStores,
  type TaskChildDelivery,
} from "../lib/taskDelivery";
import type { TaskDeliveryRef } from "../lib/taskCi";
import {
  linkedWorkItemUpdateKey,
  type LinkedSessionUpdate,
} from "../lib/linkedSessionUpdates";
import { OPEN_INBOX_WORK_ITEM } from "../lib/sessionWorkItem";
import { InboxProviderMark } from "./InboxProviderMark";
import { useDeliveryStores } from "../hooks/useDeliveryStores";
import type { SettingsSectionId } from "../lib/settings";
import {
  knownNotificationProject,
  type NotificationProject,
} from "../lib/notificationProjects";
import { NotificationMuteDatePicker } from "./NotificationMuteDatePicker";
import { Popover } from "./Popover";
import { InboxNotificationMenu } from "./InboxNotificationMenu";
import { notificationMuteActions, notificationMuteDeadline, notificationMuteStatus } from "./notificationMuteActions";
import { useProjectNotificationPreferences } from "../hooks/useProjectNotificationPreferences";
import { useNotificationProjects } from "../hooks/useNotificationProjects";
import { updateNotificationPreferences } from "../lib/notificationPreferences";

const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : IS_WIN
    ? "Reveal in File Explorer"
    : "Open Containing Folder";

function projectMenuExtraItems(
  pinned: boolean,
  canRemove: boolean,
  hasFolder: boolean,
  canConfigureNotifications: boolean,
  notificationReady: boolean,
  projectGroups: ProjectGroup[],
  currentProjectGroupId?: string,
): TabGroupMenuExtraItem[] {
  const groupSubmenu: ExplorerMenuItem[] = [
    { kind: "item", id: "project-group:new", label: "New group…" },
    ...(projectGroups.length > 0 ? [{ kind: "sep" } as const] : []),
    ...projectGroups.map((group) => ({
      kind: "item" as const,
      id: `project-group:${group.id}`,
      label: group.name,
      checked: group.id === currentProjectGroupId,
    })),
    ...(projectGroups.length > 0 ? [{ kind: "sep" } as const] : []),
    {
      kind: "item",
      id: "project-group:none",
      label: "Ungrouped",
      checked: currentProjectGroupId == null,
    },
  ];
  const items: TabGroupMenuExtraItem[] = [
    {
      id: "new-task",
      label: "New task…",
      icon: SquarePlus,
    },
    {
      id: "repositories",
      label: "Project repositories…",
      icon: FolderTree,
    },
    {
      id: "commands",
      label: "Commands…",
      icon: Terminal,
    },
    {
      id: "background",
      label: "Background image",
      icon: ImagePlus,
    },
    {
      id: "project-group",
      label: "Move to group",
      icon: FolderTree,
      submenu: groupSubmenu,
    },
    pinned
      ? { id: "unpin", label: "Unpin project", icon: PinOff }
      : { id: "pin", label: "Pin project", icon: Pin },
    ...(hasFolder
      ? [{ id: "reveal", label: REVEAL_LABEL, icon: FolderOpen }]
      : []),
    {
      id: "notifications-mute",
      label: "Mute notifications",
      icon: BellOff,
      sepBefore: true,
      disabled: !notificationReady,
      submenu: notificationMuteActions(),
    },
  ];
  if (canConfigureNotifications) {
    items.push({
      id: "notifications-settings",
      label: "Notification settings…",
      icon: Settings,
    });
  }
  if (canRemove) {
    items.push(
      { id: "archive", label: "Archive", icon: Archive, sepBefore: true },
      { id: "delete", label: "Delete", icon: Trash2, danger: true },
    );
  }
  return items;
}

/** Provider state strings differ in case — GitHub shouts, Jira/Azure don't. */
function overviewStatus(value: string): string {
  const trimmed = value.trim();
  return trimmed && trimmed === trimmed.toUpperCase()
    ? trimmed.toLowerCase()
    : trimmed;
}

function OverviewChip({
  tone = "muted",
  title,
  onClick,
  children,
}: {
  tone?: "muted" | "amber" | "red";
  title?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const colors =
    tone === "red"
      ? "border-red-400/30 text-red-400"
      : tone === "amber"
        ? "border-amber-400/30 text-amber-400"
        : "border-content/10 text-content/60";
  const className = `flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none ${colors}`;
  if (!onClick) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      role="menuitem"
      title={title}
      onClick={onClick}
      className={`${className} hover:bg-content/8 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent`}
    >
      {children}
    </button>
  );
}

/**
 * Compact status strip at the top of a task's rail menu — the linked
 * ticket's inbox state plus delivery/waiting badges, each a quick action
 * into the surface that owns it. Saved provider links and cache peeks only;
 * the menu never fetches.
 */
function TaskMenuOverview({
  task,
  needsInputIds,
  liveIds,
  linkedItemUpdates,
  onOpenTask,
  onOpenDetails,
  onOpenDelivery,
}: {
  task: TaskWorkspace;
  needsInputIds?: ReadonlySet<string>;
  liveIds?: ReadonlySet<string>;
  /** Remote snapshots of linked tickets that changed — keyed by
   * `linkedWorkItemUpdateKey`. */
  linkedItemUpdates?: ReadonlyMap<string, LinkedSessionUpdate>;
  onOpenTask?: () => void;
  onOpenDetails?: () => void;
  onOpenDelivery?: (child: TaskChild, ref: TaskDeliveryRef) => void;
}) {
  const stores = useDeliveryStores();
  const statsV = useSyncExternalStore(
    subscribeDiffStatsVersion,
    diffStatsVersion,
  );
  const prV = useSyncExternalStore(subscribeBranchPrVersion, branchPrVersion);
  const overview = useMemo(
    () =>
      taskDeliveryOverview(
        task,
        (child) => {
          const branch =
            peekProjectDiffStats(child.workingCopy!)?.branch ?? child.branch;
          return {
            branches: [branch, child.branch],
            githubPr: cachedBranchPr(child.workingCopy!, branch),
          };
        },
        stores,
      ),
    // statsV/prV only tick the caches — the peeks re-read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task, stores, statsV, prV],
  );

  const tickets = task.ticket
    ? [task.ticket, ...(task.ticket.additionalItems ?? [])]
    : [];
  const ticket = tickets[0];
  const ticketUpdate = ticket
    ? tickets
        .map((item) => linkedItemUpdates?.get(linkedWorkItemUpdateKey(item)))
        .find(Boolean)
    : undefined;
  const ticketStatus = ticketUpdate
    ? overviewStatus(
        ticketUpdate.item.attentionReason ??
          ticketUpdate.item.stateType ??
          ticketUpdate.item.state ??
          "",
      )
    : "";
  const waiting = [
    ...(liveIds ? liveTaskSessionIds(task, liveIds) : taskSessionIds(task)),
  ].filter((id) => needsInputIds?.has(id)).length;

  if (!ticket && !overview.prs && !overview.ci && !waiting) return null;
  const openDelivery =
    (target: { child: TaskChild; ref: TaskDeliveryRef } | undefined) => () =>
      target && onOpenDelivery
        ? onOpenDelivery(target.child, target.ref)
        : onOpenDetails?.();
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-content/10 px-2.5 py-2">
      {ticket ? (
        <OverviewChip
          tone={ticketUpdate ? "amber" : "muted"}
          title={ticketUpdate?.item.title ?? ticket.title ?? ticket.url}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(OPEN_INBOX_WORK_ITEM, { detail: ticket }),
            )
          }
        >
          <InboxProviderMark
            provider={ticket.provider ?? "github"}
            className="size-3 shrink-0"
          />
          {ticket.identifier || `#${ticket.number}`}
          {ticketStatus ? ` · ${ticketStatus}` : ""}
          {tickets.length > 1 ? ` +${tickets.length - 1}` : ""}
        </OverviewChip>
      ) : null}
      {overview.prs ? (
        <OverviewChip
          tone={overview.prAttention ? "red" : "muted"}
          title={
            overview.prAttention
              ? "A pull request needs the author — open its review"
              : "Open the pull request review"
          }
          onClick={openDelivery(overview.prTarget)}
        >
          <GitPullRequest className="size-3 shrink-0" strokeWidth={1.75} />
          {overview.prs > 1 ? `${overview.prs} PRs` : "PR"}
          {overview.prAttention ? " · needs review" : ""}
        </OverviewChip>
      ) : null}
      {overview.ci ? (
        <OverviewChip
          tone={
            overview.ciFailing ? "red" : overview.ciRunning ? "amber" : "muted"
          }
          title={
            overview.ciFailing
              ? "A linked pipeline failed — open its review"
              : overview.ciRunning
                ? "A linked pipeline is running — open its review"
                : "Open the pipeline review"
          }
          onClick={openDelivery(overview.ciTarget)}
        >
          <CircleDashed className="size-3 shrink-0" strokeWidth={1.75} />
          {overview.ci > 1 ? `${overview.ci} CI` : "CI"}
          {overview.ciFailing
            ? " · failing"
            : overview.ciRunning
              ? " · running"
              : ""}
        </OverviewChip>
      ) : null}
      {waiting ? (
        <OverviewChip
          tone="amber"
          title="A conversation in this task is waiting on you"
          onClick={onOpenTask}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
          {waiting === 1 ? "1 waiting" : `${waiting} waiting`}
        </OverviewChip>
      ) : null}
    </div>
  );
}

type Props = {
  cwd: string;
  recents: RecentProject[];
  inboxUnseen?: boolean;
  busyPaths?: Iterable<string>;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onSearch?: () => void;
  searchActive?: boolean;
  onOpenInbox?: () => void;
  inboxActive?: boolean;
  /** Attention queue (#76) — count badge on the rail row; the click anchors
   * the popover to the button. */
  attentionCount?: number;
  queueActive?: boolean;
  onOpenQueue?: (anchor: HTMLElement) => void;
  notesEnabled?: boolean;
  onOpenNotes?: () => void;
  notesActive?: boolean;
  onTogglePanel?: () => void;
  onSelectProject: (path: string) => void;
  onOpenProject: () => void;
  onNewTask?: (path: string, projectId?: string) => void;
  /** Opens the saved-commands menu. `taskId` scopes resolution to that task's
   * working copies; `path`/`projectId` identify the owning project. */
  onOpenCommands?: (options: {
    anchor: { x: number; y: number };
    path?: string;
    projectId?: string;
    taskId?: string;
  }) => void;
  onOpenTask?: (taskId: string) => void;
  /** Explicitly launches pending/failed children — heavier than opening,
   * so it stays behind the row's menu rather than the row click. */
  onStartTask?: (taskId: string) => void;
  /** Just-created task — highlighted as current until a task session takes
   * over. Purely presentational; never launches work. */
  focusTaskId?: string;
  onEditTask?: (taskId: string) => void;
  onCreateTaskPrs?: (taskId: string) => void;
  /** Bulk merge of the remote default into every linked working copy —
   * conflicts route to each copy's owning agent. */
  onSyncTaskBranches?: (taskId: string) => void;
  /** Sessions currently needing input (approval or question) — per-child dots. */
  needsInputSessionIds?: ReadonlySet<string>;
  /** Every resolvable session id — task "N conversations" labels count
   * these, never stale task records. */
  liveSessionIds?: ReadonlySet<string>;
  /** Remote snapshots of linked tickets that changed — the task menu's
   * inbox-item status chip. Keyed by `linkedWorkItemUpdateKey`. */
  linkedItemUpdates?: ReadonlyMap<string, LinkedSessionUpdate>;
  /** Opens a child's PR/CI review inside the task's conversation. */
  onOpenTaskDelivery?: (
    task: TaskWorkspace,
    child: TaskChild,
    ref: TaskDeliveryRef,
  ) => void;
  onRemoveProject?: (path: string, options: { purgeData: boolean }) => void;
  liveAgents?: LiveAgent[];
  activeSessionId?: string;
  onSelectAgent?: (sessionId: string) => void;
  settingsOpen?: boolean;
  settingsSection?: SettingsSectionId;
  onOpenSettings?: () => void;
  onOpenNotificationSettings?: (projectPath?: string) => void;
  onSelectSettingsSection?: (section: SettingsSectionId) => void;
  onCloseSettings?: () => void;
  updateNotice?: InstalledUpdate | null;
  onOpenWhatsNew?: (version: string) => void;
  onDismissUpdate?: () => void;
};

export function ProjectRail({
  cwd,
  recents,
  inboxUnseen = false,
  busyPaths,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onSearch,
  searchActive = false,
  onOpenInbox,
  inboxActive = false,
  attentionCount = 0,
  queueActive = false,
  onOpenQueue,
  notesEnabled = true,
  onOpenNotes,
  notesActive = false,
  onTogglePanel,
  onSelectProject,
  onOpenProject,
  onNewTask,
  onOpenCommands,
  onOpenTask,
  onStartTask,
  focusTaskId,
  onEditTask,
  onCreateTaskPrs,
  onSyncTaskBranches,
  needsInputSessionIds,
  liveSessionIds,
  linkedItemUpdates,
  onOpenTaskDelivery,
  onRemoveProject,
  liveAgents = [],
  activeSessionId,
  onSelectAgent,
  settingsOpen = false,
  settingsSection = "general",
  onOpenSettings,
  onOpenNotificationSettings,
  onSelectSettingsSection,
  onCloseSettings,
  updateNotice = null,
  onOpenWhatsNew,
  onDismissUpdate,
}: Props) {
  const resize = useDragResize({
    min: PROJECT_RAIL_WIDTH_MIN,
    max: () =>
      Math.min(PROJECT_RAIL_WIDTH_MAX, Math.floor(window.innerWidth * 0.35)),
    defaultWidth: PROJECT_RAIL_WIDTH_DEFAULT,
    initial: loadProjectRailWidth(),
    onCommit: saveProjectRailWidth,
  });
  const [railOrder, setRailOrder] = useState(loadProjectRailOrder);
  const [pinnedPaths, setPinnedPaths] = useState(loadPinnedProjects);
  useEffect(
    () =>
      subscribeRemovedWorktree(() => {
        setRailOrder(loadProjectRailOrder());
        setPinnedPaths(loadPinnedProjects());
      }),
    [],
  );
  const [groupLabels, setGroupLabels] = useState(loadTabGroupLabels);
  const [groupColors, setGroupColors] = useState(loadTabGroupColors);
  const [groupMascots, setGroupMascots] = useState(loadTabGroupMascots);
  const [groupCustomColors, setGroupCustomColors] = useState(
    loadTabGroupCustomColors,
  );
  const [projectGroups, setProjectGroups] = useState(loadProjectGroups);
  const [projectGroupAssignments, setProjectGroupAssignments] = useState(
    loadProjectGroupAssignments,
  );
  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    path: string;
    projectKey: string;
    projectId?: string;
    /** Right-clicked row — anchors follow-up popovers to the project itself. */
    rowRect?: DOMRect;
  } | null>(null);
  const [repositoriesProject, setRepositoriesProject] = useState<{
    path: string;
    projectId?: string;
    /** Import flow — the sheet queues repositories and creates the group only
     * on submit; nothing lands in the rail before that. */
    groupImport?: boolean;
    /** Launch the folder picker as soon as the sheet opens. */
    autoPick?: boolean;
  } | null>(null);
  const [taskMenu, setTaskMenu] = useState<{
    x: number;
    y: number;
    task: TaskWorkspace;
    /** Right-clicked row — anchors follow-up popovers to the task itself. */
    rowRect?: DOMRect;
  } | null>(null);
  // Delete goes through the worktree sheet — it can offer cleanup of the
  // task's own working copies in the same flow.
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );

  /** Task owning the focused session. */
  const activeTask = useMemo(
    () => (activeSessionId ? taskForSession(activeSessionId)?.task : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, tasksRaw],
  );
  // A just-armed task (created or explicitly opened) wins while the user is
  // still looking at another task's session; otherwise the focused
  // session's task is current.
  const currentTaskId = focusTaskId ?? activeTask?.id;
  const busySessionIds = useMemo(
    () =>
      new Set(
        liveAgents.filter((agent) => !agent.done).map((agent) => agent.id),
      ),
    [liveAgents],
  );
  const taskBusyIds = useMemo(() => {
    const set = new Set<string>();
    for (const task of loadTaskWorkspaces()) {
      if (task.archived) continue;
      if ([...taskSessionIds(task)].some((id) => busySessionIds.has(id)))
        set.add(task.id);
    }
    return set;
    // tasksRaw changes on every store write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksRaw, busySessionIds]);
  const railTasks = useMemo(() => {
    const live = loadTaskWorkspaces().filter((task) => !task.archived);
    // Stable newest-first order — selecting or working on a task must not
    // move its row; state shows through the row's indicators instead.
    return [...live].sort((a, b) => b.createdAt - a.createdAt);
    // tasksRaw changes on every store write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksRaw]);
  const archivedTasks = useMemo(
    () =>
      loadTaskWorkspaces()
        .filter((task) => task.archived)
        .sort((a, b) => b.createdAt - a.createdAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasksRaw],
  );
  const taskBySessionId = useMemo(() => {
    const map = new Map<string, { task: TaskWorkspace; child: TaskChild }>();
    for (const agent of liveAgents) {
      const scope = taskForSession(agent.id);
      if (scope) map.set(agent.id, scope);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksRaw, liveAgents]);
  const [projectGroupMenu, setProjectGroupMenu] = useState<{
    x: number;
    y: number;
    id: string;
  } | null>(null);
  const [notificationMenu, setNotificationMenu] = useState<{
    x: number;
    y: number;
    path: string;
    project: NotificationProject;
  } | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const notificationPreferences = useProjectNotificationPreferences();
  const notificationPath = projectMenu?.path;
  const readyNotificationProject = notificationPath
    ? knownNotificationProject(notificationPath)
    : undefined;
  const notificationMenuError = notificationError;
  const menuMuteStatus = readyNotificationProject
    ? notificationMuteStatus(notificationPreferences[readyNotificationProject.id])
    : null;
  useEffect(() => {
    setNotificationError(null);
  }, [notificationPath]);
  const [inboxMenu, setInboxMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const [removing, setRemoving] = useState<{
    path: string;
    name: string;
    projectId?: string;
  } | null>(null);
  const [backgroundProject, setBackgroundProject] = useState<{
    project: string;
    name: string;
  } | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const groupLogos = useTabGroupLogos();
  const projectsRaw = useSyncExternalStore(subscribeProjects, projectsSnapshot);
  const storedProjects = useMemo(() => loadProjects(), [projectsRaw]);
  const allProjects = useMemo(() => {
    const map = collectRailProjects(recents, cwd);
    // Stored projects keep a rail row from their anchor even when no member
    // path is a recent; the anchor keys order, pins and appearance.
    for (const project of storedProjects) {
      const key = pathKey(project.anchor ?? projectRailKey(project.id));
      if (!map.has(key))
        map.set(key, {
          path: project.anchor ?? projectRailKey(project.id),
          openedAt: 0,
        });
    }
    return map;
  }, [cwd, recents, storedProjects]);
  const rawSections = useMemo(
    () =>
      projectRailSections(
        recents,
        cwd,
        railOrder,
        pinnedPaths,
        new Map(),
        storedProjects,
      ),
    [cwd, pinnedPaths, railOrder, recents, storedProjects],
  );
  const families = useRepositoryFamilies(recents, cwd);
  const notificationProjects = useNotificationProjects([...allProjects.keys()]);
  const muteStatuses = new Map<string, string | null>();
  for (const project of notificationProjects.projects) {
    const status = notificationMuteStatus(notificationPreferences[project.id]);
    for (const path of project.paths) muteStatuses.set(pathKey(path), status);
  }
  const sections = useMemo(
    () =>
      groupRailProjectsByMembership(
        groupRepositoryFamilies(rawSections, families),
        families,
        storedProjects,
      ),
    [rawSections, families, storedProjects],
  );

  // Reopening a project lands on the working copy the user last left it in.
  useEffect(() => {
    if (cwd) recordProjectLastPath(cwd, families);
  }, [cwd, families]);

  const groupedProjectSections = useMemo(() => {
    const byGroup = new Map<string, RailProjectItem[]>(
      projectGroups.map((group) => [group.id, []]),
    );
    const ungrouped: RailProjectItem[] = [];
    for (const project of sections.projects) {
      const groupId = projectGroupIdForPath(
        project.path,
        projectGroupAssignments,
      );
      const items = groupId ? byGroup.get(groupId) : undefined;
      if (items) items.push(project);
      else ungrouped.push(project);
    }
    return {
      ungrouped,
      grouped: projectGroups.map((group) => ({
        group,
        items: byGroup.get(group.id) ?? [],
      })),
    };
  }, [projectGroupAssignments, projectGroups, sections.projects]);
  const busy = useMemo(() => {
    const set = new Set<string>();
    for (const path of busyPaths ?? []) set.add(path);
    return set;
  }, [busyPaths]);

  useEffect(() => {
    setRailOrder((prev) => {
      const synced = syncProjectRailOrder(prev, allProjects);
      if (synced.join("\0") === prev.join("\0")) return prev;
      saveProjectRailOrder(synced);
      return synced;
    });
  }, [allProjects]);

  useEffect(() => {
    setPinnedPaths((prev) => {
      const next = prev.filter((path) => allProjects.has(path));
      if (next.length === prev.length) return prev;
      savePinnedProjects(next);
      return next;
    });
  }, [allProjects]);

  useEffect(() => {
    if (!projectMenu) return;
    const onScroll = () => setProjectMenu(null);
    const scrollParent = scrollRef.current ?? window;
    scrollParent.addEventListener("scroll", onScroll, true);
    return () => scrollParent.removeEventListener("scroll", onScroll, true);
  }, [projectMenu]);

  const openProjectMenu = (
    item: RailProjectItem,
    x: number,
    y: number,
    rowRect?: DOMRect,
  ) => {
    menuTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInboxMenu(null);
    setNotificationMenu(null);
    setProjectMenu({
      x,
      y,
      path: item.path,
      projectKey: projectKey(item.path),
      projectId: item.project?.id,
      rowRect,
    });
  };

  const onProjectContextMenu = (
    item: RailProjectItem,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
    openProjectMenu(
      item,
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );
  };

  const openTaskMenu = (
    task: TaskWorkspace,
    x: number,
    y: number,
    rowRect?: DOMRect,
  ) => {
    setTaskMenu({ task, x, y, rowRect });
  };

  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);

  const closeAddMenu = () => setAddMenu(null);

  /** A pathless project — a pure group. The sheet queues repositories and
   * materializes the group on the first submit, so an abandoned setup never
   * leaves an empty project row behind. */
  const submitGroup = () => {
    setRepositoriesProject({ path: "", groupImport: true });
  };

  const onProjectRename = (groupId: string, label: string) => {
    const projectId = projectMenu?.projectId;
    if (projectId) {
      renameProject(projectId, label);
      return;
    }
    saveTabGroupLabel(groupId, label);
    setGroupLabels(loadTabGroupLabels());
  };

  const onProjectColorChange = (
    projectKey: string,
    colorIndex: number | null,
  ) => {
    saveTabGroupColor(projectKey, colorIndex);
    setGroupColors(loadTabGroupColors());
    setGroupCustomColors(loadTabGroupCustomColors());
  };

  const onProjectMascotChange = (projectKey: string, name: string | null) => {
    saveTabGroupMascot(projectKey, name);
    setGroupMascots(loadTabGroupMascots());
  };

  const onProjectCustomColorChange = (projectKey: string, color: string) => {
    saveTabGroupCustomColor(projectKey, color);
    setGroupColors(loadTabGroupColors());
    setGroupCustomColors(loadTabGroupCustomColors());
  };

  const saveProjectGroupList = (next: ProjectGroup[]) => {
    if (!saveProjectGroups(next)) return false;
    setProjectGroups(next);
    return true;
  };

  const updateProjectGroup = (
    id: string,
    update: (group: ProjectGroup) => ProjectGroup,
  ) => {
    const current = loadProjectGroups();
    if (!current.some((group) => group.id === id)) return;
    const next = current.map((group) =>
      group.id === id ? update(group) : group,
    );
    saveProjectGroupList(next);
  };

  const assignProjectGroup = (path: string, groupId: string | null) => {
    const next = { ...loadProjectGroupAssignments() };
    const key = pathKey(path);
    if (groupId == null) delete next[key];
    else next[key] = groupId;
    if (!saveProjectGroupAssignments(next)) return false;
    setProjectGroupAssignments(next);
    return true;
  };

  const createGroup = (x: number, y: number, projectPath?: string) => {
    const current = loadProjectGroups();
    const group = createProjectGroup(current);
    if (!saveProjectGroupList([...current, group])) return;
    if (projectPath) assignProjectGroup(projectPath, group.id);
    if (!projectPath) {
      menuTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    setProjectGroupMenu({ x, y, id: group.id });
  };

  const deleteGroup = (id: string) => {
    const nextGroups = loadProjectGroups().filter((group) => group.id !== id);
    if (!saveProjectGroupList(nextGroups)) return false;
    const nextAssignments = loadProjectGroupAssignments(nextGroups);
    saveProjectGroupAssignments(nextAssignments);
    setProjectGroupAssignments(nextAssignments);
    return true;
  };

  const reorderSubset = (
    fullOrder: string[],
    subsetOrder: string[],
    subsetPaths: Set<string>,
  ) => {
    const next: string[] = [];
    let subsetIndex = 0;
    for (const path of fullOrder) {
      if (!subsetPaths.has(path)) {
        next.push(path);
        continue;
      }
      if (subsetIndex < subsetOrder.length) {
        next.push(subsetOrder[subsetIndex++]);
      }
    }
    return next;
  };

  const onReorderPinned = (ids: string[]) => {
    const subset = new Set(sections.pinned.map((item) => item.path));
    const next = reorderSubset(railOrder, ids, subset);
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  const onReorderProjects = (ids: string[]) => {
    const subset = new Set(ids);
    const next = reorderSubset(railOrder, ids, subset);
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  /** Recent paths whose verified family belongs to the project — the paths the
   * rail actually lists for it. */
  const memberRecentPaths = (project: ProjectRecord) =>
    recents
      .filter((item) => projectContainsPath(project, item.path, families))
      .map((item) => item.path);

  /** Every normalized key a grouped row can be pinned under — its row path,
   * the project anchor and sentinel key, member repository anchors and member
   * recents. A pin stored against any of them must resolve, or a member-pinned
   * row offers "Pin project" again with no way to unpin. */
  const pinKeys = (path: string, project?: ProjectRecord) => {
    const keys = new Set([pathKey(path)]);
    if (project) {
      if (project.anchor) keys.add(pathKey(project.anchor));
      keys.add(pathKey(projectRailKey(project.id)));
      for (const repo of project.repositories)
        if (repo.anchor) keys.add(pathKey(repo.anchor));
      for (const member of memberRecentPaths(project))
        keys.add(pathKey(member));
    }
    return keys;
  };

  const isRowPinned = (path: string, project?: ProjectRecord) => {
    const keys = pinKeys(path, project);
    return pinnedPaths.some((pinned) => keys.has(pathKey(pinned)));
  };

  const onTogglePin = (path: string, project?: ProjectRecord) => {
    const keys = pinKeys(path, project);
    const isPinned = pinnedPaths.some((pinned) => keys.has(pathKey(pinned)));
    const next = isPinned
      ? pinnedPaths.filter((pinned) => !keys.has(pathKey(pinned)))
      : [...pinnedPaths, path];
    setPinnedPaths(next);
    savePinnedProjects(next);
  };

  const menuProject = projectMenu?.projectId
    ? storedProjects.find((entry) => entry.id === projectMenu.projectId)
    : undefined;

  const removeProjectEntry = (
    path: string,
    projectId: string | undefined,
    purgeData: boolean,
  ) => {
    const project = projectId
      ? storedProjects.find((entry) => entry.id === projectId)
      : undefined;
    if (!project) {
      onRemoveProject?.(path, { purgeData });
      return;
    }
    // Removing the project removes its rail rows and record — member
    // checkouts, worktrees, branches and credentials stay on disk. Purge still
    // applies the existing per-path session cleanup.
    deleteProject(project.id);
    // Tasks bound to the deleted record would be orphaned — they could no
    // longer resolve a project (no edit, no relaunch, no repo inventory).
    // Archive instead of deleting so their worktree/cleanup records survive;
    // recreating the project restores access via unarchive.
    for (const task of loadTaskWorkspaces()) {
      if (task.projectId === project.id && !task.archived)
        archiveTask(task.id, true);
    }
    dropVerifyForProject(project.id);
    const members = memberRecentPaths(project);
    for (const member of members) onRemoveProject?.(member, { purgeData });
    if (!members.includes(path) && !isProjectRailKey(path))
      onRemoveProject?.(path, { purgeData });
  };

  const onProjectMenuPick = (action: string) => {
    if (!projectMenu) return;
    const { path, projectKey, projectId } = projectMenu;
    const displayName =
      menuProject?.name ??
      resolveTabGroupLabel(
        projectKey,
        groupLabels,
        isProjectRailKey(path) ? "Project" : basename(path),
      );
    if (action === "project-group:new") {
      createGroup(projectMenu.x, projectMenu.y, path);
    } else if (action === "project-group:none") {
      assignProjectGroup(path, null);
    } else if (action.startsWith("project-group:")) {
      const groupId = action.slice("project-group:".length);
      if (projectGroups.some((group) => group.id === groupId)) {
        assignProjectGroup(path, groupId);
      }
    } else if (action === "mute:custom") {
      if (!readyNotificationProject) return false;
      setNotificationMenu({ ...projectMenu, project: readyNotificationProject });
    } else if (action.startsWith("mute:") || action === "notifications-resume") {
      if (!readyNotificationProject) return false;
      const mutedUntil = notificationMuteDeadline(action);
      if (action !== "notifications-resume" && mutedUntil === undefined) return false;
      try {
        updateNotificationPreferences([readyNotificationProject.id], { mutedUntil });
      } catch {
        setNotificationError("Could not save notification preferences. Please try again.");
        return false;
      }
    } else if (action === "notifications-settings") {
      onOpenNotificationSettings?.(path);
    } else if (action === "pin" || action === "unpin") onTogglePin(path, menuProject);
    else if (action === "new-task") onNewTask?.(path, projectId);
    else if (action === "commands") {
      onOpenCommands?.({
        // Anchor to the right-clicked row — it stays mounted, so the popover
        // reads as attached to the project rather than floating where the
        // dismissed context menu item happened to be.
        anchor: projectMenu.rowRect
          ? { x: projectMenu.rowRect.right, y: projectMenu.rowRect.top }
          : { x: projectMenu.x, y: projectMenu.y },
        path: isProjectRailKey(path) ? undefined : path,
        projectId,
      });
    } else if (action === "repositories") {
      setRepositoriesProject({ path, projectId });
    } else if (action === "background") {
      setBackgroundProject({
        project: projectKey,
        name: displayName,
      });
    } else if (action === "reveal") {
      if (!isProjectRailKey(path)) void revealPath(path);
    } else if (action === "archive") {
      removeProjectEntry(path, projectId, false);
    } else if (action === "delete") {
      setRemoving({ path, name: displayName, projectId });
    }
  };

  const onConfirmDelete = () => {
    if (!removing) return;
    assignProjectGroup(removing.path, null);
    removeProjectEntry(removing.path, removing.projectId, true);
    setRemoving(null);
  };

  const pinnedIds = sections.pinned.map((item) => item.path);
  const projectIds = groupedProjectSections.ungrouped.map((item) => item.path);
  const pinnedSortable = useAnimatedReorder(pinnedIds, onReorderPinned, "y");
  const projectSortable = useAnimatedReorder(projectIds, onReorderProjects, "y");
  return (
    <nav
      ref={resize.setPaneRef}
      aria-label="Projects"
      className="sidebar-glass relative flex shrink-0 flex-col border-r border-stroke"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center pr-1.5"
        data-tauri-drag-region="deep"
      >
        {IS_MAC ? <div className="w-[78px] shrink-0" /> : null}
        <DevModeSlot />
        <TabVisitNav
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={onGoBack}
          onGoForward={onGoForward}
          onTogglePanel={settingsOpen ? undefined : onTogglePanel}
          panelActive
        />
      </div>

      {settingsOpen ? (
        <SettingsNav
          section={settingsSection}
          onSelect={(next) => onSelectSettingsSection?.(next)}
          onClose={() => onCloseSettings?.()}
        />
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-px px-2 pb-2 pt-0.5">
            <RailSearch
              label="Search"
              icon={Search}
              onClick={onSearch}
              active={searchActive}
              shortcut={`${MOD}K`}
              ariaLabel={`Search (${MOD}K)`}
            />
            <div className="mt-0.5" />
            <RailAction
              label="Inbox"
              icon={Inbox}
              onClick={onOpenInbox}
              onOpenContextMenu={(x, y) => {
                menuTrigger.current =
                  document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
                setProjectMenu(null);
                setNotificationMenu(null);
                setInboxMenu({ x, y });
              }}
              active={inboxActive}
              dot={inboxUnseen}
              ariaLabel={inboxUnseen ? "Inbox, new items" : "Inbox"}
            />
            {onOpenQueue ? (
              <RailAction
                label="Attention"
                icon={Zap}
                onClick={(event) => onOpenQueue(event.currentTarget)}
                active={queueActive}
                badge={attentionCount || undefined}
                ariaLabel={
                  attentionCount
                    ? `Attention queue, ${attentionCount} item${attentionCount === 1 ? "" : "s"}`
                    : "Attention queue"
                }
              />
            ) : null}
            {notesEnabled ? (
              <RailAction
                label="Notes"
                icon={File}
                onClick={onOpenNotes}
                active={notesActive}
                ariaLabel="Notes"
              />
            ) : null}
          </div>

          <div
            ref={(el) => {
              lockOverscroll(el);
              scrollRef.current = el;
            }}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none pb-2"
          >
            <TasksSection
              tasks={railTasks}
              archivedTasks={archivedTasks}
              currentTaskId={currentTaskId}
              busyIds={taskBusyIds}
              busySessionIds={busySessionIds}
              needsInputIds={needsInputSessionIds}
              onOpen={onOpenTask}
              onMenu={openTaskMenu}
              onNewTask={
                storedProjects.length
                  ? () => {
                      const current = storedProjects.find((project) =>
                        projectContainsPath(project, cwd, families),
                      );
                      const project = current ?? storedProjects[0];
                      onNewTask?.(
                        project.anchor ?? projectRailKey(project.id),
                        project.id,
                      );
                    }
                  : undefined
              }
            />
            {sections.pinned.length > 0 ? (
              <ProjectSection
                label="Pinned"
                items={sections.pinned}
                families={families}
                muteStatuses={muteStatuses}
                cwd={cwd}
                busy={busy}
                sortable={pinnedSortable}
                pinned
                searchActive={searchActive || inboxActive || notesActive}
                onSelect={onSelectProject}
                onTogglePin={onTogglePin}
                onContextMenu={onProjectContextMenu}
                onOpenMenu={openProjectMenu}
                groupLabels={groupLabels}
                groupColors={groupColors}
                groupCustomColors={groupCustomColors}
                groupLogos={groupLogos}
                groupMascots={groupMascots}
              />
            ) : null}

            {projectGroups.length > 0 ? (
              <div className="mb-2 shrink-0">
                <ProjectSectionHeader label="Groups" onAddGroup={createGroup} />
                <div className="flex flex-col gap-px px-2">
                  {groupedProjectSections.grouped.map(({ group, items }) => (
                    <ProjectGroupSection
                      key={group.id}
                      group={group}
                      items={items}
                      families={families}
                      muteStatuses={muteStatuses}
                      cwd={cwd}
                      busy={busy}
                      searchActive={searchActive || inboxActive || notesActive}
                      onSelect={onSelectProject}
                      onTogglePin={onTogglePin}
                      onContextMenu={onProjectContextMenu}
                      onOpenMenu={openProjectMenu}
                      onReorder={onReorderProjects}
                      onToggleCollapsed={() =>
                        updateProjectGroup(group.id, (current) => ({
                          ...current,
                          collapsed: !current.collapsed,
                        }))
                      }
                      onOpenGroupMenu={(x, y) => {
                        menuTrigger.current =
                          document.activeElement instanceof HTMLElement
                            ? document.activeElement
                            : null;
                        setProjectMenu(null);
                        setNotificationMenu(null);
                        setProjectGroupMenu({ x, y, id: group.id });
                      }}
                      groupLabels={groupLabels}
                      groupColors={groupColors}
                      groupCustomColors={groupCustomColors}
                      groupLogos={groupLogos}
                      groupMascots={groupMascots}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            <ProjectSection
              label="Projects"
              items={groupedProjectSections.ungrouped}
              families={families}
              muteStatuses={muteStatuses}
              emptyLabel={
                sections.projects.length === 0 && projectGroups.length === 0
                  ? "No projects yet"
                  : undefined
              }
              onAdd={(event) =>
                setAddMenu({ x: event.clientX, y: event.clientY })
              }
              cwd={cwd}
              busy={busy}
              sortable={projectSortable}
              pinned={false}
              searchActive={searchActive || inboxActive || notesActive}
              onSelect={onSelectProject}
              onTogglePin={onTogglePin}
              onContextMenu={onProjectContextMenu}
              onOpenMenu={openProjectMenu}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupLogos={groupLogos}
              groupMascots={groupMascots}
            />
          </div>
          <LiveAgentsPreview
            agents={liveAgents}
            activeSessionId={activeSessionId}
            taskBySessionId={taskBySessionId}
            onSelect={onSelectAgent}
            groupLabels={groupLabels}
            groupColors={groupColors}
            groupCustomColors={groupCustomColors}
            groupMascots={groupMascots}
          />
          <SidebarUpdateFooter
            update={updateNotice}
            onOpenWhatsNew={onOpenWhatsNew}
            onDismissUpdate={onDismissUpdate}
          />
          <div className="flex shrink-0 flex-col gap-px p-2">
            <RailAction
              label="Settings"
              icon={Settings}
              onClick={onOpenSettings}
              shortcut={`${MOD},`}
              ariaLabel={`Settings (${MOD},)`}
            />
          </div>
        </>
      )}
      {projectMenu ? (
        <TabGroupMenu
          x={projectMenu.x}
          y={projectMenu.y}
          groupId={projectMenu.projectKey}
          label={
            menuProject?.name ??
            resolveTabGroupLabel(
              projectMenu.projectKey,
              groupLabels,
              basename(projectMenu.path),
            )
          }
          colorIndex={resolveTabGroupColorIndex(
            projectMenu.projectKey,
            groupColors,
            groupCustomColors,
          )}
          customColor={resolveTabGroupCustomColor(
            projectMenu.projectKey,
            groupCustomColors,
          )}
          currentColor={resolveTabGroupColor(
            projectMenu.projectKey,
            groupColors,
            groupCustomColors,
            projectName(projectMenu.path),
          )}
          logoPath={resolveTabGroupLogo(projectMenu.projectKey, groupLogos)}
          logoProject={projectMenu.path}
          mascotName={resolveTabGroupMascot(
            projectMenu.projectKey,
            groupMascots,
          )}
          mascotProject={projectName(projectMenu.path)}
          onRename={onProjectRename}
          onColorChange={onProjectColorChange}
          onCustomColorChange={onProjectCustomColorChange}
          onMascotChange={onProjectMascotChange}
          onLogoChange={() => {}}
          onPick={() => {}}
          onClose={() => {
            setProjectMenu(null);
            menuTrigger.current?.focus();
          }}
          showActions={false}
          leadingAction={menuMuteStatus ? {
            id: "notifications-resume",
            label: "Resume notifications",
            description: menuMuteStatus,
            icon: BellOff,
          } : undefined}
          extraItems={projectMenuExtraItems(
            isRowPinned(projectMenu.path, menuProject),
            Boolean(onRemoveProject),
            !isProjectRailKey(projectMenu.path),
            Boolean(onOpenNotificationSettings),
            Boolean(readyNotificationProject),
            projectGroups,
            projectGroupIdForPath(projectMenu.path, projectGroupAssignments),
          )}
          footer={notificationMenuError ? (
            <p role="alert" className="px-2 py-1 text-xs text-red-400">{notificationMenuError}</p>
          ) : null}
          onExtraPick={onProjectMenuPick}
        />
      ) : null}
      {projectGroupMenu ? (
        <ProjectGroupAppearanceMenu
          menu={projectGroupMenu}
          groups={projectGroups}
          onRename={(id, name) =>
            updateProjectGroup(id, (group) => ({
              ...group,
              name: name.trim() || group.name,
            }))
          }
          onColorChange={(id, colorIndex) =>
            updateProjectGroup(id, (group) => ({
              ...group,
              colorIndex: colorIndex ?? undefined,
              customColor: undefined,
            }))
          }
          onCustomColorChange={(id, customColor) =>
            updateProjectGroup(id, (group) => ({
              ...group,
              colorIndex: undefined,
              customColor,
            }))
          }
          onMascotChange={(id, mascot) =>
            updateProjectGroup(id, (group) => ({
              ...group,
              mascot: mascot ?? undefined,
            }))
          }
          onDelete={deleteGroup}
          onClose={() => {
            setProjectGroupMenu(null);
            menuTrigger.current?.focus();
          }}
        />
      ) : null}
      {notificationMenu ? (
        <ProjectNotificationDatePicker
          key={notificationMenu.path}
          {...notificationMenu}
          onClose={() => {
            setNotificationMenu(null);
            menuTrigger.current?.focus();
          }}
        />
      ) : null}
      {inboxMenu ? (
        <InboxNotificationMenu
          {...inboxMenu}
          projectPaths={[...allProjects.keys()]}
          onOpenSettings={onOpenNotificationSettings}
          onClose={() => {
            setInboxMenu(null);
            menuTrigger.current?.focus();
          }}
        />
      ) : null}
      {removing ? (
        <RemoveProjectDialog
          name={removing.name}
          path={removing.path}
          onConfirm={onConfirmDelete}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
      {backgroundProject ? (
        <ProjectBackgroundDialog
          project={backgroundProject.project}
          name={backgroundProject.name}
          onClose={() => setBackgroundProject(null)}
        />
      ) : null}
      {repositoriesProject ? (
        <ProjectRepositories
          path={repositoriesProject.path}
          projectId={repositoriesProject.projectId}
          groupImport={repositoriesProject.groupImport}
          autoPick={repositoriesProject.autoPick}
          families={families}
          onOpenPath={(path) => {
            setRepositoriesProject(null);
            onSelectProject(path);
          }}
          onClose={() => setRepositoriesProject(null)}
        />
      ) : null}
      {addMenu ? (
        <Popover
          anchor={{ x: addMenu.x, y: addMenu.y }}
          onDismiss={closeAddMenu}
          role="menu"
          aria-label="Add project"
          className="overflow-hidden"
        >
          <div className="px-1.5 py-1.5">
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
              onClick={() => {
                closeAddMenu();
                onOpenProject();
              }}
            >
              Open folder…
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
              onClick={() => {
                closeAddMenu();
                setRepositoriesProject({
                  path: "",
                  groupImport: true,
                  autoPick: true,
                });
              }}
            >
              Folder of repositories…
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
              onClick={() => {
                closeAddMenu();
                submitGroup();
              }}
            >
              New project group…
            </button>
          </div>
        </Popover>
      ) : null}
      {taskMenu ? (
        <Popover
          anchor={{ x: taskMenu.x, y: taskMenu.y }}
          side="right"
          onDismiss={() => setTaskMenu(null)}
          role="menu"
          aria-label={`Task ${taskMenu.task.name}`}
          className="overflow-hidden"
        >
          <TaskMenuOverview
            task={taskMenu.task}
            needsInputIds={needsInputSessionIds}
            liveIds={liveSessionIds}
            linkedItemUpdates={linkedItemUpdates}
            onOpenTask={
              onOpenTask
                ? () => {
                    onOpenTask(taskMenu.task.id);
                    setTaskMenu(null);
                  }
                : undefined
            }
            onOpenDetails={() => {
              window.dispatchEvent(
                new CustomEvent(OPEN_TASK_DETAILS, {
                  detail: taskMenu.task.id,
                }),
              );
              setTaskMenu(null);
            }}
            onOpenDelivery={
              onOpenTaskDelivery
                ? (child, ref) => {
                    setTaskMenu(null);
                    void onOpenTaskDelivery(taskMenu.task, child, ref);
                  }
                : undefined
            }
          />
          <div className="px-1.5 py-1.5">
            {(() => {
              // No live set (tests render the rail without sessions) — count
              // the recorded ids as before.
              const conversations = liveTaskSessionIds(
                taskMenu.task,
                liveSessionIds ?? taskSessionIds(taskMenu.task),
              ).length;
              return (
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
                  onClick={() => {
                    // Several conversations — the details sheet's list is the
                    // picker; one or none goes straight to open's behavior.
                    if (conversations > 1)
                      window.dispatchEvent(
                        new CustomEvent(OPEN_TASK_DETAILS, {
                          detail: taskMenu.task.id,
                        }),
                      );
                    else onOpenTask?.(taskMenu.task.id);
                    setTaskMenu(null);
                  }}
                >
                  {conversations > 1
                    ? `Open ${conversations} conversations…`
                    : conversations
                      ? "Open conversation"
                      : "Open task"}
                </button>
              );
            })()}
            {!taskMenu.task.archived &&
            (taskMenu.task.children.some(
              (child) => !taskChildPrepared(child),
            ) ||
              // Every child ready but no live session anywhere — Start
              // recreates the conversation the task lost.
              !liveTaskSessionIds(
                taskMenu.task,
                liveSessionIds ?? taskSessionIds(taskMenu.task),
              ).length) &&
            onStartTask ? (
              <button
                type="button"
                role="menuitem"
                title="Prepare working copies and start the agent"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
                onClick={() => {
                  onStartTask(taskMenu.task.id);
                  setTaskMenu(null);
                }}
              >
                Start task
              </button>
            ) : null}
            {!taskMenu.task.archived &&
            onSyncTaskBranches &&
            taskMenu.task.children.some((child) => child.workingCopy) ? (
              <button
                type="button"
                role="menuitem"
                title="Fetch and merge the remote default into every linked working copy — conflicts go to each copy's agent"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
                onClick={() => {
                  onSyncTaskBranches(taskMenu.task.id);
                  setTaskMenu(null);
                }}
              >
                Sync all branches with remote default
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent(OPEN_TASK_DETAILS, {
                    detail: taskMenu.task.id,
                  }),
                );
                setTaskMenu(null);
              }}
            >
              Task details…
            </button>
            {!taskMenu.task.archived && onEditTask ? (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
                onClick={() => {
                  onEditTask(taskMenu.task.id);
                  setTaskMenu(null);
                }}
              >
                Edit task…
              </button>
            ) : null}
            {onOpenCommands ? (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
                onClick={() => {
                  onOpenCommands({
                    anchor: taskMenu.rowRect
                      ? { x: taskMenu.rowRect.right, y: taskMenu.rowRect.top }
                      : { x: taskMenu.x, y: taskMenu.y },
                    projectId: taskMenu.task.projectId,
                    taskId: taskMenu.task.id,
                  });
                  setTaskMenu(null);
                }}
              >
                Commands…
              </button>
            ) : null}
            {!taskMenu.task.archived && onCreateTaskPrs ? (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
                onClick={() => {
                  onCreateTaskPrs(taskMenu.task.id);
                  setTaskMenu(null);
                }}
              >
                Create pull requests…
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
              onClick={() => {
                archiveTask(taskMenu.task.id, !taskMenu.task.archived);
                setTaskMenu(null);
              }}
            >
              {taskMenu.task.archived ? "Unarchive task" : "Archive task"}
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-red-400 hover:bg-content/5"
              onClick={() => {
                setDeleteTaskId(taskMenu.task.id);
                setTaskMenu(null);
              }}
            >
              Delete task…
            </button>
          </div>
        </Popover>
      ) : null}
      {deleteTaskId ? (
        <TaskWorktreesSheet
          taskId={deleteTaskId}
          cwd={cwd}
          families={families}
          onClose={() => setDeleteTaskId(null)}
        />
      ) : null}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize project sidebar"
        aria-valuenow={resize.width}
        aria-valuemin={PROJECT_RAIL_WIDTH_MIN}
        aria-valuemax={PROJECT_RAIL_WIDTH_MAX}
        className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-content/15" : "hover:bg-content/10"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
    </nav>
  );
}

type SortableHandle = ReturnType<typeof useAnimatedReorder>;


function ProjectNotificationDatePicker({
  project,
  x,
  y,
  onClose,
}: {
  project: NotificationProject;
  x: number;
  y: number;
  onClose: () => void;
}) {
  return (
    <Popover
      anchor={{ x, y }}
      gap={0}
      width={280}
      role="dialog"
      aria-label="Mute project notifications"
      onDismiss={onClose}
      className="space-y-1 overflow-y-auto p-3"
    >
      <p
        className="truncate px-1 text-xs font-medium text-content/85"
        title={project.name}
      >
        {project.name}
      </p>
      <NotificationMuteDatePicker projectIds={[project.id]} onCancel={onClose} onChanged={onClose} />
    </Popover>
  );
}


function ProjectSection({
  label,
  items,
  families,
  muteStatuses,
  emptyLabel,
  onAdd,
  cwd,
  busy,
  sortable,
  pinned,
  searchActive,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  label: string;
  items: RailProjectItem[];
  families: ReadonlyMap<string, RepositoryFamily>;
  muteStatuses: ReadonlyMap<string, string | null>;
  emptyLabel?: string;
  onAdd?: (event: MouseEvent<HTMLButtonElement>) => void;
  cwd: string;
  busy: Set<string>;
  sortable: SortableHandle;
  pinned: boolean;
  searchActive: boolean;
  onSelect: (path: string) => void;
  onTogglePin: (path: string, project?: ProjectRecord) => void;
  onContextMenu: (
    item: RailProjectItem,
    event: MouseEvent<HTMLElement>,
  ) => void;
  onOpenMenu: (
    item: RailProjectItem,
    x: number,
    y: number,
    rowRect?: DOMRect,
  ) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  return (
    <div className="shrink-0 mb-2">
      <ProjectSectionHeader label={label} onAdd={onAdd} />
      {items.length === 0 && emptyLabel ? (
        <p className="px-4 pb-1 text-[11px] leading-tight text-content/40">
          {emptyLabel}
        </p>
      ) : null}
      <div className="flex flex-col gap-px px-2">
        {items.map((item) => (
          <ProjectFamilyCard
            key={item.path}
            item={item}
            family={families.get(pathKey(item.path))}
            families={families}
            muteStatus={muteStatuses.get(pathKey(item.path)) ?? undefined}
            cwd={cwd}
            busyPaths={busy}
            selected={!searchActive && sameProjectPath(item.path, cwd)}
            busy={isBusyPath(item.path, busy)}
            pinned={pinned}
            sortable={sortable}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            onContextMenu={onContextMenu}
            onOpenMenu={onOpenMenu}
            groupLabels={groupLabels}
            groupColors={groupColors}
            groupCustomColors={groupCustomColors}
            groupLogos={groupLogos}
            groupMascots={groupMascots}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectSectionHeader({
  label,
  onAdd,
  onAddGroup,
}: {
  label: string;
  onAdd?: (event: MouseEvent<HTMLButtonElement>) => void;
  onAddGroup?: (x: number, y: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
      <span className="min-w-0 flex-1 truncate px-1 text-xs text-content/50">
        {label}
      </span>
      {onAddGroup ? (
        <button
          type="button"
          title="New project group"
          aria-label="New project group"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onAddGroup(rect.left, rect.bottom);
          }}
          className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
        >
          <FolderPlus className="size-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
      {onAdd ? (
        <button
          type="button"
          title="Open project"
          aria-label="Open project"
          onClick={onAdd}
          className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}

function projectGroupColor(group: ProjectGroup): string {
  if (group.customColor) return group.customColor;
  if (
    group.colorIndex != null &&
    group.colorIndex >= 0 &&
    group.colorIndex < TAB_GROUP_COLORS.length
  ) {
    return TAB_GROUP_COLORS[group.colorIndex];
  }
  return tabGroupColor(group.id);
}

function ProjectGroupAppearanceMenu({
  menu,
  groups,
  onRename,
  onColorChange,
  onCustomColorChange,
  onMascotChange,
  onDelete,
  onClose,
}: {
  menu: { x: number; y: number; id: string };
  groups: ProjectGroup[];
  onRename: (id: string, name: string) => void;
  onColorChange: (id: string, colorIndex: number | null) => void;
  onCustomColorChange: (id: string, color: string) => void;
  onMascotChange: (id: string, mascot: string | null) => void;
  onDelete: (id: string) => boolean;
  onClose: () => void;
}) {
  const group = groups.find((item) => item.id === menu.id);
  if (!group) return null;
  return (
    <TabGroupMenu
      x={menu.x}
      y={menu.y}
      groupId={group.id}
      label={group.name}
      colorIndex={group.colorIndex ?? null}
      customColor={group.customColor ?? null}
      currentColor={projectGroupColor(group)}
      logoPath={null}
      mascotName={group.mascot ?? null}
      mascotProject={group.id}
      onRename={onRename}
      onColorChange={onColorChange}
      onCustomColorChange={onCustomColorChange}
      onMascotChange={onMascotChange}
      onLogoChange={() => {}}
      onPick={() => {}}
      onClose={onClose}
      showActions={false}
      ariaLabel="Project group actions"
      extraItems={[
        {
          id: "delete-project-group",
          label: "Delete group",
          description: "Projects will become ungrouped",
          icon: Trash2,
          danger: true,
        },
      ]}
      onExtraPick={(action) =>
        action === "delete-project-group" ? onDelete(group.id) : undefined
      }
    />
  );
}

function ProjectGroupSection({
  group,
  items,
  families,
  muteStatuses,
  cwd,
  busy,
  searchActive,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  onReorder,
  onToggleCollapsed,
  onOpenGroupMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  group: ProjectGroup;
  items: RailProjectItem[];
  families: ReadonlyMap<string, RepositoryFamily>;
  muteStatuses: ReadonlyMap<string, string | null>;
  cwd: string;
  busy: Set<string>;
  searchActive: boolean;
  onSelect: (path: string) => void;
  onTogglePin: (path: string, project?: ProjectRecord) => void;
  onContextMenu: (
    item: RailProjectItem,
    event: MouseEvent<HTMLElement>,
  ) => void;
  onOpenMenu: (
    item: RailProjectItem,
    x: number,
    y: number,
    rowRect?: DOMRect,
  ) => void;
  onReorder: (ids: string[]) => void;
  onToggleCollapsed: () => void;
  onOpenGroupMenu: (x: number, y: number) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  const sortable = useAnimatedReorder(
    items.map((item) => item.path),
    onReorder,
    "y",
  );
  const countLabel = `${items.length} ${items.length === 1 ? "project" : "projects"}`;
  const expanded = !group.collapsed;
  const openMenu = (target: HTMLElement, x?: number, y?: number) => {
    const rect = target.getBoundingClientRect();
    onOpenGroupMenu(x ?? rect.left, y ?? rect.bottom);
  };

  return (
    <div
      className={`shrink-0 overflow-hidden rounded-md ${
        expanded ? "mb-1.5 bg-content/5" : ""
      }`}
      data-project-group={group.id}
      role="group"
      aria-label={group.name}
    >
      <div
        className="project-reorder-item group relative flex h-8 items-stretch rounded-md px-2 opacity-65 cursor-default"
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
          openMenu(event.currentTarget, event.clientX, event.clientY);
        }}
      >
        <button
          type="button"
          aria-expanded={!group.collapsed}
          aria-label={`${group.name}, ${countLabel}`}
          title={`${group.name} · ${countLabel}`}
          onClick={onToggleCollapsed}
          className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left transition-[padding] duration-150 motion-reduce:transition-none group-hover:pr-6 group-has-[:focus-visible]:pr-6"
        >
          <div className="grid size-4 shrink-0 place-items-center">
            {group.collapsed ? (
              <>
                <span
                  data-group-mascot
                  className="grid size-4 place-items-center group-hover:hidden group-has-[:focus-visible]:hidden"
                >
                  <ProjectMascot
                    project={group.id}
                    color={projectGroupColor(group)}
                    name={group.mascot ?? null}
                    className="size-3"
                  />
                </span>
                <ChevronRight
                  data-group-chevron
                  className="hidden size-3.5 group-hover:block group-has-[:focus-visible]:block"
                  strokeWidth={1.75}
                />
              </>
            ) : (
              <ChevronDown
                data-group-chevron
                className="size-3.5"
                strokeWidth={1.75}
              />
            )}
          </div>
          <span className={nameClassName}>{group.name}</span>
        </button>
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          <button
            type="button"
            data-no-drag
            title="Group options"
            aria-label={`${group.name} group options`}
            aria-haspopup="menu"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openMenu(event.currentTarget);
            }}
            className="invisible grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:visible group-has-[:focus-visible]:visible"
          >
            <MoreHorizontal className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      {expanded ? (
        <div data-project-group-items className="flex flex-col gap-px p-1">
          {items.map((item) => (
            <ProjectFamilyCard
              key={item.path}
              item={item}
              family={families.get(pathKey(item.path))}
              families={families}
              muteStatus={muteStatuses.get(pathKey(item.path)) ?? undefined}
              cwd={cwd}
              busyPaths={busy}
              selected={!searchActive && sameProjectPath(item.path, cwd)}
              busy={isBusyPath(item.path, busy)}
              pinned={false}
              sortable={sortable}
              onSelect={onSelect}
              onTogglePin={onTogglePin}
              onContextMenu={onContextMenu}
              onOpenMenu={onOpenMenu}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupLogos={groupLogos}
              groupMascots={groupMascots}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const nameClassName =
  "min-w-0 flex-1 truncate text-sm font-medium leading-tight";

function useExpandedRow(
  key: string,
): [boolean | null, (next: boolean) => void] {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      setExpanded(saved === null ? null : saved === "true");
    } catch {
      setExpanded(null);
    }
  }, [key]);
  const set = (next: boolean) => {
    setExpanded(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      /* quota */
    }
  };
  return [expanded, set];
}

function lastWorkingCopyPath(
  commonDir: string,
  family: RepositoryFamily | undefined,
): string | null {
  let last: string | null = null;
  try {
    last = localStorage.getItem(`monocode.worktreeLast:${commonDir}`);
  } catch {
    /* private mode */
  }
  return (
    family?.worktrees.find(
      (child) => !child.missing && last && sameProjectPath(child.path, last),
    )?.path ?? null
  );
}

function WorkingCopyRows({
  family,
  hidden,
  cwd,
  busyPaths,
  recents,
  onSelect,
  onOpenList,
}: {
  family: RepositoryFamily;
  hidden: string[];
  cwd: string;
  busyPaths: Set<string>;
  recents: RecentProject[];
  onSelect: (path: string) => void;
  /** Opens the full worktree panel anchored to the clicked button — the
   * menu's "All worktrees…" escape hatch. */
  onOpenList: (anchor: HTMLButtonElement) => void;
}) {
  // One version subscription per rows block; per-copy results are peeked.
  useSyncExternalStore(
    subscribeWorktreeCollisionVersion,
    worktreeCollisionVersion,
  );
  // Claim labels re-derive on every task store write.
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    child: WorkingCopy;
    anchor: HTMLButtonElement;
  } | null>(null);
  const menuClaim = useMemo(
    () => (menu ? taskChildrenForWorkingCopy(menu.child.path)[0] : undefined),
    // tasksRaw changes on every store write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menu, tasksRaw],
  );
  const children = family.worktrees.filter(
    (child) =>
      sameProjectPath(child.path, cwd) ||
      !hidden.some((path) => sameProjectPath(path, child.path)),
  );
  /** A surviving member that can host the manager's Git calls — a removed,
   * missing or targeted path can never be the context. */
  const managerContext = (exclude?: string) => {
    const usable = family.worktrees.filter(
      (entry) =>
        !entry.missing &&
        !entry.prunable &&
        (!exclude || pathKey(entry.path) !== pathKey(exclude)),
    );
    return (
      usable.find((entry) => entry.main)?.path ??
      usable[0]?.path ??
      family.checkout
    );
  };
  const menuItems = (child: WorkingCopy): ExplorerMenuItem[] => {
    const isHidden = hidden.some((path) => sameProjectPath(path, child.path));
    const unavailable = child.missing || !!child.prunable;
    return [
      {
        kind: "item",
        id: "open",
        label: "Open",
        disabled: unavailable,
      },
      { kind: "item", id: "copy", label: "Copy path" },
      {
        kind: "item",
        id: "reveal",
        label: REVEAL_LABEL,
        // WSL paths can't be revealed from a host-shell call on macOS/Linux.
        disabled: unavailable || (!!wslLocation(child.path) && !IS_WIN),
      },
      { kind: "sep" },
      ...(!child.main
        ? [
            {
              kind: "item" as const,
              id: "hide",
              label: isHidden ? "Show in project" : "Hide from project",
            },
          ]
        : []),
      { kind: "item", id: "details", label: "Details & cleanup…" },
      { kind: "item", id: "all", label: "All worktrees…" },
      { kind: "sep" },
      {
        kind: "item",
        id: "remove",
        label: "Remove Git worktree…",
        danger: true,
        disabled: child.main || unavailable || !!child.locked || !child.branch,
      },
    ];
  };
  const pickMenuItem = (id: string) => {
    const state = menu;
    setMenu(null);
    if (!state) return;
    // `onPick` bypasses `onClose` — restore focus the same way. The …
    // anchor is visibility:hidden off-hover, so focus the row button.
    (
      state.anchor.parentElement?.querySelector("button") ?? state.anchor
    ).focus();
    const child = state.child;
    switch (id) {
      case "open":
        onSelect(child.path);
        break;
      case "copy":
        void copyText(child.path).catch(() => {});
        break;
      case "reveal":
        void revealPath(child.path).catch(() => {});
        break;
      case "hide":
        try {
          setWorkingCopyHidden(
            child.path,
            !hidden.some((path) => sameProjectPath(path, child.path)),
          );
        } catch {
          /* storage quota — presentation only */
        }
        break;
      case "details":
        openWorktreeManager({
          cwd: managerContext(child.path),
          path: child.path,
        });
        break;
      case "all":
        onOpenList(state.anchor);
        break;
      case "remove":
        // Delegates to the modal's reviewed confirmation — no check bypassed.
        openWorktreeManager({
          cwd: managerContext(child.path),
          path: child.path,
          action: "remove",
        });
        break;
    }
  };
  return (
    <>
      {children.map((child) => {
        const name = workingCopyName(child, family);
        const active = sameProjectPath(child.path, cwd);
        const working = isBusyPath(child.path, busyPaths);
        const collision = peekWorktreeCollision(child.path);
        return (
          <div
            key={child.path}
            className="group/working-copy relative flex min-w-0 items-center"
          >
            <button
              type="button"
              disabled={child.missing || !!child.prunable}
              title={`${prettyCwd(child.path)}\n${child.head}\n${workingCopyAge(lastWorkingCopyUse(child, recents))} in MonoCode${child.locked ? ` · ${child.locked}` : ""}${working ? " · Working" : ""}`}
              aria-current={active ? "true" : undefined}
              className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pl-2 ${collision ? "pr-16" : "pr-7"} text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-content/30 disabled:opacity-40 ${active ? "bg-content/10 text-content" : "text-content/55 hover:bg-content/5 hover:text-content/85"}`}
              onClick={() => onSelect(child.path)}
            >
              <GitBranch
                className="size-3 shrink-0 text-content/40"
                strokeWidth={1.5}
              />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              {child.missing || child.prunable ? (
                <span className="text-[10px]">Missing</span>
              ) : working ? (
                <span title="Working" aria-label="Working">
                  <TerminalSpinner className="size-3" />
                </span>
              ) : active ? (
                <Check
                  className="size-3 shrink-0 text-content/45"
                  strokeWidth={1.5}
                />
              ) : null}
            </button>
            {collision ? (
              <WorktreeCollisionBadge
                files={collision}
                className="absolute right-1 top-1/2 -translate-y-1/2"
              />
            ) : null}
            <button
              type="button"
              title="Worktree actions"
              aria-label={`Actions for worktree ${name}`}
              aria-haspopup="menu"
              className={`invisible absolute ${collision ? "right-11" : "right-1"} top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content group-hover/working-copy:visible group-focus-within/working-copy:visible focus-visible:ring-1 focus-visible:ring-content/30`}
              onClick={(event) =>
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  child,
                  anchor: event.currentTarget,
                })
              }
            >
              <MoreHorizontal className="size-3" />
            </button>
          </div>
        );
      })}
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={`Worktree ${workingCopyName(menu.child, family)} actions`}
          header={
            <div className="px-2 py-1.5">
              <p className="truncate text-[12px] font-medium text-content">
                {workingCopyName(menu.child, family)}
                {menuClaim ? ` · Task ${menuClaim.task.name}` : ""}
              </p>
              <p className="truncate text-[10px] text-content/45">
                {prettyCwd(menu.child.path)}
              </p>
            </div>
          }
          items={menuItems(menu.child)}
          onPick={pickMenuItem}
          onClose={() => {
            setMenu(null);
            (
              menu.anchor.parentElement?.querySelector("button") ?? menu.anchor
            ).focus();
          }}
        />
      ) : null}
    </>
  );
}

/** One repository row inside an expanded multi-repository project. Opens the
 * repository's last working copy; its chevron reveals that repository's
 * worktrees. */
function ProjectRepositoryRow({
  repo,
  families,
  hidden,
  cwd,
  busyPaths,
  recents,
  onSelect,
}: {
  repo: ProjectRecord["repositories"][number];
  families: ReadonlyMap<string, RepositoryFamily>;
  hidden: string[];
  cwd: string;
  busyPaths: Set<string>;
  recents: RecentProject[];
  onSelect: (path: string) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ create: boolean } | null>(null);
  const [working, setWorking] = useState(false);
  const family = familyForRepository(repo, families);
  const [expanded, setExpanded] = useExpandedRow(
    `monocode.repoExpanded:${repo.id}`,
  );
  const visible = expanded ?? false;
  const name = repositoryDisplayName(repo);
  const wsl = wslLocation(repo.anchor);
  const active = family
    ? family.worktrees.some((child) => sameProjectPath(child.path, cwd))
    : sameProjectPath(repo.anchor, cwd);
  const openRepository = () =>
    onSelect(
      lastWorkingCopyPath(repo.commonDir, family) ??
        (family?.worktrees.find((child) => child.main && !child.missing)
          ?.path ||
          repo.anchor),
    );
  return (
    <div>
      <div className="group/repository relative flex min-w-0 items-center">
        {family ? (
          <button
            type="button"
            aria-label={`Show working copies of ${name}`}
            aria-expanded={visible}
            onClick={() => setExpanded(!visible)}
            className="shrink-0 rounded px-0.5 text-content/45 hover:text-content"
          >
            <ChevronDown className={`size-3 ${visible ? "" : "-rotate-90"}`} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <button
          type="button"
          title={prettyCwd(repo.anchor)}
          aria-current={active ? "true" : undefined}
          className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pl-2 pr-7 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-content/30 group-hover/repository:pr-12 ${active ? "bg-content/10 text-content" : "text-content/55 hover:bg-content/5 hover:text-content/85"}`}
          onClick={openRepository}
        >
          <Folder
            className="size-3 shrink-0 text-content/40"
            strokeWidth={1.5}
          />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {wsl ? (
            <span className="shrink-0 text-[10px] text-content/40 group-hover/repository:invisible">
              WSL
            </span>
          ) : null}
          {active ? (
            <Check
              className="size-3 shrink-0 text-content/45"
              strokeWidth={1.5}
            />
          ) : null}
        </button>
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          {family ? (
            <button
              type="button"
              title={`New worktree in ${name}`}
              aria-label={`New worktree in ${name}`}
              className="invisible grid size-5 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content group-hover/repository:visible group-focus-within/repository:visible focus-visible:ring-1 focus-visible:ring-content/30"
              onClick={(event) => {
                anchor.current = event.currentTarget;
                setMenu({ create: true });
              }}
            >
              <Plus className="size-3" strokeWidth={1.75} />
            </button>
          ) : null}
          <button
            type="button"
            title="Repository worktrees"
            aria-label={`Manage ${name} worktrees`}
            className="invisible grid size-5 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content group-hover/repository:visible group-focus-within/repository:visible focus-visible:ring-1 focus-visible:ring-content/30"
            onClick={(event) => {
              anchor.current = event.currentTarget;
              setMenu({ create: false });
            }}
          >
            <MoreHorizontal className="size-3" />
          </button>
        </div>
      </div>
      {visible && family ? (
        <div className="my-0.5 ml-5">
          <WorkingCopyRows
            family={family}
            hidden={hidden}
            cwd={cwd}
            busyPaths={busyPaths}
            recents={recents}
            onSelect={onSelect}
            onOpenList={(el) => {
              anchor.current = el;
              setMenu({ create: false });
            }}
          />
        </div>
      ) : null}
      {menu && (
        <Popover
          anchor={anchor}
          side="right"
          width={320}
          maxHeight={380}
          onDismiss={() => {
            if (!working) {
              setMenu(null);
              anchor.current?.focus();
            }
          }}
          role="dialog"
          aria-label={`${name} worktrees`}
          className="flex flex-col overflow-hidden"
        >
          <WorktreePanel
            key={String(menu.create)}
            initialCreate={menu.create}
            activeCwd={cwd}
            cwd={
              family?.worktrees.find(
                (entry) => !entry.missing && !entry.prunable,
              )?.path ?? repo.anchor
            }
            onClose={() => {
              setMenu(null);
              anchor.current?.focus();
            }}
            onOpen={onSelect}
            onBusyChange={setWorking}
          />
        </Popover>
      )}
    </div>
  );
}

const TASK_RAIL_CAP = 8;

/** The rail's one home for tasks — a dedicated section listing every active
 * task with live status, instead of rows buried inside each project.
 * Archived tasks collapse under a toggle so they stay recoverable. */
function TasksSection({
  tasks,
  archivedTasks,
  currentTaskId,
  busyIds,
  busySessionIds,
  needsInputIds,
  onOpen,
  onMenu,
  onNewTask,
}: {
  tasks: TaskWorkspace[];
  archivedTasks: TaskWorkspace[];
  currentTaskId?: string;
  busyIds: ReadonlySet<string>;
  busySessionIds: ReadonlySet<string>;
  needsInputIds?: ReadonlySet<string>;
  onOpen?: (taskId: string) => void;
  onMenu: (
    task: TaskWorkspace,
    x: number,
    y: number,
    rowRect?: DOMRect,
  ) => void;
  onNewTask?: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Re-read saved provider links when they change — one parse shared by all
  // rows; the rail never fetches live provider data itself.
  const stores = useDeliveryStores();
  // The rail stays compact — current and working tasks sort first, the
  // long tail hides behind a toggle like the archived list. Filtering shows
  // every match (live and archived) without the cap.
  const filtering = Boolean(query.trim());
  const visibleTasks = filtering
    ? tasks.filter((task) => taskMatchesQuery(task, query))
    : showAll || tasks.length <= TASK_RAIL_CAP
      ? tasks
      : tasks.slice(0, TASK_RAIL_CAP);
  const visibleArchived = filtering
    ? archivedTasks.filter((task) => taskMatchesQuery(task, query))
    : archivedTasks;
  const row = (task: TaskWorkspace, archived = false) => {
    const project = projectForTask(task);
    return (
      <TaskRailRow
        key={task.id}
        task={task}
        archived={archived}
        active={task.id === currentTaskId}
        busy={busyIds.has(task.id)}
        needsInput={
          task.sessionIds?.some((id) => needsInputIds?.has(id)) ||
          task.children.some((entry) =>
            entry.sessionIds.some((id) => needsInputIds?.has(id)),
          ) ||
          false
        }
        busySessionIds={busySessionIds}
        needsInputIds={needsInputIds}
        stores={stores}
        project={project}
        onOpen={() => onOpen?.(task.id)}
        onMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onMenu(
            task,
            event.clientX,
            event.clientY,
            event.currentTarget.getBoundingClientRect(),
          );
        }}
      />
    );
  };
  return (
    <div className="mb-2 shrink-0">
      <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-content/50">
          Tasks
        </span>
        {tasks.length || archivedTasks.length ? (
          <button
            type="button"
            title="Search tasks"
            aria-label="Search tasks"
            aria-expanded={searching}
            onClick={() => {
              setSearching(true);
              searchRef.current?.focus();
            }}
            className={`grid size-5 shrink-0 place-items-center rounded-md hover:bg-content/8 hover:text-content ${searching ? "text-content" : "text-content/50"}`}
          >
            <Search className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
        {onNewTask ? (
          <button
            type="button"
            title="New task"
            aria-label="New task"
            onClick={onNewTask}
            className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {searching ? (
        <div className="px-3 pb-1.5">
          <input
            ref={searchRef}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
              setSearching(false);
            }}
            onBlur={() => {
              if (!query) setSearching(false);
            }}
            placeholder="Filter tasks..."
            aria-label="Filter tasks"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            className="h-6 w-full rounded-md bg-content/6 px-2 text-[11px] text-content outline-none placeholder:text-content/35 focus:ring-1 focus:ring-content/25"
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-px px-2">
        {visibleTasks.map((task) => row(task))}
        {!tasks.length && !archivedTasks.length ? (
          onNewTask ? (
            <button
              type="button"
              onClick={onNewTask}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-content/40 hover:bg-content/5 hover:text-content/60"
            >
              <Plus className="size-3 shrink-0" strokeWidth={1.75} />
              New task
            </button>
          ) : (
            <p className="px-4 pb-1 text-[11px] leading-tight text-content/40">
              No tasks yet
            </p>
          )
        ) : null}
        {filtering && !visibleTasks.length && !visibleArchived.length ? (
          <p className="px-4 pb-1 text-[11px] leading-tight text-content/40">
            No matching tasks
          </p>
        ) : null}
        {!filtering && tasks.length > visibleTasks.length ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-content/40 hover:bg-content/5 hover:text-content/60"
          >
            {tasks.length - visibleTasks.length} more tasks
          </button>
        ) : null}
      </div>
      {visibleArchived.length ? (
        <div className="px-2 pt-1">
          <button
            type="button"
            aria-expanded={showArchived || filtering}
            onClick={() => setShowArchived((value) => !value)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-content/40 hover:bg-content/5 hover:text-content/60"
          >
            <ChevronDown
              className={`size-3 shrink-0 transition-transform ${showArchived || filtering ? "" : "-rotate-90"}`}
              strokeWidth={1.75}
            />
            Archived · {visibleArchived.length}
          </button>
          {showArchived || filtering ? (
            <div className="flex flex-col gap-px">
              {visibleArchived.map((task) => row(task, true))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One task row in the Tasks section — name, ticket ref, project +
 * repository meta, needs-input and working markers, plus a compact
 * delivery aggregate (failing CI, PRs needing review, launches to retry)
 * derived from saved provider links — never a live fetch. Opens the task. */
function TaskRailRow({
  task,
  active = false,
  busy = false,
  archived = false,
  needsInput,
  busySessionIds,
  needsInputIds,
  stores,
  project,
  onOpen,
  onMenu,
}: {
  task: TaskWorkspace;
  /** Its session is the focused one — persistent row highlight. */
  active?: boolean;
  /** Its agent is mid-turn — pulsing marker. */
  busy?: boolean;
  /** Dimmed row under the section's archived expander. */
  archived?: boolean;
  needsInput: boolean;
  busySessionIds: ReadonlySet<string>;
  needsInputIds?: ReadonlySet<string>;
  stores: DeliveryStores;
  /** Owning project — already resolved by the caller, shown for context. */
  project?: ProjectRecord;
  onOpen: () => void;
  onMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const ticket = task.ticket?.identifier;
  const projectLabel = project
    ? project.name?.trim() ||
      (project.anchor ? projectName(project.anchor) : "Project")
    : "";
  const repoNames = task.children
    .map((entry) => {
      const repo = repositoryForChild(task, entry, project);
      return repo ? repositoryDisplayName(repo) : "Repository";
    })
    .join(" · ");
  // Delivery per child, from saved links and already-cached data only —
  // the rail must stay cheap even with several tasks expanded. The version
  // ticks re-derive when a stats or PR cache publish lands — the peeks
  // themselves never subscribe or fetch.
  const statsV = useSyncExternalStore(
    subscribeDiffStatsVersion,
    diffStatsVersion,
  );
  const prV = useSyncExternalStore(subscribeBranchPrVersion, branchPrVersion);
  const deliveryMap = useMemo(() => {
    const map = new Map<string, TaskChildDelivery>();
    for (const entry of task.children) {
      if (!entry.workingCopy) continue;
      const branch =
        peekProjectDiffStats(entry.workingCopy)?.branch ?? entry.branch;
      map.set(
        entry.id,
        childDelivery(
          task,
          entry,
          [branch, entry.branch],
          cachedBranchPr(entry.workingCopy, branch),
          stores,
        ),
      );
    }
    return map;
    // statsV/prV only tick the caches — the peeks re-read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, stores, statsV, prV]);
  const failing = task.children.some(
    (entry) =>
      entry.launch.state === "failed" ||
      deliveryMap.get(entry.id)?.ciFailing ||
      deliveryMap.get(entry.id)?.prNeedsAttention,
  );
  // The "Working" badge already covers the busy segment — don't repeat it.
  const segments = taskStatusSegments(task, {
    busySessionIds,
    needsInputIds,
    delivery: deliveryMap,
    dropWorking: true,
  });
  const statusText = segments.join(" · ");
  const title = [
    ticket,
    task.name,
    repoNames || `${task.children.length} repos`,
    ...segments,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="group/task relative flex min-w-0 items-center">
      <button
        type="button"
        title={title}
        aria-label={title}
        onClick={onOpen}
        onContextMenu={onMenu}
        className={`flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 pr-7 text-left outline-none hover:bg-content/8 focus-visible:ring-1 focus-visible:ring-content/30 ${
          active ? "bg-content/10" : ""
        } ${archived ? "opacity-55" : ""}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Task
            className={`size-3 shrink-0 ${
              busy
                ? "animate-pulse text-accent"
                : active
                  ? "text-accent/80"
                  : "text-content/40"
            }`}
            strokeWidth={1.5}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-snug text-content">
            {task.name}
          </span>
          {busy ? (
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-accent">
              Working
            </span>
          ) : ticket ? (
            <span className="shrink-0 text-[11px] text-content/40">
              {ticket}
            </span>
          ) : projectLabel ? (
            <span className="shrink-0 truncate text-[10px] text-content/40">
              {projectLabel}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-5 text-[11px] leading-tight">
          {needsInput ? (
            <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
          ) : failing ? (
            <span className="size-1.5 shrink-0 rounded-full bg-red-400" />
          ) : null}
          <span
            className={`min-w-0 flex-1 truncate ${
              needsInput
                ? "text-amber-400"
                : failing
                  ? "text-red-400/90"
                  : "text-content/45"
            }`}
          >
            {statusText ? `${statusText} · ` : ""}
            {repoNames || `${task.children.length} repos`}
            {projectLabel ? ` · ${projectLabel}` : ""}
          </span>
        </span>
      </button>
      <button
        type="button"
        title="Task menu"
        aria-label={`Menu for task ${task.name}`}
        className="invisible absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content focus-visible:ring-1 focus-visible:ring-content/30 group-hover/task:visible group-focus-within/task:visible"
        onClick={onMenu}
      >
        <MoreHorizontal className="size-3" />
      </button>
    </div>
  );
}

function ProjectFamilyCard(
  props: Parameters<typeof ProjectCard>[0] & {
    family?: RepositoryFamily;
    families: ReadonlyMap<string, RepositoryFamily>;
    cwd: string;
    busyPaths: Set<string>;
  },
) {
  const { family, families, cwd, busyPaths, onSelect } = props;
  const project = props.item.project;
  const multiRepo = (project?.repositories.length ?? 0) > 1;
  /** Anchorless group — no own folder; the row exists to hold members. */
  const isGroup = !!project && !project.anchor;
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ create: boolean } | null>(null);
  const hiddenRaw = useSyncExternalStore(
    subscribeWorkingCopyPreferences,
    hiddenWorkingCopiesSnapshot,
  );
  const hidden = hiddenWorkingCopies(hiddenRaw);
  const recents = loadRecents();
  const [working, setWorking] = useState(false);
  const expandedKey = project
    ? `monocode.projectExpanded:${project.id}`
    : `monocode.worktreeExpanded:${family?.commonDir ?? props.item.path}`;
  const [expanded, setExpanded] = useExpandedRow(expandedKey);
  const allChildren = family?.worktrees ?? [];
  const children = allChildren.filter(
    (child) =>
      sameProjectPath(child.path, cwd) ||
      !hidden.some((path) => sameProjectPath(path, child.path)),
  );
  const visible = expanded ?? (isGroup || (!multiRepo && children.length > 1));
  const selected =
    multiRepo || isGroup
      ? !!project && projectContainsPath(project, cwd, families)
      : children.some((child) => sameProjectPath(child.path, cwd));
  const busy =
    props.busy ||
    (!!project &&
      project.repositories.some((repo) => {
        const member = familyForRepository(repo, families);
        return member
          ? member.worktrees.some((copy) => isBusyPath(copy.path, busyPaths))
          : isBusyPath(repo.anchor, busyPaths);
      }));
  const lastKey = `monocode.worktreeLast:${family?.commonDir ?? props.item.path}`;
  const inFamily = children.some((child) => sameProjectPath(child.path, cwd));
  useEffect(() => {
    if (inFamily) {
      try {
        localStorage.setItem(lastKey, cwd);
      } catch {
        /* quota */
      }
    }
  }, [inFamily, lastKey, cwd]);
  // Expanding a multi-repository row verifies member repositories on demand so
  // collapsed rows never probe extra Git state.
  useEffect(() => {
    if (!visible || !project) return;
    for (const repo of project.repositories)
      if (!familyForRepository(repo, families))
        void probeRepositoryFamily(repo.anchor);
  }, [visible, project, families]);
  const openLast = () => {
    if (
      project?.lastPath &&
      projectContainsPath(project, project.lastPath, families)
    ) {
      onSelect(project.lastPath);
      return;
    }
    // A group has no folder of its own — clicking it just expands.
    if (isGroup) {
      setExpanded(!visible);
      return;
    }
    onSelect(
      lastWorkingCopyPath(family?.commonDir ?? "", family) ?? props.item.path,
    );
  };
  return (
    <div>
      <ProjectCard
        {...props}
        selected={!visible && (props.selected || selected)}
        busy={busy}
        onSelect={openLast}
        worktreeControls={
          family || multiRepo || isGroup
            ? {
                expanded: visible,
                toggle: () => setExpanded(!visible),
                ...(multiRepo || isGroup
                  ? {}
                  : {
                      create: (event) => {
                        anchor.current = event.currentTarget;
                        setMenu({ create: true });
                      },
                    }),
              }
            : undefined
        }
      />
      {visible && (multiRepo || isGroup) && project && (
        <div className="my-0.5 ml-5">
          {project.repositories.map((repo) => (
            <ProjectRepositoryRow
              key={repo.id}
              repo={repo}
              families={families}
              hidden={hidden}
              cwd={cwd}
              busyPaths={busyPaths}
              recents={recents}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      {visible && !multiRepo && !isGroup && family && (
        <div className="my-0.5 ml-5">
          <WorkingCopyRows
            family={family}
            hidden={hidden}
            cwd={cwd}
            busyPaths={busyPaths}
            recents={recents}
            onSelect={onSelect}
            onOpenList={(el) => {
              anchor.current = el;
              setMenu({ create: false });
            }}
          />
        </div>
      )}
      {visible &&
        !multiRepo &&
        !isGroup &&
        allChildren.length > children.length && (
          <button
            type="button"
            className="w-full rounded px-2 py-1 text-left text-[10px] text-content/50 hover:bg-content/5"
            onClick={(event) => {
              anchor.current = event.currentTarget;
              setMenu({ create: false });
            }}
          >
            {allChildren.length - children.length} hidden · Manage worktrees
          </button>
        )}
      {menu && (
        <Popover
          anchor={anchor}
          side="right"
          width={320}
          maxHeight={380}
          onDismiss={() => {
            if (!working) {
              setMenu(null);
              anchor.current?.focus();
            }
          }}
          role="dialog"
          aria-label="Worktrees"
          className="flex flex-col overflow-hidden"
        >
          <WorktreePanel
            key={String(menu.create)}
            initialCreate={menu.create}
            activeCwd={cwd}
            cwd={
              family?.worktrees.find(
                (entry) => !entry.missing && !entry.prunable,
              )?.path ?? props.item.path
            }
            onClose={() => {
              setMenu(null);
              anchor.current?.focus();
            }}
            onOpen={onSelect}
            onBusyChange={setWorking}
          />
        </Popover>
      )}
    </div>
  );
}

function ProjectCard({
  item,
  worktreeControls,
  muteStatus,
  selected,
  busy,
  pinned,
  sortable,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  item: RailProjectItem;
  worktreeControls?: {
    expanded: boolean;
    toggle: () => void;
    /** Worktree creation lives on repository rows for multi-repo projects —
     * a project-level + would silently target only the anchor repo. */
    create?: (event: MouseEvent<HTMLButtonElement>) => void;
  };
  muteStatus?: string;
  selected: boolean;
  busy: boolean;
  pinned: boolean;
  sortable: SortableHandle;
  onSelect: (path: string) => void;
  onTogglePin: (path: string, project?: ProjectRecord) => void;
  onContextMenu: (
    item: RailProjectItem,
    event: MouseEvent<HTMLElement>,
  ) => void;
  onOpenMenu: (
    item: RailProjectItem,
    x: number,
    y: number,
    rowRect?: DOMRect,
  ) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  const groupRow = isProjectRailKey(item.path);
  const fallbackName = groupRow ? "Project" : basename(item.path);
  const key = projectKey(item.path);
  const seed = projectName(item.path);
  const name =
    item.project?.name ?? resolveTabGroupLabel(key, groupLabels, fallbackName);
  const logoPath = resolveTabGroupLogo(key, groupLogos);
  const color = resolveTabGroupColor(key, groupColors, groupCustomColors, seed);
  const diffEnabled = Boolean(item.path) && item.path !== "~" && !groupRow;
  const stats = useProjectDiffStats(item.path, diffEnabled);
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const hasChanges = files > 0 || additions > 0 || deletions > 0;
  const cardTitle = projectCardTitle(
    groupRow ? "" : item.path,
    name,
    stats,
    busy,
  );
  const cardAriaLabel = projectCardAriaLabel(name, stats, busy);

  return (
    <div
      ref={(el) => sortable.setItemRef(item.path, el)}
      data-selected={selected || undefined}
      className={`reorder-item project-reorder-item group relative flex touch-none items-stretch rounded-md pl-2 pr-7 h-8 ${
        selected
          ? "bg-selection-strong text-content"
          : "opacity-65"
      } cursor-default`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        sortable.onItemPointerDown(item.path, event);
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        if (sortable.consumeClick()) return;
        onSelect(item.path);
      }}
      onContextMenu={(event) => onContextMenu(item, event)}
      onKeyDown={(event) => {
        if (
          event.key !== "ContextMenu" &&
          !(event.shiftKey && event.key === "F10")
        ) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onOpenMenu(item, rect.left, rect.bottom, rect);
      }}
    >
      {worktreeControls && (
        <button
          type="button"
          data-no-drag
          aria-label="Show working copies"
          aria-expanded={worktreeControls.expanded}
          onClick={worktreeControls.toggle}
          className="mr-1 shrink-0 rounded text-content/45 hover:text-content"
        >
          <ChevronDown
            className={`size-3 ${worktreeControls.expanded ? "" : "-rotate-90"}`}
          />
        </button>
      )}
      <button
        type="button"
        title={muteStatus ? `${cardTitle}\n${muteStatus}` : cardTitle}
        aria-label={muteStatus ? `${cardAriaLabel}, ${muteStatus}` : cardAriaLabel}
        aria-current={selected ? "true" : undefined}
        className={`flex min-w-0 flex-1 cursor-default items-center gap-2 text-left transition-[padding] duration-150 motion-reduce:transition-none ${worktreeControls?.create ? "group-hover:pr-9 group-has-[:focus-visible]:pr-9" : "group-hover:pr-6 group-has-[:focus-visible]:pr-6"}`}
      >
        <div className="project-card-logo grid size-4 shrink-0 place-items-center transition-opacity group-hover:opacity-0">
          {logoPath && !busy ? (
            <ProjectLogoIcon
              path={logoPath}
              className="size-4 rounded-sm"
              imageClassName="size-4"
            />
          ) : (
            <ProjectMascot
              project={seed}
              color={color}
              name={resolveTabGroupMascot(key, groupMascots)}
              className="size-3"
              active={busy}
            />
          )}
        </div>
        {busy ? (
          <Shimmer as="span" duration={1.4} className={nameClassName}>
            {name}
          </Shimmer>
        ) : (
          <span className={nameClassName}>{name}</span>
        )}
        {hasChanges && !worktreeControls ? (
          <span className="project-card-stats shrink-0 group-hover:hidden group-has-[:focus-visible]:hidden">
            <ProjectDiffStat additions={additions} deletions={deletions} />
          </span>
        ) : null}
        {muteStatus ? (
          <span
            role="img"
            aria-label={muteStatus}
            title={muteStatus}
            className="grid size-4 shrink-0 place-items-center text-amber-400"
          >
            <BellOff className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          </span>
        ) : null}
      </button>
      <span className="group-hover:hidden">
        <WslBadge cwd={item.path} compact />
      </span>
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
        {worktreeControls?.create && (
          <button
            type="button"
            data-no-drag
            title="New worktree"
            aria-label={`New worktree in ${name}`}
            onClick={worktreeControls.create}
            className="invisible grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:visible group-has-[:focus-visible]:visible"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        )}
        <button
          type="button"
          data-no-drag
          title="Project options"
          aria-label="Project options"
          aria-haspopup="menu"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(
              item,
              event.detail === 0 ? rect.left : event.clientX,
              event.detail === 0 ? rect.bottom : event.clientY,
              rect,
            );
          }}
          className="invisible grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:visible group-has-[:focus-visible]:visible"
        >
          <MoreHorizontal className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <button
        type="button"
        data-no-drag
        title={pinned ? "Unpin project" : "Pin project"}
        aria-label={pinned ? "Unpin project" : "Pin project"}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(item.path, item.project);
        }}
        className={`absolute ${worktreeControls ? "left-6" : "left-2"} top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-sm text-content/55 opacity-0 pointer-events-none transition-opacity hover:text-content group-hover:pointer-events-auto group-hover:opacity-100`}
      >
        {pinned ? (
          <PinOff className="size-3.5" strokeWidth={1.75} />
        ) : (
          <Pin className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
    </div>
  );
}

function isBusyPath(path: string, busy: Set<string>): boolean {
  for (const other of busy) {
    if (sameProjectPath(path, other)) return true;
  }
  return false;
}

function ProjectDiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions <= 0 && deletions <= 0) return null;

  const label = [
    additions > 0 ? `+${additions}` : "",
    deletions > 0 ? `-${deletions}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      title={`${label} uncommitted`}
      className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-semibold tabular-nums"
    >
      {additions > 0 ? (
        <span className="text-emerald-400">+{additions}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-red-400">-{deletions}</span>
      ) : null}
    </span>
  );
}

function projectCardTitle(
  path: string,
  name: string,
  stats: GitDiffStats | null,
  busy: boolean,
): string {
  const parts = [name, path].filter(Boolean);
  if (busy) parts.push("Working");
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  if (files > 0 || additions > 0 || deletions > 0) {
    parts.push(
      [
        files > 0 ? `${files} ${files === 1 ? "file" : "files"} changed` : "",
        additions > 0 ? `+${additions}` : "",
        deletions > 0 ? `-${deletions}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return parts.join("\n");
}

function projectCardAriaLabel(
  name: string,
  stats: GitDiffStats | null,
  busy: boolean,
): string {
  const parts = [name];
  if (busy) parts.push("working");
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  if (files > 0) {
    parts.push(`${files} ${files === 1 ? "file" : "files"} changed`);
  }
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`-${deletions}`);
  return parts.join(", ");
}
