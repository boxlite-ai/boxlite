//! OCI container runtime
//!
//! This module provides an OCI-compliant container runtime using libcontainer.
//!
//! # Architecture
//!
//! - [`Container`]: OCI container lifecycle (create, start, check status)
//! - [`ContainerCommand`]: Builder for executing commands inside container
//! - [`crate::service::exec::exec_handle::ExecHandle`]: Handle to a running process
//!
//! # Example
//!
//! ```no_run
//! use guest::container::Container;
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! // Create and start container
//! let container = Container::start(
//!     "/rootfs",
//!     vec!["sh".to_string()],
//!     vec!["PATH=/bin:/usr/bin".to_string()],
//!     "/",
//! )?;
//!
//! // Execute command
//! let mut child = container
//!     .exec()
//!     .cmd("ls")
//!     .args(&["-la", "/tmp"])
//!     .env("FOO", "bar")
//!     .spawn()
//!     .await?;
//!
//! // Write to stdin
//! if let Some(stdin) = child.stdin() {
//!     stdin.write_all(b"hello\n").await?;
//! }
//!
//! // Stream stdout and stderr separately
//! use futures::StreamExt;
//! let stdout = child.stdout();
//! let stderr = child.stderr();
//!
//! // Spawn separate tasks for reading
//! tokio::spawn(async move {
//!     while let Some(line) = stdout.next().await {
//!         println!("out: {}", String::from_utf8_lossy(&line));
//!     }
//! });
//!
//! tokio::spawn(async move {
//!     while let Some(line) = stderr.next().await {
//!         eprintln!("err: {}", String::from_utf8_lossy(&line));
//!     }
//! });
//! # Ok(())
//! # }
//! ```

#[cfg(target_os = "linux")]
mod capabilities;
#[cfg(target_os = "linux")]
mod command;
#[cfg(target_os = "linux")]
mod console_socket;
#[cfg(target_os = "linux")]
mod kill;
#[cfg(target_os = "linux")]
mod lifecycle;
#[cfg(target_os = "linux")]
mod mount_override;
#[cfg(target_os = "linux")]
mod spec;
#[cfg(target_os = "linux")]
mod start;
#[cfg(target_os = "linux")]
mod stdio;
#[cfg(target_os = "linux")]
pub(crate) mod user_profile;
#[cfg(target_os = "linux")]
pub(crate) mod zygote;

#[cfg(target_os = "linux")]
pub(crate) use capabilities::CapabilitySet;
#[cfg(target_os = "linux")]
pub(crate) use command::SpawnResult;
#[cfg(target_os = "linux")]
pub use lifecycle::Container;
#[cfg(target_os = "linux")]
pub(crate) use mount_override::validate_mount_override;
#[cfg(target_os = "linux")]
pub use spec::{ContainerDevices, MountOverride, UserMount};
#[cfg(target_os = "linux")]
pub(crate) use zygote::CommandRejection;

use boxlite_shared::errors::BoxliteError;

/// Why a spawn produced no process.
///
/// The split is the whole point: [`Rejected`](Self::Rejected) is a POSIX
/// outcome for an exec (the command cannot run — 126/127), while
/// [`Failed`](Self::Failed) is a fault the caller should see as an error.
#[derive(Debug)]
pub(crate) enum SpawnFailure {
    Rejected(CommandRejection),
    Failed(BoxliteError),
}

impl From<BoxliteError> for SpawnFailure {
    fn from(error: BoxliteError) -> Self {
        Self::Failed(error)
    }
}

impl std::fmt::Display for SpawnFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(rejection) => f.write_str(&rejection.message),
            Self::Failed(error) => std::fmt::Display::fmt(error, f),
        }
    }
}

impl SpawnFailure {
    /// Collapse onto the error channel, for callers that have no POSIX
    /// outcome to report (an internal SSH workload that cannot start is a
    /// fault, not an exit status).
    pub(crate) fn into_error(self) -> BoxliteError {
        match self {
            Self::Rejected(rejection) => BoxliteError::Execution(rejection.message),
            Self::Failed(error) => error,
        }
    }
}
