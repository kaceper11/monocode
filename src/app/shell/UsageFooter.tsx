import { Globe, RefreshCw, Terminal } from "../../shared/ui/icons";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import { Popover, type PopoverDismissReason } from "../../shared/ui/Popover";
import { consumeCodexRateLimitResetCredit } from "../../features/providers/model/rateLimitsFetch";
import {
  errorRateLimits,
  unavailableRateLimits,
  type RateLimitProvider,
} from "../../features/providers/model/rateLimits";
import {
  getCachedRateLimits,
  loadRateLimits,
  setCachedRateLimits,
  useCachedRateLimits,
} from "../../features/providers/model/rateLimitsCache";
import {
  HARNESS_LABEL,
  HARNESS_TITLE,
  type HarnessId,
} from "../../features/sessions/model/session";
import {
  loginHarness,
  supportsHarnessLogin,
} from "../../integrations/harness/core/auth";
import {
  runningTerminalChipLabel,
  type RunningTerminal,
} from "../../features/terminal/model/terminalTab";
import { MOD } from "../../platform/tauri/platform";
import { UsageProviderChip } from "./UsageProviderChip";
import { PiUsage } from "./PiUsage";
import {
  ProviderSignInPanel,
  type ProviderSignInState,
} from "../../features/sessions/ui/ProviderSignInPanel";
import {
  newProviderAccount,
  providerAccountExists,
  providerAccounts,
  saveProviderAccount,
  selectProviderAccount,
  selectedProviderAccountId,
  subscribeProviderAccounts,
  type ProviderAccountProvider,
} from "../../features/providers/model/providerAccounts";

import { wslLocation } from "../../shared/lib/paths";

const CLOCK_MS = 30_000;

export type UsageFooterSession = {
  id?: string;
  harness: HarnessId;
  model?: string;
  authRequired?: boolean;
  providerAccountId?: string;
  cwd?: string;
};

export function UsageFooter(props: ComponentProps<typeof UsageFooterContent>) {
  const destination = [
    props.session?.cwd ?? props.project,
    props.session?.id,
    props.session?.harness,
    props.session?.providerAccountId,
    props.providers,
  ];
  return <UsageFooterContent key={JSON.stringify(destination)} {...props} />;
}

