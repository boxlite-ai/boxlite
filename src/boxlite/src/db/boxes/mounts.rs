//! A directory declaration belongs to the box; delivery progress belongs to
//! one VM run. Both live in the `mounts` object of the box's state row, next to
//! the outbound policy, and every write is one short transaction.
//!
//! Only the native engine reads or changes them: its mount operations, a
//! start, a clone or an export.
#![cfg_attr(
    not(all(feature = "native", target_os = "linux", target_arch = "x86_64")),
    allow(dead_code)
)]

use std::collections::{BTreeMap, BTreeSet};

use boxlite_shared::constants::{normalize_target, path_is_below};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::fmt::Display;

use super::BoxStore;
use crate::db::db_err;
use crate::litebox::mounts::{MountInfo, MountProgress, MountRequest, MountState};
use crate::runtime::advanced_options::AdvancedBoxOptions;
use crate::runtime::options::{BoxOptions, MountSpec, MountType, VolumeSpec};
use crate::runtime::types::BoxState;
use crate::volumes::{ContainerMount, ContainerMountPayload};

/// What the row keeps besides the creation options.
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    /// Added directories, and `None` where a directory was removed.
    #[serde(default)]
    changes: BTreeMap<String, Option<MountRequest>>,
    /// The progress of the run that last wrote one. No other run shows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    run: Option<Run>,
}

#[derive(Serialize, Deserialize)]
struct Run {
    pid: u32,
    started_at: Option<DateTime<Utc>>,
    targets: BTreeMap<String, MountProgress>,
}

/// The directory declarations of a box, with the progress of its current VM run.
#[derive(Debug)]
pub(crate) struct Mounts {
    /// The state the declarations were read with. A start stores its live
    /// state again together with the mounts it confirmed.
    pub state: BoxState,
    /// The directories the box boots with, by normalized target: the ones it
    /// was created with, with every committed change applied.
    pub declarations: BTreeMap<String, MountRequest>,
    /// Last committed progress of the current VM run, by target.
    pub progress: BTreeMap<String, MountProgress>,
    /// Creation targets that are no directory declaration: files and managed volumes.
    pub(crate) unmanaged: BTreeSet<String>,
    /// Creation targets whose source is a file: no directory can sit below one.
    pub(crate) files: BTreeSet<String>,
    changes: BTreeMap<String, Option<MountRequest>>,
}

/// The mounts of the creation formats, split by what their sources are on the
/// host.
struct Creation {
    directories: BTreeMap<String, MountRequest>,
    unmanaged: BTreeSet<String>,
    files: BTreeSet<String>,
}

