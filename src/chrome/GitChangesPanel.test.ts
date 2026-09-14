// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { GitChangesPanel } from "./GitChangesPanel";
import {
  contextFromChanges,
  contextFromText,
  requestAgentContext,
} from "../lib/agentContext";
vi.mock("../lib/agentContext", async (original) => ({
  ...(await original<typeof import("../lib/agentContext")>()),
  contextFromChanges: vi.fn(),
  requestAgentContext: vi.fn(),
}));
vi.mock("./GitHistoryGraph", () => ({
  GitHistoryGraph: () => null,
  GraphResizeSash: () => null,
  GRAPH_PANEL_DEFAULT: 180,
  GRAPH_PANEL_MIN: 80,
  loadGraphPanelHeight: () => 180,
  saveGraphPanelHeight: () => {},
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(async () => true),
  message: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "git_diff_index"
      ? {
          branch: "feature",
          ahead: 0,
          behind: 0,
          files: [
            {
              path: "/repo/a.ts",
              relative: "a.ts",
              status: "modified",
              staged: false,
              unstaged: true,
              additions: 1,
              deletions: 0,
            },
          ],
        }
      : null,
  ),
}));
it("keeps changes selected until the chosen recipient accepts context", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  vi.mocked(contextFromChanges).mockResolvedValue(
    contextFromText("a.ts", "patch", "/repo"),
  );
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === text,
    )!;
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo",
          sourceSessionId: "original",
          enabled: true,
          onOpenFile: vi.fn(),
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    expect(
      [...host.querySelectorAll("button")].filter(
        (button) => button.getAttribute("aria-label") === "Pull requests",
      ),
    ).toHaveLength(1);
    expect(
      [...host.querySelectorAll("button")].filter(
        (button) => button.getAttribute("aria-label") === "CI",
      ),
    ).toHaveLength(1);
    await act(async () =>
      (
        host.querySelector(
          'button[aria-label="Select files for agent"]',
        ) as HTMLButtonElement
      ).click(),
    );
    localStorage.setItem(
      "monocode.taskWorkspaces.v1",
      JSON.stringify([
        {
          id: "t1",
          projectId: "p1",
          name: "Fix billing",
          children: [
            {
              id: "c1",
              repositoryId: "r1",
              sessionIds: [],
              launch: { state: "pending" },
            },
          ],
          sessionIds: [],
          createdAt: 1,
        },
      ]),
    );
    const checkbox = () =>
      host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const menuItem = (text: string) =>
      [...document.body.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === text,
      ) as HTMLButtonElement;
    await act(async () => checkbox().click());
    // The task menu opens; the selection stays until a target accepts it.
    await act(async () => button("Send to task").click());
    expect(checkbox().checked).toBe(true);
    await act(async () => menuItem("Fix billing").click());
    expect(checkbox().checked).toBe(true);
    expect(requestAgentContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionId: "original",
        taskId: "t1",
      }),
    );
    await act(async () =>
      vi.mocked(requestAgentContext).mock.calls.at(-1)![0].onPrepared!(),
    );
    expect(checkbox()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.removeItem("monocode.taskWorkspaces.v1");
    vi.unstubAllGlobals();
  }
});

