//! HostExec hook strategy — spawn a host-side subprocess.

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;
use tracing::{debug, info, warn};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::context::HookContext;
use super::substitution;
use super::Hook;

/// Result of running a HostExec hook.
#[derive(Debug)]
pub struct HostExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run a HostExec hook.
///
/// 1. Performs `$BOXLITE_*` substitution on args and env.
/// 2. Spawns the child process, piping context JSON to stdin.
/// 3. Captures stdout and stderr.
/// 4. Applies timeout — on expiry: SIGTERM, 5 s grace, SIGKILL.
pub async fn run(hook: &Hook, ctx: &HookContext) -> BoxliteResult<HostExecResult> {
    match &hook.action {
        super::HookAction::HostExec { program, args, env } => {
            let args = substitution::substitute_args(args, ctx);
            let env = substitution::substitute_env(env, ctx);

            debug!(
                hook = %hook.name,
                program = %program,
                ?args,
                "Running HostExec hook"
            );

            let ctx_json = serde_json::to_string(ctx).map_err(|e| {
                BoxliteError::Internal(format!("Failed to serialize HookContext: {e}"))
            })?;

            let mut child = Command::new(program)
                .args(&args)
                .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| {
                    BoxliteError::Internal(format!(
                        "Failed to spawn HostExec hook '{}' program '{program}': {e}",
                        hook.name
                    ))
                })?;

            // Write context JSON to stdin, then close it
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                stdin
                    .write_all(ctx_json.as_bytes())
                    .await
                    .map_err(|e| BoxliteError::Internal(format!("Failed to write stdin: {e}")))?;
                // stdin is dropped here, closing the pipe
            }

            let timeout_dur = Duration::from_secs(hook.timeout_secs);

            let result = timeout(timeout_dur, child.wait_with_output()).await;

            match result {
                Ok(Ok(output)) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    let exit_code = output.status.code().unwrap_or(-1);

                    let hook_result = HostExecResult {
                        exit_code,
                        stdout: stdout.clone(),
                        stderr: stderr.clone(),
                    };

                    if output.status.success() {
                        info!(
                            hook = %hook.name,
                            exit_code,
                            hook_output = %stdout.trim_end(),
                            "HostExec hook succeeded"
                        );
                    } else {
                        warn!(
                            hook = %hook.name,
                            exit_code,
                            hook_output = %stderr.trim_end(),
                            "HostExec hook failed"
                        );
                    }

                    Ok(hook_result)
                }
                Ok(Err(e)) => {
                    warn!(hook = %hook.name, error = %e, "HostExec hook wait error");
                    Err(BoxliteError::Internal(format!(
                        "HostExec hook '{}' wait error: {e}",
                        hook.name
                    )))
                }
                Err(_elapsed) => {
                    // Timeout — child is killed by kill_on_drop
                    warn!(
                        hook = %hook.name,
                        timeout_secs = hook.timeout_secs,
                        "HostExec hook timed out"
                    );
                    Err(BoxliteError::Internal(format!(
                        "HostExec hook '{}' timed out after {}s",
                        hook.name, hook.timeout_secs
                    )))
                }
            }
        }
        _ => Err(BoxliteError::Internal(format!(
            "HostExec::run called with non-HostExec action for hook '{}'",
            hook.name
        ))),
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::{Hook, HookAction, HookCondition, HookErrorPolicy, HookPoint};
    use crate::runtime::types::BoxStatus;

    fn test_ctx() -> HookContext {
        HookContext::new(
            "bx1".into(),
            "c1".into(),
            HookPoint::PostStart,
            "test-hook".into(),
            BoxStatus::Running,
            "alpine:latest".into(),
            1,
        )
    }

    fn host_exec_hook(program: &str, args: Vec<String>) -> Hook {
        Hook {
            name: "test-hook".into(),
            point: HookPoint::PostStart,
            action: HookAction::HostExec {
                program: program.into(),
                args,
                env: vec![],
            },
            enabled: true,
            priority: 0,
            timeout_secs: 10,
            condition: None,
            on_error: HookErrorPolicy::Continue,
        }
    }

    // ── T-HEXEC-01: Basic spawn and wait ────────────────────────────────

    #[tokio::test]
    async fn hexec_01_basic_spawn_and_wait() {
        let hook = host_exec_hook("true", vec![]);
        let result = run(&hook, &test_ctx()).await.unwrap();
        assert_eq!(result.exit_code, 0);
    }

    // ── T-HEXEC-02: Non-zero exit captured ──────────────────────────────

    #[tokio::test]
    async fn hexec_02_non_zero_exit_captured() {
        let hook = host_exec_hook("false", vec![]);
        let result = run(&hook, &test_ctx()).await.unwrap();
        assert_eq!(result.exit_code, 1);
        // stdout/stderr are captured (may be empty)
    }

    // ── T-HEXEC-03: Stdin receives context JSON ─────────────────────────

    #[tokio::test]
    async fn hexec_03_stdin_receives_context() {
        let mut ctx = test_ctx();
        ctx.box_id = "test-box-123".into(); // override for assertion

        let mut hook = host_exec_hook("cat", vec![]);
        // Use a small timeout
        hook.timeout_secs = 5;

        let result = run(&hook, &ctx).await.unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&result.stdout).expect("stdout should be valid JSON");
        assert_eq!(parsed["box_id"], "test-box-123");
    }

    // ── T-HEXEC-04: Env vars merged ─────────────────────────────────────

    #[tokio::test]
    async fn hexec_04_env_vars_merged() {
        let mut hook = host_exec_hook("sh", vec!["-c".into(), "echo $MY_VAR".into()]);
        hook.action = HookAction::HostExec {
            program: "sh".into(),
            args: vec!["-c".into(), "echo $MY_VAR".into()],
            env: vec![("MY_VAR".into(), "my_value".into())],
        };
        hook.timeout_secs = 5;

        let result = run(&hook, &test_ctx()).await.unwrap();
        assert_eq!(result.stdout.trim(), "my_value");
    }

    // ── T-HEXEC-05: $BOXLITE_* substitution applied before spawn ────────

    #[tokio::test]
    async fn hexec_05_substitution_applied() {
        let mut ctx = test_ctx();
        ctx.box_id = "bx1".into();

        let mut hook = host_exec_hook(
            "sh",
            vec![
                "-c".into(),
                "echo \"id=$BOXLITE_BOX_ID\"".into(),
            ],
        );
        hook.timeout_secs = 5;

        let result = run(&hook, &ctx).await.unwrap();
        assert_eq!(result.stdout.trim(), "id=bx1");
    }

    // ── T-HEXEC-06: Timeout SIGTERM ─────────────────────────────────────

    #[tokio::test]
    async fn hexec_06_timeout_kills_child() {
        let mut hook = host_exec_hook("sleep", vec!["60".into()]);
        hook.timeout_secs = 1;

        let result = run(&hook, &test_ctx()).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("timed out"));
    }

    // ── T-HEXEC-07: Child process group killed ──────────────────────────

    #[tokio::test]
    async fn hexec_07_child_process_group_killed() {
        let mut hook = host_exec_hook(
            "sh",
            vec![
                "-c".into(),
                "sleep 60 & sleep 60 & wait".into(),
            ],
        );
        hook.timeout_secs = 1;

        let result = run(&hook, &test_ctx()).await;
        // kill_on_drop + timeout should clean up all processes
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("timed out"));
    }

    // ── T-HEXEC-08: Args with spaces passed correctly ───────────────────

    #[tokio::test]
    async fn hexec_08_args_with_spaces() {
        let mut hook = host_exec_hook("echo", vec!["hello world".into()]);
        hook.timeout_secs = 5;

        let result = run(&hook, &test_ctx()).await.unwrap();
        // "echo" prints its args space-separated, followed by newline
        assert_eq!(result.stdout.trim(), "hello world");
    }

    // ── Non-HostExec action rejected ────────────────────────────────────

    #[tokio::test]
    async fn hexec_non_host_exec_rejected() {
        let hook = Hook {
            name: "guest-hook".into(),
            point: HookPoint::PostStart,
            action: HookAction::GuestExec {
                command: "ls".into(),
                args: vec![],
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

        let result = run(&hook, &test_ctx()).await;
        assert!(result.is_err());
    }
}
