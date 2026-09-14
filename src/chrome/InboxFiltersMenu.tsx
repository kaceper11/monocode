import { Check, CircleDot, GitPullRequest } from "./icons";
import { type ReactNode } from "react";
import type { InboxKind } from "../lib/githubTasks";
import {
  DEFAULT_INBOX_FILTERS,
  INBOX_SOURCES,
  INBOX_SOURCE_LABELS,
  hasActiveInboxFilters,
  type InboxFilters,
  type InboxSource,
  type InboxTimeFilter,
  type LinearProjectOption,
} from "../lib/inboxFilters";
import type { LinearTeam } from "../lib/linear";
import {
  DEFAULT_JIRA_FILTER,
  type JiraFilter,
  type JiraOption,
} from "../lib/jira";
import { Popover } from "./Popover";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { InboxProviderMark } from "./InboxProviderMark";
import { useEffect, useState } from "react";
import { azureOptions, saveAzureFilter, type AzureFilter, type AzureOption } from "../lib/azure";

export const INBOX_FILTER_MENU_WIDTH = 228;

type ProjectOption = {
  /** Rail identity — a normalized path or `project:<id>` for groups. */
  key: string;
  name: string;
  logoPath: string | null;
};

type Props = {
  x: number;
  y: number;
  projects: ProjectOption[];
  linearProjects: LinearProjectOption[];
  linearTeams: LinearTeam[];
  hiddenLinearTeamIds: string[];
  source: InboxSource;
  filters: InboxFilters;
  onChange: (filters: InboxFilters) => void;
  /** Shared with Settings → Linear Teams; narrows the fetch, not just the list. */
  onLinearTeamsChange: (ids: string[]) => void;
  onClose: () => void;
  jiraFilter?: JiraFilter;
  jiraProjects?: JiraOption[];
  jiraFavorites?: JiraOption[];
  jiraOptionsError?: string;
  onJiraFilterChange?: (filter: JiraFilter) => void;
  visibleSources?: InboxSource[];
  onVisibleSourcesChange?: (sources: InboxSource[]) => void;
  azure?: { site: string; filter: AzureFilter };
};

const TIME_OPTIONS: { id: InboxTimeFilter; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
];

const KIND_OPTIONS: {
  id: InboxKind;
  label: string;
  icon: ReactNode;
}[] = [
  {
    id: "issue",
    label: "Issues",
    icon: <CircleDot className="size-3.5 shrink-0" strokeWidth={1.75} />,
  },
  {
    id: "pr",
    label: "Pull requests",
    icon: <GitPullRequest className="size-3.5 shrink-0" strokeWidth={1.75} />,
  },
];

