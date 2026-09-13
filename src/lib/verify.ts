import { invoke } from "@tauri-apps/api/core";
import { composeActionPrompt, type ActionRunRef } from "./agentActions";
import {
  ATTENTION_ACTION,
  ATTENTION_INFO,
  emitAttention,
  resolveAttention,
  resolveAttentionWhere,
  type AttentionItem,
} from "./attention";
import { gitDiffIndex } from "./fs";
import { isInFlightSession, wasTurnInterrupted } from "./inFlight";
import { pathKey } from "./paths";
import { joinRelativeCwd, resolveCommandTarget } from "./projectCommands";
import {
  findProjectByCommonDir,
  loadProjects,
  type ProjectCommand,
  type ProjectRecord,
} from "./projects";
import { sameProjectPath } from "./recents";
import {
  getVerifiedFamilies,
  type RepositoryFamily,
} from "./repositoryFamilies";
import { sessionNeedsInput, sessionWorkCwd, type Session } from "./session";
import { projectForTask, taskForSession } from "./taskWorkspaces";

/**
 * Checks on finish (#92). When an agent turn goes busy→idle, the project's
 * designated saved command runs headlessly in the session's exact working
 * copy (WSL-aware through `run_check`) and the outcome lands in the attention
 * queue — green means "ready for review", red offers to hand the bounded
 * output tail back to the owning agent.
 *
 * Same discipline as watchers and schedules: foreground-only (the run dies
 * with the WebView), one row per session's latest outcome, and a claimed
 * turn is never reprocessed — including across windows, via the persisted
 * claim list.
 */

export type CheckRunStatus =
  | "passed"
  | "failed"
  | "timeout"
  | "error"
  | "skipped";

export type CheckRunRecord = {
  id: string;
  projectId: string;
  sessionId: string;
  sessionTitle: string;
  commandId: string;
  commandName: string;
  /** Exact working copy the check ran in. */
  cwd: string;
  /** `${sessionId}:${userBlockId}` — the turn this run verified. */
  turnKey: string;
  at: number;
  durationMs: number;
  status: CheckRunStatus;
  /** Failure summary, error text or skip reason — one line for the UI. */
  detail?: string;
  /** Bounded tail kept for the send-to-agent action; absent on pass. */
  outputTail?: string;
  truncated?: boolean;
  /** The failure tail was handed to the agent (auto-fix or manual). */
  sentToAgent?: boolean;
};

export type VerifyHooks = {
  /** Live session lookup, re-read at dispatch time. */
  getSession?: (sessionId: string) => Session | undefined;
  /** Queued follow-up into the owning session; false = refused. `action`
   * stamps the provenance card a watcher/action dispatch would carry. */
  sendToSession?: (
    sessionId: string,
    text: string,
    action: ActionRunRef,
  ) => Promise<boolean>;
};

const KEY = "monocode.verify.v1";
const VERIFY_CHANGED = "monocode:verify-changed";
const MAX_RUNS = 40;
const MAX_CLAIMS = 300;
const MAX_TAIL = 4_000;
/** Consecutive sends into one failure chain before the row goes manual-only. */
export const MAX_FIX_SENDS = 3;

type ProjectVerifyState = {
  runs: CheckRunRecord[];
  /** Sends dispatched in each session's current consecutive-failure chain. */
  sends: Record<string, number>;
};

