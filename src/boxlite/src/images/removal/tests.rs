use super::*;
use crate::images::{ImageManager, store::tests::seed_removable_build as seed_cached_build};
use crate::runtime::images::{ImageBackend, ImageHandle};
use crate::runtime::options::{BoxOptions, BoxliteOptions};
use crate::runtime::rt_impl::{LocalRuntime, RuntimeImpl};

const FIRST: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const SECOND: &str = "sha256:1222222222222222222222222222222222222222222222222222222222222222";

fn runtime() -> (Arc<RuntimeImpl>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: dir.path().to_path_buf(),
        ..Default::default()
    })
    .unwrap();
    (runtime, dir)
}

fn handle(runtime: &Arc<RuntimeImpl>) -> ImageHandle {
    ImageHandle::new(Arc::new(LocalRuntime(Arc::clone(runtime))), None)
}

async fn seed(images: &ImageManager, repository: &str, id: &str) {
    seed_cached_build(images.store(), &format!("{repository}@{id}"), id).await;
}

#[tokio::test]
async fn removal_resolves_full_and_short_ids_once_per_manifest() {
    let (runtime, _dir) = runtime();
    seed(&runtime.image_manager, "one.example/app", FIRST).await;
    seed(&runtime.image_manager, "two.example/app", FIRST).await;
    let images = handle(&runtime);
    for id in [FIRST, &FIRST[7..], "111111111111", "1"] {
        assert_eq!(
            images
                .resolve_ids(&[id.into()])
                .await
                .unwrap()
                .remove(0)
                .unwrap(),
            FIRST
        );
    }
    seed(&runtime.image_manager, "two.example/app", SECOND).await;
    let ids = [
        "1",
        "111",
        "f",
        "",
        "../",
        "sha256:1",
        "ABC",
        &"1".repeat(65),
    ]
    .map(str::to_string);
    let results = images.resolve_ids(&ids).await.unwrap();
    assert!(matches!(results[0], Err(BoxliteError::AmbiguousImageId(_))));
    assert_eq!(results[1].as_ref().unwrap(), FIRST);
    assert!(matches!(results[2], Err(BoxliteError::NotFound(_))));
    assert!(
        results[3..]
            .iter()
            .all(|result| matches!(result, Err(BoxliteError::InvalidArgument(_))))
    );
}

#[tokio::test]
async fn removal_clears_every_repository_alias_and_preserves_retained_shared_data() {
    let (runtime, _dir) = runtime();
    seed(&runtime.image_manager, "one.example/app", FIRST).await;
    seed(&runtime.image_manager, "two.example/app", FIRST).await;
    let retained = seed_cached_build(
        runtime.image_manager.store(),
        "one.example/app:latest",
        SECOND,
    )
    .await;
    let storage = runtime.image_manager.store().storage().await;
    let result = handle(&runtime).remove_by_id("111").await.unwrap();
    assert_eq!(result.image_id, FIRST);
    assert_eq!(result.removed_references.len(), 2);
    assert!(result.reclaimed_bytes > 0);
    assert!(!storage.manifest_path(FIRST).exists());
    assert!(storage.config_path(&retained.config_digest).exists());
    assert!(
        storage
            .layer_tarball_path(&retained.layers[0].digest)
            .exists()
    );
    let image = runtime
        .image_manager
        .pull("one.example/app:latest")
        .await
        .unwrap();
    image.load_config().await.unwrap();
    assert_eq!(image.manifest_digest(), SECOND);
}

#[tokio::test]
async fn removal_refuses_tags_including_a_tag_pinned_to_a_digest() {
    for reference in [
        "one.example/app:latest".to_string(),
        format!("one.example/app:stable@{FIRST}"),
    ] {
        let (runtime, _dir) = runtime();
        seed(&runtime.image_manager, "two.example/app", FIRST).await;
        seed_cached_build(runtime.image_manager.store(), &reference, FIRST).await;
        let error = handle(&runtime).remove_by_id(FIRST).await.unwrap_err();
        assert!(matches!(error, BoxliteError::ImageHasTags(_)));
        assert!(error.to_string().contains(&reference));
        assert_eq!(runtime.image_manager.list().await.unwrap().len(), 2);
        assert!(
            runtime
                .image_manager
                .store()
                .storage()
                .await
                .manifest_path(FIRST)
                .exists()
        );
    }
}

