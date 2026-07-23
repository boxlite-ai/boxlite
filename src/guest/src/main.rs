//! Entry point for the Boxlite guest agent.

#[cfg(not(target_os = "linux"))]
compile_error!("BoxLite guest is Linux-only; build with a Linux target");

#[cfg(target_os = "linux")]
mod ca_trust;
#[cfg(target_os = "linux")]
mod container;
#[cfg(target_os = "linux")]
mod layout;
#[cfg(target_os = "linux")]
mod mounts;
#[cfg(target_os = "linux")]
mod network;
#[cfg(target_os = "linux")]
mod overlayfs;
#[cfg(target_os = "linux")]
mod service;
#[cfg(target_os = "linux")]
mod storage;

#[cfg(target_os = "linux")]
use boxlite_shared::errors::BoxliteResult;
#[cfg(target_os = "linux")]
use clap::Parser;
#[cfg(target_os = "linux")]
use service::server::GuestServer;
#[cfg(target_os = "linux")]
use std::sync::OnceLock;
#[cfg(target_os = "linux")]
use std::time::Instant;
#[cfg(target_os = "linux")]
use tracing::info;

/// Boot timestamp, set once at guest agent startup.
#[cfg(target_os = "linux")]
static BOOT_T0: OnceLock<Instant> = OnceLock::new();

/// Milliseconds elapsed since guest agent startup.
#[cfg(target_os = "linux")]
pub(crate) fn boot_elapsed_ms() -> u128 {
    BOOT_T0.get().map(|t| t.elapsed().as_millis()).unwrap_or(0)
}

/// BoxLite Guest Agent - runs inside the isolated Box to execute containers
#[cfg(target_os = "linux")]
#[derive(Parser, Debug)]
#[command(author, version, about = "BoxLite Guest Agent - Box-side agent")]
struct GuestArgs {
    /// Listen URI for host communication
    ///
    /// Examples:
    ///   --listen vsock://2695
    ///   --listen unix:///var/run/boxlite.sock
    ///   --listen tcp://127.0.0.1:8080
    #[arg(short, long)]
    listen: String,

    /// Notify URI to signal host when ready
    ///
    /// Guest connects to this URI after gRPC server is ready to serve.
    /// Examples:
    ///   --notify vsock://2696
    ///   --notify unix:///var/run/boxlite-ready.sock
    #[arg(short, long)]
    notify: Option<String>,
}

#[cfg(target_os = "linux")]
fn main() -> BoxliteResult<()> {
    let t0 = Instant::now();
    BOOT_T0.set(t0).expect("BOOT_T0 already initialized");

    // Early diagnostic - visible even if tracing fails
    eprintln!("[guest] T+0ms: agent starting");

    // Set panic hook to ensure we see panics
    std::panic::set_hook(Box::new(|panic_info| {
        eprintln!("[PANIC] Guest agent panicked: {}", panic_info);
        std::process::exit(1);
    }));

    // Initialize tracing subscriber - respects RUST_LOG env var
    // Default to "info" level if RUST_LOG is not set (for visibility)
    if let Err(e) = tracing_subscriber::fmt()
        .with_target(true) // Show module names
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init()
    {
        eprintln!("[ERROR] Failed to initialize tracing: {}", e);
        // Continue anyway - logging failure shouldn't stop the server
    }
    eprintln!("[guest] T+{}ms: tracing initialized", boot_elapsed_ms());

    info!("BoxLite Guest Agent starting");

    // Start zygote BEFORE tokio creates any threads.
    // The zygote handles all clone3() calls in a single-threaded context,
    // avoiding musl's __malloc_lock deadlock. See docs/investigations/concurrent-exec-deadlock.md
    use container::zygote::{Zygote, ZYGOTE};
    let zygote = Zygote::start()?;
    ZYGOTE.set(zygote).expect("zygote already initialized");
    eprintln!("[guest] T+{}ms: zygote started", boot_elapsed_ms());

    // Now start tokio runtime — threads are safe since clone3 goes through zygote
    let rt = tokio::runtime::Runtime::new().map_err(|e| {
        boxlite_shared::errors::BoxliteError::Internal(format!("tokio runtime: {e}"))
    })?;
    rt.block_on(async_main())
}

#[cfg(target_os = "linux")]
async fn async_main() -> BoxliteResult<()> {
    // Mount essential tmpfs directories early
    // Needed because virtio-fs doesn't support open-unlink-fstat pattern
    mounts::mount_essential_tmpfs()?;
    eprintln!("[guest] T+{}ms: tmpfs mounted", boot_elapsed_ms());

    // Parse command-line arguments with clap
    let args = GuestArgs::parse();
    info!(
        "Arguments parsed: listen={}, notify={:?}",
        args.listen, args.notify
    );

    // Prepare guest layout directories
    let layout = layout::GuestLayout::new();
    info!("Preparing guest layout at {}", layout.base().display());
    layout.prepare_base()?;

    // Start server in uninitialized state
    // All initialization (mounts, rootfs, network) will happen via Guest.Init RPC
    info!("Starting guest server on: {}", args.listen);
    let server = GuestServer::new(layout);
    server.run(args.listen, args.notify).await
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn test_args_structure() {
        // Test that the args structure compiles
        let args = GuestArgs {
            listen: "vsock://2695".to_string(),
            notify: Some("vsock://2696".to_string()),
        };
        assert_eq!(args.listen, "vsock://2695");
        assert_eq!(args.notify, Some("vsock://2696".to_string()));
    }
}
