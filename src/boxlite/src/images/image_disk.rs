//! Image disk manager.
//!
//! Builds and caches pure ext4 disk images from OCI images.
//! These disks contain only image content (no guest binary).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::db::ImageIndexStore;
use crate::disk::{BaseDiskManager, Disk, DiskFormat, create_ext4_from_dir};
use crate::metrics::RuntimeMetricsStorage;
use crate::rootfs::RootfsBuilder;

use super::ImageObject;
use super::object::image_digest_for_layers;
use super::parse_override;

/// How long a cached disk must sit untouched before a sweep may consider it.
///
/// [`ImageDiskManager::install`] renames a file into place before any caller
/// records it, so a fresh entry looks unreachable for a moment. Same window,
/// for the same reason, as `BaseDiskManager::ORPHAN_GRACE`.
const ORPHAN_GRACE: Duration = Duration::from_secs(300);

/// Minimum gap between two sweeps on the build path, so a burst of box
/// creates doesn't re-scan the cache directory once per box. The startup and
/// periodic triggers are not throttled — they run a handful of times a day.
/// Override via `BOXLITE_IMAGE_DISK_GC_MIN_INTERVAL_SECS`.
const DEFAULT_GC_MIN_INTERVAL: Duration = Duration::from_secs(300);

fn gc_min_interval() -> Duration {
    static INTERVAL: OnceLock<Duration> = OnceLock::new();
    *INTERVAL.get_or_init(|| {
        Duration::from_secs(parse_override(
            std::env::var("BOXLITE_IMAGE_DISK_GC_MIN_INTERVAL_SECS").ok(),
            DEFAULT_GC_MIN_INTERVAL.as_secs(),
        ))
    })
}

/// Volume usage at which a build starts evicting cached disks, in percent.
///
/// High on purpose: an eviction costs the next box that wants that image a
/// full local rebuild (~4 passes over the uncompressed image content), so this
/// is pressure relief, not cache management. At the usage a developer machine
/// or an idle runner normally sits at, the eviction pass does nothing at all.
/// Override via `BOXLITE_IMAGE_DISK_EVICT_HIGH_PERCENT`; 100 disables it.
const DEFAULT_EVICT_HIGH_PERCENT: u8 = 85;

/// Usage an eviction pass stops at once it has started, in percent. Leaves
/// room for the disk about to be built without emptying the cache.
///
/// Deliberately **below the control plane's disk penalty threshold**
/// (`RUNNER_DISK_PENALTY_THRESHOLD`, default 75 — `apps/api` scores a runner
/// down exponentially from there and drops it out of placement entirely once
/// the score falls under `RUNNER_AVAILABILITY_SCORE_THRESHOLD`). Stopping
/// *at* that line would free space without restoring the runner's standing,
/// so a completed eviction would leave it still being penalised. Both numbers
/// read the same figure — the runner reports `disk.Usage("/")` and this reads
/// `statvfs` on a cache directory that lives on the same volume — so they
/// have to be chosen together, not independently.
/// Pinned by `the_low_watermark_stays_under_the_control_plane_disk_penalty`,
/// which reads the threshold out of `apps/api`'s own config rather than
/// copying the number here — so moving either side breaks the test.
/// Override via `BOXLITE_IMAGE_DISK_EVICT_LOW_PERCENT`.
const DEFAULT_EVICT_LOW_PERCENT: u8 = 70;

fn evict_high_percent() -> u8 {
    static HIGH: OnceLock<u8> = OnceLock::new();
    *HIGH.get_or_init(|| {
        parse_override(
            std::env::var("BOXLITE_IMAGE_DISK_EVICT_HIGH_PERCENT").ok(),
            DEFAULT_EVICT_HIGH_PERCENT,
        )
    })
}

/// Whether an eviction pass has anything to do at this usage.
///
/// `100` is the documented off switch, and it needs its own arm: a full
/// volume reads back as exactly 100, so `usage < high` alone would still
/// evict there — the one case an operator who set 100 was disabling.
fn eviction_is_warranted(usage: u8, high: u8) -> bool {
    high < 100 && usage >= high
}

/// The low watermark a pass actually stops at.
///
/// Clamped *below* the high watermark, not to it: the pass stops as soon as
/// `usage <= low`, so a low mark equal to the high one exits on the very first
/// candidate — silently turning eviction off at exactly the usage that
/// triggered it. One percent is enough to guarantee forward progress.
fn effective_low_percent(low: u8, high: u8) -> u8 {
    low.min(high.saturating_sub(1))
}

fn evict_low_percent() -> u8 {
    static LOW: OnceLock<u8> = OnceLock::new();
    let configured = *LOW.get_or_init(|| {
        parse_override(
            std::env::var("BOXLITE_IMAGE_DISK_EVICT_LOW_PERCENT").ok(),
            DEFAULT_EVICT_LOW_PERCENT,
        )
    });
    effective_low_percent(configured, evict_high_percent())
}

/// Bytes a cached disk actually occupies.
///
/// Image disks are sparse — a 718 MiB ext4 commonly holds ~141 MiB — so
/// `Metadata::len()` would report several times what a sweep really freed.
fn allocated_bytes(metadata: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.blocks() * 512
}

/// What tells a still-reachable cached disk from a dead one.
///
/// Bundled into one type and held by [`ImageDiskManager`] rather than passed
/// per call: the trigger that matters most is "just before building a disk",
/// which is inside the manager, and a collaborator every caller has to
/// remember to invoke is one some caller will forget.
pub(crate) struct DiskCacheReclaim {
    /// Guard A's source: every reference this host has pulled or loaded, each
    /// carrying the ordered layer list that names its disk.
    index: ImageIndexStore,
    /// Guard B's source: which files a box overlay backs onto — the box may be
    /// running or stopped; a stopped box's `disk.qcow2` is still there.
    base_disks: BaseDiskManager,
    boxes_dir: PathBuf,
    /// When the build-path sweep last ran in this process.
    last_sweep: Mutex<Option<Instant>>,
    /// Where both passes report what they freed. Held here rather than passed
    /// per call for the same reason as the guards themselves: the trigger that
    /// matters most is inside the manager.
    metrics: RuntimeMetricsStorage,
}

impl DiskCacheReclaim {
    pub(crate) fn new(
        index: ImageIndexStore,
        base_disks: BaseDiskManager,
        boxes_dir: PathBuf,
        metrics: RuntimeMetricsStorage,
    ) -> Self {
        Self {
            index,
            base_disks,
            boxes_dir,
            last_sweep: Mutex::new(None),
            metrics,
        }
    }

    /// True at most once per [`gc_min_interval`], recording the sweep as it
    /// answers. A poisoned lock answers `false`: skipping a sweep costs some
    /// disk space, and this is not the place to panic a box create.
    fn sweep_is_due(&self) -> bool {
        let Ok(mut last_sweep) = self.last_sweep.lock() else {
            return false;
        };
        let now = Instant::now();
        let due = last_sweep.is_none_or(|prev| now.duration_since(prev) >= gc_min_interval());
        if due {
            *last_sweep = Some(now);
        }
        due
    }
}

/// What one full reclaim pass freed.
///
/// Two numbers rather than a sum: the passes answer different questions —
/// `collected` is garbage that cost nothing to remove, `evicted` is live
/// cache given up under space pressure, and an operator reading the log
/// needs to tell a host that is merely tidy from one that is thrashing.
pub(crate) struct Reclaimed {
    pub(crate) collected: usize,
    pub(crate) evicted: usize,
}

