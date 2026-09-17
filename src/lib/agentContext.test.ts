// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  linkTicketContext,
  removeContextItem,
  boundAgentContext,
  composeAgentContext,
  contextFromChanges,
  contextFromText,
  contextFromTickets,
  contextFromTicketDescriptions,
  MAX_CONTEXT_TEXT,
  prepareSessionContext,
} from "./agentContext";
import type { InboxItem } from "./githubTasks";
import { isBlankSession, type Session } from "./session";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const session = {
  id: "recipient",
  harness: "codex",
  cwd: "/other",
  busy: true,
} as Session;
const ticket = {
  provider: "jira",
  account: "alice",
  site: "https://team.atlassian.net",
  id: "1",
  number: 1,
  identifier: "ENG-1",
  title: "Ticket",
  url: "https://team.atlassian.net/browse/ENG-1",
  state: "Open",
  repo: "ENG",
  labels: [],
} as unknown as InboxItem;

describe("selected context preparation", () => {
  it("does not replace or retarget a conversation with prepared context", () => {
    const empty = { ...session, busy: false, blocks: [] };
    expect(isBlankSession(empty)).toBe(true);
    expect(
      isBlankSession(
        prepareSessionContext(
          empty,
          contextFromText("File", "Contents", "/source"),
        ),
      ),
    ).toBe(false);
    expect(
      isBlankSession({
        ...empty,
        inboxCard: contextFromTickets([ticket]).entries[0].ticket,
      }),
    ).toBe(false);
  });
  it("bounds text visibly and preserves every ticket's identity even after exhaustion", () => {
    const context = contextFromTickets([
      ticket,
      { ...ticket, account: "bob" },
      { ...ticket, provider: "azure" },
    ]);
    expect(new Set(context.entries.map((entry) => entry.id)).size).toBe(3);
    const bounded = boundAgentContext({
      ...context,
      entries: context.entries.map((entry) => ({
        ...entry,
        text: "x".repeat(MAX_CONTEXT_TEXT),
      })),
    });
    expect(bounded.entries.map((entry) => entry.text).join("").length).toBeLessThanOrEqual(
      MAX_CONTEXT_TEXT,
    );
    expect(bounded.entries[1].truncated).toBe(true);
    expect(bounded.entries[1].origin).toContain("bob");
    expect(composeAgentContext(bounded, "Review")).toContain(
      "untrusted context",
    );
    expect(composeAgentContext(bounded, "Review")).toContain(
      "Context truncated to the selected-context limit",
    );
  });

  it("prepares for the exact busy recipient without sending, queuing or altering its links", () => {
    const original = {
      ...session,
      linkedWorkItem: {
        kind: "issue" as const,
        repo: "other/repo",
        number: 7,
        url: "https://github.com/other/repo/issues/7",
      },
    };
    const context = contextFromText(
      "Selected response",
      "Only this passage",
      "source-session /source/worktree message-4",
    );
    const next = prepareSessionContext(original, context);
    expect(next.id).toBe("recipient");
    expect(next.busy).toBe(true);
    expect(next.linkedWorkItem).toBe(original.linkedWorkItem);
    expect(next.queuedMessages).toBeUndefined();
    expect(original.contextDraft).toBeUndefined();
    expect(prepareSessionContext(next, context)).toBe(next);
    expect(() =>
      prepareSessionContext(
        next,
        contextFromText("Other", "Other", "Elsewhere"),
      ),
    ).toThrow("already has prepared context");
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("appends an explicitly selected hunk to owning-session context without duplication", () => {
    const files = contextFromText("a.ts", "Before / after", "/repo");
    const comment = contextFromText("a.ts:5", "Review this line", "/repo");
    const next = prepareSessionContext(
      prepareSessionContext(session, files),
      comment,
      true,
    );
    expect(next.contextDraft?.entries).toHaveLength(2);
    expect(prepareSessionContext(next, comment, true)).toBe(next);
    const refreshed = {
      ...comment,
      id: "new-capture",
      entries: [{ ...comment.entries[0], text: "Updated selection" }],
    };
    const updated = prepareSessionContext(next, refreshed, true);
    expect(updated.contextDraft?.entries).toHaveLength(2);
    expect(updated.contextDraft?.entries[1].text).toBe("Updated selection");
  });

  it("rejects oversized bundles and unsupported image recipients without losing the draft", () => {
    const context = contextFromText("Image", "Screenshot", "source");
    context.attachments = [
      {
        id: "image",
        kind: "image",
        mimeType: "image/png",
        name: "image.png",
        size: 10,
        data: "aW1hZ2U=",
      },
    ];
    expect(() =>
      prepareSessionContext({ ...session, harness: "fx" }, context),
    ).toThrow("does not support attachments");
    expect(() =>
      boundAgentContext({
        ...context,
        attachments: Array(21).fill(context.attachments[0]),
      }),
    ).toThrow("20 files");
    expect(() =>
      boundAgentContext({
        ...context,
        entries: Array(21).fill(context.entries[0]),
      }),
    ).toThrow("20 items");
  });

  it("captures the selected diff kind and retains deleted-file snapshots", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      status: "deleted",
      original: "old content",
      current: "",
      binary: false,
      tooLarge: false,
    });
    const context = await contextFromChanges("/source", [
      { relative: "a.ts", kind: "staged" },
    ]);
    expect(invoke).toHaveBeenLastCalledWith("git_file_diff", {
      cwd: "/source",
      relative: "a.ts",
      staged: true,
    });
    expect(context.entries[0].origin).toContain("staged · deleted");
    expect(context.entries[0].text).toContain("old content");
    vi.mocked(invoke).mockResolvedValueOnce({ binary: true });
    await expect(
      contextFromChanges("/source", [{ relative: "a.bin", kind: "unstaged" }]),
    ).rejects.toThrow("binary or oversized");
  });
});

