import { invoke } from "@tauri-apps/api/core";
import { getVerifiedFamilies } from "./repositoryFamilies";
import { loadRecents } from "./recents";
import { wslLocation } from "./paths";
import { notifyGitChanged } from "./fs";
import {
  boundAgentContext,
  contextFromText,
  type AgentContext,
} from "./agentContext";
import {
  azurePrContext,
  azurePrKey,
  readAzurePr,
  readAzurePrSection,
  type AzurePrAssociation,
  type AzurePrThread,
} from "./azureRepos";
import {
  ciContext,
  ciKey,
  ciLogContext,
  ciMatches,
  ciRead,
  type CiHead,
  type CiCheckout,
  type CiSource,
  type CiRun,
  type CiJob,
  type CiLog,
} from "./azurePipelines";
import {
  FAILING_CHECK_CONCLUSIONS,
  githubPrState,
  githubWorkItemThread,
  type GithubPrState,
  type GithubWorkItemComment,
} from "./githubTasks";
import {
  gitlabMrDiscussions,
  gitlabMrState,
  gitlabRepo,
  type GitlabMrState,
  type GitlabWorkItemComment,
} from "./gitlab";
import { sessionWorkCwd, type Session } from "./session";
import { isLiveHarness } from "./harness/registry";
import { isPreparingHandoff } from "./handoff";

