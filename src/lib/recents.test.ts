import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathKey } from "./paths";
import {
  addRepositoryToProject,
  createProjectGroup,
  ensureProjectForPath,
  isProjectRailKey,
  loadProjects,
  projectRailKey,
} from "./projects";
import type { RepositoryFamily } from "./repositoryFamilies";
import {
  archiveProject,
  forgetProject,
  forgetRemovedWorktree,
  subscribeRemovedWorktree,
  loadArchivedProjects,
  loadPinnedProjects,
  loadProjectRailOrder,
  loadRecents,
  looksLikeProject,
  projectRailItems,
  projectRailSections,
  rememberProject,
  savePinnedProjects,
  saveProjectRailOrder,
  syncProjectRailOrder,
} from "./recents";

function mockLocalStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

describe("looksLikeProject", () => {
  it("rejects the home directory so it is never indexed", () => {
    // Home arrives expanded from `default_cwd`. Walking it reaches
    // ~/Library, which makes macOS prompt for access to other apps' data.
    expect(looksLikeProject("/Users/me")).toBe(false);
    expect(looksLikeProject("/Users/me/")).toBe(false);
    expect(looksLikeProject("/home/me")).toBe(false);
    expect(looksLikeProject("C:/Users/me")).toBe(false);
    expect(looksLikeProject("C:\\Users\\me")).toBe(false);
    expect(looksLikeProject("~")).toBe(false);
  });

  it("rejects system roots and app bundles", () => {
    expect(looksLikeProject("/")).toBe(false);
    expect(looksLikeProject("")).toBe(false);
    expect(looksLikeProject("C:/")).toBe(false);
    expect(looksLikeProject("C:")).toBe(false);
    expect(looksLikeProject("/Applications/Some.app/Contents")).toBe(false);
  });

  it("accepts real projects, including ones directly under home", () => {
    expect(looksLikeProject("/Users/me/code/app")).toBe(true);
    expect(looksLikeProject("/Users/me/Desktop")).toBe(true);
    expect(looksLikeProject("/tmp/scratch")).toBe(true);
    expect(looksLikeProject("C:/Users/me/code/app")).toBe(true);
  });
});

describe("projectRailSections", () => {
  it("keeps saved order and does not move the current project first", () => {
    const recents = [
      { path: "/tmp/older", openedAt: 1 },
      { path: "/tmp/current", openedAt: 2 },
    ];
    const { pinned, projects } = projectRailSections(
      recents,
      "/tmp/current/",
      ["/tmp/older", "/tmp/current"],
      [],
    );
    expect([...pinned, ...projects].map((item) => item.path)).toEqual([
      "/tmp/older",
      "/tmp/current",
    ]);
  });

  it("places pinned projects before unpinned ones", () => {
    const recents = [
      { path: "/tmp/a", openedAt: 1 },
      { path: "/tmp/b", openedAt: 2 },
      { path: "/tmp/c", openedAt: 3 },
    ];
    const { pinned, projects } = projectRailSections(
      recents,
      "/tmp/a",
      ["/tmp/a", "/tmp/b", "/tmp/c"],
      ["/tmp/b"],
    );
    expect(pinned.map((item) => item.path)).toEqual(["/tmp/b"]);
    expect(projects.map((item) => item.path)).toEqual(["/tmp/a", "/tmp/c"]);
  });

  it("appends new projects without reordering existing entries", () => {
    const recents = [
      { path: "/tmp/older", openedAt: 1 },
      { path: "/tmp/new", openedAt: 3 },
    ];
    const projects = new Map([
      ["/tmp/older", { path: "/tmp/older", openedAt: 1 }],
      ["/tmp/new", { path: "/tmp/new", openedAt: 3 }],
    ]);
    expect(syncProjectRailOrder(["/tmp/older"], projects)).toEqual([
      "/tmp/older",
      "/tmp/new",
    ]);
  });
});

describe("projectRailItems", () => {
  it("ignores home as a current folder", () => {
    expect(
      projectRailItems([{ path: "/tmp/app", openedAt: 1 }], "/Users/me").map(
        (item) => item.path,
      ),
    ).toEqual(["/tmp/app"]);
  });
});

