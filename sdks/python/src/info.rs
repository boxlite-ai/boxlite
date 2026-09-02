use boxlite::runtime::options::PortProtocol;
use boxlite::{
    BoxInfo, BoxStateInfo, BoxStatus, HealthState as CoreHealthState, NetworkInfo, NetworkMode,
    OutboundNetworkInfo, PublishedPort,
};
use pyo3::prelude::*;

fn port_protocol_to_string(protocol: PortProtocol) -> String {
    match protocol {
        PortProtocol::Tcp => "tcp",
        PortProtocol::Udp => "udp",
    }
    .to_string()
}

fn network_mode_to_string(mode: NetworkMode) -> String {
    match mode {
        NetworkMode::Enabled => "enabled",
        NetworkMode::Disabled => "disabled",
    }
    .to_string()
}

// ============================================================================
// PublishedPort / NetworkInfo - Resolved network metadata
// ============================================================================

#[pyclass(name = "PublishedPort")]
#[derive(Clone, Debug)]
pub(crate) struct PyPublishedPort {
    #[pyo3(get)]
    pub(crate) guest_port: u16,
    #[pyo3(get)]
    pub(crate) host_ip: String,
    #[pyo3(get)]
    pub(crate) host_port: u16,
    #[pyo3(get)]
    pub(crate) protocol: String,
}

impl From<PublishedPort> for PyPublishedPort {
    fn from(port: PublishedPort) -> Self {
        Self {
            guest_port: port.guest_port,
            host_ip: port.host_ip,
            host_port: port.host_port,
            protocol: port_protocol_to_string(port.protocol),
        }
    }
}

impl PyPublishedPort {
    fn json_value(&self) -> serde_json::Value {
        serde_json::json!({
            "guest_port": self.guest_port,
            "host_ip": self.host_ip,
            "host_port": self.host_port,
            "protocol": self.protocol,
        })
    }
}

#[pymethods]
impl PyPublishedPort {
    fn __repr__(&self) -> String {
        serde_json::to_string_pretty(&self.json_value()).unwrap_or_default()
    }
}

#[pyclass(name = "OutboundNetworkInfo")]
#[derive(Clone, Debug)]
pub(crate) struct PyOutboundNetworkInfo {
    #[pyo3(get)]
    pub(crate) mode: String,
    #[pyo3(get)]
    pub(crate) allow_net: Vec<String>,
}

impl From<OutboundNetworkInfo> for PyOutboundNetworkInfo {
    fn from(direction: OutboundNetworkInfo) -> Self {
        Self {
            mode: network_mode_to_string(direction.mode),
            allow_net: direction.allow_net,
        }
    }
}

impl PyOutboundNetworkInfo {
    fn json_value(&self) -> serde_json::Value {
        serde_json::json!({
            "mode": self.mode,
            "allow_net": self.allow_net,
        })
    }
}

#[pymethods]
impl PyOutboundNetworkInfo {
    fn __repr__(&self) -> String {
        serde_json::to_string_pretty(&self.json_value()).unwrap_or_default()
    }
}

#[pyclass(name = "InboundNetworkInfo")]
#[derive(Clone, Debug)]
pub(crate) struct PyInboundNetworkInfo {
    #[pyo3(get)]
    pub(crate) mode: String,
    #[pyo3(get)]
    pub(crate) allow_net: Vec<String>,
}

impl From<boxlite::InboundNetworkInfo> for PyInboundNetworkInfo {
    fn from(direction: boxlite::InboundNetworkInfo) -> Self {
        Self {
            mode: network_mode_to_string(direction.mode),
            allow_net: direction.allow_net,
        }
    }
}

impl PyInboundNetworkInfo {
    fn json_value(&self) -> serde_json::Value {
        serde_json::json!({
            "mode": self.mode,
            "allow_net": self.allow_net,
        })
    }
}

#[pymethods]
impl PyInboundNetworkInfo {
    fn __repr__(&self) -> String {
        serde_json::to_string_pretty(&self.json_value()).unwrap_or_default()
    }
}

