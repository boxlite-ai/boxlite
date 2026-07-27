use assert_cmd::Command;
use predicates::prelude::*;

#[test]
fn custom_kernel_requires_explicit_rc_opt_in() {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    command
        .env_remove("BOXLITE_EXPERIMENTAL")
        .args([
            "--url",
            "http://127.0.0.1:1",
            "create",
            "--rootfs",
            "/definitely/missing/rootfs",
            "--kernel",
            "/definitely/missing/vmlinux",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "BOXLITE_EXPERIMENTAL=custom-kernel",
        ));
}

#[test]
fn unknown_rc_feature_fails_before_runtime_setup() {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    command
        .env("BOXLITE_EXPERIMENTAL", "custom-kernal")
        .args([
            "--url",
            "http://127.0.0.1:1",
            "create",
            "--rootfs",
            "/definitely/missing/rootfs",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "unknown feature 'custom-kernal' in BOXLITE_EXPERIMENTAL",
        ));
}
