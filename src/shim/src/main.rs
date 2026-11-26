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
//! The shim stands up the network backend (gvproxy) from the network provisioning
//! spec (`network_backend_spec`) if present.
//! This ensures networking survives detach operations - the gvproxy lives in the
//! shim subprocess, not the main boxlite process.

mod crash_capture;

#[cfg(test)]
#[path = "tests/outbound_bootstrap.rs"]
mod outbound_bootstrap_tests;

use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use boxlite::vmm::exit_info::ExitErrorKind;
use boxlite::{
    util,
    vmm::{self, ExitInfo, InstanceSpec, VmmConfig, controller::watchdog},
};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use crash_capture::CrashCapture;
#[allow(unused_imports)]
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use boxlite::net::gvproxy::{CloudScope, GvproxyInstance};
use boxlite::net::{
    NetworkBackendEndpoint, NetworkBackendSpec, OutboundBootstrap, OutboundRevision,
};

fn parse_config(json: &str) -> BoxliteResult<(InstanceSpec, Option<OutboundRevision>)> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| BoxliteError::Engine(format!("Failed to parse config JSON: {e}")))?;
    let revision =
        serde_json::from_value(value.get("outbound_revision").cloned().unwrap_or_default())
            .map_err(|e| {
                BoxliteError::Engine(format!("Invalid outbound bootstrap revision: {e}"))
            })?;
    let config = serde_json::from_value(value)
        .map_err(|e| BoxliteError::Engine(format!("Failed to parse config JSON: {e}")))?;
    Ok((config, revision))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteLaunch {
    config: InstanceSpec,
    outbound_v1: OutboundBootstrap,
    #[serde(default)]
    platform_protected_cidrs: Vec<String>,
    cloud_scope: Option<CloudScope>,
}

fn parse_complete_launch(value: serde_json::Value) -> BoxliteResult<CompleteLaunch> {
    let launch: CompleteLaunch = serde_json::from_value(value)
        .map_err(|e| BoxliteError::Engine(format!("Invalid complete shim launch: {e}")))?;
    GvproxyInstance::outbound_capabilities().require(launch.outbound_v1.requirements)?;
    if launch.config.network_backend_spec.is_none() || launch.config.disable_network {
        return Err(BoxliteError::InvalidArgument(
            "complete outbound launch requires a guest NIC".into(),
        ));
    }
    Ok(launch)
}

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

    let value: serde_json::Value = serde_json::from_str(&config_json)
        .map_err(|e| BoxliteError::Engine(format!("Failed to parse config JSON: {e}")))?;
    if value.get("outbound_policy_probe").is_some() {
        if value != serde_json::json!({"outbound_policy_probe": 1}) {
            return Err(BoxliteError::InvalidArgument(
                "invalid outbound capability probe".into(),
            ));
        }
        let reply = serde_json::to_string(&GvproxyInstance::outbound_capabilities())
            .map_err(|e| BoxliteError::Internal(e.to_string()))?;
        println!("{reply}");
        return Ok(());
    }
    if value.get("platform_cidrs_probe").is_some() {
        if value != serde_json::json!({"platform_cidrs_probe": 1}) {
            return Err(BoxliteError::InvalidArgument(
                "invalid platform CIDR capability probe".into(),
            ));
        }
        println!("{}", GvproxyInstance::supports_platform_cidrs());
        return Ok(());
    }
    if value.get("cloud_scope_probe").is_some() {
        if value != serde_json::json!({"cloud_scope_probe": 1}) {
            return Err(BoxliteError::InvalidArgument(
                "invalid Cloud network scope capability probe".into(),
            ));
        }
        println!("{}", GvproxyInstance::supports_cloud_scope());
        return Ok(());
    }
    let launch = parse_launch(&config_json, value)?;
    let config = &launch.config;
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
    run_shim(
        launch,
        |spec, launch| {
            GvproxyInstance::from_host_launch(
                spec,
                launch.revision.as_ref(),
                launch.outbound.as_ref(),
                &launch.protected_cidrs,
                launch.cloud_scope.as_ref(),
            )
        },
        |config| run_vmm(config, &timing),
        &timing,
    )
    .inspect_err(|e| {
        let info = ExitInfo::Error {
            exit_code: 1,
            message: e.to_string(),
            error_kind: ExitErrorKind::of(e),
        };

        if let Ok(json) = serde_json::to_string(&info) {
            let _ = std::fs::write(&exit_file, json);
        }
    })
}

