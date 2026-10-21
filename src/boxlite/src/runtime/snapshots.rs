use std::sync::Arc;

use super::rt_impl::{RuntimeImpl, sanitize_local_options};
use crate::disk::{Qcow2Helper, constants::filenames};
use crate::litebox::snapshot_mgr::SnapshotManifest;
use crate::{BoxOptions, BoxStatus, BoxliteError, BoxliteResult, LiteBox, SnapshotType};

impl RuntimeImpl {
    pub(crate) async fn create_from_snapshot(
        self: &Arc<Self>,
        id: &str,
        name: Option<String>,
        options: Option<BoxOptions>,
    ) -> BoxliteResult<LiteBox> {
        let _catalog_lock = self.snapshot_mgr.operations.lock().await;
        let info = self.snapshot_mgr.get_id(id)?;
        if info.snapshot_type != SnapshotType::Filesystem || info.is_mock {
            return Err(BoxliteError::Unsupported(
                "only real filesystem snapshots can cold-create a Box".into(),
            ));
        }
        let disk = info.disk_info.to_path_buf();
        let manifest = SnapshotManifest::read(&disk)?;
        let rootfs = manifest.options.rootfs.clone();
        let mut options = options.unwrap_or(manifest.options);
        options.rootfs = rootfs;
        #[allow(deprecated)]
        {
            options.auto_remove = false;
        }
        let options = sanitize_local_options(&self.experimental_features, options).await?;
        if let Some(name) = &name {
            if self.get_info(name).await?.is_some() {
                return Err(BoxliteError::AlreadyExists(
                    "Box name already exists".into(),
                ));
            }
        }
        let temp = tempfile::tempdir_in(self.layout.temp_dir())?;
        let staging = temp.path().join("box");
        let disks = staging.join("disks");
        std::fs::create_dir_all(&disks)?;
        let dest = disks.join(filenames::CONTAINER_DISK);
        // Each child owns its writable disk. Deletion cannot invalidate it.
        tokio::task::spawn_blocking(move || Qcow2Helper::flatten(&disk, &dest))
            .await
            .map_err(|e| BoxliteError::Internal(format!("snapshot materialization: {e}")))??;
        self.provision_box(staging, name, options, BoxStatus::Stopped, None)
            .await
    }
}
