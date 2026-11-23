//! Membership- and quota-error compatibility through the real shim/jailer/bubblewrap path.
//! Requires root and mount namespaces; quota enforcement has separate KVM acceptance.

use super::ShimSpawner;
use crate::BoxOptions;
use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
use nix::mount::{MsFlags, mount};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::{fs, path::Path};

fn assert_spawn_survives_cgroup_failure(membership_target: Option<&Path>, quota_writable: bool) {
    assert_eq!(unsafe { libc::geteuid() }, 0, "test requires root");
    assert!(crate::jailer::bwrap::is_available(), "test requires bwrap");

    // Isolate this test thread's mounts before replacing the cgroup filesystem.
    // Recursive private propagation prevents any bind from reaching the host.
    assert_eq!(unsafe { libc::unshare(libc::CLONE_NEWNS) }, 0);
    mount(
        None::<&str>,
        "/",
        None::<&str>,
        MsFlags::MS_REC | MsFlags::MS_PRIVATE,
        None::<&str>,
    )
    .unwrap();
    let cgroups = tempfile::tempdir().unwrap();
    let group = cgroups.path().join("boxlite/membership-test");
    fs::create_dir_all(&group).unwrap();
    for parent in [cgroups.path().to_path_buf(), cgroups.path().join("boxlite")] {
        fs::write(parent.join("cgroup.controllers"), "cpu memory pids").unwrap();
    }
    if let Some(target) = membership_target {
        symlink(target, group.join("cgroup.procs")).unwrap();
    }
    if !quota_writable {
        // A directory in place of the file makes the quota write fail.
        fs::create_dir(group.join("cpu.max")).unwrap();
    }
    mount(
        Some(cgroups.path()),
        "/sys/fs/cgroup",
        None::<&str>,
        MsFlags::MS_BIND,
        None::<&str>,
    )
    .unwrap();

    let home = tempfile::tempdir().unwrap();
    let layout = BoxFilesystemLayout::new(
        home.path().to_path_buf(),
        FsLayoutConfig::without_bind_mount(),
        false,
    );
    layout.prepare().unwrap();
    // The jailer copies this helper into <box>/bin. Its marker is in the
    // writable logs binding, since bubblewrap replaces /tmp with a tmpfs.
    let helpers = tempfile::tempdir().unwrap();
    let binary = helpers.path().join("membership-helper");
    fs::write(
        &binary,
        "#!/bin/sh\nexec cat > \"${0%/*}/../logs/executed\"\n",
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    let options = BoxOptions {
        cpus: Some(0.5),
        ..Default::default()
    };
    let config = "cgroup failure must preserve exec";
    let result =
        ShimSpawner::new(&binary, &layout, "membership-test", &options).spawn(config, true);
    if quota_writable {
        assert_eq!(
            fs::read_to_string(group.join("cpu.max")).unwrap(),
            "50000 100000",
            "production startup must write the quota before attempting membership"
        );
    }
    let mut spawned = result.expect("cgroup failure must not prevent child exec");
    assert!(spawned.child.wait().unwrap().success());
    assert_eq!(
        fs::read_to_string(layout.logs_dir().join("executed")).unwrap(),
        config
    );
    layout.cleanup().unwrap();
}

#[test]
#[ignore = "requires Linux root, mount namespaces, and bubblewrap"]
fn fractional_cpus_missing_membership_file_allows_exec() {
    assert_spawn_survives_cgroup_failure(None, true);
}

#[test]
#[ignore = "requires Linux root, mount namespaces, and bubblewrap"]
fn fractional_cpus_membership_write_failure_allows_exec() {
    assert_spawn_survives_cgroup_failure(Some(Path::new("/dev/full")), true);
}

#[test]
#[ignore = "requires Linux root, mount namespaces, and bubblewrap"]
fn fractional_cpus_quota_write_failure_allows_exec() {
    assert_spawn_survives_cgroup_failure(None, false);
}
