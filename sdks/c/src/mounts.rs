//! Runtime directory delivery (M6) for the BoxLite C SDK.
//!
//! Same post-and-drain contract as the lifecycle ops: each entry point
//! spawns a Tokio task, pushes one `RuntimeEvent`, and the callback fires
//! from `boxlite_runtime_drain`. `add`/`remove` are completion-only;
//! `list`/`get` deliver a JSON document (an array of mounts, one mount, or
//! JSON `null` for "not mounted") that the recipient releases with
//! `boxlite_free_string`.

use std::ffi::{CStr, CString, c_char, c_int, c_void};

use boxlite::{BoxliteError, MountInfo, MountRequest};

use serde_json::json;

use crate::CBoxliteError;
use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{CBoxMountCb, CBoxMountJsonCb, RuntimeEvent, push_event};

/// Submit a runtime directory delivery into the running container.
///
/// `source` is a host directory, `box_path` the container target, and
/// `read_only` non-zero for a read-only delivery.
///
/// # Safety
/// `handle` must remain live and must not be freed concurrently until this
/// call returns: the entrypoint synchronously clones its owned box handle.
/// Strings must be readable NUL-terminated UTF-8 through this call; they are
/// copied before return. `out_error`, when non-null, must be writable.
/// After successful submission, keep the runtime, callback and `user_data`
/// valid until completion is dispatched by `boxlite_runtime_drain`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_mount_add(
    handle: *mut BoxHandle,
    source: *const c_char,
    box_path: *const c_char,
    read_only: c_int,
    cb: CBoxMountCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        mount_add(
            handle, source, box_path, read_only, cb, user_data, out_error,
        )
    }
}

/// Lazily detach the mount at a container target.
///
/// Idempotent: removing an unknown target completes successfully; a mount
/// already converging reports success once the record reaches `detaching`.
///
/// # Safety
/// The handle, strings, error output, runtime and callback obey the same
/// lifetime requirements as [`boxlite_box_mount_add`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_mount_remove(
    handle: *mut BoxHandle,
    box_path: *const c_char,
    cb: CBoxMountCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { mount_remove(handle, box_path, cb, user_data, out_error) }
}

/// List every runtime mount of the current VM run as a JSON array.
///
/// On success, the callback owns the returned string and must release it
/// with `boxlite_free_string`.
///
/// # Safety
/// The handle, error output, runtime and callback obey the same lifetime
/// requirements as [`boxlite_box_mount_add`]. Callback errors are borrowed
/// only for the callback duration; successful JSON strings are caller-owned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_mount_list(
    handle: *mut BoxHandle,
    cb: CBoxMountJsonCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { mount_list(handle, cb, user_data, out_error) }
}

/// The mount at a container target as a JSON object, or JSON `null` when
/// nothing is delivered there.
///
/// On success, the callback owns the returned string and must release it
/// with `boxlite_free_string`.
///
/// # Safety
/// The handle, strings, error output, runtime and callback obey the same
/// lifetime requirements as [`boxlite_box_mount_add`]. Callback errors are
/// borrowed only for the callback duration; successful JSON is caller-owned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_mount_get(
    handle: *mut BoxHandle,
    box_path: *const c_char,
    cb: CBoxMountJsonCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { mount_get(handle, box_path, cb, user_data, out_error) }
}

fn mount_value(mount: &MountInfo) -> serde_json::Value {
    json!({
        "source": mount.source.display().to_string(),
        "target": mount.target.display().to_string(),
        "readOnly": mount.read_only,
        "state": mount.state,
    })
}

fn mount_json(mount: &MountInfo) -> CString {
    CString::new(mount_value(mount).to_string()).expect("json has no interior nul")
}

