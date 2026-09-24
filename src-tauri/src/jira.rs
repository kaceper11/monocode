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
    #[serde(default)]
    account: String,
    /// Atlassian products verified for this credential. Empty means the
    /// connection predates capability tracking — treated as unknown.
    #[serde(default)]
    pub(crate) capabilities: Vec<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JiraStatus {
    email: String,
    connected: bool,
    site: String,
    account: String,
    account_id: String,
    capabilities: Vec<String>,
}

impl JiraConfig {
    // Bind reads to the credential login, never the non-unique display name.
    pub(crate) fn account_id(&self) -> String {
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
            email: self.email.clone(),
            connected: true,
            site: self.site.clone(),
            account: self.account.clone(),
            account_id: self.account_id(),
            capabilities: self.capabilities.clone(),
        }
    }
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
            config.site = normalize_jira_site(&config.site)?;
            Ok(Some(config))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read Jira settings".into()),
    }
}

pub(crate) fn require_config(app: &AppHandle, site: &str) -> Result<JiraConfig, String> {
    let config = read_config(app)?.ok_or("Connect Jira Cloud in Settings")?;
    if config.site != normalize_jira_site(site)? {
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
            site: normalize_jira_site(&site)?,
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

fn check_backoff(config: &JiraConfig) -> Result<(), HttpError> {
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
    Ok(())
}

fn request_bytes(
    config: &JiraConfig,
    path: &str,
    query: &[(&str, String)],
) -> Result<Vec<u8>, HttpError> {
    check_backoff(config)?;
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

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_LIMIT: u32 = 40;
const COMMENT_LIMIT: u32 = 50;
pub(crate) const ISSUE_FIELDS: [&str; 8] = [
    "summary",
    "status",
    "updated",
    "labels",
    "assignee",
    "project",
    "parent",
    "issuetype",
];

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JiraProject {
    pub id: String,
    pub key: String,
    pub name: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JiraLabel {
    pub name: String,
    pub color: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JiraAssignee {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssue {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<Box<JiraIssue>>,
    pub site: String,
    pub account: String,
    pub provider: String,
    pub kind: String,
    pub id: String,
    pub identifier: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub state_type: String,
    pub updated_at: String,
    pub labels: Vec<JiraLabel>,
    pub assignees: Vec<JiraAssignee>,
    pub draft: bool,
    pub repo: String,
    pub team_id: String,
    pub team_name: String,
    pub project_path: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JiraAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssueDetails {
    pub attachments: Vec<JiraAttachment>,
    pub body: String,
    pub author: String,
    pub author_avatar_url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssueComment {
    pub id: String,
    pub kind: String,
    pub author: String,
    pub author_avatar_url: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
    pub state: String,
    pub path: String,
    pub line: Option<i64>,
    pub resolved: bool,
    pub thread_id: String,
    pub replies: Vec<JiraIssueComment>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssueThread {
    pub comments: Vec<JiraIssueComment>,
    pub truncated: bool,
    pub review_decision: String,
    pub base_ref_name: String,
    pub head_ref_name: String,
}

#[tauri::command]
pub async fn jira_list_projects(app: AppHandle) -> Result<Vec<JiraProject>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = current_config(&app)?;
        fetch_jira_projects(|start| {
            jira_get(
                &config,
                &format!("/rest/api/3/project/search?maxResults=100&orderBy=name&startAt={start}"),
            )
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn jira_list_issues(
    app: AppHandle,
    assigned_to_me: bool,
    state: String,
    project_ids: Vec<String>,
    limit: Option<u32>,
    project: Option<String>,
    filter: Option<String>,
    relationship: Option<String>,
) -> Result<Vec<JiraIssue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(config) = read_config(&app)? else {
            return Ok(Vec::new());
        };
        let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 100);
        if !config.capabilities.is_empty() && !config.capabilities.iter().any(|c| c == "Jira") { return Ok(Vec::new()); }
        let jql = if project.is_some() || filter.is_some() || relationship.is_some() {
            let base = issue_query(project.as_deref().unwrap_or(""), filter.as_deref().unwrap_or(""), assigned_to_me, &state, relationship.as_deref())?;
            let visible = issue_jql(false, "all", &project_ids);
            if project_ids.is_empty() { base } else { format!("{} AND {} ORDER BY updated DESC", base.trim_end_matches(" ORDER BY updated DESC"), visible.trim_end_matches(" ORDER BY updated DESC")) }
        } else { issue_jql(assigned_to_me, &state, &project_ids) };
        let rows = issue_pages(limit as usize, |remaining, token| {
            let mut body = json!({ "jql": jql, "maxResults": remaining.min(limit as usize), "fields": ISSUE_FIELDS });
            if !token.is_empty() { body["nextPageToken"] = json!(token); }
            jira_post(&config, "/rest/api/3/search/jql", &body)
        })?;
        let data = json!({ "issues": rows.into_iter().take(limit as usize).collect::<Vec<_>>() });
        require_config(&app, &config.site)?.require_account(&config.account_id())?;
        let mut issues = parse_jira_issues(&data, &config.site)?;
        for issue in &mut issues {
            issue.site = config.site.clone(); issue.account = config.account_id();
            if let Some(parent) = &mut issue.parent { parent.site = config.site.clone(); parent.account = config.account_id(); }
        }
        Ok(issues)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn jira_issue_details(
    app: AppHandle,
    key: String,
    site: String,
    account_id: String,
) -> Result<JiraIssueDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        config.require_account(&account_id)?;
        let key = require_issue_key(&key)?;
        let data = jira_get(
            &config,
            &format!(
                "/rest/api/3/issue/{key}?fields=description,reporter,creator,assignee,attachment"
            ),
        )?;
        require_config(&app, &site)?.require_account(&account_id)?;
        parse_jira_issue_details(&data)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn jira_issue_thread(
    app: AppHandle,
    key: String,
    site: String,
    account_id: String,
) -> Result<JiraIssueThread, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        config.require_account(&account_id)?;
        let key = require_issue_key(&key)?;
        // Newest first so a long thread keeps its latest comments; re-sorted below.
        let data = jira_get(
            &config,
            &format!("/rest/api/3/issue/{key}/comment?maxResults={COMMENT_LIMIT}&orderBy=-created"),
        )?;
        require_config(&app, &site)?.require_account(&account_id)?;
        parse_jira_issue_thread(&data, &config.site, key)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn jira_issue_comment(
    app: AppHandle,
    key: String,
    body: String,
    site: String,
    account_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        config.require_account(&account_id)?;
        let key = require_issue_key(&key)?;
        let body = body.trim();
        if body.is_empty() {
            return Err("Comment cannot be empty".into());
        }
        let data = jira_post(
            &config,
            &format!("/rest/api/3/issue/{key}/comment"),
            &json!({ "body": text_to_adf(body) }),
        )?;
        let id = string_field(&data, "id").unwrap_or_default();
        if id.is_empty() {
            return Err("Could not post Jira comment".into());
        }
        Ok(comment_url(&config.site, key, &id))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn issue_jql(assigned_to_me: bool, state: &str, project_ids: &[String]) -> String {
    let mut clauses = Vec::new();
    if assigned_to_me {
        clauses.push("assignee = currentUser()".to_string());
    }
    let ids: Vec<&str> = project_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()))
        .collect();
    if !ids.is_empty() {
        clauses.push(format!("project in ({})", ids.join(", ")));
    }
    if !state.trim().eq_ignore_ascii_case("all") {
        clauses.push("statusCategory != Done".to_string());
    }
    // The search endpoint rejects unbounded JQL, so an unfiltered query is
    // limited to the last year of activity.
    if clauses.is_empty() {
        clauses.push("updated >= -365d".to_string());
    }
    format!("{} ORDER BY updated DESC", clauses.join(" AND "))
}

fn jira_authorization(config: &JiraConfig) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!(
        "{}:{}",
        config.email.trim(),
        config.token.trim()
    ));
    format!("Basic {encoded}")
}

pub(crate) fn jira_get(config: &JiraConfig, path: &str) -> Result<Value, String> {
    check_backoff(config)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT)
        .redirects(0)
        .build();
    let result = agent
        .get(&format!("{}{path}", config.site))
        .set("Authorization", &jira_authorization(config))
        .set("Accept", "application/json")
        .call();
    read_jira_response(result, config)
}

pub(crate) fn jira_post(config: &JiraConfig, path: &str, body: &Value) -> Result<Value, String> {
    check_backoff(config)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT)
        .redirects(0)
        .build();
    let payload = serde_json::to_string(body).map_err(|error| error.to_string())?;
    let result = agent
        .post(&format!("{}{path}", config.site))
        .set("Authorization", &jira_authorization(config))
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .send_string(&payload);
    read_jira_response(result, config)
}

fn read_bounded_response(response: ureq::Response) -> Result<String, String> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Jira returned an unreadable response")?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err("Jira response is too large. Choose a narrower filter.".into());
    }
    String::from_utf8(bytes).map_err(|_| "Jira returned invalid UTF-8".into())
}

fn read_jira_response(
    result: Result<ureq::Response, ureq::Error>,
    config: &JiraConfig,
) -> Result<Value, String> {
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(401, _)) => {
            return Err("Jira email or API token is invalid".into());
        }
        Err(ureq::Error::Status(status, response)) => {
            if status == 429 || status >= 500 {
                let seconds = response
                    .header("Retry-After")
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(30)
                    .clamp(1, 300);
                *BACKOFF
                    .lock()
                    .map_err(|_| "Jira request state unavailable")? = Some((
                    config.site.clone(),
                    Instant::now() + Duration::from_secs(seconds),
                ));
            }
            let body = read_bounded_response(response).unwrap_or_default();
            return Err(jira_http_error(status, &body));
        }
        Err(_) => return Err("Could not reach Jira".into()),
    };
    let status = response.status();
    let body = read_bounded_response(response)?;
    if !(200..300).contains(&status) {
        return Err(jira_http_error(status, &body));
    }
    serde_json::from_str(&body).map_err(|_| "Jira returned invalid JSON".to_string())
}

fn jira_http_error(status: u16, body: &str) -> String {
    if let Some(message) = jira_error_message(body) {
        return message;
    }
    match status {
        403 => "Jira denied access. Check the API token's permissions".into(),
        404 => "Jira could not find that issue".into(),
        _ => format!("Jira request failed ({status})"),
    }
}

fn jira_error_message(body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    let from_list = parsed
        .get("errorMessages")
        .and_then(Value::as_array)
        .and_then(|messages| messages.iter().filter_map(Value::as_str).next())
        .map(str::to_string);
    let from_map = || {
        parsed
            .get("errors")
            .and_then(Value::as_object)
            .and_then(|errors| errors.values().filter_map(Value::as_str).next())
            .map(str::to_string)
    };
    from_list
        .or_else(from_map)
        .map(|message| message.trim().to_string())
        .filter(|message| !message.is_empty())
}

fn parse_jira_projects(data: &Value) -> Result<Vec<JiraProject>, String> {
    let values = data
        .get("values")
        .and_then(Value::as_array)
        .ok_or_else(|| "Jira did not return projects".to_string())?;
    Ok(values
        .iter()
        .filter_map(|value| {
            let id = string_field(value, "id").filter(|id| !id.is_empty())?;
            let key = string_field(value, "key").unwrap_or_default();
            let name = string_field(value, "name")
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| key.clone());
            Some(JiraProject { id, key, name })
        })
        .collect())
}

