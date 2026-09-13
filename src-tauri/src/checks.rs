use std::collections::VecDeque;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::fs::expand_home;

// Post-turn project checks (#92): run one saved command headlessly in the
// resolved worktree and report a bounded *tail* of its output. The tail is
// the evidence — a failed suite reports at the end, so unlike
// `bounded_process` an overflowing stream is truncated, never dropped.
//
// WSL-qualified cwds run inside the distribution through the same login
// shell path interactive steps use; native cwds run in the user's login
// shell so saved commands behave the way they do in a project terminal.
//
// A check is foreground work: it dies with the app. Windows coverage is
// free (spawn_scoped's job object closes on teardown); unix pids register
// in RUNNING so the last-window/exit reaper can kill them.

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MIN_TIMEOUT: Duration = Duration::from_secs(5);
/// Combined stdout+stderr kept, tail-first.
const OUTPUT_CAP: usize = 64 * 1024;
const MAX_CHECK_TEXT: usize = 4_000;
/// Matches the project-command step cap.
const MAX_STEPS: usize = 12;
/// Live check processes across all invocations — the dedupe cap and the
/// reaper's kill list in one.
const MAX_RUNNING: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    /// Exit code of the last executed step. `None` when that step was killed
    /// (timeout) or died to a signal.
    code: Option<i32>,
    /// True when the run ended because a step was killed at the deadline or
    /// the deadline expired between steps.
    timed_out: bool,
    /// stdout+stderr combined, tail-bounded.
    output: String,
    truncated: bool,
    duration_ms: u64,
}

/// One step of a check. `native` steps run on the OS host shell even when
/// `cwd` is a WSL checkout — the same boundary interactive command steps use.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckStep {
    exec: String,
    native: Option<bool>,
}

// Pids (process-group ids on unix) of live check steps. Registered at
// spawn, removed by the guard's Drop; the app reaper kills what's left.
static RUNNING: Mutex<Vec<u32>> = Mutex::new(Vec::new());
/// Once the reaper has run, no new check process may spawn — a step started
/// mid-reap would register into the drained list and survive app exit.
static REAPED: AtomicBool = AtomicBool::new(false);

fn running() -> std::sync::MutexGuard<'static, Vec<u32>> {
    RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Kill every still-running check step — called from the last-window and
/// exit reaper in lib.rs alongside the harness/pty cleanup.
pub(crate) fn reap_running() {
    REAPED.store(true, Ordering::SeqCst);
    for pid in std::mem::take(&mut *running()) {
        kill_tree(pid);
    }
}

/// Kills the whole tree for a step pid: its process group on unix (the
/// child owns the group via process_group(0)), the /T tree on Windows.
fn kill_tree(pid: u32) {
    // kill(-0) and kill(-1) would signal our own group or every process.
    if pid <= 1 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        // Spawned, not waited — /F needs no confirmation and a .status()
        // wait would stall the app-event loop during teardown reaping.
        let mut kill = Command::new("taskkill");
        crate::hide_window_console(&mut kill);
        let _ = kill
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

/// Guarantees a spawned step is dead and unregistered however run_tailed
/// exits — `Child::drop` alone would orphan a still-running child.
struct KillGuard {
    child: Child,
    pid: u32,
}

impl KillGuard {
    fn new(child: Child) -> Self {
        let pid = child.id();
        running().push(pid);
        Self { child, pid }
    }

    fn kill(&mut self) {
        kill_tree(self.pid);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for KillGuard {
    fn drop(&mut self) {
        // Always sweep the group, not only when the leader still runs: a
        // step that exited can still leave strays behind, and a wait error
        // must not skip the kill either — matching kill-on-close jobs.
        self.kill();
        running().retain(|entry| *entry != self.pid);
    }
}

/// Whole runs in flight across all windows — a between-steps run owns no
/// pid yet, so counting RUNNING alone would undercount.
static ACTIVE: AtomicUsize = AtomicUsize::new(0);

struct RunSlot;
impl RunSlot {
    fn take() -> Result<Self, String> {
        ACTIVE
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_RUNNING).then_some(n + 1)
            })
            .map_err(|_| "Too many checks are already running.".to_string())?;
        Ok(RunSlot)
    }
}

