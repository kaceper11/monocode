import { currentHarnessTiming, markHarnessTiming, measureHarnessTiming, timingWriteKind } from "./timing";

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  runtimeProviderBinaryPath,
  type ConfigurableBinaryProvider,
} from "../../../features/providers/model/providerBinaryPaths";

/** Process I/O is supplied by the desktop or a headless host. Provider
 * protocols never need to know which process owns their children. */
export interface ChildBackend {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<UnlistenFn>;
}

let backend: ChildBackend | undefined;

export function configureChildBackend(next: ChildBackend): void {
  if (bridge || users)
    throw new Error("Configure the child backend before starting the bridge");
  backend = next;
}

export function hasHeadlessChildBackend(): boolean {
  return backend !== undefined;
}

/** Provider-owned transcript files are read on the machine running the child. */
export function readHarnessTextFile(path: string): Promise<string> {
  return invoke<string>(backend ? "harness_read_text_file" : "read_text_file", {
    path,
  });
}

function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return backend
    ? backend.invoke<T>(command, args)
    : tauriInvoke<T>(command, args);
}

function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  return backend ? backend.listen(event, handler) : tauriListen(event, handler);
}

type LinePayload = { sessionId: string; generation: number; line: string };
type ExitPayload = {
  sessionId: string;
  code: number | null;
  generation: number;
  pid?: number;
};
type SsePayload = { sessionId: string; generation: number; data: string };
type SseEndPayload = {
  sessionId: string;
  generation: number;
  error?: string | null;
};

type LineHandler = (line: string) => void;
type ExitHandler = (code: number | null) => void;
type SseHandler = (data: string) => void;
type SseEndHandler = (error?: string) => void;

const lineHandlers = new Map<string, LineHandler>();
const exitHandlers = new Map<string, ExitHandler>();
const lineBuffer = new Map<string, string[]>();
const stderrHandlers = new Map<string, LineHandler>();
const sseHandlers = new Map<string, SseHandler>();
const sseEndHandlers = new Map<string, SseEndHandler>();
const sseBuffer = new Map<string, string[]>();
// Output is broadcast to every window. Only ids this window spawned or opened
// may buffer while unwatched; anything else would be held until the bridge
// is torn down, since nothing here ever watches or unwatches it.
const ownedChildren = new Set<string>();
const ownedSse = new Set<string>();
const livePid = new Map<string, number>();
const childGeneration = new Map<string, number>();
const sseGeneration = new Map<string, number>();
const stopping = new Map<string, Promise<void>>();
let nextGeneration = Date.now() * 1000;
let stoppingAll: Promise<void> | undefined;
const writes = new Map<
  string,
  {
    generation: number;
    tail: Promise<void>;
    count: number;
    bytes: number;
    failed: boolean;
  }
>();
const WRITE_TIMEOUT_MS = 10_000;
const MAX_PENDING_WRITES = 128;
const MAX_PENDING_WRITE_BYTES = 64 * 1024 * 1024;
const pendingExit = new Map<
  string,
  Array<{ code: number | null; pid: number }>
>();

/** True when this exit belongs to the child we currently have spawned. */
export function isCurrentChildExit(
  expectedPid: number | undefined,
  exitedPid: number | undefined,
): boolean {
  if (expectedPid == null || expectedPid <= 0) return false;
  if (exitedPid == null || exitedPid <= 0) return false;
  return exitedPid === expectedPid;
}

const MAX_BUFFERED = 1000;
let bridge: Promise<UnlistenFn[]> | null = null;
let bridgeAttempt: symbol | null = null;
let users = 0;
let teardownTimer: ReturnType<typeof setTimeout> | undefined;

function pushBounded(
  map: Map<string, string[]>,
  sessionId: string,
  item: string,
) {
  const queued = map.get(sessionId) ?? [];
  queued.push(item);
  let retained = 0;
  let start = queued.length;
  while (start > 0 && queued.length - start < MAX_BUFFERED) {
    const size = queued[start - 1].length * 2;
    if (retained + size > 64 * 1024 * 1024) break;
    retained += size;
    start -= 1;
  }
  if (start > 0) queued.splice(0, start);
  map.set(sessionId, queued);
}

