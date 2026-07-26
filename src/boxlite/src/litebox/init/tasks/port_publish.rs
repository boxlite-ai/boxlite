//! Task: publish configured host ports through the running network backend.
//!
//! The backend owns endpoint allocation. This task owns lifecycle policy:
//! fixed endpoints are published before automatic ones, partial publication is
//! rolled back, and the concrete bindings are persisted in request order.

use super::{InitCtx, log_task_error, task_start};
use crate::litebox::ports::ResolvedPortsSnapshot;
use crate::net::constants::GUEST_IP;
use crate::net::{Forward, NetworkBackend, TransportProtocol};
use crate::pipeline::PipelineTask;
use crate::runtime::options::{PortProtocol, PortSpec};
use crate::runtime::types::PublishedPort;
use crate::util::{PidFileReader, ShimPidRecord};
use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::time::Duration;

const DEFAULT_HOST_IP: IpAddr = IpAddr::V4(Ipv4Addr::UNSPECIFIED);

#[cfg(not(test))]
const REATTACH_CONTROL_READY_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const REATTACH_CONTROL_READY_TIMEOUT: Duration = Duration::from_millis(50);

#[cfg(not(test))]
const REATTACH_CONTROL_READY_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(test)]
const REATTACH_CONTROL_READY_INTERVAL: Duration = Duration::from_millis(1);

#[derive(Clone)]
struct PlannedPort {
    request_index: usize,
    request: PortSpec,
    host_ip: IpAddr,
    local: SocketAddr,
    remote: SocketAddr,
    protocol: TransportProtocol,
}

impl PlannedPort {
    fn is_automatic(&self) -> bool {
        self.local.port() == 0
    }
}

pub struct PortPublishTask;

impl PortPublishTask {
    /// Discover bindings already owned by the running backend without creating
    /// or removing any listener. Metadata reads use this observational path;
    /// start/reattach remains the sole owner of publication repair.
    pub(crate) async fn observe(
        backend: Option<&dyn NetworkBackend>,
        requested: &[PortSpec],
        snapshot_path: &Path,
        lifecycle: ShimPidRecord,
    ) -> BoxliteResult<Vec<PublishedPort>> {
        let planned = plan_ports(requested)?;
        if planned.is_empty() {
            return Ok(Vec::new());
        }
        if !lifecycle.has_runtime_port_control() {
            return Err(BoxliteError::Unsupported(
                "legacy shim has no observable runtime port control; restart the box to migrate"
                    .to_string(),
            ));
        }
        let backend = backend.ok_or_else(|| {
            BoxliteError::Unsupported(
                "host port discovery requires an active network backend".to_string(),
            )
        })?;

        let snapshot = ResolvedPortsSnapshot::at(snapshot_path);
        let previous_snapshot = snapshot.previous_bindings_best_effort();
        let active_forwards = list_forwards_when_ready(backend).await?;
        let mut claimed_active = vec![false; active_forwards.len()];
        let mut resolved = vec![None; requested.len()];

        for mapping in &planned {
            let active_index = find_existing_forward(
                mapping,
                &previous_snapshot,
                &active_forwards,
                &claimed_active,
            )
            .ok_or_else(|| {
                BoxliteError::InvalidState(format!(
                    "configured port {} has no active backend forward",
                    mapping.request.guest_port
                ))
            })?;
            claimed_active[active_index] = true;
            let local = validate_forward(&active_forwards[active_index], mapping)?;
            resolved[mapping.request_index] = Some(PublishedPort {
                guest_port: mapping.request.guest_port,
                host_ip: local.ip().to_string(),
                host_port: local.port(),
                protocol: mapping.request.protocol,
            });
        }

        resolved
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| {
                BoxliteError::Internal("port discovery result was incomplete".to_string())
            })
    }

    /// Repair and persist publication for an already-active lifecycle.
    ///
    /// The running reattach pipeline uses this entry point to adopt or restore
    /// forwards after a core-process restart. Metadata reads use `observe`
    /// above and never call this mutating path.
    pub(crate) async fn reconcile(
        backend: Option<&dyn NetworkBackend>,
        requested: &[PortSpec],
        snapshot_path: &Path,
        lifecycle: ShimPidRecord,
    ) -> BoxliteResult<()> {
        let result = publish_ports(backend, requested, snapshot_path, lifecycle, true)
            .await
            .map(|_| ());
        if result.is_err() {
            // Once live backend state cannot be confirmed, a matching
            // same-lifecycle file is no longer authoritative. Invalidate only
            // metadata; never tear down the already-running shim.
            ResolvedPortsSnapshot::at(snapshot_path).clear_best_effort();
        }
        result
    }
}

