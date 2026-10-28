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
            unlinked: false,
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
        local_roots: Default::default(),
        boot_disk_path: None,
        disk_dependencies: serde_json::Value::Null,
        application: serde_json::Value::Null,
    }
}
fn capture(root: &Path, share: ShareDependency) -> (CheckpointDependencies, LocalPaths) {
    capture_version(root, share, 1)
}
fn capture_version(
    root: &Path,
    mut share: ShareDependency,
    version: u32,
) -> (CheckpointDependencies, LocalPaths) {
    let paths = LocalPaths {
        version,
        shares: BTreeMap::from([(share.tag.clone(), LocalRoot::capture(root).unwrap())]),
        boot_disk: root.join("boot.ext4"),
    };
    let files = [".", "data"]
        .into_iter()
        .map(|name| path_object(root, Path::new(name), object_flags()).unwrap())
        .collect();
    let refs = LocalCheckpointProvider::prepare(&[share.clone()], files, &paths).unwrap();
    for (object, reference) in share.objects.iter_mut().zip(&refs[0]) {
        object.reference = Some(reference.clone());
    }
    (dependencies(share), paths)
}

#[test]
fn checkpoint_v2_rebinds_different_inodes_and_preserves_independent_handles() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("data"), b"source bytes").unwrap();
    std::fs::write(target.path().join("data"), b"target bytes").unwrap();
    let mut share = share(source.path());
    let mut second = share.state["handles"][0].clone();
    second["handle"] = 6.into();
    share.state["handles"].as_array_mut().unwrap().push(second);
    let (deps, mut paths) = capture_version(source.path(), share, 2);
    paths.shares.insert(
        "BoxLiteShared".into(),
        LocalRoot::capture(target.path()).unwrap(),
    );
    let mut bound = LocalCheckpointProvider::bind(&deps, &paths).unwrap();
    use std::io::{Read, Seek};
    let file = bound.shares[0].handles.get_mut(&5).unwrap();
    let mut bytes = [0; 6];
    file.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"target");
    assert_eq!(
        bound.shares[0]
            .handles
            .get_mut(&6)
            .unwrap()
            .stream_position()
            .unwrap(),
        0
    );
    assert_ne!(
        std::fs::metadata(source.path().join("data")).unwrap().ino(),
        bound.shares[0].objects[1]
            .as_ref()
            .unwrap()
            .metadata()
            .unwrap()
            .ino()
    );
    let mut wrong_type = deps.clone();
    wrong_type.shares[0].objects[1].kind = 0o040000;
    assert!(LocalCheckpointProvider::bind(&wrong_type, &paths).is_err());
    let mut alias = deps.clone();
    alias.shares[0].objects[1].alias = alias.shares[0].objects[0].alias;
    assert!(
        LocalCheckpointProvider::bind(&alias, &paths)
            .unwrap_err()
            .to_string()
            .contains("alias")
    );
    std::fs::remove_file(target.path().join("data")).unwrap();
    let mut deleted = deps.clone();
    deleted.shares[0].objects[1].unlinked = true;
    assert!(
        LocalCheckpointProvider::bind(&deleted, &paths)
            .unwrap_err()
            .to_string()
            .contains("DAX")
    );
    deleted.shares[0].state["dax"]["mappings"] = serde_json::json!([]);
    let omitted = LocalCheckpointProvider::bind(&deleted, &paths).unwrap();
    assert!(omitted.shares[0].objects[1].is_none());
    assert!(omitted.shares[0].handles.is_empty());
}

#[test]
fn checkpoint_local_paths_reopen_independent_handles_and_validate_roles() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::write(root.join("data"), b"retained bytes").unwrap();
    let mut share = share(root);
    let mut second = share.state["handles"][0].clone();
    second["handle"] = 6.into();
    let append = path_object(root, Path::new("data"), libc::O_WRONLY | libc::O_APPEND).unwrap();
    second["flags"] = unsafe { libc::fcntl(append.as_raw_fd(), libc::F_GETFL) }.into();
    share.state["handles"].as_array_mut().unwrap().push(second);
    let (deps, paths) = capture(root, share);
    let mut first = LocalCheckpointProvider::bind(&deps, &paths).unwrap();
    let again = LocalCheckpointProvider::bind(&deps, &paths).unwrap();
    use std::io::{Read, Seek, SeekFrom};
    first.shares[0]
        .handles
        .get_mut(&5)
        .unwrap()
        .seek(SeekFrom::Start(3))
        .unwrap();
    let mut byte = [0];
    first.shares[0]
        .handles
        .get_mut(&5)
        .unwrap()
        .read_exact(&mut byte)
        .unwrap();
    assert_eq!(&byte, b"a");
    assert_eq!(
        unsafe { libc::lseek(again.shares[0].handles[&5].as_raw_fd(), 0, libc::SEEK_CUR) },
        0
    );
    assert_eq!(
        unsafe { libc::lseek(first.shares[0].handles[&6].as_raw_fd(), 0, libc::SEEK_CUR) },
        0
    );
    let flags = unsafe { libc::fcntl(first.shares[0].handles[&6].as_raw_fd(), libc::F_GETFL) };
    assert_eq!(
        flags & (libc::O_ACCMODE | libc::O_APPEND),
        libc::O_WRONLY | libc::O_APPEND
    );
    first.shares[0].dax[0].2 = File::open(root.join("data")).unwrap();
    assert!(
        first
            .validate(&deps)
            .unwrap_err()
            .to_string()
            .contains("DAX")
    );
}

