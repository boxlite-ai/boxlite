//! `boxlite ssh` against real VMs.
//!
//! Default login runs system OpenSSH with piped shell input, preserves managed
//! identities and healthy SSH generations, and propagates remote exit codes.
//! Non-detached boxes stay alive through the session and stop afterward.
//! Explicit tunnel/proxy and enable/disable controls retain their behavior.
//! Against `boxlite serve`, controls work but its missing tunnel route fails
//! without changing the SSH configuration.
//!
//! Argument relations, credential redaction, and request counts are covered
//! without a VM in `src/cli/src/commands/ssh/tests/`.

mod common;

use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpListener};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use boxlite::SshStatus;
use common::serve::ServeChild;
use russh::ChannelMsg;
use russh::client::{self, Handler};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey};

fn generate_key(path: &Path) {
    let status = Command::new("ssh-keygen")
        .args([
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            "boxlite-ssh-test",
            "-f",
        ])
        .arg(path)
        .status()
        .expect("run ssh-keygen");
    assert!(status.success(), "ssh-keygen failed for {}", path.display());
}

/// Host and user key pairs, generated per test and never written elsewhere.
struct Keys {
    _dir: tempfile::TempDir,
    host: PathBuf,
    user: PathBuf,
}

impl Keys {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("key directory");
        let (host, user) = (dir.path().join("host"), dir.path().join("user"));
        generate_key(&host);
        generate_key(&user);
        Self {
            _dir: dir,
            host,
            user,
        }
    }

    fn user_public(&self) -> PathBuf {
        self.user.with_extension("pub")
    }

    fn flags(&self, login: &str) -> Vec<String> {
        vec![
            "--host-key".into(),
            self.host.display().to_string(),
            "--login".into(),
            login.into(),
            "--authorized-key".into(),
            self.user_public().display().to_string(),
        ]
    }
}

fn output_status(output: &std::process::Output, what: &str) -> SshStatus {
    assert!(
        output.status.success(),
        "{what} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "{what} printed no SshStatus JSON ({error}): {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

/// Prove direct CLI login reaches a real guest shell and returns its exit status.
fn assert_direct_login(ctx: &common::TestContext, id: &str) {
    let output = ctx
        .new_cmd()
        .args(["ssh", id])
        .write_stdin("printf 'direct-ssh-ok\\n'; exit 42\n")
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(42),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"direct-ssh-ok\n");
}

/// A foreground forwarder: the bound address it printed, and its process,
/// killed on drop so a failed assertion never leaks it holding the home lock.
struct Forwarder {
    child: Child,
    address: SocketAddr,
}

impl Forwarder {
    fn spawn(mut command: Command) -> Self {
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn forwarder");
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = sender.send(line);
        });
        let mut forwarder = Self {
            child,
            address: SocketAddr::from(([0, 0, 0, 0], 0)),
        };
        let line = receiver
            .recv_timeout(Duration::from_secs(120))
            .unwrap_or_default();
        match line.trim().strip_prefix("tcp://").map(str::parse) {
            Some(Ok(address)) => forwarder.address = address,
            _ => {
                let _ = forwarder.child.kill();
                panic!(
                    "forwarder printed {line:?} instead of an address: {}",
                    forwarder.stderr()
                );
            }
        }
        forwarder
    }

    fn stderr(&mut self) -> String {
        let mut stderr = String::new();
        if let Some(mut pipe) = self.child.stderr.take() {
            pipe.read_to_string(&mut stderr).ok();
        }
        stderr
    }

    /// Ctrl-C, then the exit status and everything written to stderr.
    fn interrupt(&mut self) -> (ExitStatus, String) {
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(self.child.id() as i32),
            nix::sys::signal::Signal::SIGINT,
        )
        .expect("send SIGINT");
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = self.child.try_wait().expect("poll forwarder") {
                break status;
            }
            assert!(Instant::now() < deadline, "forwarder ignored Ctrl-C");
            std::thread::sleep(Duration::from_millis(100));
        };
        (status, self.stderr())
    }
}

