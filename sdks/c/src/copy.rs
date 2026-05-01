//! File copy operations for the BoxLite C SDK.

use std::os::raw::c_char;
use std::path::Path;

use boxlite::litebox::copy::CopyOptions;

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::util::c_str_to_string;
use crate::{CBoxHandle, CBoxliteError};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_into(
    handle: *mut CBoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_copy_into(handle, host_src, guest_dst, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_out(
    handle: *mut CBoxHandle,
    guest_src: *const c_char,
    host_dst: *const c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_copy_out(handle, guest_src, host_dst, out_error)
}

unsafe fn box_copy_into(
    handle: *mut BoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let src = match c_str_to_string(host_src) {
            Ok(s) => s,
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

        let opts = CopyOptions {
            recursive: true,
            overwrite: true,
            follow_symlinks: false,
            include_parent: false,
        };
        let handle_ref = &*handle;
        let result =
            handle_ref
                .tokio_rt
                .block_on(handle_ref.handle.copy_into(Path::new(&src), &dst, opts));

        match result {
            Ok(()) => BoxliteErrorCode::Ok,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

unsafe fn box_copy_out(
    handle: *mut BoxHandle,
    guest_src: *const c_char,
    host_dst: *const c_char,
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
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let opts = CopyOptions {
            recursive: true,
            overwrite: true,
            follow_symlinks: false,
            include_parent: false,
        };
        let handle_ref = &*handle;
        let result =
            handle_ref
                .tokio_rt
                .block_on(handle_ref.handle.copy_out(&src, Path::new(&dst), opts));

        match result {
            Ok(()) => BoxliteErrorCode::Ok,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}
