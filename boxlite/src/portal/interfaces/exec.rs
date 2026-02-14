//! Execution service interface.
//!
//! High-level API for execution operations (unary Exec + output-only Attach +
//! blocking Wait).

use crate::litebox::{BoxCommand, ExecResult};
use boxlite_shared::{
    AttachRequest, BoxliteError, BoxliteResult, ExecOutput, ExecRequest, ExecStdin,
    ExecutionClient, KillRequest, WaitRequest, WaitResponse, exec_output,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use tonic::transport::Channel;

/// Execution service interface.
#[derive(Clone)]
pub struct ExecutionInterface {
    client: ExecutionClient<Channel>,
}

/// Components for building an Execution.
pub struct ExecComponents {
    pub execution_id: String,
    pub stdin_tx: mpsc::UnboundedSender<Vec<u8>>,
    pub stdout_rx: mpsc::UnboundedReceiver<String>,
    pub stderr_rx: mpsc::UnboundedReceiver<String>,
    pub result_rx: mpsc::UnboundedReceiver<ExecResult>,
}

impl ExecutionInterface {
    /// Create from a channel.
    pub fn new(channel: Channel) -> Self {
        Self {
            client: ExecutionClient::new(channel),
        }
    }

    /// Execute a command and return execution components.
    ///
    /// # Arguments
    /// * `command` - The command to execute
    /// * `shutdown_token` - Cancellation token to abort background tasks on shutdown
    pub async fn exec(
        &mut self,
        command: BoxCommand,
        shutdown_token: CancellationToken,
    ) -> BoxliteResult<ExecComponents> {
        // Create channels
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, stderr_rx) = mpsc::unbounded_channel::<String>();
        let (result_tx, result_rx) = mpsc::unbounded_channel();

        // Build request
        let request = ExecProtocol::build_exec_request(&command);

        tracing::debug!(?command, "Starting execution");

        // Start execution
        let exec_response = self.client.exec(request).await?.into_inner();
        if let Some(err) = exec_response.error {
            return Err(BoxliteError::Internal(format!(
                "{}: {}",
                err.reason, err.detail
            )));
        }

        let execution_id = exec_response.execution_id.clone();

        // Spawn stdin pump (no cancellation needed - closes when stdin_tx is dropped)
        ExecProtocol::spawn_stdin(self.client.clone(), execution_id.clone(), stdin_rx);

        // Spawn attach fanout (cancellable)
        ExecProtocol::spawn_attach(
            self.client.clone(),
            execution_id.clone(),
            stdout_tx,
            stderr_tx,
            shutdown_token.clone(),
        );

        // Spawn wait task for terminal status (cancellable)
        ExecProtocol::spawn_wait(
            self.client.clone(),
            execution_id.clone(),
            result_tx,
            shutdown_token,
        );

        Ok(ExecComponents {
            execution_id,
            stdin_tx,
            stdout_rx,
            stderr_rx,
            result_rx,
        })
    }

    /// Wait for execution to complete.
    #[allow(dead_code)] // API method for future use
    pub async fn wait(&mut self, execution_id: &str) -> BoxliteResult<ExecResult> {
        let request = WaitRequest {
            execution_id: execution_id.to_string(),
        };

        let response = self.client.wait(request).await?.into_inner();
        Ok(ExecProtocol::map_wait_response(response))
    }

    /// Kill execution (send signal).
    pub async fn kill(&mut self, execution_id: &str, signal: i32) -> BoxliteResult<()> {
        let request = KillRequest {
            execution_id: execution_id.to_string(),
            signal,
        };

        let response = self.client.kill(request).await?.into_inner();

        if response.success {
            Ok(())
        } else {
            Err(BoxliteError::Internal(
                response.error.unwrap_or_else(|| "Kill failed".to_string()),
            ))
        }
    }

    /// Resize PTY terminal window.
    pub async fn resize_tty(
        &mut self,
        execution_id: &str,
        rows: u32,
        cols: u32,
        x_pixels: u32,
        y_pixels: u32,
    ) -> BoxliteResult<()> {
        use boxlite_shared::ResizeTtyRequest;

        let request = ResizeTtyRequest {
            execution_id: execution_id.to_string(),
            rows,
            cols,
            x_pixels,
            y_pixels,
        };

        let response = self.client.resize_tty(request).await?.into_inner();

        if response.success {
            Ok(())
        } else {
            Err(BoxliteError::Internal(
                response
                    .error
                    .unwrap_or_else(|| "Resize TTY failed".to_string()),
            ))
        }
    }
}

// ============================================================================
// ExecBackend trait implementation
// ============================================================================

