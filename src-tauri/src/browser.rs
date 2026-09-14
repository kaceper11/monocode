//! Untrusted page preview hosted in a native child webview per browser tab.
//!
//! Security boundary: the page is remote content — Tauri already rejects
//! every invoke from a non-local origin, and `on_navigation` additionally
//! refuses the app's own origin so a page can never become "local". Only
//! http(s) is allowed; popups, downloads and external protocols are denied
//! explicitly and surfaced to the tab as events.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    utils::config::Color,
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Runtime, Url, WebviewUrl,
    Window,
};

use crate::browser_logins;

pub const EVENT: &str = "monocode:browser";
const MAX_HISTORY: usize = 64;
const MAX_URL_LEN: usize = 8192;
const MAX_LABEL_LEN: usize = 120;
const MAX_TITLE_LEN: usize = 200;
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// Hosts where Tauri serves local content: navigating there would make the
/// page "local" and hand it invoke authority.
const LOCAL_HOSTS: [&str; 2] = ["tauri.localhost", "asset.localhost"];
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
/// Rust-side bounds on untrusted page output — the page decides what the
/// eval returns, so sizes are enforced here, not only in the script.
const MAX_CAPTURE_TEXT: usize = 6_000;
const MAX_CAPTURE_CONTROLS: usize = 40;
const MAX_CAPTURE_CONTROL_LEN: usize = 120;
const MAX_CAPTURE_CONSOLE: usize = 40;
const MAX_CAPTURE_CONSOLE_LEN: usize = 400;
const MAX_CAPTURE_STEPS: usize = 60;
const MAX_STEP_TEXT: usize = 240;
const MAX_HEADINGS: usize = 12;
const MAX_HEADING_LEN: usize = 120;
const MAX_FOCUSED_LEN: usize = 160;
const MAX_SELECTION_LEN: usize = 400;
/// A full-pane PNG base64'd over IPC and into agent context — cap it.
const MAX_SCREENSHOT_BYTES: usize = 4 * 1024 * 1024;

/// Page-local console ring buffer plus an opt-in interaction trail.
/// Injected before any page script runs; it writes into the page's own
/// context only — nothing calls back into the app, so the security
/// boundary is unchanged. The trail is gated by `__monocodeRec` (toggled
/// via `browser_set_recording`) and both flag and trail persist in
/// sessionStorage, so same-origin navigations keep recording while a
/// different origin can neither read the steps nor keep the session.
const PAGE_TAP_SCRIPT: &str = r#"(() => {
  // wry injects init scripts into subframes on Windows; the trail lives in
  // sessionStorage, which same-origin iframes share — restrict everything
  // to the top frame so embeds can't clobber or pollute it.
  if (window.top !== window) return;
  const cap = 100;
  const buf = [];
  const clip = (v) => {
    try {
      return (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 300);
    } catch (e) {
      return String(v).slice(0, 300);
    }
  };
  const push = (level, args) => {
    try {
      buf.push({
        level,
        text: Array.from(args).map(clip).join(" ").slice(0, 400),
      });
      if (buf.length > cap) buf.splice(0, buf.length - cap);
    } catch (e) {}
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    if (typeof original !== "function") continue;
    console[level] = function () {
      push(level, arguments);
      return original.apply(this, arguments);
    };
  }
  window.addEventListener("error", (e) => push("error", [e.message || "error"]));
  window.addEventListener("unhandledrejection", (e) =>
    push("error", [
      "unhandled rejection: " +
        (e.reason && e.reason.message ? e.reason.message : e.reason),
    ]),
  );
  window.__monocodeConsole = buf;

  // --- Interaction trail ("repro steps"). Recorded only while the user
  // pressed record (`__monocodeRec`) — a session's worth of what they did,
  // so a send can describe it without a write-up. Sensitive fields record
  // the fact of an edit, never the value; URL parameters that look like
  // credentials are redacted before they are stored.
  const TRAIL_KEY = "monocode.trail";
  const REC_KEY = "monocode.rec";
  const TRAIL_CAP = 80;
  const SECRET_KEY =
    /token|secret|password|passwd|pwd|apikey|api_key|key|auth|session|code|sig|credential|jwt|saml|assertion|bearer|nonce/i;
  const redactParams = (s) =>
    (s || "").replace(/([?&#])([^=&#]+)=([^&#]*)/g, (m, sep, k) =>
      SECRET_KEY.test(k) ? sep + k + "=…" : m,
    );
  // A JWT is base64url'd `{"…` → always starts "eyJ". It can appear as a
  // bare path/hash segment (#/callback/<jwt>) where param redaction can't
  // reach, or nested inside a non-secret-looking param value.
  const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]*/g;
  const cleanUrl = (raw) => {
    try {
      const u = new URL(raw);
      u.username = "";
      u.password = "";
      return (
        u.origin + u.pathname + redactParams(u.search) + redactParams(u.hash)
      ).replace(JWT, "…");
    } catch (e) {
      return String(raw).slice(0, 300);
    }
  };
  const label = (el) => {
    try {
      if (!el || el.nodeType !== 1) return "";
      const tag = (el.tagName || "").toLowerCase();
      const type = ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
      let text =
        el.getAttribute("aria-label") ||
        (tag === "input" && (type === "button" || type === "submit")
          ? el.value
          : "") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        el.getAttribute("title") ||
        (tag === "input" || tag === "textarea" || el.isContentEditable
          ? ""
          : el.innerText || "") ||
        el.id ||
        "";
      text = String(text).trim().replace(/\s+/g, " ").slice(0, 80);
      const name =
        tag === "input" && type && type !== "text" ? "input[" + type + "]" : tag;
      return text ? name + ' "' + text + '"' : name;
    } catch (e) {
      return "element";
    }
  };
  const sensitive = (el) => {
    try {
      if ((el.type || "").toLowerCase() === "password") return true;
      const hint = [
        el.name,
        el.id,
        el.autocomplete,
        el.getAttribute("aria-label"),
      ].join(" ");
      return /pass|secret|token|cvv|card|cc-|ssn|cred|otp|pin|2fa|mfa|verif|one.?time|code|auth/i.test(
        hint,
      );
    } catch (e) {
      return true;
    }
  };
  let trail = [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(TRAIL_KEY) || "[]");
    if (Array.isArray(saved)) {
      trail = saved.filter(
        (e) =>
          e &&
          typeof e.text === "string" &&
          typeof e.at === "number" &&
          isFinite(e.at),
      );
    }
  } catch (e) {}
  const saveTrail = () => {
    try {
      sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail.slice(-TRAIL_CAP)));
    } catch (e) {}
  };
  try {
    window.__monocodeRec = sessionStorage.getItem(REC_KEY) === "1";
  } catch (e) {
    window.__monocodeRec = false;
  }
  const step = (text) => {
    try {
      if (!window.__monocodeRec) return;
      trail.push({ at: Date.now(), text: String(text).slice(0, 240) });
      if (trail.length > TRAIL_CAP) trail.splice(0, trail.length - TRAIL_CAP);
      saveTrail();
    } catch (e) {}
  };
  let lastNav = cleanUrl(location.href);
  // The record toggle: a fresh session clears the previous trail and opens
  // on the current page; stopping just drops the flag — the finished trail
  // stays readable until the next session or the webview dies. Idempotent:
  // the app re-asserts the flag after loads in case the webview was
  // recreated, and that must not wipe the trail on a plain reload.
  window.__monocodeSetRec = (on) => {
    on = !!on;
    if (on === window.__monocodeRec) return;
    window.__monocodeRec = on;
    try {
      sessionStorage.setItem(REC_KEY, on ? "1" : "0");
    } catch (e) {}
    if (on) {
      trail.length = 0;
      lastNav = cleanUrl(location.href);
      step("Opened " + lastNav);
    }
  };
  window.__monocodeLabel = label;
  window.__monocodeTrail = trail;
  // Clicking a <label> forwards a synthesized click to its control — the
  // label step already says what happened, so swallow the echo.
  let forwardedClick = null;
  window.addEventListener(
    "click",
    (e) => {
      try {
        const t = e.target;
        if (!t || t.nodeType !== 1 || t.closest("select,option")) return;
        const el =
          t.closest(
            "a,button,input,textarea,summary,label,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='switch'],[contenteditable]",
          ) || t;
        if (
          forwardedClick &&
          forwardedClick.el === el &&
          Date.now() - forwardedClick.at < 500
        ) {
          forwardedClick = null;
          return;
        }
        forwardedClick = null;
        // Checkbox/radio clicks are reported by the change event instead.
        if (el.tagName === "INPUT") {
          const ty = (el.getAttribute("type") || "").toLowerCase();
          if (ty === "checkbox" || ty === "radio") return;
        }
        step("Clicked " + label(el));
        if (el.tagName === "LABEL" && el.control) {
          forwardedClick = { el: el.control, at: Date.now() };
        }
      } catch (err) {}
    },
    true,
  );
  window.addEventListener(
    "change",
    (e) => {
      try {
        const el = e.target;
        if (!el || el.nodeType !== 1) return;
        const tag = (el.tagName || "").toLowerCase();
        const type = (el.type || "").toLowerCase();
        if (tag === "select") {
          const opt = el.options && el.options[el.selectedIndex];
          const chosen = (((opt && opt.text) || el.value || "") + "").trim().slice(0, 60);
          step('Selected "' + chosen + '" in ' + label(el));
        } else if (type === "checkbox") {
          step((el.checked ? "Checked " : "Unchecked ") + label(el));
        } else if (type === "radio") {
          step("Selected " + label(el));
        } else if (tag === "input" || tag === "textarea") {
          if (sensitive(el)) {
            step("Edited " + label(el));
          } else {
            step(
              'Typed "' + String(el.value).slice(0, 80) + '" in ' + label(el),
            );
          }
        }
      } catch (err) {}
    },
    true,
  );
  window.addEventListener(
    "submit",
    (e) => step("Submitted " + label(e.target)),
    true,
  );
  // Enter is a step where it submits (inputs, chat-style contenteditable);
  // in a plain textarea it's just a newline.
  window.addEventListener(
    "keydown",
    (e) => {
      try {
        if (e.key !== "Enter") return;
        const el = e.target;
        if (!el || !el.matches || !el.matches("input,[contenteditable]"))
          return;
        step("Pressed Enter in " + label(el));
      } catch (err) {}
    },
    true,
  );
  // contenteditable never fires `change` — the blur is the edit's end.
  // Fact-of-edit only; the typed content itself is never recorded.
  window.addEventListener(
    "focusout",
    (e) => {
      try {
        const el = e.target;
        if (!el || el.nodeType !== 1 || !el.isContentEditable) return;
        step("Edited " + label(el));
      } catch (err) {}
    },
    true,
  );
  // Frameworks spam replaceState (scroll restoration, URL-synced state) —
  // record a location only when it actually changed, or repeats would
  // evict real steps from the bounded trail.
  const navigated = () => {
    try {
      const url = cleanUrl(location.href);
      if (url === lastNav) return;
      lastNav = url;
      step("Navigated to " + url);
    } catch (e) {}
  };
  window.addEventListener("popstate", navigated);
  window.addEventListener("hashchange", navigated);
  for (const fn of ["pushState", "replaceState"]) {
    const original = history[fn];
    history[fn] = function () {
      const ret = original.apply(this, arguments);
      navigated();
      return ret;
    };
  }
  // A mid-session page load belongs to the trail too.
  step("Opened " + lastNav);
})()"#;

