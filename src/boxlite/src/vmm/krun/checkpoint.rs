//! libkrun's checkpoint owner behind the shim's control socket.

use std::ffi::{CString, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use crate::vmm::checkpoint::krun_abi::{self, call_result, run_state};
use crate::vmm::checkpoint::{CheckpointOwner, FailureKind, OwnerError, VmRunState};
use libkrun_sys::{
    KRUN_SNAPSHOT_PAUSE_HOST_WRITERS_STOPPED, krun_snapshot_export,
    krun_snapshot_get_restored_share, krun_snapshot_get_state, krun_snapshot_pause,
    krun_snapshot_resume, krun_snapshot_stop,
};

// The ABI mapping is tested without libkrun; keep its numbers honest.
const _: () = {
    assert!(libkrun_sys::KRUN_SNAPSHOT_STATE_CONFIGURED == krun_abi::STATE_CONFIGURED);
    assert!(libkrun_sys::KRUN_SNAPSHOT_STATE_STARTING == krun_abi::STATE_STARTING);
    assert!(libkrun_sys::KRUN_SNAPSHOT_STATE_RUNNING == krun_abi::STATE_RUNNING);
    assert!(libkrun_sys::KRUN_SNAPSHOT_STATE_PAUSED == krun_abi::STATE_PAUSED);
    assert!(libkrun_sys::KRUN_SNAPSHOT_STATE_EXITED == krun_abi::STATE_EXITED);
    assert!(libkrun_sys::KRUN_SNAPSHOT_STATE_FAILED == krun_abi::STATE_FAILED);
    assert!(libkrun_sys::KRUN_SNAPSHOT_STATE_STOPPED == krun_abi::STATE_STOPPED);
};

/// Control handle for a checkpointing context.
///
/// libkrun keys control by context ID and keeps the entry after
/// `krun_start_enter` consumed the context, until `krun_free_ctx`. Every call
/// is thread-safe and blocks until the owner thread finished it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct KrunCheckpoint {
    ctx_id: u32,
}

impl KrunCheckpoint {
    pub(crate) fn new(ctx_id: u32) -> Self {
        Self { ctx_id }
    }

    fn finish(&self, op: &str, status: i32) -> Result<(), OwnerError> {
        let result = call_result(op, status, self.state());
        if let Err(error) = &result {
            tracing::warn!(ctx_id = self.ctx_id, status, error = %error.message, "Checkpoint call failed");
        }
        result
    }
}

impl CheckpointOwner for KrunCheckpoint {
    fn state(&self) -> VmRunState {
        let mut state = 0u32;
        let mut exit_code = 0i32;
        // SAFETY: both pointers are valid for the call; libkrun only writes them.
        let status = unsafe { krun_snapshot_get_state(self.ctx_id, &mut state, &mut exit_code) };
        if status < 0 {
            // -ENOENT: the context was freed after the VM ended.
            tracing::warn!(
                ctx_id = self.ctx_id,
                status,
                "krun_snapshot_get_state failed"
            );
            return VmRunState::Stopped;
        }
        run_state(state, exit_code)
    }

    fn pause(&self, host_writers_stopped: bool) -> Result<(), OwnerError> {
        let flags = if host_writers_stopped {
            KRUN_SNAPSHOT_PAUSE_HOST_WRITERS_STOPPED
        } else {
            0
        };
        // SAFETY: plain values; libkrun validates the context ID.
        self.finish("pause", unsafe { krun_snapshot_pause(self.ctx_id, flags) })
    }

    fn resume(&self) -> Result<(), OwnerError> {
        // SAFETY: plain value; libkrun validates the context ID.
        self.finish("resume", unsafe { krun_snapshot_resume(self.ctx_id) })
    }

    fn export_raw(&self, path: &Path) -> Result<(), OwnerError> {
        let path = path
            .to_str()
            .and_then(|path| CString::new(path).ok())
            .ok_or_else(|| {
                OwnerError::new(
                    FailureKind::Rejected,
                    format!("export path {} is not a valid C string", path.display()),
                )
            })?;
        // SAFETY: `path` is a NUL-terminated string that outlives the call.
        self.finish("export", unsafe {
            krun_snapshot_export(self.ctx_id, path.as_ptr())
        })
    }

    fn stop(&self) -> Result<(), OwnerError> {
        // SAFETY: plain value; libkrun validates the context ID.
        self.finish("stop", unsafe { krun_snapshot_stop(self.ctx_id) })
    }

    fn restored_share(&self, tag: &str) -> Result<PathBuf, OwnerError> {
        let c_tag = CString::new(tag).map_err(|_| {
            OwnerError::new(
                FailureKind::Rejected,
                format!("share tag {tag:?} has a NUL"),
            )
        })?;
        let mut path = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: `c_tag` is NUL-terminated and `path` is writable for its
        // length; both outlive the call.
        let len = unsafe {
            krun_snapshot_get_restored_share(
                self.ctx_id,
                c_tag.as_ptr(),
                path.as_mut_ptr().cast(),
                path.len(),
            )
        };
        match usize::try_from(len) {
            Ok(len) => {
                path.truncate(len);
                Ok(PathBuf::from(OsString::from_vec(path)))
            }
            // An unknown tag, the VM-owned root, or a VM that was not imported.
            Err(_) if len == -libc::ENOENT => Err(OwnerError::new(
                FailureKind::Rejected,
                format!("the VM has no restored share {tag:?}"),
            )),
            Err(_) => Err(self
                .finish("restored share", len)
                .expect_err("a negative status is an error")),
        }
    }
}
