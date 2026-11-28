//! Regression coverage for `renameat2` in the VMM seccomp allowlist.

#![cfg(target_os = "linux")]

use boxlite::jailer::seccomp::{SeccompRole, apply_filter, deserialize_binary, get_filter};

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
#[test]
fn test_vmm_filter_allows_renameat2() {
    use std::os::fd::AsRawFd;

    // libkrun's virtio-fs passthrough implements guest renames with
    // SYS_renameat2. The raw syscall (not libc::renameat2, which may use a
    // wrapper or a different syscall) is the exact operation that reaches
    // the seccomp-filtered VMM process.
    let bytes = include_bytes!(concat!(env!("OUT_DIR"), "/seccomp_filter.bpf"));
    let filters = deserialize_binary(&bytes[..]).expect("deserialize embedded filter");
    let vmm_filter = get_filter(&filters, SeccompRole::Vmm).expect("vmm filter present");
    let scratch = tempfile::tempdir().unwrap();
    let old_path = scratch.path().join("old");
    std::fs::write(&old_path, b"renamed").unwrap();
    let directory = std::fs::File::open(scratch.path()).unwrap();

    // fork() so a SIGSYS from the `trap` default action kills only the child.
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0, "fork failed");
    if pid == 0 {
        if apply_filter(vmm_filter).is_err() {
            unsafe { libc::_exit(2) };
        }
        // SAFETY: directory owns the fd and the literals are NUL-terminated.
        let ret = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                directory.as_raw_fd(),
                c"old".as_ptr(),
                directory.as_raw_fd(),
                c"new".as_ptr(),
                0,
            )
        };
        if ret == -1 {
            unsafe { libc::_exit(3) };
        }
        unsafe { libc::_exit(0) };
    }

    let mut status = 0;
    loop {
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        if waited == pid {
            break;
        }
        // waitpid returns -1/EINTR if a signal lands in the parent test
        // thread; retry, but surface any other failure.
        assert!(
            waited == -1 && unsafe { *libc::__errno_location() } == libc::EINTR,
            "waitpid failed: {}",
            std::io::Error::last_os_error()
        );
    }
    assert!(
        libc::WIFEXITED(status),
        "child killed by signal {} (SIGSYS=31)",
        libc::WTERMSIG(status)
    );
    assert_eq!(libc::WEXITSTATUS(status), 0);
}

#[test]
fn test_linux_vmm_profiles_allow_renameat2() {
    use std::path::Path;

    // CI does not run host tests on every musl target. Keep the source
    // profile contract explicit so a target cannot silently regress.
    let profile_names = [
        "aarch64-unknown-linux-gnu.json",
        "aarch64-unknown-linux-musl.json",
        "x86_64-unknown-linux-gnu.json",
        "x86_64-unknown-linux-musl.json",
    ];

    for profile_name in profile_names {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/seccomp")
            .join(profile_name);
        let profile: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display())),
        )
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()));
        let allows_renameat2 = profile["vmm"]["filter"]
            .as_array()
            .expect("vmm filter is an array")
            .iter()
            .any(|entry| entry["syscall"].as_str() == Some("renameat2"));
        assert!(
            allows_renameat2,
            "{} must allow renameat2 for virtio-fs renames",
            path.display()
        );
    }
}
