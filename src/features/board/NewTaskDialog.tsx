import {
  useSavedProjects,
} from "../projects/model/savedProjects";
import { SavedProjectDialog } from "../projects/ui/SavedProjectDialog";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { TaskTicketPicker } from "./TaskTicketPicker";
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
  RefreshCw,
  X,
} from "../../shared/ui/icons";
import { type InboxItem } from "../inbox/model/githubTasks";
import { LAYER } from "../../shared/lib/layers";
import { pathKey, prettyCwd, projectName } from "../../shared/lib/paths";
import { sameProjectPath, type RecentProject } from "../projects/model/recents";
import { useTaskGitBusy, useTaskGitOperation } from "./TaskGitActions";
import type { LinkedWorkItem } from "../sessions/model/session";
import { linkedWorkItemInboxKey } from "../sessions/model/sessionWorkItem";
import {
  bindableWorktrees,
  namedWorktreeBranch,
  type Worktree,
} from "../source-control/model/worktrees";
import {
  localBranchOptions,
  taskBranchChoice,
  useProjectBranchesState,
} from "../source-control/hooks/useProjectBranches";
import { useProjectWorktrees } from "../source-control/hooks/useProjectWorktrees";
import { type GitBranches } from "../../platform/tauri/fs";
import { groupSwatch } from "./boardData";
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
  remote?: string;
  /** Bind this existing worktree instead of creating a new one. */
  worktreePath?: string;
  /** Track the branch only — no working copy is prepared on submit. */
  noWorktree?: boolean;
};

