import { afterAll, expect, it, vi } from "vitest";
import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { HarnessEvent, SendTurnInput } from "./types";

// Explicit opt-in: real authenticated CLIs, disposable workspace, read-only prompts.
// This exercises adapters/stdio, not the native Tauri bridge or WebView rendering.
const provider = process.env.MONOCODE_LIVE_PROVIDER;
const comparison = process.env.MONOCODE_COMPARE === "1";
const greetings = process.env.MONOCODE_GREETING_CHECK === "1";
let observeWire: ((message: any) => void) | undefined;
const children = new Map<string, ChildProcessWithoutNullStreams>();
const listeners = new Map<
  string,
  {
    line: (line: string) => void;
    exit: (code: number | null) => void;
    stderr?: (line: string) => void;
  }
>();
const wireModels: unknown[] = [];
const methods = new Map<number, string>();
const controls: unknown[] = [];
const writes: { method: string; at: number }[] = [];

vi.mock("./child", async (original) => ({
  ...(await original<typeof import("./child")>()),
  resolveMuseBinary: async () => ({ path: "muse" }),
  resolveDevinBinary: async () => ({ path: "devin" }),
  resolveCodexBinary: async () => ({ path: "codex" }),
  resolveCopilotBinary: async () => ({ path: "copilot" }),
  watchChild: (
    id: string,
    line: (line: string) => void,
    exit: (code: number | null) => void,
    stderr?: (line: string) => void,
  ) => {
    listeners.set(id, { line, exit, stderr });
  },
  unwatchChild: (id: string) => {
    listeners.delete(id);
  },
  spawnChild: async (
    id: string,
    command: string,
    args: string[],
    cwd: string,
  ) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "pipe" });
    children.set(id, child);
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        observeWire?.(message);
        const result = message.result;
        if (
          ["turn/start", "turn/steer"].includes(methods.get(message.id) ?? "")
        ) {
          controls.push({ method: methods.get(message.id), result });
          console.log("Turn acknowledgement", JSON.stringify(controls.at(-1)));
        }
        if (result?.thread)
          wireModels.push({
            model: result.model,
            threadModel: result.thread.model,
          });
      } catch {
        /* provider diagnostics need not be JSON */
      }
      listeners.get(id)?.line(line);
    });
    createInterface({ input: child.stderr }).on("line", (line) =>
      listeners.get(id)?.stderr?.(line),
    );
    child.on("exit", (code) => {
      if (children.get(id) !== child) return;
      children.delete(id);
      listeners.get(id)?.exit(code);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  },
  writeChild: async (id: string, line: string) => {
    const child = children.get(id);
    if (!child) throw new Error("Owned test child is not running");
    const message = JSON.parse(line);
    if (message.id && message.method) methods.set(message.id, message.method);
    if (message.method)
      writes.push({ method: message.method, at: performance.now() });
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(`${line}\n`, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  },
  killChild: async (id: string) => {
    const child = children.get(id);
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already exited */
    }
    children.delete(id);
  },
}));

afterAll(() => {
  for (const child of children.values()) {
    if (child.pid)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
  }
});

