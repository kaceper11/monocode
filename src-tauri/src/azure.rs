//! Azure DevOps Services connection and read-only Boards requests. Credentials stay on the app host.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, io::Read, path::PathBuf, time::Duration};
use tauri::{AppHandle, Emitter, Manager, Url};

static CONFIG_WRITES: crate::integration_config::ConfigWrites =
    crate::integration_config::ConfigWrites::new();

#[derive(Serialize, Deserialize)]
pub(crate) struct AzureConfig {
    pub site: String,
    pub project: String,
    pub account: String,
    pub account_id: String,
    #[serde(default = "legacy_capabilities")]
    capabilities: Vec<String>,
    token: String,
}

fn legacy_capabilities() -> Vec<String> {
    vec!["Boards".into()]
}

impl AzureConfig {
    fn status(&self) -> Value {
        json!({"connected":true,"site":self.site,"project":self.project,"account":self.account,"accountId":self.account_id,"capabilities":self.capabilities})
    }
    pub(crate) fn authorization(&self) -> String {
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!(":{}", self.token))
        )
    }
    pub(crate) fn has_capability(&self, name: &str) -> bool {
        self.capabilities
            .iter()
            .any(|capability| capability == name)
    }
}

fn normalize_site(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Use https://dev.azure.com/your-organization")?;
    let org = url.path().trim_matches('/');
    if url.scheme() != "https"
        || url.host_str() != Some("dev.azure.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || org.is_empty()
        || org.len() > 100
        || !org.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(
            "Use https://dev.azure.com/your-organization. Azure DevOps Server is not supported."
                .into(),
        );
    }
    Ok(format!(
        "https://dev.azure.com/{}",
        org.to_ascii_lowercase()
    ))
}

pub(crate) fn component(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn project_path(project: &str) -> Result<String, String> {
    if project.trim().is_empty()
        || project.len() > 256
        || project.chars().any(char::is_control)
        || matches!(project, "." | "..")
    {
        return Err("Choose an Azure Boards project".into());
    }
    Ok(component(project))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate Azure settings")?
        .join("azure-config.json"))
}

