//! Named checkpoints through the runtime's post-and-drain callback queue.

use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxCheckpointInfoCb, CBoxCheckpointListCb, CBoxCheckpointOpCb, CBoxCreateBoxCb, EventQueue,
    OwnedFfiPtr, RuntimeEvent, push_event,
};
use crate::runtime::RuntimeLiveness;
use crate::util::{alloc_c_string, ensure_runtime_live, free_c_string};
use crate::{CBoxHandle, CBoxliteCheckpointHandle, CBoxliteError, CBoxliteRuntime};
use boxlite::RuntimeCheckpointHandle;
use boxlite::{BoxliteError, BoxliteResult, CheckpointInfo, LiteBox};
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;
use tokio::runtime::Runtime as TokioRuntime;

#[derive(Clone)]
enum CheckpointScope {
    Box(Arc<LiteBox>),
    Runtime(RuntimeCheckpointHandle),
}

/// Opaque checkpoint capability. Capture requires a box-scoped handle;
/// list/get/remove use the scope chosen by the accessor.
pub struct CheckpointHandle {
    scope: CheckpointScope,
    tokio_rt: Arc<TokioRuntime>,
    liveness: Arc<RuntimeLiveness>,
    queue: Arc<EventQueue>,
}

/// Checkpoint metadata. Strings are owned by this value; error may be null.
/// created_at is Unix seconds; disk sizes are bytes.
#[repr(C)]
pub struct CCheckpointInfo {
    pub id: *mut c_char,
    pub box_id: *mut c_char,
    pub name: *mut c_char,
    pub status: *mut c_char,
    pub error: *mut c_char,
    pub created_at: i64,
    pub cpus: u16,
    pub memory_bytes: u64,
    pub container_disk_bytes: u64,
    pub size_bytes: u64,
}

#[repr(C)]
pub struct CCheckpointInfoList {
    pub items: *mut CCheckpointInfo,
    pub count: usize,
}

impl From<CheckpointInfo> for CCheckpointInfo {
    fn from(info: CheckpointInfo) -> Self {
        Self {
            id: alloc_c_string(&info.id),
            box_id: alloc_c_string(&info.box_id),
            name: alloc_c_string(&info.name),
            status: alloc_c_string(&info.status),
            error: info
                .error
                .as_deref()
                .map(alloc_c_string)
                .unwrap_or(ptr::null_mut()),
            created_at: info.created_at,
            cpus: info.cpus,
            memory_bytes: info.memory_bytes,
            container_disk_bytes: info.container_disk_bytes,
            size_bytes: info.size_bytes,
        }
    }
}

unsafe fn free_fields(info: &mut CCheckpointInfo) {
    for field in [info.id, info.box_id, info.name, info.status, info.error] {
        free_c_string(field);
    }
}

pub(crate) unsafe fn free_info(info: *mut CCheckpointInfo) {
    if !info.is_null() {
        let mut info = Box::from_raw(info);
        free_fields(&mut info);
    }
}

pub(crate) unsafe fn free_list(list: *mut CCheckpointInfoList) {
    if list.is_null() {
        return;
    }
    let list = Box::from_raw(list);
    let mut items = Box::from_raw(ptr::slice_from_raw_parts_mut(list.items, list.count));
    for info in &mut items {
        free_fields(info);
    }
}

/// Release metadata returned by create/get. Null is accepted.
/// # Safety
/// info must be null or an unmodified, owned result not previously freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_checkpoint_info(info: *mut CCheckpointInfo) {
    free_info(info);
}

/// Release an entire checkpoint list. Entries must not be freed individually.
/// # Safety
/// list must be null or an unmodified, owned result not previously freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_checkpoint_info_list(list: *mut CCheckpointInfoList) {
    free_list(list);
}

fn fail(out_error: *mut CBoxliteError, error: BoxliteError) -> BoxliteErrorCode {
    let code = error_to_code(&error);
    unsafe {
        write_error(out_error, error);
    }
    code
}

macro_rules! checkpoint_try {
    ($value:expr, $out:expr) => {
        match $value {
            Ok(value) => value,
            Err(error) => return fail($out, error),
        }
    };
}

