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
async fn guest_ssh_exec_inherits_container_default_user() {
    let home = common::home::PerTestBoxHome::new();
    let keys = tempfile::TempDir::new_in("/tmp").unwrap();
    let host_key = keys.path().join("host");
    let user_key = keys.path().join("user");
    generate_key(&host_key, "host").await;
    generate_key(&user_key, "user").await;
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .unwrap();
    let mut options = common::alpine_opts();
    options.user = Some("12345:12346".into());
    options.ports = vec![PortSpec {
        host_port: None,
        guest_port: 2222,
        protocol: PortProtocol::Tcp,
        host_ip: Some("127.0.0.1".into()),
    }];
    let sandbox = runtime.create(options, None).await.unwrap();
    sandbox.start().await.unwrap();
    let socket = home
        .path
        .join("boxes")
        .join(sandbox.id().as_str())
        .join("sockets/box.sock");
    let mut ssh = SshClient::new(connect_rpc(socket).await.unwrap());
    let status = ssh
        .configure(SshConfigureRequest {
            config: Some(SshConfig {
                listen_address: "0.0.0.0:2222".into(),
                host_private_key: std::fs::read_to_string(&host_key).unwrap(),
                accounts: vec![boxlite_shared::SshAccount {
                    login: "root".into(),
                    ca: None,
                    authorized_keys: vec![
                        std::fs::read_to_string(user_key.with_extension("pub")).unwrap(),
                    ],
                }],
            }),
        })
        .await
        .unwrap()
        .into_inner()
        .status
        .unwrap();
    let port = sandbox
        .info()
        .await
        .unwrap()
        .network
        .unwrap()
        .published_ports
        .unwrap()[0]
        .host_port;
    let known_hosts = keys.path().join("known_hosts");
    std::fs::write(
        &known_hosts,
        format!("[127.0.0.1]:{port} {}\n", status.host_public_key),
    )
    .unwrap();
    let mut exec = client_command("ssh", &user_key, &known_hosts, port);
    exec.args(["root@127.0.0.1", "id -u; id -g"]);
    let output = checked_output(exec).await;
    sandbox.stop().await.unwrap();
    assert_eq!(
        output, b"12345\n12346\n",
        "SSH must inherit the container user"
    );
}

async fn container_output(sandbox: &boxlite::LiteBox, script: &str) -> String {
    use tokio_stream::StreamExt;
    let mut execution = sandbox
        .exec(
            boxlite::BoxCommand::new("sh")
                .args(["-c", script])
                .user("0:0"),
        )
        .await
        .unwrap();
    let mut stdout = execution.stdout().unwrap();
    let mut output = String::new();
    while let Some(chunk) = stdout.next().await {
        output.push_str(&chunk);
    }
    assert!(execution.wait().await.unwrap().success());
    output
}

async fn rejected_output(mut command: Command) -> std::process::Output {
    command.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .expect("rejected SSH command timed out")
        .unwrap();
    assert!(
        !output.status.success(),
        "SSH command unexpectedly succeeded"
    );
    output
}

