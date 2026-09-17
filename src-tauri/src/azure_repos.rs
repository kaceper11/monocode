//! Azure Repos inspection and pull-request creation through the shared app-host Azure connection.
use crate::azure::{component, request, request_method, require_config, AzureConfig};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const PAGE_SIZE: usize = 50;

#[tauri::command]
pub fn azure_pr_cancel_checkout(request_id: String) {
    crate::checkout::cancel_checkout(&request_id);
}

#[tauri::command]
pub async fn azure_pr_prepare_checkout(
    app: AppHandle,
    cwd: String,
    target: PrTarget,
    expected_revision: String,
    request_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _preparation = crate::checkout::begin_checkout(&request_id)?;
        if crate::wsl::location(&cwd)?.is_some() {
            return Err("Automatic cloning requires a local execution host. Open a matching checkout in this WSL distribution to keep the agent on its selected host.".into());
        }
        let config = require_config(&app, &target.site)?;
        checked_account(&config, &target.account_id)?;
        let api_path = format!("{}/pullRequests/{}", repository_path(&target.project, &target.repository)?, target.number);
        let pr = get(&config, &api_path, &[])?;
        verify_pr(&pr, &target.project, &target.repository, target.number)?;
        if revision(&pr)? != expected_revision || pr["status"] != "active" {
            return Err("PR changed or is no longer active. Refresh before preparing its checkout.".into());
        }
        if pr.get("forkSource").is_some_and(|fork| !fork.is_null()) {
            return Err("Fork PR checkouts require opening the source repository explicitly.".into());
        }
        let branch = text(&pr, "sourceRefName")?.strip_prefix("refs/heads/").ok_or("Invalid PR source branch")?;
        let commit = text(&pr["lastMergeSourceCommit"], "commitId")?;
        let remote = format!("{}/{}/_git/{}", config.site, segment(text(&pr["repository"]["project"], "name")?)?, segment(text(&pr["repository"], "name")?)?);
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        (&config.site, &config.account_id, &target.project, &target.repository, target.number, branch, commit).hash(&mut hash);
        let key = format!("pr-{}-{:016x}", target.number, hash.finish());
        let base = app.path().app_data_dir().map_err(|_| "Cannot locate PR checkouts")?.join("checkouts").join("azure");
        crate::checkout::prepare_checkout(&base, &key, &remote, branch, commit, Some(&config.authorization()), || {
            if crate::checkout::checkout_cancelled() { return Err("Checkout preparation cancelled.".into()); }
            let current = require_config(&app, &target.site)?;
            checked_account(&current, &target.account_id)?;
            let latest = get(&current, &api_path, &[])?;
            verify_pr(&latest, &target.project, &target.repository, target.number)?;
            if revision(&latest)? != expected_revision || latest["status"] != "active" {
                return Err("PR changed or is no longer active. Refresh before repair.".into());
            }
            Ok(())
        })
    }).await.map_err(|_| "PR checkout preparation task failed")?
}

// Local Git stays on the checkout's execution host; credentials never leave it.
#[tauri::command]
pub async fn azure_pr_remotes(cwd: String, branch: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::fs::expand_home(&cwd);
        let head =
            crate::fs::git_command_output(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        if !head.status.success() || String::from_utf8_lossy(&head.stdout).trim() != branch {
            return Err(
                "Working branch changed or is detached. Refresh Changes before discovering PRs."
                    .into(),
            );
        }
        let output = crate::fs::git_command_output(
            &root,
            &["config", "--get-regexp", r"^remote\..*\.url$"],
        )?;
        if !output.status.success() && output.status.code() != Some(1) {
            return Err("Cannot read this checkout's Git remotes.".into());
        }
        if output.stdout.len() > 64 * 1024 {
            return Err("Too many Git remotes. Link a PR manually.".into());
        }
        let rows: Vec<_> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let (key, raw) = line.split_once(char::is_whitespace)?;
                let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
                Some(json!({"name":name,"url":safe_azure_remote(raw.trim())?}))
            })
            .take(21)
            .collect();
        Ok(json!({"items":rows.iter().take(20).collect::<Vec<_>>(),"more":rows.len()>20}))
    })
    .await
    .map_err(|_| "Git remote discovery task failed")?
}