export function InboxFiltersMenu({
  x,
  y,
  projects,
  linearProjects,
  linearTeams,
  hiddenLinearTeamIds,
  source,
  filters,
  onChange,
  onLinearTeamsChange,
  onClose,
  jiraFilter = DEFAULT_JIRA_FILTER,
  jiraProjects = [],
  jiraFavorites = [],
  jiraOptionsError,
  onJiraFilterChange,
  visibleSources = INBOX_SOURCES,
  onVisibleSourcesChange,
  azure,
}: Props) {
  const ticket = source === "linear" || source === "jira";
  const hiddenProjects = new Set(filters.hiddenProjects);
  const hiddenLinearProjects = new Set(filters.hiddenLinearProjects);
  const hiddenTeams = new Set(hiddenLinearTeamIds);
  const hiddenKinds = new Set(filters.hiddenKinds);
  const teamsActive = source === "linear" && hiddenLinearTeamIds.length > 0;

  const toggleAssigned = () => {
    onChange({ ...filters, assignedToMe: !filters.assignedToMe });
  };

  const toggleKind = (kind: InboxKind) => {
    const next = new Set(hiddenKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    onChange({ ...filters, hiddenKinds: [...next] });
  };

  const toggleProject = (key: string) => {
    const next = new Set(hiddenProjects);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange({ ...filters, hiddenProjects: [...next] });
  };

  const toggleLinearTeam = (id: string) => {
    const next = new Set(hiddenTeams);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onLinearTeamsChange([...next]);
  };

  const toggleLinearProject = (id: string) => {
    const next = new Set(hiddenLinearProjects);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...filters, hiddenLinearProjects: [...next] });
  };

  const setTime = (time: InboxTimeFilter) => {
    onChange({ ...filters, time });
  };

  const toggleStatus = (key: keyof InboxFilters["status"]) => {
    onChange({
      ...filters,
      status: { ...filters.status, [key]: !filters.status[key] },
    });
  };

  return (
    <Popover
      anchor={{ x, y }}
      gap={0}
      width={INBOX_FILTER_MENU_WIDTH}
      maxHeight={480}
      onDismiss={onClose}
      role="menu"
      aria-label="Filter inbox"
      onContextMenu={(event) => event.preventDefault()}
      className="overflow-y-auto overscroll-none p-1"
    >
      {onVisibleSourcesChange ? (
        <>
          <SectionLabel>Visible sources</SectionLabel>
          {INBOX_SOURCES.map((provider) => (
            <FilterItem
              key={provider}
              label={INBOX_SOURCE_LABELS[provider]}
              icon={
                <InboxProviderMark
                  provider={provider}
                  className="size-3.5 shrink-0"
                />
              }
              checked={visibleSources.includes(provider)}
              disabled={
                visibleSources.length === 1 && visibleSources.includes(provider)
              }
              onClick={() =>
                onVisibleSourcesChange(
                  INBOX_SOURCES.filter((candidate) =>
                    candidate === provider
                      ? !visibleSources.includes(candidate)
                      : visibleSources.includes(candidate),
                  ),
                )
              }
            />
          ))}
          <div role="separator" className="my-1 h-px bg-content/10" />
        </>
      ) : null}
      {source === "azure" && azure ? <AzureFilters site={azure.site} filter={azure.filter} /> : <FilterItem
        label={source === "gitlab" ? "Needs attention" : "Assigned to me"}
        checked={source === "jira" ? jiraFilter.assigned : filters.assignedToMe}
        onClick={
          source === "jira"
            ? () =>
                onJiraFilterChange?.({
                  ...jiraFilter,
                  assigned: !jiraFilter.assigned,
                })
            : toggleAssigned
        }
      />}

      <SectionLabel>Status</SectionLabel>
      <FilterItem
        label="Open"
        checked={filters.status.open}
        onClick={() => toggleStatus("open")}
      />
      {!ticket ? (
        <FilterItem
          label="Draft"
          checked={filters.status.draft}
          onClick={() => toggleStatus("draft")}
        />
      ) : null}
      <FilterItem
        label="Closed"
        checked={filters.status.closed}
        onClick={() => toggleStatus("closed")}
      />
      {!ticket ? (
        <FilterItem
          label="Merged"
          checked={filters.status.merged}
          onClick={() => toggleStatus("merged")}
        />
      ) : null}

      <SectionLabel>Time</SectionLabel>
      {TIME_OPTIONS.map((option) => (
        <FilterItem
          key={option.id}
          label={option.label}
          checked={filters.time === option.id}
          onClick={() => setTime(option.id)}
        />
      ))}

      {!ticket ? (
        <>
          <SectionLabel>Type</SectionLabel>
          {(source === "azure" ? [...KIND_OPTIONS.map(option => option.id === "issue" ? {...option,id:"azure" as const} : option), {id:"ci" as const,label:"CI",icon:<CircleDot className="size-3.5" />} ] : KIND_OPTIONS).map((option) => (
            <FilterItem
              key={option.id}
              label={
                source === "gitlab" && option.id === "pr"
                  ? "Merge requests"
                  : option.label
              }
              checked={!hiddenKinds.has(option.id)}
              icon={option.icon}
              onClick={() => toggleKind(option.id)}
            />
          ))}
        </>
      ) : null}

      {source === "linear" && linearTeams.length > 0 ? (
        <>
          <SectionLabel>Teams</SectionLabel>
          {linearTeams.map((team) => (
            <FilterItem
              key={team.id}
              label={team.name || team.key}
              checked={!hiddenTeams.has(team.id)}
              onClick={() => toggleLinearTeam(team.id)}
            />
          ))}
        </>
      ) : null}

      {source === "linear" && linearProjects.length > 0 ? (
        <>
          <SectionLabel>Projects</SectionLabel>
          {linearProjects.map((project) => (
            <FilterItem
              key={project.id}
              label={project.name}
              checked={!hiddenLinearProjects.has(project.id)}
              onClick={() => toggleLinearProject(project.id)}
            />
          ))}
        </>
      ) : null}

      {source === "jira" ? (
        <>
          <SectionLabel>Projects</SectionLabel>
          <FilterItem
            label="All projects"
            checked={!jiraFilter.project}
            onClick={() => onJiraFilterChange?.({ ...jiraFilter, project: "" })}
          />
          {jiraProjects.map((project) => (
            <FilterItem
              key={project.id}
              label={project.name}
              checked={jiraFilter.project === project.id}
              onClick={() =>
                onJiraFilterChange?.({ ...jiraFilter, project: project.id })
              }
            />
          ))}
          <SectionLabel>Favorite filters</SectionLabel>
          <FilterItem
            label="No saved filter"
            checked={!jiraFilter.filter}
            onClick={() => onJiraFilterChange?.({ ...jiraFilter, filter: "" })}
          />
          {jiraFavorites.map((filter) => (
            <FilterItem
              key={filter.id}
              label={filter.name}
              checked={jiraFilter.filter === filter.id}
              onClick={() =>
                onJiraFilterChange?.({
                  ...jiraFilter,
                  filter: filter.id,
                  assigned: false,
                })
              }
            />
          ))}
          {jiraOptionsError ? (
            <p className="px-2 py-1 text-[12px] text-content/50">
              {jiraOptionsError} Close and reopen filters to retry.
            </p>
          ) : null}
        </>
      ) : null}

      {!ticket &&
      source !== "azure" &&
      !(source === "gitlab" && filters.assignedToMe) &&
      projects.length > 0 ? (
        <>
          <SectionLabel>Projects</SectionLabel>
          {projects.map((project) => (
            <FilterItem
              key={project.key}
              label={project.name}
              checked={!hiddenProjects.has(project.key)}
              icon={
                project.logoPath ? (
                  <ProjectLogoIcon
                    path={project.logoPath}
                    className="size-3.5 shrink-0 rounded-sm"
                    imageClassName="size-3.5"
                  />
                ) : undefined
              }
              onClick={() => toggleProject(project.key)}
            />
          ))}
        </>
      ) : null}

      {hasActiveInboxFilters(filters, source, hiddenLinearTeamIds) ||
      (source === "azure" && azure && (azure.filter.query || !azure.filter.assigned)) ||
      (source === "jira" &&
        (jiraFilter.project || jiraFilter.filter || !jiraFilter.assigned)) ? (
        <>
          <div role="separator" className="my-1 h-px bg-content/10" />
          <button
            type="button"
            role="menuitem"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange(DEFAULT_INBOX_FILTERS);
              if (teamsActive) onLinearTeamsChange([]);
              if (source === "jira") onJiraFilterChange?.(DEFAULT_JIRA_FILTER);
              if (source === "azure" && azure) saveAzureFilter(azure.site, { ...azure.filter, query: "", assigned: true });
            }}
            className="flex h-7 w-full items-center rounded-lg px-2 text-left text-[13px] leading-none text-content/70 hover:bg-content/5 hover:text-content"
          >
            Clear filters
          </button>
        </>
      ) : null}
    </Popover>
  );
}

