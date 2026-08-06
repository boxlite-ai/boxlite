//! Archive operations for box export and import.
//!
//! Handles `.boxlite` archive files: zstd-compressed tarballs containing
//! disk images and a JSON manifest.

use std::path::Path;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Manifest filename inside the archive.
pub(crate) const MANIFEST_FILENAME: &str = "manifest.json";

/// Archive format version for configurations a v3 importer reads correctly.
pub(crate) const ARCHIVE_VERSION: u32 = 3;

/// First archive version that carries a custom Linux capability policy.
///
/// A pre-capability importer accepts up to v3 and would silently drop
/// `advanced.capabilities`, starting the box with wider privileges than the
/// archive asked for. Stamping v4 makes that importer refuse the archive.
pub(crate) const CAPABILITY_POLICY_ARCHIVE_VERSION: u32 = 4;

/// First archive version whose `ports` carry publication semantics.
///
/// Up to v4 an importer reused the guest port for a null `host_port` and
/// ignored `host_ip` and `protocol` entirely. It would read a v5 mapping under
/// those rules and bind the wrong port, or bind every interface where the
/// archive asked for one — so any archive that carries ports at all is stamped
/// v5, and the importer canonicalizes anything below it.
pub(crate) const PUBLISHED_PORTS_ARCHIVE_VERSION: u32 = 5;

/// First archive version that carries the box's disk as a layer chain.
///
/// Up to v5 an archive held one flattened `disk.qcow2`. A v6 archive holds
/// `layers/` blobs plus the order to relink them in, which an older importer
/// cannot reassemble — it would find no container disk at all — so stamping v6
/// makes it refuse the archive rather than fail obscurely.
pub(crate) const LAYERED_ARCHIVE_VERSION: u32 = 6;

/// Maximum archive version this build can import.
pub(crate) const MAX_SUPPORTED_VERSION: u32 = LAYERED_ARCHIVE_VERSION;

/// Directory holding layer blobs inside a layered archive.
pub(crate) const LAYERS_DIR: &str = "layers";

/// Tar entry name for a layer blob, derived from its digest.
///
/// The `sha256:` prefix is dropped so the name stays a plain path component.
pub(crate) fn layer_entry_name(digest: &str) -> String {
    let hex = digest.strip_prefix("sha256:").unwrap_or(digest);
    format!("{LAYERS_DIR}/{hex}")
}

/// Pick the archive format an exported box needs.
pub(crate) fn archive_version_for_options(options: &crate::runtime::options::BoxOptions) -> u32 {
    if !options.ports.is_empty() {
        PUBLISHED_PORTS_ARCHIVE_VERSION
    } else if options.advanced.capabilities.is_empty() {
        ARCHIVE_VERSION
    } else {
        CAPABILITY_POLICY_ARCHIVE_VERSION
    }
}

/// Format of a layer blob, which decides how its child references it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayerFormat {
    Qcow2,
    /// A raw image, only ever the bottom of a chain (the image disk).
    Raw,
}

/// One layer of a box's disk chain, addressed by content.
///
/// Carries no path: an importer resolves a layer against its own store and
/// picks where it lands, so nothing an archive says can point a backing file
/// at a host path of the archive's choosing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveLayer {
    /// `sha256:<hex>` of the layer blob.
    pub digest: String,
    /// Format of this layer's blob.
    pub format: LayerFormat,
    /// Virtual size in bytes (qcow2 layers only; 0 for raw).
    #[serde(default)]
    pub virtual_size: u64,
    /// The OCI image this layer is the disk for, when it is one.
    ///
    /// The bottom of every chain is the image's ext4, and `mke2fs` writes a
    /// random filesystem UUID and timestamps into it — so two hosts building
    /// the same image produce different bytes and `digest` can never match
    /// across them. The image digest can: it is a hash of the OCI layer
    /// digests (images/object.rs), identical everywhere. An importer that
    /// already holds this image's disk uses its own copy and never writes the
    /// blob, which is the only form of cross-host reuse this layer can have.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_digest: Option<String>,
}

