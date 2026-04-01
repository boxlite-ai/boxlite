use boxlite_test_utils::TEST_REGISTRIES;

mod common;

#[test]
fn test_run_with_custom_registry() {
    let mut ctx = common::boxlite_bare();
    let mirror = TEST_REGISTRIES[0];
    ctx.cmd.arg("--registry").arg(mirror).args([
        "run",
        "--rm",
        "alpine:latest",
        "echo",
        "custom registry works",
    ]);
    ctx.cmd.assert().success().stdout("custom registry works\n");
}

#[test]
fn test_run_with_multiple_registries_fallback() {
    let mut ctx = common::boxlite_bare();
    ctx.cmd
        .arg("--registry")
        .arg("invalid.registry.that.does.not.exist")
        .arg("--registry")
        .arg(TEST_REGISTRIES[0])
        .args([
            "run",
            "--rm",
            "alpine:latest",
            "echo",
            "hello from fallback",
        ]);
    ctx.cmd.assert().success().stdout("hello from fallback\n");
}

#[test]
fn test_create_with_custom_registry() {
    let mut ctx = common::boxlite_bare();
    let mirror = TEST_REGISTRIES[0];
    ctx.cmd
        .arg("--registry")
        .arg(mirror)
        .args(["create", "alpine:latest"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    assert!(!box_id.is_empty(), "Box ID should not be empty");

    ctx.cleanup_box(&box_id);
}

#[test]
fn test_run_fully_qualified_image_bypasses_registry() {
    let mut ctx = common::boxlite_bare();
    let qualified = format!("{}/library/alpine:latest", TEST_REGISTRIES[0]);
    ctx.cmd
        .arg("--registry")
        .arg("invalid.registry.that.does.not.exist")
        .arg("--registry")
        .arg(TEST_REGISTRIES[0]) // needed for guest rootfs (debian:bookworm-slim)
        .args(["run", "--rm", &qualified, "echo", "fully qualified"]);
    ctx.cmd.assert().success().stdout("fully qualified\n");
}