#[async_trait::async_trait]
impl crate::runtime::backend::ExecBackend for ExecutionInterface {
    async fn kill(&mut self, execution_id: &str, signal: i32) -> BoxliteResult<()> {
        self.kill(execution_id, signal).await
    }

    async fn resize_tty(
        &mut self,
        execution_id: &str,
        rows: u32,
        cols: u32,
        x_pixels: u32,
        y_pixels: u32,
    ) -> BoxliteResult<()> {
        self.resize_tty(execution_id, rows, cols, x_pixels, y_pixels)
            .await
    }
}

// ============================================================================
// Helper: Protocol wiring
// ============================================================================

struct ExecProtocol;

impl ExecProtocol {
    fn build_exec_request(command: &BoxCommand) -> ExecRequest {
        use boxlite_shared::TtyConfig;

        ExecRequest {
            execution_id: None,
            program: command.command.clone(),
            args: command.args.clone(),
            env: command
                .env
                .clone()
                .unwrap_or_default()
                .into_iter()
                .collect(),
            workdir: command.working_dir.clone().unwrap_or_default(),
            timeout_ms: command.timeout.map(|d| d.as_millis() as u64).unwrap_or(0),
            tty: if command.tty {
                let (rows, cols) = crate::util::get_terminal_size();
                Some(TtyConfig {
                    rows,
                    cols,
                    x_pixels: 0,
                    y_pixels: 0,
                })
            } else {
                None
            },
        }
    }

    fn map_wait_response(resp: WaitResponse) -> ExecResult {
        let code = if resp.signal != 0 {
            -resp.signal
        } else {
            resp.exit_code
        };
        let error_message = if resp.error_message.is_empty() {
            None
        } else {
            Some(resp.error_message)
        };
        ExecResult {
            exit_code: code,
            error_message,
        }
    }

    fn spawn_attach(
        mut client: ExecutionClient<Channel>,
        execution_id: String,
        stdout_tx: mpsc::UnboundedSender<String>,
        stderr_tx: mpsc::UnboundedSender<String>,
        shutdown_token: CancellationToken,
    ) {
        tokio::spawn(async move {
            let request = AttachRequest {
                execution_id: execution_id.clone(),
            };

            // Use select! to handle cancellation during initial attach
            let response = tokio::select! {
                biased;
                _ = shutdown_token.cancelled() => {
                    tracing::debug!(execution_id = %execution_id, "Attach cancelled during connect");
                    return;
                }
                result = client.attach(request) => result,
            };

            match response {
                Ok(response) => {
                    tracing::debug!(execution_id = %execution_id, "Attach stream connected");
                    let mut stream = response.into_inner();
                    let mut message_count = 0u64;

                    loop {
                        // Use select! to handle cancellation while streaming
                        let output = tokio::select! {
                            biased;
                            _ = shutdown_token.cancelled() => {
                                tracing::debug!(
                                    execution_id = %execution_id,
                                    message_count,
                                    "Attach stream cancelled during shutdown"
                                );
                                break;
                            }
                            msg = stream.message() => msg,
                        };

                        match output.transpose() {
                            Some(Ok(output)) => {
                                message_count += 1;
                                Self::route_output(output, &stdout_tx, &stderr_tx);
                            }
                            Some(Err(e)) => {
                                tracing::debug!(
                                    execution_id = %execution_id,
                                    error = %e,
                                    message_count,
                                    "Attach stream error, breaking"
                                );
                                let _ = stderr_tx.send(format!("Attach stream error: {}", e));
                                break;
                            }
                            None => {
                                // Stream ended normally
                                break;
                            }
                        }
                    }

                    tracing::debug!(
                        execution_id = %execution_id,
                        message_count,
                        "Attach stream ended"
                    );
                }
                Err(e) => {
                    tracing::debug!(execution_id = %execution_id, error = %e, "Attach failed");
                    let _ = stderr_tx.send(format!("Attach failed: {}", e));
                }
            }
        });
    }

    fn route_output(
        output: ExecOutput,
        stdout_tx: &mpsc::UnboundedSender<String>,
        stderr_tx: &mpsc::UnboundedSender<String>,
    ) {
        match output.event {
            Some(exec_output::Event::Stdout(chunk)) => {
                let stdout_data = String::from_utf8_lossy(&chunk.data).to_string();
                tracing::trace!(?stdout_data, "Received exec stdout");
                let _ = stdout_tx.send(stdout_data);
            }
            Some(exec_output::Event::Stderr(chunk)) => {
                let stderr_data = String::from_utf8_lossy(&chunk.data).to_string();
                tracing::trace!(?stderr_data, "Received exec stderr");
                let _ = stderr_tx.send(stderr_data);
            }
            None => {}
        }
    }

