//! Bounded, read-only delivery summaries for the existing Azure Inbox source.
use crate::azure::{component, request, require_config};
use serde_json::{json, Value};
use tauri::AppHandle;

fn text(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(1000)
        .collect()
}
fn id(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|id| *id > 0 && *id <= i32::MAX as u64)
}
fn pr_item(value: &Value, site: &str, account: &str) -> Option<Value> {
    let number = id(&value["pullRequestId"])?;
    let repo = &value["repository"];
    let project = &repo["project"];
    let project_id = text(project, "id");
    let repository = text(repo, "id");
    if project_id.is_empty() || repository.is_empty() {
        return None;
    }
    Some(json!({
        "kind":"pr", "number":number, "title":text(value,"title"),
        "url":format!("{}/{}/_git/{}/pullrequest/{number}",site,component(&project_id),component(&repository)),
        "state":match value["status"].as_str() { Some("completed")=>"merged",Some("abandoned")=>"closed",Some("active")=>"open",_=>"unknown" },
        "draft":value["isDraft"].as_bool().unwrap_or(false),
        "updatedAt":value["closedDate"].as_str().or(value["creationDate"].as_str()).unwrap_or(""),
        "repo":text(repo,"name"), "projectId":project_id, "projectName":text(project,"name"),
        "delivery":{"kind":"pr","project":project_id,"repository":repository,
          "branch":text(value,"sourceRefName"),"commit":text(&value["lastMergeSourceCommit"],"commitId"),
          "targetBranch":text(value,"targetRefName"),"author":text(&value["createdBy"],"displayName"),"accountId":account}
    }))
}
fn ci_item(value: &Value, site: &str, account: &str) -> Option<Value> {
    if !matches!(
        value["result"].as_str(),
        Some("failed" | "partiallySucceeded")
    ) {
        return None;
    }
    let number = id(&value["id"])?;
    let definition = id(&value["definition"]["id"])?;
    let project = text(&value["project"], "id");
    if project.is_empty() {
        return None;
    }
    Some(json!({
        "kind":"ci", "number":number,"title":format!("{} · {}",text(&value["definition"],"name"),text(value,"buildNumber")),
        "url":format!("{}/{}/_build/results?buildId={number}",site,component(&project)),
        "state":text(value,"result"),"draft":false,
        "updatedAt":value["finishTime"].as_str().or(value["queueTime"].as_str()).unwrap_or(""),
        "repo":text(&value["repository"],"name"),"projectId":project,"projectName":text(&value["project"],"name"),
        "delivery":{"kind":"ci","project":project,"definition":definition,
          "repository":text(&value["repository"],"id"),"repositoryType":text(&value["repository"],"type"),
          "branch":text(value,"sourceBranch"),"commit":text(value,"sourceVersion"),
          "author":text(&value["requestedFor"],"displayName"),"accountId":account}
    }))
}
#[tauri::command]
pub async fn azure_delivery_inbox(
    app: AppHandle,
    site: String,
    account_id: String,
    project: String,
    assigned: bool,
    state: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        if account_id.is_empty() || config.account_id != account_id {
            return Err("Azure account changed. Refresh Inbox.".into());
        }
        if project.is_empty()
            || project.len() > 256
            || project.chars().any(char::is_control)
            || matches!(project.as_str(), "." | "..")
        {
            return Err("Choose an Azure project.".into());
        }
        let path = component(&project);
        let mut items = Vec::new();
        let mut errors = Vec::new();
        let criteria = if assigned {
            vec!["searchCriteria.creatorId", "searchCriteria.reviewerId"]
        } else {
            vec![""]
        };
        for criterion in criteria {
            let mut query = vec![
                ("api-version", "7.1".into()),
                (
                    "searchCriteria.status",
                    if state == "all" { "all" } else { "active" }.into(),
                ),
                ("$top", "50".into()),
            ];
            if !criterion.is_empty() {
                query.push((criterion, account_id.clone()));
            }
            match request(
                &config,
                &format!("{path}/_apis/git/pullrequests"),
                &query,
                None,
            ) {
                Ok(response) => {
                    if let Some(rows) = response["value"].as_array() {
                        if rows.len() >= 50 {
                            errors.push(
                                "PR list limited to 50 per scope. Open Azure for more.".into(),
                            );
                        }
                        items.extend(
                            rows.iter()
                                .take(50)
                                .filter_map(|row| pr_item(row, &site, &account_id)),
                        );
                    } else {
                        errors.push("Azure returned an invalid PR list.".into());
                    }
                }
                Err(error) => {
                    errors.push(format!("PRs: {error}"));
                    break;
                }
            }
        }
        // Retain only the newest completed run per pipeline and branch from this bounded page.
        let mut query = vec![
            ("api-version", "7.1".into()),
            ("statusFilter", "completed".into()),
            ("queryOrder", "finishTimeDescending".into()),
            ("$top", "50".into()),
        ];
        if assigned {
            query.push(("requestedFor", account_id.clone()));
        }
        match request(&config, &format!("{path}/_apis/build/builds"), &query, None) {
            Ok(response) => {
                if let Some(rows) = response["value"].as_array() {
                    if rows.len() >= 50 {
                        errors.push(
                            "CI list limited to 50 recent completed runs. Open Azure for more."
                                .into(),
                        );
                    }
                    let mut seen = std::collections::HashSet::new();
                    items.extend(
                        rows.iter()
                            .take(50)
                            .filter(|row| {
                                seen.insert((
                                    row["definition"]["id"].to_string(),
                                    text(row, "sourceBranch"),
                                ))
                            })
                            .filter_map(|row| ci_item(row, &site, &account_id)),
                    );
                } else {
                    errors.push("Azure returned an invalid CI list.".into());
                }
            }
            Err(error) => errors.push(format!("CI: {error}")),
        }
        if require_config(&app, &site)?.account_id != account_id {
            return Err("Azure account changed. Refresh Inbox.".into());
        }
        Ok(json!({"items":items,"errors":errors}))
    })
    .await
    .map_err(|_| "Azure Inbox lookup failed")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delivery_rows_have_distinct_canonical_identity_and_only_actionable_ci() {
        let pr = json!({"pullRequestId":7,"status":"active","repository":{"id":"repo","project":{"id":"project"}},"sourceRefName":"refs/heads/feature"});
        let run =
            json!({"id":7,"result":"failed","definition":{"id":2},"project":{"id":"project"}});
        let a = pr_item(&pr, "https://dev.azure.com/team", "account").unwrap();
        let b = ci_item(&run, "https://dev.azure.com/team", "account").unwrap();
        assert_ne!(a["url"], b["url"]);
        assert_eq!(a["delivery"]["branch"], "refs/heads/feature");
        let mut success = run.clone();
        success["result"] = json!("succeeded");
        assert!(ci_item(&success, "https://dev.azure.com/team", "account").is_none());
        assert!(pr_item(&json!({"pullRequestId":0}), "site", "account").is_none());
        let mut unknown = pr.clone();
        unknown["status"] = json!("future");
        assert_eq!(
            pr_item(&unknown, "site", "account").unwrap()["state"],
            "unknown"
        );
    }
}

