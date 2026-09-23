import type { HarnessId } from "../../../features/sessions/model/session";
import type { HarnessEvent } from "./types";

const KEY = "monocode.harnessTiming";
const MAX_TRACES = 100;
const MAX_SPANS = 128;
const SETTING_KEYS = [
  "reasoningEffort",
  "effort",
  "thinking",
  "reasoning",
  "fast",
  "serviceTier",
  "context",
];

export type HarnessTiming = {
  id: number;
  harness: HarnessId;
  operation: "turn" | "steer" | "cancel";
  model?: string;
  settings: Record<string, string>;
  startedAt: string;
  start: number;
  marks: Record<string, number>;
  spans: Array<{
    name: string;
    start: number;
    duration: number;
    failed: boolean;
  }>;
  outcome?: "completed" | "failed" | "cancelled";
};

const traces: HarnessTiming[] = [];
const active = new Map<string, HarnessTiming>();
const textTimings = new Map<string, HarnessTiming>();
const commits = new Map<string, HarnessTiming>();
let nextId = 0;

/** Local, opt-in diagnostics. Never retain prompts, wire payloads, paths or errors. */
export function startHarnessTiming(
  input: {
    harness: HarnessId;
    model?: string;
    modelSettings?: Record<string, string>;
  },
  operation: HarnessTiming["operation"] = "turn",
): HarnessTiming | undefined {
  try {
    if (localStorage.getItem(KEY) !== "true") return;
  } catch {
    return;
  }
  const trace: HarnessTiming = {
    id: ++nextId,
    harness: input.harness,
    operation,
    model: input.model?.slice(0, 128),
    settings: Object.fromEntries(
      SETTING_KEYS.flatMap((key) => {
        const value = input.modelSettings?.[key];
        return typeof value !== "string" ? [] : [[key, value.slice(0, 128)]];
      }),
    ),
    startedAt: new Date().toISOString(),
    start: performance.now(),
    marks: {},
    spans: [],
  };
  traces.push(trace);
  if (traces.length > MAX_TRACES) {
    const removed = traces.shift();
    for (const map of [active, textTimings, commits]) {
      for (const [key, value] of map) if (value === removed) map.delete(key);
    }
  }
  Object.assign(globalThis, {
    monocodeHarnessTiming: {
      read: () => structuredClone(traces),
      clear: clearHarnessTimings,
    },
  });
  return trace;
}

export function clearHarnessTimings(): void {
  traces.length = 0;
  active.clear();
  textTimings.clear();
  commits.clear();
}

export function markHarnessTiming(
  trace: HarnessTiming | undefined,
  name: string,
): void {
  if (
    trace &&
    trace.marks[name] == null &&
    Object.keys(trace.marks).length < MAX_SPANS
  )
    trace.marks[name] = performance.now() - trace.start;
}

export function finishHarnessTiming(
  trace: HarnessTiming | undefined,
  outcome: NonNullable<HarnessTiming["outcome"]>,
): void {
  if (!trace || trace.outcome) return;
  markHarnessTiming(trace, "settled");
  trace.outcome = trace.marks.cancelRequested != null ? "cancelled" : outcome;
}

export function currentHarnessTiming(
  sessionId: string,
): HarnessTiming | undefined {
  return active.get(sessionId);
}

export function bindHarnessTiming(
  sessionId: string,
  trace: HarnessTiming | undefined,
): () => void {
  if (trace) active.set(sessionId, trace);
  return () => {
    if (active.get(sessionId) === trace) active.delete(sessionId);
  };
}

export function measureHarnessTiming<T>(
  trace: HarnessTiming | undefined,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!trace) return work();
  const start = performance.now();
  const finish = (failed: boolean) => {
    if (trace.spans.length < MAX_SPANS)
      trace.spans.push({
        name,
        start: start - trace.start,
        duration: performance.now() - start,
        failed,
      });
  };
  try {
    const pending = work();
    // Observe the original promise; do not add an adoption hop to RPC races.
    void pending.then(
      () => finish(false),
      () => finish(true),
    );
    return pending;
  } catch (error) {
    finish(true);
    throw error;
  }
}

export function observeHarnessTiming(
  sessionId: string,
  trace: HarnessTiming | undefined,
  event: HarnessEvent,
): void {
  if (!trace || !traces.includes(trace)) return;
  if (event.type === "session.started")
    markHarnessTiming(trace, "sessionReady");
  if (event.type === "turn.started") markHarnessTiming(trace, "turnStarted");
  if (event.type === "session.error") markHarnessTiming(trace, "providerError");
  if (event.type === "message.completed")
    markHarnessTiming(trace, "firstMessageCompleted");
  if (event.type === "reasoning.delta" && event.text)
    markHarnessTiming(trace, "firstReasoning");
  if (
    event.type === "message.delta" &&
    event.text &&
    trace.marks.firstText == null
  ) {
    markHarnessTiming(trace, "firstText");
    textTimings.set(sessionId, trace);
  }
}

/** Called only after text has actually been applied to React state. */
export function queueHarnessTimingCommit(
  sessionId: string,
  events: readonly HarnessEvent[],
): void {
  const trace = textTimings.get(sessionId);
  if (
    !trace ||
    !events.some((event) => event.type === "message.delta" && event.text)
  )
    return;
  textTimings.delete(sessionId);
  markHarnessTiming(trace, "firstTextApplied");
  commits.set(sessionId, trace);
}

/** A visible transcript's React commit; this is not a browser paint timestamp. */
export function commitHarnessTiming(sessionId: string | undefined): void {
  if (!sessionId) return;
  const trace = commits.get(sessionId);
  if (!trace) return;
  commits.delete(sessionId);
  markHarnessTiming(trace, "firstTextCommitted");
}

/** Inspect the serializer's small header, never parse multi-MiB attachments. */
export function timingWriteKind(
  line: string,
): "prompt" | "steer" | "cancel" | "control" {
  const header = line.slice(0, 512);
  const method =
    /^\{\s*(?:(?:"jsonrpc"\s*:\s*"2.0"|"id"\s*:\s*(?:[0-9]+|"[a-zA-Z0-9_-]+"))\s*,\s*)*"(?:method|type)"\s*:\s*"([a-zA-Z_/]+)"/.exec(
      header,
    )?.[1];
  if (["turn/start", "session/prompt", "prompt", "user"].includes(method ?? ""))
    return "prompt";
  if (["turn/steer", "steer", "follow_up"].includes(method ?? ""))
    return "steer";
  if (
    ["turn/interrupt", "session/cancel", "abort"].includes(method ?? "") ||
    (method === "control_request" &&
      /"request"\s*:\s*\{\s*"subtype"\s*:\s*"interrupt"/.test(header))
  )
    return "cancel";
  return "control";
}

export function timingRequestName(method: string): string {
  // Protocol method names only. Reject arbitrary extension strings.
  return /^[a-zA-Z][a-zA-Z0-9_/-]{0,63}$/.test(method)
    ? `rpc:${method}`
    : "rpc:other";
}
