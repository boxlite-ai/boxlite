use crate::runtime::rt_impl::RuntimeImpl;
use crate::{BoxOptions, BoxStatus, BoxliteOptions, CloneOptions};
use std::os::unix::fs::MetadataExt;

#[tokio::test]
async fn checkpoint_clone_capture_preserves_source_inode_and_one_standalone_base() {
    let home = tempfile::tempdir().unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().into(),
        ..Default::default()
    })
    .unwrap();
    let source = runtime.create(BoxOptions::default(), None).await.unwrap();
    let backend = source.local_backend("test").unwrap();
    std::fs::create_dir_all(backend.config.box_home.join("disks")).unwrap();
    let raw = home.path().join("base.ext4");
    std::fs::write(&raw, vec![31; 1 << 20]).unwrap();
    let path = backend.config.box_home.join("disks/disk.qcow2");
    crate::disk::Qcow2Helper::create_cow_child_disk(
        &raw,
        crate::disk::BackingFormat::Raw,
        &path,
        1 << 20,
    )
    .unwrap()
    .leak();
    let mut state = runtime.box_manager.update_box(source.id()).unwrap();
    state.force_status(BoxStatus::Stopped);
    runtime.box_manager.save_box(source.id(), &state).unwrap();
    let open = std::fs::File::open(&path).unwrap();
    let before = open.metadata().unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let clones = source
        .clone_boxes(CloneOptions::default(), 3, Vec::new())
        .await
        .unwrap();
    let after = std::fs::metadata(&path).unwrap();
    assert_eq!(
        (before.dev(), before.ino()),
        (after.dev(), after.ino()),
        "capture must not replace the source disk open description"
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let mut backings = Vec::new();
    for cloned in clones {
        let backend = cloned.local_backend("test").unwrap();
        backings.push(
            crate::disk::read_backing_file_path(&backend.config.box_home.join("disks/disk.qcow2"))
                .unwrap()
                .unwrap(),
        );
    }
    assert!(
        backings.iter().all(|path| path == &backings[0]),
        "batch shares one captured base"
    );
    assert_eq!(
        crate::disk::read_backing_file_path(std::path::Path::new(&backings[0])).unwrap(),
        None
    );
    assert_ne!(
        open.metadata().unwrap().ino(),
        std::fs::metadata(&backings[0]).unwrap().ino()
    );
}