// Follow every page: a partial project list would silently exclude visible
// projects when converting hidden projects into the JQL allowlist.
fn fetch_jira_projects(
    mut fetch: impl FnMut(u64) -> Result<Value, String>,
) -> Result<Vec<JiraProject>, String> {
    let mut start = 0;
    let mut projects = Vec::new();
    loop {
        let data = fetch(start)?;
        let page = parse_jira_projects(&data)?;
        let count = data["values"].as_array().map_or(0, Vec::len) as u64;
        projects.extend(page);
        if data["isLast"].as_bool() == Some(true) {
            break;
        }
        let next = data["startAt"].as_u64().unwrap_or(start) + count;
        if data["total"].as_u64().is_some_and(|total| next >= total) {
            break;
        }
        if count == 0 || next <= start {
            if data["isLast"].as_bool() == Some(false) {
                return Err("Jira project pagination did not advance".into());
            }
            break;
        }
        start = next;
    }
    let mut seen = std::collections::HashSet::new();
    projects.retain(|project| seen.insert(project.id.clone()));
    Ok(projects)
}

pub(crate) fn parse_jira_issues(data: &Value, site: &str) -> Result<Vec<JiraIssue>, String> {
    let issues = data
        .get("issues")
        .and_then(Value::as_array)
        .ok_or_else(|| "Jira did not return issues".to_string())?;
    Ok(issues
        .iter()
        .filter_map(|issue| parse_jira_issue(issue, site))
        .collect())
}