fn read_config(app: &AppHandle) -> Result<Option<AzureConfig>, String> {
    match fs::read(config_path(app)?) {
        Ok(raw) => {
            let mut config: AzureConfig = serde_json::from_slice(&raw)
                .map_err(|_| "Invalid Azure settings. Reconnect in Settings.")?;
            config.site = normalize_site(&config.site)?;
            Ok(Some(config))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read Azure settings".into()),
    }
}

pub(crate) fn require_config(app: &AppHandle, site: &str) -> Result<AzureConfig, String> {
    let config = read_config(app)?.ok_or("Connect Azure DevOps in Settings")?;
    if config.site != normalize_site(site)? {
        return Err("Azure connection changed. Refresh and retry.".into());
    }
    Ok(config)
}

fn require_account(config: &AzureConfig, expected: &str) -> Result<(), String> {
    if expected.is_empty() || expected != config.account_id {
        return Err("The Azure account changed. Refresh and reselect the item.".into());
    }
    Ok(())
}

fn http_error(status: u16) -> String {
    match status {
        401 | 203 => "Azure credentials expired or are invalid. Reconnect in Settings.".into(),
        403 => "Azure denied access. Check Work Items (Read), Project and Team (Read), and project permissions.".into(),
        404 => "Azure project, query or item is unavailable. Choose another project/query or retry.".into(),
        429 => "Azure is rate limiting requests. Wait before retrying.".into(),
        _ => format!("Azure request failed (HTTP {status}). Retry when the service is available."),
    }
}

pub(crate) fn request(
    config: &AzureConfig,
    path: &str,
    query: &[(&str, String)],
    body: Option<Value>,
) -> Result<Value, String> {
    request_method(
        config,
        if body.is_some() { "POST" } else { "GET" },
        path,
        query,
        body,
    )
}

pub(crate) fn request_method(
    config: &AzureConfig,
    method: &str,
    path: &str,
    query: &[(&str, String)],
    body: Option<Value>,
) -> Result<Value, String> {
    let (raw, _) = request_bytes_method(
        config,
        method,
        path,
        query,
        body,
        "application/json",
        2 * 1024 * 1024,
    )?;
    serde_json::from_slice(&raw)
        .map_err(|_| "Azure returned an invalid response. Reconnect or retry.".into())
}

pub(crate) fn request_bytes(
    config: &AzureConfig,
    path: &str,
    query: &[(&str, String)],
    body: Option<Value>,
    accept: &str,
    limit: usize,
) -> Result<(Vec<u8>, Option<String>), String> {
    request_bytes_method(
        config,
        if body.is_some() { "POST" } else { "GET" },
        path,
        query,
        body,
        accept,
        limit,
    )
}

fn request_bytes_method(
    config: &AzureConfig,
    method: &str,
    path: &str,
    query: &[(&str, String)],
    body: Option<Value>,
    accept: &str,
    limit: usize,
) -> Result<(Vec<u8>, Option<String>), String> {
    // All paths are built here from encoded components, never from a provider response URL.
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .redirects(0)
        .build();
    let url = format!("{}/{path}", config.site);
    let mut req = agent
        .request(method, &url)
        .set("Authorization", &config.authorization())
        .set("Accept", accept);
    for (key, value) in query {
        req = req.query(key, value);
    }
    let result = if let Some(body) = body {
        req.set("Content-Type", "application/json")
            .send_string(&body.to_string())
    } else {
        req.call()
    };
    let response = match result {
        Ok(response) if (200..300).contains(&response.status()) => response,
        Ok(response) | Err(ureq::Error::Status(_, response)) => {
            return Err(http_error(response.status()))
        }
        Err(_) => return Err("Cannot reach Azure DevOps. Check your connection and retry.".into()),
    };
    let continuation = response.header("x-ms-continuationtoken").map(String::from);
    if continuation
        .as_ref()
        .is_some_and(|value| value.len() > 2048 || value.chars().any(char::is_control))
    {
        return Err("Azure returned an invalid continuation token. Refresh the list.".into());
    }
    let mut raw = Vec::new();
    response
        .into_reader()
        .take(limit as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "Cannot read Azure response")?;
    if raw.len() > limit {
        return Err("Azure response is too large. Choose a narrower query.".into());
    }
    Ok((raw, continuation))
}

fn version() -> [(&'static str, String); 1] {
    [("api-version", "7.1".into())]
}

#[tauri::command(async)]
pub fn azure_status(app: AppHandle) -> Result<Value, String> {
    Ok(read_config(&app)?.map(|c| c.status()).unwrap_or(
        json!({"connected":false,"site":"","project":"","account":"","capabilities":[]}),
    ))
}

#[tauri::command]
pub async fn azure_set_config(
    app: AppHandle,
    site: String,
    project: String,
    token: String,
) -> Result<Value, String> {
    let generation = CONFIG_WRITES.begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_path(&app)?;
        if token.is_empty() {
            CONFIG_WRITES.commit(generation, &path, None)?;
            let _ = app.emit("monocode:azure-change", ());
            return azure_status(app);
        }
        if token.trim().is_empty() || token.len() > 4096 || token.chars().any(char::is_control) {
            return Err("Enter a valid Azure DevOps personal access token".into());
        }
        let mut config = AzureConfig {
            site: normalize_site(&site)?,
            project: project.trim().into(),
            token: token.trim().into(),
            account: String::new(),
            account_id: String::new(),
            capabilities: Vec::new(),
        };
        let project = project_path(&config.project)?;
        let viewer = request(
            &config,
            "_apis/connectionData",
            &[
                ("connectOptions", "0".into()),
                ("api-version", "7.1-preview.1".into()),
            ],
            None,
        )?;
        config.account_id = viewer["authenticatedUser"]["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Azure did not return an authenticated account")?
            .into();
        config.account = viewer["authenticatedUser"]["providerDisplayName"]
            .as_str()
            .unwrap_or(&config.account_id)
            .into();
        // The shared connection may serve Boards, Repos, or both. One denied capability
        // must not prevent connecting the other, or overwrite a working connection.
        let boards = request(
            &config,
            &format!("{project}/_apis/wit/workitemtypes"),
            &version(),
            None,
        );
        if boards.is_ok() {
            config.capabilities.push("Boards".into());
        }
        let repos = request(
            &config,
            &format!("{project}/_apis/git/repositories"),
            &version(),
            None,
        );
        if repos.is_ok() {
            config.capabilities.push("Repos".into());
        }
        if request(&config, &format!("{project}/_apis/build/definitions"), &[("api-version", "7.1".into()), ("$top", "1".into())], None).is_ok() {
            config.capabilities.push("Pipelines".into());
        }
        if config.capabilities.is_empty() {
            return Err("Azure account authenticated, but no read capability was verified. Check the project and grant Work Items (Read) for Boards Code (Read) for Repos, or Build (Read) for Pipelines. Existing connection was preserved.".into());
        }
        let raw = serde_json::to_string(&config).map_err(|_| "Cannot encode Azure settings")?;
        CONFIG_WRITES.commit(generation, &path, Some(&raw))?;
        let _ = app.emit("monocode:azure-change", ());
        Ok(config.status())
    })
    .await
    .map_err(|_| "Azure connection task failed")?
}

