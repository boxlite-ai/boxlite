//! Lifecycle-bound persistence for resolved host port mappings.
//!
//! Requested mappings live in [`BoxConfig`](super::config::BoxConfig). This
//! module owns the separate runtime fact: which concrete host endpoints belong
//! to the currently active shim lifecycle.

use std::io::Write;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

use super::config::BoxConfig;
use super::state::BoxState;
use crate::runtime::layout::dirs;
use crate::runtime::options::PortSpec;
use crate::runtime::types::PublishedPort;
use crate::util::{PidFileReader, PidRecord, ProcessIdentity};

const SNAPSHOT_VERSION: u8 = 1;
const DEFAULT_HOST_IP: IpAddr = IpAddr::V4(Ipv4Addr::UNSPECIFIED);

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct SnapshotEnvelope {
    version: u8,
    lifecycle: PidRecord,
    runtime: PidRecord,
    ports: Vec<PublishedPort>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SnapshotDocument {
    Current(SnapshotEnvelope),
    Legacy(Vec<PortSpec>),
}

/// Resolved-port view safe to expose through [`crate::BoxInfo`].
pub(crate) struct PortResolution {
    pub(crate) published_ports: Option<Vec<PublishedPort>>,
}

impl PortResolution {
    fn resolved(published_ports: Vec<PublishedPort>) -> Self {
        Self {
            published_ports: Some(published_ports),
        }
    }

    fn unresolved() -> Self {
        Self {
            published_ports: None,
        }
    }

    /// Build a synchronous snapshot without trusting data from another VM
    /// lifecycle. Missing or invalid runtime evidence is explicitly unresolved,
    /// never a believable empty set.
    pub(crate) fn load(config: &BoxConfig, state: &BoxState) -> Self {
        if config.options.ports.is_empty() {
            return Self::resolved(Vec::new());
        }
        let pid_file = PidFileReader::at(config.box_home.join(dirs::SHIM_PID_FILE));
        match state.status {
            crate::BoxStatus::Configured | crate::BoxStatus::Stopped | crate::BoxStatus::Failed => {
                // Start/restart publishes ports before the public state flips
                // to Running, and failed cleanup can itself fail. A verified
                // live shim means "empty" has not yet been proven.
                return if pid_file.process_identity() != ProcessIdentity::Absent {
                    Self::unresolved()
                } else {
                    Self::resolved(Vec::new())
                };
            }
            crate::BoxStatus::Unknown | crate::BoxStatus::Stopping => {
                return Self::unresolved();
            }
            crate::BoxStatus::Running | crate::BoxStatus::Paused => {}
        }

        let Some(state_pid) = state.pid else {
            return Self::unresolved();
        };
        let Some(shim) = pid_file.verified_shim() else {
            return Self::unresolved();
        };
        if !shim.has_runtime_port_control() {
            return Self::unresolved();
        }
        let lifecycle = shim.identity();
        if lifecycle.pid != state_pid {
            return Self::unresolved();
        }

        let snapshot = ResolvedPortsSnapshot::at(
            config
                .box_home
                .join(dirs::LOGS_DIR)
                .join(dirs::RESOLVED_PORTS_FILE),
        );
        let Some(envelope) = snapshot.read_current_best_effort() else {
            return Self::unresolved();
        };
        if envelope.version != SNAPSHOT_VERSION
            || envelope.lifecycle != lifecycle
            || envelope.runtime != PidRecord::current()
            || !bindings_match_requests(&config.options.ports, &envelope.ports)
        {
            return Self::unresolved();
        }

        Self::resolved(envelope.ports)
    }
}

/// Atomic on-disk store shared by publication, reconciliation, and BoxInfo.
pub(crate) struct ResolvedPortsSnapshot {
    path: PathBuf,
}

impl ResolvedPortsSnapshot {
    pub(crate) fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub(crate) fn clear(&self) -> BoxliteResult<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(BoxliteError::Storage(format!(
                "remove stale resolved port snapshot {}: {error}",
                self.path.display()
            ))),
        }
    }

    pub(crate) fn clear_best_effort(&self) {
        if let Err(error) = self.clear() {
            tracing::warn!(
                path = %self.path.display(),
                %error,
                "Failed to clear resolved port snapshot after publication failure"
            );
        }
    }

    /// Read bindings only as reconciliation hints. Both the versioned format
    /// and the prior bare-array format are accepted here because gvproxy's live
    /// `/all` response remains the authority before any hint is adopted.
    pub(crate) fn previous_bindings_best_effort(&self) -> Vec<PublishedPort> {
        match self.read_document_best_effort() {
            Some(SnapshotDocument::Current(envelope)) => envelope.ports,
            Some(SnapshotDocument::Legacy(ports)) => ports
                .into_iter()
                .map(legacy_published_port)
                .collect::<Option<Vec<_>>>()
                .unwrap_or_default(),
            None => Vec::new(),
        }
    }

    pub(crate) fn replace(
        &self,
        lifecycle: PidRecord,
        ports: &[PublishedPort],
    ) -> BoxliteResult<()> {
        let parent = self.path.parent().ok_or_else(|| {
            BoxliteError::Storage(format!(
                "resolved port snapshot path has no parent: {}",
                self.path.display()
            ))
        })?;
        let envelope = SnapshotEnvelope {
            version: SNAPSHOT_VERSION,
            lifecycle,
            // A shim lifecycle survives a core-process crash. Binding the
            // snapshot to the core that confirmed it prevents a replacement
            // core from trusting a same-lifecycle crash-window file before it
            // checks gvproxy's live state.
            runtime: PidRecord::current(),
            ports: ports.to_vec(),
        };
        if self.read_current_best_effort().as_ref() == Some(&envelope) {
            return Ok(());
        }

        // The filesystem task owns directory creation. Refusing to recreate a
        // missing parent prevents a late reconciliation write from resurrecting
        // a box directory that concurrent removal has already deleted.
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|error| {
            BoxliteError::Storage(format!(
                "create temporary resolved port snapshot in {}: {error}",
                parent.display()
            ))
        })?;
        serde_json::to_writer(temporary.as_file_mut(), &envelope).map_err(|error| {
            BoxliteError::Storage(format!(
                "serialize resolved port snapshot {}: {error}",
                self.path.display()
            ))
        })?;
        temporary.as_file_mut().write_all(b"\n").map_err(|error| {
            BoxliteError::Storage(format!(
                "write resolved port snapshot {}: {error}",
                self.path.display()
            ))
        })?;
        temporary.as_file_mut().sync_all().map_err(|error| {
            BoxliteError::Storage(format!(
                "sync resolved port snapshot {}: {error}",
                self.path.display()
            ))
        })?;
        temporary.persist(&self.path).map_err(|error| {
            BoxliteError::Storage(format!(
                "install resolved port snapshot {}: {}",
                self.path.display(),
                error.error
            ))
        })?;
        Ok(())
    }

    fn read_current_best_effort(&self) -> Option<SnapshotEnvelope> {
        match self.read_document_best_effort()? {
            SnapshotDocument::Current(envelope) => Some(envelope),
            SnapshotDocument::Legacy(_) => None,
        }
    }

    fn read_document_best_effort(&self) -> Option<SnapshotDocument> {
        let contents = match std::fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                tracing::warn!(
                    path = %self.path.display(),
                    %error,
                    "Failed to read resolved port snapshot"
                );
                return None;
            }
        };

        serde_json::from_str(&contents)
            .map_err(|error| {
                tracing::warn!(
                    path = %self.path.display(),
                    %error,
                    "Failed to parse resolved port snapshot"
                );
            })
            .ok()
    }
}

