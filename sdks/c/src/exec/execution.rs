use futures::StreamExt;
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;
use tokio::task::JoinHandle;

use boxlite::{BoxliteError, ExecStdin, Execution};

use super::command::{BoxliteCommand, parse_boxlite_command};
use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::{CBoxHandle, CBoxliteError, CExecutionHandle};

pub type OutputCallback = extern "C" fn(*const c_char, c_int, *mut c_void);

/// Opaque handle to a running command execution.
pub struct ExecutionHandle {
    execution: Option<Execution>,
    stdin: Option<ExecStdin>,
    output_task: Option<JoinHandle<()>>,
    completed: bool,
    tokio_rt: Arc<TokioRuntime>,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execute(
    handle: *mut CBoxHandle,
    cmd: *const BoxliteCommand,
    callback: Option<extern "C" fn(*const c_char, c_int, *mut c_void)>,
    user_data: *mut c_void,
    out_execution: *mut *mut CExecutionHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    execute(handle, cmd, callback, user_data, out_execution, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_write(
    execution: *mut CExecutionHandle,
    data: *const c_char,
    len: c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    execution_write(execution, data, len, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_wait(
    execution: *mut CExecutionHandle,
    out_exit_code: *mut c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    execution_wait(execution, out_exit_code, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_kill(
    execution: *mut CExecutionHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    execution_kill(execution, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_resize_tty(
    execution: *mut CExecutionHandle,
    rows: c_int,
    cols: c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    execution_resize_tty(execution, rows, cols, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execution_free(execution: *mut CExecutionHandle) {
    execution_free(execution)
}

unsafe fn execute(
    handle: *mut BoxHandle,
    cmd: *const BoxliteCommand,
    callback: Option<OutputCallback>,
    user_data: *mut c_void,
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

        let handle_ref = &mut *handle;
        let command = match parse_boxlite_command(&*cmd) {
            Ok(command) => command,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                return code;
            }
        };

        let tokio_rt = handle_ref.tokio_rt.clone();
        let execution_rt = tokio_rt.clone();
        let result = tokio_rt.block_on(async {
            let mut execution = handle_ref.handle.exec(command).await?;
            let stdin = execution.stdin();
            let stdout = execution.stdout();
            let stderr = execution.stderr();
            let output_task = spawn_output_task(&tokio_rt, stdout, stderr, callback, user_data);

            Ok::<ExecutionHandle, BoxliteError>(ExecutionHandle {
                execution: Some(execution),
                stdin,
                output_task: Some(output_task),
                completed: false,
                tokio_rt: execution_rt,
            })
        });

        match result {
            Ok(execution) => {
                *out_execution = Box::into_raw(Box::new(execution));
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

fn spawn_output_task(
    tokio_rt: &Arc<TokioRuntime>,
    mut stdout: Option<boxlite::ExecStdout>,
    mut stderr: Option<boxlite::ExecStderr>,
    callback: Option<OutputCallback>,
    user_data: *mut c_void,
) -> JoinHandle<()> {
    let user_data = user_data as usize;
    tokio_rt.spawn(async move {
        loop {
            tokio::select! {
                Some(line) = async {
                    match &mut stdout {
                        Some(stream) => stream.next().await,
                        None => None,
                    }
                } => {
                    write_streaming_output(callback, line, 0, user_data);
                }
                Some(line) = async {
                    match &mut stderr {
                        Some(stream) => stream.next().await,
                        None => None,
                    }
                } => {
                    write_streaming_output(callback, line, 1, user_data);
                }
                else => break,
            }
        }
    })
}

fn write_streaming_output(
    callback: Option<OutputCallback>,
    line: String,
    is_stderr: c_int,
    user_data: usize,
) {
    let Some(callback) = callback else {
        return;
    };

    if let Ok(text) = CString::new(line) {
        callback(text.as_ptr(), is_stderr, user_data as *mut c_void);
    }
}

unsafe fn execution_write(
    execution: *mut ExecutionHandle,
    data: *const c_char,
    len: c_int,
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
        if len < 0 {
            write_error(
                out_error,
                BoxliteError::InvalidArgument("len must be non-negative".to_string()),
            );
            return BoxliteErrorCode::InvalidArgument;
        }
        if len == 0 {
            return BoxliteErrorCode::Ok;
        }

        let execution_ref = &mut *execution;
        let Some(stdin) = execution_ref.stdin.as_mut() else {
            write_error(
                out_error,
                BoxliteError::InvalidState("execution stdin is closed".to_string()),
            );
            return BoxliteErrorCode::InvalidState;
        };

        let bytes = std::slice::from_raw_parts(data.cast::<u8>(), len as usize);
        match execution_ref.tokio_rt.block_on(stdin.write(bytes)) {
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
    out_exit_code: *mut c_int,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if execution.is_null() {
            write_error(out_error, null_pointer_error("execution"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_exit_code.is_null() {
            write_error(out_error, null_pointer_error("out_exit_code"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let execution_ref = &mut *execution;
        let Some(execution) = execution_ref.execution.as_mut() else {
            write_error(
                out_error,
                BoxliteError::InvalidState("execution has been freed".to_string()),
            );
            return BoxliteErrorCode::InvalidState;
        };

        let result = execution_ref.tokio_rt.block_on(async {
            let result = execution.wait().await;
            if let Some(task) = execution_ref.output_task.take() {
                let _ = task.await;
            }
            result
        });

        match result {
            Ok(status) => {
                execution_ref.completed = true;
                *out_exit_code = status.exit_code;
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

unsafe fn execution_kill(
    execution: *mut ExecutionHandle,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if execution.is_null() {
            write_error(out_error, null_pointer_error("execution"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let execution_ref = &mut *execution;
        let Some(execution) = execution_ref.execution.as_mut() else {
            write_error(
                out_error,
                BoxliteError::InvalidState("execution has been freed".to_string()),
            );
            return BoxliteErrorCode::InvalidState;
        };

        match execution_ref.tokio_rt.block_on(execution.kill()) {
            Ok(()) => BoxliteErrorCode::Ok,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

unsafe fn execution_resize_tty(
    execution: *mut ExecutionHandle,
    rows: c_int,
    cols: c_int,
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

        let execution_ref = &mut *execution;
        let Some(execution) = execution_ref.execution.as_ref() else {
            write_error(
                out_error,
                BoxliteError::InvalidState("execution has been freed".to_string()),
            );
            return BoxliteErrorCode::InvalidState;
        };

        match execution_ref
            .tokio_rt
            .block_on(execution.resize_tty(rows as u32, cols as u32))
        {
            Ok(()) => BoxliteErrorCode::Ok,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

unsafe fn execution_free(execution: *mut ExecutionHandle) {
    if execution.is_null() {
        return;
    }

    unsafe {
        let mut execution = Box::from_raw(execution);
        if let Some(mut stdin) = execution.stdin.take() {
            stdin.close();
        }

        if let Some(mut running) = execution.execution.take()
            && !execution.completed
        {
            let _ = execution.tokio_rt.block_on(async {
                let _ = running.kill().await;
                running.wait().await
            });
        }

        if let Some(task) = execution.output_task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ptr;

    use super::*;

    extern "C" fn noop_callback(_: *const c_char, _: c_int, _: *mut c_void) {}

    #[test]
    fn execute_rejects_null_handle() {
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
            boxlite_execute(
                ptr::null_mut(),
                &cmd as *const _,
                Some(noop_callback),
                ptr::null_mut(),
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
    fn execution_write_rejects_null_execution() {
        let mut error = FFIError::default();
        let data = CString::new("hello").expect("data cstring");

        let code = unsafe {
            boxlite_execution_write(ptr::null_mut(), data.as_ptr(), 5, &mut error as *mut _)
        };

        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    #[test]
    fn execution_write_rejects_negative_len() {
        let runtime = crate::runtime::create_tokio_runtime().expect("runtime");
        let mut execution = ExecutionHandle {
            execution: None,
            stdin: None,
            output_task: None,
            completed: false,
            tokio_rt: runtime,
        };
        let mut error = FFIError::default();

        let code = unsafe {
            boxlite_execution_write(
                &mut execution as *mut _,
                ptr::null(),
                -1,
                &mut error as *mut _,
            )
        };

        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    #[test]
    fn execution_resize_rejects_invalid_dimensions() {
        let runtime = crate::runtime::create_tokio_runtime().expect("runtime");
        let mut execution = ExecutionHandle {
            execution: None,
            stdin: None,
            output_task: None,
            completed: false,
            tokio_rt: runtime,
        };
        let mut error = FFIError::default();

        let code = unsafe {
            boxlite_execution_resize_tty(&mut execution as *mut _, 0, 80, &mut error as *mut _)
        };

        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }
}
