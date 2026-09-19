import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Gauge, Square, X } from "./icons";
import { Popover } from "./Popover";
import {
  formatCpu,
  formatMem,
  sampleTerminalResources,
  stopTerminalWorkload,
  type FooterTerminal,
  type PtyResource,
} from "../lib/terminalResources";
import {
  savedCommandRunsSnapshot,
  subscribeSavedCommandRuns,
} from "../lib/savedCommandRun";

type Props = {
  terminals: FooterTerminal[];
  onOpen: (id: string) => void;
  onClose: (terminal: FooterTerminal) => void;
};
export function TerminalResourcesControl(props: Props) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1 hover:bg-content/10 hover:text-content"
        onClick={() => setOpen((value) => !value)}
        title="Terminal processes and resource usage"
      >
        <Gauge className="size-3.5" aria-hidden />
        Resources{props.terminals.length ? ` (${props.terminals.length})` : ""}
      </button>
      {open && (
        <TerminalResourcesManager
          {...props}
          anchor={anchor}
          onDismiss={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function TerminalResourcesManager({
  terminals,
  onOpen,
  onClose,
  anchor,
  onDismiss,
}: Props & {
  anchor: RefObject<HTMLButtonElement | null>;
  onDismiss: () => void;
}) {
  const idsKey = JSON.stringify(terminals.map((terminal) => terminal.id));
  const [sample, setSample] = useState<{
    key: string;
    rows: PtyResource[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const stoppingRef = useRef(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(0);
  const alive = useRef(false);
  const runs = useSyncExternalStore(
    subscribeSavedCommandRuns,
    savedCommandRunsSnapshot,
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let closed = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () => !closed && document.visibilityState === "visible";
    const poll = async () => {
      if (timer) clearTimeout(timer);
      if (!active() || running) return;
      if (idsKey === "[]") {
        setSample({ key: idsKey, rows: [] });
        return;
      }
      running = true;
      try {
        const rows = await sampleTerminalResources(
          JSON.parse(idsKey) as string[],
          active,
        );
        if (active() && rows) {
          setSample({ key: idsKey, rows });
          setSampleError(null);
        }
      } catch (cause) {
        if (active()) {
          setSample(null);
          setSampleError(String(cause));
        }
      } finally {
        running = false;
        if (active()) timer = setTimeout(() => void poll(), 1500);
      }
    };
    const visibility = () => {
      if (active()) void poll();
      else {
        if (timer) clearTimeout(timer);
        setSample(null);
      }
    };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [idsKey, refresh]);
  const byId = new Map(
    (sample?.key === idsKey ? sample.rows : []).map((row) => [row.id, row]),
  );
  const activeRuns = new Set(
    runs
      .filter((run) => run.status === "queued" || run.status === "running")
      .map((run) => run.terminalId),
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(terminals.length / 50) - 1),
  );
  const stop = async (row: Pick<PtyResource, "id" | "generation">) => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(row.id);
    setError(null);
    try {
      await stopTerminalWorkload(row, () => alive.current);
    } catch (cause) {
      if (alive.current) setError(String(cause));
    } finally {
      stoppingRef.current = false;
      if (alive.current) {
        setStopping(null);
        setSample(null);
        setRefresh((value) => value + 1);
      }
    }
  };
  const action =
    "grid size-7 shrink-0 place-items-center rounded hover:bg-content/10 focus-visible:outline focus-visible:outline-2 disabled:opacity-35";
  return (
    <Popover
      anchor={anchor}
      side="top"
      align="end"
      width={440}
      autoFocus
      tabIndex={-1}
      onDismiss={onDismiss}
      role="dialog"
      aria-label="Terminal resources"
      className="overflow-y-auto overscroll-none p-2 text-content"
    >
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <span className="text-xs font-medium">Terminal resources</span>
        <button
          type="button"
          className={action}
          aria-label="Close resource manager"
          onClick={onDismiss}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {(error || sampleError) && (
        <p
          role="alert"
          className="mb-2 break-words px-1 text-xs text-red-700 dark:text-red-400"
        >
          {error || sampleError}
        </p>
      )}
      {!terminals.length && (
        <p className="p-2 text-xs text-content/80">
          No terminals in this workspace.
        </p>
      )}
      {terminals
        .slice(currentPage * 50, (currentPage + 1) * 50)
        .map((terminal) => {
          const row = byId.get(terminal.id);
          const saved = activeRuns.has(terminal.id);
          const state =
            !row || row.error
              ? "Unknown"
              : !row.alive
                ? "Exited"
                : saved || row.workload
                  ? "Running"
                  : "Idle";
          return (
            <div
              key={terminal.id}
              className="rounded-lg px-1 py-1 hover:bg-content/5"
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded px-1 py-1 text-left hover:bg-content/10"
                  onClick={() => {
                    onOpen(terminal.id);
                    onDismiss();
                  }}
                  title={`${terminal.cwd}${row?.host === "wsl" ? ` · WSL ${row.distro}` : ""}`}
                >
                  <span className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate font-medium">
                      {terminal.title}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums">
                      {row?.alive && !row.error
                        ? `${formatCpu(row.cpuPct)} · ${formatMem(row.rssBytes)}`
                        : "—"}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-content/80">
                    {state}
                    {row?.alive &&
                    !row.error &&
                    (row.top || terminal.foreground)
                      ? ` · ${row.top ?? terminal.foreground}`
                      : ""}
                    {row?.alive && !row.error && row.processes != null
                      ? ` · ${row.processes} ${row.processes === 1 ? "process" : "processes"}`
                      : ""}
                    {row?.host === "wsl" ? ` · WSL ${row.distro}` : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className={action}
                  aria-label={`Stop workload in ${terminal.title}`}
                  title={
                    saved
                      ? "Stop saved command sequence"
                      : "Stop workload; keep shell open"
                  }
                  disabled={
                    !!stopping ||
                    !row ||
                    (!saved &&
                      (!row.workload || !!row.error || !row.generation))
                  }
                  onClick={() =>
                    void stop(row ?? { id: terminal.id, generation: null })
                  }
                >
                  <Square className="size-3" aria-hidden />
                </button>
                <button
                  type="button"
                  className={action}
                  aria-label={`Close terminal ${terminal.title}`}
                  title="Close terminal"
                  onClick={() => {
                    onClose(terminal);
                    onDismiss();
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
              {row?.error && (
                <p className="mt-1 break-words px-1 text-[11px] text-red-700 dark:text-red-400">
                  {row.error}
                </p>
              )}
            </div>
          );
        })}
      {terminals.length > 50 && (
        <div className="mt-2 flex items-center justify-between px-1 text-xs">
          <button
            type="button"
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span>
            {currentPage + 1} / {Math.ceil(terminals.length / 50)}
          </span>
          <button
            type="button"
            disabled={(currentPage + 1) * 50 >= terminals.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}
      <p className="mt-2 border-t border-content/10 px-1 pt-2 text-[10px] text-content/80">
        CPU is per core. Usage refreshes while this panel is visible.
      </p>
    </Popover>
  );
}
