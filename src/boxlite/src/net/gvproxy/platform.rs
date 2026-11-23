use std::path::{Path, PathBuf};
use std::time::Duration;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use http_body_util::{BodyExt, Empty, Limited};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Private host Runtime to shim launch data.
#[doc(hidden)]
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloudGuardBootstrap {
    pub inventory_directory: PathBuf,
    pub shim_socket: PathBuf,
    pub r#box: String,
    pub instance: String,
    pub revision: String,
    pub digest: String,
}

impl CloudGuardBootstrap {
    /// Verify the private gvproxy confirmation before the shim hands off networking.
    #[doc(hidden)]
    pub async fn confirm_gvproxy(&self, data_socket: &Path) -> BoxliteResult<()> {
        tokio::time::timeout(CONTROLLER_TIMEOUT, async {
            let stream = UnixStream::connect(super::control_socket_path(data_socket))
                .await
                .map_err(guard_error)?;
            let proof = shim_proof(stream).await?;
            if !proof.matches(&self.revision, &self.digest) {
                return Err(guard_error(
                    "gvproxy startup confirmation does not match the Cloud guard",
                ));
            }
            Ok(())
        })
        .await
        .map_err(guard_error)?
    }
}

const CONTROLLER_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct CloudGuardRuntime {
    inventory: PathBuf,
    state: PathBuf,
}

#[derive(serde::Deserialize)]
#[serde(default)]
#[derive(Default)]
struct HostProof {
    instance: String,
    revision: String,
    digest: String,
    cgroup_id: u64,
    deadline_ns: u64,
    shim_pid: u32,
    shim_start: u64,
    inventory_version: u8,
    error: Option<String>,
}

impl CloudGuardRuntime {
    pub(crate) fn from_host() -> BoxliteResult<Option<Self>> {
        let profile = std::env::var("BOXLITE_PLATFORM_GUARD_PROFILE");
        let required = std::env::var_os("BOXLITE_REQUIRE_CLOUD_GUARD").is_some();
        match profile.as_deref() {
            Ok("cloud") if cfg!(target_os = "linux") => Ok(Some(Self {
                inventory: host_path(
                    "BOXLITE_PLATFORM_GUARD_INVENTORY_DIR",
                    "/etc/boxlite/platform-guard",
                )?,
                state: host_path(
                    "BOXLITE_PLATFORM_GUARD_STATE_DIR",
                    "/run/boxlite-platform-guard",
                )?,
            })),
            Ok("local") | Err(std::env::VarError::NotPresent) if !required => Ok(None),
            _ => Err(guard_error(
                "a valid Linux Cloud platform guard profile is required",
            )),
        }
    }

    pub(crate) fn validate_jail_mounts(
        &self,
        options: &crate::runtime::options::BoxOptions,
        config: &crate::vmm::InstanceSpec,
        shim_binary: &Path,
    ) -> BoxliteResult<()> {
        if !options.advanced.security.jailer_enabled {
            return Err(guard_error("Cloud platform guard requires the jailed shim"));
        }
        let sources = options
            .volumes
            .iter()
            .map(|volume| volume.host_path.as_str())
            .filter(|source| !source.is_empty())
            .chain(
                options
                    .mounts
                    .iter()
                    .filter(|mount| mount.mount_type == crate::runtime::options::MountType::Bind)
                    .filter_map(|mount| mount.source.as_deref()),
            )
            .map(Path::new)
            .chain(
                config
                    .fs_shares
                    .shares()
                    .iter()
                    .map(|share| share.host_path.as_path()),
            )
            .chain([
                config.guest_rootfs.path.as_path(),
                config.home_dir.as_path(),
            ])
            .chain(shim_binary.parent());
        for source in sources {
            let path = std::fs::canonicalize(source).map_err(guard_error)?;
            if [&self.inventory, &self.state]
                .iter()
                .any(|authority| path.starts_with(authority) || authority.starts_with(&path))
            {
                return Err(guard_error("Box mounts overlap Cloud guard authority"));
            }
        }
        for builtin in ["/usr", "/lib", "/lib64", "/bin", "/sbin"] {
            if let Ok(path) = std::fs::canonicalize(builtin)
                && [&self.inventory, &self.state]
                    .iter()
                    .any(|authority| authority.starts_with(&path))
            {
                return Err(guard_error(
                    "Cloud guard authority overlaps the shim's system mounts",
                ));
            }
        }
        Ok(())
    }

