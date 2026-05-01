//! Runtime management for BoxLite FFI
//!
//! Provides Tokio runtime and BoxliteRuntime handle management.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::runtime::BoxliteRuntime;

/// Opaque handle to a BoxliteRuntime instance with associated Tokio runtime
pub struct RuntimeHandle {
    pub runtime: BoxliteRuntime,
    pub tokio_rt: Arc<TokioRuntime>,
    pub liveness: Arc<RuntimeLiveness>,
}

/// Shared runtime liveness for FFI-owned handles.
///
/// Image handles use this to honor the runtime shutdown/free boundary even
/// though they retain their own core handle internally.
pub struct RuntimeLiveness {
    alive: AtomicBool,
}

impl RuntimeLiveness {
    pub fn new() -> Self {
        Self {
            alive: AtomicBool::new(true),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn mark_closed(&self) {
        self.alive.store(false, Ordering::Release);
    }
}

impl Default for RuntimeLiveness {
    fn default() -> Self {
        Self::new()
    }
}

/// Create a new Tokio runtime
pub fn create_tokio_runtime() -> Result<Arc<TokioRuntime>, String> {
    TokioRuntime::new()
        .map(Arc::new)
        .map_err(|e| format!("Failed to create async runtime: {}", e))
}

use std::os::raw::{c_char, c_int};

use boxlite::BoxliteError;
use boxlite::runtime::options::BoxliteOptions;

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::images::ImageHandle;
use crate::util::c_str_to_string;
use crate::{CBoxliteError, CBoxliteImageHandle, CBoxliteRuntime};

#[unsafe(no_mangle)]
pub extern "C" fn boxlite_version() -> *const c_char {
    version()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_new(
    home_dir: *const c_char,
    registries: *const *const c_char,
    registries_count: c_int,
    out_runtime: *mut *mut CBoxliteRuntime,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    runtime_new(
        home_dir,
        registries,
        registries_count,
        out_runtime,
        out_error,
    )
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_images(
    runtime: *mut CBoxliteRuntime,
    out_handle: *mut *mut CBoxliteImageHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    runtime_images(runtime, out_handle, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_shutdown(
    runtime: *mut CBoxliteRuntime,
    timeout: c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let timeout_opt = if timeout == 0 { None } else { Some(timeout) };
    shutdown_runtime(runtime, timeout_opt, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_free(runtime: *mut CBoxliteRuntime) {
    runtime_free(runtime)
}

unsafe fn runtime_new(
    home_dir: *const c_char,
    registries: *const *const c_char,
    registries_count: c_int,
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

        options.image_registries = crate::util::parse_c_string_array(registries, registries_count);

        // Create runtime
        let runtime = match BoxliteRuntime::new(options) {
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
            liveness: std::sync::Arc::new(RuntimeLiveness::new()),
        }));
        BoxliteErrorCode::Ok
    }
}

unsafe fn runtime_images(
    runtime: *mut RuntimeHandle,
    out_handle: *mut *mut ImageHandle,
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
        if let Err(e) = crate::util::ensure_runtime_live(&runtime_ref.liveness, "access images") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }

        match runtime_ref.runtime.images() {
            Ok(handle) => {
                *out_handle = Box::into_raw(Box::new(ImageHandle {
                    handle,
                    tokio_rt: runtime_ref.tokio_rt.clone(),
                    liveness: runtime_ref.liveness.clone(),
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

unsafe fn shutdown_runtime(
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
        runtime_ref.liveness.mark_closed();

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

unsafe fn runtime_free(runtime: *mut RuntimeHandle) {
    if !runtime.is_null() {
        unsafe {
            (*runtime).liveness.mark_closed();
            drop(Box::from_raw(runtime));
        }
    }
}

pub extern "C" fn version() -> *const c_char {
    // Static string, safe to return pointer
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr() as *const c_char
}