/// Archive manifest stored as `manifest.json` inside exported archives.
///
/// v1: plain tar, no checksums
/// v2: tar.zst with checksums
/// v3: adds `box_options` for full configuration preservation
/// v4: `box_options.advanced` carries a custom capability policy
/// v5: `ports` carry publication semantics (automatic host port, bind IP)
/// v6: the container disk travels as a chain of content-addressed layers
#[derive(Debug, Serialize, Deserialize)]
pub struct ArchiveManifest {
    /// Archive format version (1 through 6).
    pub version: u32,
    /// Original box name (optional, may be renamed on import).
    pub box_name: Option<String>,
    /// Image reference used to create the box (e.g. "alpine:latest").
    pub image: String,
    /// Full box configuration (v3+). `None` for v1/v2 archives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_options: Option<crate::runtime::options::BoxOptions>,
    /// SHA-256 checksum of the guest rootfs disk.
    pub guest_disk_checksum: String,
    /// SHA-256 checksum of the container disk.
    pub container_disk_checksum: String,
    /// The container disk's layer chain, ordered base first, top last (v6+).
    ///
    /// Empty for v1–v5, whose container disk is a single flattened image.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<ArchiveLayer>,
    /// Timestamp when the archive was created.
    pub exported_at: String,
}

// ── Build ───────────────────────────────────────────────────────────────

/// A layer's bytes with its backing-file pointer zeroed.
///
/// A qcow2's digest covers its header, and the header holds the *absolute
/// local path* of its parent. Hashing a layer as it sits on disk would
/// therefore mix in where that host happens to keep the parent, so the same
/// logical layer would hash differently on every machine and content
/// addressing could never match anything across hosts. It would also go stale
/// the moment an importer relinks the file, and leak the exporting host's
/// directory layout into the archive.
///
/// The canonical form is what travels and what gets hashed: identical to the
/// file except `backing_file_offset`, `backing_file_size`, and the path string
/// they point at read as zeroes. Length is unchanged, so this streams — no
/// temporary copy of a multi-hundred-megabyte layer.
pub(crate) struct CanonicalLayer {
    file: std::fs::File,
    len: u64,
    pos: u64,
    /// Byte ranges to serve as zeroes, in ascending order.
    holes: Vec<(u64, u64)>,
}

impl CanonicalLayer {
    /// Header bytes covering `backing_file_size` only.
    ///
    /// `backing_file_offset` is deliberately preserved: it is a location
    /// *within* the file, identical on every host for a layer boxlite wrote,
    /// and an importer needs it to know where to put the parent path it picks.
    /// The size is zeroed because it would otherwise leak — and make the digest
    /// depend on — how long the exporting host's path happened to be.
    const BACKING_SIZE_FIELD: (u64, u64) = (16, 20);

    pub(crate) fn open(path: &Path) -> BoxliteResult<Self> {
        use std::io::Read;

        let mut file = std::fs::File::open(path).map_err(|e| {
            BoxliteError::Storage(format!("Failed to open layer {}: {}", path.display(), e))
        })?;
        let len = file
            .metadata()
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to stat layer {}: {}", path.display(), e))
            })?
            .len();

        let mut head = [0u8; 20];
        let holes = match file.read_exact(&mut head) {
            Ok(()) if u32::from_be_bytes(head[0..4].try_into().unwrap()) == 0x5146_49fb => {
                let backing_offset = u64::from_be_bytes(head[8..16].try_into().unwrap());
                let backing_size = u32::from_be_bytes(head[16..20].try_into().unwrap()) as u64;
                let mut holes = vec![Self::BACKING_SIZE_FIELD];
                if backing_offset != 0 && backing_size != 0 {
                    holes.push((backing_offset, backing_offset + backing_size));
                }
                holes.sort_unstable();
                holes
            }
            // A raw layer (the image disk) has no header to normalize.
            _ => Vec::new(),
        };

        use std::io::Seek;
        file.rewind().map_err(|e| {
            BoxliteError::Storage(format!("Failed to rewind {}: {}", path.display(), e))
        })?;

        Ok(Self {
            file,
            len,
            pos: 0,
            holes,
        })
    }

    pub(crate) fn len(&self) -> u64 {
        self.len
    }

    /// The layer's canonical digest, consuming the reader.
    pub(crate) fn digest(mut self) -> BoxliteResult<String> {
        use std::io::Read;

        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = self
                .read(&mut buf)
                .map_err(|e| BoxliteError::Storage(format!("Failed to read layer: {}", e)))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
    }
}

