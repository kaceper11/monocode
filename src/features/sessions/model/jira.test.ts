// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  jiraIssue,
  jiraOptions,
  jiraMarkdown,
  loadJiraFilter,
  saveJiraFilter,
  jiraDetails,
  peekJiraDetails,
  saveJiraConfig,
} from "./jira";
import {
  clearInboxCache,
  dedupeInboxItems,
  inboxComposerCard,
  inboxItemKey,
  inboxItemStatus,
  listInboxItems,
} from "../../inbox/model/githubTasks.ts";
import { applyInboxFilters, DEFAULT_INBOX_FILTERS } from "../../inbox/model/inboxFilters.ts";
import { inboxAskKey } from "../../inbox/model/inboxAsk.ts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const call = vi.mocked(invoke);
const issue = {
  id: "101",
  key: "ENG-42",
  fields: {
    summary: "Fix checkout",
    status: { name: "Ready for deployment", statusCategory: { key: "done" } },
    project: { id: "12", name: "Engineering" },
    updated: "2026-09-10T10:00:00Z",
  },
};
const item = jiraIssue("https://team.atlassian.net", issue);
beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  clearInboxCache();
  call.mockReset();
});

it("keeps site/project identity and actual statuses without inventing a code host", () => {
  const otherSite = jiraIssue("https://other.atlassian.net", issue);
  const otherProject = jiraIssue(item.site!, { ...issue, key: "OPS-42" });
  expect(dedupeInboxItems([item, otherSite, otherProject])).toHaveLength(3);
  const github = {
    ...item,
    provider: "github" as const,
    kind: "issue" as const,
    repo: "same/project",
  };
  expect(
    dedupeInboxItems([github, { ...github, provider: "gitlab" }]),
  ).toHaveLength(2);
  expect(inboxItemKey(item)).not.toBe(inboxItemKey(otherSite));
  expect(inboxAskKey(item)).not.toBe(inboxAskKey(otherSite));
  expect(item.repo).toBe("");
  expect(item.projectPath).toBe("");
  expect(item.state).toBe("Ready for deployment");
  expect(inboxItemStatus(item)).toBe("Closed");
  const filtered = applyInboxFilters(
    [item],
    {
      ...DEFAULT_INBOX_FILTERS,
      hiddenKinds: ["issue"],
      status: { open: false, closed: true, draft: false, merged: false },
    },
    "Engineering",
    Date.now(),
    "jira",
  );
  expect(filtered).toEqual([item]);
  const card = inboxComposerCard(item, "Description");
  for (const text of [
    item.site!,
    "Engineering",
    "ENG-42",
    item.url,
    "Description",
    "untrusted reference data",
  ])
    expect(card.prompt).toContain(text);
});

it("keeps jira Inbox selection and deduplication account-scoped", () => {
  const first = { ...item, provider: "jira" as const, account: "account-a" };
  const second = { ...first, account: "account-b" };
  expect(inboxItemKey(first)).not.toBe(inboxItemKey(second));
  expect(inboxAskKey(first)).not.toBe(inboxAskKey(second));
  expect(dedupeInboxItems([first, second])).toHaveLength(2);
});

it.each([
  ["jira", undefined], ["jira", "future"],
] as const)("keeps unknown %s states unknown (%s)", (kind, stateType) => {
  expect(inboxItemStatus({ ...item, kind, state: "unknown", stateType })).toBe("Unknown");
});

it("remembers favorite filters only for their site and defaults to assigned", () => {
  expect(loadJiraFilter(item.site!).assigned).toBe(true);
  saveJiraFilter(item.site!, { project: "12", filter: "34", assigned: false });
  expect(loadJiraFilter(item.site!)).toEqual({
    project: "12",
    filter: "34",
    assigned: false,
  });
  expect(loadJiraFilter("https://other.atlassian.net")).toEqual({
    project: "",
    filter: "",
    assigned: true,
  });
});

