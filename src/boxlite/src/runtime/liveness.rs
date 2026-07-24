use crate::litebox::config::BoxConfig;
use crate::runtime::types::{BoxInfo, BoxState, BoxStatus};
use crate::util::{PidFileReader, ProcessIdentity};

/// Read-only runtime presence evidence captured for an inventory operation.
///
/// The probe never mutates SQLite or sends a signal. That keeps inventory from
/// racing lifecycle writes while ensuring only a proven live runtime is
/// projected as active to callers such as the billing lease heartbeat.
pub(crate) struct RuntimeLivenessProbe {
    #[cfg(target_os = "linux")]
    processes: Option<crate::util::process::ProcessTreeSnapshot>,
    #[cfg(target_os = "linux")]
    original_shim: Option<std::path::PathBuf>,
}

impl RuntimeLivenessProbe {
    pub(crate) fn capture() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            processes: crate::util::process::ProcessTreeSnapshot::capture(),
            #[cfg(target_os = "linux")]
            original_shim: crate::util::find_binary("boxlite-shim").ok(),
        }
    }

    pub(crate) fn project(&self, config: &BoxConfig, state: &BoxState) -> BoxInfo {
        let mut info = BoxInfo::new(config, state);
        if !state.status.is_active() {
            return info;
        }

        let identity = PidFileReader::at(config.box_home.join("shim.pid")).process_identity();
        let runtime_is_present = match identity {
            ProcessIdentity::Verified(launcher_pid) => {
                self.has_runtime_process(config, launcher_pid)
            }
            // A legacy one-line PID file cannot exclude PID reuse and therefore
            // is not strong enough evidence for a new compute-billing lease.
            ProcessIdentity::Legacy(_) | ProcessIdentity::Absent => false,
        };

        if runtime_is_present {
            if let ProcessIdentity::Verified(pid) = identity {
                info.pid = Some(pid);
            }
        } else {
            info.status = BoxStatus::Unknown;
            info.pid = None;
        }
        info
    }

    fn has_runtime_process(&self, config: &BoxConfig, launcher_pid: u32) -> bool {
        #[cfg(target_os = "linux")]
        {
            if config.options.advanced.security.jailer_enabled {
                let copied_shim = config.box_home.join("bin").join("boxlite-shim");
                let mut candidates = vec![copied_shim.clone()];
                if let Some(original_shim) = &self.original_shim
                    && original_shim != &copied_shim
                {
                    // Jailer deliberately falls back to the original binary if
                    // the per-box copy fails. Accept either actual executable,
                    // but still require exactly one match in this launcher's tree.
                    candidates.push(original_shim.clone());
                }
                return self.processes.as_ref().is_some_and(|processes| {
                    processes.has_unique_runtime_executable(launcher_pid, &candidates)
                });
            }
        }

        let _ = (config, launcher_pid);
        true
    }
}
