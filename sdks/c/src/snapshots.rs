//! Named snapshots through the runtime's post-and-drain callback queue.

use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxCreateBoxCb, CBoxSnapshotInfoCb, CBoxSnapshotListCb, CBoxSnapshotOpCb, EventQueue,
    OwnedFfiPtr, RuntimeEvent, push_event,
};
use crate::runtime::RuntimeLiveness;
use crate::util::{alloc_c_string, ensure_runtime_live, free_c_string};
use crate::{CBoxHandle, CBoxliteError, CBoxliteOptions, CBoxliteRuntime, CBoxliteSnapshotHandle};
use boxlite::runtime::RuntimeSnapshotHandle;
use boxlite::{BoxliteError, BoxliteResult, LiteBox, SnapshotInfo, SnapshotOptions};
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;
use tokio::runtime::Runtime as TokioRuntime;

#[derive(Clone)]
enum SnapshotScope {
    Box(Arc<LiteBox>),
    Organization(RuntimeSnapshotHandle),
}

/// Opaque snapshot capability. Create/restore require a box-scoped handle;
/// list/get/remove use the scope chosen by the accessor.
pub struct SnapshotHandle {
    scope: SnapshotScope,
    tokio_rt: Arc<TokioRuntime>,
    liveness: Arc<RuntimeLiveness>,
    queue: Arc<EventQueue>,
}

/// Snapshot metadata. Strings are owned by this value; error may be null.
/// created_at is Unix seconds; disk sizes are bytes.
#[repr(C)]
pub struct CSnapshotInfo {
    pub id: *mut c_char,
    pub box_id: *mut c_char,
    pub name: *mut c_char,
    pub status: *mut c_char,
    pub error: *mut c_char,
    pub created_at: i64,
    pub container_disk_bytes: u64,
    pub size_bytes: u64,
}

#[repr(C)]
pub struct CSnapshotInfoList {
    pub items: *mut CSnapshotInfo,
    pub count: usize,
}

impl From<SnapshotInfo> for CSnapshotInfo {
    fn from(info: SnapshotInfo) -> Self {
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
            container_disk_bytes: info.disk_info.container_disk_bytes,
            size_bytes: info.disk_info.size_bytes,
        }
    }
}

unsafe fn free_fields(info: &mut CSnapshotInfo) {
    for field in [info.id, info.box_id, info.name, info.status, info.error] {
        free_c_string(field);
    }
}

pub(crate) unsafe fn free_info(info: *mut CSnapshotInfo) {
    if !info.is_null() {
        let mut info = Box::from_raw(info);
        free_fields(&mut info);
    }
}

pub(crate) unsafe fn free_list(list: *mut CSnapshotInfoList) {
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
pub unsafe extern "C" fn boxlite_free_snapshot_info(info: *mut CSnapshotInfo) {
    free_info(info);
}

/// Release an entire snapshot list. Entries must not be freed individually.
/// # Safety
/// list must be null or an unmodified, owned result not previously freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_snapshot_info_list(list: *mut CSnapshotInfoList) {
    free_list(list);
}

fn fail(out_error: *mut CBoxliteError, error: BoxliteError) -> BoxliteErrorCode {
    let code = error_to_code(&error);
    unsafe {
        write_error(out_error, error);
    }
    code
}

macro_rules! snapshot_try {
    ($value:expr, $out:expr) => {
        match $value {
            Ok(value) => value,
            Err(error) => return fail($out, error),
        }
    };
}

unsafe fn checked_handle<'a>(
    handle: *mut CBoxliteSnapshotHandle,
) -> BoxliteResult<&'a SnapshotHandle> {
    let handle = handle
        .as_ref()
        .ok_or_else(|| null_pointer_error("handle"))?;
    ensure_runtime_live(&handle.liveness, "operate on snapshots")?;
    Ok(handle)
}

unsafe fn required_name(name: *const c_char) -> BoxliteResult<String> {
    if name.is_null() {
        return Err(null_pointer_error("snapshot"));
    }
    std::ffi::CStr::from_ptr(name)
        .to_str()
        .map(str::to_owned)
        .map_err(|_| BoxliteError::InvalidArgument("Snapshot name must be UTF-8".into()))
}