/// Bounded visible-DOM + console read. wry serializes the completion
/// value itself, so the script returns an object; the Rust side still
/// re-bounds everything — the page is untrusted, and __monocodeConsole is
/// page-writable, so entries are normalized here before they ever reach
/// JSON.
const SUMMARY_SCRIPT: &str = r#"(() => {
  const controls = [];
  try {
    const els = document.querySelectorAll(
      "a[href],button,input,select,textarea,[role='button'],summary",
    );
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const tag = (el.tagName || "").toLowerCase();
      const type = ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
      // A free-text field's value is user input (possibly a password) —
      // it is never a label. Button/submit values and a select's chosen
      // option are fine.
      const editable =
        tag === "textarea" ||
        (tag === "input" && type !== "button" && type !== "submit");
      let label =
        (el.innerText || (editable ? "" : el.value) || el.placeholder ||
          el.getAttribute("aria-label") || el.getAttribute("title") || "")
          .trim();
      if (!label && tag === "a") label = el.getAttribute("href") || "";
      if (!label) continue;
      controls.push(`${tag}: ${label.slice(0, 120)}`);
      if (controls.length >= 40) break;
    }
  } catch (e) {}
  let text = "";
  try {
    text = (document.body && document.body.innerText) || "";
  } catch (e) {}
  let log = [];
  try {
    const raw = Array.isArray(window.__monocodeConsole)
      ? window.__monocodeConsole
      : [];
    log = raw.slice(-40).map((entry) => ({
      level: String((entry && entry.level) || "log").slice(0, 16),
      text: String((entry && entry.text) || "").slice(0, 400),
    }));
  } catch (e) {}
  let steps = [];
  try {
    const trail = Array.isArray(window.__monocodeTrail)
      ? window.__monocodeTrail
      : [];
    steps = trail.slice(-60).map((entry) => ({
      at:
        entry && typeof entry.at === "number" && isFinite(entry.at)
          ? entry.at
          : 0,
      text: String((entry && entry.text) || "").slice(0, 240),
    }));
  } catch (e) {}
  let viewport = null;
  try {
    viewport = {
      width: Math.round(window.innerWidth || 0),
      height: Math.round(window.innerHeight || 0),
      scrollY: Math.round(window.scrollY || 0),
      pageHeight: Math.round(
        (document.documentElement && document.documentElement.scrollHeight) ||
          (document.body && document.body.scrollHeight) ||
          0,
      ),
    };
  } catch (e) {}
  let focused = "";
  try {
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement
    ) {
      const lbl = window.__monocodeLabel;
      focused = String(
        typeof lbl === "function"
          ? lbl(active)
          : (active.tagName || "").toLowerCase(),
      ).slice(0, 160);
    }
  } catch (e) {}
  let selection = "";
  try {
    selection = String(window.getSelection() || "").trim().slice(0, 400);
  } catch (e) {}
  const headings = [];
  try {
    const hs = document.querySelectorAll("h1,h2,h3");
    for (const h of hs) {
      const r = h.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const heading = (h.innerText || "").trim().replace(/\s+/g, " ");
      if (!heading) continue;
      headings.push(
        `${(h.tagName || "").toLowerCase()} ${heading.slice(0, 100)}`,
      );
      if (headings.length >= 12) break;
    }
  } catch (e) {}
  return {
    url: String(location.href || "").slice(0, 8192),
    title: String(document.title || "").slice(0, 200),
    text: String(text).slice(0, 6000),
    controls,
    console: log,
    steps,
    viewport,
    focused,
    selection,
    headings,
  };
})()"#;

