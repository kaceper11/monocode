//! Per-terminal process-tree resource sampling.
//!
//! One snapshot per poll is shared by every terminal row — unix forks a
//! single `ps`, Windows walks one ToolHelp listing and measures only the
//! pids inside terminal trees. CPU is a percentage of one core measured
//! between polls, so a multi-core process can exceed 100.
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default)]
pub struct ProcStat {
    pub cpu_pct: f32,
    pub rss_bytes: u64,
    pub processes: u32,
    /// Tree has members besides the root shell — killing the workload
    /// keeps the terminal alive.
    pub workload: bool,
    /// Name of the busiest non-root member — the row's process label.
    pub top: Option<String>,
}

struct ProcRow {
    pid: u32,
    ppid: u32,
    /// Cumulative CPU seconds — unix `cputime`, Windows FILETIME ticks/1e7.
    cpu_secs: f64,
    /// % of one core since the previous sample; filled by `apply_cpu_deltas`.
    cpu: f32,
    rss_bytes: u64,
    name: String,
}

fn build_children(rows: &[ProcRow]) -> (HashMap<u32, usize>, HashMap<u32, Vec<usize>>) {
    let mut index_of: HashMap<u32, usize> = HashMap::new();
    let mut children: HashMap<u32, Vec<usize>> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        index_of.entry(row.pid).or_insert(index);
        children.entry(row.ppid).or_default().push(index);
    }
    (index_of, children)
}

/// Every member of the tree rooted at `root`, root first. A malformed
/// `ppid == pid` row cannot loop the walk.
fn subtree(
    rows: &[ProcRow],
    index_of: &HashMap<u32, usize>,
    children: &HashMap<u32, Vec<usize>>,
    root: u32,
) -> Vec<usize> {
    let mut members = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        if !seen.insert(pid) {
            continue;
        }
        let Some(&index) = index_of.get(&pid) else {
            continue;
        };
        members.push(index);
        if let Some(kids) = children.get(&pid) {
            queue.extend(kids.iter().map(|&i| rows[i].pid));
        }
    }
    members
}

fn aggregate(rows: &[ProcRow], members: Vec<usize>, root: u32) -> ProcStat {
    let mut stat = ProcStat::default();
    let mut top: Option<(f32, u64, &str)> = None;
    for index in members {
        let row = &rows[index];
        stat.cpu_pct += row.cpu;
        stat.rss_bytes += row.rss_bytes;
        stat.processes += 1;
        if row.pid != root {
            let candidate = (row.cpu, row.rss_bytes, row.name.as_str());
            if top.is_none_or(|best| candidate > best) {
                top = Some(candidate);
            }
        }
    }
    stat.workload = stat.processes > 1;
    stat.top = top.map(|(_, _, name)| name.to_string());
    stat
}

/// Non-root pids in `root`'s tree — the workload `pty_kill_workload` stops.
pub fn descendants(root: u32) -> Vec<u32> {
    let Ok(rows) = snapshot() else {
        return Vec::new();
    };
    let (index_of, children) = build_children(&rows);
    subtree(&rows, &index_of, &children, root)
        .into_iter()
        .map(|index| rows[index].pid)
        .filter(|pid| *pid != root)
        .collect()
}

pub fn sample_trees(roots: &[u32]) -> HashMap<u32, ProcStat> {
    if roots.is_empty() {
        return HashMap::new();
    }
    let Ok(mut rows) = snapshot() else {
        return HashMap::new();
    };
    let (index_of, children) = build_children(&rows);
    let member_sets: Vec<Vec<usize>> = roots
        .iter()
        .map(|&root| subtree(&rows, &index_of, &children, root))
        .collect();
    let wanted: HashSet<u32> = member_sets
        .iter()
        .flatten()
        .map(|&index| rows[index].pid)
        .collect();
    measure(&mut rows, &wanted);
    apply_cpu_deltas(&mut rows, &wanted);
    roots
        .iter()
        .zip(member_sets)
        .map(|(&root, members)| (root, aggregate(&rows, members, root)))
        .collect()
}

