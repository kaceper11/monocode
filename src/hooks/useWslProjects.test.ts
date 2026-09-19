// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { setWslStatus } from "../lib/wslStatus";
import { useWslProjects } from "./useWslProjects";
import { connectWslProject } from "../lib/wsl";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(false) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/wsl", () => ({ connectWslProject: vi.fn(), invalidateWslDiscovery: vi.fn(), wslDistributions: vi.fn().mockResolvedValue(["Ubuntu"]) }));
it("enters only the latest connected WSL project and never falls back to native on failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const select = vi.fn();let hook!: ReturnType<typeof useWslProjects>;
  const pending: { resolve: (path: string) => void; reject: (error: Error) => void; signal?: AbortSignal }[] = [];
  vi.mocked(connectWslProject).mockImplementation((_path, signal) => new Promise((resolve, reject) => pending.push({ resolve, reject, signal })));
  function Fixture() { hook = useWslProjects("/native", select);return null; }
  const host = document.createElement("div");const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => hook.onSelectProject("//wsl.localhost/Ubuntu/old"));
    await act(async () => hook.onSelectProject("//wsl.localhost/Debian/new"));
    expect(pending[0].signal?.aborted).toBe(true);
    await act(async () => pending[0].resolve("//wsl.localhost/Ubuntu/old"));
    expect(select).not.toHaveBeenCalled();
    await act(async () => pending[1].reject(new Error("bridge unavailable")));
    expect(select).not.toHaveBeenCalled();
    expect(hook.wslOpening?.error).toContain("bridge unavailable");
    await act(async () => hook.onSelectProject("//wsl.localhost/Debian/new"));
    await act(async () => pending[2].resolve("//wsl.localhost/Debian/canonical"));
    expect(select).toHaveBeenCalledExactlyOnceWith("//wsl.localhost/Debian/canonical");
    expect(hook.wslOpening).toBeNull();
  } finally { await act(async () => root.unmount());vi.unstubAllGlobals(); }
});

it("does not show an offline banner when a stale probe finishes after reconnect", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolve!: (value: boolean) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  setWslStatus("Ubuntu", { state: "disconnected" });
  let hook!: ReturnType<typeof useWslProjects>;
  function Fixture() { hook = useWslProjects("//wsl.localhost/Ubuntu/repo", vi.fn()); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    setWslStatus("Ubuntu", { state: "connected" });
    await act(async () => resolve(false));
    expect(hook.wslOpening).toBeNull();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
