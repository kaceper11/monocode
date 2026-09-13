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
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Runtime, Url, WebviewUrl,
    Window,
};

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
/// A full-pane PNG base64'd over IPC and into agent context — cap it.
const MAX_SCREENSHOT_BYTES: usize = 4 * 1024 * 1024;

/// Page-local console ring buffer. Injected before any page script runs;
/// it writes into the page's own context only — nothing calls back into
/// the app, so the security boundary is unchanged.
const CONSOLE_TAP_SCRIPT: &str = r#"(() => {
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
      let label =
        (el.innerText || el.value || el.placeholder ||
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
  return {
    url: String(location.href || "").slice(0, 8192),
    title: String(document.title || "").slice(0, 200),
    text: String(text).slice(0, 6000),
    controls,
    console: log,
  };
})()"#;

#[derive(Default)]
pub struct BrowserState {
    history: Mutex<HashMap<String, History>>,
    hooked: Mutex<HashSet<String>>,
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
) -> Result<(), String> {
    if !valid_label(&label) {
        return Err("Invalid browser label".into());
    }
    let parsed = Url::parse(&url).map_err(|_| "Enter a valid URL".to_string())?;
    let origin = app_origin(&window);
    allowed_url(&parsed, origin.as_deref())?;

    let window_label = window.label().to_string();
    let key = history_key(&window_label, &label);
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

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed.clone()))
        .incognito(true)
        .devtools(false)
        .focused(false)
        .initialization_script(CONSOLE_TAP_SCRIPT)
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
    state
        .history
        .lock()
        .unwrap()
        .remove(&history_key(window.label(), &label));
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
    let (tx, rx) = std::sync::mpsc::channel();
    view.eval_with_callback(
        "({href:location.href,title:document.title,readyState:document.readyState})",
        move |result| {
            let _ = tx.send(result);
        },
    )
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(PROBE_TIMEOUT)
            .map_err(|_| "Probe timed out".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleLine {
    level: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapture {
    url: String,
    title: Option<String>,
    text: Option<String>,
    controls: Vec<String>,
    console: Vec<BrowserConsoleLine>,
    /// Base64 PNG of the visible page, when the platform supports it.
    screenshot: Option<String>,
    /// Why a piece is missing, when it is.
    detail: Option<String>,
}

#[derive(Deserialize)]
struct PageSummary {
    url: Option<String>,
    title: Option<String>,
    text: Option<String>,
    controls: Option<Vec<serde_json::Value>>,
    console: Option<Vec<PageConsoleLine>>,
}

#[derive(Deserialize)]
struct PageConsoleLine {
    level: Option<String>,
    text: Option<String>,
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
        screenshot: screenshot_b64,
        detail,
    })
}
