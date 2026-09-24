import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  __wslDistributionsReset,
  connectWslProject,
  wslDistributions,
  wslDistributionsPeek,
} from "./wsl";
import { setWslStatus, subscribeWslStatus, wslStatusFor } from "./wslStatus";
import { hasLiveCatalog, setHarnessModels } from "./models";

const { response, health } = vi.hoisted(() => ({ response: vi.fn(), health: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command, args) => command === "wsl_connected" ? health(args) : response(command, args)),
}));
beforeEach(() => {
  vi.mocked(invoke).mockClear();
  response.mockReset();
  health.mockReset().mockResolvedValue(false);
  for (const host of ["Ubuntu", "Ubuntu Work", "Debian"]) setWslStatus(host, { state: "unknown" });
  __wslDistributionsReset();
});

it("opens only the selected distribution and preserves cancellation and errors", async () => {
  const path = "//wsl.localhost/Ubuntu Work/home/me/Zażółć Repo";
  response.mockResolvedValue({
    distribution: "Ubuntu Work",
    path: "/real/Zażółć Repo",
  });
  await expect(connectWslProject(path)).resolves.toBe(
    "//wsl.localhost/Ubuntu Work/real/Zażółć Repo",
  );
  expect(invoke).toHaveBeenCalledWith("wsl_connect", {
    distribution: "Ubuntu Work",
    path: "/home/me/Zażółć Repo",
  });
  // The shared store tracks the connect for badges/banners.
  expect(wslStatusFor("Ubuntu Work").state).toBe("connected");
  response.mockResolvedValue({
    distribution: "Debian",
    path: "/real/project",
  });
  await expect(connectWslProject(path)).rejects.toThrow(
    "different distribution",
  );
  // A mismatched answer means the requested distro failed, the returned
  // one did connect.
  expect(wslStatusFor("Ubuntu Work").state).toBe("error");
  expect(wslStatusFor("Debian").state).toBe("connected");
  response.mockRejectedValue(new Error("Distribution stopped"));
  await expect(connectWslProject(path)).rejects.toThrow("Distribution stopped");
  expect(wslStatusFor("Ubuntu Work")).toMatchObject({
    state: "error",
    error: "Error: Distribution stopped",
  });
  response.mockResolvedValue({
    distribution: "Ubuntu Work",
    path: "/real/project",
  });
  await expect(connectWslProject(path)).resolves.toBe(
    "//wsl.localhost/Ubuntu Work/real/project",
  );
  const controller = new AbortController();
  let finish!: (value: unknown) => void;
  response.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = connectWslProject(path, controller.signal);
  controller.abort();
  await Promise.resolve();
  finish({ distribution: "Ubuntu Work", path: "/late/project" });
  await expect(pending).rejects.toThrow();
  // The link came up even though the caller walked away mid-request.
  expect(wslStatusFor("Ubuntu Work").state).toBe("connected");
  vi.mocked(invoke).mockClear();
  await expect(connectWslProject(path, controller.signal)).rejects.toThrow();
  await expect(connectWslProject("C:/native/project")).rejects.toThrow(
    "WSL distribution",
  );
  expect(invoke).not.toHaveBeenCalled();
});

it("memoizes the distribution probe and exposes the resolved list", async () => {
  response.mockResolvedValue(["Ubuntu", "Debian"]);
  expect(await wslDistributions()).toEqual(["Ubuntu", "Debian"]);
  expect(await wslDistributions()).toEqual(["Ubuntu", "Debian"]);
  expect(wslDistributionsPeek()).toEqual(["Ubuntu", "Debian"]);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("wsl_distributions");
});

