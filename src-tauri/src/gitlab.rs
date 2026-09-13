use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::fs::clean_field;

const DEFAULT_GITLAB_URL: &str = "https://gitlab.com";
const DEFAULT_LIMIT: u32 = 40;
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
const USER_AGENT: &str = "MonoCode";
/// Shared with `read_gitlab_response` so callers can tell a denied endpoint
/// from a real failure.
const GITLAB_PERMISSION_ERROR: &str = "GitLab access token is invalid or lacks permission";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabStatus {
    pub connected: bool,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct GitlabConfig {
    pub(crate) url: String,
    pub(crate) token: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabLabel {
    pub name: String,
    pub color: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabAssignee {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabWorkItem {
    pub account: String,
    pub kind: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub updated_at: String,
    pub labels: Vec<GitlabLabel>,
    pub assignees: Vec<GitlabAssignee>,
    pub draft: bool,
    pub repo: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabWorkItemDetails {
    pub body: String,
    pub author: String,
    pub author_avatar_url: String,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub review_decision: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabWorkItemComment {
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
    /// GitLab reports which notes may be resolved; a resolved flag without
    /// it is never shown as actionable.
    pub resolvable: bool,
    pub thread_id: String,
    pub replies: Vec<GitlabWorkItemComment>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabWorkItemThread {
    pub comments: Vec<GitlabWorkItemComment>,
    pub truncated: bool,
    pub review_decision: String,
    pub base_ref_name: String,
    pub head_ref_name: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabMrFile {
    pub path: String,
    pub additions: i64,
    pub deletions: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabMrDiff {
    pub additions: i64,
    pub deletions: i64,
    pub files: Vec<GitlabMrFile>,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabMrPipeline {
    pub id: i64,
    pub sha: String,
    pub status: String,
    pub url: String,
}

/// One read of a merge request's review/merge/pipeline state for the review
/// surface and repair evidence. `head_sha` binds evidence to an exact
/// revision so a stale head is rejected before an agent is dispatched.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabMrState {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    /// The project this state was actually read from — lets the surface
    /// verify identity against a fresh resolution rather than a cache.
    pub repo: String,
    pub head_sha: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    /// `detailed_merge_status` when the instance provides it, else
    /// `merge_status`: can_be_merged, cannot_be_merged, checking…
    pub merge_status: String,
    /// False while unresolved resolvable discussions block the merge.
    pub blocking_discussions_resolved: bool,
    pub approvals_required: i64,
    pub approvals_left: i64,
    pub approved: bool,
    pub pipeline: Option<GitlabMrPipeline>,
}

#[tauri::command(async)]
pub fn gitlab_status(app: AppHandle) -> Result<GitlabStatus, String> {
    let config = read_config(&app)?;
    Ok(GitlabStatus {
        connected: config.is_some(),
        url: config
            .map(|config| config.url)
            .unwrap_or_else(|| DEFAULT_GITLAB_URL.into()),
    })
}

#[tauri::command]
pub async fn gitlab_set_config(
    app: AppHandle,
    url: String,
    token: String,
) -> Result<GitlabStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = normalize_gitlab_url(&url)?;
        let token = token.trim().to_string();
        if token.is_empty() {
            delete_config(&app)?;
            return Ok(GitlabStatus {
                connected: false,
                url,
            });
        }
        let config = GitlabConfig { url, token };
        let response = gitlab_get(&config, "/user")?;
        if response.value.get("id").and_then(Value::as_i64).is_none() {
            return Err("GitLab did not return the current user".into());
        }
        write_config(&app, &config)?;
        Ok(GitlabStatus {
            connected: true,
            url: config.url,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_repo(app: AppHandle, cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_list_work_items(
    app: AppHandle,
    cwd: String,
    kind: String,
    assigned_to_me: bool,
    state: String,
    limit: Option<u32>,
) -> Result<Vec<GitlabWorkItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        gitlab_list_work_items_for(
            &config,
            &repo,
            &kind,
            assigned_to_me,
            &state,
            limit.unwrap_or(DEFAULT_LIMIT),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_work_item_details(
    app: AppHandle,
    cwd: String,
    kind: String,
    number: i64,
) -> Result<GitlabWorkItemDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        gitlab_work_item_details_for(&config, &repo, &kind, number)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_work_item_thread(
    app: AppHandle,
    cwd: String,
    kind: String,
    number: i64,
) -> Result<GitlabWorkItemThread, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        gitlab_work_item_thread_for(&config, &repo, &kind, number)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_work_item_comment(
    app: AppHandle,
    cwd: String,
    kind: String,
    number: i64,
    body: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        gitlab_work_item_comment_for(&config, &repo, &kind, number, &body)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_issue_relations(
    app: AppHandle,
    cwd: String,
    kind: String,
    number: i64,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Validate before resolving the repo — an MR or bad number should not
        // pay for a `git config` subprocess just to return empty.
        validate_item(&kind, number)?;
        if kind == "pr" {
            return Ok(serde_json::json!({ "edges": [], "truncated": false }));
        }
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        gitlab_issue_relations_for(&config, &repo, &kind, number)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_mr_diff(
    app: AppHandle,
    cwd: String,
    number: i64,
) -> Result<GitlabMrDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        gitlab_mr_diff_for(&config, &repo, number)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The open merge request for a source branch — delivery rows bind to an
/// explicit `repo` + `number`, never a guessed listing.
#[tauri::command]
pub async fn gitlab_mr_for_branch(
    app: AppHandle,
    cwd: String,
    branch: String,
) -> Result<GitlabWorkItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = branch.trim().to_string();
        if branch.is_empty() || branch.len() > 255 || branch.chars().any(char::is_whitespace) {
            return Err("Invalid GitLab branch".into());
        }
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        let path = format!(
            "/projects/{}/merge_requests?source_branch={}&state=opened&order_by=updated_at&sort=desc&per_page=10",
            encode_path_component(&repo),
            encode_path_component(&branch)
        );
        let response = gitlab_get(&config, &path)?;
        let rows = response.value.as_array().cloned().unwrap_or_default();
        let row = prefer_same_project_mr(&rows)
            .cloned()
            .ok_or_else(|| "No open merge request for this branch".to_string())?;
        parse_work_items(&Value::Array(vec![row]), "pr", &repo)?
            .into_iter()
            .next()
            .ok_or_else(|| "No open merge request for this branch".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_mr_state(
    app: AppHandle,
    cwd: String,
    number: i64,
) -> Result<GitlabMrState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Validate before the git subprocess — a bad number must not pay for it.
        validate_item("pr", number)?;
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        gitlab_mr_state_for(&config, &repo, number)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_mr_discussions(
    app: AppHandle,
    cwd: String,
    number: i64,
) -> Result<GitlabWorkItemThread, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_item("pr", number)?;
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        gitlab_mr_discussions_for(&config, &repo, number)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_mr_discussion_reply(
    app: AppHandle,
    cwd: String,
    number: i64,
    discussion_id: String,
    body: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_item("pr", number)?;
        let discussion = validate_discussion_id(&discussion_id)?;
        let body = body.trim();
        if body.is_empty() {
            return Err("Reply cannot be empty".into());
        }
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        let path = format!(
            "{}/discussions/{discussion}/notes",
            item_path(&repo, "pr", number)
        );
        let response = gitlab_post_form(&config, &path, &[("body", body)])?;
        let id = response
            .value
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "GitLab did not return a reply".to_string())?;
        Ok(note_url(&config.url, &repo, "pr", number, id))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gitlab_mr_discussion_resolve(
    app: AppHandle,
    cwd: String,
    number: i64,
    discussion_id: String,
    resolved: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_item("pr", number)?;
        let discussion = validate_discussion_id(&discussion_id)?;
        let config = require_config(&app)?;
        let repo = gitlab_repo_for(&crate::fs::expand_home(&cwd), &config.url)?;
        let path = format!(
            "{}/discussions/{discussion}",
            item_path(&repo, "pr", number)
        );
        gitlab_put_form(
            &config,
            &path,
            &[("resolved", if resolved { "true" } else { "false" })],
        )?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn gitlab_list_work_items_for(
    config: &GitlabConfig,
    repo: &str,
    kind: &str,
    assigned_to_me: bool,
    state: &str,
    limit: u32,
) -> Result<Vec<GitlabWorkItem>, String> {
    validate_kind(kind)?;
    let resource = resource_for_kind(kind);
    let state = if state.trim().eq_ignore_ascii_case("all") {
        "all"
    } else {
        "opened"
    };
    let limit = limit.clamp(1, 100);
    let assigned = if assigned_to_me {
        "&scope=assigned_to_me"
    } else {
        "&scope=all"
    };
    let path = format!(
        "/projects/{}/{resource}?state={state}&order_by=updated_at&sort=desc&per_page={limit}&with_labels_details=true{assigned}",
        encode_path_component(repo)
    );
    let response = gitlab_get(config, &path)?;
    let mut items = parse_work_items(&response.value, kind, repo)?;
    if !items.is_empty() {
        let account = gitlab_get(config, "/user")
            .ok()
            .and_then(|response| response.value["id"].as_i64())
            .map(|id| format!("{}:{id}", config.url))
            .unwrap_or_default();
        for item in &mut items {
            item.account.clone_from(&account);
        }
    }
    Ok(items)
}

fn gitlab_work_item_details_for(
    config: &GitlabConfig,
    repo: &str,
    kind: &str,
    number: i64,
) -> Result<GitlabWorkItemDetails, String> {
    validate_item(kind, number)?;
    let path = item_path(repo, kind, number);
    let response = gitlab_get(config, &path)?;
    parse_work_item_details(&response.value, kind)
}

fn gitlab_work_item_thread_for(
    config: &GitlabConfig,
    repo: &str,
    kind: &str,
    number: i64,
) -> Result<GitlabWorkItemThread, String> {
    validate_item(kind, number)?;
    let path = format!(
        "{}/notes?order_by=created_at&sort=desc&per_page=100",
        item_path(repo, kind, number)
    );
    let response = gitlab_get(config, &path)?;
    parse_work_item_thread(
        &response.value,
        &config.url,
        repo,
        kind,
        number,
        response.has_next_page,
    )
}

fn gitlab_work_item_comment_for(
    config: &GitlabConfig,
    repo: &str,
    kind: &str,
    number: i64,
    body: &str,
) -> Result<String, String> {
    validate_item(kind, number)?;
    let body = body.trim();
    if body.is_empty() {
        return Err("Comment cannot be empty".into());
    }
    let path = format!("{}/notes", item_path(repo, kind, number));
    let response = gitlab_post_form(config, &path, &[("body", body)])?;
    let id = response
        .value
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "GitLab did not return a comment".to_string())?;
    Ok(note_url(&config.url, repo, kind, number, id))
}

fn gitlab_link_group(link_type: &str) -> (&'static str, &'static str) {
    match link_type {
        "blocks" => ("blocks", "Blocks"),
        "is_blocked_by" => ("blocked-by", "Is blocked by"),
        _ => ("related", "Relates to"),
    }
}

fn gitlab_issue_relations_for(
    config: &GitlabConfig,
    repo: &str,
    kind: &str,
    number: i64,
) -> Result<Value, String> {
    validate_item(kind, number)?;
    // Merge requests expose no linked-item API; only issues carry links.
    if kind == "pr" {
        return Ok(serde_json::json!({ "edges": [], "truncated": false }));
    }
    let path = format!("{}/links?per_page=50", item_path(repo, kind, number));
    let response = gitlab_get(config, &path)?;
    let rows = response
        .value
        .as_array()
        .ok_or_else(|| "GitLab did not return linked issues".to_string())?;
    let edges: Vec<Value> = rows
        .iter()
        .take(50)
        .filter_map(|row| {
            let iid = row.get("iid").and_then(Value::as_i64)?;
            if iid <= 0 {
                return None;
            }
            let (key, label) =
                gitlab_link_group(row.get("link_type").and_then(Value::as_str).unwrap_or(""));
            let reference = row
                .pointer("/references/full")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let linked_repo = reference
                .rsplit_once('#')
                .map(|(path, _)| path.trim().to_string())
                .filter(|path| !path.is_empty());
            // An unresolvable reference cannot prove same-project identity —
            // fail safe and render the row display-only.
            let foreign = linked_repo
                .as_deref()
                .is_none_or(|path| !path.eq_ignore_ascii_case(repo));
            Some(serde_json::json!({
                "key": key,
                "label": label,
                "ref": format!("#{iid}"),
                "foreign": foreign,
                "item": {
                    "number": iid,
                    "title": string_field(row, "title").unwrap_or_default(),
                    "url": string_field(row, "web_url").unwrap_or_default(),
                    "state": normalize_state(&string_field(row, "state").unwrap_or_default()),
                    "updatedAt": string_field(row, "updated_at").unwrap_or_default(),
                    "repo": linked_repo.unwrap_or_else(|| repo.to_string()),
                },
            }))
        })
        .collect();
    Ok(serde_json::json!({
        "edges": edges,
        "truncated": response.has_next_page,
    }))
}

/// `source_branch` also matches MRs opened from forks — prefer the MR
/// whose source project is this project. Both ids must be present for the
/// equality to mean anything.
fn prefer_same_project_mr(rows: &[Value]) -> Option<&Value> {
    rows.iter()
        .find(|row| {
            matches!(
                (
                    row.get("source_project_id").and_then(Value::as_i64),
                    row.get("project_id").and_then(Value::as_i64),
                ),
                (Some(source), Some(target)) if source == target
            )
        })
        .or_else(|| rows.first())
}

fn gitlab_mr_diff_for(
    config: &GitlabConfig,
    repo: &str,
    number: i64,
) -> Result<GitlabMrDiff, String> {
    validate_item("pr", number)?;
    let path = format!(
        "/projects/{}/merge_requests/{number}/diffs?per_page=100",
        encode_path_component(repo)
    );
    let response = gitlab_get(config, &path)?;
    parse_mr_diff(&response.value, response.has_next_page)
}

fn gitlab_mr_state_for(
    config: &GitlabConfig,
    repo: &str,
    number: i64,
) -> Result<GitlabMrState, String> {
    validate_item("pr", number)?;
    let response = gitlab_get(config, &item_path(repo, "pr", number))?;
    let value = &response.value;
    if value.get("iid").and_then(Value::as_i64) != Some(number) {
        return Err("GitLab returned a different merge request".into());
    }
    // Approvals need a second read. A denied endpoint (free tier, reporter
    // role) or an absent one (older instances) must not hide the MR — but a
    // real request failure should surface.
    let approvals = match gitlab_get_optional(
        config,
        &format!("{}/approvals", item_path(repo, "pr", number)),
    ) {
        Ok(response) => response.value,
        Err(error) if error == GITLAB_PERMISSION_ERROR => Value::Null,
        Err(error) => return Err(error),
    };
    // `head_pipeline` rides on the MR response on modern instances; older
    // ones omit the key entirely and need the pipelines list. A present-but-
    // null value means the MR simply has no pipeline — don't refetch. The
    // list can lead with a non-head run, so only attach a pipeline that
    // built this head.
    let pipeline = match value.get("head_pipeline") {
        Some(head) => parse_mr_pipeline(Some(head)),
        None => {
            let head_sha = string_field(value, "sha").unwrap_or_default();
            gitlab_get(
                config,
                &format!("{}/pipelines?per_page=1", item_path(repo, "pr", number)),
            )
            .ok()
            .and_then(|response| {
                response
                    .value
                    .as_array()
                    .and_then(|rows| rows.first())
                    .and_then(|row| parse_mr_pipeline(Some(row)))
                    .filter(|pipeline| pipeline.sha.is_empty() || pipeline.sha == head_sha)
            })
        }
    };
    parse_mr_state(value, number, repo, &approvals, pipeline)
}

/// GitLab's draft signals: the `draft`/`work_in_progress` flags plus the
/// documented title prefixes instances older than the fields still carry.
fn mr_is_draft(row: &Value, title: &str) -> bool {
    let title = title.trim_start().to_ascii_lowercase();
    row.get("draft").and_then(Value::as_bool).unwrap_or(false)
        || row
            .get("work_in_progress")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || title == "draft"
        || title == "wip"
        || title.starts_with("draft:")
        || title.starts_with("[draft]")
        || title.starts_with("(draft)")
        || title.starts_with("draft -")
        || title.starts_with("wip:")
        || title.starts_with("[wip]")
        || title.starts_with("(wip)")
        || title.starts_with("wip -")
}

fn parse_mr_state(
    value: &Value,
    number: i64,
    repo: &str,
    approvals: &Value,
    pipeline: Option<GitlabMrPipeline>,
) -> Result<GitlabMrState, String> {
    let title = string_field(value, "title").unwrap_or_default();
    Ok(GitlabMrState {
        number,
        title: clean_field(&title, 500),
        url: string_field(value, "web_url")
            .map(|url| clean_field(&url, 500))
            .unwrap_or_default(),
        state: normalize_state(&string_field(value, "state").unwrap_or_default()),
        draft: mr_is_draft(value, &title),
        repo: repo.to_string(),
        head_sha: string_field(value, "sha").unwrap_or_default(),
        head_ref_name: string_field(value, "source_branch").unwrap_or_default(),
        base_ref_name: string_field(value, "target_branch").unwrap_or_default(),
        merge_status: string_field(value, "detailed_merge_status")
            .or_else(|| string_field(value, "merge_status"))
            .unwrap_or_default(),
        blocking_discussions_resolved: value
            .get("blocking_discussions_resolved")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        approvals_required: approvals
            .get("approvals_required")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        approvals_left: approvals
            .get("approvals_left")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        approved: approvals
            .get("approved")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pipeline,
    })
}

fn parse_mr_pipeline(row: Option<&Value>) -> Option<GitlabMrPipeline> {
    let row = row.filter(|row| row.is_object())?;
    let id = row.get("id").and_then(Value::as_i64)?;
    if id <= 0 {
        return None;
    }
    Some(GitlabMrPipeline {
        id,
        sha: string_field(row, "sha").unwrap_or_default(),
        status: string_field(row, "status").unwrap_or_default(),
        url: string_field(row, "web_url").unwrap_or_default(),
    })
}

fn gitlab_mr_discussions_for(
    config: &GitlabConfig,
    repo: &str,
    number: i64,
) -> Result<GitlabWorkItemThread, String> {
    validate_item("pr", number)?;
    // The discussions endpoint ignores sort/order_by and always pages
    // oldest-first, so every page has to be walked — the newest review
    // feedback sits on the last one. The bound keeps a runaway thread
    // count from pinning the request; `truncated` then means the newest
    // discussions are missing.
    const MAX_DISCUSSION_PAGES: u32 = 10;
    let mut rows = Vec::new();
    let mut truncated = true;
    for page in 1..=MAX_DISCUSSION_PAGES {
        let path = format!(
            "{}/discussions?per_page=100&page={page}",
            item_path(repo, "pr", number)
        );
        let response = gitlab_get(config, &path)?;
        let has_next_page = response.has_next_page;
        match response.value.as_array() {
            Some(page_rows) => rows.extend_from_slice(page_rows),
            None => return Err("GitLab did not return discussions".into()),
        }
        if !has_next_page {
            truncated = false;
            break;
        }
    }
    parse_mr_discussions(&Value::Array(rows), &config.url, repo, number, truncated)
}

fn parse_mr_discussions(
    value: &Value,
    base_url: &str,
    repo: &str,
    number: i64,
    truncated: bool,
) -> Result<GitlabWorkItemThread, String> {
    let rows = value
        .as_array()
        .ok_or_else(|| "GitLab did not return discussions".to_string())?;
    let mut comments = Vec::new();
    for discussion in rows {
        let discussion_id = string_field(discussion, "id").unwrap_or_default();
        // `individual_note` marks a standalone comment — anything else is a
        // discussion thread, including resolvable threads without a diff
        // position, which still block the merge.
        let discussion_kind = if discussion
            .get("individual_note")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "comment"
        } else {
            "review"
        };
        let notes = match discussion.get("notes").and_then(Value::as_array) {
            Some(notes) => notes,
            None => continue,
        };
        let mut thread_comments = Vec::new();
        for note in notes {
            if note.get("system").and_then(Value::as_bool).unwrap_or(false) {
                continue;
            }
            let Some(id) = note.get("id").and_then(Value::as_i64) else {
                continue;
            };
            let position = note.get("position").filter(|p| p.is_object());
            let (path, line) = position
                .map(|position| {
                    (
                        string_field(position, "new_path")
                            .or_else(|| string_field(position, "old_path"))
                            .unwrap_or_default(),
                        position
                            .get("new_line")
                            .and_then(Value::as_i64)
                            .or_else(|| position.get("old_line").and_then(Value::as_i64)),
                    )
                })
                .unwrap_or_default();
            let author = note.get("author");
            thread_comments.push(GitlabWorkItemComment {
                id: id.to_string(),
                kind: discussion_kind.into(),
                author: author
                    .and_then(|author| string_field(author, "username"))
                    .or_else(|| author.and_then(|author| string_field(author, "name")))
                    .map(|author| clean_field(&author, 200))
                    .unwrap_or_default(),
                author_avatar_url: author
                    .and_then(|author| string_field(author, "avatar_url"))
                    .map(|url| clean_field(&url, 500))
                    .unwrap_or_default(),
                body: string_field(note, "body")
                    .map(|body| clean_field(&body, 2000))
                    .unwrap_or_default(),
                created_at: string_field(note, "created_at").unwrap_or_default(),
                url: note_url(base_url, repo, "pr", number, id),
                state: String::new(),
                path,
                line,
                resolved: note
                    .get("resolved")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                resolvable: note
                    .get("resolvable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                thread_id: discussion_id.clone(),
                replies: Vec::new(),
            });
        }
        if !thread_comments.is_empty() {
            let mut first = thread_comments.remove(0);
            first.replies = thread_comments;
            comments.push(first);
        }
    }
    Ok(GitlabWorkItemThread {
        comments,
        truncated,
        review_decision: String::new(),
        base_ref_name: String::new(),
        head_ref_name: String::new(),
    })
}

/// Discussion ids become a URL path segment — accept only the hex/opaque
/// form GitLab returns, never slashes or whitespace.
fn validate_discussion_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid GitLab discussion".into());
    }
    Ok(id.to_string())
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if kind == "issue" || kind == "pr" {
        Ok(())
    } else {
        Err("Unknown GitLab task kind".into())
    }
}

fn validate_item(kind: &str, number: i64) -> Result<(), String> {
    validate_kind(kind)?;
    if number <= 0 {
        return Err("Invalid GitLab item number".into());
    }
    Ok(())
}

fn resource_for_kind(kind: &str) -> &'static str {
    if kind == "pr" {
        "merge_requests"
    } else {
        "issues"
    }
}

fn item_path(repo: &str, kind: &str, number: i64) -> String {
    format!(
        "/projects/{}/{}/{number}",
        encode_path_component(repo),
        resource_for_kind(kind)
    )
}

fn parse_work_items(value: &Value, kind: &str, repo: &str) -> Result<Vec<GitlabWorkItem>, String> {
    let rows = value
        .as_array()
        .ok_or_else(|| "GitLab did not return work items".to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| parse_work_item(row, kind, repo))
        .collect())
}

fn parse_work_item(row: &Value, kind: &str, repo: &str) -> Option<GitlabWorkItem> {
    let number = row.get("iid").and_then(Value::as_i64)?;
    if number <= 0 {
        return None;
    }
    let title = string_field(row, "title").unwrap_or_default();
    let draft = kind == "pr" && mr_is_draft(row, &title);
    Some(GitlabWorkItem {
        account: String::new(),
        kind: kind.into(),
        number,
        title: clean_field(&title, 500),
        url: string_field(row, "web_url")
            .map(|url| clean_field(&url, 500))
            .unwrap_or_default(),
        state: normalize_state(&string_field(row, "state").unwrap_or_default()),
        updated_at: string_field(row, "updated_at").unwrap_or_default(),
        labels: parse_labels(row),
        assignees: parse_assignees(row),
        draft,
        repo: repo.into(),
    })
}

fn parse_work_item_details(value: &Value, kind: &str) -> Result<GitlabWorkItemDetails, String> {
    if !value.is_object() {
        return Err("GitLab did not return that item".into());
    }
    let author = value.get("author");
    Ok(GitlabWorkItemDetails {
        body: string_field(value, "description")
            .map(|body| clean_field(&body, 2000))
            .unwrap_or_default(),
        author: author
            .and_then(|author| string_field(author, "username"))
            .or_else(|| author.and_then(|author| string_field(author, "name")))
            .map(|author| clean_field(&author, 200))
            .unwrap_or_default(),
        author_avatar_url: author
            .and_then(|author| string_field(author, "avatar_url"))
            .map(|url| clean_field(&url, 500))
            .unwrap_or_default(),
        base_ref_name: if kind == "pr" {
            string_field(value, "target_branch").unwrap_or_default()
        } else {
            String::new()
        },
        head_ref_name: if kind == "pr" {
            string_field(value, "source_branch").unwrap_or_default()
        } else {
            String::new()
        },
        review_decision: String::new(),
    })
}

fn parse_work_item_thread(
    value: &Value,
    base_url: &str,
    repo: &str,
    kind: &str,
    number: i64,
    has_next_page: bool,
) -> Result<GitlabWorkItemThread, String> {
    let rows = value
        .as_array()
        .ok_or_else(|| "GitLab did not return comments".to_string())?;
    let mut comments: Vec<GitlabWorkItemComment> = rows
        .iter()
        .filter(|row| !row.get("system").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|row| {
            let id = row.get("id").and_then(Value::as_i64)?;
            let author = row.get("author");
            Some(GitlabWorkItemComment {
                id: id.to_string(),
                kind: "comment".into(),
                author: author
                    .and_then(|author| string_field(author, "username"))
                    .or_else(|| author.and_then(|author| string_field(author, "name")))
                    .map(|author| clean_field(&author, 200))
                    .unwrap_or_default(),
                author_avatar_url: author
                    .and_then(|author| string_field(author, "avatar_url"))
                    .map(|url| clean_field(&url, 500))
                    .unwrap_or_default(),
                body: string_field(row, "body")
                    .map(|body| clean_field(&body, 2000))
                    .unwrap_or_default(),
                created_at: string_field(row, "created_at").unwrap_or_default(),
                url: note_url(base_url, repo, kind, number, id),
                state: String::new(),
                path: String::new(),
                line: None,
                resolved: row
                    .get("resolved")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                resolvable: row
                    .get("resolvable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                thread_id: String::new(),
                replies: Vec::new(),
            })
        })
        .collect();
    comments.reverse();
    Ok(GitlabWorkItemThread {
        comments,
        truncated: has_next_page,
        review_decision: String::new(),
        base_ref_name: String::new(),
        head_ref_name: String::new(),
    })
}

fn parse_mr_diff(value: &Value, has_next_page: bool) -> Result<GitlabMrDiff, String> {
    let rows = value
        .as_array()
        .ok_or_else(|| "GitLab did not return merge request diffs".to_string())?;
    let mut files = Vec::new();
    let mut patch = String::new();
    let mut total_additions = 0;
    let mut total_deletions = 0;
    let mut truncated = has_next_page;

    for row in rows {
        let old_path = string_field(row, "old_path").unwrap_or_default();
        let new_path = string_field(row, "new_path").unwrap_or_else(|| old_path.clone());
        if new_path.is_empty() && old_path.is_empty() {
            continue;
        }
        let diff = string_field_preserve(row, "diff").unwrap_or_default();
        let (additions, deletions) = diff_counts(&diff);
        total_additions += additions;
        total_deletions += deletions;
        files.push(GitlabMrFile {
            path: if new_path.is_empty() {
                old_path.clone()
            } else {
                new_path.clone()
            },
            additions,
            deletions,
        });
        truncated |= row
            .get("too_large")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || row
                .get("collapsed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        if diff.is_empty() || patch.len() >= MAX_DIFF_BYTES {
            continue;
        }
        let block = gitlab_diff_block(row, &old_path, &new_path, &diff);
        if patch.len() + block.len() > MAX_DIFF_BYTES {
            truncated = true;
            continue;
        }
        patch.push_str(&block);
    }

    Ok(GitlabMrDiff {
        additions: total_additions,
        deletions: total_deletions,
        files,
        patch,
        truncated,
    })
}

fn gitlab_diff_block(row: &Value, old_path: &str, new_path: &str, diff: &str) -> String {
    let old = if old_path.is_empty() {
        new_path
    } else {
        old_path
    };
    let new = if new_path.is_empty() {
        old_path
    } else {
        new_path
    };
    let mut block = format!("diff --git a/{old} b/{new}\n");
    if row
        .get("new_file")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        block.push_str("new file mode 100644\n");
    }
    if row
        .get("deleted_file")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        block.push_str("deleted file mode 100644\n");
    }
    if row
        .get("renamed_file")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        block.push_str(&format!("rename from {old}\nrename to {new}\n"));
    }
    let old_header = if row
        .get("new_file")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        "/dev/null".to_string()
    } else {
        format!("a/{old}")
    };
    let new_header = if row
        .get("deleted_file")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        "/dev/null".to_string()
    } else {
        format!("b/{new}")
    };
    block.push_str(&format!("--- {old_header}\n+++ {new_header}\n"));
    block.push_str(diff);
    if !diff.ends_with('\n') {
        block.push('\n');
    }
    block
}

fn diff_counts(diff: &str) -> (i64, i64) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

fn parse_labels(row: &Value) -> Vec<GitlabLabel> {
    row.get("labels")
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .filter_map(|label| {
                    if let Some(name) = label.as_str() {
                        return Some(GitlabLabel {
                            name: name.trim().to_string(),
                            color: String::new(),
                        });
                    }
                    let name = string_field(label, "name")?;
                    Some(GitlabLabel {
                        name,
                        color: string_field(label, "color")
                            .unwrap_or_default()
                            .trim_start_matches('#')
                            .to_string(),
                    })
                })
                .filter(|label| !label.name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn parse_assignees(row: &Value) -> Vec<GitlabAssignee> {
    let mut people: Vec<&Value> = row
        .get("assignees")
        .and_then(Value::as_array)
        .map(|people| people.iter().collect())
        .unwrap_or_default();
    if people.is_empty() {
        if let Some(assignee) = row.get("assignee").filter(|value| value.is_object()) {
            people.push(assignee);
        }
    }
    people
        .into_iter()
        .filter_map(|person| {
            let login =
                string_field(person, "username").or_else(|| string_field(person, "name"))?;
            if login.is_empty() {
                return None;
            }
            Some(GitlabAssignee {
                login,
                avatar_url: string_field(person, "avatar_url").unwrap_or_default(),
            })
        })
        .collect()
}

fn normalize_state(state: &str) -> String {
    match state.trim().to_ascii_lowercase().as_str() {
        "opened" | "reopened" => "open".into(),
        other => other.into(),
    }
}

fn note_url(base_url: &str, repo: &str, kind: &str, number: i64, id: i64) -> String {
    let item = if kind == "pr" {
        "merge_requests"
    } else {
        "issues"
    };
    format!(
        "{}/{repo}/-/{item}/{number}#note_{id}",
        base_url.trim_end_matches('/')
    )
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
}

fn string_field_preserve(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

pub(crate) struct GitlabResponse {
    pub(crate) value: Value,
    pub(crate) has_next_page: bool,
}

pub(crate) fn gitlab_get(config: &GitlabConfig, path: &str) -> Result<GitlabResponse, String> {
    let url = format!("{}/api/v4{}", config.url.trim_end_matches('/'), path);
    read_gitlab_response(
        gitlab_agent()
            .get(&url)
            .set("PRIVATE-TOKEN", &config.token)
            .set("Accept", "application/json")
            .set("User-Agent", USER_AGENT)
            .call(),
    )
}

/// Like `gitlab_get`, but a 404 — the endpoint does not exist on this
/// instance — yields an empty value instead of an error.
fn gitlab_get_optional(config: &GitlabConfig, path: &str) -> Result<GitlabResponse, String> {
    let url = format!("{}/api/v4{}", config.url.trim_end_matches('/'), path);
    let result = gitlab_agent()
        .get(&url)
        .set("PRIVATE-TOKEN", &config.token)
        .set("Accept", "application/json")
        .set("User-Agent", USER_AGENT)
        .call();
    match result {
        Err(ureq::Error::Status(404, _)) => Ok(GitlabResponse {
            value: Value::Null,
            has_next_page: false,
        }),
        result => read_gitlab_response(result),
    }
}

fn gitlab_post_form(
    config: &GitlabConfig,
    path: &str,
    fields: &[(&str, &str)],
) -> Result<GitlabResponse, String> {
    let url = format!("{}/api/v4{}", config.url.trim_end_matches('/'), path);
    read_gitlab_response(
        gitlab_agent()
            .post(&url)
            .set("PRIVATE-TOKEN", &config.token)
            .set("Accept", "application/json")
            .set("User-Agent", USER_AGENT)
            .send_form(fields),
    )
}

fn gitlab_put_form(
    config: &GitlabConfig,
    path: &str,
    fields: &[(&str, &str)],
) -> Result<GitlabResponse, String> {
    let url = format!("{}/api/v4{}", config.url.trim_end_matches('/'), path);
    read_gitlab_response(
        gitlab_agent()
            .put(&url)
            .set("PRIVATE-TOKEN", &config.token)
            .set("Accept", "application/json")
            .set("User-Agent", USER_AGENT)
            .send_form(fields),
    )
}

fn gitlab_agent() -> ureq::Agent {
    // One agent keeps a connection pool — MR state makes up to three
    // requests and should not pay a TLS handshake each time.
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT
        .get_or_init(|| {
            ureq::AgentBuilder::new()
                .timeout(HTTP_TIMEOUT)
                .redirects(0)
                .build()
        })
        .clone()
}

fn read_gitlab_response(
    result: Result<ureq::Response, ureq::Error>,
) -> Result<GitlabResponse, String> {
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => {
            return Err(GITLAB_PERMISSION_ERROR.into());
        }
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            return Err(gitlab_http_error(status, &body));
        }
        Err(_) => return Err("Could not reach GitLab".into()),
    };
    let status = response.status();
    let has_next_page = response
        .header("X-Next-Page")
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let body = response
        .into_string()
        .map_err(|_| "GitLab returned an unreadable response".to_string())?;
    if !(200..300).contains(&status) {
        return Err(gitlab_http_error(status, &body));
    }
    let value =
        serde_json::from_str(&body).map_err(|_| "GitLab returned invalid JSON".to_string())?;
    Ok(GitlabResponse {
        value,
        has_next_page,
    })
}

fn gitlab_http_error(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body).ok().and_then(|value| {
        value
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| value.get("error").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    });
    message.unwrap_or_else(|| format!("GitLab request failed ({status})"))
}

fn normalize_gitlab_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let raw = if raw.is_empty() {
        DEFAULT_GITLAB_URL
    } else {
        raw
    };
    if raw.contains("://") && !raw.starts_with("https://") && !raw.starts_with("http://") {
        return Err("GitLab URL must use HTTP or HTTPS".into());
    }
    let value = if raw.starts_with("https://") || raw.starts_with("http://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let (_, rest) = value
        .split_once("://")
        .ok_or_else(|| "GitLab URL must use HTTP or HTTPS".to_string())?;
    let path = rest.split_once('/').map(|(_, path)| path).unwrap_or("");
    if rest.is_empty()
        || rest.starts_with('/')
        || rest.contains('@')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('\\')
        || rest.chars().any(char::is_whitespace)
        || path.split('/').any(|segment| {
            matches!(
                segment.to_ascii_lowercase().as_str(),
                "." | ".." | "%2e" | "%2e%2e" | "%2e." | ".%2e"
            )
        })
    {
        return Err("GitLab URL is invalid".into());
    }
    let normalized = value.trim_end_matches('/');
    let normalized = normalized.strip_suffix("/api/v4").unwrap_or(normalized);
    Ok(normalized.trim_end_matches('/').to_string())
}

fn encode_path_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn gitlab_repo_for(root: &Path, gitlab_url: &str) -> Result<String, String> {
    // Routes through the shared Git runner so WSL checkouts resolve inside
    // their distro and Windows never flashes a console window — and the
    // runner error propagates, since the WSL bridge message ("WSL is not
    // connected…") is more actionable than a generic failure.
    let output =
        crate::fs::git_command_output(root, &["config", "--get-regexp", r"^remote\..*\.url$"])?;
    if (!output.status.success() && output.status.code() != Some(1))
        || output.stdout.len() > 64 * 1024
    {
        return Err("Could not read git remotes".into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut matches = Vec::new();
    for line in stdout.lines() {
        let Some((name, remote)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        if let Some(repo) = project_from_remote(remote.trim(), gitlab_url) {
            matches.push((name == "remote.origin.url", repo));
        }
    }
    matches
        .iter()
        .find(|(origin, _)| *origin)
        .or_else(|| matches.first())
        .map(|(_, repo)| repo.clone())
        .ok_or_else(|| "No GitLab remote matches the configured host".to_string())
}

fn project_from_remote(remote: &str, gitlab_url: &str) -> Option<String> {
    let configured = configured_remote(gitlab_url)?;
    let (authority, mut path) = remote_authority_path(remote)?;
    if host_without_port(&authority) != host_without_port(&configured.authority) {
        return None;
    }
    path = path.trim_matches('/').to_string();
    let prefix = configured.path.trim_matches('/');
    if !prefix.is_empty() {
        path = path.strip_prefix(&format!("{prefix}/"))?.to_string();
    }
    if let Some(stripped) = path.strip_suffix(".git") {
        path = stripped.to_string();
    }
    if !valid_project_path(&path) {
        return None;
    }
    Some(path)
}

struct ConfiguredRemote {
    authority: String,
    path: String,
}

fn configured_remote(url: &str) -> Option<ConfiguredRemote> {
    let normalized = normalize_gitlab_url(url).ok()?;
    let (_, rest) = normalized.split_once("://")?;
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    Some(ConfiguredRemote {
        authority: authority.to_ascii_lowercase(),
        path: path.to_string(),
    })
}

fn remote_authority_path(remote: &str) -> Option<(String, String)> {
    let remote = remote.trim();
    if let Some((_, rest)) = remote.split_once("://") {
        let (authority, path) = rest.split_once('/')?;
        let authority = authority.rsplit('@').next()?.to_ascii_lowercase();
        return Some((authority, path.to_string()));
    }
    let (user_host, path) = remote.split_once(':')?;
    let authority = user_host.rsplit('@').next()?.to_ascii_lowercase();
    Some((authority, path.to_string()))
}

fn host_without_port(authority: &str) -> String {
    let authority = authority.trim().to_ascii_lowercase();
    if authority.starts_with('[') {
        return authority
            .split(']')
            .next()
            .map(|host| format!("{host}]"))
            .unwrap_or(authority);
    }
    authority
        .split(':')
        .next()
        .unwrap_or(&authority)
        .to_string()
}

fn valid_project_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    parts.len() >= 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && !part.chars().any(char::is_whitespace)
                && !part.contains(['?', '#', '\\'])
        })
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("gitlab-config.json"))
}

fn read_config(app: &AppHandle) -> Result<Option<GitlabConfig>, String> {
    let path = config_path(app)?;
    match fs::read_to_string(path) {
        Ok(raw) => {
            let mut config: GitlabConfig = serde_json::from_str(&raw)
                .map_err(|_| "GitLab settings are invalid".to_string())?;
            config.url = normalize_gitlab_url(&config.url)?;
            config.token = config.token.trim().to_string();
            if config.token.is_empty() {
                Ok(None)
            } else {
                Ok(Some(config))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn require_config(app: &AppHandle) -> Result<GitlabConfig, String> {
    read_config(app)?.ok_or_else(|| "Connect GitLab in Settings".to_string())
}

fn write_config(app: &AppHandle, config: &GitlabConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let value = serde_json::to_string(config).map_err(|error| error.to_string())?;
    write_secret_file(&path, &value)
}

fn delete_config(app: &AppHandle) -> Result<(), String> {
    let path = config_path(app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn write_secret_file(path: &Path, value: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| error.to_string())?;
        file.write_all(value.as_bytes())
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, value).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_host_and_api_suffix() {
        assert_eq!(normalize_gitlab_url("").unwrap(), "https://gitlab.com");
        assert_eq!(
            normalize_gitlab_url("gitlab.example.com/").unwrap(),
            "https://gitlab.example.com"
        );
        assert_eq!(
            normalize_gitlab_url("https://gitlab.example.com/api/v4").unwrap(),
            "https://gitlab.example.com"
        );
        assert!(normalize_gitlab_url("ftp://gitlab.example.com").is_err());
        assert!(normalize_gitlab_url("https://user@host").is_err());
        assert!(normalize_gitlab_url("https://host/../admin").is_err());
    }

    #[test]
    fn reads_https_and_ssh_project_remotes() {
        assert_eq!(
            project_from_remote(
                "https://gitlab.example.com/acme/platform/web.git",
                "https://gitlab.example.com"
            )
            .as_deref(),
            Some("acme/platform/web")
        );
        assert_eq!(
            project_from_remote(
                "git@gitlab.example.com:acme/web.git",
                "https://gitlab.example.com"
            )
            .as_deref(),
            Some("acme/web")
        );
        assert_eq!(
            project_from_remote(
                "ssh://git@gitlab.example.com/acme/web.git",
                "https://gitlab.example.com"
            )
            .as_deref(),
            Some("acme/web")
        );
        assert!(
            project_from_remote("git@github.com:acme/web.git", "https://gitlab.example.com")
                .is_none()
        );
    }

    #[test]
    fn reads_relative_url_root_remotes() {
        assert_eq!(
            project_from_remote(
                "https://code.example.com/gitlab/acme/web.git",
                "https://code.example.com/gitlab"
            )
            .as_deref(),
            Some("acme/web")
        );
        assert!(project_from_remote(
            "https://code.example.com/gitlab-old/acme/web.git",
            "https://code.example.com/gitlab"
        )
        .is_none());
    }

    #[test]
    fn encodes_project_path_for_api() {
        assert_eq!(
            encode_path_component("acme/platform web"),
            "acme%2Fplatform%20web"
        );
    }

    #[test]
    fn parses_issue_and_merge_request_fields() {
        let rows = json!([{
            "iid": 9,
            "title": "Draft: Improve login",
            "web_url": "https://gitlab.example.com/acme/web/-/merge_requests/9",
            "state": "opened",
            "updated_at": "2026-09-09T10:00:00Z",
            "labels": [{ "name": "bug", "color": "#ff0000" }],
            "assignees": [{ "username": "maya", "avatar_url": "https://gitlab.example.com/uploads/maya.png" }]
        }]);
        let items = parse_work_items(&rows, "pr", "acme/web").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "pr");
        assert_eq!(items[0].state, "open");
        assert!(items[0].draft);
        assert_eq!(items[0].labels[0].color, "ff0000");
        assert_eq!(items[0].assignees[0].login, "maya");
    }

    #[test]
    fn parses_details_and_comments() {
        let details = parse_work_item_details(
            &json!({
                "description": "Body",
                "author": { "username": "maya", "avatar_url": "https://example.com/maya.png" },
                "target_branch": "main",
                "source_branch": "feature"
            }),
            "pr",
        )
        .unwrap();
        assert_eq!(details.author, "maya");
        assert_eq!(details.base_ref_name, "main");
        assert_eq!(details.head_ref_name, "feature");

        let thread = parse_work_item_thread(
            &json!([
                { "id": 1, "body": "Started", "system": true },
                {
                    "id": 2,
                    "body": "Looks good",
                    "created_at": "2026-09-09T10:00:00Z",
                    "author": { "username": "ada" },
                    "system": false
                }
            ]),
            "https://gitlab.example.com",
            "acme/web",
            "pr",
            9,
            true,
        )
        .unwrap();
        assert!(thread.truncated);
        assert_eq!(thread.comments.len(), 1);
        assert_eq!(thread.comments[0].author, "ada");
        assert_eq!(
            thread.comments[0].url,
            "https://gitlab.example.com/acme/web/-/merge_requests/9#note_2"
        );
    }

    #[test]
    fn maps_gitlab_link_types_to_groups() {
        assert_eq!(gitlab_link_group("blocks"), ("blocks", "Blocks"));
        assert_eq!(
            gitlab_link_group("is_blocked_by"),
            ("blocked-by", "Is blocked by")
        );
        assert_eq!(gitlab_link_group("relates_to"), ("related", "Relates to"));
        assert_eq!(gitlab_link_group(""), ("related", "Relates to"));
    }

    #[test]
    fn builds_merge_request_diff() {
        let diff = parse_mr_diff(
            &json!([{
                "old_path": "src/old.ts",
                "new_path": "src/new.ts",
                "renamed_file": true,
                "diff": "@@ -1 +1 @@\n-old\n+new\n"
            }]),
            false,
        )
        .unwrap();
        assert_eq!(diff.additions, 1);
        assert_eq!(diff.deletions, 1);
        assert_eq!(diff.files[0].path, "src/new.ts");
        assert!(diff.patch.contains("rename from src/old.ts"));
        assert!(diff.patch.contains("@@ -1 +1 @@"));
    }

    #[test]
    fn parses_merge_request_state() {
        let state = parse_mr_state(
            &json!({
                "iid": 9,
                "title": "Draft: Improve login",
                "web_url": "https://gitlab.example.com/acme/web/-/merge_requests/9",
                "state": "opened",
                "sha": "abc123def456",
                "source_branch": "feature",
                "target_branch": "main",
                "detailed_merge_status": "need_rebase",
                "blocking_discussions_resolved": false,
            }),
            9,
            "acme/web",
            &json!({ "approvals_required": 2, "approvals_left": 1, "approved": false }),
            Some(GitlabMrPipeline {
                id: 77,
                sha: "abc123def456".into(),
                status: "failed".into(),
                url: "https://gitlab.example.com/acme/web/-/pipelines/77".into(),
            }),
        )
        .unwrap();
        assert_eq!(state.state, "open");
        assert!(state.draft);
        assert_eq!(state.repo, "acme/web");
        assert_eq!(state.head_sha, "abc123def456");
        assert_eq!(state.merge_status, "need_rebase");
        assert!(!state.blocking_discussions_resolved);
        assert_eq!(state.approvals_left, 1);
        assert_eq!(state.pipeline.unwrap().status, "failed");
    }

    #[test]
    fn merge_state_defaults_when_approvals_denied() {
        let state = parse_mr_state(
            &json!({ "iid": 3, "state": "merged", "sha": "f00", "merge_status": "can_be_merged" }),
            3,
            "acme/web",
            &Value::Null,
            None,
        )
        .unwrap();
        assert_eq!(state.merge_status, "can_be_merged");
        assert!(state.blocking_discussions_resolved);
        assert_eq!(state.approvals_required, 0);
        assert!(!state.approved);
        assert!(state.pipeline.is_none());
    }

    #[test]
    fn parses_discussions_with_positions_and_replies() {
        // The discussions endpoint always pages oldest-first; the parser
        // keeps that order for display.
        let thread = parse_mr_discussions(
            &json!([
                {
                    "id": "deadbeef01",
                    "notes": [
                        {
                            "id": 10, "body": "Naming?", "system": false,
                            "created_at": "2026-09-09T10:00:00Z",
                            "author": { "username": "ada" },
                            "resolved": false, "resolvable": true,
                            "position": { "new_path": "src/app.ts", "new_line": 12 }
                        },
                        {
                            "id": 11, "body": "Renamed", "system": false,
                            "created_at": "2026-09-09T10:05:00Z",
                            "author": { "username": "maya" },
                            "resolved": true,
                            "position": { "new_path": "src/app.ts", "new_line": 12 }
                        },
                        { "id": 12, "body": "ada resolved this", "system": true }
                    ]
                },
                {
                    "id": "cafe0002",
                    "individual_note": true,
                    "notes": [{
                        "id": 20, "body": "Overall looks fine", "system": false,
                        "created_at": "2026-09-09T11:00:00Z",
                        "author": { "username": "sam" }
                    }]
                }
            ]),
            "https://gitlab.example.com",
            "acme/web",
            9,
            true,
        )
        .unwrap();
        assert!(thread.truncated);
        assert_eq!(thread.comments.len(), 2);
        let anchored = &thread.comments[0];
        assert_eq!(anchored.kind, "review");
        assert_eq!(anchored.path, "src/app.ts");
        assert_eq!(anchored.line, Some(12));
        assert_eq!(anchored.thread_id, "deadbeef01");
        assert!(!anchored.resolved);
        assert_eq!(anchored.replies.len(), 1);
        assert_eq!(anchored.replies[0].author, "maya");
        let plain = &thread.comments[1];
        assert_eq!(plain.kind, "comment");
        assert!(plain.path.is_empty());
    }

    #[test]
    fn resolvable_discussions_without_positions_stay_threads() {
        let thread = parse_mr_discussions(
            &json!([
                {
                    "id": "oldest01",
                    "notes": [{
                        "id": 5, "body": "Removed this line?", "system": false,
                        "author": { "username": "sam" },
                        "resolved": false, "resolvable": true,
                        "position": { "new_path": "src/app.ts", "new_line": null, "old_line": 7 }
                    }]
                },
                {
                    "id": "newest02",
                    "notes": [{
                        "id": 30, "body": "Please explain the approach", "system": false,
                        "author": { "username": "ada" },
                        "resolved": false, "resolvable": true
                    }]
                }
            ]),
            "https://gitlab.example.com",
            "acme/web",
            9,
            false,
        )
        .unwrap();
        // Rows arrive and are surfaced oldest-first.
        assert_eq!(thread.comments[0].thread_id, "oldest01");
        assert_eq!(thread.comments[1].thread_id, "newest02");
        // A resolvable discussion with no diff position is still a review
        // thread — it blocks the merge and must stay reachable.
        assert_eq!(thread.comments[1].kind, "review");
        assert!(thread.comments[1].resolvable);
        // Removed-line notes anchor to the old line.
        assert_eq!(thread.comments[0].line, Some(7));
        assert_eq!(thread.comments[0].path, "src/app.ts");
    }

    #[test]
    fn skips_empty_and_system_only_discussions() {
        let thread = parse_mr_discussions(
            &json!([
                { "id": "nonotes" },
                {
                    "id": "sysonly",
                    "notes": [{ "id": 1, "body": "system event", "system": true }]
                },
                {
                    "id": "real",
                    "notes": [{ "id": 2, "body": "looks good", "system": false }]
                }
            ]),
            "https://gitlab.example.com",
            "acme/web",
            9,
            false,
        )
        .unwrap();
        assert_eq!(thread.comments.len(), 1);
        assert_eq!(thread.comments[0].thread_id, "real");
        assert_eq!(thread.comments[0].kind, "review");
    }

    #[test]
    fn branch_mr_prefers_same_project_over_fork() {
        let rows = json!([
            { "iid": 8, "source_project_id": 77, "project_id": 10 },
            { "iid": 3, "source_project_id": 10, "project_id": 10 }
        ]);
        let rows = rows.as_array().unwrap();
        assert_eq!(prefer_same_project_mr(rows).unwrap().get("iid").unwrap(), 3);
        // Only fork MRs — falls back to the newest listing.
        let forks = json!([{ "iid": 8, "source_project_id": 77, "project_id": 10 }]);
        let forks = forks.as_array().unwrap();
        assert_eq!(
            prefer_same_project_mr(forks).unwrap().get("iid").unwrap(),
            8
        );
        // Missing ids cannot claim a same-project match.
        let missing =
            json!([{ "iid": 9 }, { "iid": 4, "source_project_id": 10, "project_id": 10 }]);
        let missing = missing.as_array().unwrap();
        assert_eq!(
            prefer_same_project_mr(missing).unwrap().get("iid").unwrap(),
            4
        );
        assert!(prefer_same_project_mr(&[]).is_none());
    }

    #[test]
    fn detects_draft_title_variants() {
        for title in [
            "Draft: x",
            "[Draft] x",
            "(Draft) x",
            "Draft - x",
            "draft",
            "WIP: x",
            "[wip] x",
            "(WIP) x",
            "wip - x",
        ] {
            assert!(mr_is_draft(&json!({}), title), "{title}");
        }
        assert!(!mr_is_draft(&json!({}), "Drafted changes"));
        assert!(!mr_is_draft(&json!({}), "Improve login"));
    }

    #[test]
    fn merge_state_flags_draft_without_title_prefix() {
        let state = parse_mr_state(
            &json!({ "iid": 4, "title": "Improve login", "state": "opened", "work_in_progress": true }),
            4,
            "acme/web",
            &Value::Null,
            None,
        )
        .unwrap();
        assert!(state.draft);
        let bracketed = parse_mr_state(
            &json!({ "iid": 5, "title": "[Draft] Improve login", "state": "opened" }),
            5,
            "acme/web",
            &Value::Null,
            None,
        )
        .unwrap();
        assert!(bracketed.draft);
    }

    #[test]
    fn parses_pipeline_edges() {
        assert!(parse_mr_pipeline(None).is_none());
        assert!(parse_mr_pipeline(Some(&Value::Null)).is_none());
        assert!(parse_mr_pipeline(Some(&json!({ "id": 0, "status": "failed" }))).is_none());
        assert!(parse_mr_pipeline(Some(&json!({ "status": "failed" }))).is_none());
        let pipeline = parse_mr_pipeline(Some(&json!({
            "id": 42, "sha": "abc", "status": "running", "web_url": "https://x/p/42"
        })))
        .unwrap();
        assert_eq!(pipeline.id, 42);
        assert_eq!(pipeline.status, "running");
    }

    #[test]
    fn discussion_ids_reject_path_segments() {
        assert_eq!(validate_discussion_id("deadbeef01").unwrap(), "deadbeef01");
        assert_eq!(validate_discussion_id("a-b_c").unwrap(), "a-b_c");
        assert!(validate_discussion_id("").is_err());
        assert!(validate_discussion_id("../admin").is_err());
        assert!(validate_discussion_id("a/b").is_err());
        assert!(validate_discussion_id("a b").is_err());
        assert!(validate_discussion_id(&"x".repeat(65)).is_err());
    }
}
