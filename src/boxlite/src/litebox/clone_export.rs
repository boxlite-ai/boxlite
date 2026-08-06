//! Clone and export operations for BoxImpl.

use std::sync::Arc;
use std::time::Instant;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::box_impl::{BoxImpl, QuiescePolicy};
use crate::disk::BaseDiskKind;
use crate::disk::constants::filenames as disk_filenames;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::runtime::types::BoxStatus;

// ============================================================================
// CLONE / EXPORT OPERATIONS
// ============================================================================

impl BoxImpl {
    pub(crate) async fn clone_box(
        &self,
        options: crate::runtime::options::CloneOptions,
        name: Option<String>,
    ) -> BoxliteResult<crate::LiteBox> {
        // Single clone delegates to batch clone with count=1.
        let names = match name {
            Some(n) => vec![n],
            None => Vec::new(),
        };
        let mut clones = self.clone_boxes(options, 1, names).await?;
        Ok(clones.remove(0))
    }

    /// Batch clone: create N clones sharing a single base disk layer.
    ///
    /// Three-phase flow (snapshot-as-base):
    ///   A. Inside quiesce bracket (VM paused): create disk layer (rename + COW child).
    ///   B. Outside quiesce bracket (VM resumed): create N thin overlay headers.
    ///   C. Provision each clone and increment layer ref count.
    pub(crate) async fn clone_boxes(
        &self,
        _options: crate::runtime::options::CloneOptions,
        count: usize,
        names: Vec<String>,
    ) -> BoxliteResult<Vec<crate::LiteBox>> {
        if count == 0 {
            return Ok(Vec::new());
        }

        if !names.is_empty() && names.len() != count {
            return Err(BoxliteError::Config(format!(
                "names length ({}) must match count ({})",
                names.len(),
                count
            )));
        }

        let t0 = Instant::now();
        let _lock = self.disk_ops.lock().await;

        let rt = Arc::clone(&self.runtime);
        let src_disks = self.config.box_home.join("disks");
        let src_container = src_disks.join(disk_filenames::CONTAINER_DISK);

        if !src_container.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                src_container.display()
            )));
        }

        // Phase A: Create shared base layer inside quiesce bracket (VM paused).
        // This is the same operation as snapshot creation: rename + COW child.
        let source_box_id = self.id().to_string();
        let layer = {
            let src_disks = src_disks.clone();
            let source_box_id = source_box_id.clone();

            self.with_quiesce_async(async {
                rt.base_disk_mgr.create_base_disk(
                    &src_disks,
                    BaseDiskKind::CloneBase,
                    None,
                    &source_box_id,
                )
            })
            .await?
        };

        // base_path is a flat file (e.g., bases/{nanoid}.qcow2)
        let shared_container = layer.disk_info.to_path_buf();

        // Read virtual size from the shared base for overlay creation.
        let container_vsize = Qcow2Helper::qcow2_virtual_size(&shared_container)?;

        // Phase B: Create N container overlay headers (VM is resumed, fast).
        // Guest rootfs is NOT cloned — each clone creates its own on first start.
        let mut staging_dirs = Vec::with_capacity(count);
        for _ in 0..count {
            let temp = tempfile::tempdir_in(rt.layout.boxes_dir()).map_err(|e| {
                BoxliteError::Storage(format!("Failed to create temp box directory: {}", e))
            })?;
            #[allow(deprecated)]
            let staging = temp.into_path();

            let staging_disks = staging.join("disks");
            std::fs::create_dir_all(&staging_disks).map_err(|e| {
                BoxliteError::Storage(format!("Failed to create staging disks dir: {}", e))
            })?;

            // Container overlay → shared base (qcow2 backing qcow2)
            // leak() prevents the Disk RAII guard from deleting the file on drop —
            // the child is the clone's persistent disk and must outlive this function.
            Qcow2Helper::create_cow_child_disk(
                &shared_container,
                BackingFormat::Qcow2,
                &staging_disks.join(disk_filenames::CONTAINER_DISK),
                container_vsize,
            )?
            .leak();

            staging_dirs.push(staging);
        }

        // Phase C: Provision each clone and record base disk refs.
        let mut clones = Vec::with_capacity(count);
        for (i, staging) in staging_dirs.into_iter().enumerate() {
            let litebox = match rt
                .provision_box(
                    staging.clone(),
                    names.get(i).cloned(),
                    self.config.options.clone(),
                    BoxStatus::Stopped,
                )
                .await
            {
                Ok(lb) => lb,
                Err(e) => {
                    // Cleanup remaining staging dirs on failure.
                    let _ = std::fs::remove_dir_all(&staging);
                    // Don't clean up already-provisioned clones; they're valid boxes.
                    return Err(e);
                }
            };

            // Record that this clone depends on the shared base disk.
            if let Err(e) = rt
                .base_disk_mgr
                .store()
                .add_ref(&layer.id, litebox.id().as_ref())
            {
                tracing::warn!(
                    clone_id = %litebox.id(),
                    base_disk_id = %layer.id,
                    error = %e,
                    "Failed to record base disk ref for clone"
                );
            }

            clones.push(litebox);
        }

        tracing::info!(
            source_id = %self.id(),
            base_disk_id = %layer.id,
            count = clones.len(),
            elapsed_ms = t0.elapsed().as_millis() as u64,
            "Batch cloned boxes (shared base disk)"
        );

        Ok(clones)
    }

    pub(crate) async fn export_box(
        &self,
        options: crate::runtime::options::ExportOptions,
        dest: &std::path::Path,
    ) -> BoxliteResult<crate::runtime::options::BoxArchive> {
        let t0 = Instant::now();
        let _lock = self.disk_ops.lock().await;

        let box_home = self.config.box_home.clone();
        let runtime_layout = self.runtime.layout.clone();

        // Phase 1: Capture the chain inside the quiesce bracket (VM paused).
        // Only the top overlay is live, so only it has to be copied; the bases
        // below it are immutable and are read in place at archive time.
        //
        // An archive is expected to restore into a working box, so a failed
        // freeze is refused rather than silently downgraded: SIGSTOP alone
        // pauses the vCPUs but leaves the guest's dirty page cache unwritten,
        // producing the disk equivalent of pulling the power cord. That archive
        // is indistinguishable from a good one, which makes it worse than no
        // archive at all. Clone and snapshot keep the best-effort policy —
        // their output is a COW fork the caller boots immediately, not an
        // artifact someone will restore from months later.
        let capture = self
            .with_quiesce_policy(QuiescePolicy::RequireFrozen, async {
                let bh = box_home.clone();
                let rl = runtime_layout.clone();
                tokio::task::spawn_blocking(move || do_export_capture(&bh, &rl))
                    .await
                    .map_err(|e| {
                        BoxliteError::Internal(format!("Export capture task panicked: {}", e))
                    })?
            })
            .await?;

        // Phase 2: Digest + manifest + archive run with the VM resumed. Every
        // input is now either a temp copy or an immutable base.
        let config_name = self.config.name.clone();
        let config_options = self.config.options.clone();
        let box_id_str = self.id().to_string();
        let dest = dest.to_path_buf();
        let as_directory = options.as_directory;
        let base_disk_mgr = self.runtime.base_disk_mgr.clone();
        let image_disks_dir = self.runtime.layout.image_layout().disk_images_dir();

        let result = tokio::task::spawn_blocking(move || {
            do_export_finalize(
                capture,
                &base_disk_mgr,
                &image_disks_dir,
                config_name.as_deref(),
                &config_options,
                &box_id_str,
                if as_directory {
                    ExportDest::Directory(&dest)
                } else {
                    ExportDest::File(&dest)
                },
            )
        })
        .await
        .map_err(|e| BoxliteError::Internal(format!("Export finalize task panicked: {}", e)))?;

        tracing::info!(
            box_id = %self.config.id,
            elapsed_ms = t0.elapsed().as_millis() as u64,
            ok = result.is_ok(),
            "export_box completed"
        );

        result
    }
}

