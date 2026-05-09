//! Box handle operations for the BoxLite C SDK.
//!
//! All async lifecycle operations follow the post-and-drain pattern: each C
//! function spawns a Tokio task that performs the underlying async Rust call
//! and pushes a typed `RuntimeEvent` to the runtime's queue. Callbacks fire
//! later from `boxlite_runtime_drain` on the user's thread.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxID;
use boxlite::BoxliteError;
use boxlite::litebox::LiteBox;

use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxCreateBoxCb, CBoxGetBoxCb, CBoxRemoveBoxCb, CBoxStartBoxCb, CBoxStopBoxCb, EventQueue,
    RuntimeEvent, push_event,
};
use crate::options::OptionsHandle;
use crate::runtime::RuntimeHandle;
use crate::util::c_str_to_string;
use crate::{CBoxHandle, CBoxliteError, CBoxliteOptions, CBoxliteRuntime};

/// Opaque handle to a running box.
///
/// `handle` is wrapped in `Arc` so it can be cloned into Tokio tasks for
/// async lifecycle ops.
pub struct BoxHandle {
    pub handle: Arc<LiteBox>,
    #[allow(dead_code)]
    pub box_id: BoxID,
    pub tokio_rt: Arc<TokioRuntime>,
    pub queue: Arc<EventQueue>,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_create_box(
    runtime: *mut CBoxliteRuntime,
    opts: *mut CBoxliteOptions,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    create_box(runtime, opts, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_stop_box(
    handle: *mut CBoxHandle,
    cb: CBoxStopBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    stop_box(handle, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    cb: CBoxGetBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    attach_box(runtime, id_or_name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_remove(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    force: c_int,
    cb: CBoxRemoveBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    remove_box(runtime, id_or_name, force != 0, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_start_box(
    handle: *mut CBoxHandle,
    cb: CBoxStartBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    start_box(handle, cb, user_data, out_error)
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
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
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
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime_ref = &*runtime;
        let opts_handle = Box::from_raw(opts);
        let runtime_clone = runtime_ref.runtime.clone();
        let tokio_rt = runtime_ref.tokio_rt.clone();
        let queue = runtime_ref.queue.clone();
        let user_data_addr = user_data as usize;
        let task_tokio_rt = tokio_rt.clone();
        let task_queue = queue.clone();

        tokio_rt.spawn(async move {
            let result = runtime_clone
                .create(opts_handle.options, opts_handle.name)
                .await
                .map(|handle| {
                    let box_id = handle.id().clone();
                    let boxed = Box::new(BoxHandle {
                        handle: Arc::new(handle),
                        box_id,
                        tokio_rt: task_tokio_rt,
                        queue: task_queue.clone(),
                    });
                    crate::event_queue::OwnedFfiPtr::new(boxed)
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

unsafe fn stop_box(
    handle: *mut BoxHandle,
    cb: CBoxStopBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.stop().await;
            push_event(
                &queue,
                RuntimeEvent::StopBox {
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

unsafe fn attach_box(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    cb: CBoxGetBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let id_str = match c_str_to_string(id_or_name) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime_ref = &*runtime;
        let runtime_clone = runtime_ref.runtime.clone();
        let tokio_rt = runtime_ref.tokio_rt.clone();
        let queue = runtime_ref.queue.clone();
        let user_data_addr = user_data as usize;
        let task_tokio_rt = tokio_rt.clone();
        let task_queue = queue.clone();

        tokio_rt.spawn(async move {
            let result = match runtime_clone.get(&id_str).await {
                Ok(Some(handle)) => {
                    let box_id = handle.id().clone();
                    let boxed = Box::new(BoxHandle {
                        handle: Arc::new(handle),
                        box_id,
                        tokio_rt: task_tokio_rt,
                        queue: task_queue.clone(),
                    });
                    Ok(crate::event_queue::OwnedFfiPtr::new(boxed))
                }
                Ok(None) => Err(BoxliteError::NotFound(format!("Box not found: {id_str}"))),
                Err(e) => Err(e),
            };
            push_event(
                &queue,
                RuntimeEvent::GetBox {
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

unsafe fn remove_box(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    force: bool,
    cb: CBoxRemoveBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let id_str = match c_str_to_string(id_or_name) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime_ref = &*runtime;
        let runtime_clone = runtime_ref.runtime.clone();
        let queue = runtime_ref.queue.clone();
        let user_data_addr = user_data as usize;

        runtime_ref.tokio_rt.spawn(async move {
            let result = runtime_clone.remove(&id_str, force).await.map(|_| ());
            push_event(
                &queue,
                RuntimeEvent::RemoveBox {
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

unsafe fn start_box(
    handle: *mut BoxHandle,
    cb: CBoxStartBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.start().await;
            push_event(
                &queue,
                RuntimeEvent::StartBox {
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
