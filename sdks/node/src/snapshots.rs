//! Node.js bindings for snapshot operations.

use std::sync::Arc;

use boxlite::{LiteBox, SnapshotInfo, SnapshotOptions};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::snapshot_options::JsSnapshotOptions;
use crate::util::map_err;

/// Snapshot metadata.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsSnapshotInfo {
    pub id: String,
    #[napi(js_name = "boxId")]
    pub box_id: String,
    pub name: String,
    #[napi(js_name = "createdAt")]
    pub created_at: i64,
    #[napi(js_name = "containerDiskBytes")]
    pub container_disk_bytes: i64,
    #[napi(js_name = "sizeBytes")]
    pub size_bytes: i64,
}

impl From<SnapshotInfo> for JsSnapshotInfo {
    fn from(r: SnapshotInfo) -> Self {
        Self {
            id: r.id,
            box_id: r.box_id,
            name: r.name,
            created_at: r.created_at,
            container_disk_bytes: r.disk_info.container_disk_bytes as i64,
            size_bytes: r.disk_info.size_bytes as i64,
        }
    }
}

/// Handle for snapshot operations on a Box.
///
/// Accessed as a property: `box.snapshot.create(...)`.
#[napi]
pub struct JsSnapshotHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[napi]
impl JsSnapshotHandle {
    /// Create a snapshot of the box's current disk state.
    #[napi]
    pub async fn create(
        &self,
        name: String,
        options: Option<JsSnapshotOptions>,
    ) -> Result<JsSnapshotInfo> {
        let handle = Arc::clone(&self.handle);
        let options: SnapshotOptions = options.map(Into::into).unwrap_or_default();
        let info = handle
            .snapshots()
            .create(options, &name)
            .await
            .map_err(map_err)?;
        Ok(JsSnapshotInfo::from(info))
    }

    /// List all snapshots for this box.
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsSnapshotInfo>> {
        let handle = Arc::clone(&self.handle);
        let infos = handle.snapshots().list().await.map_err(map_err)?;
        Ok(infos.into_iter().map(JsSnapshotInfo::from).collect())
    }

    /// Get a snapshot by name.
    #[napi]
    pub async fn get(&self, name: String) -> Result<Option<JsSnapshotInfo>> {
        let handle = Arc::clone(&self.handle);
        let info = handle.snapshots().get(&name).await.map_err(map_err)?;
        Ok(info.map(JsSnapshotInfo::from))
    }

    /// Remove a snapshot by name.
    #[napi]
    pub async fn remove(&self, name: String) -> Result<()> {
        let handle = Arc::clone(&self.handle);
        handle.snapshots().remove(&name).await.map_err(map_err)
    }

    /// Restore the box's disks from a snapshot.
    #[napi]
    pub async fn restore(&self, name: String) -> Result<()> {
        let handle = Arc::clone(&self.handle);
        handle.snapshots().restore(&name).await.map_err(map_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_info_from_core() {
        let core = SnapshotInfo {
            id: "snap-id".into(),
            box_id: "box-id".into(),
            name: "my-snap".into(),
            created_at: 1700000000,
            disk_info: boxlite::DiskInfo {
                base_path: "/bases/snap-1.qcow2".into(),
                container_disk_bytes: 2048,
                size_bytes: 3072,
            },
        };
        let js: JsSnapshotInfo = core.into();
        assert_eq!(js.id, "snap-id");
        assert_eq!(js.box_id, "box-id");
        assert_eq!(js.name, "my-snap");
        assert_eq!(js.created_at, 1700000000);
        assert_eq!(js.container_disk_bytes, 2048);
        assert_eq!(js.size_bytes, 3072);
    }

    #[test]
    fn snapshot_info_large_u64_truncates_to_i64() {
        let core = SnapshotInfo {
            id: "id".into(),
            box_id: "bid".into(),
            name: "n".into(),
            created_at: 0,
            disk_info: boxlite::DiskInfo {
                base_path: String::new(),
                container_disk_bytes: u64::MAX,
                size_bytes: u64::MAX,
            },
        };
        let js: JsSnapshotInfo = core.into();
        // u64::MAX as i64 wraps to -1
        assert_eq!(js.container_disk_bytes, -1);
        assert_eq!(js.size_bytes, -1);
    }
}