async fn check_direct_socket_permissions(
    sandbox: &boxlite::LiteBox,
    key: &Path,
    known_hosts: &Path,
    port: u16,
    local_socket: &Path,
) {
    use tokio_stream::StreamExt;
    let mut server = sandbox.exec(boxlite::BoxCommand::new("python3").args([
        "-u", "-c",
        "import socket,os; s=socket.socket(socket.AF_UNIX); s.bind('/root/ssh-private/service.sock'); os.chmod('/root/ssh-private/service.sock',0o777); s.listen(); print('ready'); c,_=s.accept(); c.sendall(b'connected'); c.close()",
    ]).user("0:0")).await.unwrap();
    let mut ready = server.stdout().unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(10), ready.next())
            .await
            .unwrap()
            .unwrap()
            .contains("ready")
    );
    let mut forward = client_command("ssh", key, known_hosts, port);
    forward
        .args(["-o", "ExitOnForwardFailure=yes", "-L"])
        .arg(format!(
            "{}:/root/ssh-private/service.sock",
            local_socket.display()
        ))
        .args(["alice@127.0.0.1", "echo ready; read finish"])
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut forward = forward.spawn().unwrap();
    let mut output = tokio::io::BufReader::new(forward.stdout.take().unwrap());
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(10), output.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line.trim(), "ready");
    let mut denied = tokio::net::UnixStream::connect(local_socket).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), denied.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(
        response.is_empty(),
        "non-root helper must not reach the private socket"
    );
    // The same live socket must become reachable once DAC permits traversal.
    container_output(sandbox, "chmod 755 /root /root/ssh-private").await;
    let mut allowed = tokio::net::UnixStream::connect(local_socket).await.unwrap();
    let mut greeting = [0; 9];
    tokio::time::timeout(Duration::from_secs(10), allowed.read_exact(&mut greeting))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&greeting, b"connected");
    drop(allowed);
    assert!(server.wait().await.unwrap().success());
    forward
        .stdin
        .take()
        .unwrap()
        .write_all(b"done\n")
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(10), forward.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