impl Drop for RunSlot {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

/// One bounded check run: the steps in order, each to completion, stopping at
/// the first failure — the same semantics a sequential project command gets
/// in a terminal. Step text is a literal command line the resolved shell
/// parses — never split or re-quoted here.
#[tauri::command]
pub async fn run_check(
    cwd: String,
    steps: Vec<CheckStep>,
    timeout_secs: Option<u64>,
) -> Result<CheckRun, String> {
    tauri::async_runtime::spawn_blocking(move || run_check_sync(cwd, steps, timeout_secs))
        .await
        .map_err(|e| e.to_string())?
}

/// The execution host a run resolves once — a multi-step WSL check pays the
/// bridge round trip once, not once per step.
enum Host {
    /// Native checkout — expanded, verified directory.
    Local(std::path::PathBuf),
    /// WSL checkout — location verified over the bridge.
    #[cfg(windows)]
    Wsl(crate::wsl::Location),
}

/// A WSL checkout can only be checked from the Windows app; there the
/// location is verified over the bridge once for the whole run.
#[cfg(windows)]
fn wsl_host(location: crate::wsl::Location) -> Result<Host, String> {
    crate::wsl::verify_location(&location)?;
    Ok(Host::Wsl(location))
}

#[cfg(not(windows))]
fn wsl_host(_location: crate::wsl::Location) -> Result<Host, String> {
    Err("This checkout lives in WSL — checks can only run from the Windows app.".into())
}

fn run_check_sync(
    cwd: String,
    steps: Vec<CheckStep>,
    timeout_secs: Option<u64>,
) -> Result<CheckRun, String> {
    let steps: Vec<CheckStep> = steps
        .into_iter()
        .map(|step| CheckStep {
            exec: step.exec.trim().into(),
            native: step.native,
        })
        .filter(|step| !step.exec.is_empty())
        .collect();
    if steps.is_empty()
        || steps.len() > MAX_STEPS
        || steps
            .iter()
            .any(|step| step.exec.chars().count() > MAX_CHECK_TEXT)
    {
        return Err("The check command is empty or too long.".into());
    }
    let _slot = RunSlot::take()?;
    let host = match crate::wsl::location(&cwd).map_err(|e| e.to_string())? {
        Some(location) => wsl_host(location)?,
        None => {
            let dir = expand_home(&cwd);
            if !dir.is_dir() {
                return Err(format!("{} is not an existing directory", dir.display()));
            }
            Host::Local(dir)
        }
    };
    let timeout = timeout_secs
        .map(|secs| Duration::from_secs(secs).clamp(MIN_TIMEOUT, MAX_TIMEOUT))
        .unwrap_or(DEFAULT_TIMEOUT);
    let started = Instant::now();
    let deadline = started + timeout;
    let mut combined = Tail::new(OUTPUT_CAP);
    let mut last_status = None;
    // Deadline exhaustion between steps must not report the previous step's
    // success — un-run steps mean the check timed out.
    let mut timed_out = false;
    for step in &steps {
        let mut command = if step.native == Some(true) {
            native_command(&step.exec)?
        } else {
            match &host {
                Host::Local(dir) => {
                    let mut command = shell_command(dir, &step.exec);
                    crate::harness::apply_gui_env(&mut command);
                    command
                }
                #[cfg(windows)]
                Host::Wsl(location) => {
                    crate::wsl::exec_command_verified(location, &step.exec, None)?
                }
            }
        };
        // Construction can burn real time (the WSL bridge, PATH lookup) —
        // re-sample the deadline after it, not just before.
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            timed_out = true;
            break;
        }
        let (outcome, output, truncated) = run_tailed(&mut command, remaining, OUTPUT_CAP)?;
        if !output.is_empty() {
            if !combined.bytes.is_empty() {
                combined.push(b"\n");
            }
            combined.push(output.as_bytes());
        }
        combined.truncated |= truncated;
        match outcome {
            StepOutcome::Exited(status) if status.success() => last_status = Some(status),
            // A failing or timed-out step stops the run, like a terminal step.
            StepOutcome::Exited(status) => {
                last_status = Some(status);
                break;
            }
            StepOutcome::TimedOut => {
                timed_out = true;
                break;
            }
        }
    }
    let truncated = combined.truncated;
    Ok(CheckRun {
        code: last_status.and_then(|status| status.code()),
        timed_out,
        output: combined.into_string(),
        truncated,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// An OS-host step: the user's login shell in their home directory — where
/// the interactive "OS host" step runs, never inside the WSL checkout.
fn native_command(exec: &str) -> Result<Command, String> {
    let dir = expand_home("~");
    if !dir.is_dir() {
        return Err("The OS-host home directory is unavailable.".into());
    }
    let mut command = shell_command(&dir, exec);
    crate::harness::apply_gui_env(&mut command);
    Ok(command)
}

/// One step in `dir` through the user's login shell — the same shell the
/// project terminal would use.
#[cfg(not(windows))]
fn shell_command(dir: &std::path::Path, exec: &str) -> Command {
    let (shell, login) = crate::pty::default_shell();
    let mut command = Command::new(shell);
    command.args(login).arg("-c").arg(exec).current_dir(dir);
    command
}

/// Windows runs through whichever shell the terminal would use so `cmd`- and
/// PowerShell-style steps keep their terminal semantics. `spawn_scoped`
/// already suppresses the console window.
#[cfg(windows)]
fn shell_command(dir: &std::path::Path, exec: &str) -> Command {
    let (shell, _) = crate::pty::default_shell();
    let args = crate::pty::windows_exec_args(&shell, exec);
    let mut command = Command::new(shell);
    command.args(args).current_dir(dir);
    command
}

/// How a step ended: `Exited` carries the real status (signal death is a
/// `Some` status whose `code()` is `None`); `TimedOut` is the kill path.
enum StepOutcome {
    Exited(std::process::ExitStatus),
    TimedOut,
}

/// Accumulates a stream into its last `cap` bytes. A command can print
/// unboundedly without growing memory — only the retained tail survives.
struct Tail {
    bytes: VecDeque<u8>,
    cap: usize,
    truncated: bool,
}

impl Tail {
    fn new(cap: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            cap,
            truncated: false,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        for &byte in chunk {
            if self.bytes.len() == self.cap {
                self.bytes.pop_front();
                self.truncated = true;
            }
            self.bytes.push_back(byte);
        }
    }

    fn into_string(mut self) -> String {
        String::from_utf8_lossy(self.bytes.make_contiguous()).into_owned()
    }
}

/// A reader-shared tail: the drain thread pushes as it reads, so output
/// captured before a kill survives even if the thread never finishes
/// (a detached grandchild holding the pipe open).
type SharedTail = Arc<Mutex<Tail>>;

fn shared_tail(cap: usize) -> SharedTail {
    Arc::new(Mutex::new(Tail::new(cap)))
}

fn lock_tail(tail: &Mutex<Tail>) -> std::sync::MutexGuard<'_, Tail> {
    tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs `command` to completion, killing its process group once `timeout`
/// expires. Returns the step outcome plus the combined output tail — the
/// part of a failing suite that actually names the failure.
fn run_tailed(
    command: &mut Command,
    timeout: Duration,
    cap: usize,
) -> Result<(StepOutcome, String, bool), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    if REAPED.load(Ordering::SeqCst) {
        return Err("The app is shutting down — the check cannot start.".into());
    }
    #[cfg(windows)]
    let (child, job) = crate::windows::spawn_scoped(command).map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let child = command.spawn().map_err(|e| e.to_string())?;
    // Any exit below — error, timeout, success — leaves the step dead and
    // unregistered: the guard kills whatever survives, and on Windows the
    // job close (explicit below or at scope end) kills the whole tree.
    let mut guard = KillGuard::new(child);
    // The reaper can drain RUNNING between spawn and registration — if it
    // ran, this pid is registered but will never be reaped. Kill ourselves.
    if REAPED.load(Ordering::SeqCst) {
        return Err("The app is shutting down — the check cannot start.".into());
    }
    let out_tail = shared_tail(cap);
    let err_tail = shared_tail(cap);
    let read = |pipe: Box<dyn Read + Send>, tail: SharedTail| {
        let (tx, rx) = mpsc::sync_channel::<()>(1);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pipe = pipe;
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                lock_tail(&tail).push(&buf[..n]);
            }
            let _ = tx.send(());
        });
        rx
    };
    let out_done = read(
        Box::new(guard.child.stdout.take().ok_or("Missing stdout")?),
        Arc::clone(&out_tail),
    );
    let err_done = read(
        Box::new(guard.child.stderr.take().ok_or("Missing stderr")?),
        Arc::clone(&err_tail),
    );
    let deadline = Instant::now() + timeout;
    let outcome = loop {
        match guard.child.try_wait() {
            Ok(Some(status)) => break StepOutcome::Exited(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    guard.kill();
                    break StepOutcome::TimedOut;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    // Readers finish once the dead child's pipes close. A detached
    // grandchild can hold a pipe open forever, so wait bounded — the shared
    // tails keep whatever was read either way.
    let _ = out_done.recv_timeout(Duration::from_secs(5));
    let _ = err_done.recv_timeout(Duration::from_secs(5));
    #[cfg(windows)]
    drop(job);
    let stdout = std::mem::replace(&mut *lock_tail(&out_tail), Tail::new(cap));
    let stderr = std::mem::replace(&mut *lock_tail(&err_tail), Tail::new(cap));
    let truncated = stdout.truncated || stderr.truncated;
    let mut combined = stdout.into_string();
    if !stderr.bytes.is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&stderr.into_string());
    }
    Ok((outcome, combined, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> Command {
        #[cfg(unix)]
        {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            command
        }
        #[cfg(windows)]
        {
            let mut command = Command::new("cmd");
            command.args(["/C", script]);
            command
        }
    }

    fn step(exec: &str) -> CheckStep {
        CheckStep {
            exec: exec.into(),
            native: None,
        }
    }

    fn exit_code(outcome: &StepOutcome) -> Option<i32> {
        match outcome {
            StepOutcome::Exited(status) => status.code(),
            StepOutcome::TimedOut => None,
        }
    }

    /// run_check_sync resolves the user's login shell — pin it so the tests
    /// don't depend on the dev machine's $SHELL.
    fn pin_shell() {
        #[cfg(unix)]
        std::env::set_var("SHELL", "/bin/sh");
    }

    #[test]
    fn captures_exit_code_and_output_tail() {
        let (outcome, output, truncated) =
            run_tailed(&mut shell("echo hello"), Duration::from_secs(5), 1024).unwrap();
        assert_eq!(exit_code(&outcome), Some(0));
        assert_eq!(output.trim(), "hello");
        assert!(!truncated);
    }

    #[test]
    fn keeps_the_tail_when_output_overflows() {
        #[cfg(unix)]
        let script =
            "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; echo TAIL-MARKER";
        #[cfg(windows)]
        let script = "for /l %i in (0,1,2000) do @echo line-%i & echo TAIL-MARKER";
        let (outcome, output, truncated) =
            run_tailed(&mut shell(script), Duration::from_secs(30), 2048).unwrap();
        assert_eq!(exit_code(&outcome), Some(0));
        assert!(truncated);
        assert!(output.contains("TAIL-MARKER"));
        assert!(!output.contains("line-0\r"));
        assert!(!output.contains("line-0\n"));
    }

    #[test]
    fn nonzero_exit_is_reported() {
        #[cfg(unix)]
        let script = "echo failure-detail >&2; exit 3";
        #[cfg(windows)]
        let script = "echo failure-detail 1>&2 & exit /b 3";
        let (outcome, output, _) =
            run_tailed(&mut shell(script), Duration::from_secs(5), 1024).unwrap();
        assert_eq!(exit_code(&outcome), Some(3));
        assert!(output.contains("failure-detail"));
    }

    #[test]
    fn timeout_kills_the_run() {
        #[cfg(unix)]
        let script = "sleep 30";
        #[cfg(windows)]
        let script = "powershell -NoProfile -Command \"Start-Sleep -Seconds 30\"";
        let start = Instant::now();
        let mut command = shell(script);
        let (outcome, _, _) = run_tailed(&mut command, Duration::from_millis(150), 1024).unwrap();
        assert!(matches!(outcome, StepOutcome::TimedOut));
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    #[cfg(unix)]
    fn signal_death_reports_no_exit_code() {
        let (outcome, _, _) =
            run_tailed(&mut shell("kill -9 $$"), Duration::from_secs(5), 1024).unwrap();
        assert!(matches!(outcome, StepOutcome::Exited(_)));
        assert_eq!(exit_code(&outcome), None);
    }

    #[test]
    fn output_written_before_a_timeout_survives_the_kill() {
        #[cfg(unix)]
        let script = "echo before-death; sleep 30";
        #[cfg(windows)]
        let script =
            "echo before-death & powershell -NoProfile -Command \"Start-Sleep -Seconds 30\"";
        let (outcome, output, _) =
            run_tailed(&mut shell(script), Duration::from_millis(300), 1024).unwrap();
        assert!(matches!(outcome, StepOutcome::TimedOut));
        assert!(output.contains("before-death"));
    }

    #[test]
    fn run_check_runs_steps_in_order_and_stops_at_first_failure() {
        pin_shell();
        let dir = std::env::temp_dir();
        let cwd = dir.to_str().unwrap().to_string();
        let result = run_check_sync(
            cwd,
            vec![
                step("echo first"),
                step("echo second-out >&2 && exit 7"),
                step("echo never"),
            ],
            None,
        )
        .unwrap();
        assert_eq!(result.code, Some(7));
        assert!(!result.timed_out);
        assert!(result.output.contains("first"));
        assert!(result.output.contains("second-out"));
        assert!(!result.output.contains("never"));
    }

    #[test]
    fn run_check_rejects_blank_and_missing_targets() {
        pin_shell();
        assert!(run_check_sync(".".into(), vec![], None).is_err());
        assert!(run_check_sync(".".into(), vec![step("   ")], None).is_err());
        let missing = std::env::temp_dir().join("monocode-no-such-dir-92");
        let error = run_check_sync(
            missing.to_str().unwrap().to_string(),
            vec![step("echo hi")],
            None,
        )
        .err()
        .unwrap();
        assert!(error.contains("not an existing directory"));
    }
}
