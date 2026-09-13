import { RefreshCw, Stop, X } from "./icons";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { HarnessIcon } from "./HarnessIcon";
import { Popover } from "./Popover";
import {
  fetchClaudeRateLimits,
  fetchCodexRateLimits,
} from "../lib/rateLimitsFetch";
import {
  clampUsedPercent,
  fetchingRateLimits,
  formatRateLimitWindowChipLabel,
  formatUsagePercent,
  idleRateLimits,
  RATE_LIMIT_POLL_MS,
  rateLimitWindowTooltip,
  shouldFetchProvider,
  type ProviderRateLimits,
  type RateLimitProvider,
  type RateLimitWindow,
} from "../lib/rateLimits";
import { HARNESS_LABEL, HARNESS_TITLE, type HarnessId } from "../lib/session";
import { runningTerminalChipLabel } from "../lib/terminalTab";
import {
  getPtyResources,
  killPtyWorkload,
  type PtyResource,
} from "../lib/pty";
import {
  formatCpu,
  formatMem,
  mergeTerminalRows,
  type FooterTerminal,
} from "../lib/terminalResources";

const CLOCK_MS = 30_000;

export type UsageFooterSession = {
  harness: HarnessId;
};

export function UsageFooter({
  providers,
  session,
  terminals = [],
  onOpenTerminal,
  onCloseTerminal,
}: {
  providers: RateLimitProvider[];
  session?: UsageFooterSession;
  terminals?: FooterTerminal[];
  onOpenTerminal?: (fileId: string) => void;
  onCloseTerminal?: (fileId: string) => void;
}) {
  const wantClaude = providers.includes("claude");
  const wantCodex = providers.includes("codex");
  const [claude, setClaude] = useState<ProviderRateLimits>(() =>
    idleRateLimits("claude"),
  );
  const [codex, setCodex] = useState<ProviderRateLimits>(() =>
    idleRateLimits("codex"),
  );
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const inflight = useRef<Promise<void> | null>(null);
  const claudeRef = useRef(claude);
  const codexRef = useRef(codex);
  claudeRef.current = claude;
  codexRef.current = codex;

  const refresh = useCallback((force = false) => {
    if (inflight.current) return inflight.current;
    const visible = document.visibilityState === "visible";
    const fetchClaude =
      wantClaude &&
      shouldFetchProvider(claudeRef.current, { force, visible });
    const fetchCodex =
      wantCodex &&
      shouldFetchProvider(codexRef.current, { force, visible });
    if (!fetchClaude && !fetchCodex) return;
    if (force) setRefreshing(true);
    const jobs: Promise<void>[] = [];
    if (fetchClaude) {
      setClaude((current) => fetchingRateLimits("claude", current));
      jobs.push(
        fetchClaudeRateLimits().then((value) => {
          setClaude(value);
        }),
      );
    }
    if (fetchCodex) {
      setCodex((current) => fetchingRateLimits("codex", current));
      jobs.push(
        fetchCodexRateLimits().then((value) => {
          setCodex(value);
        }),
      );
    }
    const run = Promise.allSettled(jobs)
      .then(() => undefined)
      .finally(() => {
        inflight.current = null;
        setRefreshing(false);
      });
    inflight.current = run;
    return run;
  }, [wantClaude, wantCodex]);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), RATE_LIMIT_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const showUsage = wantClaude || wantCodex;
  const showTerminals = terminals.length > 0;
  const showRight = showUsage || showTerminals;
  const ariaLabel = showUsage
    ? "Provider usage"
    : showTerminals
      ? "Terminals"
      : session
        ? "Session"
        : undefined;

  return (
    <footer
      aria-label={ariaLabel}
      className="flex h-7 shrink-0 items-center gap-3 overflow-x-auto border-t border-content/10 px-3 text-[11px] text-content/55"
    >
      {showUsage ? (
        <>
          {wantClaude ? <ProviderChip limits={claude} now={now} /> : null}
          {wantCodex ? <ProviderChip limits={codex} now={now} /> : null}
        </>
      ) : session ? (
        <SessionChip session={session} />
      ) : null}
      {showRight ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {showTerminals ? (
            <TerminalChip
              terminals={terminals}
              onOpen={onOpenTerminal}
              onClose={onCloseTerminal}
            />
          ) : null}
          {showUsage ? (
            <button
              type="button"
              className="grid size-5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-50"
              aria-label="Refresh usage"
              title="Refresh usage"
              disabled={refreshing}
              onClick={() => void refresh(true)}
            >
              <RefreshCw
                className={`size-3 ${refreshing ? "animate-spin" : ""}`}
                strokeWidth={1.75}
                aria-hidden
              />
            </button>
          ) : null}
        </div>
      ) : null}
    </footer>
  );
}

