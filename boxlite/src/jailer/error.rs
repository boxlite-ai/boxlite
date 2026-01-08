//! Hierarchical error types for the jailer module.
//!
//! Errors are categorized by recovery path:
//! - [`IsolationError`]: Isolation layer setup failures (usually fatal)
//! - [`SystemError`]: System-level operations (potentially recoverable)
//! - [`ConfigError`]: Configuration/validation issues (user-fixable)

use std::io;
use thiserror::Error;

// ============================================================================
// Top-Level Error
// ============================================================================

/// Errors that can occur during jailer operations.
///
/// Categorized into sub-enums for easier error handling:
/// ```ignore
/// match jailer::apply(..) {
///     Err(JailerError::Isolation(_)) => { /* fatal, abort */ }
///     Err(JailerError::System(_)) => { /* maybe retry */ }
///     Err(JailerError::Config(_)) => { /* user should fix config */ }
///     _ => {}
/// }
/// ```
#[derive(Debug, Error)]
pub enum JailerError {
    /// Isolation layer setup failed (likely fatal).
    #[error("isolation: {0}")]
    Isolation(#[from] IsolationError),

    /// System-level operation failed (may be recoverable).
    #[error("system: {0}")]
    System(#[from] SystemError),

    /// Configuration or validation error (user-fixable).
    #[error("config: {0}")]
    Config(#[from] ConfigError),

    /// Platform not supported for jailer isolation.
    #[error("jailer not supported on this platform")]
    UnsupportedPlatform,

    /// Cgroup operation failed.
    #[error("cgroup: {0}")]
    Cgroup(String),

    /// Generic IO error (catch-all).
    #[error("io: {0}")]
    Io(#[from] io::Error),
}

// ============================================================================
// Isolation Errors (Linux namespace/chroot/seccomp, usually fatal)
// ============================================================================

/// Errors during isolation layer setup.
///
/// These typically indicate the sandbox cannot be established
/// and the process should abort.
#[derive(Debug, Error)]
pub enum IsolationError {
    /// Failed to create a Linux namespace.
    #[error("{namespace} namespace: {source}")]
    Namespace {
        namespace: &'static str,
        #[source]
        source: io::Error,
    },

    /// Failed to setup chroot jail.
    #[error("chroot at {path}: {source}")]
    Chroot {
        path: String,
        #[source]
        source: io::Error,
    },

    /// Failed to pivot root filesystem.
    #[error("pivot_root: {0}")]
    PivotRoot(#[source] io::Error),

    /// Failed to create device node in jail.
    #[error("device node {path}: {source}")]
    DeviceNode {
        path: String,
        #[source]
        source: io::Error,
    },

    /// Failed to apply seccomp syscall filter.
    #[error("seccomp: {0}")]
    Seccomp(String),

    /// Failed to setup cgroup resource limits.
    #[error("cgroup: {0}")]
    Cgroup(String),
}

// ============================================================================
// System Errors (FD cleanup, rlimits, privilege drop)
// ============================================================================

/// Errors during system-level operations.
///
/// These may be recoverable depending on the specific operation.
#[derive(Debug, Error)]
pub enum SystemError {
    /// Failed to close inherited file descriptors.
    #[error("close fds: {0}")]
    CloseFds(#[source] io::Error),

    /// Failed to set resource limit.
    #[error("rlimit {resource}: {source}")]
    Rlimit {
        resource: &'static str,
        #[source]
        source: io::Error,
    },

    /// Failed to drop privileges to unprivileged user.
    #[error("privilege drop to {uid}:{gid}: {source}")]
    PrivilegeDrop {
        uid: u32,
        gid: u32,
        #[source]
        source: io::Error,
    },
}

// ============================================================================
// Config Errors (sandbox profile, validation)
// ============================================================================

/// Errors related to configuration or validation.
///
/// These are typically user-fixable by adjusting the configuration.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// Failed to apply macOS sandbox profile.
    #[error("sandbox profile: {0}")]
    SandboxProfile(String),

    /// Sandbox profile file not found.
    #[error("profile not found: {0}")]
    ProfileNotFound(String),

    /// Invalid security configuration.
    #[error("invalid config: {0}")]
    InvalidConfig(String),
}

// ============================================================================
// Conversions
// ============================================================================

impl From<JailerError> for boxlite_shared::errors::BoxliteError {
    fn from(err: JailerError) -> Self {
        boxlite_shared::errors::BoxliteError::Engine(err.to_string())
    }
}

// ============================================================================
// Convenience Constructors
// ============================================================================

impl IsolationError {
    /// Create a namespace error.
    pub fn namespace(ns: &'static str, source: io::Error) -> Self {
        Self::Namespace {
            namespace: ns,
            source,
        }
    }

    /// Create a chroot error.
    pub fn chroot(path: impl Into<String>, source: io::Error) -> Self {
        Self::Chroot {
            path: path.into(),
            source,
        }
    }

    /// Create a device node error.
    pub fn device_node(path: impl Into<String>, source: io::Error) -> Self {
        Self::DeviceNode {
            path: path.into(),
            source,
        }
    }
}

impl SystemError {
    /// Create an rlimit error.
    pub fn rlimit(resource: &'static str, source: io::Error) -> Self {
        Self::Rlimit { resource, source }
    }

    /// Create a privilege drop error.
    pub fn privilege_drop(uid: u32, gid: u32, source: io::Error) -> Self {
        Self::PrivilegeDrop { uid, gid, source }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_hierarchy() {
        // IsolationError -> JailerError
        let iso_err = IsolationError::Seccomp("test".into());
        let jailer_err: JailerError = iso_err.into();
        assert!(matches!(jailer_err, JailerError::Isolation(_)));

        // SystemError -> JailerError
        let sys_err = SystemError::CloseFds(io::Error::other("test"));
        let jailer_err: JailerError = sys_err.into();
        assert!(matches!(jailer_err, JailerError::System(_)));

        // ConfigError -> JailerError
        let cfg_err = ConfigError::ProfileNotFound("/path".into());
        let jailer_err: JailerError = cfg_err.into();
        assert!(matches!(jailer_err, JailerError::Config(_)));
    }

    #[test]
    fn test_error_display() {
        let err = JailerError::Isolation(IsolationError::Seccomp("blocked syscall".into()));
        assert_eq!(err.to_string(), "isolation: seccomp: blocked syscall");

        let err = JailerError::System(SystemError::rlimit(
            "RLIMIT_NOFILE",
            io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
        ));
        assert!(err.to_string().contains("rlimit RLIMIT_NOFILE"));
    }

    #[test]
    fn test_boxlite_error_conversion() {
        let err = JailerError::UnsupportedPlatform;
        let boxlite_err: boxlite_shared::errors::BoxliteError = err.into();
        assert!(boxlite_err.to_string().contains("not supported"));
    }
}
