import type { CiRun, CiSource } from "./azurePipelines";
import { gitPrStatus } from "./fs";
import { githubRepo, githubPrState } from "./githubTasks";
import { gitlabMrForBranch, gitlabMrState } from "./gitlab";
import { pathKey } from "./paths";

/**
 * Fetched CI state for one task-child checkout — GitHub check runs on the
 * branch's PR head and the GitLab pipeline on its merge request. Unlike the
 * saved delivery links this is live provider data, so it is fetched only on
 * demand (the task details sheet) and never polled in the background.
 *
 * The module mirrors useBranchPr's shape: one deduplicated in-flight load
 * per checkout, a version counter so peek-based readers re-render, and no
 * retained provider payloads beyond the bounded check rows.
 */
export type TaskCiCheck = {
  name: string;
  /** Normalized display state — see githubCheckState/gitlabPipelineState. */
  state: string;
  url?: string;
};

export type TaskChildCi = {
  /** Branch the load ran under — stale entries report the branch they
   * actually describe, like the branch-PR cache does. */
  branch: string;
  github: {
    number: number;
    url: string;
    /** Resolved "owner/repo" — the repair's repo binding, "" when the
     * checkout has no GitHub remote (Fix stays hidden). */
    repo: string;
    /** Raw PR state (OPEN/MERGED/CLOSED) — gates the Fix action. */
    prState: string;
    checks: TaskCiCheck[];
  } | null;
  gitlab: {
    /** The branch's merge request — present even when it has no pipeline. */
    mrNumber: number;
    mrTitle: string;
    mrUrl: string;
    /** Raw MR state ("open"/"merged"/"closed") — gates the Fix action. */
    mrState: string;
    /** Project path the backend resolved — the repair's repo binding. */
    repo: string;
    /** Head pipeline when the MR reports one. */
    pipeline: { id: number; state: string; url?: string } | null;
  } | null;
};

type Entry = {
  value: TaskChildCi | null;
  inflight: boolean;
  /** Branch of the in-flight/last requested load. */
  branch: string | null;
  /** Caller's already-known branch PR — refreshed per request. */
  prNumber: number | undefined;
  pending: boolean;
};

const entries = new Map<string, Entry>();
let version = 0;
const versionListeners = new Set<() => void>();

export function subscribeTaskCiVersion(listener: () => void) {
  versionListeners.add(listener);
  return () => {
    versionListeners.delete(listener);
  };
}

export function taskCiVersion(): number {
  return version;
}

/** Bounded per-checkout cache — evicts the oldest idle entry past the cap. */
const MAX_ENTRIES = 64;

function entryFor(cwd: string): Entry {
  const key = pathKey(cwd);
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= MAX_ENTRIES) {
      for (const [oldKey, old] of entries) {
        if (!old.inflight) {
          entries.delete(oldKey);
          break;
        }
      }
    }
    entry = {
      value: null,
      inflight: false,
      branch: null,
      prNumber: undefined,
      pending: false,
    };
    entries.set(key, entry);
  }
  return entry;
}

function publish() {
  version += 1;
  for (const listener of versionListeners) listener();
}

/** GitHub check-run status+conclusion → a display state. */
export function githubCheckState(status: string, conclusion: string): string {
  switch (status) {
    case "completed":
      switch (conclusion) {
        case "success":
          return "Passed";
        case "failure":
        case "timed_out":
        case "action_required":
        case "startup_failure":
          return "Failed";
        case "cancelled":
          return "Cancelled";
        default:
          // neutral, skipped, stale
          return "Skipped";
      }
    case "in_progress":
      return "Running";
    default:
      // queued, pending, requested, waiting
      return "Queued";
  }
}

/** GitLab pipeline status → a display state. */
export function gitlabPipelineState(status: string): string {
  switch (status) {
    case "success":
      return "Passed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "canceled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
    case "manual":
      return "Manual";
    default:
      // created, waiting_for_resource, preparing, pending, scheduled
      return "Queued";
  }
}

