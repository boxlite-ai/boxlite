//! Box import from `.boxlite` archives.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::disk::constants::filenames as disk_filenames;
use crate::litebox::LiteBox;
use crate::litebox::archive::{
    ArchiveLayer, ArchiveManifest, CanonicalLayer, LayerFormat, MANIFEST_FILENAME,
    MAX_SUPPORTED_VERSION, PUBLISHED_PORTS_ARCHIVE_VERSION, extract_archive, layer_entry_name,
    move_file, sha256_file,
};
use crate::runtime::advanced_options::SecurityOptions;
use crate::runtime::id::BaseDiskID;
use crate::runtime::options::{
    ArchiveImportPolicy, BoxArchive, BoxOptions, RootfsSpec, normalize_legacy_ports,
};
use crate::runtime::rt_impl::RuntimeImpl;
use crate::runtime::types::BoxStatus;

/// Import a box from a `.boxlite` archive.
///
/// Creates a new box with a new ID from archived disk images and
/// configuration. The imported box starts in `Stopped` state.
pub(crate) async fn import_box(
    runtime: &Arc<RuntimeImpl>,
    archive: BoxArchive,
    name: Option<String>,
) -> BoxliteResult<LiteBox> {
    let t0 = std::time::Instant::now();
    let archive_path = archive.path().to_path_buf();
    if !archive_path.exists() {
        return Err(BoxliteError::NotFound(format!(
            "Archive not found: {}",
            archive_path.display()
        )));
    }

    // Phase 1: Extract and validate archive (blocking I/O).
    let layout = runtime.layout.clone();
    let (manifest, temp_dir) =
        tokio::task::spawn_blocking(move || extract_and_validate(&archive_path, &layout))
            .await
            .map_err(|e| {
                BoxliteError::Internal(format!("Import extraction task panicked: {}", e))
            })??;

    let options = options_from_manifest(&manifest, archive.import_policy())?;

    // Phase 2: Validate disks and install into a staging directory (blocking I/O).
    // The staging dir lives inside temp_dir; provision_box will rename it.
    let staging_dir = temp_dir.path().join("staging");
    let temp_path = temp_dir.path().to_path_buf();
    let staging_clone = staging_dir.clone();
    let layers = manifest.layers.clone();
    let base_disk_mgr = runtime.base_disk_mgr.clone();
    let image_disks_dir = runtime.layout.image_layout().disk_images_dir();
    // Layers are pinned to this token the moment each one lands, and the token
    // is only released once the box owns them. Without it a layer sits
    // unreferenced between installation and provisioning, where a concurrent
    // `box rm` would GC it out from under this import — and anything installed
    // before a mid-way failure would leak, since nothing else ever collects a
    // base with no dependents.
    let token = format!("__importing__{}", uuid::Uuid::new_v4());
    let token_for_task = token.clone();
    // The directory form keeps its objects where they are; the scratch dir is
    // only where the ones actually wanted get unpacked.
    let blobs = if archive.path().is_dir() {
        LayerBlobs::directory(archive.path().to_path_buf(), temp_path.clone())
    } else {
        LayerBlobs::Extracted(temp_path.clone())
    };
    let install_task = tokio::task::spawn_blocking(move || {
        if layers.is_empty() {
            install_disks(&temp_path, &staging_clone).map(|()| Vec::new())
        } else {
            install_layers(
                &layers,
                &blobs,
                &staging_clone,
                &base_disk_mgr,
                &token_for_task,
                &image_disks_dir,
            )
        }
    });
    let install = match install_task.await {
        Ok(install) => install,
        Err(e) => {
            release_import_token(&runtime.base_disk_mgr, &token);
            return Err(BoxliteError::Internal(format!(
                "Import install task panicked: {e}"
            )));
        }
    };

    let installed = match install {
        Ok(installed) => installed,
        Err(e) => {
            release_import_token(&runtime.base_disk_mgr, &token);
            return Err(e);
        }
    };

    let litebox = match runtime
        .provision_box(staging_dir, name, options, BoxStatus::Stopped)
        .await
    {
        Ok(litebox) => litebox,
        Err(e) => {
            release_import_token(&runtime.base_disk_mgr, &token);
            return Err(e);
        }
    };

    // Hand ownership to the box before dropping the token, so the layers are
    // never momentarily unreferenced.
    handoff_import_refs(
        &runtime.base_disk_mgr,
        &installed,
        &token,
        litebox.id().as_ref(),
    );

    tracing::info!(
        box_id = %litebox.id(),
        elapsed_ms = t0.elapsed().as_millis() as u64,
        "Imported box from archive"
    );

    Ok(litebox)
}

/// Drop an import's provisional refs and collect anything they were the last
/// reference to.
///
/// After a successful import the box holds its own refs, so this only releases
/// the token. After a failure it is what stops half-installed layers from
/// accumulating in `bases/` forever.
fn handoff_import_refs(
    base_disk_mgr: &crate::disk::BaseDiskManager,
    installed: &[BaseDiskID],
    token: &str,
    box_id: &str,
) {
    for base_id in installed {
        if let Err(e) = base_disk_mgr.store().add_ref(base_id, box_id) {
            tracing::warn!(
                box_id,
                base_disk_id = %base_id,
                error = %e,
                "Failed to record base disk ref; retaining import token refs"
            );
            return;
        }
    }
    release_import_token(base_disk_mgr, token);
}

fn release_import_token(base_disk_mgr: &crate::disk::BaseDiskManager, token: &str) {
    let store = base_disk_mgr.store();
    let released = match store.remove_all_refs_for_box(token) {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!(error = %e, "Failed to release import token refs");
            return;
        }
    };
    for id in released {
        base_disk_mgr.try_gc_base(&id);
    }
}

