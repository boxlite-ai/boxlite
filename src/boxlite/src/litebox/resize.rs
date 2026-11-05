//! Online resource allocation and persistence.

use serde::{Deserialize, Serialize};

use super::BoxResources;
#[cfg(any(target_os = "linux", test))]
use crate::runtime::cpu_count::CpuCount;
use boxlite_shared::{BoxliteError, BoxliteResult};

/// Absolute resource targets. Omitted fields retain the current allocation.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResizeOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpus: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mib: Option<u32>,
}

#[cfg(any(target_os = "linux", test))]
impl ResizeOptions {
    fn target(self, current: BoxResources) -> BoxliteResult<BoxResources> {
        let cpus = self.cpus.map_or(current.cpus, f64::from);
        CpuCount::new(cpus)?;
        let memory_mib = self.memory_mib.unwrap_or(current.memory_mib);
        if cpus < current.cpus || cpus > f64::from(current.max_cpus) {
            return Err(BoxliteError::InvalidArgument(format!(
                "cpus must be between {} and {} for this boot, got {cpus}",
                current.cpus, current.max_cpus
            )));
        }
        if memory_mib < current.memory_mib || memory_mib > current.max_memory_mib {
            return Err(BoxliteError::InvalidArgument(format!(
                "memory_mib must be between {} and {} for this boot, got {memory_mib}",
                current.memory_mib, current.max_memory_mib
            )));
        }
        if !(memory_mib - current.memory_mib).is_multiple_of(128) {
            return Err(BoxliteError::InvalidArgument(
                "memory growth must be a multiple of 128 MiB".into(),
            ));
        }
        Ok(BoxResources {
            cpus,
            memory_mib,
            ..current
        })
    }
}

