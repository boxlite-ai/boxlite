//! Local catalog ownership: one cross-process lease covers publication and use.

mod archive;
pub(crate) mod cloud;
#[cfg(test)]
mod tests;

use super::{CheckpointBackend, CheckpointInfo, validate_name};
use crate::db::checkpoint::CheckpointStore;
use crate::litebox::SharedBoxImpl;
use crate::litebox::checkpoint::pair::{self, invalid};
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::{BoxStatus, BoxliteError, BoxliteResult, CheckpointImportOptions, LiteBox};
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub(crate) struct Catalog {
    store: CheckpointStore,
    root: PathBuf,
}

impl Catalog {
    pub(crate) fn new(db: crate::db::Database, root: PathBuf) -> BoxliteResult<Self> {
        std::fs::create_dir_all(&root).map_err(invalid)?;
        let catalog = Self {
            store: CheckpointStore(db),
            root,
        };
        let _lease = catalog.lease()?;
        for mut info in catalog.store.list(None)? {
            if info.status == "creating" {
                info.status = "failed".into();
                info.error = Some("checkpoint creation interrupted before publication".into());
                catalog.store.update(&info)?;
            } else if info.status == "deleting" {
                catalog.erase(&info.id)?;
            }
        }
        // Archive extraction never starts native work. A crash can leave these
        // unregistered temporary directories, unlike retained capture stages.
        for entry in std::fs::read_dir(&catalog.root).map_err(invalid)? {
            let entry = entry.map_err(invalid)?;
            if entry.file_name().to_string_lossy().starts_with(".archive-")
                && entry.file_type().map_err(invalid)?.is_dir()
            {
                std::fs::remove_dir_all(entry.path()).map_err(invalid)?;
            }
        }
        Ok(catalog)
    }

    fn lease(&self) -> BoxliteResult<File> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.root.join(".operation.lock"))
            .map_err(invalid)?;
        // Each operation opens a distinct descriptor. Closing the owner releases
        // flock even after caller cancellation; no lock is held by a borrowed task.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                return Err(BoxliteError::InvalidState(
                    "checkpoint catalog is in use".into(),
                ));
            }
            return Err(invalid(error));
        }
        Ok(file)
    }

    fn directory(&self, id: &str) -> BoxliteResult<PathBuf> {
        let id = uuid::Uuid::parse_str(id).map_err(invalid)?;
        Ok(self.root.join(id.to_string()))
    }

    fn selected(&self, source: Option<&str>, key: &str) -> BoxliteResult<CheckpointInfo> {
        validate_name(key)?;
        self.store
            .get(source, key)?
            .ok_or_else(|| BoxliteError::NotFound(format!("checkpoint '{key}'")))
    }

    fn ready(&self, source: Option<&str>, key: &str) -> BoxliteResult<CheckpointInfo> {
        let info = self.selected(source, key)?;
        if info.status != "ready" {
            return Err(BoxliteError::InvalidState(format!(
                "checkpoint '{}' is {}",
                info.id, info.status
            )));
        }
        Ok(info)
    }

    fn erase(&self, id: &str) -> BoxliteResult<()> {
        for directory in [self.directory(id)?, self.root.join(format!(".stage-{id}"))] {
            match std::fs::remove_dir_all(directory) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(invalid(error)),
            }
        }
        File::open(&self.root)
            .and_then(|file| file.sync_all())
            .map_err(invalid)?;
        self.store.remove(id)
    }

    fn publish_import(
        &self,
        stage: tempfile::TempDir,
        mut info: CheckpointInfo,
    ) -> BoxliteResult<CheckpointInfo> {
        File::open(stage.path().join("pair"))
            .and_then(|file| file.sync_all())
            .map_err(invalid)?;
        File::open(stage.path())
            .and_then(|file| file.sync_all())
            .map_err(invalid)?;
        self.store.insert(&info)?;
        let result = (|| {
            crate::checkpoint_transport::rename_exclusive(
                stage.path(),
                &self.directory(&info.id)?,
            )?;
            let _ = stage.keep();
            File::open(&self.root)
                .and_then(|file| file.sync_all())
                .map_err(invalid)?;
            info.status = "ready".into();
            self.store.update(&info)
        })();
        if let Err(error) = result {
            info.status = "failed".into();
            info.error = Some(error.to_string());
            self.store.update(&info)?;
            return Err(error);
        }
        Ok(info)
    }
}

pub(crate) struct LocalCheckpoints {
    runtime: SharedRuntimeImpl,
    source: Option<SharedBoxImpl>,
}

impl LocalCheckpoints {
    pub(crate) fn new(runtime: SharedRuntimeImpl, source: Option<SharedBoxImpl>) -> Self {
        Self { runtime, source }
    }
    fn source_id(&self) -> Option<&str> {
        self.source.as_ref().map(|source| source.id().as_str())
    }

