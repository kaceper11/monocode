import {
  ATTENTION_ACTION,
  ATTENTION_INFO,
  type AttentionItem,
} from "./attention";
import {
  FAILING_CHECK_CONCLUSIONS,
  githubPrState,
  githubWorkItemThread,
  listGithubWorkItems,
  type InboxItem,
} from "./githubTasks";
import { listJiraIssues } from "./jira";
import { listAzureItems, type AzureStatus } from "./azure";
import {
  azurePrUrl,
  readAzurePr,
  readAzurePrSection,
  type AzurePrThread,
} from "./azureRepos";
import { unresolvedThread } from "./repair";
import { ciContext, ciLookup, ciMatches } from "./azurePipelines";
import {
  linkedWorkItemFromInboxItem,
  parseGithubWorkItemUrl,
} from "./sessionWorkItem";
import type { Watcher, WatcherSource } from "./watchers";

/**
 * Watcher poll adapters (#23). One adapter per source kind turns a bounded
 * provider read into the set of conditions that are *currently true*. The
 * engine diffs consecutive condition sets: a new key emits a row, a missing
 * key resolves it, a changed signature resurfaces it. Adapters never write
 * provider state and never build repair evidence — quick actions re-derive
 * fresh evidence at click time.
 */

export type WatcherCondition = {
  /** Condition identity inside the watcher — stable while the same
   * underlying state persists (e.g. `pr-behind:owner/repo#4`). */
  key: string;
  /** Fingerprint of the condition payload — a change resurfaces the row. */
  signature: string;
  item: Omit<AttentionItem, "key" | "signature" | "source">;
};

export type WatcherPoll = {
  conditions: WatcherCondition[];
  /** Adapter watermark persisted on the watcher. */
  cursor?: string;
  /** The source reached a terminal state — the engine emits this goodbye
   * row and removes the watcher instead of polling it forever. */
  done?: Omit<AttentionItem, "key" | "signature" | "source">;
};

/** Cap items read into conditions; anything beyond is summarized. */
const MAX_CONDITION_ITEMS = 50;

const ticketItem = (
  item: InboxItem,
): Omit<AttentionItem, "key" | "signature" | "source"> | null => {
  const linked = linkedWorkItemFromInboxItem(item);
  if (!linked) return null;
  const label =
    item.identifier?.trim() ||
    (item.kind === "issue" || item.kind === "pr" ? `#${item.number}` : item.title);
  const isPr = item.kind === "pr";
  return {
    kind: isPr ? "pr-review" : "ticket",
    title: `${label} — ${item.title}`.slice(0, 160),
    detail: item.repo || item.projectName || item.site || undefined,
    urgency: ATTENTION_ACTION,
    at: Date.parse(item.updatedAt) || Date.now(),
    provider: item.provider,
    account: item.account || item.site || undefined,
    repo: item.repo || undefined,
    url: item.url || undefined,
    revision: item.updatedAt,
    action: isPr
      ? { kind: "open-item", item: linked }
      : { kind: "start-task", item },
  };
};

async function pollGithubItems(
  source: Extract<WatcherSource, { kind: "github-items" }>,
): Promise<WatcherPoll> {
  const items = await listGithubWorkItems(source.cwd, source.repo, {
    kind: source.itemKind,
    assignedToMe: true,
    state: "open",
    search: "",
  });
  const conditions: WatcherCondition[] = [];
  for (const item of items.slice(0, MAX_CONDITION_ITEMS)) {
    const inbox: InboxItem = {
      ...item,
      provider: "github",
      projectPath: source.cwd,
    };
    const base = ticketItem(inbox);
    if (!base) continue;
    conditions.push({
      key: `gh-item:${source.repo}:${item.kind}:${item.number}`,
      signature: `${item.updatedAt}:${item.state}`,
      item: base,
    });
  }
  return { conditions };
}