/// Builds and caches ext4 disk images from OCI images.
///
/// Image disks are pure: only OCI image content, no guest binary injected.
/// Cache key is the image digest (SHA256 of layer digests) plus the
/// manager's `reserve_bytes` — see the field doc — so a disk cached by an
/// older build (before headroom existed, or under a smaller budget) is never
/// mistaken for one sized under the current budget.
///
/// Follows the staged install pattern: build in temp → atomic rename to cache.
/// No half-written files ever appear in the cache directory.
///
/// # Reclaim
///
/// The cache is bounded by [`Self::gc_unreachable`], which deletes entries
/// nothing can reach any more. See its doc for the guards; see
/// [`Self::reclaim_before_build`] for when it runs on this path.
///
/// # Concurrency
///
/// Thread-safety is provided by the caller:
/// - Multi-process: `RuntimeLock` ensures single-process access per BOXLITE_HOME
/// - In-process: `OnceCell<GuestRootfs>` serializes all calls to `get_or_create()`
///
/// No internal locking is needed.
///
/// Cache location: `~/.boxlite/images/disk-images/`
pub struct ImageDiskManager {
    cache_dir: PathBuf,
    temp_dir: PathBuf,
    /// Extra headroom baked into every image disk this manager builds, and
    /// folded into its cache key (`disk_path`).
    ///
    /// `GuestRootfsManager` injects the `boxlite-guest` binary into a *copy*
    /// of whatever this manager cached — so the headroom that copy needs
    /// must be decided once, here, rather than per `get_or_create` call:
    /// `container_rootfs.rs`'s `prepare_disk_rootfs` uses the same cached
    /// disk directly with no injection, and if headroom were instead a
    /// per-call choice, whichever caller happened to build a given digest
    /// first would decide the size for every later caller of that digest too.
    ///
    /// In production this is a fixed constant
    /// (`IMAGE_DISK_GUEST_BINARY_HEADROOM_BYTES` in `runtime/rt_impl.rs`),
    /// not derived from the guest binary's live size — so, unlike a value
    /// that changed on every guest-binary rebuild, folding it into the cache
    /// key doesn't orphan a cache entry on every rebuild; it only creates a
    /// new one on the rare, deliberate occasions the constant itself changes
    /// (this manager has no GC, so that distinction is load-bearing — see
    /// the constant's own doc comment). It still MUST be in the cache key:
    /// an older build with no headroom budgeted at all (or a smaller one)
    /// would otherwise be reused as-is, silently reproducing the exact
    /// ENOSPC-on-injection failure this field exists to prevent.
    reserve_bytes: u64,
    reclaim: DiskCacheReclaim,
}

impl ImageDiskManager {
    pub fn new(
        cache_dir: PathBuf,
        temp_dir: PathBuf,
        reserve_bytes: u64,
        reclaim: DiskCacheReclaim,
    ) -> Self {
        // Canonicalize once at construction so the reclaim guards compare
        // against the same path shape the qcow2 headers carry — the reason
        // `BaseDiskManager::new` does it too. `FilesystemLayout::prepare`
        // has already created this directory in production.
        let cache_dir = cache_dir
            .canonicalize()
            .unwrap_or_else(|_| cache_dir.clone());
        Self {
            cache_dir,
            temp_dir,
            reserve_bytes,
            reclaim,
        }
    }

    /// Get or create an ext4 disk image for the given OCI image.
    ///
    /// Returns a persistent `Disk` (won't be cleaned up on drop).
    /// If a cached disk exists for this image digest, returns it immediately.
    /// Otherwise: extracts layers → creates ext4 → atomically installs to cache.
    pub async fn get_or_create(&self, image: &ImageObject) -> BoxliteResult<Disk> {
        let digest = image.compute_image_digest();

        let disk = match self.find(&digest) {
            Some(disk) => {
                tracing::debug!("Found cached image disk for {}", digest);
                disk
            }
            None => {
                self.reclaim_before_build(&digest);
                tracing::info!("Building image disk for {} (first time)", digest);
                self.build_and_install(image, &digest).await?
            }
        };

        // One site, on the path both branches join, so neither can forget it.
        // The rebuild branch needs it as much as the hit branch: a miss is
        // exactly the state an eviction leaves behind, and a disk rebuilt
        // while still carrying the stamp that made it the coldest candidate
        // goes straight back to the front of the queue.
        self.record_use(image.reference());
        Ok(disk)
    }

    /// Look up a cached disk by image digest.
    fn find(&self, digest: &str) -> Option<Disk> {
        let path = self.disk_path(digest);
        path.exists()
            .then(|| Disk::new(path, DiskFormat::Ext4, true))
    }

    // ========================================================================
    // RECLAIM
    // ========================================================================

    /// Free what can be freed before spending a whole disk's worth of space.
    ///
    /// Throttled: a burst of box creates would otherwise re-scan the cache
    /// directory once per box, and nothing becomes unreachable in between.
    /// Failures are logged and swallowed — a sweep that can't run is a cache
    /// that keeps growing, not a box that fails to start.
    /// `building` is the disk this call is about to install — the eviction
    /// pass must not take it out from under the build.
    fn reclaim_before_build(&self, building: &str) {
        self.reclaim_before_build_with(building, &|| self.volume_used_percent());
    }

    /// [`Self::reclaim_before_build`] against an injected usage reading, which
    /// is how a test drives pressure a real filesystem will not reproduce on
    /// demand. Same split, for the same reason, as
    /// [`Self::evict_cold_down_to_low_watermark`].
    fn reclaim_before_build_with(&self, building: &str, used_percent: &dyn Fn() -> Option<u8>) {
        // Free first: this deletes only what nothing can reach, so it costs
        // nothing and may make the eviction below unnecessary. Throttled,
        // because nothing new becomes unreachable between two box creates.
        if self.reclaim.sweep_is_due()
            && let Err(e) = self.gc_unreachable()
        {
            tracing::warn!("Image disk GC failed, continuing without it: {}", e);
        }

        // Not throttled: it answers "is there room for the disk I am about to
        // build", and the previous pass's answer says nothing about that.
        if let Err(e) = self.evict_cold_down_to_low_watermark(Some(building), used_percent) {
            tracing::warn!("Image disk eviction failed, continuing without it: {}", e);
        }
    }

    /// Both reclaim passes, for a caller with no build waiting on them.
    ///
    /// The build-path trigger cannot be the eviction pass's only one: the
    /// control plane scores a runner down as its disk fills and eventually
    /// stops placing boxes on it altogether, so the fullest hosts are exactly
    /// the ones that stop getting builds — and would never evict. This is the
    /// path that lets such a host recover on its own.
    pub(crate) fn reclaim_now(&self) -> BoxliteResult<Reclaimed> {
        let collected = self.gc_unreachable()?;
        let evicted = self.evict_cold_if_low_on_space(None)?;
        Ok(Reclaimed { collected, evicted })
    }

    /// Delete cached disks that nothing can reach any more.
    ///
    /// Four guards; a file is removed only when all four agree it is dead:
    ///
    /// - **A** — no `image_index` row names it. The name folds in
    ///   `reserve_bytes`, so an entry built under a different headroom budget
    ///   is unreachable by construction: `find()` can no longer produce that
    ///   name, which is exactly what makes it garbage rather than cache.
    /// - **B** — nothing backs onto it. `referenced_backing_paths` walks the
    ///   whole chain of both overlays every box owns, so this covers stopped
    ///   boxes too: their `disk.qcow2` is still on disk and still pinned to
    ///   the base it booted from.
    /// - **C** — it has settled for [`ORPHAN_GRACE`].
    /// - **D** — it is a plain `.ext4` file directly in this manager's own
    ///   cache directory.
    ///
    /// A and B are deliberately independent: a disk built under an older
    /// headroom budget fails A while still being load-bearing for the box
    /// that booted from it, and each check has its own way of coming up empty
    /// (a lost row, an unreadable qcow2 header, a chain deeper than the walk).
    ///
    /// A database error aborts the whole sweep instead of yielding an empty
    /// reachable set — that set is read as "everything is garbage".
    ///
    /// Returns the number of entries removed.
    pub(crate) fn gc_unreachable(&self) -> BoxliteResult<usize> {
        let entries = match fs::read_dir(&self.cache_dir) {
            Ok(entries) => entries,
            Err(e) => {
                if self.cache_dir.exists() {
                    tracing::warn!(
                        "GC: failed to read image disk cache {}: {}",
                        self.cache_dir.display(),
                        e
                    );
                }
                return Ok(0);
            }
        };

        let reachable = self.reachable_disk_paths()?;
        let referenced = self
            .reclaim
            .base_disks
            .referenced_backing_paths_checked(&self.reclaim.boxes_dir);
        // Guard B could not see everything, so "not in the set" no longer
        // means "nothing backs onto it". Guard A alone would still delete a
        // disk whose index row is legitimately gone but which a stopped box
        // is backed by — the case guard B exists for.
        if !referenced.complete {
            tracing::warn!(
                "GC: backing scan incomplete, skipping this pass rather than \
                 deleting on a partial view"
            );
            return Ok(0);
        }
        let referenced = referenced.paths;
        let now = SystemTime::now();

        let mut removed = 0;
        let mut reclaimed_bytes = 0u64;

        for entry in entries.flatten() {
            let path = entry.path();

            // Guard D. Never touch a qcow2, a directory, or anything else
            // that happens to share the directory.
            if path.extension().and_then(|e| e.to_str()) != Some("ext4") {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }

            // Guard C.
            let settled = metadata
                .modified()
                .ok()
                .and_then(|mtime| now.duration_since(mtime).ok())
                .is_some_and(|age| age >= ORPHAN_GRACE);
            if !settled {
                continue;
            }

            // Guard A.
            if reachable.contains(&path) {
                continue;
            }

            // Guard B.
            if referenced.contains(&path) {
                continue;
            }

            tracing::info!(
                path = %path.display(),
                size_mb = allocated_bytes(&metadata) / (1024 * 1024),
                "GC: removing unreachable image disk (no index row, nothing backing onto it)"
            );
            match fs::remove_file(&path) {
                Ok(()) => {
                    removed += 1;
                    reclaimed_bytes += allocated_bytes(&metadata);
                }
                Err(e) => tracing::warn!("GC: failed to remove {}: {}", path.display(), e),
            }
        }

        if removed > 0 {
            self.reclaim
                .metrics
                .record_image_disk_bytes_reclaimed(reclaimed_bytes);
            tracing::info!(
                removed,
                reclaimed_mb = reclaimed_bytes / (1024 * 1024),
                "GC: reclaimed unreachable image disks"
            );
        }
        Ok(removed)
    }

