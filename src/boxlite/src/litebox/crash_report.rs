//! Crash report formatting, split by audience.
//!
//! Transforms raw [`ExitInfo`] into a terse client-facing sentence and a rich
//! operator report. Only the former may cross the API boundary — see
//! [`CrashReport`] and [`crate::util`]'s diagnostic module for why.

use crate::vmm::{ExitInfo, exit_info::ExitErrorKind};
use std::path::Path;

/// A box-start failure, split by audience.
///
/// The same crash has two readers with opposite needs. An engineer on the host
/// wants the console path, the shim stderr and the exit code; an API tenant must
/// see none of it — those paths are on someone else's machine. So the rich text
/// is not discarded, it is *routed*: callers log [`operator_report`] and pass
/// only [`client_message`] to the `BoxliteError` payload that crosses the wire.
///
/// [`operator_report`]: CrashReport::operator_report
/// [`client_message`]: CrashReport::client_message
#[derive(Debug)]
pub struct CrashReport {
    /// Terse, caller-safe sentence. The only field allowed past the API boundary.
    pub client_message: String,
    /// Full diagnostic: paths, shim stderr, exit code, troubleshooting hints.
    /// Log this; never return it to a caller.
    pub operator_report: String,
    /// Category the shim recorded, so callers can pick the matching
    /// [`BoxliteError`](boxlite_shared::errors::BoxliteError) variant.
    pub error_kind: ExitErrorKind,
}

impl CrashReport {
    /// Create a crash report from exit file and context.
    ///
    /// Parses the JSON exit file and formats both audiences' messages with
    /// context-specific troubleshooting suggestions.
    ///
    /// # Arguments
    /// * `exit_file` - Path to the JSON exit file written by shim
    /// * `console_log` - Path to console log (operator report only)
    /// * `stderr_file` - Path to stderr file (operator report only)
    /// * `box_id` - Box identifier (operator report only)
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

