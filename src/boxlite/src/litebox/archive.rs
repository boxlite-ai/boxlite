//! Archive operations for box export and import.
//!
//! Handles `.boxlite` archive files: zstd-compressed tarballs containing
//! disk images and a JSON manifest.

use std::io::Write;
use std::path::Path;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::disk::constants::filenames as disk_filenames;

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

/// Older importers must refuse fractional CPUs they cannot enforce.
pub(crate) const FRACTIONAL_CPUS_ARCHIVE_VERSION: u32 = 6;

/// Managed and typed mounts require a local volume-capable importer.
pub(crate) const MANAGED_MOUNTS_ARCHIVE_VERSION: u32 = 7;

/// Archive format version carrying full VM memory and device state checkpoint.
pub(crate) const MEMORY_CHECKPOINT_ARCHIVE_VERSION: u32 = 8;

/// Maximum archive version this build can import.
pub(crate) const MAX_SUPPORTED_VERSION: u32 = MEMORY_CHECKPOINT_ARCHIVE_VERSION;

/// Per-box checkpoint staging directory name under `box_home/`.
pub(crate) const CHECKPOINT_DIRNAME: &str = "checkpoint";

/// VM state filename inside v8 archives and `box_home/checkpoint/`.
pub(crate) const VMSTATE_FILENAME: &str = "vmstate.krun";

/// Guest rootfs disk filename inside v8 archives and `box_home/checkpoint/`.
pub(crate) const GUEST_ROOTFS_FILENAME: &str = "guest-rootfs.ext4";

/// Return the host checkpoint platform identifier if full memory checkpoints are supported.
pub(crate) fn current_checkpoint_platform() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Some("macos-aarch64-hvf")
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Some("linux-x86_64-kvm")
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    {
        None
    }
}

/// Pick the archive format an exported box needs.
///
/// Use the oldest format that can represent all configured policies.
/// An explicitly empty capability policy still requires v4; ports require v5,
/// fractional CPUs require v6, and managed/typed mounts require v7 so older
/// readers cannot silently discard or defer them until boot fails.
pub(crate) fn archive_version_for_options(options: &crate::runtime::options::BoxOptions) -> u32 {
    if !options.mounts.is_empty()
        || options
            .volumes
            .iter()
            .any(|mount| mount.managed_volume.is_some())
    {
        MANAGED_MOUNTS_ARCHIVE_VERSION
    } else if options
        .cpu_count()
        .is_ok_and(|cpu| cpu.is_some_and(|cpu| cpu.is_fractional()))
    {
        FRACTIONAL_CPUS_ARCHIVE_VERSION
    } else if !options.ports.is_empty() {
        PUBLISHED_PORTS_ARCHIVE_VERSION
    } else if options.advanced.capabilities().is_none() {
        ARCHIVE_VERSION
    } else {
        CAPABILITY_POLICY_ARCHIVE_VERSION
    }
}

/// Archive manifest stored as `manifest.json` inside exported archives.
///
/// v1: plain tar, no checksums
/// v2: tar.zst with checksums
/// v3: adds `box_options` for full configuration preservation
/// v4: `box_options.advanced` carries a custom capability policy
/// v5: `ports` carry publication semantics (automatic host port, bind IP)
/// v6: fractional `box_options.cpus` requires host CPU bandwidth enforcement
/// v7: managed/typed mounts require local volume-capable resolution
/// v8: adds `memory_checkpoint` for full VM memory + device state restore
#[derive(Debug, Serialize, Deserialize)]
pub struct ArchiveManifest {
    /// Archive format version (1 through 8).
    pub version: u32,
    /// Original box name (optional, may be renamed on import).
    pub box_name: Option<String>,
    /// Image reference used to create the box (e.g. "alpine:latest").
    pub image: String,
    /// Full box configuration (v3+). `None` for v1/v2 archives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "crate::runtime::cpu_count::deserialize_options")]
    pub box_options: Option<crate::runtime::options::BoxOptions>,
    /// SHA-256 checksum of the guest rootfs disk.
    ///
    /// Always empty: the guest rootfs is no longer bundled in archives (it ships
    /// as a shared base image). Kept in the schema so pre-minimal-rootfs
    /// importers, which require the field, can deserialize the manifest instead
    /// of failing with "missing field `guest_disk_checksum`".
    pub guest_disk_checksum: String,
    /// SHA-256 checksum of the container disk; required for memory checkpoints.
    pub container_disk_checksum: String,
    /// Full VM memory/device checkpoint metadata, required in v8 and absent in v1–v7.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_checkpoint: Option<MemoryCheckpointArchiveMetadata>,
    /// Timestamp when the archive was created.
    pub exported_at: String,
}

