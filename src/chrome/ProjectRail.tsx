import { WslBadge } from "./WslBadge";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
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
  Trash2,
} from "./icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { probeRepositoryFamily, useRepositoryFamilies } from "../hooks/useRepositoryFamilies";
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
  createProjectGroup,
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
  subscribeWorkingCopyPreferences,
  type RepositoryFamily,
} from "../lib/repositoryFamilies";
import { useDragResize } from "../hooks/useDragResize";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useProjectDiffStats } from "../hooks/useProjectDiffStats";
import { useSortable } from "../hooks/useSortable";
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
import { pathKey, prettyCwd, projectKey, projectName, wslLocation } from "../lib/paths";
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
} from "../lib/tabGroups";
import { formatLiveElapsed, type LiveAgent } from "../lib/liveAgents";
import { HarnessIcon } from "./HarnessIcon";
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
import { Popover } from "./Popover";
import { WorktreePanel } from "./WorktreePicker";
import {
  archiveTask,
  removeTask,
  repositoryForChild,
  subscribeTaskWorkspaces,
  taskChildRepoLabel,
  taskForSession,
  taskWorkspacesSnapshot,
  loadTaskWorkspaces,
  projectForTask,
  type TaskChild,
  type TaskWorkspace,
} from "../lib/taskWorkspaces";
import type { SettingsSectionId } from "../lib/settings";

const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : IS_WIN
    ? "Reveal in File Explorer"
    : "Open Containing Folder";