fn safe_azure_remote(raw: &str) -> Option<String> {
    if raw.len() > 2048 || raw.chars().any(char::is_control) {
        return None;
    }
    if raw.starts_with("git@ssh.dev.azure.com:v3/") {
        return Some(raw.into());
    }
    let mut url = tauri::Url::parse(raw).ok()?;
    let host = url.host_str()?;
    if !((url.scheme() == "https"
        && (host == "dev.azure.com" || host.ends_with(".visualstudio.com")))
        || (url.scheme() == "ssh" && host == "ssh.dev.azure.com" && url.username() == "git"))
        || url.port().is_some()
    {
        return None;
    }
    url.set_password(None).ok()?;
    if url.scheme() == "https" {
        url.set_username("").ok()?;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn story_pr_link(site: &str, relation: &Value) -> Option<String> {
    let raw = relation["url"].as_str()?;
    if relation["rel"] == "ArtifactLink" {
        let artifact = raw
            .strip_prefix("vstfs:///Git/PullRequestId/")?
            .replace("%2F", "/")
            .replace("%2f", "/");
        let ids: Vec<_> = artifact.split('/').collect();
        if ids.len() != 3 || ids[2].parse::<u32>().ok().filter(|n| *n > 0).is_none() {
            return None;
        }
        Some(format!(
            "{}/{}/_git/{}/pullrequest/{}",
            site,
            component(ids[0]),
            component(ids[1]),
            ids[2]
        ))
    } else if relation["rel"] == "Hyperlink" {
        Some(raw.to_string())
    } else {
        None
    }
}

/// Read a story's actual links, without following provider-controlled URLs.
#[tauri::command]
pub async fn azure_pr_story_links(
    app: AppHandle,
    provider: String,
    url: String,
    site: String,
    account_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        checked_account(&config, &account_id)?;
        let story = tauri::Url::parse(&url).map_err(|_| "Invalid linked story URL")?;
        if story.scheme() != "https" || !story.username().is_empty() || story.password().is_some() || story.port().is_some() || story.query().is_some() || story.fragment().is_some() {
            return Err("Invalid linked story URL".into());
        }
        let parts: Vec<_> = story.path().split('/').filter(|part| !part.is_empty()).collect();
        let links = if provider == "azure" {
            let prefix = format!("{}/", config.site);
            if !url.starts_with(&prefix) || parts.len() != 5 || parts[2] != "_workitems" || parts[3] != "edit" {
                return Err("This story belongs to a different Azure organization. Reconnect to discover its links.".into());
            }
            let item = crate::azure::item(&config, parts[4])?;
            item["relations"].as_array().cloned().unwrap_or_default().iter().filter_map(|relation| story_pr_link(&config.site, relation)).collect::<Vec<_>>()
        } else if provider == "jira" {
            if parts.len() != 2 || parts[0] != "browse" || parts[1].len() > 128 || !parts[1].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                return Err("Invalid linked Jira story URL".into());
            }
            let jira_site = story.origin().ascii_serialization();
            let jira = crate::jira::require_config(&app, &jira_site)?;
            let response = crate::jira::request(&jira, &format!("issue/{}/remotelink", parts[1]), &[])?;
            let current = crate::jira::require_config(&app, &jira_site)?;
            if current.email != jira.email || current.token != jira.token { return Err("Jira connection changed. Discover story links again.".into()); }
            response.as_array().ok_or("Jira returned an invalid story link list")?.iter().filter_map(|row| row["object"]["url"].as_str().map(String::from)).collect()
        } else { return Err("Story provider does not expose Azure PR links here. Use captured story references or branch matches.".into()); };
        checked_account(&require_config(&app, &site)?, &account_id)?;
        Ok(json!({"links":links.iter().filter(|url| url.len()<=2048).take(50).collect::<Vec<_>>(),"more":links.len()>50}))
    }).await.map_err(|_| "Story PR discovery task failed")?
}

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

