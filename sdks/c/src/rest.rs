//! REST runtime construction for the BoxLite C FFI.
//!
//! Connects to a remote BoxLite server instead of the local in-process
//! runtime. Construction goes through an opaque credential + options
//! pair that mirrors the other SDKs (`ApiKeyCredential` +
//! `BoxliteRestOptions`):
//!
//! ```c
//! CBoxliteCredential *cred = NULL;
//! boxlite_api_key_credential_new("blk_live_...", &cred, &err);
//!
//! CBoxliteRestOptions *opts = NULL;
//! boxlite_rest_options_new("https://api.example.com", &opts, &err);
//! boxlite_rest_options_set_credential(opts, cred);
//! boxlite_rest_options_set_prefix(opts, "v1");
//!
//! CBoxliteRuntime *rt = NULL;
//! boxlite_rest_runtime_new_with_options(opts, &rt, &err);
//!
//! boxlite_rest_options_free(opts);
//! boxlite_credential_free(cred);
//! // ... use rt ...
//! boxlite_runtime_free(rt);
//! ```
//!
//! The returned handle is the *same* opaque `CBoxliteRuntime` as
//! [`crate::runtime::boxlite_runtime_new`], so every box, exec, copy,
//! image, and metrics operation works against it unchanged. Free it
//! with `boxlite_runtime_free` like any other runtime handle.

use std::os::raw::c_char;
use std::sync::Arc;

use boxlite::BoxliteError;
use boxlite::BoxliteRestOptions;
use boxlite::runtime::BoxliteRuntime;
use boxlite::{ApiKeyCredential, Credential};

use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::event_queue::EventQueue;
use crate::runtime::{RuntimeHandle, RuntimeLiveness, create_tokio_runtime};
use crate::util::c_str_to_string;
use crate::{CBoxliteCredential, CBoxliteError, CBoxliteRestOptions, CBoxliteRuntime};

/// Opaque credential handle. Wraps a core `Arc<dyn Credential>` so the
/// concrete credential kind (today only `ApiKeyCredential`) is hidden
/// behind one C type, matching the trait/interface surface in the other
/// SDKs.
pub struct CredentialHandle {
    inner: Arc<dyn Credential>,
}

/// Opaque REST options handle. Owns a core [`BoxliteRestOptions`] that
/// the setters mutate in place before construction.
pub struct RestOptionsHandle {
    opts: BoxliteRestOptions,
}

/// Create an API-key credential.
///
/// # Arguments
/// - `key`: opaque API key sent as `Authorization: Bearer` (required).
/// - `out_credential`: receives the credential handle on success.
/// - `out_error`: receives error code + message on failure (nullable).
///
/// Returns `BoxliteErrorCode::Ok` on success. Free the handle with
/// `boxlite_credential_free`.
///
/// # Safety
/// `out_credential` must be non-NULL; `key` must be a valid C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_api_key_credential_new(
    key: *const c_char,
    out_credential: *mut *mut CBoxliteCredential,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if out_credential.is_null() {
            write_error(out_error, null_pointer_error("out_credential"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let key = match c_str_to_string(key) {
            Ok(k) => k,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let handle = CredentialHandle {
            inner: Arc::new(ApiKeyCredential::new(key)),
        };
        *out_credential = Box::into_raw(Box::new(handle));
        BoxliteErrorCode::Ok
    }
}

/// Free a credential handle. No-op on NULL.
///
/// # Safety
/// `credential` must be a handle from `boxlite_api_key_credential_new`
/// or NULL, and must not be used after this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_credential_free(credential: *mut CBoxliteCredential) {
    if !credential.is_null() {
        unsafe {
            drop(Box::from_raw(credential));
        }
    }
}

/// Create REST options for `url` (no credential, server-default prefix).
///
/// # Arguments
/// - `url`: REST API base URL (required, e.g. `https://api.example.com`).
/// - `out_options`: receives the options handle on success.
/// - `out_error`: receives error code + message on failure (nullable).
///
/// Returns `BoxliteErrorCode::Ok` on success. Free the handle with
/// `boxlite_rest_options_free`.
///
/// # Safety
/// `out_options` must be non-NULL; `url` must be a valid C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_rest_options_new(
    url: *const c_char,
    out_options: *mut *mut CBoxliteRestOptions,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if out_options.is_null() {
            write_error(out_error, null_pointer_error("out_options"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let url = match c_str_to_string(url) {
            Ok(u) => u,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let handle = RestOptionsHandle {
            opts: BoxliteRestOptions::new(url),
        };
        *out_options = Box::into_raw(Box::new(handle));
        BoxliteErrorCode::Ok
    }
}

/// Attach a credential to the options. The credential's inner reference
/// is cloned into the options, so the caller still owns `credential`
/// and must free it independently with `boxlite_credential_free`.
/// No-op if either pointer is NULL.
///
/// # Safety
/// `options` and `credential` must be valid handles or NULL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_rest_options_set_credential(
    options: *mut CBoxliteRestOptions,
    credential: *const CBoxliteCredential,
) {
    unsafe {
        if options.is_null() || credential.is_null() {
            return;
        }
        (*options).opts.credential = Some((*credential).inner.clone());
    }
}

/// Override the API path prefix (server default: `v1`). No-op if
/// `options` is NULL or `prefix` is not a valid C string.
///
/// # Safety
/// `options` must be a valid handle or NULL; `prefix` a valid C string
/// or NULL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_rest_options_set_prefix(
    options: *mut CBoxliteRestOptions,
    prefix: *const c_char,
) {
    unsafe {
        if options.is_null() || prefix.is_null() {
            return;
        }
        if let Ok(p) = c_str_to_string(prefix) {
            (*options).opts.prefix = Some(p);
        }
    }
}

/// Free a REST options handle. No-op on NULL.
///
/// # Safety
/// `options` must be a handle from `boxlite_rest_options_new` or NULL,
/// and must not be used after this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_rest_options_free(options: *mut CBoxliteRestOptions) {
    if !options.is_null() {
        unsafe {
            drop(Box::from_raw(options));
        }
    }
}

/// Create a runtime that connects to a remote BoxLite REST server using
/// the supplied options.
///
/// # Arguments
/// - `options`: a handle from `boxlite_rest_options_new` (required).
/// - `out_runtime`: receives the runtime handle on success.
/// - `out_error`: receives error code + message on failure (nullable).
///
/// Returns `BoxliteErrorCode::Ok` on success. The runtime handle is
/// freed with `boxlite_runtime_free`. `options` is unchanged and must
/// still be freed by the caller with `boxlite_rest_options_free`.
///
/// # Safety
/// `options` and `out_runtime` must be non-NULL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_rest_runtime_new_with_options(
    options: *const CBoxliteRestOptions,
    out_runtime: *mut *mut CBoxliteRuntime,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if out_runtime.is_null() {
            write_error(out_error, null_pointer_error("out_runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if options.is_null() {
            write_error(out_error, null_pointer_error("options"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let opts = (*options).opts.clone();

        let tokio_rt = match create_tokio_runtime() {
            Ok(rt) => rt,
            Err(e) => {
                write_error(out_error, BoxliteError::Internal(e));
                return BoxliteErrorCode::Internal;
            }
        };

        let runtime = match BoxliteRuntime::rest(opts) {
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
