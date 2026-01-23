//! Graceful shutdown support for BoxLite runtime.
//!
//! This module provides signal handling for graceful shutdown of all boxes
//! when the process receives SIGTERM or SIGINT.
//!
//! Uses a dedicated thread with `signal-hook` for signal handling, which works
//! in any context (sync or async, with or without an active Tokio runtime).
//! This is important for FFI contexts like Python (PyO3) where no Tokio runtime
//! may be active when the signal handler is installed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Default timeout for graceful shutdown (10 seconds).
pub const DEFAULT_SHUTDOWN_TIMEOUT_SECS: i32 = 10;

/// Flag to track if signal handler has been installed (install only once).
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

/// Windows stub - signal handling not implemented yet.
#[cfg(not(unix))]
pub(crate) fn install_signal_handler<F, Fut>(_shutdown_callback: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    tracing::warn!("Signal handling not implemented for this platform");
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
