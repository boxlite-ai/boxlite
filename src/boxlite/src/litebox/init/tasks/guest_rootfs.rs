//! Task: resolve the bundled minimal guest rootfs.

use super::{InitCtx, log_task_error, task_start};
use crate::pipeline::PipelineTask;
use crate::rootfs::guest::GuestRootfs;
use crate::util::RuntimeBinaryFinder;
use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

pub struct GuestRootfsTask;

#[async_trait]
impl PipelineTask<InitCtx> for GuestRootfsTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let rootfs_path = RuntimeBinaryFinder::from_env()
            .find("guest-rootfs/rootfs")
            .and_then(GuestRootfs::from_bundled_rootfs)
            .inspect_err(|error| log_task_error(&box_id, task_name, error))?;

        let mut ctx = ctx.lock().await;
        if ctx.layout.is_none() {
            return Err(BoxliteError::Internal(
                "filesystem task must run before guest rootfs resolution".into(),
            ));
        }
        ctx.guest_rootfs = Some(rootfs_path);
        Ok(())
    }

    fn name(&self) -> &str {
        "guest_rootfs_init"
    }
}