type VerifyStore = {
  /** turnKey → first-seen timestamp. Processed turns, runs and skips alike. */
  claims: Record<string, number>;
  projects: Record<string, ProjectVerifyState>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const clean = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;

const STATUSES: CheckRunStatus[] = [
  "passed",
  "failed",
  "timeout",
  "error",
  "skipped",
];

function sanitizeRun(value: unknown): CheckRunRecord | null {
  if (!isRecord(value)) return null;
  const status = STATUSES.includes(value.status as CheckRunStatus)
    ? (value.status as CheckRunStatus)
    : null;
  const id = clean(value.id, 128);
  const turnKey = clean(value.turnKey, 300);
  if (!status || !id || !turnKey) return null;
  const detail = clean(value.detail, 400);
  const outputTail = clean(value.outputTail, MAX_TAIL * 2);
  return {
    id,
    projectId: clean(value.projectId, 128) ?? "",
    sessionId: clean(value.sessionId, 128) ?? "",
    sessionTitle: clean(value.sessionTitle, 200) ?? "Session",
    commandId: clean(value.commandId, 128) ?? "",
    commandName: clean(value.commandName, 200) ?? "Check",
    cwd: clean(value.cwd, 2000) ?? "",
    turnKey,
    at:
      typeof value.at === "number" && Number.isFinite(value.at)
        ? value.at
        : 0,
    durationMs:
      typeof value.durationMs === "number" &&
      Number.isFinite(value.durationMs)
        ? value.durationMs
        : 0,
    status,
    ...(detail ? { detail } : {}),
    ...(outputTail ? { outputTail } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(value.sentToAgent === true ? { sentToAgent: true } : {}),
  };
}

function sanitizeStore(value: unknown): VerifyStore {
  const store: VerifyStore = { claims: {}, projects: {} };
  if (!isRecord(value)) return store;
  if (isRecord(value.claims)) {
    for (const [key, at] of Object.entries(value.claims)) {
      if (Object.keys(store.claims).length >= MAX_CLAIMS) break;
      if (key.length <= 300 && typeof at === "number" && Number.isFinite(at))
        store.claims[key] = at;
    }
  }
  if (isRecord(value.projects)) {
    for (const [projectId, entry] of Object.entries(value.projects)) {
      if (!isRecord(entry)) continue;
      const runs = (Array.isArray(entry.runs) ? entry.runs : [])
        .map(sanitizeRun)
        .filter((run): run is CheckRunRecord => !!run)
        .slice(-MAX_RUNS);
      const sends: Record<string, number> = {};
      if (isRecord(entry.sends)) {
        for (const [sessionId, count] of Object.entries(entry.sends)) {
          if (
            sessionId.length <= 128 &&
            typeof count === "number" &&
            Number.isInteger(count) &&
            count > 0
          )
            sends[sessionId] = Math.min(count, MAX_FIX_SENDS);
        }
      }
      store.projects[projectId] = { runs, sends };
    }
  }
  return store;
}

/** In-memory fallback once a write has failed (quota/denied storage) —
 * keeps claims deduping and runs recording for the session, matching the
 * attention store's contract. */
let memoryRaw: string | null = null;
let writeFailed = false;

function readStore(): VerifyStore {
  try {
    const raw = writeFailed && memoryRaw ? memoryRaw : localStorage.getItem(KEY);
    return raw ? sanitizeStore(JSON.parse(raw)) : { claims: {}, projects: {} };
  } catch {
    return { claims: {}, projects: {} };
  }
}

function writeStore(store: VerifyStore) {
  // Oldest claims evict first — the set is a dedupe window, not a ledger.
  const claims = Object.entries(store.claims)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CLAIMS);
  store.claims = Object.fromEntries(claims);
  const raw = JSON.stringify(store);
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // Storage full or unavailable — serve reads from memory this session.
    writeFailed = true;
    memoryRaw = raw;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(VERIFY_CHANGED));
  }
}

/** Raw snapshot for useSyncExternalStore. */
export function verifySnapshot(): string | null {
  if (writeFailed && memoryRaw) return memoryRaw;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return memoryRaw;
  }
}

export function verifyStoreFromSnapshot(raw: string | null): VerifyStore {
  if (!raw) return { claims: {}, projects: {} };
  try {
    return sanitizeStore(JSON.parse(raw));
  } catch {
    return { claims: {}, projects: {} };
  }
}

