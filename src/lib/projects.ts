import { basename } from "./fs";
import { looksLikeProject, pathKey, slash } from "./paths";
import type { RecentProject, ProjectRailSections } from "./recents";
import { getVerifiedFamilies, type RepositoryFamily } from "./repositoryFamilies";

/** One Git repository family on one execution host. The common dir is the
 * verified identity; it is host-qualified (`//wsl.localhost/<distro>/…`), so
 * native, WSL and future remote checkouts never collapse. */
export type ProjectRepository = {
  /** Stable id that survives a repository move (Locate). */
  id: string;
  /** Verified Git common dir from `git_repository_family`. */
  commonDir: string;
  /** A working-copy path used to re-probe the family. */
  anchor: string;
  /** Optional display name; defaults to the anchor folder name. */
  label?: string;
};

/** Ordered reusable subset of a project's repositories. Membership/order only —
 * never branches, worktree paths, sessions or credentials. */
export type SavedRepositorySet = {
  id: string;
  name: string;
  repositoryIds: string[];
};

/** Durable product boundary. Owns an explicit list of repositories and saved
 * sets; never merges them into one Git repository. */
export type ProjectRecord = {
  id: string;
  /** Explicit project name; falls back to the tab-group label/folder name. */
  name?: string;
  /** Stable rail key: order, pins and appearance stay keyed on this path even
   * if its repository later leaves the project. A project can also be a pure
   * group — no anchor — when its repositories share no single folder. */
  anchor?: string;
  repositories: ProjectRepository[];
  sets: SavedRepositorySet[];
  /** Last-active working copy inside the project — the open target. */
  lastPath?: string;
};

/** Synthetic rail key for a project with no folder anchor. Never a real
 * path — real recents are absolute — so ordering/pins can reuse it. */
export const projectRailKey = (id: string) => `project:${id}`;
export const isProjectRailKey = (path: string) => path.startsWith("project:");

export type RailProjectItem = RecentProject & { project?: ProjectRecord };

const KEY = "monocode.projects.v1";
const PROJECTS_CHANGED = "monocode:projects-changed";
const MAX_PROJECTS = 100;
const MAX_REPOSITORIES = 50;
const MAX_SETS = 50;

function normalizePath(path: string): string {
  return slash(path).replace(/\/+$/, "") || "/";
}

function sanitizeRepository(value: unknown): ProjectRepository | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.commonDir !== "string" ||
    !record.commonDir ||
    typeof record.anchor !== "string" ||
    !record.anchor
  )
    return null;
  return {
    id: record.id.slice(0, 128),
    commonDir: normalizePath(record.commonDir),
    anchor: normalizePath(record.anchor),
    ...(typeof record.label === "string" && record.label
      ? { label: record.label.slice(0, 200) }
      : {}),
  };
}

function sanitizeSet(value: unknown): SavedRepositorySet | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.name !== "string" ||
    !record.name ||
    !Array.isArray(record.repositoryIds)
  )
    return null;
  const repositoryIds = record.repositoryIds.filter(
    (id): id is string => typeof id === "string" && !!id,
  );
  return { id: record.id.slice(0, 128), name: record.name.slice(0, 200), repositoryIds };
}

function sanitizeProject(value: unknown): ProjectRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    !Array.isArray(record.repositories)
  )
    return null;
  const anchor =
    typeof record.anchor === "string" &&
    record.anchor &&
    looksLikeProject(record.anchor)
      ? normalizePath(record.anchor)
      : undefined;
  const repositories = record.repositories
    .map(sanitizeRepository)
    .filter((repo): repo is ProjectRepository => !!repo)
    .slice(0, MAX_REPOSITORIES);
  const memberIds = new Set(repositories.map((repo) => repo.id));
  const seenCommonDirs = new Set<string>();
  const deduped = repositories.filter((repo) => {
    const key = pathKey(repo.commonDir);
    if (seenCommonDirs.has(key)) return false;
    seenCommonDirs.add(key);
    return true;
  });
  const sets = (Array.isArray(record.sets) ? record.sets : [])
    .map(sanitizeSet)
    .filter((set): set is SavedRepositorySet => !!set)
    .map((set) => ({
      ...set,
      repositoryIds: set.repositoryIds.filter((id) => memberIds.has(id)),
    }))
    .filter((set) => set.repositoryIds.length > 0)
    .slice(0, MAX_SETS);
  return {
    id: record.id.slice(0, 128),
    ...(typeof record.name === "string" && record.name
      ? { name: record.name.slice(0, 200) }
      : {}),
    ...(anchor ? { anchor } : {}),
    repositories: deduped,
    sets,
    ...(typeof record.lastPath === "string" && record.lastPath
      ? { lastPath: normalizePath(record.lastPath) }
      : {}),
  };
}

