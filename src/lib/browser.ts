import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pathKey, wslLocation } from "./paths";
import { boundAgentContext, type AgentContext } from "./agentContext";
import type { Attachment } from "./session";

/**
 * Untrusted page preview. The native webview lives in the window next to
 * the tab; this module owns the invoke surface, the event fan-in, URL
 * normalization and the per-worktree remembered URL. Everything page-side
 * is untrusted — no script bridges, and the Rust host bounds navigation.
 */

export const OPEN_BROWSER_EVENT = "monocode:open-browser";
export const LINK_CHOICE_EVENT = "monocode:link-choice";

const BROWSER_EVENT_NAME = "monocode:browser";
const MAX_URL_LENGTH = 8192;
const REMEMBERED_KEY = "monocode.browserUrls";
const REMEMBERED_LIMIT = 50;

export type BrowserEventKind =
  | "navigate"
  | "load-started"
  | "load-finished"
  | "title"
  | "blocked"
  | "popup"
  | "download";

export type BrowserEventPayload = {
  label: string;
  window: string;
  kind: BrowserEventKind;
  url?: string;
  title?: string;
  reason?: string;
  canBack: boolean;
  canForward: boolean;
};

export type BrowserOpenRequest = {
  /** Omitted = open the worktree's remembered URL; "" = blank new tab. */
  url?: string;
  cwd?: string;
  /** Pane the new tab should land in (a `+` in that pane's tab row). */
  paneId?: string;
};

export function requestBrowserOpen(url?: string, cwd?: string, paneId?: string) {
  window.dispatchEvent(
    new CustomEvent<BrowserOpenRequest>(OPEN_BROWSER_EVENT, {
      detail: { url, cwd, paneId },
    }),
  );
}

export function isBrowserOpenRequest(
  event: Event,
): event is CustomEvent<BrowserOpenRequest> {
  if (!(event instanceof CustomEvent)) return false;
  const detail = event.detail as Partial<BrowserOpenRequest> | null;
  return !!detail && (detail.url === undefined || typeof detail.url === "string");
}

export type LinkChoiceRequest = {
  url: string;
  x: number;
  y: number;
  cwd?: string;
};

/** A localhost link was deliberately activated — ask where it should open. */
export function requestLinkChoice(request: LinkChoiceRequest) {
  window.dispatchEvent(
    new CustomEvent<LinkChoiceRequest>(LINK_CHOICE_EVENT, {
      detail: request,
    }),
  );
}

export function isLinkChoiceRequest(
  event: Event,
): event is CustomEvent<LinkChoiceRequest> {
  if (!(event instanceof CustomEvent)) return false;
  const detail = event.detail as Partial<LinkChoiceRequest> | null;
  return (
    !!detail &&
    typeof detail.url === "string" &&
    typeof detail.x === "number" &&
    typeof detail.y === "number"
  );
}

/** Normalize user/agent output into a navigable http(s) URL, or throw. */
export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a URL");
  if (trimmed.length > MAX_URL_LENGTH) throw new Error("URL is too long");
  // `host:port` reads like a scheme to the regex — a colon followed by
  // digits is a port, not a scheme.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Enter a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${parsed.protocol.replace(/:$/, "")}: links aren't allowed in Browser`);
  }
  return parsed.toString();
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** First http(s) URL in copied text — handles whole-line copies like
 * `➜ Local: http://localhost:5173/`. Returns "" when nothing valid. */
