//! Azure Repos inspection and pull-request creation through the shared app-host Azure connection.
use crate::azure::{component, request, request_method, require_config, AzureConfig};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

const PAGE_SIZE: usize = 50;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrTarget {
    site: String,
    account_id: String,
    project: String,
    repository: String,
    number: u32,
}

fn segment(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 256
        || value.chars().any(char::is_control)
        || matches!(value, "." | "..")
    {
        return Err("Choose an Azure project and repository".into());
    }
    Ok(component(value))
}

fn checked_account(config: &AzureConfig, account_id: &str) -> Result<(), String> {
    if account_id.is_empty() || account_id != config.account_id {
        return Err("Azure account changed. Refresh and choose the PR again.".into());
    }
    Ok(())
}

fn get(config: &AzureConfig, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let mut query = query.to_vec();
    query.push(("api-version", "7.1".into()));
    request(config, path, &query, None).map_err(|error| {
        if error.contains("denied access") {
            "Azure denied this PR read. Check Code (Read) and repository permissions; other Azure features remain available.".into()
        } else if error.starts_with("Azure project, query or item is unavailable") {
            "Azure PR, repository or branch is unavailable. Check the linked target and permissions, or open it in Azure.".into()
        } else {
            error
        }
    })
}

fn repository_path(project: &str, repository: &str) -> Result<String, String> {
    Ok(format!(
        "{}/_apis/git/repositories/{}",
        segment(project)?,
        segment(repository)?
    ))
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Azure returned a PR without {key}. Refresh or open it in Azure."))
}

fn revision(pr: &Value) -> Result<String, String> {
    let source = text(&pr["lastMergeSourceCommit"], "commitId")?;
    let target = text(&pr["lastMergeTargetCommit"], "commitId")?;
    Ok(format!(
        "{source}:{target}:{}:{}",
        text(pr, "sourceRefName")?,
        text(pr, "targetRefName")?
    ))
}

fn verify_pr(pr: &Value, project: &str, repository: &str, number: u32) -> Result<(), String> {
    if pr["repository"]["id"] != repository
        || pr["repository"]["project"]["id"] != project
        || pr["pullRequestId"] != number
    {
        return Err("Azure PR identity changed. Choose the repository and PR again.".into());
    }
    Ok(())
}

fn page(value: &Value, key: &str, skip: u32, server_paged: bool) -> Result<Value, String> {
    let rows = value[key]
        .as_array()
        .ok_or("Azure returned an invalid PR detail list")?;
    let start = if server_paged { 0 } else { skip as usize };
    let items: Vec<_> = rows.iter().skip(start).take(PAGE_SIZE).cloned().collect();
    let more = if server_paged {
        rows.len() >= PAGE_SIZE
    } else {
        rows.len() > start + PAGE_SIZE
    };
    Ok(json!({"items":items,"nextSkip": if more { Some(skip + PAGE_SIZE as u32) } else { None }}))
}

fn check_skip(skip: u32) -> Result<(), String> {
    if skip > 10_000 {
        return Err("PR detail limit reached. Open the remaining context in Azure.".into());
    }
    Ok(())
}

/// The transport already bounds the full response. Include activity outside
/// the visible thread page without downloading that same response repeatedly.
fn activity_dates(value: &Value) -> Result<Vec<&str>, String> {
    let threads = value["value"]
        .as_array()
        .ok_or("Azure returned an invalid PR thread list")?;
    let mut dates = Vec::new();
    for thread in threads {
        for entry in
            std::iter::once(thread).chain(thread["comments"].as_array().into_iter().flatten())
        {
            for key in ["publishedDate", "lastUpdatedDate"] {
                if let Some(date) = entry[key].as_str().filter(|date| date.len() <= 64) {
                    dates.push(date);
                }
            }
        }
    }
    Ok(dates)
}

