import { invoke } from "@tauri-apps/api/core";

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
export const ciContext = (cwd: string, forPr = false) =>
  invoke<CiCheckout>("azure_ci_context", forPr ? { cwd, forPr: true } : { cwd });
export function ciRead<T>(
  target: CiTarget,
  head: CiHead | null,
  run: Pick<CiRun, "id" | "revision">,
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
