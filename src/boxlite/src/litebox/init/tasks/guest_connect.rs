//! Task: Guest Connect - Connect to the guest gRPC session.
//!
//! Creates a GuestSession for communicating with the guest init process.
//! This task is reusable across spawn, restart, and reconnect paths.
//!
//! IMPORTANT: Must wait for guest to be ready before creating session.
//! Races guest readiness against shim process death for fast failure detection.

use super::{InitCtx, log_task_error, task_start};
use crate::litebox::CrashReport;
use crate::pipeline::PipelineTask;
use crate::portal::GuestSession;
use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
use crate::util::{ProcessExit, ProcessMonitor};
use async_trait::async_trait;
use boxlite_shared::Transport;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::Path;
use std::time::Duration;

pub struct GuestConnectTask;

#[async_trait]
impl PipelineTask<InitCtx> for GuestConnectTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (
            transport,
            ready_transport,
            skip_guest_wait,
            shim_pid,
            exit_file,
            console_log,
            stderr_file,
        ) = {
            let ctx = ctx.lock().await;
            // Use pipeline layout if available, otherwise construct from box_home
            // (reattach scenario: layout not set because FilesystemTask didn't run)
            let fallback_layout;
            let layout = match ctx.layout.as_ref() {
                Some(l) => l,
                None => {
                    fallback_layout = BoxFilesystemLayout::new(
                        ctx.config.box_home.clone(),
                        FsLayoutConfig::without_bind_mount(),
                        false,
                    );
                    &fallback_layout
                }
            };
            let exit_file = layout.exit_file_path();
            let console_log = layout.console_output_path();
            let stderr_file = layout.stderr_file_path();
            (
                ctx.config.transport.clone(),
                Transport::unix(ctx.config.ready_socket_path.clone()),
                ctx.skip_guest_wait,
                ctx.guard.handler_pid(),
                exit_file,
                console_log,
                stderr_file,
            )
        };

        // Wait for guest to be ready before creating session
        // Skip for reattach (Running status) - guest already signaled ready at boot
        if skip_guest_wait {
            tracing::debug!(box_id = %box_id, "Skipping guest ready wait (reattach)");
        } else {
            tracing::debug!(box_id = %box_id, "Waiting for guest to be ready");
            wait_for_guest_ready(
                &ready_transport,
                shim_pid,
                &exit_file,
                &console_log,
                &stderr_file,
                box_id.as_str(),
                GUEST_READY_TIMEOUT,
            )
            .await
            .inspect_err(|e| log_task_error(&box_id, task_name, e))?;
        }

        tracing::debug!(box_id = %box_id, "Guest is ready, creating session");
        let guest_session = GuestSession::new(transport);

        let mut ctx = ctx.lock().await;
        ctx.guest_session = Some(guest_session);

        Ok(())
    }

    fn name(&self) -> &str {
        "guest_connect"
    }
}

