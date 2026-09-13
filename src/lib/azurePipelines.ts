export const AZURE_CI_SOURCES_CHANGED = "monocode:azure-ci-sources";
import { invoke } from "@tauri-apps/api/core";
import { contextFromText } from "./agentContext";
import { pathKey } from "./paths";
import { ensureDeliveryWatcher, unwatchCiDelivery } from "./watchers";

export type CiTarget = {
  site: string;
  accountId: string;
  project: string;
  definition: number;
  repositoryId: string;
  repositoryType: string;
  repositoryUrl: string;
};
export type CiHead = {
  cwd: string;
  branch: string;
  commit: string;
  remote: string;
};
export type CiCheckout = Omit<CiHead, "remote"> & {
  remotes: { name: string; url: string }[];
};
export type CiRun = {
  id: number;
  number: string;
  status: string;
  result: string | null;
  branch: string;
  commit: string;
  queuedAt: string;
  revision: string;
  match:
    | "exact"
    | "pr-source"
    | "old-commit"
    | "other-branch"
    | "unverified-merge"
    | "unverified";
};
export type CiPage = {
  target: CiTarget;
  definitionName: string;
  projectName: string;
  items: CiRun[];
  continuation: string | null;
  checkedAt: number;
};
export type CiSource = {
  target: CiTarget;
  definitionName: string;
  projectName: string;
  remote: string;
  cwd: string;
  branch: string;
  session?: string;
  last?: { run: CiRun; commit: string; checkedAt: number };
};
export type CiJob = {
  id: string;
  name: string;
  type: string;
  parentName?: string;
  attempt: number | null;
  state: string;
  result: string | null;
  logId: number | null;
  previousAttempts?:
    { attempt: number; recordId: string; timelineId: string }[] | null;
};
export type CiJobs = {
  items: CiJob[];
  nextSkip: number | null;
  timelineId: string;
};
export type CiLog = {
  text: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  attempt: number;
  logId: number;
  recordId: string;
  bounded: boolean;
};
export const ciKey = (target: CiTarget) =>
  JSON.stringify([
    target.site,
    target.accountId,
    target.project,
    target.definition,
    target.repositoryId,
  ]);
export const ciScope = (cwd: string, branch: string, session?: string) =>
  JSON.stringify([cwd, branch, session ?? null]);
export const ciContext = (cwd: string) =>
  invoke<CiCheckout>("azure_ci_context", { cwd });
