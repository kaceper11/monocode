import { invoke } from "@tauri-apps/api/core";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  assertGithubBinding,
  DEFAULT_PROJECT_CONNECTIONS,
  githubBinding,
  githubBindingKey,
  githubRequest,
  inboxConnectionsKey,
  inheritWorktreeConnections,
  loadConnections,
  projectConnections,
  saveConnections,
  validateConnections,
  type Connections,
} from "./connections";
import {
  dedupeInboxItems,
  detailsCacheKey,
  prDiffCacheKey,
  type InboxItem,
} from "./githubTasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const fixture = (): Connections => ({
  version: 1,
  accounts: [
    {
      id: "a",
      provider: "github",
      hostname: "github.com",
      login: "alice",
      credentialHost: "local",
      writes: true,
    },
    {
      id: "b",
      provider: "github",
      hostname: "github.com",
      login: "bob",
      credentialHost: "local",
      writes: false,
    },
  ],
  projects: {
    "/repo": {
      ...DEFAULT_PROJECT_CONNECTIONS,
      tickets: [{ provider: "github", accountId: "a", project: "org/repo" }],
      prs: { provider: "github", accountId: "b", project: "org/repo" },
      ci: [
        {
          provider: "azure-pipelines",
          accountId: "azure",
          project: "org/project",
        },
      ],
    },
  },
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("independent connections", () => {
  it("preserves legacy defaults and changes CI without changing other bindings", () => {
    expect(projectConnections("/old")).toEqual(DEFAULT_PROJECT_CONNECTIONS);
    const config = fixture();
    saveConnections(config);
    const before = projectConnections("/repo");
    const inboxBefore = inboxConnectionsKey(config);
    config.projects["/repo"].ci = [];
    expect(inboxConnectionsKey(config)).toBe(inboxBefore);
    saveConnections(config);
    expect(projectConnections("/repo")).toEqual({ ...before, ci: [] });
    expect(localStorage.getItem("monocode.connections.v1.backup")).toContain(
      "azure-pipelines",
    );
  });

  it("keeps colliding artifact and cache identities separate for two accounts", () => {
    const config = fixture();
    const a = githubBinding(config.projects["/repo"].tickets![0], config);
    const b = githubBinding(
      { provider: "github", accountId: "b", project: "org/repo" },
      config,
    );
    expect(githubBindingKey(a)).not.toBe(githubBindingKey(b));
    expect(detailsCacheKey("/repo", "issue", 1, a)).not.toBe(
      detailsCacheKey("/repo", "issue", 1, b),
    );
    expect(prDiffCacheKey("/repo", 1, a)).not.toBe(
      prDiffCacheKey("/repo", 1, b),
    );
    const item: InboxItem = {
      provider: "github",
      kind: "issue",
      number: 1,
      title: "issue",
      url: "https://github.com/org/repo/issues/1",
      state: "OPEN",
      updatedAt: "",
      labels: [],
      assignees: [],
      draft: false,
      repo: "org/repo",
      projectPath: "/repo",
    };
    expect(
      dedupeInboxItems([
        { ...item, binding: a },
        { ...item, binding: b },
      ]),
    ).toHaveLength(2);
  });

  it("rejects disconnected or retargeted snapshots and gates writes independently", () => {
    const config = fixture();
    saveConnections(config);
    const a = githubBinding(config.projects["/repo"].tickets![0]);
    const b = githubBinding({
      provider: "github",
      accountId: "b",
      project: "org/repo",
    });
    expect(() => assertGithubBinding("/repo", "issue", a, true)).not.toThrow();
    expect(() => assertGithubBinding("/repo", "pr", b, true)).toThrow(
      "does not allow writes",
    );
    config.accounts = config.accounts.filter((account) => account.id !== "a");
    saveConnections(config);
    expect(() => assertGithubBinding("/repo", "issue", a)).toThrow(
      "disconnected",
    );
    expect(() => assertGithubBinding("/repo", "pr", b)).not.toThrow();
    config.projects["/repo"].prs = {
      provider: "github",
      accountId: "b",
      project: "org/other",
    };
    saveConnections(config);
    expect(() => assertGithubBinding("/repo", "pr", b)).toThrow("changed");
  });

  it("copies project mappings to a new worktree and preserves existing settings", () => {
    const config = fixture();
    saveConnections(config);
    inheritWorktreeConnections("/repo", "/repo-task");
    expect(projectConnections("/repo-task")).toEqual(config.projects["/repo"]);
    const updated = loadConnections();
    updated.projects["/repo-task"].tickets = [];
    saveConnections(updated);
    inheritWorktreeConnections("/repo", "/repo-task");
    expect(projectConnections("/repo-task").tickets).toEqual([]);
    expect(() => saveConnections(config, config)).toThrow("another window");
  });

  it("records unsupported mixed providers without a credential fallback", () => {
    const config = fixture();
    config.projects["/repo"].tickets = [
      { provider: "jira", accountId: "jira", project: "TEAM" },
    ];
    config.projects["/repo"].prs = {
      provider: "azure-repos",
      accountId: "azure",
      project: "org/project/repo",
    };
    saveConnections(config);
    expect(() => githubBinding(config.projects["/repo"].tickets[0])).toThrow(
      "not available",
    );
    expect(() => assertGithubBinding("/repo", "issue")).toThrow("changed");
    expect(() =>
      githubBinding({
        provider: "github",
        accountId: "missing",
        project: "org/repo",
      }),
    ).toThrow("disconnected");
  });

  it("bounds active requests and rejects queued work after disconnect", async () => {
    const config = fixture();
    saveConnections(config);
    const binding = githubBinding(config.projects["/repo"].tickets![0]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(invoke).mockImplementation(async () => {
      await gate;
      return "ok";
    });
    const requests = Array.from({ length: 5 }, () =>
      githubRequest("git_github_work_items", {
        cwd: "/repo",
        kind: "issue",
        binding,
      }).catch((error: Error) => error.message),
    );
    expect(invoke).toHaveBeenCalledTimes(4);
    config.accounts = config.accounts.filter((account) => account.id !== "a");
    saveConnections(config);
    release();
    const results = await Promise.all(requests);
    expect(results.slice(0, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(results[4]).toContain("disconnected");
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("caps the waiting queue while draining accepted requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(invoke).mockImplementation(async () => {
      await gate;
      return "org/repo";
    });
    const requests = Array.from({ length: 69 }, () =>
      githubRequest("git_github_repo", { cwd: "/repo" }).catch(
        (error: Error) => error.message,
      ),
    );
    expect(invoke).toHaveBeenCalledTimes(4);
    release();
    const results = await Promise.all(requests);
    expect(results.filter((result) => result === "org/repo")).toHaveLength(68);
    expect(results[68]).toContain("queue is full");
  });

  it("does not overwrite invalid or future settings and rejects host confusion", () => {
    localStorage.setItem("monocode.connections.v1", '{"version":2}');
    expect(loadConnections).toThrow();
    expect(localStorage.getItem("monocode.connections.v1")).toBe(
      '{"version":2}',
    );
    const config = fixture();
    Object.assign(config.accounts[0], { credentialHost: "wsl" });
    expect(() => validateConnections(config)).toThrow("account");
    Object.assign(config.accounts[0], { credentialHost: "local" });
    config.projects["/repo"].executionHost = {
      kind: "wsl",
      distribution: "Ubuntu 24.04 – 開発",
    };
    expect(() => validateConnections(config)).not.toThrow();
    config.projects["/repo"].executionHost = {
      kind: "wsl",
      distribution: "Ubuntu\nother",
    };
    expect(() => validateConnections(config)).toThrow("host");
  });
});