#[tokio::test]
async fn removal_protects_configured_stopped_and_pinned_boxes() {
    use crate::runtime::types::BoxStatus;
    for status in [
        BoxStatus::Configured,
        BoxStatus::Stopped,
        BoxStatus::Running,
        BoxStatus::Failed,
    ] {
        let (runtime, _dir) = runtime();
        seed(&runtime.image_manager, "one.example/app", FIRST).await;
        let box_handle = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image(format!("one.example/app@{FIRST}")),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        let (config, mut state) = runtime.box_manager.all_boxes(true).unwrap().remove(0);
        state.status = status;
        state.resolved_image = Some(crate::images::ResolvedImage {
            manifest_digest: FIRST.into(),
            total_layer_size: 0,
        });
        runtime.box_manager.save_box(&config.id, &state).unwrap();
        let error = handle(&runtime).remove_by_id("111").await.unwrap_err();
        assert!(matches!(error, BoxliteError::ImageUsedByBoxes(_)));
        assert!(error.to_string().contains(box_handle.id().as_str()));
        assert!(
            runtime
                .image_manager
                .store()
                .storage()
                .await
                .manifest_path(FIRST)
                .exists()
        );
    }
}

#[tokio::test]
async fn removal_protects_legacy_unqualified_references_across_registry_search() {
    let (runtime, _dir) = runtime();
    seed(
        &runtime.image_manager,
        "mirror.example/library/alpine",
        FIRST,
    )
    .await;
    let box_handle = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let error = handle(&runtime).remove_by_id("111").await.unwrap_err();
    assert!(matches!(error, BoxliteError::ImageUsedByBoxes(_)));
    assert!(error.to_string().contains(box_handle.id().as_str()));
}

#[tokio::test]
async fn removal_retains_unknown_box_contents_and_all_disk_cache_variants() {
    let (runtime, _dir) = runtime();
    seed(&runtime.image_manager, "one.example/app", FIRST).await;
    let (_, mut state) = {
        runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("other.example/app:latest".into()),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        runtime.box_manager.all_boxes(true).unwrap().remove(0)
    };
    state.resolved_image = Some(crate::images::ResolvedImage {
        manifest_digest: SECOND.into(),
        total_layer_size: 0,
    });
    let (config, _) = runtime.box_manager.all_boxes(true).unwrap().remove(0);
    runtime.box_manager.save_box(&config.id, &state).unwrap();
    let storage = runtime.image_manager.store().storage().await;
    let image = runtime
        .image_manager
        .pull(&format!("one.example/app@{FIRST}"))
        .await
        .unwrap();
    let config_path = storage.config_path(image.config_digest());
    let layer_path = storage.layer_tarball_path(image.layer_digests()[0]);
    let disk = storage.disk_images_dir().join(format!(
        "{}-r0.ext4",
        image.compute_image_digest().replace(':', "-")
    ));
    fs::write(&disk, b"base disk").unwrap();
    drop(image);
    handle(&runtime).remove_by_id(FIRST).await.unwrap();
    assert!(config_path.exists());
    assert!(layer_path.exists());
    assert!(disk.exists());
}

#[tokio::test]
async fn removal_refuses_active_image_consumers_until_every_clone_is_released() {
    let (runtime, _dir) = runtime();
    seed(&runtime.image_manager, "one.example/app", FIRST).await;
    let image = runtime
        .image_manager
        .pull(&format!("one.example/app@{FIRST}"))
        .await
        .unwrap();
    let clone = image.clone();
    drop(image);
    let images = handle(&runtime);
    assert!(matches!(
        images.remove_by_id(FIRST).await,
        Err(BoxliteError::InvalidState(_))
    ));
    clone.load_config().await.unwrap();
    drop(clone);
    images.remove_by_id(FIRST).await.unwrap();
}

#[tokio::test]
async fn removal_reports_zero_when_the_target_has_no_files_left() {
    let (runtime, _dir) = runtime();
    seed(&runtime.image_manager, "one.example/app", FIRST).await;
    let storage = runtime.image_manager.store().storage().await;
    let image = runtime
        .image_manager
        .pull(&format!("one.example/app@{FIRST}"))
        .await
        .unwrap();
    fs::remove_file(storage.config_path(image.config_digest())).unwrap();
    fs::remove_file(storage.layer_tarball_path(image.layer_digests()[0])).unwrap();
    fs::remove_file(storage.manifest_path(FIRST)).unwrap();
    drop(image);
    assert_eq!(
        handle(&runtime)
            .remove_by_id(FIRST)
            .await
            .unwrap()
            .reclaimed_bytes,
        0
    );
}