it("moves a staged file immediately and refreshes the index once", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { invoke } = await import("@tauri-apps/api/core");
  let staged = false;
  let indexCalls = 0;
  let release: (() => void) | undefined;
  const snapshot = () => ({
    branch: "feature",
    ahead: 0,
    behind: 0,
    files: [
      {
        path: "/repo-stage/a.ts",
        relative: "a.ts",
        status: "modified",
        staged,
        unstaged: !staged,
        additions: 1,
        deletions: 0,
      },
    ],
  });
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "git_stage_file") {
      staged = true;
      return null;
    }
    if (command === "git_diff_index") {
      indexCalls += 1;
      if (indexCalls === 2) {
        // Hold the post-mutation refresh open so the optimistic move is
        // observable before the refreshed index lands.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return snapshot();
    }
    return original(command, args);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const stageButton = () =>
    host.querySelector('button[aria-label="Stage Changes"]');
  const unstageButton = () =>
    host.querySelector('button[aria-label="Unstage Changes"]');
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo-stage",
          sourceSessionId: "owner",
          enabled: true,
          onOpenFile: vi.fn(),
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    expect(stageButton()).not.toBeNull();
    expect(unstageButton()).toBeNull();
    await act(async () => {
      (stageButton() as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The row moved to the staged section before the refreshed index
    // resolved, and the mutation triggered exactly one index reload
    // (notify + no duplicate reload pass).
    expect(stageButton()).toBeNull();
    expect(unstageButton()).not.toBeNull();
    expect(indexCalls).toBe(2);
    await act(async () => release?.());
    expect(unstageButton()).not.toBeNull();
    expect(indexCalls).toBe(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(invoke).mockImplementation(original);
    vi.unstubAllGlobals();
  }
});

it("toggles selection from the row and hides row actions while selecting", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const checkbox = () =>
    host.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  const onOpenFile = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo-row",
          sourceSessionId: "owner",
          enabled: true,
          onOpenFile,
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    await act(async () =>
      (
        host.querySelector(
          'button[aria-label="Select files for agent"]',
        ) as HTMLButtonElement
      ).click(),
    );
    // Clicking the row body (not the checkbox) toggles selection and does
    // not open the file.
    await act(async () =>
      (host.querySelector('button[title="a.ts"]') as HTMLButtonElement).click(),
    );
    expect(checkbox()?.checked).toBe(true);
    expect(onOpenFile).not.toHaveBeenCalled();
    // Stage/unstage/discard icons stay out of the way in selection mode.
    expect(host.querySelector('button[aria-label="Stage Changes"]')).toBeNull();
    await act(async () =>
      (host.querySelector('button[title="a.ts"]') as HTMLButtonElement).click(),
    );
    expect(checkbox()?.checked).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("updates PR and CI rows when their exact conversation associations change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value) });
  const { saveAzurePrAssociation } = await import("../lib/azureRepos");
  const { saveCiSources } = await import("../lib/azurePipelines");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn();
  const prRow = () => host.querySelector('button[aria-label="Pull requests"]') as HTMLButtonElement;
  const ciRow = () => host.querySelector('button[aria-label="CI"]') as HTMLButtonElement;
  const association = {
    cwd: "/repo", branch: "feature", sourceSessionId: "owner", account: "Ada", projectName: "Project", repositoryName: "repo", revision: "head:base",
    target: { site: "https://dev.azure.com/team", accountId: "ada", project: "project", repository: "repo", number: 13 },
    pr: { pullRequestId: 13, title: "Fix login", status: "active", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", reviewers: [{ id: "reviewer", displayName: "Sam", vote: -5 }] },
  };
  try {
    await act(async () => root.render(createElement(GitChangesPanel, { cwd: "/repo", sourceSessionId: "owner", enabled: true, onOpenDelivery: open, onOpenFile: vi.fn(), onOpenAllChanges: vi.fn(), onOpenCommit: vi.fn() })));
    await act(async () => saveAzurePrAssociation({ ...association, sourceSessionId: "other" }, "/repo", "feature", "other"));
    expect(prRow().textContent).not.toContain("Fix login");
    await act(async () => saveAzurePrAssociation(association, "/repo", "feature", "owner"));
    expect(prRow().textContent).toContain("#13 Fix login");
    expect(prRow().textContent).toContain("Needs attention · saved");
    await act(async () => prRow().click());
    expect(open).toHaveBeenLastCalledWith("/repo", { kind: "pr", branch: "feature", sourceSessionId: "owner", provider: "azure" });
    const target = { site: "https://dev.azure.com/team", accountId: "ada", project: "project", definition: 7, repositoryId: "team/repo", repositoryType: "GitHub", repositoryUrl: "https://github.com/team/repo" };
    await act(async () => saveCiSources([{ target, cwd: "/repo", branch: "feature", session: "owner", remote: target.repositoryUrl, definitionName: "Unit tests", projectName: "Project" }], "/repo", "feature", "owner"));
    expect(ciRow().textContent).toContain("Unit tests");
    await act(async () => saveAzurePrAssociation(null, "/repo", "feature", "owner", association.target));
    expect(prRow().textContent).not.toContain("Fix login");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("lets a task session switch the panel between child working copies", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  });
  rows.set(
    "monocode.taskWorkspaces.v1",
    JSON.stringify([
      {
        id: "t1",
        projectId: "p1",
        name: "Ship it",
        sessionIds: ["s1"],
        createdAt: 1,
        children: [
          {
            id: "c1",
            repositoryId: "r1",
            workingCopy: "/repo-a",
            branch: "feat/a",
            sessionIds: [],
            launch: { state: "ready" },
          },
          {
            id: "c2",
            repositoryId: "r2",
            workingCopy: "/repo-b",
            branch: "feat/b",
            sessionIds: [],
            launch: { state: "ready" },
          },
        ],
      },
    ]),
  );
  const { invoke } = await import("@tauri-apps/api/core");
  const original = vi.mocked(invoke).getMockImplementation()!;
  const indexed: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "git_diff_index") {
      const cwd = (args as { cwd: string }).cwd;
      indexed.push(cwd);
      return {
        branch: cwd === "/repo-b" ? "feat/b" : "feat/a",
        ahead: 0,
        behind: 0,
        files: [
          {
            path: `${cwd}/only.ts`,
            relative: cwd === "/repo-b" ? "b-only.ts" : "a-only.ts",
            status: "modified",
            staged: false,
            unstaged: true,
            additions: 1,
            deletions: 0,
          },
        ],
      };
    }
    return original(command, args);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const chip = (name: string) =>
    [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(name),
    );
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo-a",
          sourceSessionId: "s1",
          enabled: true,
          onOpenFile: vi.fn(),
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    // A chip per child; the session's own copy is selected by default.
    expect(chip("repo-a")).toBeTruthy();
    expect(chip("repo-b")).toBeTruthy();
    expect(host.querySelector("header")?.textContent).toContain("feat/a");
    // The sibling child's index is prefetched while the strip is open, so
    // switching swaps to cached content instead of blanking the list.
    expect(indexed).toContain("/repo-b");
    await act(async () => chip("repo-b")!.click());
    expect(host.querySelector("header")?.textContent).toContain("feat/b");
    // The file list shows the selected child's files — never repo A's rows
    // under repo B's chip.
    expect(host.querySelector('button[title="b-only.ts"]')).not.toBeNull();
    expect(host.querySelector('button[title="a-only.ts"]')).toBeNull();
    // Switching back is served from the warm cache too.
    await act(async () => chip("repo-a")!.click());
    expect(host.querySelector("header")?.textContent).toContain("feat/a");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(invoke).mockImplementation(original);
    vi.unstubAllGlobals();
  }
});

it("uses the selector instead of chips for more than two children", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  });
  rows.set(
    "monocode.taskWorkspaces.v1",
    JSON.stringify([
      {
        id: "t1",
        projectId: "p1",
        name: "Ship it",
        sessionIds: ["s1"],
        createdAt: 1,
        children: ["a", "b", "c"].map((name, index) => ({
          id: `c${index + 1}`,
          repositoryId: `r${index + 1}`,
          workingCopy: `/repo-${name}`,
          branch: `feat/${name}`,
          sessionIds: [],
          launch: { state: "ready" },
        })),
      },
    ]),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const selector = () =>
    host.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement | null;
  const menuRow = (name: string) =>
    [...document.querySelectorAll('ul[role="menu"] button')].find((button) =>
      button.textContent?.includes(name),
    );
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo-a",
          sourceSessionId: "s1",
          enabled: true,
          onOpenFile: vi.fn(),
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    // No chip row — a compact selector shows the active child and count.
    expect(selector()?.textContent).toContain("repo-a");
    expect(selector()?.textContent).toContain("3 repos");
    await act(async () => selector()!.click());
    expect(menuRow("repo-c")).toBeTruthy();
    await act(async () => (menuRow("repo-c") as HTMLButtonElement).click());
    expect(host.querySelector("header")?.textContent).toContain("feature");
    expect(selector()?.textContent).toContain("repo-c");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("collapses the child chips into a selector menu when they overflow", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  });
  rows.set(
    "monocode.taskWorkspaces.v1",
    JSON.stringify([
      {
        id: "t1",
        projectId: "p1",
        name: "Ship it",
        sessionIds: ["s1"],
        createdAt: 1,
        children: [
          {
            id: "c1",
            repositoryId: "r1",
            workingCopy: "/repo-a",
            branch: "feat/a",
            sessionIds: [],
            launch: { state: "ready" },
          },
          {
            id: "c2",
            repositoryId: "r2",
            workingCopy: "/repo-b",
            branch: "feat/b",
            sessionIds: [],
            launch: { state: "ready" },
          },
        ],
      },
    ]),
  );
  // A strip narrower than its chips reports scrollWidth > clientWidth.
  const sizeDesc = (name: "scrollWidth" | "clientWidth") =>
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
  const savedScroll = sizeDesc("scrollWidth");
  const savedClient = sizeDesc("clientWidth");
  const restore = (name: "scrollWidth" | "clientWidth", desc?: PropertyDescriptor) => {
    if (desc) Object.defineProperty(HTMLElement.prototype, name, desc);
    else
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
        name
      ];
  };
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return 800;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 120;
    },
  });
  const { invoke } = await import("@tauri-apps/api/core");
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "git_diff_index") {
      const cwd = (args as { cwd: string }).cwd;
      return {
        branch: cwd === "/repo-b" ? "feat/b" : "feat/a",
        ahead: 0,
        behind: 0,
        files: [],
      };
    }
    return original(command, args);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const selector = () =>
    host.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement | null;
  const menuRow = (name: string) =>
    [...document.querySelectorAll('ul[role="menu"] button')].find((button) =>
      button.textContent?.includes(name),
    );
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo-a",
          sourceSessionId: "s1",
          enabled: true,
          onOpenFile: vi.fn(),
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    // The chip row cannot fit — a compact selector shows the active child
    // and the repo count instead of a clipped list.
    expect(selector()?.textContent).toContain("repo-a");
    expect(selector()?.textContent).toContain("2 repos");
    await act(async () => selector()!.click());
    expect(menuRow("repo-a")).toBeTruthy();
    expect(menuRow("repo-b")).toBeTruthy();
    await act(async () => (menuRow("repo-b") as HTMLButtonElement).click());
    expect(host.querySelector("header")?.textContent).toContain("feat/b");
    // The menu closed on selection and the selector follows the new child.
    expect(document.querySelector('ul[role="menu"]')).toBeNull();
    expect(selector()?.textContent).toContain("repo-b");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(invoke).mockImplementation(original);
    restore("scrollWidth", savedScroll);
    restore("clientWidth", savedClient);
    vi.unstubAllGlobals();
  }
});

