//! Runtime backend trait — internal abstraction for local vs REST execution.

use std::path::Path;

use async_trait::async_trait;

use crate::db::snapshots::SnapshotInfo;
use crate::litebox::copy::CopyOptions;
use crate::litebox::{BoxCommand, Execution, LiteBox};
use crate::metrics::{BoxMetrics, RuntimeMetrics};
use crate::runtime::options::{
    BoxArchive, BoxOptions, CloneOptions, ExportOptions, SnapshotOptions,
};
use crate::runtime::types::BoxInfo;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::id::BoxID;

/// Backend abstraction for runtime operations.
///
/// Local backend delegates to `RuntimeImpl` (VM management).
/// REST backend delegates to HTTP API calls.
///
/// This trait is `pub(crate)` — internal implementation detail.
/// The public API (`BoxliteRuntime`) is unchanged.
#[async_trait]
pub(crate) trait RuntimeBackend: Send + Sync {
    async fn create(&self, options: BoxOptions, name: Option<String>) -> BoxliteResult<LiteBox>;

    async fn get_or_create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<(LiteBox, bool)>;

    async fn get(&self, id_or_name: &str) -> BoxliteResult<Option<LiteBox>>;

    async fn get_info(&self, id_or_name: &str) -> BoxliteResult<Option<BoxInfo>>;

    async fn list_info(&self) -> BoxliteResult<Vec<BoxInfo>>;

    async fn exists(&self, id_or_name: &str) -> BoxliteResult<bool>;

    async fn metrics(&self) -> BoxliteResult<RuntimeMetrics>;

    async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()>;

    async fn shutdown(&self, timeout: Option<i32>) -> BoxliteResult<()>;

    async fn import_box(
        &self,
        _archive: BoxArchive,
        _name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        Err(BoxliteError::Unsupported(
            "This operation is only supported for local runtimes (not REST backends)".to_string(),
        ))
    }

    /// Synchronous shutdown for atexit/Drop contexts.
    /// Default no-op (REST backend doesn't manage local processes).
    fn shutdown_sync(&self) {}
}

/// Backend abstraction for individual box operations.
///
/// Local backend is implemented directly by `BoxImpl`.
/// REST backend delegates to HTTP API calls.
#[async_trait]
pub(crate) trait BoxBackend: Send + Sync {
    fn id(&self) -> &BoxID;

    fn name(&self) -> Option<&str>;

    fn info(&self) -> BoxInfo;

    async fn start(&self) -> BoxliteResult<()>;

    async fn exec(&self, command: BoxCommand) -> BoxliteResult<Execution>;

    async fn metrics(&self) -> BoxliteResult<BoxMetrics>;

    async fn stop(&self) -> BoxliteResult<()>;

    async fn copy_into(
        &self,
        host_src: &Path,
        container_dst: &str,
        opts: CopyOptions,
    ) -> BoxliteResult<()>;

    async fn copy_out(
        &self,
        container_src: &str,
        host_dst: &Path,
        opts: CopyOptions,
    ) -> BoxliteResult<()>;

    async fn clone_box(
        &self,
        options: CloneOptions,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox>;

    async fn export_box(&self, options: ExportOptions, dest: &Path) -> BoxliteResult<BoxArchive>;
}

/// Backend abstraction for snapshot lifecycle operations on a box.
///
/// Kept separate from `BoxBackend` so lifecycle/exec/file operations can evolve
/// independently from snapshot/clone/export behavior.
#[allow(dead_code)] // Snapshots temporarily disabled; will be re-enabled
#[async_trait]
pub(crate) trait SnapshotBackend: Send + Sync {
    async fn create(&self, options: SnapshotOptions, name: &str) -> BoxliteResult<SnapshotInfo>;

    async fn list(&self) -> BoxliteResult<Vec<SnapshotInfo>>;

    async fn get(&self, name: &str) -> BoxliteResult<Option<SnapshotInfo>>;

    async fn remove(&self, name: &str) -> BoxliteResult<()>;

    async fn restore(&self, name: &str) -> BoxliteResult<()>;
}

/// Backend abstraction for execution control (kill, resize).
///
/// Local backend is implemented by `ExecutionInterface`.
/// REST backend delegates to HTTP API calls.
#[async_trait]
pub(crate) trait ExecBackend: Send + Sync {
    async fn kill(&mut self, execution_id: &str, signal: i32) -> BoxliteResult<()>;

    async fn resize_tty(
        &mut self,
        execution_id: &str,
        rows: u32,
        cols: u32,
        x_pixels: u32,
        y_pixels: u32,
    ) -> BoxliteResult<()>;
}
