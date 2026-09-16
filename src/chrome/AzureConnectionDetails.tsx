import type { ReactNode } from "react";
import { emit } from "@tauri-apps/api/event";
import type { AzureStatus } from "../lib/azure";
import { ReviewDetails, reviewButton } from "./ReviewChrome";

/**
 * Collapsed connection/account block shared by the Azure PR and CI surfaces —
 * opens itself while disconnected, stays out of the way otherwise.
 */
export function AzureConnectionDetails({
  label,
  status,
  connected,
  connectHint,
  onLeave,
  onError,
  children,
}: {
  label: string;
  status?: AzureStatus;
  connected: boolean;
  connectHint: string;
  /** Called after settings open so the caller can close the surface. */
  onLeave: () => void;
  onError: (message: string) => void;
  children?: ReactNode;
}) {
  return (
    <ReviewDetails
      open={status ? !connected : false}
      summary={
        <>
          {label}
          {status
            ? connected && status.account
              ? ` · ${status.account}`
              : " · Connect account"
            : " · Checking…"}
        </>
      }
    >
      <p className="break-words text-content/60">
        {status
          ? connected
            ? `${status.account} · ${status.site} · credentials on this device`
            : connectHint
          : "Checking Azure connection…"}
      </p>
      {children}
      <button
        className={reviewButton}
        onClick={() => {
          void emit("open_settings", { section: "general" })
            .then(onLeave)
            .catch((error) =>
              onError(error instanceof Error ? error.message : String(error)),
            );
        }}
      >
        {connected ? "Connection settings" : "Connect Azure DevOps"}
      </button>
    </ReviewDetails>
  );
}
