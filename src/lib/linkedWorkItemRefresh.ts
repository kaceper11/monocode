import type {
  GithubWorkItemComment,
  GithubWorkItemThread,
  InboxItem,
} from "./githubTasks";
import {
  githubWorkItem,
  githubWorkItemThread,
  gitlabWorkItemToInboxItem,
  linearIssueToInboxItem,
} from "./githubTasks";
import {
  gitlabConnected,
  gitlabWorkItem,
  gitlabWorkItemThread,
} from "./gitlab";
import { azureConnected, azureItemSnapshot, azureThread } from "./azure";
import {
  parseAzurePrLocation,
  readAzurePr,
  readAzurePrSection,
  type AzurePrTarget,
  type AzurePrThread,
} from "./azureRepos";
import { jiraConnected, jiraIssueSnapshot, jiraThread } from "./jira";
import { linearIssueSnapshot, linearIssueThread } from "./linear";
import type { LinkedWorkItem } from "./session";

const providerOf = (linked: LinkedWorkItem) => linked.provider ?? "github";

type AzurePrThreadRow = Omit<AzurePrThread, "comments"> & {
  publishedDate?: string;
  lastUpdatedDate?: string;
  comments: (AzurePrThread["comments"][number] & {
    publishedDate?: string;
    lastUpdatedDate?: string;
  })[];
};

async function azurePrTarget(
  linked: LinkedWorkItem,
): Promise<AzurePrTarget | null> {
  try {
    const location = parseAzurePrLocation(linked.url);
    const accountId =
      linked.account ?? (await azureConnected()).accountId ?? "";
    return { ...location, accountId };
  } catch {
    return null;
  }
}

/** Newest thread/comment stamp across one Azure PR threads page (ISO strings). */
function azurePrActivityStamp(items: readonly AzurePrThreadRow[]): string {
  let latest = "";
  const note = (stamp?: string) => {
    if (stamp && stamp > latest) latest = stamp;
  };
  for (const thread of items) {
    note(thread.publishedDate);
    note(thread.lastUpdatedDate);
    for (const comment of thread.comments ?? []) {
      note(comment.publishedDate);
      note(comment.lastUpdatedDate);
    }
  }
  return latest;
}

function azurePrSnapshotState(status: string): {
  state: string;
  stateType: string;
} {
  const normalized = status.trim().toLowerCase();
  if (normalized === "completed") return { state: "merged", stateType: "completed" };
  if (normalized === "abandoned") return { state: "closed", stateType: "removed" };
  return { state: "open", stateType: "inProgress" };
}

/** Thread pages are 50 rows; 10 keeps the activity read bounded on old PRs. */
const AZURE_PR_THREAD_PAGES = 10;

async function azurePrThreadRows(
  target: AzurePrTarget,
  revision: string,
): Promise<{ items: AzurePrThreadRow[]; truncated: boolean }> {
  const items: AzurePrThreadRow[] = [];
  let skip = 0;
  for (let page = 0; page < AZURE_PR_THREAD_PAGES; page++) {
    const result = await readAzurePrSection<AzurePrThreadRow>(
      target,
      revision,
      "threads",
      skip,
    );
    items.push(...result.items);
    if (result.nextSkip == null) return { items, truncated: false };
    skip = result.nextSkip;
  }
  return { items, truncated: true };
}

async function azurePrSnapshot(
  linked: LinkedWorkItem,
): Promise<InboxItem | null> {
  const target = await azurePrTarget(linked);
  if (!target) return null;
  const { pr, revision } = await readAzurePr(target);
  const { items } = await azurePrThreadRows(target, revision);
  const { state, stateType } = azurePrSnapshotState(pr.status);
  const updatedAt = [
    azurePrActivityStamp(items),
    pr.closedDate ?? "",
    pr.creationDate ?? "",
  ]
    .filter(Boolean)
    .sort()
    .pop() ?? "";
  return {
    provider: "azure",
    account: target.accountId,
    kind: "pr",
    id: String(pr.pullRequestId),
    number: pr.pullRequestId,
    identifier: `PR #${pr.pullRequestId}`,
    title: pr.title,
    url: linked.url,
    site: target.site,
    state,
    stateType,
    updatedAt,
    labels: [],
    assignees: [],
    draft: Boolean(pr.isDraft),
    repo: pr.repositoryName || linked.repo,
    projectName: pr.projectName || "",
    projectPath: "",
  };
}