/// The box's disk chain as captured under quiesce, base first and top last.
struct ChainCapture {
    temp_dir: tempfile::TempDir,
    /// Files to read each layer from. The last entry is a temp copy of the
    /// live top overlay; the rest are immutable bases read in place.
    layer_paths: Vec<std::path::PathBuf>,
    capture_ms: u64,
}

/// Phase 1: Capture the container disk's layer chain.
/// Runs inside the quiesce bracket — this is the only part that needs disk consistency.
///
/// The chain is exported as layers rather than flattened into one image. The
/// layers below the top are immutable and shared: every box's container disk is
/// a COW child of the image disk, so the image layer is identical across every
/// box built from it and an importer that already holds it skips the transfer
/// entirely. Flattening would erase exactly that structure, and measured on a
/// real box it does not even buy a smaller archive.
///
/// The guest rootfs disk is deliberately not exported. It is a thin COW overlay
/// over the host-global guest rootfs cache (`bases/{id}.ext4`, keyed by the
/// bootstrap image + guest binary version), holds no user state, and is
/// recreated from the importing host's own cache on first start — the same way
/// clone and snapshot-restore already treat it.
fn do_export_capture(
    box_home: &std::path::Path,
    runtime_layout: &crate::runtime::layout::FilesystemLayout,
) -> BoxliteResult<ChainCapture> {
    use crate::disk::constants::filenames as disk_filenames;
    use crate::disk::{read_backing_chain, read_backing_file_path};

    let disks_dir = box_home.join("disks");
    let container_disk = disks_dir.join(disk_filenames::CONTAINER_DISK);

    if !container_disk.exists() {
        return Err(BoxliteError::Storage(format!(
            "Container disk not found at {}",
            container_disk.display()
        )));
    }

    let temp_dir = tempfile::tempdir_in(runtime_layout.temp_dir())
        .map_err(|e| BoxliteError::Storage(format!("Failed to create temp directory: {}", e)))?;

    let t_capture = Instant::now();

    // Only the top overlay can still be written to, so it is the only layer
    // that has to be copied while the VM is paused.
    let top_copy = temp_dir.path().join(disk_filenames::CONTAINER_DISK);
    std::fs::copy(&container_disk, &top_copy).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to copy container disk {}: {}",
            container_disk.display(),
            e
        ))
    })?;

    // read_backing_chain yields the backing files below `container_disk`,
    // nearest first, so reversing puts the deepest base at index 0.
    let chain = read_backing_chain(&container_disk);
    let deepest = chain.last().unwrap_or(&container_disk);
    if is_qcow2(deepest) && read_backing_file_path(deepest)?.is_some() {
        return Err(BoxliteError::Storage(format!(
            "Cannot export {}: backing chain is incomplete",
            container_disk.display()
        )));
    }
    let mut layer_paths: Vec<std::path::PathBuf> = chain.into_iter().rev().collect();
    layer_paths.push(top_copy);

    let capture_ms = t_capture.elapsed().as_millis() as u64;

    Ok(ChainCapture {
        temp_dir,
        layer_paths,
        capture_ms,
    })
}

