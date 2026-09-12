//! Target-scoped "is this checkout busy" evidence for worktree removal.
//!
//! Removal used to refuse while any agent or terminal was alive anywhere.
//! Ownership is recorded at spawn instead: an agent child or PTY belongs to
//! the working directory it was started in. Stream-only sessions (SSE readers
//! with no local child) bind through their saved session's effective
//! checkout. Saved-command runs report through the same aggregate once the
//! command host exists.
//!
//! `owns_path` never mixes hosts: a Windows path cannot own a WSL process
//! cwd and vice versa, and an unparsable path is never evidence.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::harness::HarnessHost;
use crate::pty::PtyHost;
use crate::session_store::SessionStore;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundProcess {
    /// `agent` | `terminal`; further kinds arrive with later process hosts.
    pub kind: &'static str,
    /// Session id for agents, PTY id for terminals.
    pub id: String,
    /// Spawn-time working directory — the recorded binding.
    pub cwd: String,
    pub label: String,
}

fn inside(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches('/');
    !root.is_empty() && (path == root || path.starts_with(&format!("{root}/")))
}

/// Canonical comparison key for a host path. Missing paths still get a key —
/// their processes are gone, and the comparison stays well-defined.
fn host_key(path: &str) -> String {
    let expanded = super::expand_home(path);
    let text = expanded
        .canonicalize()
        .map(|path| super::worktrees::path_to_js(&path))
        .unwrap_or_else(|_| super::path_to_js(&expanded));
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// The target's comparison key, computed once per collection so each
/// candidate only canonicalizes itself.
enum TargetKey {
    Wsl { distribution: String, path: String },
    Host(String),
}

fn target_key(target: &str) -> Option<TargetKey> {
    match crate::wsl::location(target) {
        Ok(Some(location)) => Some(TargetKey::Wsl {
            distribution: location.distribution,
            path: location.path,
        }),
        Ok(None) => Some(TargetKey::Host(host_key(target))),
        Err(_) => None,
    }
}

fn owns_key(target: &TargetKey, path: &str) -> bool {
    match (target, crate::wsl::location(path)) {
        (
            TargetKey::Wsl {
                distribution,
                path: root,
            },
            Ok(Some(location)),
        ) => {
            distribution.eq_ignore_ascii_case(&location.distribution)
                && inside(root, &location.path)
        }
        (TargetKey::Host(root), Ok(None)) => inside(root, &host_key(path)),
        _ => false,
    }
}

/// True when `path` is the target checkout or a directory inside it, on the
/// same execution host. Cross-host and unparsable paths are not evidence.
/// `collect` inlines this via `owns_key` so the target key is computed once.
#[cfg(test)]
pub fn owns_path(target: &str, path: &str) -> bool {
    match target_key(target) {
        Some(key) => owns_key(&key, path),
        None => false,
    }
}

fn session_row(store: &SessionStore, id: &str) -> Option<(String, String)> {
    let conn = store.lock_conn().ok()?;
    conn.query_row(
        "SELECT title, COALESCE(NULLIF(worktree_cwd, ''), cwd) FROM sessions WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .ok()
}

fn agent_label(store: Option<&SessionStore>, id: &str) -> String {
    store
        .and_then(|store| session_row(store, id))
        .map(|(title, _)| title)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "Agent session".into())
}

/// Bound processes under `target` across every live process host. The
/// AppHandle wrapper resolves the managed hosts; `collect` takes them
/// directly so the owning boundary is unit-testable without a running app.
pub fn bound_processes(app: &AppHandle, target: &str) -> Vec<BoundProcess> {
    collect(
        &app.state::<HarnessHost>(),
        &app.state::<PtyHost>(),
        app.try_state::<SessionStore>()
            .map(|state| state.inner() as &SessionStore),
        target,
    )
}

pub(crate) fn collect(
    harness: &HarnessHost,
    pty: &PtyHost,
    store: Option<&SessionStore>,
    target: &str,
) -> Vec<BoundProcess> {
    let Some(target) = target_key(target) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (id, cwd) in harness.live_cwds() {
        if owns_key(&target, &cwd) {
            out.push(BoundProcess {
                kind: "agent",
                label: agent_label(store, &id),
                id,
                cwd,
            });
        }
    }
    // Stream-only sessions own no local child; their saved session checkout is
    // the binding evidence. A session already listed above is not repeated.
    for id in harness.sse_sessions() {
        if out.iter().any(|process| process.id == id) {
            continue;
        }
        let Some((title, cwd)) = store.and_then(|store| session_row(store, &id)) else {
            continue;
        };
        if owns_key(&target, &cwd) {
            out.push(BoundProcess {
                kind: "agent",
                label: if title.trim().is_empty() {
                    "Agent session".into()
                } else {
                    title
                },
                id,
                cwd,
            });
        }
    }
    for (id, cwd) in pty.live_cwds() {
        if owns_key(&target, &cwd) {
            out.push(BoundProcess {
                kind: "terminal",
                label: format!(
                    "Terminal · {}",
                    cwd.rsplit('/')
                        .next()
                        .filter(|name| !name.is_empty())
                        .unwrap_or(&cwd)
                ),
                id,
                cwd,
            });
        }
    }
    out
}

/// Stop exactly the processes evidence proved belong to the reviewed target.
/// The caller holds the worktree lifecycle write lock, so no spawn can join
/// mid-stop. Unknown kinds block rather than being guessed at.
pub fn stop_bound(app: &AppHandle, processes: &[BoundProcess]) -> Result<(), String> {
    stop_processes(
        &app.state::<HarnessHost>(),
        &app.state::<PtyHost>(),
        processes,
    )
}

pub(crate) fn stop_processes(
    harness: &HarnessHost,
    pty: &PtyHost,
    processes: &[BoundProcess],
) -> Result<(), String> {
    let mut failed = Vec::new();
    let mut stopped: Vec<(String, u32)> = Vec::new();
    for process in processes {
        let result = match process.kind {
            "agent" => harness.kill_id(&process.id),
            "terminal" => pty.kill_id(&process.id),
            // A bound process we cannot stop must block, not be skipped.
            kind => Err(format!("no stopper for process kind '{kind}'")),
        };
        match result {
            Ok(Some(pid)) => stopped.push((process.label.clone(), pid)),
            Ok(None) => {}
            Err(error) => failed.push(format!("{} ({error})", process.label)),
        }
    }
    // Signaling is asynchronous: a process ignoring SIGTERM stays inside the
    // reviewed tree until the escalation lands. Wait out that window and
    // report survivors rather than removing files under live work.
    let pids: Vec<u32> = stopped.iter().map(|(_, pid)| *pid).collect();
    let survivors = crate::harness::await_stopped(&pids);
    for (label, pid) in stopped {
        if survivors.contains(&pid) {
            failed.push(format!("{label} (pid {pid} still running)"));
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!("Could not stop: {}", failed.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owns_path_is_same_host_containment() {
        assert!(owns_path("/repo/child", "/repo/child"));
        assert!(owns_path("/repo/child", "/repo/child/sub/dir"));
        assert!(!owns_path("/repo/child", "/repo/childish"));
        assert!(!owns_path("/repo/child", "/repo"));
        assert!(!owns_path("/repo/child", "/other"));
        // Hosts never mix: neither direction is evidence.
        assert!(!owns_path("//wsl.localhost/Debian/repo", "/repo"));
        assert!(!owns_path("/repo", "//wsl.localhost/Debian/repo"));
        // WSL containment is per distribution.
        assert!(owns_path(
            "//wsl.localhost/Debian/repo",
            "//wsl.localhost/Debian/repo/sub"
        ));
        assert!(!owns_path(
            "//wsl.localhost/Debian/repo",
            "//wsl.localhost/Ubuntu/repo"
        ));
        assert!(!owns_path(
            "//wsl.localhost/Debian/repo",
            "//wsl.localhost/Debian/repo-sibling"
        ));
        // Unparsable input is not evidence.
        assert!(!owns_path("", "/repo"));
        assert!(!owns_path("/repo", ""));
    }

    #[cfg(unix)]
    #[test]
    fn bound_processes_cover_only_the_target_and_stop_is_scoped() {
        let base = std::env::temp_dir().join(format!(
            "monocode-occupancy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let target = base.join("target");
        let sibling = base.join("sibling");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let target = crate::fs::worktrees::path_to_js(&target.canonicalize().unwrap());
        let sibling = crate::fs::worktrees::path_to_js(&sibling.canonicalize().unwrap());

        let store = SessionStore::open_in_memory().unwrap();
        store
            .lock_conn()
            .unwrap()
            .execute(
                "INSERT INTO sessions (id,cwd,worktree_cwd,harness,model,runtime_mode,title,created_at,updated_at,has_user_message) VALUES ('streamed','/elsewhere',?1,'codex','test','supervised','Streamed agent',1,2,1)",
                [&target],
            )
            .unwrap();

        let harness = HarnessHost::new();
        let pty = PtyHost::new();
        let mut inside = harness.add_test_child("s-inside", &target);
        let mut outside = harness.add_test_child("s-outside", &sibling);
        harness.add_test_sse("streamed");
        harness.add_test_sse("unknown-stream"); // no session row — not evidence
        let mut term_inside = pty.add_test_pty("t-inside", &format!("{target}/sub"));
        let mut term_other = pty.add_test_pty("t-other", &sibling);
        // Real children are reaped by their owner threads; an unwaited test
        // child would stay a zombie and answer kill(pid, 0) during the wait.
        std::thread::spawn(move || {
            let _ = inside.wait();
        });
        std::thread::spawn(move || {
            let _ = term_inside.wait();
        });

        let bound = collect(&harness, &pty, Some(&store), &target);
        let ids: Vec<&str> = bound.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(bound.len(), 3);
        assert!(ids.contains(&"s-inside"));
        assert!(ids.contains(&"t-inside"));
        assert!(ids.contains(&"streamed"));
        assert!(bound
            .iter()
            .any(|p| p.kind == "agent" && p.label == "Streamed agent"));
        assert!(bound.iter().any(|p| p.label.starts_with("Terminal ·")));

        // Nothing in the sibling is bound to the target, and vice versa.
        let other = collect(&harness, &pty, Some(&store), &sibling);
        assert_eq!(
            other.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["s-outside", "t-other"]
        );

        // A kind no host can stop fails closed instead of being skipped.
        assert!(stop_processes(
            &harness,
            &pty,
            &[BoundProcess {
                kind: "command",
                id: "cmd-1".into(),
                cwd: target.clone(),
                label: "Saved command".into(),
            }],
        )
        .is_err());

        stop_processes(&harness, &pty, &bound).unwrap();
        assert!(harness.live_cwds().iter().all(|(id, _)| id != "s-inside"));
        assert!(pty.live_cwds().iter().all(|(id, _)| id != "t-inside"));
        assert!(!harness.sse_sessions().iter().any(|id| id == "streamed"));
        // An unbound stream is not stopped on another worktree's behalf.
        assert!(harness
            .sse_sessions()
            .iter()
            .any(|id| id == "unknown-stream"));
        // Work outside the reviewed target is untouched.
        assert_eq!(
            harness
                .live_cwds()
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["s-outside"]
        );
        assert_eq!(
            pty.live_cwds()
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["t-other"]
        );

        // Release the surviving children.
        let _ = outside.kill();
        let _ = outside.wait();
        let _ = term_other.kill();
        let _ = term_other.wait();
        let _ = std::fs::remove_dir_all(&base);
    }
}
