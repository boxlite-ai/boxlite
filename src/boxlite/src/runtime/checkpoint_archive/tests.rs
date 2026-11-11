use super::*;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::litebox::archive::{
    ArchiveManifest, archive_version_for_options, build_zstd_tar_archive, sha256_file,
};
use crate::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use crate::runtime::rt_impl::RuntimeImpl;
use crate::{BoxArchive, BoxStatus};
use std::sync::Arc;

const IMAGE: &str = "example.invalid/acme/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn archive_source(archive: &BoxArchive) -> CheckpointArchiveSource {
    CheckpointArchiveSource {
        path: archive.path().to_owned(),
        sha256: sha256_file(archive.path()).unwrap(),
        pinned_image: IMAGE.into(),
    }
}

#[tokio::test]
async fn downloaded_checkpoint_preparation_rebinds_only_platform_identity_before_native_import() {
    let (runtime, api, temporary) = setup();
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
    let prepared = api
        .prepare_checkpoint_archive(source.clone(), Some(platform))
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
    let cloud_prepared = api
        .prepare_checkpoint_archive(cloud_source, None)
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
    let (runtime, api, temporary) = setup();
    let archive = source_archive(temporary.path(), &source_options());
    let mut source = archive_source(&archive);
    source.sha256 = "f".repeat(64);
    assert!(matches!(
        api.prepare_checkpoint_archive(source, None).await,
        Err(BoxliteError::Storage(_))
    ));
    let platform = std::collections::BTreeMap::from([
        ("BOXLITE_BOX_ID".into(), "target".into()),
        ("APP_MODE".into(), "override".into()),
    ]);
    assert!(matches!(
        api.prepare_checkpoint_archive(archive_source(&archive), Some(platform))
            .await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    assert!(matches!(
        api.prepare_checkpoint_archive(archive_source(&archive), Some(Default::default()))
            .await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    assert!(runtime.list_info().await.unwrap().is_empty());
    assert!(archive.path().exists());
}

#[tokio::test]
async fn downloaded_checkpoint_preparation_reuses_native_disk_validation() {
    let (runtime, api, temporary) = setup();
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
        api.prepare_checkpoint_archive(archive_source(&archive), None)
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
    let (runtime, api, temporary) = setup();
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
    let error = match api
        .prepare_checkpoint_archive(archive_source(&archive), None)
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
    let (runtime, api, temporary) = setup();
    let mut options = source_options();
    options.advanced.nested_virtualization = true;
    let archive = source_archive(temporary.path(), &options);
    let error = match api
        .prepare_checkpoint_archive(archive_source(&archive), None)
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("checkpoint bypassed the target runtime feature gate"),
    };
    assert!(
        error.to_string().contains("NestedVirtualization"),
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
    )
    .unwrap();
    crate::images::test_support::seed_cached_build(
        &opted_in.image_manager,
        IMAGE,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .await;
    let opted_in_api = crate::BoxliteRuntime::from_local(crate::runtime::rt_impl::LocalRuntime(
        Arc::clone(&opted_in),
    ));
    let prepared = opted_in_api
        .prepare_checkpoint_archive(archive_source(&archive), None)
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

fn setup() -> (SharedRuntimeImpl, crate::BoxliteRuntime, tempfile::TempDir) {
    let temporary = tempfile::tempdir().unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: temporary.path().join("runtime"),
        ..Default::default()
    })
    .unwrap();
    let api = crate::BoxliteRuntime::from_local(crate::runtime::rt_impl::LocalRuntime(Arc::clone(
        &runtime,
    )));
    (runtime, api, temporary)
}

#[tokio::test]
async fn checkpoint_preparation_rejects_a_shutdown_runtime_before_archive_work() {
    let (runtime, api, temporary) = setup();
    let archive = source_archive(temporary.path(), &source_options());
    crate::images::test_support::seed_cached_build(
        &runtime.image_manager,
        IMAGE,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .await;
    runtime.shutdown(None).await.unwrap();
    assert!(matches!(
        api.prepare_checkpoint_archive(archive_source(&archive), None)
            .await,
        Err(BoxliteError::Stopped(_))
    ));
}
