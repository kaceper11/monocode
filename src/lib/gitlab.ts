import { invoke } from "@tauri-apps/api/core";
import { normalizeProjectPath } from "./recents";

export type GitlabKind = "issue" | "pr";

export type GitlabStatus = {
  connected: boolean;
  url: string;
};

export type GitlabWorkItem = {
  account?: string;
  kind: GitlabKind;
  number: number;
  title: string;
  url: string;
  state: string;
  updatedAt: string;
  labels: { name: string; color: string }[];
  assignees: { login: string; avatarUrl?: string }[];
  draft: boolean;
  repo: string;
};

export type GitlabWorkItemDetails = {
  body: string;
  author: string;
  authorAvatarUrl?: string;
  baseRefName?: string;
  headRefName?: string;
  reviewDecision?: string;
};

export type GitlabWorkItemComment = {
  id: string;
  kind: string;
  author: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt: string;
  url: string;
  state: string;
  path: string;
  line: number | null;
  resolved: boolean;
  resolvable?: boolean;
  threadId: string;
  replies: GitlabWorkItemComment[];
};

export type GitlabWorkItemThread = {
  comments: GitlabWorkItemComment[];
  truncated: boolean;
  reviewDecision: string;
  baseRefName: string;
  headRefName: string;
};

export type GitlabMrDiff = {
  additions: number;
  deletions: number;
  files: { path: string; additions: number; deletions: number }[];
  patch: string;
  truncated: boolean;
};

export type GitlabMrPipeline = {
  id: number;
  sha: string;
  status: string;
  url: string;
};

export type GitlabMrState = {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  /** Project the backend resolved and read — fresh, unlike the repo cache. */
  repo: string;
  headSha: string;
  headRefName: string;
  baseRefName: string;
  mergeStatus: string;
  blockingDiscussionsResolved: boolean;
  approvalsRequired: number;
  approvalsLeft: number;
  approved: boolean;
  pipeline: GitlabMrPipeline | null;
};

export const GITLAB_CHANGE_EVENT = "monocode:gitlab-change";

const repoByPath = new Map<string, string>();
const repoInflight = new Map<string, Promise<string>>();
const detailsByKey = new Map<string, GitlabWorkItemDetails>();
const threadByKey = new Map<string, GitlabWorkItemThread>();
const threadInflight = new Map<string, Promise<GitlabWorkItemThread>>();
const diffInflight = new Map<string, Promise<GitlabMrDiff>>();
const discussionInflight = new Map<string, Promise<GitlabWorkItemThread>>();

function itemKey(cwd: string, kind: GitlabKind, number: number): string {
  return `${normalizeProjectPath(cwd)}:${kind}:${number}`;
}

export function clearGitlabCache() {
  repoByPath.clear();
  repoInflight.clear();
  detailsByKey.clear();
  threadByKey.clear();
  threadInflight.clear();
  diffInflight.clear();
  discussionInflight.clear();
}

export function gitlabConnected(): Promise<GitlabStatus> {
  return invoke<GitlabStatus>("gitlab_status");
}

export async function saveGitlabConfig(
  url: string,
  token: string,
): Promise<GitlabStatus> {
  const status = await invoke<GitlabStatus>("gitlab_set_config", {
    url: url.trim(),
    token: token.trim(),
  });
  clearGitlabCache();
  notifyGitlabChange();
  return status;
}

export async function disconnectGitlab(url: string): Promise<GitlabStatus> {
  const status = await invoke<GitlabStatus>("gitlab_set_config", {
    url: url.trim(),
    token: "",
  });
  clearGitlabCache();
  notifyGitlabChange();
  return status;
}

export async function gitlabRepo(cwd: string): Promise<string> {
  const key = normalizeProjectPath(cwd);
  const cached = repoByPath.get(key);
  if (cached !== undefined) return cached;
  const inflight = repoInflight.get(key);
  if (inflight) return inflight;
  const pending = invoke<string>("gitlab_repo", { cwd })
    .then((repo) => {
      // A later force/invalidate removed or replaced this entry — don't
      // let the stale write repopulate the cache.
      if (repoInflight.get(key) === pending) repoByPath.set(key, repo);
      return repo;
    })
    .finally(() => {
      if (repoInflight.get(key) === pending) repoInflight.delete(key);
    });
  repoInflight.set(key, pending);
  return pending;
}

export function listGitlabWorkItems(
  cwd: string,
  query: {
    kind: GitlabKind;
    assignedToMe: boolean;
    state: "open" | "all";
    limit?: number;
  },
): Promise<GitlabWorkItem[]> {
  return invoke<GitlabWorkItem[]>("gitlab_list_work_items", {
    cwd,
    kind: query.kind,
    assignedToMe: query.assignedToMe,
    state: query.state,
    limit: query.limit,
  });
}

export function peekGitlabWorkItemDetails(
  cwd: string,
  kind: GitlabKind,
  number: number,
): GitlabWorkItemDetails | null {
  return detailsByKey.get(itemKey(cwd, kind, number)) ?? null;
}

