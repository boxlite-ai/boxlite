//! Path-based box archive import and export for the C SDK.
//!
//! Inputs are copied before the entrypoint returns, and completions are
//! delivered by the runtime's existing post-and-drain event queue.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::path::PathBuf;
use std::sync::Arc;

use boxlite::{BoxArchive, BoxliteError, ExportOptions};
use tokio::runtime::Runtime as TokioRuntime;

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{CBoxExportCb, CRuntimeImportCb, OwnedFfiPtr, RuntimeEvent, push_event};
use crate::runtime::RuntimeHandle;
use crate::{CBoxHandle, CBoxliteError, CBoxliteRuntime};

// use it to prevent the runtime from being dropped while the import task is running.
// The runtime is cloned into the task,
// and this guard will drop that clone when the task completes.
// "an Arc<Runtime> will prevent the runtime from shutting down." according to: https://docs.rs/tokio/latest/tokio/runtime/struct.Runtime.html#sharing
struct TokioRuntimeDropGuard(Option<Arc<TokioRuntime>>);

impl TokioRuntimeDropGuard {
    fn new(runtime: Arc<TokioRuntime>) -> Self {
        Self(Some(runtime))
    }
}

impl Drop for TokioRuntimeDropGuard {
    fn drop(&mut self) {
        let Some(runtime) = self.0.take() else {
            return;
        };
        match Arc::try_unwrap(runtime) {
            Ok(runtime) => runtime.shutdown_background(),
            Err(runtime) => {
                drop(std::thread::spawn(move || drop(runtime)));
            }
        }
    }
}

/// Submit a box export.
///
/// On success, the callback owns the returned path and must release it with
/// `boxlite_free_string`. The archive itself is never deleted by this bridge.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_export(
    handle: *mut CBoxHandle,
    dest: *const c_char,
    cb: CBoxExportCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { export_box(handle, dest, cb, user_data, out_error) }
}

/// Submit a trusted archive import.
///
/// A null or empty `name_or_null` leaves the new box unnamed. The callback
/// owns the returned stopped box handle. The caller retains ownership of the
/// archive file; this bridge never removes it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_import(
    runtime: *mut CBoxliteRuntime,
    archive_path: *const c_char,
    name_or_null: *const c_char,
    cb: CRuntimeImportCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        import_box(
            runtime,
            archive_path,
            name_or_null,
            cb,
            user_data,
            out_error,
        )
    }
}