it("links multiple tickets and stages their context without sending a prompt", () => {
  const context = contextFromTickets([
    ticket,
    {
      ...ticket,
      id: "2",
      number: 2,
      url: "https://team.atlassian.net/browse/ENG-2",
      identifier: "ENG-2",
    },
  ]);
  const linked = linkTicketContext(session, context);
  expect(linked.linkedWorkItem?.url).toBe(ticket.url);
  expect(linked.linkedWorkItem?.additionalItems).toHaveLength(1);
  expect(
    linkTicketContext(linked, context).linkedWorkItem?.additionalItems,
  ).toHaveLength(1);
  expect(linked.contextDraft?.entries).toHaveLength(2);
  expect(composeAgentContext(linked.contextDraft, "Implement both")).toContain("ENG-2");
  expect(linked.inboxCard).toBeUndefined();
  expect(linked.composerSeed).toBeUndefined();
});


it("includes every selected issue description in the next agent message", async () => {
  const items = [1, 2].map(number => ({ ...ticket, provider: "github", kind: "issue", projectPath: "/source", repo: "team/repo", number, title: `Issue ${number}`, url: `https://github.com/team/repo/issues/${number}` }) as InboxItem);
  vi.mocked(invoke).mockImplementation(async (_command, args) => ({ body: `Acceptance for issue ${(args as { number: number }).number}`, author: "author" }));
  const context = await contextFromTicketDescriptions(items);
  const prepared = linkTicketContext(session, context);
  const message = composeAgentContext(prepared.contextDraft, "Implement both");
  for (const number of [1, 2]) {
    expect(message).toContain(`Issue ${number}`);
    expect(message).toContain(`https://github.com/team/repo/issues/${number}`);
    expect(message).toContain(`Acceptance for issue ${number}`);
    expect(invoke).toHaveBeenCalledWith("git_github_work_item_details", { cwd: "/source", repo: "team/repo", kind: "issue", number });
  }
  expect(message).toContain("untrusted context");
  const remaining = removeContextItem(context, context.entries[0].id)!;
  expect(remaining.entries).toHaveLength(1);
  expect(composeAgentContext(remaining, "Implement")).not.toContain("Acceptance for issue 1");
  expect(removeContextItem(remaining, remaining.entries[0].id)).toBeUndefined();
  expect(prepared.queuedMessages).toBeUndefined();
  expect(session.contextDraft).toBeUndefined();
  vi.mocked(invoke).mockClear();
  await contextFromTicketDescriptions(items);
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Access denied"));
  await expect(contextFromTicketDescriptions([{ ...items[0], number: 3 }])).rejects.toThrow("Access denied");
});


