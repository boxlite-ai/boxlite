//! Checkpoint management uses the runtime's post-and-drain completion queue.
//! Inputs are copied synchronously; successful callbacks own their metadata or
//! Box handle. Releasing a result handle never removes a native Box.

use std::ffi::CString;
use std::future::Future;
use std::os::raw::{c_char, c_int, c_void};
use std::sync::Arc;

use boxlite::{BoxliteError, BoxliteResult, BoxliteRuntime, CheckpointInfo};
use tokio::runtime::Runtime as TokioRuntime;

use crate::archive::TokioRuntimeDropGuard;
use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxRemoveBoxCb, CCheckpointInfoCb, CCheckpointListCb, CRuntimeImportCb, EventQueue,
    OwnedFfiPtr, RuntimeEvent, push_event,
};
use crate::info::{free_raw_slice, into_raw_slice};
use crate::{CBoxliteError, CBoxliteRuntime};

/// Callback-owned checkpoint metadata. Release with boxlite_free_checkpoint_info.
#[repr(C)]
pub struct CCheckpointInfo {
    pub id: *mut c_char,
    pub name: *mut c_char,
    pub source_box_id: *mut c_char,
    pub created_at: *mut c_char,
    pub size_bytes: u64,
    /// Lowercase creating, ready, failed, or deleting.
    pub state: *mut c_char,
    /// Null unless the server reports a failure reason.
    pub error_reason: *mut c_char,
}

impl CCheckpointInfo {
    fn new(info: CheckpointInfo) -> BoxliteResult<Self> {
        let reason = info
            .error_reason
            .map(CString::new)
            .transpose()
            .map_err(|_| {
                BoxliteError::Internal("checkpoint failure reason contains a NUL byte".into())
            })?;
        let values = [
            info.id,
            info.name,
            info.source_box_id,
            info.created_at.to_rfc3339(),
            format!("{:?}", info.state).to_lowercase(),
        ];
        // Validate every string before transferring any allocation to raw C ownership.
        let mut strings = values
            .into_iter()
            .map(|value| {
                CString::new(value).map_err(|_| {
                    BoxliteError::Internal("checkpoint metadata contains a NUL byte".into())
                })
            })
            .collect::<BoxliteResult<Vec<_>>>()?
            .into_iter();
        Ok(Self {
            id: strings.next().unwrap().into_raw(),
            name: strings.next().unwrap().into_raw(),
            source_box_id: strings.next().unwrap().into_raw(),
            created_at: strings.next().unwrap().into_raw(),
            size_bytes: info.size_bytes,
            state: strings.next().unwrap().into_raw(),
            error_reason: reason.map_or(std::ptr::null_mut(), CString::into_raw),
        })
    }
}

impl Drop for CCheckpointInfo {
    fn drop(&mut self) {
        for value in [
            self.id,
            self.name,
            self.source_box_id,
            self.created_at,
            self.state,
            self.error_reason,
        ] {
            if !value.is_null() {
                unsafe {
                    drop(CString::from_raw(value));
                }
            }
        }
    }
}

/// Entries belong to this list; release once with boxlite_free_checkpoint_list.
#[repr(C)]
pub struct CCheckpointList {
    pub items: *mut CCheckpointInfo,
    pub count: c_int,
}

