//! Initramfs acceptance driver for the production guest volume mount adapter.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use boxlite_shared::constants::mount_tags;
use boxlite_shared::{volume, VirtiofsSource, Volume};
use nix::mount::{mount, MsFlags};

const BASE: &str = "/run/boxlite/shared";
const VOLUMES: &str = "/run/boxlite/shared/containers/mount-test/volumes";

fn volume(tag: &str, read_only: bool) -> Volume {
    Volume {
        mount_point: String::new(),
        container_id: if tag == mount_tags::SHARED {
            String::new()
        } else {
            "mount-test".into()
        },
        source: Some(volume::Source::Virtiofs(VirtiofsSource {
            tag: tag.into(),
            device_tag: "boxlite".into(),
            export_key: tag.into(),
            read_only,
        })),
    }
}

fn mounted() -> bool {
    fs::read_to_string("/proc/self/mountinfo")
        .expect("read mountinfo")
        .lines()
        .any(|line| {
            let target = line.split_whitespace().nth(4).unwrap_or("");
            target == BASE
                || target.starts_with("/run/boxlite/virtiofs/")
                || target.starts_with(VOLUMES)
        })
}

fn check_bytes(path: impl AsRef<Path>, expected: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    assert_eq!(fs::read(path)?, expected);
    Ok(())
}

fn check() -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all("/proc")?;
    mount(
        Some("proc"),
        "/proc",
        Some("proc"),
        MsFlags::empty(),
        None::<&str>,
    )?;

    // Put SHARED last: the production planner must bind parents before children.
    let volumes = vec![
        volume("directory", false),
        volume("writable", false),
        volume("snapshot", true),
        volume(mount_tags::SHARED, false),
    ];
    let mut failing = volumes.clone();
    failing.push(volume("missing", false));
    let failure = match crate::storage::mount_volumes(&failing) {
        Ok(_) => panic!("missing export unexpectedly mounted"),
        Err(error) => error,
    };
    assert!(failure.to_string().contains("missing"), "{failure}");
    assert!(!mounted(), "failed batch retained mounts");

    {
        let _initializing = crate::storage::mount_volumes(&volumes)?;
        check_bytes(format!("{BASE}/file"), b"shared")?;
        check_bytes(format!("{VOLUMES}/directory/file"), b"directory")?;
        check_bytes(format!("{VOLUMES}/writable/file"), b"writable")?;
        check_bytes(format!("{VOLUMES}/snapshot/file"), b"snapshot")?;
        let error = OpenOptions::new()
            .write(true)
            .open(format!("{VOLUMES}/snapshot/file"))
            .expect_err("read-only file accepted a write-open");
        assert_eq!(error.raw_os_error(), Some(nix::libc::EROFS));
        for tag in ["writable", "snapshot"] {
            let names = fs::read_dir(format!("{VOLUMES}/{tag}"))?
                .map(|entry| entry.map(|entry| entry.file_name()))
                .collect::<io::Result<Vec<_>>>()?;
            assert_eq!(names, vec![std::ffi::OsString::from("file")]);
        }
    }
    assert!(!mounted(), "later initialization failure retained mounts");

    crate::storage::mount_volumes(&volumes)?.commit();
    assert!(mounted(), "commit lost mounts");
    for (tag, bytes) in [
        ("directory", b"guest directory".as_slice()),
        ("writable", b"guest writable".as_slice()),
    ] {
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(format!("{VOLUMES}/{tag}/file"))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        check_bytes(format!("{VOLUMES}/{tag}/file"), bytes)?;
    }
    check_bytes(format!("{BASE}/file"), b"shared")?;
    check_bytes(format!("{VOLUMES}/snapshot/file"), b"snapshot")?;
    Ok(())
}

/// This feature is built into a separate target directory, never shipped as the agent.
pub(super) fn run() {
    assert_eq!(
        std::process::id(),
        1,
        "mount test init must run as guest PID 1"
    );
    std::panic::set_hook(Box::new(|panic| eprintln!("GUEST-MOUNTS-FAIL: {panic}")));
    match check() {
        Ok(()) => eprintln!("GUEST-MOUNTS-OK"),
        Err(error) => eprintln!("GUEST-MOUNTS-FAIL: {error}"),
    }
    // SAFETY: reboot has no pointer arguments; this test runs as init in its own VM.
    unsafe { nix::libc::reboot(nix::libc::RB_AUTOBOOT) };
    std::process::exit(1);
}