it("combines five issue providers with their descriptions and keeps their identities", async () => {
  const providers = ["github", "linear", "gitlab", "jira", "azure"] as const;
  const items = providers.map((provider, index) => ({ ...ticket, provider, kind: provider === "github" || provider === "gitlab" ? "issue" : provider, projectPath: "/mixed", id: String(100 + index), number: 100 + index, repo: "team/repo", title: `${provider} task`, url: `https://${provider}.example.com/issues/${100 + index}` }) as InboxItem);
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "jira_issue_content") return { fields: { description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Jira acceptance" }] }] } } };
    if (command === "azure_item_content") return { fields: { "System.Description": "Azure acceptance" } };
    return { body: `${command} acceptance`, author: "Author" };
  });
  const context = await contextFromTicketDescriptions(items);
  const linked = linkTicketContext(session, context);
  const message = composeAgentContext(linked.contextDraft, "Implement");
  for (const item of items) {
    expect(message).toContain(item.title);
    expect(message).toContain(item.url);
  }
  expect(message).toContain("Jira acceptance");
  expect(message).toContain("Azure acceptance");
  expect(new Set(context.entries.map(entry => entry.id)).size).toBe(5);
  expect(linked.linkedWorkItem?.additionalItems).toHaveLength(4);
  expect(linked.linkedWorkItem?.context).toContain("acceptance");
});

it("limits description requests and stops queued work after cancellation", async () => {
  const pending: (() => void)[] = [];
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(() => new Promise(resolve => pending.push(() => resolve({ body: "description" }))));
  const controller = new AbortController();
  const items = Array.from({ length: 20 }, (_, index) => ({ ...ticket, provider: "github", kind: "issue", projectPath: "/bounded-fetch", repo: "a/b", number: 200 + index, url: `https://github.com/a/b/issues/${200 + index}` }) as InboxItem);
  const result = contextFromTicketDescriptions(items, controller.signal);
  const rejected = expect(result).rejects.toThrow();
  expect(pending).toHaveLength(4);
  controller.abort();
  pending.forEach(resolve => resolve());
  await rejected;
  expect(invoke).toHaveBeenCalledTimes(4);
});

it("retains description text for every long issue in batches and incremental additions", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, args) => ({ body: `Acceptance ${(args as { number: number }).number}\n${"x".repeat(32_000)}` }));
  const items = Array.from({ length: 20 }, (_, index) => ({ ...ticket, provider: "github", kind: "issue", projectPath: "/fair-context", repo: "a/b", number: 600 + index, url: `https://github.com/a/b/issues/${600 + index}` }) as InboxItem);
  const batch = linkTicketContext(session, await contextFromTicketDescriptions(items));
  let incremental = session;
  for (const item of items) incremental = linkTicketContext(incremental, await contextFromTicketDescriptions([item]));
  for (const result of [batch, incremental]) {
    expect(result.contextDraft!.entries.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(MAX_CONTEXT_TEXT);
    for (const item of items) expect(composeAgentContext(result.contextDraft, "")).toContain(`Acceptance ${item.number}`);
    const links = [result.linkedWorkItem!, ...result.linkedWorkItem!.additionalItems!];
    expect(links.every(link => link.context?.includes("Acceptance"))).toBe(true);
    expect(links.reduce((sum, link) => sum + link.context!.length, 0)).toBeLessThanOrEqual(MAX_CONTEXT_TEXT);
  }
});
