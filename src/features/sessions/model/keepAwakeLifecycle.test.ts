// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
import { newSession, type Session } from "./session";
const state = (revision: number, enabled = true, working = 1) => ({
  supported: true,
  enabled,
  held: enabled && working > 0,
  working,
  error: null,
  revision,
});
let event: (event: { payload: ReturnType<typeof state> }) => void;
let root: Root | undefined;
let element: HTMLDivElement | undefined;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  api.invoke.mockReset();
  api.listen.mockReset();
  api.unlisten.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listen.mockImplementation(async (_name, listener) => {
    event = listener;
    return api.unlisten;
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  element?.remove();
  root = undefined;
  element = undefined;
  vi.unstubAllGlobals();
});
it("does not replace a newer shared status with a late initial fetch", async () => {
  let resolve!: (value: ReturnType<typeof state>) => void;
  api.invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const power = await import("./keepAwake");
  const unsubscribe = power.subscribePowerStatus(vi.fn());
  await Promise.resolve();
  event({ payload: state(2) });
  resolve(state(1, false, 0));
  await Promise.resolve();
  await Promise.resolve();
  expect(power.getPowerStatus()).toMatchObject({
    loaded: true,
    enabled: true,
    held: true,
    revision: 2,
  });
  expect(localStorage.getItem("monocode.keepAwake")).toBe("1");
  unsubscribe();
  await Promise.resolve();
  expect(api.unlisten).toHaveBeenCalledOnce();
});
it("preserves the newest explicit toggle when older command responses arrive later", async () => {
  const pending: ((value: ReturnType<typeof state>) => void)[] = [];
  api.invoke.mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const power = await import("./keepAwake");
  const enable = power.setKeepAwakeEnabled(true);
  const disable = power.setKeepAwakeEnabled(false);
  pending[1](state(4, false));
  await disable;
  pending[0](state(3, true));
  await enable;
  expect(power.getPowerStatus()).toMatchObject({
    revision: 4,
    enabled: false,
    held: false,
  });
  expect(localStorage.getItem("monocode.keepAwake")).toBe("0");
});
it("surfaces a failed status read and lets explicit retry recover without leaking its listener", async () => {
  api.invoke.mockRejectedValueOnce(new Error("IPC unavailable"));
  const power = await import("./keepAwake");
  const unsubscribe = power.subscribePowerStatus(vi.fn());
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(power.getPowerStatus().error).toBe("IPC unavailable");
  api.invoke.mockResolvedValue(state(1, false, 0));
  await power.retryKeepAwake();
  expect(power.getPowerStatus()).toMatchObject({ loaded: true, error: null });
  expect(api.listen).toHaveBeenCalledOnce();
  unsubscribe();
  await Promise.resolve();
  expect(api.unlisten).toHaveBeenCalledOnce();
});
it("reports only real work changes and releases its report on unmount, including StrictMode", async () => {
  localStorage.setItem("monocode.keepAwake", "true");
  let revision = 0;
  api.invoke.mockImplementation(async (command, args) => {
    if (command === "power_status") return state(revision, true, 0);
    if (command === "power_sync")
      return state(++revision, true, args.sessionIds.length);
    throw new Error(command);
  });
  const { useKeepAwake } = await import("./keepAwake");
  function App({ sessions }: { sessions: Session[] }) {
    useKeepAwake(sessions);
    return null;
  }
  const working = { ...newSession("codex", "/repo"), busy: true };
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  const render = async (session: Session) =>
    act(async () =>
      root!.render(
        createElement(
          StrictMode,
          null,
          createElement(App, { sessions: [session] }),
        ),
      ),
    );
  await render(working);
  const reports = () =>
    api.invoke.mock.calls
      .filter(([command]) => command === "power_sync")
      .map(([, args]) => args);
  expect(reports().at(-1)).toEqual({
    initialEnabled: true,
    sessionIds: [working.id],
  });
  const count = reports().length;
  await render({ ...working, title: "Streaming title" });
  expect(reports()).toHaveLength(count);
  await render({
    ...working,
    pendingQuestion: { requestId: 1, title: "Choose", questions: [] },
  });
  expect(reports().at(-1).sessionIds).toEqual([]);
  await render(working);
  await act(async () => root!.render(null));
  expect(reports().at(-1).sessionIds).toEqual([]);
  expect(
    api.invoke.mock.calls.some(([command]) => command === "power_set_enabled"),
  ).toBe(false);
});