export function ciLookup(
  target: CiTarget,
  head: CiHead,
  continuation: string | null = null,
  runId?: number,
) {
  return invoke<CiPage>("azure_ci_lookup", {
    input: { target, head, continuation, ...(runId ? {runId} : {}) },
  });
}
export function ciRead<T>(
  target: CiTarget,
  head: CiHead,
  run: CiRun,
  section: "summary" | "jobs" | "log",
  options: {
    recordId?: string;
    attempt?: number;
    logId?: number;
    startLine?: number;
    skip?: number;
  } = {},
) {
  return invoke<T>("azure_ci_read", {
    input: {
      target,
      head,
      runId: run.id,
      revision: run.revision,
      section,
      ...options,
    },
  });
}
export function ciUrl(target: CiTarget, run?: number) {
  const site = new URL(target.site);
  if (
    site.origin !== "https://dev.azure.com" ||
    !/^\/[a-z0-9-]+$/i.test(site.pathname) ||
    site.username ||
    site.password ||
    site.search ||
    site.hash ||
    !Number.isInteger(target.definition) ||
    target.definition <= 0 ||
    !target.project ||
    /[/\\?#\x00-\x1f]/.test(target.project) ||
    [".", ".."].includes(target.project) ||
    (run != null && (!Number.isInteger(run) || run <= 0))
  )
    throw new Error("Invalid Azure pipeline identity");
  return `${target.site}/${encodeURIComponent(target.project)}/_build?${run ? `buildId=${run}` : `definitionId=${target.definition}`}`;
}
export function parsePipelineUrl(raw: string, accountId: string): CiTarget {
  if (raw.length > 2048) throw new Error("Pipeline link is too long");
  const url = new URL(raw.trim());
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.origin !== "https://dev.azure.com" ||
    url.username ||
    url.password ||
    url.hash ||
    parts.length !== 3 ||
    parts[2] !== "_build"
  )
    throw new Error(
      "Paste an Azure DevOps pipeline link ending in _build?definitionId=…",
    );
  const definition = Number(url.searchParams.get("definitionId"));
  const target = {
    site: `https://dev.azure.com/${parts[0].toLowerCase()}`,
    accountId,
    project: decodeURIComponent(parts[1]),
    definition,
    repositoryId: "",
    repositoryType: "",
    repositoryUrl: "",
  };
  ciUrl(target);
  return target;
}
export function ciState(status: string, result: string | null): string {
  if (status === "notStarted" || status === "pending") return "Queued";
  if (status === "inProgress") return "Running";
  if (status === "cancelling") return "Cancelling";
  if (status !== "completed") return "Unknown";
  return (
    (
      {
        succeeded: "Passed",
        partiallySucceeded: "Partially passed",
        succeededWithIssues: "Passed with issues",
        failed: "Failed",
        canceled: "Cancelled",
        skipped: "Skipped",
        abandoned: "Abandoned",
      } as Record<string, string>
    )[result ?? ""] ?? "Unknown"
  );
}
export const ciMatches = (run: CiRun) =>
  run.match === "exact" || run.match === "pr-source";
export const ciMatchLabel = (run: CiRun) =>
  ({
    exact: "Current checkout commit",
    "pr-source": "PR merge build · source head verified",
    "old-commit": "Old commit",
    "other-branch": "Other branch",
    "unverified-merge": "PR merge revision not verified",
    unverified: "Revision unknown",
  })[run.match] ?? "Revision unknown";
export function ciLogContext(
  source: CiSource,
  head: CiHead,
  run: CiRun,
  job: CiJob,
  log: CiLog,
) {
  const context = contextFromText(
    `Azure Pipelines · ${source.definitionName} · ${job.name}`,
    `Run ${run.id} (${run.number}): ${ciState(run.status, run.result)}\nPipeline: ${source.target.definition}; repository: ${source.target.repositoryType}/${source.target.repositoryId}\nBranch: ${run.branch}; build commit: ${run.commit}; checkout commit: ${head.commit}\n${ciMatchLabel(run)}\nJob/task: ${job.id}; attempt: ${log.attempt}; log: ${log.logId}; lines: ${log.startLine + 1}–${log.endLine + 1}\nRun revision: ${run.revision}\n\nBounded log excerpt; common secret patterns and terminal controls removed. Review before sending.\n\n${log.text}`,
    `${ciUrl(source.target, run.id)} · account ${source.target.accountId} · checkout ${head.cwd} · session ${source.session ?? "not assigned"}`,
  );
  context.entries[0].truncated = log.bounded;
  return context;
}
const KEY = "monocode.azureCiSources.v1";
/** Every saved CI source, validated — one storage read for callers that
 * aggregate several scopes (e.g. a task's repository children). */