impl Drop for Forwarder {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Accept only the host key the CLI reported.
struct ExpectHostKey(String);

impl Handler for ExpectHostKey {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(key.fingerprint(HashAlg::Sha256).to_string() == self.0)
    }
}

/// Log in through `address` and run `command`, returning its stdout; the
/// whole exchange is bounded so a stalled tunnel fails the test.
async fn ssh_exec(
    address: SocketAddr,
    fingerprint: &str,
    key: &Path,
    login: &str,
    command: &str,
) -> anyhow::Result<String> {
    tokio::time::timeout(
        Duration::from_secs(60),
        ssh_exec_unbounded(address, fingerprint, key, login, command),
    )
    .await?
}

async fn ssh_exec_unbounded(
    address: SocketAddr,
    fingerprint: &str,
    key: &Path,
    login: &str,
    command: &str,
) -> anyhow::Result<String> {
    let key = Arc::new(russh::keys::load_secret_key(key, None)?);
    let mut session = client::connect(
        Arc::new(client::Config::default()),
        address,
        ExpectHostKey(fingerprint.to_string()),
    )
    .await?;
    let auth = session
        .authenticate_publickey(login, PrivateKeyWithHashAlg::new(key, None))
        .await?;
    anyhow::ensure!(auth.success(), "public key authentication rejected");
    let mut channel = session.channel_open_session().await?;
    channel.exec(true, command).await?;
    let mut stdout = Vec::new();
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => {
                anyhow::ensure!(exit_status == 0, "remote command exited {exit_status}")
            }
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(String::from_utf8(stdout)?)
}