impl Creation {
    /// No write changes the creation options after create, so they are read
    /// apart from the state row. The split inspects the host filesystem, so
    /// callers take the connection for this read alone and open no transaction
    /// around it.
    fn read(conn: &Connection, id: &str) -> BoxliteResult<Self> {
        let (volumes, mounts): (String, String) = db_err!(
            conn.query_row(
                "SELECT coalesce(json ->> '$.options.volumes', '[]'),
                    coalesce(json ->> '$.options.mounts', '[]') FROM box_config WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        )?
        .ok_or_else(|| BoxliteError::NotFound(id.to_owned()))?;
        let volumes: Vec<VolumeSpec> = db_err!(serde_json::from_str(&volumes))?;
        let mounts: Vec<MountSpec> = db_err!(serde_json::from_str(&mounts))?;
        let mut this = Self {
            unmanaged: volumes
                .iter()
                .filter(|volume| volume.managed_volume.is_some())
                .map(|volume| volume.guest_path.as_str())
                .chain(
                    mounts
                        .iter()
                        .filter(|mount| mount.mount_type != MountType::Bind)
                        .map(|mount| mount.target.as_str()),
                )
                .filter_map(normalize_target)
                .collect(),
            directories: BTreeMap::new(),
            files: BTreeSet::new(),
        };
        let directories = volumes
            .iter()
            .filter(|volume| volume.managed_volume.is_none())
            .map(|volume| {
                (
                    volume.host_path.as_str(),
                    volume.guest_path.as_str(),
                    volume.read_only,
                )
            })
            .chain(
                mounts
                    .iter()
                    .filter(|mount| mount.mount_type == MountType::Bind)
                    .filter_map(|mount| {
                        Some((
                            mount.source.as_deref()?,
                            mount.target.as_str(),
                            mount.read_only,
                        ))
                    }),
            );
        for (source, target, read_only) in directories {
            let Some(key) = normalize_target(target) else {
                continue;
            };
            // Both creation formats take a file in the same field. A bind whose
            // source is gone still counts as a directory, so it stays removable.
            if this.unmanaged.contains(&key) {
                this.unmanaged.insert(key);
            } else if std::fs::metadata(source).is_ok_and(|metadata| !metadata.is_dir()) {
                this.unmanaged.insert(key.clone());
                this.files.insert(key);
            } else {
                this.directories.insert(
                    key.clone(),
                    MountRequest {
                        source: source.into(),
                        target: key.into(),
                        read_only,
                    },
                );
            }
        }
        Ok(this)
    }
}

impl Mounts {
    fn load(conn: &Connection, id: &str, creation: Creation) -> BoxliteResult<Self> {
        // One statement, so the state and the mounts come from the same WAL snapshot.
        let row: Option<(String, Option<String>)> = db_err!(
            conn.query_row(
                "SELECT json, json ->> '$.mounts' FROM box_state WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        )?;
        let (state, saved) = row.ok_or_else(|| BoxliteError::NotFound(id.to_owned()))?;
        let state: BoxState = db_err!(serde_json::from_str(&state))?;
        let saved: Saved = match saved {
            Some(json) => db_err!(serde_json::from_str(&json))?,
            None => Saved::default(),
        };
        let mut this = Self {
            // Progress belongs to one run. A stopped box, or a later run, has none.
            progress: saved
                .run
                .filter(|run| Some(run.pid) == state.pid && run.started_at == state.started_at)
                .map(|run| run.targets)
                .unwrap_or_default(),
            state,
            declarations: creation.directories,
            unmanaged: creation.unmanaged,
            files: creation.files,
            changes: BTreeMap::new(),
        };
        for (target, change) in saved.changes {
            this.apply(&target, change);
        }
        Ok(this)
    }

    /// Refuse a progress write once the box no longer runs the given VM.
    pub(crate) fn ensure_run(
        &self,
        pid: u32,
        started_at: Option<DateTime<Utc>>,
    ) -> BoxliteResult<()> {
        if Some(pid) == self.state.pid && self.state.started_at == started_at {
            Ok(())
        } else {
            Err(BoxliteError::Stopped(
                "the box's VM run ended; use runtime.get() for its next run".into(),
            ))
        }
    }

    /// Whether a target has a mount on record.
    pub(crate) fn occupied(&self, target: &str) -> bool {
        self.declarations.contains_key(target)
            || self.unmanaged.contains(target)
            || self.progress.contains_key(target)
    }

    /// A mount on record below `target`. A mount applied at `target` after it
    /// would cover it, and a lazy detach of `target` would take it along.
    pub(crate) fn below(&self, target: &str) -> Option<&str> {
        self.declarations
            .keys()
            .chain(self.unmanaged.iter())
            .chain(self.progress.keys())
            .find(|other| path_is_below(other, target))
            .map(String::as_str)
    }

    /// Whether `target` was added through `mount()`, not created with the box.
    pub(crate) fn is_added(&self, target: &str) -> bool {
        self.changes.get(target).is_some_and(Option::is_some)
    }

    /// Record what a change did to the target: a directory is declared there,
    /// or the target is free again, whatever its source is now.
    fn apply(&mut self, target: &str, change: Option<MountRequest>) {
        self.changes.insert(target.to_owned(), change.clone());
        match change {
            Some(request) => {
                self.declarations.insert(target.to_owned(), request);
            }
            None => {
                self.declarations.remove(target);
                self.unmanaged.remove(target);
                self.files.remove(target);
            }
        }
    }

    /// Save a declaration for the next start.
    pub(crate) fn declare(&mut self, request: MountRequest) {
        let target = request.target.to_string_lossy().into_owned();
        self.apply(&target, Some(request));
    }

    /// Drop the declaration at `target`.
    pub(crate) fn forget(&mut self, target: &str) {
        self.apply(target, None);
    }

    pub(crate) fn lookup(&self, target: &str) -> Option<MountInfo> {
        self.progress
            .get(target)
            .map(|entry| entry.request.info(entry.state))
            .or_else(|| {
                self.declarations
                    .get(target)
                    .map(|request| request.info(MountState::Configured))
            })
    }

    pub(crate) fn visible(&self) -> Vec<MountInfo> {
        self.progress
            .values()
            .map(|entry| entry.request.info(entry.state))
            .chain(
                self.declarations
                    .iter()
                    .filter(|(target, _)| !self.progress.contains_key(*target))
                    .map(|(_, request)| request.info(MountState::Configured)),
            )
            .collect()
    }

    /// Write the committed changes into the options a box boots under: removed
    /// targets go, added directories join in the box's own creation format.
    pub(crate) fn apply_to_boot(&self, options: &mut BoxOptions) {
        if self.changes.is_empty() {
            return;
        }
        let changed = |target: &str| {
            normalize_target(target).is_some_and(|key| self.changes.contains_key(&key))
        };
        options
            .volumes
            .retain(|volume| !changed(&volume.guest_path));
        options.mounts.retain(|mount| !changed(&mount.target));
        // The volume resolver rejects a mixture of the two formats.
        let legacy = !options.volumes.is_empty();
        for request in self.changes.values().flatten() {
            // A declaration always comes from a checked request.
            let bind = (
                request.source.to_string_lossy(),
                request.target.to_string_lossy(),
            );
            if legacy {
                options.volumes.push(VolumeSpec {
                    read_only: request.read_only,
                    ..VolumeSpec::bind_mount(bind.0, bind.1)
                });
            } else {
                options.mounts.push(MountSpec {
                    read_only: request.read_only,
                    ..MountSpec::bind_mount(bind.0, bind.1)
                });
            }
        }
    }

    /// Refuse a declared source that is no longer a directory, before the
    /// volume resolver runs: it would mount a file in the directory's place,
    /// or fail without naming the target. A directory added through `mount()`
    /// also refuses a link, as it did when it was added.
    pub(crate) fn check_sources(&self) -> BoxliteResult<()> {
        for (target, request) in &self.declarations {
            let added = self.is_added(target);
            let metadata = if added {
                // A trailing separator or dot would make the kernel follow a final link.
                std::fs::symlink_metadata(request.source.components().as_path())
            } else {
                std::fs::metadata(&request.source)
            };
            let problem = match metadata {
                Ok(metadata) if metadata.is_dir() => continue,
                Ok(_) => "is not a directory anymore".to_owned(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    "does not exist".to_owned()
                }
                Err(error) => format!("cannot be inspected: {error}"),
            };
            return Err(undeliverable(request, problem));
        }
        Ok(())
    }

    /// Have the guest record the mount the container runtime makes for each
    /// declared directory, so an online removal can select it. Returns the
    /// progress the start confirms for them.
    pub(crate) fn record(
        &self,
        mounts: &mut [ContainerMount],
        advanced: &AdvancedBoxOptions,
    ) -> BTreeMap<String, MountProgress> {
        let permits = advanced.permits_aggregate_mounts();
        let mut confirmed = BTreeMap::new();
        for mount in mounts {
            let Some((target, request)) = normalize_target(&mount.destination).and_then(|target| {
                self.declarations
                    .get(&target)
                    .map(|request| (target, request))
            }) else {
                continue;
            };
            let added = self.is_added(&target);
            // A directory created with the box keeps its static delivery
            // unless the container may detach it.
            if !added && !permits {
                continue;
            }
            let key = uuid::Uuid::new_v4();
            mount.payload = ContainerMountPayload::RecordedDirectory {
                key: key.to_string(),
                added,
            };
            confirmed.insert(
                target,
                MountProgress {
                    request: request.clone(),
                    state: MountState::Mounted,
                    request_id: key.into_bytes(),
                    export: None,
                    delivered_at_start: true,
                },
            );
        }
        confirmed
    }
}

/// A start cannot use a declared directory. The target leads the message: it
/// is what the caller can query, and remove, while the box is stopped.
fn undeliverable(request: &MountRequest, cause: impl Display) -> BoxliteError {
    BoxliteError::InvalidState(format!(
        "cannot deliver the directory declared at {}: source {} {cause}",
        request.target.display(),
        request.source.display()
    ))
}
impl BoxStore {
    /// The declarations of box `id` and the progress of its current VM run.
    pub(crate) fn mounts(&self, id: &str) -> BoxliteResult<Mounts> {
        let creation = Creation::read(&self.db.conn(), id)?;
        Mounts::load(&self.db.conn(), id, creation)
    }

    /// Apply `change` to the declarations and progress of box `id`, with the
    /// state they were read with, in one write transaction.
    pub(crate) fn update_mounts<T>(
        &self,
        id: &str,
        change: impl FnOnce(&mut Mounts) -> BoxliteResult<T>,
    ) -> BoxliteResult<T> {
        // Before the transaction, so that the inspection in `Creation::read`
        // holds neither the connection nor the database write lock.
        let creation = Creation::read(&self.db.conn(), id)?;
        let mut conn = self.db.conn();
        let tx = db_err!(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let mut mounts = Mounts::load(&tx, id, creation)?;
        let result = change(&mut mounts)?;
        let saved = db_err!(serde_json::to_string(&Saved {
            changes: mounts.changes,
            run: (!mounts.progress.is_empty()).then(|| Run {
                pid: mounts.state.pid.unwrap_or_default(),
                started_at: mounts.state.started_at,
                targets: mounts.progress,
            }),
        }))?;
        Self::write_state(&tx, id, &mounts.state, Some(&saved))?;
        db_err!(tx.commit())?;
        Ok(result)
    }
}
