//! Container lifecycle hook system.
//!
//! Hooks allow users to inject custom logic at key points in the container
//! lifecycle. See [`Hook`] for the declarative configuration and [`HookRunner`]
//! for the execution engine.

use serde::{Deserialize, Serialize};

pub mod context;
pub mod fire_count;
pub mod host_exec;
pub mod runner;
pub mod substitution;

pub use context::HookContext;
pub use fire_count::FireCountStore;
pub use runner::HookRunner;

// ============================================================================
// TYPES
// ============================================================================

/// Where and how a hook executes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HookAction {
    /// Run a command on the host OS beside the runtime.
    ///
    /// Context is available in two forms:
    /// - Piped to the child's stdin as JSON (OCI convention).
    /// - Injected into `args` and `env` via literal `$BOXLITE_*` substitution.
    ///
    /// The child's stdout and stderr are captured and logged at INFO level
    /// (WARN on failure). The child runs in the runtime's process group;
    /// on timeout it receives SIGTERM, then SIGKILL after a 5 s grace.
    HostExec {
        program: String,
        /// Each element may contain `$BOXLITE_*` variables, which the runner
        /// replaces with their string values before spawning. No shell is
        /// involved — this is literal string substitution within each argv slot.
        args: Vec<String>,
        /// Extra environment variables (merged on top of the runtime's env).
        #[serde(default)]
        env: Vec<(String, String)>,
    },
    /// Run a command inside the container via the Execution RPC.
    ///
    /// Context is injected as environment variables (`BOXLITE_*`).
    /// `$BOXLITE_*` substitution in `args` and `env` is also performed.
    /// Stdout and stderr are captured and logged at DEBUG level (WARN on failure).
    /// Only valid at hook points where the container init is running
    /// (post-start, pre-stop, post-restore).
    GuestExec {
        command: String,
        args: Vec<String>,
        #[serde(default)]
        env: Vec<(String, String)>,
        /// User to run as inside the container (default: root).
        #[serde(default)]
        user: Option<String>,
        /// Working directory inside the container.
        #[serde(default)]
        working_dir: Option<String>,
    },
}

/// When a hook fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HookPoint {
    PostCreate,
    PreStart,
    PostStart,
    PreStop,
    PostStop,
    PreExec,
    PostExec,
    PreSnapshot,
    PostSnapshot,
    PreRestore,
    PostRestore,
}

/// Optional filter — the hook only fires when the condition matches.
///
/// `None` (the default) means the hook always fires at its point.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HookCondition {
    /// PostExec only: gate on the exec's exit code.
    ExecResult {
        trigger: ExecHookTrigger,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecHookTrigger {
    /// Fire regardless of exit code (equivalent to no condition).
    Always,
    /// Fire only when exit_code == 0.
    OnSuccess,
    /// Fire only when exit_code != 0.
    OnFailure,
    /// Fire only when exit_code equals this value.
    ExitCode(i32),
    /// Fire only when the exec command matches this glob pattern.
    /// Example: `"pip*"` matches `pip`, `pip3`, `pip install ...`.
    CommandMatches(String),
}

/// What to do when a hook's retries are exhausted.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OnExhausted {
    /// Log the error and continue.
    #[default]
    Continue,
    /// Abort the triggering operation.
    Fail,
}

/// Error policy for a single hook.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HookErrorPolicy {
    /// Log the error and continue (default for post- hooks and pre-stop).
    #[default]
    Continue,
    /// Abort the triggering operation (default for pre- hooks except pre-stop).
    Fail,
    /// Retry up to N times with linear backoff, then apply `on_exhausted`.
    Retry {
        max_retries: u32,
        backoff_secs: u64,
        #[serde(default)]
        on_exhausted: OnExhausted,
    },
}

