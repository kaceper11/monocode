//! Local multilingual dictation — engine, capture and model management.
//!
//! All audio and transcripts stay on the machine. Models are pinned,
//! checksummed whisper.cpp GGML files downloaded on demand to app data.
//! Capture (cpal) and inference (whisper-rs) run on dedicated threads.
//! `dictation_transcribe_file` is the headless diagnostics entry point.

pub mod audio_file;
pub mod capture;
pub mod catalog;
mod download;
pub mod engine;
pub mod resample;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use capture::{AudioBuffer, BufferSnapshot, MicPermission};
use catalog::ModelSpec;
use engine::{join_segments, Engine, TranscribeOptions};
use resample::WHISPER_RATE;

const PARTIAL_EVENT: &str = "dictation:partial";
const SESSION_EVENT: &str = "dictation:session";

/// Seconds of trailing audio each partial pass re-transcribes.
const PARTIAL_WINDOW_S: usize = 8;
/// A segment becomes committed once it ends this far inside the window —
/// whisper may still revise the most recent speech.
const COMMIT_MARGIN_MS: i64 = 400;
/// Worker poll cadence; cheap relative to an inference pass.
const TICK: std::time::Duration = std::time::Duration::from_millis(60);
/// How long dictation_start waits for the capture thread to report — a hung
/// device stack must not wedge the host state machine.
const START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// How long dictation_stop waits for the worker's final pass before
/// escalating to cancel — a pass that will not finish must not hold
/// `finishing` (and block every later session) forever.
const STOP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Grace after the cancel escalation, dictation_cancel's own join budget,
/// and how long a take-over cancel waits for `finishing` to clear.
const CANCEL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Poll cadence for the bounded joins — JoinHandle has no timed wait.
const JOIN_POLL: std::time::Duration = std::time::Duration::from_millis(25);

const PARTIAL_WINDOW: usize = PARTIAL_WINDOW_S * WHISPER_RATE as usize;
/// ~1.5 s of new audio between partial passes.
const PARTIAL_EVERY: u64 = WHISPER_RATE as u64 * 3 / 2;
const MIN_PARTIAL_SAMPLES: u64 = WHISPER_RATE as u64 / 2;