/// Obtain an organization-scoped snapshot handle. Does not contact the server.
/// # Safety
/// runtime/out_handle must be valid and non-null; out_error may be null.
/// The caller owns the handle and must call boxlite_snapshot_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_snapshots(
    runtime: *mut CBoxliteRuntime,
    out_handle: *mut *mut CBoxliteSnapshotHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if out_handle.is_null() {
        return fail(out_error, null_pointer_error("out_handle"));
    }
    *out_handle = ptr::null_mut();
    let runtime = snapshot_try!(
        runtime
            .as_ref()
            .ok_or_else(|| null_pointer_error("runtime")),
        out_error
    );
    snapshot_try!(
        ensure_runtime_live(&runtime.liveness, "access snapshots"),
        out_error
    );
    let handle = snapshot_try!(runtime.runtime.snapshots(), out_error);
    *out_handle = Box::into_raw(Box::new(SnapshotHandle {
        scope: SnapshotScope::Organization(handle),
        tokio_rt: runtime.tokio_rt.clone(),
        liveness: runtime.liveness.clone(),
        queue: runtime.queue.clone(),
    }));
    BoxliteErrorCode::Ok
}

/// Obtain snapshots taken from one box; restore targets this box.
/// # Safety
/// box_handle/out_handle must be valid and non-null; out_error may be null.
/// The returned handle owns a reference to the box and must be freed separately.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_snapshots(
    box_handle: *mut CBoxHandle,
    out_handle: *mut *mut CBoxliteSnapshotHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if out_handle.is_null() {
        return fail(out_error, null_pointer_error("out_handle"));
    }
    *out_handle = ptr::null_mut();
    let bx = snapshot_try!(
        box_handle
            .as_ref()
            .ok_or_else(|| null_pointer_error("box_handle")),
        out_error
    );
    snapshot_try!(
        ensure_runtime_live(&bx.liveness, "access snapshots"),
        out_error
    );
    *out_handle = Box::into_raw(Box::new(SnapshotHandle {
        scope: SnapshotScope::Box(bx.handle.clone()),
        tokio_rt: bx.tokio_rt.clone(),
        liveness: bx.liveness.clone(),
        queue: bx.queue.clone(),
    }));
    BoxliteErrorCode::Ok
}

/// Release a snapshot handle; queued calls keep their own references.
/// # Safety
/// handle must be null or a live handle not previously freed. No concurrent access.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_snapshot_free(handle: *mut CBoxliteSnapshotHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

