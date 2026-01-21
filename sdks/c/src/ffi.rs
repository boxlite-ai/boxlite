//! C FFI bindings for BoxLite
//!
//! This module provides a C-compatible API for integrating BoxLite into C/C++ applications.
//! The API uses JSON for complex types to avoid ABI compatibility issues.
//!
//! # Safety
//!
//! All functions in this module are unsafe because they:
//! - Dereference raw pointers passed from C
//! - Require the caller to ensure pointer validity and proper cleanup
//! - May write to caller-provided output pointers

#![allow(unsafe_op_in_unsafe_fn)]
#![allow(clippy::missing_safety_doc)]
#![allow(clippy::doc_overindented_list_items)]

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxID;
use boxlite::litebox::LiteBox;
use boxlite::runtime::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use boxlite::runtime::types::{BoxInfo, BoxStatus};
use boxlite_shared::errors::BoxliteError;

/// Opaque handle to a BoxliteRuntime instance
pub struct CBoxliteRuntime {
    runtime: BoxliteRuntime,
    tokio_rt: Arc<TokioRuntime>,
}

/// Opaque handle to a running box
pub struct CBoxHandle {
    handle: LiteBox,
    #[allow(dead_code)]
    box_id: BoxID,
    tokio_rt: Arc<TokioRuntime>,
}

/// Helper to convert Rust error to C string
fn error_to_c_string(err: BoxliteError) -> *mut c_char {
    let msg = format!("{}", err);
    match CString::new(msg) {
        Ok(s) => s.into_raw(),
        Err(_) => {
            let fallback = CString::new("Failed to format error message").unwrap();
            fallback.into_raw()
        }
    }
}

/// Helper to convert C string to Rust string
unsafe fn c_str_to_string(s: *const c_char) -> Result<String, BoxliteError> {
    if s.is_null() {
        return Err(BoxliteError::Internal("null pointer".to_string()));
    }
    unsafe {
        CStr::from_ptr(s)
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| BoxliteError::Internal(format!("invalid UTF-8: {}", e)))
    }
}

/// Convert BoxStatus to string
fn status_to_string(status: BoxStatus) -> &'static str {
    match status {
        BoxStatus::Unknown => "unknown",
        BoxStatus::Configured => "configured",
        BoxStatus::Running => "running",
        BoxStatus::Stopping => "stopping",
        BoxStatus::Stopped => "stopped",
    }
}

/// Convert BoxInfo to JSON with nested state structure
fn box_info_to_json(info: &BoxInfo) -> serde_json::Value {
    serde_json::json!({
        "id": info.id.to_string(),
        "name": info.name,
        "state": {
            "status": status_to_string(info.status),
            "running": info.status.is_running(),
            "pid": info.pid
        },
        "created_at": info.created_at.to_rfc3339(),
        "image": info.image,
        "cpus": info.cpus,
        "memory_mib": info.memory_mib
    })
}

/// Helper to write JSON string to output pointer
fn write_json_output(json: serde_json::Value, out_json: *mut *mut c_char) -> c_int {
    let json_str = match serde_json::to_string(&json) {
        Ok(s) => s,
        Err(e) => {
            if !out_json.is_null() {
                unsafe {
                    *out_json = error_to_c_string(BoxliteError::Internal(format!(
                        "JSON serialization failed: {}",
                        e
                    )));
                }
            }
            return -1;
        }
    };

    match CString::new(json_str) {
        Ok(s) => {
            if !out_json.is_null() {
                unsafe {
                    *out_json = s.into_raw();
                }
            }
            0
        }
        Err(e) => {
            if !out_json.is_null() {
                unsafe {
                    *out_json = error_to_c_string(BoxliteError::Internal(format!(
                        "CString conversion failed: {}",
                        e
                    )));
                }
            }
            -1
        }
    }
}

/// Get BoxLite version string
///
/// # Returns
/// Static string containing the version (e.g., "0.1.0")
#[unsafe(no_mangle)]
pub extern "C" fn boxlite_version() -> *const c_char {
    // Static string, safe to return pointer
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr() as *const c_char
}

