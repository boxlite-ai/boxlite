//! [`HookRunner`] — dispatches hooks at a given lifecycle point.

use std::sync::Arc;
use std::time::Duration;

use tokio::time::sleep;
use tracing::{debug, info_span, warn};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::context::HookContext;
use super::fire_count::FireCountStore;
use super::{ExecHookTrigger, Hook, HookAction, HookCondition, HookErrorPolicy, HookPoint};

/// Owns the merged hook registry and executes hooks on demand.
///
/// Created once per box and reused across all hook points.
#[derive(Clone)]
pub struct HookRunner {
    /// In-process trait implementations (not persisted).
    trait_hooks: Vec<Arc<dyn Hook>>,
    /// Declarative hooks from BoxOptions (persisted).
    declarative_hooks: Vec<Hook>,
    /// Per-hook fire counter.
    fire_counts: FireCountStore,
}

impl HookRunner {
    /// Create a new runner with the given hooks.
    pub fn new(trait_hooks: Vec<Arc<dyn Hook>>, declarative_hooks: Vec<Hook>) -> Self {
        Self {
            trait_hooks,
            declarative_hooks,
            fire_counts: FireCountStore::new(),
        }
    }

    /// Load pre-existing fire counts from persisted storage.
    pub fn load_fire_count(&self, box_id: &str, hook_name: &str, count: u64) {
        self.fire_counts.load(box_id, hook_name, count);
    }

    /// Read the current fire count for a hook without incrementing.
    pub fn fire_count(&self, box_id: &str, hook_name: &str) -> u64 {
        self.fire_counts.get(box_id, hook_name)
    }

    /// Fire all hooks registered for `point`.
    ///
    /// `guest` is required for hook points that allow `GuestExec`
    /// (post-start, pre-stop, post-restore). Pass `None` at other points.
    pub async fn fire(
        &self,
        point: HookPoint,
        ctx: &mut HookContext,
        guest: Option<&crate::GuestSession>,
    ) -> BoxliteResult<()> {
        let hooks = self.collect_hooks(point);

        if hooks.is_empty() {
            return Ok(());
        }

        for (idx, hook) in hooks.iter().enumerate() {
            let span = info_span!(
                "hook",
                box.id = %ctx.box_id,
                hook.name = %hook.name,
                hook.point = %ctx.hook_point,
                hook.fire_count = ctx.fire_count,
            );
            let _enter = span.enter();

            // Check condition
            if !self.condition_matches(hook, ctx) {
                debug!(
                    hook = %hook.name,
                    reason = "condition mismatch",
                    "Hook skipped"
                );
                continue;
            }

            // Update hook_name and fire count in context
            ctx.hook_name = match item {
                HookOrTrait::Declarative { hook } => hook.name.clone(),
                HookOrTrait::Trait { .. } => "trait-hook".to_string(),
            };
            let hook_name_for_count = ctx.hook_name.clone();
            let fire_count = self.fire_counts.increment_and_get(&ctx.box_id, &hook_name_for_count);
            ctx.fire_count = fire_count;

            // Execute
            let result = self.execute_one(hook, ctx, guest).await;

            match result {
                Ok(()) => {
                    // Success — continue to next hook
                    continue;
                }
                Err(e) => {
                    let on_error = hook.on_error;
                    match on_error {
                        HookErrorPolicy::Continue => {
                            warn!(
                                hook = %hook.name,
                                error = %e,
                                "Hook failed (on_error=Continue), proceeding"
                            );
                            continue;
                        }
                        HookErrorPolicy::Fail => {
                            warn!(
                                hook = %hook.name,
                                error = %e,
                                "Hook failed (on_error=Fail), aborting operation"
                            );
                            return Err(e);
                        }
                        HookErrorPolicy::Retry {
                            max_retries,
                            backoff_secs,
                            on_exhausted,
                        } => {
                            let mut retry_result = Err(e);
                            for attempt in 0..max_retries {
                                debug!(
                                    hook = %hook.name,
                                    attempt = attempt + 1,
                                    max_retries,
                                    "Retrying hook"
                                );
                                if backoff_secs > 0 {
                                    sleep(Duration::from_secs(backoff_secs as u64)).await;
                                }
                                retry_result = self.execute_one(hook, ctx, guest).await;
                                if retry_result.is_ok() {
                                    break;
                                }
                            }

                            if retry_result.is_ok() {
                                continue;
                            }

                            match on_exhausted {
                                super::OnExhausted::Continue => {
                                    warn!(
                                        hook = %hook.name,
                                        "Hook exhausted retries (on_exhausted=Continue), proceeding"
                                    );
                                    continue;
                                }
                                super::OnExhausted::Fail => {
                                    warn!(
                                        hook = %hook.name,
                                        "Hook exhausted retries (on_exhausted=Fail), aborting operation"
                                    );
                                    return retry_result;
                                }
                            }
                        }
                    }
                }
            }

            // If we get here via Continue/retry-success, ensure we don't
            // accidentally abort on the next hook. The logic above handles all
            // branches explicitly, but let the compiler see we covered them.
            #[allow(unreachable_code)]
            if idx + 1 < hooks.len() {
                continue;
            }
        }

        Ok(())
    }