it("applies an in-flight mutation to the repo it ran on after a child switch", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  });
  rows.set(
    "monocode.taskWorkspaces.v1",
    JSON.stringify([
      {
        id: "t1",
        projectId: "p1",
        name: "Ship it",
        sessionIds: ["s1"],
        createdAt: 1,
        children: [
          {
            id: "c1",
            repositoryId: "r1",
            workingCopy: "/repo-a",
            branch: "feat/a",
            sessionIds: [],
            launch: { state: "ready" },
          },
          {
            id: "c2",
            repositoryId: "r2",
            workingCopy: "/repo-b",
            branch: "feat/b",
            sessionIds: [],
            launch: { state: "ready" },
          },
        ],
      },
    ]),
  );
  const { invoke } = await import("@tauri-apps/api/core");
  const original = vi.mocked(invoke).getMockImplementation()!;
  const stagedAll = new Set<string>();
  let release: (() => void) | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "git_stage_file") {
      const cwd = (args as { cwd: string }).cwd;
      // Hold repo A's mutation open so the child switch lands mid-flight.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      stagedAll.add(cwd);
      return null;
    }
    if (command === "git_diff_index") {
      const cwd = (args as { cwd: string }).cwd;
      return {
        branch: cwd === "/repo-b" ? "feat/b" : "feat/a",
        ahead: 0,
        behind: 0,
        files: [
          {
            path: `${cwd}/only.ts`,
            relative: cwd === "/repo-b" ? "b-only.ts" : "a-only.ts",
            status: "modified",
            staged: stagedAll.has(cwd),
            unstaged: !stagedAll.has(cwd),
            additions: 1,
            deletions: 0,
          },
        ],
      };
    }
    return original(command, args);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const chip = (name: string) =>
    [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(name),
    );
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo-a",
          sourceSessionId: "s1",
          enabled: true,
          onOpenFile: vi.fn(),
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    const stageButton = () =>
      host.querySelector('button[aria-label="Stage Changes"]');
    const unstageButton = () =>
      host.querySelector('button[aria-label="Unstage Changes"]');
    // Start staging repo A, then switch to repo B before it resolves.
    await act(async () => {
      (stageButton() as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => chip("repo-b")!.click());
    expect(host.querySelector("header")?.textContent).toContain("feat/b");
    await act(async () => release?.());
    // Repo B's displayed index is untouched by repo A's mutation.
    expect(host.querySelector('button[title="b-only.ts"]')).not.toBeNull();
    expect(stageButton()).not.toBeNull();
    expect(unstageButton()).toBeNull();
    // Repo A's own cache picked it up — switching back shows it staged.
    await act(async () => chip("repo-a")!.click());
    expect(host.querySelector('button[title="a-only.ts"]')).not.toBeNull();
    expect(unstageButton()).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(invoke).mockImplementation(original);
    vi.unstubAllGlobals();
  }
});

