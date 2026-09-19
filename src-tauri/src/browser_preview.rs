//! Small companion preview. Neither child is an application/session window.
//! Remote pages cannot navigate to the trusted app origin or invoke commands.
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl,
    WindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

const BAR_HEIGHT: f64 = 88.0;
const EVENT: &str = "browser-preview-state";

fn allowed_url(url: &Url, app_url: &Url) -> Result<(), String> {
    if url.as_str().len() > 8192 || !matches!(url.scheme(), "http" | "https") {
        return Err("Enter an HTTP or HTTPS address.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Addresses containing credentials are not supported.".into());
    }
    if matches!(
        url.host_str(),
        Some("tauri.localhost" | "asset.localhost" | "ipc.localhost")
    ) || url.origin() == app_url.origin()
        || (app_url.scheme() == "http"
            && url.port_or_known_default() == app_url.port_or_known_default()
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        return Err("MonoCode's own address cannot be opened in the preview.".into());
    }
    Ok(())
}

fn notice(app: &AppHandle, toolbar: &str, url: Option<&str>, message: &str) {
    let _ = app.emit_to(
        toolbar,
        EVENT,
        serde_json::json!({ "url": url, "message": message }),
    );
}

#[tauri::command]
pub async fn browser_preview_open(owner: tauri::WebviewWindow) -> Result<(), String> {
    let app = owner.app_handle();
    let label = format!("preview-{}", owner.label());
    if let Some(window) = app.get_window(&label) {
        window.unminimize().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let app_url = owner.url().map_err(|e| e.to_string())?;
    let toolbar_label = format!("{label}-toolbar");
    let page_label = format!("{label}-page");
    let window = WindowBuilder::new(app, &label)
        .title("Browser preview · MonoCode")
        .inner_size(1000.0, 720.0)
        .min_inner_size(640.0, 400.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let size = window
            .inner_size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
        let toolbar_url = app_url
            .join("/browser-preview.html")
            .map_err(|e| e.to_string())?;
        let toolbar = window
            .add_child(
                WebviewBuilder::new(
                    &toolbar_label,
                    WebviewUrl::App("browser-preview.html".into()),
                )
                .on_navigation(move |url| url == &toolbar_url),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(size.width, BAR_HEIGHT),
            )
            .map_err(|e| e.to_string())?;
        let nav_app = app.clone();
        let nav_toolbar = toolbar_label.clone();
        let load_app = app.clone();
        let load_toolbar = toolbar_label.clone();
        let popup_app = app.clone();
        let popup_toolbar = toolbar_label.clone();
        let download_app = app.clone();
        let download_toolbar = toolbar_label.clone();
        let page = window.add_child(
            WebviewBuilder::new(&page_label, WebviewUrl::External(Url::parse("about:blank").unwrap()))
                .incognito(true)
                .on_navigation(move |url| {
                    if url.as_str() == "about:blank" { return true; }
                    match allowed_url(url, &app_url) {
                        Ok(()) => true,
                        Err(error) => { notice(&nav_app, &nav_toolbar, None, &error); false }
                    }
                })
                .on_page_load(move |view, payload| {
                    // Read the native top-level URL; do not trust page-script messages.
                    let url = view.url().ok();
                    let message = match payload.event() {
                        PageLoadEvent::Started => "Loading…",
                        PageLoadEvent::Finished => "Preview runs on this computer. WSL localhost access depends on your network setup.",
                    };
                    notice(&load_app, &load_toolbar, url.as_ref().map(Url::as_str), message);
                })
                .on_new_window(move |_, _| {
                    notice(&popup_app, &popup_toolbar, None, "Popups are blocked. Use Open externally for this workflow.");
                    NewWindowResponse::Deny
                })
                .on_download(move |_, _| {
                    notice(&download_app, &download_toolbar, None, "Downloads are blocked. Use Open externally to download.");
                    false
                }),
            LogicalPosition::new(0.0, BAR_HEIGHT), LogicalSize::new(size.width, (size.height - BAR_HEIGHT).max(1.0)),
        ).map_err(|e| e.to_string())?;
        let resize_window = window.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
            ) {
                if let (Ok(size), Ok(scale)) =
                    (resize_window.inner_size(), resize_window.scale_factor())
                {
                    let size = size.to_logical::<f64>(scale);
                    let _ = toolbar.set_size(LogicalSize::new(size.width, BAR_HEIGHT));
                    let _ = page.set_size(LogicalSize::new(
                        size.width,
                        (size.height - BAR_HEIGHT).max(1.0),
                    ));
                }
            }
        });
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = window.destroy();
    }
    result
}

#[tauri::command]
pub async fn browser_preview_action(
    view: Webview,
    action: String,
    url: Option<String>,
) -> Result<(), String> {
    let window = view.window();
    // Only this companion's trusted toolbar can control its page.
    if !window.label().starts_with("preview-")
        || view.label() != format!("{}-toolbar", window.label())
    {
        return Err("Browser controls are only available in the preview toolbar.".into());
    }
    let page = view
        .app_handle()
        .get_webview(&format!("{}-page", window.label()))
        .ok_or("Preview is closed.")?;
    let app_url = view.url().map_err(|e| e.to_string())?;
    match action.as_str() {
        "navigate" => {
            let url = Url::parse(url.as_deref().unwrap_or_default())
                .map_err(|_| "Enter a complete HTTP or HTTPS address.")?;
            allowed_url(&url, &app_url)?;
            page.navigate(url).map_err(|e| e.to_string())
        }
        "back" => page.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => page.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => page.reload().map_err(|e| e.to_string()),
        "external" => {
            let url = page.url().map_err(|e| e.to_string())?;
            allowed_url(&url, &app_url)?;
            view.app_handle()
                .opener()
                .open_url(url.to_string(), None::<&str>)
                .map_err(|e| e.to_string())
        }
        _ => Err("Unknown browser action.".into()),
    }
}

pub fn close_for_owner(app: &AppHandle, owner: &str) {
    if let Some(window) = app.get_window(&format!("preview-{owner}")) {
        let _ = window.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_cannot_reach_app_authority_or_launch_protocols() {
        let app = Url::parse("http://localhost:1420/").unwrap();
        for raw in [
            "http://localhost:1420/",
            "http://127.0.0.1:1420/",
            "http://[::1]:1420/",
            "https://tauri.localhost/",
            "http://asset.localhost/",
            "http://ipc.localhost/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "https://user:secret@example.com/",
        ] {
            assert!(
                allowed_url(&Url::parse(raw).unwrap(), &app).is_err(),
                "{raw}"
            );
        }
        for raw in [
            "http://localhost:3000/",
            "http://127.0.0.1:5173/",
            "https://example.com/path?q=test#section",
        ] {
            assert!(
                allowed_url(&Url::parse(raw).unwrap(), &app).is_ok(),
                "{raw}"
            );
        }
        let production = Url::parse("tauri://localhost/").unwrap();
        assert!(allowed_url(
            &Url::parse("tauri://localhost/index.html").unwrap(),
            &production
        )
        .is_err());
    }
}
