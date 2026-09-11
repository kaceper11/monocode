// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { pathKey } from "./paths";
import type { RepositoryFamily } from "./repositoryFamilies";
import {
  addRepositoryToProject,
  createProjectGroup,
  deleteRepositorySet,
  ensureProjectForPath,
  familyForRepository,
  findProjectByCommonDir,
  groupRailProjectsByMembership,
  isProjectRailKey,
  loadProjects,
  locateRepository,
  moveRepositorySet,
  projectContainsPath,
  projectForPath,
  recordProjectLastPath,
  removeRepositoryFromProject,
  renameRepositorySet,
  repositoryDisplayName,
  saveRepositorySet,
  type ProjectRecord,
} from "./projects";

function family(commonDir: string, checkout: string): RepositoryFamily {
  return {
    commonDir,
    checkout,
    worktrees: [
      {
        path: checkout,
        head: "main",
        branch: "main",
        main: true,
        missing: false,
        locked: null,
        prunable: null,
      },
    ],
  };
}

function saveRaw(records: unknown) {
  localStorage.setItem("monocode.projects.v1", JSON.stringify(records));
}

beforeEach(() => {
  localStorage.clear();
});

describe("loadProjects", () => {
  it("returns nothing for missing or malformed storage", () => {
    expect(loadProjects()).toEqual([]);
    localStorage.setItem("monocode.projects.v1", "not json");
    expect(loadProjects()).toEqual([]);
    localStorage.setItem("monocode.projects.v1", JSON.stringify({ a: 1 }));
    expect(loadProjects()).toEqual([]);
    saveRaw([{ id: 1 }, { id: "x", anchor: "/tmp/app" }]);
    expect(loadProjects()).toEqual([]);
  });

  it("drops sets whose members left and fields that fail validation", () => {
    saveRaw([
      {
        id: "p1",
        anchor: "/tmp/app",
        repositories: [
          { id: "r1", commonDir: "/tmp/app/.git", anchor: "/tmp/app" },
          { id: "bad" },
        ],
        sets: [
          { id: "s1", name: "Backend", repositoryIds: ["r1", "gone"] },
          { id: "s2", name: "Empty", repositoryIds: ["gone"] },
        ],
      },
    ]);
    const [project] = loadProjects();
    expect(project.repositories).toHaveLength(1);
    expect(project.sets).toEqual([
      { id: "s1", name: "Backend", repositoryIds: ["r1"] },
    ]);
  });

  it("keeps a repository in at most one project when storage disagrees", () => {
    saveRaw([
      {
        id: "p1",
        anchor: "/tmp/a",
        repositories: [
          { id: "r1", commonDir: "/tmp/a/.git", anchor: "/tmp/a" },
        ],
        sets: [],
      },
      {
        id: "p2",
        anchor: "/tmp/b",
        repositories: [
          { id: "r2", commonDir: "/tmp/a/.git", anchor: "/tmp/alias" },
          { id: "r3", commonDir: "/tmp/b/.git", anchor: "/tmp/b" },
        ],
        sets: [],
      },
    ]);
    const [first, second] = loadProjects();
    expect(first.repositories.map((r) => r.id)).toEqual(["r1"]);
    expect(second.repositories.map((r) => r.id)).toEqual(["r3"]);
  });
});

describe("repository identity", () => {
  it("keeps same-named folders and two clones of one remote distinct", () => {
    const one = family("/work/api/.git", "/work/api");
    const two = family("/other/api/.git", "/other/api");
    const project = ensureProjectForPath("/work/api", one);
    addRepositoryToProject(project.id, {
      commonDir: two.commonDir,
      anchor: two.checkout,
    });
    const stored = loadProjects()[0];
    expect(stored.repositories).toHaveLength(2);
    expect(
      stored.repositories.map(repositoryDisplayName),
    ).toEqual(["api", "api"]);
  });

  it("separates native and WSL paths on the same machine", () => {
    expect(
      pathKey("//wsl.localhost/Ubuntu/home/me/repo/.git"),
    ).not.toBe(pathKey("/home/me/repo/.git"));
    const project = ensureProjectForPath(
      "/home/me/repo",
      family("/home/me/repo/.git", "/home/me/repo"),
    );
    addRepositoryToProject(project.id, {
      commonDir: "//wsl.localhost/Ubuntu/home/me/repo/.git",
      anchor: "//wsl.localhost/Ubuntu/home/me/repo",
    });
    expect(loadProjects()[0].repositories).toHaveLength(2);
  });
});

