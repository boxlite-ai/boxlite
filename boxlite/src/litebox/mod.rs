//! LiteBox - Individual box lifecycle management
//!
//! Provides lazy initialization and execution capabilities for isolated boxes.

pub(crate) mod box_impl;
pub(crate) mod config;
pub mod copy;
mod crash_report;
mod exec;
mod init;
mod manager;
mod state;

pub use copy::CopyOptions;
pub(crate) use crash_report::CrashReport;
pub use exec::{BoxCommand, ExecResult, ExecStderr, ExecStdin, ExecStdout, Execution, ExecutionId};
pub(crate) use manager::BoxManager;
pub use state::{BoxState, BoxStatus};

pub(crate) use box_impl::SharedBoxImpl;
pub(crate) use init::BoxBuilder;

use std::path::Path;
use std::sync::Arc;

use crate::metrics::BoxMetrics;
use crate::runtime::backend::BoxBackend;
use crate::{BoxID, BoxInfo};
use boxlite_shared::errors::BoxliteResult;
pub use config::BoxConfig;

/// LiteBox - Handle to a box.
///
/// Thin wrapper delegating to a `BoxBackend` implementation.
/// Local backend: `BoxImpl` (VM-backed). REST backend: `RestBox` (HTTP-backed).
///
/// Following the same pattern as BoxliteRuntime wrapping RuntimeBackend.
pub struct LiteBox {
    /// Box ID for quick access without locking.
    id: BoxID,
    /// Box name for quick access without locking.
    name: Option<String>,
    /// Backend implementation.
    inner: Arc<dyn BoxBackend>,
}

impl LiteBox {
    /// Create a LiteBox from a backend implementation.
    pub(crate) fn new(inner: Arc<dyn BoxBackend>) -> Self {
        let id = inner.id().clone();
        let name = inner.name().map(|s| s.to_string());
        Self { id, name, inner }
    }

    pub fn id(&self) -> &BoxID {
        &self.id
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// Get box info without triggering VM initialization.
    pub fn info(&self) -> BoxInfo {
        self.inner.info()
    }

    /// Start the box (initialize VM).
    ///
    /// For Configured boxes: initializes VM for the first time.
    /// For Stopped boxes: restarts the VM.
    ///
    /// This is idempotent - calling start() on a Running box is a no-op.
    /// Also called implicitly by exec() if the box is not running.
    pub async fn start(&self) -> BoxliteResult<()> {
        self.inner.start().await
    }

    pub async fn exec(&self, command: BoxCommand) -> BoxliteResult<Execution> {
        self.inner.exec(command).await
    }

    pub async fn metrics(&self) -> BoxliteResult<BoxMetrics> {
        self.inner.metrics().await
    }

    pub async fn stop(&self) -> BoxliteResult<()> {
        self.inner.stop().await
    }

    /// Copy files/directories from host into the container rootfs.
    pub async fn copy_into(
        &self,
        host_src: impl AsRef<Path>,
        container_dst: impl AsRef<str>,
        opts: copy::CopyOptions,
    ) -> BoxliteResult<()> {
        self.inner
            .copy_into(host_src.as_ref(), container_dst.as_ref(), opts)
            .await
    }

    /// Copy files/directories from container rootfs to host.
    pub async fn copy_out(
        &self,
        container_src: impl AsRef<str>,
        host_dst: impl AsRef<Path>,
        opts: copy::CopyOptions,
    ) -> BoxliteResult<()> {
        self.inner
            .copy_out(container_src.as_ref(), host_dst.as_ref(), opts)
            .await
    }
}

// ============================================================================
// THREAD SAFETY ASSERTIONS
// ============================================================================

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    let _ = assert_send_sync::<LiteBox>;
};