function ensureBridge() {
  if (bridge) return;
  let failed = false;
  const installed: UnlistenFn[] = [];
  const register = (pending: Promise<UnlistenFn>) =>
    pending.then((unlisten) => {
      if (failed) {
        unlisten();
        return () => undefined;
      }
      installed.push(unlisten);
      return unlisten;
    });
  const attempt = Symbol("bridge-installation");
  bridgeAttempt = attempt;
  const installation = Promise.all([
    register(
      listen<LinePayload>("harness-stdout", (event) => {
        const { sessionId, generation, line } = event.payload;
        if (childGeneration.get(sessionId) !== generation) return;
        const handler = lineHandlers.get(sessionId);
        if (handler) {
          markHarnessTiming(currentHarnessTiming(sessionId), "firstStdout");
          handler(line);
          return;
        }
        if (ownedChildren.has(sessionId)) {
          pushBounded(lineBuffer, sessionId, line);
        }
      }),
    ),
    register(
      listen<LinePayload>("harness-stderr", (event) => {
        const { sessionId, generation, line } = event.payload;
        if (childGeneration.get(sessionId) !== generation) return;
        stderrHandlers.get(sessionId)?.(line);
      }),
    ),
    register(
      listen<ExitPayload>("harness-exit", (event) => {
        const { sessionId, generation, code, pid } = event.payload;
        if (childGeneration.get(sessionId) !== generation) return;
        const handler = exitHandlers.get(sessionId);
        if (!handler || pid == null || pid <= 0) return;
        const currentPid = livePid.get(sessionId);
        if (isCurrentChildExit(currentPid, pid)) {
          livePid.delete(sessionId);
          handler(code);
          return;
        }
        if (currentPid != null) return;
        const exits = pendingExit.get(sessionId) ?? [];
        exits.push({ code, pid });
        if (exits.length > 8) exits.splice(0, exits.length - 8);
        pendingExit.set(sessionId, exits);
      }),
    ),
    register(
      listen<SsePayload>("harness-sse", (event) => {
        const { sessionId, generation, data } = event.payload;
        if (sseGeneration.get(sessionId) !== generation) return;
        const handler = sseHandlers.get(sessionId);
        if (handler) {
          handler(data);
          return;
        }
        if (ownedSse.has(sessionId)) pushBounded(sseBuffer, sessionId, data);
      }),
    ),
    register(
      listen<SseEndPayload>("harness-sse-end", (event) => {
        const { sessionId, generation, error } = event.payload;
        if (sseGeneration.get(sessionId) !== generation) return;
        sseEndHandlers.get(sessionId)?.(error ?? undefined);
      }),
    ),
  ]).catch((error: unknown) => {
    failed = true;
    installed.splice(0).forEach((unlisten) => unlisten());
    if (bridgeAttempt === attempt) {
      bridge = null;
      bridgeAttempt = null;
    }
    throw error;
  });
  void installation.catch(() => undefined);
  bridge = installation;
}

function teardownBridge() {
  const pending = bridge;
  bridge = null;
  bridgeAttempt = null;
  lineHandlers.clear();
  exitHandlers.clear();
  lineBuffer.clear();
  stderrHandlers.clear();
  sseHandlers.clear();
  sseEndHandlers.clear();
  sseBuffer.clear();
  childGeneration.clear();
  sseGeneration.clear();
  writes.clear();
  ownedChildren.clear();
  ownedSse.clear();
  livePid.clear();
  pendingExit.clear();
  void pending?.then((fns) => fns.forEach((fn) => fn())).catch(() => undefined);
}

export function startHarnessBridge(): () => void {
  users += 1;
  if (teardownTimer) {
    clearTimeout(teardownTimer);
    teardownTimer = undefined;
  }
  ensureBridge();
  return () => {
    users -= 1;
    if (users > 0) return;
    users = 0;
    teardownTimer = setTimeout(() => {
      teardownTimer = undefined;
      if (users === 0) teardownBridge();
    }, 0);
  };
}

