//! LandlockSandbox — Linux filesystem/network restrictions via Landlock LSM.
//!
//! Implements the [`Sandbox`] trait using Landlock for inode-based access control.
//! Landlock doesn't wrap commands — it adds a `pre_exec` hook that applies
//! kernel-enforced filesystem restrictions.
//!
//! Typically composed with [`BwrapSandbox`](super::BwrapSandbox) via
//! [`CompositeSandbox`](super::CompositeSandbox) for layered isolation:
//! - bwrap: what the process can **see** (mount namespace)
//! - Landlock: what the process can **access** (inode-based ACL)

use super::{Sandbox, SandboxContext};
use std::process::Command;

/// Linux sandbox using Landlock LSM for filesystem/network restrictions.
///
/// Degrades gracefully on kernels without Landlock support (< 5.13).
#[derive(Debug)]
pub struct LandlockSandbox;

impl LandlockSandbox {
    pub fn new() -> Self {
        Self
    }
}

impl Default for LandlockSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Sandbox for LandlockSandbox {
    fn is_available(&self) -> bool {
        crate::jailer::landlock::is_landlock_available()
    }

    fn apply(&self, ctx: &SandboxContext, cmd: &mut Command) {
        match crate::jailer::landlock::build_landlock_ruleset(&ctx.paths, ctx.network_enabled) {
            Ok(Some(fd)) => {
                tracing::info!(id = %ctx.id, "Landlock ruleset created (fd={fd})");
                use std::os::unix::process::CommandExt;
                // SAFETY: restrict_self_raw uses only async-signal-safe syscalls:
                // prctl(), syscall(SYS_landlock_restrict_self), close().
                unsafe {
                    cmd.pre_exec(move || {
                        let errno = crate::jailer::landlock::restrict_self_raw(fd);
                        if errno != 0 {
                            return Err(std::io::Error::from_raw_os_error(errno));
                        }
                        Ok(())
                    });
                }
            }
            Ok(None) => {
                tracing::warn!(
                    id = %ctx.id,
                    "Landlock not supported on this kernel, continuing without it"
                );
            }
            Err(e) => {
                tracing::warn!(
                    id = %ctx.id,
                    error = %e,
                    "Landlock ruleset creation failed, continuing without it"
                );
            }
        }
    }

    fn name(&self) -> &'static str {
        "landlock"
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jailer::sandbox::SandboxContext;
    use crate::runtime::advanced_options::ResourceLimits;

    fn test_ctx() -> SandboxContext<'static> {
        let limits = Box::leak(Box::new(ResourceLimits::default()));
        SandboxContext {
            id: "test",
            paths: vec![],
            resource_limits: limits,
            network_enabled: false,
            sandbox_profile: None,
        }
    }

    #[test]
    fn test_landlock_sandbox_name() {
        assert_eq!(LandlockSandbox::new().name(), "landlock");
    }

    #[test]
    fn test_landlock_sandbox_apply_preserves_command() {
        // LandlockSandbox should NOT replace the command — only add pre_exec.
        let sandbox = LandlockSandbox::new();
        let ctx = test_ctx();
        let mut cmd = Command::new("/usr/bin/test-binary");
        cmd.arg("--flag");

        sandbox.apply(&ctx, &mut cmd);

        // Binary and args must be unchanged (Landlock only adds pre_exec).
        assert_eq!(cmd.get_program(), "/usr/bin/test-binary");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, &["--flag"]);
    }
}
