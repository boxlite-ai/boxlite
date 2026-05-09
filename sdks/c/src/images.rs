//! Image operations for the BoxLite C SDK.
//!
//! Async methods (`boxlite_image_pull`, `boxlite_image_list`) follow the
//! post-and-drain pattern; results are dispatched on the user's drain thread.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::ImageHandle as CoreImageHandle;

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{CBoxImageListCb, CBoxImagePullCb, EventQueue, RuntimeEvent, push_event};
use crate::runtime::RuntimeLiveness;
use crate::{CBoxliteError, CBoxliteImageHandle};

/// Opaque handle to runtime image operations.
pub struct ImageHandle {
    pub handle: CoreImageHandle,
    pub tokio_rt: Arc<TokioRuntime>,
    pub liveness: Arc<RuntimeLiveness>,
    pub queue: Arc<EventQueue>,
}

#[repr(C)]
pub struct CImageInfo {
    pub reference: *mut c_char,
    pub repository: *mut c_char,
    pub tag: *mut c_char,
    pub id: *mut c_char,
    pub cached_at: i64,
    pub size: u64,
    pub has_size: c_int,
}

#[repr(C)]
pub struct CImageInfoList {
    pub items: *mut CImageInfo,
    pub count: c_int,
}

#[repr(C)]
pub struct CImagePullResult {
    pub reference: *mut c_char,
    pub config_digest: *mut c_char,
    pub layer_count: c_int,
}

fn to_c_str(s: &str) -> *mut c_char {
    CString::new(s)
        .map(|c| c.into_raw())
        .unwrap_or(ptr::null_mut())
}

impl CImageInfo {
    pub fn from_image_info(info: &boxlite::runtime::types::ImageInfo) -> Self {
        let (size, has_size) = match &info.size {
            Some(size) => (size.as_bytes(), 1),
            None => (0, 0),
        };

        CImageInfo {
            reference: to_c_str(&info.reference),
            repository: to_c_str(&info.repository),
            tag: to_c_str(&info.tag),
            id: to_c_str(&info.id),
            cached_at: info.cached_at.timestamp(),
            size,
            has_size,
        }
    }
}

impl CImagePullResult {
    pub fn new(reference: &str, config_digest: &str, layer_count: usize) -> Self {
        Self {
            reference: to_c_str(reference),
            config_digest: to_c_str(config_digest),
            layer_count: layer_count as c_int,
        }
    }
}

pub unsafe fn free_image_info_list(list: *mut CImageInfoList) {
    unsafe {
        if list.is_null() {
            return;
        }
        let list_ref = &mut *list;
        for idx in 0..list_ref.count {
            let item = &mut *list_ref.items.add(idx as usize);
            free_str(item.reference);
            free_str(item.repository);
            free_str(item.tag);
            free_str(item.id);
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

pub unsafe fn free_image_pull_result(result: *mut CImagePullResult) {
    unsafe {
        if result.is_null() {
            return;
        }
        let result_ref = &mut *result;
        free_str(result_ref.reference);
        free_str(result_ref.config_digest);
        drop(Box::from_raw(result));
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
pub unsafe extern "C" fn boxlite_image_pull(
    handle: *mut CBoxliteImageHandle,
    image_ref: *const c_char,
    cb: CBoxImagePullCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    image_pull(handle, image_ref, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_image_list(
    handle: *mut CBoxliteImageHandle,
    cb: CBoxImageListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    image_list(handle, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_image_free(handle: *mut CBoxliteImageHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_image_info_list(list: *mut CImageInfoList) {
    free_image_info_list(list)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_image_pull_result(result: *mut CImagePullResult) {
    free_image_pull_result(result)
}

unsafe fn image_list(
    handle: *mut ImageHandle,
    cb: CBoxImageListCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "list images") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.list().await.map(|image_list| {
                let mut items: Vec<CImageInfo> =
                    image_list.iter().map(CImageInfo::from_image_info).collect();
                let count = items.len() as c_int;
                let ptr = items.as_mut_ptr();
                std::mem::forget(items);
                crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CImageInfoList { items: ptr, count }),
                    free_image_info_list,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::ImageList {
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

unsafe fn image_pull(
    handle: *mut ImageHandle,
    image_ref: *const c_char,
    cb: CBoxImagePullCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let image_ref = match crate::util::c_str_to_string(image_ref) {
            Ok(reference) => reference,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "pull image") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.pull(&image_ref).await.map(|image| {
                crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CImagePullResult::new(
                        image.reference(),
                        image.config_digest(),
                        image.layer_count(),
                    )),
                    free_image_pull_result,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::ImagePull {
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