impl std::io::Read for CanonicalLayer {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.file.read(buf)?;
        let start = self.pos;
        let end = start + n as u64;

        for &(hole_start, hole_end) in &self.holes {
            let from = hole_start.max(start);
            let to = hole_end.min(end);
            if from < to {
                let lo = (from - start) as usize;
                let hi = (to - start) as usize;
                buf[lo..hi].fill(0);
            }
        }

        self.pos = end;
        Ok(n)
    }
}

/// Write the archive as a directory of separately addressed objects.
///
/// Produces `manifest.json` and `layers/{hex}.zst`, one object per layer, each
/// holding that layer's [`CanonicalLayer`] bytes compressed on its own. The
/// point is that every object is immutable and named by its content, so
/// mirroring the directory to object storage uploads only what is missing —
/// the sync tool's existence check is the whole negotiation. A layer that two
/// exports share is written to the same name and transferred once.
///
/// The manifest is written last. A reader that finds it can rely on every
/// layer it names already being present, which is what makes an interrupted
/// mirror safe to retry rather than a half-published archive.
pub(crate) fn build_layered_directory(
    output_dir: &Path,
    manifest_json: &str,
    layers: &[(String, std::path::PathBuf)],
    compression_level: i32,
) -> BoxliteResult<()> {
    write_layer_objects(output_dir, layers, compression_level)?;

    let manifest_path = output_dir.join(MANIFEST_FILENAME);
    std::fs::write(&manifest_path, manifest_json).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to write {}: {}",
            manifest_path.display(),
            e
        ))
    })?;

    Ok(())
}

/// Write each layer as a content-named `.zst` object under `root/layers/`.
///
/// An object that already exists is left alone — it was put there by an
/// earlier export sharing that layer, which is what makes repeat exports into
/// the same place incremental. New objects are written under a temporary name
/// and renamed, so a reader never sees a half-written object under a name
/// that promises specific content.
///
/// The temporary name is unique per attempt, not per digest: two exports that
/// share a missing layer (e.g. two boxes cloned from the same base, exported
/// around the same time into the same mirror) each write their own staging
/// file rather than both opening one shared path with `O_TRUNC`, which would
/// let their writes land at unsynchronized offsets in the same inode. Losing
/// the race is harmless — the layer is content-addressed, so the winner's
/// object is already the bytes this writer would have produced — so the
/// loser just discards its copy instead of erroring on a rename whose source
/// the winner already claimed.
fn write_layer_objects(
    root: &Path,
    layers: &[(String, std::path::PathBuf)],
    compression_level: i32,
) -> BoxliteResult<()> {
    let layers_dir = root.join(LAYERS_DIR);
    std::fs::create_dir_all(&layers_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create layer directory {}: {}",
            layers_dir.display(),
            e
        ))
    })?;

    for (digest, path) in layers {
        let object = root.join(format!("{}.zst", layer_entry_name(digest)));
        if object.exists() {
            tracing::debug!(digest = %digest, "Layer object already written, leaving it");
            continue;
        }

        let staging = object.with_extension(format!("zst.{}.partial", uuid::Uuid::new_v4()));
        let write_result = write_layer_object(&staging, path, compression_level, digest);
        if let Err(e) = write_result {
            let _ = std::fs::remove_file(&staging);
            return Err(e);
        }

        if object.exists() {
            // Another writer finished this same layer while we were
            // compressing our own copy.
            tracing::debug!(
                digest = %digest,
                "Layer object appeared while writing, discarding the redundant copy"
            );
            let _ = std::fs::remove_file(&staging);
            continue;
        }
        move_file(&staging, &object)?;
    }

    Ok(())
}

