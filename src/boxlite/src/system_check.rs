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
/// Catches broken /dev/kvm where the device exists but guest code cannot run.
///
/// Implemented in C (`kvm_smoke.c`) because Rust's `libc::ioctl()` variadic FFI
/// has ABI issues with some KVM ioctls on nested virtualization platforms.
///
/// References:
///   - LWN "Using the KVM API": <https://lwn.net/Articles/658511/>
///   - dpw/kvm-hello-world: <https://github.com/dpw/kvm-hello-world>
#[cfg(target_os = "linux")]
fn smoke_test_kvm(kvm: &std::fs::File) -> BoxliteResult<()> {
    use std::os::fd::AsRawFd;

    const KVM_EXIT_HLT: i32 = 5;

    unsafe extern "C" {
        fn boxlite_kvm_smoke_test(kvm_fd: libc::c_int) -> libc::c_int;
    }

    let exit_reason = unsafe { boxlite_kvm_smoke_test(kvm.as_raw_fd()) };

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
         - Ensure nested virtualization is enabled (cloud instances need this explicitly)\n\
         - Load the KVM module: sudo modprobe kvm_intel  # or kvm_amd\n\
         - Check: lsmod | grep kvm\n\
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
