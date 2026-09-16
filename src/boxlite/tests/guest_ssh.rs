//! Real-VM coverage of SSH control over box.sock and container execution.

mod common;

use boxlite::runtime::options::PortSpec;
use boxlite::{BoxliteOptions, BoxliteRuntime, PortProtocol};
use boxlite_shared::{SshClient, SshConfig, SshConfigureRequest, SshStatusRequest};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

async fn connect_rpc(
    socket: std::path::PathBuf,
) -> Result<tonic::transport::Channel, tonic::transport::Error> {
    tonic::transport::Endpoint::from_static("http://[::]:50051")
        .connect_with_connector(tower::service_fn(move |_: tonic::transport::Uri| {
            let socket = socket.clone();
            async move {
                tokio::net::UnixStream::connect(socket)
                    .await
                    .map(hyper_util::rt::TokioIo::new)
            }
        }))
        .await
}

async fn checked_output(mut command: Command) -> Vec<u8> {
    command.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .expect("SSH command timed out")
        .expect("start OpenSSH command");
    assert!(
        output.status.success(),
        "OpenSSH command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

async fn generate_key(path: &Path, comment: &str) {
    let mut command = Command::new("ssh-keygen");
    command
        .args(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f"])
        .arg(path);
    checked_output(command).await;
}

fn client_command(program: &str, key: &Path, known_hosts: &Path, port: u16) -> Command {
    let mut command = Command::new(program);
    command.args([
        "-F",
        "/dev/null",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
    ]);
    command.args([
        "-o",
        "IdentityAgent=none",
        "-o",
        "StrictHostKeyChecking=yes",
    ]);
    command
        .arg("-o")
        .arg(format!("UserKnownHostsFile={}", known_hosts.display()));
    command.args(["-o", "ConnectTimeout=10", "-i"]).arg(key);
    command
        .arg(if program == "sftp" { "-P" } else { "-p" })
        .arg(port.to_string());
    command
}

#[tokio::test]
async fn guest_ssh_rpc_exec_pty_sftp_reconnect_and_vm_restart() {
    let home = common::home::PerTestBoxHome::new();
    let keys = tempfile::TempDir::new_in("/tmp").unwrap();
    let host_key = keys.path().join("host");
    let user_key = keys.path().join("user");
    generate_key(&host_key, "host\r\ncomment").await;
    generate_key(&user_key, "user").await;
    let host_public = std::fs::read_to_string(host_key.with_extension("pub")).unwrap();
    let user_public = std::fs::read_to_string(user_key.with_extension("pub")).unwrap();
    let mut runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .unwrap();
    let mut options = common::alpine_opts();
    options.detach = true;
    let config = SshConfig {
        listen_address: "0.0.0.0:2222".into(),
        host_private_key: std::fs::read_to_string(&host_key).unwrap(),
        ca: None,
        authorized_keys: vec![user_public],
    };
    options.ports = vec![PortSpec {
        host_port: None,
        guest_port: 2222,
        protocol: PortProtocol::Tcp,
        host_ip: Some("127.0.0.1".into()),
    }];
    let mut sandbox = runtime
        .create(options, Some("guest-ssh".into()))
        .await
        .unwrap();
    for _ in 0..2 {
        sandbox.start().await.unwrap();
        let info = sandbox.info().await.unwrap();
        let socket = home
            .path
            .join("boxes")
            .join(sandbox.id().as_str())
            .join("sockets/box.sock");
        let channel = connect_rpc(socket.clone()).await.unwrap();
        let mut ssh = SshClient::new(channel);
        let disabled = ssh
            .status(SshStatusRequest {})
            .await
            .unwrap()
            .into_inner()
            .status
            .unwrap();
        assert!(!disabled.enabled, "new VM must start with SSH disabled");
        assert_eq!(disabled.generation, 0);
        let status = ssh
            .configure(SshConfigureRequest {
                config: Some(config.clone()),
            })
            .await
            .unwrap()
            .into_inner()
            .status
            .unwrap();
        drop(ssh);
        drop(sandbox);
        drop(runtime);
        runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();
        sandbox = runtime.get("guest-ssh").await.unwrap().unwrap();
        sandbox.start().await.unwrap();
        let reattached = sandbox.info().await.unwrap();
        assert_eq!(reattached.pid, info.pid);
        let channel = connect_rpc(socket).await.unwrap();
        let mut ssh = SshClient::new(channel);
        assert_eq!(
            ssh.status(SshStatusRequest {})
                .await
                .unwrap()
                .into_inner()
                .status
                .unwrap(),
            status
        );
        let reported_public = &status.host_public_key;
        // The API key must be safe to place on one known_hosts line even
        // when the configured private key contains a multiline comment.
        assert!(!reported_public.contains(['\r', '\n']));
        assert_eq!(
            reported_public.as_str(),
            host_public
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
                .join(" ")
        );
        let published = sandbox
            .info()
            .await
            .unwrap()
            .network
            .unwrap()
            .published_ports
            .unwrap();
        assert_eq!(published.len(), 1, "SSH must not publish additional ports");
        let port = published[0].host_port;
        let known_hosts = keys.path().join("known_hosts");
        std::fs::write(
            &known_hosts,
            format!("[127.0.0.1]:{port} {reported_public}\n"),
        )
        .unwrap();

        let mut exec = client_command("ssh", &user_key, &known_hosts, port);
        exec.args(["root@127.0.0.1", "printf ssh-exec-ok"]);
        assert_eq!(checked_output(exec).await, b"ssh-exec-ok");

        let mut pty = client_command("ssh", &user_key, &known_hosts, port);
        pty.args(["-tt", "root@127.0.0.1", "test -t 0 && printf ssh-pty-ok"]);
        assert_eq!(checked_output(pty).await, b"ssh-pty-ok");

        let upload = keys.path().join("upload");
        let download = keys.path().join("download");
        let batch = keys.path().join("sftp.batch");
        std::fs::write(&upload, b"SSH SFTP round trip\n").unwrap();
        std::fs::write(
            &batch,
            format!(
                "put {} /tmp/ssh-sftp-proof\nget /tmp/ssh-sftp-proof {}\n",
                upload.display(),
                download.display(),
            ),
        )
        .unwrap();
        let mut sftp = client_command("sftp", &user_key, &known_hosts, port);
        sftp.arg("-b").arg(batch).arg("root@127.0.0.1");
        checked_output(sftp).await;
        assert_eq!(std::fs::read(download).unwrap(), b"SSH SFTP round trip\n");
        let mut unrelated = sandbox
            .exec(
                boxlite::BoxCommand::new("sh").args(["-c", "read value; test \"$value\" = alive"]),
            )
            .await
            .unwrap();
        let mut unrelated_input = unrelated.stdin().unwrap();
        for disable in [false, true] {
            let mut clients = Vec::new();
            for (name, tty) in [("exec", false), ("pty", true)] {
                let mut command = client_command("ssh", &user_key, &known_hosts, port);
                if tty {
                    command.arg("-tt");
                } else {
                    command.args([
                        "-o",
                        "ExitOnForwardFailure=yes",
                        "-R",
                        "/tmp/ssh-reverse.sock:127.0.0.1:9",
                    ]);
                }
                command.arg("root@127.0.0.1").arg(format!(
                    "echo $$ > /tmp/ssh-{name}-pid; echo ready; exec sleep 300"
                ));
                command
                    .kill_on_drop(true)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null());
                let mut child = command.spawn().unwrap();
                let mut reader = tokio::io::BufReader::new(child.stdout.take().unwrap());
                let mut ready = String::new();
                tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut ready))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(ready.trim(), "ready");
                clients.push(child);
            }
            let mut sftp = client_command("ssh", &user_key, &known_hosts, port);
            sftp.args(["-s", "root@127.0.0.1", "sftp"])
                .kill_on_drop(true)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            let mut sftp = sftp.spawn().unwrap();
            let mut sftp_input = sftp.stdin.take().unwrap();
            sftp_input
                .write_all(&[0, 0, 0, 5, 1, 0, 0, 0, 3])
                .await
                .unwrap();
            let mut version = [0; 9];
            tokio::time::timeout(
                Duration::from_secs(10),
                sftp.stdout.as_mut().unwrap().read_exact(&mut version),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(&version[4..9], &[2, 0, 0, 0, 3]);
            clients.push(sftp);
            if disable {
                ssh.disable(boxlite_shared::SshDisableRequest {})
                    .await
                    .unwrap();
            } else {
                ssh.configure(SshConfigureRequest {
                    config: Some(config.clone()),
                })
                .await
                .unwrap();
            }
            for mut client in clients {
                assert!(
                    !tokio::time::timeout(Duration::from_secs(5), client.wait())
                        .await
                        .unwrap()
                        .unwrap()
                        .success()
                );
            }
            let reaped = sandbox
                .exec(boxlite::BoxCommand::new("sh").args([
                    "-c",
                    "! kill -0 $(cat /tmp/ssh-exec-pid) && ! kill -0 $(cat /tmp/ssh-pty-pid) && test ! -e /tmp/ssh-reverse.sock",
                ]))
                .await
                .unwrap();
            assert!(
                reaped.wait().await.unwrap().success(),
                "SSH processes must be reaped before control returns"
            );
        }
        unrelated_input.write_all(b"alive\n").await.unwrap();
        assert!(
            unrelated.wait().await.unwrap().success(),
            "non-SSH execution must survive Configure and Disable"
        );
        sandbox.stop().await.unwrap();

        sandbox = runtime.get("guest-ssh").await.unwrap().unwrap();
    }
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}
