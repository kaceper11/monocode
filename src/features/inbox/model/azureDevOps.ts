import type { InboxRelationship } from "./inboxFilters";
import { invoke } from "@tauri-apps/api/core";
import type { GitPr, GitPrCheck } from "../../../platform/tauri/fs";
import { recordInboxSelfActivity } from "./inboxSelfActivity";
import { normalizeProjectPath } from "../../projects/model/recents";

export type AzureDevOpsKind = "issue" | "pr";

export type AzureDevOpsStatus = {
  connected: boolean;
  url: string;
  organization: string;
};

export type AzureDevOpsWorkItem = {
  kind: AzureDevOpsKind;
  number: number;
  title: string;
  url: string;
  state: string;
  updatedAt: string;
  labels: { name: string; color: string }[];
  assignees: { login: string; avatarUrl?: string }[];
  draft: boolean;
  repo: string;
  attentionReason: string;
  /** `refs/heads/…` source/target refs — populated on pull requests. */
  sourceRefName?: string;
  targetRefName?: string;
};

export type AzureDevOpsWorkItemDetails = {
  body: string;
  author: string;
  authorAvatarUrl?: string;
  baseRefName?: string;
  headRefName?: string;
  reviewDecision?: string;
};

export type AzureDevOpsWorkItemComment = {
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
  threadId: string;
  replies: AzureDevOpsWorkItemComment[];
};

export type AzureDevOpsWorkItemThread = {
  comments: AzureDevOpsWorkItemComment[];
  truncated: boolean;
  reviewDecision: string;
  baseRefName: string;
  headRefName: string;
};

export type AzureDevOpsMrDiff = {
  additions: number;
  deletions: number;
  files: { path: string; additions: number; deletions: number }[];
  patch: string;
  truncated: boolean;
};

export const AZUREDEVOPS_CHANGE_EVENT = "monocode:azuredevops-change";

const repoByPath = new Map<string, string>();
const detailsByKey = new Map<string, AzureDevOpsWorkItemDetails>();
const detailsInflight = new Map<string, Promise<AzureDevOpsWorkItemDetails>>();
const threadByKey = new Map<string, AzureDevOpsWorkItemThread>();
const threadInflight = new Map<string, Promise<AzureDevOpsWorkItemThread>>();
const diffByKey = new Map<string, AzureDevOpsMrDiff>();
const diffInflight = new Map<string, Promise<AzureDevOpsMrDiff>>();

function itemKey(repo: string, kind: AzureDevOpsKind, number: number): string {
  return `${repo.trim().toLowerCase()}:${kind}:${number}`;
}

export function clearAzureDevOpsCache() {
  repoByPath.clear();
  matchByPath.clear();
  detailsByKey.clear();
  detailsInflight.clear();
  threadByKey.clear();
  threadInflight.clear();
  diffByKey.clear();
  diffInflight.clear();
}

export function azureDevOpsConnected(): Promise<AzureDevOpsStatus> {
  return invoke<AzureDevOpsStatus>("azure_devops_status");
}

export async function saveAzureDevOpsConfig(
  url: string,
  token: string,
): Promise<AzureDevOpsStatus> {
  const status = await invoke<AzureDevOpsStatus>("azure_devops_set_config", {
    url: url.trim(),
    token: token.trim(),
  });
  clearAzureDevOpsCache();
  notifyAzureDevOpsChange();
  return status;
}

export async function disconnectAzureDevOps(
  url: string,
): Promise<AzureDevOpsStatus> {
  const status = await invoke<AzureDevOpsStatus>("azure_devops_set_config", {
    url: url.trim(),
    token: "",
  });
  clearAzureDevOpsCache();
  notifyAzureDevOpsChange();
  return status;
}

export async function azureDevOpsRepo(cwd: string): Promise<string> {
  const key = normalizeProjectPath(cwd);
  const cached = repoByPath.get(key);
  if (cached !== undefined) return cached;
  const repo = await invoke<string>("azure_devops_repo", { cwd });
  repoByPath.set(key, repo);
  return repo;
}

