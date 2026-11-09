//! Test-only ext4 launcher. Execs the production agent as PID 1 while a
//! child checks its observable state and Unix RPC service inside the VM.

use boxlite_shared::{GuestClient, PingRequest};
use nix::{
    libc,
    mount::{mount, MsFlags},
    sys::stat::{umask, Mode},
    unistd::{fork, ForkResult},
};
use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::{fs::PermissionsExt, process::CommandExt},
    },
    process::Command,
    time::Duration,
};

const MOUNTPOINT_VIEW: &str = "/dev/boot-mountpoints";

fn main() {
    assert_eq!(
        std::process::id(),
        1,
        "boot probe runs only inside its test VM"
    );
    std::panic::set_hook(Box::new(|info| {
        eprintln!("BOOT_PROBE_FAILED: {info}");
        reset();
    }));
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "fresh".into());
    let mut agent = Command::new("/boxlite-guest");
    agent.env_remove("HOSTNAME");
    match scenario.as_str() {
        "bad-args" => {
            agent.arg("--unknown-option");
        }
        "help" => {
            agent.arg("--help");
        }
        "bad-uri" => {
            agent.args(["--listen", "invalid://endpoint"]);
        }
        "wrong-proc" => {
            mount(
                Some("tmpfs"),
                "/proc",
                Some("tmpfs"),
                MsFlags::empty(),
                None::<&str>,
            )
            .unwrap();
            agent.args(["--listen", "unix:///run/guest.sock"]);
        }
        "wrong-proc-bind" => {
            mount(
                Some("/var"),
                "/proc",
                None::<&str>,
                MsFlags::MS_BIND,
                None::<&str>,
            )
            .unwrap();
            agent.args(["--listen", "unix:///run/guest.sock"]);
        }
        "wrong-dev" => {
            mount(
                Some("tmpfs"),
                "/dev",
                Some("tmpfs"),
                MsFlags::empty(),
                None::<&str>,
            )
            .unwrap();
            agent.args(["--listen", "unix:///run/guest.sock"]);
        }
        "wrong-run" | "wrong-run-stacked" => {
            if scenario == "wrong-run-stacked" {
                mount(
                    Some("tmpfs"),
                    "/run",
                    Some("tmpfs"),
                    MsFlags::empty(),
                    None::<&str>,
                )
                .unwrap();
            }
            mount(
                Some("proc"),
                "/run",
                Some("proc"),
                MsFlags::empty(),
                None::<&str>,
            )
            .unwrap();
            agent.args(["--listen", "unix:///run/guest.sock"]);
        }
        "fresh" | "premounted" => {
            if scenario == "fresh" {
                // Expose the agent's mkdir mode even when the inherited umask
                // is permissive. This launcher runs only inside its test VM.
                umask(Mode::empty());
                fs::create_dir_all(MOUNTPOINT_VIEW).unwrap();
                // A nonrecursive bind keeps the underlying mountpoint
                // directories visible after the agent mounts devpts and shm.
                mount(
                    Some("/dev"),
                    MOUNTPOINT_VIEW,
                    None::<&str>,
                    MsFlags::MS_BIND,
                    None::<&str>,
                )
                .unwrap();
            }
            if scenario == "premounted" {
                premount();
                fs::write(
                    "/run/mounts-before",
                    fs::read("/proc/self/mountinfo").unwrap(),
                )
                .unwrap();
                agent.env("HOSTNAME", "bootstrap-test");
            }
            // SAFETY: the launcher is single-threaded. Tokio is created only
            // in the child; the parent immediately execs the real agent.
            if let ForkResult::Child = unsafe { fork() }.unwrap() {
                // Let the production agent reach its listener first. The old
                // kernel lacks Unix sockets, including Tokio's signal socket;
                // probing earlier would fail in test setup instead of init.
                let deadline = std::time::Instant::now() + Duration::from_secs(20);
                while !std::path::Path::new("/run/guest.sock").exists() {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "agent never created its listener"
                    );
                    std::thread::sleep(Duration::from_millis(20));
                }
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async {
                    tokio::time::timeout(Duration::from_secs(20), verify(&scenario))
                        .await
                        .unwrap();
                });
                println!("BOXLITE_GUEST_BOOT_OK");
                reset();
            }
            agent.args(["--listen", "unix:///run/guest.sock"]);
        }
        _ => panic!("unknown scenario: {scenario}"),
    }
    panic!("exec agent: {}", agent.exec());
}

