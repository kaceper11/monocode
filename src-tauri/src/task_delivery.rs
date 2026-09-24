//! Read-only, revision-bound delivery evidence for the existing board lanes.
use crate::fs::{expand_home, gh_checked, git_pr_status_for, git_run, GitPr};
use crate::{azure_devops as az, azure_devops_board as az_board, gitlab as gl};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    hash::{Hash, Hasher},
    io::Read,
    path::Path,
};
use tauri::AppHandle;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Gitlab,
    Azuredevops,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiBinding {
    provider: Provider,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    project: String,
    #[serde(default)]
    definition_ids: Vec<i64>,
    /// Connection URL selected in the UI. Never contains a credential.
    #[serde(default)]
    host: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub provider: Provider,
    pub repo: String,
    pub host: String,
    pub account: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub name: String,
    pub state: String,
    pub bucket: String,
    pub url: String,
    pub sha: String,
    pub source: Source,
    #[serde(default)]
    pub run_id: Option<i64>,
    #[serde(default)]
    pub job_id: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pr: Option<GitPr>,
    source: Source,
    head_sha: String,
    local_head: String,
    checks: Vec<Check>,
    ci_source: Option<Source>,
    ci_error: Option<String>,
}
fn field(v: &Value, k: &str) -> String {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn pointer(v: &Value, k: &str) -> String {
    v.pointer(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn account(token: &str) -> String {
    let mut hash = DefaultHasher::new();
    token.hash(&mut hash);
    format!("{:x}", hash.finish())
}
/// Read-only delivery calls use the existing WSL boundary and a bounded native child.
fn github_read(root: &Path, args: &[&str]) -> Result<String, String> {
    if let Some(location) = crate::wsl::path_location(root)? {
        return crate::wsl::request(&location, "gh", json!({"args":args}));
    }
    let program = crate::harness::resolve_gui_binary("gh").ok_or("Install GitHub CLI (gh)")?;
    let mut command = std::process::Command::new(program);
    command
        .current_dir(root)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat");
    crate::harness::apply_gui_env(&mut command);
    crate::hide_window_console(&mut command);
    let output = crate::bounded_process::output(
        &mut command,
        std::time::Duration::from_secs(25),
        8 * 1024 * 1024,
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
fn excerpt(text: String) -> Log {
    let truncated = text.len() > 32 * 1024;
    let mut start = text.len().saturating_sub(32 * 1024);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    Log {
        text: text[start..].to_string(),
        truncated,
    }
}
fn github_job(url: &str, source: &Source) -> Option<(i64, i64)> {
    let url = url::Url::parse(url).ok()?;
    if url.host_str()? != source.host || url.scheme() != "https" {
        return None;
    }
    let prefix = format!("/{}/actions/runs/", source.repo);
    let path = url.path().strip_prefix(&prefix)?;
    let (run, job) = path.split_once("/job/")?;
    Some((run.parse().ok()?, job.parse().ok()?))
}
fn github(root: &Path, host: &str, endpoint: &str) -> Result<Value, String> {
    serde_json::from_str(&github_read(root, &["api", "--hostname", host, endpoint])?)
        .map_err(|_| "GitHub returned invalid JSON".into())
}
fn source(
    app: &AppHandle,
    root: &Path,
    provider: &Provider,
    binding: Option<&CiBinding>,
) -> Result<Source, String> {
    let (repo, host, account) = match provider {
        Provider::Github => {
            let (repo, host) = if let Some(b) = binding.filter(|b| !b.repo.is_empty()) {
                let host = if b.host.is_empty() {
                    "github.com"
                } else {
                    &b.host
                };
                let url = url::Url::parse(&format!("https://{host}"))
                    .map_err(|_| "Invalid GitHub host")?;
                if url.host_str() != Some(host) || !url.username().is_empty() {
                    return Err("Invalid GitHub host".into());
                }
                (b.repo.clone(), host.to_string())
            } else {
                let value: Value = serde_json::from_str(&gh_checked(
                    root,
                    &["repo", "view", "--json", "nameWithOwner,url"],
                )?)
                .map_err(|e| e.to_string())?;
                let url = url::Url::parse(&field(&value, "url"))
                    .map_err(|_| "Invalid GitHub repository URL")?;
                (
                    field(&value, "nameWithOwner"),
                    url.host_str().ok_or("Missing GitHub host")?.to_string(),
                )
            };
            if repo.split('/').count() != 2
                || !repo
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
            {
                return Err("Use a GitHub owner/repository name".into());
            }
            let user = github(root, &host, "user")?;
            (repo, host, user["id"].to_string())
        }
        Provider::Gitlab => {
            let config = gl::require_config(app)?;
            let repo = match binding.filter(|b| !b.repo.is_empty()) {
                Some(b) => gl::validate_repo(&b.repo)?,
                None => gl::gitlab_repo_for(root, &config.url)?,
            };
            (repo, config.url, account(&config.token))
        }
        Provider::Azuredevops => {
            let config = az::require_config(app)?;
            let repo = match binding.filter(|b| !b.project.is_empty()) {
                Some(b) => b.project.clone(),
                None => az::azure_devops_repo_for(root, &config.url)?,
            };
            (repo, config.url, account(&config.token))
        }
    };
    if let Some(b) = binding {
        if !b.host.is_empty() && b.host != host {
            return Err("Provider connection changed — select the CI source again".into());
        }
    }
    if repo.is_empty()
        || repo
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
        || repo.contains(['?', '#', '\\'])
    {
        return Err("Invalid provider repository".into());
    }
    Ok(Source {
        provider: provider.clone(),
        repo,
        host,
        account,
    })
}
fn detect(app: &AppHandle, root: &Path) -> Result<Provider, String> {
    if let Some(config) = az::read_config(app)? {
        if az::azure_devops_repo_for(root, &config.url).is_ok() {
            return Ok(Provider::Azuredevops);
        }
    }
    if let Some(config) = gl::read_config(app)? {
        if gl::gitlab_repo_for(root, &config.url).is_ok() {
            return Ok(Provider::Gitlab);
        }
    }
    // gh must resolve a real GitHub repository; no successful fallback to an empty status.
    gh_checked(root, &["repo", "view", "--json", "nameWithOwner"])?;
    Ok(Provider::Github)
}
fn pinned_number(pin: Option<&str>, source: &Source) -> Result<Option<i64>, String> {
    let Some(pin) = pin.filter(|p| !p.trim().is_empty()) else {
        return Ok(None);
    };
    let url = url::Url::parse(pin).map_err(|_| "Invalid PR URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid PR URL".into());
    }
    let prefix = match source.provider {
        Provider::Github => format!("https://{}/{}/pull/", source.host, source.repo),
        Provider::Gitlab => format!(
            "{}/{}/-/merge_requests/",
            source.host.trim_end_matches('/'),
            source.repo
        ),
        Provider::Azuredevops => {
            let (project, repo) = az::split_repo(&source.repo)?;
            format!(
                "{}/{}/_git/{}/pullrequest/",
                source.host.trim_end_matches('/'),
                az::encode_segment(&project),
                az::encode_segment(&repo)
            )
        }
    };
    let base = url::Url::parse(&prefix).map_err(|_| "Invalid provider URL")?;
    if url.origin() != base.origin() {
        return Err("PR URL belongs to another provider connection".into());
    }
    let path = url
        .path()
        .strip_prefix(base.path())
        .ok_or("PR URL belongs to another repository")?;
    path.trim_end_matches('/')
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .map(Some)
        .ok_or_else(|| "Invalid PR number".into())
}
fn pr_snapshot(
    app: &AppHandle,
    root: &Path,
    source: &Source,
    branch: &str,
    pin: Option<&str>,
) -> Result<(Option<GitPr>, String, Vec<String>), String> {
    let number = pinned_number(pin, source)?;
    match source.provider {
        Provider::Github => {
            let pr = git_pr_status_for(root, pin)?;
            let Some(pr) = pr else {
                return Ok((None, String::new(), vec![]));
            };
            let value = github(
                root,
                &source.host,
                &format!("repos/{}/pulls/{}", source.repo, pr.number),
            )?;
            let head = pointer(&value, "/head/sha");
            Ok((Some(pr), head, vec![field(&value, "merge_commit_sha")]))
        }
        Provider::Gitlab => {
            let config = gl::require_config(app)?;
            let endpoint = format!(
                "/projects/{}/merge_requests",
                gl::encode_path_component(&source.repo)
            );
            let value = if let Some(number) = number {
                gl::gitlab_get(&config, &format!("{endpoint}/{number}"))?.value
            } else {
                let rows = gl::gitlab_get(
                    &config,
                    &format!(
                        "{endpoint}?source_branch={}&order_by=updated_at&sort=desc&per_page=100",
                        gl::encode_path_component(branch)
                    ),
                )?;
                if rows.has_next_page {
                    return Err("More merge requests match this branch — pin the MR URL".into());
                }
                let list = rows
                    .value
                    .as_array()
                    .ok_or("Invalid GitLab merge requests")?;
                let Some(row) = list
                    .iter()
                    .find(|v| field(v, "state") == "opened")
                    .or_else(|| list.first())
                else {
                    return Ok((None, String::new(), vec![]));
                };
                gl::gitlab_get(&config, &format!("{endpoint}/{}", row["iid"]))?.value
            };
            let head = field(&value, "sha");
            let pr = GitPr {
                number: value["iid"].as_i64().ok_or("Missing MR number")?,
                title: field(&value, "title"),
                url: field(&value, "web_url"),
                state: match field(&value, "state").as_str() {
                    "opened" => "open".into(),
                    s => s.into(),
                },
                review_decision: None,
                unresolved_threads: None,
                draft: value["draft"].as_bool(),
                updated_at: Some(field(&value, "updated_at")),
                merge_state: match field(&value, "detailed_merge_status").as_str() {
                    "conflict" => Some("conflicts".into()),
                    "not_approved" | "discussions_not_resolved" => Some("blocked".into()),
                    _ => None,
                },
            };
            let pipeline_sha = pointer(&value, "/head_pipeline/sha");
            let mut validation = vec![];
            if !pipeline_sha.is_empty() && pipeline_sha != head {
                let commit = gl::gitlab_get(
                    &config,
                    &format!(
                        "/projects/{}/repository/commits/{}",
                        gl::encode_path_component(&source.repo),
                        gl::encode_path_component(&pipeline_sha)
                    ),
                )?
                .value;
                if commit["parent_ids"]
                    .as_array()
                    .is_some_and(|parents| parents.iter().any(|p| p.as_str() == Some(&head)))
                {
                    validation.push(pipeline_sha);
                }
            }
            Ok((Some(pr), head, validation))
        }
        Provider::Azuredevops => {
            let config = az::require_config(app)?;
            let (project, repo) = az::split_repo(&source.repo)?;
            let value = match number {
                Some(n) => Some(az_board::pr_row_by_id(&config, &project, &repo, n)?),
                None => az_board::pr_for_branch(&config, &project, &repo, branch)?,
            };
            let Some(value) = value else {
                return Ok((None, String::new(), vec![]));
            };
            let mut pr = az_board::pr_to_git_pr(&value, &project, &repo, &config)
                .ok_or("Invalid Azure PR")?;
            pr.unresolved_threads =
                az_board::active_thread_count(&config, &project, &repo, pr.number);
            Ok((
                Some(pr),
                pointer(&value, "/lastMergeSourceCommit/commitId"),
                vec![pointer(&value, "/lastMergeCommit/commitId")],
            ))
        }
    }
}
fn bucket(state: &str) -> &str {
    match state.to_ascii_lowercase().as_str() {
        "success" | "succeeded" => "pass",
        "failed" | "failure" | "error" | "startup_failure" | "timed_out" | "partiallysucceeded" => {
            "fail"
        }
        "canceled" | "cancelled" => "cancel",
        "skipped" | "neutral" => "skipping",
        "manual" | "blocked" | "action_required" => "blocked",
        "scheduled"
        | "created"
        | "pending"
        | "running"
        | "preparing"
        | "waiting_for_resource"
        | "inprogress"
        | "notstarted"
        | "queued"
        | "in_progress" => "pending",
        _ => "unknown",
    }
}
fn gitlab_checks(
    app: &AppHandle,
    source: &Source,
    sha: &str,
    validation: &[String],
) -> Result<Vec<Check>, String> {
    let config = gl::require_config(app)?;
    let prefix = format!("/projects/{}", gl::encode_path_component(&source.repo));
    let mut checks = vec![];
    for revision in std::iter::once(sha)
        .chain(validation.iter().map(String::as_str))
        .filter(|s| !s.is_empty())
    {
        let response = gl::gitlab_get(
            &config,
            &format!(
                "{prefix}/pipelines?sha={}&order_by=id&sort=desc&per_page=100",
                gl::encode_path_component(revision)
            ),
        )?;
        if response.has_next_page {
            return Err("Pipeline results are incomplete — open GitLab".into());
        }
        let mut sources = HashSet::new();
        for run in response
            .value
            .as_array()
            .ok_or("Invalid GitLab pipelines")?
            .iter()
            .filter(|run| sources.insert(field(run, "source")))
        {
            let run_id = run["id"].as_i64().ok_or("Missing pipeline ID")?;
            let state = field(run, "status");
            checks.push(Check {
                id: format!("gitlab-pipeline:{run_id}"),
                name: format!("Pipeline #{run_id}"),
                bucket: bucket(&state).into(),
                state,
                url: field(run, "web_url"),
                sha: revision.into(),
                source: source.clone(),
                run_id: Some(run_id),
                job_id: None,
            });
            for page in 1..=5 {
                let response = gl::gitlab_get(
                    &config,
                    &format!("{prefix}/pipelines/{run_id}/jobs?per_page=100&page={page}"),
                )?;
                for job in response.value.as_array().ok_or("Invalid GitLab jobs")? {
                    let id = job["id"].as_i64().ok_or("Missing job ID")?;
                    let state = field(job, "status");
                    checks.push(Check {
                        id: format!("gitlab:{id}"),
                        name: field(job, "name"),
                        bucket: if job["allow_failure"].as_bool() == Some(true) && state == "failed"
                        {
                            "skipping".into()
                        } else {
                            bucket(&state).into()
                        },
                        state,
                        url: field(job, "web_url"),
                        sha: revision.into(),
                        source: source.clone(),
                        run_id: Some(run_id),
                        job_id: Some(id),
                    });
                }
                if !response.has_next_page {
                    break;
                }
                if page == 5 {
                    return Err("Job results are incomplete — open GitLab".into());
                }
            }
        }
    }
    let mut seen = HashSet::new();
    checks.retain(|c| seen.insert(c.id.clone()));
    Ok(checks)
}
fn azure_checks(
    config: &az::AzureDevOpsConfig,
    source: &Source,
    binding: Option<&CiBinding>,
    sha: &str,
    validation: &[String],
) -> Result<(Vec<Check>, Option<String>), String> {
    let project = match binding.filter(|b| !b.project.is_empty()) {
        Some(b) => b.project.clone(),
        None => az::split_repo(&source.repo)?.0,
    };
    let ids = binding
        .map(|b| b.definition_ids.clone())
        .unwrap_or_default();
    if binding.is_some_and(|b| !b.project.is_empty()) && ids.is_empty() {
        return Err("Select at least one Azure pipeline definition".into());
    }
    let definition_filter = if ids.is_empty() {
        String::new()
    } else {
        format!(
            "&definitions={}",
            ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
        )
    };
    let repo_filter = if binding.is_none_or(|b| b.project.is_empty()) {
        format!(
            "&repositoryId={}&repositoryType=TfsGit",
            az::repository_id(config, &project, &az::split_repo(&source.repo)?.1)?
        )
    } else {
        String::new()
    };
    let endpoint = format!("/{}/_apis/build/builds?queryOrder=queueTimeDescending&$top=100{definition_filter}{repo_filter}&api-version=7.1",az::encode_segment(&project));
    let mut seen = HashSet::new();
    let mut checks = vec![];
    let result = (|| -> Result<(), String> {
        let mut continuation = String::new();
        let mut tokens = HashSet::new();
        // ponytail: cap history at 1,000 builds; narrow the query if larger histories matter.
        for _ in 0..10 {
            let response = az::azure_get(config, &format!("{endpoint}{continuation}"))?;
            for run in response.value["value"]
                .as_array()
                .ok_or("Invalid Azure build response")?
            {
                let revision = field(run, "sourceVersion");
                let pr_source = pointer(run, "/triggerInfo/pr.sourceSha");
                if !revision_matches(&revision, &pr_source, sha, validation) {
                    continue;
                }
                let definition = run["definition"]["id"]
                    .as_i64()
                    .ok_or("Missing pipeline definition")?;
                if !seen.insert(definition) {
                    continue;
                }
                let id = run["id"].as_i64().ok_or("Missing build ID")?;
                let state = if field(run, "result").is_empty() {
                    field(run, "status")
                } else {
                    field(run, "result")
                };
                checks.push(Check {
                    id: format!("azure:{id}"),
                    name: pointer(run, "/definition/name"),
                    bucket: bucket(&state).into(),
                    state,
                    url: pointer(run, "/_links/web/href"),
                    sha: revision,
                    source: Source {
                        repo: project.clone(),
                        ..source.clone()
                    },
                    run_id: Some(id),
                    job_id: None,
                });
            }
            if (!ids.is_empty() && ids.iter().all(|id| seen.contains(id)))
                || response.continuation_token.is_none()
            {
                return Ok(());
            }
            let token = response.continuation_token.unwrap();
            if !tokens.insert(token.clone()) {
                return Err(
                    "Azure repeated a build continuation token — refresh or open Azure".into(),
                );
            }
            continuation = format!("&continuationToken={}", az::encode_segment(&token));
        }
        Err("Azure build history exceeds the lookup limit — narrow the selected pipelines or open Azure".into())
    })();
    Ok((checks, result.err()))
}
fn revision_matches(revision: &str, pr_source: &str, head: &str, validation: &[String]) -> bool {
    !head.is_empty()
        && (revision == head
            || pr_source == head
            || (!revision.is_empty() && validation.iter().any(|s| s == revision)))
}
fn github_checks(root: &Path, source: &Source, sha: &str) -> Result<Vec<Check>, String> {
    let mut checks = vec![];
    for page in 1..=5 {
        let value = github(
            root,
            &source.host,
            &format!(
                "repos/{}/commits/{}/check-runs?per_page=100&page={page}",
                source.repo, sha
            ),
        )?;
        let rows = value["check_runs"]
            .as_array()
            .ok_or("Invalid GitHub checks")?;
        for row in rows {
            let state = if field(row, "conclusion").is_empty() {
                field(row, "status")
            } else {
                field(row, "conclusion")
            };
            let id = row["id"].as_i64().ok_or("Missing check ID")?;
            checks.push(Check {
                id: format!("github:{id}"),
                name: field(row, "name"),
                state: state.clone(),
                bucket: bucket(&state).into(),
                url: field(row, "details_url"),
                sha: field(row, "head_sha"),
                source: source.clone(),
                run_id: None,
                job_id: Some(id),
            });
        }
        if rows.len() < 100 {
            break;
        }
        if page == 5 {
            return Err("GitHub check results are incomplete".into());
        }
    }
    for page in 1..=5 {
        let value = github(
            root,
            &source.host,
            &format!(
                "repos/{}/commits/{}/status?per_page=100&page={page}",
                source.repo, sha
            ),
        )?;
        let rows = value["statuses"]
            .as_array()
            .ok_or("Invalid GitHub statuses")?;
        for row in rows {
            let state = field(row, "state");
            checks.push(Check {
                id: format!("github-status:{}", row["id"]),
                name: field(row, "context"),
                bucket: bucket(&state).into(),
                state,
                url: field(row, "target_url"),
                sha: sha.into(),
                source: source.clone(),
                run_id: None,
                job_id: None,
            });
        }
        if rows.len() < 100 {
            break;
        }
        if page == 5 {
            return Err("GitHub status results are incomplete".into());
        }
    }
    Ok(checks)
}
#[tauri::command]
pub async fn task_delivery_probe(
    app: AppHandle,
    cwd: String,
    branch: String,
    pr_url: Option<String>,
    pr_provider: Option<Provider>,
    ci: Option<CiBinding>,
) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(binding) = &ci {
            if binding.definition_ids.len() > 100
                || binding.definition_ids.iter().any(|id| *id <= 0)
            {
                return Err("Invalid pipeline definition selection".into());
            }
            if binding.project.contains('/') || binding.project.len() > 200 {
                return Err("Invalid Azure project".into());
            }
        }
        let root = expand_home(&cwd);
        let provider = match pr_provider {
            Some(p) => p,
            None => detect(&app, &root)?,
        };
        let source = source(&app, &root, &provider, None)?;
        let local_head = git_run(&root, &["rev-parse", "HEAD"])
            .ok_or("Could not read checkout HEAD")?
            .trim()
            .to_string();
        let (pr, head, validation) = pr_snapshot(&app, &root, &source, &branch, pr_url.as_deref())?;
        if pr.is_some() && head.is_empty() {
            return Err("Provider did not return the PR head revision".into());
        }
        let head_sha = if head.is_empty() {
            local_head.clone()
        } else {
            head
        };
        let ci_source = match &ci {
            Some(b) => self::source(&app, &root, &b.provider, Some(b)),
            None => Ok(source.clone()),
        };
        let (checks, ci_error, ci_source) = match ci_source {
            Ok(cs) => {
                let result = match cs.provider {
                    Provider::Github => (|| {
                        let mut checks = github_checks(&root, &cs, &head_sha)?;
                        if cs == source {
                            for sha in validation
                                .iter()
                                .filter(|sha| !sha.is_empty() && **sha != head_sha)
                            {
                                checks.extend(github_checks(&root, &cs, sha)?);
                            }
                        }
                        let mut seen = HashSet::new();
                        checks.retain(|c| seen.insert(c.id.clone()));
                        Ok(checks)
                    })()
                    .map(|checks| (checks, None)),
                    Provider::Gitlab => gitlab_checks(
                        &app,
                        &cs,
                        &head_sha,
                        if cs == source { &validation } else { &[] },
                    )
                    .map(|checks| (checks, None)),
                    Provider::Azuredevops => az::require_config(&app).and_then(|config| {
                        azure_checks(
                            &config,
                            &cs,
                            ci.as_ref(),
                            &head_sha,
                            if cs == source { &validation } else { &[] },
                        )
                    }),
                };
                match result {
                    Ok((checks, error)) => (checks, error, Some(cs)),
                    Err(e) => (vec![], Some(e), Some(cs)),
                }
            }
            Err(e) => (vec![], Some(e), None),
        };
        Ok(Snapshot {
            pr,
            source,
            head_sha,
            local_head,
            checks,
            ci_source,
            ci_error,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn task_delivery_definitions(app: AppHandle, project: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if project.trim().is_empty() { return Err("Enter an Azure project".into()); }
        let config = az::require_config(&app)?;
        let result = az::azure_get(&config,&format!("/{}/_apis/build/definitions?$top=100&api-version=7.1",az::encode_segment(&project)))?;
        Ok(json!({"host":config.url,"definitions":result.value["value"],"truncated":result.truncated}))
    }).await.map_err(|e| e.to_string())?
}
#[derive(Serialize)]
pub struct Log {
    text: String,
    truncated: bool,
}
fn read_log(response: ureq::Response) -> Result<Log, String> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(32 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let truncated = bytes.len() > 32 * 1024;
    bytes.truncate(32 * 1024);
    Ok(Log {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}
#[tauri::command]
pub async fn task_delivery_log(app: AppHandle, cwd: String, check: Check) -> Result<Log, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let s = &check.source;
        // Re-read credentials and identity, never fetch arbitrary supplied URLs.
        match s.provider {
            Provider::Gitlab => {
                let config = gl::require_config(&app)?;
                if config.url != s.host || account(&config.token) != s.account {
                    return Err("GitLab connection changed".into());
                }
                let repo = gl::validate_repo(&s.repo)?;
                let id = check.job_id.filter(|n| *n > 0).ok_or("Missing job ID")?;
                let prefix = format!("/projects/{}/jobs/{id}", gl::encode_path_component(&repo));
                let job = gl::gitlab_get(&config, &prefix)?.value;
                if pointer(&job, "/commit/id") != check.sha {
                    return Err("Job revision changed".into());
                }
                read_log(
                    gl::gitlab_agent()
                        .get(&format!("{}/api/v4{prefix}/trace", config.url))
                        .set("PRIVATE-TOKEN", &config.token)
                        .call()
                        .map_err(|_| "GitLab log unavailable")?,
                )
            }
            Provider::Azuredevops => {
                let config = az::require_config(&app)?;
                if config.url != s.host || account(&config.token) != s.account {
                    return Err("Azure connection changed".into());
                }
                let id = check.run_id.filter(|n| *n > 0).ok_or("Missing build ID")?;
                let prefix = format!("/{}/_apis/build/builds/{id}", az::encode_segment(&s.repo));
                let build = az::azure_get(&config, &format!("{prefix}?api-version=7.1"))?.value;
                if field(&build, "sourceVersion") != check.sha {
                    return Err("Build revision changed".into());
                }
                let timeline =
                    az::azure_get(&config, &format!("{prefix}/timeline?api-version=7.1"))?.value;
                let records = timeline["records"]
                    .as_array()
                    .ok_or("Build timeline unavailable")?;
                let mut text = String::new();
                let mut truncated = false;
                for record in records.iter().filter(|r| field(r, "result") == "failed") {
                    let Some(log_id) = record["log"]["id"].as_i64() else {
                        continue;
                    };
                    let url = format!("{}{prefix}/logs/{log_id}?api-version=7.1", config.url);
                    let log = read_log(
                        az::azure_agent()
                            .get(&url)
                            .set("Authorization", &az::basic_auth(&config.token))
                            .call()
                            .map_err(|_| "Azure log unavailable")?,
                    )?;
                    text.push_str(&format!("{}\n{}\n", field(record, "name"), log.text));
                    truncated |= log.truncated;
                    if text.len() > 32 * 1024 {
                        truncated = true;
                        break;
                    }
                }
                if text.is_empty() {
                    return Err("No failed task logs available; open the build".into());
                }
                while text.len() > 32 * 1024 {
                    text.pop();
                }
                Ok(Log { text, truncated })
            }
            Provider::Github => {
                let user = github(&root, &s.host, "user")?;
                if user["id"].as_u64() != s.account.parse::<u64>().ok() {
                    return Err("GitHub account changed".into());
                }
                let id = check
                    .job_id
                    .filter(|n| *n > 0)
                    .ok_or("External check: open its provider for logs")?;
                let value = github(&root, &s.host, &format!("repos/{}/check-runs/{id}", s.repo))?;
                if field(&value, "head_sha") != check.sha {
                    return Err("Check revision changed".into());
                }
                if let Some((run, job)) = github_job(&field(&value, "details_url"), s) {
                    let repo = format!("https://{}/{}", s.host, s.repo);
                    if let Ok(log) = github_read(
                        &root,
                        &[
                            "run",
                            "view",
                            &run.to_string(),
                            "--job",
                            &job.to_string(),
                            "--repo",
                            &repo,
                            "--log-failed",
                        ],
                    ) {
                        if !log.trim().is_empty() {
                            return Ok(excerpt(log));
                        }
                    }
                }
                let annotations = github(
                    &root,
                    &s.host,
                    &format!("repos/{}/check-runs/{id}/annotations?per_page=50", s.repo),
                )?;
                let mut text = format!(
                    "{}\n{}",
                    pointer(&value, "/output/summary"),
                    pointer(&value, "/output/text")
                );
                for annotation in annotations.as_array().ok_or("Invalid annotations")? {
                    text.push_str(&format!(
                        "\n{}:{} {}",
                        field(annotation, "path"),
                        annotation["start_line"],
                        field(annotation, "message")
                    ));
                }
                if text.trim().is_empty() {
                    return Err(
                        "No failure annotations available; open the check for its logs".into(),
                    );
                }
                let truncated =
                    text.len() > 32 * 1024 || annotations.as_array().is_some_and(|a| a.len() == 50);
                while text.len() > 32 * 1024 {
                    text.pop();
                }
                Ok(Log { text, truncated })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;

    fn build(id: i64, definition: i64, sha: &str) -> Value {
        json!({"id": id, "definition": {"id": definition, "name": "Build"}, "sourceVersion": sha, "result": "succeeded"})
    }

    fn azure_pages(
        pages: Vec<(u16, Option<String>, Value)>,
        ids: Vec<i64>,
    ) -> (Vec<Check>, Option<String>, Vec<String>) {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::time::{Duration, Instant};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let config = az::AzureDevOpsConfig {
            url: format!("http://{}", listener.local_addr().unwrap()),
            token: "test".into(),
        };
        let source = Source {
            provider: Provider::Azuredevops,
            repo: "Project".into(),
            host: config.url.clone(),
            account: "test".into(),
        };
        let binding = CiBinding {
            provider: Provider::Azuredevops,
            project: "Project".into(),
            repo: String::new(),
            host: config.url.clone(),
            definition_ids: ids,
        };
        let server = std::thread::spawn(move || {
            let mut requests = vec![];
            for (status, token, body) in pages {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(error) => panic!("Missing Azure request: {error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                requests.push(request);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                }
                let header = token
                    .map(|token| format!("x-ms-continuationtoken: {token}\r\n"))
                    .unwrap_or_default();
                let body = body.to_string();
                write!(stream, "HTTP/1.1 {status} Test\r\n{header}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        let (checks, error) =
            azure_checks(&config, &source, Some(&binding), "head", &["merge".into()]).unwrap();
        (checks, error, server.join().unwrap())
    }

    #[test]
    fn azure_ci_pages_and_keeps_latest_revision_matches() {
        let mut triggered = build(5, 8, "trigger-merge");
        triggered["triggerInfo"] = json!({"pr.sourceSha": "head"});
        let (checks, error, requests) = azure_pages(
            vec![
                (
                    200,
                    Some("next+/=".into()),
                    json!({"value": [build(9, 7, "old"), build(8, 7, "head")]}),
                ),
                (
                    200,
                    Some("more-history".into()),
                    json!({"value": [build(7, 7, "head"), triggered, build(4, 8, "merge")]}),
                ),
            ],
            vec![7, 8],
        );
        assert!(error.is_none());
        assert_eq!(
            checks.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["azure:8", "azure:5"]
        );
        assert!(requests[1].contains("continuationToken=next%2B%2F%3D"));
        assert!(
            requests
                .iter()
                .all(|r| r.contains("definitions=7,8")
                    && r.contains("queryOrder=queueTimeDescending"))
        );
    }

    #[test]
    fn azure_ci_retains_checks_on_errors_repeated_tokens_and_page_limit() {
        for (status, token, body, expected) in [
            (500, None, json!({"message":"offline"}), "offline"),
            (200, Some("next".into()), json!({"value": []}), "repeated"),
            (200, None, json!({"invalid": true}), "Invalid Azure"),
        ] {
            let (checks, error, _) = azure_pages(
                vec![
                    (
                        200,
                        Some("next".into()),
                        json!({"value": [build(8, 7, "head")]}),
                    ),
                    (status, token, body),
                ],
                vec![7, 8],
            );
            assert_eq!(checks.len(), 1);
            assert!(error.unwrap().contains(expected));
        }
        let pages = (0..10)
            .map(|page| {
                (
                    200,
                    Some(format!("page-{page}")),
                    json!({"value": [build(8, 7, "head")]}),
                )
            })
            .collect();
        let (checks, error, requests) = azure_pages(pages, vec![7, 8]);
        assert_eq!(checks.len(), 1);
        assert!(error.unwrap().contains("lookup limit"));
        assert_eq!(requests.len(), 10);
    }

    #[test]
    fn azure_ci_empty_final_page_is_complete_and_selected_pipeline_stops_early() {
        let (checks, error, _) = azure_pages(vec![(200, None, json!({"value": []}))], vec![7]);
        assert!(checks.is_empty() && error.is_none());
        let (checks, error, _) = azure_pages(
            vec![(
                200,
                Some("old-history".into()),
                json!({"value": [build(8, 7, "head")]}),
            )],
            vec![7],
        );
        assert_eq!(checks.len(), 1);
        assert!(error.is_none());
    }

    #[test]
    fn azure_ci_resolves_repository_names_before_querying_builds() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::time::Duration;

        let guid = "12345678-1234-1234-1234-123456789abc";
        for repository in [json!({ "id": guid }), json!({}), json!({ "id": "web app" })] {
            let valid = repository["id"] == guid;
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let config = az::AzureDevOpsConfig {
                url: format!("http://{}", listener.local_addr().unwrap()),
                token: "test-token".into(),
            };
            let source = Source {
                provider: Provider::Azuredevops,
                repo: "My Project/web app".into(),
                host: config.url.clone(),
                account: "test".into(),
            };
            let server = std::thread::spawn(move || {
                let mut requests = vec![];
                let mut responses = vec![repository];
                if valid {
                    responses.push(json!({ "value": [{
                        "id": 42, "sourceVersion": "head", "result": "succeeded",
                        "definition": { "id": 7, "name": "Build" }
                    }] }));
                }
                for body in responses {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request = String::new();
                    reader.read_line(&mut request).unwrap();
                    requests.push(request);
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                            break;
                        }
                    }
                    let body = body.to_string();
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                }
                requests
            });
            let result = azure_checks(&config, &source, None, "head", &[]);
            let requests = server.join().unwrap();
            assert!(requests[0].contains("/My%20Project/_apis/git/repositories/web%20app?"));
            if valid {
                assert!(requests[1].contains(&format!("repositoryId={guid}&repositoryType=TfsGit")));
                let (checks, error) = result.unwrap();
                assert!(error.is_none());
                assert_eq!(checks.len(), 1);
                assert_eq!(checks[0].bucket, "pass");
            } else {
                assert_eq!(
                    result.unwrap_err(),
                    "Azure DevOps did not return a valid repository GUID"
                );
            }
        }
    }

    #[test]
    fn log_excerpts_are_bounded_and_action_links_are_scoped() {
        let log = excerpt("é".repeat(40_000));
        assert!(log.truncated);
        assert!(log.text.len() <= 32 * 1024);
        assert!(log.text.ends_with('é'));
        let source = Source {
            provider: Provider::Github,
            repo: "a/b".into(),
            host: "github.com".into(),
            account: "1".into(),
        };
        assert_eq!(
            github_job("https://github.com/a/b/actions/runs/12/job/34", &source),
            Some((12, 34))
        );
        assert!(github_job("https://github.com/a/c/actions/runs/12/job/34", &source).is_none());
        assert!(github_job("https://evil.test/a/b/actions/runs/12/job/34", &source).is_none());
    }
    #[test]
    fn revision_and_state_are_not_guessed() {
        assert!(!revision_matches("old", "", "head", &[]));
        assert!(revision_matches("merge", "head", "head", &[]));
        assert!(revision_matches("merge", "", "head", &["merge".into()]));
        assert!(!revision_matches("", "", "", &[]));
        assert_eq!(bucket("manual"), "blocked");
        assert_eq!(bucket("canceled"), "cancel");
        assert_eq!(bucket("new-provider-state"), "unknown");
    }
    #[test]
    fn pins_must_match_connection_and_repository() {
        let source = Source {
            provider: Provider::Github,
            repo: "a/b".into(),
            host: "github.com".into(),
            account: "1".into(),
        };
        assert_eq!(
            pinned_number(Some("https://github.com/a/b/pull/42"), &source).unwrap(),
            Some(42)
        );
        for url in [
            "https://evil.test/a/b/pull/42",
            "https://github.com/a/c/pull/42",
            "https://github.com/a/b/pull/-1",
        ] {
            assert!(pinned_number(Some(url), &source).is_err());
        }
    }
}

/// Resolve the PR's exact repository before the review workflow fetches its head.
#[tauri::command]
pub async fn task_review_remote(
    app: AppHandle,
    cwd: String,
    provider: Provider,
    repo: String,
    pr_url: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let (project, name) = if provider == Provider::Azuredevops {
            let (project, name) = az::split_repo(&repo)?;
            (project, name)
        } else {
            (String::new(), repo)
        };
        let binding = CiBinding {
            provider: provider.clone(),
            repo: name,
            project,
            definition_ids: vec![],
            host: String::new(),
        };
        let expected = source(&app, &root, &provider, Some(&binding))?;
        pinned_number(Some(&pr_url), &expected)?.ok_or("A review needs a PR URL")?;
        if provider == Provider::Github {
            return crate::fs::remote_matching_github_url(
                &root,
                &format!("https://{}/{}", expected.host, expected.repo),
            )
            .ok_or_else(|| "No local remote matches this PR repository".into());
        }
        let remotes = git_run(&root, &["remote", "-v"]).ok_or("Cannot list repository remotes")?;
        for line in remotes.lines() {
            let parts: Vec<_> = line.split_whitespace().collect();
            if parts.len() < 3 || parts[2] != "(fetch)" {
                continue;
            }
            let matched = if provider == Provider::Gitlab {
                gl::project_from_remote(parts[1], &expected.host)
            } else {
                az::project_repo_from_remote(parts[1], &expected.host)
            };
            if matched.as_deref() == Some(expected.repo.as_str()) {
                return Ok(parts[0].to_string());
            }
        }
        Err("No local remote matches this PR repository".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