#[pyclass(name = "NetworkInfo")]
#[derive(Clone, Debug)]
pub(crate) struct PyNetworkInfo {
    #[pyo3(get)]
    pub(crate) outbound: PyOutboundNetworkInfo,
    #[pyo3(get)]
    pub(crate) inbound: PyInboundNetworkInfo,
    /// `None` means this handle does not know the bindings; an empty list means
    /// there are no active publications.
    #[pyo3(get)]
    pub(crate) published_ports: Option<Vec<PyPublishedPort>>,
}

impl From<NetworkInfo> for PyNetworkInfo {
    fn from(network: NetworkInfo) -> Self {
        Self {
            outbound: PyOutboundNetworkInfo::from(network.outbound),
            inbound: PyInboundNetworkInfo::from(network.inbound),
            published_ports: network
                .published_ports
                .map(|ports| ports.into_iter().map(PyPublishedPort::from).collect()),
        }
    }
}

impl PyNetworkInfo {
    fn json_value(&self) -> serde_json::Value {
        let published_ports = self.published_ports.as_ref().map(|ports| {
            ports
                .iter()
                .map(PyPublishedPort::json_value)
                .collect::<Vec<_>>()
        });
        serde_json::json!({
            "outbound": self.outbound.json_value(),
            "inbound": self.inbound.json_value(),
            "published_ports": published_ports,
        })
    }
}

#[pymethods]
impl PyNetworkInfo {
    /// Legacy view of the outbound mode.
    ///
    /// Deprecated: read `network.outbound.mode`.
    #[getter]
    fn mode(&self) -> String {
        self.outbound.mode.clone()
    }

    /// Legacy view of the outbound allowlist.
    ///
    /// Deprecated: read `network.outbound.allow_net`.
    #[getter]
    fn allow_net(&self) -> Vec<String> {
        self.outbound.allow_net.clone()
    }

    fn __repr__(&self) -> String {
        serde_json::to_string_pretty(&self.json_value()).unwrap_or_default()
    }
}

// ============================================================================
// HealthState - Health check state enumeration
// ============================================================================

#[pyclass(name = "HealthState")]
#[derive(Clone, Debug)]
pub struct PyHealthState {
    #[pyo3(get)]
    pub(crate) value: String,
}

#[pymethods]
impl PyHealthState {
    fn __repr__(&self) -> String {
        format!("<HealthState: {}>", self.value)
    }

    fn __str__(&self) -> String {
        self.value.clone()
    }

    #[staticmethod]
    fn none() -> Self {
        Self {
            value: "none".to_string(),
        }
    }

    #[staticmethod]
    fn starting() -> Self {
        Self {
            value: "starting".to_string(),
        }
    }

    #[staticmethod]
    fn healthy() -> Self {
        Self {
            value: "healthy".to_string(),
        }
    }

    #[staticmethod]
    fn unhealthy() -> Self {
        Self {
            value: "unhealthy".to_string(),
        }
    }

    fn is_none(&self) -> bool {
        self.value == "none"
    }

    fn is_starting(&self) -> bool {
        self.value == "starting"
    }

    fn is_healthy(&self) -> bool {
        self.value == "healthy"
    }

    fn is_unhealthy(&self) -> bool {
        self.value == "unhealthy"
    }
}

// ============================================================================
// HealthStatus - Health check status
// ============================================================================

#[pyclass(name = "HealthStatus")]
#[derive(Clone)]
pub struct PyHealthStatus {
    #[pyo3(get)]
    pub(crate) state: PyHealthState,
    #[pyo3(get)]
    pub(crate) failures: u32,
    #[pyo3(get)]
    pub(crate) last_check: Option<String>,
}

#[pymethods]
impl PyHealthStatus {
    fn __repr__(&self) -> String {
        serde_json::to_string_pretty(&serde_json::json!({
            "state": self.state.value,
            "failures": self.failures,
            "last_check": self.last_check
        }))
        .unwrap_or_default()
    }
}

// ============================================================================
// BoxStateInfo - Runtime state (Docker-like State object)
// ============================================================================

