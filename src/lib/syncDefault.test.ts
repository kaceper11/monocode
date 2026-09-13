// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import {
  abortMerge,
  opLabel,
  sendMergeConflictsToAgent,
  syncConfirmText,
  syncWithDefaultBranch,
} from "./syncDefault";
import { requestAgentContext } from "./agentContext";
import { subscribeGitChanged, type GitDiffIndex } from "./fs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(async () => true),
  message: vi.fn(async () => undefined),
}));
vi.mock("./agentContext", async (original) => ({
  ...(await original<typeof import("./agentContext")>()),
  requestAgentContext: vi.fn(),
}));

const cleanIndex: GitDiffIndex = {
  branch: "feature",
  files: [],
  additions: 0,
  deletions: 0,
  remote: "origin",
  upstream: null,
  defaultBranch: "main",
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
  opInProgress: false,
  op: "",
  conflicts: [],
  mergeHead: null,
  detached: false,
};

function mockInvoke(handler: (command: string, args?: unknown) => unknown) {
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    handler(command, args),
  );
}

function syncResult(overrides: Record<string, unknown>) {
  return {
    outcome: "merged",
    branch: "feature",
    syncedWith: "origin/main",
    commits: [] as string[],
    commitCount: 0,
    conflicts: [] as string[],
    reason: "",
    ...overrides,
  };
}

function mergeContext(overrides: Record<string, unknown>) {
  return {
    merging: true,
    op: "merge",
    conflicts: ["src/app.ts"],
    mergeHead: "abc1234",
    incomingRef: "origin/main",
    diff: "",
    ...overrides,
  };
}

function invokedCommands(): string[] {
  return vi.mocked(invoke).mock.calls.map(([command]) => String(command));
}

function lastAsk(): string {
  return String(vi.mocked(ask).mock.calls.at(-1)?.[0] ?? "");
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(ask).mockReset().mockResolvedValue(true);
  vi.mocked(message).mockReset().mockResolvedValue(undefined);
  vi.mocked(requestAgentContext).mockReset();
});

it("labels each operation kind for banners and dialogs", () => {
  expect(opLabel("merge")).toBe("Merge");
  expect(opLabel("rebase")).toBe("Rebase");
  expect(opLabel("cherry-pick")).toBe("Cherry-pick");
  expect(opLabel("revert")).toBe("Revert");
  expect(opLabel("")).toBe("Merge");
  expect(opLabel(undefined)).toBe("Merge");
});

it("names fetch, merge, the exact refs, working copy and host in the confirm", () => {
  const text = syncConfirmText("/repo/wt", {
    ...cleanIndex,
    branch: "feat/x",
  });
  expect(text).toContain("merge origin/main into feat/x");
  expect(text).toContain("/repo/wt");
  expect(text).toContain("Fetch origin");
});

it("reports a WSL host instead of the native platform", () => {
  const text = syncConfirmText("//wsl.localhost/Ubuntu/home/me/repo", {
    ...cleanIndex,
    defaultBranch: "master",
  });
  expect(text).toContain("origin/master");
  expect(text).toContain("WSL · Ubuntu");
  expect(text).not.toContain("macOS");
});

it("runs fetch+merge after confirmation and reports merged commits", async () => {
  const asks: string[] = [];
  vi.mocked(ask).mockImplementation(async (text) => {
    asks.push(String(text));
    return true;
  });
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ commits: ["remote work"], commitCount: 1 });
    return null;
  });
  const result = await syncWithDefaultBranch({ cwd: "/repo" });
  expect(result?.outcome).toBe("merged");
  expect(asks[0]).toContain("merge origin/main into feature");
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain("remote work");
  // The confirmed branch is pinned so a moved checkout is refused backend-side.
  const call = vi
    .mocked(invoke)
    .mock.calls.find(([c]) => c === "git_sync_branch");
  expect(call?.[1]).toEqual({ cwd: "/repo", expectedBranch: "feature" });
});

it("never runs the sync when the user declines the confirmation", async () => {
  vi.mocked(ask).mockResolvedValue(false);
  mockInvoke((command) =>
    command === "git_diff_index" ? cleanIndex : null,
  );
  const result = await syncWithDefaultBranch({ cwd: "repo" });
  expect(result).toBeUndefined();
  expect(invokedCommands()).not.toContain("git_sync_branch");
});

it("refuses a session with no real working copy instead of syncing ~", async () => {
  for (const cwd of ["", "~"]) {
    vi.mocked(invoke).mockClear();
    vi.mocked(message).mockClear();
    const result = await syncWithDefaultBranch({ cwd });
    expect(result).toBeUndefined();
    expect(invokedCommands()).toHaveLength(0);
    expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
      "no working copy",
    );
  }
});

