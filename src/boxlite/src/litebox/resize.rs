//! Online root-disk allocation and recovery.

use boxlite_shared::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

use super::BoxResources;
const ONLINE_GROW_MAX_GB: u64 = 1024;

/// Absolute targets. An empty request queries the current allocation.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResizeOptions {
    /// Root disk capacity in binary GiB, from 1 through 1024; growth only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_size_gb: Option<u64>,
    /// Total nominal VM memory in MiB. Requires a configured memory ceiling.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mib: Option<u32>,
}

impl ResizeOptions {
    pub(crate) fn validate(&self) -> BoxliteResult<()> {
        if self.disk_size_gb.is_some() && self.memory_mib.is_some() {
            return Err(BoxliteError::InvalidArgument(
                "a resize request must contain at most one resource target".into(),
            ));
        }
        if let Some(size) = self.disk_size_gb
            && !(1..=ONLINE_GROW_MAX_GB).contains(&size)
        {
            return Err(BoxliteError::InvalidArgument(format!(
                "disk_size_gb must be between 1 and {ONLINE_GROW_MAX_GB}, got {size}"
            )));
        }
        Ok(())
    }

    #[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
    fn target(self, current: BoxResources) -> BoxliteResult<BoxResources> {
        self.validate()?;
        let disk_size_gb = self.disk_size_gb.unwrap_or(current.disk_size_gb);
        if disk_size_gb < current.disk_size_gb {
            return Err(BoxliteError::InvalidArgument(format!(
                "cannot shrink disk from {} GiB to {disk_size_gb} GiB",
                current.disk_size_gb
            )));
        }
        Ok(BoxResources {
            disk_size_gb,
            memory: None,
        })
    }
}

impl super::box_impl::BoxImpl {
    pub(crate) async fn resize(&self, options: ResizeOptions) -> BoxliteResult<BoxResources> {
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            self.resize_native(options).await
        }
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        {
            let _ = options;
            Err(BoxliteError::Unsupported(
                "online resize requires the native Linux VMM".into(),
            ))
        }
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    async fn resize_native(&self, options: ResizeOptions) -> BoxliteResult<BoxResources> {
        if self.config.engine_kind != crate::vmm::VmmKind::Native {
            return Err(BoxliteError::Unsupported(
                "online resize requires the native VMM".into(),
            ));
        }
        self.with_disk_admission(self.with_operation(self.resize_admitted(options)))
            .await
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    async fn resize_admitted(&self, options: ResizeOptions) -> BoxliteResult<BoxResources> {
        use std::time::Duration;

        let live = self.existing_live_state_locked().await?;
        let mut current = BoxResources::from_disk(&self.layout.disk_path())?;
        if options.disk_size_gb.is_none() {
            current.memory = self
                .resize_memory(&live.guest_session, options.memory_mib)
                .await?;
            return Ok(current);
        }
        let target = options.target(current)?;
        let bytes = target.disk_size_gb * (1 << 30);

        // An equal target repeats device confirmation and completes pending steps.
        crate::vmm::vmm_socket::grow_disk(&self.layout.sockets().vmm_sock(), "vda", bytes).await?;

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
        filesystem.map_err(|error| partial_resize_error(target, error))?;

        self.runtime
            .box_manager
            .save_disk_size(&self.config.id, target.disk_size_gb)
            .map_err(|error| {
                BoxliteError::Database(format!(
                    "disk resize partially completed: {} GiB allocated and filesystem expanded, state persistence failed: {error}; retry the target",
                    target.disk_size_gb
                ))
            })?;
        Ok(target)
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn partial_resize_error(resources: BoxResources, error: BoxliteError) -> BoxliteError {
    let message = format!(
        "disk resize partially completed: {} GiB allocated, filesystem grow failed: {error}; retry the target",
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
    fn resize_disk_targets_and_wire_contract() {
        let current = BoxResources {
            disk_size_gb: 10,
            memory: None,
        };
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
                    disk_size_gb: Some(size),
                    ..ResizeOptions::default()
                }
                .target(current)
                .is_err()
            );
        }
        assert_eq!(
            ResizeOptions {
                disk_size_gb: Some(1),
                ..ResizeOptions::default()
            }
            .target(BoxResources {
                disk_size_gb: 1,
                memory: None
            })
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
