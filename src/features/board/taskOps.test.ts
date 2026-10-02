// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { addTask, loadBoard, updateTask } from "./boardStore";
import { createTaskPrs, updateWorkstreamFromBase } from "./taskOps";
import { probeDelivery, type DeliverySnapshot } from "./delivery";
import {
  gitBranches,
  gitPush,
  gitPrCreate,
  gitMergeFrom,
  gitMergeInProgress,
} from "../../platform/tauri/fs";
import { azureDevOpsPrCreate } from "../inbox/model/azureDevOps";
import type { BoardTask } from "./boardStore";

vi.mock("./delivery", async (original) => ({
  ...(await original<typeof import("./delivery")>()),
  probeDelivery: vi.fn(),
}));
vi.mock("../../platform/tauri/fs", () => ({
  gitBranches: vi.fn(),
  gitRemotes: vi.fn(async () => ["origin", "upstream"]),
  gitPush: vi.fn(async () => {}),
  gitPrCreate: vi.fn(async () => "https://github.com/team/app/pull/1"),
  gitPrStatus: vi.fn(),
  gitPrUpdate: vi.fn(),
  gitBehindBase: vi.fn(),
  gitCurrentBranch: vi.fn(),
  gitMergeFrom: vi.fn(),
  gitMergeInProgress: vi.fn(),
}));
vi.mock("../inbox/model/azureDevOps", () => ({
  azureDevOpsPrCreate: vi.fn(
    async () => "https://dev.azure.com/org/project/_git/app/pullrequest/1",
  ),
  azureDevOpsPrProbe: vi.fn(),
  azureDevOpsPrUpdateBody: vi.fn(),
  azureDevOpsRepoMatch: vi.fn(),
}));
const task = {
  id: "task",
  title: "Improve Board",
  links: [],
  workstreams: [
    {
      id: "lane",
      projectPath: "/repo",
      worktreePath: "/copy",
      branch: "feature",
      base: "upstream/main",
    },
  ],
} as BoardTask;
const snapshot: DeliverySnapshot = {
  remoteName: "upstream",
  pr: null,
  source: {
    provider: "github",
    repo: "team/app",
    host: "github.com",
    account: "1",
  },
  checks: [],
  headSha: "head",
  localHead: "head",
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  addTask(task);
  vi.mocked(gitBranches).mockResolvedValue({
    current: "feature",
    branches: [],
  });
  vi.mocked(probeDelivery).mockResolvedValue(snapshot);
});

it("publishes to the resolved default remote and exact GitHub repository", async () => {
  expect(await createTaskPrs(task, new Map())).toMatchObject([{ ok: true }]);
  expect(gitPush).toHaveBeenCalledExactlyOnceWith(
    "/copy",
    "upstream",
    "feature",
  );
  expect(gitPrCreate).toHaveBeenCalledWith(
    "/copy",
    "Improve Board",
    expect.any(String),
    "main",
    "feature",
    false,
    "https://github.com/team/app",
  );
  expect(probeDelivery).toHaveBeenCalledTimes(2);
});

it("uses the exact Azure repository and refuses branch drift before publishing", async () => {
  vi.mocked(probeDelivery).mockResolvedValue({
    ...snapshot,
    source: {
      provider: "azuredevops",
      repo: "project/app",
      host: "https://dev.azure.com/org",
      account: "azure",
    },
  });
  expect(await createTaskPrs(task, new Map())).toMatchObject([{ ok: true }]);
  expect(azureDevOpsPrCreate).toHaveBeenCalledWith(
    "/copy",
    "Improve Board",
    expect.any(String),
    "main",
    "feature",
    false,
    "project/app",
  );
  vi.clearAllMocks();
  vi.mocked(gitBranches).mockResolvedValue({
    current: "switched",
    branches: [],
  });
  expect(await createTaskPrs(task, new Map())).toMatchObject([
    { ok: false, message: expect.stringContaining("expected feature") },
  ]);
  expect(gitPush).not.toHaveBeenCalled();
});

it("strips a stored refs/remotes/ base before the provider call", async () => {
  const legacy = {
    ...task,
    workstreams: [{ ...task.workstreams[0], base: "refs/remotes/upstream/main" }],
  } as BoardTask;
  updateTask(loadBoard().tasks[0].id, { workstreams: legacy.workstreams });
  expect(await createTaskPrs(legacy, new Map())).toMatchObject([{ ok: true }]);
  expect(gitPrCreate).toHaveBeenCalledWith(
    "/copy",
    "Improve Board",
    expect.any(String),
    "main",
    "feature",
    false,
    "https://github.com/team/app",
  );
});

