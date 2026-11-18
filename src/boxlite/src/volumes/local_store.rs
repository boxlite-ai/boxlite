use std::fs::{File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::VolumeInfo;
use crate::litebox::BoxManager;
use crate::litebox::config::BoxConfig;
use crate::runtime::options::MountType;
use crate::runtime::types::BoxState;

const METADATA_FILE: &str = ".metadata.json";
const PAYLOAD_DIR: &str = "_data";
const REGISTRY_LOCK: &str = ".registry.lock";
const STAGING_DIR: &str = ".staging";
const TRASH_DIR: &str = ".trash";

#[derive(Debug, Clone)]
pub(crate) enum ResolvedLocalMountPayload {
    WholeVolume,
    SubDirectory { path: String },
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedLocalMount {
    pub volume_id: String,
    pub payload_root: PathBuf,
    pub target: String,
    pub read_only: bool,
    pub payload: ResolvedLocalMountPayload,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum VolumeReferenceMode {
    Selector,
    CanonicalId,
}

/// Managed-volume backend for the local runtime. Owns the on-disk layout
/// under `~/.boxlite/volumes` (one canonical UUID directory per volume, with
/// `.metadata.json` and a `_data/` payload) and serializes every mutation
/// through a flock on `.registry.lock`.
#[derive(Debug, Clone)]
pub(crate) struct LocalVolumeStore {
    root: PathBuf,
    box_manager: BoxManager,
}

#[derive(Debug, Serialize, Deserialize)]
struct VolumeMetadata {
    version: u32,
    id: String,
    name: String,
    created_at: DateTime<Utc>,
}

impl LocalVolumeStore {
    pub(crate) fn new(root: PathBuf, box_manager: BoxManager) -> BoxliteResult<Self> {
        for path in [root.clone(), root.join(STAGING_DIR), root.join(TRASH_DIR)] {
            std::fs::create_dir_all(&path)
                .map_err(|error| storage("create volume directory", &path, error))?;
        }
        let root = root
            .canonicalize()
            .map_err(|error| storage("resolve volume root", &root, error))?;
        Ok(Self { root, box_manager })
    }

    /// Startup-only cleanup: remove leftovers from crashed staging or trash
    /// operations. Never touches canonical volume directories.
    pub(crate) fn recover(&self) -> BoxliteResult<()> {
        self.recover_impl(|_| Ok(()))
    }

    fn recover_impl(
        &self,
        before_cleanup: impl Fn(&Path) -> BoxliteResult<()>,
    ) -> BoxliteResult<()> {
        self.with_registry_lock(true, || {
            for directory in [STAGING_DIR, TRASH_DIR] {
                let root = self.root.join(directory);
                let entries = std::fs::read_dir(&root)
                    .map_err(|error| storage("read volume recovery directory", &root, error))?;
                for entry in entries {
                    let entry = entry
                        .map_err(|error| storage("read volume recovery entry", &root, error))?;
                    let path = entry.path();
                    let result = before_cleanup(&path).and_then(|()| remove_entry_nofollow(&path));
                    if let Err(error) = result {
                        tracing::error!(path = %path.display(), %error, "Failed to remove local volume recovery entry");
                    }
                }
            }
            Ok(())
        })
    }

    pub(crate) fn create(&self, name: Option<&str>) -> BoxliteResult<VolumeInfo> {
        self.create_impl(name, |_, _| {})
    }

    fn create_impl(
        &self,
        name: Option<&str>,
        before_publish: impl FnOnce(&str, &Path),
    ) -> BoxliteResult<VolumeInfo> {
        if let Some(name) = name {
            validate_name(name)?;
            if validate_id(name).is_ok() {
                return Err(BoxliteError::InvalidArgument(format!(
                    "volume name {name:?} must not be a canonical UUID"
                )));
            }
        }
        self.with_registry_lock(true, || {
            let existing = self.scan_valid()?;
            if let Some(name) = name
                && existing.iter().any(|volume| volume.name == name)
            {
                return Err(BoxliteError::AlreadyExists(format!("volume name {name:?}")));
            }
            if let Some(name) = name
                && validate_id(name).is_ok()
            {
                return Err(BoxliteError::InvalidArgument(format!(
                    "volume name {name:?} must not be a canonical UUID; omit the name to use \
                     the generated id"
                )));
            }

            let id = Uuid::new_v4().to_string();
            let final_path = self.root.join(&id);
            if path_exists(&final_path)? {
                return Err(BoxliteError::AlreadyExists(format!("volume id {id}")));
            }
            let name = name.unwrap_or(&id).to_string();
            let metadata = VolumeMetadata {
                version: 1,
                id: id.clone(),
                name: name.clone(),
                created_at: Utc::now(),
            };
            // Build the volume inside .staging, then rename it into place so
            // a partially written volume never appears in the registry.
            let operation = Uuid::new_v4().simple().to_string();
            let staging = self.root.join(STAGING_DIR).join(&operation);
            std::fs::create_dir(&staging)
                .map_err(|error| storage("create volume staging", &staging, error))?;
            if let Err(error) = std::fs::create_dir(staging.join(PAYLOAD_DIR)) {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(storage("create volume payload", &staging, error));
            }
            let metadata_path = staging.join(METADATA_FILE);
            let write_result = serde_json::to_vec_pretty(&metadata)
                .map_err(|error| {
                    BoxliteError::Internal(format!("serialize volume metadata: {error}"))
                })
                .and_then(|json| {
                    std::fs::write(&metadata_path, json)
                        .map_err(|error| volume_storage(&id, "write volume metadata", error))
                });
            if let Err(error) = write_result {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(error);
            }
            // Hook runs before the rename publishes the volume (used by
            // callers that must observe the payload while it is still hidden).
            before_publish(&id, &staging);
            if let Err(error) = std::fs::rename(&staging, &final_path) {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(volume_storage(&id, "publish volume", error));
            }
            Ok(VolumeInfo {
                id,
                name,
                created_at: metadata.created_at,
                size_bytes: None,
            })
        })
    }

    pub(crate) fn list(&self) -> BoxliteResult<Vec<VolumeInfo>> {
        self.with_registry_lock(false, || {
            let mut volumes = Vec::new();
            let mut names = std::collections::HashSet::new();
            for entry in self.canonical_entries()? {
                let id = entry
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned();
                match self.read_info(&entry) {
                    Ok(info) => {
                        if !names.insert(info.name.clone()) {
                            return Err(BoxliteError::MetadataError(format!(
                                "duplicate volume name {:?} in local store",
                                info.name
                            )));
                        }
                        volumes.push(info);
                    }
                    Err(error) => {
                        tracing::warn!(volume_id = %id, %error, "Skipping invalid local volume");
                    }
                }
            }
            volumes.sort_by(|left, right| {
                right
                    .created_at
                    .cmp(&left.created_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
            Ok(volumes)
        })
    }

    pub(crate) fn get(&self, id: &str) -> BoxliteResult<VolumeInfo> {
        validate_id(id)?;
        self.with_registry_lock(false, || {
            let path = self.root.join(id);
            if !path_exists(&path)? {
                return Err(BoxliteError::NotFound(format!("volume {id}")));
            }
            self.read_info(&path)
        })
    }

    pub(crate) fn remove(&self, id: &str, force: bool) -> BoxliteResult<()> {
        self.remove_impl(id, force, |_| Ok(()))
    }

    fn remove_impl(
        &self,
        id: &str,
        force: bool,
        before_cleanup: impl FnOnce(&Path) -> BoxliteResult<()>,
    ) -> BoxliteResult<()> {
        validate_id(id)?;
        let Some(trash) = self.with_registry_lock(true, || {
            let path = self.root.join(id);
            if !path_exists(&path)? {
                return if force {
                    Ok(None)
                } else {
                    Err(BoxliteError::NotFound(format!("volume {id}")))
                };
            }
            // Refuse deletion while any box still mounts this volume, in
            // either the legacy or typed mount format.
            for config in self.box_manager.all_box_configs()? {
                let legacy_holder = config
                    .options
                    .volumes
                    .iter()
                    .any(|mount| mount.managed_volume.as_deref() == Some(id));
                let typed_holder = config.options.mounts.iter().any(|mount| {
                    mount.mount_type == MountType::Volume && mount.source.as_deref() == Some(id)
                });
                if legacy_holder || typed_holder {
                    return Err(BoxliteError::InvalidState(format!(
                        "volume {id} is still referenced by box {}",
                        config.id
                    )));
                }
            }

            // Rename out of the registry first so the volume disappears
            // atomically; deleting the payload below is best-effort — a crash
            // mid-way leaves trash for recover() to clean on next startup.
            let operation = Uuid::new_v4().simple().to_string();
            let trash = self.root.join(TRASH_DIR).join(operation);
            if path_exists(&trash)? {
                return Err(BoxliteError::AlreadyExists(format!(
                    "volume remove operation for {id}"
                )));
            }
            std::fs::rename(&path, &trash)
                .map_err(|error| storage("move volume to trash", &path, error))?;
            Ok(Some(trash))
        })?
        else {
            return Ok(());
        };
        let result = before_cleanup(&trash).and_then(|()| remove_entry_nofollow(&trash));
        if let Err(error) = result {
            tracing::error!(volume_id = %id, path = %trash.display(), %error, "Failed to remove local volume payload from trash");
        }
        Ok(())
    }

    pub(crate) fn add_box_with_resolved_volumes(
        &self,
        config: &mut BoxConfig,
        state: &BoxState,
        mode: VolumeReferenceMode,
    ) -> BoxliteResult<()> {
        self.add_box_impl(config, state, mode, None, || {})
    }

    pub(crate) fn add_clone_box_with_resolved_volumes(
        &self,
        config: &mut BoxConfig,
        state: &BoxState,
        mode: VolumeReferenceMode,
        base_disk_id: &crate::BaseDiskID,
    ) -> BoxliteResult<()> {
        self.add_box_impl(config, state, mode, Some(base_disk_id), || {})
    }

    fn add_box_impl(
        &self,
        config: &mut BoxConfig,
        state: &BoxState,
        mode: VolumeReferenceMode,
        base_disk_id: Option<&crate::BaseDiskID>,
        before_commit: impl FnOnce(),
    ) -> BoxliteResult<()> {
        let has_managed = config
            .options
            .volumes
            .iter()
            .any(|mount| mount.managed_volume.is_some())
            || config
                .options
                .mounts
                .iter()
                .any(|mount| mount.mount_type == MountType::Volume);
        if !has_managed {
            return self.persist_box(config, state, base_disk_id);
        }
        // Persist canonical ids, never user selectors: the stored config must
        // stay resolvable regardless of later resolution rules. Selector
        // resolution and duplicate rejection share the registry's exclusive
        // lock with holder registration.
        self.with_registry_lock(true, || {
            if !config.options.volumes.is_empty() && !config.options.mounts.is_empty() {
                return Err(BoxliteError::InvalidArgument(
                    "volumes and mounts cannot both be non-empty".into(),
                ));
            }
            let mut volume_ids = std::collections::HashSet::new();
            for mount in &mut config.options.volumes {
                if let Some(selector) = mount.managed_volume.clone() {
                    let volume = self.resolve_selector(&selector, mode)?;
                    if !volume_ids.insert(volume.id.clone()) {
                        return Err(BoxliteError::InvalidArgument(format!(
                            "volume {} is mounted more than once in box {}",
                            volume.id, config.id
                        )));
                    }
                    mount.managed_volume = Some(volume.id);
                    mount.host_path.clear();
                }
            }
            for mount in &mut config.options.mounts {
                if mount.mount_type != MountType::Volume {
                    continue;
                }
                let selector = mount.source.clone().ok_or_else(|| {
                    BoxliteError::InvalidArgument("volume mount is missing a source".into())
                })?;
                let volume = self.resolve_selector(&selector, mode)?;
                if let Some(sub_path) = mount.sub_path.as_deref() {
                    validate_sub_path(&self.root.join(&volume.id).join(PAYLOAD_DIR), sub_path)?;
                }
                if !volume_ids.insert(volume.id.clone()) {
                    return Err(BoxliteError::InvalidArgument(format!(
                        "volume {} is mounted more than once in box {}",
                        volume.id, config.id
                    )));
                }
                mount.source = Some(volume.id);
            }
            before_commit();
            self.persist_box(config, state, base_disk_id)
        })
    }

    fn persist_box(
        &self,
        config: &BoxConfig,
        state: &BoxState,
        base_disk_id: Option<&crate::BaseDiskID>,
    ) -> BoxliteResult<()> {
        match base_disk_id {
            Some(id) => self.box_manager.add_clone_box(config, state, id),
            None => self.box_manager.add_box(config, state),
        }
    }

    /// Resolve every managed-volume reference (legacy and typed formats) to
    /// its current payload path for a box boot. Mirrors the validation in
    /// add_box_impl so a persisted config always boots.
    pub(crate) fn resolve_for_boot(
        &self,
        options: &crate::runtime::options::BoxOptions,
    ) -> BoxliteResult<Vec<ResolvedLocalMount>> {
        if !options.volumes.is_empty() && !options.mounts.is_empty() {
            return Err(BoxliteError::InvalidArgument(
                "volumes and mounts cannot both be non-empty".into(),
            ));
        }
        let has_managed = options
            .volumes
            .iter()
            .any(|mount| mount.managed_volume.is_some())
            || options
                .mounts
                .iter()
                .any(|mount| mount.mount_type == MountType::Volume);
        if !has_managed {
            return Ok(Vec::new());
        }
        self.with_registry_lock(false, || {
            let mut resolved = Vec::new();
            let mut volume_ids = std::collections::HashSet::new();
            for mount in &options.volumes {
                let Some(selector) = mount.managed_volume.as_deref() else {
                    continue;
                };
                let volume = self.resolve_selector(selector, VolumeReferenceMode::CanonicalId)?;
                if !volume_ids.insert(volume.id.clone()) {
                    return Err(BoxliteError::InvalidArgument(format!(
                        "volume {} is mounted more than once",
                        volume.id
                    )));
                }
                resolved.push(ResolvedLocalMount {
                    payload_root: self.root.join(&volume.id).join(PAYLOAD_DIR),
                    volume_id: volume.id,
                    target: mount.guest_path.clone(),
                    read_only: mount.read_only,
                    payload: ResolvedLocalMountPayload::WholeVolume,
                });
            }
            for mount in &options.mounts {
                if mount.mount_type != MountType::Volume {
                    continue;
                }
                let selector = mount.source.as_deref().ok_or_else(|| {
                    BoxliteError::InvalidArgument("volume mount is missing a source".into())
                })?;
                let volume = self.resolve_selector(selector, VolumeReferenceMode::CanonicalId)?;
                let payload = match mount.sub_path.as_deref() {
                    None => ResolvedLocalMountPayload::WholeVolume,
                    Some(path) => {
                        validate_sub_path(&self.root.join(&volume.id).join(PAYLOAD_DIR), path)?;
                        ResolvedLocalMountPayload::SubDirectory {
                            path: path.to_owned(),
                        }
                    }
                };
                if !volume_ids.insert(volume.id.clone()) {
                    return Err(BoxliteError::InvalidArgument(format!(
                        "volume {} is mounted more than once",
                        volume.id
                    )));
                }
                resolved.push(ResolvedLocalMount {
                    payload_root: self.root.join(&volume.id).join(PAYLOAD_DIR),
                    volume_id: volume.id,
                    target: mount.target.clone(),
                    read_only: mount.read_only,
                    payload,
                });
            }
            Ok(resolved)
        })
    }

    fn resolve_selector(
        &self,
        selector: &str,
        mode: VolumeReferenceMode,
    ) -> BoxliteResult<VolumeInfo> {
        match mode {
            VolumeReferenceMode::CanonicalId => {
                validate_id(selector)?;
                let path = self.root.join(selector);
                if !path_exists(&path)? {
                    return Err(BoxliteError::NotFound(format!("volume {selector}")));
                }
                self.read_info(&path)
            }
            VolumeReferenceMode::Selector => {
                validate_name(selector)?;
                if validate_id(selector).is_ok() {
                    let path = self.root.join(selector);
                    if path_exists(&path)? {
                        return self.read_info(&path);
                    }
                }
                let volume = self
                    .scan_valid()?
                    .into_iter()
                    .find(|volume| volume.name == selector)
                    .ok_or_else(|| BoxliteError::NotFound(format!("volume {selector}")))?;
                self.read_info(&self.root.join(&volume.id))
            }
        }
    }

    fn scan_valid(&self) -> BoxliteResult<Vec<VolumeInfo>> {
        let mut volumes = Vec::new();
        let mut names = std::collections::HashSet::new();
        for path in self.canonical_entries()? {
            let info = self.read_metadata(&path)?;
            if !names.insert(info.name.clone()) {
                return Err(BoxliteError::MetadataError(format!(
                    "duplicate volume name {:?} in local store",
                    info.name
                )));
            }
            volumes.push(info);
        }
        Ok(volumes)
    }

    fn canonical_entries(&self) -> BoxliteResult<Vec<PathBuf>> {
        let entries = std::fs::read_dir(&self.root)
            .map_err(|error| storage("list volumes", &self.root, error))?;
        let mut paths = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    tracing::warn!(%error, "Skipping unreadable local volume entry");
                    continue;
                }
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if Uuid::parse_str(name).is_ok_and(|id| id.to_string() == name) {
                paths.push(entry.path());
            }
        }
        Ok(paths)
    }

    fn read_metadata(&self, path: &Path) -> BoxliteResult<VolumeInfo> {
        let id = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| BoxliteError::Internal("volume path has no UTF-8 id".into()))?;
        let metadata_path = path.join(METADATA_FILE);
        let json = std::fs::read_to_string(&metadata_path)
            .map_err(|error| volume_storage(id, "read volume metadata", error))?;
        let metadata: VolumeMetadata = serde_json::from_str(&json).map_err(|error| {
            BoxliteError::MetadataError(format!("volume {id} has invalid metadata: {error}"))
        })?;
        if metadata.version != 1 {
            return Err(BoxliteError::MetadataError(format!(
                "volume {id} uses unsupported metadata version {}",
                metadata.version
            )));
        }
        if metadata.id != id {
            return Err(BoxliteError::MetadataError(format!(
                "volume directory id {id} does not match metadata id {:?}",
                metadata.id
            )));
        }
        validate_name(&metadata.name)
            .map_err(|error| BoxliteError::MetadataError(error.to_string()))?;
        Ok(VolumeInfo {
            id: metadata.id,
            name: metadata.name,
            created_at: metadata.created_at,
            size_bytes: None,
        })
    }

    fn read_info(&self, path: &Path) -> BoxliteResult<VolumeInfo> {
        let info = self.read_metadata(path)?;
        let payload = path.join(PAYLOAD_DIR);
        let payload_metadata = match std::fs::symlink_metadata(&payload) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Err(BoxliteError::MetadataError(format!(
                    "volume {} payload is missing",
                    info.id
                )));
            }
            Err(error) => return Err(volume_storage(&info.id, "inspect volume payload", error)),
        };
        if !payload_metadata.file_type().is_dir() || payload_metadata.file_type().is_symlink() {
            return Err(BoxliteError::MetadataError(format!(
                "volume {} payload is not a real directory",
                info.id
            )));
        }
        Ok(info)
    }

    /// flock-based cross-process lock over the registry: LOCK_EX for mutations
    /// (create/remove/add_box), LOCK_SH for reads. Holder checks and renames
    /// run inside one critical section with resolution, so there is no
    /// TOCTOU window between "no box references this volume" and its removal.
    /// The guard releases on drop, including on early returns.
    fn with_registry_lock<T>(
        &self,
        exclusive: bool,
        operation: impl FnOnce() -> BoxliteResult<T>,
    ) -> BoxliteResult<T> {
        let lock_path = self.root.join(REGISTRY_LOCK);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|error| storage("open volume registry lock", &lock_path, error))?;
        let operation_flags = if exclusive {
            libc::LOCK_EX
        } else {
            libc::LOCK_SH
        };
        flock(&file, operation_flags)?;
        let _guard = RegistryLockGuard(file);
        operation()
    }
}