export function browserClipboardUrl(text: string): string {
  const match = /https?:\/\/[^\s"'<>`]+/i.exec(text.slice(0, 65536));
  if (!match) return "";
  const candidate = match[0].replace(/[.,;:'")[\]]+$/, "");
  try {
    return normalizeBrowserUrl(candidate);
  } catch {
    return "";
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Loopback targets get the Open-in-Browser chooser; remote links stay external. */
export function isLocalhostUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  if (host === "0.0.0.0") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

/** Short label for tabs and toolbar text — host (+port), never credentials. */
export function browserTabLabel(url: string, title?: string): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed.slice(0, 80);
  try {
    const parsed = new URL(url);
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.hostname}${port}` || parsed.toString().slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

type RememberedUrls = Record<string, { url: string; at: number }>;

function readRemembered(): RememberedUrls {
  try {
    const raw = localStorage.getItem(REMEMBERED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as RememberedUrls;
  } catch {
    return {};
  }
}

/** Last URL a browser tab in this worktree navigated to. */
export function rememberedBrowserUrl(cwd: string): string | undefined {
  const entry = readRemembered()[pathKey(cwd)];
  return entry && isHttpUrl(entry.url) ? entry.url : undefined;
}

export function rememberBrowserUrl(cwd: string, url: string) {
  if (!isHttpUrl(url)) return;
  try {
    const all = readRemembered();
    const key = pathKey(cwd);
    delete all[key];
    all[key] = { url: sanitizeCaptureUrl(url), at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > REMEMBERED_LIMIT) {
      keys
        .sort((a, b) => all[a].at - all[b].at)
        .slice(0, keys.length - REMEMBERED_LIMIT)
        .forEach((old) => delete all[old]);
    }
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(all));
  } catch {
    // private mode / quota
  }
}

// --- Bookmarks: a small global list, editable from the toolbar ---

export type BrowserFavorite = {
  id: string;
  url: string;
  title: string;
};

const FAVORITES_KEY = "monocode.browserFavorites";
const FAVORITES_LIMIT = 100;
const FAVORITES_EVENT = "monocode:browser-favorites";
/** Raw-string memo so useSyncExternalStore sees a stable snapshot between
 * writes while still noticing edits from other windows. */
let favoritesCache: { raw: string | null; list: BrowserFavorite[] } | null =
  null;

export function browserFavorites(): BrowserFavorite[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(FAVORITES_KEY);
  } catch {
    // private mode
  }
  if (favoritesCache && favoritesCache.raw === raw) return favoritesCache.list;
  const list = (() => {
    try {
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (entry): entry is BrowserFavorite =>
            !!entry &&
            typeof entry === "object" &&
            typeof (entry as BrowserFavorite).id === "string" &&
            typeof (entry as BrowserFavorite).url === "string" &&
            isHttpUrl((entry as BrowserFavorite).url),
        )
        .slice(0, FAVORITES_LIMIT)
        .map((entry) => ({
          id: entry.id,
          url: entry.url,
          title: typeof entry.title === "string" ? entry.title : "",
        }));
    } catch {
      return [];
    }
  })();
  favoritesCache = { raw, list };
  return list;
}

function writeFavorites(list: BrowserFavorite[]) {
  try {
    localStorage.setItem(
      FAVORITES_KEY,
      JSON.stringify(list.slice(0, FAVORITES_LIMIT)),
    );
  } catch {
    // private mode / quota
  }
  window.dispatchEvent(new Event(FAVORITES_EVENT));
}

/** Subscribe to bookmark edits; returns unsubscribe. */
export function subscribeBrowserFavorites(onChange: () => void): () => void {
  const handler = (event: Event) => {
    if (
      event instanceof StorageEvent &&
      event.key != null &&
      event.key !== FAVORITES_KEY
    )
      return;
    onChange();
  };
  window.addEventListener(FAVORITES_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(FAVORITES_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

export function isBrowserFavorite(url: string): boolean {
  return browserFavorites().some((entry) => entry.url === url);
}

/** Bookmark or unbookmark a page; returns whether it is now bookmarked. */
export function toggleBrowserFavorite(url: string, title = ""): boolean {
  const list = browserFavorites();
  const existing = list.find((entry) => entry.url === url);
  if (existing) {
    writeFavorites(list.filter((entry) => entry.id !== existing.id));
    return false;
  }
  writeFavorites([
    { id: crypto.randomUUID(), url, title: title.slice(0, 200) },
    ...list,
  ]);
  return true;
}

export function updateBrowserFavorite(
  id: string,
  patch: { title?: string; url?: string },
) {
  const list = browserFavorites();
  const next = list.map((entry) => {
    if (entry.id !== id) return entry;
    let url = entry.url;
    if (patch.url !== undefined) {
      try {
        url = normalizeBrowserUrl(patch.url);
      } catch {
        url = entry.url;
      }
    }
    const title =
      patch.title !== undefined ? patch.title.trim().slice(0, 200) : entry.title;
    return { ...entry, url, title };
  });
  // An edited URL may now collide with another entry — keep the edited one.
  const editedUrl = next.find((entry) => entry.id === id)?.url;
  writeFavorites(
    next.filter((entry) => entry.id === id || entry.url !== editedUrl),
  );
}

export function removeBrowserFavorite(id: string) {
  writeFavorites(browserFavorites().filter((entry) => entry.id !== id));
}

// --- Native webview commands ---

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function browserOpen(
  label: string,
  url: string,
  bounds: BrowserBounds,
  background?: [number, number, number, number],
): Promise<void> {
  return invoke("browser_open", { label, url, bounds, background });
}

export function browserClose(label: string): Promise<void> {
  return invoke("browser_close", { label });
}

export function browserNavigate(label: string, url: string): Promise<void> {
  return invoke("browser_navigate", { label, url });
}

export function browserReload(label: string): Promise<void> {
  return invoke("browser_reload", { label });
}

export function browserGoBack(label: string): Promise<void> {
  return invoke("browser_go_back", { label });
}

export function browserGoForward(label: string): Promise<void> {
  return invoke("browser_go_forward", { label });
}

export function browserSetBounds(
  label: string,
  bounds: BrowserBounds,
): Promise<void> {
  return invoke("browser_set_bounds", { label, bounds });
}

export function browserSetVisible(
  label: string,
  visible: boolean,
): Promise<void> {
  return invoke("browser_set_visible", { label, visible });
}

/** Swap-flash color — the pane's painted background, so navigation
 * doesn't strobe white on a dark theme. */
export function browserSetBackground(
  label: string,
  color: [number, number, number, number],
): Promise<void> {
  return invoke("browser_set_background", { label, color });
}

export type BrowserProbe = {
  href: string;
  title: string;
  readyState: string;
};

/** Live location of the page — the only way to spot a never-started load. */
export async function browserProbe(label: string): Promise<BrowserProbe | null> {
  const raw = await invoke<string>("browser_probe", { label });
  try {
    const parsed = JSON.parse(raw) as Partial<BrowserProbe>;
    return {
      href: typeof parsed.href === "string" ? parsed.href : "",
      title: typeof parsed.title === "string" ? parsed.title : "",
      readyState: typeof parsed.readyState === "string" ? parsed.readyState : "",
    };
  } catch {
    return null;
  }
}

// --- Capture for agent context (#43) ---

export type BrowserConsoleLine = { level: string; text: string };

export type BrowserCapture = {
  url: string;
  title?: string;
  /** Bounded visible text of the page. */
  text?: string;
  /** Bounded list of visible interactive elements. */
  controls: string[];
  /** Bounded console ring buffer for the page. */
  console: BrowserConsoleLine[];
  /** Base64 PNG screenshot when the platform supports it. */
  screenshot?: string;
  detail?: string;
};

export function browserCapture(label: string): Promise<BrowserCapture> {
  return invoke("browser_capture", { label });
}

function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Never hand an agent a URL with credentials embedded. */
export function sanitizeCaptureUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Build a sendable AgentContext from a capture. Provenance — page URL,
 * worktree, execution host — goes in `origin` so it survives the compose
 * step; the page-derived content is data and is marked untrusted by
 * composeAgentContext already.
 */
export function browserAgentContext(
  capture: BrowserCapture,
  cwd: string,
): AgentContext {
  const url = sanitizeCaptureUrl(capture.url);
  const wsl = wslLocation(cwd);
  const origin = [
    url || null,
    cwd,
    wsl ? `WSL ${wsl.distribution}` : "native host",
    `captured ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const sections: string[] = [];
  if (capture.text?.trim()) {
    sections.push(`### Visible text\n\n${capture.text.trim()}`);
  }
  if (capture.controls.length) {
    sections.push(
      `### Interactive elements\n\n${capture.controls.map((line) => `- ${line}`).join("\n")}`,
    );
  }
  if (capture.console.length) {
    sections.push(
      `### Console\n\n${capture.console
        .map((line) => `- [${line.level}] ${line.text}`)
        .join("\n")}`,
    );
  }
  if (!sections.length) {
    sections.push("The page reported no visible text or console output.");
  }
  const attachments: Attachment[] = [];
  if (capture.screenshot) {
    attachments.push({
      id: crypto.randomUUID(),
      name: `browser-${Date.now()}.png`,
      mimeType: "image/png",
      kind: "image",
      size: base64Bytes(capture.screenshot),
      data: capture.screenshot,
    });
  }
  const label = capture.title?.trim() || browserTabLabel(url);
  return boundAgentContext({
    id: crypto.randomUUID(),
    entries: [
      {
        id: crypto.randomUUID(),
        title: label ? `Browser: ${label}` : "Browser",
        origin,
        text: sections.join("\n\n"),
      },
    ],
    attachments,
  });
}

// --- Event fan-in, one subscription for the whole window ---

type BrowserHandler = (payload: BrowserEventPayload) => void;

const handlers = new Map<string, Set<BrowserHandler>>();
let subscription: Promise<() => void> | null = null;

function ensureSubscription() {
  if (subscription) return;
  const pending = listen<BrowserEventPayload>(BROWSER_EVENT_NAME, (event) => {
    const payload = event.payload;
    if (payload.window !== getCurrentWindow().label) return;
    for (const handler of handlers.get(payload.label) ?? []) {
      handler(payload);
    }
  });
  subscription = pending;
  // A rejected listen() must not poison the window's stream forever.
  pending.catch(() => {
    if (subscription === pending) subscription = null;
  });
}

/** Subscribe one browser tab to its navigation stream; returns unsubscribe. */
export function subscribeBrowser(
  label: string,
  handler: BrowserHandler,
): () => void {
  ensureSubscription();
  let set = handlers.get(label);
  if (!set) {
    set = new Set();
    handlers.set(label, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) {
      handlers.delete(label);
      if (handlers.size === 0) {
        void subscription?.then((unlisten) => unlisten());
        subscription = null;
      }
    }
  };
}