/// % of one core between samples — `cpu_secs` deltas over wall time,
/// keyed by pid. Pid reuse shows as a negative delta and clamps to 0;
/// first paint reports 0 until a second sample lands.
fn apply_cpu_deltas(rows: &mut [ProcRow], wanted: &HashSet<u32>) {
    use std::sync::Mutex;
    use std::time::Instant;

    static PREV: Mutex<Option<HashMap<u32, (f64, Instant)>>> = Mutex::new(None);
    let now = Instant::now();
    let mut prev = PREV.lock().unwrap_or_else(|e| e.into_inner());
    let previous = prev.get_or_insert_with(HashMap::new);
    for row in rows.iter_mut().filter(|row| wanted.contains(&row.pid)) {
        // Unmeasured rows (a failed OpenProcess) keep the old baseline —
        // overwriting with NaN/0 would spike the next delta.
        if row.cpu_secs.is_nan() {
            continue;
        }
        if let Some((prev_secs, prev_at)) = previous.get(&row.pid) {
            let elapsed = now.duration_since(*prev_at).as_secs_f64();
            row.cpu = cpu_delta_pct(*prev_secs, row.cpu_secs, elapsed);
        }
        previous.insert(row.pid, (row.cpu_secs, now));
    }
    previous.retain(|pid, _| wanted.contains(pid));
}

/// CPU seconds burned per wall second since the last sample, as % of one
/// core. A stale baseline (panel closed for minutes) would dilute the
/// reading toward ~0 — treat it as a fresh sample; a sub-ms interval
/// would amplify jitter — report 0. Multi-core trees exceed 100%.
fn cpu_delta_pct(prev_secs: f64, cpu_secs: f64, elapsed: f64) -> f32 {
    if !(0.001..60.0).contains(&elapsed) {
        return 0.0;
    }
    ((cpu_secs - prev_secs).max(0.0) / elapsed * 100.0) as f32
}

// ---------- unix ----------

#[cfg(unix)]
fn snapshot() -> Result<Vec<ProcRow>, String> {
    // `comm` is the last column, so paths with spaces cannot skew the
    // numeric fields — LC_ALL keeps parsing identical in any locale.
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,cputime=,rss=,comm="])
        .env("LC_ALL", "C")
        .output()
        .map_err(|e| format!("Failed to sample processes: {e}"))?;
    if !output.status.success() {
        return Err("Failed to sample processes".into());
    }
    Ok(parse_ps(&String::from_utf8_lossy(&output.stdout)))
}

/// `[[dd-]hh:]mm:ss[.cc]` — BSD cputime lets minutes run past 60.
#[cfg(unix)]
fn parse_cputime(text: &str) -> Option<f64> {
    let (days, rest) = match text.split_once('-') {
        Some((d, r)) => (d.trim().parse::<f64>().ok()?, r),
        None => (0.0, text),
    };
    let mut parts = rest.split(':').rev();
    let mut total = parts.next()?.trim().parse::<f64>().ok()?;
    if let Some(mins) = parts.next() {
        total += mins.trim().parse::<f64>().unwrap_or(0.0) * 60.0;
    }
    if let Some(hours) = parts.next() {
        total += hours.trim().parse::<f64>().unwrap_or(0.0) * 3600.0;
    }
    Some(total + days * 86400.0)
}

