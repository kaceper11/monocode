// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const spawnPty = vi.fn();
  const writePty = vi.fn();
  const getPtyStatus = vi.fn();
  const killPty = vi.fn();
  const resizePty = vi.fn();
  const subscribePty = vi.fn(() => () => {});
  const homeDir = vi.fn(() => Promise.resolve("/home/native"));
  return {
    spawnPty,
    writePty,
    getPtyStatus,
    killPty,
    resizePty,
    subscribePty,
    homeDir,
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    buffer = {
      active: { type: "normal" },
      onBufferChange: () => ({ dispose() {} }),
    };
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    element = null;
    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
    open() {}
    dispose() {}
    write() {}
    writeln() {}
    onData() {
      return { dispose() {} };
    }
    onRender() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
    hasSelection() {
      return false;
    }
    getSelection() {
      return "";
    }
    paste() {}
    focus() {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../lib/pty", () => ({
  spawnPty: mocks.spawnPty,
  writePty: mocks.writePty,
  getPtyStatus: mocks.getPtyStatus,
  killPty: mocks.killPty,
  resizePty: mocks.resizePty,
  subscribePty: mocks.subscribePty,
}));
vi.mock("../lib/fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/fs")>()),
  homeDir: mocks.homeDir,
}));
vi.mock("../lib/terminalLayout", () => ({
  applyTerminalChrome: vi.fn(),
  fitTerminal: vi.fn(() => null),
  resetGridStretch: vi.fn(),
}));
vi.mock("../lib/appearance", () => ({
  isLightScheme: () => false,
  SCHEME_CHANGE_EVENT: "scheme",
}));

import { TerminalView } from "./TerminalView";
import type { TerminalCommand } from "../lib/layout";

const command = (overrides: Partial<TerminalCommand> = {}): TerminalCommand => ({
  presetId: "cmd1",
  name: "Dev",
  text: "npm run dev",
  runId: 1,
  ...overrides,
});

function render(commandProp?: TerminalCommand) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onMetaChange = vi.fn();
  const run = (cmd?: TerminalCommand) =>
    root.render(
      createElement(TerminalView, {
        id: "t1",
        cwd: "/repo",
        active: true,
        command: cmd ?? commandProp,
        onMetaChange,
      }),
    );
  return { host, root, onMetaChange, run };
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("TerminalView bound commands", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    mocks.spawnPty.mockResolvedValue(undefined);
    mocks.writePty.mockResolvedValue(undefined);
    mocks.getPtyStatus.mockResolvedValue({ foreground: null });
    mocks.killPty.mockResolvedValue(undefined);
    mocks.resizePty.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("writes the command once the PTY is spawned and marks it launched", async () => {
    const { host, root, onMetaChange, run } = render(command());
    await act(async () => run());
    await flush();
    expect(mocks.spawnPty).toHaveBeenCalledWith(
      "t1",
      "/repo",
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    expect(mocks.writePty).toHaveBeenCalledWith("t1", "npm run dev\r");
    expect(onMetaChange).toHaveBeenCalledWith({ command: { launched: 1 } });
    await act(async () => root.unmount());
    host.remove();
  });

  it("does not write a command that was already launched", async () => {
    const { host, root, run } = render(command({ runId: 1, launched: 1 }));
    await act(async () => run());
    await flush();
    expect(mocks.writePty).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    host.remove();
  });

  it("re-fires with fresh text when runId bumps on a live terminal", async () => {
    const { host, root, run } = render(command({ runId: 1, launched: 1 }));
    await act(async () => run());
    await flush();
    expect(mocks.writePty).not.toHaveBeenCalled();
    await act(async () =>
      run(command({ runId: 2, launched: 1, text: "npm run build" })),
    );
    await flush();
    expect(mocks.writePty).toHaveBeenCalledWith("t1", "npm run build\r");
    await act(async () => root.unmount());
    host.remove();
  });

  it("marks a command failed when the write cannot land", async () => {
    mocks.writePty.mockRejectedValue(new Error("Terminal is not running"));
    const { host, root, onMetaChange, run } = render(command());
    await act(async () => run());
    await flush();
    expect(mocks.writePty).toHaveBeenCalledWith("t1", "npm run dev\r");
    // The run is over — `launched` closes launchPending so the terminal is
    // never wedged, and `failed` keeps a remount from silently retrying.
    expect(onMetaChange).toHaveBeenCalledWith({
      command: { failed: 1, launched: 1 },
    });
    await act(async () => root.unmount());
    host.remove();
  });

  it("survives a StrictMode remount — the stale cleanup must not kill the new PTY", async () => {
    // First spawn resolves after the remount's spawn was issued, mirroring the
    // real invoke ordering: the ghost cleanup then fired killPty for the id,
    // terminating the live replacement and leaving a dead terminal.
    const resolvers: (() => void)[] = [];
    mocks.spawnPty.mockImplementation(
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onMetaChange = vi.fn();
    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(TerminalView, {
            id: "t1",
            cwd: "/repo",
            active: true,
            command: command(),
            onMetaChange,
          }),
        ),
      ),
    );
    expect(mocks.spawnPty).toHaveBeenCalledTimes(2);
    // Ghost spawn resolves late; the remount's spawn follows.
    await act(async () => {
      resolvers[0]?.();
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[1]?.();
      await Promise.resolve();
    });
    await flush();
    expect(mocks.killPty).not.toHaveBeenCalled();
    expect(mocks.writePty).toHaveBeenCalledWith("t1", "npm run dev\r");
    expect(onMetaChange).toHaveBeenCalledWith({ command: { launched: 1 } });
    await act(async () => root.unmount());
    await flush();
    expect(mocks.killPty).toHaveBeenCalledTimes(1);
    host.remove();
  });
});

