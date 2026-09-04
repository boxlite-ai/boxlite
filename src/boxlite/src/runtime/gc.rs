//! Garbage collection for the on-disk caches under `~/.boxlite/`.
//!
//! Sweep order matters and is fixed:
//!
//! 1. **`boxes/<id>/`** — directories whose box id no longer exists in the
//!    `box` table. The startup-time [`RuntimeImpl::cleanup_orphaned_directories`]
//!    handles crash-leftovers at boot, but a long-running `boxlite serve` that
//!    survives a half-finished `rm` accumulates these between starts; reclaiming
//!    them here is what makes `boxlite gc` work mid-session. Orphan box dirs
//!    are also the *largest* reclaimable chunk on a host that's leaked: each
//!    carries an overlay qcow2 plus per-box logs / sockets, easily 100s of MiB.
//!    Sweeping them **first** is also a correctness condition for sweep #3:
//!    the stale `boxes/<id>/disks/*.qcow2` of an orphan would otherwise pin
//!    image disk-images it backs onto, blocking that sweep.
//!
//! 2. **`bases/*.qcow2`** — snapshot / clone base files whose row in the
//!    `base_disk` table is gone (no source box, no ref). The `remove_box` →
//!    `try_gc_base` cascade collects most as they become unreferenced; this
//!    sweep catches the leftovers from a crash mid-rm or a stale row that
//!    failed to clean up.
//!
//! 3. **`images/disk-images/*.ext4`** — the merged per-image rootfs that box
//!    COW overlays back onto (via an absolute path baked into the qcow2
//!    header). Removable only when *no* (non-orphan) box overlay backs onto it;
//!    deleting a backed one would leave a box unable to start. Usually the
//!    biggest single artifact, but only reachable after #1 so orphan
//!    overlays don't keep image cache pinned.
//!
//! Out of scope here (handled elsewhere or deferred):
//! - LRU eviction of the re-pullable build cache (`images/layers`,
//!   `images/extracted`) needs blob-dedup accounting inside the image store
//!   and is a separate change.
//! - `logs/`, `tmp/` — small enough that even a fully-leaked one is rarely
//!   the cliff. Add when an operator reports a real recovery story that needs
//!   them.
//!
//! Safety: every sweep deletes only on a *referential* signal — orphan box id
//! not in DB, base path not in DB, disk-image absent from every backing chain.
//! No size / age heuristic is ever the sole reason for deletion. A mtime
//! grace skips files modified within the last few minutes so a concurrent box
//! start can't race a sweep.

use crate::runtime::rt_impl::RuntimeImpl;
use boxlite_shared::errors::BoxliteResult;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Don't reclaim a disk-image modified within this window. A concurrent box
/// start builds its disk-image and creates the backing overlay back-to-back
/// (sub-second); skipping recently-touched files avoids deleting one mid-start
/// without serializing the start hot path behind a global lock. A just-built
/// disk-image becomes collectable once it ages past this and no box backs it.
const DISK_IMAGE_GRACE: Duration = Duration::from_secs(600);

/// Same logic for box dirs and bases: a box that just finished `create` but
/// hasn't yet persisted its row, or a base whose row write is in flight,
/// gets a 10-minute window before it's eligible. Mirrors the rest of the
/// "don't race a concurrent in-flight start" posture.
const BOX_DIR_GRACE: Duration = Duration::from_secs(600);
const BASE_GRACE: Duration = Duration::from_secs(600);

/// What to sweep and how.
#[derive(Debug, Clone, Default)]
pub struct GcOptions {
    /// Report what would be reclaimed without deleting anything.
    pub dry_run: bool,
}

/// What a GC pass freed (or would free, under `dry_run`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct GcReport {
    pub dry_run: bool,
    /// Orphan `boxes/<id>/` directories reclaimed.
    pub box_dirs_removed: u64,
    pub box_dirs_bytes: u64,
    /// Orphan `bases/*.qcow2` reclaimed.
    pub bases_removed: u64,
    pub bases_bytes: u64,
    /// Orphan image disk-images reclaimed (no box overlay backs onto them).
    pub disk_images_removed: u64,
    pub disk_images_bytes: u64,
}

impl GcReport {
    pub fn total_bytes(&self) -> u64 {
        self.box_dirs_bytes + self.bases_bytes + self.disk_images_bytes
    }

    pub fn total_removed(&self) -> u64 {
        self.box_dirs_removed + self.bases_removed + self.disk_images_removed
    }
}

