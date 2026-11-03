use super::*;

fn runtime() -> (SharedRuntimeImpl, tempfile::TempDir) {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let runtime = crate::runtime::rt_impl::RuntimeImpl::new_for_test(crate::BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    (runtime, home)
}

fn record(catalog: &Catalog, name: &str, source: &str, status: &str) -> CheckpointInfo {
    let info = CheckpointInfo {
        id: uuid::Uuid::new_v4().to_string(),
        box_id: source.into(),
        name: name.into(),
        created_at: 1,
        status: status.into(),
        error: None,
        cpus: 1,
        memory_bytes: 4096,
        container_disk_bytes: 1048576,
        size_bytes: 0,
    };
    catalog.store.insert(&info).unwrap();
    info
}

#[tokio::test]
async fn checkpoint_catalog_id_collision_preserves_selected_state_and_other_resource() {
    let (runtime, _home) = runtime();
    let catalog = &runtime.checkpoint_catalog;
    let a = record(catalog, "first", "source", "failed");
    let b = record(catalog, &a.id, "source", "ready");
    let backend = LocalCheckpoints::new(runtime.clone(), None);
    assert_eq!(backend.get(&a.id).await.unwrap().unwrap().id, a.id);
    let error = backend.create_from(&a.id, None).await.err().unwrap();
    assert!(error.to_string().contains(&a.id));
    assert!(error.to_string().contains("failed"));
    assert_eq!(backend.get(&b.id).await.unwrap().unwrap(), b);
    backend.remove(&a.id, false).await.unwrap();
    assert_eq!(backend.get(&b.id).await.unwrap().unwrap(), b);
    // Only once the selected ID is absent may the same input select B by name.
    assert_eq!(backend.get(&a.id).await.unwrap().unwrap().id, b.id);
}

#[tokio::test]
async fn checkpoint_catalog_scopes_before_selection_and_tracks_deleting_id() {
    let (runtime, _home) = runtime();
    let catalog = &runtime.checkpoint_catalog;
    let a = record(catalog, "old", "other-source", "deleting");
    let b = record(catalog, &a.id, "source", "failed");
    assert_eq!(catalog.selected(Some("source"), &a.id).unwrap().id, b.id);
    assert!(matches!(
        catalog.selected(Some("missing"), &a.id),
        Err(BoxliteError::NotFound(_))
    ));
    let mut old = record(catalog, "reused", "source", "failed");
    old.status = "deleting".into();
    catalog.store.update(&old).unwrap();
    let new = record(catalog, "reused", "source", "failed");
    let backend = LocalCheckpoints::new(runtime.clone(), None);
    assert_eq!(
        backend.get(&old.id).await.unwrap().unwrap().status,
        "deleting"
    );
    assert_eq!(backend.get("reused").await.unwrap().unwrap().id, new.id);
    let error = backend.create_from(&old.id, None).await.err().unwrap();
    assert!(error.to_string().contains("deleting"));
    backend.remove(&old.id, false).await.unwrap();
    assert_eq!(backend.get("reused").await.unwrap().unwrap(), new);
}

#[tokio::test]
async fn checkpoint_catalog_persistence_recovery_name_validation_and_lease() {
    let (runtime, home) = runtime();
    let catalog = &runtime.checkpoint_catalog;
    let unfinished = record(catalog, "unfinished", "deleted-source", "creating");
    let ready = record(catalog, "retained", "deleted-source", "ready");
    assert!(record_duplicate(catalog, &ready).is_err());
    for invalid_name in ["", " ", "../escape", ".", "foo/bar"] {
        assert!(validate_name(invalid_name).is_err());
    }
    let lock = catalog.lease().unwrap();
    let backend = LocalCheckpoints::new(runtime.clone(), None);
    assert!(matches!(
        backend.remove(&ready.id, false).await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert_eq!(backend.get(&ready.id).await.unwrap().unwrap(), ready);
    drop(lock);
    drop(backend);
    drop(runtime);
    let orphan = home.path().join("checkpoints/.archive-interrupted");
    std::fs::create_dir(&orphan).unwrap();
    std::fs::write(orphan.join("partial"), b"incomplete transfer").unwrap();
    let db = crate::db::Database::open(&home.path().join("db/boxlite.db")).unwrap();
    let reopened = Catalog::new(db, home.path().join("checkpoints")).unwrap();
    assert!(!orphan.exists());
    assert_eq!(
        reopened.selected(None, &unfinished.id).unwrap().status,
        "failed"
    );
    assert_eq!(reopened.selected(None, &ready.id).unwrap(), ready);
}

fn record_duplicate(catalog: &Catalog, info: &CheckpointInfo) -> BoxliteResult<()> {
    let mut duplicate = info.clone();
    duplicate.id = uuid::Uuid::new_v4().to_string();
    catalog.store.insert(&duplicate)
}

#[test]
fn checkpoint_managed_archive_roundtrip_replay_digest_and_source_independence() {
    let (runtime, _home) = runtime();
    let catalog = &runtime.checkpoint_catalog;
    let pair = crate::litebox::checkpoint::pair::tests::managed_fixture();
    let staging = tempfile::tempdir().unwrap();
    std::fs::create_dir(staging.path().join("pair")).unwrap();
    for name in [pair::MEMORY, pair::DISK] {
        std::fs::copy(
            pair.path().join(name),
            staging.path().join("pair").join(name),
        )
        .unwrap();
    }
    std::fs::copy(
        pair.path().join("boot.raw"),
        staging.path().join("boot.raw"),
    )
    .unwrap();
    let deps = pair::open(&staging.path().join("pair"))
        .unwrap()
        .dependencies;
    let mut info = record(catalog, "capture", "deleted-source", "ready");
    info.cpus = 1;
    info.memory_bytes = deps.memory_bytes;
    info.container_disk_bytes = deps.container_disk_bytes;
    let archive_home = tempfile::tempdir().unwrap();
    let archive_path = archive_home.path().join("managed.zst");
    archive::pack(staging.path(), &info, &archive_path).unwrap();
    drop(pair);
    drop(staging);
    let operation = uuid::Uuid::new_v4().to_string();
    let imported = archive::unpack(catalog, &archive_path, &operation).unwrap();
    assert_eq!(imported.status, "ready");
    assert_eq!(
        imported.cpus, 1,
        "allocated CPUs differ from the saved growth ceiling"
    );
    assert_eq!(imported.id, operation);
    assert_eq!(
        archive::unpack(catalog, &archive_path, &operation).unwrap(),
        imported
    );
    assert_eq!(
        std::fs::read(catalog.directory(&operation).unwrap().join("boot.raw")).unwrap(),
        vec![7; 4096]
    );
    // Corruption after registration is not idempotent success.
    std::fs::write(
        catalog.directory(&operation).unwrap().join("boot.raw"),
        b"bad",
    )
    .unwrap();
    assert!(archive::unpack(catalog, &archive_path, &operation).is_err());
}

#[test]
fn checkpoint_managed_archive_rejects_duplicate_extra_missing_and_nonregular_members_before_registration()
 {
    let (runtime, _home) = runtime();
    let catalog = &runtime.checkpoint_catalog;
    let files = tempfile::tempdir().unwrap();
    for (index, names) in [
        vec![
            ("boot.raw", tar::EntryType::Regular),
            ("boot.raw", tar::EntryType::Regular),
        ],
        vec![("unexpected", tar::EntryType::Regular)],
        vec![("boot.raw", tar::EntryType::Symlink)],
        vec![("boot.raw", tar::EntryType::Regular)],
    ]
    .into_iter()
    .enumerate()
    {
        let path = files.path().join(format!("invalid-{index}.zst"));
        let encoder = zstd::stream::write::Encoder::new(File::create(&path).unwrap(), 1).unwrap();
        let mut tar = tar::Builder::new(encoder);
        for (name, kind) in names {
            let mut header = tar::Header::new_ustar();
            header.set_size(0);
            header.set_mode(0o600);
            header.set_entry_type(kind);
            header.set_cksum();
            tar.append_data(&mut header, name, &[][..]).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
        assert!(archive::unpack(catalog, &path, &uuid::Uuid::new_v4().to_string()).is_err());
        assert!(catalog.store.list(None).unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(&catalog.root).unwrap().count(),
            1,
            "failed staging was retained"
        );
    }
}
