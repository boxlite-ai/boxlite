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
use boxlite::BoxliteError;
use boxlite::litebox::LiteBox;
use boxlite::runtime::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use boxlite::runtime::types::{BoxInfo, BoxStatus};

// ============================================================================
// Error Code Enum - Maps to BoxliteError variants
// ============================================================================

/// Error codes returned by BoxLite C API functions.
///
/// These codes map directly to Rust's BoxliteError variants,
/// allowing programmatic error handling in C.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoxliteErrorCode {
    /// Operation succeeded
    Ok = 0,
    /// Internal error
    Internal = 1,
    /// Resource not found
    NotFound = 2,
    /// Resource already exists
    AlreadyExists = 3,
    /// Invalid state for operation
    InvalidState = 4,
    /// Invalid argument provided
    InvalidArgument = 5,
    /// Configuration error
    Config = 6,
    /// Storage error
    Storage = 7,
    /// Image error
    Image = 8,
    /// Network error
    Network = 9,
    /// Execution error
    Execution = 10,
    /// Resource stopped
    Stopped = 11,
    /// Engine error
    Engine = 12,
    /// Unsupported operation
    Unsupported = 13,
    /// Database error
    Database = 14,
    /// Portal/communication error
    Portal = 15,
    /// RPC error
    Rpc = 16,
}

/// Extended error information for C API.
///
/// Contains both an error code (for programmatic handling)
/// and an optional detailed message (for debugging).
#[repr(C)]
pub struct CBoxliteError {
    /// Error code
    pub code: BoxliteErrorCode,
    /// Detailed error message (NULL if none, caller must free with boxlite_error_free)
    pub message: *mut c_char,
}

impl Default for CBoxliteError {
    fn default() -> Self {
        CBoxliteError {
            code: BoxliteErrorCode::Ok,
            message: ptr::null_mut(),
        }
    }
}

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

/// Opaque handle for simple API (auto-manages runtime)
pub struct CBoxliteSimple {
    runtime: BoxliteRuntime,
    handle: Option<LiteBox>,
    box_id: Option<BoxID>,
    tokio_rt: Arc<TokioRuntime>,
}

// ============================================================================
// Error Conversion Helpers
// ============================================================================

/// Map BoxliteError to BoxliteErrorCode
fn error_to_code(err: &BoxliteError) -> BoxliteErrorCode {
    match err {
        BoxliteError::Internal(_) => BoxliteErrorCode::Internal,
        BoxliteError::NotFound(_) => BoxliteErrorCode::NotFound,
        BoxliteError::AlreadyExists(_) => BoxliteErrorCode::AlreadyExists,
        BoxliteError::InvalidState(_) => BoxliteErrorCode::InvalidState,
        BoxliteError::InvalidArgument(_) => BoxliteErrorCode::InvalidArgument,
        BoxliteError::Config(_) => BoxliteErrorCode::Config,
        BoxliteError::Storage(_) => BoxliteErrorCode::Storage,
        BoxliteError::Image(_) => BoxliteErrorCode::Image,
        BoxliteError::Network(_) => BoxliteErrorCode::Network,
        BoxliteError::Execution(_) => BoxliteErrorCode::Execution,
        BoxliteError::Stopped(_) => BoxliteErrorCode::Stopped,
        BoxliteError::Engine(_) => BoxliteErrorCode::Engine,
        BoxliteError::Unsupported(_) => BoxliteErrorCode::Unsupported,
        BoxliteError::UnsupportedEngine => BoxliteErrorCode::Unsupported,
        BoxliteError::Database(_) => BoxliteErrorCode::Database,
        BoxliteError::Portal(_) => BoxliteErrorCode::Portal,
        BoxliteError::Rpc(_) | BoxliteError::RpcTransport(_) => BoxliteErrorCode::Rpc,
        BoxliteError::MetadataError(_) => BoxliteErrorCode::Internal,
    }
}

/// Convert Rust error to C error struct
fn error_to_c_error(err: BoxliteError) -> CBoxliteError {
    let code = error_to_code(&err);
    let message = error_to_c_string(err);
    CBoxliteError { code, message }
}

/// Write error to output parameter (if not NULL)
fn write_error(out_error: *mut CBoxliteError, err: BoxliteError) {
    if !out_error.is_null() {
        unsafe {
            *out_error = error_to_c_error(err);
        }
    }
}