/// Create a new BoxLite runtime
///
/// # Arguments
/// * `home_dir` - Path to BoxLite home directory (stores images, rootfs, etc.)
///                If NULL, uses default: ~/.boxlite
/// * `registries_json` - JSON array of registries to search for unqualified images,
///                       e.g. `["ghcr.io", "quay.io"]`. If NULL, uses default (docker.io).
///                       Registries are tried in order; first successful pull wins.
/// * `out_error` - Output parameter for error message (caller must free with boxlite_free_string)
///
/// # Returns
/// Pointer to CBoxliteRuntime on success, NULL on failure
///
/// # Example
/// ```c
/// char *error = NULL;
/// const char *registries = "[\"ghcr.io\", \"docker.io\"]";
/// BoxliteRuntime *runtime = boxlite_runtime_new("/tmp/boxlite", registries, &error);
/// if (!runtime) {
///     fprintf(stderr, "Error: %s\n", error);
///     boxlite_free_string(error);
///     return 1;
/// }
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_new(
    home_dir: *const c_char,
    registries_json: *const c_char,
    out_error: *mut *mut c_char,
) -> *mut CBoxliteRuntime {
    // Create tokio runtime
    let tokio_rt = match TokioRuntime::new() {
        Ok(rt) => Arc::new(rt),
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(BoxliteError::Internal(format!(
                    "Failed to create async runtime: {}",
                    e
                )));
            }
            return ptr::null_mut();
        }
    };

    // Parse options
    let mut options = BoxliteOptions::default();
    if !home_dir.is_null() {
        match c_str_to_string(home_dir) {
            Ok(path) => options.home_dir = path.into(),
            Err(e) => {
                if !out_error.is_null() {
                    *out_error = error_to_c_string(e);
                }
                return ptr::null_mut();
            }
        }
    }

    // Parse image registries (JSON array)
    if !registries_json.is_null() {
        match c_str_to_string(registries_json) {
            Ok(json_str) => match serde_json::from_str::<Vec<String>>(&json_str) {
                Ok(registries) => options.image_registries = registries,
                Err(e) => {
                    if !out_error.is_null() {
                        *out_error = error_to_c_string(BoxliteError::Internal(format!(
                            "Invalid registries JSON: {}",
                            e
                        )));
                    }
                    return ptr::null_mut();
                }
            },
            Err(e) => {
                if !out_error.is_null() {
                    *out_error = error_to_c_string(e);
                }
                return ptr::null_mut();
            }
        }
    }

    // Create runtime
    let runtime = match BoxliteRuntime::new(options) {
        Ok(rt) => rt,
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            return ptr::null_mut();
        }
    };

    Box::into_raw(Box::new(CBoxliteRuntime { runtime, tokio_rt }))
}

/// Create a new box with the given options (JSON)
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `options_json` - JSON-encoded BoxOptions, e.g.:
///                    `{"rootfs": {"Image": "alpine:3.19"}, "working_dir": "/workspace"}`
/// * `out_error` - Output parameter for error message
///
/// # Returns
/// Pointer to CBoxHandle on success, NULL on failure
///
/// # Example
/// ```c
/// const char *opts = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";
/// BoxHandle *box = boxlite_create_box(runtime, opts, &error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_create_box(
    runtime: *mut CBoxliteRuntime,
    options_json: *const c_char,
    out_error: *mut *mut c_char,
) -> *mut CBoxHandle {
    if runtime.is_null() {
        if !out_error.is_null() {
            *out_error = error_to_c_string(BoxliteError::Internal("runtime is null".to_string()));
        }
        return ptr::null_mut();
    }

    let runtime_ref = &mut *runtime;

    // Parse JSON options
    let options_str = match c_str_to_string(options_json) {
        Ok(s) => s,
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            return ptr::null_mut();
        }
    };

    let options: BoxOptions = match serde_json::from_str(&options_str) {
        Ok(opts) => opts,
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(BoxliteError::Internal(format!(
                    "Invalid JSON options: {}",
                    e
                )));
            }
            return ptr::null_mut();
        }
    };

    // Create box (no name support in C API yet)
    // create() is async, so we block on the tokio runtime
    let result = runtime_ref
        .tokio_rt
        .block_on(runtime_ref.runtime.create(options, None));

    match result {
        Ok(handle) => {
            let box_id = handle.id().clone();
            Box::into_raw(Box::new(CBoxHandle {
                handle,
                box_id,
                tokio_rt: runtime_ref.tokio_rt.clone(),
            }))
        }
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            ptr::null_mut()
        }
    }
}