/// Full VM memory and device checkpoint metadata stored in v8 manifests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryCheckpointArchiveMetadata {
    /// Host checkpoint platform identifier (e.g. `"macos-aarch64-hvf"`, `"linux-x86_64-kvm"`).
    pub platform: String,
    /// Container ID associated with the saved guest state.
    pub container_id: String,
    /// SHA-256 checksum of `vmstate.krun`.
    pub vmstate_checksum: String,
    /// Size of `vmstate.krun` in bytes.
    pub vmstate_size_bytes: u64,
    /// SHA-256 checksum of `guest-rootfs.ext4`.
    pub guest_rootfs_checksum: String,
    /// Preserve a runtime egress block without removing the saved NIC. An empty
    /// `box_options.network` allowlist alone would allow all outbound traffic.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub outbound_disabled: bool,
}

// ── Build ───────────────────────────────────────────────────────────────

/// Build a zstd-compressed tar archive.
pub(crate) fn build_zstd_tar_archive(
    output_path: &Path,
    manifest_path: &Path,
    container_disk: &Path,
    compression_level: i32,
) -> BoxliteResult<()> {
    build_zstd_tar_archive_inner(
        output_path,
        manifest_path,
        container_disk,
        None,
        compression_level,
    )
}

/// Build a zstd-compressed tar archive carrying a full memory/device checkpoint (v8).
pub(crate) fn build_zstd_tar_archive_with_memory(
    output_path: &Path,
    manifest_path: &Path,
    container_disk: &Path,
    vmstate_path: &Path,
    guest_rootfs_path: &Path,
    compression_level: i32,
) -> BoxliteResult<()> {
    build_zstd_tar_archive_inner(
        output_path,
        manifest_path,
        container_disk,
        Some((vmstate_path, guest_rootfs_path)),
        compression_level,
    )
}

fn build_zstd_tar_archive_inner(
    output_path: &Path,
    manifest_path: &Path,
    container_disk: &Path,
    memory_artifacts: Option<(&Path, &Path)>,
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
    append_archive_files(
        &mut builder,
        manifest_path,
        container_disk,
        memory_artifacts,
    )?;

    let encoder = builder
        .into_inner()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finalize tar: {}", e)))?;
    encoder
        .finish()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finish zstd compression: {}", e)))?;

    Ok(())
}

fn append_archive_files<W: Write>(
    builder: &mut tar::Builder<W>,
    manifest_path: &Path,
    container_disk: &Path,
    memory_artifacts: Option<(&Path, &Path)>,
) -> BoxliteResult<()> {
    builder
        .append_path_with_name(manifest_path, MANIFEST_FILENAME)
        .map_err(|e| BoxliteError::Storage(format!("Failed to add manifest to archive: {}", e)))?;

    builder
        .append_path_with_name(container_disk, disk_filenames::CONTAINER_DISK)
        .map_err(|e| {
            BoxliteError::Storage(format!("Failed to add container disk to archive: {}", e))
        })?;

    if let Some((vmstate_path, guest_rootfs_path)) = memory_artifacts {
        builder
            .append_path_with_name(vmstate_path, VMSTATE_FILENAME)
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to add vmstate to archive: {}", e))
            })?;

        builder
            .append_path_with_name(guest_rootfs_path, GUEST_ROOTFS_FILENAME)
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to add guest rootfs to archive: {}", e))
            })?;
    }

    Ok(())
}

// ── Extract ─────────────────────────────────────────────────────────────

/// Zstd magic bytes: `0x28B52FFD` (little-endian in file).
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