struct ShimLaunch {
    config: InstanceSpec,
    revision: Option<OutboundRevision>,
    outbound: Option<OutboundBootstrap>,
    protected_cidrs: Vec<String>,
    cloud_scope: Option<CloudScope>,
}

fn parse_launch(json: &str, value: serde_json::Value) -> BoxliteResult<ShimLaunch> {
    if value.get("cloud_guard").is_some()
        || value
            .get("cloud_scope")
            .is_some_and(serde_json::Value::is_null)
    {
        return Err(BoxliteError::InvalidArgument(
            "managed Cloud scope is required for a Cloud launch".into(),
        ));
    }
    if value.get("outbound_v1").is_some() {
        let launch = parse_complete_launch(value)?;
        return Ok(ShimLaunch {
            config: launch.config,
            revision: None,
            outbound: Some(launch.outbound_v1),
            protected_cidrs: launch.platform_protected_cidrs,
            cloud_scope: launch.cloud_scope,
        });
    }
    let (config, revision) = parse_config(json)?;
    let protected_cidrs = value
        .get("platform_protected_cidrs")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| BoxliteError::InvalidArgument("invalid platform-protected CIDR list".into()))?
        .unwrap_or_default();
    let cloud_scope = serde_json::from_value(value.get("cloud_scope").cloned().unwrap_or_default())
        .map_err(|_| BoxliteError::InvalidArgument("invalid Cloud network scope launch".into()))?;
    Ok(ShimLaunch {
        config,
        revision,
        outbound: None,
        protected_cidrs,
        cloud_scope,
    })
}

fn run_shim<Backend>(
    mut launch: ShimLaunch,
    start_network: impl FnOnce(
        &NetworkBackendSpec,
        &ShimLaunch,
    ) -> BoxliteResult<(Backend, NetworkBackendEndpoint)>,
    start_vm: impl FnOnce(InstanceSpec) -> BoxliteResult<()>,
    timing: &impl Fn(&str),
) -> BoxliteResult<()> {
    let config = &launch.config;
    tracing::debug!(shares = ?config.fs_shares.shares(), "Filesystem shares configured");
    tracing::debug!(entrypoint = ?config.guest_entrypoint.executable, "Guest entrypoint configured");

    let cloud_scope = launch.cloud_scope.as_ref();
    if cloud_scope.is_some_and(|guard| guard.box_id != config.box_id)
        || (cloud_scope.is_some()
            && (config.network_backend_spec.is_none() || config.disable_network))
    {
        return Err(BoxliteError::InvalidArgument(
            "Cloud network scope launch must match the Box and its network backend".into(),
        ));
    }
    if let Some(spec) = &config.network_backend_spec {
        let (gvproxy, endpoint) = start_network(spec, &launch)?;
        if let Some(guard) = cloud_scope {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            runtime.block_on(guard.confirm_gvproxy(&spec.socket_path))?;
            timing("Cloud gvproxy confirmed");
        }
        launch.config.network_backend_endpoint = Some(endpoint);
        timing("gvproxy created");

        // Keep gvproxy alive for the lifetime of the VM process.
        Box::leak(Box::new(gvproxy));
    }
    start_vm(launch.config)
}

fn run_vmm(config: InstanceSpec, timing: &impl Fn(&str)) -> BoxliteResult<()> {
    // Apply VMM seccomp filter with TSYNC (covers all threads including gvproxy)
    #[cfg(target_os = "linux")]
    {
        use boxlite::jailer::seccomp;

        if config.security.jailer_enabled
            && config.security.seccomp_enabled
            && config.network_backend_spec.is_none()
        {
            tracing::info!(
                box_id = %config.box_id,
                "Applying VMM seccomp filter (TSYNC)"
            );

            seccomp::apply_vmm_filter(&config.box_id)?;

            tracing::info!(
                box_id = %config.box_id,
                "Seccomp isolation complete"
            );
        } else if config.security.jailer_enabled && config.security.seccomp_enabled {
            tracing::warn!(
                box_id = %config.box_id,
                "Seccomp disabled for network-enabled VM; gvproxy runs in-process and is not covered by the VMM syscall profile"
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
fn install_graceful_shutdown_handler(transport: boxlite_shared::BoxTransport) {
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