#[async_trait]
impl PipelineTask<InitCtx> for PortPublishTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (requested, snapshot_path, pid_path, network_backend, is_reattach) = {
            let mut ctx = ctx.lock().await;
            let layout = ctx
                .layout
                .as_ref()
                .ok_or_else(|| BoxliteError::Internal("filesystem task must run first".into()))?;
            (
                ctx.config.options.ports.clone(),
                layout.resolved_ports_path(),
                layout.pid_file_path(),
                ctx.network_backend.take(),
                ctx.skip_guest_wait,
            )
        };

        // The backend must not remain behind the pipeline mutex while control
        // requests await the shim. Restore ownership before returning on both
        // success and failure.
        let lifecycle = match PidFileReader::at(pid_path).read_shim() {
            Ok(lifecycle) => lifecycle,
            Err(error) => {
                ctx.lock().await.network_backend = network_backend;
                log_task_error(&box_id, task_name, &error);
                return Err(error);
            }
        };
        let result = if is_reattach {
            Self::reconcile(
                network_backend.as_deref(),
                &requested,
                &snapshot_path,
                lifecycle,
            )
            .await
            .map(|_| Vec::new())
        } else {
            publish_ports(
                network_backend.as_deref(),
                &requested,
                &snapshot_path,
                lifecycle,
                false,
            )
            .await
        };
        ctx.lock().await.network_backend = network_backend;

        finish_publication(&box_id, task_name, is_reattach, result)
    }

    fn name(&self) -> &str {
        "port_publish"
    }
}

async fn publish_ports(
    backend: Option<&dyn NetworkBackend>,
    requested: &[PortSpec],
    snapshot_path: &Path,
    lifecycle: ShimPidRecord,
    is_reattach: bool,
) -> BoxliteResult<Vec<PublishedPort>> {
    // Validate the complete request before the first backend call. In
    // particular, a bad later mapping must not strand earlier forwards.
    let planned = plan_ports(requested)?;
    let snapshot = ResolvedPortsSnapshot::at(snapshot_path);
    let previous_snapshot = snapshot.previous_bindings_best_effort();

    if planned.is_empty() {
        snapshot.clear()?;
        return Ok(Vec::new());
    }
    // A live shim started by the previous release owns its configured ports in
    // custom listeners, not ServicesMux, so `/all` cannot see them. Its
    // shim-written snapshot is nevertheless authoritative. Keep that legacy
    // lifecycle untouched; the next normal restart writes a capability-bearing
    // PID record and publishes through NetworkBackend::expose.
    if is_reattach && !lifecycle.has_runtime_port_control() {
        if let Some(legacy_bindings) = legacy_bindings(&planned, &previous_snapshot) {
            return Ok(legacy_bindings);
        }

        // Never risk a second listener beside an older shim when its snapshot
        // is missing or malformed. Keeping the live lifecycle intact is safer
        // than guessing ownership; discovery remains empty/stale until the box
        // is normally restarted and migrated to ServicesMux.
        tracing::warn!(
            "Could not validate legacy port bindings; leaving the live shim's listeners untouched"
        );
        return Ok(previous_snapshot);
    }

    if !lifecycle.has_runtime_port_control() {
        return Err(BoxliteError::Internal(
            "new shim PID record does not advertise ServicesMux runtime port control".to_string(),
        ));
    }

    let backend = backend.ok_or_else(|| {
        BoxliteError::Unsupported(
            "host port publication requires an active network backend".to_string(),
        )
    })?;

    // Reattach can follow a core-process crash at any instruction boundary.
    // Adopt forwards that gvproxy already owns so publication is idempotent
    // even when the prior process died before writing the snapshot. PID
    // publication precedes shim startup, so wait through the bounded window
    // where the lifecycle is live but ServicesMux has not bound its socket yet.
    // A fresh backend cannot own forwards, so it need not implement discovery.
    let active_forwards = if is_reattach {
        list_forwards_when_ready(backend).await?
    } else {
        Vec::new()
    };
    let mut claimed_active = vec![false; active_forwards.len()];
    let mut resolved = vec![None; requested.len()];
    let mut published = Vec::with_capacity(planned.len());

    let fixed = planned.iter().filter(|mapping| !mapping.is_automatic());
    let automatic = planned.iter().filter(|mapping| mapping.is_automatic());

    for mapping in fixed.chain(automatic) {
        let existing = find_existing_forward(
            mapping,
            &previous_snapshot,
            &active_forwards,
            &claimed_active,
        );
        let forward = if let Some(active_index) = existing {
            claimed_active[active_index] = true;
            active_forwards[active_index].clone()
        } else {
            match backend
                .expose(
                    &mapping.local.to_string(),
                    &mapping.remote.to_string(),
                    mapping.protocol,
                )
                .await
            {
                Ok(forward) => {
                    published.push(forward.clone());
                    forward
                }
                Err(error) => {
                    rollback(backend, &published).await;
                    if !is_reattach {
                        snapshot.clear_best_effort();
                    }
                    return Err(error);
                }
            }
        };

        let local = match validate_forward(&forward, mapping) {
            Ok(local) => local,
            Err(error) => {
                rollback(backend, &published).await;
                if !is_reattach {
                    snapshot.clear_best_effort();
                }
                return Err(error);
            }
        };
        resolved[mapping.request_index] = Some(PublishedPort {
            guest_port: mapping.request.guest_port,
            host_ip: local.ip().to_string(),
            host_port: local.port(),
            protocol: mapping.request.protocol,
        });
    }

    let resolved = resolved
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| BoxliteError::Internal("port publication result was incomplete".into()))?;
    if let Err(error) = snapshot.replace(lifecycle.identity(), &resolved) {
        rollback(backend, &published).await;
        if !is_reattach {
            snapshot.clear_best_effort();
        }
        return Err(error);
    }

    Ok(resolved)
}

