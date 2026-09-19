//! Untrusted page preview hosted in a native child webview per browser tab.
//!
//! Archived browser capabilities adapted to a browser-owned raw Wry child.
//! The child has no Tauri protocols, initialization or command dispatcher.
//!
//! Remote pages have no app protocol or command dispatcher. Their sole IPC
//! message is a notification that this browser pane received focus; it grants
//! no filesystem, credential, agent, clipboard or other app access. Navigation
//! to app origins is refused, and popups/downloads are reported but denied.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use tauri::{utils::config::Color, AppHandle, Emitter, Manager, Runtime, Url, Window};
use wry::{NewWindowResponse, PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder};

struct BrowserInstance {
    view: WebView,
    alive: Rc<Cell<bool>>,
    // Drop the view before its persistent engine context, on the UI thread.
    _context: WebContext,
}
impl Drop for BrowserInstance {
    fn drop(&mut self) {
        self.alive.set(false);
    }
}
thread_local! {
    static VIEWS: RefCell<HashMap<String, BrowserInstance>> = RefCell::default();
    #[cfg(target_os = "linux")]
    static CONTAINERS: RefCell<HashMap<String, gtk::Fixed>> = RefCell::default();
}

async fn on_ui<T: Send + 'static>(
    window: Window,
    task: impl FnOnce(Window) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let owner = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(task(owner));
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
}

async fn with_view<T: Send + 'static>(
    window: Window,
    label: String,
    task: impl FnOnce(&WebView) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    on_ui(window, move |window| {
        VIEWS.with(|views| {
            let views = views.borrow();
            let instance = views
                .get(&history_key(window.label(), &label))
                .ok_or("Browser tab is no longer open")?;
            task(&instance.view)
        })
    })
    .await
}

