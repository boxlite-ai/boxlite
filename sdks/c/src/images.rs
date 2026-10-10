//! Image operations for the BoxLite C SDK.
//!
//! The handle holds the images a runtime can boot from: the local cache on a
//! runtime from `boxlite_runtime_new`, the server's catalog on a REST runtime.
//! Pull is local only (a REST runtime pulls when a box is created) and usage is
//! REST only.
//!
//! Async methods (`boxlite_image_pull`, `boxlite_image_list`,
//! `boxlite_image_get`, `boxlite_image_remove`, `boxlite_image_usage`) follow
//! the post-and-drain pattern; results are dispatched on the user's drain thread.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxliteError;
use boxlite::ImageHandle as CoreImageHandle;
use boxlite::runtime::types::{ImageDetail, ImageUsage, ImageVersion};

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxImageGetCb, CBoxImageListCb, CBoxImagePullCb, CBoxImageRemoveCb, CBoxImageUsageCb,
    EventQueue, RuntimeEvent, push_event,
};
use crate::info::{free_raw_slice, into_raw_slice};
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

/// One build of an image, owned by its enclosing [`CImageDetail`].
///
/// Sizes and times follow [`CImageInfo`]: `size_bytes` is meaningful only when
/// `has_size` is non-zero, and `recorded_at` is in Unix seconds (UTC).
#[repr(C)]
pub struct CImageVersion {
    /// Manifest digest, such as "sha256:…".
    pub digest: *mut c_char,
    /// Sum of the layer sizes the manifest declares, in bytes.
    pub size_bytes: u64,
    /// Non-zero when `size_bytes` is known.
    pub has_size: c_int,
    /// The reference that was pulled to get this build.
    pub source_ref: *mut c_char,
    /// When this build was recorded, in Unix seconds.
    pub recorded_at: i64,
}

/// An image name and every build of it the runtime holds.
///
/// `tags` points to `tags_count` strings and `versions` to `versions_count`
/// entries, newest first; each array is null only when its count is zero. The
/// callback that receives a detail owns it, nested strings and arrays
/// included, and releases it once with `boxlite_free_image_detail`.
#[repr(C)]
pub struct CImageDetail {
    /// Registry and repository without a tag, such as "docker.io/library/alpine".
    pub name: *mut c_char,
    pub tags: *mut *mut c_char,
    pub tags_count: c_int,
    /// Non-zero when the operator provides the image rather than a box having
    /// pulled it. Only a REST runtime's catalog has these.
    pub curated: c_int,
    pub versions: *mut CImageVersion,
    pub versions_count: c_int,
}

/// How much of its image allowance a REST runtime's caller holds.
///
/// Passed to the callback by pointer, valid only during that callback; there
/// is nothing to free.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct CImageUsage {
    /// Images held.
    pub count: u64,
    /// Images the caller may hold.
    pub limit: u64,
    /// Sum of the sizes the held builds' manifests declare. A layer two builds
    /// share is counted for each, so this is not the bytes stored.
    pub known_bytes: u64,
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

impl CImageVersion {
    fn from_image_version(version: &ImageVersion) -> Self {
        let (size_bytes, has_size) = match version.size_bytes {
            Some(size) => (size, 1),
            None => (0, 0),
        };

        CImageVersion {
            digest: to_c_str(&version.digest),
            size_bytes,
            has_size,
            source_ref: to_c_str(&version.source_ref),
            recorded_at: version.recorded_at.timestamp(),
        }
    }
}

impl CImageDetail {
    pub fn from_image_detail(detail: &ImageDetail) -> Self {
        let (tags, tags_count) = into_raw_slice(detail.tags.iter().map(|t| to_c_str(t)).collect());
        let (versions, versions_count) = into_raw_slice(
            detail
                .versions
                .iter()
                .map(CImageVersion::from_image_version)
                .collect(),
        );

        CImageDetail {
            name: to_c_str(&detail.name),
            tags,
            tags_count,
            curated: c_int::from(detail.curated),
            versions,
            versions_count,
        }
    }
}

impl From<ImageUsage> for CImageUsage {
    fn from(usage: ImageUsage) -> Self {
        CImageUsage {
            count: usage.count,
            limit: usage.limit,
            known_bytes: usage.known_bytes,
        }
    }
}