/** Raw storage snapshot for useSyncExternalStore — parse via loadProjects. */
export function projectsSnapshot(): string {
  try {
    return localStorage.getItem(KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

export function loadProjects(): ProjectRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ProjectRecord[] = [];
    const seenIds = new Set<string>();
    const seenRepos = new Set<string>();
    for (const item of parsed) {
      const project = sanitizeProject(item);
      if (!project || seenIds.has(project.id)) continue;
      // A repository belongs to at most one project; later records lose.
      const repositories = project.repositories.filter((repo) => {
        const key = pathKey(repo.commonDir);
        if (seenRepos.has(key)) return false;
        seenRepos.add(key);
        return true;
      });
      seenIds.add(project.id);
      out.push({ ...project, repositories });
    }
    return out.slice(0, MAX_PROJECTS);
  } catch {
    return [];
  }
}

function saveProjects(next: ProjectRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX_PROJECTS)));
  } catch {
    // private mode / quota
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PROJECTS_CHANGED));
  }
}

export function subscribeProjects(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PROJECTS_CHANGED, listener);
  return () => window.removeEventListener(PROJECTS_CHANGED, listener);
}

export function updateProject(
  id: string,
  update: (project: ProjectRecord) => ProjectRecord,
): void {
  const projects = loadProjects();
  const next = projects.map((project) =>
    project.id === id ? update(project) : project,
  );
  if (next.some((project, index) => project !== projects[index]))
    saveProjects(next);
}

/** Resolves a repository identity to the project that owns it. */
export function findProjectByCommonDir(
  commonDir: string,
  projects: readonly ProjectRecord[] = loadProjects(),
): { project: ProjectRecord; repository: ProjectRepository } | undefined {
  const key = pathKey(commonDir);
  for (const project of projects) {
    const repository = project.repositories.find(
      (repo) => pathKey(repo.commonDir) === key,
    );
    if (repository) return { project, repository };
  }
  return undefined;
}

/** Resolves any working-copy path to its owning stored project, if verified. */
export function projectForPath(
  path: string,
  families: ReadonlyMap<string, RepositoryFamily> = getVerifiedFamilies(),
  projects: readonly ProjectRecord[] = loadProjects(),
): ProjectRecord | undefined {
  const family = families.get(pathKey(path));
  if (!family) return undefined;
  return findProjectByCommonDir(family.commonDir, projects)?.project;
}

export function projectContainsPath(
  project: ProjectRecord,
  path: string,
  families: ReadonlyMap<string, RepositoryFamily> = getVerifiedFamilies(),
): boolean {
  const family = families.get(pathKey(path));
  if (family) {
    const key = pathKey(family.commonDir);
    if (project.repositories.some((repo) => pathKey(repo.commonDir) === key))
      return true;
  }
  return project.repositories.some(
    (repo) => pathKey(repo.anchor) === pathKey(path),
  );
}

/** The verified family for a stored repository, matched by identity — any
 * already-probed working copy of the same family counts. */
export function familyForRepository(
  repo: ProjectRepository,
  families: ReadonlyMap<string, RepositoryFamily> = getVerifiedFamilies(),
): RepositoryFamily | undefined {
  const direct = families.get(pathKey(repo.anchor));
  const key = pathKey(repo.commonDir);
  if (direct && pathKey(direct.commonDir) === key) return direct;
  for (const family of families.values())
    if (pathKey(family.commonDir) === key) return family;
  return undefined;
}

export function repositoryDisplayName(repo: ProjectRepository): string {
  return repo.label?.trim() || basename(repo.anchor) || repo.anchor;
}

/** Materializes a stored project for `anchorPath`. When `family` is given the
 * verified repository joins as the first member; a non-Git anchor still yields
 * a project that repositories can be added to. */
export function ensureProjectForPath(
  anchorPath: string,
  family?: RepositoryFamily,
): ProjectRecord {
  if (family) {
    const existing = findProjectByCommonDir(family.commonDir);
    if (existing) return existing.project;
  }
  const anchor = normalizePath(anchorPath);
  const existing = loadProjects().find(
    (project) =>
      project.anchor && pathKey(project.anchor) === pathKey(anchor),
  );
  if (existing) return existing;
  const project: ProjectRecord = {
    id: crypto.randomUUID(),
    anchor,
    repositories: family
      ? [
          {
            id: crypto.randomUUID(),
            commonDir: normalizePath(family.commonDir),
            anchor: normalizePath(family.checkout || anchor),
          },
        ]
      : [],
    sets: [],
    lastPath: anchor,
  };
  saveProjects([...loadProjects(), project]);
  return project;
}

