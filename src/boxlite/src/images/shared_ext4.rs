//! Shared ext4 rows: ready fast path, in-process builds, and `rmi`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use tokio::sync::Notify;

use crate::db::Database;
use crate::db::shared_disk::{self, DiskDelete};
use crate::images::config::ContainerImageConfig;
use crate::images::object::ImageObject;
use crate::images::storage::ImageStorage;

#[derive(Debug, Clone)]
pub(crate) struct ReadyExt4 {
    pub disk_key: String,
    pub path: PathBuf,
    pub config: ContainerImageConfig,
}

#[derive(Debug)]
pub(crate) struct ScratchFiles {
    pub manifest: PathBuf,
    pub config_blob: PathBuf,
    pub layers: Vec<PathBuf>,
    pub extracted: Vec<PathBuf>,
    /// Multi-arch index saved beside the platform manifest. `None` for a
    /// single-platform image.
    pub index_manifest: Option<PathBuf>,
}

pub(crate) fn scratch_files(storage: &ImageStorage, image: &ImageObject) -> ScratchFiles {
    ScratchFiles {
        manifest: storage.manifest_path(image.manifest_digest()),
        config_blob: storage.config_path(image.config_digest()),
        layers: image.layer_tarballs(),
        extracted: image
            .layer_digests()
            .into_iter()
            .map(|digest| storage.layer_extracted_path(digest))
            .collect(),
        index_manifest: image
            .index_digest()
            .map(|digest| storage.manifest_path(digest)),
    }
}

pub(crate) fn choose_start(db: &Database, image_ref: &str) -> BoxliteResult<Option<ReadyExt4>> {
    let Some(disk_key) = shared_disk::image_key(db, image_ref)? else {
        return Ok(None);
    };
    match classify(db, &disk_key)? {
        Class::Ready(ready) => Ok(Some(ready)),
        Class::NeedsBuild => Ok(None),
        Class::Conflict(err) | Class::ReferencedMissing(err) => Err(err),
    }
}

/// Restart reads `disk.root` for this box. It does not look up the image tag.
pub(crate) fn open_restart(db: &Database, box_id: &str) -> BoxliteResult<ReadyExt4> {
    let Some((root, _)) = shared_disk::disk_row(db, box_id)? else {
        return Err(BoxliteError::Storage(format!(
            "cannot restart box {box_id}: no disk.root is recorded"
        )));
    };
    match classify(db, &root)? {
        Class::Ready(ready) => Ok(ready),
        Class::Conflict(err) | Class::ReferencedMissing(err) => Err(err),
        Class::NeedsBuild => Err(BoxliteError::Storage(format!(
            "cannot restart box {box_id}: ext4 {root} is not ready"
        ))),
    }
}

pub(crate) fn reuse_ready(
    db: &Database,
    builds: &BuildRegistry,
    image_ref: &str,
    disk_key: &str,
    scratch: &ScratchFiles,
) -> BoxliteResult<Option<ReadyExt4>> {
    let Some(ready) = load_ready(db, disk_key)? else {
        return Ok(None);
    };
    shared_disk::ensure_image(db, image_ref, disk_key)?;
    delete_scratch(builds, disk_key, scratch)?;
    Ok(Some(ready))
}

#[allow(dead_code)] // install path covered by the ready-ext4 test; create uses mark_ready
pub(crate) fn publish_ready(
    db: &Database,
    builds: &BuildRegistry,
    image_ref: &str,
    disk_key: &str,
    ext4_path: &Path,
    scratch: &ScratchFiles,
) -> BoxliteResult<ReadyExt4> {
    if !ext4_path.is_file() {
        return Err(BoxliteError::Image(format!(
            "refusing to mark {} ready: ext4 is not a file",
            ext4_path.display()
        )));
    }
    let config = guest_config(&scratch.config_blob)?;
    let config_json = serde_json::to_string(&config)
        .map_err(|e| BoxliteError::Image(format!("failed to store guest image config: {e}")))?;
    let path = ext4_path.to_str().ok_or_else(|| {
        BoxliteError::Image(format!("ext4 path is not utf-8: {}", ext4_path.display()))
    })?;
    shared_disk::publish_ready(db, image_ref, disk_key, path, &config_json)?;
    delete_scratch(builds, disk_key, scratch)?;
    Ok(ReadyExt4 {
        disk_key: disk_key.to_string(),
        path: ext4_path.to_path_buf(),
        config,
    })
}

enum Class {
    Ready(ReadyExt4),
    NeedsBuild,
    Conflict(BoxliteError),
    ReferencedMissing(BoxliteError),
}

fn classify(db: &Database, disk_key: &str) -> BoxliteResult<Class> {
    let Some((path, state, config_json)) = shared_disk::image_disk(db, disk_key)? else {
        return Ok(Class::NeedsBuild);
    };
    if state == "deleting" {
        return Ok(Class::Conflict(deleting_conflict(disk_key)));
    }
    // A dead `building` row with `disk.root` is not a cache miss. Fail before
    // any registry pull, and leave the file where it is.
    if state == "building" && shared_disk::any_disk_root(db, disk_key)? {
        return Ok(Class::ReferencedMissing(BoxliteError::Storage(format!(
            "ext4 for {disk_key} is still building and a disk.root points at it; refusing to rebuild in place"
        ))));
    }
    let ext4 = PathBuf::from(&path);
    let present = ext4.is_file();
    if state == "ready" && present {
        let config = serde_json::from_str(&config_json).map_err(|e| {
            BoxliteError::Image(format!("failed to read guest config for {disk_key}: {e}"))
        })?;
        return Ok(Class::Ready(ReadyExt4 {
            disk_key: disk_key.to_string(),
            path: ext4,
            config,
        }));
    }
    if shared_disk::any_disk_root(db, disk_key)? && !present {
        return Ok(Class::ReferencedMissing(BoxliteError::Storage(format!(
            "ext4 for {disk_key} is missing and a disk.root still points at it; refusing to rebuild in place"
        ))));
    }
    if state == "ready" && !present {
        shared_disk::clear_image_disk(db, disk_key)?;
    }
    Ok(Class::NeedsBuild)
}

fn deleting_conflict(disk_key: &str) -> BoxliteError {
    BoxliteError::InvalidState(format!(
        "operation conflict: image disk {disk_key} is being deleted"
    ))
}

fn load_ready(db: &Database, disk_key: &str) -> BoxliteResult<Option<ReadyExt4>> {
    match classify(db, disk_key)? {
        Class::Ready(ready) => Ok(Some(ready)),
        Class::NeedsBuild => Ok(None),
        Class::Conflict(err) | Class::ReferencedMissing(err) => Err(err),
    }
}

#[allow(dead_code)] // used by publish_ready
fn guest_config(path: &Path) -> BoxliteResult<ContainerImageConfig> {
    let bytes = std::fs::read(path)
        .map_err(|e| BoxliteError::Image(format!("read image config {}: {e}", path.display())))?;
    let oci: oci_spec::image::ImageConfiguration = serde_json::from_slice(&bytes)
        .map_err(|e| BoxliteError::Image(format!("parse image config {}: {e}", path.display())))?;
    ContainerImageConfig::from_oci_config(&oci)
}

fn scratch_paths(scratch: &ScratchFiles) -> HashSet<PathBuf> {
    let mut paths = HashSet::new();
    paths.insert(scratch.manifest.clone());
    paths.insert(scratch.config_blob.clone());
    if let Some(index) = &scratch.index_manifest {
        paths.insert(index.clone());
    }
    paths.extend(scratch.layers.iter().cloned());
    paths.extend(scratch.extracted.iter().cloned());
    paths
}

/// Drop blobs this ext4 no longer needs. A path another in-progress build still
/// names stays on disk until that build finishes.
fn delete_scratch(
    builds: &BuildRegistry,
    disk_key: &str,
    scratch: &ScratchFiles,
) -> BoxliteResult<()> {
    remove_unless_held(builds, disk_key, &scratch.manifest)?;
    if let Some(index) = &scratch.index_manifest {
        remove_unless_held(builds, disk_key, index)?;
    }
    delete_index_siblings(builds, disk_key, &scratch.manifest)?;
    remove_unless_held(builds, disk_key, &scratch.config_blob)?;
    for path in scratch.layers.iter().chain(scratch.extracted.iter()) {
        remove_unless_held(builds, disk_key, path)?;
    }
    Ok(())
}

fn remove_unless_held(builds: &BuildRegistry, disk_key: &str, path: &Path) -> BoxliteResult<()> {
    if builds.held_by_other(disk_key, path) {
        return Ok(());
    }
    remove(path)
}

/// A multi-arch index is stored under its own digest, which is not the platform
/// manifest name. Delete an index in the same directory when it points at the
/// platform manifest. This still runs if the in-memory index digest was lost
/// on a cache hit.
fn delete_index_siblings(
    builds: &BuildRegistry,
    disk_key: &str,
    platform_manifest: &Path,
) -> BoxliteResult<()> {
    let Some(dir) = platform_manifest.parent() else {
        return Ok(());
    };
    let Some(stem) = platform_manifest.file_stem().and_then(|stem| stem.to_str()) else {
        return Ok(());
    };
    let digest = stem.replacen('-', ":", 1);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == platform_manifest {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let is_index = text.contains("image.index") || text.contains("manifest.list");
        if is_index && text.contains(&digest) {
            remove_unless_held(builds, disk_key, &path)?;
        }
    }
    Ok(())
}

fn remove(path: &Path) -> BoxliteResult<()> {
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(BoxliteError::Storage(format!(
            "failed to remove {}: {e}",
            path.display()
        ))),
    }
}

#[derive(Clone)]
enum Outcome {
    Pending,
    Ready,
    Failed(String),
}

struct LiveBuild {
    outcome: Mutex<Outcome>,
    dropped: Mutex<HashSet<String>>,
    finish: Mutex<Finish>,
    notify: Notify,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Finish {
    Running,
    Stopped,
    Ready,
}

impl LiveBuild {
    fn new() -> Self {
        Self {
            outcome: Mutex::new(Outcome::Pending),
            dropped: Mutex::new(HashSet::new()),
            finish: Mutex::new(Finish::Running),
            notify: Notify::new(),
        }
    }

