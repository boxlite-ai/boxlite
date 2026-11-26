use super::*;
use tempfile::TempDir;

fn options(home: &TempDir) -> BoxliteOptions {
    BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    }
}

async fn create(runtime: &Arc<RuntimeImpl>) -> LiteBox {
    runtime
        .create(
            BoxOptions {
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap()
}

fn assert_pair(runtime: &RuntimeImpl, id: &BoxID, exists: bool) -> crate::lock::LockId {
    let state = runtime.box_manager.update_box(id).unwrap();
    let id = state.lock_id.unwrap();
    for dir in [runtime.layout.locks_dir(), runtime.layout.disk_locks_dir()] {
        assert_eq!(dir.join(id.to_string()).is_file(), exists);
    }
    id
}

#[tokio::test]
async fn disk_lock_create_provision_stop_shutdown_and_restart_pair_lifetimes() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let a = create(&runtime).await;
    let staging = runtime.layout.temp_dir().join("staged");
    std::fs::create_dir_all(&staging).unwrap();
    let b = runtime
        .provision_box(
            staging,
            None,
            BoxOptions {
                auto_delete: Some(0),
                ..Default::default()
            },
            BoxStatus::Stopped,
            None,
            None,
        )
        .await
        .unwrap();
    let a_id = a.id().clone();
    let b_id = b.id().clone();
    let first = assert_pair(&runtime, &a_id, true);
    assert_pair(&runtime, &b_id, true);
    a.stop().await.unwrap();
    assert_eq!(assert_pair(&runtime, &a_id, true), first);
    runtime.shutdown(None).await.unwrap();
    assert_pair(&runtime, &a_id, true);
    assert_pair(&runtime, &b_id, true);
    let orphan = crate::lock::LockId(99);
    runtime.lock_manager.allocate_and_retrieve(orphan).unwrap();
    runtime
        .disk_lock_manager
        .allocate_and_retrieve(orphan)
        .unwrap();
    drop(a);
    drop(b);
    drop(runtime);

    let recovered = RuntimeImpl::new_for_test(options(&home)).unwrap();
    assert_eq!(assert_pair(&recovered, &a_id, true), first);
    assert_pair(&recovered, &b_id, true);
    for manager in [&recovered.lock_manager, &recovered.disk_lock_manager] {
        assert_eq!(manager.allocated_count().unwrap(), 2);
        assert!(matches!(
            manager.retrieve(orphan),
            Err(BoxliteError::NotFound(_))
        ));
    }
    recovered.remove_box(&a_id, false).unwrap();
    recovered.remove_box(&b_id, false).unwrap();
    assert_eq!(recovered.lock_manager.allocated_count().unwrap(), 0);
    assert_eq!(recovered.disk_lock_manager.allocated_count().unwrap(), 0);
}

#[tokio::test]
async fn disk_lock_db_insert_failure_rolls_back_create_and_provision() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let db = rusqlite::Connection::open(runtime.layout.db_dir().join("boxlite.db")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_insert BEFORE INSERT ON box_config
        BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END;",
    )
    .unwrap();
    assert!(runtime.create(BoxOptions::default(), None).await.is_err());
    let staging = runtime.layout.temp_dir().join("staged");
    std::fs::create_dir_all(&staging).unwrap();
    assert!(
        runtime
            .provision_box(
                staging,
                None,
                BoxOptions::default(),
                BoxStatus::Stopped,
                None,
                None,
            )
            .await
            .is_err()
    );
    for manager in [&runtime.lock_manager, &runtime.disk_lock_manager] {
        assert_eq!(manager.allocated_count().unwrap(), 0);
        assert!(matches!(
            manager.retrieve(crate::lock::LockId(0)),
            Err(BoxliteError::NotFound(_))
        ));
    }
    assert!(runtime.box_manager.all_boxes(true).unwrap().is_empty());
    assert_eq!(
        std::fs::read_dir(runtime.layout.boxes_dir())
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn disk_lock_b2_failed_allocation_preserves_file_and_reserves_id() {
    enable_disk_lock_logs();
    use std::os::unix::fs::MetadataExt;
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let id = crate::lock::LockId(0);
    runtime.disk_lock_manager.allocate_and_retrieve(id).unwrap();
    let path = runtime.layout.disk_locks_dir().join("0");
    let inode = std::fs::metadata(&path).unwrap().ino();
    assert!(runtime.create(BoxOptions::default(), None).await.is_err());
    let staging = runtime.layout.temp_dir().join("staged");
    std::fs::create_dir_all(&staging).unwrap();
    let provisioned = runtime
        .provision_box(
            staging,
            None,
            BoxOptions::default(),
            BoxStatus::Stopped,
            None,
            None,
        )
        .await
        .expect("provision reused the ID reserved after failed disk allocation");
    assert_ne!(assert_pair(&runtime, provisioned.id(), true), id);
    assert_eq!(runtime.lock_manager.allocated_count().unwrap(), 2);
    assert_eq!(runtime.disk_lock_manager.allocated_count().unwrap(), 2);
    assert_eq!(inode, std::fs::metadata(&path).unwrap().ino());
    assert_eq!(runtime.box_manager.all_boxes(true).unwrap().len(), 1);
    assert_eq!(
        std::fs::read_dir(runtime.layout.boxes_dir())
            .unwrap()
            .count(),
        1
    );
}

#[tokio::test]
async fn disk_lock_recovery_duplicate_persisted_ids_fails_initialization() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let a = create(&runtime).await;
    let b = create(&runtime).await;
    let mut state = runtime.box_manager.update_box(b.id()).unwrap();
    state.lock_id = runtime.box_manager.update_box(a.id()).unwrap().lock_id;
    runtime.box_manager.save_box(b.id(), &state).unwrap();
    drop(a);
    drop(b);
    drop(runtime);
    assert!(matches!(
        RuntimeImpl::new_for_test(options(&home)),
        Err(BoxliteError::InvalidState(_))
    ));
}

#[tokio::test]
async fn disk_lock_recovery_disk_rebuild_failure_rolls_back_lifecycle() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let handle = create(&runtime).await;
    let id = assert_pair(&runtime, handle.id(), true);
    let disk_path = runtime.layout.disk_locks_dir().join(id.to_string());
    let lifecycle_path = runtime.layout.locks_dir().join(id.to_string());
    drop(handle);
    drop(runtime);
    // A numeric directory survives numeric-file cleanup but cannot become a lock.
    std::fs::remove_file(&disk_path).unwrap();
    std::fs::create_dir(&disk_path).unwrap();
    assert!(matches!(
        RuntimeImpl::new_for_test(options(&home)),
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(
        !lifecycle_path.exists(),
        "partial lifecycle allocation was leaked"
    );
    assert!(
        disk_path.is_dir(),
        "failed allocation removed someone else's path"
    );
}

struct ReadOnlyDir {
    path: std::path::PathBuf,
    permissions: std::fs::Permissions,
}

impl ReadOnlyDir {
    fn new(path: std::path::PathBuf) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::metadata(&path).unwrap().permissions();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o500)).unwrap();
        Self { path, permissions }
    }
}

