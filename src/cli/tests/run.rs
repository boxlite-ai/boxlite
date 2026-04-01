use predicates::prelude::*;

mod common;

// ============================================================================
// Exit Code Tests
// ============================================================================

#[test]
fn test_run_exit_code_success() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "sh", "-c", "exit 0"]);
    ctx.cmd.assert().success();
}

#[test]
fn test_run_exit_code_custom() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "sh", "-c", "exit 42"]);
    ctx.cmd.assert().code(42);
}

#[test]
fn test_run_exit_code_125() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "sh", "-c", "exit 125"]);
    ctx.cmd.assert().code(125);
}

// ============================================================================
// Command Execution Error Tests
// ============================================================================

#[test]
fn test_run_command_not_found() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "nonexistent_command"]);
    ctx.cmd.assert()
        .failure() // Currently exits with 1, should be 127？
        .stderr(
            predicate::str::contains("not found")
                .or(predicate::str::contains("No such file"))
                .or(predicate::str::contains("executable"))
        );
}

#[test]
fn test_run_invalid_executable() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["run", "--rm", "alpine:latest", "/etc"]);
    ctx.cmd.assert()
        .failure() // Currently exits with 1, should be 126
        .stderr(
            predicate::str::contains("is a directory")
                .or(predicate::str::contains("permission denied"))
                .or(predicate::str::contains("cannot invoke"))
                .or(predicate::str::contains("not a regular file"))
                .or(predicate::str::contains("does not have correct permissions"))
        );
}

// ============================================================================
// Environment Variable Tests
// ============================================================================

#[test]
fn test_run_single_env_var() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-e",
        "BOX=lite",
        "alpine:latest",
        "sh",
        "-c",
        "echo $BOX",
    ]);
    ctx.cmd.assert().success().stdout("lite\n");
}

#[test]
fn test_run_multiple_env_vars() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-e",
        "BOX=lite",
        "-e",
        "HELLO=world",
        "alpine:latest",
        "sh",
        "-c",
        "echo $BOX-$HELLO",
    ]);
    ctx.cmd.assert().success().stdout("lite-world\n");
}

#[test]
fn test_run_env_var_from_host() {
    let mut ctx = common::boxlite();
    ctx.cmd.env("BOXLITE_TEST_VAR", "from_host");
    ctx.cmd.args([
        "run",
        "--rm",
        "-e",
        "BOXLITE_TEST_VAR",
        "alpine:latest",
        "sh",
        "-c",
        "echo $BOXLITE_TEST_VAR",
    ]);
    ctx.cmd.assert().success().stdout("from_host\n");
}

#[test]
fn test_run_env_var_empty_value() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-e",
        "EMPTY=",
        "alpine:latest",
        "sh",
        "-c",
        "echo \"x${EMPTY}x\"",
    ]);

    ctx.cmd.assert().success().stdout("xx\n");
}

// ============================================================================
// Working Directory Tests
// ============================================================================

#[test]
fn test_run_working_dir_default() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["run", "--rm", "alpine:latest", "pwd"]);
    ctx.cmd.assert().success().stdout("/\n");
}

#[test]
fn test_run_working_dir_custom() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "-w", "/tmp", "alpine:latest", "pwd"]);
    ctx.cmd.assert().success().stdout("/tmp\n");
}

#[test]
fn test_run_working_dir_absolute_path() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "-w", "/etc", "alpine:latest", "pwd"]);
    ctx.cmd.assert().success().stdout("/etc\n");
}

// ============================================================================
// IO Stream Tests
// ============================================================================

#[test]
fn test_run_stdout_capture() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "echo", "hello boxlite"]);
    ctx.cmd.assert().success().stdout("hello boxlite\n");
}

#[test]
fn test_run_stderr_capture() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "sh", "-c", "echo error >&2"]);
    ctx.cmd
        .assert()
        .success()
        .stderr(predicate::str::contains("error"));
}

#[test]
fn test_run_stdout_stderr_separate() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "alpine:latest",
        "sh",
        "-c",
        "echo out; echo err >&2",
    ]);
    ctx.cmd
        .assert()
        .success()
        .stdout("out\n")
        .stderr(predicate::str::contains("err"));
}

#[test]
fn test_run_multiline_output() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "alpine:latest",
        "sh",
        "-c",
        "echo line1; echo line2; echo line3",
    ]);
    ctx.cmd.assert().success().stdout("line1\nline2\nline3\n");
}

// ============================================================================
// Naming Tests
// ============================================================================

#[test]
fn test_run_with_name() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "--name",
        "test-boxlite",
        "alpine:latest",
        "echo",
        "helloboxlite",
    ]);

    ctx.cmd.assert().success().stdout("helloboxlite\n");
}

// ============================================================================
// Resource Limit Tests
// ============================================================================

#[test]
fn test_run_cpus_limit() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "--cpus",
        "2",
        "alpine:latest",
        "echo",
        "boxlite-cpu-limited",
    ]);

    ctx.cmd.assert().success().stdout("boxlite-cpu-limited\n");
}