impl Drop for CCheckpointList {
    fn drop(&mut self) {
        unsafe {
            free_raw_slice(self.items, self.count);
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_checkpoint_info(info: *mut CCheckpointInfo) {
    if !info.is_null() {
        unsafe {
            drop(Box::from_raw(info));
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_checkpoint_list(list: *mut CCheckpointList) {
    if !list.is_null() {
        unsafe {
            drop(Box::from_raw(list));
        }
    }
}

macro_rules! input_or_return {
    ($input:expr, $out_error:expr) => {
        match $input {
            Ok(value) => value,
            Err(error) => {
                let code = error_to_code(&error);
                unsafe {
                    write_error($out_error, error);
                }
                return code;
            }
        }
    };
}

unsafe fn optional(value: *const c_char) -> BoxliteResult<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        unsafe { required(value).map(Some) }
    }
}

unsafe fn required(value: *const c_char) -> BoxliteResult<String> {
    if value.is_null() {
        return Err(null_pointer_error("checkpoint string"));
    }
    unsafe { crate::util::c_str_to_string(value) }
        .map_err(|error| BoxliteError::InvalidArgument(error.to_string()))
}

/// Queue capture; name may be null. Runtime, source and callback must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_create(
    runtime: *mut CBoxliteRuntime,
    source: *const c_char,
    name: *const c_char,
    cb: CCheckpointInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let source = input_or_return!(unsafe { required(source) }, out_error);
    let name = input_or_return!(unsafe { optional(name) }, out_error);
    let user_data = user_data as usize;
    unsafe {
        submit(runtime, out_error, move |runtime, _, _| async move {
            let result = runtime
                .checkpoints()
                .create(&source, name)
                .await
                .and_then(CCheckpointInfo::new)
                .map(|info| OwnedFfiPtr::new(Box::new(info)));
            RuntimeEvent::CheckpointInfo {
                cb,
                user_data,
                result,
            }
        })
    }
}

/// Queue metadata lookup by ID or name. All inputs except out_error are required.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_get(
    runtime: *mut CBoxliteRuntime,
    key: *const c_char,
    cb: CCheckpointInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let key = input_or_return!(unsafe { required(key) }, out_error);
    let user_data = user_data as usize;
    unsafe {
        submit(runtime, out_error, move |runtime, _, _| async move {
            let result = runtime
                .checkpoints()
                .get(&key)
                .await
                .and_then(CCheckpointInfo::new)
                .map(|info| OwnedFfiPtr::new(Box::new(info)));
            RuntimeEvent::CheckpointInfo {
                cb,
                user_data,
                result,
            }
        })
    }
}

/// Queue listing. Runtime and callback must be valid; user_data is opaque.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_list(
    runtime: *mut CBoxliteRuntime,
    cb: CCheckpointListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let user_data = user_data as usize;
    unsafe {
        submit(runtime, out_error, move |runtime, _, _| async move {
            let result = runtime.checkpoints().list().await.and_then(|infos| {
                let items = infos
                    .into_iter()
                    .map(CCheckpointInfo::new)
                    .collect::<BoxliteResult<Vec<_>>>()?;
                let (items, count) = into_raw_slice(items);
                Ok(OwnedFfiPtr::new(Box::new(CCheckpointList { items, count })))
            });
            RuntimeEvent::CheckpointList {
                cb,
                user_data,
                result,
            }
        })
    }
}

/// Queue deletion; force only ignores absence. Completion has no owned payload.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_remove(
    runtime: *mut CBoxliteRuntime,
    key: *const c_char,
    force: c_int,
    cb: CBoxRemoveBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let key = input_or_return!(unsafe { required(key) }, out_error);
    let user_data = user_data as usize;
    unsafe {
        submit(runtime, out_error, move |runtime, _, _| async move {
            let result = runtime.checkpoints().remove(&key, force != 0).await;
            RuntimeEvent::RemoveBox {
                cb,
                user_data,
                result,
            }
        })
    }
}

/// Queue checkpoint import. Name and box_id may be null but are mutually exclusive.
/// A non-null box_id replaces an idle target; the callback owns the Box handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_import_box(
    runtime: *mut CBoxliteRuntime,
    key: *const c_char,
    name: *const c_char,
    box_id: *const c_char,
    cb: CRuntimeImportCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let key = input_or_return!(unsafe { required(key) }, out_error);
    let name = input_or_return!(unsafe { optional(name) }, out_error);
    let box_id = input_or_return!(unsafe { optional(box_id) }, out_error);
    let user_data = user_data as usize;
    unsafe {
        submit(
            runtime,
            out_error,
            move |runtime, tokio_rt, queue| async move {
                let result = runtime
                    .checkpoints()
                    .import_box(&key, name, box_id.as_deref())
                    .await
                    .map(|handle| boxed_result(handle, tokio_rt, queue));
                RuntimeEvent::RuntimeImport {
                    cb,
                    user_data,
                    result,
                }
            },
        )
    }
}