fn summary(pr: &Value) -> Result<Value, String> {
    let number = pr["pullRequestId"]
        .as_u64()
        .filter(|id| *id > 0 && *id <= i32::MAX as u64)
        .ok_or("Azure returned an invalid PR number")?;
    let reviewers = pr["reviewers"].as_array().map(|rows| rows.iter().take(50).map(|row| json!({
        "id":row["id"].as_str().unwrap_or("unknown"),
        "displayName":row["displayName"].as_str().unwrap_or("Unknown reviewer"),
        "vote":row["vote"].as_i64().unwrap_or(0),"isRequired":row["isRequired"].as_bool().unwrap_or(false),
    })).collect::<Vec<_>>()).unwrap_or_default();
    Ok(json!({
        "pullRequestId":number,"title":text(pr,"title")?.chars().take(500).collect::<String>(),
        "description":pr["description"].as_str().unwrap_or("").chars().take(64000).collect::<String>(),
        "status":pr["status"].as_str().unwrap_or("unknown"),"isDraft":pr["isDraft"].as_bool().unwrap_or(false),
        "sourceRefName":text(pr,"sourceRefName")?,"targetRefName":text(pr,"targetRefName")?,
        "creationDate":pr["creationDate"].as_str().unwrap_or(""),
        "closedDate":pr["closedDate"].as_str().unwrap_or(""),
        "repositoryName":pr["repository"]["name"].as_str().unwrap_or(""),
        "projectName":pr["repository"]["project"]["name"].as_str().unwrap_or(""),
        "lastMergeSourceCommit":pr["lastMergeSourceCommit"],"lastMergeTargetCommit":pr["lastMergeTargetCommit"],
        "mergeStatus":pr["mergeStatus"].as_str().unwrap_or(""),
        "reviewers":reviewers,
    }))
}

/// Resolve names only within the explicitly chosen organization/project, then return stable IDs.
#[tauri::command]
pub async fn azure_pr_list(
    app: AppHandle,
    target: PrTarget,
    branch: String,
    skip: u32,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_skip(skip)?;
        let config = require_config(&app, &target.site)?;
        checked_account(&config, &target.account_id)?;
        let repo = get(&config, &repository_path(&target.project, &target.repository)?, &[])?;
        let repository = text(&repo, "id")?;
        let project = text(&repo["project"], "id")?;
        let path = repository_path(project, repository)?;
        let mut result = if target.number > 0 {
            let pr = get(&config, &format!("{path}/pullRequests/{}", target.number), &[])?;
            verify_pr(&pr, project, repository, target.number)?;
            json!({"items":[pr],"nextSkip":null})
        } else {
            if branch.is_empty() || branch.len() > 1024 || branch.chars().any(char::is_control) {
                return Err("Enter a branch or link a specific PR".into());
            }
            let branch = if branch.starts_with("refs/heads/") { branch } else { format!("refs/heads/{branch}") };
            let response = get(&config, &format!("{path}/pullRequests"), &[
                ("searchCriteria.sourceRefName", branch),
                ("searchCriteria.status", "all".into()),
                ("$top", PAGE_SIZE.to_string()),
                ("$skip", skip.to_string()),
            ])?;
            page(&response, "value", skip, true)?
        };
        if let Some(items) = result["items"].as_array_mut() {
            for item in items {
                let number = item["pullRequestId"].as_u64().and_then(|id| u32::try_from(id).ok()).ok_or("Azure returned an invalid PR number")?;
                verify_pr(item, project, repository, number)?;
                *item = summary(item)?;
            }
        }
        // Never return a result under a newly selected account after a reconnect.
        checked_account(&require_config(&app, &target.site)?, &target.account_id)?;
        result["target"] = json!({"site":config.site,"accountId":config.account_id,"project":project,"repository":repository,"number":target.number});
        result["repositoryName"] = repo["name"].clone();
        result["projectName"] = repo["project"]["name"].clone();
        Ok(result)
    }).await.map_err(|_| "Azure PR lookup task failed")?
}

/// Normalize a user/agent-provided branch name into a `refs/heads/` target.
fn pr_branch_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    let name = name.strip_prefix("refs/heads/").unwrap_or(name);
    if name.is_empty()
        || name.len() > 250
        || name.starts_with("refs/")
        || name.chars().any(char::is_control)
        || name.contains("..")
        || name.contains("@{")
        || name.starts_with('-')
        || name.ends_with('/')
        || name.ends_with(".lock")
    {
        return Err("Enter a valid branch name".into());
    }
    Ok(name.to_string())
}

fn write_denied(error: &str) -> String {
    if error.contains("denied access") {
        "Azure denied this PR write. Grant Code (Read & Write) to the token in Settings; other Azure features remain available.".into()
    } else {
        error.to_string()
    }
}

fn uncertain_write(error: &str) -> String {
    let detail = if error.contains("denied access") {
        " Check Code (Read & Write) and repository permissions."
    } else {
        ""
    };
    format!("Azure could not confirm the complete write. Some changes may already be saved. Refresh or open the PR and inspect it before submitting again.{detail}")
}

fn verify_created_branches(pr: &Value, source: &str, target: &str) -> Result<(), String> {
    if pr["sourceRefName"] != source || pr["targetRefName"] != target {
        return Err("Azure returned a different source or target branch. Open Azure and inspect the PR before creating another.".into());
    }
    Ok(())
}

