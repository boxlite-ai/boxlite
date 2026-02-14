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

use std::os::raw::{c_char, c_int, c_void};

// Import internal FFI types from shared layer
use boxlite_ffi::error::{BoxliteErrorCode, FFIError};
use boxlite_ffi::runner::{BoxRunner, ExecResult};
use boxlite_ffi::runtime::{BoxHandle, RuntimeHandle};

// Define C-compatible type aliases for the C header
pub type CBoxliteRuntime = RuntimeHandle;
pub type CBoxHandle = BoxHandle;
pub type CBoxliteSimple = BoxRunner;
pub type CBoxliteError = FFIError;
pub type CBoxliteExecResult = ExecResult;

// ============================================================================
// Public API Functions
// ============================================================================

/// Get BoxLite version string
///
/// # Returns
/// A pointer to a static C string containing the version. Do not free this string.
///
/// # Example
/// ```c
/// printf("BoxLite Version: %s\n", boxlite_version());
/// ```
#[unsafe(no_mangle)]
pub extern "C" fn boxlite_version() -> *const c_char {
    boxlite_ffi::ops::version()
}

/// Create a new BoxLite runtime configuration.
///
/// # Arguments
/// * `home_dir` - Optional path to the home directory. If NULL, defaults to `~/.boxlite`.
/// * `registries_json` - Optional JSON array of registry configurations.
/// * `out_runtime` - Output parameter to store the created `CBoxliteRuntime` pointer.
/// * `out_error` - Output parameter for error information.
///
/// # Returns
/// `BoxliteErrorCode::Ok` on success, or an error code on failure.
///
/// # Example
/// ```c
/// CBoxliteRuntime *runtime;
/// CBoxliteError *error = malloc(sizeof(CBoxliteError));
/// if (boxlite_runtime_new(NULL, NULL, &runtime, error) != BOXLITE_OK) {
///     fprintf(stderr, "Failed to create runtime\n");
/// }
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_new(
    home_dir: *const c_char,
    registries_json: *const c_char,
    out_runtime: *mut *mut CBoxliteRuntime,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::runtime_new(home_dir, registries_json, out_runtime, out_error)
}

/// Create a new box with the given options (JSON).
///
/// # Arguments
/// * `runtime` - Pointer to the active `CBoxliteRuntime`.
/// * `options_json` - JSON string defining the box (e.g., image, resources).
/// * `out_box` - Output parameter to store the created `CBoxHandle`.
/// * `out_error` - Output parameter for error information.
///
/// # Returns
/// `BoxliteErrorCode::Ok` on success.
///
/// # Example
/// ```c
/// const char *options = "{\"rootfs\": {\"Image\": \"alpine:latest\"}}";
/// CBoxHandle *box;
/// if (boxlite_create_box(runtime, options, &box, error) == BOXLITE_OK) {
///     // Use box...
/// }
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_create_box(
    runtime: *mut CBoxliteRuntime,
    options_json: *const c_char,
    out_box: *mut *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::box_create(runtime, options_json, std::ptr::null(), out_box, out_error)
}

/// Execute a command in a box.
///
/// # Arguments
/// * `handle` - Box handle.
/// * `command` - Command to execute (e.g., "/bin/sh").
/// * `args_json` - JSON array of arguments, e.g.: `["-c", "echo hello"]`.
/// * `callback` - Optional callback for streaming output.
/// * `user_data` - User data passed to callback.
/// * `out_exit_code` - Output parameter for command exit code.
/// * `out_error` - Output parameter for error information.
///
/// # Returns
/// `BoxliteErrorCode::Ok` on success.
///
/// # Example
/// ```c
/// int exit_code;
/// const char *args = "[\"hello\"]";
/// if (boxlite_execute(box, "echo", args, NULL, NULL, &exit_code, error) == BOXLITE_OK) {
///     printf("Exit code: %d\n", exit_code);
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
    boxlite_ffi::ops::box_exec(
        handle,
        command,
        args_json,
        callback,
        user_data,
        out_exit_code,
        out_error,
    )
}