#[tokio::test]
async fn removal_reclaims_every_unique_cache_object_and_reports_its_allocated_bytes() {
    let (runtime, _dir) = runtime();
    let manifest = seed_cached_build(
        runtime.image_manager.store(),
        &format!("one.example/app@{FIRST}"),
        FIRST,
    )
    .await;
    let storage = runtime.image_manager.store().storage().await;
    let config = storage.config_path(&manifest.config_digest);
    let layer = storage.layer_tarball_path(&manifest.layers[0].digest);
    fs::write(&layer, b"cached tarball").unwrap();
    let extracted = storage.layer_extracted_path(&manifest.layers[0].digest);
    fs::create_dir(&extracted).unwrap();
    let contents = extracted.join("contents");
    fs::write(&contents, [42; 8192]).unwrap();
    let paths = [
        storage.manifest_path(FIRST),
        config,
        layer,
        extracted,
        contents,
    ];
    let expected: u64 = paths
        .iter()
        .map(|path| fs::symlink_metadata(path).unwrap().blocks() * 512)
        .sum();
    let result = handle(&runtime).remove_by_id(FIRST).await.unwrap();
    assert_eq!(result.reclaimed_bytes, expected);
    assert!(paths.iter().all(|path| !path.exists()));
}

#[tokio::test]
async fn removal_refuses_corrupt_cache_and_box_metadata_before_deleting_any_file() {
    for corrupt_box in [false, true] {
        let (runtime, _dir) = runtime();
        seed(&runtime.image_manager, "one.example/app", FIRST).await;
        let db = crate::db::Database::open(&runtime.layout.db_dir().join("boxlite.db")).unwrap();
        if corrupt_box {
            runtime
                .create(
                    BoxOptions {
                        rootfs: RootfsSpec::Image("other.example/app:latest".into()),
                        ..Default::default()
                    },
                    None,
                )
                .await
                .unwrap();
            db.conn()
                .execute("UPDATE box_state SET json = 'unreadable'", [])
                .unwrap();
        } else {
            let index = ImageIndexStore::new(db);
            let reference = format!("one.example/app@{FIRST}");
            let mut cached = index.get(&reference).unwrap().unwrap();
            cached.config_digest = "sha256:../../outside".into();
            index.upsert(&reference, &cached).unwrap();
        }
        let error = handle(&runtime).remove_by_id(FIRST).await.unwrap_err();
        assert!(matches!(
            error,
            BoxliteError::MetadataError(_) | BoxliteError::Database(_)
        ));
        assert!(
            runtime
                .image_manager
                .store()
                .storage()
                .await
                .manifest_path(FIRST)
                .exists()
        );
    }
}

#[tokio::test]
async fn removal_keeps_retained_content_when_index_deletion_fails_and_can_retry() {
    let (runtime, _dir) = runtime();
    seed(&runtime.image_manager, "one.example/app", FIRST).await;
    let retained = seed_cached_build(
        runtime.image_manager.store(),
        "two.example/app:latest",
        SECOND,
    )
    .await;
    let db = crate::db::Database::open(&runtime.layout.db_dir().join("boxlite.db")).unwrap();
    db.conn().execute_batch("CREATE TRIGGER refuse_removal BEFORE DELETE ON image_index BEGIN SELECT RAISE(ABORT, 'fixture index failure'); END").unwrap();
    assert!(matches!(
        handle(&runtime).remove_by_id(FIRST).await,
        Err(BoxliteError::Database(_))
    ));
    let storage = runtime.image_manager.store().storage().await;
    assert!(storage.manifest_path(SECOND).exists());
    assert!(storage.config_path(&retained.config_digest).exists());
    assert!(
        storage
            .layer_tarball_path(&retained.layers[0].digest)
            .exists()
    );
    db.conn()
        .execute_batch("DROP TRIGGER refuse_removal")
        .unwrap();
    let result = handle(&runtime).remove_by_id(FIRST).await.unwrap();
    assert_eq!(result.reclaimed_bytes, 0);
    assert_eq!(runtime.image_manager.list().await.unwrap().len(), 1);
}

#[tokio::test]
async fn removal_refuses_after_runtime_shutdown() {
    let (runtime, _dir) = runtime();
    runtime.shutdown(None).await.unwrap();
    assert!(matches!(
        LocalRuntime(runtime).remove_image_by_id(FIRST).await,
        Err(BoxliteError::Stopped(_))
    ));
}

#[test]
fn removal_unlinks_symlinks_without_touching_their_targets() {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    fs::write(external.path().join("keep"), b"external data").unwrap();
    let storage = ImageStorage::new(root.path().to_path_buf()).unwrap();
    let path = storage.layer_extracted_path(FIRST);
    std::os::unix::fs::symlink(external.path(), &path).unwrap();
    remove_paths(root.path(), BTreeSet::from([path.clone()])).unwrap();
    assert!(fs::symlink_metadata(path).is_err());
    assert_eq!(
        fs::read(external.path().join("keep")).unwrap(),
        b"external data"
    );
}