fn boxed_result(
    handle: boxlite::LiteBox,
    tokio_rt: Arc<TokioRuntime>,
    queue: Arc<EventQueue>,
) -> OwnedFfiPtr<BoxHandle> {
    let box_id = handle.id().clone();
    OwnedFfiPtr::new(Box::new(BoxHandle {
        handle: Arc::new(handle),
        box_id,
        tokio_rt,
        queue,
    }))
}

unsafe fn submit<F>(
    runtime: *mut CBoxliteRuntime,
    out_error: *mut CBoxliteError,
    build: impl FnOnce(BoxliteRuntime, Arc<TokioRuntime>, Arc<EventQueue>) -> F + Send + 'static,
) -> BoxliteErrorCode
where
    F: Future<Output = RuntimeEvent> + Send + 'static,
{
    if runtime.is_null() {
        unsafe {
            write_error(out_error, null_pointer_error("runtime"));
        }
        return BoxliteErrorCode::InvalidArgument;
    }
    let runtime = unsafe { &*runtime };
    if let Err(error) = crate::util::ensure_runtime_live(&runtime.liveness, "manage checkpoints") {
        let code = error_to_code(&error);
        unsafe {
            write_error(out_error, error);
        }
        return code;
    }
    let core = runtime.runtime.clone();
    let task_runtime = runtime.tokio_rt.clone();
    let queue = runtime.queue.clone();
    runtime.tokio_rt.spawn(async move {
        let _guard = TokioRuntimeDropGuard::new(task_runtime.clone());
        let event = build(core, task_runtime, queue.clone()).await;
        push_event(&queue, event).await;
    });
    BoxliteErrorCode::Ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{RuntimeHandle, RuntimeLiveness, create_tokio_runtime};
    use std::ptr;
    use std::sync::mpsc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    extern "C" fn list_received(
        list: *mut CCheckpointList,
        error: *mut CBoxliteError,
        data: *mut c_void,
    ) {
        let sender =
            unsafe { &*(data as *const mpsc::Sender<(c_int, bool, std::thread::ThreadId)>) };
        let count = if list.is_null() {
            -1
        } else {
            unsafe { (*list).count }
        };
        let success = error.is_null() || unsafe { (*error).code == BoxliteErrorCode::Ok };
        let _ = sender.send((count, success, std::thread::current().id()));
        unsafe {
            boxlite_free_checkpoint_list(list);
        }
    }

    #[test]
    fn checkpoint_c_boundary_validates_runtime_callback_and_liveness() {
        let home = std::env::temp_dir().join(format!(
            "boxlite-checkpoint-c-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let core = BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
            home_dir: home.clone(),
            ..Default::default()
        })
        .unwrap();
        let mut runtime = RuntimeHandle {
            runtime: core,
            tokio_rt: create_tokio_runtime().unwrap(),
            liveness: Arc::new(RuntimeLiveness::new()),
            queue: Arc::new(EventQueue::new()),
        };
        let mut error = crate::error::FFIError::default();
        unsafe {
            assert_eq!(
                boxlite_checkpoint_list(
                    ptr::null_mut(),
                    Some(list_received),
                    ptr::null_mut(),
                    &mut error
                ),
                BoxliteErrorCode::InvalidArgument
            );
            crate::boxlite_error_free(&mut error);
            assert_eq!(
                boxlite_checkpoint_list(&mut runtime, None, ptr::null_mut(), &mut error),
                BoxliteErrorCode::InvalidArgument
            );
            crate::boxlite_error_free(&mut error);
            let (sender, receiver) = mpsc::channel::<(c_int, bool, std::thread::ThreadId)>();
            let data = &sender as *const _ as *mut c_void;
            assert_eq!(
                boxlite_checkpoint_list(&mut runtime, Some(list_received), data, &mut error),
                BoxliteErrorCode::Ok
            );
            assert!(
                receiver.try_recv().is_err(),
                "callbacks run only when the caller drains"
            );
            crate::boxlite_runtime_drain(&mut runtime, 5000, &mut error);
            let (count, success, thread) = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
            assert_eq!(count, 0);
            assert!(success);
            assert_eq!(thread, std::thread::current().id());
            runtime.liveness.mark_closed();
            assert_eq!(
                boxlite_checkpoint_list(&mut runtime, Some(list_received), data, &mut error),
                BoxliteErrorCode::Stopped
            );
            crate::boxlite_error_free(&mut error);
        }
        drop(runtime);
        std::fs::remove_dir_all(home).unwrap();
    }

    extern "C" fn metadata_received(
        info: *mut CCheckpointInfo,
        _: *mut CBoxliteError,
        data: *mut c_void,
    ) {
        let sender = unsafe { &*(data as *const mpsc::Sender<()>) };
        let _ = sender.send(());
        unsafe { boxlite_free_checkpoint_info(info) };
    }

    #[test]
    fn checkpoint_c_boundary_refuses_null_and_non_utf8_strings_before_queueing() {
        let home = std::env::temp_dir().join(format!(
            "boxlite-checkpoint-c-strings-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut runtime = RuntimeHandle {
            runtime: BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
                home_dir: home.clone(),
                ..Default::default()
            })
            .unwrap(),
            tokio_rt: create_tokio_runtime().unwrap(),
            liveness: Arc::new(RuntimeLiveness::new()),
            queue: Arc::new(EventQueue::new()),
        };
        let (sender, receiver) = mpsc::channel::<()>();
        let data = &sender as *const _ as *mut c_void;
        let mut error = crate::error::FFIError::default();
        let invalid = [255u8, 0];
        for source in [ptr::null(), invalid.as_ptr().cast()] {
            unsafe {
                assert_eq!(
                    boxlite_checkpoint_create(
                        &mut runtime,
                        source,
                        ptr::null(),
                        Some(metadata_received),
                        data,
                        &mut error
                    ),
                    BoxliteErrorCode::InvalidArgument
                );
                crate::boxlite_error_free(&mut error);
                assert_eq!(
                    boxlite_checkpoint_get(
                        &mut runtime,
                        source,
                        Some(metadata_received),
                        data,
                        &mut error
                    ),
                    BoxliteErrorCode::InvalidArgument
                );
                crate::boxlite_error_free(&mut error);
            }
        }
        unsafe {
            assert_eq!(crate::boxlite_runtime_drain(&mut runtime, 0, &mut error), 0);
        }
        assert!(
            receiver.try_recv().is_err(),
            "invalid input queued a callback"
        );
        drop(runtime);
        std::fs::remove_dir_all(home).unwrap();
    }

    type Reply = (BoxliteErrorCode, String);

    fn reply_code(error: *mut CBoxliteError) -> BoxliteErrorCode {
        if error.is_null() {
            BoxliteErrorCode::Ok
        } else {
            unsafe { (*error).code }
        }
    }

    fn send_reply(data: *mut c_void, error: *mut CBoxliteError, value: String) {
        let sender = unsafe { &*(data as *const mpsc::Sender<Reply>) };
        let _ = sender.send((reply_code(error), value));
    }

    extern "C" fn checkpoint_metadata_reply(
        info: *mut CCheckpointInfo,
        error: *mut CBoxliteError,
        data: *mut c_void,
    ) {
        let value = if info.is_null() {
            String::new()
        } else {
            unsafe {
                let reason = if (*info).error_reason.is_null() {
                    String::new()
                } else {
                    std::ffi::CStr::from_ptr((*info).error_reason)
                        .to_string_lossy()
                        .into_owned()
                };
                format!(
                    "{}:{}:{reason}",
                    std::ffi::CStr::from_ptr((*info).id).to_string_lossy(),
                    std::ffi::CStr::from_ptr((*info).state).to_string_lossy(),
                )
            }
        };
        unsafe { boxlite_free_checkpoint_info(info) };
        send_reply(data, error, value);
    }

    extern "C" fn checkpoint_list_reply(
        list: *mut CCheckpointList,
        error: *mut CBoxliteError,
        data: *mut c_void,
    ) {
        let value = if list.is_null() {
            String::new()
        } else {
            unsafe { (*list).count.to_string() }
        };
        unsafe { boxlite_free_checkpoint_list(list) };
        send_reply(data, error, value);
    }

    extern "C" fn checkpoint_box_reply(
        handle: *mut crate::CBoxHandle,
        error: *mut CBoxliteError,
        data: *mut c_void,
    ) {
        let value = if handle.is_null() {
            String::new()
        } else {
            let name = unsafe { crate::box_handle::boxlite_box_name(handle) };
            let name_value = if name.is_null() {
                "<unnamed>".into()
            } else {
                unsafe { std::ffi::CStr::from_ptr(name) }
                    .to_string_lossy()
                    .into_owned()
            };
            unsafe { crate::boxlite_free_string(name) };
            format!("{}:{name_value}", unsafe { &(*handle).box_id })
        };
        unsafe { crate::box_handle::boxlite_box_free(handle) };
        send_reply(data, error, value);
    }

    extern "C" fn checkpoint_remove_reply(error: *mut CBoxliteError, data: *mut c_void) {
        send_reply(data, error, String::new());
    }

    #[test]
    fn checkpoint_c_rest_management_delivers_owned_results_and_errors_through_drain() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;
        use std::time::Instant;

        let _strings = crate::FREE_STR_LOCK.lock().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::scope(|scope| {
            let server = scope.spawn(move || {
                let mut requests = Vec::new();
                while requests.len() < 8 {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    let (mut stream, _) = loop {
                        match listener.accept() {
                            Ok(connection) => break connection,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(Instant::now() < deadline, "C checkpoint HTTP request timed out");
                                std::thread::sleep(Duration::from_millis(1));
                            }
                            Err(error) => panic!("C checkpoint HTTP server: {error}"),
                        }
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
                    let mut reader = BufReader::new(&mut stream);
                    let mut first = String::new();
                    reader.read_line(&mut first).unwrap();
                    let mut length = 0;
                    loop {
                        let mut line = String::new();
                        assert_ne!(reader.read_line(&mut line).unwrap(), 0, "incomplete HTTP request");
                        if line == "\r\n" { break; }
                        if let Some((key, value)) = line.split_once(':')
                            && key.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse::<usize>().unwrap();
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    drop(reader);
                    let mut request = first.split_whitespace();
                    let method = request.next().unwrap().to_owned();
                    let path = request.next().unwrap().to_owned();
                    let body = if body.is_empty() { serde_json::Value::Null } else { serde_json::from_slice(&body).unwrap() };
                    let info = serde_json::json!({"id":"checkpoint-1","name":"base","source_box_id":"source-1","created_at":"2026-11-06T00:00:00Z","size_bytes":4096,"state":"ready"});
                    let (status, response) = if path.ends_with("/missing") {
                        (404, serde_json::json!({"message":"Checkpoint not found"}))
                    } else if path == "/v1/boxes/import" {
                        (200, serde_json::json!({"box_id":"target-1","name":"worker","status":"stopped","created_at":"2026-11-06T00:00:00Z","updated_at":"2026-11-06T00:00:00Z","image":"alpine:latest","cpus":2,"memory_mib":512}))
                    } else if method == "GET" && path == "/v1/checkpoints" {
                        (200, serde_json::json!({"checkpoints":[info]}))
                    } else if method == "GET" {
                        let mut failed = info;
                        failed["state"] = "failed".into();
                        failed["error_reason"] = "upload failed".into();
                        (200, failed)
                    } else { (200, info) };
                    let response = response.to_string();
                    write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
                    requests.push((method, path, body));
                }
                requests
            });
            let mut runtime = RuntimeHandle {
                runtime: BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(format!(
                    "http://{address}"
                )))
                .unwrap(),
                tokio_rt: create_tokio_runtime().unwrap(),
                liveness: Arc::new(RuntimeLiveness::new()),
                queue: Arc::new(EventQueue::new()),
            };
            let (sender, receiver) = mpsc::channel::<Reply>();
            let data = &sender as *const _ as *mut c_void;
            let mut error = crate::error::FFIError::default();
            let source = CString::new("source-1").unwrap();
            let key = CString::new("checkpoint-1").unwrap();
            let name = CString::new("worker").unwrap();
            let target = CString::new("target-1").unwrap();
            let mut drain = |runtime: &mut RuntimeHandle| {
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    unsafe { crate::boxlite_runtime_drain(runtime, 50, &mut error) };
                    if let Ok(reply) = receiver.try_recv() {
                        break reply;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "checkpoint callback was not delivered"
                    );
                }
            };
            unsafe {
                for supplied_name in [name.as_ptr(), ptr::null()] {
                    assert_eq!(
                        boxlite_checkpoint_create(
                            &mut runtime,
                            source.as_ptr(),
                            supplied_name,
                            Some(checkpoint_metadata_reply),
                            data,
                            ptr::null_mut()
                        ),
                        BoxliteErrorCode::Ok
                    );
                    assert_eq!(
                        drain(&mut runtime),
                        (BoxliteErrorCode::Ok, "checkpoint-1:ready:".into())
                    );
                }
                assert_eq!(
                    boxlite_checkpoint_get(
                        &mut runtime,
                        key.as_ptr(),
                        Some(checkpoint_metadata_reply),
                        data,
                        ptr::null_mut()
                    ),
                    BoxliteErrorCode::Ok
                );
                assert_eq!(
                    drain(&mut runtime),
                    (
                        BoxliteErrorCode::Ok,
                        "checkpoint-1:failed:upload failed".into()
                    )
                );
                assert_eq!(
                    boxlite_checkpoint_list(
                        &mut runtime,
                        Some(checkpoint_list_reply),
                        data,
                        ptr::null_mut()
                    ),
                    BoxliteErrorCode::Ok
                );
                assert_eq!(drain(&mut runtime), (BoxliteErrorCode::Ok, "1".into()));
                for (name, target) in [(name.as_ptr(), ptr::null()), (ptr::null(), target.as_ptr())]
                {
                    assert_eq!(
                        boxlite_checkpoint_import_box(
                            &mut runtime,
                            key.as_ptr(),
                            name,
                            target,
                            Some(checkpoint_box_reply),
                            data,
                            ptr::null_mut()
                        ),
                        BoxliteErrorCode::Ok
                    );
                    assert_eq!(
                        drain(&mut runtime),
                        (BoxliteErrorCode::Ok, "target-1:worker".into())
                    );
                }
                assert_eq!(
                    boxlite_checkpoint_remove(
                        &mut runtime,
                        key.as_ptr(),
                        1,
                        Some(checkpoint_remove_reply),
                        data,
                        ptr::null_mut()
                    ),
                    BoxliteErrorCode::Ok
                );
                assert_eq!(drain(&mut runtime), (BoxliteErrorCode::Ok, String::new()));
                let missing = CString::new("missing").unwrap();
                assert_eq!(
                    boxlite_checkpoint_get(
                        &mut runtime,
                        missing.as_ptr(),
                        Some(checkpoint_metadata_reply),
                        data,
                        ptr::null_mut()
                    ),
                    BoxliteErrorCode::Ok
                );
                assert_eq!(
                    drain(&mut runtime),
                    (BoxliteErrorCode::NotFound, String::new())
                );
            }
            let requests = server.join().unwrap();
            assert_eq!(
                requests[0].2,
                serde_json::json!({"source_box_id":"source-1","name":"worker"})
            );
            assert_eq!(
                requests[1].2,
                serde_json::json!({"source_box_id":"source-1"})
            );
            assert_eq!(requests[4].1, "/v1/boxes/import");
            assert_eq!(
                requests[4].2,
                serde_json::json!({"checkpoint_id":"checkpoint-1","name":"worker"})
            );
            assert_eq!(
                requests[5].2,
                serde_json::json!({"checkpoint_id":"checkpoint-1","box_id":"target-1"})
            );
            assert_eq!(requests[6].1, "/v1/checkpoints/checkpoint-1?force=true");
        });
    }
}
