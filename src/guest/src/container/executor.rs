//! Custom libcontainer Executor that undoes the tenant-builder-injected
//! OCI default `readonly_paths` / `masked_paths` before `execvp`.
//!
//! # Why this is necessary
//!
//! libcontainer-0.5.7's `TenantContainerBuilder::adapt_spec_for_tenant`
//! (`src/container/tenant_builder.rs:442`) rebuilds the OCI `Linux`
//! block from `LinuxBuilder::default().namespaces(ns)`, **dropping**
//! the init spec's `readonly_paths` / `masked_paths`. `LinuxBuilder`'s
//! `default` derive fills missing fields via `Linux::default()`, which
//! in `oci-spec-0.6.7` resolves to the OCI defaults from
//! `get_default_readonly_paths()` (5 paths including `/proc/sys`) and
//! `get_default_maskedpaths()` (10 paths including `/proc/kcore`).
//! So every tenant exec — including the foreground `sleep infinity`
//! `boxlite run` spawns when `--entrypoint` is set, and every
//! subsequent `boxlite exec` — re-applies the default hardening:
//! libcontainer's init bind-mounts `/proc/sys`, `/proc/bus`,
//! `/proc/fs`, `/proc/irq` as `ro,nosuid,nodev,noexec`, and overlays
//! `tmpfs`/`/dev/null` on the masked paths. These mounts land in the
//! *shared* mount namespace and break any in-box workload that needs
//! `/proc/sys` writable — most notably `dockerd`'s default bridge
//! setup, which writes `/proc/sys/net/ipv4/ip_forward`.
//!
//! Bug present in libcontainer 0.5.7, libcontainer 0.6.0, and youki
//! upstream `main` — bumping the dep does not fix it. The clean fix
//! is to teach `adapt_spec_for_tenant` to preserve the init spec's
//! ro/mask policy, which is the right upstream PR; until then we
//! mitigate in-tree without forking libcontainer.
//!
//! # How the mitigation works
//!
//! The `Executor` trait is libcontainer's last hook before `execvp`.
//! It runs inside the tenant process, after `readonly_paths` /
//! `masked_paths` have been applied. Our executor:
//!   1. Reads the `io.boxlite.privileged` annotation off the spec.
//!      This annotation is set by `create_oci_spec` when
//!      `privileged = true` and is preserved across `Spec::save` /
//!      `Spec::load`, so it survives the tenant-builder's spec
//!      adaptation (which doesn't touch annotations).
//!   2. When the annotation is `"true"`, `umount2(MNT_DETACH)` each
//!      of the well-known OCI default ro/masked paths. Errors are
//!      ignored: `EINVAL` means the path isn't a mount point (init
//!      spec was `Some([])`, nothing was mounted), `ENOENT` means
//!      the path doesn't exist on this kernel — both expected on
//!      various paths.
//!   3. `execvp` the spec's `process.args`, matching libcontainer's
//!      `DefaultExecutor` behaviour.
//!
//! For non-privileged boxes we skip the unmount loop: the OCI defaults
//! ARE the intended hardening there, and the init spec also carries
//! them, so the tenant just re-confirms what's already in place.

use std::ffi::CString;

use libcontainer::oci_spec::runtime::Spec;
use libcontainer::workload::{Executor, ExecutorError, ExecutorValidationError};
use nix::mount::{umount2, MntFlags};
use nix::unistd;

/// Annotation key set on the OCI spec when boxlite is in
/// `--privileged` mode. Read by `BoxliteExecutor::exec` to decide
/// whether to undo the tenant-injected OCI default hardening.
pub const PRIVILEGED_ANNOTATION: &str = "io.boxlite.privileged";

/// OCI default `readonly_paths` from `oci-spec-0.6.7`'s
/// `get_default_readonly_paths()`. Pinned explicitly so the unmount
/// set stays in lockstep with what libcontainer's tenant init applies.
const DEFAULT_READONLY_PATHS: &[&str] = &[
    "/proc/bus",
    "/proc/fs",
    "/proc/irq",
    "/proc/sys",
    "/proc/sysrq-trigger",
];

