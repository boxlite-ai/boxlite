// BoxLite Go SDK - Rust Bridge Layer
//
// 将 boxlite-ffi 的内部实现暴露为 Go CGo 可调用的 C ABI 函数。

use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::ptr;

use boxlite_ffi::error::{BoxliteErrorCode, FFIError};
use boxlite_ffi::ops::{
    box_attach, box_create, box_free, box_id, box_inspect_handle, box_list, box_remove, box_start,
    box_stop, error_free,
};
use boxlite_ffi::runtime::RuntimeHandle;

// Import from boxlite core
use boxlite::BoxliteOptions;
use boxlite::BoxliteRuntime;
use boxlite_ffi::runtime::create_tokio_runtime;
use boxlite_ffi::runtime::BoxHandle;
use std::path::PathBuf;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

fn set_error(out_err: *mut *mut c_char, msg: &str) {
    if !out_err.is_null() {
        if let Ok(c_msg) = CString::new(msg.to_string()) {
            unsafe {
                *out_err = c_msg.into_raw();
            }
        }
    }
}

unsafe fn c_str_to_string(s: *const c_char) -> Result<String, String> {
    if s.is_null() {
        return Err("null pointer".to_string());
    }
    std::ffi::CStr::from_ptr(s)
        .to_str()
        .map(|s| s.to_string())
        .map_err(|e| format!("invalid UTF-8: {}", e))
}

fn error_msg(err: &FFIError) -> String {
    if err.message.is_null() {
        "unknown error".to_string()
    } else {
        unsafe { std::ffi::CStr::from_ptr(err.message) }
            .to_str()
            .unwrap_or("unknown error")
            .to_string()
    }
}

// ============================================================================
// STRING MANAGEMENT
// ============================================================================

/// Free a string allocated by any boxlite_go_* function.
///
/// # Safety
/// `s` must be a valid pointer allocated by a boxlite_go_* function, or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_free_string(s: *mut c_char) {
    if !s.is_null() {
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

// ============================================================================
// RUNTIME MANAGEMENT
// ============================================================================

/// Create a new BoxLite runtime.
///
/// Returns a pointer to RuntimeHandle on success, NULL on failure.
/// out_err receives error message on failure (caller must free with boxlite_go_free_string).
///
/// # Safety
/// * `config_json` must be null or a null-terminated UTF-8 JSON string.
/// * `out_err` must be a valid pointer to a `*mut c_char` or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_runtime_new(
    config_json: *const c_char,
    out_err: *mut *mut c_char,
) -> *mut RuntimeHandle {
    let mut options = BoxliteOptions::default();

    if !config_json.is_null() {
        let config_str = match unsafe { c_str_to_string(config_json) } {
            Ok(s) => s,
            Err(e) => {
                set_error(out_err, &format!("Invalid config string: {}", e));
                return ptr::null_mut();
            }
        };

        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&config_str) {
            if let Some(home_dir) = json.get("home_dir").and_then(|v| v.as_str()) {
                options.home_dir = PathBuf::from(home_dir);
            }
            if let Some(registries) = json.get("image_registries").and_then(|v| v.as_array()) {
                options.image_registries = registries
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
            }
        }
    }

    let tokio_rt = match create_tokio_runtime() {
        Ok(rt) => rt,
        Err(e) => {
            set_error(out_err, &format!("Failed to create tokio runtime: {}", e));
            return ptr::null_mut();
        }
    };

    let runtime = match BoxliteRuntime::new(options) {
        Ok(rt) => rt,
        Err(e) => {
            set_error(out_err, &format!("Failed to create runtime: {}", e));
            return ptr::null_mut();
        }
    };

    Box::into_raw(Box::new(RuntimeHandle { runtime, tokio_rt }))
}

/// Free a runtime.
///
/// # Safety
/// `runtime` must be a valid pointer to a RuntimeHandle, or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_runtime_free(runtime: *mut RuntimeHandle) {
    if !runtime.is_null() {
        unsafe {
            drop(Box::from_raw(runtime));
        }
    }
}

// ============================================================================
// BOX CRUD OPERATIONS
// ============================================================================

/// Create a new box. Returns box ID string on success (caller must free), NULL on failure.
///
/// # Safety
/// All pointer parameters must be valid or null as described.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_create_box(
    runtime: *mut RuntimeHandle,
    opts_json: *const c_char,
    name: *const c_char,
    out_err: *mut *mut c_char,
) -> *mut c_char {
    let mut error = FFIError::default();
    let mut box_handle: *mut BoxHandle = ptr::null_mut();

    let code = unsafe { box_create(runtime, opts_json, name, &mut box_handle, &mut error) };

    if code != BoxliteErrorCode::Ok {
        if !out_err.is_null() {
            let msg = error_msg(&error);
            unsafe { error_free(&mut error) };
            set_error(out_err, &msg);
        } else {
            unsafe { error_free(&mut error) };
        }
        return ptr::null_mut();
    }

    // Get box ID and return it, then free the handle
    let id = unsafe { box_id(box_handle) };
    unsafe { box_free(box_handle) };
    id
}

