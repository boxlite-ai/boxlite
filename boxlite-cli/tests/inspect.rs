use std::time::Duration;

use assert_cmd::Command;
use predicates::prelude::*;

mod common;

/// No args and no --latest
#[test]
fn test_inspect_no_args() {
    let ctx = common::boxlite();
    ctx.new_cmd()
        .args(["inspect"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("no names or ids specified"));
}

#[test]
fn test_inspect_nonexistent() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["inspect", "no-such-box-123"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("no such"))
        .stdout(predicate::str::contains("[]"));
}

#[test]
fn test_inspect_by_name() {
    let mut ctx = common::boxlite();
    let name = "inspect-by-name";
    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();
    let output = ctx.new_cmd().args(["inspect", name]).output().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("inspect output should be valid JSON");
    let arr = v.as_array().expect("inspect output should be a JSON array");
    assert_eq!(arr.len(), 1, "single box => array of one");
    let obj = arr[0].as_object().expect("first element should be object");
    assert!(obj.contains_key("Id"), "JSON should contain Id");
    assert!(obj.contains_key("Image"), "JSON should contain Image");
    assert!(obj.contains_key("Status"), "JSON should contain Status");
    assert_eq!(
        obj.get("Image").and_then(|s| s.as_str()),
        Some("alpine:latest")
    );

    ctx.cleanup_box(name);
}

#[test]
fn test_inspect_by_id() {
    let mut ctx = common::boxlite();
    let create_out = ctx.cmd.args(["create", "alpine:latest"]).output().unwrap();
    assert!(create_out.status.success());
    let id = String::from_utf8(create_out.stdout)
        .unwrap()
        .trim()
        .to_string();
    assert!(id.len() >= 12, "id should be at least 12 chars");

    let output = ctx.new_cmd().args(["inspect", &id]).output().unwrap();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("inspect output should be valid JSON");
    let arr = v.as_array().expect("inspect output should be a JSON array");
    assert_eq!(arr.len(), 1);
    let obj = arr[0].as_object().expect("first element should be object");
    assert_eq!(obj.get("Id").and_then(|s| s.as_str()), Some(id.as_str()));

    ctx.cleanup_box(&id);
}

#[test]
fn test_inspect_format_json() {
    let mut ctx = common::boxlite();
    let name = "inspect-format-json";
    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();
    let output = ctx
        .new_cmd()
        .args(["inspect", "--format", "json", name])
        .output()
        .unwrap();

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let _: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("--format json should produce valid JSON");

    ctx.cleanup_box(name);
}

#[test]
fn test_inspect_format_yaml() {
    let mut ctx = common::boxlite();
    let name = "inspect-format-yaml";
    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();
    let output = ctx
        .new_cmd()
        .args(["inspect", "--format", "yaml", name])
        .output()
        .unwrap();

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let _: serde_yaml::Value =
        serde_yaml::from_str(stdout.trim()).expect("--format yaml should produce valid YAML");

    ctx.cleanup_box(name);
}

#[test]
fn test_inspect_format_template_state() {
    let mut ctx = common::boxlite();
    let name = "inspect-format-template";
    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();

    // boxlite inspect --format '{{.State}}' hellobox
    let output = ctx
        .new_cmd()
        .args(["inspect", "--format", "{{.State}}", name])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    // State is an object with status, running, pid; output may be JSON or single line
    assert!(
        stdout.contains("running") || stdout.contains("configured") || stdout.contains("stopped"),
        "template {{.State}} output should contain status value; got: {}",
        stdout.trim()
    );

    ctx.cleanup_box(name);
}

/// {{json .State}} outputs JSON (Podman/Docker aligned).
#[test]
fn test_inspect_format_template_json_state() {
    let mut ctx = common::boxlite();
    let name = "inspect-format-json-state";
    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();

    let output = ctx
        .new_cmd()
        .args(["inspect", "--format", "{{json .State}}", name])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap().trim().to_string();
    let v: serde_json::Value =
        serde_json::from_str(&stdout).expect("{{json .State}} should produce valid JSON");
    let obj = v.as_object().expect("should be object");
    assert!(obj.contains_key("Status"));
    assert!(obj.contains_key("Running"));
    assert!(obj.contains_key("Pid"));

    ctx.cleanup_box(name);
}

/// Invalid format (e.g. xml, foo)
#[test]
fn test_inspect_format_invalid() {
    let mut ctx = common::boxlite();
    let name = "inspect-format-invalid";
    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();

    for bad_format in ["xml", "foo", "XML"] {
        let output = ctx
            .new_cmd()
            .args(["inspect", "--format", bad_format, name])
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "format {:?} should fail",
            bad_format
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("Unknown format") || stderr.contains("Valid formats"),
            "stderr should mention unknown/valid format; got: {}",
            stderr
        );
    }

    ctx.cleanup_box(name);
}

#[test]
fn test_inspect_format_table_rejected() {
    let mut ctx = common::boxlite();
    let name = "inspect-format-table";
    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();

    let output = ctx
        .new_cmd()
        .args(["inspect", "--format", "table", name])
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("inspect does not support table format"),
        "stderr should say table not supported; got: {}",
        stderr
    );

    ctx.cleanup_box(name);
}

