import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { InboxProviderMark } from "../inbox/ui/InboxProviderMark";
import { Modal } from "../../shared/ui/Modal";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "../../shared/ui/SearchableSelect";
import {
  Check,
  GitBranch,
  LoaderCircle,
  Plus,
  Search,
  X,
} from "../../shared/ui/icons";
import { inboxItemRef, type InboxItem } from "../inbox/model/githubTasks";
import { LAYER } from "../../shared/lib/layers";
import { pathKey, prettyCwd, projectName } from "../../shared/lib/paths";
import { sameProjectPath, type RecentProject } from "../projects/model/recents";
import type { LinkedWorkItem } from "../sessions/model/session";
import { linkedWorkItemInboxKey } from "../sessions/model/sessionWorkItem";
import {
  bindableWorktrees,
  namedWorktreeBranch,
  type Worktree,
} from "../source-control/model/worktrees";
import {
  localBranchOptions,
  peekProjectBranches,
  useProjectBranchesState,
} from "../source-control/hooks/useProjectBranches";
import { useProjectWorktrees } from "../source-control/hooks/useProjectWorktrees";
import { gitBranches, type GitBranches } from "../../platform/tauri/fs";
import { boardTicketOptions, groupSwatch } from "./boardData";
import {
  createGroup,
  loadBoard,
  MAX_WORKSTREAMS,
  type TaskWorkstream,
} from "./boardStore";

export type TaskWorkstreamSpec = {
  projectPath: string;
  branch: string;
  base: string;
  /** Bind this existing worktree instead of creating a new one. */
  worktreePath?: string;
};

export type NewTaskSpec = {
  title: string;
  links: LinkedWorkItem[];
  workstreams: TaskWorkstreamSpec[];
  /** Board groups the task starts in. */
  groupIds?: string[];
};

/** kebab-case fragment for `mc/<fragment>` branch names. */
function branchSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function suggestedBranch(
  title: string,
  links: LinkedWorkItem[],
): string {
  const key = links
    .map((link) => link.identifier ?? "")
    .find((identifier) => /[A-Za-z][A-Za-z0-9]+-\d+/.test(identifier));
  const fragment = branchSlug(
    `${key ? `${key.toLowerCase()}-` : ""}${title}`.slice(0, 64),
  );
  return namedWorktreeBranch(fragment) ?? "mc/task";
}

/** Resolve a typed/picked lane branch. A name matching an existing LOCAL
 * branch stays verbatim — spawn adopts it via the `existing: true` retry
 * (`mc/` wrapping would create a different branch instead). Anything else
 * is a new branch and gets the `mc/` convention. Callers on a submit path
 * should pass a fresh `branches` — the cache can lag branches created
 * outside the app, and wrapping a real branch in `mc/` silently forks it. */
export function resolveLaneBranch(
  projectPath: string,
  typed: string,
  branches?: GitBranches | null,
): string | null {
  const clean = typed.trim();
  if (!clean) return null;
  const known =
    branches !== undefined ? branches : peekProjectBranches(projectPath);
  // Cache still loading — pass the name through verbatim. The spawn path
  // adopts an existing branch or creates it under the user's literal name;
  // wrapping in `mc/` here could fork an existing branch into `mc/<name>`.
  if (!known) return clean;
  const isLocal = known.branches.some(
    (branch) => !branch.remote && branch.name === clean,
  );
  return isLocal ? clean : namedWorktreeBranch(clean);
}

/** Repo select options from recents — shared by this dialog and the
 * details panel's add-lane row. */
export function workstreamProjectOptions(recents: readonly RecentProject[]) {
  return recents.map((project) => ({
    value: project.path,
    label: projectName(project.path) || project.path,
  }));
}

/** Base-branch select options: every known ref, current checkout first when
 * it isn't listed. Shared by WorkstreamFields and the lane editor. */
export function baseBranchOptions(
  branches: GitBranches | null,
): SearchableSelectOption[] {
  const list = (branches?.branches ?? []).map((branch) => ({
    value: branch.remote ? `${branch.remote}/${branch.name}` : branch.name,
    label: branch.remote ? `${branch.remote}/${branch.name}` : branch.name,
  }));
  const current = branches?.current;
  return current && !list.some((option) => option.value === current)
    ? [{ value: current, label: current }, ...list]
    : list;
}

