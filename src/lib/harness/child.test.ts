import { afterEach, describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@tauri-apps/api/event";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: never }) => void>(),
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installResolvedListeners() {
  mocks.listen.mockImplementation(
    async (name: string, handler: (event: { payload: never }) => void) => {
      mocks.handlers.set(name, handler);
      return vi.fn();
    },
  );
}

async function loadChild() {
  vi.resetModules();
  return import("./child");
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  mocks.handlers.clear();
  mocks.invoke.mockReset();
  mocks.listen.mockReset();
  vi.useRealTimers();
});

describe("isCurrentChildExit", () => {
  it("matches only the live child's pid", async () => {
    installResolvedListeners();
    const { isCurrentChildExit } = await loadChild();
    expect(isCurrentChildExit(undefined, 41)).toBe(false);
    expect(isCurrentChildExit(42, 41)).toBe(false);
    expect(isCurrentChildExit(42, 42)).toBe(true);
  });
});

describe("child bridge", () => {
  it("waits until every listener is installed", async () => {
    const pending = deferred<UnlistenFn>();
    mocks.listen.mockImplementation(
      (name: string, handler: (event: { payload: never }) => void) => {
        mocks.handlers.set(name, handler);
        return name === "harness-stdout"
          ? pending.promise
          : Promise.resolve(vi.fn());
      },
    );
    const child = await loadChild();
    let acquired = false;
    const lease = child.acquireHarnessBridge().then((release) => {
      acquired = true;
      return release;
    });

    await flush();
    expect(acquired).toBe(false);

    pending.resolve(vi.fn());
    const release = await lease;
    expect(acquired).toBe(true);
    release();
  });

  it("cleans a failed installation and allows retry", async () => {
    vi.useFakeTimers();
    const late = deferred<UnlistenFn>();
    const firstUnlisten = vi.fn();
    const lateUnlisten = vi.fn();
    mocks.listen
      .mockResolvedValueOnce(firstUnlisten)
      .mockRejectedValueOnce(new Error("listen failed"))
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(vi.fn())
      .mockResolvedValueOnce(vi.fn());
    const child = await loadChild();
    const releaseApp = child.startHarnessBridge();

    await expect(child.acquireHarnessBridge()).rejects.toThrow("listen failed");
    expect(firstUnlisten).toHaveBeenCalledOnce();

    late.resolve(lateUnlisten);
    await flush();
    expect(lateUnlisten).toHaveBeenCalledOnce();

    installResolvedListeners();
    const releaseProbe = await child.acquireHarnessBridge();
    releaseProbe();
    releaseApp();
    await vi.runAllTimersAsync();
  });

  it("reconciles an exit that arrives before spawn returns its pid", async () => {
    installResolvedListeners();
    const spawned = deferred<number>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "harness_spawn") return spawned.promise;
      return Promise.resolve();
    });
    const child = await loadChild();
    const release = await child.acquireHarnessBridge();
    const onExit = vi.fn();
    child.watchChild("probe", vi.fn(), onExit);

    const spawning = child.spawnChild(
      "probe",
      "pi",
      ["--mode", "rpc"],
      "/repo",
    );
    await flush();
    const generation = mocks.invoke.mock.calls.find(
      ([name]) => name === "harness_spawn",
    )![1].generation;
    mocks.handlers.get("harness-exit")?.({
      payload: { sessionId: "probe", generation, code: 1, pid: 42 } as never,
    });
    expect(onExit).not.toHaveBeenCalled();

    spawned.resolve(42);
    await spawning;
    expect(onExit).toHaveBeenCalledWith(1);
    release();
  });
  it("rejects stale stdout, stderr and exits while preserving early output for its own spawn", async () => {
    installResolvedListeners();
    mocks.invoke.mockResolvedValue(41);
    const child = await loadChild();
    const release = await child.acquireHarnessBridge();
    child.watchChild("same", vi.fn(), vi.fn());
    await child.spawnChild("same", "agent", [], "/repo");
    const old = mocks.invoke.mock.calls.find(
      ([name]) => name === "harness_spawn",
    )![1].generation;
    await child.killChild("same");
    const stdout = vi.fn(),
      stderr = vi.fn(),
      exit = vi.fn();
    child.watchChild("same", stdout, exit, stderr);
    const pending = deferred<number>();
    mocks.invoke.mockImplementation((name: string) =>
      name === "harness_spawn" ? pending.promise : Promise.resolve(),
    );
    const spawn = child.spawnChild("same", "agent", [], "/repo");
    await flush();
    const current = mocks.invoke.mock.calls
      .filter(([name]) => name === "harness_spawn")
      .at(-1)![1].generation;
    for (const name of ["harness-stdout", "harness-stderr", "harness-exit"]) {
      mocks.handlers.get(name)?.({
        payload: {
          sessionId: "same",
          generation: old,
          line: "stale",
          pid: 41,
          code: 0,
        } as never,
      });
    }
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    mocks.handlers.get("harness-stdout")?.({
      payload: {
        sessionId: "same",
        generation: current,
        line: "early",
      } as never,
    });
    expect(stdout).toHaveBeenCalledWith("early");
    pending.resolve(42);
    await spawn;
    release();
  });

  it("invalidates a cancelled spawn and waits for kill before installing a replacement", async () => {
    installResolvedListeners();
    const first = deferred<number>(),
      killed = deferred<void>();
    mocks.invoke.mockImplementation((name: string) =>
      name === "harness_spawn" ? first.promise : killed.promise,
    );
    const child = await loadChild();
    const pending = child.spawnChild("same", "agent", [], "/repo");
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await flush();
    const kill = child.killChild("same");
    const next = child.spawnChild("same", "agent", [], "/repo");
    first.resolve(41);
    await rejected;
    expect(
      mocks.invoke.mock.calls.filter(([n]) => n === "harness_spawn"),
    ).toHaveLength(1);
    mocks.invoke.mockResolvedValue(42);
    killed.resolve();
    await kill;
    await next;
    expect(
      mocks.invoke.mock.calls.filter(([n]) => n === "harness_spawn"),
    ).toHaveLength(2);
  });

  it("orders writes and stops a blocked pipe without replaying queued input", async () => {
    vi.useFakeTimers();
    installResolvedListeners();
    const blocked = deferred<void>();
    mocks.invoke.mockImplementation((name: string) =>
      name === "harness_spawn"
        ? Promise.resolve(42)
        : name === "harness_write"
          ? blocked.promise
          : Promise.resolve(),
    );
    const child = await loadChild();
    await child.spawnChild("same", "agent", [], "/repo");
    const a = expect(child.writeChild("same", "first")).rejects.toThrow(
      "timed out",
    );
    const b = expect(child.writeChild("same", "second")).rejects.toThrow(
      "cancelled",
    );
    await flush();
    expect(
      mocks.invoke.mock.calls.filter(([n]) => n === "harness_write"),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_001);
    await a;
    await b;
    expect(
      mocks.invoke.mock.calls.filter(([n]) => n === "harness_write"),
    ).toHaveLength(1);
    expect(mocks.invoke.mock.calls.some(([n]) => n === "harness_kill")).toBe(
      true,
    );
    blocked.resolve();
  });

  it("bounds pending input and rejects late SSE events from a replaced stream", async () => {
    installResolvedListeners();
    mocks.invoke.mockImplementation((name: string) =>
      name === "harness_write" ? new Promise(() => {}) : Promise.resolve(42),
    );
    const child = await loadChild();
    const release = await child.acquireHarnessBridge();
    await child.spawnChild("same", "agent", [], "/repo");
    await expect(
      child.writeChild("same", "x".repeat(33 * 1024 * 1024)),
    ).rejects.toThrow("queue");
    const data = vi.fn(),
      end = vi.fn();
    child.watchSse("same", data, end);
    await child.openHarnessSse("same", "http://127.0.0.1:1234/event");
    const old = mocks.invoke.mock.calls
      .filter(([n]) => n === "harness_sse_open")
      .at(-1)![1].generation;
    await child.openHarnessSse("same", "http://127.0.0.1:1234/event");
    const current = mocks.invoke.mock.calls
      .filter(([n]) => n === "harness_sse_open")
      .at(-1)![1].generation;
    mocks.handlers.get("harness-sse")?.({
      payload: { sessionId: "same", generation: old, data: "old" } as never,
    });
    mocks.handlers.get("harness-sse-end")?.({
      payload: { sessionId: "same", generation: old, error: "old" } as never,
    });
    expect(data).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    mocks.handlers.get("harness-sse")?.({
      payload: {
        sessionId: "same",
        generation: current,
        data: "current",
      } as never,
    });
    expect(data).toHaveBeenCalledWith("current");
    release();
  });
  it("never delivers a queued request cancelled before its write begins", async () => {
    installResolvedListeners();
    const blocked = deferred<void>();
    mocks.invoke.mockImplementation((name: string) =>
      name === "harness_spawn"
        ? Promise.resolve(42)
        : name === "harness_write"
          ? blocked.promise
          : Promise.resolve(),
    );
    const child = await loadChild();
    await child.spawnChild("same", "agent", [], "/repo");
    const first = child.writeChild("same", "first");
    const cancellation = new AbortController();
    const second = expect(
      child.writeChild("same", "cancelled", cancellation.signal),
    ).rejects.toThrow("cancelled");
    await flush();
    cancellation.abort();
    blocked.resolve();
    await first;
    await second;
    expect(
      mocks.invoke.mock.calls.filter(([name]) => name === "harness_write"),
    ).toHaveLength(1);
    expect(
      mocks.invoke.mock.calls.some(([name]) => name === "harness_kill"),
    ).toBe(false);
  });
  it.each([false, true])(
    "waits for pending stop before opening a new event stream (all=%s)",
    async (all) => {
      installResolvedListeners();
      const stopped = deferred<void>();
      mocks.invoke.mockImplementation((name: string) =>
        name.startsWith("harness_kill") ? stopped.promise : Promise.resolve(),
      );
      const child = await loadChild();
      const stop = all ? child.killAllChildren() : child.killChild("same");
      const open = child.openHarnessSse("same", "http://127.0.0.1:1234/event");
      await flush();
      expect(
        mocks.invoke.mock.calls.some(([name]) => name === "harness_sse_open"),
      ).toBe(false);
      stopped.resolve();
      await stop;
      await open;
      expect(
        mocks.invoke.mock.calls.some(([name]) => name === "harness_sse_open"),
      ).toBe(true);
    },
  );
});
