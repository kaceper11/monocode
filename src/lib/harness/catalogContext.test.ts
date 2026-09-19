import { afterEach, expect, it, vi } from "vitest";
import { sessionWorkCwd } from "../session";
import { refreshCodexCatalog } from "./codexCatalog";
import {
  findModel,
  hasLiveCatalog,
  invalidateModelCatalogs,
  modelCatalogStatus,
  modelContextWindow,
  modelsFor,
  nativeModelId,
  preferredModelId,
  refreshModelCatalog,
  resetHarnessModelOverlays,
  resolveModel,
  saveDefaultModel,
  setHarnessModels,
  type AgentModel,
} from "../models";

const mock = vi.hoisted(() => ({
  lines: new Map<string, (line: string) => void>(),
  hosts: new Map<string, string>(),
  spawn: vi.fn(),
  resolve: vi.fn(),
  kill: vi.fn(),
}));
vi.mock("../fs", () => ({ homeDir: async () => "/native-home" }));
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
const ubuntu = "//wsl.localhost/Ubuntu/home/me/project";
const debian = "//wsl.localhost/Debian/home/me/project";
const model = (name: string): AgentModel => ({
  id: "codex:shared",
  harness: "codex",
  name,
  nativeId: name,
});
afterEach(() => {
  resetHarnessModelOverlays();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("probes simultaneous Linux projects through their own cwd and child identity", async () => {
  const first = refreshCodexCatalog(ubuntu);
  expect(refreshCodexCatalog(ubuntu)).toBe(first);
  await Promise.all([
    first,
    refreshCodexCatalog(debian),
    refreshCodexCatalog(`${ubuntu}/other`),
  ]);
  expect(mock.spawn).toHaveBeenCalledTimes(3);
  expect(new Set(mock.spawn.mock.calls.map(([id]) => id)).size).toBe(3);
  expect(mock.resolve.mock.calls.map(([cwd]) => cwd)).toEqual([
    ubuntu,
    debian,
    `${ubuntu}/other`,
  ]);
  expect(findModel("codex:shared", ubuntu)?.name).toBe(ubuntu);
  expect(findModel("codex:shared", debian)?.name).toBe(debian);
  expect(hasLiveCatalog("codex")).toBe(false);
  expect(mock.kill).toHaveBeenCalledTimes(3);
});

it("isolates lookups, defaults and late catalogs across reconnect", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  setHarnessModels("codex", [model("native")]);
  setHarnessModels("codex", [model("ubuntu")], ubuntu);
  setHarnessModels("codex", [model("debian")], debian);
  expect(resolveModel("codex", "codex:shared", ubuntu).name).toBe("ubuntu");
  expect(nativeModelId("codex:shared", ubuntu)).toBe("ubuntu");
  expect(findModel("codex:shared")?.name).toBe("native");
  saveDefaultModel("codex", "codex:linux-default", ubuntu);
  expect(preferredModelId("codex", ubuntu)).toBe("codex:linux-default");
  expect(preferredModelId("codex", debian)).not.toBe("codex:linux-default");
  let finish!: (models: AgentModel[]) => void;
  const pending = refreshModelCatalog(
    "codex",
    ubuntu,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  invalidateModelCatalogs(ubuntu);
  await refreshModelCatalog("codex", ubuntu, async () => [model("new")]);
  finish([model("stale")]);
  await pending;
  expect(modelsFor("codex", ubuntu)[0].name).toBe("new");
  expect(modelsFor("codex", debian)[0].name).toBe("debian");
  await refreshModelCatalog("codex", ubuntu, async () => {
    throw new Error("Login required");
  });
  expect(modelCatalogStatus("codex", ubuntu)).toContain("Login required");
  expect(modelsFor("codex", ubuntu)[0].name).toBe("new");
});

it("uses the effective worktree catalog for model identity and capacity", () => {
  const session = { cwd: ubuntu, worktreeCwd: `${ubuntu}-feature` };
  setHarnessModels(
    "codex",
    [{ ...model("root"), contextWindow: 1000 }],
    session.cwd,
  );
  setHarnessModels(
    "codex",
    [{ ...model("worktree"), contextWindow: 2000 }],
    session.worktreeCwd,
  );
  const cwd = sessionWorkCwd(session);
  expect(resolveModel("codex", "codex:shared", cwd).name).toBe("worktree");
  expect(nativeModelId("codex:shared", cwd)).toBe("worktree");
  expect(modelContextWindow("codex:shared", cwd)).toBe(2000);
});

it("does not evict the native catalog when many WSL projects are opened", () => {
  setHarnessModels("codex", [model("native")]);
  for (let i = 0; i < 40; i++) {
    setHarnessModels("codex", [model(`linux-${i}`)], `${ubuntu}-${i}`);
  }
  expect(hasLiveCatalog("codex")).toBe(true);
  expect(findModel("codex:shared")?.name).toBe("native");
});


it("keeps native catalog probes in the upstream home directory", async () => {
  await refreshCodexCatalog("/native-project");
  expect(mock.spawn.mock.calls[0][3]).toBe("/native-home");
  expect(mock.resolve).toHaveBeenCalledWith(undefined);
});

it("reserves native discovery capacity when all guest catalogs are busy", async () => {
  const finish: Array<() => void> = [];
  const pending: Promise<void>[] = [];
  for (let i = 0; i < 32; i++) {
    try {
      pending.push(refreshModelCatalog("codex", `${ubuntu}-${i}`, () => new Promise((resolve) => finish.push(() => resolve([model("guest")])))));
    } catch {
      // Reaching the bounded guest limit must not consume the native slot.
    }
  }
  try {
    await expect(Promise.resolve().then(() => refreshModelCatalog("codex", undefined, async () => [model("native")]))).resolves.toBeUndefined();
    expect(findModel("codex:shared")?.name).toBe("native");
  } finally {
    await Promise.resolve();
    finish.forEach((resolve) => resolve());
    await Promise.all(pending);
  }
});
