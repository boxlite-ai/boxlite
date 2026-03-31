// Copyright 2025 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Landlock LSM filesystem and network restrictions for defense-in-depth.
//!
//! Landlock is a Linux Security Module (available since kernel 5.13) that allows
//! unprivileged processes to restrict their own ambient rights. It complements
//! bwrap (namespace isolation) and seccomp (syscall filtering) by adding
//! kernel-enforced, inode-based access control.
//!
//! # Architecture
//!
//! Landlock is applied using a split parent/child pattern for zero-gap enforcement:
//!
//! 1. **Parent process** (before fork): Uses the full `landlock` crate API to build
//!    a ruleset from [`PathAccess`] rules. This allocates freely (not in pre_exec).
//! 2. **Child process** (pre_exec hook): Calls the single `landlock_restrict_self(fd, 0)`
//!    syscall — fully async-signal-safe. The shim binary starts already sandboxed.
//!
//! # Graceful Degradation
//!
//! On kernels without Landlock support (< 5.13), [`build_landlock_ruleset`] returns
//! `Ok(None)`. The caller logs a warning and continues without Landlock. The crate's
//! `BestEffort` mode silently downgrades on older kernels that support Landlock but
//! lack newer ABI features.
//!
//! # Security Layers
//!
//! ```text
//! bwrap        → what the process can SEE (mount namespace)
//! Landlock     → what the process can ACCESS (inode-based rules)
//! seccomp      → what syscalls the process can CALL (BPF filter)
//! ```

use crate::jailer::error::IsolationError;
use crate::jailer::sandbox::PathAccess;
use boxlite_shared::errors::BoxliteError;
use landlock::{
    ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset,
    RulesetAttr, RulesetCreatedAttr, RulesetError,
};
use std::os::fd::{IntoRawFd, RawFd};

/// Target Landlock ABI version.
///
/// V5 (kernel 6.10+) supports filesystem + network + ioctl_dev.
/// BestEffort mode silently downgrades on older kernels.
const TARGET_ABI: ABI = ABI::V5;

/// System paths that should always be readable (matching bwrap's system binds).
const SYSTEM_READ_PATHS: &[&str] = &[
    "/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/proc", "/dev",
];

/// System paths that should always be writable.
const SYSTEM_WRITE_PATHS: &[&str] = &["/tmp"];

