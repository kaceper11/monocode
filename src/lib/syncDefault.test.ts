// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "./dialogs";
import {
  abortMerge,
  acquireSyncSlot,
  mergeResolutionSnapshot,
  offerMergeResolution,
  opLabel,
  sendMergeConflictsToAgent,
  syncConfirmText,
  syncTaskBranches,
  syncWithDefaultBranch,
} from "./syncDefault";
import { requestAgentContext } from "./agentContext";
import { subscribeGitChanged, type GitDiffIndex } from "./fs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./dialogs", () => ({
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
  localOnly: [],
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
  mockInvoke((command) => (command === "git_diff_index" ? cleanIndex : null));
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
    mockInvoke((command) => (command === "git_diff_index" ? index : null));
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
        reason:
          "3 uncommitted changes. Commit or stash before syncing — nothing is stashed automatically.",
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
  // ask#1 confirm sync → true; the in-app sheet then resolves "agent".
  vi.mocked(ask).mockResolvedValueOnce(true);
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
  const pending = syncWithDefaultBranch({
    cwd: "/repo",
    sessionId: "owner-1",
  });
  await vi.waitFor(() => expect(mergeResolutionSnapshot().length).toBe(1));
  const sheet = mergeResolutionSnapshot()[0]!;
  expect(sheet.syncedWith).toBe("origin/main");
  expect(sheet.conflicts).toEqual(["src/app.ts"]);
  expect(sheet.sessionId).toBe("owner-1");
  sheet.choose("agent");
  const result = await pending;
  expect(result?.outcome).toBe("conflicted");
  expect(mergeResolutionSnapshot().length).toBe(0);
  expect(requestAgentContext).toHaveBeenCalledTimes(1);
  expect(vi.mocked(requestAgentContext).mock.calls[0][0]?.sourceSessionId).toBe(
    "owner-1",
  );
});

it("aborts when the sheet chooses abort", async () => {
  // ask#1 confirm sync → true; sheet → "abort".
  vi.mocked(ask).mockResolvedValueOnce(true);
  const changed: (string | undefined)[] = [];
  const off = subscribeGitChanged((cwd) => changed.push(cwd));
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "conflicted", conflicts: ["a.ts"] });
    if (command === "git_merge_context") return mergeContext({});
    if (command === "git_merge_abort") return "aborted";
    return null;
  });
  const pending = syncWithDefaultBranch({ cwd: "/repo" });
  await vi.waitFor(() => expect(mergeResolutionSnapshot().length).toBe(1));
  mergeResolutionSnapshot()[0]!.choose("abort");
  const result = await pending;
  off();
  expect(result?.outcome).toBe("conflicted");
  expect(invokedCommands()).toContain("git_merge_abort");
  expect(requestAgentContext).not.toHaveBeenCalled();
  // sync + abort notifications.
  expect(changed).toEqual(["/repo", "/repo"]);
});

it("keeps the conflicts when the sheet is dismissed (keep)", async () => {
  vi.mocked(ask).mockResolvedValueOnce(true);
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "conflicted", conflicts: ["a.ts"] });
    return null;
  });
  const pending = syncWithDefaultBranch({ cwd: "/repo" });
  await vi.waitFor(() => expect(mergeResolutionSnapshot().length).toBe(1));
  mergeResolutionSnapshot()[0]!.choose("keep");
  await pending;
  expect(invokedCommands()).not.toContain("git_merge_abort");
  expect(requestAgentContext).not.toHaveBeenCalled();
});

