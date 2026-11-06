//! New catalog contract checks; native capture/import are exercised separately.

use super::*;
use std::sync::{Arc, Barrier};

fn catalog() -> (Catalog, TempDir) {
    let temporary = tempfile::tempdir().unwrap();
    (
        Catalog::new(temporary.path().join("checkpoints")),
        temporary,
    )
}

fn staged(catalog: &Catalog) -> TempDir {
    let stage = catalog.stage().unwrap();
    // This tests the storage boundary, which owns bytes, not archive parsing.
    fs::write(Catalog::archive_path(&stage), b"immutable archive payload").unwrap();
    stage
}

fn publish(catalog: &Catalog, name: &str) -> CheckpointInfo {
    catalog
        .publish(
            staged(catalog),
            Some(name.into()),
            "source-box".into(),
            format!("example/image@sha256:{}", "a".repeat(64)),
        )
        .unwrap()
}

#[test]
fn absent_catalog_is_empty_without_creating_a_directory() {
    let (catalog, _temporary) = catalog();
    assert!(catalog.list().unwrap().is_empty());
    assert!(!catalog.root.exists());
    assert!(matches!(
        catalog.get("absent"),
        Err(BoxliteError::NotFound(_))
    ));
    catalog.remove("absent", true).unwrap();
    assert!(!catalog.root.exists());
}

#[test]
fn published_records_round_trip_and_keep_the_archive_private() {
    let (catalog, _temporary) = catalog();
    let info = publish(&catalog, "base");
    let reopened = Catalog::new(catalog.root.clone());
    assert_eq!(reopened.list().unwrap(), vec![info.clone()]);
    for key in [&info.id, &info.name] {
        let lease = reopened.get(key).unwrap();
        assert_eq!(lease.record.info, info);
        lease.verify().unwrap();
        assert_eq!(
            fs::read(&lease.archive).unwrap(),
            b"immutable archive payload"
        );
        assert_eq!(
            fs::metadata(lease.archive).unwrap().permissions().mode() & 0o777,
            0o400
        );
    }
    assert_eq!(
        fs::metadata(catalog.directory(&info.id).unwrap().join(RECORD))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn checkpoint_deletion_retry_reclaims_archive_after_interruption() {
    for by_name in [false, true] {
        let (catalog, _temporary) = catalog();
        let info = publish(&catalog, "delete-retry");
        let deleting = catalog.root.join(format!(".deleting-{}", info.id));
        fs::rename(catalog.directory(&info.id).unwrap(), &deleting).unwrap();
        sync_directory(&catalog.root).unwrap();
        let reopened = Catalog::new(catalog.root.clone());
        reopened
            .remove(if by_name { &info.name } else { &info.id }, true)
            .unwrap();
        assert!(
            !deleting.join(ARCHIVE).exists(),
            "successful deletion retry left captured archive bytes behind"
        );
        assert!(!deleting.exists());
        assert!(reopened.list().unwrap().is_empty());
    }
}

#[test]
fn checkpoint_deletion_keeps_metadata_until_partial_cleanup_can_resume() {
    for (removed_archive, removed_directory) in [(false, false), (true, false), (true, true)] {
        let (catalog, _temporary) = catalog();
        let info = publish(&catalog, "delete-pending");
        let deleting = catalog.root.join(format!(".deleting-{}", info.id));
        let receipt = catalog.root.join(format!(".deleting-{}.json", info.id));
        fs::rename(catalog.directory(&info.id).unwrap(), &deleting).unwrap();
        fs::rename(deleting.join(RECORD), &receipt).unwrap();
        if removed_archive {
            fs::remove_file(deleting.join(ARCHIVE)).unwrap();
        }
        if removed_directory {
            fs::remove_dir(&deleting).unwrap();
        }
        sync_directory(&catalog.root).unwrap();
        let reopened = Catalog::new(catalog.root.clone());
        let mut pending = info.clone();
        pending.state = super::super::CheckpointState::Deleting;
        assert_eq!(reopened.list().unwrap(), vec![pending]);
        assert!(matches!(
            reopened.get(&info.id),
            Err(BoxliteError::InvalidState(_))
        ));
        assert!(matches!(
            reopened.publish(
                staged(&reopened),
                Some(info.name.clone()),
                "source-box".into(),
                "image".into()
            ),
            Err(BoxliteError::InvalidState(_))
        ));
        reopened.remove(&info.name, false).unwrap();
        assert!(!deleting.exists());
        assert!(!receipt.exists());
        assert!(reopened.list().unwrap().is_empty());
    }
}

#[test]
fn unpublished_and_dropped_stages_do_not_become_listed_checkpoints() {
    let (catalog, _temporary) = catalog();
    let stage = staged(&catalog);
    let path = stage.path().to_path_buf();
    assert!(catalog.list().unwrap().is_empty());
    drop(stage);
    assert!(!path.exists());
    assert!(catalog.list().unwrap().is_empty());
}

#[test]
fn duplicate_name_rejection_preserves_the_first_archive_and_cleans_staging() {
    let (catalog, _temporary) = catalog();
    let first = publish(&catalog, "base");
    let stage = staged(&catalog);
    let path = stage.path().to_path_buf();
    let error = catalog
        .publish(stage, Some("base".into()), "other".into(), "image".into())
        .unwrap_err();
    assert!(matches!(error, BoxliteError::InvalidState(_)));
    assert!(!path.exists());
    assert_eq!(catalog.list().unwrap(), vec![first]);
    catalog.get("base").unwrap().verify().unwrap();
}

#[test]
fn competing_publishers_using_separate_catalogs_cannot_both_take_one_name() {
    let (catalog, _temporary) = catalog();
    let gate = Arc::new(Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let catalog = catalog.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                let stage = staged(&catalog);
                gate.wait();
                catalog.publish(
                    stage,
                    Some("shared".into()),
                    "source".into(),
                    "image".into(),
                )
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(catalog.list().unwrap().len(), 1);
    assert!(fs::read_dir(&catalog.root).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".creating-")
    }));
}