export async function gitlabWorkItemDetails(
  cwd: string,
  kind: GitlabKind,
  number: number,
): Promise<GitlabWorkItemDetails> {
  const details = await invoke<GitlabWorkItemDetails>(
    "gitlab_work_item_details",
    { cwd, kind, number },
  );
  detailsByKey.set(itemKey(cwd, kind, number), details);
  return details;
}

export function peekGitlabWorkItemThread(
  cwd: string,
  kind: GitlabKind,
  number: number,
): GitlabWorkItemThread | null {
  return threadByKey.get(itemKey(cwd, kind, number)) ?? null;
}

export async function gitlabWorkItemThread(
  cwd: string,
  kind: GitlabKind,
  number: number,
  options?: { force?: boolean },
): Promise<GitlabWorkItemThread> {
  const key = itemKey(cwd, kind, number);
  if (options?.force) {
    threadByKey.delete(key);
    threadInflight.delete(key);
  }
  const cached = threadInflight.get(key);
  if (cached) return cached;
  const pending = invoke<GitlabWorkItemThread>("gitlab_work_item_thread", {
    cwd,
    kind,
    number,
  })
    .then((thread) => {
      if (threadInflight.get(key) === pending) threadByKey.set(key, thread);
      return thread;
    })
    .finally(() => {
      if (threadInflight.get(key) === pending) threadInflight.delete(key);
    });
  threadInflight.set(key, pending);
  return pending;
}

export async function gitlabWorkItemComment(
  cwd: string,
  kind: GitlabKind,
  number: number,
  body: string,
): Promise<string> {
  const url = await invoke<string>("gitlab_work_item_comment", {
    cwd,
    kind,
    number,
    body: body.trim(),
  });
  const key = itemKey(cwd, kind, number);
  threadByKey.delete(key);
  threadInflight.delete(key);
  // A top-level note on an MR lands as a new individual_note discussion.
  if (kind === "pr") invalidateDiscussions(cwd, number);
  return url;
}

export async function gitlabMrDiff(
  cwd: string,
  number: number,
): Promise<GitlabMrDiff> {
  const key = itemKey(cwd, "pr", number);
  const cached = diffInflight.get(key);
  if (cached) return cached;
  const pending = invoke<GitlabMrDiff>("gitlab_mr_diff", { cwd, number })
    .finally(() => {
      if (diffInflight.get(key) === pending) diffInflight.delete(key);
    });
  diffInflight.set(key, pending);
  return pending;
}

/** Review/merge/pipeline state for one merge request. */
export function gitlabMrState(
  cwd: string,
  number: number,
): Promise<GitlabMrState> {
  return invoke<GitlabMrState>("gitlab_mr_state", { cwd, number });
}

/** The open merge request for a source branch, or a rejection. */
export function gitlabMrForBranch(
  cwd: string,
  branch: string,
): Promise<GitlabWorkItem> {
  return invoke<GitlabWorkItem>("gitlab_mr_for_branch", { cwd, branch });
}

/** Discussions keep diff positions; unlike flat notes they carry
 * `threadId` (the discussion id) so replies and resolve target exactly. */
export async function gitlabMrDiscussions(
  cwd: string,
  number: number,
  options?: { force?: boolean },
): Promise<GitlabWorkItemThread> {
  const key = itemKey(cwd, "pr", number);
  if (options?.force) discussionInflight.delete(key);
  const cached = discussionInflight.get(key);
  if (cached) return cached;
  const pending = invoke<GitlabWorkItemThread>("gitlab_mr_discussions", {
    cwd,
    number,
  }).finally(() => {
    if (discussionInflight.get(key) === pending)
      discussionInflight.delete(key);
  });
  discussionInflight.set(key, pending);
  return pending;
}

const invalidateDiscussions = (cwd: string, number: number) => {
  const key = itemKey(cwd, "pr", number);
  discussionInflight.delete(key);
  // The flat notes thread behind the inbox summary lists the same replies.
  threadByKey.delete(key);
  threadInflight.delete(key);
};

/** Reply inside an existing discussion; returns the new note's URL. */
export async function gitlabMrDiscussionReply(
  cwd: string,
  number: number,
  discussionId: string,
  body: string,
): Promise<string> {
  const url = await invoke<string>("gitlab_mr_discussion_reply", {
    cwd,
    number,
    discussionId,
    body: body.trim(),
  });
  invalidateDiscussions(cwd, number);
  return url;
}

export async function gitlabMrDiscussionResolve(
  cwd: string,
  number: number,
  discussionId: string,
  resolved: boolean,
): Promise<void> {
  await invoke("gitlab_mr_discussion_resolve", {
    cwd,
    number,
    discussionId,
    resolved,
  });
  invalidateDiscussions(cwd, number);
}

export function notifyGitlabChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(GITLAB_CHANGE_EVENT));
}
