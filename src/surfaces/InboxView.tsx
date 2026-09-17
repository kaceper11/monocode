import {
  ACTION_OUTLINE,
  ACTION_GHOST,
} from "../chrome/inboxActions";
import { AzureInboxDetail } from "../chrome/AzureInboxDetail";
import {
  InboxDetailShell,
  inboxKindLabel,
  inboxStatusMark,
} from "../chrome/InboxDetailShell";

import { contextTicketKey } from "../lib/agentContext";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CheckCheck,
  Check,
  ExternalLink,
  GitCompare,
  Inbox,
  ListFilter,
  LoaderCircle,
  MessageMultiple,
  Plus,
  RefreshCw,
  Search,
  Zap,
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
import { Checkbox } from "../chrome/controls";
import { useInboxContext } from "../chrome/InboxContextPicker";
import { InboxRelated } from "../chrome/InboxRelated";
import { MyWorkBadges, myWorkBadges } from "../chrome/InboxMyWorkSection";
import { inboxMyWorkForItems, type InboxMyWork } from "../lib/inboxMyWork";
import type { AttentionItem } from "../lib/attention";
import {
  listTaskPrDrafts,
  subscribeTaskPrs,
  taskPrsSnapshot,
} from "../lib/taskPrs";
import {
  loadProjects,
  projectsSnapshot,
  subscribeProjects,
} from "../lib/projects";
import { useDeliveryStores } from "../hooks/useDeliveryStores";
import {
  diffStatsVersion,
  peekProjectDiffStats,
  subscribeDiffStatsVersion,
} from "../hooks/useProjectDiffStats";
import {
  branchPrVersion,
  cachedBranchPr,
  subscribeBranchPrVersion,
} from "../hooks/useBranchPr";
import type { InboxComposerCard } from "../lib/githubTasks";
import { contextFromTickets, requestAgentContext } from "../lib/agentContext";
import { ProjectLogoIcon } from "../chrome/ProjectLogoIcon";
import { ProjectMascot } from "../chrome/ProjectMascot";
import { OverlayNav } from "../chrome/TitleBar";
import {
  loadTaskWorkspaces,
  subscribeTaskWorkspaces,
  taskWorkspacesSnapshot,
} from "../lib/taskWorkspaces";
import { WindowControls } from "../chrome/WindowControls";
import { useDragResize } from "../hooks/useDragResize";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import { refreshLinkedWorkItem } from "../lib/linkedWorkItemRefresh";
import {
  githubStatus,
  githubReviewDecisionLabel,
  githubWorkItemComment,
  githubWorkItemDetails,
  githubWorkItemThread,
  gitlabAttentionLabel,
  inboxFetchPaths,
  inboxItemKey,
  inboxItemRef,
  inboxListIsFresh,
  inboxProjectIdentities,
  inboxProjectsForRail,
  inboxRailKeyResolver,
  listInboxItems,
  peekGithubWorkItemDetails,
  peekGithubWorkItemThread,
  peekInboxList,
  formatRelativeTime,
  inboxPersonAvatarUrl,
  type GithubLabel,
  type GithubWorkItemDetails,
  type GithubWorkItemThread,
  type InboxItem,
  type InboxProviderErrors,
  type InboxQuery,
  type InboxRailProject,
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
import { type RecentProject } from "../lib/recents";
import {
  getVerifiedFamilies,
  subscribeRepositoryFamilies,
  type RepositoryFamily,
} from "../lib/repositoryFamilies";
import { type LinkedWorkItem } from "../lib/session";
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
  gitlabWorkItemComment,
  gitlabWorkItemDetails,
  gitlabWorkItemThread,
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
import {
  AZURE_CHANGE_EVENT,
  azureConnected,
  azureDetails,
  azureThread,
  peekAzureDetails,
  peekAzureThread,
  loadAzureFilter,
  type AzureFilter,
} from "../lib/azure";
import {
  InboxComments,
  InboxCommentForm,
  type InboxReplyTarget,
} from "./InboxComments";
import { GithubPrReview } from "../chrome/GithubPrReview";
import { GitlabMrReview } from "../chrome/GitlabMrReview";
import {
  InboxDiscussionPanel,
  type InboxSessionPortal,
} from "./InboxDiscussionPanel";
import { inboxAskKey } from "../lib/inboxAsk";
import { openWatchSheet } from "../lib/watchers";
import {
  JIRA_CHANGE_EVENT,
  atlassianCapable,
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
  /** Rail identity — a normalized path or `project:<id>` for pure groups. */
  key: string;
  /** Real folder for new-work defaults — never a `project:` sentinel. */
  path: string;
  /** Working copies this project fetches through. */
  paths: string[];
  name: string;
  logoPath: string | null;
  mascotName: string | null;
  mascotColor: string;
};

function inboxProjectOptions(
  projects: InboxRailProject[],
  logos: ReturnType<typeof useTabGroupLogos>,
): InboxProjectOption[] {
  const mascots = loadTabGroupMascots();
  const colors = loadTabGroupColors();
  const custom = loadTabGroupCustomColors();
  return [...projects]
    .map((project) => {
      const key = projectKey(project.key);
      return {
        key: project.key,
        path: project.cwd,
        paths: project.paths,
        name: project.name,
        logoPath: resolveTabGroupLogo(key, logos),
        mascotName: resolveTabGroupMascot(key, mascots),
        mascotColor: resolveTabGroupColor(key, colors, custom, project.name),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function peekInboxForRail(recents: RecentProject[], cwd: string) {
  const projects = inboxProjectsForRail(recents, cwd);
  const filters = pruneInboxFilters(
    loadInboxFilters(),
    inboxProjectIdentities(projects),
  );
  return peekInboxList(inboxFetchPaths(projects), {
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
  sessions?: readonly SessionSummary[];
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenDelivery?: (
    sessionId: string,
    kind: "pr" | "ci",
    current: () => boolean,
    provider: "github" | "azure" | "gitlab",
    prUrl?: string,
    gitlabTarget?: { repo: string; number: number },
  ) => Promise<void>;
  /** Live session state for "my work" badges — mid-turn and input-blocked. */
  busySessionIds?: ReadonlySet<string>;
  needsInputSessionIds?: ReadonlySet<string>;
  /** Visible attention queue rows — "waiting on you" joins per ticket. */
  attentionItems?: readonly AttentionItem[];
  onAttentionAction?: (item: AttentionItem) => void | Promise<void>;
  /** Session-card destination to reveal after the Inbox list loads. */
  target?: LinkedWorkItem | null;
  visible?: boolean;
  conversationId?: string;
  conversationRevision?: number;
  selectionRevision?: number;
  onCloseConversation?: () => void;
  onToggleConversationTicket?: (
    sessionId: string,
    item: InboxItem,
    selected: boolean,
  ) => Promise<void>;
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
  sessions = [],
  onOpenSession,
  onOpenDelivery,
  busySessionIds,
  needsInputSessionIds,
  attentionItems,
  onAttentionAction,
  target = null,
  visible = true,
  conversationId,
  conversationRevision,
  selectionRevision = 0,
  onCloseConversation,
  onToggleConversationTicket,
  onOpenIntegrations,
}: Props) {
  const [selectingTickets, setSelectingTickets] = useState(false);
  const [issuesCollapsed, setIssuesCollapsed] = useState(false);
  useEffect(() => {
    if (selectionRevision) {
      setSelectingTickets(true);
      setIssuesCollapsed(false);
    }
  }, [selectionRevision]);
  const [selectedTickets, setSelectedTickets] = useState<
    Map<string, InboxItem>
  >(new Map());
  const [selectionError, setSelectionError] = useState("");
  const [pendingTickets, setPendingTickets] = useState<Map<string, boolean>>(
    new Map(),
  );
  const conversationLinks = sessionWorkItems(
    sessions.find((session) => session.id === conversationId) ?? {},
  );
  const editingLinks = !!conversationId && !!onToggleConversationTicket;
  const selectionCount = editingLinks
    ? conversationLinks.length
    : selectedTickets.size;
  const ticketSelected = (item: InboxItem) =>
    pendingTickets.get(contextTicketKey(item)) ??
    (editingLinks
      ? conversationLinks.some((link) =>
          inboxItemMatchesLinkedWorkItem(item, link),
        )
      : selectedTickets.has(contextTicketKey(item)));
  const toggleTicket = (item: InboxItem) => {
    if (item.delivery) return;
    setSelectionError("");
    if (editingLinks) {
      const key = contextTicketKey(item);
      if (pendingTickets.has(key)) return;
      const selected = !ticketSelected(item);
      setPendingTickets((previous) => new Map(previous).set(key, selected));
      void onToggleConversationTicket!(conversationId!, item, selected)
        .catch((error) =>
          setSelectionError(`Could not save ticket links: ${String(error)}`),
        )
        .finally(() =>
          setPendingTickets((previous) => {
            const next = new Map(previous);
            next.delete(key);
            return next;
          }),
        );
      return;
    }
    const identity = contextTicketKey(item);
    if (!selectedTickets.has(identity) && selectedTickets.size >= 20) {
      setSelectionError("Select at most 20 tickets.");
      return;
    }
    setSelectedTickets((previous) => {
      const next = new Map(previous);
      if (next.has(identity)) next.delete(identity);
      else next.set(identity, { ...item });
      return next;
    });
  };
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [previewingTicket, setPreviewingTicket] = useState(false);
  useEffect(
    () => setPreviewingTicket(false),
    [conversationId, conversationRevision],
  );
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
    resolveInboxSource(
      loadInboxSource(),
      connections,
      loadVisibleInboxSources(),
    ),
  );
  const [connectMenuOpen, setConnectMenuOpen] = useState(false);
  const connectButtonRef = useRef<HTMLButtonElement | null>(null);
  const [preferredSources, setVisibleSources] = useState(
    loadVisibleInboxSources,
  );
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
  const [azureFilter, setAzureFilter] = useState<AzureFilter>({
    project: "",
    query: "",
    assigned: true,
  });
  const [jiraFilter, setJiraFilter] = useState<JiraFilter>(DEFAULT_JIRA_FILTER);
  const [jiraProjects, setJiraProjects] = useState<JiraOption[]>([]);
  const [jiraFavorites, setJiraFavorites] = useState<JiraOption[]>([]);
  const [jiraOptionsError, setJiraOptionsError] = useState("");
  const prevRefresh = useRef(refresh);

  // Project rows follow the durable project store and verified repository
  // families — adding a project or moving a repository republishes both and
  // lands here without waiting for a remount.
  const projectsRaw = useSyncExternalStore(subscribeProjects, projectsSnapshot);
  const [families, setFamilies] = useState<
    ReadonlyMap<string, RepositoryFamily>
  >(() => getVerifiedFamilies());
  // Discovery publishes once per probed path; coalesce the burst like the
  // rail's useRepositoryFamilies instead of regrouping a step at a time.
  useEffect(() => {
    let timer = 0;
    const unsubscribe = subscribeRepositoryFamilies(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFamilies(getVerifiedFamilies()), 40);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);
  const storedProjects = useMemo(() => loadProjects(), [projectsRaw]);
  const projects = useMemo(
    () => inboxProjectsForRail(recents, cwd, storedProjects, families),
    [cwd, recents, storedProjects, families],
  );
  const fetchProjects = useMemo(() => inboxFetchPaths(projects), [projects]);
  const railKeyOf = useMemo(() => inboxRailKeyResolver(projects), [projects]);
  const projectByKey = useMemo(
    () =>
      new Map(projects.map((project) => [projectKey(project.key), project])),
    [projects],
  );
  const projectOptions = useMemo(
    () => inboxProjectOptions(projects, logos),
    [logos, projects],
  );
  const linearProjects = useMemo(() => linearProjectOptions(items), [items]);
  const activeFilters = useMemo(
    () => pruneInboxFilters(filters, inboxProjectIdentities(projects)),
    [filters, projects],
  );
  const filtersActive =
    source === "azure"
      ? !!(
          azureFilter.query ||
          !azureFilter.assigned ||
          activeFilters.time !== "all" ||
          activeFilters.status.open ||
          activeFilters.status.closed
        )
      : source === "jira"
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
    setVisibleSources((previous) =>
      previous.includes(target.provider ?? "github")
        ? previous
        : [target.provider ?? "github", ...previous],
    );
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
      void jiraConnected()
        .then((status) => {
          if (cancelled) return;
          setJiraSite(status.site);
          setConnections((prev) => ({
            ...prev,
            jira: status.connected && atlassianCapable(status, "Jira"),
          }));
          setJiraProjects([]);
          setJiraFavorites([]);
          setJiraFilter(loadJiraFilter(status.site));
          if (changed) setRefresh((value) => value + 1);
        })
        .catch(() => {
          /* The list shows the connection error locally. */
        });
    };
    update();
    const onChange = () => update(true);
    window.addEventListener(JIRA_CHANGE_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(JIRA_CHANGE_EVENT, onChange);
    };
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
    return () => {
      cancelled = true;
    };
  }, [visible, source, jiraSite, !!filterMenu, refresh]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const update = (changed = false) => {
      if (changed) clearInboxCache();
      void azureConnected()
        .then((status) => {
          if (cancelled) return;
          const owner = status.connected
            ? `${status.site}:${status.accountId}`
            : "";
          if (changed && azureOwner.current !== owner)
            setItems((previous) =>
              previous.filter((item) => item.provider !== "azure"),
            );
          azureOwner.current = owner;
          setAzureSite(status.connected ? status.site : "");
          setConnections((prev) => ({ ...prev, azure: status.connected }));
          setAzureFilter(loadAzureFilter(status.site, status.project));
          if (changed) setRefresh((value) => value + 1);
        })
        .catch(() => {
          /* The list owns connection errors. */
        });
    };
    update();
    const onChange = () => update(true);
    window.addEventListener(AZURE_CHANGE_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(AZURE_CHANGE_EVENT, onChange);
    };
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

  const visibleSources = visibleInboxSources(connections).filter((source) =>
    preferredSources.includes(source),
  );
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
    const cached = peekInboxList(fetchProjects, fetchQuery);
    if (cached) {
      setItems((previous) => [
        ...cached.items,
        ...previous.filter(
          (item) =>
            (item.provider === "jira" &&
              cached.errors.jira &&
              jiraSite === item.site) ||
            (item.provider === "azure" &&
              cached.errors.azure &&
              azureSite === item.site),
        ),
      ]);
      setProviderErrors(cached.errors);
      setLoading(false);
    }
    if (!force && cached && inboxListIsFresh(fetchProjects, fetchQuery)) {
      return;
    }

    let cancelled = false;
    if (cached) setRevalidating(true);
    else {
      setLoading(true);
      setProviderErrors({});
    }
    void listInboxItems(fetchProjects, fetchQuery, { force })
      .then((next) => {
        if (cancelled) return;
        setItems((previous) => [
          ...next.items,
          ...previous.filter(
            (item) =>
              (item.provider === "jira" &&
                next.errors.jira &&
                jiraSite === item.site) ||
              (item.provider === "azure" &&
                next.errors.azure &&
                azureSite === item.site),
          ),
        ]);
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
  }, [visible, fetchQuery, fetchProjects, refresh]);

  useEffect(() => {
    if (!visible) return;
    if (
      !target ||
      items.some((item) => inboxItemMatchesLinkedWorkItem(item, target))
    ) {
      return;
    }
    let cancelled = false;
    void refreshLinkedWorkItem(cwd, target).then((item) => {
      if (cancelled || !item) return;
      setTargetItem({
        ...item,
        projectPath: item.projectPath || cwd,
      });
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
      railKeyOf,
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
    railKeyOf,
    searchInput,
    source,
    sourceAvailable,
    target,
    targetItem,
  ]);

  const relatedSessionCounts = useMemo(
    () => inboxRelatedSessionCounts(visibleItems, sessions),
    [visibleItems, sessions],
  );

  // "My work" inputs are all already-cached snapshots — the version ticks
  // re-derive the join when a store publish lands; nothing here fetches.
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const prDraftsRaw = useSyncExternalStore(subscribeTaskPrs, taskPrsSnapshot);
  const statsVersion = useSyncExternalStore(
    subscribeDiffStatsVersion,
    diffStatsVersion,
  );
  const branchPrV = useSyncExternalStore(
    subscribeBranchPrVersion,
    branchPrVersion,
  );
  const stores = useDeliveryStores();
  const myWorkByItem = useMemo(
    () =>
      inboxMyWorkForItems(visibleItems, {
        sessions,
        busySessionIds,
        needsInputSessionIds,
        tasks: loadTaskWorkspaces(),
        projects: loadProjects(),
        prDrafts: listTaskPrDrafts(),
        stores,
        attention: attentionItems,
        branchForCwd: (cwd) => peekProjectDiffStats(cwd)?.branch,
        githubPrFor: cachedBranchPr,
      }),
    // Snapshot strings above are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      visibleItems,
      sessions,
      busySessionIds,
      needsInputSessionIds,
      attentionItems,
      tasksRaw,
      projectsRaw,
      prDraftsRaw,
      stores,
      statsVersion,
      branchPrV,
    ],
  );
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

  /** "Watch this query" (#23) — binds a watcher to the current source tab's
   * filter. GitHub queries span repos, so the sheet asks which repository. */
  const watchRepos = useMemo(
    () => [
      ...new Map(
        items
          .filter((item) => item.provider === "github" && item.repo)
          .map((item) => [
            `${item.projectPath}|${item.repo}`,
            { cwd: item.projectPath, repo: item.repo },
          ]),
      ).values(),
    ],
    [items],
  );
  const canWatch =
    (source === "jira" && connections.jira && !!jiraSite) ||
    (source === "azure" && !!azureSite) ||
    (source === "github" && watchRepos.length > 0);
  const onWatchQuery = () => {
    if (source === "jira" && jiraSite) {
      openWatchSheet({
        source: { kind: "jira-items", site: jiraSite, filter: jiraFilter },
        name: `Jira · ${jiraFilter.project || "Assigned to me"}`,
      });
    } else if (source === "azure" && azureSite) {
      openWatchSheet({
        source: {
          kind: "azure-boards",
          site: azureSite,
          project: azureFilter.project,
          filter: azureFilter,
        },
        name: `Azure Boards · ${azureFilter.project || "Assigned to me"}`,
      });
    } else if (source === "github" && watchRepos.length) {
      openWatchSheet({
        source: {
          kind: "github-items",
          cwd: watchRepos[0].cwd,
          repo: watchRepos[0].repo,
          itemKind: "issue",
        },
        name: `GitHub · ${watchRepos[0].repo}`,
        repos: watchRepos,
      });
    }
  };

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
    const pruned = pruneInboxFilters(next, inboxProjectIdentities(projects));
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
      className={
        conversationId && issuesCollapsed
          ? "hidden"
          : "relative flex h-full min-h-0 shrink-0 flex-col border-r border-content/10"
      }
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
        {selectingTickets ? (
          <>
            <span className="min-w-0 flex-1 text-[12px] text-content/60">
              {selectionCount} {editingLinks ? "linked" : "selected"}
            </span>
            {!editingLinks ? (
              <button
                type="button"
                aria-label="Send selected tickets to an agent"
                disabled={!selectionCount}
                onClick={() => {
                  const items = [...selectedTickets.values()];
                  try {
                    requestAgentContext({
                      inboxItems: items,
                      context: contextFromTickets(items),
                      cwd: items[0]?.projectPath || cwd || undefined,
                      // Selection survives until the route accepts — a
                      // cancelled picker or a failed launch keeps it so the
                      // send can be retried without re-picking tickets.
                      onPrepared: () => {
                        setSelectedTickets(new Map());
                        setSelectingTickets(false);
                      },
                      onFailed: (reason) => setSelectionError(reason),
                    });
                  } catch (error) {
                    setSelectionError(String(error));
                  }
                }}
                className="rounded-md bg-content/10 px-2 py-1 text-[11px] disabled:opacity-40"
              >
                Send to agent
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Done selecting tickets"
              onClick={() => {
                setSelectedTickets(new Map());
                setSelectingTickets(false);
                setSelectionError("");
              }}
              className="rounded-md px-2 py-1 text-[11px] text-content/60 hover:bg-content/5"
            >
              Done
            </button>
          </>
        ) : (
          <>
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
            {canWatch ? (
              <button
                type="button"
                title="Watch this query — poll it while MonoCode is open"
                aria-label="Watch this query"
                onClick={onWatchQuery}
                className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
              >
                <Zap className="size-3.5" strokeWidth={1.75} />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Select tickets"
              title="Select tickets"
              onClick={() => {
                setSelectingTickets(true);
                setFilterMenu(null);
                setSelectionError("");
              }}
              className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
            >
              <Check className="size-3.5" strokeWidth={1.75} />
            </button>
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
          </>
        )}
      </div>
      {selectionError ? (
        <p role="alert" className="px-3 py-1 text-[11px] text-red-400">
          {selectionError}
        </p>
      ) : null}
      <div
        ref={listLock}
        className="min-h-0 flex-1 overflow-y-auto overscroll-none"
      >
        {sourceError && visibleItems.length > 0 ? (
          <p role="status" className="px-3 py-2 text-[12px] text-content/50">
            {sourceError}{" "}
            <button
              type="button"
              onClick={() => setRefresh((value) => value + 1)}
              className="underline"
            >
              Retry
            </button>
          </p>
        ) : null}
        {noSourcesConnected ? (
          <p className="px-3 py-3 text-[12px] text-content/50">
            Add a connection to start using the Inbox.
          </p>
        ) : sourceError && visibleItems.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-content/50">
            <p>{sourceError}</p>
            {source === "azure" ? (
              <div className="mt-2 flex gap-3">
                {onOpenSettings ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={onOpenSettings}
                  >
                    {azureSite ? "Connection settings" : "Connect Azure DevOps"}
                  </button>
                ) : null}
                {azureSite ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
            {source === "jira" ? (
              <div className="mt-2 flex gap-3">
                {onOpenSettings ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={onOpenSettings}
                  >
                    {jiraSite ? "Connection settings" : "Connect Jira"}
                  </button>
                ) : null}
                {jiraSite ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : loading && items.length === 0 ? (
          <div className="flex justify-center py-10 text-content/40">
            <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} />
          </div>
        ) : visibleItems.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-content/50">
            {source === "azure"
              ? "No Azure items match these filters"
              : source === "jira"
                ? "No Jira issues match these filters"
                : narrowedByUser
                  ? searchNarrowed
                    ? source === "linear"
                      ? "No matching Linear issues"
                      : source === "gitlab"
                        ? "No matching issues or merge requests"
                        : "No matching issues or pull requests"
                    : source === "linear"
                      ? "No Linear issues match these filters"
                      : source === "gitlab"
                        ? activeFilters.assignedToMe
                          ? "Nothing needs your attention"
                          : "No GitLab items match these filters"
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
              // The row a working copy was fetched under — a stored project's
              // key or its own path when nothing claims it.
              const projectId = item.projectPath
                ? projectKey(railKeyOf(item.projectPath))
                : "";
              const project = projectId
                ? projectByKey.get(projectId)
                : undefined;
              return (
                <li
                  key={key}
                  className={
                    selectingTickets ? "flex items-center gap-1" : undefined
                  }
                >
                  {selectingTickets ? (
                    <Checkbox
                      label={`Select ${item.provider} ${item.identifier || item.number} ${item.title}`}
                      checked={ticketSelected(item)}
                      disabled={
                        !!item.delivery ||
                        pendingTickets.has(contextTicketKey(item))
                      }
                      onChange={() => toggleTicket(item)}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <InboxCard
                      item={item}
                      active={
                        selected != null && key === inboxItemKey(selected)
                      }
                      projectLabel={project?.name}
                      logoPath={resolveTabGroupLogo(projectId, logos)}
                      mascotName={resolveTabGroupMascot(
                        projectId,
                        groupMascots,
                      )}
                      mascotColor={resolveTabGroupColor(
                        projectId,
                        groupColors,
                        groupCustomColors,
                        project?.name ?? projectName(item.projectPath),
                      )}
                      relatedSessionCount={relatedSessionCounts.get(item) ?? 0}
                      myWork={myWorkByItem.get(item)}
                      onSelect={selectTicketPreview}
                    />
                  </div>
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
      onJiraFilterChange={(next) => {
        setJiraFilter(next);
        saveJiraFilter(jiraSite, next);
      }}
      onClose={() => setFilterMenu(null)}
    />
  ) : null;

  const connectPortal =
    connectMenuOpen && connectableSources.length > 0 ? (
      <InboxConnectMenu
        anchor={connectButtonRef}
        sources={connectableSources}
        onConnect={(source) => onOpenIntegrations?.(source)}
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
          {conversationId ? (
            <button
              type="button"
              aria-expanded={!issuesCollapsed}
              aria-controls="inbox-ticket-list"
              onClick={() => setIssuesCollapsed((value) => !value)}
              className="rounded-md px-2 py-1 text-[11px] text-content/60 hover:bg-content/5"
            >
              {issuesCollapsed ? "Show issues" : "Hide issues"}
            </button>
          ) : null}
          {conversationId && previewingTicket ? (
            <button
              type="button"
              className="ml-auto rounded-md px-2 py-1 text-[11px] text-content/60 hover:bg-content/5"
              onClick={() => setPreviewingTicket(false)}
            >
              Back to conversation
            </button>
          ) : null}
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        {list}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <div
            hidden={!!conversationId && !previewingTicket}
            className={
              conversationId && !previewingTicket
                ? "hidden"
                : "min-h-0 min-w-0 flex-1"
            }
          >
            {target &&
            !selected &&
            selectedKey === targetSelectionKey &&
            !loading &&
            source === target.provider &&
            target.provider !== "github" ? (
              <div role="status" className="p-4 text-[13px] text-content/60">
                <p className="mb-2 font-medium text-content">
                  {target.title ||
                    target.identifier ||
                    `Issue ${target.number}`}
                </p>
                <p>
                  This linked issue is not available in the current Inbox. Check
                  the connected account and provider filters.
                </p>
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
              viewingSessionId={conversationId}
              onDiscuss={async (context) => {
                if (!selected) return;
                await onAsk(selected, context);
                setDiscussionOpen(true);
              }}
              onOpenDelivery={onOpenDelivery}
              onOpenSession={(id) => {
                setPreviewingTicket(false);
                return onOpenSession?.(id);
              }}
              myWork={selected ? myWorkByItem.get(selected) : undefined}
              onAttentionAction={onAttentionAction}
            />
          </div>
          {(conversationId && !previewingTicket) ||
          (discussionOpen && selected) ? (
            <InboxDiscussionPanel
              onOpen={onAsk}
              onRestart={onAskRestart}
              onMount={onAskMount}
              key={conversationId ?? (selected ? inboxAskKey(selected) : "")}
              sessionId={conversationId}
              item={selected ?? undefined}
              onClose={() => {
                setDiscussionOpen(false);
                onCloseConversation?.();
              }}
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
  viewingSessionId,
  onDiscuss,
  onOpenSession,
  onOpenDelivery,
  myWork,
  onAttentionAction,
}: {
  item: InboxItem | null;
  cwd: string;
  projects: InboxProjectOption[];
  revision?: number;
  relatedSessions: readonly SessionSummary[];
  /** Session the user is currently reading in the inbox conversation
   * panel — delivery rows host on it when it shares the working copy. */
  viewingSessionId?: string;
  onDiscuss?: (context: InboxComposerCard) => void | Promise<void>;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenDelivery?: (
    sessionId: string,
    kind: "pr" | "ci",
    current: () => boolean,
    provider: "github" | "azure" | "gitlab",
    prUrl?: string,
    gitlabTarget?: { repo: string; number: number },
  ) => Promise<void>;
  myWork?: InboxMyWork;
  onAttentionAction?: (item: AttentionItem) => void | Promise<void>;
}) {
  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <Inbox className="mb-3 size-6 text-content/30" strokeWidth={1.75} />
        <p className="text-[13px] text-content/45">Select an inbox item</p>
      </div>
    );
  }
  if (item.delivery)
    return (
      <AzureInboxDetail
        key={inboxItemKey(item)}
        item={item}
        cwd={cwd}
        projects={projects}
        relatedSessions={relatedSessions}
        viewingSessionId={viewingSessionId}
        onOpenSession={onOpenSession}
        onOpenDelivery={onOpenDelivery}
        onDiscuss={onDiscuss}
        myWork={myWork}
        onAttentionAction={onAttentionAction}
      />
    );
  return (
    <InboxDetail
      key={inboxItemKey(item)}
      item={item}
      cwd={cwd}
      revision={revision}
      viewingSessionId={viewingSessionId}
      onDiscuss={onDiscuss}
      onOpenSession={onOpenSession}
      onOpenDelivery={onOpenDelivery}
      myWork={myWork}
      onAttentionAction={onAttentionAction}
    />
  );
}

const InboxCard = memo(function InboxCard({
  item,
  active,
  projectLabel,
  logoPath,
  mascotName,
  mascotColor,
  relatedSessionCount,
  myWork,
  onSelect,
}: {
  item: InboxItem;
  active: boolean;
  /** Owning project's display name — falls back to the folder name. */
  projectLabel?: string;
  logoPath: string | null;
  mascotName: string | null;
  mascotColor: string;
  relatedSessionCount: number;
  myWork?: InboxMyWork;
  onSelect: (item: InboxItem) => void;
}) {
  useInboxSeenTick();
  const status = inboxStatusMark(item);
  const kindLabel = inboxKindLabel(item);
  const time = formatRelativeTime(item.updatedAt);
  const name = projectLabel?.trim() || projectName(item.projectPath);
  const linear = item.provider === "linear";
  const jira = item.provider === "jira";
  const azure = item.provider === "azure";
  const statusLabel = linear || jira || azure ? item.state : status.label;
  const source = azure
    ? `${item.site?.split("/").pop()} / ${item.projectName}`
    : jira
      ? item.projectName
      : linear
        ? item.teamName || item.repo
        : item.repo || name;
  const attentionLabel =
    item.provider === "gitlab"
      ? gitlabAttentionLabel(item.attentionReason ?? "")
      : "";
  const unseen = isInboxEntryUnseen({
    key: inboxItemKey(item),
    updatedAt: item.updatedAt,
  });
  const work = myWorkBadges(myWork);

  return (
    <button
      type="button"
      title={item.title}
      aria-current={active ? "true" : undefined}
      aria-label={`${statusLabel} ${kindLabel.toLowerCase()} ${inboxItemRef(
        item,
      )}: ${item.title}${attentionLabel ? `, ${attentionLabel}` : ""}${unseen ? ", new" : ""}${relatedSessionCount > 0 ? `, ${relatedSessionCount} related ${relatedSessionCount === 1 ? "thread" : "threads"}` : ""}${work?.aria ? `, ${work.aria}` : ""}`}
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
            {kindLabel} · {inboxItemRef(item)}
            {attentionLabel ? ` · ${attentionLabel}` : ""}
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
          {linear || jira || azure || !item.projectPath ? null : logoPath ? (
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
          {linear || jira || azure ? (
            <span className="max-w-[55%] truncate" title={item.state}>
              {item.state} ·
            </span>
          ) : null}
          <span className="min-w-0 truncate">{source}</span>
        </span>
        <MyWorkBadges work={myWork} />
        {item.labels.length > 0 ? (
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
  revision,
  viewingSessionId,
  onDiscuss,
  onOpenSession,
  onOpenDelivery,
  myWork,
  onAttentionAction,
}: {
  item: InboxItem;
  cwd: string;
  revision: number;
  /** Session the user is currently reading — it hosts its checkout's
   * delivery cluster when several conversations share a working copy. */
  viewingSessionId?: string;
  onDiscuss?: (context: InboxComposerCard) => void | Promise<void>;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenDelivery?: (
    sessionId: string,
    kind: "pr" | "ci",
    current: () => boolean,
    provider: "github" | "azure" | "gitlab",
    prUrl?: string,
    gitlabTarget?: { repo: string; number: number },
  ) => Promise<void>;
  myWork?: InboxMyWork;
  onAttentionAction?: (item: AttentionItem) => void | Promise<void>;
}) {
  const detailLock = useLockOverscroll<HTMLDivElement>();
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
  const cached = azure
    ? peekAzureDetails(item)
    : jira
      ? peekJiraDetails(item)
      : linear
        ? peekLinearIssueDetails(item.id ?? "")
        : gitlabKind
          ? peekGitlabWorkItemDetails(item.repo, gitlabKind, item.number)
          : githubKind
            ? peekGithubWorkItemDetails(
                item.projectPath,
                githubKind,
                item.number,
              )
            : null;
  const cachedThread = azure
    ? peekAzureThread(item)
    : jira
      ? peekJiraThread(item)
      : linear
        ? peekLinearIssueThread(item.id ?? "")
        : gitlabKind
          ? peekGitlabWorkItemThread(item.repo, gitlabKind, item.number)
          : githubKind
            ? peekGithubWorkItemThread(
                item.projectPath,
                githubKind,
                item.number,
              )
            : null;
  const [details, setDetails] = useState<GithubWorkItemDetails | null>(cached);
  const [loading, setLoading] = useState(cached == null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"summary" | "code">("summary");
  const [thread, setThread] = useState<
    GithubWorkItemThread | LinearIssueThread | GitlabWorkItemThread | null
  >(cachedThread);
  const [threadLoading, setThreadLoading] = useState(cachedThread == null);
  const galleryAttachments = [
    ...new Map(
      [
        ...(details?.attachments ?? []),
        ...(azure && thread && "attachments" in thread
          ? (thread.attachments ?? [])
          : []),
      ].map((file) => [file.id, file]),
    ).values(),
  ];
  const [threadError, setThreadError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<InboxReplyTarget | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const context = useInboxContext(item);
  const [retry, setRetry] = useState(0);

  const source = azure
    ? `${item.site?.split("/").pop()} / ${item.projectName}`
    : jira
      ? item.projectName
      : linear
        ? item.teamName || item.repo
        : item.repo || projectName(item.projectPath);
  const attentionLabel = gitlab
    ? gitlabAttentionLabel(item.attentionReason ?? "")
    : "";
  const markdownCwd = item.projectPath || cwd;
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
    const cachedDetails = azure
      ? peekAzureDetails(item)
      : jira
        ? peekJiraDetails(item)
        : linear
          ? peekLinearIssueDetails(item.id ?? "")
          : gitlabKind
            ? peekGitlabWorkItemDetails(item.repo, gitlabKind, item.number)
            : githubKind
              ? peekGithubWorkItemDetails(
                  item.projectPath,
                  githubKind,
                  item.number,
                )
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
    const pending = azure
      ? azureDetails(item)
      : jira
        ? jiraDetails(item)
        : linear
          ? item.id
            ? linearIssueDetails(item.id)
            : Promise.reject(new Error("Missing Linear issue"))
          : gitlabKind
            ? gitlabWorkItemDetails(item.repo, gitlabKind, item.number)
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
    item.repo,
    linear,
    revision,
    jira,
    retry,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (ticket) {
      const id = item.id ?? "";
      const cachedThread = azure
        ? peekAzureThread(item)
        : jira
          ? peekJiraThread(item)
          : peekLinearIssueThread(id);
      if (cachedThread) {
        setThread(cachedThread);
        setThreadLoading(false);
        setThreadError(null);
      } else {
        setThreadLoading(true);
        setThreadError(null);
        setThread(null);
      }
      void (
        azure
          ? azureThread(item)
          : jira
            ? jiraThread(item)
            : linearIssueThread(id)
      )
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
        item.repo,
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
      void gitlabWorkItemThread(item.repo, gitlabKind, item.number)
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
    item.repo,
    linear,
    revision,
    jira,
    retry,
  ]);

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
        await gitlabWorkItemComment(item.repo, gitlabKind, item.number, body);
        setReplyTo(null);
        try {
          setThread(
            await gitlabWorkItemThread(item.repo, gitlabKind, item.number, {
              force: true,
            }),
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
    <InboxDetailShell
      item={item}
      cwd={cwd}
      context={context}
      attention={
        attentionLabel ? (
          <span className="shrink-0 text-accent">{attentionLabel}</span>
        ) : null
      }
      source={source ? <span className="truncate">{source}</span> : null}
      meta={
        <>
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
                    <GitCompare
                      className="size-3 shrink-0"
                      strokeWidth={1.75}
                    />
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
        </>
      }
      myWork={myWork}
      viewingSessionId={viewingSessionId}
      onOpenSession={onOpenSession}
      onOpenDelivery={onOpenDelivery}
      onOpenAttention={onAttentionAction}
      onDiscuss={onDiscuss}
      actions={
        <>
              {isPr && (item.provider === "github" || gitlab) ? (
                <button
                  type="button"
                  className={ACTION_OUTLINE}
                  onClick={() => setTab("code")}
                >
                  Review PR
                </button>
              ) : null}
              {item.provider === "github" && item.kind === "pr" && item.repo ? (
                <button
                  type="button"
                  className={ACTION_GHOST}
                  title="Watch reviews and checks on this PR"
                  onClick={() =>
                    openWatchSheet({
                      source: {
                        kind: "github-pr",
                        cwd: item.projectPath,
                        repo: item.repo,
                        number: item.number,
                      },
                      name: `Reviews · ${item.repo}#${item.number}`,
                    })
                  }
                >
                  <Zap className="size-3.5" strokeWidth={1.75} /> Watch
                </button>
              ) : null}
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
                  : azure
                    ? "Open in Azure DevOps"
                    : jira
                      ? "Open in Jira"
                      : linear
                        ? "Open in Linear"
                        : gitlab
                          ? "Open on GitLab"
                          : "Open on GitHub"}
              </button>
        </>
      }
      error={
        (jira || azure) && error && details ? (
          <p role="status" className="text-[12px] text-content/50">
            {error}{" "}
            <button
              type="button"
              className={ACTION_GHOST}
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry
            </button>
          </p>
        ) : null
      }
      tabs={
        isPr && (item.provider === "github" || gitlab)
          ? {
              ariaLabel: gitlab
                ? "Merge request sections"
                : "Pull request sections",
              items: [
                {
                  label: "Summary",
                  selected: tab === "summary",
                  onSelect: () => setTab("summary"),
                },
                {
                  label: "Code",
                  selected: tab === "code",
                  onSelect: () => setTab("code"),
                },
              ],
            }
          : undefined
      }
    >
      <div
        ref={detailLock}
        data-inbox-detail-scroll
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-8 py-5">
          {item.labels.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {item.labels.map((label) => (
                <InboxLabel key={label.name} label={label} />
              ))}
            </div>
          ) : null}
          {isPr && tab === "code" ? (
            item.provider === "github" ? (
              <GithubPrReview
                key={`${item.projectPath}:${item.repo}:${item.number}:${revision}`}
                embedded
                cwd={item.projectPath}
                repo={item.repo}
                number={item.number}
                enabled
                onClose={() => undefined}
              />
            ) : gitlab ? (
              <GitlabMrReview
                key={`${item.projectPath}:${item.repo}:${item.number}:${revision}`}
                embedded
                cwd={item.projectPath}
                repo={item.repo}
                number={item.number}
                enabled
                onClose={() => undefined}
              />
            ) : null
          ) : loading ? (
            <div className="flex justify-center py-10 text-content/40">
              <LoaderCircle
                className="size-4 animate-spin"
                strokeWidth={1.75}
              />
            </div>
          ) : error && !details ? (
            <div className="text-[13px] text-content/50">
              {error}
              {jira || azure ? (
                <button
                  type="button"
                  className={ACTION_GHOST}
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Retry
                </button>
              ) : null}
            </div>
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
              {(jira || azure) && galleryAttachments.length ? (
                <TicketImages
                  key={`${item.site}:${item.id}:${revision}`}
                  item={item}
                  attachments={galleryAttachments}
                />
              ) : null}
              <InboxRelated
                key={`related:${inboxItemKey(item)}:${revision}`}
                item={item}
              />
              <InboxComments
                thread={thread}
                loading={threadLoading}
                error={threadError}
                cwd={markdownCwd}
                provider={item.provider}
                replyMode={linear ? "parent" : gitlab ? undefined : "thread"}
                onReply={jira || azure ? undefined : setReplyTo}
              />
              {(jira || azure) && threadError ? (
                <button
                  type="button"
                  className={ACTION_GHOST}
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Retry comments
                </button>
              ) : null}
              {jira || azure ? null : (
                <InboxCommentForm
                  replyTo={replyTo}
                  posting={posting}
                  error={postError}
                  onCancelReply={() => {
                    setReplyTo(null);
                    setPostError(null);
                  }}
                  onSubmit={postComment}
                />
              )}
            </>
          )}
        </div>
      </div>
    </InboxDetailShell>
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