it("routes GitHub rows to the review surface and keeps an Azure CI override independent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value) });
  const { invoke } = await import("@tauri-apps/api/core");
  const { saveDeliveryProvider } = await import("../lib/deliveryProviders");
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "azure_ci_context") return {cwd:"/github",branch:"feature",commit:"head",remotes:[{name:"origin",url:"https://github.com/team/repo"}]};
    if (command === "git_pr_status") return {number:5,title:"Fix",state:"OPEN",url:"https://github.com/team/repo/pull/5"};
    return original(command, args);
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), open = vi.fn();
  const row = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  try {
    await act(async () => root.render(createElement(GitChangesPanel, {cwd:"/github",sourceSessionId:"gh-owner",enabled:true,onOpenDelivery:open,onOpenFile:vi.fn(),onOpenAllChanges:vi.fn(),onOpenCommit:vi.fn()})));
    expect(row("Pull requests").textContent).toContain("GitHub");
    expect(row("CI").textContent).toContain("GitHub");
    await act(async () => row("CI").click());
    expect(open).toHaveBeenCalledWith("/github", {kind:"ci",branch:"feature",sourceSessionId:"gh-owner",provider:"github",repo:"team/repo",number:5});
    open.mockClear();
    await act(async () => saveDeliveryProvider("/github", "feature", "gh-owner", "ci", "azure"));
    expect(row("CI").textContent).toContain("Azure Pipelines");
    expect(row("Pull requests").textContent).toContain("GitHub");
    await act(async () => row("CI").click());
    expect(open).toHaveBeenCalledWith("/github", {kind:"ci",branch:"feature",sourceSessionId:"gh-owner",provider:"azure"});
  } finally { await act(async () => root.unmount()); host.remove(); vi.mocked(invoke).mockImplementation(original); vi.unstubAllGlobals(); }
});