    /// Store the outcome, then wake waiters. The mutex keeps the value for a
    /// waiter that arrives after the build has already failed or become ready.
    fn publish(&self, outcome: Outcome) {
        *self.outcome.lock().expect("build outcome") = outcome;
        self.notify.notify_waiters();
    }

    fn drop_waiter(&self, image_ref: &str) {
        self.dropped
            .lock()
            .expect("build waiters")
            .insert(image_ref.to_string());
        self.notify.notify_waiters();
    }

    fn is_dropped(&self, image_ref: &str) -> bool {
        self.dropped
            .lock()
            .expect("build waiters")
            .contains(image_ref)
    }

    fn failure(&self) -> Option<String> {
        match self.outcome.lock().expect("build outcome").clone() {
            Outcome::Failed(message) => Some(message),
            Outcome::Pending | Outcome::Ready => None,
        }
    }

    /// Stop a live build before it is marked ready. Returns false when the ext4
    /// is already ready, so the caller follows the ready removal rules.
    fn stop(&self) -> bool {
        let mut finish = self.finish.lock().expect("build finish");
        if *finish == Finish::Ready {
            return false;
        }
        *finish = Finish::Stopped;
        drop(finish);
        self.publish(Outcome::Failed("build stopped".into()));
        true
    }

    fn fail(&self, message: String) {
        let mut finish = self.finish.lock().expect("build finish");
        if *finish == Finish::Ready {
            return;
        }
        *finish = Finish::Stopped;
        drop(finish);
        self.publish(Outcome::Failed(message));
    }

    fn publish_ready(&self) {
        self.publish(Outcome::Ready);
    }

    async fn wait(&self, image_ref: &str) -> BoxliteResult<()> {
        loop {
            // Register before reading so a publish between the read and the
            // await is not lost. Locks are dropped before the await.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            let removed = self
                .dropped
                .lock()
                .expect("build waiters")
                .contains(image_ref);
            if removed {
                return Err(BoxliteError::InvalidState(format!(
                    "image {image_ref} was removed while its ext4 was building"
                )));
            }
            let outcome = self.outcome.lock().expect("build outcome").clone();
            match outcome {
                Outcome::Ready => return Ok(()),
                Outcome::Failed(message) => return Err(BoxliteError::Image(message)),
                Outcome::Pending => {}
            }
            notified.await;
        }
    }
}

enum Reservation {
    Own(Arc<LiveBuild>),
    Wait(Arc<LiveBuild>),
}

/// In-process builds. A `building` row with no entry here is dead: the process
/// that inserted it is gone, because one process holds the runtime lock.
#[derive(Default)]
pub(crate) struct BuildRegistry {
    live: Mutex<HashMap<String, Arc<LiveBuild>>>,
    /// Blob paths an in-progress build still needs. Keyed by `disk_key`.
    scratch: Mutex<HashMap<String, HashSet<PathBuf>>>,
}

impl BuildRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn is_live(&self, disk_key: &str) -> bool {
        self.live.lock().expect("builds").contains_key(disk_key)
    }

    fn reserve(&self, disk_key: &str) -> Reservation {
        let mut live = self.live.lock().expect("builds");
        if let Some(existing) = live.get(disk_key) {
            return Reservation::Wait(existing.clone());
        }
        let build = Arc::new(LiveBuild::new());
        live.insert(disk_key.to_string(), build.clone());
        Reservation::Own(build)
    }

    fn hold_scratch(&self, disk_key: &str, scratch: &ScratchFiles) {
        self.scratch
            .lock()
            .expect("build scratch")
            .insert(disk_key.to_string(), scratch_paths(scratch));
    }

    fn held_by_other(&self, disk_key: &str, path: &Path) -> bool {
        self.scratch
            .lock()
            .expect("build scratch")
            .iter()
            .any(|(key, paths)| key != disk_key && paths.contains(path))
    }

    fn release(&self, disk_key: &str) {
        self.live.lock().expect("builds").remove(disk_key);
        self.scratch.lock().expect("build scratch").remove(disk_key);
    }

    fn get(&self, disk_key: &str) -> Option<Arc<LiveBuild>> {
        self.live.lock().expect("builds").get(disk_key).cloned()
    }
}

/// Create or wait for the shared ext4. The closure runs only for the owner,
/// and only after the `building` row and image row are committed.
// Keep the build identity explicit at this concurrency boundary: grouping these
// borrowed values would only move the same lifetime coupling into a parameter bag.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn resolve_for_create<F, Fut>(
    db: &Database,
    builds: &BuildRegistry,
    image_ref: &str,
    disk_key: &str,
    ext4_path: &Path,
    config_json: &str,
    scratch: &ScratchFiles,
    build: F,
) -> BoxliteResult<ReadyExt4>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = BoxliteResult<()>>,
{
    recover_or_ready(db, builds, disk_key)?;
    if let Some(ready) = reuse_ready(db, builds, image_ref, disk_key, scratch)? {
        return Ok(ready);
    }

    match builds.reserve(disk_key) {
        Reservation::Wait(live) => {
            if live.is_dropped(image_ref) {
                return Err(removed_waiter(image_ref));
            }
            // A build that already failed, including `rmi --force` on the last
            // name, must not let this waiter insert the name again.
            if let Some(message) = live.failure() {
                return Err(BoxliteError::Image(message));
            }
            shared_disk::ensure_image(db, image_ref, disk_key)?;
            // `stop` publishes Failed without `drop_waiter`. A waiter that
            // passed the check above and then lost that race must not leave
            // the row `ensure_image` just wrote.
            if live.is_dropped(image_ref) || live.failure().is_some() {
                let _ = shared_disk::delete_image_row(db, image_ref);
                if live.is_dropped(image_ref) {
                    return Err(removed_waiter(image_ref));
                }
                if let Some(message) = live.failure() {
                    return Err(BoxliteError::Image(message));
                }
            }
            live.wait(image_ref).await?;
            let ready = load_ready(db, disk_key)?.ok_or_else(|| {
                BoxliteError::Image(format!("image disk {disk_key} did not become ready"))
            })?;
            delete_scratch(builds, disk_key, scratch)?;
            Ok(ready)
        }
        Reservation::Own(live) => {
            let outcome = own_build(
                db,
                builds,
                &live,
                image_ref,
                disk_key,
                ext4_path,
                config_json,
                scratch,
                build,
            )
            .await;
            builds.release(disk_key);
            outcome
        }
    }
}

fn recover_or_ready(db: &Database, builds: &BuildRegistry, disk_key: &str) -> BoxliteResult<()> {
    let Some((path, state, _)) = shared_disk::image_disk(db, disk_key)? else {
        return Ok(());
    };
    if state == "deleting" {
        return Err(deleting_conflict(disk_key));
    }
    let ext4 = PathBuf::from(&path);
    let present = ext4.is_file();
    if shared_disk::any_disk_root(db, disk_key)? && !present {
        return Err(BoxliteError::Storage(format!(
            "ext4 for {disk_key} is missing and a disk.root still points at it; refusing to rebuild in place"
        )));
    }
    if state == "building" && !builds.is_live(disk_key) {
        if shared_disk::any_disk_root(db, disk_key)? {
            return Err(BoxliteError::Storage(format!(
                "ext4 for {disk_key} is still building and a disk.root points at it; refusing to rebuild in place"
            )));
        }
        if present {
            remove(&ext4)?;
        }
        shared_disk::clear_image_disk(db, disk_key)?;
        return Ok(());
    }
    if state == "ready" && !present {
        shared_disk::clear_image_disk(db, disk_key)?;
    }
    Ok(())
}

// Mirrors `resolve_for_create` and also receives the reserved live-build guard.
#[allow(clippy::too_many_arguments)]
async fn own_build<F, Fut>(
    db: &Database,
    builds: &BuildRegistry,
    live: &LiveBuild,
    image_ref: &str,
    disk_key: &str,
    ext4_path: &Path,
    config_json: &str,
    scratch: &ScratchFiles,
    build: F,
) -> BoxliteResult<ReadyExt4>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = BoxliteResult<()>>,
{
    // Register before `build()` so a concurrent ready image does not delete a
    // blob this build still has to read.
    builds.hold_scratch(disk_key, scratch);
    if *live.finish.lock().expect("build finish") == Finish::Stopped {
        live.fail("build stopped".into());
        return Err(BoxliteError::InvalidState(format!(
            "image disk {disk_key} build was stopped"
        )));
    }
    let Some(path) = ext4_path.to_str() else {
        let message = format!("ext4 path is not utf-8: {}", ext4_path.display());
        live.fail(message.clone());
        return Err(BoxliteError::Image(message));
    };
    if let Err(err) = shared_disk::begin_build(db, image_ref, disk_key, path, config_json) {
        live.fail(err.to_string());
        return Err(err);
    }
    let built = build().await;
    if *live.finish.lock().expect("build finish") == Finish::Stopped {
        let _ = remove(ext4_path);
        if !shared_disk::any_disk_root(db, disk_key)? {
            let _ = shared_disk::clear_image_disk(db, disk_key);
        }
        live.fail("build stopped".into());
        return Err(BoxliteError::InvalidState(format!(
            "image disk {disk_key} build was stopped"
        )));
    }
    match built {
        Ok(()) if ext4_path.is_file() => {
            let marked = {
                let mut finish = live.finish.lock().expect("build finish");
                if *finish != Finish::Running {
                    drop(finish);
                    let _ = remove(ext4_path);
                    return Err(BoxliteError::InvalidState(format!(
                        "image disk {disk_key} build was stopped"
                    )));
                }
                let marked = match shared_disk::mark_ready(db, disk_key, path) {
                    Ok(marked) => marked,
                    Err(err) => {
                        // `fail` takes this same mutex. Drop it before waking
                        // waiters, including when the following cleanup fails.
                        drop(finish);
                        let message = err.to_string();
                        let _ = fail_build(db, live, disk_key, ext4_path, &message);
                        return Err(err);
                    }
                };
                if marked {
                    *finish = Finish::Ready;
                }
                marked
            };
            if !marked {
                live.fail(format!(
                    "image disk {disk_key} was cleared before it was ready"
                ));
                let _ = remove(ext4_path);
                return Err(BoxliteError::Image(format!(
                    "refusing to mark {disk_key} ready"
                )));
            }
            live.publish_ready();
            delete_scratch(builds, disk_key, scratch)?;
            load_ready(db, disk_key)?.ok_or_else(|| {
                BoxliteError::Image(format!("image disk {disk_key} disappeared after ready"))
            })
        }
        Ok(()) => {
            fail_build(db, live, disk_key, ext4_path, "build produced no ext4")?;
            Err(BoxliteError::Image(format!(
                "refusing to mark {disk_key} ready: ext4 is missing"
            )))
        }
        Err(err) => {
            fail_build(db, live, disk_key, ext4_path, &err.to_string())?;
            Err(err)
        }
    }
}