export function subscribeVerify(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener(VERIFY_CHANGED, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(VERIFY_CHANGED, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Bounded run history for a project, oldest first — the Automations page. */
export function verifyRunsFor(
  projectId: string,
  store: VerifyStore = readStore(),
): CheckRunRecord[] {
  return store.projects[projectId]?.runs ?? [];
}

function verifyRunById(
  runId: string,
  store: VerifyStore,
): CheckRunRecord | undefined {
  for (const entry of Object.values(store.projects)) {
    const run = entry.runs.find((candidate) => candidate.id === runId);
    if (run) return run;
  }
  return undefined;
}

// --- dispatch bridge -------------------------------------------------------

let hooks: VerifyHooks = {};

export function setVerifyHooks(next: VerifyHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = {};
  };
}

// --- turn-end entry point --------------------------------------------------

const inflight = new Set<string>();

/** Turn keys the user deliberately stopped — claimed but never run. The
 * marker must live module-side because `stopStreaming` records no "stopped"
 * flag on the session itself (queueStatus "paused" only covers the queued
 * follow-up case). Bounded and consumed on first match. */
const suppressedTurns = new Set<string>();
const MAX_SUPPRESSED = 64;

/** Last real user turn — the unit a check verifies. Steer and legacy user
 * blocks carry no `startedAt`; they still count as turns, so the newest user
 * block is the fallback rather than an older one winning silently. */
function lastUserTurn(session: Session) {
  let fallback: Session["blocks"][number] | undefined;
  for (let index = session.blocks.length - 1; index >= 0; index -= 1) {
    const block = session.blocks[index];
    if (block.role !== "user") continue;
    if (block.startedAt) return block;
    fallback ??= block;
  }
  return fallback;
}

/** Called by App's stop path: the turn being cut short must not verify. */
export function suppressVerifyTurn(session: Session) {
  const turn = lastUserTurn(session);
  if (!turn) return;
  if (suppressedTurns.size >= MAX_SUPPRESSED) {
    const oldest = suppressedTurns.values().next().value;
    if (oldest !== undefined) suppressedTurns.delete(oldest);
  }
  suppressedTurns.add(`${session.id}:${turn.id}`);
}

/**
 * Called by App on every busy→idle edge. Claims the turn synchronously —
 * re-entrant edges, other windows and restarts all see the claim — then runs
 * the actual verification off the render path.
 */
export function verifyTurnFinished(session: Session) {
  if (session.inboxAsk) return;
  const turn = lastUserTurn(session);
  if (!turn) return;
  // A turn ending on an approval/question resumes with the same user block
  // once answered — claiming it now would consume the dedupe and never
  // verify the real finish.
  if (sessionNeedsInput(session)) return;
  // Resolved synchronously: sessions outside any configured project skip
  // without claiming, so unverifiable edges never touch the store.
  const resolved = resolveTarget(session);
  if ("skip" in resolved) return;
  const turnKey = `${session.id}:${turn.id}`;
  if (inflight.has(turnKey)) return;
  const store = readStore();
  if (turnKey in store.claims) return;
  store.claims[turnKey] = Date.now();
  writeStore(store);
  inflight.add(turnKey);
  void run(session.id, turnKey, resolved).finally(() =>
    inflight.delete(turnKey),
  );
}

function recordRun(run: Omit<CheckRunRecord, "id" | "at">): CheckRunRecord {
  // Re-read inside the write: runs in different projects overlap, and a stale
  // snapshot would clobber the other project's freshly recorded run.
  const store = readStore();
  const entry: CheckRunRecord = {
    ...run,
    id: crypto.randomUUID(),
    at: Date.now(),
  };
  const state = store.projects[run.projectId] ?? { runs: [], sends: {} };
  state.runs = [...state.runs, entry].slice(-MAX_RUNS);
  // Only a pass ends the failure chain — skips and errors leave the send
  // budget where it was.
  if (run.status === "passed") delete state.sends[run.sessionId];
  store.projects[run.projectId] = state;
  writeStore(store);
  return entry;
}

function skipRun(
  base: Omit<CheckRunRecord, "id" | "at" | "status" | "detail">,
  detail: string,
) {
  recordRun({ ...base, status: "skipped", detail });
}

type RunTarget = {
  project: ProjectRecord;
  command: ProjectCommand;
  cwd: string;
};

/** Exact checkout match, then ancestor worktree match — a session rooted in
 * a subdirectory still belongs to that checkout's project. */
function familyForCwd(cwd: string): RepositoryFamily | undefined {
  const families = getVerifiedFamilies();
  const direct = families.get(pathKey(cwd));
  if (direct) return direct;
  const key = pathKey(cwd);
  for (const family of families.values()) {
    for (const worktree of family.worktrees) {
      const base = pathKey(worktree.path);
      if (key === base || key.startsWith(`${base}/`)) return family;
    }
  }
  return undefined;
}

/** Project owning `cwd` — via its verified Git family when known, else via
 * its anchor/last active folder so folder-only projects still match. */
function projectForCwd(cwd: string): ProjectRecord | undefined {
  const family = familyForCwd(cwd);
  if (family) {
    const match = findProjectByCommonDir(family.commonDir);
    if (match) return match.project;
  }
  return loadProjects().find(
    (project) =>
      (project.anchor && sameProjectPath(cwd, project.anchor)) ||
      (project.lastPath && sameProjectPath(cwd, project.lastPath)),
  );
}

/** session → owning project → configured command → exact run directory. */
function resolveTarget(
  session: Session,
): RunTarget | { skip: string } | { error: string; project?: ProjectRecord } {
  const cwd = sessionWorkCwd(session);
  const owner = taskForSession(session.id, cwd);
  const project = owner ? projectForTask(owner.task) : projectForCwd(cwd);
  if (!project) return { skip: "Session is not in a stored project." };
  const verify = project.verify;
  if (!verify || verify.enabled === false)
    return { skip: "Checks on finish are off." };
  const command = project.commands.find((item) => item.id === verify.commandId);
  if (!command) return { error: "The check command was deleted.", project };
  if (owner) {
    const target = resolveCommandTarget({
      command,
      project,
      task: owner.task,
      // The session's own child: the check runs where the agent worked, not
      // the task's primary copy or a different attempt's checkout.
      child: owner.child,
    });
    if ("error" in target) return { error: target.error, project };
    return { project, command, cwd: target.cwd };
  }
  // Standalone session: the run lands where the agent actually worked. A
  // repository-bound command additionally requires the session's copy to be
  // that repository — never redirect into a different checkout.
  if (command.repositoryId) {
    const repo = project.repositories.find(
      (entry) => entry.id === command.repositoryId,
    );
    const family = familyForCwd(cwd);
    if (
      !repo ||
      !family ||
      pathKey(family.commonDir) !== pathKey(repo.commonDir)
    )
      return {
        error: "The check targets a repository this session is not in.",
        project,
      };
  }
  const joined = joinRelativeCwd(cwd, command.relativeCwd);
  if ("error" in joined) return { error: joined.error, project };
  return { project, command, cwd: joined.cwd };
}

/** The run's step list — a stepped command keeps its steps; `host: "native"`
 * marks them for the OS shell exactly like the interactive runner does. */
function commandSteps(command: ProjectCommand): CheckStep[] {
  if (command.steps?.length)
    return command.steps.map((step) => ({
      exec: step.command,
      ...(step.host === "native" ? { native: true } : {}),
    }));
  return [{ exec: command.command }];
}

type CheckStep = { exec: string; native?: boolean };

type CheckRunResult = {
  code: number | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
  durationMs: number;
};

function attentionKey(sessionId: string) {
  return `verify:${sessionId}`;
}

/** Working copies with a check currently executing — two sessions finishing
 * into the same tree must not run overlapping checks in one directory. */
const runningCwds = new Set<string>();
/** Sessions whose turn skipped because a check already runs in their copy —
 * retried when that run finishes so the turn still verifies. */
const pendingCwds = new Map<string, Set<string>>();

/** The configured project state as it stands right now — a delete or a
 * switch-off mid-run is terminal for the in-flight check. */
function liveVerify(projectId: string) {
  const project = loadProjects().find((entry) => entry.id === projectId);
  const verify = project?.verify;
  return verify && verify.enabled !== false ? verify : undefined;
}

function releaseClaim(turnKey: string) {
  const store = readStore();
  if (!(turnKey in store.claims)) return;
  delete store.claims[turnKey];
  writeStore(store);
}

async function run(
  sessionId: string,
  turnKey: string,
  resolved: RunTarget | { error: string; project?: ProjectRecord },
) {
  const session = hooks.getSession?.(sessionId);
  if (!session) return;

  const base = {
    projectId: resolved.project?.id ?? "",
    sessionId,
    sessionTitle: session.title,
    commandId:
      "error" in resolved
        ? (resolved.project?.verify?.commandId ?? "")
        : resolved.command.id,
    commandName: "error" in resolved ? "Check" : resolved.command.name,
    cwd: "error" in resolved ? sessionWorkCwd(session) : resolved.cwd,
    turnKey,
    durationMs: 0,
  };

  // A turn-end that is not a clean finish never verifies — and a stopped or
  // interrupted turn must not surface a "check is broken" row on top of it,
  // so session-state guards run before configuration errors are reported.
  // (needsInput lives in verifyTurnFinished: the claim must survive it.)
  if (wasTurnInterrupted(session))
    return skipRun(base, "Turn was interrupted by quitting.");
  if (suppressedTurns.delete(turnKey))
    return skipRun(base, "Turn was stopped.");
  if (session.queueStatus === "paused")
    return skipRun(base, "Turn stopped before finishing.");
  if (session.queuedMessages?.length)
    return skipRun(base, "Follow-ups are still queued.");
  if (session.busy) return skipRun(base, "Session is busy again.");

  if ("error" in resolved) {
    const run = recordRun({ ...base, status: "error", detail: resolved.error });
    emitAttention(outcomeItem(run, sessionId));
    return;
  }

  const cwdKey = pathKey(resolved.cwd);
  if (runningCwds.has(cwdKey)) {
    // Retry when the running check finishes — the claim is released so the
    // retry can re-claim this turn instead of dying on it.
    const pending = pendingCwds.get(cwdKey) ?? new Set<string>();
    pending.add(sessionId);
    pendingCwds.set(cwdKey, pending);
    releaseClaim(turnKey);
    return;
  }
  runningCwds.add(cwdKey);
  try {
    // Clean-tree guard: a turn that changed nothing and is not ahead of its
    // upstream has nothing new to verify. Git failure is not proof of clean —
    // the check still runs.
    try {
      const index = await gitDiffIndex(resolved.cwd);
      if (
        index.files.length === 0 &&
        index.ahead === 0 &&
        index.aheadOfDefault === 0 &&
        !index.opInProgress
      )
        return skipRun(base, "Working copy is unchanged.");
    } catch {
      /* not a Git checkout — run anyway */
    }

    // The probe was async — re-read before the long-running invoke. A session
    // deleted mid-probe gets nothing; one busy again skips rather than run a
    // check against a mutating tree. A deleted/switched-off project is
    // terminal: running anyway would emit state nothing can clean up.
    const current = hooks.getSession?.(sessionId);
    if (!current || !liveVerify(resolved.project.id)) return;
    if (current.busy) return skipRun(base, "Session is busy again.");

    let result: CheckRunResult;
    try {
      result = await invoke<CheckRunResult>("run_check", {
        cwd: resolved.cwd,
        steps: commandSteps(resolved.command),
      });
    } catch (error) {
      if (!liveVerify(resolved.project.id)) return;
      const run = recordRun({
        ...base,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
      if (hooks.getSession?.(sessionId))
        emitAttention(outcomeItem(run, sessionId));
      return;
    }

    const status: CheckRunStatus = result.timedOut
      ? "timeout"
      : result.code === 0
        ? "passed"
        : "failed";
    const tail = result.output.slice(-MAX_TAIL);
    // A project deleted or switched off while the check ran stays dead —
    // recording or emitting now would resurrect state nothing can resolve.
    const verify = liveVerify(resolved.project.id);
    if (!verify) return;
    const run = recordRun({
      ...base,
      status,
      durationMs: result.durationMs,
      ...(status === "failed" || status === "timeout"
        ? {
            detail:
              status === "timeout"
                ? "Timed out."
                : result.code === null
                  ? "Killed."
                  : `Exit ${result.code}.`,
            outputTail: tail,
            truncated:
              result.truncated || result.output.length > MAX_TAIL,
          }
        : {
            detail: `${Math.max(1, Math.round(result.durationMs / 1000))}s`,
          }),
    });
    // The run is history regardless; the row only lands when the session is
    // still around to act on it (it may have been deleted mid-run).
    if (hooks.getSession?.(sessionId))
      emitAttention(outcomeItem(run, sessionId));

    // Auto-fix: hand the tail back to the owning session, capped per failure
    // chain. The send goes through the same queued dispatch a manual click
    // uses, and a busy/away session just skips this chance. The live config
    // decides — a mid-run mode switch is honored.
    if (
      (status === "failed" || status === "timeout") &&
      verify.mode === "fix"
    ) {
      await maybeSendToAgent(run);
    }
  } finally {
    runningCwds.delete(cwdKey);
    const pending = pendingCwds.get(cwdKey);
    pendingCwds.delete(cwdKey);
    for (const pendingId of pending ?? []) {
      const pendingSession = hooks.getSession?.(pendingId);
      if (pendingSession) verifyTurnFinished(pendingSession);
    }
  }
}

function fixPrompt(run: CheckRunRecord): { text: string; revision: string } {
  return composeActionPrompt({
    name: `Check · ${run.commandName}`,
    instructions: `The project's finish check "${run.commandName}" failed after your last turn. Fix the failures in this working copy; do not commit or push.`,
    sections: [
      {
        title: run.truncated
          ? "Check output (tail — earlier output was truncated)"
          : "Check output (tail)",
        text: run.outputTail ?? run.detail ?? "",
      },
    ],
  });
}

/** Shared send path for auto-fix and the manual attention action. */
async function sendRunToAgent(runId: string): Promise<string | void> {
  const store = readStore();
  const run = verifyRunById(runId, store);
  if (!run) return "That check result is gone.";
  if (run.status !== "failed" && run.status !== "timeout")
    return "That run has no failure output to send.";
  const session = hooks.getSession?.(run.sessionId);
  if (!session)
    return "The owning session is gone — start a new conversation from the task.";
  if (isInFlightSession(session) || session.queuedMessages?.length)
    return "The owning agent is busy — try again when it is idle.";
  if (!hooks.sendToSession) return "Dispatch is not wired up.";
  const state = store.projects[run.projectId];
  if ((state?.sends[run.sessionId] ?? 0) >= MAX_FIX_SENDS)
    return `Already sent ${MAX_FIX_SENDS} times for this failure chain — inspect the session instead.`;
  // Reserve the send before dispatching so a racing window can't overshoot
  // the cap; a refused or lost send rolls the reservation back.
  if (state) {
    state.sends[run.sessionId] = (state.sends[run.sessionId] ?? 0) + 1;
    writeStore(store);
  }
  const { text, revision } = fixPrompt(run);
  let accepted: boolean | void;
  try {
    accepted = await hooks.sendToSession(run.sessionId, text, {
      actionId: `verify:${run.id}`,
      name: `Check · ${run.commandName}`,
      revision,
    });
  } catch {
    accepted = false;
  }
  const next = readStore();
  const entry = next.projects[run.projectId];
  const delivered = accepted !== false && !!hooks.getSession?.(run.sessionId);
  if (!delivered) {
    if (entry) {
      entry.sends[run.sessionId] = Math.max(
        0,
        (entry.sends[run.sessionId] ?? 1) - 1,
      );
      writeStore(next);
    }
    return accepted === false
      ? "The follow-up was not sent."
      : "The owning session is gone — the send was not delivered.";
  }
  if (entry) {
    entry.runs = entry.runs.map((candidate) =>
      candidate.id === runId ? { ...candidate, sentToAgent: true } : candidate,
    );
    writeStore(next);
  }
  emitAttention({
    ...outcomeItem(run, run.sessionId, "Sent the check output to the agent."),
    signature: `sent:${run.id}:${Date.now()}`,
  });
  return undefined;
}

async function maybeSendToAgent(run: CheckRunRecord) {
  // Nobody to notify or send to — the run record already preserves it.
  if (!hooks.getSession?.(run.sessionId)) return;
  const error = await sendRunToAgent(run.id);
  if (error) {
    // A skipped auto-send is still recorded so the row can say why nothing
    // was dispatched.
    emitAttention(outcomeItem(run, run.sessionId, error));
  }
}

/** The "Send output to agent" quick action — resolved at click time. */
export function sendCheckToAgent(runId: string): Promise<string | void> {
  return sendRunToAgent(runId);
}

function outcomeItem(
  run: CheckRunRecord,
  sessionId: string,
  overrideDetail?: string,
): AttentionItem {
  const failed = run.status === "failed" || run.status === "timeout";
  const title =
    run.status === "passed"
      ? `Checks passed — ${run.sessionTitle}`
      : run.status === "error"
        ? `Checks didn't run — ${run.sessionTitle}`
        : `Checks failed — ${run.sessionTitle}`;
  const detail = overrideDetail ?? run.detail ?? run.commandName;
  return {
    key: attentionKey(sessionId),
    kind: "check",
    title,
    detail,
    urgency: failed || run.status === "error" ? ATTENTION_ACTION : ATTENTION_INFO,
    at: run.at,
    signature: `${run.status}:${run.id}:${overrideDetail ?? ""}`,
    sessionId,
    cwd: run.cwd,
    source: { kind: "verify", id: run.projectId },
    action: failed
      ? { kind: "check-fix", runId: run.id }
      : run.status === "passed"
        ? { kind: "open-changes", sessionId }
        : // Errors are configuration/target problems — the fix lives in the
          // project's commands, not in the conversation.
          { kind: "open-automations" },
  };
}

/** Session archived/deleted — drop its stale outcome row and its send
 * counters, which would otherwise outlive the session forever. */
export function resolveVerifyForSession(sessionId: string) {
  resolveAttention(attentionKey(sessionId));
  const store = readStore();
  let changed = false;
  for (const state of Object.values(store.projects)) {
    if (sessionId in state.sends) {
      delete state.sends[sessionId];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

/** Config switched off — the project's live check rows no longer apply.
 * Run history stays: it's diagnostic, bounded, and still true. */
export function resolveVerifyForProject(projectId: string) {
  resolveAttentionWhere(
    (item) => item.source?.kind === "verify" && item.source.id === projectId,
  );
}

/** Project deleted — rows and stored run state both go; nothing may keep a
 * dead project id alive. */
export function dropVerifyForProject(projectId: string) {
  resolveVerifyForProject(projectId);
  const store = readStore();
  if (!(projectId in store.projects)) return;
  delete store.projects[projectId];
  writeStore(store);
}