describe("TerminalView step commands", () => {
  let exitHandler: ((code: number | null) => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    exitHandler = undefined;
    mocks.spawnPty.mockResolvedValue(undefined);
    mocks.writePty.mockResolvedValue(undefined);
    mocks.getPtyStatus.mockResolvedValue({ foreground: null });
    mocks.killPty.mockResolvedValue(undefined);
    mocks.resizePty.mockResolvedValue(undefined);
    mocks.homeDir.mockResolvedValue("/home/native");
    mocks.subscribePty.mockImplementation((id, _onData, onExit) => {
      exitHandler = onExit;
      return () => {};
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const stepsCommand = (
    steps: { command: string; host?: "native" }[],
    overrides: Partial<TerminalCommand> = {},
  ): TerminalCommand => ({
    presetId: "cmd1",
    name: "Maintenance",
    text: steps.map((step) => step.command).join("\n"),
    steps,
    runId: 1,
    ...overrides,
  });

  it("runs steps as sequential one-shot processes", async () => {
    const { host, root, onMetaChange, run } = render(
      stepsCommand([
        { command: "docker system prune -f" },
        { command: "wsl --shutdown", host: "native" },
      ]),
    );
    await act(async () => run());
    await flush();
    // Step one replaces the interactive shell spawn entirely.
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);
    expect(mocks.spawnPty).toHaveBeenNthCalledWith(
      1,
      "t1",
      "/repo",
      expect.any(Number),
      expect.any(Number),
      "docker system prune -f",
    );
    // Step two waits for the first step's exit, then runs on the OS host.
    await act(async () => exitHandler?.(0));
    await flush();
    expect(mocks.spawnPty).toHaveBeenCalledTimes(2);
    expect(mocks.spawnPty).toHaveBeenNthCalledWith(
      2,
      "t1",
      "/home/native",
      expect.any(Number),
      expect.any(Number),
      "wsl --shutdown",
    );
    expect(onMetaChange).toHaveBeenCalledWith({
      command: { step: { runId: 1, done: 1 } },
    });
    await act(async () => exitHandler?.(0));
    await flush();
    expect(onMetaChange).toHaveBeenCalledWith({ command: { launched: 1 } });
    // The tab hands an interactive shell back when the sequence completes.
    expect(mocks.spawnPty).toHaveBeenCalledTimes(3);
    expect(mocks.spawnPty).toHaveBeenNthCalledWith(
      3,
      "t1",
      "/repo",
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    await act(async () => root.unmount());
    host.remove();
  });

  it("stops the sequence on a failed step, ends the run and hands a shell back", async () => {
    const { host, root, onMetaChange, run } = render(
      stepsCommand([{ command: "step one" }, { command: "step two" }]),
    );
    await act(async () => run());
    await flush();
    await act(async () => exitHandler?.(1));
    await flush();
    // `launched` lands with `failed`: the run is over, so `runId > launched`
    // cannot pin the launch-pending guard forever.
    expect(onMetaChange).toHaveBeenCalledWith({
      command: { failed: 1, launched: 1, step: { runId: 1, done: 0 } },
    });
    // The failed run leaves an interactive shell — step two never spawns.
    expect(mocks.spawnPty).toHaveBeenCalledTimes(2);
    expect(mocks.spawnPty).toHaveBeenNthCalledWith(
      2,
      "t1",
      "/repo",
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    await act(async () => root.unmount());
    host.remove();
  });

  it("fails a native-host step whose home directory is unavailable instead of running it in the target", async () => {
    mocks.homeDir.mockRejectedValue(new Error("no home"));
    const { host, root, onMetaChange, run } = render(
      stepsCommand([
        { command: "wsl --shutdown", host: "native" },
        { command: "after" },
      ]),
    );
    await act(async () => run());
    await flush();
    expect(onMetaChange).toHaveBeenCalledWith({
      command: { failed: 1, launched: 1, step: { runId: 1, done: 0 } },
    });
    // The step never spawned at the target cwd — that could be WSL, the host
    // it explicitly means to avoid. The shell respawn is the only spawn.
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);
    expect(mocks.spawnPty).toHaveBeenCalledWith(
      "t1",
      "/repo",
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    await act(async () => root.unmount());
    host.remove();
  });

  it("fails a step whose spawn rejects and still hands a shell back", async () => {
    mocks.spawnPty.mockRejectedValueOnce(new Error("pty spawn failed"));
    const { host, root, onMetaChange, run } = render(
      stepsCommand([{ command: "step one" }, { command: "step two" }]),
    );
    await act(async () => run());
    await flush();
    expect(onMetaChange).toHaveBeenCalledWith({
      command: { failed: 1, launched: 1, step: { runId: 1, done: 0 } },
    });
    expect(mocks.spawnPty).toHaveBeenCalledTimes(2);
    expect(mocks.spawnPty).toHaveBeenNthCalledWith(
      2,
      "t1",
      "/repo",
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    await act(async () => root.unmount());
    host.remove();
  });

  it("resumes at the persisted step instead of re-running completed ones", async () => {
    const { host, root, run } = render(
      stepsCommand([{ command: "step one" }, { command: "step two" }], {
        step: { runId: 1, done: 1 },
      }),
    );
    await act(async () => run());
    await flush();
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);
    expect(mocks.spawnPty).toHaveBeenCalledWith(
      "t1",
      "/repo",
      expect.any(Number),
      expect.any(Number),
      "step two",
    );
    await act(async () => root.unmount());
    host.remove();
  });

  it("does not re-fire a failed run without a new runId", async () => {
    const { host, root, run } = render(
      stepsCommand([{ command: "step one" }], { failed: 1 }),
    );
    await act(async () => run());
    await flush();
    // Interactive shell only — the failed step never re-runs silently.
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);
    expect(mocks.spawnPty).toHaveBeenCalledWith(
      "t1",
      "/repo",
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    await act(async () => root.unmount());
    host.remove();
  });
});