/// Create a pull request in Azure Repos. A duplicate create returns the
/// matching PR instead of substituting a different target branch.
#[tauri::command]
pub async fn azure_pr_create(
    app: AppHandle,
    target: PrTarget,
    source_branch: String,
    target_branch: String,
    title: String,
    description: String,
    draft: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &target.site)?;
        checked_account(&config, &target.account_id)?;
        if !config.has_capability("Repos") {
            return Err(
                "The Azure connection has no Repos access. Reconnect with Code (Read & Write)."
                    .into(),
            );
        }
        let source = pr_branch_name(&source_branch)?;
        let target_branch = pr_branch_name(&target_branch)?;
        if source == target_branch {
            return Err("Source and target branches are the same".into());
        }
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 500 {
            return Err("Enter a pull request title".into());
        }
        let description: String = description.trim().chars().take(64_000).collect();
        // Resolve names to stable IDs inside the explicitly chosen organization.
        let repo = get(&config, &repository_path(&target.project, &target.repository)?, &[])
            .map_err(|error| write_denied(&error))?;
        let repository = text(&repo, "id")?;
        let project = text(&repo["project"], "id")?;
        let path = repository_path(project, repository)?;
        let source_ref = format!("refs/heads/{source}");
        let target_ref = format!("refs/heads/{target_branch}");
        checked_account(&require_config(&app, &target.site)?, &target.account_id)?;
        let created = request(
            &config,
            &format!("{path}/pullRequests"),
            &[("api-version", "7.1".into())],
            Some(json!({
                "sourceRefName": source_ref,
                "targetRefName": target_ref,
                "title": title,
                "description": description,
                "isDraft": draft,
            })),
        );
        let (pr, existing) = match created {
            Ok(pr) => (pr, false),
            Err(error) if error.contains("HTTP 409") => {
                // Recover only the exact source/target pair the user chose.
                let found = get(&config, &format!("{path}/pullRequests"), &[
                    ("searchCriteria.sourceRefName", source_ref.clone()),
                    ("searchCriteria.targetRefName", target_ref.clone()),
                    ("searchCriteria.status", "active".into()),
                    ("$top", "1".into()),
                ])?;
                let pr = found["value"]
                    .as_array()
                    .and_then(|rows| rows.first().cloned())
                    .ok_or_else(|| uncertain_write(&error))?;
                (pr, true)
            }
            Err(error) => return Err(uncertain_write(&error)),
        };
        let number = pr["pullRequestId"]
            .as_u64()
            .and_then(|id| u32::try_from(id).ok())
            .ok_or_else(|| uncertain_write("invalid PR number"))?;
        verify_pr(&pr, project, repository, number).map_err(|error| uncertain_write(&error))?;
        verify_created_branches(&pr, &source_ref, &target_ref)?;
        // Never report a result under a newly selected account after a reconnect.
        checked_account(&require_config(&app, &target.site).map_err(|error| uncertain_write(&error))?, &target.account_id).map_err(|error| uncertain_write(&error))?;
        Ok(json!({
            "pr": summary(&pr).map_err(|error| uncertain_write(&error))?,
            "existing": existing,
            "revision": revision(&pr).map_err(|error| uncertain_write(&error))?,
            "target": {"site":config.site,"accountId":config.account_id,"project":project,"repository":repository,"number":number},
            "repositoryName": repo["name"].clone(),
            "projectName": repo["project"]["name"].clone(),
            "account": config.account,
        }))
    })
    .await
    .map_err(|_| uncertain_write("creation task failed"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrSection {
    Summary,
    Activity,
    Threads,
    Workitems,
    Iterations,
    Changes,
    Policies,
    Statuses,
    Diff,
}

/// A review diff renders whole files, so the aggregated section is bounded
/// like the shared transport — 50 files, ~4 MB of embedded text total.
const DIFF_FILE_LIMIT: usize = 50;
const DIFF_BYTES_LIMIT: usize = 4 * 1024 * 1024;

/// Each on-demand section fails independently. Snapshot reads verify both sides of the read.
#[tauri::command]
pub async fn azure_pr_read(
    app: AppHandle,
    target: PrTarget,
    section: PrSection,
    expected_revision: Option<String>,
    iteration: Option<u32>,
    skip: u32,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_skip(skip)?;
        if target.number == 0 {
            return Err("Choose a PR first".into());
        }
        let config = require_config(&app, &target.site)?;
        checked_account(&config, &target.account_id)?;
        let path = format!(
            "{}/pullRequests/{}",
            repository_path(&target.project, &target.repository)?,
            target.number
        );
        let pr = get(&config, &path, &[])?;
        verify_pr(&pr, &target.project, &target.repository, target.number)?;
        let current = revision(&pr)?;
        if expected_revision
            .as_ref()
            .is_some_and(|expected| expected != &current)
        {
            return Err("PR revision changed. Refresh before selecting or sending context.".into());
        }
        let mut result = match section {
            PrSection::Activity => {
                let threads = get(&config, &format!("{path}/threads"), &[])?;
                json!({"pr": summary(&pr)?, "activityDates": activity_dates(&threads)?})
            }
            PrSection::Diff => {
                if pr.get("forkSource").is_some_and(|fork| !fork.is_null()) {
                    return Err("Fork diffs are available in Azure. Cross-repository content is not substituted.".into());
                }
                // The review diff is base → latest iteration — the same view
                // the other providers render with a single patch.
                let iterations = get(&config, &format!("{path}/iterations"), &[])?;
                let latest = iterations["value"]
                    .as_array()
                    .and_then(|rows| rows.iter().filter_map(|row| row["id"].as_u64()).max())
                    .ok_or("Azure returned a PR without iterations")?;
                let commits = get(&config, &format!("{path}/iterations/{latest}"), &[])?;
                let source = text(&commits["sourceRefCommit"], "commitId")?;
                let base = text(&commits["commonRefCommit"], "commitId")?;
                let (changes, truncated) = pr_changes(&config, &path, latest, DIFF_FILE_LIMIT)?;
                let repo_path = repository_path(&target.project, &target.repository)?;
                json!({
                    "items": diff_items(&config, &repo_path, &changes, source, base),
                    "nextSkip": Value::Null,
                    "iteration": latest,
                    "truncated": truncated,
                })
            }
            PrSection::Summary => {
                let mut summary = summary(&pr)?;
                // Behind detection: the merge commit Azure computed ages as the
                // target branch moves, so compare it to the target head. The
                // extra read is best-effort — a summary must still work when
                // the commits call is refused.
                if let Some(target_branch) = pr["targetRefName"].as_str().and_then(|name| name.strip_prefix("refs/heads/")) {
                    let commits_path = format!("{}/commits", repository_path(&target.project, &target.repository)?);
                    if let Ok(commits) = get(&config, &commits_path, &[
                        ("searchCriteria.itemVersion.version", target_branch.to_string()),
                        ("searchCriteria.itemVersion.versionType", "branch".into()),
                        ("$top", "1".into()),
                    ]) {
                        if let Some(head) = commits["value"].as_array().and_then(|rows| rows.first()).and_then(|row| row["commitId"].as_str()) {
                            summary["targetHead"] = json!(head);
                        }
                    }
                }
                json!({"pr":summary})
            }
            PrSection::Threads | PrSection::Iterations | PrSection::Workitems => {
                let suffix = if matches!(section, PrSection::Threads) {
                    "threads"
                } else if matches!(section, PrSection::Workitems) {
                    "workitems"
                } else {
                    "iterations"
                };
                // These Azure endpoints do not offer server paging. The shared transport caps bytes;
                // only one visible page is retained by the caller. Oversize reads offer Open in Azure.
                page(
                    &get(&config, &format!("{path}/{suffix}"), &[])?,
                    "value",
                    skip,
                    false,
                )?
            }
            PrSection::Changes => {
                let iteration = iteration
                    .filter(|id| *id > 0)
                    .ok_or("Choose a PR iteration")?;
                let response = get(
                    &config,
                    &format!("{path}/iterations/{iteration}/changes"),
                    &[
                        ("$top", PAGE_SIZE.to_string()),
                        ("$skip", skip.to_string()),
                        ("$compareTo", "0".into()),
                    ],
                )?;
                let mut result = page(&response, "changeEntries", skip, true)?;
                result["nextSkip"] = response["nextSkip"]
                    .as_u64()
                    .filter(|n| *n > skip as u64)
                    .map_or(Value::Null, |n| json!(n));
                result
            }
            PrSection::Policies => {
                let response = request(
                    &config,
                    &format!("{}/_apis/policy/evaluations", segment(&target.project)?),
                    &[
                        (
                            "artifactId",
                            format!(
                                "vstfs:///CodeReview/CodeReviewId/{}/{}",
                                target.project, target.number
                            ),
                        ),
                        ("api-version", "7.1-preview.1".into()),
                        ("$top", PAGE_SIZE.to_string()),
                        ("$skip", skip.to_string()),
                    ],
                    None,
                )?;
                page(&response, "value", skip, true)?
            }
            PrSection::Statuses => page(
                &get(&config, &format!("{path}/statuses"), &[])?,
                "value", skip, false,
            )?,
        };
        if !matches!(section, PrSection::Summary) {
            let after = get(&config, &path, &[])?;
            verify_pr(&after, &target.project, &target.repository, target.number)?;
            if revision(&after)? != current {
                return Err("PR revision changed during loading. Refresh and retry.".into());
            }
        }
        checked_account(&require_config(&app, &target.site)?, &target.account_id)?;
        result["revision"] = json!(current);
        Ok(result)
    })
    .await
    .map_err(|_| "Azure PR detail task failed")?
}