// ── IPC types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationModelInfo {
    pub id: String,
    pub label: String,
    pub tier: String,
    pub size_bytes: u64,
    pub installed: bool,
    /// Bytes of a resumable `.part` download on disk.
    pub partial_bytes: u64,
    pub downloading: bool,
    /// Whether this model performs the translate-to-English task.
    pub supports_translate: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub mic_permission: MicPermission,
    /// idle | starting | recording | finishing (final pass running)
    pub phase: &'static str,
    pub recording: bool,
    pub session_id: Option<u64>,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStarted {
    pub session_id: u64,
    pub device_name: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationResult {
    pub text: String,
    pub language: Option<String>,
    pub audio_ms: u64,
    pub model_load_ms: u64,
    pub infer_ms: u64,
    /// Milliseconds of audio dropped from the start because the session
    /// exceeded the buffer cap — its committed text is preserved in `text`.
    pub dropped_audio_ms: u64,
    /// Capture stream error recorded before stop, if any. The final
    /// transcript still covers whatever audio was captured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTranscript {
    pub text: String,
    pub language: Option<String>,
    pub audio_ms: u64,
    pub model_load_ms: u64,
    pub infer_ms: u64,
    pub first_segment_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PartialEvent {
    session_id: u64,
    seq: u64,
    /// All committed text so far — replaces the draft's committed portion.
    committed: String,
    /// Provisional text for the trailing window; the next partial or the
    /// final result replaces it.
    partial: String,
    audio_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEvent {
    session_id: u64,
    /// recording | finished | cancelled | error
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ── Host state ──────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
pub struct DictationHost {
    inner: Arc<Mutex<HostState>>,
    /// Serializes dictation_transcribe_file — each call loads a model
    /// (up to ~1.6 GB plus GPU buffers), so concurrent diagnostics must not
    /// pile up.
    diag: Arc<Mutex<()>>,
}

#[derive(Default)]
struct HostState {
    /// model_id → download; presence means a download thread is alive
    /// (including winding down after cancel).
    downloads: HashMap<String, Download>,
    session: Option<Session>,
    /// The starting worker's cancel flag, set before spawn — lets shutdown
    /// and takeover-cancel reach a session that does not exist yet and
    /// keeps two concurrent starts from both spawning.
    starting: Option<Arc<AtomicBool>>,
    /// The session's id and cancel flag while stop/cancel joins the worker —
    /// keeps the final pass abortable and blocks an overlapping start.
    finishing: Option<(u64, Arc<AtomicBool>)>,
    /// Workers that outlived their stop/cancel timeout — detached but still
    /// tracked so shutdown can reach their cancel flag and a later reap can
    /// collect them once they actually exit.
    orphans: Vec<OrphanedSession>,
}

struct Download {
    cancel: Arc<AtomicBool>,
    join: std::thread::JoinHandle<()>,
}

struct OrphanedSession {
    id: u64,
    cancel: Arc<AtomicBool>,
    join: WorkerJoin,
}

struct Session {
    id: u64,
    model_id: String,
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    join: WorkerJoin,
}

impl DictationHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// Abort any live session and download on window teardown or exit. The
    /// webview is gone, so events no longer matter — workers are detached
    /// (join handles dropped) and exit on their own, dropping the engine and
    /// releasing the mic. Without this a destroyed window leaves capture
    /// running indefinitely.
    pub fn shutdown(&self) {
        let mut state = self.inner.lock().unwrap();
        if let Some(session) = state.session.take() {
            session.cancel.store(true, Ordering::Relaxed);
        }
        if let Some(cancel) = state.starting.take() {
            // A worker blocked in capture start: dictation_start re-checks
            // the flag after the channel resolves and refuses to register
            // the session, so the mic is released instead of orphaned.
            cancel.store(true, Ordering::Relaxed);
        }
        if let Some((_, cancel)) = state.finishing.take() {
            cancel.store(true, Ordering::Relaxed);
        }
        for (_, download) in state.downloads.drain() {
            download.cancel.store(true, Ordering::Relaxed);
        }
        for orphan in &state.orphans {
            orphan.cancel.store(true, Ordering::Relaxed);
        }
    }
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot locate app data: {e}"))?
        .join("dictation")
        .join("models"))
}

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

fn emit_session(app: &AppHandle, session_id: u64, state: &'static str, error: Option<String>) {
    let _ = app.emit(
        SESSION_EVENT,
        SessionEvent {
            session_id,
            state,
            error,
        },
    );
}

// ── Model commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn dictation_catalog(
    app: AppHandle,
    host: State<'_, DictationHost>,
) -> Result<Vec<DictationModelInfo>, String> {
    let dir = models_dir(&app)?;
    let state = host.inner.lock().unwrap();
    Ok(catalog::MODELS
        .iter()
        .map(|spec| model_info(&dir, spec, &state))
        .collect())
}

/// The model file exists at its expected size (checksum was verified when it
/// was installed — re-hashing on every check would be gratuitous IO).
fn installed_path(dir: &Path, spec: &ModelSpec) -> Option<PathBuf> {
    let path = download::final_path(dir, spec);
    path.metadata()
        .ok()
        .filter(|m| m.len() == spec.size_bytes)
        .map(|_| path)
}

/// Shared validation for the dictation paths that need a model on disk.
fn resolve_model(
    app: &AppHandle,
    model_id: &str,
    language: &Option<String>,
    translate: bool,
) -> Result<PathBuf, String> {
    if let Some(lang) = language.as_deref() {
        if !engine::valid_language(lang) {
            return Err(format!("Unknown dictation language \"{lang}\""));
        }
    }
    let spec = catalog::find(model_id).ok_or("Unknown dictation model")?;
    if translate && !spec.supports_translate {
        return Err(format!(
            "Model \"{}\" cannot translate to English — pick a translate-capable model",
            spec.label
        ));
    }
    installed_path(&models_dir(app)?, spec).ok_or_else(|| {
        format!(
            "Model \"{}\" is not installed — download it first",
            spec.label
        )
    })
}

fn model_info(dir: &Path, spec: &ModelSpec, state: &HostState) -> DictationModelInfo {
    let installed = installed_path(dir, spec).is_some();
    let partial_bytes = download::part_path(dir, spec)
        .metadata()
        .map(|m| m.len())
        .unwrap_or(0);
    DictationModelInfo {
        id: spec.id.into(),
        label: spec.label.into(),
        tier: spec.tier.into(),
        size_bytes: spec.size_bytes,
        installed,
        partial_bytes,
        downloading: state.downloads.contains_key(spec.id),
        supports_translate: spec.supports_translate,
    }
}

#[tauri::command]
pub fn dictation_model_install(
    app: AppHandle,
    host: State<'_, DictationHost>,
    model_id: String,
) -> Result<(), String> {
    let spec = catalog::find(&model_id).ok_or("Unknown dictation model")?;
    let dir = models_dir(&app)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut state = host.inner.lock().unwrap();
        if let Some(download) = state.downloads.get(spec.id) {
            if download.join.is_finished() {
                // Finished but not yet self-removed — the worker is done
                // writing, so dropping the stale entry is safe.
                state.downloads.remove(spec.id);
            } else if download.cancel.load(Ordering::Relaxed) {
                // Cancelled but still inside its read loop — a second
                // writer must not open the same .part until it exits.
                return Err("The previous download is still stopping — try again".into());
            } else {
                return Ok(()); // already running
            }
        }
        if installed_path(&dir, spec).is_some() {
            return Ok(());
        }
        let thread_app = app.clone();
        let thread_host = host.inner.clone();
        let thread_id = spec.id.to_string();
        let thread_cancel = Arc::clone(&cancel);
        let join = std::thread::spawn(move || {
            download::download_model(&thread_app, spec, &dir, thread_cancel);
            thread_host.lock().unwrap().downloads.remove(&thread_id);
        });
        state
            .downloads
            .insert(spec.id.into(), Download { cancel, join });
    }
    Ok(())
}

