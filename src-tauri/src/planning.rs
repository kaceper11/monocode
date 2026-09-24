//! Read-only native planning periods. Authentication and item parsers stay in their providers.
use crate::{azure_devops as ado, fs, gitlab, jira, linear};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub connection: String,
    #[serde(default)]
    pub cwd: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub id: String,
    pub label: String,
    pub scope: Scope,
    #[serde(default)]
    pub field_id: String,
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub end: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    entries: Vec<Value>,
    next: Option<String>,
}
fn enc(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().map(str::to_owned).unwrap_or_else(|| {
        value[key]
            .as_i64()
            .map(|n| n.to_string())
            .unwrap_or_default()
    })
}
fn rows(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
fn cursor_number(cursor: &str) -> Result<usize, String> {
    if cursor.is_empty() {
        return Ok(0);
    }
    let n = cursor
        .parse::<usize>()
        .map_err(|_| "Invalid planning page")?;
    if n > 100_000 {
        return Err("Planning page limit exceeded".into());
    }
    Ok(n)
}
fn connection_next(value: &Value) -> Option<String> {
    value["pageInfo"]["hasNextPage"]
        .as_bool()
        .filter(|v| *v)
        .and_then(|_| value["pageInfo"]["endCursor"].as_str().map(str::to_owned))
}
fn gh(cwd: &str, query: &str, variables: Value) -> Result<Value, String> {
    let mut args = vec![
        "api".to_string(),
        "graphql".into(),
        "-f".into(),
        format!("query={query}"),
    ];
    for (key, value) in variables.as_object().ok_or("Invalid GraphQL variables")? {
        if value.is_null() {
            continue;
        }
        args.extend([
            "-f".into(),
            format!(
                "{key}={}",
                value.as_str().ok_or("Invalid GraphQL variable")?
            ),
        ]);
    }
    let result = fs::gh_checked(
        &fs::expand_home(cwd),
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    )?;
    let value: Value = serde_json::from_str(&result).map_err(|e| e.to_string())?;
    if let Some(error) = value["errors"][0]["message"].as_str() {
        return Err(error.to_string());
    }
    Ok(value["data"].clone())
}
fn connection(app: &AppHandle, provider: &str, cwd: &str) -> Result<String, String> {
    match provider {
        "jira" => {
            let c = jira::current_config(app)?;
            Ok(format!("{}|{}", c.site, c.account_id()))
        }
        "azuredevops" => {
            let c = ado::require_config(app)?;
            Ok(format!("{}|{}", c.url, ado::azure_current_user_id(&c)?))
        }
        "gitlab" => {
            let c = gitlab::require_config(app)?;
            let user = gitlab::gitlab_get(&c, "/user")?;
            Ok(format!("{}|{}", c.url, text(&user.value, "id")))
        }
        "linear" => {
            let token = linear::require_token(app)?;
            let data = linear::graphql_with_token(
                &token,
                "query { viewer { id organization { id } } }",
                json!({}),
            )?;
            Ok(format!(
                "{}|{}",
                text(&data["viewer"]["organization"], "id"),
                text(&data["viewer"], "id")
            ))
        }
        "github" => {
            let data = gh(cwd, "query { viewer { login } }", json!({}))?;
            Ok(format!("github.com|{}", text(&data["viewer"], "login")))
        }
        _ => Err("Unknown planning provider".into()),
    }
}
fn validate_scope(app: &AppHandle, scope: &Scope) -> Result<(), String> {
    if scope.id.is_empty() || scope.id.len() > 500 || scope.cwd.len() > 4096 {
        return Err("Invalid planning scope".into());
    }
    if connection(app, &scope.provider, &scope.cwd)? != scope.connection {
        return Err("The planning account changed. Reselect the scope.".into());
    }
    Ok(())
}
fn period(scope: &Scope, row: &Value) -> Value {
    let start = text(row, "startDate");
    let end = text(row, "endDate");
    let label = [text(row, "name"), text(row, "title")]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if start.is_empty() {
                format!("Period {}", text(row, "id"))
            } else {
                format!("{start} – {end}")
            }
        });
    json!(Period {
        id: text(row, "id"),
        label,
        scope: scope.clone(),
        field_id: String::new(),
        start,
        end
    })
}

#[tauri::command]
pub async fn planning_scopes(
    app: AppHandle,
    provider: String,
    cwd: String,
    cursor: String,
) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || planning_scopes_for(app, provider, cwd, cursor))
        .await
        .map_err(|e| e.to_string())?
}

