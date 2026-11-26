use super::{tests::v3_manifest, *};
use crate::runtime::options::BoxliteOptions;
use tempfile::TempDir;

#[test]
fn checkpoint_manifest_is_checked_before_archive_members_are_extracted() {
    use crate::litebox::archive::{MemoryCheckpointArchiveMetadata, build_zstd_tar_archive};
    use crate::runtime::layout::FilesystemLayout;

    let dir = TempDir::new().unwrap();
    let layout = FilesystemLayout::new(dir.path().join("home"), Default::default());
    std::fs::create_dir_all(layout.temp_dir()).unwrap();

    let container_path = dir.path().join("disk.qcow2");
    std::fs::write(&container_path, b"disk").unwrap();
    let manifest_path = dir.path().join(MANIFEST_FILENAME);
    let archive_path = dir.path().join("ckpt.boxlite");

    let mut manifest = v3_manifest(BoxOptions::default());
    manifest.version = crate::litebox::archive::MEMORY_CHECKPOINT_ARCHIVE_VERSION;
    manifest.container_disk_checksum = "0000".into();
    manifest.memory_checkpoint = Some(MemoryCheckpointArchiveMetadata {
        platform: crate::litebox::archive::current_checkpoint_platform()
            .unwrap_or("linux-x86_64-kvm")
            .to_string(),
        container_id: "cont-123".into(),
        vmstate_checksum: "0000".into(),
        vmstate_size_bytes: 10,
        guest_rootfs_checksum: "0000".into(),
        outbound_disabled: false,
    });
    for policy in [
        ArchiveImportPolicy::UntrustedRemote,
        ArchiveImportPolicy::Trusted,
    ] {
        if policy == ArchiveImportPolicy::Trusted {
            manifest.memory_checkpoint.as_mut().unwrap().platform = "other-arch-vmm".into();
        }
        let mut archive = tar::Builder::new(std::fs::File::create(&archive_path).unwrap());
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        archive
            .append_path_with_name(&manifest_path, MANIFEST_FILENAME)
            .unwrap();
        archive
            .append_path_with_name(&container_path, disk_filenames::CONTAINER_DISK)
            .unwrap();
        // This later member would fail extraction. The policy/platform error must win.
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        archive
            .append_link(&mut header, VMSTATE_FILENAME, "unused")
            .unwrap();
        archive.finish().unwrap();

        let err = extract_and_validate_with_policy(&archive_path, &layout, policy)
            .expect_err("manifest must be rejected before disk extraction");
        assert!(matches!(err, BoxliteError::Unsupported(_)), "{err:?}");
        assert!(
            std::fs::read_dir(layout.temp_dir())
                .unwrap()
                .next()
                .is_none()
        );
    }

    let memory = manifest.memory_checkpoint.take().unwrap();
    for (version, checkpoint, checksum, expected) in [
        (
            MEMORY_CHECKPOINT_ARCHIVE_VERSION,
            None,
            "0000",
            "memory_checkpoint",
        ),
        (
            PUBLISHED_PORTS_ARCHIVE_VERSION,
            Some(memory.clone()),
            "0000",
            "memory_checkpoint",
        ),
        (
            MEMORY_CHECKPOINT_ARCHIVE_VERSION,
            Some(memory),
            "",
            "container disk checksum",
        ),
    ] {
        manifest.version = version;
        manifest.memory_checkpoint = checkpoint;
        manifest.container_disk_checksum = checksum.into();
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        build_zstd_tar_archive(&archive_path, &manifest_path, &container_path, 1).unwrap();
        let err = extract_and_validate(&archive_path, &layout).unwrap_err();
        assert!(
            matches!(err, BoxliteError::Storage(ref message) if message.contains(expected)),
            "{err:?}"
        );
    }
}

fn build_test_memory_checkpoint_archive(
    dir: &Path,
    platform: &str,
    container_id: &str,
    tamper_vmstate_checksum: bool,
) -> std::path::PathBuf {
    let disk = dir.join("disk.qcow2");
    let vmstate = dir.join(VMSTATE_FILENAME);
    let guest_rootfs = dir.join(GUEST_ROOTFS_FILENAME);
    crate::disk::qcow2::write_test_qcow2(&disk, None);
    std::fs::write(&vmstate, b"fake-vmstate-payload").unwrap();
    std::fs::write(&guest_rootfs, b"fake-guest-rootfs").unwrap();

    let vmstate_checksum = if tamper_vmstate_checksum {
        "sha256:0000000000000000000000000000000000000000000000000000000000000000".into()
    } else {
        sha256_file(&vmstate).unwrap()
    };

    let manifest = ArchiveManifest {
        version: crate::litebox::archive::MEMORY_CHECKPOINT_ARCHIVE_VERSION,
        box_name: Some("ckpt-box".into()),
        image: "alpine:latest".into(),
        box_options: Some(BoxOptions::default()),
        guest_disk_checksum: String::new(),
        container_disk_checksum: sha256_file(&disk).unwrap(),
        memory_checkpoint: Some(MemoryCheckpointArchiveMetadata {
            platform: platform.into(),
            container_id: container_id.into(),
            vmstate_checksum,
            vmstate_size_bytes: std::fs::metadata(&vmstate).unwrap().len(),
            guest_rootfs_checksum: sha256_file(&guest_rootfs).unwrap(),
            outbound_disabled: false,
        }),
        exported_at: "2026-11-25T00:00:00Z".into(),
    };
    let manifest_path = dir.join(MANIFEST_FILENAME);
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

    let archive_path = dir.join("memory-ckpt.boxlite");
    crate::litebox::archive::build_zstd_tar_archive_with_memory(
        &archive_path,
        &manifest_path,
        &disk,
        &vmstate,
        &guest_rootfs,
        1,
    )
    .unwrap();
    archive_path
}