    async fn capture(&self, name: Option<String>) -> BoxliteResult<CheckpointInfo> {
        let source = self
            .source
            .as_ref()
            .ok_or_else(|| BoxliteError::Unsupported("capture requires a source box".into()))?;
        crate::vmm::checkpoint::support::check_host(
            crate::vmm::checkpoint::support::Host::current(),
        )?;
        source
            .check_operation(crate::litebox::operation::Action::Checkpoint)
            .await?;
        let catalog = self.runtime.checkpoint_catalog.clone();
        let _lease = acquire(catalog.clone()).await?;
        let id = uuid::Uuid::new_v4().to_string();
        let name = name.unwrap_or_else(|| format!("checkpoint-{id}"));
        validate_name(&name)?;
        let mut info = CheckpointInfo {
            id,
            box_id: source.id().to_string(),
            name,
            created_at: chrono::Utc::now().timestamp(),
            status: "creating".into(),
            error: None,
            cpus: 0,
            memory_bytes: 0,
            container_disk_bytes: 0,
            size_bytes: 0,
        };
        catalog.store.insert(&info)?;
        let staging = catalog.root.join(format!(".stage-{}", info.id));
        let result = async {
            std::fs::create_dir(&staging).map_err(invalid)?;
            source.export_checkpoint(&staging.join("pair")).await?;
            let stage = staging.clone();
            let captured = tokio::task::spawn_blocking(move || {
                let pair = pair::open(&stage.join("pair"))?;
                pair.verify_disk()?;
                let resources: crate::BoxResources =
                    serde_json::from_value(pair.dependencies.application["resources"].clone())
                        .map_err(invalid)?;
                pair::validate_resources(resources, &pair.dependencies)?;
                let boot = pair
                    .dependencies
                    .boot_disk_path
                    .as_ref()
                    .ok_or_else(|| invalid("missing boot path"))?;
                copy_boot(boot, &stage.join("boot.raw"), &pair.dependencies)?;
                let size = pair
                    .memory
                    .metadata()
                    .map_err(invalid)?
                    .len()
                    .checked_add(pair.disk.metadata().map_err(invalid)?.len())
                    .and_then(|size| size.checked_add(pair.dependencies.boot_disk_bytes))
                    .ok_or_else(|| invalid("managed size overflow"))?;
                File::open(&stage)
                    .and_then(|file| file.sync_all())
                    .map_err(invalid)?;
                Ok::<_, BoxliteError>((pair.dependencies, size, resources.cpus))
            })
            .await
            .map_err(invalid)??;
            info.cpus = u16::from(captured.2);
            info.memory_bytes = captured.0.memory_bytes;
            info.container_disk_bytes = captured.0.container_disk_bytes;
            info.size_bytes = captured.1;
            crate::checkpoint_transport::rename_exclusive(&staging, &catalog.directory(&info.id)?)?;
            File::open(&catalog.root)
                .and_then(|file| file.sync_all())
                .map_err(invalid)?;
            info.status = "ready".into();
            catalog.store.update(&info)?;
            Ok::<_, BoxliteError>(info.clone())
        }
        .await;
        if let Err(error) = &result {
            info.status = "failed".into();
            info.error = Some(error.to_string());
            catalog.store.update(&info)?;
            // A failed native export may have retained writers. Keep its stage;
            // remove refuses cleanup until the source writer is known gone.
        }
        result
    }

    async fn restore(
        &self,
        key: &str,
        name: Option<String>,
        operation: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        let catalog = self.runtime.checkpoint_catalog.clone();
        let _lease = acquire(catalog.clone()).await?;
        let info = catalog.ready(self.source_id(), key)?;
        let directory = catalog.directory(&info.id)?;
        let marker = if let Some(operation_id) = operation {
            let directory_for_digest = directory.clone();
            let digest =
                tokio::task::spawn_blocking(move || archive::content_digest(&directory_for_digest))
                    .await
                    .map_err(invalid)??;
            Some(super::ImportIdentity {
                operation_id,
                checkpoint_id: info.id.clone(),
                digest,
            })
        } else {
            None
        };
        if let Some(marker) = &marker {
            for (config, state) in
                crate::db::BoxStore::new(self.runtime.box_manager.db()).list_all()?
            {
                if let Some(existing) = &state.checkpoint_import_identity
                    && existing.operation_id == marker.operation_id
                {
                    if existing != marker
                        || config.name != name
                        || state.status != BoxStatus::Paused
                    {
                        return Err(BoxliteError::InvalidState("checkpoint import operation exists with different content, name or state".into()));
                    }
                    let expected_id = config.id.clone();
                    let (box_impl, _) = self.runtime.get_or_create_box_impl(config, state);
                    if box_impl.id() != &expected_id {
                        return Err(invalid("published checkpoint target identity mismatch"));
                    }
                    box_impl
                        .check_operation(crate::litebox::operation::Action::Checkpoint)
                        .await?;
                    return Ok(crate::runtime::rt_impl::litebox_from_impl(box_impl));
                }
            }
        }
        crate::runtime::checkpoint_import::import_managed_checkpoint(
            &self.runtime,
            &directory.join("pair"),
            CheckpointImportOptions { name },
            directory.join("boot.raw"),
            marker,
        )
        .await
    }
}