#[tauri::command]
pub fn dictation_model_cancel_download(
    host: State<'_, DictationHost>,
    model_id: String,
) -> Result<(), String> {
    let state = host.inner.lock().unwrap();
    match state.downloads.get(&model_id) {
        // Keep the map entry until the thread exits so catalog/status still
        // show the download winding down and a fresh install can't race it.
        Some(download) => {
            download.cancel.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err("No download in progress for that model".into()),
    }
}

/// Reap a session whose worker already exited (stream error, panic) so a
/// stale entry cannot block later operations. Emits the session event the
/// worker itself could not send if it panicked. Also collects orphaned
/// workers that have since exited.
fn reap_finished_session(state: &mut HostState, app: &AppHandle) {
    if let Some(s) = state.session.as_ref() {
        if s.join.is_finished() {
            let stale = state.session.take().unwrap();
            if stale.join.join().is_err() {
                emit_panic(app, stale.id);
            }
        }
    }
    let mut i = 0;
    while i < state.orphans.len() {
        if state.orphans[i].join.is_finished() {
            let orphan = state.orphans.remove(i);
            // An orphan was already reported — joining just frees the
            // thread; a panic is still worth surfacing to any listener.
            if orphan.join.join().is_err() {
                emit_panic(app, orphan.id);
            }
        } else {
            i += 1;
        }
    }
}

/// A session worker's join handle, and its output once collected.
type WorkerJoin = std::thread::JoinHandle<Result<DictationResult, String>>;
type WorkerOutcome = std::thread::Result<Result<DictationResult, String>>;

/// `JoinHandle` has no timed wait — poll `is_finished` until the deadline.
/// `Err(join)` hands the handle back so the caller can escalate to cancel
/// or park it in `orphans` rather than blocking on a stuck worker forever.
fn join_with_timeout(
    join: WorkerJoin,
    timeout: std::time::Duration,
) -> Result<WorkerOutcome, WorkerJoin> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if join.is_finished() {
            return Ok(join.join());
        }
        if std::time::Instant::now() >= deadline {
            return Err(join);
        }
        std::thread::sleep(JOIN_POLL);
    }
}

/// The worker died before it could report — surface it on the session
/// event channel like any other failure.
fn emit_panic(app: &AppHandle, id: u64) {
    emit_session(app, id, "error", Some("Dictation worker panicked".into()));
}

/// Clear `starting` only while it still belongs to this attempt — a
/// takeover cancel takes the flag and a retried start may already have
/// installed a newer one, which must not be wiped.
fn clear_starting(state: &mut HostState, cancel: &Arc<AtomicBool>) {
    if state
        .starting
        .as_ref()
        .is_some_and(|flag| Arc::ptr_eq(flag, cancel))
    {
        state.starting = None;
    }
}

/// Clear `finishing` only while it still names this session — after a
/// takeover force-clear a newer session may already own the entry.
fn clear_finishing(state: &mut HostState, id: u64) {
    if state
        .finishing
        .as_ref()
        .is_some_and(|(owner, _)| *owner == id)
    {
        state.finishing = None;
    }
}

#[tauri::command]
pub fn dictation_model_remove(
    app: AppHandle,
    host: State<'_, DictationHost>,
    model_id: String,
) -> Result<(), String> {
    let spec = catalog::find(&model_id).ok_or("Unknown dictation model")?;
    {
        let mut state = host.inner.lock().unwrap();
        reap_finished_session(&mut state, &app);
        if state.downloads.contains_key(spec.id) {
            return Err("Cancel the download before removing this model".into());
        }
        if state.starting.is_some() || state.finishing.is_some() {
            return Err("A dictation session is starting or finishing".into());
        }
        if state.session.as_ref().map(|s| s.model_id.as_str()) == Some(spec.id) {
            return Err("Model is in use by an active dictation".into());
        }
    }
    let dir = models_dir(&app)?;
    let _ = std::fs::remove_file(download::part_path(&dir, spec));
    match std::fs::remove_file(download::final_path(&dir, spec)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result.map_err(|e| format!("Cannot remove model: {e}")),
    }
}

// ── Permission / status commands ────────────────────────────────────────────

