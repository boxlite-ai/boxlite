use super::*;
use nix::mount::{mount, umount2, MntFlags, MsFlags};
use nix::unistd::{chown, mkfifo, Gid, Uid};
use std::ffi::OsString;
use std::fs::{self, File, Permissions};
use std::io::{self, Write};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

struct CapturedWriter(Arc<Mutex<Vec<u8>>>);

impl CapturedLogs {
    fn contents(&self) -> String {
        String::from_utf8(self.0.lock().expect("lock captured logs").clone())
            .expect("tracing output is UTF-8")
    }
}

impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for CapturedLogs {
    type Writer = CapturedWriter;

    fn make_writer(&'writer self) -> Self::Writer {
        CapturedWriter(Arc::clone(&self.0))
    }
}

impl Write for CapturedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("lock captured logs").write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct PathGuard(Option<std::ffi::OsString>);

impl PathGuard {
    fn clear() -> Self {
        let original = std::env::var_os("PATH");
        std::env::set_var("PATH", "");
        Self(original)
    }
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            std::env::set_var("PATH", path);
        } else {
            std::env::remove_var("PATH");
        }
    }
}

struct MountGuard(PathBuf);

impl Drop for MountGuard {
    fn drop(&mut self) {
        umount2(&self.0, MntFlags::MNT_DETACH).expect("unmount test bind mount");
    }
}

fn current_owner() -> (u32, u32) {
    (unsafe { libc::getuid() }, unsafe { libc::getgid() })
}

fn chown_path_for_current_process(path: &Path) -> ChownReport {
    let (uid, gid) = current_owner();
    RecursiveChowner::new(uid, gid).chown_path(path)
}

fn chown_path_with_test_faults(path: &Path, test_faults: TestFaults) -> ChownReport {
    let (uid, gid) = current_owner();
    RecursiveChowner::new(uid, gid)
        .with_test_faults(test_faults)
        .chown_path(path)
}

fn descent_failure_report(stage: TestDescentFailure) -> ChownReport {
    let temp = tempfile::tempdir().expect("create temporary directory");
    let child = temp.path().join("child");
    fs::create_dir(&child).expect("create child directory");
    let test_faults = TestFaults {
        descent_failure: Some((child, stage)),
        read_failure: None,
    };
    chown_path_with_test_faults(temp.path(), test_faults)
}

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, Permissions::from_mode(mode)).expect("set fixture mode");
}

fn set_distinct_owner(path: &Path) {
    let (uid, gid) = current_owner();
    let different_uid = if uid == 0 { 1 } else { 0 };
    let different_gid = if gid == 0 { 1 } else { 0 };
    chown(
        path,
        Some(Uid::from_raw(different_uid)),
        Some(Gid::from_raw(different_gid)),
    )
    .expect("privileged ownership test requires a mapped alternate uid/gid");
}

#[test]
#[ignore = "requires root; mutates process PATH"]
fn privileged_fix_does_not_depend_on_path() {
    assert_eq!(unsafe { libc::geteuid() }, 0, "test requires root");
    let temp = tempfile::tempdir().expect("create temporary directory");
    set_distinct_owner(temp.path());

    let _path = PathGuard::clear();
    OwnershipFixer::fix_if_needed(temp.path())
        .expect("ownership repair must not depend on a PATH chown binary");
}

#[test]
fn walks_non_utf8_and_deep_directory_names_without_recursion() {
    let temp = tempfile::tempdir().expect("create temporary directory");
    let non_utf8 = OsString::from_vec(vec![b'n', b'a', b'm', b'e', 0xff]);
    File::create(temp.path().join(non_utf8)).expect("create non-UTF-8 file");

    let mut deepest = temp.path().to_path_buf();
    for _ in 0..256 {
        deepest.push("d");
        fs::create_dir(&deepest).expect("create deep directory");
    }
    File::create(deepest.join("leaf")).expect("create deep leaf");

    let report = chown_path_for_current_process(temp.path());

    assert_eq!(report.failures, 0);
    assert_eq!(report.cycles, 0);
    assert_eq!(report.visited, 259);
    assert_eq!(report.changed, report.visited);
}

#[test]
fn directory_open_failure_does_not_chown_inode() {
    let report = descent_failure_report(TestDescentFailure::Open);

    assert_eq!(report.visited, 2);
    assert_eq!(report.failures, 1);
    assert_eq!(
        report.changed, 1,
        "only the fully traversed root is changed"
    );
}

