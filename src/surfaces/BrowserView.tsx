import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Camera, ChevronLeft, ChevronRight, ExternalLink, Globe, RefreshCw, X } from "../chrome/icons";
import {
  browserAgentContext,
  browserCapture,
  browserClose,
  browserGoBack,
  browserGoForward,
  browserNavigate,
  browserOpen,
  browserProbe,
  browserReload,
  browserSetBounds,
  browserSetVisible,
  normalizeBrowserUrl,
  rememberedBrowserUrl,
  rememberBrowserUrl,
  subscribeBrowser,
} from "../lib/browser";
import { requestAgentContext } from "../lib/agentContext";
import type { BrowserMetaPatch, FilePaneTab } from "../lib/layout";
import { wslLocation } from "../lib/paths";

type LoadStatus = "idle" | "opening" | "loading" | "ready" | "failed";

type Props = {
  file: FilePaneTab & { browser: { url: string; title?: string } };
  /** The tab is the active tab of a pane that is on screen. */
  active: boolean;
  onMetaChange?: (patch: BrowserMetaPatch) => void;
};

const WATCHDOG_FIRST_MS = 8_000;
const WATCHDOG_RETRY_MS = 6_000;
const WATCHDOG_MAX_ATTEMPTS = 3;
/** Re-checks the host rect — pane position can shift without a resize. */
const BOUNDS_POLL_MS = 800;

/**
 * Chrome around a native child webview. React draws the toolbar, notices,
 * empty state and failure state; the page itself is rendered by the webview
 * positioned over `hostRef`. The webview is created lazily on first
 * activation and destroyed on unmount — hiding only toggles visibility.
 */
