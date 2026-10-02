import { listWorktrees } from "../source-control/model/worktrees";
import { getSession } from "../sessions/data/sessionStore";
import { pathKey } from "../../shared/lib/paths";
import { loadBoard, updateTask, type TaskWorkstream } from "./boardStore";
import {
  deliveryKey,
  evidenceFingerprint,
  handoffPrompt,
  matchesTarget,
  probeDelivery,
  snapshotIdentity,
  type DeliverySnapshot,
  type DeliveryTarget,
  type Evidence,
  type SendToSession,
} from "./delivery";
import { replyInstructions, replyScope } from "./replyDrafts";

export type HandoffKind = "ci" | "comments" | "draft-replies";

/** Shared dispatch for agent handoffs. Re-verifies the lane binding, the
 * working copy and the provider evidence at send time — what the user
 * reviewed is what the agent gets — then spawns or reuses the chosen
 * session. Throws user-facing text on any staleness; callers own the UI
 * state around it. */
export async function sendHandoff(args: {
  taskId?: string;
  kind: HandoffKind;
  workstream: TaskWorkstream;
  /** `deliveryKey` captured when the reviewed evidence was loaded. */
  loadedKey: string;
  snapshot: DeliverySnapshot;
  target: DeliveryTarget;
  items: Evidence[];
  instructions: string;
  /** Session id, or "new" to spawn the configured default agent. */
  recipient: string;
  requestId: string;
  /** A session this flow already spawned for the lane — reused instead of
   * stacking fresh sessions on retries within one composer/dialog. */
  reuseSession?: { lane: string; id: string };
  /** Called the moment a session is spawned so callers can keep the id for
   * reuse even when a later step (send) fails. */
  onSpawned?: (spawned: { lane: string; id: string }) => void;
  /** Reloads current evidence for the fingerprint check — same ids, fresh
   * bodies, so edited comments/checks are caught before dispatch. */
  evidenceNow: (
    ws: TaskWorkstream,
    snapshot: DeliverySnapshot,
  ) => Promise<Evidence[]>;
  onSpawn: (
    ws: TaskWorkstream,
  ) => Promise<{ sessionId: string; worktreePath: string }>;
  onSend: SendToSession;
}): Promise<{ sessionId: string }> {
  const {
    taskId,
    kind,
    workstream: ws,
    loadedKey,
    snapshot,
    target,
    items,
    instructions,
    recipient,
    requestId,
  } = args;
  const current = taskId
    ? loadBoard()
        .tasks.find((t) => t.id === taskId && !t.archived)
        ?.workstreams.find((w) => w.id === ws.id)
    : ws;
  if (!current || deliveryKey(current) !== loadedKey)
    throw new Error(
      "Repository settings changed. Close and reopen this review.",
    );
  const trees = await listWorktrees(ws.projectPath);
  const tree = trees.worktrees.find(
    (t) => pathKey(t.path) === pathKey(target.cwd),
  );
  if (
    !tree ||
    tree.missing ||
    tree.branch !== target.branch ||
    tree.head !== target.head
  )
    throw new Error("Working copy changed. Refresh and review again.");
  const fresh = await probeDelivery(current, { fresh: true });
  if (
    snapshotIdentity(fresh) !== snapshotIdentity(snapshot) ||
    (kind === "ci" && fresh.ciError)
  )
    throw new Error(
      "Provider, revision or CI source changed. Refresh and review again.",
    );
  const chosen = new Set(items.filter((i) => i.selected).map((i) => i.id));
  if (kind === "ci") {
    if (
      JSON.stringify(snapshot.checks.filter((c) => chosen.has(c.id))) !==
      JSON.stringify(fresh.checks.filter((c) => chosen.has(c.id)))
    )
      throw new Error("Selected checks changed. Refresh and review again.");
  } else {
    const latest = await args.evidenceNow(current, fresh);
    if (
      evidenceFingerprint(items.filter((i) => chosen.has(i.id))) !==
      evidenceFingerprint(latest.filter((i) => chosen.has(i.id)))
    )
      throw new Error("Selected comments changed. Refresh and review again.");
  }
  const selected = items.filter((item) => item.selected);
  const fingerprint = evidenceFingerprint(selected);
  if (
    kind === "draft-replies" &&
    (selected.length > 200 || fingerprint.length > 128 * 1024)
  )
    throw new Error(
      "Select fewer threads; a reply request supports 200 threads and 128 KiB of review evidence.",
    );
  let id = recipient;
  let spawned = false;
  if (recipient === "new") {
    let reuse =
      args.reuseSession?.lane === ws.id ? args.reuseSession : undefined;
    if (reuse) {
      // The session may have been deleted or lost its working copy since the
      // failed attempt — reusing a dead id would fail every retry.
      const prior = await getSession(reuse.id).catch(() => undefined);
      if (!prior || !matchesTarget(prior, target)) reuse = undefined;
    }
    if (reuse) id = reuse.id;
    else {
      const created = await args.onSpawn(current);
      if (pathKey(created.worktreePath) !== pathKey(target.cwd))
        throw new Error("New session has a different working copy.");
      id = created.sessionId;
      spawned = true;
      args.onSpawned?.({ lane: ws.id, id });
    }
  }
  const accepted = await args.onSend(
    id,
    handoffPrompt(
      snapshot,
      target,
      kind === "draft-replies"
        ? `${instructions}\n${replyInstructions(requestId, items)}`
        : instructions,
      items,
      kind === "draft-replies",
    ),
    target,
  );
  if (!accepted)
    throw new Error(
      "The agent did not accept the request. Your selection and instructions are preserved.",
    );
  // Bind the session to the lane only after a send it actually received —
  // appending at spawn time leaks empty sessions on any send failure.
  if (taskId)
    updateTask(taskId, (entry) => ({
      workstreams: entry.workstreams.map((w) =>
        w.id === ws.id && spawned && !(w.sessionIds ?? []).includes(id)
          ? { ...w, sessionIds: [...(w.sessionIds ?? []), id] }
          : w,
      ),
      ...(kind === "draft-replies"
        ? {
            replyRequest: {
              id: requestId,
              sessionId: id,
              scope: replyScope(snapshot),
              identity: snapshotIdentity(snapshot),
              fingerprint,
              threadIds: selected.map((item) =>
                item.id.replace(/^comment:/, ""),
              ),
            },
          }
        : {}),
    }));
  return { sessionId: id };
}
