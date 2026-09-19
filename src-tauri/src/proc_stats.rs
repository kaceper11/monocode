//! Per-terminal process-tree resource sampling.
//!
//! One snapshot per poll is shared by every terminal row — unix forks a
//! single `ps`, Windows walks one ToolHelp listing and measures only the
//! pids inside terminal trees. CPU is a percentage of one core measured
//! between polls, so a multi-core process can exceed 100.
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default)]
pub struct ProcStat {
    pub cpu_pct: Option<f32>,
    pub rss_bytes: Option<u64>,
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
    cpu: Option<f32>,
    rss_bytes: Option<u64>,
    started: String,
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
    let mut stat = ProcStat {
        cpu_pct: Some(0.0),
        rss_bytes: Some(0),
        ..ProcStat::default()
    };
    let mut top: Option<(f32, u64, &str)> = None;
    for index in members {
        let row = &rows[index];
        stat.cpu_pct = stat
            .cpu_pct
            .zip(row.cpu)
            .map(|(total, value)| total + value);
        stat.rss_bytes = stat
            .rss_bytes
            .zip(row.rss_bytes)
            .map(|(total, value)| total.saturating_add(value));
        stat.processes += 1;
        if row.pid != root {
            let candidate = (
                row.cpu.unwrap_or(0.0),
                row.rss_bytes.unwrap_or(0),
                row.name.as_str(),
            );
            if top.is_none_or(|best| candidate > best) {
                top = Some(candidate);
            }
        }
    }
    stat.workload = stat.processes > 1;
    stat.top = top.map(|(_, _, name)| name.to_string());
    stat
}

pub fn sample_trees(roots: &[u32]) -> Result<HashMap<u32, ProcStat>, String> {
    if roots.is_empty() {
        return Ok(HashMap::new());
    }
    let mut rows = snapshot()?;
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
    Ok(roots
        .iter()
        .zip(member_sets)
        .filter(|(_, members)| !members.is_empty())
        .map(|(&root, members)| (root, aggregate(&rows, members, root)))
        .collect())
}

/// % of one core between samples — `cpu_secs` deltas over wall time,
/// keyed by PID and start identity. Unmeasured/first samples stay unknown;
/// a reused PID never inherits the prior process CPU baseline.
fn apply_cpu_deltas(rows: &mut [ProcRow], wanted: &HashSet<u32>) {
    use std::sync::Mutex;
    use std::time::Instant;

    type Baselines = HashMap<u32, (String, f64, Instant)>;
    static PREV: Mutex<Option<Baselines>> = Mutex::new(None);
    let now = Instant::now();
    let mut prev = PREV.lock().unwrap_or_else(|e| e.into_inner());
    let previous = prev.get_or_insert_with(HashMap::new);
    for row in rows.iter_mut().filter(|row| wanted.contains(&row.pid)) {
        // Unmeasured rows (a failed OpenProcess) keep the old baseline —
        // overwriting with NaN/0 would spike the next delta.
        if row.cpu_secs.is_nan() {
            continue;
        }
        if let Some((started, prev_secs, prev_at)) = previous.get(&row.pid) {
            let elapsed = now.duration_since(*prev_at).as_secs_f64();
            if started == &row.started
                && (0.001..60.0).contains(&elapsed)
                && row.cpu_secs >= *prev_secs
            {
                row.cpu = Some(cpu_delta_pct(*prev_secs, row.cpu_secs, elapsed));
            }
        }
        previous.insert(row.pid, (row.started.clone(), row.cpu_secs, now));
    }
    // Separate windows sample different roots. Keep their recent baselines,
    // bounded to one minute and 32k entries; this cache owns no background work.
    previous.retain(|_, (_, _, at)| now.duration_since(*at).as_secs() < 60);
    if previous.len() > 32_768 {
        previous.clear();
    }
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
    let mut command = std::process::Command::new("/bin/ps");
    command
        .args(["-axo", "pid=,ppid=,cputime=,rss=,lstart=,comm="])
        .env("LC_ALL", "C");
    let output = crate::bounded_process::output(
        &mut command,
        std::time::Duration::from_secs(3),
        16 * 1024 * 1024,
    )?;
    if !output.status.success() {
        return Err("Failed to sample processes".into());
    }
    Ok(parse_ps(&String::from_utf8_lossy(&output.stdout)))
}

/// `[[dd-]hh:]mm:ss[.cc]` — BSD cputime lets minutes run past 60.
#[cfg(unix)]
fn parse_cputime(text: &str) -> Option<f64> {
    let number = |value: &str| {
        value
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0)
    };
    let (days, rest) = match text.split_once('-') {
        Some((days, rest)) => (number(days)?, rest),
        None => (0.0, text),
    };
    let mut parts = rest.split(':').rev();
    let mut total = number(parts.next()?)?;
    if let Some(mins) = parts.next() {
        total += number(mins)? * 60.0;
    }
    if let Some(hours) = parts.next() {
        total += number(hours)? * 3600.0;
    }
    total += days * 86400.0;
    (parts.next().is_none() && total.is_finite()).then_some(total)
}