fn fail_build(
    db: &Database,
    live: &LiveBuild,
    disk_key: &str,
    ext4_path: &Path,
    message: &str,
) -> BoxliteResult<()> {
    let cleanup = (|| {
        if !shared_disk::any_disk_root(db, disk_key)? {
            remove(ext4_path)?;
            shared_disk::clear_image_disk(db, disk_key)?;
        }
        Ok(())
    })();
    // Waiters already hold this LiveBuild. Wake them even when removing the
    // partial ext4 or clearing the row fails, and keep the outcome for a
    // waiter that arrives after the owner returns.
    live.fail(message.to_string());
    cleanup
}

pub(crate) fn remove_named(
    db: &Database,
    builds: &BuildRegistry,
    image_ref: &str,
    force: bool,
) -> BoxliteResult<()> {
    let Some(disk_key) = shared_disk::image_key(db, image_ref)? else {
        return Err(BoxliteError::NotFound(format!("image {image_ref}")));
    };
    if shared_disk::any_disk_root(db, &disk_key)? {
        return Err(BoxliteError::InvalidState(format!(
            "refusing to remove {image_ref}: a disk.root still points at {disk_key}"
        )));
    }
    let Some((path, state, _)) = shared_disk::image_disk(db, &disk_key)? else {
        shared_disk::delete_image_row(db, image_ref)?;
        return Ok(());
    };
    let names = shared_disk::image_refs_for_disk(db, &disk_key)?;
    let others = names.iter().any(|name| name != image_ref);
    match state.as_str() {
        "ready" if others => {
            shared_disk::delete_image_row(db, image_ref)?;
            Ok(())
        }
        "ready" => {
            if !shared_disk::claim_deleting_last_name(db, image_ref, &disk_key)? {
                return Err(BoxliteError::InvalidState(format!(
                    "refusing to remove {image_ref}: a disk.root or another name appeared for {disk_key}"
                )));
            }
            finish_delete(db, image_ref, &disk_key, &path)
        }
        "deleting" => finish_delete(db, image_ref, &disk_key, &path),
        "building" if !force => Err(BoxliteError::InvalidState(format!(
            "image {image_ref} is building"
        ))),
        "building" if others => {
            shared_disk::delete_image_row(db, image_ref)?;
            if let Some(live) = builds.get(&disk_key) {
                live.drop_waiter(image_ref);
            }
            Ok(())
        }
        "building" => {
            // The name list above is stale. A second name or a `disk.root`
            // that appeared since then keeps the file, and this name stays
            // until the file and `image_disk` are gone.
            if another_name_or_root(db, image_ref, &disk_key)? {
                return Err(unlink_refused(&disk_key));
            }
            let stopped = match builds.get(&disk_key) {
                Some(live) => live.stop(),
                None => true,
            };
            if !stopped {
                return remove_named(db, builds, image_ref, force);
            }
            finish_delete(db, image_ref, &disk_key, &path)
        }
        _ => Err(BoxliteError::InvalidState(format!(
            "image disk {disk_key} is in state {state}"
        ))),
    }
}

pub(crate) fn remove_disk_key(db: &Database, disk_key: &str) -> BoxliteResult<()> {
    if !shared_disk::image_refs_for_disk(db, disk_key)?.is_empty() {
        return Err(BoxliteError::InvalidState(format!(
            "refusing to remove disk {disk_key}: an image name still points at it"
        )));
    }
    if shared_disk::any_disk_root(db, disk_key)? {
        return Err(BoxliteError::InvalidState(format!(
            "refusing to remove disk {disk_key}: a disk.root still points at it"
        )));
    }
    finish_unreferenced(db, disk_key)
}

pub(crate) fn remove_unused(db: &Database) -> BoxliteResult<()> {
    for disk_key in shared_disk::ready_unreferenced(db)? {
        finish_unreferenced(db, &disk_key)?;
    }
    for disk_key in shared_disk::deleting_unreferenced(db)? {
        finish_unreferenced(db, &disk_key)?;
    }
    Ok(())
}

fn finish_unreferenced(db: &Database, disk_key: &str) -> BoxliteResult<()> {
    let claimed = shared_disk::claim_unused(db, disk_key)?;
    let path = if claimed {
        shared_disk::image_disk(db, disk_key)?.map(|(path, _, _)| path)
    } else {
        shared_disk::deleting_orphan(db, disk_key)?
    };
    let Some(path) = path else {
        return Ok(());
    };
    unlink_ext4(Path::new(&path))?;
    shared_disk::clear_image_disk(db, disk_key)?;
    Ok(())
}

fn unlink_ext4(path: &Path) -> BoxliteResult<()> {
    remove(path)
}

fn removed_waiter(image_ref: &str) -> BoxliteError {
    BoxliteError::InvalidState(format!(
        "image {image_ref} was removed while its ext4 was building"
    ))
}

fn another_name_or_root(db: &Database, image_ref: &str, disk_key: &str) -> BoxliteResult<bool> {
    let names = shared_disk::image_refs_for_disk(db, disk_key)?;
    Ok(names.iter().any(|name| name != image_ref) || shared_disk::any_disk_root(db, disk_key)?)
}

fn unlink_refused(disk_key: &str) -> BoxliteError {
    BoxliteError::InvalidState(format!(
        "refusing to unlink {disk_key}: another name or a disk.root appeared"
    ))
}

/// Unlink only when this is still the last name and no `disk.root` points here.
/// A second name keeps the file, the `image_disk` row, and every name.
fn finish_delete(db: &Database, image_ref: &str, disk_key: &str, path: &str) -> BoxliteResult<()> {
    if another_name_or_root(db, image_ref, disk_key)? {
        return Err(unlink_refused(disk_key));
    }
    unlink_ext4(Path::new(path))?;
    shared_disk::clear_image_disk(db, disk_key)?;
    shared_disk::delete_image_row(db, image_ref)?;
    Ok(())
}

