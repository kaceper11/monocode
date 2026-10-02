import { useSyncExternalStore } from "react";
import {
  errorRateLimits,
  fetchingRateLimits,
  idleRateLimits,
  type ProviderRateLimits,
  type RateLimitProvider,
} from "./rateLimits";
import {
  fetchClaudeRateLimits,
  fetchCodexRateLimits,
  fetchOpencodeGoRateLimits,
  fetchAdditionalRateLimits,
} from "./rateLimitsFetch";

const snapshots = new Map<string, ProviderRateLimits>();
const pending = new Map<string, Promise<ProviderRateLimits>>();
const queuedRefreshes = new Map<string, Promise<ProviderRateLimits>>();
const listeners = new Set<() => void>();
let allSnapshots: Record<string, ProviderRateLimits> = {};

function keyFor(provider: RateLimitProvider, accountId: string, sessionId?: string): string {
  const session = provider === "muse" ? sessionId : undefined;
  return session ? `${provider}:${accountId}:${JSON.stringify(session)}` : `${provider}:${accountId}`;
}

function publish(key: string, value: ProviderRateLimits): void {
  snapshots.set(key, value);
  allSnapshots = { ...allSnapshots, [key]: value };
  for (const listener of listeners) listener();
}

export function subscribeRateLimits(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAllRateLimits(): Record<string, ProviderRateLimits> {
  return allSnapshots;
}

export function getCachedRateLimits(
  provider: RateLimitProvider,
  accountId = "default",
  sessionId?: string,
): ProviderRateLimits {
  return snapshots.get(keyFor(provider, accountId, sessionId)) ?? idle[provider];
}

const idle: Record<RateLimitProvider, ProviderRateLimits> = {
  claude: idleRateLimits("claude"),
  codex: idleRateLimits("codex"),
  opencode: idleRateLimits("opencode"),
  copilot: idleRateLimits("copilot"),
  muse: idleRateLimits("muse"),
  devin: idleRateLimits("devin"),
};

export function useCachedRateLimits(
  provider: RateLimitProvider,
  accountId = "default",
  sessionId?: string,
): ProviderRateLimits {
  return useSyncExternalStore(
    subscribeRateLimits,
    () => getCachedRateLimits(provider, accountId, sessionId),
    () => getCachedRateLimits(provider, accountId, sessionId),
  );
}

export function setCachedRateLimits(
  provider: RateLimitProvider,
  accountId: string,
  value: ProviderRateLimits,
  sessionId?: string,
): void {
  publish(keyFor(provider, accountId, sessionId), value);
}

/** Fetch an account once per window lifetime, or again on explicit refresh. */
export function loadRateLimits(
  provider: RateLimitProvider,
  accountId = "default",
  force = false,
  cwd?: string,
  sessionId?: string,
): Promise<ProviderRateLimits> {
  const key = keyFor(provider, accountId, sessionId);
  const running = pending.get(key);
  if (running) {
    if (!force) return running;
    const queued = queuedRefreshes.get(key);
    if (queued) return queued;
    const next = running.then(() => loadRateLimits(provider, accountId, true, cwd, sessionId));
    queuedRefreshes.set(key, next);
    void next.finally(() => {
      if (queuedRefreshes.get(key) === next) queuedRefreshes.delete(key);
    });
    return next;
  }
  const cached = snapshots.get(key);
  if (cached && !force) return Promise.resolve(cached);

  publish(key, fetchingRateLimits(provider, cached));
  const run = (async () => {
    try {
      const result =
        provider === "claude"
          ? await fetchClaudeRateLimits(accountId)
          : provider === "codex"
            ? await fetchCodexRateLimits(accountId)
            : provider === "opencode"
              ? await fetchOpencodeGoRateLimits()
              : await fetchAdditionalRateLimits(provider, cwd, sessionId);
      publish(key, result);
      return result;
    } catch (error) {
      const result = errorRateLimits(
        provider,
        error instanceof Error ? error.message : String(error),
        getCachedRateLimits(provider, accountId, sessionId),
      );
      publish(key, result);
      return result;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, run);
  return run;
}

/** Also used when an account is removed and by tests that need a clean cache. */
export function clearCachedRateLimits(
  provider?: RateLimitProvider,
  accountId?: string,
): void {
  if (provider && accountId) {
    const prefix = `${provider}:${accountId}`;
    for (const key of snapshots.keys()) {
      if (key !== prefix && !key.startsWith(prefix + ":")) continue;
      snapshots.delete(key);
      const { [key]: _removed, ...rest } = allSnapshots;
      allSnapshots = rest;
    }
  } else {
    snapshots.clear();
    allSnapshots = {};
  }
  for (const listener of listeners) listener();
}
