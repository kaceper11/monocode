// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }));
vi.mock("../lib/wsl", () => ({ connectWslProject: connect }));
vi.mock("./Popover", () => ({ Popover: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
import { WslBadge } from "./WslBadge";

it("shows canonical-path errors and abandons old checks when the project changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = async (cwd: string) => act(async () => root.render(createElement(WslBadge, { cwd })));
  const check = async () => {
    await act(async () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Check connection")!.click());
  };
  try {
    await render("//wsl.localhost/Ubuntu/original");
    connect.mockResolvedValueOnce("//wsl.localhost/Ubuntu/different");
    await check();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("different path");
    await render("//wsl.localhost/Ubuntu/second");
    let resolve!: (path: string) => void;
    let signal!: AbortSignal;
    connect.mockImplementationOnce((_cwd, pending) => { signal = pending; return new Promise(done => { resolve = done; }); });
    await check();
    await render("//wsl.localhost/Debian/third");
    expect(signal.aborted).toBe(true);
    await act(async () => resolve("//wsl.localhost/Ubuntu/late"));
    expect(container.textContent).not.toContain("different path");
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