#[test]
fn removal_refuses_a_cache_parent_redirected_outside_the_store() {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let storage = ImageStorage::new(root.path().to_path_buf()).unwrap();
    let path = storage.layer_tarball_path(FIRST);
    fs::remove_dir(path.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(external.path(), path.parent().unwrap()).unwrap();
    fs::write(&path, b"keep").unwrap();
    assert!(remove_paths(root.path(), BTreeSet::from([path.clone()])).is_err());
    assert_eq!(fs::read(path).unwrap(), b"keep");
}

#[test]
fn removal_counts_last_links_and_allocated_blocks_instead_of_sparse_lengths() {
    let root = tempfile::tempdir().unwrap();
    let storage = ImageStorage::new(root.path().to_path_buf()).unwrap();
    let path = storage.config_path(FIRST);
    fs::write(&path, vec![42; 8192]).unwrap();
    let external_link = root.path().join("keep-link");
    fs::hard_link(&path, &external_link).unwrap();
    assert_eq!(
        remove_paths(root.path(), BTreeSet::from([path])).unwrap(),
        0
    );
    assert_eq!(fs::read(&external_link).unwrap().len(), 8192);
    let final_link = storage.config_path(SECOND);
    fs::hard_link(&external_link, &final_link).unwrap();
    let expected = fs::metadata(&final_link).unwrap().blocks() * 512;
    assert_eq!(
        remove_paths(root.path(), BTreeSet::from([external_link, final_link])).unwrap(),
        expected
    );
    let sparse = storage.layer_tarball_path(FIRST);
    fs::File::create(&sparse)
        .unwrap()
        .set_len(32 * 1024 * 1024)
        .unwrap();
    let metadata = fs::metadata(&sparse).unwrap();
    assert!(metadata.blocks() * 512 < metadata.len());
    assert_eq!(
        remove_paths(root.path(), BTreeSet::from([sparse])).unwrap(),
        metadata.blocks() * 512
    );
}

#[test]
fn removal_handles_readonly_extracted_directories_and_nested_symlinks() {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    fs::write(external.path().join("keep"), b"keep").unwrap();
    let storage = ImageStorage::new(root.path().to_path_buf()).unwrap();
    let path = storage.layer_extracted_path(FIRST);
    fs::create_dir_all(path.join("readonly")).unwrap();
    fs::write(path.join("readonly/file"), b"cached contents").unwrap();
    std::os::unix::fs::symlink(external.path(), path.join("outside")).unwrap();
    fs::set_permissions(path.join("readonly"), fs::Permissions::from_mode(0o500)).unwrap();
    assert!(remove_paths(root.path(), BTreeSet::from([path.clone()])).unwrap() > 0);
    assert!(!path.exists());
    assert!(external.path().join("keep").exists());
}

#[tokio::test]
async fn removal_reclaims_unique_disks_but_preserves_shared_keys_and_lookalikes() {
    for shared in [false, true] {
        let (runtime, _dir) = runtime();
        seed(&runtime.image_manager, "one.example/app", FIRST).await;
        if shared {
            seed(&runtime.image_manager, "two.example/app", SECOND).await;
        }
        let image = runtime
            .image_manager
            .pull(&format!("one.example/app@{FIRST}"))
            .await
            .unwrap();
        let key = image.compute_image_digest().replace(':', "-");
        let storage = runtime.image_manager.store().storage().await;
        let paths: Vec<_> = [
            format!("{key}-r0.ext4"),
            format!("{key}-r536870912.ext4"),
            format!("{key}-r1.ext4.downloading"),
            format!("{key}-r.ext4"),
            format!("{key}-r-1.ext4"),
        ]
        .into_iter()
        .map(|name| storage.disk_images_dir().join(name))
        .collect();
        for path in &paths {
            fs::write(path, b"disk data").unwrap();
        }
        drop(image);
        handle(&runtime).remove_by_id(FIRST).await.unwrap();
        assert_eq!(paths[0].exists(), shared);
        assert_eq!(paths[1].exists(), shared);
        assert!(paths[2..].iter().all(|path| path.exists()));
    }
}

#[tokio::test]
async fn removal_worker_keeps_cache_and_home_locked_after_caller_cancellation() {
    let (runtime, dir) = runtime();
    seed(&runtime.image_manager, "one.example/app", FIRST).await;
    let manager = runtime.image_manager.clone();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let task = tokio::spawn(async move {
        manager
            .remove_by_id(FIRST.into(), move || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(Vec::new())
            })
            .await
    });
    entered_rx.await.unwrap();
    assert!(matches!(
        handle(&runtime).remove_by_id(FIRST).await,
        Err(BoxliteError::InvalidState(_))
    ));
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    drop(runtime);
    assert!(crate::runtime::lock::RuntimeLock::acquire(dir.path()).is_err());
    release_tx.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(lock) = crate::runtime::lock::RuntimeLock::acquire(dir.path()) {
                break lock;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cleanup must finish and release the home lock");
}

#[tokio::test]
async fn removal_excludes_a_pull_before_it_has_written_its_index() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let host = listener.local_addr().unwrap().to_string();
    let dir = tempfile::tempdir().unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: dir.path().to_path_buf(),
        image_registries: vec![crate::ImageRegistry::http(&host)],
        ..Default::default()
    })
    .unwrap();
    seed(&runtime.image_manager, "one.example/app", FIRST).await;
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut buffer = [0; 1];
        socket.read_exact(&mut buffer).unwrap();
        entered_tx.send(()).unwrap();
        release_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let _ = socket
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    let manager = runtime.image_manager.clone();
    let pull = tokio::spawn(async move { manager.pull(&format!("{host}/app:latest")).await });
    entered_rx.await.unwrap();
    assert!(matches!(
        handle(&runtime).remove_by_id(FIRST).await,
        Err(BoxliteError::InvalidState(_))
    ));
    release_tx.send(()).unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), pull)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    server.join().unwrap();
    handle(&runtime).remove_by_id(FIRST).await.unwrap();
}

