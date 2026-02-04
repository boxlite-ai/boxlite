// BoxLite Go SDK - Rust Bridge Layer
//
// This library serves as the underlying core for the Go SDK.
// It maintains a global Tokio Runtime on the Rust side and exposes C ABI to Go (CGO).

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;
use std::sync::OnceLock;
use tokio::runtime::Runtime;

use boxlite::{BoxOptions, BoxliteRuntime, LiteBox};

// Global Tokio Runtime
static RUNTIME: OnceLock<Runtime> = OnceLock::new();

/// Gets a reference to the global Runtime.
fn get_runtime() -> &'static Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to create BoxLite Tokio runtime")
    })
}

/// Internal helper: blocks on a future using the global Runtime.
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    get_runtime().block_on(future)
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Allocates a C string from a Rust string. Caller must free with boxlite_go_free_string.
fn alloc_c_string(s: &str) -> *mut c_char {
    match CString::new(s) {
        Ok(cs) => cs.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

/// Sets the error output parameter and returns error code.
fn set_error(out_err: *mut *mut c_char, msg: &str) -> i32 {
    if !out_err.is_null() {
        unsafe {
            *out_err = alloc_c_string(msg);
        }
    }
    -1
}

/// Parses a C string to Rust &str.
fn parse_c_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(ptr).to_str().ok() }
}

// ============================================================================
// BOX HANDLE (Opaque pointer for Go)
// ============================================================================

/// Opaque handle to a LiteBox, held by Go.
pub struct BoxHandle {
    inner: LiteBox,
}

// ============================================================================
// FFI EXPORTED FUNCTIONS (C ABI)
// ============================================================================

/// Simple ping function to verify the Go-Rust bridge is working.
/// Returns 42 on success.
#[no_mangle]
pub extern "C" fn boxlite_go_ping() -> i32 {
    42
}

/// Free a C string allocated by Rust.
///
/// # Safety
///
/// The provided pointer must be null or a valid pointer to a C string allocated by
/// `alloc_c_string` (via `CString::into_raw`). This function takes ownership of
/// the string and frees its memory.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_free_string(s: *mut c_char) {
    if !s.is_null() {
        // SAFETY: The caller must ensure 's' was allocated by CString::into_raw.
        drop(CString::from_raw(s));
    }
}

/// Create a new box with the given options (JSON).
/// Returns box ID (caller must free) on success, NULL on failure.
/// out_err receives error message on failure (caller must free).
///
/// # Safety
///
/// * `opts_json` must be a null-terminated C string representing valid JSON.
/// * `name` must be null or a null-terminated C string.
/// * `out_err` must be a valid pointer to a `*mut c_char` or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_create_box(
    opts_json: *const c_char,
    name: *const c_char,
    out_err: *mut *mut c_char,
) -> *mut c_char {
    // Parse options JSON
    let opts_str = match parse_c_str(opts_json) {
        Some(s) => s,
        None => {
            set_error(out_err, "Invalid options JSON pointer");
            return ptr::null_mut();
        }
    };

    let opts: BoxOptions = match serde_json::from_str(opts_str) {
        Ok(o) => o,
        Err(e) => {
            set_error(out_err, &format!("Failed to parse options: {}", e));
            return ptr::null_mut();
        }
    };

    // Parse optional name
    let name_opt = parse_c_str(name).map(|s| s.to_string());

    // Get default runtime and create box
    let runtime = BoxliteRuntime::default_runtime();
    let result = block_on(runtime.create(opts, name_opt));

    match result {
        Ok(lite_box) => {
            let id = lite_box.id().to_string();
            alloc_c_string(&id)
        }
        Err(e) => {
            set_error(out_err, &e.to_string());
            ptr::null_mut()
        }
    }
}

/// Get a box handle by ID or name.
/// Returns BoxHandle pointer on success, NULL if not found or on error.
/// out_err receives error message on failure (caller must free).
///
/// # Safety
///
/// * `id_or_name` must be a null-terminated C string.
/// * `out_err` must be a valid pointer to a `*mut c_char` or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_get_box(
    id_or_name: *const c_char,
    out_err: *mut *mut c_char,
) -> *mut BoxHandle {
    let id_str = match parse_c_str(id_or_name) {
        Some(s) => s,
        None => {
            set_error(out_err, "Invalid id_or_name pointer");
            return ptr::null_mut();
        }
    };

    let runtime = BoxliteRuntime::default_runtime();
    let result = block_on(runtime.get(id_str));

    match result {
        Ok(Some(lite_box)) => Box::into_raw(Box::new(BoxHandle { inner: lite_box })),
        Ok(None) => ptr::null_mut(), // Not found, not an error
        Err(e) => {
            set_error(out_err, &e.to_string());
            ptr::null_mut()
        }
    }
}

