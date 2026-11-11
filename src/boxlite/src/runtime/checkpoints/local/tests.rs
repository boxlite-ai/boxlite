use super::*;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::litebox::archive::{
    ArchiveManifest, archive_version_for_options, build_zstd_tar_archive, sha256_file,
};
use crate::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec, VolumeSpec};
use crate::runtime::rt_impl::RuntimeImpl;
use crate::{BoxStatus, CheckpointHandle, CheckpointState};

const IMAGE: &str = "example.invalid/acme/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn archive_source(archive: &BoxArchive) -> super::CheckpointArchiveSource {
    super::CheckpointArchiveSource {
        path: archive.path().to_owned(),
        sha256: sha256_file(archive.path()).unwrap(),
        pinned_image: IMAGE.into(),
    }
}

#[tokio::test]
async fn checkpoint_capture_requires_stopped_source() {
    for status in [
        BoxStatus::Configured,
        BoxStatus::Running,
        BoxStatus::Paused,
        BoxStatus::Failed,
    ] {
        let (runtime, checkpoints, temporary) = setup();
        let bx = runtime
            .import_box(
                source_archive(temporary.path(), &source_options()),
                Some("source".into()),
            )
            .await
            .unwrap();
        let id = bx.id().clone();
        drop(bx);
        let (_, mut state) = runtime.box_manager.box_by_id(&id).unwrap().unwrap();
        state.force_status(status);
        runtime.box_manager.save_box(&id, &state).unwrap();
        assert!(
            matches!(checkpoints.create("source", Some("base".into())).await,
            Err(BoxliteError::InvalidState(message)) if message.contains("stopped")),
            "accepted or misclassified {status:?}"
        );
        assert!(checkpoints.list().await.unwrap().is_empty());
        assert_eq!(
            runtime.get_info("source").await.unwrap().unwrap().status,
            status
        );
    }
}