    pub(crate) async fn prepare(
        &self,
        box_id: &str,
        data: &Path,
    ) -> BoxliteResult<CloudGuardBootstrap> {
        let instance = uuid::Uuid::new_v4().simple().to_string();
        let proof = self
            .query(serde_json::json!({
                "operation": "prepare", "box": box_id, "instance": instance, "data_socket": data,
            }))
            .await?;
        if !proof.is_current() || proof.instance != instance {
            return Err(guard_error(
                "host launch proof does not match the Box instance",
            ));
        }
        Ok(CloudGuardBootstrap {
            inventory_directory: self.inventory.clone(),
            shim_socket: self.state.join("shim/endpoint.sock"),
            r#box: box_id.to_string(),
            instance,
            revision: proof.revision,
            digest: proof.digest,
        })
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn check_readiness(&self) -> BoxliteResult<()> {
        self.inventory_version().await?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    async fn inventory_version(&self) -> BoxliteResult<u8> {
        let proof = self
            .query_with_timeout(
                serde_json::json!({"operation": "ready"}),
                Duration::from_secs(6),
            )
            .await?;
        Ok(proof.inventory_version)
    }

    pub(crate) async fn qualifies_ipv6() -> BoxliteResult<bool> {
        #[cfg(target_os = "linux")]
        if let Some(profile) = Self::from_host()? {
            return Ok(profile.inventory_version().await? == 2);
        }
        Ok(false)
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn verify_existing(
        &self,
        box_id: &crate::runtime::id::BoxID,
        data_socket: &Path,
        identity: crate::util::ProcessIdentity,
    ) -> BoxliteResult<()> {
        use crate::util::ProcessIdentity;

        let ProcessIdentity::Verified(pid) = identity else {
            return Err(guard_error("a verified outer launcher is required"));
        };
        if !crate::jailer::box_contains_launcher(box_id, pid).map_err(guard_error)? {
            return Err(guard_error("outer launcher is outside its Box cgroup"));
        }
        self.verify_live(box_id.as_str(), data_socket, None).await
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn isolate_rejected(
        box_id: &crate::runtime::id::BoxID,
        identity: crate::util::ProcessIdentity,
        error: &BoxliteError,
    ) -> BoxliteResult<()> {
        use crate::util::ProcessIdentity;

        let launcher = match identity {
            ProcessIdentity::Verified(pid) | ProcessIdentity::Legacy(pid) => Some(pid),
            ProcessIdentity::Absent => None,
        };
        crate::jailer::isolate_box(box_id, launcher)
            .await
            .map_err(|isolation| {
                guard_error(format!(
                    "cannot confirm isolation for rejected Box {box_id} ({error}): {isolation}"
                ))
            })
    }

    pub(crate) async fn release(&self, launch: &CloudGuardBootstrap) {
        if let Err(error) = self
            .query(serde_json::json!({
                "operation": "release", "box": launch.r#box, "instance": launch.instance,
            }))
            .await
        {
            tracing::warn!(%error, "Cloud guard release requires an empty verified cgroup");
        }
    }

    pub(crate) async fn verify_live(
        &self,
        box_id: &str,
        data_socket: &Path,
        launch: Option<&CloudGuardBootstrap>,
    ) -> BoxliteResult<()> {
        tokio::time::timeout(CONTROLLER_TIMEOUT, async {
            let request = serde_json::json!({"operation": "adopt", "box": box_id, "instance": ""});
            let expected = self.query(request.clone()).await?;
            if !expected.is_current()
                || expected.shim_pid == 0
                || expected.shim_start == 0
                || launch.is_some_and(|value| {
                    value.instance != expected.instance
                        || value.revision != expected.revision
                        || value.digest != expected.digest
                })
            {
                return Err(guard_error("verified live shim identity is required"));
            }
            let stream = UnixStream::connect(super::control_socket_path(data_socket))
                .await
                .map_err(guard_error)?;
            let peer = stream.peer_cred().map_err(guard_error)?.pid();
            if peer.and_then(|pid| u32::try_from(pid).ok()) != Some(expected.shim_pid) {
                return Err(guard_error(
                    "gvproxy control connection has a different shim peer",
                ));
            }
            let confirmed = shim_proof(stream).await?;
            let current = self.query(request).await?;
            if !confirmed.matches(&current.revision, &current.digest)
                || !current.is_current()
                || current.instance != expected.instance
                || current.revision != expected.revision
                || current.digest != expected.digest
                || current.cgroup_id != expected.cgroup_id
                || current.shim_pid != expected.shim_pid
                || current.shim_start != expected.shim_start
            {
                return Err(guard_error(
                    "current kernel and gvproxy guard identities differ",
                ));
            }
            Ok(())
        })
        .await
        .map_err(guard_error)?
    }

    async fn query(&self, request: serde_json::Value) -> BoxliteResult<HostProof> {
        self.query_with_timeout(request, CONTROLLER_TIMEOUT).await
    }

    async fn query_with_timeout(
        &self,
        request: serde_json::Value,
        timeout: Duration,
    ) -> BoxliteResult<HostProof> {
        tokio::time::timeout(timeout, async {
            let mut stream = UnixStream::connect(self.state.join("control.sock"))
                .await
                .map_err(guard_error)?;
            let mut body = serde_json::to_vec(&request).map_err(guard_error)?;
            body.push(b'\n');
            stream.write_all(&body).await.map_err(guard_error)?;
            let mut answer = Vec::new();
            stream
                .take(4096)
                .read_to_end(&mut answer)
                .await
                .map_err(guard_error)?;
            let proof: HostProof = serde_json::from_slice(&answer).map_err(guard_error)?;
            if let Some(error) = proof.error.as_deref() {
                return Err(guard_error(error));
            }
            Ok(proof)
        })
        .await
        .map_err(guard_error)?
    }
}

#[derive(serde::Deserialize)]
struct ShimProof {
    revision: String,
    digest: String,
    active: bool,
}

impl ShimProof {
    fn matches(&self, revision: &str, digest: &str) -> bool {
        self.active && self.revision == revision && self.digest == digest
    }
}

async fn shim_proof(stream: UnixStream) -> BoxliteResult<ShimProof> {
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(guard_error)?;
    tokio::spawn(connection);
    let request = hyper::Request::get("/network/platform-guard/status")
        .header(hyper::header::HOST, "localhost")
        .header(hyper::header::CONNECTION, "close")
        .body(Empty::<bytes::Bytes>::new())
        .map_err(guard_error)?;
    let response = sender.send_request(request).await.map_err(guard_error)?;
    if !response.status().is_success() {
        return Err(guard_error(
            "gvproxy did not confirm an active platform guard",
        ));
    }
    let body = Limited::new(response.into_body(), 4096)
        .collect()
        .await
        .map_err(guard_error)?
        .to_bytes();
    serde_json::from_slice(&body).map_err(guard_error)
}

impl HostProof {
    fn is_current(&self) -> bool {
        let mut now = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: clock_gettime writes one timespec to this pointer.
        let valid = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) } == 0;
        let now_ns = (now.tv_sec as u64).saturating_mul(1_000_000_000) + now.tv_nsec as u64;
        valid
            && self.deadline_ns > now_ns
            && self.cgroup_id != 0
            && !self.revision.is_empty()
            && self.digest.len() == 64
    }
}

fn host_path(name: &str, default: &str) -> BoxliteResult<PathBuf> {
    let path = std::env::var_os(name).map_or_else(|| PathBuf::from(default), PathBuf::from);
    if !path.is_absolute() {
        return Err(guard_error("Cloud guard paths must be absolute"));
    }
    std::fs::canonicalize(path).map_err(guard_error)
}

fn guard_error(detail: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Network(format!("Cloud platform guard: {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::UnixListener;

    fn test_launch(path: &Path) -> CloudGuardBootstrap {
        CloudGuardBootstrap {
            inventory_directory: path.into(),
            shim_socket: path.join("shim.sock"),
            r#box: "test-box".into(),
            instance: "test-instance".into(),
            revision: "policy-1".into(),
            digest: "a".repeat(64),
        }
    }

    fn serve_shim_proof(
        shim: UnixListener,
        shim_status: u16,
        body: String,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let (stream, _) = shim.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            assert_eq!(line, "GET /network/platform-guard/status HTTP/1.1\r\n");
            while line != "\r\n" {
                line.clear();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
            }
            let response = format!(
                "HTTP/1.1 {shim_status} status\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .get_mut()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        })
    }

    async fn verify_through_sockets(
        fresh: bool,
        hosts: Vec<Value>,
        shim_status: u16,
        shim_revision: &str,
    ) -> BoxliteResult<()> {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let profile = CloudGuardRuntime {
            inventory: path.into(),
            state: path.into(),
        };
        let data = path.join("net.sock");
        let host = UnixListener::bind(path.join("control.sock")).unwrap();
        let shim = UnixListener::bind(super::super::control_socket_path(&data)).unwrap();
        let launch = test_launch(path);
        let host_task = tokio::spawn(async move {
            for proof in hosts {
                let (stream, _) = host.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&line).unwrap(),
                    json!({"operation": "adopt", "box": "test-box", "instance": ""})
                );
                stream
                    .get_mut()
                    .write_all(proof.to_string().as_bytes())
                    .await
                    .unwrap();
            }
        });
        let body =
            json!({"revision": shim_revision, "digest": launch.digest, "active": true}).to_string();
        let shim_task = serve_shim_proof(shim, shim_status, body);
        let result = profile
            .verify_live("test-box", &data, fresh.then_some(&launch))
            .await;
        for task in [host_task, shim_task] {
            task.abort();
            if let Err(error) = task.await {
                assert!(error.is_cancelled(), "socket fixture failed: {error}");
            }
        }
        result
    }

    fn current_proof() -> Value {
        json!({"instance": "test-instance", "revision": "policy-1", "digest": "a".repeat(64),
            "cgroup_id": 42, "deadline_ns": u64::MAX, "shim_pid": std::process::id(), "shim_start": 100})
    }

    #[tokio::test]
    async fn platform_guard_confirms_gvproxy_before_network_handoff() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let launch = test_launch(path);
        let data = path.join("net.sock");
        let socket = super::super::control_socket_path(&data);
        assert!(launch.confirm_gvproxy(&data).await.is_err());

        for (status, revision, digest, active, expected) in [
            (
                200,
                launch.revision.as_str(),
                launch.digest.as_str(),
                true,
                true,
            ),
            (200, "other", launch.digest.as_str(), true, false),
            (
                200,
                launch.revision.as_str(),
                "different-digest",
                true,
                false,
            ),
            (
                200,
                launch.revision.as_str(),
                launch.digest.as_str(),
                false,
                false,
            ),
            (
                503,
                launch.revision.as_str(),
                launch.digest.as_str(),
                true,
                false,
            ),
        ] {
            let listener = UnixListener::bind(&socket).unwrap();
            let body =
                json!({"revision": revision, "digest": digest, "active": active}).to_string();
            let server = serve_shim_proof(listener, status, body);
            assert_eq!(launch.confirm_gvproxy(&data).await.is_ok(), expected);
            server.await.unwrap();
            std::fs::remove_file(&socket).unwrap();
        }
    }

    #[tokio::test]
    async fn platform_guard_fresh_launch_requires_live_matching_confirmation() {
        let valid = current_proof();
        let pair = || vec![valid.clone(), valid.clone()];
        verify_through_sockets(true, pair(), 200, "policy-1")
            .await
            .unwrap();
        assert!(
            verify_through_sockets(true, pair(), 503, "policy-1")
                .await
                .is_err()
        );
        assert!(
            verify_through_sockets(true, pair(), 200, "stale")
                .await
                .is_err()
        );
        let mut stale = valid.clone();
        stale["deadline_ns"] = json!(1);
        assert!(
            verify_through_sockets(true, vec![stale], 200, "policy-1")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn platform_guard_reattach_checks_the_connected_peer_and_rechecks_cgroup() {
        let valid = current_proof();
        verify_through_sockets(false, vec![valid.clone(), valid.clone()], 200, "policy-1")
            .await
            .unwrap();
        for (field, replacement) in [
            ("cgroup_id", json!(43)),
            ("shim_start", json!(101)),
            ("instance", json!("other")),
        ] {
            let mut different = valid.clone();
            different[field] = replacement;
            assert!(
                verify_through_sockets(false, vec![valid.clone(), different], 200, "policy-1")
                    .await
                    .is_err()
            );
        }
        let mut wrong_peer = valid;
        wrong_peer["shim_pid"] = json!(std::process::id() + 1);
        let error = verify_through_sockets(false, vec![wrong_peer], 200, "policy-1")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("different shim peer"), "{error}");
    }
}