#[tauri::command]
pub fn dictation_status(app: AppHandle, host: State<'_, DictationHost>) -> DictationStatus {
    // TCC can stall — never call the framework while holding the host lock.
    let mic_permission = capture::mic_permission();
    let mut state = host.inner.lock().unwrap();
    reap_finished_session(&mut state, &app);
    let active = state
        .session
        .as_ref()
        .is_some_and(|s| !s.join.is_finished());
    let phase = if active {
        "recording"
    } else if state.starting.is_some() {
        "starting"
    } else if state.finishing.is_some() {
        "finishing"
    } else {
        "idle"
    };
    DictationStatus {
        mic_permission,
        phase,
        recording: active,
        session_id: state.session.as_ref().map(|s| s.id),
        model_id: state.session.as_ref().map(|s| s.model_id.clone()),
    }
}

/// Show the system prompt when undetermined; returns the resulting state.
#[tauri::command(async)]
pub fn dictation_request_mic_permission() -> MicPermission {
    capture::request_mic_permission()
}

/// Open the OS settings page for mic access (macOS); no-op elsewhere.
#[tauri::command]
pub fn dictation_open_mic_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn();
    }
}

// ── Dictation session commands ──────────────────────────────────────────────

#[tauri::command(async)]
pub fn dictation_start(
    app: AppHandle,
    host: State<'_, DictationHost>,
    model_id: String,
    language: Option<String>,
    translate: bool,
) -> Result<DictationStarted, String> {
    let model_path = resolve_model(&app, &model_id, &language, translate)?;
    match capture::mic_permission() {
        MicPermission::Denied | MicPermission::Restricted => {
            return Err(
                "Microphone access is off — enable it in System Settings → Privacy & Security → Microphone"
                    .into(),
            )
        }
        MicPermission::NotDetermined => {
            // Sentinel the frontend matches to trigger the TCC prompt via
            // dictation_request_mic_permission, then retry.
            return Err("mic-permission-not-determined".into())
        }
        _ => {}
    }
    let id = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut state = host.inner.lock().unwrap();
        reap_finished_session(&mut state, &app);
        if state.session.is_some() || state.starting.is_some() || state.finishing.is_some() {
            return Err("A dictation session is already running".into());
        }
        // Expose the flag before spawning so shutdown/cancel can reach the
        // worker while it is still starting the stream.
        state.starting = Some(Arc::clone(&cancel));
    }

    let buffer = AudioBuffer::shared();
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();

    let spawn = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let app = app.clone();
        let stop = Arc::clone(&stop);
        let cancel = Arc::clone(&cancel);
        let language = language.clone();
        std::thread::spawn(move || {
            // Capture is created on this thread so the cpal stream never
            // crosses threads; start errors come back through `tx`.
            let capture = match capture::start(Arc::clone(&buffer)) {
                Ok(capture) => {
                    let _ = tx.send(Ok(capture.device_name().to_string()));
                    capture
                }
                Err(error) => {
                    let _ = tx.send(Err(error));
                    return Err("capture failed".into());
                }
            };
            let io = SessionIo {
                app: &app,
                buffer: &buffer,
                stop: &stop,
                cancel: &cancel,
            };
            // Emit the error event from here — a panic discovered only via
            // join() would otherwise wait for an unrelated command to reap.
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_session(&io, id, &model_path, language, translate, capture)
            })) {
                Ok(result) => result,
                Err(_) => {
                    emit_panic(&app, id);
                    Err("Dictation worker panicked".into())
                }
            }
        })
    }));
    let join = match spawn {
        Ok(join) => join,
        Err(_) => {
            clear_starting(&mut host.inner.lock().unwrap(), &cancel);
            return Err("Cannot start the dictation worker".into());
        }
    };

    // A hung device enumeration would otherwise wedge the host forever —
    // every start "already running", cancel and shutdown unable to reach it.
    let outcome = rx.recv_timeout(START_TIMEOUT);
    let mut state = host.inner.lock().unwrap();
    clear_starting(&mut state, &cancel);
    match outcome {
        Ok(Ok(device_name)) if !cancel.load(Ordering::Relaxed) => {
            state.session = Some(Session {
                id,
                model_id: model_id.clone(),
                stop,
                cancel,
                join,
            });
            Ok(DictationStarted {
                session_id: id,
                device_name,
                model_id,
            })
        }
        Ok(Ok(_)) => {
            // Shutdown/takeover cancelled mid-start — drop the handle; the
            // worker exits at its loop-top cancel check and drops capture.
            drop(join);
            Err("cancelled".into())
        }
        Ok(Err(error)) => {
            let _ = join.join();
            Err(error)
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // The worker never reported in: stop it from registering later.
            // Detached but tracked — shutdown can still reach its cancel
            // flag and a later reap collects it if it ever exits.
            cancel.store(true, Ordering::Relaxed);
            state.orphans.push(OrphanedSession { id, cancel, join });
            Err("Microphone did not respond — check the input device".into())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let _ = join.join();
            Err("Dictation worker exited before starting".into())
        }
    }
}