function UsageFooterContent({
  providers,
  session,
  project,
  terminals = [],
  terminalOpen = false,
  onToggleTerminal,
  onNewTerminal,
  onShowTerminal,
  projectTerminalActive = false,
  onToggleBrowser,
  commandsControl,
  resourcesControl,
  onSelectAccount,
  onManageAccounts,
}: {
  providers: RateLimitProvider[];
  session?: UsageFooterSession;
  project?: string;
  terminals?: RunningTerminal[];
  terminalOpen?: boolean;
  onToggleTerminal?: (fileId: string) => void;
  onNewTerminal?: () => void;
  onShowTerminal?: () => void;
  projectTerminalActive?: boolean;
  onToggleBrowser?: () => void;
  commandsControl?: ReactNode;
  resourcesControl?: ReactNode;
  onSelectAccount?: (
    provider: ProviderAccountProvider,
    accountId: string,
  ) => void;
  onManageAccounts?: (provider: ProviderAccountProvider) => void;
}) {
  const cwd = session?.cwd ?? project;
  const wsl = cwd ? wslLocation(cwd) : undefined;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const wantClaude = providers.includes("claude");
  const wantCodex = providers.includes("codex");
  const wantOpencode = providers.includes("opencode");
  const additional = providers.find(
    (provider): provider is "copilot" | "muse" | "devin" =>
      provider === "copilot" || provider === "muse" || provider === "devin",
  );
  const extra = useCachedRateLimits(additional ?? "devin", "default", cwd, session?.id);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [, setAccountsVersion] = useState(0);
  const inflight = useRef<Promise<void> | null>(null);
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
  const claudeAccountAvailable = providerAccountExists(
    "claude",
    claudeAccountId,
  );
  const codexAccountAvailable = providerAccountExists("codex", codexAccountId);
  const codexAccountRef = useRef(codexAccountId);
  codexAccountRef.current = codexAccountId;
  const cachedClaude = useCachedRateLimits("claude", claudeAccountId, cwd);
  const cachedCodex = useCachedRateLimits("codex", codexAccountId, cwd);
  const opencode = useCachedRateLimits("opencode", "default", cwd);
  const claude = claudeAccountAvailable
    ? cachedClaude
    : unavailableRateLimits(
        "claude",
        "This conversation uses a removed account",
      );
  const codex = codexAccountAvailable
    ? cachedCodex
    : unavailableRateLimits(
        "codex",
        "This conversation uses a removed account",
      );

  useEffect(
    () =>
      subscribeProviderAccounts(() => setAccountsVersion((value) => value + 1)),
    [],
  );

  // New accounts load once. Returning from Settings or focusing the window
  // reads the shared snapshot without starting another provider request.
  useEffect(() => {
    if (wantClaude && claudeAccountAvailable)
      void loadRateLimits("claude", claudeAccountId, false, cwd);
    if (wantCodex && codexAccountAvailable)
      void loadRateLimits("codex", codexAccountId, false, cwd);
    if (wantOpencode) void loadRateLimits("opencode", "default", false, cwd);
    if (additional) void loadRateLimits(additional, "default", false, cwd, session?.id);
  }, [
    claudeAccountAvailable,
    claudeAccountId,
    codexAccountAvailable,
    codexAccountId,
    wantClaude,
    wantCodex,
    wantOpencode,
    additional, cwd, session?.id,
  ]);

  const refresh = useCallback(() => {
    if (inflight.current) return inflight.current;
    setRefreshing(true);
    const jobs: Promise<unknown>[] = [];
    if (wantClaude && claudeAccountAvailable)
      jobs.push(loadRateLimits("claude", claudeAccountId, true, cwd));
    if (wantCodex && codexAccountAvailable)
      jobs.push(loadRateLimits("codex", codexAccountId, true, cwd));
    if (wantOpencode) jobs.push(loadRateLimits("opencode", "default", true, cwd));
    if (additional) jobs.push(loadRateLimits(additional, "default", true, cwd, session?.id));
    const run = Promise.allSettled(jobs)
      .then(() => undefined)
      .finally(() => {
        inflight.current = null;
        setRefreshing(false);
      });
    inflight.current = run;
    return run;
  }, [
    claudeAccountAvailable,
    claudeAccountId,
    codexAccountAvailable,
    codexAccountId,
    wantClaude,
    wantCodex,
    wantOpencode,
    additional, cwd, session?.id,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onUsage = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail.sessionId === session?.id) void refresh();
    };
    window.addEventListener("monocode-provider-usage-changed", onUsage);
    return () => window.removeEventListener("monocode-provider-usage-changed", onUsage);
  }, [refresh, session?.id]);

  const consumeCodexReset = useCallback(
    async (creditId?: string) => {
      while (inflight.current) await inflight.current;
      if (!mounted.current || codexAccountRef.current !== codexAccountId)
        throw new Error(
          "The usage destination changed. Reopen usage and retry.",
        );
      setRefreshing(true);
      let outcome: Awaited<ReturnType<typeof consumeCodexRateLimitResetCredit>>;
      const operation = (async () => {
        try {
          outcome = await consumeCodexRateLimitResetCredit(
            creditId,
            codexAccountId,
            cwd,
          );
          await loadRateLimits("codex", codexAccountId, true, cwd);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Could not use Codex reset";
          setCachedRateLimits(
            "codex",
            codexAccountId,
            errorRateLimits(
              "codex",
              message,
              getCachedRateLimits("codex", codexAccountId, cwd),
            ),
            cwd,
          );
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
    [codexAccountId, cwd],
  );

  const reconnectProvider = useCallback(
    async (provider: RateLimitProvider, accountId: string) => {
      while (inflight.current) await inflight.current;
      if (!mounted.current)
        throw new Error(
          "The usage destination changed. Reopen usage and retry.",
        );
      setRefreshing(true);
      const operation = (async () => {
        try {
          await loginHarness(provider, accountId, cwd);
          const value = await loadRateLimits(provider, accountId, true, cwd);
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
          setCachedRateLimits(
            provider,
            accountId,
            errorRateLimits(
              provider,
              message,
              getCachedRateLimits(provider, accountId, cwd),
            ),
            cwd,
          );
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
    [cwd],
  );

  const reconnectClaude = useCallback(
    () => reconnectProvider("claude", claudeAccountId),
    [claudeAccountId, reconnectProvider],
  );

  const reconnectCodex = useCallback(
    () => reconnectProvider("codex", codexAccountId),
    [codexAccountId, reconnectProvider],
  );

  const selectAccount = useCallback(
    (provider: ProviderAccountProvider, accountId: string) => {
      selectProviderAccount(provider, project, accountId);
      onSelectAccount?.(provider, accountId);
    },
    [onSelectAccount, project],
  );

  const addAccount = useCallback(
    async (provider: ProviderAccountProvider, label: string) => {
      const account = newProviderAccount(provider, label);
      await loginHarness(provider, account.id);
      saveProviderAccount(account);
      selectAccount(provider, account.id);
      return account;
    },
    [selectAccount],
  );

  const showOpencodeChip = wantOpencode && opencode.status !== "unavailable";
  const showUsage =
    wantClaude || wantCodex || showOpencodeChip || Boolean(additional);
  const showTerminals = terminals.length > 0;
  const showTerminalButton = Boolean(onNewTerminal || onShowTerminal);
  const terminalLabel = projectTerminalActive
    ? "Terminal"
    : `New Terminal (${MOD}\`)`;
  const onTerminalClick = projectTerminalActive
    ? (onShowTerminal ?? onNewTerminal)
    : (onNewTerminal ?? onShowTerminal);
  const ariaLabel = showUsage || session?.harness === "pi"
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
      {wsl ? (
        <span
          className="shrink-0 text-content/40"
          title={`Usage and sign-in inside WSL: ${wsl.distribution}`}
        >
          {wsl.distribution}
        </span>
      ) : null}
      {session?.harness === "pi" ? (
        <PiUsage key={`${session.id}:${session.model}`} model={session.model} now={now} cwd={cwd} />
      ) : showUsage ? (
        <>
          {wantClaude ? (
            <UsageProviderChip
              limits={claude}
              now={now}
              accounts={
                wsl
                  ? claudeAccounts
                      .filter((account) => account.id === "default")
                      .map((account) => ({
                        ...account,
                        label: `${wsl.distribution} account`,
                      }))
                  : claudeAccounts
              }
              accountId={claudeAccountId}
              accountLabel={
                wsl && claudeAccountId !== "default"
                  ? "Native account (unavailable in WSL)"
                  : undefined
              }
              onSelectAccount={(accountId) =>
                selectAccount("claude", accountId)
              }
              onAddAccount={
                wsl ? undefined : (label) => addAccount("claude", label)
              }
              onManageAccounts={
                !wsl && onManageAccounts
                  ? () => onManageAccounts("claude")
                  : undefined
              }
              onReconnect={reconnectClaude}
            />
          ) : null}
          {wantCodex ? (
            <UsageProviderChip
              limits={codex}
              now={now}
              project={project}
              cwd={cwd}
              accounts={
                wsl
                  ? codexAccounts
                      .filter((account) => account.id === "default")
                      .map((account) => ({
                        ...account,
                        label: `${wsl.distribution} account`,
                      }))
                  : codexAccounts
              }
              accountId={codexAccountId}
              accountLabel={
                wsl && codexAccountId !== "default"
                  ? "Native account (unavailable in WSL)"
                  : undefined
              }
              onSelectAccount={(accountId) => selectAccount("codex", accountId)}
              onAddAccount={
                wsl ? undefined : (label) => addAccount("codex", label)
              }
              onManageAccounts={
                !wsl && onManageAccounts
                  ? () => onManageAccounts("codex")
                  : undefined
              }
              onConsumeReset={consumeCodexReset}
              onReconnect={reconnectCodex}
            />
          ) : null}
          {additional ? (
            <UsageProviderChip limits={extra} now={now} project={project} />
          ) : null}
          {showOpencodeChip ? (
            <UsageProviderChip limits={opencode} now={now} project={project} />
          ) : null}
          <button
            type="button"
            className="grid size-4.5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-50"
            aria-label="Refresh usage"
            title="Refresh usage"
            disabled={refreshing}
            onClick={() => void refresh()}
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
      {showTerminals || showTerminalButton || resourcesControl ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {showTerminals ? (
            <RunningTerminalChip
              terminals={terminals}
              open={terminalOpen}
              onToggle={onToggleTerminal}
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
          {onToggleBrowser ? (
            <button
              type="button"
              aria-label="Toggle browser panel"
              title="Toggle browser panel"
              onClick={onToggleBrowser}
              className="inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-content/60 hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-content"
            >
              <Globe className="size-3.5" strokeWidth={1.75} aria-hidden />
              <span>Browser</span>
            </button>
          ) : null}
          {commandsControl}
          {resourcesControl}
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
      await loginHarness(
        session.harness,
        session.providerAccountId,
        session.cwd,
      );
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

function RunningTerminalChip({
  terminals,
  open: panelOpen,
  onToggle,
}: {
  terminals: RunningTerminal[];
  open: boolean;
  onToggle?: (fileId: string) => void;
}) {
  const root = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const label = runningTerminalChipLabel(terminals);
  const many = terminals.length > 1;
  const title = terminals
    .map((terminal) => `"${terminal.process}" in ${terminal.label}`)
    .join("\n");
  const ariaLabel =
    terminals.length === 1
      ? panelOpen
        ? `Hide ${terminals[0]?.process}`
        : `Show ${terminals[0]?.process}`
      : panelOpen
        ? "Hide running terminals"
        : `${terminals.length} terminals are running processes`;

  const toggle = (fileId: string) => {
    setMenuOpen(false);
    onToggle?.(fileId);
  };

  return (
    <>
      <button
        ref={root}
        type="button"
        className="inline-flex min-w-0 max-w-[16rem] items-center gap-1.5 whitespace-nowrap rounded px-1 -mx-1 hover:bg-content/10 hover:text-content"
        aria-label={ariaLabel}
        aria-pressed={panelOpen}
        aria-expanded={many && !panelOpen ? menuOpen : undefined}
        aria-haspopup={many && !panelOpen ? "menu" : undefined}
        title={title}
        onClick={() => {
          if (panelOpen || !many) {
            const target = terminals[0];
            if (target) toggle(target.id);
            return;
          }
          setMenuOpen((value) => !value);
        }}
      >
        <TerminalLiveMark />
        <span className="truncate font-mono text-[10px] tabular-nums">
          {label}
        </span>
      </button>
      {menuOpen && many && !panelOpen ? (
        <Popover
          anchor={root}
          side="top"
          align="end"
          autoFocus
          onDismiss={() => setMenuOpen(false)}
          role="menu"
          aria-label="Running terminals"
          className="min-w-[12rem] p-1"
        >
          {terminals.map((terminal) => (
            <button
              key={terminal.id}
              type="button"
              role="menuitem"
              className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] leading-none text-content hover:bg-content/10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggle(terminal.id)}
            >
              <span className="min-w-0 flex-1 truncate">
                {terminal.process}
              </span>
              <span className="max-w-[7rem] shrink-0 truncate text-[11px] text-content/40">
                {terminal.label}
              </span>
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}
