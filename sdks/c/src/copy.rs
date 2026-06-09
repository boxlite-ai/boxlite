//! File copy operations for the BoxLite C SDK (async + callback variants).

use std::os::raw::{c_char, c_void};
use std::path::PathBuf;

use boxlite::litebox::copy::CopyOptions;

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{CBoxCopyCb, RuntimeEvent, push_event};
use crate::util::c_str_to_string;
use crate::{CBoxHandle, CBoxliteError};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_into(
    handle: *mut CBoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_copy_into(
        handle,
        host_src,
        guest_dst,
        default_copy_options(),
        cb,
        user_data,
        out_error,
    )
}

/// Variant of `boxlite_copy_into` that takes an explicit `overwrite`
/// flag. Required for REST-mode `copy_in(..., overwrite=False)` to
/// reach the guest unchanged — `boxlite_copy_into` hard-codes
/// `overwrite=true` (the SDK's default) and there's no other way to
/// pass the flag across the C ABI today. All other CopyOptions
/// (recursive, follow_symlinks, include_parent) stay defaulted because
/// the runner-side staging step encodes them at archive-creation time
/// before this call is reached.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_into_with_options(
    handle: *mut CBoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    overwrite: bool,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let mut opts = default_copy_options();
    opts.overwrite = overwrite;
    box_copy_into(handle, host_src, guest_dst, opts, cb, user_data, out_error)
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
        include_parent: false,
    }
}

unsafe fn box_copy_into(
    handle: *mut BoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    opts: CopyOptions,
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
            let result = lite.copy_into(src, dst, opts).await;
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