#[test]
fn directory_stat_failure_does_not_chown_inode() {
    let report = descent_failure_report(TestDescentFailure::Stat);

    assert_eq!(report.visited, 2);
    assert_eq!(report.failures, 1);
    assert_eq!(
        report.changed, 1,
        "only the fully traversed root is changed"
    );
}

#[test]
fn directory_stream_failure_does_not_chown_inode() {
    let report = descent_failure_report(TestDescentFailure::Stream);

    assert_eq!(report.visited, 2);
    assert_eq!(report.failures, 1);
    assert_eq!(
        report.changed, 1,
        "only the fully traversed root is changed"
    );
}

#[test]
fn directory_read_error_is_terminal_and_does_not_chown_inode() {
    let temp = tempfile::tempdir().expect("create temporary directory");
    File::create(temp.path().join("unreachable")).expect("create sibling");
    let report = chown_path_with_test_faults(
        temp.path(),
        TestFaults {
            descent_failure: None,
            read_failure: Some(temp.path().to_path_buf()),
        },
    );

    assert_eq!(report.failures, 1);
    assert_eq!(report.visited, 1);
    assert_eq!(report.changed, 0);
}

#[test]
fn does_not_follow_external_or_dangling_symlinks() {
    let root = tempfile::tempdir().expect("create root directory");
    let outside = tempfile::tempdir().expect("create outside directory");
    let outside_file = outside.path().join("target");
    File::create(&outside_file).expect("create outside file");
    set_mode(&outside_file, 0o4755);

    symlink(&outside_file, root.path().join("external")).expect("create outside symlink");
    symlink("missing", root.path().join("dangling")).expect("create dangling symlink");

    let report = chown_path_for_current_process(root.path());

    assert_eq!(report.failures, 0);
    assert_eq!(report.visited, 3);
    assert_ne!(
        fs::metadata(&outside_file)
            .expect("stat outside file")
            .mode()
            & 0o4000,
        0,
        "following the symlink would clear the target's setuid bit"
    );
}

#[test]
fn handles_hardlinks_fifo_and_unix_socket() {
    let target_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
    let temp = tempfile::Builder::new()
        .prefix("boxlite-perms-")
        .tempdir_in(target_dir)
        .expect("create temporary directory");
    let original = temp.path().join("original");
    let hardlink = temp.path().join("hardlink");
    File::create(&original).expect("create hardlink source");
    fs::hard_link(&original, &hardlink).expect("create hardlink");
    mkfifo(&temp.path().join("fifo"), Mode::S_IRUSR | Mode::S_IWUSR).expect("create FIFO");
    let socket = match UnixListener::bind(temp.path().join("socket")) {
        Ok(socket) => Some(socket),
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
            eprintln!("skipping Unix socket fixture: sandbox denies bind(2)");
            None
        }
        Err(error) => panic!("create Unix socket: {error}"),
    };

    let report = chown_path_for_current_process(temp.path());

    assert_eq!(report.failures, 0);
    assert_eq!(report.visited, if socket.is_some() { 5 } else { 4 });
    assert_eq!(fs::metadata(original).expect("stat hardlink").nlink(), 2);
    drop(socket);
}

#[test]
fn continues_after_entry_failures_and_bounds_warning_samples() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping permission-denied fixture as root");
        return;
    }

    let temp = tempfile::tempdir().expect("create temporary directory");
    let sibling = temp.path().join("sibling");
    File::create(&sibling).expect("create successful sibling");
    let blocked: Vec<_> = (0..10)
        .map(|index| {
            let path = temp.path().join(format!("blocked-{index}"));
            fs::create_dir(&path).expect("create blocked directory");
            set_mode(&path, 0);
            path
        })
        .collect();

    let report = chown_path_for_current_process(temp.path());

    for path in &blocked {
        set_mode(path, 0o700);
    }
    assert_eq!(report.failures, blocked.len());
    assert_eq!(report.warning_samples.len(), WARNING_SAMPLE_LIMIT);
    assert_eq!(report.changed, 2, "root and sibling are changed");
    assert!(sibling.exists());
}

#[test]
fn public_entry_preserves_nonfatal_setup_errors() {
    let temp = tempfile::tempdir().expect("create temporary directory");

    OwnershipFixer::fix_if_needed(&temp.path().join("missing"))
        .expect("missing operands remain non-fatal");
    OwnershipFixer::fix_if_needed(Path::new("")).expect("empty operands remain non-fatal");
}

