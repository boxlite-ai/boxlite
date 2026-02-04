//! Info command tests.
//! Default output is YAML (Podman-style). Only json/yaml formats supported.

use boxlite::SystemInfo;
use predicates::prelude::*;

mod common;

fn system_info_json_keys() -> Vec<String> {
    let sample = SystemInfo {
        version: String::new(),
        home_dir: String::new(),
        virtualization: String::new(),
        os: String::new(),
        arch: String::new(),
        boxes_total: 0,
        boxes_running: 0,
        boxes_stopped: 0,
        boxes_configured: 0,
        images_count: 0,
    };
    let v = serde_json::to_value(&sample).expect("serialize SystemInfo");
    v.as_object()
        .expect("object")
        .keys()
        .map(String::from)
        .collect()
}

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
    let assert = ctx
        .cmd
        .args(["info", "--format", "json"])
        .assert()
        .success();
    let output = assert.get_output();
    let stdout = std::str::from_utf8(&output.stdout).unwrap();

    assert!(stdout.trim().starts_with('{'));
    assert!(stdout.trim().ends_with('}'));

    for key in system_info_json_keys() {
        assert!(
            stdout.contains(&format!("\"{}\"", key)),
            "JSON must contain key {:?}",
            key
        );
    }
}

#[test]
fn test_info_yaml_format() {
    let mut ctx = common::boxlite();
    let assert = ctx
        .cmd
        .args(["info", "--format", "yaml"])
        .assert()
        .success();
    let output = assert.get_output();
    let stdout = std::str::from_utf8(&output.stdout).unwrap();

    for key in system_info_json_keys() {
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

    let stdout = String::from_utf8(output.stdout).unwrap();
    let info: SystemInfo =
        serde_json::from_str(stdout.trim()).expect("valid JSON roundtrip to SystemInfo");
    assert!(
        info.boxes_total >= 1,
        "expected at least one box after create"
    );
    // Breakdown must sum to total (only created box: configured or stopped)
    assert_eq!(
        info.boxes_configured + info.boxes_stopped + info.boxes_running,
        info.boxes_total,
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
    let info: SystemInfo =
        serde_json::from_slice(&output.stdout).expect("valid JSON roundtrip to SystemInfo");
    assert!(!info.version.is_empty(), "version must not be empty");
    assert!(
        info.version.chars().any(|c| c.is_ascii_digit()),
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
fn test_info_json_roundtrip() {
    let mut ctx = common::boxlite();
    let output = ctx.cmd.args(["info", "--format", "json"]).output().unwrap();
    assert!(output.status.success());
    let info: SystemInfo =
        serde_json::from_slice(&output.stdout).expect("valid JSON roundtrip to SystemInfo");
    let expected_keys = system_info_json_keys();
    let actual: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    for key in &expected_keys {
        assert!(actual.get(key).is_some(), "JSON must contain key {:?}", key);
    }
    let _ = info;
}