/// Read the persisted configuration, falling back to the v1/v2 image field.
///
/// An archive is untrusted input, so its options are validated here rather
/// than after disks have been installed and box metadata persisted.
fn options_from_manifest(
    manifest: &ArchiveManifest,
    policy: ArchiveImportPolicy,
) -> BoxliteResult<BoxOptions> {
    let mut options = manifest.box_options.clone().unwrap_or_else(|| BoxOptions {
        rootfs: RootfsSpec::Image(manifest.image.clone()),
        ..Default::default()
    });
    // Up to v4 an archive's ports carried no publication semantics: a null
    // host port meant the guest port, and host_ip and protocol were ignored.
    // Canonicalize before sanitize, so the rewritten mappings are validated.
    if manifest.version < PUBLISHED_PORTS_ARCHIVE_VERSION {
        let changed_mappings = normalize_legacy_ports(&mut options.ports);
        if changed_mappings > 0 {
            tracing::warn!(
                archive_version = manifest.version,
                changed_mappings,
                "Canonicalized legacy archive port mappings"
            );
        }
    }
    options.sanitize().map_err(|error| {
        BoxliteError::InvalidArgument(format!("invalid archive box_options: {error}"))
    })?;

    if policy == ArchiveImportPolicy::Trusted {
        return Ok(options);
    }

    // An upload must not reach into the server's host or pick its own
    // isolation, so refuse everything that would and impose server defaults.
    if options.advanced.kernel.is_some() {
        return Err(rejected_upload("custom kernels"));
    }
    if options.advanced.nested_virtualization {
        return Err(rejected_upload("nested virtualization"));
    }
    if matches!(options.rootfs, RootfsSpec::RootfsPath(_)) {
        return Err(rejected_upload("host rootfs paths"));
    }
    if !options.volumes.is_empty() {
        return Err(rejected_upload("host volume mounts"));
    }
    options.advanced.security = SecurityOptions::default();

    Ok(options)
}

fn rejected_upload(subject: &str) -> BoxliteError {
    BoxliteError::Unsupported(format!(
        "{subject} cannot be requested by an archive uploaded through a REST server"
    ))
}

/// Extract archive, parse manifest, verify checksums.
fn extract_and_validate(
    archive_path: &Path,
    layout: &crate::runtime::layout::FilesystemLayout,
) -> BoxliteResult<(ArchiveManifest, tempfile::TempDir)> {
    let temp_dir = tempfile::tempdir_in(layout.temp_dir())
        .map_err(|e| BoxliteError::Storage(format!("Failed to create temp directory: {}", e)))?;

    // A mirrored archive directory is already in the layout an extraction
    // would produce, except its layers are still compressed and are unpacked
    // one at a time, only if wanted. Copying it here first would throw that
    // away, so only the single-file form is extracted.
    let manifest_path = if archive_path.is_dir() {
        archive_path.join(MANIFEST_FILENAME)
    } else {
        extract_archive(archive_path, temp_dir.path())?;
        temp_dir.path().join(MANIFEST_FILENAME)
    };
    if !manifest_path.exists() {
        return Err(BoxliteError::Storage(
            "Invalid archive: manifest.json not found".to_string(),
        ));
    }

    let manifest_json = std::fs::read_to_string(&manifest_path)?;
    let manifest: ArchiveManifest = serde_json::from_str(&manifest_json)
        .map_err(|e| BoxliteError::Storage(format!("Invalid manifest: {}", e)))?;

    if manifest.version > MAX_SUPPORTED_VERSION {
        return Err(BoxliteError::Storage(format!(
            "Unsupported archive version {} (max supported: {}). Upgrade boxlite.",
            manifest.version, MAX_SUPPORTED_VERSION
        )));
    }

    // A layered archive carries `layers/` blobs instead of a flattened disk;
    // each is checked against its own digest as it is installed.
    if !manifest.layers.is_empty() {
        for layer in &manifest.layers {
            validate_sha256_digest(&layer.digest, "layer")?;
            if let Some(image_digest) = &layer.image_digest {
                validate_sha256_digest(image_digest, "image")?;
            }
        }
        return Ok((manifest, temp_dir));
    }

    let extracted_container = temp_dir.path().join(disk_filenames::CONTAINER_DISK);
    if !extracted_container.exists() {
        return Err(BoxliteError::Storage(format!(
            "Invalid archive: {} not found",
            disk_filenames::CONTAINER_DISK
        )));
    }

    // Verify checksums (v2+ archives have non-empty checksums).
    if !manifest.container_disk_checksum.is_empty() {
        let actual = sha256_file(&extracted_container)?;
        if actual != manifest.container_disk_checksum {
            return Err(BoxliteError::Storage(format!(
                "Container disk checksum mismatch: expected {}, got {}",
                manifest.container_disk_checksum, actual
            )));
        }
    }

    // A guest rootfs disk carried by an older archive is ignored, so it is
    // neither checksummed nor installed — see `install_disks`.

    Ok((manifest, temp_dir))
}

