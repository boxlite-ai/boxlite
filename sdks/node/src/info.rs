use boxlite::NetworkMode;
use boxlite::litebox::HealthState as CoreHealthState;
use boxlite::runtime::options::PortProtocol;
use boxlite::runtime::types::{BoxInfo, BoxStateInfo, BoxStatus, NetworkInfo, PublishedPort};
use napi::bindgen_prelude::{Either, Null};
use napi_derive::napi;

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

#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsPublishedPort {
    #[napi(js_name = "guestPort")]
    pub guest_port: u16,
    #[napi(js_name = "hostIp")]
    pub host_ip: String,
    #[napi(js_name = "hostPort")]
    pub host_port: u16,
    pub protocol: String,
}

impl From<PublishedPort> for JsPublishedPort {
    fn from(port: PublishedPort) -> Self {
        Self {
            guest_port: port.guest_port,
            host_ip: port.host_ip,
            host_port: port.host_port,
            protocol: port_protocol_to_string(port.protocol),
        }
    }
}

#[napi(object, use_nullable = true)]
#[derive(Clone, Debug)]
pub struct JsNetworkInfo {
    pub mode: String,
    #[napi(js_name = "allowNet")]
    pub allow_net: Vec<String>,
    /// `None` becomes `null` when this handle does not know the bindings; an
    /// empty array means there are no active publications.
    #[napi(js_name = "publishedPorts")]
    pub published_ports: Option<Vec<JsPublishedPort>>,
}

impl From<NetworkInfo> for JsNetworkInfo {
    fn from(network: NetworkInfo) -> Self {
        Self {
            mode: network_mode_to_string(network.mode),
            allow_net: network.allow_net,
            published_ports: network
                .published_ports
                .map(|ports| ports.into_iter().map(JsPublishedPort::from).collect()),
        }
    }
}

// ============================================================================
// HealthState - Health check state enumeration
// ============================================================================

/// Health state of a box.
#[napi(string_enum)]
#[derive(Clone, Debug)]
pub enum JsHealthState {
    /// No health check configured
    None,
    /// Within start_period, not yet checked
    Starting,
    /// Last health check passed
    Healthy,
    /// Failed retries consecutive checks
    Unhealthy,
}

fn health_state_to_js(state: &CoreHealthState) -> JsHealthState {
    match state {
        CoreHealthState::None => JsHealthState::None,
        CoreHealthState::Starting => JsHealthState::Starting,
        CoreHealthState::Healthy => JsHealthState::Healthy,
        CoreHealthState::Unhealthy => JsHealthState::Unhealthy,
    }
}

// ============================================================================
// HealthStatus - Health check status
// ============================================================================

/// Health status of a box with health check enabled.
///
/// Tracks the current health state and consecutive failure count.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsHealthStatus {
    /// Current health state
    pub state: JsHealthState,
    /// Consecutive health check failures
    pub failures: u32,
    /// Last health check timestamp (ISO 8601 format)
    pub last_check: Option<String>,
}

// ============================================================================
// BoxStateInfo - Runtime state (Docker-like State object)
// ============================================================================

/// Runtime state information for a box.
///
/// Contains dynamic state that changes during the box lifecycle,
/// following Docker's State object pattern.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsBoxStateInfo {
    /// Current lifecycle status ("configured", "running", "stopped", etc.)
    pub status: String,

    /// Whether the box is currently running
    pub running: bool,

    /// Process ID of the VMM subprocess (undefined if not running)
    pub pid: Option<u32>,
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

impl From<BoxStateInfo> for JsBoxStateInfo {
    fn from(state_info: BoxStateInfo) -> Self {
        Self {
            status: status_to_string(state_info.status),
            running: state_info.running,
            pid: state_info.pid,
        }
    }
}

// ============================================================================
// BoxInfo - Container info with nested state
// ============================================================================

/// Public metadata about a box (returned by list operations).
///
/// Provides read-only information about a box's identity, configuration,
/// and runtime state. The `state` field contains dynamic runtime information.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsBoxInfo {
    /// Unique box identifier (ULID format)
    pub id: String,

    /// User-defined name (optional)
    pub name: Option<String>,

    /// Runtime state information
    pub state: JsBoxStateInfo,

    /// Creation timestamp (ISO 8601 format)
    pub created_at: String,

    /// Image reference or rootfs path
    pub image: String,

    /// Allocated CPU count
    pub cpus: u8,

    /// Allocated memory in MiB
    pub memory_mib: u32,

    /// Network configuration and resolved local publications, when available.
    pub network: Either<JsNetworkInfo, Null>,

    /// Idle time in seconds before AutoPause; 0 disables it.
    #[napi(js_name = "autoPause")]
    pub auto_pause: u32,

    /// Stopped time in seconds before AutoDelete; 0 disables it.
    #[napi(js_name = "autoDelete")]
    pub auto_delete: u32,

    /// Whether the box automatically resumes when accessed after AutoPause.
    #[napi(js_name = "autoResume")]
    pub auto_resume: bool,

    /// Health status
    pub health_status: JsHealthStatus,
}