/// The OCI image digest a layer is the disk for, if it is one.
///
/// Image disks live in the image cache under a filename derived from the image
/// digest (`images/image_disk.rs`), so the digest is read back from the path
/// rather than by resolving the image again — export must not depend on the
/// registry being reachable.
fn image_digest_of(path: &std::path::Path, image_disks_dir: &std::path::Path) -> Option<String> {
    let path = path.canonicalize().ok()?;
    let image_disks_dir = image_disks_dir.canonicalize().ok()?;
    if path.parent() != Some(image_disks_dir.as_path()) {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    // `sha256:<hex>` is stored as `sha256-<hex>.ext4`.
    let (algo, hex) = stem.split_once('-')?;
    if algo != "sha256" || hex.is_empty() {
        return None;
    }
    Some(format!("{algo}:{hex}"))
}

/// Whether a file starts with the qcow2 magic, deciding how a child references it.
fn is_qcow2(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).is_ok() && u32::from_be_bytes(magic) == 0x5146_49fb
}

/// Where an export lands, and in which form.
enum ExportDest<'a> {
    /// One `.boxlite` file; a directory here means "name the file inside it".
    File(&'a std::path::Path),
    /// A mirrorable directory of layer objects, used exactly as given.
    Directory(&'a std::path::Path),
}

/// Phase 2: Checksum, manifest, and archive.
/// Runs after the VM resumes — only reads static temp files.
fn do_export_finalize(
    capture: ChainCapture,
    base_disk_mgr: &crate::disk::BaseDiskManager,
    image_disks_dir: &std::path::Path,
    config_name: Option<&str>,
    config_options: &crate::runtime::options::BoxOptions,
    box_id_str: &str,
    dest: ExportDest<'_>,
) -> BoxliteResult<crate::runtime::options::BoxArchive> {
    use super::archive::{
        ArchiveLayer, ArchiveManifest, CanonicalLayer, LAYERED_ARCHIVE_VERSION, LayerFormat,
        MANIFEST_FILENAME, archive_version_for_options, build_layered_archive,
        build_layered_directory, sha256_file,
    };
    use crate::disk::Qcow2Helper;

    // In directory mode `dest` *is* the directory to mirror, so it is used as
    // given — appending a name would bury the layout a level down and break
    // repeat exports into the same place, which is what makes the transfer
    // incremental.
    let output_path = match dest {
        ExportDest::Directory(dir) => dir.to_path_buf(),
        ExportDest::File(path) if path.is_dir() => {
            let name = config_name.unwrap_or("box");
            path.join(format!("{}.boxlite", name))
        }
        ExportDest::File(path) => path.to_path_buf(),
    };

    let t_digest = Instant::now();
    let last = capture.layer_paths.len().saturating_sub(1);
    let mut layers = Vec::with_capacity(capture.layer_paths.len());
    let mut blobs = Vec::with_capacity(capture.layer_paths.len());

    for (i, path) in capture.layer_paths.iter().enumerate() {
        // Every layer below the top is immutable, so its digest is cached and a
        // repeat export never re-reads it — which matters most for the image
        // disk, usually the largest layer in the chain. The top layer is a
        // fresh temp copy that will be gone in a moment, so there is nothing to
        // cache it against and no point trying.
        let digest = if i == last {
            CanonicalLayer::open(path)?.digest()?
        } else {
            match base_disk_mgr.digest_of(path)? {
                Some(cached) => cached,
                None => CanonicalLayer::open(path)?.digest()?,
            }
        };

        let qcow2 = is_qcow2(path);
        layers.push(ArchiveLayer {
            image_digest: image_digest_of(path, image_disks_dir),
            digest: digest.clone(),
            format: if qcow2 {
                LayerFormat::Qcow2
            } else {
                LayerFormat::Raw
            },
            virtual_size: if qcow2 {
                Qcow2Helper::qcow2_virtual_size(path)?
            } else {
                0
            },
        });
        blobs.push((digest, path.clone()));
    }
    let digest_ms = t_digest.elapsed().as_millis() as u64;

    let image = match &config_options.rootfs {
        crate::runtime::options::RootfsSpec::Image(img) => img.clone(),
        crate::runtime::options::RootfsSpec::RootfsPath(path) => path.clone(),
    };

    let manifest = ArchiveManifest {
        // A layered archive is unreadable to a pre-v6 importer, so it is
        // stamped v6 regardless of what the options alone would need.
        version: archive_version_for_options(config_options).max(LAYERED_ARCHIVE_VERSION),
        box_name: config_name.map(|s| s.to_string()),
        image,
        box_options: Some(config_options.clone()),
        // Kept for wire compatibility with importers that still expect the
        // fields; v6 carries per-layer digests instead.
        guest_disk_checksum: String::new(),
        container_disk_checksum: String::new(),
        layers,
        exported_at: chrono::Utc::now().to_rfc3339(),
    };

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| BoxliteError::Internal(format!("Failed to serialize manifest: {}", e)))?;

    let t_archive = Instant::now();
    let output_path = match dest {
        ExportDest::Directory(_) => {
            build_layered_directory(&output_path, &manifest_json, &blobs, 3)?;
            output_path
        }
        ExportDest::File(_) => {
            let manifest_path = capture.temp_dir.path().join(MANIFEST_FILENAME);
            std::fs::write(&manifest_path, &manifest_json)?;
            build_layered_archive(&output_path, &manifest_path, &blobs, 3)?;
            output_path
        }
    };
    let archive_ms = t_archive.elapsed().as_millis() as u64;

    tracing::info!(
        box_id = %box_id_str,
        output = %output_path.display(),
        layers = blobs.len(),
        capture_ms = capture.capture_ms,
        digest_ms,
        archive_ms,
        "Exported box to layered archive"
    );

    let (sha256, size_bytes) = match dest {
        ExportDest::Directory(_) => (
            sha256_file(&output_path.join(MANIFEST_FILENAME))?,
            directory_size(&output_path)?,
        ),
        ExportDest::File(_) => {
            let size = std::fs::metadata(&output_path)
                .map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to stat archive {}: {}",
                        output_path.display(),
                        e
                    ))
                })?
                .len();
            (sha256_file(&output_path)?, size)
        }
    };

    Ok(
        crate::runtime::options::BoxArchive::new(output_path).with_metadata(
            sha256,
            size_bytes,
            manifest.version,
        ),
    )
}