/// Stop a box.
///
/// # Arguments
/// * `handle` - Box handle.
/// * `out_error` - output error.
///
/// # Example
/// ```c
/// boxlite_stop_box(box, error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_stop_box(
    handle: *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::box_stop(handle, out_error)
}

/// List all boxes as JSON.
///
/// # Arguments
/// * `runtime` - Runtime handle.
/// * `out_json` - Output pointer for JSON string. Caller must free this with `boxlite_free_string`.
/// * `out_error` - Output error.
///
/// # Example
/// ```c
/// char *json;
/// if (boxlite_list_info(runtime, &json, error) == BOXLITE_OK) {
///     printf("Boxes: %s\n", json);
///     boxlite_free_string(json);
/// }
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_list_info(
    runtime: *mut CBoxliteRuntime,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::box_list(runtime, out_json, out_error)
}

/// Get single box info as JSON.
///
/// # Arguments
/// * `runtime` - Runtime handle.
/// * `id_or_name` - ID or name of the box.
/// * `out_json` - Output pointer for JSON string.
/// * `out_error` - Output error.
///
/// # Example
/// ```c
/// char *json;
/// boxlite_get_info(runtime, "my-box", &json, error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get_info(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::box_inspect(runtime, id_or_name, out_json, out_error)
}

/// Attach to an existing box.
///
/// # Arguments
/// * `runtime` - Runtime handle.
/// * `id_or_name` - ID or name of the box.
/// * `out_handle` - Output pointer for box handle.
/// * `out_error` - Output error.
///
/// # Example
/// ```c
/// CBoxHandle *handle;
/// if (boxlite_get(runtime, "my-box", &handle, error) == BOXLITE_OK) {
///     // Use handle...
/// }
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    out_handle: *mut *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::box_attach(runtime, id_or_name, out_handle, out_error)
}

/// Remove a box.
///
/// # Arguments
/// * `runtime` - Runtime handle.
/// * `id_or_name` - ID or name of the box.
/// * `force` - 1 to force remove (stop if running), 0 otherwise.
/// * `out_error` - Output error.
///
/// # Example
/// ```c
/// boxlite_remove(runtime, "my-box", 1, error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_remove(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    force: c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::box_remove(runtime, id_or_name, force != 0, out_error)
}

/// Get runtime metrics as JSON.
///
/// # Arguments
/// * `runtime` - Runtime handle.
/// * `out_json` - Output pointer for JSON string.
/// * `out_error` - Output error.
///
/// # Example
/// ```c
/// char *json;
/// boxlite_runtime_metrics(runtime, &json, error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_metrics(
    runtime: *mut CBoxliteRuntime,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::runtime_metrics(runtime, out_json, out_error)
}

/// Gracefully shutdown all boxes in this runtime.
///
/// # Arguments
/// * `runtime` - Runtime handle.
/// * `timeout` - Seconds to wait before force-killing each box:
///   - 0 - Use default timeout (10 seconds)
///   - Positive integer - Wait that many seconds
///   - -1 - Wait indefinitely (no timeout)
/// * `out_error` - Output parameter for error information
///
/// # Example
/// ```c
/// boxlite_runtime_shutdown(runtime, 5, error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_shutdown(
    runtime: *mut CBoxliteRuntime,
    timeout: c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let timeout_opt = if timeout == 0 { None } else { Some(timeout) };
    boxlite_ffi::ops::runtime_shutdown(runtime, timeout_opt, out_error)
}

/// Get info for a box handle as JSON.
///
/// # Arguments
/// * `handle` - Box handle.
/// * `out_json` - Output pointer for JSON string.
/// * `out_error` - Output error.
///
/// # Example
/// ```c
/// char *json;
/// boxlite_box_info(handle, &json, error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_info(
    handle: *mut CBoxHandle,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::box_inspect_handle(handle, out_json, out_error)
}

/// Get metrics for a box handle as JSON.
///
/// # Arguments
/// * `handle` - Box handle.
/// * `out_json` - Output pointer for JSON string.
/// * `out_error` - Output error.
///
/// # Example
/// ```c
/// char *json;
/// boxlite_box_metrics(handle, &json, error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_metrics(
    handle: *mut CBoxHandle,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::box_metrics(handle, out_json, out_error)
}

