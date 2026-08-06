//! `$BOXLITE_*` variable substitution in hook args and env.

use super::context::HookContext;

/// Perform `$BOXLITE_*` substitution on a list of strings (args or env values).
///
/// Each `$BOXLITE_VAR` token is replaced with its string value from the
/// `HookContext`. No shell is invoked — this is literal string substitution
/// within each element. Unrecognized `$BOXLITE_*` tokens are left as-is.
pub fn substitute_args(args: &[String], ctx: &HookContext) -> Vec<String> {
    args.iter().map(|arg| substitute_in_string(arg, ctx)).collect()
}

/// Perform `$BOXLITE_*` substitution on env `(key, value)` pairs.
pub fn substitute_env(env: &[(String, String)], ctx: &HookContext) -> Vec<(String, String)> {
    env.iter()
        .map(|(k, v)| (k.clone(), substitute_in_string(v, ctx)))
        .collect()
}

/// Replace all `$BOXLITE_*` tokens in a single string with context values.
fn substitute_in_string(s: &str, ctx: &HookContext) -> String {
    // Fast path: no $BOXLITE_ prefix at all
    if !s.contains("$BOXLITE_") {
        return s.to_string();
    }

    let mut result = s.to_string();
    let vars = build_var_map(ctx);

    for (var_name, value) in &vars {
        result = result.replace(var_name, value);
    }

    result
}