describe("membership", () => {
  it("materializes a project once around the verified family", () => {
    const f = family("/tmp/app/.git", "/tmp/app");
    const first = ensureProjectForPath("/tmp/app", f);
    const second = ensureProjectForPath("/tmp/app", f);
    expect(second.id).toBe(first.id);
    expect(loadProjects()).toHaveLength(1);
  });

  it("moves a repository between projects instead of duplicating it", () => {
    const a = ensureProjectForPath("/tmp/a", family("/tmp/a/.git", "/tmp/a"));
    const b = ensureProjectForPath("/tmp/b", family("/tmp/b/.git", "/tmp/b"));
    addRepositoryToProject(b.id, {
      commonDir: "/tmp/c/.git",
      anchor: "/tmp/c",
    });
    expect(
      addRepositoryToProject(a.id, {
        commonDir: "/tmp/c/.git",
        anchor: "/tmp/c",
      }).error,
    ).toBeUndefined();
    const projects = loadProjects();
    const owner = projects.find((p) =>
      p.repositories.some((r) => pathKey(r.commonDir) === pathKey("/tmp/c/.git")),
    );
    expect(owner?.id).toBe(a.id);
    expect(
      projects
        .find((p) => p.id === b.id)
        ?.repositories.some(
          (r) => pathKey(r.commonDir) === pathKey("/tmp/c/.git"),
        ),
    ).toBe(false);
  });

  it("removing a repository prunes it from saved sets", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    addRepositoryToProject(project.id, {
      commonDir: "/tmp/lib/.git",
      anchor: "/tmp/lib",
    });
    const stored = loadProjects()[0];
    const [app, lib] = stored.repositories;
    saveRepositorySet(project.id, "Both", [app.id, lib.id]);
    removeRepositoryFromProject(project.id, lib.id);
    const after = loadProjects()[0];
    expect(after.repositories.map((r) => r.id)).toEqual([app.id]);
    // A single-member set still survives; empty sets would be dropped.
    expect(after.sets[0]?.repositoryIds).toEqual([app.id]);
  });
});

describe("locateRepository", () => {
  it("keeps the repository id across a move", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    const repo = loadProjects()[0].repositories[0];
    const moved = family("/tmp/moved/app/.git", "/tmp/moved/app");
    const result = locateRepository(project.id, repo.id, "/tmp/moved/app", moved);
    expect(result.error).toBeUndefined();
    const after = loadProjects()[0].repositories[0];
    expect(after.id).toBe(repo.id);
    expect(after.commonDir).toBe("/tmp/moved/app/.git");
    expect(after.anchor).toBe("/tmp/moved/app");
  });

  it("rejects locating onto another member's identity", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    addRepositoryToProject(project.id, {
      commonDir: "/tmp/lib/.git",
      anchor: "/tmp/lib",
    });
    const [app] = loadProjects()[0].repositories;
    const result = locateRepository(
      project.id,
      app.id,
      "/tmp/lib",
      family("/tmp/lib/.git", "/tmp/lib"),
    );
    expect(result.error).toBeTruthy();
  });
});

describe("saved sets", () => {
  it("preserves repository order and edits do not touch earlier tasks", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    addRepositoryToProject(project.id, {
      commonDir: "/tmp/b/.git",
      anchor: "/tmp/b",
    });
    const [a, b] = loadProjects()[0].repositories;
    expect(saveRepositorySet(project.id, "Back then front", [b.id, a.id]).error)
      .toBeUndefined();
    expect(loadProjects()[0].sets[0].repositoryIds).toEqual([b.id, a.id]);
  });

  it("rejects empty names and unknown members", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    const [repo] = loadProjects()[0].repositories;
    expect(saveRepositorySet(project.id, "  ", [repo.id]).error).toBeTruthy();
    expect(saveRepositorySet(project.id, "Set", []).error).toBeTruthy();
    saveRepositorySet(project.id, "Set", [repo.id, "foreign"]);
    expect(loadProjects()[0].sets[0].repositoryIds).toEqual([repo.id]);
  });

  it("renames, reorders and deletes sets", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    const [repo] = loadProjects()[0].repositories;
    saveRepositorySet(project.id, "One", [repo.id]);
    saveRepositorySet(project.id, "Two", [repo.id]);
    const [one, two] = loadProjects()[0].sets;
    moveRepositorySet(project.id, two.id, -1);
    expect(loadProjects()[0].sets.map((set) => set.name)).toEqual([
      "Two",
      "One",
    ]);
    renameRepositorySet(project.id, two.id, "Pair");
    expect(loadProjects()[0].sets[0].name).toBe("Pair");
    deleteRepositorySet(project.id, one.id);
    expect(loadProjects()[0].sets.map((set) => set.id)).toEqual([two.id]);
  });
});