fn assert_port_released(address: SocketAddr) {
    TcpListener::bind(address)
        .unwrap_or_else(|error| panic!("forwarder kept {address} bound: {error}"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_local_configure_forward_and_disable() {
    let ctx = common::boxlite();
    let keys = Keys::new();
    let run = ctx
        .new_cmd()
        .args(["run", "-d", "alpine:latest", "sleep", "600"])
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let id = String::from_utf8_lossy(&run.stdout).trim().to_string();
    let ssh = |args: &[&str]| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_boxlite"));
        command.arg("--home").arg(&ctx.home).arg("ssh").args(args);
        command
    };
    let status = |what| output_status(&ssh(&["--status", &id]).output().unwrap(), what);

    assert!(!status("initial status").enabled);

    let mut configure = ssh(&["--configure", &id]);
    configure.args(keys.flags("alice"));
    let configured = output_status(&configure.output().unwrap(), "--configure");
    assert!(configured.enabled);
    assert_eq!(configured.listen_address, "0.0.0.0:2222");

    // Each `forward` only observes SSH; logins work and the listener survives.
    for _ in 0..2 {
        let mut forwarder = Forwarder::spawn(ssh(&["--tunnel", &id]));
        let address = forwarder.address;
        let output = ssh_exec(
            address,
            &configured.host_key_fingerprint,
            &keys.user,
            "alice",
            "echo ssh-ok",
        )
        .await
        .expect("SSH through forward");
        assert_eq!(output.trim(), "ssh-ok");

        let (exit, stderr) = forwarder.interrupt();
        assert!(
            exit.success(),
            "Ctrl-C must exit cleanly: {exit:?} {stderr}"
        );
        assert!(
            stderr.contains(&configured.host_key_fingerprint),
            "{stderr}"
        );
        assert_port_released(address);
        assert_eq!(status("status after forward"), configured);
    }

    // Configure a dynamic guest port explicitly, then forward without reconfiguring.
    let mut configure = ssh(&["--configure", &id, "--guest-listen", "0.0.0.0:0"]);
    configure.args(keys.flags("alice"));
    let dynamic = output_status(&configure.output().unwrap(), "configure dynamic guest port");
    assert!(dynamic.enabled);
    assert_eq!(dynamic.generation, configured.generation + 1);
    let guest_port: u16 = dynamic
        .listen_address
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert_ne!(guest_port, 0);

    let mut forwarder = Forwarder::spawn(ssh(&["--tunnel", &id]));
    let address = forwarder.address;
    let output = ssh_exec(
        address,
        &dynamic.host_key_fingerprint,
        &keys.user,
        "alice",
        "echo dynamic-port-ok",
    )
    .await
    .expect("SSH through forward to dynamic guest port");
    assert_eq!(output.trim(), "dynamic-port-ok");
    let (exit, stderr) = forwarder.interrupt();
    assert!(exit.success(), "{exit:?} {stderr}");
    assert!(
        stderr.contains(&format!(
            "Connect: ssh -p {} -l LOGIN 127.0.0.1",
            address.port()
        )),
        "{stderr}"
    );
    assert_port_released(address);
    assert_eq!(
        status("status after forward to dynamic guest port"),
        dynamic
    );

    // Disabled SSH refuses `forward`, and nothing answers on the old port.
    let disabled = output_status(&ssh(&["--disable", &id]).output().unwrap(), "--disable");
    assert!(!disabled.enabled);
    let refused = ssh(&["--tunnel", &id]).output().unwrap();
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("disabled"));

    let mut raw = Command::new(env!("CARGO_BIN_EXE_boxlite"));
    raw.arg("--home").arg(&ctx.home).args([
        "network",
        "tunnel",
        &id,
        &guest_port.to_string(),
        "--listen",
        "127.0.0.1:0",
    ]);
    let mut forwarder = Forwarder::spawn(raw);
    let login = ssh_exec(
        forwarder.address,
        &configured.host_key_fingerprint,
        &keys.user,
        "alice",
        "true",
    )
    .await;
    assert!(login.is_err(), "disabled SSH still accepted a login");
    forwarder.interrupt();

    ctx.cleanup_box(&id);
}

/// Reuse managed identity across login, disable/enable, restart and failed setup.
///
/// Real guest execution and unchanged status distinguish reuse from silently
/// reconfiguring SSH; unsafe local files must fail without changing the guest.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_local_connect_enable_and_restart() {
    let mut ctx = common::boxlite();
    ctx.home = ctx.home.join("ssh ' % home");
    std::fs::create_dir(&ctx.home).unwrap();
    let keys = Keys::new();
    let run = ctx
        .new_cmd()
        .args(["create", "alpine:latest", "sleep", "600"])
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let id = String::from_utf8_lossy(&run.stdout).trim().to_string();
    let ssh = |operation: &str| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_boxlite"));
        command
            .arg("--home")
            .arg(&ctx.home)
            .args(["ssh", &id, operation]);
        command
    };
    let key_dir = ctx.home.join("boxes").join(&id).join("ssh");
    let client_key = key_dir.join("client_key");
    // Fail after generating the first key: no incomplete directory is published.
    let bin = tempfile::tempdir().unwrap();
    let keygen = bin.path().join("ssh-keygen");
    std::fs::write(&keygen, "#!/bin/sh\nfor arg do :; done\ncase \"$arg\" in */host_key) exit 1;; esac\nexec /usr/bin/ssh-keygen \"$@\"\n").unwrap();
    std::fs::set_permissions(&keygen, std::fs::Permissions::from_mode(0o700)).unwrap();
    let failed = ctx
        .new_cmd()
        .args(["ssh", &id])
        .env(
            "PATH",
            format!(
                "{}:{}",
                bin.path().display(),
                std::env::var("PATH").unwrap()
            ),
        )
        .output()
        .unwrap();
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("failed to generate host_key"));
    assert!(!key_dir.exists());
    let stopped_connect = ctx.new_cmd().args(["ssh", &id]).output().unwrap();
    assert!(
        !stopped_connect.status.success(),
        "explicit main command requires start"
    );
    assert!(
        String::from_utf8_lossy(&stopped_connect.stderr).contains("start the box explicitly"),
        "{}",
        String::from_utf8_lossy(&stopped_connect.stderr)
    );
    let stopped = output_status(&ssh("--status").output().unwrap(), "failed configure");
    assert!(!stopped.enabled);
    assert_eq!(stopped.generation, 0);
    let retry_key = std::fs::read(&client_key).expect("failed configure retains credentials");
    let retry_host_key = std::fs::read(key_dir.join("host_key")).unwrap();
    ctx.new_cmd().args(["start", &id]).assert().success();
    assert!(
        !ssh("--enable").output().unwrap().status.success(),
        "enable needs saved configuration"
    );
    assert_direct_login(&ctx, &id);
    let private_key = std::fs::read(&client_key).unwrap();
    let host_key = std::fs::read(key_dir.join("host_key")).unwrap();
    assert_eq!(private_key, retry_key);
    assert_eq!(host_key, retry_host_key);
    assert_eq!(
        std::fs::metadata(&key_dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for name in ["client_key", "host_key", "known_hosts"] {
        assert_eq!(
            std::fs::metadata(key_dir.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "{name}"
        );
    }
    let first = output_status(&ssh("--status").output().unwrap(), "first login status");
    assert_direct_login(&ctx, &id);
    assert_eq!(
        output_status(&ssh("--status").output().unwrap(), "repeated login status"),
        first
    );
    assert_eq!(std::fs::read(&client_key).unwrap(), private_key);
    assert_eq!(std::fs::read(key_dir.join("host_key")).unwrap(), host_key);

    let payload = format!("{}\n", "0123456789abcdef".repeat(32 * 1024));
    let echo = ctx
        .new_cmd()
        .args(["ssh", &id])
        .write_stdin(format!(
            "cat <<'BOXLITE_SSH_PAYLOAD'\n{payload}BOXLITE_SSH_PAYLOAD\nexit 0\n"
        ))
        .output()
        .unwrap();
    assert!(
        echo.status.success(),
        "{}",
        String::from_utf8_lossy(&echo.stderr)
    );
    assert_eq!(echo.stdout, payload.as_bytes());

    // OpenSSH sends SIGHUP to its proxy; explicit termination must also release
    // the runtime even while the parent keeps stdin open.
    for signal in [
        nix::sys::signal::Signal::SIGHUP,
        nix::sys::signal::Signal::SIGTERM,
    ] {
        let mut child = ssh("--proxy")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut banner = String::new();
            let result = BufReader::new(stdout).read_line(&mut banner);
            let _ = send.send((result, banner));
        });
        let mut proxy = Forwarder {
            child,
            address: SocketAddr::from(([127, 0, 0, 1], 0)),
        };
        let (read, banner) = receive.recv_timeout(Duration::from_secs(10)).unwrap();
        read.unwrap();
        assert!(banner.starts_with("SSH-2.0-"), "{banner:?}");
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(proxy.child.id() as i32), signal)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = proxy.child.try_wait().unwrap() {
                assert!(status.success(), "{}", proxy.stderr());
                break;
            }
            assert!(Instant::now() < deadline, "proxy remained blocked on stdin");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            ssh("--status").output().unwrap().status.success(),
            "home lock released"
        );
    }
    assert!(first.enabled);
    assert_eq!(first.listen_address, "0.0.0.0:22");
    assert_eq!(
        output_status(&ssh("--enable").output().unwrap(), "repeat enable"),
        first
    );
    let mut forwarder = Forwarder::spawn(ssh("--tunnel"));
    assert_eq!(
        ssh_exec(
            forwarder.address,
            &first.host_key_fingerprint,
            &client_key,
            "box",
            "echo tunnel-ok"
        )
        .await
        .unwrap()
        .trim(),
        "tunnel-ok"
    );
    assert!(
        ssh_exec(
            forwarder.address,
            &first.host_key_fingerprint,
            &keys.user,
            "box",
            "true"
        )
        .await
        .is_err()
    );
    assert!(forwarder.interrupt().0.success());
    assert!(!output_status(&ssh("--disable").output().unwrap(), "--disable").enabled);
    let enabled = output_status(&ssh("--enable").output().unwrap(), "--enable");
    assert_eq!(enabled.host_key_fingerprint, first.host_key_fingerprint);
    assert_eq!(enabled.generation, first.generation + 1);
    assert_direct_login(&ctx, &id);
    assert_eq!(
        output_status(&ssh("--status").output().unwrap(), "login after enable"),
        enabled
    );
    assert!(!output_status(&ssh("--disable").output().unwrap(), "--disable").enabled);
    assert_direct_login(&ctx, &id);
    let resumed = output_status(&ssh("--status").output().unwrap(), "login enables SSH");
    assert!(resumed.enabled);
    assert_eq!(resumed.host_public_key, first.host_public_key);
    assert_eq!(resumed.generation, enabled.generation + 1);
    assert_eq!(std::fs::read(&client_key).unwrap(), private_key);
    assert_eq!(std::fs::read(key_dir.join("host_key")).unwrap(), host_key);

    ctx.new_cmd().args(["stop", &id]).assert().success();
    for operation in ["--enable", "--disable", "--proxy"] {
        let result = ssh(operation).output().unwrap();
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("not running"));
    }
    assert!(!output_status(&ssh("--status").output().unwrap(), "stopped status").enabled);
    ctx.new_cmd().args(["start", &id]).assert().success();
    let restored = output_status(&ssh("--status").output().unwrap(), "restored status");
    assert!(restored.enabled);
    assert_eq!(restored.host_public_key, first.host_public_key);
    assert_direct_login(&ctx, &id);
    assert_eq!(
        output_status(&ssh("--status").output().unwrap(), "login after restart"),
        restored
    );
    assert_eq!(std::fs::read(&client_key).unwrap(), private_key);
    assert_eq!(std::fs::read(key_dir.join("host_key")).unwrap(), host_key);

    // Existing credentials must fail closed instead of being silently replaced.
    std::fs::set_permissions(&client_key, std::fs::Permissions::from_mode(0o644)).unwrap();
    let unsafe_key = ctx.new_cmd().args(["ssh", &id]).output().unwrap();
    assert!(!unsafe_key.status.success());
    assert!(unsafe_key.stdout.is_empty());
    assert!(String::from_utf8_lossy(&unsafe_key.stderr).contains("owner-private"));
    std::fs::set_permissions(&client_key, std::fs::Permissions::from_mode(0o600)).unwrap();

    let host_key_file = key_dir.join("host_key");
    std::fs::write(&host_key_file, b"not a host key\n").unwrap();
    let corrupt_key = ctx.new_cmd().args(["ssh", &id]).output().unwrap();
    assert!(!corrupt_key.status.success());
    assert!(corrupt_key.stdout.is_empty());
    assert!(String::from_utf8_lossy(&corrupt_key.stderr).contains("invalid or encrypted SSH key"));
    std::fs::write(&host_key_file, &host_key).unwrap();

    let known_hosts = key_dir.join("known_hosts");
    std::fs::remove_file(&known_hosts).unwrap();
    std::os::unix::fs::symlink(&host_key_file, &known_hosts).unwrap();
    let unsafe_hosts = ctx.new_cmd().args(["ssh", &id]).output().unwrap();
    assert!(!unsafe_hosts.status.success());
    assert!(unsafe_hosts.stdout.is_empty());
    assert!(String::from_utf8_lossy(&unsafe_hosts.stderr).contains("owner-private"));
    std::fs::remove_file(&known_hosts).unwrap();
    assert_eq!(
        output_status(
            &ssh("--status").output().unwrap(),
            "status after refused login"
        ),
        restored
    );
    assert_direct_login(&ctx, &id);
    assert_eq!(
        output_status(&ssh("--status").output().unwrap(), "status after recovery"),
        restored
    );
    ctx.cleanup_box(&id);
}

