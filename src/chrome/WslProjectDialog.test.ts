// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { wslDistributions } from "../lib/wsl";
import { WslProjectDialog } from "./WslProjectDialog";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ["Ubuntu", "Debian"]),
}));

it("uses the themed listbox and returns keyboard focus without closing the dialog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const close = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(WslProjectDialog, {
          cwd: "//wsl.localhost/Ubuntu/home/me/repo",
          onOpen: vi.fn(),
          onClose: close,
        }),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-haspopup="listbox"]',
    )!;
    expect(trigger.textContent).toContain("Ubuntu");
    expect(document.querySelector("select")).toBeNull();
    await act(async () => trigger.click());
    const menu = document.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(menu).not.toBeNull();
    await act(async () =>
      menu.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await act(async () =>
      menu.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(trigger.textContent).toContain("Debian");
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("mounts with prefetched distributions without re-probing or loading", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The boot/preflight probe has already resolved, so the dialog must open
  // in its final layout — a fresh probe would flicker the loading frame.
  await wslDistributions();
  vi.mocked(invoke).mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(WslProjectDialog, {
          cwd: "//wsl.localhost/Ubuntu/home/me/repo",
          onOpen: vi.fn(),
          onClose: vi.fn(),
        }),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-haspopup="listbox"]',
    )!;
    expect(trigger.textContent).toContain("Ubuntu");
    expect(
      document.querySelector("form")!.textContent,
    ).not.toContain("No WSL distributions found");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