/** Existing-worktree select options — the main checkout is a valid bind
 * target too (lanes work on its checked-out branch). A stale bound path
 * stays listed so the pick can be corrected instead of rendering blank. */
export function worktreeLaneOptions(
  trees: readonly Worktree[],
  boundPath?: string,
): SearchableSelectOption[] {
  const options = bindableWorktrees(trees).map((tree) => ({
    value: tree.path,
    label: tree.isMain
      ? `Project checkout — ${tree.branch}`
      : `${tree.branch} — ${prettyCwd(tree.path)}`,
  }));
  if (
    boundPath &&
    !options.some((option) => pathKey(option.value) === pathKey(boundPath))
  ) {
    // The bound path isn't bindable — name the actual state so the user
    // knows whether to repoint (gone) or re-branch it (detached).
    const stale = trees.find(
      (tree) => pathKey(tree.path) === pathKey(boundPath),
    );
    options.push({
      value: boundPath,
      label: `${prettyCwd(boundPath)} — ${stale && !stale.missing ? "detached" : "missing"}`,
    });
  }
  return options;
}

type DraftWorkstream = {
  key: number;
  projectPath: string;
  /** "" → auto from title/tickets on submit. */
  branch: string;
  base: string;
  /** Bind this existing worktree instead of creating a new one. */
  worktreePath?: string;
};

/** Repo + branch + base inputs — shared by this dialog and the details
 * panel's add-workstream row. `tail` is the trailing button (remove/add). */