#[tokio::test]
async fn guest_ssh_accounts_share_identity_and_file_permissions() {
    let home = common::home::PerTestBoxHome::new();
    let keys = tempfile::TempDir::new_in("/tmp").unwrap();
    let host_key = keys.path().join("host");
    let alice_key = keys.path().join("alice");
    let bob_key = keys.path().join("bob");
    for key in [&host_key, &alice_key, &bob_key] {
        generate_key(key, "test").await;
    }
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .unwrap();
    // The numeric case deliberately has no passwd entry. The named case
    // provisions one after init, before the SSH process enters the container.
    for (user, name, user_home, shell) in [
        (None, "root", "/root", "/bin/sh"),
        (Some("12345:12346"), "12345", "/", "/bin/sh"),
        (Some("12345:12346"), "app", "/home/app", "/opt/ssh/sh"),
    ] {
        let mut options = common::alpine_opts();
        options.user = user.map(str::to_owned);
        if name == "app" {
            options.rootfs = boxlite::runtime::options::RootfsSpec::Image("python:alpine".into());
        }
        options.ports = vec![PortSpec {
            host_port: None,
            guest_port: 2222,
            protocol: PortProtocol::Tcp,
            host_ip: Some("127.0.0.1".into()),
        }];
        let sandbox = runtime.create(options, None).await.unwrap();
        sandbox.start().await.unwrap();
        if name == "app" {
            container_output(&sandbox, "mkdir -p /home/app; chown 12345:12346 /home/app; mkdir -p /opt/ssh; ln -s /bin/sh /opt/ssh/sh; printf 'app:x:12345:12346::/home/app:/opt/ssh/sh\\n' >> /etc/passwd").await;
        }
        container_output(&sandbox, "mkdir -p /root/ssh-private; chmod 700 /root/ssh-private; printf private > /root/ssh-private/proof").await;
        let socket = home
            .path
            .join("boxes")
            .join(sandbox.id().as_str())
            .join("sockets/box.sock");
        let mut ssh = SshClient::new(connect_rpc(socket).await.unwrap());
        let mut configuration = SshConfig {
            listen_address: "0.0.0.0:2222".into(),
            host_private_key: std::fs::read_to_string(&host_key).unwrap(),
            accounts: [("alice", &alice_key), ("bob", &bob_key)]
                .into_iter()
                .map(|(login, key)| boxlite_shared::SshAccount {
                    login: login.into(),
                    authorized_keys: vec![
                        std::fs::read_to_string(key.with_extension("pub")).unwrap(),
                    ],
                    ca: None,
                })
                .collect(),
        };
        let status = ssh
            .configure(SshConfigureRequest {
                config: Some(configuration.clone()),
            })
            .await
            .unwrap()
            .into_inner()
            .status
            .unwrap();
        let port = sandbox
            .info()
            .await
            .unwrap()
            .network
            .unwrap()
            .published_ports
            .unwrap()[0]
            .host_port;
        let known_hosts = keys.path().join("known_hosts");
        std::fs::write(
            &known_hosts,
            format!("[127.0.0.1]:{port} {}\n", status.host_public_key),
        )
        .unwrap();
        let (uid, gid) = if user.is_some() {
            (12345, 12346)
        } else {
            (0, 0)
        };
        for (login, key) in [("alice", &alice_key), ("bob", &bob_key)] {
            for pty in [false, true] {
                let mut exec = client_command("ssh", key, &known_hosts, port);
                if pty {
                    exec.arg("-tt");
                }
                exec.args([
                    "-o",
                    "SetEnv=USER=attacker LOGNAME=attacker HOME=/attacker SHELL=/attacker",
                ]);
                exec.arg(format!("{login}@127.0.0.1")).arg("printf '%s:%s:%s:%s:%s:%s' \"$(id -u)\" \"$(id -g)\" \"$USER\" \"$LOGNAME\" \"$HOME\" \"$SHELL\"");
                assert_eq!(
                    String::from_utf8(checked_output(exec).await).unwrap(),
                    format!("{uid}:{gid}:{name}:{name}:{user_home}:{shell}")
                );
            }
            let upload = keys.path().join("upload");
            let download = keys.path().join("download");
            let batch = keys.path().join("batch");
            std::fs::write(&upload, b"shared identity").unwrap();
            std::fs::write(
                &batch,
                format!(
                    "pwd\nput {} /tmp/ssh-{login}\nget /tmp/ssh-{login} {}\n",
                    upload.display(),
                    download.display()
                ),
            )
            .unwrap();
            let mut sftp = client_command("sftp", key, &known_hosts, port);
            sftp.arg("-b").arg(&batch).arg(format!("{login}@127.0.0.1"));
            let output = String::from_utf8(checked_output(sftp).await).unwrap();
            assert!(
                output.contains(&format!("Remote working directory: {user_home}")),
                "{output}"
            );
            assert_eq!(std::fs::read(download).unwrap(), b"shared identity");
            assert_eq!(
                container_output(&sandbox, &format!("stat -c '%u:%g' /tmp/ssh-{login}"))
                    .await
                    .trim(),
                format!("{uid}:{gid}")
            );
            if user.is_some() {
                let process_status = keys.path().join("helper-status");
                std::fs::write(
                    &batch,
                    format!("get /proc/self/status {}\n", process_status.display()),
                )
                .unwrap();
                let mut sftp = client_command("sftp", key, &known_hosts, port);
                sftp.arg("-b").arg(&batch).arg(format!("{login}@127.0.0.1"));
                checked_output(sftp).await;
                let process_status = std::fs::read_to_string(process_status).unwrap();
                for capability_set in ["CapEff", "CapPrm", "CapInh", "CapAmb"] {
                    assert!(
                        process_status.contains(&format!("{capability_set}:\t0000000000000000")),
                        "{process_status}"
                    );
                }
                let bounding = process_status
                    .lines()
                    .find(|line| line.starts_with("CapBnd:"))
                    .unwrap();
                assert!(
                    !bounding.ends_with("0000000000000000"),
                    "bounding set must be preserved"
                );
                std::fs::write(
                    &batch,
                    format!("put {} /root/ssh-private/forbidden\n", upload.display()),
                )
                .unwrap();
                let mut denied = client_command("sftp", key, &known_hosts, port);
                denied
                    .arg("-b")
                    .arg(&batch)
                    .arg(format!("{login}@127.0.0.1"));
                let output = rejected_output(denied).await;
                assert!(String::from_utf8_lossy(&output.stderr).contains("Permission denied"));
                let mut denied = client_command("ssh", key, &known_hosts, port);
                denied.args([
                    "-o",
                    "ExitOnForwardFailure=yes",
                    "-R",
                    "/root/ssh-private/relay.sock:127.0.0.1:9",
                ]);
                denied.arg(format!("{login}@127.0.0.1")).arg("true");
                let output = rejected_output(denied).await;
                assert!(
                    String::from_utf8_lossy(&output.stderr)
                        .contains("remote port forwarding failed")
                );
            }
        }
        for (login, key) in [
            ("alice", &bob_key),
            ("bob", &alice_key),
            ("unknown", &alice_key),
        ] {
            let mut denied = client_command("ssh", key, &known_hosts, port);
            denied.arg(format!("{login}@127.0.0.1")).arg("true");
            let output = rejected_output(denied).await;
            assert!(String::from_utf8_lossy(&output.stderr).contains("Permission denied"));
        }
        // A legacy configuration decodes without accounts; it must not stop
        // the running service or invent a root login.
        let mut invalid = configuration.clone();
        invalid.accounts.clear();
        let error = ssh
            .configure(SshConfigureRequest {
                config: Some(invalid),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::InvalidArgument);
        assert!(error.message().contains("accounts"));
        assert_eq!(
            ssh.status(SshStatusRequest {})
                .await
                .unwrap()
                .into_inner()
                .status
                .unwrap(),
            status
        );
        if name == "app" {
            check_direct_socket_permissions(
                &sandbox,
                &alice_key,
                &known_hosts,
                port,
                &keys.path().join("direct.sock"),
            )
            .await;
        }
        configuration.accounts.remove(0);
        ssh.configure(SshConfigureRequest {
            config: Some(configuration),
        })
        .await
        .unwrap();
        let mut denied = client_command("ssh", &alice_key, &known_hosts, port);
        denied.args(["alice@127.0.0.1", "true"]);
        rejected_output(denied).await;
        let mut accepted = client_command("ssh", &bob_key, &known_hosts, port);
        accepted.args(["bob@127.0.0.1", "true"]);
        checked_output(accepted).await;
        if name == "app" {
            container_output(&sandbox, "rm /opt/ssh/sh").await;
            let mut missing_shell = client_command("ssh", &bob_key, &known_hosts, port);
            missing_shell.args(["bob@127.0.0.1", "true"]);
            let output = rejected_output(missing_shell).await;
            // Startup errors are reported as SSH channel-request failures;
            // session unit tests check the detailed error's shell path.
            assert_eq!(output.status.code(), Some(255));
            assert!(String::from_utf8_lossy(&output.stderr).contains("exec request failed"));
            container_output(&sandbox, "ln -s /bin/sh /opt/ssh/sh").await;
            let mut restored_shell = client_command("ssh", &bob_key, &known_hosts, port);
            restored_shell.args(["bob@127.0.0.1", "true"]);
            checked_output(restored_shell).await;
        }
        sandbox.stop().await.unwrap();
    }
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
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
        accounts: vec![boxlite_shared::SshAccount {
            login: "root".into(),
            ca: None,
            authorized_keys: vec![user_public],
        }],
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
            let mut blocked_input = None;
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
                    .stdin(std::process::Stdio::piped())
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
                if !tty {
                    let mut input = child.stdin.take().unwrap();
                    let payload = vec![b'x'; 16 * 1024 * 1024];
                    assert!(
                        tokio::time::timeout(Duration::from_secs(1), input.write_all(&payload))
                            .await
                            .is_err(),
                        "the non-reading SSH process must apply stdin backpressure"
                    );
                    blocked_input = Some(input);
                }
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
            tokio::time::timeout(Duration::from_secs(15), async {
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
            })
            .await
            .expect("SSH control must complete while stdin is backpressured");
            drop(blocked_input);
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
            if disable {
                ssh.configure(SshConfigureRequest {
                    config: Some(config.clone()),
                })
                .await
                .unwrap();
            }
            let mut fresh = client_command("ssh", &user_key, &known_hosts, port);
            fresh.args(["root@127.0.0.1", "printf fresh-ssh-ok"]);
            assert_eq!(checked_output(fresh).await, b"fresh-ssh-ok");
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