struct RegistryLockGuard(File);

impl Drop for RegistryLockGuard {
    fn drop(&mut self) {
        let result = unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
        if result != 0 {
            tracing::warn!(error = %std::io::Error::last_os_error(), "Failed to unlock volume registry");
        }
    }
}

use std::os::unix::io::AsRawFd;

fn flock(file: &File, operation: i32) -> BoxliteResult<()> {
    loop {
        let result = unsafe { libc::flock(file.as_raw_fd(), operation) };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == ErrorKind::Interrupted {
            continue;
        }
        return Err(BoxliteError::Storage(format!(
            "failed to lock volume registry: {error}"
        )));
    }
}

fn path_exists(path: &Path) -> BoxliteResult<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(storage("inspect path", path, error)),
    }
}

/// Delete a trash entry without ever following a symlink out of the trash dir.
fn remove_entry_nofollow(path: &Path) -> BoxliteResult<()> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| storage("inspect volume trash", path, error))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        std::fs::remove_file(path).map_err(|error| storage("remove volume trash", path, error))
    } else {
        std::fs::remove_dir_all(path).map_err(|error| storage("remove volume trash", path, error))
    }
}

fn validate_id(id: &str) -> BoxliteResult<()> {
    if Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id) {
        Ok(())
    } else {
        Err(BoxliteError::InvalidArgument(format!(
            "volume id {id:?} is not a canonical UUID"
        )))
    }
}

