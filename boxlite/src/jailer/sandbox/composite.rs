//! CompositeSandbox — chains multiple sandboxes for layered isolation.
//!
//! Each child sandbox's [`apply()`](super::Sandbox::apply) is called in order
//! on the same `Command`. Typical composition on Linux:
//!
//! 1. [`BwrapSandbox`](super::BwrapSandbox) — replaces command with bwrap wrapper
//! 2. [`LandlockSandbox`](super::LandlockSandbox) — adds Landlock pre_exec hook
//!
//! Multiple `pre_exec` hooks are safe — `Command` stores them in a `Vec`,
//! executed in registration order.

use super::{Sandbox, SandboxContext};
use boxlite_shared::errors::BoxliteResult;
use std::process::Command;

/// Sandbox that chains multiple sandbox implementations.
///
/// Each child's `apply()` is called in order on the same `Command`.
/// The first child typically wraps the command (bwrap replaces it),
/// subsequent children add restrictions (Landlock adds pre_exec hooks).
pub struct CompositeSandbox {
    sandboxes: Vec<Box<dyn Sandbox>>,
    name: &'static str,
}

impl std::fmt::Debug for CompositeSandbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompositeSandbox")
            .field("name", &self.name)
            .field("count", &self.sandboxes.len())
            .finish()
    }
}

impl CompositeSandbox {
    /// Create a composite sandbox from a list of child sandboxes.
    ///
    /// Children are applied in order — put wrapping sandboxes first,
    /// restriction sandboxes second.
    pub fn new(sandboxes: Vec<Box<dyn Sandbox>>) -> Self {
        let name = sandboxes
            .iter()
            .map(|s| s.name())
            .collect::<Vec<_>>()
            .join("+");
        // Leak the name string — one-time allocation, lives for process lifetime.
        let name: &'static str = Box::leak(name.into_boxed_str());
        Self { sandboxes, name }
    }
}

impl Sandbox for CompositeSandbox {
    fn is_available(&self) -> bool {
        self.sandboxes.first().is_some_and(|s| s.is_available())
    }

    fn setup(&self, ctx: &SandboxContext) -> BoxliteResult<()> {
        for s in &self.sandboxes {
            s.setup(ctx)?;
        }
        Ok(())
    }

    fn apply(&self, ctx: &SandboxContext, cmd: &mut Command) {
        for child in &self.sandboxes {
            if child.is_available() {
                child.apply(ctx, cmd);
            }
        }
    }

    fn name(&self) -> &'static str {
        self.name
    }
}

// ============================================================================
// Platform-specific constructors
// ============================================================================

// On Linux, PlatformSandbox = CompositeSandbox. The builder calls PlatformSandbox::new(),
// so we provide a no-arg constructor that assembles the default Linux sandbox stack.
#[cfg(target_os = "linux")]
impl CompositeSandbox {
    /// Create the default Linux sandbox: bwrap (namespaces) + Landlock (filesystem ACL).
    ///
    /// This is called by [`JailerBuilder::build()`] via the `PlatformSandbox::new()` alias.
    pub fn platform_new() -> Self {
        Self::new(vec![
            Box::new(super::BwrapSandbox::new()),
            Box::new(super::LandlockSandbox::new()),
        ])
    }
}

// macOS doesn't use CompositeSandbox as PlatformSandbox.
#[cfg(not(target_os = "linux"))]
impl CompositeSandbox {
    /// No-arg constructor for non-Linux platforms (empty composite).
    pub fn platform_new() -> Self {
        Self::new(vec![])
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jailer::sandbox::{NoopSandbox, SandboxContext};
    use crate::runtime::advanced_options::ResourceLimits;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn test_ctx() -> SandboxContext<'static> {
        // Leak a ResourceLimits so we can return a 'static SandboxContext.
        let limits = Box::leak(Box::new(ResourceLimits::default()));
        SandboxContext {
            id: "test",
            paths: vec![],
            resource_limits: limits,
            network_enabled: false,
            sandbox_profile: None,
        }
    }

    /// Mock sandbox that tracks calls.
    #[derive(Debug)]
    struct MockSandbox {
        available: bool,
        setup_called: Arc<AtomicBool>,
        apply_called: Arc<AtomicBool>,
        apply_order: Arc<AtomicUsize>,
        order_counter: Arc<AtomicUsize>,
        sandbox_name: &'static str,
    }

