//! Resource-manager adapter over upstream-owned PTYs. No independent process
//! registry, polling thread or terminal lifecycle; only explicit UI requests.
use super::{LivePty, PtyHost};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyResource {
    id: String,
    generation: Option<String>,
    alive: bool,
    cpu_pct: Option<f32>,
    rss_bytes: Option<u64>,
    processes: Option<u32>,
    workload: bool,
    top: Option<String>,
    error: Option<String>,
}

fn owned(live: &LivePty, owner: &str, generation: &str) -> bool {
    live.owner == owner && live.generation == generation
}

fn current(host: &PtyHost, id: &str, live: &Arc<LivePty>) -> bool {
    host.get(id).is_some_and(|value| Arc::ptr_eq(&value, live))
}

#[tauri::command(async)]
pub(crate) fn pty_resources(
    window: tauri::Window,
    host: State<'_, PtyHost>,
    ids: Vec<String>,
) -> Result<Vec<PtyResource>, String> {
    if ids.len() > 1024 || ids.iter().any(|id| id.is_empty() || id.len() > 256) {
        return Err("Too many or invalid terminal identities".into());
    }
    let mut seen = HashSet::new();
    let live: Vec<_> = ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .map(|id| {
            let entry = host.get(&id).filter(|live| live.owner == window.label());
            (id, entry)
        })
        .collect();
    let roots: Vec<_> = live
        .iter()
        .filter_map(|(_, live)| live.as_ref())
        .map(|live| live.pid)
        .filter(|pid| *pid > 1)
        .collect();
    let native = crate::proc_stats::sample_trees(&roots);
    Ok(live
        .into_iter()
        .map(|(id, live)| {
            let live = live.filter(|live| current(&host, &id, live));
            let mut row = PtyResource {
                id,
                generation: live.as_ref().map(|live| live.generation.clone()),
                alive: live.is_some(),
                cpu_pct: None,
                rss_bytes: None,
                processes: None,
                workload: false,
                top: None,
                error: None,
            };
            let Some(live) = live else {
                return row;
            };
            if live.process_started.is_none()
                || crate::proc_stats::identity(live.pid).ok().flatten() != live.process_started
            {
                row.error =
                    Some("Terminal process identity is unavailable or changed; refresh".into());
            } else {
                match &native {
                    Ok(stats) => {
                        if let Some(stat) = stats.get(&live.pid) {
                            row.cpu_pct = stat.cpu_pct;
                            row.rss_bytes = stat.rss_bytes;
                            row.processes = Some(stat.processes);
                            row.workload = stat.workload;
                            row.top = stat.top.clone();
                        } else {
                            row.error = Some("Process exited or cannot be sampled; refresh".into());
                        }
                    }
                    Err(error) => row.error = Some(error.clone()),
                }
            }
            row
        })
        .collect())
}

#[tauri::command(async)]
pub(crate) fn pty_kill_workload(
    window: tauri::Window,
    host: State<'_, PtyHost>,
    id: String,
    generation: String,
) -> Result<(), String> {
    let live = host.get(&id).ok_or("Terminal is not running")?;
    if !owned(&live, window.label(), &generation) {
        return Err("Terminal identity changed; refresh before stopping".into());
    }
    let started = live
        .process_started
        .ok_or("Terminal process identity is unavailable; nothing was stopped")?;
    crate::proc_stats::stop_workload(live.pid, started, || current(&host, &id, &live))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[test]
    fn ownership_requires_window_and_current_spawn_generation() {
        let host = PtyHost::new();
        let make = |generation: &str| {
            Arc::new(LivePty {
                owner: "window-a".into(),
                generation: generation.into(),
                process_started: None,
                cwd: "/fixture".into(),
                writer: Mutex::new(Box::new(std::io::sink())),
                master_fd: -1,
                pid: 0,
            })
        };
        let first = make("spawn-a");
        host.insert("terminal".into(), first.clone());
        assert!(owned(&first, "window-a", "spawn-a"));
        assert!(!owned(&first, "window-b", "spawn-a"));
        assert!(!owned(&first, "window-a", "spawn-b"));
        assert!(current(&host, "terminal", &first));
        host.insert("terminal".into(), make("spawn-b"));
        assert!(!current(&host, "terminal", &first));
        host.remove("terminal");
    }
}