export type NewTaskSpec = {
  projectId?: string;
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

/** Preserve explicit branch names; only the task's automatic suggestion uses mc/. */
export function resolveLaneBranch(typed: string): string | null {
  return taskBranchChoice(typed.trim()).branch || null;
}

/** Repo select options from recents — shared by this dialog and the
 * details panel's add-lane row. */
export function workstreamProjectOptions(recents: readonly RecentProject[]) {
  return recents.map((project) => ({
    value: project.path,
    label: projectName(project.path) || project.path,
  }));
}

/** Task-lane repo options: recents plus every saved-project member, deduped
 * by path. Members may never have been opened, so recents alone miss them. */
export function taskProjectOptions(
  recents: readonly RecentProject[],
  savedProjects: readonly { members: readonly string[] }[],
) {
  return workstreamProjectOptions([
    ...new Map(
      [
        ...recents,
        ...savedProjects.flatMap((project) =>
          project.members.map((path) => ({ path, openedAt: 0 })),
        ),
      ].map((project) => [pathKey(project.path), project]),
    ).values(),
  ]);
}

/** Base-branch select options: every known ref, current checkout first when
 * it isn't listed. Shared by WorkstreamFields and the lane editor. */
export function baseBranchOptions(
  branches: GitBranches | null,
  selected?: string,
): SearchableSelectOption[] {
  const list = (branches?.branches ?? []).map((branch) => ({
    value: branch.remote ? `${branch.remote}/${branch.name}` : branch.name,
    label: branch.remote ? `${branch.remote}/${branch.name}` : branch.name,
  }));
  if (selected && !list.some((option) => option.value === selected))
    list.unshift({
      value: selected,
      label: selected.replace(/^refs\/remotes\//, ""),
    });
  const current = branches?.current;
  return current && !list.some((option) => option.value === current)
    ? [{ value: current, label: current }, ...list]
    : list;
}

/** One row in the working-copy pick list — a bindable worktree, a stale
 * bound path, or a New/None action row appended by the caller. */
export type CopyPick = {
  value: string;
  /** Primary text — branch name or action label. */
  title: string;
  /** Muted suffix — path tail, "detached", "current". */
  detail?: string;
  icon?: "branch" | "new" | "none";
  disabled?: boolean;
};

/** Bindable worktrees as copy-pick rows — the main checkout is a valid bind
 * target too (lanes work on its checked-out branch). A stale bound path
 * stays listed so the pick can be corrected instead of rendering blank. */
export function worktreeCopyPicks(
  trees: readonly Worktree[],
  boundPath?: string,
): CopyPick[] {
  const isBound = (path: string) => pathKey(path) === pathKey(boundPath ?? "");
  const picks: CopyPick[] = bindableWorktrees(trees).map((tree) => ({
    value: tree.path,
    title: tree.isMain ? "Main checkout" : tree.branch!,
    detail: [
      tree.isMain ? tree.branch : prettyCwd(tree.path),
      isBound(tree.path) ? "current" : "",
    ]
      .filter(Boolean)
      .join(" · "),
    icon: "branch",
  }));
  if (boundPath && !picks.some((pick) => isBound(pick.value))) {
    // The bound path isn't bindable — name the actual state so the user
    // knows whether to repoint (gone) or re-branch it (detached).
    const stale = trees.find(
      (tree) => pathKey(tree.path) === pathKey(boundPath),
    );
    picks.push({
      value: boundPath,
      title: prettyCwd(boundPath),
      detail: `${stale && !stale.missing ? "detached" : "missing"} · current`,
      icon: "branch",
    });
  }
  // The bound copy leads the list — it describes the current state.
  return [
    ...picks.filter((pick) => isBound(pick.value)),
    ...picks.filter((pick) => !isBound(pick.value)),
  ];
}

/** Radio-style pick list for working copies — every option is visible and
 * one click selects it; the mode choice isn't buried in a dropdown. */
export function CopyPickList({
  value,
  options,
  onPick,
  disabled,
}: {
  value: string;
  options: CopyPick[];
  onPick: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Working copy"
      onKeyDown={(event) => {
        if (
          ![
            "ArrowDown",
            "ArrowUp",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
          ].includes(event.key)
        )
          return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button[role="radio"]:not(:disabled)',
          ),
        ];
        if (!buttons.length) return;
        event.preventDefault();
        const current = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (current +
                  (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) +
                  buttons.length) %
                buttons.length;
        buttons[next].focus();
        buttons[next].click();
      }}
      className="flex max-h-36 flex-col gap-0.5 overflow-y-auto rounded-lg border border-content/10 bg-content/[0.02] p-1"
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value || "__new"}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={
              (selected && !option.disabled) ||
              (!options.some(
                (option) => option.value === value && !option.disabled,
              ) &&
                index === options.findIndex((option) => !option.disabled))
                ? 0
                : -1
            }
            disabled={disabled || option.disabled}
            onClick={() => onPick(option.value)}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-45 ${
              selected
                ? "bg-accent/10 text-content ring-1 ring-inset ring-accent/30"
                : "text-content/75 hover:bg-content/5"
            }`}
          >
            {option.icon === "new" ? (
              <Plus
                className="size-3.5 shrink-0 text-content/60"
                strokeWidth={2}
              />
            ) : option.icon === "none" ? (
              <X
                className="size-3.5 shrink-0 text-content/60"
                strokeWidth={2}
              />
            ) : (
              <GitBranch
                className="size-3.5 shrink-0 text-content/60"
                strokeWidth={1.75}
              />
            )}
            <span className="min-w-0 flex-1 truncate">
              <span className={selected ? "font-medium" : ""}>
                {option.title}
              </span>
              {option.detail ? (
                <span className="text-content/60"> · {option.detail}</span>
              ) : null}
            </span>
            {selected ? (
              <Check
                className="size-3.5 shrink-0 text-accent"
                strokeWidth={2.25}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

type DraftWorkstream = {
  key: number;
  projectPath: string;
  /** "" → auto from title/tickets on submit. */
  branch: string;
  base: string;
  remote?: string;
  /** Bind this existing worktree instead of creating a new one. */
  worktreePath?: string;
  /** Track the branch only — the lane prepares a copy on demand. */
  noWorktree?: boolean;
};

/** Working-copy pick that binds nothing — real values are absolute paths. */
export const NO_COPY = "none";

/** Repo + working-copy + branch/base inputs — shared by this dialog and the
 * details panel's add-workstream row. `tail` is the trailing button
 * (remove/add). Every row stays mounted across mode changes — a pick only
 * ever disables or re-labels a field, so choosing a copy never reflows the
 * form. */
export function WorkstreamFields({
  draft,
  onChange,
  tail,
  layer,
  excludeWorktreePaths,
  excludeBranches,
  defaultBranch = "mc/task",
}: {
  draft: {
    projectPath: string;
    branch: string;
    base: string;
    remote?: string;
    worktreePath?: string;
    noWorktree?: boolean;
  };
  onChange: (
    patch: Partial<{
      projectPath: string;
      branch: string;
      base: string;
      remote?: string;
      worktreePath?: string;
      noWorktree?: boolean;
    }>,
  ) => void;
  tail: ReactNode;
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
  const gitBusy = useTaskGitBusy([draft.projectPath]);
  const gitOp = useTaskGitOperation([draft.projectPath]);
  const { branches } = useProjectBranchesState(
    draft.projectPath,
    !!draft.projectPath,
  );
  const {
    data: worktrees,
    error: worktreeError,
    refresh: refreshWorktrees,
  } = useProjectWorktrees(draft.projectPath, !!draft.projectPath);
  useEffect(() => {
    if (!draft.worktreePath || draft.branch || !worktrees) return;
    const tree = worktrees.worktrees.find(
      (tree) => pathKey(tree.path) === pathKey(draft.worktreePath!),
    );
    if (tree?.branch) onChange({ branch: tree.branch });
  }, [draft.worktreePath, draft.branch, worktrees, onChange]);
  const baseOptions = useMemo(
    () => baseBranchOptions(branches, draft.base),
    [branches, draft.base],
  );
  // Adoptable branches are local-only, matching CreateWorktreeDialog — the
  // spawn path creates a new branch from base for anything else it can't
  // adopt. "" keeps the auto-generated name.
  const branchOptions = useMemo(
    () => [
      { value: "", label: "Auto from task" },
      ...localBranchOptions(branches).map((option) => ({
        ...option,
        disabled: excludeBranches?.has(option.value),
      })),
    ],
    [branches, excludeBranches],
  );
  // Existing worktrees of the chosen repo — a lane can bind one instead of
  // creating a fresh copy. Branch follows the pick (a bound lane's branch
  // is whatever the worktree has checked out).
  const copyPicks = useMemo(
    () => [
      { value: "", title: "Create new worktree", icon: "new" as const },
      ...worktreeCopyPicks(worktrees?.worktrees ?? [], draft.worktreePath).map(
        (pick) => {
          const tree = worktrees?.worktrees.find(
            (tree) => pathKey(tree.path) === pathKey(pick.value),
          );
          const claimed =
            excludeWorktreePaths?.has(pathKey(pick.value)) ||
            (!!tree?.branch && excludeBranches?.has(tree.branch));
          return {
            ...pick,
            disabled: claimed,
            detail: [pick.detail, claimed ? "used by another task" : ""]
              .filter(Boolean)
              .join(" · "),
          };
        },
      ),
      ...(draft.noWorktree
        ? [
            {
              value: NO_COPY,
              title: "No working copy",
              detail: "Track the branch only",
              icon: "none" as const,
            },
          ]
        : []),
    ],
    [worktrees, draft.worktreePath, excludeWorktreePaths, excludeBranches],
  );
  const field = (label: string, control: ReactNode) => (
    <div className="grid min-w-0 grid-cols-[76px_minmax(0,1fr)] items-center gap-2 text-[11px] text-content/60">
      <span className="truncate">{label}</span>
      {control}
    </div>
  );
  const worktreeSelect = (
    <CopyPickList
      value={draft.noWorktree ? NO_COPY : (draft.worktreePath ?? "")}
      options={copyPicks}
      disabled={!draft.projectPath || gitBusy}
      onPick={(path) => {
        if (path === NO_COPY) {
          // Track the branch only — task details can prepare a copy later.
          onChange({ noWorktree: true, worktreePath: undefined });
          return;
        }
        const tree = worktrees?.worktrees.find((entry) => entry.path === path);
        onChange({
          noWorktree: false,
          // `path` may be the stale-bound synthetic option — keep it so the
          // pick stays visible instead of silently unbinding. Leaving a
          // bound pick for "new" drops the synced branch (it would collide
          // with the copy it came from); "none" keeps it — a tracked branch
          // survives detaching the copy. A stale pick has no live tree to
          // read from — keep the branch it synced.
          worktreePath: path || undefined,
          branch: path
            ? (tree?.branch ?? draft.branch)
            : draft.worktreePath
              ? ""
              : draft.branch,
        });
      }}
    />
  );
  const baseSelect = (
    <SearchableSelect
      variant="field"
      label="Base branch"
      value={draft.base}
      options={baseOptions}
      onChange={(base) => onChange({ base })}
      placeholder="HEAD (current checkout)"
      searchPlaceholder="Branches…"
      disabled={!draft.projectPath || gitBusy}
      layer={layer}
      minMenuWidth={260}
    />
  );
  const branchSelect = (
    <SearchableSelect
      variant="field"
      label="Branch"
      value={draft.branch}
      options={branchOptions}
      onChange={(value) => {
        const choice = taskBranchChoice(value);
        onChange({
          branch: choice.branch,
          ...(choice.base ? { base: choice.base } : {}),
        });
      }}
      placeholder={defaultBranch}
      searchPlaceholder="Pick or type a branch…"
      creatable="New branch"
      exclude={excludeBranches}
      disabled={!draft.projectPath || gitBusy || !!draft.worktreePath}
      layer={layer}
      minMenuWidth={240}
    />
  );
  // One status line under the fields: what the current picks mean, or the
  // loading/error state. Always rendered so the card never grows on load.
  const hint = gitOp
    ? `Git is busy — ${gitOp}`
    : worktreeError
      ? worktreeError
      : draft.projectPath && !worktrees
        ? "Loading working copies…"
        : draft.worktreePath
          ? `${draft.branch || "Bound branch"} · ${prettyCwd(draft.worktreePath)}`
          : draft.noWorktree
            ? "Tracks the branch only — attach or create a copy later"
            : `New worktree branches from ${draft.base || "the current checkout"}`;
  const footer = (
    <div className="mt-1.5 flex items-center gap-2">
      <p
        role={
          worktreeError
            ? "alert"
            : draft.projectPath && !worktrees
              ? "status"
              : undefined
        }
        title={hint}
        className={`min-w-0 flex-1 truncate text-[11px] ${worktreeError ? "text-red-400" : "text-content/60"}`}
      >
        {hint}
      </p>
      <button
        type="button"
        title="Refresh working copies"
        aria-label="Refresh working copies"
        disabled={!draft.projectPath || gitBusy}
        onClick={() => void refreshWorktrees()}
        className="grid size-5 shrink-0 place-items-center rounded text-content/60 hover:bg-content/8 hover:text-content disabled:opacity-40"
      >
        <RefreshCw
          className={`size-3 ${draft.projectPath && !worktrees && !worktreeError ? "animate-spin" : ""}`}
          strokeWidth={1.75}
        />
      </button>
    </div>
  );
  return (
    <div className="min-w-0 rounded-lg border border-content/10 p-3">
      <div className="mb-2.5 flex min-w-0 items-center gap-2">
        <GitBranch className="size-4 shrink-0 text-content/60" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium text-content">
            {projectName(draft.projectPath)}
          </p>
          <p
            className="truncate text-[10px] text-content/60"
            title={draft.projectPath}
          >
            {prettyCwd(draft.projectPath)}
          </p>
        </div>
        {tail}
      </div>
      <div className="flex flex-col gap-1.5">
        {worktreeSelect}
        {!draft.worktreePath && field("Branch", branchSelect)}
        {!draft.worktreePath &&
          !draft.noWorktree &&
          field("Origin branch", baseSelect)}
      </div>
      {footer}
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
  const { projects: savedProjects, selected: selectedProject } =
    useSavedProjects(initialProject);
  const [projectId, setProjectId] = useState(selectedProject?.id ?? "");
  const savedProject = savedProjects.find(
    (project) => project.id === projectId,
  );
  const [manageProject, setManageProject] = useState(false);
  const formId = useId();
  const [title, setTitle] = useState(initialTitle ?? "");
  const [selected, setSelected] = useState<Map<string, LinkedWorkItem>>(
    new Map(initialLinks.map((link) => [linkedWorkItemInboxKey(link), link])),
  );
  const [streams, setStreams] = useState<DraftWorkstream[]>(
    !fixedWorkstream && selectedProject
      ? selectedProject.members.map((projectPath, key) => ({
          key,
          projectPath,
          worktreePath: projectPath,
          branch: "",
          base: "",
        }))
      : fixedWorkstream || initialProject
        ? [
            {
              key: 0,
              ...(fixedWorkstream ?? {
                projectPath: initialProject ?? "",
                branch: "",
                base: "",
                worktreePath: initialProject,
              }),
            },
          ]
        : [],
  );
  // Group ids the task starts in; the list is read fresh on open and grows
  // when a new group is created inline.
  const gitBusy = useTaskGitBusy(streams.map((stream) => stream.projectPath));
  const gitOp = useTaskGitOperation(
    streams.map((stream) => stream.projectPath),
  );
  const [groups, setGroups] = useState(() => loadBoard().groups);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [newGroupName, setNewGroupName] = useState("");
  const nextKey = useRef(100);
  const titleRef = useRef<HTMLInputElement>(null);
  // The modal focuses its close button on mount — land title focus a frame
  // later so the composer starts on the field.
  useEffect(() => {
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const projects = useMemo(() => {
    const options = taskProjectOptions(recents, savedProjects);
    if (
      initialProject &&
      !options.some((option) => sameProjectPath(option.value, initialProject))
    )
      options.unshift({
        value: initialProject,
        label: projectName(initialProject),
      });
    return options;
  }, [recents, initialProject, savedProjects]);

  // Claims per stream row: board lanes own their paths+branches; sibling rows
  // claim each picked worktree and the branch it synced. Keyed by row key so
  // the sets stay stable across unrelated re-renders.
  const claims = useMemo(() => {
    const map = new Map<
      number,
      { paths: Set<string>; branches: Set<string> }
    >();
    for (const stream of streams) {
      const paths = new Set<string>();
      const branches = new Set<string>();
      for (const ws of lanes) {
        if (!sameProjectPath(ws.projectPath, stream.projectPath)) continue;
        branches.add(ws.branch);
        if (ws.worktreePath) paths.add(pathKey(ws.worktreePath));
      }
      for (const other of streams) {
        if (
          other === stream ||
          !sameProjectPath(other.projectPath, stream.projectPath)
        )
          continue;
        // "" is the auto-name sentinel, never a real claim.
        if (other.branch) branches.add(other.branch);
        if (other.worktreePath) paths.add(pathKey(other.worktreePath));
      }
      map.set(stream.key, { paths, branches });
    }
    return map;
  }, [lanes, streams]);

  const hasClaim = streams.some((stream) => {
    const claim = claims.get(stream.key);
    return (
      !!claim &&
      ((!!stream.branch && claim.branches.has(stream.branch)) ||
        (!!stream.worktreePath &&
          claim.paths.has(pathKey(stream.worktreePath))))
    );
  });

  const toggleTicket = (linked: LinkedWorkItem) => {
    const key = linkedWorkItemInboxKey(linked);
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, linked);
      return next;
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      busy ||
      gitBusy ||
      !title.trim() ||
      hasClaim ||
      streams.some((stream) => stream.worktreePath && !stream.branch)
    )
      return;
    const links = [...selected.values()];
    const fallback = suggestedBranch(title, links);
    onSubmit({
      projectId: savedProject?.id,
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
            : resolveLaneBranch(stream.branch) || fallback,
          base: stream.base.trim() || "HEAD",
          ...(stream.remote ? { remote: stream.remote } : {}),
          ...(stream.worktreePath ? { worktreePath: stream.worktreePath } : {}),
          ...(stream.noWorktree ? { noWorktree: true } : {}),
        })),
      groupIds: [...selectedGroups],
    });
  };

  const applyMembers = (members: string[]) =>
    setStreams((current) =>
      members.map(
        (projectPath) =>
          current.find((row) =>
            sameProjectPath(row.projectPath, projectPath),
          ) ?? {
            key: nextKey.current++,
            projectPath,
            worktreePath: projectPath,
            branch: "",
            base: "",
          },
      ),
    );
  return (
    <>
      <Modal
        title="New task"
        description={
          fixedWorkstream
            ? "Keep this conversation and its working copy together."
            : "Create one conversation across your working copies."
        }
        fitViewport
        footer={
          <div className="flex items-center justify-end gap-2 p-3">
            {gitOp ? (
              <p
                role="status"
                className="mr-auto min-w-0 truncate text-[11px] text-content/45"
              >
                Git is busy — {gitOp}
              </p>
            ) : null}
            <button
              type="button"
              onClick={onCancel}
              disabled={busy || gitBusy}
              className="rounded-md px-3 py-1.5 text-[12px] text-content/70 outline-none hover:bg-content/8 focus-visible:ring-2 focus-visible:ring-accent/60 active:scale-[0.97] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form={formId}
              disabled={
                busy ||
                gitBusy ||
                !title.trim() ||
                hasClaim ||
                streams.some((stream) => stream.worktreePath && !stream.branch)
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base outline-none transition-transform focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.97] disabled:opacity-40"
            >
              {busy ? (
                <LoaderCircle
                  className="size-3.5 animate-spin"
                  strokeWidth={2}
                />
              ) : null}
              {!fixedWorkstream &&
              streams.some((stream) => stream.projectPath && !stream.noWorktree)
                ? "Create & open agent"
                : "Create task"}
            </button>
          </div>
        }
        size="md"
        onClose={() => {
          if (!busy) onCancel();
        }}
      >
        <form
          id={formId}
          onSubmit={submit}
          className="flex flex-col gap-4 px-4 pb-4 pt-1"
        >
          <fieldset
            disabled={busy || gitBusy}
            className="flex min-w-0 flex-col gap-4"
          >
            <label className="flex flex-col gap-1.5 text-[12px] text-content/70">
              Title
              <input
                ref={titleRef}
                value={title}
                required
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Auth token refresh across services"
                className="h-9 rounded-md border border-content/10 bg-background-base px-2.5 text-[13px] text-content outline-none placeholder:text-content/60 focus:border-content/25"
              />
            </label>

            {!fixedWorkstream && (
              <section className="space-y-2">
                <SearchableSelect
                  label="Project"
                  value={projectId}
                  options={[
                    { value: "", label: "Custom repositories" },
                    ...savedProjects.map((project) => ({
                      value: project.id,
                      label: project.name,
                    })),
                  ]}
                  onChange={(id) => {
                    setProjectId(id);
                    const project = savedProjects.find((p) => p.id === id);
                    if (project) applyMembers(project.members);
                  }}
                  layer={LAYER.dialogPopover}
                  placeholder="Choose a project…"
                  disabled={busy}
                />
                {savedProject && (
                  <div className="flex items-center justify-between gap-2">
                    {!!savedProject.presets.length && (
                      <div className="min-w-0 flex-1">
                        <SearchableSelect
                          label="Repository preset"
                          value={
                            [savedProject, ...savedProject.presets].find(
                              (preset) =>
                                preset.members.length === streams.length &&
                                preset.members.every((path) =>
                                  streams.some((row) =>
                                    sameProjectPath(row.projectPath, path),
                                  ),
                                ),
                            )?.id ?? "custom"
                          }
                          options={[
                            {
                              value: savedProject.id,
                              label: "All repositories",
                            },
                            ...savedProject.presets.map((preset) => ({
                              value: preset.id,
                              label: preset.name,
                            })),
                            {
                              value: "custom",
                              label: "Custom selection",
                              disabled: true,
                            },
                          ]}
                          onChange={(id) => {
                            const preset = [
                              savedProject,
                              ...savedProject.presets,
                            ].find((entry) => entry.id === id);
                            if (preset) applyMembers(preset.members);
                          }}
                          layer={LAYER.dialogPopover}
                          variant="pill"
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      className="ml-auto rounded px-2 py-1 text-[11px] text-content/60 hover:bg-content/8 focus-visible:outline-accent"
                      onClick={() => setManageProject(true)}
                    >
                      Manage project & presets
                    </button>
                  </div>
                )}
              </section>
            )}
            {fixedWorkstream ? (
              <p className="break-words text-[12px] text-content/65">
                Current working copy:{" "}
                {prettyCwd(
                  fixedWorkstream.worktreePath ?? fixedWorkstream.projectPath,
                )}
                {" · "}
                {fixedWorkstream.branch}. This conversation will be linked to
                the task. Add more repositories from task details.
              </p>
            ) : (
              <section className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[12px] font-medium text-content/75">
                    Repositories
                  </h3>
                </div>
                <div className="flex min-w-0 flex-col gap-2">
                  {streams.map((stream) => {
                    const claim = claims.get(stream.key)!;
                    return (
                      <WorkstreamFields
                        key={stream.key}
                        draft={stream}
                        defaultBranch={suggestedBranch(title, [
                          ...selected.values(),
                        ])}
                        layer={LAYER.dialogPopover}
                        excludeWorktreePaths={claim.paths}
                        excludeBranches={claim.branches}
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
                                current.filter(
                                  (entry) => entry.key !== stream.key,
                                ),
                              )
                            }
                            className="grid size-7 shrink-0 place-items-center rounded-md text-content/60 outline-none hover:bg-content/8 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
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
                      busy || streams.length >= MAX_WORKSTREAMS
                    }
                    onChange={(projectPath) => {
                      if (projectPath)
                        setStreams((current) => [
                          ...current,
                          {
                            key: nextKey.current++,
                            projectPath,
                            worktreePath: projectPath,
                            branch: "",
                            base: "",
                          },
                        ]);
                    }}
                  />
                </div>
                {hasClaim && (
                  <p
                    role="alert"
                    className="mt-2 text-[11px] text-amber-700 dark:text-amber-300"
                  >
                    A selected checkout or branch already belongs to another
                    task. Choose another worktree or create a new one.
                  </p>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-content/60">
                  {streams.length
                    ? "One agent session across these working copies. Nothing runs until you send a message."
                    : "Add a repository to start an agent, or create the task and set it up later."}
                </p>
              </section>
            )}

            <TaskTicketPicker
              items={items}
              links={[...selected.values()]}
              onToggle={toggleTicket}
            />

            <section>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-content/60">
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
                        <Check
                          className="size-2.5 shrink-0"
                          strokeWidth={2.5}
                        />
                      ) : null}
                    </button>
                  );
                })}
                <label className="inline-flex h-5 items-center gap-1 rounded border border-dashed border-content/20 px-1.5 text-content/60 focus-within:border-content/40 focus-within:text-content/60">
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
                        setSelectedGroups((current) =>
                          new Set(current).add(id),
                        );
                        setNewGroupName("");
                      }
                    }}
                    placeholder="New group…"
                    aria-label="New group name"
                    className="w-20 bg-transparent text-[11px] outline-none placeholder:text-content/60"
                  />
                </label>
              </div>
            </section>

            {error ? (
              <p role="alert" className="text-[12px] text-red-300">
                {error}
              </p>
            ) : null}
          </fieldset>
        </form>
      </Modal>
      {manageProject && savedProject && (
        <SavedProjectDialog
          project={savedProject}
          recents={recents}
          onClose={() => setManageProject(false)}
        />
      )}
    </>
  );
}
