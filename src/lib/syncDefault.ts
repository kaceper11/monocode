import { ask, message } from "@tauri-apps/plugin-dialog";
import {
  gitDiffIndex,
  gitMergeAbort,
  gitMergeContext,
  gitSyncBranch,
  notifyGitChanged,
  type GitDiffIndex,
  type GitSyncResult,
} from "./fs";
import { boundAgentContext, requestAgentContext } from "./agentContext";
import { pathKey, wslLocation } from "./paths";
import { IS_MAC, IS_WIN } from "./platform";

/** A working copy to sync, optionally owned by a conversation. */
export type SyncTarget = {
  /** Exact working copy — resolved by the caller (sessionWorkCwd, panel cwd). */
  cwd: string;
  /** Owning conversation — conflicts route straight to it; otherwise the picker. */
  sessionId?: string;
  /** Dialog title context, e.g. the session title. */
  title?: string;
};

/** Display label for the operation in progress — index.op / merge.op. */
export function opLabel(op: string | undefined): string {
  switch (op) {
    case "rebase":
      return "Rebase";
    case "am":
      return "Patch apply";
    case "cherry-pick":
      return "Cherry-pick";
    case "revert":
      return "Revert";
    default:
      return "Merge";
  }
}

/** Execution host for confirmations and agent context — never guessed. */
export function syncHostLabel(cwd: string): string {
  const wsl = wslLocation(cwd);
  if (wsl) return `WSL · ${wsl.distribution}`;
  return IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux";
}

/** The exact operation the confirmation must state before anything runs. */
export function syncConfirmText(cwd: string, index: GitDiffIndex): string {
  const remote = index.remote ?? "origin";
  const incoming = index.defaultBranch
    ? `${remote}/${index.defaultBranch}`
    : `the ${remote} default branch`;
  const branch = index.branch ?? "the current branch";
  return [
    `Fetch ${remote}, then merge ${incoming} into ${branch} in this exact working copy and host.`,
    "",
    `Working copy: ${cwd}`,
    `Host: ${syncHostLabel(cwd)}`,
    "",
    "Nothing is pushed. A dirty tree or an operation already in progress is refused — nothing is stashed or aborted automatically.",
  ].join("\n");
}

/** Pre-flight: the confirmation should describe an operation that can run.
 * These mirror most backend refusals so the user is told plainly instead
 * of confirming an impossible fetch+merge — residual gaps (a dirty file
 * outside a subdirectory-scoped index, an op or dirty file appearing after
 * the read) still refuse honestly at the backend. Returns the refusal
 * text, or null when a sync is at least plausible. */
export function syncPreflightRefusal(index: GitDiffIndex): string | null {
  if (index.opInProgress)
    return `A ${opLabel(index.op).toLowerCase()} is already in progress in this working copy — resolve or abort it first.`;
  if (!index.branch || index.detached)
    return "Check out a branch before syncing with the default branch.";
  if (!index.remote) return "No remote configured for this checkout.";
  if (!index.defaultBranch)
    return "Cannot resolve the remote default branch for this checkout.";
  if (index.files.length > 0)
    return `${index.files.length} uncommitted change${index.files.length === 1 ? "" : "s"} — commit or stash before syncing; nothing is stashed automatically.`;
  return null;
}

/** One flow per working copy at a time — dialogs don't block the UI, so
 * without this a second menu click could stack confirmations while the
 * first run still waits for an answer. */
const syncInFlight = new Set<string>();

/** Claim the working copy's sync slot for a sibling flow (the attention
 * update path) so its confirmations can't overlap a menu/panel sync.
 * Returns the release callback, or undefined when a sync is in flight.
 * Keyed on `pathKey` — the spellings the various callers hand over are
 * not all normalized the same way; a subdirectory spelling can still
 * slip through (the backend guard catches that case as a refusal). */
export function acquireSyncSlot(cwd: string): (() => void) | undefined {
  // "" would key to "/" — never let a pathological cwd claim it.
  if (!cwd || cwd === "~") return undefined;
  const key = pathKey(cwd);
  if (syncInFlight.has(key)) return undefined;
  syncInFlight.add(key);
  return () => syncInFlight.delete(key);
}

/**
 * Confirm → fetch → merge `remote/<default>` → report. Returns the raw
 * result (undefined when the user cancels). A failed pre-read throws —
 * callers surface it. Conflicts stay in the tree and route to
 * `offerMergeResolution`; abort is offered again there. Callers own busy
 * state — a second run is refused by the backend, never queued.
 */
