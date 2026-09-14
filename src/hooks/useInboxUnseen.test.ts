// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "../lib/githubTasks";
import type { SessionSummary } from "../lib/sessionStore";
import { markLinkedSessionUpdateSeen } from "../lib/linkedSessionSeen";
import { useInboxActivity, type InboxActivity } from "./useInboxUnseen";

const { githubWorkItem, listInboxItems, refreshLinkedWorkItem } = vi.hoisted(
  () => ({
    githubWorkItem: vi.fn(),
    listInboxItems: vi.fn(),
    refreshLinkedWorkItem: vi.fn(),
  }),
);
vi.mock("../lib/githubTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/githubTasks")>()),
  githubWorkItem,
  listInboxItems,
}));
vi.mock("../lib/linkedWorkItemRefresh", () => ({
  refreshLinkedWorkItem,
}));
vi.mock("../lib/sounds", () => ({ noteInboxUnseen: vi.fn() }));

const remote: InboxItem = {
  provider: "github",
  kind: "pr",
  repo: "acme/app",
  number: 42,
  title: "Update sidebar activity",
  url: "https://github.com/acme/app/pull/42",
  state: "open",
  updatedAt: "2026-09-13T12:00:00Z",
  labels: [],
  assignees: [],
  draft: false,
  projectPath: "/tmp/app",
};
const session: SessionSummary = {
  id: "linked-session",
  cwd: "/tmp/app",
  harness: "codex",
  model: "gpt-5",
  runtimeMode: "supervised",
  title: "codex · Update sidebar activity",
  createdAt: Date.parse("2026-09-13T10:00:00Z"),
  updatedAt: Date.parse("2026-09-13T10:00:00Z"),
  linkedWorkItem: {
    kind: "pr",
    repo: "acme/app",
    number: 42,
    url: remote.url,
  },
};

let root: Root;
let container: HTMLDivElement;
let activity: InboxActivity;
const recents = [];
let sessions = [session];

function Harness() {
  activity = useInboxActivity(recents, "/tmp/app", sessions);
  return null;
}

async function mount() {
  await act(async () => {
    root.render(createElement(Harness));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  listInboxItems.mockReset();
  githubWorkItem.mockReset();
  refreshLinkedWorkItem.mockReset();
  refreshLinkedWorkItem.mockImplementation(async (_cwd, linked) =>
    githubWorkItem("/tmp/app", linked.repo, linked.kind, linked.number),
  );
  sessions = [session];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Inbox activity polling", () => {
  it("reuses the Inbox list for linked-session updates", async () => {
    listInboxItems.mockResolvedValue({ items: [remote], errors: {} });
    await mount();

    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(true);
    expect(listInboxItems).toHaveBeenCalledTimes(1);
    expect(githubWorkItem).not.toHaveBeenCalled();
  });

  it("falls back to an exact lookup only when the Inbox omits the item", async () => {
    listInboxItems.mockResolvedValue({ items: [], errors: {} });
    githubWorkItem.mockResolvedValue(remote);
    await mount();

    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(true);
    expect(listInboxItems).toHaveBeenCalledTimes(1);
    expect(refreshLinkedWorkItem).toHaveBeenCalledExactlyOnceWith(
      "/tmp/app",
      session.linkedWorkItem,
    );
  });

  it("matches linked GitLab items from the shared Inbox listing", async () => {
    const gitlabItem: InboxItem = {
      ...remote,
      provider: "gitlab",
      url: "https://gitlab.example.com/acme/app/-/merge_requests/42",
    };
    sessions = [
      {
        ...session,
        id: "gitlab-session",
        linkedWorkItem: {
          provider: "gitlab",
          kind: "pr",
          repo: "acme/app",
          number: 42,
          url: gitlabItem.url,
        },
      },
    ];
    listInboxItems.mockResolvedValue({ items: [gitlabItem], errors: {} });
    await mount();

    expect(activity.linkedSessionUpdateIds.has("gitlab-session")).toBe(true);
    expect(refreshLinkedWorkItem).not.toHaveBeenCalled();
  });

  it("falls back to a provider refresh for linked items outside the listing", async () => {
    const jiraLinked = {
      provider: "jira" as const,
      kind: "issue" as const,
      repo: "",
      number: 123,
      url: "https://acme.atlassian.net/browse/PROJ-123",
      identifier: "PROJ-123",
      site: "https://acme.atlassian.net",
      id: "10042",
    };
    sessions = [
      { ...session, id: "jira-session", linkedWorkItem: jiraLinked },
    ];
    listInboxItems.mockResolvedValue({ items: [], errors: {} });
    refreshLinkedWorkItem.mockResolvedValue({
      ...remote,
      provider: "jira",
      kind: "jira",
      url: jiraLinked.url,
      identifier: "PROJ-123",
      id: "10042",
      site: jiraLinked.site,
    });
    await mount();

    expect(refreshLinkedWorkItem).toHaveBeenCalledWith("/tmp/app", jiraLinked);
    expect(activity.linkedSessionUpdateIds.has("jira-session")).toBe(true);
  });

  it("always refreshes Azure PRs directly — listing stamps miss comments", async () => {
    const azureUrl =
      "https://dev.azure.com/org/project-id/_git/repo-id/pullrequest/7";
    const azureLinked = {
      provider: "azure" as const,
      kind: "pr" as const,
      repo: "repo",
      number: 7,
      url: azureUrl,
      site: "https://dev.azure.com/org",
      id: "7",
    };
    sessions = [
      { ...session, id: "azure-session", linkedWorkItem: azureLinked },
    ];
    // The delivery row lists the PR but stamps only creation/close dates.
    listInboxItems.mockResolvedValue({
      items: [
        {
          ...remote,
          provider: "azure",
          kind: "pr",
          number: 7,
          url: azureUrl,
          site: azureLinked.site,
          updatedAt: "2026-09-13T09:00:00Z",
        },
      ],
      errors: {},
    });
    refreshLinkedWorkItem.mockResolvedValue({
      ...remote,
      provider: "azure",
      kind: "pr",
      number: 7,
      url: azureUrl,
      site: azureLinked.site,
    });
    await mount();

    expect(refreshLinkedWorkItem).toHaveBeenCalledWith("/tmp/app", azureLinked);
    expect(activity.linkedSessionUpdateIds.has("azure-session")).toBe(true);
  });

  it("clears a linked-session update as soon as its remote snapshot is read", async () => {
    listInboxItems.mockResolvedValue({ items: [remote], errors: {} });
    await mount();
    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(true);

    act(() => {
      markLinkedSessionUpdateSeen(session.id, Date.parse(remote.updatedAt));
    });

    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(false);
  });

  it("re-pulls with the new project's repositories when the store changes", async () => {
    const { addRepositoryToProject, createProjectGroup } = await import(
      "../lib/projects"
    );
    listInboxItems.mockResolvedValue({ items: [], errors: {} });
    await mount();
    expect(listInboxItems).toHaveBeenLastCalledWith(
      [{ path: "/tmp/app" }],
      expect.anything(),
      expect.anything(),
    );

    await act(async () => {
      const group = createProjectGroup("Suite");
      addRepositoryToProject(group.id, {
        commonDir: "/tmp/api/.git",
        anchor: "/tmp/api",
      });
    });

    expect(listInboxItems).toHaveBeenLastCalledWith(
      [{ path: "/tmp/app" }, { path: "/tmp/api" }],
      expect.anything(),
      expect.anything(),
    );
  });
});