#[test]
fn public_entry_accepts_matching_root_and_intermediate_symlinks() {
    let temp = tempfile::tempdir().expect("create temporary directory");
    let target = temp.path().join("target");
    let child = target.join("child");
    fs::create_dir_all(&child).expect("create symlink target child");
    let link = temp.path().join("link");
    symlink(&target, &link).expect("create root symlink");

    OwnershipFixer::fix_if_needed(&link)
        .expect("legacy sampling follows a matching symlink operand");
    OwnershipFixer::fix_if_needed(&link.join("child"))
        .expect("legacy sampling follows a matching intermediate symlink");
}

#[test]
fn supports_file_fifo_and_socket_operands() {
    let temp = tempfile::tempdir().expect("create temporary directory");
    let file = temp.path().join("file");
    File::create(&file).expect("create file operand");
    let fifo = temp.path().join("fifo");
    mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).expect("create FIFO operand");
    let socket_path = temp.path().join("socket");
    let socket = match UnixListener::bind(&socket_path) {
        Ok(socket) => Some(socket),
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => None,
        Err(error) => panic!("create Unix socket: {error}"),
    };

    for path in [file, fifo] {
        let report = chown_path_for_current_process(&path);
        assert_eq!(report.visited, 1);
        assert_eq!(report.changed, 1);
        assert_eq!(report.failures, 0);
    }
    if socket.is_some() {
        let report = chown_path_for_current_process(&socket_path);
        assert_eq!(report.visited, 1);
        assert_eq!(report.changed, 1);
        assert_eq!(report.failures, 0);
    }
}

#[test]
#[ignore = "requires root"]
fn privileged_preserves_sampling_skip_behavior() {
    let temp = tempfile::tempdir().expect("create temporary directory");
    let sampled = temp.path().join("sampled");
    fs::create_dir(&sampled).expect("create sampled directory");
    let nested = sampled.join("nested");
    File::create(&nested).expect("create nested file");
    set_distinct_owner(&nested);
    let before = fs::symlink_metadata(&nested).expect("stat nested fixture");

    OwnershipFixer::fix_if_needed(temp.path()).expect("sampling skip succeeds");

    let after = fs::symlink_metadata(&nested).expect("stat nested file after skip");
    assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
}

#[test]
#[ignore = "requires root"]
fn privileged_blanket_fix_changes_the_whole_tree() {
    let temp = tempfile::tempdir().expect("create temporary directory");
    let directory = temp.path().join("directory");
    fs::create_dir(&directory).expect("create child directory");
    let file = directory.join("file");
    File::create(&file).expect("create child file");
    set_distinct_owner(&directory);
    set_distinct_owner(&file);

    OwnershipFixer::fix_if_needed(temp.path()).expect("blanket ownership fix");

    let expected = current_owner();
    for path in [temp.path(), directory.as_path(), file.as_path()] {
        let metadata = fs::symlink_metadata(path).expect("stat fixed path");
        assert_eq!((metadata.uid(), metadata.gid()), expected);
    }
}

#[test]
#[ignore = "requires root"]
fn privileged_continues_when_ownership_root_is_read_only() {
    let root = tempfile::tempdir().expect("create root directory");
    let source = tempfile::tempdir().expect("create read-only root source");
    mount(
        Option::<&str>::None,
        source.path(),
        Some("tmpfs"),
        MsFlags::empty(),
        Some("size=1m"),
    )
    .expect("mount private tmpfs fixture");
    let source_guard = MountGuard(source.path().to_path_buf());
    File::create(source.path().join("file")).expect("create root fixture file");

    mount(
        Some(source.path()),
        root.path(),
        Option::<&str>::None,
        MsFlags::MS_BIND,
        Option::<&str>::None,
    )
    .expect("bind root fixture");
    let root_guard = MountGuard(root.path().to_path_buf());
    let expected_owner = current_owner();
    let before = fs::symlink_metadata(root.path()).expect("stat root before repair");
    assert_eq!((before.uid(), before.gid()), expected_owner);
    mount(
        Option::<&Path>::None,
        root.path(),
        Option::<&str>::None,
        MsFlags::MS_BIND | MsFlags::MS_REMOUNT | MsFlags::MS_RDONLY,
        Option::<&str>::None,
    )
    .expect("remount root fixture read-only");
    let (uid, gid) = current_owner();
    let mismatched_gid = if gid == u32::MAX { gid - 1 } else { gid + 1 };

    let report = chown_path_for_current_process(root.path());
    assert_eq!(report.visited, 2);
    assert_eq!(report.changed, 0);
    assert_eq!(report.failures, 2);
    assert!(report
        .warning_samples
        .iter()
        .any(|sample| sample.contains("chown directory") && sample.contains("EROFS")));

    let logs = CapturedLogs::default();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .with_writer(logs.clone())
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        OwnershipFixer::fix_for_owner(root.path(), uid, mismatched_gid)
    })
    .expect("root chown failure remains non-fatal");

    let after = fs::symlink_metadata(root.path()).expect("stat root after repair");
    assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
    let logs = logs.contents();
    assert!(logs.contains("completed with warnings"), "logs: {logs}");
    assert!(logs.contains("chown directory"), "logs: {logs}");
    drop(root_guard);
    drop(source_guard);
}