fn parse_jira_issue(node: &Value, site: &str) -> Option<JiraIssue> {
    let id = string_field(node, "id").filter(|id| !id.is_empty())?;
    let key = string_field(node, "key").filter(|key| !key.is_empty())?;
    let fields = node.get("fields").cloned().unwrap_or(Value::Null);
    let project = fields.get("project");
    let status = fields.get("status");
    let labels = fields
        .get("labels")
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .filter_map(Value::as_str)
                .map(|name| JiraLabel {
                    name: name.to_string(),
                    color: String::new(),
                })
                .collect()
        })
        .unwrap_or_default();
    let (assignee, avatar_url) = person_fields(fields.get("assignee"));
    Some(JiraIssue {
        parent: if fields
            .pointer("/issuetype/subtask")
            .and_then(Value::as_bool)
            == Some(true)
        {
            fields
                .get("parent")
                .and_then(|parent| parse_jira_issue(parent, site))
                .map(Box::new)
        } else {
            None
        },
        site: site.to_string(),
        account: String::new(),
        provider: "jira".into(),
        kind: "jira".into(),
        number: issue_number(&key),
        url: format!("{site}/browse/{key}"),
        title: string_field(&fields, "summary").unwrap_or_default(),
        state: status
            .and_then(|value| string_field(value, "name"))
            .unwrap_or_else(|| "Open".into()),
        state_type: status
            .and_then(|value| value.pointer("/statusCategory/key"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        updated_at: normalize_jira_time(&string_field(&fields, "updated").unwrap_or_default()),
        labels,
        assignees: assignee
            .map(|login| vec![JiraAssignee { login, avatar_url }])
            .unwrap_or_default(),
        draft: false,
        repo: project
            .and_then(|value| string_field(value, "key"))
            .unwrap_or_default(),
        team_id: project
            .and_then(|value| string_field(value, "id"))
            .unwrap_or_default(),
        team_name: project
            .and_then(|value| string_field(value, "name"))
            .unwrap_or_default(),
        project_path: String::new(),
        id,
        identifier: key,
    })
}

fn parse_jira_issue_details(data: &Value) -> Result<JiraIssueDetails, String> {
    let fields = data
        .get("fields")
        .ok_or_else(|| "Jira did not return that issue".to_string())?;
    let (author, author_avatar_url) = [fields.get("reporter"), fields.get("creator")]
        .into_iter()
        .map(person_fields)
        .find(|(name, _)| name.is_some())
        .unwrap_or_else(|| person_fields(fields.get("assignee")));
    Ok(JiraIssueDetails {
        attachments: data["fields"]["attachment"]
            .as_array()
            .into_iter()
            .flatten()
            .take(200)
            .filter_map(|file| {
                let id = file["id"].as_str()?;
                numeric_id(id).then(|| JiraAttachment {
                    id: id.into(),
                    name: file["filename"].as_str().unwrap_or_default().into(),
                    mime_type: file["mimeType"].as_str().unwrap_or_default().into(),
                })
            })
            .collect(),
        body: rich_text(fields.get("description")),
        author: author.unwrap_or_default(),
        author_avatar_url,
    })
}

fn parse_jira_issue_thread(data: &Value, site: &str, key: &str) -> Result<JiraIssueThread, String> {
    let comments = data
        .get("comments")
        .and_then(Value::as_array)
        .ok_or_else(|| "Jira did not return comments".to_string())?;
    let total = data
        .get("total")
        .and_then(Value::as_u64)
        .unwrap_or(comments.len() as u64);
    let mut parsed: Vec<JiraIssueComment> = comments
        .iter()
        .filter_map(|comment| parse_jira_comment(comment, site, key))
        .collect();
    parsed.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    Ok(JiraIssueThread {
        truncated: total > comments.len() as u64,
        comments: parsed,
        review_decision: String::new(),
        base_ref_name: String::new(),
        head_ref_name: String::new(),
    })
}

fn parse_jira_comment(node: &Value, site: &str, key: &str) -> Option<JiraIssueComment> {
    let id = string_field(node, "id").filter(|id| !id.is_empty())?;
    let (author, author_avatar_url) = person_fields(node.get("author"));
    Some(JiraIssueComment {
        url: comment_url(site, key, &id),
        kind: "comment".into(),
        author: author.unwrap_or_default(),
        author_avatar_url,
        body: rich_text(node.get("body")),
        created_at: normalize_jira_time(&string_field(node, "created").unwrap_or_default()),
        state: String::new(),
        path: String::new(),
        line: None,
        resolved: false,
        thread_id: String::new(),
        replies: Vec::new(),
        id,
    })
}

fn comment_url(site: &str, key: &str, id: &str) -> String {
    format!("{site}/browse/{key}?focusedCommentId={id}")
}

fn issue_number(key: &str) -> i64 {
    key.rsplit('-')
        .next()
        .and_then(|number| number.parse().ok())
        .unwrap_or(0)
}

/// Jira sends `+0000` offsets, which WebKit's `Date.parse` rejects.
fn normalize_jira_time(value: &str) -> String {
    let bytes = value.as_bytes();
    let len = bytes.len();
    if len > 5
        && matches!(bytes[len - 5], b'+' | b'-')
        && bytes[len - 4..].iter().all(u8::is_ascii_digit)
    {
        return format!("{}:{}", &value[..len - 2], &value[len - 2..]);
    }
    value.to_string()
}

fn require_issue_key(key: &str) -> Result<&str, String> {
    let key = key.trim();
    let valid = !key.is_empty()
        && key.len() < 64
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'));
    if valid {
        Ok(key)
    } else {
        Err("Missing Jira issue".into())
    }
}

fn person_fields(node: Option<&Value>) -> (Option<String>, String) {
    let Some(node) = node.filter(|node| node.is_object()) else {
        return (None, String::new());
    };
    (
        string_field(node, "displayName").filter(|name| !name.is_empty()),
        node.pointer("/avatarUrls/48x48")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    )
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|text| text.trim().to_string())
}

