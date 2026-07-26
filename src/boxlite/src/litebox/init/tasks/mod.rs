//! Initialization tasks.
//!
//! ## Dependency Graph
//!
//! ```text
//! Filesystem ───────┐
//!                   │
//! BootAssets ───────┤
//! ContainerRootfs ──┼──→ VmmSpawn ──→ GuestConnect ──→ GuestInit
//! GuestRootfs ──────┘
//!
//! Starting (new box):
//! - Stage 1 (sequential): [Filesystem]
//! - Stage 2 (parallel):   [BootAssets, ContainerRootfs, GuestRootfs]
//! - Stages 3-5 (sequential): [VmmSpawn], [GuestConnect], [GuestInit]
//!
//! Stopped (restart):
//! - Stage 1 (sequential): [Filesystem]
//! - Stage 2 (parallel):   [BootAssets, ContainerRootfs, GuestRootfs]
//! - Stages 3-5 (sequential): [VmmSpawn], [GuestConnect], [GuestInit]
//!
//! Running (reattach):
//! - Stages 1-2 (sequential): [VmmAttach], [GuestConnect]
//! ```

mod boot_assets;
mod container_rootfs;
mod filesystem;
mod guest_connect;
mod guest_entrypoint;
mod guest_init;
mod guest_rootfs;
mod vmm_attach;
mod vmm_spawn;

use super::types::InitPipelineContext;
use crate::runtime::id::BoxID;
use boxlite_shared::errors::BoxliteError;
use std::sync::Arc;
use tokio::sync::Mutex;

pub type InitCtx = Arc<Mutex<InitPipelineContext>>;

async fn task_start(ctx: &InitCtx, task_name: &str) -> BoxID {
    let box_id = { ctx.lock().await.config.id.clone() };
    tracing::debug!(box_id = %box_id, task = %task_name, "Executing task");
    box_id
}

fn log_task_error(box_id: &BoxID, task_name: &str, err: &BoxliteError) {
    tracing::error!(box_id = %box_id, task = %task_name, "Task failed: {}", err);
}

pub use boot_assets::BootAssetsTask;
pub use container_rootfs::ContainerRootfsTask;
pub use filesystem::FilesystemTask;
pub use guest_connect::GuestConnectTask;
pub use guest_init::GuestInitTask;
pub use guest_rootfs::GuestRootfsTask;
pub use vmm_attach::VmmAttachTask;
pub use vmm_spawn::VmmSpawnTask;
