//! Snapshot facade using the runtime's post-and-drain callback ownership.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};

use boxlite::{BoxliteError, SnapshotInfo, SnapshotOptions, SnapshotType};
use serde::Deserialize;

use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{CBoxSnapshotCb, RuntimeEvent, push_event};
use crate::{CBoxHandle, CBoxliteError};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    Create,
    Get,
    List,
    Remove,
    Restore,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: Operation,
    #[serde(default)]
    name: String,
    #[serde(default)]
    snapshot_type: SnapshotType,
}

fn metadata(info: SnapshotInfo) -> serde_json::Value {
    // Never expose the runner's absolute base_path over this wire interface.
    serde_json::json!({
        "id": info.id, "box_id": info.box_id, "name": info.name,
        "created_at": info.created_at, "snapshot_type": info.snapshot_type,
        "is_mock": info.is_mock, "container_disk_bytes": info.disk_info.container_disk_bytes,
        "size_bytes": info.disk_info.size_bytes,
    })
}

/// Submit create/get/list/remove/restore using a JSON request with `operation`,
/// `name` (except list), and optional `snapshot_type` (default filesystem).
/// The callback owns the JSON result string; release with boxlite_free_string.
/// Inputs are copied before returning. Cancellation does not abort disk capture.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_snapshot(
    handle: *mut CBoxHandle,
    request_json: *const c_char,
    cb: CBoxSnapshotCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if handle.is_null() || request_json.is_null() {
        write_error(out_error, null_pointer_error("handle or request_json"));
        return BoxliteErrorCode::InvalidArgument;
    }
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let bytes = CStr::from_ptr(request_json).to_bytes();
    let request = (|| {
        if bytes.len() > 65536 {
            return Err(BoxliteError::InvalidArgument(
                "snapshot request exceeds 64KiB".into(),
            ));
        }
        serde_json::from_slice::<Request>(bytes)
            .map_err(|e| BoxliteError::InvalidArgument(format!("invalid snapshot request: {e}")))
    })();
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            let code = error_to_code(&error);
            write_error(out_error, error);
            return code;
        }
    };
    let handle = &*handle;
    let lite = handle.handle.clone();
    let queue = handle.queue.clone();
    let user_data = user_data as usize;
    handle.tokio_rt.spawn(async move {
        let result = async {
            if request.snapshot_type == SnapshotType::Memory {
                return Err(BoxliteError::Unsupported(
                    "memory save/restore is not implemented".into(),
                ));
            }
            let snapshots = lite.snapshots();
            let value = match request.operation {
                Operation::Create => metadata(
                    snapshots
                        .create(
                            SnapshotOptions {
                                snapshot_type: request.snapshot_type,
                            },
                            &request.name,
                        )
                        .await?,
                ),
                Operation::Get => metadata(
                    snapshots
                        .get(&request.name)
                        .await?
                        .ok_or_else(|| BoxliteError::NotFound("snapshot not found".into()))?,
                ),
                Operation::List => serde_json::Value::Array(
                    snapshots.list().await?.into_iter().map(metadata).collect(),
                ),
                Operation::Remove => {
                    snapshots.remove(&request.name).await?;
                    serde_json::Value::Null
                }
                Operation::Restore => {
                    snapshots.restore(&request.name).await?;
                    serde_json::Value::Null
                }
            };
            CString::new(value.to_string()).map_err(|e| BoxliteError::Internal(e.to_string()))
        }
        .await;
        push_event(
            &queue,
            RuntimeEvent::Snapshot {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}