/// Read and validate the leading manifest before creating the extraction directory.
pub(crate) fn extract_archive_with_manifest(
    archive_path: &Path,
    temp_root: &Path,
    validate: impl FnOnce(&ArchiveManifest) -> BoxliteResult<()>,
) -> BoxliteResult<(ArchiveManifest, tempfile::TempDir)> {
    let mut archive = open_archive(archive_path)?;
    let mut entries = archive.entries()?;
    let manifest = {
        let entry = entries.next().transpose()?.ok_or_else(missing_manifest)?;
        if entry.path()?.as_ref() != Path::new(MANIFEST_FILENAME)
            || !carries_file_contents(entry.header().entry_type())
        {
            return Err(missing_manifest());
        }
        serde_json::from_reader(entry)
            .map_err(|e| BoxliteError::Storage(format!("Invalid manifest: {e}")))?
    };
    validate(&manifest)?;

    let temp_dir = tempfile::tempdir_in(temp_root)
        .map_err(|e| BoxliteError::Storage(format!("Failed to create temp directory: {e}")))?;
    unpack_file_members(entries, temp_dir.path())?;
    Ok((manifest, temp_dir))
}

fn missing_manifest() -> BoxliteError {
    BoxliteError::Storage("Invalid archive: first member must be manifest.json".into())
}

#[cfg(test)]
pub(crate) fn extract_archive(archive_path: &Path, dest_dir: &Path) -> BoxliteResult<()> {
    unpack_file_members(open_archive(archive_path)?.entries()?, dest_dir)
}

/// Open an archive, detecting format via magic bytes (zstd or plain tar).
fn open_archive(archive_path: &Path) -> BoxliteResult<tar::Archive<Box<dyn std::io::Read>>> {
    use std::io::{Read, Seek};

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
    file.rewind()?;
    let reader: Box<dyn Read> = if magic == ZSTD_MAGIC {
        let decoder = zstd::Decoder::new(file)
            .map_err(|e| BoxliteError::Storage(format!("Failed to create zstd decoder: {}", e)))?;
        Box::new(decoder)
    } else {
        Box::new(file)
    };
    Ok(tar::Archive::new(reader))
}

/// Member types that carry their own contents rather than a reference to
/// something else.
///
/// `Regular` is the common case. `Continuous` is its rarely used contiguous
/// variant. `GNUSparse` is what `tar::Builder` emits for a file with holes —
/// which on Linux is every exported qcow2 disk, since the builder reads sparse
/// information from disk by default. All three unpack as ordinary files.
///
/// The OCI layer extractor pairs the same two types for the same reason — see
/// the `EntryType::Regular | EntryType::GNUSparse` arm in
/// `images/archive/extractor.rs`.
fn carries_file_contents(entry_type: tar::EntryType) -> bool {
    matches!(
        entry_type,
        tar::EntryType::Regular | tar::EntryType::Continuous | tar::EntryType::GNUSparse
    )
}

