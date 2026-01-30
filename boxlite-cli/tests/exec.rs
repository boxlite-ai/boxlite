use predicates::prelude::*;

mod common;

fn cleanup(ctx: &common::TestContext, box_id: &str) {
    ctx.new_cmd()
        .args(["rm", "--force", box_id])
        .assert()
        .success();
}

#[test]
fn test_exec_on_running_box() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", &box_id, "--", "echo", "hello from boxlite"])
        .assert()
        .success()
        .stdout("hello from boxlite\n");

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_auto_starts_box() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["create", "alpine:latest"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", &box_id, "--", "echo", "boxlite"])
        .assert()
        .success()
        .stdout(predicate::str::contains("boxlite"));

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_not_found() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["exec", "nonexistent_box_id", "--", "echo", "test"]);
    ctx.cmd.assert().failure().stderr(
        predicate::str::contains("not found")
            .or(predicate::str::contains("does not exist"))
            .or(predicate::str::contains("No such box")),
    );
}

#[test]
fn test_exec_multiple_times_same_box() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    for i in 1..=3 {
        ctx.new_cmd()
            .args(["exec", &box_id, "--", "echo", &format!("iteration {}", i)])
            .assert()
            .success()
            .stdout(format!("iteration {}\n", i));
    }

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_inherits_box_env() {
    let mut ctx = common::boxlite();

    ctx.cmd.args([
        "run",
        "-d",
        "-e",
        "BOXLITE_VAR=hello_boxlite",
        "alpine:latest",
        "sleep",
        "300",
    ]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", &box_id, "--", "sh", "-c", "echo $BOXLITE_VAR"])
        .assert()
        .success()
        .stdout("hello_boxlite\n");

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_env_override() {
    let mut ctx = common::boxlite();

    ctx.cmd.args([
        "run",
        "-d",
        "-e",
        "VAR=original",
        "alpine:latest",
        "sleep",
        "300",
    ]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args([
            "exec",
            "-e",
            "VAR=override",
            &box_id,
            "--",
            "sh",
            "-c",
            "echo $VAR",
        ])
        .assert()
        .success()
        .stdout("override\n");

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_inherits_box_workdir() {
    let mut ctx = common::boxlite();

    ctx.cmd
        .args(["run", "-d", "-w", "/tmp", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", &box_id, "--", "pwd"])
        .assert()
        .success()
        .stdout("/tmp\n");
    ctx.new_cmd()
        .args(["exec", &box_id, "--", "pwd"])
        .assert()
        .success()
        .stdout("/tmp\n");

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_workdir_override() {
    let mut ctx = common::boxlite();

    ctx.cmd
        .args(["run", "-d", "-w", "/tmp", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", "-w", "/etc", &box_id, "--", "pwd"])
        .assert()
        .success()
        .stdout("/etc\n");

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_basic_command() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", &box_id, "--", "echo", "hello"])
        .assert()
        .success()
        .stdout("hello\n");

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_exit_code_success() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", &box_id, "--", "sh", "-c", "exit 0"])
        .assert()
        .success();

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_exit_code_custom() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", &box_id, "--", "sh", "-c", "exit 42"])
        .assert()
        .code(42);

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_stdin_redirect() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", "-i", &box_id, "--", "cat"])
        .write_stdin("hello from stdin\n")
        .assert()
        .success()
        .stdout("hello from stdin\n");

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_command_not_found() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", &box_id, "--", "nonexistent_command"])
        .assert()
        .failure()
        .stderr(
            predicate::str::contains("not found")
                .or(predicate::str::contains("No such file"))
                .or(predicate::str::contains("executable")),
        );

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_empty_command() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", &box_id])
        .assert()
        .failure()
        .stderr(predicate::str::contains("command").or(predicate::str::contains("required")));

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_python_command() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "python:alpine", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // boxlite exec <id> -- python -c "print('hello from python')"
    ctx.new_cmd()
        .args([
            "exec",
            &box_id,
            "--",
            "python",
            "-c",
            "print('hello from boxlite')",
        ])
        .assert()
        .success()
        .stdout("hello from boxlite\n");

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_interactive_shell() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Pipe multiple commands into sh and get output back
    ctx.new_cmd()
        .args(["exec", "-i", &box_id, "--", "/bin/sh"])
        .write_stdin("echo first\necho second\nexit\n")
        .assert()
        .success()
        .stdout(predicate::str::contains("first").and(predicate::str::contains("second")));

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_detach() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", "-d", &box_id, "--", "sleep", "10"])
        .assert()
        .success()
        .stdout(""); // Detach mode produces no output

    cleanup(&ctx, &box_id);
}

#[test]
fn test_exec_detach_with_tty_allowed() {
    let mut ctx = common::boxlite();

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    ctx.new_cmd()
        .args(["exec", "-d", "-t", &box_id, "--", "echo", "test"])
        .assert()
        .success()
        .stdout("");

    cleanup(&ctx, &box_id);
}