function AzureFilters({ site, filter }: { site: string; filter: AzureFilter }) {
  const [projects, setProjects] = useState<AzureOption[]>([]);
  const [queries, setQueries] = useState<AzureOption[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!site) return;
    let cancelled = false;
    setLoading(true); setError(""); setQueries([]);
    void Promise.allSettled([azureOptions(site, filter.project, false), azureOptions(site, filter.project, true)]).then(([p,q]) => {
      if (cancelled) return;
      if (p.status === "fulfilled") setProjects(p.value);
      if (q.status === "fulfilled") setQueries(q.value);
      setError([p,q].filter(r => r.status === "rejected").map(r => String(r.reason)).join(" "));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [site, filter.project, retry]);
  const change = (next: AzureFilter) => saveAzureFilter(site, next);
  return <>
    <div className="truncate px-2 py-1 text-[11px] text-content/50" title={site}>{site.replace("https://dev.azure.com/", "") || "Connect Azure DevOps in Settings"}</div>
    <FilterItem label="Assigned to me" checked={filter.assigned && !filter.query} disabled={!site} onClick={() => change({ ...filter, query: "", assigned: !filter.assigned })} />
    <SectionLabel>Project</SectionLabel>
    {[{ id: filter.project, name: filter.project }, ...projects.filter(p => p.id !== filter.project)].filter(p => p.id).map(p => <FilterItem key={p.id} label={p.name} checked={p.id === filter.project} onClick={() => change({ project: p.id, query: "", assigned: true })} />)}
    <SectionLabel>Saved query</SectionLabel>
    <FilterItem label="No saved query" checked={!filter.query} onClick={() => change({ ...filter, query: "" })} />
    {queries.map(q => <FilterItem key={q.id} label={q.name} checked={q.id === filter.query} onClick={() => change({ ...filter, query: q.id, assigned: false })} />)}
    {loading ? <p role="status" className="px-2 py-1 text-[12px] text-content/50">Loading projects and queries…</p> : null}
    <p className="px-2 py-1 text-[11px] text-content/40">Up to 100 projects and flat queries, two folder levels.</p>
    {error ? <p role="alert" className="px-2 py-1 text-[12px] text-content/50">{error} <button className="underline" onClick={() => setRetry(v => v + 1)}>Retry</button></p> : null}
  </>;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content/40">
      {children}
    </div>
  );
}

function FilterItem({
  label,
  checked,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-none text-content hover:bg-content/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/50 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked ? (
        <Check className="size-3.5 shrink-0" strokeWidth={2.25} />
      ) : null}
    </button>
  );
}