/// Execute a command in a box
///
/// # Arguments
/// * `handle` - Box handle
/// * `command` - Command to execute
/// * `args_json` - JSON array of arguments, e.g.: `["arg1", "arg2"]`
/// * `callback` - Optional callback for streaming output (chunk_text, is_stderr, user_data)
/// * `user_data` - User data passed to callback
/// * `out_error` - Output parameter for error message
///
/// # Returns
/// Exit code on success, -1 on failure
///
/// # Example
/// ```c
/// const char *args = "[\"hello\"]";
/// int exit_code = boxlite_execute(box, "echo", args, NULL, NULL, &error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execute(
    handle: *mut CBoxHandle,
    command: *const c_char,
    args_json: *const c_char,
    callback: Option<extern "C" fn(*const c_char, c_int, *mut c_void)>,
    user_data: *mut c_void,
    out_error: *mut *mut c_char,
) -> c_int {
    if handle.is_null() {
        if !out_error.is_null() {
            *out_error = error_to_c_string(BoxliteError::Internal("handle is null".into()));
        }
        return -1;
    }

    let handle_ref = &mut *handle;

    // Parse command
    let cmd_str = match c_str_to_string(command) {
        Ok(s) => s,
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            return -1;
        }
    };

    // Parse args
    let args: Vec<String> = if !args_json.is_null() {
        match c_str_to_string(args_json) {
            Ok(json_str) => match serde_json::from_str(&json_str) {
                Ok(a) => a,
                Err(e) => {
                    if !out_error.is_null() {
                        *out_error = error_to_c_string(BoxliteError::Internal(format!(
                            "Invalid args JSON: {}",
                            e
                        )));
                    }
                    return -1;
                }
            },
            Err(e) => {
                if !out_error.is_null() {
                    *out_error = error_to_c_string(e);
                }
                return -1;
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

        // Wait for execution to complete
        let status = execution.wait().await?;
        Ok::<i32, BoxliteError>(status.exit_code)
    });

    match result {
        Ok(exit_code) => exit_code,
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            -1
        }
    }
}

/// Stop a box
///
/// # Arguments
/// * `handle` - Box handle (will be consumed/freed)
/// * `out_error` - Output parameter for error message
///
/// # Returns
/// 0 on success, -1 on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_stop_box(
    handle: *mut CBoxHandle,
    out_error: *mut *mut c_char,
) -> c_int {
    if handle.is_null() {
        if !out_error.is_null() {
            unsafe {
                *out_error = error_to_c_string(BoxliteError::Internal("handle is null".into()));
            }
        }
        return -1;
    }

    let handle_box = unsafe { Box::from_raw(handle) };

    // Block on async stop using the stored tokio runtime
    let result = handle_box.tokio_rt.block_on(handle_box.handle.stop());

    match result {
        Ok(_) => 0,
        Err(e) => {
            if !out_error.is_null() {
                unsafe {
                    *out_error = error_to_c_string(e);
                }
            }
            -1
        }
    }
}

// ============================================================================
// NEW API FUNCTIONS - Python SDK Parity
// ============================================================================

/// List all boxes as JSON
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `out_json` - Output parameter for JSON array of box info
/// * `out_error` - Output parameter for error message
///
/// # Returns
/// 0 on success, -1 on failure
///
/// # JSON Format
/// ```json
/// [
///   {
///     "id": "01HJK4TNRPQSXYZ8WM6NCVT9R5",
///     "name": "my-box",
///     "state": { "status": "running", "running": true, "pid": 12345 },
///     "created_at": "2024-01-15T10:30:00Z",
///     "image": "alpine:3.19",
///     "cpus": 2,
///     "memory_mib": 512
///   }
/// ]
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_list_info(
    runtime: *mut CBoxliteRuntime,
    out_json: *mut *mut c_char,
    out_error: *mut *mut c_char,
) -> c_int {
    if runtime.is_null() {
        if !out_error.is_null() {
            *out_error = error_to_c_string(BoxliteError::Internal("runtime is null".to_string()));
        }
        return -1;
    }

    let runtime_ref = &*runtime;

    let result = runtime_ref
        .tokio_rt
        .block_on(runtime_ref.runtime.list_info());

    match result {
        Ok(boxes) => {
            let json_array: Vec<serde_json::Value> = boxes.iter().map(box_info_to_json).collect();
            write_json_output(serde_json::Value::Array(json_array), out_json)
        }
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            -1
        }
    }
}

