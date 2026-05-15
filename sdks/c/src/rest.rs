//! REST runtime construction for the BoxLite C FFI.
//!
//! Connects to a remote BoxLite server instead of the local in-process
//! runtime. The returned handle is the *same* opaque `CBoxliteRuntime`
//! as [`crate::runtime::boxlite_runtime_new`], so every existing box,
//! exec, copy, image, and metrics operation works against it unchanged
//! — REST is just an alternative way to construct the runtime. Free it
//! with `boxlite_runtime_free` like any other runtime handle.

use std::os::raw::c_char;
use std::sync::Arc;

use boxlite::BoxliteError;
use boxlite::BoxliteRestOptions;
use boxlite::runtime::BoxliteRuntime;

use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::event_queue::EventQueue;
use crate::runtime::{RuntimeHandle, RuntimeLiveness, create_tokio_runtime};
use crate::util::c_str_to_string;
use crate::{CBoxliteError, CBoxliteRuntime};

/// Create a runtime that connects to a remote BoxLite REST server.
///
/// # Arguments
/// - `url`: REST API base URL (required, e.g. `https://api.example.com`).
/// - `api_key`: opaque API key sent as `Authorization: Bearer`. Pass
///   `NULL` for an unauthenticated runtime.
/// - `prefix`: API path prefix. Pass `NULL` for the server default
///   (`v1`).
/// - `out_runtime`: receives the runtime handle on success.
/// - `out_error`: receives error code + message on failure (nullable).
///
/// Returns `BoxliteErrorCode::Ok` on success. The handle is freed with
/// `boxlite_runtime_free`.
///
/// # Safety
/// All pointer arguments must be valid or `NULL` as documented;
/// `out_runtime` must be non-NULL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_rest_runtime_new(
    url: *const c_char,
    api_key: *const c_char,
    prefix: *const c_char,
    out_runtime: *mut *mut CBoxliteRuntime,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if out_runtime.is_null() {
            write_error(out_error, null_pointer_error("out_runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let url = match c_str_to_string(url) {
            Ok(u) => u,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let tokio_rt = match create_tokio_runtime() {
            Ok(rt) => rt,
            Err(e) => {
                write_error(out_error, BoxliteError::Internal(e));
                return BoxliteErrorCode::Internal;
            }
        };

        let mut options = BoxliteRestOptions::new(url);
        if !api_key.is_null() {
            match c_str_to_string(api_key) {
                Ok(key) => options = options.with_api_key(key),
                Err(e) => {
                    write_error(out_error, e);
                    return BoxliteErrorCode::InvalidArgument;
                }
            }
        }
        if !prefix.is_null() {
            match c_str_to_string(prefix) {
                Ok(p) => options = options.with_prefix(p),
                Err(e) => {
                    write_error(out_error, e);
                    return BoxliteErrorCode::InvalidArgument;
                }
            }
        }

        let runtime = match BoxliteRuntime::rest(options) {
            Ok(rt) => rt,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                return code;
            }
        };

        *out_runtime = Box::into_raw(Box::new(RuntimeHandle {
            runtime,
            tokio_rt,
            liveness: Arc::new(RuntimeLiveness::new()),
            queue: Arc::new(EventQueue::new()),
        }));
        BoxliteErrorCode::Ok
    }
}
