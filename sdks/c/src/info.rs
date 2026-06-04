//! Box information types and operations for the BoxLite C SDK.
//!
//! `boxlite_box_info` is synchronous (reads cached fields on the handle).
//! `boxlite_get_info` and `boxlite_list_info` are async + callback.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;

use boxlite::BoxliteError;
use boxlite::runtime::types::BoxStatus;

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{CBoxInfoCb, CBoxInfoListCb, RuntimeEvent, push_event};
use crate::runtime::RuntimeHandle;
use crate::{CBoxHandle, CBoxliteError, CBoxliteRuntime};

#[repr(C)]
pub struct CBoxInfo {
    pub id: *mut c_char,
    pub name: *mut c_char,
    pub image: *mut c_char,
    pub status: *mut c_char,
    pub running: c_int,
    pub pid: c_int,
    pub cpus: c_int,
    pub memory_mib: c_int,
    pub created_at: i64,
}

#[repr(C)]
pub struct CBoxInfoList {
    pub items: *mut CBoxInfo,
    pub count: c_int,
}

fn to_c_str(s: &str) -> *mut c_char {
    CString::new(s)
        .map(|c| c.into_raw())
        .unwrap_or(ptr::null_mut())
}

fn status_to_str(status: BoxStatus) -> &'static str {
    match status {
        BoxStatus::Unknown => "unknown",
        BoxStatus::Configured => "configured",
        BoxStatus::Running => "running",
        BoxStatus::Stopping => "stopping",
        BoxStatus::Stopped => "stopped",
        BoxStatus::Paused => "paused",
        BoxStatus::Failed => "failed",
    }
}

impl CBoxInfo {
    pub fn from_box_info(info: &boxlite::runtime::types::BoxInfo) -> Self {
        CBoxInfo {
            id: to_c_str(info.id.as_ref()),
            name: info
                .name
                .as_deref()
                .map(to_c_str)
                .unwrap_or(ptr::null_mut()),
            image: to_c_str(&info.image),
            status: to_c_str(status_to_str(info.status)),
            running: if info.status.is_running() { 1 } else { 0 },
            pid: info.pid.map(|p| p as c_int).unwrap_or(0),
            cpus: info.cpus as c_int,
            memory_mib: info.memory_mib as c_int,
            created_at: info.created_at.timestamp(),
        }
    }
}

pub unsafe fn free_box_info(info: *mut CBoxInfo) {
    unsafe {
        if info.is_null() {
            return;
        }
        let info_ref = &mut *info;
        free_str(info_ref.id);
        free_str(info_ref.name);
        free_str(info_ref.image);
        free_str(info_ref.status);
    }
}

pub unsafe fn free_box_info_ptr(info: *mut CBoxInfo) {
    unsafe {
        if info.is_null() {
            return;
        }
        free_box_info(info);
        drop(Box::from_raw(info));
    }
}

pub unsafe fn free_box_info_list(list: *mut CBoxInfoList) {
    unsafe {
        if list.is_null() {
            return;
        }
        let list_ref = &mut *list;
        for idx in 0..list_ref.count {
            free_box_info(list_ref.items.add(idx as usize));
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
pub unsafe extern "C" fn boxlite_box_info(
    handle: *mut CBoxHandle,
    out_info: *mut *mut CBoxInfo,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_info(handle, out_info, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get_info(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    cb: CBoxInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_info_by_id(runtime, id_or_name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_list_info(
    runtime: *mut CBoxliteRuntime,
    cb: CBoxInfoListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_list(runtime, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_box_info(info: *mut CBoxInfo) {
    free_box_info_ptr(info)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_box_info_list(list: *mut CBoxInfoList) {
    free_box_info_list(list)
}

unsafe fn box_info(
    handle: *mut BoxHandle,
    out_info: *mut *mut CBoxInfo,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_info.is_null() {
            write_error(out_error, null_pointer_error("out_info"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;
        let info = handle_ref.handle.info();
        *out_info = Box::into_raw(Box::new(CBoxInfo::from_box_info(&info)));
        BoxliteErrorCode::Ok
    }
}

unsafe fn box_info_by_id(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    cb: CBoxInfoCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let id_or_name = match crate::util::c_str_to_string(id_or_name) {
            Ok(value) => value,
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
            let result = match runtime_clone.get_info(&id_or_name).await {
                Ok(Some(info)) => Ok(crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CBoxInfo::from_box_info(&info)),
                    free_box_info_ptr,
                )),
                Ok(None) => Err(BoxliteError::NotFound(format!(
                    "Box not found: {id_or_name}"
                ))),
                Err(e) => Err(e),
            };
            push_event(
                &queue,
                RuntimeEvent::Info {
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

unsafe fn box_list(
    runtime: *mut RuntimeHandle,
    cb: CBoxInfoListCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime_ref = &*runtime;
        let runtime_clone = runtime_ref.runtime.clone();
        let queue = runtime_ref.queue.clone();
        let user_data_addr = user_data as usize;

        runtime_ref.tokio_rt.spawn(async move {
            let result = runtime_clone.list_info().await.map(|boxes| {
                let mut items: Vec<CBoxInfo> = boxes.iter().map(CBoxInfo::from_box_info).collect();
                let count = items.len() as c_int;
                let ptr = items.as_mut_ptr();
                std::mem::forget(items);
                crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CBoxInfoList { items: ptr, count }),
                    free_box_info_list,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::InfoList {
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