/// Get single box info as JSON
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `id_or_name` - Box ID (full or prefix) or name
/// * `out_json` - Output parameter for JSON object
/// * `out_error` - Output parameter for error message
///
/// # Returns
/// 0 on success, -1 on failure (including box not found)
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get_info(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    out_json: *mut *mut c_char,
    out_error: *mut *mut c_char,
) -> c_int {
    if runtime.is_null() {
        if !out_error.is_null() {
            *out_error = error_to_c_string(BoxliteError::Internal("runtime is null".to_string()));
        }
        return -1;
    }

    let runtime_ref = &*runtime;

    let id_str = match c_str_to_string(id_or_name) {
        Ok(s) => s,
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            return -1;
        }
    };

    let result = runtime_ref
        .tokio_rt
        .block_on(runtime_ref.runtime.get_info(&id_str));

    match result {
        Ok(Some(info)) => write_json_output(box_info_to_json(&info), out_json),
        Ok(None) => {
            if !out_error.is_null() {
                *out_error =
                    error_to_c_string(BoxliteError::NotFound(format!("Box not found: {}", id_str)));
            }
            -1
        }
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            -1
        }
    }
}

/// Get box handle for reattaching to an existing box
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `id_or_name` - Box ID (full or prefix) or name
/// * `out_error` - Output parameter for error message
///
/// # Returns
/// Pointer to CBoxHandle on success, NULL on failure (including box not found)
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    out_error: *mut *mut c_char,
) -> *mut CBoxHandle {
    if runtime.is_null() {
        if !out_error.is_null() {
            *out_error = error_to_c_string(BoxliteError::Internal("runtime is null".to_string()));
        }
        return ptr::null_mut();
    }

    let runtime_ref = &*runtime;

    let id_str = match c_str_to_string(id_or_name) {
        Ok(s) => s,
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            return ptr::null_mut();
        }
    };

    let result = runtime_ref
        .tokio_rt
        .block_on(runtime_ref.runtime.get(&id_str));

    match result {
        Ok(Some(handle)) => {
            let box_id = handle.id().clone();
            Box::into_raw(Box::new(CBoxHandle {
                handle,
                box_id,
                tokio_rt: runtime_ref.tokio_rt.clone(),
            }))
        }
        Ok(None) => {
            if !out_error.is_null() {
                *out_error =
                    error_to_c_string(BoxliteError::NotFound(format!("Box not found: {}", id_str)));
            }
            ptr::null_mut()
        }
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            ptr::null_mut()
        }
    }
}

/// Remove a box
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `id_or_name` - Box ID (full or prefix) or name
/// * `force` - If non-zero, force remove even if running
/// * `out_error` - Output parameter for error message
///
/// # Returns
/// 0 on success, -1 on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_remove(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    force: c_int,
    out_error: *mut *mut c_char,
) -> c_int {
    if runtime.is_null() {
        if !out_error.is_null() {
            *out_error = error_to_c_string(BoxliteError::Internal("runtime is null".to_string()));
        }
        return -1;
    }

    let runtime_ref = &*runtime;

    let id_str = match c_str_to_string(id_or_name) {
        Ok(s) => s,
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            return -1;
        }
    };

    let result = runtime_ref
        .tokio_rt
        .block_on(runtime_ref.runtime.remove(&id_str, force != 0));

    match result {
        Ok(_) => 0,
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            -1
        }
    }
}

