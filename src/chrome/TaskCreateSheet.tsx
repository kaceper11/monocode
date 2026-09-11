import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  getVerifiedFamilies,
  subscribeRepositoryFamilies,
  type RepositoryFamily,
  type WorkingCopy,
} from "../lib/repositoryFamilies";
import { probeRepositoryFamily } from "../hooks/useRepositoryFamilies";
import {
  familyForRepository,
  loadProjects,
  projectsSnapshot,
  repositoryDisplayName,
  subscribeProjects,
  type ProjectRepository,
} from "../lib/projects";
import {
  createTask,
  loadTaskWorkspaces,
  reviseTask,
  suggestTaskBranch,
  taskChildrenForWorkingCopy,
  taskHostConflict,
  taskWorkspacesSnapshot,
  subscribeTaskWorkspaces,
  type TaskChild,
  type TaskChildDraft,
  type TaskWorkspace,
} from "../lib/taskWorkspaces";
import { basename } from "../lib/fs";
import {
  listInboxItems,
  type InboxItem,
} from "../lib/githubTasks";
import { linkedWorkItemFromInboxItem } from "../lib/sessionWorkItem";
import type { LinkedWorkItem } from "../lib/session";
import { pathKey, prettyCwd, wslLocation, wslPath } from "../lib/paths";
import { ContextCheckbox } from "./InboxContextPicker";
import { Modal } from "./Modal";
import { Popover } from "./Popover";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Folder,
  GitBranch,
  Loader,
  Search,
} from "./icons";

type Ref = { name: string; commit: string };

type ChildDraftState = {
  mode: "worktree" | "existing" | "later";
  baseRef?: string;
  baseCommit?: string;
  branch?: string;
  /** True while the branch is the auto suggestion — re-suggested on rename. */
  branchAuto?: boolean;
  /** Display path — the Linux path for WSL repositories. */
  path?: string;
  /** True while the location follows the branch-derived default. */
  pathAuto?: boolean;
  existingPath?: string;
  responsibility?: string;
  sharedAccepted?: boolean;
};

type Props = {
  /** Resolved stored project — the sheet only opens with a real project id. */
  projectId: string;
  /** Present → edit mode: rename, retune children, add/remove repositories. */
  editingTaskId?: string;
  /** An inbox item the new task starts linked to. */
  initialTickets?: LinkedWorkItem[];
  initialName?: string;
  /** Prepared change context summarized for the shared brief. */
  initialBrief?: string;
  /** Preselected children — e.g. the worktree holding selected changes,
   * added in "existing" mode so the task points at it unchanged. */
  initialChildren?: TaskChildDraft[];
  onClose: () => void;
  onCreated?: (taskId: string) => void;
  /** Fires after an edit persists — lets callers sync open task sessions. */
  onEdited?: (task: TaskWorkspace) => void;
};

const inputClass =
  "w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none ring-accent/40 focus:ring-1";

const MODES: { value: ChildDraftState["mode"]; label: string }[] = [
  { value: "worktree", label: "New worktree" },
  { value: "existing", label: "Existing" },
];

