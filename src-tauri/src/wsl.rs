//! App-open WSL process boundary. Reconnect is explicit; uncertain writes are not retried.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

const SCRIPT: &str = concat!(
    include_str!("terminal_resources.py"),
    "\n",
    include_str!("wsl_bridge.py")
);
const PROCESS_SCRIPT: &str = include_str!("wsl_process.py");
const MAX_MESSAGE: usize = 40 * 1024 * 1024;
const MAX_QUEUED_BYTES: usize = 64 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
static QUEUED_REQUESTS: AtomicUsize = AtomicUsize::new(0);
static QUEUED_BYTES: AtomicUsize = AtomicUsize::new(0);
static CONNECTING: AtomicUsize = AtomicUsize::new(0);
static HOSTS: OnceLock<Mutex<HashMap<String, Arc<Bridge>>>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub distribution: String,
    pub path: String,
}

impl Location {
    pub fn new(distribution: &str, path: &str) -> Result<Self, String> {
        if distribution.is_empty()
            || distribution.len() > 128
            || distribution.starts_with('-')
            || distribution.contains(['/', '\\', ':'])
            || distribution.chars().any(char::is_control)
        {
            return Err("Choose a named WSL distribution".into());
        }
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.len() > 4096
            || path.contains('\\')
            || path.chars().any(char::is_control)
            || path.split('/').any(|part| part == "..")
        {
            return Err(
                "Choose an absolute Linux path without parent traversal or backslashes".into(),
            );
        }
        let parts: Vec<_> = path
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .collect();
        Ok(Self {
            distribution: distribution.into(),
            path: format!("/{}", parts.join("/")),
        })
    }

    /// Internal host-qualified identity; the project picker displays the Linux path.
    pub fn identity(&self) -> String {
        format!("//wsl.localhost/{}{}", self.distribution, self.path)
    }

    pub fn with_path(&self, path: &str) -> Result<Self, String> {
        Self::new(&self.distribution, path)
    }
}

pub fn location(path: &str) -> Result<Option<Location>, String> {
    let normalized = path.replace('\\', "/");
    let normalized = normalized
        .strip_prefix("//?/UNC/")
        .map(|rest| format!("//{rest}"))
        .unwrap_or(normalized);
    let lower = normalized.to_ascii_lowercase();
    let prefix = if lower.starts_with("//wsl.localhost/") {
        "//wsl.localhost/"
    } else if lower.starts_with("//wsl$/") {
        "//wsl$/"
    } else {
        return Ok(None);
    };
    let rest = &normalized[prefix.len()..];
    let (distribution, path) = rest.split_once('/').unwrap_or((rest, ""));
    Location::new(distribution, &format!("/{path}")).map(Some)
}

pub fn path_location(path: &Path) -> Result<Option<Location>, String> {
    location(&path.to_string_lossy())
}

fn wsl_args(distribution: &str, path: &str, program: &str, args: &[String]) -> Vec<String> {
    let mut result = vec![
        "--distribution".into(),
        distribution.into(),
        "--cd".into(),
        path.into(),
        "--exec".into(),
        program.into(),
    ];
    result.extend_from_slice(args);
    result
}

fn wsl_command() -> Result<Command, String> {
    if !cfg!(windows) {
        return Err("WSL execution requires the native Windows app".into());
    }
    // Use the Windows system executable, never a repository-local wsl.exe.
    let system = std::env::var_os("SystemRoot").ok_or("Windows system directory is unavailable")?;
    let mut command = Command::new(Path::new(&system).join("System32").join("wsl.exe"));
    command.env("WSLENV", "");
    crate::hide_window_console(&mut command);
    Ok(command)
}

/// Windows caps a spawn command line near 32 KiB (os error 206) and the bridge
/// script is larger. This fixed-size `-c` bootstrap execs the program read from
/// stdin; the same pipe then carries protocol frames.
fn stdin_bootstrap(program: &str) -> String {
    format!(
        "import sys;exec(compile(sys.stdin.buffer.read({}),'bridge','exec'))",
        program.len()
    )
}

#[cfg(any(windows, test))]
fn terminal_args(location: &Location, marker: Option<&str>) -> Vec<String> {
    let mut env = vec![
        "TERM=xterm-256color".into(),
        "COLORTERM=truecolor".into(),
        "TERM_PROGRAM=MonoCode".into(),
    ];
    env.extend([
        "/bin/sh".into(),
        "-c".into(),
        "exec \"${SHELL:-/bin/sh}\" -l".into(),
    ]);
    mark_terminal_args(&mut env, marker);
    wsl_args(&location.distribution, &location.path, "/usr/bin/env", &env)
}

#[cfg(windows)]
pub fn terminal_command(location: &Location, marker: &str) -> Result<Command, String> {
    let _: String = request(location, "canonical", json!({}))?;
    let mut command = wsl_command()?;
    command.args(terminal_args(location, Some(marker)));
    Ok(command)
}

#[cfg(windows)]
pub fn terminal_exec_command(
    location: &Location,
    exec: &str,
    marker: &str,
) -> Result<Command, String> {
    let _: String = request(location, "canonical", json!({}))?;
    let mut command = wsl_command()?;
    let mut args = crate::saved_commands::wsl_shell_args(exec);
    mark_terminal_args(&mut args, Some(marker));
    command.args(wsl_args(
        &location.distribution,
        &location.path,
        "/usr/bin/env",
        &args,
    ));
    Ok(command)
}

/// The marker is generated by the PTY owner, never taken from page content.
#[cfg(any(windows, test))]
fn mark_terminal_args(args: &mut Vec<String>, marker: Option<&str>) {
    if let Some(marker) = marker {
        // Resource attribution is optional: malformed internal identifiers must
        // not become env assignments or alter the user's ordinary shell argv.
        if marker.is_empty()
            || marker.len() > 128
            || !marker
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return;
        }
        let Some(shell) = args.iter().position(|arg| arg == "/bin/sh") else {
            return;
        };
        if args.get(shell + 1).is_none_or(|arg| arg != "-c") {
            return;
        }
        let Some(script) = args.get_mut(shell + 2) else {
            return;
        };
        *script = format!("export MONOCODE_PTY_ROOT=$$; {script}");
        args.insert(shell, format!("MONOCODE_PTY={marker}"));
    }
}

#[cfg(windows)]
pub(crate) fn terminal_resources(
    location: &Location,
    markers: &[String],
) -> Result<HashMap<String, crate::pty::resources::LinuxResource>, String> {
    request(location, "terminal_resources", json!({"markers": markers}))
}

#[cfg(windows)]
pub(crate) fn terminal_stop_workload(location: &Location, marker: &str) -> Result<(), String> {
    request::<Value>(
        location,
        "terminal_stop_workload",
        json!({"marker": marker}),
    )?;
    Ok(())
}

#[tauri::command(async)]
pub fn wsl_resolve_harness(cwd: String, provider: String) -> Result<Value, String> {
    let location = location(&cwd)?.ok_or("Choose a WSL project")?;
    request(&location, "resolve_agent", json!({"provider":provider}))
}

/// One round trip that resolves every provider and reports a best-effort
/// credential signal, instead of eight serialized resolver requests.
#[tauri::command(async)]
pub fn wsl_resolve_agents(cwd: String) -> Result<Value, String> {
    let location = location(&cwd)?.ok_or("Choose a WSL project")?;
    request(&location, "resolve_agents", json!({}))
}

pub struct LinuxProcess {
    location: Location,
    pid: u32,
    started: u64,
    boot: String,
}