/// OCI default `masked_paths` from `oci-spec-0.6.7`'s
/// `get_default_maskedpaths()`.
const DEFAULT_MASKED_PATHS: &[&str] = &[
    "/proc/acpi",
    "/proc/asound",
    "/proc/kcore",
    "/proc/keys",
    "/proc/latency_stats",
    "/proc/timer_list",
    "/proc/timer_stats",
    "/proc/sched_debug",
    "/sys/firmware",
    "/proc/scsi",
];

#[derive(Clone)]
pub struct BoxliteExecutor;

impl BoxliteExecutor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for BoxliteExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl Executor for BoxliteExecutor {
    fn exec(&self, spec: &Spec) -> Result<(), ExecutorError> {
        if is_privileged(spec) {
            // MNT_DETACH so a held fd on the mountpoint doesn't EBUSY us;
            // the unmount completes lazily once the fd is closed but the
            // path is already exposed to the parent (rw procfs underneath).
            for path in DEFAULT_READONLY_PATHS
                .iter()
                .chain(DEFAULT_MASKED_PATHS.iter())
            {
                let _ = umount2(*path, MntFlags::MNT_DETACH);
            }
        }

        // execvp the spec's process args. Mirrors libcontainer's
        // `workload::default::DefaultExecutor::exec`.
        let args = spec
            .process()
            .as_ref()
            .and_then(|p| p.args().as_ref())
            .ok_or(ExecutorError::InvalidArg)?;
        if args.is_empty() {
            return Err(ExecutorError::InvalidArg);
        }
        let exe = CString::new(args[0].as_bytes()).map_err(|_| ExecutorError::InvalidArg)?;
        let cargs: Vec<CString> = args
            .iter()
            .map(|s| CString::new(s.as_bytes()).unwrap_or_default())
            .collect();
        unistd::execvp(&exe, &cargs).map_err(|err| {
            ExecutorError::Execution(
                format!("execvp({:?}, {:?}) failed: {}", exe, cargs, err).into(),
            )
        })?;
        unreachable!("execvp does not return on success");
    }

    fn validate(&self, _spec: &Spec) -> Result<(), ExecutorValidationError> {
        // Skip the validation `DefaultExecutor` does: it requires a
        // `PATH=` env entry and walks it to confirm the executable is
        // resolvable from the host's filesystem view, which is the
        // wrong filesystem (the container's rootfs hasn't been pivoted
        // yet). `execvp` will fail loudly inside `exec` if the binary
        // is genuinely missing.
        Ok(())
    }
}

fn is_privileged(spec: &Spec) -> bool {
    spec.annotations()
        .as_ref()
        .and_then(|a| a.get(PRIVILEGED_ANNOTATION))
        .map(|v| v == "true")
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use libcontainer::oci_spec::runtime::{ProcessBuilder, SpecBuilder};
    use std::collections::HashMap;

    fn spec_with_annotation(value: Option<&str>) -> Spec {
        let process = ProcessBuilder::default()
            .args(vec!["/bin/true".to_string()])
            .build()
            .unwrap();
        let mut b = SpecBuilder::default().process(process);
        if let Some(v) = value {
            let mut a = HashMap::new();
            a.insert(PRIVILEGED_ANNOTATION.to_string(), v.to_string());
            b = b.annotations(a);
        }
        b.build().unwrap()
    }

    #[test]
    fn is_privileged_true_only_when_annotation_equals_true() {
        assert!(is_privileged(&spec_with_annotation(Some("true"))));
        assert!(!is_privileged(&spec_with_annotation(Some("false"))));
        assert!(!is_privileged(&spec_with_annotation(Some("1"))));
        assert!(!is_privileged(&spec_with_annotation(Some(""))));
        assert!(!is_privileged(&spec_with_annotation(None)));
    }
}