    /// Every cache path an `image_index` row still names.
    ///
    /// Rebuilt from the row's ordered layer list through the same function
    /// that keys the cache in the first place ([`image_digest_for_layers`]),
    /// because two derivations of one key would drift — and the direction
    /// they would drift in is "delete a live disk".
    fn reachable_disk_paths(&self) -> BoxliteResult<HashSet<PathBuf>> {
        Ok(self
            .reclaim
            .index
            .list_all()?
            .iter()
            .map(|(_, cached)| self.disk_path(&image_digest_for_layers(&cached.layers)))
            .collect())
    }

    /// Record that this reference's cached disk was just used, so eviction
    /// can rank it against the others.
    ///
    /// One primary-key update, on the reference actually asked for. The
    /// obvious alternative — find every reference whose layers name this disk
    /// and touch them all — measured **23 ms per box start** at 500 cached
    /// references, because it reads every index row and hashes each one's
    /// layer list; and it stamps tags that were never used besides. Sharing is
    /// handled where it belongs, on the read side: [`Self::coldest_first`]
    /// already takes the newest use among the references naming one disk.
    ///
    /// A database error costs accuracy in the eviction order and nothing else,
    /// so it is logged rather than propagated — this is on every box start. A
    /// reference with no row is a no-op, as `touch` documents.
    fn record_use(&self, reference: &str) {
        // `ImageObject::reference()` is the string the caller asked with —
        // `python:alpine`, not the `docker.io/library/python:alpine` the row is
        // keyed by. Touching the raw string updates nothing, silently.
        let key = super::index_key(reference);
        let now = chrono::Utc::now().timestamp();
        if let Err(e) = self.reclaim.index.touch(&key, now) {
            tracing::warn!("Could not record image disk use for {}: {}", key, e);
        }
    }

    /// Evict the least recently used cached disks when the volume is running
    /// out of room, so the disk about to be built doesn't hit ENOSPC.
    ///
    /// Only `disk-images/` entries are candidates. `layers/` and `extracted/`
    /// are deduplicated across images and are what makes a rebuild a local
    /// operation instead of a network pull, so evicting them would cost far
    /// more than the space it frees.
    ///
    /// Guard B of [`Self::gc_unreachable`] applies unchanged: a disk some box
    /// overlay backs onto is never a candidate, however cold — the box may be
    /// stopped, but that file is still its rootfs.
    ///
    /// Eviction is ordered by `image_index.last_used_at`, never by mtime: a
    /// cached disk is a read-only backing file, so reading one never updates
    /// its mtime, and an mtime order degrades into "oldest created first" —
    /// which evicts the most widely shared base images first.
    /// `building` is the disk a pull is about to install, or `None` when no
    /// build is waiting on this pass — the periodic sweep's case.
    pub(crate) fn evict_cold_if_low_on_space(
        &self,
        building: Option<&str>,
    ) -> BoxliteResult<usize> {
        self.evict_cold_down_to_low_watermark(building, &|| self.volume_used_percent())
    }

    /// [`Self::evict_cold_if_low_on_space`] against an injected usage reading,
    /// which is how a test drives pressure a real filesystem will not
    /// reproduce on demand. Re-read after every removal, so the pass stops the
    /// moment the low watermark is reached.
    fn evict_cold_down_to_low_watermark(
        &self,
        building: Option<&str>,
        used_percent: &dyn Fn() -> Option<u8>,
    ) -> BoxliteResult<usize> {
        // A filesystem that cannot be queried is not a full one. Reading
        // "unknown" as "full" would flush the cache on every host where the
        // syscall is unavailable.
        let Some(mut usage) = used_percent() else {
            return Ok(0);
        };
        let high = evict_high_percent();
        if !eviction_is_warranted(usage, high) {
            tracing::debug!(
                usage,
                high,
                "Image disk cache is under the eviction watermark; nothing to give up"
            );
            return Ok(0);
        }

        let referenced = self
            .reclaim
            .base_disks
            .referenced_backing_paths_checked(&self.reclaim.boxes_dir);
        // Eviction has no second guard: it targets entries that *do* have
        // index rows, so "no row names it" cannot help here. A partial scan
        // is therefore the difference between evicting cold cache and
        // deleting the backing file under every running box — and this pass
        // only runs under disk pressure, when transient I/O errors are
        // likeliest. Same rule as the `statvfs` failure above: unknown is not
        // permission to act.
        if !referenced.complete {
            tracing::warn!(
                "Eviction: backing scan incomplete, skipping this pass rather \
                 than evicting on a partial view"
            );
            return Ok(0);
        }
        let referenced = referenced.paths;
        let low = evict_low_percent();

        let mut evicted = 0;
        let mut reclaimed_bytes = 0u64;

        for (last_used_at, path) in self.coldest_first(building, &referenced)? {
            if usage <= low {
                break;
            }
            let freed = fs::metadata(&path)
                .as_ref()
                .map(allocated_bytes)
                .unwrap_or(0);
            if let Err(e) = fs::remove_file(&path) {
                tracing::warn!("Eviction: failed to remove {}: {}", path.display(), e);
                continue;
            }
            tracing::info!(
                path = %path.display(),
                last_used_at,
                usage,
                "Evicting cold image disk under space pressure"
            );
            evicted += 1;
            reclaimed_bytes += freed;

            let Some(next) = used_percent() else {
                break;
            };
            usage = next;
        }

        if evicted > 0 {
            self.reclaim
                .metrics
                .record_image_disks_evicted(evicted as u64);
            self.reclaim
                .metrics
                .record_image_disk_bytes_reclaimed(reclaimed_bytes);
            tracing::info!(
                evicted,
                reclaimed_mb = reclaimed_bytes / (1024 * 1024),
                usage,
                "Evicted cold image disks"
            );
        }
        Ok(evicted)
    }

    /// Cached disks an index row still names, least recently used first.
    ///
    /// Keyed by file rather than by row: several references can name the same
    /// disk, and the newest use among them is the one that counts. Files no
    /// row names are left out — those belong to [`Self::gc_unreachable`],
    /// which costs nothing and has already had its turn.
    ///
    /// Two things are held back even though nothing backs onto them yet:
    /// - `building`, the disk this pull is about to install. It is installed
    ///   before its box overlay exists, so between those two steps it looks
    ///   unreferenced to a *concurrent* create's eviction pass.
    /// - anything younger than [`ORPHAN_GRACE`], which covers the same window
    ///   for a disk another caller just landed — the reason
    ///   [`Self::gc_unreachable`]'s guard C exists.
    fn coldest_first(
        &self,
        building: Option<&str>,
        referenced: &HashSet<PathBuf>,
    ) -> BoxliteResult<Vec<(i64, PathBuf)>> {
        let in_flight = building.map(|digest| self.disk_path(digest));
        let now = SystemTime::now();
        let mut newest_use: HashMap<PathBuf, i64> = HashMap::new();

        for (_, cached) in self.reclaim.index.list_all()? {
            let path = self.disk_path(&image_digest_for_layers(&cached.layers));
            if referenced.contains(&path) || in_flight.as_ref() == Some(&path) {
                continue;
            }
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            let settled = metadata.is_file()
                && metadata
                    .modified()
                    .ok()
                    .and_then(|mtime| now.duration_since(mtime).ok())
                    .is_some_and(|age| age >= ORPHAN_GRACE);
            if !settled {
                continue;
            }
            newest_use
                .entry(path)
                .and_modify(|at| *at = (*at).max(cached.last_used_at))
                .or_insert(cached.last_used_at);
        }

        let mut coldest_first: Vec<(i64, PathBuf)> = newest_use
            .into_iter()
            .map(|(path, last_used_at)| (last_used_at, path))
            .collect();
        // Path breaks ties, so the order is deterministic across runs.
        coldest_first.sort();
        Ok(coldest_first)
    }