impl Drop for ReadOnlyDir {
    fn drop(&mut self) {
        std::fs::set_permissions(&self.path, self.permissions.clone()).unwrap();
    }
}

#[tokio::test]
async fn disk_lock_b2_unlink_failure_quarantines_lifecycle_id() {
    enable_disk_lock_logs();
    // SAFETY: geteuid has no preconditions and only reads the effective user ID.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!(
            "skipping chmod fault injection: root can unlink files in mode 0o500 directories"
        );
        return;
    }
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let old = create(&runtime).await;
    let id = assert_pair(&runtime, old.id(), true);
    let disk_path = runtime.layout.disk_locks_dir().join(id.to_string());
    let readonly = ReadOnlyDir::new(runtime.layout.disk_locks_dir());
    runtime.remove_box(old.id(), false).unwrap();
    assert!(runtime.box_manager.box_by_id(old.id()).unwrap().is_none());
    assert!(
        disk_path.is_file(),
        "test did not cause disk unlink failure"
    );
    assert_eq!(runtime.disk_lock_manager.allocated_count().unwrap(), 0);
    drop(readonly);
    let next = runtime
        .create(
            BoxOptions {
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .expect("create reused the quarantined ID and collided with the residual disk file");
    assert_ne!(assert_pair(&runtime, next.id(), true), id);
    assert!(runtime.layout.locks_dir().join(id.to_string()).is_file());
}

#[tokio::test]
async fn disk_lock_b3_legacy_recovery_allocates_and_persists_pair() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let existing = create(&runtime).await;
    let existing_id = assert_pair(&runtime, existing.id(), true);
    let mut config = runtime
        .box_manager
        .box_by_id(existing.id())
        .unwrap()
        .unwrap()
        .0;
    config.id = BoxIDMint::mint();
    config.box_home = runtime.layout.boxes_dir().join(config.id.as_str());
    runtime
        .box_manager
        .add_box(&config, &BoxState::new())
        .unwrap();
    runtime.recover_boxes().unwrap();
    runtime
        .remove_box(&config.id, false)
        .expect("recovered legacy box must be removable");
    // Reinsert the legacy row to exercise persistence, including a second restart.
    runtime
        .box_manager
        .add_box(&config, &BoxState::new())
        .unwrap();
    runtime.recover_boxes().unwrap();
    let assigned = assert_pair(&runtime, &config.id, true);
    assert_ne!(assigned, existing_id);
    assert_eq!(assert_pair(&runtime, existing.id(), true), existing_id);
    let legacy_id = config.id;
    drop(existing);
    drop(runtime);
    let recovered = RuntimeImpl::new_for_test(options(&home)).unwrap();
    assert_eq!(assert_pair(&recovered, &legacy_id, true), assigned);
    recovered.remove_box(&legacy_id, false).unwrap();
}