/// Get a box handle by ID or name. Returns box handle pointer on success, NULL if not found.
///
/// # Safety
/// All pointer parameters must be valid or null as described.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_get_box(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    out_err: *mut *mut c_char,
) -> *mut BoxHandle {
    let mut error = FFIError::default();
    let mut handle: *mut BoxHandle = ptr::null_mut();

    let code = unsafe { box_attach(runtime, id_or_name, &mut handle, &mut error) };

    if code == BoxliteErrorCode::NotFound {
        unsafe { error_free(&mut error) };
        return ptr::null_mut();
    }

    if code != BoxliteErrorCode::Ok {
        if !out_err.is_null() {
            let msg = error_msg(&error);
            unsafe { error_free(&mut error) };
            set_error(out_err, &msg);
        } else {
            unsafe { error_free(&mut error) };
        }
        return ptr::null_mut();
    }

    handle
}

/// List all boxes as JSON array. Returns 0 on success, -1 on failure.
///
/// # Safety
/// All pointer parameters must be valid or null as described.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_list_boxes(
    runtime: *mut RuntimeHandle,
    out_json: *mut *mut c_char,
    out_err: *mut *mut c_char,
) -> c_int {
    let mut error = FFIError::default();

    let code = unsafe { box_list(runtime, out_json, &mut error) };

    if code != BoxliteErrorCode::Ok {
        if !out_err.is_null() {
            let msg = error_msg(&error);
            unsafe { error_free(&mut error) };
            set_error(out_err, &msg);
        } else {
            unsafe { error_free(&mut error) };
        }
        return -1;
    }
    0
}

/// Remove a box. Returns 0 on success, -1 on failure.
///
/// # Safety
/// All pointer parameters must be valid or null as described.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_remove_box(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    force: bool,
    out_err: *mut *mut c_char,
) -> c_int {
    let mut error = FFIError::default();

    let code = unsafe { box_remove(runtime, id_or_name, force, &mut error) };

    if code != BoxliteErrorCode::Ok {
        if !out_err.is_null() {
            let msg = error_msg(&error);
            unsafe { error_free(&mut error) };
            set_error(out_err, &msg);
        } else {
            unsafe { error_free(&mut error) };
        }
        return -1;
    }
    0
}

// ============================================================================
// BOX HANDLE OPERATIONS
// ============================================================================

/// Start a box. Returns 0 on success, -1 on failure.
///
/// # Safety
/// `handle` must be a valid pointer to a BoxHandle, or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_box_start(
    handle: *mut BoxHandle,
    out_err: *mut *mut c_char,
) -> c_int {
    let mut error = FFIError::default();

    let code = unsafe { box_start(handle, &mut error) };

    if code != BoxliteErrorCode::Ok {
        if !out_err.is_null() {
            let msg = error_msg(&error);
            unsafe { error_free(&mut error) };
            set_error(out_err, &msg);
        } else {
            unsafe { error_free(&mut error) };
        }
        return -1;
    }
    0
}

/// Stop a box. Returns 0 on success, -1 on failure.
///
/// # Safety
/// `handle` must be a valid pointer to a BoxHandle, or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_box_stop(
    handle: *mut BoxHandle,
    out_err: *mut *mut c_char,
) -> c_int {
    let mut error = FFIError::default();

    let code = unsafe { box_stop(handle, &mut error) };

    if code != BoxliteErrorCode::Ok {
        if !out_err.is_null() {
            let msg = error_msg(&error);
            unsafe { error_free(&mut error) };
            set_error(out_err, &msg);
        } else {
            unsafe { error_free(&mut error) };
        }
        return -1;
    }
    0
}

/// Get box info as JSON. Returns 0 on success, -1 on failure.
///
/// # Safety
/// `handle` and `out_json` must be valid pointers, `out_err` may be null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_box_info(
    handle: *mut BoxHandle,
    out_json: *mut *mut c_char,
    out_err: *mut *mut c_char,
) -> c_int {
    let mut error = FFIError::default();

    let code = unsafe { box_inspect_handle(handle, out_json, &mut error) };

    if code != BoxliteErrorCode::Ok {
        if !out_err.is_null() {
            let msg = error_msg(&error);
            unsafe { error_free(&mut error) };
            set_error(out_err, &msg);
        } else {
            unsafe { error_free(&mut error) };
        }
        return -1;
    }
    0
}

/// Get the ID of a box handle. Returns a string (caller must free), or NULL.
///
/// # Safety
/// `handle` must be a valid pointer to a BoxHandle, or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_box_id(handle: *mut BoxHandle) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    unsafe { box_id(handle) }
}

/// Free a box handle.
///
/// # Safety
/// `handle` must be a valid pointer to a BoxHandle, or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_box_free(handle: *mut BoxHandle) {
    if !handle.is_null() {
        unsafe { box_free(handle) };
    }
}
