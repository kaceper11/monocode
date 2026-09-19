//! Ordering and atomic storage for the added Jira/Azure connections.
use std::{fs, path::Path, sync::Mutex};

pub(crate) struct ConfigWrites(Mutex<u64>);

impl ConfigWrites {
    pub(crate) const fn new() -> Self {
        Self(Mutex::new(0))
    }

    /// Reserve intent before an asynchronous credential probe starts.
    pub(crate) fn begin(&self) -> Result<u64, String> {
        let mut generation = self
            .0
            .lock()
            .map_err(|_| "Connection settings unavailable")?;
        *generation = generation.wrapping_add(1);
        Ok(*generation)
    }

    pub(crate) fn commit(
        &self,
        generation: u64,
        path: &Path,
        value: Option<&str>,
    ) -> Result<(), String> {
        let current = self
            .0
            .lock()
            .map_err(|_| "Connection settings unavailable")?;
        if *current != generation {
            return Err(
                "A newer connection change superseded this request. Refresh Settings.".into(),
            );
        }
        let Some(value) = value else {
            return match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("Cannot disconnect the integration".into()),
            };
        };
        fs::create_dir_all(path.parent().ok_or("Cannot locate integration settings")?)
            .map_err(|_| "Cannot create integration settings")?;
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = crate::gitlab::write_secret_file(&temporary, value)
            .and_then(|()| fs::rename(&temporary, path).map_err(|error| error.to_string()));
        // The unique temporary belongs only to this request, including a partial write.
        let _ = fs::remove_file(&temporary);
        result.map_err(|_| "Cannot save integration settings".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn only_the_newest_intent_commits_and_disconnect_supersedes_pending_probes() {
        let root =
            std::env::temp_dir().join(format!("monocode-config-test-{}", uuid::Uuid::new_v4()));
        let path = root.join("settings.json");
        let writes = Arc::new(ConfigWrites::new());
        let barrier = Arc::new(Barrier::new(8));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let (writes, barrier, path) = (writes.clone(), barrier.clone(), path.clone());
            workers.push(std::thread::spawn(move || {
                let ticket = writes.begin().unwrap();
                barrier.wait();
                (
                    ticket,
                    writes
                        .commit(ticket, &path, Some(&format!("{{\"account\":{ticket}}}")))
                        .is_ok(),
                )
            }));
        }
        let completed: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(completed.iter().filter(|(_, saved)| *saved).count(), 1);
        assert!(completed.contains(&(8, true)));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"account\":8}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let pending_probe = writes.begin().unwrap();
        let disconnect = writes.begin().unwrap();
        writes.commit(disconnect, &path, None).unwrap();
        assert!(writes
            .commit(pending_probe, &path, Some("old account"))
            .is_err());
        assert!(!path.exists());
        let current = writes.begin().unwrap();
        fs::create_dir(&path).unwrap();
        assert!(writes
            .commit(current, &path, Some("cannot replace directory"))
            .is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
