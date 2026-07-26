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
mod reaper;
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

    /// Listen address for the in-guest SSH server. Omitted means no SSH
    /// listener at all -- the feature is off unless the host asks for it.
    ///
    /// Example: --ssh-listen 0.0.0.0:22
    #[arg(long)]
    ssh_listen: Option<String>,

    /// Trusted organization SSH CA public key, in OpenSSH format, with the
    /// non-secret CA key ID in the comment field. Repeat to trust the `next`
    /// key as well during a CA rotation. Only CA *public* material is ever
    /// passed here.
    #[arg(long)]
    ssh_ca_key: Vec<String>,

    /// Organization ID every accepted certificate must name as `org:<id>`.
    #[arg(long)]
    ssh_org_id: Option<String>,

    /// Canonical box ID every accepted certificate must name as `box:<id>`.
    #[arg(long)]
    ssh_box_id: Option<String>,
}

/// Resolved, validated SSH configuration for this VM generation.
#[cfg(target_os = "linux")]
struct GuestSshConfig {
    listen: std::net::SocketAddr,
    trust: std::sync::Arc<service::ssh::ca::SshTrust>,
}

/// Turn the SSH boot arguments into a listener configuration.
///
/// Returns `Ok(None)` when `--ssh-listen` was not given: SSH is off by
/// default and its absence is not an error. When it *is* given, an incomplete
/// or malformed trust bundle is a hard startup failure rather than a listener
/// that accepts nothing (or worse, everything) -- deployment must fail closed.
#[cfg(target_os = "linux")]
fn resolve_ssh_config(args: &GuestArgs) -> BoxliteResult<Option<GuestSshConfig>> {
    use boxlite_shared::errors::BoxliteError;

    let Some(listen) = args.ssh_listen.as_deref() else {
        return Ok(None);
    };

    let listen: std::net::SocketAddr = listen
        .parse()
        .map_err(|e| BoxliteError::Internal(format!("invalid --ssh-listen {listen:?}: {e}")))?;

    let trust = service::ssh::ca::SshTrust::new(
        args.ssh_org_id.as_deref().unwrap_or_default(),
        args.ssh_box_id.as_deref().unwrap_or_default(),
        &args.ssh_ca_key,
    )
    .map_err(|e| BoxliteError::Internal(e.to_string()))?;

    Ok(Some(GuestSshConfig {
        listen,
        trust: std::sync::Arc::new(trust),
    }))
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

    // Install the child-reaper before serving: one waitpid(-1) loop reaps the
    // container init, exec tenants (both reparent to us via as_sibling), and
    // guest processes, so a finished command is observed and the box stops
    // itself. See the reaper module.
    let _ = reaper::REAPER.set(reaper::Reaper::install());

    // Parse command-line arguments with clap
    let args = GuestArgs::parse();
    info!(
        "Arguments parsed: listen={}, notify={:?}",
        args.listen, args.notify
    );

    // Resolved before any listener starts: a bad trust bundle must abort boot,
    // not degrade into an SSH port that rejects everything silently.
    let ssh = resolve_ssh_config(&args)?;
    match &ssh {
        Some(cfg) => info!(
            "SSH enabled: listen={}, trusted_ca_key_ids={:?}",
            cfg.listen,
            cfg.trust.ca_key_ids()
        ),
        None => info!("SSH disabled: no --ssh-listen"),
    }

    // Prepare guest layout directories
    let layout = layout::GuestLayout::new();
    info!("Preparing guest layout at {}", layout.base().display());
    layout.prepare_base()?;

    // Start server in uninitialized state
    // All initialization (mounts, rootfs, network) will happen via Guest.Init RPC
    info!("Starting guest server on: {}", args.listen);
    let server = GuestServer::new(layout);
    let ssh = ssh.map(|cfg| (cfg.listen, cfg.trust));
    server.run(args.listen, args.notify, ssh).await
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn parse(argv: &[&str]) -> GuestArgs {
        GuestArgs::try_parse_from(argv).expect("arguments should parse")
    }

    fn base_argv() -> Vec<&'static str> {
        vec!["boxlite-guest", "--listen", "vsock://2695"]
    }

    fn ca_key_line() -> String {
        let ca = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
            .unwrap();
        let mut public = ca.public_key().clone();
        public.set_comment("ca-key-1");
        public.to_openssh().unwrap()
    }

    #[test]
    fn test_args_structure() {
        let args = parse(&[
            "boxlite-guest",
            "--listen",
            "vsock://2695",
            "--notify",
            "vsock://2696",
        ]);
        assert_eq!(args.listen, "vsock://2695");
        assert_eq!(args.notify, Some("vsock://2696".to_string()));
    }

    #[test]
    fn ssh_is_disabled_without_a_listen_address() {
        let args = parse(&base_argv());
        assert!(resolve_ssh_config(&args).unwrap().is_none());
    }

    #[test]
    fn ssh_ca_keys_left_over_from_a_disabled_config_do_not_start_a_listener() {
        let key = ca_key_line();
        let mut argv = base_argv();
        argv.extend([
            "--ssh-ca-key",
            &key,
            "--ssh-org-id",
            "org-1",
            "--ssh-box-id",
            "box-1",
        ]);
        let args = parse(&argv);
        assert!(resolve_ssh_config(&args).unwrap().is_none());
    }

    #[test]
    fn ssh_config_resolves_with_a_current_only_trust_bundle() {
        let key = ca_key_line();
        let mut argv = base_argv();
        argv.extend([
            "--ssh-listen",
            "0.0.0.0:22",
            "--ssh-ca-key",
            &key,
            "--ssh-org-id",
            "org-1",
            "--ssh-box-id",
            "box-1",
        ]);
        let args = parse(&argv);
        let cfg = resolve_ssh_config(&args)
            .unwrap()
            .expect("ssh should be enabled");
        assert_eq!(cfg.listen.to_string(), "0.0.0.0:22");
        assert_eq!(cfg.trust.ca_key_ids(), vec!["ca-key-1".to_string()]);
    }

    #[test]
    fn ssh_config_accepts_a_repeated_ca_key_for_current_plus_next() {
        let current = ca_key_line();
        let next = ca_key_line();
        let mut argv = base_argv();
        argv.extend([
            "--ssh-listen",
            "0.0.0.0:22",
            "--ssh-ca-key",
            &current,
            "--ssh-ca-key",
            &next,
            "--ssh-org-id",
            "org-1",
            "--ssh-box-id",
            "box-1",
        ]);
        let args = parse(&argv);
        let cfg = resolve_ssh_config(&args)
            .unwrap()
            .expect("ssh should be enabled");
        assert_eq!(cfg.trust.ca_key_ids().len(), 2);
    }

    #[test]
    fn ssh_listen_without_identity_or_ca_keys_fails_closed() {
        let key = ca_key_line();

        let mut no_ca = base_argv();
        no_ca.extend([
            "--ssh-listen",
            "0.0.0.0:22",
            "--ssh-org-id",
            "org-1",
            "--ssh-box-id",
            "box-1",
        ]);
        assert!(resolve_ssh_config(&parse(&no_ca)).is_err());

        let mut no_org = base_argv();
        no_org.extend([
            "--ssh-listen",
            "0.0.0.0:22",
            "--ssh-ca-key",
            &key,
            "--ssh-box-id",
            "box-1",
        ]);
        assert!(resolve_ssh_config(&parse(&no_org)).is_err());

        let mut no_box = base_argv();
        no_box.extend([
            "--ssh-listen",
            "0.0.0.0:22",
            "--ssh-ca-key",
            &key,
            "--ssh-org-id",
            "org-1",
        ]);
        assert!(resolve_ssh_config(&parse(&no_box)).is_err());
    }

    #[test]
    fn a_malformed_ssh_listen_address_fails_closed() {
        let key = ca_key_line();
        let mut argv = base_argv();
        argv.extend([
            "--ssh-listen",
            "not-an-address",
            "--ssh-ca-key",
            &key,
            "--ssh-org-id",
            "org-1",
            "--ssh-box-id",
            "box-1",
        ]);
        assert!(resolve_ssh_config(&parse(&argv)).is_err());
    }
}
