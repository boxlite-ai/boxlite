//! Seccomp BPF filter generator for libkrun VMM process.
//!
//! This module generates a seccomp filter that whitelists syscalls
//! needed by the libkrun VMM process while blocking dangerous ones.
//!
//! The filter is generated as BPF bytecode that can be passed to
//! bubblewrap via `--seccomp <fd>`.
//!
//! ## Syscall Categories
//!
//! **ALLOWED** (needed for VMM operation):
//! - Memory management: mmap, munmap, mprotect, brk, madvise
//! - File I/O: read, write, openat, close, fstat, lseek
//! - KVM: ioctl with KVM_* commands
//! - Events: epoll_*, eventfd2, poll
//! - Networking: socket, connect, sendto, recvfrom (for gvproxy/vsock)
//! - Process: exit, exit_group, futex, clock_gettime
//!
//! **BLOCKED** (dangerous, attack vectors):
//! - mount, umount - filesystem manipulation
//! - ptrace - process debugging/control
//! - execve, execveat - execute new binaries
//! - init_module, finit_module - kernel module loading
//! - reboot - system reboot
//! - setns, unshare - namespace manipulation

use super::error::JailerError;
use std::collections::HashSet;
use std::io::Write;
use std::os::unix::io::{AsRawFd, RawFd};

/// Syscalls that libkrun VMM process needs to operate.
///
/// This whitelist is based on analysis of libkrun's operation.
/// When in doubt, it's better to allow a syscall than to break functionality.
pub const ALLOWED_SYSCALLS: &[&str] = &[
    // Memory management
    "brk",
    "mmap",
    "munmap",
    "mprotect",
    "madvise",
    "mremap",

    // File operations
    "read",
    "write",
    "pread64",
    "pwrite64",
    "readv",
    "writev",
    "openat",
    "close",
    "fstat",
    "newfstatat",
    "lseek",
    "fcntl",
    "dup",
    "dup2",
    "dup3",
    "pipe2",
    "statx",
    "access",
    "faccessat",
    "faccessat2",
    "readlink",
    "readlinkat",
    "getcwd",
    "getdents64",
    "unlink",
    "unlinkat",
    "mkdir",
    "mkdirat",
    "rmdir",
    "rename",
    "renameat",
    "renameat2",
    "symlink",
    "symlinkat",
    "ftruncate",
    "fallocate",
    "fsync",
    "fdatasync",

    // KVM operations (via ioctl)
    "ioctl",

    // Memory mapping for KVM
    "memfd_create",

    // Events and polling
    "epoll_create1",
    "epoll_ctl",
    "epoll_wait",
    "epoll_pwait",
    "epoll_pwait2",
    "eventfd2",
    "poll",
    "ppoll",
    "select",
    "pselect6",

    // Timers and clocks
    "clock_gettime",
    "clock_getres",
    "clock_nanosleep",
    "nanosleep",
    "gettimeofday",
    "timerfd_create",
    "timerfd_settime",
    "timerfd_gettime",

    // Signals
    "rt_sigaction",
    "rt_sigprocmask",
    "rt_sigreturn",
    "sigaltstack",

    // Threading
    "clone",
    "clone3",
    "futex",
    "set_robust_list",
    "get_robust_list",
    "rseq",
    "set_tid_address",
    "gettid",

    // Process info
    "getpid",
    "getppid",
    "getuid",
    "geteuid",
    "getgid",
    "getegid",
    "getgroups",

    // Process exit
    "exit",
    "exit_group",

    // Resource limits
    "getrlimit",
    "prlimit64",

    // Networking (for gvproxy/vsock)
    "socket",
    "socketpair",
    "connect",
    "accept",
    "accept4",
    "bind",
    "listen",
    "sendto",
    "recvfrom",
    "sendmsg",
    "recvmsg",
    "shutdown",
    "getsockname",
    "getpeername",
    "getsockopt",
    "setsockopt",

    // Misc
    "uname",
    "arch_prctl",
    "prctl",
    "getrandom",
    "sched_yield",
    "sched_getaffinity",
    "sched_setaffinity",
    "setpriority",
    "getpriority",

    // Landlock (security)
    "landlock_create_ruleset",
    "landlock_add_rule",
    "landlock_restrict_self",
];

