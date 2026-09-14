import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Camera, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDot, ExternalLink, EyeOff, Globe, KeyRound, ListBullet, Maximize2, Minimize2, MoreHorizontal, Pencil, RefreshCw, Search, Star, Trash2, X } from "../chrome/icons";
import { ExplorerMenu, type ExplorerMenuItem } from "../chrome/ExplorerMenu";
import { ALT, MOD } from "../lib/platform";

import {
  BROWSER_COMMAND_EVENT,
  browserAgentContext,
  browserCapture,
  browserCaptureLogin,
  browserClearData,
  browserClipboardUrl,
  browserClose,
  browserCopyScreenshot,
  browserDevtools,
  browserFavorites,
  browserFillLogin,
  browserFind,
  browserGoBack,
  browserGoForward,
  browserLoginDelete,
  browserLoginUpdate,
  browserLoginsList,
  browserNavigate,
  browserOpen,
  browserProbe,
  browserReload,
  browserSetBackground,
  browserSetBounds,
  browserSetRecording,
  browserSetVisible,
  browserSetZoom,
  browserTabLabel,
  isBrowserCommandRequest,
  isBrowserFavorite,
  isHttpUrl,
  normalizeBrowserUrl,
  rememberedBrowserUrl,
  rememberBrowserUrl,
  removeBrowserFavorite,
  subscribeBrowser,
  subscribeBrowserFavorites,
  toggleBrowserFavorite,
  updateBrowserFavorite,
  type BrowserFavorite,
  type BrowserLoginMeta,
} from "../lib/browser";
import { requestAgentContext } from "../lib/agentContext";
import type {
  BrowserMetaPatch,
  BrowserTabSource,
  FilePaneTab,
} from "../lib/layout";
import { wslLocation } from "../lib/paths";

type LoadStatus = "idle" | "opening" | "loading" | "ready" | "failed";

type Props = {
  file: FilePaneTab & { browser: BrowserTabSource };
  /** The tab is the active tab of a pane that is on screen. */
  active: boolean;
  /** Another pane is expanded over this one — the DOM rect still reports
   * layout, so the webview must be hidden explicitly. */
  occluded?: boolean;
  onMetaChange?: (patch: BrowserMetaPatch) => void;
};

const WATCHDOG_FIRST_MS = 8_000;
const WATCHDOG_RETRY_MS = 6_000;
const WATCHDOG_MAX_ATTEMPTS = 3;
/** Re-checks the host rect — pane position can shift without a resize. */
const BOUNDS_POLL_MS = 800;
/** Chrome-style zoom ladder — Cmd +/- steps through these. */
const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

type Rgba = [number, number, number, number];

function parseCssColor(value: string): Rgba | undefined {
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(
    value,
  );
  if (rgb) {
    const a =
      rgb[4] === undefined
        ? 1
        : rgb[4].endsWith("%")
          ? parseFloat(rgb[4]) / 100
          : parseFloat(rgb[4]);
    return [+rgb[1], +rgb[2], +rgb[3], Math.round(a * 255)];
  }
  const srgb =
    /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(
      value,
    );
  if (srgb) {
    const a =
      srgb[4] === undefined
        ? 1
        : srgb[4].endsWith("%")
          ? parseFloat(srgb[4]) / 100
          : parseFloat(srgb[4]);
    return [
      Math.round(+srgb[1] * 255),
      Math.round(+srgb[2] * 255),
      Math.round(+srgb[3] * 255),
      Math.round(a * 255),
    ];
  }
}

/** First painted background above the host — the color the native
 * webview should flash while a navigation swaps renderer processes. */
function paneBackground(host: HTMLElement | null): Rgba | undefined {
  let el = host;
  while (el) {
    const color = parseCssColor(getComputedStyle(el).backgroundColor);
    if (color && color[3] > 0) return color;
    el = el.parentElement;
  }
}

/**
 * Chrome around a native child webview. React draws the toolbar, notices,
 * empty state and failure state; the page itself is rendered by the webview
 * positioned over `hostRef`. The webview is created lazily on first
 * activation and destroyed on unmount — hiding only toggles visibility.
 */