/// Template '{{"\n"}}' must not choke
#[test]
fn test_inspect_format_template_newline() {
    let mut ctx = common::boxlite();
    let name = "inspect-format-newline";
    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();

    let output = ctx
        .new_cmd()
        .args(["inspect", "--format", r#"{{"\n"}}"#, name])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.trim().is_empty(),
        "template newline should produce empty output; got: {:?}",
        stdout
    );

    ctx.cleanup_box(name);
}

/// Single-field template {{.Id}}
#[test]
fn test_inspect_format_template_single_field_id() {
    let mut ctx = common::boxlite();
    let name = "inspect-format-id";
    let create_out = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output()
        .unwrap();
    assert!(create_out.status.success());
    let expected_id = String::from_utf8(create_out.stdout)
        .unwrap()
        .trim()
        .to_string();

    let output = ctx
        .new_cmd()
        .args(["inspect", "--format", "{{.Id}}", name])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let got = String::from_utf8(output.stdout).unwrap().trim().to_string();
    assert_eq!(got, expected_id, "{{.Id}} should match create output id");

    ctx.cleanup_box(name);
}

/// Template alias {{.ID}} and {{.ImageID}} work like {{.Id}} / {{.Image}}.
#[test]
fn test_inspect_format_template_alias_id_and_image() {
    let mut ctx = common::boxlite();
    let name = "inspect-format-alias";
    let create_out = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output()
        .unwrap();
    assert!(create_out.status.success());
    let expected_id = String::from_utf8(create_out.stdout)
        .unwrap()
        .trim()
        .to_string();

    let out_id = ctx
        .new_cmd()
        .args(["inspect", "--format", "{{.ID}}", name])
        .output()
        .unwrap();
    assert!(
        out_id.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out_id.stderr)
    );
    assert_eq!(
        String::from_utf8(out_id.stdout).unwrap().trim(),
        expected_id,
        "{{.ID}} should match create output id"
    );

    let out_image = ctx
        .new_cmd()
        .args(["inspect", "--format", "{{.ImageID}}", name])
        .output()
        .unwrap();
    assert!(
        out_image.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out_image.stderr)
    );
    assert_eq!(
        String::from_utf8(out_image.stdout).unwrap().trim(),
        "alpine:latest",
        "{{.ImageID}} should output image"
    );

    ctx.cleanup_box(name);
}

/// Multiple IDs
#[test]
fn test_inspect_multiple_ids() {
    let ctx = common::boxlite();
    let name1 = "inspect-multi-1";
    let name2 = "inspect-multi-2";
    let c1 = ctx
        .new_cmd()
        .args(["create", "--name", name1, "alpine:latest"])
        .output()
        .unwrap();
    assert!(
        c1.status.success(),
        "create {}: {}",
        name1,
        String::from_utf8_lossy(&c1.stderr)
    );
    let c2 = ctx
        .new_cmd()
        .args(["create", "--name", name2, "alpine:latest"])
        .output()
        .unwrap();
    assert!(
        c2.status.success(),
        "create {}: {}",
        name2,
        String::from_utf8_lossy(&c2.stderr)
    );

    let output = ctx
        .new_cmd()
        .args(["inspect", name1, name2])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("inspect output should be valid JSON");
    let arr = v.as_array().expect("inspect output should be a JSON array");
    assert_eq!(arr.len(), 2, "inspect id1 id2 => array of two");
    let ids: Vec<&str> = arr
        .iter()
        .filter_map(|o| o.get("Id").and_then(|s| s.as_str()))
        .collect();
    assert_eq!(ids.len(), 2);
    let names: Vec<&str> = arr
        .iter()
        .filter_map(|o| o.get("Name").and_then(|s| s.as_str()))
        .collect();
    assert!(names.contains(&name1));
    assert!(names.contains(&name2));

    ctx.cleanup_box(name1);
    ctx.cleanup_box(name2);
}

/// --latest: inspect the most recently created box.
#[test]
fn test_inspect_latest() {
    let mut ctx = common::boxlite();
    let name = "inspect-latest-box";
    let create_out = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output()
        .unwrap();
    assert!(create_out.status.success());
    let expected_id = String::from_utf8(create_out.stdout)
        .unwrap()
        .trim()
        .to_string();

    let output = ctx
        .new_cmd()
        .args(["inspect", "--latest"])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("inspect --latest output should be valid JSON");
    let arr = v.as_array().expect("inspect output should be a JSON array");
    assert_eq!(arr.len(), 1);
    let obj = arr[0].as_object().expect("first element should be object");
    assert_eq!(
        obj.get("Id").and_then(|s| s.as_str()),
        Some(expected_id.as_str())
    );
    assert_eq!(obj.get("Name").and_then(|s| s.as_str()), Some(name));

    ctx.cleanup_box(name);
}

/// --latest with no boxes: use isolated empty home so there are no boxes
#[test]
fn test_inspect_latest_no_boxes() {
    let temp = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .timeout(Duration::from_secs(60))
        .arg("--home")
        .arg(temp.path())
        .args(["inspect", "--latest"])
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "inspect --latest with no boxes must fail; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no boxes to inspect"),
        "stderr should mention no boxes to inspect; got: {}",
        stderr
    );
}

/// --latest and BOX arguments are mutually exclusive
#[test]
fn test_inspect_latest_and_ref_fail() {
    let ctx = common::boxlite();
    let output = ctx
        .new_cmd()
        .args(["inspect", "--latest", "some-id"])
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("cannot be used together"),
        "stderr should say --latest and arguments cannot be used together; got: {}",
        stderr
    );
}
