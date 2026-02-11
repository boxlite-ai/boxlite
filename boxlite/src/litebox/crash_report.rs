//! Crash report formatting for user-friendly error messages.
//!
//! Transforms raw [`ExitInfo`] into human-readable crash reports
//! with context-aware troubleshooting suggestions.

use crate::vmm::ExitInfo;
use std::path::Path;

/// Formatted crash report for user-friendly error messages.
///
/// Combines parsed exit information with formatted messages suitable
/// for displaying to users.
#[derive(Debug)]
pub struct CrashReport {
    /// User-friendly error message with troubleshooting hints.
    pub user_message: String,
    /// Raw debug info (stderr content for signals).
    pub debug_info: String,
}

impl CrashReport {
    /// Create a crash report from exit file and context.
    ///
    /// Parses the JSON exit file and formats a user-friendly message
    /// with context-specific troubleshooting suggestions.
    ///
    /// # Arguments
    /// * `exit_file` - Path to the JSON exit file written by shim
    /// * `console_log` - Path to console log (for error message)
    /// * `stderr_file` - Path to stderr file (for error message)
    /// * `box_id` - Box identifier (for error message)
    pub fn from_exit_file(
        exit_file: &Path,
        console_log: &Path,
        stderr_file: &Path,
        box_id: &str,
    ) -> Self {
        let console_display = console_log.display();
        let stderr_display = stderr_file.display();

        // Try to parse JSON exit file
        let Some(info) = ExitInfo::from_file(exit_file) else {
            // No exit file or invalid JSON - generic message
            return Self {
                user_message: format!(
                    "Box {box_id} failed to start\n\n\
                     The VM exited unexpectedly.\n\n\
                     Common causes:\n\
                     • AppArmor or SELinux blocking execution\n\
                     • /dev/kvm permissions (Linux)\n\
                     • Missing Hypervisor entitlement (macOS)\n\n\
                     Debug files:\n\
                     • Console: {console_display}\n\n\
                     Tip: Check system logs (dmesg, Console.app)"
                ),
                debug_info: String::new(),
            };
        };

        // Extract debug info (stderr for signals, empty for panics)
        let debug_info = info.stderr().unwrap_or("").to_string();

        // Build user-friendly message based on crash type
        let mut user_message = match &info {
            ExitInfo::Signal { signal, .. } => match signal.as_str() {
                "SIGABRT" => format!(
                    "Box {box_id} failed to start: internal error (SIGABRT)\n\n\
                     The VM crashed during initialization.\n\n\
                     Common causes:\n\
                     • Missing or incompatible native libraries\n\
                     • Invalid VM configuration (memory, CPU)\n\
                     • Resource limits exceeded\n\n\
                     Debug files:\n\
                     • Console: {console_display}\n\
                     • Stderr:  {stderr_display}"
                ),
                "SIGSEGV" | "SIGBUS" => format!(
                    "Box {box_id} failed to start: memory error ({signal})\n\n\
                     The VM encountered a memory access error.\n\n\
                     Common causes:\n\
                     • Insufficient memory available\n\
                     • Library version mismatch\n\
                     • Corrupted binary or library\n\n\
                     Debug files:\n\
                     • Console: {console_display}\n\
                     • Stderr:  {stderr_display}"
                ),
                "SIGILL" => format!(
                    "Box {box_id} failed to start: invalid instruction (SIGILL)\n\n\
                     The VM encountered an unsupported CPU instruction.\n\n\
                     Common causes:\n\
                     • CPU compatibility issue\n\
                     • Binary compiled for different architecture\n\n\
                     Debug files:\n\
                     • Console: {console_display}\n\
                     • Stderr:  {stderr_display}"
                ),
                _ => format!(
                    "Box {box_id} failed to start\n\n\
                     The VM exited unexpectedly during startup.\n\n\
                     Debug files:\n\
                     • Console: {console_display}\n\
                     • Stderr:  {stderr_display}"
                ),
            },
            ExitInfo::Panic {
                message, location, ..
            } => format!(
                "Box {box_id} failed to start: panic\n\n\
                 The shim process panicked during initialization.\n\n\
                 Panic: {message}\n\
                 Location: {location}\n\n\
                 Debug files:\n\
                 • Console: {console_display}\n\
                 • Stderr:  {stderr_display}"
            ),
        };

        // Include brief debug info if available (first 5 lines)
        if !debug_info.is_empty() {
            let brief_debug: Vec<&str> = debug_info.lines().take(5).collect();
            user_message.push_str("\n\nError output:\n");
            user_message.push_str(&brief_debug.join("\n"));
            if debug_info.lines().count() > 5 {
                user_message.push_str("\n... (see stderr file for full output)");
            }
        }

        Self {
            user_message,
            debug_info,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_exit_file() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("nonexistent");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        let report =
            CrashReport::from_exit_file(&exit_file, &console_log, &stderr_file, "test-box");

        assert!(report.user_message.contains("test-box failed to start"));
        assert!(report.user_message.contains("VM exited unexpectedly"));
        assert!(report.debug_info.is_empty());
    }

    #[test]
    fn test_signal_crash() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        std::fs::write(
            &exit_file,
            r#"{"type":"signal","exit_code":134,"signal":"SIGABRT","stderr":"error details"}"#,
        )
        .unwrap();

        let report =
            CrashReport::from_exit_file(&exit_file, &console_log, &stderr_file, "test-box");

        assert!(report.user_message.contains("SIGABRT"));
        assert!(report.user_message.contains("internal error"));
        assert_eq!(report.debug_info, "error details");
    }

    #[test]
    fn test_panic_crash() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        std::fs::write(
            &exit_file,
            r#"{"type":"panic","exit_code":101,"message":"assertion failed","location":"main.rs:42:5"}"#,
        )
        .unwrap();

        let report =
            CrashReport::from_exit_file(&exit_file, &console_log, &stderr_file, "test-box");

        assert!(report.user_message.contains("panic"));
        assert!(report.user_message.contains("assertion failed"));
        assert!(report.user_message.contains("main.rs:42:5"));
    }

    #[test]
    fn test_debug_info_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        // Create stderr with more than 5 lines
        let long_stderr = (1..=10)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");

        std::fs::write(
            &exit_file,
            format!(
                r#"{{"type":"signal","exit_code":134,"signal":"SIGABRT","stderr":"{}"}}"#,
                long_stderr.replace('\n', "\\n")
            ),
        )
        .unwrap();

        let report =
            CrashReport::from_exit_file(&exit_file, &console_log, &stderr_file, "test-box");

        assert!(report.user_message.contains("line 1"));
        assert!(report.user_message.contains("line 5"));
        assert!(
            report
                .user_message
                .contains("... (see stderr file for full output)")
        );
        assert!(!report.user_message.contains("line 6")); // Truncated
    }
}