fn query_ids(result: &Value) -> Result<Vec<u64>, String> {
    let rows = result["workItems"].as_array().ok_or(
        "This saved query is not a flat work-item list. Choose a flat query or Assigned to me.",
    )?;
    let mut seen = HashSet::new();
    Ok(rows
        .iter()
        .filter_map(|v| v["id"].as_u64())
        .filter(|id| *id > 0 && seen.insert(*id))
        .take(100)
        .collect())
}

#[tauri::command]
pub async fn azure_list_items(
    app: AppHandle,
    site: String,
    account_id: String,
    project: String,
    query: String,
    assigned: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        require_account(&config, &account_id)?;
        let project = project_path(&project)?;
        let query_result = if query.is_empty() {
            let predicate = if assigned { " AND [System.AssignedTo] = @Me" } else { "" };
            request(&config, &format!("{project}/_apis/wit/wiql"), &[("api-version", "7.1".into()), ("$top", "100".into())], Some(json!({"query":format!("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @Project{predicate} ORDER BY [System.ChangedDate] DESC")})))?
        } else {
            if !guid(&query) { return Err("Choose a valid saved query".into()); }
            request(&config, &format!("{project}/_apis/wit/wiql/{query}"), &[("api-version", "7.1".into()), ("$top", "100".into())], None)?
        };
        let ids = query_ids(&query_result)?;
        if ids.is_empty() {
            require_account(&require_config(&app, &site)?, &account_id)?;
            return Ok(json!({"site":config.site,"items":[]}));
        }
        let batch = request(&config, "_apis/wit/workitemsbatch", &version(), Some(json!({"ids":ids,"fields":["System.Id","System.Title","System.State","System.WorkItemType","System.TeamProject","System.ChangedDate","System.Tags","System.AssignedTo"],"errorPolicy":"Fail"})))?;
        let mut items = batch["value"].as_array().ok_or("Azure returned an invalid work-item batch")?.clone();
        items.truncate(100);
        attach_state_categories(&config, &mut items);
        require_account(&require_config(&app, &site)?, &account_id)?;
        Ok(json!({"site":config.site,"items":items}))
    }).await.map_err(|_| "Azure list task failed")?
}

