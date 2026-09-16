import { Select } from "./Select";
import { ciRepair } from "../lib/repair";
import { RepairStatus } from "./RepairStatus";
import {
  ReviewDetails,
  ReviewError,
  ReviewHeader,
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
import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  azureConnected,
  AZURE_CHANGE_EVENT,
  type AzureStatus,
} from "../lib/azure";
import { requestAgentContext } from "../lib/agentContext";
import { openWatchSheet } from "../lib/watchers";
import {
  ciContext,
  ciKey,
  ciLogContext,
  ciLookup,
  ciMatchLabel,
  ciMatches,
  ciRead,
  ciScope,
  ciState,
  ciUrl,
  loadCiSources,
  parsePipelineUrl,
  saveCiSources,
  type CiTarget,
  type CiCheckout,
  type CiHead,
  type CiJob,
  type CiJobs,
  type CiLog,
  type CiPage,
  type CiRun,
  type CiSource,
} from "../lib/azurePipelines";

const button = reviewButton;
const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
// Two initial sources at a time across visible CI panes; explicit refreshes stay immediate.
const initialLoads: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
let initialSlot = 0;
const scheduleInitialLoad = (
  action: () => Promise<void>,
  current: () => boolean,
) => {
  const slot = initialSlot++ % initialLoads.length;
  initialLoads[slot] = initialLoads[slot]
    .then(() => (current() ? action() : undefined))
    .catch(() => undefined);
};
const drafts = new Map<string, string>();
/** Run/job state → pill tone: in-flight amber, passed emerald, failed rose,
 * cancelled/skipped/abandoned dim. */
const ciTone = (status: string, result?: string | null): ReviewTone =>
  status !== "completed"
    ? "running"
    : result === "succeeded"
      ? "passing"
      : result === "partiallySucceeded" || result === "succeededWithIssues"
        ? "running"
        : result === "failed"
          ? "failing"
          : result
            ? "closed"
            : "neutral";

export function AzureCiReview({
  inboxTarget,
  embedded = false,
  cwd,
  branch,
  sourceSessionId,
  enabled,
  onClose,
  onReveal,
}: {
  inboxTarget?: CiTarget;
  embedded?: boolean;
  cwd: string;
  branch: string;
  sourceSessionId?: string;
  enabled: boolean;
  onClose: () => void;
  onReveal?: () => void;
}) {
  const [sources, setSources] = useState(() =>
    loadCiSources(cwd, branch, sourceSessionId),
  );
  const update = (next: CiSource[]) => {
    saveCiSources(next, cwd, branch, sourceSessionId);
    setSources(next);
  };
  return enabled ? (
    <CiPanel
      inboxTarget={inboxTarget}
      embedded={embedded}
      key={ciScope(cwd, branch, sourceSessionId)}
      cwd={cwd}
      branch={branch}
      session={sourceSessionId}
      sources={sources}
      onChange={update}
      onClose={onClose}
      onReveal={onReveal}
    />
  ) : null;
}

