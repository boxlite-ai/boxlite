//! libkrun's checkpoint owner behind the shim's control socket.

use crate::vmm::checkpoint::{descriptors, protocol::DescriptorRequest};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

use crate::vmm::checkpoint::krun_abi::{self, call_result, run_state};
use crate::vmm::checkpoint::{CheckpointOwner, FailureKind, OwnerError, VmRunState};
use libkrun_sys::{
    KRUN_SNAPSHOT_PAUSE_HOST_WRITERS_STOPPED, krun_snapshot_get_state, krun_snapshot_pause,
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
    fn descriptors(
        &self,
        request: DescriptorRequest,
        files: Vec<OwnedFd>,
    ) -> Result<(serde_json::Value, Vec<OwnedFd>), OwnerError> {
        let exact = |count| {
            if files.len() == count {
                Ok(())
            } else {
                Err(rejected("checkpoint descriptor count differs"))
            }
        };
        let json = |bytes: Vec<u8>| {
            serde_json::from_slice(&bytes)
                .map_err(|e| OwnerError::new(FailureKind::Failed, format!("libkrun metadata: {e}")))
        };
        let empty = || Ok((serde_json::Value::Null, Vec::new()));
        match request {
            DescriptorRequest::Capabilities => {
                exact(0)?;
                // SAFETY: capability query takes no arguments.
                Ok((
                    serde_json::json!({"protocol":2,"capabilities":unsafe { libkrun_sys::krun_snapshot_capabilities() }}),
                    Vec::new(),
                ))
            }
            DescriptorRequest::Begin { disk_only } => {
                exact(1)?;
                let mut token = 0;
                // SAFETY: live borrowed stream FD and writable token outlive the call.
                self.finish("begin capture", unsafe {
                    libkrun_sys::krun_snapshot_begin_capture(
                        self.ctx_id,
                        u32::from(disk_only),
                        files[0].as_raw_fd(),
                        &mut token,
                    )
                })?;
                Ok((serde_json::json!({"token":token}), Vec::new()))
            }
            DescriptorRequest::End { token, cancel } => {
                exact(0)?;
                // SAFETY: libkrun validates the context and capture token.
                self.finish("end capture", unsafe {
                    libkrun_sys::krun_snapshot_end_capture(self.ctx_id, token, u32::from(cancel))
                })?;
                empty()
            }
            DescriptorRequest::Prepare { token } => {
                exact(0)?;
                let (mut length, mut count) = (0, 0);
                // SAFETY: null buffers request lengths only; no FDs transfer.
                let status = unsafe {
                    libkrun_sys::krun_snapshot_prepare_capture(
                        self.ctx_id,
                        token,
                        std::ptr::null_mut(),
                        &mut length,
                        std::ptr::null_mut(),
                        &mut count,
                    )
                };
                if status != -libc::ENOBUFS {
                    self.finish("prepare capture sizes", status)?;
                }
                if length > descriptors::MAX_JSON {
                    return Err(rejected("checkpoint metadata exceeds 16 MiB"));
                }
                descriptors::preflight(count)
                    .map_err(|e| OwnerError::new(FailureKind::Io, e.to_string()))?;
                let mut bytes = vec![0; length];
                let mut raw = vec![-1; count];
                // SAFETY: buffers have the returned sizes; successful output FDs
                // transfer ownership exactly once to OwnedFd below.
                self.finish("prepare capture", unsafe {
                    libkrun_sys::krun_snapshot_prepare_capture(
                        self.ctx_id,
                        token,
                        bytes.as_mut_ptr(),
                        &mut length,
                        raw.as_mut_ptr(),
                        &mut count,
                    )
                })?;
                let files = raw
                    .into_iter()
                    .map(|fd| unsafe { OwnedFd::from_raw_fd(fd) })
                    .collect();
                bytes.truncate(length);
                Ok((json(bytes)?, files))
            }
            DescriptorRequest::Export { token, metadata } => {
                exact(2)?;
                let bytes = serde_json::to_vec(&metadata).map_err(|e| rejected(e.to_string()))?;
                // SAFETY: both borrowed FDs and JSON bytes remain valid for the call.
                self.finish("export capture", unsafe {
                    libkrun_sys::krun_snapshot_export_fd(
                        self.ctx_id,
                        token,
                        files[0].as_raw_fd(),
                        files[1].as_raw_fd(),
                        bytes.as_ptr(),
                        bytes.len(),
                    )
                })?;
                empty()
            }
            DescriptorRequest::Import { bindings } => {
                if files.is_empty() {
                    return Err(rejected("missing memory descriptor"));
                }
                let bytes = serde_json::to_vec(&bindings).map_err(|e| rejected(e.to_string()))?;
                let raw: Vec<_> = files[1..].iter().map(AsRawFd::as_raw_fd).collect();
                // SAFETY: libkrun duplicates the borrowed memory/resource FDs.
                self.finish("import capture", unsafe {
                    libkrun_sys::krun_snapshot_import_fd(
                        self.ctx_id,
                        files[0].as_raw_fd(),
                        bytes.as_ptr(),
                        bytes.len(),
                        raw.as_ptr(),
                        raw.len(),
                    )
                })?;
                empty()
            }
            DescriptorRequest::Inspect => {
                exact(1)?;
                let mut length = 0;
                // SAFETY: null buffer requests checked metadata length only.
                let status = unsafe {
                    libkrun_sys::krun_snapshot_inspect_fd(
                        files[0].as_raw_fd(),
                        std::ptr::null_mut(),
                        &mut length,
                    )
                };
                if status != -libc::ENOBUFS {
                    self.finish("inspect sizes", status)?;
                }
                if length > descriptors::MAX_JSON {
                    return Err(rejected("checkpoint metadata exceeds 16 MiB"));
                }
                let mut bytes = vec![0; length];
                // SAFETY: metadata buffer has the required size.
                self.finish("inspect capture", unsafe {
                    libkrun_sys::krun_snapshot_inspect_fd(
                        files[0].as_raw_fd(),
                        bytes.as_mut_ptr(),
                        &mut length,
                    )
                })?;
                bytes.truncate(length);
                Ok((json(bytes)?, Vec::new()))
            }
        }
    }

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

    fn stop(&self) -> Result<(), OwnerError> {
        // SAFETY: plain value; libkrun validates the context ID.
        self.finish("stop", unsafe { krun_snapshot_stop(self.ctx_id) })
    }
}

fn rejected(message: impl Into<String>) -> OwnerError {
    OwnerError::new(FailureKind::Rejected, message)
}