#[tokio::test]
async fn removal_serializes_box_creation_until_cleanup_finishes() {
    let (runtime, _dir) = runtime();
    seed(&runtime.image_manager, "one.example/app", FIRST).await;
    let manager = runtime.image_manager.clone();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let removed = tokio::spawn(async move {
        manager
            .remove_by_id(FIRST.into(), move || {
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                Ok(Vec::new())
            })
            .await
    });
    entered_rx.await.unwrap();
    let created = runtime.create(
        BoxOptions {
            rootfs: RootfsSpec::Image(format!("one.example/app@{FIRST}")),
            ..Default::default()
        },
        None,
    );
    tokio::pin!(created);
    assert!(futures::poll!(created.as_mut()).is_pending());
    assert!(runtime.box_manager.all_boxes(true).unwrap().is_empty());
    release_tx.send(()).unwrap();
    removed.await.unwrap().unwrap();
    let created = created.await.unwrap();
    assert_eq!(
        created.info().await.unwrap().status,
        crate::BoxStatus::Configured
    );
}

#[tokio::test]
async fn removal_waits_for_detached_extraction_after_its_caller_and_runtime_are_dropped() {
    use crate::images::blob_source::{BlobSource, StoreBlobSource};
    use std::io::Write;
    let (runtime, dir) = runtime();
    let manifest = seed_cached_build(
        runtime.image_manager.store(),
        &format!("one.example/app@{FIRST}"),
        FIRST,
    )
    .await;
    let storage = runtime.image_manager.store().storage().await;
    let tarball = storage.layer_tarball_path(&manifest.layers[0].digest);
    fs::remove_file(&tarball).unwrap();
    nix::unistd::mkfifo(
        &tarball,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        let mut pipe = fs::OpenOptions::new().write(true).open(tarball).unwrap();
        entered_tx.send(()).unwrap();
        release_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        // Header sniffing consumes two bytes; reopening reads the empty tar.
        // Keep this writer open through both reader opens, until extraction ends.
        pipe.write_all(&[0; 1026]).unwrap();
        let _ = finished_rx.recv_timeout(std::time::Duration::from_secs(5));
    });
    let source = BlobSource::Store(StoreBlobSource::new(storage))
        .with_lease(runtime.image_manager.cache_lease().await);
    let extraction = tokio::spawn(async move {
        source
            .extract_layers(&[manifest.layers[0].digest.clone()])
            .await
    });
    entered_rx.await.unwrap();
    assert!(matches!(
        handle(&runtime).remove_by_id(FIRST).await,
        Err(BoxliteError::InvalidState(_))
    ));
    extraction.abort();
    assert!(extraction.await.unwrap_err().is_cancelled());
    drop(runtime);
    assert!(crate::runtime::lock::RuntimeLock::acquire(dir.path()).is_err());
    release_tx.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(lock) = crate::runtime::lock::RuntimeLock::acquire(dir.path()) {
                break lock;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("extraction must finish and release the home lock");
    finished_tx.send(()).unwrap();
    writer.join().unwrap();
}
