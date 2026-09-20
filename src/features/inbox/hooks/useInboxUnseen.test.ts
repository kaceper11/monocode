// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "../model/githubTasks";
import { inboxItemKey } from "../model/githubTasks";
import {
  isInboxEntryUnseen,
  markInboxItemSeen,
  seedInboxSeenIfNeeded,
} from "../model/inboxSeen";
import { updateNotificationPreferences } from "../../notifications/model/notificationPreferences";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { markLinkedSessionUpdateSeen } from "../model/linkedSessionSeen";
import {
  clearPendingInboxSelfActivity,
  recordInboxSelfActivity,
} from "../model/inboxSelfActivity";
import { useInboxActivity, type InboxActivity } from "./useInboxUnseen";

const { githubWorkItem, listInboxItems, listInboxIntegrations, refreshLinkedWorkItem, playCue } =
  vi.hoisted(() => ({
    githubWorkItem: vi.fn(),
    listInboxItems: vi.fn(),
    listInboxIntegrations: vi.fn(),
    refreshLinkedWorkItem: vi.fn(),
    playCue: vi.fn(),
  }));
vi.mock("../model/githubTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model/githubTasks")>()),
  githubWorkItem,
  listInboxItems,
}));
vi.mock("../../sessions/model/inboxIntegrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/model/inboxIntegrations")>()),
  listInboxIntegrations,
}));
vi.mock("../../sessions/model/linkedWorkItemRefresh", () => ({
  refreshLinkedWorkItem,
}));
vi.mock("../../settings/model/sounds", () => ({ playCue }));

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
let cwd = "/tmp/app";

function Harness() {
  activity = useInboxActivity(recents, cwd, sessions);
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
  cwd = "/tmp/app";
  listInboxItems.mockReset();
  listInboxIntegrations.mockReset();
  listInboxIntegrations.mockResolvedValue({ items: [], errors: {} });
  githubWorkItem.mockReset();
  refreshLinkedWorkItem.mockReset();
  refreshLinkedWorkItem.mockImplementation(async (_cwd, linked) =>
    githubWorkItem("/tmp/app", linked.repo, linked.kind, linked.number),
  );
  playCue.mockReset();
  clearPendingInboxSelfActivity();
  sessions = [session];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearPendingInboxSelfActivity();
});