/// Production timeout for the guest-ready handshake.
///
/// Exposed as a constant so tests can call `wait_for_guest_ready` with a
/// short timeout and exercise the real timeout branch (including its
/// diagnostic-collection logic) without waiting 30s.
const GUEST_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Wait for guest to signal readiness, racing against shim process death.
///
/// Uses `tokio::select!` to detect three conditions:
/// 1. Guest connects to ready socket (success)
/// 2. Shim process exits unexpectedly (fast failure with diagnostic)
/// 3. `timeout` expires (slow failure fallback with on-host evidence)
async fn wait_for_guest_ready(
    ready_transport: &Transport,
    shim_pid: Option<u32>,
    exit_file: &Path,
    console_log: &Path,
    stderr_file: &Path,
    box_id: &str,
    timeout: Duration,
) -> BoxliteResult<()> {
    let ready_socket_path = match ready_transport {
        Transport::Unix { socket_path } => socket_path,
        _ => {
            return Err(BoxliteError::Engine(
                "ready transport must be Unix socket".into(),
            ));
        }
    };

    // Remove stale socket if exists
    if ready_socket_path.exists() {
        let _ = std::fs::remove_file(ready_socket_path);
    }

    // Create listener for ready notification
    let listener = tokio::net::UnixListener::bind(ready_socket_path).map_err(|e| {
        BoxliteError::Engine(format!(
            "Failed to bind ready socket {}: {}",
            ready_socket_path.display(),
            e
        ))
    })?;

    tracing::debug!(
        socket = %ready_socket_path.display(),
        "Listening for guest ready notification"
    );

    // Race: guest ready signal vs shim death vs timeout
    tokio::select! {
        result = tokio::time::timeout(timeout, listener.accept()) => {
            match result {
                Ok(Ok((_stream, _addr))) => {
                    tracing::debug!("Guest signaled ready via socket connection");
                    Ok(())
                }
                Ok(Err(e)) => Err(BoxliteError::Engine(format!(
                    "Ready socket accept failed: {}", e
                ))),
                Err(_) => {
                    // Collect cheap diagnostics so the user/operator can tell
                    // *which* failure class hit (vs. the previous generic
                    // "Common causes:" list). Order: do not change semantics,
                    // just enrich the error body.
                    let shim_alive = shim_pid
                        .map(crate::util::is_process_alive)
                        .unwrap_or(false);
                    let console_bytes = std::fs::metadata(console_log)
                        .map(|m| m.len())
                        .unwrap_or(0);
                    let ready_socket_present = ready_socket_path.exists();
                    let console_tail = if console_bytes > 0 {
                        // Read the last ~1024 bytes of console.log. If the
                        // file is shorter, read the whole thing.
                        read_tail(console_log, 1024).unwrap_or_default()
                    } else {
                        String::new()
                    };
                    // Likely-cause heuristic. The pattern we hit in production
                    // (shim alive, console empty, ready socket present) maps
                    // to "guest agent failed to connect over vsock".
                    let likely_cause = match (shim_alive, console_bytes > 0) {
                        (true, false) => "guest agent never wrote to console (init or vsock plumbing broken)",
                        (true, true) => "guest booted but agent did not connect to vsock READY port",
                        (false, _) => "shim died silently (see stderr / exit file)",
                    };
                    Err(BoxliteError::Engine(format!(
                        "Box {box_id} failed to start: timeout after {}s\n\n\
                         Evidence at T+{}s:\n\
                         • shim_alive          = {}\n\
                         • console_bytes       = {}\n\
                         • ready_socket_exists = {}\n\
                         • likely_cause        = {}\n\n\
                         Common causes:\n\
                         • Slow disk I/O during rootfs setup\n\
                         • Network configuration issues\n\
                         • Guest agent failed to start\n\n\
                         Debug files:\n\
                         • Console: {}\n\
                         {}\n\
                         Tip: Run with RUST_LOG=debug for more details",
                        timeout.as_secs(),
                        timeout.as_secs(),
                        shim_alive,
                        console_bytes,
                        ready_socket_present,
                        likely_cause,
                        console_log.display(),
                        if console_tail.is_empty() {
                            String::new()
                        } else {
                            format!("\nConsole tail (last {} bytes):\n{}\n", console_tail.len(), console_tail)
                        }
                    )))
                }
            }
        }
        exit_code = wait_for_process_exit(shim_pid) => {
            // Parse exit file and present user-friendly message
            let report = CrashReport::from_exit_file(
                exit_file,
                console_log,
                stderr_file,
                box_id,
                exit_code,
            );

            // Log raw debug info for troubleshooting
            if !report.debug_info.is_empty() {
                tracing::error!(
                    "Box crash details (raw stderr):\n{}",
                    report.debug_info
                );
            }

            Err(BoxliteError::Engine(report.user_message))
        }
    }
}

/// Read at most `max_bytes` from the end of `path`, lossily as UTF-8.
/// Returns the trailing bytes, with a leading `…` marker if the file was
/// longer than `max_bytes`. Used only for human diagnostic strings — not for
/// machine parsing — so silently returns `None` on any IO error.
fn read_tail(path: &Path, max_bytes: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity(max_bytes as usize);
    file.take(max_bytes).read_to_end(&mut buf).ok()?;
    let tail = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        Some(format!("…{}", tail))
    } else {
        Some(tail)
    }
}

