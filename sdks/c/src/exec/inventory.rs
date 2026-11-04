//! Live guest execution inventory. Listing never starts the box.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};

use boxlite::BoxliteError;

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
    /// Start time in Unix milliseconds.
    pub started_at: u64,
    pub tty: bool,
    pub is_main_session: bool,
}

/// Owned list. Release it with `boxlite_free_execution_info_list`.
#[repr(C)]
pub struct CExecutionInfoList {
    pub items: *mut CExecutionInfo,
    pub count: c_int,
}

impl CExecutionInfo {
    /// Fallible because these strings come from the guest, not from the C
    /// caller: a NUL byte in a listed argv would otherwise panic inside the
    /// spawned task, and the callback would never fire.
    ///
    /// Every string is built as a `CString` and released with `into_raw` only
    /// after the last one succeeds, so an early error frees what it allocated.
    fn try_from_info(info: boxlite::litebox::ExecutionInfo) -> Result<Self, BoxliteError> {
        let argv = info
            .argv
            .into_iter()
            .map(|arg| {
                CString::new(arg)
                    .map_err(|_| BoxliteError::Internal("guest argv contains a NUL byte".into()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let execution_id = CString::new(info.execution_id)
            .map_err(|_| BoxliteError::Internal("guest execution ID contains a NUL byte".into()))?;
        let (argv, argc) = into_raw_slice(argv.into_iter().map(CString::into_raw).collect());
        Ok(Self {
            execution_id: execution_id.into_raw(),
            argv,
            argc,
            started_at: info.started_at,
            tty: info.tty,
            is_main_session: info.is_main_session,
        })
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
            let result = lite.list_executions().await.and_then(|executions| {
                let items = executions
                    .into_iter()
                    .map(CExecutionInfo::try_from_info)
                    .collect::<Result<Vec<_>, _>>()?;
                let (items, count) = into_raw_slice(items);
                Ok(OwnedFfiPtr::new_with(
                    Box::new(CExecutionInfoList { items, count }),
                    free_execution_info_list,
                ))
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
            }
        }
        free_raw_slice(list.items, list.count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;
    use std::ptr;

    fn info(argv: Vec<&str>) -> boxlite::litebox::ExecutionInfo {
        boxlite::litebox::ExecutionInfo {
            execution_id: "exec-1".to_string(),
            argv: argv.into_iter().map(str::to_string).collect(),
            started_at: 1,
            tty: false,
            is_main_session: false,
        }
    }

    #[test]
    fn nul_in_listed_argv_is_an_error_not_a_panic() {
        let error = match CExecutionInfo::try_from_info(info(vec!["sh", "-c", "echo a\0b"])) {
            Ok(_) => panic!("a NUL byte in guest argv must be rejected"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("NUL"),
            "error should name the NUL byte: {error}"
        );
    }

    #[test]
    fn listed_argv_round_trips_through_the_ffi_struct() {
        let converted =
            CExecutionInfo::try_from_info(info(vec!["sh", "-c", "echo hi"])).expect("convert");
        unsafe {
            assert_eq!(converted.argc, 3);
            assert_eq!(
                CStr::from_ptr(converted.execution_id).to_str().unwrap(),
                "exec-1"
            );
            let arg = *converted.argv.add(2);
            assert_eq!(CStr::from_ptr(arg).to_str().unwrap(), "echo hi");
            let list = Box::into_raw(Box::new(CExecutionInfoList {
                items: Box::into_raw(Box::new(converted)),
                count: 1,
            }));
            boxlite_free_execution_info_list(list);
        }
    }

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
