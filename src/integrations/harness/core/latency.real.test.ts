// Opt-in native-protocol baseline: see docs/HARNESS_PERFORMANCE.md.
// Uses the real adapters with Node stdio in place of Tauri; normal checks skip it.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { HarnessId } from "../../../features/sessions/model/session";
import {
  bindHarnessTiming,
  currentHarnessTiming,
  finishHarnessTiming,
  markHarnessTiming,
  measureHarnessTiming,
  observeHarnessTiming,
  startHarnessTiming,
  timingWriteKind,
  type HarnessTiming,
} from "./timing";

const processes = new Map<string, ChildProcessWithoutNullStreams>();
const watchers = new Map<
  string,
  { line: (line: string) => void; exit: (code: number | null) => void }
>();
let command: string[];

vi.mock("./child", async (original) => ({
  ...(await original<typeof import("./child")>()),
  ...Object.fromEntries(
    ["Codex", "Claude", "Devin", "Copilot", "Omp", "Muse"].map((name) => [
      `resolve${name}Binary`,
      async () => ({ path: command[0] }),
    ]),
  ),
  watchChild: (
    id: string,
    line: (line: string) => void,
    exit: (code: number | null) => void,
  ) => watchers.set(id, { line, exit }),
  unwatchChild: (id: string) => watchers.delete(id),
  spawnChild: async (
    id: string,
    _path: string,
    args: string[],
    cwd: string,
  ) => {
    await measureHarnessTiming(
      currentHarnessTiming(id),
      "spawn",
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(command[0], [...command.slice(1), ...args], {
            cwd,
            stdio: "pipe",
            windowsHide: true,
            detached: process.platform !== "win32",
          });
          processes.set(id, child);
          child.once("error", reject);
          child.once("spawn", resolve);
          createInterface({ input: child.stdout }).on("line", (line) => {
            markHarnessTiming(currentHarnessTiming(id), "firstStdout");
            watchers.get(id)?.line(line);
          });
          // Drain without retaining potentially sensitive provider diagnostics.
          child.stderr.resume();
          child.once("close", (code) => {
            if (processes.get(id) === child) {
              processes.delete(id);
              watchers.get(id)?.exit(code);
            }
          });
        }),
    );
  },
  writeChild: async (id: string, line: string, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("cancelled");
    const child = processes.get(id);
    if (!child) throw new Error("Harness process is not running");
    const timing = currentHarnessTiming(id);
    const kind = timingWriteKind(line);
    markHarnessTiming(timing, `${kind}WriteStarted`);
    await measureHarnessTiming(
      timing,
      `write:${kind}`,
      () =>
        new Promise<void>((resolve, reject) => {
          child.stdin.write(`${line}\n`, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
    markHarnessTiming(timing, `${kind}Written`);
  },
  killChild: (id: string) => stopProcess(id),
}));

async function stopProcess(id: string): Promise<void> {
  const child = processes.get(id);
  if (!child) return;
  watchers.delete(id);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        // Only the process tree created by this measurement.
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => child.kill());
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, 1000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.end();
  });
  processes.delete(id);
}

it.skipIf(!process.env.MONOCODE_LATENCY_HARNESS)(
  "measures real cold, warm and resumed adapter turns",
  async () => {
    const harness = process.env.MONOCODE_LATENCY_HARNESS as HarnessId;
    expect(["codex", "claude", "devin", "copilot", "omp", "muse"]).toContain(
      harness,
    );
    command = JSON.parse(process.env.MONOCODE_LATENCY_COMMAND ?? "[]");
    expect(
      Array.isArray(command) &&
        command.length > 0 &&
        command.every((arg) => typeof arg === "string" && arg.length > 0),
    ).toBe(true);
    const cwd = process.env.MONOCODE_LATENCY_CWD;
    const model = process.env.MONOCODE_LATENCY_MODEL;
    if (!cwd || !model)
      throw new Error(
        "Set MONOCODE_LATENCY_CWD and MONOCODE_LATENCY_MODEL to match MonoCode.",
      );
    const modelSettings = JSON.parse(
      process.env.MONOCODE_LATENCY_SETTINGS ?? "{}",
    );
    const storage = new Map<string, string>([
      ["monocode.harnessTiming", "true"],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    const { registerBuiltinHarnesses } = await import("./register");
    const { requireHarness } = await import("./registry");
    registerBuiltinHarnesses();
    const adapter = requireHarness(harness);
    const samples: Array<{ case: string; timing: HarnessTiming }> = [];
    const ids: string[] = [];
    const output =
      process.env.MONOCODE_LATENCY_OUTPUT ??
      join(tmpdir(), `monocode-${harness}-latency-${Date.now()}.json`);
    try {
      for (let cold = 0; cold < 3; cold++) {
        const sessionId = `latency-${harness}-${Date.now()}-${cold}`;
        ids.push(sessionId);
        const run = async (name: string) => {
          const timing = startHarnessTiming({ harness, model, modelSettings })!;
          samples.push({ case: name, timing });
          const release = bindHarnessTiming(sessionId, timing);
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              adapter.sendTurn({
                sessionId,
                cwd,
                model,
                modelSettings,
                runtimeMode: "supervised",
                text: "Reply with exactly HI. Do not use tools.",
                attachments: [],
                onEvent(event) {
                  observeHarnessTiming(sessionId, timing, event);
                  if (event.type === "approval.requested")
                    adapter.respondApproval(sessionId, event.requestId, "deny");
                  if (event.type === "question.asked")
                    adapter.respondQuestion?.(sessionId, event.requestId, {
                      kind: "skipped",
                    });
                },
              }),
              new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(
                  () => reject(new Error("Latency sample exceeded 60 seconds")),
                  60_000,
                );
              }),
            ]);
            finishHarnessTiming(
              timing,
              timing.marks.providerError == null ? "completed" : "failed",
            );
            expect(timing.outcome).toBe("completed");
            expect(timing.marks.firstText).toBeTypeOf("number");
            console.log(
              `${harness} ${name}: first text ${Math.round(timing.marks.firstText)} ms, prompt delivery ${Math.round(timing.marks.promptWriteStarted)} ms`,
            );
          } catch (error) {
            finishHarnessTiming(timing, "failed");
            throw error;
          } finally {
            if (deadline) clearTimeout(deadline);
            release();
          }
        };
        await run("cold");
        if (cold === 0) for (let warm = 0; warm < 10; warm++) await run("warm");
        await adapter.stopSession(sessionId);
        await run("resumed");
        await adapter.forgetSession(sessionId);
      }
    } finally {
      for (const id of ids) {
        await adapter.forgetSession(id).catch(() => undefined);
        await stopProcess(id);
      }
      await writeFile(
        output,
        JSON.stringify(
          {
            kind: "adapter-over-stdio",
            platform: process.platform,
            command,
            cwd,
            harness,
            samples,
          },
          null,
          2,
        ),
      );
      console.log(`Harness latency measurements: ${output}`);
      vi.unstubAllGlobals();
    }
  },
  20 * 60_000,
);
