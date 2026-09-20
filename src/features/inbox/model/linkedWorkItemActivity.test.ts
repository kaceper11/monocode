import { describe, expect, it } from "vitest";
import type { GithubWorkItemThread } from "./githubTasks";
import {
  completeLinkedWorkItemUpdateCard,
  linkedWorkItemActivityKey,
  linkedWorkItemActivityPrompt,
  linkedWorkItemTerminalState,
  linkedWorkItemUpdateSummary,
  pendingLinkedWorkItemUpdateCard,
} from "./linkedWorkItemActivity";
import type { LinkedSessionUpdate } from "./linkedSessionUpdates";

const update: LinkedSessionUpdate = {
  sessionId: "session-1",
  since: Date.parse("2026-09-13T10:00:00Z"),
  updatedAt: Date.parse("2026-09-13T12:00:00Z"),
  item: {
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
    projectPath: "",
  },
};

const thread: GithubWorkItemThread = {
  comments: [
    {
      id: "old",
      kind: "comment",
      author: "old-user",
      body: "Already handled",
      createdAt: "2026-09-13T09:00:00Z",
      url: "",
      state: "",
      path: "",
      line: null,
      resolved: false,
      threadId: "",
      replies: [],
    },
    {
      id: "review",
      kind: "review",
      author: "maya",
      body: "Please cover the empty state",
      createdAt: "2026-09-13T11:30:00Z",
      url: "https://github.com/acme/app/pull/42#review",
      state: "CHANGES_REQUESTED",
      path: "",
      line: null,
      resolved: false,
      threadId: "",
      replies: [],
    },
  ],
  commits: [
    {
      oid: "abcdef123456",
      messageHeadline: "Handle linked activity",
      author: "nik",
      committedDate: "2026-09-13T11:00:00Z",
      url: "https://github.com/acme/app/commit/abcdef123456",
    },
  ],
  truncated: false,
  reviewDecision: "CHANGES_REQUESTED",
  baseRefName: "main",
  headRefName: "activity",
};

describe("linked work item activity card", () => {
  it("binds an async activity read to the account, item and revision", () => {
    const key = linkedWorkItemActivityKey(update);
    expect(linkedWorkItemActivityKey({ ...update, item: { ...update.item } })).toBe(key);
    for (const item of [
      { ...update.item, account: "another-account" },
      { ...update.item, url: "https://github.com/acme/other/pull/42" },
      { ...update.item, number: 43 },
    ]) expect(linkedWorkItemActivityKey({ ...update, item })).not.toBe(key);
    expect(linkedWorkItemActivityKey({ ...update, updatedAt: update.updatedAt + 1 })).not.toBe(key);
    expect(pendingLinkedWorkItemUpdateCard(update).key).toBe(key);
  });

  it("only includes activity newer than the prior read baseline", () => {
    const card = completeLinkedWorkItemUpdateCard(
      pendingLinkedWorkItemUpdateCard(update),
      thread,
    );

    expect(card.counts).toEqual({ comments: 0, reviews: 1, commits: 1 });
    expect(card.entries.map((entry) => entry.id)).toEqual([
      "review",
      "abcdef123456",
    ]);
    expect(linkedWorkItemUpdateSummary(card)).toBe(
      "1 new commit · 1 new review",
    );
  });

  it("builds an explicit agent action from the update details", () => {
    const card = completeLinkedWorkItemUpdateCard(
      pendingLinkedWorkItemUpdateCard(update),
      thread,
    );
    const message = linkedWorkItemActivityPrompt(card);

    expect(message).toContain("Address the new feedback");
    expect(message).toContain(
      "The linked GitHub pull request has new activity",
    );
    expect(message).toContain("review by @maya: Requested changes");
    expect(message).toContain("commit by @nik: Handle linked activity");
  });

  it("recognizes terminal issue and pull request states", () => {
    expect(
      linkedWorkItemTerminalState({ kind: "issue", state: "CLOSED" }),
    ).toBe("issue_closed");
    expect(linkedWorkItemTerminalState({ kind: "pr", state: "merged" })).toBe(
      "pr_merged",
    );
    expect(linkedWorkItemTerminalState({ kind: "pr", state: "closed" })).toBe(
      "pr_closed",
    );
    expect(linkedWorkItemTerminalState({ kind: "issue", state: "open" })).toBe(
      undefined,
    );
  });
});