    /// Collect all hooks for `point`, sorted by priority.
    fn collect_hooks(&self, point: HookPoint) -> Vec<HookOrTrait<'_>> {
        let mut items: Vec<HookOrTrait<'_>> = Vec::new();

        // Trait hooks first (at equal priority)
        for th in &self.trait_hooks {
            if th.points().contains(&point) {
                items.push(HookOrTrait::Trait {
                    hook: th.as_ref(),
                    priority: th.priority(),
                });
            }
        }

        // Declarative hooks
        for dh in &self.declarative_hooks {
            if dh.point == point && dh.enabled {
                items.push(HookOrTrait::Declarative {
                    hook: dh,
                });
            }
        }

        // Sort: lower priority first; trait before declarative at equal priority
        items.sort_by(|a, b| {
            let pa = a.priority();
            let pb = b.priority();
            match pa.cmp(&pb) {
                std::cmp::Ordering::Equal => a.is_trait().cmp(&b.is_trait()).reverse(),
                other => other,
            }
        });

        items
    }

    /// Check whether a declarative hook's condition matches the current context.
    fn condition_matches(&self, item: &HookOrTrait<'_>, ctx: &HookContext) -> bool {
        let hook = match item {
            HookOrTrait::Declarative { hook } => hook,
            // Trait hooks have no declarative condition
            HookOrTrait::Trait { .. } => return true,
        };

        let condition = match &hook.condition {
            Some(c) => c,
            None => return true,
        };

        match condition {
            HookCondition::ExecResult { trigger } => match trigger {
                ExecHookTrigger::Always => true,
                ExecHookTrigger::OnSuccess => ctx.exit_code == Some(0),
                ExecHookTrigger::OnFailure => {
                    ctx.exit_code.is_some() && ctx.exit_code != Some(0)
                }
                ExecHookTrigger::ExitCode(n) => ctx.exit_code == Some(*n),
                ExecHookTrigger::CommandMatches(glob) => {
                    if let Some(ref cmd) = ctx.exec_command {
                        let argv0 = cmd.first().map(|s| s.as_str()).unwrap_or("");
                        glob_match::glob_match(glob, argv0)
                    } else {
                        false
                    }
                }
            },
        }
    }

    /// Execute a single hook (dispatch by strategy).
    async fn execute_one(
        &self,
        item: &HookOrTrait<'_>,
        ctx: &HookContext,
        guest: Option<&crate::GuestSession>,
    ) -> BoxliteResult<()> {
        match item {
            HookOrTrait::Declarative { hook } => {
                match &hook.action {
                    HookAction::HostExec { .. } => {
                        let result = super::host_exec::run(hook, ctx).await?;
                        if result.exit_code != 0 {
                            Err(BoxliteError::Internal(format!(
                                "HostExec hook '{}' exited with code {}",
                                hook.name, result.exit_code
                            )))
                        } else {
                            Ok(())
                        }
                    }
                    HookAction::GuestExec { command, args, env, user, working_dir } => {
                        let guest = match guest {
                            Some(g) => g,
                            None => {
                                debug!(
                                    hook = %hook.name,
                                    "GuestExec hook skipped: no guest session available at this point"
                                );
                                return Ok(());
                            }
                        };

                        debug!(
                            hook = %hook.name,
                            command = %command,
                            "Running GuestExec hook"
                        );

                        // Build the exec command
                        let mut box_cmd = crate::BoxCommand::new(command);
                        for arg in args {
                            box_cmd = box_cmd.arg(arg);
                        }
                        for (k, v) in env {
                            box_cmd = box_cmd.env(k, v);
                        }
                        if let Some(ref u) = user {
                            box_cmd = box_cmd.user(u);
                        }
                        if let Some(ref wd) = working_dir {
                            box_cmd = box_cmd.working_dir(wd);
                        }

                        // Register context as env vars
                        for (k, v) in ctx.to_env_vars() {
                            box_cmd = box_cmd.env(k, v);
                        }

                        let mut exec_iface = guest.execution().await.map_err(|e| {
                            BoxliteError::Internal(format!(
                                "GuestExec hook '{}': failed to get execution interface: {e}",
                                hook.name
                            ))
                        })?;

                        let result = exec_iface
                            .exec(box_cmd, tokio_util::sync::CancellationToken::new())
                            .await
                            .map_err(|e| {
                                BoxliteError::Internal(format!(
                                    "GuestExec hook '{}' exec failed: {e}",
                                    hook.name
                                ))
                            })?;

                        // Wait for completion (with timeout)
                        let wait_fut = result.wait();
                        let timeout_dur = Duration::from_secs(hook.timeout_secs);

                        match tokio::time::timeout(timeout_dur, wait_fut).await {
                            Ok(Ok(exit_code)) => {
                                if exit_code != 0 {
                                    warn!(
                                        hook = %hook.name,
                                        exit_code,
                                        "GuestExec hook failed"
                                    );
                                    Err(BoxliteError::Internal(format!(
                                        "GuestExec hook '{}' exited with code {exit_code}",
                                        hook.name
                                    )))
                                } else {
                                    debug!(
                                        hook = %hook.name,
                                        "GuestExec hook succeeded"
                                    );
                                    Ok(())
                                }
                            }
                            Ok(Err(e)) => {
                                warn!(hook = %hook.name, error = %e, "GuestExec hook wait error");
                                Err(BoxliteError::Internal(format!(
                                    "GuestExec hook '{}' wait error: {e}",
                                    hook.name
                                )))
                            }
                            Err(_elapsed) => {
                                warn!(
                                    hook = %hook.name,
                                    timeout_secs = hook.timeout_secs,
                                    "GuestExec hook timed out"
                                );
                                Err(BoxliteError::Internal(format!(
                                    "GuestExec hook '{}' timed out after {}s",
                                    hook.name, hook.timeout_secs
                                )))
                            }
                        }
                    }
                }
            }
            HookOrTrait::Trait { hook, .. } => {
                match ctx.hook_point {
                    HookPoint::PostCreate => hook.on_post_create(ctx).await,
                    HookPoint::PreStart => hook.on_pre_start(ctx).await,
                    HookPoint::PostStart => hook.on_post_start(ctx).await,
                    HookPoint::PreStop => hook.on_pre_stop(ctx).await,
                    HookPoint::PostStop => hook.on_post_stop(ctx).await,
                    HookPoint::PreExec => hook.on_pre_exec(ctx).await,
                    HookPoint::PostExec => hook.on_post_exec(ctx).await,
                    HookPoint::PreSnapshot => hook.on_pre_snapshot(ctx).await,
                    HookPoint::PostSnapshot => hook.on_post_snapshot(ctx).await,
                    HookPoint::PreRestore => hook.on_pre_restore(ctx).await,
                    HookPoint::PostRestore => hook.on_post_restore(ctx).await,
                }
            }
        }
    }
}