/// Non-detached boxes survive through the SSH shell, then stop on CLI teardown.
#[tokio::test]
async fn ssh_local_non_detached_lifetime() {
    let ctx = common::boxlite();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::BoxliteOptions {
        home_dir: ctx.home.clone(),
        image_registries: boxlite_test_utils::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let sandbox = runtime
        .create(
            boxlite::BoxOptions {
                rootfs: boxlite::RootfsSpec::Image("alpine:latest".into()),
                detach: false,
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let id = sandbox.id().to_string();
    drop(sandbox);
    drop(runtime);

    assert_direct_login(&ctx, &id);
    let stopped = ctx
        .new_cmd()
        .args(["inspect", "-f", "{{.State.Status}}", &id])
        .output()
        .unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&stopped.stdout).trim(), "stopped");
    ctx.cleanup_box(&id);
}

/// Refuse a changed guest identity without rotating local keys or restoring SSH.
#[tokio::test]
async fn ssh_local_connect_rejects_changed_host_identity() {
    let ctx = common::boxlite();
    let run = ctx
        .new_cmd()
        .args(["run", "-d", "alpine:latest", "sleep", "600"])
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let id = String::from_utf8_lossy(&run.stdout).trim().to_string();
    assert_direct_login(&ctx, &id);
    let status = || {
        output_status(
            &ctx.new_cmd()
                .args(["ssh", "--status", &id])
                .output()
                .unwrap(),
            "host identity status",
        )
    };
    let first = status();
    let key_file = ctx
        .home
        .join("boxes")
        .join(&id)
        .join("ssh")
        .join("host_key");
    let expected_key = std::fs::read(&key_file).unwrap();
    let alternate_keys = Keys::new();
    let mut configure = ctx.new_cmd();
    configure
        .args(["ssh", "--configure", &id, "--guest-listen", "0.0.0.0:22"])
        .args(alternate_keys.flags("box"));
    let changed = output_status(&configure.output().unwrap(), "alternate host configuration");
    assert!(changed.enabled);
    assert_ne!(changed.host_public_key, first.host_public_key);
    assert_eq!(changed.generation, first.generation + 1);

    let refused = ctx.new_cmd().args(["ssh", &id]).output().unwrap();
    assert!(!refused.status.success());
    assert!(refused.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&refused.stderr)
            .contains("SSH host key does not match the CLI-managed identity")
    );
    assert_eq!(status(), changed, "default login must not reconfigure SSH");
    assert_eq!(std::fs::read(&key_file).unwrap(), expected_key);
    ctx.cleanup_box(&id);
}

