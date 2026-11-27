use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use super::CloudScope;
use crate::jailer::cgroup::{self, CgroupConfig};
use crate::runtime::id::BoxID;
use crate::util::ProcessIdentity;

const PEER_SOCKET: &str = "BOXLITE_TEST_CLOUD_SCOPE_SOCKET";
const PEER_SCOPE: &str = "BOXLITE_TEST_CLOUD_SCOPE_RESPONSE";

struct Peer(Child);

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start_peer(data_socket: &Path, scope: &CloudScope) -> Peer {
    let control = super::super::control_socket_path(data_socket);
    let (_, module) = module_path!().split_once("::").unwrap();
    let test_name = format!("{module}::cloud_scope_control_peer");
    let peer = Peer(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &test_name, "--ignored"])
            .env(PEER_SOCKET, &control)
            .env(PEER_SCOPE, serde_json::to_string(scope).unwrap())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while !control.exists() {
        assert!(Instant::now() < deadline, "control peer did not bind");
        std::thread::sleep(Duration::from_millis(10));
    }
    peer
}

#[test]
#[ignore = "subprocess helper"]
fn cloud_scope_control_peer() {
    let Some(path) = std::env::var_os(PEER_SOCKET) else {
        return;
    };
    let body = std::env::var(PEER_SCOPE).unwrap();
    let listener = UnixListener::bind(PathBuf::from(path)).unwrap();
    for mut stream in listener.incoming().map(Result::unwrap) {
        let mut request = BufReader::new(&stream);
        let mut line = String::new();
        if request.read_line(&mut line).unwrap() == 0 {
            continue;
        }
        assert_eq!(line, "GET /network/cloud-scope HTTP/1.1\r\n");
        while {
            line.clear();
            request.read_line(&mut line).unwrap() != 0 && line != "\r\n"
        } {}
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
    }
}

#[tokio::test]
#[ignore = "requires a dedicated Linux host with writable cgroup v2"]
async fn cloud_scope_adoption_checks_the_real_unix_peer_and_cgroup() {
    let id = BoxID::parse(&format!("scope-{}", uuid::Uuid::new_v4().simple())).unwrap();
    let scope: CloudScope = serde_json::from_value(serde_json::json!({
        "version": 1, "stage": "dev", "runner": "10.0.0.0/24",
        "cloud_run": "10.0.1.0/24", "managed_proxy": "10.0.2.0/24",
        "gke_pods": "10.0.3.0/24", "gke_services": "10.0.4.0/24",
        "private_services": "10.0.5.0/24",
    }))
    .unwrap();
    let launch = scope.for_box(id.as_str());
    let live_dir = tempfile::tempdir().unwrap();
    let other_dir = tempfile::tempdir().unwrap();
    let live_socket = live_dir.path().join("data.sock");
    let other_socket = other_dir.path().join("data.sock");
    let mut live = start_peer(&live_socket, &launch);
    let mut other = start_peer(&other_socket, &launch);
    cgroup::setup_cgroup(id.as_str(), &CgroupConfig::default()).unwrap();
    cgroup::add_process(id.as_str(), live.0.id()).unwrap();
    let launcher = ProcessIdentity::Verified(live.0.id());

    scope
        .verify_existing(&id, &live_socket, launcher, None)
        .await
        .unwrap();
    let error = scope
        .verify_existing(&id, &other_socket, launcher, None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("outside its cgroup"), "{error}");

    let mut changed = scope.clone();
    changed.stage = "stage".into();
    let error = changed
        .verify_existing(&id, &live_socket, launcher, None)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("different managed Cloud scope"),
        "{error}"
    );
    let outside = ProcessIdentity::Verified(other.0.id());
    assert!(
        CloudScope::isolate_rejected(&id, outside, &error)
            .await
            .is_err()
    );
    assert!(other.0.try_wait().unwrap().is_none());
    CloudScope::isolate_rejected(&id, launcher, &error)
        .await
        .unwrap();
    assert!(!live.0.wait().unwrap().success());
    assert!(other.0.try_wait().unwrap().is_none());
    cgroup::remove_cgroup(id.as_str()).unwrap();
}
