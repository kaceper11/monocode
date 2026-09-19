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
    host: &'static str,
    distro: Option<String>,
    cpu_pct: Option<f32>,
    rss_bytes: Option<u64>,
    processes: Option<u32>,
    workload: bool,
    top: Option<String>,
    error: Option<String>,
}

#[cfg(any(windows, test))]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinuxResource {
    cpu_pct: Option<f32>,
    rss_bytes: Option<u64>,
    processes: Option<u32>,
    workload: bool,
    top: Option<String>,
    error: Option<String>,
}

#[cfg(windows)]
fn linux_resources(
    live: &[(String, Option<Arc<LivePty>>)],
) -> std::collections::HashMap<String, Result<LinuxResource, String>> {
    let mut locations =
        std::collections::HashMap::<String, (crate::wsl::Location, Vec<String>)>::new();
    for (_, live) in live {
        if let Some(live) = live {
            if let Ok(Some(location)) = crate::wsl::path_location(&live.cwd) {
                locations
                    .entry(location.distribution.to_lowercase())
                    .or_insert_with(|| (location, Vec::new()))
                    .1
                    .push(live.generation.clone());
            }
        }
    }
    let mut result = std::collections::HashMap::new();
    for (location, markers) in locations.into_values() {
        match crate::wsl::terminal_resources(&location, &markers) {
            Ok(mut found) => {
                for marker in markers {
                    result.insert(
                        marker.clone(),
                        found
                            .remove(&marker)
                            .ok_or_else(|| "Linux process sample is unavailable".to_string()),
                    );
                }
            }
            Err(error) => {
                for marker in markers {
                    result.insert(marker, Err(error.clone()));
                }
            }
        }
    }
    result
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
        .filter(|live| {
            crate::wsl::path_location(&live.cwd).is_ok_and(|location| location.is_none())
        })
        .map(|live| live.pid)
        .filter(|pid| *pid > 1)
        .collect();
    let native = crate::proc_stats::sample_trees(&roots);
    #[cfg(windows)]
    let mut linux = linux_resources(&live);
    Ok(live
        .into_iter()
        .map(|(id, live)| {
            let live = live.filter(|live| current(&host, &id, live));
            let mut row = PtyResource {
                id,
                generation: live.as_ref().map(|live| live.generation.clone()),
                alive: live.is_some(),
                host: "native",
                distro: None,
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
            match crate::wsl::path_location(&live.cwd) {
                Ok(Some(location)) => {
                    row.host = "wsl";
                    row.distro = Some(location.distribution);
                    // Never present launcher usage as Linux workload usage.
                    #[cfg(windows)]
                    match linux.remove(&live.generation) {
                        Some(Ok(stat)) => {
                            row.cpu_pct = stat.cpu_pct;
                            row.rss_bytes = stat.rss_bytes;
                            row.processes = stat.processes;
                            row.workload = stat.workload;
                            row.top = stat.top;
                            row.error = stat.error;
                        }
                        Some(Err(error)) => row.error = Some(error),
                        None => row.error = Some("Linux process sample is unavailable".into()),
                    }
                    #[cfg(not(windows))]
                    {
                        row.error = Some("WSL terminals require the native Windows app".into());
                    }
                }
                Err(error) => row.error = Some(error),
                Ok(None)
                    if live.process_started.is_none()
                        || crate::proc_stats::identity(live.pid).ok().flatten()
                            != live.process_started =>
                {
                    row.error =
                        Some("Terminal process identity is unavailable or changed; refresh".into());
                }
                Ok(None) => match &native {
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
                },
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
    if let Some(location) = crate::wsl::path_location(&live.cwd)? {
        if !current(&host, &id, &live) {
            return Err("Terminal identity changed; refresh".into());
        }
        #[cfg(windows)]
        return crate::wsl::terminal_stop_workload(&location, &live.generation);
        #[cfg(not(windows))]
        {
            let _ = location;
            return Err("WSL terminals require the native Windows app".into());
        }
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

#[cfg(test)]
mod linux_tests {
    use super::*;
    #[test]
    fn linux_unknown_fields_are_not_zero_measurements() {
        let row: LinuxResource = serde_json::from_str(r#"{"cpuPct":null,"rssBytes":null,"processes":null,"workload":false,"top":null,"error":"unavailable"}"#).unwrap();
        assert_eq!(
            (
                row.cpu_pct,
                row.rss_bytes,
                row.processes,
                row.workload,
                row.top,
                row.error
            ),
            (None, None, None, false, None, Some("unavailable".into()))
        );
    }

    #[test]
    fn linux_generation_root_and_pidfd_stopping_are_checked() {
        let fixture = r#"
from unittest.mock import patch
import types
marker = 'test-generation'
base = {'state':'S', 'started':10, 'cpu':5, 'rss':4096, 'root':10, 'name':'sh'}
members = {10:dict(base), 11:{**base,'started':11,'name':'sleep'}, 12:{**base,'started':12,'name':'node'}}
env = lambda pid: (marker, 10)
with patch.dict(globals(), {'_tr_snapshot':lambda markers:{marker:members}, '_tr_environment':env}):
    first = terminal_resource_request({'op':'terminal_resources','markers':[marker]})[marker]
    assert first['cpuPct'] is None and first['rssBytes'] == 12288 and first['processes'] == 3 and first['workload']
    # Root is explicit, not guessed from the oldest process or lowest PID.
    try:
        _tr_root(marker, {11:members[11]})
        assert False
    except ValueError:
        pass
    signals, closed = [], []
    stat = lambda pid: ({**members[pid], 'started':999} if pid == 12 else members[pid])
    class Poll:
        def __init__(self): self.fds = set()
        def register(self, fd, event): self.fds.add(fd)
        def unregister(self, fd): self.fds.remove(fd)
        def poll(self, delay): return [(fd, 1) for fd in self.fds]
    with patch.dict(globals(), {'_tr_stat':stat}), patch.object(_tr_os, 'pidfd_open', lambda pid:pid+100, create=True), patch.object(_tr_os, 'close', closed.append), patch.object(_tr_signal, 'pidfd_send_signal', lambda fd, sig:signals.append((fd,sig)), create=True), patch.object(_tr_select, 'poll', Poll):
        terminal_resource_request({'op':'terminal_stop_workload','marker':marker})
    assert signals == [(111, _tr_signal.SIGTERM)], signals
    assert sorted(closed) == [111,112], closed
for bad in ['', 'bad=value', 'space here', 'ą', 'a'*129, None]:
    try:
        terminal_resource_request({'op':'terminal_stop_workload','marker':bad})
        assert False
    except ValueError:
        pass
"#;
        let script = format!("{}\n{}", include_str!("terminal_resources.py"), fixture);
        let result = std::process::Command::new("python3")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
