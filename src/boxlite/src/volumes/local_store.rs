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
pub(crate) struct ResolvedLocalMount {
    pub volume_id: String,
    pub payload_root: PathBuf,
    pub target: String,
    pub read_only: bool,
    pub sub_path: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum VolumeReferenceMode {
    Selector,
    CanonicalId,
}

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

    pub(crate) fn recover(&self) -> BoxliteResult<()> {
        self.with_registry_lock(true, || {
            for directory in [STAGING_DIR, TRASH_DIR] {
                let root = self.root.join(directory);
                let entries = std::fs::read_dir(&root)
                    .map_err(|error| storage("read volume recovery directory", &root, error))?;
                for entry in entries {
                    let entry = entry
                        .map_err(|error| storage("read volume recovery entry", &root, error))?;
                    remove_entry_nofollow(&entry.path())?;
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
        }
        self.with_registry_lock(true, || {
            let existing = self.scan_valid()?;
            if let Some(name) = name
                && existing.iter().any(|volume| volume.name == name)
            {
                return Err(BoxliteError::AlreadyExists(format!("volume name {name:?}")));
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
            for entry in self.canonical_entries()? {
                let id = entry
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned();
                match self.read_info(&entry) {
                    Ok(info) => volumes.push(info),
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
        validate_id(id)?;
        self.with_registry_lock(true, || {
            let path = self.root.join(id);
            if !path_exists(&path)? {
                return if force {
                    Ok(())
                } else {
                    Err(BoxliteError::NotFound(format!("volume {id}")))
                };
            }
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

            let operation = Uuid::new_v4().simple().to_string();
            let trash = self.root.join(TRASH_DIR).join(operation);
            if path_exists(&trash)? {
                return Err(BoxliteError::AlreadyExists(format!(
                    "volume remove operation for {id}"
                )));
            }
            std::fs::rename(&path, &trash)
                .map_err(|error| storage("move volume to trash", &path, error))?;
            remove_entry_nofollow(&trash).map_err(|error| {
                BoxliteError::Storage(format!("remove payload for volume {id}: {error}"))
            })
        })
    }

    pub(crate) fn add_box_with_resolved_volumes(
        &self,
        config: &mut BoxConfig,
        state: &BoxState,
        mode: VolumeReferenceMode,
    ) -> BoxliteResult<()> {
        self.add_box_impl(config, state, mode, || {})
    }

    fn add_box_impl(
        &self,
        config: &mut BoxConfig,
        state: &BoxState,
        mode: VolumeReferenceMode,
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
            return self.box_manager.add_box(config, state);
        }
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
            self.box_manager.add_box(config, state)
        })
    }

    pub(crate) fn resolve_for_boot(
        &self,
        options: &crate::runtime::options::BoxOptions,
    ) -> BoxliteResult<Vec<ResolvedLocalMount>> {
        self.with_registry_lock(false, || {
            if !options.volumes.is_empty() && !options.mounts.is_empty() {
                return Err(BoxliteError::InvalidArgument(
                    "volumes and mounts cannot both be non-empty".into(),
                ));
            }
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
                    sub_path: None,
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
                if let Some(sub_path) = mount.sub_path.as_deref() {
                    validate_sub_path(&self.root.join(&volume.id).join(PAYLOAD_DIR), sub_path)?;
                }
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
                    sub_path: mount.sub_path.clone(),
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
        let volume = runtime.volume_store.create(Some("workspace")).unwrap();
        let options = BoxOptions {
            volumes: vec![VolumeSpec {
                read_only: true,
                ..VolumeSpec::managed_volume(&volume.id, "/workspace")
            }],
            ..Default::default()
        };

        let resolved = runtime
            .volume_store
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
        assert!(resolved[0].sub_path.is_none());
        assert!(resolved[0].payload_root.is_dir());
    }

    #[tokio::test]
    async fn boot_resolution_validates_sub_path_without_changing_share_root() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime.volume_store.create(Some("workspace")).unwrap();
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
            .volume_store
            .resolve_for_boot(&options("team/backend"))
            .expect("accept an existing subdirectory");
        assert_eq!(resolved[0].sub_path.as_deref(), Some("team/backend"));
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
                .volume_store
                .resolve_for_boot(&options(invalid))
                .err()
                .unwrap_or_else(|| panic!("{invalid} must be rejected"));
            assert!(
                matches!(error, BoxliteError::InvalidArgument(_)),
                "{invalid}: {error:?}"
            );
        }
        let error = runtime
            .volume_store
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
        let volume = runtime.volume_store.create(Some("workspace")).unwrap();
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
            runtime.volume_store.get(&volume.id).unwrap().name,
            "workspace"
        );
    }

    #[tokio::test]
    async fn public_errors_do_not_leak_internal_volume_paths() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let volume = runtime.volume_store.create(Some("workspace")).unwrap();
        std::fs::remove_file(
            runtime
                .layout
                .volumes_dir()
                .join(&volume.id)
                .join(METADATA_FILE),
        )
        .unwrap();

        let error = runtime
            .volume_store
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
        let good = runtime.volume_store.create(Some("workspace")).unwrap();
        let bad_id = Uuid::new_v4().to_string();
        let bad_path = runtime.layout.volumes_dir().join(&bad_id);
        std::fs::create_dir_all(&bad_path).unwrap();
        std::fs::write(bad_path.join(METADATA_FILE), b"not json").unwrap();

        let listed = runtime.volume_store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, good.id);
        let error = runtime
            .volume_store
            .get(&bad_id)
            .expect_err("corrupt metadata must be diagnosable");
        assert!(matches!(error, BoxliteError::MetadataError(_)), "{error:?}");
        runtime.volume_store.remove(&bad_id, false).unwrap();
        assert_eq!(runtime.volume_store.list().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn publish_failure_cleans_staging_without_overwriting_existing_entry() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let store = runtime.volume_store.clone();
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
        assert!(runtime.volume_store.list().unwrap().is_empty());
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
        let store = runtime.volume_store.clone();
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
            volumes = runtime.volume_store.list().unwrap();
            if !volumes.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(volumes.len(), 1);
        runtime.volume_store.get(&volumes[0].id).unwrap();
        runtime.volume_store.remove(&volumes[0].id, false).unwrap();
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
            .volume_store
            .create(Some("another"))
            .expect_err("duplicate metadata names must fail creation");
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
    async fn name_audit_ignores_unrelated_payload_corruption() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let good = runtime.volume_store.create(Some("workspace")).unwrap();
        let root = runtime.layout.volumes_dir();
        let bad_id = Uuid::new_v4().to_string();
        seed_raw_volume(&root, &bad_id, "unrelated");
        std::fs::remove_dir(root.join(&bad_id).join(PAYLOAD_DIR)).unwrap();

        runtime
            .volume_store
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
            .volume_store
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
        let volume = runtime.volume_store.create(Some("workspace")).unwrap();
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
        let store = runtime.volume_store.clone();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let add_task = tokio::task::spawn_blocking(move || {
            store.add_box_impl(&mut config, &state, VolumeReferenceMode::Selector, || {
                ready_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
            })
        });
        ready_receiver.recv().unwrap();
        let remove_task = tokio::task::spawn_blocking({
            let store = runtime.volume_store.clone();
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
        runtime.volume_store.remove(&volume.id, false).unwrap();
        let error = runtime
            .volume_store
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
