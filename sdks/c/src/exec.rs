//! Command execution for the BoxLite C SDK.

use futures::StreamExt;
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::litebox::LiteBox;
use boxlite::runtime::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use boxlite::{BoxID, BoxliteError, RootfsSpec};

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::runtime::create_tokio_runtime;
use crate::util::c_str_to_string;
use crate::{CBoxHandle, CBoxliteError, CBoxliteExecResult, CBoxliteSimple};

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

        let handle_ref = &mut *handle;
        let cmd_ref = &*cmd;

        // Parse command (required)
        let cmd_str = match c_str_to_string(cmd_ref.command) {
            Ok(s) => s,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                return code;
            }
        };

        let mut box_cmd = boxlite::BoxCommand::new(cmd_str);
        box_cmd = box_cmd.args(crate::util::parse_c_string_array(
            cmd_ref.args,
            cmd_ref.argc,
        ));

        let env_pairs = crate::util::parse_c_string_array(cmd_ref.env_pairs, cmd_ref.env_count);
        for pair in env_pairs.chunks(2) {
            if let [key, value] = pair {
                box_cmd = box_cmd.env(key.clone(), value.clone());
            }
        }

        // Parse workdir
        if !cmd_ref.workdir.is_null() {
            match c_str_to_string(cmd_ref.workdir) {
                Ok(dir) => {
                    box_cmd = box_cmd.working_dir(dir);
                }
                Err(e) => {
                    let code = error_to_code(&e);
                    write_error(out_error, e);
                    return code;
                }
            }
        }

        // Parse user
        if !cmd_ref.user.is_null() {
            match c_str_to_string(cmd_ref.user) {
                Ok(u) => {
                    box_cmd = box_cmd.user(u);
                }
                Err(e) => {
                    let code = error_to_code(&e);
                    write_error(out_error, e);
                    return code;
                }
            }
        }

        // Parse timeout
        if cmd_ref.timeout_secs > 0.0 {
            box_cmd = box_cmd.timeout(std::time::Duration::from_secs_f64(cmd_ref.timeout_secs));
        }

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