export function allCiSources(): CiSource[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(rows)) return [];
    return rows
      .slice(0, 100)
      .filter((row): row is CiSource => {
        try {
          ciUrl(row.target);
          return (
            typeof row.target.accountId === "string" &&
            [
              row.remote,
              row.definitionName,
              row.projectName,
              row.target.repositoryId,
              row.target.repositoryType,
              row.target.repositoryUrl,
            ].every((value) => typeof value === "string")
          );
        } catch {
          return false;
        }
      })
      .map((row) => ({
        ...row,
        last:
          row.last &&
          typeof row.last.commit === "string" &&
          typeof row.last.run?.revision === "string" &&
          Number.isInteger(row.last.run?.id)
            ? row.last
            : undefined,
      }));
  } catch {
    return [];
  }
}
export function loadCiSources(
  cwd: string,
  branch: string,
  session?: string,
): CiSource[] {
  return allCiSources().filter(
    (row) =>
      ciScope(row.cwd, row.branch, row.session) ===
        ciScope(cwd, branch, session) ||
      // A session-scoped view also owns session-less rows — they were linked
      // at the checkout itself, so a pane must see (and unlink) them.
      (session !== undefined &&
        row.session === undefined &&
        row.cwd === cwd &&
        row.branch === branch),
  );
}
/** A deleted session can no longer own a source — the row stays (the
 * pipeline still belongs to the checkout) but drops the dead owner so
 * coverage and watcher rebinds never point at it. Session-less twins
 * collapse. */
export function unbindCiSourceSession(sessionId: string) {
  const rows = allCiSources();
  if (!rows.some((row) => row.session === sessionId)) return;
  const seen = new Set<string>();
  const next = rows
    .map((row) =>
      row.session === sessionId ? { ...row, session: undefined } : row,
    )
    .filter((row) => {
      const key = JSON.stringify([
        ciKey(row.target),
        pathKey(row.cwd),
        row.branch,
        row.session ?? "",
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  localStorage.setItem(KEY, JSON.stringify(next));
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(AZURE_CI_SOURCES_CHANGED));
}
export function saveCiSources(
  sources: CiSource[],
  cwd: string,
  branch: string,
  session?: string,
) {
  let rows: CiSource[] = [];
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(stored)) rows = stored;
  } catch {
    /* Recover this feature's malformed cache. */
  }
  const scope = ciScope(cwd, branch, session);
  // Scope members before this write — diffed against the new set below so
  // only first-time links register a watcher and departed ones are lifted.
  // A session-scoped write also owns session-less rows at this checkout.
  const inScope = (row: CiSource) =>
    row &&
    row.target &&
    (ciScope(row.cwd, row.branch, row.session) === scope ||
      (session !== undefined &&
        row.session === undefined &&
        row.cwd === cwd &&
        row.branch === branch));
  const previous = rows.filter(inScope);
  const others = rows.filter((row) => row && !inScope(row));
  const merged = [...sources.slice(0, 20), ...others];
  const stored = merged.slice(0, 100);
  localStorage.setItem(KEY, JSON.stringify(stored));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AZURE_CI_SOURCES_CHANGED));
  const before = new Set(previous.map((row) => ciKey(row.target)));
  const covered = (target: CiTarget, atCwd: string, atBranch: string) =>
    stored.some(
      (row) =>
        row?.target &&
        ciKey(row.target) === ciKey(target) &&
        pathKey(row.cwd) === pathKey(atCwd) &&
        row.branch === atBranch,
    );
  for (const source of sources.slice(0, 20)) {
    if (before.has(ciKey(source.target))) continue;
    ensureDeliveryWatcher({
      kind: "azure-ci",
      target: source.target,
      definitionName: source.definitionName,
      remote: source.remote,
      cwd,
      branch,
      ...(source.session ?? session
        ? { sessionId: source.session ?? session }
        : {}),
    });
  }
  // A source leaves the scope → lift its watcher unless another scope's row
  // still covers the same pipeline at this checkout+branch.
  for (const row of previous)
    if (!covered(row.target, cwd, branch))
      unwatchCiDelivery(row.target, cwd, branch);
  // Rows the cap pushed out can orphan a watcher — same coverage rule.
  for (const row of merged.slice(100))
    if (
      row?.target &&
      typeof row.cwd === "string" &&
      typeof row.branch === "string" &&
      !covered(row.target, row.cwd, row.branch)
    )
      unwatchCiDelivery(row.target, row.cwd, row.branch);
}