pub unsafe fn free_image_detail(detail: *mut CImageDetail) {
    unsafe {
        if detail.is_null() {
            return;
        }
        let detail = Box::from_raw(detail);
        free_str(detail.name);
        if !detail.tags.is_null() && detail.tags_count >= 0 {
            for idx in 0..detail.tags_count as usize {
                free_str(*detail.tags.add(idx));
            }
        }
        free_raw_slice(detail.tags, detail.tags_count);
        if !detail.versions.is_null() && detail.versions_count >= 0 {
            for idx in 0..detail.versions_count as usize {
                let version = &*detail.versions.add(idx);
                free_str(version.digest);
                free_str(version.source_ref);
            }
        }
        free_raw_slice(detail.versions, detail.versions_count);
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

/// Queue a read of every build held under an image name, such as
/// "docker.io/library/alpine".
///
/// `Ok` means the request was queued; the callback runs later on the thread
/// calling `boxlite_runtime_drain`. A name the runtime does not hold reaches
/// the callback as `NotFound`, and a reference with a tag or digest
/// (`"quay.io/acme/app:v1"`) as `InvalidArgument`. `user_data` is passed
/// through unchanged and must stay usable until the callback runs.
///
/// # Safety
///
/// `handle`, `name`, and `cb` must be non-null; `name` must be UTF-8 and only
/// needs to stay valid for this call. `out_error` may be null and otherwise
/// receives synchronous queueing failures only. A successful callback owns
/// the detail and must release it with `boxlite_free_image_detail`; the error
/// pointer is borrowed for the callback only.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_image_get(
    handle: *mut CBoxliteImageHandle,
    name: *const c_char,
    cb: CBoxImageGetCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    image_get(handle, name, cb, user_data, out_error)
}

/// Queue removal of an image name, every tag of it, with the same dispatch
/// and argument contract as [`boxlite_image_get`].
///
/// The layers stay. On a local runtime a box built from the image fetches the
/// image's configuration from the registry when it next starts. A REST server
/// refuses with `InvalidState` while a box can still boot from the image.
///
/// # Safety
///
/// As for [`boxlite_image_get`]. The callback receives only a borrowed error
/// and has nothing to free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_image_remove(
    handle: *mut CBoxliteImageHandle,
    name: *const c_char,
    cb: CBoxImageRemoveCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    image_remove(handle, name, cb, user_data, out_error)
}

/// Queue a read of how many images are held against the allowance, with the
/// same dispatch contract as [`boxlite_image_get`]. REST runtimes only: on a
/// local runtime the callback receives `Unsupported`.
///
/// # Safety
///
/// `handle` and `cb` must be non-null; `out_error` may be null. The usage and
/// error pointers the callback receives are valid only during the callback.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_image_usage(
    handle: *mut CBoxliteImageHandle,
    cb: CBoxImageUsageCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    image_usage(handle, cb, user_data, out_error)
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

/// Free a `CImageDetail` with its tags, versions, and their strings.
///
/// # Safety
///
/// `detail` must be null or a pointer handed to a `boxlite_image_get` callback
/// that has not already been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_image_detail(detail: *mut CImageDetail) {
    free_image_detail(detail)
}

/// `name` copied out of the caller's string, which it owns only until the
/// call returns.
unsafe fn copy_name(name: *const c_char) -> Result<String, BoxliteError> {
    if name.is_null() {
        return Err(null_pointer_error("name"));
    }
    unsafe { CStr::from_ptr(name) }
        .to_str()
        .map(str::to_owned)
        .map_err(|e| BoxliteError::InvalidArgument(format!("name is not UTF-8: {e}")))
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

unsafe fn image_get(
    handle: *mut ImageHandle,
    name: *const c_char,
    cb: CBoxImageGetCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let name = match copy_name(name) {
            Ok(name) => name,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "get image") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.get(&name).await.map(|detail| {
                crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CImageDetail::from_image_detail(&detail)),
                    free_image_detail,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::ImageGet {
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

unsafe fn image_remove(
    handle: *mut ImageHandle,
    name: *const c_char,
    cb: CBoxImageRemoveCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let name = match copy_name(name) {
            Ok(name) => name,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "remove image") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.remove(&name).await;
            push_event(
                &queue,
                RuntimeEvent::ImageRemove {
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

unsafe fn image_usage(
    handle: *mut ImageHandle,
    cb: CBoxImageUsageCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, "read image usage") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.usage().await.map(CImageUsage::from);
            push_event(
                &queue,
                RuntimeEvent::ImageUsage {
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