unsafe fn export_box(
    handle: *mut BoxHandle,
    dest: *const c_char,
    cb: CBoxExportCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let dest = match parse_required_path(dest, "dest") {
            Ok(dest) => dest,
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                return code;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite
                .export(ExportOptions::default(), &dest)
                .await
                .and_then(|archive| archive_path_to_c_string(archive.path()));
            push_event(
                &queue,
                RuntimeEvent::BoxExport {
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

unsafe fn import_box(
    runtime: *mut RuntimeHandle,
    archive_path: *const c_char,
    name_or_null: *const c_char,
    cb: CRuntimeImportCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let archive_path = match parse_required_path(archive_path, "archive_path") {
            Ok(archive_path) => archive_path,
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                return code;
            }
        };
        let name = match parse_optional_name(name_or_null) {
            Ok(name) => name,
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                return code;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime_ref = &*runtime;
        let runtime = runtime_ref.runtime.clone();
        let tokio_rt = runtime_ref.tokio_rt.clone();
        let queue = runtime_ref.queue.clone();
        let box_tokio_rt = tokio_rt.clone();
        let task_tokio_rt = tokio_rt.clone();
        let box_queue = queue.clone();
        let user_data = user_data as usize;

        tokio_rt.spawn(async move {
            // Prevent the runtime from being dropped while the import task is running.
            let _runtime_drop_guard = TokioRuntimeDropGuard::new(task_tokio_rt);
            // Local runtimes intentionally trust caller-managed archives. A
            // REST server applies its own untrusted-upload policy server-side.
            let archive = BoxArchive::new(archive_path);
            let result = runtime.import_box(archive, name).await.map(|handle| {
                let box_id = handle.id().clone();
                OwnedFfiPtr::new(Box::new(BoxHandle {
                    handle: Arc::new(handle),
                    box_id,
                    tokio_rt: box_tokio_rt,
                    queue: box_queue,
                }))
            });
            push_event(
                &queue,
                RuntimeEvent::RuntimeImport {
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

unsafe fn parse_required_path(
    value: *const c_char,
    parameter: &str,
) -> Result<PathBuf, BoxliteError> {
    let value = unsafe { parse_required_string(value, parameter)? };
    if value.is_empty() {
        return Err(BoxliteError::InvalidArgument(format!(
            "{parameter} must not be empty"
        )));
    }
    Ok(PathBuf::from(value))
}

unsafe fn parse_optional_name(value: *const c_char) -> Result<Option<String>, BoxliteError> {
    if value.is_null() {
        return Ok(None);
    }
    let value = unsafe { parse_required_string(value, "name_or_null")? };
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

unsafe fn parse_required_string(
    value: *const c_char,
    parameter: &str,
) -> Result<String, BoxliteError> {
    if value.is_null() {
        return Err(null_pointer_error(parameter));
    }
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(str::to_owned)
        .map_err(|error| {
            BoxliteError::InvalidArgument(format!("{parameter} is not valid UTF-8: {error}"))
        })
}

fn archive_path_to_c_string(path: &std::path::Path) -> Result<CString, BoxliteError> {
    CString::new(path.to_string_lossy().as_bytes()).map_err(|_| {
        BoxliteError::Internal("exported archive path contains an interior NUL byte".to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ptr;

    extern "C" fn noop_export_cb(
        _archive_path: *mut c_char,
        _error: *mut CBoxliteError,
        _user_data: *mut c_void,
    ) {
    }

    extern "C" fn noop_import_cb(
        _handle: *mut CBoxHandle,
        _error: *mut CBoxliteError,
        _user_data: *mut c_void,
    ) {
    }

    fn assert_invalid_argument(code: BoxliteErrorCode, error: &mut FFIError, parameter: &str) {
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert_eq!(error.code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        let message = unsafe { CStr::from_ptr(error.message) }.to_string_lossy();
        assert!(
            message.contains(parameter),
            "error should mention {parameter}: {message}"
        );
        unsafe { crate::boxlite_error_free(error) };
    }

    #[test]
    fn export_rejects_invalid_arguments_synchronously() {
        let dest = CString::new("/tmp/export.boxlite").unwrap();
        let dangling_handle = ptr::NonNull::<BoxHandle>::dangling().as_ptr();
        let mut error = FFIError::default();

        let code = unsafe {
            boxlite_box_export(
                ptr::null_mut(),
                dest.as_ptr(),
                Some(noop_export_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "handle");

        let code = unsafe {
            boxlite_box_export(
                dangling_handle,
                ptr::null(),
                Some(noop_export_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "dest");

        let code = unsafe {
            boxlite_box_export(
                dangling_handle,
                dest.as_ptr(),
                None,
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "cb");
    }

    #[test]
    fn import_rejects_invalid_arguments_synchronously() {
        let archive_path = CString::new("/tmp/import.boxlite").unwrap();
        let dangling_runtime = ptr::NonNull::<RuntimeHandle>::dangling().as_ptr();
        let mut error = FFIError::default();

        let code = unsafe {
            boxlite_runtime_import(
                ptr::null_mut(),
                archive_path.as_ptr(),
                ptr::null(),
                Some(noop_import_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "runtime");

        let code = unsafe {
            boxlite_runtime_import(
                dangling_runtime,
                ptr::null(),
                ptr::null(),
                Some(noop_import_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "archive_path");

        let code = unsafe {
            boxlite_runtime_import(
                dangling_runtime,
                archive_path.as_ptr(),
                ptr::null(),
                None,
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "cb");
    }

    #[test]
    fn archive_paths_must_not_be_empty() {
        let empty = CString::new("").unwrap();
        let dangling_handle = ptr::NonNull::<BoxHandle>::dangling().as_ptr();
        let dangling_runtime = ptr::NonNull::<RuntimeHandle>::dangling().as_ptr();
        let mut error = FFIError::default();

        let code = unsafe {
            boxlite_box_export(
                dangling_handle,
                empty.as_ptr(),
                Some(noop_export_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "dest");

        let code = unsafe {
            boxlite_runtime_import(
                dangling_runtime,
                empty.as_ptr(),
                ptr::null(),
                Some(noop_import_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "archive_path");
    }

    #[test]
    fn null_and_empty_import_names_are_unnamed() {
        assert_eq!(unsafe { parse_optional_name(ptr::null()) }.unwrap(), None);

        let empty = CString::new("").unwrap();
        assert_eq!(
            unsafe { parse_optional_name(empty.as_ptr()) }.unwrap(),
            None
        );

        let named = CString::new("restored-box").unwrap();
        assert_eq!(
            unsafe { parse_optional_name(named.as_ptr()) }.unwrap(),
            Some("restored-box".to_string())
        );
    }
}
