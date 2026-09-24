//! Board-facing Azure DevOps operations: per-branch pull request status and
//! creation plus the pipeline builds that stand in for check runs. Upstream's
//! `azure_devops.rs` keeps the inbox surface; this adds the worktree-level
//! operations the board's task lanes need. Everything here keys off the
//! worktree's checked-out branch, matching `git_pr_*`'s contract for GitHub.

use std::cmp::Reverse;
use std::collections::HashSet;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::azure_devops::{
    azure_devops_repo_for, azure_get, azure_request_json, encode_segment, match_remote,
    parse_azure_remote, parse_pr, percent_decode, pr_web_url, read_config, remote_urls,
    repository_id, require_config, short_ref, split_repo, string_field, AzureDevOpsConfig,
    API_VERSION,
};
use crate::fs::{expand_home, git_branch, GitPr, GitPrCheck};

/// `(config, project, repo)` for a worktree on an Azure DevOps remote.
fn repo_context(app: &AppHandle, cwd: &str) -> Result<(AzureDevOpsConfig, String, String), String> {
    let config = require_config(app)?;
    let repo = azure_devops_repo_for(&expand_home(cwd), &config.url)?;
    let (project, name) = split_repo(&repo)?;
    Ok((config, project, name))
}

/// `repo_context` plus the worktree's checked-out branch.
fn board_context(
    app: &AppHandle,
    cwd: &str,
) -> Result<(AzureDevOpsConfig, String, String, String), String> {
    let (config, project, name) = repo_context(app, cwd)?;
    let root = expand_home(cwd);
    let branch =
        git_branch(&root).ok_or_else(|| "Could not resolve the worktree's branch".to_string())?;
    Ok((config, project, name, branch))
}