async function fetchGithubCi(cwd: string, branch: string, prNumber?: number) {
  // A known branch-PR goes straight to its check state; otherwise gitPrStatus
  // discovers the PR for the checkout's current branch. headRefName is always
  // verified — a checkout that moved must not serve another branch's checks.
  let number =
    prNumber ?? (await gitPrStatus(cwd).catch(() => null))?.number;
  if (!number) return null;
  let state = await githubPrState(cwd, number).catch(() => null);
  if (state && state.headRefName !== branch && prNumber) {
    // The caller's cached number belongs to another branch — rediscover once
    // so a stale link can't hide the current branch's checks.
    const found = (await gitPrStatus(cwd).catch(() => null))?.number;
    if (found && found !== number) {
      number = found;
      state = await githubPrState(cwd, number).catch(() => null);
    } else state = null;
  }
  if (!state || !number || state.headRefName !== branch) return null;
  const repo = (await githubRepo(cwd).catch(() => "")).trim();
  return {
    number,
    url: state.url,
    repo,
    prState: state.state,
    checks: state.checks.slice(0, 50).map((check) => ({
      name: check.name,
      state: githubCheckState(check.status, check.conclusion),
      ...(check.url ? { url: check.url } : {}),
    })),
  };
}

async function fetchGitlabCi(cwd: string, branch: string) {
  const mr = await gitlabMrForBranch(cwd, branch).catch(() => null);
  if (!mr) return null;
  const state = await gitlabMrState(cwd, mr.number).catch(() => null);
  // The work-item lookup already carries title/url/state/repo — when the
  // deeper MR-state call fails the row still names the MR, just without a
  // pipeline or a repair binding. A head that moved mid-read (same rule as
  // the GitHub path) reports the MR but drops the pipeline: it describes a
  // head this branch no longer owns.
  const pipeline = state && state.headRefName === branch ? state.pipeline : null;
  return {
    mrNumber: mr.number,
    mrTitle: state?.title ?? mr.title,
    mrUrl: state?.url ?? mr.url,
    mrState: state?.state ?? mr.state,
    repo: state?.repo ?? mr.repo,
    pipeline: pipeline
      ? {
          id: pipeline.id,
          state: gitlabPipelineState(pipeline.status),
          ...(pipeline.url ? { url: pipeline.url } : {}),
        }
      : null,
  };
}

/**
 * Loads the checkout's provider CI once — deduplicated per working copy; a
 * second call while one is in flight queues a rerun so a branch switch never
 * serves the old branch's rows. `prNumber` is the caller's already-known
 * branch PR and saves the discovery call.
 */
export function loadTaskChildCi(
  cwd: string,
  branch: string,
  prNumber?: number,
) {
  if (!cwd || cwd === "~" || !branch) return;
  const entry = entryFor(cwd);
  entry.branch = branch;
  entry.prNumber = prNumber;
  if (entry.inflight) {
    entry.pending = true;
    return;
  }
  entry.inflight = true;
  void (async () => {
    try {
      do {
        entry.pending = false;
        const fetchBranch = entry.branch ?? branch;
        try {
          const [github, gitlab] = await Promise.all([
            fetchGithubCi(cwd, fetchBranch, entry.prNumber),
            fetchGitlabCi(cwd, fetchBranch),
          ]);
          entry.value = {
            branch: fetchBranch,
            github,
            gitlab,
          };
          publish();
        } catch {
          // Fetchers null-guard provider errors — a throw here is an
          // unexpected failure; a queued rerun still deserves its turn.
        }
      } while (entry.pending);
    } finally {
      entry.inflight = false;
      entry.pending = false;
    }
  })();
}

/** Last fetched CI for a checkout — never triggers a load. */
export function peekTaskChildCi(
  cwd: string | undefined,
  branch: string | null | undefined,
): TaskChildCi | null {
  if (!cwd || !branch) return null;
  const entry = entries.get(pathKey(cwd));
  return entry?.value?.branch === branch ? entry.value : null;
}

/** A load is in flight for this checkout+branch. */
export function taskChildCiLoading(
  cwd: string | undefined,
  branch: string | null | undefined,
): boolean {
  if (!cwd || !branch) return false;
  const entry = entries.get(pathKey(cwd));
  return !!entry?.inflight && entry.branch === branch;
}

/** Drop everything — project removal and tests reset here. */
export function clearTaskCi() {
  entries.clear();
  publish();
}

/**
 * A repair request for a CI row — the App dispatches it through the same
 * evidence builders the attention queue's fix actions use. `number`/`repo`
 * name the PR or MR the failing CI belongs to; each builder re-verifies
 * branch, head and identity before anything reaches an agent.
 */
export type TaskCiFix =
  | { kind: "azure"; source: CiSource; run: CiRun }
  | { kind: "github"; cwd: string; repo: string; number: number }
  | { kind: "gitlab"; cwd: string; repo: string; number: number };

/** A review-tab open request from the details sheet — the App fills
 * branch/session and mounts the provider's review surface in the task's
 * workspace. No provider means Azure DevOps. */
export type TaskDeliveryRef = {
  kind: "pr" | "ci";
  provider?: "github" | "gitlab";
  repo?: string;
  number?: number;
};