/** Creates a project that is only a group — no folder anchor. Its rail row
 * keys on `projectRailKey(id)`; repositories are added afterwards. */
export function createProjectGroup(name?: string): ProjectRecord {
  const trimmed = name?.trim().slice(0, 200);
  const project: ProjectRecord = {
    id: crypto.randomUUID(),
    ...(trimmed ? { name: trimmed } : {}),
    repositories: [],
    sets: [],
  };
  saveProjects([...loadProjects(), project]);
  return project;
}

/** Adds a repository to a project. A repository belongs to at most one
 * project; moving removes it from the previous owner first. */
export function addRepositoryToProject(
  projectId: string,
  repo: Omit<ProjectRepository, "id">,
): { error?: string } {
  const key = pathKey(repo.commonDir);
  const projects = loadProjects();
  const target = projects.find((project) => project.id === projectId);
  if (!target) return { error: "Project not found." };
  const owner = projects.find((project) =>
    project.repositories.some((entry) => pathKey(entry.commonDir) === key),
  );
  if (owner?.id === projectId)
    return { error: "Repository is already in this project." };
  const entry: ProjectRepository = { ...repo, id: crypto.randomUUID() };
  const next = projects.map((project) => {
    if (project.id === owner?.id)
      return removeRepositoryEntry(project, key);
    if (project.id === projectId) {
      if (project.repositories.length >= MAX_REPOSITORIES) return project;
      return { ...project, repositories: [...project.repositories, entry] };
    }
    return project;
  });
  saveProjects(next);
  return {};
}

function removeRepositoryEntry(
  project: ProjectRecord,
  commonDirKey: string,
): ProjectRecord {
  const removed = project.repositories.filter(
    (repo) => pathKey(repo.commonDir) === commonDirKey,
  );
  if (!removed.length) return project;
  const removedIds = new Set(removed.map((repo) => repo.id));
  const repositories = project.repositories.filter(
    (repo) => !removedIds.has(repo.id),
  );
  return {
    ...project,
    repositories,
    sets: project.sets
      .map((set) => ({
        ...set,
        repositoryIds: set.repositoryIds.filter((id) => !removedIds.has(id)),
      }))
      .filter((set) => set.repositoryIds.length > 0),
  };
}

/** Drops the membership association only — files, worktrees, sessions,
 * branches and provider configuration are untouched. */
export function removeRepositoryFromProject(
  projectId: string,
  repositoryId: string,
): void {
  const projects = loadProjects();
  const next = projects.map((project) => {
    if (project.id !== projectId) return project;
    if (!project.repositories.some((repo) => repo.id === repositoryId))
      return project;
    const repositories = project.repositories.filter(
      (repo) => repo.id !== repositoryId,
    );
    return {
      ...project,
      repositories,
      sets: project.sets
        .map((set) => ({
          ...set,
          repositoryIds: set.repositoryIds.filter((id) => id !== repositoryId),
        }))
        .filter((set) => set.repositoryIds.length > 0),
    };
  });
  saveProjects(next);
}

/** Re-points a missing repository at a re-verified family. The repository id —
 * and therefore saved sets and future task children — survives the move. */
export function locateRepository(
  projectId: string,
  repositoryId: string,
  anchor: string,
  family: RepositoryFamily,
): { error?: string } {
  const key = pathKey(family.commonDir);
  const projects = loadProjects();
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) return { error: "Project not found." };
  const conflict = projects.find((entry) =>
    entry.repositories.some(
      (repo) => repo.id !== repositoryId && pathKey(repo.commonDir) === key,
    ),
  );
  if (conflict)
    return {
      error: `This repository already belongs to ${conflict.name ?? (conflict.anchor ? basename(conflict.anchor) : "another project")}.`,
    };
  updateProject(projectId, (current) => ({
    ...current,
    repositories: current.repositories.map((repo) =>
      repo.id === repositoryId
        ? {
            ...repo,
            anchor: normalizePath(anchor),
            commonDir: normalizePath(family.commonDir),
          }
        : repo,
    ),
  }));
  return {};
}

export function renameProject(projectId: string, name: string): void {
  const trimmed = name.trim().slice(0, 200);
  updateProject(projectId, (project) => ({
    ...project,
    ...(trimmed ? { name: trimmed } : { name: undefined }),
  }));
}

