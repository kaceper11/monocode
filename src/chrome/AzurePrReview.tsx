import { commentsRepair, unresolvedThread } from "../lib/repair";
import { RepairStatus } from "./RepairStatus";
import {
  ReviewDetails,
  ReviewError,
  ReviewHeader,
  ReviewLineComposer,
  ReviewPill,
  ReviewShell,
  ReviewStatus,
  reviewAction,
  reviewButton,
  reviewField,
  reviewDanger,
  reviewToneText,
  type ReviewTone,
} from "./ReviewChrome";
import {
  Bot,
  Check,
  ExternalLink,
  FolderOpen,
  Loader,
  RefreshCw,
  X,
} from "./icons";
import { AzureConnectionDetails } from "./AzureConnectionDetails";
import type { LinkedWorkItem } from "../lib/session";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AZURE_CHANGE_EVENT,
  azureConnected,
  type AzureStatus,
} from "../lib/azure";
import { requestAgentContext } from "../lib/agentContext";
import { taskDestinationForSession } from "../lib/taskWorkspaces";
import { openWatchSheet } from "../lib/watchers";
import { notifyGitChanged } from "../lib/fs";
import { openProjectPath } from "../lib/recents";
import { buildUnifiedFile, type UnifiedLine } from "../lib/unifiedDiff";
import {
  UnifiedDiffView,
  type LineCommentComposer,
  type UnifiedDiffFileModel,
} from "../surfaces/UnifiedDiffView";
import {
  azurePrContext,
  discoverAzurePrs,
  loadAzurePrAssociations,
  azurePrKey,
  type AzurePrDiscoveryGroup,
  azurePrScope,
  azurePrUrl,
  azurePrSubmitReview,
  azurePrThreadComment,
  azurePrThreadStatus,
  azureReviewAnchor,
  findAzurePrs,
  loadAzurePrAssociation,
  parseAzurePrLocation,
  readAzurePr,
  readAzurePrDiff,
  readAzurePrSection,
  saveAzurePrAssociation,
  type AzurePr,
  type AzurePrAssociation,
  type AzurePrDiff,
  type AzurePrPage,
  type AzurePrReviewEvent,
  type AzurePrTarget,
  type AzurePrThread,
  type AzureReviewCommentDraft,
} from "../lib/azureRepos";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";

const button = reviewButton;
const drafts = new Map<string, { link: string; branch: string }>();
const threadSelections = new Map<string, { id: number | null; page: number }>();
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function AzurePrReview({
  embedded = false,
  cwd,
  branch,
  sourceSessionId,
  enabled,
  linkedWorkItem,
  onClose,
  onReveal,
}: {
  embedded?: boolean;
  cwd: string;
  branch: string;
  sourceSessionId?: string;
  enabled: boolean;
  linkedWorkItem?: LinkedWorkItem;
  onClose: () => void;
  onReveal?: () => void;
}) {
  const [association, setAssociation] = useState(() =>
    loadAzurePrAssociation(cwd, branch, sourceSessionId),
  );
  const update = (value: AzurePrAssociation | null) => {
    saveAzurePrAssociation(
      value,
      cwd,
      branch,
      sourceSessionId,
      association?.target,
    );
    setAssociation(
      value ?? loadAzurePrAssociation(cwd, branch, sourceSessionId),
    );
  };
  useEffect(() => {
    setAssociation(loadAzurePrAssociation(cwd, branch, sourceSessionId));
  }, [cwd, branch, sourceSessionId]);
  return enabled ? (
    <AzurePrPanel
      embedded={embedded}
      key={azurePrScope(cwd, branch, sourceSessionId)}
      cwd={cwd}
      branch={branch}
      sourceSessionId={sourceSessionId}
      linkedWorkItem={linkedWorkItem}
      association={association}
      onChange={update}
      onClose={onClose}
      onReveal={onReveal}
    />
  ) : null;
}

