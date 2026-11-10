//! One published directory owns an immutable archive and its catalog record.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tempfile::TempDir;

use super::{CheckpointInfo, CheckpointState, checked_name};
use crate::litebox::archive::sha256_file;
use crate::{BoxliteError, BoxliteResult};

const ARCHIVE: &str = "archive.boxlite";
const RECORD: &str = "checkpoint.json";
const RECORD_LIMIT: u64 = 64 * 1024;

mod recovery;
pub(super) use recovery::Recovery;

#[derive(Clone, Debug)]
pub(super) struct Catalog {
    root: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Record {
    version: u32,
    pub info: CheckpointInfo,
    pub pinned_image: String,
    pub archive_sha256: String,
}

/// Kept until the consumer finishes reading or importing the archive.
pub(super) struct Lease {
    pub record: Record,
    pub archive: PathBuf,
    _lock: File,
}

impl Lease {
    pub fn verify(&self) -> BoxliteResult<()> {
        if sha256_file(&self.archive)? != self.record.archive_sha256 {
            return Err(storage(
                "checkpoint archive checksum does not match its record",
            ));
        }
        Ok(())
    }
}

impl Catalog {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn stage(&self) -> BoxliteResult<TempDir> {
        self.prepare()?;
        tempfile::Builder::new()
            .prefix(".creating-")
            .tempdir_in(&self.root)
            .map_err(storage)
    }

    pub fn archive_path(stage: &TempDir) -> PathBuf {
        stage.path().join(ARCHIVE)
    }

    pub fn publish(
        &self,
        stage: TempDir,
        name: Option<String>,
        source_box_id: String,
        pinned_image: String,
    ) -> BoxliteResult<CheckpointInfo> {
        let id = uuid::Uuid::new_v4().to_string();
        let name = name.unwrap_or_else(|| format!("checkpoint-{id}"));
        checked_name(&name)?;
        let archive = private_read(&Self::archive_path(&stage))?;
        let size_bytes = archive.metadata().map_err(storage)?.len();
        if size_bytes == 0 {
            return Err(storage("checkpoint archive is empty"));
        }
        archive.sync_all().map_err(storage)?;
        let record = Record {
            version: 1,
            info: CheckpointInfo {
                id,
                name,
                source_box_id,
                created_at: Utc::now(),
                size_bytes,
                state: super::CheckpointState::Ready,
                error_reason: None,
            },
            pinned_image,
            archive_sha256: sha256_file(&Self::archive_path(&stage))?,
        };
        let bytes = serde_json::to_vec_pretty(&record).map_err(storage)?;
        let mut metadata = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(stage.path().join(RECORD))
            .map_err(storage)?;
        metadata.write_all(&bytes).map_err(storage)?;
        metadata.sync_all().map_err(storage)?;
        fs::set_permissions(
            Self::archive_path(&stage),
            fs::Permissions::from_mode(0o400),
        )
        .map_err(storage)?;
        sync_directory(stage.path())?;

        // Export does not hold this lease. Publication rechecks uniqueness after
        // the slow export, including writers using another BOXLITE_HOME.
        let _catalog = self.catalog_lock(true)?;
        if self.records()?.iter().any(|existing| {
            existing.info.name == record.info.name
                || existing.info.id == record.info.name
                || existing.info.name == record.info.id
        }) {
            return Err(BoxliteError::InvalidState(format!(
                "checkpoint '{}' already exists",
                record.info.name
            )));
        }
        let destination = self.directory(&record.info.id)?;
        if destination.try_exists().map_err(storage)? {
            return Err(storage("checkpoint ID already exists"));
        }
        fs::rename(stage.path(), &destination).map_err(storage)?;
        // The temporary path has gone; its destructor cannot erase the
        // published directory, even if syncing the parent reports failure.
        drop(stage);
        sync_directory(&self.root)?;
        Ok(record.info)
    }