const shortRef = (name: string) =>
  name.replace(/^refs\/(heads|remotes)\//, "");

/**
 * Guided task creation: name → repository checklist (saved sets preselect) →
 * per-child working-copy choice → shared brief + responsibilities → review →
 * independent per-child launch. Repository identity is always the stored
 * `ProjectRepository.id`; nothing routes by name.
 */
export function TaskCreateSheet({
  projectId,
  editingTaskId,
  initialTickets,
  initialName,
  initialBrief,
  initialChildren,
  onClose,
  onCreated,
  onEdited,
}: Props) {
  const projectsRaw = useSyncExternalStore(subscribeProjects, projectsSnapshot);
  const projects = useMemo(() => loadProjects(), [projectsRaw]);
  const families = useSyncExternalStore(
    subscribeRepositoryFamilies,
    getVerifiedFamilies,
  );
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const project = projects.find((entry) => entry.id === projectId);

  const editingTask: TaskWorkspace | undefined = useMemo(
    () =>
      editingTaskId
        ? loadTaskWorkspaces().find((entry) => entry.id === editingTaskId)
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editingTaskId, tasksRaw],
  );

  const [name, setName] = useState(editingTask?.name ?? initialName ?? "");
  const [brief, setBrief] = useState(editingTask?.brief ?? initialBrief ?? "");
  const [selected, setSelected] = useState<string[]>(
    () =>
      editingTask?.children.map((child) => child.repositoryId) ??
      initialChildren?.map((child) => child.repositoryId) ??
      [],
  );
  const [tickets, setTickets] = useState<LinkedWorkItem[]>(() => {
    const first = editingTask?.ticket;
    if (first) return [first, ...(first.additionalItems ?? [])];
    return initialTickets?.length ? [...initialTickets] : [];
  });
  /** Editable responsibilities for children that already exist — keyed by
   * child id, since existing children are not drafts. */
  const [childResp, setChildResp] = useState<Map<string, string>>(
    () =>
      new Map(
        (editingTask?.children ?? [])
          .filter((child) => child.responsibility)
          .map((child) => [child.id, child.responsibility ?? ""]),
      ),
  );
  const [drafts, setDrafts] = useState<Map<string, ChildDraftState>>(
    () =>
      new Map(
        (initialChildren ?? []).map((child) => [
          child.repositoryId,
          {
            mode:
              child.mode === "worktree"
                ? "worktree"
                : child.mode === "later"
                  ? "later"
                  : "existing",
            ...(child.workingCopy ? { existingPath: child.workingCopy } : {}),
          } satisfies ChildDraftState,
        ]),
      ),
  );
  const [error, setError] = useState("");
  const refsCache = useRef(new Map<string, Ref[]>());
  const [refsLoading, setRefsLoading] = useState<Set<string>>(new Set());
  const [refsTick, bumpRefs] = useState(0);

  const repositories = useMemo(
    () => project?.repositories ?? [],
    [project],
  );

  const existingByRepo = useMemo(() => {
    const map = new Map<string, TaskChild>();
    for (const child of editingTask?.children ?? [])
      map.set(child.repositoryId, child);
    return map;
  }, [editingTask]);

  // Probe member anchors once so worktree choices and concurrent-writer
  // evidence are available for the checklist.
  useEffect(() => {
    for (const repo of repositories)
      if (!familyForRepository(repo, families))
        void probeRepositoryFamily(repo.anchor);
  }, [repositories, families]);

  const loadRefs = useCallback((repo: ProjectRepository) => {
    if (refsCache.current.has(repo.id)) return;
    setRefsLoading((prev) => {
      if (prev.has(repo.id)) return prev;
      return new Set(prev).add(repo.id);
    });
    void invoke<Ref[]>("git_worktree_refs", { cwd: repo.anchor })
      .then((refs) => refsCache.current.set(repo.id, refs))
      .catch(() => refsCache.current.set(repo.id, []))
      .finally(() => {
        setRefsLoading((prev) => {
          const next = new Set(prev);
          next.delete(repo.id);
          return next;
        });
        bumpRefs((n) => n + 1);
      });
  }, []);

  const defaultBase = useCallback(
    (
      family: RepositoryFamily | undefined,
      refs: readonly Ref[],
    ): Ref | undefined => {
      const remotes = refs.filter((ref) =>
        /^refs\/remotes\/[^/]+\/HEAD$/.test(ref.name),
      );
      if (remotes.length === 1) return remotes[0];
      const mainBranch = family?.worktrees.find(
        (entry) => entry.main,
      )?.branch;
      if (mainBranch) {
        const local = refs.find(
          (ref) => ref.name === `refs/heads/${mainBranch}`,
        );
        if (local) return local;
        return refs.find((ref) => ref.name.endsWith(`/${mainBranch}`));
      }
      return undefined;
    },
    [],
  );

  const mainCheckout = useCallback(
    (repo: ProjectRepository, family?: RepositoryFamily): string =>
      family?.worktrees.find((entry) => entry.main)?.path ??
      family?.checkout ??
      repo.anchor,
    [],
  );

  /** Draft for a freshly selected repository — new worktree is the default so
   * tasks stay isolated from shared working copies. */
  const defaultDraft = useCallback(
    (repo: ProjectRepository): ChildDraftState => {
      const family = familyForRepository(repo, families);
      const refs = refsCache.current.get(repo.id) ?? [];
      const base = defaultBase(family, refs);
      const branch = suggestTaskBranch(name || "task", refs);
      const location = wslLocation(mainCheckout(repo, family));
      return {
        mode: "worktree",
        ...(base ? { baseRef: base.name, baseCommit: base.commit } : {}),
        branch,
        branchAuto: true,
        path: `${location?.path ?? mainCheckout(repo, family)}-${branch.replace(/\//g, "-")}`,
        pathAuto: true,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [families, name, defaultBase, mainCheckout, refsTick],
  );

  // Refs arrive asynchronously — fill the base for worktree drafts that were
  // created before the fetch landed.
  useEffect(() => {
    setDrafts((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const repo of repositories) {
        const draft = next.get(repo.id);
        if (!draft || draft.mode !== "worktree" || draft.baseRef) continue;
        const refs = refsCache.current.get(repo.id);
        if (!refs) continue;
        const base = defaultBase(familyForRepository(repo, families), refs);
        if (!base) continue;
        changed = true;
        next.set(repo.id, {
          ...draft,
          baseRef: base.name,
          baseCommit: base.commit,
        });
      }
      return changed ? next : prev;
    });
  }, [repositories, families, refsTick, defaultBase]);

  // Keep branch/location suggestions in step with the task name for drafts
  // the user has not hand-edited.
  useEffect(() => {
    setDrafts((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const repo of repositories) {
        const draft = next.get(repo.id);
        if (!draft || draft.mode !== "worktree" || !draft.branchAuto)
          continue;
        const refs = refsCache.current.get(repo.id) ?? [];
        const branch = suggestTaskBranch(name || "task", refs);
        if (branch === draft.branch) continue;
        const family = familyForRepository(repo, families);
        const location = wslLocation(mainCheckout(repo, family));
        changed = true;
        next.set(repo.id, {
          ...draft,
          branch,
          ...(draft.pathAuto
            ? {
                path: `${location?.path ?? mainCheckout(repo, family)}-${branch.replace(/\//g, "-")}`,
              }
            : {}),
        });
      }
      return changed ? next : prev;
    });
  }, [name, repositories, families, refsTick, mainCheckout]);

  const selectRepository = (repo: ProjectRepository, on: boolean) => {
    setError("");
    if (on) {
      setSelected((prev) =>
        prev.includes(repo.id) ? prev : [...prev, repo.id],
      );
      if (!existingByRepo.has(repo.id)) {
        setDrafts((prev) => {
          if (prev.has(repo.id)) return prev;
          const next = new Map(prev);
          next.set(repo.id, defaultDraft(repo));
          return next;
        });
        loadRefs(repo);
      }
      return;
    }
    setSelected((prev) => prev.filter((id) => id !== repo.id));
    setDrafts((prev) => {
      const next = new Map(prev);
      next.delete(repo.id);
      return next;
    });
  };

  const applySet = (setId: string) => {
    const set = project?.sets.find((entry) => entry.id === setId);
    if (!set) return;
    setError("");
    const ids = set.repositoryIds.filter((id) =>
      repositories.some((repo) => repo.id === id),
    );
    setSelected(ids);
    setDrafts((prev) => {
      const next = new Map<string, ChildDraftState>();
      for (const id of ids) {
        if (existingByRepo.has(id)) continue;
        const repo = repositories.find((entry) => entry.id === id);
        if (!repo) continue;
        next.set(id, prev.get(id) ?? defaultDraft(repo));
      }
      return next;
    });
    for (const id of ids) {
      const repo = repositories.find((entry) => entry.id === id);
      if (repo) loadRefs(repo);
    }
  };

  const selectAll = (on: boolean) => {
    setError("");
    if (on) {
      setSelected(repositories.map((repo) => repo.id));
      setDrafts((prev) => {
        const next = new Map(prev);
        for (const repo of repositories)
          if (!existingByRepo.has(repo.id) && !next.has(repo.id))
            next.set(repo.id, defaultDraft(repo));
        return next;
      });
      for (const repo of repositories)
        if (!existingByRepo.has(repo.id)) loadRefs(repo);
      return;
    }
    setSelected([]);
    setDrafts(new Map());
  };

  const updateDraft = (repoId: string, patch: Partial<ChildDraftState>) =>
    setDrafts((prev) => {
      const next = new Map(prev);
      const draft = next.get(repoId);
      if (draft) next.set(repoId, { ...draft, ...patch });
      return next;
    });

  /** Host-qualified working copy for a draft (WSL paths stay qualified). */
  const chosenPath = (
    repo: ProjectRepository,
    draft: ChildDraftState,
  ): string | undefined => {
    const family = familyForRepository(repo, families);
    if (draft.mode === "later") return undefined;
    if (draft.mode === "worktree") {
      if (!draft.path) return undefined;
      const location = wslLocation(mainCheckout(repo, family));
      return location ? wslPath(location.distribution, draft.path) : draft.path;
    }
    return draft.existingPath;
  };

  /** Concurrent-writer evidence for a chosen copy: sessions bound to it
   * (family users) or children of other active tasks. */
  const sharedWriters = (
    repo: ProjectRepository,
    draft: ChildDraftState,
  ): string[] => {
    const path = chosenPath(repo, draft);
    if (!path || draft.mode === "worktree") return [];
    const users = new Set<string>();
    const family = familyForRepository(repo, families);
    const copy = family?.worktrees.find(
      (entry) => pathKey(entry.path) === pathKey(path),
    );
    for (const user of copy?.users ?? []) users.add(user);
    for (const claim of taskChildrenForWorkingCopy(path))
      users.add(`task "${claim.task.name}"`);
    return [...users];
  };

  const hostConflict = taskHostConflict([
    ...(editingTask?.children ?? [])
      .filter((child) => selected.includes(child.repositoryId))
      .map((child) => child.workingCopy),
    ...repositories
      .filter((repo) => selected.includes(repo.id))
      .map((repo) => {
        const draft = drafts.get(repo.id);
        return draft ? chosenPath(repo, draft) : undefined;
      }),
  ]);

  const blockedShared = repositories.filter((repo) => {
    const draft = drafts.get(repo.id);
    if (!draft || !selected.includes(repo.id)) return false;
    return sharedWriters(repo, draft).length > 0 && !draft.sharedAccepted;
  });

  const canSubmit =
    Boolean(name.trim()) &&
    selected.length > 0 &&
    !hostConflict &&
    blockedShared.length === 0;

  const buildDrafts = (): TaskChildDraft[] =>
    selected
      .map((repoId): TaskChildDraft | null => {
        if (existingByRepo.has(repoId)) return null;
        const repo = repositories.find((entry) => entry.id === repoId);
        const draft = drafts.get(repoId);
        if (!repo || !draft) return null;
        const path = chosenPath(repo, draft);
        return {
          repositoryId: repo.id,
          mode: draft.mode,
          ...(draft.mode === "worktree"
            ? {
                baseRef: draft.baseRef,
                baseCommit: draft.baseCommit,
                branch: draft.branch,
                path,
              }
            : {}),
          ...(draft.mode !== "worktree" && path ? { workingCopy: path } : {}),
          ...(draft.responsibility?.trim()
            ? { responsibility: draft.responsibility }
            : {}),
        } satisfies TaskChildDraft;
      })
      .filter((entry): entry is TaskChildDraft => entry !== null);

  const submit = () => {
    setError("");
    const linked: LinkedWorkItem | undefined = tickets.length
      ? {
          ...tickets[0],
          ...(tickets.length > 1
            ? { additionalItems: tickets.slice(1) }
            : {}),
        }
      : undefined;
    try {
      if (editingTask) {
        // One atomic write: a failed add doesn't leave the rename or the
        // child removals half-saved.
        const next = reviseTask(editingTask.id, {
          name,
          ticket: linked,
          brief: brief.trim() || undefined,
          keepRepositoryIds: selected,
          responsibilities: childResp,
          additions: buildDrafts(),
        });
        onEdited?.(next);
        onClose();
        return;
      }
      const task = createTask({
        projectId,
        name,
        ...(linked ? { ticket: linked } : {}),
        brief,
        children: buildDrafts(),
      });
      // Prepared only — sessions start when the task is opened.
      onCreated?.(task.id);
      onClose();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={editingTask ? `Edit · ${editingTask.name}` : "New task"}
      description={
        project
          ? (project.name ??
            (project.anchor ? basename(project.anchor) : "Project"))
          : "Project"
      }
      size="lg"
    >
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto overscroll-none px-4 pb-4 pt-1">
        <>
            <div>
              <p className="mb-1 text-[11px] text-content/50">Task name</p>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Checkout redesign"
                aria-label="Task name"
                className={inputClass}
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-[11px] text-content/50">Repositories</p>
                {repositories.length > 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      selectAll(selected.length !== repositories.length)
                    }
                    className="text-[11px] text-content/45 hover:text-content/80"
                  >
                    {selected.length === repositories.length
                      ? "Deselect all"
                      : "Select all"}
                  </button>
                ) : null}
              </div>
              {project?.sets.length ? (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {project.sets.map((set) => (
                    <button
                      key={set.id}
                      type="button"
                      onClick={() => applySet(set.id)}
                      className="rounded-full border border-content/10 bg-content/5 px-2 py-0.5 text-[11px] text-content/65 hover:bg-content/10 hover:text-content"
                    >
                      {set.name} · {set.repositoryIds.length}
                    </button>
                  ))}
                </div>
              ) : null}
              {repositories.length === 0 ? (
                <p className="rounded-lg border border-content/10 px-2.5 py-2 text-[12px] text-content/45">
                  This project has no repositories yet. Add them from the
                  project menu → Project repositories…
                </p>
              ) : (
                <ul className="flex flex-col gap-px">
                  {repositories.map((repo) => {
                    const checked = selected.includes(repo.id);
                    const wsl = wslLocation(repo.anchor);
                    return (
                      <li key={repo.id}>
                        <button
                          type="button"
                          onClick={() => selectRepository(repo, !checked)}
                          className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-content/5"
                        >
                          <ContextCheckbox
                            label={`Select ${repositoryDisplayName(repo)}`}
                            checked={checked}
                            onChange={() => selectRepository(repo, !checked)}
                          />
                          <GitBranch
                            className="size-3.5 shrink-0 text-content/40"
                            strokeWidth={1.5}
                          />
                          <span className="min-w-0 flex-1 truncate text-[13px] text-content">
                            {repositoryDisplayName(repo)}
                          </span>
                          {wsl ? (
                            <span className="shrink-0 rounded bg-content/8 px-1.5 py-0.5 text-[10px] text-content/55">
                              WSL · {wsl.distribution}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {selected.map((repoId) => {
              const repo = repositories.find((entry) => entry.id === repoId);
              if (!repo) return null;
              const existing = existingByRepo.get(repoId);
              if (existing) {
                return (
                  <ExistingChildCard
                    key={repoId}
                    repo={repo}
                    child={existing}
                    responsibility={childResp.get(existing.id) ?? ""}
                    onResponsibility={(value) =>
                      setChildResp((prev) => {
                        const next = new Map(prev);
                        next.set(existing.id, value);
                        return next;
                      })
                    }
                    onRemove={() => selectRepository(repo, false)}
                  />
                );
              }
              const draft = drafts.get(repoId);
              if (!draft) return null;
              return (
                <ChildConfig
                  key={repoId}
                  repo={repo}
                  taskName={name}
                  draft={draft}
                  family={familyForRepository(repo, families)}
                  refs={refsCache.current.get(repo.id)}
                  refsLoading={refsLoading.has(repo.id)}
                  writers={sharedWriters(repo, draft)}
                  onChange={(patch) => updateDraft(repo.id, patch)}
                  onLoadRefs={() => loadRefs(repo)}
                />
              );
            })}

            <IssuePicker
              tickets={tickets}
              repositories={repositories}
              onChange={setTickets}
            />

            <div>
              <p className="mb-1 text-[11px] text-content/50">Shared brief</p>
              <textarea
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder="What this task changes across the selected repositories…"
                aria-label="Shared task brief"
                rows={3}
                className={`${inputClass} resize-y leading-5`}
              />
            </div>

            {hostConflict ? (
              <p
                role="alert"
                className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-2 text-[12px] leading-4 text-amber-200"
              >
                {hostConflict}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-[12px] text-red-400">
                {error}
              </p>
            ) : null}

            <div className="flex justify-end gap-2 border-t border-content/10 pt-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-content/10 px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/5"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={submit}
                className="rounded-md bg-content/10 px-3 py-1.5 text-[12px] font-medium text-content hover:bg-content/15 disabled:opacity-40"
              >
                {editingTask ? "Save changes" : "Create task"}
              </button>
            </div>
          </>
      </div>
    </Modal>
  );
}

function ChildConfig({
  repo,
  taskName,
  draft,
  family,
  refs,
  refsLoading,
  writers,
  onChange,
  onLoadRefs,
}: {
  repo: ProjectRepository;
  taskName: string;
  draft: ChildDraftState;
  family: RepositoryFamily | undefined;
  refs: Ref[] | undefined;
  refsLoading: boolean;
  writers: string[];
  onChange: (patch: Partial<ChildDraftState>) => void;
  onLoadRefs: () => void;
}) {
  const location = wslLocation(repo.anchor);
  // The main checkout is one of the existing copies — no separate mode.
  const copies = (family?.worktrees ?? []).filter(
    (entry) => !entry.missing && !entry.prunable,
  );

  /** Branch + location defaults for a draft switching to worktree mode —
   * skipped once a branch exists. */
  const worktreeDefaults = (): Partial<ChildDraftState> => {
    if (draft.branch) return {};
    const branch = suggestTaskBranch(taskName || "task", refs ?? []);
    const main =
      family?.worktrees.find((entry) => entry.main)?.path ??
      family?.checkout ??
      repo.anchor;
    const loc = wslLocation(main);
    return {
      branch,
      branchAuto: true,
      path: `${loc?.path ?? main}-${branch.replace(/\//g, "-")}`,
      pathAuto: true,
    };
  };

  const pickBase = (refName: string) => {
    const ref = refs?.find((entry) => entry.name === refName);
    onChange(
      ref ? { baseRef: ref.name, baseCommit: ref.commit } : { baseRef: refName },
    );
  };

  return (
    <section className="rounded-lg border border-content/10 p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <GitBranch
          className="size-3.5 shrink-0 text-content/40"
          strokeWidth={1.5}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-content">
          {repositoryDisplayName(repo)}
        </span>
        {location ? (
          <span className="shrink-0 rounded bg-content/8 px-1.5 py-0.5 text-[10px] text-content/55">
            WSL · {location.distribution}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() =>
            onChange({
              mode: draft.mode === "later" ? "worktree" : "later",
              ...(draft.mode === "later" ? worktreeDefaults() : {}),
            })
          }
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-content/40 hover:bg-content/5 hover:text-content/70"
        >
          {draft.mode === "later" ? "Set up now" : "Skip for now"}
        </button>
      </div>

      {draft.mode !== "later" ? (
        <div
          role="radiogroup"
          aria-label={`Working copy for ${repositoryDisplayName(repo)}`}
          className="mb-2 grid grid-cols-2 gap-0.5 rounded-md border border-content/10 p-0.5 text-[11px]"
        >
          {MODES.map((option) => {
            const disabled = option.value === "existing" && !copies.length;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={draft.mode === option.value}
                disabled={disabled}
                onClick={() => {
                  onChange({
                    mode: option.value,
                    ...(option.value === "worktree"
                      ? worktreeDefaults()
                      : {}),
                  });
                  if (option.value === "worktree") onLoadRefs();
                }}
                className={`rounded-[5px] px-1 py-1 disabled:opacity-40 ${
                  draft.mode === option.value
                    ? "bg-content/10 text-content"
                    : "text-content/50 hover:text-content"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {draft.mode === "worktree" ? (
        <div className="flex flex-col gap-1.5">
          <div className="block">
            <span className="mb-0.5 block text-[11px] text-content/50">
              Base
            </span>
            <SearchablePick
              value={draft.baseRef ? shortRef(draft.baseRef) : undefined}
              placeholder={
                refsLoading ? "Loading branches…" : "Choose a base…"
              }
              searchPlaceholder="Search branches…"
              empty={
                refsLoading
                  ? "Loading branches…"
                  : refs?.length
                    ? "No matching branches"
                    : "No branches found"
              }
              icon="branch"
              options={(refs ?? []).map((ref) => ({
                key: ref.name,
                label: shortRef(ref.name),
              }))}
              onPick={pickBase}
              ariaLabel={`Base for ${repositoryDisplayName(repo)}`}
            />
          </div>
          <label className="block">
            <span className="mb-0.5 block text-[11px] text-content/50">
              Branch
            </span>
            <input
              value={draft.branch ?? ""}
              onChange={(event) =>
                onChange({
                  branch: event.target.value.trim() || undefined,
                  branchAuto: false,
                })
              }
              className={`${inputClass} py-1.5 text-[12px]`}
              aria-label={`Branch for ${repositoryDisplayName(repo)}`}
            />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[11px] text-content/50">
              Location{location ? ` (inside ${location.distribution})` : ""}
            </span>
            <input
              value={draft.path ?? ""}
              onChange={(event) =>
                onChange({
                  path: event.target.value || undefined,
                  pathAuto: false,
                })
              }
              className={`${inputClass} py-1.5 font-mono text-[12px]`}
              aria-label={`Location for ${repositoryDisplayName(repo)}`}
            />
          </label>
        </div>
      ) : null}

      {draft.mode === "existing" ? (
        <SearchablePick
          value={
            draft.existingPath
              ? (() => {
                  const picked = copies.find(
                    (entry) =>
                      pathKey(entry.path) === pathKey(draft.existingPath!),
                  );
                  return picked?.main
                    ? "Main checkout"
                    : (picked?.branch?.replace("refs/heads/", "") ??
                        basename(draft.existingPath!));
                })()
              : undefined
          }
          placeholder="Choose a working copy…"
          searchPlaceholder="Search working copies…"
          empty="No working copies on disk"
          icon="folder"
          options={copies.map((entry: WorkingCopy) => ({
            key: entry.path,
            label: entry.main
              ? "Main checkout"
              : (entry.branch?.replace("refs/heads/", "") ??
                basename(entry.path)),
            detail: prettyCwd(entry.path),
          }))}
          onPick={(path) =>
            onChange({ existingPath: path, sharedAccepted: false })
          }
          ariaLabel={`Existing worktree for ${repositoryDisplayName(repo)}`}
        />
      ) : null}

      {draft.mode === "later" ? (
        <p className="text-[11px] leading-4 text-content/45">
          Skipped for now — the repository stays in the task with no working
          copy or session yet.
        </p>
      ) : null}

      {writers.length > 0 ? (
        <label className="mt-2 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-2">
          <ContextCheckbox
            label={`Allow sharing this working copy in ${repositoryDisplayName(repo)}`}
            checked={draft.sharedAccepted ?? false}
            onChange={() =>
              onChange({ sharedAccepted: !draft.sharedAccepted })
            }
          />
          <span className="min-w-0 flex-1 text-[11px] leading-4 text-amber-200">
            Already in use by {writers.join(", ")} — agents can change the same
            files. Check to share this working copy anyway.
          </span>
        </label>
      ) : null}

      <label className="mt-2 block">
        <span className="mb-0.5 block text-[11px] text-content/50">
          Responsibility (optional)
        </span>
        <input
          value={draft.responsibility ?? ""}
          onChange={(event) =>
            onChange({ responsibility: event.target.value || undefined })
          }
          placeholder="What changes in this repository…"
          className={`${inputClass} py-1.5 text-[12px]`}
          aria-label={`Responsibility for ${repositoryDisplayName(repo)}`}
        />
      </label>
    </section>
  );
}

/** Read-only card for a child that already exists — its working copy,
 * branch and sessions are settled; only the responsibility can change, or
 * the child can be removed from the task. */
function ExistingChildCard({
  repo,
  child,
  responsibility,
  onResponsibility,
  onRemove,
}: {
  repo: ProjectRepository;
  child: TaskChild;
  responsibility: string;
  onResponsibility: (value: string) => void;
  onRemove: () => void;
}) {
  const location = wslLocation(repo.anchor);
  const state = child.launch.state;
  const summary = child.workingCopy
    ? [child.branch, prettyCwd(child.workingCopy)].filter(Boolean).join(" · ")
    : "Skipped — no working copy yet";
  return (
    <section className="rounded-lg border border-content/10 p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <GitBranch
          className="size-3.5 shrink-0 text-content/40"
          strokeWidth={1.5}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-content">
          {repositoryDisplayName(repo)}
        </span>
        {location ? (
          <span className="shrink-0 rounded bg-content/8 px-1.5 py-0.5 text-[10px] text-content/55">
            WSL · {location.distribution}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-content/40 hover:bg-content/5 hover:text-content/70"
        >
          Remove
        </button>
      </div>
      <div className="mb-2 flex items-center gap-1.5">
        {state === "ready" ? (
          <Check className="size-3 shrink-0 text-emerald-400" strokeWidth={2} />
        ) : state === "working" ? (
          <Loader className="size-3 shrink-0 animate-spin text-content/50" />
        ) : state === "failed" ? (
          <CircleAlert className="size-3 shrink-0 text-red-400" />
        ) : (
          <CircleAlert className="size-3 shrink-0 text-content/30" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-content/50">
          {summary}
        </span>
      </div>
      <label className="block">
        <span className="mb-0.5 block text-[11px] text-content/50">
          Responsibility
        </span>
        <input
          value={responsibility}
          onChange={(event) => onResponsibility(event.target.value)}
          placeholder="What this repository contributes…"
          aria-label={`Responsibility for ${repositoryDisplayName(repo)}`}
          className={`${inputClass} py-1.5 text-[12px]`}
        />
      </label>
    </section>
  );
}

/** Picked issues plus a searchable inbox picker — the selected items become
 * the task's linked ticket (first) and additionalItems (rest). */
function IssuePicker({
  tickets,
  repositories,
  onChange,
}: {
  tickets: LinkedWorkItem[];
  repositories: readonly ProjectRepository[];
  onChange: (next: LinkedWorkItem[]) => void;
}) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open || items !== null || busy) return;
    setBusy(true);
    setError("");
    void listInboxItems(
      repositories.map((repo) => ({ path: repo.anchor })),
      { assignedToMe: false, state: "open", search: "" },
    )
      .then((result) =>
        setItems(
          result.items.filter((item) => item.kind === "issue"),
        ),
      )
      .catch((reason) => setError(String(reason)))
      .finally(() => setBusy(false));
  }, [open, items, busy, repositories]);

  const picked = new Set(tickets.map((ticket) => ticket.url));
  const query = search.trim().toLowerCase();
  const shown = (items ?? [])
    .filter(
      (item) =>
        !query ||
        [item.identifier, item.title, item.repo].some((field) =>
          field?.toLowerCase().includes(query),
        ),
    )
    .slice(0, 80);

  const toggle = (item: InboxItem) => {
    const linked = linkedWorkItemFromInboxItem(item);
    if (!linked) return;
    onChange(
      picked.has(linked.url)
        ? tickets.filter((ticket) => ticket.url !== linked.url)
        : [...tickets, linked],
    );
  };

  const label = (ticket: LinkedWorkItem) =>
    ticket.identifier ?? `${ticket.repo}#${ticket.number}`;

  return (
    <div>
      <p className="mb-1 text-[11px] text-content/50">Issues</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {tickets.map((ticket) => (
          <span
            key={ticket.url}
            className="inline-flex items-center gap-1 rounded-full border border-content/10 bg-content/5 py-0.5 pl-2 pr-1 text-[11px] text-content/80"
          >
            <span className="min-w-0 max-w-56 truncate">
              {label(ticket)}
              {ticket.title ? ` — ${ticket.title}` : ""}
            </span>
            <button
              type="button"
              aria-label={`Remove ${label(ticket)}`}
              className="grid size-4 place-items-center rounded-full text-content/40 hover:bg-content/10 hover:text-content"
              onClick={() =>
                onChange(
                  tickets.filter((entry) => entry.url !== ticket.url),
                )
              }
            >
              ×
            </button>
          </span>
        ))}
        <button
          ref={anchor}
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-full border border-dashed border-content/15 px-2 py-0.5 text-[11px] text-content/50 hover:bg-content/5 hover:text-content"
        >
          {tickets.length ? "Add more…" : "Add issues…"}
        </button>
      </div>
      {open ? (
        <Popover
          anchor={anchor}
          onDismiss={() => setOpen(false)}
          role="dialog"
          aria-label="Select issues"
          className="flex w-[21rem] flex-col overflow-hidden"
        >
          <div className="flex items-center gap-1.5 border-b border-content/8 px-2 py-1.5">
            <Search
              className="size-3.5 shrink-0 text-content/40"
              strokeWidth={1.75}
            />
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search open issues…"
              aria-label="Search open issues"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
            />
          </div>
          <div className="max-h-64 overflow-y-auto px-1.5 py-1.5">
            {busy ? (
              <p className="px-2 py-2 text-[11px] text-content/45">
                Loading issues…
              </p>
            ) : error ? (
              <p className="px-2 py-2 text-[11px] text-red-400">{error}</p>
            ) : shown.length ? (
              shown.map((item) => (
                <button
                  key={item.url || `${item.provider}:${item.id}`}
                  type="button"
                  onClick={() => toggle(item)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-content/5"
                >
                  <ContextCheckbox
                    label={item.title}
                    checked={picked.has(item.url)}
                    onChange={() => toggle(item)}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-content">
                    {item.identifier ?? `#${item.number}`} {item.title}
                  </span>
                  <span className="shrink-0 truncate text-[10px] text-content/40">
                    {item.repo || item.provider}
                  </span>
                </button>
              ))
            ) : (
              <p className="px-2 py-2 text-[11px] text-content/45">
                No open issues found
              </p>
            )}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

type PickOption = { key: string; label: string; detail?: string };

/** Field-styled picker opening a searchable popover — the same pattern the
 * worktree panel uses for its base list. */
function SearchablePick({
  value,
  placeholder,
  searchPlaceholder,
  empty,
  icon,
  options,
  onPick,
  ariaLabel,
}: {
  value?: string;
  placeholder: string;
  searchPlaceholder: string;
  empty: string;
  icon: "branch" | "folder";
  options: readonly PickOption[];
  onPick: (key: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const shown = options
    .filter((option) =>
      `${option.label} ${option.detail ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, 200);
  const Icon = icon === "folder" ? Folder : GitBranch;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={ariaLabel}
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
        className="flex w-full items-center gap-2 rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-left text-[12px] outline-none ring-accent/40 focus:ring-1"
      >
        <Icon
          className="size-3.5 shrink-0 text-content/40"
          strokeWidth={1.5}
        />
        <span
          className={`min-w-0 flex-1 truncate ${
            value ? "font-mono text-content" : "text-content/45"
          }`}
        >
          {value || placeholder}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-content/40" />
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          onDismiss={() => setOpen(false)}
          width={anchor.current?.offsetWidth}
          className="overflow-hidden"
        >
          <label className="flex items-center gap-2 border-b border-content/10 px-2 py-2 text-content/50">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/40"
              aria-label={ariaLabel}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="max-h-56 overflow-y-auto overscroll-none px-1.5 py-1.5">
            {shown.map((option) => (
              <button
                type="button"
                key={option.key}
                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/5"
                onClick={() => {
                  onPick(option.key);
                  setOpen(false);
                }}
              >
                <Icon
                  className="size-3.5 shrink-0 text-content/50"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                  {option.label}
                </span>
                {option.detail ? (
                  <span className="shrink-0 truncate text-[10px] text-content/40">
                    {option.detail}
                  </span>
                ) : null}
              </button>
            ))}
            {!shown.length ? (
              <p className="px-2 py-2 text-[11px] text-content/45">{empty}</p>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </>
  );
}