// ---- Atlassian Document Format ----

/// Descriptions and comments arrive as ADF (v3) or plain text; the Inbox renders markdown.
fn rich_text(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(doc @ Value::Object(_)) => adf_to_markdown(doc),
        _ => String::new(),
    };
    if text.chars().count() > 60_000 {
        format!(
            "{}\n[Truncated: open Jira for full content]",
            text.chars().take(60_000).collect::<String>()
        )
    } else {
        text
    }
}

fn adf_to_markdown(doc: &Value) -> String {
    let mut blocks = Vec::new();
    for node in children(doc) {
        let block = adf_block(node, "");
        if !block.trim().is_empty() {
            blocks.push(block);
        }
    }
    blocks.join("\n\n").trim().to_string()
}

fn children(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn node_type(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn attr<'a>(node: &'a Value, name: &str) -> Option<&'a Value> {
    node.pointer(&format!("/attrs/{name}"))
}

fn attr_str<'a>(node: &'a Value, name: &str) -> &'a str {
    attr(node, name).and_then(Value::as_str).unwrap_or_default()
}

fn adf_block(node: &Value, indent: &str) -> String {
    match node_type(node) {
        "paragraph" => adf_inline(children(node)),
        "heading" => {
            let level = attr(node, "level")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 6) as usize;
            format!("{} {}", "#".repeat(level), adf_inline(children(node)))
        }
        "bulletList" => adf_list(node, indent, None),
        "orderedList" => {
            let start = attr(node, "order").and_then(Value::as_u64).unwrap_or(1);
            adf_list(node, indent, Some(start))
        }
        "codeBlock" => {
            let code: String = children(node)
                .iter()
                .filter_map(|child| child.get("text").and_then(Value::as_str))
                .collect();
            format!("```{}\n{}\n```", attr_str(node, "language"), code)
        }
        "blockquote" | "panel" => adf_blocks(children(node), indent)
            .lines()
            .map(|line| format!("> {line}"))
            .collect::<Vec<_>>()
            .join("\n"),
        "rule" => "---".into(),
        "table" => adf_table(node),
        "mediaSingle" | "mediaGroup" | "media" => String::new(),
        _ => {
            if children(node).is_empty() {
                adf_inline(std::slice::from_ref(node))
            } else {
                adf_blocks(children(node), indent)
            }
        }
    }
}