function AzurePrPanel({
  embedded,
  cwd,
  branch,
  sourceSessionId,
  association,
  linkedWorkItem,
  onChange,
  onClose,
  onReveal,
}: {
  embedded?: boolean;
  cwd: string;
  branch: string;
  sourceSessionId?: string;
  association: AzurePrAssociation | null;
  linkedWorkItem?: LinkedWorkItem;
  onChange: (value: AzurePrAssociation | null) => void;
  onClose: () => void;
  onReveal?: () => void;
}) {
  const [status, setStatus] = useState<AzureStatus | null>(null);
  const [choosing, setChoosing] = useState(!association);
  const [linking, setLinking] = useState(false);
  const [repairRefresh, setRepairRefresh] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [discovery, setDiscovery] = useState<{
    groups: AzurePrDiscoveryGroup[];
    errors: string[];
  } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const scope = azurePrScope(cwd, branch, sourceSessionId);
  const [link, setLink] = useState(
    drafts.get(scope)?.link ??
      (association ? azurePrUrl(association.target) : ""),
  );
  const [lookupBranch, setLookupBranch] = useState(
    drafts.get(scope)?.branch ?? branch,
  );
  const rememberDraft = (link: string, branch: string) => {
    drafts.delete(scope);
    drafts.set(scope, { link, branch });
    if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
  };
  const [candidates, setCandidates] = useState<Awaited<
    ReturnType<typeof findAzurePrs>
  > | null>(null);
  const [lookup, setLookup] = useState<AzurePrTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  // Unlinking must not let a still-resolving discovery auto re-link the PR.
  const suppressAutoChoose = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const repairDraft = useRef<{ key: string; instruction: string } | null>(null);
  const preparation = useRef<AbortController | null>(null);
  useEffect(() => {
    const refresh = () => {
      const run = ++generation.current;
      pending.current = false;
      setBusy(false);
      // `verified` stays — `sameAccount` gates display until the refreshed
      // status lands, so the panel does not collapse on an account event.
      setCandidates(null);
      void azureConnected()
        .then((next) => {
          if (generation.current === run) setStatus(next);
        })
        .catch((error) => {
          if (generation.current === run) setError(message(error));
        });
    };
    refresh();
    window.addEventListener(AZURE_CHANGE_EVENT, refresh);
    return () => {
      generation.current++;
      preparation.current?.abort();
      window.removeEventListener(AZURE_CHANGE_EVENT, refresh);
    };
  }, []);
  useEffect(() => {
    if (embedded || !status?.connected || !status.accountId) {
      setDiscovery(null);
      return;
    }
    let cancelled = false;
    const id = generation.current;
    setDiscovering(true);
    setDiscovery(null);
    void discoverAzurePrs(
      cwd,
      branch,
      status,
      linkedWorkItem,
      () => !cancelled && generation.current === id,
    )
      .then((result) => {
        if (!cancelled && generation.current === id) setDiscovery(result);
      })
      .catch((error) => {
        if (!cancelled && generation.current === id)
          setDiscovery({ groups: [], errors: [message(error)] });
      })
      .finally(() => {
        if (!cancelled && generation.current === id) setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, branch, status, linkedWorkItem, discoveryVersion]);
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    const id = generation.current;
    setBusy(true);
    setError("");
    try {
      await action(() => id === generation.current);
    } catch (error) {
      if (id === generation.current) setError(message(error));
    } finally {
      if (id === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const find = (skip = 0) =>
    run(async (current) => {
      if (!status?.connected || !status.accountId)
        throw new Error("Connect Azure DevOps in Settings first.");
      const location =
        skip && lookup
          ? lookup
          : { ...parseAzurePrLocation(link), accountId: status.accountId };
      if (location.site !== status.site)
        throw new Error(
          `This link belongs to ${location.site}. Connect that organization in Settings or choose a link from ${status.site}.`,
        );
      const result = await findAzurePrs(location, lookupBranch, skip);
      if (current()) {
        setLookup(location);
        setCandidates(result);
      }
    });
  const choose = (pr: AzurePr, group = candidates) =>
    run(async (current) => {
      if (!group || !status) return;
      const target = { ...group.target, number: pr.pullRequestId };
      const summary = await readAzurePr(target);
      if (!current()) return;
      onChange({
        ...summary,
        target,
        cwd,
        branch,
        sourceSessionId,
        account: status.account,
        repositoryName: group.repositoryName,
        projectName: group.projectName,
      });
      setVerified(true);
      setCandidates(null);
      setChoosing(false);
      setLinking(false);
      drafts.delete(scope);
    });
  useEffect(() => {
    if (
      suppressAutoChoose.current ||
      association ||
      link.trim() ||
      !discovery ||
      discovery.errors.length ||
      discovery.groups.some((group) => group.nextSkip != null)
    )
      return;
    const matches = discovery.groups.flatMap((group) =>
      group.items.map((pr) => ({ pr, group })),
    );
    if (matches.length === 1) void choose(matches[0].pr, matches[0].group);
    // A completed discovery may select a unique match; later unlinking does not rerun discovery.
  }, [discovery]);
  const refresh = () =>
    run(async (current) => {
      if (!association) return;
      const summary = await readAzurePr(association.target).catch((error) => {
        if (current()) setVerified(false);
        throw error;
      });
      if (current()) {
        onChange({ ...association, ...summary });
        setVerified(true);
        setRefreshKey((key) => key + 1);
      }
    });
  const openWorktree = () =>
    run(async (current) => {
      if (!association) return;
      const requestId = crypto.randomUUID();
      const controller = new AbortController();
      controller.signal.addEventListener(
        "abort",
        () => {
          void invoke("azure_pr_cancel_checkout", { requestId }).catch(
            () => undefined,
          );
        },
        { once: true },
      );
      preparation.current = controller;
      try {
        const path = await invoke<string>("azure_pr_prepare_checkout", {
          cwd,
          target: association.target,
          expectedRevision: association.revision,
          requestId,
        });
        if (!current() || controller.signal.aborted) return;
        notifyGitChanged(cwd);
        openProjectPath(path);
      } finally {
        if (preparation.current === controller) preparation.current = null;
      }
    });
  const connected = !!status?.connected && !!status.accountId;
  const sameAccount =
    !!association &&
    status?.site === association.target.site &&
    status?.accountId === association.target.accountId;
  useEffect(() => {
    if (sameAccount) void refresh();
    // Read once on opening or reconnecting; saving the result must not poll.
  }, [status, repairRefresh]);
  return (
    <ReviewShell label="Azure pull request">
      {!embedded ? (
        <ReviewHeader
          label="Pull request"
          context={`${association ? `${association.repositoryName} · ` : ""}${branch || "Detached checkout"}`}
          title={cwd}
        />
      ) : null}
      <AzureConnectionDetails
        label="Azure Repos"
        status={status ?? undefined}
        connected={connected}
        connectHint="Connect the shared Azure DevOps account to inspect PRs."
        onLeave={onClose}
        onError={setError}
      />
      {choosing && association ? (
        <p className="flex flex-wrap items-center gap-2 text-content/50">
          <span className="min-w-0 truncate">
            Currently linked: #{association.pr.pullRequestId}{" "}
            {association.pr.title}
          </span>
          {!embedded ? (
            <button
              className={reviewDanger}
              disabled={busy}
              onClick={() => {
                try {
                  suppressAutoChoose.current = true;
                  onChange(null);
                  setVerified(false);
                } catch (error) {
                  setError(message(error));
                }
              }}
            >
              Unlink PR
            </button>
          ) : null}
        </p>
      ) : null}
      {choosing ? (
        <section className="space-y-2" aria-label="Related Azure PRs">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">Linked to this work</h3>
            <div className="flex items-center gap-1">
              {!embedded ? (
                <button
                  className={button}
                  disabled={discovering || !connected}
                  onClick={() => setDiscoveryVersion((value) => value + 1)}
                >
                  Refresh matches
                </button>
              ) : null}
              {association && !linking ? (
                <button className={button} onClick={() => setChoosing(false)}>
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
          {discovering ? (
            <ReviewStatus>
              Finding story links, then branch matches…
            </ReviewStatus>
          ) : null}
          {discovery?.errors.map((error) => (
            <p key={error} className="break-words text-content/60">
              {error}
            </p>
          ))}
          {discovery &&
          !discovery.groups.some((group) => group.items.length) ? (
            <p className="text-content/60">
              No accessible PR found for this story or branch. Link an existing
              PR to review it here.
            </p>
          ) : null}
          {discovery?.groups.map((group, groupIndex) => (
            <div
              key={`${azurePrKey(group.target)}:${groupIndex}`}
              className="space-y-1"
            >
              {group.items.length ? (
                <p className="break-words text-content/50">
                  {group.origins.join(" · ")}
                </p>
              ) : null}
              {group.items.map((pr) => (
                <button
                  key={pr.pullRequestId}
                  className={`${button} block w-full text-left`}
                  disabled={busy}
                  onClick={() => void choose(pr, group)}
                >
                  <span className="block">
                    #{pr.pullRequestId} {pr.title} · {pr.status}
                  </span>
                  <span className="block break-words text-content/50">
                    {group.projectName}/{group.repositoryName} ·{" "}
                    {pr.sourceRefName} → {pr.targetRefName} ·{" "}
                    {pr.lastMergeSourceCommit?.commitId.slice(0, 8) ??
                      "unknown revision"}
                  </span>
                </button>
              ))}
              {group.nextSkip != null ? (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(async (current) => {
                      const page = await findAzurePrs(
                        group.target,
                        branch,
                        group.nextSkip!,
                      );
                      if (current())
                        setDiscovery((previous) =>
                          previous
                            ? {
                                ...previous,
                                groups: previous.groups.map((value, index) =>
                                  index === groupIndex
                                    ? { ...page, origins: group.origins }
                                    : value,
                                ),
                              }
                            : previous,
                        );
                    })
                  }
                >
                  Next PRs · {group.repositoryName}
                </button>
              ) : null}
            </div>
          ))}
          {loadAzurePrAssociations(cwd, branch, sourceSessionId).map(
            (saved) => (
              <button
                key={azurePrKey(saved.target)}
                className={`${button} block w-full text-left`}
                disabled={
                  busy ||
                  saved.target.accountId !== status?.accountId ||
                  saved.target.site !== status?.site
                }
                onClick={() =>
                  void choose(saved.pr, {
                    target: saved.target,
                    projectName: saved.projectName,
                    repositoryName: saved.repositoryName,
                    items: [saved.pr],
                    nextSkip: null,
                  })
                }
              >
                Saved PR #{saved.pr.pullRequestId} · {saved.projectName}/
                {saved.repositoryName} · {saved.pr.title}
              </button>
            ),
          )}
        </section>
      ) : null}
      {choosing && !linking ? (
        <button
          className={`${button} bg-content/10`}
          disabled={!connected || busy}
          onClick={() => setLinking(true)}
        >
          Link a PR
        </button>
      ) : null}
      {choosing && linking ? (
        <form
          className="max-w-lg space-y-3 rounded-md border border-content/10 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void find();
          }}
        >
          <p className="font-medium">Link a PR</p>
          <label className="block">
            PR link or repository remote
            <input
              aria-label="Azure PR link or repository remote"
              maxLength={2048}
              className={reviewField}
              value={link}
              disabled={busy}
              onChange={(event) => {
                setLink(event.target.value);
                rememberDraft(event.target.value, lookupBranch);
                setCandidates(null);
                setLookup(null);
              }}
              placeholder="https://dev.azure.com/org/project/_git/repo/pullrequest/13"
            />
          </label>
          <ReviewDetails summary="Find by branch">
            <label className="mt-2 block">
              Branch (for repository lookup)
              <input
                maxLength={1024}
                className={reviewField}
                value={lookupBranch}
                disabled={busy}
                onChange={(event) => {
                  setLookupBranch(event.target.value);
                  rememberDraft(link, event.target.value);
                  setCandidates(null);
                  setLookup(null);
                }}
              />
            </label>
          </ReviewDetails>
          <button
            className={button}
            disabled={busy || !connected || !link.trim()}
          >
            {busy ? "Verifying…" : "Find PR"}
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => {
              setLinking(false);
              setCandidates(null);
              setLookup(null);
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {error ? <ReviewError>{error}</ReviewError> : null}
      {candidates ? (
        <div className="space-y-1">
          <p>
            {candidates.items.length
              ? "Choose the exact PR to link:"
              : "No matching PR. Check the branch or paste a specific PR link."}
          </p>
          {candidates.items.map((pr) => (
            <button
              key={pr.pullRequestId}
              className={`${button} block w-full text-left`}
              disabled={busy}
              onClick={() => void choose(pr)}
            >
              <span className="block">
                #{pr.pullRequestId} {pr.title} · {pr.status}
              </span>
              <span className="block break-words text-content/50">
                {candidates.projectName}/{candidates.repositoryName} ·{" "}
                {pr.sourceRefName} → {pr.targetRefName} ·{" "}
                {pr.lastMergeSourceCommit?.commitId.slice(0, 8) ??
                  "unknown revision"}
              </span>
            </button>
          ))}
          {candidates.nextSkip != null ? (
            <button
              disabled={busy}
              className={button}
              onClick={() => void find(candidates.nextSkip!)}
            >
              Next PRs
            </button>
          ) : null}
        </div>
      ) : null}
      {association && !choosing ? (
        <section className="space-y-2">
          {!embedded ? (
            <h3 className="text-[14px] font-medium leading-snug">
              #{association.pr.pullRequestId} {association.pr.title}
            </h3>
          ) : null}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-content/55">
            <ReviewPill
              tone={
                association.pr.isDraft
                  ? "draft"
                  : association.pr.status === "active"
                    ? "open"
                    : association.pr.status === "completed"
                      ? "merged"
                      : association.pr.status === "abandoned"
                        ? "closed"
                        : "neutral"
              }
            >
              {association.pr.isDraft
                ? "Draft"
                : association.pr.status === "active"
                  ? "Open"
                  : association.pr.status === "completed"
                    ? "Completed"
                    : association.pr.status === "abandoned"
                      ? "Abandoned"
                      : association.pr.status}
            </ReviewPill>
            <span>
              {embedded
                ? `${association.projectName}/${association.repositoryName}`
                : association.projectName}
            </span>
            <span
              className="min-w-0 truncate"
              title={`${association.pr.sourceRefName} → ${association.pr.targetRefName} · ${association.pr.lastMergeSourceCommit?.commitId || "unknown revision"}`}
            >
              {association.pr.sourceRefName.replace(/^refs\/heads\//, "")} →{" "}
              {association.pr.targetRefName.replace(/^refs\/heads\//, "")}
              {association.pr.lastMergeSourceCommit?.commitId
                ? ` · ${association.pr.lastMergeSourceCommit.commitId.slice(0, 8)}`
                : ""}
            </span>
            {(() => {
              const summary = voteSummary(association.pr.reviewers);
              return summary ? (
                <span className={reviewToneText[summary.tone]}>
                  {summary.label}
                </span>
              ) : null;
            })()}
            {azureMergeStateLabel(association.pr.mergeStatus) ? (
              <span
                className={
                  reviewToneText[
                    azureMergeStateTone(association.pr.mergeStatus) || "neutral"
                  ]
                }
              >
                {azureMergeStateLabel(association.pr.mergeStatus)}
              </span>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-1">
            <button
              className={button}
              disabled={busy || !sameAccount}
              onClick={() => void refresh()}
            >
              {busy ? (
                <Loader className="size-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <RefreshCw className="size-3.5" strokeWidth={1.75} />
              )}
              Refresh PR
            </button>
            {!embedded ? (
              <button
                className={button}
                onClick={() => {
                  void openUrl(azurePrUrl(association.target)).catch((error) =>
                    setError(message(error)),
                  );
                }}
              >
                <ExternalLink className="size-3.5" strokeWidth={1.75} />
                Open in Azure
              </button>
            ) : null}
            {!embedded ? (
              <button className={button} onClick={() => setChoosing(true)}>
                Choose another PR
              </button>
            ) : null}
            <button
              className={button}
              disabled={
                busy || !sameAccount || association.pr.status !== "active"
              }
              onClick={() => void openWorktree()}
            >
              <FolderOpen className="size-3.5" strokeWidth={1.75} />
              Open in worktree
            </button>
            {association.pr.status === "active" && sameAccount ? (
              <button
                className={button}
                onClick={() =>
                  openWatchSheet({
                    source: {
                      kind: "azure-pr",
                      target: association.target,
                      projectName: association.projectName,
                      repositoryName: association.repositoryName,
                      cwd: association.cwd,
                      branch: association.branch,
                      ...(association.sourceSessionId
                        ? { sessionId: association.sourceSessionId }
                        : {}),
                    },
                    name: `Reviews · ${association.repositoryName} !${association.target.number}`,
                  })
                }
              >
                Watch reviews
              </button>
            ) : null}
          </div>
          {busy && preparation.current ? (
            <button
              className={button}
              onClick={() => preparation.current?.abort()}
            >
              Cancel preparation
            </button>
          ) : null}
          {!sameAccount ? (
            <ReviewError>
              Reconnect the linked Azure account to read this PR, or choose
              another PR.
            </ReviewError>
          ) : !verified ? (
            <ReviewStatus>
              {busy
                ? "Updating PR…"
                : "Could not update this saved PR. Retry with Refresh PR."}
            </ReviewStatus>
          ) : null}
          {sameAccount && verified ? (
            <RepairStatus
              scope={azurePrKey(association.target)}
              cwd={association.cwd}
            />
          ) : null}
          {sameAccount ? (
            <fieldset disabled={!verified || busy} className="min-w-0">
              <AzurePrSections
                key={`${association.revision}:${azurePrKey(association.target)}`}
                association={association}
                verified={verified}
                refreshKey={refreshKey}
                onStale={() => {
                  setVerified(false);
                  setError(
                    "PR revision or access changed. Refresh PR before sending context.",
                  );
                }}
                onHandoff={onClose}
                repairInstruction={
                  repairDraft.current?.key === azurePrKey(association.target)
                    ? repairDraft.current.instruction
                    : undefined
                }
                onRefreshEvidence={(instruction) => {
                  repairDraft.current = {
                    key: azurePrKey(association.target),
                    instruction,
                  };
                  onReveal?.();
                  setRepairRefresh((value) => value + 1);
                }}
                onChanged={() => void refresh()}
              />
            </fieldset>
          ) : null}
          <ReviewDetails summary="Account and revisions">
            <p className="break-all">
              Account: {association.account} ({association.target.accountId})
              <br />
              Repository: {association.target.repository}
              <br />
              Source / target revision: {association.revision}
            </p>
          </ReviewDetails>
          <ReviewDetails
            summary={`Reviewers (${association.pr.reviewers.length})`}
          >
            <p>
              {association.pr.reviewers
                .slice(0, 50)
                .map(
                  (reviewer) =>
                    `${reviewer.displayName}: ${vote(reviewer.vote)}${reviewer.isRequired ? " (required)" : ""}`,
                )
                .join("; ") || "None listed"}
            </p>
          </ReviewDetails>
        </section>
      ) : null}
    </ReviewShell>
  );
}

/** Azure `mergeStatus` as a short label — the same slot GitHub gives its
 * mergeStateStatus. `notSet`/`notApplicable`/`multiple` say nothing useful
 * next to the state pill, so they render nothing. */
function azureMergeStateLabel(status: string | undefined): string {
  const known: Record<string, string> = {
    succeeded: "Ready to merge",
    conflicts: "Merge conflicts",
    rejectedbypolicy: "Merge blocked by policy",
    queued: "Merge queued",
    failure: "Merge check failed",
  };
  return known[(status ?? "").trim().toLowerCase()] ?? "";
}

function azureMergeStateTone(status: string | undefined): ReviewTone | "" {
  switch ((status ?? "").trim().toLowerCase()) {
    case "succeeded":
      return "passing";
    case "conflicts":
    case "rejectedbypolicy":
    case "failure":
      return "failing";
    case "queued":
      return "running";
    default:
      return "";
  }
}

function vote(value: number) {
  return (
    (
      {
        10: "approved",
        5: "approved with suggestions",
        0: "no vote",
        "-5": "waiting for author",
        "-10": "rejected",
      } as Record<number, string>
    )[value] ?? `unknown vote (${value})`
  );
}

/** Worst-vote rollup for the meta line — the same slot where GitHub shows
 * its reviewDecision. The full per-reviewer list stays in the disclosure. */
export function voteSummary(
  reviewers: AzurePr["reviewers"],
): { label: string; tone: ReviewTone } | null {
  if (!reviewers.length) return null;
  const worst = Math.min(...reviewers.map((reviewer) => reviewer.vote));
  if (worst <= -10) return { label: "Rejected", tone: "failing" };
  if (worst <= -5) return { label: "Waiting for author", tone: "running" };
  const approvals = reviewers.filter((reviewer) => reviewer.vote > 0).length;
  if (approvals)
    return {
      label: `${approvals} approval${approvals === 1 ? "" : "s"}`,
      tone: "passing",
    };
  return {
    label: `${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}`,
    tone: "neutral",
  };
}

const threadStatusLabel = (status: string) =>
  (
    ({
      active: "active",
      pending: "pending",
      fixed: "fixed",
      wontFix: "won't fix",
      byDesign: "by design",
      closed: "closed",
    }) as Record<string, string>
  )[status] ?? status;

type CheckRow = {
  id: number | string;
  description?: string;
  status?: string;
  state?: string;
  configuration?: { isBlocking?: boolean; type?: { displayName?: string } };
  context?: { genre?: string; name?: string };
};

/** Azure status/policy verdicts onto the shared check tones. */
function checkTone(value: string | undefined): ReviewTone {
  switch ((value ?? "").trim().toLowerCase()) {
    case "succeeded":
    case "approved":
      return "passing";
    case "error":
    case "failed":
    case "rejected":
    case "broken":
      return "failing";
    case "pending":
    case "running":
    case "queued":
    case "notstarted":
      return "running";
    default:
      return "neutral";
  }
}

type LoadResult<T> = { page: T | null; error: string };
const attempt = <T,>(promise: Promise<T>): Promise<LoadResult<T>> =>
  promise
    .then((page) => ({ page, error: "" }))
    .catch((error: unknown) => ({ page: null, error: message(error) }));

function AzurePrSections({
  association,
  verified,
  refreshKey = 0,
  onStale,
  onHandoff,
  onRefreshEvidence,
  repairInstruction,
  onChanged,
}: {
  association: AzurePrAssociation;
  verified: boolean;
  refreshKey?: number;
  onStale: () => void;
  onHandoff: () => void;
  onRefreshEvidence: (instruction: string) => void;
  repairInstruction?: string;
  onChanged: () => void;
}) {
  const [threads, setThreads] = useState<AzurePrPage<AzurePrThread> | null>(
    null,
  );
  const [threadError, setThreadError] = useState("");
  const [diff, setDiff] = useState<AzurePrDiff | null>(null);
  const [diffError, setDiffError] = useState("");
  const [statuses, setStatuses] = useState<AzurePrPage<CheckRow> | null>(null);
  const [statusError, setStatusError] = useState("");
  const [policies, setPolicies] = useState<AzurePrPage<CheckRow> | null>(null);
  const [policyError, setPolicyError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewComments, setReviewComments] = useState<
    AzureReviewCommentDraft[]
  >([]);
  const [reviewBody, setReviewBody] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const selectionKey = JSON.stringify([
    association.cwd,
    association.sourceSessionId,
    association.target,
    association.revision,
  ]);
  const [expanded, setExpanded] = useState<number | null>(
    threadSelections.get(selectionKey)?.id ?? null,
  );
  const pageRef = useRef(threadSelections.get(selectionKey)?.page ?? 0);
  const preparation = useRef<AbortController | null>(null);
  const rememberThread = (id: number | null) => {
    threadSelections.delete(selectionKey);
    threadSelections.set(selectionKey, { id, page: pageRef.current });
    if (threadSelections.size > 100)
      threadSelections.delete(threadSelections.keys().next().value!);
    setExpanded(id);
  };
  const generation = useRef(0);
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setBusy(false);
    return () => {
      mounted.current = false;
      preparation.current?.abort();
      generation.current++;
    };
  }, []);
  const read = async (action: (current: () => boolean) => Promise<void>) => {
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
  const loadThreads = (skip = pageRef.current) =>
    read(async (current) => {
      const next = await readAzurePrSection<AzurePrThread>(
        association.target,
        association.revision,
        "threads",
        skip,
      );
      if (current()) {
        pageRef.current = skip;
        setThreads(next);
        setThreadError("");
      }
    });
  const load = () =>
    read(async (current) => {
      // Each section degrades independently — a denied policy read must not
      // hide a healthy diff, matching how the other providers isolate checks.
      const [nextThreads, nextDiff, nextStatuses, nextPolicies] =
        await Promise.all([
          attempt(
            readAzurePrSection<AzurePrThread>(
              association.target,
              association.revision,
              "threads",
              pageRef.current,
            ),
          ),
          attempt(readAzurePrDiff(association.target, association.revision)),
          attempt(
            readAzurePrSection<CheckRow>(
              association.target,
              association.revision,
              "statuses",
            ),
          ),
          attempt(
            readAzurePrSection<CheckRow>(
              association.target,
              association.revision,
              "policies",
            ),
          ),
        ]);
      if (!current()) return;
      setThreads(nextThreads.page);
      setThreadError(nextThreads.error);
      setDiff(nextDiff.page);
      setDiffError(nextDiff.error);
      setStatuses(nextStatuses.page);
      setStatusError(nextStatuses.error);
      setPolicies(nextPolicies.page);
      setPolicyError(nextPolicies.error);
    });
  useEffect(() => {
    if (verified) void load();
  }, [verified, refreshKey]);
  const send = (thread: AzurePrThread) =>
    read(async (current) => {
      // Recheck the revision before opening the existing #8 destination picker.
      try {
        await readAzurePr(association.target, association.revision);
      } catch (error) {
        if (current()) onStale();
        throw error;
      }
      if (!current()) return;
      requestAgentContext({
        context: azurePrContext(association, thread),
        cwd: association.cwd,
        sourceSessionId: association.sourceSessionId,
        onPrepared: onHandoff,
      });
    });
  const repairComments = (
    selected = threads?.items ?? [],
    commentId?: number,
  ) =>
    read(async (current) => {
      const controller = new AbortController();
      preparation.current = controller;
      const draft = await commentsRepair(
        association,
        selected,
        pageRef.current,
        () => current() && !controller.signal.aborted,
        commentId,
        controller.signal,
      ).finally(() => {
        if (preparation.current === controller) preparation.current = null;
      });
      if (!current()) return;
      requestAgentContext({
        context: {
          ...draft.context,
          instruction: repairInstruction ?? draft.context.instruction,
        },
        repair: draft.evidence,
        onRefreshEvidence,
        cwd: draft.evidence.head.cwd,
        sourceSessionId:
          draft.evidence.kind === "comments"
            ? draft.evidence.association.sourceSessionId
            : undefined,
        destination: taskDestinationForSession(
          draft.evidence.kind === "comments"
            ? draft.evidence.association.sourceSessionId
            : undefined,
        ),
        onPrepared: onHandoff,
      });
    });
  const addReviewComment = useCallback(
    (path: string, line: UnifiedLine, body: string) => {
      const anchor = azureReviewAnchor(line);
      if (!anchor) return;
      setSubmitted(false);
      setReviewComments((current) =>
        [
          ...current.filter(
            (comment) =>
              !(
                comment.path === path &&
                comment.line === anchor.line &&
                comment.side === anchor.side
              ),
          ),
          { path, ...anchor, body },
        ].slice(-50),
      );
    },
    [],
  );
  const removeReviewComment = useCallback((index: number) => {
    setReviewComments((current) => current.filter((_, row) => row !== index));
  }, []);
  const submitReview = async (event: AzurePrReviewEvent) => {
    let submittedOk = false;
    await read(async (current) => {
      await azurePrSubmitReview(association.target, association.revision, {
        event,
        body: reviewBody,
        comments: reviewComments,
      });
      if (!current()) return;
      setReviewComments([]);
      setReviewBody("");
      setSubmitted(true);
      submittedOk = true;
    });
    // Votes and threads changed — refresh the panel summary and the sections.
    if (submittedOk) onChanged();
  };
  const commentComposer = useCallback<LineCommentComposer>(
    ({ path, target, onDismiss }) => (
      <ReviewLineComposer
        path={path}
        target={target}
        onAdd={(body) => {
          addReviewComment(path, target.line, body);
          onDismiss();
        }}
        onDismiss={onDismiss}
      />
    ),
    [addReviewComment],
  );
  const open = association.pr.status === "active";
  const liveThreads = (threads?.items ?? []).filter(
    (thread) => !thread.isDeleted,
  );
  const reviewThreads = liveThreads.filter((thread) => thread.threadContext);
  const conversation = liveThreads.filter((thread) => !thread.threadContext);
  const unresolvedCount = liveThreads.filter(unresolvedThread).length;
  const sendableComments = liveThreads
    .filter(unresolvedThread)
    .reduce(
      (count, thread) =>
        count + thread.comments.filter((comment) => !comment.isDeleted).length,
      0,
    );
  const checkRows = [
    ...(statuses?.items ?? []),
    ...(policies?.items ?? []),
  ].slice(0, 50);
  const checksSummary = (() => {
    const total = checkRows.length;
    if (!total) return "No checks";
    const failing = checkRows.filter(
      (row) => checkTone(row.state ?? row.status) === "failing",
    ).length;
    const running = checkRows.filter(
      (row) => checkTone(row.state ?? row.status) === "running",
    ).length;
    const parts = [`${total - failing - running}/${total} passing`];
    if (failing) parts.push(`${failing} failing`);
    if (running) parts.push(`${running} pending`);
    return parts.join(" · ");
  })();
  const files = useMemo<UnifiedDiffFileModel[]>(
    () =>
      (diff?.items ?? []).map((item, index) => {
        const built = item.error
          ? null
          : buildUnifiedFile(item.original ?? "", item.modified ?? "");
        return {
          id: `${index}:${item.path}`,
          path: item.path,
          label: item.originalPath
            ? `${item.originalPath} → ${item.path}`
            : item.path,
          emptyMessage:
            item.error ??
            (built && built.lines.length === 0 ? "No textual diff" : undefined),
          additions: built?.additions ?? 0,
          deletions: built?.deletions ?? 0,
          blocks: built?.blocks ?? [],
          contextActions: false,
        };
      }),
    [diff],
  );
  const totals = useMemo(
    () => ({
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    }),
    [files],
  );
  return (
    <div className="space-y-3">
      {open && unresolvedCount > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          <button
            className={reviewAction}
            disabled={busy}
            onClick={() => void repairComments()}
          >
            <Bot className="size-3.5" strokeWidth={1.75} />
            Address {unresolvedCount} unresolved thread
            {unresolvedCount === 1 ? "" : "s"}
            {sendableComments > 20 ? " · first 20 comments" : ""}
          </button>
        </div>
      ) : null}
      {busy && (preparation.current || !threads) ? (
        <ReviewStatus>
          {preparation.current ? "Preparing checkout…" : "Loading PR details…"}
        </ReviewStatus>
      ) : null}
      {busy && preparation.current ? (
        <button className={button} onClick={() => preparation.current?.abort()}>
          Cancel preparation
        </button>
      ) : null}
      {checkRows.length || statusError || policyError ? (
        <ReviewDetails
          bordered
          summary={
            <>
              Checks ({checkRows.length}) · {checksSummary}
              {checkRows.some(
                (row) => checkTone(row.state ?? row.status) === "failing",
              ) ? (
                <span className="text-rose-400/90"> — needs attention</span>
              ) : null}
            </>
          }
        >
          <p className="text-content/45">
            Statuses and policies are provider evidence, not an independently
            verified CI result.
          </p>
          {statusError ? (
            <div className="flex flex-wrap items-center gap-2">
              <ReviewError>{statusError}</ReviewError>
            </div>
          ) : null}
          {policyError ? (
            <div className="flex flex-wrap items-center gap-2">
              <ReviewError>{policyError}</ReviewError>
            </div>
          ) : null}
          <ul className="space-y-1 pt-1">
            {checkRows.map((row, index) => (
              <li
                key={`${row.id ?? row.context?.name}:${index}`}
                className="break-words"
              >
                <span
                  className={reviewToneText[checkTone(row.state ?? row.status)]}
                >
                  {row.context
                    ? [row.context.genre, row.context.name]
                        .filter(Boolean)
                        .join("/")
                    : (row.configuration?.type?.displayName ?? row.id)}{" "}
                  · {row.state ?? row.status ?? "unknown"}
                </span>
                {row.configuration?.isBlocking ? (
                  <span className="text-content/50"> · required</span>
                ) : null}
                {row.description ? (
                  <span className="text-content/50">
                    {" "}
                    · {row.description.slice(0, 2000)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </ReviewDetails>
      ) : null}
      <section aria-label="Pull request diff">
        {diff ? (
          <UnifiedDiffView
            files={files}
            truncated={diff.truncated}
            totals={totals}
            fill={false}
            fileLayout="cards"
            initialExpansion="first"
            lineCommentComposer={open ? commentComposer : undefined}
          />
        ) : diffError ? (
          <p className="flex items-center gap-2 text-content/50">
            Diff unavailable. {diffError}
            <button className={button} onClick={() => void load()}>
              Retry
            </button>
          </p>
        ) : (
          <ReviewStatus>Loading diff…</ReviewStatus>
        )}
      </section>
      <section aria-label="Review threads" className="space-y-1.5">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-content/45">
          Review threads{threads ? ` (${reviewThreads.length})` : ""}
        </h4>
        {threadError ? (
          <div className="flex flex-wrap items-center gap-2">
            <ReviewError>{threadError}</ReviewError>
            <button
              className={button}
              disabled={busy}
              onClick={() => void loadThreads()}
            >
              Retry
            </button>
          </div>
        ) : null}
        {error ? <ReviewError>{error}</ReviewError> : null}
        {threads && reviewThreads.length === 0 && !threadError ? (
          <p className="text-content/50">No review threads.</p>
        ) : null}
        {reviewThreads.map((thread) => (
          <AzureReviewThread
            key={thread.id}
            association={association}
            thread={thread}
            open={open}
            expanded={expanded === thread.id}
            onToggle={(opening) => rememberThread(opening ? thread.id : null)}
            busy={busy}
            sendThread={() => void send(thread)}
            repairComment={(commentId) =>
              void repairComments([thread], commentId)
            }
            onActed={() => void loadThreads()}
          />
        ))}
        {threads && (pageRef.current > 0 || threads.nextSkip != null) ? (
          <div className="flex flex-wrap gap-1">
            {pageRef.current > 0 ? (
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void loadThreads(Math.max(0, pageRef.current - 50))
                }
              >
                Previous threads
              </button>
            ) : null}
            {threads.nextSkip != null ? (
              <button
                className={button}
                disabled={busy}
                onClick={() => void loadThreads(threads.nextSkip!)}
              >
                Next threads
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
      {open ? (
        <section
          aria-label="Submit a review"
          className="space-y-2 rounded-md border border-content/10 px-3 py-2.5"
        >
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-content/45">
            Review
            {reviewComments.length
              ? ` · ${reviewComments.length} line comment${reviewComments.length === 1 ? "" : "s"}`
              : ""}
          </h4>
          {reviewComments.length ? (
            <ul className="space-y-1">
              {reviewComments.map((comment, index) => (
                <li
                  key={`${comment.path}:${comment.side}:${comment.line}`}
                  className="flex items-start gap-1"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-content/70"
                    title={`${comment.path}:${comment.line}\n${comment.body}`}
                  >
                    {comment.path}:{comment.line}
                    {comment.side === "left" ? " (removed line)" : ""} ·{" "}
                    {comment.body}
                  </span>
                  <button
                    type="button"
                    title="Remove comment"
                    aria-label="Remove comment"
                    onClick={() => removeReviewComment(index)}
                    className="grid size-5 shrink-0 place-items-center rounded text-content/45 hover:bg-content/10 hover:text-content"
                  >
                    <X className="size-3" strokeWidth={1.75} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-content/50">
              Comment on a diff line to include it in the review.
            </p>
          )}
          <textarea
            aria-label="Review summary"
            className={reviewField}
            rows={2}
            maxLength={64_000}
            placeholder="Review summary (optional)"
            value={reviewBody}
            disabled={busy}
            onChange={(event) => setReviewBody(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              className={button}
              disabled={busy || (!reviewBody.trim() && !reviewComments.length)}
              onClick={() => void submitReview("comment")}
            >
              Comment
            </button>
            <button
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-emerald-300 hover:bg-emerald-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 disabled:opacity-40"
              disabled={busy || !!association.pr.isDraft}
              title={
                association.pr.isDraft
                  ? "Draft pull requests can't be approved"
                  : undefined
              }
              onClick={() => void submitReview("approve")}
            >
              <Check className="size-3.5" strokeWidth={1.75} />
              Approve
            </button>
            <button
              className={reviewDanger}
              disabled={busy}
              onClick={() => void submitReview("reject")}
            >
              Request changes
            </button>
          </div>
          {submitted ? (
            <p className="flex items-center gap-2 text-content/50">
              <Check
                className="size-3.5 text-emerald-400/90"
                strokeWidth={1.75}
              />
              Review submitted.
              <button
                className={button}
                onClick={() =>
                  void openUrl(azurePrUrl(association.target)).catch(
                    () => undefined,
                  )
                }
              >
                Open in Azure
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
      {conversation.length ? (
        <ReviewDetails
          lazy
          summary={`Conversation (${conversation.length})`}
          className="border-t border-content/10 pt-2"
        >
          <div className="space-y-2 pt-1">
            {conversation.slice(0, 50).map((thread) => {
              const comments = thread.comments
                .filter((comment) => !comment.isDeleted)
                .slice(0, 50);
              return comments.map((comment) => (
                <div key={`${thread.id}:${comment.id}`}>
                  <p className="text-content/55">
                    {comment.author?.displayName ?? "Unknown author"}
                  </p>
                  <AgentMarkdown
                    text={(comment.content ?? "").slice(0, 32_000)}
                    cwd={association.cwd}
                  />
                </div>
              ));
            })}
          </div>
        </ReviewDetails>
      ) : null}
    </div>
  );
}

function AzureReviewThread({
  association,
  thread,
  open,
  expanded,
  onToggle,
  busy,
  sendThread,
  repairComment,
  onActed,
}: {
  association: AzurePrAssociation;
  thread: AzurePrThread;
  open: boolean;
  expanded: boolean;
  onToggle: (opening: boolean) => void;
  busy: boolean;
  sendThread: () => void;
  repairComment: (commentId: number) => void;
  onActed: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [acting, setActing] = useState<"reply" | "resolve" | "">("");
  const [actionError, setActionError] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    // Re-showing after an <Activity> hide must not keep a stale busy flag.
    setActing("");
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const act = async (
    kind: "reply" | "resolve",
    action: () => Promise<void>,
  ) => {
    if (acting || busy) return;
    const id = generation.current;
    const current = () => mounted.current && generation.current === id;
    setActing(kind);
    setActionError("");
    try {
      await action();
      if (!current()) return;
      if (kind === "reply") setDraft("");
      onActed();
    } catch (error) {
      if (current()) setActionError(message(error));
    } finally {
      if (current()) setActing("");
    }
  };
  const reply = () =>
    act("reply", async () => {
      if (!draft.trim()) return;
      await azurePrThreadComment(
        association.target,
        association.revision,
        thread.id,
        draft,
      );
    });
  const toggleResolve = () =>
    act("resolve", async () => {
      await azurePrThreadStatus(
        association.target,
        association.revision,
        thread.id,
        resolved ? "active" : "fixed",
      );
    });
  const firstComment = thread.comments.find((comment) => !comment.isDeleted);
  const path = thread.threadContext?.filePath;
  const line = thread.threadContext?.rightFileStart?.line;
  const excerpt = (firstComment?.content?.split("\n")[0] ?? "").slice(0, 100);
  const resolved = !unresolvedThread(thread);
  const comments = thread.comments.filter((comment) => !comment.isDeleted);
  const total = comments.length;
  return (
    <ReviewDetails
      bordered
      lazy
      open={expanded}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      summary={
        <>
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              resolved ? "bg-emerald-400/70" : "bg-amber-400/80"
            }`}
            title={resolved ? "Resolved" : "Unresolved"}
          />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-content/80">
              {firstComment?.author?.displayName ?? "Unknown author"}
            </span>
            {excerpt ? (
              <span className="text-content/50"> — {excerpt}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-content/40">
            {path || "General"}
            {line != null ? `:${line}` : ""} ·{" "}
            <span
              className={resolved ? "text-emerald-400/80" : "text-amber-400/90"}
            >
              {resolved ? "Resolved" : "Unresolved"}
            </span>{" "}
            · {total} comment{total === 1 ? "" : "s"}
          </span>
        </>
      }
    >
      <div className="space-y-2 pt-2">
        <p className="text-content/45">
          {threadStatusLabel(thread.status)}
          {path ? ` · ${path}${line != null ? `:${line}` : ""}` : ""} ·
          Iteration{" "}
          {thread.pullRequestThreadContext?.iterationContext
            ?.secondComparingIteration ?? "—"}
        </p>
        {comments.slice(0, 50).map((comment) => (
          <div key={comment.id}>
            <p className="text-content/55">
              {comment.author?.displayName ?? "Unknown author"}
            </p>
            <AgentMarkdown
              text={(comment.content ?? "").slice(0, 32_000)}
              cwd={association.cwd}
            />
            {open && !resolved ? (
              <button
                className={button}
                disabled={busy || !!acting}
                onClick={() => repairComment(comment.id)}
              >
                Address this comment
              </button>
            ) : null}
          </div>
        ))}
        {comments.length > 50 ? (
          <p className="text-content/45">
            Showing 50 comments. Open in Azure for the rest.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1">
          {open && !resolved ? (
            <button
              className={button}
              disabled={busy || !!acting}
              onClick={sendThread}
            >
              <Bot className="size-3.5" strokeWidth={1.75} />
              Send thread to agent
            </button>
          ) : null}
          {open ? (
            <button
              className={button}
              disabled={busy || !!acting}
              onClick={() => void toggleResolve()}
            >
              {acting === "resolve"
                ? "Saving…"
                : resolved
                  ? "Unresolve"
                  : "Resolve"}
            </button>
          ) : null}
        </div>
        {open ? (
          <div className="space-y-1">
            <textarea
              aria-label="Reply to review thread"
              className={reviewField}
              rows={2}
              maxLength={64_000}
              value={draft}
              disabled={acting === "reply"}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Reply inside this review thread…"
            />
            <button
              className={button}
              disabled={busy || !!acting || !draft.trim()}
              onClick={() => void reply()}
            >
              {acting === "reply" ? "Replying…" : "Reply"}
            </button>
            {actionError ? <ReviewError>{actionError}</ReviewError> : null}
          </div>
        ) : actionError ? (
          <ReviewError>{actionError}</ReviewError>
        ) : null}
      </div>
    </ReviewDetails>
  );
}
