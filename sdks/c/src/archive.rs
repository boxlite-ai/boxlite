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

#[repr(C)]
pub struct CExportOptions {
    /// Non-zero includes guest memory and VM state; zero exports disk only.
    pub include_memory: std::os::raw::c_int,
}

/// Submit a disk-only box export.
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
    unsafe {
        boxlite_box_export_with_options(handle, dest, std::ptr::null(), cb, user_data, out_error)
    }
}

/// Submit a box export with options; pass NULL for disk-only export.
///
/// Options are copied before this function returns. On success, the callback
/// owns the returned path and must release it with `boxlite_free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_export_with_options(
    handle: *mut CBoxHandle,
    dest: *const c_char,
    options: *const CExportOptions,
    cb: CBoxExportCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { export_box(handle, dest, options, cb, user_data, out_error) }
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

unsafe fn export_includes_memory(options: *const CExportOptions) -> bool {
    unsafe { options.as_ref() }.is_some_and(|options| options.include_memory != 0)
}

unsafe fn export_box(
    handle: *mut BoxHandle,
    dest: *const c_char,
    options: *const CExportOptions,
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

        let include_memory = export_includes_memory(options);
        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite
                .export(ExportOptions { include_memory }, &dest)
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

    use boxlite_test_utils::home::PerTestBoxHome;
    use std::{ptr, sync::mpsc, time::Duration};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};

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
    fn export_options_map_null_and_zero_to_disk_only() {
        assert!(!unsafe { export_includes_memory(ptr::null()) });
        for include_memory in [0, 1, 2, -1] {
            let options = CExportOptions { include_memory };
            assert_eq!(
                unsafe { export_includes_memory(&options) },
                include_memory != 0
            );
        }
    }

    #[test]
    fn export_with_options_rejects_invalid_arguments_synchronously() {
        let options = CExportOptions { include_memory: 1 };
        let dangling_handle = ptr::NonNull::<BoxHandle>::dangling().as_ptr();
        let mut error = FFIError::default();
        let dest = c"archive.boxlite".as_ptr();
        let cb: CBoxExportCb = Some(noop_export_cb);
        for (handle, dest, cb, parameter) in [
            (ptr::null_mut(), dest, cb, "handle"),
            (dangling_handle, ptr::null(), cb, "dest"),
            (dangling_handle, c"".as_ptr(), cb, "dest"),
            (dangling_handle, dest, None, "cb"),
        ] {
            let code = unsafe {
                boxlite_box_export_with_options(
                    handle,
                    dest,
                    &options,
                    cb,
                    ptr::null_mut(),
                    &mut error,
                )
            };
            assert_invalid_argument(code, &mut error, parameter);
        }
    }

    type HttpRequest = (String, String);
    type GetReply = (BoxliteErrorCode, *mut CBoxHandle);
    type ExportReply = (BoxliteErrorCode, Option<CString>);

    const BOX_GET: &str = "GET /v1/boxes/source-1 HTTP/1.1";
    const CONFIG_GET: &str = "GET /v1/config HTTP/1.1";
    const EXPORT_POST: &str = "POST /v1/boxes/source-1/export HTTP/1.1";
    const ARCHIVE_BYTES: &str = "mock disk-only archive";

    async fn answer_export_request(stream: TcpStream, requests: &mpsc::Sender<HttpRequest>) {
        let mut reader = BufReader::new(stream);
        let mut request = String::new();
        reader.read_line(&mut request).await.unwrap();
        let request = request.trim_end().to_owned();
        let mut length = 0;
        loop {
            let mut header = String::new();
            assert_ne!(reader.read_line(&mut header).await.unwrap(), 0);
            if header == "\r\n" {
                break;
            }
            if let Some((key, value)) = header.split_once(':')
                && key.eq_ignore_ascii_case("content-length")
            {
                length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).await.unwrap();

        let (status, content_type, response) = match request.as_str() {
            BOX_GET => (
                "200 OK",
                "application/json",
                r#"{"box_id":"source-1","name":"worker","status":"stopped","created_at":"2026-11-06T00:00:00Z","updated_at":"2026-11-06T00:00:00Z","image":"alpine:latest","cpus":2,"memory_mib":512}"#,
            ),
            CONFIG_GET => (
                "200 OK",
                "application/json",
                r#"{"capabilities":{"export_enabled":true}}"#,
            ),
            EXPORT_POST => ("200 OK", "application/octet-stream", ARCHIVE_BYTES),
            _ => ("404 Not Found", "application/json", "{}"),
        };
        requests
            .send((request, String::from_utf8(body).unwrap()))
            .unwrap();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
            response.len()
        );
        reader
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
    }

    extern "C" fn get_reply(handle: *mut CBoxHandle, error: *mut CBoxliteError, data: *mut c_void) {
        unsafe { *data.cast::<Option<GetReply>>() = Some(((*error).code, handle)) };
    }

    extern "C" fn export_reply(path: *mut c_char, error: *mut CBoxliteError, data: *mut c_void) {
        unsafe {
            let archive = (!path.is_null()).then(|| CStr::from_ptr(path).to_owned());
            crate::boxlite_free_string(path);
            *data.cast::<Option<ExportReply>>() = Some(((*error).code, archive));
        }
    }

    fn drain_one(runtime: &mut RuntimeHandle) {
        let tokio_rt = runtime.tokio_rt.clone();
        let events = tokio_rt.block_on(async {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let events =
                        unsafe { crate::boxlite_runtime_drain(runtime, 0, ptr::null_mut()) };
                    if events != 0 {
                        break events;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .expect("callback was not delivered through drain")
        });
        assert_eq!(events, 1);
    }

    fn rest_export_box() -> (RuntimeHandle, Box<CBoxHandle>, mpsc::Receiver<HttpRequest>) {
        // Drive Tokio only during drain so stack mutations before drain always
        // happen before the submitted export task can run.
        let tokio_rt = Arc::new(
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap(),
        );
        let listener = tokio_rt.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, requests) = mpsc::channel();
        tokio_rt.spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                answer_export_request(stream, &sender).await;
            }
        });
        let mut runtime = RuntimeHandle {
            runtime: boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(format!(
                "http://{address}"
            )))
            .unwrap(),
            tokio_rt,
            liveness: Arc::new(crate::runtime::RuntimeLiveness::new()),
            queue: Arc::new(crate::event_queue::EventQueue::new()),
        };
        let mut reply: Option<GetReply> = None;
        assert_eq!(
            unsafe {
                crate::boxlite_get(
                    &mut runtime,
                    c"source-1".as_ptr(),
                    Some(get_reply),
                    ptr::from_mut(&mut reply).cast(),
                    ptr::null_mut(),
                )
            },
            BoxliteErrorCode::Ok
        );
        drain_one(&mut runtime);
        let (code, handle) = reply.unwrap();
        assert_eq!(code, BoxliteErrorCode::Ok);
        assert!(!handle.is_null());
        // Take ownership of the C callback's handle (boxlite_box_free drops it this way).
        (runtime, unsafe { Box::from_raw(handle) }, requests)
    }

    #[test]
    fn full_rest_export_reports_unsupported_through_drain_without_an_export_request() {
        let _strings = crate::FREE_STR_LOCK.lock().unwrap();
        let (mut runtime, mut handle, requests) = rest_export_box();
        let home = PerTestBoxHome::isolated();
        let path = home.path.join("full.boxlite");
        let dest = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        let options = CExportOptions { include_memory: 1 };
        let mut reply: Option<ExportReply> = None;
        assert_eq!(
            unsafe {
                boxlite_box_export_with_options(
                    &mut *handle,
                    dest.as_ptr(),
                    &options,
                    Some(export_reply),
                    ptr::from_mut(&mut reply).cast(),
                    ptr::null_mut(),
                )
            },
            BoxliteErrorCode::Ok
        );
        assert!(reply.is_none());
        drain_one(&mut runtime);
        assert_eq!(reply, Some((BoxliteErrorCode::Unsupported, None)));
        assert_eq!(
            requests.try_iter().collect::<Vec<_>>(),
            [(BOX_GET.into(), String::new())]
        );
    }

    #[test]
    fn disk_only_rest_export_accepts_null_and_copies_zero_options_before_returning() {
        let _strings = crate::FREE_STR_LOCK.lock().unwrap();
        let (mut runtime, mut handle, requests) = rest_export_box();
        let home = PerTestBoxHome::isolated();
        for (file, null_options) in [("null.boxlite", true), ("zero.boxlite", false)] {
            let path = home.path.join(file);
            let dest = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
            let mut options = CExportOptions { include_memory: 0 };
            let supplied = if null_options {
                ptr::null()
            } else {
                &raw const options
            };
            let mut reply: Option<ExportReply> = None;
            assert_eq!(
                unsafe {
                    boxlite_box_export_with_options(
                        &mut *handle,
                        dest.as_ptr(),
                        supplied,
                        Some(export_reply),
                        ptr::from_mut(&mut reply).cast(),
                        ptr::null_mut(),
                    )
                },
                BoxliteErrorCode::Ok
            );
            options.include_memory = 1;
            std::hint::black_box(&options);
            assert!(reply.is_none());
            drain_one(&mut runtime);
            assert_eq!(reply, Some((BoxliteErrorCode::Ok, Some(dest))));
            assert_eq!(std::fs::read(path).unwrap(), ARCHIVE_BYTES.as_bytes());
        }
        assert_eq!(
            requests.try_iter().collect::<Vec<_>>(),
            [
                (BOX_GET.into(), String::new()),
                (CONFIG_GET.into(), String::new()),
                (EXPORT_POST.into(), "{}".into()),
                (EXPORT_POST.into(), "{}".into()),
            ]
        );
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