#[test]
fn a_reader_blocks_deletion_even_with_force_and_another_catalog_instance() {
    let (catalog, _temporary) = catalog();
    let info = publish(&catalog, "base");
    let lease = catalog.get(&info.id).unwrap();
    let another = Catalog::new(catalog.root.clone());
    for force in [false, true] {
        assert!(matches!(
            another.remove(&info.id, force),
            Err(BoxliteError::InvalidState(_))
        ));
        lease.verify().unwrap();
    }
    drop(lease);
    another.remove("base", false).unwrap();
    assert!(catalog.list().unwrap().is_empty());
    assert!(!catalog.directory(&info.id).unwrap().exists());
    another.remove(&info.id, true).unwrap();
    assert!(matches!(
        another.remove(&info.id, false),
        Err(BoxliteError::NotFound(_))
    ));
}

#[test]
fn damaged_published_metadata_is_an_error_instead_of_an_empty_list() {
    let (catalog, _temporary) = catalog();
    let info = publish(&catalog, "base");
    fs::write(catalog.directory(&info.id).unwrap().join(RECORD), b"broken").unwrap();
    assert!(matches!(catalog.list(), Err(BoxliteError::Storage(_))));
}

#[test]
fn changed_archive_bytes_do_not_match_the_persisted_digest() {
    let (catalog, _temporary) = catalog();
    publish(&catalog, "base");
    let lease = catalog.get("base").unwrap();
    fs::set_permissions(&lease.archive, fs::Permissions::from_mode(0o600)).unwrap();
    let mut contents = fs::read(&lease.archive).unwrap();
    contents[0] ^= 1;
    fs::write(&lease.archive, contents).unwrap();
    assert!(matches!(lease.verify(), Err(BoxliteError::Storage(_))));
}

#[test]
fn symlinked_catalog_members_are_refused() {
    let (catalog, temporary) = catalog();
    let info = publish(&catalog, "base");
    let archive = catalog.directory(&info.id).unwrap().join(ARCHIVE);
    let outside = temporary.path().join("outside");
    fs::rename(&archive, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &archive).unwrap();
    assert!(matches!(
        catalog.get(&info.id),
        Err(BoxliteError::Storage(_))
    ));
    assert!(outside.exists());
}

#[test]
fn names_and_lookup_keys_cannot_select_paths_outside_the_catalog() {
    let (catalog, _temporary) = catalog();
    for key in [
        "",
        ".",
        "..",
        "../outside",
        "a/b",
        "a\\b",
        " x",
        "x\n",
        "x\0",
    ] {
        assert!(checked_name(key).is_err(), "{key:?}");
        assert!(matches!(
            catalog.get(key),
            Err(BoxliteError::InvalidArgument(_))
        ));
    }
    assert!(checked_name(&"a".repeat(128)).is_ok());
    assert!(checked_name(&"a".repeat(129)).is_err());
    assert!(!catalog.root.exists());
}
