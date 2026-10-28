//! Export a reserved Paused owner as a checked, durably published pair.
use super::{
    BoxImpl,
    capture::{self, CancelOnDrop, Session},
    pair::{self, Application},
    provider::LocalCheckpointProvider,
};
use crate::images::ContainerImageConfig;
use crate::litebox::init::restart_image_config;
use crate::vmm::checkpoint::protocol::DescriptorRequest;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::fs::{File, OpenOptions};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// A delivered export may still own its output FD after the host loses its
/// reply. Retain that attempt unless its writer was confirmed joined.
struct StagedPair {
    directory: Option<tempfile::TempDir>,
    joined: AtomicBool,
}
impl StagedPair {
    fn path(&self) -> &Path {
        self.directory.as_ref().expect("unpublished staging").path()
    }
    fn into_directory(mut self) -> tempfile::TempDir {
        self.directory.take().expect("unpublished staging")
    }
}
impl Drop for StagedPair {
    fn drop(&mut self) {
        if !self.joined.load(Ordering::Acquire)
            && let Some(directory) = self.directory.take()
        {
            let location = directory.path().canonicalize();
            let path = directory.keep();
            let path = location.unwrap_or(path);
            tracing::error!(path=%path.display(),"Checkpoint writer could not be joined; retained attempt storage");
        }
    }
}

fn destination(path: &Path) -> BoxliteResult<(PathBuf, std::ffi::CString)> {
    if !cfg!(target_os = "linux") {
        return Err(BoxliteError::Unsupported(
            "checkpoint publication requires Linux renameat2".into(),
        ));
    }
    use std::os::unix::ffi::OsStrExt;
    let name = path.file_name().ok_or_else(|| {
        BoxliteError::InvalidArgument("checkpoint destination has no name".into())
    })?;
    let name = std::ffi::CString::new(name.as_bytes()).map_err(pair::invalid)?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .canonicalize()
        .map_err(pair::invalid)?;
    if path.symlink_metadata().is_ok() {
        return Err(BoxliteError::AlreadyExists(path.display().to_string()));
    }
    Ok((parent, name))
}

fn stage(parent_path: &Path) -> BoxliteResult<(File, Arc<StagedPair>)> {
    let parent = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent_path)
        .map_err(pair::invalid)?;
    #[cfg(target_os = "linux")]
    let alias = PathBuf::from(format!("/proc/self/fd/{}", parent.as_raw_fd()));
    #[cfg(not(target_os = "linux"))]
    let alias = parent_path.to_path_buf();
    let directory = tempfile::Builder::new()
        .prefix(".boxlite-checkpoint-")
        .tempdir_in(alias)
        .map_err(pair::invalid)?;
    Ok((
        parent,
        Arc::new(StagedPair {
            directory: Some(directory),
            joined: AtomicBool::new(true),
        }),
    ))
}

#[derive(Debug)]
#[cfg_attr(
    not(target_os = "linux"),
    expect(dead_code, reason = "publication and rollback require Linux renameat2")
)]
struct Publication {
    parent: File,
    directory: File,
    members: Vec<(std::ffi::CString, File)>,
    name: std::ffi::CString,
}

