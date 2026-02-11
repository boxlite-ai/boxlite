//! Exit information for shim process crashes.
//!
//! Provides structured JSON format for crash diagnostics.
//! Written by shim signal/panic handlers, read by guest_connect.
//!
//! ## Exit File Format (JSON)
//!
//! Signal crash:
//! ```json
//! {"exit_code":134,"type":"signal","signal":"SIGABRT","stderr":"error message..."}
//! ```
//!
//! Panic:
//! ```json
//! {"exit_code":101,"type":"panic","message":"panic message","location":"file.rs:42:5"}
//! ```

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Exit information written to the exit file as JSON.
///
/// Two variants for different crash types:
/// - `Signal`: Process killed by signal (SIGABRT, SIGSEGV, etc.)
/// - `Panic`: Rust panic occurred
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ExitInfo {
    /// Process killed by a signal (SIGABRT, SIGSEGV, SIGBUS, SIGILL).
    Signal {
        exit_code: i32,
        signal: String,
        stderr: String,
    },
    /// Rust panic occurred.
    Panic {
        exit_code: i32,
        message: String,
        location: String,
    },
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
        }
    }

    /// Get the signal name if this is a signal crash.
    pub fn signal_name(&self) -> Option<&str> {
        match self {
            ExitInfo::Signal { signal, .. } => Some(signal),
            ExitInfo::Panic { .. } => None,
        }
    }

    /// Get the panic message if this is a panic.
    pub fn panic_message(&self) -> Option<&str> {
        match self {
            ExitInfo::Signal { .. } => None,
            ExitInfo::Panic { message, .. } => Some(message),
        }
    }

    /// Get the stderr content (for signal crashes).
    pub fn stderr(&self) -> Option<&str> {
        match self {
            ExitInfo::Signal { stderr, .. } => Some(stderr),
            ExitInfo::Panic { .. } => None,
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_signal_serialization() {
        let info = ExitInfo::Signal {
            exit_code: 134,
            signal: "SIGABRT".to_string(),
            stderr: "error message".to_string(),
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
            r#"{"type":"signal","exit_code":134,"signal":"SIGABRT","stderr":"test"}"#,
        )
        .unwrap();

        let result = ExitInfo::from_file(&path);
        assert!(result.is_some());
        let info = result.unwrap();
        assert_eq!(info.exit_code(), 134);
        assert_eq!(info.signal_name(), Some("SIGABRT"));
    }
}