#[tauri::command(async)]
pub fn dictation_stop(
    app: AppHandle,
    host: State<'_, DictationHost>,
    session_id: u64,
) -> Result<DictationResult, String> {
    let session = {
        let mut state = host.inner.lock().unwrap();
        // A stop for a session that isn't current must not take over whatever
        // session replaced it — the caller's session is already gone.
        match state.session.as_ref() {
            Some(session) if session_id != session.id => {
                return Err("No dictation in progress".into());
            }
            _ => {}
        }
        let Some(session) = state.session.take() else {
            return Err("No dictation in progress".into());
        };
        session.stop.store(true, Ordering::Relaxed);
        // Keep the cancel flag reachable so the final pass can still abort,
        // and block a new session from overlapping this one.
        state.finishing = Some((session.id, Arc::clone(&session.cancel)));
        session
    };
    let id = session.id;
    let cancel = Arc::clone(&session.cancel);
    // Bound the wait: the final pass is unbounded CPU work, and a worker
    // that will not exit must not hold `finishing` — and therefore block
    // every later session — forever.
    let outcome = match join_with_timeout(session.join, STOP_TIMEOUT) {
        Ok(outcome) => outcome,
        Err(join) => {
            // Escalate to cancel — the final pass checks the flag at each
            // decoding step, so a healthy worker exits inside the grace.
            cancel.store(true, Ordering::Relaxed);
            match join_with_timeout(join, CANCEL_TIMEOUT) {
                Ok(outcome) => outcome,
                Err(join) => {
                    // Truly stuck — park it so `finishing` can't wedge every
                    // later session; reaped when (if) it ever exits.
                    {
                        let mut state = host.inner.lock().unwrap();
                        clear_finishing(&mut state, id);
                        state.orphans.push(OrphanedSession { id, cancel, join });
                    }
                    let message = "Dictation took too long to stop — the session was abandoned";
                    emit_session(&app, id, "error", Some(message.into()));
                    return Err(message.into());
                }
            }
        }
    };
    clear_finishing(&mut host.inner.lock().unwrap(), id);
    match outcome {
        Ok(result) => result,
        Err(_) => {
            emit_panic(&app, id);
            Err("Dictation worker panicked".into())
        }
    }
}

#[tauri::command(async)]
pub fn dictation_cancel(
    app: AppHandle,
    host: State<'_, DictationHost>,
    session_id: Option<u64>,
) -> Result<(), String> {
    enum Pending {
        /// The session was this call's to take — join its worker below.
        Join(Session),
        /// Stop/cancel already took it — the flag was set; wait for the
        /// owner to clear `finishing` so a take-over retry can't hit a
        /// stale "already running". Carries the watched session id.
        WaitClear(u64),
    }
    let pending = {
        let mut state = host.inner.lock().unwrap();
        match state.session.as_ref() {
            Some(session) if session_id.is_some_and(|id| id != session.id) => {
                return Err("No dictation in progress".into());
            }
            _ => {}
        }
        match state.session.take() {
            Some(session) => {
                session.cancel.store(true, Ordering::Relaxed);
                state.finishing = Some((session.id, Arc::clone(&session.cancel)));
                Pending::Join(session)
            }
            None => match state.finishing.as_ref() {
                // Stop already took the session — abort its final pass.
                Some((id, cancel)) if session_id.is_none_or(|wanted| wanted == *id) => {
                    cancel.store(true, Ordering::Relaxed);
                    Pending::WaitClear(*id)
                }
                Some(_) => return Err("No dictation in progress".into()),
                // An id-less cancel is an explicit takeover — a session
                // still starting has no id yet, so only None can abort it.
                None => match state.starting.take() {
                    Some(cancel) if session_id.is_none() => {
                        cancel.store(true, Ordering::Relaxed);
                        return Ok(());
                    }
                    Some(cancel) => {
                        state.starting = Some(cancel);
                        return Err("No dictation in progress".into());
                    }
                    None => return Err("No dictation in progress".into()),
                },
            },
        }
    };
    match pending {
        Pending::WaitClear(watched) => {
            // The command that owns the join clears `finishing` when the
            // worker exits — wait for it so a retried start sees a clean
            // host. If it never clears, take the flag: the worker's cancel
            // is already set, so the stale entry is dead weight either way.
            let deadline = std::time::Instant::now() + CANCEL_TIMEOUT;
            loop {
                {
                    let mut state = host.inner.lock().unwrap();
                    // Done once the watched entry is gone — cleared by its
                    // owner, or replaced by a newer session's.
                    let still_watched = state
                        .finishing
                        .as_ref()
                        .is_some_and(|(id, _)| *id == watched);
                    if !still_watched {
                        return Ok(());
                    }
                    if std::time::Instant::now() >= deadline {
                        state.finishing = None;
                        return Ok(());
                    }
                }
                std::thread::sleep(JOIN_POLL);
            }
        }
        Pending::Join(session) => {
            let id = session.id;
            let cancel = Arc::clone(&session.cancel);
            match join_with_timeout(session.join, CANCEL_TIMEOUT) {
                Ok(outcome) => {
                    clear_finishing(&mut host.inner.lock().unwrap(), id);
                    if outcome.is_err() {
                        emit_panic(&app, id);
                    }
                }
                Err(join) => {
                    // Cancel was already set — park the stuck worker rather
                    // than blocking on it forever; reaped once it exits.
                    {
                        let mut state = host.inner.lock().unwrap();
                        clear_finishing(&mut state, id);
                        state.orphans.push(OrphanedSession { id, cancel, join });
                    }
                    // The owning composer is still showing this session —
                    // nothing else will clear its UI now.
                    emit_session(&app, id, "cancelled", None);
                }
            }
            Ok(())
        }
    }
}

