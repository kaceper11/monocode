import {
  githubPrDiff,
  githubWorkItemComment,
  githubWorkItemDetails,
  githubWorkItemThread,
  peekGithubPrDiff,
  peekGithubWorkItemDetails,
  peekGithubWorkItemThread,
  type GithubPrDiff,
  type GithubWorkItemDetails,
  type GithubWorkItemThread,
  type InboxItem,
} from "../../inbox/model/githubTasks";
import {
  linearIssueComment,
  linearIssueDetails,
  linearIssueThread,
  peekLinearIssueDetails,
  peekLinearIssueThread,
  type LinearIssueThread,
} from "../../inbox/model/linear";
import {
  gitlabMrDiff,
  gitlabWorkItemComment,
  gitlabWorkItemDetails,
  gitlabWorkItemThread,
  peekGitlabMrDiff,
  peekGitlabWorkItemDetails,
  peekGitlabWorkItemThread,
  type GitlabWorkItemThread,
} from "../../inbox/model/gitlab";
import {
  azureDevOpsMrDiff,
  azureDevOpsWorkItemComment,
  azureDevOpsWorkItemDetails,
  azureDevOpsWorkItemThread,
  peekAzureDevOpsMrDiff,
  peekAzureDevOpsWorkItemDetails,
  peekAzureDevOpsWorkItemThread,
  type AzureDevOpsKind,
  type AzureDevOpsMrDiff,
  type AzureDevOpsWorkItemThread,
} from "../../inbox/model/azureDevOps";
import {
  jiraDetails,
  jiraThread,
  peekJiraDetails,
  peekJiraThread,
} from "./jira";

export type InboxThread =
  | GithubWorkItemThread
  | LinearIssueThread
  | GitlabWorkItemThread
  | AzureDevOpsWorkItemThread;
export type InboxDiff = GithubPrDiff | AzureDevOpsMrDiff;
export type InboxReply = { id: string; threadId?: string };

/** Provider IO stays here; upstream's inbox owns presentation and interaction. */
export type InboxProviderAdapter = {
  details: () => Promise<GithubWorkItemDetails>;
  peekDetails: () => GithubWorkItemDetails | null;
  thread: (force?: boolean) => Promise<InboxThread>;
  peekThread: () => InboxThread | null;
  comment?: (body: string, reply: InboxReply | null) => Promise<unknown>;
  replyMode?: "parent" | "thread";
  diff?: (fullFile: boolean) => Promise<InboxDiff>;
  peekDiff?: (fullFile: boolean) => InboxDiff | null;
};

/** GitHub starts from the item itself; do not require a local checkout or IO. */
export async function inboxSessionDescription(item: InboxItem, body?: string) {
  if (body !== undefined || !item.provider || item.provider === "github")
    return body;
  if (item.provider === "linear" && !item.id) return undefined;
  if (item.provider === "gitlab" && item.kind !== "issue" && item.kind !== "pr")
    return undefined;
  const provider = inboxProvider(item);
  return (provider.peekDetails() ?? (await provider.details())).body;
}

export function inboxProvider(item: InboxItem): InboxProviderAdapter {
  if (item.provider === "azuredevops") {
    const kind: AzureDevOpsKind = item.kind === "pr" ? "pr" : "issue";
    return {
      details: () =>
        azureDevOpsWorkItemDetails(item.repo, kind, item.number),
      peekDetails: () =>
        peekAzureDevOpsWorkItemDetails(item.repo, kind, item.number),
      thread: (force) =>
        azureDevOpsWorkItemThread(item.repo, kind, item.number, { force }),
      peekThread: () =>
        peekAzureDevOpsWorkItemThread(item.repo, kind, item.number),
      comment: (body) =>
        azureDevOpsWorkItemComment(item.repo, kind, item.number, body),
      ...(kind === "pr"
        ? {
            diff: () => azureDevOpsMrDiff(item.repo, item.number),
            peekDiff: () =>
              peekAzureDevOpsMrDiff(item.repo, item.number),
          }
        : {}),
    };
  }
  if (item.provider === "jira")
    return {
      details: () => jiraDetails(item),
      peekDetails: () => peekJiraDetails(item),
      thread: () => jiraThread(item),
      peekThread: () => peekJiraThread(item),
    };
  if (item.provider === "linear") {
    const id = item.id ?? "";
    return {
      details: () => linearIssueDetails(id),
      peekDetails: () => peekLinearIssueDetails(id),
      thread: (force) => linearIssueThread(id, { force }),
      peekThread: () => peekLinearIssueThread(id),
      comment: (body, reply) =>
        linearIssueComment(id, body, { parentId: reply?.id }),
      replyMode: "parent",
    };
  }
  const kind = item.kind === "pr" ? "pr" : "issue";
  if (item.provider === "gitlab")
    return {
      details: () => gitlabWorkItemDetails(item.repo, kind, item.number),
      peekDetails: () =>
        peekGitlabWorkItemDetails(item.repo, kind, item.number),
      thread: (force) =>
        gitlabWorkItemThread(item.repo, kind, item.number, { force }),
      peekThread: () => peekGitlabWorkItemThread(item.repo, kind, item.number),
      comment: (body) =>
        gitlabWorkItemComment(item.repo, kind, item.number, body),
      ...(kind === "pr"
        ? {
            diff: () => gitlabMrDiff(item.repo, item.number),
            peekDiff: () => peekGitlabMrDiff(item.repo, item.number),
          }
        : {}),
    };
  return {
    details: () =>
      githubWorkItemDetails(item.projectPath, item.repo, kind, item.number),
    peekDetails: () => peekGithubWorkItemDetails(item.repo, kind, item.number),
    thread: (force) =>
      githubWorkItemThread(item.projectPath, item.repo, kind, item.number, {
        force,
      }),
    peekThread: () => peekGithubWorkItemThread(item.repo, kind, item.number),
    comment: (body, reply) =>
      githubWorkItemComment(
        item.projectPath,
        item.repo,
        kind,
        item.number,
        body,
        { inReplyTo: reply?.threadId },
      ),
    replyMode: "thread",
    ...(kind === "pr"
      ? {
          diff: (fullContext: boolean) =>
            githubPrDiff(item.projectPath, item.repo, item.number, {
              fullContext,
            }),
          peekDiff: (fullContext: boolean) =>
            peekGithubPrDiff(item.repo, item.number, fullContext),
        }
      : {}),
  };
}