/// Materialize a layered archive's chain and relink it, returning the ids of
/// the base disks the imported box now depends on.
///
/// A layer already present locally — same content digest — is reused as-is and
/// its blob is never written, which is where cross-box dedup comes from: every
/// box built from an image shares that image's layer.
///
/// Security: the manifest carries digests, never paths. Each child is relinked
/// to a path *this* function chose and canonicalized locally, and the resulting
/// header is read back and checked, so a crafted archive cannot aim a backing
/// file at a host path of its choosing. Every blob is verified against its
/// declared digest before anything points at it.
fn install_layers(
    layers: &[ArchiveLayer],
    blobs: &LayerBlobs,
    box_home: &Path,
    base_disk_mgr: &crate::disk::BaseDiskManager,
    token: &str,
    image_disks_dir: &Path,
) -> BoxliteResult<Vec<BaseDiskID>> {
    let Some((top, bases)) = layers.split_last() else {
        return Err(BoxliteError::Storage(
            "Invalid archive: layered manifest has no layers".to_string(),
        ));
    };

    let disks_dir = box_home.join("disks");
    std::fs::create_dir_all(&disks_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create disks directory {}: {}",
            disks_dir.display(),
            e
        ))
    })?;

    // Materialize the bases bottom-up, so each layer's parent already exists
    // by the time it is relinked.
    let mut base_ids = Vec::new();
    let mut parent: Option<PathBuf> = None;
    for layer in bases {
        let (path, id, freshly_installed) = resolve_layer(
            layer,
            blobs,
            base_disk_mgr,
            token,
            parent.as_deref(),
            image_disks_dir,
        )?;
        if let Some(id) = id {
            base_ids.push(id);
        }
        if freshly_installed {
            match &parent {
                Some(parent_path) => relink(&path, parent_path)?,
                // The deepest layer stands alone. Without this an archive
                // could ship a base whose header already points at any host
                // path — the chain is granted to the sandbox at start, so that
                // would hand the guest an arbitrary file.
                None => validate_no_backing_references(&path)?,
            }
        }
        parent = Some(path);
    }

    // The top layer is the box's own container disk.
    let container = disks_dir.join(disk_filenames::CONTAINER_DISK);
    let blob = blobs.materialize(top)?;
    verify_layer_digest(&blob, &top.digest)?;
    verify_layer_format(&blob, top)?;
    move_file(&blob, &container)?;

    match &parent {
        Some(parent_path) => relink(&container, parent_path)?,
        // A single-layer chain stands alone, so it must not reference anything.
        None => validate_no_backing_references(&container)?,
    }

    Ok(base_ids)
}

/// Where a layer's bytes come from while an archive is being installed.
///
/// The two forms differ in *when* a blob costs anything. A `.boxlite` file is
/// one stream, so every layer is already unpacked by the time anything is
/// decided. A mirrored directory holds each layer as its own object, so a
/// layer the host already has is never opened — which is the only reason the
/// directory form saves work rather than just rearranging it.
enum LayerBlobs {
    Extracted(PathBuf),
    Directory {
        archive_dir: PathBuf,
        scratch: PathBuf,
        remaining_output: Cell<u64>,
    },
}

impl LayerBlobs {
    fn directory(archive_dir: PathBuf, scratch: PathBuf) -> Self {
        Self::directory_with_limit(
            archive_dir,
            scratch,
            crate::litebox::archive::MAX_ARCHIVE_OUTPUT,
        )
    }

    fn directory_with_limit(archive_dir: PathBuf, scratch: PathBuf, limit: u64) -> Self {
        Self::Directory {
            archive_dir,
            scratch,
            remaining_output: Cell::new(limit),
        }
    }

    /// Produce a path to this layer's bytes, unpacking it only if needed.
    fn materialize(&self, layer: &ArchiveLayer) -> BoxliteResult<PathBuf> {
        validate_sha256_digest(&layer.digest, "layer")?;
        match self {
            Self::Extracted(dir) => Ok(dir.join(layer_entry_name(&layer.digest))),
            Self::Directory {
                archive_dir,
                scratch,
                remaining_output,
            } => {
                let dest = scratch.join(layer_entry_name(&layer.digest));
                if !dest.exists() {
                    let written = crate::litebox::archive::extract_layer_object(
                        archive_dir,
                        &layer.digest,
                        &dest,
                        layer.virtual_size,
                        remaining_output.get(),
                    )?;
                    remaining_output.set(remaining_output.get().saturating_sub(written));
                }
                Ok(dest)
            }
        }
    }
}

fn validate_sha256_digest<'a>(digest: &'a str, kind: &str) -> BoxliteResult<&'a str> {
    digest
        .strip_prefix("sha256:")
        .filter(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            BoxliteError::Storage(format!("Invalid archive: malformed {kind} digest {digest}"))
        })
}

/// Fail unless a blob hashes to the digest the manifest declared for it.
fn verify_layer_digest(path: &Path, digest: &str) -> BoxliteResult<()> {
    if !path.exists() {
        return Err(BoxliteError::Storage(format!(
            "Invalid archive: layer {digest} is missing from the archive"
        )));
    }
    // Compare canonical forms: a shipped blob has its backing pointer zeroed,
    // and so does the digest that names it.
    let actual = CanonicalLayer::open(path)?.digest()?;
    if actual != digest {
        return Err(BoxliteError::Storage(format!(
            "Layer digest mismatch: expected {digest}, got {actual}"
        )));
    }
    Ok(())
}

/// Fail unless a blob's on-disk format is the one the manifest declared.
///
/// Only the deepest layer may be raw; anything above it must be qcow2 to carry
/// a backing pointer at all. Checking here keeps a mislabelled layer from
/// reaching `relink`, whose failure would be reported as a rebase error rather
/// than as the malformed archive it is.
fn verify_layer_format(path: &Path, layer: &ArchiveLayer) -> BoxliteResult<()> {
    let is_qcow2 = qcow2_magic(path);
    let declared_qcow2 = layer.format == LayerFormat::Qcow2;
    if is_qcow2 != declared_qcow2 {
        return Err(BoxliteError::Storage(format!(
            "Layer {} declares format {:?} but its blob is {}",
            layer.digest,
            layer.format,
            if is_qcow2 { "qcow2" } else { "raw" }
        )));
    }
    Ok(())
}

fn qcow2_magic(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).is_ok() && u32::from_be_bytes(magic) == 0x5146_49fb
}

