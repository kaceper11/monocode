import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  home: vi.fn(),
  spawn: vi.fn(),
  kill: vi.fn(),
  ready: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("./fs", () => ({ homeDir: api.home }));
vi.mock("./pty", () => ({
  spawnPty: api.spawn,
  killPty: api.kill,
  readyPtyEvents: api.ready,
}));
import {
  bindSavedCommandRun,
  queueSavedCommandRun,
  savedCommandRunsSnapshot,
  stopSavedCommandRun,
} from "./savedCommandRun";
const mounted: NonNullable<ReturnType<typeof bindSavedCommandRun>>[] = [];
let serial = 0;
beforeEach(() => {
  api.invoke.mockReset().mockResolvedValue(undefined);
  api.home.mockReset().mockResolvedValue("/native-home");
  api.spawn.mockReset().mockResolvedValue(undefined);
  api.kill.mockReset().mockResolvedValue(undefined);
  api.ready.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const run of mounted.splice(0)) await run.dispose();
});
function bind(id: string) {
  const run = bindSavedCommandRun(id, vi.fn(), () => ({ cols: 90, rows: 30 }))!;
  mounted.push(run);
  return run;
}
function queued(steps = [{ command: "first" }, { command: "second" }]) {
  const id = `command-test-${++serial}`;
  queueSavedCommandRun({
    terminalId: id,
    commandId: "command",
    projectCwd: "/repo",
    name: "Test",
    cwd: "/repo",
    steps,
  });
  return { id, run: bind(id) };
}
const state = (id: string) =>
  savedCommandRunsSnapshot().find((run) => run.terminalId === id);
it("runs steps in order, accepts an immediate exit, and returns the existing terminal to a shell", async () => {
  const { id, run } = queued();
  api.invoke.mockImplementation(async (_command, args) => {
    if (args.exec === "first") run.exited(0);
  });
  await run.start("/repo");
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2));
  expect(api.invoke.mock.calls.map((call) => call[1].exec)).toEqual([
    "first",
    "second",
  ]);
  expect(state(id)?.status).toBe("running");
  run.exited(0);
  await vi.waitFor(() => expect(state(id)?.status).toBe("completed"));
  expect(state(id)?.done).toBe(2);
  expect(api.spawn).toHaveBeenCalledWith(id, "/repo", 90, 30);
});
it("stops on failure without running a later step", async () => {
  const { id, run } = queued();
  await run.start("/repo");
  run.exited(7);
  await vi.waitFor(() => expect(state(id)?.status).toBe("failed"));
  expect(state(id)?.error).toContain("failed (7)");
  expect(api.invoke).toHaveBeenCalledOnce();
  expect(api.spawn).toHaveBeenCalledOnce();
});
it("never substitutes the WSL target when an OS-host directory lookup fails", async () => {
  const { id, run } = queued([
    { command: "native", host: "native" } as { command: string },
  ]);
  api.home.mockRejectedValue(new Error("Home unavailable"));
  await run.start("/repo");
  expect(state(id)?.status).toBe("failed");
  expect(api.invoke).not.toHaveBeenCalled();
  expect(api.spawn).toHaveBeenCalledWith(id, "/repo", 90, 30);
});
it("uses an explicit native directory for native steps", async () => {
  const { run } = queued([
    { command: "native", host: "native" } as { command: string },
  ]);
  await run.start("/repo");
  expect(api.invoke).toHaveBeenCalledWith(
    "pty_spawn",
    expect.objectContaining({ cwd: "/native-home", exec: "native" }),
  );
});
it("does not dispatch from StrictMode's disposed first mount", async () => {
  const { id, run: first } = queued();
  const starting = first.start("/repo");
  const closing = first.dispose();
  const second = bind(id);
  await second.start("/repo");
  await starting;
  await closing;
  expect(api.invoke).toHaveBeenCalledOnce();
  expect(api.kill).not.toHaveBeenCalled();
});
it("awaits an in-flight spawn before cleanup, without starting another step or shell", async () => {
  const { id, run } = queued();
  let resolve!: () => void;
  api.invoke.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const starting = run.start("/repo");
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledOnce());
  const closing = run.dispose();
  expect(api.kill).not.toHaveBeenCalled();
  resolve();
  await starting;
  await closing;
  expect(api.kill).toHaveBeenCalledWith(id);
  expect(api.spawn).not.toHaveBeenCalled();
  expect(state(id)).toBeUndefined();
});
it("does not replay an already dispatched command when the same terminal remounts", async () => {
  const { id, run: first } = queued();
  await first.start("/repo");
  const closing = first.dispose();
  const second = bind(id);
  await second.start("/repo");
  await closing;
  expect(api.invoke).toHaveBeenCalledOnce();
  expect(api.kill).not.toHaveBeenCalled();
  expect(api.spawn).toHaveBeenCalledWith(id, "/repo", 90, 30);
  expect(state(id)?.status).toBe("stopped");
});
it("explicit stop uses the current PTY and preserves its event subscription for the shell", async () => {
  const { id, run } = queued();
  await run.start("/repo");
  await stopSavedCommandRun(id);
  await vi.waitFor(() => expect(api.spawn).toHaveBeenCalledOnce());
  expect(api.invoke).toHaveBeenCalledWith("pty_kill", { id });
  expect(api.kill).not.toHaveBeenCalled();
  expect(state(id)?.status).toBe("stopped");
  expect(
    api.invoke.mock.calls.filter((call) => call[0] === "pty_spawn"),
  ).toHaveLength(1);
});
it("does not dispatch before exit listeners are ready and exposes bridge failure", async () => {
  const { id, run } = queued();
  api.ready.mockRejectedValue(new Error("Bridge unavailable"));
  await expect(run.start("/repo")).rejects.toThrow(/Bridge/);
  expect(state(id)?.status).toBe("failed");
  expect(api.invoke).not.toHaveBeenCalled();
});