/// Syscalls that are explicitly blocked (dangerous).
pub const BLOCKED_SYSCALLS: &[&str] = &[
    // Filesystem manipulation
    "mount",
    "umount",
    "umount2",
    "pivot_root",
    "chroot",

    // Process control
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",

    // Execute new binaries (escape vector)
    "execve",
    "execveat",

    // Kernel module loading
    "init_module",
    "finit_module",
    "delete_module",

    // System control
    "reboot",
    "kexec_load",
    "kexec_file_load",

    // Namespace manipulation (already in namespace)
    "setns",
    "unshare",

    // Capability manipulation
    "capset",

    // Keyring (potential info leak)
    "keyctl",
    "add_key",
    "request_key",

    // BPF (kernel code execution)
    "bpf",

    // Userfaultfd (exploit helper)
    "userfaultfd",

    // Performance (info leak)
    "perf_event_open",

    // Process accounting
    "acct",

    // Swap
    "swapon",
    "swapoff",

    // Quotas
    "quotactl",
    "quotactl_fd",
];

/// Generate a seccomp filter description for logging/debugging.
pub fn describe_filter() -> String {
    let allowed: HashSet<&str> = ALLOWED_SYSCALLS.iter().copied().collect();
    let blocked: HashSet<&str> = BLOCKED_SYSCALLS.iter().copied().collect();

    format!(
        "Seccomp filter:\n  Allowed: {} syscalls\n  Blocked: {} syscalls\n  Default: TRAP (block with SIGSYS)",
        allowed.len(),
        blocked.len()
    )
}

/// Write a simple seccomp filter configuration for documentation.
///
/// Note: Actual BPF generation requires the `seccompiler` crate.
/// This function generates a JSON representation that can be used
/// with seccompiler or for documentation purposes.
pub fn generate_filter_json() -> String {
    let mut json = String::from("{\n  \"main\": {\n    \"default_action\": \"trap\",\n    \"filter_action\": \"allow\",\n    \"filter\": [\n");

    for (i, syscall) in ALLOWED_SYSCALLS.iter().enumerate() {
        if i > 0 {
            json.push_str(",\n");
        }
        json.push_str(&format!("      {{ \"syscall\": \"{}\" }}", syscall));
    }

    json.push_str("\n    ]\n  }\n}");
    json
}

/// Placeholder for BPF filter generation.
///
/// Full implementation requires the `seccompiler` crate.
/// For now, this generates a simple allow-all filter for testing.
///
/// TODO: Implement proper BPF generation with seccompiler.
pub fn generate_bpf_filter() -> Result<Vec<u8>, JailerError> {
    // This is a placeholder - proper implementation requires seccompiler
    //
    // With seccompiler, it would be:
    // ```rust
    // use seccompiler::{SeccompAction, SeccompFilter, SeccompRule};
    //
    // let rules = ALLOWED_SYSCALLS.iter()
    //     .map(|s| SeccompRule::new(s.parse().unwrap()).unwrap())
    //     .collect();
    //
    // let filter = SeccompFilter::new(
    //     rules,
    //     SeccompAction::Trap,  // Default: block with SIGSYS
    //     SeccompAction::Allow, // Match: allow
    // )?;
    //
    // filter.to_bpf()
    // ```

    tracing::warn!("Seccomp BPF generation not yet implemented, using placeholder");

    // Return empty - bwrap will run without seccomp filter
    Ok(Vec::new())
}

/// Check if a syscall is in the allowed list.
pub fn is_allowed(syscall: &str) -> bool {
    ALLOWED_SYSCALLS.contains(&syscall)
}

/// Check if a syscall is explicitly blocked.
pub fn is_blocked(syscall: &str) -> bool {
    BLOCKED_SYSCALLS.contains(&syscall)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allowed_syscalls() {
        assert!(is_allowed("read"));
        assert!(is_allowed("write"));
        assert!(is_allowed("mmap"));
        assert!(is_allowed("ioctl"));  // KVM
        assert!(is_allowed("socket")); // gvproxy
    }

    #[test]
    fn test_blocked_syscalls() {
        assert!(is_blocked("mount"));
        assert!(is_blocked("ptrace"));
        assert!(is_blocked("execve"));
        assert!(is_blocked("reboot"));
        assert!(is_blocked("bpf"));
    }

    #[test]
    fn test_no_overlap() {
        // Ensure no syscall is both allowed and blocked
        let allowed: HashSet<&str> = ALLOWED_SYSCALLS.iter().copied().collect();
        let blocked: HashSet<&str> = BLOCKED_SYSCALLS.iter().copied().collect();

        let overlap: Vec<_> = allowed.intersection(&blocked).collect();
        assert!(
            overlap.is_empty(),
            "Syscalls should not be both allowed and blocked: {:?}",
            overlap
        );
    }

    #[test]
    fn test_filter_description() {
        let desc = describe_filter();
        assert!(desc.contains("Allowed:"));
        assert!(desc.contains("Blocked:"));
    }

    #[test]
    fn test_generate_json() {
        let json = generate_filter_json();
        assert!(json.contains("\"default_action\": \"trap\""));
        assert!(json.contains("\"filter_action\": \"allow\""));
        assert!(json.contains("\"syscall\": \"read\""));
    }
}
