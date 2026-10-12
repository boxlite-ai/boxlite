//! A youki `Executor` that classifies user-command errors at the source.
//!
//! ## Why this exists
//!
//! When `box.exec("nonexistent")` runs, youki's `DefaultExecutor::validate()`
//! rejects it with `ExecutorValidationError::ArgValidationError` (program not
//! found / not executable / no PATH). That error is *typed* — but it dies at
//! youki's own init→main process boundary: `container_intermediate_process.rs`
//! does `exec_failed(err.to_string())`, flattening every init failure into a
//! single `Message::ExecFailed(String)`. By the time `ContainerBuilder::build()`
//! returns to us, the validation error is indistinguishable (same
//! `LibcontainerError` variant) from a genuine platform failure (cgroup, mount,
//! seccomp). The only surviving signal is the message *text*.
//!
//! Rather than string-match youki's volatile wording on the host, we intercept
//! the error *where it is still typed* — inside the container init process,
//! right after `DefaultExecutor::validate()` returns it — and smuggle a single
//! byte out through an fd side-channel that bypasses youki's lossy channel. The
//! zygote reads that byte and tags the build outcome with a typed
//! [`BuildFailureKind`](super::zygote::BuildFailureKind), which then rides our
//! own IPC and proto `reason` token up to the host as `BoxliteError::Execution`.
//!
//! ## fd lifetime
//!
//! `validate()` runs *after* pivot_root but *before* execvp (see the trait doc
//! and youki `init/process.rs`). The write fd is created in the zygote, set
//! `O_CLOEXEC`, and inherited by the clone3'd init child (clone does not honor
//! CLOEXEC — only execve does). So the fd is open during `validate()` and is
//! automatically closed on a successful execvp, never leaking into the user's
//! process.

use std::os::fd::RawFd;

// Use libcontainer's re-exported oci_spec (0.6.x): the guest crate also depends
// on oci_spec 0.9 directly, and the youki `Executor` trait is defined over the
// 0.6 `Spec` — mixing the two is a type error.
use libcontainer::oci_spec::runtime::Spec;
use libcontainer::workload::default::DefaultExecutor;
use libcontainer::workload::{Executor, ExecutorError, ExecutorValidationError};

/// Wraps youki's `DefaultExecutor`, intercepting `validate()` to flag
/// user-command errors over an out-of-band fd. `exec()` / `setup_envs()`
/// delegate unchanged. `Clone` is required because youki clones the executor
/// across the fork boundary (`builder_impl.rs`); `RawFd` is `Copy`, so a derive
/// suffices and the `CloneBoxExecutor` blanket impl handles the trait object.
#[derive(Clone)]
pub(crate) struct ValidatingExecutor {
    /// Write end of the zygote's signal pipe. We hold the raw number only —
    /// the `OwnedFd` lifetime stays in `do_build`, so dropping the (cloned)
    /// executor never closes it.
    fail_fd: RawFd,
}

impl ValidatingExecutor {
    pub(crate) fn new(fail_fd: RawFd) -> Self {
        Self { fail_fd }
    }
}

impl Executor for ValidatingExecutor {
    fn exec(&self, spec: &Spec) -> Result<(), ExecutorError> {
        (DefaultExecutor {}).exec(spec)
    }

    fn validate(&self, spec: &Spec) -> Result<(), ExecutorValidationError> {
        match (DefaultExecutor {}).validate(spec) {
            // The user asked to run something that can't be run. Signal the
            // zygote (best-effort) before propagating youki's typed error, which
            // youki will then stringify over its own channel. The byte — not the
            // string — is what the host's 422 classification keys on.
            Err(err @ ExecutorValidationError::ArgValidationError(_)) => {
                let byte = [1u8];
                // SAFETY: fail_fd is the inherited write end of the zygote's
                // pipe, open until execvp (CLOEXEC). A failed/partial write only
                // costs us the typed classification (falls back to 500), never
                // correctness, so the result is intentionally ignored.
                let _ = unsafe {
                    nix::libc::write(self.fail_fd, byte.as_ptr() as *const nix::libc::c_void, 1)
                };
                Err(err)
            }
            other => other,
        }
    }

    // setup_envs() uses the trait's default implementation (reset env from spec).
}
