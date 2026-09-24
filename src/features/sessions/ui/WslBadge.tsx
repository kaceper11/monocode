import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { pathKey, wslLocation } from "../../../shared/lib/paths";
import { connectWslProject } from "../model/wsl";
import { setWslStatus, useWslStatus, wslStatusFor } from "../model/wslStatus";
import { Popover } from "../../../shared/ui/Popover.tsx";

export function WslBadge({
  cwd,
  compact = false,
}: {
  cwd: string;
  compact?: boolean;
}) {
  const location = wslLocation(cwd);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const status = useWslStatus(location?.distribution);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setOpen(false);
    setBusy(false);
    setError("");
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [cwd]);
  useEffect(() => {
    if (!location) return;
    let cancelled = false;
    // Probes take time; only publish when nothing fresher landed meanwhile
    // (a connect in flight or a finished one outranks an older probe).
    const before = wslStatusFor(location.distribution);
    if (before.state === "connecting") return;
    void invoke<boolean>("wsl_connected", {
      distribution: location.distribution,
    })
      .then((value) => {
        if (cancelled || wslStatusFor(location.distribution) !== before) return;
        setWslStatus(location.distribution, {
          state: value ? "connected" : "disconnected",
        });
      })
      .catch((reason) => {
        if (cancelled || wslStatusFor(location.distribution) !== before) return;
        setWslStatus(location.distribution, {
          state: "error",
          error: String(reason),
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.distribution]);
  if (!location) return null;
  const offline =
    status.state === "disconnected" || status.state === "error";
  const label =
    status.state === "connecting"
      ? "WSL · connecting…"
      : offline
        ? "WSL · offline"
        : compact
          ? "WSL"
          : `WSL · ${location.distribution}`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-no-drag
        title={`WSL · ${location.distribution}`}
        aria-label={`WSL · ${location.distribution} environment`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className={`my-auto max-w-28 shrink-0 truncate rounded bg-content/5 px-1.5 py-0.5 text-[10px] outline-none hover:bg-content/10 focus-visible:ring-1 focus-visible:ring-content/30 ${
          offline ? "italic text-content/80" : "text-content"
        }`}
      >
        {label}
      </button>
      {open && (
        <Popover
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          anchor={anchor}
          side="bottom"
          width={280}
          role="dialog"
          aria-label="WSL environment"
          className="space-y-2 p-3 text-[12px]"
          onDismiss={() => {
            setOpen(false);
            anchor.current?.focus();
          }}
        >
          <p className="font-medium text-content">
            WSL · {location.distribution}
          </p>
          <p className="break-all text-content/60">{location.path}</p>
          <p className="text-content/60">
            {status.state === "connecting"
              ? "Connecting…"
              : status.state === "connected"
                ? "Connected · Linux files, Git and agents"
                : status.state === "disconnected"
                  ? "Disconnected"
                  : status.state === "error"
                    ? "Connection failed"
                    : "Checking connection…"}
          </p>
          <p className="text-content/75">
            Browser links open on Windows. Localhost access depends on WSL
            networking; MonoCode does not forward ports. Open Linux editors from
            the terminal.
          </p>
          {(error || status.error) && (
            <p role="alert" className="break-words text-content/80">
              {error || status.error}
            </p>
          )}
          <button
            type="button"
            disabled={busy || status.state === "connecting"}
            className="rounded-md bg-content/8 px-2 py-1 text-content/75 hover:bg-content/12 disabled:opacity-40"
            onClick={() => {
              const controller = new AbortController();
              request.current = controller;
              setBusy(true);
              setError("");
              void connectWslProject(cwd, controller.signal, true)
                .then((canonical) => {
                  if (pathKey(canonical) !== pathKey(cwd))
                    throw new Error(
                      "This folder resolves to a different path. Choose it again from Open project.",
                    );
                })
                .catch((reason) => {
                  if (!controller.signal.aborted) setError(String(reason));
                })
                .finally(() => {
                  if (request.current === controller) {
                    request.current = null;
                    setBusy(false);
                  }
                });
            }}
          >
            {busy || status.state === "connecting"
              ? "Connecting…"
              : status.state === "connected"
                ? "Check connection"
                : "Reconnect"}
          </button>
        </Popover>
      )}
    </>
  );
}
