//! Model downloads: pinned URL → `.part` file → sha256 check → rename.
//! Runs on a background thread; progress goes to the frontend over
//! `dictation:model-progress`. Interrupted downloads keep the `.part` file
//! and resume with a `Range` request on the next install call.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use super::catalog::ModelSpec;

pub const PROGRESS_EVENT: &str = "dictation:model-progress";

const CHUNK: usize = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// Per-operation timeouts — connect and each socket read/write. The overall
/// transfer is intentionally unbounded: model files reach 1.6 GB.
const HTTP_OP_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = "MonoCode";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    /// downloading | verifying | done | cancelled | failed
    pub phase: &'static str,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DownloadProgress {
    fn emit(app: &AppHandle, progress: &DownloadProgress) {
        let _ = app.emit(PROGRESS_EVENT, progress);
    }
}

pub fn part_path(dir: &Path, spec: &ModelSpec) -> PathBuf {
    dir.join(format!("{}.part", spec.file))
}

pub fn final_path(dir: &Path, spec: &ModelSpec) -> PathBuf {
    dir.join(spec.file)
}

pub struct ModelLock(std::fs::File);

impl Drop for ModelLock {
    fn drop(&mut self) {
        // Closing only our descriptor can leave a lock held by a forked child
        // until exec. Release it when the owning operation actually finishes.
        let _ = self.0.unlock();
    }
}

/// All app instances use the same OS file lock; no persistent ownership marker.
pub fn model_lock(dir: &Path, spec: &ModelSpec) -> Result<ModelLock, String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("{}.lock", spec.file));
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
        .map_err(|error| format!("Cannot lock model: {error}"))?;
    file.try_lock().map_err(|error| {
        format!("This model is being changed by another window or app: {error}")
    })?;
    Ok(ModelLock(file))
}

/// Download `spec` into `dir`, resuming any `.part` file. Blocking — run on a
/// worker thread. Emits progress events throughout.
pub fn download_model(
    app: &AppHandle,
    spec: &'static ModelSpec,
    dir: &Path,
    cancel: Arc<AtomicBool>,
) {
    match download_from(&spec.url(), spec, dir, &cancel, Some(app)) {
        Ok(()) => DownloadProgress::emit(
            app,
            &DownloadProgress {
                model_id: spec.id.into(),
                phase: "done",
                downloaded_bytes: spec.size_bytes,
                total_bytes: spec.size_bytes,
                error: None,
            },
        ),
        Err(error) => {
            let cancelled = cancel.load(Ordering::Relaxed);
            DownloadProgress::emit(
                app,
                &DownloadProgress {
                    model_id: spec.id.into(),
                    phase: if cancelled { "cancelled" } else { "failed" },
                    downloaded_bytes: error.downloaded,
                    total_bytes: spec.size_bytes,
                    error: (!cancelled).then_some(error.message),
                },
            );
        }
    }
}

#[derive(Debug)]
struct DownloadError {
    message: String,
    /// Bytes on disk when the error hit — reported so the UI can show the
    /// resume point on failed/cancelled.
    downloaded: u64,
}

impl DownloadError {
    fn new(message: impl Into<String>, downloaded: u64) -> Self {
        Self {
            message: message.into(),
            downloaded,
        }
    }
}