/// `pid=,ppid=,cputime=,rss=,comm=` rows: `  417   415  0:03.20  84512 Sat Sep 19 12:00:00 2026 /usr/bin/vim`
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
        let started = fields.by_ref().take(5).collect::<Vec<_>>().join(" ");
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
            cpu: None,
            rss_bytes: Some(rss.saturating_mul(1024)),
            started,
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
                cpu: None,
                rss_bytes: None,
                started: String::new(),
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
            row.rss_bytes = Some(counters.WorkingSetSize as u64);
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
        row.started = filetime(created).to_string();
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
            cpu: Some(cpu),
            rss_bytes: Some(rss),
            started: "test-start".into(),
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
        assert!((stat.cpu_pct.unwrap() - 62.4).abs() < 0.001);
        assert_eq!(stat.rss_bytes, Some(400_000));
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
            "  417   415  0:03.20  84512 Sat Sep 19 12:00:00 2026 /usr/bin/vim\n    9     1  0:00.00   1204 Sat Sep 19 12:00:00 2026 zsh\nbad line\n";
        let rows = parse_ps(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].pid, 417);
        assert_eq!(rows[0].ppid, 415);
        assert!((rows[0].cpu_secs - 3.2).abs() < 0.001);
        assert_eq!(rows[0].rss_bytes, Some(84512 * 1024));
        assert_eq!(rows[0].name, "vim");
        // Paths with spaces are the last column — the basename survives.
        let spaced =
            parse_ps("  5     1  0:00.00  1024 Sat Sep 19 12:00:00 2026 /Applications/My App/app");
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
        for bad in ["nan", "-1", "1:bad:20", "1:2:3:4", "inf"] {
            assert_eq!(parse_cputime(bad), None);
        }
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

/// Stop only the descendants captured by this request. The root shell remains
/// alive. Revalidate both the mounted PTY and process birth before every signal.
/// Unlike ordinary terminal close, this feature never schedules detached kills.
pub fn stop_workload(
    root: u32,
    root_start: u64,
    still_owned: impl Fn() -> bool,
) -> Result<(), String> {
    if root <= 1 || root == std::process::id() || !still_owned() {
        return Err("Terminal identity changed; refresh before stopping".into());
    }
    if identity(root)? != Some(root_start) {
        return Err("Terminal process identity changed; nothing was stopped".into());
    }
    let rows = snapshot()?;
    let (index, children) = build_children(&rows);
    let mut targets = Vec::new();
    for i in subtree(&rows, &index, &children, root).into_iter().rev() {
        let row = &rows[i];
        if row.pid <= 1 || row.pid == root || row.pid == std::process::id() {
            continue;
        }
        if let Some(started) = identity(row.pid)? {
            targets.push((row.pid, started));
        }
    }
    // Capture birth identities before a fresh membership check: a PID recycled
    // outside this terminal between enumeration and capture is never signalled.
    let fresh = snapshot()?;
    let (index, children) = build_children(&fresh);
    let current: HashSet<u32> = subtree(&fresh, &index, &children, root)
        .into_iter()
        .map(|i| fresh[i].pid)
        .collect();
    targets.retain(|(pid, _)| current.contains(pid));
    let check_root = || -> Result<(), String> {
        if !still_owned() || identity(root)? != Some(root_start) {
            return Err("Terminal identity changed; no further processes were stopped".into());
        }
        Ok(())
    };
    for &(pid, started) in &targets {
        check_root()?;
        signal_identity(pid, started, false)?;
    }
    #[cfg(unix)]
    if !targets.is_empty() {
        // This command already runs off the UI thread; keep escalation in its
        // bounded lifetime rather than leaving a timer with stale PID authority.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < deadline {
            targets.retain(|(pid, started)| identity(*pid).ok().flatten() == Some(*started));
            if targets.is_empty() {
                break;
            }
            check_root()?;
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        for (pid, started) in targets {
            check_root()?;
            signal_identity(pid, started, true)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn identity(pid: u32) -> Result<Option<u64>, String> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if read != size {
        let error = std::io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::ESRCH | libc::ENOENT)) {
            return Ok(None);
        }
        return Err(format!("Cannot verify process {pid}: {error}"));
    }
    Ok(Some(
        info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
    ))
}

#[cfg(target_os = "linux")]
pub(super) fn identity(pid: u32) -> Result<Option<u64>, String> {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(text) => text
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(19))
            .and_then(|value| value.parse().ok())
            .map(Some)
            .ok_or_else(|| "Invalid process identity".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot verify process {pid}: {error}")),
    }
}

#[cfg(windows)]
fn process_handle(
    pid: u32,
    terminate: bool,
) -> Result<Option<std::os::windows::io::OwnedHandle>, String> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };
    let access = PROCESS_QUERY_LIMITED_INFORMATION | if terminate { PROCESS_TERMINATE } else { 0 };
    let raw = unsafe { OpenProcess(access, 0, pid) };
    if raw.is_null() {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(87) {
            return Ok(None);
        }
        return Err(format!("Cannot verify process {pid}: {error}"));
    }
    Ok(Some(unsafe {
        std::os::windows::io::OwnedHandle::from_raw_handle(raw)
    }))
}