fn planning_scopes_for(
    app: AppHandle,
    provider: String,
    cwd: String,
    cursor: String,
) -> Result<Page, String> {
    let identity = connection(&app, &provider, &cwd)?;
    let offset = if provider == "linear" || provider == "github" {
        0
    } else {
        cursor_number(&cursor)?
    };
    let (entries, next) = match provider.as_str() {
        "jira" => {
            let c = jira::current_config(&app)?;
            let value = jira::jira_get(
                &c,
                &format!("/rest/agile/1.0/board?type=scrum&maxResults=50&startAt={offset}"),
            )?;
            let entries = rows(&value["values"]);
            let next = (value["isLast"] != true && !entries.is_empty())
                .then(|| (offset + entries.len()).to_string());
            (entries, next)
        }
        "azuredevops" => {
            let c = ado::require_config(&app)?;
            let value = ado::azure_get(
                &c,
                &format!("/_apis/projects?api-version=7.1&$top=50&$skip={offset}"),
            )?;
            let entries = rows(&value.value["value"]);
            let next = (entries.len() == 50).then(|| (offset + 50).to_string());
            (entries, next)
        }
        "gitlab" => {
            let c = gitlab::require_config(&app)?;
            let page = offset.max(1);
            let result = gitlab::gitlab_get(
                &c,
                &format!("/projects?membership=true&per_page=50&page={page}"),
            )?;
            (
                rows(&result.value),
                result.has_next_page.then(|| (page + 1).to_string()),
            )
        }
        "linear" => {
            let token = linear::require_token(&app)?;
            let data = linear::graphql_with_token(&token, "query($after:String) { teams(first:50,after:$after) { nodes { id name } pageInfo { hasNextPage endCursor } } }", json!({"after": if cursor.is_empty() { None } else { Some(&cursor) }}))?;
            (
                rows(&data["teams"]["nodes"]),
                connection_next(&data["teams"]),
            )
        }
        "github" => {
            let repo = fs::gh_checked(
                &fs::expand_home(&cwd),
                &[
                    "repo",
                    "view",
                    "--json",
                    "nameWithOwner",
                    "--jq",
                    ".nameWithOwner",
                ],
            )?;
            let (owner, name) = repo
                .trim()
                .split_once('/')
                .ok_or("Select a GitHub repository")?;
            let data = gh(&cwd, "query($owner:String!,$name:String!,$after:String) { repository(owner:$owner,name:$name) { projectsV2(first:50,after:$after) { nodes { id title } pageInfo { hasNextPage endCursor } } } }", json!({"owner":owner,"name":name,"after":if cursor.is_empty(){None}else{Some(&cursor)}}))?;
            let list = &data["repository"]["projectsV2"];
            (rows(&list["nodes"]), connection_next(list))
        }
        _ => return Err("Unknown planning provider".into()),
    };
    let entries = entries
        .iter()
        .map(|row| {
            json!(Scope {
                provider: provider.clone(),
                id: text(row, "id"),
                name: [
                    text(row, "path_with_namespace"),
                    text(row, "name"),
                    text(row, "title")
                ]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or_default(),
                connection: identity.clone(),
                cwd: cwd.clone()
            })
        })
        .collect();
    if connection(&app, &provider, &cwd)? != identity {
        return Err("Planning account changed during loading".into());
    }
    Ok(Page { entries, next })
}

#[tauri::command]
pub async fn planning_periods(
    app: AppHandle,
    scope: Scope,
    cursor: String,
) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || planning_periods_for(app, scope, cursor))
        .await
        .map_err(|e| e.to_string())?
}

