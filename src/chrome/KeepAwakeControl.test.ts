// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const power = vi.hoisted(() => ({
  status: {
    supported: true,
    enabled: false,
    held: false,
    working: 0,
    error: null as string | null,
    revision: 1,
    loaded: true,
  },
  set: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("../lib/keepAwake", () => ({
  usePowerStatus: () => power.status,
  setKeepAwakeEnabled: power.set,
  retryKeepAwake: power.retry,
}));
import { KeepAwakeControl } from "./KeepAwakeControl";
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  power.status = {
    supported: true,
    enabled: false,
    held: false,
    working: 0,
    error: null,
    revision: 1,
    loaded: true,
  };
  power.set.mockReset();
  power.retry.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(createElement(KeepAwakeControl)));
}
it("waits for the explicit toggle result and shows an OS failure with a usable retry", async () => {
  let reject!: (reason: Error) => void;
  power.set.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await render();
  const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  act(() => toggle.click());
  expect(power.set).toHaveBeenCalledWith(true);
  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => reject(new Error("Power request unavailable")));
  expect(toggle.disabled).toBe(false);
  expect(host.textContent).toContain("Power request unavailable");
  power.retry.mockResolvedValue(undefined);
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  expect(power.retry).toHaveBeenCalledOnce();
});
it("only shows Active for a held assertion and identifies unsupported platforms", async () => {
  power.status = { ...power.status, enabled: true, held: true, working: 2 };
  await render();
  expect(host.textContent).toContain("Active · 2 agents working");
  power.status = { ...power.status, held: false, working: 0 };
  await render();
  expect(host.textContent).not.toContain("Active");
  power.status = { ...power.status, supported: false };
  await render();
  expect(host.textContent).toContain("Not available on this platform");
});