#[test]
fn test_run_memory_limit() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "--memory",
        "512",
        "alpine:latest",
        "echo",
        "boxlite-memory-limited",
    ]);

    ctx.cmd
        .assert()
        .success()
        .stdout("boxlite-memory-limited\n");
}

#[test]
fn test_run_combined_resource_limits() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "--cpus",
        "1",
        "--memory",
        "256",
        "alpine:latest",
        "echo",
        "boxlite-resource-limited",
    ]);

    ctx.cmd
        .assert()
        .success()
        .stdout("boxlite-resource-limited\n");
}

// ============================================================================
// Interactive, Detach, Cleanup
// ============================================================================

#[test]
fn test_run_interactive_pipe() {
    // e.g. echo "hello" | boxlite run -i ... cat
    let mut ctx = common::boxlite();
    ctx.cmd.args(["run", "--rm", "-i", "alpine:latest", "cat"]);
    //simulate pipe
    ctx.cmd.write_stdin("hello from boxlite pipe\n");
    ctx.cmd
        .assert()
        .success()
        .stdout("hello from boxlite pipe\n");
}

#[test]
fn test_run_detach() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let box_id = stdout.trim();

    assert!(!box_id.is_empty());
    assert!(box_id.chars().all(|c| c.is_alphanumeric()));

    // Cleanup: Detached boxes must be manually removed since they don't support --rm
    let mut rm_cmd = ctx.new_cmd();
    rm_cmd.args(["rm", "--force", box_id]);
    rm_cmd.assert().success();
}

#[test]
fn test_run_rm_cleanup() {
    let mut ctx = common::boxlite();
    let name = "test-auto-remove-boxlite";

    ctx.cmd.args([
        "run",
        "--rm",
        "--name",
        name,
        "alpine:latest",
        "echo",
        "done",
    ]);

    ctx.cmd.assert().success();

    // run another box with the SAME name
    let mut cmd2 = ctx.new_cmd();

    cmd2.args([
        "run",
        "--rm",
        "--name",
        name,
        "alpine:latest",
        "echo",
        "reused",
    ]);
    cmd2.assert().success().stdout("reused\n");
}

// ============================================================================
// Port Publish (-p / --publish) Tests
// ============================================================================

#[test]
fn test_run_with_publish_success() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-p",
        "18789:18789",
        "alpine:latest",
        "echo",
        "ok",
    ]);
    ctx.cmd.assert().success().stdout("ok\n");
}

#[test]
fn test_run_with_publish_short_flag() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-p",
        "8080:80",
        "alpine:latest",
        "sh",
        "-c",
        "echo done",
    ]);
    ctx.cmd.assert().success().stdout("done\n");
}

#[test]
fn test_run_with_publish_tcp_suffix() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "--publish",
        "9000:9000/tcp",
        "alpine:latest",
        "echo",
        "tcp",
    ]);
    ctx.cmd.assert().success().stdout("tcp\n");
}

#[test]
fn test_run_with_publish_invalid_format() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-p",
        "not-a-port",
        "alpine:latest",
        "echo",
        "ok",
    ]);
    ctx.cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("invalid"));
}

// ============================================================================
// Volume (-v / --volume) Tests
// ============================================================================

#[test]
fn test_run_with_volume_success() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    std::fs::write(path.join("hello.txt"), "hello-boxlite\n").unwrap();

    let mut ctx = common::boxlite();
    let host_path = path.to_str().unwrap();
    ctx.cmd.args([
        "run",
        "--rm",
        "-v",
        &format!("{}:/data", host_path),
        "alpine:latest",
        "cat",
        "/data/hello.txt",
    ]);
    ctx.cmd.assert().success().stdout("hello-boxlite\n");
}

#[test]
fn test_run_with_volume_short_flag() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    std::fs::write(path.join("x"), "ok").unwrap();

    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-v",
        &format!("{}:/mnt", path.to_str().unwrap()),
        "alpine:latest",
        "cat",
        "/mnt/x",
    ]);
    ctx.cmd.assert().success().stdout("ok");
}

#[test]
fn test_run_with_volume_read_only() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    std::fs::write(path.join("boxlite.txt"), "readonly").unwrap();

    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-v",
        &format!("{}:/data:ro", path.to_str().unwrap()),
        "alpine:latest",
        "cat",
        "/data/boxlite.txt",
    ]);
    ctx.cmd.assert().success().stdout("readonly");
}

#[test]
fn test_run_with_volume_invalid_format() {
    // Relative box path is invalid for anonymous volume
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "-v", "data", "alpine:latest", "echo", "ok"]);
    ctx.cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("absolute"));
}

#[test]
fn test_run_with_volume_anonymous() {
    // -v /data (anonymous volume): CLI creates a host dir and mounts it at /data
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-v",
        "/data",
        "alpine:latest",
        "sh",
        "-c",
        "echo anon > /data/x && cat /data/x",
    ]);
    ctx.cmd.assert().success().stdout("anon\n");
}