function TerminalLiveMark() {
  return (
    <span className="terminal-live shrink-0" aria-hidden>
      <span className="terminal-live-bar" />
      <span className="terminal-live-bar" />
      <span className="terminal-live-bar" />
    </span>
  );
}

function SessionChip({ session }: { session: UsageFooterSession }) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap"
      title={HARNESS_TITLE[session.harness]}
    >
      <HarnessIcon harness={session.harness} className="size-3 shrink-0" />
      <span>{HARNESS_LABEL[session.harness]}</span>
    </span>
  );
}

const RESOURCE_POLL_MS = 1500;

function TerminalChip({
  terminals,
  onOpen,
  onClose,
}: {
  terminals: FooterTerminal[];
  onOpen?: (fileId: string) => void;
  onClose?: (fileId: string) => void;
}) {
  const root = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const processes = terminals.flatMap((terminal) =>
    terminal.foreground ? [terminal.foreground] : [],
  );
  const label = processes.length
    ? runningTerminalChipLabel(processes)
    : terminals.length === 1
      ? "1 terminal"
      : `${terminals.length} terminals`;
  const ariaLabel = menuOpen
    ? "Hide terminal manager"
    : `${terminals.length} terminal${terminals.length === 1 ? "" : "s"}`;

  const open = (fileId: string) => {
    setMenuOpen(false);
    onOpen?.(fileId);
  };

  return (
    <>
      <button
        ref={root}
        type="button"
        className="inline-flex min-w-0 max-w-[16rem] items-center gap-1.5 whitespace-nowrap rounded px-1 -mx-1 hover:bg-content/10 hover:text-content"
        aria-label={ariaLabel}
        aria-expanded={menuOpen}
        aria-haspopup="dialog"
        title="Terminals"
        onClick={() => setMenuOpen((value) => !value)}
      >
        {processes.length ? <TerminalLiveMark /> : null}
        <span className="truncate font-mono text-[10px] tabular-nums">
          {label}
        </span>
      </button>
      {menuOpen ? (
        <TerminalManager
          anchor={root}
          terminals={terminals}
          onOpen={open}
          onClose={onClose}
          onDismiss={() => setMenuOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Compact activity monitor for the window's terminals. Polls one shared
 * process sample while open — closing the panel stops all sampling. */
function TerminalManager({
  anchor,
  terminals,
  onOpen,
  onClose,
  onDismiss,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  terminals: FooterTerminal[];
  onOpen: (fileId: string) => void;
  onClose?: (fileId: string) => void;
  onDismiss: () => void;
}) {
  const [resources, setResources] = useState<PtyResource[] | null>(null);
  const [killing, setKilling] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(false);
  /** Bumped by every request — a slower earlier response never overwrites
   * a newer one (e.g. a pre-kill poll landing after the kill refresh),
   * and only the newest request may clear the in-flight guard. */
  const seq = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      if (stopped) return;
      // Hidden: stop the chain — visibilitychange re-arms it. In-flight:
      // the active request's finally already schedules the next tick.
      if (document.visibilityState !== "visible") return;
      if (inFlight.current) {
        timer = setTimeout(poll, RESOURCE_POLL_MS);
        return;
      }
      inFlight.current = true;
      const my = ++seq.current;
      void getPtyResources()
        .then((found) => {
          if (seq.current === my) setResources(found);
        })
        .catch(() => undefined)
        .finally(() => {
          if (seq.current === my) inFlight.current = false;
          if (!stopped) timer = setTimeout(poll, RESOURCE_POLL_MS);
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    poll();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const rows = mergeTerminalRows(terminals, resources);

  const kill = (fileId: string) => {
    inFlight.current = true;
    const my = ++seq.current;
    setKilling((prev) => new Set(prev).add(fileId));
    void killPtyWorkload(fileId)
      .then(() => getPtyResources())
      .then((found) => {
        if (seq.current === my) setResources(found);
      })
      .catch((error) => console.warn("Kill workload failed:", error))
      .finally(() => {
        if (seq.current === my) inFlight.current = false;
        setKilling((prev) => {
          const next = new Set(prev);
          next.delete(fileId);
          return next;
        });
      });
  };

  return (
    <Popover
      anchor={anchor}
      side="top"
      align="end"
      autoFocus
      tabIndex={-1}
      onDismiss={onDismiss}
      role="dialog"
      aria-label="Terminals"
      className="w-[22rem] overflow-y-auto overscroll-none p-1"
    >
      <div className="flex h-6 items-center px-2 text-[10px] font-medium uppercase tracking-wide text-content/40">
        Terminals
      </div>
      {rows.map((row) => {
        const process = row.top ?? row.foreground;
        return (
          <div
            key={row.id}
            className="flex h-8 items-center gap-2 rounded-lg px-2 text-[12px] leading-none text-content hover:bg-content/10"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title={
                row.alive
                  ? `${row.title} — ${row.cwd}` +
                    (row.host === "wsl"
                      ? ` · WSL ${row.distro ?? ""}`
                      : "") +
                    (row.processes ? ` · ${row.processes} processes` : "")
                  : `${row.title} — exited`
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onOpen(row.id)}
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  row.alive
                    ? row.workload
                      ? "bg-emerald-400"
                      : "bg-content/30"
                    : "bg-content/15"
                }`}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              {process ? (
                <span className="max-w-[7rem] shrink-0 truncate font-mono text-[10px] text-content/50">
                  {process}
                </span>
              ) : null}
              <span className="min-w-24 shrink-0 text-right font-mono text-[10px] tabular-nums text-content/50">
                {row.alive
                  ? `${formatCpu(row.cpuPct)} · ${formatMem(row.rssBytes)}`
                  : "exited"}
              </span>
            </button>
            <span className="flex shrink-0 items-center gap-0.5 text-content/40">
              <button
                type="button"
                className="grid size-5 place-items-center rounded hover:bg-content/15 hover:text-content disabled:opacity-30"
                aria-label={`Stop processes in ${row.title}`}
                title="Kill processes"
                disabled={!row.workload || killing.has(row.id)}
                onClick={() => kill(row.id)}
              >
                <Stop className="size-2.5" aria-hidden />
              </button>
              <button
                type="button"
                className="grid size-5 place-items-center rounded hover:bg-content/15 hover:text-content"
                aria-label={`Close ${row.title}`}
                title="Close terminal"
                onClick={() => onClose?.(row.id)}
              >
                <X className="size-3" strokeWidth={1.75} aria-hidden />
              </button>
            </span>
          </div>
        );
      })}
    </Popover>
  );
}

function ProviderChip({
  limits,
  now,
}: {
  limits: ProviderRateLimits;
  now: number;
}) {
  const loading =
    limits.status === "idle" ||
    (limits.status === "fetching" && !limits.session && !limits.weekly);
  const disconnected = limits.status === "unavailable";
  const windows = [
    limits.session ? { key: "session", window: limits.session } : null,
    limits.weekly ? { key: "weekly", window: limits.weekly } : null,
  ].filter((entry): entry is { key: string; window: RateLimitWindow } => {
    return entry != null;
  });
  const tightest = windows.reduce<RateLimitWindow | null>((best, entry) => {
    if (!best || entry.window.usedPercent > best.usedPercent) {
      return entry.window;
    }
    return best;
  }, null);
  const tooltip = windows
    .map((entry) => rateLimitWindowTooltip(entry.window, now))
    .join(" · ");

  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap"
      title={
        tooltip ||
        limits.error ||
        (disconnected
          ? "Not connected"
          : loading
            ? "Loading usage…"
            : undefined)
      }
    >
      <HarnessIcon harness={limits.provider} className="size-3 shrink-0" />
      {loading ? (
        <span className="animate-pulse text-content/35">···</span>
      ) : disconnected ? (
        <span className="text-content/35">not connected</span>
      ) : windows.length === 0 ? (
        <span className="text-content/35">{emptyUsageLabel(limits)}</span>
      ) : (
        <>
          {tightest ? <MiniBar usedPct={tightest.usedPercent} /> : null}
          <span className="flex min-w-0 items-center gap-1 tabular-nums">
            {windows.map((entry, index) => (
              <span key={entry.key} className="inline-flex items-center gap-1">
                {index > 0 ? <span className="text-content/25">·</span> : null}
                <span>
                  {formatUsagePercent(entry.window.usedPercent)}{" "}
                  {formatRateLimitWindowChipLabel(entry.window, now)}
                </span>
              </span>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

function emptyUsageLabel(limits: ProviderRateLimits): string {
  if (limits.status !== "error") return "—";
  const text = limits.error?.toLowerCase() ?? "";
  if (text.includes("expired") || text.includes("sign-in")) return "expired";
  return "—";
}

function MiniBar({ usedPct }: { usedPct: number }) {
  const pct = clampUsedPercent(usedPct);
  return (
    <span
      className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-content/10"
      aria-hidden
    >
      <span
        className={`block h-full rounded-full ${barClass(pct)}`}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

function barClass(pct: number): string {
  if (pct >= 90) return "bg-red-400";
  if (pct >= 80) return "bg-amber-400";
  return "bg-content/45";
}