/// Async poll until a process exits. Returns exit code when process terminates.
/// If pid is None, never resolves (lets other select! branches win).
async fn wait_for_process_exit(pid: Option<u32>) -> Option<i32> {
    let Some(pid) = pid else {
        // No PID to monitor — pend forever, let timeout branch handle it
        return std::future::pending().await;
    };

    let monitor = ProcessMonitor::new(pid);
    match monitor.wait_for_exit().await {
        ProcessExit::Code(code) => {
            tracing::warn!(
                pid = pid,
                exit_code = code,
                "VM subprocess exited unexpectedly during startup"
            );
            Some(code)
        }
        ProcessExit::Unknown => {
            tracing::warn!(
                pid = pid,
                "VM subprocess exited (not our child, exit code unknown)"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────
    // wait_for_guest_ready tests
    // ─────────────────────────────────────────────────────────────────────

    /// Guest connects to the ready socket → success.
    #[tokio::test]
    async fn test_guest_ready_success() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("ready.sock");
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("shim.stderr");
        let transport = Transport::unix(socket_path.clone());

        // Spawn a task that connects after a short delay
        let connect_path = socket_path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = tokio::net::UnixStream::connect(&connect_path).await;
        });

        // No shim PID to monitor (None = never triggers death branch)
        let result = wait_for_guest_ready(
            &transport,
            None,
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Duration::from_secs(5),
        )
        .await;
        assert!(result.is_ok(), "Expected success, got: {:?}", result);
    }

    /// Non-Unix transport should be rejected immediately.
    #[tokio::test]
    async fn test_guest_ready_rejects_non_unix_transport() {
        let dir = tempfile::tempdir().unwrap();
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("shim.stderr");
        let transport = Transport::Vsock { port: 2695 };

        let result = wait_for_guest_ready(
            &transport,
            None,
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Duration::from_secs(1),
        )
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("ready transport must be Unix socket"),
            "Unexpected error: {}",
            err
        );
    }

    /// Stale socket file is cleaned up before binding.
    #[tokio::test]
    async fn test_guest_ready_cleans_stale_socket() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("ready.sock");
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("shim.stderr");

        // Create a stale socket file
        std::fs::write(&socket_path, b"stale").unwrap();
        assert!(socket_path.exists());

        let transport = Transport::unix(socket_path.clone());

        // Spawn connector
        let connect_path = socket_path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = tokio::net::UnixStream::connect(&connect_path).await;
        });

        let result = wait_for_guest_ready(
            &transport,
            None,
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Duration::from_secs(5),
        )
        .await;
        assert!(
            result.is_ok(),
            "Expected success after stale cleanup, got: {:?}",
            result
        );
    }

    /// When the shim process dies (invalid PID), the death branch fires
    /// before the 30s timeout, producing a diagnostic error.
    #[tokio::test]
    async fn test_guest_ready_detects_shim_death() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("ready.sock");
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("shim.stderr");
        let transport = Transport::unix(socket_path);

        // Use a PID that doesn't exist — wait_for_process_exit will
        // detect it as dead on the first poll interval.
        let dead_pid = Some(999_999_999u32);

        let start = std::time::Instant::now();
        let result = wait_for_guest_ready(
            &transport,
            dead_pid,
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Duration::from_secs(30),
        )
        .await;
        let elapsed = start.elapsed();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("test-box failed to start"),
            "Expected user-friendly error with box_id, got: {}",
            err
        );

        // Should complete in ~500ms (one poll interval), not 30s
        assert!(
            elapsed < Duration::from_secs(5),
            "Should detect dead process quickly, took {:?}",
            elapsed
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // wait_for_process_exit tests
    // ─────────────────────────────────────────────────────────────────────

    /// None PID → future never resolves (pends forever).
    /// Verify by racing against a short timeout.
    #[tokio::test]
    async fn test_wait_for_process_exit_none_pid_pends() {
        let result =
            tokio::time::timeout(Duration::from_millis(200), wait_for_process_exit(None)).await;

        // Should timeout because None pid pends forever
        assert!(
            result.is_err(),
            "None pid should pend forever, but it resolved"
        );
    }

    /// Dead PID resolves within one poll interval (~500ms).
    #[tokio::test]
    async fn test_wait_for_process_exit_dead_pid_resolves() {
        let start = std::time::Instant::now();
        wait_for_process_exit(Some(999_999_999)).await;
        let elapsed = start.elapsed();

        // Should complete within ~600ms (500ms poll + small overhead)
        assert!(
            elapsed < Duration::from_secs(2),
            "Dead PID should resolve quickly, took {:?}",
            elapsed
        );
    }

    /// Live PID (current process) should NOT resolve within a short window.
    #[tokio::test]
    async fn test_wait_for_process_exit_live_pid_pends() {
        let current_pid = std::process::id();

        let result = tokio::time::timeout(
            Duration::from_millis(700),
            wait_for_process_exit(Some(current_pid)),
        )
        .await;

        // Current process is alive, so this should timeout
        assert!(result.is_err(), "Live PID should not resolve");
    }

    /// Zombie PID should resolve quickly (treated as not alive).
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn test_wait_for_process_exit_zombie_pid_resolves() {
        struct PidReaper {
            pid: libc::pid_t,
        }

        impl Drop for PidReaper {
            fn drop(&mut self) {
                let mut status = 0;
                let _ = unsafe { libc::waitpid(self.pid, &mut status, 0) };
            }
        }

        let child_pid = unsafe { libc::fork() };
        assert!(child_pid >= 0, "fork() failed");
        if child_pid == 0 {
            unsafe { libc::_exit(0) };
        }
        let _reaper = PidReaper { pid: child_pid };

        let result = tokio::time::timeout(
            Duration::from_secs(2),
            wait_for_process_exit(Some(child_pid as u32)),
        )
        .await;

        assert!(
            result.is_ok(),
            "Zombie PID should resolve quickly, got timeout"
        );
    }

    /// Timeout branch fires the enriched diagnostic. The error string is
    /// produced by `wait_for_guest_ready` itself — the test asserts on what
    /// production code returns, not on its own format string.
    #[tokio::test]
    async fn test_guest_ready_timeout_branch_returns_enriched_error() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("ready.sock");
        let exit_file = dir.path().join("exit");
        let console_log = dir.path().join("console.log");
        let stderr_file = dir.path().join("shim.stderr");
        // Pre-populate console.log so `console_bytes` is non-zero and
        // production code picks the "guest booted but agent did not connect"
        // likely-cause branch.
        std::fs::write(&console_log, b"early kernel boot...\n").unwrap();
        let transport = Transport::unix(socket_path);

        let result = wait_for_guest_ready(
            &transport,
            None, // no shim death branch
            &exit_file,
            &console_log,
            &stderr_file,
            "test-box",
            Duration::from_millis(100),
        )
        .await;

        let err = result.expect_err("timeout branch must fire").to_string();
        // Substrings come from production code, not the test body.
        assert!(err.contains("test-box failed to start"), "got: {err}");
        assert!(err.contains("Evidence at T+"), "got: {err}");
        assert!(err.contains("shim_alive          = false"), "got: {err}");
        assert!(err.contains("console_bytes       = 21"), "got: {err}");
        assert!(err.contains("ready_socket_exists = true"), "got: {err}");
        assert!(
            err.contains("Console tail"),
            "tail block missing when console has bytes: {err}"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // read_tail tests (used by the enriched timeout diagnostic)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_read_tail_missing_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let nonexistent = dir.path().join("nope.log");
        assert!(read_tail(&nonexistent, 1024).is_none());
    }

    #[test]
    fn test_read_tail_short_file_returns_whole_content_no_ellipsis() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("short.log");
        std::fs::write(&path, b"abc").unwrap();
        let tail = read_tail(&path, 1024).expect("read");
        assert_eq!(tail, "abc");
    }

    #[test]
    fn test_read_tail_long_file_returns_suffix_with_ellipsis() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("long.log");
        // Content exceeds max_bytes; tail should start with '…' marker.
        let content = "x".repeat(1500);
        std::fs::write(&path, &content).unwrap();
        let tail = read_tail(&path, 100).expect("read");
        assert!(
            tail.starts_with('…'),
            "expected ellipsis marker, got: {:?}",
            &tail[..10]
        );
        // 100 bytes plus the leading '…' char (3 bytes UTF-8).
        assert!(tail.len() <= 1024);
    }
}