impl From<BoxInfo> for JsBoxInfo {
    fn from(info: BoxInfo) -> Self {
        let state_info = BoxStateInfo::from(&info);
        let state = JsBoxStateInfo::from(state_info);
        let health_status = JsHealthStatus {
            state: health_state_to_js(&info.health_status.state),
            failures: info.health_status.failures,
            last_check: info.health_status.last_check.map(|dt| dt.to_rfc3339()),
        };
        Self {
            id: info.id.to_string(),
            name: info.name,
            state,
            created_at: info.created_at.to_rfc3339(),
            image: info.image,
            cpus: info.cpus,
            memory_mib: info.memory_mib,
            network: match info.network {
                Some(network) => Either::A(JsNetworkInfo::from(network)),
                None => Either::B(Null),
            },
            auto_pause: info.auto_pause,
            auto_delete: info.auto_delete,
            auto_resume: info.auto_resume,
            health_status,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::SystemTime;

    use boxlite::runtime::options::PortProtocol;
    use boxlite::{
        BoxID, BoxInfo, BoxStatus, HealthStatus, NetworkInfo, NetworkMode, PublishedPort,
    };

    use napi::bindgen_prelude::Either;

    use super::JsBoxInfo;

    fn core_info(network: Option<NetworkInfo>) -> BoxInfo {
        BoxInfo {
            id: BoxID::parse("box-node-info").unwrap(),
            name: Some("node-info".to_string()),
            status: BoxStatus::Running,
            created_at: SystemTime::UNIX_EPOCH.into(),
            last_updated: SystemTime::UNIX_EPOCH.into(),
            pid: Some(1234),
            image: "alpine:latest".to_string(),
            cpus: 2,
            memory_mib: 512,
            network,
            labels: HashMap::new(),
            auto_pause: 0,
            auto_delete: 0,
            auto_resume: true,
            health_status: HealthStatus::default(),
            exit_code: None,
        }
    }

    #[test]
    fn box_info_conversion_preserves_network_and_publication_state() {
        let resolved = JsBoxInfo::from(core_info(Some(NetworkInfo {
            mode: NetworkMode::Enabled,
            allow_net: vec!["api.example.com".to_string()],
            published_ports: Some(vec![PublishedPort {
                guest_port: 3000,
                host_ip: "127.0.0.1".to_string(),
                host_port: 49152,
                protocol: PortProtocol::Tcp,
            }]),
        })));

        let network = match resolved.network {
            Either::A(network) => network,
            Either::B(_) => panic!("network metadata missing"),
        };
        assert_eq!(network.mode, "enabled");
        assert_eq!(network.allow_net, vec!["api.example.com"]);
        let ports = network.published_ports.expect("resolved publications");
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].guest_port, 3000);
        assert_eq!(ports[0].host_ip, "127.0.0.1");
        assert_eq!(ports[0].host_port, 49152);
        assert_eq!(ports[0].protocol, "tcp");

        let resolved_empty = JsBoxInfo::from(core_info(Some(NetworkInfo {
            mode: NetworkMode::Disabled,
            allow_net: Vec::new(),
            published_ports: Some(Vec::new()),
        })));
        let network = match resolved_empty.network {
            Either::A(network) => network,
            Either::B(_) => panic!("network metadata missing"),
        };
        assert!(
            network
                .published_ports
                .expect("resolved publications")
                .is_empty()
        );

        let unresolved = JsBoxInfo::from(core_info(Some(NetworkInfo {
            mode: NetworkMode::Enabled,
            allow_net: Vec::new(),
            published_ports: None,
        })));
        let network = match unresolved.network {
            Either::A(network) => network,
            Either::B(_) => panic!("network metadata missing"),
        };
        assert!(network.published_ports.is_none());

        assert!(matches!(
            JsBoxInfo::from(core_info(None)).network,
            Either::B(_)
        ));
    }
}