fn adf_blocks(nodes: &[Value], indent: &str) -> String {
    nodes
        .iter()
        .map(|node| adf_block(node, indent))
        .filter(|block| !block.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn adf_list(node: &Value, indent: &str, start: Option<u64>) -> String {
    let mut lines = Vec::new();
    for (index, item) in children(node).iter().enumerate() {
        let marker = match start {
            Some(start) => format!("{}. ", start + index as u64),
            None => "- ".into(),
        };
        let nested = format!("{indent}{}", " ".repeat(marker.len()));
        let mut first = true;
        for child in children(item) {
            let text = adf_block(child, &nested);
            if text.trim().is_empty() {
                continue;
            }
            if matches!(node_type(child), "bulletList" | "orderedList") {
                lines.push(text);
            } else if first {
                lines.push(format!(
                    "{indent}{marker}{}",
                    text.replace('\n', &format!("\n{nested}"))
                ));
                first = false;
            } else {
                lines.push(format!(
                    "{nested}{}",
                    text.replace('\n', &format!("\n{nested}"))
                ));
            }
        }
    }
    lines.join("\n")
}

fn adf_table(node: &Value) -> String {
    let rows: Vec<Vec<String>> = children(node)
        .iter()
        .map(|row| {
            children(row)
                .iter()
                .map(|cell| {
                    adf_blocks(children(cell), "")
                        .replace('\n', " ")
                        .replace('|', "\\|")
                })
                .collect()
        })
        .filter(|row: &Vec<String>| !row.is_empty())
        .collect();
    let Some(width) = rows.iter().map(Vec::len).max() else {
        return String::new();
    };
    let line = |cells: &[String]| {
        let mut padded = cells.to_vec();
        padded.resize(width, String::new());
        format!("| {} |", padded.join(" | "))
    };
    let mut lines = vec![line(&rows[0]), format!("|{}", " --- |".repeat(width))];
    lines.extend(rows[1..].iter().map(|row| line(row)));
    lines.join("\n")
}

fn adf_inline(nodes: &[Value]) -> String {
    let mut out = String::new();
    for node in nodes {
        match node_type(node) {
            "text" => out.push_str(&adf_marked_text(node)),
            "hardBreak" => out.push('\n'),
            "mention" => {
                let text = attr_str(node, "text");
                if text.starts_with('@') {
                    out.push_str(text);
                } else if !text.is_empty() {
                    out.push('@');
                    out.push_str(text);
                }
            }
            "emoji" => {
                let text = attr_str(node, "text");
                out.push_str(if text.is_empty() {
                    attr_str(node, "shortName")
                } else {
                    text
                });
            }
            "inlineCard" | "blockCard" | "embedCard" => {
                let url = attr_str(node, "url");
                if safe_link(url) {
                    out.push_str(&format!("<{url}>"));
                }
            }
            "status" => out.push_str(&format!("`{}`", attr_str(node, "text"))),
            "date" => {}
            _ => out.push_str(&adf_inline(children(node))),
        }
    }
    out
}

fn safe_link(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|url| matches!(url.scheme(), "https" | "http" | "mailto"))
}

fn adf_marked_text(node: &Value) -> String {
    let mut text = node
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if text.is_empty() {
        return text;
    }
    let marks = node
        .get("marks")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if marks.iter().any(|mark| node_type(mark) == "code") {
        return format!("`{text}`");
    }
    for mark in marks {
        text = match node_type(mark) {
            "strong" => format!("**{text}**"),
            "em" => format!("_{text}_"),
            "strike" => format!("~~{text}~~"),
            "link" => {
                let href = attr_str(mark, "href");
                if !safe_link(href) {
                    text
                } else {
                    format!("[{text}]({href})")
                }
            }
            _ => text,
        };
    }
    text
}

/// Posts plain text as ADF: blank lines split paragraphs, single newlines become hard breaks.
fn text_to_adf(text: &str) -> Value {
    let paragraphs: Vec<Value> = text
        .replace("\r\n", "\n")
        .split("\n\n")
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
        .map(|paragraph| {
            let mut content = Vec::new();
            for (index, line) in paragraph.lines().enumerate() {
                if index > 0 {
                    content.push(json!({ "type": "hardBreak" }));
                }
                if !line.is_empty() {
                    content.push(json!({ "type": "text", "text": line }));
                }
            }
            json!({ "type": "paragraph", "content": content })
        })
        .collect();
    json!({ "type": "doc", "version": 1, "content": paragraphs })
}

fn normalize_jira_site(raw: &str) -> Result<String, String> {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err("Enter your Jira site (e.g. yourteam.atlassian.net)".into());
    }
    // Bare `yourteam` becomes the Atlassian Cloud site.
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else if raw.contains('.') {
        format!("https://{raw}")
    } else {
        format!("https://{raw}.atlassian.net")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| "Jira site is invalid".to_string())?;
    // The API token travels on every request as Basic auth.
    if url.scheme() != "https" {
        return Err("Jira site must use HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Jira site is invalid".into());
    }
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "Jira site is invalid".to_string())?;
    Ok(match url.port() {
        Some(port) => format!("https://{}:{port}", host.to_ascii_lowercase()),
        None => format!("https://{}", host.to_ascii_lowercase()),
    })
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

