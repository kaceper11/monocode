import { commentsRepair, unresolvedThread } from "../lib/repair";
import { RepairStatus } from "./RepairStatus";
import {
  ReviewDetails,
  ReviewError,
  ReviewHeader,
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
import { Bot, ExternalLink, Loader, RefreshCw } from "./icons";
import { AzureConnectionDetails } from "./AzureConnectionDetails";
import type { LinkedWorkItem } from "../lib/session";
import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AZURE_CHANGE_EVENT,
  azureConnected,
  type AzureStatus,
} from "../lib/azure";
import { contextFromText, requestAgentContext } from "../lib/agentContext";
import { taskDestinationForSession } from "../lib/taskWorkspaces";
import { openWatchSheet } from "../lib/watchers";
import { buildUnifiedFile, formatUnifiedHunk } from "../lib/unifiedDiff";
import { UnifiedDiffView } from "../surfaces/UnifiedDiffView";
import {
  azurePrContext,
  discoverAzurePrs,
  loadAzurePrAssociations,
  azurePrKey,
  type AzurePrDiscoveryGroup,
  azurePrScope,
  azurePrUrl,
  findAzurePrs,
  loadAzurePrAssociation,
  parseAzurePrLocation,
  readAzurePr,
  readAzurePrFile,
  readAzurePrSection,
  saveAzurePrAssociation,
  type AzurePr,
  type AzurePrAssociation,
  type AzurePrPage,
  type AzurePrTarget,
  type AzurePrThread,
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
    <ReviewShell label="Azure pull requests">
      {!embedded ? (
        <ReviewHeader
          label="Pull requests"
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
              title={`${association.pr.sourceRefName} → ${association.pr.targetRefName}`}
            >
              {association.pr.sourceRefName.replace(/^refs\/heads\//, "")} →{" "}
              {association.pr.targetRefName.replace(/^refs\/heads\//, "")}
            </span>
            {(() => {
              const summary = voteSummary(association.pr.reviewers);
              return summary ? (
                <span className={reviewToneText[summary.tone]}>
                  {summary.label}
                </span>
              ) : null;
            })()}
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
          {sameAccount ? (
            <fieldset disabled={!verified || busy} className="min-w-0">
              <AzurePrDetails
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
              />
            </fieldset>
          ) : null}
        </section>
      ) : null}
    </ReviewShell>
  );
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

function AzurePrDetails({
  association,
  verified,
  refreshKey = 0,
  onStale,
  onHandoff,
  onRefreshEvidence,
  repairInstruction,
}: {
  association: AzurePrAssociation;
  verified: boolean;
  refreshKey?: number;
  onStale: () => void;
  onHandoff: () => void;
  onRefreshEvidence: (instruction: string) => void;
  repairInstruction?: string;
}) {
  const [threads, setThreads] = useState<AzurePrPage<AzurePrThread> | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  const load = (skip = pageRef.current) =>
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
      }
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
  const unresolvedCount = threads?.items.filter(unresolvedThread).length ?? 0;
  const sendableComments = (threads?.items ?? [])
    .filter(unresolvedThread)
    .reduce(
      (count, thread) =>
        count + thread.comments.filter((comment) => !comment.isDeleted).length,
      0,
    );
  const liveThreads = (threads?.items ?? []).filter(
    (thread) => !thread.isDeleted,
  );
  return (
    <div className="space-y-3">
      <RepairStatus
        scope={azurePrKey(association.target)}
        cwd={association.cwd}
      />
      {association.pr.status === "active" && unresolvedCount > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          <button
            className={reviewAction}
            disabled={busy}
            onClick={() => void repairComments()}
          >
            <Bot className="size-3.5" strokeWidth={1.75} />
            Address comments
            {sendableComments > 20 ? " · first 20 comments" : ""}
          </button>
        </div>
      ) : null}
      {busy && (preparation.current || !threads) ? (
        <ReviewStatus>
          {preparation.current ? "Preparing checkout…" : "Loading comments…"}
        </ReviewStatus>
      ) : null}
      {busy && preparation.current ? (
        <button
          className={button}
          onClick={() => preparation.current?.abort()}
        >
          Cancel preparation
        </button>
      ) : null}
      <ReviewDetails lazy summary="Files, policies and statuses">
        <AzureReviewSection
          association={association}
          section="iterations"
          onHandoff={onHandoff}
        />
        <AzureReviewSection
          association={association}
          section="policies"
          onHandoff={onHandoff}
        />
        <AzureReviewSection
          association={association}
          section="statuses"
          onHandoff={onHandoff}
        />
      </ReviewDetails>
      <section aria-label="Review threads" className="space-y-1.5">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-content/45">
          Review threads{threads ? ` (${liveThreads.length})` : ""}
        </h4>
        {error ? (
          <div className="flex flex-wrap items-center gap-2">
            <ReviewError>{error}</ReviewError>
            <button
              className={button}
              disabled={busy}
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        ) : null}
        {threads && liveThreads.length === 0 && !error ? (
          <p className="text-content/50">No review threads.</p>
        ) : null}
        {liveThreads.map((thread) => {
          const firstComment = thread.comments.find(
            (comment) => !comment.isDeleted,
          );
          const location = thread.threadContext?.filePath
            ? `${thread.threadContext.filePath.split("/").pop()}${
                thread.threadContext.rightFileStart?.line != null
                  ? `:${thread.threadContext.rightFileStart.line}`
                  : ""
              }`
            : null;
          return (
            <ReviewDetails
              key={thread.id}
              bordered
              open={expanded === thread.id}
              onToggle={(event) => {
                if (event.currentTarget.open) rememberThread(thread.id);
                else if (expanded === thread.id) rememberThread(null);
              }}
              summary={
                <>
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      unresolvedThread(thread)
                        ? "bg-amber-400/80"
                        : "bg-emerald-400/70"
                    }`}
                  />
                  <span className="min-w-0 truncate">
                    Thread {thread.id} ·{" "}
                    <span
                      className={
                        unresolvedThread(thread)
                          ? "text-amber-400/90"
                          : "text-emerald-400/80"
                      }
                    >
                      {threadStatusLabel(thread.status)}
                    </span>
                    {firstComment?.author?.displayName
                      ? ` — ${firstComment.author.displayName}`
                      : ""}
                  </span>
                  <span className="shrink-0 text-content/45">
                    {location ?? "General discussion"} ·{" "}
                    {thread.comments.filter((comment) => !comment.isDeleted)
                      .length || "No"}{" "}
                    comments
                  </span>
                </>
              }
            >
              {expanded === thread.id ? (
                <div className="space-y-2">
                  <p className="text-content/45">
                    {threadStatusLabel(thread.status)}
                    {location ? ` · ${location}` : ""} · Iteration{" "}
                    {thread.pullRequestThreadContext?.iterationContext
                      ?.secondComparingIteration ?? "—"}
                  </p>
                  {thread.comments
                    .filter((comment) => !comment.isDeleted)
                    .slice(0, 50)
                    .map((comment) => (
                      <div key={comment.id}>
                        <p className="text-content/55">
                          {comment.author?.displayName ?? "Unknown author"}
                        </p>
                        <AgentMarkdown
                          text={(comment.content ?? "").slice(0, 32_000)}
                          cwd={association.cwd}
                        />
                        {association.pr.status === "active" &&
                        unresolvedThread(thread) ? (
                          <button
                            className={button}
                            disabled={busy}
                            onClick={() =>
                              void repairComments([thread], comment.id)
                            }
                          >
                            Address this comment
                          </button>
                        ) : null}
                      </div>
                    ))}
                  {thread.comments.length > 50 ? (
                    <p className="text-content/45">
                      Showing 50 comments. Open in Azure for the rest.
                    </p>
                  ) : null}
                  <button
                    className={reviewAction}
                    disabled={busy}
                    onClick={() => void send(thread)}
                  >
                    <Bot className="size-3.5" strokeWidth={1.75} />
                    Send thread to agent
                  </button>
                </div>
              ) : null}
            </ReviewDetails>
          );
        })}
        {threads && (pageRef.current > 0 || threads.nextSkip != null) ? (
          <div className="flex flex-wrap gap-1">
            {pageRef.current > 0 ? (
              <button
                className={button}
                disabled={busy}
                onClick={() => void load(Math.max(0, pageRef.current - 50))}
              >
                Previous threads
              </button>
            ) : null}
            {threads.nextSkip != null ? (
              <button
                className={button}
                disabled={busy}
                onClick={() => void load(threads.nextSkip!)}
              >
                Next threads
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

type ReviewRow = {
  id: number | string;
  description?: string;
  status?: string;
  state?: string;
  sourceRefCommit?: { commitId: string };
  targetRefCommit?: { commitId: string };
  configuration?: { isBlocking?: boolean; type?: { displayName?: string } };
  context?: { genre?: string; name?: string };
  item?: { path: string };
  originalPath?: string;
  changeType?: string;
};

function AzureReviewSection({
  association,
  section,
  iteration = null,
  onHandoff,
}: {
  association: AzurePrAssociation;
  section: "iterations" | "policies" | "statuses" | "changes";
  iteration?: number | null;
  onHandoff: () => void;
}) {
  const [page, setPage] = useState<AzurePrPage<ReviewRow> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedIteration, setSelectedIteration] = useState<number | null>(
    null,
  );
  const [pageSkip, setPageSkip] = useState(0);
  const [filePath, setFilePath] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setBusy(false);
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const label = {
    iterations: "Iterations",
    policies: "Policies",
    statuses: "PR statuses",
    changes: "Changed files",
  }[section];
  const load = async (skip = 0) => {
    if (pending.current) return;
    const id = generation.current;
    const current = () => mounted.current && generation.current === id;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await readAzurePrSection<ReviewRow>(
        association.target,
        association.revision,
        section,
        skip,
        iteration,
      );
      if (current()) {
        setPage(next);
        setPageSkip(skip);
        setFilePath(null);
      }
    } catch (error) {
      if (current()) setError(message(error));
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section className="space-y-1 border-t border-content/10 pt-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{label}</p>
        {page ? (
          <button
            aria-label={`Refresh ${label.toLowerCase()}`}
            className={button}
            disabled={busy}
            onClick={() => void load(pageSkip)}
          >
            {busy ? (
              <Loader className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <RefreshCw className="size-3.5" strokeWidth={1.75} />
            )}
          </button>
        ) : null}
      </div>
      {section === "policies" || section === "statuses" ? (
        <p className="text-content/50">
          {label} are provider evidence, not an independently verified CI
          result.
        </p>
      ) : null}
      {busy && !page ? (
        <ReviewStatus>Loading {label.toLowerCase()}…</ReviewStatus>
      ) : null}
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <ReviewError>{error}</ReviewError>
          <button
            className={button}
            disabled={busy}
            onClick={() => void load()}
          >
            Retry {label.toLowerCase()}
          </button>
        </div>
      ) : null}
      {page?.items.length === 0 ? (
        <p className="text-content/45">No {label.toLowerCase()} returned.</p>
      ) : null}
      {page?.items.map((row, index) => (
        <div
          key={`${row.id ?? row.item?.path}:${index}`}
          className="break-words px-2 py-1"
        >
          {section === "iterations" ? (
            <button
              className={`${button} w-full text-left`}
              onClick={() => setSelectedIteration(Number(row.id))}
            >
              Iteration {row.id} ·{" "}
              {row.sourceRefCommit?.commitId.slice(0, 8) ?? "unknown source"} →{" "}
              {row.targetRefCommit?.commitId.slice(0, 8) ?? "unknown target"} ·
              Show changes
            </button>
          ) : section === "changes" ? (
            <button
              className={`${button} w-full text-left`}
              onClick={() => setFilePath(row.item?.path ?? null)}
            >
              {row.changeType} ·{" "}
              {row.originalPath ? `${row.originalPath} → ` : ""}
              {row.item?.path} · View diff
            </button>
          ) : (
            <p>
              {row.configuration?.type?.displayName ??
                row.context?.name ??
                row.id}{" "}
              · {row.status ?? row.state ?? "unknown"}
              {row.configuration?.isBlocking ? " · required" : ""}
            </p>
          )}
          {row.description ? (
            <p className="text-content/55">{row.description.slice(0, 2000)}</p>
          ) : null}
        </div>
      ))}
      {page && pageSkip > 0 ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => void load(Math.max(0, pageSkip - 50))}
        >
          Previous {label.toLowerCase()}
        </button>
      ) : null}
      {page?.nextSkip != null ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => void load(page.nextSkip!)}
        >
          Next {label.toLowerCase()}
        </button>
      ) : null}
      {selectedIteration != null ? (
        <AzureReviewSection
          key={selectedIteration}
          association={association}
          section="changes"
          iteration={selectedIteration}
          onHandoff={onHandoff}
        />
      ) : null}
      {filePath && iteration ? (
        <AzurePrFile
          key={`${iteration}:${filePath}:${pageSkip}`}
          association={association}
          iteration={iteration}
          path={filePath}
          skip={pageSkip}
          onHandoff={onHandoff}
        />
      ) : null}
    </section>
  );
}

function AzurePrFile({
  association,
  iteration,
  path,
  skip,
  onHandoff,
}: {
  association: AzurePrAssociation;
  iteration: number;
  path: string;
  skip: number;
  onHandoff: () => void;
}) {
  const [file, setFile] = useState<Awaited<
    ReturnType<typeof readAzurePrFile>
  > | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [sending, setSending] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setSending(false);
    let cancelled = false;
    setError("");
    void readAzurePrFile(
      association.target,
      association.revision,
      iteration,
      path,
      skip,
    )
      .then((file) => {
        if (!cancelled) setFile(file);
      })
      .catch((error) => {
        if (!cancelled) setError(message(error));
      });
    return () => {
      cancelled = true;
      mounted.current = false;
      generation.current++;
    };
  }, [association.target, association.revision, iteration, path, skip, retry]);
  const diff = useMemo(
    () => (file ? buildUnifiedFile(file.original, file.modified) : null),
    [file],
  );
  const send = async () => {
    if (!file || !diff || pending.current) return;
    const id = generation.current;
    const current = () => mounted.current && generation.current === id;
    pending.current = true;
    setSending(true);
    setError("");
    try {
      await readAzurePr(association.target, association.revision);
      if (!current()) return;
      const origin = `${azurePrUrl(association.target)} · account ${association.target.accountId} · checkout ${association.cwd} · session ${association.sourceSessionId ?? "not assigned"} · revision ${association.revision} · iteration ${iteration} · ${file.baseCommit} → ${file.sourceCommit}`;
      const context = contextFromText(
        `Azure PR #${association.target.number} · ${path}`,
        formatUnifiedHunk(diff.lines),
        origin,
      );
      context.entries[0].language = "diff";
      requestAgentContext({
        context,
        cwd: association.cwd,
        sourceSessionId: association.sourceSessionId,
        onPrepared: onHandoff,
      });
    } catch (error) {
      if (current()) setError(message(error));
    } finally {
      if (current()) {
        pending.current = false;
        setSending(false);
      }
    }
  };
  return (
    <div className="space-y-2">
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <ReviewError>{error}</ReviewError>
          <button
            className={button}
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry file
          </button>
        </div>
      ) : null}
      {!file && !error ? <p>Loading selected file…</p> : null}
      {file && diff ? (
        <>
          <p className="break-all text-content/50">
            Iteration {iteration}: {file.baseCommit} → {file.sourceCommit}
          </p>
          <UnifiedDiffView
            files={[
              {
                id: path,
                path,
                label: path,
                blocks: diff.blocks,
                additions: diff.additions,
                deletions: diff.deletions,
                contextActions: false,
              },
            ]}
            fill={false}
            fileLayout="cards"
          />
          <button
            className={button}
            disabled={sending}
            onClick={() => void send()}
          >
            {sending ? "Checking revision…" : "Send file diff to agent"}
          </button>
        </>
      ) : null}
    </div>
  );
}