impl RuntimeImpl {
    /// Reclaim disk by sweeping orphan box dirs, orphan bases, and orphan
    /// image disk-images — in that order. Order matters: dropping orphan box
    /// dirs *first* prevents their stale qcow2 chains from pinning image
    /// disk-images in the third sweep.
    pub fn collect_garbage(&self, opts: &GcOptions) -> BoxliteResult<GcReport> {
        let mut report = GcReport {
            dry_run: opts.dry_run,
            ..Default::default()
        };

        // #1: orphan box dirs (must run before #3 — pinning depends on this)
        let known_boxes = self.known_box_ids()?;
        self.sweep_orphan_box_dirs(opts.dry_run, &known_boxes, &mut report);

        // #2: orphan bases
        self.sweep_orphan_bases(opts.dry_run, &mut report);

        // #3: orphan image disk-images
        self.sweep_orphan_disk_images(opts.dry_run, &known_boxes, &mut report);

        tracing::info!(
            dry_run = opts.dry_run,
            box_dirs = report.box_dirs_removed,
            bases = report.bases_removed,
            disk_images = report.disk_images_removed,
            bytes = report.total_bytes(),
            "GC pass complete"
        );
        Ok(report)
    }

    /// Set of box ids the DB knows about. Loaded once per GC pass so a
    /// concurrent `remove_box` mid-sweep can't make us re-classify a still-
    /// in-use box as orphan in the middle of the same pass.
    fn known_box_ids(&self) -> BoxliteResult<HashSet<String>> {
        self.box_manager.all_boxes(false).map(|rows| {
            rows.into_iter()
                .map(|(cfg, _)| cfg.id.to_string())
                .collect()
        })
    }

    /// Sweep `boxes/<id>/` directories whose id is not in `known`.
    ///
    /// The DB read that produces `known` is fallible and is completed before
    /// any sweep starts, so an empty set here means there are genuinely no
    /// registered boxes rather than an unknown database state.
    fn sweep_orphan_box_dirs(&self, dry_run: bool, known: &HashSet<String>, report: &mut GcReport) {
        let boxes_dir = self.layout.boxes_dir();
        let Ok(entries) = std::fs::read_dir(&boxes_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().map(|t| !t.is_dir()).unwrap_or(true) {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(String::from) else {
                continue;
            };
            if known.contains(&name) {
                continue;
            }
            // Mtime grace: a `create` that finished writing the dir but
            // hasn't yet committed its DB row would otherwise be reaped
            // mid-flight.
            if !is_past_grace(&path, BOX_DIR_GRACE) {
                continue;
            }
            let bytes = dir_size(&path);
            if !dry_run && let Err(error) = std::fs::remove_dir_all(&path) {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "Failed to remove orphan box directory"
                );
                continue;
            }
            tracing::info!(
                orphan_box = name,
                path = %path.display(),
                bytes,
                dry_run,
                "Orphan box directory reclaimed"
            );
            report.box_dirs_removed += 1;
            report.box_dirs_bytes += bytes;
        }
    }

