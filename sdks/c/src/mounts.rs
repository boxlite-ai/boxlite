use std::ffi::{CString, c_char, c_void};
use std::ptr;
use std::sync::Arc;

use boxlite::{BoxliteError, MountRequest};
use serde::Serialize;

use crate::archive::{TokioRuntimeDropGuard, parse_required_string};
use crate::error::{
    BoxliteErrorCode, error_to_c_error, error_to_code, null_pointer_error, write_error,
};
use crate::event_queue::{RuntimeEvent, push_event};
use crate::{CBoxHandle, CBoxliteError};

pub(crate) type MountsFn = extern "C" fn(*const c_char, *const CBoxliteError, *mut c_void);

/// Mount completion on the drain thread. Both pointers are borrowed for the
/// duration of the callback. Copy the JSON to keep it beyond that call.
pub type CBoxMountCb = Option<extern "C" fn(*const c_char, *const CBoxliteError, *mut c_void)>;

enum MountOp {
    Add(MountRequest),
    Remove(String),
    List,
    Get(String),
}

fn json(value: impl Serialize) -> Result<CString, BoxliteError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|err| BoxliteError::Internal(err.to_string()))?;
    CString::new(bytes).map_err(|err| BoxliteError::Internal(err.to_string()))
}

pub(crate) unsafe fn dispatch_mounts(
    result: Result<CString, BoxliteError>,
    cb: MountsFn,
    user_data: usize,
) {
    match result {
        Ok(json) => cb(json.as_ptr(), ptr::null(), user_data as *mut c_void),
        Err(error) => {
            let mut error = error_to_c_error(error);
            cb(ptr::null(), &error, user_data as *mut c_void);
            unsafe { crate::boxlite_error_free(&mut error) };
        }
    }
}

unsafe fn schedule(
    handle: *mut CBoxHandle,
    op: Result<MountOp, BoxliteError>,
    cb: CBoxMountCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let refuse = |error: BoxliteError| {
        let code = error_to_code(&error);
        unsafe { write_error(out_error, error) };
        code
    };
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let Some(handle) = (unsafe { handle.as_ref() }) else {
        return refuse(null_pointer_error("handle"));
    };
    let op = match op {
        Ok(op) => op,
        Err(error) => return refuse(error),
    };
    if let Err(error) = crate::util::ensure_runtime_live(&handle.liveness, "access mounts") {
        return refuse(error);
    }
    let mount = handle.handle.mount();
    let queue = Arc::clone(&handle.queue);
    let runtime = Arc::clone(&handle.tokio_rt);
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        // The operation can outlive the caller's box and runtime handles.
        let _runtime = TokioRuntimeDropGuard::new(runtime);
        let result = match op {
            MountOp::Add(request) => mount.add(request).await.and_then(json),
            MountOp::Remove(target) => mount.remove(target).await.and_then(json),
            MountOp::List => mount.list().await.and_then(json),
            MountOp::Get(target) => mount.get(target).await.and_then(json),
        };
        push_event(
            &queue,
            RuntimeEvent::Mounts {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Deliver a host directory to a Box. The callback receives the resulting
/// mount as JSON with source, target, read_only and state fields. A running
/// Box reports `mounted`; a stopped one saves the mount and reports
/// `configured` for its next start. The Box is never started.
/// Input strings are required and copied before returning.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_mount_add(
    handle: *mut CBoxHandle,
    source: *const c_char,
    target: *const c_char,
    read_only: bool,
    cb: CBoxMountCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let op = unsafe { parse_required_string(source, "source") }.and_then(|source| {
        Ok(MountOp::Add(MountRequest {
            source: source.into(),
            target: unsafe { parse_required_string(target, "target") }?.into(),
            read_only,
        }))
    });
    unsafe { schedule(handle, op, cb, user_data, out_error) }
}

/// Lazily detach the mount at target, or discard one a stopped Box saved as
/// `configured`. On success the callback receives JSON null. The Box is never
/// started.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_mount_remove(
    handle: *mut CBoxHandle,
    target: *const c_char,
    cb: CBoxMountCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let op = unsafe { parse_required_string(target, "target") }.map(MountOp::Remove);
    unsafe { schedule(handle, op, cb, user_data, out_error) }
}

/// Read the mounts of the Box as a JSON array, including any saved as
/// `configured` for its next start. The Box is never started.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_mount_list(
    handle: *mut CBoxHandle,
    cb: CBoxMountCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { schedule(handle, Ok(MountOp::List), cb, user_data, out_error) }
}

/// Read the mount at target as JSON. An absent target returns JSON null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_mount_get(
    handle: *mut CBoxHandle,
    target: *const c_char,
    cb: CBoxMountCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let op = unsafe { parse_required_string(target, "target") }.map(MountOp::Get);
    unsafe { schedule(handle, op, cb, user_data, out_error) }
}