it("offers 'Sync with main' and runs fetch+merge through the shared flow", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { invoke } = await import("@tauri-apps/api/core");
  const original = vi.mocked(invoke).getMockImplementation()!;
  const synced: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "git_diff_index")
      return {
        branch: "feature",
        ahead: 0,
        behind: 0,
        remote: "origin",
        upstream: null,
        defaultBranch: "main",
        files: [],
        opInProgress: false,
        op: "",
        conflicts: [],
        mergeHead: null,
        detached: false,
      };
    if (command === "git_sync_branch") {
      synced.push((args as { cwd: string }).cwd);
      return {
        outcome: "merged",
        branch: "feature",
        syncedWith: "origin/main",
        commits: ["remote work"],
        commitCount: 1,
        conflicts: [],
        reason: "",
      };
    }
    return original(command, args);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(text),
    ) as HTMLButtonElement | undefined;
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo",
          sourceSessionId: "owner",
          enabled: true,
          onOpenFile: vi.fn(),
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    expect(button("Sync with main")).toBeTruthy();
    await act(async () => button("Sync with main")!.click());
    // The shared flow confirmed, then invoked the merge on this exact copy.
    expect(synced).toEqual(["/repo"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(invoke).mockImplementation(original);
    vi.unstubAllGlobals();
  }
});

