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
use crate::event_queue::{
    CBoxInfoCb, CBoxInfoListCb, CBoxInfoListV2Cb, CBoxInfoV2Cb, RuntimeEvent, push_event,
};
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
    pub auto_pause: u32,
    pub auto_delete: u32,
    pub auto_resume: c_int,
    pub created_at: i64,
}

#[repr(C)]
pub struct CBoxInfoList {
    pub items: *mut CBoxInfo,
    pub count: c_int,
}

/// Versioned box metadata that adds capability policy without changing the
/// layout or array stride of the stable CBoxInfo ABI.
#[repr(C)]
pub struct CContainerCapabilities {
    pub add: *mut *mut c_char,
    pub add_count: c_int,
    pub drop: *mut *mut c_char,
    pub drop_count: c_int,
}

#[repr(C)]
pub struct CBoxAdvancedInfo {
    pub capabilities: CContainerCapabilities,
}

#[repr(C)]
pub struct CBoxInfoV2 {
    pub base: CBoxInfo,
    pub advanced: CBoxAdvancedInfo,
}

#[repr(C)]
pub struct CBoxInfoListV2 {
    pub items: *mut CBoxInfoV2,
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
            auto_pause: info.auto_pause,
            auto_delete: info.auto_delete,
            auto_resume: if info.auto_resume { 1 } else { 0 },
            created_at: info.created_at.timestamp(),
        }
    }
}

impl CBoxInfoV2 {
    pub fn from_box_info(info: &boxlite::runtime::types::BoxInfo) -> Self {
        Self {
            base: CBoxInfo::from_box_info(info),
            advanced: CBoxAdvancedInfo::from_box_info(&info.advanced),
        }
    }
}

impl CBoxAdvancedInfo {
    fn from_box_info(info: &boxlite::runtime::types::BoxAdvancedInfo) -> Self {
        Self {
            capabilities: CContainerCapabilities::from_capabilities(&info.capabilities),
        }
    }
}

impl CContainerCapabilities {
    fn from_capabilities(
        capabilities: &boxlite::runtime::advanced_options::ContainerCapabilities,
    ) -> Self {
        let (add, add_count) = to_c_str_list(&capabilities.add);
        let (drop, drop_count) = to_c_str_list(&capabilities.drop);
        Self {
            add,
            add_count,
            drop,
            drop_count,
        }
    }
}

fn to_c_str_list(values: &[String]) -> (*mut *mut c_char, c_int) {
    if values.is_empty() {
        return (ptr::null_mut(), 0);
    }
    let mut strings: Box<[*mut c_char]> = values
        .iter()
        .map(|value| to_c_str(value))
        .collect::<Vec<_>>()
        .into_boxed_slice();
    let count = strings.len() as c_int;
    let items = strings.as_mut_ptr();
    Box::leak(strings);
    (items, count)
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
            drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
                list_ref.items,
                list_ref.count as usize,
            )));
        }
        drop(Box::from_raw(list));
    }
}

pub unsafe fn free_box_info_v2(info: *mut CBoxInfoV2) {
    unsafe {
        if info.is_null() {
            return;
        }
        let info = &mut *info;
        free_box_info(&mut info.base);
        free_box_advanced_info(&mut info.advanced);
    }
}

unsafe fn free_box_advanced_info(info: &mut CBoxAdvancedInfo) {
    unsafe {
        free_container_capabilities(&mut info.capabilities);
    }
}

unsafe fn free_container_capabilities(capabilities: &mut CContainerCapabilities) {
    unsafe {
        free_str_list(capabilities.add, capabilities.add_count);
        free_str_list(capabilities.drop, capabilities.drop_count);
    }
}

pub unsafe fn free_box_info_v2_ptr(info: *mut CBoxInfoV2) {
    unsafe {
        if info.is_null() {
            return;
        }
        free_box_info_v2(info);
        drop(Box::from_raw(info));
    }
}

pub unsafe fn free_box_info_list_v2(list: *mut CBoxInfoListV2) {
    unsafe {
        if list.is_null() {
            return;
        }
        let list = &mut *list;
        for index in 0..list.count {
            free_box_info_v2(list.items.add(index as usize));
        }
        if !list.items.is_null() {
            drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
                list.items,
                list.count as usize,
            )));
        }
        drop(Box::from_raw(list));
    }
}

