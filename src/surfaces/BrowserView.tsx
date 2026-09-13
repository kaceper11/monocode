import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Camera, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Globe, Pencil, Plus, RefreshCw, Star, Trash2, X } from "../chrome/icons";
import { Popover } from "../chrome/Popover";
import {
  browserAgentContext,
  browserCapture,
  browserClose,
  browserFavorites,
  browserGoBack,
  browserGoForward,
  browserNavigate,
  browserOpen,
  browserProbe,
  browserReload,
  browserSetBounds,
  browserSetVisible,
  browserTabLabel,
  isBrowserFavorite,
  normalizeBrowserUrl,
  rememberedBrowserUrl,
  rememberBrowserUrl,
  removeBrowserFavorite,
  requestBrowserOpen,
  subscribeBrowser,
  subscribeBrowserFavorites,
  toggleBrowserFavorite,
  updateBrowserFavorite,
  type BrowserFavorite,
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
  const openingRef = useRef<Promise<void> | null>(null);
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
  const [favoritesAnchor, setFavoritesAnchor] = useState<HTMLElement | null>(null);
  const favorites = useSyncExternalStore(
    subscribeBrowserFavorites,
    browserFavorites,
  );
  const favorited = !!current && favorites.some((fav) => fav.url === current);

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

  // Lazily create the webview the first time the tab is on screen with a
  // URL. A dep change or StrictMode remount can land while the native call
  // is still in flight: the stale run's continuation must close the child
  // it just created (it arrives visible), and the fresh run waits for the
  // in-flight open before issuing its own — never drops its URL.
  useEffect(() => {
    if (!active || !url || openedRef.current) return;
    let alive = true;
    const open = async () => {
      while (openingRef.current) {
        try {
          await openingRef.current;
        } catch {
          // The in-flight run already reported its own failure.
        }
        if (!alive || openedRef.current) return;
      }
      const pending = (async () => {
        try {
          const rect = hostRef.current?.getBoundingClientRect();
          const bounds = rect
            ? { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) }
            : { x: 0, y: 0, width: 1, height: 1 };
          await browserOpen(label, url, bounds);
          if (!alive) {
            void browserClose(label).catch(() => undefined);
            return;
          }
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
        }
      })();
      openingRef.current = pending;
      try {
        await pending;
      } finally {
        if (openingRef.current === pending) openingRef.current = null;
      }
    };
    setStatus("opening");
    void open();
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

  // Native content sits above DOM chrome — hide it while a menu, dialog,
  // popover or floating panel from our side is open so the overlay stays
  // reachable. Overlays are portaled to body inside plain wrapper divs, so
  // the match has to descend, not just test top-level children. Scans are
  // rAF-coalesced and skipped entirely until a webview exists.
  useEffect(() => {
    const OVERLAY =
      '[role="dialog"], [role="menu"], [data-explorer-menu], [data-popover-side], [data-app-overlay]';
    let queued = 0;
    const check = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        if (!openedRef.current) return;
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
      });
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      // Overlays can also be hidden purely by attribute on an ancestor.
      attributes: true,
      attributeFilter: ["aria-hidden", "inert", "class", "hidden"],
    });
    check();
    return () => {
      observer.disconnect();
      if (queued) cancelAnimationFrame(queued);
    };
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
        // The navigation never started — drop the watchdog so it can't
        // overwrite this specific error with a generic one seconds later.
        clearWatchdog();
        setStatus("ready");
        setNotice(error instanceof Error ? error.message : String(error));
      });
    },
    [label, armWatchdog, clearWatchdog],
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
          <ToolbarButton
            title={favorited ? "Remove bookmark" : "Bookmark this page"}
            disabled={!current}
            onClick={() =>
              toggleBrowserFavorite(current, file.browser.title?.trim() || "")
            }
          >
            <Star
              className={`size-3.5 ${favorited ? "fill-current text-amber-400" : ""}`}
              strokeWidth={1.75}
            />
          </ToolbarButton>
          <ToolbarButton
            title="Bookmarks"
            onClick={(event) => setFavoritesAnchor(event.currentTarget)}
          >
            <ChevronDown className="size-3.5" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton
            title="New browser tab"
            onClick={() => requestBrowserOpen("", file.cwd)}
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </ToolbarButton>
        </div>
      ) : null}
      {favoritesAnchor ? (
        <BrowserFavoritesMenu
          anchor={favoritesAnchor}
          current={current}
          onPick={(target) => {
            setFavoritesAnchor(null);
            navigate(target);
          }}
          onClose={() => setFavoritesAnchor(null)}
        />
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
            favorites={favorites}
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
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
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

function BrowserFavoritesMenu({
  anchor,
  current,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  current: string;
  onPick: (url: string) => void;
  onClose: () => void;
}) {
  const favorites = useSyncExternalStore(
    subscribeBrowserFavorites,
    browserFavorites,
  );
  const [editing, setEditing] = useState<{
    id: string;
    title: string;
    url: string;
  } | null>(null);
  const [editError, setEditError] = useState("");

  return (
    <Popover
      anchor={anchor}
      side="bottom"
      align="end"
      gap={4}
      width={300}
      onDismiss={onClose}
      role="menu"
      aria-label="Bookmarks"
      className="overflow-y-auto overscroll-none p-1"
    >
      {current && !isBrowserFavorite(current) ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-none text-content hover:bg-content/5"
            onClick={() => toggleBrowserFavorite(current)}
          >
            <Star className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate">Bookmark this page</span>
          </button>
          <div role="separator" className="my-1 h-px bg-content/10" />
        </>
      ) : null}
      {favorites.map((fav) =>
        editing?.id === fav.id ? (
          <form
            key={fav.id}
            className="flex flex-col gap-1.5 px-2 py-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                normalizeBrowserUrl(editing.url);
              } catch (err) {
                setEditError(
                  err instanceof Error ? err.message : String(err),
                );
                return;
              }
              updateBrowserFavorite(fav.id, {
                title: editing.title,
                url: editing.url,
              });
              setEditing(null);
            }}
          >
            <input
              value={editing.title}
              onChange={(event) =>
                setEditing({ ...editing, title: event.currentTarget.value })
              }
              placeholder="Name"
              aria-label="Bookmark name"
              autoFocus
              className="h-6 w-full rounded-md border border-content/10 bg-content/5 px-2 text-[12px] text-content outline-none focus:border-content/25"
            />
            <input
              value={editing.url}
              onChange={(event) => {
                setEditing({ ...editing, url: event.currentTarget.value });
                setEditError("");
              }}
              placeholder="URL"
              aria-label="Bookmark URL"
              spellCheck={false}
              autoCapitalize="off"
              className="h-6 w-full rounded-md border border-content/10 bg-content/5 px-2 font-mono text-[11.5px] text-content outline-none focus:border-content/25"
            />
            {editError ? (
              <p className="text-[11px] text-red-400">{editError}</p>
            ) : null}
            <div className="flex items-center gap-1">
              <button
                type="submit"
                aria-label="Save bookmark"
                className="grid size-5 place-items-center rounded text-content/60 hover:bg-content/10 hover:text-content"
              >
                <Check className="size-3" strokeWidth={2} />
              </button>
              <button
                type="button"
                aria-label="Cancel"
                className="grid size-5 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
                onClick={() => {
                  setEditing(null);
                  setEditError("");
                }}
              >
                <X className="size-3" strokeWidth={1.75} />
              </button>
            </div>
          </form>
        ) : (
          <div key={fav.id} className="group flex items-center gap-1">
            <button
              type="button"
              role="menuitem"
              className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-none text-content hover:bg-content/5"
              onClick={() => onPick(fav.url)}
              title={fav.url}
            >
              <Globe className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">
                {fav.title || browserTabLabel(fav.url)}
              </span>
            </button>
            <button
              type="button"
              aria-label="Edit bookmark"
              className="grid size-5 shrink-0 place-items-center rounded text-content/40 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
              onClick={() => {
                setEditing({ id: fav.id, title: fav.title, url: fav.url });
                setEditError("");
              }}
            >
              <Pencil className="size-3" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="Delete bookmark"
              className="grid size-5 shrink-0 place-items-center rounded text-content/40 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
              onClick={() => removeBrowserFavorite(fav.id)}
            >
              <Trash2 className="size-3" strokeWidth={1.75} />
            </button>
          </div>
        ),
      )}
      {!favorites.length ? (
        <p className="px-2 py-1.5 text-[12px] text-content/45">
          No bookmarks yet — open a page and star it.
        </p>
      ) : null}
    </Popover>
  );
}

function EmptyBrowserState({
  suggested,
  favorites,
  onSubmit,
}: {
  suggested?: string;
  favorites: BrowserFavorite[];
  onSubmit: (url: string) => void;
}) {
  const [value, setValue] = useState(suggested ?? "");
  const [error, setError] = useState("");
  return (
    <div className="absolute inset-0 grid place-items-center overflow-y-auto p-6">
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
        {favorites.length ? (
          <div className="mt-5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-content/40">
              Bookmarks
            </p>
            <div className="mt-1.5 flex flex-col gap-0.5">
              {favorites.slice(0, 8).map((fav) => (
                <button
                  key={fav.id}
                  type="button"
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-content/75 hover:bg-content/5 hover:text-content"
                  onClick={() => onSubmit(fav.url)}
                  title={fav.url}
                >
                  <Globe
                    className="size-3.5 shrink-0 text-content/40"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {fav.title || browserTabLabel(fav.url)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </form>
    </div>
  );
}