async fn list_forwards_when_ready(backend: &dyn NetworkBackend) -> BoxliteResult<Vec<Forward>> {
    let deadline = tokio::time::Instant::now() + REATTACH_CONTROL_READY_TIMEOUT;

    loop {
        match tokio::time::timeout_at(deadline, backend.list_forwards()).await {
            Ok(Ok(forwards)) => return Ok(forwards),
            Ok(Err(error @ BoxliteError::Network(_))) => {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    return Err(error);
                }
                tokio::time::sleep(REATTACH_CONTROL_READY_INTERVAL.min(deadline - now)).await;
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => {
                return Err(BoxliteError::Network(format!(
                    "timed out waiting for gvproxy runtime port control after {REATTACH_CONTROL_READY_TIMEOUT:?}"
                )));
            }
        }
    }
}

fn finish_publication(
    box_id: &crate::BoxID,
    task_name: &str,
    is_reattach: bool,
    result: BoxliteResult<Vec<PublishedPort>>,
) -> BoxliteResult<()> {
    match result {
        Ok(_) => Ok(()),
        Err(error) if is_reattach => {
            // Reconciliation is repair work on an already-running shim. A
            // transient control-plane or snapshot error must not leave its
            // CleanupGuard armed and tear down the healthy workload.
            tracing::warn!(
                box_id = %box_id,
                %error,
                "Port publication reconciliation failed; preserving the running box"
            );
            Ok(())
        }
        Err(error) => {
            log_task_error(box_id, task_name, &error);
            Err(error)
        }
    }
}

fn plan_ports(requested: &[PortSpec]) -> BoxliteResult<Vec<PlannedPort>> {
    let guest_ip = GUEST_IP.parse::<IpAddr>().map_err(|error| {
        BoxliteError::Internal(format!("invalid built-in guest IP {GUEST_IP}: {error}"))
    })?;

    requested
        .iter()
        .cloned()
        .enumerate()
        .map(|(request_index, request)| {
            if request.guest_port == 0 {
                return Err(BoxliteError::Config(
                    "guest port must be in range 1-65535".to_string(),
                ));
            }
            let host_ip = parse_host_ip(&request)?;
            let protocol = transport_protocol(request.protocol)?;
            Ok(PlannedPort {
                request_index,
                local: SocketAddr::new(host_ip, request.host_port.unwrap_or(0)),
                remote: SocketAddr::new(guest_ip, request.guest_port),
                host_ip,
                protocol,
                request,
            })
        })
        .collect()
}

fn legacy_bindings(
    planned: &[PlannedPort],
    snapshot: &[PublishedPort],
) -> Option<Vec<PublishedPort>> {
    if snapshot.len() != planned.len() {
        return None;
    }

    for mapping in planned {
        let binding = snapshot.get(mapping.request_index)?;
        let host_ip = binding.host_ip.parse::<IpAddr>().ok()?;
        let host_port = (binding.host_port != 0).then_some(binding.host_port)?;

        if binding.guest_port != mapping.request.guest_port
            || binding.protocol != mapping.request.protocol
            || host_ip != mapping.host_ip
            || mapping
                .request
                .host_port
                .is_some_and(|requested| requested != 0 && requested != host_port)
        {
            return None;
        }
    }

    Some(snapshot.to_vec())
}

fn find_existing_forward(
    planned: &PlannedPort,
    previous_snapshot: &[PublishedPort],
    active: &[Forward],
    claimed: &[bool],
) -> Option<usize> {
    let preferred_local = if planned.is_automatic() {
        previous_snapshot
            .get(planned.request_index)
            .filter(|binding| {
                binding.guest_port == planned.request.guest_port
                    && binding.protocol == planned.request.protocol
            })
            .and_then(|binding| {
                let host_ip = binding.host_ip.parse::<IpAddr>().ok()?;
                let host_port = (binding.host_port != 0).then_some(binding.host_port)?;
                (host_ip == planned.host_ip).then_some(SocketAddr::new(host_ip, host_port))
            })
    } else {
        Some(planned.local)
    };

    if let Some(preferred_local) = preferred_local
        && let Some(index) = active.iter().enumerate().position(|(index, forward)| {
            !claimed[index]
                && forward_matches_plan(forward, planned)
                && forward
                    .local
                    .parse::<SocketAddr>()
                    .is_ok_and(|local| local == preferred_local)
        })
    {
        return Some(index);
    }

    if !planned.is_automatic() {
        return None;
    }

    active
        .iter()
        .enumerate()
        .position(|(index, forward)| !claimed[index] && forward_matches_plan(forward, planned))
}

