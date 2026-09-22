// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { wslDistributions } from "../model/wsl";
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

it("offers the distribution's Linux home for a new project", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "wsl_home" ? "/home/tester" : ["Ubuntu", "Debian"],
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(WslProjectDialog, {
          cwd: "C:/work/repo",
          onOpen: vi.fn(),
          onClose: vi.fn(),
        }),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-haspopup="listbox"]',
    )!;
    await act(async () => trigger.click());
    const menu = document.querySelector<HTMLElement>('[role="listbox"]')!;
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
    await act(async () => Promise.resolve());
    expect(invoke).toHaveBeenCalledWith("wsl_home", {
      distribution: "Ubuntu",
    });
    expect(
      document.querySelector<HTMLTextAreaElement>("textarea")!.value,
    ).toBe("/home/tester");
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

it("connects each listed Linux folder in order and opens them together", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onOpen = vi.fn();
  const close = vi.fn();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "wsl_distributions") return Promise.resolve(["Ubuntu"]);
    if (command === "wsl_connect") return Promise.resolve(args);
    return Promise.resolve(false);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(WslProjectDialog, {
          cwd: "/native/repo",
          onOpen,
          onClose: close,
        }),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-haspopup="listbox"]',
    )!;
    await act(async () => trigger.click());
    const menu = document.querySelector<HTMLElement>('[role="listbox"]')!;
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
    expect(trigger.textContent).toContain("Ubuntu");
    const textarea = document.querySelector("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(textarea, "/home/me/a\n/home/me/b");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    const connects = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "wsl_connect");
    expect(connects.map(([, args]) => args)).toEqual([
      { distribution: "Ubuntu", path: "/home/me/a" },
      { distribution: "Ubuntu", path: "/home/me/b" },
    ]);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith([
      "//wsl.localhost/Ubuntu/home/me/a",
      "//wsl.localhost/Ubuntu/home/me/b",
    ]);
    expect(close).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