#[test]
#[ignore = "requires root"]
fn privileged_continues_past_read_only_mount() {
    let root = tempfile::tempdir().expect("create root directory");
    let source = tempfile::tempdir().expect("create read-only mount source");
    mount(
        Option::<&str>::None,
        source.path(),
        Some("tmpfs"),
        MsFlags::empty(),
        Some("size=1m"),
    )
    .expect("mount private tmpfs fixture");
    let source_guard = MountGuard(source.path().to_path_buf());
    File::create(source.path().join("read-only-file")).expect("create read-only file");
    let mountpoint = root.path().join("read-only");
    fs::create_dir(&mountpoint).expect("create read-only mountpoint");
    mount(
        Some(source.path()),
        &mountpoint,
        Option::<&str>::None,
        MsFlags::MS_BIND,
        Option::<&str>::None,
    )
    .expect("bind read-only fixture");
    let mount_guard = MountGuard(mountpoint.clone());
    mount(
        Option::<&Path>::None,
        &mountpoint,
        Option::<&str>::None,
        MsFlags::MS_BIND | MsFlags::MS_REMOUNT | MsFlags::MS_RDONLY,
        Option::<&str>::None,
    )
    .expect("remount fixture read-only");
    File::create(root.path().join("sibling")).expect("create writable sibling");

    let report = chown_path_for_current_process(root.path());

    assert_eq!(report.visited, 4);
    assert_eq!(report.changed, 2, "root and writable sibling are changed");
    assert_eq!(report.failures, 2, "read-only directory and file fail");
    assert!(report
        .warning_samples
        .iter()
        .all(|sample| sample.contains("EROFS")));
    drop(mount_guard);
    drop(source_guard);
}

#[test]
#[ignore = "requires root"]
fn privileged_crosses_mounts_and_stops_ancestor_cycles() {
    let root = tempfile::tempdir().expect("create root directory");
    let source = tempfile::tempdir().expect("create mount source");
    File::create(source.path().join("mounted-file")).expect("create mounted file");
    let mountpoint = root.path().join("mounted");
    fs::create_dir(&mountpoint).expect("create mountpoint");
    mount(
        Some(source.path()),
        &mountpoint,
        Option::<&str>::None,
        MsFlags::MS_BIND,
        Option::<&str>::None,
    )
    .expect("bind child filesystem");
    let mounted_guard = MountGuard(mountpoint.clone());

    let crossed = chown_path_for_current_process(root.path());
    assert_eq!(crossed.failures, 0);
    assert_eq!(crossed.cycles, 0);
    assert_eq!(crossed.visited, 3);
    drop(mounted_guard);

    let cyclepoint = root.path().join("cycle");
    fs::create_dir(&cyclepoint).expect("create cycle mountpoint");
    mount(
        Some(root.path()),
        &cyclepoint,
        Option::<&str>::None,
        MsFlags::MS_BIND,
        Option::<&str>::None,
    )
    .expect("bind ancestor onto descendant");
    let cycle_guard = MountGuard(cyclepoint);

    let cycled = chown_path_for_current_process(root.path());
    assert_eq!(cycled.failures, 0);
    assert_eq!(cycled.cycles, 1);
    assert_eq!(cycled.warning_samples.len(), 1);

    drop(cycle_guard);
}