/// Return where a layer lives locally, installing it if this host lacks it.
///
/// A local layer is reused only when its chain already matches the one the
/// archive describes — that is, its backing file is exactly `parent`. A layer's
/// digest names its canonical form, which says nothing about which parent it
/// sits on, so the same layer can legitimately exist over different parents.
/// Relinking a reused base to satisfy this archive would rewrite a file other
/// boxes and snapshots are actively backed by, silently re-pointing them at
/// content this archive supplied; installing a private copy instead costs
/// space but cannot corrupt anything.
///
/// The returned id is `Some` only when a base disk record exists to reference,
/// which is what keeps a newly installed layer from being garbage-collected.
/// The bool reports whether the file was freshly installed, and so is safe for
/// the caller to relink.
fn resolve_layer(
    layer: &ArchiveLayer,
    blobs: &LayerBlobs,
    base_disk_mgr: &crate::disk::BaseDiskManager,
    token: &str,
    parent: Option<&Path>,
    image_disks_dir: &Path,
) -> BoxliteResult<(PathBuf, Option<BaseDiskID>, bool)> {
    validate_sha256_digest(&layer.digest, "layer")?;

    // An image disk this host already built is preferred over the archived
    // copy, and is the only cross-host reuse available for that layer: its
    // bytes differ on every host (mke2fs writes a random UUID), so `digest`
    // cannot match, but the image digest can. Reusing it also keeps the box on
    // the host's own correctly-built disk rather than a foreign one.
    //
    // No base disk id is returned because the image cache owns this file and
    // manages its own lifecycle — it must not be pulled into base-disk GC.
    if let Some(image_digest) = &layer.image_digest {
        let hex = validate_sha256_digest(image_digest, "image")?;
        let local = image_disks_dir.join(format!("sha256-{hex}.ext4"));
        if local.is_file() {
            tracing::debug!(
                image_digest = %image_digest,
                "Image disk already built locally, skipping the archived copy"
            );
            return Ok((local, None, false));
        }
    }

    // Keep lookup/install and the provisional ref pin indivisible with GC.
    // Otherwise GC can observe a zero-ref record between the lookup and pin,
    // then delete the file while this import is adopting it.
    let lifecycle = base_disk_mgr.lock_lifecycle();
    if let Some(existing) = base_disk_mgr.store().find_by_digest(&layer.digest)? {
        let path = PathBuf::from(&existing.disk.disk_info.base_path);
        if path.exists() && backing_matches(&path, parent) {
            base_disk_mgr.store().add_ref(&existing.disk.id, token)?;
            tracing::debug!(digest = %layer.digest, "Layer already present, skipping transfer");
            return Ok((path, Some(existing.disk.id), false));
        }
        // Either the record outlived its file, or the local copy sits on a
        // different parent; install a private copy below.
    }

    let blob = blobs.materialize(layer)?;
    verify_layer_digest(&blob, &layer.digest)?;
    verify_layer_format(&blob, layer)?;
    let installed = base_disk_mgr.install_layer(&blob, &layer.digest)?;
    if let Err(error) = base_disk_mgr.store().add_ref(&installed.id, token) {
        drop(lifecycle);
        base_disk_mgr.try_gc_base(&installed.id);
        return Err(error);
    }
    Ok((installed.disk_info.to_path_buf(), Some(installed.id), true))
}

/// Whether `path`'s backing file is already exactly `parent`.
fn backing_matches(path: &Path, parent: Option<&Path>) -> bool {
    let actual = crate::disk::read_backing_file_path(path)
        .ok()
        .flatten()
        .map(PathBuf::from);
    match (actual, parent) {
        (None, None) => true,
        (Some(actual), Some(parent)) => {
            let expected = parent
                .canonicalize()
                .unwrap_or_else(|_| parent.to_path_buf());
            actual == expected
        }
        _ => false,
    }
}

/// Point a child qcow2 at a parent path chosen by this host, then prove it took.
fn relink(child: &Path, parent: &Path) -> BoxliteResult<()> {
    crate::disk::set_backing_file_path(child, parent)?;

    let expected = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf());
    match crate::disk::read_backing_file_path(child)? {
        Some(actual) if Path::new(&actual) == expected => Ok(()),
        other => Err(BoxliteError::InvalidState(format!(
            "Refusing imported disk '{}': backing file is {:?} after relink, expected {}",
            child.display(),
            other,
            expected.display()
        ))),
    }
}

/// Validate disk security and move the container disk into box_home/disks/.
///
/// The guest rootfs disk is never installed, even when an older archive carries
/// one. It holds no user state, and letting an archived copy win would bypass
/// the importing host's own version-keyed guest rootfs cache: export flattens
/// the overlay, so the archived disk has no backing reference and
/// `validate_reusable_guest_rootfs_disk` would accept it verbatim. Leaving it
/// absent makes the next start rebuild the overlay from the local cache, which
/// is what clone and snapshot-restore already do.
fn install_disks(temp_dir: &Path, box_home: &Path) -> BoxliteResult<()> {
    // Security: Reject imported disks that reference backing files.
    // A crafted archive could include a qcow2 with a backing reference to
    // /etc/shadow or another box's disk, leaking data on first read.
    let extracted_container = temp_dir.join(disk_filenames::CONTAINER_DISK);
    validate_no_backing_references(&extracted_container)?;

    let disks_dir = box_home.join("disks");
    std::fs::create_dir_all(&disks_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create disks directory {}: {}",
            disks_dir.display(),
            e
        ))
    })?;

    move_file(
        &extracted_container,
        &disks_dir.join(disk_filenames::CONTAINER_DISK),
    )?;

    Ok(())
}

