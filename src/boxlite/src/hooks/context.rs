//! [`HookContext`] — runtime state passed to every hook at fire time.

use serde::Serialize;

use crate::runtime::types::BoxStatus;
use super::{HookPoint, ExecHookTrigger};

/// Context passed to every hook at fire time.
///
/// For HostExec hooks this is serialized to JSON and piped to the child's stdin.
/// For GuestExec hooks each field is exported as a `BOXLITE_<KEY>` env var.
/// For `Hook` trait implementations this is the `ctx` argument.
#[derive(Debug, Clone, Serialize)]
pub struct HookContext {
    /// Box ID (e.g. "bxp8k2m1...").
    pub box_id: String,
    /// Container ID (64-char hex).
    pub container_id: String,
    /// Which hook point is firing.
    pub hook_point: HookPoint,
    /// Name of this specific hook.
    pub hook_name: String,
    /// Current box status.
    pub box_status: BoxStatus,
    /// Image reference (e.g. "python:3.12").
    pub image: String,
    /// How many times this hook has fired in this box's lifetime.
    pub fire_count: u64,

    // ── Exec-specific ──
    /// Exit code. `None` for pre-exec; the actual code for post-exec.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// The exec command (argv). `None` for non-exec points.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exec_command: Option<Vec<String>>,
    /// Wall-clock duration in ms. `None` for pre-exec.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exec_duration_ms: Option<u64>,

    // ── Snapshot-specific ──
    /// Name of the snapshot being created or restored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_name: Option<String>,
}

impl HookContext {
    /// Build a context for a non-exec, non-snapshot hook point.
    pub fn new(
        box_id: String,
        container_id: String,
        hook_point: HookPoint,
        hook_name: String,
        box_status: BoxStatus,
        image: String,
        fire_count: u64,
    ) -> Self {
        Self {
            box_id,
            container_id,
            hook_point,
            hook_name,
            box_status,
            image,
            fire_count,
            exit_code: None,
            exec_command: None,
            exec_duration_ms: None,
            snapshot_name: None,
        }
    }

    /// Build a context for a pre-exec hook point.
    pub fn for_pre_exec(
        box_id: String,
        container_id: String,
        hook_name: String,
        box_status: BoxStatus,
        image: String,
        fire_count: u64,
        exec_command: Vec<String>,
    ) -> Self {
        Self {
            box_id,
            container_id,
            hook_point: HookPoint::PreExec,
            hook_name,
            box_status,
            image,
            fire_count,
            exit_code: None,
            exec_command: Some(exec_command),
            exec_duration_ms: None,
            snapshot_name: None,
        }
    }

    /// Build a context for a post-exec hook point.
    pub fn for_post_exec(
        box_id: String,
        container_id: String,
        hook_name: String,
        box_status: BoxStatus,
        image: String,
        fire_count: u64,
        exec_command: Vec<String>,
        exit_code: i32,
        exec_duration_ms: u64,
    ) -> Self {
        Self {
            box_id,
            container_id,
            hook_point: HookPoint::PostExec,
            hook_name,
            box_status,
            image,
            fire_count,
            exit_code: Some(exit_code),
            exec_command: Some(exec_command),
            exec_duration_ms: Some(exec_duration_ms),
            snapshot_name: None,
        }
    }

    /// Build a context for a snapshot hook point.
    pub fn for_snapshot(
        box_id: String,
        container_id: String,
        hook_point: HookPoint,
        hook_name: String,
        box_status: BoxStatus,
        image: String,
        fire_count: u64,
        snapshot_name: String,
    ) -> Self {
        Self {
            box_id,
            container_id,
            hook_point,
            hook_name,
            box_status,
            image,
            fire_count,
            exit_code: None,
            exec_command: None,
            exec_duration_ms: None,
            snapshot_name: Some(snapshot_name),
        }
    }

    /// Convert the context into a map of `BOXLITE_*` environment variables.
    pub fn to_env_vars(&self) -> Vec<(String, String)> {
        let mut vars = Vec::new();
        vars.push(("BOXLITE_BOX_ID".into(), self.box_id.clone()));
        vars.push(("BOXLITE_CONTAINER_ID".into(), self.container_id.clone()));
        vars.push(("BOXLITE_HOOK_POINT".into(), self.hook_point_name()));
        vars.push(("BOXLITE_HOOK_NAME".into(), self.hook_name.clone()));
        vars.push(("BOXLITE_BOX_STATUS".into(), self.box_status_name()));
        vars.push(("BOXLITE_IMAGE".into(), self.image.clone()));
        vars.push(("BOXLITE_FIRE_COUNT".into(), self.fire_count.to_string()));
        vars.push((
            "BOXLITE_EXIT_CODE".into(),
            self.exit_code.map(|c| c.to_string()).unwrap_or_default(),
        ));
        vars.push((
            "BOXLITE_EXEC_COMMAND".into(),
            self.exec_command
                .as_ref()
                .map(|cmd| cmd.join(" "))
                .unwrap_or_default(),
        ));
        vars.push((
            "BOXLITE_EXEC_DURATION_MS".into(),
            self.exec_duration_ms
                .map(|d| d.to_string())
                .unwrap_or_default(),
        ));
        vars.push((
            "BOXLITE_SNAPSHOT_NAME".into(),
            self.snapshot_name.clone().unwrap_or_default(),
        ));
        vars
    }