it("a second offer for the same working copy resolves the first as keep", async () => {
  mockInvoke((command) => {
    if (command === "git_merge_context")
      return mergeContext({ merging: false, op: "", conflicts: [] });
    return null;
  });
  const first = offerMergeResolution({ cwd: "/repo" }, "origin/main", ["a.ts"]);
  const second = offerMergeResolution({ cwd: "/repo" }, "origin/main", [
    "b.ts",
  ]);
  // The first sheet was auto-resolved as keep; only the newest stays pending.
  await vi.waitFor(() => expect(mergeResolutionSnapshot().length).toBe(1));
  expect(mergeResolutionSnapshot()[0]!.conflicts).toEqual(["b.ts"]);
  mergeResolutionSnapshot()[0]!.choose("keep");
  await Promise.all([first, second]);
  expect(mergeResolutionSnapshot().length).toBe(0);
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
  expect(request?.destination).toEqual({ kind: "source" });
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
      return mergeContext({
        conflicts: ["a.ts"],
        mergeHead: null,
        incomingRef: null,
      });
    if (command === "git_diff_index") return cleanIndex;
    return null;
  });
  await sendMergeConflictsToAgent({ cwd: "/repo" });
  const request = vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0];
  // No owning session — the source destination can't resolve and the
  // handler falls back to the destination picker.
  expect(request?.destination).toEqual({ kind: "source" });
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
    command === "git_merge_context" ? mergeContext({ op: "rebase" }) : null,
  );
  vi.mocked(ask).mockResolvedValueOnce(false);
  expect(await abortMerge({ cwd: "/repo" })).toBe(false);
  expect(invokedCommands()).not.toContain("git_merge_abort");
  expect(lastAsk()).toContain("Abort the rebase");

  vi.mocked(ask).mockResolvedValueOnce(true);
  expect(await abortMerge({ cwd: "/repo" })).toBe(true);
  expect(invokedCommands()).toContain("git_merge_abort");
});

it("skips the abort dialog entirely when nothing is in progress", async () => {
  mockInvoke((command) =>
    command === "git_merge_context"
      ? mergeContext({ merging: false, op: "", conflicts: [] })
      : null,
  );
  expect(await abortMerge({ cwd: "/repo" })).toBe(false);
  expect(ask).not.toHaveBeenCalled();
  expect(invokedCommands()).not.toContain("git_merge_abort");
});

it("refuses a second sync while one is still awaiting confirmation", async () => {
  let resolveFirst: ((value: boolean) => void) | undefined;
  vi.mocked(ask).mockImplementationOnce(
    () => new Promise((resolve) => (resolveFirst = resolve)),
  );
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "up-to-date" });
    return null;
  });
  const first = syncWithDefaultBranch({ cwd: "/repo" });
  await vi.waitFor(() => expect(vi.mocked(ask)).toHaveBeenCalledTimes(1));
  const second = await syncWithDefaultBranch({ cwd: "/repo" });
  expect(second).toBeUndefined();
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
    "already running",
  );
  expect(invokedCommands()).not.toContain("git_sync_branch");
  resolveFirst?.(false);
  await first;
});

it("shares one slot across spellings of the same working copy", async () => {
  let resolveFirst: ((value: boolean) => void) | undefined;
  vi.mocked(ask).mockImplementationOnce(
    () => new Promise((resolve) => (resolveFirst = resolve)),
  );
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "up-to-date" });
    return null;
  });
  const first = syncWithDefaultBranch({ cwd: "/repo" });
  await vi.waitFor(() => expect(vi.mocked(ask)).toHaveBeenCalledTimes(1));
  // "/repo/" is the same working copy — its confirm must not stack.
  expect(await syncWithDefaultBranch({ cwd: "/repo/" })).toBeUndefined();
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
    "already running",
  );
  resolveFirst?.(false);
  await first;
});

it("keeps the slot held while the conflict resolution sheet is open", async () => {
  // ask#1 confirm → true; the sheet then waits for a choice.
  vi.mocked(ask).mockResolvedValueOnce(true);
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "conflicted", conflicts: ["a.ts"] });
    if (command === "git_merge_context") return mergeContext({});
    return null;
  });
  const first = syncWithDefaultBranch({ cwd: "/repo" });
  await vi.waitFor(() => expect(mergeResolutionSnapshot().length).toBe(1));
  // A second sync while the user is still deciding must refuse.
  expect(await syncWithDefaultBranch({ cwd: "/repo" })).toBeUndefined();
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
    "already running",
  );
  mergeResolutionSnapshot()[0]!.choose("keep");
  await first;
});

it("releases the slot once the flow finishes", async () => {
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "up-to-date" });
    return null;
  });
  await syncWithDefaultBranch({ cwd: "/repo" });
  // The same working copy must sync again — a leaked slot would refuse.
  expect(await syncWithDefaultBranch({ cwd: "/repo" })).toEqual(
    expect.objectContaining({ outcome: "up-to-date" }),
  );
});