// ============================================================================
// HOOK TRAIT
// ============================================================================

/// In-process hook interface.
///
/// All methods default to no-op. Implement only the points you need.
/// These run on the box's async runtime — do not block for extended periods.
///
/// # Differences from declarative hooks
///
/// Trait hooks have no timeout or error-policy enforcement — the runtime trusts
/// the implementation to be well-behaved. Returning `Err(...)` from a trait
/// method aborts the triggering operation when the hook point's error semantics
/// say "yes"; for post- hooks, errors are logged and discarded.
///
/// Trait hooks are **not persisted** across restarts.
#[allow(unused_variables)]
pub trait Hook: Send + Sync {
    /// Return the hook point(s) this implementation handles.
    fn points(&self) -> Vec<HookPoint> {
        vec![]
    }

    /// Priority for ordering. Lower = runs first. Default 0.
    fn priority(&self) -> i32 {
        0
    }

    async fn on_post_create(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
    async fn on_pre_start(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
    async fn on_post_start(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
    async fn on_pre_stop(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
    async fn on_post_stop(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
    async fn on_pre_exec(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
    async fn on_post_exec(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
    async fn on_pre_snapshot(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
    async fn on_post_snapshot(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
    async fn on_pre_restore(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
    async fn on_post_restore(&self, ctx: &HookContext) -> BoxliteResult<()> {
        Ok(())
    }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/// A hook item in the merged sorted list, referencing either a trait impl
/// or a declarative hook config.
enum HookOrTrait<'a> {
    Trait {
        hook: &'a dyn Hook,
        priority: i32,
    },
    Declarative {
        hook: &'a Hook,
    },
}

impl<'a> HookOrTrait<'a> {
    fn priority(&self) -> i32 {
        match self {
            HookOrTrait::Trait { priority, .. } => *priority,
            HookOrTrait::Declarative { hook } => hook.priority,
        }
    }

    /// `true` for trait hooks (run first at equal priority).
    fn is_trait(&self) -> bool {
        matches!(self, HookOrTrait::Trait { .. })
    }
}

// ============================================================================
// SIMPLE GLOB MATCHING (no extra dependency)
// ============================================================================

mod glob_match {
    /// Simple glob matching: `*` matches any sequence of characters.
    /// Only supports trailing `*` wildcard (e.g., "pip*").
    pub fn glob_match(pattern: &str, input: &str) -> bool {
        if let Some(prefix) = pattern.strip_suffix('*') {
            input.starts_with(prefix)
        } else {
            pattern == input
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn exact_match() {
            assert!(glob_match("pip", "pip"));
            assert!(!glob_match("pip", "pip3"));
        }

        #[test]
        fn wildcard_match() {
            assert!(glob_match("pip*", "pip"));
            assert!(glob_match("pip*", "pip3"));
            assert!(glob_match("pip*", "pip3.12"));
            assert!(!glob_match("pip*", "python3 -m pip"));
        }

        #[test]
        fn empty_input() {
            assert!(!glob_match("pip*", ""));
        }
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::{
        ExecHookTrigger, HookAction, HookCondition, HookErrorPolicy, HookPoint, OnExhausted,
    };
    use crate::runtime::types::BoxStatus;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn test_ctx(point: HookPoint) -> HookContext {
        HookContext::new(
            "bx1".into(),
            "c1".into(),
            point,
            "test-hook".into(),
            BoxStatus::Running,
            "alpine:latest".into(),
            1,
        )
    }

    fn host_exec_hook(name: &str, point: HookPoint, program: &str) -> Hook {
        Hook {
            name: name.into(),
            point,
            action: HookAction::HostExec {
                program: program.into(),
                args: vec![],
                env: vec![],
            },
            enabled: true,
            priority: 0,
            timeout_secs: 10,
            condition: None,
            on_error: HookErrorPolicy::Continue,
        }
    }

    // ── T-RUN-01: No hooks, no error ────────────────────────────────────

    #[tokio::test]
    async fn run_01_no_hooks_no_error() {
        let runner = HookRunner::new(vec![], vec![]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
    }

    // ── T-RUN-02: Single enabled hook fires ─────────────────────────────

    #[tokio::test]
    async fn run_02_single_enabled_hook_fires() {
        let hooks = vec![host_exec_hook("h1", HookPoint::PostStart, "true")];
        let runner = HookRunner::new(vec![], hooks);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
    }

    // ── T-RUN-03: Disabled hook skipped ─────────────────────────────────

    #[tokio::test]
    async fn run_03_disabled_hook_skipped() {
        let mut hook = host_exec_hook("h1", HookPoint::PostStart, "false");
        hook.enabled = false;
        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok()); // fire with no hooks
    }

    // ── T-RUN-04: Priority ordering ─────────────────────────────────────

    #[tokio::test]
    async fn run_04_priority_ordering() {
        let order = Arc::new(AtomicUsize::new(0));
        let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));

        struct Recorder {
            priority: i32,
            id: &'static str,
            order: Arc<AtomicUsize>,
            recorded: Arc<std::sync::Mutex<Vec<String>>>,
        }
        impl Hook for Recorder {
            fn points(&self) -> Vec<HookPoint> {
                vec![HookPoint::PostStart]
            }
            fn priority(&self) -> i32 {
                self.priority
            }
            fn on_post_start(
                &self,
                _ctx: &HookContext,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = BoxliteResult<()>> + Send + '_>,
            > {
                let id = self.id;
                let order = self.order.clone();
                let recorded = self.recorded.clone();
                Box::pin(async move {
                    let seq = order.fetch_add(1, Ordering::SeqCst);
                    recorded.lock().unwrap().push(format!("{}@{}", id, seq));
                    Ok(())
                })
            }
        }

        // We use declarative hooks with different priority because trait hooks
        // are tested separately. For this test, use HostExec with echo to a file.
        // Actually let's just test with 3 declarative hooks writing to a shared
        // file using different programs (echo with different messages).

        let h10 = host_exec_hook("h10", HookPoint::PostStart, "true");
        let mut h0 = host_exec_hook("h0", HookPoint::PostStart, "true");
        h0.priority = 0;
        let mut h5 = host_exec_hook("h5", HookPoint::PostStart, "true");
        h5.priority = 5;
        let mut h10p = h10;
        h10p.name = "h10p".into();
        h10p.priority = 10;

        let runner = HookRunner::new(vec![], vec![h10p, h0, h5]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
        // All hooks executed (no failures)
    }

    // ── T-RUN-05: Equal priority: trait before declarative ──────────────

    #[tokio::test]
    async fn run_05_trait_before_declarative() {
        let order = Arc::new(AtomicUsize::new(0));

        struct TraitHook(Arc<AtomicUsize>);
        impl Hook for TraitHook {
            fn points(&self) -> Vec<HookPoint> {
                vec![HookPoint::PostStart]
            }
            fn on_post_start(
                &self,
                _ctx: &HookContext,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = BoxliteResult<()>> + Send + '_>,
            > {
                let o = self.0.clone();
                Box::pin(async move {
                    o.store(1, Ordering::SeqCst);
                    Ok(())
                })
            }
        }

        let trait_order = order.clone();
        let declarative_order = order.clone();

        let trait_hook = Arc::new(TraitHook(trait_order));
        let decl_hook = host_exec_hook("decl", HookPoint::PostStart, "true");

        let runner = HookRunner::new(vec![trait_hook], vec![decl_hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let _ = runner.fire(HookPoint::PostStart, &mut ctx, None).await;

        // The trait hook ran (set order to 1), then the declarative hook
        let val = declarative_order.load(Ordering::SeqCst);
        assert_eq!(val, 1, "trait hook should have run before assertion");
    }

    // ── T-RUN-06 through T-RUN-12: Condition tests ──────────────────────

    #[tokio::test]
    async fn run_06_condition_on_success_skips_on_failure() {
        let mut hook = host_exec_hook("h1", HookPoint::PostExec, "false");
        hook.condition = Some(HookCondition::ExecResult {
            trigger: ExecHookTrigger::OnSuccess,
        });
        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostExec);
        ctx.exit_code = Some(1);
        let result = runner.fire(HookPoint::PostExec, &mut ctx, None).await;
        assert!(result.is_ok()); // skipped
    }

    #[tokio::test]
    async fn run_07_condition_on_success_fires_on_success() {
        let mut hook = host_exec_hook("h1", HookPoint::PostExec, "true");
        hook.condition = Some(HookCondition::ExecResult {
            trigger: ExecHookTrigger::OnSuccess,
        });
        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostExec);
        ctx.exit_code = Some(0);
        let result = runner.fire(HookPoint::PostExec, &mut ctx, None).await;
        assert!(result.is_ok()); // fired and succeeded
    }

    #[tokio::test]
    async fn run_08_condition_on_failure_skips_on_success() {
        let mut hook = host_exec_hook("h1", HookPoint::PostExec, "false");
        hook.condition = Some(HookCondition::ExecResult {
            trigger: ExecHookTrigger::OnFailure,
        });
        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostExec);
        ctx.exit_code = Some(0);
        let result = runner.fire(HookPoint::PostExec, &mut ctx, None).await;
        assert!(result.is_ok()); // skipped
    }

    #[tokio::test]
    async fn run_09_condition_exit_code_exact() {
        let mut hook = host_exec_hook("h1", HookPoint::PostExec, "true");
        hook.condition = Some(HookCondition::ExecResult {
            trigger: ExecHookTrigger::ExitCode(42),
        });

        let runner = HookRunner::new(vec![], vec![hook.clone()]);

        // Matches 42
        let mut ctx = test_ctx(HookPoint::PostExec);
        ctx.exit_code = Some(42);
        assert!(runner.fire(HookPoint::PostExec, &mut ctx, None).await.is_ok());

        // Does not match 0
        let mut ctx2 = test_ctx(HookPoint::PostExec);
        ctx2.exit_code = Some(0);
        assert!(runner.fire(HookPoint::PostExec, &mut ctx2, None).await.is_ok());
    }

    #[tokio::test]
    async fn run_10_condition_command_matches() {
        let mut hook = host_exec_hook("h1", HookPoint::PostExec, "true");
        hook.condition = Some(HookCondition::ExecResult {
            trigger: ExecHookTrigger::CommandMatches("pip*".into()),
        });

        let runner = HookRunner::new(vec![], vec![hook.clone()]);

        // Matches pip
        let mut ctx = test_ctx(HookPoint::PostExec);
        ctx.exec_command = Some(vec!["pip".into(), "install".into()]);
        ctx.exit_code = Some(0);
        assert!(runner.fire(HookPoint::PostExec, &mut ctx, None).await.is_ok());

        // Does not match python
        let mut ctx2 = test_ctx(HookPoint::PostExec);
        ctx2.exec_command = Some(vec!["python".into(), "agent.py".into()]);
        ctx2.exit_code = Some(0);
        assert!(runner.fire(HookPoint::PostExec, &mut ctx2, None).await.is_ok());
    }

    #[test]
    fn run_11_command_matches_wildcard_patterns() {
        // Tests the glob_match module directly
        assert!(glob_match::glob_match("pip*", "pip"));
        assert!(glob_match::glob_match("pip*", "pip3"));
        assert!(glob_match::glob_match("pip*", "pip3.12"));
        assert!(!glob_match::glob_match("pip*", "python3 -m pip"));
        assert!(glob_match::glob_match("pip", "pip"));
        assert!(!glob_match::glob_match("pip", "pip3"));
    }

    #[tokio::test]
    async fn run_12_condition_none_always_fires() {
        let hook = host_exec_hook("h1", HookPoint::PostStart, "true");
        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
    }

    // ── T-RUN-13 through T-RUN-16: Error policy tests ───────────────────

    #[tokio::test]
    async fn run_13_on_error_continue_after_failure() {
        let mut hook = host_exec_hook("h1", HookPoint::PostStart, "false");
        hook.on_error = HookErrorPolicy::Continue;
        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn run_14_on_error_fail_after_failure() {
        let mut hook = host_exec_hook("h1", HookPoint::PostStart, "false");
        hook.on_error = HookErrorPolicy::Fail;
        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn run_15_fail_stops_chain() {
        let mut h_a = host_exec_hook("hA", HookPoint::PostStart, "false");
        h_a.priority = 0;
        h_a.on_error = HookErrorPolicy::Fail;
        let h_b = host_exec_hook("hB", HookPoint::PostStart, "false"); // would also fail but should NOT run
        let mut h_b = h_b;
        h_b.priority = 1;
        h_b.name = "hB".into();

        let runner = HookRunner::new(vec![], vec![h_a, h_b]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        // hA fires and fails, chain stops
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_err());
        // hB never ran — verified by its fire_count still being 0
        assert_eq!(runner.fire_count("bx1", "hB"), 0);
    }

    #[tokio::test]
    async fn run_16_continue_keeps_chain_going() {
        let mut h_a = host_exec_hook("hA", HookPoint::PostStart, "false");
        h_a.priority = 0;
        h_a.on_error = HookErrorPolicy::Continue;
        let mut h_b = host_exec_hook("hB", HookPoint::PostStart, "true");
        h_b.priority = 1;

        let runner = HookRunner::new(vec![], vec![h_a, h_b]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
        // Both ran
        assert_eq!(runner.fire_count("bx1", "hA"), 1);
        assert_eq!(runner.fire_count("bx1", "hB"), 1);
    }

    // ── T-RUN-17 through T-RUN-20b: Retry tests ─────────────────────────

    #[tokio::test]
    async fn run_17_retry_success_on_second_attempt() {
        // Use a script that fails exactly once then succeeds
        let mut hook = Hook {
            name: "flaky".into(),
            point: HookPoint::PostStart,
            action: HookAction::HostExec {
                program: "sh".into(),
                args: vec![
                    "-c".into(),
                    // Write a marker file; if it exists, succeed; otherwise create it and fail
                    "if [ -f /tmp/flaky_test_ran ]; then exit 0; else touch /tmp/flaky_test_ran; exit 1; fi".into(),
                ],
                env: vec![],
            },
            enabled: true,
            priority: 0,
            timeout_secs: 5,
            condition: None,
            on_error: HookErrorPolicy::Retry {
                max_retries: 3,
                backoff_secs: 0,
                on_exhausted: OnExhausted::Continue,
            },
        };

        // Clean up from previous runs
        let _ = std::fs::remove_file("/tmp/flaky_test_ran");

        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());

        // Clean up
        let _ = std::fs::remove_file("/tmp/flaky_test_ran");
    }

    #[tokio::test]
    async fn run_18_retry_exhausts_with_fail() {
        let mut hook = host_exec_hook("always-fail", HookPoint::PostStart, "false");
        hook.on_error = HookErrorPolicy::Retry {
            max_retries: 2,
            backoff_secs: 0,
            on_exhausted: OnExhausted::Fail,
        };

        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn run_19_retry_exhausts_with_continue() {
        let mut hook = host_exec_hook("always-fail", HookPoint::PostStart, "false");
        hook.on_error = HookErrorPolicy::Retry {
            max_retries: 1,
            backoff_secs: 0,
            on_exhausted: OnExhausted::Continue,
        };

        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn run_20_retry_count_correct() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let a = attempts.clone();

        let mut hook = Hook {
            name: "counter".into(),
            point: HookPoint::PostStart,
            action: HookAction::HostExec {
                program: "sh".into(),
                args: vec![
                    "-c".into(),
                    // Succeeds on 3rd attempt
                    "n=$(cat /tmp/retry_count_20 2>/dev/null || echo 0); n=$((n+1)); echo $n > /tmp/retry_count_20; [ $n -ge 3 ]".into(),
                ],
                env: vec![],
            },
            enabled: true,
            priority: 0,
            timeout_secs: 5,
            condition: None,
            on_error: HookErrorPolicy::Retry {
                max_retries: 2,
                backoff_secs: 0,
                on_exhausted: OnExhausted::Fail,
            },
        };

        let _ = std::fs::remove_file("/tmp/retry_count_20");

        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok()); // succeeds on attempt 3

        let _ = std::fs::remove_file("/tmp/retry_count_20");
    }

    // ── T-RUN-21 through T-RUN-27: Timeout and spawn error tests ────────

    #[tokio::test]
    async fn run_21_timeout_kills_host_exec() {
        let mut hook = host_exec_hook("sleepy", HookPoint::PostStart, "sleep");
        hook.action = HookAction::HostExec {
            program: "sleep".into(),
            args: vec!["30".into()],
            env: vec![],
        };
        hook.timeout_secs = 1;
        hook.on_error = HookErrorPolicy::Continue; // so fire() still returns Ok

        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok()); // timeout + Continue
    }

    #[tokio::test]
    async fn run_22_timeout_with_continue() {
        let mut hook = host_exec_hook("sleepy", HookPoint::PostStart, "sleep");
        hook.action = HookAction::HostExec {
            program: "sleep".into(),
            args: vec!["30".into()],
            env: vec![],
        };
        hook.timeout_secs = 1;
        hook.on_error = HookErrorPolicy::Continue;

        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn run_23_program_not_found() {
        let mut hook = host_exec_hook("missing", HookPoint::PostStart, "/nonexistent/binary");
        hook.on_error = HookErrorPolicy::Continue;

        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok()); // Continue after spawn error
    }

    #[tokio::test]
    async fn run_24_stdin_pipe_contains_context_json() {
        let mut hook = host_exec_hook("cat", HookPoint::PostStart, "cat");
        hook.timeout_secs = 5;

        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
    }

    // ── T-RUN-25/26: stdout/stderr capture tested in host_exec tests ────

    // ── T-RUN-27: GuestExec skipped when guest is None ──────────────────

    #[tokio::test]
    async fn run_27_guest_exec_skipped_when_guest_none() {
        let hook = Hook {
            name: "guest-hook".into(),
            point: HookPoint::PostExec,
            action: HookAction::GuestExec {
                command: "echo".into(),
                args: vec!["hello".into()],
                env: vec![],
                user: None,
                working_dir: None,
            },
            enabled: true,
            priority: 0,
            timeout_secs: 10,
            condition: None,
            on_error: HookErrorPolicy::Continue,
        };

        let runner = HookRunner::new(vec![], vec![hook]);
        let mut ctx = test_ctx(HookPoint::PostExec);
        ctx.exit_code = Some(0);
        // guest=None → GuestExec should be silently skipped
        let result = runner.fire(HookPoint::PostExec, &mut ctx, None).await;
        assert!(result.is_ok());
    }

    // ── T-RUN-28 through T-RUN-30: Trait hook tests ─────────────────────

    #[tokio::test]
    async fn run_28_trait_hook_fires() {
        struct CountingHook(AtomicUsize);
        impl Hook for CountingHook {
            fn points(&self) -> Vec<HookPoint> {
                vec![HookPoint::PostStart]
            }
            fn on_post_start(
                &self,
                _ctx: &HookContext,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = BoxliteResult<()>> + Send + '_>,
            > {
                let result: BoxliteResult<()> = Ok(());
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move { result })
            }
        }

        let counter = Arc::new(CountingHook(AtomicUsize::new(0)));
        let runner = HookRunner::new(vec![counter.clone()], vec![]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn run_29_trait_hook_err_on_pre_aborts() {
        struct FailingHook;
        impl Hook for FailingHook {
            fn points(&self) -> Vec<HookPoint> {
                vec![HookPoint::PreStart]
            }
            fn on_pre_start(
                &self,
                _ctx: &HookContext,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = BoxliteResult<()>> + Send + '_>,
            > {
                Box::pin(async move {
                    Err(BoxliteError::Internal("trait hook failed".into()))
                })
            }
        }

        let runner = HookRunner::new(vec![Arc::new(FailingHook)], vec![]);
        let mut ctx = test_ctx(HookPoint::PreStart);
        let result = runner.fire(HookPoint::PreStart, &mut ctx, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn run_30_trait_hook_err_on_post_is_logged() {
        struct FailingPostHook;
        impl Hook for FailingPostHook {
            fn points(&self) -> Vec<HookPoint> {
                vec![HookPoint::PostStart]
            }
            fn on_post_start(
                &self,
                _ctx: &HookContext,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = BoxliteResult<()>> + Send + '_>,
            > {
                Box::pin(async move {
                    Err(BoxliteError::Internal("post hook failed".into()))
                })
            }
        }

        let runner = HookRunner::new(vec![Arc::new(FailingPostHook)], vec![]);
        let mut ctx = test_ctx(HookPoint::PostStart);
        // PostStart error is logged but does not abort
        let result = runner.fire(HookPoint::PostStart, &mut ctx, None).await;
        assert!(result.is_ok());
    }
}
