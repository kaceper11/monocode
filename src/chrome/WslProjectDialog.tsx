import { useEffect, useRef, useState } from "react";
import { wslLocation, wslPath } from "../lib/paths";
import { connectWslProject, wslDistributions, wslDistributionsPeek } from "../lib/wsl";
import { useWslStatus } from "../lib/wslStatus";
import { pickFolder, pickFolders } from "../lib/fs";
import { Select } from "./Select";
import { Modal } from "./Modal";

export function WslProjectDialog({
  cwd,
  multiple,
  onOpen,
  onClose,
}: {
  cwd: string;
  /** Lets the native folder picker return several folders at once. A typed
   * WSL path always delivers a single entry. */
  multiple?: boolean;
  onOpen: (paths: string[]) => void;
  onClose: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const previousFocus = useRef(document.activeElement);
  useEffect(() => {
    const previous = previousFocus.current;
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = form.current
        ?.closest('[role="dialog"]')
        ?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
        );
      if (!controls?.length) return;
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapTab);
    return () => {
      document.removeEventListener("keydown", trapTab);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const current = wslLocation(cwd);
  // A prefetched distribution list mounts the dialog in its final layout
  // instead of flashing a loading frame that resizes under the user.
  const [distributions, setDistributions] = useState<string[]>(
    () => wslDistributionsPeek() ?? [],
  );
  const [distribution, setDistribution] = useState(current?.distribution ?? "");
  const [path, setPath] = useState(current?.path ?? "");
  const [loading, setLoading] = useState(() => wslDistributionsPeek() == null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const wslStatus = useWslStatus(distribution || undefined);
  const request = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    // A manual retry shows the spinner even when a stale list is cached.
    if (wslDistributionsPeek() == null || attempt > 0) setLoading(true);
    setError("");
    void wslDistributions(attempt > 0)
      .then((names) => {
        if (cancelled) return;
        setDistributions(names);
        setDistribution((selected) =>
          selected
            ? (names.find(
                (name) => name.toLowerCase() === selected.toLowerCase(),
              ) ?? selected)
            : "",
        );
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  useEffect(() => () => request.current?.abort(), []);
  const close = () => {
    request.current?.abort();
    onClose();
  };
  const field =
    "h-8 w-full rounded-md border border-content/10 bg-content/5 px-2 text-[13px] text-content outline-none focus:border-content/30 disabled:opacity-50";
  return (
    <Modal
      size="sm"
      className="[&_header_p]:text-content/75"
      title="Open project"
      description="Choose where this repository and its tools run."
      onClose={close}
    >
      <form
        ref={form}
        className="space-y-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || (distribution && loading)) return;
          const controller = new AbortController();
          request.current = controller;
          setBusy(true);
          setError("");
          void Promise.resolve()
            .then(async () => {
              if (distribution)
                return [
                  await connectWslProject(
                    wslPath(distribution, path),
                    controller.signal,
                  ),
                ];
              const selected = await (multiple ? pickFolders() : pickFolder());
              const paths = Array.isArray(selected)
                ? selected
                : selected
                  ? [selected]
                  : null;
              if (paths?.some((picked) => wslLocation(picked)))
                throw new Error(
                  "Choose that WSL distribution as the execution location, then enter its Linux path.",
                );
              return paths;
            })
            .then((canonical) => {
              if (canonical?.length && !controller.signal.aborted) {
                onOpen(canonical);
                onClose();
              }
            })
            .catch((reason) => {
              if (!controller.signal.aborted) setError(String(reason));
            })
            .finally(() => {
              if (!controller.signal.aborted) setBusy(false);
            });
        }}
      >
        <div className="space-y-1 text-[12px] text-content/75">
          <span>Execution location</span>
          <Select
            label="Execution location"
            value={distribution}
            disabled={busy}
            onChange={setDistribution}
            options={[
              { value: "", label: "This Windows PC" },
              ...(distribution && !distributions.includes(distribution)
                ? [
                    {
                      value: distribution,
                      label: `WSL · ${distribution} (unavailable)`,
                    },
                  ]
                : []),
              ...distributions.map((name) => ({
                value: name,
                label: `WSL · ${name}`,
              })),
            ]}
          />
        </div>
        {distribution &&
          wslStatus.state !== "unknown" &&
          !(wslStatus.state === "error" && error) && (
            <p className="text-[12px] text-content/50">
              {wslStatus.state === "connecting"
                ? `Connecting to ${distribution}…`
                : wslStatus.state === "connected"
                  ? `${distribution} is connected.`
                  : wslStatus.state === "disconnected"
                    ? `${distribution} is not connected — opening reconnects it.`
                    : (wslStatus.error ??
                      `Could not reach ${distribution} — opening retries.`)}
            </p>
          )}
        {distribution && (
          <label className="block space-y-1 text-[12px] text-content/75">
            <span>Linux folder</span>
            <input
              className={field}
              value={path}
              disabled={busy}
              placeholder="/home/you/projects/repo"
              required
              spellCheck={false}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
        )}
        {!loading && !distributions.length && !error && (
          <p className="text-[12px] text-content/50">
            No WSL distributions found. Install a Linux distribution to use WSL.
          </p>
        )}
        {error && (
          <p role="alert" className="break-words text-[12px] text-content/80">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 text-[12px]">
          {!loading && (!!error || !distributions.length) && (
            <button
              type="button"
              className="rounded-md px-3 py-1.5 hover:bg-content/8"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-content/75 hover:bg-content/8"
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || Boolean(distribution && (loading || !path))}
            className="rounded-md bg-content px-3 py-1.5 text-background-base disabled:opacity-40"
          >
            {busy ? "Opening…" : distribution ? "Open" : "Browse…"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
