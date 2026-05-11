//! Stable handle for a box whose underlying VM implementation can be replaced.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;

use super::box_impl::SharedBoxImpl;
use super::copy::CopyOptions;
use super::local_snapshot::LocalSnapshotBackend;
use super::snapshot_mgr::SnapshotInfo;
use super::{BoxCommand, BoxTunnel, Execution, LiteBox};
use crate::BoxID;
use crate::metrics::BoxMetrics;
use crate::runtime::backend::{BoxBackend, BoxNetworkBackend, SnapshotBackend};
use crate::runtime::options::{BoxArchive, CloneOptions, ExportOptions, SnapshotOptions};
use crate::runtime::types::BoxInfo;
use boxlite_shared::errors::BoxliteResult;

pub(crate) type SharedBoxHandle = Arc<BoxHandle>;

/// Stable API handle for a box.
///
/// `LiteBox` points at this handle, while restart can replace the current
/// `BoxImpl` underneath it. This keeps existing user handles usable after an
/// automatic restart.
pub(crate) struct BoxHandle {
    id: BoxID,
    name: Option<String>,
    current: RwLock<SharedBoxImpl>,
}

impl BoxHandle {
    pub(crate) fn new(inner: SharedBoxImpl) -> Self {
        Self {
            id: inner.id().clone(),
            name: inner.config.name.clone(),
            current: RwLock::new(inner),
        }
    }

    pub(crate) fn current(&self) -> SharedBoxImpl {
        Arc::clone(&self.current.read())
    }

    pub(crate) fn id(&self) -> &BoxID {
        &self.id
    }

    pub(crate) fn info(&self) -> BoxInfo {
        self.current().info()
    }

}

#[async_trait]
impl BoxBackend for BoxHandle {
    fn id(&self) -> &BoxID {
        &self.id
    }

    fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    fn info(&self) -> BoxInfo {
        self.current().info()
    }

    async fn start(&self) -> BoxliteResult<()> {
        self.current().start().await
    }

    async fn exec(&self, command: BoxCommand) -> BoxliteResult<Execution> {
        self.current().exec(command).await
    }

    async fn attach(&self, execution_id: Option<&str>) -> BoxliteResult<Execution> {
        crate::runtime::backend::BoxBackend::attach(&*self.current(), execution_id).await
    }

    async fn metrics(&self) -> BoxliteResult<BoxMetrics> {
        self.current().metrics().await
    }

    async fn stop(&self) -> BoxliteResult<()> {
        self.current().stop().await
    }

    async fn copy_into(
        &self,
        host_src: &Path,
        container_dst: &str,
        opts: CopyOptions,
    ) -> BoxliteResult<()> {
        self.current()
            .copy_into(host_src, container_dst, opts)
            .await
    }

    async fn copy_out(
        &self,
        container_src: &str,
        host_dst: &Path,
        opts: CopyOptions,
    ) -> BoxliteResult<()> {
        self.current().copy_out(container_src, host_dst, opts).await
    }

    async fn clone_box(
        &self,
        options: CloneOptions,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        self.current().clone_box(options, name).await
    }

    async fn clone_boxes(
        &self,
        options: CloneOptions,
        count: usize,
        names: Vec<String>,
    ) -> BoxliteResult<Vec<LiteBox>> {
        self.current().clone_boxes(options, count, names).await
    }

    async fn export_box(&self, options: ExportOptions, dest: &Path) -> BoxliteResult<BoxArchive> {
        self.current().export_box(options, dest).await
    }
}

#[async_trait]
impl BoxNetworkBackend for BoxHandle {
    async fn tunnel(&self, target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        crate::runtime::backend::BoxNetworkBackend::tunnel(&*self.current(), target).await
    }
}

#[async_trait]
impl SnapshotBackend for BoxHandle {
    async fn create(&self, options: SnapshotOptions, name: &str) -> BoxliteResult<SnapshotInfo> {
        LocalSnapshotBackend::new(self.current())
            .create(options, name)
            .await
    }

    async fn list(&self) -> BoxliteResult<Vec<SnapshotInfo>> {
        LocalSnapshotBackend::new(self.current()).list().await
    }

    async fn get(&self, name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        LocalSnapshotBackend::new(self.current()).get(name).await
    }

    async fn remove(&self, name: &str) -> BoxliteResult<()> {
        LocalSnapshotBackend::new(self.current()).remove(name).await
    }

    async fn restore(&self, name: &str) -> BoxliteResult<()> {
        LocalSnapshotBackend::new(self.current())
            .restore(name)
            .await
    }
}
