//! Live guest execution inventory. Listing never starts the box.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;

use crate::error::{BoxliteErrorCode, null_pointer_error, write_error};
use crate::event_queue::{CExecutionInfoListCb, OwnedFfiPtr, RuntimeEvent, push_event};
use crate::info::{free_raw_slice, into_raw_slice};
use crate::{CBoxHandle, CBoxliteError};

/// Owned metadata for one live guest execution, including the main process.
#[repr(C)]
pub struct CExecutionInfo {
    pub execution_id: *mut c_char,
    pub argv: *mut *mut c_char,
    pub argc: c_int,
    pub pid: u32,
    /// Start time in Unix milliseconds.
    pub started_at: u64,
    pub tty: bool,
    pub is_main: bool,
}

/// Owned list. Release it with `boxlite_free_execution_info_list`.
#[repr(C)]
pub struct CExecutionInfoList {
    pub items: *mut CExecutionInfo,
    pub count: c_int,
}

impl From<boxlite::litebox::ExecutionInfo> for CExecutionInfo {
    fn from(info: boxlite::litebox::ExecutionInfo) -> Self {
        let (argv, argc) = into_raw_slice(
            info.argv
                .into_iter()
                .map(|arg| {
                    CString::new(arg)
                        .expect("guest argv cannot contain NUL")
                        .into_raw()
                })
                .collect(),
        );
        Self {
            execution_id: CString::new(info.execution_id)
                .expect("guest execution ID cannot contain NUL")
                .into_raw(),
            argv,
            argc,
            pid: info.pid,
            started_at: info.started_at,
            tty: info.tty,
            is_main: info.is_main,
        }
    }
}

/// Callback owns the returned list; errors are borrowed during dispatch only.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_list_executions(
    handle: *mut CBoxHandle,
    cb: CExecutionInfoListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);
        let handle = &*handle;
        let lite = handle.handle.clone();
        let queue = handle.queue.clone();
        let user_data = user_data as usize;
        handle.tokio_rt.spawn(async move {
            let result = lite.list_executions().await.map(|executions| {
                let (items, count) =
                    into_raw_slice(executions.into_iter().map(CExecutionInfo::from).collect());
                OwnedFfiPtr::new_with(
                    Box::new(CExecutionInfoList { items, count }),
                    free_execution_info_list,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::ExecutionInfoList {
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

/// Free the list and all IDs/argv strings. Null is accepted.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_execution_info_list(list: *mut CExecutionInfoList) {
    unsafe { free_execution_info_list(list) }
}

pub(crate) unsafe fn free_execution_info_list(list: *mut CExecutionInfoList) {
    unsafe {
        if list.is_null() {
            return;
        }
        let list = Box::from_raw(list);
        if !list.items.is_null() && list.count > 0 {
            for info in std::slice::from_raw_parts_mut(list.items, list.count as usize) {
                crate::util::free_c_string(info.execution_id);
                if !info.argv.is_null() && info.argc > 0 {
                    for arg in std::slice::from_raw_parts(info.argv, info.argc as usize) {
                        crate::util::free_c_string(*arg);
                    }
                }
                free_raw_slice(info.argv, info.argc);
                info.execution_id = ptr::null_mut();
                info.argv = ptr::null_mut();
            }
        }
        free_raw_slice(list.items, list.count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_rejects_null_box_without_scheduling() {
        let mut error = crate::error::FFIError::default();
        unsafe {
            assert_eq!(
                boxlite_list_executions(ptr::null_mut(), None, ptr::null_mut(), &mut error),
                BoxliteErrorCode::InvalidArgument,
            );
            crate::boxlite_error_free(&mut error);
            boxlite_free_execution_info_list(ptr::null_mut());
        }
    }
}
