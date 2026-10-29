//! Compile one thread's filter of a BoxLite seccomp JSON with the call
//! src/boxlite/build.rs makes, and write it as raw `sock_filter`
//! instructions (8 bytes each, native endian) for tests that install the
//! production filter themselves.
//!
//! Usage: boxlite-seccomp-bpf <filter.json> <arch> <thread> <out>

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let [_, json, arch, thread, out] = args.as_slice() else {
        eprintln!("usage: boxlite-seccomp-bpf <filter.json> <arch> <thread> <out>");
        return ExitCode::FAILURE;
    };
    match compile(json, arch, thread, out) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("boxlite-seccomp-bpf: {e}");
            ExitCode::FAILURE
        }
    }
}

fn compile(json: &str, arch: &str, thread: &str, out: &str) -> Result<(), String> {
    let arch: seccompiler::TargetArch = arch.try_into().map_err(|e| format!("{arch}: {e:?}"))?;
    let filters = std::fs::read(json).map_err(|e| format!("{json}: {e}"))?;
    let filters = seccompiler::compile_from_json(filters.as_slice(), arch)
        .map_err(|e| format!("{json}: {e}"))?;
    let filter = filters
        .get(thread)
        .ok_or_else(|| format!("{json} has no {thread} filter"))?;
    let mut bytes = Vec::with_capacity(filter.len() * 8);
    for insn in filter {
        bytes.extend_from_slice(&insn.code.to_ne_bytes());
        bytes.extend_from_slice(&[insn.jt, insn.jf]);
        bytes.extend_from_slice(&insn.k.to_ne_bytes());
    }
    std::fs::write(out, bytes).map_err(|e| format!("{out}: {e}"))
}

#[cfg(test)]
mod tests {
    //! The production x86_64 VMM filters allow every syscall the virtio-fs
    //! snapshot archive, pause path and a networked VM make, and trap escape
    //! syscalls, decided by running the compiled BPF on each syscall number.

    use seccompiler::{sock_filter, TargetArch};

    const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
    const RET_ALLOW: u32 = 0x7fff_0000;
    const RET_TRAP: u32 = 0x0003_0000;
    const MS_SYNC: u64 = 4;

    /// x86_64 numbers of what capture, import, session restore and pause
    /// sync call (passthrough/archive/{capture,import,host}.rs,
    /// passthrough/snapshot.rs, passthrough/dax.rs), with the arguments a
    /// filter rule may test.
    const SNAPSHOT_SYSCALLS: &[(&str, u32, [u64; 6])] = &[
        ("pwrite64", 18, [0; 6]),
        ("msync", 26, [0, 0, MS_SYNC, 0, 0, 0]),
        ("fdatasync", 75, [0; 6]),
        ("ftruncate", 77, [0; 6]),
        ("geteuid", 107, [0; 6]),
        ("getegid", 108, [0; 6]),
        ("capget", 125, [0; 6]),
        ("setxattr", 188, [0; 6]),
        ("getxattr", 191, [0; 6]),
        ("listxattr", 194, [0; 6]),
        ("removexattr", 197, [0; 6]),
        ("getdents64", 217, [0; 6]),
        ("openat", 257, [0; 6]),
        ("mkdirat", 258, [0; 6]),
        ("mknodat", 259, [0; 6]),
        ("fchownat", 260, [0; 6]),
        ("unlinkat", 263, [0; 6]),
        ("linkat", 265, [0; 6]),
        ("symlinkat", 266, [0; 6]),
        ("readlinkat", 267, [0; 6]),
        ("fchmodat", 268, [0; 6]),
        ("utimensat", 280, [0; 6]),
        ("statx", 332, [0; 6]),
    ];

    const SOCK_CLOEXEC: u64 = 0x80000;
    const MAP_PRIVATE_ANONYMOUS_STACK: u64 = 0x20022;
    const MADV_DONTNEED: u64 = 4;
    const PR_SET_NAME: u64 = 15;
    /// FUTEX_WAIT_BITSET_PRIVATE | FUTEX_CLOCK_REALTIME: a timed wait.
    const FUTEX_TIMED_WAIT: u64 = 393;
    const FUTEX_WAKE_PRIVATE: u64 = 129;
    const SIGTERM: u64 = 15;