describe("provider-specific activity", () => {
  it.each([undefined, "resolved", "inprogress", "unknown"])(
    "does not infer Azure completion from a display name (%s category)",
    (stateType) => {
      expect(linkedWorkItemTerminalState({
        provider: "azuredevops", kind: "issue", state: "Done", stateType,
      })).toBeUndefined();
    },
  );

  it("recognizes the Azure removed category regardless of display name", () => {
    expect(linkedWorkItemTerminalState({
      provider: "azuredevops", kind: "issue", state: "Discarded", stateType: "removed",
    })).toBe("issue_closed");
  });

  const gitlabUpdate: LinkedSessionUpdate = {
    ...update,
    item: {
      ...update.item,
      provider: "gitlab",
      url: "https://gitlab.example.com/acme/app/-/merge_requests/42",
    },
  };

  it("labels GitLab notes as comments and uses merge-request wording", () => {
    const card = completeLinkedWorkItemUpdateCard(
      pendingLinkedWorkItemUpdateCard(gitlabUpdate),
      {
        comments: [
          {
            id: "discussion",
            kind: "comment",
            author: "maya",
            body: "A blocking discussion",
            createdAt: "2026-09-13T11:30:00Z",
            url: "",
            state: "",
            path: "",
            line: null,
            resolved: false,
            threadId: "d1",
            replies: [],
          },
          {
            id: "diff-note",
            kind: "comment",
            author: "nik",
            body: "Rename this",
            createdAt: "2026-09-13T11:40:00Z",
            url: "",
            state: "",
            path: "",
            line: null,
            resolved: false,
            threadId: "d2",
            replies: [],
          },
        ],
        commits: [],
        truncated: false,
        reviewDecision: "",
        baseRefName: "",
        headRefName: "",
      },
    );

    expect(card.entries.map((entry) => entry.kind)).toEqual([
      "comment",
      "comment",
    ]);
    expect(card.counts).toEqual({ comments: 2, reviews: 0, commits: 0 });
    expect(linkedWorkItemActivityPrompt(card)).toContain(
      "The linked GitLab merge request has new activity",
    );
  });

  it("recognizes Jira, Azure and Linear terminal states", () => {
    expect(
      linkedWorkItemTerminalState({
        provider: "jira",
        kind: "issue",
        state: "Done",
        stateType: "done",
      }),
    ).toBe("issue_closed");
    expect(
      linkedWorkItemTerminalState({
        provider: "jira",
        kind: "issue",
        state: "In Progress",
        stateType: "indeterminate",
      }),
    ).toBeUndefined();
    expect(
      linkedWorkItemTerminalState({
        provider: "azuredevops",
        kind: "issue",
        state: "Resolved",
        stateType: "completed",
      }),
    ).toBe("issue_closed");
    expect(
      linkedWorkItemTerminalState({
        provider: "linear",
        kind: "issue",
        state: "Canceled",
        stateType: "canceled",
      }),
    ).toBe("issue_closed");
    expect(
      linkedWorkItemTerminalState({
        provider: "azuredevops",
        kind: "pr",
        state: "merged",
        stateType: "completed",
      }),
    ).toBe("pr_merged");
    expect(
      linkedWorkItemTerminalState({
        provider: "azuredevops",
        kind: "pr",
        state: "closed",
        stateType: "removed",
      }),
    ).toBe("pr_closed");
  });

  it("uses provider nouns and identifiers in the agent prompt", () => {
    const jiraCard = completeLinkedWorkItemUpdateCard(
      pendingLinkedWorkItemUpdateCard({
        ...update,
        item: {
          ...update.item,
          provider: "jira",
          kind: "jira",
          identifier: "PROJ-123",
          url: "https://acme.atlassian.net/browse/PROJ-123",
        },
      }),
      { ...thread, commits: [] },
    );

    const prompt = linkedWorkItemActivityPrompt(jiraCard);
    expect(prompt).toContain("The linked Jira issue has new activity");
    expect(prompt).toContain("PROJ-123");
    expect(jiraCard.identifier).toBe("PROJ-123");
  });
});
