//! Resource bounds for the guest SSH listener.

use std::time::Duration;

pub(crate) const MAX_CONNECTIONS: usize = 128;
pub(crate) const MAX_CHANNELS_PER_CONNECTION: usize = 16;
pub(crate) const MAX_ENV_VARS: usize = 32;
pub(crate) const MAX_ENV_NAME_BYTES: usize = 256;
pub(crate) const MAX_ENV_VALUE_BYTES: usize = 4096;
pub(crate) const MAX_TERM_BYTES: usize = 256;
pub(crate) const MAX_COMMAND_BYTES: usize = 64 * 1024;
pub(crate) const MAX_FORWARD_HOST_BYTES: usize = 253;
// Linux sockaddr_un::sun_path is 108 bytes including its trailing NUL.
pub(crate) const MAX_STREAMLOCAL_PATH_BYTES: usize = 107;
pub(crate) const MAX_REMOTE_FORWARD_LISTENERS: usize = 16;
pub(crate) const MAX_FORWARD_CONNECTIONS: usize = 64;
pub(crate) const MAX_SFTP_HANDLES: usize = 256;
pub(crate) const MAX_SFTP_READ_BYTES: usize = 256 * 1024;
pub(crate) const MAX_SFTP_DIRECTORY_ENTRIES: usize = 128;
pub(crate) const STDIN_QUEUE_DEPTH: usize = 32;
pub(crate) const CONTROL_CALL_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const PROCESS_TERMINATION_GRACE: Duration = Duration::from_secs(1);
pub(crate) const FORWARD_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const DISCONNECT_GRACE_TIMEOUT: Duration = Duration::from_secs(1);