fn forward_matches_plan(forward: &Forward, planned: &PlannedPort) -> bool {
    let Ok(local) = forward.local.parse::<SocketAddr>() else {
        return false;
    };
    let Ok(remote) = forward.remote.parse::<SocketAddr>() else {
        return false;
    };

    local.port() != 0
        && local.ip() == planned.host_ip
        && remote == planned.remote
        && forward.protocol == planned.protocol.as_str()
}

fn parse_host_ip(mapping: &PortSpec) -> BoxliteResult<IpAddr> {
    mapping
        .host_ip
        .as_deref()
        .map(str::parse)
        .transpose()
        .map_err(|error| {
            BoxliteError::Config(format!(
                "invalid port host_ip {:?}: {error}",
                mapping.host_ip
            ))
        })
        .map(|host_ip| host_ip.unwrap_or(DEFAULT_HOST_IP))
}

fn transport_protocol(protocol: PortProtocol) -> BoxliteResult<TransportProtocol> {
    match protocol {
        PortProtocol::Tcp => Ok(TransportProtocol::Tcp),
        PortProtocol::Udp => Err(BoxliteError::Unsupported(
            "UDP port forwarding is not implemented; use TCP".to_string(),
        )),
    }
}

fn validate_forward(forward: &Forward, planned: &PlannedPort) -> BoxliteResult<SocketAddr> {
    let local = forward.local.parse::<SocketAddr>().map_err(|error| {
        BoxliteError::Network(format!(
            "network backend returned invalid local endpoint {:?}: {error}",
            forward.local
        ))
    })?;
    if local.port() == 0 {
        return Err(BoxliteError::Network(format!(
            "network backend returned unresolved local endpoint {}",
            forward.local
        )));
    }
    if local.ip() != planned.host_ip {
        return Err(BoxliteError::Network(format!(
            "network backend bound {} instead of requested host IP {}",
            forward.local, planned.host_ip
        )));
    }
    if let Some(requested_port) = planned.request.host_port
        && requested_port != 0
        && local.port() != requested_port
    {
        return Err(BoxliteError::Network(format!(
            "network backend bound {} instead of requested host port {}",
            forward.local, requested_port
        )));
    }
    let remote = forward.remote.parse::<SocketAddr>().map_err(|error| {
        BoxliteError::Network(format!(
            "network backend returned invalid remote endpoint {:?}: {error}",
            forward.remote
        ))
    })?;
    if remote != planned.remote {
        return Err(BoxliteError::Network(format!(
            "network backend forwarded to {} instead of requested guest endpoint {}",
            forward.remote, planned.remote
        )));
    }
    if forward.protocol != planned.protocol.as_str() {
        return Err(BoxliteError::Network(format!(
            "network backend returned protocol {:?} instead of {:?}",
            forward.protocol,
            planned.protocol.as_str()
        )));
    }
    Ok(local)
}

