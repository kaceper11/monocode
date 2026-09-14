use super::{
    expand_home, git_cmd, git_keep_local_for, host_path, local_only_files, local_only_paths,
};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::RwLock;
use std::time::{Duration, Instant};
use tauri::{Manager, State};

// Serializes removal against process startup, not against running agents.
pub(crate) static LIFECYCLE: RwLock<()> = RwLock::new(());

pub(crate) fn path_to_js(path: &Path) -> String {
    let text = super::path_to_js(path);
    // Rust canonicalization uses extended Windows paths; Git's inventory does not.
    if cfg!(windows) {
        if let Some(unc) = text.strip_prefix("//?/UNC/") {
            return format!("//{unc}");
        }
        return text.strip_prefix("//?/").unwrap_or(&text).to_owned();
    }
    text
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    path: String,
    head: String,
    branch: Option<String>,
    locked: Option<String>,
    prunable: Option<String>,
    main: bool,
    missing: bool,
    users: Vec<String>,
    last_used: Option<i64>,
}

// Drain both pipes while retaining at most 1 MiB; hooks are disabled for these
// explicit local operations. A timeout is uncertain, so callers always read back.
fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    if let Some(location) = crate::wsl::path_location(root)? {
        let mut options = vec!["-c", "core.hooksPath=/dev/null"];
        options.extend_from_slice(args);
        let output = crate::wsl::git(&location, &options, None)?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().into());
        }
        if output.stdout.len() > 1024 * 1024 {
            return Err("Git output exceeds 1 MiB".into());
        }
        return String::from_utf8(output.stdout)
            .map_err(|_| "Git returned a non-UTF-8 path".into());
    }
    let mut child = git_cmd()
        .arg("-C")
        .arg(path_to_js(root))
        .args(["-c", "core.hooksPath=/dev/null"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    fn drain(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<(Vec<u8>, bool)> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut buf = [0; 8192];
            let mut truncated = false;
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let keep = n.min((1024 * 1024_usize).saturating_sub(bytes.len()));
                bytes.extend_from_slice(&buf[..keep]);
                truncated |= keep != n;
            }
            (bytes, truncated)
        })
    }
    let out = drain(child.stdout.take().ok_or("Missing stdout")?);
    let err = drain(child.stderr.take().ok_or("Missing stderr")?);
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let (out, truncated) = out.join().map_err(|_| "Git reader failed")?;
    let (err, _) = err.join().map_err(|_| "Git reader failed")?;
    match status {
        None => Err(
            "Git timed out. Refresh worktrees before retrying; the operation may have completed."
                .into(),
        ),
        Some(status) if !status.success() => Err(String::from_utf8_lossy(&err).trim().to_owned()),
        _ if truncated => Err("Git output exceeds 1 MiB; narrow the repository operation.".into()),
        _ => String::from_utf8(out).map_err(|_| "Git returned a non-UTF-8 path".into()),
    }
}

fn inventory(root: &Path) -> Result<Vec<Worktree>, String> {
    let location = crate::wsl::path_location(root)?;
    let text = git(root, &["worktree", "list", "--porcelain", "-z"])?;
    let mut result = Vec::new();
    let mut entry = Worktree::default();
    for field in text.split('\0') {
        if field.is_empty() {
            if !entry.path.is_empty() {
                entry.main = result.is_empty();
                entry.missing = location.is_none() && !Path::new(&entry.path).is_dir();
                if let Some(location) = &location {
                    entry.path = location.with_path(&entry.path)?.identity();
                }
                result.push(entry);
                entry = Worktree::default();
            }
        } else if let Some(path) = field.strip_prefix("worktree ") {
            entry.path = path.to_owned();
        } else if let Some(head) = field.strip_prefix("HEAD ") {
            entry.head = head.to_owned();
        } else if let Some(branch) = field.strip_prefix("branch ") {
            entry.branch = Some(branch.to_owned());
        } else if field == "locked" || field.starts_with("locked ") {
            entry.locked = Some(field.to_owned());
        } else if field == "prunable" || field.starts_with("prunable ") {
            entry.prunable = Some(field.to_owned());
        }
    }
    if location.is_some() {
        let paths = result
            .iter()
            .map(|entry| entry.path.clone())
            .collect::<Vec<_>>();
        let metadata: Vec<serde_json::Value> = crate::wsl::file_batches(&paths, "inspect")?;
        let directories = metadata
            .iter()
            .filter(|item| item["isDir"] == true)
            .filter_map(|item| item["path"].as_str())
            .collect::<std::collections::HashSet<_>>();
        for entry in &mut result {
            entry.missing = !directories.contains(entry.path.as_str());
        }
    }
    Ok(result)
}

pub(super) fn branch_paths(root: &Path) -> Result<HashMap<String, String>, String> {
    Ok(inventory(root)?
        .into_iter()
        .filter_map(|entry| entry.branch.map(|branch| (branch, entry.path)))
        .collect())
}

fn canonical(path: &str) -> Result<String, String> {
    if let Some(location) = crate::wsl::location(path)? {
        return crate::wsl::path_request(&location, "canonical", serde_json::json!({}));
    }
    expand_home(path)
        .canonicalize()
        .map(|p| path_to_js(&p))
        .map_err(|e| e.to_string())
}

fn qualify(root: &Path, path: &str) -> Result<String, String> {
    match crate::wsl::path_location(root)? {
        Some(location) => Ok(location.with_path(path)?.identity()),
        None => Ok(path.into()),
    }
}

