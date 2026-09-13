import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  GITLAB_CHANGE_EVENT,
  gitlabMrDiff,
  gitlabMrDiscussionReply,
  gitlabMrDiscussionResolve,
  gitlabMrDiscussions,
  gitlabMrState,
  peekGitlabMrDiff,
  peekGitlabMrDiscussions,
  type GitlabMrDiff,
  type GitlabMrState,
  type GitlabWorkItemComment,
  type GitlabWorkItemThread,
} from "../lib/gitlab";
import {
  FAILING_PIPELINE_STATUSES,
  gitlabCommentsRepair,
  gitlabPipelineRepair,
  type RepairEvidence,
} from "../lib/repair";
import { requestAgentContext, type AgentContext } from "../lib/agentContext";
import { RepairStatus } from "./RepairStatus";
import { InboxPrDiff } from "../surfaces/InboxPrDiff";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";

const button =
  "rounded-md px-2 py-1 text-[12px] text-content hover:bg-content/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";
const field =
  "w-full rounded-md border border-content/15 bg-content/5 px-2 py-1.5 text-[12px] text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isReviewThread = (comment: GitlabWorkItemComment) =>
  comment.kind === "review";

/** Same shape as the repair evidence scope — project path case is
 * significant. */
function gitlabMrScope(repo: string, number: number): string {
  return `gitlab-mr:${repo.trim()}#${number}`;
}

/** GitLab's snake_case merge verdicts, made readable. */
function mergeStatusLabel(status: string): string {
  const value = status.trim().toLowerCase();
  if (!value) return "";
  const known: Record<string, string> = {
    mergeable: "Mergeable",
    can_be_merged: "Mergeable",
    cannot_be_merged: "Cannot be merged",
    cannot_be_merged_recheck: "Merge check needed",
    checking: "Checking merge…",
    unchecked: "Merge unchecked",
    ci_must_pass: "Pipeline must pass",
    ci_still_running: "Pipeline running",
    discussions_not_resolved: "Discussions unresolved",
    blocked_status: "Blocked",
    draft_status: "Draft",
    need_rebase: "Needs rebase",
    not_open: "Not open",
    conflict: "Conflicts",
    broken_status: "Broken status",
    approvals_syncing: "Approvals syncing",
    external_status_checks: "External checks",
    locked_paths: "Locked paths",
    preparing: "Preparing",
    requested_changes: "Changes requested",
    denied_policies_denied: "Denied by policy",
  };
  return known[value] ?? value.replace(/_/g, " ");
}

function pipelineStatusLabel(status: string): string {
  const value = status.trim().toLowerCase();
  return value ? value.replace(/_/g, " ") : "none";
}

/**
 * GitLab merge-request review — the MR identity is explicit (project path +
 * iid) and verified against the checkout, so identical numbers in different
 * projects never share a surface.
 */
export function GitlabMrReview({
  embedded = false,
  cwd,
  repo,
  number,
  branch = "",
  sourceSessionId,
  enabled,
  onClose,
  onReveal,
}: {
  embedded?: boolean;
  cwd: string;
  /** GitLab project path the MR lives in — empty resolves it from the checkout. */
  repo: string;
  number: number;
  branch?: string;
  sourceSessionId?: string;
  enabled: boolean;
  onClose: () => void;
  onReveal?: () => void;
}) {
  if (enabled && number <= 0)
    return (
      <p role="alert" className="px-5 py-4 text-[12px]">
        This delivery is missing its GitLab project or MR number. Open the
        review again from the MR or a session checkout.
      </p>
    );
  return enabled ? (
    <GitlabMrPanel
      key={gitlabMrScope(repo || cwd, number)}
      embedded={embedded}
      cwd={cwd}
      repo={repo}
      number={number}
      branch={branch}
      sourceSessionId={sourceSessionId}
      onClose={onClose}
      onReveal={onReveal}
    />
  ) : null;
}