// ── Session worker ──────────────────────────────────────────────────────────

/// Shared session plumbing handed to the worker thread.
struct SessionIo<'a> {
    app: &'a AppHandle,
    buffer: &'a Arc<Mutex<AudioBuffer>>,
    stop: &'a Arc<AtomicBool>,
    cancel: &'a Arc<AtomicBool>,
}

/// The trailing audio no partial pass committed — the only part the final
/// transcription needs to decode. `committed_end_ms` is on the snapshot's
/// absolute timeline; commits may cover silence decoded to empty text, so
/// the boundary alone decides — not whether any words came out of it.
fn uncommitted_tail(snapshot: &BufferSnapshot, committed_end_ms: i64) -> &[f32] {
    if committed_end_ms <= 0 {
        return &snapshot.samples;
    }
    let committed_end = committed_end_ms as u64 * WHISPER_RATE as u64 / 1000;
    let start = committed_end
        .saturating_sub(snapshot.base)
        .min(snapshot.samples.len() as u64) as usize;
    &snapshot.samples[start..]
}

/// `true` when a non-trivial session captured only exact zeros (or nothing
/// at all — `all` holds on an empty slice) — a real mic always produces
/// noise, so this means the OS tap delivered nothing: dead device, or mic
/// privacy serving silence to desktop apps on Windows. `duration_ms` is
/// the longer of the audio length and the session's wall-clock time.
fn captured_only_silence(samples: &[f32], duration_ms: u64) -> bool {
    duration_ms > 1_500 && samples.iter().all(|s| *s == 0.0)
}