/// One metadata request per distinct project, not one request per rendered row.
fn attach_state_categories(config: &AzureConfig, items: &mut [Value]) {
    let mut projects = std::collections::HashMap::new();
    for item in items.iter_mut() {
        let name = item["fields"]["System.TeamProject"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if !projects.contains_key(&name) && projects.len() < 10 {
            let types = project_path(&name).ok().and_then(|project| {
                request(
                    config,
                    &format!("{project}/_apis/wit/workitemtypes"),
                    &version(),
                    None,
                )
                .ok()
            });
            projects.insert(name.clone(), types);
        }
        let category = projects
            .get(&name)
            .and_then(Option::as_ref)
            .and_then(|v| v["value"].as_array())
            .and_then(|types| {
                types
                    .iter()
                    .find(|t| t["name"] == item["fields"]["System.WorkItemType"])
            })
            .and_then(|t| t["states"].as_array())
            .and_then(|states| {
                states
                    .iter()
                    .find(|s| s["name"] == item["fields"]["System.State"])
            })
            .and_then(|s| s["category"].as_str())
            .unwrap_or("unknown")
            .to_string();
        item["stateCategory"] = json!(category);
    }
}

fn guid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

pub(crate) fn attachment_url(site: &str, raw: &str) -> Result<String, String> {
    let site = normalize_site(site)?;
    let url = Url::parse(raw).map_err(|_| "Invalid Azure attachment URL")?;
    let org = site.rsplit('/').next().unwrap_or_default();
    let segments: Vec<_> = url.path_segments().into_iter().flatten().collect();
    let suffix = if segments.len() == 5 {
        &segments[1..]
    } else if segments.len() == 6 {
        &segments[2..]
    } else {
        return Err("Unsupported Azure attachment URL".into());
    };
    if url.scheme() != "https"
        || url.host_str() != Some("dev.azure.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || segments
            .first()
            .is_none_or(|s| !s.eq_ignore_ascii_case(org))
        || suffix[..3] != ["_apis", "wit", "attachments"]
        || !guid(suffix[3])
    {
        return Err("Only attachments in the selected Azure organization are supported".into());
    }
    Ok(format!(
        "{site}/_apis/wit/attachments/{}?api-version=7.1",
        suffix[3]
    ))
}

pub(crate) fn attachments(config: &AzureConfig, item: &Value, comments: &[Value]) -> Vec<Value> {
    let mut files = Vec::new();
    let mut add = |raw: &str, name: &str, size: Option<u64>| {
        let Ok(url) = attachment_url(&config.site, raw) else {
            return;
        };
        if files.len() >= 200 || files.iter().any(|f: &Value| f["url"] == url) {
            return;
        }
        let parsed = Url::parse(raw).ok();
        let query_name = parsed.as_ref().and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| k == "fileName")
                .map(|(_, v)| v.into_owned())
        });
        let name = if name.is_empty() {
            query_name.as_deref().unwrap_or("attachment")
        } else {
            name
        };
        let lower = name.to_ascii_lowercase();
        let mime = if lower.ends_with(".png") {
            "image/png"
        } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
            "image/jpeg"
        } else if lower.ends_with(".gif") {
            "image/gif"
        } else if lower.ends_with(".webp") {
            "image/webp"
        } else {
            ""
        };
        files.push(json!({"id":url,"url":url,"name":name,"mimeType":mime,"size":size}));
    };
    if let Some(relations) = item["relations"].as_array() {
        for relation in relations.iter().take(200) {
            if relation["rel"] == "AttachedFile" {
                add(
                    relation["url"].as_str().unwrap_or_default(),
                    relation["attributes"]["name"].as_str().unwrap_or_default(),
                    relation["attributes"]["resourceSize"].as_u64(),
                );
            }
        }
    }
    let bodies = [
        "System.Description",
        "Microsoft.VSTS.TCM.ReproSteps",
        "Microsoft.VSTS.Common.AcceptanceCriteria",
    ]
    .iter()
    .filter_map(|key| item["fields"][key].as_str())
    .chain(
        comments
            .iter()
            .filter_map(|c| c["renderedText"].as_str().or(c["text"].as_str())),
    );
    for body in bodies {
        // ponytail: only absolute Azure attachment links in bounded rich text; unusual escaped links remain available in Azure.
        for token in body
            .split(['"', '\'', '<', '>', ' ', '\n', '\r', '(', ')'])
            .take(20_000)
        {
            if token.starts_with("https://dev.azure.com/") {
                add(&token.replace("&amp;", "&"), "", None);
            }
        }
    }
    files
}

