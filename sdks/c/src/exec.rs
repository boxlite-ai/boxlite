//! Command execution for the BoxLite C SDK.

use futures::StreamExt;
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;
use tokio::task::JoinHandle;

use boxlite::litebox::LiteBox;
use boxlite::runtime::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use boxlite::{BoxID, BoxliteError, ExecStdin, Execution, RootfsSpec};

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::runtime::create_tokio_runtime;
use crate::util::c_str_to_string;
use crate::{CBoxHandle, CBoxliteError, CBoxliteExecResult, CBoxliteSimple, CExecutionHandle};

/// Opaque handle for Runner API (auto-manages runtime)
pub struct BoxRunner {
    pub runtime: BoxliteRuntime,
    pub handle: Option<LiteBox>,
    pub box_id: Option<BoxID>,
    pub tokio_rt: Arc<TokioRuntime>,
}

/// Result structure for runner command execution
#[repr(C)]
pub struct ExecResult {
    pub exit_code: c_int,
    pub stdout_text: *mut c_char,
    pub stderr_text: *mut c_char,
}

/// Opaque handle to a running command execution.
pub struct ExecutionHandle {
    execution: Option<Execution>,
    stdin: Option<ExecStdin>,
    output_task: Option<JoinHandle<()>>,
    completed: bool,
    tokio_rt: Arc<TokioRuntime>,
}

impl BoxRunner {
    pub fn new(
        runtime: BoxliteRuntime,
        handle: LiteBox,
        box_id: BoxID,
        tokio_rt: Arc<TokioRuntime>,
    ) -> Self {
        Self {
            runtime,
            handle: Some(handle),
            box_id: Some(box_id),
            tokio_rt,
        }
    }
}

pub type OutputCallback = extern "C" fn(*const c_char, c_int, *mut c_void);