it("accepts bases persisted before submit and still rejects a stale snapshot", async () => {
  // onSubmitPrs writes the dialog's base picks into the store, then hands
  // createTaskPrs a task carrying the same values — the live-binding check
  // compares against the store, so they must agree.
  const picked = {
    ...task,
    workstreams: [{ ...task.workstreams[0], base: "upstream/release" }],
  } as BoardTask;
  updateTask(loadBoard().tasks[0].id, { workstreams: picked.workstreams });
  expect(
    await createTaskPrs(picked, new Map(), undefined, {
      bases: new Map([["lane", "upstream/release"]]),
    }),
  ).toMatchObject([{ ok: true }]);
  expect(gitPrCreate).toHaveBeenCalledWith(
    "/copy",
    "Improve Board",
    expect.any(String),
    "release",
    "feature",
    false,
    "https://github.com/team/app",
  );
  // The stale pre-submit snapshot still fails the binding check.
  expect(await createTaskPrs(task, new Map())).toMatchObject([
    { ok: false, message: expect.stringContaining("binding changed") },
  ]);
});

it("rejects a concurrent submit instead of pushing twice", async () => {
  // The first call holds the repository lock through the whole publish; a
  // second submit must fail the lane cleanly rather than double-push.
  const first = createTaskPrs(task, new Map());
  expect(await createTaskPrs(task, new Map())).toMatchObject([
    { ok: false, message: expect.stringContaining("already running") },
  ]);
  expect(await first).toMatchObject([{ ok: true }]);
  expect(gitPush).toHaveBeenCalledTimes(1);
  expect(gitPrCreate).toHaveBeenCalledTimes(1);
});

it("stops publishing when the lane is rebound or archived mid-submit", async () => {
  // The live-binding check between probe and push catches a workstream that
  // was removed while the (awaited) delivery probe was in flight.
  vi.mocked(probeDelivery).mockImplementationOnce(async () => {
    updateTask(loadBoard().tasks[0].id, { workstreams: [] });
    return snapshot;
  });
  expect(await createTaskPrs(task, new Map())).toMatchObject([
    { ok: false, message: expect.stringContaining("binding changed") },
  ]);
  expect(gitPush).not.toHaveBeenCalled();

  // Restore the lane, then the same mid-flight check catches archiving.
  updateTask(loadBoard().tasks[0].id, { workstreams: task.workstreams });
  vi.mocked(probeDelivery).mockResolvedValue(snapshot);
  expect(await createTaskPrs(task, new Map())).toMatchObject([
    { ok: true },
  ]);
  vi.mocked(probeDelivery).mockImplementationOnce(async () => {
    updateTask(loadBoard().tasks[0].id, { archived: true });
    return snapshot;
  });
  expect(await createTaskPrs(task, new Map())).toMatchObject([
    { ok: false, message: expect.stringContaining("binding changed") },
  ]);
  expect(gitPrCreate).toHaveBeenCalledTimes(1);
});

it("updates from the default branch or an explicit ref and rejects checkout drift", async () => {
  const lane = task.workstreams[0];
  vi.mocked(gitMergeFrom).mockResolvedValue();
  expect(await updateWorkstreamFromBase(lane)).toMatchObject({ ok: true });
  expect(gitMergeFrom).toHaveBeenLastCalledWith("/copy", "HEAD");
  expect(
    await updateWorkstreamFromBase(lane, "refs/remotes/upstream/release"),
  ).toMatchObject({ ok: true });
  expect(gitMergeFrom).toHaveBeenLastCalledWith(
    "/copy",
    "refs/remotes/upstream/release",
  );
  vi.mocked(gitBranches).mockResolvedValue({
    current: "switched",
    branches: [],
  });
  expect(await updateWorkstreamFromBase(lane)).toMatchObject({
    ok: false,
    message: expect.stringContaining("expected feature"),
  });
  expect(gitMergeFrom).toHaveBeenCalledTimes(2);
});
it("keeps merge conflicts and rejects changed or removed task bindings", async () => {
  const lane = task.workstreams[0];
  vi.mocked(gitMergeFrom).mockRejectedValue(new Error("Conflict"));
  vi.mocked(gitMergeInProgress).mockResolvedValue(true);
  expect(
    await updateWorkstreamFromBase(lane, "refs/remotes/origin/release"),
  ).toMatchObject({
    ok: false,
    conflict: true,
    message: expect.stringContaining("release"),
  });
  updateTask(loadBoard().tasks[0].id, { workstreams: [] });
  vi.mocked(gitMergeFrom).mockClear();
  expect(await updateWorkstreamFromBase(lane)).toMatchObject({
    ok: false,
    message: expect.stringContaining("binding changed"),
  });
  expect(gitMergeFrom).not.toHaveBeenCalled();
});