async function azurePrThreadFor(
  linked: LinkedWorkItem,
): Promise<GithubWorkItemThread> {
  const target = await azurePrTarget(linked);
  if (!target) throw new Error("Missing Azure pull request target");
  const { revision } = await readAzurePr(target);
  const { items, truncated } = await azurePrThreadRows(target, revision);
  const comments: GithubWorkItemComment[] = items.flatMap((thread) =>
    (thread.comments ?? [])
      .filter((comment) => !comment.isDeleted)
      .map((comment) => ({
        id: `${thread.id}:${comment.id}`,
        kind: thread.threadContext?.filePath ? "review_comment" : "comment",
        author: comment.author?.displayName ?? "",
        body: comment.content ?? "",
        createdAt: comment.publishedDate ?? thread.publishedDate ?? "",
        url: linked.url,
        state: thread.status ?? "",
        path: thread.threadContext?.filePath ?? "",
        line: thread.threadContext?.rightFileStart?.line ?? null,
        resolved:
          thread.status === "closed" || thread.status === "fixed",
        threadId: String(thread.id),
        replies: [],
      })),
  );
  return {
    comments,
    commits: [],
    truncated,
    reviewDecision: "",
    baseRefName: "",
    headRefName: "",
  };
}

/**
 * GitLab config is a single instance; a link whose URL belongs to another
 * instance must not silently query the configured one. A link whose URL
 * cannot be parsed is not verifiable, so it is treated as foreign.
 */
async function gitlabSameInstance(linked: LinkedWorkItem): Promise<boolean> {
  const status = await gitlabConnected();
  if (!status.connected) return false;
  try {
    return new URL(status.url).origin === new URL(linked.url).origin;
  } catch {
    return false;
  }
}

async function jiraSite(linked: LinkedWorkItem): Promise<string> {
  return linked.site ?? (await jiraConnected()).site;
}

async function azureSite(linked: LinkedWorkItem): Promise<string> {
  return linked.site ?? (await azureConnected()).site;
}

/**
 * Refresh one linked item when it does not appear in the Inbox listing —
 * e.g. assigned to someone else, filtered out, or in a closed state. Returns
 * null when the provider cannot identify or read it.
 */
export async function refreshLinkedWorkItem(
  cwd: string,
  linked: LinkedWorkItem,
): Promise<InboxItem | null> {
  try {
    switch (providerOf(linked)) {
      case "gitlab": {
        if (!(await gitlabSameInstance(linked))) return null;
        const item = await gitlabWorkItem(
          linked.repo,
          linked.kind,
          linked.number,
        );
        return {
          ...gitlabWorkItemToInboxItem(item, "", item.repo || linked.repo),
          account: linked.account ?? item.account,
        };
      }
      case "jira": {
        const id = linked.id ?? linked.identifier;
        const site = await jiraSite(linked);
        if (!id || !site) return null;
        const item = await jiraIssueSnapshot(site, id);
        return { ...item, account: linked.account ?? item.account };
      }
      case "azure": {
        if (linked.kind === "pr") return azurePrSnapshot(linked);
        const id = linked.id ?? String(linked.number);
        const status = await azureConnected();
        const site = linked.site ?? status.site;
        if (!site) return null;
        const item = await azureItemSnapshot(site, id);
        return {
          ...item,
          account: linked.account ?? status.accountId ?? item.account,
        };
      }
      case "linear": {
        const id = linked.id ?? linked.identifier;
        if (!id) return null;
        const item = linearIssueToInboxItem(await linearIssueSnapshot(id));
        return { ...item, account: linked.account ?? item.account };
      }
      default: {
        const item = await githubWorkItem(
          cwd,
          linked.repo,
          linked.kind,
          linked.number,
          { force: true },
        );
        return { ...item, provider: "github", projectPath: "" };
      }
    }
  } catch {
    return null;
  }
}

/** Detail read behind the activity card, dispatched on the linked provider. */
export async function fetchLinkedWorkItemThread(
  cwd: string,
  linked: LinkedWorkItem,
): Promise<GithubWorkItemThread> {
  switch (providerOf(linked)) {
    case "gitlab": {
      if (!(await gitlabSameInstance(linked))) {
        throw new Error("Linked GitLab item is on another instance");
      }
      const thread = await gitlabWorkItemThread(
        linked.repo,
        linked.kind,
        linked.number,
        { force: true },
      );
      return { ...thread, commits: [] };
    }
    case "jira": {
      const id = linked.id ?? linked.identifier;
      const site = await jiraSite(linked);
      if (!id || !site) throw new Error("Missing Jira issue identity");
      return jiraThread({ site, id, url: linked.url });
    }
    case "azure": {
      if (linked.kind === "pr") return azurePrThreadFor(linked);
      const site = await azureSite(linked);
      const id = linked.id ?? String(linked.number);
      if (!site) throw new Error("Missing Azure site");
      return azureThread({ site, id, url: linked.url });
    }
    case "linear": {
      const id = linked.id ?? linked.identifier;
      if (!id) throw new Error("Missing Linear issue identity");
      const thread = await linearIssueThread(id, { force: true });
      return { ...thread, commits: [] };
    }
    default:
      return githubWorkItemThread(cwd, linked.kind, linked.number, {
        force: true,
        repo: linked.repo,
      });
  }
}