describe("project grouping on the rail", () => {
  beforeEach(mockLocalStorage);
  afterEach(mockLocalStorage);

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

  it("collapses two member recents into one project row and keeps order", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    addRepositoryToProject(project.id, {
      commonDir: "/tmp/lib/.git",
      anchor: "/tmp/lib",
    });
    const families = new Map<string, RepositoryFamily>([
      [pathKey("/tmp/app"), family("/tmp/app/.git", "/tmp/app")],
      [pathKey("/tmp/lib"), family("/tmp/lib/.git", "/tmp/lib")],
    ]);
    const sections = projectRailSections(
      [
        { path: "/tmp/app", openedAt: 1 },
        { path: "/tmp/lib", openedAt: 2 },
        { path: "/tmp/else", openedAt: 3 },
      ],
      "/tmp/app",
      ["/tmp/else", "/tmp/lib", "/tmp/app"],
      [],
      families,
      loadProjects(),
    );
    expect(sections.projects.map((item) => item.path)).toEqual([
      "/tmp/else",
      "/tmp/app",
    ]);
    expect(sections.projects[0].project).toBeUndefined();
    expect(sections.projects[1].project?.id).toBe(project.id);
  });

  it("keeps the pinned position when a member recent is pinned", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    addRepositoryToProject(project.id, {
      commonDir: "/tmp/lib/.git",
      anchor: "/tmp/lib",
    });
    const families = new Map<string, RepositoryFamily>([
      [pathKey("/tmp/app"), family("/tmp/app/.git", "/tmp/app")],
      [pathKey("/tmp/lib"), family("/tmp/lib/.git", "/tmp/lib")],
    ]);
    const sections = projectRailSections(
      [
        { path: "/tmp/app", openedAt: 1 },
        { path: "/tmp/lib", openedAt: 2 },
      ],
      "/tmp/app",
      ["/tmp/app", "/tmp/lib"],
      ["/tmp/lib"],
      families,
      loadProjects(),
    );
    expect(sections.pinned.map((item) => item.path)).toEqual(["/tmp/app"]);
    expect(sections.pinned[0].project?.id).toBe(project.id);
    expect(sections.projects).toEqual([]);
  });

  it("renders a stored project whose members are not recents", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    const sections = projectRailSections(
      [{ path: "/tmp/else", openedAt: 1 }],
      "/tmp/else",
      ["/tmp/else", "/tmp/app"],
      [],
      new Map(),
      [project],
    );
    expect(sections.projects.map((item) => item.path)).toEqual([
      "/tmp/else",
      "/tmp/app",
    ]);
    expect(sections.projects[1].project?.id).toBe(project.id);
  });

  it("renders a group project once — its sentinel row is not duplicated", () => {
    const group = createProjectGroup("Team");
    const sections = projectRailSections(
      [{ path: "/tmp/else", openedAt: 1 }],
      "/tmp/else",
      ["/tmp/else", projectRailKey(group.id)],
      [],
      new Map(),
      loadProjects(),
    );
    const rows = sections.projects.filter((item) =>
      isProjectRailKey(item.path),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].project?.id).toBe(group.id);
  });

  it("collapses a member recent through its stored repository anchor before the family is probed", () => {
    const project = ensureProjectForPath(
      "/tmp/app",
      family("/tmp/app/.git", "/tmp/app"),
    );
    addRepositoryToProject(project.id, {
      commonDir: "/tmp/lib/.git",
      anchor: "/tmp/lib",
    });
    // No verified families yet — the member recent still joins its project
    // instead of briefly doubling the row.
    const sections = projectRailSections(
      [
        { path: "/tmp/app", openedAt: 1 },
        { path: "/tmp/lib", openedAt: 2 },
      ],
      "/tmp/app",
      ["/tmp/app", "/tmp/lib"],
      [],
      new Map(),
      loadProjects(),
    );
    expect(sections.projects.map((item) => item.path)).toEqual(["/tmp/app"]);
    expect(sections.projects[0].project?.id).toBe(project.id);
  });
});

