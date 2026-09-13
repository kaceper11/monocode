// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emittedAttention } from "./attention";
import { INTERRUPT_MESSAGE } from "./inFlight";
import {
  deleteProject,
  ensureProjectForPath,
  loadProjects,
  saveProjectCommand,
  setProjectVerify,
  type ProjectRecord,
} from "./projects";
import { publishRepositoryFamilies } from "./repositoryFamilies";
import { newSession, type Session } from "./session";
import {
  MAX_FIX_SENDS,
  sendCheckToAgent,
  setVerifyHooks,
  suppressVerifyTurn,
  verifyRunsFor,
  verifyTurnFinished,
} from "./verify";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const CWD = "/repo";

const family = {
  commonDir: `${CWD}/.git`,
  checkout: CWD,
  worktrees: [
    { path: CWD, head: "abc", branch: "main", main: true, missing: false },
  ],
};

const dirtyIndex = {
  branch: "main",
  files: [
    {
      path: `${CWD}/a.ts`,
      relative: "a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      staged: true,
      unstaged: false,
    },
  ],
  additions: 1,
  deletions: 0,
  remote: "origin",
  upstream: "origin/main",
  defaultBranch: "main",
  ahead: 1,
  behind: 0,
  aheadOfDefault: 1,
  opInProgress: false,
  op: "",
  conflicts: [],
  mergeHead: null,
  detached: false,
};

const cleanIndex = {
  ...dirtyIndex,
  files: [],
  additions: 0,
  deletions: 0,
  ahead: 0,
  aheadOfDefault: 0,
};

const checkResult = (code: number, output = "ok") => ({
  code,
  timedOut: false,
  output,
  truncated: false,
  durationMs: 12,
});

let session: Session;
let project: ProjectRecord;
let commandId: string;
const sendToSession = vi.fn().mockResolvedValue(true);

function makeProject(mode: "notify" | "fix" = "notify") {
  project = ensureProjectForPath(CWD, family);
  const saved = saveProjectCommand(project.id, {
    name: "Tests",
    command: "npm test",
  });
  if (saved.error) throw new Error(saved.error);
  commandId = loadProjects().find((p) => p.id === project.id)!.commands[0].id;
  const result = setProjectVerify(project.id, { commandId, mode });
  if (result.error) throw new Error(result.error);
}

function turnSession(blockId = crypto.randomUUID()): Session {
  return {
    ...session,
    blocks: [
      ...session.blocks,
      {
        id: blockId,
        role: "user",
        text: "do the thing",
        startedAt: Date.now(),
      },
    ],
  };
}

async function settle() {
  await vi.waitFor(() => {
    const runs = verifyRunsFor(project.id);
    expect(runs.length).toBeGreaterThan(0);
  });
  // The send is awaited after the record write — one extra microtask tick.
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(invoke).mockClear();
  publishRepositoryFamilies(new Map([[CWD, family]]));
  sendToSession.mockClear().mockResolvedValue(true);
  session = { ...newSession("claude", CWD), title: "claude · work" };
  setVerifyHooks({
    getSession: () => session,
    sendToSession,
  });
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check") return Promise.resolve(checkResult(0));
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
});

afterEach(() => {
  setVerifyHooks({});
  publishRepositoryFamilies(new Map());
});

it("runs the configured command when a turn finishes", async () => {
  makeProject();
  session = turnSession();
  verifyTurnFinished(session);
  await settle();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("run_check", {
    cwd: CWD,
    steps: [{ exec: "npm test" }],
  });
  const run = verifyRunsFor(project.id).at(-1)!;
  expect(run.status).toBe("passed");
  const row = emittedAttention().find((item) => item.kind === "check");
  expect(row?.title).toContain("Checks passed");
  expect(row?.action).toEqual({ kind: "open-changes", sessionId: session.id });
});

it("claims a turn once — re-fired edges never re-run", async () => {
  makeProject();
  session = turnSession();
  verifyTurnFinished(session);
  verifyTurnFinished(session);
  await settle();
  // A later edge for the same turn hits the persisted claim too.
  verifyTurnFinished(session);
  await Promise.resolve();
  expect(
    vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "run_check"),
  ).toHaveLength(1);
});