    fn spawn_wait(
        mut client: ExecutionClient<Channel>,
        execution_id: String,
        result_tx: mpsc::UnboundedSender<ExecResult>,
        shutdown_token: CancellationToken,
    ) {
        tokio::spawn(async move {
            let request = WaitRequest {
                execution_id: execution_id.clone(),
            };

            // Use select! to handle cancellation during wait
            let result = tokio::select! {
                biased;
                _ = shutdown_token.cancelled() => {
                    tracing::debug!(execution_id = %execution_id, "Wait cancelled during shutdown");
                    // Send a special result indicating cancellation
                    // Using exit code -1 to indicate abnormal termination
                    let _ = result_tx.send(ExecResult { exit_code: -1, error_message: None });
                    return;
                }
                result = client.wait(request) => result,
            };

            match result {
                Ok(resp) => {
                    let mapped = Self::map_wait_response(resp.into_inner());
                    let _ = result_tx.send(mapped);
                }
                Err(e) => {
                    tracing::error!(
                        execution_id = %execution_id,
                        error = %e,
                        "Wait failed"
                    );
                    let _ = result_tx.send(ExecResult {
                        exit_code: -1,
                        error_message: None,
                    });
                }
            }
        });
    }

    fn spawn_stdin(
        mut client: ExecutionClient<Channel>,
        execution_id: String,
        mut stdin_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    ) {
        tokio::spawn(async move {
            let (tx, rx) = mpsc::channel::<ExecStdin>(8);

            // Producer: forward stdin channel into tonic stream
            let exec_id_clone = execution_id.clone();
            tokio::spawn(async move {
                while let Some(data) = stdin_rx.recv().await {
                    let msg = ExecStdin {
                        execution_id: exec_id_clone.clone(),
                        data,
                        close: false,
                    };
                    if tx.send(msg).await.is_err() {
                        return;
                    }
                }

                // Signal stdin close
                let _ = tx
                    .send(ExecStdin {
                        execution_id: exec_id_clone,
                        data: Vec::new(),
                        close: true,
                    })
                    .await;
            });

            let stream = ReceiverStream::new(rx);
            if let Err(e) = client.send_input(stream).await {
                tracing::warn!(
                    execution_id = %execution_id,
                    error = %e,
                    "SendInput failed"
                );
            }
        });
    }
}