function projectMenuExtraItems(
  pinned: boolean,
  canRemove: boolean,
  hasFolder: boolean,
): TabGroupMenuExtraItem[] {
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
      id: "background",
      label: "Background image",
      icon: ImagePlus,
    },
    pinned
      ? { id: "unpin", label: "Unpin project", icon: PinOff }
      : { id: "pin", label: "Pin project", icon: Pin },
    ...(hasFolder
      ? [{ id: "reveal", label: REVEAL_LABEL, icon: FolderOpen }]
      : []),
  ];
  if (canRemove) {
    items.push(
      { id: "archive", label: "Archive", icon: Archive, sepBefore: true },
      { id: "delete", label: "Delete", icon: Trash2, danger: true },
    );
  }
  return items;
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
  notesEnabled?: boolean;
  onOpenNotes?: () => void;
  notesActive?: boolean;
  onTogglePanel?: () => void;
  onSelectProject: (path: string) => void;
  onOpenProject: () => void;
  onNewTask?: (path: string, projectId?: string) => void;
  onOpenTask?: (taskId: string) => void;
  /** Just-created task — highlighted as current until a task session takes
   * over. Purely presentational; never launches work. */
  focusTaskId?: string;
  onEditTask?: (taskId: string) => void;
  /** Sessions currently needing input (approval or question) — per-child dots. */
  needsInputSessionIds?: ReadonlySet<string>;
  onRemoveProject?: (path: string, options: { purgeData: boolean }) => void;
  liveAgents?: LiveAgent[];
  activeSessionId?: string;
  onSelectAgent?: (sessionId: string) => void;
  settingsOpen?: boolean;
  settingsSection?: SettingsSectionId;
  onOpenSettings?: () => void;
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
  notesEnabled = true,
  onOpenNotes,
  notesActive = false,
  onTogglePanel,
  onSelectProject,
  onOpenProject,
  onNewTask,
  onOpenTask,
  focusTaskId,
  onEditTask,
  needsInputSessionIds,
  onRemoveProject,
  liveAgents = [],
  activeSessionId,
  onSelectAgent,
  settingsOpen = false,
  settingsSection = "general",
  onOpenSettings,
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
    () => subscribeRemovedWorktree(() => {
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
  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    path: string;
    projectKey: string;
    projectId?: string;
  } | null>(null);
  const [repositoriesProject, setRepositoriesProject] = useState<{
    path: string;
    projectId?: string;
  } | null>(null);
  const [taskMenu, setTaskMenu] = useState<{
    x: number;
    y: number;
    task: TaskWorkspace;
  } | null>(null);
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );


  /** Task owning the focused session — drives the scope highlight across all
   * of its repository rows, not just the host cwd. */
  const activeTask = useMemo(
    () => (activeSessionId ? taskForSession(activeSessionId)?.task : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, tasksRaw],
  );
  // The session's task wins; a just-created task fills the gap so it reads
  // as current in the rail before any session exists.
  const currentTaskId = activeTask?.id ?? focusTaskId;
  const scopeRepoIds = useMemo(
    () =>
      new Set(activeTask?.children.map((entry) => entry.repositoryId) ?? []),
    [activeTask],
  );
  const taskBusyIds = useMemo(() => {
    const busyIds = new Set(
      liveAgents.filter((agent) => !agent.done).map((agent) => agent.id),
    );
    const set = new Set<string>();
    for (const task of loadTaskWorkspaces()) {
      if (task.archived) continue;
      const ids = [
        ...(task.sessionIds ?? []),
        ...task.children.flatMap((entry) => entry.sessionIds),
      ];
      if (ids.some((id) => busyIds.has(id))) set.add(task.id);
    }
    return set;
    // tasksRaw changes on every store write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksRaw, liveAgents]);
  const railTasks = useMemo(() => {
    const live = loadTaskWorkspaces().filter((task) => !task.archived);
    const rank = (task: TaskWorkspace) =>
      task.id === currentTaskId
        ? 0
        : taskBusyIds.has(task.id)
          ? 1
          : 2;
    return [...live].sort(
      (a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt,
    );
    // tasksRaw changes on every store write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksRaw, currentTaskId, taskBusyIds]);
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

  const openProjectMenu = (item: RailProjectItem, x: number, y: number) => {
    setProjectMenu({
      x,
      y,
      path: item.path,
      projectKey: projectKey(item.path),
      projectId: item.project?.id,
    });
  };

  const onProjectContextMenu = (
    item: RailProjectItem,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openProjectMenu(item, event.clientX, event.clientY);
  };

  const openTaskMenu = (task: TaskWorkspace, x: number, y: number) => {
    setTaskMenu({ task, x, y });
  };

  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(
    null,
  );

  const closeAddMenu = () => setAddMenu(null);

  /** A pathless project — a pure group; opens its repositories sheet so the
   * user can add members right away. The group is unnamed until renamed via
   * its project menu. */
  const submitGroup = () => {
    const project = createProjectGroup();
    setRepositoriesProject({
      path: projectRailKey(project.id),
      projectId: project.id,
    });
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
    const subset = new Set(sections.projects.map((item) => item.path));
    const next = reorderSubset(railOrder, ids, subset);
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  const onTogglePin = (path: string) => {
    const isPinned = pinnedPaths.some((pinned) =>
      sameProjectPath(pinned, path),
    );
    const next = isPinned
      ? pinnedPaths.filter((pinned) => !sameProjectPath(pinned, path))
      : [...pinnedPaths, path];
    setPinnedPaths(next);
    savePinnedProjects(next);
  };

  const menuProject = projectMenu?.projectId
    ? storedProjects.find((entry) => entry.id === projectMenu.projectId)
    : undefined;

  /** Recent paths whose verified family belongs to the project — the paths the
   * rail actually lists for it. */
  const memberRecentPaths = (project: ProjectRecord) =>
    recents
      .filter((item) => projectContainsPath(project, item.path, families))
      .map((item) => item.path);

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
    const members = memberRecentPaths(project);
    for (const member of members)
      onRemoveProject?.(member, { purgeData });
    if (!members.includes(path) && !isProjectRailKey(path))
      onRemoveProject?.(path, { purgeData });
  };

  const onProjectMenuPick = (action: string) => {
    if (!projectMenu) return;
    const { path, projectKey, projectId } = projectMenu;
    const displayName =
      menuProject?.name ??
      resolveTabGroupLabel(projectKey, groupLabels, basename(path));
    if (action === "pin" || action === "unpin") onTogglePin(path);
    else if (action === "new-task") onNewTask?.(path, projectId);
    else if (action === "repositories") {
      setRepositoriesProject({ path, projectId });
    } else if (action === "background") {
      setBackgroundProject({
        project: projectKey,
        name: displayName,
      });
    } else if (action === "reveal") {
      if (!isProjectRailKey(path)) void revealPath(path);
    }
    else if (action === "archive") {
      removeProjectEntry(path, projectId, false);
    } else if (action === "delete") {
      setRemoving({ path, name: displayName, projectId });
    }
  };

  const onConfirmDelete = () => {
    if (!removing) return;
    removeProjectEntry(removing.path, removing.projectId, true);
    setRemoving(null);
  };

  const pinnedIds = sections.pinned.map((item) => item.path);
  const projectIds = sections.projects.map((item) => item.path);
  const pinnedSortable = useSortable(pinnedIds, onReorderPinned, {
    axis: "y",
    onActivate: onSelectProject,
  });
  const projectSortable = useSortable(projectIds, onReorderProjects, {
    axis: "y",
    onActivate: onSelectProject,
  });
  return (
    <nav
      ref={resize.setPaneRef}
      aria-label="Projects"
      className="sidebar-glass relative flex shrink-0 flex-col border-r border-content/10"
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
              active={inboxActive}
              dot={inboxUnseen}
              ariaLabel={inboxUnseen ? "Inbox, new items" : "Inbox"}
            />
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
                cwd={cwd}
                busy={busy}
                sortable={pinnedSortable}
                pinned
                searchActive={searchActive || inboxActive || notesActive}
                onSelect={onSelectProject}
                onTogglePin={onTogglePin}
                onContextMenu={onProjectContextMenu}
                onOpenMenu={openProjectMenu}
                scopeRepoIds={scopeRepoIds}
                groupLabels={groupLabels}
                groupColors={groupColors}
                groupCustomColors={groupCustomColors}
                groupLogos={groupLogos}
                groupMascots={groupMascots}
              />
            ) : null}

            <ProjectSection
              label="Projects"
              items={sections.projects}
              families={families}
              emptyLabel="No projects yet"
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
              scopeRepoIds={scopeRepoIds}
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
          onClose={() => setProjectMenu(null)}
          showActions={false}
          extraItems={projectMenuExtraItems(
            pinnedPaths.some((pinned) =>
              sameProjectPath(pinned, projectMenu.path),
            ),
            Boolean(onRemoveProject),
            !isProjectRailKey(projectMenu.path),
          )}
          onExtraPick={onProjectMenuPick}
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
          <div className="px-1.5 py-1.5">
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
              onClick={() => {
                onOpenTask?.(taskMenu.task.id);
                setTaskMenu(null);
              }}
            >
              Open task
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
              onClick={() => {
                onEditTask?.(taskMenu.task.id);
                setTaskMenu(null);
              }}
            >
              Edit task…
            </button>
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
                // Sessions and working copies survive — only the record goes.
                if (
                  window.confirm(
                    `Delete task “${taskMenu.task.name}”? Its sessions and working copies stay.`,
                  )
                )
                  removeTask(taskMenu.task.id);
                setTaskMenu(null);
              }}
            >
              Delete task
            </button>
          </div>
        </Popover>
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

type SortableHandle = ReturnType<typeof useSortable>;

const LIVE_AGENT_MIN = 2;
const LIVE_AGENT_CAP = 4;

function LiveAgentsPreview({
  agents,
  activeSessionId,
  taskBySessionId,
  onSelect,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: {
  agents: LiveAgent[];
  activeSessionId?: string;
  taskBySessionId?: ReadonlyMap<
    string,
    { task: TaskWorkspace; child: TaskChild }
  >;
  onSelect?: (sessionId: string) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lockList = useLockOverscroll<HTMLDivElement>();
  const ticking =
    agents.length >= LIVE_AGENT_MIN &&
    agents.some((agent) => !agent.done && agent.startedAt != null);

  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  if (agents.length < LIVE_AGENT_MIN) return null;

  const extra = agents.length - LIVE_AGENT_CAP;
  const visible =
    expanded || extra <= 0 ? agents : agents.slice(0, LIVE_AGENT_CAP);

  return (
    <div className="shrink-0 px-2">
      <div
        role="status"
        aria-label="Working agents"
        className="overflow-hidden rounded-lg bg-content/5"
      >
        <div className="flex items-center gap-2 px-3.5 py-1.5">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)] animate-pulse"
          />
          <span className="min-w-0 flex-1 truncate text-xs text-content/50">
            Working
          </span>
          <span className="text-[11px] tabular-nums text-content/40">
            {agents.length}
          </span>
        </div>
        <div
          ref={expanded ? lockList : undefined}
          className={`flex flex-col gap-px px-1 ${
            extra > 0 ? "" : "pb-1"
          } ${expanded ? "max-h-[45vh] overflow-y-auto overscroll-none" : ""}`}
        >
          {visible.map((agent) => (
            <LiveAgentCard
              key={agent.id}
              agent={agent}
              now={now}
              selected={agent.id === activeSessionId}
              taskScope={taskBySessionId?.get(agent.id)}
              onSelect={onSelect}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupMascots={groupMascots}
            />
          ))}
        </div>
        {extra > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="flex w-full items-center justify-center gap-1 px-2 py-1.5 text-[11px] text-content/50 hover:bg-content/8 hover:text-content"
          >
            {expanded ? (
              <ChevronUp className="size-3" strokeWidth={1.75} />
            ) : (
              <ChevronDown className="size-3" strokeWidth={1.75} />
            )}
            {expanded ? "Show less" : `${extra} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LiveAgentCard({
  agent,
  now,
  selected,
  taskScope,
  onSelect,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: {
  agent: LiveAgent;
  now: number;
  selected: boolean;
  taskScope?: { task: TaskWorkspace; child: TaskChild };
  onSelect?: (sessionId: string) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
}) {
  const seed = projectName(agent.cwd);
  const key = projectKey(agent.cwd);
  const project = resolveTabGroupLabel(key, groupLabels, seed);
  const color = resolveTabGroupColor(key, groupColors, groupCustomColors, seed);
  const elapsed = agent.done
    ? agent.durationMs != null
      ? formatLiveElapsed(0, agent.durationMs)
      : ""
    : agent.startedAt != null
      ? formatLiveElapsed(agent.startedAt, now)
      : "";
  const activity = agent.needsApproval
    ? "Need approval"
    : agent.done
      ? "Done"
      : agent.activity;
  const live = !agent.needsApproval && !agent.done;
  const title = [agent.title, project, activity, elapsed]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      type="button"
      title={title}
      aria-label={[agent.title, project, activity, elapsed]
        .filter(Boolean)
        .join(", ")}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect?.(agent.id)}
      className={`relative flex w-full flex-col rounded-md px-2 py-1.5 text-left ${
        selected ? "bg-content/10" : "hover:bg-content/8"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {taskScope ? (
          <Task
            className={`size-3 shrink-0 ${live ? "text-accent" : "text-content/40"}`}
            strokeWidth={1.75}
          />
        ) : (
          <ProjectMascot
            project={seed}
            color={color}
            name={resolveTabGroupMascot(key, groupMascots)}
            className="size-2 shrink-0"
            active={live}
          />
        )}
        {live ? (
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug">
            {agent.title}
          </p>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug">
            {agent.title}
          </span>
        )}
      </span>
      <span
        className={`mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] leading-tight ${
          agent.needsApproval
            ? "text-amber-400"
            : agent.done
              ? "text-emerald-400"
              : "text-content/50"
        }`}
      >
        {agent.needsApproval ? (
          <CircleAlert className="size-3 shrink-0" strokeWidth={1.75} />
        ) : agent.done ? (
          <Check className="size-3 shrink-0" strokeWidth={2.25} />
        ) : (
          <TerminalSpinner className="inline-block w-3 select-none text-center text-[11px] leading-none" />
        )}
        <span className="min-w-0 truncate">{activity}</span>
      </span>
      <span className="mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] leading-tight text-content/45">
        <HarnessIcon harness={agent.harness} className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {taskScope
            ? [
                taskScope.task.name,
                ...taskScope.task.children.map((child) =>
                  taskChildRepoLabel(taskScope.task, child),
                ),
              ].join(" · ")
            : project}
        </span>
        {elapsed ? (
          <span className="shrink-0 tabular-nums">{elapsed}</span>
        ) : null}
      </span>
    </button>
  );
}

function ProjectSection({
  label,
  items,
  families,
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
  scopeRepoIds,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  label: string;
  items: RailProjectItem[];
  families: ReadonlyMap<string, RepositoryFamily>;
  emptyLabel?: string;
  onAdd?: (event: MouseEvent<HTMLButtonElement>) => void;
  cwd: string;
  busy: Set<string>;
  sortable: SortableHandle;
  pinned: boolean;
  searchActive: boolean;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (item: RailProjectItem, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (
    item: RailProjectItem,
    x: number,
    y: number,
  ) => void;
  scopeRepoIds?: ReadonlySet<string>;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  return (
    <div className="shrink-0 mb-2">
      <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-content/50">
          {label}
        </span>
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
      {items.length === 0 && emptyLabel ? (
        <p className="px-4 pb-1 text-[11px] leading-tight text-content/40">
          {emptyLabel}
        </p>
      ) : null}
      <div className="flex flex-col gap-px px-2">
        {items.map((item, index) => (
          <ProjectFamilyCard
            key={item.path}
            item={item}
            family={families.get(pathKey(item.path))}
            families={families}
            cwd={cwd}
            busyPaths={busy}
            selected={!searchActive && sameProjectPath(item.path, cwd)}
            busy={isBusyPath(item.path, busy)}
            pinned={pinned}
            sortable={sortable}
            index={index}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            onContextMenu={onContextMenu}
            onOpenMenu={onOpenMenu}
            scopeRepoIds={scopeRepoIds}
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

const nameClassName =
  "min-w-0 flex-1 truncate text-sm font-medium leading-tight";

function useExpandedRow(key: string): [boolean | null, (next: boolean) => void] {
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
  onManage,
}: {
  family: RepositoryFamily;
  hidden: string[];
  cwd: string;
  busyPaths: Set<string>;
  recents: RecentProject[];
  onSelect: (path: string) => void;
  onManage: (event: MouseEvent<HTMLButtonElement>, path?: string) => void;
}) {
  const children = family.worktrees.filter(
    (child) =>
      sameProjectPath(child.path, cwd) ||
      !hidden.some((path) => sameProjectPath(path, child.path)),
  );
  return (
    <>
      {children.map((child) => {
        const name = workingCopyName(child, family);
        const active = sameProjectPath(child.path, cwd);
        const working = isBusyPath(child.path, busyPaths);
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
              className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pl-2 pr-7 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-content/30 disabled:opacity-40 ${active ? "bg-content/10 text-content" : "text-content/55 hover:bg-content/5 hover:text-content/85"}`}
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
            <button
              type="button"
              title="Worktree details and cleanup"
              aria-label={`Manage worktree ${name}`}
              className="invisible absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content group-hover/working-copy:visible group-focus-within/working-copy:visible focus-visible:ring-1 focus-visible:ring-content/30"
              onClick={(event) => onManage(event, child.path)}
            >
              <MoreHorizontal className="size-3" />
            </button>
          </div>
        );
      })}
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
  scoped = false,
  onSelect,
}: {
  repo: ProjectRecord["repositories"][number];
  /** The focused session's task spans this repository — secondary scope
   * highlight alongside the host's `active` state. */
  scoped?: boolean;
  families: ReadonlyMap<string, RepositoryFamily>;
  hidden: string[];
  cwd: string;
  busyPaths: Set<string>;
  recents: RecentProject[];
  onSelect: (path: string) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ create: boolean; path?: string } | null>(
    null,
  );
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
        (family?.worktrees.find((child) => child.main && !child.missing)?.path ||
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
            <ChevronDown
              className={`size-3 ${visible ? "" : "-rotate-90"}`}
            />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <button
          type="button"
          title={prettyCwd(repo.anchor)}
          aria-current={active ? "true" : undefined}
          className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pl-2 pr-7 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-content/30 group-hover/repository:pr-12 ${active ? "bg-content/10 text-content" : scoped ? "bg-accent/10 text-content/80 hover:bg-accent/15" : "text-content/55 hover:bg-content/5 hover:text-content/85"}`}
          onClick={openRepository}
        >
          <Folder
            className={`size-3 shrink-0 ${scoped ? "text-accent/70" : "text-content/40"}`}
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
            onManage={(event, path) => {
              anchor.current = event.currentTarget;
              setMenu({ create: false, path });
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
            key={`${menu.create}:${menu.path ?? ""}`}
            initialCreate={menu.create}
            initialPath={menu.path}
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
  needsInputIds,
  onOpen,
  onMenu,
  onNewTask,
}: {
  tasks: TaskWorkspace[];
  archivedTasks: TaskWorkspace[];
  currentTaskId?: string;
  busyIds: ReadonlySet<string>;
  needsInputIds?: ReadonlySet<string>;
  onOpen?: (taskId: string) => void;
  onMenu: (task: TaskWorkspace, x: number, y: number) => void;
  onNewTask?: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (!tasks.length && !archivedTasks.length) return null;
  // The rail stays compact — current and working tasks sort first, the
  // long tail hides behind a toggle like the archived list.
  const visibleTasks =
    showAll || tasks.length <= TASK_RAIL_CAP ? tasks : tasks.slice(0, TASK_RAIL_CAP);
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
        project={project}
        onOpen={() => onOpen?.(task.id)}
        onMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onMenu(task, event.clientX, event.clientY);
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
      <div className="flex flex-col gap-px px-2">
        {visibleTasks.map((task) => row(task))}
        {tasks.length > visibleTasks.length ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-content/40 hover:bg-content/5 hover:text-content/60"
          >
            {tasks.length - visibleTasks.length} more tasks
          </button>
        ) : null}
      </div>
      {archivedTasks.length ? (
        <div className="px-2 pt-1">
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((value) => !value)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-content/40 hover:bg-content/5 hover:text-content/60"
          >
            <ChevronDown
              className={`size-3 shrink-0 transition-transform ${showArchived ? "" : "-rotate-90"}`}
              strokeWidth={1.75}
            />
            Archived · {archivedTasks.length}
          </button>
          {showArchived ? (
            <div className="flex flex-col gap-px">
              {archivedTasks.map((task) => row(task, true))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One task row in the Tasks section — name, ticket ref, project +
 * repository meta, needs-input and working markers. Opens the task. */
function TaskRailRow({
  task,
  active = false,
  busy = false,
  archived = false,
  needsInput,
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
  const title = [
    ticket,
    task.name,
    repoNames || `${task.children.length} repos`,
    needsInput ? "Needs input" : undefined,
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
          ) : null}
          <span
            className={`min-w-0 flex-1 truncate ${
              needsInput ? "text-amber-400" : "text-content/45"
            }`}
          >
            {needsInput ? "Needs input" : ""}
            {needsInput && repoNames ? " · " : ""}
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
    scopeRepoIds?: ReadonlySet<string>;
  },
) {
  const {
    family,
    families,
    cwd,
    busyPaths,
    onSelect,
    scopeRepoIds,
  } = props;
  const project = props.item.project;
  const multiRepo = (project?.repositories.length ?? 0) > 1;
  /** Anchorless group — no own folder; the row exists to hold members. */
  const isGroup = !!project && !project.anchor;
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ create: boolean; path?: string } | null>(
    null,
  );
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
  const visible =
    expanded ?? (isGroup || (!multiRepo && children.length > 1));
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
              scoped={scopeRepoIds?.has(repo.id) ?? false}
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
            onManage={(event, path) => {
              anchor.current = event.currentTarget;
              setMenu({ create: false, path });
            }}
          />
        </div>
      )}
      {visible && !multiRepo && !isGroup && allChildren.length > children.length && (
        <button
          type="button"
          className="w-full rounded px-2 py-1 text-left text-[10px] text-content/50 hover:bg-content/5"
          onClick={(event) => { anchor.current = event.currentTarget; setMenu({ create: false }); }}
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
            if (!working) { setMenu(null); anchor.current?.focus(); }
          }}
          role="dialog"
          aria-label="Worktrees"
          className="flex flex-col overflow-hidden"
        >
          <WorktreePanel
            key={`${menu.create}:${menu.path ?? ""}`}
            initialCreate={menu.create}
            initialPath={menu.path}
            activeCwd={cwd}
            cwd={
              family?.worktrees.find(
                (entry) => !entry.missing && !entry.prunable,
              )?.path ?? props.item.path
            }
            onClose={() => { setMenu(null); anchor.current?.focus(); }}
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
  selected,
  busy,
  pinned,
  sortable,
  index,
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
  selected: boolean;
  busy: boolean;
  pinned: boolean;
  sortable: SortableHandle;
  index: number;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (item: RailProjectItem, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (item: RailProjectItem, x: number, y: number) => void;
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
    item.project?.name ??
    resolveTabGroupLabel(key, groupLabels, fallbackName);
  const logoPath = resolveTabGroupLogo(key, groupLogos);
  const color = resolveTabGroupColor(key, groupColors, groupCustomColors, seed);
  const dragging = sortable.draggingId === item.path;
  const showStart =
    sortable.draggingId &&
    sortable.toIndex === index &&
    sortable.fromIndex !== null &&
    sortable.toIndex < sortable.fromIndex;
  const showEnd =
    sortable.draggingId &&
    sortable.toIndex === index &&
    sortable.fromIndex !== null &&
    sortable.toIndex > sortable.fromIndex;
  const diffEnabled =
    Boolean(item.path) && item.path !== "~" && !groupRow;
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
      className={`group relative flex touch-none items-stretch rounded-md pl-2 pr-7 h-8 ${
        selected
          ? "bg-content/12 text-content"
          : "opacity-65 hover:bg-content/5 hover:text-content"
      } ${dragging ? "opacity-40" : ""} cursor-default`}
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
    >
      {showStart ? (
        <div className="pointer-events-none absolute inset-x-2 top-0 z-20 h-0.5 rounded-full bg-accent" />
      ) : null}
      {showEnd ? (
        <div className="pointer-events-none absolute inset-x-2 bottom-0 z-20 h-0.5 rounded-full bg-accent" />
      ) : null}
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
        title={cardTitle}
        aria-label={cardAriaLabel}
        aria-current={selected ? "true" : undefined}
        className={`flex min-w-0 flex-1 cursor-default items-center gap-2 text-left ${worktreeControls?.create ? "group-hover:pr-9" : "group-hover:pr-6"}`}
      >
        <div className="grid size-4 shrink-0 place-items-center transition-opacity group-hover:opacity-0">
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
          <span className="shrink-0 group-hover:hidden">
            <ProjectDiffStat additions={additions} deletions={deletions} />
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
            className="invisible grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:visible"
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
            onOpenMenu(item, event.clientX, event.clientY);
          }}
          className="invisible grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:visible"
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
          onTogglePin(item.path);
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
