//! Guest service interface.

use super::container::{ContainerInterface, map_container_init_status};
use boxlite_shared::{
    BlockDeviceSource, BoxliteError, BoxliteResult, Filesystem, GuestBootstrapRequest,
    GuestBootstrapResponse, GuestClient, GuestInitRequest, NetworkInit, PingRequest, PingResponse,
    QuiesceRequest, ShutdownRequest, SyncClockRequest, ThawRequest, VirtiofsSource, Volume,
    guest_init_response,
};
use tonic::transport::Channel;

/// Guest service interface.
pub struct GuestInterface {
    client: GuestClient<Channel>,
    // Only used during bootstrap; health checks always issue a fresh RPC.
    bootstrap_info: Option<PingResponse>,
}

impl GuestInterface {
    /// Create from a channel.
    pub fn new(channel: Channel) -> Self {
        Self {
            client: GuestClient::new(channel),
            bootstrap_info: None,
        }
    }

    /// Initialize guest environment.
    ///
    /// This must be called first after connection, before Container.Init.
    /// Sets up volumes (virtiofs + block devices) and network.
    pub async fn init(&mut self, request: GuestInitRequest) -> BoxliteResult<()> {
        tracing::debug!("Sending GuestInit request");
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

    /// `None` means the peer predates Bootstrap; no initialization was performed.
    pub async fn bootstrap(
        &mut self,
        request: GuestBootstrapRequest,
    ) -> BoxliteResult<Option<bool>> {
        let container_id = request
            .container_init
            .as_ref()
            .map(|init| init.container_id.clone())
            .unwrap_or_default();
        match self.client.bootstrap(request).await {
            Ok(response) => {
                let response = response.into_inner();
                self.bootstrap_info = Some(PingResponse {
                    version: response.guest_version.clone(),
                    safe_managed_volume_sub_path: response.safe_volume_sub_path,
                });
                Self::decode_bootstrap_response(&container_id, response).map(Some)
            }
            Err(status) if status.code() == tonic::Code::Unimplemented => Ok(None),
            Err(status) => Err(map_container_init_status(status)),
        }
    }

    fn decode_bootstrap_response(
        container_id: &str,
        response: GuestBootstrapResponse,
    ) -> BoxliteResult<bool> {
        if let Some(init) = response.container_init {
            ContainerInterface::decode_init_response(container_id, init)?;
        } else if response.error.is_empty() {
            return Err(BoxliteError::Internal(
                "Guest.Bootstrap response missing container_init".into(),
            ));
        }
        if !response.error.is_empty() {
            return Err(BoxliteError::Internal(response.error));
        }
        Ok(response.started)
    }

    /// Ping the guest (health check).
    #[allow(dead_code)] // API method for future health checks
    pub async fn ping(&mut self) -> BoxliteResult<()> {
        let _response = self.client.ping(PingRequest {}).await?;
        Ok(())
    }

    pub(crate) async fn bootstrap_info(&mut self) -> BoxliteResult<&PingResponse> {
        if self.bootstrap_info.is_none() {
            self.bootstrap_info = Some(self.client.ping(PingRequest {}).await?.into_inner());
        }
        Ok(self
            .bootstrap_info
            .as_ref()
            .expect("bootstrap info populated"))
    }

    /// Fail before initialization if the guest predates a required field.
    ///
    /// A guest built before the field existed decodes it as an unknown proto
    /// field and drops it, so the request would appear to succeed while the
    /// setting was never applied. The guest reports its own build version;
    /// gate on that instead of letting the request through.
    pub async fn require_min_version(&mut self, minimum: GuestVersion) -> BoxliteResult<()> {
        ensure_guest_version(&self.bootstrap_info().await?.version, minimum)
    }

    /// Fail before initialization if the guest cannot pin managed-volume subdirectories.
    pub async fn require_safe_volume_sub_path(&mut self) -> BoxliteResult<()> {
        if self.bootstrap_info().await?.safe_managed_volume_sub_path {
            return Ok(());
        }
        Err(BoxliteError::Unsupported(
            "guest does not support safe managed-volume sub_path mounts; recreate the box with the current runtime"
                .into(),
        ))
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

    /// Correct CLOCK_REALTIME from UTC sampled by the host just before sending.
    ///
    /// The Linux/native shim pushes initially and checks every 2s, pushing on
    /// a >=6s check gap, >=60s since success, no success, or host clock rollback.
    /// It survives detached creator exit and needs no D-Bus. This host-only
    /// operation leaves the RTC and monotonic clock unchanged.
    /// Success means absolute drift <=100ms (no adjustment) or an accepted
    /// clock setting in either direction; 100ms is not a precision guarantee.
    /// Invalid timestamps, clock-read/set failures, and an agent without this
    /// method surface as errors.
    pub async fn sync_clock(&mut self, unix_sec: i64, nanos: i32) -> BoxliteResult<()> {
        let _response = self
            .client
            .sync_clock(SyncClockRequest { unix_sec, nanos })
            .await?;
        Ok(())
    }

    /// Fill the container root disk after the kernel observes its new capacity.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    pub(crate) async fn resize_filesystem(&mut self, minimum_bytes: u64) -> BoxliteResult<()> {
        self.client
            .resize_filesystem(boxlite_shared::ResizeFilesystemRequest {
                device: "/dev/vda".into(),
                minimum_bytes,
            })
            .await
            .map_err(|error| {
                if error.code() == tonic::Code::Unimplemented {
                    BoxliteError::Unsupported(
                        "guest has no filesystem resize RPC; restart with the current runtime"
                            .into(),
                    )
                } else {
                    BoxliteError::Engine(format!("guest filesystem resize failed: {error}"))
                }
            })?;
        Ok(())
    }
}

impl From<GuestInitConfig> for GuestInitRequest {
    fn from(config: GuestInitConfig) -> Self {
        Self {
            volumes: config.volumes.into_iter().map(|v| v.into_proto()).collect(),
            network: config.network.map(|n| NetworkInit {
                interface: n.interface,
                ip: n.ip,
                gateway: n.gateway,
            }),
        }
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

pub(crate) fn ensure_guest_version(version: &str, minimum: GuestVersion) -> BoxliteResult<()> {
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
    fn aggregate_mount_identity_survives_proto_conversion() {
        let config = VolumeConfig::Virtiofs {
            tag: "BoxLiteShared".into(),
            device_tag: "boxlite".into(),
            export_key: "shared".into(),
            mount_point: String::new(),
            read_only: true,
            container_id: None,
        };
        let encoded = config.into_proto();
        let Some(boxlite_shared::volume::Source::Virtiofs(fs)) = encoded.source else {
            panic!("filesystem source")
        };
        assert_eq!(fs.tag, "BoxLiteShared");
        assert_eq!(fs.device_tag, "boxlite");
        assert_eq!(fs.export_key, "shared");
        assert!(fs.read_only);
        let legacy = VolumeConfig::virtiofs("BoxLiteShared", "", false, None).into_proto();
        let Some(boxlite_shared::volume::Source::Virtiofs(fs)) = legacy.source else {
            panic!("filesystem source")
        };
        assert!(fs.device_tag.is_empty() && fs.export_key.is_empty());
    }

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
        /// Aggregate device tag and export key; empty for legacy mounts.
        device_tag: String,
        export_key: String,
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
            device_tag: String::new(),
            export_key: String::new(),
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
                device_tag,
                export_key,
                mount_point,
                read_only,
                container_id,
            } => Volume {
                mount_point,
                source: Some(boxlite_shared::volume::Source::Virtiofs(VirtiofsSource {
                    tag,
                    read_only,
                    device_tag,
                    export_key,
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