fn run_session(
    io: &SessionIo<'_>,
    session_id: u64,
    model_path: &Path,
    language: Option<String>,
    translate: bool,
    capture: capture::Capture,
) -> Result<DictationResult, String> {
    let SessionIo {
        app,
        buffer,
        stop,
        cancel,
    } = *io;
    // A takeover or the start timeout may have cancelled while the stream
    // was still opening — don't spend seconds loading a model for a dead
    // session.
    if cancel.load(Ordering::Relaxed) {
        emit_session(app, session_id, "cancelled", None);
        return Err("cancelled".into());
    }
    let (engine, load_ms) = match Engine::load(model_path) {
        Ok(ok) => ok,
        Err(error) => {
            emit_session(app, session_id, "error", Some(error.clone()));
            return Err(error);
        }
    };
    emit_session(app, session_id, "recording", None);
    let recording_since = std::time::Instant::now();

    let opts = TranscribeOptions {
        language: language.clone(),
        translate,
        no_context: true,
        temperature_inc: 0.0,
    };
    let mut committed = String::new();
    let mut committed_end_ms: i64 = 0;
    let mut last_partial_end: u64 = 0;
    let mut seq = 0u64;

    loop {
        if cancel.load(Ordering::Relaxed) {
            emit_session(app, session_id, "cancelled", None);
            // `engine` drops here → model memory released.
            return Err("cancelled".into());
        }
        // Peek without cloning — `tail` would copy ~512 KB every 60 ms tick.
        let (end_abs, base, stream_error) = buffer.lock().unwrap().stats();
        if let Some(error) = stream_error {
            emit_session(app, session_id, "error", Some(error.clone()));
            return Err(error);
        }
        let enough_new = end_abs.saturating_sub(last_partial_end) >= PARTIAL_EVERY;
        let enough_total = end_abs.saturating_sub(base) >= MIN_PARTIAL_SAMPLES;
        if stop.load(Ordering::Relaxed) {
            break;
        }
        if enough_new && enough_total {
            last_partial_end = end_abs;
            let snapshot = buffer.lock().unwrap().tail(PARTIAL_WINDOW);
            // Abort a partial pass on stop too — it would otherwise finish
            // before the loop notices and delay the final pass by seconds.
            let abort = {
                let stop = Arc::clone(stop);
                let cancel = Arc::clone(cancel);
                move || stop.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed)
            };
            match engine.transcribe(&snapshot.samples, &opts, abort) {
                Ok(transcript) => {
                    let window_start_ms = (snapshot.base * 1000 / WHISPER_RATE as u64) as i64;
                    let now_ms = (end_abs * 1000 / WHISPER_RATE as u64) as i64;
                    let mut partial = Vec::new();
                    let mut deferred = false;
                    for seg in &transcript.segments {
                        let seg_start = window_start_ms + seg.start_ms;
                        let seg_end = window_start_ms + seg.end_ms;
                        if seg_end <= committed_end_ms {
                            // Already committed — don't echo it in the partial.
                            continue;
                        }
                        // Commit only whole segments that start after the last
                        // commit — and stop committing once one is deferred,
                        // so the commit point never jumps over audio the
                        // tail pass would then skip below `committed_end_ms`.
                        if !deferred
                            && seg_end <= now_ms - COMMIT_MARGIN_MS
                            && seg_start >= committed_end_ms
                        {
                            let text = seg.text.trim();
                            if !text.is_empty() {
                                if !committed.is_empty() {
                                    committed.push(' ');
                                }
                                committed.push_str(text);
                            }
                            committed_end_ms = seg_end;
                        } else {
                            deferred = true;
                            partial.push(seg.clone());
                        }
                    }
                    seq += 1;
                    let _ = app.emit(
                        PARTIAL_EVENT,
                        PartialEvent {
                            session_id,
                            seq,
                            committed: committed.clone(),
                            partial: join_segments(&partial),
                            audio_ms: now_ms as u64,
                        },
                    );
                }
                Err(error) => {
                    if cancel.load(Ordering::Relaxed) {
                        emit_session(app, session_id, "cancelled", None);
                        return Err("cancelled".into());
                    }
                    if stop.load(Ordering::Relaxed) {
                        break; // the partial was aborted by stop, not a failure
                    }
                    emit_session(app, session_id, "error", Some(error.clone()));
                    return Err(error);
                }
            }
        }
        std::thread::sleep(TICK);
    }

    // Stop the stream before the big snapshot so nothing is pushing — and so
    // the lock isn't held while the copy contends with the RT callback.
    drop(capture);

    // Final pass over the still-uncommitted tail — everything before
    // `committed_end_ms` was already decoded by the partial passes, and
    // re-transcribing a whole session on a CPU-bound platform takes minutes,
    // which presents exactly like a hang.
    let snapshot = buffer.lock().unwrap().snapshot();
    let dropped_audio_ms = snapshot.base * 1000 / WHISPER_RATE as u64;
    let audio_ms = snapshot.end() * 1000 / WHISPER_RATE as u64;
    // Wall clock covers the no-callback case — a privacy-blocked mic can
    // deliver zero samples rather than zeroed buffers. When nothing ever
    // committed, all-zero (or absent) samples mean the OS tap gave us
    // nothing: dead device, or mic privacy serving silence on Windows.
    // Skip the decode entirely — transcribing minutes of zeros is exactly
    // the unbounded final pass this is meant to bound.
    let elapsed_ms = recording_since.elapsed().as_millis() as u64;
    let silent =
        committed.is_empty() && captured_only_silence(&snapshot.samples, audio_ms.max(elapsed_ms));
    let stream_error = snapshot.error.clone().or(silent.then(|| {
        "The microphone captured only silence — check the input device and the OS microphone privacy setting".into()
    }));
    if silent {
        emit_session(app, session_id, "finished", None);
        return Ok(DictationResult {
            text: committed,
            language: None,
            audio_ms,
            model_load_ms: load_ms,
            infer_ms: 0,
            dropped_audio_ms,
            stream_error,
        });
    }
    let tail = uncommitted_tail(&snapshot, committed_end_ms);
    let final_opts = TranscribeOptions {
        language,
        translate,
        no_context: false,
        temperature_inc: 0.2,
    };
    let abort = {
        // `stop` is already set — the final pass must only abort on cancel.
        let cancel = Arc::clone(cancel);
        move || cancel.load(Ordering::Relaxed)
    };
    // `engine` drops on every return path → model memory released.
    match engine.transcribe(tail, &final_opts, abort) {
        Ok(transcript) => {
            // `committed` already covers the audio the tail skipped — the
            // merge the dropped-head case relied on, now unconditional. A
            // word clipped exactly at the boundary can echo in the tail.
            let text = if !committed.is_empty() && !transcript.text.is_empty() {
                format!("{} {}", committed, transcript.text)
            } else if !committed.is_empty() {
                committed
            } else {
                transcript.text
            };
            emit_session(app, session_id, "finished", None);
            Ok(DictationResult {
                text,
                language: transcript.language,
                audio_ms,
                model_load_ms: load_ms,
                infer_ms: transcript.infer_ms,
                dropped_audio_ms,
                stream_error,
            })
        }
        Err(error) => {
            if cancel.load(Ordering::Relaxed) {
                emit_session(app, session_id, "cancelled", None);
                return Err("cancelled".into());
            }
            emit_session(app, session_id, "error", Some(error.clone()));
            Err(error)
        }
    }
}

