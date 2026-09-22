// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { setWslStatus } from "../../features/sessions/model/wslStatus";
import { useWslProjects } from "./useWslProjects";
import { connectWslProject, invalidateWslDiscovery, wslDistributions, wslDistributionsPeek } from "../../features/sessions/model/wsl";
import { pickFolder } from "../../platform/tauri/fs";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(false) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../platform/tauri/platform", () => ({
  IS_WIN: true,
  IS_MAC: false,
  HAS_NATIVE_GLASS: true,
  MOD: "Ctrl+",
  ALT: "Alt+",
  SHIFT: "Shift+",
}));
vi.mock("../../platform/tauri/fs", () => ({ pickFolder: vi.fn() }));
vi.mock("../../features/sessions/model/wsl", () => ({ connectWslProject: vi.fn(), invalidateWslDiscovery: vi.fn(), wslDistributions: vi.fn().mockResolvedValue(["Ubuntu"]), wslDistributionsPeek: vi.fn().mockReturnValue(null) }));
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
    expect(select).toHaveBeenCalledExactlyOnceWith(["//wsl.localhost/Debian/canonical"], true);
    expect(hook.wslOpening).toBeNull();
  } finally { await act(async () => root.unmount());vi.unstubAllGlobals(); }
});

it("connects restored sessions and new sessions in the same project without opening another tab", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const cwd = "//wsl.localhost/Ubuntu/repo";
  const select = vi.fn();
  let hook!: ReturnType<typeof useWslProjects>;
  vi.mocked(connectWslProject).mockReset().mockResolvedValue(cwd);
  function Fixture({ id }: { id: string }) { hook = useWslProjects(cwd, select, id); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture, { id: "restored" })));
    expect(connectWslProject).toHaveBeenCalledTimes(1);
    expect(hook.wslOpening).toBeNull();
    await act(async () => root.render(createElement(Fixture, { id: "new" })));
    expect(connectWslProject).toHaveBeenCalledTimes(2);
    expect(select).not.toHaveBeenCalled();
    await act(async () => setWslStatus("Ubuntu", { state: "disconnected" }));
    expect(connectWslProject).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("keeps an attached session on connection failure and retries without retargeting it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const cwd = "//wsl.localhost/Ubuntu/repo";
  const select = vi.fn();
  let hook!: ReturnType<typeof useWslProjects>;
  vi.mocked(connectWslProject).mockReset().mockRejectedValueOnce(new Error("bridge unavailable")).mockResolvedValue(cwd);
  function Fixture() { hook = useWslProjects(cwd, select); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    expect(hook.wslOpening).toMatchObject({ path: cwd, busy: false, attached: true, error: "Error: bridge unavailable" });
    await act(async () => hook.retryOpening());
    expect(hook.wslOpening).toBeNull();
    vi.mocked(connectWslProject).mockResolvedValueOnce("//wsl.localhost/Ubuntu/other");
    await act(async () => root.render(createElement(Fixture, { key: "another-session" })));
    expect(hook.wslOpening?.error).toContain("different path");
    expect(select).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("ignores an abandoned automatic connect after switching to a native project", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const select = vi.fn();
  let hook!: ReturnType<typeof useWslProjects>;
  let finish!: (path: string) => void;
  vi.mocked(connectWslProject).mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  function Fixture({ cwd }: { cwd: string }) { hook = useWslProjects(cwd, select); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture, { cwd: "//wsl.localhost/Ubuntu/repo" })));
    expect(hook.wslOpening?.busy).toBe(true);
    await act(async () => root.render(createElement(Fixture, { cwd: "/native" })));
    await act(async () => finish("//wsl.localhost/Ubuntu/repo"));
    expect(hook.wslOpening).toBeNull();
    expect(select).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("uses the folder picker without the host dialog when WSL offers no distributions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const select = vi.fn();let hook!: ReturnType<typeof useWslProjects>;
  vi.mocked(wslDistributions).mockResolvedValueOnce([]);
  vi.mocked(pickFolder).mockResolvedValueOnce(["/work/a", "/work/b"]);
  function Fixture() { hook = useWslProjects("/native", select);return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => hook.pickProject());
    expect(hook.wslPickerOpen).toBe(false);
    expect(select).toHaveBeenCalledExactlyOnceWith(["/work/a", "/work/b"], true);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("uses the folder picker when the probe fails and no distributions were ever seen", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const select = vi.fn();let hook!: ReturnType<typeof useWslProjects>;
  vi.mocked(wslDistributionsPeek).mockReturnValue(null);
  vi.mocked(wslDistributions).mockRejectedValueOnce(new Error("wsl.exe unavailable"));
  vi.mocked(pickFolder).mockResolvedValueOnce(["/work/a"]);
  function Fixture() { hook = useWslProjects("/native", select);return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => hook.pickProject());
    expect(hook.wslPickerOpen).toBe(false);
    expect(select).toHaveBeenCalledExactlyOnceWith(["/work/a"], true);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("opens the host dialog when distributions are listed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let hook!: ReturnType<typeof useWslProjects>;
  vi.mocked(pickFolder).mockClear();
  function Fixture() { hook = useWslProjects("/native", vi.fn());return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => hook.pickProject());
    expect(hook.wslPickerOpen).toBe(true);
    expect(pickFolder).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("keeps the host dialog when a failed probe leaves known distributions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let hook!: ReturnType<typeof useWslProjects>;
  vi.mocked(wslDistributionsPeek).mockReturnValue(["Ubuntu"]);
  vi.mocked(wslDistributions).mockRejectedValueOnce(new Error("probe failed"));
  vi.mocked(pickFolder).mockClear();
  function Fixture() { hook = useWslProjects("/native", vi.fn());return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => hook.pickProject());
    expect(hook.wslPickerOpen).toBe(true);
    expect(pickFolder).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("connects picked WSL folders in order and opens the batch once", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const select = vi.fn();let hook!: ReturnType<typeof useWslProjects>;
  const pending: { resolve: (path: string) => void; reject: (error: Error) => void }[] = [];
  vi.mocked(connectWslProject).mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  function Fixture() { hook = useWslProjects("/native", select);return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => hook.onSelectProjects(["/native/a", "//wsl.localhost/Ubuntu/x", "//wsl.localhost/Debian/y"]));
    // Sequential connects — Debian has not started while Ubuntu is pending.
    expect(pending.length).toBe(1);
    await act(async () => pending[0].resolve("//wsl.localhost/Ubuntu/cx"));
    expect(pending.length).toBe(2);
    await act(async () => pending[1].resolve("//wsl.localhost/Debian/cy"));
    expect(select).toHaveBeenCalledExactlyOnceWith(
      ["/native/a", "//wsl.localhost/Ubuntu/cx", "//wsl.localhost/Debian/cy"],
      true,
    );
    expect(hook.wslOpening).toBeNull();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("opens resolved picks before a failed connect and resumes the rest on retry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const select = vi.fn();let hook!: ReturnType<typeof useWslProjects>;
  const pending: { resolve: (path: string) => void; reject: (error: Error) => void }[] = [];
  vi.mocked(connectWslProject).mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  function Fixture() { hook = useWslProjects("/native", select);return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => hook.onSelectProjects(["//wsl.localhost/Ubuntu/x", "//wsl.localhost/Debian/y", "/native/z"]));
    await act(async () => pending[0].resolve("//wsl.localhost/Ubuntu/cx"));
    await act(async () => pending[1].reject(new Error("bridge unavailable")));
    expect(select).toHaveBeenCalledExactlyOnceWith(["//wsl.localhost/Ubuntu/cx"], true);
    expect(hook.wslOpening?.error).toContain("bridge unavailable");
    expect(hook.wslOpening?.queue).toEqual(["//wsl.localhost/Debian/y", "/native/z"]);
    expect(hook.wslOpening?.blankReuse).toBe(false);
    select.mockClear();
    await act(async () => hook.onSelectProjects(hook.wslOpening!.queue!, hook.wslOpening!.blankReuse));
    await act(async () => pending[2].resolve("//wsl.localhost/Debian/cy"));
    expect(select).toHaveBeenCalledExactlyOnceWith(["//wsl.localhost/Debian/cy", "/native/z"], false);
    expect(hook.wslOpening).toBeNull();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("abandons an attached manual retry when switching to a native session", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const cwd = "//wsl.localhost/Ubuntu/retry";
  let hook!: ReturnType<typeof useWslProjects>;
  let finish!: (path: string) => void;
  vi.mocked(connectWslProject).mockReset().mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  function Fixture({ cwd }: { cwd: string }) { hook = useWslProjects(cwd, vi.fn()); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture, { cwd })));
    await act(async () => hook.retryOpening());
    const signal = vi.mocked(connectWslProject).mock.calls[1][1];
    await act(async () => root.render(createElement(Fixture, { cwd: "/native" })));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish("//wsl.localhost/Ubuntu/different"));
    expect(hook.wslOpening).toBeNull();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("keeps recovered catalogs when a stale disconnect event arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(listen).mockClear();
  vi.mocked(invalidateWslDiscovery).mockClear();
  vi.mocked(invoke).mockResolvedValue(true);
  setWslStatus("Recovered", { state: "connected" });
  function Fixture() { useWslProjects("/native", vi.fn()); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Fixture)));
    const onDisconnect = vi.mocked(listen).mock.calls.find(([event]) => event === "wsl:disconnected")![1];
    await act(async () => onDisconnect({ event: "wsl:disconnected", id: 1, payload: "Recovered" }));
    expect(invalidateWslDiscovery).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