impl LinuxProcess {
    pub fn protocol_line(&self, line: String) -> Result<String, String> {
        translate_agent_cwd(&self.location, line)
    }
    pub fn stop(&self) -> Result<(), String> {
        let mut command = wsl_command()?;
        command.args(wsl_args(
            &self.location.distribution,
            "/",
            "/usr/bin/python3",
            &[
                "-c".into(),
                PROCESS_SCRIPT.into(),
                "stop".into(),
                self.pid.to_string(),
                self.started.to_string(),
                self.boot.clone(),
            ],
        ));
        let output = crate::bounded_process::output(&mut command, Duration::from_secs(10), 8192)?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Could not stop the Linux agent: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

fn translate_agent_cwd(host: &Location, line: String) -> Result<String, String> {
    if line.len() > 16 * 1024 * 1024 {
        return Err("Agent message exceeds 16 MiB".into());
    }
    let Ok(mut message) = serde_json::from_str::<Value>(&line) else {
        return Ok(line);
    };
    // Translate execution fields only; prompts and nested tool data stay intact.
    if message.get("method").and_then(Value::as_str).is_none() {
        return Ok(line);
    }
    let mut changed = false;
    for field in ["cwd", "workspaceRoot"] {
        if let Some(cwd) = message["params"][field].as_str() {
            if let Some(target) = location(cwd)? {
                if !target.distribution.eq_ignore_ascii_case(&host.distribution) {
                    return Err("Agent cwd belongs to a different WSL distribution".into());
                }
                message["params"][field] = target.path.into();
                changed = true;
            } else if !cwd.starts_with('/') || cwd.starts_with("//") || cwd.contains('\\') {
                return Err("Agent cwd must be a path in its Linux distribution".into());
            }
        }
    }
    if changed {
        return Ok(message.to_string());
    }
    Ok(line)
}

pub fn agent_command(
    location: &Location,
    command: &str,
    args: &[String],
) -> Result<(Command, String, String), String> {
    // Check the app-open connection before starting a separate streaming process.
    let _: String = request(location, "canonical", json!({}))?;
    if command.is_empty() || command.contains(['\\', ':', '\0']) || args.len() > 512 {
        return Err("Choose an agent installed inside the selected WSL distribution".into());
    }
    static NEXT_PROCESS: AtomicUsize = AtomicUsize::new(0);
    let nonce = format!(
        "{}-{}-{}",
        std::process::id(),
        NEXT_PROCESS.fetch_add(1, Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let config =
        json!({"command":command,"args":args,"cwd":location.path,"nonce":nonce}).to_string();
    if config.len() > 16 * 1024 {
        return Err("Linux agent arguments exceed 16 KiB".into());
    }
    let mut cmd = wsl_command()?;
    cmd.args(wsl_args(
        &location.distribution,
        &location.path,
        "/usr/bin/python3",
        &[
            "-u".into(),
            "-c".into(),
            PROCESS_SCRIPT.into(),
            "start".into(),
            config,
        ],
    ));
    let environment = agent_environment(location)?;
    let acknowledgement = json!({"nonce": nonce, "environment": environment}).to_string();
    Ok((cmd, nonce, acknowledgement))
}

/// Add only this launch's control state to the private stdin handshake. Never
/// mutate the cached login environment or put credentials in process arguments.
pub fn agent_acknowledgement(acknowledgement: &str, cmd: &Command) -> Result<String, String> {
    let mut message: Value = serde_json::from_str(acknowledgement)
        .map_err(|_| "Invalid Linux startup acknowledgement")?;
    let environment = message["environment"]
        .as_object_mut()
        .ok_or("Invalid Linux startup environment")?;
    for key in ["MONOCODE_CONTROL_ENDPOINT", "MONOCODE_CONTROL_TOKEN"] {
        environment.remove(key);
    }
    for key in [
        "MONOCODE_CONTROL_ENDPOINT",
        "MONOCODE_CONTROL_TOKEN",
        "TMPDIR",
        "TMP",
        "TEMP",
    ] {
        if let Some((_, value)) = cmd.get_envs().find(|(name, _)| *name == key) {
            match value {
                Some(value) => {
                    let value = value
                        .to_str()
                        .ok_or("Invalid Linux launch environment value")?;
                    environment.insert(key.into(), value.into());
                }
                None => {
                    environment.remove(key);
                }
            }
        }
    }
    // /w exports only to Win32 children. The CLI remains the same native app
    // executable and connects to its Windows loopback listener, including on NAT.
    environment.insert(
        "WSLENV".into(),
        if environment.contains_key("MONOCODE_CONTROL_TOKEN") {
            "MONOCODE_CONTROL_ENDPOINT/w:MONOCODE_CONTROL_TOKEN/w"
        } else {
            ""
        }
        .into(),
    );
    Ok(message.to_string())
}

/// The login-shell environment changes only through refresh_environment, which
/// bumps the bridge generation, so launches reuse the cached payload.
fn agent_environment(location: &Location) -> Result<Arc<Value>, String> {
    let bridge = bridge_for(location)?;
    let generation = bridge.generation.load(Ordering::SeqCst);
    {
        let cache = bridge
            .agent_environment
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some((cached, environment)) = cache.as_ref() {
            if *cached == generation {
                return Ok(environment.clone());
            }
        }
    }
    let environment = bridge.request(json!({
        "op": "agent_environment",
        "path": location.path,
    }))?;
    if !environment.is_object() {
        return Err("Invalid WSL environment response".into());
    }
    let environment = Arc::new(environment);
    *bridge
        .agent_environment
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some((generation, environment.clone()));
    Ok(environment)
}

pub fn agent_handshake(
    stdout: ChildStdout,
    location: Location,
    nonce: &str,
) -> Result<(BufReader<ChildStdout>, LinuxProcess), String> {
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let result = (&mut reader)
            .take(4097)
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())
            .and_then(|_| {
                if line.len() > 4096 || !line.ends_with(b"\n") {
                    return Err("Invalid Linux agent startup response".into());
                }
                serde_json::from_slice::<Value>(&line).map_err(|e| e.to_string())
            });
        let _ = send.send(result.map(|value| (reader, value)));
    });
    let (reader, value) = receive
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Linux agent startup timed out; no start acknowledgement was sent")??;
    let pid = value["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 1);
    let started = value["started"].as_u64().filter(|value| *value > 0);
    let boot = value["boot"].as_str().filter(|value| {
        value.len() == 36
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    });
    if value["nonce"].as_str() != Some(nonce)
        || pid.is_none()
        || started.is_none()
        || boot.is_none()
    {
        return Err("Linux agent startup identity did not match".into());
    }
    Ok((
        reader,
        LinuxProcess {
            location,
            pid: pid.unwrap(),
            started: started.unwrap(),
            boot: boot.unwrap().to_owned(),
        },
    ))
}

fn decode_distributions(bytes: &[u8]) -> Result<Vec<String>, String> {
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.iter().take(128).any(|byte| *byte == 0)
    {
        let (pairs, remainder) = bytes.as_chunks::<2>();
        if !remainder.is_empty() {
            return Err("WSL returned incomplete UTF-16 output".into());
        }
        let values: Vec<_> = pairs
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&values).map_err(|_| "WSL returned invalid distribution names")?
    } else {
        String::from_utf8(bytes.to_vec()).map_err(|_| "WSL returned invalid distribution names")?
    };
    let mut distributions = Vec::new();
    for name in text
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Location::new(name, "/")?;
        if distributions.len() >= 64 {
            return Err("WSL returned more than 64 distributions".into());
        }
        if !distributions.contains(&name.to_owned()) {
            distributions.push(name.to_owned());
        }
    }
    Ok(distributions)
}

#[tauri::command(async)]
pub fn wsl_distributions() -> Result<Vec<String>, String> {
    let output = crate::bounded_process::output(
        wsl_command()?.args(["--list", "--quiet"]),
        Duration::from_secs(10),
        32 * 1024,
    )?;
    if !output.status.success() {
        return Err("WSL is unavailable. Install WSL and a Linux distribution, then retry.".into());
    }
    decode_distributions(&output.stdout)
}

