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
pub struct VolumeHandle {
    pub handle: CoreVolumeHandle,
    pub tokio_rt: Arc<TokioRuntime>,
    pub liveness: Arc<RuntimeLiveness>,
    pub queue: Arc<EventQueue>,
}

#[repr(C)]
pub struct CVolumeInfo {
    pub name: *mut c_char,
    pub mountpoint: *mut c_char,
    pub created_at: *mut c_char,
    pub size_bytes: u64,
    pub has_size: c_int,
}

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
            name: to_c_str(&info.name),
            mountpoint: to_c_str(&info.mountpoint.to_string_lossy()),
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
        free_str(info_ref.name);
        free_str(info_ref.mountpoint);
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
            free_str(item.name);
            free_str(item.mountpoint);
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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_volume_create(
    handle: *mut CBoxliteVolumeHandle,
    name: *const c_char,
    size_gb: u64,
    has_size_gb: c_int,
    cb: CBoxVolumeCreateCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    volume_create(handle, name, size_gb, has_size_gb, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_volume_list(
    handle: *mut CBoxliteVolumeHandle,
    cb: CBoxVolumeListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    volume_list(handle, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_volume_get(
    handle: *mut CBoxliteVolumeHandle,
    name: *const c_char,
    cb: CBoxVolumeGetCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    volume_get(handle, name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_volume_remove(
    handle: *mut CBoxliteVolumeHandle,
    name: *const c_char,
    force: c_int,
    cb: CBoxVolumeRemoveCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    volume_remove(handle, name, force, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_volume_free(handle: *mut CBoxliteVolumeHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_volume_info(info: *mut CVolumeInfo) {
    free_volume_info(info)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_volume_info_list(list: *mut CVolumeInfoList) {
    free_volume_info_list(list)
}

unsafe fn volume_create(
    handle: *mut VolumeHandle,
    name: *const c_char,
    size_gb: u64,
    has_size_gb: c_int,
    cb: CBoxVolumeCreateCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let name = match crate::util::c_str_to_string(name) {
            Ok(name) => name,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "create volume") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let size_gb = if has_size_gb != 0 { Some(size_gb) } else { None };
        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.create(&name, size_gb).await.map(|info| {
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
    name: *const c_char,
    cb: CBoxVolumeGetCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let name = match crate::util::c_str_to_string(name) {
            Ok(name) => name,
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
            let result = core_handle.get(&name).await.map(|info| {
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
    name: *const c_char,
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

        let name = match crate::util::c_str_to_string(name) {
            Ok(name) => name,
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
            let result = core_handle.remove(&name, force).await;
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
