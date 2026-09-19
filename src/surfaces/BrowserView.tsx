import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { copyText as writeClipboardText } from "../lib/clipboard";
import { BrowserContextPicker } from "../chrome/BrowserContextPicker";
import type { AgentContext } from "../lib/agentContext";
import type { Session } from "../lib/session";
const readClipboardText = () => invoke<string>("browser_read_clipboard");
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
} from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";
import { Camera, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDot, ExternalLink, EyeOff, Globe, ListBullet, Maximize2, Minimize2, MoreHorizontal, Pencil, RefreshCw, Search, Star, Trash2, X } from "../chrome/icons";

import { MOD } from "../lib/platform";

import {
  BROWSER_COMMAND_EVENT,
  browserAgentContext,
  browserCapture,
  browserClearData,
  browserClipboardUrl,
  browserClose,
  browserCopyScreenshot,
  browserDevtools,
  browserFavorites,
  browserFind,
  browserGoBack,
  browserGoForward,
  browserNavigate,
  browserOpen,
  browserProbe,
  browserReload,
  browserSetBackground,
  browserSetBounds,
  browserSetRecording,
  browserSetVisible,
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
} from "../lib/browser";

import type { BrowserMetaPatch, BrowserTabSource } from "../lib/browserWorkspace";
import type { FilePaneTab } from "../lib/layout";
import { wslLocation } from "../lib/paths";

type LoadStatus = "idle" | "opening" | "loading" | "ready" | "failed";

type Props = {
  sessions: readonly Session[];
  file: FilePaneTab & { browser: BrowserTabSource };
  /** The tab is the active tab of a pane that is on screen. */
  active: boolean;
  /** Another pane is expanded over this one — the DOM rect still reports
   * layout, so the webview must be hidden explicitly. */
  occluded?: boolean;
  onFocus?: () => void;
  onMetaChange?: (patch: BrowserMetaPatch) => void;
};