it.skipIf(!provider || comparison)(
  "runs consecutive prompts through an installed provider",
  async () => {
    if (!["muse", "devin", "codex", "copilot"].includes(provider!))
      throw new Error("Unsupported smoke provider");
    const adapters = {
      muse: (await import("./museAdapter")).museAdapter,
      devin: (await import("./devinAdapter")).devinAdapter,
      codex: (await import("./codexAdapter")).codexAdapter,
      copilot: (await import("./copilotAdapter")).copilotAdapter,
    };
    const adapter = adapters[provider as keyof typeof adapters];
    const cwd = greetings ? homedir() : mkdtempSync(join(tmpdir(), "monocode-harness-smoke-"));
    if (!greetings) execFileSync("git", ["init", "--quiet", cwd]);
    const model = greetings && provider === "codex" ? "codex:gpt-6-astra"
      : greetings && provider === "devin" ? "devin:swe-2-high" : `${provider}:default`;
    const modelSettings = greetings && provider === "codex" ? { reasoningEffort: "medium" } : undefined;
    const sessionId = `smoke-${provider}-${Date.now()}`;
    const pairs = Math.max(
      0,
      Math.min(10, Number(process.env.MONOCODE_BENCH_PAIRS) || 0),
    );
    if (pairs && provider === "copilot") {
      throw new Error(
        "Direct Copilot comparison is not configured; use the normal live smoke run.",
      );
    }
    const direct: { turn: number; completedMs: number }[] = [];
    const samples: {
      turn: number;
      firstContentMs?: number;
      settledMs: number;
      writeMs?: number;
      errors: string[];
    }[] = [];
    try {
      for (let i = 1; i <= (pairs || 3); i++) {
        const text = greetings ? ["hey", "how are you", "thanks"][i - 1]
          : `Reply with exactly HARNESS_OK_${i}. Do not use tools, read or modify files, or run commands.`;
        const directRun = async () => {
          const args =
            provider === "muse"
              ? [
                  "exec",
                  "--json",
                  "--workspace",
                  cwd,
                  "--approval-mode",
                  "untrusted",
                  text,
                ]
              : provider === "devin"
                ? [
                    "--permission-mode",
                    "accept-edits",
                    "--respect-workspace-trust",
                    "false",
                    "-p",
                    text,
                  ]
                : ["exec", "--json", "--sandbox", "workspace-write", text];
          const started = performance.now();
          const stdout = await new Promise<string>((resolve, reject) => {
            const child = execFile(
              provider!,
              args,
              {
                cwd,
                timeout: 120_000,
                maxBuffer: 4 * 1024 * 1024,
              },
              (error, output) => (error ? reject(error) : resolve(output)),
            );
            // Codex reads optional additional piped input before starting.
            child.stdin?.end();
          });
          expect(stdout).toContain(`HARNESS_OK_${i}`);
          direct.push({ turn: i, completedMs: performance.now() - started });
        };
        if (pairs && i % 2 === 1) await directRun();
        const start = performance.now();
        const events: HarnessEvent[] = [];
        let firstContentMs: number | undefined;
        let followUp: Promise<void> | undefined;
        let followUpRequested = false;
        writes.length = 0;
        const input: SendTurnInput = {
          sessionId,
          cwd,
          model,
          modelSettings,
          runtimeMode: "supervised",
          text,
          attachments: [],
          onEvent: (event) => {
            events.push(event);
            if (event.type === "message.delta" && firstContentMs == null)
              firstContentMs = performance.now() - start;
            if (
              process.env.MONOCODE_LIVE_STEER === "1" &&
              i === 1 &&
              !followUpRequested &&
              event.type === "message.completed"
            ) {
              followUpRequested = true;
              if (adapter.canSteer !== false) {
                followUp = adapter.steerTurn({
                  sessionId,
                  cwd,
                  model: `${provider}:default`,
                  text: "Now reply with exactly HARNESS_FOLLOWUP. Do not use tools or modify anything.",
                });
                void followUp.catch(() => undefined);
              }
            }
            if (event.type === "approval.requested")
              adapter.respondApproval(sessionId, event.requestId, "deny");
          },
        };
        await adapter.sendTurn(input);
        if (followUpRequested && !followUp) {
          // A provider without steering receives a follow-up after completion.
          followUp = adapter.sendTurn({
            ...input,
            text: "Reply with exactly HARNESS_FOLLOWUP. Do not use tools or modify anything.",
          });
        }
        await followUp;
        const errors = events
          .filter(
            (e): e is Extract<HarnessEvent, { type: "session.error" }> =>
              e.type === "session.error",
          )
          .map((e) => e.message);
        samples.push({
          turn: i,
          firstContentMs,
          settledMs: performance.now() - start,
          writeMs:
            writes.find(
              (w) => w.method === "turn/start" || w.method === "session/prompt",
            )?.at! - start,
          errors,
        });
        expect(errors).toEqual([]);
        if (process.env.MONOCODE_LIVE_STEER === "1" && i === 1) {
          expect(followUp).toBeDefined();
          expect(
            events
              .filter((e) => e.type === "message.delta")
              .map((e) => e.text)
              .join(""),
          ).toContain("HARNESS_FOLLOWUP");
        }
        const answer = events
            .filter((e) => e.type === "message.delta")
            .map((e) => e.text)
            .join("");
        if (greetings) {
          expect(answer.trim()).not.toBe("");
        } else expect(answer).toContain(`HARNESS_OK_${i}`);
        if (pairs) {
          await adapter.forgetSession(sessionId);
          if (i % 2 === 0) await directRun();
        }
      }
    } finally {
      await adapter.stopSession(sessionId);
      const report = {
        provider,
        cwd,
        model,
        modelSettings,
        samples,
        direct,
        wireModels,
        controls,
        boundary: "native CLI + TypeScript adapter; excludes Tauri/WebView",
      };
      const path = join(tmpdir(), `monocode-${provider}-smoke.json`);
      writeFileSync(path, JSON.stringify(report, null, 2));
      console.log(`Native smoke report: ${path}`, JSON.stringify(samples));
    }
  },
  1_800_000,
);

