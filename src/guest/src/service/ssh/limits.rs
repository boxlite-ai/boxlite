//! Resource bounds for the guest SSH listener.
//!
//! A public direct tunnel means anyone who can reach the box's TCP port can
//! open a raw SSH connection before authenticating -- these bounds keep a
//! misbehaving or hostile peer from exhausting guest memory/FDs/tasks.

/// Concurrent SSH connections accepted at once.
pub(crate) const MAX_CONNECTIONS: usize = 128;

/// Concurrent channels within a single SSH connection.
pub(crate) const MAX_CHANNELS_PER_CONNECTION: usize = 16;

/// `env` requests accepted per channel before further ones are rejected.
pub(crate) const MAX_ENV_VARS: usize = 32;

/// Max length of an `env` variable name/value pair.
pub(crate) const MAX_ENV_VALUE_BYTES: usize = 4096;

/// Depth of the bounded stdin queue feeding a channel's exec/shell. Backpressure
/// beyond this drops frames rather than blocking the single-threaded per-connection
/// dispatcher (russh serializes all channel callbacks through one Handler).
pub(crate) const STDIN_QUEUE_DEPTH: usize = 32;

/// Deadline for any single control RPC to the in-process Execution service
/// (exec/kill/resize/wait-for-attach-setup). Guards against a wedged guest
/// process stalling an SSH channel forever.
pub(crate) const CONTROL_RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Max SSH_FXP_READ/WRITE length accepted per SFTP request. Mirrors
/// `backend::MAX_RW_CHUNK_BYTES` -- keep in sync so SFTP never asks the
/// filesystem backend for more than it will hand back in one call.
pub(crate) const MAX_SFTP_RW_BYTES: usize = crate::service::files::backend::MAX_RW_CHUNK_BYTES;

/// Concurrently open SFTP file/dir handles per SSH connection.
pub(crate) const MAX_SFTP_HANDLES_PER_CONNECTION: usize = 256;

/// Max entries accepted in one `Ssh.ReplaceAccessSet` call, bounding the
/// serialized guest snapshot size regardless of how many credentials the
/// Hosted API believes are active for this box.
pub(crate) const MAX_ACCESS_ENTRIES: usize = 256;
