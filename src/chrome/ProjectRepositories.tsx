import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { basename, pickFolder } from "../lib/fs";
import { probeRepositoryFamily } from "../hooks/useRepositoryFamilies";
import {
  addRepositoryToProject,
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
  Plus,
  Trash2,
  X,
} from "./icons";

type Props = {
  /** Rail row path — the project anchor, or the recent for an implicit
   * one-repository project. */
  path: string;
  /** Explicit stored project when the rail row already carries one. */
  projectId?: string;
  families: ReadonlyMap<string, RepositoryFamily>;
  onOpenPath: (path: string) => void;
  onClose: () => void;
};

const inputClass =
  "w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none ring-accent/40 focus:ring-1";

/** The project repositories sheet: membership and saved repository sets for
 * one project. Edits here change associations only — never checkouts,
 * worktrees, sessions or credentials. */
export function ProjectRepositories({
  path,
  projectId,
  families,
  onOpenPath,
  onClose,
}: Props) {
  const raw = useSyncExternalStore(subscribeProjects, projectsSnapshot);
  const projects = useMemo(() => loadProjects(), [raw]);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const locating = useRef<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [setName, setSetName] = useState("");
  const [setNaming, setSetNaming] = useState(false);
  const [renamingSet, setRenamingSet] = useState<string | null>(null);

  const direct = projectId
    ? projects.find((project) => project.id === projectId)
    : undefined;
  const family = families.get(pathKey(path));
  const project =
    direct ??
    (family
      ? findProjectByCommonDir(family.commonDir, projects)?.project
      : undefined) ??
    projects.find(
      (entry) => entry.anchor && pathKey(entry.anchor) === pathKey(path),
    );

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
    if (isProjectRailKey(path)) return "Project";
    const key = projectKey(project?.anchor ?? path);
    return resolveTabGroupLabel(
      key,
      loadTabGroupLabels(),
      basename(project?.anchor ?? path) || "Project",
    );
    // Re-resolve after project edits (raw snapshot changed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, path, raw]);

  const ensureProject = (): ProjectRecord =>
    project ?? ensureProjectForPath(path, family);

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

  const names = members.map(repositoryDisplayName);
  const ambiguous = new Set(
    names.filter((name, index) => names.indexOf(name) !== index),
  );

  const addFamily = (found: RepositoryFamily | null) => {
    if (!found) {
      setError("That folder is not a Git repository.");
      return;
    }
    const target = ensureProject();
    const anchor = found.checkout || target.anchor;
    if (!anchor) {
      setError("Pick a working-copy folder for this repository.");
      return;
    }
    const result = addRepositoryToProject(target.id, {
      commonDir: found.commonDir,
      anchor,
    });
    setError(result.error ?? "");
  };

  const addPath = async (picked: string | null) => {
    if (!picked) return;
    setError("");
    addFamily(await probeRepositoryFamily(picked));
  };

  const pickRepository = () => {
    setError("");
    if (IS_WIN) {
      setPickOpen(true);
      return;
    }
    void pickFolder("Choose repository").then(addPath);
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
    const result = saveRepositorySet(target.id, setName, ids);
    if (result.error) setError(result.error);
    else {
      setError("");
      setSetName("");
      setSetNaming(false);
      setSelection(new Set());
    }
  };

  // Repositories MonoCode already verified that are not members here.
  const candidates = useMemo(() => {
    const unique = new Map<string, RepositoryFamily>();
    for (const family of families.values())
      unique.set(pathKey(family.commonDir), family);
    const memberKeys = new Set(members.map((repo) => pathKey(repo.commonDir)));
    return [...unique.values()].filter(
      (entry) => !memberKeys.has(pathKey(entry.commonDir)),
    );
  }, [families, members]);

  return (
    <Modal
      onClose={onClose}
      title={title}
      description={
        isProjectRailKey(path)
          ? "A group of repositories — no folder of its own"
          : prettyCwd(project?.anchor ?? path)
      }
      size="md"
    >
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        <div>
          <p className="mb-1 text-[11px] text-content/50">Project name</p>
          <input
            defaultValue={title}
            aria-label="Project name"
            className={inputClass}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (!name || name === title) return;
              if (project) renameProject(project.id, name);
              else {
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
          <div className="mb-1 flex items-center gap-1">
            <p className="min-w-0 flex-1 text-[11px] text-content/50">
              Repositories
            </p>
            <button
              type="button"
              onClick={() => setAdding((open) => !open)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-content/55 hover:bg-content/8 hover:text-content"
            >
              <Plus className="size-3" strokeWidth={1.75} />
              Add repository
            </button>
          </div>

          {members.length === 0 ? (
            <p className="rounded-lg border border-content/10 px-2.5 py-2 text-[12px] text-content/45">
              No repositories yet. Add one explicitly — folders are never
              scanned or auto-imported.
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

          {adding ? (
            <div className="mt-1.5 rounded-lg border border-content/10 p-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={pickRepository}
                  className="flex items-center gap-1.5 rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[12px] text-content hover:bg-content/10"
                >
                  <FolderPlus className="size-3.5" strokeWidth={1.75} />
                  Choose folder…
                </button>
                <p className="min-w-0 flex-1 text-[11px] leading-tight text-content/45">
                  or pick a repository MonoCode already verified
                </p>
              </div>
              {candidates.length ? (
                <ul className="mt-1.5 flex flex-col gap-px">
                  {candidates.map((entry) => {
                    const owner = findProjectByCommonDir(
                      entry.commonDir,
                      projects,
                    )?.project;
                    return (
                      <li key={pathKey(entry.commonDir)}>
                        <button
                          type="button"
                          title={prettyCwd(entry.checkout)}
                          onClick={() => addFamily(entry)}
                          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
                        >
                          <GitBranch
                            className="size-3.5 shrink-0 text-content/40"
                            strokeWidth={1.5}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {basename(entry.checkout) || entry.checkout}
                          </span>
                          {owner ? (
                            <span className="shrink-0 text-[10px] text-content/45">
                              Moves from {owner.name ??
                                (owner.anchor
                                  ? basename(owner.anchor)
                                  : "another project")}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          ) : null}
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
                onClick={() => setSetNaming(true)}
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
                  aria-label="Save set"
                >
                  <Check className="size-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  onClick={() => setSetNaming(false)}
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
          cwd={path}
          onOpen={(picked) => {
            setPickOpen(false);
            const target = locating.current;
            locating.current = null;
            if (target && project) {
              const repo = project.repositories.find(
                (entry) => entry.id === target,
              );
              if (repo) void locateInto(repo, picked);
            } else void addPath(picked);
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