fn file_text(
    config: &AzureConfig,
    repository: &str,
    path: &str,
    commit: &str,
) -> Result<String, String> {
    let item = get(
        config,
        &format!("{repository}/items"),
        &[
            ("path", path.into()),
            ("versionDescriptor.versionType", "commit".into()),
            ("versionDescriptor.version", commit.into()),
            ("includeContent", "true".into()),
            ("includeContentMetadata", "true".into()),
            ("$format", "json".into()),
        ],
    )?;
    preview_text(&item)
}

fn preview_text(item: &Value) -> Result<String, String> {
    if item["isFolder"] == true || item["contentMetadata"]["isBinary"] == true {
        return Err("Binary files and folders are available in Azure.".into());
    }
    let content = item["content"]
        .as_str()
        .ok_or("File text is unavailable. Open it in Azure.")?;
    if content.len() > 100_000 || content.lines().count() > 5_000 || content.contains('\0') {
        return Err(
            "File exceeds the preview limit (100 KB / 5,000 lines). Open it in Azure.".into(),
        );
    }
    Ok(content.into())
}

/// Every change in an iteration, paged through `nextSkip`, bounded by `limit`.
/// The second return marks omitted entries so the caller can say the diff is
/// partial instead of silently dropping files.
fn pr_changes(
    config: &AzureConfig,
    path: &str,
    iteration: u64,
    limit: usize,
) -> Result<(Vec<Value>, bool), String> {
    let mut items: Vec<Value> = Vec::new();
    let mut truncated = false;
    let mut skip = 0u64;
    loop {
        let response = get(
            config,
            &format!("{path}/iterations/{iteration}/changes"),
            &[
                ("$top", PAGE_SIZE.to_string()),
                ("$skip", skip.to_string()),
                ("$compareTo", "0".into()),
            ],
        )?;
        let entries = response["changeEntries"]
            .as_array()
            .ok_or("Azure returned an invalid PR change list")?;
        for entry in entries {
            if items.len() < limit {
                items.push(entry.clone());
            } else {
                truncated = true;
            }
        }
        if truncated {
            break;
        }
        match response["nextSkip"].as_u64().filter(|next| *next > skip) {
            Some(next) if next <= 10_000 => skip = next,
            Some(_) => {
                truncated = true;
                break;
            }
            None => break,
        }
    }
    Ok((items, truncated))
}

