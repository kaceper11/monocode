//! Optional idle-sleep prevention, shared across app windows. This observes
//! upstream session state; it does not own, pause or supervise agent processes.
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

const STATUS_EVENT: &str = "power-assertion";
const MAX_WORKING_PER_WINDOW: usize = 256;
const MAX_AUTO_ATTEMPTS: u8 = 3;

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    supported: bool,
    enabled: bool,
    held: bool,
    working: usize,
    error: Option<String>,
    revision: u64,
}

// macOS owns an IOKit assertion; Windows owns the thread that set its state.
// Both release on Drop, and the OS reclaims the assertion on process exit.
trait SleepAssertion: Send {}
type AcquireFn = Box<dyn Fn() -> Result<Box<dyn SleepAssertion>, String> + Send>;
struct PowerInner {
    enabled: Option<bool>,
    working: HashMap<String, HashSet<String>>,
    assertion: Option<Box<dyn SleepAssertion>>,
    error: Option<String>,
    attempts: u8,
    revision: u64,
    last_status: Option<PowerStatus>,
    acquire: AcquireFn,
}
pub struct PowerHost {
    inner: Mutex<PowerInner>,
}
impl PowerHost {
    pub fn new() -> Self {
        Self::with_acquire(Box::new(platform::acquire))
    }
    fn with_acquire(acquire: AcquireFn) -> Self {
        Self {
            inner: Mutex::new(PowerInner {
                enabled: None,
                working: HashMap::new(),
                assertion: None,
                error: None,
                attempts: 0,
                revision: 0,
                last_status: None,
                acquire,
            }),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, PowerInner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
    fn status_of(inner: &PowerInner) -> PowerStatus {
        PowerStatus {
            supported: platform::SUPPORTED,
            enabled: inner.enabled.unwrap_or(false),
            held: inner.assertion.is_some(),
            working: inner.working.values().map(HashSet::len).sum(),
            error: inner.error.clone(),
            revision: inner.revision,
        }
    }
    fn reconcile(inner: &mut PowerInner, app: Option<&AppHandle>) -> PowerStatus {
        let want = inner.enabled == Some(true) && inner.working.values().any(|ids| !ids.is_empty());
        if !want {
            inner.assertion = None;
            inner.error = None;
            inner.attempts = 0;
        } else if inner.assertion.is_none() && inner.attempts < MAX_AUTO_ATTEMPTS {
            inner.attempts += 1;
            match (inner.acquire)() {
                Ok(assertion) => {
                    inner.assertion = Some(assertion);
                    inner.error = None;
                }
                Err(error) => inner.error = Some(error),
            }
        }
        let mut status = Self::status_of(inner);
        if inner.last_status.as_ref() != Some(&status) {
            inner.revision += 1;
            status.revision = inner.revision;
            inner.last_status = Some(status.clone());
            if let Some(app) = app {
                let _ = app.emit(STATUS_EVENT, &status);
            }
        }
        status
    }
    fn sync(
        &self,
        app: Option<&AppHandle>,
        window: &str,
        initial_enabled: bool,
        ids: Vec<String>,
    ) -> PowerStatus {
        let mut inner = self.lock();
        // Only the first live reporter initializes the saved preference.
        // New/reloaded windows must not undo a more recent explicit toggle.
        if app.is_none_or(|app| app.get_webview_window(window).is_some()) {
            inner.enabled.get_or_insert(initial_enabled);
            let ids: HashSet<_> = ids
                .into_iter()
                .filter(|id| !id.is_empty() && id.len() <= 256)
                .take(MAX_WORKING_PER_WINDOW)
                .collect();
            if ids.is_empty() {
                inner.working.remove(window);
            } else {
                inner.working.insert(window.into(), ids);
            }
        } else {
            inner.working.remove(window);
        }
        Self::reconcile(&mut inner, app)
    }
    fn set_enabled(&self, app: Option<&AppHandle>, enabled: bool) -> PowerStatus {
        let mut inner = self.lock();
        inner.enabled = Some(enabled);
        Self::reconcile(&mut inner, app)
    }
    fn retry(&self, app: Option<&AppHandle>) -> PowerStatus {
        let mut inner = self.lock();
        inner.attempts = 0;
        Self::reconcile(&mut inner, app)
    }
    pub fn drop_window(&self, app: Option<&AppHandle>, label: &str) {
        let mut inner = self.lock();
        inner.working.remove(label);
        Self::reconcile(&mut inner, app);
    }
    pub fn release(&self, app: Option<&AppHandle>) {
        let mut inner = self.lock();
        inner.working.clear();
        Self::reconcile(&mut inner, app);
    }
}

// Synchronous dispatch orders reports/toggles with native window destruction.
#[tauri::command]
pub fn power_sync(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, PowerHost>,
    initial_enabled: bool,
    session_ids: Vec<String>,
) -> PowerStatus {
    host.sync(Some(&app), window.label(), initial_enabled, session_ids)
}
#[tauri::command]
pub fn power_set_enabled(app: AppHandle, host: State<'_, PowerHost>, enabled: bool) -> PowerStatus {
    host.set_enabled(Some(&app), enabled)
}
#[tauri::command]
pub fn power_status(host: State<'_, PowerHost>) -> PowerStatus {
    PowerHost::status_of(&host.lock())
}
#[tauri::command]
pub fn power_retry(app: AppHandle, host: State<'_, PowerHost>) -> PowerStatus {
    host.retry(Some(&app))
}

#[cfg(target_os = "macos")]
mod platform {
    use super::SleepAssertion;
    use objc2_foundation::NSString;
    use std::ffi::c_void;
    pub const SUPPORTED: bool = true;
    const REASON: &str = "MonoCode agents are working";
    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            kind: *const c_void,
            level: u32,
            name: *const c_void,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }
    struct Assertion(u32);
    impl SleepAssertion for Assertion {}
    impl Drop for Assertion {
        fn drop(&mut self) {
            let result = unsafe { IOPMAssertionRelease(self.0) };
            if result != 0 {
                eprintln!("monocode power: assertion release failed ({result})");
            }
        }
    }
    pub fn acquire() -> Result<Box<dyn SleepAssertion>, String> {
        let kind = NSString::from_str("PreventUserIdleSystemSleep");
        let name = NSString::from_str(REASON);
        let mut id = 0;
        // NSString and CFString are toll-free bridged; both retained strings
        // remain alive for this call. 255 is kIOPMAssertionLevelOn in IOPMLib.h.
        let result = unsafe {
            IOPMAssertionCreateWithName(
                (&*kind as *const NSString).cast(),
                255,
                (&*name as *const NSString).cast(),
                &mut id,
            )
        };
        if result != 0 {
            return Err(format!("Could not prevent idle sleep (IOKit {result})"));
        }
        Ok(Box::new(Assertion(id)))
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        #[ignore = "queries the real macOS power assertion API"]
        fn native_assertion_holds_and_releases_idle_sleep() {
            let marker = format!("pid {}(", std::process::id());
            let held = || {
                let output = std::process::Command::new("/usr/bin/pmset")
                    .args(["-g", "assertions"])
                    .output()
                    .unwrap();
                assert!(output.status.success());
                String::from_utf8_lossy(&output.stdout).lines().any(|line| {
                    line.contains(&marker)
                        && line.contains("PreventUserIdleSystemSleep")
                        && line.contains(REASON)
                })
            };
            let wait_for = |expected| {
                for _ in 0..40 {
                    if held() == expected {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                panic!("Expected this process's idle-sleep assertion to be {expected}");
            };
            let assertion = acquire().expect("IOKit acquires the assertion");
            wait_for(true);
            drop(assertion);
            wait_for(false);
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::SleepAssertion;
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    pub const SUPPORTED: bool = true;

    /// The execution state is per-thread, so one dedicated thread must both
    /// set and clear it. The thread parks until dropped; process exit also
    /// reclaims the state.
    pub fn acquire() -> Result<Box<dyn SleepAssertion>, String> {
        let wanted = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let handle = thread::spawn(move || {
            unsafe { SetThreadExecutionState(wanted) };
            // A fresh thread has no prior state, so the first call's 0 return
            // cannot tell success from failure; the second call reports what
            // the first installed.
            if unsafe { SetThreadExecutionState(wanted) } != wanted {
                let _ = ready_tx.send(Err(
                    "SetThreadExecutionState did not hold the system-awake request".into(),
                ));
                return;
            }
            if ready_tx.send(Ok(())).is_err() {
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                return;
            }
            let _ = stop_rx.recv();
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        });
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Box::new(ThreadAssertion {
                stop: stop_tx,
                handle: Some(handle),
            })),
            Ok(Err(error)) => {
                let _ = handle.join();
                Err(error)
            }
            Err(_) => {
                let _ = handle.join();
                Err("Power assertion thread failed to start".into())
            }
        }
    }

    struct ThreadAssertion {
        stop: mpsc::Sender<()>,
        handle: Option<JoinHandle<()>>,
    }

    impl SleepAssertion for ThreadAssertion {}

    impl Drop for ThreadAssertion {
        fn drop(&mut self) {
            let _ = self.stop.send(());
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::SleepAssertion;

    pub const SUPPORTED: bool = false;

    pub fn acquire() -> Result<Box<dyn SleepAssertion>, String> {
        Err("Keeping the computer awake is not supported on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct Held(Arc<AtomicUsize>);
    impl SleepAssertion for Held {}
    impl Drop for Held {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn host(fail: bool) -> (PowerHost, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let acquired = Arc::new(AtomicUsize::new(0));
        let released = Arc::new(AtomicUsize::new(0));
        let (a, r) = (acquired.clone(), released.clone());
        (
            PowerHost::with_acquire(Box::new(move || {
                a.fetch_add(1, Ordering::SeqCst);
                if fail {
                    Err("OS refused the assertion".into())
                } else {
                    Ok(Box::new(Held(r.clone())))
                }
            })),
            acquired,
            released,
        )
    }
    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }
    #[test]
    fn one_assertion_spans_windows_and_releases_on_last_close_or_exit() {
        let (host, acquired, released) = host(false);
        assert!(host.sync(None, "one", true, ids(&["s1", "s1"])).held);
        assert_eq!(host.sync(None, "two", true, ids(&["s2"])).working, 2);
        assert_eq!(acquired.load(Ordering::SeqCst), 1);
        host.drop_window(None, "one");
        assert!(PowerHost::status_of(&host.lock()).held);
        assert_eq!(released.load(Ordering::SeqCst), 0);
        host.drop_window(None, "two");
        assert_eq!(released.load(Ordering::SeqCst), 1);
        host.sync(None, "two", true, ids(&["s2"]));
        host.release(None);
        assert_eq!(released.load(Ordering::SeqCst), 2);
        assert!(
            PowerHost::status_of(&host.lock()).enabled,
            "exit must not erase the saved preference"
        );
    }
    #[test]
    fn late_window_initialization_cannot_override_an_explicit_toggle() {
        let (host, acquired, released) = host(false);
        let initial = host.sync(None, "one", false, ids(&["s1"]));
        assert!(!initial.enabled && !initial.held);
        assert_eq!(acquired.load(Ordering::SeqCst), 0);
        let enabled = host.set_enabled(None, true);
        assert!(enabled.held && enabled.revision > initial.revision);
        let late = host.sync(None, "two", false, ids(&["s2"]));
        assert!(late.enabled && late.held);
        assert_eq!(
            late.revision,
            host.sync(None, "two", false, ids(&["s2"])).revision
        );
        host.set_enabled(None, false);
        assert!(!host.sync(None, "three", true, ids(&["s3"])).held);
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn failures_are_visible_bounded_and_explicitly_retryable() {
        let (host, acquired, _) = host(true);
        for i in 0..10 {
            host.sync(None, "one", true, vec![format!("s{i}")]);
        }
        assert_eq!(acquired.load(Ordering::SeqCst), MAX_AUTO_ATTEMPTS as usize);
        assert!(PowerHost::status_of(&host.lock()).error.is_some());
        host.retry(None);
        assert_eq!(
            acquired.load(Ordering::SeqCst),
            MAX_AUTO_ATTEMPTS as usize + 1
        );
        let idle = host.sync(None, "one", true, vec![]);
        assert!(!idle.held && idle.error.is_none());
        host.sync(None, "one", true, ids(&["new"]));
        assert_eq!(
            acquired.load(Ordering::SeqCst),
            MAX_AUTO_ATTEMPTS as usize + 2
        );
    }
}
