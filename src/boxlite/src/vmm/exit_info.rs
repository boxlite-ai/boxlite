//! Exit information for shim process crashes.
//!
//! Provides structured JSON format for crash diagnostics.
//! Written by shim signal/panic handlers, read by guest_connect.
//!
//! ## Exit File Format (JSON)
//!
//! Signal crash:
//! ```json
//! {"exit_code":134,"type":"signal","signal":"SIGABRT"}
//! ```
//!
//! Panic:
//! ```json
//! {"exit_code":101,"type":"panic","message":"panic message","location":"file.rs:42:5"}
//! ```
//!
//! Note: Stderr content is captured separately in shim.stderr file (not embedded here).

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Exit information written to the exit file as JSON.
///
/// Three variants for different exit types:
/// - `Signal`: Process killed by signal (SIGABRT, SIGSEGV, etc.)
/// - `Panic`: Rust panic occurred
/// - `Error`: Normal error returned from instance.enter()
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ExitInfo {
    /// Process killed by a signal (SIGABRT, SIGSEGV, SIGBUS, SIGILL).
    Signal { exit_code: i32, signal: String },
    /// Rust panic occurred.
    Panic {
        exit_code: i32,
        message: String,
        location: String,
    },
    /// Normal error returned from shim (e.g., instance.enter() failed).
    Error { exit_code: i32, message: String },
}

impl ExitInfo {
    /// Parse exit info from a JSON file.
    ///
    /// Returns `None` if file doesn't exist or JSON is invalid.
    pub fn from_file(path: &Path) -> Option<Self> {
        let content = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&content).ok()
    }

    /// Get the exit code.
    pub fn exit_code(&self) -> i32 {
        match self {
            ExitInfo::Signal { exit_code, .. } => *exit_code,
            ExitInfo::Panic { exit_code, .. } => *exit_code,
            ExitInfo::Error { exit_code, .. } => *exit_code,
        }
    }

    /// Get the signal name if this is a signal crash.
    pub fn signal_name(&self) -> Option<&str> {
        match self {
            ExitInfo::Signal { signal, .. } => Some(signal),
            ExitInfo::Panic { .. } | ExitInfo::Error { .. } => None,
        }
    }

    /// Get the panic message if this is a panic.
    pub fn panic_message(&self) -> Option<&str> {
        match self {
            ExitInfo::Panic { message, .. } => Some(message),
            ExitInfo::Signal { .. } | ExitInfo::Error { .. } => None,
        }
    }

    /// Get the error message if this is an error.
    pub fn error_message(&self) -> Option<&str> {
        match self {
            ExitInfo::Error { message, .. } => Some(message),
            ExitInfo::Signal { .. } | ExitInfo::Panic { .. } => None,
        }
    }

    /// Check if this is a signal crash.
    pub fn is_signal(&self) -> bool {
        matches!(self, ExitInfo::Signal { .. })
    }

    /// Check if this is a panic.
    pub fn is_panic(&self) -> bool {
        matches!(self, ExitInfo::Panic { .. })
    }

    /// Check if this is an error.
    pub fn is_error(&self) -> bool {
        matches!(self, ExitInfo::Error { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_signal_serialization() {
        let info = ExitInfo::Signal {
            exit_code: 134,
            signal: "SIGABRT".to_string(),
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""type":"signal""#));
        assert!(json.contains(r#""exit_code":134"#));
        assert!(json.contains(r#""signal":"SIGABRT""#));

        let parsed: ExitInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.exit_code(), 134);
        assert_eq!(parsed.signal_name(), Some("SIGABRT"));
        assert!(parsed.is_signal());
    }

    #[test]
    fn test_panic_serialization() {
        let info = ExitInfo::Panic {
            exit_code: 101,
            message: "explicit panic".to_string(),
            location: "main.rs:42:5".to_string(),
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""type":"panic""#));
        assert!(json.contains(r#""exit_code":101"#));
        assert!(json.contains(r#""message":"explicit panic""#));

        let parsed: ExitInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.exit_code(), 101);
        assert_eq!(parsed.panic_message(), Some("explicit panic"));
        assert!(parsed.is_panic());
    }

    #[test]
    fn test_from_file_not_found() {
        let result = ExitInfo::from_file(Path::new("/nonexistent/path"));
        assert!(result.is_none());
    }

    #[test]
    fn test_from_file_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("exit");
        std::fs::write(&path, "not valid json").unwrap();

        let result = ExitInfo::from_file(&path);
        assert!(result.is_none());
    }

    #[test]
    fn test_from_file_valid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("exit");
        std::fs::write(
            &path,
            r#"{"type":"signal","exit_code":134,"signal":"SIGABRT"}"#,
        )
        .unwrap();

        let result = ExitInfo::from_file(&path);
        assert!(result.is_some());
        let info = result.unwrap();
        assert_eq!(info.exit_code(), 134);
        assert_eq!(info.signal_name(), Some("SIGABRT"));
    }

    #[test]
    fn test_error_serialization() {
        let info = ExitInfo::Error {
            exit_code: 1,
            message: "Failed to create VM instance".to_string(),
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""type":"error""#));
        assert!(json.contains(r#""exit_code":1"#));
        assert!(json.contains(r#""message":"Failed to create VM instance""#));

        let parsed: ExitInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.exit_code(), 1);
        assert_eq!(parsed.error_message(), Some("Failed to create VM instance"));
        assert!(parsed.is_error());
    }

    #[test]
    fn test_error_from_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("exit");
        std::fs::write(
            &path,
            r#"{"type":"error","exit_code":1,"message":"test error"}"#,
        )
        .unwrap();

        let result = ExitInfo::from_file(&path);
        assert!(result.is_some());
        let info = result.unwrap();
        assert_eq!(info.exit_code(), 1);
        assert_eq!(info.error_message(), Some("test error"));
        assert!(info.is_error());
    }
}
