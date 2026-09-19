//! Confluence Cloud reads on the shared Atlassian connection. Credentials stay on the app host.
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::jira::{require_config, HttpError, JiraConfig};

const MAX_RESPONSE: u64 = 2 * 1024 * 1024;
const PAGE_LIMIT: usize = 25;
static BACKOFF: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn http_error(status: u16) -> String {
    match status {
        401 => "Atlassian credentials expired or are invalid. Reconnect in Settings.".into(),
        403 => "Confluence denied access. Check the account's Confluence permissions.".into(),
        404 => "Confluence content is unavailable. Refresh or choose another page.".into(),
        429 => "Confluence is rate limiting requests. Wait before retrying.".into(),
        _ => format!("Confluence request failed (HTTP {status}). Check the connection and retry."),
    }
}

fn wiki_request(
    config: &JiraConfig,
    path: &str,
    query: &[(&str, String)],
) -> Result<Value, HttpError> {
    serde_json::from_slice(&wiki_bytes(config, path, query)?)
        .map_err(|_| HttpError::other("Confluence returned an invalid response"))
}

fn wiki_bytes(
    config: &JiraConfig,
    path: &str,
    query: &[(&str, String)],
) -> Result<Vec<u8>, HttpError> {
    if BACKOFF
        .lock()
        .map_err(|_| HttpError::other("Confluence request state unavailable"))?
        .as_ref()
        .is_some_and(|(site, until)| site == &config.site && *until > Instant::now())
    {
        return Err(HttpError::other(
            "Confluence requests are paused after a service error. Wait before retrying.",
        ));
    }
    let authorization = base64::engine::general_purpose::STANDARD
        .encode(format!("{}:{}", config.email, config.token));
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .redirects(0)
        .build();
    let mut req = agent
        .get(&format!("{}/wiki/rest/api/{path}", config.site))
        .set("Authorization", &format!("Basic {authorization}"))
        .set("Accept", "application/json");
    for (key, value) in query {
        req = req.query(key, value);
    }
    let response = match req.call() {
        Ok(response) if response.status() == 200 => response,
        Ok(response) | Err(ureq::Error::Status(_, response)) => {
            let status = response.status();
            if status == 429 || status >= 500 {
                let seconds = response
                    .header("Retry-After")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30)
                    .clamp(1, 300);
                *BACKOFF
                    .lock()
                    .map_err(|_| HttpError::other("Confluence request state unavailable"))? =
                    Some((
                        config.site.clone(),
                        Instant::now() + Duration::from_secs(seconds),
                    ));
            }
            return Err(HttpError::status(http_error(status), status));
        }
        Err(_) => {
            return Err(HttpError::other(
                "Cannot reach Confluence Cloud. Check your connection and retry.",
            ))
        }
    };
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| HttpError::other("Cannot read Confluence response"))?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err(HttpError::other(
            "Confluence response is too large. Choose a narrower search.",
        ));
    }
    Ok(bytes)
}

/// Verify the shared credentials can read Confluence on this site.
pub(crate) fn probe(config: &JiraConfig) -> Result<Value, HttpError> {
    wiki_request(config, "user/current", &[])
}

/// Configs saved before capability tracking have an empty list; treat them as
/// unknown and let the request decide instead of blocking them.
fn require_confluence(config: &JiraConfig) -> Result<(), String> {
    if !config.capabilities.is_empty() && !config.capabilities.iter().any(|cap| cap == "Confluence")
    {
        return Err(
            "Confluence is not available on this Atlassian connection. Reconnect in Settings."
                .into(),
        );
    }
    Ok(())
}

/// The shared Jira config's errors say "Jira"; reword them for Confluence UI.
fn confluence_config(app: &AppHandle, site: &str, account_id: &str) -> Result<JiraConfig, String> {
    let config = require_config(app, site).map_err(|error| error.replace("Jira", "Atlassian"))?;
    config.require_account(account_id)?;
    require_confluence(&config)?;
    Ok(config)
}

fn cql_string(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 200 {
        return Err("Search text must be 1-200 characters".into());
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn search_cql(query: &str, space: &str) -> Result<String, String> {
    let mut parts = vec!["type = page AND status = current".to_string()];
    let space = space.trim();
    if !space.is_empty() {
        // Personal space keys are `~<accountId>` and contain a colon.
        if space.len() > 64
            || !space
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '~' | ':'))
        {
            return Err("Choose a valid Confluence space".into());
        }
        parts.push(format!("space = {}", cql_string(space)?));
    }
    let query = query.trim();
    if !query.is_empty() {
        let text = cql_string(query)?;
        parts.push(format!("(title ~ {text} OR text ~ {text})"));
        return Ok(parts.join(" AND "));
    }
    Ok(format!(
        "{} ORDER BY lastmodified DESC",
        parts.join(" AND ")
    ))
}