    /// x86_64 numbers of what the shim's checkpoint control makes after the
    /// filter is installed: the control server's accept and per-request
    /// threads (vmm/checkpoint/server.rs: thread spawn, accept4, read
    /// timeout, one line each way, close) and the SIGTERM path's bounded owner
    /// stop (shim main.rs: thread, timed channel wait, re-raise).
    const CHECKPOINT_CONTROL_SYSCALLS: &[(&str, u32, [u64; 6])] = &[
        ("read", 0, [0; 6]),
        ("write", 1, [0; 6]),
        ("close", 3, [0; 6]),
        ("mmap", 9, [0, 0, 3, MAP_PRIVATE_ANONYMOUS_STACK, 0, 0]),
        ("mprotect", 10, [0; 6]),
        ("munmap", 11, [0; 6]),
        ("rt_sigprocmask", 14, [0; 6]),
        ("madvise", 28, [0, 0, MADV_DONTNEED, 0, 0, 0]),
        ("sendto", 44, [0; 6]),
        ("recvfrom", 45, [0; 6]),
        ("setsockopt", 54, [0; 6]),
        ("exit", 60, [0; 6]),
        ("sigaltstack", 131, [0; 6]),
        ("prctl", 157, [PR_SET_NAME, 0, 0, 0, 0, 0]),
        ("gettid", 186, [0; 6]),
        ("futex", 202, [0, FUTEX_TIMED_WAIT, 0, 0, 0, 0]),
        ("futex", 202, [0, FUTEX_WAKE_PRIVATE, 0, 0, 0, 0]),
        ("sched_getaffinity", 204, [0; 6]),
        ("exit_group", 231, [0; 6]),
        ("tgkill", 234, [0, 0, SIGTERM, 0, 0, 0]),
        ("set_robust_list", 273, [0; 6]),
        ("accept4", 288, [0, 0, 0, SOCK_CLOEXEC, 0, 0]),
        ("rseq", 334, [0; 6]),
        ("clone3", 435, [0; 6]),
    ];

    const FALLOC_FL_KEEP_SIZE: u64 = 0x01;
    const FALLOC_FL_PUNCH_HOLE: u64 = 0x02;
    const FALLOC_FL_COLLAPSE_RANGE: u64 = 0x08;
    const FALLOC_FL_ZERO_RANGE: u64 = 0x10;
    const FALLOC_FL_INSERT_RANGE: u64 = 0x20;
    const FALLOC_FL_UNSHARE_RANGE: u64 = 0x40;

    /// x86_64 numbers of what a networked VM adds to the VMM filter:
    /// gvproxy's Go dial reads the peer after connect (net/fd_unix.go), and
    /// virtio-blk discard and virtio-fs FUSE_FALLOCATE pass the fallocate
    /// modes a stock guest kernel sends (fs/fuse/file.c, fs/open.c).
    const NETWORKED_VM_SYSCALLS: &[(&str, u32, [u64; 6])] = &[
        ("getpeername", 52, [0; 6]),
        ("fallocate", 285, [0; 6]),
        ("fallocate", 285, [0, FALLOC_FL_KEEP_SIZE, 0, 0, 0, 0]),
        (
            "fallocate",
            285,
            [0, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, 0, 0, 0, 0],
        ),
        ("fallocate", 285, [0, FALLOC_FL_ZERO_RANGE, 0, 0, 0, 0]),
        (
            "fallocate",
            285,
            [0, FALLOC_FL_ZERO_RANGE | FALLOC_FL_KEEP_SIZE, 0, 0, 0, 0],
        ),
    ];

