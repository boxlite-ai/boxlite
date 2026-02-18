//! Crash capture for shim process.
//!
//! Captures crash information (panics, signals) to an exit file for diagnostics.
//! Signal handlers can't capture closures, so we use global statics for paths.
//!
//! Note: Stderr content is captured separately by the parent process (to shim.stderr).
//! CrashReport reads it directly from file - we don't embed it in the exit file.
//!
//! Uses [`boxlite::vmm::ExitInfo`] for the JSON format.

use boxlite::vmm::ExitInfo;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Unix convention: exit code for signal-terminated process = 128 + signal number.
const SIGNAL_EXIT_CODE_BASE: i32 = 128;

/// Exit code for Rust panics.
const PANIC_EXIT_CODE: i32 = 101;

/// Global exit file path for signal handlers.
static EXIT_FILE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Crash capture installer.
///
/// Installs panic hook and signal handlers to capture crash info.
pub struct CrashCapture;

impl CrashCapture {
    /// Install crash capture mechanisms (panic hook + signal handlers).
    ///
    /// - `exit_file`: Where to write crash info (JSON format)
    pub fn install(exit_file: PathBuf) {
        install_panic_hook(exit_file.clone());
        install_signal_handlers(exit_file);
    }
}

/// Install panic hook that writes JSON to exit file AND log.
fn install_panic_hook(exit_file: PathBuf) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let message = panic_info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| panic_info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "Unknown panic".into());

        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".into());

        tracing::error!(message = %message, location = %location, "PANIC");

        let info = ExitInfo::Panic {
            exit_code: PANIC_EXIT_CODE,
            message,
            location,
        };
        if let Ok(json) = serde_json::to_string(&info) {
            let _ = std::fs::write(&exit_file, json);
        }

        default_hook(panic_info);
    }));
}

/// Install Unix signal handlers to catch C library crashes.
fn install_signal_handlers(exit_file: PathBuf) {
    let _ = EXIT_FILE_PATH.set(exit_file);

    unsafe {
        libc::signal(libc::SIGABRT, crash_signal_handler as *const () as usize);
        libc::signal(libc::SIGSEGV, crash_signal_handler as *const () as usize);
        libc::signal(libc::SIGBUS, crash_signal_handler as *const () as usize);
        libc::signal(libc::SIGILL, crash_signal_handler as *const () as usize);
        libc::signal(libc::SIGSYS, crash_signal_handler as *const () as usize);
    }
}

/// Signal handler that writes JSON crash info to exit file.
///
/// Note: We intentionally don't read stderr here. Signal handlers should be
/// minimal and avoid async-signal-unsafe operations. CrashReport reads stderr
/// directly from the file when formatting the error message.
extern "C" fn crash_signal_handler(sig: libc::c_int) {
    let signal = match sig {
        libc::SIGABRT => "SIGABRT",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGBUS => "SIGBUS",
        libc::SIGILL => "SIGILL",
        libc::SIGSYS => "SIGSYS",
        _ => "UNKNOWN",
    };

    if let Some(exit_file) = EXIT_FILE_PATH.get() {
        let info = ExitInfo::Signal {
            exit_code: SIGNAL_EXIT_CODE_BASE + sig,
            signal: signal.to_string(),
        };
        if let Ok(json) = serde_json::to_string(&info) {
            let _ = std::fs::write(exit_file, json);
        }
    }

    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}