async function pollGithubPr(
  source: Extract<WatcherSource, { kind: "github-pr" }>,
): Promise<WatcherPoll> {
  const [state, thread] = await Promise.all([
    githubPrState(source.cwd, source.number),
    // The thread cache has no TTL — force a fresh read or comment detection
    // freezes after the first poll.
    githubWorkItemThread(source.cwd, source.repo, "pr", source.number, {
      force: true,
    }),
  ]);
  // `gh` resolves the PR through the checkout's current remote — a repointed
  // remote would read an unrelated PR number and could fake a `done`.
  const fetchedRepo = state.url
    ? parseGithubWorkItemUrl(state.url)?.repo
    : null;
  if (fetchedRepo && fetchedRepo.toLowerCase() !== source.repo.toLowerCase())
    throw new Error(`Checkout no longer points at ${source.repo}`);
  {
    const prState = state.state.toUpperCase();
    if (prState !== "OPEN") {
      return {
        conditions: [],
        done: {
          kind: "pr-done",
          title: `PR #${state.number} — ${prState === "MERGED" ? "merged" : "closed"}`,
          detail: state.title || undefined,
          urgency: ATTENTION_INFO,
          at: Date.now(),
          provider: "github",
          repo: source.repo,
          cwd: source.cwd,
          url: state.url,
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
          action: { kind: "open-url", url: state.url },
        },
      };
    }
  }
  const conditions: WatcherCondition[] = [];
  const prLabel = `PR #${state.number}`;
  const base = {
    provider: "github" as const,
    repo: source.repo,
    cwd: source.cwd,
    url: state.url,
    revision: state.headRefOid,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
  };

  const failing = state.checks.filter((check) =>
    FAILING_CHECK_CONCLUSIONS.includes(check.conclusion),
  );
  if (failing.length) {
    conditions.push({
      key: `gh-ci:${source.repo}#${state.number}`,
      signature: `${state.headRefOid}:${failing.map((c) => `${c.name}=${c.conclusion}`).sort().join(",")}`,
      item: {
        kind: "ci-failure",
        title: `${prLabel} — ${failing.length} failing check${failing.length === 1 ? "" : "s"}`,
        detail: failing
          .slice(0, 3)
          .map((check) => check.name)
          .join(", "),
        urgency: ATTENTION_ACTION,
        at: Date.now(),
        ...base,
        action: {
          kind: "github-ci-fix",
          cwd: source.cwd,
          repo: source.repo,
          number: state.number,
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        },
      },
    });
  }

  // The backend emits three kinds: "comment" (conversation), "review"
  // (top-level review submissions — `resolved` is always false on these),
  // and "review_comment" (inline threads with a real resolution flag).
  // Only review_comment can resolve, so it drives the condition.
  const comments = thread.comments.filter(
    (comment) => comment.kind === "review_comment",
  );
  const openReview = comments.filter((comment) => !comment.resolved);
  const newest = comments[comments.length - 1];
  const changesRequested =
    state.reviewDecision.toUpperCase() === "CHANGES_REQUESTED";
  if (openReview.length || changesRequested) {
    conditions.push({
      key: `gh-comments:${source.repo}#${state.number}`,
      signature: `${openReview.length}:${newest?.id ?? ""}:${state.reviewDecision}:${state.headRefOid}`,
      item: {
        kind: "pr-comments",
        title: openReview.length
          ? `${prLabel} — ${openReview.length} unresolved review comment${openReview.length === 1 ? "" : "s"}`
          : `${prLabel} — changes requested`,
        detail: changesRequested ? "Changes requested" : undefined,
        urgency: ATTENTION_ACTION,
        at: Date.parse(newest?.createdAt ?? "") || Date.now(),
        ...base,
        action: {
          kind: "github-pr-comments",
          cwd: source.cwd,
          repo: source.repo,
          number: state.number,
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        },
      },
    });
  }

  const updateBranch = {
    kind: "update-branch" as const,
    cwd: source.cwd,
    branch: state.headRefName,
    ...(state.baseRefName ? { base: state.baseRefName } : {}),
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
  };
  const mergeState = state.mergeStateStatus.toUpperCase();
  if (mergeState === "DIRTY") {
    conditions.push({
      key: `gh-conflicts:${source.repo}#${state.number}`,
      signature: `${mergeState}:${state.headRefOid}`,
      item: {
        kind: "pr-conflicts",
        title: `${prLabel} has merge conflicts`,
        detail: state.baseRefName ? `with ${state.baseRefName}` : undefined,
        urgency: ATTENTION_ACTION,
        at: Date.now(),
        ...base,
        action: updateBranch,
      },
    });
  } else if (mergeState === "BEHIND") {
    conditions.push({
      key: `gh-behind:${source.repo}#${state.number}`,
      signature: `${mergeState}:${state.headRefOid}`,
      item: {
        kind: "pr-behind",
        title: `${prLabel} is behind ${state.baseRefName || "the base branch"}`,
        urgency: ATTENTION_INFO,
        at: Date.now(),
        ...base,
        action: updateBranch,
      },
    });
  }
  return { conditions };
}

