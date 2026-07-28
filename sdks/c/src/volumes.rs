//! Named-volume operations for the BoxLite C SDK.
//!
//! Async methods (`boxlite_volume_create`, `boxlite_volume_list`,
//! `boxlite_volume_get`, `boxlite_volume_remove`) follow the post-and-drain
//! pattern; results are dispatched on the user's drain thread.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::runtime::VolumeHandle as CoreVolumeHandle;

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxVolumeCreateCb, CBoxVolumeGetCb, CBoxVolumeListCb, CBoxVolumeRemoveCb, EventQueue,
    RuntimeEvent, push_event,
};
use crate::runtime::RuntimeLiveness;
use crate::{CBoxliteError, CBoxliteVolumeHandle};

/// Opaque handle to runtime named-volume operations.
///
/// The handle owns a cloneable core volume handle plus the runtime liveness,
/// Tokio runtime, and event queue needed to submit asynchronous work. C callers
/// receive this as an opaque `CBoxliteVolumeHandle` and must release it with
/// `boxlite_volume_free`.
pub struct VolumeHandle {
    pub handle: CoreVolumeHandle,
    pub tokio_rt: Arc<TokioRuntime>,
    pub liveness: Arc<RuntimeLiveness>,
    pub queue: Arc<EventQueue>,
}

/// C ABI representation of volume metadata.
///
/// `id` and `created_at` are non-null, heap-owned C strings. A standalone value
/// is transferred to the callback and must be released exactly once with
/// `boxlite_free_volume_info`. List entries remain owned by their enclosing
/// [`CVolumeInfoList`] and must not be freed individually. `size_bytes` is
/// meaningful only when `has_size` is non-zero.
#[repr(C)]
pub struct CVolumeInfo {
    pub id: *mut c_char,
    pub created_at: *mut c_char,
    pub size_bytes: u64,
    pub has_size: c_int,
}

/// C ABI representation of a volume metadata list.
///
/// `items` points to `count` contiguous [`CVolumeInfo`] entries and may be null
/// only when `count` is zero. The callback recipient owns the list, its array,
/// and all entry strings and must release them together with
/// `boxlite_free_volume_info_list`.
#[repr(C)]
pub struct CVolumeInfoList {
    pub items: *mut CVolumeInfo,
    pub count: c_int,
}

fn to_c_str(s: &str) -> *mut c_char {
    CString::new(s)
        .map(|c| c.into_raw())
        .unwrap_or(ptr::null_mut())
}

impl CVolumeInfo {
    pub fn from_volume_info(info: &boxlite::runtime::types::VolumeInfo) -> Self {
        let (size_bytes, has_size) = match info.size_bytes {
            Some(size) => (size, 1),
            None => (0, 0),
        };

        CVolumeInfo {
            id: to_c_str(&info.id),
            created_at: to_c_str(&info.created_at.to_rfc3339()),
            size_bytes,
            has_size,
        }
    }
}

pub unsafe fn free_volume_info(info: *mut CVolumeInfo) {
    unsafe {
        if info.is_null() {
            return;
        }
        let info_ref = &mut *info;
        free_str(info_ref.id);
        free_str(info_ref.created_at);
        drop(Box::from_raw(info));
    }
}

pub unsafe fn free_volume_info_list(list: *mut CVolumeInfoList) {
    unsafe {
        if list.is_null() {
            return;
        }
        let list_ref = &mut *list;
        for idx in 0..list_ref.count {
            let item = &mut *list_ref.items.add(idx as usize);
            free_str(item.id);
            free_str(item.created_at);
        }
        if !list_ref.items.is_null() {
            drop(Vec::from_raw_parts(
                list_ref.items,
                list_ref.count as usize,
                list_ref.count as usize,
            ));
        }
        drop(Box::from_raw(list));
    }
}