/// An installed alias executes through real OpenSSH and reinstalls idempotently.
#[tokio::test]
async fn ssh_local_install_config() {
    let ctx = common::boxlite();
    let user_home = tempfile::tempdir().unwrap();
    let created = ctx
        .new_cmd()
        .args([
            "run",
            "-d",
            "--name",
            "installed-ssh",
            "alpine:latest",
            "sleep",
            "600",
        ])
        .output()
        .unwrap();
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let id = String::from_utf8_lossy(&created.stdout).trim().to_string();
    let install = || {
        let mut command = ctx.new_cmd();
        command.env("HOME", user_home.path()).args([
            "ssh",
            "installed-ssh",
            "--install-ssh-config",
        ]);
        command
    };
    install()
        .assert()
        .success()
        .stdout(predicates::str::is_empty());
    let status = || {
        output_status(
            &ctx.new_cmd()
                .args(["ssh", "--status", &id])
                .output()
                .unwrap(),
            "installed SSH status",
        )
    };
    let first = status();
    assert!(first.enabled);
    let key_dir = ctx.home.join("boxes").join(&id).join("ssh");
    let client_key = std::fs::read(key_dir.join("client_key")).unwrap();
    let host_key = std::fs::read(key_dir.join("host_key")).unwrap();
    let managed_config = std::fs::read(user_home.path().join(".boxlite/ssh/config")).unwrap();
    let user_config = std::fs::read(user_home.path().join(".ssh/config")).unwrap();
    let shell = Command::new("ssh")
        .env("HOME", user_home.path())
        .arg("-F")
        .arg(user_home.path().join(".ssh/config"))
        .args(["installed-ssh", "printf 'installed-ssh-ok\\n'; exit 42"])
        .output()
        .unwrap();
    assert_eq!(
        shell.status.code(),
        Some(42),
        "{}",
        String::from_utf8_lossy(&shell.stderr)
    );
    assert_eq!(shell.stdout, b"installed-ssh-ok\n");
    install()
        .assert()
        .success()
        .stdout(predicates::str::is_empty());
    assert_eq!(status(), first, "healthy reinstall must not change SSH");
    assert_eq!(
        std::fs::read(key_dir.join("client_key")).unwrap(),
        client_key
    );
    assert_eq!(std::fs::read(key_dir.join("host_key")).unwrap(), host_key);
    assert_eq!(
        std::fs::read(user_home.path().join(".boxlite/ssh/config")).unwrap(),
        managed_config
    );
    assert_eq!(
        std::fs::read(user_home.path().join(".ssh/config")).unwrap(),
        user_config
    );
    ctx.cleanup_box(&id);
}

