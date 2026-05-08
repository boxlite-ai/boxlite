//! Universal Box runner binary for all engine types.
//!
//! This binary handles the actual Box execution in a subprocess and delegates
//! to the appropriate VMM based on the engine type argument.
//!
//! Engine implementations auto-register themselves via the inventory pattern,
//! so this runner doesn't need to know about specific engine types.
//!
//! ## Network Backend
//!
//! The shim creates the network backend (gvproxy) from network_config if present.
//! This ensures networking survives detach operations - the gvproxy lives in the
//! shim subprocess, not the main boxlite process.

mod crash_capture;

use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use boxlite::{
    util,
    vmm::{self, ExitInfo, InstanceSpec, VmmConfig, controller::watchdog},
};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use crash_capture::CrashCapture;
#[allow(unused_imports)]
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use boxlite::net::gvproxy::GvproxyInstance;

// No CLI args — all config (including engine type) is read from stdin pipe.
// This avoids /proc/<pid>/cmdline exposure of secrets and CA keys.

/// Initialize tracing with file logging.
///
/// Logs are written to {box_dir}/logs/boxlite-shim.log with daily rotation.
/// Returns WorkerGuard that must be kept alive to maintain the background writer thread.
fn init_logging(box_dir: &Path) -> tracing_appender::non_blocking::WorkerGuard {
    let logs_dir = box_dir.join("logs");

    // Create logs directory if it doesn't exist
    std::fs::create_dir_all(&logs_dir).expect("Failed to create logs directory");

    // Set up file appender with daily rotation
    let file_appender = tracing_appender::rolling::daily(logs_dir, "boxlite-shim.log");

    // Create non-blocking writer
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    // Set up env filter (defaults to "info" if RUST_LOG not set)
    let env_filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("info"))
        .unwrap();

    // Initialize subscriber with file output
    util::register_to_tracing(non_blocking, env_filter);

    guard
}

fn main() -> BoxliteResult<()> {
    let t0 = Instant::now();
    let timing = |msg: &str| eprintln!("[shim] T+{}ms: {msg}", t0.elapsed().as_millis());

    let wall = chrono::Utc::now().format("%H:%M:%S%.6f");
    eprintln!("[shim] {wall} T+0ms: main() entered");

    // Read config from stdin (piped by parent process).
    // Stdin avoids /proc/<pid>/cmdline exposure — CLI args are world-readable
    // on Linux, and the config contains CA private keys and secret values.
    let config_json = {
        use std::io::Read;
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| BoxliteError::Engine(format!("Failed to read config from stdin: {e}")))?;
        buf
    };

    #[allow(unused_mut)]
    let mut config: InstanceSpec = serde_json::from_str(&config_json)
        .map_err(|e| BoxliteError::Engine(format!("Failed to parse config JSON: {e}")))?;
    timing("config parsed");

    // Initialize logging using box_dir derived from exit_file path.
    // Logs go to box_dir/logs/ so the sandbox only needs write access to box_dir.
    let box_dir = config
        .exit_file
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf();
    let _log_guard = init_logging(&box_dir);
    timing("logging initialized");

    // Install crash capture (panic hook, signal handlers).
    // Note: stderr is already redirected to file by parent process (spawn.rs).
    // CrashReport reads stderr content directly from shim.stderr when needed.
    CrashCapture::install(config.exit_file.clone());

    tracing::info!(
        engine = ?config.engine,
        box_id = %config.box_id,
        "Box runner starting"
    );

    // Save exit_file path for error handling
    let exit_file = config.exit_file.clone();

    // Run the shim and handle errors
    run_shim(config, timing).inspect_err(|e| {
        let info = ExitInfo::Error {
            exit_code: 1,
            message: e.to_string(),
        };

        if let Ok(json) = serde_json::to_string(&info) {
            let _ = std::fs::write(&exit_file, json);
        }
    })
}