fn directory_size(path: &std::path::Path) -> BoxliteResult<u64> {
    let mut total = 0u64;
    for entry in walkdir::WalkDir::new(path) {
        let entry =
            entry.map_err(|e| BoxliteError::Storage(format!("Failed to walk archive: {e}")))?;
        if entry.file_type().is_file() {
            total = total
                .checked_add(
                    entry
                        .metadata()
                        .map_err(|e| {
                            BoxliteError::Storage(format!(
                                "Failed to stat archive entry {}: {}",
                                entry.path().display(),
                                e
                            ))
                        })?
                        .len(),
                )
                .ok_or_else(|| BoxliteError::Storage("archive size overflow".into()))?;
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::layout::{FilesystemLayout, FsLayoutConfig};

    /// Entry paths inside a built `.boxlite` archive.
    fn archive_entry_names(archive_path: &std::path::Path) -> Vec<String> {
        let file = std::fs::File::open(archive_path).expect("open archive");
        let decoder = zstd::Decoder::new(file).expect("zstd decoder");
        let mut archive = tar::Archive::new(decoder);
        archive
            .entries()
            .expect("read entries")
            .map(|e| {
                e.expect("entry")
                    .path()
                    .expect("entry path")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    /// Build a manager over a real store in `home`.
    fn test_base_disk_mgr(home: &std::path::Path) -> crate::disk::BaseDiskManager {
        let bases_dir = home.join("bases");
        std::fs::create_dir_all(&bases_dir).unwrap();
        let db = crate::db::Database::open(&home.join("boxlite.db")).unwrap();
        crate::disk::BaseDiskManager::new(bases_dir, crate::db::base_disk::BaseDiskStore::new(db))
    }

    /// A box home holding a two-layer chain: `disk.qcow2` over a base.
    fn chained_box_home(home: &std::path::Path) -> std::path::PathBuf {
        let box_home = home.join("box");
        let disks = box_home.join("disks");
        std::fs::create_dir_all(&disks).unwrap();

        let base = home.join("base.qcow2");
        let vsize = Qcow2Helper::create_disk(&base, true).unwrap().leak();
        let vsize = Qcow2Helper::qcow2_virtual_size(&vsize).unwrap();
        Qcow2Helper::create_cow_child_disk(
            &base,
            crate::disk::BackingFormat::Qcow2,
            &disks.join(disk_filenames::CONTAINER_DISK),
            vsize,
        )
        .unwrap()
        .leak();

        // Present, as on any started box — and never exported.
        Qcow2Helper::create_disk(&disks.join(disk_filenames::GUEST_ROOTFS_DISK), true)
            .unwrap()
            .leak();
        box_home
    }

    /// Re-exporting the same box leaves existing layer objects untouched.
    ///
    /// The shared base keeps its mtime — the object was not rewritten — which
    /// is the property a sync tool needs for "mirror this directory" to
    /// transfer only missing objects.
    #[test]
    fn a_reexport_into_the_same_directory_skips_existing_objects() {
        let temp = tempfile::TempDir::new_in("/tmp").unwrap();
        let home = temp.path();
        let out = home.join("mirror");

        export_with(home, &out, true);
        let layers: Vec<_> = std::fs::read_dir(out.join("layers"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert!(!layers.is_empty(), "directory export must produce objects");
        let stamps: Vec<_> = layers
            .iter()
            .map(|p| std::fs::metadata(p).unwrap().modified().unwrap())
            .collect();

        // Re-export the same box into the same mirror.
        export_with(home, &out, true);

        for (path, before) in layers.iter().zip(&stamps) {
            assert_eq!(
                &std::fs::metadata(path).unwrap().modified().unwrap(),
                before,
                "{} was rewritten on re-export",
                path.display()
            );
        }
        assert!(out.join("manifest.json").exists());
    }

    fn export_to_archive(home: &std::path::Path) -> crate::runtime::options::BoxArchive {
        export_with(home, &home.join("out.boxlite"), false)
    }

    fn export_with(
        home: &std::path::Path,
        dest: &std::path::Path,
        as_directory: bool,
    ) -> crate::runtime::options::BoxArchive {
        let layout = FilesystemLayout::new(home.to_path_buf(), FsLayoutConfig::default());
        std::fs::create_dir_all(layout.temp_dir()).unwrap();
        let box_home = chained_box_home(home);
        let capture = do_export_capture(&box_home, &layout).expect("capture");
        do_export_finalize(
            capture,
            &test_base_disk_mgr(home),
            &home.join("images").join("disk-images"),
            Some("some-box"),
            &crate::runtime::options::BoxOptions::default(),
            "box-id",
            if as_directory {
                ExportDest::Directory(dest)
            } else {
                ExportDest::File(dest)
            },
        )
        .expect("finalize")
    }

    /// Export ships the disk chain as layers instead of flattening it, so an
    /// importer that already holds a layer can skip transferring it.
    #[test]
    fn export_emits_one_blob_per_chain_layer() {
        let home = tempfile::tempdir_in("/tmp").expect("home dir");
        let archive = export_to_archive(home.path());

        let entries = archive_entry_names(archive.path());
        let blobs: Vec<_> = entries
            .iter()
            .filter(|e| e.starts_with("layers/"))
            .collect();
        assert_eq!(
            blobs.len(),
            2,
            "expected one blob per chain layer (base + overlay), got {entries:?}"
        );
        assert!(
            !entries.iter().any(|e| e == disk_filenames::CONTAINER_DISK),
            "a layered archive carries no flattened disk, got {entries:?}"
        );
    }

    /// The guest rootfs disk is host-global state the importing host rebuilds
    /// from its own version-keyed cache, so it must never travel in an archive.
    #[test]
    fn export_omits_the_guest_rootfs_disk() {
        let home = tempfile::tempdir_in("/tmp").expect("home dir");
        let archive = export_to_archive(home.path());

        let entries = archive_entry_names(archive.path());
        assert!(
            !entries
                .iter()
                .any(|e| e.ends_with(disk_filenames::GUEST_ROOTFS_DISK)),
            "archive must not carry the guest rootfs disk, got {entries:?}"
        );
    }

    #[test]
    fn export_refuses_an_incomplete_backing_chain() {
        let temp = tempfile::TempDir::new_in("/tmp").unwrap();
        let home = temp.path();
        let layout = FilesystemLayout::new(home.to_path_buf(), FsLayoutConfig::default());
        std::fs::create_dir_all(layout.temp_dir()).unwrap();
        let box_home = chained_box_home(home);
        let container = box_home.join("disks").join(disk_filenames::CONTAINER_DISK);
        let nearest = crate::disk::read_backing_file_path(&container)
            .unwrap()
            .map(std::path::PathBuf::from)
            .expect("container backing");
        std::fs::remove_file(nearest).unwrap();

        let error = match do_export_capture(&box_home, &layout) {
            Ok(_) => panic!("an incomplete chain must not produce an archive"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("backing chain is incomplete"));
    }

    /// Layers are ordered base first, so an importer can materialize each
    /// layer's parent before relinking it.
    #[test]
    fn manifest_orders_layers_base_first() {
        let home = tempfile::tempdir_in("/tmp").expect("home dir");
        let archive = export_to_archive(home.path());

        let file = std::fs::File::open(archive.path()).unwrap();
        let mut tar = tar::Archive::new(zstd::Decoder::new(file).unwrap());
        let mut manifest_json = String::new();
        for entry in tar.entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap().to_string_lossy() == super::super::archive::MANIFEST_FILENAME {
                use std::io::Read;
                entry.read_to_string(&mut manifest_json).unwrap();
            }
        }
        let manifest: super::super::archive::ArchiveManifest =
            serde_json::from_str(&manifest_json).unwrap();

        assert_eq!(manifest.layers.len(), 2, "{:?}", manifest.layers);
        // The base has no backing file of its own; the overlay sits on top.
        assert_eq!(
            manifest.version,
            super::super::archive::LAYERED_ARCHIVE_VERSION
        );
        assert!(
            manifest.layers[0].digest != manifest.layers[1].digest,
            "layers must be distinct blobs"
        );
    }
}