    /// x86_64 numbers a compromised VMM could use to leave its sandbox or
    /// reshape host files beyond what a guest can ask for; they must trap.
    const TRAPPED_SYSCALLS: &[(&str, u32, [u64; 6])] = &[
        ("fallocate", 285, [0, FALLOC_FL_PUNCH_HOLE, 0, 0, 0, 0]),
        ("fallocate", 285, [0, FALLOC_FL_COLLAPSE_RANGE, 0, 0, 0, 0]),
        ("fallocate", 285, [0, FALLOC_FL_INSERT_RANGE, 0, 0, 0, 0]),
        ("fallocate", 285, [0, FALLOC_FL_UNSHARE_RANGE, 0, 0, 0, 0]),
        ("execve", 59, [0; 6]),
        ("ptrace", 101, [0; 6]),
        ("mount", 165, [0; 6]),
        ("unshare", 272, [0; 6]),
        ("open_by_handle_at", 304, [0; 6]),
        ("setns", 308, [0; 6]),
        ("process_vm_writev", 311, [0; 6]),
        ("bpf", 321, [0; 6]),
        ("execveat", 322, [0; 6]),
    ];

    /// The classic BPF subset seccompiler emits, run on one seccomp_data.
    fn decide(program: &[sock_filter], nr: u32, args: [u64; 6]) -> u32 {
        let mut data = [0u8; 64];
        data[0..4].copy_from_slice(&nr.to_ne_bytes());
        data[4..8].copy_from_slice(&AUDIT_ARCH_X86_64.to_ne_bytes());
        for (i, arg) in args.iter().enumerate() {
            data[16 + i * 8..24 + i * 8].copy_from_slice(&arg.to_ne_bytes());
        }
        let (mut acc, mut pc) = (0u32, 0usize);
        loop {
            let insn = &program[pc];
            pc += 1;
            let jump = |taken: bool| usize::from(if taken { insn.jt } else { insn.jf });
            match insn.code {
                0x20 => {
                    let k = insn.k as usize;
                    acc = u32::from_ne_bytes(data[k..k + 4].try_into().unwrap());
                }
                0x54 => acc &= insn.k,
                0x05 => pc += insn.k as usize,
                0x15 => pc += jump(acc == insn.k),
                0x25 => pc += jump(acc > insn.k),
                0x35 => pc += jump(acc >= insn.k),
                0x45 => pc += jump(acc & insn.k != 0),
                0x06 => return insn.k,
                code => panic!("unexpected BPF instruction {code:#x}"),
            }
        }
    }

    fn vmm_filter(target: &str) -> Vec<sock_filter> {
        let path = format!(
            "{}/../../../src/boxlite/resources/seccomp/{target}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let json = std::fs::read(&path).unwrap();
        let mut filters = seccompiler::compile_from_json(json.as_slice(), TargetArch::x86_64)
            .unwrap_or_else(|e| panic!("{path}: {e}"));
        filters.remove("vmm").unwrap()
    }

    #[test]
    fn x86_64_vmm_filters_allow_the_snapshot_archive_syscalls() {
        for target in ["x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"] {
            let filter = vmm_filter(target);
            for &(name, nr, args) in SNAPSHOT_SYSCALLS {
                assert_eq!(decide(&filter, nr, args), RET_ALLOW, "{target}: {name}");
            }
            // The interpreter sees the filter trap what it does not list:
            // reboot, and msync without MS_SYNC.
            assert_eq!(decide(&filter, 169, [0; 6]), RET_TRAP, "{target}: reboot");
            assert_eq!(decide(&filter, 26, [0; 6]), RET_TRAP, "{target}: msync");
        }
    }

    #[test]
    fn x86_64_vmm_filters_allow_networked_vm_syscalls_and_trap_escapes() {
        for target in ["x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"] {
            let filter = vmm_filter(target);
            for &(name, nr, args) in NETWORKED_VM_SYSCALLS {
                let decision = decide(&filter, nr, args);
                assert_eq!(decision, RET_ALLOW, "{target}: {name} {args:x?}");
            }
            for &(name, nr, args) in TRAPPED_SYSCALLS {
                let decision = decide(&filter, nr, args);
                assert_eq!(decision, RET_TRAP, "{target}: {name} {args:x?}");
            }
        }
    }

    #[test]
    fn x86_64_vmm_filters_allow_the_checkpoint_control_syscalls() {
        for target in ["x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"] {
            let filter = vmm_filter(target);
            for &(name, nr, args) in CHECKPOINT_CONTROL_SYSCALLS {
                assert_eq!(decide(&filter, nr, args), RET_ALLOW, "{target}: {name}");
            }
        }
    }
}
