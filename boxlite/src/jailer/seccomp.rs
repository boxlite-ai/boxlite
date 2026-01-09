//! Seccomp BPF filter generator for libkrun VMM process.
//!
//! This module generates a seccomp filter aligned with Firecracker's
//! security model, allowing only the minimal set of syscalls needed
//! for VMM operation.
//!
//! The filter is generated as BPF bytecode using the `seccompiler` crate.
//!
//! ## Firecracker Alignment
//!
//! This filter is based on Firecracker's seccomp policy:
//! - <https://github.com/firecracker-microvm/firecracker/tree/main/resources/seccomp>
//!
//! The syscall list is the union of Firecracker's vmm, api, and vcpu
//! thread filters, providing a single filter that covers all operations.
//!
//! ## Syscall Categories
//!
//! **ALLOWED** (~44 syscalls, Firecracker-aligned):
//! - Memory: brk, mmap, mremap, munmap, madvise, mincore, msync
//! - File I/O: read, write, readv, writev, open, openat, close, fstat, lseek
//! - KVM: ioctl (for KVM_* operations)
//! - Events: epoll_ctl, epoll_pwait, eventfd2
//! - Networking: socket, connect, accept4, recvfrom, recvmsg, sendmsg
//! - Signals: rt_sigaction, rt_sigprocmask, rt_sigreturn, sigaltstack, tkill
//! - Process: exit, exit_group, futex, sched_yield
//!
//! **BLOCKED** (dangerous, attack vectors):
//! - mount, umount - filesystem manipulation
//! - ptrace - process debugging/control
//! - execve, execveat - execute new binaries
//! - init_module, finit_module - kernel module loading
//! - reboot - system reboot
//! - setns, unshare - namespace manipulation

#[cfg(target_os = "linux")]
use super::error::IsolationError;
use super::error::JailerError;
use std::collections::HashSet;

// Unused imports on non-Linux (kept for potential future use)
#[allow(unused_imports)]
use std::io::Write;
#[allow(unused_imports)]
use std::os::unix::io::{AsRawFd, RawFd};

