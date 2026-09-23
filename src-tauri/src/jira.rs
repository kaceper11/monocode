use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const MAX_RESPONSE: u64 = 2 * 1024 * 1024;
static BACKOFF: Mutex<Option<(String, Instant)>> = Mutex::new(None);

static CONFIG_WRITES: crate::integration_config::ConfigWrites =
    crate::integration_config::ConfigWrites::new();

#[derive(Deserialize, Serialize)]
pub(crate) struct JiraConfig {
    pub(crate) site: String,
    pub(crate) email: String,
    pub(crate) token: String,
    account: String,
    /// Atlassian products verified for this credential. Empty means the
    /// connection predates capability tracking — treated as unknown.
    #[serde(default)]
    pub(crate) capabilities: Vec<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JiraStatus {
    connected: bool,
    site: String,
    account: String,
    account_id: String,
    capabilities: Vec<String>,
}

impl JiraConfig {
    // Bind reads to the credential login, never the non-unique display name.
    fn account_id(&self) -> String {
        format!("email:{}", self.email.trim())
    }

    pub(crate) fn require_account(&self, expected: &str) -> Result<(), String> {
        if expected != self.account_id() {
            return Err("The Atlassian account changed. Refresh and reselect the item.".into());
        }
        Ok(())
    }

    fn status(&self) -> JiraStatus {
        JiraStatus {
            connected: true,
            site: self.site.clone(),
            account: self.account.clone(),
            account_id: self.account_id(),
            capabilities: self.capabilities.clone(),
        }
    }
}

fn normalize_site(site: &str) -> Result<String, String> {
    let url = tauri::Url::parse(site.trim()).map_err(|_| "Enter a Jira Cloud HTTPS site URL")?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https"
        || !host.ends_with(".atlassian.net")
        || host == "atlassian.net"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Use https://your-site.atlassian.net. Jira Server/Data Center is not supported.".into(),
        );
    }
    Ok(format!("https://{host}"))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate Jira settings")?
        .join("jira-config.json"))
}

fn read_config(app: &AppHandle) -> Result<Option<JiraConfig>, String> {
    match fs::read(config_path(app)?) {
        Ok(bytes) => {
            let mut config: JiraConfig = serde_json::from_slice(&bytes)
                .map_err(|_| "Jira settings are invalid. Reconnect in Settings.")?;
            config.site = normalize_site(&config.site)?;
            Ok(Some(config))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read Jira settings".into()),
    }
}

pub(crate) fn require_config(app: &AppHandle, site: &str) -> Result<JiraConfig, String> {
    let config = read_config(app)?.ok_or("Connect Jira Cloud in Settings")?;
    if config.site != normalize_site(site)? {
        return Err("The Jira connection changed. Refresh the Inbox before retrying.".into());
    }
    Ok(config)
}

#[tauri::command(async)]
pub fn jira_status(app: AppHandle) -> Result<JiraStatus, String> {
    Ok(read_config(&app)?.map(|c| c.status()).unwrap_or_default())
}

#[tauri::command]
pub async fn jira_set_config(
    app: AppHandle,
    site: String,
    email: String,
    token: String,
) -> Result<JiraStatus, String> {
    let generation = CONFIG_WRITES.begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_path(&app)?;
        if token.is_empty() {
            CONFIG_WRITES.commit(generation, &path, None)?;
            let _ = app.emit("monocode:jira-change", ());
            return Ok(JiraStatus::default());
        }
        if email.trim().is_empty()
            || email.contains([':', '\r', '\n'])
            || token.trim().is_empty()
            || token.len() > 4096
        {
            return Err("Enter your Atlassian email and API token".into());
        }
        let mut config = JiraConfig {
            site: normalize_site(&site)?,
            email: email.trim().into(),
            token: token.trim().into(),
            account: String::new(),
            capabilities: Vec::new(),
        };
        // A 200 with a degenerate body is inconclusive, not definitive — treat
        // it like a transport failure so a working Confluence still connects.
        let viewer = request(&config, "myself", &[]).and_then(|viewer| {
            if viewer["accountId"].as_str().unwrap_or_default().is_empty() {
                Err(HttpError::other(
                    "Jira did not return an authenticated account",
                ))
            } else {
                Ok(viewer)
            }
        });
        let confluence = crate::confluence::probe(&config);
        match (viewer, confluence) {
            (Ok(viewer), wiki) => {
                config.account = viewer["displayName"]
                    .as_str()
                    .unwrap_or(&config.email)
                    .to_string();
                config.capabilities.push("Jira".into());
                // Only a definitive denial records Confluence as absent; a
                // transient probe failure leaves it enabled for per-request
                // errors instead of blocking it until the next reconnect.
                if !matches!(&wiki, Err(error) if error.denied()) {
                    config.capabilities.push("Confluence".into());
                }
            }
            (Err(jira_error), Ok(user)) => {
                // The site may provision Confluence without Jira for this account.
                if user["accountId"].as_str().unwrap_or_default().is_empty()
                    && user["displayName"].as_str().unwrap_or_default().is_empty()
                {
                    return Err("Confluence did not return an authenticated account".into());
                }
                config.account = user["displayName"]
                    .as_str()
                    .unwrap_or(&config.email)
                    .to_string();
                if !jira_error.denied() {
                    // Jira's answer was inconclusive — keep it enabled rather
                    // than silently downgrading a working connection.
                    config.capabilities.push("Jira".into());
                }
                config.capabilities.push("Confluence".into());
            }
            (Err(jira_error), Err(_)) => return Err(jira_error.into()),
        }
        let raw = serde_json::to_string(&config).map_err(|_| "Cannot encode Jira settings")?;
        CONFIG_WRITES.commit(generation, &path, Some(&raw))?;
        let _ = app.emit("monocode:jira-change", ());
        Ok(config.status())
    })
    .await
    .map_err(|_| "Jira connection task failed")?
}

