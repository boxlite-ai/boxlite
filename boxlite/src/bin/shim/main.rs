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
use std::time::Duration;

use boxlite::{
    runtime::layout,
    util::{self, is_process_alive},
    vmm::{self, ExitInfo, InstanceSpec, VmmConfig, VmmKind},
};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use clap::Parser;
use crash_capture::CrashCapture;
#[allow(unused_imports)]
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

#[cfg(feature = "gvproxy-backend")]
use boxlite::net::{ConnectionType, NetworkBackendEndpoint, gvproxy::GvproxyInstance};

/// Universal Box runner binary - subprocess that executes isolated Boxes
#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "BoxLite shim process - handles Box in isolated subprocess"
)]
struct ShimArgs {
    /// Engine type to use for Box execution
    ///
    /// Supported engines: libkrun, firecracker
    #[arg(long)]
    engine: VmmKind,

    /// Box configuration as JSON string
    ///
    /// This contains the full InstanceSpec including rootfs path, volumes,
    /// networking, guest entrypoint, and other runtime configuration.
    #[arg(long)]
    config: String,
}

/// Initialize tracing with file logging.
///
/// Logs are written to {home_dir}/logs/boxlite-shim.log with daily rotation.
/// Returns WorkerGuard that must be kept alive to maintain the background writer thread.
fn init_logging(home_dir: &Path) -> tracing_appender::non_blocking::WorkerGuard {
    let logs_dir = home_dir.join(layout::dirs::LOGS_DIR);

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
    // Parse command line arguments with clap
    // VmmKind parsed via FromStr trait automatically
    let args = ShimArgs::parse();

    // Parse InstanceSpec from JSON
    let config: InstanceSpec = serde_json::from_str(&args.config)
        .map_err(|e| BoxliteError::Engine(format!("Failed to parse config JSON: {}", e)))?;

    // Initialize logging using home_dir from config
    // Keep guard alive until end of main to ensure logs are written
    let _log_guard = init_logging(&config.home_dir);

    // Install crash capture (panic hook, signal handlers).
    // Note: stderr is already redirected to file by parent process (spawn.rs).
    // CrashReport reads stderr content directly from shim.stderr when needed.
    CrashCapture::install(config.exit_file.clone());

    tracing::info!(
        engine = ?args.engine,
        box_id = %config.box_id,
        "Box runner starting"
    );

    // Save exit_file path for error handling
    let exit_file = config.exit_file.clone();

    // Run the shim and handle errors
    run_shim(args, config).inspect_err(|e| {
        let info = ExitInfo::Error {
            exit_code: 1,
            message: e.to_string(),
        };

        if let Ok(json) = serde_json::to_string(&info) {
            let _ = std::fs::write(&exit_file, json);
        }
    })
}

fn run_shim(args: ShimArgs, mut config: InstanceSpec) -> BoxliteResult<()> {
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
    #[cfg(feature = "gvproxy-backend")]
    if let Some(ref net_config) = config.network_config {
        tracing::info!(
            port_mappings = ?net_config.port_mappings,
            "Creating network backend (gvproxy) from config"
        );

        // Create gvproxy instance with caller-provided socket path
        let gvproxy =
            GvproxyInstance::new(net_config.socket_path.clone(), &net_config.port_mappings)?;

        tracing::info!(
            socket_path = ?net_config.socket_path,
            "Network backend created"
        );

        // Create NetworkBackendEndpoint from socket path
        // Platform-specific connection type:
        // - macOS: UnixDgram with VFKit protocol
        // - Linux: UnixStream with Qemu protocol
        let connection_type = if cfg!(target_os = "macos") {
            ConnectionType::UnixDgram
        } else {
            ConnectionType::UnixStream
        };

        // Use GUEST_MAC constant - must match DHCP static lease in gvproxy config
        use boxlite::net::constants::GUEST_MAC;

        config.network_backend_endpoint = Some(NetworkBackendEndpoint::UnixSocket {
            path: net_config.socket_path.clone(),
            connection_type,
            mac_address: GUEST_MAC,
        });

        // Leak the gvproxy instance to keep it alive for VM lifetime.
        // This is intentional - the VM needs networking for its entire life,
        // and OS cleanup handles resources when process exits.
        let _gvproxy_leaked = Box::leak(Box::new(gvproxy));
        tracing::debug!("Leaked gvproxy instance for VM lifetime");
    }

    // Apply VMM seccomp filter with TSYNC (covers all threads including gvproxy)
    #[cfg(target_os = "linux")]
    {
        use boxlite::jailer::platform::linux;

        if config.security.jailer_enabled && config.security.seccomp_enabled {
            tracing::info!(
                box_id = %config.box_id,
                "Applying VMM seccomp filter (TSYNC)"
            );

            linux::apply_vmm_filter(&config.box_id)?;

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

    // Save detach/parent_pid/transport before config is moved into engine.create()
    let detach = config.detach;
    let parent_pid = config.parent_pid;
    let transport = config.transport.clone();

    // Initialize engine options with defaults
    let options = VmmConfig::default();

    // Create engine using inventory pattern (no match statement needed!)
    // Engines auto-register themselves at compile time
    let mut engine = vmm::create_engine(args.engine, options)?;

    tracing::info!("Engine created, creating Box instance");

    // Create Box instance with the provided configuration
    let instance = match engine.create(config) {
        Ok(instance) => instance,
        Err(e) => {
            tracing::error!("Failed to create Box instance: {}", e);
            return Err(e);
        }
    };

    tracing::info!("Box instance created, handing over process control to Box");

    // Install SIGTERM handler for graceful shutdown (all boxes, detached or not).
    // When SIGTERM is received: Guest.Shutdown() RPC (flush qcow2) → re-raise SIGTERM.
    install_graceful_shutdown_handler(transport);

    // Start parent watchdog if detach=false
    // Watchdog monitors parent process and sends SIGTERM when parent dies
    if !detach {
        start_parent_watchdog(parent_pid);
        tracing::info!(
            parent_pid = parent_pid,
            "Parent watchdog started (detach=false)"
        );
    } else {
        tracing::info!("Running in detached mode (detach=true)");
    }

    // Hand over process control to Box instance
    // This may never return (process takeover)
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

/// Start a watchdog thread that monitors the parent process.
///
/// When parent exits: sends SIGTERM to self. The SIGTERM handler
/// ([`install_graceful_shutdown_handler`]) does the actual graceful shutdown
/// (Guest.Shutdown() RPC → qcow2 flush → exit).
///
/// This ensures orphan boxes don't accumulate when `detach=false`.
fn start_parent_watchdog(parent_pid: u32) {
    thread::spawn(move || {
        let self_pid = std::process::id();

        loop {
            thread::sleep(Duration::from_secs(1));

            if !is_process_alive(parent_pid) {
                tracing::info!(
                    parent_pid = parent_pid,
                    "Parent process exited, sending SIGTERM to trigger graceful shutdown"
                );

                // SIGTERM triggers the graceful shutdown handler
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
            }
        }
    });
}