/// Unpack an archive, accepting only members that carry their own contents.
///
/// tar checks where a member is *written* but copies a link's target verbatim,
/// so a link member lands in `dest_dir` pointing anywhere on the host and every
/// later step — exists, checksum, the backing-file scan, the rename that makes
/// it a box's disk — follows it there. Deciding on the member's own type is the
/// only point where the archive itself, rather than whatever it resolves to, is
/// what gets judged.
///
/// This costs no compatibility: `tar::Builder` dereferences symlinks by default
/// and boxlite has never turned that off, so no export has ever produced a link
/// member. Member *names* are deliberately not filtered — archives written
/// before the guest rootfs became a shared base image carry a third member that
/// the importer ignores, and rejecting it would strand them.
fn unpack_file_members<R: std::io::Read>(
    entries: tar::Entries<'_, R>,
    dest_dir: &Path,
) -> BoxliteResult<()> {
    for entry in entries {
        let mut entry = entry
            .map_err(|e| BoxliteError::Storage(format!("Failed to read archive member: {}", e)))?;

        let entry_type = entry.header().entry_type();
        if !carries_file_contents(entry_type) {
            let name = entry
                .path()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| "<unreadable>".to_string());
            return Err(BoxliteError::Storage(format!(
                "Invalid archive: member '{}' is {:?}, only files are allowed",
                name, entry_type
            )));
        }

        entry
            .unpack_in(dest_dir)
            .map_err(|e| BoxliteError::Storage(format!("Failed to extract archive: {}", e)))?;
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// An export must not be readable by an importer that would drop part of
    /// its configuration: capability policies are stamped v4, published ports
    /// v5, fractional CPUs v6, ordinary boxes v3.
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
        let limited = crate::BoxOptions {
            cpus: Some(0.125),
            ..ordinary.clone()
        };
        assert_eq!(archive_version_for_options(&limited), 6);

        let mut custom_advanced = crate::runtime::advanced_options::AdvancedBoxOptions::default();
        custom_advanced
            .set_capabilities(Some(
                crate::runtime::advanced_options::ContainerCapabilities {
                    drop: vec!["NET_RAW".into()],
                    ..Default::default()
                },
            ))
            .unwrap();
        let custom = crate::runtime::options::BoxOptions {
            advanced: custom_advanced,
            ..Default::default()
        };
        assert_eq!(
            archive_version_for_options(&custom),
            CAPABILITY_POLICY_ARCHIVE_VERSION
        );

        // An explicit, empty capability policy is still an explicit policy,
        // not the same as never touching the field — a pre-capability
        // importer must not decide that distinction was safe to drop.
        let mut explicit_empty_advanced =
            crate::runtime::advanced_options::AdvancedBoxOptions::default();
        explicit_empty_advanced
            .set_capabilities(Some(
                crate::runtime::advanced_options::ContainerCapabilities::default(),
            ))
            .unwrap();
        let explicit_empty = crate::runtime::options::BoxOptions {
            advanced: explicit_empty_advanced,
            ..Default::default()
        };
        assert_eq!(
            archive_version_for_options(&explicit_empty),
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

    #[test]
    fn managed_mounts_require_archive_v7() {
        use crate::runtime::options::{MountSpec, VolumeSpec};

        let legacy = crate::runtime::options::BoxOptions {
            volumes: vec![VolumeSpec::managed_volume("workspace", "/workspace")],
            ..Default::default()
        };
        assert_eq!(archive_version_for_options(&legacy), 7);

        for mount in [
            MountSpec::volume_mount("workspace", "/workspace"),
            MountSpec::bind_mount("/srv/data", "/data"),
        ] {
            let options = crate::runtime::options::BoxOptions {
                mounts: vec![mount],
                ..Default::default()
            };
            assert_eq!(archive_version_for_options(&options), 7);
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

        // Create test files
        let manifest_path = dir.path().join(MANIFEST_FILENAME);
        let container_path = dir.path().join("container.qcow2");
        std::fs::write(&manifest_path, r#"{"version":2}"#).unwrap();
        std::fs::write(&container_path, "fake-container-disk").unwrap();

        build_zstd_tar_archive(&archive_path, &manifest_path, &container_path, 3).unwrap();
        extract_archive(&archive_path, &extract_dir).unwrap();

        assert_eq!(
            std::fs::read_to_string(extract_dir.join(MANIFEST_FILENAME)).unwrap(),
            r#"{"version":2}"#
        );
        assert_eq!(
            std::fs::read_to_string(extract_dir.join(disk_filenames::CONTAINER_DISK)).unwrap(),
            "fake-container-disk",
            "the container disk must be extracted"
        );
        assert!(
            !extract_dir.join(disk_filenames::GUEST_ROOTFS_DISK).exists(),
            "the archive must not contain a guest rootfs member"
        );
    }

    /// A `.boxlite` archive is untrusted input, and tar validates only where an
    /// entry is *written* — a symlink's target is copied verbatim. Without an
    /// entry-type check an archive can plant `disk.qcow2` as a link to any host
    /// path, and every later step (exists, checksum, backing-file scan, rename)
    /// follows it. The link must never reach the filesystem at all.
    #[test]
    fn extract_archive_rejects_symlink_entry() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("evil.boxlite");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let victim = dir.path().join("victim-disk.qcow2");
        std::fs::write(&victim, b"victim bytes").unwrap();

        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut builder = tar::Builder::new(file);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            builder
                .append_link(&mut header, disk_filenames::CONTAINER_DISK, &victim)
                .unwrap();
            builder.finish().unwrap();
        }

        let error = extract_archive(&archive_path, &extract_dir)
            .expect_err("a symlink archive member must be rejected");
        assert!(
            error.to_string().contains(disk_filenames::CONTAINER_DISK),
            "the error must name the offending member, got: {error}"
        );
        assert!(
            extract_dir
                .join(disk_filenames::CONTAINER_DISK)
                .symlink_metadata()
                .is_err(),
            "the link must never reach the filesystem"
        );
    }

    /// The same rule covers hard links. `symlink_metadata` reports a hard link
    /// as a regular file, so a check written against that would let this
    /// through; only the archive member's own type tells the truth.
    #[test]
    fn extract_archive_rejects_hardlink_entry() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("evil.boxlite");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let manifest = dir.path().join(MANIFEST_FILENAME);
        std::fs::write(&manifest, br#"{"version":3}"#).unwrap();

        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut builder = tar::Builder::new(file);
            builder
                .append_path_with_name(&manifest, MANIFEST_FILENAME)
                .unwrap();
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Link);
            header.set_size(0);
            header.set_mode(0o644);
            builder
                .append_link(
                    &mut header,
                    disk_filenames::CONTAINER_DISK,
                    MANIFEST_FILENAME,
                )
                .unwrap();
            builder.finish().unwrap();
        }

        let error = extract_archive(&archive_path, &extract_dir)
            .expect_err("a hard link archive member must be rejected");
        assert!(
            error.to_string().contains(disk_filenames::CONTAINER_DISK),
            "the error must name the offending member, got: {error}"
        );
        assert!(
            extract_dir
                .join(disk_filenames::CONTAINER_DISK)
                .symlink_metadata()
                .is_err(),
            "the link must never reach the filesystem"
        );
    }

    /// Archives written before the guest rootfs became a shared base image
    /// carry a third member. The importer ignores it, but extraction must
    /// still accept it — rejecting unknown *names* would strand every archive
    /// exported by a released build.
    #[test]
    fn extract_archive_accepts_legacy_guest_rootfs_member() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("legacy.boxlite");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let manifest = dir.path().join(MANIFEST_FILENAME);
        let container = dir.path().join("container-src");
        let guest = dir.path().join("guest-src");
        std::fs::write(&manifest, br#"{"version":2}"#).unwrap();
        std::fs::write(&container, b"container-disk").unwrap();
        std::fs::write(&guest, b"guest-rootfs-disk").unwrap();

        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut builder = tar::Builder::new(file);
            builder
                .append_path_with_name(&manifest, MANIFEST_FILENAME)
                .unwrap();
            builder
                .append_path_with_name(&container, disk_filenames::CONTAINER_DISK)
                .unwrap();
            builder
                .append_path_with_name(&guest, disk_filenames::GUEST_ROOTFS_DISK)
                .unwrap();
            builder.finish().unwrap();
        }

        extract_archive(&archive_path, &extract_dir)
            .expect("a legacy 3-member archive must import");
        assert_eq!(
            std::fs::read_to_string(extract_dir.join(disk_filenames::CONTAINER_DISK)).unwrap(),
            "container-disk"
        );
        assert_eq!(
            std::fs::read_to_string(extract_dir.join(disk_filenames::GUEST_ROOTFS_DISK)).unwrap(),
            "guest-rootfs-disk"
        );
    }
    /// Every exported disk is a sparse qcow2, and on Linux `tar::Builder`
    /// encodes a file with holes as a `GNUSparse` member rather than a plain
    /// regular one. A member-type check written against `Regular` alone reads
    /// as correct against small dense fixtures and rejects every real export,
    /// so the fixture here has to have a hole in it.
    #[test]
    fn extract_archive_accepts_sparse_disk_member() {
        use std::io::{Seek, SeekFrom, Write};

        const HOLE_END: u64 = 8 * 1024 * 1024;

        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("sparse.boxlite");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let manifest = dir.path().join(MANIFEST_FILENAME);
        std::fs::write(&manifest, br#"{"version":3}"#).unwrap();

        let disk = dir.path().join("sparse-disk");
        {
            let mut file = std::fs::File::create(&disk).unwrap();
            file.write_all(b"head").unwrap();
            file.seek(SeekFrom::Start(HOLE_END)).unwrap();
            file.write_all(b"tail").unwrap();
            file.sync_all().unwrap();
        }

        build_zstd_tar_archive(&archive_path, &manifest, &disk, 3).unwrap();

        // Where the builder reads hole information, assert the fixture really
        // did reproduce a real export's encoding — otherwise this test would
        // quietly stop covering the case it exists for.
        #[cfg(any(target_os = "linux", target_os = "android", target_os = "freebsd"))]
        {
            let file = std::fs::File::open(&archive_path).unwrap();
            let decoder = zstd::Decoder::new(file).unwrap();
            let mut probe = tar::Archive::new(decoder);
            let mut disk_member_type = None;
            for entry in probe.entries().unwrap() {
                let entry = entry.unwrap();
                if entry.path().unwrap().to_string_lossy() == disk_filenames::CONTAINER_DISK {
                    disk_member_type = Some(entry.header().entry_type());
                }
            }
            assert_eq!(
                disk_member_type,
                Some(tar::EntryType::GNUSparse),
                "the fixture must be encoded the way a real exported disk is"
            );
        }

        extract_archive(&archive_path, &extract_dir).expect("a sparse disk member must extract");

        let extracted = std::fs::read(extract_dir.join(disk_filenames::CONTAINER_DISK)).unwrap();
        assert_eq!(extracted.len() as u64, HOLE_END + 4);
        assert_eq!(&extracted[..4], b"head");
        assert_eq!(&extracted[HOLE_END as usize..], b"tail");
    }

    #[test]
    fn memory_checkpoint_manifest_omitted_for_disk_only_and_roundtrips_for_v8() {
        let disk_only = ArchiveManifest {
            version: ARCHIVE_VERSION,
            box_name: Some("disk-only".into()),
            image: "alpine:latest".into(),
            box_options: None,
            guest_disk_checksum: String::new(),
            container_disk_checksum: "sha256:abc".into(),
            memory_checkpoint: None,
            exported_at: "2026-11-25T00:00:00Z".into(),
        };
        let disk_only_json = serde_json::to_string(&disk_only).unwrap();
        assert!(!disk_only_json.contains("memory_checkpoint"));

        let full = ArchiveManifest {
            version: MEMORY_CHECKPOINT_ARCHIVE_VERSION,
            box_name: Some("full-ckpt".into()),
            image: "alpine:latest".into(),
            box_options: None,
            guest_disk_checksum: String::new(),
            container_disk_checksum: "sha256:disk".into(),
            memory_checkpoint: Some(MemoryCheckpointArchiveMetadata {
                platform: "linux-x86_64-kvm".into(),
                container_id: "a".repeat(64),
                vmstate_checksum: "sha256:vmstate".into(),
                vmstate_size_bytes: 1234,
                guest_rootfs_checksum: "sha256:guest".into(),
                outbound_disabled: true,
            }),
            exported_at: "2026-11-25T00:00:00Z".into(),
        };
        let full_json = serde_json::to_string(&full).unwrap();
        let decoded: ArchiveManifest = serde_json::from_str(&full_json).unwrap();
        assert_eq!(decoded.version, 8);
        assert_eq!(decoded.memory_checkpoint, full.memory_checkpoint);
    }

    #[test]
    fn build_zstd_tar_archive_with_memory_roundtrips_all_members() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("full.boxlite");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let manifest_path = dir.path().join(MANIFEST_FILENAME);
        let container_path = dir.path().join("container.qcow2");
        let vmstate_path = dir.path().join(VMSTATE_FILENAME);
        let guest_rootfs_path = dir.path().join(GUEST_ROOTFS_FILENAME);
        std::fs::write(&manifest_path, br#"{"version":8}"#).unwrap();
        std::fs::write(&container_path, b"disk-bytes").unwrap();
        std::fs::write(&vmstate_path, b"vmstate-bytes").unwrap();
        std::fs::write(&guest_rootfs_path, b"guest-rootfs-bytes").unwrap();

        build_zstd_tar_archive_with_memory(
            &archive_path,
            &manifest_path,
            &container_path,
            &vmstate_path,
            &guest_rootfs_path,
            3,
        )
        .unwrap();
        extract_archive(&archive_path, &extract_dir).unwrap();

        assert_eq!(
            std::fs::read(extract_dir.join(MANIFEST_FILENAME)).unwrap(),
            br#"{"version":8}"#
        );
        assert_eq!(
            std::fs::read(extract_dir.join(disk_filenames::CONTAINER_DISK)).unwrap(),
            b"disk-bytes"
        );
        assert_eq!(
            std::fs::read(extract_dir.join(VMSTATE_FILENAME)).unwrap(),
            b"vmstate-bytes"
        );
        assert_eq!(
            std::fs::read(extract_dir.join(GUEST_ROOTFS_FILENAME)).unwrap(),
            b"guest-rootfs-bytes"
        );
    }
}