#[derive(Default)]
pub struct BrowserState {
    history: Mutex<HashMap<String, History>>,
    hooked: Mutex<HashSet<String>>,
    /// History keys whose webview owns a dedicated persistent data store —
    /// only those may be cleared without touching the app shell's store.
    dedicated: Mutex<HashSet<String>>,
}

struct History {
    urls: Vec<String>,
    index: usize,
}

impl History {
    fn new(url: &str) -> Self {
        Self {
            urls: vec![url.to_string()],
            index: 0,
        }
    }

    fn push(&mut self, url: &str) {
        if self.urls.get(self.index) == Some(&url.to_string()) {
            return;
        }
        if self.urls.get(self.index.wrapping_sub(1)) == Some(&url.to_string()) && self.index > 0 {
            self.index -= 1;
            return;
        }
        if self.urls.get(self.index + 1) == Some(&url.to_string()) {
            self.index += 1;
            return;
        }
        self.urls.truncate(self.index + 1);
        self.urls.push(url.to_string());
        if self.urls.len() > MAX_HISTORY {
            let drop = self.urls.len() - MAX_HISTORY;
            self.urls.drain(..drop);
            self.index = self.index.saturating_sub(drop);
        }
        self.index = self.urls.len() - 1;
    }

    fn can_back(&self) -> bool {
        self.index > 0
    }

    fn can_forward(&self) -> bool {
        self.index + 1 < self.urls.len()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserEvent<'a> {
    label: &'a str,
    window: &'a str,
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    can_back: bool,
    can_forward: bool,
}

/// One page-side occurrence worth telling the tab about.
struct BrowserNotice {
    kind: &'static str,
    url: Option<String>,
    title: Option<String>,
    reason: Option<String>,
    can_back: bool,
    can_forward: bool,
}

impl BrowserNotice {
    /// For struct-update syntax: `..BrowserNotice::empty()` — `kind` is
    /// always supplied by the caller's literal.
    fn empty() -> Self {
        Self {
            kind: "",
            url: None,
            title: None,
            reason: None,
            can_back: false,
            can_forward: false,
        }
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, label: &str, window: &str, notice: BrowserNotice) {
    let _ = app.emit(
        EVENT,
        BrowserEvent {
            label,
            window,
            kind: notice.kind,
            url: notice.url,
            title: notice.title,
            reason: notice.reason,
            can_back: notice.can_back,
            can_forward: notice.can_forward,
        },
    );
}

fn history_key(window: &str, label: &str) -> String {
    format!("{window}/{label}")
}

fn allowed_url(url: &Url, app_origin: Option<&str>) -> Result<(), String> {
    if url.as_str().len() > MAX_URL_LEN {
        return Err("URL is too long".into());
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{}: links aren't allowed in Browser", url.scheme()));
    }
    // Embedded credentials would otherwise be remembered, shown in the
    // address bar and emitted in events — refuse them outright.
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with embedded credentials aren't allowed".into());
    }
    if let Some(host) = url.host_str() {
        if LOCAL_HOSTS.contains(&host) {
            return Err("that address belongs to MonoCode".into());
        }
    }
    if let Some(origin) = app_origin {
        if url.origin().ascii_serialization() == origin {
            return Err("that address belongs to MonoCode".into());
        }
    }
    Ok(())
}

fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= MAX_LABEL_LEN
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
}

fn app_origin<R: Runtime>(window: &Window<R>) -> Option<String> {
    window
        .webviews()
        .iter()
        .find(|view| view.label() == window.label())
        .and_then(|view| view.url().ok())
        .map(|url| url.origin().ascii_serialization())
}

/// Identifies the dedicated WKWebsiteDataStore holding persisted browser
/// tabs — exactly 16 bytes ("monocode-browser").
#[cfg(target_os = "macos")]
const BROWSER_STORE_ID: [u8; 16] = *b"monocode-browser";

/// macOS major version, queried once — feature gates below.
#[cfg(target_os = "macos")]
fn os_major() -> isize {
    use objc2_foundation::NSProcessInfo;
    static VERSION: std::sync::OnceLock<isize> = std::sync::OnceLock::new();
    *VERSION.get_or_init(|| {
        NSProcessInfo::processInfo()
            .operatingSystemVersion()
            .majorVersion
    })
}

/// `data_store_identifier` needs macOS 14; below it a persisted tab falls
/// back to the default (shared) data store, which still persists but must
/// never be cleared from here — it holds the app's own storage too.
#[cfg(target_os = "macos")]
fn dedicated_store_supported() -> bool {
    os_major() >= 14
}