fn validate_name(name: &str) -> BoxliteResult<()> {
    let valid = (2..=255).contains(&name.len())
        && name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(BoxliteError::InvalidArgument(format!(
            "invalid volume name {name:?}; expected 2-255 characters of [a-zA-Z0-9][a-zA-Z0-9_.-]"
        )))
    }
}

/// Reject path traversal up front, then verify every component actually
/// resolves inside `payload_root` via an O_NOFOLLOW openat walk.
fn validate_sub_path(payload_root: &Path, sub_path: &str) -> BoxliteResult<()> {
    if sub_path.is_empty()
        || sub_path.contains('\0')
        || sub_path.len() > 4096
        || sub_path.starts_with('/')
        || sub_path.ends_with('/')
        || sub_path.split('/').count() > 64
        || sub_path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || sub_path.split('/').any(|part| part.len() > 255)
    {
        return Err(BoxliteError::InvalidArgument(format!(
            "invalid volume sub_path {sub_path:?}"
        )));
    }

    use nix::fcntl::{OFlag, open, openat};
    use nix::sys::stat::Mode;
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW;
    let mut directory = open(payload_root, flags, Mode::empty())
        .map_err(|error| sub_path_io_error(payload_root, error))?;
    for component in sub_path.split('/') {
        directory = openat(&directory, component, flags, Mode::empty())
            .map_err(|error| sub_path_io_error(payload_root, error))?;
    }
    Ok(())
}