it("refuses before confirming when the tree is dirty", async () => {
  mockInvoke((command) =>
    command === "git_diff_index"
      ? {
          ...cleanIndex,
          files: [
            {
              relative: "a.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              staged: false,
              unstaged: true,
            },
          ],
        }
      : null,
  );
  const result = await syncWithDefaultBranch({ cwd: "/repo" });
  expect(result).toBeUndefined();
  expect(invokedCommands()).not.toContain("git_sync_branch");
  const text = String(vi.mocked(message).mock.calls.at(-1)?.[0]);
  expect(text).toContain("1 uncommitted change");
  expect(text).toContain("nothing is stashed");
});

it("refuses before confirming when an operation is already in progress", async () => {
  mockInvoke((command) =>
    command === "git_diff_index"
      ? { ...cleanIndex, opInProgress: true, op: "rebase", conflicts: ["a.ts"] }
      : null,
  );
  const result = await syncWithDefaultBranch({ cwd: "/repo" });
  expect(result).toBeUndefined();
  expect(invokedCommands()).not.toContain("git_sync_branch");
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
    "A rebase is already in progress",
  );
});

it("refuses before confirming on a detached HEAD", async () => {
  mockInvoke((command) =>
    command === "git_diff_index"
      ? { ...cleanIndex, branch: "abc1234", detached: true }
      : null,
  );
  const result = await syncWithDefaultBranch({ cwd: "/repo" });
  expect(result).toBeUndefined();
  expect(invokedCommands()).not.toContain("git_sync_branch");
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
    "Check out a branch",
  );
});

it("refuses before confirming without a remote or default branch", async () => {
  for (const index of [
    { ...cleanIndex, remote: null },
    { ...cleanIndex, defaultBranch: null },
  ]) {
    vi.mocked(invoke).mockClear();
    vi.mocked(message).mockClear();
    mockInvoke((command) =>
      command === "git_diff_index" ? index : null,
    );
    const result = await syncWithDefaultBranch({ cwd: "/repo" });
    expect(result).toBeUndefined();
    expect(invokedCommands()).not.toContain("git_sync_branch");
    expect(vi.mocked(message)).toHaveBeenCalled();
  }
});

it("surfaces a refused sync as a warning, not an error throw", async () => {
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({
        outcome: "refused",
        branch: "",
        syncedWith: "",
        reason: "3 uncommitted changes. Commit or stash before syncing — nothing is stashed automatically.",
      });
    return null;
  });
  const result = await syncWithDefaultBranch({ cwd: "/repo" });
  expect(result?.outcome).toBe("refused");
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
    "uncommitted changes",
  );
});

it("reports an up-to-date branch without offering resolution", async () => {
  const changed: (string | undefined)[] = [];
  const off = subscribeGitChanged((cwd) => changed.push(cwd));
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "up-to-date" });
    return null;
  });
  const result = await syncWithDefaultBranch({ cwd: "/repo" });
  off();
  expect(result?.outcome).toBe("up-to-date");
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
    "already up to date with origin/main",
  );
  // One confirmation ask, no resolution asks.
  expect(vi.mocked(ask)).toHaveBeenCalledTimes(1);
  expect(changed).toEqual(["/repo"]);
});

it("offers the resolution flow when the merge stops with conflicts", async () => {
  // ask#1 confirm sync → true; ask#2 send to agent → true.
  vi.mocked(ask)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true);
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({
        outcome: "conflicted",
        conflicts: ["src/app.ts"],
      });
    if (command === "git_merge_context") return mergeContext({});
    return null;
  });
  const result = await syncWithDefaultBranch({
    cwd: "/repo",
    sessionId: "owner-1",
  });
  expect(result?.outcome).toBe("conflicted");
  expect(lastAsk()).toContain("Merging origin/main");
  expect(lastAsk()).toContain("src/app.ts");
  expect(requestAgentContext).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(requestAgentContext).mock.calls[0][0]?.sourceSessionId,
  ).toBe("owner-1");
});

it("aborts only after a second explicit confirm when send is declined", async () => {
  // ask#1 confirm sync → true; ask#2 send → false; ask#3 abort → true.
  vi.mocked(ask)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const changed: (string | undefined)[] = [];
  const off = subscribeGitChanged((cwd) => changed.push(cwd));
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "conflicted", conflicts: ["a.ts"] });
    if (command === "git_merge_abort") return "aborted";
    return null;
  });
  const result = await syncWithDefaultBranch({ cwd: "/repo" });
  off();
  expect(result?.outcome).toBe("conflicted");
  expect(lastAsk()).toContain("abort the merge");
  expect(invokedCommands()).toContain("git_merge_abort");
  expect(requestAgentContext).not.toHaveBeenCalled();
  // sync + abort notifications.
  expect(changed).toEqual(["/repo", "/repo"]);
});

it("keeps the conflicts when the user declines both send and abort", async () => {
  vi.mocked(ask)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false);
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "conflicted", conflicts: ["a.ts"] });
    return null;
  });
  await syncWithDefaultBranch({ cwd: "/repo" });
  expect(invokedCommands()).not.toContain("git_merge_abort");
  expect(requestAgentContext).not.toHaveBeenCalled();
});