/// One change entry → both file texts. Content failures land in `error` so a
/// single binary or oversized file cannot fail the whole diff.
fn diff_item(
    config: &AzureConfig,
    repository: &str,
    change: &Value,
    source: &str,
    base: &str,
    budget: &std::sync::atomic::AtomicUsize,
) -> Value {
    let path = change["item"]["path"].as_str().unwrap_or("");
    if path.is_empty() || path.len() > 4096 {
        return json!({"path":path,"error":"Azure returned a change without a valid path."});
    }
    let kind = change["changeType"]
        .as_str()
        .unwrap_or("edit")
        .to_ascii_lowercase();
    let old_path = change["originalPath"]
        .as_str()
        .or(change["sourceServerItem"].as_str())
        .unwrap_or(path);
    let added = kind.split(',').any(|flag| flag.trim() == "add");
    let deleted = kind.split(',').any(|flag| flag.trim() == "delete");
    let mut item = json!({
        "path": path,
        "originalPath": if old_path == path { Value::Null } else { json!(old_path) },
        "changeType": change["changeType"].as_str().unwrap_or("edit"),
        "changeTrackingId": change["changeTrackingId"].as_u64(),
    });
    let mut error: Option<String> = None;
    for (version, target_path, slot) in [(base, old_path, "original"), (source, path, "modified")] {
        if (slot == "original" && added) || (slot == "modified" && deleted) {
            continue;
        }
        if budget.load(std::sync::atomic::Ordering::Relaxed) >= DIFF_BYTES_LIMIT {
            error = Some("File text omitted — the diff exceeds the preview limit.".into());
            break;
        }
        match file_text(config, repository, target_path, version) {
            Ok(content) => {
                budget.fetch_add(content.len(), std::sync::atomic::Ordering::Relaxed);
                item[slot] = json!(content);
            }
            Err(reason) => error = Some(reason),
        }
    }
    if let Some(reason) = error {
        item["error"] = json!(reason);
    }
    item
}

