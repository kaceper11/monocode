import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  __wslDistributionsReset,
  connectWslProject,
  wslDistributions,
  wslDistributionsPeek,
} from "./wsl";
import { wslStatusFor } from "./wslStatus";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  __wslDistributionsReset();
});

it("opens only the selected distribution and preserves cancellation and errors", async () => {
  const path = "//wsl.localhost/Ubuntu Work/home/me/Zażółć Repo";
  vi.mocked(invoke).mockResolvedValue({
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
  vi.mocked(invoke).mockResolvedValue({
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
  vi.mocked(invoke).mockRejectedValue(new Error("Distribution stopped"));
  await expect(connectWslProject(path)).rejects.toThrow("Distribution stopped");
  expect(wslStatusFor("Ubuntu Work")).toMatchObject({
    state: "error",
    error: "Error: Distribution stopped",
  });
  vi.mocked(invoke).mockResolvedValue({
    distribution: "Ubuntu Work",
    path: "/real/project",
  });
  await expect(connectWslProject(path)).resolves.toBe(
    "//wsl.localhost/Ubuntu Work/real/project",
  );
  const controller = new AbortController();
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = connectWslProject(path, controller.signal);
  controller.abort();
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
  vi.mocked(invoke).mockResolvedValue(["Ubuntu", "Debian"]);
  expect(await wslDistributions()).toEqual(["Ubuntu", "Debian"]);
  expect(await wslDistributions()).toEqual(["Ubuntu", "Debian"]);
  expect(wslDistributionsPeek()).toEqual(["Ubuntu", "Debian"]);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("wsl_distributions");
});

it("refresh re-probes", async () => {
  vi.mocked(invoke).mockResolvedValue(["Ubuntu"]);
  await wslDistributions(true);
  expect(wslDistributionsPeek()).toEqual(["Ubuntu"]);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("a failed probe is not retained", async () => {
  vi.mocked(invoke).mockResolvedValue(["Ubuntu"]);
  await wslDistributions();
  vi.mocked(invoke).mockRejectedValueOnce(new Error("wsl.exe unavailable"));
  await expect(wslDistributions(true)).rejects.toThrow("wsl.exe unavailable");
  // The last good value remains visible while the next call re-probes.
  expect(wslDistributionsPeek()).toEqual(["Ubuntu"]);
  vi.mocked(invoke).mockResolvedValue([]);
  expect(await wslDistributions(true)).toEqual([]);
  expect(invoke).toHaveBeenCalledTimes(3);
});

it("an expired value re-probes", async () => {
  vi.mocked(invoke).mockResolvedValue(["Ubuntu"]);
  await wslDistributions();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 60_000);
    vi.mocked(invoke).mockResolvedValue(["Ubuntu", "Debian"]);
    expect(await wslDistributions()).toEqual(["Ubuntu", "Debian"]);
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("dedupes concurrent in-flight probes", async () => {
  let finish!: (value: string[]) => void;
  vi.mocked(invoke).mockImplementation(
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
  vi.mocked(invoke).mockImplementation(
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
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const old = connectWslProject("//wsl.localhost/Ubuntu/old");
  const rejected = expect(old).rejects.toThrow("old request");
  vi.mocked(invoke).mockResolvedValueOnce({ distribution: "Ubuntu", path: "/new", generation: 2 });
  await connectWslProject("//wsl.localhost/Ubuntu/new");
  fail(new Error("old request"));
  await rejected;
  expect(wslStatusFor("Ubuntu").state).toBe("connected");
});
