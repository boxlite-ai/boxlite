//! Exercise descriptor receipt after sandbox entry in a separate test process.

use super::ipc::ControlChannel;
use crate::vmm::ssh_forwarder::listener::Listener;
use landlock::{ABI, Access, AccessFs, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus};
use std::net::SocketAddr;
use std::os::fd::OwnedFd;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixListener, UnixStream};

#[tokio::test]
async fn ssh_linux_sandbox_receives_listener_fds() {
    if let Some(control) = std::env::var_os("BOXLITE_SSH_SANDBOX_CONTROL") {
        sandbox_child(Path::new(&control)).await;
        // The seccomp filter belongs to the child operation, not test-harness teardown.
        std::process::exit(0);
    }

    for bind_address in ["127.0.0.1:0", "[::1]:0"] {
        let home = tempfile::tempdir().unwrap();
        let control_path = home.path().join("control.sock");
        let control = UnixListener::bind(&control_path).unwrap();
        let guest = UnixListener::bind(home.path().join("guest.sock")).unwrap();
        let listener = std::net::TcpListener::bind(bind_address).unwrap();
        let address = listener.local_addr().unwrap();
        let descriptor: OwnedFd = listener.into();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["ssh_linux_sandbox_receives_listener_fds", "--nocapture"])
            .env("BOXLITE_SSH_SANDBOX_CONTROL", &control_path)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut channel = ControlChannel(control.accept().await.unwrap().0);
            channel.send(&address, Some(&descriptor)).await.unwrap();
            drop(descriptor);
            let (enforced, received): (bool, _) = match channel.receive().await {
                Ok(response) => response,
                Err(error) => panic!(
                    "sandbox listener handoff failed: {error}; child status: {}",
                    child.wait().await.unwrap()
                ),
            };
            assert!(
                enforced,
                "environment blocker: Landlock is not fully enforced"
            );
            assert!(received.is_none());
            let mut client = TcpStream::connect(address).await.unwrap();
            let mut guest = guest.accept().await.unwrap().0;
            let workload = async {
                let mut bytes = Vec::new();
                guest.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, vec![0x53; 1024 * 1024]);
                guest.write_all(b"reply after half-close").await.unwrap();
                guest.shutdown().await.unwrap();
            };
            let request = async {
                client.write_all(&vec![0x53; 1024 * 1024]).await.unwrap();
                client.shutdown().await.unwrap();
                let mut bytes = Vec::new();
                client.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, b"reply after half-close");
            };
            tokio::join!(workload, request);
            assert!(child.wait().await.unwrap().success());
        })
        .await
        .expect("sandboxed FD receipt and forwarding did not finish");
    }
}

async fn sandbox_child(control_path: &Path) {
    let home = control_path.parent().unwrap();
    let mut control = ControlChannel(UnixStream::connect(control_path).await.unwrap());
    let ruleset = Ruleset::default()
        .handle_access(AccessFs::from_all(ABI::V1))
        .unwrap()
        .create()
        .unwrap();
    let status = ruleset.restrict_self().unwrap();
    if status.ruleset != RulesetStatus::FullyEnforced {
        control.send(&false, None).await.unwrap();
        return;
    }
    assert!(std::fs::write(home.join("forbidden"), b"no").is_err());
    crate::jailer::seccomp::apply_vmm_filter("ssh-sandbox-test").unwrap();
    let (expected, descriptor): (SocketAddr, _) = control.receive().await.unwrap();
    let listener = Listener::from_fd(descriptor.unwrap(), &expected).unwrap();
    control.send(&true, None).await.unwrap();
    let mut guest = UnixStream::connect(home.join("guest.sock")).await.unwrap();
    let mut client = listener.accept().await.unwrap();
    tokio::io::copy_bidirectional(&mut client, &mut guest)
        .await
        .unwrap();
}

#[tokio::test]
async fn ssh_linux_sandbox_drops_shim_server_and_removes_control_socket() {
    use super::ShimServer;
    use crate::net::socket_path::BoxSockets;
    use landlock::{PathBeneath, PathFd};

    if let Some(home) = std::env::var_os("BOXLITE_SSH_SANDBOX_DROP_HOME") {
        let home = Path::new(&home);
        let sockets = BoxSockets::new(format!("drop-{}", std::process::id()), home.join("sockets"));
        std::fs::create_dir(sockets.real_dir()).unwrap();
        sockets.ensure().unwrap();
        let status = Ruleset::default()
            .handle_access(AccessFs::from_all(ABI::V1))
            .unwrap()
            .create()
            .unwrap()
            .add_rule(PathBeneath::new(
                PathFd::new(home).unwrap(),
                AccessFs::from_all(ABI::V1),
            ))
            .unwrap()
            .restrict_self()
            .unwrap();
        assert_eq!(
            status.ruleset,
            RulesetStatus::FullyEnforced,
            "environment blocker: Landlock unavailable"
        );
        assert!(std::fs::write(home.parent().unwrap().join("ssh-forbidden"), b"denied").is_err());
        let shim_server = ShimServer::start(sockets.clone(), false).unwrap();
        let control_path = sockets.shim_sock();
        assert!(control_path.exists());
        crate::jailer::seccomp::apply_vmm_filter("ssh-drop-test").unwrap();
        drop(shim_server);
        assert!(
            !control_path.exists(),
            "SSH control socket survived shim_server Drop"
        );
        // Only the shim_server's teardown is subject to the VMM filter.
        std::process::exit(0);
    }
    let home = tempfile::tempdir().unwrap();
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "ssh_linux_sandbox_drops_shim_server_and_removes_control_socket",
            "--nocapture",
        ])
        .env("BOXLITE_SSH_SANDBOX_DROP_HOME", home.path())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .expect("sandboxed shim_server did not exit")
        .unwrap();
    assert!(
        status.success(),
        "sandboxed ShimServer Drop failed: {status}"
    );
    assert!(!home.path().join("sockets/shim.sock").exists());
}