/// The default user's Linux home, probed without a bridge so the project
/// picker can offer it before any checkout is connected.
#[tauri::command(async)]
pub fn wsl_home(distribution: String) -> Result<String, String> {
    let location = Location::new(&distribution, "/")?;
    let output = crate::bounded_process::output(
        wsl_command()?.args(wsl_args(
            &location.distribution,
            "/",
            "/bin/sh",
            &["-c".into(), "printf %s \"$HOME\"".into()],
        )),
        Duration::from_secs(10),
        8 * 1024,
    )?;
    if !output.status.success() {
        return Err(format!(
            "Could not read the Linux home in {}: {}",
            location.distribution,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let home = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok(location.with_path(&home)?.path)
}

struct Process {
    child: Child,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct BridgeIo {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}
static NEXT_BRIDGE_GENERATION: AtomicUsize = AtomicUsize::new(1);

struct Bridge {
    generation: AtomicUsize,
    io: Mutex<Option<BridgeIo>>,
    available: Condvar,
    reads: Option<Box<Bridge>>,
    process: Arc<Mutex<Process>>,
    alive: Arc<AtomicBool>,
    owner: Option<(tauri::AppHandle, String)>,
    /// Login-shell environment captured per generation; agent launches reuse it
    /// instead of round-tripping the whole environment on every spawn.
    agent_environment: Mutex<Option<(usize, Arc<Value>)>>,
}
struct Spawned {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
}

impl Spawned {
    /// Deliver the program on a helper thread with a deadline: a `wsl.exe`
    /// that stalls before the guest reads must not wedge a connect slot.
    /// Killing the child breaks the pipe and releases the writer.
    fn finish_lane(mut self, program: &[u8]) -> Result<Bridge, String> {
        let (send, receive) = mpsc::sync_channel(0);
        let mut stdin = self.stdin;
        let program = program.to_vec();
        std::thread::spawn(move || {
            let delivered = stdin
                .write_all(&program)
                .and_then(|()| stdin.flush())
                .map(|()| stdin);
            let _ = send.send(delivered);
        });
        let stdin = match receive.recv_timeout(LAUNCH_TIMEOUT) {
            Ok(Ok(stdin)) => stdin,
            Ok(Err(error)) => {
                let _ = self.child.kill();
                let _ = self.child.wait();
                return Err(format!("Cannot start WSL: {error}"));
            }
            Err(_) => {
                let _ = self.child.kill();
                let _ = self.child.wait();
                return Err("WSL did not load the bridge in time".into());
            }
        };
        Ok(Bridge {
            generation: AtomicUsize::new(NEXT_BRIDGE_GENERATION.fetch_add(1, Ordering::SeqCst)),
            io: Mutex::new(Some(BridgeIo {
                stdin,
                stdout: self.stdout,
            })),
            available: Condvar::new(),
            reads: None,
            process: Arc::new(Mutex::new(Process {
                child: self.child,
                #[cfg(windows)]
                _job: self.job,
            })),
            alive: Arc::new(AtomicBool::new(true)),
            owner: None,
            agent_environment: Mutex::new(None),
        })
    }

    fn abort(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Bridge {
    fn start(command: &mut Command, program: &[u8]) -> Result<Self, String> {
        // Spawn both lanes before either program is delivered so the two guest
        // interpreters start together; each write then waits only on its own
        // reader.
        let first = Self::spawn_lane(command)?;
        let second = match Self::spawn_lane(command) {
            Ok(lane) => lane,
            Err(error) => {
                first.abort();
                return Err(error);
            }
        };
        let mut bridge = match first.finish_lane(program) {
            Ok(bridge) => bridge,
            Err(error) => {
                second.abort();
                return Err(error);
            }
        };
        let mut reads = second.finish_lane(program)?;
        reads.alive = bridge.alive.clone();
        bridge.reads = Some(Box::new(reads));
        Ok(bridge)
    }

    fn spawn_lane(command: &mut Command) -> Result<Spawned, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        let (mut child, job) =
            crate::windows::spawn_scoped(command).map_err(|e| format!("Cannot start WSL: {e}"))?;
        #[cfg(not(windows))]
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start Linux bridge: {e}"))?;
        let stdin = child.stdin.take().ok_or("Missing WSL input")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("Missing WSL output")?);
        Ok(Spawned {
            child,
            stdin,
            stdout,
            #[cfg(windows)]
            job,
        })
    }
    fn request(&self, request: Value) -> Result<Value, String> {
        self.request_bounded(request, REQUEST_TIMEOUT)
    }

    /// Same request path with a caller-chosen deadline — long git
    /// operations (fetch/merge) need more than the 30s default.
    fn request_bounded(&self, request: Value, timeout: Duration) -> Result<Value, String> {
        // Read-only filesystem operations have a separate bounded channel so a
        // slow Git/CLI command cannot block navigation or file polling. All Git
        // commands and mutations remain serialized on the original channel.
        if let Some(reads) = &self.reads {
            if matches!(
                request["op"].as_str(),
                Some(
                    "stat"
                        | "inspect"
                        | "list"
                        | "read"
                        | "read_text"
                        | "preview"
                        | "diff_file"
                        | "read_many"
                        | "search_read"
                        | "line_counts"
                        | "files"
                        | "canonical"
                        | "canonical_directory"
                        | "project_location"
                        | "home"
                        | "skill_entries"
                        | "terminal_resources"
                        | "resolve_agent"
                        | "resolve_agents"
                        | "agent_exec"
                        | "agent_environment"
                )
            ) {
                let result = reads.request(request);
                if !self.alive.load(Ordering::SeqCst) {
                    self.available.notify_all();
                }
                return result;
            }
        }
        struct RequestSlot;
        impl Drop for RequestSlot {
            fn drop(&mut self) {
                QUEUED_REQUESTS.fetch_sub(1, Ordering::SeqCst);
            }
        }
        if QUEUED_REQUESTS.fetch_add(1, Ordering::SeqCst) >= 32 {
            QUEUED_REQUESTS.fetch_sub(1, Ordering::SeqCst);
            return Err("WSL request queue is full. Retry after current work finishes.".into());
        }
        let _slot = RequestSlot;
        struct Size(usize);
        impl Write for Size {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 = self.0.saturating_add(bytes.len());
                if self.0 >= MAX_MESSAGE {
                    return Err(std::io::Error::other("WSL request exceeds 40 MiB"));
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        // Reserve the serialized-byte budget before allocating an encoded copy.
        let mut measured = Size(0);
        serde_json::to_writer(&mut measured, &request).map_err(|e| e.to_string())?;
        struct Budget(usize);
        impl Drop for Budget {
            fn drop(&mut self) {
                QUEUED_BYTES.fetch_sub(self.0, Ordering::SeqCst);
            }
        }
        let size = measured.0 + 1;
        if QUEUED_BYTES
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                current
                    .checked_add(size)
                    .filter(|next| *next <= MAX_QUEUED_BYTES)
            })
            .is_err()
        {
            return Err("WSL request queue is full. Retry after current work finishes.".into());
        }
        let _budget = Budget(size);
        let mut encoded = Vec::with_capacity(size);
        serde_json::to_writer(&mut encoded, &request).map_err(|e| e.to_string())?;
        encoded.push(b'\n');
        // The queue wait is bounded separately — `timeout` budgets the
        // request's execution; time spent queued behind another command
        // must not eat it, or a long git op would expire before it starts.
        let queue_deadline = Instant::now() + REQUEST_TIMEOUT;
        let mut slot = self.io.lock().map_err(|_| "WSL IO lock poisoned")?;
        loop {
            if !self.alive.load(Ordering::SeqCst) {
                return Err("WSL connection was interrupted. Reconnect the selected distribution; no action was replayed.".into());
            }
            if Instant::now() >= queue_deadline {
                return Err("WSL is busy. This queued action did not start.".into());
            }
            if slot.is_some() {
                break;
            }
            slot = self
                .available
                .wait_timeout(
                    slot,
                    queue_deadline.saturating_duration_since(Instant::now()),
                )
                .map_err(|_| "WSL IO lock poisoned")?
                .0;
        }
        let mut io = slot.take().ok_or("WSL IO unavailable")?;
        drop(slot);
        let (done, waiting) = mpsc::channel();
        let process = self.process.clone();
        // The execution budget starts now that the channel is ours.
        let remaining = timeout;
        let watchdog = std::thread::spawn(move || {
            if waiting.recv_timeout(remaining).is_err() {
                let _ = process
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .child
                    .kill();
                return true;
            }
            false
        });
        let result = (|| {
            io.stdin.write_all(&encoded).map_err(|e| e.to_string())?;
            io.stdin.flush().map_err(|e| e.to_string())?;
            let mut response = Vec::new();
            (&mut io.stdout)
                .take((MAX_MESSAGE + 1) as u64)
                .read_until(b'\n', &mut response)
                .map_err(|e| e.to_string())?;
            if response.is_empty() || response.len() > MAX_MESSAGE || !response.ends_with(b"\n") {
                return Err("WSL bridge stopped or returned an oversized response".into());
            }
            serde_json::from_slice::<Value>(&response).map_err(|e| e.to_string())
        })();
        let _ = done.send(());
        let timed_out = watchdog.join().unwrap_or(true);
        // Mark failures before releasing the channel: queued writes must not run
        // after an uncertain response, even if they win the next wakeup.
        let result = self.finish_request(result, timed_out);
        *self.io.lock().unwrap_or_else(|error| error.into_inner()) = Some(io);
        if self.alive.load(Ordering::SeqCst) {
            self.available.notify_one();
        } else {
            self.available.notify_all();
            if let Some(reads) = &self.reads {
                reads.available.notify_all();
            }
        }
        result
    }

    fn finish_request(
        &self,
        result: Result<Value, String>,
        timed_out: bool,
    ) -> Result<Value, String> {
        // A complete response can race the watchdog killing the launcher. Never
        // retain that dead connection or imply the timed-out mutation is retryable.
        let result = if timed_out {
            Err("WSL request timed out".into())
        } else {
            result.and_then(|response| {
                let valid = response.as_object().is_some_and(|fields| {
                    fields.len() == 1
                        && (fields.contains_key("ok")
                            || fields.get("error").is_some_and(Value::is_string))
                });
                if valid {
                    Ok(response)
                } else {
                    Err("Invalid WSL response".into())
                }
            })
        };
        match result {
            Ok(mut response) => {
                if let Some(error) = response.get("error").and_then(Value::as_str) {
                    return Err(error.to_owned());
                }
                response
                    .get_mut("ok")
                    .map(Value::take)
                    .ok_or_else(|| "Invalid WSL response".into())
            }
            Err(error) => {
                self.alive.store(false, Ordering::SeqCst);
                if let Some((app, distribution)) = &self.owner {
                    let _ = app.emit("wsl:disconnected", distribution);
                }
                let _ = self
                    .process
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .child
                    .kill();
                Err(format!("WSL connection interrupted: {error}. Check /usr/bin/python3 and reconnect. An in-flight action may have completed; inspect it before retrying."))
            }
        }
    }
}

fn bridge_for(location: &Location) -> Result<Arc<Bridge>, String> {
    HOSTS.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner()).get(&location.distribution.to_lowercase()).cloned()
        .ok_or("WSL is not connected. Open the project location and reconnect; Windows execution was not used.".into())
}

pub fn request<T: DeserializeOwned>(
    location: &Location,
    op: &str,
    mut arguments: Value,
) -> Result<T, String> {
    let bridge = bridge_for(location)?;
    arguments["op"] = op.into();
    arguments["path"] = location.path.clone().into();
    serde_json::from_value(bridge.request(arguments)?)
        .map_err(|e| format!("Invalid WSL result: {e}"))
}

/// `request` with a caller-chosen deadline — for ops whose own timeout
/// exceeds `REQUEST_TIMEOUT` (a fetch/merge on a slow link).
pub fn request_bounded<T: DeserializeOwned>(
    location: &Location,
    op: &str,
    mut arguments: Value,
    timeout: Duration,
) -> Result<T, String> {
    let bridge = bridge_for(location)?;
    arguments["op"] = op.into();
    arguments["path"] = location.path.clone().into();
    serde_json::from_value(bridge.request_bounded(arguments, timeout)?)
        .map_err(|e| format!("Invalid WSL result: {e}"))
}

#[tauri::command(async)]
pub fn wsl_connect(
    app: tauri::AppHandle,
    distribution: String,
    path: String,
    refresh: Option<bool>,
) -> Result<Value, String> {
    let location = Location::new(&distribution, &path)?;
    let existing = HOSTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&distribution.to_lowercase())
        .cloned();
    if let Some(bridge) = existing.filter(|bridge| bridge.alive.load(Ordering::SeqCst)) {
        if refresh.unwrap_or(false) {
            bridge.request(json!({"op":"refresh_environment", "path":"/"}))?;
            if let Some(reads) = &bridge.reads {
                reads.request(json!({"op":"refresh_environment", "path":"/"}))?;
            }
            bridge.generation.store(
                NEXT_BRIDGE_GENERATION.fetch_add(1, Ordering::SeqCst),
                Ordering::SeqCst,
            );
        }
        let path = bridge.request(json!({"op":"canonical_directory", "path":location.path}))?;
        return Ok(
            json!({"distribution": distribution, "path": path, "generation": bridge.generation.load(Ordering::SeqCst)}),
        );
    }
    if CONNECTING.fetch_add(1, Ordering::SeqCst) >= 4 {
        CONNECTING.fetch_sub(1, Ordering::SeqCst);
        return Err(
            "WSL connection attempts are busy. Wait for the current open to finish.".into(),
        );
    }
    struct Connecting;
    impl Drop for Connecting {
        fn drop(&mut self) {
            CONNECTING.fetch_sub(1, Ordering::SeqCst);
        }
    }
    let _connecting = Connecting;
    let known = wsl_distributions()?;
    let distribution = known
        .iter()
        .find(|name| name.eq_ignore_ascii_case(&distribution))
        .ok_or("The selected WSL distribution is not installed")?;
    let location = Location::new(distribution, &path)?;
    let mut command = wsl_command()?;
    command.args(wsl_args(
        distribution,
        "/",
        "/usr/bin/python3",
        &["-u".into(), "-c".into(), stdin_bootstrap(SCRIPT)],
    ));
    let connected = connect_bridge(
        HOSTS.get_or_init(Mutex::default),
        &location,
        &mut command,
        Some((app, distribution.to_owned())),
    )?;
    let generation = HOSTS
        .get()
        .unwrap()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&distribution.to_lowercase())
        .map(|bridge| bridge.generation.load(Ordering::SeqCst));
    Ok(
        json!({"distribution": connected.distribution, "path": connected.path, "generation": generation}),
    )
}

fn connect_bridge(
    registry: &Mutex<HashMap<String, Arc<Bridge>>>,
    location: &Location,
    command: &mut Command,
    owner: Option<(tauri::AppHandle, String)>,
) -> Result<Location, String> {
    fn validate(bridge: &Bridge, location: &Location) -> Result<Location, String> {
        // Both lanes capture the login environment on connect — run the two
        // guest probes together instead of serially.
        std::thread::scope(|scope| {
            let pending = bridge.reads.as_ref().map(|reads| {
                scope.spawn(|| reads.request(json!({"op":"connect", "path":location.path})))
            });
            let result = bridge.request(json!({"op":"connect", "path":location.path}))?;
            if let Some(pending) = pending {
                let checked = pending
                    .join()
                    .map_err(|_| "WSL read validation panicked".to_string())??;
                if checked["path"] != result["path"] {
                    return Err("WSL read channel resolved a different checkout".into());
                }
            }
            location.with_path(
                result["path"]
                    .as_str()
                    .ok_or("WSL did not return the selected Linux path")?,
            )
        })
    }
    let key = location.distribution.to_lowercase();
    {
        let mut hosts = registry.lock().unwrap_or_else(|e| e.into_inner());
        hosts.retain(|_, bridge| bridge.alive.load(Ordering::SeqCst));
        if let Some(bridge) = hosts.get(&key).cloned() {
            drop(hosts);
            return validate(&bridge, location);
        }
        if hosts.len() + CONNECTING.load(Ordering::SeqCst).max(1) > 4 {
            return Err("WSL connections are busy or four distributions are connected. Retry after pending opens finish; close the app to release connected distributions.".into());
        }
    }
    // Validate privately: failed opens drop their process and consume no host
    // slot. Other repositories can keep using their bridges during validation.
    let mut candidate = Bridge::start(command, SCRIPT.as_bytes())?;
    if let Some(reads) = &mut candidate.reads {
        reads.owner = owner.clone();
    }
    candidate.owner = owner;
    let connected = validate(&candidate, location)?;
    let mut hosts = registry.lock().unwrap_or_else(|e| e.into_inner());
    hosts.retain(|_, bridge| bridge.alive.load(Ordering::SeqCst));
    if !hosts.contains_key(&key) && hosts.len() >= 4 {
        return Err(
            "Four WSL distributions are already connected. Close the app before selecting another."
                .into(),
        );
    }
    // Another successful open may have registered the same distro meanwhile.
    hosts.entry(key).or_insert_with(|| Arc::new(candidate));
    Ok(connected)
}

#[tauri::command]
pub fn wsl_connected(distribution: String) -> bool {
    HOSTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&distribution.to_lowercase())
        .is_some_and(|bridge| bridge.alive.load(Ordering::SeqCst))
}