export type RepairEvidence = {
  scope: string;
  head: CiHead;
} & (
  | {
      kind: "comments";
      association: AzurePrAssociation;
      skip: number;
      threads: { id: number; digest: string; entry: string; comment?: { id: number; author: string; text: string; file?: string; line?: number } }[];
    }
  | {
      kind: "ci";
      source: CiSource;
      run: CiRun;
      job: CiJob;
      log: Pick<
        CiLog,
        "startLine" | "endLine" | "attempt" | "logId" | "recordId"
      >;
    }
  | {
      kind: "github-comments";
      /** owner/repo the PR lives in — the checkout remote must match. */
      repo: string;
      number: number;
      comments: {
        id: string;
        digest: string;
        entry: string;
        kind: string;
        author: string;
        text: string;
        file?: string;
        line?: number;
      }[];
    }
  | {
      kind: "github-ci";
      repo: string;
      number: number;
      checks: {
        name: string;
        digest: string;
        entry: string;
        conclusion: string;
        url: string;
      }[];
    }
  | {
      kind: "gitlab-comments";
      /** GitLab project path (acme/web) — the checkout must resolve to it. */
      repo: string;
      number: number;
      comments: {
        id: string;
        digest: string;
        entry: string;
        author: string;
        text: string;
        file?: string;
        line?: number;
      }[];
    }
  | {
      kind: "gitlab-ci";
      repo: string;
      number: number;
      pipeline: {
        id: number;
        digest: string;
        entry: string;
        status: string;
        url: string;
      };
    }
);
export type RepairDelivery = {
  id: string;
  evidence: RepairEvidence;
  context: AgentContext;
  owner: {
    id: string;
    harness: Session["harness"];
    model: string;
    cwd: string;
    runtimeMode: Session["runtimeMode"];
    providerSessionId?: string;
  };
};
export type RepairRecord = {
  id: string;
  scope: string;
  cwd: string;
  commit: string;
  session: string;
  state:
    | "checking"
    | "queued"
    | "running"
    | "completed"
    | "blocked"
    | "uncertain"
    | "released";
  detail: string;
  at: number;
};
export const REPAIR_CHANGE = "monocode:repair-change";
export const OPEN_REPAIR = "monocode:open-repair";
const KEY = "monocode.repairs.v1";
let records: RepairRecord[] | undefined;
export function repairRecords(): RepairRecord[] {
  if (!records) {
    const value = JSON.parse(
      localStorage.getItem(KEY) || "[]",
    ) as RepairRecord[];
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some((row) => !row.id || !row.scope || !row.session || !row.cwd)
    )
      throw new Error(
        "Repair recovery records are unreadable. Restore local app data before sending another repair.",
      );
    records = value.map((row) =>
      ["checking", "queued", "running"].includes(row.state)
        ? {
            ...row,
            state: "uncertain",
            detail:
              "App interrupted. Inspect the conversation before allowing another request.",
          }
        : row,
    );
  }
  return records;
}
function save(next: RepairRecord[]) {
  localStorage.setItem(KEY, JSON.stringify(next)); // Failure must prevent dispatch, not silently lose deduplication.
  records = next;
  window.dispatchEvent(new Event(REPAIR_CHANGE));
}
export function reserveRepair(delivery: RepairDelivery, checkingOwner = false) {
  if (checkingOwner)
    throw new Error(
      "Another repair is checking this agent. Wait before trying again.",
    );
  const rows = repairRecords();
  const { evidence: e, owner } = delivery;
  // One active repair per artifact and checkout, including overlapping thread/job selections.
  if (
    rows.some(
      (row) =>
        row.scope === e.scope &&
        row.cwd === e.head.cwd &&
        !["released", "blocked"].includes(row.state),
    )
  )
    throw new Error(
      "A repair already exists for this work. Open its conversation and reconcile it before trying again.",
    );
  const retained = rows.filter(
    (row) => !["released", "blocked"].includes(row.state),
  ).length;
  if (retained >= 100)
    throw new Error(
      "Repair history is full. Reconcile completed requests before starting another.",
    );
  const next = [
    ...rows,
    {
      id: delivery.id,
      scope: e.scope,
      cwd: e.head.cwd,
      commit: e.head.commit,
      session: owner.id,
      state: "checking" as const,
      detail: "Checking selected evidence",
      at: Date.now(),
    },
  ];
  while (next.length > 100)
    next.splice(
      next.findIndex((row) => ["released", "blocked"].includes(row.state)),
      1,
    );
  save(next);
}
export function updateRepair(
  id: string,
  state: RepairRecord["state"],
  detail: string,
) {
  save(
    repairRecords().map((row) =>
      row.id === id
        ? { ...row, state, detail: detail.slice(0, 1000), at: Date.now() }
        : row,
    ),
  );
}
export function repairOwnerError(
  session: Session | undefined,
  evidence: RepairEvidence,
) {
  if (
    !session ||
    session.inboxAsk ||
    sessionWorkCwd(session) !== evidence.head.cwd
  )
    return "Choose an agent bound to this exact checkout.";
  if (!isLiveHarness(session.harness))
    return "This agent provider is not connected.";
  if (session.pendingSwitch || isPreparingHandoff(session))
    return "Finish the agent handoff before starting repair.";
  if (
    session.contextDraft ||
    session.noteCard ||
    session.handoffCard ||
    session.composerSeed?.trim()
  )
    return "Send or clear the destination's existing draft first.";
  return "";
}
export function assertRepairOwner(
  delivery: RepairDelivery,
  session: Session | undefined,
) {
  const error = repairOwnerError(session, delivery.evidence);
  const owner = delivery.owner;
  if (
    error ||
    !session ||
    session.id !== owner.id ||
    session.harness !== owner.harness ||
    session.model !== owner.model ||
    session.runtimeMode !== owner.runtimeMode ||
    session.providerSessionId !== owner.providerSessionId
  )
    throw new Error(
      error ||
        "Agent ownership changed. Open the evidence and choose the destination again.",
    );
}
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export const unresolvedThread = (thread: AzurePrThread) =>
  !thread.isDeleted && ["active", "pending"].includes(thread.status);
