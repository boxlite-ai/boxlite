//! Checkpoint control between the host runtime and the shim's snapshot VM
//! owner.
//!
//! A checkpoint-enabled box runs its VM under libkrun's snapshot owner. The
//! shim serves a box-private Unix socket ([`server::ControlServer`]) whose
//! threads answer while the guest is paused; the host talks to it with
//! [`client::ControlClient`] and turns each result into an [`Outcome`].
//!
//! The rules the host follows:
//! - host state changes only from a reply, which the shim builds after the
//!   owner finished;
//! - a request that was delivered but got no reply is [`Outcome::Uncertain`]:
//!   the host stops the VM and never repeats the request (an export repeated
//!   blindly could publish a second image);
//! - a failed export leaves the guest paused, so the caller can retry or
//!   resume.

pub mod client;
pub mod krun_abi;
pub mod launch;
pub mod protocol;
pub mod server;
pub mod support;

pub use client::{ControlClient, ControlError};
pub use launch::{CheckpointLaunch, CheckpointStart, ImportLaunch};
pub use protocol::{
    ControlFailure, ControlReply, ControlRequest, FailureKind, Operation, VmRunState,
};
pub use server::{CheckpointOwner, ControlServer, OwnerError};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// The DAX window of each share a checkpoint-enabled box mounts (512 MiB,
/// libkrun's default window). Its mappings are VM state a checkpoint
/// carries; ordinary boxes mount without DAX.
pub const DAX_WINDOW_BYTES: u64 = 1 << 29;

/// What one control request means for the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The owner completed the request; the VM is now in this state.
    Done(VmRunState),
    /// The owner answered without completing it; the VM is in `state`.
    Refused {
        state: VmRunState,
        failure: ControlFailure,
    },
    /// Nothing was delivered; the VM is as it was.
    Unavailable(String),
    /// The request may have taken effect. Stop the VM; do not retry.
    Uncertain(String),
}

impl Outcome {
    pub fn from_result(result: Result<ControlReply, ControlError>) -> Self {
        match result {
            Ok(ControlReply {
                state, error: None, ..
            }) => Self::Done(state),
            Ok(ControlReply {
                state,
                error: Some(failure),
                ..
            }) => Self::Refused { state, failure },
            Err(ControlError::Unavailable(m)) => Self::Unavailable(m),
            Err(ControlError::Uncertain(m)) => Self::Uncertain(m),
        }
    }
}

/// The shim's result once a checkpoint VM's `krun_start_enter` returned.
///
/// libkrun returns 0 whenever a started VM ended, so the guest's own exit
/// code comes from the final state, never from the status.
pub fn enter_result(status: i32, state: VmRunState) -> BoxliteResult<Option<i32>> {
    if status < 0 {
        return Err(BoxliteError::Engine(format!(
            "checkpoint VM failed to start (libkrun status={status}, state {state})"
        )));
    }
    match state {
        VmRunState::Exited(code) => Ok(Some(code)),
        VmRunState::Stopped => Ok(None),
        VmRunState::Failed => Err(BoxliteError::Engine(
            "checkpoint VM failed while running".to_string(),
        )),
        other => Err(BoxliteError::Internal(format!(
            "krun_start_enter returned while the VM was {other}"
        ))),
    }
}

#[cfg(test)]
pub(crate) mod fake;
#[cfg(test)]
mod tests;