/// Capture this box's disk, waiting for a ready snapshot. Null/blank name generates one.
/// # Safety
/// handle/cb must be valid and non-null; name is null or valid UTF-8 and is copied.
/// Callback fires only on runtime_drain. Its metadata must be freed by the caller.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_snapshot_create(
    handle: *mut CBoxliteSnapshotHandle,
    name: *const c_char,
    cb: CBoxSnapshotInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let handle = snapshot_try!(checked_handle(handle), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let name = if name.is_null() {
        String::new()
    } else {
        snapshot_try!(required_name(name), out_error)
    };
    let SnapshotScope::Box(bx) = &handle.scope else {
        return fail(
            out_error,
            BoxliteError::Unsupported("Capture requires a box snapshot handle".into()),
        );
    };
    let bx = bx.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = bx
            .snapshots()
            .create(SnapshotOptions::default(), &name)
            .await
            .map(|info| Some(OwnedFfiPtr::new_with(Box::new(info.into()), free_info)));
        push_event(
            &queue,
            RuntimeEvent::SnapshotInfo {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// List snapshots in this handle's scope. The callback owns the whole list.
/// # Safety
/// handle/cb must be valid and non-null; user_data must survive callback dispatch.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_snapshot_list(
    handle: *mut CBoxliteSnapshotHandle,
    cb: CBoxSnapshotListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let handle = snapshot_try!(checked_handle(handle), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let scope = handle.scope.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = match scope {
            SnapshotScope::Box(bx) => bx.snapshots().list().await,
            SnapshotScope::Organization(catalog) => catalog.list().await,
        }
        .map(|infos| {
            let items: Box<[_]> = infos.into_iter().map(CSnapshotInfo::from).collect();
            let count = items.len();
            let items = Box::into_raw(items) as *mut CSnapshotInfo;
            OwnedFfiPtr::new_with(Box::new(CSnapshotInfoList { items, count }), free_list)
        });
        push_event(
            &queue,
            RuntimeEvent::SnapshotList {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Get metadata by name (or ID on cloud servers). A missing box-scoped snapshot
/// returns null without error; organization lookups return NotFound.
/// # Safety
/// handle/snapshot/cb must be valid and non-null. snapshot is copied before return.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_snapshot_get(
    handle: *mut CBoxliteSnapshotHandle,
    snapshot: *const c_char,
    cb: CBoxSnapshotInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let handle = snapshot_try!(checked_handle(handle), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let snapshot = snapshot_try!(required_name(snapshot), out_error);
    let scope = handle.scope.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = match scope {
            SnapshotScope::Box(bx) => bx.snapshots().get(&snapshot).await,
            SnapshotScope::Organization(catalog) => catalog.get(&snapshot).await.map(Some),
        }
        .map(|info| info.map(|info| OwnedFfiPtr::new_with(Box::new(info.into()), free_info)));
        push_event(
            &queue,
            RuntimeEvent::SnapshotInfo {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Delete a snapshot. Nonzero force ignores absence, not permission or busy errors.
/// # Safety
/// handle/snapshot/cb must be valid and non-null. Strings are copied before return.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_snapshot_remove(
    handle: *mut CBoxliteSnapshotHandle,
    snapshot: *const c_char,
    force: c_int,
    cb: CBoxSnapshotOpCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let handle = snapshot_try!(checked_handle(handle), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let snapshot = snapshot_try!(required_name(snapshot), out_error);
    let scope = handle.scope.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = match scope {
            SnapshotScope::Box(bx) => match bx.snapshots().remove(&snapshot).await {
                Err(BoxliteError::NotFound(_)) if force != 0 => Ok(()),
                result => result,
            },
            SnapshotScope::Organization(catalog) => catalog.remove(&snapshot, force != 0).await,
        };
        push_event(
            &queue,
            RuntimeEvent::SnapshotOp {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Restore into this handle's box, waiting for the restore job to succeed.
/// # Safety
/// handle/snapshot/cb must be valid and non-null. Strings are copied before return.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_snapshot_restore(
    handle: *mut CBoxliteSnapshotHandle,
    snapshot: *const c_char,
    cb: CBoxSnapshotOpCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let handle = snapshot_try!(checked_handle(handle), out_error);
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let snapshot = snapshot_try!(required_name(snapshot), out_error);
    let SnapshotScope::Box(bx) = &handle.scope else {
        return fail(
            out_error,
            BoxliteError::Unsupported("Restore requires a target box snapshot handle".into()),
        );
    };
    let bx = bx.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = bx.snapshots().restore(&snapshot).await;
        push_event(
            &queue,
            RuntimeEvent::SnapshotOp {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Create an independent cloud box from a ready snapshot and wait for startup.
/// # Safety
/// runtime/snapshot/opts/cb must be valid and non-null. opts is consumed on
/// successful queueing only. Callback ownership matches boxlite_create_box.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_create_box_from_snapshot(
    runtime: *mut CBoxliteRuntime,
    snapshot: *const c_char,
    opts: *mut CBoxliteOptions,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let runtime = snapshot_try!(
        runtime
            .as_ref()
            .ok_or_else(|| null_pointer_error("runtime")),
        out_error
    );
    snapshot_try!(
        ensure_runtime_live(&runtime.liveness, "create snapshot box"),
        out_error
    );
    if opts.is_null() {
        return fail(out_error, null_pointer_error("opts"));
    }
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let snapshot = snapshot_try!(required_name(snapshot), out_error);
    let opts = Box::from_raw(opts);
    let core = runtime.runtime.clone();
    let queue = runtime.queue.clone();
    let tokio_rt = runtime.tokio_rt.clone();
    let liveness = runtime.liveness.clone();
    let user_data = user_data as usize;
    runtime.tokio_rt.spawn(async move {
        let _drop_guard = crate::archive::TokioRuntimeDropGuard::new(tokio_rt.clone());
        let result = core
            .create_from_snapshot(&snapshot, opts.options, opts.name)
            .await
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
