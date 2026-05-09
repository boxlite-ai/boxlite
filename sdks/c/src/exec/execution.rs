//! Execution handle for the BoxLite C SDK (post-and-drain callback model).
//!
//! `boxlite_box_exec` synchronously creates a handle. Streaming callbacks
//! (`_on_stdout`, `_on_stderr`, `_on_exit`) are registered by the user; on
//! first registration the corresponding pump task is lazily spawned and
//! pushes events to the parent runtime's `EventQueue`. Lifecycle async ops
//! (`_wait`, `_kill`, `_resize_tty`) follow the same post-and-drain pattern
//! as box-handle ops.
//!
//! Stdin writes are synchronous: they are routed through the in-process
//! channel inside `ExecStdin::write` and never block on a Tokio worker.

use futures::StreamExt;
use std::os::raw::{c_int, c_void};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::runtime::Runtime as TokioRuntime;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Synthetic exit code emitted when `boxlite_execution_free` tears down a
/// running execution before the process exits naturally. Distinct from the
/// `-1` that `wait_on_clone` returns on internal error so consumers (Go SDK
/// in particular) can distinguish "we forced this" from "wait failed".
///
/// Scoped `pub(crate)` so cbindgen does not emit it as a `#define` in the
/// C header (cbindgen would render `-129` without parens, which fails
/// clang-tidy's `bugprone-macro-parentheses`). Foreign callers receive
/// the raw int via the exit callback; they don't need the symbol.
pub(crate) const EXIT_CODE_FORCE_CLOSED: i32 = -129;

use boxlite::{BoxliteError, ExecStderr, ExecStdin, ExecStdout, Execution};

use super::command::{BoxliteCommand, parse_boxlite_command};
use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxExitCb, CBoxExitFn, CBoxStderrCb, CBoxStderrFn, CBoxStdoutCb, CBoxStdoutFn,
    CExecutionKillCb, CExecutionResizeCb, CExecutionWaitCb, EventQueue, RuntimeEvent, push_event,
};
use crate::{CBoxHandle, CBoxliteError, CExecutionHandle};