#[tokio::test]
async fn memory_checkpoint_import_rejects_untrusted_tampered_and_mismatched_platform() {
    let current_platform = current_checkpoint_platform().unwrap_or("linux-x86_64-kvm");
    let wrong_platform = if current_platform == "macos-aarch64-hvf" {
        "linux-x86_64-kvm"
    } else {
        "macos-aarch64-hvf"
    };
    let valid_cid = ContainerID::new().as_str().to_string();

    // 1. Untrusted upload policy rejected with Unsupported.
    {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().join("runtime"),
            ..Default::default()
        })
        .unwrap();
        let path =
            build_test_memory_checkpoint_archive(home.path(), current_platform, &valid_cid, false);
        let err = import_box(&runtime, BoxArchive::from_untrusted_upload(&path), None)
            .await
            .err()
            .expect("untrusted memory checkpoint import must fail");
        assert!(matches!(err, BoxliteError::Unsupported(_)), "{err:?}");
        assert!(runtime.list_info().await.unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(runtime.layout.temp_dir())
                .unwrap()
                .count(),
            0
        );
    }

    // 2. Tampered vmstate checksum rejected without leaking boxes or temp dirs.
    {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().join("runtime"),
            ..Default::default()
        })
        .unwrap();
        let path =
            build_test_memory_checkpoint_archive(home.path(), current_platform, &valid_cid, true);
        let err = import_box(&runtime, BoxArchive::new(&path), None)
            .await
            .err()
            .expect("tampered vmstate checksum must fail");
        if current_checkpoint_platform().is_some() {
            assert!(
                err.to_string().contains("VM state checksum mismatch"),
                "{err:?}"
            );
        } else {
            assert!(matches!(err, BoxliteError::Unsupported(_)), "{err:?}");
        }
        assert!(runtime.list_info().await.unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(runtime.layout.temp_dir())
                .unwrap()
                .count(),
            0
        );
    }

    // 3. Platform mismatch rejected with Unsupported.
    {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().join("runtime"),
            ..Default::default()
        })
        .unwrap();
        let path =
            build_test_memory_checkpoint_archive(home.path(), wrong_platform, &valid_cid, false);
        let err = import_box(&runtime, BoxArchive::new(&path), None)
            .await
            .err()
            .expect("mismatched platform must fail");
        assert!(matches!(err, BoxliteError::Unsupported(_)), "{err:?}");
        assert!(runtime.list_info().await.unwrap().is_empty());
    }

    // 4. Invalid container_id rejected.
    {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().join("runtime"),
            ..Default::default()
        })
        .unwrap();
        let path = build_test_memory_checkpoint_archive(
            home.path(),
            current_platform,
            "not-a-valid-container-id",
            false,
        );
        let err = import_box(&runtime, BoxArchive::new(&path), None)
            .await
            .err()
            .expect("invalid container_id must fail");
        assert!(matches!(err, BoxliteError::Storage(_)), "{err:?}");
        assert!(runtime.list_info().await.unwrap().is_empty());
    }

    // 5. Valid trusted v8 archive provisions Configured box with staged checkpoint/.
    if current_checkpoint_platform().is_some() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().join("runtime"),
            ..Default::default()
        })
        .unwrap();
        let path =
            build_test_memory_checkpoint_archive(home.path(), current_platform, &valid_cid, false);
        let imported = import_box(&runtime, BoxArchive::new(&path), Some("restored".into()))
            .await
            .expect("valid v8 memory checkpoint archive must import");
        let info = imported.info().await.unwrap();
        assert_eq!(info.status, BoxStatus::Configured);
        let (config, state) = runtime
            .box_manager
            .box_by_id(imported.id())
            .unwrap()
            .unwrap();
        assert_eq!(config.container.id.as_str(), valid_cid);
        assert!(state.pending_memory_restore);
        let box_home = runtime.layout.boxes_dir().join(imported.id().as_str());
        assert!(box_home.join("disks/disk.qcow2").is_file());
        assert!(box_home.join("checkpoint/vmstate.krun").is_file());
        assert!(box_home.join("checkpoint/guest-rootfs.ext4").is_file());
    }
}
