// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { InboxView } from "./InboxView";
import { clearInboxCache } from "../lib/githubTasks";
import { loadInboxSource, loadVisibleInboxSources } from "../lib/inboxFilters";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock("./AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => createElement("p", null, text),
}));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));

it("retains the selected Jira ticket and explicit project through handoff and refresh failures", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>([["monocode.inboxSource", "jira"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  let failRefresh = false;
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "inbox_context_document")
      return {
        owner: "jira:team:Ada",
        description: "Loaded description",
        comments: [],
        files: [],
        more: false,
        adf: false,
      };
    if (cmd === "jira_status")
      return {
        connected: true,
        site: "https://team.atlassian.net",
        account: "Ada",
      };
    if (cmd === "git_github_status") return { installed: true, connected: true };
    if (cmd.endsWith("_status")) return { connected: false };
    if (cmd === "jira_list_issues") {
      if (failRefresh) throw new Error("Jira permission error");
      return {
        site: "https://team.atlassian.net",
        issues: [42, 41].map((number) => ({
          id: String(number),
          key: `ENG-${number}`,
          fields: {
            summary: `Ticket ${number}`,
            status: {
              name: "In review",
              statusCategory: { key: "indeterminate" },
            },
            project: { id: "1", name: "Engineering" },
            updated: "2026-09-10T10:00:00Z",
          },
        })),
      };
    }
    if (cmd === "jira_issue_content")
      return {
        fields: {
          description: "Loaded description",
          creator: { displayName: "Ada" },
        },
        comments: [],
        total: 0,
      };
    if (cmd === "git_github_repo") return "";
    return [];
  });
  clearInboxCache();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onStartTask = vi.fn().mockRejectedValue(new Error("Handoff failed"));
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === text,
    )!;
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
    });
  };
  try {
    await act(async () => {
      root.render(
        createElement(InboxView, {
          cwd: "/local/project",
          recents: [],
          onAsk: async () => "",
          onAskRestart: async () => "",
          onAskMount: () => {},
          onStartTask,
        }),
      );
    });
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    await click(
      container.querySelector(
        '[aria-label="In review issue ENG-41: Ticket 41"]',
      )!,
    );
    await click(button("Send to agent"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onStartTask).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: "ENG-41",
        site: "https://team.atlassian.net",
        projectPath: "/local/project",
        repo: "",
      }),
      null,
    );
    expect(document.body.textContent).toContain("Handoff failed");
    await click(button("GitHub"));
    await click(button("Jira"));
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 41");
    failRefresh = true;
    await click(container.querySelector('[aria-label="Refresh"]')!);
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 41");
    expect(container.textContent).toContain("Jira permission error");
    await click(button("Retry"));
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 41");
    expect(container.querySelector("textarea")).toBeNull();
    await click(container.querySelector('button[aria-label="Filter inbox"]')!);
    const sourceChoice = (name: string) =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemcheckbox"]',
        ),
      ].find((element) => element.textContent?.trim() === name)!;
    await click(sourceChoice("GitLab"));
    await click(sourceChoice("Linear"));
    await click(sourceChoice("Azure"));
    expect(
      [...container.querySelectorAll('[role="tab"]')].map(
        (element) => element.textContent,
      ),
    ).toEqual(["GitHub", "Jira"]);
    expect(loadVisibleInboxSources()).toEqual(["github", "jira"]);
    await click(sourceChoice("Jira"));
    expect(loadInboxSource()).toBe("github");
    expect(sourceChoice("GitHub").disabled).toBe(true);
    await click(sourceChoice("Jira"));
    expect(loadVisibleInboxSources()).toEqual(["github", "jira"]);
    stored.set("monocode.inboxVisibleSources", "[]");
    expect(loadVisibleInboxSources()).toHaveLength(5);
    stored.set("monocode.inboxVisibleSources", '["jira", "unknown", "jira"]');
    expect(loadVisibleInboxSources()).toEqual(["jira"]);
    expect(loadInboxSource()).toBe("jira");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
