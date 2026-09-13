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
import { wslLocation } from "./paths";
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

/** Pre-flight: the confirmation must describe an operation that can run.
 * These mirror the backend refusals so the user is told plainly instead of
 * confirming an impossible fetch+merge. Returns the refusal text, or null
 * when a sync is at least plausible. */
function syncPreflightRefusal(index: GitDiffIndex): string | null {
  if (index.opInProgress)
    return `A ${index.op || "merge"} is already in progress in this working copy — resolve or abort it first.`;
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
 * Returns the release callback, or undefined when a sync is in flight. */
export function acquireSyncSlot(cwd: string): (() => void) | undefined {
  if (syncInFlight.has(cwd)) return undefined;
  syncInFlight.add(cwd);
  return () => syncInFlight.delete(cwd);
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
 * Conflict resolution choice after a sync or update (or later, from the
 * merge banner): send the merge context to an agent, or leave the real
 * state in the tree — with one more explicit chance to abort instead.
 * `op` names what produced the state ("merge" by default, "rebase" from
 * the update-branch flow).
 */
export async function offerMergeResolution(
  target: SyncTarget,
  syncedWith: string,
  conflicts: string[],
  op: "merge" | "rebase" = "merge",
): Promise<void> {
  const title = target.title || "Merge conflicts";
  const list = conflicts.slice(0, 10).join("\n");
  // The backend caps at 100 — at the cap the count is honest but the list
  // is truncated; the shown slice is capped at 10 either way.
  const count = conflicts.length === 100 ? "100+" : `${conflicts.length}`;
  const action =
    op === "rebase" ? `Rebasing onto ${syncedWith}` : `Merging ${syncedWith}`;
  const send = await ask(
    `${action} left ${count} conflicted file${conflicts.length === 1 ? "" : "s"}${list ? `:\n${list}` : ""}\n\nThe conflicted state is preserved in the working copy. Send the merge context to ${target.sessionId ? "the owning conversation" : "an agent"}?`,
    {
      title,
      kind: "warning",
      okLabel: target.sessionId ? "Send to owning agent" : "Send to agent",
      cancelLabel: "Resolve manually",
    },
  );
  if (send) {
    const sent = await sendMergeConflictsToAgent(target);
    if (!sent)
      await message(
        `The ${op} is no longer in progress — nothing was sent.`,
        { title, kind: "info" },
      );
    return;
  }
  if (
    await ask(
      `Keep the conflicts in the tree, or abort the ${op} and restore the previous state?`,
      {
        title,
        kind: "warning",
        okLabel: `Abort ${op}`,
        cancelLabel: "Keep conflicts",
      },
    )
  ) {
    await gitMergeAbort(target.cwd);
    notifyGitChanged(target.cwd);
  }
}

/**
 * Dispatch the live merge state to the owning conversation (or the
 * destination picker when the working copy has none). Reads fresh state so
 * a merge already resolved or aborted sends nothing; the conflict stays in
 * the tree either way. Returns false when there is nothing left to send.
 */
export async function sendMergeConflictsToAgent(
  target: SyncTarget,
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
    "",
    `Host: ${host}`,
    `Working copy: ${target.cwd}`,
    `Branch: ${branch}`,
    `Operation: ${op.toLowerCase()}`,
    `Incoming head: ${incoming ?? "unknown"}`,
    `Conflicted paths (${countLabel}):`,
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
    requireDestinationSelection: !target.sessionId,
  });
  return true;
}

/** Explicit abort of the operation in progress — always confirmed. The
 * uncached merge context names the real op (a 1.5s-stale index could
 * mislabel it) and short-circuits a stale banner when nothing is running. */
export async function abortMerge(target: SyncTarget): Promise<boolean> {
  const merge = await gitMergeContext(target.cwd).catch(() => null);
  if (merge && !merge.merging) return false;
  const op = opLabel(merge?.op).toLowerCase();
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
