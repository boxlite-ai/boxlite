//! Box clone + export + runtime import operations for the BoxLite C SDK.
//!
//! `boxlite_box_clone_box` returns a fresh `CBoxHandle` (the cloned box).
//! `boxlite_box_export` writes a `.boxlite` archive to dest and returns
//! unit + error (the caller already knows the dest path).
//! `boxlite_runtime_import_box` reads a `.boxlite` archive from src and
//! returns a fresh `CBoxHandle` (the imported box).

use std::os::raw::{c_char, c_void};
use std::path::PathBuf;

use boxlite::runtime::options::{BoxArchive, CloneOptions, ExportOptions};

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxCloneCb, CBoxCreateBoxCb, CBoxExportCb, OwnedFfiPtr, RuntimeEvent, push_event,
};
use crate::runtime::RuntimeHandle;
use crate::{CBoxHandle, CBoxliteError, CBoxliteRuntime};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_clone_box(
    handle: *mut CBoxHandle,
    name: *const c_char,
    cb: CBoxCloneCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_clone(handle, name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_export(
    handle: *mut CBoxHandle,
    dest: *const c_char,
    cb: CBoxExportCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_export(handle, dest, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_import_box(
    runtime: *mut CBoxliteRuntime,
    archive_path: *const c_char,
    name: *const c_char,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    runtime_import_box(runtime, archive_path, name, cb, user_data, out_error)
}

unsafe fn box_clone(
    handle: *mut BoxHandle,
    name: *const c_char,
    cb: CBoxCloneCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        // name may be null (caller wants an unnamed clone).
        let name = if name.is_null() {
            None
        } else {
            match crate::util::c_str_to_string(name) {
                Ok(s) => Some(s),
                Err(e) => {
                    write_error(out_error, e);
                    return BoxliteErrorCode::InvalidArgument;
                }
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let tokio_rt = handle_ref.tokio_rt.clone();
        let user_data_addr = user_data as usize;

        let task_queue = queue.clone();
        let task_tokio_rt = tokio_rt.clone();
        tokio_rt.spawn(async move {
            let result = lite
                .clone_box(CloneOptions::default(), name)
                .await
                .map(|cloned| {
                    let box_id = cloned.id().clone();
                    let boxed = Box::new(BoxHandle {
                        handle: std::sync::Arc::new(cloned),
                        box_id,
                        tokio_rt: task_tokio_rt,
                        queue: task_queue.clone(),
                    });
                    OwnedFfiPtr::new(boxed)
                });
            push_event(
                &queue,
                RuntimeEvent::CloneBox {
                    cb,
                    user_data: user_data_addr,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

unsafe fn box_export(
    handle: *mut BoxHandle,
    dest: *const c_char,
    cb: CBoxExportCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let dest = match crate::util::c_str_to_string(dest) {
            Ok(s) => PathBuf::from(s),
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite
                .export(ExportOptions::default(), dest.as_path())
                .await
                .map(|_archive| ());
            push_event(
                &queue,
                RuntimeEvent::ExportBox {
                    cb,
                    user_data: user_data_addr,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

unsafe fn runtime_import_box(
    runtime: *mut RuntimeHandle,
    archive_path: *const c_char,
    name: *const c_char,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let archive_path = match crate::util::c_str_to_string(archive_path) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let name = if name.is_null() {
            None
        } else {
            match crate::util::c_str_to_string(name) {
                Ok(s) => Some(s),
                Err(e) => {
                    write_error(out_error, e);
                    return BoxliteErrorCode::InvalidArgument;
                }
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime_ref = &*runtime;
        let runtime_clone = runtime_ref.runtime.clone();
        let queue = runtime_ref.queue.clone();
        let tokio_rt = runtime_ref.tokio_rt.clone();
        let user_data_addr = user_data as usize;
        let task_tokio_rt = tokio_rt.clone();
        let task_queue = queue.clone();

        tokio_rt.spawn(async move {
            let archive = BoxArchive::new(archive_path);
            let result = runtime_clone
                .import_box(archive, name)
                .await
                .map(|imported| {
                    let box_id = imported.id().clone();
                    let boxed = Box::new(BoxHandle {
                        handle: std::sync::Arc::new(imported),
                        box_id,
                        tokio_rt: task_tokio_rt,
                        queue: task_queue.clone(),
                    });
                    OwnedFfiPtr::new(boxed)
                });
            push_event(
                &queue,
                RuntimeEvent::CreateBox {
                    cb,
                    user_data: user_data_addr,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

// Suppress unused-import warning until BoxArchive::default is wired through
// `ExportOptions` for the runtime side; the type is exercised by the
// import path above and the trait import paths below.
const _: () = {
    let _ = std::mem::size_of::<BoxArchive>();
};