#[allow(unused_mut)]
fn run_shim(mut config: InstanceSpec, timing: impl Fn(&str)) -> BoxliteResult<()> {
    tracing::debug!(
        shares = ?config.fs_shares.shares(),
        "Filesystem shares configured"
    );
    tracing::debug!(
        entrypoint = ?config.guest_entrypoint.executable,
        "Guest entrypoint configured"
    );

    // =========================================================================
    // Network backend (gvproxy) + Seccomp
    // =========================================================================

    // Create network backend (gvproxy) from network_config if present.
    // gvproxy provides virtio-net (eth0) to the guest - required even without port mappings.
    // The gvproxy instance is leaked intentionally - it must live for the entire
    // duration of the VM. When the shim process exits, OS cleans up all resources.
    if let Some(ref net_config) = config.network_config {
        let (gvproxy, endpoint) = GvproxyInstance::from_config(net_config)?;
        config.network_backend_endpoint = Some(endpoint);
        timing("gvproxy created");

        // Leak to keep networking alive for VM lifetime (OS cleans up on exit)
        Box::leak(Box::new(gvproxy));
    }

    // Apply VMM seccomp filter with TSYNC (covers all threads including gvproxy)
    #[cfg(target_os = "linux")]
    {
        use boxlite::jailer::seccomp;

        if config.security.jailer_enabled && config.security.seccomp_enabled {
            tracing::info!(
                box_id = %config.box_id,
                "Applying VMM seccomp filter (TSYNC)"
            );

            seccomp::apply_vmm_filter(&config.box_id)?;

            tracing::info!(
                box_id = %config.box_id,
                "Seccomp isolation complete"
            );
        } else if config.security.jailer_enabled {
            tracing::warn!(
                box_id = %config.box_id,
                "Seccomp disabled - running without syscall filtering"
            );
        } else {
            tracing::warn!(
                box_id = %config.box_id,
                "Jailer disabled - running without process isolation"
            );
        }
    }

    // Save detach/transport before config is moved into engine.create()
    let detach = config.detach;
    let transport = config.transport.clone();

    // Initialize engine options with defaults
    let options = VmmConfig::default();

    // Create engine using inventory pattern (no match statement needed!)
    // Engines auto-register themselves at compile time
    let mut engine = vmm::create_engine(config.engine, options)?;
    timing("engine created");

    tracing::info!("Engine created, creating Box instance");

    // Create Box instance with the provided configuration
    let instance = match engine.create(config) {
        Ok(instance) => instance,
        Err(e) => {
            tracing::error!("Failed to create Box instance: {}", e);
            return Err(e);
        }
    };
    timing("instance created (krun FFI calls done)");

    tracing::info!("Box instance created, handing over process control to Box");

    // Install SIGTERM handler for graceful shutdown (all boxes, detached or not).
    // When SIGTERM is received: Guest.Shutdown() RPC (flush qcow2) → re-raise SIGTERM.
    install_graceful_shutdown_handler(transport);

    // Start parent watchdog if detach=false.
    // The parent holds the write end of a pipe (fd 3 in this process).
    // When parent dies or drops the keepalive, kernel closes the write end,
    // delivering POLLHUP to our watchdog thread → SIGTERM → graceful shutdown.
    if !detach {
        start_parent_watchdog();
        tracing::info!("Parent watchdog started via pipe POLLHUP (detach=false)");
    } else {
        tracing::info!("Running in detached mode (detach=true)");
    }

    // Hand over process control to Box instance
    // This may never return (process takeover)
    timing("entering VM (krun_start_enter)");
    match instance.enter() {
        Ok(()) => {
            tracing::info!("Box execution completed successfully");
            Ok(())
        }
        Err(e) => {
            tracing::error!("Box execution failed: {}", e);
            Err(e)
        }
    }
}

/// Timeout for graceful shutdown before force kill (in seconds).
const GRACEFUL_SHUTDOWN_TIMEOUT_SECS: u64 = 5;

/// Timeout for guest RPC shutdown (filesystem sync) in seconds.
const GUEST_SHUTDOWN_TIMEOUT_SECS: u64 = 3;

