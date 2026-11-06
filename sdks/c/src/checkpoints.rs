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
}

impl CCheckpointInfo {
    fn new(info: CheckpointInfo) -> BoxliteResult<Self> {
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

/// Queue creation with inherited settings. Name may be null; callback owns Box.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_create_box(
    runtime: *mut CBoxliteRuntime,
    key: *const c_char,
    name: *const c_char,
    cb: CRuntimeImportCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let key = input_or_return!(unsafe { required(key) }, out_error);
    let name = input_or_return!(unsafe { optional(name) }, out_error);
    let user_data = user_data as usize;
    unsafe {
        submit(
            runtime,
            out_error,
            move |runtime, tokio_rt, queue| async move {
                let result = runtime
                    .checkpoints()
                    .create_box(&key, name)
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

/// Queue recovery. Target must be idle; local result has a new native ID.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_recover_box(
    runtime: *mut CBoxliteRuntime,
    key: *const c_char,
    target: *const c_char,
    cb: CRuntimeImportCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let key = input_or_return!(unsafe { required(key) }, out_error);
    let target = input_or_return!(unsafe { required(target) }, out_error);
    let user_data = user_data as usize;
    unsafe {
        submit(
            runtime,
            out_error,
            move |runtime, tokio_rt, queue| async move {
                let result = runtime
                    .checkpoints()
                    .recover_box(&key, &target)
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
        _: *mut CCheckpointInfo,
        _: *mut CBoxliteError,
        _: *mut c_void,
    ) {
    }

    #[test]
    fn checkpoint_c_boundary_refuses_null_and_non_utf8_strings_before_queueing() {
        let mut error = crate::error::FFIError::default();
        let invalid = [255u8, 0];
        for source in [ptr::null(), invalid.as_ptr().cast()] {
            unsafe {
                assert_eq!(
                    boxlite_checkpoint_create(
                        ptr::null_mut(),
                        source,
                        ptr::null(),
                        Some(metadata_received),
                        ptr::null_mut(),
                        &mut error
                    ),
                    BoxliteErrorCode::InvalidArgument
                );
                crate::boxlite_error_free(&mut error);
                assert_eq!(
                    boxlite_checkpoint_get(
                        ptr::null_mut(),
                        source,
                        Some(metadata_received),
                        ptr::null_mut(),
                        &mut error
                    ),
                    BoxliteErrorCode::InvalidArgument
                );
                crate::boxlite_error_free(&mut error);
            }
        }
    }
}