export async function acquireHarnessBridge(): Promise<() => void> {
  const release = startHarnessBridge();
  const installation = bridge;
  try {
    await installation;
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    users = 0;
    if (teardownTimer) {
      clearTimeout(teardownTimer);
      teardownTimer = undefined;
    }
    teardownBridge();
  });
}

export function watchChild(
  sessionId: string,
  onLine: LineHandler,
  onExit: ExitHandler,
  onStderr?: LineHandler,
) {
  const queued = lineBuffer.get(sessionId);
  lineBuffer.delete(sessionId);
  lineHandlers.set(sessionId, onLine);
  exitHandlers.set(sessionId, onExit);
  if (onStderr) stderrHandlers.set(sessionId, onStderr);
  if (queued) queued.forEach(onLine);
}

export function unwatchChild(sessionId: string) {
  lineHandlers.delete(sessionId);
  exitHandlers.delete(sessionId);
  lineBuffer.delete(sessionId);
  ownedChildren.delete(sessionId);
  stderrHandlers.delete(sessionId);
  pendingExit.delete(sessionId);
}

export function watchSse(
  sessionId: string,
  onData: SseHandler,
  onEnd?: SseEndHandler,
) {
  const queued = sseBuffer.get(sessionId);
  sseBuffer.delete(sessionId);
  sseHandlers.set(sessionId, onData);
  if (onEnd) sseEndHandlers.set(sessionId, onEnd);
  if (queued) queued.forEach(onData);
}

export function unwatchSse(sessionId: string) {
  sseHandlers.delete(sessionId);
  sseEndHandlers.delete(sessionId);
  sseBuffer.delete(sessionId);
  ownedSse.delete(sessionId);
}

export async function spawnChild(
  sessionId: string,
  command: string,
  args: string[],
  cwd: string,
  account?: { provider: "claude" | "codex"; id: string },
  binaryProvider?: ConfigurableBinaryProvider,
): Promise<void> {
  const generation = ++nextGeneration;
  childGeneration.set(sessionId, generation);
  livePid.delete(sessionId);
  pendingExit.delete(sessionId);
  ownedChildren.add(sessionId);
  const binaryPath = binaryProvider
    ? runtimeProviderBinaryPath(binaryProvider)
    : undefined;
  lineBuffer.delete(sessionId);
  writes.delete(sessionId);
  await stoppingAll;
  await stopping.get(sessionId);
  if (childGeneration.get(sessionId) !== generation)
    throw new Error("Harness startup cancelled");
  let pid: number;
  try {
    pid = await measureHarnessTiming(currentHarnessTiming(sessionId), "spawn", () => invoke<number>("harness_spawn", {
      sessionId,
      generation,
      command,
      args,
      cwd,
      account,
      binaryProvider,
      binaryPath,
    }));
  } catch (error) {
    if (childGeneration.get(sessionId) === generation)
      childGeneration.delete(sessionId);
    throw error;
  }
  if (childGeneration.get(sessionId) !== generation)
    throw new Error("Harness startup cancelled");
  if (typeof pid !== "number" || pid <= 0)
    throw new Error("Harness did not return a process ID");
  livePid.set(sessionId, pid);
  const exits = pendingExit.get(sessionId);
  pendingExit.delete(sessionId);
  const exited = exits?.find((event) => event.pid === pid);
  if (!exited) return;
  livePid.delete(sessionId);
  exitHandlers.get(sessionId)?.(exited.code);
}

