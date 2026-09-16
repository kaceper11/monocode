// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  clearTaskCi,
  githubCheckState,
  gitlabPipelineState,
  loadTaskChildCi,
  peekTaskChildCi,
  subscribeTaskCiVersion,
  taskChildCiLoading,
  taskCiVersion,
} from "./taskCi";
import { clearInboxCache } from "./githubTasks";
import { clearGitlabCache } from "./gitlab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mocked = vi.mocked(invoke);
const cwd = "/repos/app";

function githubState(over: Record<string, unknown> = {}) {
  return {
    number: 5,
    title: "PR",
    url: "https://github.com/acme/app/pull/5",
    state: "OPEN",
    headRefName: "feat",
    headRefOid: "abc123",
    baseRefName: "main",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    isDraft: false,
    checks: [],
    ...over,
  };
}

function gitlabState(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "MR",
    url: "https://gitlab.com/group/app/-/merge_requests/7",
    state: "open",
    draft: false,
    repo: "group/app",
    headSha: "abc123",
    headRefName: "feat",
    baseRefName: "main",
    mergeStatus: "can_be_merged",
    blockingDiscussionsResolved: true,
    approvalsRequired: 0,
    approvalsLeft: 0,
    approved: true,
    pipeline: {
      id: 42,
      sha: "abc123",
      status: "failed",
      url: "https://gitlab.com/group/app/-/pipelines/42",
    },
    ...over,
  };
}

/** Map invoke commands to canned replies — one implementation per suite. */
function replies(handlers: Record<string, (args?: unknown) => unknown>) {
  mocked.mockImplementation(async (command, args) => {
    const handler = handlers[command as string];
    if (!handler) throw new Error(`unexpected invoke ${command as string}`);
    return handler(args);
  });
}

async function settled() {
  await vi.waitFor(() => expect(taskChildCiLoading(cwd, "feat")).toBe(false));
}

beforeEach(() => {
  clearTaskCi();
  clearInboxCache();
  clearGitlabCache();
  vi.clearAllMocks();
});

describe("githubCheckState", () => {
  it("normalizes check-run status+conclusion", () => {
    expect(githubCheckState("completed", "success")).toBe("Passed");
    expect(githubCheckState("completed", "failure")).toBe("Failed");
    expect(githubCheckState("completed", "timed_out")).toBe("Failed");
    expect(githubCheckState("completed", "action_required")).toBe("Failed");
    expect(githubCheckState("completed", "cancelled")).toBe("Cancelled");
    expect(githubCheckState("completed", "neutral")).toBe("Skipped");
    expect(githubCheckState("completed", "skipped")).toBe("Skipped");
    expect(githubCheckState("in_progress", "")).toBe("Running");
    expect(githubCheckState("queued", "")).toBe("Queued");
    expect(githubCheckState("waiting", "")).toBe("Queued");
  });
});

describe("gitlabPipelineState", () => {
  it("normalizes pipeline status", () => {
    expect(gitlabPipelineState("success")).toBe("Passed");
    expect(gitlabPipelineState("failed")).toBe("Failed");
    expect(gitlabPipelineState("running")).toBe("Running");
    expect(gitlabPipelineState("canceled")).toBe("Cancelled");
    expect(gitlabPipelineState("skipped")).toBe("Skipped");
    expect(gitlabPipelineState("manual")).toBe("Manual");
    expect(gitlabPipelineState("created")).toBe("Queued");
    expect(gitlabPipelineState("pending")).toBe("Queued");
  });
});

