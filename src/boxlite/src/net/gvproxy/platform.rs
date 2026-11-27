use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::Path;
use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use http_body_util::{BodyExt, Empty, Limited};
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;

use crate::net::Ipv6LinkPlan;

const SCOPE_TIMEOUT: Duration = Duration::from_secs(2);

/// Trusted network configuration carried from the Runner to one Cloud Box.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloudScope {
    version: u32,
    stage: String,
    #[serde(rename = "box", default)]
    pub box_id: String,
    #[serde(default)]
    instance: String,
    runner: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runner_ipv6: Option<String>,
    cloud_run: String,
    managed_proxy: String,
    gke_pods: String,
    gke_services: String,
    private_services: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CloudScopeStatus {
    scope: CloudScope,
    ipv6: Option<Ipv6LinkPlan>,
    ipv6_qualified: bool,
    ipv6_ready: bool,
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum CloudScopeReadback {
    Current(CloudScopeStatus),
    Ipv4(CloudScope),
}

impl CloudScope {
    pub(crate) fn from_host() -> BoxliteResult<Option<Self>> {
        let stage = std::env::var("BOXLITE_CLOUD_STAGE");
        let scope = std::env::var("BOXLITE_CLOUD_SCOPE");
        let managed_runner = std::env::var_os("GCP_PROJECT_ID").is_some()
            && std::env::var_os("BOXLITE_RUNNER_NAME").is_some();
        let predecessor = std::env::var_os("BOXLITE_REQUIRE_CLOUD_GUARD").is_some()
            || std::env::var("BOXLITE_PLATFORM_GUARD_PROFILE").as_deref() == Ok("cloud");
        match (stage, scope) {
            (Ok(stage), Ok(scope)) if cfg!(target_os = "linux") => {
                let payload = URL_SAFE_NO_PAD.decode(scope).map_err(scope_error)?;
                let scope: Self = serde_json::from_slice(&payload).map_err(scope_error)?;
                scope.validate_host(&stage)?;
                Ok(Some(scope))
            }
            (Err(std::env::VarError::NotPresent), Err(std::env::VarError::NotPresent))
                if !managed_runner && !predecessor =>
            {
                Ok(None)
            }
            _ => Err(scope_error(
                "managed Cloud Runner requires a Linux deployment scope",
            )),
        }
    }

    fn validate_host(&self, stage: &str) -> BoxliteResult<()> {
        if stage.is_empty()
            || self.stage != stage
            || self.version != 1
            || !self.box_id.is_empty()
            || !self.instance.is_empty()
            || [
                &self.runner,
                &self.cloud_run,
                &self.managed_proxy,
                &self.gke_pods,
                &self.gke_services,
                &self.private_services,
            ]
            .iter()
            .any(|cidr| !valid_managed_cidr(cidr))
            || self
                .runner_ipv6
                .as_deref()
                .is_some_and(|cidr| managed_ipv6_prefix(cidr).is_none())
        {
            return Err(scope_error(
                "invalid deployment stage or managed Cloud ranges",
            ));
        }
        Ok(())
    }

    pub(crate) fn qualifies_ipv6() -> BoxliteResult<bool> {
        let scope = Self::from_host()?;
        #[cfg(target_os = "linux")]
        if let Some(scope) = scope {
            return Ok(scope.has_runner_ipv6_route());
        }
        #[cfg(not(target_os = "linux"))]
        let _ = scope;
        Ok(false)
    }

    #[cfg(target_os = "linux")]
    fn has_runner_ipv6_route(&self) -> bool {
        use nix::net::if_::InterfaceFlags;
        use nix::sys::socket::sockopt::BindToDevice;
        use std::net::{SocketAddr, UdpSocket};
        use std::os::unix::ffi::OsStringExt;

        const PROBE: &str = "[2001:4860:4860::8888]:53";
        let route = || {
            let prefix = managed_ipv6_prefix(self.runner_ipv6.as_deref()?)?;
            let (runner, length) = self.runner.split_once('/')?;
            let runner = u32::from(runner.parse::<Ipv4Addr>().ok()?);
            let mask = u32::MAX.checked_shl(32_u32.checked_sub(length.parse::<u32>().ok()?)?)?;
            let probe = UdpSocket::bind("[::]:0").ok()?;
            probe.connect(PROBE).ok()?;
            let SocketAddr::V6(mut source) = probe.local_addr().ok()? else {
                return None;
            };
            if u128::from(*source.ip()) >> 64 != prefix {
                return None;
            }

            let mut runner_interfaces = std::collections::HashSet::new();
            let mut source_interfaces = std::collections::HashSet::new();
            for iface in nix::ifaddrs::getifaddrs().ok()? {
                if !iface.flags.contains(InterfaceFlags::IFF_UP)
                    || iface.flags.contains(InterfaceFlags::IFF_LOOPBACK)
                {
                    continue;
                }
                let Some(address) = iface.address else {
                    continue;
                };
                if address
                    .as_sockaddr_in()
                    .is_some_and(|ip| u32::from(ip.ip()) & mask == runner)
                {
                    runner_interfaces.insert(iface.interface_name);
                } else if address
                    .as_sockaddr_in6()
                    .is_some_and(|ip| ip.ip() == *source.ip())
                {
                    source_interfaces.insert(iface.interface_name);
                }
            }
            let mut matching = runner_interfaces.intersection(&source_interfaces);
            let device = matching.next()?;
            if matching.next().is_some() {
                return None;
            }
            source.set_port(0);
            let socket = UdpSocket::bind(SocketAddr::V6(source)).ok()?;
            let device = std::ffi::OsString::from_vec(device.as_bytes().to_vec());
            nix::sys::socket::setsockopt(&socket, BindToDevice, &device).ok()?;
            socket.connect(PROBE).ok()
        };
        route().is_some()
    }

    pub(crate) fn for_box(&self, box_id: &str) -> Self {
        let mut launch = self.clone();
        launch.box_id = box_id.to_owned();
        launch.instance = uuid::Uuid::new_v4().simple().to_string();
        launch
    }

    /// Verify gvproxy's private readback before the shim starts the VM.
    #[doc(hidden)]
    pub async fn confirm_gvproxy(
        &self,
        data_socket: &Path,
        plan: Option<&Ipv6LinkPlan>,
    ) -> BoxliteResult<()> {
        let status = self
            .connect_and_verify(data_socket, |_stream| {
                #[cfg(target_os = "linux")]
                if _stream.peer_cred().map_err(scope_error)?.pid()
                    != Some(std::process::id() as i32)
                {
                    return Err(scope_error(
                        "gvproxy control socket belongs to a different shim",
                    ));
                }
                Ok(())
            })
            .await?;
        status.verify_ipv6(plan, false)
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn verify_existing(
        &self,
        box_id: &crate::runtime::id::BoxID,
        data_socket: &Path,
        identity: crate::util::ProcessIdentity,
        plan: Option<&Ipv6LinkPlan>,
    ) -> BoxliteResult<()> {
        let crate::util::ProcessIdentity::Verified(pid) = identity else {
            return Err(scope_error("a verified outer launcher is required"));
        };
        let start = process_start_in_box(box_id, pid)?;
        let mut expected = self.clone();
        expected.box_id = box_id.as_str().to_owned();
        expected
            .verify_live(box_id, data_socket, plan, true)
            .await?;
        if process_start_in_box(box_id, pid)? != start {
            return Err(scope_error(
                "outer launcher changed during Cloud scope readback",
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn verify_launch(
        &self,
        box_id: &crate::runtime::id::BoxID,
        data_socket: &Path,
        plan: Option<&Ipv6LinkPlan>,
    ) -> BoxliteResult<()> {
        self.verify_live(box_id, data_socket, plan, false).await
    }

    #[cfg(target_os = "linux")]
    async fn verify_live(
        &self,
        box_id: &crate::runtime::id::BoxID,
        data_socket: &Path,
        plan: Option<&Ipv6LinkPlan>,
        require_guest_ready: bool,
    ) -> BoxliteResult<()> {
        let mut peer_identity = None;
        let status = self
            .connect_and_verify(data_socket, |stream| {
                let pid = stream
                    .peer_cred()
                    .map_err(scope_error)?
                    .pid()
                    .and_then(|pid| u32::try_from(pid).ok())
                    .filter(|pid| *pid > 0)
                    .ok_or_else(|| {
                        scope_error("gvproxy control socket did not identify its peer")
                    })?;
                peer_identity = Some((pid, process_start_in_box(box_id, pid)?));
                Ok(())
            })
            .await?;
        let (pid, start) = peer_identity.ok_or_else(|| scope_error("unverified gvproxy peer"))?;
        if process_start_in_box(box_id, pid)? != start {
            return Err(scope_error(
                "gvproxy peer changed during Cloud scope readback",
            ));
        }
        status.verify_ipv6(plan, require_guest_ready)
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
                scope_error(format!(
                    "cannot confirm isolation for rejected Box {box_id} ({error}): {isolation}"
                ))
            })
    }

    async fn connect_and_verify(
        &self,
        data_socket: &Path,
        verify_peer: impl FnOnce(&UnixStream) -> BoxliteResult<()>,
    ) -> BoxliteResult<CloudScopeStatus> {
        tokio::time::timeout(SCOPE_TIMEOUT, async {
            let stream = UnixStream::connect(super::control_socket_path(data_socket))
                .await
                .map_err(scope_error)?;
            verify_peer(&stream)?;
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(TokioIo::new(stream))
                    .await
                    .map_err(scope_error)?;
            tokio::spawn(connection);
            let request = hyper::Request::get("/network/cloud-scope")
                .header(hyper::header::HOST, "localhost")
                .header(hyper::header::CONNECTION, "close")
                .body(Empty::<bytes::Bytes>::new())
                .map_err(scope_error)?;
            let response = sender.send_request(request).await.map_err(scope_error)?;
            if !response.status().is_success() {
                return Err(scope_error(
                    "gvproxy did not confirm the managed Cloud scope",
                ));
            }
            let body = Limited::new(response.into_body(), 4096)
                .collect()
                .await
                .map_err(scope_error)?
                .to_bytes();
            let mut status = match serde_json::from_slice(&body).map_err(scope_error)? {
                CloudScopeReadback::Current(status) => status,
                CloudScopeReadback::Ipv4(scope) => CloudScopeStatus {
                    scope,
                    ipv6: None,
                    ipv6_qualified: false,
                    ipv6_ready: false,
                },
            };
            if !valid_instance(&status.scope.instance) {
                return Err(scope_error("gvproxy has no valid launch instance identity"));
            }
            if self.instance.is_empty() {
                status.scope.instance.clear();
            }
            if status.scope != *self {
                return Err(scope_error(
                    "gvproxy is running with a different managed Cloud scope",
                ));
            }
            Ok(status)
        })
        .await
        .map_err(scope_error)?
    }
}

impl CloudScopeStatus {
    fn verify_ipv6(
        &self,
        plan: Option<&Ipv6LinkPlan>,
        require_guest_ready: bool,
    ) -> BoxliteResult<()> {
        if self.ipv6.as_ref() != plan
            || (plan.is_some()
                && (!self.ipv6_qualified || (require_guest_ready && !self.ipv6_ready)))
        {
            return Err(scope_error("gvproxy has no matching live Guest IPv6 link"));
        }
        Ok(())
    }
}

fn valid_instance(instance: &str) -> bool {
    instance.len() == 32 && instance.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_managed_cidr(cidr: &str) -> bool {
    let Some((address, prefix)) = cidr.split_once('/') else {
        return false;
    };
    let (Ok(address), Ok(prefix)) = (address.parse::<Ipv4Addr>(), prefix.parse::<u32>()) else {
        return false;
    };
    if !(1..=32).contains(&prefix) {
        return false;
    }
    let host_bits = (1_u64 << (32 - prefix)) - 1;
    u64::from(u32::from(address)) & host_bits == 0 && cidr == format!("{address}/{prefix}")
}

fn managed_ipv6_prefix(cidr: &str) -> Option<u128> {
    let (address, "64") = cidr.split_once('/')? else {
        return None;
    };
    let ip = address.parse::<Ipv6Addr>().ok()?;
    let bits = u128::from(ip);
    let special = [
        (0x2001_0000_u32, 23),
        (0x2001_0db8, 32),
        (0x2002_0000, 16),
        (0x3fff_0000, 20),
    ];
    (bits >> 125 == 1
        && (bits as u64) == 0
        && address == ip.to_string()
        && special
            .iter()
            .all(|&(range, len)| (bits >> (128 - len)) != u128::from(range >> (32 - len))))
    .then_some(bits >> 64)
}

#[cfg(target_os = "linux")]
fn process_start_in_box(box_id: &crate::runtime::id::BoxID, pid: u32) -> BoxliteResult<u64> {
    let start = crate::util::process_start_time(pid)
        .ok_or_else(|| scope_error("Cloud Box process has no live start time"))?;
    if !crate::jailer::box_contains_launcher(box_id, pid).map_err(scope_error)? {
        return Err(scope_error("Cloud Box process is outside its cgroup"));
    }
    Ok(start)
}

fn scope_error(detail: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Engine(format!("Cloud network scope: {detail}"))
}

#[cfg(all(test, target_os = "linux"))]
#[path = "tests/cloud_scope.rs"]
mod tests;