/// Reject qcow2 disks with backing file references (security check).
pub(crate) fn validate_no_backing_references(disk_path: &Path) -> BoxliteResult<()> {
    if let Ok(Some(backing)) = crate::disk::read_backing_file_path(disk_path) {
        return Err(BoxliteError::InvalidState(format!(
            "Imported disk '{}' has backing file reference '{}'. \
             This is not allowed for security reasons.",
            disk_path.display(),
            backing
        )));
    }
    Ok(())
}

#[cfg(test)]
#[cfg(test)]
mod layered_install_tests {
    use super::*;
    use crate::litebox::archive::CanonicalLayer;

    fn mgr(home: &Path) -> crate::disk::BaseDiskManager {
        let bases = home.join("bases");
        std::fs::create_dir_all(&bases).unwrap();
        let db = crate::db::Database::open(&home.join("boxlite.db")).unwrap();
        crate::disk::BaseDiskManager::new(bases, crate::db::base_disk::BaseDiskStore::new(db))
    }

    /// Write a blob into the extracted-archive layout and describe it.
    ///
    /// `tag` makes each layer's content unique, so distinct layers get distinct
    /// digests. A layer that will be relinked must be staged with some backing
    /// path — `set_backing_file_path` can only rewrite a pointer that exists,
    /// which is also true of the real layers this stands in for: every layer
    /// above the image disk is a COW child.
    fn stage(temp: &Path, tag: u8, backing: Option<&str>) -> ArchiveLayer {
        let scratch = temp.join("scratch.qcow2");
        crate::disk::qcow2::write_test_qcow2(&scratch, backing);
        // Perturb a byte outside the header and the backing-path region so the
        // canonical digests differ per layer.
        let mut bytes = std::fs::read(&scratch).unwrap();
        bytes[900] = tag;
        std::fs::write(&scratch, &bytes).unwrap();

        let digest = CanonicalLayer::open(&scratch).unwrap().digest().unwrap();
        let layer = ArchiveLayer {
            image_digest: None,
            digest: digest.clone(),
            format: LayerFormat::Qcow2,
            virtual_size: 0,
        };
        let dest = temp.join(layer_entry_name(&digest));
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::rename(&scratch, &dest).unwrap();
        layer
    }

    #[test]
    fn a_failed_box_ref_keeps_the_import_token_refs() {
        let home = tempfile::TempDir::new_in("/tmp").unwrap();
        let temp = home.path().join("extract");
        std::fs::create_dir_all(&temp).unwrap();
        let mgr = mgr(home.path());
        let bottom = stage(&temp, 1, None);
        let top = stage(&temp, 2, Some(FOREIGN_PARENT));
        let installed = install_layers(
            &[bottom, top],
            &LayerBlobs::Extracted(temp),
            &home.path().join("box"),
            &mgr,
            "import-token",
            &home.path().join("images"),
        )
        .expect("install");
        assert!(!installed.is_empty(), "the bottom layer must be installed");

        let conn = rusqlite::Connection::open(home.path().join("boxlite.db")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_box_ref
             BEFORE INSERT ON base_disk_ref
             WHEN NEW.box_id = 'box-id'
             BEGIN
               SELECT RAISE(FAIL, 'forced add_ref failure');
             END;",
        )
        .unwrap();
        drop(conn);

        handoff_import_refs(&mgr, &installed, "import-token", "box-id");

        for id in installed {
            let dependents = mgr.store().dependent_boxes(&id).unwrap();
            assert!(dependents.contains(&"import-token".to_string()));
            assert!(!dependents.contains(&"box-id".to_string()));
        }
    }

    #[test]
    fn a_failed_import_token_ref_collects_the_installed_layer() {
        let home = tempfile::TempDir::new_in("/tmp").unwrap();
        let temp = home.path().join("extract");
        std::fs::create_dir_all(&temp).unwrap();
        let mgr = mgr(home.path());
        let bottom = stage(&temp, 1, None);
        let digest = bottom.digest.clone();

        let conn = rusqlite::Connection::open(home.path().join("boxlite.db")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_import_ref
             BEFORE INSERT ON base_disk_ref
             WHEN NEW.box_id = 'import-token'
             BEGIN
               SELECT RAISE(FAIL, 'forced add_ref failure');
             END;",
        )
        .unwrap();
        drop(conn);

        install_layers(
            &[bottom, stage(&temp, 2, Some(FOREIGN_PARENT))],
            &LayerBlobs::Extracted(temp),
            &home.path().join("box"),
            &mgr,
            "import-token",
            &home.path().join("images"),
        )
        .expect_err("the forced token ref failure must abort the import");

        assert!(
            mgr.store().find_by_digest(&digest).unwrap().is_none(),
            "the unreferenced layer record must be collected"
        );
    }

    /// A directory archive's objects are opened only when actually wanted.
    ///
    /// The host already holds the bottom layer, so its object in the mirror is
    /// replaced with garbage that would fail digest verification the moment
    /// anything read it. The import must succeed anyway — proof the object was
    /// never opened, which is what makes the directory form cheaper than the
    /// single file rather than just differently shaped.
    #[test]
    fn a_layer_the_host_already_holds_is_never_read_from_the_directory() {
        let home = tempfile::TempDir::new_in("/tmp").unwrap();
        let temp = home.path().join("extract");
        std::fs::create_dir_all(&temp).unwrap();
        let mgr = mgr(home.path());

        // First import, single-file form: installs both layers locally.
        let bottom = stage(&temp, 1, None);
        let top = stage(&temp, 2, Some(FOREIGN_PARENT));
        // Read before the first install consumes the blob by moving it.
        let top_blob = std::fs::read(temp.join(layer_entry_name(&top.digest))).unwrap();
        install_layers(
            &[bottom.clone(), top.clone()],
            &LayerBlobs::Extracted(temp.clone()),
            &home.path().join("box1"),
            &mgr,
            "tok1",
            &home.path().join("images"),
        )
        .expect("first import");

        // Second import of the same box, directory form. The bottom's object
        // is garbage; the top's object is real (a top layer is always fresh).
        let mirror = home.path().join("mirror");
        let layers_dir = mirror.join("layers");
        std::fs::create_dir_all(&layers_dir).unwrap();
        let hex = |d: &str| d.strip_prefix("sha256:").unwrap().to_string();
        std::fs::write(
            layers_dir.join(format!("{}.zst", hex(&bottom.digest))),
            b"not zstd, not the layer, not anything",
        )
        .unwrap();
        std::fs::write(
            layers_dir.join(format!("{}.zst", hex(&top.digest))),
            zstd::encode_all(&top_blob[..], 3).unwrap(),
        )
        .unwrap();

        let scratch = home.path().join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        install_layers(
            &[bottom, top],
            &LayerBlobs::directory(mirror, scratch),
            &home.path().join("box2"),
            &mgr,
            "tok2",
            &home.path().join("images"),
        )
        .expect("a held layer's garbage object must never be read");
    }

