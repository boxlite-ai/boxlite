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
    /// Spawned pumps; aborted on `_free`.
    pumps: Mutex<Vec<JoinHandle<()>>>,
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
    completed: Arc<Mutex<bool>>,
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
                    stream_done_rx: Mutex::new(Vec::new()),
                    exit_dispatch: Mutex::new(None),
                    queue: handle_ref.queue.clone(),
                    tokio_rt: handle_ref.tokio_rt.clone(),
                    completed: Arc::new(Mutex::new(false)),
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
        let completed = exec_ref.completed.clone();
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
            completed,
            stream_dones,
        ));
        exec_ref.pumps.lock().unwrap().push(pump);
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

        exec_ref.tokio_rt.spawn(async move {
            let result = wait_on_clone(&exec_arc).await;
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
        let completed = *exec_box.completed.lock().unwrap();
        if !completed {
            let exec_arc = exec_box.execution.clone();
            let _ = exec_box.tokio_rt.block_on(async move {
                let _ = kill_on_clone(&exec_arc).await;
                wait_on_clone(&exec_arc).await
            });
            // The exit pump may have been aborted before it pushed Exit.
            // Synthesise an Exit event with `EXIT_CODE_FORCE_CLOSED` so the
            // Go SDK still receives exactly one Exit per execution and can
            // delete the shared cgo.Handle. Push BEFORE aborting pumps so
            // the queue accepts the event.
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
        }

        // Abort pump tasks AFTER the synthetic-Exit push so the exit
        // dispatch is preserved. Stream pumps that haven't drained get
        // their oneshot tx dropped — exit_pump's rx.await sees Err and
        // moves on, no deadlock.
        let pumps = std::mem::take(&mut *exec_box.pumps.lock().unwrap());
        for pump in &pumps {
            pump.abort();
        }

        drop(exec_box);
    }
}

// ─── Pump tasks ────────────────────────────────────────────────────────────

async fn stdout_pump(
    mut stream: ExecStdout,
    cb: CBoxStdoutFn,
    user_data_addr: usize,
    queue: Arc<EventQueue>,
    done_tx: oneshot::Sender<()>,
) {
    while let Some(line) = stream.next().await {
        let mut bytes = line.into_bytes();
        // Restore the line terminator that the upstream stream stripped, so
        // the C consumer reassembles a faithful byte stream.
        bytes.push(b'\n');
        push_event(
            &queue,
            RuntimeEvent::Stdout {
                cb,
                user_data: user_data_addr,
                data: bytes,
            },
        )
        .await;
    }
    // Signal the exit pump we're done. Failure (rx dropped) means exit_pump
    // already completed or was never registered — either way harmless.
    let _ = done_tx.send(());
}

async fn stderr_pump(
    mut stream: ExecStderr,
    cb: CBoxStderrFn,
    user_data_addr: usize,
    queue: Arc<EventQueue>,
    done_tx: oneshot::Sender<()>,
) {
    while let Some(line) = stream.next().await {
        let mut bytes = line.into_bytes();
        bytes.push(b'\n');
        push_event(
            &queue,
            RuntimeEvent::Stderr {
                cb,
                user_data: user_data_addr,
                data: bytes,
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
    completed: Arc<Mutex<bool>>,
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
    *completed.lock().unwrap() = true;
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
            stream_done_rx: Mutex::new(Vec::new()),
            exit_dispatch: Mutex::new(None),
            queue: Arc::new(EventQueue::new()),
            tokio_rt: runtime,
            completed: Arc::new(Mutex::new(false)),
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

    // The end-to-end regression guard for the wait-vs-kill deadlock
    // (Codex round-2 finding #1) lives in
    // `src/boxlite/src/litebox/exec.rs::tests::wait_does_not_block_kill`,
    // where `ExecBackend` is in scope and a real `Execution` can be
    // constructed against a stub backend. That test deadlocks on the
    // unfixed code and passes on the fixed code; reproducing it here
    // would require duplicating the stub-backend infrastructure.
}