// ============================================================================
// Timeout Protection Tests
// ============================================================================

#[test]
fn test_run_basic_command_with_timeout() {
    let mut ctx = common::boxlite();
    ctx.cmd.timeout(std::time::Duration::from_secs(30));
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "echo", "hello boxlite"]);
    ctx.cmd.assert().success().stdout("hello boxlite\n");
}

#[test]
fn test_run_invalid_command_no_hang() {
    let mut ctx = common::boxlite();
    ctx.cmd.timeout(std::time::Duration::from_secs(5));
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "invalidcommand"]);
    ctx.cmd.assert().failure();
}

// ============================================================================
// Python Code Execution Tests
// ============================================================================

#[test]
fn test_run_python_simple_print() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "python:alpine",
        "python",
        "-c",
        "print('Hello BoxLite')",
    ]);

    ctx.cmd.assert().success().stdout("Hello BoxLite\n");
}

#[test]
fn test_run_python_json_processing() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "python:alpine",
        "python",
        "-c",
        "import json; data = [{'id': i, 'value': i*2} for i in range(3)]; print(json.dumps(data))",
    ]);

    let output = ctx.cmd.assert().success().get_output().clone();
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(stdout.contains("\"id\""), "JSON should contain 'id' field");
    assert!(
        stdout.contains("\"value\""),
        "JSON should contain 'value' field"
    );
    assert!(stdout.contains("0"), "JSON should contain data");
}

#[test]
fn test_run_python_computation() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "python:alpine",
        "python",
        "-c",
        "import json; data = [{'id': i, 'value': i*2} for i in range(5)]; \
         total = sum(item['value'] for item in data); \
         print(f'Total: {total}')",
    ]);
    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("Total: 20"));
}

#[test]
fn test_run_python_with_env_vars() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-e",
        "DATA_SIZE=5",
        "-e",
        "MULTIPLIER=3",
        "python:alpine",
        "python",
        "-c",
        "import os; size = int(os.getenv('DATA_SIZE', 0)); \
         mult = int(os.getenv('MULTIPLIER', 1)); \
         result = size * mult; \
         print(f'Result: {result}')",
    ]);

    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("Result: 15"));
}

#[test]
fn test_run_python_multi_step_pipeline() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "python:alpine",
        "sh",
        "-c",
        "python -c \"print('Step 1: Generate')\" && \
         python -c \"print('Step 2: Process')\" && \
         python -c \"print('Step 3: Complete')\"",
    ]);
    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("Step 1: Generate"))
        .stdout(predicate::str::contains("Step 2: Process"))
        .stdout(predicate::str::contains("Step 3: Complete"));
}

#[test]
fn test_run_python_list_comprehension() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "python:alpine",
        "python",
        "-c",
        "squares = [x**2 for x in range(5)]; print(squares)",
    ]);
    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("[0, 1, 4, 9, 16]"));
}

#[test]
fn test_run_python_error_handling() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "python:alpine",
        "python",
        "-c",
        "import sys; sys.exit(42)",
    ]);
    ctx.cmd.assert().code(42);
}

#[test]
fn test_run_python_import_stdlib() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "python:alpine",
        "python",
        "-c",
        "import sys, os, json, math; \
         print(f'Python {sys.version_info.major}.{sys.version_info.minor}')",
    ]);

    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("Python 3."));
}

// ============================================================================
// Signal Handling Tests
// ============================================================================

#[test]
fn test_run_signal_exit_code_sigterm() {
    let mut ctx = common::boxlite();

    // Sends SIGTERM to itself using kill
    // SIGTERM = 15
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "sh", "-c", "kill -TERM $$"]);

    ctx.cmd.assert().code(143);
}

#[test]
fn test_run_signal_exit_code_sigkill() {
    let mut ctx = common::boxlite();

    // SIGKILL = 9
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "sh", "-c", "kill -KILL $$"]);

    ctx.cmd.assert().code(137);
}

#[test]
fn test_run_signal_exit_code_sigint() {
    let mut ctx = common::boxlite();

    // SIGINT (Ctrl+C) = 2
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "sh", "-c", "kill -INT $$"]);

    ctx.cmd.assert().code(130);
}

// ============================================================================
// Other Tests
// ============================================================================

#[test]
fn test_run_invalid_image() {
    let mut ctx = common::boxlite();
    ctx.cmd.timeout(std::time::Duration::from_secs(30));
    ctx.cmd
        .args(["run", "nonexistent-image:latest", "echo", "hi"]);
    ctx.cmd.assert().failure().stderr(
        predicate::str::contains("failed to pull")
            .or(predicate::str::contains("not found"))
            .or(predicate::str::contains("Not authorized")),
    );
}

#[test]
fn test_run_tty_error_in_pipe() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["run", "--tty", "alpine:latest"]);
    // Simulate non-TTY input by writing to stdin
    ctx.cmd.write_stdin("ls\n");
    ctx.cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("input device is not a TTY"));
}
