import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { basename, listDir, pickFolder } from "../lib/fs";
import { probeRepositoryFamily } from "../hooks/useRepositoryFamilies";
import {
  addRepositoryToProject,
  createProjectGroup,
  deleteRepositorySet,
  ensureProjectForPath,
  familyForRepository,
  findProjectByCommonDir,
  loadProjects,
  locateRepository,
  isProjectRailKey,
  moveRepositorySet,
  projectsSnapshot,
  removeRepositoryFromProject,
  renameProject,
  renameRepositorySet,
  repositoryDisplayName,
  saveRepositorySet,
  subscribeProjects,
  type ProjectRecord,
  type ProjectRepository,
  type SavedRepositorySet,
} from "../lib/projects";
import { IS_WIN } from "../lib/platform";
import {
  pathKey,
  prettyCwd,
  projectKey,
  wslLocation,
} from "../lib/paths";
import {
  loadTabGroupLabels,
  resolveTabGroupLabel,
  saveTabGroupLabel,
} from "../lib/tabGroups";
import type { RepositoryFamily } from "../lib/repositoryFamilies";
import { ContextCheckbox } from "./InboxContextPicker";
import { Modal } from "./Modal";
import { WslProjectDialog } from "./WslProjectDialog";
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FolderPlus,
  FolderTree,
  GitBranch,
  Pencil,
  Plus,
  Trash2,
  X,
} from "./icons";

type Props = {
  /** Rail row path — the project anchor, or the recent for an implicit
   * one-repository project. Empty when `groupImport` drives the sheet. */
  path: string;
  /** Explicit stored project when the rail row already carries one. */
  projectId?: string;
  /** Import flow: create the project group only when the user submits the
   * queue — nothing is persisted, and nothing appears in the rail, if the
   * sheet is closed first. */
  groupImport?: boolean;
  /** With `groupImport`, launch the folder picker as soon as the sheet opens. */
  autoPick?: boolean;
  families: ReadonlyMap<string, RepositoryFamily>;
  onOpenPath: (path: string) => void;
  onClose: () => void;
};

const inputClass =
  "w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none ring-accent/40 focus:ring-1";

/** A verified repository staged for addition — nothing is persisted until the
 * user submits the queue. */
type PendingRepo = {
  family: RepositoryFamily;
  /** Name of another project this repository would move from. */
  owner?: string;
};

/** Probing one directory child per request; scan in small batches so a big
 * parent folder does not burst the backend. */
const SCAN_BATCH = 8;
const SCAN_LIMIT = 200;

/** The project repositories sheet: membership and saved repository sets for
 * one project. Edits here change associations only — never checkouts,
 * worktrees, sessions or credentials. */