fn http_error(status: u16) -> String {
    match status {
        401 => "Jira credentials expired or are invalid. Reconnect in Settings.".into(),
        403 => "Jira denied access. Check the account's project permissions.".into(),
        404 => "Jira item or filter is unavailable. Refresh or choose another filter.".into(),
        429 => "Jira is rate limiting requests. Wait before refreshing.".into(),
        _ => format!("Jira request failed (HTTP {status}). Check the connection and retry."),
    }
}

/// The HTTP status rides along with the message so capability probing can tell
/// a definitive denial (401/403/404) from a transient failure.
#[derive(Debug)]
pub(crate) struct HttpError {
    message: String,
    status: Option<u16>,
}

impl HttpError {
    pub(crate) fn status(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status: Some(status),
        }
    }

    pub(crate) fn other(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
        }
    }

    /// The product answered with an auth/permission/absence status — only then
    /// is it safe to record the capability as absent.
    pub(crate) fn denied(&self) -> bool {
        matches!(self.status, Some(401 | 403 | 404))
    }
}

impl From<HttpError> for String {
    fn from(error: HttpError) -> Self {
        error.message
    }
}

pub(crate) fn request(
    config: &JiraConfig,
    path: &str,
    query: &[(&str, String)],
) -> Result<Value, HttpError> {
    serde_json::from_slice(&request_bytes(config, path, query)?)
        .map_err(|_| HttpError::other("Jira returned an invalid response"))
}

fn request_bytes(
    config: &JiraConfig,
    path: &str,
    query: &[(&str, String)],
) -> Result<Vec<u8>, HttpError> {
    if BACKOFF
        .lock()
        .map_err(|_| HttpError::other("Jira request state unavailable"))?
        .as_ref()
        .is_some_and(|(site, until)| site == &config.site && *until > Instant::now())
    {
        return Err(HttpError::other(
            "Jira requests are paused after a service error. Wait before refreshing.",
        ));
    }
    let authorization = base64::engine::general_purpose::STANDARD
        .encode(format!("{}:{}", config.email, config.token));
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .redirects(0)
        .build();
    let mut req = agent
        .get(&format!("{}/rest/api/3/{path}", config.site))
        .set("Authorization", &format!("Basic {authorization}"))
        .set("Accept", "*/*");
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
                    .map_err(|_| HttpError::other("Jira request state unavailable"))? = Some((
                    config.site.clone(),
                    Instant::now() + Duration::from_secs(seconds),
                ));
            }
            return Err(HttpError::status(http_error(status), status));
        }
        Err(_) => {
            return Err(HttpError::other(
                "Cannot reach Jira Cloud. Check your connection and retry.",
            ))
        }
    };
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| HttpError::other("Cannot read Jira response"))?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err(HttpError::other(
            "Jira response is too large. Choose a narrower filter.",
        ));
    }
    Ok(bytes)
}

