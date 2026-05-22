//! File copy operations for the BoxLite C SDK (async + callback variants).

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::path::PathBuf;
use std::ptr;

use boxlite::litebox::copy::{CopyOptions, CopyOutPair};

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{CBoxCopyCb, CBoxCopyOutManyCb, OwnedFfiPtr, RuntimeEvent, push_event};
use crate::util::c_str_to_string;
use crate::{CBoxHandle, CBoxliteError};

/// One source/destination pair passed into `boxlite_copy_out_many`.
/// Strings are caller-owned; the SDK copies them into Rust `String`s
/// before the call returns, so the caller may free them after
/// `boxlite_copy_out_many` returns control.
#[repr(C)]
pub struct CCopyOutPair {
    pub container_src: *const c_char,
    pub host_dst: *const c_char,
}

/// Per-pair outcome returned from `boxlite_copy_out_many`. `error` is null
/// when the pair succeeded; a heap-allocated UTF-8 C string otherwise.
/// All `*mut c_char` fields are owned by the list and reclaimed by
/// `boxlite_free_copy_out_outcome_list`.
#[repr(C)]
pub struct CCopyOutOutcome {
    pub container_src: *mut c_char,
    pub host_dst: *mut c_char,
    pub error: *mut c_char,
}

#[repr(C)]
pub struct CCopyOutOutcomeList {
    pub items: *mut CCopyOutOutcome,
    pub count: c_int,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_into(
    handle: *mut CBoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_copy_into(handle, host_src, guest_dst, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_out(
    handle: *mut CBoxHandle,
    guest_src: *const c_char,
    host_dst: *const c_char,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_copy_out(handle, guest_src, host_dst, cb, user_data, out_error)
}

fn default_copy_options() -> CopyOptions {
    CopyOptions {
        recursive: true,
        overwrite: true,
        follow_symlinks: false,
        include_parent: true,
    }
}

unsafe fn box_copy_into(
    handle: *mut BoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let src = match c_str_to_string(host_src) {
            Ok(s) => PathBuf::from(s),
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let dst = match c_str_to_string(guest_dst) {
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
            let result = lite.copy_into(src, dst, default_copy_options()).await;
            push_event(
                &queue,
                RuntimeEvent::Copy {
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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_out_many(
    handle: *mut CBoxHandle,
    pairs: *const CCopyOutPair,
    count: usize,
    cb: CBoxCopyOutManyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_copy_out_many(handle, pairs, count, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_copy_out_outcome_list(list: *mut CCopyOutOutcomeList) {
    free_copy_out_outcome_list(list)
}

pub unsafe fn free_copy_out_outcome_list(list: *mut CCopyOutOutcomeList) {
    unsafe {
        if list.is_null() {
            return;
        }
        let list_ref = &mut *list;
        for idx in 0..list_ref.count {
            let item = &mut *list_ref.items.add(idx as usize);
            free_outcome_str(item.container_src);
            free_outcome_str(item.host_dst);
            free_outcome_str(item.error);
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

unsafe fn free_outcome_str(s: *mut c_char) {
    if !s.is_null() {
        #[cfg(test)]
        crate::FREE_STR_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

unsafe fn box_copy_out(
    handle: *mut BoxHandle,
    guest_src: *const c_char,
    host_dst: *const c_char,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let src = match c_str_to_string(guest_src) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let dst = match c_str_to_string(host_dst) {
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
            let result = lite.copy_out(src, dst, default_copy_options()).await;
            push_event(
                &queue,
                RuntimeEvent::Copy {
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

unsafe fn box_copy_out_many(
    handle: *mut BoxHandle,
    pairs: *const CCopyOutPair,
    count: usize,
    cb: CBoxCopyOutManyCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if count > 0 && pairs.is_null() {
            write_error(out_error, null_pointer_error("pairs"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let pair_slice = if count == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(pairs, count)
        };
        let mut rust_pairs: Vec<CopyOutPair> = Vec::with_capacity(pair_slice.len());
        for (idx, p) in pair_slice.iter().enumerate() {
            let src = match c_str_to_string(p.container_src) {
                Ok(s) => s,
                Err(e) => {
                    write_error(
                        out_error,
                        boxlite::BoxliteError::InvalidArgument(format!(
                            "pairs[{idx}].container_src: {e}"
                        )),
                    );
                    return BoxliteErrorCode::InvalidArgument;
                }
            };
            let dst = match c_str_to_string(p.host_dst) {
                Ok(s) => PathBuf::from(s),
                Err(e) => {
                    write_error(
                        out_error,
                        boxlite::BoxliteError::InvalidArgument(format!(
                            "pairs[{idx}].host_dst: {e}"
                        )),
                    );
                    return BoxliteErrorCode::InvalidArgument;
                }
            };
            rust_pairs.push(CopyOutPair {
                container_src: src,
                host_dst: dst,
            });
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.copy_out_many(&rust_pairs).await.map(|outcomes| {
                let mut items: Vec<CCopyOutOutcome> =
                    outcomes.into_iter().map(outcome_to_c).collect();
                let count = items.len() as c_int;
                let ptr = items.as_mut_ptr();
                std::mem::forget(items);
                OwnedFfiPtr::new_with(
                    Box::new(CCopyOutOutcomeList { items: ptr, count }),
                    free_copy_out_outcome_list,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::CopyOutMany {
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

fn outcome_to_c(outcome: boxlite::litebox::copy::CopyOutOutcome) -> CCopyOutOutcome {
    let container_src = CString::new(outcome.container_src)
        .map(|c| c.into_raw())
        .unwrap_or(ptr::null_mut());
    let host_dst = CString::new(outcome.host_dst.to_string_lossy().into_owned())
        .map(|c| c.into_raw())
        .unwrap_or(ptr::null_mut());
    let error = match outcome.error {
        Some(msg) => CString::new(msg)
            .map(|c| c.into_raw())
            .unwrap_or(ptr::null_mut()),
        None => ptr::null_mut(),
    };
    CCopyOutOutcome {
        container_src,
        host_dst,
        error,
    }
}