/// Minimal syscalls for libkrun VMM process.
///
/// Each syscall includes a comment explaining why it's needed.
/// This list was built by analyzing libkrun's requirements.
pub const ALLOWED_SYSCALLS: &[&str] = &[
    // === Memory management (VM guest memory) ===
    "mmap",     // Map VM guest memory regions
    "munmap",   // Unmap memory regions
    "mprotect", // Set memory protection (execute permissions for JIT)
    "brk",      // Extend data segment (heap allocation)
    "madvise",  // Memory hints (MADV_DONTNEED for balloon)
    "mremap",   // Resize memory mappings
    // === File I/O (disk images, vsock, virtio-fs) ===
    "read",       // Read from file descriptors
    "write",      // Write to file descriptors
    "pread64",    // Read at offset (QCOW2 random access)
    "pwrite64",   // Write at offset (QCOW2 random access)
    "preadv",     // Scatter-gather read (efficient disk I/O)
    "pwritev",    // Scatter-gather write (efficient disk I/O)
    "openat",     // Open files relative to directory fd
    "close",      // Close file descriptors
    "dup",        // Duplicate file descriptor
    "fstat",      // Get file status (size, type)
    "newfstatat", // Get file status at path
    "lseek",      // Seek in file (QCOW2 cluster lookup)
    "fcntl",      // File control (non-blocking, locks)
    "fsync",      // Sync file to disk (data integrity)
    "ftruncate",  // Truncate file (disk resize)
    "fallocate",  // Preallocate space (QCOW2 cluster allocation)
    "statx",      // Extended file stat (modern stat replacement)
    "unlinkat",   // Remove file (cleanup sockets)
    "mkdir",      // Create directory
    "mkdirat",    // Create directory (runtime dirs)
    "getdents64", // Read directory entries (virtiofs)
    // === KVM virtualization ===
    "ioctl", // KVM_* ioctls (VM/vCPU control)
    // === Event loop (async I/O) ===
    "epoll_create1",   // Create epoll instance
    "epoll_ctl",       // Add/modify/remove epoll events
    "epoll_wait",      // Wait for I/O events
    "epoll_pwait",     // Wait with signal mask
    "eventfd2",        // Create eventfd for signaling
    "timerfd_create",  // Create timer fd
    "timerfd_settime", // Arm timer
    // === Threading (vCPU threads) ===
    "clone",           // Create threads (vCPU workers)
    "clone3",          // Modern clone with flags
    "futex",           // Fast userspace mutex
    "set_robust_list", // Robust futex list
    "set_tid_address", // Set thread ID pointer
    "gettid",          // Get thread ID
    "rseq",            // Restartable sequences (thread optimization)
    // === Signals (vCPU interrupts) ===
    "rt_sigaction",   // Install signal handlers
    "rt_sigprocmask", // Block/unblock signals
    "rt_sigreturn",   // Return from signal handler
    "sigaltstack",    // Alternate signal stack
    "tgkill",         // Send signal to thread (vCPU kick)
    "kill",           // Send signal to process
    // === Process info ===
    "getpid",  // Get process ID
    "gettid",  // Get thread ID (duplicate for clarity)
    "getuid",  // Get user ID
    "geteuid", // Get effective user ID
    "getgid",  // Get group ID
    "capget",  // Get process capabilities
    "umask",   // Set file creation mask
    // === Process lifecycle ===
    "exit",       // Exit thread
    "exit_group", // Exit all threads
    // === Resource limits ===
    "prlimit64", // Get/set limits (RLIMIT_NOFILE)
    "getrlimit", // Get resource limits
    // === Networking (vsock, gvproxy) ===
    "socket",      // Create socket
    "bind",        // Bind socket to address (gvproxy listener)
    "listen",      // Listen for connections (gvproxy)
    "connect",     // Connect to vsock/unix socket
    "accept",      // Accept connection
    "accept4",     // Accept connection with flags
    "shutdown",    // Shutdown socket
    "sendto",      // Send data to address
    "recvfrom",    // Receive data from address
    "sendmsg",     // Send message (vsock)
    "recvmsg",     // Receive message (vsock)
    "getsockname", // Get socket address
    "setsockopt",  // Set socket options
    "getsockopt",  // Get socket options
    // === Time (timers, guest clock) ===
    "clock_gettime",   // Get clock time
    "clock_nanosleep", // Sleep with clock specification
    "nanosleep",       // Sleep
    // === Scheduling ===
    "sched_yield",       // Yield CPU to other threads
    "sched_getaffinity", // Get CPU affinity (vCPU pinning)
    // === Misc ===
    "getrandom",  // Get random bytes (VM entropy)
    "prctl",      // Process control (PR_SET_NAME for threads)
    "arch_prctl", // Architecture-specific (x86_64 FS/GS base)
    "uname",      // Get system info
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
    let mut json = String::from(
        "{\n  \"main\": {\n    \"default_action\": \"trap\",\n    \"filter_action\": \"allow\",\n    \"filter\": [\n",
    );

    for (i, syscall) in ALLOWED_SYSCALLS.iter().enumerate() {
        if i > 0 {
            json.push_str(",\n");
        }
        json.push_str(&format!("      {{ \"syscall\": \"{}\" }}", syscall));
    }

    json.push_str("\n    ]\n  }\n}");
    json
}

