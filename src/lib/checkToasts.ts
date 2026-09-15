import type { Session } from "./session";
import type { CheckRunRecord } from "./verify";

/**
 * Transient in-app toasts for check outcomes that need attention — the
 * attention queue row persists, these cards are the "look here" cue and
 * expire on their own. Only actionable outcomes (failed/timeout/error)
 * toast; a pass lands in the queue quietly.
 */

export type CheckToast = {
  id: string;
  sessionId: string;
  runId: string;
  title: string;
  harness: Session["harness"];
  commandName: string;
  status: "failed" | "timeout" | "error";
  detail: string;
  at: number;
};

const TOAST_TTL = 12_000;
const MAX_TOASTS = 4;

let toasts: CheckToast[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeCheckToasts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCheckToasts(): CheckToast[] {
  return toasts;
}

export function dismissCheckToast(id: string) {
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function pushCheckToast(
  run: CheckRunRecord,
  session: Session,
  now = Date.now(),
) {
  if (
    run.status !== "failed" &&
    run.status !== "timeout" &&
    run.status !== "error"
  )
    return;
  const toast: CheckToast = {
    id: run.id,
    sessionId: session.id,
    runId: run.id,
    title: session.title,
    harness: session.harness,
    commandName: run.commandName,
    status: run.status,
    detail: run.detail ?? "",
    at: now,
  };
  // One toast per run — a re-emit refreshes it rather than duplicating.
  toasts = [...toasts.filter((entry) => entry.id !== toast.id), toast].slice(
    -MAX_TOASTS,
  );
  emit();
  setTimeout(() => dismissCheckToast(toast.id), TOAST_TTL);
}

/** Test seam — drop live toasts between cases. */
export function resetCheckToasts() {
  toasts = [];
  emit();
}