const WATCHDOG_FIRST_MS = 8_000;
const WATCHDOG_RETRY_MS = 6_000;
const WATCHDOG_MAX_ATTEMPTS = 3;
/** Re-checks the host rect — pane position can shift without a resize. */
const BOUNDS_POLL_MS = 800;

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
  sessions,
  active,
  occluded,
  onMetaChange,
  onFocus,
}: Props) {
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const [captureContext, setCaptureContext] = useState<AgentContext | null>(null);
  const captureOwner = useRef(0);
  useEffect(() => {
    setCaptureContext(null);
    setCapturing(false);
    return () => { captureOwner.current++; };
  }, [file.id, file.cwd, file.browser.persist]);
  const persist = file.browser.persist !== false;
  // A remount or profile change must never receive a predecessor's queued IPC.
  const label = useMemo(() => `browser-${crypto.randomUUID()}`, [file.id, persist]);
  const nativeLabel = useRef(label);
  nativeLabel.current = label;
  const operationsEpoch = useRef(0);
  const recordingRequest = useRef(0);
  const recordingDesired = useRef(false);
  const recordingQueue = useRef(Promise.resolve());
  const findRequest = useRef(0);
  const findQueue = useRef(Promise.resolve());
  const geometryQueue = useRef(Promise.resolve());
  const focusRef = useRef({ active, occluded, onFocus });
  focusRef.current = { active, occluded, onFocus };
  const url = file.browser.url;
  const hostRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const openingRef = useRef<Promise<void> | null>(null);
  const shownRef = useRef(false);
  const boundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const watchdogRef = useRef<number | null>(null);
  const watchdogGeneration = useRef(0);
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
  const [recordingPending, setRecordingPending] = useState(false);
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
  const [menuOpen, setMenuOpen] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findTimerRef = useRef<number | null>(null);
  /** Latest find query for the page-event subscription. */
  const findQueryRef = useRef("");
  /** Storage mode the live webview was created with. */
  const persistRef = useRef(persist);

  useEffect(() => {
    operationsEpoch.current++;
    recordingDesired.current = false;
    recordingRef.current = false;
    recordingQueue.current = Promise.resolve();
    findQueue.current = Promise.resolve();
    geometryQueue.current = Promise.resolve();
    setRecording(false); setRecordingPending(false); setRecordStart(null); setRecordedOnce(false);
    setFindOpen(false); setFindQuery(""); setFindResult(null); findQueryRef.current = "";
    setOpened(false);
    return () => { operationsEpoch.current++; };
  }, [label]);

  const favorites = useSyncExternalStore(
    subscribeBrowserFavorites,
    browserFavorites,
  );
  const favorited = !!current && favorites.some((fav) => fav.url === current);

  const clearWatchdog = useCallback(() => {
    watchdogGeneration.current++;
    if (watchdogRef.current != null) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  /** One message row, newest status wins: a fresh notice replaces a
   * blocked popup/download banner, and a new banner replaces the notice. */
  const showNotice = useCallback((message: string) => {
    setPopup(null);
    setDownload(null);
    setNotice(message);
  }, []);

  const noticeError = useCallback(
    (error: unknown) =>
      showNotice(error instanceof Error ? error.message : String(error)),
    [showNotice],
  );

  /**
   * WKWebView keeps a refused connection visually blank and emits no event —
   * probe the live location after a delay to tell that apart from a slow
   * load. `about:blank` means the navigation never committed.
   */
  const armWatchdog = useCallback(
    (target: string, attempt = 1) => {
      const generation = ++watchdogGeneration.current;
      if (watchdogRef.current != null) window.clearTimeout(watchdogRef.current);
      watchdogRef.current = window.setTimeout(
        () => {
          watchdogRef.current = null;
          void (async () => {
            const probe = await browserProbe(label).catch(() => null);
            if (generation !== watchdogGeneration.current) return;
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
                showNotice("Still loading…");
                return;
              }
              armWatchdog(target, attempt + 1);
              return;
            }
            // The page never committed — whatever is still shown wins.
            currentRef.current = probe.href;
            setCurrent(probe.href);
            setDraft(probe.href);
            if (openedRef.current) {
              setStatus("ready");
              showNotice(`Couldn't load ${target}`);
            } else {
              setStatus("failed");
              setFailure(`Couldn't load ${target}`);
            }
          })();
        },
        attempt === 1 ? WATCHDOG_FIRST_MS : WATCHDOG_RETRY_MS,
      );
    },
    [label, showNotice],
  );

  const changeRecording = useCallback((on: boolean, resume = false) => {
    const epoch = operationsEpoch.current;
    const request = ++recordingRequest.current;
    const origin = urlOrigin(currentRef.current);
    const live = () => nativeLabel.current === label && operationsEpoch.current === epoch;
    recordingDesired.current = on;
    setRecordingPending(true);
    const pending = recordingQueue.current.then(async () => {
      if (!live() || request !== recordingRequest.current) return;
      const applied = origin ? await browserSetRecording(label, on, origin, resume) : false;
      if (!live() || request !== recordingRequest.current) return;
      const next = on && applied;
      recordingDesired.current = next;
      recordingRef.current = next;
      setRecording(next);
      setRecordStart(previous => next ? (resume ? previous ?? Date.now() : Date.now()) : null);
      if (!resume) setElapsed(0);
      if (next) setRecordedOnce(true);
      if (on && !applied) showNotice("Can't record steps on this page");
    }).catch(error => {
      if (!live() || request !== recordingRequest.current) return;
      // An eval timeout does not prove the page-side write failed. Keep a
      // visible stop control until a subsequent stop/reload confirms it.
      recordingDesired.current = true;
      recordingRef.current = true;
      setRecording(true);
      showNotice(`Cannot confirm recording state. Stop recording or reload the page. ${String(error)}`);
    }).finally(() => {
      if (live() && request === recordingRequest.current) setRecordingPending(false);
    });
    recordingQueue.current = pending;
    return pending;
  }, [label, showNotice]);

  const stopRecording = useCallback((message?: string) => {
    if (message) showNotice(message);
    changeRecording(false);
  }, [changeRecording, showNotice]);

  const toggleRecording = useCallback(() => {
    changeRecording(!recordingDesired.current);
  }, [changeRecording]);

  const reloadPage = useCallback(() => {
    setStatus("loading");
    if (currentRef.current) armWatchdog(currentRef.current);
    void browserReload(label).catch(() => undefined);
  }, [label, armWatchdog]);

  const runFind = useCallback((query: string, forward = true) => {
    const epoch = operationsEpoch.current;
    const request = ++findRequest.current;
    const live = () => nativeLabel.current === label && operationsEpoch.current === epoch;
    const pending = findQueue.current.then(async () => {
      if (!live() || query !== findQueryRef.current) return;
      const result = await browserFind(label, query, forward);
      if (live() && request === findRequest.current && query === findQueryRef.current)
        setFindResult(query ? result : null);
    }).catch(() => {
      if (live() && request === findRequest.current) setFindResult(null);
    });
    findQueue.current = pending;
  }, [label]);

  /** Opens the find bar (or refocuses it) — no-op on a URL-less tab. */
  const openFind = useCallback(() => {
    if (!currentRef.current) return;
    setFindOpen(true);
    findInputRef.current?.focus();
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindResult(null);
    setFindQuery("");
    findQueryRef.current = "";
    if (findTimerRef.current != null)
      window.clearTimeout(findTimerRef.current);
    findTimerRef.current = null;
    // Empty query clears page-side highlights and match state.
    runFind("");
  }, [runFind]);

  const clearSiteData = useCallback(() => {
    void (async () => {
      const epoch = operationsEpoch.current;
      const live = () => nativeLabel.current === label && operationsEpoch.current === epoch;
      const ok = await ask(
        "Clear cookies and site data for every site in this browser profile? You'll be signed out everywhere.",
        { title: "MonoCode", kind: "warning", okLabel: "Clear data" },
      ).catch(() => false);
      if (!ok || !live()) return;
      try {
        await browserClearData(label);
        if (!live()) return;
        showNotice("Site data cleared");
        reloadPage();
      } catch (error) {
        if (live()) noticeError(error);
      }
    })();
  }, [label, reloadPage, showNotice, noticeError]);

  const onMenuPick = useCallback(
    (id: string) => {
      switch (id) {
        case "find":
          openFind();
          break;
        case "copy-url":
          void writeClipboardText(currentRef.current)
            .then(() => showNotice("URL copied"))
            .catch(noticeError);
          break;
        case "copy-shot":
          void browserCopyScreenshot(label)
            .then(() => showNotice("Screenshot copied"))
            .catch(noticeError);
          break;
        case "devtools":
          void browserDevtools(label).catch(noticeError);
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
    [label, persist, clearSiteData, openFind, showNotice, noticeError],
  );

  // Menu accelerators and the App key handler route browser commands here
  // — they fire even while the native webview holds DOM-unreachable focus.
  useEffect(() => {
    const onCommand = (event: Event) => {
      if (!isBrowserCommandRequest(event) || event.detail.label !== `browser-${file.id}`)
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
          openFind();
          break;
        case "devtools":
          void browserDevtools(label).catch(() => undefined);
          break;
      }
    };
    window.addEventListener(BROWSER_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(BROWSER_COMMAND_EVENT, onCommand);
  }, [file.id, label, reloadPage, openFind]);

  // The recording chip's elapsed timer — only ticks while a session runs.
  useEffect(() => {
    if (!recording || recordStart == null || !active || occluded || !documentVisible) return;
    const tick = () => setElapsed(Date.now() - recordStart);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [recording, recordStart, active, occluded, documentVisible]);

  // Page events → tab state. `navigate` fires for every committed
  // navigation (initial load, user clicks, redirects, history moves).
  useEffect(() => {
    let readyPending = false;
    let readyAgain = false;
    let disposed = false;
    let nextReadyAt = 0;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const acknowledgeReady = () => {
      readyAgain = true;
      if (readyPending || disposed) return;
      readyPending = true;
      readyTimer = setTimeout(async () => {
        readyTimer = undefined;
        nextReadyAt = Date.now() + 1000;
        readyAgain = false;
        if (recordingDesired.current) await changeRecording(true, recordingRef.current);
        readyPending = false;
        if (readyAgain && recordingDesired.current && !disposed) acknowledgeReady();
      }, Math.max(50, nextReadyAt - Date.now()));
    };
    const unsubscribe = subscribeBrowser(label, (event) => {
      switch (event.kind) {
        case "focus":
          if (focusRef.current.active && !focusRef.current.occluded && wantShowRef.current) focusRef.current.onFocus?.();
          break;
        case "navigate": {
          const next = event.url ?? "";
          const prev = currentRef.current;
          // The session flag can't cross origins — make the end visible
          // instead of leaving a dead indicator running.
          const movedOrigin = urlOrigin(prev) !== urlOrigin(next);
          const stopped = movedOrigin && (recordingDesired.current || recordingRef.current);
          if (movedOrigin) setRecordedOnce(false);
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
        case "recording-ready":
          // A new document/BFCache restore can accept the origin-checked
          // owner acknowledgement before slow resources finish loading.
          // The page can forge this notice: keep at most one scheduled or
          // in-flight acknowledgement, and let an explicit Stop supersede it.
          if (recordingDesired.current) acknowledgeReady();
          break;
        case "load-finished": {
          clearWatchdog();
          setStatus("ready");
          // A navigation replaces the document — re-run an open find.
          if (findQueryRef.current) runFind(findQueryRef.current);
          if (recordingDesired.current) {
            if (/^https?:/.test(event.url ?? "")) {
              changeRecording(true, recordingRef.current);
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
          showNotice(event.reason ?? "That link isn't allowed in Browser");
          break;
        case "popup":
          if (event.url) {
            setNotice(null);
            setDownload(null);
            setPopup(event.url);
          }
          break;
        case "download":
          // Denied by design — offer the system browser as the way out.
          if (event.url && isHttpUrl(event.url)) {
            setNotice(null);
            setPopup(null);
            setDownload(event.url);
          } else {
            showNotice(
              event.reason ?? "Downloads are not allowed in Browser",
            );
          }
          break;
      }
    });
    return () => { disposed = true; clearTimeout(readyTimer); unsubscribe(); };
  }, [label, armWatchdog, clearWatchdog, stopRecording, changeRecording, runFind, showNotice]);

  // A delayed hide must finish before a later show/bounds restoration.
  const queueGeometry = useCallback((update: () => Promise<void>) => {
    const epoch = operationsEpoch.current;
    const live = () => nativeLabel.current === label && operationsEpoch.current === epoch;
    geometryQueue.current = geometryQueue.current.then(async () => {
      if (live()) await update();
    }).catch(() => {
      if (live()) { shownRef.current = false; boundsRef.current = null; }
    });
  }, [label]);

  const wantShowRef = useRef(false);
  const bgRef = useRef<Rgba | undefined>(undefined);
  const syncBounds = useCallback(() => {
    const el = hostRef.current;
    if (!el || !openedRef.current) return;
    if (!wantShowRef.current) {
      if (shownRef.current) {
        shownRef.current = false;
        queueGeometry(() => browserSetVisible(label, false));
      }
      return;
    }
    const rect = el.getBoundingClientRect();
    // An overlay view (search/settings/inbox) or an inactive workspace tab
    // hides the host: a zero rect, or an ancestor marked hidden/inert. The
    // native webview sits above the DOM, so it must be hidden explicitly.
    const covered =
      !rect.width ||
      !rect.height ||
      !!el.closest("[aria-hidden='true'], [inert], .hidden");
    if (covered) {
      if (shownRef.current) {
        shownRef.current = false;
        queueGeometry(() => browserSetVisible(label, false));
      }
      return;
    }
    if (!shownRef.current) {
      shownRef.current = true;
      // The "hidden" view was parked offscreen, so the real bounds must be
      // re-sent even when they match the last visible frame.
      boundsRef.current = null;
      queueGeometry(() => browserSetVisible(label, true));
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
    queueGeometry(() => browserSetBounds(label, next));
  }, [label, queueGeometry]);

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
            // Await the orphan close — a stale run must not drop a webview
            // a fresh run is about to open under the same label.
            await browserClose(label).catch(() => undefined);
            return;
          }
          persistRef.current = persist;
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
    if (!opened || !active || occluded || !documentVisible) return;
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
  }, [opened, active, occluded, documentVisible]);

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
    if (!opened || !active || occluded || overlayOpen || !documentVisible) return;
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
  }, [syncBounds, opened, active, occluded, overlayOpen, documentVisible]);

  const expanded = !!file.browser.expanded;
  const wantShow =
    opened && active && documentVisible && !overlayOpen && status !== "failed" && !occluded;
  wantShowRef.current = wantShow;
  useEffect(() => {
    if (!opened) return;
    if (!wantShow) {
      if (shownRef.current) {
        shownRef.current = false;
        queueGeometry(() => browserSetVisible(label, false));
      }
      return;
    }
    syncBounds();
  }, [wantShow, opened, label, syncBounds, queueGeometry]);

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
      setDownload(null);
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
        noticeError(error);
      });
    },
    [label, armWatchdog, clearWatchdog, noticeError],
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
      const owner = ++captureOwner.current;
      const captureCwd = cwdRef.current;
      void (async () => {
        try {
          // Explicit capture flushes any pending document continuation even
          // during the page-notification cooldown. It cannot start recording.
          if (includeSteps && recordingDesired.current) {
            await changeRecording(true, true);
            if (owner !== captureOwner.current) return;
          }
          const capture = await browserCapture(label);
          if (owner !== captureOwner.current) return;
          if (includeSteps && !capture.steps.length) {
            showNotice("No steps recorded — press the record button first");
            return;
          }
          const context = browserAgentContext(
            capture,
            captureCwd,
            includeSteps,
          );
          setCaptureContext(context);
          if (capture.detail) showNotice(capture.detail);
        } catch (error) {
          if (owner === captureOwner.current) noticeError(error);
        } finally {
          if (owner === captureOwner.current) setCapturing(false);
        }
      })();
    },
    [capturing, label, showNotice, noticeError, changeRecording],
  );

  const wsl = wslLocation(file.cwd);
  const showChrome = !!url;
  // The overflow menu is a native popup: a DOM menu would paint under the
  // native webview and force the overlay watcher to blank the page while
  // it's open — the native menu floats above it instead.
  const openMenu = useCallback(
    (anchor: { left: number; bottom: number }) => {
      void (async () => {
        const spec: (
          | { sep: true }
          | { id: string; text: string; enabled?: boolean; checked?: boolean; accel?: string }
        )[] = [
          { id: "find", text: "Find in Page", accel: "CmdOrCtrl+F", enabled: opened },
          { id: "copy-url", text: "Copy URL", enabled: !!current },
          { id: "copy-shot", text: "Copy Screenshot", enabled: opened },
          { sep: true },
          {
            id: "devtools",
            text: "Developer Tools",
            accel: "CmdOrCtrl+Alt+I",
            enabled: opened,
          },
          // Forget site data when this tab closes — the page reloads.
          { id: "private", text: "Private Tab", checked: !persist },
          { sep: true },
          {
            id: "clear-data",
            text: "Clear Saved Site Data…",
            enabled: persist,
          },
        ];
        const items = await Promise.all(
          spec.map((entry) => {
            if ("sep" in entry)
              return PredefinedMenuItem.new({ item: "Separator" });
            const base = {
              id: `browser-${entry.id}`,
              text: entry.text,
              enabled: entry.enabled !== false,
              accelerator: entry.accel,
              action: () => onMenuPick(entry.id),
            };
            return entry.checked === undefined
              ? MenuItem.new(base)
              : CheckMenuItem.new({ ...base, checked: entry.checked });
          }),
        );
        const menu = await Menu.new({ items });
        setMenuOpen(true);
        try {
          await menu.popup(
            new LogicalPosition(anchor.left, anchor.bottom + 4),
          );
        } finally {
          setMenuOpen(false);
        }
      })().catch(noticeError);
    },
    [opened, current, persist, onMenuPick, noticeError],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {captureContext ? <BrowserContextPicker context={captureContext} sessions={sessions} onClose={() => setCaptureContext(null)} /> : null}
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
              title={`Repository: ${file.cwd}. Browser runs on the native host.`}
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
            title={recordingPending && recordingDesired.current ? "Cancel recording start" : recording ? "Stop recording steps" : "Record steps to reproduce"}
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
            onClick={() => void openUrl(current).catch(noticeError)}
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
            title="More actions"
            pressed={menuOpen}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) =>
              openMenu(event.currentTarget.getBoundingClientRect())
            }
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
          ref={findInputRef}
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

    </div>
  );
}

function ToolbarButton({
  title,
  pressed,
  children,
  ...rest
}: Omit<
  ComponentPropsWithoutRef<"button">,
  "className" | "type" | "title"
> & {
  title: string;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      className="grid size-6 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/10 hover:text-content disabled:cursor-not-allowed disabled:opacity-35"
      {...rest}
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
  ref,
  query,
  result,
  onQuery,
  onStep,
  onClose,
}: {
  ref?: Ref<HTMLInputElement>;
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
        ref={ref}
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