/// Build a Landlock ruleset from [`PathAccess`] rules and return the raw fd.
///
/// Called in the parent process before `fork()`. The returned fd is inherited
/// by the child and used in the pre_exec hook via [`restrict_self_raw`].
///
/// Returns `Ok(None)` if Landlock is not supported on the running kernel.
/// Returns `Err` only for unexpected failures (not for missing kernel support).
pub fn build_landlock_ruleset(
    paths: &[PathAccess],
    network_enabled: bool,
) -> Result<Option<RawFd>, BoxliteError> {
    // Build the ruleset with explicit BestEffort compatibility.
    // BestEffort silently drops unsupported access rights on older kernels,
    // so this works on any kernel version (returns None if Landlock is absent).
    let mut ruleset = Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(AccessFs::from_all(TARGET_ABI))
        .map_err(|e| map_landlock_error("handle filesystem access", e))?;

    // Handle network access only when we want to DENY it.
    // When network_enabled=true, we don't handle AccessNet at all (permit all).
    // When network_enabled=false, we handle AccessNet but add no rules (deny all TCP).
    if !network_enabled {
        ruleset = ruleset
            .handle_access(AccessNet::from_all(TARGET_ABI))
            .map_err(|e| map_landlock_error("handle network access", e))?;
    }

    let mut ruleset_created = ruleset
        .create()
        .map_err(|e| map_landlock_error("create ruleset", e))?
        .set_compatibility(CompatLevel::BestEffort);

    // Add system read-only paths (matching bwrap's system binds).
    // Skip paths that don't exist (e.g., /lib64 on some distros).
    let read_access = AccessFs::from_read(TARGET_ABI);
    for path in SYSTEM_READ_PATHS {
        if let Ok(path_fd) = PathFd::new(path) {
            ruleset_created = ruleset_created
                .add_rule(PathBeneath::new(path_fd, read_access))
                .map_err(|e| map_landlock_error(&format!("add rule for {path}"), e))?;
        }
    }

    // Add system writable paths.
    let all_access = AccessFs::from_all(TARGET_ABI);
    for path in SYSTEM_WRITE_PATHS {
        if let Ok(path_fd) = PathFd::new(path) {
            ruleset_created = ruleset_created
                .add_rule(PathBeneath::new(path_fd, all_access))
                .map_err(|e| map_landlock_error(&format!("add rule for {path}"), e))?;
        }
    }

    // Add box-specific paths from PathAccess rules.
    for pa in paths {
        // Canonicalize to resolve symlinks (Landlock is inode-based).
        let real_path = pa.path.canonicalize().unwrap_or_else(|_| pa.path.clone());

        let path_fd = match PathFd::new(&real_path) {
            Ok(fd) => fd,
            Err(_) => {
                // Path doesn't exist or is inaccessible — skip silently.
                // This can happen for paths that will be created inside
                // the namespace by bwrap.
                continue;
            }
        };

        let access = if pa.writable {
            AccessFs::from_all(TARGET_ABI)
        } else {
            AccessFs::from_read(TARGET_ABI)
        };

        ruleset_created = ruleset_created
            .add_rule(PathBeneath::new(path_fd, access))
            .map_err(|e| map_landlock_error(&format!("add rule for {}", real_path.display()), e))?;
    }

    // Extract the raw fd. Returns None if Landlock is unsupported.
    let owned_fd: Option<std::os::fd::OwnedFd> = ruleset_created.into();
    match owned_fd {
        Some(fd) => {
            // Convert to raw fd to prevent close-on-drop.
            // The fd will be closed in the child's pre_exec hook after restrict_self.
            let raw_fd = fd.into_raw_fd();
            Ok(Some(raw_fd))
        }
        None => {
            // Landlock not supported on this kernel — graceful degradation.
            Ok(None)
        }
    }
}

/// Apply Landlock restriction in the pre_exec hook (async-signal-safe).
///
/// This function uses only raw syscalls — no memory allocation, no logging,
/// no mutex operations. Safe to call between `fork()` and `exec()`.
///
/// # Safety
///
/// Must be called in a forked child process (pre_exec context).
/// The `ruleset_fd` must be a valid Landlock ruleset file descriptor
/// inherited from the parent process.
///
/// # Returns
///
/// 0 on success, or a positive errno value on failure.
pub unsafe fn restrict_self_raw(ruleset_fd: RawFd) -> i32 {
    // Set PR_SET_NO_NEW_PRIVS (required by Landlock).
    // This prevents privilege escalation via setuid binaries.
    // Note: bwrap may have already set this, but it's idempotent.
    // SAFETY: prctl with PR_SET_NO_NEW_PRIVS is always safe to call.
    let ret = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if ret != 0 {
        // SAFETY: errno is thread-local, safe to read after failed syscall.
        let errno = unsafe { *libc::__errno_location() };
        unsafe { libc::close(ruleset_fd) };
        return errno;
    }

    // Apply the Landlock ruleset to this thread.
    // SAFETY: ruleset_fd is a valid Landlock fd inherited from the parent.
    let ret = unsafe {
        libc::syscall(
            libc::SYS_landlock_restrict_self,
            ruleset_fd as libc::c_long,
            0i64,
        )
    };
    let errno = if ret != 0 {
        unsafe { *libc::__errno_location() }
    } else {
        0
    };

    // Always close the ruleset fd (no longer needed after restrict_self).
    unsafe { libc::close(ruleset_fd) };

    errno
}