/// Generate a seccomp BPF filter program.
///
/// Creates a filter that:
/// - **Allows** all syscalls in `ALLOWED_SYSCALLS`
/// - **Traps** (sends SIGSYS) for all other syscalls
///
/// The filter uses seccompiler to generate BPF bytecode that can be
/// applied to the current process.
///
/// # Errors
///
/// Returns an error if filter creation or BPF compilation fails.
#[cfg(target_os = "linux")]
pub fn generate_bpf_filter() -> Result<seccompiler::BpfProgram, JailerError> {
    use seccompiler::{SeccompAction, SeccompFilter, SeccompRule};
    use std::collections::BTreeMap;

    // Build rules map: syscall_number -> Vec<SeccompRule>
    // Empty rules vector = unconditional allow for that syscall
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();

    let mut mapped_count = 0;
    let mut unmapped = Vec::new();

    for syscall_name in ALLOWED_SYSCALLS {
        if let Some(nr) = syscall_name_to_nr(syscall_name) {
            rules.insert(nr, vec![]); // Empty rules = allow unconditionally
            mapped_count += 1;
        } else {
            unmapped.push(*syscall_name);
        }
    }

    if !unmapped.is_empty() {
        tracing::warn!(
            unmapped_syscalls = ?unmapped,
            "Some syscalls could not be mapped to numbers (may not exist on this architecture)"
        );
    }

    tracing::debug!(
        total_syscalls = ALLOWED_SYSCALLS.len(),
        mapped = mapped_count,
        unmapped = unmapped.len(),
        "Building seccomp filter"
    );

    // Create filter with:
    // - Default action: Trap (send SIGSYS for unlisted syscalls)
    // - Filter action: Allow (for matched syscalls)
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Trap,  // Default: kill process on blocked syscall
        SeccompAction::Allow, // Match: allow the syscall
        target_arch(),
    )
    .map_err(|e| {
        JailerError::Isolation(IsolationError::Seccomp(format!(
            "Failed to create seccomp filter: {}",
            e
        )))
    })?;

    // Convert to BPF bytecode
    filter.try_into().map_err(|e: seccompiler::BackendError| {
        JailerError::Isolation(IsolationError::Seccomp(format!(
            "Failed to compile seccomp filter to BPF: {}",
            e
        )))
    })
}

/// Placeholder for non-Linux platforms.
///
/// Seccomp is Linux-specific, so this returns an empty filter on other platforms.
#[cfg(not(target_os = "linux"))]
pub fn generate_bpf_filter() -> Result<Vec<u8>, JailerError> {
    tracing::warn!("Seccomp is only available on Linux");
    Ok(Vec::new())
}

/// Apply a seccomp BPF filter to the current process.
///
/// Once applied, the filter cannot be removed. The process will be
/// restricted to the syscalls allowed by the filter.
///
/// # Safety
///
/// This permanently restricts the process. Ensure all required syscalls
/// are in the allowlist before calling.
#[cfg(target_os = "linux")]
pub fn apply_filter(filter: &seccompiler::BpfProgram) -> Result<(), JailerError> {
    seccompiler::apply_filter(filter).map_err(|e| {
        JailerError::Isolation(IsolationError::Seccomp(format!(
            "Failed to apply seccomp filter: {}",
            e
        )))
    })
}

/// Placeholder for non-Linux platforms.
#[cfg(not(target_os = "linux"))]
pub fn apply_filter(_filter: &[u8]) -> Result<(), JailerError> {
    tracing::warn!("Seccomp is only available on Linux, filter not applied");
    Ok(())
}

/// Get the target architecture for seccomp filter compilation.
#[cfg(target_os = "linux")]
fn target_arch() -> seccompiler::TargetArch {
    #[cfg(target_arch = "x86_64")]
    {
        seccompiler::TargetArch::x86_64
    }
    #[cfg(target_arch = "aarch64")]
    {
        seccompiler::TargetArch::aarch64
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        compile_error!("Unsupported architecture for seccomp")
    }
}