it("does nothing without a user turn or outside a stored project", async () => {
  makeProject();
  verifyTurnFinished(session); // no user blocks
  session = {
    ...session,
    cwd: "/nowhere",
    blocks: [
      { id: "t1", role: "user", text: "x", startedAt: Date.now() },
    ],
  };
  verifyTurnFinished(session);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(invoke).not.toHaveBeenCalled();
});

it("skips when the working copy is unchanged", async () => {
  makeProject();
  vi.mocked(invoke).mockImplementation((command) =>
    command === "git_diff_index"
      ? Promise.resolve(cleanIndex)
      : Promise.reject(new Error(`unexpected invoke: ${command}`)),
  );
  session = turnSession();
  verifyTurnFinished(session);
  await vi.waitFor(() =>
    expect(verifyRunsFor(project.id).at(-1)?.status).toBe("skipped"),
  );
  expect(
    vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "run_check"),
  ).toHaveLength(0);
});

it("skips a turn that is stopped, awaiting input, or has queued follow-ups", async () => {
  makeProject();
  const suppressed = turnSession("turn-suppressed");
  suppressVerifyTurn(suppressed);
  const sessions: Session[] = [
    suppressed,
    {
      ...turnSession("turn-interrupted"),
      blocks: [
        ...turnSession("turn-interrupted").blocks,
        { id: "interrupt-note", role: "system", text: INTERRUPT_MESSAGE },
      ],
    },
    { ...turnSession("turn-paused"), queueStatus: "paused" },
    {
      ...turnSession("turn-queued"),
      queuedMessages: [{ id: "q1", text: "next", attachments: [] }],
    },
  ];
  for (const [index, next] of sessions.entries()) {
    session = next;
    verifyTurnFinished(session);
    // eslint-disable-next-line no-await-in-loop
    await vi.waitFor(() =>
      expect(
        verifyRunsFor(project.id).filter((run) => run.status === "skipped"),
      ).toHaveLength(index + 1),
    );
  }
  // An approval-pending turn is not claimed at all: answering it resumes the
  // same turn, and the edge after that must still verify.
  session = { ...newSession("claude", CWD), title: "claude · work" };
  session = {
    ...turnSession("turn-approval"),
    blocks: [
      ...turnSession("turn-approval").blocks,
      {
        id: "approval-block",
        role: "approval",
        text: "",
        approval: { requestId: 1 },
      },
    ],
  };
  verifyTurnFinished(session);
  await Promise.resolve();
  expect(verifyRunsFor(project.id)).toHaveLength(sessions.length);
  // The approval resolves — same user block, same turn, now verifiable.
  session = {
    ...session,
    blocks: session.blocks.filter((block) => block.id !== "approval-block"),
  };
  verifyTurnFinished(session);
  await vi.waitFor(() =>
    expect(verifyRunsFor(project.id)).toHaveLength(sessions.length + 1),
  );
  expect(verifyRunsFor(project.id).at(-1)!.status).toBe("passed");
  expect(
    vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "run_check"),
  ).toHaveLength(1);
});

it("a failed run records the tail and offers send-to-agent", async () => {
  makeProject();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check")
      return Promise.resolve(checkResult(1, "boom: 2 failing tests"));
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
  session = turnSession();
  verifyTurnFinished(session);
  await settle();
  const run = verifyRunsFor(project.id).at(-1)!;
  expect(run.status).toBe("failed");
  expect(run.outputTail).toContain("2 failing tests");
  const row = emittedAttention().find((item) => item.kind === "check")!;
  expect(row.title).toContain("Checks failed");
  expect(row.action).toEqual({ kind: "check-fix", runId: run.id });
  expect(sendToSession).not.toHaveBeenCalled(); // notify mode stays manual
});

it("a signal-killed run reports Killed, not an exit code", async () => {
  makeProject();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check")
      return Promise.resolve({ ...checkResult(0, ""), code: null });
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
  session = turnSession();
  verifyTurnFinished(session);
  await settle();
  const run = verifyRunsFor(project.id).at(-1)!;
  expect(run.status).toBe("failed");
  expect(run.detail).toBe("Killed.");
});

