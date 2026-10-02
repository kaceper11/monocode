import { afterEach, expect, it, vi } from "vitest";
import { refreshCodexCatalog } from "../providers/codex/codexCatalog.ts";
import {
  resetHarnessModelOverlays,
} from "../../../features/sessions/model/models.ts";

const mock = vi.hoisted(() => ({
  lines: new Map<string, (line: string) => void>(),
  hosts: new Map<string, string>(),
  spawn: vi.fn(),
  resolve: vi.fn(),
  kill: vi.fn(),
}));
vi.mock("../../../platform/tauri/fs.ts", () => ({ homeDir: async () => "/native-home" }));
vi.mock("./child", () => ({
  resolveCodexBinary: async (cwd?: string) => {
    mock.resolve(cwd);
    return { path: "/linux/codex" };
  },
  watchChild: (id: string, line: (value: string) => void) =>
    mock.lines.set(id, line),
  unwatchChild: (id: string) => mock.lines.delete(id),
  killChild: async (id: string) => {
    mock.kill(id);
  },
  spawnChild: async (
    id: string,
    command: string,
    args: string[],
    cwd: string,
  ) => {
    mock.spawn(id, command, args, cwd);
    mock.hosts.set(id, cwd);
  },
  writeChild: async (id: string, text: string) => {
    const message = JSON.parse(text);
    if (message.id == null) return;
    const result =
      message.method === "model/list"
        ? {
            data: [
              {
                id: "shared",
                displayName: mock.hosts.get(id),
                supportedReasoningEfforts: ["low", "high"],
              },
            ],
          }
        : message.method === "account/read"
          ? { account: { type: "fixture" } }
          : {};
    queueMicrotask(() =>
      mock.lines.get(id)?.(JSON.stringify({ id: message.id, result })),
    );
  },
}));
afterEach(() => {
  resetHarnessModelOverlays();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("keeps native catalog probes in the upstream home directory", async () => {
  await refreshCodexCatalog();
  expect(mock.spawn.mock.calls[0][3]).toBe("/native-home");
  expect(mock.resolve).toHaveBeenCalledWith(undefined);
});
