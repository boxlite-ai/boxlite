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

        tracing::debug!(command = %command.command, "exec RPC: sending request");

        // Start execution
        let exec_response = self.client.exec(request).await?.into_inner();
        if let Some(err) = exec_response.error {
            return Err(BoxliteError::Internal(format!(
                "{}: {}",
                err.reason, err.detail
            )));
        }

        let execution_id = exec_response.execution_id.clone();

        tracing::debug!(execution_id = %execution_id, "spawning background streams");

        // Spawn stdin pump (cancellable — exits cleanly during shutdown)
        ExecProtocol::spawn_stdin(
            self.client.clone(),
            execution_id.clone(),
            stdin_rx,
            shutdown_token.clone(),
        );

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

    /// Send a signal to an execution. Despite the underlying gRPC method
    /// being named `kill`, this is a generic signal-sending operation —
    /// pass `9` for SIGKILL, `15` for SIGTERM, `2` for SIGINT, etc.
    pub async fn signal(&mut self, execution_id: &str, signal: i32) -> BoxliteResult<()> {
        let request = KillRequest {
            execution_id: execution_id.to_string(),
            signal,
        };

        let response = self.client.kill(request).await?.into_inner();

        if response.success {
            Ok(())
        } else {
            Err(BoxliteError::Internal(
                response
                    .error
                    .unwrap_or_else(|| "Signal failed".to_string()),
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
    async fn signal(&mut self, execution_id: &str, signal: i32) -> BoxliteResult<()> {
        self.signal(execution_id, signal).await
    }

    // kill() uses the trait default (signal(id, SIGKILL)) — local backend
    // has no separate "evict" step beyond the kernel-level signal.

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
            user: command.user.clone(),
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
                    tracing::debug!(execution_id = %execution_id, "attach cancelled during connect");
                    return;
                }
                result = client.attach(request) => result,
            };

            match response {
                Ok(response) => {
                    tracing::debug!(execution_id = %execution_id, "attach stream connected");
                    let mut stream = response.into_inner();
                    let mut message_count = 0u64;
                    // Per-stream UTF-8 decoder state. The gRPC layer chunks the
                    // PTY's byte stream at arbitrary offsets, which can land
                    // mid-codepoint for any multi-byte char (e.g. `─` is 3
                    // bytes, `👋` is 4). Decoding each chunk independently with
                    // `from_utf8_lossy` substitutes U+FFFD on both sides of the
                    // cut, doubling visible columns and desyncing TUI cursor
                    // math (see https://github.com/.../issues/...). Holding
                    // the trailing partial across chunks fixes this.
                    let mut stdout_decoder = Utf8StreamDecoder::default();
                    let mut stderr_decoder = Utf8StreamDecoder::default();

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
                                Self::route_output(
                                    output,
                                    &stdout_tx,
                                    &stderr_tx,
                                    &mut stdout_decoder,
                                    &mut stderr_decoder,
                                );
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
                                // Stream ended normally — flush any partial
                                // bytes still in the decoders as U+FFFD,
                                // matching `from_utf8_lossy` semantics for
                                // a truncated input at EOF.
                                let stdout_tail = stdout_decoder.flush();
                                if !stdout_tail.is_empty() {
                                    let _ = stdout_tx.send(stdout_tail);
                                }
                                let stderr_tail = stderr_decoder.flush();
                                if !stderr_tail.is_empty() {
                                    let _ = stderr_tx.send(stderr_tail);
                                }
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
        stdout_decoder: &mut Utf8StreamDecoder,
        stderr_decoder: &mut Utf8StreamDecoder,
    ) {
        match output.event {
            Some(exec_output::Event::Stdout(chunk)) => {
                let stdout_data = stdout_decoder.decode(&chunk.data);
                tracing::trace!(?stdout_data, "Received exec stdout");
                if !stdout_data.is_empty() {
                    let _ = stdout_tx.send(stdout_data);
                }
            }
            Some(exec_output::Event::Stderr(chunk)) => {
                let stderr_data = stderr_decoder.decode(&chunk.data);
                tracing::trace!(?stderr_data, "Received exec stderr");
                if !stderr_data.is_empty() {
                    let _ = stderr_tx.send(stderr_data);
                }
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

            tracing::debug!(execution_id = %execution_id, "wait: sending request");

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
                    tracing::warn!(
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
        shutdown_token: CancellationToken,
    ) {
        tokio::spawn(async move {
            tracing::debug!(execution_id = %execution_id, "stdin: starting stream");
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
            tokio::select! {
                biased;
                _ = shutdown_token.cancelled() => {
                    tracing::debug!(execution_id = %execution_id, "SendInput cancelled during shutdown");
                }
                result = client.send_input(stream) => {
                    if let Err(e) = result {
                        tracing::warn!(
                            execution_id = %execution_id,
                            error = %e,
                            "SendInput failed"
                        );
                    }
                }
            }
        });
    }
}

// ============================================================================
// Streaming UTF-8 decoder
// ============================================================================

/// Lossy UTF-8 decoder that preserves a trailing incomplete codepoint across
/// `decode` calls.
///
/// `String::from_utf8_lossy` works on a single buffer; when the producer
/// chunks bytes at arbitrary offsets (gRPC frames, network reads), a
/// multi-byte codepoint can land split across two chunks and each side gets
/// replaced with U+FFFD. This decoder holds back the trailing 1-3 bytes of
/// an incomplete sequence and prepends them to the next chunk before
/// decoding, so a single split codepoint emits as one character (or one
/// U+FFFD for genuinely invalid bytes), not two.
///
/// `flush()` returns U+FFFD for any bytes still held when the stream ends —
/// matches `from_utf8_lossy` semantics for a truncated tail.
#[derive(Default)]
struct Utf8StreamDecoder {
    /// 0-3 trailing bytes from the previous chunk that may be the start of a
    /// multi-byte sequence. UTF-8 codepoints are at most 4 bytes; if we ever
    /// hold 4 bytes without finding a complete codepoint, the bytes are
    /// invalid and get emitted as U+FFFD on the next decode.
    holdover: Vec<u8>,
}

impl Utf8StreamDecoder {
    /// Decode `chunk`, prepending any held-over bytes from the previous call.
    /// Returns the longest valid UTF-8 prefix as a String; bytes that form
    /// the start of a possibly-incomplete codepoint at the end are held for
    /// the next call.
    fn decode(&mut self, chunk: &[u8]) -> String {
        // Combine any held-over partial bytes with the new chunk. Allocation
        // is unavoidable when holdover is non-empty; for the common case
        // (clean chunk boundaries), holdover is empty and we still need to
        // own the bytes to splice in any new partial tail.
        let mut buf = std::mem::take(&mut self.holdover);
        buf.extend_from_slice(chunk);

        match std::str::from_utf8(&buf) {
            Ok(s) => s.to_string(),
            Err(e) => {
                let valid_up_to = e.valid_up_to();
                // SAFETY: `valid_up_to` is, by definition, a valid UTF-8
                // boundary in `buf` — bytes [0..valid_up_to] are valid.
                let valid =
                    unsafe { std::str::from_utf8_unchecked(&buf[..valid_up_to]) }.to_string();

                let tail = &buf[valid_up_to..];
                match e.error_len() {
                    // Tail is the start of a possibly-incomplete codepoint;
                    // hold it for the next chunk. Cap at 4 bytes — the max
                    // UTF-8 codepoint length. If we ever hold 4 bytes that
                    // still don't form a codepoint, the bytes are genuinely
                    // invalid and the next decode will emit U+FFFD.
                    None if tail.len() < 4 => {
                        self.holdover = tail.to_vec();
                        valid
                    }
                    // Either a definitively invalid sequence (Some(len)) or
                    // an incomplete sequence longer than any valid UTF-8
                    // codepoint — in both cases, fall through to lossy
                    // decode of the tail so callers see U+FFFD where the
                    // bytes are bad.
                    _ => {
                        let mut out = valid;
                        out.push_str(&String::from_utf8_lossy(tail));
                        out
                    }
                }
            }
        }
    }

    /// Drain any held-over partial codepoint as U+FFFD. Call when the stream
    /// ends so callers don't silently lose trailing invalid bytes.
    fn flush(&mut self) -> String {
        if self.holdover.is_empty() {
            return String::new();
        }
        let tail = std::mem::take(&mut self.holdover);
        String::from_utf8_lossy(&tail).into_owned()
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

    // ========================================================================
    // Utf8StreamDecoder
    //
    // Reproducer for the bug where `from_utf8_lossy` on each gRPC chunk
    // independently doubles a multi-byte char straddling the chunk boundary
    // ("─" → "��"), desyncing TUI cursor math in pi/htop/ncdu/etc.
    // ========================================================================

    /// 3-byte char split between two chunks must decode to one char, not two
    /// U+FFFD. This is the exact pattern observed in the wild.
    #[test]
    fn utf8_decoder_joins_3byte_split_across_chunks() {
        let mut d = Utf8StreamDecoder::default();
        // "─" is E2 94 80. Split into [E2] and [94 80].
        let a = d.decode(&[0xE2]);
        let b = d.decode(&[0x94, 0x80]);
        assert_eq!(a, "");
        assert_eq!(b, "─");
    }

    /// 4-byte char (emoji) split anywhere across two chunks — every cut
    /// point should still recover the original char.
    #[test]
    fn utf8_decoder_joins_4byte_split_at_every_cut() {
        // "👋" is F0 9F 91 8B.
        let bytes = "👋".as_bytes();
        for cut in 1..bytes.len() {
            let mut d = Utf8StreamDecoder::default();
            let head = d.decode(&bytes[..cut]);
            let tail = d.decode(&bytes[cut..]);
            assert_eq!(
                format!("{head}{tail}"),
                "👋",
                "cut at {cut} did not reassemble cleanly"
            );
        }
    }

    /// A char split across THREE chunks (one byte at a time) — bytes must
    /// keep accumulating in the holdover until the codepoint completes.
    #[test]
    fn utf8_decoder_joins_4byte_split_one_byte_per_chunk() {
        let mut d = Utf8StreamDecoder::default();
        let bytes = "👋".as_bytes();
        let r1 = d.decode(&[bytes[0]]);
        let r2 = d.decode(&[bytes[1]]);
        let r3 = d.decode(&[bytes[2]]);
        let r4 = d.decode(&[bytes[3]]);
        assert_eq!(r1, "");
        assert_eq!(r2, "");
        assert_eq!(r3, "");
        assert_eq!(r4, "👋");
    }

    /// Mix of ASCII + multi-byte split — the ASCII prefix must emit
    /// immediately, only the trailing partial codepoint should be held.
    #[test]
    fn utf8_decoder_emits_ascii_prefix_and_holds_partial_tail() {
        let mut d = Utf8StreamDecoder::default();
        // "hi─" = 68 69 + E2 94 80; deliver [68 69 E2] then [94 80].
        let r1 = d.decode(&[0x68, 0x69, 0xE2]);
        let r2 = d.decode(&[0x94, 0x80]);
        assert_eq!(r1, "hi");
        assert_eq!(r2, "─");
    }

    /// Genuinely invalid bytes must still be replaced with U+FFFD — we
    /// shouldn't paper over real corruption by holding bytes forever.
    #[test]
    fn utf8_decoder_emits_replacement_for_definitively_invalid_bytes() {
        let mut d = Utf8StreamDecoder::default();
        // 0xFF is never valid in UTF-8.
        let out = d.decode(&[b'a', 0xFF, b'b']);
        assert_eq!(out, "a\u{FFFD}b");
    }

    /// flush() at EOF must emit U+FFFD for held-over bytes so the truncated
    /// tail isn't silently dropped.
    #[test]
    fn utf8_decoder_flush_emits_replacement_for_truncated_tail() {
        let mut d = Utf8StreamDecoder::default();
        // Send only the first byte of "─" then "EOF".
        let mid = d.decode(&[0xE2]);
        let tail = d.flush();
        assert_eq!(mid, "");
        assert_eq!(tail, "\u{FFFD}");
        // Subsequent flush is a no-op.
        assert_eq!(d.flush(), "");
    }

    /// Clean ASCII traffic (the hot path) must allocate-and-emit without
    /// any holdover state, run after run.
    #[test]
    fn utf8_decoder_passthrough_for_pure_ascii() {
        let mut d = Utf8StreamDecoder::default();
        assert_eq!(d.decode(b"hello"), "hello");
        assert_eq!(d.decode(b" world\n"), " world\n");
        assert_eq!(d.flush(), "");
    }

    /// route_output uses the decoder; verify it doesn't double-emit U+FFFD
    /// when a 3-byte char straddles two ExecOutput messages. This is the
    /// integration-shaped reproducer for the original bug.
    #[test]
    fn route_output_recovers_split_codepoint_across_messages() {
        use boxlite_shared::{Stdout as StdoutMsg, exec_output};

        let (stdout_tx, mut stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, mut stderr_rx) = mpsc::unbounded_channel::<String>();
        let mut stdout_decoder = Utf8StreamDecoder::default();
        let mut stderr_decoder = Utf8StreamDecoder::default();

        let mk_stdout = |bytes: Vec<u8>| ExecOutput {
            event: Some(exec_output::Event::Stdout(StdoutMsg { data: bytes })),
        };

        // "─" split into [E2] and [94 80] across two messages.
        ExecProtocol::route_output(
            mk_stdout(vec![0xE2]),
            &stdout_tx,
            &stderr_tx,
            &mut stdout_decoder,
            &mut stderr_decoder,
        );
        ExecProtocol::route_output(
            mk_stdout(vec![0x94, 0x80]),
            &stdout_tx,
            &stderr_tx,
            &mut stdout_decoder,
            &mut stderr_decoder,
        );

        // First message: holdover only, no emission.
        // Second message: complete "─" emitted.
        let mut received = String::new();
        while let Ok(s) = stdout_rx.try_recv() {
            received.push_str(&s);
        }
        assert_eq!(received, "─");
        assert!(stderr_rx.try_recv().is_err());
    }
}
