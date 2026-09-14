//! Isolated PR checkouts shared by repair flows. A repair never mutates the
//! user's working copy: when no known checkout already sits at the PR head,
//! a provider command clones the exact head into app-data storage instead.
//! The machinery here is provider-agnostic — Azure and GitHub supply their
//! own verification and auth around the same guarded fetch.

// Only preparation writes local files; it never mutates a provider or an
// existing checkout.
static PREPARING_CHECKOUT: std::sync::Mutex<()> = std::sync::Mutex::new(());
static CHECKOUT_REQUEST: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static CANCELLED_CHECKOUTS: std::sync::Mutex<std::collections::VecDeque<String>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
static CHECKOUT_CANCELLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(crate) fn checkout_cancelled() -> bool {
    CHECKOUT_CANCELLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Mark the registered request cancelled — an in-flight fetch sees it at the
/// next checkpoint, and a later `begin_checkout` with the same id is refused.
pub(crate) fn cancel_checkout(request_id: &str) {
    if request_id.is_empty() || request_id.len() > 64 {
        return;
    }
    let current = CHECKOUT_REQUEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut cancelled = CANCELLED_CHECKOUTS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if current.as_deref() == Some(request_id) {
        CHECKOUT_CANCELLED.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    if cancelled.len() >= 20 {
        cancelled.pop_front();
    }
    cancelled.push_back(request_id.to_string());
}

/// Holds the single in-flight preparation slot; dropping releases the
/// request id so a stale cancellation cannot kill an unrelated preparation.
pub(crate) struct CheckoutPreparation {
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl Drop for CheckoutPreparation {
    fn drop(&mut self) {
        *CHECKOUT_REQUEST
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }
}

/// Claim the one-at-a-time preparation slot and register the request id so a
/// cancel can interrupt the fetch.
pub(crate) fn begin_checkout(request_id: &str) -> Result<CheckoutPreparation, String> {
    let guard = PREPARING_CHECKOUT
        .try_lock()
        .map_err(|_| "Another PR checkout is being prepared. Try again when it finishes.")?;
    {
        let mut current = CHECKOUT_REQUEST
            .lock()
            .map_err(|_| "Cannot start checkout preparation")?;
        let cancelled = CANCELLED_CHECKOUTS
            .lock()
            .map_err(|_| "Cannot start checkout preparation")?;
        if request_id.is_empty()
            || request_id.len() > 64
            || cancelled.iter().any(|id| id == request_id)
        {
            return Err("Checkout preparation cancelled.".into());
        }
        CHECKOUT_CANCELLED.store(false, std::sync::atomic::Ordering::Relaxed);
        *current = Some(request_id.to_string());
    }
    Ok(CheckoutPreparation { _guard: guard })
}

pub(crate) fn checkout_git(
    root: &std::path::Path,
    args: &[&str],
    auth: Option<(&str, &str)>,
) -> Result<String, String> {
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut command = std::process::Command::new("git");
    crate::hide_window_console(&mut command);
    // Ignore URL rewrites, credential helpers, hooks and filters from unrelated Git config.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .arg("-C")
        .arg(root)
        .args([
            "-c",
            &format!("core.hooksPath={null}"),
            "-c",
            "credential.helper=",
            "-c",
            "http.followRedirects=false",
            "-c",
            "http.sslVerify=true",
        ])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", null)
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some((remote, authorization)) = auth {
        command
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", format!("http.{remote}.extraHeader"))
            .env(
                "GIT_CONFIG_VALUE_0",
                format!("Authorization: {authorization}"),
            );
    }
    let output = crate::bounded_process::output_cancellable(
        &mut command,
        std::time::Duration::from_secs(120),
        1024 * 1024,
        checkout_cancelled,
    )
    .map_err(|_| {
        if checkout_cancelled() {
            return "Checkout preparation cancelled.".to_string();
        }
        "PR checkout preparation failed or timed out. Retry after checking network access."
            .to_string()
    })?;
    if !output.status.success() {
        // Git errors may contain credentials or remote response content.
        return Err("Could not prepare the PR checkout. Check read access and network connectivity, then retry.".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "Invalid Git response".into())
}

pub(crate) fn prepare_checkout(
    base: &std::path::Path,
    key: &str,
    remote: &str,
    branch: &str,
    commit: &str,
    auth: Option<&str>,
    verify: impl Fn() -> Result<(), String>,
) -> Result<String, String> {
    std::fs::create_dir_all(base).map_err(|_| "Cannot create the PR checkouts directory")?;
    checkout_git(
        base,
        &["check-ref-format", &format!("refs/heads/{branch}")],
        None,
    )?;
    if branch.starts_with('-')
        || ![40, 64].contains(&commit.len())
        || !commit.bytes().all(|ch| ch.is_ascii_hexdigit())
    {
        return Err("The provider returned an invalid PR branch or commit.".into());
    }
    for suffix in 0..20 {
        let path = base.join(format!("{key}-{suffix}"));
        let matching = || -> bool {
            std::fs::symlink_metadata(&path)
                .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
                && checkout_git(&path, &["config", "--get", "remote.origin.url"], None)
                    .is_ok_and(|value| value.trim() == remote)
                && checkout_git(&path, &["symbolic-ref", "--quiet", "--short", "HEAD"], None)
                    .is_ok_and(|value| value.trim() == branch)
                && checkout_git(&path, &["rev-parse", "HEAD"], None)
                    .is_ok_and(|value| value.trim() == commit)
        };
        if path.exists() {
            if matching() {
                verify()?;
                return Ok(crate::fs::path_to_js(&path));
            }
            continue; // Never reset an existing, partial or user-modified checkout.
        }
        match std::fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("Cannot create an isolated PR checkout".into()),
        }
        let created = (|| {
            checkout_git(&path, &["init", "--quiet", "--template="], None)?;
            checkout_git(&path, &["remote", "add", "origin", remote], None)?;
            checkout_git(
                &path,
                &[
                    "fetch",
                    "--quiet",
                    "--depth=1",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "origin",
                    &format!("refs/heads/{branch}"),
                ],
                auth.map(|authorization| (remote, authorization)),
            )?;
            if checkout_git(&path, &["rev-parse", "FETCH_HEAD"], None)?.trim() != commit {
                return Err(
                    "PR head changed during checkout preparation. Refresh the PR and retry.".into(),
                );
            }
            checkout_git(
                &path,
                &["checkout", "--quiet", "-b", branch, commit, "--"],
                None,
            )?;
            if !matching() {
                return Err("Could not verify the prepared PR checkout".into());
            }
            verify()?;
            Ok(crate::fs::path_to_js(&path))
        })();
        if created.is_err() {
            // This directory was created by this call and was never handed to a session.
            let _ = std::fs::remove_dir_all(&path);
        }
        return created;
    }
    Err("Too many previous PR checkouts. Review working copies before trying again.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_isolated_checkout_and_reuses_it_without_resetting_work() {
        let root = std::env::temp_dir().join(format!(
            "monocode-pr-checkout-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let origin = root.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        checkout_git(&origin, &["init", "--quiet", "--template="], None).unwrap();
        checkout_git(&origin, &["checkout", "-b", "feature"], None).unwrap();
        std::fs::write(origin.join("file.txt"), "source\n").unwrap();
        checkout_git(&origin, &["add", "file.txt"], None).unwrap();
        checkout_git(
            &origin,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-m",
                "fixture",
            ],
            None,
        )
        .unwrap();
        let commit = checkout_git(&origin, &["rev-parse", "HEAD"], None)
            .unwrap()
            .trim()
            .to_string();
        let remote = tauri::Url::from_directory_path(&origin)
            .unwrap()
            .to_string();
        let base = root.join("checkouts");
        let path = prepare_checkout(
            &base,
            "pr-1",
            &remote,
            "feature",
            &commit,
            Some("Basic fixture-secret"),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&path).join("file.txt")).unwrap(),
            "source\n"
        );
        assert!(
            !std::fs::read_to_string(std::path::Path::new(&path).join(".git/config"))
                .unwrap()
                .contains("fixture-secret")
        );
        std::fs::write(std::path::Path::new(&path).join("file.txt"), "user edit\n").unwrap();
        assert_eq!(
            prepare_checkout(&base, "pr-1", &remote, "feature", &commit, None, || Ok(())).unwrap(),
            path
        );
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&path).join("file.txt")).unwrap(),
            "user edit\n"
        );
        assert!(prepare_checkout(
            &base,
            "stale",
            &remote,
            "feature",
            &"0".repeat(40),
            None,
            || Ok(())
        )
        .unwrap_err()
        .contains("head changed"));
        assert!(!base.join("stale-0").exists());
        assert!(prepare_checkout(
            &base,
            "bad",
            &remote,
            "--upload-pack=bad",
            &commit,
            None,
            || Ok(())
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(origin.join("file.txt")).unwrap(),
            "source\n"
        );
        assert!(prepare_checkout(
            &base,
            "final-stale",
            &remote,
            "feature",
            &commit,
            None,
            || Err("PR is no longer active".into())
        )
        .is_err());
        assert!(!base.join("final-stale-0").exists());
        assert!(
            prepare_checkout(&base, "pr-1", &remote, "feature", &commit, None, || Err(
                "PR is no longer active".into()
            ))
            .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&path).join("file.txt")).unwrap(),
            "user edit\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
