//! Image operations for the BoxLite C SDK.

use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::ImageHandle as CoreImageHandle;

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::runtime::RuntimeLiveness;
use crate::{CBoxliteError, CBoxliteImageHandle};

/// Opaque handle to runtime image operations.
pub struct ImageHandle {
    pub handle: CoreImageHandle,
    pub tokio_rt: Arc<TokioRuntime>,
    pub liveness: Arc<RuntimeLiveness>,
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
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_image_pull(
    handle: *mut CBoxliteImageHandle,
    image_ref: *const c_char,
    out_result: *mut *mut CImagePullResult,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    image_pull(handle, image_ref, out_result, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_image_list(
    handle: *mut CBoxliteImageHandle,
    out_list: *mut *mut CImageInfoList,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    image_list(handle, out_list, out_error)
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
    out_list: *mut *mut CImageInfoList,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_list.is_null() {
            write_error(out_error, null_pointer_error("out_list"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "list images") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }

        let result = handle_ref.tokio_rt.block_on(handle_ref.handle.list());

        match result {
            Ok(image_list) => {
                let mut items: Vec<CImageInfo> =
                    image_list.iter().map(CImageInfo::from_image_info).collect();
                let count = items.len() as c_int;
                let ptr = items.as_mut_ptr();
                std::mem::forget(items);

                *out_list = Box::into_raw(Box::new(CImageInfoList { items: ptr, count }));
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

unsafe fn image_pull(
    handle: *mut ImageHandle,
    image_ref: *const std::os::raw::c_char,
    out_result: *mut *mut CImagePullResult,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_result.is_null() {
            write_error(out_error, null_pointer_error("out_result"));
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

        let result = handle_ref
            .tokio_rt
            .block_on(handle_ref.handle.pull(&image_ref));

        match result {
            Ok(image) => {
                *out_result = Box::into_raw(Box::new(CImagePullResult::new(
                    image.reference(),
                    image.config_digest(),
                    image.layer_count(),
                )));
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