describe("loadTaskChildCi", () => {
  it("loads GitHub checks for the branch's PR", async () => {
    replies({
      git_pr_status: () => ({ number: 5 }),
      git_github_pr_state: () =>
        githubState({
          checks: [
            { name: "build", status: "completed", conclusion: "success" },
            {
              name: "lint",
              status: "completed",
              conclusion: "failure",
              url: "https://ci/lint",
            },
            { name: "test", status: "in_progress", conclusion: "" },
          ],
        }),
      git_github_repo: () => "acme/app",
      gitlab_mr_for_branch: () => null,
    });
    loadTaskChildCi(cwd, "feat");
    expect(taskChildCiLoading(cwd, "feat")).toBe(true);
    await settled();
    const ci = peekTaskChildCi(cwd, "feat");
    expect(ci?.github).toMatchObject({
      number: 5,
      repo: "acme/app",
      prState: "OPEN",
    });
    expect(ci?.github?.checks).toEqual([
      { name: "build", state: "Passed" },
      { name: "lint", state: "Failed", url: "https://ci/lint" },
      { name: "test", state: "Running" },
    ]);
    expect(ci?.gitlab).toBeNull();
  });

  it("uses a known PR number instead of rediscovering it", async () => {
    replies({
      git_github_pr_state: () => githubState(),
      git_github_repo: () => "acme/app",
      gitlab_mr_for_branch: () => null,
    });
    loadTaskChildCi(cwd, "feat", 5);
    await settled();
    expect(
      mocked.mock.calls.filter(([command]) => command === "git_pr_status"),
    ).toHaveLength(0);
    expect(peekTaskChildCi(cwd, "feat")?.github?.number).toBe(5);
  });

  it("drops GitHub state whose head moved to another branch", async () => {
    replies({
      git_pr_status: () => ({ number: 5 }),
      git_github_pr_state: () => githubState({ headRefName: "other" }),
      git_github_repo: () => "acme/app",
      gitlab_mr_for_branch: () => null,
    });
    loadTaskChildCi(cwd, "feat", 5);
    await settled();
    expect(peekTaskChildCi(cwd, "feat")?.github).toBeNull();
  });

  it("rediscovers when the caller's PR number is stale", async () => {
    replies({
      git_pr_status: () => ({ number: 9 }),
      git_github_pr_state: (args) =>
        (args as { number: number }).number === 5
          ? githubState({ headRefName: "old-branch" })
          : githubState({ number: 9, headRefName: "feat" }),
      git_github_repo: () => "acme/app",
      gitlab_mr_for_branch: () => null,
    });
    loadTaskChildCi(cwd, "feat", 5);
    await settled();
    expect(peekTaskChildCi(cwd, "feat")?.github?.number).toBe(9);
  });

  it("bounds retained checks to 50", async () => {
    replies({
      git_github_pr_state: () =>
        githubState({
          checks: Array.from({ length: 60 }, (_, index) => ({
            name: `check-${index}`,
            status: "completed",
            conclusion: "success",
          })),
        }),
      git_github_repo: () => "acme/app",
      gitlab_mr_for_branch: () => null,
    });
    loadTaskChildCi(cwd, "feat", 5);
    await settled();
    expect(peekTaskChildCi(cwd, "feat")?.github?.checks).toHaveLength(50);
  });

  it("loads the GitLab head pipeline with its MR binding", async () => {
    replies({
      git_github_pr_state: () => {
        throw new Error("not a github checkout");
      },
      git_pr_status: () => null,
      git_github_repo: () => {
        throw new Error("not a github checkout");
      },
      gitlab_mr_for_branch: () => ({
        number: 7,
        url: "https://gitlab.com/group/app/-/merge_requests/7",
      }),
      gitlab_mr_state: () => gitlabState(),
    });
    loadTaskChildCi(cwd, "feat");
    await settled();
    const ci = peekTaskChildCi(cwd, "feat");
    expect(ci?.gitlab).toEqual({
      mrNumber: 7,
      mrTitle: "MR",
      mrUrl: "https://gitlab.com/group/app/-/merge_requests/7",
      mrState: "open",
      repo: "group/app",
      pipeline: {
        id: 42,
        state: "Failed",
        url: "https://gitlab.com/group/app/-/pipelines/42",
      },
    });
    expect(ci?.github).toBeNull();
  });

  it("keeps a pipeline-less GitLab MR as an MR row", async () => {
    replies({
      git_pr_status: () => null,
      gitlab_mr_for_branch: () => ({
        number: 7,
        title: "MR",
        url: "https://gitlab.com/group/app/-/merge_requests/7",
        state: "open",
        repo: "group/app",
      }),
      gitlab_mr_state: () => gitlabState({ pipeline: null }),
    });
    loadTaskChildCi(cwd, "feat");
    await settled();
    const gl = peekTaskChildCi(cwd, "feat")?.gitlab;
    expect(gl?.mrNumber).toBe(7);
    expect(gl?.pipeline).toBeNull();
  });

  it("reports nothing when neither provider has a PR/MR", async () => {
    replies({
      git_pr_status: () => null,
      gitlab_mr_for_branch: () => null,
    });
    loadTaskChildCi(cwd, "feat");
    await settled();
    const ci = peekTaskChildCi(cwd, "feat");
    expect(ci?.github).toBeNull();
    expect(ci?.gitlab).toBeNull();
  });

  it("tolerates provider errors instead of rejecting", async () => {
    replies({
      git_pr_status: () => {
        throw new Error("offline");
      },
      gitlab_mr_for_branch: () => {
        throw new Error("offline");
      },
    });
    loadTaskChildCi(cwd, "feat");
    await settled();
    expect(peekTaskChildCi(cwd, "feat")?.github).toBeNull();
  });

  it("queues a rerun when a second load lands mid-flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    replies({
      git_github_pr_state: async () => {
        calls += 1;
        await gate;
        return githubState();
      },
      git_github_repo: () => "acme/app",
      gitlab_mr_for_branch: () => null,
    });
    loadTaskChildCi(cwd, "feat", 5);
    loadTaskChildCi(cwd, "feat", 5);
    release();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    await settled();
  });

  it("labels the entry by branch so a moved branch peeks null", async () => {
    replies({
      git_github_pr_state: () => githubState(),
      git_github_repo: () => "acme/app",
      gitlab_mr_for_branch: () => null,
    });
    loadTaskChildCi(cwd, "feat", 5);
    await settled();
    expect(peekTaskChildCi(cwd, "main")).toBeNull();
    expect(peekTaskChildCi(cwd, "feat")?.github?.number).toBe(5);
  });

  it("publishes a version bump on completion", async () => {
    replies({
      git_pr_status: () => null,
      gitlab_mr_for_branch: () => null,
    });
    const before = taskCiVersion();
    const listener = vi.fn();
    const unsubscribe = subscribeTaskCiVersion(listener);
    loadTaskChildCi(cwd, "feat");
    await settled();
    expect(taskCiVersion()).toBeGreaterThan(before);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