    /// Sweep `bases/*.qcow2` whose path is absent from `base_disk.base_path`.
    ///
    /// Bases are normally collected by the `remove_box` → `try_gc_base`
    /// cascade as the last referencing box goes away. This sweep catches
    /// leftovers from a crash mid-rm or a row whose cleanup failed.
    fn sweep_orphan_bases(&self, dry_run: bool, report: &mut GcReport) {
        let bases_dir = self.layout.bases_dir();
        let Ok(entries) = std::fs::read_dir(&bases_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // Only ever reclaim `*.qcow2`. A stray foreign file (operator
            // copied something in, partial download, etc.) must not be
            // deleted just because the DB doesn't know about it.
            if path.extension().and_then(|e| e.to_str()) != Some("qcow2") {
                continue;
            }
            // Match by exact `base_path` string, as stored in the DB. We use
            // the absolute display() so symlinked or relative rows don't
            // accidentally match a different file — referenced bases live in
            // this dir with absolute paths.
            let probe = path.to_string_lossy().to_string();
            let referenced = match self.base_disk_mgr.store().find_by_base_path(&probe) {
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(e) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %e,
                        "Could not query base_disk for orphan-check; skipping"
                    );
                    continue;
                }
            };
            if referenced {
                continue;
            }
            if !is_past_grace(&path, BASE_GRACE) {
                continue;
            }
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let bytes = meta.len();
            if !dry_run && let Err(error) = std::fs::remove_file(&path) {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "Failed to remove orphan base disk"
                );
                continue;
            }
            tracing::info!(
                base = %path.display(),
                bytes,
                dry_run,
                "Orphan base disk reclaimed"
            );
            report.bases_removed += 1;
            report.bases_bytes += bytes;
        }
    }

    /// Remove `images/disk-images/*.ext4` files that no *live* box overlay
    /// backs onto. Pinning ignores orphan box dirs (those whose id is not in
    /// `known`) so a stale qcow2 from a half-removed box can't keep the image
    /// cache pinned. The orphan-box-dir sweep runs first in `collect_garbage`,
    /// which usually removes those overlays altogether — but we still filter
    /// here so a sweep cycle that skipped step 1 (empty `known`) doesn't
    /// double-deny image cache reclaim later.
    fn sweep_orphan_disk_images(
        &self,
        dry_run: bool,
        known: &HashSet<String>,
        report: &mut GcReport,
    ) {
        let disk_images_dir = self.layout.image_layout().disk_images_dir();
        let pinned = self.disk_images_backed_by_live_boxes(&disk_images_dir, known);

        let entries = match std::fs::read_dir(&disk_images_dir) {
            Ok(e) => e,
            Err(_) => return, // dir absent → nothing to sweep
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // Only ever reclaim `*.ext4` disk-images. The directory should hold
            // nothing else, but a stray partial/temp/foreign file must never be
            // deleted just because it aged out of the grace window.
            if path.extension().and_then(|e| e.to_str()) != Some("ext4") {
                continue;
            }
            // Compare by canonical path so a symlinked/relative backing pointer
            // still matches the file we're considering.
            let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
            if pinned.contains(&canonical) {
                continue; // a box overlay backs onto this — keep it
            }

            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            // Skip recently-modified files: a concurrent start may have just
            // built this disk-image and not yet created its backing overlay.
            if let Ok(modified) = meta.modified()
                && SystemTime::now()
                    .duration_since(modified)
                    .map(|age| age < DISK_IMAGE_GRACE)
                    .unwrap_or(true)
            {
                continue;
            }

            let bytes = meta.len();
            if !dry_run && let Err(error) = std::fs::remove_file(&path) {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "Failed to remove orphan image disk"
                );
                continue;
            }
            tracing::info!(
                disk_image = %path.display(),
                bytes,
                dry_run,
                "Orphan image disk reclaimed"
            );
            report.disk_images_removed += 1;
            report.disk_images_bytes += bytes;
        }
    }

    /// Canonical paths of disk-images that some *live* box overlay backs onto.
    ///
    /// Walks the backing chain of every `*.qcow2` under
    /// `boxes/<id>/disks/`, restricted to ids that the DB confirms still
    /// exist (`known`) — see the module-doc invariant: an orphan's stale
    /// chain must not pin the image cache.
    fn disk_images_backed_by_live_boxes(
        &self,
        disk_images_dir: &Path,
        known: &HashSet<String>,
    ) -> HashSet<PathBuf> {
        let disk_images_dir = disk_images_dir
            .canonicalize()
            .unwrap_or_else(|_| disk_images_dir.to_path_buf());
        let mut pinned = HashSet::new();

        let boxes_dir = self.layout.boxes_dir();
        let Ok(boxes) = std::fs::read_dir(&boxes_dir) else {
            return pinned;
        };
        for box_entry in boxes.flatten() {
            let name = match box_entry.file_name().to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            if !known.contains(&name) {
                continue;
            }
            let disks_dir = box_entry.path().join("disks");
            let Ok(disks) = std::fs::read_dir(&disks_dir) else {
                continue;
            };
            for disk in disks.flatten() {
                let disk_path = disk.path();
                if disk_path.extension().and_then(|e| e.to_str()) != Some("qcow2") {
                    continue;
                }
                for backing in crate::disk::read_backing_chain(&disk_path) {
                    let canonical = backing.canonicalize().unwrap_or(backing);
                    if canonical.starts_with(&disk_images_dir) {
                        pinned.insert(canonical);
                    }
                }
            }
        }
        pinned
    }
}

/// `path` was last modified more than `grace` ago (so it is safe to delete).
/// Returns `false` on any stat / clock failure so a transient error doesn't
/// turn into an accidental deletion.
fn is_past_grace(path: &Path, grace: Duration) -> bool {
    let modified = match std::fs::metadata(path).and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(_) => return false,
    };
    SystemTime::now()
        .duration_since(modified)
        .map(|age| age >= grace)
        .unwrap_or(false)
}