fn write_layer_object(
    staging: &Path,
    path: &Path,
    compression_level: i32,
    digest: &str,
) -> BoxliteResult<()> {
    let mut layer = CanonicalLayer::open(path)?;
    let file = std::fs::File::create(staging).map_err(|e| {
        BoxliteError::Storage(format!("Failed to create {}: {}", staging.display(), e))
    })?;
    let mut encoder = zstd::Encoder::new(file, compression_level)
        .map_err(|e| BoxliteError::Storage(format!("Failed to create zstd encoder: {}", e)))?;
    std::io::copy(&mut layer, &mut encoder)
        .map_err(|e| BoxliteError::Storage(format!("Failed to write layer {}: {}", digest, e)))?;
    encoder
        .finish()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finish layer {}: {}", digest, e)))?;
    Ok(())
}

/// Build a zstd-compressed tar archive holding a manifest and layer blobs.
///
/// `layers` pairs each layer's digest with the file to read it from, in the
/// same order as the manifest's layer list. Each layer travels in its
/// [`CanonicalLayer`] form.
pub(crate) fn build_layered_archive(
    output_path: &Path,
    manifest_path: &Path,
    layers: &[(String, std::path::PathBuf)],
    compression_level: i32,
) -> BoxliteResult<()> {
    let file = std::fs::File::create(output_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create archive file {}: {}",
            output_path.display(),
            e
        ))
    })?;

    let encoder = zstd::Encoder::new(file, compression_level)
        .map_err(|e| BoxliteError::Storage(format!("Failed to create zstd encoder: {}", e)))?;
    let mut builder = tar::Builder::new(encoder);

    builder
        .append_path_with_name(manifest_path, MANIFEST_FILENAME)
        .map_err(|e| BoxliteError::Storage(format!("Failed to add manifest to archive: {}", e)))?;

    for (digest, path) in layers {
        let layer = CanonicalLayer::open(path)?;
        let mut header = tar::Header::new_gnu();
        header.set_size(layer.len());
        header.set_mode(0o600);
        header.set_cksum();
        builder
            .append_data(&mut header, layer_entry_name(digest), layer)
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to add layer {} to archive: {}", digest, e))
            })?;
    }

    let encoder = builder
        .into_inner()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finalize tar: {}", e)))?;
    encoder
        .finish()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finish zstd compression: {}", e)))?;

    Ok(())
}

// ── Extract ─────────────────────────────────────────────────────────────

/// Zstd magic bytes: `0x28B52FFD` (little-endian in file).
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
pub(crate) const MAX_ARCHIVE_OUTPUT: u64 = 128 * 1024 * 1024 * 1024;

/// Extract an archive, detecting format via magic bytes (zstd or plain tar).
pub(crate) fn extract_archive(archive_path: &Path, dest_dir: &Path) -> BoxliteResult<()> {
    use std::io::Read;

    let mut file = std::fs::File::open(archive_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to open archive {}: {}",
            archive_path.display(),
            e
        ))
    })?;

    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to read archive header {}: {}",
            archive_path.display(),
            e
        ))
    })?;
    drop(file);

    // Re-open for extraction (tar/zstd need the file from the beginning).
    let file = std::fs::File::open(archive_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to reopen archive {}: {}",
            archive_path.display(),
            e
        ))
    })?;

    if magic == ZSTD_MAGIC {
        extract_zstd_tar(file, dest_dir)
    } else {
        extract_plain_tar(file, dest_dir)
    }
}

fn extract_zstd_tar(file: std::fs::File, dest_dir: &Path) -> BoxliteResult<()> {
    use std::io::Read;

    let decoder = zstd::Decoder::new(file)
        .map_err(|e| BoxliteError::Storage(format!("Failed to create zstd decoder: {}", e)))?;
    let mut archive = tar::Archive::new(decoder.take(MAX_ARCHIVE_OUTPUT.saturating_add(1)));
    archive
        .unpack(dest_dir)
        .map_err(|e| BoxliteError::Storage(format!("Failed to extract zstd tar: {}", e)))?;
    Ok(())
}

fn extract_plain_tar(file: std::fs::File, dest_dir: &Path) -> BoxliteResult<()> {
    let mut archive = tar::Archive::new(file);
    archive
        .unpack(dest_dir)
        .map_err(|e| BoxliteError::Storage(format!("Failed to extract archive: {}", e)))?;
    Ok(())
}

// ── File Operations ─────────────────────────────────────────────────────