unsafe fn free_str(s: *mut c_char) {
    if !s.is_null() {
        #[cfg(test)]
        crate::FREE_STR_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

/// Queue asynchronous volume creation.
///
/// `Ok` means queueing succeeded. The callback runs later on the thread calling
/// `boxlite_runtime_drain`; successful metadata ownership transfers to it.
/// Calls may be submitted concurrently. `user_data` is passed through unchanged
/// and must remain usable by the caller until callback dispatch.
///
/// # Safety
///
/// `handle` and `cb` must be non-null. `out_error` may be null; otherwise it must
/// be writable and receives synchronous queueing failures only. The handle must
/// remain valid until this function returns. A successful callback must release
/// its metadata with `boxlite_free_volume_info`; the error pointer is borrowed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_volume_create(
    handle: *mut CBoxliteVolumeHandle,
    cb: CBoxVolumeCreateCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    volume_create(handle, cb, user_data, out_error)
}

/// Queue asynchronous volume listing with the same dispatch, concurrency, and
/// `user_data` contract as [`boxlite_volume_create`].
///
/// # Safety
///
/// `handle` and `cb` must be non-null; `out_error` may be null. A successful
/// callback owns its list and must call `boxlite_free_volume_info_list`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_volume_list(
    handle: *mut CBoxliteVolumeHandle,
    cb: CBoxVolumeListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    volume_list(handle, cb, user_data, out_error)
}

/// Queue asynchronous lookup of a volume by id with the same dispatch,
/// concurrency, and `user_data` contract as [`boxlite_volume_create`].
///
/// # Safety
///
/// `handle`, `id`, and `cb` must be non-null. `id` must contain UTF-8 and only
/// needs to remain valid for this call. `out_error` may be null. A successful
/// callback owns its metadata and must call `boxlite_free_volume_info`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_volume_get(
    handle: *mut CBoxliteVolumeHandle,
    id: *const c_char,
    cb: CBoxVolumeGetCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    volume_get(handle, id, cb, user_data, out_error)
}

/// Queue asynchronous removal of a volume by id with the same dispatch,
/// concurrency, and `user_data` contract as [`boxlite_volume_create`]. A
/// non-zero `force` requests success when the volume is absent.
///
/// # Safety
///
/// `handle`, `id`, and `cb` must be non-null. `id` must contain UTF-8 and only
/// needs to remain valid for this call. `out_error` may be null. Callback
/// arguments are borrowed for dispatch and require no result deallocation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_volume_remove(
    handle: *mut CBoxliteVolumeHandle,
    id: *const c_char,
    force: c_int,
    cb: CBoxVolumeRemoveCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    volume_remove(handle, id, force, cb, user_data, out_error)
}

/// Free a volume handle returned by `boxlite_runtime_volumes`.
///
/// # Safety
///
/// `handle` must be null or a pointer previously returned by
/// `boxlite_runtime_volumes` that has not already been freed. Callers must not
/// use the handle after this function returns.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_volume_free(handle: *mut CBoxliteVolumeHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

/// Free a standalone `CVolumeInfo` and its owned strings.
///
/// # Safety
///
/// `info` must be null or a pointer allocated by this module that has not
/// already been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_volume_info(info: *mut CVolumeInfo) {
    free_volume_info(info)
}

/// Free a `CVolumeInfoList`, all entries, and their owned strings.
///
/// # Safety
///
/// `list` must be null or a pointer allocated by this module that has not
/// already been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_volume_info_list(list: *mut CVolumeInfoList) {
    free_volume_info_list(list)
}

unsafe fn volume_create(
    handle: *mut VolumeHandle,
    cb: CBoxVolumeCreateCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "create volume") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.create().await.map(|info| {
                crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CVolumeInfo::from_volume_info(&info)),
                    free_volume_info,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::VolumeCreate {
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

unsafe fn volume_list(
    handle: *mut VolumeHandle,
    cb: CBoxVolumeListCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "list volumes") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.list().await.map(|volume_list| {
                let mut items: Vec<CVolumeInfo> = volume_list
                    .iter()
                    .map(CVolumeInfo::from_volume_info)
                    .collect();
                let count = items.len() as c_int;
                let ptr = items.as_mut_ptr();
                std::mem::forget(items);
                crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CVolumeInfoList { items: ptr, count }),
                    free_volume_info_list,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::VolumeList {
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

unsafe fn volume_get(
    handle: *mut VolumeHandle,
    id: *const c_char,
    cb: CBoxVolumeGetCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let id = match crate::util::c_str_to_string(id) {
            Ok(id) => id,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "get volume") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.get(&id).await.map(|info| {
                crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CVolumeInfo::from_volume_info(&info)),
                    free_volume_info,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::VolumeGet {
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

unsafe fn volume_remove(
    handle: *mut VolumeHandle,
    id: *const c_char,
    force: c_int,
    cb: CBoxVolumeRemoveCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let id = match crate::util::c_str_to_string(id) {
            Ok(id) => id,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "remove volume") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let force = force != 0;
        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.remove(&id, force).await;
            push_event(
                &queue,
                RuntimeEvent::VolumeRemove {
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