/** Ordered and bounded before IPC, so a stalled pipe cannot queue unbounded native jobs. */
export function writeChild(
  sessionId: string,
  line: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new Error("Harness write cancelled"));
  const generation = childGeneration.get(sessionId);
  if (generation == null)
    return Promise.reject(new Error("Harness process is not running"));
  let queue = writes.get(sessionId);
  if (!queue || queue.generation !== generation) {
    queue = {
      generation,
      tail: Promise.resolve(),
      count: 0,
      bytes: 0,
      failed: false,
    };
    writes.set(sessionId, queue);
  }
  const bytes = line.length * 2;
  if (
    queue.failed ||
    queue.count >= MAX_PENDING_WRITES ||
    queue.bytes + bytes > MAX_PENDING_WRITE_BYTES
  ) {
    return Promise.reject(
      new Error("Harness input queue is full or unavailable"),
    );
  }
  queue.count += 1;
  queue.bytes += bytes;
  const owned = queue;
  const timing = currentHarnessTiming(sessionId);
  const kind = timing ? timingWriteKind(line) : "control";
  const write = measureHarnessTiming(timing, `writeQueue:${kind}`, () => owned.tail).then(async () => {
    if (
      signal?.aborted ||
      owned.failed ||
      childGeneration.get(sessionId) !== generation
    )
      throw new Error("Harness write cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      markHarnessTiming(timing, `${kind}WriteStarted`);
      await Promise.race([
        measureHarnessTiming(timing, `write:${kind}`, () => invoke<void>("harness_write", { sessionId, generation, line })),
        new Promise<never>((_resolve, reject) => {
          onAbort = () =>
            reject(new Error("Harness write cancelled; delivery is unknown"));
          signal?.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(
            () =>
              reject(new Error("Harness write timed out; delivery is unknown")),
            WRITE_TIMEOUT_MS,
          );
        }),
      ]);
      markHarnessTiming(timing, `${kind}Written`);
    } catch (error) {
      owned.failed = true;
      if (childGeneration.get(sessionId) === generation) {
        void killChild(sessionId).catch(() => undefined);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  });
  const settled = write.finally(() => {
    owned.count -= 1;
    owned.bytes -= bytes;
  });
  owned.tail = settled.catch(() => undefined);
  return settled;
}

export function killChild(sessionId: string): Promise<void> {
  const generation = ++nextGeneration;
  childGeneration.delete(sessionId);
  sseGeneration.delete(sessionId);
  livePid.delete(sessionId);
  writes.delete(sessionId);
  pendingExit.delete(sessionId);
  unwatchChild(sessionId);
  const pending = invoke<void>("harness_kill", { sessionId, generation });
  stopping.set(sessionId, pending);
  const cleanup = () => {
    if (stopping.get(sessionId) === pending) stopping.delete(sessionId);
  };
  void pending.then(cleanup, cleanup);
  return pending;
}

export function killAllChildren(): Promise<void> {
  lineHandlers.clear();
  exitHandlers.clear();
  lineBuffer.clear();
  stderrHandlers.clear();
  sseHandlers.clear();
  sseEndHandlers.clear();
  sseBuffer.clear();
  childGeneration.clear();
  sseGeneration.clear();
  writes.clear();
  ownedChildren.clear();
  ownedSse.clear();
  livePid.clear();
  pendingExit.clear();
  const pending = invoke<void>("harness_kill_all", {
    generation: ++nextGeneration,
  });
  stoppingAll = pending;
  const cleanup = () => {
    if (stoppingAll === pending) stoppingAll = undefined;
  };
  void pending.then(cleanup, cleanup);
  return pending;
}

type ResolvedHarnessBinary = { path: string; args?: string[] };

async function resolveHarnessBinary(
  provider: ConfigurableBinaryProvider,
  binaryPath?: string | null,
): Promise<ResolvedHarnessBinary> {
  const configuredPath =
    binaryPath === undefined
      ? runtimeProviderBinaryPath(provider)
      : binaryPath?.trim();
  if (configuredPath) {
    return invoke("harness_resolve_configured", {
      provider,
      binaryPath: configuredPath,
    });
  }
  const command: Record<ConfigurableBinaryProvider, string> = {
    claude: "harness_resolve_claude",
    codex: "harness_resolve_codex",
    cursor: "harness_resolve_cursor",
    grok: "harness_resolve_grok",
    opencode: "harness_resolve_opencode",
    pi: "harness_resolve_pi",
    omp: "harness_resolve_omp",
    fx: "harness_resolve_fx",
    hermes: "harness_resolve_hermes",
    antigravity: "harness_resolve_antigravity",
    devin: "harness_resolve_devin",
    copilot: "harness_resolve_copilot",
    muse: "harness_resolve_muse",
  };
  return invoke(command[provider]);
}

export function resolveCursorBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("cursor", binaryPath);
}