fn flatten_queries(rows: &[Value], depth: usize, result: &mut Vec<Value>) {
    if depth > 2 {
        return;
    }
    for row in rows.iter().take(100) {
        if result.len() >= 100 {
            break;
        }
        if row["isFolder"] != true
            && row["queryType"] == "flat"
            && row["id"].as_str().is_some_and(guid)
        {
            result.push(json!({"id":row["id"],"name":row["path"].as_str().or(row["name"].as_str()).unwrap_or("Saved query")}));
        }
        if let Some(children) = row["children"].as_array() {
            flatten_queries(children, depth + 1, result);
        }
    }
}

#[tauri::command]
pub async fn azure_options(
    app: AppHandle,
    site: String,
    account_id: String,
    project: String,
    queries: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        require_account(&config, &account_id)?;
        let result = if queries {
            let page = request(
                &config,
                &format!("{}/_apis/wit/queries", project_path(&project)?),
                &[
                    ("api-version", "7.1".into()),
                    ("$depth", "2".into()),
                    ("$expand", "wiql".into()),
                ],
                None,
            )?;
            let mut result = Vec::new();
            flatten_queries(
                page["value"].as_array().ok_or("Invalid Azure query list")?,
                0,
                &mut result,
            );
            json!(result)
        } else {
            // ponytail: bounded first 100 projects; direct project entry in Settings handles larger organizations.
            let page = request(
                &config,
                "_apis/projects",
                &[("api-version", "7.1".into()), ("$top", "100".into())],
                None,
            )?;
            json!(page["value"]
                .as_array()
                .ok_or("Invalid Azure project list")?
                .iter()
                .take(100)
                .map(|p| json!({"id":p["name"],"name":p["name"]}))
                .collect::<Vec<_>>())
        };
        require_account(&require_config(&app, &site)?, &account_id)?;
        Ok(result)
    })
    .await
    .map_err(|_| "Azure options task failed")?
}

pub(crate) fn item(config: &AzureConfig, id: &str) -> Result<Value, String> {
    if id.parse::<u32>().ok().filter(|n| *n > 0).is_none() {
        return Err("Invalid Azure work-item ID".into());
    }
    request(
        config,
        &format!("_apis/wit/workitems/{id}"),
        &[
            ("api-version", "7.1".into()),
            ("$expand", "relations".into()),
        ],
        None,
    )
}

pub(crate) fn comments(
    config: &AzureConfig,
    project: &str,
    id: &str,
    pages: usize,
) -> Result<Value, String> {
    if id.parse::<u32>().ok().filter(|n| *n > 0).is_none() {
        return Err("Invalid Azure work-item ID".into());
    }
    comment_pages(pages, |token| {
        request(
            config,
            &format!(
                "{}/_apis/wit/workItems/{id}/comments",
                project_path(project)?
            ),
            &[
                ("api-version", "7.1-preview.4".into()),
                ("$top", "50".into()),
                ("order", "desc".into()),
                ("$expand", "renderedText".into()),
                ("continuationToken", token.into()),
            ],
            None,
        )
    })
}