describe("rail grouping", () => {
  const app = family("/tmp/app/.git", "/tmp/app");
  const lib = family("/tmp/lib/.git", "/tmp/lib");
  const families = new Map<string, RepositoryFamily>([
    [pathKey("/tmp/app"), app],
    [pathKey("/tmp/lib"), lib],
  ]);

  it("collapses member recents into one project row keyed on the anchor", () => {
    const project = ensureProjectForPath("/tmp/app", app);
    addRepositoryToProject(project.id, {
      commonDir: lib.commonDir,
      anchor: lib.checkout,
    });
    const stored = loadProjects();
    const sections = groupRailProjectsByMembership(
      {
        pinned: [],
        projects: [
          { path: "/tmp/lib", openedAt: 2 },
          { path: "/tmp/app", openedAt: 1 },
        ],
      },
      families,
      stored,
    );
    expect(sections.projects).toHaveLength(1);
    expect(sections.projects[0].path).toBe("/tmp/app");
    expect(sections.projects[0].project?.id).toBe(project.id);
  });

  it("leaves non-member recents untouched", () => {
    const project = ensureProjectForPath("/tmp/app", app);
    const sections = groupRailProjectsByMembership(
      {
        pinned: [],
        projects: [
          { path: "/tmp/app", openedAt: 1 },
          { path: "/tmp/other", openedAt: 2 },
        ],
      },
      families,
      [project],
    );
    expect(sections.projects.map((item) => item.path)).toEqual([
      "/tmp/app",
      "/tmp/other",
    ]);
    expect(sections.projects[1].project).toBeUndefined();
  });

  it("keeps a stored project on the rail without member recents", () => {
    const project = ensureProjectForPath("/tmp/app", app);
    const sections = groupRailProjectsByMembership(
      { pinned: [], projects: [{ path: "/tmp/other", openedAt: 1 }] },
      families,
      [project],
    );
    const paths = sections.projects.map((item) => item.path);
    expect(paths).toContain("/tmp/app");
    expect(paths).toContain("/tmp/other");
  });
});

describe("last path tracking", () => {
  it("records activity only for member working copies", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    const families = new Map([
      [pathKey("/tmp/app"), family("/tmp/app/.git", "/tmp/app")],
      [pathKey("/tmp/lib"), family("/tmp/lib/.git", "/tmp/lib")],
    ]);
    recordProjectLastPath("/tmp/lib", families);
    expect(loadProjects()[0].lastPath).toBe("/tmp/app");
    recordProjectLastPath("/tmp/app", families);
    expect(loadProjects()[0].lastPath).toBe("/tmp/app");
  });
});

describe("path resolution", () => {
  it("finds the owning project through any verified member copy", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    const worktree = family("/tmp/app/.git", "/tmp/app");
    worktree.worktrees.push({
      path: "/tmp/app-fix",
      head: "fix",
      branch: "fix",
      main: false,
      missing: false,
      locked: null,
      prunable: null,
    });
    const families = new Map([[pathKey("/tmp/app-fix"), worktree]]);
    expect(projectForPath("/tmp/app-fix", families)?.id).toBe(project.id);
    expect(projectContainsPath(project, "/tmp/app-fix", families)).toBe(true);
    expect(projectContainsPath(project, "/tmp/elsewhere", families)).toBe(false);
  });

  it("matches a family for a repository through a sibling probe", () => {
    const sibling = family("/tmp/app/.git", "/tmp/app");
    const families = new Map([[pathKey("/tmp/app-fix"), sibling]]);
    const repo = { id: "r", commonDir: "/tmp/app/.git", anchor: "/tmp/app" };
    expect(familyForRepository(repo, families)?.checkout).toBe("/tmp/app");
    expect(
      familyForRepository(
        { id: "r2", commonDir: "/tmp/missing/.git", anchor: "/tmp/missing" },
        families,
      ),
    ).toBeUndefined();
  });
});

describe("group projects", () => {
  it("creates an anchorless project that persists", () => {
    const group = createProjectGroup("My work");
    expect(group.anchor).toBeUndefined();
    expect(group.repositories).toEqual([]);
    const stored = loadProjects();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe("My work");
    expect(stored[0].anchor).toBeUndefined();
  });

  it("renders a sentinel rail row and still absorbs member recents", () => {
    const group = createProjectGroup();
    const lib = family("/tmp/lib/.git", "/tmp/lib");
    addRepositoryToProject(group.id, {
      commonDir: lib.commonDir,
      anchor: lib.checkout,
    });
    const stored = loadProjects();
    const families = new Map([[pathKey("/tmp/lib"), lib]]);
    const sections = groupRailProjectsByMembership(
      { pinned: [], projects: [{ path: "/tmp/lib", openedAt: 1 }] },
      families,
      stored,
    );
    expect(sections.projects).toHaveLength(1);
    expect(sections.projects[0].path).toBe(`project:${group.id}`);
    expect(isProjectRailKey(sections.projects[0].path)).toBe(true);
    expect(sections.projects[0].project?.id).toBe(group.id);
  });

  it("keeps a sentinel row without member recents", () => {
    const group = createProjectGroup();
    const sections = groupRailProjectsByMembership(
      { pinned: [], projects: [{ path: "/tmp/other", openedAt: 1 }] },
      new Map(),
      loadProjects(),
    );
    const paths = sections.projects.map((item) => item.path);
    expect(paths).toContain(`project:${group.id}`);
    expect(paths).toContain("/tmp/other");
  });

  it("tracks lastPath through member working copies without an anchor", () => {
    const group = createProjectGroup();
    const lib = family("/tmp/lib/.git", "/tmp/lib");
    addRepositoryToProject(group.id, {
      commonDir: lib.commonDir,
      anchor: lib.checkout,
    });
    recordProjectLastPath(
      "/tmp/lib",
      new Map([[pathKey("/tmp/lib"), lib]]),
    );
    expect(loadProjects()[0].lastPath).toBe("/tmp/lib");
  });
});
