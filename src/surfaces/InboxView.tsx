import { ACTION_FILLED, ACTION_OUTLINE, ACTION_GHOST } from "../chrome/inboxActions";
import { AzureInboxDetail } from "../chrome/AzureInboxDetail";
import { Select } from "../chrome/Select";

import { contextTicketKey } from "../lib/agentContext";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CheckCheck,
  Check,
  ChevronDown,
  CircleDot,
  CircleX,
  ExternalLink,
  GitCompare,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Inbox,
  MessageSquare,
  ListFilter,
  LoaderCircle,
  MessageMultiple,
  Plus,
  RefreshCw,
  Search,
  Task,
  type IconComponent,
} from "../chrome/icons";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  InboxFiltersMenu,
  INBOX_FILTER_MENU_WIDTH,
} from "../chrome/InboxFiltersMenu";
import { InboxConnectMenu } from "../chrome/InboxConnectMenu";
import { InboxProviderMark } from "../chrome/InboxProviderMark";
import { ContextCheckbox, InboxContextPicker, useInboxContext } from "../chrome/InboxContextPicker";
import type { InboxComposerCard } from "../lib/githubTasks";
import { ProjectLogoIcon } from "../chrome/ProjectLogoIcon";
import { ProjectMascot } from "../chrome/ProjectMascot";
import { OverlayNav } from "../chrome/TitleBar";
import { Popover } from "../chrome/Popover";
import {
  loadTaskWorkspaces,
  projectForTask,
  subscribeTaskWorkspaces,
  taskWorkspacesSnapshot,
} from "../lib/taskWorkspaces";
import { WindowControls } from "../chrome/WindowControls";
import { useDragResize } from "../hooks/useDragResize";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import {
  githubStatus,
  githubPrDiff,
  githubReviewDecisionLabel,
  githubWorkItem,
  githubWorkItemComment,
  githubWorkItemDetails,
  githubWorkItemThread,
  inboxItemKey,
  inboxItemRef,
  inboxItemStatus,
  inboxListIsFresh,
  inboxProjectsForRail,
  listInboxItems,
  peekGithubPrDiff,
  peekGithubWorkItemDetails,
  peekGithubWorkItemThread,
  peekInboxList,
  formatRelativeTime,
  inboxPersonAvatarUrl,
  type GithubLabel,
  type GithubPrDiff,
  type GithubWorkItemDetails,
  type GithubWorkItemThread,
  type InboxItem,
  type InboxProviderErrors,
  type InboxQuery,
  clearInboxCache,
} from "../lib/githubTasks";
import {
  applyInboxFilters,
  connectableInboxSources,
  hasActiveInboxFilters,
  loadInboxConnections,
  linearProjectOptions,
  inboxFetchState,
  loadInboxFilters,
  loadInboxSource,
  loadVisibleInboxSources,
  saveVisibleInboxSources,
  INBOX_SOURCE_LABELS,
  pruneInboxFilters,
  saveInboxFilters,
  resolveInboxSource,
  saveInboxConnections,
  saveInboxSource,
  visibleInboxSources,
  type ConnectableInboxSource,
  type InboxFilters,
  type InboxSource,
} from "../lib/inboxFilters";
import { projectKey, projectName } from "../lib/paths";
import { IS_MAC } from "../lib/platform";
import { sameProjectPath, type RecentProject } from "../lib/recents";
import { sessionDisplayTitle, type LinkedWorkItem } from "../lib/session";
import type { SessionSummary } from "../lib/sessionStore";
import {
  inboxRelatedSessionCounts,
  inboxItemMatchesLinkedWorkItem,
  linkedWorkItemInboxKey,
  sessionWorkItems,
  relatedSessionsForInboxItem,
} from "../lib/sessionWorkItem";
import {
  isInboxEntryUnseen,
  markInboxItemSeen,
  markInboxItemsSeen,
  useInboxSeenTick,
} from "../lib/inboxSeen";
import {
  LINEAR_CHANGE_EVENT,
  linearConnected,
  linearIssueComment,
  linearIssueDetails,
  linearIssueThread,
  listLinearTeams,
  loadHiddenLinearTeamIds,
  peekLinearIssueDetails,
  peekLinearIssueThread,
  saveHiddenLinearTeamIds,
  type LinearIssueThread,
  type LinearTeam,
} from "../lib/linear";
import {
  GITLAB_CHANGE_EVENT,
  gitlabConnected,
  gitlabMrDiff,
  gitlabWorkItemComment,
  gitlabWorkItemDetails,
  gitlabWorkItemThread,
  peekGitlabMrDiff,
  peekGitlabWorkItemDetails,
  peekGitlabWorkItemThread,
  type GitlabWorkItemThread,
} from "../lib/gitlab";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
} from "../lib/tabGroups";
import { AgentMarkdown } from "./AgentMarkdown";
import { TicketImages } from "./InboxMedia";
import { AZURE_CHANGE_EVENT, azureConnected, azureDetails, azureThread, peekAzureDetails, peekAzureThread, loadAzureFilter, type AzureFilter } from "../lib/azure";
import {
  InboxComments,
  InboxCommentForm,
  type InboxReplyTarget,
} from "./InboxComments";
import { InboxPrDiff } from "./InboxPrDiff";
import {
  InboxDiscussionPanel,
  type InboxSessionPortal,
} from "./InboxDiscussionPanel";
import { inboxAskKey } from "../lib/inboxAsk";
import {
  JIRA_CHANGE_EVENT,
  jiraConnected,
  jiraDetails,
  jiraThread,
  peekJiraDetails,
  peekJiraThread,
  jiraOptions,
  loadJiraFilter,
  saveJiraFilter,
  DEFAULT_JIRA_FILTER,
  type JiraFilter,
  type JiraOption,
} from "../lib/jira";

const MIN_WIDTH = 240;
const MAX_WIDTH = 420;

const DEFAULT_WIDTH = 280;

let rememberedWidth = DEFAULT_WIDTH;
const rememberedSelections: Partial<Record<InboxSource, string>> = {};

type InboxProjectOption = {
  path: string;
  name: string;
  logoPath: string | null;
  mascotName: string | null;
  mascotColor: string;
};