/// List all boxes as JSON array.
/// out_json receives the JSON string (caller must free).
/// Returns 0 on success, -1 on error.
///
/// # Safety
///
/// * `out_json` must be a valid pointer to a `*mut c_char`.
/// * `out_err` must be a valid pointer to a `*mut c_char` or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_list_boxes(
    out_json: *mut *mut c_char,
    out_err: *mut *mut c_char,
) -> i32 {
    if out_json.is_null() {
        return set_error(out_err, "out_json is null");
    }

    let runtime = BoxliteRuntime::default_runtime();
    let result = block_on(runtime.list_info());

    match result {
        Ok(infos) => {
            let json = match serde_json::to_string(&infos) {
                Ok(j) => j,
                Err(e) => {
                    return set_error(out_err, &format!("Failed to serialize: {}", e));
                }
            };
            *out_json = alloc_c_string(&json);
            0
        }
        Err(e) => set_error(out_err, &e.to_string()),
    }
}

/// Remove a box by ID or name.
/// Returns 0 on success, -1 on error.
///
/// # Safety
///
/// * `id_or_name` must be a null-terminated C string.
/// * `out_err` must be a valid pointer to a `*mut c_char` or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_remove_box(
    id_or_name: *const c_char,
    force: bool,
    out_err: *mut *mut c_char,
) -> i32 {
    let id_str = match parse_c_str(id_or_name) {
        Some(s) => s,
        None => {
            return set_error(out_err, "Invalid id_or_name pointer");
        }
    };

    let runtime = BoxliteRuntime::default_runtime();
    let result = block_on(runtime.remove(id_str, force));

    match result {
        Ok(_) => 0,
        Err(e) => set_error(out_err, &e.to_string()),
    }
}

// ============================================================================
// BOX OPERATIONS
// ============================================================================

/// Start a box.
/// Returns 0 on success, -1 on error.
///
/// # Safety
///
/// * `handle` must be a valid pointer to a `BoxHandle`.
/// * `out_err` must be a valid pointer to a `*mut c_char` or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_box_start(
    handle: *mut BoxHandle,
    out_err: *mut *mut c_char,
) -> i32 {
    if handle.is_null() {
        return set_error(out_err, "handle is null");
    }

    let handle = &*handle;
    let result = block_on(handle.inner.start());

    match result {
        Ok(_) => 0,
        Err(e) => set_error(out_err, &e.to_string()),
    }
}

/// Stop a box.
/// Returns 0 on success, -1 on error.
///
/// # Safety
///
/// * `handle` must be a valid pointer to a `BoxHandle`.
/// * `out_err` must be a valid pointer to a `*mut c_char` or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_box_stop(
    handle: *mut BoxHandle,
    out_err: *mut *mut c_char,
) -> i32 {
    if handle.is_null() {
        return set_error(out_err, "handle is null");
    }

    let handle = &*handle;
    let result = block_on(handle.inner.stop());

    match result {
        Ok(_) => 0,
        Err(e) => set_error(out_err, &e.to_string()),
    }
}

/// Get box info as JSON.
/// out_json receives the JSON string (caller must free).
/// Returns 0 on success, -1 on error.
///
/// # Safety
///
/// * `handle` must be a valid pointer to a `BoxHandle`.
/// * `out_json` must be a valid pointer to a `*mut c_char`.
/// * `out_err` must be a valid pointer to a `*mut c_char` or null.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_box_info(
    handle: *mut BoxHandle,
    out_json: *mut *mut c_char,
    out_err: *mut *mut c_char,
) -> i32 {
    if handle.is_null() {
        return set_error(out_err, "handle is null");
    }
    if out_json.is_null() {
        return set_error(out_err, "out_json is null");
    }

    let handle = &*handle;
    let info = handle.inner.info();

    let json = match serde_json::to_string(&info) {
        Ok(j) => j,
        Err(e) => {
            return set_error(out_err, &format!("Failed to serialize: {}", e));
        }
    };
    *out_json = alloc_c_string(&json);
    0
}

/// Get box ID as string (caller must free).
///
/// # Safety
///
/// * `handle` must be a valid pointer to a `BoxHandle`.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_box_id(handle: *mut BoxHandle) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    let handle = &*handle;
    alloc_c_string(handle.inner.id().as_ref())
}

/// Free a box handle.
///
/// # Safety
///
/// * `handle` must be a valid pointer to a `BoxHandle` allocated by `boxlite_go_get_box`
///   (via `Box::into_raw`). This function takes ownership and frees the memory.
#[no_mangle]
pub unsafe extern "C" fn boxlite_go_box_free(handle: *mut BoxHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}
