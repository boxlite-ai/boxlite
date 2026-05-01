//! Box handle operations for the BoxLite C SDK.

use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxID;
use boxlite::BoxliteError;
use boxlite::litebox::LiteBox;

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::options::OptionsHandle;
use crate::runtime::RuntimeHandle;
use crate::util::c_str_to_string;
use crate::{CBoxHandle, CBoxliteError, CBoxliteOptions, CBoxliteRuntime};

/// Opaque handle to a running box.
pub struct BoxHandle {
    pub handle: LiteBox,
    #[allow(dead_code)]
    pub box_id: BoxID,
    pub tokio_rt: Arc<TokioRuntime>,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_create_box(
    runtime: *mut CBoxliteRuntime,
    opts: *mut CBoxliteOptions,
    out_box: *mut *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    create_box(runtime, opts, out_box, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_stop_box(
    handle: *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    stop_box(handle, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    out_handle: *mut *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    attach_box(runtime, id_or_name, out_handle, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_remove(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    force: c_int,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    remove_box(runtime, id_or_name, force != 0, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_start_box(
    handle: *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    start_box(handle, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_id(handle: *mut CBoxHandle) -> *mut c_char {
    box_id(handle)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_free(handle: *mut CBoxHandle) {
    box_free(handle)
}

unsafe fn create_box(
    runtime: *mut RuntimeHandle,
    opts: *mut OptionsHandle,
    out_box: *mut *mut BoxHandle,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if opts.is_null() {
            write_error(out_error, null_pointer_error("opts"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_box.is_null() {
            write_error(out_error, null_pointer_error("out_box"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &mut *runtime;
        let opts_handle = Box::from_raw(opts);
        let result = runtime_ref.tokio_rt.block_on(
            runtime_ref
                .runtime
                .create(opts_handle.options, opts_handle.name),
        );

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

unsafe fn stop_box(handle: *mut BoxHandle, out_error: *mut FFIError) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;

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

unsafe fn attach_box(
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

unsafe fn remove_box(
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

unsafe fn start_box(handle: *mut BoxHandle, out_error: *mut FFIError) -> BoxliteErrorCode {
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

unsafe fn box_id(handle: *mut BoxHandle) -> *mut c_char {
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

unsafe fn box_free(handle: *mut BoxHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}