/// Helper to create InvalidArgument error for NULL pointers
fn null_pointer_error(param_name: &str) -> BoxliteError {
    BoxliteError::InvalidArgument(format!("{} is null", param_name))
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
    out_runtime: *mut *mut CBoxliteRuntime,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if out_runtime.is_null() {
        write_error(out_error, null_pointer_error("out_runtime"));
        return BoxliteErrorCode::InvalidArgument;
    }

    // Create tokio runtime
    let tokio_rt = match TokioRuntime::new() {
        Ok(rt) => Arc::new(rt),
        Err(e) => {
            let err = BoxliteError::Internal(format!("Failed to create async runtime: {}", e));
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

    *out_runtime = Box::into_raw(Box::new(CBoxliteRuntime { runtime, tokio_rt }));
    BoxliteErrorCode::Ok
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
    out_box: *mut *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
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

    let options: BoxOptions = match serde_json::from_str(&options_str) {
        Ok(opts) => opts,
        Err(e) => {
            let err = BoxliteError::Internal(format!("Invalid JSON options: {}", e));
            write_error(out_error, err);
            return BoxliteErrorCode::Internal;
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
            *out_box = Box::into_raw(Box::new(CBoxHandle {
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

/// Execute a command in a box
///
/// # Arguments
/// * `handle` - Box handle
/// * `command` - Command to execute
/// * `args_json` - JSON array of arguments, e.g.: `["arg1", "arg2"]`
/// * `callback` - Optional callback for streaming output (chunk_text, is_stderr, user_data)
/// * `user_data` - User data passed to callback
/// * `out_exit_code` - Output parameter for command exit code
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure
///
/// # Example
/// ```c
/// int exit_code;
/// CBoxliteError error = {0};
/// const char *args = "[\"hello\"]";
/// BoxliteErrorCode code = boxlite_execute(box, "echo", args, NULL, NULL, &exit_code, &error);
/// if (code == BOXLITE_OK) {
///     printf("Command exited with code: %d\n", exit_code);
/// }
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_execute(
    handle: *mut CBoxHandle,
    command: *const c_char,
    args_json: *const c_char,
    callback: Option<extern "C" fn(*const c_char, c_int, *mut c_void)>,
    user_data: *mut c_void,
    out_exit_code: *mut c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
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

        // Wait for execution to complete
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

/// Stop a box
///
/// # Arguments
/// * `handle` - Box handle (will be consumed/freed)
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_stop_box(
    handle: *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if handle.is_null() {
        write_error(out_error, null_pointer_error("handle"));
        return BoxliteErrorCode::InvalidArgument;
    }

    let handle_box = Box::from_raw(handle);

    // Block on async stop using the stored tokio runtime
    let result = handle_box.tokio_rt.block_on(handle_box.handle.stop());

    match result {
        Ok(_) => BoxliteErrorCode::Ok,
        Err(e) => {
            let code = error_to_code(&e);
            write_error(out_error, e);
            code
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
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure
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
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
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
            let json_array: Vec<serde_json::Value> = boxes.iter().map(box_info_to_json).collect();
            let json_str = match serde_json::to_string(&json_array) {
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
        Err(e) => {
            let code = error_to_code(&e);
            write_error(out_error, e);
            code
        }
    }
}

/// Get single box info as JSON
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `id_or_name` - Box ID (full or prefix) or name
/// * `out_json` - Output parameter for JSON object
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure (including box not found)
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get_info(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
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
        Ok(None) => {
            let err = BoxliteError::NotFound(id_str.clone());
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

/// Get box handle for reattaching to an existing box
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `id_or_name` - Box ID (full or prefix) or name
/// * `out_handle` - Output parameter for box handle
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure (including box not found)
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    out_handle: *mut *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
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
            *out_handle = Box::into_raw(Box::new(CBoxHandle {
                handle,
                box_id,
                tokio_rt: runtime_ref.tokio_rt.clone(),
            }));
            BoxliteErrorCode::Ok
        }
        Ok(None) => {
            let err = BoxliteError::NotFound(id_str.clone());
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

/// Remove a box
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `id_or_name` - Box ID (full or prefix) or name
/// * `force` - If non-zero, force remove even if running
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_remove(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    force: c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
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
        .block_on(runtime_ref.runtime.remove(&id_str, force != 0));

    match result {
        Ok(_) => BoxliteErrorCode::Ok,
        Err(e) => {
            let code = error_to_code(&e);
            write_error(out_error, e);
            code
        }
    }
}

/// Get runtime metrics as JSON
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `out_json` - Output parameter for JSON object
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_metrics(
    runtime: *mut CBoxliteRuntime,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if runtime.is_null() {
        write_error(out_error, null_pointer_error("runtime"));
        return BoxliteErrorCode::InvalidArgument;
    }
    if out_json.is_null() {
        write_error(out_error, null_pointer_error("out_json"));
        return BoxliteErrorCode::InvalidArgument;
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

/// Gracefully shutdown all boxes in this runtime.
///
/// This method stops all running boxes, waiting up to `timeout` seconds
/// for each box to stop gracefully before force-killing it.
///
/// After calling this method, the runtime is permanently shut down and
/// will return errors for any new operations (like `create()`).
///
/// # Arguments
/// * `runtime` - BoxLite runtime instance
/// * `timeout` - Seconds to wait before force-killing each box:
///   - 0 - Use default timeout (10 seconds)
///   - Positive integer - Wait that many seconds
///   - -1 - Wait indefinitely (no timeout)
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_shutdown(
    runtime: *mut CBoxliteRuntime,
    timeout: c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if runtime.is_null() {
        write_error(out_error, null_pointer_error("runtime"));
        return BoxliteErrorCode::InvalidArgument;
    }

    let runtime_ref = &*runtime;

    // C API: 0 = default (maps to Rust None), positive = timeout, -1 = infinite
    let timeout_opt = if timeout == 0 { None } else { Some(timeout) };

    let result = runtime_ref
        .tokio_rt
        .block_on(runtime_ref.runtime.shutdown(timeout_opt));

    match result {
        Ok(()) => BoxliteErrorCode::Ok,
        Err(e) => {
            let code = error_to_code(&e);
            write_error(out_error, e);
            code
        }
    }
}

/// Get box info from handle as JSON
///
/// # Arguments
/// * `handle` - Box handle
/// * `out_json` - Output parameter for JSON object
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_info(
    handle: *mut CBoxHandle,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
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

/// Get box metrics from handle as JSON
///
/// # Arguments
/// * `handle` - Box handle
/// * `out_json` - Output parameter for JSON object
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_metrics(
    handle: *mut CBoxHandle,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
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
        Err(e) => {
            let code = error_to_code(&e);
            write_error(out_error, e);
            code
        }
    }
}

/// Start or restart a stopped box
///
/// # Arguments
/// * `handle` - Box handle
/// * `out_error` - Output parameter for error information
///
/// # Returns
/// BoxliteErrorCode::Ok on success, error code on failure
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_start_box(
    handle: *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if handle.is_null() {
        write_error(out_error, null_pointer_error("handle"));
        return BoxliteErrorCode::InvalidArgument;
    }

    let handle_ref = &*handle;

    let result = handle_ref.tokio_rt.block_on(handle_ref.handle.start());

    match result {
        Ok(_) => BoxliteErrorCode::Ok,
        Err(e) => {
            let code = error_to_code(&e);
            write_error(out_error, e);
            code
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

// ============================================================================
// Simple Convenience API
// ============================================================================

/// Result structure for simple API command execution
#[repr(C)]
pub struct CBoxliteExecResult {
    pub exit_code: c_int,
    pub stdout_text: *mut c_char,
    pub stderr_text: *mut c_char,
}

/// Create and start a box using simple API
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_simple_new(
    image: *const c_char,
    cpus: c_int,
    memory_mib: c_int,
    out_box: *mut *mut CBoxliteSimple,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if image.is_null() {
        write_error(out_error, null_pointer_error("image"));
        return BoxliteErrorCode::InvalidArgument;
    }
    if out_box.is_null() {
        write_error(out_error, null_pointer_error("out_box"));
        return BoxliteErrorCode::InvalidArgument;
    }

    let image_str = match c_str_to_string(image) {
        Ok(s) => s,
        Err(e) => {
            write_error(out_error, e);
            return BoxliteErrorCode::InvalidArgument;
        }
    };

    let tokio_rt = match TokioRuntime::new() {
        Ok(rt) => Arc::new(rt),
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
            let simple_box = Box::new(CBoxliteSimple {
                runtime,
                handle: Some(handle),
                box_id: Some(box_id),
                tokio_rt,
            });
            *out_box = Box::into_raw(simple_box);
            BoxliteErrorCode::Ok
        }
        Err(e) => {
            let code = error_to_code(&e);
            write_error(out_error, e);
            code
        }
    }
}

/// Run a command and get buffered result
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_simple_run(
    simple_box: *mut CBoxliteSimple,
    command: *const c_char,
    args: *const *const c_char,
    argc: c_int,
    out_result: *mut *mut CBoxliteExecResult,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if simple_box.is_null() {
        write_error(out_error, null_pointer_error("simple_box"));
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

    let simple_ref = &mut *simple_box;

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

    let handle = match &simple_ref.handle {
        Some(h) => h,
        None => {
            write_error(
                out_error,
                BoxliteError::InvalidState("Box not initialized".to_string()),
            );
            return BoxliteErrorCode::InvalidState;
        }
    };

    let result = simple_ref.tokio_rt.block_on(async {
        let mut cmd = boxlite::BoxCommand::new(cmd_str);
        cmd = cmd.args(arg_vec);

        let mut execution = handle.exec(cmd).await?;

        use futures::StreamExt;
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

            let exec_result = Box::new(CBoxliteExecResult {
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

/// Free execution result
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_result_free(result: *mut CBoxliteExecResult) {
    if !result.is_null() {
        let result_box = Box::from_raw(result);
        if !result_box.stdout_text.is_null() {
            drop(CString::from_raw(result_box.stdout_text));
        }
        if !result_box.stderr_text.is_null() {
            drop(CString::from_raw(result_box.stderr_text));
        }
    }
}

/// Free simple box (auto-cleanup)
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_simple_free(simple_box: *mut CBoxliteSimple) {
    if !simple_box.is_null() {
        let mut simple = Box::from_raw(simple_box);

        if let Some(handle) = simple.handle.take() {
            let _ = simple.tokio_rt.block_on(handle.stop());
        }

        if let Some(box_id) = simple.box_id.take() {
            let _ = simple
                .tokio_rt
                .block_on(simple.runtime.remove(box_id.as_ref(), true));
        }

        drop(simple);
    }
}

// ============================================================================
// Memory Management
// ============================================================================

/// Free a runtime instance
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_free(runtime: *mut CBoxliteRuntime) {
    if !runtime.is_null() {
        unsafe {
            drop(Box::from_raw(runtime));
        }
    }
}

/// Free a string allocated by BoxLite
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_string(str: *mut c_char) {
    if !str.is_null() {
        unsafe {
            drop(CString::from_raw(str));
        }
    }
}

/// Free error struct
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_error_free(error: *mut CBoxliteError) {
    if !error.is_null() {
        let err = &mut *error;
        if !err.message.is_null() {
            drop(CString::from_raw(err.message));
            err.message = ptr::null_mut();
        }
        err.code = BoxliteErrorCode::Ok;
    }
}

// ============================================================================
// Unit Tests
// ============================================================================

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
        let c_err = error_to_c_error(err);
        assert_eq!(c_err.code, BoxliteErrorCode::NotFound);
        assert!(!c_err.message.is_null());
        unsafe {
            boxlite_error_free(&mut CBoxliteError {
                code: c_err.code,
                message: c_err.message,
            } as *mut _);
        }
    }

    #[test]
    fn test_null_pointer_validation() {
        unsafe {
            let mut error = CBoxliteError::default();
            let code = boxlite_simple_new(ptr::null(), 0, 0, ptr::null_mut(), &mut error as *mut _);
            assert_eq!(code, BoxliteErrorCode::InvalidArgument);
            assert!(!error.message.is_null());
            boxlite_error_free(&mut error as *mut _);
        }
    }

    #[test]
    fn test_c_string_conversion() {
        let test_str = CString::new("hello").unwrap();
        unsafe {
            let result = c_str_to_string(test_str.as_ptr());
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), "hello");
        }
    }

    #[test]
    fn test_c_string_null_handling() {
        unsafe {
            let result = c_str_to_string(ptr::null());
            assert!(result.is_err());
        }
    }

    #[test]
    fn test_status_to_string() {
        assert_eq!(status_to_string(BoxStatus::Unknown), "unknown");
        assert_eq!(status_to_string(BoxStatus::Configured), "configured");
        assert_eq!(status_to_string(BoxStatus::Running), "running");
        assert_eq!(status_to_string(BoxStatus::Stopping), "stopping");
        assert_eq!(status_to_string(BoxStatus::Stopped), "stopped");
    }

    #[test]
    fn test_default_error_struct() {
        let err = CBoxliteError::default();
        assert_eq!(err.code, BoxliteErrorCode::Ok);
        assert!(err.message.is_null());
    }

    #[test]
    fn test_error_free_null_safe() {
        unsafe {
            boxlite_error_free(ptr::null_mut());
            // Should not panic
        }
    }

    #[test]
    fn test_result_free_null_safe() {
        unsafe {
            boxlite_result_free(ptr::null_mut());
            // Should not panic
        }
    }

    #[test]
    fn test_simple_free_null_safe() {
        unsafe {
            boxlite_simple_free(ptr::null_mut());
            // Should not panic
        }
    }
}