export function BrowserView({ file, active, onMetaChange }: Props) {
  const label = `browser-${file.id}`;
  const url = file.browser.url;
  const hostRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const openingRef = useRef(false);
  const shownRef = useRef(false);
  const boundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const watchdogRef = useRef<number | null>(null);
  const onMetaChangeRef = useRef(onMetaChange);
  onMetaChangeRef.current = onMetaChange;
  const cwdRef = useRef(file.cwd);
  cwdRef.current = file.cwd;

  const [opened, setOpened] = useState(false);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [current, setCurrent] = useState(url);
  const [draft, setDraft] = useState(url);
  const [draftError, setDraftError] = useState("");
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [popup, setPopup] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current != null) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  /**
   * WKWebView keeps a refused connection visually blank and emits no event —
   * probe the live location after a delay to tell that apart from a slow
   * load. `about:blank` means the navigation never committed.
   */
  const armWatchdog = useCallback(
    (target: string, attempt = 1) => {
      if (watchdogRef.current != null) window.clearTimeout(watchdogRef.current);
      watchdogRef.current = window.setTimeout(
        () => {
          watchdogRef.current = null;
          void (async () => {
            const probe = await browserProbe(label).catch(() => null);
            if (!probe) {
              if (attempt >= WATCHDOG_MAX_ATTEMPTS) {
                setStatus("failed");
                setFailure(`Couldn't load ${target}`);
              } else {
                armWatchdog(target, attempt + 1);
              }
              return;
            }
            if (probe.href === "about:blank") {
              setStatus("failed");
              setFailure(`Couldn't load ${target}`);
              return;
            }
            if (probe.href === target) {
              if (attempt >= WATCHDOG_MAX_ATTEMPTS) {
                setNotice("Still loading…");
                return;
              }
              armWatchdog(target, attempt + 1);
              return;
            }
            // The page never committed — whatever is still shown wins.
            setCurrent(probe.href);
            setDraft(probe.href);
            if (openedRef.current) {
              setStatus("ready");
              setNotice(`Couldn't load ${target}`);
            } else {
              setStatus("failed");
              setFailure(`Couldn't load ${target}`);
            }
          })();
        },
        attempt === 1 ? WATCHDOG_FIRST_MS : WATCHDOG_RETRY_MS,
      );
    },
    [label],
  );

  // Page events → tab state. `navigate` fires for every committed
  // navigation (initial load, user clicks, redirects, history moves).
  useEffect(() => {
    return subscribeBrowser(label, (event) => {
      switch (event.kind) {
        case "navigate": {
          const next = event.url ?? "";
          setCurrent(next);
          setDraft(next);
          setCanBack(event.canBack);
          setCanForward(event.canForward);
          setNotice(null);
          setPopup(null);
          setFailure("");
          setStatus("loading");
          armWatchdog(next);
          onMetaChangeRef.current?.({ url: next });
          rememberBrowserUrl(cwdRef.current, next);
          break;
        }
        case "load-started":
          setStatus("loading");
          break;
        case "load-finished":
          clearWatchdog();
          setStatus("ready");
          break;
        case "title":
          onMetaChangeRef.current?.({ title: event.title ?? "" });
          break;
        case "blocked":
          setNotice(event.reason ?? "That link isn't allowed in Browser");
          break;
        case "popup":
          if (event.url) setPopup(event.url);
          break;
        case "download":
          setNotice(event.reason ?? "Downloads are not allowed in Browser");
          break;
      }
    });
  }, [label, armWatchdog, clearWatchdog]);

  const wantShowRef = useRef(false);
  const syncBounds = useCallback(() => {
    const el = hostRef.current;
    if (!el || !openedRef.current) return;
    const rect = el.getBoundingClientRect();
    // An overlay view (search/settings/inbox) or an inactive workspace tab
    // hides the host: a zero rect, or an ancestor marked hidden/inert. The
    // native webview sits above the DOM, so it must be hidden explicitly.
    const covered =
      !rect.width ||
      !rect.height ||
      !!el.closest("[aria-hidden='true'], [inert], .hidden");
    if (covered || !wantShowRef.current) {
      if (shownRef.current) {
        shownRef.current = false;
        void browserSetVisible(label, false).catch(() => undefined);
      }
      return;
    }
    if (!shownRef.current) {
      shownRef.current = true;
      void browserSetVisible(label, true).catch(() => undefined);
    }
    const next = {
      x: rect.x,
      y: rect.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };
    const prev = boundsRef.current;
    if (
      prev &&
      Math.abs(prev.x - next.x) < 0.5 &&
      Math.abs(prev.y - next.y) < 0.5 &&
      Math.abs(prev.width - next.width) < 0.5 &&
      Math.abs(prev.height - next.height) < 0.5
    )
      return;
    boundsRef.current = next;
    void browserSetBounds(label, next).catch(() => undefined);
  }, [label]);

  // Lazily create the webview the first time the tab is on screen with a URL.
  useEffect(() => {
    if (!active || !url || openedRef.current || openingRef.current) return;
    openingRef.current = true;
    setStatus("opening");
    let alive = true;
    void (async () => {
      try {
        const rect = hostRef.current?.getBoundingClientRect();
        const bounds = rect
          ? { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) }
          : { x: 0, y: 0, width: 1, height: 1 };
        await browserOpen(label, url, bounds);
        if (!alive) return;
        openedRef.current = true;
        shownRef.current = true;
        boundsRef.current = bounds;
        setOpened(true);
        setStatus("loading");
        armWatchdog(url);
      } catch (error) {
        if (!alive) return;
        setStatus("failed");
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        openingRef.current = false;
      }
    })();
    return () => {
      alive = false;
    };
  }, [active, url, label, armWatchdog]);

  // The webview dies with the tab — never on hide, so switching sessions
  // keeps the page and its scroll/form state.
  useEffect(
    () => () => {
      clearWatchdog();
      openedRef.current = false;
      void browserClose(label).catch(() => undefined);
    },
    [label, clearWatchdog],
  );

  // Native content sits above DOM chrome — hide it while a menu, dialog or
  // popover from our side is open so the overlay is reachable. Overlays are
  // portaled to body inside plain wrapper divs, so the match has to descend
  // into each body child, not just test the child itself.
  useEffect(() => {
    const OVERLAY = '[role="dialog"], [role="menu"], [data-explorer-menu], [data-popover-side]';
    const check = () => {
      const host = hostRef.current;
      const has = Array.from(
        document.body.querySelectorAll<HTMLElement>(OVERLAY),
      ).some(
        (el) =>
          !(host && (host.contains(el) || el.contains(host))) &&
          !el.closest("[aria-hidden='true'], [inert], .hidden") &&
          !!el.getClientRects().length,
      );
      setOverlayOpen(has);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return () => observer.disconnect();
  }, []);

  // Track the host rect: ResizeObserver covers resizes, window resize covers
  // window bounds, and a slow poll covers shifts that resize neither (e.g.
  // the sidebar toggling under a fixed-size pane).
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const observer = new ResizeObserver(syncBounds);
    observer.observe(el);
    window.addEventListener("resize", syncBounds);
    const interval = window.setInterval(syncBounds, BOUNDS_POLL_MS);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.clearInterval(interval);
    };
  }, [syncBounds]);

  const wantShow = opened && active && !overlayOpen && status !== "failed";
  wantShowRef.current = wantShow;
  useEffect(() => {
    if (!opened) return;
    if (!wantShow) {
      if (shownRef.current) {
        shownRef.current = false;
        void browserSetVisible(label, false).catch(() => undefined);
      }
      return;
    }
    syncBounds();
  }, [wantShow, opened, label, syncBounds]);

  const navigate = useCallback(
    (input: string) => {
      let normalized: string;
      try {
        normalized = normalizeBrowserUrl(input);
      } catch (error) {
        setDraftError(error instanceof Error ? error.message : String(error));
        return;
      }
      setDraftError("");
      setDraft(normalized);
      setNotice(null);
      setPopup(null);
      if (!openedRef.current) {
        onMetaChangeRef.current?.({ url: normalized });
        return;
      }
      setStatus("loading");
      armWatchdog(normalized);
      void browserNavigate(label, normalized).catch((error) => {
        setStatus("ready");
        setNotice(error instanceof Error ? error.message : String(error));
      });
    },
    [label, armWatchdog],
  );

  const onSubmitUrl = (event: FormEvent) => {
    event.preventDefault();
    navigate(draft);
  };

  /** Explicit user action (#43): screenshot + bounded DOM/console summary →
   * destination picker. Page content stays data — never an instruction. */
  const captureForAgent = useCallback(() => {
    if (capturing) return;
    setCapturing(true);
    void (async () => {
      try {
        const capture = await browserCapture(label);
        const context = browserAgentContext(capture, cwdRef.current);
        requestAgentContext({
          context,
          cwd: cwdRef.current,
          attachmentsOptional: true,
          requireDestinationSelection: true,
        });
        if (capture.detail) setNotice(capture.detail);
      } catch (error) {
        setNotice(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setCapturing(false);
      }
    })();
  }, [capturing, label]);

  const wsl = wslLocation(file.cwd);
  const showChrome = !!url;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {showChrome ? (
        <div
          className="flex h-9 shrink-0 items-center gap-1 border-b border-content/10 bg-content/2 px-1.5"
          title={file.cwd}
        >
          <ToolbarButton
            title="Back"
            disabled={!canBack}
            onClick={() => void browserGoBack(label).catch(() => undefined)}
          >
            <ChevronLeft className="size-3.5" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton
            title="Forward"
            disabled={!canForward}
            onClick={() => void browserGoForward(label).catch(() => undefined)}
          >
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton
            title="Reload"
            disabled={!opened}
            onClick={() => {
              setStatus("loading");
              if (current) armWatchdog(current);
              void browserReload(label).catch(() => undefined);
            }}
          >
            <RefreshCw className="size-3" strokeWidth={1.75} />
          </ToolbarButton>
          <form onSubmit={onSubmitUrl} className="min-w-0 flex-1">
            <input
              value={draft}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setDraftError("");
              }}
              onFocus={(event) => event.currentTarget.select()}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="URL"
              title={current || url}
              className="h-6 w-full rounded-md border border-content/10 bg-content/5 px-2 font-mono text-[11.5px] text-content outline-none focus:border-content/25"
            />
          </form>
          {wsl ? (
            <span
              className="shrink-0 rounded-md bg-content/8 px-1.5 py-0.5 text-[10px] font-medium text-content/60"
              title={`Runs against ${file.cwd}`}
            >
              WSL · {wsl.distribution}
            </span>
          ) : null}
          <ToolbarButton
            title="Send page to an agent"
            disabled={!opened || capturing}
            onClick={captureForAgent}
          >
            <Camera className="size-3.5" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton
            title="Open in system browser"
            disabled={!current}
            onClick={() =>
              void openUrl(current).catch((error) =>
                setNotice(error instanceof Error ? error.message : String(error)),
              )
            }
          >
            <ExternalLink className="size-3.5" strokeWidth={1.75} />
          </ToolbarButton>
        </div>
      ) : null}
      {notice || popup || draftError ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-content/10 bg-content/5 px-3 py-1.5 text-[12px] text-content/75">
          <span className="min-w-0 flex-1 truncate" title={popup ?? notice ?? draftError}>
            {draftError ||
              (popup ? `Popup blocked: ${popup}` : notice)}
          </span>
          {popup ? (
            <>
              <button
                type="button"
                className="shrink-0 rounded-md bg-content/10 px-2 py-0.5 hover:bg-content/15"
                onClick={() => {
                  const target = popup;
                  setPopup(null);
                  navigate(target);
                }}
              >
                Open here
              </button>
              <button
                type="button"
                className="shrink-0 rounded-md bg-content/10 px-2 py-0.5 hover:bg-content/15"
                onClick={() => {
                  const target = popup;
                  setPopup(null);
                  void openUrl(target).catch(() => undefined);
                }}
              >
                Open externally
              </button>
            </>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
            onClick={() => {
              setNotice(null);
              setPopup(null);
              setDraftError("");
            }}
          >
            <X className="size-3" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />
        {!url ? (
          <EmptyBrowserState
            suggested={rememberedBrowserUrl(file.cwd)}
            onSubmit={(value) => onMetaChangeRef.current?.({ url: value })}
          />
        ) : status === "failed" ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="max-w-sm text-center">
              <p className="text-[13px] font-medium text-content">
                Couldn't load this page
              </p>
              <p className="mt-1 text-[12px] leading-5 text-content/55">
                {failure || `Couldn't load ${current || url}`}
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <button
                  type="button"
                  className="rounded-md bg-content/10 px-2.5 py-1 text-[12px] text-content hover:bg-content/15"
                  onClick={() => navigate(draft || url)}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="rounded-md bg-content/10 px-2.5 py-1 text-[12px] text-content hover:bg-content/15"
                  onClick={() =>
                    void openUrl(draft || url).catch(() => undefined)
                  }
                >
                  Open externally
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolbarButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/10 hover:text-content disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function EmptyBrowserState({
  suggested,
  onSubmit,
}: {
  suggested?: string;
  onSubmit: (url: string) => void;
}) {
  const [value, setValue] = useState(suggested ?? "");
  const [error, setError] = useState("");
  return (
    <div className="absolute inset-0 grid place-items-center p-6">
      <form
        className="w-full max-w-sm"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            onSubmit(normalizeBrowserUrl(value));
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <div className="flex items-center gap-2 text-[13px] font-medium text-content">
          <Globe className="size-4 text-content/60" strokeWidth={1.75} />
          Browser preview
        </div>
        <p className="mt-1 text-[12px] leading-5 text-content/55">
          Open a page next to this session — for example a local dev server
          from a terminal.
        </p>
        <input
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError("");
          }}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="http://localhost:3000"
          aria-label="URL"
          className="mt-3 h-8 w-full rounded-md border border-content/10 bg-content/5 px-2.5 font-mono text-[12px] text-content outline-none focus:border-content/25"
        />
        {error ? (
          <p className="mt-1.5 text-[11.5px] text-red-400">{error}</p>
        ) : null}
        <button
          type="submit"
          disabled={!value.trim()}
          className="mt-2.5 rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/90 disabled:opacity-40"
        >
          Open
        </button>
      </form>
    </div>
  );
}
