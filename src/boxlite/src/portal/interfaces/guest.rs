//! Guest service interface.

use boxlite_shared::{
    BlockDeviceSource, BoxliteError, BoxliteResult, Filesystem, GuestClient, GuestInitRequest,
    NetworkInit, PingRequest, QuiesceRequest, ShutdownRequest, ThawRequest, VirtiofsSource, Volume,
    guest_init_response,
};
use tonic::transport::Channel;

/// Guest service interface.
pub struct GuestInterface {
    client: GuestClient<Channel>,
}

impl GuestInterface {
    /// Create from a channel.
    pub fn new(channel: Channel) -> Self {
        Self {
            client: GuestClient::new(channel),
        }
    }

    /// Initialize guest environment.
    ///
    /// This must be called first after connection, before Container.Init.
    /// Sets up volumes (virtiofs + block devices) and network.
    pub async fn init(&mut self, config: GuestInitConfig) -> BoxliteResult<()> {
        tracing::debug!("Sending GuestInit request");
        tracing::trace!(
            volumes = config.volumes.len(),
            network = ?config.network,
            "Guest init configuration"
        );

        let request = GuestInitRequest {
            volumes: config.volumes.into_iter().map(|v| v.into_proto()).collect(),
            network: config.network.map(|n| NetworkInit {
                interface: n.interface,
                ip: n.ip,
                gateway: n.gateway,
            }),
        };

        let response = self.client.init(request).await?.into_inner();

        match response.result {
            Some(guest_init_response::Result::Success(_)) => {
                tracing::debug!("Guest initialized");
                Ok(())
            }
            Some(guest_init_response::Result::Error(err)) => {
                tracing::error!("Guest init failed: {}", err.reason);
                Err(BoxliteError::Internal(format!(
                    "Guest init failed: {}",
                    err.reason
                )))
            }
            None => Err(BoxliteError::Internal(
                "GuestInit response missing result".to_string(),
            )),
        }
    }

    /// Ping the guest (health check).
    #[allow(dead_code)] // API method for future health checks
    pub async fn ping(&mut self) -> BoxliteResult<()> {
        let _response = self.client.ping(PingRequest {}).await?;
        Ok(())
    }

    /// Fail before initialization if the guest predates a required field.
    ///
    /// A guest built before the field existed decodes it as an unknown proto
    /// field and drops it, so the request would appear to succeed while the
    /// setting was never applied. The guest reports its own build version;
    /// gate on that instead of letting the request through.
    pub async fn require_min_version(&mut self, minimum: GuestVersion) -> BoxliteResult<()> {
        let response = self.client.ping(PingRequest {}).await?.into_inner();
        ensure_guest_version(&response.version, minimum)
    }

    /// Shutdown the guest agent.
    pub async fn shutdown(&mut self) -> BoxliteResult<()> {
        let _response = self.client.shutdown(ShutdownRequest {}).await?;
        Ok(())
    }

    /// Quiesce guest filesystems (FIFREEZE).
    ///
    /// Flushes dirty pages and blocks new writes atomically.
    /// Returns the number of filesystems frozen.
    pub async fn quiesce(&mut self) -> BoxliteResult<u32> {
        let response = self.client.quiesce(QuiesceRequest {}).await?.into_inner();
        Ok(response.frozen_count)
    }

    /// Thaw guest filesystems (FITHAW).
    ///
    /// Unblocks writes on filesystems frozen by the last quiesce call.
    /// Returns the number of filesystems thawed.
    pub async fn thaw(&mut self) -> BoxliteResult<u32> {
        let response = self.client.thaw(ThawRequest {}).await?.into_inner();
        Ok(response.thawed_count)
    }
}

/// A guest agent version as `(major, minor, patch)`.
pub type GuestVersion = (u32, u32, u32);

/// Parse the `major.minor.patch` core of a guest version.
///
/// Any pre-release or build suffix is ignored, so a `0.9.8-rc1` guest counts
/// as 0.9.8: it is built from the tree that carries the field. Anything that
/// does not parse yields `None` and is rejected by the caller.
fn parse_guest_version(version: &str) -> Option<GuestVersion> {
    let mut parts = version.split(['-', '+']).next()?.split('.');
    let mut next = || parts.next()?.parse::<u32>().ok();
    let parsed = (next()?, next()?, next()?);
    parts.next().is_none().then_some(parsed)
}