    pub fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>> {
        if !self.root.try_exists().map_err(storage)? {
            return Ok(Vec::new());
        }
        let _catalog = self.catalog_lock(false)?;
        let mut records = self.records()?;
        records.sort_by(|a, b| {
            b.info
                .created_at
                .cmp(&a.info.created_at)
                .then(a.info.id.cmp(&b.info.id))
        });
        Ok(records.into_iter().map(|record| record.info).collect())
    }

    pub fn get(&self, key: &str) -> BoxliteResult<Lease> {
        checked_name(key)?;
        if !self.root.try_exists().map_err(storage)? {
            return Err(missing(key));
        }
        let _catalog = self.catalog_lock(false)?;
        let record = self.find(key)?;
        if record.info.state != CheckpointState::Ready {
            return Err(BoxliteError::InvalidState(
                "checkpoint archive is not ready for use".into(),
            ));
        }
        let lock = self.record_lock(&record.info.id, false)?;
        let archive = self.archive(&record)?;
        Ok(Lease {
            record,
            archive,
            _lock: lock,
        })
    }

    pub fn info(&self, key: &str) -> BoxliteResult<CheckpointInfo> {
        checked_name(key)?;
        if !self.root.try_exists().map_err(storage)? {
            return Err(missing(key));
        }
        let _catalog = self.catalog_lock(false)?;
        let record = self.find(key)?;
        if record.info.state == CheckpointState::Ready {
            self.archive(&record)?;
        }
        Ok(record.info)
    }

    pub fn remove(&self, key: &str, force: bool) -> BoxliteResult<()> {
        checked_name(key)?;
        if !self.root.try_exists().map_err(storage)? {
            return if force { Ok(()) } else { Err(missing(key)) };
        }
        let _catalog = self.catalog_lock(true)?;
        let record = match self.find(key) {
            Err(BoxliteError::NotFound(_)) if force => return Ok(()),
            result => result?,
        };
        let _record = self.record_lock(&record.info.id, true)?;
        if self.recovery_records()?.iter().any(|recovery| {
            recovery.checkpoint_id == record.info.id && recovery.accepted_id.is_none()
        }) {
            return Err(BoxliteError::InvalidState(
                "checkpoint has an unfinished recovery".into(),
            ));
        }
        let directory = self.directory(&record.info.id)?;
        let deleting = self.root.join(format!(".deleting-{}", record.info.id));
        if directory.try_exists().map_err(storage)? {
            fs::rename(directory, &deleting).map_err(storage)?;
            sync_directory(&self.root)?;
        }
        // Keep identity/name outside recursive cleanup. A partially removed
        // archive must remain discoverable and retryable after a restart.
        let receipt = self.deletion_receipt(&record.info.id);
        if !receipt.try_exists().map_err(storage)? {
            fs::rename(deleting.join(RECORD), &receipt).map_err(storage)?;
            sync_directory(&self.root)?;
        }
        match fs::remove_dir_all(deleting) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(storage(error)),
        }
        sync_directory(&self.root)?;
        fs::remove_file(receipt).map_err(storage)?;
        sync_directory(&self.root)
    }

    fn deletion_receipt(&self, id: &str) -> PathBuf {
        self.root.join(format!(".deleting-{id}.json"))
    }

    fn archive(&self, record: &Record) -> BoxliteResult<PathBuf> {
        let archive = self.directory(&record.info.id)?.join(ARCHIVE);
        let metadata = private_read(&archive)?.metadata().map_err(storage)?;
        if metadata.len() != record.info.size_bytes {
            return Err(storage(
                "checkpoint archive length does not match its record",
            ));
        }
        Ok(archive)
    }

