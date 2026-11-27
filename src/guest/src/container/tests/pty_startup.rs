//! PTY attachment and real runner startup regressions.

use super::*;
use crate::service::exec::exec_handle::PtyMode;
use crate::service::ssh::SshWorkload;
use std::fs;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TEST_NAME: &str = "container::command::pty_startup_tests::pty_startup_preserves_shell_modes";
const CHILD_ENV: &str = "BOXLITE_PTY_STARTUP_CHILD";

#[path = "pty_executor.rs"]
mod executor;

#[tokio::test]
async fn pty_attachment_preserves_workload_terminal_state() {
    use nix::pty::{openpty, Winsize};
    use nix::sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg};

    let size = Winsize {
        ws_row: 43,
        ws_col: 137,
        ws_xpixel: 640,
        ws_ypixel: 480,
    };
    let pty = openpty(Some(&size), None).unwrap();
    let mut raw = tcgetattr(&pty.slave).unwrap();
    cfmakeraw(&mut raw);
    tcsetattr(&pty.slave, SetArg::TCSANOW, &raw).unwrap();
    let child = Child(Command::new("sleep").arg("30").spawn().unwrap());
    let handle = create_pty_child(
        Pid::from_raw(child.0.id() as i32),
        pty.master,
        PtyConfig {
            rows: 24,
            cols: 80,
            x_pixels: 0,
            y_pixels: 0,
            modes: vec![
                PtyMode {
                    opcode: 53,
                    value: 1,
                },
                PtyMode {
                    opcode: 51,
                    value: 1,
                },
            ],
        },
    )
    .unwrap();
    let actual = tcgetattr(&pty.slave).unwrap();
    assert_eq!(actual, raw, "attachment must preserve workload termios");
    let mut actual_size = std::mem::MaybeUninit::<Winsize>::uninit();
    // SAFETY: ioctl writes exactly one Winsize into a valid output buffer.
    assert_eq!(
        unsafe {
            nix::libc::ioctl(
                handle.pty_controller().unwrap().as_raw_fd(),
                nix::libc::TIOCGWINSZ,
                actual_size.as_mut_ptr(),
            )
        },
        0
    );
    // SAFETY: the successful TIOCGWINSZ initialized the buffer.
    let actual_size = unsafe { actual_size.assume_init() };
    assert_eq!(
        actual_size, size,
        "attachment must preserve workload window size"
    );
}

#[test]
#[ignore = "requires root, unshare and writable cgroup v2; see Guest SSH README"]
fn pty_startup_preserves_shell_modes() {
    if std::env::var_os(CHILD_ENV).is_some() {
        exercise_startup();
        return;
    }
    assert!(nix::unistd::Uid::effective().is_root(), "requires root");
    let id = format!("pty-test-{}", uuid::Uuid::new_v4());
    let cgroup_path = std::path::Path::new("/sys/fs/cgroup").join(format!("boxlite:{id}"));
    let _cgroup = Cgroup(cgroup_path);
    let log = tempfile::tempfile().unwrap();
    let mut child = Command::new("unshare")
        // Killing namespace PID 1 also cleans up a hung zygote or tenant.
        .args(["--mount", "--pid", "--fork", "--kill-child", "--mount-proc"])
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", TEST_NAME, "--ignored", "--nocapture"])
        .env(CHILD_ENV, id)
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log.try_clone().unwrap())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("PTY startup/exec-notify handshake did not complete within 15s");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    use std::io::{Read, Seek};
    let mut log = log;
    log.rewind().unwrap();
    let mut output = String::new();
    log.read_to_string(&mut output).unwrap();
    assert!(status.success(), "PTY startup subprocess failed:\n{output}");
}

struct Tenant(Pid);

impl Drop for Tenant {
    fn drop(&mut self) {
        terminate_process(self.0);
    }
}

struct Child(std::process::Child);

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Cgroup(PathBuf);

