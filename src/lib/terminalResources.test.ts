import { beforeEach, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  runs: [] as { terminalId: string; status: string }[],
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("./savedCommandRun", () => ({
  savedCommandRunsSnapshot: () => bridge.runs,
  stopSavedCommandRun: bridge.stop,
}));
import {
  footerTerminals,
  sampleTerminalResources,
  stopTerminalWorkload,
} from "./terminalResources";
import type { ProjectTerminalDock } from "./projectTerminal";
import type { WorkspaceTab } from "./layout";
beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.stop.mockReset();
  bridge.runs = [];
});
it("lists only the current project dock plus workspace terminal panes, once each", () => {
  const terminal = (id: string) => ({
    id,
    terminal: true,
    cwd: "/repo",
    path: id,
  });
  const docks = [
    { projectPath: "/repo", pane: { files: [terminal("dock")] } },
    { projectPath: "/other", pane: { files: [terminal("other")] } },
  ] as ProjectTerminalDock[];
  const tabs = [
    {
      terminalPanes: [
        {
          id: "pane",
          files: [
            terminal("workspace"),
            terminal("dock"),
            { id: "file", cwd: "/repo", path: "file" },
          ],
        },
      ],
    },
  ] as WorkspaceTab[];
  const rows = footerTerminals(docks, tabs, "/repo");
  expect(rows.map((row) => [row.id, row.paneId])).toEqual([
    ["dock", undefined],
    ["workspace", "pane"],
  ]);
});
it("serializes samples and discards a waiter closed before dispatch", async () => {
  let resolve!: (value: never[]) => void;
  bridge.invoke
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue([]);
  const first = sampleTerminalResources(["a"], () => true);
  let active = true;
  const second = sampleTerminalResources(["b"], () => active);
  const third = sampleTerminalResources(["c"], () => true);
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
  active = false;
  resolve([]);
  expect(await first).toEqual([]);
  expect(await second).toBeNull();
  expect(await third).toEqual([]);
  expect(bridge.invoke.mock.calls).toEqual([
    ["pty_resources", { ids: ["a"] }],
    ["pty_resources", { ids: ["c"] }],
  ]);
});
it("cancels the saved sequence even if it completes while a sample is pending", async () => {
  let resolve!: (value: never[]) => void;
  bridge.invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const sample = sampleTerminalResources(["term"], () => true);
  bridge.runs = [{ terminalId: "term", status: "running" }];
  bridge.stop.mockResolvedValue(undefined);
  const stop = stopTerminalWorkload(
    { id: "term", generation: "spawn" },
    () => true,
  );
  bridge.runs = [{ terminalId: "term", status: "completed" }];
  resolve([]);
  await sample;
  await stop;
  expect(bridge.stop).toHaveBeenCalledWith("term");
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
});
it("binds ordinary stops to the sampled spawn and reports failures without retry", async () => {
  bridge.invoke.mockRejectedValueOnce(new Error("identity changed"));
  await expect(
    stopTerminalWorkload({ id: "term", generation: "spawn-a" }, () => true),
  ).rejects.toThrow("identity changed");
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("pty_kill_workload", {
    id: "term",
    generation: "spawn-a",
  });
  await expect(
    stopTerminalWorkload({ id: "term", generation: null }, () => true),
  ).rejects.toThrow("identity is unavailable");
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
});