fn ensure_guest_version(version: &str, minimum: GuestVersion) -> BoxliteResult<()> {
    let (major, minor, patch) = minimum;
    let Some(reported) = parse_guest_version(version) else {
        return Err(BoxliteError::Unsupported(format!(
            "guest reported an unrecognized version '{version}'; {major}.{minor}.{patch} or newer is required"
        )));
    };

    if reported >= minimum {
        return Ok(());
    }

    Err(BoxliteError::Unsupported(format!(
        "guest {version} is older than the required {major}.{minor}.{patch}; recreate the box with the current runtime"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMUM: GuestVersion = (0, 9, 8);

    #[test]
    fn guest_older_than_the_minimum_is_rejected() {
        for version in ["0.9.7", "0.8.9", "0.9.7-rc1"] {
            let error = ensure_guest_version(version, MINIMUM)
                .expect_err("an old guest must not silently drop the field");

            assert!(matches!(error, BoxliteError::Unsupported(_)));
            assert!(
                error.to_string().contains(version) && error.to_string().contains("0.9.8"),
                "error should name both versions: {error}"
            );
        }
    }

    #[test]
    fn guest_at_or_above_the_minimum_is_accepted() {
        for version in ["0.9.8", "0.9.9", "0.10.0", "1.0.0", "0.9.8-rc1"] {
            ensure_guest_version(version, MINIMUM)
                .unwrap_or_else(|error| panic!("{version} should be accepted: {error}"));
        }
    }

    #[test]
    fn unparseable_guest_version_is_rejected() {
        for version in ["", "0.9", "0.9.8.1", "abc", "0.x.8"] {
            let error = ensure_guest_version(version, MINIMUM)
                .expect_err("an unreadable version must fail closed");

            assert!(matches!(error, BoxliteError::Unsupported(_)));
        }
    }
}

/// Configuration for guest initialization.
#[derive(Debug)]
pub struct GuestInitConfig {
    /// Volumes to mount (virtiofs + block devices)
    pub volumes: Vec<VolumeConfig>,
    /// Network configuration (optional)
    pub network: Option<NetworkInitConfig>,
}

/// Volume configuration.
#[derive(Debug, Clone)]
pub enum VolumeConfig {
    /// Virtiofs mount
    Virtiofs {
        /// Virtiofs tag
        tag: String,
        /// Mount point in guest
        mount_point: String,
        read_only: bool,
        /// Optional container_id for convention-based paths
        container_id: Option<String>,
    },
    /// Block device mount
    BlockDevice {
        /// Device path (e.g., "/dev/vda")
        device: String,
        /// Mount point in guest
        mount_point: String,
        /// Filesystem type
        filesystem: Filesystem,
        /// If true, format device before mounting
        need_format: bool,
        /// If true, resize filesystem after mounting to fill disk
        need_resize: bool,
    },
}

impl VolumeConfig {
    /// Create virtiofs volume config.
    pub fn virtiofs(
        tag: impl Into<String>,
        mount_point: impl Into<String>,
        read_only: bool,
        container_id: Option<String>,
    ) -> Self {
        Self::Virtiofs {
            tag: tag.into(),
            mount_point: mount_point.into(),
            read_only,
            container_id,
        }
    }

    /// Create block device volume config.
    pub fn block_device(
        device: impl Into<String>,
        mount_point: impl Into<String>,
        filesystem: Filesystem,
        need_format: bool,
        need_resize: bool,
    ) -> Self {
        Self::BlockDevice {
            device: device.into(),
            mount_point: mount_point.into(),
            filesystem,
            need_format,
            need_resize,
        }
    }

    fn into_proto(self) -> Volume {
        match self {
            VolumeConfig::Virtiofs {
                tag,
                mount_point,
                read_only,
                container_id,
            } => Volume {
                mount_point,
                source: Some(boxlite_shared::volume::Source::Virtiofs(VirtiofsSource {
                    tag,
                    read_only,
                })),
                container_id: container_id.unwrap_or_default(),
            },
            VolumeConfig::BlockDevice {
                device,
                mount_point,
                filesystem,
                need_format,
                need_resize,
            } => Volume {
                mount_point,
                source: Some(boxlite_shared::volume::Source::BlockDevice(
                    BlockDeviceSource {
                        device,
                        filesystem: filesystem.into(),
                        need_format,
                        need_resize,
                    },
                )),
                container_id: String::new(),
            },
        }
    }
}

/// Network initialization configuration.
#[derive(Debug)]
pub struct NetworkInitConfig {
    /// Interface name (e.g., "eth0")
    pub interface: String,
    /// IP address with prefix (e.g., "192.168.127.2/24")
    pub ip: Option<String>,
    /// Gateway address (e.g., "192.168.127.1")
    pub gateway: Option<String>,
}
