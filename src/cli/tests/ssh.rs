//! `boxlite ssh` against real VMs.
//!
//! Locally, a `russh` client logs in through the CLI's forwarder; across
//! repeated `forward` runs, the guest listener keeps its generation, Ctrl-C frees the
//! local port and leaves SSH enabled, and disable stops new logins. Against
//! `boxlite serve`, which has SSH control but no tunnel route, the controls
//! round-trip and a failed `forward` leaves the configuration unchanged.
//!
//! Argument relations, credential redaction, and request counts are covered
//! without a VM in `src/cli/src/commands/ssh/tests/`.

mod common;

use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpListener};
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
    let status = |what| output_status(&ssh(&["status", &id]).output().unwrap(), what);

    assert!(!status("initial status").enabled);

    let mut configure = ssh(&["configure", &id]);
    configure.args(keys.flags("alice"));
    let configured = output_status(&configure.output().unwrap(), "configure");
    assert!(configured.enabled);
    assert_eq!(configured.listen_address, "0.0.0.0:2222");

    // Each `forward` only observes SSH; logins work and the listener survives.
    for _ in 0..2 {
        let mut forwarder = Forwarder::spawn(ssh(&["forward", &id]));
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
    let mut configure = ssh(&["configure", &id, "--guest-listen", "0.0.0.0:0"]);
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

    let mut forwarder = Forwarder::spawn(ssh(&["forward", &id]));
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
    let disabled = output_status(&ssh(&["disable", &id]).output().unwrap(), "disable");
    assert!(!disabled.enabled);
    let refused = ssh(&["forward", &id]).output().unwrap();
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
    let status = |what| output_status(&serve.client(&["ssh", "status", &id]), what);

    assert!(!status("initial status").enabled);
    let configured = output_status(
        &serve.client(&["ssh", "configure", &id, "--ssh-config", config]),
        "configure",
    );
    assert!(configured.enabled);
    assert_eq!(status("status"), configured);

    // serve has no tunnel route; forwarding fails without changing configuration.
    let forward = serve.client(&["ssh", "forward", &id]);
    assert!(!forward.status.success());
    // The missing tunnel route returns a bare 404, unlike SSH handler errors.
    assert_eq!(
        String::from_utf8_lossy(&forward.stderr).trim(),
        "Error: not found:"
    );
    assert_eq!(status("status after failed forward"), configured);

    assert!(!output_status(&serve.client(&["ssh", "disable", &id]), "disable").enabled);
    assert!(!status("status after disable").enabled);

    drop(boxes);
    serve.wait_until_no_boxes();
}