fn planning_periods_for(app: AppHandle, scope: Scope, cursor: String) -> Result<Page, String> {
    validate_scope(&app, &scope)?;
    let mut next = None;
    let entries = match scope.provider.as_str() {
        "jira" => {
            let c = jira::current_config(&app)?;
            let offset = cursor_number(&cursor)?;
            let value = jira::jira_get(
                &c,
                &format!(
                    "/rest/agile/1.0/board/{}/sprint?maxResults=50&startAt={offset}",
                    enc(&scope.id)
                ),
            )?;
            let entries = rows(&value["values"]);
            next = (value["isLast"] != true && !entries.is_empty())
                .then(|| (offset + entries.len()).to_string());
            entries.iter().map(|row| period(&scope, row)).collect()
        }
        "azuredevops" => {
            let c = ado::require_config(&app)?;
            let value = ado::azure_get(
                &c,
                &format!(
                    "/{}/_apis/wit/classificationnodes/iterations?$depth=10&api-version=7.1",
                    enc(&scope.id)
                ),
            )?;
            let mut entries = Vec::new();
            fn walk(scope: &Scope, row: &Value, out: &mut Vec<Value>) {
                if row["attributes"]["startDate"].is_string() {
                    let mut value = row.clone();
                    value["id"] = row["path"].clone();
                    value["startDate"] = row["attributes"]["startDate"].clone();
                    value["endDate"] = row["attributes"]["finishDate"].clone();
                    out.push(period(scope, &value));
                }
                for child in rows(&row["children"]) {
                    walk(scope, &child, out);
                }
            }
            walk(&scope, &value.value, &mut entries);
            entries
        }
        "gitlab" => {
            let c = gitlab::require_config(&app)?;
            let page = cursor_number(&cursor)?.max(1);
            let value = gitlab::gitlab_get(
                &c,
                &format!(
                    "/projects/{}/iterations?include_ancestors=true&per_page=50&page={page}",
                    enc(&scope.id)
                ),
            )?;
            next = value.has_next_page.then(|| (page + 1).to_string());
            rows(&value.value)
                .iter()
                .map(|row| {
                    let mut v = row.clone();
                    v["startDate"] = row["start_date"].clone();
                    v["endDate"] = row["due_date"].clone();
                    period(&scope, &v)
                })
                .collect()
        }
        "linear" => {
            let token = linear::require_token(&app)?;
            let value=linear::graphql_with_token(&token,"query($id:String!,$after:String) { team(id:$id) { cycles(first:50,after:$after) { nodes { id name number startsAt endsAt } pageInfo { hasNextPage endCursor } } } }",json!({"id":scope.id,"after":if cursor.is_empty(){None}else{Some(&cursor)}}))?;
            let list = &value["team"]["cycles"];
            next = connection_next(list);
            rows(&list["nodes"])
                .iter()
                .map(|row| {
                    let mut v = row.clone();
                    v["startDate"] = row["startsAt"].clone();
                    v["endDate"] = row["endsAt"].clone();
                    if text(row, "name").is_empty() {
                        v["name"] = json!(format!("Cycle {}", text(row, "number")));
                    }
                    period(&scope, &v)
                })
                .collect()
        }
        "github" => {
            let value=gh(&scope.cwd,"query($id:ID!) { node(id:$id) { ... on ProjectV2 { fields(first:100) { nodes { ... on ProjectV2IterationField { id name configuration { iterations { id title startDate duration } completedIterations { id title startDate duration } } } } pageInfo { hasNextPage } } } } }",json!({"id":scope.id}))?;
            let fields = &value["node"]["fields"];
            if fields["pageInfo"]["hasNextPage"] == true {
                return Err(
                    "Project has more than 100 fields; iteration catalog is incomplete".into(),
                );
            }
            let mut entries = Vec::new();
            for field in rows(&fields["nodes"]) {
                for row in rows(&field["configuration"]["iterations"])
                    .into_iter()
                    .chain(rows(&field["configuration"]["completedIterations"]))
                {
                    let mut entry = period(&scope, &row);
                    entry["duration"] = row["duration"].clone();
                    entry["fieldId"] = field["id"].clone();
                    entry["label"] = json!(format!(
                        "{} · {}",
                        text(&field, "name"),
                        text(&row, "title")
                    ));
                    entries.push(entry);
                }
            }
            entries
        }
        _ => return Err("Unknown planning provider".into()),
    };
    validate_scope(&app, &scope)?;
    Ok(Page { entries, next })
}

