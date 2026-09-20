import { useSyncExternalStore } from "react";

/**
 * Shared per-distribution WSL connection state. Fed by `wsl_connect` results,
 * `wsl_connected` checks and `wsl:disconnected` events so the banner, badge
 * and project dialog all describe the same connection.
 */

export type WslConnectionState =
  | "unknown"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type WslStatus = {
  state: WslConnectionState;
  error?: string;
};

const UNKNOWN: WslStatus = { state: "unknown" };

/** Keyed by lower-cased distribution name — never by path. */
const statuses = new Map<string, WslStatus>();
const listeners = new Set<() => void>();

export function setWslStatus(
  distribution: string,
  status: WslStatus,
): void {
  const key = distribution.toLowerCase();
  const previous = statuses.get(key);
  if (previous?.state === status.state && previous?.error === status.error)
    return;
  statuses.set(key, status);
  for (const listener of listeners) listener();
}

export function wslStatusFor(distribution: string): WslStatus {
  return statuses.get(distribution.toLowerCase()) ?? UNKNOWN;
}

export function subscribeWslStatus(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function useWslStatus(distribution: string | undefined): WslStatus {
  return useSyncExternalStore(subscribeWslStatus, () =>
    distribution ? wslStatusFor(distribution) : UNKNOWN,
  );
}