#[cfg(windows)]
fn handle_identity(handle: &std::os::windows::io::OwnedHandle) -> Result<u64, String> {
    use std::os::windows::io::AsRawHandle;
    let (mut created, mut exited, mut kernel, mut user) = unsafe { std::mem::zeroed() };
    if unsafe {
        windows_sys::Win32::System::Threading::GetProcessTimes(
            handle.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(format!(
            "Cannot verify process: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(filetime(created))
}

#[cfg(windows)]
pub(super) fn identity(pid: u32) -> Result<Option<u64>, String> {
    process_handle(pid, false)?
        .as_ref()
        .map(handle_identity)
        .transpose()
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub(super) fn identity(_pid: u32) -> Result<Option<u64>, String> {
    Err("Safe process stopping is unavailable on this platform".into())
}

#[cfg(unix)]
fn signal_identity(pid: u32, started: u64, hard: bool) -> Result<(), String> {
    let number = if hard { libc::SIGKILL } else { libc::SIGTERM };
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(format!("Cannot bind process for stopping: {error}"));
        }
        let fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
        if identity(pid)? != Some(started) {
            return Ok(());
        }
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                number,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        } == 0
        {
            return Ok(());
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        // macOS has no pidfd: verify microsecond birth identity immediately
        // before the signal. Do not carry PID-only authority across the delay.
        if identity(pid)? != Some(started) {
            return Ok(());
        }
        if unsafe { libc::kill(pid as i32, number) } == 0 {
            return Ok(());
        }
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(format!("Cannot stop process {pid}: {error}"))
}

#[cfg(windows)]
fn signal_identity(pid: u32, started: u64, _hard: bool) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    let Some(handle) = process_handle(pid, true)? else {
        return Ok(());
    };
    if handle_identity(&handle)? != started {
        return Ok(());
    }
    if unsafe { windows_sys::Win32::System::Threading::TerminateProcess(handle.as_raw_handle(), 1) }
        == 0
    {
        return Err(format!(
            "Cannot stop process {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn signal_identity(_pid: u32, _started: u64, _hard: bool) -> Result<(), String> {
    Err("Safe process stopping is unavailable on this platform".into())
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod live_tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    struct OwnedTestTree(Child);
    impl Drop for OwnedTestTree {
        fn drop(&mut self) {
            // This exact child remains unreaped until cleanup, so the test's
            // process-group ID cannot be recycled into a user-owned process.
            unsafe {
                libc::kill(-(self.0.id() as i32), libc::SIGKILL);
            }
            let _ = self.0.wait();
        }
    }

    #[test]
    fn samples_and_stops_only_its_owned_workload_leaving_shell_alive() {
        let mut tree = OwnedTestTree(
            Command::new("/bin/sh")
                .args(["-c", "sleep 30 & wait; read line"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let root = tree.0.id();
        let started = identity(root).unwrap().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let stats = sample_trees(&[root]).unwrap();
            if stats.get(&root).is_some_and(|row| row.processes >= 2) {
                assert!(stats[&root].workload);
                assert!(stats[&root].rss_bytes.unwrap() > 0);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "fixture workload failed to start"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(stop_workload(root, started + 1, || true).is_err());
        assert!(stop_workload(root, started, || false).is_err());
        assert!(sample_trees(&[root]).unwrap()[&root].workload);
        signal_identity(root, started + 1, true).unwrap();
        assert!(tree.0.try_wait().unwrap().is_none());
        stop_workload(root, started, || true).unwrap();
        assert!(
            tree.0.try_wait().unwrap().is_none(),
            "root shell must survive workload stop"
        );
        assert_eq!(identity(root).unwrap(), Some(started));
        assert!(!sample_trees(&[root]).unwrap()[&root].workload);
    }

    #[test]
    fn unavailable_measurements_stay_unknown_and_reused_pid_does_not_inherit_cpu() {
        let mut rows = vec![ProcRow {
            pid: u32::MAX,
            ppid: 0,
            cpu_secs: 4.0,
            cpu: None,
            rss_bytes: None,
            started: "old".into(),
            name: "fixture".into(),
        }];
        let wanted = HashSet::from([u32::MAX]);
        apply_cpu_deltas(&mut rows, &wanted);
        assert_eq!(aggregate(&rows, vec![0], u32::MAX).cpu_pct, None);
        assert_eq!(aggregate(&rows, vec![0], u32::MAX).rss_bytes, None);
        rows[0].started = "replacement".into();
        rows[0].cpu_secs = 400.0;
        std::thread::sleep(Duration::from_millis(2));
        apply_cpu_deltas(&mut rows, &wanted);
        assert_eq!(rows[0].cpu, None);
    }
}