/// Get runtime metrics as JSON
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `out_json` - Output parameter for JSON object
/// * `out_error` - Output parameter for error message (unused, provided for API consistency)
///
/// # Returns
/// 0 on success, -1 on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_metrics(
    runtime: *mut CBoxliteRuntime,
    out_json: *mut *mut c_char,
    out_error: *mut *mut c_char,
) -> c_int {
    if runtime.is_null() {
        if !out_error.is_null() {
            *out_error = error_to_c_string(BoxliteError::Internal("runtime is null".to_string()));
        }
        return -1;
    }

    let runtime_ref = &*runtime;

    let metrics = runtime_ref.tokio_rt.block_on(runtime_ref.runtime.metrics());

    let json = serde_json::json!({
        "boxes_created_total": metrics.boxes_created_total(),
        "boxes_failed_total": metrics.boxes_failed_total(),
        "num_running_boxes": metrics.num_running_boxes(),
        "total_commands_executed": metrics.total_commands_executed(),
        "total_exec_errors": metrics.total_exec_errors()
    });
    write_json_output(json, out_json)
}

/// Get box info from handle as JSON
///
/// # Arguments
/// * `handle` - Box handle
/// * `out_json` - Output parameter for JSON object
/// * `out_error` - Output parameter for error message
///
/// # Returns
/// 0 on success, -1 on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_info(
    handle: *mut CBoxHandle,
    out_json: *mut *mut c_char,
    out_error: *mut *mut c_char,
) -> c_int {
    if handle.is_null() {
        if !out_error.is_null() {
            *out_error = error_to_c_string(BoxliteError::Internal("handle is null".to_string()));
        }
        return -1;
    }

    let handle_ref = &*handle;
    let info = handle_ref.handle.info();
    write_json_output(box_info_to_json(&info), out_json)
}

/// Get box metrics from handle as JSON
///
/// # Arguments
/// * `handle` - Box handle
/// * `out_json` - Output parameter for JSON object
/// * `out_error` - Output parameter for error message
///
/// # Returns
/// 0 on success, -1 on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_metrics(
    handle: *mut CBoxHandle,
    out_json: *mut *mut c_char,
    out_error: *mut *mut c_char,
) -> c_int {
    if handle.is_null() {
        if !out_error.is_null() {
            *out_error = error_to_c_string(BoxliteError::Internal("handle is null".to_string()));
        }
        return -1;
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
            write_json_output(json, out_json)
        }
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            -1
        }
    }
}

/// Start or restart a stopped box
///
/// # Arguments
/// * `handle` - Box handle
/// * `out_error` - Output parameter for error message
///
/// # Returns
/// 0 on success, -1 on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_start_box(
    handle: *mut CBoxHandle,
    out_error: *mut *mut c_char,
) -> c_int {
    if handle.is_null() {
        if !out_error.is_null() {
            *out_error = error_to_c_string(BoxliteError::Internal("handle is null".to_string()));
        }
        return -1;
    }

    let handle_ref = &*handle;

    let result = handle_ref.tokio_rt.block_on(handle_ref.handle.start());

    match result {
        Ok(_) => 0,
        Err(e) => {
            if !out_error.is_null() {
                *out_error = error_to_c_string(e);
            }
            -1
        }
    }
}

/// Get box ID string from handle
///
/// # Arguments
/// * `handle` - Box handle
///
/// # Returns
/// Pointer to C string (caller must free with boxlite_free_string), NULL on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_id(handle: *mut CBoxHandle) -> *mut c_char {
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

/// Free a runtime instance
///
/// # Arguments
/// * `runtime` - Runtime instance to free (can be NULL)
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_free(runtime: *mut CBoxliteRuntime) {
    if !runtime.is_null() {
        unsafe {
            drop(Box::from_raw(runtime));
        }
    }
}

/// Free a string allocated by BoxLite
///
/// # Arguments
/// * `str` - String to free (can be NULL)
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_string(str: *mut c_char) {
    if !str.is_null() {
        unsafe {
            drop(CString::from_raw(str));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        unsafe {
            let version = CStr::from_ptr(boxlite_version()).to_str().unwrap();
            assert!(!version.is_empty());
            assert!(version.contains('.'));
        }
    }
}