/// File text reads are independent, so a small worker pool keeps a 50-file
/// diff close to one round trip instead of a hundred sequential ones.
fn diff_items(
    config: &AzureConfig,
    repository: &str,
    changes: &[Value],
    source: &str,
    base: &str,
) -> Vec<Value> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    let next = AtomicUsize::new(0);
    let budget = AtomicUsize::new(0);
    let rows: Vec<Mutex<Option<Value>>> = changes.iter().map(|_| Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                if index >= changes.len() {
                    break;
                }
                *rows[index].lock().unwrap() = Some(diff_item(
                    config,
                    repository,
                    &changes[index],
                    source,
                    base,
                    &budget,
                ));
            });
        }
    });
    rows.into_iter()
        .map(|row| {
            row.into_inner()
                .unwrap_or_default()
                .unwrap_or_else(|| json!({"error":"File read was interrupted."}))
        })
        .collect()
}

/// Pre-write verification shared by every PR mutation — identity, the exact
/// revision the user saw, and the active state all pinned before any write.
fn verified_active_pr(
    config: &AzureConfig,
    target: &PrTarget,
    expected_revision: &str,
) -> Result<String, String> {
    if target.number == 0 {
        return Err("Choose a PR first".into());
    }
    checked_account(config, &target.account_id)?;
    if !config.has_capability("Repos") {
        return Err(
            "The Azure connection has no Repos access. Reconnect with Code (Read & Write).".into(),
        );
    }
    let path = format!(
        "{}/pullRequests/{}",
        repository_path(&target.project, &target.repository)?,
        target.number
    );
    let pr = get(config, &path, &[])?;
    verify_pr(&pr, &target.project, &target.repository, target.number)?;
    if revision(&pr)? != expected_revision {
        return Err("PR revision changed. Refresh before writing.".into());
    }
    if pr["status"] != "active" {
        return Err("The PR is no longer active. Refresh before writing.".into());
    }
    Ok(path)
}

/// Revalidate each step in a review; writes and verification reads are never replayed.
fn mutate_pr(
    app: &AppHandle,
    target: &PrTarget,
    expected_revision: &str,
    method: &str,
    suffix: &str,
    body: Value,
) -> Result<(), String> {
    let config = require_config(app, &target.site)?;
    let path = verified_active_pr(&config, target, expected_revision)?;
    checked_account(&require_config(app, &target.site)?, &target.account_id)?;
    request_method(
        &config,
        method,
        &format!("{path}/{suffix}"),
        &[("api-version", "7.1".into())],
        Some(body),
    )
    .map_err(|error| uncertain_write(&error))?;
    let after = get(&config, &path, &[]).map_err(|error| uncertain_write(&error))?;
    verify_pr(&after, &target.project, &target.repository, target.number)
        .map_err(|error| uncertain_write(&error))?;
    if revision(&after).map_err(|error| uncertain_write(&error))? != expected_revision {
        return Err(uncertain_write("revision changed"));
    }
    checked_account(
        &require_config(app, &target.site).map_err(|error| uncertain_write(&error))?,
        &target.account_id,
    )
    .map_err(|error| uncertain_write(&error))
}