describe("Inbox activity polling", () => {
  it("does not poll upstream providers without a rail project", async () => {
    cwd = "";
    listInboxItems.mockResolvedValue({ items: [], errors: {} });
    await mount();
    expect(listInboxIntegrations).toHaveBeenCalledOnce();
    expect(listInboxItems).not.toHaveBeenCalled();
    expect(refreshLinkedWorkItem).not.toHaveBeenCalled();
  });

  it("does not bind a legacy link to listed accounts as the connection changes", async () => {
    vi.useFakeTimers();
    const linked = {
      provider: "jira" as const, kind: "issue" as const, repo: "", number: 123,
      url: "https://acme.atlassian.net/browse/PROJ-123",
    };
    sessions = [{ ...session, linkedWorkItem: linked }];
    let row: InboxItem = { ...remote, ...linked, kind: "jira", account: "account-a" };
    listInboxItems.mockImplementation(async () => ({ items: [row], errors: {} }));
    await mount();
    expect(activity.linkedSessionUpdates.has(session.id)).toBe(false);
    expect(refreshLinkedWorkItem).not.toHaveBeenCalled();
    row = { ...row, account: "account-b" };
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(activity.linkedSessionUpdates.has(session.id)).toBe(false);
    expect(refreshLinkedWorkItem).not.toHaveBeenCalled();
  });

  it("updates Inbox and linked-session indicators on category changes without consuming unread activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    const entry = { key: inboxItemKey(remote), updatedAt: remote.updatedAt };
    seedInboxSeenIfNeeded([{ ...entry, updatedAt: "2026-09-12T12:00:00Z" }]);
    listInboxItems.mockResolvedValue({ items: [remote], errors: {} });
    await mount();
    expect(activity.unseen).toBe(true);
    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(true);

    act(() =>
      updateNotificationPreferences(["local:/tmp/app"], {
        disabled: ["pullRequests"],
      }),
    );
    expect(activity.unseen).toBe(false);
    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(false);
    expect(activity.linkedSessionUpdates.has(session.id)).toBe(true);
    expect(isInboxEntryUnseen(entry)).toBe(true);

    act(() =>
      updateNotificationPreferences(["local:/tmp/app"], {
        disabled: [],
        mutedUntil: Date.now() + 1000,
      }),
    );
    expect(activity.unseen).toBe(false);
    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(activity.unseen).toBe(true);
    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(true);
    expect(isInboxEntryUnseen(entry)).toBe(true);
  });

  it("updates the dot immediately on mute, resume, and mute expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    const entry = { key: inboxItemKey(remote), updatedAt: remote.updatedAt };
    seedInboxSeenIfNeeded([{ ...entry, updatedAt: "2026-09-12T12:00:00Z" }]);
    listInboxItems.mockResolvedValue({ items: [remote], errors: {} });
    await mount();
    expect(activity.unseen).toBe(true);

    act(() =>
      updateNotificationPreferences(["local:/tmp/app"], {
        mutedUntil: null,
      }),
    );
    expect(activity.unseen).toBe(false);
    expect(isInboxEntryUnseen(entry)).toBe(true);
    act(() =>
      updateNotificationPreferences(["local:/tmp/app"], {
        mutedUntil: undefined,
      }),
    );
    expect(activity.unseen).toBe(true);
    act(() =>
      updateNotificationPreferences(["local:/tmp/app"], {
        mutedUntil: Date.now() + 1000,
      }),
    );
    expect(activity.unseen).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(activity.unseen).toBe(true);
    act(() => markInboxItemSeen(entry));
    expect(activity.unseen).toBe(false);
  });

  it("badges only unmuted projects while muted activity stays unread", async () => {
    const other: InboxItem = {
      ...remote,
      repo: "acme/other",
      url: "https://github.com/acme/other/pull/42",
      projectPath: "/tmp/other",
    };
    const mutedEntry = {
      key: inboxItemKey(remote),
      updatedAt: remote.updatedAt,
    };
    const otherEntry = { key: inboxItemKey(other), updatedAt: other.updatedAt };
    seedInboxSeenIfNeeded([
      { ...mutedEntry, updatedAt: "2026-09-12T12:00:00Z" },
      { ...otherEntry, updatedAt: "2026-09-12T12:00:00Z" },
    ]);
    updateNotificationPreferences(["local:/tmp/app"], {
      mutedUntil: null,
    });
    listInboxItems.mockResolvedValue({ items: [remote, other], errors: {} });
    await mount();

    expect(activity.unseen).toBe(true);
    act(() => markInboxItemSeen(otherEntry));
    expect(activity.unseen).toBe(false);
    expect(isInboxEntryUnseen(mutedEntry)).toBe(true);
    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(false);
    expect(activity.linkedSessionUpdates.has(session.id)).toBe(true);
  });

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

  it("does not activate fork-only GitLab link polling for retained legacy records", async () => {
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

    expect(activity.linkedSessionUpdateIds.has("gitlab-session")).toBe(false);
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
      account: "jira-account",
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
      account: jiraLinked.account,
    });
    await mount();

    expect(refreshLinkedWorkItem).toHaveBeenCalledWith("/tmp/app", jiraLinked);
    expect(activity.linkedSessionUpdateIds.has("jira-session")).toBe(true);
  });

  it("always refreshes Azure DevOps PRs directly — listing stamps miss comments", async () => {
    const azureUrl =
      "https://dev.azure.com/org/project-id/_git/repo-id/pullrequest/7";
    // Fork-era sessions persisted the provider as "azure".
    const azureLinked = {
      provider: "azure" as unknown as "azuredevops",
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
          provider: "azuredevops",
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
      provider: "azuredevops",
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

  it("acknowledges an app-authored revision without a cue or linked-session notification", async () => {
    let listed = { ...remote, updatedAt: "2026-09-13T11:00:00Z" };
    listInboxItems.mockImplementation(async () => ({
      items: [listed],
      errors: {},
    }));
    markLinkedSessionUpdateSeen(session.id, Date.parse(listed.updatedAt));
    await mount();
    expect(activity.unseen).toBe(false);
    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(false);

    listed = { ...listed, updatedAt: "2026-09-13T12:05:00Z" };
    await act(async () => {
      recordInboxSelfActivity({
        provider: "github",
        kind: "pr",
        repo: listed.repo,
        number: listed.number,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const entry = { key: inboxItemKey(listed), updatedAt: listed.updatedAt };
    expect(listInboxItems).toHaveBeenCalledTimes(2);
    expect(playCue).not.toHaveBeenCalled();
    expect(isInboxEntryUnseen(entry)).toBe(false);
    expect(activity.unseen).toBe(false);
    expect(activity.linkedSessionUpdateIds.has(session.id)).toBe(false);
  });
});