describe("forgetProject", () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  afterEach(() => {
    mockLocalStorage();
  });

  it("drops the recent entry, rail order slot, and pin", () => {
    rememberProject("/tmp/keep");
    rememberProject("/tmp/gone");
    saveProjectRailOrder(["/tmp/keep", "/tmp/gone"]);
    savePinnedProjects(["/tmp/gone"]);

    expect(forgetProject("/tmp/gone").map((item) => item.path)).toEqual([
      "/tmp/keep",
    ]);
    expect(loadRecents().map((item) => item.path)).toEqual(["/tmp/keep"]);
    expect(loadProjectRailOrder()).toEqual(["/tmp/keep"]);
    expect(loadPinnedProjects()).toEqual([]);
  });

  it("treats differently-cased Windows paths as one project", () => {
    rememberProject("C:/Users/me/Code/App");
    rememberProject("c:/users/ME/code/app");
    expect(loadRecents().map((item) => item.path)).toEqual([
      "c:/users/ME/code/app",
    ]);
  });
});

describe("archiveProject", () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  afterEach(() => {
    mockLocalStorage();
  });

  it("files the project in the archive and takes it off the rail", () => {
    rememberProject("/tmp/keep");
    rememberProject("/tmp/gone");
    savePinnedProjects(["/tmp/gone"]);

    expect(archiveProject("/tmp/gone").map((item) => item.path)).toEqual([
      "/tmp/keep",
    ]);
    expect(loadArchivedProjects().map((item) => item.path)).toEqual([
      "/tmp/gone",
    ]);
    expect(loadPinnedProjects()).toEqual([]);
    expect(loadRecents().map((item) => item.path)).toEqual(["/tmp/keep"]);
  });

  it("opening a project again restores it from the archive", () => {
    rememberProject("/tmp/gone");
    archiveProject("/tmp/gone");
    expect(loadArchivedProjects()).toHaveLength(1);

    rememberProject("/tmp/gone");
    expect(loadArchivedProjects()).toEqual([]);
    expect(loadRecents().map((item) => item.path)).toEqual(["/tmp/gone"]);
  });

  it("delete drops an archived project instead of restoring it", () => {
    rememberProject("/tmp/gone");
    archiveProject("/tmp/gone");
    forgetProject("/tmp/gone");
    expect(loadArchivedProjects()).toEqual([]);
    expect(loadRecents()).toEqual([]);
  });
});

describe("confirmed worktree removal", () => {
  beforeEach(mockLocalStorage);
  it("keeps one pinned repository after the removed child loses its Git identity", () => {
    rememberProject("/tmp/repo");
    rememberProject("/tmp/unrelated");
    rememberProject("/tmp/child");
    saveProjectRailOrder(["/tmp/child", "/tmp/unrelated", "/tmp/repo"]);
    savePinnedProjects(["/tmp/child", "/tmp/repo"]);
    let notified = false;
    const unsubscribe = subscribeRemovedWorktree(({ path, replacement }) => {
      expect(path).toBe("/tmp/child");
      expect(replacement).toBe("/tmp/repo");
      expect(loadRecents().some((item) => item.path === path)).toBe(false);
      notified = true;
    });
    forgetRemovedWorktree("/tmp/child", "/tmp/repo");
    unsubscribe();
    expect(notified).toBe(true);
    expect(loadProjectRailOrder()).toEqual(["/tmp/repo", "/tmp/unrelated"]);
    expect(loadPinnedProjects()).toEqual(["/tmp/repo"]);
    const sections = projectRailSections(
      loadRecents(),
      "/tmp/repo",
      loadProjectRailOrder(),
      loadPinnedProjects(),
      new Map(),
    );
    expect(sections.pinned.map((item) => item.path)).toEqual(["/tmp/repo"]);
    expect(sections.projects.map((item) => item.path)).toEqual([
      "/tmp/unrelated",
    ]);
  });
  it("retains the repository when only the removed child was remembered", () => {
    rememberProject("/tmp/child");
    forgetRemovedWorktree("/tmp/child/", "/tmp/repo");
    expect(loadRecents().map((item) => item.path)).toEqual(["/tmp/repo"]);
  });
});