#[tauri::command]
pub async fn planning_items(
    app: AppHandle,
    period: Period,
    relationships: Vec<String>,
    cursor: String,
) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || {
        planning_items_for(app, period, relationships, cursor)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn planning_items_for(
    app: AppHandle,
    period: Period,
    relationships: Vec<String>,
    cursor: String,
) -> Result<Page, String> {
    validate_scope(&app, &period.scope)?;
    if period.id.is_empty()
        || period.id.len() > 1000
        || cursor.len() > 2000
        || relationships
            .iter()
            .any(|r| !["assigned", "created", "reviewing", "related"].contains(&r.as_str()))
    {
        return Err("Invalid planning selection".into());
    }
    let scope = &period.scope;
    let mut next = None;
    let assigned = relationships
        .iter()
        .any(|r| r == "assigned" || r == "related");
    let created = relationships
        .iter()
        .any(|r| r == "created" || r == "related");
    let only_reviewing = !relationships.is_empty() && !assigned && !created;
    if only_reviewing && scope.provider != "github" {
        return Ok(Page {
            entries: vec![],
            next: None,
        });
    }
    let entries = match scope.provider.as_str() {
        "jira" => {
            let c = jira::current_config(&app)?;
            let id = period.id.parse::<u64>().map_err(|_| "Invalid sprint id")?;
            let mut roles = Vec::new();
            if assigned {
                roles.push("assignee = currentUser()");
            }
            if created {
                roles.push("creator = currentUser()");
            }
            let jql = format!(
                "sprint = {id}{} ORDER BY updated DESC",
                if roles.is_empty() {
                    String::new()
                } else {
                    format!(" AND ({})", roles.join(" OR "))
                }
            );
            let mut body = json!({"jql":jql,"maxResults":100,"fields":jira::ISSUE_FIELDS});
            if !cursor.is_empty() {
                body["nextPageToken"] = json!(cursor);
            }
            let value = jira::jira_post(&c, "/rest/api/3/search/jql", &body)?;
            next = value["nextPageToken"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let mut issues = jira::parse_jira_issues(&value, &c.site)?;
            for issue in &mut issues {
                issue.account = c.account_id();
                issue.site = c.site.clone();
            }
            issues
                .into_iter()
                .map(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, _>>()?
        }
        "azuredevops" => {
            let c = ado::require_config(&app)?;
            // Classification node paths contain an extra Iteration segment absent in WIQL paths.
            let path = period
                .id
                .trim_start_matches('\\')
                .replacen("\\Iteration\\", "\\", 1)
                .replace('\'', "''");
            let mut roles = Vec::new();
            if assigned {
                roles.push("[System.AssignedTo] = @me");
            }
            if created {
                roles.push("[System.CreatedBy] = @me");
            }
            let after = cursor_number(&cursor)?;
            let query=format!("SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '{path}' AND [System.Id] > {after}{} ORDER BY [System.Id]",if roles.is_empty(){String::new()}else{format!(" AND ({})",roles.join(" OR "))});
            let value = ado::azure_post_json(
                &c,
                "/_apis/wit/wiql?$top=100&api-version=7.1",
                json!({"query":query}),
            )?;
            let ids: Vec<i64> = rows(&value.value["workItems"])
                .iter()
                .filter_map(|r| r["id"].as_i64())
                .collect();
            if ids.len() == 100 {
                next = ids.last().map(|n| n.to_string());
            }
            if ids.is_empty() {
                vec![]
            } else {
                ado::azure_fetch_wit_batch(&c, &ids)?
            }
            .into_iter()
            .map(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?
        }
        "linear" => {
            let token = linear::require_token(&app)?;
            let mut filter = json!({"cycle":{"id":{"eq":period.id}},"team":{"id":{"eq":scope.id}}});
            let mut roles = vec![];
            if assigned {
                roles.push(json!({"assignee":{"isMe":{"eq":true}}}));
            }
            if created {
                roles.push(json!({"creator":{"isMe":{"eq":true}}}));
            }
            if !roles.is_empty() {
                filter["or"] = json!(roles);
            }
            let query = linear::ISSUES_QUERY
                .replace(
                    "$filter: IssueFilter)",
                    "$filter: IssueFilter, $after: String)",
                )
                .replace(
                    "filter: $filter, orderBy:",
                    "filter: $filter, after: $after, orderBy:",
                )
                .replace(
                    "    nodes {",
                    "    pageInfo { hasNextPage endCursor }\n    nodes {",
                );
            let value = linear::graphql_with_token(
                &token,
                &query,
                json!({"first":100,"filter":filter,"after":if cursor.is_empty(){None}else{Some(&cursor)}}),
            )?;
            next = connection_next(&value["issues"]);
            linear::parse_linear_issues(&value)?
                .into_iter()
                .map(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, _>>()?
        }
        "gitlab" => {
            let c = gitlab::require_config(&app)?;
            let page = cursor_number(&cursor)?.max(1);
            let id = period
                .id
                .parse::<u64>()
                .map_err(|_| "Invalid iteration id")?;
            let project = gitlab::gitlab_get(&c, &format!("/projects/{}", enc(&scope.id)))?;
            let repo = text(&project.value, "path_with_namespace");
            let roles: Vec<&str> = if assigned && created {
                vec!["assigned", "created"]
            } else if assigned {
                vec!["assigned"]
            } else if created {
                vec!["created"]
            } else {
                vec!["all"]
            };
            let mut entries = vec![];
            for role in roles {
                let suffix = gitlab::relationship_suffix(&c, "issue", role)?;
                let value = gitlab::gitlab_get(
                    &c,
                    &format!(
                        "/projects/{}/issues?iteration_id={id}&per_page=100&page={page}{suffix}",
                        enc(&scope.id)
                    ),
                )?;
                if value.has_next_page {
                    next = Some((page + 1).to_string());
                }
                entries.extend(
                    gitlab::parse_work_items(&value.value, "issue", &repo)?
                        .into_iter()
                        .map(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            entries
        }
        "github" => github_period_items(&period, &relationships, &cursor, &mut next)?,
        _ => return Err("Unknown planning provider".into()),
    };
    validate_scope(&app, scope)?;
    let entries = entries
        .into_iter()
        .map(|mut item| {
            item["provider"] = json!(scope.provider);
            if item["projectPath"].is_null() {
                item["projectPath"] = json!(if scope.provider == "github" {
                    scope.cwd.as_str()
                } else {
                    ""
                });
            }
            item
        })
        .collect();
    Ok(Page { entries, next })
}

fn github_period_items(
    period: &Period,
    roles: &[String],
    cursor: &str,
    next: &mut Option<String>,
) -> Result<Vec<Value>, String> {
    let query = r#"query($id:ID!,$after:String) { viewer { login } node(id:$id) { ... on ProjectV2 { items(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { fieldValues(first:100) { pageInfo { hasNextPage } nodes { ... on ProjectV2ItemFieldIterationValue { iterationId field { ... on ProjectV2IterationField { id } } } } } content { __typename ... on Issue { number title url state updatedAt repository { nameWithOwner } author { login } assignees(first:100) { nodes { login } } } ... on PullRequest { number title url state updatedAt isDraft repository { nameWithOwner } author { login } assignees(first:100) { nodes { login } } reviewRequests(first:100) { nodes { requestedReviewer { ... on User { login } } } } } } } } } } }"#;
    let data = gh(
        &period.scope.cwd,
        query,
        json!({"id":period.scope.id,"after":if cursor.is_empty(){None}else{Some(cursor)}}),
    )?;
    let list = &data["node"]["items"];
    *next = connection_next(list);
    let viewer = text(&data["viewer"], "login");
    let mut result = vec![];
    for row in rows(&list["nodes"]) {
        if row["fieldValues"]["pageInfo"]["hasNextPage"] == true {
            return Err(
                "A project item has more than 100 fields; iteration membership is incomplete"
                    .into(),
            );
        }
        if !rows(&row["fieldValues"]["nodes"]).iter().any(|v| {
            text(v, "iterationId") == period.id && text(&v["field"], "id") == period.field_id
        }) {
            continue;
        }
        let item = &row["content"];
        let kind = match item["__typename"].as_str() {
            Some("Issue") => "issue",
            Some("PullRequest") => "pr",
            _ => continue,
        };
        let assigned = rows(&item["assignees"]["nodes"])
            .iter()
            .any(|v| text(v, "login") == viewer);
        let created = text(&item["author"], "login") == viewer;
        let reviewing = rows(&item["reviewRequests"]["nodes"])
            .iter()
            .any(|v| text(&v["requestedReviewer"], "login") == viewer);
        if !roles.is_empty()
            && !roles.iter().any(|r| match r.as_str() {
                "assigned" => assigned,
                "created" => created,
                "reviewing" => reviewing,
                "related" => assigned || created || reviewing,
                _ => false,
            })
        {
            continue;
        }
        result.push(json!({"kind":kind,"number":item["number"],"title":item["title"],"url":item["url"],"state":text(item,"state").to_lowercase(),"updatedAt":item["updatedAt"],"repo":item["repository"]["nameWithOwner"],"assignees":rows(&item["assignees"]["nodes"]),"labels":[],"draft":item["isDraft"].as_bool().unwrap_or(false)}));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursors_are_bounded_and_native_period_identity_is_retained() {
        assert_eq!(cursor_number("").unwrap(), 0);
        assert_eq!(cursor_number("100").unwrap(), 100);
        assert!(cursor_number("-1").is_err());
        assert!(cursor_number("100001").is_err());
        let scope = Scope {
            provider: "gitlab".into(),
            id: "12".into(),
            name: "team/repo".into(),
            connection: "host|user".into(),
            cwd: String::new(),
        };
        let entry = period(
            &scope,
            &json!({"id":34,"title":null,"startDate":"2026-09-21","endDate":"2026-10-01"}),
        );
        assert_eq!(entry["id"], "34");
        assert_eq!(entry["label"], "2026-09-21 – 2026-10-01");
        assert_eq!(entry["scope"]["connection"], "host|user");
        assert_eq!(
            connection_next(&json!({"pageInfo":{"hasNextPage":true,"endCursor":"second"}})),
            Some("second".into())
        );
        assert_eq!(enc("Team / Work & Plan"), "Team+%2F+Work+%26+Plan");
    }
}
