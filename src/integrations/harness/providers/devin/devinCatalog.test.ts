import { beforeEach, expect, it, vi } from "vitest";
import { modelCatalogError, modelsFor, resetHarnessModelOverlays } from "../../../../features/sessions/model/models.ts";
import { DEVIN_CLIENT_CAPABILITIES, DEVIN_CLIENT_INFO } from "./devinProtocol.ts";

const wire = vi.hoisted(() => ({
  listeners: new Map<string, (line: string) => void>(),
  sent: [] as { child: string; id?: string | number; method?: string; params?: any; result?: any; error?: any }[],
  cli: "",
  failSession: false,
}));
vi.mock("../../../../platform/tauri/fs.ts", () => ({ homeDir: async () => "/home/me" }));
vi.mock("../../core/child.ts", () => ({
  resolveDevinBinary: vi.fn(async (_cwd?: string) => ({ path: "/fake/devin" })),
  execChild: vi.fn(async () => wire.cli),
  spawnChild: vi.fn(async () => undefined),
  killChild: vi.fn(async () => undefined),
  unwatchChild: vi.fn((id: string) => wire.listeners.delete(id)),
  watchChild: (id: string, line: (line: string) => void) => wire.listeners.set(id, line),
  writeChild: async (child: string, line: string) => {
    const message = JSON.parse(line);
    wire.sent.push({ child, ...message });
    if (!message.method || message.id == null) return;
    const push = (value: unknown) => wire.listeners.get(child)?.(JSON.stringify(value));
    if (message.method === "initialize") {
      for (const method of ["_cognition.ai/request_diagnostics", "session/request_permission", "elicitation/create", "unsupported/request"]) {
        push({ jsonrpc: "2.0", id: method, method, params: {} });
      }
    }
    queueMicrotask(() => push({ jsonrpc: "2.0", id: message.id,
      ...(wire.failSession && message.method === "session/new"
        ? { error: { code: -32000, message: "probe failed" } }
        : { result: message.method === "session/new" ? {
          sessionId: "probe-session", configOptions: [{ id: "model", category: "model", currentValue: "swe-2",
            options: [{ value: "swe-2", name: "SWE 2" }] }],
        } : {} }),
    }));
  },
}));
import { execChild, killChild, resolveDevinBinary, spawnChild, unwatchChild } from "../../core/child.ts";
import { refreshDevinCatalog } from "./devinCatalog.ts";

beforeEach(() => {
  resetHarnessModelOverlays();
  vi.clearAllMocks();
  wire.listeners.clear();
  wire.sent.length = 0;
  wire.cli = "";
  wire.failSession = false;
});

it("uses CLI discovery first", async () => {
  wire.cli = JSON.stringify({ families: [{ slug: "swe-2", variants: [{ model_uid: "swe-2-high", label: "SWE 2 High" }] }] });
  await refreshDevinCatalog();
  expect(execChild).toHaveBeenCalledWith("/fake/devin", ["models", "list", "--format", "json"], "/home/me", "devin");
  expect(modelsFor("devin").some((model) => model.nativeId === "swe-2-high")).toBe(true);
  expect(spawnChild).not.toHaveBeenCalled();
});

it("probes models with the compatible ACP handshake", async () => {
  await refreshDevinCatalog();
  const starts = vi.mocked(spawnChild).mock.calls;
  expect(starts).toHaveLength(1);
  expect(starts.map((args) => args[3]).sort()).toEqual(["/home/me"]);
  for (const [id, path, args, cwd, , provider] of starts) {
    expect([path, args, provider]).toEqual(["/fake/devin", ["acp"], "devin"]);
    const requests = wire.sent.filter((message) => message.child === id);
    expect(requests.find((message) => message.method === "initialize")?.params)
      .toMatchObject({ clientInfo: DEVIN_CLIENT_INFO, clientCapabilities: DEVIN_CLIENT_CAPABILITIES });
    expect(requests.find((message) => message.method === "session/new")?.params.cwd).toBe(cwd);
    expect(requests.find((message) => message.id === "_cognition.ai/request_diagnostics")?.result).toEqual({});
    expect(requests.find((message) => message.id === "session/request_permission")?.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(requests.find((message) => message.id === "elicitation/create")?.result).toEqual({ action: "cancel" });
    expect(requests.find((message) => message.id === "unsupported/request")?.error.code).toBe(-32601);
    expect(unwatchChild).toHaveBeenCalledWith(id);
    expect(killChild).toHaveBeenCalledWith(id);
  }
  expect(modelsFor("devin").some((model) => model.nativeId === "swe-2")).toBe(true);
});

it("coalesces probes and cleans up failures without replacing a catalog", async () => {
  const first = refreshDevinCatalog();
  expect(refreshDevinCatalog()).toBe(first);
  await first;
  const before = modelsFor("devin");
  wire.failSession = true;
  await refreshDevinCatalog();
  expect(modelsFor("devin")).toEqual(before);
  expect(modelCatalogError("devin")).toMatch(/probe failed/);
  expect(wire.listeners.size).toBe(0);
  expect(killChild).toHaveBeenCalledTimes(2);
});