it("refresh re-probes", async () => {
  response.mockResolvedValue(["Ubuntu"]);
  await wslDistributions(true);
  expect(wslDistributionsPeek()).toEqual(["Ubuntu"]);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("a failed probe is not retained", async () => {
  response.mockResolvedValue(["Ubuntu"]);
  await wslDistributions();
  response.mockRejectedValueOnce(new Error("wsl.exe unavailable"));
  await expect(wslDistributions(true)).rejects.toThrow("wsl.exe unavailable");
  // The last good value remains visible while the next call re-probes.
  expect(wslDistributionsPeek()).toEqual(["Ubuntu"]);
  response.mockResolvedValue([]);
  expect(await wslDistributions(true)).toEqual([]);
  expect(invoke).toHaveBeenCalledTimes(3);
});

it("an expired value re-probes", async () => {
  response.mockResolvedValue(["Ubuntu"]);
  await wslDistributions();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 60_000);
    response.mockResolvedValue(["Ubuntu", "Debian"]);
    expect(await wslDistributions()).toEqual(["Ubuntu", "Debian"]);
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("dedupes concurrent in-flight probes", async () => {
  let finish!: (value: string[]) => void;
  response.mockImplementation(
    () =>
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
  );
  const first = wslDistributions();
  const second = wslDistributions();
  finish(["Ubuntu"]);
  expect(await first).toEqual(["Ubuntu"]);
  expect(await second).toEqual(["Ubuntu"]);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("a superseded probe cannot overwrite a newer result", async () => {
  const resolves: Array<(value: string[]) => void> = [];
  response.mockImplementation(
    () =>
      new Promise<string[]>((resolve) => {
        resolves.push(resolve);
      }),
  );
  const slow = wslDistributions();
  const refresh = wslDistributions(true);
  resolves[1](["Debian"]);
  expect(await refresh).toEqual(["Debian"]);
  resolves[0](["Ubuntu"]);
  expect(await slow).toEqual(["Ubuntu"]);
  // The stale result is discarded — peek keeps the refresh's answer.
  expect(wslDistributionsPeek()).toEqual(["Debian"]);
});

it("does not let an older failed connection overwrite a newer success", async () => {
  let fail!: (error: Error) => void;
  response.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const old = connectWslProject("//wsl.localhost/Ubuntu/old");
  const rejected = expect(old).rejects.toThrow("old request");
  response.mockResolvedValueOnce({ distribution: "Ubuntu", path: "/new", generation: 2 });
  await connectWslProject("//wsl.localhost/Ubuntu/new");
  fail(new Error("old request"));
  await rejected;
  expect(wslStatusFor("Ubuntu").state).toBe("connected");
});

it("shares simultaneous project connections while cancellation belongs to each caller", async () => {
  const path = "//wsl.localhost/Ubuntu/shared";
  let finish!: (value: unknown) => void;
  response.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const abandoned = connectWslProject(path, controller.signal);
  const current = connectWslProject("//wsl$/ubuntu/shared");
  expect(invoke).toHaveBeenCalledTimes(1);
  controller.abort();
  finish({ distribution: "Ubuntu", path: "/shared", generation: 500 });
  await expect(abandoned).rejects.toThrow();
  await expect(current).resolves.toBe(path);
  expect(wslStatusFor("Ubuntu").state).toBe("connected");
});

it("keeps warm validation connected but publishes a real reconnect", async () => {
  setWslStatus("Ubuntu", { state: "connected" });
  health.mockResolvedValue(true);
  response.mockResolvedValue({ distribution: "Ubuntu", path: "/repo", generation: 800 });
  const states: string[] = [];
  const stop = subscribeWslStatus(() => states.push(wslStatusFor("Ubuntu").state));
  try {
    await connectWslProject("//wsl.localhost/Ubuntu/repo");
    expect(states).toEqual([]);
    setHarnessModels("codex", [{ id: "codex:warm", harness: "codex", name: "Warm" }], "//wsl.localhost/Ubuntu/repo");
    await connectWslProject("//wsl.localhost/Ubuntu/repo");
    expect(states).toEqual([]);
    expect(hasLiveCatalog("codex", "//wsl.localhost/Ubuntu/repo")).toBe(true);
    health.mockResolvedValue(false);
    response.mockResolvedValue({ distribution: "Ubuntu", path: "/repo", generation: 801 });
    await connectWslProject("//wsl.localhost/Ubuntu/repo");
    expect(states).toEqual(["connecting", "connected"]);
    expect(hasLiveCatalog("codex", "//wsl.localhost/Ubuntu/repo")).toBe(false);
    states.length = 0;
    health.mockResolvedValue(true);
    await connectWslProject("//wsl.localhost/Ubuntu/repo", undefined, true);
    expect(states).toEqual(["connecting", "connected"]);
  } finally { stop(); }
});

it("rejects a missing folder without disconnecting a healthy distribution", async () => {
  setWslStatus("Ubuntu", { state: "connected" });
  health.mockResolvedValue(true);
  response.mockRejectedValue(new Error("folder missing"));
  await expect(connectWslProject("//wsl.localhost/Ubuntu/missing")).rejects.toThrow("folder missing");
  expect(wslStatusFor("Ubuntu")).toEqual({ state: "connected" });
});
