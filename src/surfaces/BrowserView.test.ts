// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  open: vi.fn(async (..._args: unknown[]) => {}), close: vi.fn(async (..._args: unknown[]) => {}), probe: vi.fn(),
  event: undefined as ((event: unknown) => void) | undefined,
  record: vi.fn(), capture: vi.fn(), find: vi.fn(), bounds: vi.fn(), visible: vi.fn(),
}));
vi.mock("../lib/browser", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/browser")>(),
  browserOpen: api.open, browserClose: api.close, browserProbe: api.probe,
  browserSetBounds: api.bounds, browserSetVisible: api.visible,
  browserSetBackground: vi.fn(async () => {}),
  browserSetRecording: api.record, browserCapture: api.capture, browserFind: api.find,
  subscribeBrowser: (_label: string, handler: (event: unknown) => void) => { api.event = handler; return () => { api.event = undefined; }; },
}));
import { BrowserView } from "./BrowserView";
import { requestBrowserCommand } from "../lib/browser";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.open.mockClear(); api.close.mockClear(); api.probe.mockReset();
  api.bounds.mockReset().mockResolvedValue(undefined); api.visible.mockReset().mockResolvedValue(undefined);
  api.capture.mockReset().mockRejectedValue(new Error("fixture capture"));
  api.record.mockReset().mockResolvedValue(true); api.find.mockReset().mockResolvedValue({ count: 0, index: -1 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function renderBrowser(persist = true, active = true) {
  await act(async () => root.render(createElement(BrowserView, {
    file: { id: "browser-file", cwd: "/repo", path: "https://example.test", browser: { url: "https://example.test", persist } },
    sessions: [], active,
  })));
}
function click(title: string) {
  const button = host.querySelector(`button[title="${title}"]`) as HTMLButtonElement;
  expect(button).not.toBeNull(); button.click();
}

it("queues a stop behind an in-flight start without reviving its indicator", async () => {
  const first = deferred<boolean>(); api.record.mockReturnValueOnce(first.promise);
  await renderBrowser();
  await act(async () => click("Record steps to reproduce"));
  await act(async () => click("Cancel recording start"));
  expect(api.record).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(true));
  expect(api.record).toHaveBeenCalledTimes(2);
  expect(api.record.mock.calls.map(args => args.slice(1))).toEqual([
    [true, "https://example.test", false], [false, "https://example.test", false],
  ]);
  expect(host.querySelector('[title="Recording browser steps"]')).toBeNull();
  expect(host.querySelector('button[title="Record steps to reproduce"]')).not.toBeNull();
});

it("invalidates a pending recording when navigation moves to another origin", async () => {
  const first = deferred<boolean>(); api.record.mockReturnValueOnce(first.promise);
  await renderBrowser();
  await act(async () => click("Record steps to reproduce"));
  await act(async () => api.event?.({ kind: "navigate", url: "https://other.test/page", canBack: true, canForward: false }));
  await act(async () => first.resolve(true));
  expect(api.record.mock.calls.at(-1)?.slice(1)).toEqual([false, "https://other.test", false]);
  expect(host.querySelector('[title="Recording browser steps"]')).toBeNull();
  expect(host.textContent).toContain("moved to a different site");
});

it("gives a recreated profile a new native identity and ignores the old recording reply", async () => {
  const first = deferred<boolean>(); api.record.mockReturnValueOnce(first.promise);
  await renderBrowser(); const oldLabel = api.open.mock.calls[0][0];
  await act(async () => click("Record steps to reproduce"));
  await renderBrowser(false);
  const nextLabel = api.open.mock.calls.at(-1)![0];
  expect(nextLabel).not.toBe(oldLabel);
  expect(api.close).toHaveBeenCalledWith(oldLabel);
  await act(async () => first.resolve(true));
  expect(host.querySelector('[title="Recording browser steps"]')).toBeNull();
  expect(api.record).toHaveBeenCalledTimes(1);
});

it("keeps a visible stop action when recording acknowledgement fails", async () => {
  api.record.mockRejectedValueOnce(new Error("timed out"));
  await renderBrowser();
  await act(async () => click("Record steps to reproduce"));
  expect(host.textContent).toContain("Cannot confirm recording state");
  await act(async () => click("Stop recording steps"));
  expect(api.record.mock.calls.at(-1)?.[1]).toBe(false);
});

it("stops geometry polling and overlay scans for an inactive browser pane", async () => {
  await renderBrowser();
  await act(async () => api.event?.({ kind: "load-finished", url: "https://example.test", canBack: false, canForward: false }));
  const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  try {
    await renderBrowser(true, false);
    const count = geometry.mock.calls.length;
    await act(async () => {
      document.body.classList.add("fixture-change");
      await vi.advanceTimersByTimeAsync(2200);
    });
    expect(geometry.mock.calls.length).toBe(count);
    expect(api.open).toHaveBeenCalledTimes(1);
  } finally { geometry.mockRestore(); document.body.classList.remove("fixture-change"); }
});

it("clears find after a pending result and never restores a closed result", async () => {
  const first = deferred<{count: number; index: number}>(); api.find.mockReturnValueOnce(first.promise);
  await renderBrowser();
  await act(async () => requestBrowserCommand("browser-browser-file", "find"));
  const input = host.querySelector('input[aria-label="Find in page"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "needle"); input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
  });
  expect(api.find).toHaveBeenCalledTimes(1);
  await act(async () => (host.querySelector('button[aria-label="Close find"]') as HTMLButtonElement).click());
  await act(async () => first.resolve({ count: 9, index: 0 }));
  expect(api.find.mock.calls.at(-1)?.[1]).toBe("");
  await act(async () => requestBrowserCommand("browser-browser-file", "find"));
  expect((host.querySelector('button[aria-label="Next match"]') as HTMLButtonElement).disabled).toBe(true);
  expect((host.querySelector('input[aria-label="Find in page"]') as HTMLInputElement).value).toBe("");
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(["ready", "closed"])("ignores an obsolete load probe after the page is %s", async state => {
  let resolve!: (value: unknown) => void;
  api.probe.mockImplementation(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(createElement(BrowserView, {
    file: { id: "browser-file", cwd: "/repo", path: "https://example.test", browser: { url: "https://example.test" } },
    sessions: [], active: true,
  })));
  expect(api.open).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(8000));
  expect(api.probe).toHaveBeenCalledOnce();
  if (state === "ready") {
    act(() => api.event?.({ kind: "load-finished", url: "https://example.test", canBack: false, canForward: false }));
  } else { act(() => root.render(null)); }
  await act(async () => resolve(state === "ready" ? { href: "about:blank" } : null));
  expect(host.textContent).not.toContain("Couldn't load");
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(api.probe).toHaveBeenCalledOnce();
});

it("restores bounds only after an earlier native hide has finished", async () => {
  const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 30, width: 600, height: 400 } as DOMRect);
  const hide = deferred<void>();
  try {
    await renderBrowser();
    api.bounds.mockClear(); api.visible.mockClear();
    api.visible.mockImplementation((_label, visible) => visible ? Promise.resolve() : hide.promise);
    await renderBrowser(true, false);
    expect(api.visible).toHaveBeenLastCalledWith(expect.any(String), false);
    await renderBrowser(true, true);
    expect(api.visible).toHaveBeenCalledTimes(1);
    expect(api.bounds).not.toHaveBeenCalled();
    await act(async () => hide.resolve());
    expect(api.visible).toHaveBeenLastCalledWith(expect.any(String), true);
    expect(api.bounds).toHaveBeenLastCalledWith(expect.any(String), { x: 20, y: 30, width: 600, height: 400 });
  } finally { geometry.mockRestore(); }
});