pub const EVENT: &str = "monocode:browser";
const MAX_HISTORY: usize = 64;
const MAX_URL_LEN: usize = 8192;
const MAX_LABEL_LEN: usize = 120;
const MAX_TITLE_LEN: usize = 200;
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// App-owned origins are excluded even though this raw child has no app IPC.
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
/// context only. Focus/recorder-ready notifications carry no page data.
/// The trail is gated by `__monocodeRec` (toggled
/// via `browser_set_recording`). Only the trail persists in sessionStorage;
/// the app must acknowledge continuation after navigation or BFCache restore.
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
  const readTrail = () => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(TRAIL_KEY) || "[]");
      if (Array.isArray(saved)) return saved.filter(
        (e) =>
          e &&
          typeof e.text === "string" &&
          typeof e.at === "number" &&
          isFinite(e.at),
      ).slice(-TRAIL_CAP);
    } catch (e) {}
    return [];
  };
  let trail = readTrail();
  const continuationHint = () => {
    try { return sessionStorage.getItem(REC_KEY) === "1"; } catch (e) { return false; }
  };
  let awaitingResume = continuationHint();
  let pending = [];
  const saveTrail = () => {
    try {
      sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail.slice(-TRAIL_CAP)));
    } catch (e) {}
  };
  // Never revive a stale origin's recording flag after Back or a new mount.
  window.__monocodeRec = false;
  const step = (text) => {
    try {
      if (!window.__monocodeRec && !awaitingResume) return;
      // A prior opt-in is only a hint. Early redacted steps stay in a bounded
      // private buffer, never persisted/captured until the owner authorizes
      // same-origin continuation. A stop or fresh recording discards them.
      const target = window.__monocodeRec ? trail : pending;
      target.push({ at: Date.now(), text: String(text).slice(0, 240) });
      if (target.length > TRAIL_CAP) target.splice(0, target.length - TRAIL_CAP);
      if (window.__monocodeRec) saveTrail();
    } catch (e) {}
  };
  let lastNav = cleanUrl(location.href);
  // The record toggle: a fresh session clears the previous trail and opens
  // on the current page; stopping just drops the flag — the finished trail
  // stays readable until the next session or the webview dies. The app may
  // resume a same-origin document without clearing this session's trail.
  window.__monocodeSetRec = (on, resume = false) => {
    on = !!on;
    if (!on || !resume) pending.length = 0;
    awaitingResume = false;
    try { sessionStorage.setItem(REC_KEY, on ? "1" : "0"); } catch (e) {}
    if (on === window.__monocodeRec) return;
    window.__monocodeRec = on;
    if (on) {
      if (!resume) trail.length = 0;
      lastNav = cleanUrl(location.href);
      if (resume && pending.length) {
        trail.push(...pending);
        pending.length = 0;
        if (trail.length > TRAIL_CAP) trail.splice(0, trail.length - TRAIL_CAP);
        saveTrail();
      } else {
        step("Opened " + lastNav);
      }
    }
  };
  // BFCache can restore this document without re-running initialization.
  const ready = () => { try { window.ipc.postMessage("recording-ready"); } catch (e) {} };
  window.addEventListener("pagehide", () => {
    window.__monocodeRec = false;
    awaitingResume = false;
    pending.length = 0;
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    trail.splice(0, trail.length, ...readTrail());
    awaitingResume = continuationHint();
    step("Opened " + cleanUrl(location.href));
    ready();
  });
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
  ready();
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
async fn eval_json(window: Window, label: String, script: String) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    with_view(window, label, move |view| {
        view.evaluate_script_with_callback(&script, move |result| {
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(PROBE_TIMEOUT)
            .map_err(|_| "The page did not answer".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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
        let removed: Vec<_> = VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            let keys: Vec<_> = views
                .keys()
                .filter(|entry| entry.starts_with(&prefix))
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|entry| views.remove(&entry))
                .collect()
        });
        drop(removed);
        #[cfg(target_os = "linux")]
        CONTAINERS.with(|containers| {
            containers.borrow_mut().remove(&key);
        });
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
}

impl BrowserBounds {
    fn rect(&self, size: tauri::PhysicalSize<u32>) -> Result<Rect, String> {
        if ![self.x, self.y, self.width, self.height, self.viewport_width]
            .iter()
            .all(|v| v.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
            || self.viewport_width <= 0.0
            || size.width == 0
            || size.height == 0
        {
            return Err("Invalid browser bounds".into());
        }
        // Includes the app WebView zoom as well as the OS scale factor.
        let scale = f64::from(size.width) / self.viewport_width;
        let x = (self.x * scale).min(f64::from(size.width.saturating_sub(1)));
        let y = (self.y * scale).min(f64::from(size.height.saturating_sub(1)));
        Ok(Rect {
            position: tauri::PhysicalPosition::new(x, y).into(),
            size: tauri::PhysicalSize::new(
                (self.width * scale).min(f64::from(size.width) - x),
                (self.height * scale).min(f64::from(size.height) - y),
            )
            .into(),
        })
    }
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
    on_ui(window, move |window| {
        if !valid_label(&label) || label == window.label() {
            return Err("Invalid browser label".into());
        }
        let parsed = Url::parse(&url).map_err(|_| "Enter a valid URL".to_string())?;
        let origin = app_origin(&window);
        allowed_url(&parsed, origin.as_deref())?;

        let window_label = window.label().to_string();
        let key = history_key(&window_label, &label);
        let persist = persist.unwrap_or(true);

        // Idempotent open: a stale webview under the same label is replaced.
        let previous = VIEWS.with(|views| views.borrow_mut().remove(&key));
        drop(previous);

        let state = app.state::<BrowserState>();
        state
            .history
            .lock()
            .unwrap()
            .insert(key.clone(), History::new(parsed.as_str()));

        let alive = Rc::new(Cell::new(true));
        let cleanup_alive = alive.clone();
        let cleanup_key = key.clone();
        let created = (|| -> Result<(), String> {
            let focus_alive = alive.clone();
            let nav_alive = alive.clone();
            let popup_alive = alive.clone();
            let load_alive = alive.clone();
            let title_alive = alive.clone();
            let download_alive = alive.clone();
            let focus_app = app.clone();
            let focus_window = window_label.clone();
            let focus_label = label.clone();
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
            let title_label = label.clone();
            let download_app = app.clone();
            let download_window = window_label.clone();
            let download_label = label.clone();

            let data_dir = if persist {
                let dir = app
                    .path()
                    .app_local_data_dir()
                    .map_err(|e| e.to_string())?
                    .join("browser");
                #[cfg(not(target_os = "macos"))]
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                Some(dir)
            } else {
                None
            };
            let mut context = WebContext::new(data_dir);
            #[allow(unused_mut)]
            let mut builder = WebViewBuilder::new_with_web_context(&mut context)
                .with_url(parsed.as_str())
                .with_bounds(bounds.rect(window.inner_size().map_err(|e| e.to_string())?)?)
                .with_incognito(!persist)
                .with_devtools(true)
                .with_focused(false)
                .with_background_color(background.unwrap_or(Color(255, 255, 255, 255)).into())
                .with_initialization_script(PAGE_TAP_SCRIPT)
                .with_initialization_script(
                    r#"(() => {
          if (window.top !== window) return;
          const notify = event => { if (event.isTrusted) window.ipc.postMessage('focus'); };
          window.addEventListener('pointerdown', notify, true);
          window.addEventListener('focusin', notify, true);
        })()"#,
                )
                .with_ipc_handler(move |request| {
                    // Page-controlled notification, never a command or authorization.
                    if focus_alive.get()
                        && matches!(request.body().as_str(), "focus" | "recording-ready")
                    {
                        emit(
                            &focus_app,
                            &focus_label,
                            &focus_window,
                            BrowserNotice {
                                kind: if request.body() == "focus" {
                                    "focus"
                                } else {
                                    "recording-ready"
                                },
                                ..BrowserNotice::empty()
                            },
                        );
                    }
                })
                .with_navigation_handler(move |value| {
                    if !nav_alive.get() {
                        return false;
                    }
                    let Ok(url) = Url::parse(&value) else {
                        return false;
                    };
                    // Policy gate only. WKWebView reports subframe navigations here
                    // too and wry does not pass targetFrame, so this callback can't
                    // tell a main-frame commit from an iframe — history and the
                    // address bar update live in on_page_load, which is main-frame
                    // only. about:/blob:/data: are allowed for the pervasive
                    // srcdoc/blank iframe cases; they never gain invoke authority.
                    let verdict = match url.scheme() {
                        "http" | "https" => allowed_url(&url, nav_origin.as_deref()),
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
                .with_new_window_req_handler(move |value, _features| {
                    if !popup_alive.get() {
                        return NewWindowResponse::Deny;
                    }
                    let Ok(url) = Url::parse(&value) else {
                        return NewWindowResponse::Deny;
                    };
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
                .with_on_page_load_handler(move |event, value| {
                    if !load_alive.get() {
                        return;
                    }
                    // Page-load events are main-frame only on both engines, so this
                    // is where the committed URL is recorded and reported. Started
                    // carries the requested URL (early bar feedback); Finished
                    // carries the post-redirect URL and earns the history slot.
                    let Ok(url) = Url::parse(&value) else {
                        return;
                    };
                    let committed = matches!(url.scheme(), "http" | "https")
                        && allowed_url(&url, page_origin.as_deref()).is_ok();
                    let (can_back, can_forward) = {
                        let state = page_load_app.state::<BrowserState>();
                        let key = history_key(&page_load_window, &page_load_label);
                        let mut guard = state.history.lock().unwrap();
                        match event {
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
                            &page_load_label,
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
                        &page_load_label,
                        &page_load_window,
                        BrowserNotice {
                            kind: match event {
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
                .with_document_title_changed_handler(move |title| {
                    if !title_alive.get() {
                        return;
                    }
                    emit(
                        &title_app,
                        &title_label,
                        &title_window,
                        BrowserNotice {
                            kind: "title",
                            title: Some(title.chars().take(MAX_TITLE_LEN).collect()),
                            ..BrowserNotice::empty()
                        },
                    );
                })
                .with_download_started_handler(move |url, _path| {
                    if !download_alive.get() {
                        return false;
                    }
                    {
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

            #[cfg(target_os = "macos")]
            let dedicated = persist && dedicated_store_supported();
            #[cfg(target_os = "macos")]
            if dedicated {
                use wry::WebViewBuilderExtDarwin;
                builder = builder.with_data_store_identifier(BROWSER_STORE_ID);
            }
            #[cfg(not(target_os = "macos"))]
            let dedicated = persist;
            if dedicated {
                app.state::<BrowserState>()
                    .dedicated
                    .lock()
                    .unwrap()
                    .insert(key.clone());
            } else {
                app.state::<BrowserState>()
                    .dedicated
                    .lock()
                    .unwrap()
                    .remove(&key);
            }

            hook_window_close(&app, &window);
            #[cfg(not(target_os = "linux"))]
            let view = builder.build_as_child(&window).map_err(|e| e.to_string())?;
            #[cfg(target_os = "linux")]
            let view = {
                use wry::WebViewBuilderExtUnix;
                builder
                    .build_gtk(&browser_container(&window)?)
                    .map_err(|e| e.to_string())?
            };
            VIEWS.with(|views| {
                views.borrow_mut().insert(
                    key,
                    BrowserInstance {
                        view,
                        alive,
                        _context: context,
                    },
                )
            });
            Ok(())
        })();
        if created.is_err() {
            cleanup_alive.set(false);
            state.history.lock().unwrap().remove(&cleanup_key);
            state.dedicated.lock().unwrap().remove(&cleanup_key);
        }
        created
    })
    .await
}

#[tauri::command]
pub async fn browser_close(window: Window, app: AppHandle, label: String) -> Result<(), String> {
    on_ui(window, move |window| {
        let key = history_key(window.label(), &label);
        let previous = VIEWS.with(|views| views.borrow_mut().remove(&key));
        drop(previous);
        let state = app.state::<BrowserState>();
        state.history.lock().unwrap().remove(&key);
        state.dedicated.lock().unwrap().remove(&key);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn browser_navigate(window: Window, label: String, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Enter a valid URL")?;
    allowed_url(&parsed, app_origin(&window).as_deref())?;
    with_view(window, label, move |view| {
        view.load_url(parsed.as_str()).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn browser_reload(window: Window, label: String) -> Result<(), String> {
    with_view(window, label, |view| {
        view.reload().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn browser_go_back(window: Window, label: String) -> Result<(), String> {
    with_view(window, label, |view| {
        view.evaluate_script("history.back()")
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn browser_go_forward(window: Window, label: String) -> Result<(), String> {
    with_view(window, label, |view| {
        view.evaluate_script("history.forward()")
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn browser_set_bounds(
    window: Window,
    label: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let rect = bounds.rect(window.inner_size().map_err(|e| e.to_string())?)?;
    with_view(window, label, move |view| {
        view.set_bounds(rect).map_err(|e| e.to_string())
    })
    .await
}

/// The shell follows theme flips; an open webview's swap-flash color is
/// only as fresh as its last update — cheap to keep in step.
#[tauri::command]
pub async fn browser_set_background(
    window: Window,
    label: String,
    color: Color,
) -> Result<(), String> {
    with_view(window, label, move |view| {
        view.set_background_color(color.into())
            .map_err(|e| e.to_string())
    })
    .await
}

/// Hiding a child webview suspends it — WKWebView stalls for a beat
/// re-compositing on the next show, which read as the preview freezing
/// whenever a tab switch hid and restored it. Instead "hidden" parks the
/// view offscreen at its current size: nothing suspends, no relayout
/// runs, and the next set_bounds puts it back instantly. `visible: true`
/// is a no-op — the bounds sync that always follows restores position.
#[tauri::command]
pub async fn browser_set_visible(
    window: Window,
    label: String,
    visible: bool,
) -> Result<(), String> {
    if visible {
        return Ok(());
    }
    with_view(window, label, |view| {
        let bounds = view.bounds().map_err(|e| e.to_string())?;
        view.set_bounds(Rect {
            position: tauri::PhysicalPosition::new(-32_768, 0).into(),
            size: bounds.size,
        })
        .map_err(|e| e.to_string())
    })
    .await
}

/// Flip the page-side steps recorder on or off; returns whether the page
/// actually has the hook (a page where the init script can't run — e.g.
/// still on its first load — silently has no flag otherwise, and the
/// toolbar indicator would lie). Bind the queued evaluation to the intended
/// origin; a navigation must not turn a different page's recording on. Async
/// for the same reason `browser_probe` is: the eval callback arrives on
/// the main thread.
#[tauri::command]
pub async fn browser_set_recording(
    window: Window,
    label: String,
    on: bool,
    expected_origin: String,
    resume: bool,
) -> Result<bool, String> {
    let origin = Url::parse(&expected_origin).map_err(|_| "Invalid recording origin")?;
    if !matches!(origin.scheme(), "http" | "https")
        || origin.origin().ascii_serialization() != expected_origin
    {
        return Err("Invalid recording origin".into());
    }
    let expected = serde_json::to_string(&expected_origin).map_err(|e| e.to_string())?;
    let raw = eval_json(
        window,
        label,
        format!(
            "!!(location.origin === {expected} && window.__monocodeSetRec && (window.__monocodeSetRec({on}, {resume}), true))"
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
    eval_json(
        window,
        label,
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
fn start_screenshot(
    view: &WebView,
    tx: std::sync::mpsc::Sender<Option<Vec<u8>>>,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use wry::WebViewExtMacOS;

    {
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
            view.webview()
                .takeSnapshotWithConfiguration_completionHandler(None, &block);
        }
    }
    Ok(())
}

/// WebView2's CapturePreview renders the viewport into a stream as PNG.
#[cfg(windows)]
fn start_screenshot(
    view: &WebView,
    tx: std::sync::mpsc::Sender<Option<Vec<u8>>>,
) -> Result<(), String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows61::Win32::System::Com::{IStream, STREAM_SEEK_SET};
    use windows61::Win32::UI::Shell::SHCreateMemStream;

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
            if out.len() + read as usize > MAX_SCREENSHOT_BYTES {
                return None;
            }
            out.extend_from_slice(&buf[..read as usize]);
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    use wry::WebViewExtWindows;
    unsafe {
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
        let started = view.controller().CoreWebView2().and_then(|webview| {
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
    }
    Ok(())
}

/// No snapshot API wired up for this platform — text capture still works.
#[cfg(not(any(target_os = "macos", windows)))]
fn start_screenshot(
    _view: &WebView,
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
    let (page_tx, page_rx) = std::sync::mpsc::channel();
    let (shot_tx, shot_rx) = std::sync::mpsc::channel();
    let shot_detail = with_view(window, label, move |view| {
        view.evaluate_script_with_callback(SUMMARY_SCRIPT, move |result| {
            let _ = page_tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        Ok(start_screenshot(view, shot_tx).err())
    })
    .await?;

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

    let parsed = summary.as_deref().map(|raw| {
        if raw.len() <= 256 * 1024 {
            serde_json::from_str::<PageSummary>(raw).ok()
        } else {
            None
        }
    });
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
            at: entry
                .at
                .filter(|value| {
                    value.is_finite() && (0.0..=8_640_000_000_000_000.0).contains(value)
                })
                .unwrap_or(0.0),
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
        (None, None) => (None, Some("Screenshot unavailable".to_string())),
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
pub async fn browser_devtools(
    window: Window,
    label: String,
    open: Option<bool>,
) -> Result<bool, String> {
    with_view(window, label, move |view| {
        let next = open.unwrap_or_else(|| !view.is_devtools_open());
        if next {
            view.open_devtools();
        } else {
            view.close_devtools();
        }
        Ok(next)
    })
    .await
}

/// Clear the browser profile's site data (cookies, storage). Only a tab
/// backed by the dedicated store may clear it — on older macOS persistent
/// tabs share the app shell's default data store, and clearing that would
/// wipe app settings too.
#[tauri::command]
pub async fn browser_clear_data(
    window: Window,
    app: AppHandle,
    label: String,
) -> Result<(), String> {
    let key = history_key(window.label(), &label);
    with_view(window, label, move |view| {
        if !app
            .state::<BrowserState>()
            .dedicated
            .lock()
            .unwrap()
            .contains(&key)
        {
            return Err("Only a persistent browser tab has its own data to clear".into());
        }
        view.clear_all_browsing_data().map_err(|e| e.to_string())
    })
    .await
}

/// Copy a screenshot of the visible page to the system clipboard. Same
/// platform capture as `browser_capture`, minus the DOM summary.
#[tauri::command]
pub async fn browser_copy_screenshot(
    window: Window,
    app: AppHandle,
    label: String,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    with_view(window, label, move |view| start_screenshot(view, tx)).await?;
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
    let arg = serde_json::json!({
        "query": query.chars().take(200).collect::<String>(),
        "forward": forward.unwrap_or(true),
    });
    let arg = serde_json::to_string(&arg)
        .map_err(|error| error.to_string())?
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    let raw = eval_json(window, label, format!("({FIND_SCRIPT})({arg})")).await?;
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

#[tauri::command]
pub fn browser_read_clipboard(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn browser_container(window: &Window) -> Result<gtk::Fixed, String> {
    use gtk::prelude::*;
    CONTAINERS.with(|containers| {
        if let Some(fixed) = containers.borrow().get(window.label()) {
            return Ok(fixed.clone());
        }
        let vbox = window.default_vbox().map_err(|e| e.to_string())?;
        let child = vbox
            .children()
            .into_iter()
            .next()
            .ok_or("Missing main webview")?;
        vbox.remove(&child);
        let overlay = gtk::Overlay::new();
        overlay.add(&child);
        let fixed = gtk::Fixed::new();
        fixed.set_hexpand(true);
        fixed.set_vexpand(true);
        overlay.add_overlay(&fixed);
        vbox.pack_start(&overlay, true, true, 0);
        overlay.show_all();
        containers
            .borrow_mut()
            .insert(window.label().to_string(), fixed.clone());
        Ok(fixed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_page_policy_excludes_app_origins_credentials_and_protocols() {
        for value in [
            "file:///tmp/private",
            "tauri://localhost",
            "https://tauri.localhost",
            "http://asset.localhost",
            "https://user:password@example.test",
            "http://localhost:1420/path",
        ] {
            assert!(
                allowed_url(&Url::parse(value).unwrap(), Some("http://localhost:1420")).is_err(),
                "{value}"
            );
        }
        for value in ["http://localhost:3000/app", "https://example.test"] {
            assert!(
                allowed_url(&Url::parse(value).unwrap(), Some("http://localhost:1420")).is_ok(),
                "{value}"
            );
        }
        assert_ne!(
            history_key("main", "browser-1"),
            history_key("second", "browser-1")
        );
        assert!(!valid_label("../main"));
    }

    #[test]
    fn browser_bounds_follow_webview_zoom_and_stay_inside_the_window() {
        let mut bounds = BrowserBounds {
            x: 100.0,
            y: 50.0,
            width: 300.0,
            height: 900.0,
            viewport_width: 800.0,
        };
        let size = tauri::PhysicalSize::new(1600, 1200);
        let rect = bounds.rect(size).unwrap();
        assert_eq!(
            rect.position.to_physical::<f64>(1.0),
            tauri::PhysicalPosition::new(200.0, 100.0)
        );
        assert_eq!(
            rect.size.to_physical::<f64>(1.0),
            tauri::PhysicalSize::new(600.0, 1100.0)
        );
        bounds.x = f64::NAN;
        assert!(bounds.rect(size).is_err());
        bounds.x = -1.0;
        assert!(bounds.rect(size).is_err());
        bounds.x = 0.0;
        bounds.viewport_width = 0.0;
        assert!(bounds.rect(size).is_err());
    }

    #[test]
    fn browser_history_is_bounded_and_follows_adjacent_back_and_forward_visits() {
        let mut history = History::new("https://example.test/0");
        for i in 1..100 {
            history.push(&format!("https://example.test/{i}"));
        }
        assert_eq!(history.urls.len(), MAX_HISTORY);
        assert!(history.can_back());
        assert!(!history.can_forward());
        history.push("https://example.test/98");
        assert!(history.can_forward());
        history.push("https://example.test/99");
        assert!(!history.can_forward());
        history.push("https://example.test/new");
        assert_eq!(history.urls.len(), MAX_HISTORY);
    }
}