/// A single hook registered on a box.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hook {
    /// Human-readable name for debugging and logs. Must be unique within a box.
    pub name: String,
    /// When this hook fires.
    pub point: HookPoint,
    /// What this hook does.
    pub action: HookAction,
    /// Whether the hook is active. Set to `false` to temporarily disable it
    /// without removing it from the configuration.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Lower-numbered hooks run first. Default 0.
    #[serde(default)]
    pub priority: i32,
    /// Timeout in seconds. The default is 30 s. Must be ≥ 1.
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    /// Only fire when this condition holds. `None` = always fire.
    #[serde(default)]
    pub condition: Option<HookCondition>,
    /// What to do when this hook fails (non-zero exit, timeout, or spawn error).
    #[serde(default)]
    pub on_error: HookErrorPolicy,
}

fn default_enabled() -> bool {
    true
}
fn default_timeout() -> u64 {
    30
}

// ============================================================================
// PER-HOOK-POINT DEFAULTS
// ============================================================================

impl HookPoint {
    /// Default `on_error` policy for this hook point.
    pub fn default_on_error(self) -> HookErrorPolicy {
        match self {
            HookPoint::PostCreate
            | HookPoint::PostStart
            | HookPoint::PreStop
            | HookPoint::PostStop
            | HookPoint::PostExec
            | HookPoint::PostSnapshot
            | HookPoint::PostRestore => HookErrorPolicy::Continue,
            HookPoint::PreStart
            | HookPoint::PreExec
            | HookPoint::PreSnapshot
            | HookPoint::PreRestore => HookErrorPolicy::Fail,
        }
    }

