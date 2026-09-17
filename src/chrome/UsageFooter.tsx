import { RefreshCw, Stop, Terminal, X } from "./icons";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { HarnessIcon } from "./HarnessIcon";
import { Popover, type PopoverDismissReason } from "./Popover";
import {
  consumeCodexRateLimitResetCredit,
  fetchClaudeRateLimits,
  fetchCodexRateLimits,
} from "../lib/rateLimitsFetch";
import {
  errorRateLimits,
  fetchingRateLimits,
  idleRateLimits,
  RATE_LIMIT_POLL_MS,
  shouldFetchProvider,
  type ProviderRateLimits,
  type RateLimitProvider,
} from "../lib/rateLimits";
import { HARNESS_LABEL, HARNESS_TITLE, type HarnessId } from "../lib/session";
import { runningTerminalChipLabel } from "../lib/terminalTab";
import { loginHarness, supportsHarnessLogin } from "../lib/harness/auth";
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
import { MOD } from "../lib/platform";
import { UsageProviderChip } from "./UsageProviderChip";
import {
  ProviderSignInPanel,
  type ProviderSignInState,
} from "./ProviderSignInPanel";
import {
  newProviderAccount,
  providerAccounts,
  saveProviderAccount,
  selectProviderAccount,
  selectedProviderAccountId,
  subscribeProviderAccounts,
} from "../lib/providerAccounts";

const CLOCK_MS = 30_000;

export type UsageFooterSession = {
  id?: string;
  harness: HarnessId;
  authRequired?: boolean;
  providerAccountId?: string;
};