/// `pid=,ppid=,cputime=,rss=,comm=` rows: `  417   415  0:03.20  84512 /usr/bin/vim`
#[cfg(unix)]
fn parse_ps(text: &str) -> Vec<ProcRow> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(cpu_secs), Some(rss)) = (
            fields.next().and_then(|v| v.parse::<u32>().ok()),
            fields.next().and_then(|v| v.parse::<u32>().ok()),
            fields.next().and_then(parse_cputime),
            fields.next().and_then(|v| v.parse::<u64>().ok()),
        ) else {
            continue;
        };
        let comm = fields.collect::<Vec<_>>().join(" ");
        if comm.is_empty() {
            continue;
        }
        // macOS reports the full executable path — keep the basename.
        let name = comm.rsplit('/').next().unwrap_or(&comm);
        rows.push(ProcRow {
            pid,
            ppid,
            cpu_secs,
            cpu: 0.0,
            rss_bytes: rss.saturating_mul(1024),
            name: name.to_string(),
        });
    }
    rows
}

/// `ps` already reports rss and cumulative cpu time for every row.
#[cfg(unix)]
fn measure(_rows: &mut [ProcRow], _wanted: &HashSet<u32>) {}

// ---------- windows ----------

#[cfg(windows)]
fn snapshot() -> Result<Vec<ProcRow>, String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if raw == INVALID_HANDLE_VALUE {
            return Err(format!(
                "Failed to sample processes: {}",
                std::io::Error::last_os_error()
            ));
        }
        let snap = OwnedHandle::from_raw_handle(raw);
        let mut rows = Vec::with_capacity(256);
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut ok = Process32FirstW(snap.as_raw_handle(), &mut entry);
        while ok != 0 {
            let end = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            rows.push(ProcRow {
                pid: entry.th32ProcessID,
                ppid: entry.th32ParentProcessID,
                cpu_secs: f64::NAN,
                cpu: 0.0,
                rss_bytes: 0,
                name: String::from_utf16_lossy(&entry.szExeFile[..end]),
            });
            ok = Process32NextW(snap.as_raw_handle(), &mut entry);
        }
        Ok(rows)
    }
}