    fn hook_point_name(&self) -> String {
        serde_json::to_string(&self.hook_point)
            .unwrap_or_else(|_| "\"unknown\"".into())
            .trim_matches('"')
            .to_string()
    }

    fn box_status_name(&self) -> String {
        serde_json::to_string(&self.box_status)
            .unwrap_or_else(|_| "\"unknown\"".into())
            .trim_matches('"')
            .to_string()
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::HookPoint;
    use crate::runtime::types::BoxStatus;

    // ── T-CTX-01: JSON serialization for HostExec ───────────────────────

    #[test]
    fn ctx_01_json_serialization() {
        let ctx = HookContext::for_post_exec(
            "bx1".into(),
            "c1".into(),
            "my-hook".into(),
            BoxStatus::Running,
            "python:3.12".into(),
            5,
            vec!["pip".into(), "install".into()],
            0,
            4200,
        );
        let json = serde_json::to_string(&ctx).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed["box_id"], "bx1");
        assert_eq!(parsed["container_id"], "c1");
        assert_eq!(parsed["hook_point"], "post-exec");
        assert_eq!(parsed["hook_name"], "my-hook");
        assert_eq!(parsed["box_status"], "running");
        assert_eq!(parsed["image"], "python:3.12");
        assert_eq!(parsed["fire_count"], 5);
        assert_eq!(parsed["exit_code"], 0);
        assert_eq!(parsed["exec_command"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["exec_duration_ms"], 4200);
        // snapshot_name is skipped when None
        assert!(parsed.get("snapshot_name").is_none());
    }

    // ── T-CTX-02: Env-var serialization for GuestExec ───────────────────

    #[test]
    fn ctx_02_env_var_serialization() {
        let ctx = HookContext::new(
            "bx1".into(),
            "c1".into(),
            HookPoint::PostStart,
            "auto-init".into(),
            BoxStatus::Running,
            "alpine:latest".into(),
            3,
        );
        let vars = ctx.to_env_vars();

        let get = |key: &str| -> String {
            vars.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };

        assert_eq!(get("BOXLITE_BOX_ID"), "bx1");
        assert_eq!(get("BOXLITE_HOOK_POINT"), "post-start");
        assert_eq!(get("BOXLITE_HOOK_NAME"), "auto-init");
        assert_eq!(get("BOXLITE_EXIT_CODE"), ""); // empty for non-exec
        assert_eq!(get("BOXLITE_SNAPSHOT_NAME"), ""); // empty for non-snapshot
    }

    // ── T-CTX-03: Pre-exec context (exit_code is None) ─────────────────

    #[test]
    fn ctx_03_pre_exec_context() {
        let ctx = HookContext::for_pre_exec(
            "bx1".into(),
            "c1".into(),
            "pre-exec-hook".into(),
            BoxStatus::Running,
            "alpine:latest".into(),
            1,
            vec!["sh".into(), "-c".into(), "echo hi".into()],
        );
        assert_eq!(ctx.hook_point, HookPoint::PreExec);
        assert!(ctx.exit_code.is_none());
        assert!(ctx.exec_duration_ms.is_none());
        assert_eq!(ctx.exec_command.unwrap(), vec!["sh", "-c", "echo hi"]);

        let json = serde_json::to_string(&ctx).unwrap();
        // exit_code and exec_duration_ms should be absent
        assert!(!json.contains("exit_code"));
        assert!(!json.contains("exec_duration_ms"));
    }

    // ── T-CTX-04: Snapshot context (snapshot_name present) ──────────────

    #[test]
    fn ctx_04_snapshot_context() {
        let ctx = HookContext::for_snapshot(
            "bx1".into(),
            "c1".into(),
            HookPoint::PreSnapshot,
            "pre-snap-hook".into(),
            BoxStatus::Running,
            "alpine:latest".into(),
            2,
            "my-snap".into(),
        );
        assert_eq!(ctx.snapshot_name.as_deref(), Some("my-snap"));
        assert!(ctx.exit_code.is_none());
        assert!(ctx.exec_command.is_none());

        let json = serde_json::to_string(&ctx).unwrap();
        assert!(json.contains("my-snap"));
        // exec fields should be absent
        assert!(!json.contains("exit_code"));
        assert!(!json.contains("exec_command"));
    }
}
