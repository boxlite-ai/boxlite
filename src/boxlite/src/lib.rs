//! Boxlite runtime library.
//!
//! This crate provides the host-side API for managing Boxlite sandboxes.

use std::path::Path;
use std::sync::OnceLock;
use tracing_subscriber::EnvFilter;

// Global guard for tracing-appender to keep the writer thread alive.
// Only set when an executable explicitly calls `init_logging_for`.
static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

pub mod event_listener;
pub mod jailer;
pub mod litebox;
pub mod lock;
pub mod metrics;
pub mod net;
pub mod pipeline;
pub mod runtime;
pub mod system_check;
pub mod util;
pub mod vmm;

mod db;
mod disk;
mod fs;
mod images;
mod portal;
#[cfg(feature = "rest")]
mod rest;
mod rootfs;
mod volumes;

pub use litebox::LiteBox;
pub use portal::GuestSession;
pub use runtime::{AuthHandle, BoxliteRuntime, ImageHandle, Principal};

pub use boxlite_shared::errors::{BoxliteError, BoxliteResult};
pub use disk::DiskInfo;
pub use event_listener::{AuditEvent, AuditEventKind, AuditEventListener, EventListener};
pub use litebox::SnapshotHandle;
pub use litebox::archive::ArchiveManifest;
pub use litebox::snapshot_mgr::SnapshotInfo;
pub use litebox::{
    BoxCommand, CopyOptions, ExecResult, ExecStderr, ExecStdin, ExecStdout, Execution, ExecutionId,
    HealthState, HealthStatus,
};
pub use metrics::{BoxMetrics, RuntimeMetrics};
pub use runtime::advanced_options::{
    AdvancedBoxOptions, HealthCheckOptions, ResourceLimits, SecurityOptions,
};
pub use runtime::options::{
    BoxArchive, BoxOptions, BoxliteOptions, CloneOptions, ExportOptions, ImageRegistry,
    ImageRegistryAuth, NetworkSpec, RegistryTransport, RootfsSpec, Secret, SnapshotOptions,
};
/// Boxlite library version (from CARGO_PKG_VERSION at compile time).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub use runtime::id::{BaseDiskID, BaseDiskIDMint, BoxID, BoxIDMint};
pub use runtime::types::ContainerID;
pub use runtime::types::{BoxInfo, BoxState, BoxStateInfo, BoxStatus};

#[cfg(feature = "rest")]
pub use rest::credential::{AccessToken, ApiKeyCredential, Credential};
#[cfg(feature = "rest")]
pub use rest::options::BoxliteRestOptions;

/// Opt-in helper for executables (SDK bindings, daemons, embedders) that want
/// the default Boxlite file logger at `<home_dir>/logs/boxlite.log` with daily
/// rotation. Honors `RUST_LOG` (defaults to `info` when unset). Idempotent.
///
/// **Libraries must not call this.** The `tracing` crate is explicit that
/// installing a global default subscriber is the executable's responsibility;
/// doing it from a library "will cause conflicts when executables that depend
/// on the library try to set the default later." Boxlite's own CLI installs
/// its own layered subscriber in `boxlite-cli/src/main.rs` and does not call
/// this function.
///
/// Errors creating the log directory are returned; errors installing the
/// global default (because one is already set by the host) are swallowed
/// silently — the host's subscriber wins.
pub fn init_logging_for(home_dir: &Path) -> BoxliteResult<()> {
    let logs_dir = crate::runtime::layout::FilesystemLayout::logs_dir_for(home_dir);
    std::fs::create_dir_all(&logs_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create logs directory {}: {}",
            logs_dir.display(),
            e
        ))
    })?;

    let _ = LOG_GUARD.get_or_init(|| {
        let file_appender = tracing_appender::rolling::daily(logs_dir, "boxlite.log");
        let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

        let env_filter = EnvFilter::try_from_default_env()
            .or_else(|_| EnvFilter::try_new("info"))
            .unwrap_or_else(|_| EnvFilter::new("info"));

        // If a global default subscriber is already set, `try_init` is a no-op —
        // the host's subscriber wins, which is the idiomatic outcome.
        util::register_to_tracing(non_blocking, env_filter);

        guard
    });

    Ok(())
}
