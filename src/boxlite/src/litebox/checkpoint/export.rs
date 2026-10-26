//! Export of a paused checkpoint-enabled box to one BoxCheckpoint file.
//!
//! The jailed shim writes the raw VM image only inside the box's own
//! `checkpoint/` directory; the host then checks it, stages the archive
//! next to the destination, syncs it and publishes it with a link that
//! never replaces an existing file. Every failure leaves the box paused
//! and removes only the names this export created.

use super::archive::{self, BootRecord, ImageRecord, Manifest};
use super::{BoxImpl, VmRunState, query_state};
use crate::images::ContainerImageConfig;
use crate::litebox::init::restart_image_config;
use crate::vmm::checkpoint::ControlRequest;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::fs::{File, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// Removes a file this export created when dropped.
struct Created(PathBuf);

impl Drop for Created {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.0) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::warn!(path = %self.0.display(), error = %e, "Failed to remove checkpoint temporary")
            }
        }
    }
}

/// A name no other export of this process or another one picks.
fn unique(prefix: &str) -> String {
    format!(
        "{prefix}{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Check `path` can become the archive: its directory exists and nothing,
/// not even a dangling link, has its name.
fn check_destination(path: &Path) -> BoxliteResult<(PathBuf, String)> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            BoxliteError::InvalidArgument(format!(
                "checkpoint destination {} has no file name",
                path.display()
            ))
        })?
        .to_string();
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.to_path_buf(),
        _ => PathBuf::from("."),
    };
    if !dir.is_dir() {
        return Err(BoxliteError::InvalidArgument(format!(
            "checkpoint destination directory {} does not exist",
            dir.display()
        )));
    }
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((dir, name)),
        Ok(_) => Err(BoxliteError::InvalidArgument(format!(
            "checkpoint destination {} already exists",
            path.display()
        ))),
        Err(e) => Err(BoxliteError::Storage(format!(
            "checkpoint destination {}: {e}",
            path.display()
        ))),
    }
}

/// Write the archive for `manifest` and `image` to a private temporary in
/// `dir`, sync it, link it to `path` and sync `dir`. The link fails rather
/// than replace a file that appeared meanwhile; a failed directory sync
/// takes the link back, so a failure never leaves a published file.
fn publish(
    manifest: &Manifest,
    image: &Path,
    dir: &Path,
    name: &str,
    path: &Path,
) -> BoxliteResult<()> {
    use std::os::unix::fs::MetadataExt;
    let storage = |what: &str, e: std::io::Error| {
        BoxliteError::Storage(format!("checkpoint {what} {}: {e}", path.display()))
    };
    let temp_path = dir.join(format!(".{}.tmp", unique(&format!("{name}."))));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp_path)
        .map_err(|e| storage("staging", e))?;
    let temp = Created(temp_path);
    archive::write(&mut file, manifest, image)?;
    file.sync_all().map_err(|e| storage("sync", e))?;
    let staged = file.metadata().map_err(|e| storage("staging", e))?;
    drop(file);
    std::fs::hard_link(&temp.0, path).map_err(|e| storage("publish", e))?;
    if let Err(e) = File::open(dir).and_then(|dir| dir.sync_all()) {
        // Remove the link only while it is still this export's file.
        if std::fs::symlink_metadata(path)
            .is_ok_and(|meta| (meta.dev(), meta.ino()) == (staged.dev(), staged.ino()))
            && let Err(unlink) = std::fs::remove_file(path)
        {
            tracing::warn!(path = %path.display(), error = %unlink, "Failed to unpublish checkpoint");
        }
        return Err(storage("directory sync", e));
    }
    Ok(())
}

impl BoxImpl {
    /// Write the paused VM to a new BoxCheckpoint file at `path`.
    ///
    /// The box must be paused. It stays paused whether the export succeeds
    /// or fails; only an export whose outcome the owner could not report
    /// stops the VM, and it is never repeated.
    pub(crate) async fn export_checkpoint(&self, path: &Path) -> BoxliteResult<()> {
        let _serial = self.checkpoint_ops.lock().await;
        self.require_checkpoint("export a checkpoint")?;
        let (dir, name) = check_destination(path)?;
        // The persisted record: another process may have taken the pause.
        let persisted = self.runtime.box_manager.update_box(&self.config.id)?;
        let guest = persisted.checkpoint_guest.ok_or_else(|| {
            BoxliteError::InvalidState(format!(
                "box {} has no record of the guest its pause cut; resume and pause it again",
                self.config.id
            ))
        })?;
        let reply = query_state(&self.checkpoint_control())
            .await
            .map_err(|message| BoxliteError::Engine(format!("export: {message}")))?;
        if reply.state != VmRunState::Paused || reply.in_flight.is_some() {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot export box {}: its VM is {}{}; pause it first",
                self.config.id,
                reply.state,
                reply
                    .in_flight
                    .map(|op| format!(" with a {op} in progress"))
                    .unwrap_or_default()
            )));
        }
        let container_image_config = self.boot_image_config().await?;

        let raw_name = format!("{}.krunvm", unique("export-"));
        let raw = Created(self.layout.prepare_checkpoint_dir()?.join(&raw_name));
        let outcome = self
            .checkpoint_request(&ControlRequest::ExportRaw { name: raw_name })
            .await;
        // An uncertain outcome stops the VM here, and `raw` goes once the
        // shim that might still write it is gone.
        self.settle("export", outcome).await?;

        let mut options = self.config.options.clone();
        // The file holds the volumes' contents, not where they came from:
        // an import points each volume at its restored copy.
        for volume in &mut options.volumes {
            volume.host_path.clear();
        }
        let source_box_id = self.config.id.to_string();
        let outbound_policy = persisted.outbound_policy;
        let destination = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let (length, sha256) = archive::digest(&raw.0)?;
            let (layout, _) = archive::read_image_layout(&raw.0)?;
            layout.check_for(&options)?;
            let manifest = Manifest {
                format: archive::FORMAT.to_string(),
                version: archive::VERSION,
                created_at: chrono::Utc::now(),
                source_box_id,
                guest,
                image: ImageRecord {
                    krunvm_version: archive::KRUNVM_VERSION,
                    length,
                    sha256,
                },
                layout,
                boot: BootRecord {
                    options,
                    outbound_policy,
                    container_image_config,
                },
            };
            publish(&manifest, &raw.0, &dir, &name, &destination)
        })
        .await
        .map_err(|e| BoxliteError::Internal(format!("checkpoint export task failed: {e}")))?
    }

    /// The container config the paused guest was booted with: an imported
    /// box's recorded one, else the one a restart computes from the image
    /// the box's disk was built from (still on this host).
    async fn boot_image_config(&self) -> BoxliteResult<ContainerImageConfig> {
        let (restored, built_from) = {
            let state = self.state.read();
            (
                state
                    .restored_storage
                    .as_ref()
                    .map(|restored| restored.container_image_config.clone()),
                state.resolved_image.clone(),
            )
        };
        if let Some(config) = restored {
            return Ok(config);
        }
        let options = &self.config.options;
        restart_image_config(
            &self.runtime,
            &options.rootfs,
            &options.env,
            options.entrypoint.as_deref(),
            options.cmd.as_deref(),
            options.user.as_deref(),
            options.working_dir.as_deref(),
            built_from.as_ref(),
        )
        .await
    }
}