fn mounts_json(mounts: &[MountInfo]) -> CString {
    let values: Vec<_> = mounts.iter().map(mount_value).collect();
    CString::new(json!(values).to_string()).expect("json has no interior nul")
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

fn write_arg_error(out_error: *mut FFIError, error: BoxliteError) -> BoxliteErrorCode {
    unsafe { write_error(out_error, error) };
    BoxliteErrorCode::InvalidArgument
}

unsafe fn mount_add(
    handle: *mut BoxHandle,
    source: *const c_char,
    box_path: *const c_char,
    read_only: c_int,
    cb: CBoxMountCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let source = match parse_required_string(source, "source") {
            Ok(source) => source,
            Err(error) => return write_arg_error(out_error, error),
        };
        let box_path = match parse_required_string(box_path, "box_path") {
            Ok(path) => path,
            Err(error) => return write_arg_error(out_error, error),
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data = user_data as usize;
        let request = MountRequest {
            source: source.into(),
            target: box_path.into(),
            read_only: read_only != 0,
        };

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.mounts().add(request).await.map(|_| ());
            push_event(
                &queue,
                RuntimeEvent::MountAdd {
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

unsafe fn mount_remove(
    handle: *mut BoxHandle,
    box_path: *const c_char,
    cb: CBoxMountCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let box_path = match parse_required_string(box_path, "box_path") {
            Ok(path) => path,
            Err(error) => return write_arg_error(out_error, error),
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.mounts().remove(&box_path).await;
            push_event(
                &queue,
                RuntimeEvent::MountRemove {
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

unsafe fn mount_list(
    handle: *mut BoxHandle,
    cb: CBoxMountJsonCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite
                .mounts()
                .list()
                .await
                .map(|mounts| mounts_json(&mounts));
            push_event(
                &queue,
                RuntimeEvent::MountListJson {
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

unsafe fn mount_get(
    handle: *mut BoxHandle,
    box_path: *const c_char,
    cb: CBoxMountJsonCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let box_path = match parse_required_string(box_path, "box_path") {
            Ok(path) => path,
            Err(error) => return write_arg_error(out_error, error),
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.mounts().get(&box_path).await.map(|mount| {
                mount
                    .map(|mount| mount_json(&mount))
                    .unwrap_or_else(|| CString::new("null").expect("no interior nul"))
            });
            push_event(
                &queue,
                RuntimeEvent::MountGetJson {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(source: &str, target: &str, read_only: bool) -> MountInfo {
        MountInfo {
            source: source.into(),
            target: target.into(),
            read_only,
            state: boxlite::MountState::Mounted,
        }
    }

    #[test]
    fn mount_json_carries_pair_mode_and_lowercase_state() {
        let json = mount_json(&sample("/host/a", "/box/a", true));
        let value: serde_json::Value =
            serde_json::from_str(json.to_str().expect("utf8")).expect("valid json");
        assert_eq!(value["source"], "/host/a");
        assert_eq!(value["target"], "/box/a");
        assert_eq!(value["readOnly"], true);
        assert_eq!(value["state"], "mounted");
    }

    #[test]
    fn mounts_json_is_an_array_and_reports_detaching_verbatim() {
        let mut detaching = sample("/host/b", "/box/b", false);
        detaching.state = boxlite::MountState::Detaching;
        let json = mounts_json(&[sample("/host/a", "/box/a", true), detaching]);
        let value: serde_json::Value =
            serde_json::from_str(json.to_str().expect("utf8")).expect("valid json");
        assert!(value.is_array());
        assert_eq!(value.as_array().expect("array").len(), 2);
        assert_eq!(value[1]["state"], "detaching");
    }

    #[test]
    fn parse_required_string_rejects_null_and_invalid_utf8() {
        let error = unsafe { parse_required_string(std::ptr::null(), "box_path") }
            .expect_err("null is rejected");
        assert!(error.to_string().contains("box_path"));

        // Non-UTF8 bytes are rejected without reading past the buffer.
        let bytes = CString::new([0xFF, 0xFE]).expect("terminator appended");
        let error = unsafe { parse_required_string(bytes.as_ptr(), "source") }
            .expect_err("invalid utf-8 is rejected");
        assert!(error.to_string().contains("source"));
    }
}
