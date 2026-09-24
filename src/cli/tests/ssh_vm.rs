//! Real VM acceptance for SSH login, forwarding, lifecycle, and REST control.
mod common;

use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

fn json_output(command: &mut assert_cmd::Command) -> Value {
    let output = command.assert().success();
    serde_json::from_slice(&output.get_output().stdout).unwrap()
}

struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn login_command(login: &Value, remote: &str) -> assert_cmd::Command {
    let mut cmd = assert_cmd::Command::new("/bin/sh");
    cmd.args([
        "-c",
        &format!("exec {} {remote}", login["command"].as_str().unwrap()),
    ]);
    cmd.timeout(Duration::from_secs(20));
    cmd
}

#[test]
fn ssh_vm_setup_connect_forward_reuse_disable_and_restart() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args([
            "run",
            "-d",
            "--name",
            "ssh-vm",
            "alpine:latest",
            "sleep",
            "600",
        ])
        .assert()
        .success();
    let login = json_output(
        ctx.new_cmd()
            .args(["ssh", "setup", "ssh-vm", "--format", "json"]),
    );
    login_command(&login, "'printf' 'ssh-ready'")
        .assert()
        .success()
        .stdout("ssh-ready");

    // Config can select a runtime independently of the default credential home.
    // Exercise actual OpenSSH with every quoting layer in its paths.
    let credential_home = tempfile::Builder::new()
        .prefix("ssh ' \" %h ")
        .tempdir()
        .unwrap();
    let config_path = credential_home.path().join("runtime config.json");
    std::fs::write(
        &config_path,
        serde_json::json!({"home_dir":ctx.home}).to_string(),
    )
    .unwrap();
    ctx.new_cmd()
        .args(["ssh", "disable", "ssh-vm"])
        .assert()
        .success();
    let quoted = json_output(
        assert_cmd::Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
            .env("HOME", credential_home.path())
            .env_remove("BOXLITE_HOME")
            .arg("--config")
            .arg(&config_path)
            .args(["ssh", "setup", "ssh-vm", "--format", "json"]),
    );
    login_command(&quoted, "'printf' 'quoted-ready'")
        .env("HOME", credential_home.path())
        .env_remove("BOXLITE_HOME")
        .assert()
        .success()
        .stdout("quoted-ready");
    ctx.new_cmd()
        .args(["ssh", "disable", "ssh-vm"])
        .assert()
        .success();
    let login = json_output(
        ctx.new_cmd()
            .args(["ssh", "setup", "ssh-vm", "--format", "json"]),
    );
    let dir = std::path::Path::new(login["identity_file"].as_str().unwrap())
        .parent()
        .unwrap();
    let config = serde_json::json!({"listen_address":"0.0.0.0:2223","host_private_key":std::fs::read_to_string(dir.join("host")).unwrap(),"accounts":[{"login":"alice","authorized_keys":[std::fs::read_to_string(dir.join("identity.pub")).unwrap()],"ca":null}]});
    ctx.new_cmd()
        .args(["ssh", "configure", "ssh-vm", "--file", "-"])
        .write_stdin(config.to_string())
        .assert()
        .success();
    let login = json_output(
        ctx.new_cmd()
            .args(["ssh", "setup", "ssh-vm", "--format", "json"]),
    );
    assert_eq!(login["login"], "alice");
    assert_eq!(login["port"], 2223);
    ctx.new_cmd()
        .args([
            "ssh",
            "connect",
            "ssh-vm",
            "--",
            "sh",
            "-c",
            "printf direct; exit 17",
        ])
        .assert()
        .code(17)
        .stdout("direct");

    #[cfg(target_os = "macos")]
    interactive_login(&ctx.home);

    let mut session = ChildGuard(
        Command::new("/bin/sh")
            .args([
                "-c",
                &format!("exec {} cat", login["command"].as_str().unwrap()),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut input = session.0.stdin.take().unwrap();
    let mut output = BufReader::new(session.0.stdout.take().unwrap());
    input.write_all(b"before\n").unwrap();
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    assert_eq!(line, "before\n");
    let repeated = json_output(
        ctx.new_cmd()
            .args(["ssh", "setup", "ssh-vm", "--format", "json"]),
    );
    assert_eq!(login["identity_file"], repeated["identity_file"]);
    input.write_all(b"after\n").unwrap();
    line.clear();
    output.read_line(&mut line).unwrap();
    assert_eq!(line, "after\n");
    drop(input);
    assert!(session.0.wait().unwrap().success());

    let mut forward = ChildGuard(
        Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
            .arg("--home")
            .arg(&ctx.home)
            .args(["ssh", "forward", "ssh-vm", "--format", "json"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut lines = BufReader::new(forward.0.stdout.take().unwrap());
    let mut document = String::new();
    loop {
        let mut line = String::new();
        assert_ne!(
            lines.read_line(&mut line).unwrap(),
            0,
            "forward exited before reporting listener"
        );
        document.push_str(&line);
        if line.trim() == "}" {
            break;
        }
    }
    let forwarded: Value = serde_json::from_str(&document).unwrap();
    assert_eq!(forwarded["port"], 2222);
    login_command(&forwarded, "'printf' 'forwarded'")
        .assert()
        .success()
        .stdout("forwarded");
    ctx.new_cmd()
        .args(["ssh", "forward", "ssh-vm"])
        .assert()
        .failure()
        .stderr(predicates::str::contains("Address already in use"));
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(forward.0.id() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    assert!(forward.0.wait().unwrap().success());
    assert!(std::net::TcpStream::connect("127.0.0.1:2222").is_err());
    login_command(&login, "'true'").assert().success();

    let known_hosts = login["known_hosts_file"].as_str().unwrap();
    let expected = std::fs::read(known_hosts).unwrap();
    std::fs::write(known_hosts, "").unwrap();
    login_command(&login, "'true'")
        .assert()
        .failure()
        .stderr(predicates::str::contains("Host key verification failed"));
    std::fs::write(known_hosts, expected).unwrap();

    ctx.new_cmd()
        .args(["ssh", "disable", "ssh-vm"])
        .assert()
        .success();
    login_command(&login, "'true'").assert().failure();
    let restored = json_output(
        ctx.new_cmd()
            .args(["ssh", "setup", "ssh-vm", "--format", "json"]),
    );
    assert_ne!(restored["identity_file"], login["identity_file"]);
    login_command(&restored, "'true'").assert().success();
    ctx.new_cmd().args(["restart", "ssh-vm"]).assert().success();
    let restarted = json_output(
        ctx.new_cmd()
            .args(["ssh", "setup", "ssh-vm", "--format", "json"]),
    );
    assert_ne!(restarted["identity_file"], restored["identity_file"]);
    assert_ne!(
        restarted["host_key_fingerprint"],
        restored["host_key_fingerprint"]
    );
    login_command(&restarted, "'printf' 'restarted'")
        .assert()
        .success()
        .stdout("restarted");
    ctx.cleanup_box("ssh-vm");
}

#[test]
fn ssh_serve_controls_use_real_guest() {
    let serve = common::serve::ServeChild::start();
    let created = serve.client(&[
        "run",
        "-d",
        "--name",
        "ssh-rest",
        "alpine:latest",
        "sleep",
        "600",
    ]);
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let home = tempfile::tempdir().unwrap();
    let home = home.path().to_str().unwrap();
    let setup = serve.client(&[
        "--home", home, "ssh", "setup", "ssh-rest", "--format", "json",
    ]);
    assert!(
        setup.status.success(),
        "{}",
        String::from_utf8_lossy(&setup.stderr)
    );
    let login: Value = serde_json::from_slice(&setup.stdout).unwrap();
    let keys = std::path::Path::new(login["identity_file"].as_str().unwrap())
        .parent()
        .unwrap();
    let configuration = serde_json::json!({
        "listen_address":"0.0.0.0:22",
        "host_private_key":std::fs::read_to_string(keys.join("host")).unwrap(),
        "accounts":[{"login":"boxlite","authorized_keys":[std::fs::read_to_string(keys.join("identity.pub")).unwrap()],"ca":null}]
    });
    let configuration_path = std::path::Path::new(home).join("ssh.json");
    std::fs::write(&configuration_path, configuration.to_string()).unwrap();
    let configured = serve.client(&[
        "--home",
        home,
        "ssh",
        "configure",
        "ssh-rest",
        "--file",
        configuration_path.to_str().unwrap(),
    ]);
    assert!(
        configured.status.success(),
        "{}",
        String::from_utf8_lossy(&configured.stderr)
    );
    let status = serve.client(&["ssh", "status", "ssh-rest"]);
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&status.stdout).unwrap()["enabled"],
        true
    );
    let disabled = serve.client(&["ssh", "disable", "ssh-rest"]);
    assert!(disabled.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&disabled.stdout).unwrap()["enabled"],
        false
    );
    let removed = serve.client(&["rm", "--force", "ssh-rest"]);
    assert!(removed.status.success());
    serve.wait_until_no_boxes();
}

#[cfg(target_os = "macos")]
fn interactive_login(home: &std::path::Path) {
    use std::io::Read;
    use std::os::fd::OwnedFd;
    let (mut output, writer) = std::os::unix::net::UnixStream::pair().unwrap();
    output
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let mut session = ChildGuard(
        Command::new("/usr/bin/script")
            .args(["-q", "/dev/null"])
            .arg(assert_cmd::cargo::cargo_bin!("boxlite"))
            .arg("--home")
            .arg(home)
            .args(["ssh", "connect", "ssh-vm"])
            .env("TERM", "dumb")
            .stdin(Stdio::piped())
            .stdout(Stdio::from(OwnedFd::from(writer)))
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut input = session.0.stdin.take().unwrap();
    let mut transcript = Vec::new();
    while !transcript.ends_with(b"# ") {
        let mut byte = [0];
        output
            .read_exact(&mut byte)
            .expect("interactive shell prompt");
        transcript.push(byte[0]);
        assert!(transcript.len() < 64 * 1024);
    }
    // Keep stdin open until the remote shell has received and executed the
    // command. Giving script EOF early injects Ctrl-D into its pseudo-terminal.
    input
        .write_all(b"printf 'interactive-%s\\n' ready; exit\n")
        .unwrap();
    output
        .read_to_end(&mut transcript)
        .expect("interactive shell exit");
    assert!(session.0.wait().unwrap().success());
    assert!(String::from_utf8_lossy(&transcript).contains("interactive-ready"));
}