export function listAzureDevOpsWorkItems(
  cwd: string,
  query: {
    kind: AzureDevOpsKind;
    assignedToMe: boolean;
    state: "open" | "all";
    limit?: number;
  },
): Promise<AzureDevOpsWorkItem[]> {
  return invoke<AzureDevOpsWorkItem[]>("azure_devops_list_work_items", {
    cwd,
    kind: query.kind,
    assignedToMe: query.assignedToMe,
    state: query.state,
    limit: query.limit,
  });
}

export function listAzureDevOpsTodos(query: {
  kind: AzureDevOpsKind;
  relationship?: InboxRelationship;
  state?: "open" | "all";
  limit?: number;
}): Promise<AzureDevOpsWorkItem[]> {
  return invoke<AzureDevOpsWorkItem[]>("azure_devops_list_todos", {
    kind: query.kind,
    ...(query.relationship ? { relationship: query.relationship, state: query.state } : {}),
    limit: query.limit,
  });
}

export function peekAzureDevOpsWorkItemDetails(
  repo: string,
  kind: AzureDevOpsKind,
  number: number,
): AzureDevOpsWorkItemDetails | null {
  return detailsByKey.get(itemKey(repo, kind, number)) ?? null;
}

export async function azureDevOpsWorkItemDetails(
  repo: string,
  kind: AzureDevOpsKind,
  number: number,
): Promise<AzureDevOpsWorkItemDetails> {
  const key = itemKey(repo, kind, number);
  const cached = detailsInflight.get(key);
  if (cached) return cached;
  const pending = invoke<AzureDevOpsWorkItemDetails>(
    "azure_devops_work_item_details",
    { repo, kind, number },
  )
    .then((details) => {
      // A cache clear (e.g. org change) supersedes this request: skip the
      // write so a stale completion cannot repopulate the cache.
      if (detailsInflight.get(key) === pending) detailsByKey.set(key, details);
      return details;
    })
    .finally(() => {
      if (detailsInflight.get(key) === pending) detailsInflight.delete(key);
    });
  detailsInflight.set(key, pending);
  return pending;
}

export function peekAzureDevOpsWorkItemThread(
  repo: string,
  kind: AzureDevOpsKind,
  number: number,
): AzureDevOpsWorkItemThread | null {
  return threadByKey.get(itemKey(repo, kind, number)) ?? null;
}

export async function azureDevOpsWorkItemThread(
  repo: string,
  kind: AzureDevOpsKind,
  number: number,
  options?: { force?: boolean },
): Promise<AzureDevOpsWorkItemThread> {
  const key = itemKey(repo, kind, number);
  if (options?.force) {
    threadByKey.delete(key);
    threadInflight.delete(key);
  }
  const cached = threadInflight.get(key);
  if (cached) return cached;
  const pending = invoke<AzureDevOpsWorkItemThread>(
    "azure_devops_work_item_thread",
    {
      repo,
      kind,
      number,
    },
  )
    .then((thread) => {
      // A forced refresh or cache clear supersedes this request: skip the
      // write so a stale completion cannot repopulate the cache.
      if (threadInflight.get(key) === pending) threadByKey.set(key, thread);
      return thread;
    })
    .finally(() => {
      if (threadInflight.get(key) === pending) threadInflight.delete(key);
    });
  threadInflight.set(key, pending);
  return pending;
}

export async function azureDevOpsWorkItemComment(
  repo: string,
  kind: AzureDevOpsKind,
  number: number,
  body: string,
): Promise<string> {
  const url = await invoke<string>("azure_devops_work_item_comment", {
    repo,
    kind,
    number,
    body: body.trim(),
  });
  const key = itemKey(repo, kind, number);
  threadByKey.delete(key);
  threadInflight.delete(key);
  recordInboxSelfActivity({ provider: "azuredevops", kind, repo, number });
  return url;
}

export function peekAzureDevOpsMrDiff(
  repo: string,
  number: number,
): AzureDevOpsMrDiff | null {
  return diffByKey.get(itemKey(repo, "pr", number)) ?? null;
}