async fn rollback(backend: &dyn NetworkBackend, published: &[Forward]) {
    for forward in published.iter().rev() {
        let protocol = match forward.protocol.as_str() {
            "tcp" => TransportProtocol::Tcp,
            "udp" => TransportProtocol::Udp,
            "unix" => TransportProtocol::Unix,
            "npipe" => TransportProtocol::Npipe,
            other => {
                tracing::warn!(
                    local = %forward.local,
                    protocol = %other,
                    "Cannot roll back port publication with unknown protocol"
                );
                continue;
            }
        };
        if let Err(error) = backend.unexpose(&forward.local, protocol).await {
            tracing::warn!(
                local = %forward.local,
                %error,
                "Failed to roll back port publication"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{NetworkBackendSpec, TransportProtocol};
    use crate::util::PidRecord;
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    #[derive(Debug)]
    enum ExposeResult {
        Bound(&'static str),
        BoundTo(&'static str, &'static str),
        Failed(&'static str),
    }

    #[derive(Debug)]
    struct MockBackend {
        results: Mutex<VecDeque<ExposeResult>>,
        active: Mutex<Vec<Forward>>,
        exposed: Mutex<Vec<String>>,
        unexposed: Mutex<Vec<String>>,
        list_error: Mutex<Option<&'static str>>,
        transient_list_errors: Mutex<VecDeque<&'static str>>,
        list_delay: Mutex<Option<Duration>>,
        list_calls: Mutex<usize>,
        block_snapshot_parent_after_expose: Mutex<Option<PathBuf>>,
    }

    impl MockBackend {
        fn new(results: impl IntoIterator<Item = ExposeResult>) -> Self {
            Self {
                results: Mutex::new(results.into_iter().collect()),
                active: Mutex::new(Vec::new()),
                exposed: Mutex::new(Vec::new()),
                unexposed: Mutex::new(Vec::new()),
                list_error: Mutex::new(None),
                transient_list_errors: Mutex::new(VecDeque::new()),
                list_delay: Mutex::new(None),
                list_calls: Mutex::new(0),
                block_snapshot_parent_after_expose: Mutex::new(None),
            }
        }

        fn with_active(self, active: Vec<Forward>) -> Self {
            *self.active.lock().unwrap() = active;
            self
        }

        fn with_list_error(self, message: &'static str) -> Self {
            *self.list_error.lock().unwrap() = Some(message);
            self
        }

        fn with_transient_list_errors(
            self,
            messages: impl IntoIterator<Item = &'static str>,
        ) -> Self {
            *self.transient_list_errors.lock().unwrap() = messages.into_iter().collect();
            self
        }

        fn with_list_delay(self, delay: Duration) -> Self {
            *self.list_delay.lock().unwrap() = Some(delay);
            self
        }

        fn list_call_count(&self) -> usize {
            *self.list_calls.lock().unwrap()
        }

        fn with_snapshot_parent_blocked_after_expose(self, path: PathBuf) -> Self {
            *self.block_snapshot_parent_after_expose.lock().unwrap() = Some(path);
            self
        }
    }

    #[async_trait]
    impl NetworkBackend for MockBackend {
        fn name(&self) -> &'static str {
            "mock"
        }

        fn spec(&self) -> NetworkBackendSpec {
            NetworkBackendSpec {
                socket_path: PathBuf::from("/tmp/mock-net.sock"),
                allow_net: Vec::new(),
                secrets: Vec::new(),
                ca_cert_pem: None,
                ca_key_pem: None,
            }
        }

        async fn expose(
            &self,
            local: &str,
            remote: &str,
            protocol: TransportProtocol,
        ) -> BoxliteResult<Forward> {
            self.exposed.lock().unwrap().push(local.to_string());
            let result = self.results.lock().unwrap().pop_front().unwrap();
            let (bound, returned_remote) = match result {
                ExposeResult::Bound(bound) => (bound, remote),
                ExposeResult::BoundTo(bound, returned_remote) => (bound, returned_remote),
                ExposeResult::Failed(message) => {
                    return Err(BoxliteError::Network(message.to_string()));
                }
            };
            let forward = Forward {
                local: bound.to_string(),
                remote: returned_remote.to_string(),
                protocol: protocol.as_str().to_string(),
            };
            self.active.lock().unwrap().push(forward.clone());
            if let Some(path) = self
                .block_snapshot_parent_after_expose
                .lock()
                .unwrap()
                .take()
            {
                for entry in std::fs::read_dir(&path).unwrap() {
                    std::fs::remove_file(entry.unwrap().path()).unwrap();
                }
                std::fs::remove_dir(&path).unwrap();
                std::fs::write(&path, b"not a directory").unwrap();
            }
            Ok(forward)
        }

        async fn unexpose(&self, local: &str, _protocol: TransportProtocol) -> BoxliteResult<()> {
            self.unexposed.lock().unwrap().push(local.to_string());
            self.active
                .lock()
                .unwrap()
                .retain(|forward| forward.local != local);
            Ok(())
        }

        async fn list_forwards(&self) -> BoxliteResult<Vec<Forward>> {
            *self.list_calls.lock().unwrap() += 1;
            let delay = *self.list_delay.lock().unwrap();
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            if let Some(message) = self.transient_list_errors.lock().unwrap().pop_front() {
                return Err(BoxliteError::Network(message.to_string()));
            }
            if let Some(message) = *self.list_error.lock().unwrap() {
                return Err(BoxliteError::Network(message.to_string()));
            }
            Ok(self.active.lock().unwrap().clone())
        }
    }

    fn mapping(host_port: Option<u16>, guest_port: u16) -> PortSpec {
        PortSpec {
            host_port,
            guest_port,
            protocol: PortProtocol::Tcp,
            host_ip: Some("127.0.0.1".to_string()),
        }
    }

    fn published_port(host_port: u16, guest_port: u16) -> PublishedPort {
        PublishedPort {
            guest_port,
            host_ip: "127.0.0.1".to_string(),
            host_port,
            protocol: PortProtocol::Tcp,
        }
    }

    fn active_forward(local: &str, guest_port: u16) -> Forward {
        Forward {
            local: local.to_string(),
            remote: format!("{GUEST_IP}:{guest_port}"),
            protocol: "tcp".to_string(),
        }
    }

    fn identity(pid: u32, start_time: u64) -> PidRecord {
        PidRecord {
            pid,
            start_time: Some(start_time),
        }
    }

    fn lifecycle(pid: u32, start_time: u64) -> ShimPidRecord {
        ShimPidRecord::with_runtime_port_control(identity(pid, start_time))
    }

    fn legacy_lifecycle(pid: u32, start_time: u64) -> ShimPidRecord {
        ShimPidRecord::legacy(identity(pid, start_time))
    }

    fn persisted_ports(snapshot: &Path) -> Vec<PublishedPort> {
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(snapshot).unwrap()).unwrap();
        serde_json::from_value(document["ports"].clone()).unwrap()
    }

    #[tokio::test]
    async fn publishes_fixed_first_and_persists_in_request_order() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let backend = MockBackend::new([
            ExposeResult::Bound("127.0.0.1:18080"),
            ExposeResult::Bound("127.0.0.1:49152"),
        ]);
        let requested = vec![mapping(None, 3000), mapping(Some(18080), 8080)];

        let active_lifecycle = lifecycle(101, 1001);
        let resolved = publish_ports(
            Some(&backend),
            &requested,
            &snapshot,
            active_lifecycle,
            false,
        )
        .await
        .unwrap();

        assert_eq!(
            *backend.exposed.lock().unwrap(),
            vec!["127.0.0.1:18080", "127.0.0.1:0"]
        );
        assert_eq!(resolved[0].host_port, 49152);
        assert_eq!(resolved[0].guest_port, 3000);
        assert_eq!(resolved[1].host_port, 18080);
        assert_eq!(resolved[1].guest_port, 8080);
        assert_eq!(persisted_ports(&snapshot), resolved);
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&snapshot).unwrap()).unwrap();
        assert_eq!(document["version"], 1);
        assert_eq!(document["lifecycle"]["pid"], 101);
        assert_eq!(document["lifecycle"]["start_time"], 1001);
    }

    #[tokio::test]
    async fn later_failure_rolls_back_successful_forwards_in_reverse() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let backend = MockBackend::new([
            ExposeResult::Bound("127.0.0.1:18080"),
            ExposeResult::Bound("127.0.0.1:18081"),
            ExposeResult::Failed("third publication failed"),
        ]);
        let requested = vec![
            mapping(Some(18080), 80),
            mapping(Some(18081), 81),
            mapping(Some(18082), 82),
        ];

        let error = publish_ports(
            Some(&backend),
            &requested,
            &snapshot,
            lifecycle(102, 1002),
            false,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("third publication failed"));
        assert_eq!(
            *backend.unexposed.lock().unwrap(),
            vec!["127.0.0.1:18081", "127.0.0.1:18080"]
        );
        assert!(!snapshot.exists());
    }

    #[tokio::test]
    async fn validates_complete_plan_before_exposing_any_forward() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let backend = MockBackend::new([ExposeResult::Bound("127.0.0.1:18080")]);
        let requested = vec![mapping(Some(18080), 80), mapping(Some(18081), 0)];

        let error = publish_ports(
            Some(&backend),
            &requested,
            &snapshot,
            lifecycle(103, 1003),
            false,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("guest port"));
        assert!(backend.exposed.lock().unwrap().is_empty());
        assert!(backend.unexposed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_wrong_remote_and_rolls_back_the_new_forward() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let backend =
            MockBackend::new([ExposeResult::BoundTo("127.0.0.1:18080", "192.168.127.2:81")]);

        let error = publish_ports(
            Some(&backend),
            &[mapping(Some(18080), 80)],
            &snapshot,
            lifecycle(104, 1004),
            false,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("requested guest endpoint"));
        assert_eq!(*backend.unexposed.lock().unwrap(), vec!["127.0.0.1:18080"]);
        assert!(!snapshot.exists());
    }

    #[tokio::test]
    async fn reattach_adopts_existing_fixed_forward_and_publishes_only_missing_auto() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let backend = MockBackend::new([ExposeResult::Bound("127.0.0.1:49152")])
            .with_active(vec![active_forward("127.0.0.1:18080", 8080)]);
        let requested = vec![mapping(None, 3000), mapping(Some(18080), 8080)];

        let lifecycle = lifecycle(105, 1005);
        let resolved = publish_ports(Some(&backend), &requested, &snapshot, lifecycle, true)
            .await
            .unwrap();

        assert_eq!(*backend.exposed.lock().unwrap(), vec!["127.0.0.1:0"]);
        assert_eq!(resolved[0].host_port, 49152);
        assert_eq!(resolved[1].host_port, 18080);
        assert!(backend.unexposed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn reattach_recovers_auto_forward_without_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let backend =
            MockBackend::new([]).with_active(vec![active_forward("127.0.0.1:49152", 3000)]);

        let lifecycle = lifecycle(106, 1006);
        let resolved = publish_ports(
            Some(&backend),
            &[mapping(None, 3000)],
            &snapshot,
            lifecycle,
            true,
        )
        .await
        .unwrap();

        assert_eq!(resolved[0].host_port, 49152);
        assert!(backend.exposed.lock().unwrap().is_empty());
        assert_eq!(persisted_ports(&snapshot), resolved);
    }

    #[tokio::test]
    async fn reattach_after_prepublication_crash_publishes_missing_forward() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let backend = MockBackend::new([ExposeResult::Bound("127.0.0.1:49152")]);
        let lifecycle = lifecycle(114, 1014);

        let resolved = publish_ports(
            Some(&backend),
            &[mapping(None, 3000)],
            &snapshot,
            lifecycle,
            true,
        )
        .await
        .unwrap();

        assert_eq!(*backend.exposed.lock().unwrap(), vec!["127.0.0.1:0"]);
        assert_eq!(resolved, vec![published_port(49152, 3000)]);
        assert_eq!(persisted_ports(&snapshot), resolved);
    }

    #[tokio::test]
    async fn reattach_waits_for_runtime_control_socket_then_reconciles() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let backend = MockBackend::new([ExposeResult::Bound("127.0.0.1:49152")])
            .with_transient_list_errors([
                "gvproxy services connect failed: No such file or directory",
                "gvproxy services connect failed: Connection refused",
            ]);

        let resolved = publish_ports(
            Some(&backend),
            &[mapping(None, 3000)],
            &snapshot,
            lifecycle(116, 1016),
            true,
        )
        .await
        .unwrap();

        assert_eq!(backend.list_call_count(), 3);
        assert_eq!(*backend.exposed.lock().unwrap(), vec!["127.0.0.1:0"]);
        assert_eq!(resolved, vec![published_port(49152, 3000)]);
    }

    #[tokio::test]
    async fn metadata_observation_never_publishes_a_missing_forward() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let backend = MockBackend::new([ExposeResult::Bound("127.0.0.1:49152")]);

        let error = PortPublishTask::observe(
            Some(&backend),
            &[mapping(None, 3000)],
            &snapshot,
            lifecycle(117, 1017),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("no active backend forward"));
        assert!(
            backend.exposed.lock().unwrap().is_empty(),
            "metadata discovery must not create a listener"
        );
        assert!(!snapshot.exists());
    }

    #[tokio::test]
    async fn metadata_observation_returns_an_existing_automatic_forward() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let backend =
            MockBackend::new([]).with_active(vec![active_forward("127.0.0.1:49152", 3000)]);

        let resolved = PortPublishTask::observe(
            Some(&backend),
            &[mapping(None, 3000)],
            &snapshot,
            lifecycle(118, 1018),
        )
        .await
        .unwrap();

        assert_eq!(resolved, vec![published_port(49152, 3000)]);
        assert!(backend.exposed.lock().unwrap().is_empty());
        assert!(!snapshot.exists(), "metadata discovery is not persistence");
    }

    #[tokio::test]
    async fn reattach_control_wait_bounds_a_hanging_request() {
        let backend = MockBackend::new([]).with_list_delay(Duration::from_secs(1));
        let started = std::time::Instant::now();

        let error = list_forwards_when_ready(&backend).await.unwrap_err();

        assert!(
            error
                .to_string()
                .contains("timed out waiting for gvproxy runtime port control")
        );
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "a single backend request must not escape the reattach deadline"
        );
        assert_eq!(backend.list_call_count(), 1);
    }

    #[tokio::test]
    async fn reattach_after_restart_crash_replaces_prior_lifecycle_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let prior_lifecycle = vec![mapping(Some(49151), 3000)];
        std::fs::write(&snapshot, serde_json::to_vec(&prior_lifecycle).unwrap()).unwrap();
        let backend = MockBackend::new([ExposeResult::Bound("127.0.0.1:49152")]);
        let lifecycle = lifecycle(115, 1015);

        let resolved = publish_ports(
            Some(&backend),
            &[mapping(None, 3000)],
            &snapshot,
            lifecycle,
            true,
        )
        .await
        .unwrap();

        assert_eq!(*backend.exposed.lock().unwrap(), vec!["127.0.0.1:0"]);
        assert_eq!(resolved, vec![published_port(49152, 3000)]);
        assert_eq!(persisted_ports(&snapshot), resolved);
    }

    #[tokio::test]
    async fn reattach_list_failure_invalidates_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let previous = vec![mapping(Some(49152), 3000)];
        let snapshot_contents = serde_json::to_vec(&previous).unwrap();
        std::fs::write(&snapshot, &snapshot_contents).unwrap();
        let lifecycle = lifecycle(113, 1013);
        let backend = MockBackend::new([]).with_list_error("gvproxy control socket unavailable");

        let error = PortPublishTask::reconcile(
            Some(&backend),
            &[mapping(None, 3000)],
            &snapshot,
            lifecycle,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("control socket unavailable"));
        assert!(
            !snapshot.exists(),
            "failed live reconciliation must invalidate possibly stale metadata"
        );
        assert!(backend.exposed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn snapshot_failure_rolls_back_published_forward() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot_parent = dir.path().join("snapshot");
        std::fs::create_dir(&snapshot_parent).unwrap();
        let snapshot = snapshot_parent.join("resolved-ports.json");
        let backend = MockBackend::new([ExposeResult::Bound("127.0.0.1:18080")])
            .with_snapshot_parent_blocked_after_expose(snapshot_parent);

        let error = publish_ports(
            Some(&backend),
            &[mapping(Some(18080), 80)],
            &snapshot,
            lifecycle(107, 1007),
            false,
        )
        .await
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("temporary resolved port snapshot")
        );
        assert_eq!(*backend.unexposed.lock().unwrap(), vec!["127.0.0.1:18080"]);
    }

    #[tokio::test]
    async fn empty_plan_clears_stale_snapshot_without_backend() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        std::fs::write(&snapshot, b"[{\"host_port\":1234}]").unwrap();

        let resolved = publish_ports(None, &[], &snapshot, lifecycle(108, 1008), false)
            .await
            .unwrap();

        assert!(resolved.is_empty());
        assert!(!snapshot.exists());
    }

    #[tokio::test]
    async fn nonempty_plan_requires_backend_without_mutating_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        std::fs::write(&snapshot, b"stale").unwrap();

        let error = publish_ports(
            None,
            &[mapping(None, 3000)],
            &snapshot,
            lifecycle(109, 1009),
            false,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("active network backend"));
        assert_eq!(std::fs::read_to_string(snapshot).unwrap(), "stale");
    }

    #[tokio::test]
    async fn reattach_preserves_legacy_listener_snapshot_without_republishing() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let requested = vec![mapping(None, 3000), mapping(Some(18080), 8080)];
        let legacy = vec![mapping(Some(49152), 3000), mapping(Some(18080), 8080)];
        std::fs::write(&snapshot, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let backend = MockBackend::new([]);

        let lifecycle = legacy_lifecycle(110, 1010);
        let resolved = publish_ports(Some(&backend), &requested, &snapshot, lifecycle, true)
            .await
            .unwrap();

        assert_eq!(
            resolved,
            vec![published_port(49152, 3000), published_port(18080, 8080)]
        );
        assert!(backend.exposed.lock().unwrap().is_empty());
        assert!(!lifecycle.has_runtime_port_control());
    }

    #[tokio::test]
    async fn restart_migrates_legacy_snapshot_to_backend_publication() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let requested = vec![mapping(None, 3000)];
        std::fs::write(
            &snapshot,
            serde_json::to_vec(&vec![mapping(Some(49151), 3000)]).unwrap(),
        )
        .unwrap();
        let backend = MockBackend::new([ExposeResult::Bound("127.0.0.1:49152")]);

        let lifecycle = lifecycle(111, 1011);
        let resolved = publish_ports(Some(&backend), &requested, &snapshot, lifecycle, false)
            .await
            .unwrap();

        assert_eq!(resolved[0].host_port, 49152);
        assert_eq!(*backend.exposed.lock().unwrap(), vec!["127.0.0.1:0"]);
        assert!(lifecycle.has_runtime_port_control());
    }

    #[tokio::test]
    async fn invalid_legacy_snapshot_never_creates_a_second_listener() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("resolved-ports.json");
        let stale = vec![mapping(Some(49152), 9999)];
        std::fs::write(&snapshot, serde_json::to_vec(&stale).unwrap()).unwrap();
        let backend = MockBackend::new([ExposeResult::Bound("127.0.0.1:49153")]);

        let lifecycle = legacy_lifecycle(112, 1012);
        let resolved = publish_ports(
            Some(&backend),
            &[mapping(None, 3000)],
            &snapshot,
            lifecycle,
            true,
        )
        .await
        .unwrap();

        assert_eq!(resolved, vec![published_port(49152, 9999)]);
        assert!(backend.exposed.lock().unwrap().is_empty());
        assert!(!lifecycle.has_runtime_port_control());
    }

    #[test]
    fn reattach_publication_error_does_not_fail_initialization() {
        let box_id = crate::BoxID::parse("port-reconcile-test").unwrap();
        let result = finish_publication(
            &box_id,
            "port_publish",
            true,
            Err(BoxliteError::Network(
                "gvproxy control socket unavailable".to_string(),
            )),
        );

        assert!(result.is_ok());
    }
}