fn comment_pages(
    pages: usize,
    mut fetch: impl FnMut(&str) -> Result<Value, String>,
) -> Result<Value, String> {
    let mut comments = Vec::new();
    let mut token = String::new();
    let mut seen = HashSet::new();
    for _ in 0..pages.clamp(1, 5) {
        let page = fetch(&token)?;
        let rows = page["comments"]
            .as_array()
            .ok_or("Invalid Azure comment list")?;
        comments.extend(
            rows.iter()
                .take(50)
                .filter(|c| c["isDeleted"] != true)
                .cloned(),
        );
        token = page["continuationToken"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if token.is_empty() || rows.is_empty() || !seen.insert(token.clone()) {
            break;
        }
    }
    Ok(json!({"comments":comments,"more":!token.is_empty()}))
}

#[tauri::command]
pub async fn azure_item_content(
    app: AppHandle,
    site: String,
    account_id: String,
    id: String,
    discussion: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        require_account(&config, &account_id)?;
        let item = item(&config, &id)?;
        let result = if discussion {
            let mut discussion = comments(
                &config,
                item["fields"]["System.TeamProject"]
                    .as_str()
                    .ok_or("Azure item has no project")?,
                &id,
                1,
            )?;
            discussion["attachments"] = json!(attachments(
                &config,
                &item,
                discussion["comments"]
                    .as_array()
                    .ok_or("Invalid Azure comments")?
            ));
            discussion
        } else {
            let mut item = item;
            item["attachments"] = json!(attachments(&config, &item, &[]));
            item
        };
        require_account(&require_config(&app, &site)?, &account_id)?;
        Ok(result)
    })
    .await
    .map_err(|_| "Azure details task failed")?
}