export async function azureDevOpsMrDiff(
  repo: string,
  number: number,
): Promise<AzureDevOpsMrDiff> {
  const key = itemKey(repo, "pr", number);
  const cached = diffInflight.get(key);
  if (cached) return cached;
  const pending = invoke<AzureDevOpsMrDiff>("azure_devops_mr_diff", {
    repo,
    number,
  })
    .then((diff) => {
      // Same staleness guard as the thread cache above.
      if (diffInflight.get(key) === pending) diffByKey.set(key, diff);
      return diff;
    })
    .finally(() => {
      if (diffInflight.get(key) === pending) diffInflight.delete(key);
    });
  diffInflight.set(key, pending);
  return pending;
}

export function notifyAzureDevOpsChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AZUREDEVOPS_CHANGE_EVENT));
}

// ---- Board workstream surface --------------------------------------------
// Per-branch PR status/create and pipeline builds — the Azure counterpart of
// `gitPrStatus`/`gitPrChecks`/`gitPrCreate`/`gitPrUpdate` in
// `platform/tauri/fs`, which route through `gh` and only cover GitHub.

export type AzureDevOpsPrProbe = {
  pr: GitPr | null;
  checks: GitPrCheck[];
};

/** PR + latest pipeline build per definition on the branch and its PR's
 * validation runs — one round trip per lane probe. Check buckets match
 * `GitPrCheck` (pass/fail/pending/…). `branch` overrides the checkout's
 * branch — pass the lane's when `cwd` isn't its own worktree. */
export function azureDevOpsPrProbe(
  cwd: string,
  prUrl?: string,
  branch?: string,
): Promise<AzureDevOpsPrProbe> {
  return invoke<AzureDevOpsPrProbe>("azure_devops_pr_probe", {
    cwd,
    prUrl,
    branch,
  });
}

export function azureDevOpsPrCreate(
  cwd: string,
  title: string,
  body: string,
  base: string,
  head: string,
  draft: boolean,
): Promise<string> {
  return invoke<string>("azure_devops_pr_create", {
    cwd,
    title,
    body,
    base,
    head,
    draft,
  });
}

/** Replace a pull request's description — `prId` targets the exact PR the
 * caller created; without it the branch's newest active PR is patched. */
export function azureDevOpsPrUpdateBody(
  cwd: string,
  body: string,
  prId?: number,
): Promise<void> {
  return invoke<void>("azure_devops_pr_update_body", {
    cwd,
    body,
    prId: prId ?? null,
  });
}

const matchByPath = new Map<string, { at: number; match: Promise<boolean> }>();
/** Remotes can change under a live session (repointed origin, added
 * upstream) — a forever-cache would route PR calls to the wrong provider
 * until restart. 60s bounds the staleness while absorbing probe churn. */
const MATCH_TTL_MS = 60_000;

/** Whether the worktree's remote resolves to the configured Azure org — the
 * board routes PR/CI calls through this surface instead of `gh` when true.
 * Cached per path: every lane probe and create asks, and each call is a git
 * subprocess. */
export function azureDevOpsRepoMatch(cwd: string): Promise<boolean> {
  const key = normalizeProjectPath(cwd);
  const entry = matchByPath.get(key);
  if (entry && Date.now() - entry.at < MATCH_TTL_MS) return entry.match;
  const match = invoke<boolean>("azure_devops_repo_match", { cwd });
  // A transient failure (git subprocess, auth) must not poison the cache —
  // evict rejections so the next probe retries.
  match.catch(() => matchByPath.delete(key));
  matchByPath.set(key, { at: Date.now(), match });
  return match;
}

/** Pipeline builds for an inbox PR's `repo` (`project/name`) + source ref +
 * number — CI badges for Azure PR cards that have no local workstream. */
export function azureDevOpsBranchChecks(
  repo: string,
  sourceRefName: string,
  pr: number,
): Promise<GitPrCheck[]> {
  return invoke<GitPrCheck[]>("azure_devops_branch_checks", {
    repo,
    branch: sourceRefName,
    pr,
  });
}