#[tokio::test]
async fn disk_lock_b3_legacy_pair_allocation_failure_rejects_initialization() {
    enable_disk_lock_logs();
    // SAFETY: geteuid has no preconditions and only reads the effective user ID.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping chmod fault injection: root can write in mode 0o500 directories");
        return;
    }
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let handle = create(&runtime).await;
    let mut state = runtime.box_manager.update_box(handle.id()).unwrap();
    state.lock_id = None;
    runtime.box_manager.save_box(handle.id(), &state).unwrap();
    let readonly = ReadOnlyDir::new(runtime.layout.disk_locks_dir());
    drop(handle);
    drop(runtime);
    let result = RuntimeImpl::new_for_test(options(&home));
    drop(readonly);
    assert!(
        result.is_err(),
        "runtime published a legacy box without paired admission"
    );
}

#[tokio::test]
async fn disk_lock_c4_legacy_backfill_save_failure_recovers_on_restart() {
    use std::os::unix::fs::MetadataExt;
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let existing = create(&runtime).await;
    let existing_box = existing.id().clone();
    let existing_lock = assert_pair(&runtime, &existing_box, true);
    let failing = create(&runtime).await;
    let completed = create(&runtime).await;
    let failing_box = failing.id().clone();
    let completed_box = completed.id().clone();
    for id in [&failing_box, &completed_box] {
        let mut state = runtime.box_manager.update_box(id).unwrap();
        state.lock_id = None;
        runtime.box_manager.save_box(id, &state).unwrap();
    }
    // Recovery visits newest first; fail the second row after the first commits.
    let rows = runtime.box_manager.all_boxes(true).unwrap();
    assert_eq!(rows[0].0.id, completed_box);
    assert_eq!(rows[1].0.id, failing_box);
    let database = rusqlite::Connection::open(runtime.layout.db_dir().join("boxlite.db")).unwrap();
    database
        .execute_batch(
            "CREATE TRIGGER reject_backfill BEFORE UPDATE ON box_state
         WHEN NEW.id = (SELECT id FROM box_config
                        ORDER BY created_at DESC, rowid DESC LIMIT 1 OFFSET 1)
          AND json_extract(OLD.json, '$.lock_id') IS NULL
          AND json_extract(NEW.json, '$.lock_id') IS NOT NULL
         BEGIN SELECT RAISE(ABORT, 'injected legacy backfill save failure'); END;",
        )
        .unwrap();
    let disk_dir = runtime.layout.disk_locks_dir();
    let lifecycle_dir = runtime.layout.locks_dir();
    drop(existing);
    drop(failing);
    drop(completed);
    drop(runtime);
    let error = RuntimeImpl::new_for_test(options(&home))
        .expect_err("failed backfill persistence must not publish a runtime");
    assert!(matches!(error, BoxliteError::Database(ref message)
        if message.contains("injected legacy backfill save failure")));
    let read_state = |id: &BoxID| -> BoxState {
        let json: String = database
            .query_row(
                "SELECT json FROM box_state WHERE id = ?1",
                rusqlite::params![id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&json).unwrap()
    };
    let persisted = read_state(&completed_box)
        .lock_id
        .expect("first legacy row was saved");
    assert!(read_state(&failing_box).lock_id.is_none());
    assert_eq!(read_state(&existing_box).lock_id, Some(existing_lock));
    let orphans: Vec<crate::lock::LockId> = std::fs::read_dir(&disk_dir)
        .unwrap()
        .map(|entry| {
            crate::lock::LockId(
                entry
                    .unwrap()
                    .file_name()
                    .to_str()
                    .unwrap()
                    .parse()
                    .unwrap(),
            )
        })
        .filter(|id| *id != existing_lock && *id != persisted)
        .collect();
    assert_eq!(
        orphans.len(),
        1,
        "failed save must leave one unpublished lock pair"
    );
    let orphan = orphans[0];
    let orphan_path = disk_dir.join(orphan.to_string());
    assert!(lifecycle_dir.join(orphan.to_string()).is_file());
    // Retain the old inode so the restart cannot reuse it after unlinking.
    let old_file = std::fs::File::open(&orphan_path).unwrap();
    database
        .execute_batch("DROP TRIGGER reject_backfill")
        .unwrap();
    let recovered = RuntimeImpl::new_for_test(options(&home)).unwrap();
    assert_eq!(assert_pair(&recovered, &existing_box, true), existing_lock);
    assert_eq!(assert_pair(&recovered, &completed_box, true), persisted);
    assert_eq!(assert_pair(&recovered, &failing_box, true), orphan);
    assert_ne!(
        old_file.metadata().unwrap().ino(),
        std::fs::metadata(orphan_path).unwrap().ino()
    );
    assert_eq!(recovered.lock_manager.allocated_count().unwrap(), 3);
    assert_eq!(recovered.disk_lock_manager.allocated_count().unwrap(), 3);
}

#[tokio::test]
async fn disk_lock_remove_rejects_missing_identity_and_corrupt_lock_without_side_effects() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let handle = create(&runtime).await;
    let (config, original) = runtime.box_manager.box_by_id(handle.id()).unwrap().unwrap();
    let disk = config.box_home.join("disks/disk.qcow2");
    crate::disk::Qcow2Helper::create_disk(&disk, true)
        .unwrap()
        .leak();
    let before = std::fs::read(&disk).unwrap();
    let mut missing_identity = original.clone();
    missing_identity.lock_id = None;
    runtime
        .box_manager
        .save_box(handle.id(), &missing_identity)
        .unwrap();
    let result = runtime.remove_box(handle.id(), false);
    runtime
        .box_manager
        .save_box(handle.id(), &original)
        .unwrap();
    assert!(
        matches!(result, Err(BoxliteError::Internal(message)) if message.contains("missing lock_id"))
    );

    let lock_id = original.lock_id.unwrap();
    let lock_path = runtime.layout.disk_locks_dir().join(lock_id.to_string());
    let backup = lock_path.with_extension("saved");
    std::fs::rename(&lock_path, &backup).unwrap();
    std::fs::create_dir(&lock_path).unwrap();
    let result = runtime.remove_box(handle.id(), false);
    std::fs::remove_dir(&lock_path).unwrap();
    std::fs::rename(&backup, &lock_path).unwrap();
    assert!(matches!(result, Err(BoxliteError::Storage(_))));
    assert_eq!(std::fs::read(&disk).unwrap(), before);
    assert_eq!(assert_pair(&runtime, handle.id(), true), lock_id);
    runtime.remove_box(handle.id(), false).unwrap();
    assert!(!config.box_home.exists());
}