unsafe fn checked_handle<'a>(
    handle: *mut CBoxliteCheckpointHandle,
) -> BoxliteResult<&'a CheckpointHandle> {
    let handle = handle
        .as_ref()
        .ok_or_else(|| null_pointer_error("handle"))?;
    ensure_runtime_live(&handle.liveness, "operate on checkpoints")?;
    Ok(handle)
}

unsafe fn required_name(name: *const c_char) -> BoxliteResult<String> {
    if name.is_null() {
        return Err(null_pointer_error("checkpoint"));
    }
    std::ffi::CStr::from_ptr(name)
        .to_str()
        .map(str::to_owned)
        .map_err(|_| BoxliteError::InvalidArgument("Checkpoint name must be UTF-8".into()))
}

/// Obtain the runtime checkpoint catalog. Does not contact a remote server.
/// # Safety
/// runtime/out_handle must be valid and non-null; out_error may be null.
/// The caller owns the handle and must call boxlite_checkpoint_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_checkpoints(
    runtime: *mut CBoxliteRuntime,
    out_handle: *mut *mut CBoxliteCheckpointHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if out_handle.is_null() {
        return fail(out_error, null_pointer_error("out_handle"));
    }
    *out_handle = ptr::null_mut();
    let runtime = checkpoint_try!(
        runtime
            .as_ref()
            .ok_or_else(|| null_pointer_error("runtime")),
        out_error
    );
    checkpoint_try!(
        ensure_runtime_live(&runtime.liveness, "access checkpoints"),
        out_error
    );
    let handle = checkpoint_try!(runtime.runtime.checkpoints(), out_error);
    *out_handle = Box::into_raw(Box::new(CheckpointHandle {
        scope: CheckpointScope::Runtime(handle),
        tokio_rt: runtime.tokio_rt.clone(),
        liveness: runtime.liveness.clone(),
        queue: runtime.queue.clone(),
    }));
    BoxliteErrorCode::Ok
}

/// Obtain checkpoints captured from one box. Restores always create a new box.
/// # Safety
/// box_handle/out_handle must be valid and non-null; out_error may be null.
/// The returned handle owns a reference to the box and must be freed separately.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_checkpoints(
    box_handle: *mut CBoxHandle,
    out_handle: *mut *mut CBoxliteCheckpointHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if out_handle.is_null() {
        return fail(out_error, null_pointer_error("out_handle"));
    }
    *out_handle = ptr::null_mut();
    let bx = checkpoint_try!(
        box_handle
            .as_ref()
            .ok_or_else(|| null_pointer_error("box_handle")),
        out_error
    );
    checkpoint_try!(
        ensure_runtime_live(&bx.liveness, "access checkpoints"),
        out_error
    );
    *out_handle = Box::into_raw(Box::new(CheckpointHandle {
        scope: CheckpointScope::Box(bx.handle.clone()),
        tokio_rt: bx.tokio_rt.clone(),
        liveness: bx.liveness.clone(),
        queue: bx.queue.clone(),
    }));
    BoxliteErrorCode::Ok
}

/// Release a checkpoint handle; queued calls keep their own references.
/// # Safety
/// handle must be null or a live handle not previously freed. No concurrent access.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_free(handle: *mut CBoxliteCheckpointHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

