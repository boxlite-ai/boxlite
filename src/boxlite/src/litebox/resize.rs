//! Online root-disk allocation and recovery.

use boxlite_shared::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

use super::BoxResources;
const ONLINE_GROW_MAX_GB: u64 = 1024;

/// Absolute targets. An omitted disk size queries the current allocation.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResizeOptions {
    /// Root disk capacity in binary GiB, from 1 through 1024; growth only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_size_gb: Option<u64>,
}

impl ResizeOptions {
    pub(crate) fn validate(&self) -> BoxliteResult<()> {
        if let Some(size) = self.disk_size_gb
            && !(1..=ONLINE_GROW_MAX_GB).contains(&size)
        {
            return Err(BoxliteError::InvalidArgument(format!(
                "disk_size_gb must be between 1 and {ONLINE_GROW_MAX_GB}, got {size}"
            )));
        }
        Ok(())
    }

    #[cfg(any(
        test,
        all(feature = "native", target_os = "linux", target_arch = "x86_64")
    ))]
    fn target(self, current: BoxResources) -> BoxliteResult<BoxResources> {
        self.validate()?;
        let disk_size_gb = self.disk_size_gb.unwrap_or(current.disk_size_gb);
        if disk_size_gb < current.disk_size_gb {
            return Err(BoxliteError::InvalidArgument(format!(
                "cannot shrink disk from {} GiB to {disk_size_gb} GiB",
                current.disk_size_gb
            )));
        }
        Ok(BoxResources { disk_size_gb })
    }
}

impl super::box_impl::BoxImpl {
    pub(crate) async fn resize(&self, options: ResizeOptions) -> BoxliteResult<BoxResources> {
        #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
        {
            self.resize_native(options).await
        }
        #[cfg(not(all(feature = "native", target_os = "linux", target_arch = "x86_64")))]
        {
            let _ = options;
            Err(BoxliteError::Unsupported(
                "online disk resize requires the native Linux VMM".into(),
            ))
        }
    }

    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    async fn resize_native(&self, options: ResizeOptions) -> BoxliteResult<BoxResources> {
        if self.config.engine_kind != crate::vmm::VmmKind::Native {
            return Err(BoxliteError::Unsupported(
                "online disk resize requires the native VMM".into(),
            ));
        }
        self.with_disk_admission(self.with_operation(self.resize_admitted(options)))
            .await
    }

    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    async fn resize_admitted(&self, options: ResizeOptions) -> BoxliteResult<BoxResources> {
        use std::time::Duration;

        let live = self.existing_live_state_locked().await?;
        // The image also recovers a completed request whose reply or DB write was lost.
        let current = BoxResources::from_disk(&self.layout.disk_path())?;
        let target = options.target(current)?;
        if self.state.read().resources != Some(current) {
            self.record_allocation(current)?;
        }
        if options.disk_size_gb.is_none() {
            return Ok(current);
        }
        let bytes = target.disk_size_gb * (1 << 30);
        let grow =
            crate::vmm::vmm_socket::grow_disk(&self.layout.sockets().vmm_sock(), "vda", bytes)
                .await;
        let observed = BoxResources::from_disk(&self.layout.disk_path()).map_err(|error| {
            BoxliteError::Storage(format!(
                "disk resize may have completed; cannot read allocation: {error}; retry the target"
            ))
        })?;
        self.record_allocation(observed)?;
        grow.map_err(|error| {
            if observed.disk_size_gb >= target.disk_size_gb {
                partial_resize_error(observed, "device control", error)
            } else {
                error
            }
        })?;

        // An equal target still retries the filesystem step after partial completion.
        let filesystem = tokio::time::timeout(Duration::from_secs(60), async {
            live.guest_session
                .guest()
                .await?
                .resize_filesystem(bytes)
                .await
        })
        .await
        .unwrap_or_else(|_| {
            Err(BoxliteError::Engine(
                "guest filesystem resize timed out".into(),
            ))
        });
        filesystem.map_err(|error| partial_resize_error(observed, "filesystem grow", error))?;
        Ok(observed)
    }

    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    fn record_allocation(&self, resources: BoxResources) -> BoxliteResult<()> {
        self.runtime.box_manager.save_resources(&self.config.id, &resources).map_err(|error| {
            BoxliteError::Database(format!(
                "observed {} GiB disk allocation could not be persisted: {error}; retry the target",
                resources.disk_size_gb
            ))
        })?;
        self.state.write().resources = Some(resources);
        Ok(())
    }
}

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
fn partial_resize_error(resources: BoxResources, step: &str, error: BoxliteError) -> BoxliteError {
    let message = format!(
        "disk resize partially completed: {} GiB allocated, {step} failed: {error}; retry the target",
        resources.disk_size_gb
    );
    match error {
        BoxliteError::Unsupported(_) => BoxliteError::Unsupported(message),
        BoxliteError::InvalidArgument(_) => BoxliteError::InvalidArgument(message),
        _ => BoxliteError::Engine(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_effective_options_follow_the_observed_image() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("disk.qcow2");
        let _disk = crate::disk::Qcow2Helper::create_disk(&path, true).unwrap();
        let observed = BoxResources::from_disk(&path).unwrap();
        let mut options = crate::BoxOptions {
            disk_size_gb: Some(1),
            ..Default::default()
        };
        options.advanced.security.resource_limits.max_file_size = Some(1234);
        observed.apply_to(&mut options);
        assert_eq!(options.disk_size_gb, Some(observed.disk_size_gb));
        assert_eq!(
            options.advanced.security.resource_limits.max_file_size,
            Some(1234)
        );
        assert_eq!(
            observed.disk_size_gb,
            crate::disk::constants::qcow2::DEFAULT_DISK_SIZE_GB
        );
    }

    #[test]
    fn resize_disk_targets_and_wire_contract() {
        let current = BoxResources { disk_size_gb: 10 };
        assert_eq!(ResizeOptions::default().target(current).unwrap(), current);
        assert_eq!(
            serde_json::to_value(ResizeOptions::default()).unwrap(),
            serde_json::json!({})
        );
        for size in [10, 20, 1024] {
            let options: ResizeOptions =
                serde_json::from_value(serde_json::json!({"disk_size_gb": size})).unwrap();
            assert_eq!(options.target(current).unwrap().disk_size_gb, size);
        }
        for size in [0, 1, 9, 1025, u64::MAX] {
            assert!(
                ResizeOptions {
                    disk_size_gb: Some(size)
                }
                .target(current)
                .is_err()
            );
        }
        assert_eq!(
            ResizeOptions {
                disk_size_gb: Some(1)
            }
            .target(BoxResources { disk_size_gb: 1 })
            .unwrap()
            .disk_size_gb,
            1
        );
        for body in [
            r#"{"disk_size_gb":-1}"#,
            r#"{"disk_size_gb":1.5}"#,
            r#"{"cpus":2}"#,
        ] {
            assert!(serde_json::from_str::<ResizeOptions>(body).is_err());
        }
    }
}
