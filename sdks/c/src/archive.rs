//! Box archive export/import operations for the BoxLite C SDK.

use std::os::raw::c_char;
use std::path::PathBuf;
use std::sync::Arc;

use boxlite::BoxliteError;
use boxlite::runtime::options::{BoxArchive, ExportOptions};

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::runtime::RuntimeHandle;
use crate::util::{alloc_c_string, c_str_to_string};
use crate::{CBoxHandle, CBoxliteError, CBoxliteRuntime};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_export(
    handle: *mut CBoxHandle,
    dest_path: *const c_char,
    out_path: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_export(handle, dest_path, out_path, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_import_box(
    runtime: *mut CBoxliteRuntime,
    archive_path: *const c_char,
    name: *const c_char,
    out_handle: *mut *mut CBoxHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    runtime_import_box(runtime, archive_path, name, out_handle, out_error)
}

unsafe fn box_export(
    handle: *mut BoxHandle,
    dest_path: *const c_char,
    out_path: *mut *mut c_char,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_path.is_null() {
            write_error(out_error, null_pointer_error("out_path"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let dest = match c_str_to_string(dest_path) {
            Ok(s) => PathBuf::from(s),
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        match handle_ref
            .tokio_rt
            .block_on(lite.export(ExportOptions::default(), &dest))
        {
            Ok(archive) => {
                let path = archive.path().to_string_lossy().into_owned();
                let c_path = alloc_c_string(&path);
                if c_path.is_null() {
                    write_error(
                        out_error,
                        BoxliteError::Internal("archive path contains interior NUL".into()),
                    );
                    return BoxliteErrorCode::Internal;
                }
                *out_path = c_path;
                BoxliteErrorCode::Ok
            }
            Err(e) => {
                write_error(out_error, e);
                BoxliteErrorCode::Internal
            }
        }
    }
}

unsafe fn runtime_import_box(
    runtime: *mut RuntimeHandle,
    archive_path: *const c_char,
    name: *const c_char,
    out_handle: *mut *mut CBoxHandle,
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
        let archive_path = match c_str_to_string(archive_path) {
            Ok(s) => PathBuf::from(s),
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let name = if name.is_null() {
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

        let runtime_ref = &*runtime;
        let runtime_clone = runtime_ref.runtime.clone();
        let tokio_rt = runtime_ref.tokio_rt.clone();
        let task_tokio_rt = tokio_rt.clone();

        match tokio_rt.block_on(runtime_clone.import_box(BoxArchive::new(archive_path), name)) {
            Ok(handle) => {
                let box_id = handle.id().clone();
                let boxed = Box::new(BoxHandle {
                    handle: Arc::new(handle),
                    box_id,
                    tokio_rt: task_tokio_rt,
                    queue: runtime_ref.queue.clone(),
                });
                *out_handle = Box::into_raw(boxed);
                BoxliteErrorCode::Ok
            }
            Err(e) => {
                write_error(out_error, e);
                BoxliteErrorCode::Internal
            }
        }
    }
}