#[tokio::test]
async fn disk_lock_force_remove_active_box_without_pid_frees_pair() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let handle = create(&runtime).await;
    let lock_id = assert_pair(&runtime, handle.id(), true);
    let mut active = runtime.box_manager.update_box(handle.id()).unwrap();
    active.force_status(BoxStatus::Running);
    assert!(active.pid.is_none());
    runtime.box_manager.save_box(handle.id(), &active).unwrap();
    assert!(matches!(
        runtime.remove_box(handle.id(), false),
        Err(BoxliteError::InvalidState(_))
    ));
    assert_eq!(assert_pair(&runtime, handle.id(), true), lock_id);
    runtime.remove_box(handle.id(), true).unwrap();
    assert!(
        runtime
            .box_manager
            .box_by_id(handle.id())
            .unwrap()
            .is_none()
    );
    assert_eq!(runtime.lock_manager.allocated_count().unwrap(), 0);
    assert_eq!(runtime.disk_lock_manager.allocated_count().unwrap(), 0);
}

#[tokio::test]
async fn disk_lock_remove_commits_metadata_despite_directory_and_lifecycle_unlink_errors() {
    enable_disk_lock_logs();
    // SAFETY: geteuid only reads the effective user ID.
    let inject_chmod_failure = unsafe { libc::geteuid() } != 0;
    if !inject_chmod_failure {
        eprintln!("root: chmod-only fault assertions skipped; normal removal assertions still run");
    }
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let handle = create(&runtime).await;
    let (config, state) = runtime.box_manager.box_by_id(handle.id()).unwrap().unwrap();
    crate::disk::Qcow2Helper::create_disk(&config.box_home.join("disks/disk.qcow2"), true)
        .unwrap()
        .leak();
    let readonly_home = inject_chmod_failure.then(|| ReadOnlyDir::new(config.box_home.clone()));
    let readonly_locks = inject_chmod_failure.then(|| ReadOnlyDir::new(runtime.layout.locks_dir()));
    runtime.remove_box(handle.id(), false).unwrap();
    drop(readonly_home);
    drop(readonly_locks);
    assert!(
        runtime
            .box_manager
            .box_by_id(handle.id())
            .unwrap()
            .is_none()
    );
    let id = state.lock_id.unwrap();
    assert!(
        !runtime
            .layout
            .disk_locks_dir()
            .join(id.to_string())
            .exists()
    );
    assert_eq!(
        runtime.layout.locks_dir().join(id.to_string()).is_file(),
        inject_chmod_failure
    );
    assert_eq!(
        config.box_home.exists(),
        inject_chmod_failure,
        "only injected directory cleanup failure should leave the box home"
    );
}