    /// How full the volume holding the cache is, the way `df` reports it —
    /// the number an operator comparing against the watermark will look at.
    ///
    /// `None` when the filesystem cannot be queried; callers must not read
    /// that as "full".
    fn volume_used_percent(&self) -> Option<u8> {
        let stats = match nix::sys::statvfs::statvfs(&self.cache_dir) {
            Ok(stats) => stats,
            Err(e) => {
                tracing::warn!(
                    path = %self.cache_dir.display(),
                    "Could not read free space, skipping image disk eviction: {}",
                    e
                );
                return None;
            }
        };

        let used = u128::from(stats.blocks()).saturating_sub(u128::from(stats.blocks_free()));
        let capacity = used + u128::from(stats.blocks_available());
        if capacity == 0 {
            return None;
        }
        Some(((used * 100).div_ceil(capacity)).min(100) as u8)
    }

    // ========================================================================
    // BUILD
    // ========================================================================

    /// Build ext4 from image layers and atomically install to cache.
    async fn build_and_install(&self, image: &ImageObject, digest: &str) -> BoxliteResult<Disk> {
        // All work happens in a temp directory (staged)
        let temp = tempfile::tempdir_in(&self.temp_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create temp directory in {}: {}",
                self.temp_dir.display(),
                e
            ))
        })?;

        // Extract image layers to merged directory
        let merged_path = temp.path().join("merged");
        let prepared = RootfsBuilder::new().prepare(merged_path, image).await?;

        // Create ext4 from merged directory (blocking I/O)
        let temp_disk_path = temp.path().join("image.ext4");
        let prepared_path = prepared.path.clone();
        let disk_clone = temp_disk_path.clone();
        let reserve_bytes = self.reserve_bytes;
        let temp_disk = tokio::task::spawn_blocking(move || {
            create_ext4_from_dir(&prepared_path, &disk_clone, reserve_bytes)
        })
        .await
        .map_err(|e| BoxliteError::Internal(format!("Disk creation task failed: {}", e)))??;

        // Atomically install staged disk to cache
        self.install(digest, temp_disk)
    }

    /// Atomically install a staged disk to the cache directory.
    ///
    /// Takes ownership of the temp `Disk`, renames it to the final cache path,
    /// and returns a new persistent `Disk` pointing to the installed location.
    fn install(&self, digest: &str, staged_disk: Disk) -> BoxliteResult<Disk> {
        let target = self.disk_path(digest);

        // Defensive: target may already exist from a previous run
        if target.exists() {
            tracing::debug!("Image disk already exists: {}", target.display());
            return Ok(Disk::new(target, DiskFormat::Ext4, true));
        }

        fs::create_dir_all(&self.cache_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create disk image directory {}: {}",
                self.cache_dir.display(),
                e
            ))
        })?;

        let source = staged_disk.path().to_path_buf();

        // Atomic rename (same filesystem guaranteed by startup validation)
        fs::rename(&source, &target).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to install disk image from {} to {}: {}",
                source.display(),
                target.display(),
                e
            ))
        })?;

        // Prevent staged_disk from cleaning up the now-moved file
        let _ = staged_disk.leak();

        tracing::info!("Installed image disk to cache: {}", target.display());
        Ok(Disk::new(target, DiskFormat::Ext4, true))
    }

    /// Compute the cache path for a given image digest.
    ///
    /// Includes `reserve_bytes` — see the field doc for why that's safe.
    fn disk_path(&self, digest: &str) -> PathBuf {
        let filename = digest.replace(':', "-");
        self.cache_dir
            .join(format!("{}-r{}.ext4", filename, self.reserve_bytes))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::db::{BaseDiskStore, CachedImage, Database, ImageIndexStore};
    use crate::disk::constants::filenames as disk_filenames;
    use crate::disk::{BackingFormat, Qcow2Helper};
    use crate::images::blob_source::{BlobSource, LocalBundleBlobSource};
    use crate::images::manager::{ImageManifest, LayerInfo};

    /// A cache directory, a boxes directory and a database, wired the way
    /// `RuntimeImpl::initialize` wires them.
    struct TestHome {
        _dir: tempfile::TempDir,
        root: PathBuf,
        db: Database,
        index: ImageIndexStore,
        metrics: RuntimeMetricsStorage,
    }

    impl TestHome {
        fn new() -> Self {
            let dir = tempfile::TempDir::new().unwrap();
            let root = dir.path().canonicalize().unwrap();
            for sub in [
                "disk-images",
                "boxes",
                "bases",
                "temp",
                "layers",
                "extracted",
            ] {
                fs::create_dir_all(root.join(sub)).unwrap();
            }
            let db = Database::open(&root.join("boxlite.db")).unwrap();
            let index = ImageIndexStore::new(db.clone());
            Self {
                _dir: dir,
                root,
                db,
                index,
                metrics: RuntimeMetricsStorage::new(),
            }
        }

        fn manager(&self, reserve_bytes: u64) -> ImageDiskManager {
            ImageDiskManager::new(
                self.root.join("disk-images"),
                self.root.join("temp"),
                reserve_bytes,
                DiskCacheReclaim::new(
                    self.index.clone(),
                    crate::disk::BaseDiskManager::new(
                        self.root.join("bases"),
                        BaseDiskStore::new(self.db.clone()),
                    ),
                    self.root.join("boxes"),
                    self.metrics.clone(),
                ),
            )
        }

        /// Record a pulled reference, exactly as `ImageStore::update_index` does.
        fn record_pull(&self, reference: &str, layers: &[&str]) {
            self.record_pull_used_at(reference, layers, 0);
        }

        /// A recorded reference with an explicit last-use stamp.
        fn record_pull_used_at(&self, reference: &str, layers: &[&str], last_used_at: i64) {
            self.index
                .upsert(
                    reference,
                    &CachedImage {
                        manifest_digest: "sha256:manifest".to_string(),
                        config_digest: "sha256:config".to_string(),
                        layers: layers.iter().map(|l| l.to_string()).collect(),
                        cached_at: chrono::Utc::now().to_rfc3339(),
                        complete: true,
                        last_used_at,
                    },
                )
                .unwrap();
        }

        /// A recorded reference plus the settled cache file its layers name.
        fn cached_disk(
            &self,
            mgr: &ImageDiskManager,
            reference: &str,
            layers: &[&str],
            last_used_at: i64,
        ) -> PathBuf {
            self.record_pull_used_at(reference, layers, last_used_at);
            let path = mgr.disk_path(&image_digest_for_layers(layers));
            write_settled(&path);
            path
        }

        /// A box directory whose container overlay backs onto `base`.
        fn box_backed_by(&self, box_id: &str, base: &Path) {
            let disks_dir = self.root.join("boxes").join(box_id).join("disks");
            fs::create_dir_all(&disks_dir).unwrap();
            Qcow2Helper::create_cow_child_disk(
                base,
                BackingFormat::Raw,
                &disks_dir.join(disk_filenames::CONTAINER_DISK),
                16 * 1024 * 1024,
            )
            .unwrap()
            .leak();
        }
    }

    /// Write a cache file and backdate it past [`ORPHAN_GRACE`], so guard C
    /// stops holding it back.
    fn write_settled(path: &Path) {
        fs::write(path, vec![0u8; 4096]).unwrap();
        let settled = SystemTime::now() - ORPHAN_GRACE - Duration::from_secs(60);
        filetime::set_file_mtime(path, filetime::FileTime::from_system_time(settled)).unwrap();
    }

    /// An `ImageObject` over `layers`, sourced from a bundle directory that
    /// does not exist — so building a disk from it fails, which is all the
    /// trigger tests need.
    ///
    /// `absent_bundle` must still be inside the test's own temp directory:
    /// the blob source creates its cache directory eagerly, and a test that
    /// writes outside its sandbox breaks whatever else assumes that path is
    /// absent.
    fn image_with_layers(absent_bundle: &Path, layers: &[&str]) -> ImageObject {
        let manifest = ImageManifest {
            manifest_digest: "sha256:manifest".to_string(),
            layers: layers
                .iter()
                .map(|digest| LayerInfo {
                    digest: digest.to_string(),
                    media_type: "application/vnd.oci.image.layer.v1.tar+gzip".to_string(),
                    size: 0,
                })
                .collect(),
            config_digest: "sha256:config".to_string(),
            diff_ids: Vec::new(),
        };
        ImageObject::new(
            "local/test:latest".to_string(),
            manifest,
            BlobSource::LocalBundle(LocalBundleBlobSource::new(
                absent_bundle.join("bundle"),
                absent_bundle.join("cache"),
            )),
        )
    }

    #[test]
    fn test_disk_path_replaces_colon() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let path = mgr.disk_path("sha256:abc123def456");
        assert_eq!(
            path,
            home.root.join("disk-images/sha256-abc123def456-r0.ext4")
        );
    }

    #[test]
    fn test_disk_path_no_colon() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let path = mgr.disk_path("plaindigest");
        assert_eq!(path, home.root.join("disk-images/plaindigest-r0.ext4"));
    }

    /// Two different `reserve_bytes` values must produce two different cache
    /// paths for the *same* digest — the property
    /// `find_does_not_reuse_a_disk_cached_with_different_reserve_bytes` below
    /// relies on.
    #[test]
    fn test_disk_path_varies_with_reserve_bytes() {
        let home = TestHome::new();
        let small = home.manager(0);
        let large = home.manager(100 * 1024 * 1024);

        assert_ne!(
            small.disk_path("sha256:abc123"),
            large.disk_path("sha256:abc123"),
            "the same digest under a different reserve_bytes must not collide \
             on the same cache path"
        );
    }

    #[test]
    fn test_find_returns_none_when_missing() {
        let home = TestHome::new();
        let mgr = home.manager(0);

        assert!(mgr.find("sha256:nonexistent").is_none());
    }

    #[test]
    fn test_find_returns_disk_when_cached() {
        let home = TestHome::new();
        let mgr = home.manager(0);

        // Create a fake cached disk
        let cached = mgr.disk_path("sha256:abc123");
        std::fs::write(&cached, "fake disk").unwrap();

        let disk = mgr.find("sha256:abc123");
        assert!(disk.is_some());
        let disk = disk.unwrap();
        assert_eq!(disk.path(), cached);
        assert_eq!(disk.format(), DiskFormat::Ext4);
        let _ = disk.leak();
    }

    #[test]
    fn test_install_creates_dir_and_moves_file() {
        let home = TestHome::new();
        let mgr = home.manager(0);

        // Create staged file
        let staged_path = home.root.join("staged.ext4");
        std::fs::write(&staged_path, "staged content").unwrap();
        let staged_disk = Disk::new(staged_path, DiskFormat::Ext4, false);

        let result = mgr.install("sha256:test", staged_disk).unwrap();
        let expected = mgr.disk_path("sha256:test");

        assert!(expected.exists());
        assert_eq!(result.path(), expected);
        let _ = result.leak();
    }

    /// A disk cached under a smaller `reserve_bytes` must not be handed to a
    /// caller that now needs more headroom.
    ///
    /// Live-reproduced during development: a real `~/Library/Application
    /// Support/boxlite/images/disk-images/{digest}.ext4` built before this
    /// budget existed (digest-only filename, no reserve) was reused as-is
    /// once `reserve_bytes` shipped, and `GuestRootfsManager::
    /// build_and_install` hit the identical "Could not allocate block in
    /// ext2 filesystem" failure `reserve_bytes` exists to prevent — a cache
    /// hit had bypassed the fix entirely. `GuestRootfsManager` already
    /// solves the identical problem one layer up (`version_key` folds the
    /// guest binary's id into its cache key so a rebuilt guest can't reuse a
    /// stale rootfs); this pins the same fix at the `ImageDiskManager` layer.
    #[test]
    fn find_does_not_reuse_a_disk_cached_with_different_reserve_bytes() {
        let home = TestHome::new();
        let small = home.manager(0);
        let large = home.manager(100 * 1024 * 1024);

        // Simulate a disk an earlier build cached with less (or no) headroom.
        let cached = small.disk_path("sha256:abc123");
        std::fs::create_dir_all(cached.parent().unwrap()).unwrap();
        std::fs::write(&cached, "small-reserve disk").unwrap();

        assert!(
            large.find("sha256:abc123").is_none(),
            "a disk cached under a smaller reserve_bytes must not be returned \
             to a caller that now needs more headroom"
        );
    }

    #[test]
    fn test_install_race_safe() {
        let home = TestHome::new();
        let mgr = home.manager(0);

        // Pre-create target (another process won the race)
        let target = mgr.disk_path("sha256:raced");
        std::fs::write(&target, "first").unwrap();

        // Try to install over it
        let staged_path = home.root.join("staged.ext4");
        std::fs::write(&staged_path, "second").unwrap();
        let staged_disk = Disk::new(staged_path, DiskFormat::Ext4, false);

        let result = mgr.install("sha256:raced", staged_disk).unwrap();
        assert_eq!(result.path(), target);
        assert_eq!(std::fs::read_to_string(result.path()).unwrap(), "first");
        let _ = result.leak();
    }

    // ========================================================================
    // RECLAIM — D1
    // ========================================================================

    /// Guard A. A headroom-budget change renames every cache entry, so the
    /// old generation stops being reachable by `find()` while still occupying
    /// the disk — the exact leak this sweep exists for. The entry under the
    /// *current* budget, whose digest an index row still names, must survive
    /// the same pass.
    #[test]
    fn guard_a_removes_the_previous_headroom_generation_and_keeps_the_current_one() {
        let home = TestHome::new();
        let layers = ["sha256:layer-one", "sha256:layer-two"];
        home.record_pull("docker.io/library/python:alpine", &layers);
        let digest = image_digest_for_layers(&layers);

        let previous = home.manager(0);
        let current = home.manager(100 * 1024 * 1024);
        let stale = previous.disk_path(&digest);
        let live = current.disk_path(&digest);
        write_settled(&stale);
        write_settled(&live);

        assert_eq!(current.gc_unreachable().unwrap(), 1);
        assert!(
            !stale.exists(),
            "a disk cached under a headroom budget this manager no longer uses is unreachable"
        );
        assert!(
            live.exists(),
            "a disk an index row still names, at the current budget, must never be swept"
        );
    }

    /// Guard A, the other direction: no row names these layers, so nothing can
    /// ever ask for this disk again.
    #[test]
    fn guard_a_removes_a_disk_no_index_row_names() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let orphan = mgr.disk_path(&image_digest_for_layers(&["sha256:forgotten"]));
        write_settled(&orphan);

        assert_eq!(mgr.gc_unreachable().unwrap(), 1);
        assert!(!orphan.exists());
    }

    /// The sweep rebuilds the cache key from an index row's layer list; the
    /// cache builds it from the image's. If those two ever disagree, the sweep
    /// deletes live disks — so this compares them character for character.
    #[test]
    fn guard_a_rebuilds_the_same_key_the_cache_writes() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let layers = ["sha256:layer-one", "sha256:layer-two"];

        let from_image = image_with_layers(&home.root, &layers).compute_image_digest();
        home.record_pull("docker.io/library/python:alpine", &layers);
        let from_index = image_digest_for_layers(&home.index.list_all().unwrap()[0].1.layers);

        assert_eq!(
            from_image, from_index,
            "the reclaim pass must derive the cache key the cache itself wrote"
        );
        assert!(
            mgr.reachable_disk_paths()
                .unwrap()
                .contains(&mgr.disk_path(&from_image)),
            "the disk this image would build must count as reachable"
        );
    }

    /// Guard B. The box is stopped — nothing is running, its overlay is just a
    /// file on disk — and no index row names the disk it backs onto. Guard A
    /// says garbage; guard B must still keep it, or the box loses its rootfs.
    #[test]
    fn guard_b_keeps_a_disk_a_stopped_box_still_backs_onto() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let base = mgr.disk_path(&image_digest_for_layers(&["sha256:booted-from-this"]));
        write_settled(&base);
        home.box_backed_by("stopped-box", &base);

        assert_eq!(mgr.gc_unreachable().unwrap(), 0);
        assert!(
            base.exists(),
            "a disk a box overlay backs onto must survive even with no index row"
        );
    }

    /// What deleting a box actually buys — the sequence `autoDelete` (or an
    /// explicit `DELETE /boxes/:id`) produces on a runner, with an index row
    /// still naming the disk, which is the normal case.
    ///
    /// Deleting the box unpins the disk, and that is *all* it does: guard A
    /// still sees a reference naming it, so the reclaim pass keeps it. Only
    /// the eviction pass can take it, and only under space pressure. So a
    /// box deletion moves its disk from **unevictable** to **evictable** —
    /// it does not by itself free anything.
    #[test]
    fn deleting_a_box_makes_its_disk_evictable_but_not_collected() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let base = home.cached_disk(&mgr, "registry/app:1", &["sha256:in-use"], 0);
        home.box_backed_by("box-alive", &base);

        // While the box exists, neither pass may touch it, at any pressure.
        assert_eq!(mgr.gc_unreachable().unwrap(), 0);
        assert_eq!(
            mgr.evict_cold_down_to_low_watermark(None, &|| Some(99))
                .unwrap(),
            0,
            "a disk a box backs onto is off limits however full the volume is"
        );

        // What `RuntimeImpl::remove_box` leaves behind: no box directory.
        fs::remove_dir_all(home.root.join("boxes/box-alive")).unwrap();

        assert_eq!(
            mgr.gc_unreachable().unwrap(),
            0,
            "an index row still names it, so it is cache, not garbage"
        );
        assert!(base.exists());

        let readings = [95u8, 70];
        let reading = std::cell::Cell::new(0usize);
        let evicted = mgr
            .evict_cold_down_to_low_watermark(None, &|| {
                let i = reading.get();
                reading.set(i + 1);
                Some(readings[i.min(readings.len() - 1)])
            })
            .unwrap();

        assert_eq!(evicted, 1, "unpinned and cold, it is now a candidate");
        assert!(!base.exists());
    }

    /// Guard C. `install` renames a file into place before any caller records
    /// it, so a brand-new entry legitimately looks unreachable for a moment.
    #[test]
    fn guard_c_keeps_a_freshly_installed_disk() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let fresh = mgr.disk_path(&image_digest_for_layers(&["sha256:just-installed"]));
        fs::write(&fresh, b"ext4").unwrap();

        assert_eq!(mgr.gc_unreachable().unwrap(), 0);
        assert!(
            fresh.exists(),
            "a file younger than ORPHAN_GRACE is not garbage yet"
        );
    }

    /// Guard D. Only the one shape this manager installs, and only files.
    #[test]
    fn guard_d_only_touches_ext4_files() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let cache_dir = home.root.join("disk-images");

        let qcow2 = cache_dir.join("someone-elses.qcow2");
        let extensionless = cache_dir.join("README");
        let subdir = cache_dir.join("nested.ext4");
        write_settled(&qcow2);
        write_settled(&extensionless);
        fs::create_dir_all(&subdir).unwrap();

        let ext4 = mgr.disk_path(&image_digest_for_layers(&["sha256:garbage"]));
        write_settled(&ext4);

        assert_eq!(mgr.gc_unreachable().unwrap(), 1);
        assert!(!ext4.exists());
        assert!(qcow2.exists(), "a qcow2 belongs to another manager");
        assert!(
            extensionless.exists(),
            "an unknown file is not ours to delete"
        );
        assert!(subdir.is_dir(), "a directory is never a cache entry");
    }

    /// A database error must abort the sweep. An empty reachable set reads as
    /// "every cached disk is garbage", which would wipe the whole cache — and
    /// with guard B being path-level, most of a busy host's live disks with it.
    #[test]
    fn a_database_error_aborts_the_sweep() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let orphan = mgr.disk_path(&image_digest_for_layers(&["sha256:forgotten"]));
        write_settled(&orphan);

        home.db
            .conn()
            .execute_batch("DROP TABLE image_index;")
            .unwrap();

        assert!(
            mgr.gc_unreachable().is_err(),
            "an unreadable index must surface, not be read as an empty one"
        );
        assert!(orphan.exists(), "nothing may be deleted on a failed sweep");
    }

    // ========================================================================
    // RECLAIM — TRIGGERS
    // ========================================================================

    /// Trigger: the build path. `get_or_create` sweeps before it spends a
    /// whole disk's worth of space — here the build itself fails (the blobs
    /// don't exist), and the sweep still has to have happened.
    #[tokio::test]
    async fn the_build_path_sweeps_before_building() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let orphan = mgr.disk_path(&image_digest_for_layers(&["sha256:forgotten"]));
        write_settled(&orphan);

        let image = image_with_layers(&home.root, &["sha256:missing-blob"]);
        assert!(
            mgr.get_or_create(&image).await.is_err(),
            "a build from absent blobs cannot succeed"
        );

        assert!(
            !orphan.exists(),
            "the sweep runs before the build, not after it"
        );
    }

    /// The build-path sweep is throttled: a burst of box creates must not
    /// re-scan the cache directory once per box.
    #[test]
    fn the_build_path_sweep_is_throttled() {
        let home = TestHome::new();
        let mgr = home.manager(0);

        let first = mgr.disk_path(&image_digest_for_layers(&["sha256:first"]));
        write_settled(&first);
        mgr.reclaim_before_build("sha256:unrelated");
        assert!(!first.exists(), "the first sweep runs");

        let second = mgr.disk_path(&image_digest_for_layers(&["sha256:second"]));
        write_settled(&second);
        mgr.reclaim_before_build("sha256:unrelated");
        assert!(
            second.exists(),
            "a second sweep inside the minimum interval must be skipped"
        );
    }

    // ========================================================================
    // RECLAIM — D2 (eviction under space pressure)
    // ========================================================================

    /// The two counters an operator alerts on. They are deliberately not one
    /// number: "garbage collected" and "live cache surrendered" say opposite
    /// things about a host, so only the eviction pass moves the disk count,
    /// while both passes add to the byte count.
    #[test]
    fn both_passes_report_what_they_freed_to_the_runtime_metrics() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let metrics = crate::metrics::RuntimeMetrics::new(home.metrics.clone());

        let orphan = mgr.disk_path(&image_digest_for_layers(&["sha256:forgotten"]));
        write_settled(&orphan);
        assert_eq!(mgr.gc_unreachable().unwrap(), 1);

        let after_gc = metrics.image_disk_bytes_reclaimed_total();
        assert!(after_gc > 0, "the sweep must report the bytes it freed");
        assert_eq!(
            metrics.image_disks_evicted_total(),
            0,
            "collecting garbage is not an eviction"
        );

        let cold = home.cached_disk(&mgr, "registry/cold:1", &["sha256:cold"], 100);
        let evicted = mgr
            .evict_cold_down_to_low_watermark(None, &|| Some(99))
            .unwrap();

        assert_eq!(evicted, 1);
        assert!(!cold.exists());
        assert_eq!(metrics.image_disks_evicted_total(), 1);
        assert!(
            metrics.image_disk_bytes_reclaimed_total() > after_gc,
            "both passes add to the same byte counter"
        );
    }

    /// The low mark has to leave the pass somewhere to go. It stops as soon
    /// as `usage <= low`, so clamping a too-high setting *to* the high mark
    /// would exit on the first candidate at exactly the usage that triggered
    /// the pass — eviction silently off, which is what the clamp exists to
    /// prevent.
    #[test]
    fn the_low_watermark_always_leaves_room_to_evict_into() {
        assert_eq!(effective_low_percent(70, 85), 70, "a sane setting is kept");
        assert_eq!(
            effective_low_percent(85, 85),
            84,
            "a low mark equal to the high one would stop before freeing anything"
        );
        assert_eq!(
            effective_low_percent(99, 85),
            84,
            "and so would a higher one"
        );
        assert_eq!(
            effective_low_percent(70, 0),
            0,
            "a zero high mark evicts everything"
        );
    }

    /// The defect in the subject line: a build that would have met ENOSPC
    /// makes room first. Driven through `reclaim_before_build`, the real
    /// build-path entry point, rather than through the eviction pass alone —
    /// so it covers the wiring too: the disk this build is installing, and the
    /// one a live box backs onto, both survive the pass that frees the rest.
    ///
    /// What it deliberately does not assert is that `mke2fs` then succeeds;
    /// that needs a real image and a real full volume, and was measured by
    /// hand on a 32 MiB tmpfs instead.
    #[test]
    fn the_build_path_evicts_cold_disks_to_make_room() {
        let home = TestHome::new();
        let mgr = home.manager(0);

        let cold = home.cached_disk(&mgr, "registry/cold:1", &["sha256:cold"], 100);
        let pinned = home.cached_disk(&mgr, "registry/pinned:1", &["sha256:pinned"], 200);
        home.box_backed_by("live-box", &pinned);
        let building = image_digest_for_layers(&["sha256:building"]);
        let in_flight = home.cached_disk(&mgr, "registry/building:1", &["sha256:building"], 300);

        mgr.reclaim_before_build_with(&building, &|| Some(99));

        assert!(!cold.exists(), "the coldest unreferenced disk makes room");
        assert!(
            pinned.exists(),
            "a disk a live box backs onto is never a candidate"
        );
        assert!(
            in_flight.exists(),
            "the disk this build is installing must survive its own pass"
        );
    }

    /// `100` is documented as the off switch — in the constant above and in
    /// all four SDK READMEs. A full volume reads back as exactly 100, so the
    /// predicate has to name that case rather than lean on `usage < high`.
    #[test]
    fn a_high_watermark_of_100_turns_eviction_off() {
        assert!(
            !eviction_is_warranted(100, 100),
            "a full volume must not evict when the operator disabled eviction"
        );
        assert!(!eviction_is_warranted(99, 100));
        assert!(
            eviction_is_warranted(85, 85),
            "at the watermark the pass runs"
        );
        assert!(!eviction_is_warranted(84, 85));
    }

    /// The default posture on any host that isn't nearly full: evict nothing.
    /// An eviction costs the next box a full local rebuild, so the pass must
    /// stay inert until the disk really is under pressure.
    #[test]
    fn nothing_is_evicted_below_the_high_watermark() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let disk = home.cached_disk(&mgr, "docker.io/library/python:alpine", &["sha256:l1"], 100);

        let evicted = mgr
            .evict_cold_down_to_low_watermark(None, &|| Some(evict_high_percent() - 1))
            .unwrap();

        assert_eq!(evicted, 0);
        assert!(disk.exists(), "no pressure, no eviction");
    }

    /// Under pressure the pass takes the coldest disks first and stops the
    /// moment usage is back under the low watermark — it relieves pressure,
    /// it does not flush the cache.
    #[test]
    fn eviction_takes_the_coldest_first_and_stops_at_the_low_watermark() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let coldest = home.cached_disk(&mgr, "registry/a:1", &["sha256:a"], 100);
        let colder = home.cached_disk(&mgr, "registry/b:1", &["sha256:b"], 200);
        let warm = home.cached_disk(&mgr, "registry/c:1", &["sha256:c"], 300);

        // Gate, then after each removal: the second removal brings it under.
        let readings = [90u8, 88, 70];
        let reading = std::cell::Cell::new(0usize);
        let evicted = mgr
            .evict_cold_down_to_low_watermark(None, &|| {
                let i = reading.get();
                reading.set(i + 1);
                Some(readings[i.min(readings.len() - 1)])
            })
            .unwrap();

        assert_eq!(evicted, 2);
        assert!(!coldest.exists(), "least recently used goes first");
        assert!(!colder.exists(), "then the next one up");
        assert!(
            warm.exists(),
            "the pass stops at the low watermark instead of emptying the cache"
        );
    }

    /// The eviction signal is `last_used_at`, never mtime. A cached disk is a
    /// read-only backing file, so reading one never touches its mtime: an
    /// mtime order degrades into "oldest created first", which evicts the
    /// most widely shared base image — the exact opposite of what is wanted.
    #[test]
    fn eviction_follows_last_use_not_creation_order() {
        let home = TestHome::new();
        let mgr = home.manager(0);

        // Created first, used a moment ago — the shared base image.
        let oldest_but_hot = home.cached_disk(
            &mgr,
            "registry/base:1",
            &["sha256:base"],
            chrono::Utc::now().timestamp(),
        );
        // Created last, never used since — mtime says "newest", use says "cold".
        let newest_but_cold = home.cached_disk(&mgr, "registry/oneoff:1", &["sha256:oneoff"], 0);
        let newer = SystemTime::now() - Duration::from_secs(ORPHAN_GRACE.as_secs() + 1);
        filetime::set_file_mtime(
            &newest_but_cold,
            filetime::FileTime::from_system_time(newer),
        )
        .unwrap();
        let much_older = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
        filetime::set_file_mtime(
            &oldest_but_hot,
            filetime::FileTime::from_system_time(much_older),
        )
        .unwrap();

        let readings = [95u8, 70];
        let reading = std::cell::Cell::new(0usize);
        let evicted = mgr
            .evict_cold_down_to_low_watermark(None, &|| {
                let i = reading.get();
                reading.set(i + 1);
                Some(readings[i.min(readings.len() - 1)])
            })
            .unwrap();

        assert_eq!(evicted, 1);
        assert!(
            !newest_but_cold.exists(),
            "the least recently *used* disk is the one to go"
        );
        assert!(
            oldest_but_hot.exists(),
            "the oldest file is not the coldest entry; mtime must not decide this"
        );
    }

    /// Guard B, again: a stopped box's overlay still backs onto its disk, and
    /// pressure is not a reason to take a running system's rootfs away.
    #[test]
    fn eviction_never_takes_a_disk_a_box_backs_onto() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let in_use = home.cached_disk(&mgr, "registry/in-use:1", &["sha256:in-use"], 0);
        home.box_backed_by("stopped-box", &in_use);

        let evicted = mgr
            .evict_cold_down_to_low_watermark(None, &|| Some(99))
            .unwrap();

        assert_eq!(evicted, 0);
        assert!(
            in_use.exists(),
            "the coldest disk on the host is still off limits while a box backs onto it"
        );
    }

    /// The backing scan is eviction's *only* guard — the "no index row names
    /// it" guard cannot apply to entries that are in the index by definition.
    /// So a scan that saw nothing must read as "unknown", never as "nothing
    /// backs onto these".
    #[test]
    fn an_unreadable_boxes_dir_abandons_both_passes() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let cached = home.cached_disk(&mgr, "registry/a:1", &["sha256:a"], 0);
        let orphan = mgr.disk_path(&image_digest_for_layers(&["sha256:forgotten"]));
        write_settled(&orphan);

        // A regular file where the directory should be: `read_dir` fails with
        // ENOTDIR while `exists()` still answers true, which is exactly the
        // shape a transient listing failure takes.
        let boxes_dir = home.root.join("boxes");
        fs::remove_dir_all(&boxes_dir).unwrap();
        fs::write(&boxes_dir, b"not a directory").unwrap();

        assert_eq!(mgr.gc_unreachable().unwrap(), 0);
        assert_eq!(
            mgr.evict_cold_down_to_low_watermark(None, &|| Some(99))
                .unwrap(),
            0
        );
        assert!(
            cached.exists() && orphan.exists(),
            "a scan that could not list the boxes directory must delete nothing"
        );
    }

    /// A filesystem that cannot be queried must not be read as a full one.
    #[test]
    fn an_unreadable_filesystem_abandons_the_pass() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let disk = home.cached_disk(&mgr, "registry/a:1", &["sha256:a"], 0);

        let evicted = mgr
            .evict_cold_down_to_low_watermark(None, &|| None)
            .unwrap();

        assert_eq!(evicted, 0);
        assert!(disk.exists(), "unknown free space is not zero free space");
    }

    /// Eviction only takes `disk-images/` entries. The layer and extracted
    /// layer caches are deduplicated across images and are what keeps a
    /// rebuild off the network — dropping them would cost more than it frees.
    #[test]
    fn eviction_leaves_the_layer_caches_alone() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        home.cached_disk(&mgr, "registry/a:1", &["sha256:a"], 0);
        let tarball = home.root.join("layers/sha256-a.tar.gz");
        let extracted = home.root.join("extracted/sha256-a/file");
        fs::write(&tarball, b"layer").unwrap();
        fs::create_dir_all(extracted.parent().unwrap()).unwrap();
        fs::write(&extracted, b"content").unwrap();

        assert_eq!(
            mgr.evict_cold_down_to_low_watermark(None, &|| Some(99))
                .unwrap(),
            1
        );
        assert!(tarball.exists(), "the layer tarball cache is not evicted");
        assert!(
            extracted.exists(),
            "the extracted layer cache is not evicted"
        );
    }

    /// The two passes compose: the free one first, then the one with a cost.
    #[test]
    fn reclaim_now_runs_both_passes() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let orphan = mgr.disk_path(&image_digest_for_layers(&["sha256:forgotten"]));
        write_settled(&orphan);

        // The eviction half reads the real host's `statvfs`, which a test
        // cannot dictate — so this asserts only that both passes compose and
        // neither errors. What eviction *does* under pressure is pinned by the
        // injected-usage tests below; asserting `evicted == 0` here would
        // invert on any host that is itself above the high watermark, which is
        // precisely the condition this code exists for.
        let reclaimed = mgr.reclaim_now().unwrap();
        assert_eq!(reclaimed.collected, 1, "the unreachable entry is garbage");
        assert!(!orphan.exists());
    }

    /// The default `apps/api` falls back to for one of its env-configured
    /// settings, read out of its own source: `parseInt(process.env.NAME || '75', 10)`.
    ///
    /// Reading it rather than copying the number is the whole point of the
    /// test below — a copy would keep passing after the control plane moved.
    fn control_plane_percent_default(source: &str, env_var: &str) -> u8 {
        let needle = format!("process.env.{env_var}");
        let found = source.matches(needle.as_str()).count();
        assert_eq!(
            found, 1,
            "expected exactly one `{needle}` in the control plane config, found {found}; \
             the parse below could not tell which one is the placement threshold"
        );

        let after = &source[source.find(needle.as_str()).unwrap() + needle.len()..];
        let literal = after
            .split_once('\'')
            .and_then(|(_, rest)| rest.split_once('\''))
            .map(|(literal, _)| literal)
            .unwrap_or_else(|| {
                panic!(
                    "no quoted default follows `{needle}`; if that config changed shape, \
                     re-check the watermark coupling by hand and fix this parse"
                )
            });
        let percent: u8 = literal.parse().unwrap_or_else(|e| {
            panic!("`{needle}` default {literal:?} does not read as a percentage: {e}")
        });
        assert!(
            (1..=100).contains(&percent),
            "`{needle}` parsed as {percent}, which is not a percentage — the parse \
             probably picked up the wrong literal"
        );
        percent
    }

    /// The low watermark has to land *under* the control plane's disk penalty,
    /// not on it.
    ///
    /// `apps/api` scores a runner down exponentially from
    /// `RUNNER_DISK_PENALTY_THRESHOLD` and stops placing boxes on it entirely
    /// once the score falls under its availability threshold. Both sides read
    /// the same figure — the runner reports `disk.Usage("/")`, this reads
    /// `statvfs` on a cache directory on the same volume — so an eviction that
    /// stopped *at* the penalty line would free space without restoring the
    /// runner's standing, leaving a completed pass with nothing to show.
    ///
    /// The threshold is read out of `apps/api`'s own source rather than copied
    /// here, so moving *either* number breaks this. A copied constant would
    /// keep this test green after the control plane changed, which is the
    /// assurance backwards.
    #[test]
    fn the_low_watermark_stays_under_the_control_plane_disk_penalty() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|src_dir| src_dir.parent())
            .expect("the boxlite crate lives under src/boxlite")
            .to_path_buf();
        let config = repo_root.join("apps/api/src/config/configuration.ts");
        let source = fs::read_to_string(&config)
            .unwrap_or_else(|e| panic!("read {}: {e}", config.display()));

        let penalty = control_plane_percent_default(&source, "RUNNER_DISK_PENALTY_THRESHOLD");

        assert!(
            DEFAULT_EVICT_LOW_PERCENT < penalty,
            "eviction must bring a runner back under the placement penalty, not stop on \
             it: low watermark {DEFAULT_EVICT_LOW_PERCENT}, RUNNER_DISK_PENALTY_THRESHOLD \
             {penalty} (apps/api/src/config/configuration.ts). Whichever side moved, both \
             numbers have to be chosen together."
        );
    }

    /// `install` renames a disk into place *before* the box overlay that will
    /// back onto it exists. In that window the disk looks unreferenced, so a
    /// concurrent create's eviction pass could take it and leave the first
    /// build pointing at a missing backing file. Anything younger than
    /// [`ORPHAN_GRACE`] is therefore held back — the same window
    /// `gc_unreachable`'s guard C covers.
    #[test]
    fn a_freshly_installed_disk_is_not_evicted() {
        let home = TestHome::new();
        let mgr = home.manager(0);

        // Settled and cold: a legitimate candidate.
        let settled = home.cached_disk(&mgr, "registry/settled:1", &["sha256:settled"], 0);
        // Just landed: recorded and unreferenced, but not settled.
        let layers = ["sha256:just-installed"];
        home.record_pull_used_at("registry/fresh:1", &layers, 0);
        let fresh = mgr.disk_path(&image_digest_for_layers(&layers));
        fs::write(&fresh, vec![0u8; 4096]).unwrap();

        let evicted = mgr
            .evict_cold_down_to_low_watermark(None, &|| Some(99))
            .unwrap();

        assert_eq!(evicted, 1, "only the settled disk is a candidate");
        assert!(!settled.exists());
        assert!(
            fresh.exists(),
            "a disk that just landed may still be waiting for its overlay"
        );
    }

    /// The disk this very pull is about to install is held back by name, so
    /// the guarantee does not depend on clock skew or on how long the build
    /// between install and overlay takes.
    #[test]
    fn the_disk_being_built_is_not_evicted() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let layers = ["sha256:in-flight"];
        let building = image_digest_for_layers(&layers);
        let disk = home.cached_disk(&mgr, "registry/in-flight:1", &layers, 0);

        let evicted = mgr
            .evict_cold_down_to_low_watermark(Some(&building), &|| Some(99))
            .unwrap();

        assert_eq!(evicted, 0, "the in-flight disk is the one being built");
        assert!(disk.exists());
    }

    /// The complement: a build that fails hands out no disk, so it must
    /// record no use. Together with the hit test and the single call site on
    /// the joined path, that pins the recording to "a disk was handed out"
    /// from both directions.
    ///
    /// The successful rebuild branch has no unit test of its own — it needs
    /// real layers and `mke2fs` — which is why the recording sits after the
    /// `match` rather than inside either arm.
    #[tokio::test]
    async fn a_failed_build_records_no_use() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let layers = ["sha256:never-built"];
        let asked_for = image_with_layers(&home.root, &layers);
        let row_key = crate::images::index_key(asked_for.reference());
        home.record_pull_used_at(&row_key, &layers, 0);

        assert!(
            mgr.get_or_create(&asked_for).await.is_err(),
            "the bundle does not exist, so the build must fail"
        );

        assert_eq!(
            home.index.get(&row_key).unwrap().unwrap().last_used_at,
            0,
            "nothing was handed out, so nothing was used"
        );
    }

    /// A cache hit has to record the use, or every entry keeps its original
    /// stamp and the eviction order silently degrades into least-recently
    /// *pulled* — creation order, which takes the most widely shared bases
    /// first.
    ///
    /// The row is seeded under the **normalized** reference, the way a pull
    /// writes it, while the `ImageObject` carries the raw string the caller
    /// typed. Those are different strings, and `touch` is a no-op for an
    /// unknown key, so a recording that skips the derivation updates nothing
    /// and reports no error. Seeding under the raw string instead would make
    /// this test agree with that bug.
    ///
    /// It also records the use of the reference that was *asked for*, not of
    /// every reference that happens to name the same disk — stamping a tag
    /// nobody used would report recency that never happened.
    #[tokio::test]
    async fn a_cache_hit_records_the_use() {
        let home = TestHome::new();
        let mgr = home.manager(0);
        let layers = ["sha256:hit"];
        let asked_for = image_with_layers(&home.root, &layers);

        let row_key = crate::images::index_key(asked_for.reference());
        assert_ne!(
            row_key,
            asked_for.reference(),
            "this test only bites while the typed and normalized forms differ"
        );
        home.cached_disk(&mgr, &row_key, &layers, 0);
        // A second reference over the same layers, so the same cached disk.
        home.cached_disk(&mgr, "registry/other-name:1", &layers, 0);

        mgr.get_or_create(&asked_for)
            .await
            .expect("the cached disk must be returned as-is");

        assert_eq!(
            home.index
                .get("registry/other-name:1")
                .unwrap()
                .unwrap()
                .last_used_at,
            0,
            "a reference nobody asked for keeps its stamp"
        );
        let recorded = home.index.get(&row_key).unwrap().unwrap();
        assert!(
            recorded.last_used_at > 0,
            "a cache hit must move last_used_at forward"
        );
    }
}
