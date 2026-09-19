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
  const readyPtyEvents = vi.fn(() => Promise.resolve());
  const invoke = vi.fn(() => Promise.resolve());
  const homeDir = vi.fn(() => Promise.resolve("/home/native"));
  return {
    spawnPty,
    writePty,
    getPtyStatus,
    killPty,
    resizePty,
    subscribePty,
    homeDir,
    readyPtyEvents,
    invoke,
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
  readyPtyEvents: mocks.readyPtyEvents,
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

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { TerminalView } from "./TerminalView";
import {
  queueSavedCommandRun,
  savedCommandRunsSnapshot,
} from "../lib/savedCommandRun";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let exit: (code: number | null) => void;
let mounted = false;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.spawnPty.mockReset().mockResolvedValue(undefined);
  mocks.killPty.mockReset().mockResolvedValue(undefined);
  mocks.writePty.mockReset().mockResolvedValue(undefined);
  mocks.resizePty.mockReset().mockResolvedValue(undefined);
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.subscribePty.mockImplementation((...args: unknown[]) => {
    exit = args[2] as typeof exit;
    return () => {};
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(id: string, strict = false) {
  await act(async () =>
    root.render(
      createElement(
        strict ? StrictMode : "div",
        null,
        createElement(TerminalView, { id, cwd: "/repo", active: true }),
      ),
    ),
  );
}
it("keeps ordinary terminals on the original interactive spawn path", async () => {
  await render("ordinary");
  expect(mocks.spawnPty).toHaveBeenCalledWith("ordinary", "/repo", 80, 24);
  expect(mocks.invoke).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  mounted = false;
  expect(mocks.killPty).toHaveBeenCalledWith("ordinary");
});
it("routes a registered sequence through real TerminalView exit and cleanup hooks", async () => {
  queueSavedCommandRun({
    terminalId: "saved",
    commandId: "c",
    projectCwd: "/repo",
    name: "Test",
    cwd: "/repo",
    steps: [{ command: "first" }, { command: "second" }],
  });
  await render("saved", true);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenLastCalledWith(
    "pty_spawn",
    expect.objectContaining({ id: "saved", exec: "first" }),
  );
  await act(async () => exit(0));
  expect(mocks.invoke).toHaveBeenLastCalledWith(
    "pty_spawn",
    expect.objectContaining({ exec: "second" }),
  );
  await act(async () => exit(0));
  expect(mocks.spawnPty).toHaveBeenCalledWith("saved", "/repo", 80, 24);
  expect(
    savedCommandRunsSnapshot().find((run) => run.terminalId === "saved")
      ?.status,
  ).toBe("completed");
  await act(async () => root.unmount());
  mounted = false;
  expect(mocks.killPty).toHaveBeenCalledTimes(1);
  expect(savedCommandRunsSnapshot()).toHaveLength(0);
});
