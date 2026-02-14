//! Core FFI operations for BoxLite
//!
//! This module contains the internal implementation of FFI operations.
//! These functions are called by the SDK-specific FFI exports.

use futures::StreamExt;
use std::ffi::{CString, c_void};
use std::os::raw::{c_char, c_int};
use std::ptr;

use boxlite::litebox::LiteBox;
use boxlite::runtime::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use boxlite::runtime::types::BoxID;
use boxlite::{BoxliteError, RootfsSpec};

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::json::box_info_to_json;
use crate::runtime::{BoxHandle, RuntimeHandle, create_tokio_runtime};
use crate::string::c_str_to_string;

/// Create a new BoxliteRuntime
///
/// # Parameters
/// * `home_dir`: Optional path to home directory (or null for default `~/.boxlite`)
/// * `registries_json`: Optional JSON array of registry URLs (or null)
/// * `out_runtime`: Output pointer for the created `RuntimeHandle`
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// This function initializes both the Tokio runtime and the BoxLite runtime.
/// It parses the optional `home_dir` and `registries_json` arguments.
/// If `registries_json` is provided, it attempts to parse it as a JSON array of strings.
///
/// # Safety
/// All pointer parameters must be valid or null. `out_runtime` must be a valid pointer to a pointer.
pub unsafe fn runtime_new(
    home_dir: *const c_char,
    registries_json: *const c_char,
    out_runtime: *mut *mut RuntimeHandle,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if out_runtime.is_null() {
            write_error(out_error, null_pointer_error("out_runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        // Create tokio runtime
        let tokio_rt = match create_tokio_runtime() {
            Ok(rt) => rt,
            Err(e) => {
                let err = BoxliteError::Internal(e);
                write_error(out_error, err);
                return BoxliteErrorCode::Internal;
            }
        };

        // Parse options
        let mut options = BoxliteOptions::default();
        if !home_dir.is_null() {
            match c_str_to_string(home_dir) {
                Ok(path) => options.home_dir = path.into(),
                Err(e) => {
                    write_error(out_error, e);
                    return BoxliteErrorCode::InvalidArgument;
                }
            }
        }

        // Parse image registries (JSON array)
        if !registries_json.is_null() {
            match c_str_to_string(registries_json) {
                Ok(json_str) => match serde_json::from_str::<Vec<String>>(&json_str) {
                    Ok(registries) => options.image_registries = registries,
                    Err(e) => {
                        let err = BoxliteError::Internal(format!("Invalid registries JSON: {}", e));
                        write_error(out_error, err);
                        return BoxliteErrorCode::Internal;
                    }
                },
                Err(e) => {
                    write_error(out_error, e);
                    return BoxliteErrorCode::InvalidArgument;
                }
            }
        }

        // Create runtime
        let runtime = match BoxliteRuntime::new(options) {
            Ok(rt) => rt,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                return code;
            }
        };

        *out_runtime = Box::into_raw(Box::new(RuntimeHandle { runtime, tokio_rt }));
        BoxliteErrorCode::Ok
    }
}

/// Create a new box
///
/// # Parameters
/// * `runtime`: Pointer to the `RuntimeHandle`
/// * `options_json`: JSON string defining the box configuration
/// * `name`: Optional name for the box (or null)
/// * `out_box`: Output pointer for the created `BoxHandle`
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// This function creates a new box within the given runtime.
/// It parses the `options_json` string into `BoxOptions`.
/// The operation is asynchronous, so it blocks on the runtime's Tokio executor.
///
/// # Safety
/// All pointer parameters must be valid or null.
pub unsafe fn box_create(
    runtime: *mut RuntimeHandle,
    options_json: *const c_char,
    name: *const c_char,
    out_box: *mut *mut BoxHandle,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_box.is_null() {
            write_error(out_error, null_pointer_error("out_box"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &mut *runtime;

        // Parse JSON options
        let options_str = match c_str_to_string(options_json) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        // Parse optional name
        let name_opt = if name.is_null() {
            None
        } else {
            match c_str_to_string(name) {
                Ok(s) => Some(s),
                Err(e) => {
                    write_error(out_error, e);
                    return BoxliteErrorCode::InvalidArgument;
                }
            }
        };

        let options: BoxOptions = match serde_json::from_str(&options_str) {
            Ok(opts) => opts,
            Err(e) => {
                let err = BoxliteError::Internal(format!("Invalid JSON options: {}", e));
                write_error(out_error, err);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        // Create box
        // create() is async, so we block on the tokio runtime
        let result = runtime_ref
            .tokio_rt
            .block_on(runtime_ref.runtime.create(options, name_opt));

        match result {
            Ok(handle) => {
                let box_id = handle.id().clone();
                *out_box = Box::into_raw(Box::new(BoxHandle {
                    handle,
                    box_id,
                    tokio_rt: runtime_ref.tokio_rt.clone(),
                }));
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

/// List all boxes as JSON
///
/// # Parameters
/// * `runtime`: Pointer to the `RuntimeHandle`
/// * `out_json`: Output pointer for the JSON string (must be freed)
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// Retrieves the list of all boxes from the runtime and serializes them to a JSON string.
/// The JSON string is allocated as a CString and must be freed by the caller using `string_free`.
///
/// # Safety
/// All pointer parameters must be valid or null.
pub unsafe fn box_list(
    runtime: *mut RuntimeHandle,
    out_json: *mut *mut c_char,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_json.is_null() {
            write_error(out_error, null_pointer_error("out_json"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;

        let result = runtime_ref
            .tokio_rt
            .block_on(runtime_ref.runtime.list_info());

        match result {
            Ok(boxes) => {
                let json_array: Vec<serde_json::Value> =
                    boxes.iter().map(box_info_to_json).collect();
                let json_str = match serde_json::to_string(&json_array) {
                    Ok(s) => s,
                    Err(e) => {
                        let err =
                            BoxliteError::Internal(format!("JSON serialization failed: {}", e));
                        write_error(out_error, err);
                        return BoxliteErrorCode::Internal;
                    }
                };

                match CString::new(json_str) {
                    Ok(s) => {
                        *out_json = s.into_raw();
                        BoxliteErrorCode::Ok
                    }
                    Err(e) => {
                        let err =
                            BoxliteError::Internal(format!("CString conversion failed: {}", e));
                        write_error(out_error, err);
                        BoxliteErrorCode::Internal
                    }
                }
            }
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

/// Stop a box
///
/// # Parameters
/// * `handle`: Pointer to the `BoxHandle`
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// Stops the execution of a box. This is an async operation that is blocked on.
///
/// # Safety
/// handle must be a valid pointer to `BoxHandle`.
pub unsafe fn box_stop(handle: *mut BoxHandle, out_error: *mut FFIError) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = Box::from_raw(handle);

        // Block on async stop using the stored tokio runtime
        let result = handle_ref.tokio_rt.block_on(handle_ref.handle.stop());
        match result {
            Ok(_) => BoxliteErrorCode::Ok,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

/// Inspect single box info as JSON
///
/// # Parameters
/// * `runtime`: Pointer to the `RuntimeHandle`
/// * `id_or_name`: ID or name of the box to inspect
/// * `out_json`: Output pointer for the JSON string
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// Retrieves detailed information about a specific box identified by ID or name.
/// The result is serialized to JSON.
///
/// # Safety
/// All pointer parameters must be valid or null.
pub unsafe fn box_inspect(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    out_json: *mut *mut c_char,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_json.is_null() {
            write_error(out_error, null_pointer_error("out_json"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;

        let id_str = match c_str_to_string(id_or_name) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let result = runtime_ref
            .tokio_rt
            .block_on(runtime_ref.runtime.get_info(&id_str));

        match result {
            Ok(Some(info)) => {
                let json_str = match serde_json::to_string(&box_info_to_json(&info)) {
                    Ok(s) => s,
                    Err(e) => {
                        let err =
                            BoxliteError::Internal(format!("JSON serialization failed: {}", e));
                        write_error(out_error, err);
                        return BoxliteErrorCode::Internal;
                    }
                };

                match CString::new(json_str) {
                    Ok(s) => {
                        *out_json = s.into_raw();
                        BoxliteErrorCode::Ok
                    }
                    Err(e) => {
                        let err =
                            BoxliteError::Internal(format!("CString conversion failed: {}", e));
                        write_error(out_error, err);
                        BoxliteErrorCode::Internal
                    }
                }
            }
            Ok(None) => {
                let err = BoxliteError::NotFound(format!("Box not found: {}", id_str));
                write_error(out_error, err);
                BoxliteErrorCode::NotFound
            }
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

/// Attach to an existing box
///
/// # Parameters
/// * `runtime`: Pointer to the `RuntimeHandle`
/// * `id_or_name`: ID or name of the box to attach to
/// * `out_handle`: Output pointer for the attached `BoxHandle`
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// Gets a handle to an existing box. This allows performing operations on a box
/// that was created previously or listed.
///
/// # Safety
/// All pointer parameters must be valid or null.
pub unsafe fn box_attach(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    out_handle: *mut *mut BoxHandle,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_handle.is_null() {
            write_error(out_error, null_pointer_error("out_handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;

        let id_str = match c_str_to_string(id_or_name) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let result = runtime_ref
            .tokio_rt
            .block_on(runtime_ref.runtime.get(&id_str));

        match result {
            Ok(Some(handle)) => {
                let box_id = handle.id().clone();
                *out_handle = Box::into_raw(Box::new(BoxHandle {
                    handle,
                    box_id,
                    tokio_rt: runtime_ref.tokio_rt.clone(),
                }));
                BoxliteErrorCode::Ok
            }
            Ok(None) => {
                let err = BoxliteError::NotFound(format!("Box not found: {}", id_str));
                write_error(out_error, err);
                BoxliteErrorCode::NotFound
            }
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

/// Remove a box
///
/// # Parameters
/// * `runtime`: Pointer to the `RuntimeHandle`
/// * `id_or_name`: ID or name of the box to remove
/// * `force`: If true, force remove even if running
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// Removes a box from the runtime. If `force` is true, it attempts to stop the box if running.
///
/// # Safety
/// All pointer parameters must be valid or null.
pub unsafe fn box_remove(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    force: bool,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;

        let id_str = match c_str_to_string(id_or_name) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let result = runtime_ref
            .tokio_rt
            .block_on(runtime_ref.runtime.remove(&id_str, force));

        match result {
            Ok(_) => BoxliteErrorCode::Ok,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

/// Get runtime metrics as JSON
///
/// # Parameters
/// * `runtime`: Pointer to the `RuntimeHandle`
/// * `out_json`: Output pointer for the JSON string
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// Aggregates metrics for the entire runtime and serializes them to JSON.
///
/// # Safety
/// All pointer parameters must be valid or null.
pub unsafe fn runtime_metrics(
    runtime: *mut RuntimeHandle,
    out_json: *mut *mut c_char,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_json.is_null() {
            write_error(out_error, null_pointer_error("out_json"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;
        let metrics = match runtime_ref.tokio_rt.block_on(runtime_ref.runtime.metrics()) {
            Ok(m) => m,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::Internal;
            }
        };

        let json = serde_json::json!({
            "boxes_created_total": metrics.boxes_created_total(),
            "boxes_failed_total": metrics.boxes_failed_total(),
            "num_running_boxes": metrics.num_running_boxes(),
            "total_commands_executed": metrics.total_commands_executed(),
            "total_exec_errors": metrics.total_exec_errors()
        });

        let json_str = match serde_json::to_string(&json) {
            Ok(s) => s,
            Err(e) => {
                let err = BoxliteError::Internal(format!("JSON serialization failed: {}", e));
                write_error(out_error, err);
                return BoxliteErrorCode::Internal;
            }
        };

        match CString::new(json_str) {
            Ok(s) => {
                *out_json = s.into_raw();
                BoxliteErrorCode::Ok
            }
            Err(e) => {
                let err = BoxliteError::Internal(format!("CString conversion failed: {}", e));
                write_error(out_error, err);
                BoxliteErrorCode::Internal
            }
        }
    }
}

/// Gracefully shutdown all boxes in this runtime
///
/// # Parameters
/// * `runtime`: Pointer to the `RuntimeHandle`
/// * `timeout`: Optional timeout in seconds
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// Attempts to stop all running boxes. Accepts an optional timeout via `Option<i32>`.
///
/// # Safety
/// All pointer parameters must be valid or null.
pub unsafe fn runtime_shutdown(
    runtime: *mut RuntimeHandle,
    timeout: Option<i32>,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;

        let result = runtime_ref
            .tokio_rt
            .block_on(runtime_ref.runtime.shutdown(timeout));

        match result {
            Ok(()) => BoxliteErrorCode::Ok,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

pub type OutputCallback = extern "C" fn(*const c_char, c_int, *mut c_void);

/// Execute a command in a box
///
/// # Parameters
/// * `handle`: Pointer to the `BoxHandle`
/// * `command`: Command to execute (e.g., "/bin/sh")
/// * `args_json`: JSON string of arguments (e.g., `["-c", "echo hello"]`)
/// * `callback`: Optional callback function for streaming output
/// * `user_data`: User data pointer to be passed to the callback
/// * `out_exit_code`: Output pointer for the exit code
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// Executes a command inside the container. Supports streaming output via a callback function.
/// Takes arguments as a JSON string.
///
/// # Safety
/// All pointer parameters must be valid or null.
///
pub unsafe fn box_exec(
    handle: *mut BoxHandle,
    command: *const c_char,
    args_json: *const c_char,
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

        // Parse args
        let args: Vec<String> = if !args_json.is_null() {
            match c_str_to_string(args_json) {
                Ok(json_str) => match serde_json::from_str(&json_str) {
                    Ok(a) => a,
                    Err(e) => {
                        let err = BoxliteError::Internal(format!("Invalid args JSON: {}", e));
                        write_error(out_error, err);
                        return BoxliteErrorCode::InvalidArgument;
                    }
                },
                Err(e) => {
                    let code = error_to_code(&e);
                    write_error(out_error, e);
                    return code;
                }
            }
        } else {
            vec![]
        };

        let mut cmd = boxlite::BoxCommand::new(cmd_str);
        cmd = cmd.args(args);

        // Execute command using new API
        let result = handle_ref.tokio_rt.block_on(async {
            let mut execution = handle_ref.handle.exec(cmd).await?;

            // Stream output to callback if provided
            if let Some(cb) = callback {
                use futures::StreamExt;

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

/// Get box info from handle as JSON
///
/// # Parameters
/// * `handle`: Pointer to the `BoxHandle`
/// * `out_json`: Output pointer for the JSON string
/// * `out_error`: Output pointer for error details
///
/// # Implementation Note
/// Retrieves info for a box handle. Useful for getting the status of an attached box.
///
/// # Safety
/// All pointer parameters must be valid or null.
pub unsafe fn box_inspect_handle(
    handle: *mut BoxHandle,
    out_json: *mut *mut c_char,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_json.is_null() {
            write_error(out_error, null_pointer_error("out_json"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;
        let info = handle_ref.handle.info();

        let json_str = match serde_json::to_string(&box_info_to_json(&info)) {
            Ok(s) => s,
            Err(e) => {
                let err = BoxliteError::Internal(format!("JSON serialization failed: {}", e));
                write_error(out_error, err);
                return BoxliteErrorCode::Internal;
            }
        };

        match CString::new(json_str) {
            Ok(s) => {
                *out_json = s.into_raw();
                BoxliteErrorCode::Ok
            }
            Err(e) => {
                let err = BoxliteError::Internal(format!("CString conversion failed: {}", e));
                write_error(out_error, err);
                BoxliteErrorCode::Internal
            }
        }
    }
}

/// Get box metrics from handle as JSON
///
/// # Implementation Note
/// Retrieves real-time metrics for a specific box.
///
/// # Safety
/// All pointer parameters must be valid or null.
pub unsafe fn box_metrics(
    handle: *mut BoxHandle,
    out_json: *mut *mut c_char,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_json.is_null() {
            write_error(out_error, null_pointer_error("out_json"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;

        let result = handle_ref.tokio_rt.block_on(handle_ref.handle.metrics());

        match result {
            Ok(metrics) => {
                let json = serde_json::json!({
                    "cpu_percent": metrics.cpu_percent,
                    "memory_bytes": metrics.memory_bytes,
                    "commands_executed_total": metrics.commands_executed_total,
                    "exec_errors_total": metrics.exec_errors_total,
                    "bytes_sent_total": metrics.bytes_sent_total,
                    "bytes_received_total": metrics.bytes_received_total,
                    "total_create_duration_ms": metrics.total_create_duration_ms,
                    "guest_boot_duration_ms": metrics.guest_boot_duration_ms,
                    "network_bytes_sent": metrics.network_bytes_sent,
                    "network_bytes_received": metrics.network_bytes_received,
                    "network_tcp_connections": metrics.network_tcp_connections,
                    "network_tcp_errors": metrics.network_tcp_errors
                });

                let json_str = match serde_json::to_string(&json) {
                    Ok(s) => s,
                    Err(e) => {
                        let err =
                            BoxliteError::Internal(format!("JSON serialization failed: {}", e));
                        write_error(out_error, err);
                        return BoxliteErrorCode::Internal;
                    }
                };

                match CString::new(json_str) {
                    Ok(s) => {
                        *out_json = s.into_raw();
                        BoxliteErrorCode::Ok
                    }
                    Err(e) => {
                        let err =
                            BoxliteError::Internal(format!("CString conversion failed: {}", e));
                        write_error(out_error, err);
                        BoxliteErrorCode::Internal
                    }
                }
            }
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

/// Free a runtime instance
///
/// # Parameters
/// * `runtime`: Pointer to `RuntimeHandle`
///
/// # Implementation Note
/// Releases the `RuntimeHandle` and drops the Tokio runtime.
///
/// # Safety
/// runtime must be null or a valid pointer to RuntimeHandle
pub unsafe fn runtime_free(runtime: *mut RuntimeHandle) {
    if !runtime.is_null() {
        unsafe {
            drop(Box::from_raw(runtime));
        }
    }
}

/// Free a string allocated by BoxLite
///
/// # Parameters
/// * `str`: Pointer to the string
///
/// # Implementation Note
/// Frees a `CString` that was allocated by Rust and passed to C.
///
/// # Safety
/// str must be null or a valid pointer to c_char allocated by CString
pub unsafe fn string_free(str: *mut c_char) {
    if !str.is_null() {
        unsafe {
            drop(CString::from_raw(str));
        }
    }
}

/// Free error struct
///
/// # Implementation Note
/// Frees the `message` string within the `FFIError` struct and resets the code.
///
/// # Safety
/// error must be null or a valid pointer to FFIError
pub unsafe fn error_free(error: *mut FFIError) {
    if !error.is_null() {
        unsafe {
            let err = &mut *error;
            if !err.message.is_null() {
                drop(CString::from_raw(err.message));
                err.message = ptr::null_mut();
            }
            err.code = BoxliteErrorCode::Ok;
        }
    }
}

/// Get BoxLite version string
///
/// # Implementation Note
/// Returns a static C string containing the package version.
/// This string is statically allocated and should NOT be freed.
///
/// # Returns
/// Static string containing the version (e.g., "0.1.0")
pub extern "C" fn version() -> *const c_char {
    // Static string, safe to return pointer
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr() as *const c_char
}

/// Create and start a box runner
///
/// # Implementation Note
/// Creates a `BoxRunner` which encapsulates a runtime and a single box.
/// Simplified API for quick execution.
///
/// # Safety
/// All pointers must be valid
pub unsafe fn runner_new(
    image: *const c_char,
    cpus: c_int,
    memory_mib: c_int,
    out_runner: *mut *mut crate::runner::BoxRunner,
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
                let runner = Box::new(crate::runner::BoxRunner::new(
                    runtime, handle, box_id, tokio_rt,
                ));
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

/// Run a command using the runner
///
/// # Implementation Note
/// Executes a command on the runner's box. Returns buffered stdout/stderr.
///
/// # Safety
/// All pointers must be valid
pub unsafe fn runner_exec(
    runner: *mut crate::runner::BoxRunner,
    command: *const c_char,
    args: *const *const c_char,
    argc: c_int,
    out_result: *mut *mut crate::runner::ExecResult,
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

                let exec_result = Box::new(crate::runner::ExecResult {
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

/// Free execution result
///
/// # Implementation Note
/// Frees the `ExecResult` struct and its contained strings.
///
/// # Safety
/// result must be null or valid pointer
pub unsafe fn result_free(result: *mut crate::runner::ExecResult) {
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

/// Free runner (auto-cleanup)
///
/// # Implementation Note
/// Frees the `BoxRunner`. This triggers cleanup of the box (stopping and removing it).
///
/// # Safety
/// runner must be null or valid pointer
pub unsafe fn runner_free(runner: *mut crate::runner::BoxRunner) {
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

/// Start or restart a stopped box
///
/// # Implementation Note
/// Starts the box execution.
///
/// # Safety
/// handle must be valid or null
pub unsafe fn box_start(handle: *mut BoxHandle, out_error: *mut FFIError) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;

        match handle_ref.tokio_rt.block_on(handle_ref.handle.start()) {
            Ok(_) => BoxliteErrorCode::Ok,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

/// Get box ID string from handle
///
/// # Implementation Note
/// Returns the Box ID as a newly allocated C string. Caller must free.
///
/// # Safety
/// handle must be valid or null
pub unsafe fn box_id(handle: *mut BoxHandle) -> *mut c_char {
    unsafe {
        if handle.is_null() {
            return ptr::null_mut();
        }

        let handle_ref = &*handle;
        let id_str = handle_ref.handle.id().to_string();

        match CString::new(id_str) {
            Ok(s) => s.into_raw(),
            Err(_) => ptr::null_mut(),
        }
    }
}

/// Free a box handle
///
/// # Implementation Note
/// Frees the `BoxHandle`. Note that this does NOT destroy the box itself, only the handle.
/// To destroy the box, use `box_remove`.
///
/// # Safety
/// handle must be null or a valid pointer to BoxHandle
pub unsafe fn box_free(handle: *mut BoxHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::error_to_c_error;
    use crate::json::status_to_string;
    use boxlite::runtime::types::BoxStatus;
    use std::ffi::CStr;

    #[test]
    fn test_version_string() {
        let ver = version();
        assert!(!ver.is_null());
        let ver_str = unsafe { CStr::from_ptr(ver) }.to_str().unwrap();
        assert!(!ver_str.is_empty());
        assert!(ver_str.contains('.'));
    }

    #[test]
    fn test_error_code_mapping() {
        assert_eq!(
            error_to_code(&BoxliteError::NotFound("test".into())),
            BoxliteErrorCode::NotFound
        );
        assert_eq!(
            error_to_code(&BoxliteError::AlreadyExists("test".into())),
            BoxliteErrorCode::AlreadyExists
        );
        assert_eq!(
            error_to_code(&BoxliteError::InvalidState("test".into())),
            BoxliteErrorCode::InvalidState
        );
        assert_eq!(
            error_to_code(&BoxliteError::InvalidArgument("test".into())),
            BoxliteErrorCode::InvalidArgument
        );
        assert_eq!(
            error_to_code(&BoxliteError::Internal("test".into())),
            BoxliteErrorCode::Internal
        );
        assert_eq!(
            error_to_code(&BoxliteError::Config("test".into())),
            BoxliteErrorCode::Config
        );
        assert_eq!(
            error_to_code(&BoxliteError::Storage("test".into())),
            BoxliteErrorCode::Storage
        );
        assert_eq!(
            error_to_code(&BoxliteError::Image("test".into())),
            BoxliteErrorCode::Image
        );
        assert_eq!(
            error_to_code(&BoxliteError::Network("test".into())),
            BoxliteErrorCode::Network
        );
        assert_eq!(
            error_to_code(&BoxliteError::Execution("test".into())),
            BoxliteErrorCode::Execution
        );
    }

    #[test]
    fn test_error_struct_creation() {
        let err = BoxliteError::NotFound("box123".into());
        let mut c_err = error_to_c_error(err);
        assert_eq!(c_err.code, BoxliteErrorCode::NotFound);
        assert!(!c_err.message.is_null());
        unsafe {
            error_free(&mut c_err as *mut _);
        }
        assert!(c_err.message.is_null());
        assert_eq!(c_err.code, BoxliteErrorCode::Ok);
    }

    #[test]
    fn test_null_pointer_validation() {
        unsafe {
            let mut error = FFIError::default();
            // runtime_new with null out_runtime should return InvalidArgument
            let code = runtime_new(
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                &mut error as *mut _,
            );
            assert_eq!(code, BoxliteErrorCode::InvalidArgument);
            assert!(!error.message.is_null());
            error_free(&mut error as *mut _);
        }
    }

    #[test]
    fn test_c_string_conversion_logic() {
        let test_str = CString::new("hello").unwrap();
        unsafe {
            let result = c_str_to_string(test_str.as_ptr());
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), "hello");
        }
    }

    #[test]
    fn test_status_to_string_mapping() {
        assert_eq!(status_to_string(BoxStatus::Unknown), "unknown");
        assert_eq!(status_to_string(BoxStatus::Configured), "configured");
        assert_eq!(status_to_string(BoxStatus::Running), "running");
        assert_eq!(status_to_string(BoxStatus::Stopping), "stopping");
        assert_eq!(status_to_string(BoxStatus::Stopped), "stopped");
    }

    #[test]
    fn test_free_functions_null_safe() {
        unsafe {
            runtime_free(ptr::null_mut());
            box_free(ptr::null_mut());
            string_free(ptr::null_mut());
            error_free(ptr::null_mut());
            result_free(ptr::null_mut());
            runner_free(ptr::null_mut());
        }
    }
}