#[cfg(target_os = "linux")]
fn rename_owned(
    source: &File,
    old: &std::ffi::CStr,
    destination: &File,
    new: &std::ffi::CStr,
) -> BoxliteResult<()> {
    // SAFETY: borrowed live directory FDs and terminated relative names.
    if unsafe {
        libc::renameat2(
            source.as_raw_fd(),
            old.as_ptr(),
            destination.as_raw_fd(),
            new.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(pair::invalid(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
impl Publication {
    fn rollback(&self) -> BoxliteResult<()> {
        use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
        let parent_alias = PathBuf::from(format!("/proc/self/fd/{}", self.parent.as_raw_fd()));
        let quarantine = tempfile::Builder::new()
            .prefix(".boxlite-rollback-")
            .tempdir_in(&parent_alias)
            .map_err(pair::invalid)?
            .keep();
        let quarantine_name = std::ffi::CString::new(quarantine.file_name().unwrap().as_bytes())
            .map_err(pair::invalid)?;
        let parent_location = std::fs::read_link(&parent_alias)
            .map(|path| path.display().to_string())
            .unwrap_or_else(|error| format!("unresolved pinned parent ({error})"));
        let residue = format!(
            "parent last observed at {parent_location}; quarantine {}",
            quarantine.file_name().unwrap().to_string_lossy()
        );
        let holder = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&quarantine)
            .map_err(pair::invalid)?;
        let cleanup = (|| {
            rename_owned(&self.parent, &self.name, &holder, c"pair")?;
            let path = PathBuf::from(format!("/proc/self/fd/{}/pair", holder.as_raw_fd()));
            let moved = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&path)
                .map_err(pair::invalid)?;
            let same = |a: &File, b: &File| -> BoxliteResult<bool> {
                let a = a.metadata().map_err(pair::invalid)?;
                let b = b.metadata().map_err(pair::invalid)?;
                Ok((a.dev(), a.ino()) == (b.dev(), b.ino()))
            };
            let check = (|| {
                if !same(&moved, &self.directory)? {
                    return Err(pair::invalid("publication directory replaced"));
                }
                let entries = std::fs::read_dir(&path)
                    .map_err(pair::invalid)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(pair::invalid)?;
                if entries.len() != self.members.len() {
                    return Err(pair::invalid("publication member layout changed"));
                }
                for (name, original) in &self.members {
                    let file = OpenOptions::new()
                        .read(true)
                        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                        .open(path.join(std::ffi::OsStr::from_bytes(name.to_bytes())))
                        .map_err(pair::invalid)?;
                    if !same(&file, original)? {
                        return Err(pair::invalid("publication member replaced"));
                    }
                }
                Ok(())
            })();
            if let Err(error) = check {
                let restore = rename_owned(&holder, c"pair", &self.parent, &self.name);
                return Err(BoxliteError::Storage(format!(
                    "{error}; no members removed; restoration: {restore:?}"
                )));
            }
            // The caller must not mutate the destination during export or
            // rollback. These operations stay inside the pinned, verified
            // private quarantine; they never recursively remove a public path.
            for (name, _) in &self.members {
                // SAFETY: verified relative member name and pinned directory.
                if unsafe { libc::unlinkat(moved.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                    return Err(pair::invalid(std::io::Error::last_os_error()));
                }
            }
            // SAFETY: removes only an empty directory under our pinned holder.
            if unsafe { libc::unlinkat(holder.as_raw_fd(), c"pair".as_ptr(), libc::AT_REMOVEDIR) }
                != 0
            {
                return Err(pair::invalid(std::io::Error::last_os_error()));
            }
            Ok(())
        })();
        // Remove only an empty quarantine; otherwise retain the exact residue.
        // SAFETY: relative name under the pinned parent; rmdir cannot recurse.
        let removed = unsafe {
            libc::unlinkat(
                self.parent.as_raw_fd(),
                quarantine_name.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        } == 0;
        if let Err(error) = cleanup {
            return Err(BoxliteError::Storage(format!(
                "{error}; {residue} {}",
                if removed { "removed" } else { "retained" }
            )));
        }
        if !removed {
            return Err(pair::invalid(format!(
                "empty rollback quarantine retained: {residue}"
            )));
        }
        self.parent.sync_all().map_err(|error| {
            BoxliteError::Storage(format!(
                "pair removed; parent durability uncertain: {error}"
            ))
        })
    }
}

#[cfg(not(target_os = "linux"))]
impl Publication {
    fn rollback(&self) -> BoxliteResult<()> {
        Err(pair::invalid("checkpoint rollback requires Linux"))
    }
}

fn rollback_failure(error: BoxliteError, publication: &Publication) -> BoxliteError {
    match publication.rollback() {
        Ok(()) => error,
        Err(cleanup) => BoxliteError::Storage(format!("{error}; rollback: {cleanup}")),
    }
}

fn publish(
    staging: tempfile::TempDir,
    parent: &File,
    name: &std::ffi::CStr,
) -> BoxliteResult<Publication> {
    let publication = Publication {
        parent: parent.try_clone().map_err(pair::invalid)?,
        directory: File::open(staging.path()).map_err(pair::invalid)?,
        members: [pair::MEMORY, pair::DISK]
            .into_iter()
            .map(|name| {
                Ok((
                    std::ffi::CString::new(name).unwrap(),
                    File::open(staging.path().join(name)).map_err(pair::invalid)?,
                ))
            })
            .collect::<BoxliteResult<_>>()?,
        name: name.to_owned(),
    };
    File::open(staging.path())
        .and_then(|file| file.sync_all())
        .map_err(pair::invalid)?;
    use std::os::unix::ffi::OsStrExt;
    let _source = std::ffi::CString::new(
        staging
            .path()
            .file_name()
            .expect("staging has a name")
            .as_bytes(),
    )
    .map_err(pair::invalid)?;
    #[cfg(target_os = "linux")]
    // SAFETY: terminated relative names and live pinned parent FD.
    let status = unsafe {
        libc::renameat2(
            parent.as_raw_fd(),
            _source.as_ptr(),
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(target_os = "linux"))]
    let status = -1;
    if status != 0 {
        return Err(pair::invalid(format!(
            "atomic no-overwrite publication: {}",
            std::io::Error::last_os_error()
        )));
    }
    let _ = staging.keep();
    if let Err(error) = parent.sync_all() {
        return Err(rollback_failure(
            BoxliteError::Storage(format!(
                "checkpoint parent sync failed; durability uncertain: {error}"
            )),
            &publication,
        ));
    }
    Ok(publication)
}

impl BoxImpl {
    pub(crate) async fn export_checkpoint(&self, path: &Path) -> BoxliteResult<()> {
        let reservation = self
            .reserve(crate::litebox::operation::Action::Checkpoint)
            .await?;
        self.require_checkpoint("export a checkpoint")?;
        let (parent_path, name) = destination(path)?;
        let persisted = self.runtime.box_manager.update_box(self.id())?;
        let local_paths = persisted.checkpoint_paths.clone().ok_or_else(|| {
            BoxliteError::Unsupported(
                "source has no saved local checkpoint paths; stop and restart it before export"
                    .into(),
            )
        })?;
        let guest = persisted.checkpoint_guest.ok_or_else(|| {
            BoxliteError::InvalidState(
                "no recorded paused guest identity; resume and pause again".into(),
            )
        })?;
        let mut options = self.config.options.clone();
        for volume in &mut options.volumes {
            volume.host_path.clear();
            volume.managed_volume = None;
        }
        if matches!(options.rootfs, crate::RootfsSpec::RootfsPath(_)) {
            options.rootfs = crate::RootfsSpec::Image("checkpoint:external".into());
        }
        let application = Application {
            source_box_id: self.id().to_string(),
            guest,
            options,
            container_image_config: self.boot_image_config().await?,
            outbound_policy: persisted.outbound_policy,
            local_paths: Some(local_paths.clone()),
        };
        let session = Session::begin(self.checkpoint_control(), false).await?;
        let prepared = async {
            let (reply, files) = capture::request(
                &session.control,
                DescriptorRequest::Prepare {
                    token: session.token,
                },
                Vec::new(),
            )
            .await?;
            LocalCheckpointProvider::prepare(
                &pair::shares(&reply.metadata)?,
                files.into_iter().map(File::from).collect(),
                &local_paths,
            )
        }
        .await;
        let references = match prepared {
            Ok(references) => references,
            Err(error) => {
                session.finish().await?;
                return Err(error);
            }
        };
        let source = self.config.box_home.join("disks/disk.qcow2");
        let cancel = self.shutdown_token.child_token();
        let canceller = CancelOnDrop(cancel.clone());
        let pid = persisted
            .pid
            .ok_or_else(|| BoxliteError::Engine("paused box has no shim PID".into()))?;
        let reader = crate::util::PidFileReader::at(self.layout.pid_file_path());
        let id = self.id().clone();
        let task = tokio::spawn(async move {
            let _reservation = reservation;
            let (parent, staging) = match stage(&parent_path) {
                Ok(staged) => staged,
                Err(error) => {
                    session.finish().await?;
                    return Err(error);
                }
            };
            let disk = staging.path().join(pair::DISK);
            let worker_staging = staging.clone();
            let worker_cancel = cancel.clone();
            let copy = tokio::task::spawn_blocking(move || {
                let _staging = worker_staging;
                crate::disk::Qcow2Helper::flatten_cancellable(&source, &disk, &|| {
                    worker_cancel.is_cancelled()
                })
            });
            let result = copy
                .await
                .unwrap_or_else(|e| Err(BoxliteError::Engine(e.to_string())));
            if cancel.is_cancelled() {
                drop(session);
                capture::stop_and_join(pid, id, reader.clone()).await?;
                return Err(BoxliteError::Stopped(
                    "checkpoint copy cancelled; VM stopped".into(),
                ));
            }
            if let Err(error) = result {
                session.finish().await?;
                return Err(error);
            }
            let files = (|| -> BoxliteResult<_> {
                let memory = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(staging.path().join(pair::MEMORY))
                    .map_err(pair::invalid)?;
                let disk = File::open(staging.path().join(pair::DISK)).map_err(pair::invalid)?;
                let fds = vec![
                    memory.try_clone().map_err(pair::invalid)?.into(),
                    disk.try_clone().map_err(pair::invalid)?.into(),
                ];
                Ok((memory, disk, fds))
            })();
            let (memory, disk, fds) = match files {
                Ok(files) => files,
                Err(error) => {
                    session.finish().await?;
                    return Err(error);
                }
            };
            staging.joined.store(false, Ordering::Release);
            let result = {
                let export = capture::request(
                    &session.control,
                    DescriptorRequest::Export {
                        token: session.token,
                        metadata: serde_json::json!({"application_schema":1,"application":application,"objects":references}),
                    },
                    fds,
                );
                tokio::pin!(export);
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => {
                        session.cancel();
                        let stopped=capture::stop_and_join(pid, id.clone(), reader.clone()).await;
                        if stopped.is_ok() {let _ = export.await;staging.joined.store(true,Ordering::Release);}
                        stopped?;
                        return Err(BoxliteError::Stopped("checkpoint export cancelled; VM stopped".into()));
                    }
                    result = &mut export => result,
                }
            };
            if let Err(error) = result {
                if matches!(error, BoxliteError::Engine(_)) {
                    capture::stop_and_join(pid, id, reader.clone()).await?;
                } else {
                    session.finish().await?;
                }
                staging.joined.store(true, Ordering::Release);
                return Err(error);
            }
            staging.joined.store(true, Ordering::Release);
            let publish_cancel = cancel.clone();
            let publication = tokio::task::spawn_blocking(move || {
                memory.sync_all().map_err(pair::invalid)?;
                disk.sync_all().map_err(pair::invalid)?;
                let pair = pair::open(staging.path())?;
                pair.verify_disk()?;
                if publish_cancel.is_cancelled() {
                    return Err(BoxliteError::Stopped(
                        "checkpoint publication cancelled".into(),
                    ));
                }
                drop(pair);
                let staging = Arc::try_unwrap(staging)
                    .map_err(|_| BoxliteError::Internal("staging still has a writer".into()))?;
                publish(staging.into_directory(), &parent, &name)
            })
            .await
            .map_err(|e| BoxliteError::Engine(e.to_string()))?;
            if cancel.is_cancelled() {
                drop(session);
                capture::stop_and_join(pid, id, reader.clone()).await?;
                let error = BoxliteError::Stopped("checkpoint cancelled after publication".into());
                return Err(match publication {
                    Ok(pair) => rollback_failure(error, &pair),
                    Err(original) => original,
                });
            }
            if let Err(error) = session.finish().await {
                capture::stop_and_join(pid, id, reader.clone()).await?;
                return Err(match publication {
                    Ok(pair) => rollback_failure(error, &pair),
                    Err(original) => original,
                });
            }
            publication.map(|_| ())
        });
        let result = task
            .await
            .map_err(|e| BoxliteError::Engine(e.to_string()))?;
        drop(canceller);
        result
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

#[cfg(all(test, target_os = "linux"))]

mod publication_regression {
    use super::*;
    #[test]
    fn checkpoint_publication_sync_failure_rolls_back_its_owned_pair() {
        let home = tempfile::tempdir().unwrap();
        let (parent, staging) = stage(home.path()).unwrap();
        for name in [pair::MEMORY, pair::DISK] {
            std::fs::write(staging.path().join(name), b"owned").unwrap();
        }
        let staging = Arc::try_unwrap(staging).ok().unwrap().into_directory();
        // O_PATH permits fd-relative rename but fsync returns EBADF. This
        // reaches the real post-rename durability failure without a mock.
        let parent = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_DIRECTORY)
            .open(format!("/proc/self/fd/{}", parent.as_raw_fd()))
            .unwrap();
        let result = publish(staging, &parent, c"published");
        assert!(result.is_err(), "parent sync must fail");
        assert!(
            !home.path().join("published").exists(),
            "unsynced owned pair was not rolled back"
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod publication_tests {
    use super::*;
    fn prepared(home: &Path) -> (File, tempfile::TempDir) {
        let (parent, staging) = stage(home).unwrap();
        for name in [pair::MEMORY, pair::DISK] {
            std::fs::write(staging.path().join(name), b"owned-pair").unwrap();
        }
        (
            parent,
            Arc::try_unwrap(staging).ok().unwrap().into_directory(),
        )
    }
    #[test]
    fn checkpoint_publication_rolls_back_only_its_owned_directory() {
        let home = tempfile::tempdir().unwrap();
        let (parent, staging) = prepared(home.path());
        let publication = publish(staging, &parent, c"pair").unwrap();
        publication.rollback().unwrap();
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    }
    #[test]
    fn checkpoint_publication_preserves_replaced_public_name() {
        let home = tempfile::tempdir().unwrap();
        let (parent, staging) = prepared(home.path());
        let publication = publish(staging, &parent, c"pair").unwrap();
        std::fs::rename(home.path().join("pair"), home.path().join("original")).unwrap();
        std::fs::create_dir(home.path().join("pair")).unwrap();
        std::fs::write(home.path().join("pair/replacement"), b"replacement").unwrap();
        assert!(
            publication
                .rollback()
                .unwrap_err()
                .to_string()
                .contains("replaced")
        );
        assert_eq!(
            std::fs::read(home.path().join("pair/replacement")).unwrap(),
            b"replacement"
        );
        assert_eq!(
            std::fs::read(home.path().join("original/snapshot.mem")).unwrap(),
            b"owned-pair"
        );
    }
    #[test]
    fn checkpoint_publication_preserves_changed_members_and_layout() {
        for extra in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let (parent, staging) = prepared(home.path());
            let publication = publish(staging, &parent, c"pair").unwrap();
            let name = if extra { "extra" } else { pair::MEMORY };
            let member = home.path().join("pair").join(name);
            if !extra {
                std::fs::remove_file(&member).unwrap();
            }
            std::fs::write(&member, b"replacement").unwrap();
            assert!(publication.rollback().is_err());
            assert_eq!(std::fs::read(member).unwrap(), b"replacement");
            assert_eq!(
                std::fs::read(home.path().join("pair/snapshot.qcow2")).unwrap(),
                b"owned-pair"
            );
        }
    }
    #[test]
    fn checkpoint_publication_never_overwrites_a_destination_collision() {
        let home = tempfile::tempdir().unwrap();
        let (parent, staging) = prepared(home.path());
        std::fs::create_dir(home.path().join("pair")).unwrap();
        std::fs::write(home.path().join("pair/other"), b"existing").unwrap();
        assert!(publish(staging, &parent, c"pair").is_err());
        assert_eq!(
            std::fs::read(home.path().join("pair/other")).unwrap(),
            b"existing"
        );
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 1);
    }
}
