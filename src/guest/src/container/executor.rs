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
//!      of the well-known OCI default ro/masked paths. **Only**
//!      `EINVAL` and `ENOENT` are treated as expected and silently
//!      skipped: `EINVAL` means the path isn't a mount point (init
//!      spec was `Some([])`, nothing was mounted), `ENOENT` means
//!      the path doesn't exist on this kernel. Any other errno —
//!      `EPERM` / `EACCES` / `EBUSY` / etc. — fails the executor
//!      immediately rather than silently leaving a stale read-only
//!      mount in place; otherwise dockerd would fail downstream
//!      with a confusing "/proc/sys is read-only" error far from the
//!      root cause (mount namespace state inconsistent with the
//!      privileged contract).
//!   3. `execvp` the spec's `process.args`, matching libcontainer's
//!      `DefaultExecutor` behaviour.
//!
//! For non-privileged boxes we skip the unmount loop: the OCI defaults
//! ARE the intended hardening there, and the init spec also carries
//! them, so the tenant just re-confirms what's already in place.

use libcontainer::oci_spec::runtime::Spec;
use libcontainer::workload::default::DefaultExecutor;
use libcontainer::workload::{Executor, ExecutorError, ExecutorValidationError};
use nix::errno::Errno;
use nix::mount::{umount2, MntFlags};

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

/// Wraps libcontainer's `DefaultExecutor` to add a single thing: when
/// the spec carries the `io.boxlite.privileged=true` annotation,
/// `umount2(MNT_DETACH)` each of the OCI default ro/masked paths
/// before delegating to `DefaultExecutor::exec` (which does the
/// `execvp`). For non-privileged specs the pre-step is skipped and
/// the behaviour collapses exactly to `DefaultExecutor` — same
/// `validate()`, same `exec()`. The non-`--privileged` flow is
/// byte-for-byte unchanged.
#[derive(Clone)]
pub struct BoxliteExecutor {
    inner: DefaultExecutor,
}

impl BoxliteExecutor {
    pub fn new() -> Self {
        Self {
            inner: DefaultExecutor {},
        }
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
            //
            // Only EINVAL ("not a mount point", expected when init spec
            // didn't mount the path) and ENOENT ("path doesn't exist",
            // expected on some kernels) are swallowed. Any other errno
            // surfaces as an `ExecutorError::Other` — the alternative
            // (silently continuing into execvp with a stale read-only
            // mount) makes dockerd / overlayfs fail downstream at a
            // layer far from the root cause. See module docs for why
            // we don't try to recover from `EPERM` / `EBUSY` / etc.
            for path in DEFAULT_READONLY_PATHS
                .iter()
                .chain(DEFAULT_MASKED_PATHS.iter())
            {
                match umount2(*path, MntFlags::MNT_DETACH) {
                    Ok(()) | Err(Errno::EINVAL) | Err(Errno::ENOENT) => {}
                    Err(e) => {
                        return Err(ExecutorError::Other(format!(
                            "BoxliteExecutor: unexpected umount2 errno on \
                             `{path}` while undoing OCI default hardening \
                             for --privileged box: {e} (errno {})",
                            e as i32
                        )));
                    }
                }
            }
        }
        self.inner.exec(spec)
    }

    fn validate(&self, spec: &Spec) -> Result<(), ExecutorValidationError> {
        // Delegate to the same validation libcontainer applied before
        // this executor existed (PATH env present, executable resolvable
        // against the spec's PATH). Keeps non-privileged behaviour
        // identical to a stock libcontainer run.
        self.inner.validate(spec)
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

    /// Real-errno coverage for the umount2 errno-classification fix
    /// (PR #568 review comment by nieyy). Inside a non-root process,
    /// `umount2("/proc/sys", MNT_DETACH)` returns `EPERM`, *not*
    /// `EINVAL` — empirically verified on Linux 7.0.0 kernel — so the
    /// privileged exec path hits the "unexpected errno" branch.
    ///
    /// Pre-fix: `let _ = umount2(...)` swallowed EPERM and fell through
    /// to `inner.exec(spec)`, which would `execvp` and produce a much
    /// less useful "/proc/sys read-only" downstream failure (or no
    /// error at all, leaving the privileged contract silently
    /// half-honoured). Post-fix: we surface `ExecutorError::Other`
    /// carrying the path + errno, blocking the exec entirely.
    ///
    /// This test runs as the regular `cargo test` user (non-root), so
    /// it hits the EPERM path naturally without sudo / seccomp setup.
    #[test]
    fn umount2_unexpected_errno_surfaces_as_executor_error() {
        let executor = BoxliteExecutor::new();
        let spec = spec_with_annotation(Some("true"));

        let result = executor.exec(&spec);

        match result {
            Err(ExecutorError::Other(msg)) => {
                assert!(
                    msg.contains("unexpected umount2 errno"),
                    "expected an `unexpected umount2 errno` error, got: {msg}"
                );
                assert!(
                    msg.contains("--privileged"),
                    "error message must explain this is from the privileged \
                     unmount path so the operator can correlate it with \
                     their --privileged invocation; got: {msg}"
                );
                // The path that failed should be one of the OCI default
                // ro/masked paths — anchor on `/proc/` so the test
                // tolerates the iteration order without lock-step.
                assert!(
                    msg.contains("/proc/"),
                    "error message must carry the path that failed for \
                     diagnosability; got: {msg}"
                );
            }
            Err(other) => {
                panic!("expected ExecutorError::Other for unexpected umount2 errno, got {other:?}")
            }
            Ok(()) => panic!(
                "executor must NOT silently succeed when umount2 returns \
                 an unexpected errno; that's exactly the pre-fix bug — \
                 the privileged unmount step was skipped and the box \
                 would have run with stale ro mounts in place"
            ),
        }
    }

    /// Non-privileged specs must not trigger the umount loop at all.
    /// Pre-fix behaviour and post-fix behaviour must be identical here
    /// — the executor delegates straight to `DefaultExecutor::exec`,
    /// which then `execvp`s. We can't easily assert "no umount
    /// happened", but the absence of the `unexpected umount2 errno`
    /// error tells us the loop body was never entered.
    #[test]
    fn umount2_loop_skipped_for_non_privileged_specs() {
        let executor = BoxliteExecutor::new();
        let spec = spec_with_annotation(None);

        let result = executor.exec(&spec);

        if let Err(ExecutorError::Other(msg)) = &result {
            assert!(
                !msg.contains("unexpected umount2 errno"),
                "non-privileged exec must skip the umount loop entirely; \
                 got an unexpected umount-related error: {msg}"
            );
        }
        // `result` may still be Err (libcontainer's DefaultExecutor will
        // try to execvp `/bin/true` and may fail in the test process —
        // that's fine; what we care about is *which* error path was hit,
        // and the unmount-loop path must not have been one of them).
    }
}