// ── Diagnostics: transcribe a file without the mic ─────────────────────────

/// Test entry point: transcribe/translate a WAV file through the same engine
/// the session worker uses. Not wired to the composer.
#[tauri::command(async)]
pub fn dictation_transcribe_file(
    app: AppHandle,
    host: State<'_, DictationHost>,
    path: String,
    model_id: String,
    language: Option<String>,
    translate: bool,
) -> Result<FileTranscript, String> {
    let model_path = resolve_model(&app, &model_id, &language, translate)?;
    // Each call loads the model fresh — serialize so parallel diagnostics
    // can't multiply that memory spike.
    let _diag = host.diag.lock().unwrap();
    let samples = audio_file::read_wav_mono(std::path::Path::new(&path))?;
    let audio_ms = samples.len() as u64 * 1000 / WHISPER_RATE as u64;
    let (engine, load_ms) = Engine::load(&model_path)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let opts = TranscribeOptions {
        language,
        translate,
        no_context: false,
        temperature_inc: 0.2,
    };
    let transcript = engine.transcribe(&samples, &opts, move || cancel.load(Ordering::Relaxed))?;
    Ok(FileTranscript {
        text: transcript.text,
        language: transcript.language,
        audio_ms,
        model_load_ms: load_ms,
        infer_ms: transcript.infer_ms,
        first_segment_ms: transcript.first_segment_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(base: u64, len: usize) -> BufferSnapshot {
        BufferSnapshot {
            base,
            samples: vec![1.0; len],
            error: None,
        }
    }

    fn empty_result() -> Result<DictationResult, String> {
        Ok(DictationResult {
            text: String::new(),
            language: None,
            audio_ms: 0,
            model_load_ms: 0,
            infer_ms: 0,
            dropped_audio_ms: 0,
            stream_error: None,
        })
    }

    #[test]
    fn tail_slices_from_the_commit_point() {
        // Buffer covers absolute samples [1600, 4800); committed through
        // 200 ms == absolute sample 3200 → the tail is the last 1600.
        let snap = snapshot(1600, 3200);
        let tail = uncommitted_tail(&snap, 200);
        assert_eq!(tail.len(), 1600);
    }

    #[test]
    fn tail_is_whole_buffer_when_nothing_committed() {
        let snap = snapshot(0, 100);
        assert_eq!(uncommitted_tail(&snap, 0).len(), 100);
    }

    #[test]
    fn tail_slices_even_when_commits_were_textless() {
        // Commit points can cover silence decoded to empty text — the
        // boundary alone decides, so a long quiet prefix still bounds the
        // final pass.
        let snap = snapshot(1600, 3200);
        assert_eq!(uncommitted_tail(&snap, 200).len(), 1600);
    }

    #[test]
    fn tail_is_empty_when_commit_reached_the_end() {
        let snap = snapshot(0, 100);
        assert!(uncommitted_tail(&snap, 60_000).is_empty());
    }

    #[test]
    fn tail_clamps_when_commit_predates_the_buffer() {
        // The buffer cap dropped already-committed audio → re-decode what
        // remains and let the merge prepend the committed text.
        let snap = snapshot(1600, 100);
        assert_eq!(uncommitted_tail(&snap, 10).len(), 100);
    }

    #[test]
    fn silence_detection_flags_a_dead_tap() {
        let silence = vec![0.0; 24_000];
        assert!(captured_only_silence(&silence, 2_000));
        // Too short to accuse the device — a quick toggle is legitimate.
        assert!(!captured_only_silence(&silence, 500));
        // No callbacks at all (empty buffer) is still a dead tap when the
        // session ran long enough on the wall clock.
        assert!(captured_only_silence(&[], 60_000));
        let mut noise = silence;
        noise[100] = 0.001;
        assert!(!captured_only_silence(&noise, 60_000));
    }

    #[test]
    fn join_with_timeout_collects_a_finished_worker() {
        let join = std::thread::spawn(empty_result);
        let outcome = join_with_timeout(join, std::time::Duration::from_secs(5));
        assert!(outcome.map(|r| r.is_ok()).unwrap_or(false));
    }

    #[test]
    fn join_with_timeout_hands_back_a_running_worker() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let join = std::thread::spawn(move || -> Result<DictationResult, String> {
            let _ = rx.recv();
            empty_result()
        });
        let join = match join_with_timeout(join, std::time::Duration::from_millis(50)) {
            Ok(_) => panic!("worker should still be running"),
            Err(join) => join,
        };
        drop(tx);
        assert!(join.join().is_ok());
    }
}