fn bindings_match_requests(requested: &[PortSpec], resolved: &[PublishedPort]) -> bool {
    requested.len() == resolved.len()
        && requested.iter().zip(resolved).all(|(request, binding)| {
            if binding.host_port == 0 {
                return false;
            }
            let Some(request_host_ip) = normalized_host_ip(request) else {
                return false;
            };
            let Ok(binding_host_ip) = binding.host_ip.parse::<IpAddr>() else {
                return false;
            };

            binding.guest_port == request.guest_port
                && binding.protocol == request.protocol
                && binding_host_ip == request_host_ip
                && request.host_port.is_none_or(|requested_port| {
                    requested_port == 0 || requested_port == binding.host_port
                })
        })
}

fn legacy_published_port(port: PortSpec) -> Option<PublishedPort> {
    Some(PublishedPort {
        guest_port: port.guest_port,
        host_ip: normalized_host_ip(&port)?.to_string(),
        host_port: port.host_port.filter(|host_port| *host_port != 0)?,
        protocol: port.protocol,
    })
}

fn normalized_host_ip(port: &PortSpec) -> Option<IpAddr> {
    port.host_ip
        .as_deref()
        .map(str::parse::<IpAddr>)
        .transpose()
        .ok()
        .map(|host_ip| host_ip.unwrap_or(DEFAULT_HOST_IP))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::options::PortProtocol;

    fn mapping(host_port: Option<u16>) -> PortSpec {
        PortSpec {
            host_port,
            guest_port: 3000,
            protocol: PortProtocol::Tcp,
            host_ip: Some("127.0.0.1".to_string()),
        }
    }

    fn published_port(host_port: u16) -> PublishedPort {
        PublishedPort {
            guest_port: 3000,
            host_ip: "127.0.0.1".to_string(),
            host_port,
            protocol: PortProtocol::Tcp,
        }
    }

    #[test]
    fn binding_validation_distinguishes_concrete_results_from_requests() {
        assert!(bindings_match_requests(
            &[mapping(None)],
            &[published_port(49152)]
        ));
        assert!(!bindings_match_requests(
            &[mapping(None)],
            &[published_port(0)]
        ));
        assert!(!bindings_match_requests(
            &[mapping(Some(8080))],
            &[published_port(8081)]
        ));
    }

    #[test]
    fn snapshot_writer_does_not_recreate_a_removed_box_directory() {
        let temp_dir = tempfile::tempdir().unwrap();
        let logs_dir = temp_dir.path().join("removed-box").join("logs");
        let snapshot = ResolvedPortsSnapshot::at(logs_dir.join("resolved-ports.json"));

        let error = snapshot
            .replace(PidRecord::current(), &[published_port(49152)])
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("temporary resolved port snapshot")
        );
        assert!(
            !logs_dir.exists(),
            "a late metadata write must not resurrect a removed box"
        );
    }

    #[test]
    fn invalid_legacy_snapshot_is_rejected_without_shifting_binding_indexes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let snapshot_path = temp_dir.path().join("resolved-ports.json");
        let legacy = vec![mapping(Some(49152)), mapping(None), mapping(Some(49154))];
        std::fs::write(&snapshot_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let bindings = ResolvedPortsSnapshot::at(snapshot_path).previous_bindings_best_effort();

        assert!(
            bindings.is_empty(),
            "one invalid positional entry must invalidate the whole legacy snapshot"
        );
    }
}