/// Remove boxes even when an assertion panics; declared after `ServeChild` so
/// it drops first, while the server can still service the removal.
struct ServeBoxes<'a> {
    serve: &'a ServeChild,
    ids: Vec<String>,
}

impl Drop for ServeBoxes<'_> {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            let _ = self.serve.client(&["rm", "--force", &id]);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_serve_controls_and_forward_failure() {
    let serve = ServeChild::start();
    let mut boxes = ServeBoxes {
        serve: &serve,
        ids: Vec::new(),
    };
    let keys = Keys::new();
    let config_dir = tempfile::tempdir().unwrap();
    let config = config_dir.path().join("ssh.json");
    let user_key = std::fs::read_to_string(keys.user_public()).unwrap();
    std::fs::write(
        &config,
        serde_json::json!({
            "listen_address": "0.0.0.0:2222",
            "host_private_key": std::fs::read_to_string(&keys.host).unwrap(),
            "accounts": [
                {"login": "alice", "authorized_keys": [user_key.trim()]},
                {"login": "bob", "authorized_keys": [user_key.trim()]}
            ]
        })
        .to_string(),
    )
    .unwrap();
    let config = config.to_str().unwrap();

    let run = serve.client(&["run", "-d", "alpine:latest", "sleep", "600"]);
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let id = String::from_utf8_lossy(&run.stdout).trim().to_string();
    boxes.ids.push(id.clone());
    let status = |what| output_status(&serve.client(&["ssh", "--status", &id]), what);

    assert!(!status("initial status").enabled);
    let configured = output_status(
        &serve.client(&["ssh", "--configure", &id, "--ssh-config", config]),
        "--configure",
    );
    assert!(configured.enabled);
    assert_eq!(status("--status"), configured);

    // serve has no tunnel route; forwarding fails without changing configuration.
    let forward = serve.client(&["ssh", "--tunnel", &id]);
    assert!(!forward.status.success());
    // The missing tunnel route returns a bare 404, unlike SSH handler errors.
    assert_eq!(
        String::from_utf8_lossy(&forward.stderr).trim(),
        "Error: not found:"
    );
    assert_eq!(status("status after failed forward"), configured);

    assert!(!output_status(&serve.client(&["ssh", "--disable", &id]), "--disable").enabled);
    assert!(!status("status after disable").enabled);

    drop(boxes);
    serve.wait_until_no_boxes();
}
