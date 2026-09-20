/**
 * Dedupe concurrent cold starts of one provider thread.
 *
 * A send racing a prewarm (or two sends) shares the same spawn instead of
 * paying it twice. After the shared start settles, the joiner's own
 * `ensureLive` runs again so a plan turn cannot land on a host spawned
 * without plan-mode safeguards, a changed cwd respawns, and stale model
 * settings re-apply.
 */
export async function acquireSharedStart<Live>(
  sessionId: string,
  live: ReadonlyMap<string, Live>,
  starting: Map<string, Promise<Live>>,
  ensureLive: () => Promise<Live>,
  keepExisting = false,
): Promise<Live> {
  if (!live.has(sessionId)) {
    let pending = starting.get(sessionId);
    if (!pending) {
      const started = ensureLive();
      pending = started;
      starting.set(sessionId, started);
      // `finally` would mint a second rejected promise on failure — settle
      // cleanup on the original promise instead.
      const cleanup = () => {
        if (starting.get(sessionId) === started) {
          starting.delete(sessionId);
        }
      };
      started.then(cleanup, cleanup);
    }
    await pending;
  }
  // A prewarm must never recycle: whatever host a racing send spawned —
  // whatever its posture — already satisfies the warm.
  const settled = keepExisting ? live.get(sessionId) : undefined;
  if (settled) return settled;
  return ensureLive();
}