/// Capture a Paused box, waiting for a ready checkpoint. Null name generates one.
/// # Safety
/// handle/cb must be valid and non-null; name is null or valid UTF-8 and is copied.
/// Callback fires only on runtime_drain. Its metadata must be freed by the caller.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_create(
    handle: *mut CBoxliteCheckpointHandle,
    name: *const c_char,
    cb: CBoxCheckpointInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let handle = checkpoint_try!(checked_handle(handle), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let name = if name.is_null() {
        None
    } else {
        Some(checkpoint_try!(required_name(name), out_error))
    };
    let CheckpointScope::Box(bx) = &handle.scope else {
        return fail(
            out_error,
            BoxliteError::Unsupported("Capture requires a box checkpoint handle".into()),
        );
    };
    let bx = bx.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = bx
            .checkpoints()
            .create(name)
            .await
            .map(|info| Some(OwnedFfiPtr::new_with(Box::new(info.into()), free_info)));
        push_event(
            &queue,
            RuntimeEvent::CheckpointInfo {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// List checkpoints in this handle's scope. The callback owns the whole list.
/// # Safety
/// handle/cb must be valid and non-null; user_data must survive callback dispatch.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_list(
    handle: *mut CBoxliteCheckpointHandle,
    cb: CBoxCheckpointListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let handle = checkpoint_try!(checked_handle(handle), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let scope = handle.scope.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = match scope {
            CheckpointScope::Box(bx) => bx.checkpoints().list().await,
            CheckpointScope::Runtime(catalog) => catalog.list().await,
        }
        .map(|infos| {
            let items: Box<[_]> = infos.into_iter().map(CCheckpointInfo::from).collect();
            let count = items.len();
            let items = Box::into_raw(items) as *mut CCheckpointInfo;
            OwnedFfiPtr::new_with(Box::new(CCheckpointInfoList { items, count }), free_list)
        });
        push_event(
            &queue,
            RuntimeEvent::CheckpointList {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Get metadata by scoped ID/name. A missing box-scoped checkpoint
/// returns null without error; organization lookups return NotFound.
/// # Safety
/// handle/checkpoint/cb must be valid and non-null. checkpoint is copied before return.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_get(
    handle: *mut CBoxliteCheckpointHandle,
    checkpoint: *const c_char,
    cb: CBoxCheckpointInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let handle = checkpoint_try!(checked_handle(handle), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let checkpoint = checkpoint_try!(required_name(checkpoint), out_error);
    let scope = handle.scope.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = match scope {
            CheckpointScope::Box(bx) => bx.checkpoints().get(&checkpoint).await,
            CheckpointScope::Runtime(catalog) => catalog.get(&checkpoint).await.map(Some),
        }
        .map(|info| info.map(|info| OwnedFfiPtr::new_with(Box::new(info.into()), free_info)));
        push_event(
            &queue,
            RuntimeEvent::CheckpointInfo {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Delete a checkpoint. Nonzero force ignores absence, not permission or busy errors.
/// # Safety
/// handle/checkpoint/cb must be valid and non-null. Strings are copied before return.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_checkpoint_remove(
    handle: *mut CBoxliteCheckpointHandle,
    checkpoint: *const c_char,
    force: c_int,
    cb: CBoxCheckpointOpCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let handle = checkpoint_try!(checked_handle(handle), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let checkpoint = checkpoint_try!(required_name(checkpoint), out_error);
    let scope = handle.scope.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = match scope {
            CheckpointScope::Box(bx) => bx.checkpoints().remove(&checkpoint, force != 0).await,
            CheckpointScope::Runtime(catalog) => catalog.remove(&checkpoint, force != 0).await,
        };
        push_event(
            &queue,
            RuntimeEvent::CheckpointOp {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

unsafe fn checked_runtime<'a>(runtime: *mut CBoxliteRuntime) -> BoxliteResult<&'a CBoxliteRuntime> {
    let runtime = runtime
        .as_ref()
        .ok_or_else(|| null_pointer_error("runtime"))?;
    ensure_runtime_live(&runtime.liveness, "operate on checkpoints")?;
    Ok(runtime)
}

unsafe fn optional_name(name: *const c_char) -> BoxliteResult<Option<String>> {
    if name.is_null() {
        Ok(None)
    } else {
        required_name(name).map(Some)
    }
}

/// Pause a running box. Nonzero host_writers_stopped asserts external writers are stopped.
/// Completion is dispatched once by boxlite_runtime_drain; immediate errors do not call cb.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_pause(
    handle: *mut CBoxHandle,
    host_writers_stopped: c_int,
    cb: CBoxCheckpointOpCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    submit_box_operation(
        handle,
        BoxOperation::Pause(host_writers_stopped != 0),
        cb,
        user_data,
        out_error,
    )
}

/// Resume a Paused box explicitly; never substitutes a cold start.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_resume(
    handle: *mut CBoxHandle,
    cb: CBoxCheckpointOpCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    submit_box_operation(handle, BoxOperation::Resume, cb, user_data, out_error)
}

/// Export the public two-file checkpoint to a caller-owned directory.
/// The directory must remain available until native completion, even after cancellation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_export_checkpoint(
    handle: *mut CBoxHandle,
    path: *const c_char,
    cb: CBoxCheckpointOpCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let path = checkpoint_try!(required_name(path), out_error);
    submit_box_operation(handle, BoxOperation::Export(path), cb, user_data, out_error)
}

enum BoxOperation {
    Pause(bool),
    Resume,
    Export(String),
}
unsafe fn submit_box_operation(
    handle: *mut CBoxHandle,
    operation: BoxOperation,
    cb: CBoxCheckpointOpCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let handle = checkpoint_try!(
        handle.as_ref().ok_or_else(|| null_pointer_error("handle")),
        out_error
    );
    checkpoint_try!(
        ensure_runtime_live(&handle.liveness, "operate on checkpoints"),
        out_error
    );
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let bx = handle.handle.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = match operation {
            BoxOperation::Pause(host_writers_stopped) => {
                bx.pause(boxlite::PauseOptions {
                    host_writers_stopped,
                })
                .await
            }
            BoxOperation::Resume => bx.resume().await,
            BoxOperation::Export(path) => bx.export_checkpoint(path).await,
        };
        push_event(
            &queue,
            RuntimeEvent::CheckpointOp {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Import a caller-owned public pair directory into a new Paused box.
/// A null name leaves the target unnamed. The source must outlive native completion.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_import_checkpoint(
    runtime: *mut CBoxliteRuntime,
    path: *const c_char,
    name: *const c_char,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let path = checkpoint_try!(required_name(path), out_error);
    let name = checkpoint_try!(optional_name(name), out_error);
    submit_create(
        runtime,
        CreateOperation::Pair(path, name),
        cb,
        user_data,
        out_error,
    )
}

/// Create a new Paused box from a managed checkpoint; captured resources are retained.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_create_box_from_checkpoint(
    runtime: *mut CBoxliteRuntime,
    checkpoint: *const c_char,
    name: *const c_char,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let id = checkpoint_try!(required_name(checkpoint), out_error);
    let name = checkpoint_try!(optional_name(name), out_error);
    submit_create(
        runtime,
        CreateOperation::Managed(id, name, None),
        cb,
        user_data,
        out_error,
    )
}

/// Runner-only cloud restore with durable operation identity and cloud configuration validation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_create_box_from_checkpoint_with_operation(
    runtime: *mut CBoxliteRuntime,
    checkpoint: *const c_char,
    name: *const c_char,
    operation_id: *const c_char,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let id = checkpoint_try!(required_name(checkpoint), out_error);
    let name = checkpoint_try!(optional_name(name), out_error);
    let operation = checkpoint_try!(required_name(operation_id), out_error);
    submit_create(
        runtime,
        CreateOperation::Managed(id, name, Some(operation)),
        cb,
        user_data,
        out_error,
    )
}

enum CreateOperation {
    Pair(String, Option<String>),
    Managed(String, Option<String>, Option<String>),
}
unsafe fn submit_create(
    runtime: *mut CBoxliteRuntime,
    operation: CreateOperation,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let runtime = checkpoint_try!(checked_runtime(runtime), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let core = runtime.runtime.clone();
    let queue = runtime.queue.clone();
    let tokio_rt = runtime.tokio_rt.clone();
    let liveness = runtime.liveness.clone();
    let user_data = user_data as usize;
    runtime.tokio_rt.spawn(async move {
        let _guard = crate::archive::TokioRuntimeDropGuard::new(tokio_rt.clone());
        let result = match operation {
            CreateOperation::Pair(path, name) => {
                core.import_checkpoint(path, boxlite::CheckpointImportOptions { name })
                    .await
            }
            CreateOperation::Managed(id, name, Some(operation)) => {
                core.create_from_checkpoint_with_operation(&id, name, &operation)
                    .await
            }
            CreateOperation::Managed(id, name, None) => {
                core.create_from_checkpoint(&id, name).await
            }
        }
        .map(|handle| {
            OwnedFfiPtr::new(Box::new(crate::box_handle::BoxHandle {
                box_id: handle.id().clone(),
                handle: Arc::new(handle),
                tokio_rt,
                queue: queue.clone(),
                liveness,
            }))
        });
        push_event(
            &queue,
            RuntimeEvent::CreateBox {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Inspect a caller-local public pair, preserving the full dependency schema as owned JSON.
/// Free a successful out_json with boxlite_free_string. No runtime or VM is created.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_inspect_checkpoint(
    path: *const c_char,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    inspect_json(path, out_json, out_error, false)
}

/// Runner-only complete pair validation and allowlisted admission summary as owned JSON.
/// Saved host paths are never opened. Free successful out_json with boxlite_free_string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_inspect_cloud_upload(
    path: *const c_char,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    inspect_json(path, out_json, out_error, true)
}

unsafe fn inspect_json(
    path: *const c_char,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
    cloud: bool,
) -> BoxliteErrorCode {
    if out_json.is_null() {
        return fail(out_error, null_pointer_error("out_json"));
    }
    *out_json = ptr::null_mut();
    let path = checkpoint_try!(required_name(path), out_error);
    let value = if cloud {
        boxlite::BoxliteRuntime::inspect_cloud_upload(path).and_then(|v| {
            serde_json::to_string(&v).map_err(|e| BoxliteError::Internal(e.to_string()))
        })
    } else {
        boxlite::BoxliteRuntime::inspect_checkpoint(path).and_then(|v| {
            serde_json::to_string(&v).map_err(|e| BoxliteError::Internal(e.to_string()))
        })
    };
    *out_json = alloc_c_string(&checkpoint_try!(value, out_error));
    BoxliteErrorCode::Ok
}

/// Runner-only archive transport. Export never removes the managed resource.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_export_checkpoint_archive(
    runtime: *mut CBoxliteRuntime,
    checkpoint: *const c_char,
    path: *const c_char,
    cb: CBoxCheckpointOpCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let runtime = checkpoint_try!(checked_runtime(runtime), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let id = checkpoint_try!(required_name(checkpoint), out_error);
    let path = checkpoint_try!(required_name(path), out_error);
    let core = runtime.runtime.clone();
    let queue = runtime.queue.clone();
    let tokio_rt = runtime.tokio_rt.clone();
    let user_data = user_data as usize;
    runtime.tokio_rt.spawn(async move {
        let _guard = crate::archive::TokioRuntimeDropGuard::new(tokio_rt);
        let result = core.export_checkpoint_archive(&id, path).await;
        push_event(
            &queue,
            RuntimeEvent::CheckpointOp {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Runner-only managed archive registration with a canonical operation UUID.
/// Source files remain caller-owned until native completion.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_import_checkpoint_archive(
    runtime: *mut CBoxliteRuntime,
    path: *const c_char,
    operation_id: *const c_char,
    cb: CBoxCheckpointInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let path = checkpoint_try!(required_name(path), out_error);
    let operation = checkpoint_try!(required_name(operation_id), out_error);
    submit_registration(
        runtime,
        Registration::Archive(path, operation),
        cb,
        user_data,
        out_error,
    )
}

/// Runner-only public-pair registration. options_json is CloudCheckpointImportOptions;
/// trusted_boot is a trusted runner file, never a client-supplied host path.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_import_checkpoint_pair(
    runtime: *mut CBoxliteRuntime,
    path: *const c_char,
    options_json: *const c_char,
    cb: CBoxCheckpointInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let path = checkpoint_try!(required_name(path), out_error);
    let options = checkpoint_try!(required_name(options_json), out_error);
    let options = checkpoint_try!(
        serde_json::from_str(&options).map_err(|e| BoxliteError::InvalidArgument(format!(
            "Invalid cloud checkpoint options: {e}"
        ))),
        out_error
    );
    submit_registration(
        runtime,
        Registration::Pair(path, options),
        cb,
        user_data,
        out_error,
    )
}

enum Registration {
    Archive(String, String),
    Pair(String, boxlite::CloudCheckpointImportOptions),
}
unsafe fn submit_registration(
    runtime: *mut CBoxliteRuntime,
    registration: Registration,
    cb: CBoxCheckpointInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let runtime = checkpoint_try!(checked_runtime(runtime), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let core = runtime.runtime.clone();
    let queue = runtime.queue.clone();
    let tokio_rt = runtime.tokio_rt.clone();
    let user_data = user_data as usize;
    runtime.tokio_rt.spawn(async move {
        let _guard = crate::archive::TokioRuntimeDropGuard::new(tokio_rt);
        let result = match registration {
            Registration::Archive(path, operation) => {
                core.import_checkpoint_archive(path, &operation).await
            }
            Registration::Pair(path, options) => core.import_checkpoint_pair(path, options).await,
        }
        .map(|info| Some(OwnedFfiPtr::new_with(Box::new(info.into()), free_info)));
        push_event(
            &queue,
            RuntimeEvent::CheckpointInfo {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}
