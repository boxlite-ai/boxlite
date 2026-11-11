//! Path-based box archive import and export for the C SDK.
//!
//! Inputs are copied before returning; completions use the runtime drain queue.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use boxlite::{BoxArchive, BoxliteError, ExportOptions, ImportOptions, PreparedImport};
use tokio::runtime::Runtime as TokioRuntime;

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxExportCb, CPrepareImportCb, CRuntimeImportCb, OwnedFfiPtr, RuntimeEvent, push_event,
};
use crate::runtime::{RuntimeHandle, RuntimeLiveness};
use crate::{CBoxHandle, CBoxliteError, CBoxliteRuntime};

pub struct PreparedImportHandle {
    prepared: Mutex<Option<PreparedImport>>,
    info: CString,
    tokio_rt: TokioRuntimeDropGuard,
    queue: Arc<crate::event_queue::EventQueue>,
    liveness: Arc<RuntimeLiveness>,
}

/// Extract and validate an archive without creating a box. Optional JSON uses
/// ImportOptions (image, env values or null to remove keys, preflight_startup).
/// The callback owns its prepared handle. Keep the source until completion.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_prepare_import(
    runtime: *mut CBoxliteRuntime,
    archive_path: *const c_char,
    options_json_or_null: *const c_char,
    cb: CPrepareImportCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if runtime.is_null() {
        unsafe { write_error(out_error, null_pointer_error("runtime")) };
        return BoxliteErrorCode::InvalidArgument;
    }
    let inputs = unsafe {
        (|| {
            let path = parse_required_path(archive_path, "archive_path")?;
            let options = if options_json_or_null.is_null() {
                ImportOptions::default()
            } else {
                let json = parse_required_string(options_json_or_null, "options_json_or_null")?;
                serde_json::from_str::<ImportOptions>(&json).map_err(|_| {
                    BoxliteError::InvalidArgument("invalid import options JSON".into())
                })?
            };
            Ok::<_, BoxliteError>((BoxArchive::new(path), options))
        })()
    };
    let (archive, options) = match inputs {
        Ok(inputs) => inputs,
        Err(error) => {
            let code = error_to_code(&error);
            unsafe { write_error(out_error, error) };
            return code;
        }
    };
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let runtime = unsafe { &*runtime };
    if let Err(error) = crate::util::ensure_runtime_live(&runtime.liveness, "prepare import") {
        let code = error_to_code(&error);
        unsafe { write_error(out_error, error) };
        return code;
    }
    let core = runtime.runtime.clone();
    let task_runtime = runtime.tokio_rt.clone();
    let owner_runtime = runtime.tokio_rt.clone();
    let queue = runtime.queue.clone();
    let owner_queue = queue.clone();
    let liveness = runtime.liveness.clone();
    let user_data = user_data as usize;
    runtime.tokio_rt.spawn(async move {
        let _guard = TokioRuntimeDropGuard::new(task_runtime);
        let owner_runtime = TokioRuntimeDropGuard::new(owner_runtime);
        let result = core
            .prepare_import(archive, options)
            .await
            .and_then(|prepared| {
                let info =
                    CString::new(serde_json::to_string(prepared.info()).map_err(|error| {
                        BoxliteError::Internal(format!("cannot serialize import metadata: {error}"))
                    })?)
                    .map_err(|_| BoxliteError::Internal("invalid import metadata".into()))?;
                Ok(OwnedFfiPtr::new(Box::new(PreparedImportHandle {
                    prepared: Mutex::new(Some(prepared)),
                    info,
                    tokio_rt: owner_runtime,
                    queue: owner_queue,
                    liveness,
                })))
            });
        push_event(
            &queue,
            RuntimeEvent::PrepareImport {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Borrow source metadata JSON until this owner is freed; null returns null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_prepared_import_info_json(
    handle: *const crate::CPreparedImport,
) -> *const c_char {
    unsafe { handle.as_ref() }.map_or(std::ptr::null(), |handle| handle.info.as_ptr())
}

/// Commit already validated staging without rereading the source. Synchronous
/// rejection keeps staging available; accepted work consumes it exactly once.
/// The owner may be freed after this function returns; the task owns the disks.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_prepared_import_commit(
    handle: *mut crate::CPreparedImport,
    name_or_null: *const c_char,
    cb: CRuntimeImportCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let submit = || -> Result<(), BoxliteError> {
        let owner =
            unsafe { handle.as_ref() }.ok_or_else(|| null_pointer_error("prepared_import"))?;
        let name = unsafe { parse_optional_name(name_or_null) }?;
        let cb = cb.ok_or_else(|| null_pointer_error("cb"))?;
        crate::util::ensure_runtime_live(&owner.liveness, "commit import")?;
        let prepared = owner
            .prepared
            .lock()
            .map_err(|_| BoxliteError::Internal("prepared import lock poisoned".into()))?
            .take()
            .ok_or_else(|| {
                BoxliteError::InvalidState("prepared import already committed".into())
            })?;
        let tokio_rt = owner.tokio_rt.0.as_ref().expect("prepared runtime").clone();
        let task_runtime = tokio_rt.clone();
        let box_runtime = tokio_rt.clone();
        let queue = owner.queue.clone();
        let box_queue = queue.clone();
        let user_data = user_data as usize;
        tokio_rt.spawn(async move {
            let _guard = TokioRuntimeDropGuard::new(task_runtime);
            let result = prepared.commit(name).await.map(|handle| {
                let box_id = handle.id().clone();
                OwnedFfiPtr::new(Box::new(BoxHandle {
                    handle: Arc::new(handle),
                    box_id,
                    tokio_rt: box_runtime,
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
        Ok(())
    };
    match submit() {
        Ok(()) => BoxliteErrorCode::Ok,
        Err(error) => {
            let code = error_to_code(&error);
            unsafe { write_error(out_error, error) };
            code
        }
    }
}

/// Release uncommitted staging or the consumed wrapper; never deletes a box.
/// Null is accepted. Serialize freeing with calls that access the same pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_prepared_import_free(handle: *mut crate::CPreparedImport) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle)) };
    }
}

// use it to prevent the runtime from being dropped while the import task is running.
// The runtime is cloned into the task,
// and this guard will drop that clone when the task completes.
// "an Arc<Runtime> will prevent the runtime from shutting down." according to: https://docs.rs/tokio/latest/tokio/runtime/struct.Runtime.html#sharing
pub(crate) struct TokioRuntimeDropGuard(Option<Arc<TokioRuntime>>);

impl TokioRuntimeDropGuard {
    pub(crate) fn new(runtime: Arc<TokioRuntime>) -> Self {
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

    extern "C" fn noop_prepare_import_cb(
        _archive: *mut crate::CPreparedImport,
        _error: *mut CBoxliteError,
        _user_data: *mut c_void,
    ) {
    }

    #[test]
    fn import_preparation_refuses_a_closed_runtime_before_queueing() {
        let core =
            boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new("http://127.0.0.1:1"))
                .unwrap();
        let mut runtime = RuntimeHandle {
            runtime: core,
            tokio_rt: crate::runtime::create_tokio_runtime().unwrap(),
            liveness: Arc::new(crate::runtime::RuntimeLiveness::new()),
            queue: Arc::new(crate::event_queue::EventQueue::new()),
        };
        runtime.liveness.mark_closed();
        let archive = CString::new("/tmp/checkpoint.boxlite").unwrap();
        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_runtime_prepare_import(
                &mut runtime,
                archive.as_ptr(),
                ptr::null(),
                Some(noop_prepare_import_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        unsafe { crate::boxlite_error_free(&mut error) };
        assert_eq!(code, BoxliteErrorCode::Stopped);
    }

    #[test]
    fn import_preparation_rejects_invalid_inputs_before_dereferencing_the_runtime() {
        let dangling_runtime = ptr::NonNull::<RuntimeHandle>::dangling().as_ptr();
        let archive = CString::new("/tmp/checkpoint.boxlite").unwrap();
        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_runtime_prepare_import(
                ptr::null_mut(),
                archive.as_ptr(),
                ptr::null(),
                Some(noop_prepare_import_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "runtime");
        let code = unsafe {
            boxlite_runtime_prepare_import(
                dangling_runtime,
                ptr::null(),
                ptr::null(),
                Some(noop_prepare_import_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "archive_path");
        let invalid_json = CString::new("{bad-private-input").unwrap();
        let code = unsafe {
            boxlite_runtime_prepare_import(
                dangling_runtime,
                archive.as_ptr(),
                invalid_json.as_ptr(),
                Some(noop_prepare_import_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "import options");
        let code = unsafe {
            boxlite_runtime_prepare_import(
                dangling_runtime,
                archive.as_ptr(),
                ptr::null(),
                None,
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "cb");
        assert!(unsafe { boxlite_prepared_import_info_json(ptr::null()) }.is_null());
        let code = unsafe {
            boxlite_prepared_import_commit(
                ptr::null_mut(),
                ptr::null(),
                Some(noop_import_cb),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_invalid_argument(code, &mut error, "prepared_import");
        unsafe { boxlite_prepared_import_free(ptr::null_mut()) };
    }

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