/// Create a pull request in Azure Repos. A duplicate create returns the
/// existing PR instead of failing, so retries never produce a second PR.
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
                // Azure allows one active PR per source branch; the conflict may
                // point at another target — look it up by source only and link it.
                let found = get(&config, &format!("{path}/pullRequests"), &[
                    ("searchCriteria.sourceRefName", source_ref),
                    ("searchCriteria.status", "active".into()),
                    ("$top", "1".into()),
                ])?;
                let pr = found["value"]
                    .as_array()
                    .and_then(|rows| rows.first().cloned())
                    .ok_or(error)?;
                (pr, true)
            }
            Err(error) => return Err(write_denied(&error)),
        };
        let number = pr["pullRequestId"]
            .as_u64()
            .and_then(|id| u32::try_from(id).ok())
            .ok_or("Azure returned an invalid PR number")?;
        verify_pr(&pr, project, repository, number)?;
        // Never report a result under a newly selected account after a reconnect.
        checked_account(&require_config(&app, &target.site)?, &target.account_id)?;
        Ok(json!({
            "pr": summary(&pr)?,
            "existing": existing,
            "revision": revision(&pr)?,
            "target": {"site":config.site,"accountId":config.account_id,"project":project,"repository":repository,"number":number},
            "repositoryName": repo["name"].clone(),
            "projectName": repo["project"]["name"].clone(),
            "account": config.account,
        }))
    })
    .await
    .map_err(|_| "Azure PR creation task failed")?
}

/// Replace an Azure Repos pull request's description.
#[tauri::command]
pub async fn azure_pr_update(
    app: AppHandle,
    target: PrTarget,
    description: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if target.number == 0 {
            return Err("Choose a PR first".into());
        }
        let config = require_config(&app, &target.site)?;
        checked_account(&config, &target.account_id)?;
        let description: String = description.trim().chars().take(64_000).collect();
        let repo = get(
            &config,
            &repository_path(&target.project, &target.repository)?,
            &[],
        )?;
        let repository = text(&repo, "id")?;
        let project = text(&repo["project"], "id")?;
        let path = format!(
            "{}/pullRequests/{}",
            repository_path(project, repository)?,
            target.number
        );
        let pr = request_method(
            &config,
            "PATCH",
            &path,
            &[("api-version", "7.1".into())],
            Some(json!({"description": description})),
        )
        .map_err(|error| write_denied(&error))?;
        verify_pr(&pr, project, repository, target.number)?;
        checked_account(&require_config(&app, &target.site)?, &target.account_id)?;
        Ok(json!({"pr": summary(&pr)?, "revision": revision(&pr)?}))
    })
    .await
    .map_err(|_| "Azure PR update task failed")?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrSection {
    Summary,
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

/// A write is confirmed against a fresh read — a moved revision or a switched
/// account must not be reported as a successful mutation of the seen PR.
fn recheck_active_pr(
    app: &AppHandle,
    target: &PrTarget,
    path: &str,
    expected_revision: &str,
) -> Result<(), String> {
    let config = require_config(app, &target.site)?;
    checked_account(&config, &target.account_id)?;
    let pr = get(&config, path, &[])?;
    verify_pr(&pr, &target.project, &target.repository, target.number)?;
    if revision(&pr)? != expected_revision {
        return Err("PR revision changed during the write. Refresh and retry.".into());
    }
    Ok(())
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
        let config = require_config(&app, &target.site)?;
        let path = verified_active_pr(&config, &target, &expected_revision)?;
        request_method(
            &config,
            "POST",
            &format!("{path}/threads/{thread_id}/comments"),
            &[("api-version", "7.1".into())],
            Some(json!({"content":body,"parentCommentId":0,"commentType":"text"})),
        )
        .map_err(|error| write_denied(&error))?;
        recheck_active_pr(&app, &target, &path, &expected_revision)?;
        Ok(json!({"revision":expected_revision}))
    })
    .await
    .map_err(|_| "Azure PR reply task failed")?
}