    fn prepare(&self) -> BoxliteResult<()> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.root)
            .map_err(storage)?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(self.root.join(".locks"))
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(storage)
    }

    fn catalog_lock(&self, exclusive: bool) -> BoxliteResult<File> {
        self.prepare()?;
        lock(&self.root.join(".catalog.lock"), exclusive)
    }

    fn record_lock(&self, id: &str, exclusive: bool) -> BoxliteResult<File> {
        // Never unlink lock files: an old descriptor and a newly created inode
        // would otherwise let import and deletion each hold an exclusive lease.
        lock(&self.root.join(".locks").join(id), exclusive)
    }

    fn directory(&self, id: &str) -> BoxliteResult<PathBuf> {
        let parsed = uuid::Uuid::parse_str(id).map_err(storage)?;
        if parsed.to_string() != id {
            return Err(storage("checkpoint ID is not canonical"));
        }
        Ok(self.root.join(id))
    }

    fn find(&self, key: &str) -> BoxliteResult<Record> {
        let records = self.records()?;
        records
            .iter()
            .find(|record| record.info.id == key)
            .or_else(|| records.iter().find(|record| record.info.name == key))
            .cloned()
            .ok_or_else(|| missing(key))
    }

    fn records(&self) -> BoxliteResult<Vec<Record>> {
        let mut records = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(storage)? {
            let entry = entry.map_err(storage)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| storage("non-UTF8 checkpoint ID"))?;
            let (id, metadata, deleting) = if let Some(suffix) = name.strip_prefix(".deleting-") {
                let id = suffix.strip_suffix(".json").unwrap_or(suffix);
                self.directory(id)?;
                if suffix.ends_with(".json") {
                    (id, entry.path(), true)
                } else {
                    if !entry.file_type().map_err(storage)?.is_dir() {
                        return Err(storage("checkpoint deletion directory is invalid"));
                    }
                    if self.deletion_receipt(id).try_exists().map_err(storage)? {
                        continue;
                    }
                    (id, entry.path().join(RECORD), true)
                }
            } else {
                if name.starts_with('.') {
                    continue;
                }
                let directory = self.directory(&name)?;
                if !entry.file_type().map_err(storage)?.is_dir() {
                    return Err(storage(format!("checkpoint '{name}' is not a directory")));
                }
                (name.as_str(), directory.join(RECORD), false)
            };
            let file = private_read(&metadata)?;
            if file.metadata().map_err(storage)?.len() > RECORD_LIMIT {
                return Err(storage("checkpoint record exceeds 64 KiB"));
            }
            let mut record: Record =
                serde_json::from_reader(file.take(RECORD_LIMIT + 1)).map_err(storage)?;
            if record.version != 1 || record.info.id != id {
                return Err(storage("checkpoint record version or ID mismatch"));
            }
            checked_name(&record.info.name)?;
            if deleting {
                record.info.state = CheckpointState::Deleting;
            }
            records.push(record);
        }
        Ok(records)
    }
}

fn lock(path: &Path, exclusive: bool) -> BoxliteResult<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(storage)?;
    let operation = if exclusive {
        libc::LOCK_EX
    } else {
        libc::LOCK_SH
    };
    // SAFETY: file owns a valid descriptor for the entire lease. flock neither
    // dereferences application memory nor outlives this owned File.
    if unsafe { libc::flock(file.as_raw_fd(), operation | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            return Err(BoxliteError::InvalidState(
                "checkpoint catalog or archive is in use".into(),
            ));
        }
        return Err(storage(error));
    }
    Ok(file)
}

fn private_read(path: &Path) -> BoxliteResult<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(storage)?;
    if !file.metadata().map_err(storage)?.is_file() {
        return Err(storage("checkpoint member is not a regular file"));
    }
    Ok(file)
}

fn sync_directory(path: &Path) -> BoxliteResult<()> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(storage)
}

fn storage(error: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Storage(format!("checkpoint catalog: {error}"))
}

fn missing(key: &str) -> BoxliteError {
    BoxliteError::NotFound(format!("checkpoint '{key}'"))
}

#[cfg(test)]
mod tests;
