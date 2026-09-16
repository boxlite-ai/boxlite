//! Real-VM coverage of startup SSH injection and container execution.

mod common;

use boxlite::runtime::options::PortSpec;
use boxlite::{BoxliteOptions, BoxliteRuntime, PortProtocol, SshConfig};
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;

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

async fn generate_key(path: &Path) {
    let mut command = Command::new("ssh-keygen");
    command
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
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
async fn guest_ssh_public_key_exec_pty_sftp_survive_vm_restart() {
    let home = common::home::PerTestBoxHome::new();
    let keys = tempfile::TempDir::new_in("/tmp").unwrap();
    let host_key = keys.path().join("host");
    let user_key = keys.path().join("user");
    generate_key(&host_key).await;
    generate_key(&user_key).await;
    let host_public = std::fs::read_to_string(host_key.with_extension("pub")).unwrap();
    let user_public = std::fs::read_to_string(user_key.with_extension("pub")).unwrap();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .unwrap();
    let mut options = common::alpine_opts();
    options.ssh_config = Some(SshConfig {
        listen_address: "0.0.0.0:2222".into(),
        host_private_key: std::fs::read_to_string(&host_key).unwrap(),
        ca: None,
        authorized_keys: vec![user_public],
    });
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
        std::fs::write(&known_hosts, format!("[127.0.0.1]:{port} {host_public}")).unwrap();

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
        sandbox.stop().await.unwrap();
        sandbox = runtime.get("guest-ssh").await.unwrap().unwrap();
    }
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}