fn numeric_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 30 && id.bytes().all(|b| b.is_ascii_digit())
}

/// The `issue/{ref}` endpoint also resolves project keys like `PROJ-123`.
fn issue_ref(id: &str) -> bool {
    if numeric_id(id) {
        return true;
    }
    let Some((project, number)) = id.split_once('-') else {
        return false;
    };
    !project.is_empty()
        && project.len() <= 20
        && project
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        && numeric_id(number)
}

fn issue_query(
    project: &str,
    filter: &str,
    assigned: bool,
    state: &str,
    relationship: Option<&str>,
) -> Result<String, String> {
    if (!project.is_empty() && !numeric_id(project)) || (!filter.is_empty() && !numeric_id(filter))
    {
        return Err("Choose a valid Jira project or saved filter".into());
    }
    let mut parts = Vec::new();
    if !filter.is_empty() {
        parts.push(format!("filter = {filter}"));
    }
    if !project.is_empty() {
        parts.push(format!("project = {project}"));
    }
    match relationship.unwrap_or(if assigned { "assigned" } else { "all" }) {
        "all" => {}
        "assigned" => parts.push("assignee = currentUser()".into()),
        "created" => parts.push("creator = currentUser()".into()),
        "related" => parts.push("(assignee = currentUser() OR creator = currentUser())".into()),
        _ => return Err("Choose a valid Jira relationship filter".into()),
    }
    if state == "open" {
        parts.push("statusCategory != Done".into());
    }
    if parts.is_empty() {
        parts.push("updated >= -365d".into());
    }
    Ok(format!("{} ORDER BY updated DESC", parts.join(" AND ")))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn jira_list_issues(
    app: AppHandle,
    site: String,
    account_id: String,
    project: String,
    filter: String,
    assigned: bool,
    state: String,
    relationship: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        config.require_account(&account_id)?;
        let jql = issue_query(&project, &filter, assigned, &state, relationship.as_deref())?;
        let issues = issue_pages(|limit, token| {
            let mut query = vec![
                ("jql", jql.clone()),
                ("maxResults", limit.to_string()),
                (
                    "fields",
                    "summary,status,project,updated,labels,assignee".into(),
                ),
            ];
            if !token.is_empty() {
                query.push(("nextPageToken", token.to_string()));
            }
            request(&config, "search/jql", &query).map_err(String::from)
        })?;
        require_config(&app, &site)?.require_account(&account_id)?;
        Ok(json!({ "site": config.site, "issues": issues }))
    })
    .await
    .map_err(|_| "Jira list task failed")?
}