it("auto-fix sends the tail to the owning session, capped per chain", async () => {
  makeProject("fix");
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check")
      return Promise.resolve(checkResult(1, "still broken"));
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
  for (let turn = 1; turn <= MAX_FIX_SENDS + 1; turn += 1) {
    session = turnSession(`turn-${turn}`);
    verifyTurnFinished(session);
    // eslint-disable-next-line no-await-in-loop
    await vi.waitFor(() =>
      expect(verifyRunsFor(project.id)).toHaveLength(turn),
    );
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  expect(sendToSession).toHaveBeenCalledTimes(MAX_FIX_SENDS);
  const [sentSession, text] = sendToSession.mock.calls[0];
  expect(sentSession).toBe(session.id);
  expect(text).toContain("still broken");
});

it("a pass resets the failure chain", async () => {
  makeProject("fix");
  let code = 1;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check")
      return Promise.resolve(checkResult(code, "output"));
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
  session = turnSession("t1");
  verifyTurnFinished(session);
  await vi.waitFor(() =>
    expect(verifyRunsFor(project.id).at(-1)?.status).toBe("failed"),
  );
  code = 0;
  session = turnSession("t2");
  verifyTurnFinished(session);
  await vi.waitFor(() =>
    expect(verifyRunsFor(project.id).at(-1)?.status).toBe("passed"),
  );
  code = 1;
  session = turnSession("t3");
  verifyTurnFinished(session);
  await vi.waitFor(() =>
    expect(verifyRunsFor(project.id).at(-1)?.status).toBe("failed"),
  );
  await vi.waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(2));
});

it("a deleted check command records an error instead of running", async () => {
  makeProject();
  const { deleteProjectCommand } = await import("./projects");
  deleteProjectCommand(project.id, commandId);
  session = turnSession();
  verifyTurnFinished(session);
  await settle();
  const run = verifyRunsFor(project.id).at(-1)!;
  expect(run.status).toBe("error");
  expect(run.detail).toContain("deleted");
  expect(
    vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "run_check"),
  ).toHaveLength(0);
});

it("auto-fix never dispatches into a busy session", async () => {
  makeProject("fix");
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check")
      return Promise.resolve(checkResult(1, "broken"));
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
  session = turnSession("t1");
  verifyTurnFinished(session);
  await vi.waitFor(() =>
    expect(verifyRunsFor(project.id).at(-1)?.status).toBe("failed"),
  );
  session = { ...session, busy: true };
  session = turnSession("t2");
  verifyTurnFinished(session);
  await vi.waitFor(() => expect(verifyRunsFor(project.id)).toHaveLength(2));
  await Promise.resolve();
  expect(sendToSession).toHaveBeenCalledTimes(1);
});

it("a paused config never runs — and records nothing", async () => {
  makeProject();
  const result = setProjectVerify(project.id, {
    commandId,
    mode: "notify",
    enabled: false,
  });
  expect(result.error).toBeUndefined();
  session = turnSession();
  verifyTurnFinished(session);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(invoke).not.toHaveBeenCalled();
  expect(verifyRunsFor(project.id)).toHaveLength(0);
});

it("stepped commands run as steps and preserve native-host steps", async () => {
  makeProject();
  const saved = saveProjectCommand(project.id, {
    name: "CI",
    command: "ci",
    steps: [
      { command: "npm run lint" },
      { command: "npm run build", host: "native" },
    ],
  });
  if (saved.error) throw new Error(saved.error);
  const stepped = loadProjects()
    .find((p) => p.id === project.id)!
    .commands.find((command) => command.name === "CI")!;
  const result = setProjectVerify(project.id, {
    commandId: stepped.id,
    mode: "notify",
  });
  expect(result.error).toBeUndefined();
  session = turnSession();
  verifyTurnFinished(session);
  await settle();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("run_check", {
    cwd: CWD,
    steps: [
      { exec: "npm run lint" },
      { exec: "npm run build", native: true },
    ],
  });
});

