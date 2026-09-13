import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pathKey } from "./paths";

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
  url: string;
  cwd?: string;
};

export function requestBrowserOpen(url: string, cwd?: string) {
  window.dispatchEvent(
    new CustomEvent<BrowserOpenRequest>(OPEN_BROWSER_EVENT, {
      detail: { url, cwd },
    }),
  );
}

export function isBrowserOpenRequest(
  event: Event,
): event is CustomEvent<BrowserOpenRequest> {
  if (!(event instanceof CustomEvent)) return false;
  const detail = event.detail as Partial<BrowserOpenRequest> | null;
  return !!detail && typeof detail.url === "string";
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
    all[key] = { url, at: Date.now() };
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
): Promise<void> {
  return invoke("browser_open", { label, url, bounds });
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

// --- Event fan-in, one subscription for the whole window ---

type BrowserHandler = (payload: BrowserEventPayload) => void;

const handlers = new Map<string, Set<BrowserHandler>>();
let subscription: Promise<() => void> | null = null;

function ensureSubscription() {
  subscription ??= listen<BrowserEventPayload>(BROWSER_EVENT_NAME, (event) => {
    const payload = event.payload;
    if (payload.window !== getCurrentWindow().label) return;
    for (const handler of handlers.get(payload.label) ?? []) {
      handler(payload);
    }
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