/// Run an eval whose JSON return value is needed. Async like
/// `browser_probe`: the completion callback arrives on the main thread, so
/// blocking inside a synchronous command deadlocks on Windows.
async fn eval_json<R: Runtime>(view: &tauri::Webview<R>, script: String) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    view.eval_with_callback(script, move |result| {
        let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(PROBE_TIMEOUT)
            .map_err(|_| "The page didn't answer".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn find_webview<R: Runtime>(window: &Window<R>, label: &str) -> Result<tauri::Webview<R>, String> {
    // The window's own shell webview shares this namespace — a bad label
    // must never resolve to it (browser_close would destroy the app UI).
    if label == window.label() {
        return Err("Invalid browser label".into());
    }
    window
        .webviews()
        .into_iter()
        .find(|view| view.label() == label)
        .ok_or_else(|| "Browser tab is no longer open".to_string())
}

/// Close webviews and drop history for a window going away. Registered once
/// per window so a destroyed window never leaves stale bookkeeping.
fn hook_window_close<R: Runtime>(app: &AppHandle<R>, window: &Window<R>) {
    let key = window.label().to_string();
    {
        let state = app.state::<BrowserState>();
        if !state.hooked.lock().unwrap().insert(key.clone()) {
            return;
        }
    }
    let app = app.clone();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        let state = app.state::<BrowserState>();
        let prefix = format!("{key}/");
        state
            .history
            .lock()
            .unwrap()
            .retain(|entry, _| !entry.starts_with(&prefix));
        state
            .dedicated
            .lock()
            .unwrap()
            .retain(|entry| !entry.starts_with(&prefix));
        state.hooked.lock().unwrap().remove(&key);
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Async like `browser_probe`: Tauri documents that creating a webview in a
/// synchronous command can deadlock on Windows (the WebView2 controller
/// pumps a nested message loop inside the IPC dispatch).
#[tauri::command]
pub async fn browser_open(
    window: Window,
    app: AppHandle,
    label: String,
    url: String,
    bounds: BrowserBounds,
    background: Option<Color>,
    persist: Option<bool>,
) -> Result<(), String> {
    if !valid_label(&label) {
        return Err("Invalid browser label".into());
    }
    let parsed = Url::parse(&url).map_err(|_| "Enter a valid URL".to_string())?;
    let origin = app_origin(&window);
    allowed_url(&parsed, origin.as_deref())?;

    let window_label = window.label().to_string();
    let key = history_key(&window_label, &label);
    let persist = persist.unwrap_or(true);

    // Idempotent open: a stale webview under the same label is replaced.
    if let Ok(existing) = find_webview(&window, &label) {
        let _ = existing.close();
    }

    let state = app.state::<BrowserState>();
    state
        .history
        .lock()
        .unwrap()
        .insert(key.clone(), History::new(parsed.as_str()));

    let nav_app = app.clone();
    let nav_window = window_label.clone();
    let nav_label = label.clone();
    let nav_origin = origin.clone();
    let page_origin = origin.clone();
    let new_window_app = app.clone();
    let new_window_window = window_label.clone();
    let new_window_label = label.clone();
    let page_load_app = app.clone();
    let page_load_window = window_label.clone();
    let page_load_label = label.clone();
    let title_app = app.clone();
    let title_window = window_label.clone();
    let download_app = app.clone();
    let download_window = window_label.clone();
    let download_label = label.clone();

    // `mut` only where a data store gets configured — mobile never does.
    #[allow(unused_mut)]
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed.clone()))
        // Persisted tabs keep cookies/site data in the browser profile so
        // dev logins survive webview recreation and app restarts; a tab
        // marked private stays on the throwaway store.
        .incognito(!persist)
        .devtools(true)
        .focused(false)
        // The pane's own background — WKWebView paints it during the
        // process swap on every cross-site navigation, so matching the
        // theme turns a white strobe into an invisible handoff.
        .background_color(background.unwrap_or(Color(255, 255, 255, 255)))
        .initialization_script(PAGE_TAP_SCRIPT)
        .on_navigation(move |url| {
            // Policy gate only. WKWebView reports subframe navigations here
            // too and wry does not pass targetFrame, so this callback can't
            // tell a main-frame commit from an iframe — history and the
            // address bar update live in on_page_load, which is main-frame
            // only. about:/blob:/data: are allowed for the pervasive
            // srcdoc/blank iframe cases; they never gain invoke authority.
            let verdict = match url.scheme() {
                "http" | "https" => allowed_url(url, nav_origin.as_deref()),
                "about" | "blob" | "data" => Ok(()),
                scheme => Err(format!("{scheme}: links aren't allowed in Browser")),
            };
            if let Err(reason) = verdict {
                emit(
                    &nav_app,
                    &nav_label,
                    &nav_window,
                    BrowserNotice {
                        kind: "blocked",
                        url: Some(url.as_str().chars().take(MAX_URL_LEN).collect()),
                        reason: Some(reason),
                        ..BrowserNotice::empty()
                    },
                );
                return false;
            }
            true
        })
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                emit(
                    &new_window_app,
                    &new_window_label,
                    &new_window_window,
                    BrowserNotice {
                        kind: "popup",
                        url: Some(url.as_str().chars().take(MAX_URL_LEN).collect()),
                        ..BrowserNotice::empty()
                    },
                );
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            // Page-load events are main-frame only on both engines, so this
            // is where the committed URL is recorded and reported. Started
            // carries the requested URL (early bar feedback); Finished
            // carries the post-redirect URL and earns the history slot.
            let url = payload.url();
            let committed = matches!(url.scheme(), "http" | "https")
                && allowed_url(url, page_origin.as_deref()).is_ok();
            let (can_back, can_forward) = {
                let state = page_load_app.state::<BrowserState>();
                let key = history_key(&page_load_window, &page_load_label);
                let mut guard = state.history.lock().unwrap();
                match payload.event() {
                    PageLoadEvent::Finished if committed => guard
                        .get_mut(&key)
                        .map(|history| {
                            history.push(url.as_str());
                            (history.can_back(), history.can_forward())
                        })
                        .unwrap_or((false, false)),
                    _ => guard
                        .get(&key)
                        .map(|history| (history.can_back(), history.can_forward()))
                        .unwrap_or((false, false)),
                }
            };
            if committed {
                emit(
                    &page_load_app,
                    webview.label(),
                    &page_load_window,
                    BrowserNotice {
                        kind: "navigate",
                        url: Some(url.as_str().chars().take(MAX_URL_LEN).collect()),
                        can_back,
                        can_forward,
                        ..BrowserNotice::empty()
                    },
                );
            }
            emit(
                &page_load_app,
                webview.label(),
                &page_load_window,
                BrowserNotice {
                    kind: match payload.event() {
                        PageLoadEvent::Started => "load-started",
                        PageLoadEvent::Finished => "load-finished",
                    },
                    url: Some(url.as_str().chars().take(MAX_URL_LEN).collect()),
                    can_back,
                    can_forward,
                    ..BrowserNotice::empty()
                },
            );
        })
        .on_document_title_changed(move |webview, title| {
            emit(
                &title_app,
                webview.label(),
                &title_window,
                BrowserNotice {
                    kind: "title",
                    title: Some(title.chars().take(MAX_TITLE_LEN).collect()),
                    ..BrowserNotice::empty()
                },
            );
        })
        .on_download(move |_webview, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                emit(
                    &download_app,
                    &download_label,
                    &download_window,
                    BrowserNotice {
                        kind: "download",
                        url: Some(url.as_str().chars().take(MAX_URL_LEN).collect()),
                        reason: Some("Downloads are not allowed in Browser".into()),
                        ..BrowserNotice::empty()
                    },
                );
            }
            false
        });

    // A persisted tab needs its own data store, not the app shell's:
    // WebView2/WebKitGTK take a data directory; WKWebView takes a named
    // store (macOS 14+). `dedicated` must only be set when that store was
    // actually applied — `browser_clear_data` trusts the flag, and the
    // fallback (default store/shared WebContext) also holds the app's own
    // storage. (On old WebView2 runtimes wry silently ignores `incognito`,
    // so a "private" tab may still persist — never promise otherwise.)
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    let dedicated = {
        let mut applied = false;
        if persist {
            if let Ok(dir) = app
                .path()
                .app_local_data_dir()
                .map(|dir| dir.join("browser"))
            {
                let _ = std::fs::create_dir_all(&dir);
                builder = builder.data_directory(dir);
                applied = true;
            }
        }
        applied
    };
    #[cfg(target_os = "macos")]
    let dedicated = persist && dedicated_store_supported();
    #[cfg(target_os = "macos")]
    if dedicated {
        builder = builder.data_store_identifier(BROWSER_STORE_ID);
    }
    // Mobile: no dedicated store exists — `incognito` still applies, but
    // there is nothing `browser_clear_data` may safely wipe.
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let dedicated = false;
    {
        let state = app.state::<BrowserState>();
        let mut dedicated_keys = state.dedicated.lock().unwrap();
        if dedicated {
            dedicated_keys.insert(key.clone());
        } else {
            dedicated_keys.remove(&key);
        }
    }

    hook_window_close(&app, &window);
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn browser_close(window: Window, app: AppHandle, label: String) -> Result<(), String> {
    if let Ok(view) = find_webview(&window, &label) {
        let _ = view.close();
    }
    let state = app.state::<BrowserState>();
    let key = history_key(window.label(), &label);
    state.history.lock().unwrap().remove(&key);
    state.dedicated.lock().unwrap().remove(&key);
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(window: Window, label: String, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Enter a valid URL".to_string())?;
    allowed_url(&parsed, app_origin(&window).as_deref())?;
    find_webview(&window, &label)?
        .navigate(parsed)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_reload(window: Window, label: String) -> Result<(), String> {
    find_webview(&window, &label)?
        .reload()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_go_back(window: Window, label: String) -> Result<(), String> {
    find_webview(&window, &label)?
        .eval("history.back()")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_go_forward(window: Window, label: String) -> Result<(), String> {
    find_webview(&window, &label)?
        .eval("history.forward()")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_set_bounds(
    window: Window,
    label: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    find_webview(&window, &label)?
        .set_bounds(Rect {
            position: LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)).into(),
            size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
        })
        .map_err(|error| error.to_string())
}

/// The shell follows theme flips; an open webview's swap-flash color is
/// only as fresh as its last update — cheap to keep in step.
#[tauri::command]
pub fn browser_set_background(window: Window, label: String, color: Color) -> Result<(), String> {
    find_webview(&window, &label)?
        .set_background_color(Some(color))
        .map_err(|error| error.to_string())
}

/// Hiding a child webview suspends it — WKWebView stalls for a beat
/// re-compositing on the next show, which read as the preview freezing
/// whenever a tab switch hid and restored it. Instead "hidden" parks the
/// view offscreen at its current size: nothing suspends, no relayout
/// runs, and the next set_bounds puts it back instantly. `visible: true`
/// is a no-op — the bounds sync that always follows restores position.
#[tauri::command]
pub fn browser_set_visible(window: Window, label: String, visible: bool) -> Result<(), String> {
    if visible {
        return Ok(());
    }
    let view = find_webview(&window, &label)?;
    let bounds = view.bounds().map_err(|error| error.to_string())?;
    view.set_bounds(Rect {
        position: tauri::PhysicalPosition::new(-32_768, 0).into(),
        size: bounds.size,
    })
    .map_err(|error| error.to_string())
}

/// Flip the page-side steps recorder on or off; returns whether the page
/// actually has the hook (a page where the init script can't run — e.g.
/// still on its first load — silently has no flag otherwise, and the
/// toolbar indicator would lie). The flag lives in the page's
/// sessionStorage so a same-origin reload keeps recording; the app also
/// re-asserts it after loads to heal a recreated webview — the page-side
/// setter is idempotent so that re-assert never wipes the trail. Async
/// for the same reason `browser_probe` is: the eval callback arrives on
/// the main thread.
#[tauri::command]
pub async fn browser_set_recording(
    window: Window,
    label: String,
    on: bool,
) -> Result<bool, String> {
    let view = find_webview(&window, &label)?;
    let raw = eval_json(
        &view,
        format!(
            "!!(window.__monocodeSetRec && (window.__monocodeSetRec({}), true))",
            if on { "true" } else { "false" }
        ),
    )
    .await
    .map_err(|_| "Recording toggle timed out".to_string())?;
    Ok(raw.trim() == "true")
}

/// Read the live location so the tab can tell "never loaded" apart from a
/// page that is merely slow — WKWebView shows nothing for a refused
/// connection. Async: the eval callback is delivered on the main thread,
/// so a synchronous command would deadlock waiting for it. Before the
/// first committed navigation WKWebView runs evals without invoking the
/// completion callback, so a probe there resolves via timeout rather than
/// reporting about:blank.
#[tauri::command]
pub async fn browser_probe(window: Window, label: String) -> Result<String, String> {
    let view = find_webview(&window, &label)?;
    eval_json(
        &view,
        "({href:location.href,title:document.title,readyState:document.readyState})".to_string(),
    )
    .await
    .map_err(|_| "Probe timed out".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleLine {
    level: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStep {
    /// `Date.now()` in the page — meaningful only as a relative offset.
    at: f64,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewport {
    width: f64,
    height: f64,
    scroll_y: f64,
    page_height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapture {
    url: String,
    title: Option<String>,
    text: Option<String>,
    controls: Vec<String>,
    console: Vec<BrowserConsoleLine>,
    /// The recorded session's interaction trail — empty unless the user
    /// pressed record; the frontend decides whether to include it.
    steps: Vec<BrowserStep>,
    /// Viewport size and scroll position — what the screenshot shows.
    viewport: Option<BrowserViewport>,
    focused: Option<String>,
    selection: Option<String>,
    /// Visible h1–h3 outline, top to bottom.
    headings: Vec<String>,
    /// Base64 PNG of the visible page, when the platform supports it.
    screenshot: Option<String>,
    /// Why a piece is missing, when it is.
    detail: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageSummary {
    url: Option<String>,
    title: Option<String>,
    text: Option<String>,
    controls: Option<Vec<serde_json::Value>>,
    console: Option<Vec<PageConsoleLine>>,
    steps: Option<Vec<PageStep>>,
    viewport: Option<PageViewport>,
    focused: Option<String>,
    selection: Option<String>,
    headings: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
struct PageConsoleLine {
    level: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct PageStep {
    at: Option<f64>,
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageViewport {
    width: Option<f64>,
    height: Option<f64>,
    scroll_y: Option<f64>,
    page_height: Option<f64>,
}

fn clip_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Start the platform screenshot; completion arrives on `tx` as PNG bytes.
/// Every platform variant either reports an error or guarantees a send.
#[cfg(target_os = "macos")]
fn start_screenshot<R: Runtime>(
    view: &tauri::Webview<R>,
    tx: std::sync::mpsc::Sender<Option<Vec<u8>>>,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    view.with_webview(move |platform| {
        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let png = unsafe {
                if image.is_null() || !error.is_null() {
                    None
                } else {
                    (*image)
                        .TIFFRepresentation()
                        .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                        .and_then(|rep| {
                            rep.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                        })
                        .map(|data| data.to_vec())
                }
            };
            let _ = tx.send(png);
        });
        unsafe {
            let webview: &WKWebView = &*platform.inner().cast();
            webview.takeSnapshotWithConfiguration_completionHandler(None, &block);
        }
    })
    .map_err(|error| error.to_string())
}

/// WebView2's CapturePreview renders the viewport into a stream as PNG.
#[cfg(windows)]
fn start_screenshot<R: Runtime>(
    view: &tauri::Webview<R>,
    tx: std::sync::mpsc::Sender<Option<Vec<u8>>>,
) -> Result<(), String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    unsafe fn read_stream(stream: &IStream) -> Option<Vec<u8>> {
        stream.Seek(0, STREAM_SEEK_SET, None).ok()?;
        let mut out = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        loop {
            let mut read = 0u32;
            if stream
                .Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut read))
                .is_err()
                || read == 0
            {
                break;
            }
            out.extend_from_slice(&buf[..read as usize]);
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    view.with_webview(move |platform| unsafe {
        let stream = match SHCreateMemStream(None) {
            Some(stream) => stream,
            None => {
                let _ = tx.send(None);
                return;
            }
        };
        let captured = stream.clone();
        let fired = tx.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            let _ = fired.send(if result.is_ok() {
                read_stream(&captured)
            } else {
                None
            });
            Ok(())
        }));
        let started = platform.controller().CoreWebView2().and_then(|webview| {
            webview.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            )
        });
        if started.is_err() {
            // The capture never kicked off, so the handler won't run.
            let _ = tx.send(None);
        }
    })
    .map_err(|error| error.to_string())
}

/// No snapshot API wired up for this platform — text capture still works.
#[cfg(not(any(target_os = "macos", windows)))]
fn start_screenshot<R: Runtime>(
    _view: &tauri::Webview<R>,
    tx: std::sync::mpsc::Sender<Option<Vec<u8>>>,
) -> Result<(), String> {
    let _ = tx.send(None);
    Err("Screenshots aren't supported on this platform".into())
}

/// Snapshot the page for agent context: a screenshot plus a bounded
/// visible-text/controls/console summary. The screenshot uses the platform
/// capture API (`takeSnapshotWithConfiguration` / `CapturePreview`); the
/// summary is an eval whose result is re-bounded here.
#[tauri::command]
pub async fn browser_capture(window: Window, label: String) -> Result<BrowserCapture, String> {
    let view = find_webview(&window, &label)?;

    let (page_tx, page_rx) = std::sync::mpsc::channel();
    view.eval_with_callback(SUMMARY_SCRIPT, move |result| {
        let _ = page_tx.send(result);
    })
    .map_err(|error| error.to_string())?;

    let (shot_tx, shot_rx) = std::sync::mpsc::channel();
    let shot_detail = start_screenshot(&view, shot_tx).err();

    let (summary, screenshot) = tauri::async_runtime::spawn_blocking(move || {
        // One deadline for both halves — a slow page must not make a
        // capture take twice the timeout.
        let deadline = std::time::Instant::now() + CAPTURE_TIMEOUT;
        let summary = page_rx.recv_timeout(CAPTURE_TIMEOUT).ok();
        let screenshot = shot_rx
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .ok()
            .flatten();
        (summary, screenshot)
    })
    .await
    .map_err(|error| error.to_string())?;

    let parsed = summary
        .as_deref()
        .map(|raw| serde_json::from_str::<PageSummary>(raw).ok());
    let summary_ok = matches!(parsed, Some(Some(_)));
    let page = parsed.flatten().unwrap_or(PageSummary {
        url: None,
        title: None,
        text: None,
        controls: None,
        console: None,
        steps: None,
        viewport: None,
        focused: None,
        selection: None,
        headings: None,
    });

    let controls = page
        .controls
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .take(MAX_CAPTURE_CONTROLS)
        .map(|line| clip_chars(&line, MAX_CAPTURE_CONTROL_LEN))
        .collect();
    let console = page
        .console
        .unwrap_or_default()
        .into_iter()
        .map(|line| BrowserConsoleLine {
            level: line
                .level
                .map(|level| clip_chars(&level, 16))
                .unwrap_or_else(|| "log".to_string()),
            text: clip_chars(&line.text.unwrap_or_default(), MAX_CAPTURE_CONSOLE_LEN),
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(MAX_CAPTURE_CONSOLE)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let steps = page
        .steps
        .unwrap_or_default()
        .into_iter()
        .map(|entry| BrowserStep {
            at: entry.at.unwrap_or(0.0),
            text: clip_chars(&entry.text.unwrap_or_default(), MAX_STEP_TEXT),
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(MAX_CAPTURE_STEPS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let viewport = page.viewport.map(|v| BrowserViewport {
        width: v.width.unwrap_or(0.0),
        height: v.height.unwrap_or(0.0),
        scroll_y: v.scroll_y.unwrap_or(0.0),
        page_height: v.page_height.unwrap_or(0.0),
    });
    let focused = page
        .focused
        .filter(|value| !value.trim().is_empty())
        .map(|value| clip_chars(&value, MAX_FOCUSED_LEN));
    let selection = page
        .selection
        .filter(|value| !value.trim().is_empty())
        .map(|value| clip_chars(&value, MAX_SELECTION_LEN));
    let headings = page
        .headings
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .take(MAX_HEADINGS)
        .map(|line| clip_chars(&line, MAX_HEADING_LEN))
        .collect();

    let (screenshot, shot_detail) = match (screenshot, shot_detail) {
        (Some(bytes), _) if bytes.len() > MAX_SCREENSHOT_BYTES => {
            (None, Some("screenshot too large to attach".to_string()))
        }
        pair => pair,
    };
    let screenshot_b64 = screenshot.map(|bytes| {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    });

    let summary_detail = if summary.is_none() {
        Some("summary timed out")
    } else if !summary_ok {
        Some("summary unreadable")
    } else {
        None
    };
    let detail = match (summary_detail, shot_detail) {
        (None, None) => None,
        (a, b) => Some(
            [a, b.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("; "),
        ),
    };

    Ok(BrowserCapture {
        url: clip_chars(&page.url.unwrap_or_default(), MAX_URL_LEN),
        title: page.title.map(|title| clip_chars(&title, MAX_TITLE_LEN)),
        text: page.text.map(|text| clip_chars(&text, MAX_CAPTURE_TEXT)),
        controls,
        console,
        steps,
        viewport,
        focused,
        selection,
        headings,
        screenshot: screenshot_b64,
        detail,
    })
}

// --- Login fill / capture (#browser-fill) ---
//
// One script does both jobs: `mode: "capture"` reads the page's login
// fields back (the values travel only as far as the Rust command — never
// the frontend); `mode: "fill"` writes a stored profile into them.
// Discovery walks the document, open shadow roots and same-origin
// iframes; values go in through the native setter + input/change events
// so framework-controlled inputs register them. OTP fields are detected
// and reported but never filled — a one-time code is for the user to
// type. Nothing is submitted unless the profile opts in.
const LOGIN_FORM_SCRIPT: &str = r#"(arg) => {
  // The real origin gate lives here: a navigation that committed after
  // the command read the location must not receive stored credentials —
  // this check runs in the same synchronous eval as the fill.
  if (
    arg &&
    arg.expectedOrigin &&
    location.origin !== arg.expectedOrigin
  ) {
    return { aborted: true };
  }
  const CAP = 400;
  const fields = [];
  const buttons = [];
  const ID_RE = /user|e.?mail|log.?in|account|identifier|handle|phone|sign.?in/i;
  const REMEMBER_RE = /remember|stay|keep.?me|trust|signed/i;
  const OTP_RE = /otp|one.?time|2fa|mfa|totp|verif|passcode|security.?code/i;
  const NEXT_RE = /^(next|continue|sign ?in|log ?in|submit|proceed|verify|go)$/i;

  // Lone surrogates are unpaired UTF-16 — they pass through JSON but kill
  // the native JSON serializer on the way back (wry unwraps it).
  const clean = (s) =>
    Array.from(String(s))
      .filter((c) => {
        const n = c.codePointAt(0);
        return n < 0xd800 || n > 0xdfff;
      })
      .join("");

  const visible = (el) => {
    try {
      if (el.disabled || el.readOnly) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  };
  const label = (el) => {
    try {
      const tag = (el.tagName || "").toLowerCase();
      const type = ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
      let text =
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        el.getAttribute("title") ||
        (tag === "input" && (type === "button" || type === "submit") ? el.value : "") ||
        (tag === "button" ? (el.innerText || "").trim() : "") ||
        el.id || "";
      text = clean(String(text).trim().replace(/\s+/g, " ").slice(0, 80));
      const name = tag === "input" && type && type !== "text" ? "input[" + type + "]" : tag;
      return text ? name + ' "' + text + '"' : name;
    } catch (e) {
      return "field";
    }
  };
  const classify = (el) => {
    const tag = (el.tagName || "").toLowerCase();
    if (tag !== "input" && tag !== "textarea") return null;
    const type = (((el.getAttribute && el.getAttribute("type")) || el.type || "") + "").toLowerCase();
    const ac = ((el.getAttribute("autocomplete") || "") + "").toLowerCase();
    const hint = [
      el.getAttribute("name") || "",
      el.id || "",
      el.getAttribute("placeholder") || "",
      el.getAttribute("aria-label") || "",
      ac,
    ].join(" ");
    // OTP before password: type=password + autocomplete=one-time-code is
    // a common 2FA shape — the account password must never land there.
    // An explicit current/new-password hint outranks name guesses like
    // "passcode"; a bare type=password with OTP-ish hints stays out.
    if (ac === "one-time-code") return "otp";
    if (ac === "current-password" || ac === "new-password") return "password";
    if (type === "password") return OTP_RE.test(hint) ? "otp" : "password";
    if (OTP_RE.test(hint)) return "otp";
    if (type === "checkbox") return REMEMBER_RE.test(hint) ? "remember" : null;
    if (ac === "username" || ac === "email") return "identity";
    if (type === "email" || type === "tel") return "identity";
    if ((type === "text" || type === "" || type === "username" || tag === "textarea") && ID_RE.test(hint))
      return "identity";
    return null;
  };
  const clickable = (el) => {
    const tag = (el.tagName || "").toLowerCase();
    const type = ((el.getAttribute("type") || "") + "").toLowerCase();
    if (tag === "input") return type === "submit" || type === "button" || type === "image";
    if (tag === "button") return true;
    return (el.getAttribute("role") || "") === "button";
  };
  const btnText = (el) =>
    String(
      (el.innerText || el.value || el.getAttribute("aria-label") || "") + "",
    ).trim().replace(/\s+/g, " ");

  const walk = (root, depth) => {
    if (depth > 5 || fields.length + buttons.length > CAP) return;
    let els;
    try {
      els = root.querySelectorAll("input,textarea,select,button,[role='button'],iframe");
    } catch (e) {
      return;
    }
    for (const el of els) {
      if (fields.length + buttons.length > CAP) break;
      try {
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        if ((el.tagName || "").toLowerCase() === "iframe") {
          try {
            if (el.contentDocument) walk(el.contentDocument, depth + 1);
          } catch (e) {}
          continue;
        }
        if (!visible(el)) continue;
        const kind = classify(el);
        if (kind) {
          fields.push({ el, kind });
          continue;
        }
        if (clickable(el)) buttons.push(el);
      } catch (e) {}
    }
  };
  walk(document, 0);

  const identity = fields.find((f) => f.kind === "identity");
  const password = fields.find((f) => f.kind === "password");
  const otp = fields.some((f) => f.kind === "otp");

  if ((arg && arg.mode) === "capture") {
    return {
      // href read in the same eval as the values — the pair can't drift
      // across a navigation.
      href: location.href,
      identity: identity ? clean(identity.el.value || "") : "",
      password: password ? clean(password.el.value || "") : "",
      otp,
    };
  }

  const result = { filled: [], missing: [], otpRequired: otp, submitted: false };
  const setVal = (el, v) => {
    try {
      // getPrototypeOf resolves the element's own realm — instanceof
      // against the top realm fails inside same-origin iframes, and the
      // wrong setter then throws a WebIDL receiver error.
      const proto = Object.getPrototypeOf(el);
      const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, v);
      else el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value === v;
    } catch (e) {
      return false;
    }
  };
  if (!identity) result.missing.push("username");
  if (!password) result.missing.push("password");
  if (identity && arg.username && setVal(identity.el, arg.username)) {
    result.filled.push(label(identity.el));
  }
  if (password && arg.password && setVal(password.el, arg.password)) {
    result.filled.push(label(password.el));
  }
  if (arg.rememberMe) {
    const remember = fields.find((f) => f.kind === "remember");
    if (remember) {
      try {
        if (!remember.el.checked) remember.el.click();
        result.filled.push(label(remember.el));
      } catch (e) {}
    }
  }
  // Auto-submit is opt-in per profile: a completed password field may
  // submit the form; an identity-only fill clicks a "next"-style control
  // so multi-step flows advance without trusting a guess.
  if (arg.submit && result.filled.length) {
    try {
      const anchor = (password || identity).el;
      const form = anchor && anchor.closest ? anchor.closest("form") : null;
      let target = null;
      if (form) {
        const candidates = Array.from(
          form.querySelectorAll("[type='submit'],button:not([type])"),
        ).filter(visible);
        target = candidates[0] || null;
      }
      if (!target && password && arg.password) {
        target = buttons.find((b) => NEXT_RE.test(btnText(b))) || null;
      }
      if (!target && !password) {
        target = buttons.find((b) => NEXT_RE.test(btnText(b))) || null;
      }
      if (target) {
        target.click();
        result.submitted = true;
      }
    } catch (e) {}
  }
  return result;
}"#;

/// Page-local find: text-node walk + CSS Custom Highlight painting +
/// scroll-into-view. State lives on `window.__monocodeFind` so repeated
/// calls step through matches; an empty query clears it.
const FIND_SCRIPT: &str = r#"(arg) => {
  const q = String((arg && arg.query) || "").slice(0, 200);
  const NS = "monocode-find";
  const state = (window.__monocodeFind = window.__monocodeFind || {
    query: "",
    index: -1,
  });
  const clear = () => {
    try {
      if (window.CSS && CSS.highlights) {
        CSS.highlights.delete(NS);
        CSS.highlights.delete(NS + "-current");
      }
    } catch (e) {}
  };
  if (!q) {
    clear();
    state.query = "";
    state.index = -1;
    return { count: 0, index: -1 };
  }
  const matches = [];
  try {
    const lower = q.toLowerCase();
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node;
    // Matches are capped at 200; the walk itself needs a budget too —
    // a huge DOM with few matches would otherwise blow the eval timeout.
    let walked = 0;
    while ((node = walker.nextNode()) && walked++ < 20000) {
      if (matches.length >= 200) break;
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style,noscript,iframe")) continue;
      const text = node.nodeValue || "";
      const hay = text.toLowerCase();
      let i = hay.indexOf(lower);
      while (i >= 0) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + q.length);
        matches.push(range);
        if (matches.length >= 200) break;
        i = hay.indexOf(lower, i + q.length);
      }
    }
  } catch (e) {}
  if (window.CSS && CSS.highlights) {
    try {
      if (!document.getElementById("monocode-find-style")) {
        const style = document.createElement("style");
        style.id = "monocode-find-style";
        style.textContent =
          "::highlight(" + NS + ") { background-color: rgba(255,200,0,0.35); color: inherit; }" +
          "::highlight(" + NS + "-current) { background-color: rgba(255,150,0,0.7); color: inherit; }";
        (document.head || document.documentElement).appendChild(style);
      }
      CSS.highlights.set(NS, new Highlight(...matches));
    } catch (e) {}
  }
  if (state.query !== q) {
    state.query = q;
    state.index = matches.length ? 0 : -1;
  } else if (matches.length) {
    const d = arg && arg.forward === false ? -1 : 1;
    state.index = (state.index + d + matches.length) % matches.length;
  } else {
    state.index = -1;
  }
  if (state.index >= 0) {
    try {
      if (window.CSS && CSS.highlights)
        CSS.highlights.set(NS + "-current", new Highlight(matches[state.index]));
      const el = matches[state.index].startContainer.parentElement;
      if (el) el.scrollIntoView({ block: "center" });
    } catch (e) {}
  }
  return { count: matches.length, index: state.index };
}"#;

/// Toggle (or set) the page inspector. In release builds this needs the
/// `devtools` cargo feature — enabled in Cargo.toml.
#[tauri::command]
pub fn browser_devtools(window: Window, label: String, open: Option<bool>) -> Result<bool, String> {
    let view = find_webview(&window, &label)?;
    let next = match open {
        Some(open) => open,
        None => !view.is_devtools_open(),
    };
    if next {
        view.open_devtools();
    } else {
        view.close_devtools();
    }
    // Report the requested state, not a re-query: WebView2's
    // `is_devtools_open` is hardcoded false (close is a no-op too), and
    // WKWebView's inspector visibility is async right after show.
    Ok(next)
}

/// Clear the browser profile's site data (cookies, storage). Only a tab
/// backed by the dedicated store may clear it — on older macOS persistent
/// tabs share the app shell's default data store, and clearing that would
/// wipe app settings too.
#[tauri::command]
pub fn browser_clear_data(window: Window, app: AppHandle, label: String) -> Result<(), String> {
    let key = history_key(window.label(), &label);
    let dedicated = app
        .state::<BrowserState>()
        .dedicated
        .lock()
        .unwrap()
        .contains(&key);
    if !dedicated {
        return Err("Only a persistent browser tab has its own data to clear".into());
    }
    find_webview(&window, &label)?
        .clear_all_browsing_data()
        .map_err(|error| error.to_string())
}

/// Copy a screenshot of the visible page to the system clipboard. Same
/// platform capture as `browser_capture`, minus the DOM summary.
#[tauri::command]
pub async fn browser_copy_screenshot(
    window: Window,
    app: AppHandle,
    label: String,
) -> Result<(), String> {
    let view = find_webview(&window, &label)?;
    let (tx, rx) = std::sync::mpsc::channel();
    start_screenshot(&view, tx)?;
    let png = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(CAPTURE_TIMEOUT).ok().flatten()
    })
    .await
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "Screenshot unavailable".to_string())?;
    if png.len() > MAX_SCREENSHOT_BYTES {
        return Err("Screenshot too large to copy".into());
    }
    let image = tauri::image::Image::from_bytes(&png).map_err(|error| error.to_string())?;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_image(&image)
        .map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFindResult {
    count: usize,
    index: i32,
}

/// Text search inside the page — highlight via the CSS Custom Highlight
/// API when present, scroll-into-view always. `forward: false` steps back.
#[tauri::command]
pub async fn browser_find(
    window: Window,
    label: String,
    query: String,
    forward: Option<bool>,
) -> Result<BrowserFindResult, String> {
    let view = find_webview(&window, &label)?;
    let arg = serde_json::json!({
        "query": query.chars().take(200).collect::<String>(),
        "forward": forward.unwrap_or(true),
    });
    let arg = serde_json::to_string(&arg)
        .map_err(|error| error.to_string())?
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    let raw = eval_json(&view, format!("({FIND_SCRIPT})({arg})")).await?;
    #[derive(Deserialize)]
    struct PageFind {
        count: Option<usize>,
        index: Option<i32>,
    }
    let parsed: PageFind = serde_json::from_str(&raw).unwrap_or(PageFind {
        count: None,
        index: None,
    });
    let count = parsed.count.unwrap_or(0).min(200);
    Ok(BrowserFindResult {
        count,
        // Page-controlled value — clamp to the reported range.
        index: parsed.index.unwrap_or(-1).clamp(-1, count as i32 - 1),
    })
}

// --- Saved login profiles ---

#[tauri::command]
pub fn browser_logins_list(
    app: AppHandle,
    origin: Option<String>,
) -> Result<Vec<browser_logins::LoginMeta>, String> {
    Ok(browser_logins::list(&app, origin.as_deref()))
}

#[tauri::command]
pub fn browser_login_update(
    app: AppHandle,
    id: String,
    username: Option<String>,
    submit: Option<bool>,
    remember_me: Option<bool>,
) -> Result<browser_logins::LoginMeta, String> {
    browser_logins::update(&app, &id, username, submit, remember_me)
}

#[tauri::command]
pub fn browser_login_delete(app: AppHandle, id: String) -> Result<(), String> {
    browser_logins::delete(&app, &id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturedLogin {
    /// `location.href` read in the same eval as the values — the pair
    /// can't drift across a navigation. `view.url()` is avoided entirely:
    /// wry unwraps WKWebView.URL, which is nil before the first commit
    /// (a refused dev server would abort the process on the spot).
    href: Option<String>,
    identity: Option<String>,
    password: Option<String>,
}

/// Read the credentials the user just typed on this page and save them as
/// a profile for the page's origin. The values cross page → Rust only.
#[tauri::command]
pub async fn browser_capture_login(
    window: Window,
    app: AppHandle,
    label: String,
) -> Result<browser_logins::LoginMeta, String> {
    let view = find_webview(&window, &label)?;
    let raw = eval_json(
        &view,
        format!("({LOGIN_FORM_SCRIPT})({{\"mode\":\"capture\"}})"),
    )
    .await?;
    let captured: CapturedLogin =
        serde_json::from_str(&raw).map_err(|_| "Couldn't read the login form".to_string())?;
    let origin = browser_logins::normalize_origin(&captured.href.unwrap_or_default())?;
    browser_logins::upsert_credentials(
        &app,
        &origin,
        &captured.identity.unwrap_or_default(),
        &captured.password.unwrap_or_default(),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFillResult {
    filled: Vec<String>,
    missing: Vec<String>,
    otp_required: bool,
    submitted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageFillResult {
    /// In-script origin gate tripped — the page moved between the
    /// location read and the fill eval.
    aborted: Option<bool>,
    filled: Option<Vec<serde_json::Value>>,
    missing: Option<Vec<serde_json::Value>>,
    otp_required: Option<bool>,
    submitted: Option<bool>,
}

/// Fill a saved login into the current page. The page's live origin must
/// match the profile's — checked here, then re-checked inside the fill
/// eval itself so a navigation in the gap can't steer credentials into a
/// different site. The password reaches only the eval script, never the
/// frontend.
#[tauri::command]
pub async fn browser_fill_login(
    window: Window,
    app: AppHandle,
    label: String,
    profile_id: Option<String>,
) -> Result<BrowserFillResult, String> {
    let view = find_webview(&window, &label)?;
    // location.href via eval — view.url() aborts the process on WKWebView
    // before the first commit (URL is nil there).
    let raw = eval_json(&view, "location.href".to_string()).await?;
    let href: String = serde_json::from_str(&raw).unwrap_or_default();
    let origin = browser_logins::normalize_origin(&href)?;
    let profile = match profile_id {
        Some(id) => browser_logins::get(&app, &id)
            .ok_or_else(|| "That login no longer exists".to_string())?,
        None => match browser_logins::for_origin(&app, &origin).as_slice() {
            [] => return Err("No saved login for this site".into()),
            [only] => only.clone(),
            _ => return Err("Pick a login to fill".into()),
        },
    };
    if origin != profile.origin {
        return Err("That login belongs to a different site".into());
    }
    let arg = serde_json::json!({
        "mode": "fill",
        "expectedOrigin": origin,
        "username": profile.username,
        "password": profile.password,
        "submit": profile.submit,
        "rememberMe": profile.remember_me,
    });
    // serde_json output is a valid JS object literal; U+2028/2029 are the
    // only JSON-legal characters that break older JS string parsing.
    let arg = serde_json::to_string(&arg)
        .map_err(|error| error.to_string())?
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    let raw = eval_json(&view, format!("({LOGIN_FORM_SCRIPT})({arg})")).await?;
    let parsed: PageFillResult =
        serde_json::from_str(&raw).map_err(|_| "Fill didn't report".to_string())?;
    if parsed.aborted.unwrap_or(false) {
        return Err("The page navigated — try again".into());
    }
    let strings = |values: Option<Vec<serde_json::Value>>| -> Vec<String> {
        values
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .take(20)
            .map(|value| clip_chars(&value, 120))
            .collect()
    };
    Ok(BrowserFillResult {
        filled: strings(parsed.filled),
        missing: strings(parsed.missing),
        otp_required: parsed.otp_required.unwrap_or(false),
        submitted: parsed.submitted.unwrap_or(false),
    })
}
