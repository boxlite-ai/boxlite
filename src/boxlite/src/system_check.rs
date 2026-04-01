//! Host system validation — run once at startup, fail fast.
//!
//! `SystemCheck::run()` verifies all host requirements before BoxLite does
//! expensive work (filesystem setup, database, networking). The returned
//! struct is proof that checks passed and holds validated resources.

use boxlite_shared::{BoxliteError, BoxliteResult};

/// Validated host system. Existence means all checks passed.
pub struct SystemCheck {
    #[cfg(target_os = "linux")]
    _kvm: std::fs::File,
}

impl SystemCheck {
    /// Verify all host requirements. Fails fast with actionable diagnostics.
    pub fn run() -> BoxliteResult<Self> {
        #[cfg(target_os = "linux")]
        {
            let kvm = open_kvm()?;
            smoke_test_kvm(&kvm)?;
            Ok(Self { _kvm: kvm })
        }

        #[cfg(target_os = "macos")]
        {
            check_hypervisor_framework()?;
            Ok(Self {})
        }

        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            Err(BoxliteError::Unsupported(
                "BoxLite only supports Linux and macOS".into(),
            ))
        }
    }
}

// ── Linux: KVM ──────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn open_kvm() -> BoxliteResult<std::fs::File> {
    use std::path::Path;

    const DEV: &str = "/dev/kvm";

    if !Path::new(DEV).exists() {
        let mut msg = format!(
            "{DEV} does not exist\n\n\
             Suggestions:\n\
             - Enable KVM in BIOS/UEFI (VT-x for Intel, AMD-V for AMD)\n\
             - Load the KVM module: sudo modprobe kvm_intel  # or kvm_amd\n\
             - Check: lsmod | grep kvm"
        );

        if Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists() {
            msg.push_str(
                "\n\nWSL2 detected:\n\
                 - Requires Windows 11 or Windows 10 build 21390+\n\
                 - Add 'nestedVirtualization=true' to .wslconfig\n\
                 - Restart WSL: wsl --shutdown",
            );
        }

        return Err(BoxliteError::Unsupported(msg));
    }

    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(DEV)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => BoxliteError::Unsupported(format!(
                "{DEV}: permission denied\n\n\
                 Fix:\n\
                 - sudo usermod -aG kvm $USER && newgrp kvm"
            )),
            _ => BoxliteError::Unsupported(format!("{DEV}: {e}")),
        })
}