/// Translate returned filesystem identities only; file contents and Git output stay unchanged.
pub fn files_request<T: DeserializeOwned>(
    location: &Location,
    op: &str,
    args: Value,
) -> Result<T, String> {
    fn qualify(value: &mut Value, location: &Location) -> Result<(), String> {
        match value {
            Value::Array(items) => {
                // An entry whose guest path cannot form an identity (control
                // chars, "..", a stray backslash) is dropped, not fatal — one
                // exotic name must not void the whole listing.
                let mut kept = Vec::with_capacity(items.len());
                for item in std::mem::take(items) {
                    let mut item = item;
                    if qualify(&mut item, location).is_ok() {
                        kept.push(item);
                    }
                }
                *items = kept;
            }
            Value::Object(fields) => {
                if let Some(Value::String(path)) = fields.get_mut("path") {
                    *path = location.with_path(path)?.identity();
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut result: Value = request(location, op, args)?;
    qualify(&mut result, location)?;
    serde_json::from_value(result).map_err(|e| format!("Invalid WSL filesystem result: {e}"))
}

/// One Linux metadata request per distribution, never a UNC stat per file.
pub fn file_batches<T: DeserializeOwned>(paths: &[String], op: &str) -> Result<Vec<T>, String> {
    let mut groups: HashMap<String, Vec<(&String, Location)>> = HashMap::new();
    for path in paths {
        if let Some(location) = location(path)? {
            groups
                .entry(location.distribution.to_lowercase())
                .or_default()
                .push((path, location));
        }
    }
    let mut result = Vec::new();
    for paths in groups.values() {
        for batch in paths.chunks(64) {
            let values: Vec<Value> = request(
                &batch[0].1,
                op,
                json!({"paths":batch.iter().map(|(_, location)| &location.path).collect::<Vec<_>>()}),
            )?;
            let mut remaining = batch.iter();
            for mut value in values {
                let (original, _) = remaining
                    .find(|(_, location)| value["path"] == location.path)
                    .ok_or("WSL returned an unexpected metadata path")?;
                // Watchers key their results by the requested identity, including
                // supported wsl$ aliases and backslash-form attachment paths.
                value["path"] = (*original).clone().into();
                result.push(
                    serde_json::from_value(value)
                        .map_err(|e| format!("Invalid WSL metadata: {e}"))?,
                );
            }
        }
    }
    Ok(result)
}

pub fn path_request(location: &Location, op: &str, args: Value) -> Result<String, String> {
    let path: String = request(location, op, args)?;
    Ok(location.with_path(&path)?.identity())
}

pub fn transfer_path(from: &str, destination: &str, op: &str) -> Result<Option<String>, String> {
    match (location(from)?, location(destination)?) {
        (None, None) => Ok(None),
        (Some(from), Some(to)) if from.distribution.eq_ignore_ascii_case(&to.distribution) => {
            path_request(&from, op, json!({"destination":to.path})).map(Some)
        }
        _ => Err("Copy and move must stay on the same execution host and WSL distribution. Use an explicit file transfer instead.".into()),
    }
}

pub fn git(
    location: &Location,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<std::process::Output, String> {
    git_bounded(location, args, input, None)
}

/// `git` with a guest-side command timeout — the bridge kills the child
/// group at the limit, and the request deadline gets matching slack so a
/// long fetch/merge isn't killed mid-write by the default 30s cap.
pub fn git_bounded(
    location: &Location,
    args: &[&str],
    input: Option<&[u8]>,
    timeout: Option<Duration>,
) -> Result<std::process::Output, String> {
    use base64::Engine;
    #[derive(Deserialize)]
    struct Capture {
        code: i32,
        stdout: String,
        stderr: String,
    }
    let arguments = json!({
        "args": args,
        "input": input.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
        "timeout": timeout.map(|limit| limit.as_secs()),
    });
    let captured: Capture = match timeout {
        Some(limit) => request_bounded(location, "git", arguments, limit + Duration::from_secs(15)),
        None => request(location, "git", arguments),
    }?;
    #[cfg(unix)]
    let status = {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(if captured.code < 0 {
            -captured.code
        } else {
            captured.code << 8
        })
    };
    #[cfg(windows)]
    let status = {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(captured.code as u32)
    };
    Ok(std::process::Output {
        status,
        stdout: base64::engine::general_purpose::STANDARD
            .decode(captured.stdout)
            .map_err(|e| e.to_string())?,
        stderr: base64::engine::general_purpose::STANDARD
            .decode(captured.stderr)
            .map_err(|e| e.to_string())?,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn launch_control_environment_is_private_and_never_cached_or_inherited() {
        use super::*;
        let original = json!({"nonce":"one", "environment": {
            "PATH":"/linux/bin", "MONOCODE_CONTROL_TOKEN":"stale", "MONOCODE_CONTROL_ENDPOINT":"stale",
            "WSLENV":"UNRELATED/p", "TMPDIR":"/tmp"
        }}).to_string();
        let mut command = Command::new("wsl.exe");
        command
            .env("MONOCODE_CONTROL_TOKEN", "session-only")
            .env("MONOCODE_CONTROL_ENDPOINT", "127.0.0.1:4321")
            .env("TMPDIR", "/tmp/worker")
            .env("PATH", "C:/Windows")
            .env("UNRELATED_SECRET", "never-transfer");
        let message: Value =
            serde_json::from_str(&agent_acknowledgement(&original, &command).unwrap()).unwrap();
        assert_eq!(message["nonce"], "one");
        assert_eq!(message["environment"]["PATH"], "/linux/bin");
        assert_eq!(message["environment"]["TMPDIR"], "/tmp/worker");
        assert_eq!(
            message["environment"]["MONOCODE_CONTROL_TOKEN"],
            "session-only"
        );
        assert_eq!(
            message["environment"]["WSLENV"],
            "MONOCODE_CONTROL_ENDPOINT/w:MONOCODE_CONTROL_TOKEN/w"
        );
        assert!(message["environment"].get("UNRELATED_SECRET").is_none());
        assert_eq!(command.get_args().count(), 0);
        let ordinary: Value = serde_json::from_str(
            &agent_acknowledgement(&original, &Command::new("wsl.exe")).unwrap(),
        )
        .unwrap();
        assert!(ordinary["environment"]
            .get("MONOCODE_CONTROL_TOKEN")
            .is_none());
        assert!(ordinary["environment"]
            .get("MONOCODE_CONTROL_ENDPOINT")
            .is_none());
        assert_eq!(ordinary["environment"]["WSLENV"], "");
        assert_eq!(
            serde_json::from_str::<Value>(&original).unwrap()["environment"]
                ["MONOCODE_CONTROL_TOKEN"],
            "stale"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guest_control_scopes_and_private_scratch_resolve_linux_symlinks() {
        use super::*;
        let fixture = r#"
import tempfile
with tempfile.TemporaryDirectory(prefix='monocode-control-') as directory:
    directory = str(Path(directory).resolve())
    root = Path(directory) / 'Repo'
    root.mkdir()
    (root / 'src').mkdir()
    outside = Path(directory) / 'other'
    outside.mkdir()
    (root / 'escape').symlink_to(outside, target_is_directory=True)
    (root / 'alias').symlink_to(root / 'src', target_is_directory=True)
    (root / 'dangling').symlink_to(root / 'missing', target_is_directory=True)
    assert handle({'op':'control_scope', 'path':str(root), 'scope':'.'}) == str(root)
    assert handle({'op':'control_scope', 'path':str(root), 'scope':'alias/new/file'}) == str(root / 'src/new/file')
    for scope in ['../other', '/tmp', 'escape/new', 'dangling/new', '']:
        try:
            handle({'op':'control_scope', 'path':str(root), 'scope':scope})
            raise AssertionError('unsafe scope accepted: ' + scope)
        except ValueError:
            pass
    assert handle({'op':'control_write_path', 'path':str(root / 'escape/new')}) == str(outside / 'new')
    assert handle({'op':'control_write_path', 'path':str(root / 'src/New')}) != handle({'op':'control_write_path', 'path':str(root / 'src/new')})
    scratch = Path(handle({'op':'worker_scratch', 'path':str(root)}))
    try:
        assert scratch.is_dir() and stat.S_IMODE(scratch.stat().st_mode) == 0o700
        assert not scratch.is_relative_to(root)
    finally:
        scratch.rmdir()
"#;
        let script = format!(
            "__name__ = 'fixture'\nexec({})\n{}",
            serde_json::to_string(SCRIPT).unwrap(),
            fixture
        );
        let output = Command::new("python3")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn shell_environment_discovers_and_launches_user_tools_without_windows_path() {
        use super::*;
        let fixture = r#"
import tempfile, types
from unittest.mock import patch
with tempfile.TemporaryDirectory(prefix='monocode-env-') as directory:
    home = Path(directory)
    tools = home / '.nvm/versions/node/fixture/bin'
    tools.mkdir(parents=True)
    shell = home / 'fixture-shell'
    shell.write_text('#!/bin/sh\nexport HOME=' + shlex.quote(str(home)) + '\nexport PATH=' + shlex.quote(str(tools) + ':/usr/bin:/bin:/mnt/c/Windows') + '\nprintf "startup noise\\n"\neval "$2"\n')
    shell.chmod(0o755)
    interpreter = tools / 'fixture-node'
    interpreter.write_text('#!/bin/sh\nprintf "linux-interpreter\\n"\n')
    interpreter.chmod(0o755)
    cli = tools / 'codex'
    cli.write_text('#!/usr/bin/env fixture-node\n')
    cli.chmod(0o755)
    windows = home / 'windows.exe'
    windows.write_text('#!/bin/sh\nexit 0\n')
    windows.chmod(0o755)
    (tools / 'claude').symlink_to(windows)
    fx = tools / 'fx'
    fx.write_text('#!/bin/sh\necho "fx: acp ask gateway modes"\n')
    fx.chmod(0o755)
    pi = tools / 'pi-coding-agent'
    pi.write_text('#!/bin/sh\ntrue\n')
    pi.chmod(0o755)
    (home / '.codex').mkdir()
    (home / '.codex/auth.json').write_text('{}')
    with patch.object(pwd, 'getpwuid', return_value=types.SimpleNamespace(pw_shell=str(shell))), patch.object(Path, 'home', return_value=home):
        prepare_environment()
        assert '/mnt/' not in os.environ['PATH']
        assert ENVIRONMENT_READY
        assert handle({'op':'resolve_agent','provider':'codex','path':directory}) == {'path': str(cli), 'authenticated': True}
        assert handle({'op':'agent_exec','command':str(cli),'args':[],'path':directory}).strip() == 'linux-interpreter'
        try:
            handle({'op':'resolve_agent','provider':'claude','path':directory})
            raise AssertionError('Windows executable accepted')
        except ValueError:
            pass
        # One batched request resolves every provider with its auth signal; fx
        # is an ACP agent, not a `--mode rpc` one.
        resolved = handle({'op':'resolve_agents','path':directory})
        assert resolved['codex'] == {'path': str(cli), 'authenticated': True}
        assert resolved['fx'] == {'path': str(fx), 'authenticated': None}
        assert resolved['pi'] == {'path': str(pi), 'authenticated': False}
        assert 'error' in resolved['claude']
        assert 'error' in resolved['opencode']
        # The environment is reused without evaluating the shell on every probe.
        shell.unlink()
        assert handle({'op':'agent_environment','path':directory})['PATH'] == os.environ['PATH']
    # A configured shell that cannot answer falls back to a POSIX shell.
    broken = home / 'broken-shell'
    broken.write_text('#!/bin/sh\nexit 42\n')
    broken.chmod(0o755)
    ENVIRONMENT_READY = False
    with patch.object(pwd, 'getpwuid', return_value=types.SimpleNamespace(pw_shell=str(broken))), patch.object(Path, 'home', return_value=home):
        prepare_environment()
        assert ENVIRONMENT_READY
        assert os.environ.get('PATH')
"#;
        let script = format!(
            "__name__ = 'fixture'\nexec({})\n{}",
            serde_json::to_string(SCRIPT).unwrap(),
            fixture
        );
        let output = Command::new("python3")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn metadata_remains_available_during_git_while_mutations_stay_ordered() {
        use super::*;
        let mut command = Command::new("python3");
        command.args(["-u", "-c", &stdin_bootstrap(SCRIPT)]);
        let bridge = Bridge::start(&mut command, SCRIPT.as_bytes()).unwrap();
        let root = std::env::temp_dir().join(format!("monocode-read-lane-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .arg(&root)
            .status()
            .unwrap();
        let (sent, received) = mpsc::channel();
        std::thread::scope(|scope| {
            let bridge = &bridge;
            let root = &root;
            let git = scope.spawn(move || bridge.request(json!({"op":"git","path":root,
                "args":["-c","alias.hold=!touch started; while test ! -f release; do sleep 0.01; done","hold"]})));
            let deadline = Instant::now() + Duration::from_secs(5);
            while !root.join("started").exists() {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            let write = scope.spawn(move || {
                bridge.request(
                    json!({"op":"write_text","path":root.join("write"),"content":"ordered"}),
                )
            });
            scope.spawn(move || {
                sent.send(bridge.request(json!({"op":"inspect","path":root,"paths":[root]})))
                    .unwrap()
            });
            let result = received.recv_timeout(Duration::from_secs(2));
            let wrote_early = root.join("write").exists();
            std::fs::write(root.join("release"), []).unwrap();
            git.join().unwrap().unwrap();
            write.join().unwrap().unwrap();
            assert!(result.unwrap().unwrap()[0]["isDir"] == true);
            assert!(!wrote_early, "Mutation bypassed the serialized Git channel");
        });
        let escaped = root.join("escaped.txt");
        std::fs::write(&escaped, vec![1; 8 * 1024 * 1024]).unwrap();
        assert!(bridge
            .request(json!({"op":"read_text", "path":escaped}))
            .unwrap_err()
            .contains("response exceeds"));
        // Oversized encoding returns one complete error frame, not a partial
        // JSON response or a disconnected channel.
        assert!(bridge
            .request(json!({"op":"inspect", "path":root, "paths":[root]}))
            .is_ok());
        drop(bridge);
        std::fs::remove_dir_all(root).unwrap();
    }

    use super::*;
    #[test]
    fn distribution_identity_and_arguments_preserve_linux_paths() {
        let value = Location::new("Ubuntu Work", "/home/me/Zażółć repo/Case").unwrap();
        let terminal = terminal_args(&value, None);
        let marked = terminal_args(&value, Some("spawn-123"));
        assert!(marked.iter().any(|arg| arg == "MONOCODE_PTY=spawn-123"));
        assert!(marked
            .iter()
            .any(|arg| arg.starts_with("export MONOCODE_PTY_ROOT=$$; exec ")));
        assert_eq!(terminal_args(&value, Some("bad=marker")), terminal);
        let text = "echo '$HOME'; printf '%s' \"$PATH\"";
        let mut exec = crate::saved_commands::wsl_shell_args(text);
        mark_terminal_args(&mut exec, Some("spawn-456"));
        assert_eq!(exec.last().unwrap(), text);
        assert!(exec.iter().any(|arg| arg == "MONOCODE_PTY=spawn-456"));
        assert_eq!(
            &terminal[..6],
            [
                "--distribution",
                "Ubuntu Work",
                "--cd",
                "/home/me/Zażółć repo/Case",
                "--exec",
                "/usr/bin/env"
            ]
        );
        assert_eq!(terminal.last().unwrap(), "exec \"${SHELL:-/bin/sh}\" -l");
        assert_eq!(location(&value.identity()).unwrap(), Some(value.clone()));
        assert_eq!(
            location("\\\\wsl$\\Ubuntu Work\\home\\me\\Zażółć repo\\Case").unwrap(),
            Some(value.clone())
        );
        assert_ne!(value, value.with_path("/home/me/Zażółć repo/case").unwrap());
        assert_eq!(
            wsl_args(
                &value.distribution,
                &value.path,
                "/usr/bin/git",
                &["show".into(), "a;$(no)".into()]
            ),
            vec![
                "--distribution",
                "Ubuntu Work",
                "--cd",
                "/home/me/Zażółć repo/Case",
                "--exec",
                "/usr/bin/git",
                "show",
                "a;$(no)"
            ]
        );
        for invalid in ["C:/repo", "/a/../b", "/bad\npath", "/bad\\path"] {
            assert!(Location::new("Ubuntu", invalid).is_err());
        }
        assert!(location("C:\\native\\project").unwrap().is_none());
        assert_eq!(
            crate::fs::path_to_js(&crate::fs::host_path(
                std::path::Path::new(&value.identity()),
                "C:notes"
            )),
            format!("{}/C:notes", value.identity())
        );
        let bytes: Vec<_> = "\u{feff}Ubuntu\r\nDebian Work\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(
            decode_distributions(&bytes).unwrap(),
            vec!["Ubuntu", "Debian Work"]
        );
        assert!(decode_distributions(&[255, 254, 0]).is_err());
        assert!(transfer_path(&value.identity(), "C:/native", "move").is_err());
        assert!(transfer_path("C:/native", &value.identity(), "copy").is_err());
        assert!(
            transfer_path(&value.identity(), "//wsl.localhost/Debian/home/me", "copy").is_err()
        );
    }
    #[test]
    fn agent_protocol_translates_only_execution_cwd_and_rejects_other_hosts() {
        let host = Location::new("Ubuntu", "/repo space ż").unwrap();
        for field in ["cwd", "workspaceRoot"] {
            let mut request = json!({"method":"session/start", "params":{
                "prompt": "Keep ~/literal and //wsl.localhost/Ubuntu/repo",
                "tool": {"cwd":"~"}
            }});
            request["params"][field] = host.identity().into();
            let translated: Value =
                serde_json::from_str(&translate_agent_cwd(&host, request.to_string()).unwrap())
                    .unwrap();
            request["params"][field] = host.path.clone().into();
            assert_eq!(translated, request);
            for cwd in ["~", "C:\\repo", "//wsl.localhost/Debian/repo"] {
                request["params"][field] = cwd.into();
                assert!(translate_agent_cwd(&host, request.to_string()).is_err());
            }
        }
        assert!(translate_agent_cwd(
            &host,
            json!({
                "method":"session/start", "params":{
                    "cwd":host.identity(), "workspaceRoot":"//wsl.localhost/Debian/repo"
                }
            })
            .to_string()
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn filesystem_commands_use_linux_boundary_and_preserve_identity() {
        use crate::fs;
        use std::os::unix::fs::{symlink, PermissionsExt};
        use tauri::async_runtime::block_on;
        let unique = format!(
            "monocode-wsl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(&unique);
        std::fs::create_dir(&directory).unwrap();
        struct Cleanup(std::path::PathBuf, String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                HOSTS.get().unwrap().lock().unwrap().remove(&self.1);
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(directory.clone(), unique.clone());
        // Run the production Python filesystem/Git logic. macOS lacks GNU mv;
        // replace only that external process boundary and assert its exact argv.
        // Linux CI executes the real no-clobber mv command too.
        let script = format!(
            "__name__ = 'fixture'\nexec({})\n{}\nserve()",
            serde_json::to_string(SCRIPT).unwrap(),
            r#"
real_run = run
def run(argv, cwd, input_bytes=None, timeout=25):
    if argv[0] == 'git' and 'clone' in argv:
        assert argv[-4:-1] == ['clone', '--', 'https://example.invalid/clonefixture.git']
        argv = [*argv[:-2], cwd, argv[-1]]
    if argv[0] == 'gh':
        assert cwd.startswith('/') and not cwd.startswith('//')
        if len(argv) > 2 and argv[2] == 'view':
            assert argv[:7] == ['gh', 'issue', 'view', '22', '--repo', 'fixture/repo', '--json']
            assert input_bytes is None
            return 0, b'{"number":22,"title":"Linux lookup","url":"https://github.com/fixture/repo/issues/22","state":"OPEN"}', b''
        assert input_bytes == 'Literal ż body'.encode()
        if argv[1] == 'api':
            assert argv[-1] == 'body=@-'
            return 0, b'{"data":{"addPullRequestReviewThreadReply":{"comment":{"url":"https://example.invalid/reply"}}}}', b''
        assert argv == ['gh', 'issue', 'comment', '22', '--repo', 'fixture/repo', '--body-file', '-']
        return 0, b'https://example.invalid/comment', b''
    if sys.platform == 'darwin' and argv[0] == 'mv':
        assert argv[:4] == ['mv', '--no-clobber', '--no-target-directory', '--']
        if not os.path.lexists(argv[5]):
            os.rename(argv[4], argv[5])
        return 0, b'', b''
    return real_run(argv, cwd, input_bytes, timeout)
"#
        );
        let bridge = Arc::new(
            Bridge::start(
                Command::new("python3").args(["-u", "-c", &stdin_bootstrap(&script)]),
                script.as_bytes(),
            )
            .unwrap(),
        );
        HOSTS
            .get_or_init(Mutex::default)
            .lock()
            .unwrap()
            .insert(unique.clone(), bridge);
        let root = Location::new(&unique, &directory.to_string_lossy()).unwrap();
        let original = fs::create_path(root.identity(), "project before ż".into(), true).unwrap();
        let first =
            serde_json::to_value(fs::resolve_project_location(original.clone(), None).unwrap())
                .unwrap();
        let identity = first["identity"].as_str().unwrap().to_string();
        assert!(identity.starts_with(&format!("wsl:{unique}:unix:")));
        let moved = block_on(fs::rename_path(original.clone(), "project after ż".into())).unwrap();
        let resolved = serde_json::to_value(
            fs::resolve_project_location(original.clone(), Some(identity.clone())).unwrap(),
        )
        .unwrap();
        assert_eq!(resolved["path"], moved);
        assert_eq!(resolved["identity"], identity);
        assert!(fs::resolve_project_location(original.clone(), None)
            .unwrap()
            .is_none());
        assert!(fs::resolve_project_location(
            original,
            Some(identity.replace(&unique, "other-distribution"))
        )
        .unwrap()
        .is_none());
        let file = fs::create_path(root.identity(), "Zażółć file.txt".into(), false).unwrap();
        assert!(file.starts_with(&root.identity()));
        block_on(fs::write_text_file(file.clone(), "hello\r\n".into())).unwrap();
        assert_eq!(
            block_on(fs::read_text_file(file.clone())).unwrap(),
            "hello\r\n"
        );
        let missing = format!("{}/missing", root.identity());
        let stats =
            serde_json::to_value(fs::stat_files(vec![file.clone(), missing.clone()]).unwrap())
                .unwrap();
        assert_eq!(stats[0]["path"], file);
        assert!(stats[0]["mtimeMs"].is_number());
        assert!(stats[1]["mtimeMs"].is_null());
        let alias = file.replace("wsl.localhost", "wsl$").replace('/', "\\");
        let alias_stats =
            serde_json::to_value(fs::stat_files(vec![alias.clone(), file.clone()]).unwrap())
                .unwrap();
        assert_eq!(alias_stats[0]["path"], alias);
        assert_eq!(alias_stats[1]["path"], file);
        let inspected = fs::inspect_paths(vec![file.clone(), missing]).unwrap();
        assert_eq!(inspected.len(), 1);
        assert_eq!(inspected[0].path, file);
        let renamed = block_on(fs::rename_path(file.clone(), "Renamed ü.txt".into())).unwrap();
        assert!(block_on(fs::read_text_file(file.clone())).is_err());
        fs::create_path(root.identity(), "occupied.txt".into(), false).unwrap();
        assert!(block_on(fs::rename_path(renamed.clone(), "occupied.txt".into())).is_err());
        assert_eq!(
            block_on(fs::read_text_file(renamed.clone())).unwrap(),
            "hello\r\n"
        );
        let copy = block_on(fs::copy_path(renamed.clone(), root.identity())).unwrap();
        assert_ne!(copy, renamed);
        assert_eq!(
            block_on(fs::read_text_file(copy.clone())).unwrap(),
            "hello\r\n"
        );
        block_on(fs::delete_path(copy.clone())).unwrap();
        assert!(block_on(fs::read_text_file(copy)).is_err());
        let native = directory.join("Renamed ü.txt");
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&native, directory.join("link")).unwrap();
        let link = format!("{}/link", root.identity());
        block_on(fs::write_text_file(link.clone(), "through symlink".into())).unwrap();
        assert_eq!(std::fs::read_to_string(&native).unwrap(), "through symlink");
        assert_eq!(
            std::fs::metadata(&native).unwrap().permissions().mode() & 0o777,
            0o640
        );
        block_on(fs::delete_path(link)).unwrap();
        assert!(native.exists());
        assert!(fs::create_path(root.identity(), "../outside".into(), false).is_err());
        // Exercise search and worktree production routing through the same real bridge.
        let search = |query: &str, include: Option<String>| {
            block_on(crate::search::search_project(
                crate::search::SearchOptions {
                    cwd: root.identity(),
                    query: query.into(),
                    case_sensitive: false,
                    whole_word: false,
                    regex: false,
                    include,
                    exclude: None,
                },
            ))
            .unwrap()
        };
        let found = search("through symlink", None);
        assert_eq!(found.matches.len(), 1);
        assert_eq!(found.matches[0].path, renamed);
        for args in [
            vec!["init", "-b", "main"],
            vec!["add", "."],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "fixture",
            ],
        ] {
            assert!(git(&root, &args, None).unwrap().status.success());
        }
        assert_eq!(search("through symlink", None).matches.len(), 1);
        assert_eq!(
            fs::git_info_for(std::path::Path::new(&root.identity()))
                .branch
                .as_deref(),
            Some("main")
        );
        assert_eq!(
            block_on(fs::git_github_work_item_comment(
                root.identity(),
                "fixture/repo".into(),
                "issue".into(),
                22,
                "Literal ż body".into(),
                "".into()
            ))
            .unwrap(),
            "https://example.invalid/comment"
        );
        assert_eq!(
            block_on(fs::git_github_work_item_comment(
                root.identity(),
                "fixture/repo".into(),
                "pr".into(),
                22,
                "Literal ż body".into(),
                "PRRT_fixture".into()
            ))
            .unwrap(),
            "https://example.invalid/reply"
        );
        let linked = block_on(fs::git_github_work_item(
            root.identity(),
            "fixture/repo".into(),
            "issue".into(),
            22,
        ))
        .unwrap();
        assert_eq!(linked.title, "Linux lookup");
        assert_eq!(linked.repo, "fixture/repo");
        assert!(search("through symlink", Some("--no-index".into()))
            .matches
            .is_empty());
        block_on(fs::write_text_file(renamed.clone(), "changed\n".into())).unwrap();
        let diff = block_on(fs::git_file_diff(
            root.identity(),
            "Renamed ü.txt".into(),
            false,
        ))
        .unwrap();
        assert_eq!(diff.original, "through symlink");
        assert_eq!(diff.current, "changed\n");
        // Upstream's staged and unstaged views must read distinct Linux blobs.
        block_on(fs::git_stage_file(root.identity(), "Renamed ü.txt".into())).unwrap();
        block_on(fs::write_text_file(renamed.clone(), "unstaged\n".into())).unwrap();
        let staged = block_on(fs::git_file_diff(
            root.identity(),
            "Renamed ü.txt".into(),
            true,
        ))
        .unwrap();
        assert_eq!(staged.original, "through symlink");
        assert_eq!(staged.current, "changed\n");
        let unstaged = block_on(fs::git_file_diff(
            root.identity(),
            "Renamed ü.txt".into(),
            false,
        ))
        .unwrap();
        assert_eq!(unstaged.original, "changed\n");
        assert_eq!(unstaged.current, "unstaged\n");
        block_on(fs::git_unstage_file(
            root.identity(),
            "Renamed ü.txt".into(),
        ))
        .unwrap();

        let index = block_on(fs::git_diff_files(root.identity())).unwrap();
        assert!(index
            .files
            .iter()
            .any(|file| file.relative == "Renamed ü.txt"));
        block_on(fs::git_discard_file(
            root.identity(),
            "Renamed ü.txt".into(),
        ))
        .unwrap();
        assert_eq!(
            block_on(fs::read_text_file(renamed.clone())).unwrap(),
            "through symlink"
        );
        let untracked = fs::create_path(root.identity(), "discard ü.txt".into(), false).unwrap();
        block_on(fs::write_text_file(untracked.clone(), "one\ntwo\n".into())).unwrap();
        let index =
            serde_json::to_value(block_on(fs::git_diff_files(root.identity())).unwrap()).unwrap();
        assert!(index["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["relative"] == "discard ü.txt" && file["additions"] == 2));
        block_on(fs::git_discard_file(
            root.identity(),
            "discard ü.txt".into(),
        ))
        .unwrap();
        assert!(!directory.join("discard ü.txt").exists());
        let attachment = block_on(fs::write_attachment(
            "test.txt".into(),
            "aGVsbG8=".into(),
            Some(root.identity()),
        ))
        .unwrap();
        assert!(attachment.starts_with(&format!("//wsl.localhost/{unique}/")));
        assert_eq!(
            block_on(fs::read_text_file(attachment.clone())).unwrap(),
            "hello"
        );
        assert_eq!(
            block_on(fs::write_attachment(
                "test.txt".into(),
                "aGVsbG8=".into(),
                Some(root.identity())
            ))
            .unwrap(),
            attachment
        );
        let cloned = block_on(fs::clone_repo(
            "https://example.invalid/clonefixture.git".into(),
            root.identity(),
        ))
        .unwrap();
        assert!(cloned.starts_with(&format!("//wsl.localhost/{unique}/")));
        assert_eq!(
            fs::git_info_for(std::path::Path::new(&cloned))
                .branch
                .as_deref(),
            Some("main")
        );
        assert!(block_on(fs::clone_repo(
            "https://example.invalid/clonefixture.git".into(),
            root.identity()
        ))
        .is_err());
        crate::checkpoint::tests::verify_wsl_round_trip(&cloned);
        crate::checkpoint::tests::verify_wsl_integration(&cloned);
        let skill = directory.join(".agents/skills/test-wsl/SKILL.md");
        std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
        std::fs::write(
            &skill,
            "---\nname: test-wsl\ndescription: Linux skill ż\n---\nInstructions",
        )
        .unwrap();
        let skills =
            crate::skills::list_skills_from(std::path::Path::new(&root.identity()), None, None);
        assert!(skills.iter().any(|skill| skill.name == "test-wsl"
            && skill.description == "Linux skill ż"
            && skill.path.starts_with("//wsl.localhost/")));
        let child = block_on(crate::worktrees::git_worktree_create(
            root.identity(),
            "child-branch".into(),
            "main".into(),
            false,
        ))
        .unwrap()
        .path;
        let branches = block_on(fs::git_branches(root.identity())).unwrap();
        assert!(branches
            .branches
            .iter()
            .any(|branch| branch.name == "child-branch"));
        // Upstream checkout stays in the chosen worktree; Git refuses branches
        // already checked out elsewhere instead of silently changing projects.
        assert!(block_on(fs::git_checkout(
            root.identity(),
            "child-branch".into(),
            None
        ))
        .is_err());
        assert!(block_on(fs::git_checkout(child.clone(), "main".into(), None)).is_err());
        let copies = crate::worktrees::list(std::path::Path::new(&root.identity())).unwrap();
        assert_eq!(copies.len(), 2);
        assert!(copies
            .iter()
            .all(|copy| copy.path.starts_with("//wsl.localhost/")));
        crate::worktrees::tests::verify_wsl_removal(&root.identity(), &child);
        // Upstream creates worktrees in a sibling folder; this fixture owns it.
        let parent = std::path::PathBuf::from(location(&child).unwrap().unwrap().path)
            .parent()
            .unwrap()
            .to_owned();
        std::fs::remove_dir(parent).unwrap();
        if std::env::var_os("MONOCODE_WSL_MEASURE").is_some() {
            let files: Vec<_> = (0..64)
                .map(|index| {
                    let path = directory.join(format!("editor-{index}.txt"));
                    std::fs::write(&path, "open editor\n").unwrap();
                    path
                })
                .collect();
            let identities: Vec<_> = files
                .iter()
                .map(|path| root.with_path(&path.to_string_lossy()).unwrap().identity())
                .collect();
            let mut native = Vec::new();
            let mut bridged = Vec::new();
            for _ in 0..21 {
                let start = Instant::now();
                for path in &files {
                    std::fs::metadata(path).unwrap();
                }
                native.push(start.elapsed());
                let start = Instant::now();
                assert_eq!(fs::stat_files(identities.clone()).unwrap().len(), 64);
                bridged.push(start.elapsed());
            }
            native.sort();
            bridged.sort();
            eprintln!("64-file metadata / 21 samples: native median {:?}, max {:?}; Python bridge median {:?}, max {:?}. This measures the local process boundary, not Windows-to-WSL transport or WebView cost.", native[10], native[20], bridged[10], bridged[20]);
        }
    }
    #[cfg(unix)]
    #[test]
    fn linux_agent_barrier_streams_and_cancellation_use_real_processes() {
        // macOS lacks /proc. Fake only these OS identity reads; execute the
        // production supervisor, pipes, child and process-group signals.
        let script = PROCESS_SCRIPT.replace(
            "\nif __name__ ==",
            r#"
if sys.platform == 'darwin':
    identity = lambda pid: 12345
    boot_id = lambda: '01234567-0123-0123-0123-0123456789ab'
    os.pidfd_open = lambda pid: os.open('/dev/null', os.O_RDONLY)
    signal.pidfd_send_signal = lambda fd, number: os.kill(int(sys.argv[2]), number)
    class MacPoll:
        def register(self, fd, events): pass
        def poll(self, timeout):
            time.sleep(0.3)
            return [(0, 1)]
    select.poll = MacPoll

if __name__ =="#,
        );
        let location = Location::new("fixture", &std::env::temp_dir().to_string_lossy()).unwrap();
        let config = json!({"nonce":"fixture-nonce","cwd":location.path,"command":"/usr/bin/python3",
            "args":["-u","-c","import sys, json, time; print(json.dumps(sys.argv[1:]), flush=True); print(sys.stdin.readline().strip(), flush=True); time.sleep(30)","space żółć", "$(literal)"]});
        let mut child = Command::new("python3")
            .args(["-u", "-c", &script, "start", &config.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (mut stdout, process) =
            agent_handshake(child.stdout.take().unwrap(), location, "fixture-nonce").unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(b"{\"nonce\":\"fixture-nonce\",\"environment\":{}}\nprovider-message\n")
            .unwrap();
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&line).unwrap(),
            ["space żółć", "$(literal)"]
        );
        line.clear();
        stdout.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "provider-message");
        let output = crate::bounded_process::output(
            Command::new("python3").args([
                "-c",
                &script,
                "stop",
                &process.pid.to_string(),
                &process.started.to_string(),
                &process.boot,
            ]),
            Duration::from_secs(5),
            8192,
        )
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!child.wait().unwrap().success());

        let mut abandoned = Command::new("python3")
            .args(["-u", "-c", &script, "start", &config.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(abandoned.stdout.take().unwrap());
        line.clear();
        output.read_line(&mut line).unwrap();
        drop(abandoned.stdin.take());
        assert_eq!(abandoned.wait().unwrap().code(), Some(125));
        line.clear();
        output.read_to_string(&mut line).unwrap();
        assert!(
            line.is_empty(),
            "the agent must not launch before acknowledgement"
        );
    }

    #[cfg(unix)]
    #[test]
    fn linux_process_identity_rejects_reboot_and_pid_reuse() {
        let script = format!(
            "__name__ = 'fixture'\nexec({})\n{}",
            serde_json::to_string(PROCESS_SCRIPT).unwrap(),
            r#"
assert start_time('123 (agent (worker)) ' + ' '.join(['S'] + ['0'] * 18 + ['456'])) == 456
calls = []
boot_id = lambda: 'new-boot'
identity = lambda pid: 456
os.pidfd_open = lambda pid: 99
os.close = lambda fd: calls.append(('close', fd))
os.getpgid = lambda pid: pid
signal.pidfd_send_signal = lambda fd, number: calls.append(('signal', fd))
for boot, started in [('old-boot', 456), ('new-boot', 123)]:
    try:
        stop(4321, started, boot)
        raise AssertionError('stale identity accepted')
    except ValueError:
        pass
assert not any(call[0] == 'signal' for call in calls)
"#
        );
        let output = Command::new("python3")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_connections_release_slots_and_preserve_existing_hosts() {
        let registry = Mutex::new(HashMap::new());
        let path = std::env::temp_dir().to_string_lossy().into_owned();
        let missing = format!("{path}/monocode-missing-{}", std::process::id());
        let connect = |name: &str, path: &str| {
            let mut command = Command::new("python3");
            command.args(["-u", "-c", &stdin_bootstrap(SCRIPT)]);
            connect_bridge(
                &registry,
                &Location::new(name, path).unwrap(),
                &mut command,
                None,
            )
        };
        for index in 0..4 {
            assert!(connect(&format!("Bad-{index}"), &missing).is_err());
            assert!(registry.lock().unwrap().is_empty());
        }
        connect("Valid", &path).unwrap();
        let original = registry.lock().unwrap().get("valid").unwrap().clone();
        assert!(connect("Valid", &missing).is_err());
        connect("Valid", &path).unwrap();
        assert!(Arc::ptr_eq(
            &original,
            registry.lock().unwrap().get("valid").unwrap()
        ));
        for index in 1..4 {
            connect(&format!("Valid-{index}"), &path).unwrap();
        }
        assert!(connect("Fifth", &path).is_err());
        assert_eq!(registry.lock().unwrap().len(), 4);
    }

    #[cfg(unix)]
    #[test]
    fn malformed_responses_disconnect_instead_of_reusing_an_uncertain_channel() {
        for response in [
            json!({}),
            json!({"error":7}),
            json!({"ok":null,"error":"ambiguous"}),
        ] {
            let mut command = Command::new("python3");
            command.args(["-u", "-c", &stdin_bootstrap(SCRIPT)]);
            let bridge = Bridge::start(&mut command, SCRIPT.as_bytes()).unwrap();
            let error = bridge.finish_request(Ok(response), false).unwrap_err();
            assert!(error.contains("may have completed"));
            assert!(!bridge.alive.load(Ordering::SeqCst));
            assert!(bridge
                .request(json!({"op":"write_text","path":"/must-not-run"}))
                .unwrap_err()
                .contains("Reconnect"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn watchdog_expiry_overrides_a_complete_response_and_allows_reconnect() {
        let mut command = Command::new("python3");
        command.args(["-u", "-c", &stdin_bootstrap(SCRIPT)]);
        let bridge = Arc::new(Bridge::start(&mut command, SCRIPT.as_bytes()).unwrap());
        // Simulate the OS deadline firing after the read completed. Exercise
        // the production completion, process cleanup and reconnect paths.
        let error = bridge
            .finish_request(Ok(json!({"ok":null})), true)
            .unwrap_err();
        assert!(error.contains("may have completed"));
        assert!(!bridge.alive.load(Ordering::SeqCst));
        assert!(!bridge
            .process
            .lock()
            .unwrap()
            .child
            .wait()
            .unwrap()
            .success());
        assert!(bridge.request(json!({})).unwrap_err().contains("Reconnect"));
        let registry = Mutex::new(HashMap::from([("ubuntu".into(), bridge.clone())]));
        let location = Location::new("Ubuntu", &std::env::temp_dir().to_string_lossy()).unwrap();
        let connected = connect_bridge(&registry, &location, &mut command, None).unwrap();
        assert_eq!(connected.distribution, "Ubuntu");
        assert!(!Arc::ptr_eq(
            &bridge,
            registry.lock().unwrap().get("ubuntu").unwrap()
        ));
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_bridge_requests_keep_responses_and_disconnects_scoped() {
        let mut command = Command::new("python3");
        command.args(["-u", "-c", &stdin_bootstrap(SCRIPT)]);
        let bridge = Arc::new(Bridge::start(&mut command, SCRIPT.as_bytes()).unwrap());
        let directory = std::env::temp_dir().join(format!(
            "monocode-queue-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        std::thread::scope(|scope| {
            let tasks: Vec<_> = (0..8).map(|index| {
                let bridge = bridge.clone();
                let file = directory.join(format!("request-{index}"));
                scope.spawn(move || {
                    bridge.request(json!({"op":"write_text", "path":file, "content":index.to_string()})).unwrap();
                    assert_eq!(std::fs::read_to_string(file).unwrap(), index.to_string());
                })
            }).collect();
            for task in tasks {
                task.join().unwrap();
            }
        });
        // Hold the real serialization boundary, then disconnect. Pending writes
        // must fail without executing or being replayed onto a later connection.
        let lock = bridge.io.lock().unwrap();
        let (started, waiting) = mpsc::channel();
        std::thread::scope(|scope| {
            let tasks: Vec<_> = (0..4)
                .map(|index| {
                    let bridge = bridge.clone();
                    let started = started.clone();
                    let file = directory.join(format!("cancelled-{index}"));
                    scope.spawn(move || {
                        started.send(()).unwrap();
                        assert!(bridge
                            .request(
                                json!({"op":"write_text", "path":file, "content":"must not run"})
                            )
                            .unwrap_err()
                            .contains("Reconnect"));
                        assert!(!file.exists());
                    })
                })
                .collect();
            for _ in 0..4 {
                waiting.recv().unwrap();
            }
            assert!(bridge
                .finish_request(Err("fixture process disconnected".into()), false)
                .is_err());
            drop(lock);
            for task in tasks {
                task.join().unwrap();
            }
        });
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn real_bridge_reads_git_and_survives_request_errors() {
        let mut command = Command::new("python3");
        command.args(["-u", "-c", &stdin_bootstrap(SCRIPT)]);
        let bridge = Bridge::start(&mut command, SCRIPT.as_bytes()).unwrap();
        let path = std::env::temp_dir().to_string_lossy().into_owned();
        let connected = bridge
            .request(json!({"op":"connect", "path":path}))
            .unwrap();
        assert!(connected["path"].as_str().unwrap().starts_with('/'));
        assert!(bridge
            .request(json!({"op":"unknown", "path":path}))
            .is_err());
        assert!(bridge.alive.load(Ordering::SeqCst));
        assert!(bridge
            .request(json!({"op":"unknown","path":path,"content":"a".repeat(MAX_MESSAGE)}))
            .unwrap_err()
            .contains("40 MiB"));
        assert!(bridge.alive.load(Ordering::SeqCst));
        let version = bridge
            .request(json!({"op":"git", "path":path, "args":["--version"]}))
            .unwrap();
        assert_eq!(version["code"], 0);
        bridge.process.lock().unwrap().child.kill().unwrap();
        assert!(bridge
            .request(json!({"op":"connect", "path":path}))
            .is_err());
        assert!(!bridge.alive.load(Ordering::SeqCst));
        assert!(bridge
            .request(json!({"op":"connect", "path":path}))
            .unwrap_err()
            .contains("Reconnect"));
    }
}
