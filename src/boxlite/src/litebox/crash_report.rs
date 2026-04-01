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
    /// * `exit_code` - Exit code from waitpid (if available)
    pub fn from_exit_file(
        exit_file: &Path,
        console_log: &Path,
        stderr_file: &Path,
        box_id: &str,
        exit_code: Option<i32>,
    ) -> Self {
        let console_display = console_log.display();
        let stderr_display = stderr_file.display();

        // Always read stderr file (contains pre-main dyld errors too)
        let stderr_content = std::fs::read_to_string(stderr_file)
            .unwrap_or_default()
            .trim()
            .to_string();

        // Try to parse JSON exit file
        let Some(info) = ExitInfo::from_file(exit_file) else {
            // No exit file - use exit code and raw stderr content
            return Self::from_raw_exit(
                box_id,
                exit_code,
                &stderr_content,
                console_log,
                stderr_file,
            );
        };

        // Use stderr_content we already read from file (single source of truth)
        let debug_info = stderr_content;

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
                "SIGSYS" => format!(
                    "Box {box_id} failed to start: seccomp violation (SIGSYS)\n\n\
                     The VM was killed by a seccomp filter blocking a required syscall.\n\n\
                     Common causes:\n\
                     • Seccomp filter missing syscalls needed by gvproxy (Go runtime)\n\
                     • Custom seccomp profile too restrictive\n\n\
                     Debug files:\n\
                     • Console: {console_display}\n\
                     • Stderr:  {stderr_display}\n\n\
                     Tip: Run with RUST_LOG=debug or strace to identify the blocked syscall"
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
            ExitInfo::Error { message, .. } => format!(
                "Box {box_id} failed to start: error\n\n\
                 The shim process exited with an error.\n\n\
                 Error: {message}\n\n\
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

    /// Create crash report when no exit file exists (pre-main crash).
    ///
    /// Uses exit code and raw stderr content to provide diagnostic info.
    fn from_raw_exit(
        box_id: &str,
        exit_code: Option<i32>,
        stderr_content: &str,
        console_log: &Path,
        stderr_file: &Path,
    ) -> Self {
        let mut msg = format!("Box {box_id} failed to start\n\n");

        let console_analysis = analyze_console_log(console_log);

        // Add exit code with signal interpretation
        match exit_code {
            Some(0) => {
                msg.push_str("Exit code: 0 (clean shutdown)\n\n");
                msg.push_str(
                    "The VM started but the guest agent exited immediately.\n\
                     Common causes:\n\
                     • Guest binary (boxlite-guest) crashed before producing output\n\
                     • Guest binary not found inside the rootfs\n\
                     • Rootfs disk image corrupted or unmountable\n",
                );
            }
            Some(code) if code > 128 => {
                let signal = code - 128;
                let signal_name = match signal {
                    6 => "SIGABRT",
                    9 => "SIGKILL",
                    11 => "SIGSEGV",
                    15 => "SIGTERM",
                    _ => "unknown signal",
                };
                msg.push_str(&format!("Exit code: {code} ({signal_name})\n"));
            }
            Some(code) => {
                msg.push_str(&format!("Exit code: {code}\n"));
            }
            None => {
                msg.push_str("Exit code: unknown\n");
            }
        }
        msg.push('\n');

        // Add console.log analysis
        match console_analysis {
            ConsoleAnalysis::Empty => {
                msg.push_str("Console output: empty (no kernel or guest messages captured)\n\n");
            }
            ConsoleAnalysis::KernelOnly => {
                msg.push_str(
                    "Console output: kernel messages only (guest agent never started)\n\n",
                );
            }
            ConsoleAnalysis::HasGuestOutput => {
                // Guest started — console.log has useful info, don't add extra annotation
            }
            ConsoleAnalysis::Unreadable => {
                // Can't read the file — skip annotation
            }
        }

        // Add stderr content if available (includes dyld errors)
        if !stderr_content.is_empty() {
            msg.push_str("Shim stderr:\n");
            msg.push_str(&truncate_lines(stderr_content, 15));
            msg.push_str("\n\n");
        }

        msg.push_str(&format!(
            "Debug files:\n\
             • Console: {}\n\
             • Stderr: {}\n\n\
             Diagnostic commands:\n\
             • RUST_LOG=debug boxlite run ...   (re-run with tracing)\n\
             • dmesg | tail -50                 (kernel messages)\n\
             • file $(which boxlite-guest)      (check binary arch)",
            console_log.display(),
            stderr_file.display()
        ));

        Self {
            user_message: msg,
            debug_info: stderr_content.to_string(),
        }
    }
}

/// Result of analyzing the console.log file content.
enum ConsoleAnalysis {
    /// File is empty (0 bytes) — kernel never produced output.
    Empty,
    /// Has kernel messages but no guest agent output.
    KernelOnly,
    /// Guest agent produced output (contains `[guest]` marker).
    HasGuestOutput,
    /// File could not be read.
    Unreadable,
}

/// Analyze console.log to determine what output was captured.
fn analyze_console_log(path: &Path) -> ConsoleAnalysis {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return ConsoleAnalysis::Unreadable,
    };

    if metadata.len() == 0 {
        return ConsoleAnalysis::Empty;
    }

    match std::fs::read_to_string(path) {
        Ok(content) => {
            if content.contains("[guest]") {
                ConsoleAnalysis::HasGuestOutput
            } else {
                ConsoleAnalysis::KernelOnly
            }
        }
        Err(_) => ConsoleAnalysis::Unreadable,
    }
}

/// Truncate content to max_lines, showing count of remaining lines.
fn truncate_lines(content: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = content.lines().take(max_lines).collect();
    let truncated = lines.join("\n");
    let total_lines = content.lines().count();
    if total_lines > max_lines {
        format!("{truncated}\n... ({} more lines)", total_lines - max_lines)
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_exit_file_with_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("nonexistent");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        // Create stderr file with content
        std::fs::write(&stderr_file, "dyld: Library not loaded").unwrap();

        let report = CrashReport::from_exit_file(
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Some(1),
        );

        assert!(report.user_message.contains("test-box failed to start"));
        assert!(report.user_message.contains("Exit code: 1"));
        assert!(report.user_message.contains("dyld: Library not loaded"));
        assert!(report.user_message.contains("Diagnostic commands"));
    }

    #[test]
    fn test_no_exit_file_with_signal_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("nonexistent");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        let report = CrashReport::from_exit_file(
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Some(134), // 128 + 6 (SIGABRT)
        );

        assert!(report.user_message.contains("Exit code: 134 (SIGABRT)"));
    }

    #[test]
    fn test_signal_crash() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        // Exit file no longer contains stderr - it's read from stderr_file
        std::fs::write(
            &exit_file,
            r#"{"type":"signal","exit_code":134,"signal":"SIGABRT"}"#,
        )
        .unwrap();
        std::fs::write(&stderr_file, "error details").unwrap();

        let report = CrashReport::from_exit_file(
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Some(134),
        );

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

        let report = CrashReport::from_exit_file(
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Some(101),
        );

        assert!(report.user_message.contains("panic"));
        assert!(report.user_message.contains("assertion failed"));
        assert!(report.user_message.contains("main.rs:42:5"));
    }

    #[test]
    fn test_error_crash() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        std::fs::write(
            &exit_file,
            r#"{"type":"error","exit_code":1,"message":"Failed to create VM instance"}"#,
        )
        .unwrap();

        let report = CrashReport::from_exit_file(
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Some(1),
        );

        assert!(report.user_message.contains("error"));
        assert!(report.user_message.contains("Failed to create VM instance"));
    }

    #[test]
    fn test_sigsys_crash() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        std::fs::write(
            &exit_file,
            r#"{"type":"signal","exit_code":159,"signal":"SIGSYS","stderr":""}"#,
        )
        .unwrap();

        let report = CrashReport::from_exit_file(
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Some(159),
        );

        assert!(report.user_message.contains("SIGSYS"));
        assert!(report.user_message.contains("seccomp violation"));
        assert!(report.user_message.contains("strace"));
    }

    #[test]
    fn test_debug_info_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        // Create stderr file with more than 5 lines (stderr is read from file, not exit file)
        let long_stderr = (1..=10)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");

        std::fs::write(
            &exit_file,
            r#"{"type":"signal","exit_code":134,"signal":"SIGABRT"}"#,
        )
        .unwrap();
        std::fs::write(&stderr_file, &long_stderr).unwrap();

        let report = CrashReport::from_exit_file(
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Some(134),
        );

        assert!(report.user_message.contains("line 1"));
        assert!(report.user_message.contains("line 5"));
        assert!(
            report
                .user_message
                .contains("... (see stderr file for full output)")
        );
        assert!(!report.user_message.contains("line 6")); // Truncated
    }

    #[test]
    fn test_truncate_lines() {
        let content = "line1\nline2\nline3\nline4\nline5";
        assert_eq!(
            truncate_lines(content, 3),
            "line1\nline2\nline3\n... (2 more lines)"
        );
        assert_eq!(truncate_lines(content, 10), content);
    }

    #[test]
    fn test_exit_code_zero_with_empty_console() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("nonexistent");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        // Empty console.log
        std::fs::write(&console_log, "").unwrap();
        std::fs::write(&stderr_file, "").unwrap();

        let report = CrashReport::from_exit_file(
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Some(0),
        );

        assert!(
            report
                .user_message
                .contains("Exit code: 0 (clean shutdown)")
        );
        assert!(
            report
                .user_message
                .contains("guest agent exited immediately")
        );
        assert!(report.user_message.contains("Console output: empty"));
        assert!(report.user_message.contains("Diagnostic commands"));
    }

    #[test]
    fn test_exit_code_zero_with_kernel_only_console() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("nonexistent");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        std::fs::write(&console_log, "Linux version 6.8.0\nBooting kernel...\n").unwrap();
        std::fs::write(&stderr_file, "").unwrap();

        let report = CrashReport::from_exit_file(
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Some(0),
        );

        assert!(
            report
                .user_message
                .contains("Exit code: 0 (clean shutdown)")
        );
        assert!(report.user_message.contains("kernel messages only"));
    }

    #[test]
    fn test_exit_code_zero_with_guest_output() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("nonexistent");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("stderr");

        std::fs::write(&console_log, "[guest] T+0ms: agent starting\n").unwrap();
        std::fs::write(&stderr_file, "").unwrap();

        let report = CrashReport::from_exit_file(
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Some(0),
        );

        assert!(
            report
                .user_message
                .contains("Exit code: 0 (clean shutdown)")
        );
        // Should NOT contain the empty/kernel annotations
        assert!(!report.user_message.contains("Console output:"));
    }

    #[test]
    fn test_analyze_console_log_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("console.log");
        std::fs::write(&path, "").unwrap();
        assert!(matches!(analyze_console_log(&path), ConsoleAnalysis::Empty));
    }

    #[test]
    fn test_analyze_console_log_kernel_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("console.log");
        std::fs::write(&path, "Linux version 6.8.0\n").unwrap();
        assert!(matches!(
            analyze_console_log(&path),
            ConsoleAnalysis::KernelOnly
        ));
    }

    #[test]
    fn test_analyze_console_log_has_guest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("console.log");
        std::fs::write(&path, "[guest] T+0ms: agent starting\n").unwrap();
        assert!(matches!(
            analyze_console_log(&path),
            ConsoleAnalysis::HasGuestOutput
        ));
    }

    #[test]
    fn test_analyze_console_log_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent");
        assert!(matches!(
            analyze_console_log(&path),
            ConsoleAnalysis::Unreadable
        ));
    }
}