async fn acquire(catalog: Catalog) -> BoxliteResult<File> {
    tokio::task::spawn_blocking(move || catalog.lease())
        .await
        .map_err(invalid)?
}

pub(super) fn copy_boot(
    source: &Path,
    destination: &Path,
    dependencies: &crate::CheckpointDependencies,
) -> BoxliteResult<()> {
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(source)
        .map_err(invalid)?;
    if input.metadata().map_err(invalid)?.len() != dependencies.boot_disk_bytes
        || hex::encode(pair::digest(&input, 0, dependencies.boot_disk_bytes)?)
            != dependencies.boot_disk_sha256
    {
        return Err(invalid("managed boot dependency length/checksum mismatch"));
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(destination)
        .map_err(invalid)?;
    std::io::copy(&mut input, &mut output).map_err(invalid)?;
    output.sync_all().map_err(invalid)
}

#[async_trait::async_trait]
impl CheckpointBackend for LocalCheckpoints {
    async fn create(&self, name: Option<String>) -> BoxliteResult<CheckpointInfo> {
        let owner = Self::new(self.runtime.clone(), self.source.clone());
        tokio::spawn(async move { owner.capture(name).await })
            .await
            .map_err(invalid)?
    }
    async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>> {
        self.runtime.checkpoint_catalog.store.list(self.source_id())
    }
    async fn get(&self, key: &str) -> BoxliteResult<Option<CheckpointInfo>> {
        self.runtime
            .checkpoint_catalog
            .store
            .get(self.source_id(), key)
    }
    async fn remove(&self, key: &str, force: bool) -> BoxliteResult<()> {
        let catalog = self.runtime.checkpoint_catalog.clone();
        let runtime = self.runtime.clone();
        let source = self.source_id().map(str::to_owned);
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || {
            let _lease = catalog.lease()?;
            let mut info = match catalog.selected(source.as_deref(), &key) {
                Err(BoxliteError::NotFound(_)) if force => return Ok(()),
                result => result?,
            };
            if catalog.root.join(format!(".stage-{}", info.id)).exists() {
                let source = runtime.layout.boxes_dir().join(&info.box_id);
                let stopped = runtime.box_manager.lookup_box(&info.box_id)?.is_none_or(|(_, state)| {
                    state.status == BoxStatus::Stopped && state.pid.is_none()
                        && source.join("shim.pid").symlink_metadata().is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                });
                if !stopped {
                    return Err(BoxliteError::InvalidState("failed checkpoint staging may still have native writers; stop its source first".into()));
                }
            }
            info.status = "deleting".into();
            catalog.store.update(&info)?;
            catalog.erase(&info.id)
        }).await.map_err(invalid)?
    }
    async fn create_from(&self, key: &str, name: Option<String>) -> BoxliteResult<LiteBox> {
        let owner = Self::new(self.runtime.clone(), self.source.clone());
        let key = key.to_owned();
        tokio::spawn(async move { owner.restore(&key, name, None).await })
            .await
            .map_err(invalid)?
    }
    async fn create_from_operation(
        &self,
        key: &str,
        name: Option<String>,
        operation: &str,
    ) -> BoxliteResult<LiteBox> {
        validate_name(operation)?;
        let owner = Self::new(self.runtime.clone(), self.source.clone());
        let key = key.to_owned();
        let operation = operation.to_owned();
        tokio::spawn(async move { owner.restore(&key, name, Some(operation)).await })
            .await
            .map_err(invalid)?
    }
    async fn export_archive(&self, key: &str, path: &Path) -> BoxliteResult<()> {
        let catalog = self.runtime.checkpoint_catalog.clone();
        let source = self.source_id().map(str::to_owned);
        let key = key.to_owned();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let _lease = catalog.lease()?;
            let info = catalog.ready(source.as_deref(), &key)?;
            archive::pack(&catalog.directory(&info.id)?, &info, &path)
        })
        .await
        .map_err(invalid)?
    }
    async fn import_archive(&self, path: &Path, operation: &str) -> BoxliteResult<CheckpointInfo> {
        let id = uuid::Uuid::parse_str(operation)
            .map_err(|_| {
                BoxliteError::InvalidArgument("managed import operation must be a UUID".into())
            })?
            .to_string();
        let catalog = self.runtime.checkpoint_catalog.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let _lease = catalog.lease()?;
            archive::unpack(&catalog, &path, &id)
        })
        .await
        .map_err(invalid)?
    }
    async fn import_pair(
        &self,
        path: &Path,
        options: cloud::CloudCheckpointImportOptions,
    ) -> BoxliteResult<CheckpointInfo> {
        let catalog = self.runtime.checkpoint_catalog.clone();
        let runtime = self.runtime.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || cloud::register(&runtime, &catalog, &path, options))
            .await
            .map_err(invalid)?
    }
}
