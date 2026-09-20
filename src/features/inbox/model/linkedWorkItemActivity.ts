import {
  githubReviewStateLabel,
  type GithubWorkItemComment,
  type InboxProvider,
} from "./githubTasks";
import type { InboxThread } from "../../sessions/model/inboxProvider.ts";
import type { LinkedSessionUpdate } from "./linkedSessionUpdates";

export type LinkedWorkItemActivityKind =
  "comment" | "review" | "review_comment" | "commit";

export type LinkedWorkItemActivityEntry = {
  id: string;
  kind: LinkedWorkItemActivityKind;
  author: string;
  text: string;
  createdAt: string;
  url: string;
};

export type LinkedWorkItemActivityCounts = {
  comments: number;
  reviews: number;
  commits: number;
};

export type LinkedWorkItemTerminalState =
  "issue_closed" | "pr_merged" | "pr_closed";

/** In-memory, one-shot context shown when an updated linked session is opened. */
export type LinkedWorkItemUpdateCard = {
  key: string;
  provider: InboxProvider;
  kind: "issue" | "pr";
  repo: string;
  number: number;
  identifier?: string;
  title: string;
  url: string;
  state: string;
  stateType?: string;
  project?: string;
  since: number;
  updatedAt: number;
  status: "loading" | "ready" | "error";
  counts: LinkedWorkItemActivityCounts;
  entries: LinkedWorkItemActivityEntry[];
  truncated: boolean;
};

const EMPTY_COUNTS: LinkedWorkItemActivityCounts = {
  comments: 0,
  reviews: 0,
  commits: 0,
};

const LINKED_PROVIDER_NAMES: Record<InboxProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  azuredevops: "Azure DevOps",
  linear: "Linear",
};

export function linkedWorkItemProviderName(
  provider: InboxProvider | undefined,
): string {
  return LINKED_PROVIDER_NAMES[provider ?? "github"];
}

/** Handle-style authors (logins/usernames) get "@"; display names do not. */
export function linkedWorkItemAuthorLabel(
  provider: InboxProvider | undefined,
  author: string,
): string {
  return provider === "github" || provider === "gitlab" || !provider
    ? `@${author}`
    : author;
}

/** Provider-native noun for the linked item kind. */
export function linkedWorkItemNoun(
  provider: InboxProvider | undefined,
  kind: "issue" | "pr",
): string {
  if (kind === "pr") {
    return provider === "gitlab" ? "merge request" : "pull request";
  }
  return provider === "azuredevops" ? "work item" : "issue";
}

/** Account, item and revision must still match when an async read finishes. */
export function linkedWorkItemActivityKey(update: LinkedSessionUpdate): string {
  const item = update.item;
  return JSON.stringify([
    item.provider ?? "github", item.account ?? "", item.repo, item.kind,
    item.number, item.url, update.updatedAt,
  ]);
}