it("manual send dispatches the tail with action provenance, and marks it", async () => {
  makeProject();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check")
      return Promise.resolve(checkResult(1, "boom: 2 failing tests"));
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
  session = turnSession();
  verifyTurnFinished(session);
  await settle();
  const run = verifyRunsFor(project.id).at(-1)!;
  expect(await sendCheckToAgent(run.id)).toBeUndefined();
  expect(sendToSession).toHaveBeenCalledWith(
    session.id,
    expect.stringContaining("2 failing tests"),
    expect.objectContaining({ actionId: `verify:${run.id}` }),
  );
  expect(verifyRunsFor(project.id).at(-1)!.sentToAgent).toBe(true);
  // A passing run refuses — nothing to fix.
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check") return Promise.resolve(checkResult(0));
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
  session = turnSession("turn-green");
  verifyTurnFinished(session);
  await vi.waitFor(() =>
    expect(verifyRunsFor(project.id).at(-1)?.status).toBe("passed"),
  );
  const green = verifyRunsFor(project.id).at(-1)!;
  expect(await sendCheckToAgent(green.id)).toContain("no failure output");
  expect(sendToSession).toHaveBeenCalledTimes(1);
});

it("a turn finishing behind a same-copy check retries after it", async () => {
  makeProject();
  const sessions = new Map<string, Session>();
  setVerifyHooks({
    getSession: (id: string) => sessions.get(id),
    sendToSession,
  });
  let checks = 0;
  let resolveCheck!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check") {
      checks += 1;
      return checks === 1
        ? new Promise((resolve) => {
            resolveCheck = resolve;
          })
        : Promise.resolve(checkResult(0));
    }
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
  session = { ...newSession("claude", CWD), title: "first" };
  const first = turnSession("turn-a");
  session = { ...newSession("claude", CWD), title: "second" };
  const second = turnSession("turn-b");
  sessions.set(first.id, first);
  sessions.set(second.id, second);
  verifyTurnFinished(first);
  await vi.waitFor(() => expect(checks).toBe(1));
  // Same copy — pends behind the running check instead of racing it.
  verifyTurnFinished(second);
  await Promise.resolve();
  expect(checks).toBe(1);
  resolveCheck(checkResult(0));
  await vi.waitFor(() =>
    expect(verifyRunsFor(project.id)).toHaveLength(2),
  );
  expect(checks).toBe(2);
  expect(verifyRunsFor(project.id).at(-1)!.status).toBe("passed");
});

it("a project deleted mid-run records nothing and emits no row", async () => {
  makeProject();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check") {
      deleteProject(project.id);
      return Promise.resolve(checkResult(0));
    }
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
  session = turnSession();
  verifyTurnFinished(session);
  await vi.waitFor(() =>
    expect(
      vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "run_check"),
    ).toBe(true),
  );
  for (let tick = 0; tick < 5; tick += 1)
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  // The run is dropped rather than resurrecting state for a dead project.
  expect(verifyRunsFor(project.id)).toHaveLength(0);
  expect(emittedAttention().some((item) => item.kind === "check")).toBe(false);
});

it("a session deleted mid-run records history but emits no row", async () => {
  makeProject();
  let alive = true;
  setVerifyHooks({
    getSession: () => (alive ? session : undefined),
    sendToSession,
  });
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "git_diff_index") return Promise.resolve(dirtyIndex);
    if (command === "run_check") {
      alive = false;
      return Promise.resolve(checkResult(0));
    }
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
  session = turnSession();
  verifyTurnFinished(session);
  await settle();
  expect(verifyRunsFor(project.id).at(-1)?.status).toBe("passed");
  expect(emittedAttention().some((item) => item.kind === "check")).toBe(false);
});

it("setProjectVerify rejects unknown commands but updates a stale binding", async () => {
  makeProject();
  expect(
    setProjectVerify(project.id, { commandId: "gone", mode: "notify" }).error,
  ).toBeTruthy();
  const { deleteProjectCommand } = await import("./projects");
  deleteProjectCommand(project.id, commandId);
  expect(
    setProjectVerify(project.id, {
      commandId,
      mode: "notify",
      enabled: false,
    }).error,
  ).toBeUndefined();
  const saved = loadProjects().find((p) => p.id === project.id)!;
  expect(saved.verify?.enabled).toBe(false);
});