#[tokio::test]
async fn disk_lock_clone_recovers_after_staging_failure_and_tolerates_ref_write_failure() {
    enable_disk_lock_logs();
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(options(&home)).unwrap();
    let source = create(&runtime).await;
    let (config, _) = runtime.box_manager.box_by_id(source.id()).unwrap().unwrap();
    let disk = config.box_home.join("disks/disk.qcow2");
    crate::disk::Qcow2Helper::create_disk(&disk, true)
        .unwrap()
        .leak();
    // SAFETY: geteuid only reads the effective user ID.
    if unsafe { libc::geteuid() } != 0 {
        let readonly = ReadOnlyDir::new(runtime.layout.boxes_dir());
        let failed = source.clone_box(Default::default(), None).await;
        drop(readonly);
        assert!(
            matches!(failed, Err(BoxliteError::Storage(message)) if message.contains("temp box directory"))
        );
        assert_eq!(runtime.box_manager.all_boxes(true).unwrap().len(), 1);
    } else {
        eprintln!("skipping chmod fault injection: root can write in read-only directories");
    }
    let id = assert_pair(&runtime, source.id(), true);
    let disk_locker = runtime.disk_lock_manager.retrieve(id).unwrap();
    let lifecycle = runtime.lock_manager.retrieve(id).unwrap();
    assert!(crate::lock::LockGuard::try_new(disk_locker.as_ref()).is_some());
    assert!(crate::lock::LockGuard::try_new(lifecycle.as_ref()).is_some());
    assert_eq!(
        std::fs::read_dir(runtime.layout.temp_dir())
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        std::fs::read_dir(runtime.layout.boxes_dir())
            .unwrap()
            .count(),
        1
    );
    let database = rusqlite::Connection::open(runtime.layout.db_dir().join("boxlite.db")).unwrap();
    database
        .execute_batch(
            "CREATE TRIGGER reject_clone_ref BEFORE INSERT ON base_disk_ref
         WHEN NEW.box_id != (SELECT source_box_id FROM base_disk WHERE id = NEW.base_disk_id)
         BEGIN SELECT RAISE(ABORT, 'injected clone reference failure'); END;",
        )
        .unwrap();
    let cloned = source.clone_box(Default::default(), None).await.unwrap();
    database
        .execute_batch("DROP TRIGGER reject_clone_ref")
        .unwrap();
    let (cloned_config, cloned_state) =
        runtime.box_manager.box_by_id(cloned.id()).unwrap().unwrap();
    let backing = crate::disk::read_backing_file_path(&disk).unwrap().unwrap();
    assert_eq!(
        crate::disk::read_backing_file_path(&cloned_config.box_home.join("disks/disk.qcow2"))
            .unwrap(),
        Some(backing.clone())
    );
    let base = runtime
        .base_disk_mgr
        .store()
        .find_by_base_path(&backing)
        .unwrap()
        .unwrap();
    assert_eq!(
        runtime
            .base_disk_mgr
            .store()
            .dependent_boxes(base.id())
            .unwrap(),
        vec![source.id().to_string()]
    );
    assert_eq!(cloned_state.status, BoxStatus::Stopped);
    assert_pair(&runtime, cloned.id(), true);
    assert!(crate::lock::LockGuard::try_new(disk_locker.as_ref()).is_some());
    assert!(crate::lock::LockGuard::try_new(lifecycle.as_ref()).is_some());
    assert_eq!(
        std::fs::read_dir(runtime.layout.temp_dir())
            .unwrap()
            .count(),
        0
    );
    let box_dirs: std::collections::BTreeSet<_> = std::fs::read_dir(runtime.layout.boxes_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(
        box_dirs,
        std::collections::BTreeSet::from([config.box_home, cloned_config.box_home])
    );
}

// Keep logging silent, but execute log-compatible field formatting too.
fn enable_disk_lock_logs() {
    struct Sink;
    impl tracing::log::Log for Sink {
        fn enabled(&self, _: &tracing::log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, _: &tracing::log::Record<'_>) {}
        fn flush(&self) {}
    }
    static LOGGER: Sink = Sink;
    let _ = tracing::log::set_logger(&LOGGER);
    tracing::log::set_max_level(tracing::log::LevelFilter::Trace);
}
