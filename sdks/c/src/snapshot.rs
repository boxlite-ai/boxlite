//! Box state snapshot operations for the BoxLite C SDK.
//!
//! Exposes the five snapshot lifecycle ops the Rust core already supports
//! (`LiteBox::snapshots().create / list / get / restore / remove`) across
//! the C ABI. Async + callback shape matches the rest of the SDK
//! (copy_into / box info / get_info etc.) so the post-and-drain queue
//! delivers results on the host's drain thread, never on a Tokio worker.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;

use boxlite::BoxliteError;
use boxlite::runtime::options::SnapshotOptions;

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxSnapshotCreateCb, CBoxSnapshotListCb, CBoxSnapshotRemoveCb, CBoxSnapshotRestoreCb,
    OwnedFfiPtr, RuntimeEvent, push_event,
};
use crate::{CBoxHandle, CBoxliteError};

// ─── FFI types ─────────────────────────────────────────────────────────────

#[repr(C)]
pub struct CSnapshotInfo {
    pub id: *mut c_char,
    pub box_id: *mut c_char,
    pub name: *mut c_char,
    pub created_at: i64,
    pub container_disk_bytes: u64,
    pub size_bytes: u64,
}

#[repr(C)]
pub struct CSnapshotInfoList {
    pub items: *mut CSnapshotInfo,
    pub count: c_int,
}

fn to_c_str(s: &str) -> *mut c_char {
    CString::new(s)
        .map(|c| c.into_raw())
        .unwrap_or(ptr::null_mut())
}

unsafe fn free_str(s: *mut c_char) {
    if !s.is_null() {
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

impl CSnapshotInfo {
    pub fn from_snapshot_info(info: &boxlite::SnapshotInfo) -> Self {
        Self {
            id: to_c_str(&info.id),
            box_id: to_c_str(&info.box_id),
            name: to_c_str(&info.name),
            created_at: info.created_at,
            container_disk_bytes: info.disk_info.container_disk_bytes,
            size_bytes: info.disk_info.size_bytes,
        }
    }
}

pub unsafe fn free_snapshot_info(info: *mut CSnapshotInfo) {
    unsafe {
        if info.is_null() {
            return;
        }
        let r = &mut *info;
        free_str(r.id);
        free_str(r.box_id);
        free_str(r.name);
    }
}

pub unsafe fn free_snapshot_info_ptr(info: *mut CSnapshotInfo) {
    unsafe {
        if info.is_null() {
            return;
        }
        free_snapshot_info(info);
        drop(Box::from_raw(info));
    }
}

pub unsafe fn free_snapshot_info_list(list: *mut CSnapshotInfoList) {
    unsafe {
        if list.is_null() {
            return;
        }
        let l = &mut *list;
        for idx in 0..l.count {
            free_snapshot_info(l.items.add(idx as usize));
        }
        if !l.items.is_null() {
            drop(Vec::from_raw_parts(
                l.items,
                l.count as usize,
                l.count as usize,
            ));
        }
        drop(Box::from_raw(list));
    }
}

// ─── FFI entry points ──────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_snapshot_create(
    handle: *mut CBoxHandle,
    name: *const c_char,
    cb: CBoxSnapshotCreateCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_snapshot_create(handle, name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_snapshot_list(
    handle: *mut CBoxHandle,
    cb: CBoxSnapshotListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_snapshot_list(handle, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_snapshot_get(
    handle: *mut CBoxHandle,
    name: *const c_char,
    cb: CBoxSnapshotCreateCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_snapshot_get(handle, name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_snapshot_remove(
    handle: *mut CBoxHandle,
    name: *const c_char,
    cb: CBoxSnapshotRemoveCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_snapshot_remove(handle, name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_snapshot_restore(
    handle: *mut CBoxHandle,
    name: *const c_char,
    cb: CBoxSnapshotRestoreCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_snapshot_restore(handle, name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_snapshot_info(info: *mut CSnapshotInfo) {
    free_snapshot_info_ptr(info)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_snapshot_info_list(list: *mut CSnapshotInfoList) {
    free_snapshot_info_list(list)
}

// ─── internals ─────────────────────────────────────────────────────────────

unsafe fn box_snapshot_create(
    handle: *mut BoxHandle,
    name: *const c_char,
    cb: CBoxSnapshotCreateCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let name = match crate::util::c_str_to_string(name) {
            Ok(s) => s,
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
                .snapshots()
                .create(SnapshotOptions::default(), &name)
                .await
                .map(|info| {
                    OwnedFfiPtr::new_with(
                        Box::new(CSnapshotInfo::from_snapshot_info(&info)),
                        free_snapshot_info_ptr,
                    )
                });
            push_event(
                &queue,
                RuntimeEvent::SnapshotCreate {
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

unsafe fn box_snapshot_list(
    handle: *mut BoxHandle,
    cb: CBoxSnapshotListCb,
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
            let result = lite.snapshots().list().await.map(|infos| {
                let mut items: Vec<CSnapshotInfo> = infos
                    .iter()
                    .map(CSnapshotInfo::from_snapshot_info)
                    .collect();
                let count = items.len() as c_int;
                let ptr = items.as_mut_ptr();
                std::mem::forget(items);
                OwnedFfiPtr::new_with(
                    Box::new(CSnapshotInfoList { items: ptr, count }),
                    free_snapshot_info_list,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::SnapshotList {
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

unsafe fn box_snapshot_get(
    handle: *mut BoxHandle,
    name: *const c_char,
    cb: CBoxSnapshotCreateCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let name = match crate::util::c_str_to_string(name) {
            Ok(s) => s,
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
            let result = match lite.snapshots().get(&name).await {
                Ok(Some(info)) => Ok(OwnedFfiPtr::new_with(
                    Box::new(CSnapshotInfo::from_snapshot_info(&info)),
                    free_snapshot_info_ptr,
                )),
                Ok(None) => Err(BoxliteError::NotFound(format!(
                    "snapshot not found: {name}"
                ))),
                Err(e) => Err(e),
            };
            push_event(
                &queue,
                RuntimeEvent::SnapshotCreate {
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

unsafe fn box_snapshot_remove(
    handle: *mut BoxHandle,
    name: *const c_char,
    cb: CBoxSnapshotRemoveCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let name = match crate::util::c_str_to_string(name) {
            Ok(s) => s,
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
            let result = lite.snapshots().remove(&name).await;
            push_event(
                &queue,
                RuntimeEvent::SnapshotRemove {
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

unsafe fn box_snapshot_restore(
    handle: *mut BoxHandle,
    name: *const c_char,
    cb: CBoxSnapshotRestoreCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let name = match crate::util::c_str_to_string(name) {
            Ok(s) => s,
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
            let result = lite.snapshots().restore(&name).await;
            push_event(
                &queue,
                RuntimeEvent::SnapshotRestore {
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