impl Drop for Cgroup {
    fn drop(&mut self) {
        // This unique group belongs only to the test, including on panic.
        let _ = fs::write(self.0.join("cgroup.kill"), "1");
        for _ in 0..100 {
            if !self.0.exists() || fs::remove_dir(&self.0).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        eprintln!("failed to remove test cgroup {:?}", self.0);
    }
}

fn wait_for_file(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !path.exists() {
        assert!(Instant::now() < deadline, "workload never wrote {path:?}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn exercise_startup() {
    let root = tempfile::tempdir().unwrap();
    let id = std::env::var(CHILD_ENV).unwrap();
    use crate::container::spec::{self, ContainerDevices, MountOverride, ProcessSpec, UserMount};
    let image = root.path().join("image");
    let outputs = root.path().join("output");
    fs::create_dir_all(image.join("etc")).unwrap();
    fs::create_dir(&outputs).unwrap();
    fs::copy("/etc/passwd", image.join("etc/passwd")).unwrap();
    fs::copy("/etc/group", image.join("etc/group")).unwrap();
    let mut mounts = Vec::new();
    for path in ["/bin", "/sbin", "/lib", "/lib64", "/usr"] {
        if let Ok(link) = fs::read_link(path) {
            std::os::unix::fs::symlink(link, image.join(&path[1..])).unwrap();
        } else if std::path::Path::new(path).is_dir() {
            mounts.push(UserMount {
                source: path.into(),
                destination: path.into(),
                read_only: true,
                owner_uid: 0,
                owner_gid: 0,
            });
        }
    }
    mounts.push(UserMount {
        source: outputs.to_str().unwrap().into(),
        destination: "/work".into(),
        read_only: false,
        owner_uid: 0,
        owner_gid: 0,
    });
    crate::container::start::create_container_etc_files(root.path(), &id).unwrap();
    let spec = spec::init_spec(
        &image,
        ProcessSpec {
            args: vec!["/bin/sleep".into(), "30".into()],
            env: HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
            cwd: "/".into(),
            uid: 0,
            gid: 0,
            capabilities: CapabilitySet::default(),
        },
        &[],
        &MountOverride {
            source: "/sys".into(),
            options: vec!["rbind".into(), "rro".into()],
        },
        root.path(),
        &mounts,
        &ContainerDevices::default(),
        Default::default(),
    );
    zygote::ZYGOTE
        .set(zygote::Zygote::start().unwrap())
        .unwrap();
    let server = zygote::ZYGOTE.get().unwrap();
    let null = fs::File::options()
        .read(true)
        .write(true)
        .open("/dev/null")
        .unwrap();
    server
        .build_init(
            zygote::InitBuildSpec {
                container_id: id.clone(),
                spec,
                pty_config: None,
            },
            &[null.as_raw_fd(); 3],
        )
        .unwrap();
    assert_eq!(server.status(&id).unwrap(), zygote::Status::Created);
    server.run_init(&id).unwrap();
    server.run_init(&id).unwrap();
    assert_eq!(server.status(&id).unwrap(), zygote::Status::Running);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut failures = Vec::new();
        // Both SSH transports arrive at this typed workload path. Also cover
        // ordinary container exec, which shares the same PTY attachment.
        for ssh in [true, false] {
            let output = tempfile::tempdir_in(&outputs).unwrap();
            let container_output = format!(
                "/work/{}",
                output.path().file_name().unwrap().to_string_lossy()
            );
            let script = r#"stty size > "$BOXLITE_PTY_TEST_DIR/size"
                stty -a > "$BOXLITE_PTY_TEST_DIR/modes"
                stty raw -echo
                touch "$BOXLITE_PTY_TEST_DIR/ready"
                dd bs=1 count=9 of="$BOXLITE_PTY_TEST_DIR/input" 2>/dev/null
                touch "$BOXLITE_PTY_TEST_DIR/done"
                exec sleep 30"#
                .to_string();
            let mut cmd = ContainerCommand::new(
                id.clone(),
                HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                (0, 0),
                "/".into(),
                CapabilitySet::default(),
            )
            .env("BOXLITE_PTY_TEST_DIR", container_output)
            .with_pty(PtyConfig {
                rows: 43,
                cols: 137,
                x_pixels: 640,
                y_pixels: 480,
                modes: vec![
                    PtyMode {
                        opcode: 51,
                        value: 1,
                    }, // ICANON
                    PtyMode {
                        opcode: 53,
                        value: 1,
                    }, // ECHO
                    PtyMode {
                        opcode: 36,
                        value: 0,
                    }, // ICRNL
                    PtyMode {
                        opcode: 1,
                        value: 7,
                    }, // VINTR
                ],
            });
            cmd = if ssh {
                cmd.with_ssh_workload(SshWorkload::Exec { command: script })
            } else {
                cmd.program("/bin/sh").args(["-c", &script])
            };
            let SpawnResult::PtyPending(pending) = cmd.spawn_build().await.unwrap() else {
                panic!("expected a pending PTY");
            };
            let _tenant = Tenant(pending.pid);
            // Force shell raw mode to precede parent attachment, with no sleep
            // used as an ordering assumption and no production test hook.
            wait_for_file(&output.path().join("ready"));
            let mut handle = pending.finish().unwrap();
            let terminal = handle.pty_controller().unwrap();
            let attrs = nix::sys::termios::tcgetattr(terminal).unwrap();
            use nix::sys::termios::LocalFlags;
            let raw_preserved = !attrs
                .local_flags
                .intersects(LocalFlags::ECHO | LocalFlags::ICANON);
            if !raw_preserved {
                failures.push(format!(
                    "parent attachment overwrote shell raw mode (ssh={ssh}): {:?}",
                    attrs.local_flags
                ));
            }
            let size = fs::read_to_string(output.path().join("size")).unwrap();
            if size.trim() != "43 137" {
                failures.push(format!(
                    "shell started with wrong size (ssh={ssh}): {size:?}"
                ));
            }
            let modes = fs::read_to_string(output.path().join("modes")).unwrap();
            if !modes.contains("-icrnl") || !modes.contains("intr = ^G") {
                failures.push(format!(
                    "shell started with wrong modes (ssh={ssh}): {modes}"
                ));
            }
            // The first byte and cursor reply must reach the workload intact,
            // without a newline needed to unblock canonical input.
            let input = b"x\x1b[4;12R!";
            if raw_preserved {
                handle.stdin().unwrap().write_all(input).await.unwrap();
                wait_for_file(&output.path().join("done"));
                assert_eq!(fs::read(output.path().join("input")).unwrap(), input);
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    });
    server.remove(&id).unwrap();
}
