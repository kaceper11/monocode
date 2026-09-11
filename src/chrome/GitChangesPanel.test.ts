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
    expect(open).toHaveBeenLastCalledWith("/repo", { kind: "pr", branch: "feature", sourceSessionId: "owner" });
    const target = { site: "https://dev.azure.com/team", accountId: "ada", project: "project", definition: 7, repositoryId: "team/repo", repositoryType: "GitHub", repositoryUrl: "https://github.com/team/repo" };
    await act(async () => saveCiSources([{ target, cwd: "/repo", branch: "feature", session: "owner", remote: target.repositoryUrl, definitionName: "Unit tests", projectName: "Project" }], "/repo", "feature", "owner"));
    expect(ciRow().textContent).toContain("Unit tests");
    await act(async () => saveAzurePrAssociation(null, "/repo", "feature", "owner", association.target));
    expect(prRow().textContent).not.toContain("Fix login");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("routes GitHub rows externally and keeps an Azure CI override independent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value) });
  const { invoke } = await import("@tauri-apps/api/core");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
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
    expect(openUrl).toHaveBeenCalledWith("https://github.com/team/repo/pull/5/checks");
    expect(open).not.toHaveBeenCalled();
    await act(async () => saveDeliveryProvider("/github", "feature", "gh-owner", "ci", "azure"));
    expect(row("CI").textContent).toContain("Azure Pipelines");
    expect(row("Pull requests").textContent).toContain("GitHub");
    await act(async () => row("CI").click());
    expect(open).toHaveBeenCalledWith("/github", {kind:"ci",branch:"feature",sourceSessionId:"gh-owner"});
  } finally { await act(async () => root.unmount()); host.remove(); vi.mocked(invoke).mockImplementation(original); vi.unstubAllGlobals(); }
});
