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

/// Wait for guest to signal readiness, racing against shim process death.
///
/// Uses `tokio::select!` to detect three conditions:
/// 1. Guest connects to ready socket (success)
/// 2. Shim process exits unexpectedly (fast failure with diagnostic)
/// 3. 30s timeout expires (slow failure fallback)
async fn wait_for_guest_ready(
    ready_transport: &Transport,
    shim_pid: Option<u32>,
    exit_file: &Path,
    console_log: &Path,
    stderr_file: &Path,
    box_id: &str,
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
    let timeout = Duration::from_secs(30);

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
                Err(_) => Err(BoxliteError::Engine(format!(
                    "Box {box_id} failed to start: timeout after {}s\n\n\
                     The VM did not respond within the expected time.\n\n\
                     Common causes:\n\
                     • Slow disk I/O during rootfs setup\n\
                     • Network configuration issues\n\
                     • Guest agent failed to start\n\n\
                     Debug files:\n\
                     • Console: {}\n\n\
                     Tip: Run with RUST_LOG=debug for more details",
                    timeout.as_secs(),
                    console_log.display()
                ))),
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
}