/// Total bytes occupied by `path` recursively, swallowing per-entry errors
/// so a single transient ENOENT mid-walk doesn't tank the whole report. Used
/// to attribute reclaimed bytes to an orphan box dir before `remove_dir_all`.
fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&p) else {
            continue;
        };
        for entry in entries.flatten() {
            let kind = match entry.file_type() {
                Ok(k) => k,
                Err(_) => continue,
            };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file()
                && let Ok(meta) = entry.metadata()
            {
                total += meta.len();
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::options::BoxliteOptions;
    use crate::runtime::rt_impl::RuntimeImpl;
    use boxlite_test_utils::home::PerTestBoxHome;

    /// A disk-image with no box backing it is reclaimed; one that a box overlay
    /// backs onto is kept. Dry-run reports but deletes nothing.
    #[test]
    fn sweeps_orphan_disk_images_only() {
        let home = PerTestBoxHome::isolated_in("/tmp");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: vec![],
        })
        .expect("create runtime");

        let disk_images_dir = runtime.layout.image_layout().disk_images_dir();
        std::fs::create_dir_all(&disk_images_dir).unwrap();

        // Three disk-images: one backed by a box, one old orphan (collectable),
        // one fresh orphan (protected by the grace period).
        const SZ: u64 = 1024 * 1024;
        let backed = disk_images_dir.join("sha256-backed.ext4");
        let orphan = disk_images_dir.join("sha256-orphan.ext4");
        let fresh = disk_images_dir.join("sha256-fresh.ext4");
        std::fs::write(&backed, vec![0u8; SZ as usize]).unwrap();
        std::fs::write(&orphan, vec![0u8; SZ as usize]).unwrap();
        std::fs::write(&fresh, vec![0u8; SZ as usize]).unwrap();

        // Age the orphan well past the grace window so it's collectable.
        let old = filetime::FileTime::from_unix_time(
            (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                - DISK_IMAGE_GRACE.as_secs()
                - 60) as i64,
            0,
        );
        filetime::set_file_mtime(&orphan, old).unwrap();

        // A box overlay whose qcow2 backing chain points at `backed`.
        let box_id = "01BOXBACKINGTESTAAAAAAAAAA";
        register_box(&runtime, box_id);
        let disks = runtime.layout.boxes_dir().join(box_id).join("disks");
        std::fs::create_dir_all(&disks).unwrap();
        // Bind the returned Disk: it deletes its file on drop unless persistent,
        // and we need the overlay to stay on disk for the backing-chain scan.
        let _overlay = crate::disk::Qcow2Helper::create_cow_child_disk(
            &backed,
            crate::disk::BackingFormat::Raw,
            &disks.join("disk.qcow2"),
            SZ,
        )
        .expect("create cow child");

        // Dry run: only the aged orphan qualifies (backed is pinned, fresh is
        // within the grace window). Nothing deleted.
        let preview = runtime
            .collect_garbage(&GcOptions { dry_run: true })
            .unwrap();
        assert_eq!(
            preview.disk_images_removed, 1,
            "only the aged orphan qualifies"
        );
        assert!(
            orphan.exists() && backed.exists() && fresh.exists(),
            "dry run must not delete"
        );

        // Real run: aged orphan gone; backed (pinned) and fresh (grace) kept.
        let done = runtime
            .collect_garbage(&GcOptions { dry_run: false })
            .unwrap();
        assert_eq!(done.disk_images_removed, 1);
        assert!(!orphan.exists(), "aged orphan should be reclaimed");
        assert!(backed.exists(), "box-backed disk-image must be kept");
        assert!(fresh.exists(), "recently-built disk-image kept by grace");
    }

    /// Write a disk-image of `bytes` zeros and, if `age_secs > 0`, backdate its
    /// mtime that far into the past (to move it past the grace window).
    fn make_disk_image(
        dir: &std::path::Path,
        name: &str,
        bytes: usize,
        age_secs: u64,
    ) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, vec![0u8; bytes]).unwrap();
        if age_secs > 0 {
            let now = SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let t = filetime::FileTime::from_unix_time((now - age_secs) as i64, 0);
            filetime::set_file_mtime(&p, t).unwrap();
        }
        p
    }

    /// Create a box overlay whose qcow2 backing chain pins `backing`. Returns the
    /// `Disk` — the caller must keep it alive (Drop deletes the qcow2 unless
    /// persistent, which would un-pin the backing image mid-test).
    fn pin_with_overlay(
        runtime: &RuntimeImpl,
        box_name: &str,
        backing: &std::path::Path,
        size: u64,
    ) -> crate::disk::Disk {
        register_box(runtime, box_name);
        let disks = runtime.layout.boxes_dir().join(box_name).join("disks");
        std::fs::create_dir_all(&disks).unwrap();
        crate::disk::Qcow2Helper::create_cow_child_disk(
            backing,
            crate::disk::BackingFormat::Raw,
            &disks.join("disk.qcow2"),
            size,
        )
        .expect("create cow child")
    }

    /// GC reclaims only `*.ext4` disk-images. A stray non-`.ext4` file (a
    /// partial build, a temp, a foreign artifact) that has aged past the grace
    /// window must be left untouched and never counted — otherwise GC could
    /// delete unrelated files that happen to live in the disk-images directory.
    #[test]
    fn gc_ignores_non_ext4_orphans() {
        let home = PerTestBoxHome::isolated_in("/tmp");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: vec![],
        })
        .expect("create runtime");
        let dir = runtime.layout.image_layout().disk_images_dir();
        std::fs::create_dir_all(&dir).unwrap();

        const SZ: usize = 4096;
        let aged = DISK_IMAGE_GRACE.as_secs() + 120;
        // Both aged well past grace and both unpinned — only the extension differs.
        let ext4 = make_disk_image(&dir, "sha256-orphan.ext4", SZ, aged);
        let foreign = make_disk_image(&dir, "partial-build.tmp", SZ, aged);

        let report = runtime.collect_garbage(&GcOptions::default()).unwrap();

        assert_eq!(
            report.disk_images_removed, 1,
            "only the .ext4 orphan may be reclaimed"
        );
        assert_eq!(
            report.disk_images_bytes, SZ as u64,
            "byte accounting must exclude the non-.ext4 file"
        );
        assert!(!ext4.exists(), "aged .ext4 orphan should be reclaimed");
        assert!(
            foreign.exists(),
            "aged non-.ext4 file must be left untouched by GC"
        );
    }

    /// Stress at scale: a directory full of aged orphans, fresh orphans, and
    /// box-backed images. GC must reclaim exactly the aged orphans (byte-exact),
    /// keep everything else, and be idempotent on a second pass.
    #[test]
    fn gc_at_scale_reclaims_only_aged_orphans() {
        let home = PerTestBoxHome::isolated_in("/tmp");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: vec![],
        })
        .expect("create runtime");
        let dir = runtime.layout.image_layout().disk_images_dir();
        std::fs::create_dir_all(&dir).unwrap();

        const AGED: usize = 150;
        const FRESH: usize = 40;
        const BACKED: usize = 20;
        const SZ: usize = 4096;
        let aged_secs = DISK_IMAGE_GRACE.as_secs() + 120;

        for i in 0..AGED {
            make_disk_image(&dir, &format!("aged-{i:04}.ext4"), SZ, aged_secs);
        }
        for i in 0..FRESH {
            make_disk_image(&dir, &format!("fresh-{i:04}.ext4"), SZ, 0);
        }
        // Backed images are aged too, so only the live overlay pin keeps them —
        // proves pinning, not the grace window, protects them.
        let mut overlays = Vec::with_capacity(BACKED);
        for i in 0..BACKED {
            let img = make_disk_image(&dir, &format!("backed-{i:04}.ext4"), SZ, aged_secs);
            overlays.push(pin_with_overlay(
                &runtime,
                &format!("backedbox-{i:04}"),
                &img,
                SZ as u64,
            ));
        }

        let report = runtime.collect_garbage(&GcOptions::default()).unwrap();
        assert_eq!(
            report.disk_images_removed, AGED as u64,
            "exactly the aged orphans are reclaimed"
        );
        assert_eq!(
            report.disk_images_bytes,
            (AGED * SZ) as u64,
            "byte accounting must sum only the reclaimed orphans"
        );

        for i in 0..AGED {
            assert!(
                !dir.join(format!("aged-{i:04}.ext4")).exists(),
                "aged orphan {i} must be gone"
            );
        }
        for i in 0..FRESH {
            assert!(
                dir.join(format!("fresh-{i:04}.ext4")).exists(),
                "fresh orphan {i} must be kept by grace"
            );
        }
        for i in 0..BACKED {
            assert!(
                dir.join(format!("backed-{i:04}.ext4")).exists(),
                "pinned image {i} must be kept"
            );
        }

        let again = runtime.collect_garbage(&GcOptions::default()).unwrap();
        assert_eq!(
            again.disk_images_removed, 0,
            "second pass must reclaim nothing (idempotent)"
        );
        drop(overlays);
    }

    /// Concurrency stress for the lock-free safety claim: hammer `collect_garbage`
    /// in a tight loop while another thread simulates a flood of box starts, each
    /// building a fresh disk-image and its backing overlay. No just-built or
    /// pinned image may ever be deleted (fresh mtime + the pin both protect it),
    /// while pre-seeded aged orphans are still reaped during the churn.
    #[test]
    fn gc_under_concurrent_starts_never_deletes_live_or_fresh_images() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let home = PerTestBoxHome::isolated_in("/tmp");
        let runtime = Arc::new(
            RuntimeImpl::new(BoxliteOptions {
                home_dir: home.path.clone(),
                image_registries: vec![],
            })
            .expect("create runtime"),
        );
        let dir = runtime.layout.image_layout().disk_images_dir();
        std::fs::create_dir_all(&dir).unwrap();

        const AGED: usize = 60;
        const STARTS: usize = 50;
        const SZ: usize = 4096;
        let aged_secs = DISK_IMAGE_GRACE.as_secs() + 120;
        for i in 0..AGED {
            make_disk_image(&dir, &format!("aged-{i:04}.ext4"), SZ, aged_secs);
        }

        let done = Arc::new(AtomicBool::new(false));
        let starter = {
            let runtime = runtime.clone();
            let dir = dir.clone();
            let done = done.clone();
            std::thread::spawn(move || {
                // Keep overlays alive for the whole run so their pins hold.
                let mut overlays = Vec::with_capacity(STARTS);
                for i in 0..STARTS {
                    let img = make_disk_image(&dir, &format!("live-{i:04}.ext4"), SZ, 0);
                    overlays.push(pin_with_overlay(
                        &runtime,
                        &format!("livebox-{i:04}"),
                        &img,
                        SZ as u64,
                    ));
                }
                done.store(true, Ordering::Release);
                overlays
            })
        };

        // Race GC against the start flood. The pass cap is a safety bound: if a
        // regression breaks grace/pin protection the starter panics (its backing
        // image gets deleted mid-create) and never sets `done`, so without the
        // cap this loop would spin until the harness timeout instead of failing
        // fast on the joined panic below.
        let mut passes = 0u32;
        while !done.load(Ordering::Acquire) && passes < 1_000_000 {
            runtime.collect_garbage(&GcOptions::default()).unwrap();
            passes += 1;
        }
        let overlays = starter
            .join()
            .expect("starter thread (backing image deleted under GC?)");
        // A few more passes now that every start has landed.
        for _ in 0..3 {
            runtime.collect_garbage(&GcOptions::default()).unwrap();
        }

        for i in 0..STARTS {
            assert!(
                dir.join(format!("live-{i:04}.ext4")).exists(),
                "live start image {i} was deleted under concurrent GC (passes={passes})"
            );
        }
        for i in 0..AGED {
            assert!(
                !dir.join(format!("aged-{i:04}.ext4")).exists(),
                "aged orphan {i} should be reaped despite the start churn"
            );
        }
        drop(overlays);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Box-dir sweep (new in this commit)
    // ─────────────────────────────────────────────────────────────────────

    /// Build a minimal `BoxConfig`/`BoxState` pair for a given id and insert
    /// into the runtime's box manager — what the rest of GC treats as a
    /// "live" box. Used by the box-dir / bases sweep tests.
    fn register_box(runtime: &RuntimeImpl, id_str: &str) {
        use crate::litebox::BoxState;
        use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
        use crate::runtime::id::BoxID;
        use crate::runtime::options::{BoxOptions, RootfsSpec};
        use crate::runtime::types::ContainerID;
        use crate::vmm::VmmKind;
        use chrono::Utc;

        let id = BoxID::parse(id_str).expect("valid box id literal");
        let cfg = BoxConfig {
            id: id.clone(),
            name: None,
            created_at: Utc::now(),
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            box_home: runtime.layout.boxes_dir().join(id_str),
        };
        let state = BoxState::new();
        runtime.box_manager.add_box(&cfg, &state).unwrap();
    }

    fn backdate_mtime(path: &std::path::Path, age_secs: u64) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let t = filetime::FileTime::from_unix_time((now - age_secs) as i64, 0);
        filetime::set_file_mtime(path, t).unwrap();
    }

    /// An orphan `boxes/<id>/` dir whose id is not in the DB and whose mtime
    /// is past `BOX_DIR_GRACE` is reclaimed; a DB-registered box dir is left
    /// alone even when stale-looking on disk. Dry run reports without
    /// deleting. Mirrors `sweeps_orphan_disk_images_only`'s pattern.
    #[test]
    fn sweeps_orphan_box_dirs_only() {
        let home = PerTestBoxHome::isolated_in("/tmp");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: vec![],
        })
        .expect("create runtime");

        // Live box: id committed to the DB + a dir on disk that *looks*
        // orphan-old via backdated mtime. Must be kept anyway.
        let live_id = "01LIVEAAAAAAAAAAAAAAAAAAAA";
        register_box(&runtime, live_id);
        let live_dir = runtime.layout.boxes_dir().join(live_id);
        std::fs::create_dir_all(&live_dir).unwrap();
        std::fs::write(live_dir.join("touch"), b"x").unwrap();
        backdate_mtime(&live_dir, BOX_DIR_GRACE.as_secs() + 120);

        // Orphan #1: aged past the grace window → reapable.
        let orphan_id = "01ORPHANAAAAAAAAAAAAAAAAAA";
        let orphan_dir = runtime.layout.boxes_dir().join(orphan_id);
        std::fs::create_dir_all(&orphan_dir).unwrap();
        std::fs::write(orphan_dir.join("payload"), vec![0u8; 4096]).unwrap();
        backdate_mtime(&orphan_dir, BOX_DIR_GRACE.as_secs() + 120);

        // Orphan #2: fresh (within grace) → must be kept this pass to
        // avoid racing a half-finished concurrent `create`.
        let fresh_id = "01FRESHAAAAAAAAAAAAAAAAAAA";
        let fresh_dir = runtime.layout.boxes_dir().join(fresh_id);
        std::fs::create_dir_all(&fresh_dir).unwrap();
        std::fs::write(fresh_dir.join("payload"), vec![0u8; 4096]).unwrap();

        // Dry run: only the aged orphan qualifies; nothing deleted.
        let preview = runtime
            .collect_garbage(&GcOptions { dry_run: true })
            .unwrap();
        assert_eq!(
            preview.box_dirs_removed, 1,
            "only the aged orphan qualifies"
        );
        assert!(
            live_dir.exists() && orphan_dir.exists() && fresh_dir.exists(),
            "dry run must not delete"
        );

        // Real run.
        let done = runtime
            .collect_garbage(&GcOptions { dry_run: false })
            .unwrap();
        assert_eq!(done.box_dirs_removed, 1);
        assert!(live_dir.exists(), "DB-registered box dir must be kept");
        assert!(!orphan_dir.exists(), "aged orphan should be reaped");
        assert!(fresh_dir.exists(), "fresh orphan kept by grace");
    }

    /// Box id is missing from the DB → its `boxes/<id>/disks/*.qcow2` no
    /// longer pins the image disk-image it backs onto, so the image cache
    /// can reclaim it on the same GC pass. The orphan-dir-first ordering in
    /// `collect_garbage` is what makes this work.
    #[test]
    fn orphan_box_dir_does_not_pin_image_disk_image() {
        const SZ: u64 = 4 * 1024 * 1024;

        let home = PerTestBoxHome::isolated_in("/tmp");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: vec![],
        })
        .expect("create runtime");

        // Live box that backs onto an image-disk — must keep its image.
        let live_id = "01LIVEPINBOXAAAAAAAAAAAAAA";
        register_box(&runtime, live_id);
        let live_image_dir = runtime.layout.image_layout().disk_images_dir();
        std::fs::create_dir_all(&live_image_dir).unwrap();
        let live_image = make_disk_image(
            &live_image_dir,
            "live.ext4",
            SZ as usize,
            DISK_IMAGE_GRACE.as_secs() + 60,
        );
        let live_disks_dir = runtime.layout.boxes_dir().join(live_id).join("disks");
        std::fs::create_dir_all(&live_disks_dir).unwrap();
        let _live_overlay = crate::disk::Qcow2Helper::create_cow_child_disk(
            &live_image,
            crate::disk::BackingFormat::Raw,
            &live_disks_dir.join("disk.qcow2"),
            SZ,
        )
        .expect("create live overlay");

        // Orphan box: NOT registered, but a stale overlay still points at
        // its own image-disk. The image-disk must come back into the
        // reclaimable set once the orphan dir is gone.
        let orphan_id = "01ORPHANPINAAAAAAAAAAAAAAA";
        let orphan_image = make_disk_image(
            &live_image_dir,
            "orphan.ext4",
            SZ as usize,
            DISK_IMAGE_GRACE.as_secs() + 60,
        );
        let orphan_disks_dir = runtime.layout.boxes_dir().join(orphan_id).join("disks");
        std::fs::create_dir_all(&orphan_disks_dir).unwrap();
        let _orphan_overlay = crate::disk::Qcow2Helper::create_cow_child_disk(
            &orphan_image,
            crate::disk::BackingFormat::Raw,
            &orphan_disks_dir.join("disk.qcow2"),
            SZ,
        )
        .expect("create orphan overlay");
        backdate_mtime(
            &runtime.layout.boxes_dir().join(orphan_id),
            BOX_DIR_GRACE.as_secs() + 120,
        );

        let report = runtime
            .collect_garbage(&GcOptions { dry_run: false })
            .unwrap();
        assert_eq!(report.box_dirs_removed, 1, "orphan dir reclaimed");
        assert_eq!(
            report.disk_images_removed, 1,
            "orphan image-disk reclaimed once its orphan box dir is gone"
        );
        assert!(live_image.exists(), "live image-disk must be kept");
        assert!(!orphan_image.exists(), "orphan image-disk reclaimed");
    }

    // ─────────────────────────────────────────────────────────────────────
    // Bases sweep (new in this commit)
    // ─────────────────────────────────────────────────────────────────────

    /// `bases/foo.qcow2` referenced from `base_disk.base_path` is kept; one
    /// not referenced and past the grace window is reclaimed; a non-qcow2
    /// foreign file (operator copied something in) is never touched.
    #[test]
    fn sweeps_orphan_bases_only() {
        use crate::disk::DiskInfo;
        use crate::disk::base_disk::{BaseDisk, BaseDiskKind};
        use crate::runtime::id::BaseDiskIDMint;

        let home = PerTestBoxHome::isolated_in("/tmp");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: vec![],
        })
        .expect("create runtime");

        let bases_dir = runtime.layout.bases_dir();
        std::fs::create_dir_all(&bases_dir).unwrap();

        // Referenced: file + DB row pointing at it.
        let referenced = bases_dir.join("referenced.qcow2");
        std::fs::write(&referenced, vec![0u8; 8 * 1024]).unwrap();
        backdate_mtime(&referenced, BASE_GRACE.as_secs() + 120);
        let row = BaseDisk {
            id: BaseDiskIDMint::mint(),
            source_box_id: "01ANYBOXIDAAAAAAAAAAAAAAAA".to_string(),
            name: None,
            kind: BaseDiskKind::Snapshot,
            disk_info: DiskInfo {
                base_path: referenced.to_string_lossy().to_string(),
                container_disk_bytes: 8 * 1024,
                size_bytes: 8 * 1024,
            },
            created_at: 0,
        };
        runtime.base_disk_mgr.store().insert(&row).unwrap();

        // Orphan, past grace → reapable.
        let orphan = bases_dir.join("orphan.qcow2");
        std::fs::write(&orphan, vec![0u8; 8 * 1024]).unwrap();
        backdate_mtime(&orphan, BASE_GRACE.as_secs() + 120);

        // Foreign file, past grace → must NOT be deleted (no `.qcow2`).
        let foreign = bases_dir.join("operator-notes.txt");
        std::fs::write(&foreign, b"do not delete").unwrap();
        backdate_mtime(&foreign, BASE_GRACE.as_secs() + 120);

        // Fresh orphan → grace protects it this pass.
        let fresh = bases_dir.join("fresh.qcow2");
        std::fs::write(&fresh, vec![0u8; 8 * 1024]).unwrap();

        let report = runtime
            .collect_garbage(&GcOptions { dry_run: false })
            .unwrap();
        assert_eq!(
            report.bases_removed, 1,
            "only the aged orphan should be reaped"
        );
        assert!(referenced.exists(), "DB-referenced base must be kept");
        assert!(!orphan.exists(), "aged orphan base reclaimed");
        assert!(
            foreign.exists(),
            "non-qcow2 foreign file must never be deleted"
        );
        assert!(fresh.exists(), "fresh orphan kept by grace");
    }
}
