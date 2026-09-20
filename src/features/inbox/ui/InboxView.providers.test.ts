// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { InboxDetail } from "./InboxView";
import * as adapters from "../../sessions/model/inboxProvider";
import * as github from "../model/githubTasks";
import { LinkedWorkItemPanel } from "./InboxView";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxItem } from "../model/githubTasks";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => path }));
vi.mock("../../sessions/ui/AgentMarkdown", () => ({ AgentMarkdown: ({ text }: { text: string }) => createElement("p", null, text) }));
it.each(["jira", "azuredevops"] as const)("uses upstream Ask and Send controls with %s identity and the chosen project", async provider => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const jira = provider === "jira";
  const item: InboxItem = { provider, kind: jira ? "jira" : "issue", ...(jira ? { account: "Ada" } : {}), site: jira ? "https://team.atlassian.net" : "https://dev.azure.com/team", id: "42", number: 42, identifier: "ENG-42", title: "Ticket 42", url: "https://example.test/42", projectPath: "", repo: "repo", projectName: "Engineering", state: "In review", updatedAt: "", labels: [], assignees: [], draft: false };
  vi.mocked(invoke).mockImplementation(async (cmd, args) =>
    cmd === "azure_devops_work_item_details" ? { body: "Shared description", author: "Ada" }
      : cmd === "azure_devops_work_item_thread" ? { comments: [], truncated: true, reviewDecision: "", baseRefName: "", headRefName: "" }
        : args?.comments || args?.discussion ? { comments: [], total: 51, more: true }
          : { fields: { description: "Shared description", creator: { displayName: "Ada" } } });
  const host = document.createElement("div");document.body.append(host);const root = createRoot(host);
  const onStart = vi.fn();const onDiscuss = vi.fn();
  try {
    await act(async () => root.render(createElement(InboxDetail, { item, cwd: "/local/project", projects: [{ path: "/local/project", name: "Project", logoPath: null }], revision: 0, relatedSessions: [], onStart, onDiscuss })));
    expect(host.textContent).toContain("Shared description");
    const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
    await act(async () => button("Ask").click());expect(onDiscuss).toHaveBeenCalledOnce();
    await act(async () => button("Send to agent").click());
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ provider, id: "42", site: item.site, projectPath: "/local/project", ...(jira ? { account: "Ada" } : {}) }), jira ? "Shared description" : undefined);
    expect(host.textContent).not.toContain("Send to task");
    expect(host.textContent).toContain(`Latest comments · more on ${jira ? "Jira" : "ADO"}`);
  } finally { await act(async () => root.unmount());host.remove();vi.unstubAllGlobals(); }
});

it.each(["github", "gitlab", "linear"] as const)("preserves %s cached content and Send to agent behavior when refresh fails", async provider => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const item: InboxItem = { provider, kind: provider === "linear" ? "linear" : "issue", id: "42", number: 42, title: "Issue", url: "https://example.test/42", projectPath: "/repo", repo: "org/repo", state: "open", updatedAt: "", labels: [], assignees: [], draft: false };
  const spy = vi.spyOn(adapters, "inboxProvider").mockReturnValue({
    peekDetails: () => ({ body: "Cached description", author: "Ada" }),
    details: async () => { throw new Error("Offline refresh"); },
    peekThread: () => ({ comments: [], commits: [], truncated: false, reviewDecision: "", baseRefName: "", headRefName: "" }),
    thread: async () => { throw new Error("Offline discussion"); },
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); const onStart = vi.fn();
  try {
    await act(async () => root.render(createElement(InboxDetail, { item, cwd: "/repo", projects: [{ path: "/repo", name: "Project", logoPath: null }], revision: 0, relatedSessions: [], onStart })));
    expect(host.textContent).toContain("Cached description");
    expect(host.textContent).not.toContain("Offline refresh");
    expect(host.textContent).not.toContain("Offline discussion");
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Send to agent")!.click());
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ provider }), provider === "linear" ? "Cached description" : undefined);
  } finally { await act(async () => root.unmount()); host.remove(); spy.mockRestore(); vi.unstubAllGlobals(); }
});

it("shows cached GitHub linked items immediately", () => {
  const item: InboxItem = { provider: "github", kind: "issue", number: 42, title: "Cached linked issue", url: "https://github.com/org/repo/issues/42", projectPath: "/repo", repo: "org/repo", state: "open", updatedAt: "", labels: [], assignees: [], draft: false };
  const spy = vi.spyOn(github, "peekGithubWorkItem").mockReturnValue(item);
  try {
    const markup = renderToStaticMarkup(createElement(LinkedWorkItemPanel, { target: { kind: "issue", number: 42, repo: "org/repo", url: item.url }, cwd: "/repo", recents: [], onClose: vi.fn() }));
    expect(markup).toContain("Cached linked issue");
  } finally { spy.mockRestore(); }
});
