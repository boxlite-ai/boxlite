use super::*;
use crate::litebox::checkpoint::pair::tests::cloud_fixture;
use crate::runtime::checkpoints::CheckpointBackend;
use serde_json::json;

fn runtime() -> (SharedRuntimeImpl, tempfile::TempDir) {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let runtime = crate::runtime::rt_impl::RuntimeImpl::new_for_test(crate::BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    (runtime, home)
}
fn options(root: &Path, summary: &CloudCheckpointInspection) -> CloudCheckpointImportOptions {
    CloudCheckpointImportOptions {
        operation_id: uuid::Uuid::new_v4().to_string(),
        expected_pair_sha256: summary.pair_sha256.clone(),
        trusted_boot: Some(root.join("boot.raw")),
    }
}

#[test]
fn checkpoint_cloud_inspection_allowlist_and_execution_ignore_saved_host_security_and_lifecycle() {
    let source = cloud_fixture(|metadata| {
        metadata["application"]["local_paths"]["boot_disk"] = json!("/must-not-open/saved-boot");
        metadata["application"]["options"]["advanced"]["security"] =
            json!({"jailer_enabled":false,"uid":0,"chroot_base":"/must-not-open/jail"});
        metadata["application"]["options"]["auto_delete"] = json!(1);
        metadata["application"]["options"]["detach"] = json!(false);
        metadata["application"]["options"]["env"] = json!([["TOKEN", "captured-value"]]);
    });
    let summary = inspect(&source.path().join("pair")).unwrap();
    assert_eq!(summary.version, 1);
    assert_eq!(summary.resources.cpus, 1);
    assert_eq!(summary.resources.max_cpus, 2);
    let json = serde_json::to_string(&summary).unwrap();
    for forbidden in [
        "must-not-open",
        "local_paths",
        "boot_disk_path",
        "jailer_enabled",
        "chroot_base",
        "secrets",
        "object_key",
    ] {
        assert!(!json.contains(forbidden), "{forbidden}");
    }
    let pair = pair::open(&source.path().join("pair")).unwrap();
    let (_, application) = prepare(&pair, Origin::Managed).unwrap();
    let mut expected = application.options.clone();
    expected.advanced.security = crate::SecurityOptions::default();
    expected.sanitize().unwrap();
    assert_eq!(
        application.options.advanced.security,
        expected.advanced.security
    );
    assert!(application.options.detach);
    assert_eq!(application.options.auto_delete, Some(0));
    assert_eq!(application.options.auto_resume, Some(false));
    assert_eq!(summary.configuration.env, application.options.env);
}

#[tokio::test]
async fn checkpoint_cloud_registration_uses_only_trusted_boot_and_replays_exact_content() {
    let source = cloud_fixture(|_| {});
    let summary = inspect(&source.path().join("pair")).unwrap();
    let (runtime, _home) = runtime();
    let backend = super::super::LocalCheckpoints::new(runtime.clone(), None);
    let mut missing = options(source.path(), &summary);
    missing.trusted_boot = None;
    // The saved boot path exists and matches, but is not a trusted cache entry.
    assert!(matches!(
        backend
            .import_pair(&source.path().join("pair"), missing)
            .await,
        Err(BoxliteError::Storage(_))
    ));
    assert!(
        runtime
            .checkpoint_catalog
            .store
            .list(None)
            .unwrap()
            .is_empty()
    );
    let options = options(source.path(), &summary);
    let imported = backend
        .import_pair(&source.path().join("pair"), options.clone())
        .await
        .unwrap();
    assert_eq!(imported.id, options.operation_id);
    assert_eq!(imported.status, "ready");
    assert_eq!(
        backend
            .import_pair(&source.path().join("pair"), options.clone())
            .await
            .unwrap(),
        imported
    );
    assert!(
        runtime.list_info().await.unwrap().is_empty(),
        "registration created a VM/target"
    );
    let another = cloud_fixture(|metadata| {
        metadata["application"]["options"]["env"] = json!([["CHANGED", "yes"]])
    });
    let changed = inspect(&another.path().join("pair")).unwrap();
    let mut conflict = options.clone();
    conflict.expected_pair_sha256 = changed.pair_sha256;
    conflict.trusted_boot = Some(another.path().join("boot.raw"));
    assert!(matches!(
        backend
            .import_pair(&another.path().join("pair"), conflict)
            .await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert_eq!(
        runtime
            .checkpoint_catalog
            .store
            .get(None, &imported.id)
            .unwrap()
            .unwrap(),
        imported
    );
}

#[tokio::test]
async fn checkpoint_cloud_pair_replacement_and_os_failures_remain_distinct_before_registration() {
    let source = cloud_fixture(|_| {});
    let summary = inspect(&source.path().join("pair")).unwrap();
    let (runtime, _home) = runtime();
    let backend = super::super::LocalCheckpoints::new(runtime.clone(), None);
    let changed = cloud_fixture(|metadata| {
        metadata["application"]["guest"]["boot_id"] = json!("different-boot")
    });
    assert!(matches!(
        backend
            .import_pair(
                &changed.path().join("pair"),
                options(source.path(), &summary)
            )
            .await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    assert!(matches!(
        inspect(&source.path().join("absent-stage")),
        Err(BoxliteError::Storage(_))
    ));
    std::fs::write(source.path().join("pair/snapshot.mem"), b"short").unwrap();
    assert!(matches!(
        crate::BoxliteRuntime::inspect_checkpoint(source.path().join("pair")),
        Err(BoxliteError::Storage(_))
    ));
    assert!(matches!(
        inspect(&source.path().join("pair")),
        Err(BoxliteError::InvalidArgument(_))
    ));
    assert!(
        runtime
            .checkpoint_catalog
            .store
            .list(None)
            .unwrap()
            .is_empty()
    );
    assert!(runtime.list_info().await.unwrap().is_empty());
}

#[test]
fn checkpoint_cloud_bad_qcow2_resources_and_unsupported_configuration_are_rejected() {
    let corrupt = cloud_fixture(|_| {});
    let disk = OpenOptions::new()
        .write(true)
        .open(corrupt.path().join("pair/snapshot.qcow2"))
        .unwrap();
    use std::os::unix::fs::FileExt;
    disk.write_all_at(b"bad", 0).unwrap();
    assert!(matches!(
        inspect(&corrupt.path().join("pair")),
        Err(BoxliteError::InvalidArgument(_))
    ));
    for edit in [
        (
            "resources",
            json!({"cpus":0,"memory_mib":1,"max_cpus":2,"max_memory_mib":1}),
        ),
        (
            "guest",
            json!({"boot_id":"","container_id":"bad","init_pid":0}),
        ),
    ] {
        let bad = cloud_fixture(|metadata| metadata["application"][edit.0] = edit.1);
        assert!(matches!(
            inspect(&bad.path().join("pair")),
            Err(BoxliteError::InvalidArgument(_))
        ));
    }
    // Use the production options serializer to obtain the actual enum shape.
    let host = cloud_fixture(|metadata| {
        let mut application: Application =
            serde_json::from_value(metadata["application"].clone()).unwrap();
        application.options.rootfs = RootfsSpec::RootfsPath("/must-not-open/rootfs".into());
        metadata["application"] = serde_json::to_value(application).unwrap();
    });
    assert!(matches!(
        inspect(&host.path().join("pair")),
        Err(BoxliteError::Unsupported(_))
    ));
}

#[test]
fn checkpoint_cloud_effective_outbound_is_identical_in_inspection_and_import_preparation() {
    let source = cloud_fixture(|metadata| {
        let mut application: Application =
            serde_json::from_value(metadata["application"].clone()).unwrap();
        application.options.network = crate::NetworkSpec::Enabled {
            allow_net: vec!["old.example".into()],
        };
        application.outbound_policy = Some(OutboundNetworkConfig {
            mode: NetworkMode::Enabled,
            allow_net: vec!["allowed.example".into()],
        });
        metadata["application"] = serde_json::to_value(application).unwrap();
        metadata["nic"] = json!({});
    });
    let summary = inspect(&source.path().join("pair")).unwrap();
    let pair = pair::open(&source.path().join("pair")).unwrap();
    let (_, application) = prepare(&pair, Origin::Managed).unwrap();
    assert_eq!(
        summary.configuration.outbound,
        application.outbound_policy.unwrap()
    );
    assert_eq!(
        summary.configuration.outbound.allow_net,
        vec!["allowed.example"]
    );
    assert_eq!(
        OutboundNetworkConfig::from(&application.options.network),
        summary.configuration.outbound
    );
}

#[tokio::test]
async fn checkpoint_cloud_publication_write_failure_is_internal_and_never_ready() {
    let source = cloud_fixture(|_| {});
    let summary = inspect(&source.path().join("pair")).unwrap();
    let (runtime, _home) = runtime();
    let options = options(source.path(), &summary);
    let destination = runtime
        .checkpoint_catalog
        .directory(&options.operation_id)
        .unwrap();
    std::fs::create_dir(&destination).unwrap();
    std::fs::write(destination.join("existing"), b"preserve").unwrap();
    let backend = super::super::LocalCheckpoints::new(runtime.clone(), None);
    let error = backend
        .import_pair(&source.path().join("pair"), options.clone())
        .await
        .unwrap_err();
    assert!(matches!(error, BoxliteError::Storage(_)));
    assert_eq!(error.http().0, 500);
    assert_eq!(
        std::fs::read(destination.join("existing")).unwrap(),
        b"preserve"
    );
    assert_eq!(
        runtime
            .checkpoint_catalog
            .store
            .get(None, &options.operation_id)
            .unwrap()
            .unwrap()
            .status,
        "failed"
    );
    assert!(runtime.list_info().await.unwrap().is_empty());
    // Output creation errors are internal even when parsing the input succeeded.
    let mut input = File::open(source.path().join("boot.raw")).unwrap();
    assert!(matches!(
        copy(&mut input, &source.path().join("missing-parent/output")),
        Err(BoxliteError::Storage(_))
    ));
}