it("releases the slot even when the sync throws", async () => {
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch") throw new Error("bridge down");
    return null;
  });
  await expect(syncWithDefaultBranch({ cwd: "/repo" })).rejects.toThrow(
    "bridge down",
  );
  // A second attempt must not report "already running".
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "up-to-date" });
    return null;
  });
  expect(await syncWithDefaultBranch({ cwd: "/repo" })).toEqual(
    expect.objectContaining({ outcome: "up-to-date" }),
  );
});

it("does not block syncs on other working copies", async () => {
  let resolveFirst: ((value: boolean) => void) | undefined;
  vi.mocked(ask)
    .mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    )
    .mockResolvedValueOnce(true);
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "up-to-date" });
    return null;
  });
  const first = syncWithDefaultBranch({ cwd: "/repo-a" });
  await vi.waitFor(() => expect(vi.mocked(ask)).toHaveBeenCalledTimes(1));
  // A different working copy proceeds while /repo-a waits on its confirm.
  expect(await syncWithDefaultBranch({ cwd: "/repo-b" })).toEqual(
    expect.objectContaining({ outcome: "up-to-date" }),
  );
  resolveFirst?.(false);
  await first;
});

it("propagates a failed context read out of the resolution flow", async () => {
  vi.mocked(ask).mockResolvedValueOnce(true);
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "conflicted", conflicts: ["a.ts"] });
    if (command === "git_merge_context") throw new Error("bridge down");
    return null;
  });
  const pending = syncWithDefaultBranch({ cwd: "/repo" });
  await vi.waitFor(() => expect(mergeResolutionSnapshot().length).toBe(1));
  mergeResolutionSnapshot()[0]!.choose("agent");
  await expect(pending).rejects.toThrow("bridge down");
});

it("labels the abort confirm generically when the state read fails", async () => {
  mockInvoke((command) => {
    if (command === "git_merge_context") throw new Error("bridge down");
    return null;
  });
  expect(await abortMerge({ cwd: "/repo" })).toBe(true);
  expect(lastAsk()).toContain("Abort the operation");
  expect(invokedCommands()).toContain("git_merge_abort");
});

it("says nothing is left to abort when the op ended before the choice", async () => {
  // ask#1 confirm sync → true; sheet → "abort"; but the merge ended
  // meanwhile — the abort command must never run.
  vi.mocked(ask).mockResolvedValueOnce(true);
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "conflicted", conflicts: ["a.ts"] });
    if (command === "git_merge_context")
      return mergeContext({ merging: false, op: "", conflicts: [] });
    return null;
  });
  const pending = syncWithDefaultBranch({ cwd: "/repo" });
  await vi.waitFor(() => expect(mergeResolutionSnapshot().length).toBe(1));
  mergeResolutionSnapshot()[0]!.choose("abort");
  await pending;
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
    "nothing to abort",
  );
  expect(invokedCommands()).not.toContain("git_merge_abort");
});

it("labels a capped conflict list instead of implying completeness", async () => {
  const many = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
  vi.mocked(ask).mockResolvedValueOnce(true);
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "conflicted", conflicts: many });
    if (command === "git_merge_context")
      return mergeContext({ conflicts: many });
    return null;
  });
  const pending = syncWithDefaultBranch({ cwd: "/repo" });
  await vi.waitFor(() => expect(mergeResolutionSnapshot().length).toBe(1));
  mergeResolutionSnapshot()[0]!.choose("agent");
  await pending;
  const text = String(
    vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0].context.entries[0]
      .text ?? "",
  );
  expect(text).toContain("Conflicted paths (first 100");
});

it("tells the user when the operation ended before the context was sent", async () => {
  // ask#1 confirm sync → true; sheet → "agent"; but the merge resolved
  // meanwhile — git_merge_context reports nothing in progress.
  vi.mocked(ask).mockResolvedValueOnce(true);
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "conflicted", conflicts: ["a.ts"] });
    if (command === "git_merge_context")
      return mergeContext({ merging: false, op: "", conflicts: [] });
    return null;
  });
  const pending = syncWithDefaultBranch({ cwd: "/repo" });
  await vi.waitFor(() => expect(mergeResolutionSnapshot().length).toBe(1));
  mergeResolutionSnapshot()[0]!.choose("agent");
  const result = await pending;
  expect(result?.outcome).toBe("conflicted");
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
    "no longer in progress",
  );
  expect(requestAgentContext).not.toHaveBeenCalled();
});

