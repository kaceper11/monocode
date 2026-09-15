import type { HarnessEvent } from "./harness/types";
/**
 * Greppable per-turn stage timings in devtools:
 * `[turn abcd1234] stage +12ms (total 345ms)`.
 *
 * Marks are keyed by session id so App, the registry, and harness adapters
 * share one timeline without threading a timer through every call. No-ops
 * once the turn settles or when no turn is being timed.
 */

export type TurnClock = {
  id: string;
  t0: number;
  last: number;
  harness: string;
  firstEvent: boolean;
  contentReceivedAt?: number;
  messageRendered: boolean;
  contentRendered: boolean;
  contentApplied: boolean;
};

const turns = new Map<string, TurnClock>();

/**
 * Start a clock for a turn. The returned token identifies this clock — pass
 * it to `endTurnTiming` so a slow-finishing superseded turn cannot delete a
 * newer turn's clock.
 */
export function beginTurnTiming(
  sessionId: string,
  harness: string,
  id: string = crypto.randomUUID(),
  submittedAt = performance.now(),
): TurnClock {
  const now = performance.now();
  const clock: TurnClock = {
    id,
    t0: submittedAt,
    last: now,
    harness,
    firstEvent: false,
    messageRendered: false,
    contentRendered: false,
    contentApplied: false,
  };
  turns.set(sessionId, clock);
  return clock;
}

export function markTurn(sessionId: string, stage: string): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  const now = performance.now();
  console.debug(
    `[turn ${turn.harness} ${sessionId.slice(0, 8)} ${turn.id}] ${stage} ` +
      `+${(now - turn.last).toFixed(0)}ms (total ${(now - turn.t0).toFixed(0)}ms)`,
  );
  turn.last = now;
}

/** First provider event the user could see — the latency that matters. */
export function markFirstTurnEvent(
  sessionId: string,
  event: HarnessEvent,
): void {
  if (
    !(
      (event.type === "message.delta" || event.type === "reasoning.delta") &&
      event.text.length > 0
    ) &&
    event.type !== "tool.started" &&
    event.type !== "plan"
  )
    return;
  const turn = turns.get(sessionId);
  if (!turn || turn.firstEvent) return;
  turn.firstEvent = true;
  turn.contentReceivedAt = performance.now();
  markTurn(sessionId, "first content received");
}

/** Called when the received content has entered React's transcript state. */
export function markTurnContentApplied(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (turn?.contentReceivedAt != null) turn.contentApplied = true;
}

/** Called after React commits the transcript DOM, never on a status/handshake. */
export function markTurnRendered(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  if (!turn.messageRendered) {
    turn.messageRendered = true;
    markTurn(sessionId, "submitted message rendered");
  }
  if (
    turn.contentApplied &&
    turn.contentReceivedAt != null &&
    !turn.contentRendered
  ) {
    turn.contentRendered = true;
    markTurn(
      sessionId,
      `first content rendered (bridge to DOM ${(performance.now() - turn.contentReceivedAt).toFixed(0)}ms)`,
    );
  }
}

export function endTurnTiming(
  sessionId: string,
  outcome = "settled",
  clock?: TurnClock,
): void {
  // A superseded turn's finally must not wipe a newer turn's clock.
  if (clock && turns.get(sessionId) !== clock) return;
  markTurn(sessionId, outcome);
  turns.delete(sessionId);
}