fn download_from(
    url: &str,
    spec: &'static ModelSpec,
    dir: &Path,
    cancel: &AtomicBool,
    app: Option<&AppHandle>,
) -> Result<(), DownloadError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(DownloadError::new("cancelled", 0));
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| DownloadError::new(format!("Cannot create model directory: {e}"), 0))?;
    let _lock = model_lock(dir, spec).map_err(|error| DownloadError::new(error, 0))?;
    let part = part_path(dir, spec);
    let final_path = final_path(dir, spec);

    let mut downloaded = part.metadata().map(|m| m.len()).unwrap_or(0);
    if downloaded > spec.size_bytes {
        // Stale or oversized partial — start over.
        let _ = std::fs::remove_file(&part);
        downloaded = 0;
    }

    let mut hasher = Sha256::new();
    if downloaded > 0 {
        emit(app, spec, "verifying", downloaded);
        // Hash the resumed prefix so the final digest covers the whole file.
        hash_prefix(&part, downloaded, &mut hasher, cancel)
            .map_err(|e| DownloadError::new(e, downloaded))?;
        if downloaded == spec.size_bytes {
            // Fetched previously but the process died before the rename —
            // requesting `Range: bytes=<size>-` would just get a 416.
            if cancel.load(Ordering::Relaxed) {
                return Err(DownloadError::new("cancelled", downloaded));
            }
            return verify_and_install(&part, &final_path, spec, hasher, downloaded);
        }
    }

    let mut request = ureq::AgentBuilder::new()
        .timeout_connect(HTTP_OP_TIMEOUT)
        .timeout_read(HTTP_OP_TIMEOUT)
        .timeout_write(HTTP_OP_TIMEOUT)
        .build()
        .get(url)
        .set("User-Agent", USER_AGENT)
        // A transparent gzip decode would make `downloaded`/`Content-Length`
        // count decompressed bytes while size_bytes counts wire bytes.
        .set("Accept-Encoding", "identity");
    if downloaded > 0 {
        request = request.set("Range", &format!("bytes={downloaded}-"));
    }
    let response = match request.call() {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => {
            return Err(DownloadError::new(
                format!("Model download failed (HTTP {status})"),
                downloaded,
            ))
        }
        Err(error) => {
            return Err(DownloadError::new(
                format!("Model download failed: {error}"),
                downloaded,
            ))
        }
    };

    // A 200 to a Range request means the server ignored resumption — restart.
    if downloaded > 0 && response.status() == 200 {
        hasher = Sha256::new();
        downloaded = 0;
    }
    if !matches!(response.status(), 200 | 206) {
        return Err(DownloadError::new(
            "Unexpected model download response",
            downloaded,
        ));
    }
    if response.status() == 206 {
        let expected = format!(
            "bytes {}-{}/{}",
            downloaded,
            spec.size_bytes - 1,
            spec.size_bytes
        );
        if response.header("Content-Range") != Some(expected.as_str()) {
            return Err(DownloadError::new(
                "Model resume range changed; partial download was preserved",
                downloaded,
            ));
        }
    }
    if let Some(encoding) = response.header("Content-Encoding") {
        if encoding != "identity" {
            return Err(DownloadError::new(
                "Unexpected model content encoding",
                downloaded,
            ));
        }
    }
    if let Some(length) = response.header("Content-Length") {
        if length.parse::<u64>().ok() != Some(spec.size_bytes - downloaded) {
            return Err(DownloadError::new(
                "Model download size does not match the pinned model",
                downloaded,
            ));
        }
    }
    let total = spec.size_bytes;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(downloaded == 0)
        .append(downloaded > 0)
        .open(&part)
        .map_err(|e| DownloadError::new(format!("Cannot write model file: {e}"), downloaded))?;

    let mut reader = response.into_reader();
    let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
    let mut buf = vec![0u8; CHUNK];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(DownloadError::new("cancelled", downloaded));
        }
        let n = reader.read(&mut buf).map_err(|e| {
            DownloadError::new(format!("Model download interrupted: {e}"), downloaded)
        })?;
        if n == 0 {
            break;
        }
        if n as u64 > spec.size_bytes.saturating_sub(downloaded) {
            return Err(DownloadError::new(
                "Model download exceeded the pinned size",
                downloaded,
            ));
        }
        file.write_all(&buf[..n])
            .map_err(|e| DownloadError::new(format!("Cannot write model file: {e}"), downloaded))?;
        hasher.update(&buf[..n]);
        downloaded += n as u64;
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            if let Some(app) = app {
                DownloadProgress::emit(
                    app,
                    &DownloadProgress {
                        model_id: spec.id.into(),
                        phase: "downloading",
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                        error: None,
                    },
                );
            }
        }
    }
    // fsync before rename: a power loss must not leave a size-correct but
    // corrupt file that then passes the size-only installed check forever —
    // and a failed sync must fail the install, not rename anyway.
    file.flush()
        .and_then(|()| file.sync_all())
        .map_err(|e| DownloadError::new(format!("Cannot write model file: {e}"), downloaded))?;
    drop(file);

    if downloaded != spec.size_bytes {
        return Err(DownloadError::new(
            format!(
                "Model download truncated ({downloaded} of {} bytes)",
                spec.size_bytes
            ),
            downloaded,
        ));
    }

    emit(app, spec, "verifying", downloaded);
    if cancel.load(Ordering::Relaxed) {
        return Err(DownloadError::new("cancelled", downloaded));
    }
    verify_and_install(&part, &final_path, spec, hasher, downloaded)
}

fn emit(app: Option<&AppHandle>, spec: &ModelSpec, phase: &'static str, downloaded: u64) {
    if let Some(app) = app {
        DownloadProgress::emit(
            app,
            &DownloadProgress {
                model_id: spec.id.into(),
                phase,
                downloaded_bytes: downloaded,
                total_bytes: spec.size_bytes,
                error: None,
            },
        );
    }
}