it("syncs every linked working copy and routes conflicts to their agents", async () => {
  const outcomes: Record<string, Record<string, unknown>> = {
    "/repo/a": { outcome: "merged", commits: ["one"], commitCount: 1 },
    "/repo/b": { outcome: "up-to-date" },
    "/repo/c": { outcome: "conflicted", conflicts: ["src/app.ts"] },
  };
  mockInvoke((command, raw) => {
    const cwd = String((raw as Record<string, unknown>)?.cwd ?? "");
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch") return syncResult(outcomes[cwd] ?? {});
    if (command === "git_merge_context") return mergeContext({});
    return null;
  });
  const snapshots: string[] = [];
  const rows = await syncTaskBranches(
    {
      sessionIds: ["task-session"],
      children: [
        { workingCopy: "/repo/a", sessionIds: ["session-a"] },
        { workingCopy: "/repo/b", sessionIds: ["session-b"] },
        { workingCopy: "/repo/c", sessionIds: ["session-c"] },
      ],
    },
    (next) => snapshots.push(next.map((row) => row.state).join(",")),
  );
  expect(rows.map((row) => row.state)).toEqual([
    "merged",
    "up-to-date",
    "conflicts-sent",
  ]);
  expect(snapshots[0]).toBe("running,running,running");
  // No per-copy confirmations — the bulk action states its scope up front.
  expect(ask).not.toHaveBeenCalled();
  const request = vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0];
  expect(request?.sourceSessionId).toBe("session-c");
  expect(request?.destination).toEqual({ kind: "source" });
  const text = request?.context.entries[0].text ?? "";
  expect(text).toContain("incoming and the current changes");
  expect(text).toContain("ask me questions");
});

it("reports sessionless conflicts without sending or opening the picker", async () => {
  mockInvoke((command, raw) => {
    const cwd = String((raw as Record<string, unknown>)?.cwd ?? "");
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({
        outcome: "conflicted",
        conflicts: ["a.ts", "b.ts"],
      });
    if (command === "git_merge_context") return mergeContext({});
    return cwd;
  });
  const rows = await syncTaskBranches({
    children: [{ workingCopy: "/repo/a", sessionIds: [] }],
  });
  expect(rows[0]?.state).toBe("conflicts");
  expect(rows[0]?.detail).toContain("2 conflicts");
  expect(requestAgentContext).not.toHaveBeenCalled();
});

it("skips dirty, in-progress and slot-held copies while the rest sync", async () => {
  const release = acquireSyncSlot("/repo/held")!;
  mockInvoke((command, raw) => {
    const cwd = String((raw as Record<string, unknown>)?.cwd ?? "");
    if (command === "git_diff_index")
      return cwd === "/repo/dirty"
        ? {
            ...cleanIndex,
            files: [{ path: "a.ts", status: "M", kind: "unstaged" }],
          }
        : cwd === "/repo/merging"
          ? { ...cleanIndex, opInProgress: true, op: "merge" }
          : cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "up-to-date" });
    return null;
  });
  try {
    const rows = await syncTaskBranches({
      children: [
        { workingCopy: "/repo/dirty", sessionIds: [] },
        { workingCopy: "/repo/merging", sessionIds: [] },
        { workingCopy: "/repo/held", sessionIds: [] },
        { workingCopy: "/repo/clean", sessionIds: [] },
      ],
    });
    expect(rows.map((row) => row.state)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "up-to-date",
    ]);
    expect(rows[0]?.detail).toContain("uncommitted");
    expect(rows[1]?.detail).toContain("merge");
    expect(rows[2]?.detail).toContain("already running");
    // The held copy never reached the backend.
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command, raw]) =>
            command === "git_sync_branch" &&
            (raw as Record<string, unknown>).cwd === "/repo/held",
        ).length,
    ).toBe(0);
  } finally {
    release();
  }
});

it("surfaces a backend refusal as a skipped row, not a thrown error", async () => {
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return syncResult({ outcome: "refused", reason: "branch moved" });
    return null;
  });
  const rows = await syncTaskBranches({
    children: [{ workingCopy: "/repo/a", sessionIds: [] }],
  });
  expect(rows[0]?.state).toBe("skipped");
  expect(rows[0]?.detail).toBe("branch moved");
});