export function BrowserView({
  file,
  active,
  occluded,
  onMetaChange,
}: Props) {
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
  /** Latest committed URL — the subscription callback can't see state. */
  const currentRef = useRef(url);
  /** Mirror of `recording` for the page-event subscription. */
  const recordingRef = useRef(false);
  /** The origin-move stop notice survives the Finished half of the same
   * navigation (and a redirect's second URL) instead of being cleared by
   * it — cleared on the next genuinely different navigation. */
  const stopNoticeRef = useRef(false);

  const [opened, setOpened] = useState(false);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [current, setCurrent] = useState(url);
  const [draft, setDraft] = useState(url);
  const [draftError, setDraftError] = useState("");
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [popup, setPopup] = useState<string | null>(null);
  const [download, setDownload] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordStart, setRecordStart] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  /** A steps session ran this mount — gates the steps-send so it doesn't
   * pay for a full capture just to refuse an empty trail. */
  const [recordedOnce, setRecordedOnce] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findResult, setFindResult] = useState<{
    count: number;
    index: number;
  } | null>(null);
  const [loginsOpen, setLoginsOpen] = useState(false);
  const [logins, setLogins] = useState<BrowserLoginMeta[]>([]);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const findTimerRef = useRef<number | null>(null);
  /** Latest find query for the page-event subscription. */
  const findQueryRef = useRef("");
  /** Storage mode the live webview was created with. */
  const persist = file.browser.persist !== false;
  const persistRef = useRef(persist);
  /** Page zoom — mirrored so command handlers don't read stale props. */
  const zoomRef = useRef(file.browser.zoom ?? 1);
  zoomRef.current = file.browser.zoom ?? 1;
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

  /** Stop the steps session; the page-side flag is the real gate, the
   * eval just flips it — harmless on a page where it no longer exists. */
  const stopRecording = useCallback(
    (message?: string): void => {
      recordingRef.current = false;
      setRecording(false);
      setRecordStart(null);
      if (message) setNotice(message);
      void browserSetRecording(label, false).catch(() => undefined);
    },
    [label],
  );

  const toggleRecording = useCallback(() => {
    const next = !recordingRef.current;
    void browserSetRecording(label, next)
      .then((applied) => {
        // No hook on this page (e.g. still on its first load) — starting
        // would show an indicator that records nothing.
        if (next && !applied) {
          setNotice("Can't record steps on this page");
          return;
        }
        recordingRef.current = next;
        setRecording(next);
        setRecordStart(next ? Date.now() : null);
        setElapsed(0);
        if (next) setRecordedOnce(true);
      })
      .catch((error) =>
        setNotice(error instanceof Error ? error.message : String(error)),
      );
  }, [label]);

  const reloadPage = useCallback(() => {
    setStatus("loading");
    if (currentRef.current) armWatchdog(currentRef.current);
    void browserReload(label).catch(() => undefined);
  }, [label, armWatchdog]);

  const applyZoom = useCallback(
    (next: number) => {
      void browserSetZoom(label, next)
        .then((applied) => {
          zoomRef.current = applied;
          onMetaChangeRef.current?.({ zoom: applied });
        })
        .catch(() => undefined);
    },
    [label],
  );

  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const current = zoomRef.current;
      const next =
        dir > 0
          ? (ZOOM_STEPS.find((step) => step > current + 0.001) ??
            ZOOM_STEPS[ZOOM_STEPS.length - 1])
          : ([...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ??
            ZOOM_STEPS[0]);
      applyZoom(next);
    },
    [applyZoom],
  );

  const runFind = useCallback(
    (query: string, forward = true) => {
      void browserFind(label, query, forward)
        .then((result) => setFindResult(result))
        .catch(() => setFindResult(null));
    },
    [label],
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindResult(null);
    if (findTimerRef.current != null)
      window.clearTimeout(findTimerRef.current);
    findTimerRef.current = null;
    // Empty query clears page-side highlights and match state.
    void browserFind(label, "").catch(() => undefined);
  }, [label]);

  const refreshLogins = useCallback(() => {
    const origin = urlOrigin(currentRef.current);
    if (!origin) {
      setLogins([]);
      return;
    }
    void browserLoginsList(origin)
      .then(setLogins)
      .catch(() => setLogins([]));
  }, []);

  const saveLogin = useCallback(() => {
    void browserCaptureLogin(label)
      .then((meta) => {
        setNotice(`Saved ${meta.username} for ${meta.origin}`);
        refreshLogins();
      })
      .catch((error) =>
        setNotice(error instanceof Error ? error.message : String(error)),
      );
  }, [label, refreshLogins]);

  const fillLogin = useCallback(
    (profileId?: string) => {
      void browserFillLogin(label, profileId)
        .then((result) => {
          if (result.filled.length) {
            setNotice(
              `Filled ${result.filled.join(" + ")}${
                result.submitted
                  ? " — submitted"
                  : result.otpRequired
                    ? " — type the one-time code yourself"
                    : ""
              }`,
            );
          } else if (result.missing.length) {
            setNotice(`No ${result.missing.join(" or ")} field on this page`);
          } else {
            setNotice("No matching fields on this page");
          }
        })
        .catch((error) =>
          setNotice(error instanceof Error ? error.message : String(error)),
        );
    },
    [label],
  );

  const clearSiteData = useCallback(() => {
    void (async () => {
      const ok = await ask(
        "Clear cookies and site data for every site in this browser profile? You'll be signed out everywhere.",
        { title: "MonoCode", kind: "warning", okLabel: "Clear data" },
      ).catch(() => false);
      if (!ok) return;
      try {
        await browserClearData(label);
        setNotice("Site data cleared");
        reloadPage();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [label, reloadPage]);

  const onMenuPick = useCallback(
    (id: string) => {
      setMenuAt(null);
      switch (id) {
        case "find":
          setFindOpen(true);
          break;
        case "copy-url":
          void writeClipboardText(currentRef.current)
            .then(() => setNotice("URL copied"))
            .catch((error) =>
              setNotice(error instanceof Error ? error.message : String(error)),
            );
          break;
        case "copy-shot":
          void browserCopyScreenshot(label)
            .then(() => setNotice("Screenshot copied"))
            .catch((error) =>
              setNotice(error instanceof Error ? error.message : String(error)),
            );
          break;
        case "zoom-in":
          stepZoom(1);
          break;
        case "zoom-out":
          stepZoom(-1);
          break;
        case "zoom-reset":
          applyZoom(1);
          break;
        case "devtools":
          void browserDevtools(label).catch((error) =>
            setNotice(error instanceof Error ? error.message : String(error)),
          );
          break;
        case "private":
          // Recreates the webview on the other data store — the page reloads.
          onMetaChangeRef.current?.({ persist: !persist });
          break;
        case "clear-data":
          clearSiteData();
          break;
      }
    },
    [label, persist, stepZoom, applyZoom, clearSiteData],
  );

  // Menu accelerators and the App key handler route browser commands here
  // — they fire even while the native webview holds DOM-unreachable focus.
  useEffect(() => {
    const onCommand = (event: Event) => {
      if (!isBrowserCommandRequest(event) || event.detail.label !== label)
        return;
      switch (event.detail.command) {
        case "reload":
          reloadPage();
          break;
        case "focus-url":
          urlInputRef.current?.focus();
          urlInputRef.current?.select();
          break;
        case "find":
          setFindOpen(true);
          break;
        case "zoom-in":
          stepZoom(1);
          break;
        case "zoom-out":
          stepZoom(-1);
          break;
        case "zoom-reset":
          applyZoom(1);
          break;
        case "devtools":
          void browserDevtools(label).catch(() => undefined);
          break;
      }
    };
    window.addEventListener(BROWSER_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(BROWSER_COMMAND_EVENT, onCommand);
  }, [label, reloadPage, stepZoom, applyZoom]);

  // The recording chip's elapsed timer — only ticks while a session runs.
  useEffect(() => {
    if (!recording || recordStart == null) return;
    const tick = () => setElapsed(Date.now() - recordStart);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [recording, recordStart]);

  // Page events → tab state. `navigate` fires for every committed
  // navigation (initial load, user clicks, redirects, history moves).
  useEffect(() => {
    return subscribeBrowser(label, (event) => {
      switch (event.kind) {
        case "navigate": {
          const next = event.url ?? "";
          const prev = currentRef.current;
          // The session flag can't cross origins — make the end visible
          // instead of leaving a dead indicator running.
          const movedOrigin = urlOrigin(prev) !== urlOrigin(next);
          const stopped = movedOrigin && recordingRef.current;
          currentRef.current = next;
          setCurrent(next);
          setDraft(next);
          setCanBack(event.canBack);
          setCanForward(event.canForward);
          if (stopped) {
            stopNoticeRef.current = true;
            stopRecording(
              "Recording stopped — the page moved to a different site",
            );
          } else if (stopNoticeRef.current) {
            // `navigate` fires for both Started and Finished of a commit
            // (a redirect produces two different URLs) — consume the flag
            // so that second event doesn't clear the stop notice.
            stopNoticeRef.current = false;
          } else if (next !== prev) {
            setNotice(null);
          }
          setPopup(null);
          setDownload(null);
          setFailure("");
          setStatus("loading");
          setFindResult(null);
          armWatchdog(next);
          onMetaChangeRef.current?.({ url: next });
          rememberBrowserUrl(cwdRef.current, next);
          break;
        }
        case "load-started":
          setStatus("loading");
          break;
        case "load-finished": {
          clearWatchdog();
          setStatus("ready");
          // A navigation replaces the document — re-run an open find.
          if (findQueryRef.current) runFind(findQueryRef.current);
          // Keep the indicator honest: a recreated webview lost the flag
          // with its fresh sessionStorage — re-assert it (idempotent, the
          // trail survives); a document that can't record — about:/data:
          // never emit `navigate`, so this is the only signal — stops it.
          if (recordingRef.current) {
            if (/^https?:/.test(event.url ?? "")) {
              void browserSetRecording(label, true).then((applied) => {
                if (!applied && recordingRef.current) {
                  stopRecording(
                    "Recording stopped — this page can't be recorded",
                  );
                }
              });
            } else {
              stopRecording("Recording stopped — this page can't be recorded");
            }
          }
          break;
        }
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
          // Denied by design — offer the system browser as the way out.
          if (event.url && isHttpUrl(event.url)) setDownload(event.url);
          else setNotice(event.reason ?? "Downloads are not allowed in Browser");
          break;
      }
    });
  }, [label, armWatchdog, clearWatchdog, stopRecording, runFind]);

  const wantShowRef = useRef(false);
  const bgRef = useRef<Rgba | undefined>(undefined);
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
      // The "hidden" view was parked offscreen, so the real bounds must be
      // re-sent even when they match the last visible frame.
      boundsRef.current = null;
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
  // in-flight open before issuing its own — never drops its URL. A
  // `persist` flip recreates the webview on the other data store — its
  // cookies/site data live there, so the page reloads.
  useEffect(() => {
    if (!active || !url) return;
    if (openedRef.current && persistRef.current === persist) return;
    let alive = true;
    const open = async () => {
      while (openingRef.current) {
        try {
          await openingRef.current;
        } catch {
          // The in-flight run already reported its own failure.
        }
        if (!alive) return;
        if (openedRef.current && persistRef.current === persist) return;
      }
      const pending = (async () => {
        try {
          if (openedRef.current) {
            // Switching stores — close before re-opening under the same
            // label so the close can't kill the new webview.
            openedRef.current = false;
            shownRef.current = false;
            boundsRef.current = null;
            await browserClose(label).catch(() => undefined);
            if (!alive) return;
          }
          const rect = hostRef.current?.getBoundingClientRect();
          const bounds = rect
            ? { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) }
            : { x: 0, y: 0, width: 1, height: 1 };
          const background = paneBackground(hostRef.current);
          bgRef.current = background;
          await browserOpen(label, url, bounds, background, persist);
          if (!alive) {
            void browserClose(label).catch(() => undefined);
            return;
          }
          persistRef.current = persist;
          openedRef.current = true;
          shownRef.current = true;
          boundsRef.current = bounds;
          setOpened(true);
          setStatus("loading");
          if (zoomRef.current !== 1) {
            void browserSetZoom(label, zoomRef.current).catch(() => undefined);
          }
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
  }, [active, url, label, persist, armWatchdog]);

  // The webview dies with the tab — never on hide, so switching sessions
  // keeps the page and its scroll/form state.
  useEffect(
    () => () => {
      clearWatchdog();
      if (findTimerRef.current != null) {
        window.clearTimeout(findTimerRef.current);
        findTimerRef.current = null;
      }
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
        const host = hostRef.current;
        if (!openedRef.current || !host) return;
        const hostRect = host.getBoundingClientRect();
        const has = Array.from(
          document.body.querySelectorAll<HTMLElement>(OVERLAY),
        ).some((el) => {
          if (host.contains(el) || el.contains(host)) return false;
          if (el.closest("[aria-hidden='true'], [inert], .hidden"))
            return false;
          const rect = el.getBoundingClientRect();
          // Only an overlay that actually overlaps the page area needs the
          // webview parked — a menu or toast elsewhere must not blank it.
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left < hostRect.right &&
            rect.right > hostRect.left &&
            rect.top < hostRect.bottom &&
            rect.bottom > hostRect.top
          );
        });
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

  // Theme flips rewrite the document's class and inline custom props —
  // keep the webview's swap-flash color in step with the pane behind it.
  useEffect(() => {
    const update = () => {
      if (!openedRef.current) return;
      const next = paneBackground(hostRef.current);
      const prev = bgRef.current;
      if (!next || (prev && next.every((v, i) => v === prev[i]))) return;
      bgRef.current = next;
      void browserSetBackground(label, next).catch(() => undefined);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, [label]);

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

  const expanded = !!file.browser.expanded;
  const wantShow =
    opened && active && !overlayOpen && status !== "failed" && !occluded;
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
   * destination picker. Page content stays data — never an instruction.
   * `includeSteps` snapshots the recorded session's trail — it does not
   * stop the session (the toggle owns that), so cancelling the picker
   * loses nothing and an in-flight interaction can't be truncated. */
  const captureForAgent = useCallback(
    (includeSteps = false) => {
      if (capturing) return;
      setCapturing(true);
      void (async () => {
        try {
          const capture = await browserCapture(label);
          if (includeSteps && !capture.steps.length) {
            setNotice("No steps recorded — press the record button first");
            return;
          }
          const context = browserAgentContext(
            capture,
            cwdRef.current,
            includeSteps,
          );
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
    },
    [capturing, label],
  );

  const wsl = wslLocation(file.cwd);
  const showChrome = !!url;
  const zoomPct = Math.round((file.browser.zoom ?? 1) * 100);
  const menuItems: ExplorerMenuItem[] = [
    { kind: "item", id: "find", label: "Find in Page", shortcut: `${MOD}F`, disabled: !opened },
    { kind: "item", id: "copy-url", label: "Copy URL", disabled: !current },
    {
      kind: "item",
      id: "copy-shot",
      label: "Copy Screenshot",
      disabled: !opened,
    },
    { kind: "sep" },
    {
      kind: "item",
      id: "zoom-in",
      label: "Zoom In",
      description: zoomPct === 100 ? undefined : `Currently ${zoomPct}%`,
      disabled: !opened,
    },
    { kind: "item", id: "zoom-out", label: "Zoom Out", disabled: !opened },
    {
      kind: "item",
      id: "zoom-reset",
      label: "Reset Zoom",
      disabled: !opened || zoomPct === 100,
    },
    { kind: "sep" },
    {
      kind: "item",
      id: "devtools",
      label: "Developer Tools",
      shortcut: `${MOD}${ALT}I`,
      disabled: !opened,
    },
    {
      kind: "item",
      id: "private",
      label: "Private Tab",
      checked: !persist,
      description: "Forget site data when this tab closes — the page reloads",
    },
    { kind: "sep" },
    {
      kind: "item",
      id: "clear-data",
      label: "Clear Saved Site Data…",
      danger: true,
      disabled: !persist,
    },
  ];

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
            title={`Reload (${MOD}R)`}
            disabled={!opened}
            onClick={reloadPage}
          >
            <RefreshCw className="size-3" strokeWidth={1.75} />
          </ToolbarButton>
          <form onSubmit={onSubmitUrl} className="min-w-0 flex-1">
            <input
              ref={urlInputRef}
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
            title="Send page and screenshot to an agent"
            disabled={!opened || capturing}
            onClick={() => captureForAgent()}
          >
            <Camera className="size-3.5" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton
            title={recording ? "Stop recording steps" : "Record steps to reproduce"}
            disabled={!opened}
            pressed={recording}
            onClick={toggleRecording}
          >
            <CircleDot
              className={`size-3.5 ${recording ? "fill-red-400/30 text-red-400" : ""}`}
              strokeWidth={1.75}
            />
          </ToolbarButton>
          {recording && recordStart != null ? (
            <span
              className="shrink-0 rounded-md bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums text-red-400"
              title="Recording browser steps"
            >
              {elapsedLabel(elapsed)}
            </span>
          ) : null}
          <ToolbarButton
            title="Send page and recorded steps to an agent"
            disabled={!opened || capturing || (!recording && !recordedOnce)}
            onClick={() => captureForAgent(true)}
          >
            <ListBullet className="size-3.5" strokeWidth={1.75} />
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
            pressed={bookmarksOpen}
            onClick={() => setBookmarksOpen((open) => !open)}
          >
            <ChevronDown className="size-3.5" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton
            title="Logins — save or fill credentials for this site"
            pressed={loginsOpen}
            disabled={!opened && !current}
            onClick={() => {
              setLoginsOpen((open) => {
                if (!open) refreshLogins();
                return !open;
              });
            }}
          >
            <KeyRound className="size-3.5" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton
            title="More actions"
            pressed={menuAt != null}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenuAt({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
          </ToolbarButton>
          {!persist ? (
            <span
              className="grid size-5 shrink-0 place-items-center rounded-md bg-content/8 text-content/60"
              title="Private tab — site data is forgotten when the tab closes"
            >
              <EyeOff className="size-3" strokeWidth={1.75} />
            </span>
          ) : null}
          <ToolbarButton
            title={expanded ? "Back to split view" : "Fill the workspace"}
            pressed={expanded}
            onClick={() => onMetaChange?.({ expanded: !expanded })}
          >
            {expanded ? (
              <Minimize2 className="size-3.5" strokeWidth={1.75} />
            ) : (
              <Maximize2 className="size-3.5" strokeWidth={1.75} />
            )}
          </ToolbarButton>
        </div>
      ) : null}
      {showChrome && bookmarksOpen ? (
        <BrowserBookmarksBar
          current={current}
          onPick={navigate}
        />
      ) : null}
      {showChrome && findOpen ? (
        <BrowserFindBar
          query={findQuery}
          result={findResult}
          onQuery={(query) => {
            setFindQuery(query);
            findQueryRef.current = query;
            if (findTimerRef.current != null)
              window.clearTimeout(findTimerRef.current);
            findTimerRef.current = window.setTimeout(() => {
              findTimerRef.current = null;
              runFind(query);
            }, 120);
          }}
          onStep={(forward) => runFind(findQueryRef.current, forward)}
          onClose={closeFind}
        />
      ) : null}
      {showChrome && loginsOpen ? (
        <BrowserLoginsBar
          origin={urlOrigin(current)}
          logins={logins}
          onFill={fillLogin}
          onSave={saveLogin}
          onPatch={(id, patch) => {
            void browserLoginUpdate(id, patch)
              .then(() => refreshLogins())
              .catch((error) =>
                setNotice(
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }}
          onDelete={(id) => {
            void browserLoginDelete(id)
              .then(() => refreshLogins())
              .catch((error) =>
                setNotice(
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }}
          onClose={() => setLoginsOpen(false)}
        />
      ) : null}
      {notice || popup || draftError || download ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-content/10 bg-content/5 px-3 py-1.5 text-[12px] text-content/75">
          <span className="min-w-0 flex-1 truncate" title={download ?? popup ?? notice ?? draftError}>
            {draftError ||
              (popup
                ? `Popup blocked: ${popup}`
                : download
                  ? `Download blocked: ${download}`
                  : notice)}
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
          {download ? (
            <button
              type="button"
              className="shrink-0 rounded-md bg-content/10 px-2 py-0.5 hover:bg-content/15"
              onClick={() => {
                const target = download;
                setDownload(null);
                void openUrl(target).catch(() => undefined);
              }}
            >
              Open externally
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
            onClick={() => {
              setNotice(null);
              setPopup(null);
              setDownload(null);
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
      {menuAt ? (
        <ExplorerMenu
          x={menuAt.x}
          y={menuAt.y}
          items={menuItems}
          ariaLabel="Browser actions"
          onPick={onMenuPick}
          onClose={() => setMenuAt(null)}
        />
      ) : null}
    </div>
  );
}

function ToolbarButton({
  title,
  disabled,
  pressed,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/10 hover:text-content disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  );
}

/**
 * Chrome-style bookmarks bar under the toolbar — a DOM popover would
 * paint under the native webview, so the list lives in flow and the page
 * keeps rendering (just a little shorter). Editing is inline for the
 * same reason.
 */
function BrowserBookmarksBar({
  current,
  onPick,
}: {
  current: string;
  onPick: (url: string) => void;
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
    <div
      role="toolbar"
      aria-label="Bookmarks"
      className="flex min-h-7 shrink-0 flex-wrap items-center gap-1 border-b border-content/10 bg-content/2 px-2 py-1"
    >
      {current && !isBrowserFavorite(current) ? (
        <button
          type="button"
          className="flex h-5.5 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] leading-none text-content/60 hover:bg-content/8 hover:text-content"
          onClick={() => toggleBrowserFavorite(current)}
        >
          <Star className="size-3 shrink-0" strokeWidth={1.75} />
          Bookmark this page
        </button>
      ) : null}
      {favorites.map((fav) =>
        editing?.id === fav.id ? (
          <form
            key={fav.id}
            className="flex min-w-0 flex-1 items-center gap-1"
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
              className="h-5.5 w-28 shrink-0 rounded-md border border-content/10 bg-content/5 px-1.5 text-[11.5px] text-content outline-none focus:border-content/25"
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
              className="h-5.5 min-w-24 flex-1 rounded-md border border-content/10 bg-content/5 px-1.5 font-mono text-[11px] text-content outline-none focus:border-content/25"
            />
            {editError ? (
              <span className="shrink-0 text-[11px] text-red-400">
                {editError}
              </span>
            ) : null}
            <button
              type="submit"
              aria-label="Save bookmark"
              className="grid size-5 shrink-0 place-items-center rounded text-content/60 hover:bg-content/10 hover:text-content"
            >
              <Check className="size-3" strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label="Cancel"
              className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
              onClick={() => {
                setEditing(null);
                setEditError("");
              }}
            >
              <X className="size-3" strokeWidth={1.75} />
            </button>
          </form>
        ) : (
          <div key={fav.id} className="group flex min-w-0 items-center">
            <button
              type="button"
              className="flex h-5.5 min-w-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] leading-none text-content/75 hover:bg-content/8 hover:text-content"
              onClick={() => onPick(fav.url)}
              title={fav.url}
            >
              <Globe className="size-3 shrink-0 text-content/40" strokeWidth={1.75} />
              <span className="max-w-40 truncate">
                {fav.title || browserTabLabel(fav.url)}
              </span>
            </button>
            <button
              type="button"
              aria-label="Edit bookmark"
              className="grid size-4.5 shrink-0 place-items-center rounded text-content/40 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
              onClick={() => {
                setEditing({ id: fav.id, title: fav.title, url: fav.url });
                setEditError("");
              }}
            >
              <Pencil className="size-2.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="Delete bookmark"
              className="grid size-4.5 shrink-0 place-items-center rounded text-content/40 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
              onClick={() => removeBrowserFavorite(fav.id)}
            >
              <Trash2 className="size-2.5" strokeWidth={1.75} />
            </button>
          </div>
        ),
      )}
      {!favorites.length ? (
        <span className="px-1 text-[11.5px] text-content/40">
          No bookmarks yet — open a page and star it.
        </span>
      ) : null}
    </div>
  );
}

/**
 * In-flow find bar — a popover can't float over the native webview, so
 * this trades page height for the bar like the bookmarks bar does. Enter
 * steps forward, Shift+Enter back, Esc closes and clears highlights.
 */
function BrowserFindBar({
  query,
  result,
  onQuery,
  onStep,
  onClose,
}: {
  query: string;
  result: { count: number; index: number } | null;
  onQuery: (query: string) => void;
  onStep: (forward: boolean) => void;
  onClose: () => void;
}) {
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onStep(!event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };
  const count = !query
    ? ""
    : result == null
      ? ""
      : result.count === 0
        ? "No matches"
        : `${result.index + 1} of ${result.count}`;
  return (
    <div
      role="search"
      aria-label="Find in page"
      className="flex h-8 shrink-0 items-center gap-1.5 border-b border-content/10 bg-content/2 px-2"
    >
      <Search className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
      <input
        value={query}
        onChange={(event) => onQuery(event.currentTarget.value)}
        onKeyDown={onKey}
        placeholder="Find in page"
        aria-label="Find in page"
        autoFocus
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="h-5.5 min-w-0 flex-1 rounded-md border border-content/10 bg-content/5 px-2 text-[11.5px] text-content outline-none focus:border-content/25"
      />
      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-content/50">
        {count}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!result?.count}
        className="grid size-5.5 shrink-0 place-items-center rounded text-content/60 hover:bg-content/10 hover:text-content disabled:opacity-35"
        onClick={() => onStep(false)}
      >
        <ChevronDown className="size-3.5 rotate-180" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!result?.count}
        className="grid size-5.5 shrink-0 place-items-center rounded text-content/60 hover:bg-content/10 hover:text-content disabled:opacity-35"
        onClick={() => onStep(true)}
      >
        <ChevronDown className="size-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label="Close find"
        title="Close (Esc)"
        className="grid size-5.5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
        onClick={onClose}
      >
        <X className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}

/**
 * Saved logins for the page's origin — in-flow like the bookmarks bar.
 * Passwords never reach this list: "Save typed login" reads the page's
 * fields straight into the Rust-side secret file; Fill injects them back
 * without the frontend seeing the values.
 */
function BrowserLoginsBar({
  origin,
  logins,
  onFill,
  onSave,
  onPatch,
  onDelete,
  onClose,
}: {
  origin: string;
  logins: BrowserLoginMeta[];
  onFill: (id: string) => void;
  onSave: () => void;
  onPatch: (
    id: string,
    patch: { submit?: boolean; rememberMe?: boolean },
  ) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      aria-label="Saved logins"
      className="shrink-0 border-b border-content/10 bg-content/2 px-2 py-1.5"
    >
      <div className="flex items-center gap-2">
        <KeyRound className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-content/40">
          Logins{origin ? ` · ${origin}` : ""}
        </span>
        <button
          type="button"
          className="shrink-0 rounded-md bg-content/10 px-2 py-0.5 text-[11.5px] leading-none text-content/75 hover:bg-content/15 hover:text-content"
          title="Store the credentials you just typed on this page"
          onClick={onSave}
        >
          Save typed login
        </button>
        <button
          type="button"
          aria-label="Close logins"
          className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
          onClick={onClose}
        >
          <X className="size-3" strokeWidth={1.75} />
        </button>
      </div>
      {logins.length ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {logins.map((login) => (
            <div key={login.id} className="flex items-center gap-1.5">
              <span
                className="min-w-0 flex-1 truncate text-[11.5px] text-content/75"
                title={login.username}
              >
                {login.username}
              </span>
              <label
                className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-content/55"
                title="Click the form's submit/next control after filling"
              >
                <input
                  type="checkbox"
                  checked={login.submit}
                  onChange={() => onPatch(login.id, { submit: !login.submit })}
                  className="size-3 accent-current"
                />
                Submit
              </label>
              <label
                className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-content/55"
                title="Tick a “remember me” checkbox when the page has one"
              >
                <input
                  type="checkbox"
                  checked={login.rememberMe}
                  onChange={() =>
                    onPatch(login.id, { rememberMe: !login.rememberMe })
                  }
                  className="size-3 accent-current"
                />
                Remember
              </label>
              <button
                type="button"
                className="shrink-0 rounded-md bg-content/10 px-2 py-0.5 text-[11.5px] leading-none text-content/75 hover:bg-content/15 hover:text-content"
                onClick={() => onFill(login.id)}
              >
                Fill
              </button>
              <button
                type="button"
                aria-label="Delete login"
                title="Delete login"
                className="grid size-5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
                onClick={() => onDelete(login.id)}
              >
                <Trash2 className="size-3" strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-[11.5px] text-content/40">
          No saved logins for this site — type them into the page, then “Save
          typed login”.
        </p>
      )}
    </div>
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
  const paste = () => {
    // Reads the pasteboard natively — `navigator.clipboard.readText` in
    // WKWebView shows a floating "Paste" consent bubble even on a real
    // click, so the paste goes through the plugin instead. A clipboard
    // URL opens straight away; anything else fills the field for editing.
    void readClipboardText()
      .then((text) => {
        const url = browserClipboardUrl(text);
        if (url) onSubmit(url);
        else setValue(text.trim());
      })
      .catch(() => undefined);
  };
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
          onFocus={(event) => event.currentTarget.select()}
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
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="submit"
            disabled={!value.trim()}
            className="rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/90 disabled:opacity-40"
          >
            Open
          </button>
          <button
            type="button"
            onClick={paste}
            className="rounded-md bg-content/10 px-3 py-1.5 text-[12px] font-medium text-content hover:bg-content/15"
          >
            Paste URL
          </button>
        </div>
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
