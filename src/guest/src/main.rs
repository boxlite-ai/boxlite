//! Entry point for the Boxlite guest agent.

#[cfg(not(target_os = "linux"))]
compile_error!("BoxLite guest is Linux-only; build with a Linux target");

#[cfg(target_os = "linux")]
mod bootstrap;
#[cfg(target_os = "linux")]
mod ca_trust;
#[cfg(target_os = "linux")]
mod container;
#[cfg(target_os = "linux")]
mod layout;
#[cfg(target_os = "linux")]
mod lifecycle;
#[cfg(target_os = "linux")]
mod mounts;
#[cfg(target_os = "linux")]
mod network;
#[cfg(target_os = "linux")]
mod overlayfs;
#[cfg(target_os = "linux")]
mod reaper;
#[cfg(target_os = "linux")]
mod service;
#[cfg(target_os = "linux")]
mod storage;
#[cfg(target_os = "linux")]
mod sysctl;
#[cfg(all(test, target_os = "linux"))]
#[path = "tests/syscalls.rs"]
mod test_syscalls;

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
fn main() {
    lifecycle::install_panic_hook();
    if let Err(error) = run() {
        use std::io::Write;
        let _ = writeln!(std::io::stderr(), "Error: {error:?}");
        lifecycle::exit(1);
    }
    lifecycle::exit(0);
}

#[cfg(target_os = "linux")]
fn run() -> BoxliteResult<()> {
    let t0 = Instant::now();
    BOOT_T0.set(t0).expect("BOOT_T0 already initialized");

    // Early diagnostic - visible even if tracing fails
    eprintln!("[guest] T+0ms: agent starting");

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

    // Native init supplies the mounts and defaults that init.krun provides
    // when the same binary runs as an ordinary process under libkrun.
    bootstrap::prepare()?;
    sysctl::apply_boot_hardening()?;
    eprintln!(
        "[guest] T+{}ms: kernel hardening applied",
        boot_elapsed_ms()
    );

    // Start zygote BEFORE tokio creates any threads.
    // The zygote builds container processes in a single-threaded context,
    // avoiding musl's __malloc_lock deadlock. See docs/contributing/investigations/concurrent-exec-deadlock.md
    use container::zygote::{Zygote, ZYGOTE};
    let zygote = Zygote::start()?;
    ZYGOTE.set(zygote).expect("zygote already initialized");
    eprintln!("[guest] T+{}ms: zygote started", boot_elapsed_ms());

    // Now start tokio runtime — threads are safe since the zygote builds container processes
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

    // Install the child-reaper before serving: one waitpid(-1) loop reaps the
    // container init, exec tenants (both reparent to us via as_sibling), and
    // guest processes, so a finished command is observed and the box stops
    // itself. See the reaper module.
    let _ = reaper::REAPER.set(reaper::Reaper::install());

    // Parse command-line arguments with clap
    let args = GuestArgs::try_parse().unwrap_or_else(|error| {
        let _ = error.print();
        lifecycle::exit(error.exit_code());
    });
    info!(
        "Arguments parsed: listen={}, notify={:?}",
        args.listen, args.notify
    );

    network::configure_loopback().await?;
    eprintln!("[guest] T+{}ms: loopback ready", boot_elapsed_ms());

    // Prepare guest layout directories
    let layout = layout::GuestLayout::new();
    info!("Preparing guest layout at {}", layout.base().display());
    layout.prepare_base()?;

    // Start server in uninitialized state
    // Shared storage and external networking are configured by Guest.Init.
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