function inboxProjectOptions(
  projects: RecentProject[],
  logos: ReturnType<typeof useTabGroupLogos>,
): InboxProjectOption[] {
  const mascots = loadTabGroupMascots();
  const colors = loadTabGroupColors();
  const custom = loadTabGroupCustomColors();
  return [...projects]
    .map((project) => {
      const name = projectName(project.path);
      const key = projectKey(project.path);
      return {
        path: project.path,
        name,
        logoPath: resolveTabGroupLogo(key, logos),
        mascotName: resolveTabGroupMascot(key, mascots),
        mascotColor: resolveTabGroupColor(key, colors, custom, name),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function InboxProjectMark({
  project,
}: {
  project: Pick<
    InboxProjectOption,
    "name" | "logoPath" | "mascotName" | "mascotColor"
  >;
}) {
  if (project.logoPath) {
    return (
      <ProjectLogoIcon
        path={project.logoPath}
        className="size-3.5 shrink-0 rounded-sm"
        imageClassName="size-3.5"
      />
    );
  }
  return (
    <ProjectMascot
      project={project.name}
      color={project.mascotColor}
      name={project.mascotName}
      className="size-3 shrink-0"
    />
  );
}

function peekInboxForRail(recents: RecentProject[], cwd: string) {
  const projects = inboxProjectsForRail(recents, cwd);
  const filters = pruneInboxFilters(
    loadInboxFilters(),
    projects.map((project) => project.path),
  );
  return peekInboxList(projects, {
    assignedToMe: filters.assignedToMe,
    state: inboxFetchState(filters),
    search: "",
    linearHiddenTeamIds: loadHiddenLinearTeamIds(),
  });
}

function InboxSourceTab({
  source,
  selected,
  onSelect,
}: {
  source: InboxSource;
  selected: boolean;
  onSelect: (source: InboxSource) => void;
}) {
  const label = INBOX_SOURCE_LABELS[source];
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => onSelect(source)}
      aria-label={source === "azure" ? "Azure DevOps" : label}
      className={`flex h-6 min-w-0 flex-1 items-center justify-center rounded-md px-0.5 text-[11px] leading-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/50 ${
        selected
          ? "bg-content/10 text-content"
          : "text-content/50 hover:bg-content/5 hover:text-content"
      }`}
    >
      <span className="flex items-center gap-0.5">
        <InboxProviderMark
          provider={source}
          className="block size-4 shrink-0"
        />
        <span className="leading-none">{label}</span>
      </span>
    </button>
  );
}

function InboxDetailTab({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`relative flex h-9 items-center text-[12px] leading-none ${
        selected ? "text-content" : "text-content/50 hover:text-content"
      }`}
    >
      {label}
      {selected ? (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-content" />
      ) : null}
    </button>
  );
}

type Props = {
  onAsk: (item: InboxItem, context?: InboxComposerCard) => Promise<string>;
  onAskRestart: (item: InboxItem) => Promise<string>;
  onAskMount: (portal: InboxSessionPortal | null) => void;
  cwd: string;
  recents: RecentProject[];
  besideRail?: boolean;
  onClose?: () => void;
  onToggleSidebar?: () => void;
  onOpenSettings?: () => void;
  onStartTask?: (item: InboxItem, taskId: string | null) => void;
  sessions?: readonly SessionSummary[];
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenDelivery?: (sessionId: string, kind: "pr" | "ci", current: () => boolean, provider: "github" | "azure", prUrl?: string) => Promise<void>;
  /** Session-card destination to reveal after the Inbox list loads. */
  target?: LinkedWorkItem | null;
  visible?: boolean;
  conversationId?: string;
  conversationRevision?: number;
  selectionRevision?: number;
  onCloseConversation?: () => void;
  onToggleConversationTicket?: (sessionId: string, item: InboxItem, selected: boolean) => Promise<void>;
  onSendToTask?: (items: InboxItem[]) => void;
  /** Opens Settings on the card where the given source is connected. */
  onOpenIntegrations?: (source: ConnectableInboxSource) => void;
};

export function InboxView({
  onAsk,
  onAskRestart,
  onAskMount,
  cwd,
  recents,
  besideRail = false,
  onClose,
  onToggleSidebar,
  onOpenSettings,
  onStartTask,
  sessions = [],
  onOpenSession,
  onOpenDelivery,
  target = null,
  visible = true,
  conversationId,
  conversationRevision,
  selectionRevision = 0,
  onCloseConversation,
  onToggleConversationTicket,
  onSendToTask,
  onOpenIntegrations,
}: Props) {
  const [selectingTickets, setSelectingTickets] = useState(false);
  const [issuesCollapsed, setIssuesCollapsed] = useState(false);
  useEffect(() => { if (selectionRevision) { setSelectingTickets(true); setIssuesCollapsed(false); } }, [selectionRevision]);
  const [selectedTickets, setSelectedTickets] = useState<Map<string, InboxItem>>(new Map());
  const [selectionError, setSelectionError] = useState("");
  const [pendingTickets, setPendingTickets] = useState<Map<string, boolean>>(new Map());
  const conversationLinks = sessionWorkItems(sessions.find(session => session.id === conversationId) ?? {});
  const editingLinks = !!conversationId && !!onToggleConversationTicket;
  const selectionCount = editingLinks ? conversationLinks.length : selectedTickets.size;
  const ticketSelected = (item: InboxItem) => pendingTickets.get(contextTicketKey(item)) ?? (editingLinks ? conversationLinks.some(link => inboxItemMatchesLinkedWorkItem(item, link)) : selectedTickets.has(contextTicketKey(item)));
  const toggleTicket = (item: InboxItem) => {
    if (item.delivery) return;
    setSelectionError("");
    if (editingLinks) {
      const key = contextTicketKey(item);
      if (pendingTickets.has(key)) return;
      const selected = !ticketSelected(item);
      setPendingTickets(previous => new Map(previous).set(key, selected));
      void onToggleConversationTicket!(conversationId!, item, selected)
        .catch(error => setSelectionError(`Could not save ticket links: ${String(error)}`))
        .finally(() => setPendingTickets(previous => { const next = new Map(previous); next.delete(key); return next; }));
      return;
    }
    const identity = contextTicketKey(item);
    if (!selectedTickets.has(identity) && selectedTickets.size >= 20) { setSelectionError("Select at most 20 tickets."); return; }
    setSelectedTickets(previous => { const next = new Map(previous); if (next.has(identity)) next.delete(identity); else next.set(identity, { ...item }); return next; });
  };
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [previewingTicket, setPreviewingTicket] = useState(false);
  useEffect(() => setPreviewingTicket(false), [conversationId, conversationRevision]);
  useEffect(() => {
    if (visible) return;
    setSelectingTickets(false);
    setSelectedTickets(new Map());
    setSelectionError("");
    setDiscussionOpen(false);
  }, [visible]);
  const listLock = useLockOverscroll<HTMLDivElement>();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const logos = useTabGroupLogos();
  const [groupMascots] = useState(loadTabGroupMascots);
  const [groupColors] = useState(loadTabGroupColors);
  const [groupCustomColors] = useState(loadTabGroupCustomColors);

  const [searchInput, setSearchInput] = useState("");
  const [items, setItems] = useState<InboxItem[]>(
    () => peekInboxForRail(recents, cwd)?.items ?? [],
  );
  const [loading, setLoading] = useState(
    () => peekInboxForRail(recents, cwd) == null,
  );
  const [revalidating, setRevalidating] = useState(false);
  const [providerErrors, setProviderErrors] = useState<InboxProviderErrors>(
    () => peekInboxForRail(recents, cwd)?.errors ?? {},
  );
  const [refresh, setRefresh] = useState(0);
  const targetSelectionKey = target ? linkedWorkItemInboxKey(target) : null;
  const [selectedKey, setSelectedKey] = useState<string | null>(
    targetSelectionKey ?? rememberedSelections[loadInboxSource()] ?? null,
  );
  const [targetItem, setTargetItem] = useState<InboxItem | null>(null);
  const [filters, setFilters] = useState(loadInboxFilters);
  const [connections, setConnections] = useState(loadInboxConnections);
  const [source, setSource] = useState(() =>
    resolveInboxSource(loadInboxSource(), connections, loadVisibleInboxSources()),
  );
  const [connectMenuOpen, setConnectMenuOpen] = useState(false);
  const connectButtonRef = useRef<HTMLButtonElement | null>(null);
  const [preferredSources, setVisibleSources] = useState(loadVisibleInboxSources);
  const [filterMenu, setFilterMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [linearHiddenTeamIds, setLinearHiddenTeamIds] = useState(
    loadHiddenLinearTeamIds,
  );
  const [linearTeams, setLinearTeams] = useState<LinearTeam[]>([]);
  const [jiraSite, setJiraSite] = useState("");
  const [azureSite, setAzureSite] = useState("");
  const azureOwner = useRef("");
  const [azureFilter, setAzureFilter] = useState<AzureFilter>({ project: "", query: "", assigned: true });
  const [jiraFilter, setJiraFilter] = useState<JiraFilter>(DEFAULT_JIRA_FILTER);
  const [jiraProjects, setJiraProjects] = useState<JiraOption[]>([]);
  const [jiraFavorites, setJiraFavorites] = useState<JiraOption[]>([]);
  const [jiraOptionsError, setJiraOptionsError] = useState("");
  const prevRefresh = useRef(refresh);

  const projects = useMemo(
    () => inboxProjectsForRail(recents, cwd),
    [cwd, recents],
  );
  const projectOptions = useMemo(
    () => inboxProjectOptions(projects, logos),
    [logos, projects],
  );
  const linearProjects = useMemo(() => linearProjectOptions(items), [items]);
  const activeFilters = useMemo(
    () =>
      pruneInboxFilters(
        filters,
        projects.map((project) => project.path),
      ),
    [filters, projects],
  );
  const filtersActive =
    source === "azure" ? !!(azureFilter.query || !azureFilter.assigned || activeFilters.time !== "all" || activeFilters.status.open || activeFilters.status.closed) : source === "jira"
      ? !!(
          jiraFilter.project ||
          jiraFilter.filter ||
          !jiraFilter.assigned ||
          activeFilters.time !== "all" ||
          activeFilters.status.open ||
          activeFilters.status.closed
        )
      : hasActiveInboxFilters(activeFilters, source, linearHiddenTeamIds);
  const fetchState = inboxFetchState(activeFilters);
  const fetchQuery = useMemo<InboxQuery>(
    () => ({
      assignedToMe: activeFilters.assignedToMe,
      state: fetchState,
      search: "",
      linearHiddenTeamIds,
    }),
    [activeFilters.assignedToMe, fetchState, linearHiddenTeamIds],
  );

  const resize = useDragResize({
    min: MIN_WIDTH,
    max: () => Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.5)),
    defaultWidth: DEFAULT_WIDTH,
    initial: rememberedWidth,
    onCommit: (width) => {
      rememberedWidth = width;
    },
  });

  useEffect(() => {
    if (!visible) return;
    if (!target) return;
    setPreviewingTicket(true);
    setDiscussionOpen(false);
    setSelectedKey(linkedWorkItemInboxKey(target));
    setSource(target.provider ?? "github");
    setVisibleSources(previous => previous.includes(target.provider ?? "github") ? previous : [target.provider ?? "github", ...previous]);
    setSearchInput("");
  }, [target, visible]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (filterMenu) {
        setFilterMenu(null);
        return;
      }
      if (connectMenuOpen) {
        setConnectMenuOpen(false);
        return;
      }
      onCloseRef.current?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, connectMenuOpen, filterMenu]);

  useEffect(() => {
    if (!visible) return;
    const onChange = () => {
      setLinearHiddenTeamIds(loadHiddenLinearTeamIds());
      setRefresh((value) => value + 1);
    };
    window.addEventListener(LINEAR_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(LINEAR_CHANGE_EVENT, onChange);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onChange = () => setRefresh((value) => value + 1);
    window.addEventListener(GITLAB_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(GITLAB_CHANGE_EVENT, onChange);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const update = (changed = false) => {
      if (changed) clearInboxCache();
      void jiraConnected().then(status => {
        if (cancelled) return;
        setJiraSite(status.site);
        setConnections(prev => ({ ...prev, jira: status.connected }));
        setJiraProjects([]);
        setJiraFavorites([]);
        setJiraFilter(loadJiraFilter(status.site));
        if (changed) setRefresh(value => value + 1);
      }).catch(() => { /* The list shows the connection error locally. */ });
    };
    update();
    const onChange = () => update(true);
    window.addEventListener(JIRA_CHANGE_EVENT, onChange);
    return () => { cancelled = true; window.removeEventListener(JIRA_CHANGE_EVENT, onChange); };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    if (source !== "jira" || !jiraSite || !filterMenu) return;
    let cancelled = false;
    setJiraOptionsError("");
    void Promise.all([
      jiraOptions(jiraSite, false),
      jiraOptions(jiraSite, true),
    ])
      .then(([projects, favorites]) => {
        if (cancelled) return;
        setJiraProjects(projects);
        setJiraFavorites(favorites);
      })
      .catch((error) => {
        if (!cancelled) setJiraOptionsError(String(error));
      });
    return () => { cancelled = true; };
  }, [visible, source, jiraSite, !!filterMenu, refresh]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const update = (changed = false) => {
      if (changed) clearInboxCache();
      void azureConnected().then(status => {
        if (cancelled) return;
        const owner = status.connected ? `${status.site}:${status.accountId}` : "";
        if (changed && azureOwner.current !== owner) setItems(previous => previous.filter(item => item.provider !== "azure"));
        azureOwner.current = owner;
        setAzureSite(status.connected ? status.site : "");
        setConnections(prev => ({ ...prev, azure: status.connected }));
        setAzureFilter(loadAzureFilter(status.site, status.project));
        if (changed) setRefresh(value => value + 1);
      }).catch(() => { /* The list owns connection errors. */ });
    };
    update();
    const onChange = () => update(true);
    window.addEventListener(AZURE_CHANGE_EVENT, onChange);
    return () => { cancelled = true; window.removeEventListener(AZURE_CHANGE_EVENT, onChange); };
  }, [visible]);

  // The mount read does the real work: opening Settings unmounts this view, so
  // a token set there lands on the way back in. Reads can also overlap, and
  // only the newest may write, or a slow earlier answer restores a stale one.
  useEffect(() => {
    let cancelled = false;
    if (!visible) return;
    let latest = 0;
    const read = () => {
      const generation = ++latest;
      void Promise.allSettled([
        githubStatus(),
        linearConnected(),
        gitlabConnected(),
      ]).then(([github, linear, gitlab]) => {
        if (cancelled || generation !== latest) return;
        setConnections((prev) => ({
          ...prev,
          github:
            github.status === "fulfilled"
              ? github.value.connected
              : prev.github,
          linear:
            linear.status === "fulfilled"
              ? linear.value.connected
              : prev.linear,
          gitlab:
            gitlab.status === "fulfilled"
              ? gitlab.value.connected
              : prev.gitlab,
        }));
      });
    };
    read();
    window.addEventListener(LINEAR_CHANGE_EVENT, read);
    window.addEventListener(GITLAB_CHANGE_EVENT, read);
    return () => {
      cancelled = true;
      window.removeEventListener(LINEAR_CHANGE_EVENT, read);
      window.removeEventListener(GITLAB_CHANGE_EVENT, read);
    };
  }, [visible]);

  useEffect(() => {
    saveInboxConnections(connections);
  }, [connections]);

  // The initial source is resolved against cached status, so storage can still
  // name a provider this view has already fallen back from.
  useEffect(() => {
    saveInboxSource(source);
    // Mount only: the temporary switch to GitHub for a linked target must not
    // be persisted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Disconnecting can pull the tab out from under the current selection.
  useEffect(() => {
    const next = resolveInboxSource(source, connections, preferredSources);
    if (next === source) return;
    setSource(next);
    saveInboxSource(next);
  }, [connections, source, preferredSources]);

  const visibleSources = visibleInboxSources(connections).filter(source => preferredSources.includes(source));
  const connectableSources = connectableInboxSources(connections);
  const sourceAvailable = visibleSources.includes(source);
  const noSourcesConnected = visibleSources.length === 0;

  // The roster has to come from Linear, not from the fetched issues: hiding a
  // team drops its issues, so a derived list could never offer it back.
  useEffect(() => {
    if (!visible) return;
    if (source !== "linear") return;
    let cancelled = false;
    void listLinearTeams()
      .then((teams) => {
        if (!cancelled) setLinearTeams(teams);
      })
      .catch(() => {
        if (!cancelled) setLinearTeams([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, source, linearHiddenTeamIds]);

  useEffect(() => {
    if (!visible) return;
    const force = refresh !== prevRefresh.current;
    prevRefresh.current = refresh;
    const cached = peekInboxList(projects, fetchQuery);
    if (cached) {
      setItems(previous => [...cached.items, ...previous.filter(item =>
        (item.provider === "jira" && cached.errors.jira && jiraSite === item.site) ||
        (item.provider === "azure" && cached.errors.azure && azureSite === item.site)
      )]);
      setProviderErrors(cached.errors);
      setLoading(false);
    }
    if (!force && cached && inboxListIsFresh(projects, fetchQuery)) {
      return;
    }

    let cancelled = false;
    if (cached) setRevalidating(true);
    else {
      setLoading(true);
      setProviderErrors({});
    }
    void listInboxItems(projects, fetchQuery, { force })
      .then((next) => {
        if (cancelled) return;
        setItems(previous => [...next.items, ...previous.filter(item =>
          (item.provider === "jira" && next.errors.jira && jiraSite === item.site) ||
          (item.provider === "azure" && next.errors.azure && azureSite === item.site)
        )]);
        setProviderErrors(next.errors);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (cached) return;
        setItems([]);
        const message = err instanceof Error ? err.message : String(err);
        setProviderErrors({
          github: message,
          linear: message,
          gitlab: message,
          jira: message,
          azure: message,
        });
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRevalidating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [visible, fetchQuery, projects, refresh]);

  useEffect(() => {
    if (!visible) return;
    if (
      !target ||
      (target.provider && target.provider !== "github") ||
      items.some((item) => inboxItemMatchesLinkedWorkItem(item, target))
    ) {
      return;
    }
    let cancelled = false;
    void githubWorkItem(cwd, target.repo, target.kind, target.number)
      .then((item) => {
        if (cancelled) return;
        setTargetItem({
          ...item,
          projectPath: cwd,
          provider: "github",
        });
      })
      .catch(() => {
        // The normal Inbox remains usable when an exact lookup is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [visible, cwd, items, target, targetSelectionKey]);

  const visibleItems = useMemo(() => {
    if (!sourceAvailable) return [];
    const visible = applyInboxFilters(
      items,
      activeFilters,
      searchInput,
      Date.now(),
      source,
    );
    if (!target || source !== (target.provider ?? "github")) return visible;
    const targeted =
      items.find((item) => inboxItemMatchesLinkedWorkItem(item, target)) ??
      (targetItem && inboxItemMatchesLinkedWorkItem(targetItem, target)
        ? targetItem
        : null);
    if (!targeted || visible.includes(targeted)) return visible;
    return [targeted, ...visible];
  }, [
    activeFilters,
    items,
    searchInput,
    source,
    sourceAvailable,
    target,
    targetItem,
  ]);

  const relatedSessionCounts = useMemo(() => inboxRelatedSessionCounts(visibleItems, sessions), [visibleItems, sessions]);
  const selectTicketPreview = useCallback((item: InboxItem) => {
    const key = inboxItemKey(item);
    markInboxItemSeen({ key, updatedAt: item.updatedAt });
    setSelectedKey(key);
    setPreviewingTicket(true);
    setDiscussionOpen(false);
  }, []);

  const inboxSeenTick = useInboxSeenTick();
  const sourceEntries = useMemo(
    () =>
      sourceAvailable
        ? items
            .filter((item) => item.provider === source)
            .map((item) => ({
              key: inboxItemKey(item),
              updatedAt: item.updatedAt,
            }))
        : [],
    [items, source, sourceAvailable],
  );
  const sourceHasUnseen = useMemo(
    () => sourceEntries.some(isInboxEntryUnseen),
    [inboxSeenTick, sourceEntries],
  );

  const searchNarrowed = searchInput.trim().length > 0;
  const narrowedByUser = searchNarrowed || filtersActive;
  const sourceError = providerErrors[source] ?? null;

  const selectedByKey = visibleItems.find(
    (item) => inboxItemKey(item) === selectedKey,
  );
  const waitingForTarget =
    !!targetSelectionKey && selectedKey === targetSelectionKey;
  const selected =
    selectedByKey ?? (waitingForTarget ? null : visibleItems[0]) ?? null;

  useEffect(() => {
    if (!selected) {
      if (!targetSelectionKey) setSelectedKey(null);
      return;
    }
    const key = inboxItemKey(selected);
    rememberedSelections[source] = key;
    // Keep waiting while the exact cache-miss lookup loads. Otherwise the
    // current list's first row replaces the requested key.
    if (
      targetSelectionKey &&
      selectedKey === targetSelectionKey &&
      key !== targetSelectionKey
    ) {
      return;
    }
    if (key !== selectedKey) setSelectedKey(key);
  }, [selected, selectedKey, targetSelectionKey]);

  const onFiltersChange = (next: InboxFilters) => {
    const pruned = pruneInboxFilters(
      next,
      projects.map((project) => project.path),
    );
    setFilters(pruned);
    saveInboxFilters(pruned);
  };

  const onSourceChange = (next: InboxSource) => {
    setSelectedKey(rememberedSelections[next] ?? null);
    setSource(next);
    saveInboxSource(next);
  };

  const onVisibleSourcesChange = (next: InboxSource[]) => {
    if (!next.length) return;
    setVisibleSources(next);
    saveVisibleInboxSources(next);
    if (!next.includes(source)) onSourceChange(next[0]);
  };

  const onFilterButtonClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (filterMenu) {
      setFilterMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setFilterMenu({
      x: rect.right - INBOX_FILTER_MENU_WIDTH,
      y: rect.bottom + 2,
    });
  };

  const list = (
    <div
      ref={resize.setPaneRef}
      id="inbox-ticket-list"
      hidden={!!conversationId && issuesCollapsed}
      className={conversationId && issuesCollapsed ? "hidden" : "relative flex h-full min-h-0 shrink-0 flex-col border-r border-content/10"}
    >
      <div className="flex h-9 shrink-0 items-center gap-px border-b border-content/10 px-2">
        {visibleSources.length > 0 ? (
          <div
            role="tablist"
            aria-label="Inbox source"
            className="flex min-w-0 basis-0 items-center gap-px"
            style={{ flexGrow: visibleSources.length }}
          >
            {visibleSources.map((option) => (
              <InboxSourceTab
                key={option}
                source={option}
                selected={source === option}
                onSelect={onSourceChange}
              />
            ))}
          </div>
        ) : null}
        {connectableSources.length > 0 ? (
          <button
            ref={connectButtonRef}
            type="button"
            aria-label="Connect an inbox source"
            aria-haspopup="menu"
            aria-expanded={connectMenuOpen}
            title="Connect an inbox source"
            onClick={() => setConnectMenuOpen((open) => !open)}
            className={`flex h-6 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] leading-none ${
              connectMenuOpen
                ? "bg-content/10 text-content"
                : "text-content/40 hover:bg-content/5 hover:text-content"
            }`}
          >
            <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 truncate">Add connection</span>
          </button>
        ) : null}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-content/10 px-2">
        {selectingTickets ? <>
          <span className="min-w-0 flex-1 text-[12px] text-content/60">{selectionCount} {editingLinks ? "linked" : "selected"}</span>
          {!editingLinks ? <button type="button" disabled={!selectionCount} onClick={() => {
            void Promise.resolve(onSendToTask?.([...selectedTickets.values()]))
              .then(() => { setSelectedTickets(new Map()); setSelectingTickets(false); })
              .catch((error) => setSelectionError(String(error)));
          }} className="rounded-md bg-content/10 px-2 py-1 text-[11px] disabled:opacity-40">Send to task</button> : null}
          <button type="button" aria-label="Done selecting tickets" onClick={() => { setSelectedTickets(new Map()); setSelectingTickets(false); setSelectionError(""); }} className="rounded-md px-2 py-1 text-[11px] text-content/60 hover:bg-content/5">Done</button>
        </> : <>

        <div className="relative flex h-7 min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Filter inbox"
            aria-label="Filter inbox"
            spellCheck={false}
            autoComplete="off"
            className="h-7 w-full rounded-md bg-transparent pl-7 pr-2 text-[12px] text-content outline-none placeholder:text-content/40"
          />
        </div>
        <button
          type="button"
          title="Filters and visible sources"
          aria-label="Filter inbox"
          aria-expanded={!!filterMenu}
          aria-haspopup="menu"
          onClick={onFilterButtonClick}
          className={`grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content ${
            filterMenu || filtersActive ? "bg-content/10 text-content" : ""
          }`}
        >
          <ListFilter className="size-3" strokeWidth={1.75} />
        </button>
        {onSendToTask ? <button type="button" aria-label="Select tickets" title="Select tickets" onClick={() => { setSelectingTickets(true); setFilterMenu(null); setSelectionError(""); }} className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"><Check className="size-3.5" strokeWidth={1.75} /></button> : null}
        <button
          type="button"
          title="Mark all as read"
          aria-label="Mark all as read"
          disabled={!sourceHasUnseen}
          onClick={() => markInboxItemsSeen(sourceEntries)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-content/45"
        >
          <CheckCheck className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Refresh"
          onClick={() => setRefresh((value) => value + 1)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
        >
          {loading || revalidating ? (
            <LoaderCircle
              className="size-3.5 animate-spin"
              strokeWidth={1.75}
            />
          ) : (
            <RefreshCw className="size-3.5" strokeWidth={1.75} />
          )}
        </button>
        </>}
      </div>
      {selectionError ? <p role="alert" className="px-3 py-1 text-[11px] text-red-400">{selectionError}</p> : null}
      <div
        ref={listLock}
        className="min-h-0 flex-1 overflow-y-auto overscroll-none"
      >
        {sourceError && visibleItems.length > 0 ? <p role="status" className="px-3 py-2 text-[12px] text-content/50">{sourceError} <button type="button" onClick={() => setRefresh(value => value + 1)} className="underline">Retry</button></p> : null}
        {noSourcesConnected ? <p className="px-3 py-3 text-[12px] text-content/50">Add a connection to start using the Inbox.</p> : sourceError && visibleItems.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-content/50">
            <p>{sourceError}</p>
            {source === "azure" ? <div className="mt-2 flex gap-3">
              {onOpenSettings ? <button type="button" className="underline" onClick={onOpenSettings}>{azureSite ? "Connection settings" : "Connect Azure DevOps"}</button> : null}
              {azureSite ? <button type="button" className="underline" onClick={() => setRefresh(value => value + 1)}>Retry</button> : null}
            </div> : null}
            {source === "jira" ? <div className="mt-2 flex gap-3">
              {onOpenSettings ? <button type="button" className="underline" onClick={onOpenSettings}>{jiraSite ? "Connection settings" : "Connect Jira"}</button> : null}
              {jiraSite ? <button type="button" className="underline" onClick={() => setRefresh(value => value + 1)}>Retry</button> : null}
            </div> : null}
          </div>
        ) : loading && items.length === 0 ? (
          <div className="flex justify-center py-10 text-content/40">
            <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} />
          </div>
        ) : visibleItems.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-content/50">
            {source === "azure" ? "No Azure items match these filters" : source === "jira" ? "No Jira issues match these filters" : narrowedByUser
              ? searchNarrowed
                ? source === "linear"
                  ? "No matching Linear issues"
                  : source === "gitlab"
                    ? "No matching issues or merge requests"
                    : "No matching issues or pull requests"
                : source === "linear"
                  ? "No Linear issues match these filters"
                  : source === "gitlab"
                    ? "No GitLab items match these filters"
                    : "No issues or pull requests match these filters"
              : source === "linear"
                ? "No Linear issues"
                : source === "gitlab"
                  ? projects.length === 0
                    ? "Open a project to fill the inbox"
                    : "No matching issues or merge requests"
                  : projects.length === 0
                    ? "Open a project to fill the inbox"
                    : "No matching issues or pull requests"}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5 p-1.5">
            {visibleItems.map((item) => {
              const key = inboxItemKey(item);
              const projectId = projectKey(item.projectPath);
              return (
                <li key={key} className={selectingTickets ? "flex items-center gap-1" : undefined}>
                  {selectingTickets ? <ContextCheckbox label={`Select ${item.provider} ${item.identifier || item.number} ${item.title}`} checked={ticketSelected(item)} disabled={!!item.delivery || pendingTickets.has(contextTicketKey(item))} onChange={() => toggleTicket(item)} /> : null}
                  <div className="min-w-0 flex-1"><InboxCard
                    item={item}
                    active={selected != null && key === inboxItemKey(selected)}
                    logoPath={resolveTabGroupLogo(projectId, logos)}
                    mascotName={resolveTabGroupMascot(projectId, groupMascots)}
                    mascotColor={resolveTabGroupColor(
                      projectId,
                      groupColors,
                      groupCustomColors,
                      projectName(item.projectPath),
                    )}
                    relatedSessionCount={relatedSessionCounts.get(item) ?? 0}
                    onSelect={selectTicketPreview}
                  /></div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inbox list"
        className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-content/15" : "hover:bg-content/10"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
    </div>
  );

  const filtersPortal = filterMenu ? (
    <InboxFiltersMenu
      x={filterMenu.x}
      y={filterMenu.y}
      projects={projectOptions}
      linearProjects={linearProjects}
      linearTeams={linearTeams}
      hiddenLinearTeamIds={linearHiddenTeamIds}
      source={source}
      visibleSources={preferredSources}
      onVisibleSourcesChange={onVisibleSourcesChange}
      filters={activeFilters}
      onChange={onFiltersChange}
      onLinearTeamsChange={saveHiddenLinearTeamIds}
      jiraFilter={jiraFilter}
      azure={{ site: azureSite, filter: azureFilter }}
      jiraProjects={jiraProjects}
      jiraFavorites={jiraFavorites}
      jiraOptionsError={jiraOptionsError}
      onJiraFilterChange={next => { setJiraFilter(next); saveJiraFilter(jiraSite, next); }}
      onClose={() => setFilterMenu(null)}
    />
  ) : null;

  const connectPortal =
    connectMenuOpen && connectableSources.length > 0 ? (
      <InboxConnectMenu
        anchor={connectButtonRef}
        sources={connectableSources}
        onConnect={source => onOpenIntegrations?.(source)}
        onClose={() => setConnectMenuOpen(false)}
      />
    ) : null;

  return (
    <div
      role="region"
      aria-label="Inbox"
      data-app-inbox
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-content/10"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Inbox
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-content">Inbox</span>
          {conversationId ? <button type="button" aria-expanded={!issuesCollapsed} aria-controls="inbox-ticket-list" onClick={() => setIssuesCollapsed(value => !value)} className="rounded-md px-2 py-1 text-[11px] text-content/60 hover:bg-content/5">{issuesCollapsed ? "Show issues" : "Hide issues"}</button> : null}
          {conversationId && previewingTicket ? <button type="button" className="ml-auto rounded-md px-2 py-1 text-[11px] text-content/60 hover:bg-content/5" onClick={() => setPreviewingTicket(false)}>Back to conversation</button> : null}
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        {list}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <div
            hidden={!!conversationId && !previewingTicket}
            className={conversationId && !previewingTicket ? "hidden" : "min-h-0 min-w-0 flex-1"}
          >
            {target && !selected && selectedKey === targetSelectionKey && !loading && source === target.provider && target.provider !== "github" ? (
              <div role="status" className="p-4 text-[13px] text-content/60">
                <p className="mb-2 font-medium text-content">{target.title || target.identifier || `Issue ${target.number}`}</p>
                <p>This linked issue is not available in the current Inbox. Check the connected account and provider filters.</p>
              </div>
            ) : null}
            <InboxDetailBody
              item={selected}
              cwd={cwd}
              projects={projectOptions}
              revision={refresh}
              relatedSessions={
                selected ? relatedSessionsForInboxItem(selected, sessions) : []
              }
              onDiscuss={async context => {
                if (!selected) return;
                await onAsk(selected, context);
                setDiscussionOpen(true);
              }}
              onStartTask={onStartTask}
              onOpenDelivery={onOpenDelivery}
              onOpenSession={id => { setPreviewingTicket(false); return onOpenSession?.(id); }}
            />
          </div>
          {(conversationId && !previewingTicket) || (discussionOpen && selected) ? (
            <InboxDiscussionPanel
              onOpen={onAsk}
              onRestart={onAskRestart}
              onMount={onAskMount}
              key={conversationId ?? (selected ? inboxAskKey(selected) : "") }
              sessionId={conversationId}
              item={selected ?? undefined}
              onClose={() => { setDiscussionOpen(false); onCloseConversation?.(); }}
            />
          ) : null}
        </div>
      </div>
      {filtersPortal}
      {connectPortal}
    </div>
  );
}

function InboxDetailBody({
  item,
  cwd,
  projects,
  revision = 0,
  relatedSessions,
  onDiscuss,
  onStartTask,
  onOpenSession,
  onOpenDelivery,
}: {
  item: InboxItem | null;
  cwd: string;
  projects: InboxProjectOption[];
  revision?: number;
  relatedSessions: readonly SessionSummary[];
  onDiscuss?: (context: InboxComposerCard) => void | Promise<void>;
  onStartTask?: (item: InboxItem, taskId: string | null) => void;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenDelivery?: (sessionId: string, kind: "pr" | "ci", current: () => boolean, provider: "github" | "azure", prUrl?: string) => Promise<void>;
}) {
  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <Inbox className="mb-3 size-6 text-content/30" strokeWidth={1.75} />
        <p className="text-[13px] text-content/45">Select an inbox item</p>
      </div>
    );
  }
  if (item.delivery) return <AzureInboxDetail key={inboxItemKey(item)} item={item} cwd={cwd} projects={projects} relatedSessions={relatedSessions} onOpenSession={onOpenSession} onDiscuss={onDiscuss} />;
  return (
    <InboxDetail
      key={inboxItemKey(item)}
      item={item}
      cwd={cwd}
      projects={projects}
      revision={revision}
      relatedSessions={relatedSessions}
      onDiscuss={onDiscuss}
      onStartTask={onStartTask}
      onOpenSession={onOpenSession}
      onOpenDelivery={onOpenDelivery}
    />
  );
}

type InboxStatusMark = {
  Icon: IconComponent;
  className: string;
  label: string;
};

/** Status reads from the glyph first and the color second, so it survives color blindness. */
function inboxStatusMark(item: InboxItem): InboxStatusMark {
  const label = inboxItemStatus(item);
  if (item.kind === "ci") return {Icon:CircleX,className:"text-rose-400/90",label:"Needs attention"};
  const pr = item.kind === "pr";
  if (label === "Draft") {
    return {
      Icon: GitPullRequestDraft,
      className: "text-content/50",
      label,
    };
  }
  if (label === "Merged") {
    return { Icon: GitMerge, className: "text-violet-400/90", label };
  }
  if (label === "Closed") {
    return {
      Icon: pr ? GitPullRequestClosed : CircleX,
      className: "text-rose-400/90",
      label,
    };
  }
  return {
    Icon: pr ? GitPullRequest : CircleDot,
    className: label === "Unknown" ? "text-content/50" : "text-emerald-400/90",
    label,
  };
}

const InboxCard = memo(function InboxCard({
  item,
  active,
  logoPath,
  mascotName,
  mascotColor,
  relatedSessionCount,
  onSelect,
}: {
  item: InboxItem;
  active: boolean;
  logoPath: string | null;
  mascotName: string | null;
  mascotColor: string;
  relatedSessionCount: number;
  onSelect: (item: InboxItem) => void;
}) {
  useInboxSeenTick();
  const status = inboxStatusMark(item);
  const kindLabel =
    item.kind === "ci" ? "CI" : item.kind === "pr"
      ? item.provider === "gitlab"
        ? "Merge request"
        : "Pull request"
      : "Issue";
  const time = formatRelativeTime(item.updatedAt);
  const name = projectName(item.projectPath);
  const linear = item.provider === "linear";
  const jira = item.provider === "jira";
  const azure = item.provider === "azure";
  const source = azure ? `${item.site?.split("/").pop()} / ${item.projectName}` : jira ? item.projectName : linear ? item.teamName || item.repo : item.repo || name;
  const unseen = isInboxEntryUnseen({
    key: inboxItemKey(item),
    updatedAt: item.updatedAt,
  });

  return (
    <button
      type="button"
      title={item.title}
      aria-current={active ? "true" : undefined}
      aria-label={`${jira || azure ? item.state : status.label} ${kindLabel.toLowerCase()} ${inboxItemRef(
        item,
      )}: ${item.title}${unseen ? ", new" : ""}${relatedSessionCount > 0 ? `, ${relatedSessionCount} related ${relatedSessionCount === 1 ? "thread" : "threads"}` : ""}`}
      onClick={() => onSelect(item)}
      className={`flex w-full flex-col rounded-md border px-2.5 py-2 text-left ${
        active
          ? "border-transparent bg-content/10 text-content"
          : "border-transparent text-content/80 hover:bg-content/5 hover:text-content"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <InboxProviderMark
            provider={item.provider}
            className="size-3.5 shrink-0"
          />
          <status.Icon
            className={`size-3 shrink-0 ${status.className}`}
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-[11px] text-content/50">
            {jira || (azure && !item.delivery) ? "" : `${kindLabel} · `}{inboxItemRef(item)}
          </span>
        </span>
        {relatedSessionCount > 0 || time || unseen ? (
          <span className="flex shrink-0 items-center gap-1.5">
            {relatedSessionCount > 0 ? (
              <span
                title={`${relatedSessionCount} related ${relatedSessionCount === 1 ? "thread" : "threads"}`}
                className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-accent"
              >
                <MessageMultiple className="size-3" strokeWidth={1.75} />
                {relatedSessionCount}
              </span>
            ) : null}
            {time ? (
              <span className="text-[11px] tabular-nums text-content/45">
                {time}
              </span>
            ) : null}
            {unseen ? (
              <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            ) : null}
          </span>
        ) : null}
      </span>
      <span className="mt-1 line-clamp-1 text-[13px] font-semibold leading-snug text-content">
        {item.title}
      </span>
      <span className="mt-1 flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-content/45">
          {linear || jira || azure ? null : logoPath ? (
            <ProjectLogoIcon
              path={logoPath}
              className="size-3.5 shrink-0 rounded-sm"
              imageClassName="size-3.5"
            />
          ) : (
            <ProjectMascot
              project={name}
              color={mascotColor}
              name={mascotName}
              className="size-3 shrink-0"
            />
          )}
          {jira || azure ? <span className="max-w-[55%] truncate" title={item.state}>{item.state} ·</span> : null}
          <span className="min-w-0 truncate">{source}</span>
        </span>
        {!azure && item.labels.length > 0 ? (
          <span className="flex min-w-0 shrink-0 items-center gap-1">
            {item.labels.slice(0, 2).map((label) => (
              <InboxLabel key={label.name} label={label} compact />
            ))}
          </span>
        ) : null}
      </span>
    </button>
  );
});

export function InboxDetail({
  item,
  cwd,
  projects,
  revision,
  relatedSessions,
  onDiscuss,
  onStartTask,
  onOpenSession,
  onOpenDelivery,
}: {
  item: InboxItem;
  cwd: string;
  projects: InboxProjectOption[];
  revision: number;
  relatedSessions: readonly SessionSummary[];
  onDiscuss?: (context: InboxComposerCard) => void | Promise<void>;
  onStartTask?: (item: InboxItem, taskId: string | null) => void;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenDelivery?: (sessionId: string, kind: "pr" | "ci", current: () => boolean, provider: "github" | "azure", prUrl?: string) => Promise<void>;
}) {
  const detailLock = useLockOverscroll<HTMLDivElement>();
  const [deliveryProviders, setDeliveryProviders] = useState<Record<string, "github" | "azure">>(() => {
    try { const saved = JSON.parse(localStorage.getItem("monocode.inboxDeliveryProviders.v1") || "{}"); return saved && typeof saved === "object" && !Array.isArray(saved) ? Object.fromEntries(Object.entries(saved).filter(([, value]) => value === "github" || value === "azure").slice(-100)) as Record<string, "github" | "azure"> : {}; }
    catch { return {}; }
  });
  const [choosingProviders, setChoosingProviders] = useState<string | null>(null);
  const providerKey = (sessionId: string, kind: "pr" | "ci") => JSON.stringify([contextTicketKey(item), sessionId, kind]);
  const deliveryProvider = (sessionId: string, kind: "pr" | "ci") => {
    const saved = deliveryProviders[providerKey(sessionId, kind)];
    return saved === "github" || saved === "azure" ? saved : item.provider === "github" || item.provider === "azure" ? item.provider : undefined;
  };
  const saveProvider = (sessionId: string, kind: "pr" | "ci", provider: string) => {
    if (provider !== "" && provider !== "github" && provider !== "azure") return;
    const key = providerKey(sessionId, kind);
    const next = Object.fromEntries([...Object.entries(deliveryProviders).filter(([entry]) => entry !== key), ...(provider ? [[key, provider]] : [])].slice(-100));
    try { localStorage.setItem("monocode.inboxDeliveryProviders.v1", JSON.stringify(next)); setDeliveryProviders(next); }
    catch { setDeliveryError("Could not save delivery providers. Try again."); }
  };
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [deliveryError, setDeliveryError] = useState("");
  const [sendMenu, setSendMenu] = useState(false);
  const sendAnchor = useRef<HTMLButtonElement>(null);
  const deliveryPending = useRef(false);
  const deliveryMounted = useRef(true);
  useEffect(() => { deliveryMounted.current = true; return () => { deliveryMounted.current = false; }; }, []);
  const openDelivery = async (sessionId: string, kind: "pr" | "ci") => {
    if (!onOpenDelivery || deliveryPending.current) return;
    const provider = deliveryProvider(sessionId, kind);
    if (!provider) { setChoosingProviders(sessionId); return; }
    deliveryPending.current = true;
    setDeliveryBusy(true);
    setDeliveryError("");
    try { await onOpenDelivery(sessionId, kind, () => deliveryMounted.current, provider, item.provider === "github" && item.kind === "pr" ? item.url : undefined); }
    catch (error) { if (deliveryMounted.current) setDeliveryError(error instanceof Error ? error.message : String(error)); }
    finally { deliveryPending.current = false; if (deliveryMounted.current) setDeliveryBusy(false); }
  };
  const linear = item.provider === "linear";
  const jira = item.provider === "jira";
  const azure = item.provider === "azure";
  const ticket = linear || jira || azure;
  const gitlab = item.provider === "gitlab";
  const isPr = !linear && item.kind === "pr";
  const githubKind =
    item.provider === "github" && (item.kind === "issue" || item.kind === "pr")
      ? item.kind
      : null;
  const gitlabKind =
    gitlab && (item.kind === "issue" || item.kind === "pr") ? item.kind : null;
  const cached = azure ? peekAzureDetails(item) : jira ? peekJiraDetails(item) : linear
    ? peekLinearIssueDetails(item.id ?? "")
    : gitlabKind
      ? peekGitlabWorkItemDetails(item.projectPath, gitlabKind, item.number)
      : githubKind
        ? peekGithubWorkItemDetails(item.projectPath, githubKind, item.number)
        : null;
  const cachedDiff = isPr
    ? gitlab
      ? peekGitlabMrDiff(item.projectPath, item.number)
      : peekGithubPrDiff(item.projectPath, item.number)
    : null;
  const cachedThread = azure ? peekAzureThread(item) : jira ? peekJiraThread(item) : linear
    ? peekLinearIssueThread(item.id ?? "")
    : gitlabKind
      ? peekGitlabWorkItemThread(item.projectPath, gitlabKind, item.number)
      : githubKind
        ? peekGithubWorkItemThread(item.projectPath, githubKind, item.number)
        : null;
  const [details, setDetails] = useState<GithubWorkItemDetails | null>(cached);
  const [loading, setLoading] = useState(cached == null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"summary" | "code">("summary");
  const [prDiff, setPrDiff] = useState<GithubPrDiff | null>(cachedDiff);
  const [diffLoading, setDiffLoading] = useState(isPr && cachedDiff == null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [thread, setThread] = useState<
    GithubWorkItemThread | LinearIssueThread | GitlabWorkItemThread | null
  >(cachedThread);
  const [threadLoading, setThreadLoading] = useState(cachedThread == null);
  const galleryAttachments = [...new Map([
    ...(details?.attachments ?? []),
    ...(azure && thread && "attachments" in thread ? thread.attachments ?? [] : []),
  ].map(file => [file.id, file])).values()];
  const [threadError, setThreadError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<InboxReplyTarget | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const defaultProject =
    projects.find((project) => sameProjectPath(project.path, cwd))?.path ??
    projects[0]?.path ??
    cwd;
  const [startProject, setStartProject] = useState(defaultProject);
  const context = useInboxContext(item);
  const [sendError, setSendError] = useState("");
  const [retry, setRetry] = useState(0);
  const status = ticket
    ? item.state || inboxItemStatus(item)
    : inboxItemStatus(item);
  const statusMark = inboxStatusMark(item);

  const source = azure ? `${item.site?.split("/").pop()} / ${item.projectName}` : jira ? item.projectName : linear
    ? item.teamName || item.repo
    : item.repo || projectName(item.projectPath);
  const markdownCwd = ticket ? startProject || cwd : item.projectPath || cwd;
  const authorName = details?.author?.trim() ?? "";
  const extraAssignees = item.assignees.filter(
    (person) =>
      !authorName ||
      person.login.trim().toLowerCase() !== authorName.toLowerCase(),
  );
  const showAssignment =
    extraAssignees.length > 0 || item.assignees.length === 0;
  const reviewDecision =
    details?.reviewDecision?.trim() || thread?.reviewDecision?.trim() || "";
  const reviewLabel = githubReviewDecisionLabel(reviewDecision);
  const reviewClass =
    reviewDecision.toUpperCase() === "APPROVED"
      ? "text-emerald-400/90"
      : reviewDecision.toUpperCase() === "CHANGES_REQUESTED"
        ? "text-rose-400/90"
        : "text-content/50";
  const baseRef =
    details?.baseRefName?.trim() || thread?.baseRefName?.trim() || "";
  const headRef =
    details?.headRefName?.trim() || thread?.headRefName?.trim() || "";

  useEffect(() => {
    let cancelled = false;
    const cachedDetails = azure ? peekAzureDetails(item) : jira ? peekJiraDetails(item) : linear
      ? peekLinearIssueDetails(item.id ?? "")
      : gitlabKind
        ? peekGitlabWorkItemDetails(item.projectPath, gitlabKind, item.number)
        : githubKind
          ? peekGithubWorkItemDetails(item.projectPath, githubKind, item.number)
          : null;
    if (cachedDetails) {
      setDetails(cachedDetails);
      setLoading(false);
      setError(null);
    } else {
      setLoading(true);
      setError(null);
      setDetails(null);
    }
    const pending = azure ? azureDetails(item) : jira ? jiraDetails(item) : linear
      ? item.id
        ? linearIssueDetails(item.id)
        : Promise.reject(new Error("Missing Linear issue"))
      : gitlabKind
        ? gitlabWorkItemDetails(item.projectPath, gitlabKind, item.number)
        : githubKind
          ? githubWorkItemDetails(item.projectPath, githubKind, item.number)
          : Promise.reject(new Error("Unknown inbox item"));
    void pending
      .then((next) => {
        if (cancelled) return;
        setDetails(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (cachedDetails && !jira && !azure) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    githubKind,
    gitlabKind,
    item.id,
    item.number,
    item.projectPath,
    linear,
    revision,
    jira,
    retry,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (ticket) {
      const id = item.id ?? "";
      const cachedThread = azure ? peekAzureThread(item) : jira ? peekJiraThread(item) : peekLinearIssueThread(id);
      if (cachedThread) {
        setThread(cachedThread);
        setThreadLoading(false);
        setThreadError(null);
      } else {
        setThreadLoading(true);
        setThreadError(null);
        setThread(null);
      }
      void (azure ? azureThread(item) : jira ? jiraThread(item) : linearIssueThread(id))
        .then((next) => {
          if (cancelled) return;
          setThread(next);
          setThreadError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (cachedThread && !jira && !azure) return;
          setThreadError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setThreadLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    if (gitlabKind) {
      const cachedThread = peekGitlabWorkItemThread(
        item.projectPath,
        gitlabKind,
        item.number,
      );
      if (cachedThread) {
        setThread(cachedThread);
        setThreadLoading(false);
        setThreadError(null);
      } else {
        setThreadLoading(true);
        setThreadError(null);
        setThread(null);
      }
      void gitlabWorkItemThread(item.projectPath, gitlabKind, item.number)
        .then((next) => {
          if (cancelled) return;
          setThread(next);
          setThreadError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (cachedThread) return;
          setThreadError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setThreadLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    if (!githubKind) return;
    const cachedThread = peekGithubWorkItemThread(
      item.projectPath,
      githubKind,
      item.number,
    );
    if (cachedThread) {
      setThread(cachedThread);
      setThreadLoading(false);
      setThreadError(null);
    } else {
      setThreadLoading(true);
      setThreadError(null);
      setThread(null);
    }
    void githubWorkItemThread(item.projectPath, githubKind, item.number)
      .then((next) => {
        if (cancelled) return;
        setThread(next);
        setThreadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (cachedThread) return;
        setThreadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setThreadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    githubKind,
    gitlabKind,
    item.id,
    item.number,
    item.projectPath,
    linear,
    revision,
    jira,
    retry,
  ]);

  useEffect(() => {
    if (!isPr || tab !== "code") return;
    let cancelled = false;
    const cachedDiff = gitlab
      ? peekGitlabMrDiff(item.projectPath, item.number)
      : peekGithubPrDiff(item.projectPath, item.number);
    if (cachedDiff) {
      setPrDiff(cachedDiff);
      setDiffLoading(false);
      setDiffError(null);
    } else {
      setDiffLoading(true);
      setDiffError(null);
      setPrDiff(null);
    }
    const pending = gitlab
      ? gitlabMrDiff(item.projectPath, item.number)
      : githubPrDiff(item.projectPath, item.number);
    void pending
      .then((next) => {
        if (cancelled) return;
        setPrDiff(next);
        setDiffError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (cachedDiff) return;
        setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gitlab, isPr, item.number, item.projectPath, revision, tab]);

  const postComment = async (body: string) => {
    setPosting(true);
    setPostError(null);
    try {
      if (linear) {
        const id = item.id ?? "";
        await linearIssueComment(id, body, { parentId: replyTo?.id });
        setReplyTo(null);
        try {
          setThread(await linearIssueThread(id, { force: true }));
        } catch (err: unknown) {
          setPostError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (gitlabKind) {
        await gitlabWorkItemComment(
          item.projectPath,
          gitlabKind,
          item.number,
          body,
        );
        setReplyTo(null);
        try {
          setThread(
            await gitlabWorkItemThread(
              item.projectPath,
              gitlabKind,
              item.number,
              { force: true },
            ),
          );
        } catch (err: unknown) {
          setPostError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (!githubKind) throw new Error("Unknown inbox item");
      await githubWorkItemComment(
        item.projectPath,
        githubKind,
        item.number,
        body,
        { inReplyTo: replyTo?.threadId },
      );
      setReplyTo(null);
      try {
        setThread(
          await githubWorkItemThread(
            item.projectPath,
            githubKind,
            item.number,
            {
              force: true,
            },
          ),
        );
      } catch (err: unknown) {
        setPostError(err instanceof Error ? err.message : String(err));
      }
    } catch (err: unknown) {
      setPostError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div data-inbox-detail-header className="relative z-10 shrink-0 border-b border-content/10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-2.5 px-8 pt-5 pb-5">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[12px] text-content/50">
          <InboxProviderMark provider={item.provider} className="size-3.5" />
          {azure ? null : <span>
            {item.kind === "pr"
              ? gitlab
                ? "Merge request"
                : "Pull request"
              : "Issue"}
          </span>}
          <span className="tabular-nums">{inboxItemRef(item)}</span>
          <span className={`flex items-center gap-1 ${statusMark.className}`}>
            <statusMark.Icon className="size-3.5" strokeWidth={1.75} />
            {status}
          </span>
          {source ? <span className="truncate">{source}</span> : null}
        </div>
        <h1 title={item.title}
          className="line-clamp-2 text-[20px] font-semibold leading-tight text-content">
          {item.title}
        </h1>
        <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[12px] text-content/50">
          {authorName ? (
            <InboxPerson
              name={authorName}
              avatarUrl={inboxPersonAvatarUrl(
                item.provider,
                authorName,
                details?.authorAvatarUrl,
              )}
              size={16}
            />
          ) : null}
          {showAssignment ? (
            <>
              {authorName ? <span aria-hidden>·</span> : null}
              {extraAssignees.length > 0 ? (
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  {extraAssignees.map((person) => (
                    <InboxPerson
                      key={person.login}
                      name={person.login}
                      avatarUrl={inboxPersonAvatarUrl(
                        item.provider,
                        person.login,
                        person.avatarUrl,
                      )}
                      size={16}
                    />
                  ))}
                </span>
              ) : (
                <span>Unassigned</span>
              )}
            </>
          ) : null}
          {formatRelativeTime(item.updatedAt) ? (
            <>
              <span aria-hidden>·</span>
              <span>Updated {formatRelativeTime(item.updatedAt)}</span>
            </>
          ) : null}
          {baseRef && headRef ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex min-w-0 items-center gap-1">
                <GitCompare className="size-3 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 truncate">
                  {baseRef} ← {headRef}
                </span>
              </span>
            </>
          ) : null}
          {reviewLabel ? (
            <>
              <span aria-hidden>·</span>
              <span className={reviewClass}>{reviewLabel}</span>
            </>
          ) : null}
        </div>
        {relatedSessions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 inline-flex items-center gap-1 text-[11px] text-content/45">
              <MessageMultiple className="size-3.5" strokeWidth={1.75} />
              Related {relatedSessions.length === 1 ? "thread" : "threads"}
            </span>
            {relatedSessions.map((session) => {
              const title = sessionDisplayTitle(session.title, session.harness);
              return (
                <span key={session.id} className="inline-flex items-center gap-0.5">
                <button
                  type="button"
                  title={`Open thread: ${title}`}
                  onClick={() => void onOpenSession?.(session.id)}
                  className="inline-flex max-w-64 items-center gap-1 rounded-md bg-content/5 px-2 py-1 text-[11px] text-content/70 hover:bg-content/10 hover:text-content"
                >
                  <span className="truncate">{title}</span>
                  {session.archived ? (
                    <span className="shrink-0 text-content/40">Archived</span>
                  ) : null}
                </button>                  {onOpenDelivery && session.cwd ? ([['pr', 'PRs'], ['ci', 'CI']] as const).map(([kind, label]) => (
                    <button key={kind} type="button" aria-label={`${label} for ${title}`} title={`${label} · ${session.cwd}`} disabled={deliveryBusy}
                      className="h-6 rounded-md px-1.5 text-[11px] text-content/50 hover:bg-content/5 hover:text-content focus-visible:outline-accent disabled:opacity-40"
                      onClick={() => void openDelivery(session.id, kind)}>{deliveryProvider(session.id, kind) === "github" ? `GitHub ${label} ↗` : deliveryProvider(session.id, kind) === "azure" ? `Azure ${label}` : `Choose ${label}`}</button>
                  )) : null}
                  {onOpenDelivery && session.cwd ? <button type="button" aria-label={`Delivery providers for ${title}`} className="h-6 rounded-md px-1.5 text-[11px] text-content/40 hover:bg-content/5" onClick={() => setChoosingProviders(choosingProviders === session.id ? null : session.id)}>Providers</button> : null}
                  {choosingProviders === session.id ? <span className="flex flex-wrap items-center gap-2 rounded-md border border-content/10 p-2">
                    {([['pr', 'PR provider'], ['ci', 'CI provider']] as const).map(([kind, label]) => <span key={kind} className="text-[11px] text-content/60">{label}<Select label={`${label} for ${title}`} value={deliveryProvider(session.id, kind) ?? ""} options={[{value:"", label:item.provider === "github" || item.provider === "azure" ? "Use ticket provider" : "Choose provider"}, {value:"github",label:kind === "pr" ? "GitHub" : "GitHub checks"}, {value:"azure",label:kind === "pr" ? "Azure Repos" : "Azure Pipelines"}]} onChange={value => saveProvider(session.id, kind, value)} /></span>)}
                    <button type="button" className="px-2 py-1 text-[11px]" onClick={() => setChoosingProviders(null)}>Done</button>
                  </span> : null}
                </span>
              );
            })}
          </div>
        ) : null}
        {deliveryBusy ? <p role="status" className="text-[11px] text-content/50">Opening review…</p> : null}
        {deliveryError ? <p role="alert" className="text-[12px] text-content/70">{deliveryError}</p> : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {onStartTask && item.kind !== "pr" ? (
            <>
              <button
                type="button"
                disabled={
                  context.busy
                }
                onClick={() => {
                  setSendError("");
                  void Promise.resolve(onStartTask(ticket ? { ...item, projectPath: startProject } : item, null)).catch(reason => setSendError(String(reason)));
                }}
                className={`${ACTION_FILLED} disabled:cursor-default disabled:opacity-40`}
              >
                Send to agent
              </button>
              <button
                ref={sendAnchor}
                type="button"
                disabled={context.busy}
                title="Send to a task"
                aria-label="Send to a task"
                aria-expanded={sendMenu}
                onClick={() => setSendMenu(true)}
                className={`${ACTION_FILLED} -ml-1.5 !px-1.5 disabled:cursor-default disabled:opacity-40`}
              >
                <ChevronDown className="size-3.5" strokeWidth={1.75} />
              </button>
              {ticket ? <InboxProjectPicker projects={projects} value={startProject} onChange={setStartProject} /> : null}
              {sendMenu ? (
                <SendTargetMenu
                  anchor={sendAnchor}
                  onPick={(taskId) => {
                    setSendMenu(false);
                    onStartTask?.(ticket ? { ...item, projectPath: startProject } : item, taskId);
                  }}
                  onClose={() => setSendMenu(false)}
                />
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            disabled={context.busy}
            onClick={() => {
              context.open("ask");
            }}
            className={item.kind === "pr" ? ACTION_FILLED : ACTION_OUTLINE}
          >
            <MessageSquare className="size-3.5" strokeWidth={1.75} /> Ask agent
          </button>
          {isPr ? <button type="button" className={ACTION_OUTLINE} onClick={() => setTab("code")}>Review PR</button> : null}
          <button
            type="button"
            onClick={() => void openUrl(item.url)}
            className={ACTION_GHOST}
          >
            <ExternalLink className="size-3.5" strokeWidth={1.75} />
            {item.kind === "pr"
              ? gitlab
                ? "Open on GitLab"
                : "Open on GitHub"
              : azure ? "Open in Azure DevOps" : jira ? "Open in Jira" : linear
                ? "Open in Linear"
                : gitlab
                  ? "Open on GitLab"
                  : "Open on GitHub"}
          </button>
        </div>
        {sendError ? <p role="alert" className="text-[12px] text-red-400">{sendError}</p> : null}
        <InboxContextPicker context={context}
          destination={ticket ? <InboxProjectPicker projects={projects} value={startProject} onChange={setStartProject} /> : <span className="truncate" title={item.projectPath}>{projectName(item.projectPath)}</span>}
          onConfirm={async (card) => {
            await onDiscuss?.(card);
          }} />
        {(jira || azure) && error && details ? <p role="status" className="text-[12px] text-content/50">{error} <button type="button" className={ACTION_GHOST} onClick={() => setRetry(value => value + 1)}>Retry</button></p> : null}
      </header>
      {isPr ? (
        <div
          role="tablist"
          aria-label={
            gitlab ? "Merge request sections" : "Pull request sections"
          }
          className="flex h-9 gap-4 items-stretch border-b border-content/10"
        >
          <InboxDetailTab
            label="Summary"
            selected={tab === "summary"}
            onSelect={() => setTab("summary")}
          />
          <InboxDetailTab
            label="Code"
            selected={tab === "code"}
            onSelect={() => setTab("code")}
          />
        </div>
      ) : (
        <div className="border-t border-content/10" />
      )}
      </div>
      </div>
      <div ref={detailLock} data-inbox-detail-scroll className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-8 py-5">
        {item.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {item.labels.map((label) => (
              <InboxLabel key={label.name} label={label} />
            ))}
          </div>
        ) : null}
      {isPr && tab === "code" ? (
        diffLoading ? (
          <div className="flex justify-center py-10 text-content/40">
            <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} />
          </div>
        ) : diffError ? (
          <p className="text-[13px] text-content/50">{diffError}</p>
        ) : prDiff ? (
          <InboxPrDiff
            key={`${item.projectPath}:${item.number}:${revision}`}
            diff={prDiff}
          />
        ) : (
          <p className="text-[13px] text-content/45">No file changes</p>
        )
      ) : loading ? (
        <div className="flex justify-center py-10 text-content/40">
          <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} />
        </div>
      ) : error && !details ? (
        <div className="text-[13px] text-content/50">{error}{jira || azure ? <button type="button" className={ACTION_GHOST} onClick={() => setRetry(value => value + 1)}>Retry</button> : null}</div>
      ) : (
        <>
          {details?.body.trim() ? (
            <AgentMarkdown
              text={details.body}
              cwd={markdownCwd}
              allowRemoteMedia
            />
          ) : (
            <p className="text-[13px] text-content/45">No description</p>
          )}
          {(jira || azure) && galleryAttachments.length ? <TicketImages key={`${item.site}:${item.id}:${revision}`} item={item} attachments={galleryAttachments} /> : null}
          <InboxComments
            thread={thread}
            loading={threadLoading}
            error={threadError}
            cwd={markdownCwd}
            provider={item.provider}
            replyMode={linear ? "parent" : gitlab ? undefined : "thread"}
            onReply={jira || azure ? undefined : setReplyTo}
          />
          {(jira || azure) && threadError ? <button type="button" className={ACTION_GHOST} onClick={() => setRetry(value => value + 1)}>Retry comments</button> : null}
          {jira || azure ? null : <InboxCommentForm
            replyTo={replyTo}
            posting={posting}
            error={postError}
            onCancelReply={() => {
              setReplyTo(null);
              setPostError(null);
            }}
            onSubmit={postComment}
          />}
        </>
      )}
      </div>
      </div>
    </div>
  );
}

function InboxPerson({
  name,
  avatarUrl,
  size = 20,
  className = "",
}: {
  name: string;
  avatarUrl?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(!avatarUrl);
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  useEffect(() => {
    setFailed(!avatarUrl);
  }, [avatarUrl]);

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      {avatarUrl && !failed ? (
        <img
          src={avatarUrl}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
          className="shrink-0 rounded-full bg-content/10 object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          aria-hidden
          className="grid shrink-0 place-items-center rounded-full bg-content/12 font-medium text-content/55"
          style={{
            width: size,
            height: size,
            fontSize: Math.max(9, Math.round(size * 0.45)),
          }}
        >
          {initial}
        </span>
      )}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

function InboxProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: InboxProjectOption[];
  value: string;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected =
    projects.find((project) => sameProjectPath(project.path, value)) ??
    projects[0] ??
    null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (button.current?.contains(target) || menu.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        disabled={projects.length === 0}
        onClick={() => setOpen((next) => !next)}
        className="inline-flex h-7 max-w-48 items-center gap-1.5 rounded-md border border-content/10 bg-content/5 px-2 text-[12px] text-content/80 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-40"
      >
        {selected ? <InboxProjectMark project={selected} /> : null}
        <span className="min-w-0 truncate">
          {selected?.name ?? "Choose project"}
        </span>
        <ChevronDown
          className="size-3 shrink-0 text-content/45"
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <div
          ref={menu}
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1 max-h-64 min-w-full max-w-64 overflow-y-auto rounded-lg border border-content/10 bg-background-base/55 p-1 shadow-xl backdrop-blur-xl outline-none"
        >
          {projects.map((project) => {
            const active = selected
              ? sameProjectPath(project.path, selected.path)
              : false;
            return (
              <button
                key={project.path}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(project.path);
                  setOpen(false);
                }}
                className={`flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] ${
                  active
                    ? "bg-content/10 text-content"
                    : "text-content/80 hover:bg-content/5 hover:text-content"
                }`}
              >
                <InboxProjectMark project={project} />
                <span className="min-w-0 truncate">{project.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function InboxLabel({
  label,
  compact = false,
}: {
  label: GithubLabel;
  compact?: boolean;
}) {
  const color = labelColor(label.color);
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-px text-content/50 bg-content/8 ${
        compact ? "max-w-20 text-[10px]" : "text-[11px]"
      }`}
    >
      {color ? (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      ) : null}
      <span className="min-w-0 truncate">{label.name}</span>
    </span>
  );
}

function labelColor(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex}`;
}

/** Send-to-agent task targets — picking one links the item onto it; the
 * new-task path is the sibling "Send to agent" button. */
function SendTargetMenu({
  anchor,
  onPick,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  onPick: (taskId: string) => void;
  onClose: () => void;
}) {
  // Subscribed, not a one-shot read — a task created or archived while the
  // menu is open shows up (or disappears) immediately.
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const tasks = useMemo(
    () => loadTaskWorkspaces().filter((entry) => !entry.archived),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasksRaw],
  );
  const itemClass =
    "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5";
  return (
    <Popover
      anchor={anchor}
      onDismiss={onClose}
      role="menu"
      aria-label="Send to a task"
      className="w-64 overflow-hidden"
    >
      <div className="px-1.5 py-1.5">
        {tasks.length ? (
          tasks.map((task) => {
            const project = projectForTask(task);
            const projectLabel = project
              ? project.name?.trim() ||
                (project.anchor ? projectName(project.anchor) : "Project")
              : "";
            return (
              <button
                type="button"
                role="menuitem"
                key={task.id}
                className={itemClass}
                onClick={() => onPick(task.id)}
              >
                <Task
                  className="size-3.5 shrink-0 text-content/50"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1 truncate">{task.name}</span>
                <span className="shrink-0 truncate text-[10px] text-content/40">
                  {projectLabel}
                </span>
              </button>
            );
          })
        ) : (
          <p className="px-2 py-1.5 text-[12px] text-content/45">
            No tasks yet — Send to agent opens the task sheet.
          </p>
        )}
      </div>
    </Popover>
  );
}
