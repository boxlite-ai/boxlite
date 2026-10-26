//! Meaning of libkrun's checkpoint C ABI results.
//!
//! Kept outside the `krun` feature so the mapping is unit-tested without
//! linking libkrun. The state numbers mirror `KRUN_SNAPSHOT_STATE_*` in
//! `libkrun.h`; the krun engine asserts at compile time that they match.

use super::protocol::{FailureKind, VmRunState};
use super::server::OwnerError;

pub const STATE_CONFIGURED: u32 = 0;
pub const STATE_STARTING: u32 = 1;
pub const STATE_RUNNING: u32 = 2;
pub const STATE_PAUSED: u32 = 3;
pub const STATE_EXITED: u32 = 4;
pub const STATE_FAILED: u32 = 5;
pub const STATE_STOPPED: u32 = 6;

/// Translate a `krun_snapshot_get_state` result. An unknown state number
/// means the library and this build disagree; report the VM as failed rather
/// than guess.
pub fn run_state(state: u32, exit_code: i32) -> VmRunState {
    match state {
        STATE_CONFIGURED => VmRunState::Configured,
        STATE_STARTING => VmRunState::Starting,
        STATE_RUNNING => VmRunState::Running,
        STATE_PAUSED => VmRunState::Paused,
        STATE_EXITED => VmRunState::Exited(exit_code),
        STATE_FAILED => VmRunState::Failed,
        STATE_STOPPED => VmRunState::Stopped,
        other => {
            tracing::error!(state = other, "unknown libkrun checkpoint state");
            VmRunState::Failed
        }
    }
}

/// Translate the status of a mutating call, given the state read after it.
///
/// `-EIO` is the only status where the request was performed and failed;
/// whether the VM survived is the state's to say: still paused after an
/// export is an ordinary I/O failure, anything else means the owner stopped
/// the VM.
pub fn call_result(op: &str, status: i32, after: VmRunState) -> Result<(), OwnerError> {
    if status >= 0 {
        return Ok(());
    }
    let (kind, why) = match -status {
        libc::EINVAL => (FailureKind::Rejected, "not valid now"),
        libc::EAGAIN => (FailureKind::Rejected, "the VM has not started yet"),
        libc::ESRCH => (FailureKind::Rejected, "the VM already ended"),
        libc::EIO if after == VmRunState::Paused => {
            (FailureKind::Io, "failed; the VM is still paused")
        }
        libc::EIO => (FailureKind::Failed, "failed and the VM was stopped"),
        _ => (FailureKind::Failed, "failed"),
    };
    let errno = std::io::Error::from_raw_os_error(-status);
    Err(OwnerError::new(
        kind,
        format!("{op}: {why} ({errno}); VM is {after}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_krun_results_keep_paused_export_failures_apart_from_stops() {
        assert_eq!(run_state(STATE_EXITED, 7), VmRunState::Exited(7));
        assert_eq!(run_state(STATE_PAUSED, 99), VmRunState::Paused);
        assert_eq!(run_state(42, 0), VmRunState::Failed);

        assert_eq!(call_result("export", 0, VmRunState::Paused), Ok(()));
        let kind = |status, after| call_result("export", status, after).unwrap_err().kind;
        assert_eq!(kind(-libc::EIO, VmRunState::Paused), FailureKind::Io);
        assert_eq!(kind(-libc::EIO, VmRunState::Stopped), FailureKind::Failed);
        assert_eq!(kind(-libc::EIO, VmRunState::Failed), FailureKind::Failed);
        assert_eq!(
            kind(-libc::EINVAL, VmRunState::Running),
            FailureKind::Rejected
        );
        assert_eq!(
            kind(-libc::EAGAIN, VmRunState::Configured),
            FailureKind::Rejected
        );
        assert_eq!(
            kind(-libc::ESRCH, VmRunState::Exited(0)),
            FailureKind::Rejected
        );
        assert_eq!(
            kind(-libc::ENOENT, VmRunState::Stopped),
            FailureKind::Failed
        );
        let message = call_result("pause", -libc::EIO, VmRunState::Stopped)
            .unwrap_err()
            .message;
        assert!(
            message.contains("pause") && message.contains("stopped"),
            "{message}"
        );
    }
}