/// Start a stopped box.
///
/// # Arguments
/// * `handle` - Box handle.
/// * `out_error` - output error.
///
/// # Example
/// ```c
/// boxlite_start_box(handle, error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_start_box(
    handle: *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::box_start(handle, out_error)
}

/// Get box ID.
///
/// # Arguments
/// * `handle` - Box handle.
///
/// # Returns
/// Pointer to a C string containing the ID. Must be freed with `boxlite_free_string`.
///
/// # Example
/// ```c
/// char *id = boxlite_box_id(handle);
/// printf("Box ID: %s\n", id);
/// boxlite_free_string(id);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_id(handle: *mut CBoxHandle) -> *mut c_char {
    boxlite_ffi::ops::box_id(handle)
}

// ============================================================================
// Runner API (formerly Simple API)
// ============================================================================

/// Create a simplified box runner.
///
/// # Arguments
/// * `image` - Container image.
/// * `cpus` - Number of CPUs.
/// * `memory_mib` - Memory in MiB.
/// * `out_box` - Output pointer for `CBoxliteSimple,`.
/// * `out_error` - Output error.
///
/// # Returns
/// `BoxliteErrorCode::Ok` on success.
///
/// # Example
/// ```c
/// CBoxliteSimple, *runner;
/// if (boxlite_simple_new("alpine", 1, 128, &runner, error) == BOXLITE_OK) {
///     // Use runner...
/// }
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_simple_new(
    image: *const c_char,
    cpus: c_int,
    memory_mib: c_int,
    out_box: *mut *mut CBoxliteSimple,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::runner_new(image, cpus, memory_mib, out_box, out_error)
}

/// Run a command using the simplified runner.
///
/// # Arguments
/// * `box_runner` - Runner handle.
/// * `command` - Command to execute.
/// * `args` - Array of argument strings.
/// * `argc` - Count of arguments.
/// * `out_result` - Output pointer for `CBoxliteExecResult`.
/// * `out_error` - Output error.
///
/// # Example
/// ```c
/// CBoxliteExecResult *result;
/// const char *args[] = {"hello"};
/// boxlite_simple_run(runner, "echo", args, 1, &result, error);
/// ```
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_simple_run(
    box_runner: *mut CBoxliteSimple,
    command: *const c_char,
    args: *const *const c_char,
    argc: c_int,
    out_result: *mut *mut CBoxliteExecResult,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    boxlite_ffi::ops::runner_exec(box_runner, command, args, argc, out_result, out_error)
}

// ============================================================================
// Memory Management
// ============================================================================

/// Free an execution result.
///
/// # Arguments
/// * `result` - Pointer to `CBoxliteExecResult` to free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_result_free(result: *mut CBoxliteExecResult) {
    boxlite_ffi::ops::result_free(result)
}

/// Free a simple runner.
///
/// # Arguments
/// * `box_runner` - Pointer to `CBoxliteSimple,` to free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_simple_free(box_runner: *mut CBoxliteSimple) {
    boxlite_ffi::ops::runner_free(box_runner)
}

/// Free a box handle.
///
/// # Arguments
/// * `handle` - Pointer to `CBoxHandle` to free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_free(handle: *mut CBoxHandle) {
    boxlite_ffi::ops::box_free(handle)
}

/// Free a runtime handle.
///
/// # Arguments
/// * `runtime` - Pointer to `CBoxliteRuntime` to free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_free(runtime: *mut CBoxliteRuntime) {
    boxlite_ffi::ops::runtime_free(runtime)
}

/// Free a string allocated by the library.
///
/// # Arguments
/// * `s` - Pointer to string to free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_string(s: *mut c_char) {
    boxlite_ffi::ops::string_free(s)
}

/// Free an error object.
///
/// # Arguments
/// * `error` - Pointer to `CBoxliteError` to free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_error_free(error: *mut CBoxliteError) {
    boxlite_ffi::ops::error_free(error)
}