/// Opaque handle to a running command execution.
pub struct ExecutionHandle {
    /// The underlying `Execution`. `None` once `_free` has consumed it.
    execution: Arc<Mutex<Option<Execution>>>,
    /// Stdin stream (taken at exec creation; held until `_free` drops it).
    stdin: Option<ExecStdin>,
    /// Streams pending pump-task spawn. Each is moved out on first cb register.
    pending_stdout: Option<ExecStdout>,
    pending_stderr: Option<ExecStderr>,
    /// Spawned **stream** pumps (stdout/stderr); aborted on `_free`.
    /// The exit pump is tracked separately in `exit_pump_handle` so that
    /// `_free` can wait for an in-flight Exit push to complete instead of
    /// aborting it mid-yield.
    pumps: Mutex<Vec<JoinHandle<()>>>,
    /// Spawned exit pump task. Held outside `pumps` because, once the
    /// pump has claimed `exit_dispatched`, its `push_event` may yield
    /// cooperatively under queue backpressure. Aborting it during that
    /// yield window would lose the Exit event entirely. `_free` instead
    /// waits-for-completion (with a bounded timeout) when the pump has
    /// claimed dispatch.
    exit_pump_handle: Mutex<Option<JoinHandle<()>>>,
    /// One receiver per registered stream pump. `register_exit` drains this
    /// list and `exit_pump` awaits each before pushing the Exit event so
    /// the Exit callback is strictly the last one for the execution.
    stream_done_rx: Mutex<Vec<oneshot::Receiver<()>>>,
    /// `(cb, user_data)` for the exit callback, captured at register time.
    /// Used by `_free` to synthesise an Exit event when the process is
    /// torn down before it would have exited naturally — guarantees the
    /// Go SDK gets exactly one Exit per execution and can delete the
    /// shared `cgo.Handle`.
    exit_dispatch: Mutex<Option<(CBoxExitFn, usize)>>,
    /// Shared runtime queue for posting stream / lifecycle events.
    queue: Arc<EventQueue>,
    /// Tokio runtime handle for spawning pumps and lifecycle tasks.
    tokio_rt: Arc<TokioRuntime>,
    /// True after `_wait` or the exit pump observes process termination,
    /// preventing redundant kill on `_free`.
    ///
    /// Distinct from `exit_dispatched` so that "process exited" and
    /// "Exit event was published to the queue" are tracked independently:
    /// `_free` may need to push a synthetic Exit even when the process
    /// already exited, and conversely the natural exit pump may push Exit
    /// before `_free` runs.
    process_completed: Arc<AtomicBool>,
    /// Single-flip claim on the per-execution Exit event. Set via
    /// `compare_exchange(false, true, AcqRel, Acquire)`; only the
    /// claimer pushes Exit. Both `execution_free` and `exit_pump`
    /// race for it; the loser silently no-ops.
    exit_dispatched: Arc<AtomicBool>,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_exec(
    handle: *mut CBoxHandle,
    cmd: *const BoxliteCommand,
    out_execution: *mut *mut CExecutionHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_exec(handle, cmd, out_execution, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_on_stdout(
    execution: *mut CExecutionHandle,
    cb: CBoxStdoutCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    register_stdout(execution, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_on_stderr(
    execution: *mut CExecutionHandle,
    cb: CBoxStderrCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    register_stderr(execution, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_on_exit(
    execution: *mut CExecutionHandle,
    cb: CBoxExitCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    register_exit(execution, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_write_stdin(
    execution: *mut CExecutionHandle,
    data: *const u8,
    len: usize,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    write_stdin(execution, data, len, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_wait(
    execution: *mut CExecutionHandle,
    cb: CExecutionWaitCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    execution_wait(execution, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_kill(
    execution: *mut CExecutionHandle,
    cb: CExecutionKillCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    execution_kill(execution, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_resize_tty(
    execution: *mut CExecutionHandle,
    rows: c_int,
    cols: c_int,
    cb: CExecutionResizeCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    execution_resize_tty(execution, rows, cols, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_free(execution: *mut CExecutionHandle) {
    execution_free(execution)
}

unsafe fn box_exec(
    handle: *mut BoxHandle,
    cmd: *const BoxliteCommand,
    out_execution: *mut *mut ExecutionHandle,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if cmd.is_null() {
            write_error(out_error, null_pointer_error("cmd"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_execution.is_null() {
            write_error(out_error, null_pointer_error("out_execution"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_execution = ptr::null_mut();

        let handle_ref = &*handle;
        let command = match parse_boxlite_command(&*cmd) {
            Ok(command) => command,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                return code;
            }
        };

        // Synchronous handle creation: block on the underlying exec call,
        // which only sets up channels; it does not spawn the process loop.
        let lite = handle_ref.handle.clone();
        let result = handle_ref.tokio_rt.block_on(lite.exec(command));

        match result {
            Ok(mut execution) => {
                let stdin = execution.stdin();
                let stdout = execution.stdout();
                let stderr = execution.stderr();

                let exec_handle = ExecutionHandle {
                    execution: Arc::new(Mutex::new(Some(execution))),
                    stdin,
                    pending_stdout: stdout,
                    pending_stderr: stderr,
                    pumps: Mutex::new(Vec::new()),
                    exit_pump_handle: Mutex::new(None),
                    stream_done_rx: Mutex::new(Vec::new()),
                    exit_dispatch: Mutex::new(None),
                    queue: handle_ref.queue.clone(),
                    tokio_rt: handle_ref.tokio_rt.clone(),
                    process_completed: Arc::new(AtomicBool::new(false)),
                    exit_dispatched: Arc::new(AtomicBool::new(false)),
                };
                *out_execution = Box::into_raw(Box::new(exec_handle));
                BoxliteErrorCode::Ok
            }
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

unsafe fn register_stdout(
    execution: *mut ExecutionHandle,
    cb: CBoxStdoutCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if execution.is_null() {
            write_error(out_error, null_pointer_error("execution"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);
        let exec_ref = &mut *execution;
        let Some(stream) = exec_ref.pending_stdout.take() else {
            write_error(
                out_error,
                BoxliteError::InvalidState(
                    "stdout callback already registered or stream unavailable".to_string(),
                ),
            );
            return BoxliteErrorCode::InvalidState;
        };

        let queue = exec_ref.queue.clone();
        let user_data_addr = user_data as usize;
        let (done_tx, done_rx) = oneshot::channel::<()>();
        exec_ref.stream_done_rx.lock().unwrap().push(done_rx);
        let pump = exec_ref
            .tokio_rt
            .spawn(stdout_pump(stream, cb, user_data_addr, queue, done_tx));
        exec_ref.pumps.lock().unwrap().push(pump);
        BoxliteErrorCode::Ok
    }
}

unsafe fn register_stderr(
    execution: *mut ExecutionHandle,
    cb: CBoxStderrCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if execution.is_null() {
            write_error(out_error, null_pointer_error("execution"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);
        let exec_ref = &mut *execution;
        let Some(stream) = exec_ref.pending_stderr.take() else {
            write_error(
                out_error,
                BoxliteError::InvalidState(
                    "stderr callback already registered or stream unavailable".to_string(),
                ),
            );
            return BoxliteErrorCode::InvalidState;
        };

        let queue = exec_ref.queue.clone();
        let user_data_addr = user_data as usize;
        let (done_tx, done_rx) = oneshot::channel::<()>();
        exec_ref.stream_done_rx.lock().unwrap().push(done_rx);
        let pump = exec_ref
            .tokio_rt
            .spawn(stderr_pump(stream, cb, user_data_addr, queue, done_tx));
        exec_ref.pumps.lock().unwrap().push(pump);
        BoxliteErrorCode::Ok
    }
}

unsafe fn register_exit(
    execution: *mut ExecutionHandle,
    cb: CBoxExitCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if execution.is_null() {
            write_error(out_error, null_pointer_error("execution"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);
        let exec_ref = &*execution;
        let exec_arc = exec_ref.execution.clone();
        let queue = exec_ref.queue.clone();
        let user_data_addr = user_data as usize;
        let process_completed = exec_ref.process_completed.clone();
        let exit_dispatched = exec_ref.exit_dispatched.clone();
        // Capture (cb, user_data) so the force-cleanup path in
        // `execution_free` can synthesise an Exit event on teardown.
        *exec_ref.exit_dispatch.lock().unwrap() = Some((cb, user_data_addr));
        // Take ownership of all stream-pump completion receivers — exit_pump
        // awaits each before pushing Exit, so Exit is the strictly-last
        // event for this execution. Stream registrations after this point
        // would not be respected; today the API forbids re-registration.
        let stream_dones = std::mem::take(&mut *exec_ref.stream_done_rx.lock().unwrap());
        let pump = exec_ref.tokio_rt.spawn(exit_pump(
            exec_arc,
            cb,
            user_data_addr,
            queue,
            process_completed,
            exit_dispatched,
            stream_dones,
        ));
        // Track exit_pump separately from stream pumps so `_free` can wait
        // for an in-flight Exit push instead of aborting it mid-yield. API
        // forbids re-registration; if a previous exit_pump is somehow still
        // here, abort it.
        if let Some(prev) = exec_ref.exit_pump_handle.lock().unwrap().replace(pump) {
            prev.abort();
        }
        BoxliteErrorCode::Ok
    }
}

unsafe fn write_stdin(
    execution: *mut ExecutionHandle,
    data: *const u8,
    len: usize,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if execution.is_null() {
            write_error(out_error, null_pointer_error("execution"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if data.is_null() && len > 0 {
            write_error(out_error, null_pointer_error("data"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if len == 0 {
            return BoxliteErrorCode::Ok;
        }

        let exec_ref = &mut *execution;
        let Some(stdin) = exec_ref.stdin.as_mut() else {
            write_error(
                out_error,
                BoxliteError::InvalidState("execution stdin is closed".to_string()),
            );
            return BoxliteErrorCode::InvalidState;
        };

        let bytes = std::slice::from_raw_parts(data, len);
        // ExecStdin::write is async only because the trait is async; the
        // underlying send is non-blocking (mpsc::UnboundedSender::send), so
        // block_on returns immediately on the calling thread.
        match exec_ref.tokio_rt.block_on(stdin.write(bytes)) {
            Ok(()) => BoxliteErrorCode::Ok,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

unsafe fn execution_wait(
    execution: *mut ExecutionHandle,
    cb: CExecutionWaitCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if execution.is_null() {
            write_error(out_error, null_pointer_error("execution"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let exec_ref = &*execution;
        let exec_arc = exec_ref.execution.clone();
        let queue = exec_ref.queue.clone();
        let user_data_addr = user_data as usize;
        let process_completed = exec_ref.process_completed.clone();

        exec_ref.tokio_rt.spawn(async move {
            let result = wait_on_clone(&exec_arc).await;
            // Mark process_completed=true ONLY on Ok — a failed wait is
            // NOT proof the guest process exited. For untrusted/sandboxed
            // code, an Err wait may mean the backend lost the connection
            // while the process is still running, so execution_free must
            // keep its kill+wait cleanup path active.
            if result.is_ok() {
                process_completed.store(true, Ordering::Release);
            }
            push_event(
                &queue,
                RuntimeEvent::Wait {
                    cb,
                    user_data: user_data_addr,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

unsafe fn execution_kill(
    execution: *mut ExecutionHandle,
    cb: CExecutionKillCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if execution.is_null() {
            write_error(out_error, null_pointer_error("execution"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let exec_ref = &*execution;
        let exec_arc = exec_ref.execution.clone();
        let queue = exec_ref.queue.clone();
        let user_data_addr = user_data as usize;

        exec_ref.tokio_rt.spawn(async move {
            let result = kill_on_clone(&exec_arc).await;
            push_event(
                &queue,
                RuntimeEvent::Kill {
                    cb,
                    user_data: user_data_addr,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

unsafe fn execution_resize_tty(
    execution: *mut ExecutionHandle,
    rows: c_int,
    cols: c_int,
    cb: CExecutionResizeCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if execution.is_null() {
            write_error(out_error, null_pointer_error("execution"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if rows <= 0 || cols <= 0 {
            write_error(
                out_error,
                BoxliteError::InvalidArgument("rows and cols must be positive".to_string()),
            );
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let exec_ref = &*execution;
        let exec_arc = exec_ref.execution.clone();
        let queue = exec_ref.queue.clone();
        let user_data_addr = user_data as usize;
        let rows_u = rows as u32;
        let cols_u = cols as u32;

        exec_ref.tokio_rt.spawn(async move {
            let result = resize_on_clone(&exec_arc, rows_u, cols_u).await;
            push_event(
                &queue,
                RuntimeEvent::Resize {
                    cb,
                    user_data: user_data_addr,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

unsafe fn execution_free(execution: *mut ExecutionHandle) {
    if execution.is_null() {
        return;
    }
    unsafe {
        let mut exec_box = Box::from_raw(execution);

        // Close stdin (drops the sender, signalling EOF).
        if let Some(mut stdin) = exec_box.stdin.take() {
            stdin.close();
        }

        // If the process never observed completion, kill + wait inside a
        // best-effort block_on so we don't leak the guest-side process.
        let process_completed = exec_box.process_completed.load(Ordering::Acquire);
        if !process_completed {
            let exec_arc = exec_box.execution.clone();
            let _ = exec_box.tokio_rt.block_on(async move {
                let _ = kill_on_clone(&exec_arc).await;
                wait_on_clone(&exec_arc).await
            });
        }
        // Abort stream pumps FIRST. Otherwise a pump that's mid-yield on
        // push_event can enqueue Stdout/Stderr AFTER the synthetic Exit
        // lands, violating the "Exit is strictly last" invariant. The Go
        // exit callback deletes the per-execution `cgo.Handle`; a later
        // stream callback would call `h.Value()` on the deleted handle
        // and panic the process.
        //
        // Aborting drops the stream pump's future; if it was waiting
        // on push_event's yield_now loop, the future is dropped before
        // the next push_event re-check, so no Stdout/Stderr lands. If
        // it was on its own done_tx send, the receiver (already-
        // completed exit_pump) is gone — harmless.
        let pumps = std::mem::take(&mut *exec_box.pumps.lock().unwrap());
        for pump in &pumps {
            pump.abort();
        }

        // Race exit dispatch with `exit_pump`. Two outcomes:
        //
        //  1. We win the claim. Push the synthetic Exit ourselves.
        //     `exit_pump`'s compare_exchange will fail when it gets there
        //     and it returns without pushing — safe to abort it next.
        //
        //  2. `exit_pump` already won. Its push may still be yielding on
        //     a saturated queue. Wait for the task to finish so the Exit
        //     actually reaches the queue, with a bounded timeout so a
        //     stuck drainer cannot hang teardown.
        let we_claimed_dispatch = exec_box
            .exit_dispatched
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        let exit_pump_handle = exec_box.exit_pump_handle.lock().unwrap().take();
        if we_claimed_dispatch {
            if let Some((cb, ud)) = exec_box.exit_dispatch.lock().unwrap().take() {
                let queue = exec_box.queue.clone();
                exec_box.tokio_rt.block_on(async move {
                    push_event(
                        &queue,
                        RuntimeEvent::Exit {
                            cb,
                            user_data: ud,
                            exit_code: EXIT_CODE_FORCE_CLOSED,
                        },
                    )
                    .await;
                });
            }
            // exit_pump (if any) lost the race; aborting it is safe — it
            // will not push because compare_exchange failed.
            if let Some(pump) = exit_pump_handle {
                pump.abort();
            }
        } else if let Some(pump) = exit_pump_handle {
            // exit_pump claimed; wait (bounded) for its push to complete.
            // Without this, aborting mid-yield would lose the Exit event.
            const EXIT_PUMP_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
            let _ = exec_box
                .tokio_rt
                .block_on(async move { tokio::time::timeout(EXIT_PUMP_WAIT, pump).await });
        }

        drop(exec_box);
    }
}

// ─── Pump tasks ────────────────────────────────────────────────────────────

async fn stdout_pump<S>(
    mut stream: S,
    cb: CBoxStdoutFn,
    user_data_addr: usize,
    queue: Arc<EventQueue>,
    done_tx: oneshot::Sender<()>,
) where
    S: futures::Stream<Item = String> + Unpin,
{
    while let Some(chunk) = stream.next().await {
        push_event(
            &queue,
            RuntimeEvent::Stdout {
                cb,
                user_data: user_data_addr,
                data: chunk.into_bytes(),
            },
        )
        .await;
    }
    // Signal the exit pump we're done. Failure (rx dropped) means exit_pump
    // already completed or was never registered — either way harmless.
    let _ = done_tx.send(());
}

async fn stderr_pump<S>(
    mut stream: S,
    cb: CBoxStderrFn,
    user_data_addr: usize,
    queue: Arc<EventQueue>,
    done_tx: oneshot::Sender<()>,
) where
    S: futures::Stream<Item = String> + Unpin,
{
    while let Some(chunk) = stream.next().await {
        push_event(
            &queue,
            RuntimeEvent::Stderr {
                cb,
                user_data: user_data_addr,
                data: chunk.into_bytes(),
            },
        )
        .await;
    }
    let _ = done_tx.send(());
}

async fn exit_pump(
    exec_arc: Arc<Mutex<Option<Execution>>>,
    cb: CBoxExitFn,
    user_data_addr: usize,
    queue: Arc<EventQueue>,
    process_completed: Arc<AtomicBool>,
    exit_dispatched: Arc<AtomicBool>,
    stream_dones: Vec<oneshot::Receiver<()>>,
) {
    let exit_code = wait_on_clone(&exec_arc).await.unwrap_or(-1);
    // Drain stream pumps before pushing Exit so Exit is the strictly-last
    // event for this execution; the Go SDK relies on this to safely delete
    // the shared cgo.Handle in its exit handler. Aborted pumps drop their
    // tx → rx.await returns Err → harmless.
    for rx in stream_dones {
        let _ = rx.await;
    }
    process_completed.store(true, Ordering::Release);
    // Claim the Exit dispatch slot. If `execution_free` already won the
    // race (force-close before natural exit propagated), we silently
    // skip; the queue must contain exactly one Exit per execution.
    if exit_dispatched
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    push_event(
        &queue,
        RuntimeEvent::Exit {
            cb,
            user_data: user_data_addr,
            exit_code,
        },
    )
    .await;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/// Take a snapshot clone of the underlying Execution so multiple async ops
/// can call `wait`/`kill`/`resize_tty` against the same backend without
/// tripping borrow rules. `Execution` is internally `Arc<Mutex<...>>`, so
/// the clone shares state with the original.
fn snapshot_execution(slot: &Mutex<Option<Execution>>) -> Result<Execution, BoxliteError> {
    let guard = slot.lock().unwrap();
    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| BoxliteError::InvalidState("execution has been freed".to_string()))
}

async fn wait_on_clone(slot: &Mutex<Option<Execution>>) -> Result<i32, BoxliteError> {
    let clone = snapshot_execution(slot)?;
    clone.wait().await.map(|status| status.exit_code)
}

async fn kill_on_clone(slot: &Mutex<Option<Execution>>) -> Result<(), BoxliteError> {
    let mut clone = snapshot_execution(slot)?;
    clone.kill().await
}

async fn resize_on_clone(
    slot: &Mutex<Option<Execution>>,
    rows: u32,
    cols: u32,
) -> Result<(), BoxliteError> {
    let clone = snapshot_execution(slot)?;
    clone.resize_tty(rows, cols).await
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::ffi::CString;
    use std::ptr;

    use super::*;
    use crate::event_queue::EventQueue;
    use std::sync::Arc;

    extern "C" fn noop_stdout(_: *const u8, _: usize, _: *mut c_void) {}
    extern "C" fn noop_unit(_: *mut FFIError, _: *mut c_void) {}
    extern "C" fn noop_wait(_: c_int, _: *mut FFIError, _: *mut c_void) {}

    fn empty_handle() -> ExecutionHandle {
        let runtime = crate::runtime::create_tokio_runtime().expect("runtime");
        ExecutionHandle {
            execution: Arc::new(Mutex::new(None)),
            stdin: None,
            pending_stdout: None,
            pending_stderr: None,
            pumps: Mutex::new(Vec::new()),
            exit_pump_handle: Mutex::new(None),
            stream_done_rx: Mutex::new(Vec::new()),
            exit_dispatch: Mutex::new(None),
            queue: Arc::new(EventQueue::new()),
            tokio_rt: runtime,
            process_completed: Arc::new(AtomicBool::new(false)),
            exit_dispatched: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn box_exec_rejects_null_handle() {
        let command = CString::new("/bin/sh").expect("command cstring");
        let cmd = BoxliteCommand {
            command: command.as_ptr(),
            args: ptr::null(),
            argc: 0,
            env_pairs: ptr::null(),
            env_count: 0,
            workdir: ptr::null(),
            user: ptr::null(),
            timeout_secs: 0.0,
            tty: 1,
        };
        let mut execution: *mut ExecutionHandle = ptr::null_mut();
        let mut error = FFIError::default();

        let code = unsafe {
            boxlite_box_exec(
                ptr::null_mut(),
                &cmd as *const _,
                &mut execution as *mut _,
                &mut error as *mut _,
            )
        };

        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(execution.is_null());
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    #[test]
    fn write_stdin_rejects_null_execution() {
        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_execution_write_stdin(ptr::null_mut(), b"hello".as_ptr(), 5, &mut error)
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    #[test]
    fn write_stdin_rejects_closed_stdin() {
        let mut handle = empty_handle();
        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_execution_write_stdin(&mut handle as *mut _, b"hello".as_ptr(), 5, &mut error)
        };
        assert_eq!(code, BoxliteErrorCode::InvalidState);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    #[test]
    fn resize_rejects_invalid_dimensions() {
        let mut handle = empty_handle();
        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_execution_resize_tty(
                &mut handle as *mut _,
                0,
                80,
                Some(noop_unit),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    #[test]
    fn register_stdout_rejects_null() {
        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_execution_on_stdout(
                ptr::null_mut(),
                Some(noop_stdout),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    #[test]
    fn register_stdout_rejects_double_register() {
        let mut handle = empty_handle();
        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_execution_on_stdout(
                &mut handle as *mut _,
                Some(noop_stdout),
                ptr::null_mut(),
                &mut error,
            )
        };
        // pending_stdout is None on the empty handle so this returns InvalidState.
        assert_eq!(code, BoxliteErrorCode::InvalidState);
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    #[test]
    fn wait_rejects_null_execution() {
        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_execution_wait(
                ptr::null_mut(),
                Some(noop_wait),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    #[test]
    fn kill_rejects_null_execution() {
        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_execution_kill(
                ptr::null_mut(),
                Some(noop_unit),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    // The end-to-end regression guard for the wait-vs-kill deadlock lives
    // in `src/boxlite/src/litebox/exec.rs::tests::wait_does_not_block_kill`,
    // where `ExecBackend` is in scope and a real `Execution` can be
    // constructed against a stub backend. Reproducing it here would require
    // duplicating the stub-backend infrastructure.

    // ─── Exit dispatch must be single-claim under concurrent free + pump ─
    //
    // `execution_free` and `exit_pump` both attempt to push the per-
    // execution Exit event. Without an atomic claim, both can fire and
    // the queue ends up with two Exit events for the same execution.
    // The Go SDK's exit callback deletes the shared `cgo.Handle` after
    // the first; the second tries to Value() a freed handle and panics
    // the drain goroutine.
    //
    // The fix applies a `compare_exchange(false, true, AcqRel, Acquire)`
    // claim on a per-execution `exit_dispatched: AtomicBool` in BOTH
    // production paths. The reproducer below verifies the primitive
    // directly; integration coverage with a real `Execution` is in
    // boxlite/src/litebox/exec.rs::tests.

    use crate::event_queue::{RuntimeEvent, push_event};
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    const RACE_MARKER_UD: usize = 0xBEEF_DEAD_BEEF_DEAD;

    extern "C" fn race_exit_cb(_: c_int, _: *mut c_void) {}

    /// Mirrors the fix's claim-once exit dispatcher: at most one of N
    /// concurrent invocations may push the Exit event for a given
    /// execution. Both production code paths (`execution_free`'s
    /// synth-Exit push and `exit_pump`'s Exit push) apply the same
    /// `compare_exchange(false, true, AcqRel, Acquire)` primitive on
    /// the per-execution `exit_dispatched: AtomicBool`.
    async fn dispatch_exit_test_helper(
        queue: &Arc<EventQueue>,
        dispatched: &Arc<AtomicBool>,
        exit_code: c_int,
    ) {
        if dispatched
            .compare_exchange(false, true, AtomicOrdering::AcqRel, AtomicOrdering::Acquire)
            .is_err()
        {
            return;
        }
        push_event(
            queue,
            RuntimeEvent::Exit {
                cb: race_exit_cb,
                user_data: RACE_MARKER_UD,
                exit_code,
            },
        )
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn race_produces_at_most_one_exit_event() {
        let queue = Arc::new(EventQueue::new());
        let dispatched = Arc::new(AtomicBool::new(false));

        let q1 = queue.clone();
        let d1 = dispatched.clone();
        let t1 = tokio::spawn(async move {
            dispatch_exit_test_helper(&q1, &d1, 0).await;
        });

        let q2 = queue.clone();
        let d2 = dispatched.clone();
        let t2 = tokio::spawn(async move {
            dispatch_exit_test_helper(&q2, &d2, EXIT_CODE_FORCE_CLOSED).await;
        });

        let _ = tokio::join!(t1, t2);

        let events: Vec<RuntimeEvent> = {
            let mut g = queue.inner.lock().unwrap();
            g.drain(..).collect()
        };
        let exit_count = events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    RuntimeEvent::Exit { user_data, .. } if *user_data == RACE_MARKER_UD
                )
            })
            .count();

        assert_eq!(
            exit_count, 1,
            "expected exactly 1 Exit event for {RACE_MARKER_UD:#x}, got {exit_count} \
             (race between exit_pump and execution_free produced duplicate dispatch)",
        );
        // The claim-once primitive must have flipped exactly once.
        assert!(
            dispatched.load(AtomicOrdering::Acquire),
            "exit_dispatched flag was never claimed",
        );
    }

    // ─── Stream pumps must forward chunks byte-exact ─────────────────────
    //
    // The upstream contract from `boxlite::portal::interfaces::exec::
    // route_output` is `String::from_utf8_lossy(&chunk.data).to_string()` —
    // raw byte chunks (UTF-8 lossy decoded), forwarded as-is, with NO
    // line splitting and NO newline stripping. The chunks are arbitrary
    // boundaries, not lines.
    //
    // If the pumps appended `b'\n'` to every chunk, callers would see:
    //   - `printf hello` (no trailing newline) → `hello\n` instead of `hello`.
    //   - A 1024-byte buffer split into two gRPC chunks → an extra `\n` at
    //     the chunk boundary, splitting contiguous producer bytes.
    //   - Binary or protocol output → arbitrary `\x0a` injection.

    use futures::stream::iter as stream_iter;

    extern "C" fn noop_stdout_cb(_: *const u8, _: usize, _: *mut c_void) {}
    extern "C" fn noop_stderr_cb(_: *const u8, _: usize, _: *mut c_void) {}

    fn drain_stdout_bytes(queue: &Arc<EventQueue>) -> Vec<Vec<u8>> {
        let events: Vec<RuntimeEvent> = {
            let mut g = queue.inner.lock().unwrap();
            g.drain(..).collect()
        };
        events
            .into_iter()
            .filter_map(|e| match e {
                RuntimeEvent::Stdout { data, .. } => Some(data),
                _ => None,
            })
            .collect()
    }

    fn drain_stderr_bytes(queue: &Arc<EventQueue>) -> Vec<Vec<u8>> {
        let events: Vec<RuntimeEvent> = {
            let mut g = queue.inner.lock().unwrap();
            g.drain(..).collect()
        };
        events
            .into_iter()
            .filter_map(|e| match e {
                RuntimeEvent::Stderr { data, .. } => Some(data),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn stdout_pump_forwards_chunks_byte_exact() {
        let queue = Arc::new(EventQueue::new());
        let (done_tx, _done_rx) = oneshot::channel::<()>();
        let chunks = vec![
            "hello".to_string(),                    // no trailing \n
            "world".to_string(),                    // boundary chunk
            "with\ninternal\nnewlines".to_string(), // already-newlined
            "tab\there\x00null".to_string(),        // control bytes
        ];
        let stream = stream_iter(chunks.into_iter());

        stdout_pump(stream, noop_stdout_cb, 0xFEED_DEAD, queue.clone(), done_tx).await;

        let bytes = drain_stdout_bytes(&queue);
        assert_eq!(bytes.len(), 4, "expected 4 stdout events");
        assert_eq!(
            bytes[0], b"hello",
            "chunk 0 must be forwarded byte-exact (no trailing \\n appended). \
             Got {:?}",
            bytes[0]
        );
        assert_eq!(bytes[1], b"world");
        assert_eq!(bytes[2], b"with\ninternal\nnewlines");
        assert_eq!(
            bytes[3],
            "tab\there\x00null".as_bytes(),
            "control-byte chunk corrupted",
        );
    }

    #[tokio::test]
    async fn stderr_pump_forwards_chunks_byte_exact() {
        let queue = Arc::new(EventQueue::new());
        let (done_tx, _done_rx) = oneshot::channel::<()>();
        let chunks = vec!["error".to_string(), "trace".to_string()];
        let stream = stream_iter(chunks.into_iter());

        stderr_pump(stream, noop_stderr_cb, 0xCAFE_BABE, queue.clone(), done_tx).await;

        let bytes = drain_stderr_bytes(&queue);
        assert_eq!(bytes.len(), 2);
        assert_eq!(
            bytes[0], b"error",
            "stderr chunk 0 must be forwarded byte-exact (no trailing \\n). \
             Got {:?}",
            bytes[0]
        );
        assert_eq!(bytes[1], b"trace");
    }

    use std::sync::atomic::Ordering as ProcessCompletedOrdering;

    // ─── Errored wait must NOT mark process_completed ────────────────
    //
    // execution_free reads `process_completed` to skip its kill+wait
    // cleanup path. A failed wait is NOT proof the guest process
    // exited — for untrusted/sandboxed code, an Err wait may mean the
    // backend lost the connection while the process is still running.
    // If `_wait`'s spawned task wrote `process_completed=true`
    // unconditionally, an errored wait would leave a live process
    // running with no termination on free.

    #[test]
    fn execution_wait_must_not_mark_process_completed_on_error() {
        let mut handle = empty_handle();
        let process_completed = handle.process_completed.clone();

        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_execution_wait(
                &mut handle as *mut _,
                Some(noop_wait),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::Ok);

        // Empty handle's wait_on_clone returns Err(InvalidState)
        // synchronously — give the spawned task a moment to complete.
        std::thread::sleep(std::time::Duration::from_millis(100));

        assert!(
            !process_completed.load(ProcessCompletedOrdering::Acquire),
            "process_completed MUST stay false after an errored wait. A \
             failed wait is NOT proof the guest process exited; setting \
             the flag would let execution_free skip its kill+wait cleanup \
             on a still-running command (security risk for \
             untrusted/sandboxed processes)."
        );

        unsafe {
            crate::boxlite_error_free(&mut error as *mut _);
        }
    }

    // Success-case wait coverage lives in boxlite/src/litebox/exec.rs::tests
    // (requires a stub ExecBackend that can produce Ok results, and
    // `Execution::new`/`ExecBackend` are pub(crate) in the boxlite crate).
}