#[tauri::command]
pub async fn azure_image(
    app: AppHandle,
    site: String,
    account_id: String,
    id: String,
    attachment_id: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app, &site)?;
        require_account(&config, &account_id)?;
        let item = item(&config, &id)?;
        let mut files = attachments(&config, &item, &[]);
        if !files.iter().any(|f| f["id"] == attachment_id) {
            let discussion = comments(&config, item["fields"]["System.TeamProject"].as_str().ok_or("Azure item has no project")?, &id, 1)?;
            files = attachments(&config, &item, discussion["comments"].as_array().ok_or("Invalid Azure comments")?);
        }
        let file = files.iter().find(|f| f["id"] == attachment_id).ok_or("Image is no longer on this Azure work item")?;
        let url = attachment_url(&config.site, file["url"].as_str().ok_or("Invalid Azure image")?)?;
        let response = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).redirects(0).build().get(&url).set("Authorization", &config.authorization()).call().map_err(|_| "Cannot load Azure image. Check access and retry.")?;
        if response.status() != 200 { return Err("Azure image was redirected or unavailable".to_string()); }
        let mut bytes = Vec::new();
        response.into_reader().take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "Cannot read Azure image")?;
        if bytes.len() > 2 * 1024 * 1024 || crate::inbox_media::image_mime(&bytes).is_none() { return Err("Image exceeds the 2 MiB preview limit or uses an unsupported format. Open it in Azure DevOps.".into()); }
        require_account(&require_config(&app, &site)?, &account_id)?;
        Ok(bytes)
    }).await.map_err(|_| "Azure image task failed")??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_item_reads_require_the_displayed_account() {
        let config: AzureConfig = serde_json::from_value(json!({
            "site": "https://dev.azure.com/team", "project": "Project",
            "account": "Same Name", "account_id": "account-a", "token": "test-only"
        }))
        .unwrap();
        assert!(require_account(&config, "account-a").is_ok());
        for foreign in ["", "Same Name", "account-b"] {
            assert!(require_account(&config, foreign).is_err());
        }
    }

    #[test]
    fn existing_connections_keep_boards_and_repos_capabilities_are_explicit() {
        let old = json!({"site":"https://dev.azure.com/team","project":"Project","account":"Ada","account_id":"ada","token":"secret"});
        let legacy: AzureConfig = serde_json::from_value(old.clone()).unwrap();
        assert_eq!(legacy.status()["capabilities"], json!(["Boards"]));
        let mut current = old;
        current["capabilities"] = json!(["Repos"]);
        let repos: AzureConfig = serde_json::from_value(current).unwrap();
        assert_eq!(repos.status()["capabilities"], json!(["Repos"]));
        assert!(!repos.status().to_string().contains("secret"));
    }

    #[test]
    fn identity_queries_and_response_bounds() {
        assert_eq!(
            normalize_site("https://dev.azure.com/Team/").unwrap(),
            "https://dev.azure.com/team"
        );
        for site in [
            "https://dev.azure.com.evil.test/team",
            "https://user:secret@dev.azure.com/team",
            "https://dev.azure.com/team/project",
            "http://dev.azure.com/team",
            "https://dev.azure.com/team?token=secret",
        ] {
            assert!(normalize_site(site).is_err());
        }
        assert!(project_path("..").is_err());
        assert_eq!(component("Project / A"), "Project%20%2F%20A");
        assert!(query_ids(&json!({"workItemRelations":[]})).is_err());
        assert_eq!(
            query_ids(&json!({"workItems":[{"id":142},{"id":142},{"id":0}]})).unwrap(),
            vec![142]
        );
        assert_eq!(
            query_ids(
                &json!({"workItems":(1..=200).map(|id| json!({"id":id})).collect::<Vec<_>>()})
            )
            .unwrap()
            .len(),
            100
        );
        let mut calls = 0;
        let result = comment_pages(99, |_| {
            calls += 1;
            Ok(json!({"comments":[{"id":calls}],"continuationToken":calls.to_string()}))
        })
        .unwrap();
        assert_eq!(calls, 5);
        assert_eq!(result["comments"].as_array().unwrap().len(), 5);
        let mut calls = 0;
        comment_pages(5, |_| {
            calls += 1;
            Ok(json!({"comments":[{"id":1}],"continuationToken":"same"}))
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert!(http_error(403).contains("Read"));
    }
    #[test]
    fn saved_queries_and_attachments_remain_bounded_and_org_scoped() {
        let mut queries = Vec::new();
        let id = "12345678-1234-1234-1234-123456789abc";
        flatten_queries(
            &[
                json!({"isFolder":true,"children":[{"id":id,"name":"Release queue","queryType":"flat"},{"id":id,"name":"Tree","queryType":"tree"}]}),
            ],
            0,
            &mut queries,
        );
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0]["name"], "Release queue");
        let site = "https://dev.azure.com/team";
        let url = format!("{site}/Product/_apis/wit/attachments/{id}?fileName=checkout.png");
        assert!(attachment_url(site, &url).unwrap().starts_with(site));
        for bad in [
            url.replace("/team/", "/other/"),
            url.replace("dev.azure.com", "evil.test"),
            url.replace("https://", "https://user:secret@"),
            url.replace(id, "not-an-id"),
        ] {
            assert!(attachment_url(site, &bad).is_err());
        }
        let config = AzureConfig {
            site: site.into(),
            project: "Product".into(),
            account: "Ada".into(),
            account_id: "ada-id".into(),
            capabilities: legacy_capabilities(),
            token: "private-token".into(),
        };
        assert!(!config.status().to_string().contains("private-token"));
        let item = json!({"relations":[{"rel":"AttachedFile","url":url,"attributes":{"name":"checkout.png","resourceSize":123}}],"fields":{"System.Description":format!("<img src=\"{url}\"> <img src=\"https://evil.test/private.png\">")}});
        let files = attachments(&config, &item, &[]);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["mimeType"], "image/png");
        assert_eq!(files[0]["size"], 123);
        let comment = json!({"renderedText":format!("<img src=\"{url}\">")});
        let comment_files = attachments(
            &config,
            &json!({"fields":{}}),
            std::slice::from_ref(&comment),
        );
        assert_eq!(comment_files.len(), 1);
        assert_eq!(comment_files[0]["name"], "checkout.png");
        assert_eq!(comment_files[0]["mimeType"], "image/png");
        assert_eq!(attachments(&config, &item, &[comment]).len(), 1);
    }
}