fn issue_pages(
    mut fetch: impl FnMut(usize, &str) -> Result<Value, String>,
) -> Result<Vec<Value>, String> {
    let mut issues = Vec::new();
    let mut token = String::new();
    let mut seen = std::collections::HashSet::new();
    // The Inbox retains at most 100 rows, including closed history.
    for _ in 0..10 {
        let page = fetch(100 - issues.len(), &token)?;
        let rows = page["issues"]
            .as_array()
            .ok_or("Jira returned an invalid issue list")?;
        issues.extend(rows.iter().take(100 - issues.len()).cloned());
        token = page["nextPageToken"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if issues.len() >= 100
            || page["isLast"] == true
            || token.is_empty()
            || rows.is_empty()
            || !seen.insert(token.clone())
        {
            break;
        }
    }
    Ok(issues)
}

#[tauri::command]
pub async fn jira_options(
    app: AppHandle,
    site: String,
    account_id: String,
    favorites: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        config.require_account(&account_id)?;
        let mut values = Vec::new();
        for _ in 0..10 {
            let mut query = vec![
                ("startAt", values.len().to_string()),
                ("maxResults", (100 - values.len()).to_string()),
            ];
            if favorites {
                query.push(("isFavourite", "true".into()));
            }
            let page = request(
                &config,
                if favorites {
                    "filter/search"
                } else {
                    "project/search"
                },
                &query,
            )?;
            let rows = page["values"]
                .as_array()
                .ok_or("Jira returned an invalid filter list")?;
            values.extend(
                rows.iter()
                    .take(100 - values.len())
                    .map(|row| json!({"id": row["id"], "name": row["name"]})),
            );
            if values.len() >= 100
                || rows.is_empty()
                || page["isLast"] == true
                || page["total"]
                    .as_u64()
                    .is_some_and(|total| values.len() as u64 >= total)
            {
                break;
            }
        }
        require_config(&app, &site)?.require_account(&account_id)?;
        Ok(json!(values))
    })
    .await
    .map_err(|_| "Jira filters task failed")?
}

#[tauri::command]
pub async fn jira_issue_content(
    app: AppHandle,
    site: String,
    account_id: String,
    id: String,
    comments: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        config.require_account(&account_id)?;
        if !issue_ref(&id) {
            return Err("Invalid Jira issue identity".into());
        }
        let result = if comments {
            request(
                &config,
                &format!("issue/{id}/comment"),
                &[("maxResults", "50".into()), ("orderBy", "-created".into())],
            )
        } else {
            request(
                &config,
                &format!("issue/{id}"),
                &[("fields", "description,creator,attachment".into())],
            )
        }
        .map_err(String::from)?;
        require_config(&app, &site)?.require_account(&account_id)?;
        Ok(result)
    })
    .await
    .map_err(|_| "Jira details task failed")?
}

#[tauri::command]
pub async fn jira_issue_snapshot(
    app: AppHandle,
    site: String,
    account_id: String,
    id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        config.require_account(&account_id)?;
        if !issue_ref(&id) {
            return Err("Invalid Jira issue identity".into());
        }
        let result = request(
            &config,
            &format!("issue/{id}"),
            &[(
                "fields",
                "summary,status,updated,project,labels,assignee".into(),
            )],
        )
        .map_err(String::from)?;
        require_config(&app, &site)?.require_account(&account_id)?;
        Ok(result)
    })
    .await
    .map_err(|_| "Jira snapshot task failed")?
}

fn image_on_issue(issue: &Value, attachment_id: &str) -> bool {
    numeric_id(attachment_id)
        && issue["fields"]["attachment"]
            .as_array()
            .is_some_and(|files| {
                files.iter().any(|file| {
                    file["id"].as_str() == Some(attachment_id)
                        && file["mimeType"]
                            .as_str()
                            .is_some_and(|mime| mime.starts_with("image/"))
                })
            })
}

