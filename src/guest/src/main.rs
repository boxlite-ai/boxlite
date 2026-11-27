//! Entry point for the Boxlite guest agent.

#[cfg(not(target_os = "linux"))]
compile_error!("BoxLite guest is Linux-only; build with a Linux target");

#[cfg(all(target_os = "linux", feature = "integration-test-init", not(test)))]
#[path = "../tests/support/mount_init.rs"]
mod mount_test_init;

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
use service::server::GuestServer;
#[cfg(target_os = "linux")]
use std::sync::OnceLock;
#[cfg(target_os = "linux")]
use std::time::Instant;
#[cfg(target_os = "linux")]
use tracing::debug;

/// Boot timestamp, recorded only when console timing is enabled.
#[cfg(target_os = "linux")]
static BOOT_T0: OnceLock<Instant> = OnceLock::new();

#[cfg(target_os = "linux")]
pub(crate) fn boot_timing_enabled() -> bool {
    BOOT_T0.get().is_some()
}

#[cfg(target_os = "linux")]
pub(crate) fn boot_timing_log(msg: impl std::fmt::Display) {
    if let Some(t0) = BOOT_T0.get() {
        eprintln!("[guest] T+{}ms: {msg}", t0.elapsed().as_millis());
    }
}

#[cfg(target_os = "linux")]
struct GuestArgs {
    listen: String,
    notify: Option<String>,
}

#[cfg(target_os = "linux")]
impl GuestArgs {
    fn parse() -> Result<Self, String> {
        let mut args = std::env::args().skip(1).peekable();
        let (mut listen, mut notify) = (None, None);
        while let Some(arg) = args.next() {
            let (flag, value) = arg
                .split_once('=')
                .map_or((arg.as_str(), None), |(k, v)| (k, Some(v)));
            let slot = match (flag, value) {
                ("--help" | "-h", None) => {
                    println!("Usage: boxlite-guest -l|--listen URI [-n|--notify URI]");
                    lifecycle::exit(0);
                }
                ("--listen" | "-l", _) => &mut listen,
                ("--notify" | "-n", _) => &mut notify,
                _ => return Err(format!("unknown argument: {arg}")),
            };
            if slot.is_some() {
                return Err(format!("duplicate argument: {flag}"));
            }
            *slot = Some(
                value
                    .map(str::to_owned)
                    .or_else(|| args.next_if(|arg| !arg.starts_with('-')))
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| format!("{flag} requires a URI"))?,
            );
        }
        Ok(Self {
            listen: listen.ok_or("--listen is required")?,
            notify,
        })
    }
}

#[cfg(target_os = "linux")]
fn main() {
    #[cfg(all(feature = "integration-test-init", not(test)))]
    {
        mount_test_init::run();
    }

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
    if std::env::var_os("BOXLITE_GUEST_BOOT_TIMING").as_deref() == Some(std::ffi::OsStr::new("1")) {
        BOOT_T0
            .set(Instant::now())
            .expect("BOOT_T0 already initialized");
        eprintln!("[guest] T+0ms: agent starting");
    }

    let args = GuestArgs::parse().unwrap_or_else(|error| {
        eprintln!("Error: {error}. See --help for usage.");
        lifecycle::exit(2);
    });
    let subscriber = tracing_subscriber::fmt()
        .with_target(true)
        .with_writer(std::io::stderr);
    let tracing_init = if std::env::var_os("RUST_LOG").is_some() {
        subscriber
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
            )
            .try_init()
    } else {
        subscriber
            .with_max_level(tracing::level_filters::LevelFilter::WARN)
            .try_init()
    };
    if let Err(e) = tracing_init {
        eprintln!("[ERROR] Failed to initialize tracing: {e}");
    }
    boot_timing_log("tracing initialized");

    debug!("BoxLite Guest Agent starting");
    debug!(
        "Arguments parsed: listen={}, notify={:?}",
        args.listen, args.notify
    );

    // Native init supplies the mounts and defaults that init.krun provides
    // when the same binary runs as an ordinary process under libkrun.
    bootstrap::prepare()?;

    // Start zygote BEFORE tokio creates any threads.
    // The zygote builds container processes in a single-threaded context,
    // avoiding musl's __malloc_lock deadlock. See docs/contributing/investigations/concurrent-exec-deadlock.md
    use container::zygote::{Zygote, ZYGOTE};
    let zygote = Zygote::start()?;
    ZYGOTE.set(zygote).expect("zygote already initialized");
    boot_timing_log("zygote started");

    // With one schedulable CPU there is no parallelism to gain from a worker
    // pool. Blocking work can still use spawn_blocking on either runtime.
    let mut builder = if std::thread::available_parallelism().is_ok_and(|cpus| cpus.get() == 1) {
        tokio::runtime::Builder::new_current_thread()
    } else {
        tokio::runtime::Builder::new_multi_thread()
    };
    let rt = builder.enable_all().build().map_err(|e| {
        boxlite_shared::errors::BoxliteError::Internal(format!("tokio runtime: {e}"))
    })?;
    rt.block_on(async_main(args))
}

#[cfg(target_os = "linux")]
async fn async_main(args: GuestArgs) -> BoxliteResult<()> {
    // PID 1 already mounted these in bootstrap::prepare. Under libkrun,
    // ensure virtio-fs paths that need open-unlink-fstat are backed by tmpfs.
    if std::process::id() != 1 {
        mounts::mount_essential_tmpfs()?;
    }
    boot_timing_log("tmpfs mounted");

    // Install the child-reaper before serving: one waitpid(-1) loop reaps the
    // container init, exec tenants (both reparent to us via as_sibling), and
    // guest processes, so a finished command is observed and the box stops
    // itself. See the reaper module.
    let _ = reaper::REAPER.set(reaper::Reaper::install());

    // Bind and notify the host before completing boot preparation.
    // Guest.Init waits for that preparation before setting up storage or networking.
    debug!("Starting guest server on: {}", args.listen);
    GuestServer::new(layout::GuestLayout::new())
        .run(args.listen, args.notify)
        .await
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