it("reasserts an owned recording on document-ready without waiting for load-finished", async () => {
  await renderBrowser();
  await act(async () => api.event?.({ kind: "recording-ready" }));
  expect(api.record).not.toHaveBeenCalled();
  await act(async () => click("Record steps to reproduce"));
  api.record.mockClear();
  await act(async () => api.event?.({ kind: "recording-ready" }));
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(api.record.mock.calls.at(-1)?.slice(1)).toEqual([true, "https://example.test", true]);
  await act(async () => click("Stop recording steps"));
  api.record.mockClear();
  await act(async () => api.event?.({ kind: "recording-ready" }));
  expect(api.record).not.toHaveBeenCalled();
});


it("coalesces forged ready notices and lets Stop supersede an in-flight acknowledgement", async () => {
  await renderBrowser();
  await act(async () => click("Record steps to reproduce"));
  api.record.mockClear();
  const pending = deferred<boolean>(); api.record.mockReturnValueOnce(pending.promise);
  await act(async () => { for (let i = 0; i < 200; i++) api.event?.({ kind: "recording-ready" }); });
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(api.record).toHaveBeenCalledTimes(1);
  await act(async () => { for (let i = 0; i < 200; i++) api.event?.({ kind: "recording-ready" }); });
  await act(async () => click("Cancel recording start"));
  await act(async () => pending.resolve(true));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(api.record.mock.calls.map(args => args.slice(1))).toEqual([
    [true, "https://example.test", true], [false, "https://example.test", false],
  ]);
  expect(host.querySelector('[title="Recording browser steps"]')).toBeNull();
});


it("caps sustained ready acknowledgements at one per second while preserving a trailing document", async () => {
  await renderBrowser();
  await act(async () => click("Record steps to reproduce"));
  api.record.mockClear();
  for (let i = 0; i < 20; i++) {
    await act(async () => { api.event?.({ kind: "recording-ready" }); await vi.advanceTimersByTimeAsync(50); });
  }
  expect(api.record).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(api.record).toHaveBeenCalledTimes(2);
  await act(async () => click("Stop recording steps"));
});

it("acknowledges pending continuation before explicitly capturing recorded steps", async () => {
  await renderBrowser();
  await act(async () => click("Record steps to reproduce"));
  api.record.mockClear();
  const pending = deferred<boolean>(); api.record.mockReturnValueOnce(pending.promise);
  await act(async () => click("Send page and recorded steps to an agent"));
  expect(api.record.mock.calls[0].slice(1)).toEqual([true, "https://example.test", true]);
  expect(api.capture).not.toHaveBeenCalled();
  await act(async () => pending.resolve(true));
  expect(api.capture).toHaveBeenCalledTimes(1);
});