#[tauri::command]
pub async fn azure_ci_inbox_summary(
    app: AppHandle,
    site: String,
    account_id: String,
    project: String,
    number: u32,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        if account_id.is_empty() || config.account_id != account_id {
            return Err("Azure account changed. Refresh Inbox.".into());
        }
        if number == 0
            || project.is_empty()
            || project.len() > 256
            || matches!(project.as_str(), "." | "..")
            || project.chars().any(char::is_control)
        {
            return Err("Invalid Azure run identity.".into());
        }
        let run = request(
            &config,
            &format!("{}/_apis/build/builds/{number}", component(&project)),
            &[("api-version", "7.1".into())],
            None,
        )?;
        if run["id"] != number || run["project"]["id"] != project {
            return Err("Azure returned a different run.".into());
        }
        let mut result =
            ci_item(&run, &site, &account_id).ok_or("Run state changed. Refresh Inbox.")?;
        result["evidence"] = json!({
            "target": {"site":site,"accountId":account_id,"project":project,
                "definition":run["definition"]["id"],"repositoryId":run["repository"]["id"],
                "repositoryType":run["repository"]["type"],"repositoryUrl":""},
            "run": {"id":number,"revision":crate::azure_pipelines::revision(&run)}
        });
        if require_config(&app, &site)?.account_id != account_id {
            return Err("Azure account changed. Refresh Inbox.".into());
        }
        Ok(result)
    })
    .await
    .map_err(|_| "Azure run lookup failed")?
}
