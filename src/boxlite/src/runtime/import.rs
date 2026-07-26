//! Box import from `.boxlite` archives.

use std::path::Path;
use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::disk::constants::filenames as disk_filenames;
use crate::litebox::LiteBox;
use crate::litebox::archive::{
    ArchiveManifest, MANIFEST_FILENAME, MAX_SUPPORTED_VERSION, extract_archive, move_file,
    sha256_file,
};
use crate::runtime::advanced_options::SecurityOptions;
use crate::runtime::options::{ArchiveImportPolicy, BoxArchive, BoxOptions, RootfsSpec};
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
    let import_policy = archive.import_policy();
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
    tokio::task::spawn_blocking(move || install_disks(&temp_path, &staging_clone))
        .await
        .map_err(|e| BoxliteError::Internal(format!("Import install task panicked: {}", e)))??;

    let litebox = runtime
        .provision_box(staging_dir, name, options, BoxStatus::Stopped)
        .await?;

    tracing::info!(
        box_id = %litebox.id(),
        elapsed_ms = t0.elapsed().as_millis() as u64,
        "Imported box from archive"
    );

    Ok(litebox)
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

/// Extract archive, parse manifest, verify checksums.
fn extract_and_validate(
    archive_path: &Path,
    layout: &crate::runtime::layout::FilesystemLayout,
) -> BoxliteResult<(ArchiveManifest, tempfile::TempDir)> {
    let temp_dir = tempfile::tempdir_in(layout.temp_dir())
        .map_err(|e| BoxliteError::Storage(format!("Failed to create temp directory: {}", e)))?;

    extract_archive(archive_path, temp_dir.path())?;

    let manifest_path = temp_dir.path().join(MANIFEST_FILENAME);
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

    let extracted_guest = temp_dir.path().join(disk_filenames::GUEST_ROOTFS_DISK);
    if extracted_guest.exists() && !manifest.guest_disk_checksum.is_empty() {
        let actual = sha256_file(&extracted_guest)?;
        if actual != manifest.guest_disk_checksum {
            return Err(BoxliteError::Storage(format!(
                "Guest disk checksum mismatch: expected {}, got {}",
                manifest.guest_disk_checksum, actual
            )));
        }
    }

    Ok((manifest, temp_dir))
}

/// Validate disk security and move disks into box_home/disks/.
fn install_disks(temp_dir: &Path, box_home: &Path) -> BoxliteResult<()> {
    // Security: Reject imported disks that reference backing files.
    // A crafted archive could include a qcow2 with a backing reference to
    // /etc/shadow or another box's disk, leaking data on first read.
    let extracted_container = temp_dir.join(disk_filenames::CONTAINER_DISK);
    validate_no_backing_references(&extracted_container)?;

    let extracted_guest = temp_dir.join(disk_filenames::GUEST_ROOTFS_DISK);
    if extracted_guest.exists() {
        validate_no_backing_references(&extracted_guest)?;
    }

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

    if extracted_guest.exists() {
        move_file(
            &extracted_guest,
            &disks_dir.join(disk_filenames::GUEST_ROOTFS_DISK),
        )?;
    }

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
            exported_at: "2026-07-26T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn untrusted_import_rejects_nested_virtualization() {
        let options = BoxOptions {
            nested_virtualization: true,
            ..Default::default()
        };

        let error =
            resolve_import_options(v3_manifest(options), ArchiveImportPolicy::UntrustedRemote)
                .unwrap_err();

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(error.to_string().contains("nested virtualization"));
    }

    #[test]
    fn untrusted_import_rejects_custom_kernel() {
        let mut options = BoxOptions::default();
        options.advanced.kernel = Some(crate::experimental::custom_kernel::KernelOptions::new(
            "/host/vmlinux",
        ));

        let error =
            resolve_import_options(v3_manifest(options), ArchiveImportPolicy::UntrustedRemote)
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
            resolve_import_options(v3_manifest(options), ArchiveImportPolicy::UntrustedRemote)
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
            resolve_import_options(v3_manifest(options), ArchiveImportPolicy::UntrustedRemote)
                .expect_err("untrusted archives must not select a server rootfs path");

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(error.to_string().contains("host rootfs paths"));
    }

    #[test]
    fn untrusted_import_replaces_archive_security_with_server_default() {
        let mut options = BoxOptions::default();
        options.advanced.security = SecurityOptions::disabled();

        let resolved =
            resolve_import_options(v3_manifest(options), ArchiveImportPolicy::UntrustedRemote)
                .unwrap();

        assert_eq!(resolved.advanced.security, SecurityOptions::default());
    }

    #[test]
    fn trusted_import_preserves_archive_configuration() {
        let mut options = BoxOptions {
            nested_virtualization: true,
            ..Default::default()
        };
        options.advanced.security = SecurityOptions::disabled();

        let resolved =
            resolve_import_options(v3_manifest(options), ArchiveImportPolicy::Trusted).unwrap();

        assert!(resolved.nested_virtualization);
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
            exported_at: "2026-01-01T00:00:00Z".into(),
        };

        let error = options_from_manifest(&manifest)
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