export function resolveCodexBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("codex", binaryPath);
}

export function resolveOpenCodeBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("opencode", binaryPath);
}

export function resolveClaudeBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("claude", binaryPath);
}

export function resolvePiBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("pi", binaryPath);
}

export function resolveOmpBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("omp", binaryPath);
}

export function resolveFxBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("fx", binaryPath);
}

export function resolveHermesBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("hermes", binaryPath);
}

export function resolveGrokBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("grok", binaryPath);
}

export function resolveDevinBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("devin", binaryPath);
}

export function resolveCopilotBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("copilot", binaryPath);
}

export function resolveMuseBinary(binaryPath?: string | null): Promise<{ path: string }> {
  return resolveHarnessBinary("muse", binaryPath);
}

export function resolveAntigravityBinary(binaryPath?: string | null): Promise<{ path: string; args: string[] }> {
  return resolveHarnessBinary("antigravity", binaryPath) as Promise<{ path: string; args: string[] }>;
}

export function freeHarnessPort(): Promise<number> {
  return invoke("harness_free_port");
}

export function harnessHttp(input: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<{ status: number; body: string }> {
  return invoke("harness_http", input);
}

export async function openHarnessSse(
  sessionId: string,
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  const generation = ++nextGeneration;
  sseGeneration.set(sessionId, generation);
  ownedSse.add(sessionId);
  await stoppingAll;
  await stopping.get(sessionId);
  if (sseGeneration.get(sessionId) !== generation)
    throw new Error("Event stream startup cancelled");
  return invoke("harness_sse_open", { sessionId, generation, url, headers });
}

export function closeHarnessSse(sessionId: string): Promise<void> {
  const generation = ++nextGeneration;
  sseGeneration.delete(sessionId);
  unwatchSse(sessionId);
  return invoke("harness_sse_close", { sessionId, generation });
}

export type HarnessBinaryInspection = {
  path: string;
  version?: string;
  error?: string;
};

export function inspectHarnessBinary(
  provider: ConfigurableBinaryProvider,
  binaryPath?: string | null,
): Promise<HarnessBinaryInspection> {
  return resolveHarnessBinary(provider, binaryPath).then(async (resolved) => {
    if (provider === "antigravity") {
      return { path: resolved.path, version: "ACP server" };
    }
    try {
      const version = (
        await execChild(
          resolved.path,
          ["--version"],
          undefined,
          provider,
          binaryPath,
        )
      ).trim();
      return /\d+\.\d+\.\d+/.test(version)
        ? { path: resolved.path, version }
        : { path: resolved.path, error: "CLI returned no valid version." };
    } catch (error) {
      return {
        path: resolved.path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** Runs the CLI's own self-update against the binary MonoCode uses. */
export async function updateHarnessCli(
  provider: ConfigurableBinaryProvider,
): Promise<void> {
  const resolved = await resolveHarnessBinary(provider);
  await invoke("harness_update", {
    command: resolved.path,
    binaryProvider: provider,
    binaryPath: runtimeProviderBinaryPath(provider),
  });
}

export function execChild(
  command: string,
  args: string[],
  cwd?: string,
  binaryProvider?: ConfigurableBinaryProvider,
  binaryPathOverride?: string | null,
): Promise<string> {
  const binaryPath =
    binaryPathOverride === undefined && binaryProvider
      ? runtimeProviderBinaryPath(binaryProvider)
      : binaryPathOverride;
  return invoke("harness_exec", {
    command,
    args,
    cwd,
    binaryProvider,
    binaryPath,
  });
}