impl super::box_impl::BoxImpl {
    pub(crate) async fn resize(&self, options: ResizeOptions) -> BoxliteResult<BoxResources> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = options;
            Err(BoxliteError::Unsupported(
                "online resize requires Linux/KVM".into(),
            ))
        }
        #[cfg(target_os = "linux")]
        {
            self.resize_linux(options).await
        }
    }

    #[cfg(target_os = "linux")]
    async fn resize_linux(&self, options: ResizeOptions) -> BoxliteResult<BoxResources> {
        use super::BoxStatus;
        use crate::lock::LockGuard;
        use std::time::Duration;

        let _update = self.configuration_updates.lock().await;
        if self.shutdown_token.is_cancelled() || self.state.read().status != BoxStatus::Running {
            return Err(BoxliteError::InvalidState(
                "resize requires a running box".into(),
            ));
        }
        // Attach before taking the lifecycle lock: recovery uses that lock too.
        let live = self.live_state().await?;
        let lock_id = self
            .state
            .read()
            .lock_id
            .ok_or_else(|| BoxliteError::Internal("running box has no lock".into()))?;
        let locker = self.runtime.lock_manager.retrieve(lock_id)?;
        let _guard = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(guard) = LockGuard::try_new(&*locker) {
                    return guard;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| BoxliteError::InvalidState("timed out waiting to resize box".into()))?;
        let persisted = self.runtime.box_manager.update_box(&self.config.id)?;
        if persisted.status != BoxStatus::Running || self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::InvalidState(
                "resize requires a running box".into(),
            ));
        }
        let mut current = persisted.resources.ok_or_else(|| {
            BoxliteError::Unsupported("restart this box before resizing it".into())
        })?;
        let memory_socket = self.layout.sockets().memory_sock();
        let mut memory_pending = false;
        if memory_socket.exists() {
            // A previously submitted request can finish after a client disconnect.
            let observed = crate::vmm::memory_control::request(&memory_socket, 0).await?;
            if observed.request_error != 0
                || observed.mapped_mib > observed.max_mib
                || observed.max_mib < current.memory_mib
            {
                return Err(BoxliteError::Engine(
                    "shim memory allocation is inconsistent".into(),
                ));
            }
            memory_pending = observed.plugged_mib < observed.requested_mib;
            let observed_max = if observed.active {
                observed.max_mib
            } else {
                current.max_memory_mib
            };
            if observed.mapped_mib > current.memory_mib || observed_max != current.max_memory_mib {
                current.memory_mib = current.memory_mib.max(observed.mapped_mib);
                current.max_memory_mib = observed_max;
                self.runtime
                    .box_manager
                    .save_resources(&self.config.id, &current)?;
                self.state.write().resources = Some(current);
            }
        }
        let mut target = options.target(current)?;
        let wait_for_memory = options.memory_mib.is_some() && memory_pending;
        if target == current && !wait_for_memory {
            return Ok(current);
        }
        let limits = &self.config.options.advanced.security.resource_limits;
        let cap = |cpus| {
            crate::jailer::cgroup::set_cpu_max(
                self.config.id.as_str(),
                CpuCount::new(cpus)?,
                limits,
            )
            .map_err(|error| BoxliteError::Engine(format!("resize CPU quota: {error}")))
        };
        let requested = target;
        let mut failures = Vec::new();
        if target.cpus != current.cpus {
            let current_vcpus = u32::from(CpuCount::new(current.cpus)?.vcpus());
            let target_vcpus = CpuCount::new(target.cpus)?.vcpus();
            cap(target.cpus)?;
            let response = tokio::time::timeout(Duration::from_secs(10), async {
                live.guest_session
                    .guest()
                    .await?
                    .online_cpus(target_vcpus)
                    .await
            })
            .await
            .unwrap_or_else(|_| Err(BoxliteError::Engine("guest CPU resize timed out".into())));
            let response = match response {
                Ok(response)
                    if (current_vcpus..=u32::from(target_vcpus)).contains(&response.online) =>
                {
                    response
                }
                result => {
                    cap(current.cpus)?;
                    return match result {
                        Err(error) => Err(error),
                        Ok(response) => Err(BoxliteError::Engine(format!(
                            "guest reported {} online CPUs outside the allocated range; CPU quota restored",
                            response.online
                        ))),
                    };
                }
            };
            target.cpus = f64::from(response.online).min(requested.cpus);
            cap(target.cpus)?;
            if !response.error.is_empty() || target.cpus != requested.cpus {
                failures.push(format!(
                    "CPU: {} allocated, requested {}: {}",
                    target.cpus, requested.cpus, response.error
                ));
            }
        }
        if target.memory_mib != current.memory_mib || wait_for_memory {
            target.memory_mib = current.memory_mib;
            match crate::vmm::memory_control::grow(&memory_socket, requested.memory_mib).await {
                Ok(status) => {
                    if (current.memory_mib..=current.max_memory_mib).contains(&status.mapped_mib) {
                        target.memory_mib = status.mapped_mib;
                    }
                    if status.request_error != 0
                        || status.error != 0
                        || status.plugged_mib != requested.memory_mib
                        || target.memory_mib != requested.memory_mib
                    {
                        failures.push(format!("memory: {} MiB mapped, {} MiB plugged, {} MiB pending; request error {}, device error {}",
                            target.memory_mib, status.plugged_mib, status.requested_mib,
                            status.request_error, status.error));
                    }
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        if let Err(error) = self
            .runtime
            .box_manager
            .save_resources(&self.config.id, &target)
        {
            if target.cpus != current.cpus {
                cap(current.cpus)?;
            }
            return Err(BoxliteError::Database(format!(
                "resize was applied but could not be persisted ({error}); CPU quota restored; retry the target"
            )));
        }
        self.state.write().resources = Some(target);
        if !failures.is_empty() {
            return Err(BoxliteError::Engine(format!(
                "resize partially completed; current allocation is {} CPUs / {} MiB; retry the target: {}",
                target.cpus,
                target.memory_mib,
                failures.join("; ")
            )));
        }
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_retains_fractional_cpus_when_only_memory_changes() {
        for cpus in [0.125, 0.5, 1.5] {
            let current = BoxResources {
                cpus,
                memory_mib: 512,
                max_cpus: 4,
                max_memory_mib: 1024,
            };
            assert_eq!(ResizeOptions::default().target(current).unwrap(), current);
            let target = ResizeOptions {
                cpus: None,
                memory_mib: Some(640),
            }
            .target(current)
            .unwrap();
            assert_eq!((target.cpus, target.memory_mib), (cpus, 640));
            assert_eq!(serde_json::to_value(target).unwrap()["cpus"], cpus);
            let grown = ResizeOptions {
                cpus: Some(2),
                memory_mib: None,
            }
            .target(current)
            .unwrap();
            assert_eq!(grown.cpus, 2.0);
            assert_eq!(serde_json::to_value(grown).unwrap()["cpus"], 2);
            assert!(
                ResizeOptions {
                    cpus: Some(0),
                    memory_mib: None
                }
                .target(current)
                .is_err()
            );
        }
    }

    #[test]
    fn resize_validates_both_targets_before_applying_either() {
        let current = BoxResources {
            cpus: 2.0,
            memory_mib: 512,
            max_cpus: 4,
            max_memory_mib: 1024,
        };
        assert_eq!(ResizeOptions::default().target(current).unwrap(), current);
        for cpus in [0, 1, 5] {
            assert!(
                ResizeOptions {
                    cpus: Some(cpus),
                    ..Default::default()
                }
                .target(current)
                .is_err()
            );
        }
        for memory_mib in [0, 256, 1025] {
            assert!(
                ResizeOptions {
                    cpus: Some(4),
                    memory_mib: Some(memory_mib)
                }
                .target(current)
                .is_err()
            );
        }
        assert_eq!(
            ResizeOptions {
                cpus: Some(4),
                memory_mib: Some(1024)
            }
            .target(current)
            .unwrap()
            .cpus,
            4.0
        );
    }
}