    /// Whether GuestExec hooks are valid at this point.
    pub fn allows_guest_exec(self) -> bool {
        matches!(
            self,
            HookPoint::PostStart | HookPoint::PreStop | HookPoint::PostRestore
        )
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── T-SERDE-01: Hook round-trip JSON ────────────────────────────────

    #[test]
    fn serde_01_hook_round_trip_all_fields() {
        let hook = Hook {
            name: "my-hook".into(),
            point: HookPoint::PostExec,
            action: HookAction::HostExec {
                program: "/usr/bin/curl".into(),
                args: vec!["-X".into(), "POST".into(), "$BOXLITE_BOX_ID".into()],
                env: vec![("DEBUG".into(), "1".into())],
            },
            enabled: false,
            priority: 5,
            timeout_secs: 60,
            condition: Some(HookCondition::ExecResult {
                trigger: ExecHookTrigger::OnFailure,
            }),
            on_error: HookErrorPolicy::Retry {
                max_retries: 3,
                backoff_secs: 2,
                on_exhausted: OnExhausted::Continue,
            },
        };

        let json = serde_json::to_string(&hook).unwrap();
        let round_tripped: Hook = serde_json::from_str(&json).unwrap();

        assert_eq!(round_tripped.name, hook.name);
        assert_eq!(round_tripped.point, hook.point);
        assert_eq!(round_tripped.enabled, hook.enabled);
        assert_eq!(round_tripped.priority, hook.priority);
        assert_eq!(round_tripped.timeout_secs, hook.timeout_secs);
    }

    // ── T-SERDE-02: Hook with all defaults ──────────────────────────────

    #[test]
    fn serde_02_hook_minimal_json_defaults() {
        let json = r#"{"name":"h","point":"post-create","action":{"type":"host-exec","program":"true","args":[]}}"#;
        let hook: Hook = serde_json::from_str(json).unwrap();

        assert_eq!(hook.name, "h");
        assert_eq!(hook.point, HookPoint::PostCreate);
        assert!(hook.enabled);
        assert_eq!(hook.priority, 0);
        assert_eq!(hook.timeout_secs, 30);
        assert!(hook.condition.is_none());
        assert!(matches!(hook.on_error, HookErrorPolicy::Continue));
    }

    // ── T-SERDE-03: HookAction tag discriminator ────────────────────────

    #[test]
    fn serde_03_tag_discriminator() {
        // HostExec
        let json = r#"{"type":"host-exec","program":"ls","args":[]}"#;
        let action: HookAction = serde_json::from_str(json).unwrap();
        assert!(matches!(
            action,
            HookAction::HostExec { .. }
        ));

        // GuestExec with null user/working_dir
        let json = r#"{"type":"guest-exec","command":"ls","args":[],"user":null,"working_dir":null}"#;
        let action: HookAction = serde_json::from_str(json).unwrap();
        match action {
            HookAction::GuestExec {
                command,
                args,
                env,
                user,
                working_dir,
            } => {
                assert_eq!(command, "ls");
                assert!(args.is_empty());
                assert!(env.is_empty());
                assert!(user.is_none());
                assert!(working_dir.is_none());
            }
            _ => panic!("expected GuestExec"),
        }

        // GuestExec with non-null user/working_dir
        let json = r#"{"type":"guest-exec","command":"/bin/sh","args":["-c","init.sh"],"user":"agent","working_dir":"/opt/app"}"#;
        let action: HookAction = serde_json::from_str(json).unwrap();
        match action {
            HookAction::GuestExec {
                command,
                args,
                env,
                user,
                working_dir,
            } => {
                assert_eq!(command, "/bin/sh");
                assert_eq!(args, vec!["-c", "init.sh"]);
                assert!(env.is_empty());
                assert_eq!(user.unwrap(), "agent");
                assert_eq!(working_dir.unwrap(), "/opt/app");
            }
            _ => panic!("expected GuestExec"),
        }
    }

    // ── T-SERDE-04: Unknown variant rejection ───────────────────────────

    #[test]
    fn serde_04_unknown_variant_rejected() {
        let json = r#"{"type":"invalid","program":"ls","args":[]}"#;
        let result: Result<HookAction, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    // ── T-SERDE-05: HookErrorPolicy variants ────────────────────────────

    #[test]
    fn serde_05_error_policy_variants() {
        let policy: HookErrorPolicy = serde_json::from_str(r#""continue""#).unwrap();
        assert!(matches!(policy, HookErrorPolicy::Continue));

        let policy: HookErrorPolicy = serde_json::from_str(r#""fail""#).unwrap();
        assert!(matches!(policy, HookErrorPolicy::Fail));

        let json = r#"{"retry":{"max_retries":2,"backoff_secs":1,"on_exhausted":"fail"}}"#;
        let policy: HookErrorPolicy = serde_json::from_str(json).unwrap();
        match policy {
            HookErrorPolicy::Retry {
                max_retries,
                backoff_secs,
                on_exhausted,
            } => {
                assert_eq!(max_retries, 2);
                assert_eq!(backoff_secs, 1);
                assert!(matches!(on_exhausted, OnExhausted::Fail));
            }
            _ => panic!("expected Retry"),
        }
    }

    // ── T-SERDE-05b: OnExhausted standalone deserialization ─────────────

    #[test]
    fn serde_05b_on_exhausted_standalone() {
        let oe: OnExhausted = serde_json::from_str(r#""continue""#).unwrap();
        assert!(matches!(oe, OnExhausted::Continue));

        let oe: OnExhausted = serde_json::from_str(r#""fail""#).unwrap();
        assert!(matches!(oe, OnExhausted::Fail));
    }

    // ── T-SERDE-06: ExecHookTrigger variants ────────────────────────────

    #[test]
    fn serde_06_exec_hook_trigger_variants() {
        let t: ExecHookTrigger = serde_json::from_str(r#""always""#).unwrap();
        assert!(matches!(t, ExecHookTrigger::Always));

        let t: ExecHookTrigger = serde_json::from_str(r#""on-success""#).unwrap();
        assert!(matches!(t, ExecHookTrigger::OnSuccess));

        let t: ExecHookTrigger = serde_json::from_str(r#""on-failure""#).unwrap();
        assert!(matches!(t, ExecHookTrigger::OnFailure));

        let t: ExecHookTrigger =
            serde_json::from_str(r#"{"exit-code":42}"#).unwrap();
        assert!(matches!(t, ExecHookTrigger::ExitCode(42)));

        let t: ExecHookTrigger =
            serde_json::from_str(r#"{"command-matches":"pip*"}"#).unwrap();
        assert!(matches!(t, ExecHookTrigger::CommandMatches(ref s) if s == "pip*"));
    }

    // ── T-SERDE-07: HookCondition tagged enum ───────────────────────────

    #[test]
    fn serde_07_hook_condition() {
        let json = r#"{"kind":"exec-result","trigger":"on-success"}"#;
        let cond: HookCondition = serde_json::from_str(json).unwrap();
        match cond {
            HookCondition::ExecResult { trigger } => {
                assert!(matches!(trigger, ExecHookTrigger::OnSuccess));
            }
        }
    }

    // ── T-SERDE-08: HookPoint kebab-case serialization ──────────────────

    #[test]
    fn serde_08_hook_point_kebab_case() {
        let pairs = vec![
            (HookPoint::PostCreate, "post-create"),
            (HookPoint::PreStart, "pre-start"),
            (HookPoint::PostStart, "post-start"),
            (HookPoint::PreStop, "pre-stop"),
            (HookPoint::PostStop, "post-stop"),
            (HookPoint::PreExec, "pre-exec"),
            (HookPoint::PostExec, "post-exec"),
            (HookPoint::PreSnapshot, "pre-snapshot"),
            (HookPoint::PostSnapshot, "post-snapshot"),
            (HookPoint::PreRestore, "pre-restore"),
            (HookPoint::PostRestore, "post-restore"),
        ];

        for (variant, expected) in pairs {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, format!("\"{expected}\""), "mismatch for {expected}");

            let round_tripped: HookPoint = serde_json::from_str(&json).unwrap();
            assert_eq!(round_tripped, variant);
        }
    }

    // ── Default on_error per hook point ─────────────────────────────────

    #[test]
    fn pre_hooks_default_to_fail_except_pre_stop() {
        assert_eq!(
            HookPoint::PreStart.default_on_error(),
            HookErrorPolicy::Fail
        );
        assert_eq!(
            HookPoint::PreExec.default_on_error(),
            HookErrorPolicy::Fail
        );
        assert_eq!(
            HookPoint::PreSnapshot.default_on_error(),
            HookErrorPolicy::Fail
        );
        assert_eq!(
            HookPoint::PreRestore.default_on_error(),
            HookErrorPolicy::Fail
        );
        // pre-stop is the exception
        assert_eq!(
            HookPoint::PreStop.default_on_error(),
            HookErrorPolicy::Continue
        );
    }

    #[test]
    fn post_hooks_default_to_continue() {
        assert_eq!(
            HookPoint::PostCreate.default_on_error(),
            HookErrorPolicy::Continue
        );
        assert_eq!(
            HookPoint::PostStart.default_on_error(),
            HookErrorPolicy::Continue
        );
        assert_eq!(
            HookPoint::PostStop.default_on_error(),
            HookErrorPolicy::Continue
        );
        assert_eq!(
            HookPoint::PostExec.default_on_error(),
            HookErrorPolicy::Continue
        );
        assert_eq!(
            HookPoint::PostSnapshot.default_on_error(),
            HookErrorPolicy::Continue
        );
        assert_eq!(
            HookPoint::PostRestore.default_on_error(),
            HookErrorPolicy::Continue
        );
    }

    #[test]
    fn guest_exec_validity() {
        assert!(!HookPoint::PostCreate.allows_guest_exec());
        assert!(!HookPoint::PreStart.allows_guest_exec());
        assert!(HookPoint::PostStart.allows_guest_exec());
        assert!(HookPoint::PreStop.allows_guest_exec());
        assert!(!HookPoint::PostStop.allows_guest_exec());
        assert!(!HookPoint::PreExec.allows_guest_exec());
        assert!(!HookPoint::PostExec.allows_guest_exec());
        assert!(!HookPoint::PreSnapshot.allows_guest_exec());
        assert!(!HookPoint::PostSnapshot.allows_guest_exec());
        assert!(!HookPoint::PreRestore.allows_guest_exec());
        assert!(HookPoint::PostRestore.allows_guest_exec());
    }
}