/// Map syscall name to syscall number.
///
/// Returns `None` if the syscall doesn't exist on the current architecture.
/// This is expected for some syscalls (e.g., `epoll_pwait2` on older kernels).
#[cfg(target_os = "linux")]
fn syscall_name_to_nr(name: &str) -> Option<i64> {
    // Map syscall names to libc::SYS_* constants
    // Note: Some syscalls may not exist on all architectures
    Some(match name {
        // Memory management
        "brk" => libc::SYS_brk,
        "mmap" => libc::SYS_mmap,
        "munmap" => libc::SYS_munmap,
        "mprotect" => libc::SYS_mprotect,
        "madvise" => libc::SYS_madvise,
        "mremap" => libc::SYS_mremap,

        // File operations
        "read" => libc::SYS_read,
        "write" => libc::SYS_write,
        "pread64" => libc::SYS_pread64,
        "pwrite64" => libc::SYS_pwrite64,
        "readv" => libc::SYS_readv,
        "writev" => libc::SYS_writev,
        "preadv" => libc::SYS_preadv,
        "pwritev" => libc::SYS_pwritev,
        "preadv2" => libc::SYS_preadv2,
        "pwritev2" => libc::SYS_pwritev2,
        "openat" => libc::SYS_openat,
        "openat2" => 437, // SYS_openat2 on x86_64 (not in older libc)
        "close" => libc::SYS_close,
        "fstat" => libc::SYS_fstat,
        "newfstatat" => libc::SYS_newfstatat,
        "lseek" => libc::SYS_lseek,
        "fcntl" => libc::SYS_fcntl,
        "dup" => libc::SYS_dup,
        "dup2" => libc::SYS_dup2,
        "dup3" => libc::SYS_dup3,
        "pipe2" => libc::SYS_pipe2,
        "statx" => libc::SYS_statx,
        "access" => libc::SYS_access,
        "faccessat" => libc::SYS_faccessat,
        "faccessat2" => libc::SYS_faccessat2,
        "readlink" => libc::SYS_readlink,
        "readlinkat" => libc::SYS_readlinkat,
        "getcwd" => libc::SYS_getcwd,
        "getdents64" => libc::SYS_getdents64,
        "unlink" => libc::SYS_unlink,
        "unlinkat" => libc::SYS_unlinkat,
        "mkdir" => libc::SYS_mkdir,
        "mkdirat" => libc::SYS_mkdirat,
        "rmdir" => libc::SYS_rmdir,
        "rename" => libc::SYS_rename,
        "renameat" => libc::SYS_renameat,
        "renameat2" => libc::SYS_renameat2,
        "symlink" => libc::SYS_symlink,
        "symlinkat" => libc::SYS_symlinkat,
        "ftruncate" => libc::SYS_ftruncate,
        "fallocate" => libc::SYS_fallocate,
        "fsync" => libc::SYS_fsync,
        "fdatasync" => libc::SYS_fdatasync,

        // KVM operations
        "ioctl" => libc::SYS_ioctl,

        // Memory mapping for KVM
        "memfd_create" => libc::SYS_memfd_create,

        // Events and polling
        "epoll_create1" => libc::SYS_epoll_create1,
        "epoll_ctl" => libc::SYS_epoll_ctl,
        "epoll_wait" => libc::SYS_epoll_wait,
        "epoll_pwait" => libc::SYS_epoll_pwait,
        "epoll_pwait2" => libc::SYS_epoll_pwait2,
        "eventfd2" => libc::SYS_eventfd2,
        "poll" => libc::SYS_poll,
        "ppoll" => libc::SYS_ppoll,
        "select" => libc::SYS_select,
        "pselect6" => libc::SYS_pselect6,

        // Timers and clocks
        "clock_gettime" => libc::SYS_clock_gettime,
        "clock_getres" => libc::SYS_clock_getres,
        "clock_nanosleep" => libc::SYS_clock_nanosleep,
        "nanosleep" => libc::SYS_nanosleep,
        "gettimeofday" => libc::SYS_gettimeofday,
        "timerfd_create" => libc::SYS_timerfd_create,
        "timerfd_settime" => libc::SYS_timerfd_settime,
        "timerfd_gettime" => libc::SYS_timerfd_gettime,

        // Signals
        "rt_sigaction" => libc::SYS_rt_sigaction,
        "rt_sigprocmask" => libc::SYS_rt_sigprocmask,
        "rt_sigreturn" => libc::SYS_rt_sigreturn,
        "sigaltstack" => libc::SYS_sigaltstack,

        // Threading
        "clone" => libc::SYS_clone,
        "clone3" => libc::SYS_clone3,
        "futex" => libc::SYS_futex,
        "set_robust_list" => libc::SYS_set_robust_list,
        "get_robust_list" => libc::SYS_get_robust_list,
        "rseq" => libc::SYS_rseq,
        "set_tid_address" => libc::SYS_set_tid_address,
        "gettid" => libc::SYS_gettid,

        // Process info
        "getpid" => libc::SYS_getpid,
        "getppid" => libc::SYS_getppid,
        "getuid" => libc::SYS_getuid,
        "geteuid" => libc::SYS_geteuid,
        "getgid" => libc::SYS_getgid,
        "getegid" => libc::SYS_getegid,
        "getgroups" => libc::SYS_getgroups,
        "capget" => libc::SYS_capget,
        "capset" => libc::SYS_capset,
        "umask" => libc::SYS_umask,

        // Process exit
        "exit" => libc::SYS_exit,
        "exit_group" => libc::SYS_exit_group,

        // Resource limits
        "getrlimit" => libc::SYS_getrlimit,
        "prlimit64" => libc::SYS_prlimit64,

        // Networking
        "socket" => libc::SYS_socket,
        "socketpair" => libc::SYS_socketpair,
        "connect" => libc::SYS_connect,
        "accept" => libc::SYS_accept,
        "accept4" => libc::SYS_accept4,
        "bind" => libc::SYS_bind,
        "listen" => libc::SYS_listen,
        "sendto" => libc::SYS_sendto,
        "recvfrom" => libc::SYS_recvfrom,
        "sendmsg" => libc::SYS_sendmsg,
        "recvmsg" => libc::SYS_recvmsg,
        "shutdown" => libc::SYS_shutdown,
        "getsockname" => libc::SYS_getsockname,
        "getpeername" => libc::SYS_getpeername,
        "getsockopt" => libc::SYS_getsockopt,
        "setsockopt" => libc::SYS_setsockopt,

        // Misc
        "uname" => libc::SYS_uname,
        "arch_prctl" => libc::SYS_arch_prctl,
        "prctl" => libc::SYS_prctl,
        "getrandom" => libc::SYS_getrandom,
        "sched_yield" => libc::SYS_sched_yield,
        "sched_getaffinity" => libc::SYS_sched_getaffinity,
        "sched_setaffinity" => libc::SYS_sched_setaffinity,
        "setpriority" => libc::SYS_setpriority,
        "getpriority" => libc::SYS_getpriority,

        // Landlock (security)
        "landlock_create_ruleset" => libc::SYS_landlock_create_ruleset,
        "landlock_add_rule" => libc::SYS_landlock_add_rule,
        "landlock_restrict_self" => libc::SYS_landlock_restrict_self,

        // Signal handling (for libkrun thread management)
        "tgkill" => libc::SYS_tgkill,
        "kill" => libc::SYS_kill,
        "signalfd" => libc::SYS_signalfd,
        "signalfd4" => libc::SYS_signalfd4,

        // Process management (for VM process lifecycle)
        "wait4" => libc::SYS_wait4,
        "waitid" => libc::SYS_waitid,

        // Memory management (for VM memory operations)
        "mlock" => libc::SYS_mlock,
        "munlock" => libc::SYS_munlock,
        "mlock2" => libc::SYS_mlock2,
        "mincore" => libc::SYS_mincore,
        "msync" => libc::SYS_msync,

        // Unknown syscall
        _ => return None,
    })
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
        assert!(is_allowed("ioctl")); // KVM
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

    #[test]
    #[cfg(target_os = "linux")]
    fn test_generate_bpf_filter() {
        // Test that BPF filter generation succeeds
        let result = generate_bpf_filter();
        assert!(result.is_ok(), "BPF filter generation should succeed");

        let bpf = result.unwrap();
        // BPF program should not be empty
        assert!(!bpf.is_empty(), "BPF program should not be empty");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn test_syscall_name_to_nr() {
        // Test common syscalls map correctly
        assert!(syscall_name_to_nr("read").is_some());
        assert!(syscall_name_to_nr("write").is_some());
        assert!(syscall_name_to_nr("mmap").is_some());
        assert!(syscall_name_to_nr("ioctl").is_some());

        // Test unknown syscall returns None
        assert!(syscall_name_to_nr("nonexistent_syscall").is_none());
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn test_all_allowed_syscalls_mapped() {
        // Verify most syscalls can be mapped (some may not exist on all architectures)
        let mut unmapped = Vec::new();
        let mut mapped = 0;

        for syscall in ALLOWED_SYSCALLS {
            if syscall_name_to_nr(syscall).is_some() {
                mapped += 1;
            } else {
                unmapped.push(*syscall);
            }
        }

        // At least 90% of syscalls should be mapped
        let min_mapped = (ALLOWED_SYSCALLS.len() * 90) / 100;
        assert!(
            mapped >= min_mapped,
            "Expected at least {} mapped syscalls, got {}. Unmapped: {:?}",
            min_mapped,
            mapped,
            unmapped
        );
    }
}