async function pollJiraItems(
  source: Extract<WatcherSource, { kind: "jira-items" }>,
): Promise<WatcherPoll> {
  const items = await listJiraIssues(source.site, "open", source.filter);
  const conditions: WatcherCondition[] = [];
  for (const item of items.slice(0, MAX_CONDITION_ITEMS)) {
    const base = ticketItem(item);
    if (!base) continue;
    conditions.push({
      key: `jira:${source.site}:${item.id ?? item.url}`,
      signature: `${item.updatedAt}:${item.state}`,
      item: base,
    });
  }
  return { conditions };
}

async function pollAzureBoards(
  source: Extract<WatcherSource, { kind: "azure-boards" }>,
): Promise<WatcherPoll> {
  const status: AzureStatus = {
    connected: true,
    site: source.site,
    project: source.project,
    account: "",
    capabilities: [],
  };
  const items = await listAzureItems(status, source.filter);
  const conditions: WatcherCondition[] = [];
  for (const item of items.slice(0, MAX_CONDITION_ITEMS)) {
    const base = ticketItem(item);
    if (!base) continue;
    conditions.push({
      key: `boards:${source.site}:${item.id ?? item.url}`,
      signature: `${item.updatedAt}:${item.state}`,
      item: base,
    });
  }
  return { conditions };
}