/// Build the `$BOXLITE_*` → value lookup table from a HookContext.
fn build_var_map(ctx: &HookContext) -> Vec<(String, String)> {
    let hook_point = serde_json::to_string(&ctx.hook_point)
        .unwrap_or_else(|_| "\"unknown\"".into())
        .trim_matches('"')
        .to_string();
    let box_status = serde_json::to_string(&ctx.box_status)
        .unwrap_or_else(|_| "\"unknown\"".into())
        .trim_matches('"')
        .to_string();

    vec![
        ("$BOXLITE_BOX_ID".into(), ctx.box_id.clone()),
        ("$BOXLITE_CONTAINER_ID".into(), ctx.container_id.clone()),
        ("$BOXLITE_HOOK_POINT".into(), hook_point),
        ("$BOXLITE_HOOK_NAME".into(), ctx.hook_name.clone()),
        ("$BOXLITE_BOX_STATUS".into(), box_status),
        ("$BOXLITE_IMAGE".into(), ctx.image.clone()),
        ("$BOXLITE_FIRE_COUNT".into(), ctx.fire_count.to_string()),
        (
            "$BOXLITE_EXIT_CODE".into(),
            ctx.exit_code.map(|c| c.to_string()).unwrap_or_default(),
        ),
        (
            "$BOXLITE_EXEC_COMMAND".into(),
            ctx.exec_command
                .as_ref()
                .map(|cmd| cmd.join(" "))
                .unwrap_or_default(),
        ),
        (
            "$BOXLITE_EXEC_DURATION_MS".into(),
            ctx.exec_duration_ms
                .map(|d| d.to_string())
                .unwrap_or_default(),
        ),
        (
            "$BOXLITE_SNAPSHOT_NAME".into(),
            ctx.snapshot_name.clone().unwrap_or_default(),
        ),
    ]
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::HookPoint;
    use crate::runtime::types::BoxStatus;

    fn test_ctx() -> HookContext {
        HookContext {
            box_id: "bxp8k2m".into(),
            container_id: "a1b2c3d4".into(),
            hook_point: HookPoint::PostStart,
            hook_name: "test-hook".into(),
            box_status: BoxStatus::Running,
            image: "alpine:latest".into(),
            fire_count: 42,
            exit_code: Some(137),
            exec_command: Some(vec!["pip".into(), "install".into()]),
            exec_duration_ms: Some(4200),
            snapshot_name: Some("my-snap".into()),
        }
    }

    // ── T-SUB-01: Single variable in args ───────────────────────────────

    #[test]
    fn sub_01_single_variable() {
        let ctx = test_ctx();
        let args = vec![
            "snapshot".into(),
            "$BOXLITE_BOX_ID".into(),
            "--name".into(),
            "latest".into(),
        ];
        let result = substitute_args(&args, &ctx);
        assert_eq!(
            result,
            vec!["snapshot", "bxp8k2m", "--name", "latest"]
        );
    }

    // ── T-SUB-02: Multiple variables in single arg ──────────────────────

    #[test]
    fn sub_02_multiple_in_one_arg() {
        let ctx = HookContext {
            box_id: "bx1".into(),
            ..test_ctx()
        };
        let args = vec![format!("--msg=$BOXLITE_BOX_ID:$BOXLITE_HOOK_POINT")];
        let result = substitute_args(&args, &ctx);
        assert_eq!(result, vec!["--msg=bx1:post-start"]);
    }

    // ── T-SUB-03: Variable substitution in env values ───────────────────

    #[test]
    fn sub_03_env_values() {
        let ctx = HookContext {
            box_id: "bx1".into(),
            ..test_ctx()
        };
        let env = vec![
            ("BOX".into(), "$BOXLITE_BOX_ID".into()),
            ("POINT".into(), "$BOXLITE_HOOK_POINT".into()),
        ];
        let result = substitute_env(&env, &ctx);
        assert_eq!(result[0], ("BOX".into(), "bx1".into()));
        assert_eq!(result[1], ("POINT".into(), "post-start".into()));
    }

    // ── T-SUB-04: Unrecognized variable left as-is ──────────────────────

    #[test]
    fn sub_04_unrecognized_left_as_is() {
        let ctx = test_ctx();
        let args = vec!["$BOXLITE_UNKNOWN_VAR".into()];
        let result = substitute_args(&args, &ctx);
        assert_eq!(result, vec!["$BOXLITE_UNKNOWN_VAR"]);
    }

    // ── T-SUB-05: Non-$BOXLITE_ variables left as-is ────────────────────

    #[test]
    fn sub_05_non_boxlite_vars_preserved() {
        let ctx = test_ctx();
        let args = vec!["$HOME".into(), "$PATH".into(), "literal".into()];
        let result = substitute_args(&args, &ctx);
        assert_eq!(result, vec!["$HOME", "$PATH", "literal"]);
    }

    // ── T-SUB-06: Empty variables for non-applicable context ────────────

    #[test]
    fn sub_06_empty_for_non_applicable() {
        let ctx = HookContext::new(
            "bx1".into(),
            "c1".into(),
            HookPoint::PostStart,
            "h".into(),
            BoxStatus::Running,
            "img".into(),
            1,
        );
        let args = vec![
            "$BOXLITE_EXIT_CODE".into(),
            "$BOXLITE_EXEC_COMMAND".into(),
            "$BOXLITE_SNAPSHOT_NAME".into(),
        ];
        let result = substitute_args(&args, &ctx);
        assert_eq!(result, vec!["", "", ""]);
    }

    // ── T-SUB-07: Integer values stringified ────────────────────────────

    #[test]
    fn sub_07_integers_stringified() {
        let ctx = test_ctx(); // fire_count=42, exit_code=137, exec_duration_ms=4200
        let args = vec![
            "$BOXLITE_FIRE_COUNT".into(),
            "$BOXLITE_EXIT_CODE".into(),
            "$BOXLITE_EXEC_DURATION_MS".into(),
        ];
        let result = substitute_args(&args, &ctx);
        assert_eq!(result, vec!["42", "137", "4200"]);
    }

    // ── T-SUB-08: All 11 variables present and substituted ──────────────

    #[test]
    fn sub_08_all_eleven_variables() {
        let ctx = test_ctx();
        let var_names = vec![
            "$BOXLITE_BOX_ID",
            "$BOXLITE_CONTAINER_ID",
            "$BOXLITE_HOOK_POINT",
            "$BOXLITE_HOOK_NAME",
            "$BOXLITE_BOX_STATUS",
            "$BOXLITE_IMAGE",
            "$BOXLITE_FIRE_COUNT",
            "$BOXLITE_EXIT_CODE",
            "$BOXLITE_EXEC_COMMAND",
            "$BOXLITE_EXEC_DURATION_MS",
            "$BOXLITE_SNAPSHOT_NAME",
        ];

        for var in &var_names {
            let args = vec![(*var).to_string()];
            let result = substitute_args(&args, &ctx);
            // Every recognized variable should have been replaced
            assert_ne!(
                result[0], *var,
                "variable {var} was not substituted"
            );
            // Even "empty" is fine — it just must not be the literal $BOXLITE_... token
        }
    }
}