export async function syncWithDefaultBranch(
  target: SyncTarget,
): Promise<GitSyncResult | undefined> {
  const title = target.title || "Sync with remote default";
  if (!target.cwd || target.cwd === "~") {
    await message("This conversation has no working copy to sync.", {
      title,
      kind: "warning",
    });
    return undefined;
  }
  const release = acquireSyncSlot(target.cwd);
  if (!release) {
    await message(
      "A sync or update is already running on this working copy — wait for it to finish.",
      { title, kind: "warning" },
    );
    return undefined;
  }
  try {
    return await runSync(target, title);
  } finally {
    release();
  }
}

async function runSync(
  target: SyncTarget,
  title: string,
): Promise<GitSyncResult | undefined> {
  const index = await gitDiffIndex(target.cwd);
  const refusal = syncPreflightRefusal(index);
  if (refusal) {
    await message(refusal, { title, kind: "warning" });
    return undefined;
  }
  if (
    !(await ask(syncConfirmText(target.cwd, index), {
      title,
      kind: "info",
      okLabel: "Sync",
      cancelLabel: "Cancel",
    }))
  )
    return undefined;
  // The branch named in the confirmation is pinned: a checkout that moved
  // while the dialog was open is refused, not merged into.
  const result = await gitSyncBranch(target.cwd, index.branch ?? undefined);
  notifyGitChanged(target.cwd);
  switch (result.outcome) {
    case "merged": {
      const list = result.commits.slice(0, 10).join("\n");
      // commitCount is exact even when the subject list is capped —
      // say so rather than presenting a truncated list as complete.
      const more =
        result.commitCount > result.commits.slice(0, 10).length
          ? `\n… and ${result.commitCount - result.commits.slice(0, 10).length} more`
          : "";
      await message(
        `Merged ${result.syncedWith} into ${result.branch} — ${result.commitCount} incoming commit${result.commitCount === 1 ? "" : "s"}${list ? `:\n${list}${more}` : "."}\n\nNothing was pushed.`,
        { title },
      );
      break;
    }
    case "up-to-date":
      await message(
        `${result.branch} is already up to date with ${result.syncedWith}.`,
        { title },
      );
      break;
    case "conflicted":
      await offerMergeResolution(target, result.syncedWith, result.conflicts);
      break;
    default:
      await message(result.reason || "The sync was refused.", {
        title,
        kind: "warning",
      });
  }
  return result;
}

/**
 * Pending conflict-resolution sheets — one per working copy. The app renders
 * them as in-app modals (never chained native asks — a cancel must close,
 * not open the next question). Dismiss = "keep": the conflicts stay in the
 * tree, which is always the safe default.
 */
export type MergeResolutionChoice = "agent" | "abort" | "keep";
export type MergeResolutionRequest = {
  key: string;
  cwd: string;
  sessionId?: string;
  title: string;
  op: "merge" | "rebase";
  syncedWith: string;
  conflicts: string[];
  choose: (choice: MergeResolutionChoice) => void;
};
export const MERGE_RESOLUTIONS_CHANGED = "monocode:merge-resolutions";
const pendingResolutions = new Map<string, MergeResolutionRequest>();
let resolutionSnapshot: readonly MergeResolutionRequest[] = [];
const emitResolutions = () => {
  resolutionSnapshot = [...pendingResolutions.values()];
  window.dispatchEvent(new Event(MERGE_RESOLUTIONS_CHANGED));
};
export const mergeResolutionSnapshot = () => resolutionSnapshot;
export function subscribeMergeResolutions(listener: () => void): () => void {
  window.addEventListener(MERGE_RESOLUTIONS_CHANGED, listener);
  return () => window.removeEventListener(MERGE_RESOLUTIONS_CHANGED, listener);
}

/**
 * Conflict resolution after a sync or update: offer send-to-agent, abort, or
 * keep via the in-app sheet — the conflicted state stays in the tree either
 * way. `op` names what produced the state ("merge" by default, "rebase" from
 * the update-branch flow). Re-offering the same working copy resolves the
 * earlier sheet as "keep" first so sheets never stack.
 */