#[pyclass(name = "BoxStateInfo")]
#[derive(Clone)]
pub struct PyBoxStateInfo {
    #[pyo3(get)]
    pub(crate) status: String,
    #[pyo3(get)]
    pub(crate) running: bool,
    #[pyo3(get)]
    pub(crate) pid: Option<u32>,
}

#[pymethods]
impl PyBoxStateInfo {
    fn __repr__(&self) -> String {
        serde_json::to_string_pretty(&serde_json::json!({
            "status": self.status,
            "running": self.running,
            "pid": self.pid,
        }))
        .unwrap_or_default()
    }
}

fn status_to_string(status: BoxStatus) -> String {
    match status {
        BoxStatus::Unknown => "unknown",
        BoxStatus::Configured => "configured",
        BoxStatus::Running => "running",
        BoxStatus::Stopping => "stopping",
        BoxStatus::Stopped => "stopped",
        BoxStatus::Paused => "paused",
        BoxStatus::Failed => "failed",
    }
    .to_string()
}

fn health_state_to_py(state: &CoreHealthState) -> PyHealthState {
    let value = match state {
        CoreHealthState::None => "none",
        CoreHealthState::Starting => "starting",
        CoreHealthState::Healthy => "healthy",
        CoreHealthState::Unhealthy => "unhealthy",
    }
    .to_string();
    PyHealthState { value }
}

impl From<BoxStateInfo> for PyBoxStateInfo {
    fn from(state_info: BoxStateInfo) -> Self {
        PyBoxStateInfo {
            status: status_to_string(state_info.status),
            running: state_info.running,
            pid: state_info.pid,
        }
    }
}

// ============================================================================
// BoxInfo - Container info with nested state
// ============================================================================

#[pyclass(name = "BoxInfo")]
#[derive(Clone)]
pub(crate) struct PyBoxInfo {
    #[pyo3(get)]
    pub(crate) id: String,
    #[pyo3(get)]
    pub(crate) name: Option<String>,
    #[pyo3(get)]
    pub(crate) state: PyBoxStateInfo,
    #[pyo3(get)]
    pub(crate) created_at: String,
    #[pyo3(get)]
    pub(crate) started_at: Option<String>,
    #[pyo3(get)]
    pub(crate) image: String,
    #[pyo3(get)]
    pub(crate) cpus: u8,
    #[pyo3(get)]
    pub(crate) memory_mib: u32,
    #[pyo3(get)]
    pub(crate) network: Option<PyNetworkInfo>,
    #[pyo3(get)]
    pub(crate) auto_stop: u32,
    #[pyo3(get)]
    pub(crate) auto_delete: u32,
    #[pyo3(get)]
    pub(crate) auto_resume: bool,
    #[pyo3(get)]
    pub(crate) health_status: PyHealthStatus,
}

#[pymethods]
impl PyBoxInfo {
    fn __repr__(&self) -> String {
        let network = self.network.as_ref().map(PyNetworkInfo::json_value);
        serde_json::to_string_pretty(&serde_json::json!({
            "id": self.id,
            "name": self.name,
            "state": {
                "status": self.state.status,
                "running": self.state.running,
                "pid": self.state.pid,
            },
            "image": self.image,
            "cpus": self.cpus,
            "memory_mib": self.memory_mib,
            "network": network,
            "auto_stop": self.auto_stop,
            "auto_delete": self.auto_delete,
            "auto_resume": self.auto_resume,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "health_status": {
                "state": self.health_status.state.value,
                "failures": self.health_status.failures,
                "last_check": self.health_status.last_check
            }
        }))
        .unwrap_or_default()
    }
}