// The exact same test file runs on the original base and patched checkout.
// Failures are measurements, never fast successful responses.
it.skipIf(!provider || !comparison)(
  "measures a cold prompt and warm follow-up",
  async () => {
    const adapter =
      provider === "muse"
        ? (await import("./museAdapter")).museAdapter
        : provider === "devin"
          ? (await import("./devinAdapter")).devinAdapter
          : provider === "codex"
            ? (await import("./codexAdapter")).codexAdapter
            : provider === "copilot"
              ? (await import("./copilotAdapter")).copilotAdapter
              : undefined;
    if (!adapter) throw new Error("Unsupported comparison provider");
    const cwd = process.env.MONOCODE_BENCH_CWD!;
    if (!cwd || !process.env.MONOCODE_RESULT_PATH)
      throw new Error("Comparison requires workspace and report paths");
    const sessionId = `compare-${provider}-${Date.now()}`;
    const samples: Record<string, unknown>[] = [];
    try {
      for (let turn = 1; turn <= 2; turn++) {
        const start = performance.now();
        const errors: string[] = [];
        let text = "";
        let firstContentMs: number | undefined;
        let lastContentMs: number | undefined;
        let terminalMs: number | undefined;
        let resolveTerminal!: () => void;
        const terminal = new Promise<void>((resolve) => {
          resolveTerminal = resolve;
        });
        observeWire = (message) => {
          if (message.method === "turn/completed") {
            terminalMs = performance.now() - start;
            resolveTerminal();
          }
        };
        writes.length = 0;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Measurement exceeded 120 seconds")),
            120_000,
          );
        });
        let adapterSettledMs: number | undefined;
        try {
          await Promise.race([
            adapter.sendTurn({
              sessionId,
              cwd,
              model: `${provider}:default`,
              modelSettings: {},
              runtimeMode: "supervised",
              text: `Reply with exactly HARNESS_OK_${turn}. Do not use tools, read or modify files, or run commands.`,
              attachments: [],
              onEvent: (event) => {
                if (event.type === "message.delta" && event.text) {
                  text += event.text;
                  firstContentMs ??= performance.now() - start;
                  lastContentMs = performance.now() - start;
                }
                if (event.type === "session.error") errors.push(event.message);
                if (event.type === "approval.requested")
                  adapter.respondApproval(sessionId, event.requestId, "deny");
              },
            }),
            deadline,
          ]);
          adapterSettledMs = performance.now() - start;
          // Main used to settle Muse early. Compare host completion separately,
          // and start both warm samples with the previous host turn really idle.
          if (provider === "muse" && errors.length === 0)
            await Promise.race([terminal, deadline]);
        } catch (error) {
          errors.push(String(error));
        } finally {
          clearTimeout(timeout);
          observeWire = undefined;
        }
        samples.push({
          turn,
          ok: errors.length === 0 && text.includes(`HARNESS_OK_${turn}`),
          firstContentMs,
          lastContentMs,
          adapterSettledMs,
          terminalMs,
          writeMs:
            writes.find(
              (w) => w.method === "turn/start" || w.method === "session/prompt",
            )?.at! - start,
          errors,
        });
      }
    } finally {
      observeWire = undefined;
      await adapter.forgetSession(sessionId);
      writeFileSync(
        process.env.MONOCODE_RESULT_PATH!,
        JSON.stringify(
          {
            provider,
            variant: process.env.MONOCODE_VARIANT,
            pair: Number(process.env.MONOCODE_PAIR),
            model: `${provider}:default`,
            modelSettings: {},
            runtimeMode: "supervised",
            samples,
            boundary:
              "real provider + adapter/stdio; excludes Tauri/WebView/checkpoint",
            wireModels,
          },
          null,
          2,
        ),
      );
    }
  },
  300_000,
);
