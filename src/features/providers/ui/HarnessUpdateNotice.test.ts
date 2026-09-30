// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWslStatus } from "../../sessions/model/wslStatus";
import { invoke } from "@tauri-apps/api/core";
import { updateHarnessCli, inspectHarnessBinary } from "../../../integrations/harness/core/child";
import { HarnessUpdateNotice } from "./HarnessUpdateNotice";

let claimed = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "harness_update_check_claim") {
      const first = !claimed;
      claimed = true;
      return first;
    }
    if (command === "harness_latest_version") return "2.1.285";
    throw new Error(`unexpected ${command}`);
  }),
}));
vi.mock("../../../integrations/harness/core/availability", () => ({
  probeHarnessAvailability: vi.fn(async () => undefined),
  isHarnessAvailable: (id: string) => id === "claude",
}));
let installed = "2.1.284 (Claude Code)";
vi.mock("../../../integrations/harness/core/child", () => ({
  inspectHarnessBinary: vi.fn(async () => ({
    path: "/bin/claude",
    version: installed,
  })),
  updateHarnessCli: vi.fn(async () => {
    installed = "2.1.285 (Claude Code)";
  }),
}));
vi.mock("../../sessions/model/models", async (original) => ({
  ...await original<typeof import("../../sessions/model/models")>(),
  isPickerProviderVisible: () => true,
}));
const refreshHarnessCatalogs = vi.fn(async () => undefined);
vi.mock("../../../integrations/harness/core/registry", () => ({
  refreshHarnessCatalogs: (...args: unknown[]) =>
    refreshHarnessCatalogs(...(args as [])),
}));
const eventListeners = new Set<(event: { payload: unknown }) => void>();
const emit = vi.fn(async (_event: string, payload: unknown) => {
  eventListeners.forEach((listener) => listener({ payload }));
});
vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload: unknown) => emit(event, payload),
  listen: vi.fn(
    async (_event: string, listener: (event: { payload: unknown }) => void) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
  ),
}));
vi.mock("../../sessions/ui/HarnessIcon", () => ({ HarnessIcon: () => null }));

describe("HarnessUpdateNotice", () => {
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(() => vi.unstubAllGlobals());

  it("survives a StrictMode remount and updates from the card", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(StrictMode, null, createElement(HarnessUpdateNotice)),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const notice = document.body.querySelector(
      '[aria-label="Harness updates"]',
    );
    expect(notice?.textContent).toContain("Claude Code");
    expect(notice?.textContent).toContain("2.1.284 → 2.1.285");

    const update = Array.from(notice!.querySelectorAll("button")).find(
      (button) => button.textContent === "Update",
    )!;
    await act(async () => {
      update.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(notice?.textContent).toContain("Updated to 2.1.285");
    expect(refreshHarnessCatalogs).toHaveBeenCalledWith(["claude"], undefined, true);
    expect(refreshHarnessCatalogs).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("harness-updated", {
      harness: "claude",
      source: expect.any(String),
    });
    expect(notice?.textContent).toContain("Model picker refreshed");
    await act(async () => {
      await emit("harness-updated", {
        harness: "claude",
        source: "other-window",
      });
    });
    expect(refreshHarnessCatalogs).toHaveBeenCalledTimes(2);
    expect(refreshHarnessCatalogs).toHaveBeenLastCalledWith(["claude"], undefined, true);
    act(() => root.unmount());
  });
});

it("offers updates for the selected WSL distribution and keeps every action on that host", async () => {
  installed = "2.1.284 (Claude Code)";
  claimed = false;
  const cwd = "//wsl.localhost/Ubuntu/home/me/repo";
  setWslStatus("Ubuntu", { state: "connected" });
  const container = document.createElement("div");
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => { root.render(createElement(HarnessUpdateNotice, { cwd })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const notice = document.body.querySelector('[aria-label="Harness updates"]')!;
    expect(notice.textContent).toContain("WSL: Ubuntu");
    expect(invoke).toHaveBeenCalledWith("harness_update_check_claim", { cwd });
    const update = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Update")!;
    await act(async () => { update.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(updateHarnessCli).toHaveBeenCalledWith("claude", cwd);
    expect(inspectHarnessBinary).toHaveBeenCalledWith("claude", undefined, cwd);
    expect(refreshHarnessCatalogs).toHaveBeenLastCalledWith(["claude"], cwd, true);
    expect(emit).toHaveBeenCalledWith("harness-updated", expect.objectContaining({ harness: "claude", cwd }));
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
