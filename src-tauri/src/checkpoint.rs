use crate::wsl;
use base64::Engine;
use serde_json::json;
use std::collections::HashMap;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[cfg(test)]
use crate::fs::GitDiffStats;
use crate::fs::{
    expand_home, git_checked, git_checkpoint_paths, git_command_output, git_diff_files_for,
    host_path, path_to_js, resolve_repo_path, GitChangedFile, GitDiffIndex, MAX_TEXT_FILE_BYTES,
};

const MAX_SNAPSHOT_FILES: usize = 500;

#[derive(Clone)]
pub struct CheckpointStore {
    root: PathBuf,
    gates: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl CheckpointStore {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            gates: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn exclusive<T>(
        &self,
        session_id: &str,
        cwd: &str,
        operation: impl FnOnce(&Self) -> Result<T, String>,
    ) -> Result<T, String> {
        // Preserve cross-session ownership ordering on each host. A slow WSL
        // request must not hold the native host (or another distribution).
        let host = wsl::location(cwd)?
            .map(|location| location.distribution.to_lowercase())
            .unwrap_or_default();
        let [session_gate, host_gate] = {
            let mut gates = self.gates.lock().map_err(|_| "Checkpoint gates poisoned")?;
            gates.retain(|_, gate| gate.strong_count() > 0);
            let mut gate_for = |key: String| {
                gates.get(&key).and_then(Weak::upgrade).unwrap_or_else(|| {
                    let gate = Arc::new(Mutex::new(()));
                    gates.insert(key, Arc::downgrade(&gate));
                    gate
                })
            };
            [
                gate_for(format!("session:{session_id}")),
                gate_for(format!("host:{host}")),
            ]
        };
        // A session may change cwd: keep its manifest ordered across hosts too.
        // Every caller takes session then host, never the inverse.
        let _session = session_gate
            .lock()
            .map_err(|_| "Checkpoint session lock poisoned")?;
        let _host = host_gate
            .lock()
            .map_err(|_| "Checkpoint host lock poisoned")?;
        operation(self)
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.root.join(session_id)
    }

    fn ensure(&self, session_id: &str, cwd: &str) -> Result<(), String> {
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        if let Some(manifest) = read_manifest(&dir)? {
            if same_cwd(&manifest.cwd, cwd) {
                return Ok(());
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
        std::fs::create_dir_all(dir.join("files")).map_err(|e| e.to_string())?;

        let paths: Vec<_> = git_checkpoint_paths(&root)
            .into_iter()
            .filter_map(|path| resolve_repo_path(&root, &path).ok())
            .take(MAX_SNAPSHOT_FILES)
            .collect();
        // One HEAD lookup instead of a Git/WSL round trip per dirty file.
        let head = if paths.is_empty() {
            None
        } else {
            git_command_output(
                &root,
                &["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", "."],
            )
            .ok()
            .filter(|output| output.status.success())
        };
        let candidates: HashSet<_> = paths.iter().map(|path| path.as_bytes()).collect();
        let head_paths: HashSet<_> = head
            .as_ref()
            .map(|output| {
                output
                    .stdout
                    .split(|byte| *byte == 0)
                    .filter(|path| candidates.contains(path))
                    .collect()
            })
            .unwrap_or_default();
        let mut files = BTreeMap::new();
        let mut tracked = BTreeSet::new();
        for relative in paths {
            if head_paths.contains(relative.as_bytes())
                || (head.is_none() && in_head(&root, &relative))
            {
                tracked.insert(relative.clone());
            }
            files.insert(relative.clone(), snapshot_file(&dir, &root, &relative)?);
        }
        write_manifest(
            &dir,
            &Manifest {
                mode_format: 1,
                cwd: root.to_string_lossy().into_owned(),
                files,
                touched: BTreeSet::new(),
                tracked,
                prepared: BTreeSet::new(),
                after: BTreeMap::new(),
                stats: BTreeMap::new(),
                diverged: BTreeSet::new(),
            },
        )
    }

    fn prepare(&self, session_id: &str, cwd: &str, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let mut manifest = match read_manifest(&dir)? {
            Some(manifest) if same_cwd(&manifest.cwd, cwd) => manifest,
            _ => return Ok(()),
        };

        let mut dirty = false;
        for path in paths {
            let Ok(relative) = relative_to_root(&root, path) else {
                continue;
            };
            // Keep the original pre-edit snapshot across later edits by this
            // session. The first tool-start event owns the safe undo boundary.
            if manifest.touched.contains(&relative) && manifest.prepared.contains(&relative) {
                if !after_matches_worktree(&dir, &root, &manifest, &relative)
                    && manifest.diverged.insert(relative)
                {
                    dirty = true;
                }
                continue;
            }
            if manifest.prepared.contains(&relative) {
                continue;
            }
            if manifest.touched.contains(&relative) {
                // Upgrade a legacy or completion-only claim by dropping its
                // untrusted state and starting at this real tool boundary.
                release_path(&mut manifest, &relative);
                dirty = true;
            }
            let before = snapshot_file(&dir, &root, &relative)?;
            if manifest.files.insert(relative.clone(), before) != Some(before) {
                dirty = true;
            }
            if manifest.prepared.insert(relative.clone()) {
                dirty = true;
            }
            if in_head(&root, &relative) && manifest.tracked.insert(relative) {
                dirty = true;
            }
        }
        if dirty {
            write_manifest(&dir, &manifest)?;
        }
        Ok(())
    }

    fn capture(&self, session_id: &str, cwd: &str, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let mut manifest = match read_manifest(&dir)? {
            Some(manifest) if same_cwd(&manifest.cwd, cwd) => manifest,
            _ => return Ok(()),
        };

        let mut dirty = false;
        for path in paths {
            if manifest.touched.len() >= MAX_SNAPSHOT_FILES {
                break;
            }
            let Ok(relative) = relative_to_root(&root, path) else {
                continue;
            };
            manifest.touched.insert(relative.clone());
            let tracked_in_head = in_head(&root, &relative);
            if tracked_in_head {
                manifest.tracked.insert(relative.clone());
            }
            if !manifest.files.contains_key(&relative)
                && matches!(read_worktree(&root, &relative), FileState::Missing)
                && !tracked_in_head
            {
                // A completion without a matching prepare event is retained
                // for review but is deliberately not undoable.
                manifest
                    .files
                    .insert(relative.clone(), snapshot_file(&dir, &root, &relative)?);
            }
            let after = snapshot_after_file(&dir, &root, &relative)?;
            manifest.after.insert(relative.clone(), after);
            if let Some(stats) = calculate_session_stats(&dir, &manifest, &relative) {
                manifest.stats.insert(relative, stats);
            }
            dirty = true;
        }
        if dirty {
            write_manifest(&dir, &manifest)?;
        }
        Ok(())
    }

    fn status(&self, session_id: &str, cwd: &str) -> Result<CheckpointStatus, String> {
        let Some(manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let root = project_root(cwd)?;
        let foreign_touched = self.foreign_touched_paths(cwd, session_id);
        Ok(diff_from_manifest(
            &self.session_dir(session_id),
            &root,
            &manifest,
            &foreign_touched,
        ))
    }

    fn apply(
        &self,
        session_id: &str,
        from_cwd: &str,
        to_cwd: &str,
    ) -> Result<CheckpointApplyResult, String> {
        let from_host = wsl::location(from_cwd)?.map(|v| v.distribution.to_lowercase());
        let to_host = wsl::location(to_cwd)?.map(|v| v.distribution.to_lowercase());
        if from_host != to_host {
            return Err("Worker and lead checkouts must use the same execution host".into());
        }
        let manifest = self
            .load_matching(session_id, from_cwd)?
            .ok_or("This worker has no recoverable change checkpoint")?;
        let from_root = project_root(from_cwd)?;
        let to_root = project_root(to_cwd)?;
        if same_cwd(from_cwd, to_cwd) {
            return Err("An isolated worker cannot be integrated into itself".into());
        }
        if git_head(&from_root)? != git_head(&to_root)? {
            return Err(
                "The worker or lead branch moved while this task was running. The worker worktree was kept for manual review."
                    .into(),
            );
        }
        let dir = self.session_dir(session_id);
        let changed = verified_worker_delta(&dir, &from_root, &manifest)?;

        // Preflight every path before writing any of them. A retry may see a
        // mixture of before/after states if the app stopped during a previous
        // application; both are safe and make this operation idempotent.
        let mut already_applied = 0;
        for relative in &changed {
            if path_contains_symlink(&to_root, relative) {
                return Err(format!(
                    "Cannot integrate {relative}: the target path contains a symbolic link. The worker worktree was kept."
                ));
            }
            let before = manifest
                .files
                .get(relative)
                .copied()
                .ok_or_else(|| format!("Missing original snapshot for {relative}"))?;
            let after = manifest
                .after
                .get(relative)
                .copied()
                .ok_or_else(|| format!("Missing worker snapshot for {relative}"))?;
            let target = worktree_snapshot(&to_root, relative, manifest.mode_format == 1);
            let before_state = stored_snapshot(
                &dir,
                relative,
                before,
                false,
                from_cwd,
                manifest.mode_format == 1,
            );
            let after_state = stored_snapshot(
                &dir,
                relative,
                after,
                true,
                from_cwd,
                manifest.mode_format == 1,
            );
            if target == after_state {
                already_applied += 1;
            } else if target != before_state {
                return Err(format!(
                    "Cannot integrate {relative}: the lead checkout changed since this worker started. The worker worktree was kept."
                ));
            }
        }

        for relative in &changed {
            let after = manifest.after.get(relative).copied().unwrap();
            let target = worktree_snapshot(&to_root, relative, manifest.mode_format == 1);
            let after_state = stored_snapshot(
                &dir,
                relative,
                after,
                true,
                from_cwd,
                manifest.mode_format == 1,
            );
            if target != after_state {
                write_state(&to_root, relative, after_state.0, after_state.1)?;
            }
        }
        Ok(CheckpointApplyResult {
            files: changed,
            already_applied,
        })
    }

    fn cleanup_safe(&self, session_id: &str, cwd: &str) -> Result<bool, String> {
        let Some(manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(false);
        };
        let root = project_root(cwd)?;
        Ok(
            verified_worker_delta(&self.session_dir(session_id), &root, &manifest)
                .map(|changed| changed.is_empty())
                .unwrap_or(false),
        )
    }

    fn forget(&self, session_id: &str) -> Result<(), String> {
        let dir = self.session_dir(session_id);
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn file_diff(
        &self,
        session_id: &str,
        cwd: &str,
        relative: &str,
    ) -> Result<CheckpointFileDiff, String> {
        let Some(manifest) = self.load_matching(session_id, cwd)? else {
            return Err("Session changes are no longer available".into());
        };
        let root = project_root(cwd)?;
        let relative = resolve_repo_path(&root, relative)?;
        if !manifest.touched.contains(&relative) || !manifest.prepared.contains(&relative) {
            return Err("This file was not changed by the session".into());
        }
        if manifest.diverged.contains(&relative) {
            return Err(
                "Exact lines are unavailable because the file changed between this session's edits"
                    .into(),
            );
        }

        let dir = self.session_dir(session_id);
        let before = manifest
            .files
            .get(&relative)
            .copied()
            .ok_or_else(|| "Session baseline is unavailable".to_string())?;
        let after = manifest
            .after
            .get(&relative)
            .copied()
            .ok_or_else(|| "Session result is unavailable".to_string())?;
        let original = read_snapshot(&dir, &relative, before, &manifest.cwd);
        let current = read_after_snapshot(&dir, &relative, after, &manifest.cwd);
        let too_large =
            matches!(original, FileState::Skipped) || matches!(current, FileState::Skipped);
        let binary = state_is_binary(&original) || state_is_binary(&current);
        let (original, current) = if binary || too_large {
            (String::new(), String::new())
        } else {
            (state_text(original), state_text(current))
        };
        let status = manifest
            .stats
            .get(&relative)
            .map(|stats| stats.status.clone())
            .unwrap_or_else(|| "modified".into());
        Ok(CheckpointFileDiff {
            path: path_to_js(&host_path(&root, &relative)),
            relative,
            status,
            original,
            current,
            binary,
            too_large,
        })
    }

    /// Remaining git line counts for each session, using one working-tree index.
    #[cfg(test)]
    fn stats_for_sessions(
        &self,
        cwd: &str,
        session_ids: &[String],
    ) -> Result<HashMap<String, GitDiffStats>, String> {
        let mut out = HashMap::new();
        if session_ids.is_empty() {
            return Ok(out);
        }
        let root = project_root(cwd)?;
        let index = git_diff_files_for(&root);
        for session_id in session_ids {
            let Some(manifest) = self.load_matching(session_id, cwd)? else {
                out.insert(session_id.clone(), GitDiffStats::default());
                continue;
            };
            let foreign_touched = self.foreign_touched_paths(cwd, session_id);
            let status = diff_from_manifest_with(
                &index,
                &self.session_dir(session_id),
                &root,
                &manifest,
                &foreign_touched,
            );
            out.insert(session_id.clone(), stats_from_status(&status));
        }
        Ok(out)
    }

    fn undo(
        &self,
        session_id: &str,
        cwd: &str,
        relative: Option<&str>,
    ) -> Result<CheckpointStatus, String> {
        let Some(mut manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let foreign_touched = self.foreign_touched_paths(cwd, session_id);
        let changed = diff_from_manifest(&dir, &root, &manifest, &foreign_touched);
        if let Some(relative) = relative {
            let relative = resolve_repo_path(&root, relative)?;
            let Some(file) = changed.files.iter().find(|file| file.relative == relative) else {
                return self.status(session_id, cwd);
            };
            if !file.undoable {
                return Err(format!(
                    "Cannot safely undo {relative}: it changed outside this session"
                ));
            }
            restore_one(&dir, &root, &manifest, &relative)?;
            release_path(&mut manifest, &relative);
            write_manifest(&dir, &manifest)?;
            return self.status(session_id, cwd);
        }
        if changed.files.iter().any(|file| !file.undoable) {
            return Err(
                "Cannot safely undo all: one or more files changed outside this session".into(),
            );
        }
        for file in &changed.files {
            restore_one(&dir, &root, &manifest, &file.relative)?;
        }
        let _ = std::fs::remove_dir_all(&dir);
        Ok(CheckpointStatus { files: Vec::new() })
    }

    fn keep(
        &self,
        session_id: &str,
        cwd: &str,
        relative: Option<&str>,
    ) -> Result<CheckpointStatus, String> {
        let Some(mut manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let Some(relative) = relative else {
            let _ = std::fs::remove_dir_all(&dir);
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let relative = resolve_repo_path(&root, relative)?;
        release_path(&mut manifest, &relative);
        write_manifest(&dir, &manifest)?;
        self.status(session_id, cwd)
    }

    fn load_matching(&self, session_id: &str, cwd: &str) -> Result<Option<Manifest>, String> {
        let dir = self.session_dir(session_id);
        let Some(manifest) = read_manifest(&dir)? else {
            return Ok(None);
        };
        if !same_cwd(&manifest.cwd, cwd) {
            return Ok(None);
        }
        Ok(Some(manifest))
    }

    /// Paths already claimed by another live session in the same project.
    fn foreign_touched_paths(&self, cwd: &str, except_session_id: &str) -> HashSet<String> {
        let mut paths = HashSet::new();
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(_) => return paths,
        };
        for entry in entries.flatten() {
            let session_id = entry.file_name().to_string_lossy().into_owned();
            if session_id == except_session_id {
                continue;
            }
            let dir = entry.path();
            let Ok(Some(manifest)) = read_manifest(&dir) else {
                continue;
            };
            if !same_cwd(&manifest.cwd, cwd) {
                continue;
            }
            paths.extend(manifest.touched.intersection(&manifest.prepared).cloned());
        }
        paths
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    /// Legacy native blobs used the app's creation mode, not the source mode.
    #[serde(default)]
    mode_format: u8,
    cwd: String,
    files: BTreeMap<String, SnapshotKind>,
    #[serde(default)]
    touched: BTreeSet<String>,
    #[serde(default)]
    tracked: BTreeSet<String>,
    /// Paths captured before a structured edit started. Only these are safe
    /// candidates for Undo.
    #[serde(default)]
    prepared: BTreeSet<String>,
    /// Worktree contents immediately after the session's latest edit.
    #[serde(default)]
    after: BTreeMap<String, SnapshotKind>,
    /// Stable line counts for the session-owned before/after pair.
    #[serde(default)]
    stats: BTreeMap<String, ChangeStats>,
    /// Paths whose contents changed between two edits by this session.
    #[serde(default)]
    diverged: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ChangeStats {
    status: String,
    additions: i64,
    deletions: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum SnapshotKind {
    Contents,
    Missing,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FileState {
    Contents(Vec<u8>),
    Missing,
    Skipped,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    pub path: String,
    pub relative: String,
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
    /// False when the file changed between this session's own edit snapshots,
    /// so its net line ownership cannot be reconstructed exactly.
    pub exact: bool,
    pub undoable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStatus {
    pub files: Vec<CheckpointFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFileDiff {
    pub path: String,
    pub relative: String,
    pub status: String,
    pub original: String,
    pub current: String,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointApplyResult {
    pub files: Vec<String>,
    pub already_applied: usize,
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("checkpoints");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.manage(CheckpointStore::new(dir));
    Ok(())
}

#[tauri::command]
pub async fn session_checkpoint_ensure(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(&session_id, &cwd, |store| store.ensure(&session_id, &cwd))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_prepare(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    if paths.len() > MAX_SNAPSHOT_FILES {
        return Err("Too many paths".into());
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(&session_id, &cwd, |store| {
            store.prepare(&session_id, &cwd, &paths)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_capture(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    if paths.len() > MAX_SNAPSHOT_FILES {
        return Err("Too many paths".into());
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(&session_id, &cwd, |store| {
            store.capture(&session_id, &cwd, &paths)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_status(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
) -> Result<CheckpointStatus, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(&session_id, &cwd, |store| store.status(&session_id, &cwd))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_apply(
    store: State<'_, CheckpointStore>,
    session_id: String,
    from_cwd: String,
    to_cwd: String,
) -> Result<CheckpointApplyResult, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(&session_id, &from_cwd, |store| {
            store.apply(&session_id, &from_cwd, &to_cwd)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_cleanup_safe(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
) -> Result<bool, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(&session_id, &cwd, |store| {
            store.cleanup_safe(&session_id, &cwd)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_forget(
    store: State<'_, CheckpointStore>,
    session_id: String,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(&session_id, "", |store| store.forget(&session_id))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_file_diff(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    relative: String,
) -> Result<CheckpointFileDiff, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(&session_id, &cwd, |store| {
            store.file_diff(&session_id, &cwd, &relative)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_undo(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    relative: Option<String>,
) -> Result<CheckpointStatus, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(&session_id, &cwd, |store| {
            store.undo(&session_id, &cwd, relative.as_deref())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_keep(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    relative: Option<String>,
) -> Result<CheckpointStatus, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(&session_id, &cwd, |store| {
            store.keep(&session_id, &cwd, relative.as_deref())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reconstruct the worker-owned delta and reject anything that was not
/// captured at a structured tool boundary. This is stricter than the review
/// UI because cleanup must never discard an ambiguous edit.
fn verified_worker_delta(
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
) -> Result<Vec<String>, String> {
    if manifest.mode_format != 1 {
        return Err(
            "This checkpoint predates file-mode tracking; the worker was kept for manual review"
                .into(),
        );
    }
    if !manifest.diverged.is_empty() {
        return Err(format!(
            "Cannot safely integrate files that changed outside the worker: {}",
            manifest
                .diverged
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let current_dirty: BTreeSet<String> = git_diff_files_for(root)
        .files
        .into_iter()
        .map(|file| file.relative)
        .collect();
    if let Some(relative) = current_dirty
        .iter()
        .find(|relative| !manifest.files.contains_key(*relative))
    {
        return Err(format!(
            "Cannot safely integrate {relative}: its change was not captured for this worker. The worker worktree was kept."
        ));
    }

    let mut changed = Vec::new();
    for (relative, before) in &manifest.files {
        if path_contains_symlink(root, relative) {
            return Err(format!(
                "Cannot safely integrate {relative}: the worker path contains a symbolic link. The worker worktree was kept."
            ));
        }
        if *before == SnapshotKind::Skipped {
            return Err(format!(
                "Cannot safely integrate {relative}: this file type or size cannot be checkpointed. The worker worktree was kept."
            ));
        }
        let before_state = stored_snapshot(
            dir,
            relative,
            *before,
            false,
            &manifest.cwd,
            manifest.mode_format == 1,
        );
        if matches!(before_state.0, FileState::Skipped) {
            return Err(format!("Cannot read original checkpoint for {relative}; the worker was kept for manual review"));
        }
        if manifest.touched.contains(relative) {
            if !manifest.prepared.contains(relative) {
                return Err(format!(
                    "Cannot safely integrate {relative}: its pre-edit state was not captured. The worker worktree was kept."
                ));
            }
            let after = manifest
                .after
                .get(relative)
                .copied()
                .ok_or_else(|| format!("Missing worker snapshot for {relative}"))?;
            if after == SnapshotKind::Skipped {
                return Err(format!(
                    "Cannot safely integrate {relative}: this file type or size cannot be checkpointed. The worker worktree was kept."
                ));
            }
            let after_state = stored_snapshot(
                dir,
                relative,
                after,
                true,
                &manifest.cwd,
                manifest.mode_format == 1,
            );
            if matches!(after_state.0, FileState::Skipped) {
                return Err(format!("Cannot read worker checkpoint for {relative}; the worker was kept for manual review"));
            }
            if worktree_snapshot(root, relative, manifest.mode_format == 1) != after_state {
                return Err(format!(
                    "Cannot safely integrate {relative}: it changed after the worker checkpoint. The worker worktree was kept."
                ));
            }
            if before_state != after_state {
                changed.push(relative.clone());
            }
        } else if worktree_snapshot(root, relative, manifest.mode_format == 1) != before_state {
            return Err(format!(
                "Cannot safely integrate {relative}: its change was not attributed to this worker. The worker worktree was kept."
            ));
        }
    }
    changed.sort();
    Ok(changed)
}

fn write_state(
    root: &Path,
    relative: &str,
    state: FileState,
    mode: Option<u32>,
) -> Result<(), String> {
    let relative = resolve_repo_path(root, relative)?;
    if path_contains_symlink(root, &relative) {
        return Err(format!("Cannot write through symbolic link {relative}"));
    }
    match state {
        FileState::Contents(bytes) => {
            if let Some(location) = wsl::path_location(&host_path(root, &relative))? {
                let root_location =
                    wsl::path_location(root)?.ok_or("Missing WSL checkpoint root")?;
                return wsl::request(
                    &location,
                    "restore_bytes",
                    json!({
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                        "checkpointRoot": root_location.path, "mode": mode,
                    }),
                );
            }
            let path = root.join(relative);
            write_worktree(&path, &bytes)?;
            set_file_mode(&path, mode)
        }
        FileState::Missing => remove_worktree(root, &relative),
        FileState::Skipped => Err(format!("Cannot write unsupported file {relative}")),
    }
}

fn stored_snapshot(
    dir: &Path,
    relative: &str,
    kind: SnapshotKind,
    after: bool,
    cwd: &str,
    modes_known: bool,
) -> (FileState, Option<u32>) {
    let blob_root = if after {
        dir.join("after")
    } else {
        dir.join("files")
    };
    (
        read_snapshot_at(&blob_root, relative, kind, cwd),
        if modes_known {
            snapshot_mode(&blob_root, relative, kind, cwd)
        } else {
            None
        },
    )
}

fn worktree_snapshot(root: &Path, relative: &str, modes_known: bool) -> (FileState, Option<u32>) {
    if !modes_known {
        return (read_worktree(root, relative), None);
    }
    match wsl::path_location(&host_path(root, relative)) {
        Ok(Some(location)) => {
            return read_wsl_snapshot(&location).unwrap_or((FileState::Skipped, None))
        }
        Err(_) => return (FileState::Skipped, None),
        Ok(None) => {}
    }
    (
        read_worktree(root, relative),
        file_mode(&root.join(relative)),
    )
}

fn path_contains_symlink(root: &Path, relative: &str) -> bool {
    match wsl::path_location(root) {
        Ok(Some(location)) => {
            return wsl::request(
                &location,
                "checkpoint_symlink",
                json!({"relative": relative}),
            )
            .unwrap_or(true)
        }
        Err(_) => return true,
        Ok(None) => {}
    }
    let mut current = root.to_path_buf();
    for part in relative.split('/') {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(_) => return true,
        }
    }
    false
}

fn git_head(root: &Path) -> Result<Vec<u8>, String> {
    if let Some(location) = wsl::path_location(root)? {
        let output = wsl::git(&location, &["rev-parse", "--verify", "HEAD"], None)?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        return Ok(output.stdout);
    }
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
    let output = command
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

fn diff_from_manifest(
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
    foreign_touched: &HashSet<String>,
) -> CheckpointStatus {
    diff_from_manifest_with(
        &git_diff_files_for(root),
        dir,
        root,
        manifest,
        foreign_touched,
    )
}

fn diff_from_manifest_with(
    index: &GitDiffIndex,
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
    foreign_touched: &HashSet<String>,
) -> CheckpointStatus {
    let by_relative: BTreeMap<&str, &GitChangedFile> = index
        .files
        .iter()
        .map(|file| (file.relative.as_str(), file))
        .collect();
    let git_dirty: HashSet<&str> = by_relative.keys().copied().collect();
    let mut files = Vec::new();

    for relative in &manifest.touched {
        // Without a tool-start snapshot there is no trustworthy session
        // boundary. Never guess from the shared working tree.
        if !manifest.prepared.contains(relative) {
            continue;
        }
        if session_snapshot_differs(dir, manifest, relative) == Some(false) {
            continue;
        }
        if !file_differs(dir, root, manifest, relative, &git_dirty) {
            continue;
        }
        // Review is always scoped to this session's captured before/after
        // snapshots. A foreign claim can make restoring the file unsafe, but
        // it does not make this session's recorded diff or counts inexact.
        let exact = !manifest.diverged.contains(relative);
        let undoable = exact
            && !foreign_touched.contains(relative)
            && after_matches_worktree(dir, root, manifest, relative);
        let session_change = manifest.stats.get(relative).map(|stats| {
            let additions = if exact { stats.additions } else { 0 };
            let deletions = if exact { stats.deletions } else { 0 };
            (stats.status.clone(), additions, deletions)
        });
        files.push(describe_change(
            root,
            relative,
            by_relative.get(relative.as_str()).copied(),
            exact,
            undoable,
            session_change,
        ));
    }

    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    CheckpointStatus { files }
}

fn session_snapshot_differs(dir: &Path, manifest: &Manifest, relative: &str) -> Option<bool> {
    let before = manifest.files.get(relative).copied()?;
    let after = manifest.after.get(relative).copied()?;
    Some(
        stored_snapshot(
            dir,
            relative,
            before,
            false,
            &manifest.cwd,
            manifest.mode_format == 1,
        ) != stored_snapshot(
            dir,
            relative,
            after,
            true,
            &manifest.cwd,
            manifest.mode_format == 1,
        ),
    )
}

#[cfg(test)]
fn stats_from_status(status: &CheckpointStatus) -> GitDiffStats {
    let mut additions = 0i64;
    let mut deletions = 0i64;
    for file in &status.files {
        additions += file.additions;
        deletions += file.deletions;
    }
    GitDiffStats {
        files: status.files.len() as i64,
        additions,
        deletions,
    }
}

fn file_differs(
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
    relative: &str,
    git_dirty: &HashSet<&str>,
) -> bool {
    // Once a tracked path is clean against HEAD, its session change was
    // committed (or otherwise resolved) and no longer needs review.
    if !git_dirty.contains(relative)
        && (manifest.tracked.contains(relative) || in_head(root, relative))
    {
        return false;
    }
    match manifest.files.get(relative) {
        Some(SnapshotKind::Skipped) => false,
        Some(kind) => {
            worktree_snapshot(root, relative, manifest.mode_format == 1)
                != stored_snapshot(
                    dir,
                    relative,
                    *kind,
                    false,
                    &manifest.cwd,
                    manifest.mode_format == 1,
                )
        }
        None => {
            git_dirty.contains(relative)
                || (matches!(read_worktree(root, relative), FileState::Contents(_))
                    && !in_head(root, relative))
        }
    }
}

fn describe_change(
    root: &Path,
    relative: &str,
    git: Option<&GitChangedFile>,
    exact: bool,
    undoable: bool,
    session_change: Option<(String, i64, i64)>,
) -> CheckpointFile {
    if let Some((status, additions, deletions)) = session_change {
        return CheckpointFile {
            path: path_to_js(&host_path(root, relative)),
            relative: relative.to_string(),
            status,
            additions,
            deletions,
            exact,
            undoable,
        };
    }
    if let Some(file) = git {
        return CheckpointFile {
            path: file.path.clone(),
            relative: file.relative.clone(),
            status: file.status.clone(),
            additions: file.additions,
            deletions: file.deletions,
            exact,
            undoable,
        };
    }
    let abs = host_path(root, relative);
    let status = if matches!(read_worktree(root, relative), FileState::Missing) {
        "deleted"
    } else {
        "modified"
    };
    CheckpointFile {
        path: path_to_js(&abs),
        relative: relative.to_string(),
        status: status.into(),
        additions: 0,
        deletions: 0,
        exact,
        undoable,
    }
}

fn calculate_session_stats(dir: &Path, manifest: &Manifest, relative: &str) -> Option<ChangeStats> {
    let before = manifest.files.get(relative).copied()?;
    let after = manifest.after.get(relative).copied()?;
    if before == SnapshotKind::Skipped || after == SnapshotKind::Skipped {
        return None;
    }
    let before_path = state_blob_path(
        &dir.join("files"),
        relative,
        wsl::location(&manifest.cwd).ok().flatten().is_some(),
    )
    .ok()?;
    let after_path = state_blob_path(
        &dir.join("after"),
        relative,
        wsl::location(&manifest.cwd).ok().flatten().is_some(),
    )
    .ok()?;
    let (additions, deletions) = diff_numstat(&before_path, &after_path, &manifest.cwd)?;
    let status = match (before, after) {
        (SnapshotKind::Missing, SnapshotKind::Missing) => "modified",
        (SnapshotKind::Missing, _) => "added",
        (_, SnapshotKind::Missing) => "deleted",
        _ => "modified",
    };
    Some(ChangeStats {
        status: status.into(),
        additions,
        deletions,
    })
}

fn diff_numstat(before: &Path, after: &Path, cwd: &str) -> Option<(i64, i64)> {
    if let Some(location) = wsl::location(cwd).ok().flatten() {
        let encode = |path: &Path| {
            std::fs::read(path)
                .ok()
                .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
        };
        let text: String = wsl::request(
            &location,
            "diff_numstat",
            json!({"before":encode(before)?, "after":encode(after)?}),
        )
        .ok()?;
        let mut fields = text.lines().next()?.split('\t');
        return Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?));
    }
    let mut cmd = Command::new("git");
    crate::hide_window_console(&mut cmd);
    let output = cmd
        .args(["diff", "--no-index", "--no-ext-diff", "--numstat", "--"])
        .arg(before)
        .arg(after)
        .output()
        .ok()?;
    if !output.status.success() && output.status.code() != Some(1) {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut fields = text.lines().next()?.split('\t');
    let additions = fields.next()?.parse().ok()?;
    let deletions = fields.next()?.parse().ok()?;
    Some((additions, deletions))
}

fn after_matches_worktree(dir: &Path, root: &Path, manifest: &Manifest, relative: &str) -> bool {
    let Some(kind) = manifest.after.get(relative).copied() else {
        return false;
    };
    worktree_snapshot(root, relative, manifest.mode_format == 1)
        == stored_snapshot(
            dir,
            relative,
            kind,
            true,
            &manifest.cwd,
            manifest.mode_format == 1,
        )
}

fn release_path(manifest: &mut Manifest, relative: &str) {
    manifest.files.remove(relative);
    manifest.touched.remove(relative);
    manifest.tracked.remove(relative);
    manifest.prepared.remove(relative);
    manifest.after.remove(relative);
    manifest.stats.remove(relative);
    manifest.diverged.remove(relative);
}

fn restore_one(dir: &Path, root: &Path, manifest: &Manifest, relative: &str) -> Result<(), String> {
    let relative = resolve_repo_path(root, relative)?;
    match manifest.files.get(&relative) {
        Some(SnapshotKind::Skipped) => Ok(()),
        Some(kind) => restore_snapshot(dir, root, &relative, *kind, manifest.mode_format == 1),
        None => revert_new_change(root, &relative),
    }
}

fn restore_snapshot(
    dir: &Path,
    root: &Path,
    relative: &str,
    kind: SnapshotKind,
    modes_known: bool,
) -> Result<(), String> {
    if kind != SnapshotKind::Skipped && path_contains_symlink(root, relative) {
        return Err(format!("Cannot restore through symbolic link {relative}"));
    }
    match kind {
        SnapshotKind::Skipped => Ok(()),
        SnapshotKind::Missing => {
            let _ = git_checked(root, &["reset", "-q", "HEAD", "--", relative]);
            remove_worktree(root, relative)
        }
        SnapshotKind::Contents => {
            let (state, mode) = stored_snapshot(
                dir,
                relative,
                kind,
                false,
                &root.to_string_lossy(),
                modes_known,
            );
            if !matches!(state, FileState::Contents(_)) {
                return Err(
                    "The checkpoint contents are unavailable; the current file was kept".into(),
                );
            }
            write_state(root, relative, state, mode)?;
            let _ = git_checked(root, &["reset", "-q", "HEAD", "--", relative]);
            Ok(())
        }
    }
}

fn revert_new_change(root: &Path, relative: &str) -> Result<(), String> {
    let relative = resolve_repo_path(root, relative)?;
    if in_head(root, &relative) {
        return git_checked(
            root,
            &[
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                &relative,
            ],
        );
    }
    let _ = git_checked(root, &["reset", "-q", "HEAD", "--", &relative]);
    remove_worktree(root, &relative)
}

fn in_head(root: &Path, relative: &str) -> bool {
    git_checked(root, &["cat-file", "-e", &format!("HEAD:{relative}")]).is_ok()
}

fn snapshot_file(dir: &Path, root: &Path, relative: &str) -> Result<SnapshotKind, String> {
    snapshot_file_at(&dir.join("files"), root, relative)
}

fn snapshot_after_file(dir: &Path, root: &Path, relative: &str) -> Result<SnapshotKind, String> {
    snapshot_file_at(&dir.join("after"), root, relative)
}

fn snapshot_file_at(blob_root: &Path, root: &Path, relative: &str) -> Result<SnapshotKind, String> {
    let abs = host_path(root, relative);
    if let Some(location) = wsl::path_location(&abs)? {
        let snapshot = read_wsl_snapshot(&location)?;
        let mode = snapshot.1;
        let (kind, bytes) = match snapshot.0 {
            FileState::Missing => (SnapshotKind::Missing, Vec::new()),
            FileState::Contents(bytes) => (SnapshotKind::Contents, bytes),
            FileState::Skipped => return Ok(SnapshotKind::Skipped),
        };
        let blob = state_blob_path(blob_root, relative, true)?;
        if let Some(parent) = blob.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&blob, bytes).map_err(|e| e.to_string())?;
        std::fs::write(
            blob.with_extension("mode"),
            serde_json::to_vec(&mode).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        return Ok(kind);
    }
    let meta = match std::fs::symlink_metadata(&abs) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let blob = state_blob_path(blob_root, relative, false)?;
            if let Some(parent) = blob.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(blob, []).map_err(|e| e.to_string())?;
            return Ok(SnapshotKind::Missing);
        }
        Err(error) => return Err(error.to_string()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Ok(SnapshotKind::Skipped);
    }
    if meta.len() > MAX_TEXT_FILE_BYTES {
        return Ok(SnapshotKind::Skipped);
    }
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    let blob = state_blob_path(blob_root, relative, false)?;
    if let Some(parent) = blob.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&blob, bytes).map_err(|e| e.to_string())?;
    set_file_mode(&blob, file_mode(&abs))?;
    Ok(SnapshotKind::Contents)
}

#[cfg(unix)]
fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::symlink_metadata(path)
        .ok()
        .filter(|meta| meta.is_file() && !meta.file_type().is_symlink())
        .map(|meta| meta.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Option<u32> {
    None
}

#[cfg(unix)]
fn set_file_mode(path: &Path, mode: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path, _mode: Option<u32>) -> Result<(), String> {
    Ok(())
}

fn snapshot_mode(blob_root: &Path, relative: &str, kind: SnapshotKind, cwd: &str) -> Option<u32> {
    if kind != SnapshotKind::Contents {
        return None;
    }
    if wsl::location(cwd).ok().flatten().is_some() {
        let path = state_blob_path(blob_root, relative, true).ok()?;
        return std::fs::read(path.with_extension("mode"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Option<u32>>(&bytes).ok())
            .flatten()
            .filter(|mode| *mode <= 0o777);
    }
    state_blob_path(blob_root, relative, false)
        .ok()
        .and_then(|path| file_mode(&path))
}

fn read_snapshot(dir: &Path, relative: &str, kind: SnapshotKind, cwd: &str) -> FileState {
    read_snapshot_at(&dir.join("files"), relative, kind, cwd)
}

fn read_after_snapshot(dir: &Path, relative: &str, kind: SnapshotKind, cwd: &str) -> FileState {
    read_snapshot_at(&dir.join("after"), relative, kind, cwd)
}

fn read_snapshot_at(blob_root: &Path, relative: &str, kind: SnapshotKind, cwd: &str) -> FileState {
    match kind {
        SnapshotKind::Missing => FileState::Missing,
        SnapshotKind::Skipped => FileState::Skipped,
        SnapshotKind::Contents => match state_blob_path(
            blob_root,
            relative,
            wsl::location(cwd).ok().flatten().is_some(),
        )
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        {
            Some(bytes) => FileState::Contents(bytes),
            None => FileState::Skipped,
        },
    }
}

fn read_wsl_state(location: &wsl::Location) -> Result<FileState, String> {
    read_wsl_snapshot(location).map(|value| value.0)
}

fn read_wsl_snapshot(location: &wsl::Location) -> Result<(FileState, Option<u32>), String> {
    let value: serde_json::Value = wsl::request(location, "checkpoint_file", json!({}))?;
    if value["exists"] == false {
        return Ok((FileState::Missing, None));
    }
    if value["isFile"] != true || value["tooLarge"] == true {
        return Ok((FileState::Skipped, None));
    }
    base64::engine::general_purpose::STANDARD
        .decode(
            value["data"]
                .as_str()
                .ok_or("Missing checkpoint contents")?,
        )
        .map(|bytes| {
            (
                FileState::Contents(bytes),
                value["mode"]
                    .as_u64()
                    .filter(|mode| *mode <= 0o777)
                    .map(|mode| mode as u32),
            )
        })
        .map_err(|e| e.to_string())
}

fn read_worktree(root: &Path, relative: &str) -> FileState {
    let abs = host_path(root, relative);
    match wsl::path_location(&abs) {
        Ok(Some(location)) => return read_wsl_state(&location).unwrap_or(FileState::Skipped),
        Err(_) => return FileState::Skipped,
        Ok(None) => {}
    }
    if !abs.exists() {
        return FileState::Missing;
    }
    if !abs.is_file() {
        return FileState::Skipped;
    }
    match std::fs::metadata(&abs).and_then(|meta| {
        if meta.len() > MAX_TEXT_FILE_BYTES {
            return Ok(FileState::Skipped);
        }
        std::fs::read(&abs).map(FileState::Contents)
    }) {
        Ok(state) => state,
        Err(_) => FileState::Missing,
    }
}

fn state_is_binary(state: &FileState) -> bool {
    matches!(state, FileState::Contents(bytes) if bytes.contains(&0))
}

fn state_text(state: FileState) -> String {
    match state {
        FileState::Contents(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        FileState::Missing | FileState::Skipped => String::new(),
    }
}

fn write_worktree(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(location) = wsl::path_location(path)? {
        return wsl::request(
            &location,
            "restore_bytes",
            json!({"data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
        );
    }
    if path.is_dir() {
        return Err(format!("{} is a directory", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

fn remove_worktree(root: &Path, relative: &str) -> Result<(), String> {
    let abs = host_path(root, relative);
    if let Some(location) = wsl::path_location(&abs)? {
        return wsl::request(&location, "remove_checkpoint_file", json!({}));
    }
    if abs.is_file() || abs.is_symlink() {
        std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if abs.is_dir() {
        let _ = git_checked(root, &["clean", "-fd", "--", relative]);
        if abs.exists() {
            std::fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn state_blob_path(blob_root: &Path, relative: &str, linux: bool) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "..")
    {
        return Err("Invalid path".into());
    }
    if linux {
        // Linux names may differ only in case or name Windows devices/streams.
        // Encode bytes with lowercase hex; bounded components work on both hosts.
        let encoded: String = relative.bytes().map(|byte| format!("{byte:02x}")).collect();
        let mut path = blob_root.join(".wsl");
        for chunk in encoded.as_bytes().chunks(100) {
            path.push(std::str::from_utf8(chunk).map_err(|e| e.to_string())?);
        }
        return Ok(path.join("blob"));
    }
    Ok(blob_root.join(relative))
}

fn read_manifest(dir: &Path) -> Result<Option<Manifest>, String> {
    let path = dir.join("manifest.json");
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dest = dir.join("manifest.json");
    let tmp = dir.join("manifest.json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dest).map_err(|e| e.to_string())
}

fn project_root(cwd: &str) -> Result<PathBuf, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() || trimmed == "~" {
        return Err("cwd is required".into());
    }
    if let Some(location) = wsl::location(trimmed)? {
        // Validate on the guest, but retain the chosen cwd as native checkpoints
        // do. Canonicalizing only this side breaks symlink cwd/tool identities.
        wsl::path_request(&location, "canonical_directory", json!({}))?;
        return Ok(PathBuf::from(location.identity()));
    }
    let root = expand_home(trimmed);
    if !root.is_dir() {
        return Err(format!("{}: Not a directory", root.display()));
    }
    Ok(root)
}

fn same_cwd(saved: &str, cwd: &str) -> bool {
    match (wsl::location(saved), wsl::location(cwd)) {
        (Ok(Some(left)), Ok(Some(right))) => {
            return left.distribution.eq_ignore_ascii_case(&right.distribution)
                && left.path == right.path
        }
        (Ok(None), Ok(None)) => {}
        _ => return false,
    }
    let Ok(left) = project_root(saved) else {
        return false;
    };
    let Ok(right) = project_root(cwd) else {
        return false;
    };
    left == right
}

fn relative_to_root(root: &Path, path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Invalid path".into());
    }
    let expanded = if let Some(host) = wsl::path_location(root)? {
        if let Some(target) = wsl::location(trimmed)? {
            if !host.distribution.eq_ignore_ascii_case(&target.distribution) {
                return Err("Path belongs to another WSL distribution".into());
            }
            PathBuf::from(host.with_path(&target.path)?.identity())
        } else if trimmed.starts_with('/') {
            PathBuf::from(host.with_path(trimmed)?.identity())
        } else {
            expand_home(trimmed)
        }
    } else {
        expand_home(trimmed)
    };
    if expanded.is_absolute() {
        let relative = expanded
            .strip_prefix(root)
            .map_err(|_| "Path is outside the project".to_string())?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        return resolve_repo_path(root, &relative);
    }
    resolve_repo_path(root, trimmed)
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("Invalid {label} id"));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {

    #[test]
    fn slow_wsl_checkpoint_does_not_hold_other_hosts_but_ownership_stays_ordered() {
        use std::sync::mpsc;
        use std::time::Duration;
        let store = super::CheckpointStore::new(std::env::temp_dir());
        let (entered, ready) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let (finished, done) = mpsc::channel();
        let (available, availability) = mpsc::channel();
        std::thread::scope(|scope| {
            let store = &store;
            scope.spawn(move || {
                store
                    .exclusive("wsl-session", "//wsl.localhost/Ubuntu/repo", |_| {
                        entered.send(()).unwrap();
                        released.recv().unwrap();
                        Ok(())
                    })
                    .unwrap()
            });
            ready.recv_timeout(Duration::from_secs(2)).unwrap();
            for (session, cwd) in [
                ("other-session", "//wsl$/ubuntu/other"),
                ("wsl-session", "/native/changed-cwd"),
            ] {
                let finished = finished.clone();
                scope.spawn(move || {
                    store.exclusive(session, cwd, |_| Ok(())).unwrap();
                    finished.send(()).unwrap();
                });
            }
            scope.spawn(move || {
                store
                    .exclusive("native-session", "/native/repo", |_| Ok(()))
                    .unwrap();
                store
                    .exclusive("debian-session", "//wsl.localhost/Debian/repo", |_| Ok(()))
                    .unwrap();
                available.send(()).unwrap();
            });
            let independent = availability.recv_timeout(Duration::from_secs(2));
            let finished_early = done.try_recv().is_ok();
            release.send(()).unwrap();
            independent.unwrap();
            assert!(!finished_early);
            for _ in 0..2 {
                done.recv_timeout(Duration::from_secs(2)).unwrap();
            }
        });
        // Completed hosts/sessions do not leave an ever-growing lock cache.
        for n in 0..100 {
            store
                .exclusive(
                    &format!("session-{n}"),
                    &format!("//wsl.localhost/Distro{n}/repo"),
                    |_| Ok(()),
                )
                .unwrap();
        }
        assert_eq!(store.gates.lock().unwrap().len(), 2);
    }

    use super::*;
    use std::io::ErrorKind;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp(label: &str) -> Tmp {
        loop {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "monocode-checkpoint-{label}-{}-{stamp}-{seq}",
                std::process::id()
            ));
            match std::fs::create_dir(&dir) {
                Ok(()) => return Tmp(dir),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("{}", error),
            }
        }
    }

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "monocode")
            .env("GIT_AUTHOR_EMAIL", "monocode@test")
            .env("GIT_COMMITTER_NAME", "monocode")
            .env("GIT_COMMITTER_EMAIL", "monocode@test")
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn init_git_commit(dir: &Path, files: &[(&str, &str)]) -> bool {
        if !git(dir, &["init", "-b", "main"]) && !git(dir, &["init"]) {
            return false;
        }
        let _ = git(dir, &["config", "user.email", "monocode@test"]);
        let _ = git(dir, &["config", "user.name", "monocode"]);
        let _ = git(dir, &["config", "core.autocrlf", "false"]);
        for (name, contents) in files {
            let path = dir.join(name);
            if let Some(parent) = path.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    return false;
                }
            }
            if std::fs::write(&path, contents).is_err() {
                return false;
            }
        }
        git(dir, &["add", "."]) && git(dir, &["commit", "-m", "init"])
    }

    fn store() -> (Tmp, CheckpointStore) {
        let dir = tmp("store");
        let store = CheckpointStore::new(dir.0.clone());
        (dir, store)
    }

    fn relatives(status: &CheckpointStatus) -> Vec<&str> {
        status
            .files
            .iter()
            .map(|file| file.relative.as_str())
            .collect()
    }

    fn record(store: &CheckpointStore, id: &str, cwd: &str, paths: &[&str]) {
        let owned: Vec<String> = paths.iter().map(|path| (*path).to_string()).collect();
        store.capture(id, cwd, &owned).unwrap();
        // Most legacy tests write before calling this helper. Mark their
        // already-captured baselines as if a tool-start prepare event ran;
        // dedicated tests below exercise the real prepare/capture lifecycle.
        let root = project_root(cwd).unwrap();
        let dir = store.session_dir(id);
        let mut manifest = read_manifest(&dir).unwrap().unwrap();
        for path in paths {
            manifest
                .prepared
                .insert(relative_to_root(&root, path).unwrap());
        }
        write_manifest(&dir, &manifest).unwrap();
    }

    #[test]
    fn linux_checkpoint_names_do_not_collide_on_windows() {
        let root = Path::new("store");
        let upper = state_blob_path(root, "Case.txt", true).unwrap();
        let lower = state_blob_path(root, "case.txt", true).unwrap();
        assert_ne!(
            upper.to_string_lossy().to_lowercase(),
            lower.to_string_lossy().to_lowercase()
        );
        assert!(!state_blob_path(root, "CON:stream", true)
            .unwrap()
            .to_string_lossy()
            .contains(':'));
        assert_eq!(
            state_blob_path(root, "legacy.txt", false).unwrap(),
            root.join("legacy.txt")
        );
    }

    #[cfg(unix)]
    pub(crate) fn verify_wsl_round_trip(cwd: &str) {
        let (_dir, store) = store();
        let root = project_root(cwd).unwrap();
        // A chosen symlink cwd must retain its baseline and accept absolute
        // tool paths in that same namespace, just like native checkpoints.
        let location = wsl::location(cwd).unwrap().unwrap();
        let alias = PathBuf::from(&location.path).join("checkpoint-alias");
        std::os::unix::fs::symlink(&location.path, &alias).unwrap();
        let alias_cwd = location
            .with_path(&alias.to_string_lossy())
            .unwrap()
            .identity();
        let alias_file = alias.join("alias-baseline.txt");
        std::fs::write(&alias_file, "before\n").unwrap();
        store.ensure("alias", &alias_cwd).unwrap();
        let tool_path = alias_file.to_string_lossy().into_owned();
        store
            .prepare("alias", &alias_cwd, std::slice::from_ref(&tool_path))
            .unwrap();
        std::fs::write(&alias_file, "after\n").unwrap();
        store.capture("alias", &alias_cwd, &[tool_path]).unwrap();
        store.ensure("alias", &alias_cwd).unwrap();
        let diff = store
            .file_diff("alias", &alias_cwd, "alias-baseline.txt")
            .unwrap();
        assert_eq!(diff.original, "before\n");
        assert_eq!(diff.current, "after\n");
        std::fs::remove_file(alias_file).unwrap();
        std::fs::remove_file(alias).unwrap();
        let file = "Renamed ü.txt";
        write_worktree(&host_path(&root, file), b"user-dirty\n").unwrap();
        store.ensure("wsl", cwd).unwrap();
        let location = wsl::location(cwd).unwrap().unwrap();
        let agent_path = format!("{}/{}", location.path, file);
        store
            .prepare("wsl", cwd, std::slice::from_ref(&agent_path))
            .unwrap();
        write_worktree(&host_path(&root, file), b"agent-change\n").unwrap();
        store
            .capture("wsl", cwd, std::slice::from_ref(&agent_path))
            .unwrap();
        let diff = store.file_diff("wsl", cwd, file).unwrap();
        assert_eq!(diff.original, "user-dirty\n");
        assert_eq!(diff.current, "agent-change\n");
        assert!(store
            .status("wsl", cwd)
            .unwrap()
            .files
            .iter()
            .any(|row| row.relative == file && row.undoable));
        store.undo("wsl", cwd, Some(file)).unwrap();
        assert_eq!(
            read_worktree(&root, file),
            FileState::Contents(b"user-dirty\n".to_vec())
        );
        let added = "checkpoint new ż.txt";
        store.prepare("wsl", cwd, &[added.into()]).unwrap();
        write_worktree(&host_path(&root, added), b"new\n").unwrap();
        store.capture("wsl", cwd, &[added.into()]).unwrap();
        store.undo("wsl", cwd, Some(added)).unwrap();
        assert_eq!(read_worktree(&root, added), FileState::Missing);
        assert!(same_cwd(cwd, &cwd.replace("wsl.localhost", "wsl$")));
        assert!(!same_cwd(cwd, &cwd.to_uppercase()));
    }

    #[test]
    fn undo_reverts_only_session_files_and_keeps_user_dirty() {
        let repo = tmp("keep-user");
        if !init_git_commit(&repo.0, &[("user.txt", "mine\n"), ("clean.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("user.txt"), "mine-dirty\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("s1", &cwd).unwrap();

        std::fs::write(repo.0.join("user.txt"), "agent-on-user\n").unwrap();
        std::fs::write(repo.0.join("clean.txt"), "agent-on-clean\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), "created\n").unwrap();
        record(&store, "s1", &cwd, &["user.txt", "clean.txt", "new.txt"]);

        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(relatives(&status), vec!["clean.txt", "new.txt", "user.txt"]);

        store.undo("s1", &cwd, None).unwrap();

        assert_eq!(
            std::fs::read_to_string(repo.0.join("user.txt")).unwrap(),
            "mine-dirty\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("clean.txt")).unwrap(),
            "head\n"
        );
        assert!(!repo.0.join("new.txt").exists());
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn undo_does_not_touch_untouched_user_files() {
        let repo = tmp("untouched");
        if !init_git_commit(&repo.0, &[("keep.txt", "head\n"), ("edit.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("keep.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();

        std::fs::write(repo.0.join("edit.txt"), "agent\n").unwrap();
        std::fs::write(repo.0.join("created.txt"), "new\n").unwrap();
        record(&store, "s1", &cwd, &["edit.txt", "created.txt"]);

        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(relatives(&status), vec!["created.txt", "edit.txt"]);

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("keep.txt")).unwrap(),
            "user\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("edit.txt")).unwrap(),
            "head\n"
        );
        assert!(!repo.0.join("created.txt").exists());
    }

    #[test]
    fn ensure_is_idempotent_across_turns() {
        let repo = tmp("idempotent");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("a.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent-1\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);
        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("b.txt"), "agent-2\n").unwrap();
        record(&store, "s1", &cwd, &["b.txt"]);

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "user\n"
        );
        assert!(!repo.0.join("b.txt").exists());
    }

    #[test]
    fn keep_clears_review_and_leaves_files() {
        let repo = tmp("keep");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent\n").unwrap();
        std::fs::write(repo.0.join("b.txt"), "new\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt", "b.txt"]);
        assert!(!store.status("s1", &cwd).unwrap().files.is_empty());

        store.keep("s1", &cwd, None).unwrap();
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("b.txt")).unwrap(),
            "new\n"
        );
    }

    #[test]
    fn keep_one_file_then_undo_the_rest() {
        let repo = tmp("keep-one");
        if !init_git_commit(&repo.0, &[("a.txt", "head-a\n"), ("b.txt", "head-b\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent-a\n").unwrap();
        std::fs::write(repo.0.join("b.txt"), "agent-b\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt", "b.txt"]);

        store.keep("s1", &cwd, Some("a.txt")).unwrap();
        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(relatives(&status), vec!["b.txt"]);

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent-a\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("b.txt")).unwrap(),
            "head-b\n"
        );
    }

    #[test]
    fn ensure_baselines_other_session_dirty_files() {
        let repo = tmp("ensure-baseline");
        if !init_git_commit(&repo.0, &[("plan.md", "old\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("plan.md"), "session-one\n").unwrap();
        record(&store, "s1", &cwd, &["plan.md"]);

        store.ensure("s2", &cwd).unwrap();
        assert!(store.status("s2", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn other_session_edits_do_not_appear_in_review() {
        let repo = tmp("two-sessions");
        if !init_git_commit(&repo.0, &[("plan.md", "old\n"), ("readme.md", "old\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("plan.md"), "session-one\n").unwrap();
        record(&store, "s1", &cwd, &["plan.md"]);
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["plan.md"]
        );

        store.ensure("s2", &cwd).unwrap();
        std::fs::write(repo.0.join("readme.md"), "session-two\n").unwrap();
        record(&store, "s2", &cwd, &["readme.md"]);

        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["plan.md"]
        );
        assert_eq!(
            relatives(&store.status("s2", &cwd).unwrap()),
            vec!["readme.md"]
        );

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("plan.md")).unwrap(),
            "old\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("readme.md")).unwrap(),
            "session-two\n"
        );
    }

    #[test]
    fn read_only_session_has_no_changes_when_another_session_edits() {
        let repo = tmp("read-only-session");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("writer", &cwd).unwrap();
        store.ensure("reader", &cwd).unwrap();

        store.prepare("writer", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "writer\n").unwrap();
        store.capture("writer", &cwd, &["app.ts".into()]).unwrap();

        assert_eq!(
            relatives(&store.status("writer", &cwd).unwrap()),
            vec!["app.ts"]
        );
        assert!(store.status("reader", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn status_counts_only_the_session_delta_from_its_pre_edit_snapshot() {
        let repo = tmp("session-counts");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("app.ts"), "user-one\nuser-two\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        store.prepare("s1", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "user-one\nuser-two\nagent\n").unwrap();
        store.capture("s1", &cwd, &["app.ts".into()]).unwrap();

        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].additions, 1);
        assert_eq!(status.files[0].deletions, 0);
        assert!(status.files[0].exact);
        assert!(status.files[0].undoable);
        assert_eq!(status.files[0].path, path_to_js(&repo.0.join("app.ts")));

        let diff = store.file_diff("s1", &cwd, "app.ts").unwrap();
        assert_eq!(diff.original, "user-one\nuser-two\n");
        assert_eq!(diff.current, "user-one\nuser-two\nagent\n");
        assert_eq!(diff.path, path_to_js(&repo.0.join("app.ts")));

        // Review remains the captured session result, not a later shared
        // working-tree state.
        std::fs::write(repo.0.join("app.ts"), "user-one\nuser-two\nagent\nother\n").unwrap();
        let diff = store.file_diff("s1", &cwd, "app.ts").unwrap();
        assert_eq!(diff.current, "user-one\nuser-two\nagent\n");
    }

    #[test]
    fn shared_file_keeps_session_scoped_review_but_disables_unsafe_undo() {
        let repo = tmp("shared-file");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        store.ensure("s2", &cwd).unwrap();

        store.prepare("s1", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "session-one\n").unwrap();
        store.capture("s1", &cwd, &["app.ts".into()]).unwrap();

        store.prepare("s2", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "session-one\nsession-two\n").unwrap();
        store.capture("s2", &cwd, &["app.ts".into()]).unwrap();

        let s1 = store.status("s1", &cwd).unwrap();
        let s2 = store.status("s2", &cwd).unwrap();
        assert!(s1.files[0].exact);
        assert!(s2.files[0].exact);
        assert_eq!((s1.files[0].additions, s1.files[0].deletions), (1, 1));
        assert_eq!((s2.files[0].additions, s2.files[0].deletions), (1, 0));
        assert!(!s1.files[0].undoable);
        assert!(!s2.files[0].undoable);
        let s1_diff = store.file_diff("s1", &cwd, "app.ts").unwrap();
        assert_eq!(s1_diff.original, "head\n");
        assert_eq!(s1_diff.current, "session-one\n");
        let s2_diff = store.file_diff("s2", &cwd, "app.ts").unwrap();
        assert_eq!(s2_diff.original, "session-one\n");
        assert_eq!(s2_diff.current, "session-one\nsession-two\n");
        assert!(store.undo("s1", &cwd, None).is_err());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("app.ts")).unwrap(),
            "session-one\nsession-two\n"
        );

        // Accepting s1 releases its ownership without touching the file. The
        // second session can then safely undo back to the contents it started
        // from, preserving s1's accepted line.
        store.keep("s1", &cwd, None).unwrap();
        assert!(store.status("s2", &cwd).unwrap().files[0].undoable);
        store.undo("s2", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("app.ts")).unwrap(),
            "session-one\n"
        );
    }

    #[test]
    fn undo_refuses_a_file_changed_after_the_session_edit() {
        let repo = tmp("changed-after");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        store.prepare("s1", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "agent\n").unwrap();
        store.capture("s1", &cwd, &["app.ts".into()]).unwrap();

        std::fs::write(repo.0.join("app.ts"), "agent\nother\n").unwrap();

        assert!(!store.status("s1", &cwd).unwrap().files[0].undoable);
        assert!(store.undo("s1", &cwd, None).is_err());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("app.ts")).unwrap(),
            "agent\nother\n"
        );
    }

    #[test]
    fn capture_missing_path_lets_non_git_undo_delete() {
        let project = tmp("nongit");
        let cwd = project.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        store
            .prepare(
                "s1",
                &cwd,
                &[project.0.join("made.txt").to_string_lossy().into_owned()],
            )
            .unwrap();
        std::fs::write(project.0.join("made.txt"), "hello\n").unwrap();
        store
            .capture(
                "s1",
                &cwd,
                &[project.0.join("made.txt").to_string_lossy().into_owned()],
            )
            .unwrap();
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["made.txt"]
        );
        store.undo("s1", &cwd, None).unwrap();
        assert!(!project.0.join("made.txt").exists());
    }

    #[test]
    fn late_capture_is_not_attributed_to_the_session() {
        let repo = tmp("late-capture");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent\n").unwrap();
        store.capture("s1", &cwd, &["a.txt".into()]).unwrap();
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );

        // A later structured edit in that same session replaces the
        // untrusted completion-only claim with a real boundary.
        store.ensure("s1", &cwd).unwrap();
        store.capture("s1", &cwd, &["a.txt".into()]).unwrap();
        store.prepare("s1", &cwd, &["a.txt".into()]).unwrap();
        std::fs::write(repo.0.join("a.txt"), "same-session-valid\n").unwrap();
        store.capture("s1", &cwd, &["a.txt".into()]).unwrap();
        assert!(store.status("s1", &cwd).unwrap().files[0].undoable);
        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );

        // An old/unprepared claim is not ownership and must not block a later
        // session that recorded a trustworthy before/after pair.
        store.ensure("s2", &cwd).unwrap();
        store.prepare("s2", &cwd, &["a.txt".into()]).unwrap();
        std::fs::write(repo.0.join("a.txt"), "second-session\n").unwrap();
        store.capture("s2", &cwd, &["a.txt".into()]).unwrap();
        assert!(store.status("s2", &cwd).unwrap().files[0].undoable);
        store.undo("s2", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );
    }

    #[test]
    fn committed_session_changes_leave_review() {
        let repo = tmp("committed");
        if !init_git_commit(&repo.0, &[("edit.txt", "head\n"), ("delete.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();

        std::fs::write(repo.0.join("edit.txt"), "agent\n").unwrap();
        std::fs::write(repo.0.join("created.txt"), "new\n").unwrap();
        std::fs::remove_file(repo.0.join("delete.txt")).unwrap();
        record(
            &store,
            "s1",
            &cwd,
            &["edit.txt", "created.txt", "delete.txt"],
        );
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["created.txt", "delete.txt", "edit.txt"]
        );

        assert!(git(&repo.0, &["add", "-A"]));
        assert!(git(&repo.0, &["commit", "-m", "agent changes"]));
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn deleting_untracked_baseline_still_needs_review() {
        let repo = tmp("delete-untracked");
        if !init_git_commit(&repo.0, &[("tracked.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("loose.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();

        std::fs::remove_file(repo.0.join("loose.txt")).unwrap();
        record(&store, "s1", &cwd, &["loose.txt"]);
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["loose.txt"]
        );
    }

    #[test]
    fn session_stats_match_git_not_edit_churn() {
        let repo = tmp("stats-churn");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();

        std::fs::write(repo.0.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);
        std::fs::write(repo.0.join("a.txt"), "head\nworld\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);

        let stats = store.stats_for_sessions(&cwd, &["s1".into()]).unwrap();
        let s1 = stats.get("s1").expect("s1 stats");
        assert_eq!(s1.files, 1);
        assert_eq!(s1.additions, 1);
        assert_eq!(s1.deletions, 0);
    }

    #[test]
    fn session_stats_are_scoped_to_touched_files() {
        let repo = tmp("stats-scoped");
        if !init_git_commit(&repo.0, &[("a.txt", "a\n"), ("b.txt", "b\n")]) {
            return;
        }
        std::fs::write(repo.0.join("b.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();

        std::fs::write(repo.0.join("a.txt"), "a\nA\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);

        let stats = store.stats_for_sessions(&cwd, &["s1".into()]).unwrap();
        let s1 = stats.get("s1").expect("s1 stats");
        assert_eq!(s1.files, 1);
        assert_eq!(s1.additions, 1);
        assert_eq!(s1.deletions, 0);
        assert_eq!(relatives(&store.status("s1", &cwd).unwrap()), vec!["a.txt"]);
    }

    #[cfg(unix)]
    pub(crate) fn verify_wsl_integration(cwd: &str) {
        use std::os::unix::fs::PermissionsExt;
        let host = wsl::location(cwd).unwrap().unwrap();
        let source = PathBuf::from(&host.path).join("checkpoint-apply-source");
        let target = PathBuf::from(&host.path).join("checkpoint-apply-target");
        std::fs::create_dir(&source).unwrap();
        assert!(init_git_commit(
            &source,
            &[
                ("script.sh", "head\n"),
                ("mode.sh", "same\n"),
                ("deleted.txt", "head\n")
            ]
        ));
        assert!(git(
            &source,
            &["clone", source.to_str().unwrap(), target.to_str().unwrap()]
        ));
        std::fs::write(source.join("script.sh"), "baseline\n").unwrap();
        std::fs::write(target.join("script.sh"), "baseline\n").unwrap();
        let from = host.with_path(source.to_str().unwrap()).unwrap().identity();
        let to = host.with_path(target.to_str().unwrap()).unwrap().identity();
        let (_dir, store) = store();
        store.ensure("guest-worker", &from).unwrap();
        assert!(store.cleanup_safe("guest-worker", &from).unwrap());
        let files = vec!["script.sh".into(), "mode.sh".into(), "deleted.txt".into()];
        store.prepare("guest-worker", &from, &files).unwrap();
        std::fs::write(source.join("script.sh"), "worker result\n").unwrap();
        for file in ["script.sh", "mode.sh"] {
            std::fs::set_permissions(source.join(file), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        std::fs::remove_file(source.join("deleted.txt")).unwrap();
        store.capture("guest-worker", &from, &files).unwrap();
        assert!(!store.cleanup_safe("guest-worker", &from).unwrap());
        assert!(store
            .status("guest-worker", &from)
            .unwrap()
            .files
            .iter()
            .any(|file| file.relative == "mode.sh" && file.undoable));
        assert_eq!(
            store.apply("guest-worker", &from, &to).unwrap().files.len(),
            3
        );
        assert_eq!(
            std::fs::read_to_string(target.join("script.sh")).unwrap(),
            "worker result\n"
        );
        assert!(!target.join("deleted.txt").exists());
        for file in ["script.sh", "mode.sh"] {
            assert_eq!(
                std::fs::metadata(target.join(file))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
        assert_eq!(
            store
                .apply("guest-worker", &from, &to)
                .unwrap()
                .already_applied,
            3
        );
        let outside = PathBuf::from(&host.path).join("outside-checkpoint.txt");
        std::fs::write(&outside, "untouched").unwrap();
        std::fs::remove_file(target.join("script.sh")).unwrap();
        std::os::unix::fs::symlink(&outside, target.join("script.sh")).unwrap();
        assert!(store
            .apply("guest-worker", &from, &to)
            .unwrap_err()
            .contains("symbolic link"));
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "untouched");
        let other = wsl::Location::new("OtherDistribution", source.to_str().unwrap()).unwrap();
        assert!(store
            .apply("guest-worker", &from, &other.identity())
            .unwrap_err()
            .contains("same execution host"));
        crate::worktrees::tests::verify_wsl_seeded(&from);
        store.undo("guest-worker", &from, Some("mode.sh")).unwrap();
        assert_eq!(
            std::fs::metadata(source.join("mode.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        std::fs::remove_file(source.join("script.sh")).unwrap();
        std::os::unix::fs::symlink(&outside, source.join("script.sh")).unwrap();
        assert!(restore_snapshot(
            &store.session_dir("guest-worker"),
            Path::new(&from),
            "script.sh",
            SnapshotKind::Contents,
            true
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "untouched");
    }

    #[cfg(unix)]
    #[test]
    fn legacy_checkpoint_modes_are_not_inferred_from_blob_permissions() {
        use std::os::unix::fs::PermissionsExt;
        for legacy in [true, false] {
            let source = tmp("mode-compatibility");
            assert!(init_git_commit(&source.0, &[("script.sh", "head\n")]));
            let file = source.0.join("script.sh");
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            let from = source.0.to_string_lossy().into_owned();
            let (_dir, store) = store();
            store.ensure("compat", &from).unwrap();
            store
                .prepare("compat", &from, &["script.sh".into()])
                .unwrap();
            let dir = store.session_dir("compat");
            if legacy {
                let path = dir.join("manifest.json");
                let mut saved: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                saved.as_object_mut().unwrap().remove("modeFormat");
                std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
                // Old builds created ordinary 0644 blobs for executable files.
                std::fs::set_permissions(
                    dir.join("files/script.sh"),
                    std::fs::Permissions::from_mode(0o644),
                )
                .unwrap();
            } else {
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
            std::fs::write(&file, "worker\n").unwrap();
            store
                .capture("compat", &from, &["script.sh".into()])
                .unwrap();
            assert!(store
                .status("compat", &from)
                .unwrap()
                .files
                .iter()
                .any(|file| file.undoable));
            if legacy {
                assert!(!store.cleanup_safe("compat", &from).unwrap());
            }
            store.undo("compat", &from, Some("script.sh")).unwrap();
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "head\n");
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn checkpoint_mode_only_review_undo_and_symlink_rejection() {
        use std::os::unix::fs::PermissionsExt;
        let source = tmp("mode-review");
        assert!(init_git_commit(&source.0, &[("script.sh", "head\n")]));
        let from = source.0.to_string_lossy().into_owned();
        let (_dir, store) = store();
        store.ensure("mode", &from).unwrap();
        store.prepare("mode", &from, &["script.sh".into()]).unwrap();
        std::fs::set_permissions(
            source.0.join("script.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        store.capture("mode", &from, &["script.sh".into()]).unwrap();
        assert!(store
            .status("mode", &from)
            .unwrap()
            .files
            .iter()
            .any(|file| file.relative == "script.sh" && file.undoable));
        store.undo("mode", &from, Some("script.sh")).unwrap();
        assert_eq!(
            std::fs::metadata(source.0.join("script.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        store.prepare("mode", &from, &["script.sh".into()]).unwrap();
        let outside = source.0.join("outside");
        std::fs::write(&outside, "untouched").unwrap();
        std::fs::remove_file(source.0.join("script.sh")).unwrap();
        std::os::unix::fs::symlink(&outside, source.0.join("script.sh")).unwrap();
        assert!(restore_snapshot(
            &store.session_dir("mode"),
            &source.0,
            "script.sh",
            SnapshotKind::Contents,
            true
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "untouched");
    }

    #[test]
    fn isolated_worker_delta_applies_idempotently_to_matching_baseline() {
        let source = tmp("apply-source");
        let target = tmp("apply-target");
        if !init_git_commit(&source.0, &[("a.txt", "head\n")]) {
            return;
        }
        let source_path = source.0.to_string_lossy().into_owned();
        let target_path = target.0.to_string_lossy().into_owned();
        if !git(&source.0, &["clone", &source_path, &target_path]) {
            return;
        }
        std::fs::write(source.0.join("a.txt"), "user baseline\n").unwrap();
        std::fs::write(target.0.join("a.txt"), "user baseline\n").unwrap();
        let from = source.0.to_string_lossy().into_owned();
        let to = target.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("worker", &from).unwrap();
        assert!(store.cleanup_safe("worker", &from).unwrap());
        store.prepare("worker", &from, &["a.txt".into()]).unwrap();
        std::fs::write(source.0.join("a.txt"), "worker result\n").unwrap();
        store.capture("worker", &from, &["a.txt".into()]).unwrap();
        assert!(!store.cleanup_safe("worker", &from).unwrap());

        let applied = store.apply("worker", &from, &to).unwrap();
        assert_eq!(applied.files, ["a.txt"]);
        assert_eq!(applied.already_applied, 0);
        assert_eq!(
            std::fs::read_to_string(target.0.join("a.txt")).unwrap(),
            "worker result\n"
        );
        let retried = store.apply("worker", &from, &to).unwrap();
        assert_eq!(retried.already_applied, 1);
    }

    #[test]
    fn missing_checkpoint_contents_never_become_an_absent_baseline() {
        for blob in ["files/a.txt", "after/a.txt"] {
            let source = tmp("missing-blob-source");
            let target = tmp("missing-blob-target");
            assert!(init_git_commit(&source.0, &[("a.txt", "head\n")]));
            let from = source.0.to_string_lossy().into_owned();
            let to = target.0.to_string_lossy().into_owned();
            assert!(git(&source.0, &["clone", &from, &to]));
            let (_root, store) = store();
            store.ensure("worker", &from).unwrap();
            store.prepare("worker", &from, &["a.txt".into()]).unwrap();
            std::fs::write(source.0.join("a.txt"), "worker\n").unwrap();
            store.capture("worker", &from, &["a.txt".into()]).unwrap();
            std::fs::remove_file(store.session_dir("worker").join(blob)).unwrap();
            std::fs::remove_file(target.0.join("a.txt")).unwrap();
            assert!(store.apply("worker", &from, &to).is_err());
            assert!(!target.0.join("a.txt").exists());
            assert_eq!(
                std::fs::read_to_string(source.0.join("a.txt")).unwrap(),
                "worker\n"
            );
            assert!(!store.cleanup_safe("worker", &from).unwrap());
        }
    }

    #[test]
    fn isolated_worker_integration_keeps_both_sides_on_conflict_or_unknown_edit() {
        let source = tmp("apply-conflict-source");
        let target = tmp("apply-conflict-target");
        if !init_git_commit(&source.0, &[("a.txt", "head\n")]) {
            return;
        }
        let source_path = source.0.to_string_lossy().into_owned();
        let target_path = target.0.to_string_lossy().into_owned();
        if !git(&source.0, &["clone", &source_path, &target_path]) {
            return;
        }
        let from = source.0.to_string_lossy().into_owned();
        let to = target.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("worker", &from).unwrap();
        store.prepare("worker", &from, &["a.txt".into()]).unwrap();
        std::fs::write(source.0.join("a.txt"), "worker\n").unwrap();
        store.capture("worker", &from, &["a.txt".into()]).unwrap();
        std::fs::write(target.0.join("a.txt"), "lead changed\n").unwrap();

        let conflict = store.apply("worker", &from, &to).unwrap_err();
        assert!(conflict.contains("lead checkout changed"));
        assert_eq!(
            std::fs::read_to_string(source.0.join("a.txt")).unwrap(),
            "worker\n"
        );
        assert_eq!(
            std::fs::read_to_string(target.0.join("a.txt")).unwrap(),
            "lead changed\n"
        );

        std::fs::write(source.0.join("unreported.txt"), "unknown\n").unwrap();
        assert!(!store.cleanup_safe("worker", &from).unwrap());
        assert!(store
            .apply("worker", &from, &to)
            .unwrap_err()
            .contains("not captured"));
    }

    #[test]
    fn rejects_invalid_session_id() {
        let err = validate_id("../x", "session").unwrap_err();
        assert!(err.contains("Invalid"));
    }

    #[test]
    fn fast_checkpoint_preserves_dirty_paths_and_head_ownership() {
        let repo = tmp("fast-paths");
        assert!(init_git_commit(
            &repo.0,
            &[
                ("dirty.txt", "head\n"),
                ("deleted.txt", "head\n"),
                ("rename.txt", "head\n"),
                ("parked.txt", "head\n"),
                ("nested/spaced ü.txt", "head\n")
            ]
        ));
        std::fs::write(repo.0.join("dirty.txt"), "user dirty\n").unwrap();
        std::fs::remove_file(repo.0.join("deleted.txt")).unwrap();
        assert!(git(&repo.0, &["mv", "rename.txt", "renamed.txt"]));
        std::fs::write(repo.0.join("new.txt"), "user untracked\n").unwrap();
        std::fs::write(repo.0.join("staged.txt"), "user staged\n").unwrap();
        assert!(git(&repo.0, &["add", "staged.txt"]));
        assert!(git(
            &repo.0,
            &["update-index", "--skip-worktree", "parked.txt"]
        ));
        std::fs::write(repo.0.join("parked.txt"), "kept local\n").unwrap();
        std::fs::write(repo.0.join("nested/spaced ü.txt"), "nested dirty\n").unwrap();
        let expected: Vec<_> = git_diff_files_for(&repo.0)
            .files
            .into_iter()
            .map(|file| file.relative)
            .collect();
        assert_eq!(git_checkpoint_paths(&repo.0), expected);
        let (_dir, store) = store();
        let cwd = repo.0.to_string_lossy();
        store.ensure("s", &cwd).unwrap();
        let manifest = read_manifest(&store.session_dir("s")).unwrap().unwrap();
        assert_eq!(manifest.files.keys().cloned().collect::<Vec<_>>(), expected);
        assert_eq!(
            manifest.tracked,
            BTreeSet::from([
                "deleted.txt".into(),
                "dirty.txt".into(),
                "nested/spaced ü.txt".into(),
                "rename.txt".into()
            ])
        );
        store
            .ensure("nested", &repo.0.join("nested").to_string_lossy())
            .unwrap();
        let nested = read_manifest(&store.session_dir("nested"))
            .unwrap()
            .unwrap();
        assert!(nested.tracked.contains("spaced ü.txt"));
        record(&store, "s", &cwd, &["dirty.txt", "new.txt"]);
        assert_eq!(
            std::fs::read_to_string(repo.0.join("parked.txt")).unwrap(),
            "kept local\n"
        );
    }

    #[test]
    fn fast_checkpoint_handles_unborn_head() {
        let repo = tmp("unborn-fast");
        assert!(git(&repo.0, &["init"]));
        std::fs::write(repo.0.join("new.txt"), "before\n").unwrap();
        assert_eq!(git_checkpoint_paths(&repo.0), vec!["new.txt"]);
        let (_dir, store) = store();
        store.ensure("s", &repo.0.to_string_lossy()).unwrap();
        let manifest = read_manifest(&store.session_dir("s")).unwrap().unwrap();
        assert!(manifest.tracked.is_empty());
        assert_eq!(manifest.files.len(), 1);
    }

    #[test]
    #[ignore = "release-mode filesystem benchmark; writes disposable repositories"]
    fn checkpoint_send_latency_benchmark() {
        let mut samples = Vec::new();
        for (name, count, untracked) in [
            ("clean", 0, false),
            ("50-dirty", 50, false),
            ("250-dirty", 250, false),
            ("250-untracked", 250, true),
        ] {
            let repo = tmp(name);
            let original = "original content line\n".repeat(2048);
            let names: Vec<_> = (0..count).map(|i| format!("file-{i:04}.txt")).collect();
            let files: Vec<_> = names
                .iter()
                .map(|name| (name.as_str(), original.as_str()))
                .collect();
            assert!(init_git_commit(
                &repo.0,
                if untracked || count == 0 {
                    &[("seed.txt", "seed\n")]
                } else {
                    &files
                }
            ));
            for name in &names {
                std::fs::write(repo.0.join(name), format!("changed\n{original}")).unwrap();
            }
            let cwd = repo.0.to_string_lossy().into_owned();
            for run in 0..10 {
                let (_dir, store) = store();
                let start = std::time::Instant::now();
                store
                    .exclusive("bench", &cwd, |store| store.ensure("bench", &cwd))
                    .unwrap();
                let initial_ms = start.elapsed().as_secs_f64() * 1000.0;
                let start = std::time::Instant::now();
                store
                    .exclusive("bench", &cwd, |store| store.ensure("bench", &cwd))
                    .unwrap();
                let warm_ms = start.elapsed().as_secs_f64() * 1000.0;
                let manifest = read_manifest(&store.session_dir("bench")).unwrap().unwrap();
                assert_eq!(manifest.files.len(), count);
                samples.push(serde_json::json!({"case":name,"run":run,"initialMs":initial_ms,"warmMs":warm_ms}));
            }
        }
        let path =
            std::env::var("MONOCODE_CHECKPOINT_BENCH_JSON").expect("set measurement output path");
        std::fs::write(path, serde_json::to_vec_pretty(&samples).unwrap()).unwrap();
    }
}