    /// The image layer's bytes differ on every host, so content addressing can
    /// never reuse it. Its image digest can — and the host's own build is the
    /// one the box should sit on.
    #[test]
    fn a_locally_built_image_disk_is_used_instead_of_the_archived_one() {
        let home = tempfile::TempDir::new_in("/tmp").unwrap();
        let temp = home.path().join("extract");
        std::fs::create_dir_all(&temp).unwrap();
        let images = home.path().join("images");
        std::fs::create_dir_all(&images).unwrap();

        // This host already built the image disk.
        let image_digest = format!("sha256:{}", "f".repeat(64));
        let local = images.join(format!("sha256-{}.ext4", "f".repeat(64)));
        std::fs::write(&local, b"the host's own build").unwrap();

        // The archive carries its own, byte-different copy of that layer.
        let mut bottom = stage(&temp, 1, None);
        bottom.image_digest = Some(image_digest);
        let archived_blob = temp.join(layer_entry_name(&bottom.digest));
        let top = stage(&temp, 2, Some(FOREIGN_PARENT));

        install_layers(
            &[bottom, top],
            &LayerBlobs::Extracted(temp.clone()),
            &home.path().join("box"),
            &mgr(home.path()),
            "tok",
            &images,
        )
        .expect("import");

        // The archived blob is still sitting in the extract dir: nothing
        // consumed it, because the local image disk won.
        assert!(
            archived_blob.exists(),
            "the archived image layer must be left untouched"
        );
        assert_eq!(
            std::fs::read(&local).unwrap(),
            b"the host's own build",
            "the local image disk must not be overwritten"
        );
        // And the box's disk is chained onto that local copy.
        let container = home.path().join("box").join("disks").join("disk.qcow2");
        assert_eq!(
            crate::disk::read_backing_file_path(&container)
                .unwrap()
                .map(PathBuf::from),
            Some(local.canonicalize().unwrap()),
            "the imported box must read through the host's own image disk"
        );
    }

    #[test]
    fn a_malformed_image_digest_cannot_escape_the_image_cache() {
        let home = tempfile::TempDir::new_in("/tmp").unwrap();
        let temp = home.path().join("extract");
        std::fs::create_dir_all(&temp).unwrap();
        let images = home.path().join("images");
        std::fs::create_dir_all(&images).unwrap();

        let mut bottom = stage(&temp, 1, None);
        bottom.image_digest = Some("sha256:../../bases/victim".to_string());
        let top = stage(&temp, 2, Some(FOREIGN_PARENT));

        let error = install_layers(
            &[bottom, top],
            &LayerBlobs::Extracted(temp),
            &home.path().join("box"),
            &mgr(home.path()),
            "tok",
            &images,
        )
        .expect_err("manifest paths must not escape the image cache");

        assert!(
            error.to_string().contains("malformed image digest"),
            "got: {error}"
        );
    }

    #[test]
    fn a_malformed_layer_digest_cannot_escape_the_scratch_directory() {
        let home = tempfile::TempDir::new_in("/tmp").unwrap();
        let archive_dir = home.path().join("archive");
        let scratch = home.path().join("scratch");
        std::fs::create_dir_all(&archive_dir).unwrap();
        std::fs::create_dir_all(&scratch).unwrap();
        let escaped = home.path().join("escaped");
        let layer = ArchiveLayer {
            digest: "sha256:../../escaped".to_string(),
            format: LayerFormat::Raw,
            virtual_size: 1,
            image_digest: None,
        };

        let error = LayerBlobs::directory(archive_dir, scratch)
            .materialize(&layer)
            .expect_err("a malformed digest must be rejected before filesystem access");

        assert!(error.to_string().contains("malformed layer digest"));
        assert!(!escaped.exists(), "validation must happen before any write");
    }

    #[test]
    fn directory_layers_share_one_decompression_budget() {
        let home = tempfile::TempDir::new_in("/tmp").unwrap();
        let archive_dir = home.path().join("archive");
        let scratch = home.path().join("scratch");
        std::fs::create_dir_all(archive_dir.join("layers")).unwrap();
        std::fs::create_dir_all(&scratch).unwrap();
        let make_layer = |byte: u8| {
            let digest = format!("sha256:{}", format!("{byte:02x}").repeat(32));
            let object = archive_dir.join(format!("{}.zst", layer_entry_name(&digest)));
            std::fs::write(object, zstd::encode_all(&[byte; 4][..], 3).unwrap()).unwrap();
            ArchiveLayer {
                digest,
                format: LayerFormat::Raw,
                virtual_size: 0,
                image_digest: None,
            }
        };
        let first = make_layer(1);
        let second = make_layer(2);
        let blobs = LayerBlobs::directory_with_limit(archive_dir, scratch.clone(), 6);

        blobs.materialize(&first).expect("first layer fits");
        let error = blobs
            .materialize(&second)
            .expect_err("all directory layers must share the aggregate limit");

        assert!(error.to_string().contains("decompression limit"));
        assert!(
            !scratch.join(layer_entry_name(&second.digest)).exists(),
            "a layer rejected by the aggregate limit must not remain"
        );
    }

