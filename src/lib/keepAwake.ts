import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sessionNeedsInput, type Session } from "./session";

const KEY = "monocode.keepAwake";
export type PowerStatus = {
  supported: boolean;
  enabled: boolean;
  held: boolean;
  working: number;
  error: string | null;
  revision: number;
  loaded: boolean;
};
type BackendStatus = Omit<PowerStatus, "loaded">;
export function loadKeepAwakeEnabled(): boolean {
  try {
    const value = localStorage.getItem(KEY);
    return value === "1" || value === "true";
  } catch {
    return false;
  }
}
let snapshot: PowerStatus = {
  supported: true,
  enabled: loadKeepAwakeEnabled(),
  held: false,
  working: 0,
  error: null,
  revision: 0,
  loaded: false,
};
const listeners = new Set<() => void>();
let bridge: Promise<() => void> | null = null;
export const getPowerStatus = () => snapshot;
function applyStatus(status: BackendStatus) {
  // Revision zero means no window has initialized the saved preference yet.
  if (!status.revision || status.revision < snapshot.revision) return;
  if (
    status.revision === snapshot.revision &&
    snapshot.loaded &&
    status.error === snapshot.error
  )
    return;
  snapshot = { ...status, loaded: true };
  try {
    localStorage.setItem(KEY, status.enabled ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  for (const listener of listeners) listener();
}
function reportError(reason: unknown) {
  snapshot = {
    ...snapshot,
    loaded: true,
    error: reason instanceof Error ? reason.message : String(reason),
  };
  for (const listener of listeners) listener();
}
function ensureBridge() {
  if (bridge) return;
  const pending = listen<BackendStatus>("power-assertion", (event) => {
    if (bridge === pending) applyStatus(event.payload);
  });
  bridge = pending;
  void pending.then(
    async () => {
      const before = snapshot.revision;
      try {
        const status = await invoke<BackendStatus>("power_status");
        if (bridge === pending) applyStatus(status);
      } catch (reason) {
        if (bridge === pending && snapshot.revision === before)
          reportError(reason);
      }
    },
    (reason) => {
      if (bridge === pending) {
        bridge = null;
        reportError(reason);
      }
    },
  );
}
export function subscribePowerStatus(listener: () => void): () => void {
  listeners.add(listener);
  ensureBridge();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && bridge) {
      const closing = bridge;
      bridge = null;
      void closing.then((unlisten) => unlisten()).catch(() => {});
    }
  };
}
export function usePowerStatus() {
  return useSyncExternalStore(
    subscribePowerStatus,
    getPowerStatus,
    getPowerStatus,
  );
}
export async function setKeepAwakeEnabled(enabled: boolean) {
  applyStatus(await invoke<BackendStatus>("power_set_enabled", { enabled }));
}
let latestReport = {
  initialEnabled: loadKeepAwakeEnabled(),
  sessionIds: [] as string[],
};
export async function retryKeepAwake() {
  ensureBridge();
  applyStatus(await invoke<BackendStatus>("power_sync", latestReport));
  applyStatus(await invoke<BackendStatus>("power_retry"));
}

/** Observe upstream execution state, excluding questions, approvals and lost worktrees. */
export function keepAwakeSessionIds(sessions: readonly Session[]): string[] {
  return [
    ...new Set(
      sessions
        .filter(
          (session) =>
            session.busy &&
            !session.worktreeRemoved &&
            !sessionNeedsInput(session),
        )
        .map((session) => session.id),
    ),
  ].sort();
}

/** One app-root hook; native window destruction also releases its report. */
export function useKeepAwake(sessions: readonly Session[]) {
  const status = usePowerStatus();
  const [initialEnabled] = useState(loadKeepAwakeEnabled);
  const ids = status.enabled ? keepAwakeSessionIds(sessions) : [];
  const key = JSON.stringify(ids);
  useEffect(() => {
    latestReport = {
      initialEnabled,
      sessionIds: JSON.parse(key),
    };
    let current = true;
    void invoke<BackendStatus>("power_sync", latestReport)
      .then(applyStatus)
      .catch((reason) => {
        if (current) reportError(reason);
      });
    return () => {
      current = false;
    };
  }, [key]);
  useEffect(
    () => () => {
      latestReport = { initialEnabled, sessionIds: [] };
      void invoke<BackendStatus>("power_sync", latestReport).catch(() => {});
    },
    [],
  );
}