/// C-compatible command descriptor with all BoxCommand options.
///
/// All string fields are nullable — NULL means "use default".
/// `timeout_secs` of 0.0 means no timeout.
#[repr(C)]
pub struct BoxliteCommand {
    /// Command to execute (required, must not be NULL).
    pub command: *const c_char,
    /// Array of argument strings. NULL = no args.
    pub args: *const *const c_char,
    /// Number of arguments in `args`.
    pub argc: c_int,
    /// Array of env var pairs: [key0, val0, key1, val1, ...]. NULL = inherit env.
    pub env_pairs: *const *const c_char,
    /// Number of strings in `env_pairs`; odd trailing values are ignored.
    pub env_count: c_int,
    /// Working directory inside the container. NULL = container default.
    pub workdir: *const c_char,
    /// User spec (e.g., "nobody", "1000:1000"). NULL = container default.
    pub user: *const c_char,
    /// Timeout in seconds. 0.0 = no timeout.
    pub timeout_secs: f64,
    /// Enable TTY mode for interactive programs.
    pub tty: c_int,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execute(
    handle: *mut CBoxHandle,
    command: *const c_char,
    args: *const *const c_char,
    argc: c_int,
    callback: Option<extern "C" fn(*const c_char, c_int, *mut c_void)>,
    user_data: *mut c_void,
    out_exit_code: *mut c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_exec(
        handle,
        command,
        args,
        argc,
        callback,
        user_data,
        out_exit_code,
        out_error,
    )
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execute_cmd(
    handle: *mut CBoxHandle,
    cmd: *const BoxliteCommand,
    callback: Option<extern "C" fn(*const c_char, c_int, *mut c_void)>,
    user_data: *mut c_void,
    out_exit_code: *mut c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_exec_cmd(handle, cmd, callback, user_data, out_exit_code, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_exec_start(
    handle: *mut CBoxHandle,
    cmd: *const BoxliteCommand,
    callback: Option<extern "C" fn(*const c_char, c_int, *mut c_void)>,
    user_data: *mut c_void,
    out_execution: *mut *mut CExecutionHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    exec_start(handle, cmd, callback, user_data, out_execution, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_exec_write(
    execution: *mut CExecutionHandle,
    data: *const c_char,
    len: c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    exec_write(execution, data, len, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_exec_wait(
    execution: *mut CExecutionHandle,
    out_exit_code: *mut c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    exec_wait(execution, out_exit_code, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_exec_kill(
    execution: *mut CExecutionHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    exec_kill(execution, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_exec_resize_tty(
    execution: *mut CExecutionHandle,
    rows: c_int,
    cols: c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    exec_resize_tty(execution, rows, cols, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_exec_free(execution: *mut CExecutionHandle) {
    exec_free(execution)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_simple_new(
    image: *const c_char,
    cpus: c_int,
    memory_mib: c_int,
    out_box: *mut *mut CBoxliteSimple,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    runner_new(image, cpus, memory_mib, out_box, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_simple_run(
    box_runner: *mut CBoxliteSimple,
    command: *const c_char,
    args: *const *const c_char,
    argc: c_int,
    out_result: *mut *mut CBoxliteExecResult,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    runner_exec(box_runner, command, args, argc, out_result, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_simple_free(box_runner: *mut CBoxliteSimple) {
    runner_free(box_runner)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_result_free(result: *mut CBoxliteExecResult) {
    result_free(result)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_exec_result_free(result: *mut CBoxliteExecResult) {
    result_free(result)
}

unsafe fn box_exec(
    handle: *mut BoxHandle,
    command: *const c_char,
    args: *const *const c_char,
    argc: c_int,
    callback: Option<OutputCallback>,
    user_data: *mut c_void,
    out_exit_code: *mut c_int,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        if out_exit_code.is_null() {
            write_error(out_error, null_pointer_error("out_exit_code"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &mut *handle;

        // Parse command
        let cmd_str = match c_str_to_string(command) {
            Ok(s) => s,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                return code;
            }
        };

        let mut cmd = boxlite::BoxCommand::new(cmd_str);
        cmd = cmd.args(crate::util::parse_c_string_array(args, argc));

        // Execute command using new API
        let result = handle_ref.tokio_rt.block_on(async {
            let mut execution = handle_ref.handle.exec(cmd).await?;

            // Stream output to callback if provided
            if let Some(cb) = callback {
                // Take stdout and stderr
                let mut stdout = execution.stdout();
                let mut stderr = execution.stderr();

                // Read both streams
                loop {
                    tokio::select! {
                        Some(line) = async {
                            match &mut stdout {
                                Some(s) => s.next().await,
                                None => None,
                            }
                        } => {
                            let c_text = CString::new(line).unwrap_or_default();
                            cb(c_text.as_ptr(), 0, user_data); // 0 = stdout
                        }
                        Some(line) = async {
                            match &mut stderr {
                                Some(s) => s.next().await,
                                None => None,
                            }
                        } => {
                            let c_text = CString::new(line).unwrap_or_default();
                            cb(c_text.as_ptr(), 1, user_data); // 1 = stderr
                        }
                        else => break,
                    }
                }
            }
            // Now wait for completion (should not deadlock due to output backpressure)
            let status = execution.wait().await?;
            Ok::<i32, BoxliteError>(status.exit_code)
        });

        match result {
            Ok(exit_code) => {
                *out_exit_code = exit_code;
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

unsafe fn box_exec_cmd(
    handle: *mut BoxHandle,
    cmd: *const BoxliteCommand,
    callback: Option<OutputCallback>,
    user_data: *mut c_void,
    out_exit_code: *mut c_int,
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

        if out_exit_code.is_null() {
            write_error(out_error, null_pointer_error("out_exit_code"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let cmd_ref = &*cmd;
        let handle_ref = &mut *handle;
        let box_cmd = match parse_boxlite_command(cmd_ref) {
            Ok(command) => command,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                return code;
            }
        };

        // Execute command
        let result = handle_ref.tokio_rt.block_on(async {
            let mut execution = handle_ref.handle.exec(box_cmd).await?;

            if let Some(cb) = callback {
                let mut stdout = execution.stdout();
                let mut stderr = execution.stderr();

                loop {
                    tokio::select! {
                        Some(line) = async {
                            match &mut stdout {
                                Some(s) => s.next().await,
                                None => None,
                            }
                        } => {
                            let c_text = CString::new(line).unwrap_or_default();
                            cb(c_text.as_ptr(), 0, user_data);
                        }
                        Some(line) = async {
                            match &mut stderr {
                                Some(s) => s.next().await,
                                None => None,
                            }
                        } => {
                            let c_text = CString::new(line).unwrap_or_default();
                            cb(c_text.as_ptr(), 1, user_data);
                        }
                        else => break,
                    }
                }
            }
            let status = execution.wait().await?;
            Ok::<i32, BoxliteError>(status.exit_code)
        });

        match result {
            Ok(exit_code) => {
                *out_exit_code = exit_code;
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

unsafe fn exec_start(
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

unsafe fn exec_write(
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

        let bytes = std::slice::from_raw_parts(data as *const u8, len as usize);
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

unsafe fn exec_wait(
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

unsafe fn exec_kill(execution: *mut ExecutionHandle, out_error: *mut FFIError) -> BoxliteErrorCode {
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

unsafe fn exec_resize_tty(
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

unsafe fn exec_free(execution: *mut ExecutionHandle) {
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

unsafe fn parse_boxlite_command(cmd: &BoxliteCommand) -> Result<boxlite::BoxCommand, BoxliteError> {
    unsafe {
        let cmd_str = c_str_to_string(cmd.command)?;
        let mut box_cmd = boxlite::BoxCommand::new(cmd_str)
            .args(crate::util::parse_c_string_array(cmd.args, cmd.argc));

        let env_pairs = crate::util::parse_c_string_array(cmd.env_pairs, cmd.env_count);
        for pair in env_pairs.chunks(2) {
            if let [key, value] = pair {
                box_cmd = box_cmd.env(key.clone(), value.clone());
            }
        }

        if !cmd.workdir.is_null() {
            box_cmd = box_cmd.working_dir(c_str_to_string(cmd.workdir)?);
        }

        if !cmd.user.is_null() {
            box_cmd = box_cmd.user(c_str_to_string(cmd.user)?);
        }

        if cmd.timeout_secs > 0.0 {
            box_cmd = box_cmd.timeout(std::time::Duration::from_secs_f64(cmd.timeout_secs));
        }

        if cmd.tty != 0 {
            box_cmd = box_cmd.tty(true);
        }

        Ok(box_cmd)
    }
}

unsafe fn runner_new(
    image: *const c_char,
    cpus: c_int,
    memory_mib: c_int,
    out_runner: *mut *mut BoxRunner,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if image.is_null() {
            write_error(out_error, null_pointer_error("image"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_runner.is_null() {
            write_error(out_error, null_pointer_error("out_runner"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let image_str = match c_str_to_string(image) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let tokio_rt = match create_tokio_runtime() {
            Ok(rt) => rt,
            Err(e) => {
                let err = BoxliteError::Internal(format!("Failed to create async runtime: {}", e));
                write_error(out_error, err);
                return BoxliteErrorCode::Internal;
            }
        };

        let runtime = match BoxliteRuntime::new(BoxliteOptions::default()) {
            Ok(rt) => rt,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::Internal;
            }
        };

        let options = BoxOptions {
            rootfs: RootfsSpec::Image(image_str),
            cpus: if cpus > 0 { Some(cpus as u8) } else { None },
            memory_mib: if memory_mib > 0 {
                Some(memory_mib as u32)
            } else {
                None
            },
            ..Default::default()
        };

        let result = tokio_rt.block_on(async {
            let handle = runtime.create(options, None).await?;
            let box_id = handle.id().clone();
            Ok::<(LiteBox, BoxID), BoxliteError>((handle, box_id))
        });

        match result {
            Ok((handle, box_id)) => {
                let runner = Box::new(BoxRunner::new(runtime, handle, box_id, tokio_rt));
                *out_runner = Box::into_raw(runner);
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

unsafe fn runner_exec(
    runner: *mut BoxRunner,
    command: *const c_char,
    args: *const *const c_char,
    argc: c_int,
    out_result: *mut *mut ExecResult,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runner.is_null() {
            write_error(out_error, null_pointer_error("runner"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if command.is_null() {
            write_error(out_error, null_pointer_error("command"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_result.is_null() {
            write_error(out_error, null_pointer_error("out_result"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runner_ref = &mut *runner;

        let cmd_str = match c_str_to_string(command) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let mut arg_vec = Vec::new();
        if !args.is_null() {
            for i in 0..argc {
                let arg_ptr = *args.offset(i as isize);
                if arg_ptr.is_null() {
                    break;
                }
                match c_str_to_string(arg_ptr) {
                    Ok(s) => arg_vec.push(s),
                    Err(e) => {
                        write_error(out_error, e);
                        return BoxliteErrorCode::InvalidArgument;
                    }
                }
            }
        }

        let handle = match &runner_ref.handle {
            Some(h) => h,
            None => {
                write_error(
                    out_error,
                    BoxliteError::InvalidState("Box not initialized".to_string()),
                );
                return BoxliteErrorCode::InvalidState;
            }
        };

        let result = runner_ref.tokio_rt.block_on(async {
            let mut cmd = boxlite::BoxCommand::new(cmd_str);
            cmd = cmd.args(arg_vec);

            let mut execution = handle.exec(cmd).await?;

            let mut stdout_lines = Vec::new();
            let mut stderr_lines = Vec::new();

            let mut stdout_stream = execution.stdout();
            let mut stderr_stream = execution.stderr();

            loop {
                tokio::select! {
                    Some(line) = async {
                        match &mut stdout_stream {
                            Some(s) => s.next().await,
                            None => None,
                        }
                    } => {
                        stdout_lines.push(line);
                    }
                    Some(line) = async {
                        match &mut stderr_stream {
                            Some(s) => s.next().await,
                            None => None,
                        }
                    } => {
                        stderr_lines.push(line);
                    }
                    else => break,
                }
            }

            let status = execution.wait().await?;

            Ok::<(i32, String, String), BoxliteError>((
                status.exit_code,
                stdout_lines.join("\n"),
                stderr_lines.join("\n"),
            ))
        });

        match result {
            Ok((exit_code, stdout, stderr)) => {
                let stdout_c = match CString::new(stdout) {
                    Ok(s) => s.into_raw(),
                    Err(_) => ptr::null_mut(),
                };
                let stderr_c = match CString::new(stderr) {
                    Ok(s) => s.into_raw(),
                    Err(_) => ptr::null_mut(),
                };

                let exec_result = Box::new(ExecResult {
                    exit_code,
                    stdout_text: stdout_c,
                    stderr_text: stderr_c,
                });
                *out_result = Box::into_raw(exec_result);
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

unsafe fn result_free(result: *mut ExecResult) {
    if !result.is_null() {
        unsafe {
            let result_box = Box::from_raw(result);
            if !result_box.stdout_text.is_null() {
                drop(CString::from_raw(result_box.stdout_text));
            }
            if !result_box.stderr_text.is_null() {
                drop(CString::from_raw(result_box.stderr_text));
            }
        }
    }
}

unsafe fn runner_free(runner: *mut BoxRunner) {
    if !runner.is_null() {
        unsafe {
            let mut runner_box = Box::from_raw(runner);

            if let Some(handle) = runner_box.handle.take() {
                let _ = runner_box.tokio_rt.block_on(handle.stop());
            }

            if let Some(box_id) = runner_box.box_id.take() {
                let _ = runner_box
                    .tokio_rt
                    .block_on(runner_box.runtime.remove(box_id.as_ref(), true));
            }

            drop(runner_box);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ptr;

    use super::*;

    extern "C" fn noop_callback(_: *const c_char, _: c_int, _: *mut c_void) {}

    #[test]
    fn exec_start_rejects_null_handle() {
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
            boxlite_exec_start(
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
    fn exec_write_rejects_null_execution() {
        let mut error = FFIError::default();
        let data = CString::new("hello").expect("data cstring");

        let code =
            unsafe { boxlite_exec_write(ptr::null_mut(), data.as_ptr(), 5, &mut error as *mut _) };

        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }

    #[test]
    fn exec_write_rejects_negative_len() {
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
            boxlite_exec_write(
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
    fn exec_resize_rejects_invalid_dimensions() {
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
            boxlite_exec_resize_tty(&mut execution as *mut _, 0, 80, &mut error as *mut _)
        };

        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };
    }
}