#[test]
fn checkpoint_local_paths_reject_replacement_and_never_create_or_truncate() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::write(root.join("data"), b"retained").unwrap();
    let (deps, paths) = capture(root, share(root));
    for flag in [libc::O_CREAT, libc::O_TRUNC, libc::O_EXCL, libc::O_TMPFILE] {
        let mut unsafe_deps = deps.clone();
        let flags = unsafe_deps.shares[0].state["handles"][0]["flags"]
            .as_i64()
            .unwrap();
        unsafe_deps.shares[0].state["handles"][0]["flags"] = (flags | i64::from(flag)).into();
        assert!(
            LocalCheckpointProvider::bind(&unsafe_deps, &paths)
                .unwrap_err()
                .to_string()
                .contains("creation flags")
        );
        assert_eq!(std::fs::read(root.join("data")).unwrap(), b"retained");
    }
    std::fs::rename(root.join("data"), root.join("old")).unwrap();
    std::fs::write(root.join("data"), b"replacement").unwrap();
    assert!(
        LocalCheckpointProvider::bind(&deps, &paths)
            .unwrap_err()
            .to_string()
            .contains("identity changed")
    );
    std::fs::remove_file(root.join("data")).unwrap();
    assert!(LocalCheckpointProvider::bind(&deps, &paths).is_err());
    assert!(!root.join("data").exists());
}

#[test]
fn checkpoint_local_paths_ignore_reused_orphan_names_but_reject_missing_dax() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::write(root.join("data"), b"orphan").unwrap();
    let mut share = share(root);
    let orphan = path_object(root, Path::new("data"), object_flags()).unwrap();
    std::fs::remove_file(root.join("data")).unwrap();
    share.objects[1].unlinked = true;
    let paths = LocalPaths {
        version: 1,
        shares: BTreeMap::from([(share.tag.clone(), LocalRoot::capture(root).unwrap())]),
        boot_disk: root.join("boot.ext4"),
    };
    let refs = LocalCheckpointProvider::prepare(
        &[share.clone()],
        vec![
            path_object(root, Path::new("."), object_flags()).unwrap(),
            orphan,
        ],
        &paths,
    )
    .unwrap();
    for (object, reference) in share.objects.iter_mut().zip(&refs[0]) {
        object.reference = Some(reference.clone());
    }
    let mut deps = dependencies(share);
    assert!(
        LocalCheckpointProvider::bind(&deps, &paths)
            .unwrap_err()
            .to_string()
            .contains("DAX mapping")
    );
    deps.shares[0].state["dax"]["mappings"] = serde_json::json!([]);
    std::fs::write(root.join("unlinked"), b"replacement").unwrap();
    let bound = LocalCheckpointProvider::bind(&deps, &paths).unwrap();
    assert!(bound.shares[0].objects[1].is_none());
    assert!(bound.shares[0].handles.is_empty());
    assert_eq!(
        std::fs::read(root.join("unlinked")).unwrap(),
        b"replacement"
    );
    deps.shares[0].objects[1].unlinked = false;
    assert!(LocalCheckpointProvider::bind(&deps, &paths).is_err());
}

#[test]
fn checkpoint_local_paths_preserve_deleted_suffix_and_reject_path_escape() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::write(root.join("data"), b"linked").unwrap();
    let share = share(root);
    std::fs::rename(root.join("data"), root.join("name (deleted)")).unwrap();
    let paths = LocalPaths {
        version: 1,
        shares: BTreeMap::from([(share.tag.clone(), LocalRoot::capture(root).unwrap())]),
        boot_disk: root.join("boot.ext4"),
    };
    let refs = LocalCheckpointProvider::prepare(
        &[share.clone()],
        vec![
            path_object(root, Path::new("."), object_flags()).unwrap(),
            path_object(root, Path::new("name (deleted)"), object_flags()).unwrap(),
        ],
        &paths,
    )
    .unwrap();
    let mut share = share;
    for (object, reference) in share.objects.iter_mut().zip(&refs[0]) {
        object.reference = Some(reference.clone());
    }
    let deps = dependencies(share);
    assert!(LocalCheckpointProvider::bind(&deps, &paths).unwrap().shares[0].objects[1].is_some());
    for locator in ["../outside", "/etc/passwd", ""] {
        let mut invalid = deps.clone();
        invalid.shares[0].objects[1]
            .reference
            .as_mut()
            .unwrap()
            .object_key = locator.into();
        assert!(LocalCheckpointProvider::bind(&invalid, &paths).is_err());
    }
    std::os::unix::fs::symlink(root, root.join("redirect")).unwrap();
    let mut invalid = deps.clone();
    invalid.shares[0].objects[1]
        .reference
        .as_mut()
        .unwrap()
        .object_key = "redirect/name (deleted)".into();
    assert!(LocalCheckpointProvider::bind(&invalid, &paths).is_err());
}

#[test]
fn checkpoint_local_paths_reject_alias_and_opaque_reference_mismatches() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::write(root.join("data"), b"linked").unwrap();
    let (mut deps, paths) = capture(root, share(root));
    deps.shares[0].objects[1].alias = deps.shares[0].objects[0].alias;
    assert!(
        LocalCheckpointProvider::bind(&deps, &paths)
            .unwrap_err()
            .to_string()
            .contains("alias mismatch")
    );
    deps.shares[0].objects[1]
        .reference
        .as_mut()
        .unwrap()
        .resource_id = "opaque".into();
    assert!(
        LocalCheckpointProvider::bind(&deps, &paths)
            .unwrap_err()
            .to_string()
            .contains("provider-era")
    );
}