async function pollAzurePr(
  source: Extract<WatcherSource, { kind: "azure-pr" }>,
): Promise<WatcherPoll> {
  const { pr, revision } = await readAzurePr(source.target);
  if (pr.status !== "active") {
    const url = azurePrUrl(source.target);
    return {
      conditions: [],
      done: {
        kind: "pr-done",
        title: `PR !${pr.pullRequestId} — ${
          pr.status === "abandoned"
            ? "abandoned"
            : pr.status === "completed"
              ? "completed"
              : "closed"
        }`,
        detail: pr.title || undefined,
        urgency: ATTENTION_INFO,
        at: Date.now(),
        provider: "azure",
        account: source.target.accountId,
        repo: source.target.repository,
        cwd: source.cwd,
        url,
        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        action: { kind: "open-url", url },
      },
    };
  }
  const threads = await readAzurePrSection<AzurePrThread>(
    source.target,
    revision,
    "threads",
  );
  const conditions: WatcherCondition[] = [];
  const prLabel = `PR !${pr.pullRequestId}`;
  const url = azurePrUrl(source.target);
  const base = {
    provider: "azure" as const,
    account: source.target.accountId,
    repo: source.target.repository,
    cwd: source.cwd,
    url,
    revision,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
  };

  const unresolvedThreads = threads.items.filter(unresolvedThread);
  const unresolved = unresolvedThreads.reduce(
    (count, thread) =>
      count + thread.comments.filter((comment) => !comment.isDeleted).length,
    0,
  );
  const newestThread = unresolvedThreads[unresolvedThreads.length - 1];
  const newestComment = newestThread?.comments.filter(
    (comment) => !comment.isDeleted,
  ).length
    ? `${newestThread.id}:${newestThread.comments[newestThread.comments.length - 1]?.id ?? ""}`
    : "";
  if (unresolved) {
    conditions.push({
      key: `azure-comments:${azurePrKeyOf(source.target)}`,
      signature: `${unresolved}:${newestComment}:${revision}`,
      item: {
        kind: "pr-comments",
        title: `${prLabel} — ${unresolved} unresolved comment${unresolved === 1 ? "" : "s"}`,
        urgency: ATTENTION_ACTION,
        at: Date.now(),
        ...base,
        action: {
          kind: "azure-pr-comments",
          target: source.target,
          projectName: source.projectName,
          repositoryName: source.repositoryName,
          cwd: source.cwd,
          branch: source.branch,
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        },
      },
    });
  }

  const updateBranch = {
    kind: "update-branch" as const,
    cwd: source.cwd,
    branch: source.branch,
    base: pr.targetRefName.replace(/^refs\/heads\//, ""),
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
  };
  const mergeStatus = (pr.mergeStatus ?? "").toLowerCase();
  if (mergeStatus === "conflicts") {
    conditions.push({
      key: `azure-conflicts:${azurePrKeyOf(source.target)}`,
      signature: `${mergeStatus}:${revision}`,
      item: {
        kind: "pr-conflicts",
        title: `${prLabel} has merge conflicts`,
        urgency: ATTENTION_ACTION,
        at: Date.now(),
        ...base,
        action: updateBranch,
      },
    });
  } else if (
    pr.targetHead &&
    pr.lastMergeTargetCommit?.commitId &&
    pr.targetHead !== pr.lastMergeTargetCommit.commitId
  ) {
    conditions.push({
      key: `azure-behind:${azurePrKeyOf(source.target)}`,
      signature: `${pr.targetHead}:${revision}`,
      item: {
        kind: "pr-behind",
        title: `${prLabel} is behind ${pr.targetRefName.replace(/^refs\/heads\//, "") || "the target branch"}`,
        urgency: ATTENTION_INFO,
        at: Date.now(),
        ...base,
        action: updateBranch,
      },
    });
  }
  return { conditions };
}

const azurePrKeyOf = (target: { site: string; accountId: string; project: string; repository: string; number: number }) =>
  `${target.site}:${target.repository}:${target.number}`;

async function pollAzureCi(
  source: Extract<WatcherSource, { kind: "azure-ci" }>,
): Promise<WatcherPoll> {
  const checkout = await ciContext(source.cwd);
  const head = {
    cwd: checkout.cwd,
    branch: checkout.branch,
    commit: checkout.commit,
    remote: source.remote,
  };
  if (checkout.branch !== source.branch)
    return { conditions: [], cursor: `off-branch:${checkout.branch}` };
  const page = await ciLookup(source.target, head);
  const failed = page.items.filter(
    (run) => run.result === "failed" && ciMatches(run),
  );
  const conditions: WatcherCondition[] = [];
  for (const run of failed.slice(0, 5)) {
    conditions.push({
      key: `azure-ci:${source.target.definition}:${run.id}`,
      signature: `${run.id}:${run.revision}:${run.result}`,
      item: {
        kind: "ci-failure",
        title: `${source.definitionName || "Pipeline"} run ${run.number} failed`,
        detail: run.commit ? `commit ${run.commit.slice(0, 8)}` : undefined,
        urgency: ATTENTION_ACTION,
        at: Date.parse(run.queuedAt) || Date.now(),
        provider: "azure",
        account: source.target.accountId,
        repo: source.target.repositoryId || undefined,
        cwd: source.cwd,
        revision: run.revision,
        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        action: {
          kind: "azure-ci-fix",
          target: source.target,
          definitionName: page.definitionName || source.definitionName,
          remote: source.remote,
          cwd: source.cwd,
          branch: source.branch,
          runId: run.id,
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        },
      },
    });
  }
  return { conditions, cursor: String(page.items[0]?.id ?? "") };
}

/** One bounded provider read for the watcher. Throws on provider errors — the
 * engine records backoff + a source-level reconnect row. */
export function pollWatcherSource(watcher: Watcher): Promise<WatcherPoll> {
  const source = watcher.source;
  switch (source.kind) {
    case "github-items":
      return pollGithubItems(source);
    case "github-pr":
      return pollGithubPr(source);
    case "jira-items":
      return pollJiraItems(source);
    case "azure-boards":
      return pollAzureBoards(source);
    case "azure-pr":
      return pollAzurePr(source);
    case "azure-ci":
      return pollAzureCi(source);
  }
}