export function ProjectRepositories({
  path,
  projectId,
  groupImport,
  autoPick,
  families,
  onOpenPath,
  onClose,
}: Props) {
  const raw = useSyncExternalStore(subscribeProjects, projectsSnapshot);
  const projects = useMemo(() => loadProjects(), [raw]);
  /** Group created by the import flow — the sheet rebinds to it once the
   * first submit materializes it. */
  const [createdId, setCreatedId] = useState<string | undefined>();
  const [importParent, setImportParent] = useState<string | null>(null);
  const [importName, setImportName] = useState("");
  const [error, setError] = useState("");
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [pickOpen, setPickOpen] = useState(false);
  /** Repository id being relocated through the shared folder picker. */
  const locating = useRef<string | null>(null);
  const [pending, setPending] = useState<PendingRepo[]>([]);
  const [queueSetName, setQueueSetName] = useState("");
  const [scanning, setScanning] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [setName, setSetName] = useState("");
  const [setNaming, setSetNaming] = useState(false);
  const [editingSet, setEditingSet] = useState<string | null>(null);
  const [renamingSet, setRenamingSet] = useState<string | null>(null);

  const direct = projects.find(
    (project) => project.id === (projectId ?? createdId),
  );
  // The import flow creates its own group — never resolve the picked folder's
  // family or an existing project, or a repo-folder pick would hijack the
  // sheet into editing that project instead.
  const family = groupImport ? undefined : families.get(pathKey(path));
  const project =
    direct ??
    (family
      ? findProjectByCommonDir(family.commonDir, projects)?.project
      : undefined) ??
    (!groupImport
      ? projects.find(
          (entry) => entry.anchor && pathKey(entry.anchor) === pathKey(path),
        )
      : undefined);

  // An implicit one-repository project still lists its verified repository so
  // it can join saved sets and the sheet can materialize on first edit.
  const members: ProjectRepository[] = useMemo(() => {
    if (project) return project.repositories;
    return family
      ? [{ id: "", commonDir: family.commonDir, anchor: family.checkout || path }]
      : [];
  }, [project, family, path]);

  const title = useMemo(() => {
    if (project?.name) return project.name;
    // Keep the import sheet's title stable — the picked folder's name is only
    // a preview inside the name field, not a moving header.
    if (groupImport && !project) return "New project";
    if (isProjectRailKey(path)) return "Project";
    const key = projectKey(project?.anchor ?? path);
    return resolveTabGroupLabel(
      key,
      loadTabGroupLabels(),
      basename(project?.anchor ?? path) || "Project",
    );
    // Re-resolve after project edits (raw snapshot changed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, path, raw, groupImport]);

  /** The record edits write to. In import mode the group is created lazily on
   * the first write so a cancelled import leaves nothing behind. `nameHint`
   * carries the just-picked folder — its state update is not visible in the
   * same async continuation. */
  const ensureProject = (nameHint?: string): ProjectRecord => {
    if (project) return project;
    if (groupImport) {
      const folder = nameHint ?? importParent ?? "";
      const group = createProjectGroup(
        importName || (folder ? basename(folder) : undefined),
      );
      setCreatedId(group.id);
      return group;
    }
    return ensureProjectForPath(path, family);
  };

  // Probe member anchors once so missing repositories are visible; published
  // families flow back through the shared verified map.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    for (const repo of project.repositories) {
      if (familyForRepository(repo, families)) continue;
      void probeRepositoryFamily(repo.anchor).then((found) => {
        if (cancelled) return;
        if (!found)
          setMissing((prev) =>
            prev.has(repo.id) ? prev : new Set(prev).add(repo.id),
          );
        else
          setMissing((prev) => {
            if (!prev.has(repo.id)) return prev;
            const next = new Set(prev);
            next.delete(repo.id);
            return next;
          });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [project, families]);

  // Import flow: launch the folder picker as soon as the sheet opens when the
  // rail asked for it — choosing a parent and reviewing its repositories is
  // the whole interaction.
  const autoScan = useRef(false);
  useEffect(() => {
    if (!groupImport || !autoPick || autoScan.current) return;
    autoScan.current = true;
    pickAdd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupImport, autoPick]);

  const names = members.map(repositoryDisplayName);
  const ambiguous = new Set(
    names.filter((name, index) => names.indexOf(name) !== index),
  );

  /** Splits probed families into queueable items vs already-covered ones.
   * Members of this project and already-queued repositories are skipped. */
  const stageable = (found: (RepositoryFamily | null)[]) => {
    const memberKeys = new Set(members.map((repo) => pathKey(repo.commonDir)));
    const queuedKeys = new Set(
      pending.map((item) => pathKey(item.family.commonDir)),
    );
    const items: PendingRepo[] = [];
    let covered = 0;
    for (const family of found) {
      if (!family) continue;
      const key = pathKey(family.commonDir);
      if (memberKeys.has(key) || queuedKeys.has(key)) {
        covered++;
        continue;
      }
      queuedKeys.add(key);
      const owner = findProjectByCommonDir(family.commonDir, projects)?.project;
      items.push({
        family,
        owner:
          owner && owner.id !== project?.id
            ? (owner.name ??
              (owner.anchor ? basename(owner.anchor) : "another project"))
            : undefined,
      });
    }
    return { items, covered };
  };

  const stage = (result: { items: PendingRepo[]; covered: number }) => {
    if (result.items.length) setPending((prev) => [...prev, ...result.items]);
    else if (result.covered)
      setError("That repository is already in this project or queued.");
  };

  /** Writes memberships for the given families — materializing the project on
   * first use. Returns the target record plus the commonDir keys that failed
   * so a queue can keep them. */
  const commitFamilies = (found: RepositoryFamily[], nameHint?: string) => {
    const target = ensureProject(nameHint);
    const errors: string[] = [];
    const failed = new Set<string>();
    for (const family of found) {
      const anchor =
        family.checkout ||
        target.anchor ||
        family.worktrees.find((entry) => !entry.missing)?.path;
      const key = pathKey(family.commonDir);
      if (!anchor) {
        errors.push(
          `${basename(family.checkout) || family.commonDir}: no working-copy folder found.`,
        );
        failed.add(key);
        continue;
      }
      const result = addRepositoryToProject(target.id, {
        commonDir: family.commonDir,
        anchor,
      });
      if (result.error) {
        errors.push(result.error);
        failed.add(key);
      }
    }
    if (errors.length) setError(errors.join("\n"));
    return { failed, target };
  };

  /** A single explicit pick commits immediately — unless the group is still
   * being imported, where everything waits in the queue so the project only
   * exists once the user submits. */
  const addFamily = (family: RepositoryFamily, nameHint?: string) => {
    const result = stageable([family]);
    if (result.items.length) {
      if (groupImport && !project) stage(result);
      else commitFamilies([family], nameHint);
    } else if (result.covered)
      setError("That repository is already in this project or queued.");
  };

  /** One pick for both intents: a repository folder adds right away; any
   * other folder is scanned — each immediate child repository is queued for
   * review before it joins. */
  const addPicked = async (picked: string | null) => {
    if (!picked) return;
    setError("");
    // The first picked folder proposes the group name; later picks just add
    // more repositories, so the name preview never moves again.
    if (groupImport) setImportParent((prev) => prev ?? picked);
    setScanning(true);
    try {
      const own = await probeRepositoryFamily(picked);
      if (own) {
        addFamily(own, picked);
        return;
      }
      const dirs = (await listDir(picked))
        .filter(
          (entry) => entry.isDir && !entry.ignored && !entry.name.startsWith("."),
        )
        .slice(0, SCAN_LIMIT);
      const found: (RepositoryFamily | null)[] = [];
      for (let i = 0; i < dirs.length; i += SCAN_BATCH)
        found.push(
          ...(await Promise.all(
            dirs.slice(i, i + SCAN_BATCH).map((entry) =>
              probeRepositoryFamily(entry.path),
            ),
          )),
        );
      const result = stageable(found);
      stage(result);
      if (!result.items.length && !result.covered)
        setError("No Git repositories in that folder.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setScanning(false);
    }
  };

  /** Commits the queued entries — the only batched write. In import mode a
   * clean submit creates the project, optionally saves the queue as a set,
   * and closes the sheet; failures keep the sheet open with just the failed
   * rows left. */
  const submitPending = () => {
    if (!pending.length) return;
    setError("");
    const importing = groupImport && !project;
    const { failed, target } = commitFamilies(
      pending.map((item) => item.family),
    );
    setPending((prev) =>
      prev.filter((item) => failed.has(pathKey(item.family.commonDir))),
    );
    if (!importing || failed.size) return;
    const setLabel = queueSetName.trim();
    if (setLabel) {
      const committed = new Set(
        pending.map((item) => pathKey(item.family.commonDir)),
      );
      const ids = (loadProjects().find((p) => p.id === target.id)
        ?.repositories ?? [])
        .filter((repo) => committed.has(pathKey(repo.commonDir)))
        .map((repo) => repo.id);
      if (ids.length) saveRepositorySet(target.id, setLabel, ids);
    }
    onClose();
  };

  const pickAdd = () => {
    setError("");
    if (IS_WIN) {
      setPickOpen(true);
      return;
    }
    void pickFolder("Choose a repository or a folder of repositories").then(
      addPicked,
    );
  };

  const reconnect = (repo: ProjectRepository) => {
    setError("");
    void probeRepositoryFamily(repo.anchor).then((found) => {
      setMissing((prev) => {
        const next = new Set(prev);
        if (found) next.delete(repo.id);
        else next.add(repo.id);
        return next;
      });
    });
  };

  const locateInto = async (
    repo: ProjectRepository,
    picked: string | null | undefined,
  ) => {
    if (!picked || !project) return;
    setError("");
    const found = await probeRepositoryFamily(picked);
    if (!found) {
      setError("That folder is not a Git repository.");
      return;
    }
    const result = locateRepository(
      project.id,
      repo.id,
      found.checkout || picked,
      found,
    );
    if (result.error) setError(result.error);
    else
      setMissing((prev) => {
        const next = new Set(prev);
        next.delete(repo.id);
        return next;
      });
  };

  const locate = (repo: ProjectRepository) => {
    if (!project) return;
    setError("");
    if (IS_WIN) {
      locating.current = repo.id;
      setPickOpen(true);
      return;
    }
    void pickFolder("Locate repository").then((picked) =>
      locateInto(repo, picked),
    );
  };

  const commitSet = () => {
    const target = ensureProject();
    // Selection tracks repository identity by common dir, so it survives the
    // record materializing just now for an implicit project.
    const ids = target.repositories
      .filter((repo) => selection.has(pathKey(repo.commonDir)))
      .map((repo) => repo.id);
    const result = saveRepositorySet(
      target.id,
      setName,
      ids,
      editingSet ?? undefined,
    );
    if (result.error) setError(result.error);
    else {
      setError("");
      setSetName("");
      setSetNaming(false);
      setEditingSet(null);
      setSelection(new Set());
    }
  };

  /** Loads a saved set back into the checkboxes so its membership can be
   * edited and re-saved under the same name. */
  const editSet = (set: SavedRepositorySet) => {
    const memberById = new Map(
      members.map((repo) => [repo.id, repo] as const),
    );
    setSelection(
      new Set(
        set.repositoryIds.flatMap((id) => {
          const repo = memberById.get(id);
          return repo ? [pathKey(repo.commonDir)] : [];
        }),
      ),
    );
    setSetName(set.name);
    setEditingSet(set.id);
    setSetNaming(true);
  };

  const closeSetNaming = () => {
    setSetNaming(false);
    setEditingSet(null);
    setSetName("");
  };

  // Repositories MonoCode already verified that are neither members here nor
  // already queued for addition.
  const candidates = useMemo(() => {
    const unique = new Map<string, RepositoryFamily>();
    for (const family of families.values())
      unique.set(pathKey(family.commonDir), family);
    const memberKeys = new Set(members.map((repo) => pathKey(repo.commonDir)));
    const queuedKeys = new Set(
      pending.map((item) => pathKey(item.family.commonDir)),
    );
    return [...unique.values()].filter(
      (entry) =>
        !memberKeys.has(pathKey(entry.commonDir)) &&
        !queuedKeys.has(pathKey(entry.commonDir)),
    );
  }, [families, members, pending]);

  return (
    <Modal
      onClose={onClose}
      title={title}
      description={
        groupImport && !project
          ? "A new group — saved when you add repositories"
          : (project && !project.anchor) || isProjectRailKey(path)
            ? "A group of repositories — no folder of its own"
            : prettyCwd(project?.anchor ?? path)
      }
      size="md"
    >
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        <div>
          <p className="mb-1 text-[11px] text-content/50">Project name</p>
          <input
            key={project?.id ?? (groupImport ? (importParent ?? "new") : "row")}
            defaultValue={
              groupImport && !project
                ? importName || (importParent ? basename(importParent) : "")
                : title
            }
            placeholder={groupImport && !project ? "Project name" : undefined}
            aria-label="Project name"
            className={inputClass}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (!name) return;
              if (project) {
                if (name !== title) renameProject(project.id, name);
              } else if (groupImport) {
                if (name !== importName) setImportName(name);
              } else {
                if (name === title) return;
                saveTabGroupLabel(projectKey(path), name);
                if (family) ensureProjectForPath(path, family);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </div>

        <div>
          <p className="mb-1 text-[11px] text-content/50">Repositories</p>

          {members.length === 0 ? (
            <p className="rounded-lg border border-content/10 px-2.5 py-2 text-[12px] text-content/45">
              No repositories yet. Add a repository folder, or scan a parent
              folder to add several at once.
            </p>
          ) : (
            <ul className="flex flex-col gap-px">
              {members.map((repo) => {
                const key = pathKey(repo.commonDir);
                const name = repositoryDisplayName(repo);
                const wsl = wslLocation(repo.anchor);
                const isMissing = repo.id ? missing.has(repo.id) : false;
                const showPath = ambiguous.has(name) || isMissing;
                return (
                  <li
                    key={repo.id || key}
                    className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-content/5"
                  >
                    <ContextCheckbox
                      label={`Select ${name}`}
                      checked={selection.has(key)}
                      onChange={() =>
                        setSelection((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    />
                    <GitBranch
                      className="size-3.5 shrink-0 text-content/40"
                      strokeWidth={1.5}
                    />
                    <button
                      type="button"
                      title={prettyCwd(repo.anchor)}
                      onClick={() => onOpenPath(repo.anchor)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-[13px] leading-tight text-content">
                        {name}
                      </span>
                      {showPath ? (
                        <span className="block truncate text-[11px] leading-tight text-content/45">
                          {prettyCwd(repo.anchor)}
                        </span>
                      ) : null}
                    </button>
                    {wsl ? (
                      <span className="shrink-0 rounded bg-content/8 px-1.5 py-0.5 text-[10px] text-content/55">
                        WSL · {wsl.distribution}
                      </span>
                    ) : null}
                    {isMissing ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <span
                          title="Repository not found at its saved path"
                          className="flex items-center gap-1 text-[11px] text-amber-400"
                        >
                          <CircleAlert className="size-3" strokeWidth={1.75} />
                          Missing
                        </span>
                        <button
                          type="button"
                          title="Locate the moved repository"
                          onClick={() => locate(repo)}
                          className="rounded px-1.5 py-0.5 text-[11px] text-content/60 hover:bg-content/8 hover:text-content"
                        >
                          Locate
                        </button>
                        <button
                          type="button"
                          title="Probe the saved path again"
                          onClick={() => reconnect(repo)}
                          className="rounded px-1.5 py-0.5 text-[11px] text-content/60 hover:bg-content/8 hover:text-content"
                        >
                          Reconnect
                        </button>
                      </span>
                    ) : null}
                    {project && repo.id ? (
                      <button
                        type="button"
                        title="Remove from project — files, worktrees, sessions and credentials are kept"
                        aria-label={`Remove ${name} from project`}
                        onClick={() =>
                          removeRepositoryFromProject(project.id, repo.id)
                        }
                        className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/8 hover:text-red-300"
                      >
                        <Trash2 className="size-3.5" strokeWidth={1.75} />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-1.5 rounded-lg border border-content/10 p-2">
            <button
              type="button"
              disabled={scanning}
              title="Pick a repository folder to add it, or a parent folder to review its repositories"
              onClick={pickAdd}
              className="flex items-center gap-1.5 rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[12px] text-content hover:bg-content/10 disabled:opacity-50"
            >
              <FolderPlus className="size-3.5" strokeWidth={1.75} />
              {scanning ? "Scanning…" : "Add folder…"}
            </button>
            <p className="mt-1.5 text-[11px] leading-tight text-content/45">
              {groupImport && !project
                ? "Picked repositories are queued — the project is created when you submit."
                : pending.length
                  ? "Queued repositories join the project when you submit."
                  : "Pick a repository to add it now, or a parent folder to review its repositories first."}
            </p>
            {pending.length ? (
              <div className="mt-1.5 space-y-1">
                <ul className="flex max-h-40 flex-col gap-px overflow-y-auto">
                  {pending.map((item) => {
                    const key = pathKey(item.family.commonDir);
                    const label =
                      basename(item.family.checkout) || item.family.checkout;
                    return (
                      <li
                        key={key}
                        className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-content/5"
                      >
                        <GitBranch
                          className="size-3.5 shrink-0 text-content/40"
                          strokeWidth={1.5}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] leading-tight text-content">
                            {label}
                          </span>
                          <span className="block truncate text-[10px] leading-tight text-content/45">
                            {prettyCwd(item.family.checkout)}
                          </span>
                        </span>
                        {item.owner ? (
                          <span className="shrink-0 text-[10px] text-amber-400">
                            Moves from {item.owner}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`Remove ${label} from queue`}
                          onClick={() =>
                            setPending((prev) =>
                              prev.filter((entry) => entry !== item),
                            )
                          }
                          className="grid size-5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/8 hover:text-content"
                        >
                          <X className="size-3" strokeWidth={1.75} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {groupImport && !project ? (
                  <div className="flex items-center gap-2">
                    <FolderTree
                      className="size-3.5 shrink-0 text-content/40"
                      strokeWidth={1.5}
                    />
                    <span className="shrink-0 text-[11px] text-content/50">
                      Also save as a set
                    </span>
                    <input
                      value={queueSetName}
                      onChange={(event) => setQueueSetName(event.target.value)}
                      placeholder="Set name (optional)"
                      aria-label="Repository set name"
                      className={`${inputClass} min-w-0 flex-1 py-1 text-[12px]`}
                    />
                  </div>
                ) : null}
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setPending([])}
                    className="rounded-md px-2 py-1 text-[11px] text-content/60 hover:bg-content/8 hover:text-content"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={submitPending}
                    className="rounded-md bg-content px-2.5 py-1 text-[11px] font-medium text-background-base"
                  >
                    {groupImport && !project
                      ? "Add project"
                      : `Add ${pending.length} ${
                          pending.length === 1 ? "repository" : "repositories"
                        }`}
                  </button>
                </div>
              </div>
            ) : null}
            {candidates.length ? (
              <div className="mt-2">
                <p className="mb-0.5 text-[11px] text-content/45">
                  Already verified — click to add:
                </p>
                <ul className="flex max-h-40 flex-col gap-px overflow-y-auto">
                  {candidates.map((entry) => {
                    const owner = findProjectByCommonDir(
                      entry.commonDir,
                      projects,
                    )?.project;
                    const label = basename(entry.checkout) || entry.checkout;
                    return (
                      <li key={pathKey(entry.commonDir)}>
                        <button
                          type="button"
                          onClick={() => {
                            setError("");
                            addFamily(entry);
                          }}
                          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-content/5"
                        >
                          <GitBranch
                            className="size-3.5 shrink-0 text-content/40"
                            strokeWidth={1.5}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] leading-tight text-content">
                              {label}
                            </span>
                            <span className="block truncate text-[10px] leading-tight text-content/45">
                              {prettyCwd(entry.checkout)}
                            </span>
                          </span>
                          {owner ? (
                            <span className="shrink-0 text-[10px] text-content/45">
                              Moves from{" "}
                              {owner.name ??
                                (owner.anchor
                                  ? basename(owner.anchor)
                                  : "another project")}
                            </span>
                          ) : null}
                          <Plus
                            className="size-3.5 shrink-0 text-content/40"
                            strokeWidth={1.75}
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        </div>

        {members.length ? (
          <div>
            <div className="mb-1 flex items-center gap-1">
              <p className="min-w-0 flex-1 text-[11px] text-content/50">
                Saved repository sets
              </p>
              <button
                type="button"
                disabled={!selection.size}
                onClick={() => {
                  setEditingSet(null);
                  setSetName("");
                  setSetNaming(true);
                }}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-content/55 hover:bg-content/8 hover:text-content disabled:opacity-40"
              >
                <Plus className="size-3" strokeWidth={1.75} />
                Save set…
              </button>
            </div>

            {setNaming ? (
              <form
                className="mb-1.5 flex items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  commitSet();
                }}
              >
                <input
                  autoFocus
                  value={setName}
                  onChange={(event) => setSetName(event.target.value)}
                  placeholder={`Set of ${selection.size} ${selection.size === 1 ? "repository" : "repositories"}`}
                  aria-label="Set name"
                  className={inputClass}
                />
                <button
                  type="submit"
                  className="grid size-7 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content"
                  aria-label={editingSet ? "Update set" : "Save set"}
                >
                  <Check className="size-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  onClick={closeSetNaming}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/8 hover:text-content"
                  aria-label="Cancel"
                >
                  <X className="size-3.5" strokeWidth={1.75} />
                </button>
              </form>
            ) : null}

            {project?.sets.length ? (
              <ul className="flex flex-col gap-px">
                {project.sets.map((set, index) => (
                  <li
                    key={set.id}
                    className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-content/5"
                  >
                    <FolderTree
                      className="size-3.5 shrink-0 text-content/40"
                      strokeWidth={1.5}
                    />
                    {renamingSet === set.id ? (
                      <input
                        autoFocus
                        defaultValue={set.name}
                        aria-label="Rename set"
                        className={`${inputClass} py-0.5`}
                        onBlur={(event) => {
                          renameRepositorySet(
                            project.id,
                            set.id,
                            event.target.value,
                          );
                          setRenamingSet(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") setRenamingSet(null);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        title="Rename set"
                        onClick={() => setRenamingSet(set.id)}
                        className="min-w-0 flex-1 truncate text-left text-[13px] text-content"
                      >
                        {set.name}
                      </button>
                    )}
                    <span className="shrink-0 text-[11px] tabular-nums text-content/45">
                      {set.repositoryIds.length}{" "}
                      {set.repositoryIds.length === 1 ? "repo" : "repos"}
                    </span>
                    <span className="flex shrink-0 items-center">
                      <button
                        type="button"
                        aria-label={`Edit set ${set.name}`}
                        title="Edit which repositories this set uses"
                        aria-pressed={editingSet === set.id}
                        onClick={() => editSet(set)}
                        className={`grid size-5 place-items-center rounded text-content/45 hover:bg-content/8 hover:text-content ${editingSet === set.id ? "text-content" : ""}`}
                      >
                        <Pencil className="size-3" strokeWidth={1.75} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${set.name} up`}
                        disabled={index === 0}
                        onClick={() => moveRepositorySet(project.id, set.id, -1)}
                        className="grid size-5 place-items-center rounded text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-30"
                      >
                        <ChevronUp className="size-3" strokeWidth={1.75} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${set.name} down`}
                        disabled={index === project.sets.length - 1}
                        onClick={() => moveRepositorySet(project.id, set.id, 1)}
                        className="grid size-5 place-items-center rounded text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-30"
                      >
                        <ChevronDown className="size-3" strokeWidth={1.75} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete set ${set.name}`}
                        onClick={() => deleteRepositorySet(project.id, set.id)}
                        className="grid size-5 place-items-center rounded text-content/45 hover:bg-content/8 hover:text-red-300"
                      >
                        <Trash2 className="size-3" strokeWidth={1.5} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : !setNaming ? (
              <p className="text-[11px] leading-tight text-content/40">
                Select repositories above, then save them as a reusable set for
                task creation.
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-[12px] leading-tight text-red-300">
            {error}
          </p>
        ) : null}
      </div>
      {pickOpen ? (
        <WslProjectDialog
          cwd={importParent || path}
          onOpen={(picked) => {
            setPickOpen(false);
            const target = locating.current;
            locating.current = null;
            if (target && project) {
              const repo = project.repositories.find(
                (entry) => entry.id === target,
              );
              if (repo) void locateInto(repo, picked);
            } else void addPicked(picked);
          }}
          onClose={() => {
            setPickOpen(false);
            locating.current = null;
          }}
        />
      ) : null}
    </Modal>
  );
}
