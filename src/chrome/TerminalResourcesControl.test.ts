// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  sample: vi.fn(),
  stop: vi.fn(),
  runs: [] as { terminalId: string; status: string }[],
}));
vi.mock("../lib/terminalResources", async (original) => ({
  ...(await original<object>()),
  sampleTerminalResources: api.sample,
  stopTerminalWorkload: api.stop,
}));
vi.mock("../lib/savedCommandRun", () => ({
  savedCommandRunsSnapshot: () => api.runs,
  subscribeSavedCommandRuns: () => () => {},
  stopSavedCommandRun: vi.fn(),
}));
vi.mock("./Popover", () => ({
  Popover: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
import { TerminalResourcesControl } from "./TerminalResourcesControl";
const terminals = [
  { id: "one", title: "Dev server", cwd: "/repo", foreground: "node" },
];
const row = {
  id: "one",
  generation: "spawn-1",
  alive: true,
  host: "native",
  distro: null,
  cpuPct: 25,
  rssBytes: 1024 ** 2,
  processes: 2,
  workload: true,
  top: "node",
  error: null,
};
let host: HTMLDivElement, root: Root;
const onOpen = vi.fn(),
  onClose = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  api.sample.mockReset().mockResolvedValue([row]);
  api.stop.mockReset().mockResolvedValue(undefined);
  api.runs = [];
  onOpen.mockReset();
  onClose.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      createElement(TerminalResourcesControl, { terminals, onOpen, onClose }),
    ),
  );
}
function button(name: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.getAttribute("aria-label") === name ||
      item.textContent?.startsWith(name),
  );
  if (!found) throw new Error(name);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
it("does no closed/hidden polling, resumes visibly, and stops polling after dismissal", async () => {
  await render();
  expect(api.sample).not.toHaveBeenCalled();
  await click("Resources");
  expect(api.sample).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("25% · 1 MB");
  await act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(api.sample).toHaveBeenCalledTimes(1);
  await act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(api.sample).toHaveBeenCalledTimes(2);
  await click("Close resource manager");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.sample).toHaveBeenCalledTimes(2);
});
it("keeps unknown sampling and stop errors visible instead of claiming zero usage", async () => {
  api.sample.mockRejectedValueOnce(new Error("sampling unavailable"));
  await render();
  await click("Resources");
  expect(host.textContent).toContain("sampling unavailable");
  expect(host.textContent).toContain("Unknown");
  expect(button("Stop workload in Dev server").disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  api.stop.mockRejectedValueOnce(new Error("stop denied"));
  await click("Stop workload in Dev server");
  expect(host.textContent).toContain("stop denied");
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(host.textContent).toContain("stop denied");
  expect(api.stop).toHaveBeenCalledTimes(1);
});
it("navigates and closes through the owning upstream callbacks", async () => {
  await render();
  await click("Resources");
  await click("Dev server");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("one");
  await click("Resources");
  await click("Close terminal Dev server");
  expect(onClose).toHaveBeenCalledExactlyOnceWith(terminals[0]);
});
it("ignores late samples after closing and prevents duplicate stop dispatch", async () => {
  let finish!: (value: (typeof row)[]) => void;
  api.sample.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await click("Resources");
  await click("Close resource manager");
  await act(async () => finish([row]));
  expect(host.textContent).not.toContain("25%");
  await click("Resources");
  let stopped!: () => void;
  api.stop.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        stopped = resolve;
      }),
  );
  await act(async () => {
    button("Stop workload in Dev server").click();
    button("Stop workload in Dev server").click();
  });
  expect(api.stop).toHaveBeenCalledTimes(1);
  await act(async () => stopped());
});