    /// A stand-in for the exporter's local backing path, which import must
    /// replace with one of its own choosing.
    const FOREIGN_PARENT: &str = "/exporter/bases/whatever.qcow2";

    /// The deepest layer's backing pointer is attacker-controlled data. The
    /// chain is granted to the sandbox at start, so honouring it would hand the
    /// guest an arbitrary host file.
    #[test]
    fn a_bottom_layer_pointing_at_a_host_path_is_refused() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let temp = home.path().join("extracted");
        std::fs::create_dir_all(&temp).unwrap();

        let evil = stage(&temp, 1, Some("/etc/shadow"));
        let top = stage(&temp, 2, Some(FOREIGN_PARENT));

        let err = install_layers(
            &[evil, top],
            &LayerBlobs::Extracted(temp.clone()),
            &home.path().join("box"),
            &mgr(home.path()),
            "tok",
            &temp.join("images"),
        )
        .expect_err("a bottom layer with a backing reference must be refused");
        let msg = err.to_string();
        assert!(msg.contains("backing file reference"), "got: {msg}");
        assert!(msg.contains("/etc/shadow"), "got: {msg}");
    }

    /// A layer already held locally may sit on a different parent than this
    /// archive describes. Relinking it would rewrite a file other boxes are
    /// backed by, re-pointing them at content this archive supplied.
    #[test]
    fn a_reused_layer_on_a_different_parent_is_copied_not_rewritten() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let temp = home.path().join("extracted");
        std::fs::create_dir_all(&temp).unwrap();
        let mgr = mgr(home.path());

        // A shared base already installed locally, backed by nothing.
        let shared = stage(&temp, 1, Some(FOREIGN_PARENT));
        let shared_blob = temp.join(layer_entry_name(&shared.digest));
        let victim_copy = temp.join("victim-source.qcow2");
        std::fs::copy(&shared_blob, &victim_copy).unwrap();
        let installed = mgr.install_layer(&victim_copy, &shared.digest).unwrap();
        let victim_path = installed.disk_info.to_path_buf();
        let victim_before = std::fs::read(&victim_path).unwrap();

        // An archive that puts that same layer on top of a new parent.
        let new_parent = stage(&temp, 2, None);
        let top = stage(&temp, 3, Some(FOREIGN_PARENT));
        install_layers(
            &[new_parent, shared, top],
            &LayerBlobs::Extracted(temp.clone()),
            &home.path().join("box"),
            &mgr,
            "tok",
            &temp.join("images"),
        )
        .expect("import should succeed by copying, not by rewriting");

        assert_eq!(
            std::fs::read(&victim_path).unwrap(),
            victim_before,
            "the pre-existing shared base must not be modified"
        );
    }

    /// A digest names the canonical form, so relinking an installed layer must
    /// not invalidate it — otherwise re-exporting an imported box yields an
    /// archive no other host can read.
    #[test]
    fn a_relinked_layer_still_matches_its_recorded_digest() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let temp = home.path().join("extracted");
        std::fs::create_dir_all(&temp).unwrap();
        let mgr = mgr(home.path());

        let bottom = stage(&temp, 1, None);
        let middle = stage(&temp, 2, Some(FOREIGN_PARENT));
        let middle_digest = middle.digest.clone();
        let top = stage(&temp, 3, Some(FOREIGN_PARENT));

        install_layers(
            &[bottom, middle, top],
            &LayerBlobs::Extracted(temp.clone()),
            &home.path().join("box"),
            &mgr,
            "tok",
            &temp.join("images"),
        )
        .expect("install");

        // The middle layer was relinked onto the bottom one; its canonical
        // digest must be unchanged.
        let record = mgr
            .store()
            .find_by_digest(&middle_digest)
            .unwrap()
            .expect("middle layer recorded under its digest");
        let on_disk = CanonicalLayer::open(&record.disk.disk_info.to_path_buf())
            .unwrap()
            .digest()
            .unwrap();
        assert_eq!(
            on_disk, middle_digest,
            "canonical digest must survive relinking"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn v3_manifest(options: BoxOptions) -> ArchiveManifest {
        ArchiveManifest {
            version: 3,
            box_name: None,
            image: "alpine:latest".to_string(),
            box_options: Some(options),
            guest_disk_checksum: String::new(),
            container_disk_checksum: String::new(),
            layers: Vec::new(),
            exported_at: "2026-07-26T00:00:00Z".to_string(),
        }
    }

    fn loopback_port() -> crate::runtime::options::PortSpec {
        crate::runtime::options::PortSpec {
            host_port: Some(18080),
            guest_port: 80,
            protocol: crate::runtime::options::PortProtocol::Tcp,
            host_ip: Some("127.0.0.1".to_string()),
        }
    }

    /// The importer's canonicalization window is the other half of the archive
    /// version contract: below v5 a mapping predates publication semantics and
    /// must be rewritten, at v5 it carries them and must be left exactly alone.
    /// A window that swallowed v5 would clear `host_ip` and turn a loopback
    /// publication into one on every interface.
    #[test]
    fn canonicalization_window_stops_at_the_published_ports_version() {
        let options = BoxOptions {
            ports: vec![loopback_port()],
            ..Default::default()
        };

        let mut legacy = v3_manifest(options.clone());
        legacy.version = PUBLISHED_PORTS_ARCHIVE_VERSION - 1;
        let rewritten = options_from_manifest(&legacy, ArchiveImportPolicy::Trusted).unwrap();
        assert_eq!(
            rewritten.ports[0].host_ip, None,
            "a pre-publication archive never meant its bind IP"
        );

        let mut current = v3_manifest(options.clone());
        current.version = PUBLISHED_PORTS_ARCHIVE_VERSION;
        let preserved = options_from_manifest(&current, ArchiveImportPolicy::Trusted).unwrap();
        assert_eq!(
            preserved.ports, options.ports,
            "a v5 archive carries publication semantics and must survive import intact"
        );
    }

    #[test]
    fn untrusted_import_rejects_nested_virtualization() {
        let options = BoxOptions {
            advanced: crate::runtime::advanced_options::AdvancedBoxOptions {
                nested_virtualization: true,
                ..Default::default()
            },
            ..Default::default()
        };

        let error =
            options_from_manifest(&v3_manifest(options), ArchiveImportPolicy::UntrustedRemote)
                .unwrap_err();

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(error.to_string().contains("nested virtualization"));
    }

    #[test]
    fn untrusted_import_rejects_custom_kernel() {
        // A real file, so `sanitize()` passes and the upload policy — not path
        // validation — is what rejects the archive.
        let kernel = tempfile::NamedTempFile::new().unwrap();
        let mut options = BoxOptions::default();
        options.advanced.kernel = Some(crate::experimental::custom_kernel::KernelOptions::new(
            kernel.path(),
        ));

        let error =
            options_from_manifest(&v3_manifest(options), ArchiveImportPolicy::UntrustedRemote)
                .unwrap_err();

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(error.to_string().contains("custom kernels"));
    }

    #[test]
    fn untrusted_import_rejects_host_volumes() {
        let mut options = BoxOptions::default();
        options.volumes.push(crate::runtime::options::VolumeSpec {
            host_path: "/".to_string(),
            guest_path: "/host".to_string(),
            read_only: false,
        });

        let error =
            options_from_manifest(&v3_manifest(options), ArchiveImportPolicy::UntrustedRemote)
                .expect_err("untrusted archives must not select server host paths");

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(error.to_string().contains("host volume mounts"));
    }

    #[test]
    fn untrusted_import_rejects_host_rootfs_paths() {
        let options = BoxOptions {
            rootfs: RootfsSpec::RootfsPath("/".to_string()),
            ..Default::default()
        };

        let error =
            options_from_manifest(&v3_manifest(options), ArchiveImportPolicy::UntrustedRemote)
                .expect_err("untrusted archives must not select a server rootfs path");

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(error.to_string().contains("host rootfs paths"));
    }

    #[test]
    fn untrusted_import_replaces_archive_security_with_server_default() {
        let mut options = BoxOptions::default();
        options.advanced.security = SecurityOptions::disabled();

        let resolved =
            options_from_manifest(&v3_manifest(options), ArchiveImportPolicy::UntrustedRemote)
                .unwrap();

        assert_eq!(resolved.advanced.security, SecurityOptions::default());
    }

    #[test]
    fn trusted_import_preserves_archive_configuration() {
        let mut options = BoxOptions {
            advanced: crate::runtime::advanced_options::AdvancedBoxOptions {
                nested_virtualization: true,
                ..Default::default()
            },
            ..Default::default()
        };
        options.advanced.security = SecurityOptions::disabled();

        let resolved =
            options_from_manifest(&v3_manifest(options), ArchiveImportPolicy::Trusted).unwrap();

        assert!(resolved.advanced.nested_virtualization);
        assert_eq!(resolved.advanced.security, SecurityOptions::disabled());
    }

    #[test]
    fn imported_capability_policy_is_validated_before_install() {
        let manifest = ArchiveManifest {
            version: 3,
            box_name: Some("untrusted".into()),
            image: "alpine:latest".into(),
            box_options: Some(BoxOptions {
                advanced: crate::runtime::advanced_options::AdvancedBoxOptions {
                    capabilities: crate::runtime::advanced_options::ContainerCapabilities {
                        drop: vec!["NET-ADMIN".into()],
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            }),
            guest_disk_checksum: String::new(),
            container_disk_checksum: String::new(),
            layers: Vec::new(),
            exported_at: "2026-01-01T00:00:00Z".into(),
        };

        let error = options_from_manifest(&manifest, ArchiveImportPolicy::Trusted)
            .expect_err("malformed archived capability policy must be rejected");
        assert!(matches!(error, BoxliteError::InvalidArgument(_)));
        assert!(error.to_string().contains("NET-ADMIN"));
    }

    #[test]
    fn test_validate_no_backing_references_rejects_absolute() {
        let dir = TempDir::new_in("/tmp").unwrap();
        let disk = dir.path().join("evil.qcow2");
        crate::disk::qcow2::write_test_qcow2(&disk, Some("/etc/shadow"));

        let result = validate_no_backing_references(&disk);
        assert!(result.is_err());
        let msg = format!("{}", result.unwrap_err());
        assert!(msg.contains("backing file reference"), "Got: {msg}");
        assert!(msg.contains("/etc/shadow"), "Got: {msg}");
    }

    #[test]
    fn test_validate_no_backing_references_rejects_relative() {
        let dir = TempDir::new_in("/tmp").unwrap();
        let disk = dir.path().join("evil.qcow2");
        crate::disk::qcow2::write_test_qcow2(&disk, Some("../../other/disk.qcow2"));

        let result = validate_no_backing_references(&disk);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_no_backing_references_accepts_standalone() {
        let dir = TempDir::new_in("/tmp").unwrap();
        let disk = dir.path().join("clean.qcow2");
        crate::disk::qcow2::write_test_qcow2(&disk, None);

        let result = validate_no_backing_references(&disk);
        assert!(result.is_ok());
    }
}
