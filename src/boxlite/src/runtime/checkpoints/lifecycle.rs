//! Coordinate a logical target name across native ID replacement.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use super::catalog::Catalog;
use crate::{BoxliteError, BoxliteResult};

#[derive(Default)]
pub(crate) struct Lifecycle {
    locks: Mutex<HashMap<String, Weak<RwLock<()>>>>,
    catalogs: Mutex<Vec<PathBuf>>,
    retired: Mutex<HashSet<String>>,
}

pub(crate) struct RecoveryLease {
    keys: Vec<String>,
    _guards: Vec<OwnedRwLockWriteGuard<()>>,
}

impl RecoveryLease {
    pub(crate) fn check_name(&self, name: Option<&str>) -> BoxliteResult<()> {
        if name.is_some_and(|name| !self.keys.iter().any(|key| key == name)) {
            return Err(busy());
        }
        Ok(())
    }
}

impl Lifecycle {
    pub(crate) fn register(&self, directory: PathBuf) {
        let mut catalogs = self.catalogs.lock();
        if !catalogs.contains(&directory) {
            catalogs.push(directory);
        }
    }

    pub(crate) fn read(
        &self,
        id: Option<&str>,
        name: Option<&str>,
    ) -> BoxliteResult<Vec<OwnedRwLockReadGuard<()>>> {
        let keys = keys(id, name);
        let guards = self.read_keys(&keys)?;
        self.check_available(&keys)?;
        Ok(guards)
    }

    fn check_available(&self, keys: &[String]) -> BoxliteResult<()> {
        for key in keys {
            if self.retired.lock().contains(key) {
                return Err(busy());
            }
            for directory in self.catalogs.lock().clone() {
                if Catalog::new(directory).owns_target(key)? {
                    return Err(busy());
                }
            }
        }
        Ok(())
    }

    pub(crate) fn capture(&self, id: &str, name: Option<&str>) -> BoxliteResult<RecoveryLease> {
        let lease = self.reserve(id, name)?;
        self.check_available(&lease.keys)?;
        Ok(lease)
    }

    pub(crate) fn reserve(&self, id: &str, name: Option<&str>) -> BoxliteResult<RecoveryLease> {
        let keys = keys(Some(id), name);
        let guards = self
            .locks_for(&keys)
            .into_iter()
            .map(|lock| lock.try_write_owned().map_err(|_| busy()))
            .collect::<BoxliteResult<Vec<_>>>()?;
        Ok(RecoveryLease {
            keys,
            _guards: guards,
        })
    }

    pub(crate) fn deleting(
        &self,
        id: Option<&str>,
        name: Option<&str>,
    ) -> BoxliteResult<Vec<OwnedRwLockReadGuard<()>>> {
        self.read_keys(&keys(id, name))
    }

    pub(crate) fn cancel(&self, target: &str) -> BoxliteResult<bool> {
        let mut cancelled = false;
        for directory in self.catalogs.lock().clone() {
            let ids = Catalog::new(directory).cancel_recoveries(target)?;
            cancelled |= !ids.is_empty();
            self.retired.lock().extend(ids);
        }
        Ok(cancelled)
    }

    fn read_keys(&self, keys: &[String]) -> BoxliteResult<Vec<OwnedRwLockReadGuard<()>>> {
        self.locks_for(keys)
            .into_iter()
            .map(|lock| lock.try_read_owned().map_err(|_| busy()))
            .collect()
    }

    fn locks_for(&self, keys: &[String]) -> Vec<Arc<RwLock<()>>> {
        let mut locks = self.locks.lock();
        locks.retain(|_, lock| lock.strong_count() > 0);
        keys.iter()
            .map(|key| {
                let lock = locks
                    .get(key)
                    .and_then(Weak::upgrade)
                    .unwrap_or_else(|| Arc::new(RwLock::new(())));
                locks.insert(key.clone(), Arc::downgrade(&lock));
                lock
            })
            .collect()
    }
}

fn keys(id: Option<&str>, name: Option<&str>) -> Vec<String> {
    let mut keys: Vec<_> = id.into_iter().chain(name).map(str::to_owned).collect();
    keys.sort();
    keys.dedup();
    keys
}

fn busy() -> BoxliteError {
    BoxliteError::InvalidState("box target is owned or replaced by a checkpoint recovery".into())
}