/// Change a thread's status — resolve ("fixed", "wontFix", "byDesign",
/// "closed") or reopen ("active", "pending").
#[tauri::command]
pub async fn azure_pr_thread_status(
    app: AppHandle,
    target: PrTarget,
    expected_revision: String,
    thread_id: u32,
    status: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if thread_id == 0 {
            return Err("Choose a review thread first".into());
        }
        if ![
            "active", "pending", "fixed", "wontFix", "closed", "byDesign",
        ]
        .contains(&status.as_str())
        {
            return Err("Unsupported thread status".into());
        }
        let config = require_config(&app, &target.site)?;
        let path = verified_active_pr(&config, &target, &expected_revision)?;
        request_method(
            &config,
            "PATCH",
            &format!("{path}/threads/{thread_id}"),
            &[("api-version", "7.1".into())],
            Some(json!({"status":status})),
        )
        .map_err(|error| write_denied(&error))?;
        recheck_active_pr(&app, &target, &path, &expected_revision)?;
        Ok(json!({"revision":expected_revision}))
    })
    .await
    .map_err(|_| "Azure PR thread update task failed")?
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
            if comment.line == 0 {
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
                request_method(
                    &config,
                    "POST",
                    &format!("{path}/threads"),
                    &[("api-version", "7.1".into())],
                    Some(json!({
                        "comments":[{"parentCommentId":0,"content":comment.body,"commentType":"text"}],
                        "status":"active",
                        "threadContext":thread_context,
                        "pullRequestThreadContext":{
                            "changeTrackingId":change_id,
                            // first == second compares the common commit to the
                            // latest iteration — the aggregated diff's view.
                            "iterationContext":{"firstComparingIteration":latest,"secondComparingIteration":latest}
                        }
                    })),
                )
                .map_err(|error| write_denied(&error))?;
            }
        }
        if !body.is_empty() {
            request_method(
                &config,
                "POST",
                &format!("{path}/threads"),
                &[("api-version", "7.1".into())],
                Some(json!({
                    "comments":[{"parentCommentId":0,"content":body,"commentType":"text"}],
                    "status":"active"
                })),
            )
            .map_err(|error| write_denied(&error))?;
        }
        if let Some(vote) = vote {
            request_method(
                &config,
                "PUT",
                &format!("{path}/reviewers/{}", component(&config.account_id)),
                &[("api-version", "7.1".into())],
                Some(json!({"id":config.account_id,"vote":vote})),
            )
            .map_err(|error| write_denied(&error))?;
        }
        recheck_active_pr(&app, &target, &path, &expected_revision)?;
        Ok(json!({"revision":expected_revision}))
    })
    .await
    .map_err(|_| "Azure PR review task failed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_story_prs_and_redacts_remote_credentials() {
        assert_eq!(
            story_pr_link(
                "https://dev.azure.com/team",
                &json!({"rel":"ArtifactLink","url":"vstfs:///Git/PullRequestId/project%2frepo%2F13"})
            ),
            Some("https://dev.azure.com/team/project/_git/repo/pullrequest/13".into())
        );
        assert!(story_pr_link(
            "https://dev.azure.com/team",
            &json!({"rel":"ArtifactLink","url":"vstfs:///Git/Commit/project/repo/13"})
        )
        .is_none());
        assert!(story_pr_link(
            "https://dev.azure.com/team",
            &json!({"rel":"ArtifactLink","url":"vstfs:///Git/PullRequestId/project/repo/0"})
        )
        .is_none());
        assert_eq!(
            safe_azure_remote(
                "https://user:secret@dev.azure.com/team/project/_git/repo?token=secret#secret"
            ),
            Some("https://dev.azure.com/team/project/_git/repo".into())
        );
        assert_eq!(
            safe_azure_remote("git@ssh.dev.azure.com:v3/team/project/repo"),
            Some("git@ssh.dev.azure.com:v3/team/project/repo".into())
        );
        assert!(
            safe_azure_remote("https://dev.azure.com.evil.test/team/project/_git/repo").is_none()
        );
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
