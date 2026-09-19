//! Read-only Azure Pipelines evidence, independent of ticket and PR hosting.
use crate::azure::{component, request, request_bytes, require_config, AzureConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

const API: &[(&str, &str)] = &[("api-version", "7.1")];
const PAGE: usize = 50;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiTarget {
    site: String,
    account_id: String,
    project: String,
    definition: u32,
    #[serde(default)]
    repository_id: String,
    #[serde(default)]
    repository_type: String,
    #[serde(default)]
    repository_url: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct CiHead {
    cwd: String,
    branch: String,
    commit: String,
    remote: String,
}

#[derive(Deserialize)]
pub struct CiLookup {
    target: CiTarget,
    head: CiHead,
    continuation: Option<String>,
    #[serde(default, rename = "runId")]
    run_id: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiRead {
    target: CiTarget,
    head: Option<CiHead>,
    run_id: u32,
    revision: String,
    section: String,
    record_id: Option<String>,
    attempt: Option<u32>,
    log_id: Option<u32>,
    start_line: Option<u32>,
    #[serde(default)]
    skip: usize,
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Azure Pipelines did not return {key}. Refresh or open in Azure."))
}

fn path(project: &str) -> Result<String, String> {
    if project.is_empty()
        || project.len() > 256
        || project.chars().any(char::is_control)
        || matches!(project, "." | "..")
    {
        return Err("Choose an Azure project".into());
    }
    Ok(format!("{}/_apis/build", component(project)))
}

fn connection(app: &AppHandle, target: &CiTarget) -> Result<AzureConfig, String> {
    let config = require_config(app, &target.site)?;
    if target.account_id.is_empty() || target.account_id != config.account_id {
        return Err(
            "Azure account changed. Reconnect the mapped account or choose another pipeline."
                .into(),
        );
    }
    if target.definition == 0 {
        return Err("Choose a pipeline definition".into());
    }
    Ok(config)
}

fn get(config: &AzureConfig, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let mut query = query.to_vec();
    query.extend(API.iter().map(|(key, value)| (*key, value.to_string())));
    request(config, path, &query, None).map_err(ci_error)
}
fn ci_error(error: String) -> String {
    if error.contains("denied access") {
        "Azure denied the pipeline read. Check Build (Read) and pipeline/log permissions; other sources remain available.".into()
    } else {
        error
    }
}

/// Canonical public repository identity. Never expose embedded Git credentials.
fn repository_url(raw: &str) -> Option<String> {
    if raw.len() > 2048 || raw.chars().any(char::is_control) {
        return None;
    }
    let raw = if let Some(path) = raw.strip_prefix("git@github.com:") {
        format!("https://github.com/{path}")
    } else if let Some(path) = raw.strip_prefix("git@ssh.dev.azure.com:v3/") {
        format!("ssh://git@ssh.dev.azure.com/v3/{path}")
    } else {
        raw.into()
    };
    let url = tauri::Url::parse(&raw).ok()?;
    if url.port().is_some() {
        return None;
    }
    let host = url.host_str()?;
    let mut parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if host == "github.com" && matches!(url.scheme(), "https" | "ssh") && parts.len() == 2 {
        return Some(
            format!(
                "https://github.com/{}/{}",
                parts[0],
                parts[1].trim_end_matches(".git")
            )
            .to_lowercase(),
        );
    }
    if host == "ssh.dev.azure.com" && url.scheme() == "ssh" && parts.len() == 4 && parts[0] == "v3"
    {
        return Some(
            format!(
                "https://dev.azure.com/{}/{}/_git/{}",
                parts[1], parts[2], parts[3]
            )
            .to_lowercase(),
        );
    }
    if url.scheme() != "https" {
        return None;
    }
    if let Some(org) = host.strip_suffix(".visualstudio.com") {
        if parts.first() == Some(&"DefaultCollection") {
            parts.remove(0);
        }
        parts.insert(0, org);
    } else if host != "dev.azure.com" {
        return None;
    }
    if parts.len() != 4 || parts[2] != "_git" || parts.iter().any(|s| s.is_empty()) {
        return None;
    }
    Some(
        format!(
            "https://dev.azure.com/{}/{}/_git/{}",
            parts[0], parts[1], parts[3]
        )
        .to_lowercase(),
    )
}

// PR routing also supports the hosts understood by gh. CI evidence keeps its
// stricter provider mapping; this identity alone never authorizes a request.
fn pr_repository_url(raw: &str) -> Option<String> {
    if let Some(url) = repository_url(raw) {
        return Some(url);
    }
    if raw.len() > 2048 || raw.chars().any(char::is_control) {
        return None;
    }
    let raw = if !raw.contains("://") {
        let (host, path) = raw.split_once(':')?;
        format!("ssh://{host}/{path}")
    } else {
        raw.to_string()
    };
    let url = tauri::Url::parse(&raw).ok()?;
    let host = url.host_str()?;
    if host == "dev.azure.com" || host == "ssh.dev.azure.com" || host.ends_with(".visualstudio.com")
    {
        return None;
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if !matches!(url.scheme(), "https" | "http" | "ssh")
        || parts.len() != 2
        || parts.iter().any(|part| part.is_empty())
    {
        return None;
    }
    let scheme = if url.scheme() == "http" {
        "http"
    } else {
        "https"
    };
    let port = if url.scheme() == "ssh" {
        String::new()
    } else {
        url.port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    };
    Some(
        format!(
            "{scheme}://{host}{port}/{}/{}",
            parts[0],
            parts[1].trim_end_matches(".git")
        )
        .to_lowercase(),
    )
}

fn checkout(cwd: &str, for_pr: bool) -> Result<Value, String> {
    let root = crate::fs::expand_home(cwd);
    let read = |args: &[&str]| -> Result<String, String> {
        let output = crate::fs::git_command_output(&root, args)?;
        if !output.status.success() || output.stdout.len() > 64 * 1024 {
            return Err("Cannot read this checkout's branch, revision or remotes.".into());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let commit = read(&["rev-parse", "--verify", "HEAD"])?;
    let branch = read(&["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let config =
        crate::fs::git_command_output(&root, &["config", "--get-regexp", r"^remote\..*\.url$"])?;
    if (!config.status.success() && config.status.code() != Some(1))
        || config.stdout.len() > 64 * 1024
    {
        return Err("Cannot read this checkout's Git remotes.".into());
    }
    let remotes: Vec<_> = String::from_utf8_lossy(&config.stdout).lines().filter_map(|line| {
        let (key, raw) = line.split_once(char::is_whitespace)?;
        Some(json!({"name":key.strip_prefix("remote.")?.strip_suffix(".url")?,"url":if for_pr { pr_repository_url(raw.trim())? } else { repository_url(raw.trim())? }}))
    }).take(20).collect();
    Ok(json!({"cwd":cwd,"branch":branch,"commit":commit,"remotes":remotes}))
}

fn check_head(head: &CiHead) -> Result<(), String> {
    let current = checkout(&head.cwd, false)?;
    if current["branch"] != head.branch
        || current["commit"] != head.commit
        || !current["remotes"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row["url"] == head.remote))
    {
        return Err(
            "Checkout revision, branch or remote changed. Refresh CI evidence before continuing."
                .into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn azure_ci_context(cwd: String, for_pr: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || checkout(&cwd, for_pr.unwrap_or(false)))
        .await
        .map_err(|_| "CI checkout lookup failed")?
}

fn verify_run(run: &Value, target: &CiTarget) -> Result<(), String> {
    if run["id"]
        .as_u64()
        .filter(|value| *value > 0 && *value <= i32::MAX as u64)
        .is_none()
    {
        return Err("Azure returned an invalid build ID".into());
    }
    if run["project"]["id"] != target.project
        || run["definition"]["id"] != target.definition
        || run["repository"]["id"] != target.repository_id
        || run["repository"]["type"] != target.repository_type
    {
        return Err("Pipeline or repository mapping changed. Choose the pipeline again.".into());
    }
    Ok(())
}

pub(crate) fn revision(run: &Value) -> String {
    json!([
        run["id"],
        run["definition"]["id"],
        run["definition"]["revision"],
        run["repository"]["id"],
        run["sourceBranch"],
        run["sourceVersion"],
        run["status"],
        run["result"],
        run["lastChangedDate"],
        run["finishTime"],
        run["startTime"],
        run["triggerInfo"]["pr.sourceSha"],
        run["triggerInfo"]["pr.sourceBranch"]
    ])
    .to_string()
}

fn match_kind(run: &Value, head: &CiHead) -> &'static str {
    if run["sourceVersion"]
        .as_str()
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return "unverified";
    }
    let branch = format!("refs/heads/{}", head.branch);
    if run["sourceVersion"] == head.commit && run["sourceBranch"] == branch {
        return "exact";
    }
    if run["sourceBranch"]
        .as_str()
        .is_some_and(|s| s.starts_with("refs/pull/"))
    {
        // Only explicit source-head metadata proves a merge build belongs to this checkout.
        if run["reason"] == "pullRequest"
            && run["triggerInfo"]["pr.sourceSha"] == head.commit
            && (run["triggerInfo"]["pr.sourceBranch"] == branch
                || run["triggerInfo"]["pr.sourceBranch"] == head.branch)
        {
            return "pr-source";
        }
        return "unverified-merge";
    }
    if run["sourceBranch"] == branch {
        "old-commit"
    } else {
        "other-branch"
    }
}
fn summary(run: &Value, head: &CiHead) -> Value {
    json!({"id":run["id"],"number":run["buildNumber"],"status":run["status"],"result":run["result"],"branch":run["sourceBranch"],"commit":run["sourceVersion"],"queuedAt":run["queueTime"],"revision":revision(run),"match":match_kind(run,head)})
}

#[tauri::command]
pub async fn azure_ci_lookup(app: AppHandle, input: CiLookup) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_head(&input.head)?;
        let config = connection(&app, &input.target)?;
        let definition = get(&config, &format!("{}/definitions/{}", path(&input.target.project)?, input.target.definition), &[])?;
        if definition["id"] != input.target.definition { return Err("Azure returned a different pipeline".into()); }
        let project = field(&definition["project"], "id")?;
        let repo = &definition["repository"];
        let repo_type = field(repo, "type")?;
        if !matches!(repo_type, "TfsGit" | "GitHub") { return Err("This pipeline repository type cannot be verified here. Open it in Azure.".into()); }
        let repo_url = repository_url(field(repo,"url")?).ok_or("Pipeline repository URL cannot be verified. Open it in Azure.")?;
        if repo_url != input.head.remote { return Err("Pipeline repository differs from the selected checkout remote. Choose its exact repository/pipeline mapping.".into()); }
        let target = CiTarget { site:config.site.clone(), account_id:config.account_id.clone(), project:project.into(), definition:input.target.definition, repository_id:field(repo,"id")?.into(), repository_type:repo_type.into(), repository_url:repo_url };
        let mut query = vec![("api-version", "7.1".into()),("definitions",target.definition.to_string()),("repositoryId",target.repository_id.clone()),("repositoryType",target.repository_type.clone()),("queryOrder","queueTimeDescending".into()),("$top",PAGE.to_string())];
        if let Some(token) = input.continuation { if token.len()>2048 || token.chars().any(char::is_control) { return Err("Invalid run page".into()); } query.push(("continuationToken",token)); }
        let (raw, continuation) = request_bytes(&config,&format!("{}/builds",path(project)?),&query,None,"application/json",2*1024*1024).map_err(ci_error)?;
        let response: Value = serde_json::from_slice(&raw).map_err(|_| "Azure returned an invalid run list")?;
        let mut items = Vec::new();
        for run in response["value"].as_array().ok_or("Azure returned an invalid run list")?.iter().take(PAGE) { verify_run(run,&target)?; items.push(summary(run,&input.head)); }
        if let Some(id) = input.run_id {
            if id == 0 || id > i32::MAX as u32 { return Err("Invalid selected run ID".into()); }
            if !items.iter().any(|run| run["id"] == id) {
                let run = get(&config, &format!("{}/builds/{id}", path(project)?), &[])?;
                verify_run(&run, &target)?;
                if run["id"] != id { return Err("Azure returned a different run".into()); }
                items.insert(0, summary(&run, &input.head));
            }
        }
        connection(&app,&target)?; check_head(&input.head)?;
        Ok(json!({"target":target,"definitionName":definition["name"],"projectName":definition["project"]["name"],"items":items,"continuation":continuation,"checkedAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()}))
    }).await.map_err(|_| "Pipeline lookup failed")?
}

pub(crate) fn sanitize_log(raw: &str) -> String {
    let mut clean = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' || (next == '\u{1b}' && chars.next() == Some('\\')) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if !c.is_control() || c == '\n' || c == '\t' {
            clean.push(c);
        }
    }
    let mut private_key = false;
    clean
        .lines()
        .take(500)
        .map(|line| {
            let lower = line.to_lowercase();
            if lower.contains("-----begin") && lower.contains("private key") {
                private_key = true;
            }
            if private_key {
                if lower.contains("-----end") && lower.contains("private key") {
                    private_key = false;
                }
                return "[redacted private key]".to_string();
            }
            let normalized = lower.replace(['-', '_', ' '], "");
            if [
                "token",
                "password",
                "authorization",
                "secret",
                "privatekey",
                "connectionstring",
                "apikey",
                "accountkey",
                "sig=",
                "ghp",
                "githubpat",
                "eyj",
                "akia",
                "azdo",
            ]
            .iter()
            .any(|word| normalized.contains(word))
                || (line.contains("://") && line.contains('@'))
            {
                "[redacted sensitive line]".to_string()
            } else {
                line.chars().take(2000).collect()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(32_000)
        .collect()
}

#[tauri::command]
pub async fn azure_ci_read(app: AppHandle, input: CiRead) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(head) = &input.head { check_head(head)?; }
        let config = connection(&app,&input.target)?;
        if input.run_id==0 || input.skip>10_000 { return Err("Choose a valid run/page".into()); }
        let run_path = format!("{}/builds/{}",path(&input.target.project)?,input.run_id);
        let run = get(&config,&run_path,&[])?;
        verify_run(&run,&input.target)?;
        if run["id"] != input.run_id || revision(&run) != input.revision { return Err("Run changed or was retried. Refresh CI evidence before continuing.".into()); }
        let result = if input.section == "summary" { summary(&run,input.head.as_ref().ok_or("Select a checkout to compare this run")?) } else {
            let timeline = get(&config,&format!("{run_path}/timeline"),&[])?;
            let records = timeline["records"].as_array().ok_or("Timeline is unavailable. Retry or open in Azure.")?;
            if input.section == "jobs" {
                let items: Vec<_> = records.iter().skip(input.skip).take(PAGE).map(|row| json!({"id":row["id"],"name":row["name"],"type":row["type"],"parentId":row["parentId"],"parentName":records.iter().find(|parent|parent["id"]==row["parentId"]).map(|parent|parent["name"].clone()),"attempt":row["attempt"],"state":row["state"],"result":row["result"],"logId":row["log"]["id"],"previousAttempts":row["previousAttempts"].as_array().map(|v|v.iter().take(20).cloned().collect::<Vec<_>>())})).collect();
                json!({"items":items,"nextSkip":if records.len()>input.skip+PAGE {Some(input.skip+PAGE)} else {None},"timelineId":timeline["id"]})
            } else if input.section == "log" {
                let record = records.iter().find(|row| row["id"].as_str()==input.record_id.as_deref()).ok_or("Selected job is no longer in this run")?;
                let attempt = input.attempt.filter(|v|*v>0).ok_or("Choose a job attempt")?;
                let log_id = input.log_id.filter(|v|*v>0).ok_or("Choose a job log")?;
                if record["attempt"] != attempt || record["log"]["id"] != log_id { return Err("Job attempt or log changed. Refresh jobs before loading this log.".into()); }
                let logs = get(&config,&format!("{run_path}/logs"),&[])?;
                let log = logs["value"].as_array().and_then(|rows|rows.iter().find(|log|log["id"]==log_id)).ok_or("Log is unavailable for this run")?;
                let count = log["lineCount"].as_u64().ok_or("Log line count is unavailable")?.min(u32::MAX as u64) as u32;
                let start = input.start_line.unwrap_or(count.saturating_sub(500));
                if start>count { return Err("Log page changed. Reload the log.".into()); }
                let end = start.saturating_add(499).min(count.saturating_sub(1));
                let (raw,_) = request_bytes(&config,&format!("{run_path}/logs/{log_id}"),&[("api-version","7.1".into()),("startLine",start.to_string()),("endLine",end.to_string())],None,"text/plain",200_000).map_err(ci_error)?;
                let raw = String::from_utf8(raw).map_err(|_| "Log is not readable text. Open it in Azure.")?;
                let fresh = get(&config,&format!("{run_path}/timeline"),&[])?;
                let unchanged = fresh["records"].as_array().is_some_and(|rows|rows.iter().any(|row|row["id"]==record["id"] && row["attempt"]==attempt && row["log"]["id"]==log_id));
                if !unchanged { return Err("Job was retried while reading its log. Refresh jobs.".into()); }
                json!({"text":sanitize_log(&raw),"startLine":start,"endLine":end,"lineCount":count,"attempt":attempt,"logId":log_id,"recordId":record["id"],"bounded":true})
            } else { return Err("Unknown pipeline detail section".into()); }
        };
        let after = get(&config,&run_path,&[])?;
        verify_run(&after,&input.target)?;
        if revision(&after)!=input.revision { return Err("Run changed while reading. Refresh CI evidence.".into()); }
        connection(&app,&input.target)?; if let Some(head) = &input.head { check_head(head)?; }
        Ok(result)
    }).await.map_err(|_| "Pipeline detail read failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkout_identity_rejects_head_and_remote_changes() {
        let root = std::env::temp_dir().join(format!(
            "monocode-ci-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-b", "feature"]);
        git(&[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "Initial",
        ]);
        git(&[
            "remote",
            "add",
            "origin",
            "https://user:password@github.com/team/repo.git",
        ]);
        let snapshot = checkout(root.to_str().unwrap(), false).unwrap();
        assert!(!snapshot.to_string().contains("password"));
        let head = CiHead {
            cwd: root.to_string_lossy().into(),
            branch: "feature".into(),
            commit: snapshot["commit"].as_str().unwrap().into(),
            remote: "https://github.com/team/repo".into(),
        };
        assert!(check_head(&head).is_ok());
        git(&[
            "remote",
            "set-url",
            "origin",
            "https://github.com/other/repo.git",
        ]);
        assert!(check_head(&head).is_err());
        git(&[
            "remote",
            "set-url",
            "origin",
            "https://github.com/team/repo.git",
        ]);
        git(&[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "Next",
        ]);
        assert!(check_head(&head).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn requires_commit_evidence_and_keeps_merge_unknown_without_source_metadata() {
        let head = CiHead {
            cwd: "/repo".into(),
            branch: "feature".into(),
            commit: "head".into(),
            remote: "https://github.com/team/repo".into(),
        };
        assert_eq!(
            match_kind(
                &json!({"sourceVersion":"old","sourceBranch":"refs/heads/feature","result":"succeeded"}),
                &head
            ),
            "old-commit"
        );
        assert_eq!(
            match_kind(
                &json!({"sourceVersion":"head","sourceBranch":"refs/heads/feature"}),
                &head
            ),
            "exact"
        );
        let mut merge = json!({"reason":"pullRequest","sourceVersion":"merge","sourceBranch":"refs/pull/2/merge"});
        assert_eq!(match_kind(&merge, &head), "unverified-merge");
        merge["triggerInfo"] =
            json!({"pr.sourceSha":"head","pr.sourceBranch":"refs/heads/feature"});
        assert_eq!(match_kind(&merge, &head), "pr-source");
        assert_ne!(revision(&merge), revision(&json!({"id":2})));
    }
    #[test]
    fn pr_hosts_do_not_expand_ci_mapping_or_expose_remote_credentials() {
        for remote in [
            "https://user:secret@github.example.com/Team/Repo.git?token=secret",
            "git@github.example.com:Team/Repo.git",
            "ssh://git@github.example.com/Team/Repo.git",
        ] {
            assert_eq!(
                pr_repository_url(remote).as_deref(),
                Some("https://github.example.com/team/repo")
            );
            assert!(repository_url(remote).is_none());
        }
        assert_eq!(
            pr_repository_url("http://github.example.com:8080/team/repo").as_deref(),
            Some("http://github.example.com:8080/team/repo")
        );
        assert!(pr_repository_url("https://dev.azure.com/invalid/repo").is_none());
        assert!(pr_repository_url("https://org.visualstudio.com/invalid/repo").is_none());
        assert!(pr_repository_url("file:///team/repo").is_none());
        assert!(pr_repository_url("https://github.example.com/team/repo\n").is_none());
    }

    #[test]
    fn canonicalizes_remotes_and_bounds_sanitized_evidence() {
        assert_eq!(
            repository_url("git@github.com:Team/Repo.git"),
            Some("https://github.com/team/repo".into())
        );
        assert_eq!(
            repository_url(
                "https://user:password@dev.azure.com/team/project/_git/repo?secret=value"
            ),
            Some("https://dev.azure.com/team/project/_git/repo".into())
        );
        assert_eq!(
            repository_url("git@ssh.dev.azure.com:v3/team/project/repo"),
            Some("https://dev.azure.com/team/project/_git/repo".into())
        );
        assert!(repository_url("https://github.com.evil.test/team/repo").is_none());
        assert_ne!(
            repository_url("https://dev.azure.com/team/project/_git/repo.git"),
            repository_url("https://dev.azure.com/team/project/_git/repo")
        );
        let text = sanitize_log(
            "\u{1b}[31mFailure\u{1b}[0m\nTOKEN=abc\nhttps://user:pass@host/path\nexpected 1, got 2",
        );
        assert_eq!(
            text,
            "Failure\n[redacted sensitive line]\n[redacted sensitive line]\nexpected 1, got 2"
        );
        assert!(sanitize_log(&"x".repeat(100_000)).len() <= 32_000);
        for line in [
            "X-Api-Key: abc123",
            "API_KEY=credential",
            "private_key=credential",
            "Connection-String=credential",
        ] {
            assert_eq!(sanitize_log(line), "[redacted sensitive line]");
        }
    }
}