/// Execute a HLT instruction in a throwaway VM to verify KVM works.
/// Catches broken nested virtualization (e.g., Amazon Linux 2023 on EC2 c8i).
#[cfg(target_os = "linux")]
fn smoke_test_kvm(kvm: &std::fs::File) -> BoxliteResult<()> {
    use std::os::fd::AsRawFd;

    const KVM_CREATE_VM: libc::c_ulong = 0xAE01;
    const KVM_CREATE_VCPU: libc::c_ulong = 0xAE41;
    const KVM_GET_VCPU_MMAP_SIZE: libc::c_ulong = 0xAE04;
    const KVM_RUN: libc::c_ulong = 0xAE80;
    const KVM_SET_USER_MEMORY_REGION: libc::c_ulong = 0x4020AE46;
    const KVM_EXIT_HLT: u32 = 5;

    #[repr(C)]
    struct MemRegion {
        slot: u32,
        flags: u32,
        guest_phys_addr: u64,
        memory_size: u64,
        userspace_addr: u64,
    }

    let kvm_fd = kvm.as_raw_fd();

    let vm_fd = unsafe { libc::ioctl(kvm_fd, KVM_CREATE_VM, 0) };
    if vm_fd < 0 {
        return Err(BoxliteError::Unsupported("KVM: failed to create VM".into()));
    }

    // One page of guest memory with a HLT instruction at address 0
    let mem_size: usize = 4096;
    let guest_mem = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            mem_size,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED | libc::MAP_ANONYMOUS,
            -1,
            0,
        )
    };
    if guest_mem == libc::MAP_FAILED {
        unsafe { libc::close(vm_fd) };
        return Err(BoxliteError::Unsupported(
            "KVM smoke test: mmap failed".into(),
        ));
    }
    unsafe { *(guest_mem as *mut u8) = 0xF4 }; // HLT

    let region = MemRegion {
        slot: 0,
        flags: 0,
        guest_phys_addr: 0,
        memory_size: mem_size as u64,
        userspace_addr: guest_mem as u64,
    };
    if unsafe {
        libc::ioctl(
            vm_fd,
            KVM_SET_USER_MEMORY_REGION,
            &region as *const MemRegion,
        )
    } < 0
    {
        unsafe {
            libc::munmap(guest_mem, mem_size);
            libc::close(vm_fd);
        }
        return Err(BoxliteError::Unsupported(
            "KVM smoke test: set memory region failed".into(),
        ));
    }

    let vcpu_fd = unsafe { libc::ioctl(vm_fd, KVM_CREATE_VCPU, 0) };
    if vcpu_fd < 0 {
        unsafe {
            libc::munmap(guest_mem, mem_size);
            libc::close(vm_fd);
        }
        return Err(BoxliteError::Unsupported(
            "KVM smoke test: create vCPU failed".into(),
        ));
    }

    let mmap_size = unsafe { libc::ioctl(kvm_fd, KVM_GET_VCPU_MMAP_SIZE, 0) } as usize;
    let run_data = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            mmap_size,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED,
            vcpu_fd,
            0,
        )
    };

    let ret = unsafe { libc::ioctl(vcpu_fd, KVM_RUN, 0) };

    let exit_reason = if ret == 0 && run_data != libc::MAP_FAILED {
        unsafe { *(run_data as *const u32) }
    } else {
        u32::MAX
    };

    // Cleanup
    unsafe {
        if run_data != libc::MAP_FAILED {
            libc::munmap(run_data, mmap_size);
        }
        libc::close(vcpu_fd);
        libc::munmap(guest_mem, mem_size);
        libc::close(vm_fd);
    }

    if exit_reason == KVM_EXIT_HLT {
        return Ok(());
    }

    let kernel = std::fs::read_to_string("/proc/version")
        .unwrap_or_default()
        .split_whitespace()
        .nth(2)
        .unwrap_or("unknown")
        .to_string();

    Err(BoxliteError::Unsupported(format!(
        "KVM smoke test failed: vCPU exit reason {exit_reason} (expected {KVM_EXIT_HLT})\n\n\
         /dev/kvm exists but cannot execute guest code (host kernel: {kernel}).\n\n\
         Suggestions:\n\
         - Try a different OS or kernel version\n\
         - Use a bare metal instance for direct KVM access\n\
         - See https://github.com/boxlite-ai/boxlite/blob/main/docs/faq.md"
    )))
}

// ── macOS: Hypervisor.framework ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn check_hypervisor_framework() -> BoxliteResult<()> {
    #[cfg(not(target_arch = "aarch64"))]
    return Err(BoxliteError::Unsupported(format!(
        "Unsupported architecture: {}\n\n\
         BoxLite on macOS requires Apple Silicon (ARM64).\n\
         Intel Macs are not supported.",
        std::env::consts::ARCH
    )));

    #[cfg(target_arch = "aarch64")]
    {
        let output = std::process::Command::new("sysctl")
            .arg("kern.hv_support")
            .output()
            .map_err(|e| {
                BoxliteError::Unsupported(format!(
                    "Failed to check Hypervisor.framework: {e}\n\n\
                     Check manually: sysctl kern.hv_support"
                ))
            })?;

        if !output.status.success() {
            return Err(BoxliteError::Unsupported(
                "sysctl kern.hv_support failed".into(),
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let value = stdout.split(':').nth(1).map(|s| s.trim()).unwrap_or("0");

        if value == "1" {
            Ok(())
        } else {
            Err(BoxliteError::Unsupported(
                "Hypervisor.framework is not available\n\n\
                 Suggestions:\n\
                 - Verify macOS 10.10 or later\n\
                 - Check: sysctl kern.hv_support"
                    .into(),
            ))
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_check_runs() {
        // Result depends on environment (CI may lack /dev/kvm)
        match SystemCheck::run() {
            Ok(_) => {} // host is capable
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("kvm") || msg.contains("KVM") || msg.contains("Hypervisor"),
                    "Error should mention the hypervisor: {msg}"
                );
            }
        }
    }
}