fn issue_pages(
    limit: usize,
    mut fetch: impl FnMut(usize, &str) -> Result<Value, String>,
) -> Result<Vec<Value>, String> {
    let mut issues = Vec::new();
    let mut token = String::new();
    let mut seen = std::collections::HashSet::new();
    // The Inbox retains at most 100 rows, including closed history.
    for _ in 0..10 {
        let page = fetch(limit - issues.len(), &token)?;
        let rows = page["issues"]
            .as_array()
            .ok_or("Jira returned an invalid issue list")?;
        issues.extend(rows.iter().take(limit - issues.len()).cloned());
        token = page["nextPageToken"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if issues.len() >= limit
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
pub async fn jira_issue_snapshot(
    app: AppHandle,
    site: String,
    account_id: String,
    id: String,
) -> Result<JiraIssue, String> {
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
                "summary,status,updated,project,labels,assignee,parent,issuetype".into(),
            )],
        )
        .map_err(String::from)?;
        require_config(&app, &site)?.require_account(&account_id)?;
        let mut issue = parse_jira_issue(&result, &config.site).ok_or("Invalid Jira issue")?;
        issue.account = config.account_id();
        if let Some(parent) = &mut issue.parent {
            parent.account = config.account_id();
        }
        Ok(issue)
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

pub(crate) fn current_config(app: &AppHandle) -> Result<JiraConfig, String> {
    read_config(app)?.ok_or_else(|| "Connect Jira in Settings".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SITE: &str = "https://acme.atlassian.net";

    #[test]
    fn fetches_every_project_page() {
        let mut offsets = Vec::new();
        let projects = fetch_jira_projects(|start| {
            offsets.push(start);
            Ok(if start == 0 {
                json!({ "startAt": 0, "isLast": false, "values": [
                    { "id": "10000", "key": "ENG", "name": "Engineering" }
                ] })
            } else {
                json!({ "startAt": 1, "isLast": true, "values": [
                    { "id": "10001", "key": "OPS", "name": "Operations" }
                ] })
            })
        })
        .unwrap();
        assert_eq!(offsets, vec![0, 1]);
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[1].key, "OPS");
    }

    #[test]
    fn rejects_stalled_project_pagination() {
        assert!(fetch_jira_projects(|_| Ok(json!({
            "isLast": false, "values": []
        })))
        .is_err());
    }

    #[test]
    fn normalizes_jira_sites() {
        assert_eq!(normalize_jira_site("acme").unwrap(), SITE);
        assert_eq!(normalize_jira_site("acme.atlassian.net").unwrap(), SITE);
        assert_eq!(
            normalize_jira_site(" https://Acme.atlassian.net/jira/software/projects ").unwrap(),
            SITE
        );
        assert_eq!(
            normalize_jira_site("jira.example.com:8443").unwrap(),
            "https://jira.example.com:8443"
        );
        assert!(normalize_jira_site("http://acme.atlassian.net").is_err());
        assert!(normalize_jira_site("https://user@acme.atlassian.net").is_err());
        assert!(normalize_jira_site("").is_err());
    }

    #[test]
    fn authorization_is_basic_email_and_token() {
        let config = JiraConfig {
            account: String::new(),
            capabilities: Vec::new(),
            site: SITE.into(),
            email: "ada@acme.com".into(),
            token: "secret".into(),
        };
        assert_eq!(
            jira_authorization(&config),
            "Basic YWRhQGFjbWUuY29tOnNlY3JldA=="
        );
    }

    #[test]
    fn issue_jql_combines_filters() {
        assert_eq!(
            issue_jql(true, "open", &[" 10000 ".into(), "".into(), "10001".into(), "x) OR (1".into()]),
            "assignee = currentUser() AND project in (10000, 10001) AND statusCategory != Done ORDER BY updated DESC"
        );
        assert_eq!(
            issue_jql(false, "all", &[]),
            "updated >= -365d ORDER BY updated DESC"
        );
    }

    #[test]
    fn parse_jira_projects_reads_values() {
        let data = json!({
            "values": [
                { "id": "10000", "key": "ENG", "name": "Engineering" },
                { "id": "", "key": "SKIP", "name": "Skip" }
            ]
        });
        assert_eq!(
            parse_jira_projects(&data).unwrap(),
            vec![JiraProject {
                id: "10000".into(),
                key: "ENG".into(),
                name: "Engineering".into(),
            }]
        );
    }

    #[test]
    fn parse_jira_issues_maps_fields() {
        let data = json!({
            "issues": [{
                "id": "10042",
                "key": "ENG-42",
                "fields": {
                    "summary": "Fix auth",
                    "updated": "2026-08-27T10:00:00.000+0000",
                    "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                    "labels": ["bug", "backend"],
                    "assignee": {
                        "displayName": "Maya",
                        "avatarUrls": { "48x48": "https://avatar.example/maya.png" }
                    },
                    "project": { "id": "10000", "key": "ENG", "name": "Engineering" }
                }
            }, { "id": "10043" }]
        });
        let items = parse_jira_issues(&data, SITE).unwrap();
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.provider, "jira");
        assert_eq!(item.kind, "jira");
        assert_eq!(item.id, "10042");
        assert_eq!(item.identifier, "ENG-42");
        assert_eq!(item.number, 42);
        assert_eq!(item.url, "https://acme.atlassian.net/browse/ENG-42");
        assert_eq!(item.state, "In Progress");
        assert_eq!(item.state_type, "indeterminate");
        assert_eq!(item.updated_at, "2026-08-27T10:00:00.000+00:00");
        assert_eq!(item.labels[1].name, "backend");
        assert_eq!(item.assignees[0].login, "Maya");
        assert_eq!(
            item.assignees[0].avatar_url,
            "https://avatar.example/maya.png"
        );
        assert_eq!(item.repo, "ENG");
        assert_eq!(item.team_id, "10000");
        assert_eq!(item.team_name, "Engineering");
    }

    #[test]
    fn parse_jira_issue_details_prefers_reporter() {
        let data = json!({
            "fields": {
                "description": {
                    "type": "doc",
                    "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Steps" }] }]
                },
                "reporter": { "displayName": "Ada", "avatarUrls": { "48x48": "https://avatar.example/ada.png" } },
                "creator": { "displayName": "Lin" },
                "assignee": null
            }
        });
        let details = parse_jira_issue_details(&data).unwrap();
        assert_eq!(details.body, "Steps");
        assert_eq!(details.author, "Ada");
        assert_eq!(details.author_avatar_url, "https://avatar.example/ada.png");
    }

    #[test]
    fn parse_jira_issue_thread_sorts_oldest_first() {
        let data = json!({
            "total": 3,
            "comments": [
                {
                    "id": "2",
                    "author": { "displayName": "Maya" },
                    "body": "Plain reply",
                    "created": "2026-08-31T11:00:00.000+0000"
                },
                {
                    "id": "1",
                    "author": { "displayName": "Ada" },
                    "body": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Root" }] }] },
                    "created": "2026-08-31T10:00:00.000+0000"
                }
            ]
        });
        let thread = parse_jira_issue_thread(&data, SITE, "ENG-42").unwrap();
        assert!(thread.truncated);
        assert_eq!(thread.comments.len(), 2);
        assert_eq!(thread.comments[0].body, "Root");
        assert_eq!(
            thread.comments[0].url,
            "https://acme.atlassian.net/browse/ENG-42?focusedCommentId=1"
        );
        assert_eq!(thread.comments[1].author, "Maya");
        assert_eq!(thread.comments[1].body, "Plain reply");
    }

    #[test]
    fn adf_converts_to_markdown() {
        let doc = json!({
            "type": "doc",
            "version": 1,
            "content": [
                { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Repro" }] },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "Ping " },
                    { "type": "mention", "attrs": { "text": "@Maya" } },
                    { "type": "text", "text": " see " },
                    { "type": "text", "text": "docs", "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }] },
                    { "type": "hardBreak" },
                    { "type": "text", "text": "now", "marks": [{ "type": "strong" }] },
                    { "type": "text", "text": " run " },
                    { "type": "text", "text": "make", "marks": [{ "type": "code" }, { "type": "strong" }] }
                ]},
                { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "one" }] },
                        { "type": "orderedList", "content": [
                            { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "nested" }] }] }
                        ]}
                    ]},
                    { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "two" }] }] }
                ]},
                { "type": "codeBlock", "attrs": { "language": "sh" }, "content": [{ "type": "text", "text": "npm test" }] },
                { "type": "blockquote", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "quoted" }] }] },
                { "type": "mediaSingle", "content": [{ "type": "media", "attrs": { "id": "x" } }] }
            ]
        });
        assert_eq!(
            adf_to_markdown(&doc),
            "## Repro\n\nPing @Maya see [docs](https://example.com)\n**now** run `make`\n\n- one\n  1. nested\n- two\n\n```sh\nnpm test\n```\n\n> quoted"
        );
    }

    #[test]
    fn adf_renders_tables() {
        let cell = |text: &str| json!({ "type": "tableCell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }] });
        let doc = json!({
            "type": "doc",
            "content": [{ "type": "table", "content": [
                { "type": "tableRow", "content": [cell("a"), cell("b")] },
                { "type": "tableRow", "content": [cell("1"), cell("2|3")] }
            ]}]
        });
        assert_eq!(
            adf_to_markdown(&doc),
            "| a | b |\n| --- | --- |\n| 1 | 2\\|3 |"
        );
    }

    #[test]
    fn text_to_adf_splits_paragraphs_and_lines() {
        assert_eq!(
            text_to_adf("First line\nsecond\n\nNext"),
            json!({
                "type": "doc",
                "version": 1,
                "content": [
                    { "type": "paragraph", "content": [
                        { "type": "text", "text": "First line" },
                        { "type": "hardBreak" },
                        { "type": "text", "text": "second" }
                    ]},
                    { "type": "paragraph", "content": [{ "type": "text", "text": "Next" }] }
                ]
            })
        );
    }

    #[test]
    fn normalizes_jira_offsets() {
        assert_eq!(
            normalize_jira_time("2026-08-27T10:00:00.000+0200"),
            "2026-08-27T10:00:00.000+02:00"
        );
        assert_eq!(
            normalize_jira_time("2026-08-27T10:00:00.000Z"),
            "2026-08-27T10:00:00.000Z"
        );
    }

    #[test]
    fn issue_keys_are_validated() {
        assert_eq!(require_issue_key(" ENG-42 ").unwrap(), "ENG-42");
        assert!(require_issue_key("").is_err());
        assert!(require_issue_key("ENG-42/../x").is_err());
    }

    #[test]
    fn jira_error_message_reads_both_shapes() {
        assert_eq!(
            jira_error_message(r#"{"errorMessages":["Issue does not exist"],"errors":{}}"#)
                .as_deref(),
            Some("Issue does not exist")
        );
        assert_eq!(
            jira_error_message(r#"{"errorMessages":[],"errors":{"jql":"Bad JQL"}}"#).as_deref(),
            Some("Bad JQL")
        );
    }
}
#[cfg(test)]
mod compatibility_tests {
    use super::*;

    #[test]
    fn upstream_requests_respect_service_backoff() {
        let config: JiraConfig = serde_json::from_value(json!({"site":"https://backoff-test.atlassian.net","email":"ada@example.test","token":"test"})).unwrap();
        let response = ureq::Response::new(429, "Too Many Requests", "{}").unwrap();
        assert!(read_jira_response(Err(ureq::Error::Status(429, response)), &config).is_err());
        assert!(check_backoff(&config).is_err());
        *BACKOFF.lock().unwrap() = None;
    }

    #[test]
    fn upstream_renderer_preserves_safe_links_and_content_limits() {
        let doc = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"link","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}]}]});
        assert_eq!(rich_text(Some(&doc)), "link");
        assert!(rich_text(Some(&json!("x".repeat(70_000)))).contains("Truncated"));
        let old: JiraConfig = serde_json::from_value(json!({"site":"https://team.atlassian.net","email":"ada@example.test","token":"test","account":"Ada","capabilities":["Jira","Confluence"]})).unwrap();
        assert_eq!(old.status().account_id, "email:ada@example.test");
        assert!(old.capabilities.iter().any(|c| c == "Confluence"));
        let upstream: JiraConfig = serde_json::from_value(
            json!({"site":"https://team.atlassian.net","email":"ada@example.test","token":"test"}),
        )
        .unwrap();
        assert_eq!(upstream.account_id(), old.account_id());
    }

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
        let rows = issue_pages(100, |limit, token| {
            calls.push((limit, token.to_string()));
            Ok(json!({"issues": vec![json!({"id":"1"}); 60], "nextPageToken": "next", "isLast": false}))
        }).unwrap();
        assert_eq!(rows.len(), 100);
        assert_eq!(calls, vec![(100, "".into()), (40, "next".into())]);
        let mut calls = 0;
        let rows = issue_pages(100, |_, _| {
            calls += 1;
            Ok(json!({"issues":[{"id":"1"}],"nextPageToken":"same"}))
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(rows.len(), 2);
        assert!(issue_pages(100, |_, _| Ok(json!({"unexpected":"secret"})))
            .unwrap_err()
            .contains("invalid issue list"));
        assert!(issue_pages(100, |_, _| Ok(json!({"issues":[]})))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn site_and_queries_validate_https_credentials_and_selected_ids() {
        assert_eq!(
            normalize_jira_site(" https://team.atlassian.net/ ").unwrap(),
            "https://team.atlassian.net"
        );
        for site in [
            "http://team.atlassian.net",
            "https://user:token@team.atlassian.net",
        ] {
            assert!(normalize_jira_site(site).is_err());
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
    #[test]
    fn subtask_parent_context_stops_before_epics() {
        let parent = json!({"id":"1","key":"APP-1","fields":{"summary":"Story","issuetype":{"subtask":false}}});
        let child = json!({"id":"2","key":"APP-2","fields":{"summary":"Task","issuetype":{"subtask":true},"parent":parent}});
        let parsed = parse_jira_issue(&child, "https://team.atlassian.net").unwrap();
        assert_eq!(parsed.parent.unwrap().identifier, "APP-1");
        let story = json!({"id":"3","key":"APP-3","fields":{"summary":"Story","issuetype":{"subtask":false},"parent":parent}});
        assert!(parse_jira_issue(&story, "https://team.atlassian.net")
            .unwrap()
            .parent
            .is_none());
    }
}
