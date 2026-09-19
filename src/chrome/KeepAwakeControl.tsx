import { useState } from "react";
import {
  retryKeepAwake,
  setKeepAwakeEnabled,
  usePowerStatus,
} from "../lib/keepAwake";

/** The backend owns the setting and the single assertion across all windows. */
export function KeepAwakeControl() {
  const status = usePowerStatus();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {status.enabled && status.held ? (
        <span className="text-[12px] text-content/45">
          Active · {status.working} {status.working === 1 ? "agent" : "agents"}{" "}
          working
        </span>
      ) : null}
      {status.loaded && !status.supported ? (
        <span className="text-[12px] text-content/45">
          Not available on this platform
        </span>
      ) : null}
      {error || status.error ? (
        <span role="alert" className="text-[12px] text-content/60">
          {error || status.error}
        </span>
      ) : null}
      {status.supported && (status.error || error) ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void run(retryKeepAwake)}
          className="rounded border border-content/15 px-2 py-1 text-[12px] disabled:opacity-40"
        >
          Retry
        </button>
      ) : null}
      <button
        type="button"
        role="switch"
        aria-label="Keep computer awake while agents work"
        aria-checked={status.enabled}
        disabled={!status.loaded || pending}
        onClick={() => void run(() => setKeepAwakeEnabled(!status.enabled))}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${status.enabled ? "bg-accent" : "bg-content/20"}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${status.enabled ? "left-4.5" : "left-0.5"}`}
        />
      </button>
    </div>
  );
}
