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
    fn new(kind: &'static str) -> Self {
        Self {
            kind,
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

#[tauri::command]
pub fn browser_open(
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
        .on_navigation(move |url| {
            let (can_back, can_forward) = match allowed_url(url, origin.as_deref()) {
                Ok(()) => {
                    let state = nav_app.state::<BrowserState>();
                    let mut guard = state.history.lock().unwrap();
                    let history = guard
                        .entry(key.clone())
                        .or_insert_with(|| History::new(url.as_str()));
                    history.push(url.as_str());
                    (history.can_back(), history.can_forward())
                }
                Err(reason) => {
                    emit(
                        &nav_app,
                        &nav_label,
                        &nav_window,
                        BrowserNotice {
                            kind: "blocked",
                            url: Some(url.as_str().chars().take(MAX_URL_LEN).collect()),
                            reason: Some(reason),
                            ..BrowserNotice::new("")
                        },
                    );
                    return false;
                }
            };
            emit(
                &nav_app,
                &nav_label,
                &nav_window,
                BrowserNotice {
                    kind: "navigate",
                    url: Some(url.as_str().chars().take(MAX_URL_LEN).collect()),
                    can_back,
                    can_forward,
                    ..BrowserNotice::new("")
                },
            );
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
                        ..BrowserNotice::new("")
                    },
                );
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            let kind = match payload.event() {
                PageLoadEvent::Started => "load-started",
                PageLoadEvent::Finished => "load-finished",
            };
            let (can_back, can_forward) = {
                let state = page_load_app.state::<BrowserState>();
                let key = history_key(&page_load_window, &page_load_label);
                let guard = state.history.lock().unwrap();
                guard
                    .get(&key)
                    .map(|history| (history.can_back(), history.can_forward()))
                    .unwrap_or((false, false))
            };
            emit(
                &page_load_app,
                webview.label(),
                &page_load_window,
                BrowserNotice {
                    kind,
                    url: Some(payload.url().as_str().chars().take(MAX_URL_LEN).collect()),
                    can_back,
                    can_forward,
                    ..BrowserNotice::new("")
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
                    ..BrowserNotice::new("")
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
                        ..BrowserNotice::new("")
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

#[tauri::command]
pub fn browser_set_visible(window: Window, label: String, visible: bool) -> Result<(), String> {
    let view = find_webview(&window, &label)?;
    if visible {
        view.show().map_err(|error| error.to_string())
    } else {
        view.hide().map_err(|error| error.to_string())
    }
}

/// Read the live location so the tab can tell "never loaded" apart from a
/// page that is merely slow — WKWebView shows nothing for a refused
/// connection, and WebView2's own error page still reports `about:blank`
/// for a short while. Async: the eval callback is delivered on the main
/// thread, so a synchronous command would deadlock waiting for it.
#[tauri::command]
pub async fn browser_probe(window: Window, label: String) -> Result<String, String> {
    let view = find_webview(&window, &label)?;
    let (tx, rx) = std::sync::mpsc::channel();
    view.eval_with_callback(
        "JSON.stringify({href:location.href,title:document.title,readyState:document.readyState})",
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
