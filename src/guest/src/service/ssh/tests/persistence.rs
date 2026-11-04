use super::*;
use nix::libc;

pub(in crate::service::ssh) struct SaveGate {
    pub after_rename: bool,
    pub fail: bool,
    pub entered: tokio::sync::Notify,
    pub released: std::sync::Mutex<bool>,
    pub wake: std::sync::Condvar,
}

pub(in crate::service::ssh) static SAVE_GATE: std::sync::Mutex<Option<std::sync::Arc<SaveGate>>> =
    std::sync::Mutex::new(None);

pub(super) fn pause_save(after_rename: bool) -> io::Result<()> {
    let gate = SAVE_GATE.lock().unwrap().clone();
    if let Some(gate) = gate.filter(|gate| gate.after_rename == after_rename) {
        gate.entered.notify_one();
        let mut released = gate.released.lock().unwrap();
        while !*released {
            released = gate.wake.wait(released).unwrap();
        }
        if gate.fail {
            return Err(error());
        }
    }
    Ok(())
}

use std::os::unix::fs::{symlink, MetadataExt};

#[test]
fn state_is_private_and_replaced_completely() {
    let root = tempfile::tempdir().unwrap();
    let config = boxlite_shared::SshConfig {
        listen_address: "127.0.0.1:1234".into(),
        host_private_key: "private marker".into(),
        accounts: vec![boxlite_shared::SshAccount {
            login: "alice".into(),
            authorized_keys: vec!["authorized key marker".into()],
            ca: Some(boxlite_shared::SshCaConfig {
                public_key: "CA key marker".into(),
                principal: "alice".into(),
            }),
        }],
    };
    let first = DesiredState {
        enable: true,
        config: Some(config.clone()),
    };
    save(root.path(), &first).unwrap();
    let dir = root.path().join("etc/boxlite");
    let file = dir.join("ssh.cfg");
    assert_eq!(dir.metadata().unwrap().mode() & 0o777, 0o700);
    assert_eq!(file.metadata().unwrap().mode() & 0o777, 0o600);
    for path in [&dir, &file] {
        let metadata = path.metadata().unwrap();
        assert_eq!((metadata.uid(), metadata.gid()), (0, 0));
    }
    let loaded = load(root.path()).unwrap();
    assert!(loaded.enable);
    assert_eq!(loaded.config, Some(config));
    save(root.path(), &DesiredState::default()).unwrap();
    let loaded = load(root.path()).unwrap();
    assert!(!loaded.enable && loaded.config.is_none());
}

#[test]
fn readers_observe_complete_replacements() {
    let root = tempfile::tempdir().unwrap();
    let make_state = |enable| DesiredState {
        enable,
        config: Some(boxlite_shared::SshConfig {
            listen_address: if enable { "enabled" } else { "disabled" }.into(),
            ..Default::default()
        }),
    };
    save(root.path(), &make_state(false)).unwrap();
    std::thread::scope(|scope| {
        let path = root.path().to_path_buf();
        let reader = scope.spawn(move || {
            for _ in 0..300 {
                // Observe the directory entry as an external reader. The
                // manager serializes its own load calls with save.
                let bytes = std::fs::read(path.join("etc/boxlite/ssh.cfg")).unwrap();
                let state: DesiredState = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(
                    state.config.unwrap().listen_address,
                    if state.enable { "enabled" } else { "disabled" }
                );
            }
        });
        for index in 0..100 {
            save(root.path(), &make_state(index % 2 == 0)).unwrap();
        }
        reader.join().unwrap();
    });
}

#[test]
fn mounted_state_directory_is_rejected() {
    use std::os::unix::ffi::OsStrExt;
    let original_namespace = std::env::var("BOXLITE_SSH_TEST_MOUNT_NAMESPACE")
        .expect("run this test through the guest test runner");
    assert_ne!(
        std::fs::read_link("/proc/self/ns/mnt").unwrap(),
        std::path::Path::new(&original_namespace),
        "mount namespace must be isolated"
    );
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let mountpoint = root.path().join("etc/boxlite");
    std::fs::create_dir_all(&mountpoint).unwrap();
    std::fs::write(outside.path().join("marker"), b"untouched").unwrap();
    let source = std::ffi::CString::new(outside.path().as_os_str().as_bytes()).unwrap();
    let target = std::ffi::CString::new(mountpoint.as_os_str().as_bytes()).unwrap();
    // SAFETY: both paths are valid and the runner created a private mount namespace.
    assert_eq!(
        unsafe {
            libc::mount(
                source.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                libc::MS_BIND,
                std::ptr::null(),
            )
        },
        0,
        "bind mount failed: {}",
        io::Error::last_os_error()
    );
    struct MountGuard(std::ffi::CString);
    impl Drop for MountGuard {
        fn drop(&mut self) {
            // SAFETY: the target is the bind mount created above.
            unsafe { libc::umount2(self.0.as_ptr(), libc::MNT_DETACH) };
        }
    }
    let _mount = MountGuard(target);
    assert!(save(root.path(), &DesiredState::default()).is_err());
    assert!(load(root.path()).is_err());
    assert_eq!(
        std::fs::read(outside.path().join("marker")).unwrap(),
        b"untouched"
    );
    assert!(!outside.path().join("ssh.cfg").exists());
}

#[test]
fn symlinks_special_files_and_corrupt_state_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), root.path().join("etc")).unwrap();
    assert!(save(root.path(), &DesiredState::default()).is_err());
    assert!(!outside.path().join("boxlite").exists());
    std::fs::remove_file(root.path().join("etc")).unwrap();
    save(root.path(), &DesiredState::default()).unwrap();
    let path = root.path().join("etc/boxlite/ssh.cfg");
    std::fs::write(&path, b"broken").unwrap();
    assert!(load(root.path()).is_err());
    std::fs::remove_file(&path).unwrap();
    symlink(outside.path(), &path).unwrap();
    assert!(load(root.path()).is_err());
    std::fs::remove_file(&path).unwrap();
    save(root.path(), &DesiredState::default()).unwrap();
    let link = root.path().join("etc/boxlite/other-link");
    std::fs::hard_link(&path, &link).unwrap();
    assert!(load(root.path()).is_err());
    std::fs::remove_file(&link).unwrap();
    std::fs::remove_file(&path).unwrap();
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: name is a valid C string inside the temporary directory.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(load(root.path()).is_err());
}
