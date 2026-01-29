//! Task: Guest Connect - Connect to the guest gRPC session.
//!
//! Creates a GuestSession for communicating with the guest init process.
//! This task is reusable across spawn, restart, and reconnect paths.
//!
//! IMPORTANT: Must wait for guest to be ready before creating session.
//! Races guest readiness against shim process death for fast failure detection.

use super::{InitCtx, log_task_error, task_start};
use crate::pipeline::PipelineTask;
use crate::portal::GuestSession;
use async_trait::async_trait;
use boxlite_shared::Transport;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::time::Duration;

pub struct GuestConnectTask;

#[async_trait]
impl PipelineTask<InitCtx> for GuestConnectTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (transport, ready_transport, skip_guest_wait, shim_pid) = {
            let ctx = ctx.lock().await;
            (
                ctx.config.transport.clone(),
                Transport::unix(ctx.config.ready_socket_path.clone()),
                ctx.skip_guest_wait,
                ctx.guard.handler_pid(),
            )
        };

        // Wait for guest to be ready before creating session
        // Skip for reattach (Running status) - guest already signaled ready at boot
        if skip_guest_wait {
            tracing::debug!(box_id = %box_id, "Skipping guest ready wait (reattach)");
        } else {
            tracing::debug!(box_id = %box_id, "Waiting for guest to be ready");
            wait_for_guest_ready(&ready_transport, shim_pid)
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
                    "Timeout waiting for guest ready ({}s). \
                     Check logs: ~/.boxlite/logs/boxlite-shim.log, \
                     and system: dmesg | grep -i 'apparmor\\|kvm'",
                    timeout.as_secs()
                ))),
            }
        }
        _ = wait_for_process_exit(shim_pid) => {
            Err(BoxliteError::Engine(
                "VM subprocess exited before guest became ready. \
                 Common causes: (1) AppArmor blocking bwrap — run: \
                 dmesg | grep apparmor, (2) /dev/kvm not accessible — \
                 check permissions, (3) missing shared libraries. \
                 See: ~/.boxlite/logs/boxlite-shim.log".into()
            ))
        }
    }
}

/// Async poll until a process exits. Resolves when process is no longer alive.
/// If pid is None, never resolves (lets other select! branches win).
async fn wait_for_process_exit(pid: Option<u32>) {
    let Some(pid) = pid else {
        // No PID to monitor — pend forever, let timeout branch handle it
        return std::future::pending().await;
    };

    let poll_interval = Duration::from_millis(500);
    loop {
        tokio::time::sleep(poll_interval).await;
        if !crate::util::is_process_alive(pid) {
            tracing::warn!(
                pid = pid,
                "VM subprocess exited unexpectedly during startup"
            );
            return;
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
        let transport = Transport::unix(socket_path.clone());

        // Spawn a task that connects after a short delay
        let connect_path = socket_path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = tokio::net::UnixStream::connect(&connect_path).await;
        });

        // No shim PID to monitor (None = never triggers death branch)
        let result = wait_for_guest_ready(&transport, None).await;
        assert!(result.is_ok(), "Expected success, got: {:?}", result);
    }

    /// Non-Unix transport should be rejected immediately.
    #[tokio::test]
    async fn test_guest_ready_rejects_non_unix_transport() {
        let transport = Transport::Vsock { port: 2695 };

        let result = wait_for_guest_ready(&transport, None).await;
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

        let result = wait_for_guest_ready(&transport, None).await;
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
        let transport = Transport::unix(socket_path);

        // Use a PID that doesn't exist — wait_for_process_exit will
        // detect it as dead on the first poll interval.
        let dead_pid = Some(999_999_999u32);

        let start = std::time::Instant::now();
        let result = wait_for_guest_ready(&transport, dead_pid).await;
        let elapsed = start.elapsed();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("VM subprocess exited before guest became ready"),
            "Expected shim death error, got: {}",
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
}