        // Build both audiences' messages based on crash type.
        let (client_message, mut operator_report) = match &info {
            ExitInfo::Signal { signal, .. } => match signal.as_str() {
                "SIGABRT" => (
                    "The VM failed to start: internal error (SIGABRT).".to_string(),
                    format!(
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
                ),
                "SIGSEGV" | "SIGBUS" => (
                    format!("The VM failed to start: memory error ({signal})."),
                    format!(
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
                ),
                "SIGILL" => (
                    "The VM failed to start: invalid instruction (SIGILL).".to_string(),
                    format!(
                        "Box {box_id} failed to start: invalid instruction (SIGILL)\n\n\
                         The VM encountered an unsupported CPU instruction.\n\n\
                         Common causes:\n\
                         • CPU compatibility issue\n\
                         • Binary compiled for different architecture\n\n\
                         Debug files:\n\
                         • Console: {console_display}\n\
                         • Stderr:  {stderr_display}"
                    ),
                ),
                "SIGSYS" => (
                    "The VM failed to start: seccomp violation (SIGSYS).".to_string(),
                    format!(
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
                ),
                _ => (
                    "The VM failed to start.".to_string(),
                    format!(
                        "Box {box_id} failed to start\n\n\
                         The VM exited unexpectedly during startup.\n\n\
                         Debug files:\n\
                         • Console: {console_display}\n\
                         • Stderr:  {stderr_display}"
                    ),
                ),
            },
            ExitInfo::Panic {
                message, location, ..
            } => (
                // The panic message and its source location name BoxLite
                // internals, so they stay operator-side.
                "The VM failed to start: internal panic.".to_string(),
                format!(
                    "Box {box_id} failed to start: panic\n\n\
                     The shim process panicked during initialization.\n\n\
                     Panic: {message}\n\
                     Location: {location}\n\n\
                     Debug files:\n\
                     • Console: {console_display}\n\
                     • Stderr:  {stderr_display}"
                ),
            ),
            ExitInfo::Error {
                message,
                error_kind,
                ..
            } => (
                // `Unsupported` is the one category whose text is curated for
                // callers — a host-capability statement ("nested virtualization
                // is unavailable") with no path, command or component in it.
                // See `ExitErrorKind::of`. Everything else is an engine failure
                // whose text is shim-internal.
                match error_kind {
                    ExitErrorKind::Unsupported => format!("Unsupported host capability: {message}"),
                    ExitErrorKind::Engine => "The VM failed to start.".to_string(),
                },
                format!(
                    "Box {box_id} failed to start: error\n\n\
                     The shim process exited with an error.\n\n\
                     Error: {message}\n\n\
                     Debug files:\n\
                     • Console: {console_display}\n\
                     • Stderr:  {stderr_display}"
                ),
            ),
        };

        // Include brief debug info if available (first 5 lines)
        if !stderr_content.is_empty() {
            let brief_debug: Vec<&str> = stderr_content.lines().take(5).collect();
            operator_report.push_str("\n\nError output:\n");
            operator_report.push_str(&brief_debug.join("\n"));
            if stderr_content.lines().count() > 5 {
                operator_report.push_str("\n... (see stderr file for full output)");
            }
        }

        Self {
            client_message,
            operator_report,
            error_kind: info.error_kind(),
        }
    }

    /// Create crash report when no exit file exists (pre-main crash).
    ///
    /// Uses exit code and raw stderr content to build the operator report. The
    /// client message stays generic: nothing about a pre-main crash is
    /// actionable without host access.
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
            client_message: "The VM failed to start.".to_string(),
            operator_report: msg,
            // No exit file means the shim died before it could categorize.
            error_kind: ExitErrorKind::Engine,
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

        assert!(report.operator_report.contains("test-box failed to start"));
        assert!(!report.client_message.contains("test-box"));
        assert!(report.operator_report.contains("Exit code: 1"));
        assert!(report.operator_report.contains("dyld: Library not loaded"));
        assert!(report.operator_report.contains("Diagnostic commands"));
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

        assert!(report.operator_report.contains("Exit code: 134 (SIGABRT)"));
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

        assert!(report.client_message.contains("SIGABRT"));
        assert!(report.client_message.contains("internal error"));
        assert!(report.operator_report.contains("error details"));
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

        assert!(report.client_message.contains("panic"));
        // Panic text and source location stay operator-side.
        assert!(report.operator_report.contains("assertion failed"));
        assert!(report.operator_report.contains("main.rs:42:5"));
        assert!(!report.client_message.contains("main.rs:42:5"));
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

        assert!(report.operator_report.contains("error"));
        assert!(
            report
                .operator_report
                .contains("Failed to create VM instance")
        );
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

        assert!(report.client_message.contains("SIGSYS"));
        assert!(report.client_message.contains("seccomp violation"));
        // The strace hint needs a host shell — operator-side only.
        assert!(report.operator_report.contains("strace"));
        assert!(!report.client_message.contains("strace"));
    }

    #[test]
    fn test_stderr_truncation_in_operator_report() {
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

        assert!(report.operator_report.contains("line 1"));
        assert!(report.operator_report.contains("line 5"));
        assert!(
            report
                .operator_report
                .contains("... (see stderr file for full output)")
        );
        assert!(!report.operator_report.contains("line 6")); // Truncated
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
                .operator_report
                .contains("Exit code: 0 (clean shutdown)")
        );
        assert!(
            report
                .operator_report
                .contains("guest agent exited immediately")
        );
        assert!(report.operator_report.contains("Console output: empty"));
        assert!(report.operator_report.contains("Diagnostic commands"));
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
                .operator_report
                .contains("Exit code: 0 (clean shutdown)")
        );
        assert!(report.operator_report.contains("kernel messages only"));
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
                .operator_report
                .contains("Exit code: 0 (clean shutdown)")
        );
        // Should NOT contain the empty/kernel annotations
        assert!(!report.operator_report.contains("Console output:"));
    }

    /// Every crash-report template must keep host diagnostics out of the
    /// client-facing message. Regression guard for POL-329, where the 400 body
    /// of `POST /v1/boxes` carried console paths, shim stderr and `dmesg`.
    #[test]
    fn test_client_message_never_leaks_host_diagnostics() {
        // (label, exit-file JSON or None for the no-exit-file path, exit code)
        let cases: &[(&str, Option<&str>, Option<i32>)] = &[
            (
                "sigabrt",
                Some(r#"{"type":"signal","exit_code":134,"signal":"SIGABRT"}"#),
                Some(134),
            ),
            (
                "sigsegv",
                Some(r#"{"type":"signal","exit_code":139,"signal":"SIGSEGV"}"#),
                Some(139),
            ),
            (
                "sigbus",
                Some(r#"{"type":"signal","exit_code":138,"signal":"SIGBUS"}"#),
                Some(138),
            ),
            (
                "sigill",
                Some(r#"{"type":"signal","exit_code":132,"signal":"SIGILL"}"#),
                Some(132),
            ),
            (
                "sigsys",
                Some(r#"{"type":"signal","exit_code":159,"signal":"SIGSYS"}"#),
                Some(159),
            ),
            (
                "signal_other",
                Some(r#"{"type":"signal","exit_code":143,"signal":"SIGTERM"}"#),
                Some(143),
            ),
            (
                "panic",
                Some(
                    r#"{"type":"panic","exit_code":101,"message":"assertion failed","location":"/home/dev/src/main.rs:42:5"}"#,
                ),
                Some(101),
            ),
            (
                "error_engine",
                Some(r#"{"type":"error","exit_code":1,"message":"Failed to create VM instance"}"#),
                Some(1),
            ),
            (
                "error_unsupported",
                Some(
                    r#"{"type":"error","exit_code":1,"message":"nested virtualization is unavailable","error_kind":"unsupported"}"#,
                ),
                Some(1),
            ),
            ("no_exit_file", None, Some(159)),
            ("no_exit_file_clean", None, Some(0)),
            ("no_exit_file_unknown_code", None, None),
        ];

        for (label, exit_json, exit_code) in cases {
            let dir = tempfile::tempdir().unwrap();
            let exit_file = dir.path().join("exit");
            let console_log = dir.path().join("logs").join("console.log");
            let stderr_file = dir.path().join("shim.stderr");
            std::fs::create_dir_all(console_log.parent().unwrap()).unwrap();

            if let Some(json) = exit_json {
                std::fs::write(&exit_file, json).unwrap();
            }
            // Shim stderr as it looks in production: internal component timing.
            std::fs::write(
                &stderr_file,
                "[shim] T+0ms: main() entered\n[krun] krun_start_enter called\n",
            )
            .unwrap();
            std::fs::write(&console_log, "").unwrap();

            let report = CrashReport::from_exit_file(
                &exit_file,
                &console_log,
                &stderr_file,
                "vIsLhQP34dQF",
                *exit_code,
            );

            crate::util::assert_client_safe(&report.client_message, "vIsLhQP34dQF");

            // The detail is routed, not dropped: the operator still gets the
            // box id and the console path this case would have leaked.
            assert!(
                report.operator_report.contains("vIsLhQP34dQF"),
                "{label}: operator report lost the box id"
            );
            assert!(
                report.operator_report.contains("console.log"),
                "{label}: operator report lost the console path"
            );
        }
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