it("sends live merge state — host, cwd, branch, incoming ref, paths, bounded diff — to the owning session", async () => {
  mockInvoke((command) => {
    if (command === "git_merge_context")
      return mergeContext({
        diff: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> FETCH_HEAD",
      });
    if (command === "git_diff_index") return cleanIndex;
    return null;
  });
  const sent = await sendMergeConflictsToAgent({
    cwd: "/repo",
    sessionId: "owner-1",
  });
  expect(sent).toBe(true);
  const request = vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0];
  expect(request?.sourceSessionId).toBe("owner-1");
  expect(request?.cwd).toBe("/repo");
  expect(request?.requireDestinationSelection).toBe(false);
  const entries = request?.context.entries ?? [];
  expect(entries).toHaveLength(2);
  expect(entries[0].text).toContain("Working copy: /repo");
  expect(entries[0].text).toContain("Incoming head: origin/main");
  expect(entries[0].text).toContain("src/app.ts");
  expect(entries[0].text).toContain("preserve both sides");
  expect(entries[0].text).toContain("do not commit or push");
  expect(entries[1].text).toContain("<<<<<<< HEAD");
});

it("describes a non-merge operation honestly — never claims origin/main", async () => {
  mockInvoke((command) => {
    if (command === "git_merge_context")
      return mergeContext({
        op: "rebase",
        incomingRef: null,
        mergeHead: "def5678",
      });
    if (command === "git_diff_index") return cleanIndex;
    return null;
  });
  const sent = await sendMergeConflictsToAgent({ cwd: "/repo" });
  expect(sent).toBe(true);
  const entries =
    vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0]?.context.entries ??
    [];
  expect(entries[0].title).toContain("Rebase conflicts");
  expect(entries[0].text).toContain("A rebase in feature");
  expect(entries[0].text).toContain("Operation: rebase");
  expect(entries[0].text).toContain("Incoming head: def5678");
  expect(entries[0].text).not.toContain("origin/main");
});

it("reports an unknown incoming head instead of inventing a ref", async () => {
  mockInvoke((command) => {
    if (command === "git_merge_context")
      return mergeContext({
        op: "cherry-pick",
        incomingRef: null,
        mergeHead: null,
      });
    if (command === "git_diff_index") return cleanIndex;
    return null;
  });
  await sendMergeConflictsToAgent({ cwd: "/repo" });
  const text =
    vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0]?.context.entries[0]
      .text ?? "";
  expect(text).toContain("Operation: cherry-pick");
  expect(text).toContain("Incoming head: unknown");
});

it("routes to the destination picker when the working copy has no owner", async () => {
  mockInvoke((command) => {
    if (command === "git_merge_context")
      return mergeContext({ conflicts: ["a.ts"], mergeHead: null, incomingRef: null });
    if (command === "git_diff_index") return cleanIndex;
    return null;
  });
  await sendMergeConflictsToAgent({ cwd: "/repo" });
  const request = vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0];
  expect(request?.requireDestinationSelection).toBe(true);
  expect(request?.sourceSessionId).toBeUndefined();
});

it("sends nothing when the merge already ended, leaving the tree alone", async () => {
  mockInvoke((command) =>
    command === "git_merge_context"
      ? mergeContext({
          merging: false,
          op: "",
          conflicts: [],
          mergeHead: null,
          incomingRef: null,
        })
      : null,
  );
  expect(await sendMergeConflictsToAgent({ cwd: "/repo" })).toBe(false);
  expect(requestAgentContext).not.toHaveBeenCalled();
});

it("still sends when the index read fails — merge state is authoritative", async () => {
  mockInvoke((command) => {
    if (command === "git_merge_context") return mergeContext({});
    if (command === "git_diff_index") throw new Error("index unavailable");
    return null;
  });
  expect(await sendMergeConflictsToAgent({ cwd: "/repo" })).toBe(true);
  const text =
    vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0]?.context.entries[0]
      .text ?? "";
  expect(text).toContain("Branch: the current branch");
});

it("aborts only after an explicit confirm naming the operation", async () => {
  mockInvoke((command) =>
    command === "git_diff_index"
      ? { ...cleanIndex, opInProgress: true, op: "rebase" }
      : null,
  );
  vi.mocked(ask).mockResolvedValueOnce(false);
  expect(await abortMerge({ cwd: "/repo" })).toBe(false);
  expect(invokedCommands()).not.toContain("git_merge_abort");
  expect(lastAsk()).toContain("Abort the rebase");

  vi.mocked(ask).mockResolvedValueOnce(true);
  expect(await abortMerge({ cwd: "/repo" })).toBe(true);
  expect(invokedCommands()).toContain("git_merge_abort");
});
