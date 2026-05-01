use futures::StreamExt;
use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::litebox::LiteBox;
use boxlite::runtime::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use boxlite::{BoxID, BoxliteError, RootfsSpec};

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::runtime::create_tokio_runtime;
use crate::util::c_str_to_string;
use crate::{CBoxliteError, CBoxliteExecResult, CBoxliteSimple};

/// Opaque handle for Runner API (auto-manages runtime)
pub struct BoxRunner {
    pub runtime: BoxliteRuntime,
    pub handle: Option<LiteBox>,
    pub box_id: Option<BoxID>,
    pub tokio_rt: Arc<TokioRuntime>,
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

/// Result structure for runner command execution
#[repr(C)]
pub struct ExecResult {
    pub exit_code: c_int,
    pub stdout_text: *mut c_char,
    pub stderr_text: *mut c_char,
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
