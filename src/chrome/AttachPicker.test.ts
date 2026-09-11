// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AttachPicker } from "./AttachPicker";
import type { RankedFile } from "../lib/fileIndex";

const ranked = (relative: string): RankedFile => ({
  path: `/repo/${relative}`,
  relative,
  name: relative.split("/").at(-1) ?? relative,
  isDir: false,
  score: 0,
  positions: [],
});

function render(props: Partial<Parameters<typeof AttachPicker>[0]> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const handlers = {
    onQuery: vi.fn(),
    onActive: vi.fn(),
    onToggle: vi.fn(),
    onBrowse: vi.fn(),
    onClose: vi.fn(),
  };
  const run = () =>
    root.render(
      createElement(AttachPicker, {
        files: [ranked("a.ts"), ranked("src/b.ts")],
        query: "",
        active: 0,
        attached: new Set<string>(),
        ...handlers,
        ...props,
      }),
    );
  return { host, root, handlers, run };
}

const key = (el: Element, value: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));

it("navigates with arrows, toggles on Enter, and closes on Escape", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { host, root, handlers, run } = render();
  try {
    await act(async () => run());
    const input = host.querySelector("input")!;
    await act(async () => key(input, "ArrowDown"));
    expect(handlers.onActive).toHaveBeenCalledWith(1);
    await act(async () => key(input, "Enter"));
    expect(handlers.onToggle).toHaveBeenCalledWith(
      expect.objectContaining({ relative: "a.ts" }),
    );
    await act(async () => key(input, "Escape"));
    expect(handlers.onClose).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("marks attached files, toggles by click, and offers native browse", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { host, root, handlers, run } = render({
    attached: new Set(["/repo/a.ts"]),
  });
  try {
    await act(async () => run());
    const options = [...host.querySelectorAll('[role="option"]')];
    expect(options[0]!.querySelector(".text-accent")).not.toBeNull();
    expect(options[1]!.querySelector(".text-accent")).toBeNull();
    await act(async () => (options[1] as HTMLButtonElement).click());
    expect(handlers.onToggle).toHaveBeenCalledWith(
      expect.objectContaining({ relative: "src/b.ts" }),
    );
    const browse = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Browse files…",
    )!;
    await act(async () => browse.click());
    expect(handlers.onBrowse).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("falls back to browse on Enter when the list is empty", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { host, root, handlers, run } = render({ files: [], query: "zzz" });
  try {
    await act(async () => run());
    const input = host.querySelector("input")!;
    await act(async () => key(input, "Enter"));
    expect(handlers.onBrowse).toHaveBeenCalled();
    expect(handlers.onToggle).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("closes when a pointer lands outside the popover", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { host, root, handlers, run } = render();
  try {
    await act(async () => run());
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(handlers.onClose).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