/// Pull the pagination token out of a provider `next` link; the URL itself
/// never reaches the WebView. Returns the parameter name and decoded value —
/// resending the raw value would percent-encode it a second time.
fn next_cursor(page: &Value) -> Option<(&'static str, String)> {
    let next = page["_links"]["next"].as_str().unwrap_or_default();
    let base = tauri::Url::parse("https://confluence.invalid").ok()?;
    let url = base.join(next).ok()?;
    let (mut cursor, mut start) = (None, None);
    for (key, value) in url.query_pairs() {
        if key == "cursor" {
            cursor = Some(value.into_owned());
        } else if key == "start" {
            start = Some(value.into_owned());
        }
    }
    // CQL search paginates with `cursor`; `start` is the older fallback.
    cursor
        .map(|value| ("cursor", value))
        .or_else(|| start.map(|value| ("start", value)))
}

#[tauri::command]
pub async fn confluence_spaces(
    app: AppHandle,
    site: String,
    account_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = confluence_config(&app, &site, &account_id)?;
        // No `type` filter: personal (`~`-keyed) spaces hold pages too.
        let page = wiki_request(
            &config,
            "space",
            &[("limit", "100".into()), ("status", "current".into())],
        )?;
        let spaces: Vec<Value> = page["results"]
            .as_array()
            .ok_or("Confluence returned an invalid space list")?
            .iter()
            .take(100)
            .filter_map(|space| {
                let key = space["key"].as_str()?;
                Some(json!({
                    "key": key,
                    "name": space["name"].as_str().unwrap_or(key),
                }))
            })
            .collect();
        confluence_config(&app, &site, &account_id)?;
        Ok(json!({ "spaces": spaces }))
    })
    .await
    .map_err(|_| "Confluence spaces task failed")?
}

#[tauri::command]
pub async fn confluence_search(
    app: AppHandle,
    site: String,
    account_id: String,
    query: String,
    space: String,
    cursor: String,
    cursor_param: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = confluence_config(&app, &site, &account_id)?;
        let cql = search_cql(&query, &space)?;
        let cursor = cursor.trim();
        if cursor.len() > 2048 || cursor.chars().any(char::is_control) {
            return Err("Confluence returned an invalid page cursor".into());
        }
        let mut params = vec![
            ("cql", cql),
            ("limit", PAGE_LIMIT.to_string()),
            ("expand", "space,version".into()),
        ];
        if !cursor.is_empty() {
            // The previous response names its own pagination parameter; older
            // sites still paginate `content/search` with `start`. `nextParam`
            // is authoritative — anything else defaults to the CQL `cursor`.
            let key = match cursor_param.trim() {
                known @ ("cursor" | "start") => known,
                _ => "cursor",
            };
            params.push((key, cursor.to_string()));
        }
        let page = wiki_request(&config, "content/search", &params)?;
        if !page["results"].is_array() {
            return Err("Confluence returned an invalid search result".into());
        }
        confluence_config(&app, &site, &account_id)?;
        let next = next_cursor(&page);
        Ok(json!({
            "results": page["results"],
            "next": next.as_ref().map(|(_, value)| value.as_str()).unwrap_or_default(),
            "nextParam": next.map(|(key, _)| key).unwrap_or_default(),
        }))
    })
    .await
    .map_err(|_| "Confluence search task failed")?
}

#[tauri::command]
pub async fn confluence_page(
    app: AppHandle,
    site: String,
    account_id: String,
    id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = confluence_config(&app, &site, &account_id)?;
        if id.is_empty() || id.len() > 30 || !id.bytes().all(|b| b.is_ascii_digit()) {
            return Err("Invalid Confluence page identity".into());
        }
        let page = wiki_request(
            &config,
            &format!("content/{id}"),
            &[("expand", "body.storage,space,version".into())],
        )
        .map_err(String::from)?;
        confluence_config(&app, &site, &account_id)?;
        if page["id"].as_str() != Some(&id) {
            return Err("Confluence page identity changed. Refresh and reselect the page.".into());
        }
        Ok(page)
    })
    .await
    .map_err(|_| "Confluence page task failed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cql_is_built_from_bounded_parts_never_raw_text() {
        assert_eq!(
            search_cql("", "ENG").unwrap(),
            "type = page AND status = current AND space = \"ENG\" ORDER BY lastmodified DESC"
        );
        assert_eq!(
            search_cql("auth flow", "").unwrap(),
            "type = page AND status = current AND (title ~ \"auth flow\" OR text ~ \"auth flow\")"
        );
        assert_eq!(
            search_cql("a\"b\\c", "TEAM").unwrap(),
            "type = page AND status = current AND space = \"TEAM\" AND (title ~ \"a\\\"b\\\\c\" OR text ~ \"a\\\"b\\\\c\")"
        );
        assert!(search_cql("", "bad space!\"").is_err());
        assert!(search_cql(&"x".repeat(201), "").is_err());
    }

    #[test]
    fn next_cursor_reads_and_decodes_only_the_pagination_parameter() {
        let page =
            json!({"_links":{"next":"/rest/api/search?cql=type%3Dpage&cursor=abc%2B123%3D"}});
        assert_eq!(next_cursor(&page), Some(("cursor", "abc+123=".into())));
        let legacy = json!({"_links":{"next":"/rest/api/content/search?start=25&cql=x"}});
        assert_eq!(next_cursor(&legacy), Some(("start", "25".into())));
        assert_eq!(next_cursor(&json!({"_links":{}})), None);
        let hostile = json!({"_links":{"next":"https://evil.test/?cursor=abc"}});
        assert_eq!(next_cursor(&hostile), Some(("cursor", "abc".into())));
    }
}