function CiPanel({
  inboxTarget,
  embedded,
  cwd,
  branch,
  session,
  sources,
  onChange,
  onClose,
  onReveal,
}: {
  inboxTarget?: CiTarget;
  embedded?: boolean;
  cwd: string;
  branch: string;
  session?: string;
  sources: CiSource[];
  onChange: (sources: CiSource[]) => void;
  onClose: () => void;
  onReveal?: () => void;
}) {
  const [status, setStatus] = useState<AzureStatus>();
  const [checkout, setCheckout] = useState<CiCheckout>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const scope = ciScope(cwd, branch, session);
  const [link, setLink] = useState(drafts.get(scope) ?? "");
  const [remote, setRemote] = useState("");
  const generation = useRef(0),
    pending = useRef(false);
  const repairDraft = useRef<{ key: string; instruction: string } | null>(null);
  const sourceRef = useRef(sources);
  sourceRef.current = sources;
  useEffect(() => {
    const run = ++generation.current;
    // Keep the last resolved status while re-reading — clearing it flips the
    // connection details open and flashes "Connect account" on each refresh.
    setError("");
    setBusy(false);
    pending.current = false;
    void Promise.all([azureConnected(), ciContext(cwd)])
      .then(([status, context]) => {
        if (run !== generation.current) return;
        if (context.branch !== branch)
          throw new Error(
            "Working branch changed. Refresh Changes and reopen CI.",
          );
        setStatus(status);
        setCheckout(context);
        setRemote((previous) =>
          context.remotes.some((remote) => remote.url === previous)
            ? previous
            : context.remotes.length === 1
              ? context.remotes[0].url
              : "",
        );
        setRefreshing(false);
      })
      .catch((error) => {
        if (run === generation.current) {
          setCheckout(undefined);
          setRefreshing(false);
          setError(failure(error));
        }
      });
    const changed = () => setVersion((v) => v + 1);
    window.addEventListener(AZURE_CHANGE_EVENT, changed);
    return () => {
      generation.current++;
      window.removeEventListener(AZURE_CHANGE_EVENT, changed);
    };
  }, [cwd, branch, version]);
  const connect = () =>
    void emit("open_settings", { section: "general" })
      .then(onClose)
      .catch((e) => setError(failure(e)));
  const add = async () => {
    if (pending.current || !checkout || !status?.accountId) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const id = generation.current;
    try {
      if (sourceRef.current.length >= 20)
        throw new Error(
          "Limit of 20 CI sources for this work. Remove an unused mapping first.",
        );
      const target = parsePipelineUrl(link, status.accountId);
      if (target.site !== status.site)
        throw new Error(`Connect ${target.site} in Azure settings first.`);
      const page = await ciLookup(target, {
        cwd,
        branch,
        commit: checkout.commit,
        remote,
      });
      if (id !== generation.current) return;
      const source: CiSource = {
        target: page.target,
        definitionName: page.definitionName,
        projectName: page.projectName,
        remote,
        cwd,
        branch,
        session,
      };
      onChange([
        ...sourceRef.current.filter(
          (value) => ciKey(value.target) !== ciKey(source.target),
        ),
        source,
      ]);
      setAdding(false);
      drafts.delete(scope);
      setLink("");
    } catch (error) {
      if (id === generation.current) setError(failure(error));
    } finally {
      if (id === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <ReviewShell label="Azure pipeline runs">
      {!embedded ? (
        <ReviewHeader
          label="CI"
          context={`${branch || "Detached checkout"}${checkout?.commit ? ` · ${checkout.commit.slice(0, 8)}` : ""}`}
          title={cwd}
        />
      ) : null}
      <AzureConnectionDetails
        label="Azure Pipelines"
        status={status}
        connected={!!status?.connected}
        connectHint="Connect the shared Azure account with Build (Read) to inspect CI."
        onLeave={onClose}
        onError={setError}
      >
        <p className="text-content/50">
          Each source is independent. A passing run does not establish that all
          required CI passes. PR merge builds need verified source-head
          evidence.
        </p>
      </AzureConnectionDetails>
      <div className="flex flex-wrap gap-1">
        <button
          className={button}
          disabled={busy || refreshing}
          onClick={() => {
            setRefreshing(true);
            setVersion((v) => v + 1);
          }}
        >
          {refreshing ? (
            <Loader className="size-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <RefreshCw className="size-3.5" strokeWidth={1.75} />
          )}
          Refresh all
        </button>
        {!inboxTarget && !adding ? (
          <button
            className={`${button} bg-content/10`}
            disabled={!status?.connected}
            onClick={() => setAdding(true)}
          >
            {sources.length ? "Add pipeline" : "Connect a pipeline"}
          </button>
        ) : null}
      </div>
      {error ? <ReviewError>{error}</ReviewError> : null}
      {!sources.length ? (
        <ReviewStatus>
          {status
            ? "No Azure pipeline is linked to this branch yet. Connect one to see runs and failed jobs for this checkout."
            : "Checking Azure Pipelines…"}
        </ReviewStatus>
      ) : null}
      {adding ? (
        <form
          className="max-w-lg space-y-3 rounded-md border border-content/10 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <p className="font-medium">Connect pipeline</p>
          <label className="block">
            Pipeline link
            <input
              aria-label="Azure pipeline link"
              className={reviewField}
              value={link}
              maxLength={2048}
              disabled={busy}
              placeholder="https://dev.azure.com/org/project/_build?definitionId=7"
              onChange={(e) => {
                setLink(e.target.value);
                drafts.delete(scope);
                drafts.set(scope, e.target.value);
                if (drafts.size > 100)
                  drafts.delete(drafts.keys().next().value!);
              }}
            />
          </label>
          <label className="block">
            Repository for this pipeline
            <Select
              label="Pipeline repository remote"
              value={remote}
              disabled={busy}
              options={[
                { value: "", label: "Choose repository" },
                ...(checkout?.remotes.map((value) => ({
                  value: value.url,
                  label: `${value.name} · ${value.url}`,
                })) ?? []),
              ]}
              onChange={setRemote}
            />
          </label>
          <button
            className={button}
            disabled={
              busy || !status?.connected || !checkout || !link.trim() || !remote
            }
          >
            {busy ? "Verifying…" : "Connect pipeline"}
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => setAdding(false)}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {checkout
        ? sources
            .filter(
              (source) =>
                !inboxTarget || ciKey(source.target) === ciKey(inboxTarget),
            )
            .map((source, index) => (
              <CiSourcePanel
                key={`${ciKey(source.target)}:${checkout.commit}`}
                refreshVersion={version}
                autoDetails={index === 0}
                embedded={embedded || !!inboxTarget}
                source={source}
                head={{
                  cwd,
                  branch,
                  commit: checkout.commit,
                  remote: source.remote,
                }}
                status={status}
                onSave={(last) =>
                  onChange(
                    sourceRef.current.map((value) =>
                      ciKey(value.target) === ciKey(source.target)
                        ? { ...value, last }
                        : value,
                    ),
                  )
                }
                onRemove={() =>
                  onChange(
                    sourceRef.current.filter(
                      (value) => ciKey(value.target) !== ciKey(source.target),
                    ),
                  )
                }
                onHandoff={onClose}
                onReconnect={connect}
                repairInstruction={
                  repairDraft.current?.key === ciKey(source.target)
                    ? repairDraft.current.instruction
                    : undefined
                }
                onRefreshEvidence={(instruction) => {
                  repairDraft.current = {
                    key: ciKey(source.target),
                    instruction,
                  };
                  onReveal?.();
                  setVersion((value) => value + 1);
                }}
              />
            ))
        : null}
    </ReviewShell>
  );
}

function CiSourcePanel({
  embedded,
  autoDetails,
  refreshVersion,
  source,
  head,
  status,
  onSave,
  onRemove,
  onHandoff,
  onReconnect,
  onRefreshEvidence,
  repairInstruction,
}: {
  embedded: boolean;
  autoDetails: boolean;
  refreshVersion: number;
  source: CiSource;
  head: CiHead;
  status?: AzureStatus;
  onSave: (last: CiSource["last"]) => void;
  onRemove: () => void;
  onHandoff: () => void;
  onReconnect: () => void;
  onRefreshEvidence: (instruction: string) => void;
  repairInstruction?: string;
}) {
  const [page, setPage] = useState<CiPage>();
  const [selected, setSelected] = useState<CiRun>();
  const [jobs, setJobs] = useState<CiJobs>();
  const [skip, setSkip] = useState(0);
  const [job, setJob] = useState<CiJob>();
  const [log, setLog] = useState<CiLog>();
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0),
    pending = useRef(false);
  const sameAccount =
    !!status?.connected &&
    status.site === source.target.site &&
    status.accountId === source.target.accountId;
  // Deps must be stable across refreshes — `status` is a fresh object each
  // read, so keying the effect on it refires ciLookup after every resolve.
  const statusReady = status !== undefined;
  const run = async (
    action: (current: () => boolean) => Promise<void>,
    detail = false,
  ) => {
    if (pending.current || !sameAccount) return;
    pending.current = true;
    setBusy(true);
    (detail ? setDetailError : setError)("");
    const id = generation.current;
    try {
      await action(() => id === generation.current);
    } catch (error) {
      if (id === generation.current)
        (detail ? setDetailError : setError)(failure(error));
    } finally {
      if (id === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const refresh = (continuation: string | null = null) =>
    run(async (current) => {
      const next = await ciLookup(
        source.target,
        head,
        continuation,
        !continuation ? source.last?.run.id : undefined,
      );
      if (!current()) return;
      setPage(next);
      const unchanged =
        selected &&
        next.items.some(
          (value) =>
            value.id === selected.id && value.revision === selected.revision,
        );
      if (!selected && !continuation && autoDetails) {
        const initial =
          next.items.find((value) => value.id === source.last?.run.id) ??
          next.items.find(ciMatches);
        if (initial) await readSelection(initial, current);
      } else if (!unchanged) {
        setSelected(undefined);
        setJobs(undefined);
        setJob(undefined);
        setLog(undefined);
        setDetailError(
          selected
            ? "Selected run changed or left this page. Choose fresh evidence."
            : "",
        );
      }
    });
  useEffect(() => {
    const id = ++generation.current;
    pending.current = false;
    if (sameAccount) {
      setBusy(true);
      scheduleInitialLoad(
        () => refresh(),
        () => generation.current === id,
      );
    } else if (statusReady) {
      setPage(undefined);
      setSelected(undefined);
      setJobs(undefined);
      setJob(undefined);
      setLog(undefined);
      setSkip(0);
      setDetailError("");
      setBusy(false);
      setError(
        "Reconnect the mapped Azure organization/account to read this source.",
      );
    }
    return () => {
      if (generation.current === id) generation.current++;
    };
  }, [sameAccount, statusReady, refreshVersion]);
  const readSelection = async (value: CiRun, current: () => boolean) => {
    const checked = await ciRead<CiRun>(source.target, head, value, "summary");
    if (!current()) return;
    setSelected(checked);
    setJobs(undefined);
    setJob(undefined);
    setLog(undefined);
    setSkip(0);
    setDetailError("");
    onSave({ run: checked, commit: head.commit, checkedAt: Date.now() });
    try {
      const data = await ciRead<CiJobs>(source.target, head, checked, "jobs", {
        skip: 0,
      });
      if (current()) setJobs(data);
    } catch (error) {
      if (current()) setDetailError(failure(error));
    }
  };
  const select = (value: CiRun) =>
    void run((current) => readSelection(value, current));
  const loadJobs = (skip = 0) =>
    void run(async (current) => {
      if (!selected) return;
      const data = await ciRead<CiJobs>(source.target, head, selected, "jobs", {
        skip,
      });
      if (!current()) return;
      setJobs(data);
      setSkip(skip);
      setJob(undefined);
      setLog(undefined);
    }, true);
  const loadLog = (value: CiJob, startLine?: number) =>
    void run(async (current) => {
      if (!selected || !value.attempt || !value.logId) return;
      const data = await ciRead<CiLog>(source.target, head, selected, "log", {
        recordId: value.id,
        attempt: value.attempt,
        logId: value.logId,
        startLine,
      });
      if (current()) {
        setJob(value);
        setLog(data);
      }
    }, true);
  const handoff = (repair = false) =>
    void run(async (current) => {
      if (!selected || !job || !log || !ciMatches(selected)) return;
      const checked = await ciRead<CiLog>(
        source.target,
        head,
        selected,
        "log",
        {
          recordId: job.id,
          attempt: log.attempt,
          logId: log.logId,
          startLine: log.startLine,
        },
      );
      if (!current()) return;
      const draft = repair
        ? ciRepair(source, head, selected, job, checked)
        : undefined;
      requestAgentContext({
        repair: draft?.evidence,
        onRefreshEvidence,
        onPrepared: onHandoff,
        context: draft
          ? {
              ...draft.context,
              instruction: repairInstruction ?? draft.context.instruction,
            }
          : ciLogContext(source, head, selected, job, checked),
        cwd: head.cwd,
        sourceSessionId: source.session,
        requireDestinationSelection: !source.session,
      });
    }, true);
  const external = (id?: number) =>
    void openUrl(ciUrl(source.target, id)).catch((error) =>
      setError(failure(error)),
    );
  return (
    <section className="space-y-2 border-t border-content/10 pt-3">
      <RepairStatus scope={ciKey(source.target)} cwd={head.cwd} />
      <h3 className="font-medium">
        {source.definitionName} · {source.projectName}
      </h3>
      <ReviewDetails summary="Pipeline mapping and account">
        <p>
          {source.target.site} · account {source.target.accountId}
          <br />
          Definition {source.target.definition} · {source.target.repositoryType}
          /{source.target.repositoryId}
          <br />
          {source.remote}
        </p>
        {!embedded ? (
          <button className={reviewDanger} disabled={busy} onClick={onRemove}>
            Disconnect pipeline
          </button>
        ) : null}
      </ReviewDetails>
      <div className="flex flex-wrap gap-1">
        <button
          className={button}
          disabled={busy || !sameAccount}
          onClick={() => refresh()}
        >
          {busy ? (
            <Loader className="size-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <RefreshCw className="size-3.5" strokeWidth={1.75} />
          )}
          Refresh runs
        </button>
        <button className={button} onClick={() => external()}>
          <ExternalLink className="size-3.5" strokeWidth={1.75} />
          Open pipeline in Azure
        </button>
        <button
          className={button}
          onClick={() =>
            openWatchSheet({
              source: {
                kind: "azure-ci",
                target: source.target,
                definitionName: source.definitionName,
                remote: source.remote,
                cwd: source.cwd,
                branch: source.branch,
                ...(source.session ? { sessionId: source.session } : {}),
              },
              name: `Failures · ${source.definitionName || "Pipeline"}`,
            })
          }
        >
          Watch failures
        </button>
      </div>
      {!status ? (
        <ReviewStatus>Checking Azure Pipelines…</ReviewStatus>
      ) : busy && !page ? (
        <ReviewStatus>Loading runs…</ReviewStatus>
      ) : null}
      {error ? (
        <div>
          <ReviewError>{error}</ReviewError>
          <button className={button} onClick={onReconnect}>
            Connection settings
          </button>
        </div>
      ) : null}
      {page && !page.items.some(ciMatches) ? (
        <p className="text-content/60">
          No matching run in this page for checkout {head.commit.slice(0, 8)}.
          Check the mapping or load older runs.
        </p>
      ) : null}
      {page?.items.map((value) => (
        <button
          key={value.id}
          className={`${button} block w-full text-left ${selected?.id === value.id ? "bg-content/10" : ""}`}
          disabled={busy || !sameAccount}
          onClick={() => select(value)}
        >
          <span className="block">
            Run {value.number} ·{" "}
            <span
              className={reviewToneText[ciTone(value.status, value.result)]}
            >
              {ciState(value.status, value.result)}
            </span>
          </span>
          <span className="block break-words text-content/50">
            {ciMatchLabel(value)} ·{" "}
            {value.commit?.slice(0, 8) || "unknown commit"} · {value.branch}
          </span>
        </button>
      ))}
      {page?.continuation ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => refresh(page.continuation)}
        >
          Older runs
        </button>
      ) : null}
      {selected ? (
        <div className="space-y-2 border-t border-content/10 pt-2">
          <p>
            Selected run {selected.number} ·{" "}
            <span
              className={
                reviewToneText[ciTone(selected.status, selected.result)]
              }
            >
              {ciState(selected.status, selected.result)}
            </span>{" "}
            · {ciMatchLabel(selected)}
          </p>
          <div className="flex flex-wrap gap-1">
            <button className={button} onClick={() => external(selected.id)}>
              <ExternalLink className="size-3.5" strokeWidth={1.75} />
              Open run in Azure
            </button>
            {jobs ? (
              <button
                className={button}
                disabled={busy || !sameAccount}
                onClick={() => loadJobs()}
              >
                <RefreshCw className="size-3.5" strokeWidth={1.75} />
                Refresh jobs
              </button>
            ) : !busy ? (
              <button
                className={button}
                disabled={!sameAccount}
                onClick={() => loadJobs()}
              >
                Load jobs
              </button>
            ) : null}
          </div>
          {detailError ? <ReviewError>{detailError}</ReviewError> : null}
          {jobs?.items.map((value) => (
            <div
              key={`${value.id}:${value.attempt}`}
              className="space-y-1 border-b border-content/10 py-2"
            >
              <p className="break-words">
                {value.parentName ? `${value.parentName} / ` : ""}
                {value.name} · {value.type} ·{" "}
                <span
                  className={reviewToneText[ciTone(value.state, value.result)]}
                >
                  {ciState(value.state, value.result)}
                </span>{" "}
                · attempt {value.attempt ?? "unknown"}
              </p>
              {value.previousAttempts?.length ? (
                <p className="text-content/50">
                  Earlier attempts:{" "}
                  {value.previousAttempts
                    .map((value) => value.attempt)
                    .join(", ")}{" "}
                  · open in Azure for historical logs
                </p>
              ) : null}
              {value.logId && value.attempt ? (
                <button
                  className={button}
                  disabled={busy || !sameAccount}
                  onClick={() => loadLog(value)}
                >
                  Load log · {value.name}
                </button>
              ) : (
                <p className="text-content/50">No log available</p>
              )}
            </div>
          ))}
          {jobs && skip > 0 ? (
            <button
              className={button}
              disabled={busy}
              onClick={() => loadJobs(Math.max(0, skip - 50))}
            >
              Previous jobs
            </button>
          ) : null}
          {jobs?.nextSkip != null ? (
            <button
              className={button}
              disabled={busy}
              onClick={() => loadJobs(jobs.nextSkip!)}
            >
              Next jobs
            </button>
          ) : null}
          {job && log ? (
            <section className="space-y-2">
              <h4>
                {job.name} · attempt {log.attempt}
              </h4>
              <p className="text-content/50">
                Lines {log.startLine + 1}–{log.endLine + 1} of {log.lineCount}.
                Bounded excerpt; common secret patterns removed. Review before
                sending.
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-content/10 bg-content/5 p-2 text-[11px]">
                {log.text || "No log text available."}
              </pre>
              <div className="flex flex-wrap gap-1">
                {log.startLine > 0 ? (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      loadLog(job, Math.max(0, log.startLine - 500))
                    }
                  >
                    Earlier log lines
                  </button>
                ) : null}
                {log.endLine + 1 < log.lineCount ? (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => loadLog(job, log.endLine + 1)}
                  >
                    Later log lines
                  </button>
                ) : null}
                <button
                  className={reviewAction}
                  disabled={busy || !sameAccount || !ciMatches(selected)}
                  onClick={() => handoff()}
                >
                  <Bot className="size-3.5" strokeWidth={1.75} />
                  Send log to agent
                </button>
                {selected.result === "failed" &&
                job.result === "failed" &&
                ciMatches(selected) ? (
                  <button
                    className={reviewAction}
                    disabled={busy || !sameAccount}
                    onClick={() => handoff(true)}
                  >
                    <Bot className="size-3.5" strokeWidth={1.75} />
                    Fix CI
                  </button>
                ) : null}
              </div>
              {!ciMatches(selected) ? (
                <p className="text-content/50">
                  This run is not verified for the current checkout commit.
                  Refresh or choose matching evidence before handoff.
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
