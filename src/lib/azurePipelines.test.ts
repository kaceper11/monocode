// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  ciLogContext,
  ciMatches,
  ciRead,
  ciState,
  ciUrl,
  loadCiSources,
  parsePipelineUrl,
  saveCiSources,
  type CiRun,
  type CiSource,
} from "./azurePipelines";
import { loadWatchers, removeWatcher } from "./watchers";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  });
  vi.clearAllMocks();
});
const target = {
  site: "https://dev.azure.com/team",
  accountId: "account-a",
  project: "project-a",
  definition: 7,
  repositoryId: "team/repo",
  repositoryType: "GitHub",
  repositoryUrl: "https://github.com/team/repo",
};
const source: CiSource = {
  target,
  cwd: "wsl://Ubuntu/work/repo",
  branch: "feature",
  session: "owner",
  remote: target.repositoryUrl,
  definitionName: "Tests",
  projectName: "Project",
};
const run: CiRun = {
  id: 12,
  number: "12",
  status: "completed",
  result: "failed",
  branch: "refs/heads/feature",
  commit: "head",
  revision: "run-attempt-1",
  match: "exact",
  queuedAt: "now",
};
it("keeps CI separate from PR hosting and isolates source/account/checkout mappings", () => {
  expect(
    parsePipelineUrl(
      "https://dev.azure.com/team/Project%20A/_build?definitionId=7",
      "account-a",
    ),
  ).toMatchObject({
    site: target.site,
    project: "Project A",
    definition: 7,
    accountId: "account-a",
  });
  for (const url of [
    "https://dev.azure.com.evil.test/team/p/_build?definitionId=7",
    "https://user:pass@dev.azure.com/team/p/_build?definitionId=7",
    "https://dev.azure.com/team/p/_build?definitionId=0",
  ]) {
    expect(() => parsePipelineUrl(url, "account-a")).toThrow();
  }
  saveCiSources(
    [source, { ...source, target: { ...target, definition: 8 } }],
    source.cwd,
    source.branch,
    source.session,
  );
  expect(loadCiSources(source.cwd, source.branch, source.session)).toHaveLength(
    2,
  );
  expect(loadCiSources("/work/repo", source.branch, source.session)).toEqual(
    [],
  );
  expect(loadCiSources(source.cwd, source.branch, "other")).toEqual([]);
  expect(ciUrl(target, 12)).toBe(
    "https://dev.azure.com/team/project-a/_build?buildId=12",
  );
});
it("does not present stale, unknown, cancelled or partial evidence as a passing current run", () => {
  expect(ciMatches({ ...run, match: "old-commit", result: "succeeded" })).toBe(
    false,
  );
  expect(ciMatches({ ...run, match: "unverified-merge" })).toBe(false);
  expect(ciState("inProgress", "succeeded")).toBe("Running");
  expect(ciState("unknown", "succeeded")).toBe("Unknown");
  expect(ciState("completed", "canceled")).toBe("Cancelled");
  expect(ciState("completed", "partiallySucceeded")).toBe("Partially passed");
});
it("binds selected log reads and handoff to exact run, attempt, head and source identity", async () => {
  const head = {
    cwd: source.cwd,
    branch: source.branch,
    commit: "head",
    remote: source.remote,
  };
  const job = {
    id: "job-id",
    name: "Test",
    type: "Task",
    attempt: 2,
    state: "completed",
    result: "failed",
    logId: 9,
  };
  const log = {
    text: "expected 1, got 2",
    startLine: 500,
    endLine: 999,
    lineCount: 1000,
    recordId: job.id,
    attempt: 2,
    logId: 9,
    bounded: true,
  };
  await ciRead(target, head, run, "log", {
    recordId: job.id,
    attempt: 2,
    logId: 9,
    startLine: 500,
  });
  expect(invoke).toHaveBeenCalledWith("azure_ci_read", {
    input: {
      target,
      head,
      runId: 12,
      revision: run.revision,
      section: "log",
      recordId: job.id,
      attempt: 2,
      logId: 9,
      startLine: 500,
    },
  });
  const context = ciLogContext(source, head, run, job, log);
  expect(JSON.stringify(context)).toContain("attempt: 2");
  expect(JSON.stringify(context)).toContain("account-a");
  expect(JSON.stringify(context)).toContain("wsl://Ubuntu/work/repo");
  expect(JSON.stringify(context)).toContain("session owner");
  expect(context.entries[0].truncated).toBe(true);
});

it("auto-watches newly linked pipelines and lifts them when the scope drops them", () => {
  saveCiSources([source], source.cwd, source.branch, source.session);
  const watchers = loadWatchers();
  expect(watchers).toHaveLength(1);
  expect(watchers[0].auto).toBe(true);
  expect(watchers[0].source).toEqual({
    kind: "azure-ci",
    target: source.target,
    definitionName: "Tests",
    remote: source.remote,
    cwd: source.cwd,
    branch: source.branch,
    sessionId: "owner",
  });
  // Re-saving the same set is a refresh — no duplicate.
  saveCiSources([source], source.cwd, source.branch, source.session);
  expect(loadWatchers()).toHaveLength(1);
  // Dropping the source lifts its watcher.
  saveCiSources([], source.cwd, source.branch, source.session);
  expect(loadWatchers()).toHaveLength(0);
});

it("a hand-removed watcher is not resurrected by a source re-save", () => {
  saveCiSources([source], source.cwd, source.branch, source.session);
  removeWatcher(loadWatchers()[0].id);
  saveCiSources([source], source.cwd, source.branch, source.session);
  expect(loadWatchers()).toHaveLength(0);
});

it("keeps the watcher while another session scope still links the pipeline", () => {
  saveCiSources([source], source.cwd, source.branch, "owner");
  // A second session sharing the checkout links the same pipeline — its row
  // dedupes the watcher but keeps the delivery covered.
  saveCiSources(
    [{ ...source, session: "peer" }],
    source.cwd,
    source.branch,
    "peer",
  );
  expect(loadWatchers()).toHaveLength(1);
  saveCiSources([], source.cwd, source.branch, "owner");
  expect(loadWatchers()).toHaveLength(1);
  saveCiSources([], source.cwd, source.branch, "peer");
  expect(loadWatchers()).toHaveLength(0);
});