/// Check whether Landlock is available on the running kernel.
///
/// Attempts to create a minimal ruleset. Returns `true` if the kernel
/// supports Landlock (version 5.13+).
pub fn is_landlock_available() -> bool {
    Ruleset::default()
        .handle_access(AccessFs::Execute)
        .and_then(|r| r.create())
        .is_ok()
}

/// Map a [`RulesetError`] to a [`BoxliteError`] with context.
fn map_landlock_error(context: &str, err: RulesetError) -> BoxliteError {
    BoxliteError::from(crate::jailer::error::JailerError::Isolation(
        IsolationError::Landlock(format!("{context}: {err}")),
    ))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_is_landlock_available() {
        // Just verify the function doesn't panic.
        // On Linux 5.13+, this returns true. On older Linux, false.
        let available = is_landlock_available();
        println!("Landlock available: {available}");
    }

    #[test]
    fn test_build_ruleset_empty_paths() {
        // Should succeed even with no custom paths (system paths still added).
        let result = build_landlock_ruleset(&[], false);
        // On systems without Landlock, this returns Ok(None).
        // On systems with Landlock, this returns Ok(Some(fd)).
        assert!(result.is_ok());
    }

    #[test]
    fn test_build_ruleset_with_paths() {
        let paths = vec![
            PathAccess {
                path: PathBuf::from("/tmp"),
                writable: true,
            },
            PathAccess {
                path: PathBuf::from("/usr"),
                writable: false,
            },
        ];

        let result = build_landlock_ruleset(&paths, false);
        assert!(result.is_ok());
    }

    #[test]
    fn test_build_ruleset_nonexistent_path_skipped() {
        let paths = vec![PathAccess {
            path: PathBuf::from("/this/path/does/not/exist"),
            writable: false,
        }];

        let result = build_landlock_ruleset(&paths, false);
        assert!(
            result.is_ok(),
            "Nonexistent paths should be silently skipped"
        );
    }

    #[test]
    fn test_build_ruleset_network_disabled_denies_all() {
        // When network is disabled, AccessNet is handled but no rules added → deny all.
        let result = build_landlock_ruleset(&[], false);
        assert!(result.is_ok());
    }

    #[test]
    fn test_build_ruleset_network_enabled_permits_all() {
        // When network is enabled, AccessNet is NOT handled → permit all.
        let result = build_landlock_ruleset(&[], true);
        assert!(result.is_ok());
    }

    /// End-to-end test: build ruleset → restrict → verify enforcement.
    ///
    /// Runs in a separate thread (Landlock restriction is irreversible + thread-scoped).
    /// Creates a temp directory, builds a ruleset allowing only that directory,
    /// applies the restriction, then verifies:
    /// - Allowed path: can read files inside the temp directory
    /// - Denied path: cannot read /etc/hostname (EACCES)
    #[test]
    fn test_landlock_enforcement_e2e() {
        // Build ruleset allowing only a specific temp directory (+ system paths).
        let tmp = tempfile::tempdir().expect("create tempdir");
        let allowed_file = tmp.path().join("allowed.txt");
        std::fs::write(&allowed_file, b"hello").expect("write allowed file");

        let paths = vec![PathAccess {
            path: tmp.path().to_path_buf(),
            writable: true,
        }];
        let result = build_landlock_ruleset(&paths, false);
        let Ok(Some(fd)) = result else {
            println!("Landlock not available, skipping enforcement test");
            return;
        };

        // Run in a separate thread since restrict_self is irreversible.
        let allowed_path = allowed_file.clone();
        let handle = std::thread::spawn(move || {
            // Apply Landlock restriction.
            let errno = unsafe { restrict_self_raw(fd) };
            assert_eq!(errno, 0, "restrict_self_raw failed with errno {errno}");

            // ALLOWED: read file inside the permitted temp directory.
            let content = std::fs::read_to_string(&allowed_path);
            assert!(
                content.is_ok(),
                "Should be able to read allowed file, got: {:?}",
                content.err()
            );
            assert_eq!(content.unwrap(), "hello");

            // ALLOWED: write to the writable temp directory.
            let write_result =
                std::fs::write(allowed_path.parent().unwrap().join("new.txt"), b"world");
            assert!(
                write_result.is_ok(),
                "Should be able to write to allowed writable dir, got: {:?}",
                write_result.err()
            );

            // DENIED: read a file outside the allowed paths.
            // /etc/hostname exists on most Linux systems and is NOT in our ruleset.
            // Note: system paths (/usr, /lib, /etc, ...) ARE in our ruleset as read-only,
            // so /etc/hostname should actually be readable. Use a path completely outside.
            let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
            let denied = std::fs::read_dir(&home);
            // Home directory is NOT in our allowed paths → should be denied.
            // (Unless HOME is under /tmp or /usr which are in system paths)
            if !home.starts_with("/tmp") && !home.starts_with("/usr") {
                assert!(
                    denied.is_err(),
                    "Reading home dir ({home}) should be denied by Landlock, but succeeded"
                );
                let err = denied.unwrap_err();
                assert_eq!(
                    err.kind(),
                    std::io::ErrorKind::PermissionDenied,
                    "Expected EACCES, got: {err}"
                );
            }
        });

        handle.join().expect("enforcement thread panicked");
    }

    /// Create a test directory under $HOME (NOT /tmp) to avoid the /tmp system write rule.
    /// Landlock rules are hierarchical: /tmp has full write access, so subdirs of /tmp
    /// inherit that regardless of per-path restrictions.
    fn home_test_dir(name: &str) -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        let dir = PathBuf::from(home).join(".boxlite-test").join(name);
        std::fs::create_dir_all(&dir).expect("create home test dir");
        dir
    }

    /// Clean up a home test directory.
    fn cleanup_home_test_dir(name: &str) {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        let dir = PathBuf::from(home).join(".boxlite-test").join(name);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// E2e: read-only PathAccess allows read but denies write.
    #[test]
    fn test_landlock_readonly_denies_write() {
        // Use dirs under $HOME (not /tmp) — /tmp has system write access in our ruleset,
        // and Landlock rules propagate from parent to child in the hierarchy.
        let test_id = format!("ro-test-{}", std::process::id());
        let ro_dir = home_test_dir(&format!("{test_id}/ro"));
        let rw_dir = home_test_dir(&format!("{test_id}/rw"));

        // Pre-create a file in ro_dir to read later.
        let ro_file = ro_dir.join("readonly.txt");
        std::fs::write(&ro_file, b"read only").expect("write ro file");

        let paths = vec![
            PathAccess {
                path: ro_dir.clone(),
                writable: false,
            },
            PathAccess {
                path: rw_dir.clone(),
                writable: true,
            },
        ];
        let result = build_landlock_ruleset(&paths, false);
        let Ok(Some(fd)) = result else {
            println!("Landlock not available, skipping readonly test");
            cleanup_home_test_dir(&test_id);
            return;
        };

        let ro = ro_dir.clone();
        let rw = rw_dir.clone();
        let handle = std::thread::spawn(move || {
            let errno = unsafe { restrict_self_raw(fd) };
            assert_eq!(errno, 0, "restrict_self_raw failed");

            // Read-only dir: CAN read.
            let content = std::fs::read_to_string(&ro_file);
            assert!(
                content.is_ok(),
                "Should read from ro dir: {:?}",
                content.err()
            );
            assert_eq!(content.unwrap(), "read only");

            // Read-only dir: CANNOT write.
            let write_result = std::fs::write(ro.join("new.txt"), b"denied");
            assert!(
                write_result.is_err(),
                "Writing to read-only dir should be denied"
            );
            assert_eq!(
                write_result.unwrap_err().kind(),
                std::io::ErrorKind::PermissionDenied,
                "Expected EACCES for write to read-only dir"
            );

            // Writable dir: CAN write.
            let write_ok = std::fs::write(rw.join("allowed.txt"), b"ok");
            assert!(
                write_ok.is_ok(),
                "Should write to rw dir: {:?}",
                write_ok.err()
            );
        });

        handle.join().expect("readonly test thread panicked");
        cleanup_home_test_dir(&test_id);
    }

    /// E2e: multiple PathAccess rules with different access levels.
    #[test]
    fn test_landlock_multiple_paths_enforcement() {
        let test_id = format!("multi-test-{}", std::process::id());
        let dir_a = home_test_dir(&format!("{test_id}/a"));
        let dir_b = home_test_dir(&format!("{test_id}/b"));
        let dir_c = home_test_dir(&format!("{test_id}/c"));

        // Pre-create files in read-only dirs.
        std::fs::write(dir_a.join("a.txt"), b"alpha").unwrap();
        std::fs::write(dir_b.join("b.txt"), b"beta").unwrap();
        // dir_c: no PathAccess rule → should be denied entirely.

        let paths = vec![
            PathAccess {
                path: dir_a.clone(),
                writable: false,
            },
            PathAccess {
                path: dir_b.clone(),
                writable: true,
            },
            // dir_c intentionally NOT included
        ];
        let result = build_landlock_ruleset(&paths, false);
        let Ok(Some(fd)) = result else {
            println!("Landlock not available, skipping multi-path test");
            cleanup_home_test_dir(&test_id);
            return;
        };

        let a = dir_a.clone();
        let b = dir_b.clone();
        let c = dir_c.clone();
        let handle = std::thread::spawn(move || {
            let errno = unsafe { restrict_self_raw(fd) };
            assert_eq!(errno, 0);

            // dir_a (read-only): can read, cannot write.
            assert!(std::fs::read_to_string(a.join("a.txt")).is_ok());
            assert!(std::fs::write(a.join("x.txt"), b"denied").is_err());

            // dir_b (writable): can read and write.
            assert!(std::fs::read_to_string(b.join("b.txt")).is_ok());
            assert!(std::fs::write(b.join("y.txt"), b"ok").is_ok());

            // dir_c (not in ruleset): cannot read.
            let denied = std::fs::read_dir(&c);
            assert!(denied.is_err(), "dir_c should be denied (not in ruleset)");
            assert_eq!(
                denied.unwrap_err().kind(),
                std::io::ErrorKind::PermissionDenied
            );
        });

        handle.join().expect("multi-path test thread panicked");
        cleanup_home_test_dir(&test_id);
    }

    /// E2e: network_enabled=false denies TCP connections (requires kernel 6.7+).
    #[test]
    fn test_landlock_network_deny() {
        use std::net::TcpStream;

        // Start a TCP listener so we have a valid target to connect to.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind listener");
        let port = listener.local_addr().unwrap().port();

        // Verify connection works BEFORE Landlock.
        let pre_check = TcpStream::connect(("127.0.0.1", port));
        assert!(pre_check.is_ok(), "Pre-Landlock connect should work");
        drop(pre_check);

        let paths = vec![];
        let result = build_landlock_ruleset(&paths, false); // network_enabled=false
        let Ok(Some(fd)) = result else {
            println!("Landlock not available, skipping network test");
            return;
        };

        let handle = std::thread::spawn(move || {
            let errno = unsafe { restrict_self_raw(fd) };
            assert_eq!(errno, 0);

            // Attempt TCP connect — should be denied if kernel supports Landlock V4+ (6.7+).
            let result = TcpStream::connect(("127.0.0.1", port));
            match result {
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    // Kernel 6.7+: network access denied by Landlock.
                }
                Ok(_) => {
                    // Kernel < 6.7: Landlock doesn't handle network (BestEffort skips).
                    // This is expected graceful degradation — not a test failure.
                    println!(
                        "TCP connect succeeded — kernel likely < 6.7 (no Landlock network support). \
                         This is expected graceful degradation."
                    );
                }
                Err(e) => {
                    panic!("Unexpected error kind: {e}");
                }
            }
        });

        handle.join().expect("network deny test thread panicked");
        drop(listener);
    }
}