export function pendingLinkedWorkItemUpdateCard(
  update: LinkedSessionUpdate,
): LinkedWorkItemUpdateCard {
  return {
    key: linkedWorkItemActivityKey(update),
    provider: update.item.provider ?? "github",
    kind: update.item.kind === "pr" ? "pr" : "issue",
    repo: update.item.repo,
    number: update.item.number,
    identifier: update.item.identifier,
    title: update.item.title,
    url: update.item.url,
    state: update.item.state,
    stateType: update.item.stateType,
    project: update.item.projectName,
    since: update.since,
    updatedAt: update.updatedAt,
    status: "loading",
    counts: EMPTY_COUNTS,
    entries: [],
    truncated: false,
  };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function concise(value: string, max = 140): string {
  const text = oneLine(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function after(timestamp: string, since: number): boolean {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value > since;
}

function flattenComments(
  comments: readonly GithubWorkItemComment[],
): GithubWorkItemComment[] {
  return comments.flatMap((comment) => [
    comment,
    ...flattenComments(comment.replies ?? []),
  ]);
}

export function completeLinkedWorkItemUpdateCard(
  card: LinkedWorkItemUpdateCard,
  thread: InboxThread,
): LinkedWorkItemUpdateCard {
  const comments = flattenComments(thread.comments ?? []).filter((comment) =>
    after(comment.createdAt, card.since),
  );
  const commits = (("commits" in thread ? thread.commits : []) ?? []).filter((commit) =>
    after(commit.committedDate, card.since),
  );
  const entries: LinkedWorkItemActivityEntry[] = [
    ...comments.map((comment) => ({
      id: comment.id,
      kind: (comment.kind === "review"
        ? "review"
        : comment.kind === "review_comment"
          ? "review_comment"
          : "comment") as LinkedWorkItemActivityKind,
      author: comment.author,
      text:
        comment.kind === "review"
          ? concise(
              [githubReviewStateLabel(comment.state), comment.body]
                .filter(Boolean)
                .join(": "),
            )
          : concise(comment.body),
      createdAt: comment.createdAt,
      url: comment.url,
    })),
    ...commits.map((commit) => ({
      id: commit.oid,
      kind: "commit" as const,
      author: commit.author,
      text: concise(commit.messageHeadline),
      createdAt: commit.committedDate,
      url: commit.url,
    })),
  ].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );

  return {
    ...card,
    status: "ready",
    counts: {
      comments: comments.filter((comment) => comment.kind !== "review").length,
      reviews: comments.filter((comment) => comment.kind === "review").length,
      commits: commits.length,
    },
    entries,
    truncated: thread.truncated,
  };
}

export function failLinkedWorkItemUpdateCard(
  card: LinkedWorkItemUpdateCard,
): LinkedWorkItemUpdateCard {
  return { ...card, status: "error" };
}

/**
 * A linked work item state that usually means the session can be cleaned up.
 * GitHub/GitLab share open/closed/merged state strings; Azure PR snapshots
 * map to the same vocabulary; Jira/Azure Boards/Linear report a state
 * category instead.
 */
export function linkedWorkItemTerminalState(card: {
  provider?: InboxProvider;
  kind: "issue" | "pr";
  state: string;
  stateType?: string;
}): LinkedWorkItemTerminalState | undefined {
  const provider = card.provider ?? "github";
  const state = card.state.trim().toLowerCase();
  const stateType = card.stateType?.trim().toLowerCase();
  if (card.kind === "issue") {
    if (provider === "jira") {
      return stateType === "done" ? "issue_closed" : undefined;
    }
    if (provider === "linear") {
      return stateType === "completed" || stateType === "canceled"
        ? "issue_closed"
        : undefined;
    }
    if (provider === "azuredevops") {
      return stateType === "completed" || stateType === "removed"
        ? "issue_closed"
        : undefined;
    }
    return state === "closed" ? "issue_closed" : undefined;
  }
  if (state === "merged") return "pr_merged";
  return state === "closed" ? "pr_closed" : undefined;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function linkedWorkItemUpdateSummary(
  card: LinkedWorkItemUpdateCard,
): string {
  const parts = [
    card.counts.commits ? countLabel(card.counts.commits, "new commit") : "",
    card.counts.reviews ? countLabel(card.counts.reviews, "new review") : "",
    card.counts.comments ? countLabel(card.counts.comments, "new comment") : "",
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  if (card.status === "loading") return "Loading change details…";
  if (card.status === "error") {
    return `Updated on ${linkedWorkItemProviderName(card.provider)} · details unavailable`;
  }
  return "Metadata or status changed";
}

export function linkedWorkItemActivityPrompt(
  card: LinkedWorkItemUpdateCard,
): string {
  const noun = linkedWorkItemNoun(card.provider, card.kind);
  const provider = linkedWorkItemProviderName(card.provider);
  const latest = card.entries[0];
  const instruction =
    latest?.kind === "commit"
      ? "Review the new commit and continue the work where needed."
      : latest
        ? "Address the new feedback and continue the work where needed."
        : "Review the latest update and continue the work where needed.";
  const details = card.entries.slice(0, 12).map((entry) => {
    const actor = entry.author
      ? ` by ${linkedWorkItemAuthorLabel(card.provider, entry.author)}`
      : "";
    const type =
      entry.kind === "review_comment" ? "review comment" : entry.kind;
    return `- ${type}${actor}: ${entry.text || "No message"}`;
  });
  if (details.length === 0) {
    details.push(
      `- ${linkedWorkItemUpdateSummary(card)}; current state: ${card.state}`,
    );
  }
  const context = [
    instruction,
    "",
    `The linked ${provider} ${noun} has new activity:`,
    "",
    `${card.identifier ?? `#${card.number}`} ${card.title}`,
    card.url,
    "",
    ...details,
  ].join("\n");
  return context;
}