export async function commentsRepair(
  association: AzurePrAssociation,
  threads: AzurePrThread[],
  skip: number,
  current: () => boolean = () => true,
  commentId?: number,
  signal?: AbortSignal,
) {
  const selected = threads.filter(unresolvedThread).flatMap(thread => thread.comments.filter(comment => !comment.isDeleted && (commentId === undefined || comment.id === commentId)).map(comment => ({ thread, comment }))).slice(0, 20);
  if (!selected.length) throw new Error("Load unresolved comments first.");
  const remote = `${association.target.site}/${encodeURIComponent(association.projectName)}/_git/${encodeURIComponent(association.repositoryName)}`.toLowerCase();
  const branch = association.pr.sourceRefName.replace(/^refs\/heads\//, "");
  const commit = association.pr.lastMergeSourceCommit?.commitId;
  if (!commit || !association.pr.sourceRefName.startsWith("refs/heads/")) throw new Error("Refresh this PR to read its source branch and commit.");
  const matches = (value: CiCheckout) => value.remotes.some(row => row.url === remote) && value.branch === branch && value.commit === commit;
  let checkout = await ciContext(association.cwd);
  if (!matches(checkout)) {
    const paths = [...new Set([
      ...[...getVerifiedFamilies().values()].flatMap(family => family.worktrees.filter(tree => !tree.missing && !tree.prunable && !tree.locked).map(tree => tree.path)),
      ...loadRecents().map(project => project.path),
    ])].filter(path => path !== association.cwd && wslLocation(path)?.distribution === wslLocation(association.cwd)?.distribution).slice(0, 20);
    for (const path of paths) {
      if (!current()) throw new Error("Checkout preparation cancelled.");
      const candidate = await ciContext(path).catch(() => null);
      if (candidate && matches(candidate)) { checkout = candidate; break; }
    }
    if (!matches(checkout)) {
      if (!current()) throw new Error("Checkout preparation cancelled.");
      const requestId = crypto.randomUUID();
      const cancel = () => { void invoke("azure_pr_cancel_checkout", { requestId }).catch(() => undefined); };
      signal?.throwIfAborted();
      signal?.addEventListener("abort", cancel, { once: true });
      let path: string;
      try { path = await invoke<string>("azure_pr_prepare_checkout", { cwd: association.cwd, target: association.target, expectedRevision: association.revision, requestId }); }
      finally { signal?.removeEventListener("abort", cancel); }
      signal?.throwIfAborted();
      notifyGitChanged(association.cwd);
      if (!current()) throw new Error("Checkout preparation cancelled.");
      checkout = await ciContext(path);
      if (!matches(checkout)) throw new Error("Prepared checkout no longer matches the PR. Refresh and retry.");
    }
  }
  if (!current()) throw new Error("Checkout preparation cancelled.");
  association = { ...association, cwd: checkout.cwd, branch, sourceSessionId: checkout.cwd === association.cwd ? association.sourceSessionId : undefined };
  const entries = selected.map(({ thread, comment }) => {
    const entry = azurePrContext(association, { ...thread, comments: [comment] }).entries[0];
    return { ...entry, title: `PR #${association.target.number} · ${comment.author?.displayName ?? "Unknown author"} · comment ${comment.id}` };
  });
  const digests = new Map(await Promise.all([...new Map(selected.map(({thread}) => [thread.id, thread])).values()].map(async thread => [thread.id, await digest(thread)] as const)));
  const evidence: RepairEvidence = {
    kind: "comments",
    scope: azurePrKey(association.target),
    head: {
      cwd: checkout.cwd,
      branch: checkout.branch,
      commit: checkout.commit,
      remote,
    },
    association,
    skip,
    threads: selected.map(({ thread, comment }, i) => ({
      id: thread.id, digest: digests.get(thread.id)!, entry: entries[i].id,
      comment: { id: comment.id, author: comment.author?.displayName ?? "Unknown author", text: (comment.content ?? "").slice(0, 2000), file: thread.threadContext?.filePath, line: thread.threadContext?.rightFileStart?.line ?? thread.threadContext?.leftFileStart?.line },
    })),
  };
  return {
    evidence,
    context: boundAgentContext({
      id: crypto.randomUUID(),
      entries,
      attachments: [],
      instruction:
        "Address the selected unresolved review comments in this checkout. Run relevant checks and summarize changes. Do not reply, resolve threads, push or merge.",
    }),
  };
}
export function ciRepair(
  source: CiSource,
  head: CiHead,
  run: CiRun,
  job: CiJob,
  log: CiLog,
) {
  if (!ciMatches(run) || run.result !== "failed" || job.result !== "failed")
    throw new Error(
      "Choose a failed job from a failed run verified for this checkout commit.",
    );
  const context = ciLogContext(source, head, run, job, log);
  context.instruction =
    "Fix the selected CI failure in this checkout. Run relevant checks and summarize changes. Do not rerun pipelines, push or merge.";
  return {
    evidence: {
      kind: "ci",
      scope: ciKey(source.target),
      head,
      source,
      run,
      job,
      log: {
        startLine: log.startLine,
        endLine: log.endLine,
        attempt: log.attempt,
        logId: log.logId,
        recordId: log.recordId,
      },
    } as RepairEvidence,
    context,
  };
}
/** owner/repo tail of a GitHub remote URL, e.g. "acme/app" from any
 * transport form (https, ssh, .git suffix). */
const githubRepoSlug = (url: string) =>
  url
    .trim()
    .match(/[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)?.[1]
    ?.toLowerCase();

/** Resolve and verify the GitHub PR-head binding for a repair: the checkout
 * must sit at the PR head commit on the PR branch with a remote pointing at
 * the PR's repository. Never silently checks anything out — a mismatch is a
 * visible error, not a fixup. */
async function githubRepairHead(input: {
  cwd: string;
  repo: string;
  number: number;
}): Promise<{ head: CiHead; state: GithubPrState }> {
  const state = await githubPrState(input.cwd, input.number);
  if (state.state.toUpperCase() !== "OPEN")
    throw new Error("The PR is no longer open. Refresh and retry.");
  if (!state.headRefOid || !state.headRefName)
    throw new Error("GitHub did not report the PR head. Refresh and retry.");
  const checkout = await ciContext(input.cwd);
  const remote = checkout.remotes.find(
    (row) => githubRepoSlug(row.url) === input.repo.toLowerCase(),
  );
  if (!remote)
    throw new Error(
      `This checkout has no remote for ${input.repo}. Open the PR's checkout.`,
    );
  if (
    checkout.commit !== state.headRefOid ||
    checkout.branch !== state.headRefName
  )
    throw new Error(
      `Checkout is not at the PR head (${state.headRefName} · ${state.headRefOid.slice(0, 8)}). Update the checkout first.`,
    );
  return {
    head: {
      cwd: checkout.cwd,
      branch: checkout.branch,
      commit: checkout.commit,
      remote: remote.url,
    },
    state,
  };
}

/** "Address comments" for a GitHub PR — bounded review evidence digested so a
 * changed thread blocks dispatch instead of replaying stale comments. */
export async function githubCommentsRepair(input: {
  cwd: string;
  repo: string;
  number: number;
  comments: GithubWorkItemComment[];
}) {
  const comments = input.comments.slice(0, 20);
  if (!comments.length) throw new Error("Select review comments first.");
  const { head, state } = await githubRepairHead(input);
  const origin = `${state.url} · repository ${input.repo} · head ${state.headRefOid} · checkout ${head.cwd}`;
  const built = comments.map((comment) => {
    const where = comment.path
      ? `File: ${comment.path}${comment.line != null ? `, line ${comment.line}` : ""}`
      : "General discussion";
    const replies = (comment.replies ?? [])
      .slice(0, 20)
      .map((reply) => `${reply.author}:\n${reply.body}`)
      .join("\n\n");
    const context = contextFromText(
      `GitHub PR #${input.number}: ${state.title} · ${comment.author}`,
      [
        `Review comment (${comment.kind || "comment"}), state: ${comment.state || "unknown"}.`,
        where,
        `${comment.author}:\n${comment.body}`,
        replies ? `Replies:\n${replies}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      origin,
    );
    return { comment, entry: context.entries[0] };
  });
  const evidence: RepairEvidence = {
    kind: "github-comments",
    scope: `github-pr:${input.repo}#${input.number}`,
    head,
    repo: input.repo,
    number: input.number,
    comments: await Promise.all(
      built.map(async ({ comment, entry }) => ({
        id: comment.id,
        digest: await digest(comment),
        entry: entry.id,
        kind: comment.kind,
        author: comment.author,
        text: (comment.body ?? "").slice(0, 2000),
        ...(comment.path ? { file: comment.path } : {}),
        ...(comment.line != null ? { line: comment.line } : {}),
      })),
    ),
  };
  return {
    evidence,
    context: boundAgentContext({
      id: crypto.randomUUID(),
      entries: built.map(({ entry }) => entry),
      attachments: [],
      instruction:
        "Address the selected review comments in this checkout. Run relevant checks and summarize changes. Do not reply, resolve threads, push or merge.",
    }),
  };
}

/** "Fix CI" for a GitHub PR — failing check runs on the PR head, bounded and
 * digested for freshness validation at dispatch. */
export async function githubCiRepair(input: {
  cwd: string;
  repo: string;
  number: number;
}) {
  const { head, state } = await githubRepairHead(input);
  const failing = state.checks
    .filter((check) => FAILING_CHECK_CONCLUSIONS.includes(check.conclusion))
    .slice(0, 20);
  if (!failing.length)
    throw new Error("No failing checks on this PR head. Refresh and retry.");
  const origin = `${state.url} · repository ${input.repo} · head ${state.headRefOid} · checkout ${head.cwd}`;
  const built = failing.map((check) => {
    const context = contextFromText(
      `GitHub check · ${check.name}`,
      [
        `Check "${check.name}" on ${state.headRefName} (${state.headRefOid.slice(0, 8)}): ${check.conclusion}.`,
        check.outputTitle ? `Output: ${check.outputTitle}` : "",
        check.outputText
          ? `Bounded check output; common secret patterns and terminal controls removed. Review before sending.\n\n${check.outputText}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      check.url ? `${origin} · check ${check.url}` : origin,
    );
    return { check, entry: context.entries[0] };
  });
  const evidence: RepairEvidence = {
    kind: "github-ci",
    scope: `github-ci:${input.repo}#${input.number}`,
    head,
    repo: input.repo,
    number: input.number,
    checks: await Promise.all(
      built.map(async ({ check, entry }) => ({
        name: check.name,
        digest: await digest({
          name: check.name,
          conclusion: check.conclusion,
          output: `${check.outputTitle}\n${check.outputText}`,
        }),
        entry: entry.id,
        conclusion: check.conclusion,
        url: check.url,
      })),
    ),
  };
  return {
    evidence,
    context: boundAgentContext({
      id: crypto.randomUUID(),
      entries: built.map(({ entry }) => entry),
      attachments: [],
      instruction:
        "Fix the failing checks on this PR in this checkout. Run relevant checks and summarize changes. Do not rerun workflows, push or merge.",
    }),
  };
}

/** True when a git remote URL points at the GitLab project path — covers
 * https/ssh transports, a `.git` suffix and a relative-URL-root prefix. */
const gitlabRemoteMatches = (url: string, repo: string) => {
  const repoPath = repo.trim().toLowerCase();
  if (!repoPath) return false;
  const trimmed = url
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
  const path = trimmed.includes("://")
    ? (trimmed.split("://")[1]?.split("/").slice(1).join("/") ?? "")
    : trimmed.includes(":")
      ? trimmed.slice(trimmed.indexOf(":") + 1)
      : "";
  return path === repoPath || path.endsWith(`/${repoPath}`);
};

/** GitLab MR-head binding for a repair: the checkout must resolve to the
 * MR's project and sit at its head commit on its source branch. A mismatch
 * is a visible error, never a silent fixup. */
async function gitlabRepairHead(input: {
  cwd: string;
  repo: string;
  number: number;
}): Promise<{ head: CiHead; state: GitlabMrState }> {
  const state = await gitlabMrState(input.cwd, input.number);
  if (state.state !== "open")
    throw new Error("The merge request is no longer open. Refresh and retry.");
  if (!state.headSha || !state.headRefName)
    throw new Error("GitLab did not report the MR head. Refresh and retry.");
  const resolved = await gitlabRepo(input.cwd).catch(() => "");
  if (resolved.toLowerCase() !== input.repo.toLowerCase())
    throw new Error(
      `This checkout resolves to ${resolved || "no GitLab project"}; the MR belongs to ${input.repo}. Open that project's checkout.`,
    );
  const checkout = await ciContext(input.cwd);
  const remote = checkout.remotes.find((row) =>
    gitlabRemoteMatches(row.url, input.repo),
  );
  if (!remote)
    throw new Error(
      `This checkout has no remote for ${input.repo}. Open the MR's checkout.`,
    );
  if (
    checkout.commit !== state.headSha ||
    checkout.branch !== state.headRefName
  )
    throw new Error(
      `Checkout is not at the MR head (${state.headRefName} · ${state.headSha.slice(0, 8)}). Update the checkout first.`,
    );
  return {
    head: {
      cwd: checkout.cwd,
      branch: checkout.branch,
      commit: checkout.commit,
      remote: remote.url,
    },
    state,
  };
}

/** "Address comments" for a GitLab MR — discussion evidence digested so a
 * changed discussion blocks dispatch instead of replaying stale comments. */
export async function gitlabCommentsRepair(input: {
  cwd: string;
  repo: string;
  number: number;
  comments: GitlabWorkItemComment[];
}) {
  const comments = input.comments.slice(0, 20);
  if (!comments.length) throw new Error("Select review comments first.");
  const { head, state } = await gitlabRepairHead(input);
  const origin = `${state.url} · project ${input.repo} · head ${state.headSha} · checkout ${head.cwd}`;
  const built = comments.map((comment) => {
    const where = comment.path
      ? `File: ${comment.path}${comment.line != null ? `, line ${comment.line}` : ""}`
      : "General discussion";
    const replies = (comment.replies ?? [])
      .slice(0, 20)
      .map((reply) => `${reply.author}:\n${reply.body}`)
      .join("\n\n");
    const context = contextFromText(
      `GitLab MR !${input.number}: ${state.title} · ${comment.author}`,
      [
        `Review comment, resolved: ${comment.resolved ? "yes" : "no"}.`,
        where,
        `${comment.author}:\n${comment.body}`,
        replies ? `Replies:\n${replies}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      origin,
    );
    return { comment, entry: context.entries[0] };
  });
  const evidence: RepairEvidence = {
    kind: "gitlab-comments",
    scope: `gitlab-mr:${input.repo}#${input.number}`,
    head,
    repo: input.repo,
    number: input.number,
    comments: await Promise.all(
      built.map(async ({ comment, entry }) => ({
        id: comment.id,
        digest: await digest(comment),
        entry: entry.id,
        author: comment.author,
        text: (comment.body ?? "").slice(0, 2000),
        ...(comment.path ? { file: comment.path } : {}),
        ...(comment.line != null ? { line: comment.line } : {}),
      })),
    ),
  };
  return {
    evidence,
    context: boundAgentContext({
      id: crypto.randomUUID(),
      entries: built.map(({ entry }) => entry),
      attachments: [],
      instruction:
        "Address the selected review comments in this checkout. Run relevant checks and summarize changes. Do not reply, resolve discussions, push or merge.",
    }),
  };
}

const FAILING_PIPELINE_STATUSES = ["failed", "canceled"];

/** "Fix pipeline" for a GitLab MR — the head pipeline, digested so a
 * replaced or re-run pipeline blocks dispatch of stale evidence. */
export async function gitlabPipelineRepair(input: {
  cwd: string;
  repo: string;
  number: number;
}) {
  const { head, state } = await gitlabRepairHead(input);
  const pipeline = state.pipeline;
  if (!pipeline || !FAILING_PIPELINE_STATUSES.includes(pipeline.status))
    throw new Error("No failing pipeline on this MR head. Refresh and retry.");
  const origin = `${state.url} · project ${input.repo} · head ${state.headSha} · checkout ${head.cwd}`;
  const context = contextFromText(
    `GitLab pipeline #${pipeline.id}`,
    `Pipeline #${pipeline.id} on ${state.headRefName} (${state.headSha.slice(0, 8)}): ${pipeline.status}. Review the failing jobs in GitLab before sending.`,
    pipeline.url ? `${origin} · pipeline ${pipeline.url}` : origin,
  );
  const evidence: RepairEvidence = {
    kind: "gitlab-ci",
    scope: `gitlab-ci:${input.repo}#${input.number}`,
    head,
    repo: input.repo,
    number: input.number,
    pipeline: {
      id: pipeline.id,
      digest: await digest({
        id: pipeline.id,
        sha: pipeline.sha,
        status: pipeline.status,
      }),
      entry: context.entries[0].id,
      status: pipeline.status,
      url: pipeline.url,
    },
  };
  return {
    evidence,
    context: boundAgentContext({
      id: crypto.randomUUID(),
      entries: [context.entries[0]],
      attachments: [],
      instruction:
        "Fix the failing pipeline for this MR in this checkout. Run relevant checks and summarize changes. Do not rerun pipelines, push or merge.",
    }),
  };
}

export async function validateRepair(
  evidence: RepairEvidence,
  context: AgentContext,
) {
  if (!context.entries.length || !context.instruction?.trim())
    throw new Error("Select evidence and enter a repair instruction.");
  const checkout = await ciContext(evidence.head.cwd);
  if (
    checkout.commit !== evidence.head.commit ||
    checkout.branch !== evidence.head.branch ||
    !checkout.remotes.some((row) => row.url === evidence.head.remote)
  )
    throw new Error("Checkout changed. Close this draft and Refresh evidence.");
  if (evidence.kind === "ci") {
    const log = await ciRead<CiLog>(
      evidence.source.target,
      evidence.head,
      evidence.run,
      "log",
      {
        recordId: evidence.job.id,
        attempt: evidence.log.attempt,
        logId: evidence.log.logId,
        startLine: evidence.log.startLine,
      },
    );
    const fresh = ciLogContext(
      evidence.source,
      evidence.head,
      evidence.run,
      evidence.job,
      log,
    );
    if (fresh.entries[0].text !== context.entries[0]?.text)
      throw new Error(
        "Log evidence changed. Close this draft and Refresh evidence.",
      );
  } else if (evidence.kind === "github-comments") {
    const state = await githubPrState(evidence.head.cwd, evidence.number);
    if (state.state.toUpperCase() !== "OPEN")
      throw new Error("PR is no longer open. Refresh evidence.");
    // The remote head may have moved after evidence was captured — a local
    // checkout still matching the old head is not enough.
    if (
      state.headRefOid !== evidence.head.commit ||
      state.headRefName !== evidence.head.branch
    )
      throw new Error(
        "The PR head moved. Close this draft and Refresh evidence.",
      );
    const thread = await githubWorkItemThread(
      evidence.head.cwd,
      "pr",
      evidence.number,
      { force: true },
    );
    for (const selected of evidence.comments.filter((row) =>
      context.entries.some((entry) => entry.id === row.entry),
    )) {
      const comment = thread.comments.find((row) => row.id === selected.id);
      if (!comment || (await digest(comment)) !== selected.digest)
        throw new Error(
          "Selected comments changed. Close this draft and Refresh evidence.",
        );
    }
  } else if (evidence.kind === "github-ci") {
    const state = await githubPrState(evidence.head.cwd, evidence.number);
    if (state.state.toUpperCase() !== "OPEN")
      throw new Error("PR is no longer open. Refresh evidence.");
    if (
      state.headRefOid !== evidence.head.commit ||
      state.headRefName !== evidence.head.branch
    )
      throw new Error(
        "The PR head moved. Close this draft and Refresh evidence.",
      );
    for (const selected of evidence.checks.filter((row) =>
      context.entries.some((entry) => entry.id === row.entry),
    )) {
      const check = state.checks.find((row) => row.name === selected.name);
      if (
        !check ||
        (await digest({
          name: check.name,
          conclusion: check.conclusion,
          output: `${check.outputTitle}\n${check.outputText}`,
        })) !== selected.digest
      )
        throw new Error(
          "Check output changed. Close this draft and Refresh evidence.",
        );
    }
  } else if (evidence.kind === "gitlab-comments") {
    const state = await gitlabMrState(evidence.head.cwd, evidence.number);
    if (state.state !== "open")
      throw new Error("MR is no longer open. Refresh evidence.");
    if (
      state.headSha !== evidence.head.commit ||
      state.headRefName !== evidence.head.branch
    )
      throw new Error(
        "The MR head moved. Close this draft and Refresh evidence.",
      );
    const thread = await gitlabMrDiscussions(
      evidence.head.cwd,
      evidence.number,
      { force: true },
    );
    const flat = thread.comments.flatMap((row) => [row, ...row.replies]);
    for (const selected of evidence.comments.filter((row) =>
      context.entries.some((entry) => entry.id === row.entry),
    )) {
      const comment = flat.find((row) => row.id === selected.id);
      if (!comment || (await digest(comment)) !== selected.digest)
        throw new Error(
          "Selected discussions changed. Close this draft and Refresh evidence.",
        );
    }
  } else if (evidence.kind === "gitlab-ci") {
    const state = await gitlabMrState(evidence.head.cwd, evidence.number);
    if (state.state !== "open")
      throw new Error("MR is no longer open. Refresh evidence.");
    if (
      state.headSha !== evidence.head.commit ||
      state.headRefName !== evidence.head.branch
    )
      throw new Error(
        "The MR head moved. Close this draft and Refresh evidence.",
      );
    const pipeline = state.pipeline;
    if (
      context.entries.some((entry) => entry.id === evidence.pipeline.entry) &&
      (!pipeline ||
        (await digest({
          id: pipeline.id,
          sha: pipeline.sha,
          status: pipeline.status,
        })) !== evidence.pipeline.digest)
    )
      throw new Error(
        "Pipeline evidence changed. Close this draft and Refresh evidence.",
      );
  } else {
    const pr = await readAzurePr(
      evidence.association.target,
      evidence.association.revision,
    );
    if (pr.pr.status !== "active")
      throw new Error("PR is no longer active. Refresh evidence.");
    const page = await readAzurePrSection<AzurePrThread>(
      evidence.association.target,
      evidence.association.revision,
      "threads",
      evidence.skip,
    );
    for (const selected of evidence.threads.filter((row) =>
      context.entries.some((entry) => entry.id === row.entry),
    )) {
      const thread = page.items.find((row) => row.id === selected.id);
      if (
        !thread ||
        !unresolvedThread(thread) ||
        (await digest(thread)) !== selected.digest
      )
        throw new Error(
          "Selected comments changed. Close this draft and Refresh evidence.",
        );
    }
  }
}