export function UsageFooter({
  providers,
  session,
  project,
  terminals = [],
  onOpenTerminal,
  onCloseTerminal,
  onNewTerminal,
  onShowTerminal,
  projectTerminalActive = false,
  projectTerminalExists = false,
  onSelectAccount,
}: {
  providers: RateLimitProvider[];
  session?: UsageFooterSession;
  project?: string;
  terminals?: FooterTerminal[];
  onOpenTerminal?: (fileId: string) => void;
  onCloseTerminal?: (fileId: string) => void;
  onNewTerminal?: () => void;
  onShowTerminal?: () => void;
  projectTerminalActive?: boolean;
  /** The project terminal dock exists (open or hidden). */
  projectTerminalExists?: boolean;
  onSelectAccount?: (provider: RateLimitProvider, accountId: string) => void;
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
  const [, setAccountsVersion] = useState(0);
  const inflight = useRef<Promise<void> | null>(null);
  const claudeRef = useRef(claude);
  const codexRef = useRef(codex);
  claudeRef.current = claude;
  codexRef.current = codex;
  const claudeAccountId =
    session?.harness === "claude" && session.providerAccountId
      ? session.providerAccountId
      : selectedProviderAccountId("claude", project);
  const codexAccountId =
    session?.harness === "codex" && session.providerAccountId
      ? session.providerAccountId
      : selectedProviderAccountId("codex", project);
  const claudeAccounts = providerAccounts("claude");
  const codexAccounts = providerAccounts("codex");
  const claudeAccountRef = useRef(claudeAccountId);
  const codexAccountRef = useRef(codexAccountId);
  claudeAccountRef.current = claudeAccountId;
  codexAccountRef.current = codexAccountId;

  useEffect(
    () =>
      subscribeProviderAccounts(() => setAccountsVersion((value) => value + 1)),
    [],
  );

  const refresh = useCallback(
    (force = false) => {
      if (inflight.current) return inflight.current;
      const visible = document.visibilityState === "visible";
      const fetchClaude =
        wantClaude &&
        shouldFetchProvider(claudeRef.current, { force, visible });
      const fetchCodex =
        wantCodex && shouldFetchProvider(codexRef.current, { force, visible });
      if (!fetchClaude && !fetchCodex) return;
      if (force) setRefreshing(true);
      const jobs: Promise<void>[] = [];
      if (fetchClaude) {
        const accountId = claudeAccountId;
        setClaude((current) => fetchingRateLimits("claude", current));
        jobs.push(
          fetchClaudeRateLimits(accountId).then((value) => {
            if (accountId === claudeAccountRef.current) setClaude(value);
          }),
        );
      }
      if (fetchCodex) {
        const accountId = codexAccountId;
        setCodex((current) => fetchingRateLimits("codex", current));
        jobs.push(
          fetchCodexRateLimits(accountId).then((value) => {
            if (accountId === codexAccountRef.current) setCodex(value);
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
    },
    [claudeAccountId, codexAccountId, wantClaude, wantCodex],
  );

  useEffect(() => {
    const idle = idleRateLimits("claude");
    claudeRef.current = idle;
    setClaude(idle);
    const pending = inflight.current;
    if (pending) void pending.finally(() => refresh(true));
  }, [claudeAccountId]);

  useEffect(() => {
    const idle = idleRateLimits("codex");
    codexRef.current = idle;
    setCodex(idle);
    const pending = inflight.current;
    if (pending) void pending.finally(() => refresh(true));
  }, [codexAccountId]);

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

  const consumeCodexReset = useCallback(
    async (creditId?: string) => {
      while (inflight.current) await inflight.current;
      setRefreshing(true);
      setCodex((current) => fetchingRateLimits("codex", current));
      let outcome: Awaited<ReturnType<typeof consumeCodexRateLimitResetCredit>>;
      const operation = (async () => {
        try {
          outcome = await consumeCodexRateLimitResetCredit(
            creditId,
            codexAccountId,
          );
          setCodex(await fetchCodexRateLimits(codexAccountId));
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Could not use Codex reset";
          setCodex((current) => errorRateLimits("codex", message, current));
          throw error;
        }
      })();
      const tracked = operation.finally(() => {
        inflight.current = null;
        setRefreshing(false);
      });
      inflight.current = tracked.catch(() => undefined);
      await tracked;
      return outcome!;
    },
    [codexAccountId],
  );

  const reconnectProvider = useCallback(
    async (
      provider: RateLimitProvider,
      accountId: string,
      fetchLimits: () => Promise<ProviderRateLimits>,
      setLimits: Dispatch<SetStateAction<ProviderRateLimits>>,
    ) => {
      while (inflight.current) await inflight.current;
      setRefreshing(true);
      setLimits((current) => fetchingRateLimits(provider, current));
      const operation = (async () => {
        try {
          await (accountId === "default"
            ? loginHarness(provider)
            : loginHarness(provider, accountId));
          const value = await fetchLimits();
          setLimits(value);
          if (value.status !== "ok") {
            throw new Error(
              value.error ||
                `${HARNESS_TITLE[provider]} sign-in could not be verified`,
            );
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Could not complete sign-in";
          setLimits((current) => errorRateLimits(provider, message, current));
          throw error;
        }
      })();
      const tracked = operation.finally(() => {
        inflight.current = null;
        setRefreshing(false);
      });
      inflight.current = tracked.catch(() => undefined);
      await tracked;
    },
    [],
  );

  const reconnectClaude = useCallback(
    () =>
      reconnectProvider(
        "claude",
        claudeAccountId,
        () => fetchClaudeRateLimits(claudeAccountId),
        setClaude,
      ),
    [claudeAccountId, reconnectProvider],
  );

  const reconnectCodex = useCallback(
    () =>
      reconnectProvider(
        "codex",
        codexAccountId,
        () => fetchCodexRateLimits(codexAccountId),
        setCodex,
      ),
    [codexAccountId, reconnectProvider],
  );

  const selectAccount = useCallback(
    (provider: RateLimitProvider, accountId: string) => {
      selectProviderAccount(provider, project, accountId);
      onSelectAccount?.(provider, accountId);
    },
    [onSelectAccount, project],
  );

  const addAccount = useCallback(
    async (provider: RateLimitProvider, label: string) => {
      const account = newProviderAccount(provider, label);
      await loginHarness(provider, account.id);
      saveProviderAccount(account);
      selectAccount(provider, account.id);
      return account;
    },
    [selectAccount],
  );

  const showUsage = wantClaude || wantCodex;
  const showTerminals = terminals.length > 0;
  const showTerminalButton = Boolean(onNewTerminal || onShowTerminal);
  const terminalLabel = projectTerminalActive
    ? "Hide Terminal"
    : projectTerminalExists
      ? "Show Terminal"
      : `New Terminal (${MOD}\`)`;
  const onTerminalClick = projectTerminalExists
    ? (onShowTerminal ?? onNewTerminal)
    : (onNewTerminal ?? onShowTerminal);
  const ariaLabel = showUsage
    ? "Provider usage"
    : showTerminals || showTerminalButton
      ? "Terminals"
      : session
        ? "Session"
        : undefined;

  return (
    <footer
      aria-label={ariaLabel}
      className="flex h-7 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-stroke px-3 text-[11px] text-content/55"
    >
      {showUsage ? (
        <>
          {wantClaude ? (
            <UsageProviderChip
              limits={claude}
              now={now}
              accounts={claudeAccounts}
              accountId={claudeAccountId}
              onSelectAccount={(accountId) =>
                selectAccount("claude", accountId)
              }
              onAddAccount={(label) => addAccount("claude", label)}
              onReconnect={reconnectClaude}
            />
          ) : null}
          {wantCodex ? (
            <UsageProviderChip
              limits={codex}
              now={now}
              project={project}
              accounts={codexAccounts}
              accountId={codexAccountId}
              onSelectAccount={(accountId) => selectAccount("codex", accountId)}
              onAddAccount={(label) => addAccount("codex", label)}
              onConsumeReset={consumeCodexReset}
              onReconnect={reconnectCodex}
            />
          ) : null}
          <button
            type="button"
            className="grid size-4.5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-50"
            aria-label="Refresh usage"
            title="Refresh usage"
            disabled={refreshing}
            onClick={() => void refresh(true)}
          >
            <RefreshCw
              className={`size-2.5 ${refreshing ? "animate-spin" : ""}`}
              strokeWidth={1.75}
              aria-hidden
            />
          </button>
        </>
      ) : session ? (
        <SessionChip key={session.id ?? session.harness} session={session} />
      ) : null}
      {showTerminals || showTerminalButton ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {showTerminals ? (
            <TerminalChip
              terminals={terminals}
              onOpen={onOpenTerminal}
              onClose={onCloseTerminal}
            />
          ) : showTerminalButton ? (
            <button
              type="button"
              className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 hover:bg-content/10 ${
                projectTerminalActive
                  ? "text-accent"
                  : "text-content/40 hover:text-content"
              }`}
              aria-label={terminalLabel}
              aria-pressed={projectTerminalActive}
              title={terminalLabel}
              onClick={onTerminalClick}
            >
              <Terminal className="size-3.5" strokeWidth={1.75} aria-hidden />
              <span>Terminal</span>
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
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [loginState, setLoginState] = useState<ProviderSignInState>("idle");
  const [loginError, setLoginError] = useState<string | null>(null);
  const authRequired = Boolean(
    session.authRequired && loginState !== "complete",
  );
  const canLogin = authRequired && supportsHarnessLogin(session.harness);

  useEffect(() => {
    if (!session.authRequired && loginState === "complete") {
      setLoginState("idle");
    }
  }, [loginState, session.authRequired]);

  const dismiss = (reason: PopoverDismissReason) => {
    setOpen(false);
    if (reason === "escape") {
      requestAnimationFrame(() => trigger.current?.focus());
    }
  };

  const signIn = async () => {
    setLoginState("running");
    setLoginError(null);
    try {
      await loginHarness(session.harness);
      setOpen(false);
      setLoginState("complete");
    } catch (error) {
      setLoginError(
        error instanceof Error ? error.message : "Could not complete sign-in",
      );
      setLoginState("error");
    }
  };

  if (!canLogin) {
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

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="-mx-1 inline-flex h-5 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1 text-content/55 transition-[background-color,color,transform] duration-150 ease-out hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97]"
        aria-label={`${HARNESS_TITLE[session.harness]} sign-in required`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${HARNESS_TITLE[session.harness]} sign-in required`}
        onClick={() => setOpen((value) => !value)}
      >
        <HarnessIcon harness={session.harness} className="size-3 shrink-0" />
        <span>{HARNESS_LABEL[session.harness]}</span>
        {authRequired ? (
          <span className="text-[10px] text-amber-600 dark:text-amber-300">
            sign in
          </span>
        ) : null}
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="top"
          align="start"
          gap={7}
          width={300}
          autoFocus
          onDismiss={dismiss}
          role="dialog"
          aria-label={`${HARNESS_TITLE[session.harness]} sign-in`}
          tabIndex={-1}
          className="text-content"
        >
          <ProviderSignInPanel
            harness={session.harness}
            state={loginState}
            error={loginError}
            onSignIn={() => void signIn()}
          />
        </Popover>
      ) : null}
    </>
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