#[tokio::test]
async fn checkpoint_capture_blocks_start_until_export_finishes() {
    let (runtime, checkpoints, temporary) = setup();
    let bx = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("source".into()),
        )
        .await
        .unwrap();
    let (config, state) = runtime.box_manager.box_by_id(bx.id()).unwrap().unwrap();
    let (implementation, _) = runtime.get_or_create_box_impl(config, state);
    let disk = implementation.disk_ops.lock().await;
    let capture = tokio::spawn({
        let checkpoints = checkpoints.clone();
        async move { checkpoints.create("source", Some("base".into())).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while runtime
            .checkpoint_lifecycle
            .read(Some(bx.id().as_ref()), Some("source"))
            .is_ok()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("capture did not reserve its stopped source");
    assert!(matches!(
        bx.start().await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert_eq!(bx.info().await.unwrap().status, BoxStatus::Stopped);
    drop(disk);
    capture.await.unwrap().unwrap();
    assert!(
        runtime
            .checkpoint_lifecycle
            .read(Some(bx.id().as_ref()), Some("source"))
            .is_ok()
    );
}

#[tokio::test]
async fn downloaded_checkpoint_preparation_rebinds_only_platform_identity_before_native_import() {
    let (runtime, checkpoints, temporary) = setup();
    let mut options = source_options();
    options.rootfs = RootfsSpec::Image("example.invalid/acme/app:moved".into());
    for key in [
        "BOXLITE_BOX_ID",
        "BOXLITE_ORGANIZATION_ID",
        "BOXLITE_REGION_ID",
        "BOXLITE_OTEL_ENDPOINT",
        "BOXLITE_TRACEPARENT",
        "BOXLITE_TRACESTATE",
    ] {
        options.env.push((key.into(), "old-identity".into()));
    }
    let archive = source_archive(temporary.path(), &options);
    let unpacked = tempfile::tempdir().unwrap();
    crate::litebox::archive::extract_archive(archive.path(), unpacked.path()).unwrap();
    let manifest_path = unpacked.path().join("manifest.json");
    let mut original: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    original["future_compatible_field"] = serde_json::json!({"hint":"preserve"});
    original["box_options"]["future_option"] = serde_json::json!(["unknown", "compatible"]);
    std::fs::write(&manifest_path, serde_json::to_vec(&original).unwrap()).unwrap();
    let disk = unpacked
        .path()
        .join(crate::disk::constants::filenames::CONTAINER_DISK);
    build_zstd_tar_archive(archive.path(), &manifest_path, &disk, 1).unwrap();
    let source = archive_source(&archive);
    crate::images::test_support::seed_cached_build(
        &runtime.image_manager,
        IMAGE,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .await;
    let platform = std::collections::BTreeMap::from([
        ("BOXLITE_BOX_ID".into(), "target-public-id".into()),
        ("BOXLITE_ORGANIZATION_ID".into(), "target-org".into()),
        ("BOXLITE_REGION_ID".into(), "target-region".into()),
    ]);
    let prepared = checkpoints
        .prepare_archive(source.clone(), Some(platform))
        .await
        .unwrap();
    assert!(runtime.list_info().await.unwrap().is_empty());
    assert_eq!(prepared.pinned_image(), IMAGE);
    assert_eq!(sha256_file(archive.path()).unwrap(), source.sha256);
    let mut cloud_source = source.clone();
    cloud_source.sha256 = cloud_source
        .sha256
        .strip_prefix("sha256:")
        .unwrap()
        .to_owned();
    let cloud_prepared = checkpoints
        .prepare_archive(cloud_source, None)
        .await
        .unwrap();
    assert!(cloud_prepared.path().exists());
    drop(cloud_prepared);
    let derived_path = prepared.path().to_owned();
    assert_eq!(
        prepared.size_bytes(),
        std::fs::metadata(&derived_path).unwrap().len()
    );
    assert_eq!(
        format!("sha256:{}", prepared.sha256()),
        sha256_file(&derived_path).unwrap()
    );
    let derived_directory = tempfile::tempdir().unwrap();
    crate::litebox::archive::extract_archive(prepared.path(), derived_directory.path()).unwrap();
    let derived: serde_json::Value = serde_json::from_slice(
        &std::fs::read(derived_directory.path().join("manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        derived["future_compatible_field"],
        original["future_compatible_field"]
    );
    assert_eq!(
        derived["box_options"]["future_option"],
        original["box_options"]["future_option"]
    );
    assert_eq!(
        derived["container_disk_checksum"],
        original["container_disk_checksum"]
    );
    assert_eq!(
        sha256_file(
            &derived_directory
                .path()
                .join(crate::disk::constants::filenames::CONTAINER_DISK)
        )
        .unwrap(),
        sha256_file(&disk).unwrap()
    );
    let imported = runtime
        .import_box(BoxArchive::new(prepared.path()), Some("target".into()))
        .await
        .unwrap();
    let (config, _) = runtime
        .box_manager
        .box_by_id(imported.id())
        .unwrap()
        .unwrap();
    let env: std::collections::BTreeMap<_, _> = config.options.env.iter().cloned().collect();
    assert_eq!(env.get("APP_MODE").map(String::as_str), Some("captured"));
    assert_eq!(
        env.get("BOXLITE_USER_KEY").map(String::as_str),
        Some("keep")
    );
    assert_eq!(
        env.get("BOXLITE_BOX_ID").map(String::as_str),
        Some("target-public-id")
    );
    assert_eq!(
        env.get("BOXLITE_ORGANIZATION_ID").map(String::as_str),
        Some("target-org")
    );
    assert!(!env.contains_key("BOXLITE_TRACEPARENT"));
    assert!(!env.contains_key("BOXLITE_TRACESTATE"));
    assert!(!env.contains_key("BOXLITE_OTEL_ENDPOINT"));
    assert!(matches!(&config.options.rootfs, RootfsSpec::Image(image) if image == IMAGE));
    assert_eq!(config.options.cpus, options.cpus);
    assert_eq!(config.options.memory_mib, options.memory_mib);
    assert_eq!(config.options.cmd, options.cmd);
    assert_eq!(imported.info().await.unwrap().status, BoxStatus::Stopped);
    drop(prepared);
    assert!(!derived_path.exists());
    assert_eq!(sha256_file(archive.path()).unwrap(), source.sha256);
}

#[tokio::test]
async fn downloaded_checkpoint_preparation_refuses_unverified_bytes_or_user_configuration_overrides()
 {
    let (runtime, checkpoints, temporary) = setup();
    let archive = source_archive(temporary.path(), &source_options());
    let mut source = archive_source(&archive);
    source.sha256 = "f".repeat(64);
    assert!(matches!(
        checkpoints.prepare_archive(source, None).await,
        Err(BoxliteError::Storage(_))
    ));
    let platform = std::collections::BTreeMap::from([
        ("BOXLITE_BOX_ID".into(), "target".into()),
        ("APP_MODE".into(), "override".into()),
    ]);
    assert!(matches!(
        checkpoints
            .prepare_archive(archive_source(&archive), Some(platform))
            .await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    assert!(matches!(
        checkpoints
            .prepare_archive(archive_source(&archive), Some(Default::default()))
            .await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    assert!(runtime.list_info().await.unwrap().is_empty());
    assert!(archive.path().exists());
}

#[tokio::test]
async fn downloaded_checkpoint_preparation_reuses_native_disk_validation() {
    let (runtime, checkpoints, temporary) = setup();
    let archive = source_archive(temporary.path(), &source_options());
    let unpacked = tempfile::tempdir().unwrap();
    crate::litebox::archive::extract_archive(archive.path(), unpacked.path()).unwrap();
    let disk = unpacked
        .path()
        .join(crate::disk::constants::filenames::CONTAINER_DISK);
    std::fs::write(&disk, "not a qcow2 disk").unwrap();
    build_zstd_tar_archive(
        archive.path(),
        &unpacked.path().join("manifest.json"),
        &disk,
        1,
    )
    .unwrap();
    assert!(
        checkpoints
            .prepare_archive(archive_source(&archive), None)
            .await
            .is_err()
    );
    assert!(runtime.list_info().await.unwrap().is_empty());
}

fn source_options() -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image(IMAGE.into()),
        cpus: Some(3.0),
        memory_mib: Some(768),
        disk_size_gb: Some(2),
        env: vec![
            ("APP_MODE".into(), "captured".into()),
            ("BOXLITE_USER_KEY".into(), "keep".into()),
        ],
        entrypoint: Some(vec!["/bin/sh".into()]),
        cmd: Some(vec!["-c".into(), "echo captured".into()]),
        working_dir: Some("/app".into()),
        detach: true,
        auto_delete: Some(0),
        ..Default::default()
    }
}

#[tokio::test]
async fn checkpoint_preparation_rejects_missing_boot_assets_without_changing_target() {
    let (runtime, checkpoints, temporary) = setup();
    let target = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("target".into()),
        )
        .await
        .unwrap();
    let original_id = target.id().clone();
    let mut options = source_options();
    let missing_kernel = temporary.path().join("missing-kernel");
    let initramfs = temporary.path().join("initramfs");
    std::fs::write(&initramfs, "fixture").unwrap();
    options.advanced.kernel = Some(
        crate::experimental::custom_kernel::KernelOptions::new(&missing_kernel)
            .with_format(crate::experimental::custom_kernel::KernelFormat::Raw)
            .with_initramfs(initramfs),
    );
    let archive_dir = tempfile::tempdir().unwrap();
    let archive = source_archive(archive_dir.path(), &options);
    let error = match checkpoints
        .prepare_archive(archive_source(&archive), None)
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("missing boot asset passed checkpoint preparation"),
    };
    assert!(error.to_string().contains("custom kernel"), "{error}");
    assert!(
        error.to_string().contains(missing_kernel.to_str().unwrap()),
        "{error}"
    );
    assert_eq!(
        runtime.get_info("target").await.unwrap().unwrap().id,
        original_id
    );
    assert!(archive.path().is_file());
    assert_eq!(runtime.list_info().await.unwrap().len(), 1);
}

#[tokio::test]
async fn checkpoint_preparation_requires_the_target_runtime_feature_opt_in() {
    let (runtime, checkpoints, temporary) = setup();
    let mut options = source_options();
    options.advanced.nested_virtualization = true;
    let archive = source_archive(temporary.path(), &options);
    let error = match checkpoints
        .prepare_archive(archive_source(&archive), None)
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("checkpoint bypassed the target runtime feature gate"),
    };
    assert!(
        error
            .to_string()
            .contains("nested virtualization support is disabled"),
        "{error}"
    );
    assert!(runtime.list_info().await.unwrap().is_empty());
    assert!(archive.path().is_file());

    let opted_in = RuntimeImpl::initialize(
        BoxliteOptions {
            home_dir: temporary.path().join("opted-in-runtime"),
            ..Default::default()
        },
        crate::experimental::ExperimentalFeatures::parse("nested-virtualization").unwrap(),
        false,
    )
    .unwrap();
    crate::images::test_support::seed_cached_build(
        &opted_in.image_manager,
        IMAGE,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .await;
    let opted_in_checkpoints = LocalCheckpoints::new(
        Arc::clone(&opted_in),
        temporary.path().join("opted-in-checkpoints"),
    );
    let prepared = opted_in_checkpoints
        .prepare_archive(archive_source(&archive), None)
        .await
        .unwrap();
    assert!(prepared.path().is_file());
    assert!(opted_in.list_info().await.unwrap().is_empty());
}

/// Exercise native QCOW2 creation/flattening and archive packing, without a VM.
fn source_archive(directory: &std::path::Path, options: &BoxOptions) -> BoxArchive {
    let raw = directory.join("raw");
    let file = std::fs::File::create(&raw).unwrap();
    file.set_len(1024 * 1024).unwrap();
    let cow_path = directory.join("child.qcow2");
    let cow = Qcow2Helper::create_cow_child_disk(&raw, BackingFormat::Raw, &cow_path, 1024 * 1024)
        .unwrap();
    let disk = directory.join("disk.qcow2");
    Qcow2Helper::flatten(cow.path(), &disk).unwrap();
    let manifest = ArchiveManifest {
        version: archive_version_for_options(options),
        box_name: Some("source".into()),
        image: IMAGE.into(),
        box_options: Some(options.clone()),
        guest_disk_checksum: String::new(),
        container_disk_checksum: sha256_file(&disk).unwrap(),
        exported_at: chrono::Utc::now().to_rfc3339(),
    };
    let manifest_path = directory.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let archive = directory.join("source.boxlite");
    build_zstd_tar_archive(&archive, &manifest_path, &disk, 1).unwrap();
    BoxArchive::new(archive)
}

fn setup() -> (SharedRuntimeImpl, CheckpointHandle, tempfile::TempDir) {
    let temporary = tempfile::tempdir().unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: temporary.path().join("runtime"),
        ..Default::default()
    })
    .unwrap();
    let local = LocalCheckpoints::new(Arc::clone(&runtime), temporary.path().join("checkpoints"));
    (runtime, CheckpointHandle::new(Arc::new(local)), temporary)
}

#[tokio::test]
async fn checkpoint_preparation_rejects_a_shutdown_runtime_before_archive_work() {
    let (runtime, checkpoints, temporary) = setup();
    let archive = source_archive(temporary.path(), &source_options());
    crate::images::test_support::seed_cached_build(
        &runtime.image_manager,
        IMAGE,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .await;
    runtime.shutdown(None).await.unwrap();
    assert!(matches!(
        checkpoints
            .prepare_archive(archive_source(&archive), None)
            .await,
        Err(BoxliteError::Stopped(_))
    ));
}

#[tokio::test]
async fn checkpoint_replacement_after_shutdown_preserves_the_original_box() {
    let (runtime, checkpoints, temporary) = setup();
    let original = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("target".into()),
        )
        .await
        .unwrap();
    let checkpoint = checkpoints
        .create("target", Some("base".into()))
        .await
        .unwrap();
    crate::images::test_support::seed_cached_build(
        &runtime.image_manager,
        IMAGE,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .await;
    runtime.shutdown(None).await.unwrap();
    assert!(matches!(
        checkpoints
            .import_box(&checkpoint.id, None, Some("target"))
            .await,
        Err(BoxliteError::Stopped(_))
    ));
    assert_eq!(
        runtime.get_info("target").await.unwrap().unwrap().id,
        *original.id()
    );
}

#[tokio::test]
async fn checkpoint_deletion_metadata_remains_visible_without_allowing_archive_use() {
    let (runtime, checkpoints, temporary) = setup();
    runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("source".into()),
        )
        .await
        .unwrap();
    let checkpoint = checkpoints
        .create("source", Some("base".into()))
        .await
        .unwrap();
    let root = temporary.path().join("checkpoints");
    let deleting = root.join(format!(".deleting-{}", checkpoint.id));
    std::fs::rename(root.join(&checkpoint.id), &deleting).unwrap();
    std::fs::rename(
        deleting.join("checkpoint.json"),
        root.join(format!(".deleting-{}.json", checkpoint.id)),
    )
    .unwrap();
    assert_eq!(
        checkpoints.get(&checkpoint.name).await.unwrap().state,
        CheckpointState::Deleting
    );
    assert!(matches!(
        checkpoints.import_box(&checkpoint.id, None, None).await,
        Err(BoxliteError::InvalidState(_))
    ));
    checkpoints.remove(&checkpoint.name, false).await.unwrap();
    assert!(checkpoints.list().await.unwrap().is_empty());
    assert!(runtime.get_info("source").await.unwrap().is_some());
}

#[tokio::test]
async fn checkpoint_survives_source_deletion_and_import_preserves_captured_options() {
    let (runtime, checkpoints, temporary) = setup();
    let options = source_options();
    let source = runtime
        .import_box(
            source_archive(temporary.path(), &options),
            Some("source".into()),
        )
        .await
        .unwrap();
    let original_id = source.id().clone();
    let checkpoint = checkpoints
        .create("source", Some("base".into()))
        .await
        .unwrap();
    assert_eq!(checkpoint.state, CheckpointState::Ready);
    assert_eq!(checkpoint.source_box_id, original_id.to_string());
    assert!(checkpoint.size_bytes > 0);

    runtime.remove(original_id.as_ref(), false).unwrap();
    assert!(
        runtime
            .get_info(original_id.as_ref())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(checkpoints.list().await.unwrap(), vec![checkpoint.clone()]);

    // This seeds the real image store/config reader, rather than replacing
    // native import or allowing a moved tag to supply a new configuration.
    crate::images::test_support::seed_cached_build(
        &runtime.image_manager,
        IMAGE,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .await;
    let restored = checkpoints
        .import_box(&checkpoint.id, Some("restored".into()), None)
        .await
        .unwrap();
    assert_ne!(restored.id(), &original_id);
    let info = restored.info().await.unwrap();
    assert_eq!(info.name.as_deref(), Some("restored"));
    assert_eq!(info.status, BoxStatus::Stopped);
    let (config, _) = runtime
        .box_manager
        .box_by_id(restored.id())
        .unwrap()
        .unwrap();
    assert_eq!(config.options.cpus, options.cpus);
    assert_eq!(config.options.memory_mib, options.memory_mib);
    assert_eq!(config.options.disk_size_gb, options.disk_size_gb);
    assert_eq!(config.options.env, options.env);
    assert_eq!(config.options.entrypoint, options.entrypoint);
    assert_eq!(config.options.cmd, options.cmd);
    assert_eq!(config.options.working_dir, options.working_dir);
    assert_eq!(checkpoints.get(&checkpoint.id).await.unwrap(), checkpoint);

    checkpoints.remove("base", false).await.unwrap();
    assert!(checkpoints.list().await.unwrap().is_empty());
    assert!(runtime.get_info("restored").await.unwrap().is_some());
}

#[tokio::test]
async fn external_volumes_are_refused_before_export_or_catalog_creation() {
    let (runtime, checkpoints, temporary) = setup();
    let mut options = source_options();
    options
        .volumes
        .push(VolumeSpec::bind_mount("/tmp", "/external"));
    runtime
        .import_box(
            source_archive(temporary.path(), &options),
            Some("source".into()),
        )
        .await
        .unwrap();
    assert!(matches!(
        checkpoints.create("source", None).await,
        Err(BoxliteError::Unsupported(_))
    ));
    assert!(!temporary.path().join("checkpoints").exists());
    assert!(runtime.get_info("source").await.unwrap().is_some());
}

#[tokio::test]
async fn missing_sources_and_archives_do_not_create_or_destroy_boxes() {
    let (runtime, checkpoints, _temporary) = setup();
    assert!(matches!(
        checkpoints.create("missing", None).await,
        Err(BoxliteError::NotFound(_))
    ));
    assert!(matches!(
        checkpoints
            .import_box("missing", Some("new".into()), None)
            .await,
        Err(BoxliteError::NotFound(_))
    ));
    assert!(runtime.list_info().await.unwrap().is_empty());
}

#[tokio::test]
async fn public_runtime_uses_its_configured_catalog_directory() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("separate-archives");
    let runtime = crate::BoxliteRuntime::new_for_test(BoxliteOptions {
        home_dir: temporary.path().join("home"),
        checkpoints_dir: Some(directory.clone()),
        ..Default::default()
    })
    .unwrap();
    runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("source".into()),
        )
        .await
        .unwrap();
    let checkpoints = runtime.checkpoints();
    let info = checkpoints
        .create("source", Some("custom".into()))
        .await
        .unwrap();
    assert!(directory.join(&info.id).join("checkpoint.json").is_file());
    assert!(!temporary.path().join("home/checkpoints").exists());
    assert_eq!(checkpoints.get("custom").await.unwrap(), info);
}

#[test]
fn recorded_build_pins_mutable_tags_without_losing_registry_ports() {
    let options = BoxOptions {
        rootfs: RootfsSpec::Image("registry.example:5000/acme/app:v2".into()),
        ..Default::default()
    };
    let resolved = crate::ResolvedImage {
        manifest_digest: format!("sha256:{}", "b".repeat(64)),
        total_layer_size: 0,
    };
    assert_eq!(
        archive::pinned_image(&options, Some(&resolved)).unwrap(),
        format!("registry.example:5000/acme/app@sha256:{}", "b".repeat(64))
    );
    assert!(matches!(
        archive::pinned_image(&options, None),
        Err(BoxliteError::InvalidState(_))
    ));
}

#[tokio::test]
async fn recover_preserves_the_target_name_and_replays_the_accepted_native_result() {
    let (runtime, checkpoints, temporary) = setup();
    let options = source_options();
    runtime
        .import_box(
            source_archive(temporary.path(), &options),
            Some("source".into()),
        )
        .await
        .unwrap();
    let checkpoint = checkpoints
        .create("source", Some("base".into()))
        .await
        .unwrap();
    let mut target_options = options.clone();
    target_options.cpus = Some(1.0);
    target_options.env = vec![("APP_MODE".into(), "old-target".into())];
    let target = runtime
        .import_box(
            source_archive(temporary.path(), &target_options),
            Some("target".into()),
        )
        .await
        .unwrap();
    let old_id = target.id().to_string();
    crate::images::test_support::seed_cached_build(
        &runtime.image_manager,
        IMAGE,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .await;

    let recovered = checkpoints
        .import_box(&checkpoint.id, None, Some("target"))
        .await
        .unwrap();
    assert_ne!(recovered.id().as_ref(), old_id);
    assert!(matches!(
        target.start().await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert_eq!(recovered.name(), Some("target"));
    assert_eq!(recovered.info().await.unwrap().status, BoxStatus::Stopped);
    assert!(runtime.get_info(&old_id).await.unwrap().is_none());
    let (config, _) = runtime
        .box_manager
        .box_by_id(recovered.id())
        .unwrap()
        .unwrap();
    assert_eq!(config.options.cpus, options.cpus);
    assert_eq!(config.options.env, options.env);
    assert_eq!(config.options.entrypoint, options.entrypoint);

    // A retry using the superseded ID must adopt the result, never delete it
    // and import a second box. This exercises the public recover entry point.
    let replay = checkpoints
        .import_box(&checkpoint.id, None, Some(&old_id))
        .await
        .unwrap();
    assert_eq!(replay.id(), recovered.id());
    assert_eq!(runtime.list_info().await.unwrap().len(), 2);
    assert_eq!(checkpoints.get(&checkpoint.id).await.unwrap(), checkpoint);
}

#[tokio::test]
async fn checkpoint_recovery_adopts_import_when_completion_receipt_is_missing() {
    for (restart, name) in [
        (false, Some("target")),
        (true, Some("target")),
        (true, None),
    ] {
        let (mut runtime, mut checkpoints, temporary) = setup();
        runtime
            .import_box(
                source_archive(temporary.path(), &source_options()),
                Some("source".into()),
            )
            .await
            .unwrap();
        let checkpoint = checkpoints.create("source", None).await.unwrap();
        let target = runtime
            .import_box(
                source_archive(temporary.path(), &source_options()),
                name.map(str::to_owned),
            )
            .await
            .unwrap();
        let original_id = target.id().to_string();
        crate::images::test_support::seed_cached_build(
            &runtime.image_manager,
            IMAGE,
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .await;
        let imported = checkpoints
            .import_box(&checkpoint.id, None, Some(&original_id))
            .await
            .unwrap();
        let imported_id = imported.id().clone();
        let catalog = Catalog::new(temporary.path().join("checkpoints"));
        let mut pending = catalog.recovery(&original_id).unwrap().unwrap();
        // Keep the actual imported Box and production journal, but roll back
        // its final receipt to model a failed completion write after import.
        pending.accepted_id = None;
        catalog.save_recovery(&pending).unwrap();
        drop(imported);
        drop(target);
        if restart {
            drop(checkpoints);
            drop(runtime);
            runtime = RuntimeImpl::new_for_test(BoxliteOptions {
                home_dir: temporary.path().join("runtime"),
                ..Default::default()
            })
            .unwrap();
            checkpoints = CheckpointHandle::new(Arc::new(LocalCheckpoints::new(
                Arc::clone(&runtime),
                temporary.path().join("checkpoints"),
            )));
        }
        let pending_box = runtime.get(imported_id.as_str()).await.unwrap().unwrap();
        assert!(matches!(
            pending_box.start().await,
            Err(BoxliteError::InvalidState(_))
        ));
        drop(pending_box);
        let replay = checkpoints
            .import_box(&checkpoint.id, None, Some(&original_id))
            .await
            .expect("a committed import must remain recoverable without its final receipt");
        assert_eq!(
            replay.id(),
            &imported_id,
            "retry must reuse the imported Box"
        );
        assert_eq!(runtime.list_info().await.unwrap().len(), 2);
        assert_eq!(
            catalog.recovery(&original_id).unwrap().unwrap().accepted_id,
            Some(imported_id.to_string())
        );
        let mut pending = catalog.recovery(&original_id).unwrap().unwrap();
        pending.accepted_id = None;
        catalog.save_recovery(&pending).unwrap();
        runtime.remove(imported_id.as_str(), false).unwrap();
        assert!(catalog.recovery(&original_id).unwrap().is_none());
        checkpoints.remove(&checkpoint.id, false).await.unwrap();
    }
}

#[tokio::test]
async fn damaged_checkpoint_does_not_remove_the_recovery_target() {
    use std::os::unix::fs::PermissionsExt;
    let (runtime, checkpoints, temporary) = setup();
    runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("source".into()),
        )
        .await
        .unwrap();
    let checkpoint = checkpoints
        .create("source", Some("base".into()))
        .await
        .unwrap();
    let target = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("target".into()),
        )
        .await
        .unwrap();
    let target_id = target.id().clone();
    let path = temporary
        .path()
        .join("checkpoints")
        .join(&checkpoint.id)
        .join("archive.boxlite");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[0] ^= 1;
    std::fs::write(&path, bytes).unwrap();
    assert!(matches!(
        checkpoints
            .import_box(&checkpoint.id, None, Some("target"))
            .await,
        Err(BoxliteError::Storage(_))
    ));
    assert_eq!(
        runtime.get_info("target").await.unwrap().unwrap().id,
        target_id
    );
    assert_eq!(runtime.list_info().await.unwrap().len(), 2);
    assert_eq!(checkpoints.get(&checkpoint.id).await.unwrap(), checkpoint);
}

#[tokio::test]
async fn recovery_resumes_from_its_persisted_target_after_old_native_was_removed() {
    let (runtime, checkpoints, temporary) = setup();
    runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("source".into()),
        )
        .await
        .unwrap();
    let checkpoint = checkpoints
        .create("source", Some("base".into()))
        .await
        .unwrap();
    let target = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("target".into()),
        )
        .await
        .unwrap();
    let old_id = target.id().to_string();
    let catalog = Catalog::new(temporary.path().join("checkpoints"));
    // Reconstruct the persisted between-stages state using production journal
    // and removal operations; this tests restart/resume, not injected failure.
    catalog
        .save_recovery(&Recovery {
            original_id: old_id.clone(),
            name: Some("target".into()),
            checkpoint_id: checkpoint.id.clone(),
            import_id: None,
            accepted_id: None,
        })
        .unwrap();
    runtime.remove_box(target.id(), false).unwrap();
    crate::images::test_support::seed_cached_build(
        &runtime.image_manager,
        IMAGE,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .await;
    let recovered = checkpoints
        .import_box(&checkpoint.id, None, Some(&old_id))
        .await
        .unwrap();
    assert_eq!(recovered.name(), Some("target"));
    assert_ne!(recovered.id().as_ref(), old_id);
    assert_eq!(runtime.list_info().await.unwrap().len(), 2);
}

#[tokio::test]
async fn recovery_never_removes_a_different_box_reusing_the_target_name() {
    let (runtime, checkpoints, temporary) = setup();
    runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("source".into()),
        )
        .await
        .unwrap();
    let checkpoint = checkpoints
        .create("source", Some("base".into()))
        .await
        .unwrap();
    let target = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("target".into()),
        )
        .await
        .unwrap();
    let old_id = target.id().to_string();
    let catalog = Catalog::new(temporary.path().join("checkpoints"));
    runtime.remove_box(target.id(), false).unwrap();
    let other = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("target".into()),
        )
        .await
        .unwrap();
    // A pre-existing name collision must remain safe even when a stale journal
    // is discovered on restart; current admission prevents creating this state.
    catalog
        .save_recovery(&Recovery {
            original_id: old_id.clone(),
            name: Some("target".into()),
            checkpoint_id: checkpoint.id.clone(),
            import_id: None,
            accepted_id: None,
        })
        .unwrap();
    assert!(matches!(
        checkpoints
            .import_box(&checkpoint.id, None, Some(&old_id))
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert_eq!(
        runtime.get_info("target").await.unwrap().unwrap().id,
        *other.id()
    );
}

#[tokio::test]
async fn checkpoint_pending_recovery_protects_name_old_handle_and_archive_until_explicit_delete() {
    let (runtime, checkpoints, temporary) = setup();
    let source = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("source".into()),
        )
        .await
        .unwrap();
    let checkpoint = checkpoints
        .create("source", Some("base".into()))
        .await
        .unwrap();
    let target = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("target".into()),
        )
        .await
        .unwrap();
    let old_id = target.id().to_string();
    let catalog = Catalog::new(temporary.path().join("checkpoints"));
    catalog
        .save_recovery(&Recovery {
            original_id: old_id.clone(),
            name: Some("target".into()),
            checkpoint_id: checkpoint.id.clone(),
            import_id: None,
            accepted_id: None,
        })
        .unwrap();
    // Model the durable boundary after recovery removed the original native box.
    runtime.remove_box(target.id(), false).unwrap();
    assert!(
        matches!(
            runtime
                .create(source_options(), Some("target".into()))
                .await,
            Err(BoxliteError::InvalidState(_))
        ),
        "pending recovery must retain the target name"
    );
    assert!(matches!(
        runtime
            .import_box(
                source_archive(temporary.path(), &source_options()),
                Some("target".into())
            )
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(
        matches!(target.start().await, Err(BoxliteError::InvalidState(_))),
        "old handles must fail before booting a removed target"
    );
    assert!(
        matches!(
            checkpoints.remove(&checkpoint.id, true).await,
            Err(BoxliteError::InvalidState(_))
        ),
        "force must retain an archive needed by unfinished recovery"
    );
    runtime.remove("target", false).unwrap();
    assert!(catalog.recovery(&old_id).unwrap().is_none());
    assert!(matches!(
        checkpoints
            .import_box(&checkpoint.id, None, Some(&old_id))
            .await,
        Err(BoxliteError::NotFound(_))
    ));
    checkpoints.remove(&checkpoint.id, false).await.unwrap();
    let replacement = runtime
        .create(source_options(), Some("target".into()))
        .await
        .unwrap();
    assert_ne!(replacement.id(), target.id());
    assert!(matches!(
        target.start().await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert_eq!(
        runtime.get_info("source").await.unwrap().unwrap().id,
        *source.id()
    );
}

#[tokio::test]
async fn checkpoint_recovery_reservation_excludes_all_target_mutation_entry_points() {
    let (runtime, checkpoints, temporary) = setup();
    let target = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("target".into()),
        )
        .await
        .unwrap();
    let source = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("source".into()),
        )
        .await
        .unwrap();
    let checkpoint = checkpoints
        .create("source", Some("base".into()))
        .await
        .unwrap();
    let reservation = runtime
        .checkpoint_lifecycle
        .reserve(target.id().as_ref(), target.name())
        .unwrap();
    assert!(matches!(
        target.start().await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        runtime.remove("target", true),
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        runtime.remove(target.id().as_ref(), true),
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        runtime
            .create(source_options(), Some("target".into()))
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        runtime
            .get_or_create(source_options(), Some("target".into()))
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        runtime
            .import_box(
                source_archive(temporary.path(), &source_options()),
                Some("target".into())
            )
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        checkpoints
            .import_box(&checkpoint.id, None, Some("target"))
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        checkpoints.create("target", None).await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        target
            .clone_box(Default::default(), Some("clone".into()))
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        source
            .clone_box(Default::default(), Some("target".into()))
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        target
            .export(Default::default(), &temporary.path().join("export.boxlite"))
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    // A different target remains usable while recovery owns this name and ID.
    let unrelated = runtime
        .create(source_options(), Some("unrelated".into()))
        .await
        .unwrap();
    runtime.remove(unrelated.id().as_ref(), false).unwrap();
    drop(reservation);
    let read = runtime
        .checkpoint_lifecycle
        .read(Some(target.id().as_ref()), target.name())
        .unwrap();
    assert!(
        runtime
            .checkpoint_lifecycle
            .reserve(target.id().as_ref(), target.name())
            .is_err()
    );
    drop(read);
    runtime.remove("target", false).unwrap();
    runtime
        .create(source_options(), Some("target".into()))
        .await
        .unwrap();
}

#[tokio::test]
async fn checkpoint_pending_recovery_keeps_ownership_after_runtime_restart() {
    let (runtime, checkpoints, temporary) = setup();
    let source = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("source".into()),
        )
        .await
        .unwrap();
    let checkpoint = checkpoints
        .create("source", Some("base".into()))
        .await
        .unwrap();
    let target = runtime
        .import_box(
            source_archive(temporary.path(), &source_options()),
            Some("target".into()),
        )
        .await
        .unwrap();
    let old_id = target.id().to_string();
    let catalog = Catalog::new(temporary.path().join("checkpoints"));
    catalog
        .save_recovery(&Recovery {
            original_id: old_id.clone(),
            name: Some("target".into()),
            checkpoint_id: checkpoint.id.clone(),
            import_id: None,
            accepted_id: None,
        })
        .unwrap();
    runtime.remove_box(target.id(), false).unwrap();
    drop(target);
    drop(source);
    drop(checkpoints);
    drop(runtime);

    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: temporary.path().join("runtime"),
        ..Default::default()
    })
    .unwrap();
    let checkpoints =
        LocalCheckpoints::new(Arc::clone(&runtime), temporary.path().join("checkpoints"));
    assert!(matches!(
        runtime
            .create(source_options(), Some("target".into()))
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(matches!(
        checkpoints.remove(&checkpoint.id, true).await,
        Err(BoxliteError::InvalidState(_))
    ));
    runtime.remove(&old_id, false).unwrap();
    checkpoints.remove(&checkpoint.id, false).await.unwrap();
    runtime
        .create(source_options(), Some("target".into()))
        .await
        .unwrap();
}