export async function offerMergeResolution(
  target: SyncTarget,
  syncedWith: string,
  conflicts: string[],
  op: "merge" | "rebase" = "merge",
): Promise<void> {
  const key = pathKey(target.cwd);
  pendingResolutions.get(key)?.choose("keep");
  const choice = await new Promise<MergeResolutionChoice>((resolve) => {
    let done = false;
    pendingResolutions.set(key, {
      key,
      cwd: target.cwd,
      sessionId: target.sessionId,
      title: target.title ?? "",
      op,
      syncedWith,
      conflicts,
      choose: (choice) => {
        if (done) return;
        done = true;
        pendingResolutions.delete(key);
        emitResolutions();
        resolve(choice);
      },
    });
    emitResolutions();
  });
  const title = target.title || "Merge conflicts";
  if (choice === "agent") {
    // Re-reads live merge state — a merge resolved meanwhile sends nothing.
    const sent = await sendMergeConflictsToAgent(target);
    if (!sent)
      await message(`The ${op} is no longer in progress — nothing was sent.`, {
        title,
        kind: "info",
      });
    return;
  }
  if (choice === "abort") {
    // The operation may already have been aborted (or finished) elsewhere —
    // never abort blind.
    const live = await gitMergeContext(target.cwd).catch(() => null);
    if (live && !live.merging) {
      await message(`The ${op} is no longer in progress — nothing to abort.`, {
        title,
        kind: "info",
      });
      return;
    }
    await gitMergeAbort(target.cwd);
    notifyGitChanged(target.cwd);
  }
}

/**
 * Dispatch the live merge state to the owning conversation (or the
 * destination picker when the working copy has none). Reads fresh state so
 * a merge already resolved or aborted sends nothing; the conflict stays in
 * the tree either way. `extraInstruction` adds caller-specific guidance —
 * the bulk task sync uses it to require "ask me" over guessing. Returns
 * false when there is nothing left to send.
 */
export async function sendMergeConflictsToAgent(
  target: SyncTarget,
  extraInstruction?: string,
): Promise<boolean> {
  const merge = await gitMergeContext(target.cwd);
  if (!merge.merging) return false;
  const index = await gitDiffIndex(target.cwd).catch(() => null);
  const branch = index?.branch ?? "the current branch";
  const host = syncHostLabel(target.cwd);
  const op = opLabel(merge.op);
  // Only a ref verified against the operation's head is named — a merge
  // the user started on another ref is never described as the default.
  const incoming = merge.incomingRef ?? merge.mergeHead;
  const paths = merge.conflicts.length
    ? merge.conflicts.join("\n")
    : "(no unmerged paths — the operation is still in progress)";
  // The backend caps the list at 100 — at the cap, say so rather than
  // presenting a truncated list as complete.
  const countLabel =
    merge.conflicts.length === 100 ? "first 100" : `${merge.conflicts.length}`;
  const text = [
    `A ${op.toLowerCase()} in ${branch} stopped with conflicts in this working copy. Resolve it in place — preserve both sides' intent, then run the checks this repository offers.`,
    ...(extraInstruction ? ["", extraInstruction] : []),
    "",
    `Host: ${host}`,
    `Working copy: ${target.cwd}`,
    `Branch: ${branch}`,
    `Operation: ${op.toLowerCase()}`,
    `Incoming head: ${incoming ?? "unknown"}`,
    `Conflicted paths (${countLabel}, relative to the repository root):`,
    paths,
    "",
    `Work only in this working copy and host. Do not abort the ${op.toLowerCase()}, do not commit or push — stage resolved files and leave the tree ready for review in the diff view.`,
  ].join("\n");
  requestAgentContext({
    context: boundAgentContext({
      id: crypto.randomUUID(),
      attachments: [],
      entries: [
        {
          id: crypto.randomUUID(),
          title: `${op} conflicts in ${branch}`,
          origin: `${target.cwd} · ${host} · ${op.toLowerCase()} in progress`,
          text,
        },
        ...(merge.diff
          ? [
              {
                id: crypto.randomUUID(),
                title: "Conflicted diff (bounded)",
                origin: `${target.cwd} · git diff of unmerged paths`,
                text: merge.diff,
                language: "diff",
              },
            ]
          : []),
      ],
    }),
    cwd: target.cwd,
    sourceSessionId: target.sessionId,
    // Stage straight on the owning conversation when it's open at this
    // checkout — a bulk sync can dispatch several conflict sends at once,
    // and only one picker request can be open at a time.
    destination: { kind: "source" },
  });
  return true;
}

/** Conflict guidance for the task-level bulk sync — the owning agent must
 * keep both sides and escalate ambiguity to the user instead of guessing. */
const TASK_SYNC_DIRECTIVE =
  "Preserve both the incoming and the current changes — the resolution must not drop either side's work. If anything about the correct resolution is unclear, ask me questions before continuing; do not guess.";