fn sub_path_io_error(_root: &Path, error: nix::errno::Errno) -> BoxliteError {
    match error {
        nix::errno::Errno::ENOENT => {
            BoxliteError::NotFound("volume sub_path does not exist".into())
        }
        nix::errno::Errno::ELOOP | nix::errno::Errno::ENOTDIR => BoxliteError::InvalidArgument(
            "volume sub_path contains a symlink or non-directory component".into(),
        ),
        _ => BoxliteError::Storage(format!("failed to resolve volume sub_path: {error}")),
    }
}

/// Error constructors deliberately omit internal volume paths: public errors
/// must not leak where the runtime stores payloads on the host.
fn storage(action: &str, _path: &Path, error: std::io::Error) -> BoxliteError {
    BoxliteError::Storage(format!("{action}: {error}"))
}

fn volume_storage(id: &str, action: &str, error: std::io::Error) -> BoxliteError {
    BoxliteError::Storage(format!("{action} for volume {id}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::options::{BoxOptions, BoxliteOptions, MountSpec, VolumeSpec};
    use crate::runtime::rt_impl::RuntimeImpl;
    use std::sync::Arc;

    #[tokio::test]
    async fn boot_resolution_returns_canonical_id_and_current_payload() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        let options = BoxOptions {
            volumes: vec![VolumeSpec {
                read_only: true,
                ..VolumeSpec::managed_volume(&volume.id, "/workspace")
            }],
            ..Default::default()
        };

        let resolved = runtime
            .local_volume_store
            .resolve_for_boot(&options)
            .expect("resolve a persisted volume for boot");
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].volume_id, volume.id);
        let expected_root = home
            .path()
            .canonicalize()
            .unwrap()
            .join("volumes")
            .join(&volume.id)
            .join(PAYLOAD_DIR);
        assert_eq!(resolved[0].payload_root, expected_root);
        assert_eq!(resolved[0].target, "/workspace");
        assert!(resolved[0].read_only);
        assert!(matches!(
            resolved[0].payload,
            ResolvedLocalMountPayload::WholeVolume
        ));
        assert!(resolved[0].payload_root.is_dir());
    }

    #[tokio::test]
    async fn boot_resolution_without_managed_volumes_skips_registry_lock() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let store = runtime.local_volume_store.clone();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let lock_task = tokio::task::spawn_blocking(move || {
            store.create_impl(Some("lock-holder"), move |_, _| {
                ready_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
            })
        });
        ready_receiver.recv().unwrap();

        let store = runtime.local_volume_store.clone();
        let mut resolve_task = tokio::task::spawn_blocking(move || {
            store.resolve_for_boot(&BoxOptions {
                volumes: vec![VolumeSpec::bind_mount("/tmp", "/data")],
                ..Default::default()
            })
        });
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(5), &mut resolve_task).await;
        release_sender.send(()).unwrap();
        lock_task.await.unwrap().unwrap();

        let resolved = match result {
            Ok(result) => result.unwrap().unwrap(),
            Err(_) => {
                resolve_task.await.unwrap().unwrap();
                panic!("host-only boot resolution must not wait for the registry lock");
            }
        };
        assert!(resolved.is_empty());
    }

    #[tokio::test]
    async fn boot_resolution_validates_sub_path_without_changing_share_root() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        let payload = runtime
            .layout
            .volumes_dir()
            .join(&volume.id)
            .join(PAYLOAD_DIR);
        std::fs::create_dir_all(payload.join("team/backend")).unwrap();
        std::fs::create_dir_all(payload.join("sibling")).unwrap();
        std::os::unix::fs::symlink("sibling", payload.join("team/link")).unwrap();
        let options = |sub_path: &str| BoxOptions {
            mounts: vec![MountSpec {
                sub_path: Some(sub_path.to_owned()),
                ..MountSpec::volume_mount(&volume.id, "/workspace")
            }],
            ..Default::default()
        };

        let resolved = runtime
            .local_volume_store
            .resolve_for_boot(&options("team/backend"))
            .expect("accept an existing subdirectory");
        assert!(matches!(
            resolved[0].payload,
            ResolvedLocalMountPayload::SubDirectory { ref path }
                if path == "team/backend"
        ));
        assert!(resolved[0].payload_root.ends_with("_data"));

        for invalid in [
            "/etc",
            "../escape",
            "team//backend",
            "team/./backend",
            "team/link",
            "team/\0backend",
        ] {
            let error = runtime
                .local_volume_store
                .resolve_for_boot(&options(invalid))
                .err()
                .unwrap_or_else(|| panic!("{invalid} must be rejected"));
            assert!(
                matches!(error, BoxliteError::InvalidArgument(_)),
                "{invalid}: {error:?}"
            );
        }
        let error = runtime
            .local_volume_store
            .resolve_for_boot(&options("team/missing"))
            .expect_err("a missing subdirectory must fail");
        assert!(matches!(error, BoxliteError::NotFound(_)), "{error:?}");
    }

    #[tokio::test]
    async fn recovery_removes_only_hidden_operation_directories() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        for directory in [STAGING_DIR, TRASH_DIR] {
            let operation = runtime
                .layout
                .volumes_dir()
                .join(directory)
                .join("operation");
            std::fs::create_dir_all(operation.join("nested")).unwrap();
            std::fs::write(operation.join("nested/file"), b"temporary").unwrap();
        }

        drop(runtime);
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .expect("runtime initialization must recover local volumes");

        for directory in [STAGING_DIR, TRASH_DIR] {
            assert!(
                std::fs::read_dir(runtime.layout.volumes_dir().join(directory))
                    .unwrap()
                    .next()
                    .is_none()
            );
        }
        assert_eq!(
            runtime.local_volume_store.get(&volume.id).unwrap().name,
            "workspace"
        );
    }

    #[tokio::test]
    async fn removal_succeeds_when_physical_trash_cleanup_fails() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        let payload = runtime
            .layout
            .volumes_dir()
            .join(&volume.id)
            .join(PAYLOAD_DIR);
        std::fs::write(payload.join("keep"), b"payload").unwrap();

        let result = runtime
            .local_volume_store
            .remove_impl(&volume.id, false, |_| {
                Err(BoxliteError::Storage("injected cleanup failure".into()))
            });
        let trash_entry = std::fs::read_dir(runtime.layout.volumes_dir().join(TRASH_DIR))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();

        assert!(trash_entry.join(PAYLOAD_DIR).join("keep").exists());
        result.expect("logical removal succeeds after the rename to trash");
        assert!(matches!(
            runtime.local_volume_store.get(&volume.id),
            Err(BoxliteError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn physical_trash_cleanup_runs_outside_registry_lock() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        let store = runtime.local_volume_store.clone();
        let volume_id = volume.id.clone();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let remove_task = tokio::task::spawn_blocking(move || {
            store.remove_impl(&volume_id, false, move |_| {
                ready_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
                Ok(())
            })
        });
        ready_receiver.recv().unwrap();

        let store = runtime.local_volume_store.clone();
        let mut create_task =
            tokio::task::spawn_blocking(move || store.create(Some("after-rename")));
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(5), &mut create_task).await;
        release_sender.send(()).unwrap();
        remove_task.await.unwrap().unwrap();

        match result {
            Ok(result) => {
                result.unwrap().unwrap();
            }
            Err(_) => {
                create_task.await.unwrap().unwrap();
                panic!("physical trash cleanup must not hold the registry lock");
            }
        }
        assert!(matches!(
            runtime.local_volume_store.get(&volume.id),
            Err(BoxliteError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn recovery_ignores_cleanup_failure_and_runtime_reopens() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let operation = runtime
            .layout
            .volumes_dir()
            .join(TRASH_DIR)
            .join("operation");
        let nested = operation.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("keep"), b"payload").unwrap();

        runtime
            .local_volume_store
            .recover_impl(|_| Err(BoxliteError::Storage("injected cleanup failure".into())))
            .expect("physical cleanup failure must not block recovery");
        assert!(operation.exists());

        drop(runtime);
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .expect("runtime must reopen after cleanup failure");
        runtime.local_volume_store.recover().unwrap();
        assert!(!operation.exists());
    }

    #[tokio::test]
    async fn public_errors_do_not_leak_internal_volume_paths() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        std::fs::remove_file(
            runtime
                .layout
                .volumes_dir()
                .join(&volume.id)
                .join(METADATA_FILE),
        )
        .unwrap();

        let error = runtime
            .local_volume_store
            .get(&volume.id)
            .expect_err("missing metadata must fail");
        assert!(
            !error.to_string().contains(home.path().to_str().unwrap()),
            "internal home path leaked in {error}"
        );
        assert!(
            error.to_string().contains(&volume.id),
            "the failing volume id is missing from {error}"
        );
    }

    #[tokio::test]
    async fn corrupted_metadata_is_isolated_and_removable() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let good = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        let bad_id = Uuid::new_v4().to_string();
        let bad_path = runtime.layout.volumes_dir().join(&bad_id);
        std::fs::create_dir_all(&bad_path).unwrap();
        std::fs::write(bad_path.join(METADATA_FILE), b"not json").unwrap();

        let listed = runtime.local_volume_store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, good.id);
        let error = runtime
            .local_volume_store
            .get(&bad_id)
            .expect_err("corrupt metadata must be diagnosable");
        assert!(matches!(error, BoxliteError::MetadataError(_)), "{error:?}");
        runtime.local_volume_store.remove(&bad_id, false).unwrap();
        assert_eq!(runtime.local_volume_store.list().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn publish_failure_cleans_staging_without_overwriting_existing_entry() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let store = runtime.local_volume_store.clone();
        let occupied_id = Arc::new(std::sync::Mutex::new(String::new()));
        let occupied_id_for_hook = Arc::clone(&occupied_id);
        let root_for_hook = store.root.clone();
        let error = store
            .create_impl(Some("workspace"), move |id, _staging| {
                *occupied_id_for_hook.lock().unwrap() = id.to_owned();
                let final_path = root_for_hook.join(id);
                std::fs::create_dir_all(&final_path).unwrap();
                std::fs::write(final_path.join("keep"), b"original").unwrap();
            })
            .expect_err("the occupied id must make publish fail");
        assert!(matches!(error, BoxliteError::Storage(_)), "{error:?}");
        let final_path = store.root.join(occupied_id.lock().unwrap().as_str());
        assert_eq!(std::fs::read(final_path.join("keep")).unwrap(), b"original");
        assert!(runtime.local_volume_store.list().unwrap().is_empty());
        assert!(
            std::fs::read_dir(store.root.join(STAGING_DIR))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[tokio::test]
    async fn worker_completion_after_caller_drop_leaves_manageable_volume() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let store = runtime.local_volume_store.clone();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let task = tokio::task::spawn_blocking(move || {
            store.create_impl(Some("workspace"), move |_, _| {
                ready_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
            })
        });
        ready_receiver.recv().unwrap();
        drop(task);
        release_sender.send(()).unwrap();

        let mut volumes = Vec::new();
        for _ in 0..100 {
            volumes = runtime.local_volume_store.list().unwrap();
            if !volumes.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(volumes.len(), 1);
        runtime.local_volume_store.get(&volumes[0].id).unwrap();
        runtime
            .local_volume_store
            .remove(&volumes[0].id, false)
            .unwrap();
    }

    #[tokio::test]
    async fn box_commit_after_caller_drop_is_manageable_and_recovers_on_restart() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        let store = runtime.local_volume_store.clone();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let lock_task = tokio::task::spawn_blocking(move || {
            store.create_impl(Some("lock-holder"), move |_, _| {
                ready_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
            })
        });
        ready_receiver.recv().unwrap();

        let create_runtime = Arc::clone(&runtime);
        let volume_id = volume.id.clone();
        let create = create_runtime.create(
            BoxOptions {
                volumes: vec![VolumeSpec::managed_volume(&volume_id, "/workspace")],
                auto_delete: Some(0),
                ..Default::default()
            },
            Some("after-timeout".to_string()),
        );
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), create).await;
        assert!(result.is_err(), "the registry lock must delay creation");
        drop(create_runtime);
        release_sender.send(()).unwrap();
        lock_task.await.unwrap().unwrap();

        let mut created = None;
        for _ in 0..100 {
            created = runtime.get("after-timeout").await.unwrap();
            if created.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let created = created.expect("the committed box remains discoverable");
        let (config, _) = runtime
            .box_manager
            .box_by_id(created.id())
            .unwrap()
            .unwrap();
        assert_eq!(
            config.options.volumes[0].managed_volume.as_deref(),
            Some(volume.id.as_str())
        );
        assert!(
            runtime
                .list_info()
                .await
                .unwrap()
                .iter()
                .any(|info| info.id == *created.id())
        );

        drop(created);
        drop(runtime);
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .expect("restart recovers the committed box");
        let recovered = runtime
            .get("after-timeout")
            .await
            .unwrap()
            .expect("the committed box survives restart");
        assert_eq!(
            recovered.info().await.unwrap().status,
            crate::BoxStatus::Configured
        );
        assert_eq!(runtime.lock_manager.allocated_count().unwrap(), 1);
        assert_eq!(runtime.disk_lock_manager.allocated_count().unwrap(), 1);

        runtime.remove("after-timeout", false).unwrap();
        runtime
            .local_volume_store
            .remove(&volume.id, false)
            .expect("removing the box releases its volume holder");
    }

    #[tokio::test]
    async fn background_persistence_retains_the_runtime_home_lock() {
        let home = tempfile::tempdir().unwrap();
        let home_dir = home.path().to_path_buf();
        let options = || BoxliteOptions {
            home_dir: home_dir.clone(),
            ..Default::default()
        };
        let runtime = RuntimeImpl::new_for_test(options()).unwrap();
        let blocker =
            rusqlite::Connection::open(runtime.layout.db_dir().join("boxlite.db")).unwrap();
        blocker.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let create_runtime = Arc::clone(&runtime);
        let mut create = Box::pin(create_runtime.create(
            BoxOptions {
                auto_delete: Some(0),
                ..Default::default()
            },
            Some("home-lock".to_string()),
        ));
        assert!(futures::poll!(&mut create).is_pending());

        drop(create);
        drop(create_runtime);
        drop(runtime);
        let reopen_home = home_dir.clone();
        let mut reopen_task = tokio::task::spawn_blocking(move || {
            RuntimeImpl::new_for_test(BoxliteOptions {
                home_dir: reopen_home,
                ..Default::default()
            })
        });
        let result =
            tokio::time::timeout(std::time::Duration::from_millis(500), &mut reopen_task).await;
        drop(blocker);
        let reopened = match result {
            Ok(result) => result.unwrap(),
            Err(_) => reopen_task.await.unwrap(),
        };
        let reopen_succeeded = reopened.is_ok();
        drop(reopened);

        assert!(
            !reopen_succeeded,
            "another runtime must not clear the old worker's lock allocations"
        );

        for _ in 0..100 {
            if let Ok(runtime) = RuntimeImpl::new_for_test(options()) {
                drop(runtime);
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the home lock must be released after background persistence finishes");
    }

    #[tokio::test]
    async fn create_returns_the_committed_box_when_a_lookup_caches_it_first() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        let store = runtime.local_volume_store.clone();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let lock_task = tokio::task::spawn_blocking(move || {
            store.create_impl(Some("lock-holder"), move |_, _| {
                ready_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
            })
        });
        ready_receiver.recv().unwrap();

        let create_runtime = Arc::clone(&runtime);
        let mut create = Box::pin(create_runtime.create(
            BoxOptions {
                volumes: vec![VolumeSpec::managed_volume(&volume.id, "/workspace")],
                auto_delete: Some(0),
                ..Default::default()
            },
            Some("race".to_string()),
        ));
        assert!(futures::poll!(&mut create).is_pending());
        release_sender.send(()).unwrap();
        lock_task.await.unwrap().unwrap();

        let cached = loop {
            if runtime.box_manager.lookup_box("race").unwrap().is_some() {
                break runtime
                    .get("race")
                    .await
                    .unwrap()
                    .expect("a concurrent lookup sees the committed box");
            }
            assert!(futures::poll!(&mut create).is_pending());
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        };

        let created = create
            .await
            .expect("a same-ID cache hit is still the successful create");
        assert_eq!(created.id(), cached.id());
    }

    #[tokio::test]
    async fn cancelled_clone_keeps_source_admission_and_persists_base_dependency() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        let source = runtime
            .create(
                BoxOptions {
                    volumes: vec![VolumeSpec::managed_volume(&volume.id, "/workspace")],
                    auto_delete: Some(0),
                    ..Default::default()
                },
                Some("source".to_string()),
            )
            .await
            .unwrap();
        let source_id = source.id().clone();
        let (source_config, source_state) =
            runtime.box_manager.box_by_id(&source_id).unwrap().unwrap();
        let source_disk = source_config.box_home.join("disks").join("disk.qcow2");
        crate::disk::Qcow2Helper::create_disk(&source_disk, true)
            .unwrap()
            .leak();
        let source_lock_id = source_state.lock_id.unwrap();

        let store = runtime.local_volume_store.clone();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let lock_task = tokio::task::spawn_blocking(move || {
            store.create_impl(Some("lock-holder"), move |_, _| {
                ready_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
            })
        });
        ready_receiver.recv().unwrap();

        let mut clone = Box::pin(source.clone_box(Default::default(), Some("clone".to_string())));
        for _ in 0..100 {
            assert!(futures::poll!(&mut clone).is_pending());
            if std::fs::read_dir(runtime.layout.boxes_dir())
                .unwrap()
                .count()
                == 2
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            std::fs::read_dir(runtime.layout.boxes_dir())
                .unwrap()
                .count(),
            2,
            "the clone must reach persistence while the registry lock is held"
        );
        drop(clone);

        let source_locker = runtime.disk_lock_manager.retrieve(source_lock_id).unwrap();
        let admission_released = crate::lock::LockGuard::try_new(source_locker.as_ref()).is_some();
        release_sender.send(()).unwrap();
        lock_task.await.unwrap().unwrap();

        let mut created = None;
        for _ in 0..100 {
            created = runtime.get("clone").await.unwrap();
            if created.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let created = created.expect("the cancelled clone eventually commits");
        let clone_id = created.id().clone();
        let backing = crate::disk::read_backing_file_path(&source_disk)
            .unwrap()
            .unwrap();
        let base = runtime
            .base_disk_mgr
            .store()
            .find_by_base_path(&backing)
            .unwrap()
            .unwrap();
        let base_id = base.id().clone();
        let base_path = base.disk_info().as_path().to_path_buf();
        assert!(
            runtime
                .base_disk_mgr
                .store()
                .dependent_boxes(&base_id)
                .unwrap()
                .contains(&clone_id.to_string()),
            "a visible clone must have its base dependency"
        );
        assert!(
            !admission_released,
            "source admission must remain owned by background persistence"
        );

        drop(created);
        drop(source);
        drop(runtime);
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        runtime
            .get("clone")
            .await
            .unwrap()
            .expect("the clone remains manageable after restart");
        assert!(
            runtime
                .base_disk_mgr
                .store()
                .dependent_boxes(&base_id)
                .unwrap()
                .contains(&clone_id.to_string())
        );
        let error = runtime
            .remove(source_id.as_str(), false)
            .expect_err("the clone dependency must protect the source");
        assert!(matches!(error, BoxliteError::InvalidState(_)));
        assert!(base_path.exists());

        runtime.remove(clone_id.as_ref(), false).unwrap();
        runtime.remove(source_id.as_str(), false).unwrap();
    }

    #[tokio::test]
    async fn user_supplied_uuid_volume_names_are_rejected() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let existing = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();

        for name in [existing.id, Uuid::new_v4().to_string()] {
            let error = runtime
                .local_volume_store
                .create(Some(&name))
                .expect_err("a user-supplied UUID must not become a volume name");
            assert!(
                matches!(error, BoxliteError::InvalidArgument(_)),
                "{error:?}"
            );
        }
        assert_eq!(runtime.local_volume_store.list().unwrap().len(), 1);

        let unnamed = runtime.local_volume_store.create(None).unwrap();
        assert_eq!(unnamed.name, unnamed.id);
    }

    fn seed_raw_volume(root: &Path, id: &str, name: &str) {
        let path = root.join(id);
        std::fs::create_dir_all(path.join(PAYLOAD_DIR)).unwrap();
        let metadata = VolumeMetadata {
            version: 1,
            id: id.to_owned(),
            name: name.to_owned(),
            created_at: Utc::now(),
        };
        std::fs::write(
            path.join(METADATA_FILE),
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn duplicate_metadata_names_fail_closed() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let root = runtime.layout.volumes_dir();
        for id in [Uuid::new_v4().to_string(), Uuid::new_v4().to_string()] {
            seed_raw_volume(&root, &id, "duplicate");
        }

        let error = runtime
            .local_volume_store
            .create(Some("another"))
            .expect_err("duplicate metadata names must fail creation");
        assert!(matches!(error, BoxliteError::MetadataError(_)), "{error:?}");
        let error = runtime
            .local_volume_store
            .list()
            .expect_err("list must not hide duplicate volume names");
        assert!(matches!(error, BoxliteError::MetadataError(_)), "{error:?}");
        let options = BoxOptions {
            volumes: vec![VolumeSpec::managed_volume("duplicate", "/workspace")],
            ..Default::default()
        };
        let local = crate::runtime::rt_impl::LocalRuntime(Arc::clone(&runtime));
        let error = crate::runtime::backend::RuntimeBackend::create(&local, options, None)
            .await
            .err()
            .expect("a duplicate name must not select an arbitrary volume");
        assert!(matches!(error, BoxliteError::MetadataError(_)), "{error:?}");
    }

    #[tokio::test]
    async fn named_volume_cannot_shadow_a_canonical_id() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let existing = runtime.local_volume_store.create(None).unwrap();

        let error = runtime
            .local_volume_store
            .create(Some(&existing.id))
            .expect_err("an existing volume's canonical id is already taken");
        assert!(matches!(error, BoxliteError::AlreadyExists(_)), "{error:?}");
        assert_eq!(
            runtime
                .local_volume_store
                .resolve_selector(&existing.id, VolumeReferenceMode::Selector)
                .unwrap()
                .id,
            existing.id
        );
    }

    #[tokio::test]
    async fn name_audit_ignores_unrelated_payload_corruption() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let good = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        let root = runtime.layout.volumes_dir();
        let bad_id = Uuid::new_v4().to_string();
        seed_raw_volume(&root, &bad_id, "unrelated");
        std::fs::remove_dir(root.join(&bad_id).join(PAYLOAD_DIR)).unwrap();

        runtime
            .local_volume_store
            .create(Some("another"))
            .expect("name audit should not require unrelated payload health");
        let options = BoxOptions {
            volumes: vec![VolumeSpec::managed_volume("workspace", "/workspace")],
            ..Default::default()
        };
        let local = crate::runtime::rt_impl::LocalRuntime(Arc::clone(&runtime));
        let box_handle = crate::runtime::backend::RuntimeBackend::create(&local, options, None)
            .await
            .expect("resolve a healthy volume by name");
        let (config, _) = runtime
            .box_manager
            .box_by_id(box_handle.id())
            .unwrap()
            .unwrap();
        assert_eq!(
            config.options.volumes[0].managed_volume.as_deref(),
            Some(good.id.as_str())
        );
        let error = runtime
            .local_volume_store
            .get(&bad_id)
            .expect_err("the selected corrupt payload must still fail");
        assert!(matches!(error, BoxliteError::MetadataError(_)), "{error:?}");
    }

    #[tokio::test]
    async fn holder_registration_and_remove_share_one_linearization() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime
            .local_volume_store
            .create(Some("workspace"))
            .unwrap();
        let box_id = crate::runtime::id::BoxIDMint::mint();
        let mut config = BoxConfig {
            id: box_id.clone(),
            name: None,
            created_at: Utc::now(),
            container: crate::litebox::config::ContainerRuntimeConfig {
                id: crate::runtime::types::ContainerID::new(),
            },
            options: BoxOptions {
                volumes: vec![VolumeSpec::managed_volume("workspace", "/workspace")],
                auto_delete: Some(0),
                ..Default::default()
            },
            engine_kind: crate::vmm::VmmKind::Libkrun,
            box_home: home.path().join("boxes").join(box_id.as_str()),
        };
        let state = BoxState::new();
        let mut removed_config = config.clone();
        let store = runtime.local_volume_store.clone();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let add_task = tokio::task::spawn_blocking(move || {
            store.add_box_impl(
                &mut config,
                &state,
                VolumeReferenceMode::Selector,
                None,
                || {
                    ready_sender.send(()).unwrap();
                    release_receiver.recv().unwrap();
                },
            )
        });
        ready_receiver.recv().unwrap();
        let remove_task = tokio::task::spawn_blocking({
            let store = runtime.local_volume_store.clone();
            let id = volume.id.clone();
            move || store.remove(&id, false)
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            !remove_task.is_finished(),
            "remove must wait for holder registration"
        );
        release_sender.send(()).unwrap();
        add_task.await.unwrap().unwrap();
        let error = remove_task
            .await
            .unwrap()
            .expect_err("the committed holder must block removal");
        assert!(matches!(error, BoxliteError::InvalidState(_)), "{error:?}");

        runtime.box_manager.remove_box(&box_id).unwrap();
        runtime
            .local_volume_store
            .remove(&volume.id, false)
            .unwrap();
        let error = runtime
            .local_volume_store
            .add_box_with_resolved_volumes(
                &mut removed_config,
                &BoxState::new(),
                VolumeReferenceMode::Selector,
            )
            .expect_err("a removed volume cannot acquire a new holder");
        assert!(matches!(error, BoxliteError::NotFound(_)), "{error:?}");
    }

    const CHILD_MODE: &str = "BOXLITE_VOLUME_TEST_CHILD";
    const CHILD_HOME: &str = "BOXLITE_VOLUME_TEST_HOME";

    #[test]
    fn concurrent_create_same_name_across_processes() {
        if std::env::var_os(CHILD_MODE).is_some() {
            let home = std::env::var_os(CHILD_HOME).unwrap();
            let database =
                crate::db::Database::open(Path::new(&home).join("db").join("boxlite.db").as_path())
                    .unwrap();
            let store = LocalVolumeStore::new(
                Path::new(&home).join("volumes"),
                BoxManager::new(crate::db::BoxStore::new(database)),
            )
            .unwrap();
            match store.create(Some("workspace")) {
                Ok(_) => std::process::exit(0),
                Err(BoxliteError::AlreadyExists(_)) => std::process::exit(2),
                Err(error) => {
                    eprintln!("unexpected create error: {error}");
                    std::process::exit(1);
                }
            }
        }

        let home = tempfile::tempdir().unwrap();
        let _database = crate::db::Database::open(&home.path().join("db").join("boxlite.db"))
            .expect("initialize the shared test database before spawning children");
        let mut children = Vec::new();
        for _ in 0..2 {
            children.push(
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "volumes::local_store::tests::concurrent_create_same_name_across_processes",
                        "--nocapture",
                    ])
                    .env(CHILD_MODE, "1")
                    .env(CHILD_HOME, home.path())
                    .spawn()
                    .unwrap(),
            );
        }
        let mut successes = 0;
        let mut conflicts = 0;
        for child in &mut children {
            let status = child.wait().unwrap();
            match status.code() {
                Some(0) => successes += 1,
                Some(2) => conflicts += 1,
                other => panic!("child failed: {other:?}"),
            }
        }
        assert_eq!(successes, 1);
        assert_eq!(conflicts, 1);
        let database =
            crate::db::Database::open(&home.path().join("db").join("boxlite.db")).unwrap();
        let store = LocalVolumeStore::new(
            home.path().join("volumes"),
            BoxManager::new(crate::db::BoxStore::new(database)),
        )
        .unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }
}