fn verify_and_install(
    part: &Path,
    final_path: &Path,
    spec: &ModelSpec,
    hasher: Sha256,
    downloaded: u64,
) -> Result<(), DownloadError> {
    let digest = format!("{:x}", hasher.finalize());
    if digest != spec.sha256 {
        let _ = std::fs::remove_file(part);
        return Err(DownloadError::new(
            "Model checksum mismatch — download deleted",
            downloaded,
        ));
    }
    // Atomic no-clobber publication: an existing installation is preserved,
    // even when another app process finished installing the same model first.
    std::fs::hard_link(part, final_path).map_err(|e| {
        DownloadError::new(
            format!("Cannot store model (existing files are preserved): {e}"),
            downloaded,
        )
    })?;
    std::fs::remove_file(part).map_err(|e| {
        DownloadError::new(
            format!("Model installed, but partial cleanup failed: {e}"),
            downloaded,
        )
    })?;
    Ok(())
}

fn hash_prefix(
    path: &Path,
    bytes: u64,
    hasher: &mut Sha256,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot read partial download: {e}"))?;
    let mut remaining = bytes;
    let mut buf = vec![0u8; CHUNK];
    while remaining > 0 {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let want = remaining.min(buf.len() as u64) as usize;
        let n = file
            .read(&mut buf[..want])
            .map_err(|e| format!("Cannot read partial download: {e}"))?;
        if n == 0 {
            return Err("Partial download is truncated".into());
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Mutex;

    /// Minimal HTTP/1.1 file server with Range support for download tests.
    struct TestServer {
        base: String,
        body: Vec<u8>,
        requests: Arc<Mutex<Vec<String>>>,
        join: Option<std::thread::JoinHandle<()>>,
        stop: Arc<AtomicBool>,
    }

    impl TestServer {
        fn serve(body: Vec<u8>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let requests_thread = Arc::clone(&requests);
            let serve_body = body.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let join = std::thread::spawn(move || {
                let body = serve_body;
                while let Ok((mut stream, _)) = listener.accept() {
                    if stopped.load(Ordering::Relaxed) {
                        break;
                    }
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    requests_thread.lock().unwrap().push(request.clone());
                    let range = request
                        .lines()
                        .find_map(|l| l.strip_prefix("Range: bytes=").map(str::to_string))
                        .and_then(|v| v.trim_end_matches('-').parse::<usize>().ok());
                    match range {
                        Some(start) if start < body.len() => {
                            let tail = &body[start..];
                            let head = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                                tail.len(), start, body.len()-1, body.len()
                            );
                            let _ = stream.write_all(head.as_bytes());
                            let _ = stream.write_all(tail);
                        }
                        _ => {
                            let head = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(head.as_bytes());
                            let _ = stream.write_all(&body);
                        }
                    }
                }
            });
            Self {
                base: format!("http://127.0.0.1:{port}"),
                body,
                requests,
                join: Some(join),
                stop,
            }
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            let _ = std::net::TcpStream::connect(self.base.trim_start_matches("http://"));
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    fn spec_for(server: &TestServer) -> &'static ModelSpec {
        let sha256 = format!("{:x}", Sha256::digest(&server.body));
        // Leak is fine in tests: specs are 'static by design.
        Box::leak(Box::new(ModelSpec {
            id: "test",
            file: "test-model.bin",
            label: "Test",
            tier: "fast",
            size_bytes: server.body.len() as u64,
            sha256: Box::leak(sha256.into_boxed_str()),
            supports_translate: true,
        }))
    }

    fn download_test_model(
        server_url: &str,
        spec: &'static ModelSpec,
        dir: &Path,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        download_from(server_url, spec, dir, cancel, None).map_err(|e| e.message)
    }

    #[test]
    fn fresh_download_verifies_and_renames() {
        let body = vec![7u8; 300_000];
        let server = TestServer::serve(body);
        let spec: &'static ModelSpec = spec_for(&server);
        let dir = tempfile_dir();
        let cancel = AtomicBool::new(false);
        download_test_model(
            &format!("{}/ggml-test.bin", server.base),
            spec,
            &dir,
            &cancel,
        )
        .unwrap();
        assert!(final_path(&dir, spec).exists());
        assert!(!part_path(&dir, spec).exists());
        assert_eq!(
            std::fs::metadata(final_path(&dir, spec)).unwrap().len(),
            300_000
        );
    }

    #[test]
    fn resume_completes_a_partial_file() {
        let body: Vec<u8> = (0..500_000u32).map(|i| (i % 251) as u8).collect();
        let server = TestServer::serve(body.clone());
        let spec: &'static ModelSpec = spec_for(&server);
        let dir = tempfile_dir();
        std::fs::write(part_path(&dir, spec), &body[..200_000]).unwrap();
        let cancel = AtomicBool::new(false);
        download_test_model(
            &format!("{}/ggml-test.bin", server.base),
            spec,
            &dir,
            &cancel,
        )
        .unwrap();
        assert_eq!(std::fs::read(final_path(&dir, spec)).unwrap(), body);
        assert!(server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("Range: bytes=200000-")));
    }

    #[test]
    fn cancel_aborts_without_installing() {
        let server = TestServer::serve(vec![3u8; 5_000_000]);
        let spec: &'static ModelSpec = spec_for(&server);
        let dir = tempfile_dir();
        let cancel = AtomicBool::new(true);
        let err = download_test_model(
            &format!("{}/ggml-test.bin", server.base),
            spec,
            &dir,
            &cancel,
        )
        .unwrap_err();
        assert_eq!(err, "cancelled");
        assert!(!final_path(&dir, spec).exists());
    }

    #[test]
    fn completed_part_verifies_without_http() {
        let body: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
        let server = TestServer::serve(body.clone());
        let spec: &'static ModelSpec = spec_for(&server);
        let dir = tempfile_dir();
        // Simulates a kill between the last byte and the rename: the .part is
        // complete but a Range request at EOF would get a 416 — so none is sent.
        std::fs::write(part_path(&dir, spec), &body).unwrap();
        let cancel = AtomicBool::new(false);
        download_test_model(
            &format!("{}/ggml-test.bin", server.base),
            spec,
            &dir,
            &cancel,
        )
        .unwrap();
        assert_eq!(std::fs::read(final_path(&dir, spec)).unwrap(), body);
        assert!(server.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn checksum_mismatch_removes_file() {
        let server = TestServer::serve(vec![1u8; 10_000]);
        let spec: &'static ModelSpec = Box::leak(Box::new(ModelSpec {
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            ..*spec_for(&server)
        }));
        let dir = tempfile_dir();
        let cancel = AtomicBool::new(false);
        let err = download_test_model(
            &format!("{}/ggml-test.bin", server.base),
            spec,
            &dir,
            &cancel,
        )
        .unwrap_err();
        assert!(err.contains("checksum"));
        assert!(!part_path(&dir, spec).exists());
    }

    #[test]
    fn oversized_response_never_grows_the_partial_file_past_the_pin() {
        let body = vec![9u8; 20];
        let spec = Box::leak(Box::new(ModelSpec {
            id: "bounded",
            file: "bounded.bin",
            label: "Test",
            tier: "test",
            size_bytes: 10,
            sha256: "unused",
            supports_translate: true,
        }));
        let directory = tempfile_dir();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request);
            // EOF-delimited, no Content-Length: the streamed-byte guard must
            // enforce the bound even when no trustworthy header is available.
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                .unwrap();
            let _ = stream.write_all(&body);
        });
        let error = download_test_model(
            &format!("http://{address}/model"),
            spec,
            &directory,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        server.join().unwrap();
        assert!(error.contains("exceeded"), "{error}");
        assert!(
            std::fs::metadata(part_path(&directory, spec))
                .unwrap()
                .len()
                <= 10
        );
        assert!(!final_path(&directory, spec).exists());
    }

    #[test]
    fn concurrent_writers_existing_install_and_cancelled_prefix_are_preserved() {
        let body = vec![1u8; 64];
        let server = TestServer::serve(body.clone());
        let spec = spec_for(&server);
        let directory = tempfile_dir();
        let lock = model_lock(&directory, spec).unwrap();
        assert!(
            download_test_model(&server.base, spec, &directory, &AtomicBool::new(false))
                .unwrap_err()
                .contains("another window or app")
        );
        assert!(server.requests.lock().unwrap().is_empty());
        // A child process can briefly inherit this open file description before
        // exec closes it. Completing our operation must release the lock even
        // while that descriptor still exists.
        let inherited_descriptor = lock.0.try_clone().unwrap();
        drop(lock);
        std::fs::write(part_path(&directory, spec), &body).unwrap();
        std::fs::write(final_path(&directory, spec), b"existing-install").unwrap();
        let error = download_test_model(&server.base, spec, &directory, &AtomicBool::new(false))
            .unwrap_err();
        assert!(error.contains("existing files are preserved"), "{error}");
        assert_eq!(
            std::fs::read(final_path(&directory, spec)).unwrap(),
            b"existing-install"
        );
        assert_eq!(std::fs::read(part_path(&directory, spec)).unwrap(), body);
        drop(inherited_descriptor);
        let mut hash = Sha256::new();
        assert_eq!(
            hash_prefix(
                &part_path(&directory, spec),
                64,
                &mut hash,
                &AtomicBool::new(true)
            )
            .unwrap_err(),
            "cancelled"
        );
    }

    struct TestDir(PathBuf);
    impl std::ops::Deref for TestDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempfile_dir() -> TestDir {
        let dir = std::env::temp_dir().join(format!(
            "monocode-dictation-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TestDir(dir)
    }
}