// ============================================================================
// UNIT TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Test that CancellationToken correctly signals cancelled state.
    #[tokio::test]
    async fn test_cancellation_token_basic() {
        let token = CancellationToken::new();

        // Initially not cancelled
        assert!(!token.is_cancelled());

        // Cancel it
        token.cancel();

        // Now cancelled
        assert!(token.is_cancelled());

        // cancelled() future resolves immediately when already cancelled
        tokio::time::timeout(Duration::from_millis(10), token.cancelled())
            .await
            .expect("cancelled() should resolve immediately when token is cancelled");
    }

    /// Test that child tokens are cancelled when parent is cancelled.
    #[tokio::test]
    async fn test_child_token_cancelled_with_parent() {
        let parent = CancellationToken::new();
        let child = parent.child_token();

        // Initially neither cancelled
        assert!(!parent.is_cancelled());
        assert!(!child.is_cancelled());

        // Cancel parent
        parent.cancel();

        // Both should be cancelled
        assert!(parent.is_cancelled());
        assert!(child.is_cancelled());
    }

    /// Test that cancelling child does not cancel parent.
    #[tokio::test]
    async fn test_child_token_independent_cancel() {
        let parent = CancellationToken::new();
        let child = parent.child_token();

        // Cancel child only
        child.cancel();

        // Child cancelled, parent not
        assert!(child.is_cancelled());
        assert!(!parent.is_cancelled());
    }

    /// Test that multiple children are all cancelled when parent is cancelled.
    #[tokio::test]
    async fn test_multiple_children_cancelled() {
        let runtime_token = CancellationToken::new();
        let box1_token = runtime_token.child_token();
        let box2_token = runtime_token.child_token();
        let box3_token = runtime_token.child_token();

        // Cancel runtime (simulates shutdown)
        runtime_token.cancel();

        // All boxes should be cancelled
        assert!(box1_token.is_cancelled());
        assert!(box2_token.is_cancelled());
        assert!(box3_token.is_cancelled());
    }

    /// Test that tokio::select! with cancelled() returns immediately when token is cancelled.
    #[tokio::test]
    async fn test_select_with_cancelled_token() {
        let token = CancellationToken::new();

        // Cancel before select
        token.cancel();

        // Select should immediately return the cancelled branch
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => "cancelled",
            _ = tokio::time::sleep(Duration::from_secs(10)) => "timeout",
        };

        assert_eq!(result, "cancelled");
    }

    /// Test that tokio::select! with cancelled() waits until token is cancelled.
    #[tokio::test]
    async fn test_select_waits_for_cancellation() {
        let token = CancellationToken::new();
        let token_clone = token.clone();

        // Spawn task that cancels after short delay
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            token_clone.cancel();
        });

        let start = std::time::Instant::now();

        // Select should wait for cancellation
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => "cancelled",
            _ = tokio::time::sleep(Duration::from_secs(10)) => "timeout",
        };

        let elapsed = start.elapsed();

        assert_eq!(result, "cancelled");
        // Should have waited ~50ms, not 10s
        assert!(elapsed < Duration::from_secs(1));
        assert!(elapsed >= Duration::from_millis(40)); // Allow some variance
    }

    /// Test simulating spawn_wait cancellation behavior.
    /// When token is cancelled, the result channel should receive exit_code -1.
    #[tokio::test]
    async fn test_spawn_wait_cancellation_sends_result() {
        let token = CancellationToken::new();
        let (result_tx, mut result_rx) = mpsc::unbounded_channel();

        // Simulate spawn_wait's cancellation handling
        let token_clone = token.clone();
        let handle = tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = token_clone.cancelled() => {
                    let _ = result_tx.send(ExecResult { exit_code: -1, error_message: None });
                }
                _ = tokio::time::sleep(Duration::from_secs(3600)) => {
                    // Would normally wait for gRPC response
                }
            }
        });

        // Cancel after short delay
        tokio::time::sleep(Duration::from_millis(10)).await;
        token.cancel();

        // Wait for task to complete
        handle.await.unwrap();

        // Should have received cancellation result
        let result = result_rx.recv().await;
        assert!(result.is_some());
        assert_eq!(result.unwrap().exit_code, -1);
    }

    /// Test simulating spawn_attach cancellation behavior.
    /// When token is cancelled, the task should exit cleanly.
    #[tokio::test]
    async fn test_spawn_attach_cancellation_exits() {
        let token = CancellationToken::new();
        let (stdout_tx, _stdout_rx) = mpsc::unbounded_channel::<String>();
        let (_stderr_tx, _stderr_rx) = mpsc::unbounded_channel::<String>();

        // Simulate spawn_attach's cancellation handling in streaming loop
        let token_clone = token.clone();
        let handle = tokio::spawn(async move {
            let mut iterations = 0;
            loop {
                tokio::select! {
                    biased;
                    _ = token_clone.cancelled() => {
                        return iterations;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(10)) => {
                        // Simulate receiving output
                        let _ = stdout_tx.send("output".to_string());
                        iterations += 1;
                    }
                }
            }
        });

        // Let it run for a bit
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Cancel
        token.cancel();

        // Should complete quickly
        let result = tokio::time::timeout(Duration::from_millis(100), handle).await;
        assert!(result.is_ok(), "Task should complete after cancellation");

        let iterations = result.unwrap().unwrap();
        assert!(
            iterations > 0,
            "Should have processed some iterations before cancel"
        );
        println!("Processed {} iterations before cancellation", iterations);
    }

    /// Test that runtime shutdown cascades to all boxes.
    #[tokio::test]
    async fn test_runtime_shutdown_cascades_to_boxes() {
        // Simulate runtime with multiple boxes
        let runtime_token = CancellationToken::new();

        // Create box tokens (children of runtime)
        let box1_token = runtime_token.child_token();
        let box2_token = runtime_token.child_token();

        // Create execution tokens (children of box tokens)
        let exec1_token = box1_token.child_token();
        let exec2_token = box2_token.child_token();

        // Spawn tasks simulating wait() on each execution
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        let (tx2, mut rx2) = mpsc::unbounded_channel();

        let exec1_clone = exec1_token.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = exec1_clone.cancelled() => {
                    let _ = tx1.send("cancelled");
                }
                _ = tokio::time::sleep(Duration::from_secs(3600)) => {}
            }
        });

        let exec2_clone = exec2_token.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = exec2_clone.cancelled() => {
                    let _ = tx2.send("cancelled");
                }
                _ = tokio::time::sleep(Duration::from_secs(3600)) => {}
            }
        });

        // Runtime shutdown
        runtime_token.cancel();

        // All executions should be cancelled
        let result1 = tokio::time::timeout(Duration::from_millis(100), rx1.recv()).await;
        let result2 = tokio::time::timeout(Duration::from_millis(100), rx2.recv()).await;

        assert!(result1.is_ok());
        assert!(result2.is_ok());
        assert_eq!(result1.unwrap(), Some("cancelled"));
        assert_eq!(result2.unwrap(), Some("cancelled"));
    }
}