export function saveRepositorySet(
  projectId: string,
  name: string,
  repositoryIds: string[],
): { error?: string } {
  const trimmed = name.trim().slice(0, 200);
  if (!trimmed) return { error: "Name the set." };
  if (!repositoryIds.length) return { error: "Select repositories first." };
  updateProject(projectId, (project) => {
    if (project.sets.length >= MAX_SETS) return project;
    const memberIds = new Set(project.repositories.map((repo) => repo.id));
    const ids = repositoryIds.filter((id) => memberIds.has(id));
    if (!ids.length) return project;
    return {
      ...project,
      sets: [
        ...project.sets,
        { id: crypto.randomUUID(), name: trimmed, repositoryIds: ids },
      ],
    };
  });
  return {};
}

export function renameRepositorySet(
  projectId: string,
  setId: string,
  name: string,
): void {
  const trimmed = name.trim().slice(0, 200);
  if (!trimmed) return;
  updateProject(projectId, (project) => ({
    ...project,
    sets: project.sets.map((set) =>
      set.id === setId ? { ...set, name: trimmed } : set,
    ),
  }));
}

export function deleteRepositorySet(projectId: string, setId: string): void {
  updateProject(projectId, (project) => ({
    ...project,
    sets: project.sets.filter((set) => set.id !== setId),
  }));
}

export function moveRepositorySet(
  projectId: string,
  setId: string,
  delta: -1 | 1,
): void {
  updateProject(projectId, (project) => {
    const index = project.sets.findIndex((set) => set.id === setId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= project.sets.length)
      return project;
    const sets = [...project.sets];
    [sets[index], sets[target]] = [sets[target], sets[index]];
    return { ...project, sets };
  });
}

/** Removes the project record. Member repositories return to being
 * repository-only rail entries; nothing on disk or in the session store is
 * touched. */
export function deleteProject(projectId: string): void {
  saveProjects(loadProjects().filter((project) => project.id !== projectId));
}

/** Tracks the last-active working copy inside a stored project so reopening
 * the project lands where the user left off. */
export function recordProjectLastPath(
  path: string,
  families: ReadonlyMap<string, RepositoryFamily> = getVerifiedFamilies(),
): void {
  const projects = loadProjects();
  if (!projects.length) return;
  const normalized = normalizePath(path);
  const project = projects.find(
    (entry) =>
      (entry.anchor &&
        pathKey(entry.anchor) === pathKey(normalized)) ||
      projectContainsPath(entry, normalized, families),
  );
  if (!project || project.lastPath === normalized) return;
  updateProject(project.id, (current) => ({
    ...current,
    lastPath: normalizePath(path),
  }));
}

/** Collapses rail entries whose repository family belongs to one stored
 * project into a single project row. Unverified or non-member entries render
 * unchanged as implicit one-repository projects. */
export function groupRailProjectsByMembership(
  sections: ProjectRailSections,
  families: ReadonlyMap<string, RepositoryFamily>,
  projects: readonly ProjectRecord[] = loadProjects(),
): ProjectRailSections {
  if (!projects.length) return sections;
  const byAnchor = new Map<string, ProjectRecord>();
  for (const project of projects)
    if (project.anchor)
      byAnchor.set(pathKey(project.anchor), project);
  const represented = new Set<string>();
  const group = (items: RailProjectItem[]) => {
    const out: RailProjectItem[] = [];
    const keysInItems = new Set(items.map((item) => pathKey(item.path)));
    for (const item of items) {
      const itemKey = pathKey(item.path);
      const family = families.get(itemKey);
      const member =
        family && findProjectByCommonDir(family.commonDir, projects);
      const project = member?.project ?? byAnchor.get(itemKey);
      if (!project) {
        out.push(item);
        continue;
      }
      // The anchor's own slot is the row's saved position: when it is in the
      // list, earlier member recents are absorbed into it instead.
      if (
        project.anchor &&
        keysInItems.has(pathKey(project.anchor)) &&
        itemKey !== pathKey(project.anchor)
      )
        continue;
      if (represented.has(project.id)) continue;
      represented.add(project.id);
      out.push({
        ...item,
        path: project.anchor ?? projectRailKey(project.id),
        project,
      });
    }
    return out;
  };
  const pinned = group(sections.pinned);
  const unpinned = group(sections.projects);
  // A stored project keeps its rail row even when no member path is currently
  // a recent — the project is the durable boundary, not the recents list.
  for (const project of projects) {
    if (represented.has(project.id)) continue;
    unpinned.push({
      path: project.anchor ?? projectRailKey(project.id),
      openedAt: 0,
      project,
    });
  }
  return { pinned, projects: unpinned };
}