#[tauri::command]
pub async fn jira_image(
    app: AppHandle,
    site: String,
    account_id: String,
    id: String,
    attachment_id: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        config.require_account(&account_id)?;
        if !issue_ref(&id) || !numeric_id(&attachment_id) {
            return Err("Invalid Jira image identity".into());
        }
        let issue = request(
            &config,
            &format!("issue/{id}"),
            &[("fields", "attachment".into())],
        )?;
        if !image_on_issue(&issue, &attachment_id) {
            return Err("This image is no longer available on the selected Jira ticket".into());
        }
        let bytes = request_bytes(
            &config,
            &format!("attachment/thumbnail/{attachment_id}"),
            &[
                ("redirect", "false".into()),
                ("fallbackToDefault", "false".into()),
                ("width", "800".into()),
                ("height", "600".into()),
            ],
        )?;
        if crate::inbox_media::image_mime(&bytes).is_none() {
            return Err("Jira did not return a supported image preview".into());
        }
        require_config(&app, &site)?.require_account(&account_id)?;
        Ok::<_, String>(bytes)
    })
    .await
    .map_err(|_| "Jira image task failed")??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relationship_queries_keep_scope_and_override_legacy_assignment() {
        assert_eq!(issue_query("12", "34", true, "open", Some("related")).unwrap(),
            "filter = 34 AND project = 12 AND (assignee = currentUser() OR creator = currentUser()) AND statusCategory != Done ORDER BY updated DESC");
        assert_eq!(
            issue_query("", "", true, "all", Some("created")).unwrap(),
            "creator = currentUser() ORDER BY updated DESC"
        );
        assert!(!issue_query("12", "", true, "all", Some("all"))
            .unwrap()
            .contains("assignee"));
        assert!(issue_query("", "", false, "all", Some("assigned"))
            .unwrap()
            .contains("assignee = currentUser()"));
        assert!(issue_query("", "", false, "all", Some("reviewing")).is_err());
    }

    #[test]
    fn content_identity_uses_the_credential_login_not_display_name() {
        let config: JiraConfig = serde_json::from_value(json!({
            "site": "https://team.atlassian.net", "email": "ada@example.test",
            "token": "test-only", "account": "Same Name"
        }))
        .unwrap();
        assert_eq!(config.status().account_id, "email:ada@example.test");
        assert!(config.require_account("email:ada@example.test").is_ok());
        for foreign in ["", "Same Name", "email:other@example.test"] {
            assert!(config.require_account(foreign).is_err());
        }
    }

    #[test]
    fn image_preview_requires_membership_and_image_type() {
        let issue = json!({"fields":{"attachment":[{"id":"12","mimeType":"image/png"},{"id":"13","mimeType":"text/html"}]}});
        assert!(image_on_issue(&issue, "12"));
        assert!(!image_on_issue(&issue, "13"));
        assert!(!image_on_issue(&issue, "14"));
        assert!(!image_on_issue(&issue, "../12"));
    }
    #[test]
    fn pagination_bounds_rows_requests_and_repeated_tokens() {
        let mut calls = Vec::new();
        let rows = issue_pages(|limit, token| {
            calls.push((limit, token.to_string()));
            Ok(json!({"issues": vec![json!({"id":"1"}); 60], "nextPageToken": "next", "isLast": false}))
        }).unwrap();
        assert_eq!(rows.len(), 100);
        assert_eq!(calls, vec![(100, "".into()), (40, "next".into())]);
        let mut calls = 0;
        let rows = issue_pages(|_, _| {
            calls += 1;
            Ok(json!({"issues":[{"id":"1"}],"nextPageToken":"same"}))
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(rows.len(), 2);
        assert!(issue_pages(|_, _| Ok(json!({"unexpected":"secret"})))
            .unwrap_err()
            .contains("invalid issue list"));
        assert!(issue_pages(|_, _| Ok(json!({"issues":[]})))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn site_and_queries_are_bound_to_cloud_and_selected_ids() {
        assert_eq!(
            normalize_site(" https://team.atlassian.net/ ").unwrap(),
            "https://team.atlassian.net"
        );
        for site in [
            "http://team.atlassian.net",
            "https://team.atlassian.net.evil.com",
            "https://user:token@team.atlassian.net",
            "https://team.atlassian.net/?token=secret",
            "https://jira.company.test",
            "https://team.atlassian.net/path",
        ] {
            assert!(normalize_site(site).is_err());
        }
        assert_eq!(issue_query("12", "34", true, "open", None).unwrap(), "filter = 34 AND project = 12 AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
        assert!(issue_query("12 OR 1=1", "", true, "all", None).is_err());
        assert!(issue_query("", "secret", true, "all", None).is_err());
        assert!(!numeric_id("../myself"));
        for id in ["10042", "PROJ-123", "PROJ_2-1"] {
            assert!(issue_ref(id), "expected {id} to be accepted");
        }
        for id in [
            "",
            "../myself",
            "-1",
            "PROJ-",
            "PROJ-1-2",
            "proj-1",
            "PROJ 1-1",
            "PROJ-12x",
            "PROJ-1/x",
            "PROJ-1?fields=x",
        ] {
            assert!(!issue_ref(id), "expected {id} to be rejected");
        }
        assert!(http_error(401).contains("Reconnect"));
        assert!(http_error(403).contains("permissions"));
    }
}