it("shows merge state with send-to-owning-agent and abort controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { invoke } = await import("@tauri-apps/api/core");
  const original = vi.mocked(invoke).getMockImplementation()!;
  const mergeIndex = {
    branch: "feature",
    ahead: 0,
    behind: 0,
    remote: "origin",
    upstream: null,
    defaultBranch: "main",
    opInProgress: true,
    op: "merge",
    conflicts: ["a.ts"],
    mergeHead: "abc1234",
    detached: false,
    files: [
      {
        path: "/repo/a.ts",
        relative: "a.ts",
        status: "conflicted",
        staged: false,
        unstaged: true,
        additions: 1,
        deletions: 0,
      },
    ],
  };
  const aborted: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    // Fresh object per read — mutating in place would make the cached
    // index compare equal and the banner would never re-render.
    if (command === "git_diff_index") return { ...mergeIndex };
    if (command === "git_merge_context")
      return {
        merging: true,
        op: "merge",
        conflicts: ["a.ts"],
        mergeHead: "abc1234",
        incomingRef: "origin/main",
        diff: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> FETCH_HEAD",
      };
    if (command === "git_merge_abort") {
      aborted.push((args as { cwd: string }).cwd);
      mergeIndex.opInProgress = false;
      mergeIndex.op = "";
      mergeIndex.conflicts = [];
      mergeIndex.mergeHead = null;
      return null;
    }
    return original(command, args);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(text),
    ) as HTMLButtonElement | undefined;
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo",
          sourceSessionId: "owner",
          enabled: true,
          onOpenFile: vi.fn(),
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    // The merge state is a distinct banner, not an ordinary dirty list.
    expect(host.textContent).toContain("Merge in progress");
    expect(host.textContent).toContain("1 conflicted file");
    expect(button("Sync with main")).toBeUndefined();
    vi.mocked(requestAgentContext).mockClear();
    await act(async () => button("Send to owning agent")!.click());
    const request = vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0];
    expect(request?.sourceSessionId).toBe("owner");
    expect(request?.cwd).toBe("/repo");
    expect(request?.context.entries[0].text).toContain("a.ts");
    expect(request?.context.entries[1].text).toContain("<<<<<<< HEAD");
    // Abort goes through an explicit confirm, then clears the banner.
    await act(async () => button("Abort merge")!.click());
    expect(aborted).toEqual(["/repo"]);
    // The abort notifies GIT_CHANGED; the next index read reports no op
    // and the banner clears instead of sticking on a stale snapshot.
    await vi.waitFor(() => {
      expect(host.textContent).not.toContain("Merge in progress");
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(invoke).mockImplementation(original);
    vi.unstubAllGlobals();
  }
});

it("moves a file to the Local Only section and back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { invoke } = await import("@tauri-apps/api/core");
  const original = vi.mocked(invoke).getMockImplementation()!;
  const kept = new Set<string>(["dev.local"]);
  const calls: [string, string][] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "git_keep_local" || command === "git_unkeep_local") {
      const { relative } = args as { relative: string };
      calls.push([command, relative]);
      if (command === "git_keep_local") kept.add(relative);
      else kept.delete(relative);
      return null;
    }
    if (command === "git_diff_index") {
      const file = (relative: string, status: string) => ({
        path: `/repo-keep/${relative}`,
        relative,
        status,
        staged: false,
        unstaged: !kept.has(relative),
        additions: 1,
        deletions: 0,
      });
      const files = ["a.ts", "dev.local"].filter((name) => !kept.has(name));
      return {
        branch: "feature",
        ahead: 0,
        behind: 0,
        files: files.map((name) => file(name, "modified")),
        localOnly: [...kept].map((name) => file(name, "modified")),
      };
    }
    return original(command, args);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const row = (relative: string) =>
    host.querySelector(`button[title="${relative}"]`) as HTMLButtonElement | null;
  const sectionOf = (relative: string) =>
    [...host.querySelectorAll("span.uppercase")].find((title) =>
      title.parentElement?.parentElement?.parentElement?.contains(
        row(relative)!,
      ),
    )?.textContent;
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo-keep",
          sourceSessionId: "owner",
          enabled: true,
          onOpenFile: vi.fn(),
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    // The kept file renders in its own section with only the unkeep action.
    expect(row("dev.local")).not.toBeNull();
    expect(sectionOf("dev.local")).toBe("Local Only");
    expect(
      row("dev.local")!.parentElement!.querySelector(
        'button[aria-label^="Stop keeping local"]',
      ),
    ).not.toBeNull();
    // A normal row offers keep alongside stage/discard.
    const keepButton = row("a.ts")!.parentElement!.querySelector(
      'button[aria-label^="Keep local"]',
    ) as HTMLButtonElement;
    expect(keepButton).not.toBeNull();
    await act(async () => keepButton.click());
    expect(calls).toEqual([["git_keep_local", "a.ts"]]);
    expect(sectionOf("a.ts")).toBe("Local Only");
    // Unkeeping returns the row to the regular changes list.
    const unkeepButton = row("a.ts")!.parentElement!.querySelector(
      'button[aria-label^="Stop keeping local"]',
    ) as HTMLButtonElement;
    await act(async () => unkeepButton.click());
    expect(calls.at(-1)).toEqual(["git_unkeep_local", "a.ts"]);
    await vi.waitFor(() => expect(sectionOf("a.ts")).toBe("Changes"));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(invoke).mockImplementation(original);
    vi.unstubAllGlobals();
  }
});