it("renders bounded ADF with readable unknown content and safe links", () => {
  const content = jiraMarkdown({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Summary" }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Important", marks: [{ type: "strong" }] },
          {
            type: "text",
            text: "link",
            marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
          },
        ],
      },
      {
        type: "futureBlock",
        content: [{ type: "text", text: "Still readable" }],
      },
      { type: "media", attrs: { id: "private-attachment" } },
    ],
  });
  expect(content).toContain("## Summary");
  expect(content).toContain("**Important**");
  expect(content).toContain("Still readable");
  expect(content).not.toContain("javascript:");
  expect(content).not.toContain("private-attachment");
  expect(jiraMarkdown("x".repeat(70_000))).toContain("Truncated");
  expect(
    jiraMarkdown({
      type: "orderedList",
      attrs: { order: 2 },
      content: [
        { type: "listItem", content: [{ type: "text", text: "Check" }] },
      ],
    }),
  ).toBe("2. Check");
  expect(jiraMarkdown({ type: "text", text: "x".repeat(70_000) })).toContain(
    "Truncated",
  );
});

it("does not request Jira when disconnected and isolates connection errors", async () => {
  call.mockImplementation(async (cmd) => {
    if (cmd === "linear_status") throw new Error("Linear unavailable");
    if (cmd === "gitlab_status" || cmd === "jira_status")
      return { connected: false };
    throw new Error(`Unexpected ${cmd}`);
  });
  const result = await listInboxItems([], {
    assignedToMe: false,
    state: "all",
    search: "",
  });
  expect(result.errors.linear).toBe("Linear unavailable");
  expect(result.errors.jira).toContain("Connect Jira");
  expect(call.mock.calls.some(([cmd]) => cmd === "jira_list_issues")).toBe(
    false,
  );
});

it("passes the selected saved filter and preserves other providers on Jira failure", async () => {
  saveJiraFilter(item.site!, { project: "12", filter: "34", assigned: false });
  call.mockImplementation(async (cmd) => {
    if (cmd === "linear_status" || cmd === "gitlab_status")
      return { connected: false };
    if (cmd === "jira_status")
      return { connected: true, site: item.site, account: "Ada", accountId: "email:ada@example.test" };
    if (cmd === "jira_list_issues") throw new Error("Jira denied access");
    throw new Error(`Unexpected ${cmd}`);
  });
  const result = await listInboxItems([], {
    assignedToMe: true,
    state: "all",
    search: "",
  });
  // The saved filter's project/filter ids pass through, but an
  // assigned-only query forces `assigned` — a wider saved filter must not
  // leak unassigned tickets into it (e.g. the board).
  expect(call).toHaveBeenCalledWith("jira_list_issues", {
    site: item.site,
    accountId: "email:ada@example.test",
    project: "12",
    filter: "34",
    assigned: true,
    state: "all",
  });
  expect(result.errors.jira).toBe("Jira denied access");
});

it("drops old detail results after disconnect instead of refilling the cache", async () => {
  let finish!: (value: unknown) => void;
  call.mockImplementation(async (cmd) => {
    if (cmd === "jira_issue_content")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return { connected: false, site: "", account: "" };
  });
  const pending = jiraDetails(item);
  await saveJiraConfig("", "", "");
  finish({ fields: { description: "Old private description" } });
  await expect(pending).rejects.toThrow("connection changed");
  expect(peekJiraDetails(item)).toBeNull();
});

it("separates detail caches and reads by the credential account", async () => {
  call.mockResolvedValue({ fields: { description: "Private issue" } });
  const owned = { ...item, account: "email:ada@example.test" };
  await jiraDetails(owned);
  expect(call).toHaveBeenLastCalledWith("jira_issue_content", { site: owned.site, id: owned.id, accountId: owned.account, comments: false });
  expect(peekJiraDetails(owned)).not.toBeNull();
  expect(peekJiraDetails({ ...owned, account: "email:other@example.test" })).toBeNull();
});


it("binds Jira filter options to the selected account", async () => {
  call.mockResolvedValue([]);
  await jiraOptions("https://team.atlassian.net", false, "email:ada@example.test");
  expect(call).toHaveBeenLastCalledWith("jira_options", {
    site: "https://team.atlassian.net", favorites: false, accountId: "email:ada@example.test",
  });
});