function GitlabMrPanel({
  embedded,
  cwd,
  repo: boundRepo,
  number,
  branch,
  sourceSessionId,
  onClose,
  onReveal,
}: {
  embedded?: boolean;
  cwd: string;
  repo: string;
  number: number;
  branch?: string;
  sourceSessionId?: string;
  onClose: () => void;
  onReveal?: () => void;
}) {
  const [mr, setMr] = useState<GitlabMrState | null>(null);
  const [repo, setRepo] = useState(boundRepo);
  const [repoError, setRepoError] = useState("");
  const [diff, setDiff] = useState<GitlabMrDiff | null>(() =>
    peekGitlabMrDiff(cwd, number),
  );
  const [thread, setThread] = useState<GitlabWorkItemThread | null>(() =>
    peekGitlabMrDiscussions(cwd, number),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const [repairRefresh, setRepairRefresh] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const repairDraft = useRef<{ key: string; instruction: string } | null>(null);
  const scope = gitlabMrScope(repo || boundRepo || cwd, number);

  useEffect(() => {
    mounted.current = true;
    // An <Activity> hide interrupts in-flight actions; their finally blocks
    // bail on the generation check, so re-arm the panel on re-show.
    pending.current = false;
    setBusy(false);
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);

  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (pending.current) return;
    const id = generation.current;
    const current = () => mounted.current && generation.current === id;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action(current);
    } catch (error) {
      if (current()) setError(message(error));
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  const refresh = () =>
    run(async (current) => {
      const [state, nextDiff, nextThread] = await Promise.all([
        gitlabMrState(cwd, number),
        gitlabMrDiff(cwd, number).catch(() => null),
        gitlabMrDiscussions(cwd, number, { force: true }),
      ]);
      if (!current()) return;
      // `state.repo` is resolved fresh in the backend — the project binding
      // is part of the MR identity, so a checkout that now resolves to a
      // different project must not show this MR's number.
      if (
        boundRepo &&
        state.repo.toLowerCase() !== boundRepo.toLowerCase()
      ) {
        setVerified(false);
        setMr(null);
        setDiff(null);
        setThread(null);
        setRepoError(
          `This checkout resolves to ${state.repo}; the MR is bound to ${boundRepo}. Open a checkout of that project.`,
        );
        return;
      }
      setRepoError("");
      if (state.repo && state.repo !== repo) setRepo(state.repo);
      if (state.number !== number)
        throw new Error(
          "GitLab returned a different merge request. Check the project binding.",
        );
      setMr(state);
      setDiff(nextDiff);
      setThread(nextThread);
      setVerified(true);
    });

  useEffect(() => {
    void refresh();
    // Read once on open or after an evidence refresh; never polls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairRefresh]);

  useEffect(() => {
    const onChange = () => void refresh();
    window.addEventListener(GITLAB_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(GITLAB_CHANGE_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefreshEvidence = (instruction: string) => {
    repairDraft.current = { key: scope, instruction };
    onReveal?.();
    setRepairRefresh((value) => value + 1);
  };
  const repairInstruction =
    repairDraft.current?.key === scope
      ? repairDraft.current.instruction
      : undefined;

  const sendEvidence = (
    prepare: () => Promise<{
      evidence: RepairEvidence;
      context: AgentContext;
    }>,
  ) =>
    run(async (current) => {
      const draft = await prepare();
      if (!current()) return;
      requestAgentContext({
        context: {
          ...draft.context,
          instruction: repairInstruction ?? draft.context.instruction,
        },
        repair: draft.evidence,
        onRefreshEvidence,
        cwd: draft.evidence.head.cwd,
        sourceSessionId,
        requireDestinationSelection: !sourceSessionId,
        onPrepared: onClose,
      });
    });

  const sendComments = (comments: GitlabWorkItemComment[]) =>
    sendEvidence(() => gitlabCommentsRepair({ cwd, repo, number, comments }));

  const sendPipeline = () =>
    sendEvidence(() => gitlabPipelineRepair({ cwd, repo, number }));

  const threads = (thread?.comments ?? []).filter(isReviewThread);
  const conversation = (thread?.comments ?? []).filter(
    (comment) => !isReviewThread(comment),
  );
  // Batch send matches the per-thread action: every unresolved review
  // discussion, resolvable or not, is feedback the agent should see.
  const unresolved = threads.filter((comment) => !comment.resolved);
  const pipeline = mr?.pipeline ?? null;
  const pipelineFailing =
    !!pipeline && FAILING_PIPELINE_STATUSES.includes(pipeline.status);
  const approvalsSummary = (() => {
    if (!mr) return "";
    if (mr.approved) return "Approved";
    if (!mr.approvalsRequired) return "";
    const given = Math.max(0, mr.approvalsRequired - mr.approvalsLeft);
    return `${given}/${mr.approvalsRequired} approvals`;
  })();

  return (
    <section
      aria-label="GitLab merge request"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div className="mx-auto w-full max-w-3xl space-y-3 px-5 py-4 text-[12px]">
        {!embedded ? (
          <header className="flex items-center justify-between gap-3 border-b border-content/10 pb-3">
            <h2 className="text-[13px] font-medium">Merge request</h2>
            <span className="truncate text-content/50" title={cwd}>
              {repo ? `${repo} · ` : ""}
              {branch || "Repository checkout"}
            </span>
          </header>
        ) : null}
        {mr ? (
          <section className="space-y-2">
            {!embedded ? (
              <h3 className="font-medium">
                !{mr.number} {mr.title}
              </h3>
            ) : null}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-content/55">
              <span className="rounded bg-content/5 px-1.5 py-0.5 text-[11px] text-content/75">
                {mr.draft
                  ? "Draft"
                  : mr.state === "open"
                    ? "Open"
                    : mr.state || "Unknown"}
              </span>
              {repo ? <span>{repo}</span> : null}
              {approvalsSummary ? <span>{approvalsSummary}</span> : null}
              {mergeStatusLabel(mr.mergeStatus) ? (
                <span>Merge: {mergeStatusLabel(mr.mergeStatus)}</span>
              ) : null}
              {!mr.blockingDiscussionsResolved ? (
                <span className="text-rose-400/90">
                  Blocking discussions unresolved
                </span>
              ) : null}
              {pipeline ? (
                <span
                  className={
                    pipelineFailing
                      ? "text-rose-400/90"
                      : pipeline.status === "success"
                        ? "text-emerald-400/90"
                        : "text-content/60"
                  }
                >
                  Pipeline: {pipelineStatusLabel(pipeline.status)}
                </span>
              ) : null}
              <span
                className="min-w-0 truncate"
                title={`${mr.headRefName} → ${mr.baseRefName}`}
              >
                {mr.headRefName} → {mr.baseRefName}
              </span>
            </p>
            <details>
              <summary className="cursor-pointer text-content/60">
                Project and revision
              </summary>
              <p className="break-all text-content/55">
                Project: {repo || "resolved from checkout"}
                <br />
                {mr.headRefName} → {mr.baseRefName}
                <br />
                Head revision: {mr.headSha || "unknown"}
              </p>
            </details>
            <div className="flex flex-wrap gap-1">
              <button
                className={button}
                disabled={busy}
                onClick={() => void refresh()}
              >
                Refresh MR
              </button>
              <button
                className={button}
                onClick={() => {
                  void openUrl(mr.url).catch((error) =>
                    setError(message(error)),
                  );
                }}
              >
                Open on GitLab
              </button>
            </div>
          </section>
        ) : null}
        {repoError ? <p role="alert">{repoError}</p> : null}
        {!verified && !repoError ? (
          <p>
            {busy
              ? "Loading merge request…"
              : "Could not read this MR. Retry with Refresh MR."}
          </p>
        ) : null}
        {verified && mr ? (
          <>
            <RepairStatus scope={gitlabMrScope(repo, number)} cwd={cwd} />
            <RepairStatus scope={`gitlab-ci:${repo}#${number}`} cwd={cwd} />
          </>
        ) : null}
        {verified && mr ? (
          <GitlabMrSections
            key={`${mr.headSha}:${repairRefresh}`}
            cwd={cwd}
            number={number}
            mr={mr}
            diff={diff}
            thread={thread}
            threads={threads}
            conversation={conversation}
            unresolved={unresolved}
            pipelineFailing={pipelineFailing}
            busy={busy}
            sendComments={sendComments}
            sendPipeline={sendPipeline}
            onThreadRefresh={() => void refresh()}
          />
        ) : null}
        {error ? (
          <p role="alert" className="break-words">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function GitlabMrSections({
  cwd,
  number,
  mr,
  diff,
  thread,
  threads,
  conversation,
  unresolved,
  pipelineFailing,
  busy,
  sendComments,
  sendPipeline,
  onThreadRefresh,
}: {
  cwd: string;
  number: number;
  mr: GitlabMrState;
  diff: GitlabMrDiff | null;
  thread: GitlabWorkItemThread | null;
  threads: GitlabWorkItemComment[];
  conversation: GitlabWorkItemComment[];
  unresolved: GitlabWorkItemComment[];
  pipelineFailing: boolean;
  busy: boolean;
  sendComments: (comments: GitlabWorkItemComment[]) => void;
  sendPipeline: () => void;
  onThreadRefresh: () => void;
}) {
  const open = mr.state === "open";
  const pipeline = mr.pipeline;
  return (
    <div className="space-y-2">
      {open && unresolved.length ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => sendComments(unresolved)}
        >
          Address comments
        </button>
      ) : null}
      {open && pipelineFailing ? (
        <button className={button} disabled={busy} onClick={sendPipeline}>
          Send failing pipeline to agent
        </button>
      ) : null}
      {pipeline ? (
        <details className="rounded-md border border-content/10 px-2 py-1">
          <summary className="cursor-pointer text-content/60">
            Pipeline #{pipeline.id} · {pipelineStatusLabel(pipeline.status)}
          </summary>
          <p className="break-all pt-1 text-content/50">
            Pipeline {pipeline.id} on {pipeline.sha.slice(0, 8) || "unknown"}
          </p>
          {pipeline.url ? (
            <button
              className={button}
              onClick={() =>
                void openUrl(pipeline.url).catch(() => undefined)
              }
            >
              Open pipeline
            </button>
          ) : null}
        </details>
      ) : null}
      <section aria-label="Merge request diff" className="space-y-1">
        <h4 className="text-content/60">Changed files</h4>
        {diff ? (
          <InboxPrDiff diff={diff} />
        ) : (
          <p className="text-content/50">
            Diff unavailable. Refresh MR to retry.
          </p>
        )}
      </section>
      <section aria-label="Review discussions" className="space-y-1">
        <h4 className="text-content/60">
          Discussions ({threads.length}
          {thread?.truncated ? " · latest page" : ""})
        </h4>
        {threads.length === 0 ? <p>No review discussions.</p> : null}
        {threads.map((comment) => (
          <GitlabReviewThread
            key={comment.id}
            cwd={cwd}
            number={number}
            comment={comment}
            open={open}
            busy={busy}
            sendComments={sendComments}
            onThreadRefresh={onThreadRefresh}
          />
        ))}
      </section>
      {conversation.length ? (
        <details className="border-t border-content/10 pt-2 text-content/60">
          <summary className="cursor-pointer">
            Conversation ({conversation.length})
          </summary>
          <div className="space-y-2 pt-2">
            {conversation.slice(0, 50).map((comment) => (
              <div key={comment.id}>
                <p className="text-content/55">{comment.author}</p>
                <AgentMarkdown text={comment.body.slice(0, 32_000)} cwd={cwd} />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function GitlabReviewThread({
  cwd,
  number,
  comment,
  open,
  busy,
  sendComments,
  onThreadRefresh,
}: {
  cwd: string;
  number: number;
  comment: GitlabWorkItemComment;
  open: boolean;
  busy: boolean;
  sendComments: (comments: GitlabWorkItemComment[]) => void;
  onThreadRefresh: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [acting, setActing] = useState<"reply" | "resolve" | "">("");
  const [actionError, setActionError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    // Re-showing after an <Activity> hide must not keep a stale busy flag.
    setActing("");
    return () => {
      mounted.current = false;
    };
  }, []);
  const allReplies = comment.replies ?? [];
  const replies = allReplies.slice(0, 50);
  const act = async (kind: "reply" | "resolve", action: () => Promise<void>) => {
    if (acting) return;
    setActing(kind);
    setActionError("");
    try {
      await action();
      if (!mounted.current) return;
      if (kind === "reply") setDraft("");
      onThreadRefresh();
    } catch (error) {
      if (mounted.current) setActionError(message(error));
    } finally {
      if (mounted.current) setActing("");
    }
  };
  const reply = () =>
    act("reply", async () => {
      if (!draft.trim()) return;
      await gitlabMrDiscussionReply(cwd, number, comment.threadId, draft);
    });
  const toggleResolve = () =>
    act("resolve", async () => {
      await gitlabMrDiscussionResolve(
        cwd,
        number,
        comment.threadId,
        !comment.resolved,
      );
    });
  return (
    <details className="rounded-md border border-content/10 px-2 py-1">
      <summary className="cursor-pointer break-words">
        {comment.path || "Review discussion"}
        {comment.line != null ? `:${comment.line}` : ""} ·{" "}
        {comment.resolved ? "Resolved" : "Unresolved"} · {1 + replies.length}{" "}
        notes
      </summary>
      <div className="space-y-2 pt-2">
        {allReplies.length > replies.length ? (
          <p className="text-content/45">
            Showing the first {replies.length} notes. Open on GitLab for the
            rest.
          </p>
        ) : null}
        {[comment, ...replies].map((row) => (
          <div key={row.id}>
            <p className="text-content/55">{row.author}</p>
            <AgentMarkdown text={row.body.slice(0, 32_000)} cwd={cwd} />
          </div>
        ))}
        <div className="flex flex-wrap gap-1">
          {open && !comment.resolved ? (
            <button
              className={button}
              disabled={busy || !!acting}
              onClick={() => sendComments([comment])}
            >
              Send discussion to agent
            </button>
          ) : null}
          {open && comment.resolvable && comment.threadId ? (
            <button
              className={button}
              disabled={busy || !!acting}
              onClick={() => void toggleResolve()}
            >
              {acting === "resolve"
                ? "Saving…"
                : comment.resolved
                  ? "Unresolve"
                  : "Resolve"}
            </button>
          ) : null}
        </div>
        {open && comment.threadId ? (
          <div className="space-y-1">
            <textarea
              aria-label="Reply to discussion"
              className={field}
              rows={2}
              maxLength={64_000}
              value={draft}
              disabled={acting === "reply"}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Reply inside this discussion…"
            />
            <button
              className={button}
              disabled={!!acting || !draft.trim()}
              onClick={() => void reply()}
            >
              {acting === "reply" ? "Replying…" : "Reply"}
            </button>
            {actionError ? <p role="alert">{actionError}</p> : null}
          </div>
        ) : actionError ? (
          <p role="alert">{actionError}</p>
        ) : null}
      </div>
    </details>
  );
}