fn git_path(root: &Path, path: &str) -> Result<String, String> {
    match (
        crate::wsl::path_location(root)?,
        crate::wsl::location(path)?,
    ) {
        (Some(root), Some(target))
            if root.distribution.eq_ignore_ascii_case(&target.distribution) =>
        {
            Ok(target.path)
        }
        (None, None) => Ok(path.into()),
        _ => Err("Repository and worktree must be on the same execution host".into()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFamily {
    common_dir: String,
    checkout: String,
    worktrees: Vec<Worktree>,
    /// Root commit — stable across clones of the same lineage, so separate
    /// checkouts that share no .git still land in one collision domain.
    /// Absent on unborn heads and divergent shallow clones.
    identity: Option<String>,
}

/// Shared Git metadata identifies linked checkouts; the root commit ties
/// together clones that share no common dir (remotes do not identify clones).
#[tauri::command(async)]
pub fn git_repository_family(cwd: String) -> Result<RepositoryFamily, String> {
    let root = expand_home(&cwd);
    let common = git(
        &root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let checkout = git(&root, &["rev-parse", "--show-toplevel"])?;
    let identity = git(&root, &["rev-list", "--max-parents=0", "HEAD"])
        .ok()
        .and_then(|text| text.lines().next().map(str::to_string));
    Ok(RepositoryFamily {
        common_dir: canonical(&qualify(&root, common.trim_end_matches(['\r', '\n']))?)?,
        checkout: canonical(&qualify(&root, checkout.trim_end_matches(['\r', '\n']))?)?,
        worktrees: inventory(&root)?,
        identity,
    })
}

#[tauri::command(async)]
pub fn git_worktrees(
    cwd: String,
    store: State<crate::session_store::SessionStore>,
) -> Result<Vec<Worktree>, String> {
    let mut entries = inventory(&expand_home(&cwd))?;
    add_session_activity(&mut entries, &store)?;
    Ok(entries)
}

/// Files committed on HEAD since the merge-base with the default branch —
/// the landed half of "did a sibling already touch this path". Working-tree
/// changes are covered by `git_diff_files`; absent a default branch there is
/// nothing to compare, so the answer is honestly empty.
#[tauri::command]
pub async fn git_branch_changed_files(cwd: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let remote = super::git_remote_name(&root);
        let Some(base_name) = super::git_default_branch(&root, remote.as_deref()) else {
            return Ok(Vec::new());
        };
        let Some(base_ref) = super::git_target_ref(&root, &base_name, remote.as_deref()) else {
            return Ok(Vec::new());
        };
        let spec = format!("{base_ref}...HEAD");
        let text = git(&root, &["diff", "--name-only", "--no-ext-diff", &spec])?;
        Ok(text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

const ACTIVITY_QUERY: &str = "SELECT id, title, updated_at FROM sessions WHERE COALESCE(NULLIF(worktree_cwd, ''), cwd) = ?1 AND has_user_message = 1 AND archived = 0 ORDER BY updated_at DESC LIMIT 100";

fn add_session_activity(
    entries: &mut [Worktree],
    store: &crate::session_store::SessionStore,
) -> Result<(), String> {
    let conn = store.lock_conn()?;
    let mut stmt = conn.prepare(ACTIVITY_QUERY).map_err(|e| e.to_string())?;
    for entry in entries {
        let rows = stmt
            .query_map([&entry.path], |r| {
                Ok((
                    format!("{} ({})", r.get::<_, String>(1)?, r.get::<_, String>(0)?),
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let rows = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        entry.last_used = rows.first().map(|(_, at)| *at);
        entry.users = rows.into_iter().map(|(user, _)| user).collect();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRef {
    name: String,
    commit: String,
}

#[tauri::command(async)]
pub fn git_worktree_refs(cwd: String) -> Result<Vec<WorktreeRef>, String> {
    git(
        &expand_home(&cwd),
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads",
            "refs/remotes",
        ],
    )?
    .lines()
    .map(|line| {
        let (name, commit) = line.split_once(' ').ok_or("Invalid Git ref")?;
        Ok(WorktreeRef {
            name: name.into(),
            commit: commit.into(),
        })
    })
    .collect()
}

fn create(
    root: &Path,
    base: &str,
    commit: &str,
    branch: &str,
    path: &str,
) -> Result<String, String> {
    if !base.starts_with("refs/heads/") && !base.starts_with("refs/remotes/") {
        return Err("Choose an explicit local or remote-tracking ref".into());
    }
    let actual = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{base}^{{commit}}"),
        ],
    )?;
    if actual.trim() != commit {
        return Err("Base ref changed. Refresh and review its commit again.".into());
    }
    if branch.starts_with('-') || branch.trim() != branch {
        return Err("Invalid branch name".into());
    }
    git(root, &["check-ref-format", &format!("refs/heads/{branch}")])?;
    git_path(root, path)?;
    let target = if let Some(location) = crate::wsl::location(path)? {
        crate::wsl::path_request(&location, "new_path", serde_json::json!({}))?
    } else {
        let target = expand_home(path);
        if !target.is_absolute() || target.exists() {
            return Err(
                "Choose a new absolute worktree path; existing paths are preserved.".into(),
            );
        }
        let parent = target
            .parent()
            .ok_or("Missing parent directory")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let target = parent.join(target.file_name().ok_or("Missing directory name")?);
        path_to_js(&target)
    };
    let linux_target = git_path(root, &target)?;
    let result = git(
        root,
        &["worktree", "add", "-b", branch, "--", &linux_target, commit],
    );
    let entries = inventory(root)?;
    if entries.iter().any(|e| {
        e.path == target
            && e.head == commit
            && e.branch.as_deref() == Some(&format!("refs/heads/{branch}"))
    }) {
        seed_local_only(root, Path::new(&target));
        return Ok(target);
    }
    result?;
    Err(format!(
        "Creation could not be confirmed. Refresh and inspect {target}; no data was removed."
    ))
}

/// Cap for a carried file — matches the WSL bridge's `restore_bytes` limit.
const MAX_SEED_BYTES: usize = 8 * 1024 * 1024;

/// Carry the source worktree's keep-local files into a freshly created one.
/// Each worktree owns its index, so skip-worktree flags never propagate on
/// their own — the file bytes are copied and re-flagged in the new checkout.
/// Best-effort: a file that can't be carried is skipped and simply absent
/// from the new worktree's "Local only" list. Symlinks and other non-regular
/// files copy as the plain bytes they resolve to.
fn seed_local_only(source: &Path, target: &Path) {
    for file in local_only_files(source, local_only_paths(source)) {
        // A kept file deleted on disk has nothing to carry.
        if file.status == "deleted" {
            continue;
        }
        if let Err(error) = seed_local_only_file(source, target, &file.relative) {
            eprintln!(
                "monocode: could not carry kept-local {} into {}: {error}",
                file.relative,
                path_to_js(target)
            );
        }
    }
}

fn seed_local_only_file(source: &Path, target: &Path, relative: &str) -> Result<(), String> {
    let src = host_path(source, relative);
    let dst = host_path(target, relative);
    let data = if let Some(location) = crate::wsl::path_location(&src)? {
        use base64::Engine;
        let text: String = crate::wsl::request(
            &location,
            "read",
            serde_json::json!({"limit": MAX_SEED_BYTES}),
        )?;
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(|e| e.to_string())?
    } else {
        let meta = std::fs::metadata(&src).map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() as usize > MAX_SEED_BYTES {
            return Err("not a regular file or exceeds 8 MiB".into());
        }
        std::fs::read(&src).map_err(|e| e.to_string())?
    };
    if let Some(location) = crate::wsl::path_location(&dst)? {
        use base64::Engine;
        crate::wsl::request::<serde_json::Value>(
            &location,
            "restore_bytes",
            serde_json::json!({"data": base64::engine::general_purpose::STANDARD.encode(&data)}),
        )?;
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&dst, &data).map_err(|e| e.to_string())?;
    }
    git_keep_local_for(target, relative)
}

#[tauri::command(async)]
pub fn git_worktree_create(
    cwd: String,
    base: String,
    commit: String,
    branch: String,
    path: String,
) -> Result<String, String> {
    let _guard = LIFECYCLE
        .try_write()
        .map_err(|_| "Another worktree operation or process startup is in progress")?;
    create(&expand_home(&cwd), &base, &commit, &branch, &path)
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalPreview {
    token: String,
    file_count: usize,
    files: Vec<String>,
}

fn removal_entry(root: &Path, path: &str) -> Result<(String, Worktree), String> {
    let family = git_repository_family(path_to_js(root))?;
    let entry = family
        .worktrees
        .into_iter()
        .find(|e| e.path == path)
        .ok_or("Worktree is no longer registered; refresh")?;
    if entry.main
        || entry.branch.is_none()
        || entry.missing
        || entry.locked.is_some()
        || entry.prunable.is_some()
        || canonical(path)? != path
    {
        return Err("This worktree cannot be force removed. Refresh or repair with Git.".into());
    }
    let target_common = git(
        Path::new(path),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let target_root = git(Path::new(path), &["rev-parse", "--show-toplevel"])?;
    if canonical(&qualify(
        root,
        target_common.trim_end_matches(['\r', '\n']),
    )?)? != family.common_dir
        || canonical(&qualify(root, target_root.trim_end_matches(['\r', '\n']))?)? != path
    {
        return Err("Worktree identity changed; refresh and review again".into());
    }
    Ok((family.common_dir, entry))
}

// Force review fingerprints metadata — name, type, mode, size and mtime per
// entry — so trees of any byte size review in stat time. A write between
// review and removal changes mtime or size, so the token still binds the
// reviewed tree to the destructive call; only the entry count and walk time
// are bounded.
fn removal_preview(root: &Path, path: &str, include_files: bool) -> Result<RemovalPreview, String> {
    use std::hash::{Hash, Hasher};
    let (common_dir, entry) = removal_entry(root, path)?;
    let mut digest = std::collections::hash_map::DefaultHasher::new();
    common_dir.hash(&mut digest);
    entry.path.hash(&mut digest);
    entry.head.hash(&mut digest);
    entry.branch.hash(&mut digest);
    // Includes index state, even if staged content changes without changing status.
    git(
        Path::new(path),
        &["diff", "--cached", "--no-ext-diff", "--binary", "HEAD"],
    )?
    .hash(&mut digest);
    if let Some(location) = crate::wsl::location(path)? {
        let mut review: RemovalPreview = crate::wsl::request(
            &location,
            "worktree_review",
            serde_json::json!({"includeFiles": include_files}),
        )?;
        review.token.hash(&mut digest);
        review.token = format!("{:016x}", digest.finish());
        return Ok(review);
    }
    let start = Instant::now();
    let mut pending = vec![std::path::PathBuf::from(path)];
    let mut count = 0;
    let mut files = Vec::new();
    while let Some(current) = pending.pop() {
        if start.elapsed() > Duration::from_secs(30) || count >= 250_000 {
            return Err(
                "Force review exceeds 250,000 entries or 30 seconds. Clean up with Git instead."
                    .into(),
            );
        }
        count += 1;
        current
            .strip_prefix(path)
            .map_err(|e| e.to_string())?
            .hash(&mut digest);
        let meta = std::fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
        meta.permissions().readonly().hash(&mut digest);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            meta.mode().hash(&mut digest);
        }
        meta.modified()
            .map_err(|e| e.to_string())?
            .hash(&mut digest);
        if meta.is_symlink() {
            std::fs::read_link(&current)
                .map_err(|e| e.to_string())?
                .hash(&mut digest);
        } else if meta.is_dir() {
            let mut children = Vec::new();
            for child in std::fs::read_dir(&current).map_err(|e| e.to_string())? {
                let child = child.map_err(|e| e.to_string())?;
                if current == Path::new(path) && child.file_name() == ".git" {
                    continue;
                }
                if children.len() + pending.len() + count >= 250_000 {
                    return Err(
                        "Force review exceeds 250,000 entries. Clean up with Git instead.".into(),
                    );
                }
                children.push(child.path());
            }
            children.sort();
            pending.extend(children);
        } else if meta.is_file() {
            meta.len().hash(&mut digest);
        } else {
            return Err(
                "Special files cannot be reviewed safely. Clean up with Git instead.".into(),
            );
        }
        if !meta.is_dir() && include_files && files.len() < 100 {
            files.push(
                current
                    .strip_prefix(path)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    Ok(RemovalPreview {
        token: format!("{:016x}", digest.finish()),
        file_count: count - 1,
        files,
    })
}

#[tauri::command(async)]
pub fn git_worktree_removal_preview(
    cwd: String,
    path: String,
    include_files: bool,
) -> Result<RemovalPreview, String> {
    removal_preview(&expand_home(&cwd), &path, include_files)
}

/// Every check that must pass before the destructive call. Returns the
/// family's common Git dir — it outlives removal of any member, so execution
/// and the post-remove confirmation run through a context that survives even
/// when the caller was sitting inside the removed checkout.
fn removal_checks(
    root: &Path,
    path: &str,
    head: &str,
    reviewed: Option<&str>,
) -> Result<String, String> {
    let (common_dir, entry) = removal_entry(root, path)?;
    if entry.head != head {
        return Err("Worktree HEAD changed; refresh and review again".into());
    }
    if canonical(path)? != path {
        return Err("Worktree path changed or is a symlink; refresh".into());
    }
    if let Some(reviewed) = reviewed {
        if removal_preview(root, path, false)?.token != reviewed {
            return Err("Worktree files or identity changed; refresh and review again".into());
        }
    } else if !git(
        Path::new(path),
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignored",
        ],
    )?
    .trim()
    .is_empty()
    {
        return Err(
            "Worktree has modified, untracked or ignored files; all files are preserved.".into(),
        );
    }
    Ok(common_dir)
}

fn execute_removal(common_dir: &str, path: &str, force: bool) -> Result<(), String> {
    let context = Path::new(common_dir);
    let target = git_path(context, path)?;
    let result = if force {
        git(context, &["worktree", "remove", "--force", "--", &target])
    } else {
        git(context, &["worktree", "remove", "--", &target])
    };
    if !inventory(context)?.iter().any(|e| e.path == path) {
        return Ok(());
    }
    result?;
    Err("Removal could not be confirmed; refresh before retrying".into())
}

#[cfg(test)]
fn remove(root: &Path, path: &str, head: &str) -> Result<(), String> {
    remove_reviewed(root, path, head, None)
}

#[cfg(test)]
fn remove_reviewed(
    root: &Path,
    path: &str,
    head: &str,
    reviewed: Option<&str>,
) -> Result<(), String> {
    let common_dir = removal_checks(root, path, head, reviewed)?;
    execute_removal(&common_dir, path, reviewed.is_some())
}

#[tauri::command(async)]
pub fn git_worktree_remove(
    app: tauri::AppHandle,
    cwd: String,
    path: String,
    head: String,
    reviewed: Option<String>,
    stop_processes: Option<bool>,
) -> Result<(), String> {
    let _guard = LIFECYCLE
        .try_write()
        .map_err(|_| "Another worktree operation or process startup is in progress")?;
    let root = expand_home(&cwd);
    // Everything that can still fail is checked before any process is stopped.
    let mut common_dir = removal_checks(&root, &path, &head, reviewed.as_deref())?;
    let bound = super::occupancy::bound_processes(&app, &path);
    if !bound.is_empty() {
        if !stop_processes.unwrap_or(false) {
            return Err(format!(
                "Work is still running in this worktree: {}. Open it or choose Stop and remove; nothing was removed.",
                bound
                    .iter()
                    .map(|process| process.label.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        super::occupancy::stop_bound(&app, &bound)?;
        // Fail closed: anything still bound after the stop — a process that
        // refused to die or one a future host reports — blocks removal.
        let remaining = super::occupancy::bound_processes(&app, &path);
        if !remaining.is_empty() {
            return Err(format!(
                "Work is still running in this worktree: {}. Review it, then retry; nothing was removed.",
                remaining
                    .iter()
                    .map(|process| process.label.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        // Stopped work may have written during shutdown; the earlier snapshot
        // cannot be trusted for the destructive call.
        common_dir = removal_checks(&root, &path, &head, reviewed.as_deref())?;
    }
    execute_removal(&common_dir, &path, reviewed.is_some())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSafety {
    /// Execution host of this repository family: `macos`/`windows`/`linux` or
    /// `wsl:<distribution>`.
    host: String,
    /// Fresh inventory entry for the reviewed target, with recorded use.
    entry: Worktree,
    dirty: bool,
    /// Agents and terminals bound to the target checkout at preflight time.
    processes: Vec<super::occupancy::BoundProcess>,
    /// Usable alternative checkouts for the switch-away fallback, in
    /// inventory order; the frontend ranks them by recorded use.
    siblings: Vec<Worktree>,
}

/// On-demand detail only; deletion always performs its own fresh safety checks.
#[tauri::command(async)]
pub fn git_worktree_safety(
    app: tauri::AppHandle,
    cwd: String,
    path: String,
) -> Result<WorktreeSafety, String> {
    let root = expand_home(&cwd);
    let host = crate::wsl::path_location(&root)?
        .map(|location| format!("wsl:{}", location.distribution))
        .unwrap_or_else(|| std::env::consts::OS.into());
    let mut entries = inventory(&root)?;
    add_session_activity(
        &mut entries,
        &app.state::<crate::session_store::SessionStore>(),
    )?;
    let entry = entries
        .iter()
        .find(|entry| entry.path == path)
        .cloned()
        .ok_or("Worktree is no longer registered. Refresh.")?;
    if entry.missing || entry.prunable.is_some() {
        return Err("This working copy is unavailable. Restore its original location or repair its Git registration, then retry.".into());
    }
    let dirty = !git(
        &expand_home(&path),
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignored",
        ],
    )?
    .trim()
    .is_empty();
    Ok(WorktreeSafety {
        host,
        dirty,
        processes: super::occupancy::bound_processes(&app, &path),
        siblings: entries
            .into_iter()
            .filter(|entry| entry.path != path && !entry.missing && entry.prunable.is_none())
            .collect(),
        entry,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    #[cfg(unix)]
    pub(crate) fn verify_wsl_force_removal(root: &str, child: &str, head: &str) {
        let location = crate::wsl::location(child).unwrap().unwrap();
        let file = location
            .with_path(&format!("{}/dirty ż.txt", location.path))
            .unwrap();
        let write = |text: &str| {
            crate::wsl::request::<serde_json::Value>(
                &file,
                "write_text",
                serde_json::json!({"content": text}),
            )
            .unwrap()
        };
        write("first");
        assert!(remove(Path::new(root), child, head).is_err());
        let before = removal_preview(Path::new(root), child, false).unwrap();
        assert!(before.files.is_empty());
        let details = removal_preview(Path::new(root), child, true).unwrap();
        assert_eq!(before.token, details.token);
        assert!(details.files.contains(&"dirty ż.txt".into()));
        write("changed");
        assert!(
            remove_reviewed(Path::new(root), child, head, Some(&before.token))
                .unwrap_err()
                .contains("changed")
        );
        let reviewed = removal_preview(Path::new(root), child, false).unwrap();
        remove_reviewed(Path::new(root), child, head, Some(&reviewed.token)).unwrap();
        assert!(!inventory(Path::new(root))
            .unwrap()
            .iter()
            .any(|entry| entry.path == child));
        assert_eq!(
            git(Path::new(root), &["rev-parse", "refs/heads/child-branch"])
                .unwrap()
                .trim(),
            head
        );
    }

    #[test]
    fn activity_query_uses_index_without_scanning_or_sorting() {
        let repo = Repo::new();
        let path = repo.0.join("sessions.db");
        let store = crate::session_store::SessionStore::open(path.clone()).unwrap();
        // Simulate a database previously opened by a build without this index.
        store
            .lock_conn()
            .unwrap()
            .execute_batch("DROP INDEX sessions_worktree_activity_idx")
            .unwrap();
        drop(store);
        let store = crate::session_store::SessionStore::open(path).unwrap();
        let conn = store.lock_conn().unwrap();
        let mut query = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {ACTIVITY_QUERY}"))
            .unwrap();
        let plan = query
            .query_map(["/child"], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join(" ");
        assert!(
            plan.contains("SEARCH sessions USING")
                && plan.contains("sessions_worktree_activity_idx"),
            "{plan}"
        );
        assert!(
            !plan.contains("SCAN") && !plan.contains("TEMP B-TREE"),
            "{plan}"
        );
    }

    #[test]
    fn activity_uses_effective_checkout_and_bounds_retained_users() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        {
            let conn = store.lock_conn().unwrap();
            for index in 1..=110 {
                conn.execute("INSERT INTO sessions (id,cwd,worktree_cwd,harness,model,runtime_mode,title,created_at,updated_at,has_user_message) VALUES (?1,'/main','/child','codex','test','supervised','fixture',1,?2,1)", rusqlite::params![format!("s{index}"), index]).unwrap();
            }
            // Archived sessions are neither live evidence nor peer labels.
            conn.execute("INSERT INTO sessions (id,cwd,worktree_cwd,harness,model,runtime_mode,title,created_at,updated_at,has_user_message,archived) VALUES ('archived-1','/main','/child','codex','test','supervised','archived',1,999,1,1)", []).unwrap();
        }
        let mut entries = vec![
            Worktree {
                path: "/main".into(),
                ..Default::default()
            },
            Worktree {
                path: "/child".into(),
                ..Default::default()
            },
        ];
        add_session_activity(&mut entries, &store).unwrap();
        assert_eq!(entries[0].last_used, None);
        assert_eq!(entries[1].last_used, Some(110));
        assert!(entries[1]
            .users
            .iter()
            .all(|user| !user.contains("archived-1")));

        assert_eq!(entries[1].users.len(), 100);
        assert!(entries[1].users[0].ends_with("(s110)"));
        assert_eq!(
            store
                .lock_conn()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            111
        );
    }

    struct Repo(PathBuf);
    impl Repo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "monocode-worktree-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            let path = path.canonicalize().unwrap();
            git(&path, &["init", "-b", "main"]).unwrap();
            git(&path, &["config", "user.name", "Test"]).unwrap();
            git(&path, &["config", "user.email", "test@example.invalid"]).unwrap();
            git(
                &path,
                &[
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--allow-empty",
                    "-m",
                    "base",
                ],
            )
            .unwrap();
            Self(path)
        }
        fn head(&self) -> String {
            git(&self.0, &["rev-parse", "HEAD"]).unwrap().trim().into()
        }
        fn target(&self, name: &str) -> String {
            path_to_js(&self.0.join(name))
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn family_groups_linked_checkouts_but_not_clones() {
        let repo = Repo::new();
        let child = repo.target("linked żółć space");
        create(&repo.0, "refs/heads/main", &repo.head(), "child", &child).unwrap();
        let parent = git_repository_family(path_to_js(&repo.0)).unwrap();
        let linked = git_repository_family(child.clone()).unwrap();
        assert_eq!(parent.common_dir, linked.common_dir);
        assert_eq!(linked.checkout, child);
        assert_eq!(linked.worktrees.len(), 2);
        let clone = repo.target("independent clone");
        git(&repo.0, &["clone", "--no-hardlinks", ".", &clone]).unwrap();
        assert_ne!(
            parent.common_dir,
            git_repository_family(clone).unwrap().common_dir
        );
        assert!(git_repository_family(repo.target("missing")).is_err());
    }

    #[test]
    fn selected_bases_unicode_collisions_and_external_discovery() {
        let repo = Repo::new();
        let base = repo.head();
        git(&repo.0, &["branch", "non-default"]).unwrap();
        git(&repo.0, &["update-ref", "refs/remotes/second/topic", &base]).unwrap();
        let first = repo.target("space żółć");
        let second = repo.target("second");
        assert_eq!(
            create(&repo.0, "refs/heads/non-default", &base, "task/one", &first).unwrap(),
            first
        );
        assert!(create(&repo.0, "refs/heads/non-default", &base, "task/one", &first).is_err());
        create(
            &repo.0,
            "refs/remotes/second/topic",
            &base,
            "task/two",
            &second,
        )
        .unwrap();
        git(
            &repo.0,
            &[
                "worktree",
                "add",
                "--detach",
                &repo.target("external"),
                &base,
            ],
        )
        .unwrap();
        let entries = inventory(&repo.0).unwrap();
        assert_eq!(entries.len(), 4);
        assert!(entries.iter().all(|e| e.head == base));
        assert!(entries.iter().any(|e| e.branch.is_none() && !e.main));
        let other = Repo::new();
        create(
            &other.0,
            "refs/heads/main",
            &other.head(),
            "task/one",
            &other.target("space żółć"),
        )
        .unwrap();
        assert_eq!(inventory(&other.0).unwrap().len(), 2);
        assert!(create(
            &repo.0,
            "refs/heads/main",
            "stale",
            "another",
            &repo.target("unused")
        )
        .is_err());
        assert!(create(&repo.0, "--bad", &base, "another", &repo.target("unused")).is_err());
    }

    #[test]
    fn create_carries_keep_local_files_into_the_new_worktree() {
        let repo = Repo::new();
        std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
        git(&repo.0, &["add", "tracked.txt"]).unwrap();
        git(&repo.0, &["commit", "-m", "file"]).unwrap();
        std::fs::write(repo.0.join("tracked.txt"), "base\nlocal\n").unwrap();
        std::fs::write(repo.0.join("dev.local"), "secret=1\n").unwrap();
        std::fs::create_dir_all(repo.0.join("conf.d")).unwrap();
        std::fs::write(repo.0.join("conf.d/dev.yaml"), "x: 1\n").unwrap();
        crate::fs::git_keep_local_for(&repo.0, "tracked.txt").unwrap();
        crate::fs::git_keep_local_for(&repo.0, "dev.local").unwrap();
        crate::fs::git_keep_local_for(&repo.0, "conf.d/dev.yaml").unwrap();

        let child = repo.target("child-copy");
        create(&repo.0, "refs/heads/main", &repo.head(), "child", &child).unwrap();

        // Bytes carried over — including a file nested under a new directory.
        let child_path = Path::new(&child);
        assert_eq!(
            std::fs::read_to_string(child_path.join("tracked.txt")).unwrap(),
            "base\nlocal\n"
        );
        assert_eq!(
            std::fs::read_to_string(child_path.join("dev.local")).unwrap(),
            "secret=1\n"
        );
        assert_eq!(
            std::fs::read_to_string(child_path.join("conf.d/dev.yaml")).unwrap(),
            "x: 1\n"
        );
        // And all of them are flagged in the child's own index, so they can
        // never be committed or pushed from the new worktree either.
        let index = crate::fs::git_diff_index_for(child_path);
        assert!(index.files.is_empty());
        let mut kept: Vec<&str> = index
            .local_only
            .iter()
            .map(|file| file.relative.as_str())
            .collect();
        kept.sort();
        assert_eq!(kept, ["conf.d/dev.yaml", "dev.local", "tracked.txt"]);
        // The source worktree's own keep-local state is untouched (the new
        // worktree's directory inside the repo shows as a plain untracked
        // `child-copy/` entry, not a kept file).
        let source = crate::fs::git_diff_index_for(&repo.0);
        assert_eq!(source.local_only.len(), 3);
        assert!(source
            .files
            .iter()
            .all(|file| file.relative.starts_with("child-copy")));
    }

    #[test]
    fn force_requires_current_review_and_preserves_branches_and_siblings() {
        let repo = Repo::new();
        let head = repo.head();
        let path = repo.target("dirty space ż");
        let sibling = repo.target("sibling");
        create(&repo.0, "refs/heads/main", &head, "dirty", &path).unwrap();
        create(&repo.0, "refs/heads/main", &head, "sibling", &sibling).unwrap();
        let target = Path::new(&path);
        std::fs::write(target.join("tracked"), "base").unwrap();
        git(target, &["add", "tracked"]).unwrap();
        git(
            target,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "tracked",
            ],
        )
        .unwrap();
        let head = git(target, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();
        std::fs::write(target.join("tracked"), "staged").unwrap();
        git(target, &["add", "tracked"]).unwrap();
        std::fs::write(target.join("tracked"), "unstaged").unwrap();
        std::fs::write(repo.0.join(".git/info/exclude"), "ignored\n").unwrap();
        std::fs::write(target.join("ignored"), "keep ignored").unwrap();
        std::fs::write(target.join("untracked"), "keep untracked").unwrap();
        assert!(remove(&repo.0, &path, &head).is_err());
        let first = removal_preview(&repo.0, &path, false).unwrap();
        assert!(first.files.is_empty());
        let details = removal_preview(&repo.0, &path, true).unwrap();
        assert_eq!(first.token, details.token);
        assert!(details.files.contains(&"ignored".to_owned()));
        std::fs::write(target.join("untracked"), "new content").unwrap();
        assert!(remove_reviewed(&repo.0, &path, &head, Some(&first.token))
            .unwrap_err()
            .contains("changed"));
        assert!(target.exists());
        let reviewed = removal_preview(&repo.0, &path, false).unwrap();
        assert!(remove_reviewed(&repo.0, &path, "stale head", Some(&reviewed.token)).is_err());
        assert!(remove_reviewed(&repo.0, &sibling, &repo.head(), Some(&reviewed.token)).is_err());
        assert!(removal_preview(&repo.0, &path_to_js(&repo.0), false).is_err());
        git(&repo.0, &["worktree", "lock", &path]).unwrap();
        assert!(remove_reviewed(&repo.0, &path, &head, Some(&reviewed.token)).is_err());
        git(&repo.0, &["worktree", "unlock", &path]).unwrap();
        remove_reviewed(&repo.0, &path, &head, Some(&reviewed.token)).unwrap();
        assert!(!target.exists());
        assert!(Path::new(&sibling).exists());
        assert_eq!(
            git(&repo.0, &["rev-parse", "refs/heads/dirty"])
                .unwrap()
                .trim(),
            head
        );
        assert!(remove_reviewed(&repo.0, &path, &head, Some(&reviewed.token)).is_err());
    }

    #[test]
    fn force_review_handles_large_files_and_never_follows_symlinks() {
        let repo = Repo::new();
        let path = repo.target("bounded");
        create(&repo.0, "refs/heads/main", &repo.head(), "bounded", &path).unwrap();
        // Byte size is not bounded: the fingerprint is metadata, so a sparse
        // file larger than the old 64 MiB cap still reviews.
        let file = Path::new(&path).join("large");
        std::fs::File::create(&file)
            .unwrap()
            .set_len(64 * 1024 * 1024 + 1)
            .unwrap();
        let reviewed = removal_preview(&repo.0, &path, false).unwrap();
        // A post-review write moves size/mtime — the reviewed token no longer
        // matches and removal refuses.
        std::fs::write(&file, "changed same-slot write").unwrap();
        assert!(remove_reviewed(&repo.0, &path, &repo.head(), Some(&reviewed.token)).is_err());
        std::fs::remove_file(&file).unwrap();
        #[cfg(unix)]
        {
            let outside = repo.0.join("outside");
            std::fs::write(&outside, "keep").unwrap();
            std::os::unix::fs::symlink(&outside, Path::new(&path).join("link")).unwrap();
            let reviewed = removal_preview(&repo.0, &path, false).unwrap();
            remove_reviewed(&repo.0, &path, &repo.head(), Some(&reviewed.token)).unwrap();
            assert_eq!(std::fs::read_to_string(outside).unwrap(), "keep");
        }
    }

    #[test]
    fn cleanup_preserves_files_branch_and_exact_target() {
        let repo = Repo::new();
        let head = repo.head();
        let path = repo.target("work");
        create(&repo.0, "refs/heads/main", &head, "keep-branch", &path).unwrap();
        assert!(remove(&repo.0, &path_to_js(&repo.0), &head).is_err());
        assert!(remove(&repo.0, &repo.target("unregistered"), &head).is_err());
        assert!(remove(&repo.0, &path, "stale").is_err());
        std::fs::write(repo.0.join(".git/info/exclude"), ".env\n").unwrap();
        std::fs::write(Path::new(&path).join(".env"), "keep me").unwrap();
        assert!(remove(&repo.0, &path, &head).is_err());
        assert_eq!(
            std::fs::read_to_string(Path::new(&path).join(".env")).unwrap(),
            "keep me"
        );
        std::fs::remove_file(Path::new(&path).join(".env")).unwrap();
        git(&repo.0, &["worktree", "lock", &path]).unwrap();
        assert!(remove(&repo.0, &path, &head).is_err());
        git(&repo.0, &["worktree", "unlock", &path]).unwrap();
        remove(&repo.0, &path, &head).unwrap();
        assert!(!Path::new(&path).exists());
        assert!(git(&repo.0, &["show-ref", "--verify", "refs/heads/keep-branch"]).is_ok());
        assert_eq!(inventory(&repo.0).unwrap().len(), 1);
    }

    #[test]
    fn removal_runs_through_a_surviving_context() {
        let repo = Repo::new();
        let head = repo.head();
        let path = repo.target("self-context");
        create(&repo.0, "refs/heads/main", &head, "self", &path).unwrap();
        // The caller may be sitting inside the removed checkout; the common
        // Git dir carries the removal and the post-remove confirmation.
        remove(Path::new(&path), &path, &head).unwrap();
        assert!(!Path::new(&path).exists());
        assert!(git(&repo.0, &["show-ref", "--verify", "refs/heads/self"]).is_ok());
        assert_eq!(inventory(&repo.0).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn switch_away_removal_stops_only_bound_work_on_a_real_repo() {
        // The `git_worktree_remove` command sequence, exercised at the owning
        // boundary: fresh checks, scoped occupancy evidence, explicit stop,
        // re-check, then removal through the surviving common Git dir.
        let repo = Repo::new();
        let head = repo.head();
        let path = repo.target("busy target");
        let sibling = repo.target("healthy sibling");
        create(&repo.0, "refs/heads/main", &head, "busy", &path).unwrap();
        create(&repo.0, "refs/heads/main", &head, "sibling", &sibling).unwrap();

        let harness = crate::harness::HarnessHost::new();
        let pty = crate::pty::PtyHost::new();
        let mut inside = harness.add_test_child("agent-in-target", &path);
        let mut outside = harness.add_test_child("agent-in-sibling", &sibling);
        // Real children are reaped by their owner threads; an unwaited test
        // child would stay a zombie and answer kill(pid, 0) during the wait.
        std::thread::spawn(move || {
            let _ = inside.wait();
        });

        let common_dir = removal_checks(&repo.0, &path, &head, None).unwrap();
        let bound = crate::fs::occupancy::collect(&harness, &pty, None, &path);
        assert_eq!(
            bound.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["agent-in-target"]
        );

        crate::fs::occupancy::stop_processes(&harness, &pty, &bound).unwrap();
        assert!(harness
            .live_cwds()
            .iter()
            .all(|(id, _)| id != "agent-in-target"));

        // Stopped work may have changed files, so checks run again before
        // the destructive call — the same order the command enforces.
        let common_dir = removal_checks(&repo.0, &path, &head, None).unwrap_or_else(|_| {
            panic!("clean tree still passes after stop; first context {common_dir}")
        });
        execute_removal(&common_dir, &path, false).unwrap();

        assert!(!Path::new(&path).exists());
        assert!(Path::new(&sibling).exists());
        assert_eq!(inventory(&repo.0).unwrap().len(), 2);
        assert!(git(&repo.0, &["show-ref", "--verify", "refs/heads/busy"]).is_ok());
        assert_eq!(
            harness
                .live_cwds()
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["agent-in-sibling"]
        );

        let _ = outside.kill();
        let _ = outside.wait();
    }

    #[test]
    fn missing_detached_and_moved_refs_require_explicit_recovery() {
        let repo = Repo::new();
        let head = repo.head();
        let path = repo.target("detached");
        git(&repo.0, &["worktree", "add", "--detach", &path, &head]).unwrap();
        assert!(remove(&repo.0, &path, &head).is_err());
        std::fs::remove_dir_all(&path).unwrap();
        let entries = inventory(&repo.0).unwrap();
        assert!(entries
            .iter()
            .any(|e| e.path == path && e.missing && e.prunable.is_some()));
        assert!(remove(&repo.0, &path, &head).is_err());
        git(
            &repo.0,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "moved",
            ],
        )
        .unwrap();
        assert!(create(
            &repo.0,
            "refs/heads/main",
            &head,
            "stale",
            &repo.target("new")
        )
        .is_err());
        assert!(!Path::new(&repo.target("new")).exists());
    }

    #[test]
    #[ignore = "release measurement, run with --release --ignored --nocapture"]
    fn inventory_release_measurement() {
        let repo = Repo::new();
        let head = repo.head();
        for n in 0..10 {
            create(
                &repo.0,
                "refs/heads/main",
                &head,
                &format!("task-{n}"),
                &repo.target(&format!("work-{n}")),
            )
            .unwrap();
        }
        let mut samples = Vec::new();
        for _ in 0..21 {
            let start = Instant::now();
            assert_eq!(inventory(&repo.0).unwrap().len(), 11);
            samples.push(start.elapsed());
        }
        samples.sort();
        println!(
            "11 worktrees, 21 inventory calls: median {:?}, max {:?}",
            samples[10], samples[20]
        );
        samples.clear();
        for _ in 0..21 {
            let start = Instant::now();
            assert_eq!(
                git_repository_family(path_to_js(&repo.0))
                    .unwrap()
                    .worktrees
                    .len(),
                11
            );
            samples.push(start.elapsed());
        }
        samples.sort();
        println!(
            "11 worktrees, 21 verified family calls: median {:?}, max {:?}",
            samples[10], samples[20]
        );
        let target = repo.target("work-0");
        for index in 0..64 {
            std::fs::write(
                Path::new(&target).join(format!("file-{index}")),
                vec![b'x'; 4096],
            )
            .unwrap();
        }
        samples.clear();
        for _ in 0..21 {
            let start = Instant::now();
            assert!(removal_preview(&repo.0, &target, false)
                .unwrap()
                .files
                .is_empty());
            samples.push(start.elapsed());
        }
        samples.sort();
        println!(
            "64 files / 256 KiB, 21 force reviews: median {:?}, max {:?}",
            samples[10], samples[20]
        );
    }
}