unsafe fn free_str_list(values: *mut *mut c_char, count: c_int) {
    unsafe {
        if values.is_null() {
            return;
        }
        for index in 0..count {
            free_str(*values.add(index as usize));
        }
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
            values,
            count as usize,
        )));
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
pub unsafe extern "C" fn boxlite_box_info_v2(
    handle: *mut CBoxHandle,
    out_info: *mut *mut CBoxInfoV2,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_info_v2(handle, out_info, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get_info_v2(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    cb: CBoxInfoV2Cb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_info_by_id_v2(runtime, id_or_name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_list_info_v2(
    runtime: *mut CBoxliteRuntime,
    cb: CBoxInfoListV2Cb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_list_v2(runtime, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_box_info(info: *mut CBoxInfo) {
    free_box_info_ptr(info)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_box_info_list(list: *mut CBoxInfoList) {
    free_box_info_list(list)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_box_info_v2(info: *mut CBoxInfoV2) {
    free_box_info_v2_ptr(info)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_box_info_list_v2(list: *mut CBoxInfoListV2) {
    free_box_info_list_v2(list)
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

unsafe fn box_info_v2(
    handle: *mut BoxHandle,
    out_info: *mut *mut CBoxInfoV2,
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

        let info = (*handle).handle.info();
        *out_info = Box::into_raw(Box::new(CBoxInfoV2::from_box_info(&info)));
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

unsafe fn box_info_by_id_v2(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    cb: CBoxInfoV2Cb,
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
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime = &*runtime;
        let runtime_clone = runtime.runtime.clone();
        let queue = runtime.queue.clone();
        let user_data = user_data as usize;
        runtime.tokio_rt.spawn(async move {
            let result = match runtime_clone.get_info(&id_or_name).await {
                Ok(Some(info)) => Ok(crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CBoxInfoV2::from_box_info(&info)),
                    free_box_info_v2_ptr,
                )),
                Ok(None) => Err(BoxliteError::NotFound(format!(
                    "Box not found: {id_or_name}"
                ))),
                Err(error) => Err(error),
            };
            push_event(
                &queue,
                RuntimeEvent::InfoV2 {
                    cb,
                    user_data,
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
                let mut items = boxes
                    .iter()
                    .map(CBoxInfo::from_box_info)
                    .collect::<Vec<_>>()
                    .into_boxed_slice();
                let count = items.len() as c_int;
                let ptr = if items.is_empty() {
                    ptr::null_mut()
                } else {
                    let ptr = items.as_mut_ptr();
                    Box::leak(items);
                    ptr
                };
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

unsafe fn box_list_v2(
    runtime: *mut RuntimeHandle,
    cb: CBoxInfoListV2Cb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime = &*runtime;
        let runtime_clone = runtime.runtime.clone();
        let queue = runtime.queue.clone();
        let user_data = user_data as usize;
        runtime.tokio_rt.spawn(async move {
            let result = runtime_clone.list_info().await.map(|boxes| {
                let mut items = boxes
                    .iter()
                    .map(CBoxInfoV2::from_box_info)
                    .collect::<Vec<_>>()
                    .into_boxed_slice();
                let count = items.len() as c_int;
                let items_ptr = if items.is_empty() {
                    ptr::null_mut()
                } else {
                    let items_ptr = items.as_mut_ptr();
                    Box::leak(items);
                    items_ptr
                };
                crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CBoxInfoListV2 {
                        items: items_ptr,
                        count,
                    }),
                    free_box_info_list_v2,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::InfoListV2 {
                    cb,
                    user_data,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite::{BoxAdvancedInfo, BoxID, BoxInfo, ContainerCapabilities, HealthStatus};
    use std::collections::HashMap;
    use std::ffi::CStr;

    #[test]
    fn box_info_v2_preserves_capability_policy() {
        let _free_str_guard = crate::FREE_STR_LOCK.lock().unwrap();
        let free_str_calls_before = crate::FREE_STR_CALLS.load(std::sync::atomic::Ordering::SeqCst);
        let now = "2026-01-01T00:00:00Z".parse().unwrap();
        let source = BoxInfo {
            id: BoxID::parse("c-info-v2").unwrap(),
            name: Some("custom-policy".into()),
            status: BoxStatus::Configured,
            created_at: now,
            last_updated: now,
            pid: None,
            image: "alpine:latest".into(),
            cpus: 1,
            memory_mib: 512,
            advanced: BoxAdvancedInfo {
                capabilities: ContainerCapabilities {
                    add: vec!["NET_ADMIN".into()],
                    drop: vec!["NET_RAW".into(), "MKNOD".into()],
                },
            },
            labels: HashMap::new(),
            auto_pause: 0,
            auto_delete: 0,
            auto_resume: true,
            health_status: HealthStatus::new(),
            exit_code: None,
        };

        let info = Box::into_raw(Box::new(CBoxInfoV2::from_box_info(&source)));
        unsafe {
            assert_eq!((*info).advanced.capabilities.add_count, 1);
            assert_eq!((*info).advanced.capabilities.drop_count, 2);
            assert_eq!(
                CStr::from_ptr(*(*info).advanced.capabilities.add)
                    .to_str()
                    .unwrap(),
                "NET_ADMIN"
            );
            assert_eq!(
                CStr::from_ptr(*(*info).advanced.capabilities.drop.add(1))
                    .to_str()
                    .unwrap(),
                "MKNOD"
            );
            free_box_info_v2_ptr(info);
        }
        let free_str_calls_after = crate::FREE_STR_CALLS.load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!(free_str_calls_after - free_str_calls_before, 7);
    }
}