fn premount() {
    // The kernel already mounts /dev when booting from the ext4 root.
    for (path, kind) in [
        ("/proc", "proc"),
        ("/sys", "sysfs"),
        ("/sys/fs/cgroup", "cgroup2"),
        ("/dev/pts", "devpts"),
        ("/dev/shm", "tmpfs"),
        ("/tmp", "tmpfs"),
        ("/var/tmp", "tmpfs"),
        ("/run", "tmpfs"),
    ] {
        fs::create_dir_all(path).unwrap();
        mount(Some(kind), path, Some(kind), MsFlags::empty(), None::<&str>).unwrap();
    }
    for path in ["/dev/shm", "/tmp", "/var/tmp"] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o1777)).unwrap();
    }
    fs::set_permissions("/run", fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink("/proc/self/fd", "/dev/fd").unwrap();
}

async fn verify(scenario: &str) {
    let endpoint = tonic::transport::Endpoint::from_static("http://[::]:50051");
    let channel = loop {
        let connection = endpoint
            .connect_with_connector(tower::service_fn(|_| async {
                tokio::net::UnixStream::connect("/run/guest.sock")
                    .await
                    .map(hyper_util::rt::TokioIo::new)
            }))
            .await;
        match connection {
            Ok(channel) => break channel,
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    };
    let response = GuestClient::new(channel)
        .ping(PingRequest {})
        .await
        .unwrap()
        .into_inner();
    assert_eq!(response.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(
        fs::read_link("/proc/1/exe").unwrap().to_str(),
        Some("/boxlite-guest")
    );

    let mounts = procfs::process::Process::myself()
        .unwrap()
        .mountinfo()
        .unwrap();
    if scenario == "fresh" {
        let shm = mounts
            .iter()
            .find(|mount| mount.mount_point == std::path::Path::new("/dev/shm"))
            .unwrap();
        let master = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/ptmx")
            .unwrap();
        let mut index: libc::c_uint = 0;
        // SAFETY: master is a live PTY descriptor and index is a writable
        // unsigned integer. Do not grantpt/chmod before checking initial modes.
        assert_eq!(
            unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCGPTN, &mut index) },
            0,
            "PTY index: {}",
            std::io::Error::last_os_error()
        );
        let modes = [
            "/dev/pts/ptmx".to_string(),
            format!("/dev/pts/{index}"),
            format!("{MOUNTPOINT_VIEW}/pts"),
            format!("{MOUNTPOINT_VIEW}/shm"),
        ]
        .map(|path| fs::metadata(path).unwrap().permissions().mode() & 0o7777);
        assert_eq!(
            (shm.mount_options.contains_key("nodev"), modes),
            (false, [0o000, 0o600, 0o755, 0o755]),
            "libkrun defaults: shm nodev; modes of ptmx, slave, pts directory, shm directory"
        );
    }
    for (path, kind) in [
        ("/proc", "proc"),
        ("/dev", "devtmpfs"),
        ("/sys", "sysfs"),
        ("/sys/fs/cgroup", "cgroup2"),
        ("/dev/pts", "devpts"),
        ("/dev/shm", "tmpfs"),
        ("/tmp", "tmpfs"),
        ("/var/tmp", "tmpfs"),
        ("/run", "tmpfs"),
    ] {
        let entries: Vec<_> = mounts
            .iter()
            .filter(|m| m.mount_point == std::path::Path::new(path))
            .collect();
        assert_eq!(entries.len(), 1, "no stacked mounts at {path}");
        assert_eq!(entries[0].fs_type, kind, "{path}");
        if scenario == "fresh" && ["/proc", "/sys", "/sys/fs/cgroup", "/dev/shm"].contains(&path) {
            for flag in ["nosuid", "noexec", "relatime"] {
                assert!(
                    entries[0].mount_options.contains_key(flag),
                    "{path}: missing {flag}"
                );
            }
            if path != "/dev/shm" {
                assert!(entries[0].mount_options.contains_key("nodev"), "{path}");
            }
        }
        if scenario == "premounted" {
            let before = fs::read_to_string("/run/mounts-before").unwrap();
            assert!(
                before
                    .lines()
                    .any(|line| line.starts_with(&format!("{} ", entries[0].mnt_id))),
                "mount reused: {path}"
            );
        }
    }
    let root = mounts
        .iter()
        .find(|m| m.mount_point == std::path::Path::new("/"))
        .unwrap();
    assert_eq!(root.fs_type, "ext4", "root filesystem: {root:?}");
    assert_eq!(
        fs::read_to_string("/sys/class/block/vdb/ro")
            .unwrap()
            .trim(),
        "1"
    );
    let error = fs::write("/root-write-probe", b"must remain read-only").unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EROFS), "{error}");
    assert!(
        root.opt_fields
            .iter()
            .any(|field| matches!(field, procfs::process::MountOptFields::Shared(_))),
        "root propagation: {root:?}"
    );
    for (path, mode) in [
        ("/dev/shm", 0o1777),
        ("/tmp", 0o1777),
        ("/var/tmp", 0o1777),
        ("/run", 0o755),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o7777,
            mode,
            "{path}"
        );
        fs::write(format!("{path}/writable"), "ok").unwrap();
    }
    assert_eq!(
        fs::read_link("/dev/fd").unwrap(),
        std::path::Path::new("/proc/self/fd")
    );
    assert_eq!(
        fs::read_to_string("/proc/sys/kernel/hostname")
            .unwrap()
            .trim(),
        if scenario == "premounted" {
            "bootstrap-test"
        } else {
            "localhost"
        }
    );
    for name in ["protected_hardlinks", "protected_symlinks"] {
        assert_eq!(
            fs::read_to_string(format!("/proc/sys/fs/{name}"))
                .unwrap()
                .trim(),
            "1"
        );
    }
    let limits = fs::read_to_string("/proc/1/limits").unwrap();
    assert!(
        limits.lines().any(|line| line.starts_with("Max processes")
            && line.split_whitespace().collect::<Vec<_>>()[2..4] == ["4096", "8192"]),
        "{limits}"
    );
    assert!(
        limits.lines().any(|line| line.starts_with("Max open files")
            && line.split_whitespace().collect::<Vec<_>>()[3..5] == ["1048576", "1048576"]),
        "{limits}"
    );

    // The zygote must see the same writable mounts that init established.
    let zygote = procfs::process::all_processes()
        .unwrap()
        .map(|process| process.unwrap())
        .find(|process| {
            process.pid != std::process::id() as i32 && process.stat().unwrap().ppid == 1
        })
        .expect("zygote child");
    let zygote_mounts = fs::read_to_string(format!("/proc/{}/mountinfo", zygote.pid)).unwrap();
    for path in ["/tmp", "/var/tmp", "/run"] {
        let id = mounts
            .iter()
            .find(|m| m.mount_point == std::path::Path::new(path))
            .unwrap()
            .mnt_id;
        assert!(
            zygote_mounts
                .lines()
                .any(|line| line.starts_with(&format!("{id} "))),
            "zygote inherits {path}"
        );
    }

    assert!(!std::path::Path::new("/sys/class/net/eth0").exists());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let _connection = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    listener.accept().await.unwrap();

    // The same executable remains a conventional process under an existing init.
    for (argument, code) in [("--help", 0), ("--unknown-option", 2)] {
        let output = tokio::process::Command::new("/boxlite-guest")
            .arg(argument)
            .output()
            .await
            .unwrap();
        assert_eq!(output.status.code(), Some(code));
        let diagnostics = String::from_utf8_lossy(&output.stderr);
        assert!(
            !diagnostics.contains("init bootstrap completed"),
            "{diagnostics}"
        );
        assert!(!diagnostics.contains("PID 1 restarting"), "{diagnostics}");
    }
}

fn reset() -> ! {
    // SAFETY: only this test VM executes the probe; drain the console before reset.
    unsafe {
        libc::ioctl(1, libc::TCSBRK, 1);
        libc::reboot(libc::LINUX_REBOOT_CMD_RESTART);
    }
    panic!("test reset failed: {}", std::io::Error::last_os_error());
}
