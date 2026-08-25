//! Host system validation — run once at startup, fail fast.
//!
//! `SystemCheck::run()` verifies all host requirements before BoxLite does
//! expensive work (filesystem setup, database, networking). The returned
//! struct is proof that checks passed and holds validated resources.
//!
//! The `HypervisorProbe` trait provides platform-abstracted hypervisor
//! diagnostics for both startup validation and post-failure error refinement.

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::util::HostDiagnostic;
use boxlite_shared::{BoxliteError, BoxliteResult};

// ── HypervisorProbe trait ──────────────────────────────────────────────────

/// Platform-abstracted hypervisor validation.
///
/// Provides two levels of checking:
/// - `startup_check()`: one-time validation at runtime init
/// - `diagnose_create_failure()`: post-failure diagnostic when VM creation
///   fails, refining a generic error into a specific one (zero-cost on the
///   happy path since it only runs after a failure)
pub(crate) trait HypervisorProbe: Send + Sync {
    /// One-time startup validation. Called from `SystemCheck::run()`.
    fn startup_check(&self) -> BoxliteResult<()>;

    /// Post-failure diagnostic. Called when engine create/enter fails.
    ///
    /// Inspects hypervisor state to refine the generic error into a
    /// specific one. Returns the original error unchanged if no better
    /// diagnosis is available.
    #[allow(dead_code)] // Called by krun engine (feature-gated)
    fn diagnose_create_failure(&self, error: BoxliteError) -> BoxliteError;
}

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
            let probe = KvmProbe;
            probe.startup_check()?;
            Ok(Self {
                _kvm: probe.into_kvm_file(),
            })
        }

        #[cfg(target_os = "macos")]
        {
            let probe = HvfProbe;
            probe.startup_check()?;
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

/// Create the platform-appropriate hypervisor probe.
///
/// Used by the shim to get a probe for `diagnose_create_failure()` without
/// needing a full `SystemCheck` (startup checks already passed).
#[cfg(feature = "krun")]
pub(crate) fn hypervisor_probe() -> Box<dyn HypervisorProbe> {
    #[cfg(target_os = "macos")]
    {
        Box::new(HvfProbe)
    }

    #[cfg(target_os = "linux")]
    {
        Box::new(KvmProbe)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Box::new(NoopProbe)
    }
}

// ── Linux: KVM ──────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
struct KvmProbe;

#[cfg(target_os = "linux")]
impl KvmProbe {
    /// Open /dev/kvm and return the file handle.
    fn into_kvm_file(self) -> std::fs::File {
        // Re-open for the SystemCheck to hold. If startup_check passed,
        // this will succeed too.
        open_kvm().expect("KVM was validated in startup_check but re-open failed")
    }
}

#[cfg(target_os = "linux")]
impl HypervisorProbe for KvmProbe {
    fn startup_check(&self) -> BoxliteResult<()> {
        let kvm = open_kvm()?;
        smoke_test_kvm(&kvm)?;
        Ok(())
    }

    fn diagnose_create_failure(&self, error: BoxliteError) -> BoxliteError {
        // KVM errors from libkrun are already specific enough.
        error
    }
}

#[cfg(target_os = "linux")]
fn open_kvm() -> BoxliteResult<std::fs::File> {
    use std::path::Path;

    const DEV: &str = "/dev/kvm";

    if !Path::new(DEV).exists() {
        let diagnostic = kvm_missing();
        tracing::error!("{}", diagnostic.operator());
        return Err(BoxliteError::Unsupported(diagnostic.into_client()));
    }

    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(DEV)
        .map_err(|e| {
            let diagnostic = match e.kind() {
                std::io::ErrorKind::PermissionDenied => kvm_permission_denied(),
                _ => kvm_open_failed(e.to_string()),
            };
            tracing::error!("{}", diagnostic.operator());
            BoxliteError::Unsupported(diagnostic.into_client())
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

    let diagnostic = kvm_smoke_failed(exit_reason, KVM_EXIT_HLT, &kernel);
    tracing::error!("{}", diagnostic.operator());
    Err(BoxliteError::Unsupported(diagnostic.into_client()))
}

/// `/dev/kvm` is absent. The operator guidance (BIOS, module, WSL2) needs a
/// host shell; the caller only learns KVM is unavailable.
#[cfg(target_os = "linux")]
fn kvm_missing() -> HostDiagnostic {
    let mut msg = String::from(
        "/dev/kvm does not exist\n\n\
         Suggestions:\n\
         - Enable KVM in BIOS/UEFI (VT-x for Intel, AMD-V for AMD)\n\
         - Load the KVM module: sudo modprobe kvm_intel  # or kvm_amd\n\
         - Check: lsmod | grep kvm",
    );

    if std::path::Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists() {
        msg.push_str(
            "\n\nWSL2 detected:\n\
             - Requires Windows 11 or Windows 10 build 21390+\n\
             - Add 'nestedVirtualization=true' to .wslconfig\n\
             - Restart WSL: wsl --shutdown",
        );
    }

    HostDiagnostic::new("KVM is not available on this host.", msg)
}

#[cfg(target_os = "linux")]
fn kvm_permission_denied() -> HostDiagnostic {
    HostDiagnostic::new(
        "KVM is available but access is denied for the current user.",
        "/dev/kvm: permission denied\n\n\
         Fix:\n\
         - sudo usermod -aG kvm $USER && newgrp kvm",
    )
}

#[cfg(target_os = "linux")]
fn kvm_open_failed(error: String) -> HostDiagnostic {
    HostDiagnostic::new("KVM could not be opened.", format!("/dev/kvm: {error}"))
}

#[cfg(target_os = "linux")]
fn kvm_smoke_failed(exit_reason: i32, expected: i32, kernel: &str) -> HostDiagnostic {
    HostDiagnostic::new(
        "KVM is present but cannot run a virtual machine on this host.",
        format!(
            "KVM smoke test failed: vCPU exit reason {exit_reason} (expected {expected})\n\n\
             /dev/kvm exists but cannot execute guest code (host kernel: {kernel}).\n\n\
             Suggestions:\n\
             - Ensure nested virtualization is enabled (cloud instances need this explicitly)\n\
             - Load the KVM module: sudo modprobe kvm_intel  # or kvm_amd\n\
             - Check: lsmod | grep kvm\n\
             - See https://github.com/boxlite-ai/boxlite/blob/main/docs/faq.md"
        ),
    )
}

// ── macOS: Hypervisor.framework ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[allow(dead_code)] // FFI interface — not all constants/functions used in every code path
mod hvf_ffi {
    //! Direct FFI to Hypervisor.framework for diagnostic probing.
    //!
    //! The shim links Hypervisor.framework via libkrun-sys (build.rs),
    //! so these symbols are available at runtime.

    // hv_return_t = i32 (mach_error_t)
    pub const HV_SUCCESS: i32 = 0;
    pub const HV_BUSY: i32 = -85377022;
    pub const HV_NO_RESOURCES: i32 = -85377019;
    pub const HV_DENIED: i32 = -85377017;

    unsafe extern "C" {
        /// Create a VM for the current process. One VM per process on ARM64.
        /// `config` is nullable — NULL uses default configuration.
        pub fn hv_vm_create(config: *mut std::ffi::c_void) -> i32;

        /// Destroy the VM for the current process.
        pub fn hv_vm_destroy() -> i32;
    }
}

#[cfg(target_os = "macos")]
struct HvfProbe;

#[cfg(target_os = "macos")]
impl HypervisorProbe for HvfProbe {
    fn startup_check(&self) -> BoxliteResult<()> {
        check_hypervisor_framework()
    }

    fn diagnose_create_failure(&self, error: BoxliteError) -> BoxliteError {
        // Probe HVF directly to get the exact error code that libkrun discards.
        //
        // After libkrun's krun_start_enter() fails:
        // - If hv_vm_create() failed inside libkrun (e.g., HV_NO_RESOURCES):
        //   no VM exists, our probe can call hv_vm_create() to reproduce the error.
        // - If hv_vm_create() succeeded but a later step failed:
        //   a VM exists, our probe returns HV_BUSY (one VM per process on ARM64).
        //
        // SAFETY: hv_vm_create/hv_vm_destroy are C functions from Hypervisor.framework.
        // The shim process links the framework via libkrun-sys.
        let ret = unsafe { hvf_ffi::hv_vm_create(std::ptr::null_mut()) };

        match ret {
            hvf_ffi::HV_NO_RESOURCES => {
                tracing::error!(
                    hvf_code = ret,
                    "HVF diagnostic: HV_NO_RESOURCES — VM address spaces exhausted \
                     (see sysctl kern.hv.max_address_spaces)"
                );
                BoxliteError::ResourceExhausted(
                    "macOS Hypervisor.framework VM address spaces are exhausted. \
                     Stop some running boxes and retry."
                        .into(),
                )
            }
            hvf_ffi::HV_SUCCESS => {
                // HVF works fine — failure was elsewhere (rootfs, config, etc.)
                unsafe {
                    hvf_ffi::hv_vm_destroy();
                }
                tracing::debug!(
                    "HVF diagnostic: hv_vm_create succeeded — failure is not HVF-related"
                );
                error
            }
            hvf_ffi::HV_BUSY => {
                // libkrun created a VM but failed after (vCPU setup, memory mapping, etc.)
                tracing::debug!("HVF diagnostic: HV_BUSY — VM exists, failure was post-creation");
                error
            }
            hvf_ffi::HV_DENIED => {
                tracing::error!(
                    hvf_code = ret,
                    "HVF diagnostic: HV_DENIED — missing entitlement \
                     (the shim binary needs com.apple.security.hypervisor)"
                );
                BoxliteError::Unsupported("Hypervisor.framework access is denied.".into())
            }
            _ => {
                tracing::error!(
                    hvf_code = format!("{ret:#x}"),
                    "HVF diagnostic: unexpected error code (original error: {error})"
                );
                BoxliteError::Engine("The VM failed to start.".into())
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn check_hypervisor_framework() -> BoxliteResult<()> {
    #[cfg(not(target_arch = "aarch64"))]
    {
        let diagnostic = hvf_unsupported_arch(std::env::consts::ARCH);
        tracing::error!("{}", diagnostic.operator());
        return Err(BoxliteError::Unsupported(diagnostic.into_client()));
    }

    #[cfg(target_arch = "aarch64")]
    {
        let output = std::process::Command::new("sysctl")
            .arg("kern.hv_support")
            .output()
            .map_err(|e| {
                let diagnostic = hvf_sysctl_failed(e.to_string());
                tracing::error!("{}", diagnostic.operator());
                BoxliteError::Unsupported(diagnostic.into_client())
            })?;

        if !output.status.success() {
            let diagnostic = hvf_sysctl_failed("non-zero exit status".to_string());
            tracing::error!("{}", diagnostic.operator());
            return Err(BoxliteError::Unsupported(diagnostic.into_client()));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let value = stdout.split(':').nth(1).map(|s| s.trim()).unwrap_or("0");

        if value == "1" {
            Ok(())
        } else {
            let diagnostic = hvf_unavailable();
            tracing::error!("{}", diagnostic.operator());
            Err(BoxliteError::Unsupported(diagnostic.into_client()))
        }
    }
}

#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
fn hvf_unsupported_arch(arch: &str) -> HostDiagnostic {
    HostDiagnostic::new(
        "BoxLite on macOS requires Apple Silicon (ARM64).",
        format!(
            "Unsupported architecture: {arch}\n\n\
             BoxLite on macOS requires Apple Silicon (ARM64).\n\
             Intel Macs are not supported."
        ),
    )
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn hvf_sysctl_failed(error: String) -> HostDiagnostic {
    HostDiagnostic::new(
        "Hypervisor.framework could not be checked.",
        format!(
            "Failed to check Hypervisor.framework: {error}\n\n\
                 Check manually: sysctl kern.hv_support"
        ),
    )
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn hvf_unavailable() -> HostDiagnostic {
    HostDiagnostic::new(
        "Hypervisor.framework is not available on this host.",
        "Hypervisor.framework is not available\n\n\
         Suggestions:\n\
         - Verify macOS 10.10 or later\n\
         - Check: sysctl kern.hv_support",
    )
}

// ── Unsupported platforms ──────────────────────────────────────────────────

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
struct NoopProbe;

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
impl HypervisorProbe for NoopProbe {
    fn startup_check(&self) -> BoxliteResult<()> {
        Err(BoxliteError::Unsupported(
            "BoxLite only supports Linux and macOS".into(),
        ))
    }

    fn diagnose_create_failure(&self, error: BoxliteError) -> BoxliteError {
        error
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

    /// The client-facing halves of the KVM diagnostics must not carry host
    /// internals — the regression guard for POL-329 on the Linux producers.
    #[test]
    #[cfg(target_os = "linux")]
    fn kvm_client_messages_are_safe() {
        for (diag, box_id) in [
            (kvm_missing(), "vIsLhQP34dQF"),
            (kvm_permission_denied(), "vIsLhQP34dQF"),
            (kvm_open_failed("EACCES".into()), "vIsLhQP34dQF"),
            (kvm_smoke_failed(7, 5, "6.8.0"), "vIsLhQP34dQF"),
        ] {
            crate::util::assert_client_safe(diag.client(), box_id);
            // The detail is routed, not dropped.
            assert!(
                diag.operator().contains("/dev/kvm"),
                "operator report lost the KVM detail"
            );
        }
    }

    /// The Linux KVM diagnostics must keep host guidance out of the client
    /// message. Same regression guard as crash_report (POL-329).
    #[test]
    #[cfg(target_os = "linux")]
    fn kvm_diagnostics_never_leak_host_internals() {
        let cases: Vec<(HostDiagnostic, &str)> = vec![
            (kvm_missing(), "missing"),
            (kvm_permission_denied(), "permission denied"),
            (kvm_open_failed("EACCES".to_string()), "open failed"),
            (kvm_smoke_failed(3, 5, "6.8.0"), "smoke failed"),
        ];
        for (diag, label) in cases {
            crate::util::assert_client_safe(diag.client(), "test-box");
            // The operator half is where the guidance belongs.
            assert!(
                diag.operator().contains("modprobe")
                    || diag.operator().contains("lsmod")
                    || diag.operator().contains("/dev/kvm")
                    || diag.operator().contains("nested"),
                "{label}: operator report lost the guidance"
            );
        }
    }

    #[test]
    #[cfg(feature = "krun")]
    fn hypervisor_probe_returns_original_on_passthrough() {
        // On any platform, diagnose_create_failure should at least return
        // the original error (or a refined version) — never panic.
        let probe = hypervisor_probe();
        let original = BoxliteError::Engine("test error".into());
        let result = probe.diagnose_create_failure(original);
        // Should be some form of error (original or refined)
        let msg = result.to_string();
        assert!(!msg.is_empty());
    }

    #[cfg(target_os = "macos")]
    mod hvf_tests {
        use super::super::*;

        #[test]
        fn hvf_probe_startup_check() {
            let probe = HvfProbe;
            // Should succeed on Apple Silicon Mac with HVF support
            match probe.startup_check() {
                Ok(()) => {}
                Err(e) => {
                    let msg = e.to_string();
                    assert!(
                        msg.contains("Hypervisor") || msg.contains("architecture"),
                        "Error should mention HVF: {msg}"
                    );
                }
            }
        }

        #[test]
        fn hvf_ffi_constants() {
            // Verify constants match Apple's Hypervisor.framework definitions
            assert_eq!(hvf_ffi::HV_SUCCESS, 0);
            assert_eq!(hvf_ffi::HV_NO_RESOURCES, -85377019_i32);
            assert_eq!(hvf_ffi::HV_BUSY, -85377022_i32);
            assert_eq!(hvf_ffi::HV_DENIED, -85377017_i32);
        }
    }
}