impl From<BoxInfo> for PyBoxInfo {
    fn from(info: BoxInfo) -> Self {
        let state_info = BoxStateInfo::from(&info);
        let state = PyBoxStateInfo::from(state_info);
        let health_status = PyHealthStatus {
            state: health_state_to_py(&info.health_status.state),
            failures: info.health_status.failures,
            last_check: info.health_status.last_check.map(|dt| dt.to_rfc3339()),
        };
        PyBoxInfo {
            id: info.id.to_string(),
            name: info.name,
            state,
            created_at: info.created_at.to_rfc3339(),
            started_at: info.started_at.map(|at| at.to_rfc3339()),
            image: info.image,
            cpus: info.cpus,
            memory_mib: info.memory_mib,
            network: info.network.map(PyNetworkInfo::from),
            auto_stop: info.auto_stop,
            auto_delete: info.auto_delete,
            auto_resume: info.auto_resume,
            health_status,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::{Duration, SystemTime};

    use boxlite::runtime::options::PortProtocol;
    use boxlite::{
        BoxID, BoxInfo, BoxStatus, HealthStatus, InboundNetworkInfo, NetworkInfo, NetworkMode,
        OutboundNetworkInfo, PublishedPort,
    };

    use super::PyBoxInfo;

    fn core_info(network: Option<NetworkInfo>) -> BoxInfo {
        BoxInfo {
            id: BoxID::parse("box-python-info").unwrap(),
            name: Some("python-info".to_string()),
            status: BoxStatus::Running,
            created_at: SystemTime::UNIX_EPOCH.into(),
            last_updated: SystemTime::UNIX_EPOCH.into(),
            pid: Some(1234),
            image: "alpine:latest".to_string(),
            cpus: 2,
            memory_mib: 512,
            network,
            labels: HashMap::new(),
            auto_stop: 0,
            auto_delete: 0,
            auto_resume: true,
            health_status: HealthStatus::default(),
            exit_code: None,
            started_at: None,
        }
    }

    #[test]
    fn box_info_conversion_preserves_network_and_publication_state() {
        let resolved = PyBoxInfo::from(core_info(Some(NetworkInfo::new(
            OutboundNetworkInfo {
                mode: NetworkMode::Enabled,
                allow_net: vec!["api.example.com".to_string()],
            },
            InboundNetworkInfo {
                mode: NetworkMode::Disabled,
                allow_net: Vec::new(),
            },
            Some(vec![PublishedPort {
                guest_port: 3000,
                host_ip: "127.0.0.1".to_string(),
                host_port: 49152,
                protocol: PortProtocol::Tcp,
            }]),
        ))));

        let network = resolved.network.expect("network metadata");
        assert_eq!(network.outbound.mode, "enabled");
        assert_eq!(network.outbound.allow_net, vec!["api.example.com"]);
        assert_eq!(network.inbound.mode, "disabled");
        let ports = network.published_ports.expect("resolved publications");
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].guest_port, 3000);
        assert_eq!(ports[0].host_ip, "127.0.0.1");
        assert_eq!(ports[0].host_port, 49152);
        assert_eq!(ports[0].protocol, "tcp");

        let resolved_empty = PyBoxInfo::from(core_info(Some(NetworkInfo::new(
            OutboundNetworkInfo {
                mode: NetworkMode::Disabled,
                allow_net: Vec::new(),
            },
            InboundNetworkInfo {
                mode: NetworkMode::Enabled,
                allow_net: Vec::new(),
            },
            Some(Vec::new()),
        ))));
        assert!(
            resolved_empty
                .network
                .expect("network metadata")
                .published_ports
                .expect("resolved publications")
                .is_empty()
        );

        let unresolved = PyBoxInfo::from(core_info(Some(NetworkInfo::new(
            OutboundNetworkInfo {
                mode: NetworkMode::Enabled,
                allow_net: Vec::new(),
            },
            InboundNetworkInfo {
                mode: NetworkMode::Enabled,
                allow_net: Vec::new(),
            },
            None,
        ))));
        assert!(
            unresolved
                .network
                .expect("network metadata")
                .published_ports
                .is_none()
        );

        assert!(PyBoxInfo::from(core_info(None)).network.is_none());
    }

    #[test]
    fn box_info_conversion_exposes_started_at() {
        let mut info = core_info(None);
        info.started_at = Some((SystemTime::UNIX_EPOCH + Duration::from_secs(1)).into());

        let started = PyBoxInfo::from(info);
        assert_eq!(
            started.started_at.as_deref(),
            Some("1970-01-01T00:00:01+00:00")
        );
        assert!(PyBoxInfo::from(core_info(None)).started_at.is_none());
    }
}
