//! File copy operations for the BoxLite C SDK (async + callback variants).

use std::os::raw::{c_char, c_void};
use std::path::PathBuf;

use boxlite::litebox::copy::CopyOptions;

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{CBoxCopyCb, RuntimeEvent, push_event};
use crate::util::c_str_to_string;
use crate::{CBoxHandle, CBoxliteError};

/// Copy behavior options (docker-cp semantics). Mirrors the core
/// `CopyOptions`. Pass a pointer to one of these to the `*_with_options`
/// variants; pass `NULL` (or use the plain `boxlite_copy_into`/`_out`) to get
/// the docker-cp defaults (recursive=true, overwrite=true, follow_symlinks=false,
/// include_parent=true).
///
/// NOTE: a non-NULL struct must have **every** field set explicitly — there are
/// no implicit per-field defaults. In particular a zero-initialized struct
/// (`{0}` / memset) yields `include_parent=false`, the OPPOSITE of the docker-cp
/// default; pass NULL if you want the defaults.
#[repr(C)]
pub struct CBoxCopyOptions {
    /// Recursively copy directories (must be true for directory sources).
    pub recursive: bool,
    /// Overwrite existing files/directories at the destination.
    pub overwrite: bool,
    /// Follow symlinks (copy target content) instead of preserving the link.
    pub follow_symlinks: bool,
    /// Include the source directory itself in the copy (docker-cp default).
    /// When false, the directory's contents are flattened into the destination.
    pub include_parent: bool,
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
    box_copy_into(
        handle,
        host_src,
        guest_dst,
        std::ptr::null(),
        cb,
        user_data,
        out_error,
    )
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_into_with_options(
    handle: *mut CBoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    options: *const CBoxCopyOptions,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_copy_into(
        handle, host_src, guest_dst, options, cb, user_data, out_error,
    )
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
    box_copy_out(
        handle,
        guest_src,
        host_dst,
        std::ptr::null(),
        cb,
        user_data,
        out_error,
    )
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_out_with_options(
    handle: *mut CBoxHandle,
    guest_src: *const c_char,
    host_dst: *const c_char,
    options: *const CBoxCopyOptions,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_copy_out(
        handle, guest_src, host_dst, options, cb, user_data, out_error,
    )
}

fn default_copy_options() -> CopyOptions {
    CopyOptions {
        recursive: true,
        overwrite: true,
        follow_symlinks: false,
        // docker-cp default — keep the parent dir, matching the core,
        // Python, Node, and CLI defaults.
        include_parent: true,
    }
}

/// Resolve a (possibly null) options pointer into core `CopyOptions`.
/// `null` → defaults.
unsafe fn resolve_copy_options(options: *const CBoxCopyOptions) -> CopyOptions {
    if options.is_null() {
        return default_copy_options();
    }
    let o = unsafe { &*options };
    CopyOptions {
        recursive: o.recursive,
        overwrite: o.overwrite,
        follow_symlinks: o.follow_symlinks,
        include_parent: o.include_parent,
    }
}

unsafe fn box_copy_into(
    handle: *mut BoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    options: *const CBoxCopyOptions,
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
        let opts = resolve_copy_options(options);

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
    options: *const CBoxCopyOptions,
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
        let opts = resolve_copy_options(options);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.copy_out(src, dst, opts).await;
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
