//! Graceful shutdown support for BoxLite runtime.
//!
//! This module provides signal handling for graceful shutdown of all boxes
//! when the process receives SIGTERM or SIGINT.
//!
//! Uses a dedicated thread with `signal-hook` for signal handling, which works
//! in any context (sync or async, with or without an active Tokio runtime).
//! This is important for FFI contexts like Python (PyO3) where no Tokio runtime
//! may be active when the signal handler is installed.

#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Default timeout for graceful shutdown (10 seconds).
pub const DEFAULT_SHUTDOWN_TIMEOUT_SECS: i32 = 10;

/// Flag to track if signal handler has been installed (install only once).
#[cfg(unix)]
static SIGNAL_HANDLER_INSTALLED: AtomicBool = AtomicBool::new(false);

/// Install signal handlers for graceful shutdown.
///
/// This function spawns a dedicated thread that listens for SIGTERM and SIGINT
/// using `signal-hook`. When a signal is received, it creates a lightweight
/// single-threaded Tokio runtime to execute the async shutdown callback.
///
/// # Arguments
/// * `shutdown_callback` - Async function to call when signal is received
///
/// # Safety
/// This function is safe to call multiple times - handlers are only installed once.
#[cfg(unix)]
pub(crate) fn install_signal_handler<F, Fut>(shutdown_callback: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    use signal_hook::consts::signal::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    // Only install once
    if SIGNAL_HANDLER_INSTALLED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    std::thread::Builder::new()
        .name("boxlite-signal-handler".into())
        .spawn(move || {
            let mut signals = match Signals::new([SIGTERM, SIGINT]) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!("Failed to register signal handlers: {}", e);
                    SIGNAL_HANDLER_INSTALLED.store(false, Ordering::SeqCst);
                    return;
                }
            };

            for sig in signals.forever() {
                match sig {
                    SIGTERM => {
                        tracing::info!("Received SIGTERM, initiating graceful shutdown");
                    }
                    SIGINT => {
                        tracing::info!("Received SIGINT, initiating graceful shutdown");
                    }
                    _ => continue,
                }
                break;
            }

            // Create a lightweight runtime for the async shutdown callback
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to create shutdown runtime");

            rt.block_on(shutdown_callback());

            // Exit cleanly
            std::process::exit(0);
        })
        .expect("Failed to spawn signal handler thread");
}

/// Install Ctrl+C / console close handler on Windows via `SetConsoleCtrlHandler`.
///
/// The handler callback runs on a **separate OS thread** managed by the Windows
/// console subsystem, matching the Unix pattern of a dedicated signal thread.
/// Uses `OnceLock` for the callback (same once-only semantics as
/// `SIGNAL_HANDLER_INSTALLED` AtomicBool on Unix).
#[cfg(not(unix))]
pub(crate) fn install_signal_handler<F, Fut>(shutdown_callback: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    use std::sync::{Mutex, OnceLock};

    // Store callback in a global static so the handler function can access it.
    // OnceLock ensures only the first caller installs a handler (same semantics
    // as the Unix SIGNAL_HANDLER_INSTALLED AtomicBool).
    static CALLBACK: OnceLock<Mutex<Option<Box<dyn FnOnce() + Send>>>> = OnceLock::new();

    // Wrap the async callback into a sync closure that creates its own Tokio runtime
    let sync_callback: Box<dyn FnOnce() + Send> = Box::new(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to create shutdown runtime");
        rt.block_on(shutdown_callback());
    });

    // Try to install — OnceLock::set returns Err if already set
    if CALLBACK.set(Mutex::new(Some(sync_callback))).is_err() {
        return; // Already installed
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Console::{
            CTRL_C_EVENT, CTRL_CLOSE_EVENT, SetConsoleCtrlHandler,
        };

        unsafe extern "system" fn ctrl_handler(ctrl_type: u32) -> i32 {
            match ctrl_type {
                CTRL_C_EVENT => {
                    tracing::info!("Received CTRL_C, initiating graceful shutdown");
                }
                CTRL_CLOSE_EVENT => {
                    tracing::info!("Received CTRL_CLOSE, initiating graceful shutdown");
                }
                _ => return 0, // Not handled
            }

            // Extract and run the callback (once only — take() returns None on repeat)
            if let Some(mutex) = CALLBACK.get() {
                if let Ok(mut guard) = mutex.lock() {
                    if let Some(cb) = guard.take() {
                        cb();
                    }
                }
            }

            // Exit cleanly
            std::process::exit(0);
        }

        unsafe {
            if SetConsoleCtrlHandler(Some(ctrl_handler), 1) == 0 {
                tracing::error!("Failed to install SetConsoleCtrlHandler");
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        tracing::warn!("Signal handling not implemented for this platform");
    }
}

/// Convert timeout parameter to Duration.
///
/// # Arguments
/// * `timeout` - Timeout in seconds. None = default (10s), Some(-1) = infinite
///
/// # Returns
/// Duration for the timeout, or None for infinite wait.
pub(crate) fn timeout_to_duration(timeout: Option<i32>) -> Option<Duration> {
    match timeout {
        None => Some(Duration::from_secs(DEFAULT_SHUTDOWN_TIMEOUT_SECS as u64)),
        Some(-1) => None, // Infinite
        Some(secs) if secs > 0 => Some(Duration::from_secs(secs as u64)),
        Some(_) => Some(Duration::from_secs(DEFAULT_SHUTDOWN_TIMEOUT_SECS as u64)), // Invalid, use default
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timeout_to_duration_default() {
        let duration = timeout_to_duration(None);
        assert_eq!(duration, Some(Duration::from_secs(10)));
    }

    #[test]
    fn test_timeout_to_duration_custom() {
        let duration = timeout_to_duration(Some(30));
        assert_eq!(duration, Some(Duration::from_secs(30)));
    }

    #[test]
    fn test_timeout_to_duration_infinite() {
        let duration = timeout_to_duration(Some(-1));
        assert_eq!(duration, None);
    }

    #[test]
    fn test_timeout_to_duration_invalid() {
        // Invalid values should fall back to default
        let duration = timeout_to_duration(Some(0));
        assert_eq!(duration, Some(Duration::from_secs(10)));

        let duration = timeout_to_duration(Some(-5));
        assert_eq!(duration, Some(Duration::from_secs(10)));
    }
}