export function WorkstreamFields({
  draft,
  projects,
  onChange,
  tail,
  compact,
  layer,
  excludeWorktreePaths,
  excludeBranches,
  defaultBranch = "mc/task",
}: {
  draft: {
    projectPath: string;
    branch: string;
    base: string;
    worktreePath?: string;
  };
  projects: { value: string; label: string }[];
  onChange: (
    patch: Partial<{
      projectPath: string;
      branch: string;
      base: string;
      worktreePath?: string;
    }>,
  ) => void;
  tail: ReactNode;
  compact?: boolean;
  defaultBranch?: string;
  /** Popover layer — pass `LAYER.dialogPopover` when inside a modal. */
  layer?: number;
  /** pathKey'd worktree paths another lane already claims — offering one
   * would only fail at submit, so keep it out of the picker. */
  excludeWorktreePaths?: ReadonlySet<string>;
  /** Branch names another lane already tracks — claimed options and
   * worktrees checked out on them are equally unpickable. */
  excludeBranches?: ReadonlySet<string>;
}) {
  const branchListId = useId();
  const { branches } = useProjectBranchesState(
    draft.projectPath,
    !!draft.projectPath,
  );
  const { data: worktrees } = useProjectWorktrees(
    draft.projectPath,
    !!draft.projectPath,
  );
  const baseOptions = useMemo(() => baseBranchOptions(branches), [branches]);
  // Adoptable branches are local-only, matching CreateWorktreeDialog — the
  // spawn path creates a new branch from base for anything else it can't
  // adopt. "" keeps the auto-generated name.
  const branchOptions = useMemo(
    () => [
      { value: "", label: "Auto from task" },
      ...localBranchOptions(branches).filter(
        (option) => !excludeBranches?.has(option.value),
      ),
    ],
    [branches, excludeBranches],
  );
  // Existing worktrees of the chosen repo — a lane can bind one instead of
  // creating a fresh copy. Branch follows the pick (a bound lane's branch
  // is whatever the worktree has checked out).
  const worktreeOptions = useMemo(
    () =>
      worktreeLaneOptions(
        (worktrees?.worktrees ?? []).filter(
          // A bound pick syncs the lane's branch to the tree's — a tree on
          // a claimed branch would claim that branch too.
          (tree) =>
            !excludeWorktreePaths?.has(pathKey(tree.path)) &&
            !(tree.branch && excludeBranches?.has(tree.branch)),
        ),
        draft.worktreePath,
      ),
    [worktrees, draft.worktreePath, excludeWorktreePaths, excludeBranches],
  );
  const repoSelect = (
    <SearchableSelect
      label="Repository"
      value={draft.projectPath}
      options={projects}
      onChange={(projectPath) => {
        if (sameProjectPath(projectPath, draft.projectPath)) return;
        onChange({
          projectPath,
          worktreePath: undefined,
          branch: "",
          base: "",
        });
      }}
      placeholder={compact ? "Repo…" : "Choose repo…"}
      searchPlaceholder="Search projects…"
      layer={layer}
    />
  );
  const worktreeSelect = (
    <SearchableSelect
      label="Worktree"
      value={draft.worktreePath ?? ""}
      options={[{ value: "", label: "New worktree" }, ...worktreeOptions]}
      onChange={(path) => {
        const tree = worktrees?.worktrees.find((entry) => entry.path === path);
        onChange({
          // `path` may be the stale-bound synthetic option — keep it so the
          // pick stays visible instead of silently unbinding. Reverting to
          // "New worktree" drops the copied branch too — leaving it would
          // collide with the worktree it came from. A stale pick has no
          // live tree to read from — keep the branch it synced.
          worktreePath: path || undefined,
          branch: path ? (tree?.branch ?? draft.branch) : "",
        });
      }}
      placeholder="New worktree"
      searchPlaceholder="Search worktrees…"
      emptyLabel="No working copies"
      disabled={!draft.projectPath}
      layer={layer}
      minMenuWidth={280}
    />
  );
  const baseSelect = (
    <SearchableSelect
      label="Base branch"
      value={draft.base}
      options={baseOptions}
      onChange={(base) => onChange({ base })}
      placeholder="HEAD (current checkout)"
      searchPlaceholder="Branches…"
      disabled={!draft.projectPath}
      layer={layer}
      minMenuWidth={260}
    />
  );
  const branchSelect = (
    <SearchableSelect
      label="Branch"
      value={draft.branch}
      options={branchOptions}
      onChange={(branch) => onChange({ branch })}
      placeholder={branches ? "mc/branch…" : "…"}
      searchPlaceholder="Pick or type a branch…"
      creatable="New branch"
      exclude={excludeBranches}
      disabled={!draft.projectPath || !!draft.worktreePath}
      layer={layer}
      minMenuWidth={240}
    />
  );
  // Compact rows live in the narrow details panel — stack the repo over
  // branch+base so every field stays readable.
  if (compact) {
    return (
      <div className="flex flex-col gap-1.5">
        {repoSelect}
        {worktreeSelect}
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">{branchSelect}</div>
          <div className="w-28 shrink-0">{baseSelect}</div>
          {tail}
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0 rounded-lg border border-content/10 p-3">
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <GitBranch className="size-4 shrink-0 text-content/45" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium text-content">
            {projectName(draft.projectPath)}
          </p>
          <p
            className="truncate text-[10px] text-content/40"
            title={draft.projectPath}
          >
            {prettyCwd(draft.projectPath)}
          </p>
        </div>
        {tail}
      </div>
      <div className="mb-2 min-w-0">{worktreeSelect}</div>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {!draft.worktreePath && (
          <label className="min-w-0 text-[10px] text-content/50">
            Branch
            <input
              aria-label="Branch"
              list={branchListId}
              value={draft.branch}
              onChange={(event) => onChange({ branch: event.target.value })}
              placeholder={defaultBranch}
              className="mt-1 h-8 w-full min-w-0 rounded-md border border-content/10 bg-background-base px-2 text-[12px] text-content outline-none placeholder:text-content/40 focus:border-content/30"
            />
            <datalist id={branchListId}>
              {branchOptions
                .filter((option) => option.value)
                .map((option) => (
                  <option key={option.value} value={option.value} />
                ))}
            </datalist>
          </label>
        )}
        <div className="min-w-0">
          <p className="mb-1 text-[10px] text-content/50">
            {draft.worktreePath ? "PR base branch" : "Create from"}
          </p>
          {baseSelect}
        </div>
      </div>
    </div>
  );
}

export function NewTaskDialog({
  items,
  recents,
  lanes,
  busy,
  error,
  initialTitle,
  initialProject,
  fixedWorkstream,
  initialLinks = [],
  onSubmit,
  onCancel,
}: {
  items: InboxItem[];
  recents: RecentProject[];
  /** All board lanes — claimed worktree paths and branches are excluded
   * from the pickers (a pick that can only fail at submit is no option). */
  lanes: TaskWorkstream[];
  busy: boolean;
  /** Per-workstream errors from the last submit, joined for display. */
  error: string;
  /** Prefilled title — used when promoting a board-local card. */
  initialTitle?: string;
  initialProject?: string;
  /** Creating from chat binds this existing checkout and session. */
  fixedWorkstream?: TaskWorkstreamSpec;
  initialLinks?: LinkedWorkItem[];
  onSubmit: (spec: NewTaskSpec) => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const [title, setTitle] = useState(initialTitle ?? "");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Map<string, LinkedWorkItem>>(
    new Map(initialLinks.map((link) => [linkedWorkItemInboxKey(link), link])),
  );
  const [streams, setStreams] = useState<DraftWorkstream[]>(
    fixedWorkstream || initialProject
      ? [
          {
            key: 0,
            ...(fixedWorkstream ?? {
              projectPath: initialProject ?? "",
              branch: "",
              base: "",
            }),
          },
        ]
      : [],
  );
  // Group ids the task starts in; the list is read fresh on open and grows
  // when a new group is created inline.
  const [groups, setGroups] = useState(() => loadBoard().groups);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [newGroupName, setNewGroupName] = useState("");
  // `busy` (parent) only starts once onSubmit runs — `submitting` covers
  // the async branch-refresh span before it, blocking re-submit + cancel.
  const [submitting, setSubmitting] = useState(false);
  const nextKey = useRef(1);
  const titleRef = useRef<HTMLInputElement>(null);
  // The modal focuses its close button on mount — land title focus a frame
  // later so the composer starts on the field.
  useEffect(() => {
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const projects = useMemo(() => {
    const options = workstreamProjectOptions(recents);
    if (
      initialProject &&
      !options.some((option) => sameProjectPath(option.value, initialProject))
    )
      options.unshift({
        value: initialProject,
        label: projectName(initialProject),
      });
    return options;
  }, [recents, initialProject]);

  // Ticket picker lists everything the inbox knows that can become a link —
  // issues and PRs; delivery runs are status rows, not tickets.
  const tickets = useMemo(
    () => boardTicketOptions(items, query),
    [items, query],
  );

  const toggleTicket = (linked: LinkedWorkItem) => {
    const key = linkedWorkItemInboxKey(linked);
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, linked);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || submitting || !title.trim()) return;
    setSubmitting(true);
    try {
      const links = [...selected.values()];
      const fallback = suggestedBranch(title, links);
      // Fresh branch lists — a stale cache would wrap a branch created
      // outside the app in `mc/` instead of adopting it.
      const fresh = new Map<string, GitBranches | null>();
      for (const stream of streams) {
        if (
          !stream.worktreePath &&
          stream.projectPath &&
          !fresh.has(stream.projectPath)
        ) {
          fresh.set(
            stream.projectPath,
            await gitBranches(stream.projectPath).catch(() => null),
          );
        }
      }
      onSubmit({
        title: title.trim(),
        links,
        workstreams: streams
          .filter((stream) => stream.projectPath)
          .map((stream) => ({
            projectPath: stream.projectPath,
            // A bound worktree carries its own branch — resolveLaneBranch
            // would only be needed for fresh creations.
            branch: stream.worktreePath
              ? stream.branch
              : resolveLaneBranch(
                  stream.projectPath,
                  stream.branch,
                  fresh.get(stream.projectPath),
                ) || fallback,
            base: stream.base.trim() || "HEAD",
            ...(stream.worktreePath
              ? { worktreePath: stream.worktreePath }
              : {}),
          })),
        groupIds: [...selectedGroups],
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="New task"
      description={
        fixedWorkstream
          ? "Keep this conversation and its working copy together."
          : "Create one conversation across your working copies."
      }
      fitViewport
      footer={
        <div className="flex justify-end gap-2 p-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy || submitting}
            className="rounded-md px-3 py-1.5 text-[12px] text-content/70 outline-none hover:bg-content/8 focus-visible:ring-2 focus-visible:ring-accent/60 active:scale-[0.97] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            disabled={busy || submitting || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base outline-none transition-transform focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.97] disabled:opacity-40"
          >
            {busy || submitting ? (
              <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2} />
            ) : null}
            {!fixedWorkstream && streams.length > 0
              ? "Create & open agent"
              : "Create task"}
          </button>
        </div>
      }
      size="md"
      onClose={() => {
        if (!busy && !submitting) onCancel();
      }}
    >
      <form
        id={formId}
        onSubmit={submit}
        className="flex flex-col gap-4 px-4 pb-4 pt-1"
      >
        <label className="flex flex-col gap-1.5 text-[12px] text-content/70">
          Title
          <input
            ref={titleRef}
            value={title}
            required
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Auth token refresh across services"
            className="h-9 rounded-md border border-content/10 bg-background-base px-2.5 text-[13px] text-content outline-none placeholder:text-content/40 focus:border-content/25"
          />
        </label>

        {fixedWorkstream ? (
          <p className="break-words text-[12px] text-content/65">
            Current working copy:{" "}
            {prettyCwd(
              fixedWorkstream.worktreePath ?? fixedWorkstream.projectPath,
            )}
            {" · "}
            {fixedWorkstream.branch}. This conversation will be linked to the
            task. Add more repositories from task details.
          </p>
        ) : (
          <section className="min-w-0">
            <h3 className="mb-2 text-[12px] font-medium text-content/75">
              Repositories
            </h3>
            <div className="flex min-w-0 flex-col gap-2">
              {streams.map((stream) => {
                // Claims against this row's repo: board lanes own their
                // paths+branches; sibling rows claim each picked worktree
                // and the branch it synced.
                const excludePaths = new Set<string>();
                const excludeBranches = new Set<string>();
                for (const ws of lanes) {
                  if (!sameProjectPath(ws.projectPath, stream.projectPath))
                    continue;
                  excludeBranches.add(ws.branch);
                  if (ws.worktreePath)
                    excludePaths.add(pathKey(ws.worktreePath));
                }
                for (const other of streams) {
                  if (
                    other === stream ||
                    !sameProjectPath(other.projectPath, stream.projectPath)
                  )
                    continue;
                  // "" is the auto-name sentinel, never a real claim.
                  if (other.branch) excludeBranches.add(other.branch);
                  if (other.worktreePath)
                    excludePaths.add(pathKey(other.worktreePath));
                }
                return (
                  <WorkstreamFields
                    key={stream.key}
                    draft={stream}
                    defaultBranch={suggestedBranch(title, [
                      ...selected.values(),
                    ])}
                    projects={projects}
                    layer={LAYER.dialogPopover}
                    excludeWorktreePaths={excludePaths}
                    excludeBranches={excludeBranches}
                    onChange={(patch) =>
                      setStreams((current) =>
                        current.map((entry) =>
                          entry.key === stream.key
                            ? { ...entry, ...patch }
                            : entry,
                        ),
                      )
                    }
                    tail={
                      <button
                        type="button"
                        aria-label={`Remove ${stream.projectPath ? projectName(stream.projectPath) : "repository"}`}
                        onClick={() =>
                          setStreams((current) =>
                            current.filter((entry) => entry.key !== stream.key),
                          )
                        }
                        className="grid size-7 shrink-0 place-items-center rounded-md text-content/40 outline-none hover:bg-content/8 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
                      >
                        <X className="size-3.5" strokeWidth={1.75} />
                      </button>
                    }
                  />
                );
              })}
            </div>
            <div className="mt-2">
              <SearchableSelect
                label="Add repository"
                value=""
                options={projects}
                placeholder="Add repository…"
                searchPlaceholder="Search repositories…"
                layer={LAYER.dialogPopover}
                disabled={
                  busy || submitting || streams.length >= MAX_WORKSTREAMS
                }
                onChange={(projectPath) => {
                  if (projectPath)
                    setStreams((current) => [
                      ...current,
                      {
                        key: nextKey.current++,
                        projectPath,
                        branch: "",
                        base: "",
                      },
                    ]);
                }}
              />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-content/45">
              {streams.length
                ? "One agent session across these working copies. Nothing runs until you send a message."
                : "Add a repository to start an agent, or create the task and set it up later."}
            </p>
          </section>
        )}

        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-content/40">
              Tickets
            </h3>
            {selected.size ? (
              <span className="text-[11px] text-content/45">
                {selected.size} linked
              </span>
            ) : null}
          </div>
          {selected.size ? (
            // Linked tickets stay visible as chips — the list scrolls away.
            <div className="mb-1.5 flex flex-wrap gap-1">
              {[...selected.entries()].map(([key, link]) => (
                <button
                  key={key}
                  type="button"
                  title="Unlink ticket"
                  onClick={() => toggleTicket(link)}
                  className="flex max-w-44 items-center gap-1 rounded-md bg-content/7 px-1.5 py-0.5 text-[11px] text-content/70 outline-none hover:bg-content/10 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
                >
                  {link.provider ? (
                    <InboxProviderMark
                      provider={link.provider}
                      className="size-3 shrink-0 text-content/55"
                    />
                  ) : null}
                  <span className="truncate">
                    {link.identifier ?? link.title ?? key}
                  </span>
                  <X className="size-2.5 shrink-0" strokeWidth={2} />
                </button>
              ))}
            </div>
          ) : null}
          <label className="relative mb-1.5 flex items-center">
            <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Inside the form an unguarded Enter submits the whole
                // task — searching must never create worktrees/sessions.
                if (event.key === "Enter") event.preventDefault();
              }}
              placeholder="Search inbox items…"
              aria-label="Search tickets"
              className="h-7 w-full rounded-md bg-content/6 pl-7 pr-2 text-[12px] text-content outline-none placeholder:text-content/40 focus:ring-1 focus:ring-accent/40"
            />
          </label>
          <div
            role="group"
            aria-label="Tickets"
            className="max-h-44 overflow-y-auto overscroll-none rounded-lg border border-content/8"
          >
            {tickets.map(({ item, linked }) => {
              const key = linkedWorkItemInboxKey(linked);
              const checked = selected.has(key);
              return (
                <button
                  key={key}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggleTicket(linked)}
                  className="flex w-full items-center gap-2 border-b border-content/5 px-2 py-1.5 text-left outline-none last:border-0 hover:bg-content/5 focus-visible:bg-content/6"
                >
                  <InboxProviderMark
                    provider={item.provider}
                    className="size-3.5 shrink-0 text-content/60"
                  />
                  <span className="shrink-0 rounded bg-content/8 px-1 py-px text-[10px] font-medium text-content/55">
                    {inboxItemRef(item)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                    {item.title}
                  </span>
                  {checked ? (
                    <Check
                      className="size-3.5 shrink-0 text-accent"
                      strokeWidth={2.25}
                    />
                  ) : null}
                </button>
              );
            })}
            {!tickets.length ? (
              <p className="px-3 py-2.5 text-[12px] text-content/40">
                No inbox items match. You can still create the task and link
                tickets later.
              </p>
            ) : null}
          </div>
        </section>

        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-content/40">
            Groups
          </h3>
          <div className="flex flex-wrap items-center gap-1">
            {groups.map((group) => {
              const swatch = groupSwatch(group.color);
              const on = selectedGroups.has(group.id);
              return (
                <button
                  key={group.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setSelectedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                  className={`inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
                    on
                      ? `${swatch.chip} ring-1 ring-current/30`
                      : "bg-content/6 text-content/50 hover:bg-content/10 hover:text-content"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`size-1.5 rounded-full ${swatch.dot}`}
                  />
                  <span className="min-w-0 truncate">{group.name}</span>
                  {on ? (
                    <Check className="size-2.5 shrink-0" strokeWidth={2.5} />
                  ) : null}
                </button>
              );
            })}
            <label className="inline-flex h-5 items-center gap-1 rounded border border-dashed border-content/20 px-1.5 text-content/40 focus-within:border-content/40 focus-within:text-content/60">
              <Plus className="size-2.5 shrink-0" strokeWidth={2.5} />
              <input
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const id = createGroup(newGroupName);
                  if (id) {
                    setGroups(loadBoard().groups);
                    setSelectedGroups((current) => new Set(current).add(id));
                    setNewGroupName("");
                  }
                }}
                placeholder="New group…"
                aria-label="New group name"
                className="w-20 bg-transparent text-[11px] outline-none placeholder:text-content/40"
              />
            </label>
          </div>
        </section>

        {error ? (
          <p role="alert" className="text-[12px] text-red-300">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