/// Unlink the qcow2 only when no `disk.parent` points at `id`. A blocked row
/// keeps its file. The row is deleted after the file is gone.
pub(crate) fn retire_qcow2(db: &Database, id: &str, qcow2: &Path) -> BoxliteResult<()> {
    if shared_disk::child_blocks(db, id)? {
        return Err(shared_disk::blocked_disk(id));
    }
    if qcow2.exists() {
        std::fs::remove_file(qcow2).map_err(|e| {
            BoxliteError::Storage(format!("failed to remove {}: {e}", qcow2.display()))
        })?;
    }
    match shared_disk::delete_disk_if_free(db, id)? {
        DiskDelete::Blocked => Err(shared_disk::blocked_disk(id)),
        DiskDelete::Removed | DiskDelete::Absent => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::disk::{Disk, DiskFormat};
    use crate::images::image_disk::ImageDiskManager;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    const OCI_CONFIG: &str = r#"{
        "architecture": "amd64",
        "os": "linux",
        "config": {
            "User": "guest",
            "Env": ["PATH=/usr/bin", "HELLO=from-image"],
            "Entrypoint": ["/bin/sh"],
            "Cmd": ["-c", "echo hi"],
            "WorkingDir": "/work"
        },
        "rootfs": {
            "type": "layers",
            "diff_ids": ["sha256:should-not-be-stored"]
        }
    }"#;

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn dir_names(path: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    struct Installed {
        db: Database,
        ext4: PathBuf,
        disk_key: String,
        image_ref: &'static str,
    }

    fn install_ready(home: &Path) -> Installed {
        let images = home.join("images");
        let storage = ImageStorage::new(images.clone()).unwrap();
        let db = Database::open(&home.join("db").join("boxlite.db")).unwrap();
        let layer = storage.layer_tarball_path("sha256:layer1");
        let extracted = storage.layer_extracted_path("sha256:layer1");
        let manifest = storage.manifest_path("sha256:manifest");
        let config_blob = storage.config_path("sha256:config");
        write_file(&layer, b"layer-bytes");
        write_file(&extracted.join("marker"), b"extracted");
        write_file(&manifest, b"{\"schemaVersion\":2}");
        write_file(&config_blob, OCI_CONFIG.as_bytes());
        let mgr = ImageDiskManager::new(images.join("disk-images"), home.to_path_buf(), 536870912);
        let staged = home.join("staged.ext4");
        write_file(&staged, b"ext4-bytes");
        let installed = mgr
            .install(
                "sha256:deadbeef",
                Disk::new(staged, DiskFormat::Ext4, false),
            )
            .unwrap();
        let ext4 = installed.path().to_path_buf();
        let disk_key = ext4.file_stem().unwrap().to_string_lossy().into_owned();
        let _ = installed.leak();
        let image_ref = "docker.io/library/alpine:latest";
        publish_ready(
            &db,
            &BuildRegistry::new(),
            image_ref,
            &disk_key,
            &ext4,
            &ScratchFiles {
                manifest,
                config_blob,
                layers: vec![layer],
                extracted: vec![extracted],
                index_manifest: None,
            },
        )
        .unwrap();
        Installed {
            db,
            ext4,
            disk_key,
            image_ref,
        }
    }

    #[test]
    fn ready_ext4_drops_scratch_and_starts_without_rebuild() {
        let dir = home();
        let images = dir.path().join("images");
        let storage = ImageStorage::new(images.clone()).unwrap();
        let installed = install_ready(dir.path());
        let db = &installed.db;
        let ext4 = &installed.ext4;
        let disk_key = &installed.disk_key;
        let image_ref = installed.image_ref;

        assert!(
            dir_names(&images.join("layers")).is_empty(),
            "layer tarballs for the installed image must be gone"
        );
        assert!(
            dir_names(&images.join("extracted")).is_empty(),
            "extracted dirs for the installed image must be gone"
        );
        assert!(
            std::fs::read_dir(images.join("manifests"))
                .unwrap()
                .next()
                .is_none()
                || dir_names(&images.join("manifests")).is_empty()
        );
        assert_eq!(std::fs::read(ext4).unwrap(), b"ext4-bytes");

        let stored: String = db
            .conn()
            .query_row(
                "SELECT config FROM image_disk WHERE disk_key = ?1",
                [disk_key.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains("should-not-be-stored"));
        assert!(stored.contains("\"entrypoint\":[\"/bin/sh\"]"));
        assert!(stored.contains("HELLO=from-image"));
        assert!(stored.contains("\"user\":\"guest\""));
        assert!(stored.contains("\"working_dir\":\"/work\""));

        let started = choose_start(db, image_ref).unwrap().expect("ready disk");
        assert_eq!(started.path, *ext4);
        assert_eq!(started.config.entrypoint, vec!["/bin/sh".to_string()]);
        assert_eq!(started.config.user, "guest");
        assert_eq!(started.config.working_dir, "/work");
        assert!(
            started
                .config
                .env
                .iter()
                .any(|entry| entry == "HELLO=from-image")
        );
        assert_eq!(std::fs::read(ext4).unwrap(), b"ext4-bytes");

        let layer_b = storage.layer_tarball_path("sha256:layerb");
        let extracted_b = storage.layer_extracted_path("sha256:layerb");
        let manifest_b = storage.manifest_path("sha256:manifestb");
        let config_b = storage.config_path("sha256:configb");
        write_file(&layer_b, b"other-layer");
        write_file(&extracted_b.join("marker"), b"other");
        write_file(&manifest_b, b"{}");
        write_file(
            &config_b,
            br#"{"architecture":"amd64","os":"linux","config":{"User":"other","Entrypoint":["/bin/other"]},"rootfs":{"type":"layers","diff_ids":["sha256:nope"]}}"#,
        );
        let second = reuse_ready(
            db,
            &BuildRegistry::new(),
            "docker.io/library/alpine:3.24",
            disk_key,
            &ScratchFiles {
                manifest: manifest_b,
                config_blob: config_b,
                layers: vec![layer_b.clone()],
                extracted: vec![extracted_b.clone()],
                index_manifest: None,
            },
        )
        .unwrap()
        .expect("second tag reuses the ready ext4");
        assert_eq!(second.path, *ext4);
        assert_eq!(second.config.user, "guest");
        assert_eq!(second.config.entrypoint, vec!["/bin/sh".to_string()]);
        assert!(!layer_b.exists());
        assert!(!extracted_b.exists());
        assert_eq!(std::fs::read(ext4).unwrap(), b"ext4-bytes");
        let rows: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM image WHERE disk_key = ?1",
                [disk_key.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 2);
        let again = choose_start(db, "docker.io/library/alpine:3.24")
            .unwrap()
            .expect("second tag is ready");
        assert_eq!(again.path, *ext4);

        let same_ref = reuse_ready(
            db,
            &BuildRegistry::new(),
            image_ref,
            disk_key,
            &ScratchFiles {
                manifest: dir.path().join("absent-manifest"),
                config_blob: dir.path().join("absent-config"),
                layers: Vec::new(),
                extracted: Vec::new(),
                index_manifest: None,
            },
        )
        .unwrap()
        .expect("an image row that already points at this disk is kept");
        assert_eq!(same_ref.path, *ext4);
        assert_eq!(std::fs::read(ext4).unwrap(), b"ext4-bytes");
        let same_rows: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM image WHERE ref = ?1",
                [image_ref],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(same_rows, 1);
    }

    #[test]
    fn missing_ext4_with_disk_root_does_not_rebuild() {
        let dir = home();
        let installed = install_ready(dir.path());
        assert!(
            shared_disk::commit_disk(
                &installed.db,
                "boxA",
                &installed.disk_key,
                &installed.disk_key
            )
            .unwrap()
        );
        std::fs::remove_file(&installed.ext4).unwrap();
        let err = choose_start(&installed.db, installed.image_ref).unwrap_err();
        assert!(err.to_string().contains("refusing to rebuild"), "{err}");
        assert!(!installed.ext4.exists());
        let state: String = installed
            .db
            .conn()
            .query_row(
                "SELECT state FROM image_disk WHERE disk_key = ?1",
                [installed.disk_key.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "ready");
    }

    #[test]
    fn disk_row_matches_ready_and_fork_restores_parent() {
        let dir = home();
        let installed = install_ready(dir.path());
        let db = &installed.db;
        assert!(
            shared_disk::commit_disk(db, "boxP", &installed.disk_key, &installed.disk_key).unwrap()
        );
        let (root, parent) = shared_disk::disk_row(db, "boxP").unwrap().unwrap();
        assert_eq!(root, installed.disk_key);
        assert_eq!(parent, installed.disk_key);

        db.conn()
            .execute(
                "UPDATE image_disk SET state = 'deleting' WHERE disk_key = ?1",
                [installed.disk_key.as_str()],
            )
            .unwrap();
        assert!(
            !shared_disk::commit_disk(db, "boxQ", &installed.disk_key, &installed.disk_key)
                .unwrap()
        );
        assert!(shared_disk::disk_row(db, "boxQ").unwrap().is_none());

        db.conn()
            .execute(
                "UPDATE image_disk SET state = 'ready' WHERE disk_key = ?1",
                [installed.disk_key.as_str()],
            )
            .unwrap();
        match shared_disk::commit_fork(db, "boxP", "snap1").unwrap() {
            shared_disk::ForkCommit::Committed { previous_parent } => {
                assert_eq!(previous_parent, installed.disk_key);
            }
            other => panic!("expected commit, got {other:?}"),
        }
        let (snap_root, snap_parent) = shared_disk::disk_row(db, "snap1").unwrap().unwrap();
        assert_eq!(snap_root, installed.disk_key);
        assert_eq!(snap_parent, installed.disk_key);
        assert_eq!(
            shared_disk::disk_row(db, "boxP").unwrap().unwrap().1,
            "snap1"
        );

        shared_disk::abort_fork(db, "boxP", "snap1", &installed.disk_key).unwrap();
        assert!(shared_disk::disk_row(db, "snap1").unwrap().is_none());
        assert_eq!(
            shared_disk::disk_row(db, "boxP").unwrap().unwrap().1,
            installed.disk_key
        );

        shared_disk::commit_fork(db, "boxP", "snap1").unwrap();
        let qcow = dir.path().join("boxP.qcow2");
        write_file(&qcow, b"qcow");
        std::fs::remove_file(&qcow).unwrap();
        assert!(matches!(
            shared_disk::delete_disk_if_free(db, "snap1").unwrap(),
            DiskDelete::Blocked
        ));
        assert!(shared_disk::disk_row(db, "snap1").unwrap().is_some());
        retire_qcow2(db, "boxP", &qcow).unwrap();
        assert!(shared_disk::disk_row(db, "boxP").unwrap().is_none());
        retire_qcow2(db, "snap1", &dir.path().join("missing-snap.qcow2")).unwrap();
        assert!(shared_disk::disk_row(db, "snap1").unwrap().is_none());
    }

    #[test]
    fn restart_reads_disk_root_after_the_tag_moves() {
        let dir = home();
        let installed = install_ready(dir.path());
        let db = &installed.db;
        shared_disk::commit_disk(db, "boxA", &installed.disk_key, &installed.disk_key).unwrap();
        db.conn()
            .execute(
                "UPDATE image SET disk_key = 'other-key' WHERE ref = ?1",
                [installed.image_ref],
            )
            .unwrap();
        let ready = open_restart(db, "boxA").unwrap();
        assert_eq!(ready.disk_key, installed.disk_key);
        assert_eq!(ready.path, installed.ext4);
        assert_eq!(ready.config.user, "guest");
        std::fs::remove_file(&installed.ext4).unwrap();
        let err = open_restart(db, "boxA").unwrap_err();
        assert!(err.to_string().contains("refusing to rebuild"), "{err}");
        assert!(!installed.ext4.exists());
    }

    #[tokio::test]
    async fn build_failure_clears_the_disk_and_fails_the_waiter() {
        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = Arc::new(BuildRegistry::new());
        let ext4 = dir
            .path()
            .join("images")
            .join("disk-images")
            .join("alpine-a.ext4");
        let scratch = ScratchFiles {
            manifest: dir.path().join("manifest"),
            config_blob: dir.path().join("config"),
            layers: vec![dir.path().join("layer.tar.gz")],
            extracted: vec![dir.path().join("extracted")],
            index_manifest: None,
        };
        let config = r#"{"entrypoint":["/bin/sh"],"cmd":[],"user":"guest","exposed_ports":[],"env":[],"working_dir":"/"}"#;
        let db_owner = db.clone();
        let db_wait = db.clone();
        let builds_wait = builds.clone();
        let ext4_owner = ext4.clone();
        let ext4_wait = ext4.clone();
        let (slot_tx, slot_rx) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(async move {
            slot_rx.await.unwrap();
            resolve_for_create(
                &db_wait,
                &builds_wait,
                "docker.io/library/alpine:3.24",
                "alpine-a",
                &ext4_wait,
                config,
                &ScratchFiles {
                    manifest: ext4_wait.with_file_name("manifest"),
                    config_blob: ext4_wait.with_file_name("config"),
                    layers: Vec::new(),
                    extracted: Vec::new(),
                    index_manifest: None,
                },
                || async { panic!("waiter must not build") },
            )
            .await
        });
        let owner = resolve_for_create(
            &db,
            &builds,
            "docker.io/library/alpine:latest",
            "alpine-a",
            &ext4,
            config,
            &scratch,
            move || {
                let db_owner = db_owner.clone();
                let ext4_owner = ext4_owner.clone();
                async move {
                    let state: String = db_owner
                        .conn()
                        .query_row(
                            "SELECT state FROM image_disk WHERE disk_key = 'alpine-a'",
                            [],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(state, "building");
                    write_file(&ext4_owner, b"partial");
                    slot_tx.send(()).unwrap();
                    loop {
                        let attached =
                            shared_disk::image_key(&db_owner, "docker.io/library/alpine:3.24")
                                .unwrap()
                                .is_some();
                        if attached {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                    Err(BoxliteError::Image("mkfs failed".into()))
                }
            },
        )
        .await;
        let waiter = waiter.await.unwrap();
        assert!(owner.unwrap_err().to_string().contains("mkfs failed"));
        assert!(waiter.unwrap_err().to_string().contains("mkfs failed"));
        assert!(!ext4.exists());
        assert!(shared_disk::image_disk(&db, "alpine-a").unwrap().is_none());
        let names = shared_disk::image_refs_for_disk(&db, "alpine-a").unwrap();
        assert_eq!(
            names,
            vec![
                "docker.io/library/alpine:3.24".to_string(),
                "docker.io/library/alpine:latest".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn dead_building_rebuilds_the_same_key_without_a_second_image_row() {
        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let ext4 = dir
            .path()
            .join("images")
            .join("disk-images")
            .join("alpine-a.ext4");
        write_file(&ext4, b"partial");
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('alpine-a', ?1, 'building', '{}')",
                [ext4.to_str().unwrap()],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO image (ref, disk_key) VALUES ('docker.io/library/alpine:latest', 'alpine-a')",
                [],
            )
            .unwrap();
        let builds = BuildRegistry::new();
        let config = r#"{"entrypoint":["/bin/sh"],"cmd":[],"user":"0:0","exposed_ports":[],"env":[],"working_dir":"/"}"#;
        let ready = resolve_for_create(
            &db,
            &builds,
            "docker.io/library/alpine:latest",
            "alpine-a",
            &ext4,
            config,
            &ScratchFiles {
                manifest: dir.path().join("no-manifest"),
                config_blob: dir.path().join("no-config"),
                layers: Vec::new(),
                extracted: Vec::new(),
                index_manifest: None,
            },
            {
                let ext4 = ext4.clone();
                move || async move {
                    write_file(&ext4, b"rebuilt");
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&ready.path).unwrap(), b"rebuilt");
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM image WHERE ref = 'docker.io/library/alpine:latest'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let state: String = db
            .conn()
            .query_row(
                "SELECT state FROM image_disk WHERE disk_key = 'alpine-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "ready");
    }

    #[tokio::test]
    async fn dead_building_with_a_disk_root_does_not_rebuild() {
        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let ext4 = dir.path().join("partial.ext4");
        write_file(&ext4, b"partial");
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('alpine-a', ?1, 'building', '{}')",
                [ext4.to_str().unwrap()],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO image (ref, disk_key) VALUES ('docker.io/library/alpine:latest', 'alpine-a')",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO disk (id, root, parent) VALUES ('boxA', 'alpine-a', 'alpine-a')",
                [],
            )
            .unwrap();
        let err = resolve_for_create(
            &db,
            &BuildRegistry::new(),
            "docker.io/library/alpine:latest",
            "alpine-a",
            &ext4,
            "{}",
            &ScratchFiles {
                manifest: dir.path().join("m"),
                config_blob: dir.path().join("c"),
                layers: Vec::new(),
                extracted: Vec::new(),
                index_manifest: None,
            },
            || async { panic!("must not rebuild") },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("refusing to rebuild"), "{err}");
        assert_eq!(std::fs::read(&ext4).unwrap(), b"partial");
        assert_eq!(
            shared_disk::image_disk(&db, "alpine-a").unwrap().unwrap().1,
            "building"
        );
    }

    #[tokio::test]
    async fn ready_file_missing_without_root_rebuilds_and_does_not_commit_qcow() {
        let dir = home();
        let installed = install_ready(dir.path());
        std::fs::remove_file(&installed.ext4).unwrap();
        let builds = BuildRegistry::new();
        let commits = Arc::new(AtomicUsize::new(0));
        let seen = commits.clone();
        let ext4 = installed.ext4.clone();
        let db = installed.db.clone();
        let key = installed.disk_key.clone();
        let db_build = db.clone();
        let key_build = key.clone();
        let ext4_build = ext4.clone();
        let ready = resolve_for_create(
            &db,
            &builds,
            installed.image_ref,
            &key,
            &ext4,
            r#"{"entrypoint":["/bin/sh"],"cmd":[],"user":"guest","exposed_ports":[],"env":["HELLO=from-image"],"working_dir":"/work"}"#,
            &ScratchFiles {
                manifest: dir.path().join("gone-manifest"),
                config_blob: dir.path().join("gone-config"),
                layers: Vec::new(),
                extracted: Vec::new(),
                index_manifest: None,
            },
            move || {
                let db_build = db_build.clone();
                let key_build = key_build.clone();
                let ext4_build = ext4_build.clone();
                let seen = seen.clone();
                async move {
                    let state = shared_disk::image_disk(&db_build, &key_build).unwrap().unwrap().1;
                    assert_eq!(state, "building");
                    assert!(!shared_disk::commit_disk(&db_build, "boxZ", &key_build, &key_build).unwrap());
                    seen.fetch_add(1, Ordering::SeqCst);
                    write_file(&ext4_build, b"rebuilt");
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(commits.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read(ready.path).unwrap(), b"rebuilt");
        assert!(shared_disk::disk_row(&db, "boxZ").unwrap().is_none());
        assert!(shared_disk::commit_disk(&db, "boxZ", &key, &key).unwrap());
    }

    #[test]
    fn rmi_keeps_a_referenced_disk_and_retries_deleting() {
        let dir = home();
        let installed = install_ready(dir.path());
        let db = &installed.db;
        let builds = BuildRegistry::new();
        shared_disk::ensure_image(db, "docker.io/library/alpine:3.24", &installed.disk_key)
            .unwrap();
        remove_named(db, &builds, "docker.io/library/alpine:latest", true).unwrap();
        assert!(installed.ext4.exists());
        assert_eq!(
            shared_disk::image_disk(db, &installed.disk_key)
                .unwrap()
                .unwrap()
                .1,
            "ready"
        );
        assert!(
            shared_disk::image_key(db, "docker.io/library/alpine:latest")
                .unwrap()
                .is_none()
        );

        shared_disk::commit_disk(db, "boxA", &installed.disk_key, &installed.disk_key).unwrap();
        let err = remove_named(db, &builds, "docker.io/library/alpine:3.24", true).unwrap_err();
        assert!(err.to_string().contains("disk.root"), "{err}");
        assert!(installed.ext4.exists());
        assert!(
            shared_disk::image_key(db, "docker.io/library/alpine:3.24")
                .unwrap()
                .is_some()
        );

        shared_disk::delete_disk_if_free(db, "boxA").unwrap();
        db.conn()
            .execute(
                "INSERT INTO disk (id, root, parent) VALUES ('racer', ?1, ?1)",
                [installed.disk_key.as_str()],
            )
            .unwrap();
        assert!(
            !shared_disk::claim_deleting_last_name(
                db,
                "docker.io/library/alpine:3.24",
                &installed.disk_key
            )
            .unwrap()
        );
        assert!(installed.ext4.exists(), "0-row claim must not unlink");
        let err = remove_named(db, &builds, "docker.io/library/alpine:3.24", true).unwrap_err();
        assert!(err.to_string().contains("disk.root"), "{err}");
        db.conn()
            .execute("DELETE FROM disk WHERE id = 'racer'", [])
            .unwrap();
        remove_named(db, &builds, "docker.io/library/alpine:3.24", false).unwrap();
        assert!(!installed.ext4.exists());
        assert!(
            shared_disk::image_disk(db, &installed.disk_key)
                .unwrap()
                .is_none()
        );
        assert!(
            shared_disk::image_key(db, "docker.io/library/alpine:3.24")
                .unwrap()
                .is_none()
        );

        db.conn()
            .execute(
                "INSERT INTO image (ref, disk_key) VALUES ('docker.io/library/alpine:3.24', ?1)",
                [installed.disk_key.as_str()],
            )
            .unwrap();
        remove_named(db, &builds, "docker.io/library/alpine:3.24", false).unwrap();
        assert!(
            shared_disk::image_key(db, "docker.io/library/alpine:3.24")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rmi_force_on_a_live_build_drops_one_waiter_and_stops_the_last_name() {
        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = BuildRegistry::new();
        let ext4 = dir.path().join("partial.ext4");
        write_file(&ext4, b"partial");
        let path = ext4.to_str().unwrap();
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('alpine-a', ?1, 'building', '{}')",
                [path],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO image (ref, disk_key) VALUES ('docker.io/library/alpine:latest', 'alpine-a'), ('docker.io/library/alpine:3.24', 'alpine-a')",
                [],
            )
            .unwrap();
        match builds.reserve("alpine-a") {
            Reservation::Own(_) => {}
            Reservation::Wait(_) => panic!("expected to own the build"),
        }
        let err = remove_named(&db, &builds, "docker.io/library/alpine:latest", false).unwrap_err();
        assert!(err.to_string().contains("building"), "{err}");
        assert!(ext4.exists());
        remove_named(&db, &builds, "docker.io/library/alpine:latest", true).unwrap();
        assert_eq!(
            shared_disk::image_disk(&db, "alpine-a").unwrap().unwrap().1,
            "building"
        );
        assert!(ext4.exists());
        assert!(
            shared_disk::image_key(&db, "docker.io/library/alpine:latest")
                .unwrap()
                .is_none()
        );
        remove_named(&db, &builds, "docker.io/library/alpine:3.24", true).unwrap();
        assert!(!ext4.exists());
        assert!(shared_disk::image_disk(&db, "alpine-a").unwrap().is_none());
        assert!(
            shared_disk::image_key(&db, "docker.io/library/alpine:3.24")
                .unwrap()
                .is_none()
        );
        let state = builds.get("alpine-a").unwrap();
        let outcome = state.outcome.lock().expect("build outcome").clone();
        assert!(matches!(outcome, Outcome::Failed(_)));
    }

    #[test]
    fn deleting_start_conflicts_and_retry_finishes_unlink() {
        let dir = home();
        let installed = install_ready(dir.path());
        let db = &installed.db;
        db.conn()
            .execute(
                "UPDATE image_disk SET state = 'deleting' WHERE disk_key = ?1",
                [installed.disk_key.as_str()],
            )
            .unwrap();
        let err = choose_start(db, installed.image_ref).unwrap_err();
        assert!(err.to_string().contains("operation conflict"), "{err}");
        assert!(installed.ext4.exists());
        remove_named(db, &BuildRegistry::new(), installed.image_ref, false).unwrap();
        assert!(!installed.ext4.exists());
        assert!(
            shared_disk::image_key(db, installed.image_ref)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn unused_and_disk_key_removal_lose_the_race_to_a_disk_row() {
        let dir = home();
        let installed = install_ready(dir.path());
        let db = &installed.db;
        db.conn()
            .execute(
                "DELETE FROM image WHERE disk_key = ?1",
                [installed.disk_key.as_str()],
            )
            .unwrap();
        let err = remove_disk_key(db, &installed.disk_key);
        assert!(err.is_ok(), "no image and no root deletes the ext4");
        assert!(!installed.ext4.exists());

        let installed = install_ready(dir.path());
        let db = &installed.db;
        db.conn()
            .execute(
                "DELETE FROM image WHERE disk_key = ?1",
                [installed.disk_key.as_str()],
            )
            .unwrap();
        assert!(
            shared_disk::commit_disk(db, "boxP", &installed.disk_key, &installed.disk_key).unwrap()
        );
        let err = remove_disk_key(db, &installed.disk_key).unwrap_err();
        assert!(err.to_string().contains("disk.root"), "{err}");
        assert!(installed.ext4.exists());
        remove_unused(db).unwrap();
        assert!(installed.ext4.exists());

        shared_disk::delete_disk_if_free(db, "boxP").unwrap();
        db.conn()
            .execute(
                "UPDATE image_disk SET state = 'deleting' WHERE disk_key = ?1",
                [installed.disk_key.as_str()],
            )
            .unwrap();
        remove_unused(db).unwrap();
        assert!(!installed.ext4.exists());
        assert!(
            shared_disk::image_disk(db, &installed.disk_key)
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn failure_is_visible_to_a_waiter_that_arrives_later() {
        let live = LiveBuild::new();
        live.fail("mkfs failed".into());
        let err = live
            .wait("docker.io/library/alpine:latest")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("mkfs failed"), "{err}");
    }

    #[tokio::test]
    async fn force_rmi_fails_only_the_removed_waiter() {
        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = Arc::new(BuildRegistry::new());
        let ext4 = dir.path().join("partial.ext4");
        write_file(&ext4, b"partial");
        let config = r#"{"entrypoint":["/bin/sh"],"cmd":[],"user":"guest","exposed_ports":[],"env":[],"working_dir":"/"}"#;
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('alpine-a', ?1, 'building', ?2)",
                rusqlite::params![ext4.to_str().unwrap(), config],
            )
            .unwrap();
        match builds.reserve("alpine-a") {
            Reservation::Own(_) => {}
            Reservation::Wait(_) => panic!("expected to own the build"),
        }

        let spawn_waiter = |image_ref: &'static str| {
            let db = db.clone();
            let builds = builds.clone();
            let ext4 = ext4.clone();
            tokio::spawn(async move {
                resolve_for_create(
                    &db,
                    &builds,
                    image_ref,
                    "alpine-a",
                    &ext4,
                    config,
                    &ScratchFiles {
                        manifest: ext4.with_file_name("manifest"),
                        config_blob: ext4.with_file_name("config"),
                        layers: Vec::new(),
                        extracted: Vec::new(),
                        index_manifest: None,
                    },
                    || async { panic!("waiter must not build") },
                )
                .await
            })
        };
        let dropped = spawn_waiter("docker.io/library/alpine:latest");
        let mut remaining = spawn_waiter("docker.io/library/alpine:3.24");
        loop {
            let names = shared_disk::image_refs_for_disk(&db, "alpine-a").unwrap();
            if names.len() == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
        remove_named(&db, &builds, "docker.io/library/alpine:latest", true).unwrap();
        let dropped = tokio::time::timeout(std::time::Duration::from_secs(2), dropped)
            .await
            .expect("removed waiter hung")
            .unwrap()
            .unwrap_err();
        assert!(dropped.to_string().contains("removed"), "{dropped}");
        assert_eq!(
            shared_disk::image_disk(&db, "alpine-a").unwrap().unwrap().1,
            "building"
        );
        assert!(ext4.exists());
        match tokio::time::timeout(std::time::Duration::from_millis(200), &mut remaining).await {
            Ok(finished) => panic!("remaining waiter finished before ready: {finished:?}"),
            Err(_still_waiting) => {}
        }

        assert!(shared_disk::mark_ready(&db, "alpine-a", ext4.to_str().unwrap()).unwrap());
        builds.get("alpine-a").unwrap().publish_ready();
        let ready = tokio::time::timeout(std::time::Duration::from_secs(2), remaining)
            .await
            .expect("remaining waiter hung")
            .unwrap()
            .unwrap();
        assert_eq!(ready.path, ext4);
        assert_eq!(
            shared_disk::image_key(&db, "docker.io/library/alpine:latest").unwrap(),
            None
        );
        assert_eq!(
            shared_disk::image_key(&db, "docker.io/library/alpine:3.24")
                .unwrap()
                .as_deref(),
            Some("alpine-a")
        );
        assert_eq!(
            shared_disk::image_disk(&db, "alpine-a").unwrap().unwrap().1,
            "ready"
        );
    }

    #[test]
    fn disk_key_rmi_refuses_while_an_image_name_remains() {
        let dir = home();
        let installed = install_ready(dir.path());
        let err = remove_disk_key(&installed.db, &installed.disk_key).unwrap_err();
        assert!(err.to_string().contains("image name"), "{err}");
        assert!(installed.ext4.exists());
        assert_eq!(
            shared_disk::image_key(&installed.db, installed.image_ref)
                .unwrap()
                .as_deref(),
            Some(installed.disk_key.as_str())
        );
        assert_eq!(
            shared_disk::image_disk(&installed.db, &installed.disk_key)
                .unwrap()
                .unwrap()
                .1,
            "ready"
        );
    }

    /// The pre-check sees one ready name and no `disk.root`. The claim's UPDATE
    /// then matches nothing because a root appears as that statement starts.
    /// Zero rows must leave the file and the name, and must not report success.
    #[test]
    fn rmi_claim_that_matches_nothing_is_an_error() {
        use std::cell::RefCell;

        thread_local! {
            static PLANT: RefCell<Option<(PathBuf, String)>> = const { RefCell::new(None) };
        }

        unsafe extern "C" fn plant(
            event: std::ffi::c_uint,
            _ctx: *mut std::ffi::c_void,
            _stmt: *mut std::ffi::c_void,
            sql: *mut std::ffi::c_void,
        ) -> std::ffi::c_int {
            if event != rusqlite::ffi::SQLITE_TRACE_STMT || sql.is_null() {
                return 0;
            }
            let text = unsafe {
                std::ffi::CStr::from_ptr(sql as *const std::ffi::c_char).to_string_lossy()
            };
            if !text.contains("SET state = 'deleting'") {
                return 0;
            }
            let _ = std::panic::catch_unwind(|| {
                let Some((path, key)) = PLANT.with(|slot| slot.borrow_mut().take()) else {
                    return;
                };
                let conn = rusqlite::Connection::open(path).expect("race connection");
                conn.execute(
                    "INSERT INTO disk (id, root, parent) VALUES ('racer', ?1, ?1)",
                    [key],
                )
                .expect("plant disk.root");
            });
            0
        }

        let dir = home();
        let installed = install_ready(dir.path());
        PLANT.with(|slot| {
            *slot.borrow_mut() = Some((
                dir.path().join("db").join("boxlite.db"),
                installed.disk_key.clone(),
            ));
        });
        {
            let conn = installed.db.conn();
            unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    conn.handle(),
                    rusqlite::ffi::SQLITE_TRACE_STMT,
                    Some(plant),
                    std::ptr::null_mut(),
                );
            }
        }

        let result = remove_named(
            &installed.db,
            &BuildRegistry::new(),
            installed.image_ref,
            false,
        );
        PLANT.with(|slot| slot.borrow_mut().take());
        assert!(
            shared_disk::disk_row(&installed.db, "racer")
                .unwrap()
                .is_some(),
            "disk.root must appear before the claim update runs"
        );
        assert!(installed.ext4.exists(), "0-row claim must not unlink");
        let err = result.expect_err("a claim that changes 0 rows must not succeed");
        assert!(
            err.to_string().contains("disk.root") || err.to_string().contains("another name"),
            "{err}"
        );
        assert_eq!(
            shared_disk::image_disk(&installed.db, &installed.disk_key)
                .unwrap()
                .unwrap()
                .1,
            "ready"
        );
        assert_eq!(
            shared_disk::image_key(&installed.db, installed.image_ref)
                .unwrap()
                .as_deref(),
            Some(installed.disk_key.as_str())
        );
    }

    /// `rmi --force` deletes the only name before the waiter calls `ensure_image`.
    /// `force_rmi_fails_only_the_removed_waiter` waits until both rows exist first,
    /// so it never sees this reinsert.
    #[tokio::test]
    async fn force_rmi_before_the_waiter_registers_keeps_the_name_deleted() {
        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = BuildRegistry::new();
        let ext4 = dir.path().join("partial.ext4");
        write_file(&ext4, b"partial");
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('alpine-a', ?1, 'building', ?2)",
                rusqlite::params![ext4.to_str().unwrap(), GUEST_CONFIG],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO image (ref, disk_key) VALUES ('docker.io/library/alpine:latest', 'alpine-a')",
                [],
            )
            .unwrap();
        match builds.reserve("alpine-a") {
            Reservation::Own(_) => {}
            Reservation::Wait(_) => panic!("expected to own the build"),
        }
        remove_named(&db, &builds, "docker.io/library/alpine:latest", true).unwrap();
        assert!(
            shared_disk::image_key(&db, "docker.io/library/alpine:latest")
                .unwrap()
                .is_none()
        );

        let err = resolve_for_create(
            &db,
            &builds,
            "docker.io/library/alpine:latest",
            "alpine-a",
            &ext4,
            GUEST_CONFIG,
            &empty_scratch(dir.path()),
            || async { panic!("removed waiter must not build") },
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("removed") || err.to_string().contains("stopped"),
            "{err}"
        );
        assert!(
            shared_disk::image_key(&db, "docker.io/library/alpine:latest")
                .unwrap()
                .is_none(),
            "removed name was inserted again"
        );
        assert!(shared_disk::image_disk(&db, "alpine-a").unwrap().is_none());
    }

    /// The name list is read once at the start of `remove_named`. This plants a
    /// second name after that read has finished and before unlink. The last-name
    /// `--force` arm must notice the new name and leave the file and the original
    /// name in place.
    #[test]
    fn force_rmi_last_name_keeps_the_file_when_a_second_name_appears() {
        use std::cell::RefCell;
        use std::sync::atomic::AtomicBool;

        struct Plant {
            db_path: PathBuf,
            planted: AtomicBool,
        }

        thread_local! {
            static PLANT: RefCell<Option<Plant>> = const { RefCell::new(None) };
        }

        unsafe extern "C" fn plant_second_name(
            event: std::ffi::c_uint,
            _ctx: *mut std::ffi::c_void,
            stmt: *mut std::ffi::c_void,
            _nanos: *mut std::ffi::c_void,
        ) -> std::ffi::c_int {
            if event != rusqlite::ffi::SQLITE_TRACE_PROFILE || stmt.is_null() {
                return 0;
            }
            let sql_ptr =
                unsafe { rusqlite::ffi::sqlite3_sql(stmt as *mut rusqlite::ffi::sqlite3_stmt) };
            if sql_ptr.is_null() {
                return 0;
            }
            let text = unsafe { std::ffi::CStr::from_ptr(sql_ptr).to_string_lossy() };
            if !text.contains("SELECT ref FROM image WHERE disk_key") {
                return 0;
            }
            let _ = std::panic::catch_unwind(|| {
                let Some(path) = PLANT.with(|slot| {
                    let plant = slot.borrow();
                    let plant = plant.as_ref()?;
                    if plant
                        .planted
                        .swap(true, std::sync::atomic::Ordering::SeqCst)
                    {
                        return None;
                    }
                    Some(plant.db_path.clone())
                }) else {
                    return;
                };
                let conn = rusqlite::Connection::open(path).expect("race connection");
                conn.execute_batch("PRAGMA busy_timeout=5000;")
                    .expect("busy timeout");
                conn.execute(
                    "INSERT INTO image (ref, disk_key) VALUES ('docker.io/library/alpine:3.24', 'alpine-a')",
                    [],
                )
                .expect("plant second name");
            });
            0
        }

        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = BuildRegistry::new();
        let ext4 = dir.path().join("partial.ext4");
        write_file(&ext4, b"partial");
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('alpine-a', ?1, 'building', ?2)",
                rusqlite::params![ext4.to_str().unwrap(), GUEST_CONFIG],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO image (ref, disk_key) VALUES ('docker.io/library/alpine:latest', 'alpine-a')",
                [],
            )
            .unwrap();
        match builds.reserve("alpine-a") {
            Reservation::Own(_) => {}
            Reservation::Wait(_) => panic!("expected to own the build"),
        }
        PLANT.with(|slot| {
            *slot.borrow_mut() = Some(Plant {
                db_path: dir.path().join("db").join("boxlite.db"),
                planted: AtomicBool::new(false),
            });
        });
        {
            let conn = db.conn();
            unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    conn.handle(),
                    rusqlite::ffi::SQLITE_TRACE_PROFILE,
                    Some(plant_second_name),
                    std::ptr::null_mut(),
                );
            }
        }

        let result = remove_named(&db, &builds, "docker.io/library/alpine:latest", true);
        let planted = PLANT.with(|slot| {
            slot.borrow()
                .as_ref()
                .map(|plant| plant.planted.load(std::sync::atomic::Ordering::SeqCst))
                .unwrap_or(false)
        });
        assert!(
            planted,
            "the name query never finished, so the second name was not planted"
        );
        assert_eq!(
            shared_disk::image_key(&db, "docker.io/library/alpine:3.24")
                .unwrap()
                .as_deref(),
            Some("alpine-a"),
            "the second name must be visible to the unlink decision"
        );
        assert!(
            ext4.exists(),
            "last-name --force unlinked after a second name appeared"
        );
        assert_eq!(
            shared_disk::image_key(&db, "docker.io/library/alpine:latest")
                .unwrap()
                .as_deref(),
            Some("alpine-a"),
            "the name was deleted before the file and image_disk were gone"
        );
        assert!(shared_disk::image_disk(&db, "alpine-a").unwrap().is_some());
        let err = result.expect_err("a second name must refuse the unlink");
        assert!(err.to_string().contains("another name"), "{err}");
    }

    /// `rmi --force` stops the build after this waiter has passed `failure()` and
    /// before `ensure_image` inserts the name. The waiter must fail and must not
    /// leave that name behind.
    #[tokio::test]
    async fn waiter_that_loses_the_race_to_stop_does_not_leave_the_name() {
        use std::cell::RefCell;
        use std::sync::atomic::{AtomicBool, AtomicUsize};

        struct Race {
            db_path: PathBuf,
            ext4: PathBuf,
            live: Arc<LiveBuild>,
            selects: AtomicUsize,
            fired: AtomicBool,
        }

        thread_local! {
            static RACE: RefCell<Option<Race>> = const { RefCell::new(None) };
        }

        unsafe extern "C" fn stop_before_insert(
            event: std::ffi::c_uint,
            _ctx: *mut std::ffi::c_void,
            _stmt: *mut std::ffi::c_void,
            sql: *mut std::ffi::c_void,
        ) -> std::ffi::c_int {
            if event != rusqlite::ffi::SQLITE_TRACE_STMT || sql.is_null() {
                return 0;
            }
            let text = unsafe {
                std::ffi::CStr::from_ptr(sql as *const std::ffi::c_char).to_string_lossy()
            };
            if !text.contains("SELECT path, state, config FROM image_disk") {
                return 0;
            }
            let Some((db_path, ext4, live)) = RACE.with(|slot| {
                let race = slot.borrow();
                let race = race.as_ref()?;
                let n = race
                    .selects
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    + 1;
                if n != 3 {
                    return None;
                }
                race.fired.store(true, std::sync::atomic::Ordering::SeqCst);
                Some((race.db_path.clone(), race.ext4.clone(), race.live.clone()))
            }) else {
                return 0;
            };
            let _ = std::panic::catch_unwind(|| {
                live.stop();
                let conn = rusqlite::Connection::open(db_path).expect("race connection");
                conn.execute_batch("PRAGMA busy_timeout=5000;")
                    .expect("busy timeout");
                conn.execute(
                    "DELETE FROM image WHERE ref = 'docker.io/library/alpine:latest'",
                    [],
                )
                .expect("delete name");
                conn.execute("DELETE FROM image_disk WHERE disk_key = 'alpine-a'", [])
                    .expect("clear image_disk");
                let _ = std::fs::remove_file(ext4);
            });
            0
        }

        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = BuildRegistry::new();
        let ext4 = dir.path().join("partial.ext4");
        write_file(&ext4, b"partial");
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('alpine-a', ?1, 'building', ?2)",
                rusqlite::params![ext4.to_str().unwrap(), GUEST_CONFIG],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO image (ref, disk_key) VALUES ('docker.io/library/alpine:latest', 'alpine-a')",
                [],
            )
            .unwrap();
        let live = match builds.reserve("alpine-a") {
            Reservation::Own(live) => live,
            Reservation::Wait(_) => panic!("expected to own the build"),
        };
        RACE.with(|slot| {
            *slot.borrow_mut() = Some(Race {
                db_path: dir.path().join("db").join("boxlite.db"),
                ext4: ext4.clone(),
                live,
                selects: AtomicUsize::new(0),
                fired: AtomicBool::new(false),
            });
        });
        {
            let conn = db.conn();
            unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    conn.handle(),
                    rusqlite::ffi::SQLITE_TRACE_STMT,
                    Some(stop_before_insert),
                    std::ptr::null_mut(),
                );
            }
        }

        let err = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            resolve_for_create(
                &db,
                &builds,
                "docker.io/library/alpine:latest",
                "alpine-a",
                &ext4,
                GUEST_CONFIG,
                &empty_scratch(dir.path()),
                || async { panic!("removed waiter must not build") },
            ),
        )
        .await
        .expect("waiter hung")
        .unwrap_err();
        let fired = RACE.with(|slot| {
            slot.borrow()
                .as_ref()
                .map(|race| race.fired.load(std::sync::atomic::Ordering::SeqCst))
                .unwrap_or(false)
        });
        assert!(
            fired,
            "stop did not land between the failure check and ensure_image"
        );
        assert!(
            err.to_string().contains("stopped") || err.to_string().contains("removed"),
            "{err}"
        );
        assert!(
            shared_disk::image_key(&db, "docker.io/library/alpine:latest")
                .unwrap()
                .is_none(),
            "waiter that lost the race to stop left the image row in place: {:?}",
            shared_disk::image_key(&db, "docker.io/library/alpine:latest").unwrap()
        );
    }

    #[tokio::test]
    async fn stopped_owner_does_not_rewrite_the_removed_name() {
        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = BuildRegistry::new();
        let ext4 = dir.path().join("partial.ext4");
        write_file(&ext4, b"partial");
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('alpine-a', ?1, 'building', ?2)",
                rusqlite::params![ext4.to_str().unwrap(), GUEST_CONFIG],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO image (ref, disk_key) VALUES ('docker.io/library/alpine:latest', 'alpine-a')",
                [],
            )
            .unwrap();
        let live = match builds.reserve("alpine-a") {
            Reservation::Own(live) => live,
            Reservation::Wait(_) => panic!("expected to own the build"),
        };
        remove_named(&db, &builds, "docker.io/library/alpine:latest", true).unwrap();
        let err = own_build(
            &db,
            &builds,
            &live,
            "docker.io/library/alpine:latest",
            "alpine-a",
            &ext4,
            GUEST_CONFIG,
            &empty_scratch(dir.path()),
            || async { Ok(()) },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("stopped"), "{err}");
        assert!(
            shared_disk::image_key(&db, "docker.io/library/alpine:latest")
                .unwrap()
                .is_none(),
            "begin_build rewrote the removed name"
        );
        assert!(!ext4.exists(), "a stopped build must not leave a new ext4");
    }

    #[test]
    fn deleting_with_a_second_name_does_not_unlink() {
        let dir = home();
        let installed = install_ready(dir.path());
        let db = &installed.db;
        db.conn()
            .execute(
                "UPDATE image_disk SET state = 'deleting' WHERE disk_key = ?1",
                [installed.disk_key.as_str()],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO image (ref, disk_key) VALUES ('docker.io/library/alpine:3.24', ?1)",
                [installed.disk_key.as_str()],
            )
            .unwrap();
        let err = remove_named(db, &BuildRegistry::new(), installed.image_ref, false).unwrap_err();
        assert!(err.to_string().contains("another name"), "{err}");
        assert!(installed.ext4.exists(), "a second name must keep the ext4");
        assert!(
            shared_disk::image_disk(db, &installed.disk_key)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            shared_disk::image_key(db, installed.image_ref)
                .unwrap()
                .as_deref(),
            Some(installed.disk_key.as_str()),
            "the name stays until the file and image_disk are gone"
        );
        assert_eq!(
            shared_disk::image_key(db, "docker.io/library/alpine:3.24")
                .unwrap()
                .as_deref(),
            Some(installed.disk_key.as_str())
        );
    }

    fn empty_scratch(dir: &Path) -> ScratchFiles {
        ScratchFiles {
            manifest: dir.join("manifest"),
            config_blob: dir.join("config"),
            layers: vec![dir.join("layer.tar.gz")],
            extracted: vec![dir.join("extracted")],
            index_manifest: None,
        }
    }

    const GUEST_CONFIG: &str = r#"{"entrypoint":["/bin/sh"],"cmd":[],"user":"guest","exposed_ports":[],"env":[],"working_dir":"/"}"#;

    /// An error before `LiveBuild::fail` — a non-UTF-8 ext4 path never reaches
    /// `begin_build` — must still fail a waiter already parked on the build and
    /// a waiter that arrives after the owner has returned.
    #[tokio::test]
    async fn error_before_publish_fails_current_and_late_waiters() {
        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = BuildRegistry::new();
        let live = match builds.reserve("alpine-a") {
            Reservation::Own(live) => live,
            Reservation::Wait(_) => panic!("expected to own the build"),
        };
        use std::os::unix::ffi::OsStringExt;
        let bad = PathBuf::from(std::ffi::OsString::from_vec(b"not-utf8-\xff.ext4".to_vec()));
        let scratch = empty_scratch(dir.path());
        let parked = live.clone();
        let waiter =
            tokio::spawn(async move { parked.wait("docker.io/library/alpine:3.24").await });
        tokio::task::yield_now().await;

        let owner = own_build(
            &db,
            &builds,
            &live,
            "docker.io/library/alpine:latest",
            "alpine-a",
            &bad,
            GUEST_CONFIG,
            &scratch,
            || async { panic!("build must not run") },
        )
        .await;
        let waiter = tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("waiter hung on Outcome::Pending")
            .unwrap()
            .unwrap_err();
        let owner = owner.unwrap_err();
        assert!(owner.to_string().contains("utf-8"), "{owner}");
        assert!(waiter.to_string().contains("utf-8"), "{waiter}");

        let late = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            live.wait("docker.io/library/alpine:latest"),
        )
        .await
        .expect("late waiter hung on Outcome::Pending")
        .unwrap_err();
        assert!(late.to_string().contains("utf-8"), "{late}");
        assert!(shared_disk::image_disk(&db, "alpine-a").unwrap().is_none());
    }

    /// `fail_build` must wake waiters even when deleting the partial ext4 fails.
    #[tokio::test]
    async fn cleanup_failure_still_wakes_waiters() {
        use std::os::unix::fs::PermissionsExt;

        struct RestoreMode(PathBuf);
        impl Drop for RestoreMode {
            fn drop(&mut self) {
                if let Ok(meta) = std::fs::metadata(&self.0) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = std::fs::set_permissions(&self.0, perms);
                }
            }
        }

        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = BuildRegistry::new();
        let ext4 = dir.path().join("partial.ext4");
        std::fs::create_dir_all(&ext4).unwrap();
        write_file(&ext4.join("stuck"), b"partial");
        let _restore = RestoreMode(ext4.clone());
        let mut perms = std::fs::metadata(&ext4).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&ext4, perms).unwrap();

        let live = match builds.reserve("alpine-a") {
            Reservation::Own(live) => live,
            Reservation::Wait(_) => panic!("expected to own the build"),
        };
        let parked = live.clone();
        let waiter =
            tokio::spawn(async move { parked.wait("docker.io/library/alpine:3.24").await });
        tokio::task::yield_now().await;

        let owner = own_build(
            &db,
            &builds,
            &live,
            "docker.io/library/alpine:latest",
            "alpine-a",
            &ext4,
            GUEST_CONFIG,
            &empty_scratch(dir.path()),
            || async { Err(BoxliteError::Image("mkfs failed".into())) },
        )
        .await;
        let waiter = tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("waiter hung on Outcome::Pending")
            .unwrap()
            .unwrap_err();
        assert!(waiter.to_string().contains("mkfs failed"), "{waiter}");
        let _ = owner.unwrap_err();
        assert!(
            ext4.join("stuck").exists(),
            "cleanup failed, so the partial ext4 must still be there"
        );
        let late = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            live.wait("docker.io/library/alpine:latest"),
        )
        .await
        .expect("late waiter hung on Outcome::Pending")
        .unwrap_err();
        assert!(late.to_string().contains("mkfs failed"), "{late}");
    }

    #[tokio::test]
    async fn ready_image_keeps_a_layer_another_build_still_needs() {
        let dir = home();
        let images = dir.path().join("images");
        let storage = ImageStorage::new(images.clone()).unwrap();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = Arc::new(BuildRegistry::new());
        let shared_layer = storage.layer_tarball_path("sha256:shared");
        let shared_extracted = storage.layer_extracted_path("sha256:shared");
        let only_a = storage.layer_tarball_path("sha256:onlya");
        write_file(&shared_layer, b"shared-layer");
        write_file(&shared_extracted.join("marker"), b"shared-extracted");
        write_file(&only_a, b"only-a");

        let ext4_a = images.join("disk-images").join("disk-a.ext4");
        let ext4_b = images.join("disk-images").join("disk-b.ext4");
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();

        let builds_b = builds.clone();
        let db_b = db.clone();
        let shared_for_b = shared_layer.clone();
        let extracted_for_b = shared_extracted.clone();
        let ext4_b_build = ext4_b.clone();
        let scratch_b = ScratchFiles {
            manifest: storage.manifest_path("sha256:manifestb"),
            config_blob: storage.config_path("sha256:configb"),
            layers: vec![shared_layer.clone()],
            extracted: vec![shared_extracted.clone()],
            index_manifest: None,
        };
        let builder = tokio::spawn(async move {
            resolve_for_create(
                &db_b,
                &builds_b,
                "docker.io/library/debian:latest",
                "disk-b",
                &ext4_b,
                GUEST_CONFIG,
                &scratch_b,
                move || {
                    let shared_for_b = shared_for_b.clone();
                    let extracted_for_b = extracted_for_b.clone();
                    let ext4_b_build = ext4_b_build.clone();
                    async move {
                        entered_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                        assert_eq!(
                            std::fs::read(&shared_for_b).ok().as_deref(),
                            Some(&b"shared-layer"[..]),
                            "shared layer was deleted while another build still needs it"
                        );
                        assert_eq!(
                            std::fs::read(extracted_for_b.join("marker"))
                                .ok()
                                .as_deref(),
                            Some(&b"shared-extracted"[..]),
                            "extracted layer was deleted while another build still needs it"
                        );
                        write_file(&ext4_b_build, b"ext4-b");
                        Ok(())
                    }
                },
            )
            .await
        });

        entered_rx.await.unwrap();
        let ready_a = resolve_for_create(
            &db,
            &builds,
            "docker.io/library/alpine:latest",
            "disk-a",
            &ext4_a,
            GUEST_CONFIG,
            &ScratchFiles {
                manifest: storage.manifest_path("sha256:manifesta"),
                config_blob: storage.config_path("sha256:configa"),
                layers: vec![shared_layer.clone(), only_a.clone()],
                extracted: vec![shared_extracted.clone()],
                index_manifest: None,
            },
            {
                let ext4_a = ext4_a.clone();
                move || async move {
                    write_file(&ext4_a, b"ext4-a");
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        assert!(
            !only_a.exists(),
            "the ready image must still delete a layer only it used"
        );
        assert_eq!(std::fs::read(&ready_a.path).unwrap(), b"ext4-a");

        release_tx.send(()).unwrap();
        let ready_b = builder.await.unwrap().unwrap();
        assert_eq!(std::fs::read(&ready_b.path).unwrap(), b"ext4-b");
        assert!(
            !shared_layer.exists(),
            "the shared layer is deleted once no in-progress build names it"
        );
        assert!(!shared_extracted.exists());
    }

    /// `mark_ready` can fail after the ext4 file exists and before
    /// `LiveBuild::fail`. The database error is the failure the owner returns.
    /// A waiter already parked on the build, and one that arrives after the
    /// owner returns, must see that same error instead of staying pending.
    #[tokio::test]
    async fn mark_ready_database_error_fails_current_and_late_waiters() {
        let dir = home();
        let db = Database::open(&dir.path().join("db").join("boxlite.db")).unwrap();
        let builds = BuildRegistry::new();
        let ext4 = dir.path().join("built.ext4");
        let live = match builds.reserve("alpine-a") {
            Reservation::Own(live) => live,
            Reservation::Wait(_) => panic!("expected to own the build"),
        };
        let parked = live.clone();
        let waiter =
            tokio::spawn(async move { parked.wait("docker.io/library/alpine:3.24").await });
        tokio::task::yield_now().await;

        let db_build = db.clone();
        let ext4_build = ext4.clone();
        let owner = own_build(
            &db,
            &builds,
            &live,
            "docker.io/library/alpine:latest",
            "alpine-a",
            &ext4,
            GUEST_CONFIG,
            &empty_scratch(dir.path()),
            move || async move {
                db_build
                    .conn()
                    .execute_batch("DROP TABLE image_disk")
                    .unwrap();
                write_file(&ext4_build, b"ext4-bytes");
                Ok(())
            },
        )
        .await;

        let waiter = tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("waiter hung on Outcome::Pending")
            .unwrap()
            .unwrap_err();
        let owner = owner.unwrap_err();
        assert!(
            waiter.to_string().contains(&owner.to_string()),
            "waiter {waiter} did not observe the mark_ready error {owner}"
        );
        let late = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            live.wait("docker.io/library/alpine:latest"),
        )
        .await
        .expect("late waiter hung on Outcome::Pending")
        .unwrap_err();
        assert!(
            late.to_string().contains(&owner.to_string()),
            "late waiter {late} did not observe the mark_ready error {owner}"
        );
    }
}
