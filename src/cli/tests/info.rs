//! Info command tests.
//! Default output is YAML (Podman-style). Only json/yaml formats supported.
//! Assertions use serde_json::Value (sqlx-cli / inspect.rs style), no duplicate structs.

use predicates::prelude::*;

mod common;

/// Expected top-level keys for `boxlite info --format json` (camelCase, must match info command).
const INFO_JSON_KEYS: &[&str] = &[
    "version",
    "homeDir",
    "virtualization",
    "os",
    "arch",
    "boxesTotal",
    "boxesRunning",
    "boxesStopped",
    "boxesConfigured",
    "imagesCount",
];

#[test]
fn test_info_default_is_yaml() {
    let mut ctx = common::boxlite();
    let assert = ctx.cmd.arg("info").assert().success();
    let stdout = std::str::from_utf8(&assert.get_output().stdout).unwrap();
    assert!(
        stdout.contains("version:"),
        "default output must be YAML with version:"
    );
    assert!(
        stdout.contains("homeDir:"),
        "YAML must contain homeDir: (camelCase)"
    );
}

#[test]
fn test_info_json_format() {
    let mut ctx = common::boxlite();
    let output = ctx.cmd.args(["info", "--format", "json"]).output().unwrap();
    assert!(output.status.success());
    let v: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("info --format json should be valid JSON");
    let obj = v.as_object().expect("root should be object");
    for key in INFO_JSON_KEYS {
        assert!(obj.contains_key(*key), "JSON must contain key {:?}", key);
    }
}

#[test]
fn test_info_yaml_format() {
    let mut ctx = common::boxlite();
    let output = ctx.cmd.args(["info", "--format", "yaml"]).output().unwrap();
    assert!(output.status.success());
    let stdout = std::str::from_utf8(&output.stdout).unwrap();
    for key in INFO_JSON_KEYS {
        let needle = format!("{}:", key);
        assert!(stdout.contains(&needle), "YAML must contain {:?}:", key);
    }
}

#[test]
fn test_info_box_counts() {
    let mut ctx = common::boxlite();
    let name = "info-counts-test";

    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();

    let output = ctx
        .new_cmd()
        .args(["info", "--format", "json"])
        .output()
        .unwrap();
    assert!(output.status.success());

    let v: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("info --format json should be valid JSON");
    let obj = v.as_object().expect("root should be object");
    let boxes_total = obj
        .get("boxesTotal")
        .and_then(|n| n.as_u64())
        .expect("boxesTotal");
    let boxes_running = obj
        .get("boxesRunning")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let boxes_stopped = obj
        .get("boxesStopped")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let boxes_configured = obj
        .get("boxesConfigured")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    assert!(boxes_total >= 1, "expected at least one box after create");
    assert_eq!(
        boxes_configured + boxes_stopped + boxes_running,
        boxes_total,
        "box count breakdown must sum to total"
    );

    ctx.cleanup_box(name);
}

#[test]
fn test_info_home_dir_in_output() {
    let mut ctx = common::boxlite();
    let home_str = ctx.home.to_string_lossy();
    ctx.cmd
        .arg("info")
        .assert()
        .success()
        .stdout(predicate::str::contains(home_str.as_ref()));
}

#[test]
fn test_info_version_present() {
    let mut ctx = common::boxlite();
    let output = ctx.cmd.args(["info", "--format", "json"]).output().unwrap();
    assert!(output.status.success());
    let v: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("info --format json should be valid JSON");
    let version = v
        .get("version")
        .and_then(|s| s.as_str())
        .expect("version key present");
    assert!(!version.is_empty(), "version must not be empty");
    assert!(
        version.chars().any(|c| c.is_ascii_digit()),
        "version should contain a digit"
    );
}

#[test]
fn test_info_invalid_format() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["info", "--format", "invalid"])
        .assert()
        .failure();
}

#[test]
fn test_info_format_table_rejected() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["info", "--format", "table"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("yaml").and(predicate::str::contains("json")));
}

#[test]
fn test_info_json_has_expected_keys() {
    let mut ctx = common::boxlite();
    let output = ctx.cmd.args(["info", "--format", "json"]).output().unwrap();
    assert!(output.status.success());
    let v: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("info --format json should be valid JSON");
    let obj = v.as_object().expect("root should be object");
    for key in INFO_JSON_KEYS {
        assert!(obj.contains_key(*key), "JSON must contain key {:?}", key);
    }
}
