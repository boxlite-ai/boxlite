//! Task: VMM Attach - Attach to an existing running VM process.
//!
//! Creates a handler for an already-running VM subprocess by PID. Used
//! for reconnecting to detached boxes.
//!
//! Identity is read from the canonical PID file (`shim.pid`) and verified
//! via start-time fingerprint. `state.pid` from the DB is a cache that
//! could lag (PID reuse, external kill); the file + ProcessIdentity is
//! the trust anchor.
//!
//! Crash enrichment: when ProcessIdentity is Absent AND the shim left a
//! parseable exit file behind, the error carries the formatted
//! CrashReport so callers see the actual crash cause instead of a
//! generic "shim no longer alive" message.

use super::{InitCtx, task_start};
use crate::litebox::CrashReport;
use crate::pipeline::PipelineTask;
use crate::runtime::rt_impl::stash_exit_file;
use crate::util::{PidFileReader, ProcessIdentity};
use crate::vmm::ExitInfo;
use crate::vmm::controller::ShimHandler;
use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

pub struct VmmAttachTask;

#[async_trait]
impl PipelineTask<InitCtx> for VmmAttachTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (runtime, config_id) = {
            let ctx = ctx.lock().await;
            (ctx.runtime.clone(), ctx.config.id.clone())
        };

        let layout = runtime.layout.box_layout(config_id.as_str(), false)?;
        let pid_file = layout.pid_file_path();
        let exit_file = layout.exit_file_path();

        let pid = match PidFileReader::at(&pid_file).process_identity() {
            ProcessIdentity::Verified(pid) | ProcessIdentity::Legacy(pid) => {
                // Live shim wins — archive any prior-lifecycle exit file
                // so a future crash gets the canonical slot.
                if exit_file.exists() {
                    stash_exit_file(&layout);
                    tracing::warn!(
                        box_id = %box_id,
                        pid,
                        "Live shim found alongside stale exit file; stashed to exit.previous"
                    );
                }
                pid
            }
            ProcessIdentity::Absent => {
                // No live shim. If an exit file is present, surface the
                // crash cause; otherwise fail with a generic message.
                let msg = if ExitInfo::from_file(&exit_file).is_some() {
                    let report = CrashReport::from_exit_file(
                        &exit_file,
                        &layout.console_output_path(),
                        &layout.stderr_file_path(),
                        box_id.as_str(),
                        None,
                    );
                    report.user_message
                } else {
                    "Box process is no longer running (PID file missing, process dead, \
                     or start-time mismatch indicating PID reuse)"
                        .to_string()
                };
                return Err(BoxliteError::InvalidState(msg));
            }
        };

        let handler = ShimHandler::from_pid(pid, config_id);

        let mut ctx = ctx.lock().await;
        ctx.guard.set_handler(Box::new(handler));

        tracing::info!(
            box_id = %box_id,
            pid,
            "Attached to existing VM process"
        );

        Ok(())
    }

    fn name(&self) -> &str {
        "vmm_attach"
    }
}