/// Install SIGTERM handler for graceful VM shutdown.
///
/// Uses `signal-hook` to catch SIGTERM in a dedicated thread.
/// When received: Guest.Shutdown() RPC (flush qcow2) → re-raise SIGTERM.
///
/// This ensures any SIGTERM source (runtime shutdown, watchdog, systemd, manual kill)
/// triggers a graceful guest shutdown with filesystem sync. Without this handler,
/// SIGTERM would immediately kill the process, risking qcow2 COW disk buffer loss
/// and ext4 filesystem corruption on next restart.
fn install_graceful_shutdown_handler(transport: boxlite_shared::Transport) {
    use signal_hook::consts::signal::SIGTERM;
    use signal_hook::iterator::Signals;

    let mut signals = match Signals::new([SIGTERM]) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("Failed to install SIGTERM handler: {e}");
            return;
        }
    };

    thread::spawn(move || {
        // Block until SIGTERM received
        for sig in signals.forever() {
            if sig == SIGTERM {
                tracing::info!("SIGTERM received, initiating graceful guest shutdown");
                break;
            }
        }

        // Guest.Shutdown() RPC — flush qcow2 buffers (critical for data integrity)
        match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => {
                let session = boxlite::GuestSession::new(transport);
                let result = rt.block_on(async {
                    tokio::time::timeout(Duration::from_secs(GUEST_SHUTDOWN_TIMEOUT_SECS), async {
                        match session.guest().await {
                            Ok(mut guest) => {
                                let _ = guest.shutdown().await;
                            }
                            Err(e) => {
                                tracing::debug!("Could not connect to guest for shutdown: {e}");
                            }
                        }
                    })
                    .await
                });
                match result {
                    Ok(()) => tracing::info!("Guest shutdown completed (filesystems synced)"),
                    Err(_) => tracing::warn!(
                        timeout_secs = GUEST_SHUTDOWN_TIMEOUT_SECS,
                        "Guest shutdown timed out"
                    ),
                }
            }
            Err(e) => tracing::warn!("Failed to build tokio runtime for guest shutdown: {e}"),
        }

        // Re-raise SIGTERM with default handler for correct exit status (128+15=143)
        unsafe {
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            libc::raise(libc::SIGTERM);
        }
    });
}

/// Start a watchdog thread that detects parent death via pipe POLLHUP.
///
/// The parent holds the write end of a pipe; the read end is fd 3 in this process
/// (dup2'd by the pre_exec hook). When the parent dies or drops its keepalive,
/// the kernel closes the write end, delivering POLLHUP immediately — zero latency,
/// works across PID/mount namespaces.
///
/// On POLLHUP: sends SIGTERM to self. The SIGTERM handler
/// ([`install_graceful_shutdown_handler`]) does the actual graceful shutdown
/// (Guest.Shutdown() RPC → qcow2 flush → exit).
fn start_parent_watchdog() {
    thread::spawn(|| {
        let mut pollfd = libc::pollfd {
            fd: watchdog::PIPE_FD,
            events: libc::POLLIN, // POLLIN for macOS compatibility; POLLHUP is reported in revents
            revents: 0,
        };

        // Block until write end is closed (parent death or keepalive drop)
        let ret = unsafe { libc::poll(&mut pollfd, 1, -1) };

        if ret > 0 && (pollfd.revents & libc::POLLHUP) != 0 {
            tracing::info!("Parent death detected (POLLHUP on watchdog pipe)");
        } else {
            tracing::warn!(
                ret = ret,
                revents = pollfd.revents,
                "Watchdog poll returned unexpectedly"
            );
        }

        // SIGTERM triggers the graceful shutdown handler
        let self_pid = std::process::id();
        unsafe {
            libc::kill(self_pid as i32, libc::SIGTERM);
        }

        // Safety net: wait for handler to complete, then force kill
        thread::sleep(Duration::from_secs(
            GUEST_SHUTDOWN_TIMEOUT_SECS + GRACEFUL_SHUTDOWN_TIMEOUT_SECS,
        ));

        tracing::warn!("Graceful shutdown timed out, forcing exit with SIGKILL");
        unsafe {
            libc::kill(self_pid as i32, libc::SIGKILL);
        }

        // Fallback: if SIGKILL somehow didn't work, exit forcefully
        std::process::exit(137); // 128 + 9 (SIGKILL)
    });
}