/// Reply inside an existing pull-request thread.
#[tauri::command]
pub async fn azure_pr_thread_comment(
    app: AppHandle,
    target: PrTarget,
    expected_revision: String,
    thread_id: u32,
    body: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if thread_id == 0 {
            return Err("Choose a review thread first".into());
        }
        let body: String = body.trim().chars().take(64_000).collect();
        if body.is_empty() {
            return Err("Enter a reply first".into());
        }
        mutate_pr(
            &app,
            &target,
            &expected_revision,
            "POST",
            &format!("threads/{thread_id}/comments"),
            json!({"content":body,"parentCommentId":0,"commentType":"text"}),
        )?;
        Ok(json!({"revision":expected_revision}))
    })
    .await
    .map_err(|_| uncertain_write("reply task failed"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    path: String,
    line: u32,
    /// "left" anchors on the removed side, "right" on the new side.
    side: String,
    /// Line length the comment spans — Azure positions are offset ranges.
    offset: u32,
    body: String,
}

/// Submit a review: inline file threads first, then the summary comment, then
/// the vote — a failure leaves context behind instead of a bare vote.
#[tauri::command]
pub async fn azure_pr_submit_review(
    app: AppHandle,
    target: PrTarget,
    expected_revision: String,
    event: String,
    body: String,
    comments: Vec<ReviewComment>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let vote = match event.as_str() {
            "comment" => None,
            "approve" => Some(10),
            "reject" => Some(-10),
            _ => return Err("Unsupported review event".into()),
        };
        let body: String = body.trim().chars().take(64_000).collect();
        if comments.len() > 50 {
            return Err("Azure accepts at most 50 line comments per review".into());
        }
        for comment in &comments {
            if comment.path.is_empty()
                || comment.path.len() > 4096
                || comment.path.chars().any(char::is_control)
            {
                return Err("A line comment lost its file. Refresh and draft it again.".into());
            }
            if comment.line == 0 || comment.offset == u32::MAX {
                return Err("A line comment lost its line. Refresh and draft it again.".into());
            }
            if !["left", "right"].contains(&comment.side.as_str()) {
                return Err("Unsupported comment side".into());
            }
            if comment.body.trim().is_empty() || comment.body.chars().count() > 64_000 {
                return Err("A line comment is empty or too long".into());
            }
        }
        if comments.is_empty() && body.is_empty() && vote.is_none() {
            return Err("Nothing to submit".into());
        }
        let config = require_config(&app, &target.site)?;
        let path = verified_active_pr(&config, &target, &expected_revision)?;
        let mut writes = Vec::new();
        if !comments.is_empty() {
            let iterations = get(&config, &format!("{path}/iterations"), &[])?;
            let latest = iterations["value"]
                .as_array()
                .and_then(|rows| rows.iter().filter_map(|row| row["id"].as_u64()).max())
                .ok_or("Azure returned a PR without iterations")?;
            // Anchoring needs the full change list even past the display cap.
            let (changes, _) = pr_changes(&config, &path, latest, 500)?;
            let tracking = |path: &str| {
                changes
                    .iter()
                    .find(|change| change["item"]["path"] == path)
                    .and_then(|change| change["changeTrackingId"].as_u64())
            };
            for comment in &comments {
                let change_id = tracking(&comment.path).ok_or_else(|| {
                    format!(
                        "{} is not in the PR's latest changes. Refresh and draft it again.",
                        comment.path
                    )
                })?;
                let start = json!({"line":comment.line,"offset":1});
                let end = json!({"line":comment.line,"offset":comment.offset.max(1) + 1});
                let thread_context = if comment.side == "left" {
                    json!({"filePath":comment.path,"leftFileStart":start,"leftFileEnd":end})
                } else {
                    json!({"filePath":comment.path,"rightFileStart":start,"rightFileEnd":end})
                };
                writes.push(("POST", "threads".to_string(), json!({
                    "comments":[{"parentCommentId":0,"content":comment.body,"commentType":"text"}],
                    "status":"active",
                    "threadContext":thread_context,
                    "pullRequestThreadContext":{
                        "changeTrackingId":change_id,
                        "iterationContext":{"firstComparingIteration":latest,"secondComparingIteration":latest}
                    }
                })));
            }
        }
        if !body.is_empty() {
            writes.push(("POST", "threads".to_string(), json!({
                "comments":[{"parentCommentId":0,"content":body,"commentType":"text"}],
                "status":"active"
            })));
        }
        if let Some(vote) = vote {
            writes.push(("PUT", format!("reviewers/{}", component(&config.account_id)),
                json!({"id":config.account_id,"vote":vote})));
        }
        for (index, (method, suffix, body)) in writes.into_iter().enumerate() {
            mutate_pr(&app, &target, &expected_revision, method, &suffix, body)
                .map_err(|error| if index == 0 { error } else { uncertain_write(&error) })?;
        }
        Ok(json!({"revision":expected_revision}))
    })
    .await
    .map_err(|_| uncertain_write("review task failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_recovery_keeps_both_branches_and_uncertain_writes_do_not_instruct_retry() {
        let pr = json!({"sourceRefName":"refs/heads/topic", "targetRefName":"refs/heads/main"});
        assert!(verify_created_branches(&pr, "refs/heads/topic", "refs/heads/main").is_ok());
        assert!(verify_created_branches(&pr, "refs/heads/topic", "refs/heads/release").is_err());
        assert!(verify_created_branches(&pr, "refs/heads/other", "refs/heads/main").is_err());
        for reason in [
            "Cannot reach Azure. Retry.",
            "Invalid response. Retry.",
            "denied access",
        ] {
            let message = uncertain_write(reason);
            assert!(message.contains("may already be saved"));
            assert!(message.contains("inspect"));
            assert!(!message.to_lowercase().contains("retry"));
        }
    }

    #[test]
    fn activity_includes_comments_beyond_the_visible_pages() {
        let mut threads = vec![json!({"comments": []}); 601];
        threads[600] = json!({"lastUpdatedDate": "2026-09-19T08:00:00Z", "comments": [
            {"publishedDate": "2026-09-19T09:00:00Z", "lastUpdatedDate": "2026-09-19T10:00:00Z"}
        ]});
        let response = json!({"value": threads});
        assert_eq!(
            activity_dates(&response).unwrap(),
            vec![
                "2026-09-19T08:00:00Z",
                "2026-09-19T09:00:00Z",
                "2026-09-19T10:00:00Z"
            ]
        );
        assert!(activity_dates(&json!({})).is_err());
    }

    #[test]
    fn summaries_and_file_previews_reject_missing_or_oversized_content() {
        assert!(summary(&json!({"pullRequestId":0})).is_err());
        let summary = summary(&json!({"pullRequestId":13,"title":"Review","sourceRefName":"refs/heads/topic","targetRefName":"refs/heads/main","reviewers":null})).unwrap();
        assert_eq!(summary["status"], "unknown");
        assert_eq!(summary["reviewers"], json!([]));
        assert_eq!(
            preview_text(&json!({"content":"source\n"})).unwrap(),
            "source\n"
        );
        assert!(preview_text(&json!({"content":"x".repeat(100_001)})).is_err());
        assert!(preview_text(&json!({"content":"x\n".repeat(5_001)})).is_err());
        assert!(
            preview_text(&json!({"content":"binary","contentMetadata":{"isBinary":true}})).is_err()
        );
        assert!(preview_text(&json!({})).is_err());
    }

    #[test]
    fn scoped_paths_revisions_and_bounded_pages() {
        assert_eq!(
            repository_path("Project A", "same/name").unwrap(),
            "Project%20A/_apis/git/repositories/same%2Fname"
        );
        for invalid in ["", "..", ".", "bad\nname"] {
            assert!(segment(invalid).is_err());
        }
        let pr = json!({"repository":{"id":"repo-a","project":{"id":"project-a"}},"pullRequestId":13,"sourceRefName":"refs/heads/topic","targetRefName":"refs/heads/main","lastMergeSourceCommit":{"commitId":"source"},"lastMergeTargetCommit":{"commitId":"target"}});
        assert!(verify_pr(&pr, "project-a", "repo-a", 13).is_ok());
        assert!(verify_pr(&pr, "project-b", "repo-a", 13).is_err());
        assert!(verify_pr(&pr, "project-a", "repo-b", 13).is_err());
        assert!(verify_pr(&pr, "project-a", "repo-a", 14).is_err());
        assert_eq!(
            revision(&pr).unwrap(),
            "source:target:refs/heads/topic:refs/heads/main"
        );
        let mut retargeted = pr.clone();
        retargeted["targetRefName"] = json!("refs/heads/release");
        assert_ne!(revision(&retargeted).unwrap(), revision(&pr).unwrap());
        assert!(revision(&json!({})).is_err());
        let rows = json!({"value":(0..120).collect::<Vec<_>>()});
        let first = page(&rows, "value", 0, false).unwrap();
        let next = page(&rows, "value", 50, false).unwrap();
        let last = page(&rows, "value", 100, false).unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 50);
        assert_eq!(next["items"][0], 50);
        assert_eq!(last["items"].as_array().unwrap().len(), 20);
        assert!(last["nextSkip"].is_null());
        assert!(page(&json!({}), "value", 0, false).is_err());
        assert!(check_skip(10_001).is_err());
    }

    #[test]
    fn pr_branch_names_normalize_and_reject_unsafe_input() {
        assert_eq!(pr_branch_name("dev").unwrap(), "dev");
        assert_eq!(
            pr_branch_name(" refs/heads/feature/x ").unwrap(),
            "feature/x"
        );
        for bad in [
            "",
            "  ",
            "refs/heads/",
            "refs/tags/v1",
            "-rm",
            "trail/",
            "name.lock",
            "a..b",
            "at@{0}",
            "bad\nname",
        ] {
            assert!(pr_branch_name(bad).is_err(), "{bad}");
        }
        assert!(pr_branch_name(&"x".repeat(251)).is_err());
    }

    #[test]
    fn write_denied_explains_missing_scope_only() {
        assert!(write_denied(
            "The requested resource requires authentication or the user denied access"
        )
        .contains("Read & Write"));
        assert_eq!(write_denied("boom"), "boom");
    }
}
