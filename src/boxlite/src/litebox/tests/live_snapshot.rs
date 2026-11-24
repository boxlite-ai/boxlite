use super::*;

fn staged_transaction() -> (tempfile::TempDir, Journal, Paths) {
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path().canonicalize().unwrap();
    fs::create_dir(home.join("disks")).unwrap();
    fs::create_dir(home.join("snapshots")).unwrap();
    let transaction = nanoid::nanoid!();
    let paths = Paths::new(&home, "pending", &transaction).unwrap();
    fs::write(&paths.active, b"original").unwrap();
    let mut journal = Journal {
        version: JOURNAL_VERSION,
        decision: Decision::Pending,
        finished: false,
        boot_id: current_boot_id().unwrap(),
        shim: PidRecord::current(),
        info: SnapshotInfo {
            id: transaction,
            box_id: "box".into(),
            name: "pending".into(),
            created_at: 0,
            disk_info: DiskInfo {
                base_path: paths.saved.to_str().unwrap().into(),
                container_disk_bytes: 64 * 1024 * 1024,
                size_bytes: 0,
            },
        },
        source: FileId::at(&paths.active).unwrap(),
        reservation: None,
        overlay: None,
    };
    paths.qualify(journal.source).unwrap();
    journal.save(&paths).unwrap();
    paths.reserve(&mut journal).unwrap();
    let until = monotonic_nanos() + FENCE_WINDOW.as_nanos() as u64;
    stage_and_pivot(&paths, &mut journal, until).unwrap();
    (temporary, journal, paths)
}

#[test]
fn live_snapshot_finished_marker_does_not_replay_old_disk_changes() {
    let (_temporary, mut journal, paths) = staged_transaction();
    journal.prepare_abort(&paths).unwrap();
    journal.finish(&paths).unwrap();

    // Model a crash before the last unlink reached disk and a later disk layout.
    journal.save(&paths).unwrap();
    fs::rename(&paths.disks, paths.home.join("old-disks")).unwrap();
    assert!(Journal::load(&paths.home, "box").unwrap().is_none());
    assert!(!paths.journal.exists());
    assert_eq!(
        fs::read(paths.home.join("old-disks").join(CONTAINER_DISK)).unwrap(),
        b"original"
    );
}

#[test]
fn live_snapshot_abort_persists_a_and_can_replay() {
    let (_temporary, journal, paths) = staged_transaction();
    assert_eq!(FileId::at(&paths.active).unwrap(), journal.overlay.unwrap());

    let (mut recovered, paths) = Journal::load(&paths.home, "box").unwrap().unwrap();
    recovered.prepare_abort(&paths).unwrap();
    assert_eq!(FileId::at(&paths.active).unwrap(), journal.source);
    assert_eq!(fs::read(&paths.active).unwrap(), b"original");

    let (mut recovered, paths) = Journal::load(&paths.home, "box").unwrap().unwrap();
    assert_eq!(recovered.decision, Decision::AbortReady);
    recovered.prepare_abort(&paths).unwrap();
    recovered.finish(&paths).unwrap();
    assert_eq!(FileId::at(&paths.active).unwrap(), journal.source);
    assert!(!paths.target.exists());
    assert!(!paths.journal.exists());
}

#[test]
fn live_snapshot_corrupt_decision_keeps_both_disks() {
    let (_temporary, journal, paths) = staged_transaction();
    let original = fs::read_to_string(&paths.journal).unwrap();
    let changed = original.replace(r#""decision":"Pending""#, r#""decision":"Commit""#);
    assert_ne!(changed, original);
    fs::write(&paths.journal, changed).unwrap();

    let Err(error) = Journal::load(&paths.home, "box") else {
        panic!("recovery accepted a changed decision without its checksum");
    };
    assert!(error.to_string().contains("checksum mismatch"));
    assert_eq!(FileId::at(&paths.saved).unwrap(), journal.source);
    assert_eq!(FileId::at(&paths.active).unwrap(), journal.overlay.unwrap());
    assert!(paths.journal.exists());
}

#[test]
fn live_snapshot_registration_preserves_conflicting_row() {
    let (_temporary, journal, paths) = staged_transaction();
    let database = paths.home.join("boxlite.db");
    let store = SnapshotStore::new(crate::db::Database::open(&database).unwrap());
    let mut conflicting = journal.info.clone();
    conflicting.id = "other-snapshot".into();
    store.save(&conflicting).unwrap();

    let error = SnapshotStore::register_live(&database, &journal.info).unwrap_err();
    assert!(error.to_string().contains("registration conflict"));
    assert_eq!(
        store.find("box", "pending").unwrap().unwrap().id,
        conflicting.id
    );
    assert_eq!(FileId::at(&paths.saved).unwrap(), journal.source);
    assert_eq!(FileId::at(&paths.active).unwrap(), journal.overlay.unwrap());

    store.delete(&conflicting.id).unwrap();
    assert!(SnapshotStore::register_live(&database, &journal.info).unwrap());
    assert!(SnapshotStore::register_live(&database, &journal.info).unwrap());
    assert_eq!(
        store.find("box", "pending").unwrap().unwrap().id,
        journal.info.id
    );
}
