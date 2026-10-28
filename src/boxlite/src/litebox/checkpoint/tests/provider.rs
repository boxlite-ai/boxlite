use super::*;
use crate::ObjectDependency;

fn share(root: &Path) -> ShareDependency {
    let root_stat = std::fs::metadata(root).unwrap();
    let file_stat = std::fs::metadata(root.join("data")).unwrap();
    let handle = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("data"))
        .unwrap();
    // SAFETY: a live test descriptor; the saved status originates at the OS.
    let flags = unsafe { libc::fcntl(handle.as_raw_fd(), libc::F_GETFL) };
    let objects = [root_stat, file_stat]
        .into_iter()
        .enumerate()
        .map(|(alias, st)| ObjectDependency {
            alias: alias as u64,
            guest_ino: st.ino(),
            ctime: (st.ctime(), st.ctime_nsec()),
            kind: st.mode() & 0o170000,
            reference: None,
            recipe: None,
        })
        .collect();
    ShareDependency {
        tag: "BoxLiteShared".into(),
        vm_owned: false,
        read_only: false,
        objects,
        state: serde_json::json!({"nodes":[{"inode":1,"object":0}],"handles":[{"handle":5,"object":1,"flags":flags,"listing":null}],
            "dax":{"size":4096,"mappings":[{"moffset":0,"len":4096,"kind":{"file":{"object":1,"foffset":0,"writable":true}}}]}}),
    }
}
fn dependencies(share: ShareDependency) -> CheckpointDependencies {
    CheckpointDependencies {
        version: 9,
        cpus: 1,
        memory_bytes: 4096,
        container_disk_bytes: 4096,
        boot_disk_bytes: 4096,
        boot_disk_sha256: String::new(),
        qcow2_bytes: 0,
        qcow2_sha256: String::new(),
        shares: vec![share],
        disk_dependencies: serde_json::Value::Null,
        application: serde_json::Value::Null,
    }
}
fn local(root: &Path) -> LocalCheckpointProvider {
    LocalCheckpointProvider {
        shares: BTreeMap::from([("BoxLiteShared".into(), "resource".into())]),
        resources: BTreeMap::from([(
            "resource".into(),
            LocalResource {
                recovery_point: "cut".into(),
                root: root.into(),
                source_root: None,
                objects: BTreeMap::from([
                    ("root".into(), LocalObject::Path { path: ".".into() }),
                    (
                        "file".into(),
                        LocalObject::Path {
                            path: "data".into(),
                        },
                    ),
                ]),
            },
        )]),
        boot_disks: BTreeMap::new(),
    }
}

#[tokio::test]
async fn checkpoint_provider_binds_production_references_and_rejects_wrong_access() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("data"), b"retained").unwrap();
    let provider = local(directory.path());
    let mut share = share(directory.path());
    let objects = vec![
        path_object(directory.path(), Path::new("."), object_flags()).unwrap(),
        path_object(directory.path(), Path::new("data"), object_flags()).unwrap(),
    ];
    let references = provider
        .prepare(CheckpointExportRequest {
            shares: vec![share.clone()],
            objects,
        })
        .await
        .unwrap();
    for (object, reference) in share.objects.iter_mut().zip(&references[0]) {
        object.reference = Some(reference.clone());
    }
    let dependencies = dependencies(share);
    let mut bindings = provider.bind(&dependencies).await.unwrap();
    bindings.validate(&dependencies).unwrap();
    bindings.shares[0].dax[0].2 = File::open(directory.path().join("data")).unwrap();
    assert!(
        bindings
            .validate(&dependencies)
            .unwrap_err()
            .to_string()
            .contains("DAX")
    );
    let mut wrong = provider.clone();
    wrong.resources.get_mut("resource").unwrap().recovery_point = "other-cut".into();
    assert!(wrong.bind(&dependencies).await.is_err());
}

#[test]
fn checkpoint_provider_confines_explicit_locators_without_search() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret"), b"outside").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
    for path in [
        Path::new("escape/secret"),
        Path::new("../secret"),
        outside.path(),
    ] {
        assert!(
            path_object(root.path(), path, libc::O_RDONLY).is_err(),
            "{}",
            path.display()
        );
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn checkpoint_provider_accepts_pinned_proc_fd_orphan_and_requires_independent_roles() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("data");
    std::fs::write(&path, b"orphan").unwrap();
    let mut share = share(root.path());
    let retained = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    std::fs::remove_file(&path).unwrap();
    let proc_path = PathBuf::from(format!("/proc/self/fd/{}", retained.as_raw_fd()));
    let object = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH)
        .open(&proc_path)
        .unwrap();
    let handle = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&proc_path)
        .unwrap();
    let dax = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&proc_path)
        .unwrap();
    let mut provider = local(root.path());
    provider
        .resources
        .get_mut("resource")
        .unwrap()
        .objects
        .insert(
            "file".into(),
            LocalObject::Fd {
                fd: retained.as_raw_fd(),
                handles: BTreeMap::from([(5, handle.as_raw_fd())]),
                dax_read: None,
                dax_write: Some(dax.as_raw_fd()),
            },
        );
    let references = provider
        .prepare(CheckpointExportRequest {
            shares: vec![share.clone()],
            objects: vec![
                path_object(root.path(), Path::new("."), object_flags()).unwrap(),
                retained.try_clone().unwrap(),
            ],
        })
        .await
        .unwrap();
    for (object, reference) in share.objects.iter_mut().zip(&references[0]) {
        object.reference = Some(reference.clone());
    }
    if let LocalObject::Fd { fd, .. } = provider
        .resources
        .get_mut("resource")
        .unwrap()
        .objects
        .get_mut("file")
        .unwrap()
    {
        *fd = object.as_raw_fd();
    }
    let dependencies = dependencies(share);
    let bindings = provider.bind(&dependencies).await.unwrap();
    bindings.validate(&dependencies).unwrap();
    assert_eq!(bindings.shares[0].objects[1].metadata().unwrap().nlink(), 0);
    if let LocalObject::Fd { handles, .. } = provider
        .resources
        .get_mut("resource")
        .unwrap()
        .objects
        .get_mut("file")
        .unwrap()
    {
        handles.clear();
    }
    assert!(provider.bind(&dependencies).await.is_err());
}