/// Move a file, falling back to copy+remove if rename fails with EXDEV
/// (cross-device link error, i.e. source and destination on different filesystems).
pub(crate) fn move_file(src: &Path, dst: &Path) -> BoxliteResult<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            std::fs::copy(src, dst).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to copy {} to {}: {}",
                    src.display(),
                    dst.display(),
                    e
                ))
            })?;
            std::fs::remove_file(src).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to remove source after cross-fs copy {}: {}",
                    src.display(),
                    e
                ))
            })?;
            Ok(())
        }
        Err(e) => Err(BoxliteError::Storage(format!(
            "Failed to move {} to {}: {}",
            src.display(),
            dst.display(),
            e
        ))),
    }
}

// ── Checksums ───────────────────────────────────────────────────────────

/// Compute SHA-256 checksum of a file, returning "sha256:<hex>" string.
pub(crate) fn sha256_file(path: &Path) -> BoxliteResult<String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to open {} for checksum: {}",
            path.display(),
            e
        ))
    })?;

    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read {} for checksum: {}",
                path.display(),
                e
            ))
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

/// Decompress one layer object from a mirrored archive directory.
///
/// Only called for a layer the importer has decided it actually needs, which
/// is the point of the directory form: an object the host already holds is
/// never read, let alone decompressed.
pub(crate) fn extract_layer_object(
    archive_dir: &Path,
    digest: &str,
    dest: &Path,
    virtual_size: u64,
    remaining_output: u64,
) -> BoxliteResult<u64> {
    use std::io::Read;

    let object = archive_dir.join(format!("{}.zst", layer_entry_name(digest)));
    let file = std::fs::File::open(&object).map_err(|e| {
        BoxliteError::Storage(format!(
            "Archive directory is missing layer {}: {}",
            object.display(),
            e
        ))
    })?;
    let layer_limit = if virtual_size > 0 {
        virtual_size
    } else {
        MAX_ARCHIVE_OUTPUT
    };
    let max_output = layer_limit.min(remaining_output);
    let mut decoder = zstd::Decoder::new(file)
        .map_err(|e| BoxliteError::Storage(format!("Failed to read layer {}: {}", digest, e)))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            BoxliteError::Storage(format!("Failed to create {}: {}", parent.display(), e))
        })?;
    }
    let mut out = std::fs::File::create(dest).map_err(|e| {
        BoxliteError::Storage(format!("Failed to create {}: {}", dest.display(), e))
    })?;
    let written = std::io::copy(
        &mut decoder.by_ref().take(max_output.saturating_add(1)),
        &mut out,
    )
    .map_err(|e| BoxliteError::Storage(format!("Failed to unpack layer {}: {}", digest, e)))?;
    if written > max_output {
        drop(out);
        let _ = std::fs::remove_file(dest);
        return Err(BoxliteError::Storage(format!(
            "Layer {digest} exceeds its decompression limit"
        )));
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// An export must not be readable by an importer that would drop part of
    /// its configuration: capability policies are stamped v4, published ports
    /// v5, ordinary boxes v3.
    ///
    /// The literals are the compatibility boundary itself — a pre-capability
    /// importer accepts up to 3, a pre-publication one up to 4 — so pin them,
    /// not just the branch.
    #[test]
    fn configuration_an_older_importer_would_drop_raises_the_archive_version() {
        assert_eq!(ARCHIVE_VERSION, 3);
        assert_eq!(CAPABILITY_POLICY_ARCHIVE_VERSION, 4);
        assert_eq!(PUBLISHED_PORTS_ARCHIVE_VERSION, 5);

        let ordinary = crate::runtime::options::BoxOptions::default();
        assert_eq!(archive_version_for_options(&ordinary), ARCHIVE_VERSION);

        let custom = crate::runtime::options::BoxOptions {
            advanced: crate::runtime::advanced_options::AdvancedBoxOptions {
                capabilities: crate::runtime::advanced_options::ContainerCapabilities {
                    drop: vec!["NET_RAW".into()],
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(
            archive_version_for_options(&custom),
            CAPABILITY_POLICY_ARCHIVE_VERSION
        );

        // Every port field gained meaning in v5. A fixed mapping with a bind IP
        // is the case a v3 stamp would lose silently: an older importer drops
        // host_ip and publishes on every interface.
        for ports in [
            vec![crate::runtime::options::PortSpec {
                host_port: None,
                guest_port: 3000,
                protocol: crate::runtime::options::PortProtocol::Tcp,
                host_ip: None,
            }],
            vec![crate::runtime::options::PortSpec {
                host_port: Some(18080),
                guest_port: 80,
                protocol: crate::runtime::options::PortProtocol::Tcp,
                host_ip: Some("127.0.0.1".to_string()),
            }],
        ] {
            let published = crate::runtime::options::BoxOptions {
                ports,
                ..Default::default()
            };
            assert_eq!(
                archive_version_for_options(&published),
                PUBLISHED_PORTS_ARCHIVE_VERSION
            );
        }
    }

    /// Regression: the export stamp and the importer's canonicalization window
    /// have to agree. When they drift, a box exported by this build re-imports
    /// through `normalize_legacy_ports`, which clears `host_ip` — turning a
    /// loopback publication into one on every interface.
    #[test]
    fn this_builds_port_exports_are_never_canonicalized_on_import() {
        let published = crate::runtime::options::BoxOptions {
            ports: vec![crate::runtime::options::PortSpec {
                host_port: Some(18080),
                guest_port: 80,
                protocol: crate::runtime::options::PortProtocol::Tcp,
                host_ip: Some("127.0.0.1".to_string()),
            }],
            ..Default::default()
        };

        assert!(
            archive_version_for_options(&published) >= PUBLISHED_PORTS_ARCHIVE_VERSION,
            "an export carrying ports must be stamped at or above the version \
             below which the importer rewrites them"
        );
    }

    #[test]
    fn test_extract_zstd_archive_via_magic_bytes() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("test.boxlite");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        // Create a small zstd-compressed tar with a test file.
        let test_content = b"hello from zstd archive";
        let test_file = dir.path().join("test.txt");
        std::fs::write(&test_file, test_content).unwrap();

        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let encoder = zstd::Encoder::new(file, 3).unwrap();
            let mut builder = tar::Builder::new(encoder);
            builder
                .append_path_with_name(&test_file, "test.txt")
                .unwrap();
            let encoder = builder.into_inner().unwrap();
            encoder.finish().unwrap();
        }

        // Verify magic bytes
        let header = std::fs::read(&archive_path).unwrap();
        assert_eq!(&header[..4], &ZSTD_MAGIC);

        // Extract and verify
        extract_archive(&archive_path, &extract_dir).unwrap();
        let content = std::fs::read_to_string(extract_dir.join("test.txt")).unwrap();
        assert_eq!(content, "hello from zstd archive");
    }

    #[test]
    fn test_extract_plain_tar_via_magic_bytes() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("test.tar");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let test_file = dir.path().join("test.txt");
        std::fs::write(&test_file, b"hello from plain tar").unwrap();

        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut builder = tar::Builder::new(file);
            builder
                .append_path_with_name(&test_file, "test.txt")
                .unwrap();
            builder.finish().unwrap();
        }

        // Verify NOT zstd magic
        let header = std::fs::read(&archive_path).unwrap();
        assert_ne!(&header[..4], &ZSTD_MAGIC);

        extract_archive(&archive_path, &extract_dir).unwrap();
        let content = std::fs::read_to_string(extract_dir.join("test.txt")).unwrap();
        assert_eq!(content, "hello from plain tar");
    }

    #[test]
    fn layer_object_decompression_is_bounded() {
        let dir = tempdir().unwrap();
        let archive_dir = dir.path().join("archive");
        std::fs::create_dir_all(archive_dir.join(LAYERS_DIR)).unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));
        let object = archive_dir.join(format!("{}.zst", layer_entry_name(&digest)));
        std::fs::write(&object, zstd::encode_all(&b"too large"[..], 3).unwrap()).unwrap();
        let dest = dir.path().join("layer");

        let error = extract_layer_object(&archive_dir, &digest, &dest, 1, MAX_ARCHIVE_OUTPUT)
            .expect_err("decompression must stop at the declared virtual size");

        assert!(error.to_string().contains("decompression limit"));
        assert!(!dest.exists(), "a rejected partial layer must be removed");
    }

    #[test]
    fn test_move_file_same_filesystem() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.txt");
        let dst = dir.path().join("dst.txt");
        std::fs::write(&src, "move me").unwrap();

        move_file(&src, &dst).unwrap();

        assert!(!src.exists());
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "move me");
    }

    #[test]
    fn test_move_file_nonexistent_source_errors() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("nonexistent.txt");
        let dst = dir.path().join("dst.txt");

        assert!(move_file(&src, &dst).is_err());
    }

    #[test]
    fn test_sha256_file_deterministic() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.bin");
        std::fs::write(&path, b"deterministic content").unwrap();

        let hash1 = sha256_file(&path).unwrap();
        let hash2 = sha256_file(&path).unwrap();
        assert_eq!(hash1, hash2);
        assert!(hash1.starts_with("sha256:"));
    }

    #[test]
    fn test_build_and_extract_roundtrip() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("roundtrip.boxlite");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let manifest_path = dir.path().join(MANIFEST_FILENAME);
        let base = dir.path().join("base.bin");
        let top = dir.path().join("top.bin");
        std::fs::write(&manifest_path, r#"{"version":6}"#).unwrap();
        std::fs::write(&base, "fake-base-layer").unwrap();
        std::fs::write(&top, "fake-top-layer").unwrap();

        let layers = vec![
            ("sha256:aaa".to_string(), base),
            ("sha256:bbb".to_string(), top),
        ];
        build_layered_archive(&archive_path, &manifest_path, &layers, 3).unwrap();
        extract_archive(&archive_path, &extract_dir).unwrap();

        assert_eq!(
            std::fs::read_to_string(extract_dir.join(MANIFEST_FILENAME)).unwrap(),
            r#"{"version":6}"#
        );
        // Each layer lands under the name its digest implies, which is how the
        // importer finds a blob it only knows by content.
        assert_eq!(
            std::fs::read_to_string(extract_dir.join(layer_entry_name("sha256:aaa"))).unwrap(),
            "fake-base-layer"
        );
        assert_eq!(
            std::fs::read_to_string(extract_dir.join(layer_entry_name("sha256:bbb"))).unwrap(),
            "fake-top-layer"
        );
    }

    /// Two exports that share a missing layer (e.g. two boxes cloned from the
    /// same base, both mirrored into the same directory around the same time)
    /// must not corrupt or fail to write that layer's object just because
    /// they raced on it.
    #[test]
    fn concurrent_writers_of_the_same_missing_layer_do_not_corrupt_it() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("shared-layer.bin");
        // Large and only lightly compressible, so each writer's encode+write
        // takes long enough for concurrent attempts to actually overlap.
        let mut content = vec![0u8; 8 * 1024 * 1024];
        for (i, byte) in content.iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        std::fs::write(&source, &content).unwrap();
        let digest = CanonicalLayer::open(&source).unwrap().digest().unwrap();

        for round in 0..5 {
            let root = dir.path().join(format!("root-{round}"));
            let writers = 4;
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(writers));
            let root = std::sync::Arc::new(root);
            let source = std::sync::Arc::new(source.clone());
            let digest = std::sync::Arc::new(digest.clone());

            let handles: Vec<_> = (0..writers)
                .map(|_| {
                    let barrier = barrier.clone();
                    let root = root.clone();
                    let source = source.clone();
                    let digest = digest.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        write_layer_objects(&root, &[((*digest).clone(), (*source).clone())], 3)
                    })
                })
                .collect();

            for handle in handles {
                handle
                    .join()
                    .unwrap()
                    .expect("a racing writer must not fail just because another writer won");
            }

            let object = root.join(format!("{}.zst", layer_entry_name(&digest)));
            let file = std::fs::File::open(&object).expect("the layer object must exist");
            let mut decoder = zstd::Decoder::new(file).expect("a valid writer's object decodes");
            let mut restored = Vec::new();
            std::io::Read::read_to_end(&mut decoder, &mut restored)
                .expect("the object must decompress cleanly, not end mid-frame");
            assert_eq!(
                restored, content,
                "round {round}: the object's content must be exactly the source layer"
            );
        }
    }
}