/** One row per linked working copy in a task sync report. */
export type TaskBranchSyncRow = {
  cwd: string;
  /** Branch once known, the path before that. */
  label: string;
  state:
    | "running"
    | "merged"
    | "up-to-date"
    | "conflicts-sent"
    | "conflicts"
    | "skipped"
    | "failed";
  detail?: string;
};

/** Minimal task shape the sync needs — TaskWorkspace satisfies it. */
type TaskSyncSource = {
  children: readonly { workingCopy?: string; sessionIds: readonly string[] }[];
  sessionIds?: readonly string[];
};

/**
 * Task-level quick action: fetch and merge the remote default into every
 * linked working copy, one at a time so copies of the same repository never
 * race on the object store. No per-copy confirmation — the backend refuses
 * dirty trees and in-progress operations, nothing is pushed, and conflicts
 * stay recoverable. Conflicted copies with an owning session go straight
 * to their agent with the preserve-and-ask directive; sessionless ones are
 * reported for manual resolution. `onRows` receives the report as rows
 * resolve so the sheet can stream progress.
 */
export async function syncTaskBranches(
  task: TaskSyncSource,
  onRows?: (rows: readonly TaskBranchSyncRow[]) => void,
): Promise<TaskBranchSyncRow[]> {
  const targets: { cwd: string; sessionId?: string }[] = [];
  const seen = new Set<string>();
  for (const child of task.children) {
    if (!child.workingCopy) continue;
    const key = pathKey(child.workingCopy);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      cwd: child.workingCopy,
      sessionId: child.sessionIds[0] ?? task.sessionIds?.[0],
    });
  }
  const rows: TaskBranchSyncRow[] = targets.map(({ cwd }) => ({
    cwd,
    label: cwd,
    state: "running",
  }));
  const emit = () => onRows?.(rows.map((row) => ({ ...row })));
  emit();
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const row = rows[index];
    const release = acquireSyncSlot(target.cwd);
    if (!release) {
      row.state = "skipped";
      row.detail = "A sync is already running on this working copy.";
      emit();
      continue;
    }
    try {
      const read = await gitDiffIndex(target.cwd);
      row.label = read.branch ?? target.cwd;
      const refusal = syncPreflightRefusal(read);
      if (refusal) {
        row.state = "skipped";
        row.detail = refusal;
      } else {
        const result = await gitSyncBranch(
          target.cwd,
          read.branch ?? undefined,
        );
        notifyGitChanged(target.cwd);
        switch (result.outcome) {
          case "merged":
            row.state = "merged";
            row.detail = `${result.commitCount} incoming commit${result.commitCount === 1 ? "" : "s"} from ${result.syncedWith}`;
            break;
          case "up-to-date":
            row.state = "up-to-date";
            row.detail = `Already up to date with ${result.syncedWith}`;
            break;
          case "conflicted": {
            if (!target.sessionId) {
              row.state = "conflicts";
              row.detail = `${result.conflicts.length} conflict${result.conflicts.length === 1 ? "" : "s"} left — no owning conversation; resolve in Git Changes.`;
              break;
            }
            const sent = await sendMergeConflictsToAgent(
              { cwd: target.cwd, sessionId: target.sessionId },
              TASK_SYNC_DIRECTIVE,
            );
            row.state = sent ? "conflicts-sent" : "conflicts";
            row.detail = sent
              ? "Conflicts sent to the owning conversation."
              : "The operation finished before conflicts could be sent.";
            break;
          }
          default:
            row.state = "skipped";
            row.detail = result.reason || "The sync was refused.";
        }
      }
    } catch (error) {
      row.state = "failed";
      row.detail = error instanceof Error ? error.message : String(error);
    } finally {
      release();
      emit();
    }
  }
  return rows;
}

/** Explicit abort of the operation in progress — always confirmed. The
 * uncached merge context names the real op (a 1.5s-stale index could
 * mislabel it) and short-circuits a stale banner when nothing is running. */
export async function abortMerge(target: SyncTarget): Promise<boolean> {
  const merge = await gitMergeContext(target.cwd).catch(() => null);
  if (merge && !merge.merging) return false;
  // A failed state read still offers the confirmed abort — but names no
  // operation rather than guessing "merge" for a possibly-different op.
  const op = merge ? opLabel(merge.op).toLowerCase() : "operation";
  if (
    !(await ask(
      `Abort the ${op} in ${target.cwd} and restore the previous state?`,
      {
        title: `Abort ${op}`,
        kind: "warning",
        okLabel: `Abort ${op}`,
        cancelLabel: "Cancel",
      },
    ))
  )
    return false;
  await gitMergeAbort(target.cwd);
  notifyGitChanged(target.cwd);
  return true;
}