/// Working set + CPU time exist only behind an `OpenProcess` handle, so they
/// are fetched just for the pids inside terminal trees — not system-wide.
/// `apply_cpu_deltas` turns the cumulative time into a per-poll percent.
#[cfg(windows)]
fn measure(rows: &mut [ProcRow], wanted: &HashSet<u32>) {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    for row in rows.iter_mut().filter(|row| wanted.contains(&row.pid)) {
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, row.pid) };
        if raw.is_null() {
            continue;
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of_val(&counters) as u32;
        if unsafe { GetProcessMemoryInfo(handle.as_raw_handle(), &mut counters, counters.cb) } != 0
        {
            row.rss_bytes = counters.WorkingSetSize as u64;
        }
        let (mut created, mut exited, mut kernel, mut user) = unsafe { std::mem::zeroed() };
        if unsafe {
            GetProcessTimes(
                handle.as_raw_handle(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            continue;
        }
        // FILETIME is 100ns — ticks/10M is CPU seconds used.
        row.cpu_secs = filetime(kernel).saturating_add(filetime(user)) as f64 / 10_000_000.0;
    }
}

#[cfg(windows)]
fn filetime(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    (value.dwHighDateTime as u64) << 32 | value.dwLowDateTime as u64
}

#[cfg(not(any(unix, windows)))]
fn snapshot() -> Result<Vec<ProcRow>, String> {
    Err("Process sampling is not supported on this platform.".into())
}

#[cfg(not(any(unix, windows)))]
fn measure(_rows: &mut [ProcRow], _wanted: &HashSet<u32>) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, cpu: f32, rss: u64, name: &str) -> ProcRow {
        ProcRow {
            pid,
            ppid,
            cpu_secs: 0.0,
            cpu,
            rss_bytes: rss,
            name: name.into(),
        }
    }

    #[test]
    fn subtree_collects_descendants_without_looping() {
        let rows = vec![
            row(1, 0, 0.0, 0, "init"),
            row(10, 1, 0.0, 0, "zsh"),
            row(11, 10, 0.0, 0, "node"),
            row(12, 11, 0.0, 0, "esbuild"),
            row(13, 13, 0.0, 0, "cycle"),
        ];
        let (index_of, children) = build_children(&rows);
        let members = subtree(&rows, &index_of, &children, 10);
        let pids: Vec<u32> = members.iter().map(|&i| rows[i].pid).collect();
        assert_eq!(pids, [10, 11, 12]);
        // A self-parented row terminates instead of looping.
        assert_eq!(subtree(&rows, &index_of, &children, 13).len(), 1);
    }

    #[test]
    fn aggregate_sums_the_tree_and_names_the_top_consumer() {
        let rows = vec![
            row(10, 1, 0.4, 20_000, "zsh"),
            row(11, 10, 12.0, 300_000, "node"),
            row(12, 11, 50.0, 80_000, "esbuild"),
        ];
        let stat = aggregate(&rows, vec![0, 1, 2], 10);
        assert_eq!(stat.processes, 3);
        assert!(stat.workload);
        assert!((stat.cpu_pct - 62.4).abs() < 0.001);
        assert_eq!(stat.rss_bytes, 400_000);
        assert_eq!(stat.top.as_deref(), Some("esbuild"));
    }

    #[test]
    fn aggregate_shell_only_tree_has_no_workload() {
        let rows = vec![row(10, 1, 0.1, 10_000, "zsh")];
        let stat = aggregate(&rows, vec![0], 10);
        assert!(!stat.workload);
        assert_eq!(stat.top, None);
    }

    #[cfg(unix)]
    #[test]
    fn parse_ps_reads_fixed_columns() {
        let text =
            "  417   415  0:03.20  84512 /usr/bin/vim\n    9     1  0:00.00   1204 zsh\nbad line\n";
        let rows = parse_ps(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].pid, 417);
        assert_eq!(rows[0].ppid, 415);
        assert!((rows[0].cpu_secs - 3.2).abs() < 0.001);
        assert_eq!(rows[0].rss_bytes, 84512 * 1024);
        assert_eq!(rows[0].name, "vim");
        // Paths with spaces are the last column — the basename survives.
        let spaced = parse_ps("  5     1  0:00.00  1024 /Applications/My App/app");
        assert_eq!(spaced[0].name, "app");
    }

    #[cfg(unix)]
    #[test]
    fn parse_cputime_handles_minutes_hours_and_days() {
        assert_eq!(parse_cputime("0:03.20"), Some(3.2));
        assert_eq!(parse_cputime("732:42.44"), Some(732.0 * 60.0 + 42.44));
        assert_eq!(parse_cputime("1:02:03.00"), Some(3723.0));
        assert_eq!(
            parse_cputime("2-03:04:05.50"),
            Some(2.0 * 86400.0 + 3.0 * 3600.0 + 245.5)
        );
        assert_eq!(parse_cputime("junk"), None);
    }

    #[test]
    fn cpu_delta_is_percent_of_one_core_over_the_interval() {
        // 1.5 cpu-secs over 1.5 wall secs → one full core.
        assert_eq!(cpu_delta_pct(10.0, 11.5, 1.5), 100.0);
        // 3 cpu-secs over 1.5 wall secs → two cores busy → >100%.
        assert_eq!(cpu_delta_pct(10.0, 13.0, 1.5), 200.0);
        // 0.75 cpu-secs over 1.5 wall secs → half a core.
        assert_eq!(cpu_delta_pct(0.0, 0.75, 1.5), 50.0);
    }

    #[test]
    fn cpu_delta_clamps_bad_intervals_and_pid_reuse() {
        // A pid recycled between samples reports a negative delta → 0.
        assert_eq!(cpu_delta_pct(500.0, 0.4, 1.5), 0.0);
        // A baseline older than the panel's lifetime dilutes to ~0 —
        // refresh instead of reporting a diluted reading.
        assert_eq!(cpu_delta_pct(10.0, 700.0, 600.0), 0.0);
        // Sub-millisecond intervals amplify scheduling jitter.
        assert_eq!(cpu_delta_pct(10.0, 10.1, 0.0005), 0.0);
    }
}
