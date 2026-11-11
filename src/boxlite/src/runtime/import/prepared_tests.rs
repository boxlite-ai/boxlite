use super::*;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::litebox::archive::{archive_version_for_options, build_zstd_tar_archive};
use crate::runtime::options::BoxliteOptions;
use crate::runtime::rt_impl::SharedRuntimeImpl;

const IMAGE: &str = "example.invalid/acme/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn startup_options() -> ImportOptions {
    ImportOptions {
        preflight_startup: true,
        ..Default::default()
    }
}

#[tokio::test]
async fn prepared_import_commits_owned_disks_after_source_is_deleted() {
    let (runtime, api, temporary) = setup();
    let mut options = source_options();
    options.rootfs = RootfsSpec::Image("example.invalid/app:original".into());
    options.env.extend([
        ("OLD".into(), "remove".into()),
        ("APP_MODE".into(), "duplicate".into()),
    ]);
    let archive = source_archive(temporary.path(), &options);
    let prepared = api
        .prepare_import(
            archive.clone(),
            ImportOptions {
                image: Some(IMAGE.into()),
                env: BTreeMap::from([
                    ("OLD".into(), None),
                    ("APP_MODE".into(), Some("new".into())),
                    ("TARGET".into(), Some("id".into())),
                ]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(runtime.list_info().await.unwrap().is_empty());
    let source = prepared.info();
    assert!(source.has_disk_checksum);
    assert_eq!(source.box_options.as_ref().unwrap().env, options.env);
    let staging = prepared.directory.path().to_owned();
    assert!(prepared.staging_dir.join("disks/disk.qcow2").is_file());
    // No source access or re-extraction can succeed from this point onward.
    std::fs::remove_file(archive.path()).unwrap();
    let imported = prepared.commit(Some("target".into())).await.unwrap();
    assert!(!staging.exists());
    let (config, _) = runtime
        .box_manager
        .box_by_id(imported.id())
        .unwrap()
        .unwrap();
    assert!(matches!(&config.options.rootfs, RootfsSpec::Image(image) if image == IMAGE));
    let env: BTreeMap<_, _> = config.options.env.iter().cloned().collect();
    assert_eq!(env.get("APP_MODE").map(String::as_str), Some("new"));
    assert_eq!(env.get("TARGET").map(String::as_str), Some("id"));
    assert_eq!(
        env.get("BOXLITE_USER_KEY").map(String::as_str),
        Some("keep")
    );
    assert!(!env.contains_key("OLD"));
    assert_eq!(
        config
            .options
            .env
            .iter()
            .filter(|(key, _)| key == "APP_MODE")
            .count(),
        1
    );
    assert_eq!(config.options.cpus, options.cpus);
    assert_eq!(config.options.memory_mib, options.memory_mib);
    assert_eq!(config.options.cmd, options.cmd);
    assert_eq!(imported.info().await.unwrap().status, BoxStatus::Stopped);
}

#[tokio::test]
async fn prepared_import_drop_cleans_staging_without_creating_a_box() {
    let (runtime, api, temporary) = setup();
    let archive = source_archive(temporary.path(), &source_options());
    let checksum = sha256_file(archive.path()).unwrap();
    let prepared = api
        .prepare_import(archive.clone(), ImportOptions::default())
        .await
        .unwrap();
    let path = prepared.directory.path().to_owned();
    drop(prepared);
    assert!(!path.exists());
    assert_eq!(sha256_file(archive.path()).unwrap(), checksum);
    assert!(runtime.list_info().await.unwrap().is_empty());
}

#[tokio::test]
async fn prepared_import_rejects_bad_overrides_and_reuses_archive_integrity_checks() {
    let (runtime, api, temporary) = setup();
    let archive = source_archive(temporary.path(), &source_options());
    for overrides in [
        ImportOptions {
            image: Some(String::new()),
            ..Default::default()
        },
        ImportOptions {
            env: BTreeMap::from([("BAD=KEY".into(), None)]),
            ..Default::default()
        },
        ImportOptions {
            env: BTreeMap::from([("KEY".into(), Some("bad\0value".into()))]),
            ..Default::default()
        },
    ] {
        assert!(matches!(
            api.prepare_import(archive.clone(), overrides).await,
            Err(BoxliteError::InvalidArgument(_))
        ));
    }
    let unpacked = tempfile::tempdir().unwrap();
    crate::litebox::archive::extract_archive(archive.path(), unpacked.path()).unwrap();
    let disk = unpacked.path().join("disk.qcow2");
    let mut bytes = std::fs::read(&disk).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    std::fs::write(&disk, &bytes).unwrap();
    build_zstd_tar_archive(
        archive.path(),
        &unpacked.path().join("manifest.json"),
        &disk,
        1,
    )
    .unwrap();
    let error = api
        .prepare_import(archive.clone(), ImportOptions::default())
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("checksum mismatch"), "{error}");
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
async fn prepared_import_rejects_missing_boot_assets_without_changing_target() {
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
    let error = match api.prepare_import(archive.clone(), startup_options()).await {
        Err(error) => error,
        Ok(_) => panic!("missing boot asset passed import preparation"),
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
async fn prepared_import_requires_the_target_runtime_feature_opt_in() {
    let (runtime, api, temporary) = setup();
    let mut options = source_options();
    options.advanced.nested_virtualization = true;
    let archive = source_archive(temporary.path(), &options);
    let error = match api.prepare_import(archive.clone(), startup_options()).await {
        Err(error) => error,
        Ok(_) => panic!("checkpoint bypassed the target runtime feature gate"),
    };
    assert!(matches!(&error, BoxliteError::Config(_)), "{error}");
    assert!(
        error
            .to_string()
            .contains("BOXLITE_EXPERIMENTAL=nested-virtualization"),
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
    let opted_in_api = crate::BoxliteRuntime::from_local(crate::runtime::rt_impl::LocalRuntime(
        Arc::clone(&opted_in),
    ));
    let prepared = opted_in_api
        .prepare_import(archive.clone(), startup_options())
        .await
        .unwrap();
    assert!(prepared.staging_dir.is_dir());
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
async fn prepared_import_rejects_a_shutdown_runtime_before_archive_work() {
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
        api.prepare_import(archive, ImportOptions::default()).await,
        Err(BoxliteError::Stopped(_))
    ));
}