/// Pull request rows for a branch — `status` is an Azure searchCriteria
/// value (`active`, `all`, …). Rows arrive unsorted; callers pick by id.
fn pr_rows_for_branch(
    config: &AzureDevOpsConfig,
    project: &str,
    repo: &str,
    branch: &str,
    status: &str,
) -> Result<Vec<Value>, String> {
    let path = format!(
        "/{}/_apis/git/repositories/{}/pullrequests?searchCriteria.sourceRefName={}&searchCriteria.status={}&$top=10&api-version={}",
        encode_segment(project),
        encode_segment(repo),
        encode_segment(&ref_name(branch)),
        status,
        API_VERSION
    );
    let response = azure_get(config, &path)?;
    Ok(response
        .value
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// The branch's newest pull request — an active row wins, then highest id.
fn pick_pr_row(rows: &mut [Value]) -> Option<Value> {
    rows.sort_by_key(|row| {
        Reverse(
            row.get("pullRequestId")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        )
    });
    rows.iter()
        .find(|row| string_field(row, "status").as_deref() == Some("active"))
        .or_else(|| rows.first())
        .cloned()
}

pub(crate) fn pr_for_branch(
    config: &AzureDevOpsConfig,
    project: &str,
    repo: &str,
    branch: &str,
) -> Result<Option<Value>, String> {
    // Active first: an `all` query's `$top=10` could page past the open PR
    // on a branch with many closed ones — and the active row wins anyway.
    let mut rows = pr_rows_for_branch(config, project, repo, branch, "active")?;
    if let Some(row) = pick_pr_row(&mut rows) {
        return Ok(Some(row));
    }
    let mut rows = pr_rows_for_branch(config, project, repo, branch, "all")?;
    Ok(pick_pr_row(&mut rows))
}

/// `…/<project>/_git/<repo>/pullrequest/42` → 42 — trusted only when the
/// url's project AND repo segments name this lane's. PR ids are
/// project-scoped: a cross-project pin would otherwise fetch an unrelated
/// PR that happens to share the id.
fn pr_id_from_url(url: &str, project: &str, repo: &str) -> Option<i64> {
    let (head, tail) = url.rsplit_once("/pullrequest/")?;
    let id: i64 = tail
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    let (path, url_repo) = head.rsplit_once("/_git/")?;
    let url_project = path.rsplit('/').next()?;
    // Segments arrive percent-encoded (`My Repo` → `My%20Repo`).
    (percent_decode(url_repo).eq_ignore_ascii_case(repo)
        && percent_decode(url_project).eq_ignore_ascii_case(project))
    .then_some(id)
}

/// One PR by id — review lanes need it: their `pr/<N>` branch never
/// matches the PR's `sourceRefName`. Errors propagate — Azure PRs can't
/// be deleted, so a failed fetch is an outage/auth problem, not "no PR".
pub(crate) fn pr_row_by_id(
    config: &AzureDevOpsConfig,
    project: &str,
    repo: &str,
    id: i64,
) -> Result<Value, String> {
    let path = format!(
        "/{}/_apis/git/repositories/{}/pullrequests/{}?api-version={}",
        encode_segment(project),
        encode_segment(repo),
        id,
        API_VERSION
    );
    Ok(azure_get(config, &path)?.value)
}

/// Azure reviewer votes → the GitHub-shaped `reviewDecision` rollup:
/// any negative vote (-10 rejected, -5 waiting-for-author) means the
/// reviewer sent it back — the author has work to do; any ≥5
/// (approved/approved-with-suggestions) approves; anything else is still
/// waiting. None when the response carries no reviewers.
fn reviewers_decision(row: &Value) -> Option<String> {
    let votes: Vec<i64> = row
        .get("reviewers")?
        .as_array()?
        .iter()
        .filter_map(|reviewer| reviewer.get("vote").and_then(Value::as_i64))
        .collect();
    if votes.is_empty() {
        return None;
    }
    Some(
        if votes.iter().any(|vote| *vote < 0) {
            "CHANGES_REQUESTED"
        } else if votes.iter().any(|vote| *vote >= 5) {
            "APPROVED"
        } else {
            "REVIEW_REQUIRED"
        }
        .to_string(),
    )
}

pub(crate) fn pr_to_git_pr(
    row: &Value,
    project: &str,
    repo: &str,
    config: &AzureDevOpsConfig,
) -> Option<GitPr> {
    // parse_pr owns the three-tier URL fallback the inbox relies on.
    let item = parse_pr(row, &format!("{project}/{repo}"), &config.url)?;
    Some(GitPr {
        number: item.number,
        title: item.title,
        url: item.url,
        state: item.state,
        review_decision: reviewers_decision(row),
        unresolved_threads: None,
        draft: row.get("isDraft").and_then(Value::as_bool),
        updated_at: string_field(row, "closedDate").or_else(|| string_field(row, "creationDate")),
        merge_state: normalize_azure_merge_state(row),
    })
}

/// Azure `mergeStatus` (PullRequestAsyncStatus) → shared buckets. It only
/// reports merge conflicts — `succeeded` says nothing about policies or
/// builds, so "ready" still has to check votes + checks. `queued` is the
/// merge-eval in flight, `notSet` pre-eval.
fn normalize_azure_merge_state(row: &Value) -> Option<String> {
    Some(
        match string_field(row, "mergeStatus")?.as_str() {
            "succeeded" => "clean",
            "conflicts" => "conflicts",
            "rejectedByPolicy" => "blocked",
            "failure" => "unstable",
            _ => return None,
        }
        .to_string(),
    )
}

/// Active review threads on a PR — Azure's "unresolved comments" count.
/// Best-effort: a failed call just leaves the badge empty.
pub(crate) fn active_thread_count(
    config: &AzureDevOpsConfig,
    project: &str,
    repo: &str,
    pr: i64,
) -> Option<i64> {
    let path = format!(
        "/{}/_apis/git/repositories/{}/pullrequests/{}/threads?api-version={}",
        encode_segment(project),
        encode_segment(repo),
        pr,
        API_VERSION
    );
    let response = azure_get(config, &path).ok()?;
    let threads = response.value.get("value")?.as_array()?;
    Some(
        threads
            .iter()
            .filter(|thread| {
                thread.get("status").and_then(Value::as_str) == Some("active")
                    // System threads (status changes, votes) aren't comments.
                    && thread
                        .get("comments")
                        .and_then(Value::as_array)
                        .and_then(|comments| comments.first())
                        .and_then(|comment| comment.get("commentType"))
                        .and_then(Value::as_str)
                        != Some("system")
            })
            .count() as i64,
    )
}

fn bucket_for_build(status: &str, result: &str) -> &'static str {
    match result {
        "succeeded" => "pass",
        "failed" | "partiallySucceeded" => "fail",
        "canceled" => "cancel",
        // Completed with no recorded outcome isn't a pass.
        "none" => "skipping",
        _ => match status {
            "completed" => "skipping",
            _ => "pending",
        },
    }
}

/// Recent build rows on a ref — branch CI runs (`refs/heads/…`) or PR
/// validation runs (`refs/pull/{id}/merge`, reason `pullRequest`). Scoped to
/// the repository: the builds API is otherwise project-wide, and another
/// repo's same-named branch would leak in.
fn build_rows_for_ref(
    config: &AzureDevOpsConfig,
    project: &str,
    repo_id: &str,
    branch_ref: &str,
    pr_validation: bool,
) -> Result<Vec<Value>, String> {
    let reason = if pr_validation {
        "&reasonFilter=pullRequest"
    } else {
        ""
    };
    let path = format!(
        "/{}/_apis/build/builds?branchName={}&repositoryId={}&repositoryType=TfsGit{}&queryOrder=finishTimeDescending&$top=15&api-version={}",
        encode_segment(project),
        encode_segment(branch_ref),
        encode_segment(repo_id),
        reason,
        API_VERSION
    );
    let response = azure_get(config, &path)?;
    Ok(response
        .value
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// Builds in-flight have no `finishTime` — fall back so they still sort
/// ahead of older finished runs.
fn build_time(row: &Value) -> String {
    string_field(row, "finishTime")
        .or_else(|| string_field(row, "startTime"))
        .or_else(|| string_field(row, "queueTime"))
        .unwrap_or_default()
}

fn row_to_check(row: &Value) -> Option<GitPrCheck> {
    let name = row
        .get("definition")
        .and_then(|definition| string_field(definition, "name"))
        .or_else(|| string_field(row, "buildNumber"))?;
    let status = string_field(row, "status").unwrap_or_default();
    let result = string_field(row, "result").unwrap_or_default();
    let bucket = bucket_for_build(&status, &result).to_string();
    Some(GitPrCheck {
        name,
        state: if result.is_empty() { status } else { result },
        bucket,
        url: row
            .get("_links")
            .and_then(|links| links.get("web"))
            .and_then(|web| string_field(web, "href"))
            .unwrap_or_default(),
    })
}

/// CI for one repo lane: the latest build per pipeline definition across
/// branch runs and the PR's validation runs (`pr` is the pull request id —
/// the lane probe resolves it, standalone cards pass the item's number).
/// Build failures degrade to no checks rather than failing the probe.
fn checks_for_branch(
    config: &AzureDevOpsConfig,
    project: &str,
    repo: &str,
    branch: &str,
    pr: Option<i64>,
) -> Vec<GitPrCheck> {
    let Ok(repo_id) = repository_id(config, project, repo) else {
        return vec![];
    };
    let mut rows =
        build_rows_for_ref(config, project, &repo_id, &ref_name(branch), false).unwrap_or_default();
    if let Some(id) = pr {
        rows.extend(
            build_rows_for_ref(
                config,
                project,
                &repo_id,
                &format!("refs/pull/{id}/merge"),
                true,
            )
            .unwrap_or_default(),
        );
    }
    // Both queries are individually finish-sorted; merge them so a newer
    // validation run isn't shadowed by an older branch run (or vice versa).
    rows.sort_by_key(|row| Reverse(build_time(row)));
    let mut seen = HashSet::new();
    rows.iter()
        .filter_map(row_to_check)
        .filter(|check| seen.insert(check.name.clone()))
        .collect()
}

/// The branch's pull request plus its pipeline status — one call so a lane
/// probe costs a single round trip instead of two.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPrProbe {
    pr: Option<GitPr>,
    checks: Vec<GitPrCheck>,
}

/// Pull request and pipeline status for the worktree's checked-out branch.
/// `pr_url` pins the lookup to that exact PR (review lanes); `branch`
/// overrides the checkout's branch — a lane probed via the project root
/// after its worktree was cleaned up must not inherit main's builds.
#[tauri::command]
pub async fn azure_devops_pr_probe(
    app: AppHandle,
    cwd: String,
    pr_url: Option<String>,
    branch: Option<String>,
) -> Result<GitPrProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (config, project, repo, checkout_branch) = board_context(&app, &cwd)?;
        let branch = branch
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or(checkout_branch);
        let row = match pr_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            // A pin means pin — a malformed or cross-repo url yields no PR,
            // never a branch query that could return the wrong repo's PR.
            Some(url) => pr_id_from_url(url, &project, &repo)
                .map(|id| pr_row_by_id(&config, &project, &repo, id))
                .transpose()?,
            None => pr_for_branch(&config, &project, &repo, &branch)?,
        };
        let pr_id = row
            .as_ref()
            .and_then(|row| row.get("pullRequestId"))
            .and_then(Value::as_i64);
        let mut pr = row.and_then(|row| pr_to_git_pr(&row, &project, &repo, &config));
        if let (Some(pr), Some(id)) = (&mut pr, pr_id) {
            if pr.state == "open" {
                pr.unresolved_threads = active_thread_count(&config, &project, &repo, id);
            }
        }
        Ok(GitPrProbe {
            pr,
            checks: checks_for_branch(&config, &project, &repo, &branch, pr_id),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Pipeline status for an inbox PR's branch — same query as the lane probe
/// but keyed by the item's `project/repo` + `sourceRefName` + number, so
/// standalone Azure PR cards carry CI badges without a local worktree.
#[tauri::command]
pub async fn azure_devops_branch_checks(
    app: AppHandle,
    repo: String,
    branch: String,
    pr: Option<i64>,
) -> Result<Vec<GitPrCheck>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let (project, name) = split_repo(&repo)?;
        Ok(checks_for_branch(
            &config,
            &project,
            &name,
            &short_ref(&branch),
            pr,
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn ref_name(branch: &str) -> String {
    if branch.starts_with("refs/") {
        branch.to_string()
    } else {
        format!("refs/heads/{branch}")
    }
}

/// Create an Azure DevOps pull request and return its web URL.
#[tauri::command]
pub async fn azure_devops_pr_create(
    app: AppHandle,
    cwd: String,
    title: String,
    body: String,
    base: String,
    head: String,
    draft: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if title.trim().is_empty() {
            return Err("Pull request title cannot be empty".into());
        }
        let (config, project, repo) = repo_context(&app, &cwd)?;
        let path = format!(
            "/{}/_apis/git/repositories/{}/pullrequests?api-version={}",
            encode_segment(&project),
            encode_segment(&repo),
            API_VERSION
        );
        let response = azure_request_json(
            &config,
            "POST",
            &path,
            json!({
                "sourceRefName": ref_name(&head),
                "targetRefName": ref_name(&base),
                "title": title.trim(),
                "description": body,
                "isDraft": draft,
            }),
        )?;
        let number = response
            .value
            .get("pullRequestId")
            .and_then(Value::as_i64)
            .ok_or_else(|| "Azure DevOps did not return the pull request".to_string())?;
        Ok(pr_web_url(&config, &project, &repo, number))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Replace a pull request's description. `pr_id` targets the exact PR — a
/// branch switched between create and patch would otherwise re-resolve to a
/// different PR. Without it, the branch's newest active PR is updated.
#[tauri::command]
pub async fn azure_devops_pr_update_body(
    app: AppHandle,
    cwd: String,
    body: String,
    pr_id: Option<i64>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (config, project, repo) = repo_context(&app, &cwd)?;
        let id = match pr_id {
            Some(id) => id,
            None => {
                let branch = git_branch(&expand_home(&cwd))
                    .ok_or_else(|| "Could not resolve the worktree's branch".to_string())?;
                let mut rows = pr_rows_for_branch(&config, &project, &repo, &branch, "active")?;
                pick_pr_row(&mut rows)
                    .and_then(|row| row.get("pullRequestId").and_then(Value::as_i64))
                    .ok_or_else(|| "No active pull request for the branch".to_string())?
            }
        };
        let path = format!(
            "/{}/_apis/git/repositories/{}/pullrequests/{}?api-version={}",
            encode_segment(&project),
            encode_segment(&repo),
            id,
            API_VERSION
        );
        azure_request_json(&config, "PATCH", &path, json!({ "description": body }))?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Provider routing for the board: true when the worktree's remote resolves
/// to the configured Azure org. An Azure-shaped remote that *doesn't* match
/// errors instead of returning false, so the caller surfaces "connect Azure"
/// rather than falling back to `gh` and failing cryptically.
#[tauri::command]
pub async fn azure_devops_repo_match(app: AppHandle, cwd: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let remotes = remote_urls(&expand_home(&cwd))?;
        if !remotes
            .iter()
            .any(|(_, url)| parse_azure_remote(url).is_some())
        {
            return Ok(false);
        }
        let Some(config) = read_config(&app)? else {
            return Err("This worktree is on Azure DevOps — connect it in Settings".into());
        };
        match match_remote(&remotes, &config.url) {
            Some(_) => Ok(true),
            None => Err("Azure DevOps remote doesn't match the configured organization".into()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> AzureDevOpsConfig {
        AzureDevOpsConfig {
            url: "https://dev.azure.com/acme".into(),
            token: "pat".into(),
        }
    }

    #[test]
    fn buckets_build_outcomes() {
        assert_eq!(bucket_for_build("completed", "succeeded"), "pass");
        assert_eq!(bucket_for_build("completed", "failed"), "fail");
        assert_eq!(bucket_for_build("completed", "partiallySucceeded"), "fail");
        assert_eq!(bucket_for_build("completed", "canceled"), "cancel");
        // Completed with no recorded result isn't a pass.
        assert_eq!(bucket_for_build("completed", "none"), "skipping");
        assert_eq!(bucket_for_build("completed", ""), "skipping");
        assert_eq!(bucket_for_build("inProgress", ""), "pending");
        assert_eq!(bucket_for_build("notStarted", ""), "pending");
    }

    #[test]
    fn qualifies_branch_refs() {
        assert_eq!(ref_name("main"), "refs/heads/main");
        assert_eq!(ref_name("release/1.2"), "refs/heads/release/1.2");
        assert_eq!(ref_name("refs/heads/main"), "refs/heads/main");
    }

    #[test]
    fn converts_pr_rows_to_git_pr() {
        let row = json!({
            "pullRequestId": 42,
            "title": "Add feature",
            "status": "active",
            "_links": { "web": { "href": "https://dev.azure.com/acme/p/_git/r/pullrequest/42" } },
        });
        let pr = pr_to_git_pr(&row, "p", "r", &config()).unwrap();
        assert_eq!(pr.number, 42);
        assert_eq!(pr.state, "open");
        assert_eq!(pr.url, "https://dev.azure.com/acme/p/_git/r/pullrequest/42");

        // Completed PRs normalize to merged; missing _links falls back to a
        // constructed URL.
        let row = json!({ "pullRequestId": 7, "title": "x", "status": "completed" });
        let pr = pr_to_git_pr(&row, "p", "r", &config()).unwrap();
        assert_eq!(pr.state, "merged");
        assert!(pr.url.ends_with("/_git/r/pullrequest/7"));

        // Rows without an id can't be represented.
        assert!(pr_to_git_pr(&json!({"title": "x"}), "p", "r", &config()).is_none());
    }

    #[test]
    fn azure_merge_state_normalizes_to_shared_buckets() {
        // `mergeStatus` only covers merge conflicts — `succeeded` means
        // "merges cleanly", not "policies pass".
        let cases = [
            ("succeeded", Some("clean")),
            ("conflicts", Some("conflicts")),
            ("rejectedByPolicy", Some("blocked")),
            ("failure", Some("unstable")),
            ("queued", None),
            ("notSet", None),
        ];
        for (status, expected) in cases {
            let row = json!({
                "pullRequestId": 1,
                "title": "x",
                "status": "active",
                "mergeStatus": status,
            });
            assert_eq!(
                pr_to_git_pr(&row, "p", "r", &config())
                    .unwrap()
                    .merge_state
                    .as_deref(),
                expected,
                "{status}"
            );
        }
        // No mergeStatus at all → None, not a guess.
        let row = json!({ "pullRequestId": 1, "title": "x", "status": "active" });
        assert_eq!(
            pr_to_git_pr(&row, "p", "r", &config()).unwrap().merge_state,
            None
        );
    }

    #[test]
    fn pr_rows_carry_review_signals() {
        // Reviewer votes roll up to a decision: rejection wins, else an
        // approval, else assigned-but-unvoted reviewers mean required.
        let rejected = json!({
            "pullRequestId": 1, "title": "x", "status": "active",
            "_links": { "web": { "href": "https://u/1" } },
            "reviewers": [{ "vote": 10 }, { "vote": -10 }],
        });
        assert_eq!(
            pr_to_git_pr(&rejected, "p", "r", &config())
                .unwrap()
                .review_decision
                .as_deref(),
            Some("CHANGES_REQUESTED")
        );
        let approved = json!({
            "pullRequestId": 1, "title": "x", "status": "active",
            "_links": { "web": { "href": "https://u/1" } },
            "reviewers": [{ "vote": 0 }, { "vote": 5 }],
        });
        assert_eq!(
            pr_to_git_pr(&approved, "p", "r", &config())
                .unwrap()
                .review_decision
                .as_deref(),
            Some("APPROVED")
        );
        // -5 (waiting for author) is a send-back too — author action
        // needed, same attention signal as a rejection.
        let sent_back = json!({
            "pullRequestId": 1, "title": "x", "status": "active",
            "_links": { "web": { "href": "https://u/1" } },
            "reviewers": [{ "vote": 5 }, { "vote": -5 }],
        });
        assert_eq!(
            pr_to_git_pr(&sent_back, "p", "r", &config())
                .unwrap()
                .review_decision
                .as_deref(),
            Some("CHANGES_REQUESTED")
        );
        let waiting = json!({
            "pullRequestId": 1, "title": "x", "status": "active",
            "_links": { "web": { "href": "https://u/1" } },
            "reviewers": [{ "vote": 0 }],
            "isDraft": true,
            "closedDate": "2025-01-02T00:00:00Z",
        });
        let pr = pr_to_git_pr(&waiting, "p", "r", &config()).unwrap();
        assert_eq!(pr.review_decision.as_deref(), Some("REVIEW_REQUIRED"));
        assert_eq!(pr.draft, Some(true));
        assert_eq!(pr.updated_at.as_deref(), Some("2025-01-02T00:00:00Z"));
        // No reviewers → no decision (distinguishes "unreviewed" from
        // "required" — the badge stays quiet instead of lying).
        let bare = json!({
            "pullRequestId": 1, "title": "x", "status": "active",
            "_links": { "web": { "href": "https://u/1" } },
        });
        assert_eq!(
            pr_to_git_pr(&bare, "p", "r", &config())
                .unwrap()
                .review_decision,
            None
        );
    }

    #[test]
    fn picks_newest_active_pr() {
        // An active row wins over a newer closed one; with none active the
        // highest id (most recent) wins.
        let mut rows = vec![
            json!({"pullRequestId": 5, "status": "completed"}),
            json!({"pullRequestId": 3, "status": "active"}),
        ];
        assert_eq!(
            pick_pr_row(&mut rows)
                .unwrap()
                .get("pullRequestId")
                .and_then(Value::as_i64),
            Some(3)
        );
        let mut rows = vec![
            json!({"pullRequestId": 5, "status": "completed"}),
            json!({"pullRequestId": 9, "status": "abandoned"}),
        ];
        assert_eq!(
            pick_pr_row(&mut rows)
                .unwrap()
                .get("pullRequestId")
                .and_then(Value::as_i64),
            Some(9)
        );
        assert!(pick_pr_row(&mut []).is_none());
    }

    #[test]
    fn pr_id_parses_from_web_urls() {
        assert_eq!(
            pr_id_from_url(
                "https://dev.azure.com/acme/p/_git/r/pullrequest/42",
                "p",
                "r"
            ),
            Some(42)
        );
        assert_eq!(
            pr_id_from_url(
                "https://dev.azure.com/acme/p/_git/r/pullrequest/7?a=1",
                "p",
                "r"
            ),
            Some(7)
        );
        // Segments in urls are percent-encoded; matching is
        // case-insensitive.
        assert_eq!(
            pr_id_from_url(
                "https://dev.azure.com/acme/p/_git/My%20Repo/pullrequest/3",
                "p",
                "my repo"
            ),
            Some(3)
        );
        // Ids are project-scoped — a url naming another repo OR project
        // isn't trusted.
        assert_eq!(
            pr_id_from_url(
                "https://dev.azure.com/acme/p/_git/other/pullrequest/42",
                "p",
                "r"
            ),
            None
        );
        assert_eq!(
            pr_id_from_url(
                "https://dev.azure.com/acme/other-project/_git/r/pullrequest/42",
                "p",
                "r"
            ),
            None
        );
        assert_eq!(
            pr_id_from_url(
                "https://dev.azure.com/acme/p/_git/r/pullrequest/x",
                "p",
                "r"
            ),
            None
        );
        assert_eq!(
            pr_id_from_url("https://github.com/a/b/pull/3", "p", "b"),
            None
        );
    }
}
