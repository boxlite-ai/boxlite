//! Errors the execution core reports to any caller, transport or in-process.
//!
//! The core deals in these; `impl Execution for GuestServer` is the only place
//! that turns one into a `tonic::Status`. Keeping the discriminant typed is what
//! lets an in-process caller — the SSH server — branch on the reason without
//! matching on a rendered string.

use std::fmt;

#[derive(Debug)]
pub(crate) enum ExecutionError {
    /// No execution is registered under this id.
    NotFound(String),
    /// The execution exists but its process handle is already gone.
    HandleUnavailable,
    /// stdin was already taken by an earlier `send_input`.
    StdinTaken,
    /// stdout/stderr were already taken by an earlier `attach`.
    AlreadyAttached,
    /// The execution was not started with a PTY.
    NotAPty,
    /// Caller supplied a value the core cannot act on (bad signal, bad size).
    InvalidArgument(String),
    /// I/O against the process failed.
    Io(String),
    /// The caller's own input stream ended in error.
    ///
    /// Carries that error verbatim so the RPC adapter returns the peer's
    /// original status rather than flattening every stream failure to
    /// `Internal`. Only a transport-backed caller can produce this — the
    /// in-process path feeds an infallible stream and never constructs it.
    Input(Box<tonic::Status>),
}

impl fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(id) => write!(f, "execution not found: {id}"),
            Self::HandleUnavailable => write!(f, "execution handle is no longer available"),
            Self::StdinTaken => write!(f, "execution stdin was already taken"),
            Self::AlreadyAttached => write!(f, "execution output is already attached"),
            Self::NotAPty => write!(f, "execution was not started with a PTY"),
            Self::InvalidArgument(detail) => write!(f, "invalid argument: {detail}"),
            Self::Io(detail) => write!(f, "execution I/O failed: {detail}"),
            Self::Input(status) => write!(f, "execution input stream failed: {status}"),
        }
    }
}

impl std::error::Error for ExecutionError {}

impl From<ExecutionError> for tonic::Status {
    fn from(error: ExecutionError) -> Self {
        // The caller's own stream error goes back unchanged — re-coding it would
        // hide why the peer gave up.
        if let ExecutionError::Input(status) = error {
            return *status;
        }
        let message = error.to_string();
        match error {
            ExecutionError::NotFound(_) => tonic::Status::not_found(message),
            ExecutionError::HandleUnavailable | ExecutionError::NotAPty => {
                tonic::Status::failed_precondition(message)
            }
            ExecutionError::StdinTaken | ExecutionError::AlreadyAttached => {
                tonic::Status::already_exists(message)
            }
            ExecutionError::InvalidArgument(_) => tonic::Status::invalid_argument(message),
            ExecutionError::Io(_) => tonic::Status::internal(message),
            // Returned verbatim above; this arm is unreachable.
            ExecutionError::Input(status) => *status,
        }
    }
}