    impl MockSandbox {
        fn new(name: &'static str, available: bool, counter: Arc<AtomicUsize>) -> Self {
            Self {
                available,
                setup_called: Arc::new(AtomicBool::new(false)),
                apply_called: Arc::new(AtomicBool::new(false)),
                apply_order: Arc::new(AtomicUsize::new(0)),
                order_counter: counter,
                sandbox_name: name,
            }
        }
    }

    impl Sandbox for MockSandbox {
        fn is_available(&self) -> bool {
            self.available
        }
        fn setup(&self, _ctx: &SandboxContext) -> BoxliteResult<()> {
            self.setup_called.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn apply(&self, _ctx: &SandboxContext, _cmd: &mut Command) {
            self.apply_called.store(true, Ordering::SeqCst);
            let order = self.order_counter.fetch_add(1, Ordering::SeqCst);
            self.apply_order.store(order, Ordering::SeqCst);
        }
        fn name(&self) -> &'static str {
            self.sandbox_name
        }
    }

    #[test]
    fn test_composite_name_joined() {
        let composite = CompositeSandbox::new(vec![
            Box::new(NoopSandbox::new()),
            Box::new(NoopSandbox::new()),
        ]);
        assert_eq!(composite.name(), "noop+noop");
    }

    #[test]
    fn test_composite_is_available_follows_first() {
        let counter = Arc::new(AtomicUsize::new(0));
        let composite = CompositeSandbox::new(vec![
            Box::new(MockSandbox::new("first", true, counter.clone())),
            Box::new(MockSandbox::new("second", false, counter)),
        ]);
        assert!(composite.is_available());

        let counter2 = Arc::new(AtomicUsize::new(0));
        let composite2 = CompositeSandbox::new(vec![
            Box::new(MockSandbox::new("first", false, counter2.clone())),
            Box::new(MockSandbox::new("second", true, counter2)),
        ]);
        assert!(!composite2.is_available());
    }

    #[test]
    fn test_composite_setup_calls_all() {
        let counter = Arc::new(AtomicUsize::new(0));
        let s1 = MockSandbox::new("a", true, counter.clone());
        let s2 = MockSandbox::new("b", true, counter);
        let s1_setup = s1.setup_called.clone();
        let s2_setup = s2.setup_called.clone();

        let composite = CompositeSandbox::new(vec![Box::new(s1), Box::new(s2)]);
        let ctx = test_ctx();
        composite.setup(&ctx).unwrap();

        assert!(
            s1_setup.load(Ordering::SeqCst),
            "first sandbox setup called"
        );
        assert!(
            s2_setup.load(Ordering::SeqCst),
            "second sandbox setup called"
        );
    }

    #[test]
    fn test_composite_apply_chains_in_order() {
        let counter = Arc::new(AtomicUsize::new(0));
        let s1 = MockSandbox::new("first", true, counter.clone());
        let s2 = MockSandbox::new("second", true, counter);
        let s1_order = s1.apply_order.clone();
        let s2_order = s2.apply_order.clone();

        let composite = CompositeSandbox::new(vec![Box::new(s1), Box::new(s2)]);
        let ctx = test_ctx();
        let mut cmd = Command::new("/bin/echo");
        composite.apply(&ctx, &mut cmd);

        assert_eq!(s1_order.load(Ordering::SeqCst), 0, "first applied first");
        assert_eq!(s2_order.load(Ordering::SeqCst), 1, "second applied second");
    }

    #[test]
    fn test_composite_apply_skips_unavailable() {
        let counter = Arc::new(AtomicUsize::new(0));
        let s1 = MockSandbox::new("available", true, counter.clone());
        let s2 = MockSandbox::new("unavailable", false, counter);
        let s1_applied = s1.apply_called.clone();
        let s2_applied = s2.apply_called.clone();

        let composite = CompositeSandbox::new(vec![Box::new(s1), Box::new(s2)]);
        let ctx = test_ctx();
        let mut cmd = Command::new("/bin/echo");
        composite.apply(&ctx, &mut cmd);

        assert!(
            s1_applied.load(Ordering::SeqCst),
            "available sandbox applied"
        );
        assert!(
            !s2_applied.load(Ordering::SeqCst),
            "unavailable sandbox skipped"
        );
    }

    #[test]
    fn test_composite_empty_sandboxes() {
        let composite = CompositeSandbox::new(vec![]);
        assert!(!composite.is_available());
        assert_eq!(composite.name(), "");

        let ctx = test_ctx();
        composite.setup(&ctx).unwrap();
        let mut cmd = Command::new("/bin/echo");
        composite.apply(&ctx, &mut cmd);
        // Should not panic
    }
}
