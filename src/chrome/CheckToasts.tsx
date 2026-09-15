import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LAYER } from "../lib/layers";
import {
  dismissCheckToast,
  getCheckToasts,
  subscribeCheckToasts,
  type CheckToast,
} from "../lib/checkToasts";
import { sessionDisplayTitle } from "../lib/session";
import { HarnessIcon } from "./HarnessIcon";
import { CircleAlert, CircleX } from "./icons";

type Props = {
  topOffset?: number;
  onFocusSession: (sessionId: string) => void;
};

const STATUS_LABEL: Record<CheckToast["status"], string> = {
  failed: "Checks failed",
  timeout: "Timed out",
  error: "Didn't run",
};

export function CheckToasts({ onFocusSession, topOffset = 12 }: Props) {
  const toasts = useSyncExternalStore(subscribeCheckToasts, getCheckToasts);
  if (toasts.length === 0) return null;

  return createPortal(
    <div
      aria-live="polite"
      data-app-overlay
      style={{ zIndex: LAYER.toast, top: topOffset }}
      className="pointer-events-none fixed right-3 flex w-[min(360px,calc(100vw-24px))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <CheckToastCard
          key={toast.id}
          toast={toast}
          onFocusSession={onFocusSession}
        />
      ))}
    </div>,
    document.body,
  );
}

function CheckToastCard({
  toast,
  onFocusSession,
}: {
  toast: CheckToast;
  onFocusSession: Props["onFocusSession"];
}) {
  const title = sessionDisplayTitle(toast.title, toast.harness);
  const failed = toast.status !== "error";

  const openSession = () => {
    dismissCheckToast(toast.id);
    onFocusSession(toast.sessionId);
  };

  return (
    <article
      className="pointer-events-auto overflow-hidden rounded-xl border border-content/20 border-dashed bg-content/10 shadow-xl backdrop-blur-xl"
      role="status"
    >
      <div className="flex items-start gap-2 px-3.5 py-3">
        <button
          type="button"
          onClick={openSession}
          className="flex min-w-0 flex-1 flex-col gap-1.5 text-left hover:opacity-80"
        >
          <span className="flex items-center gap-2">
            <HarnessIcon harness={toast.harness} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug text-content">
              {title}
            </span>
            <span
              className={`flex shrink-0 items-center gap-1 text-[11px] ${
                failed ? "text-red-400" : "text-amber-400"
              }`}
            >
              <CircleAlert className="size-3.5" strokeWidth={1.75} />
              <span>{STATUS_LABEL[toast.status]}</span>
            </span>
          </span>
          <span className="truncate text-[12px] leading-relaxed text-content/70">
            {toast.commandName}
            {toast.detail ? ` · ${toast.detail}` : ""}
          </span>
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => dismissCheckToast(toast.id)}
          className="mt-0.5 shrink-0 text-content/40 hover:text-content"
        >
          <CircleX className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </article>
  );
}
