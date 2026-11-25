//! Online memory targets and durable reconciliation for a native Box.

use std::path::{Path, PathBuf};
use std::time::Duration;

use boxlite_shared::{BoxliteError, BoxliteResult};

use super::BoxManager;
use super::box_impl::BoxImpl;
use super::config::BoxConfig;
use super::state::{BoxMemoryResources, MemoryResizeState};
use crate::portal::GuestSession;
use crate::runtime::constants::vm_defaults::DEFAULT_MEMORY_MIB;
use crate::runtime::layout::BoxFilesystemLayout;
use crate::util::{PidFileReader, PidRecord};
use crate::vmm::vmm_socket::{ControlReply, memory_control};

const MIB: u64 = 1 << 20;
const RESIZE_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

struct MemoryResize<'a> {
    manager: &'a BoxManager,
    config: &'a BoxConfig,
    socket: PathBuf,
    guest: &'a GuestSession,
    boot_mib: u32,
    ceiling_mib: u32,
}

impl<'a> MemoryResize<'a> {
    fn new(
        manager: &'a BoxManager,
        config: &'a BoxConfig,
        layout: &BoxFilesystemLayout,
        guest: &'a GuestSession,
    ) -> Option<Self> {
        Some(Self {
            manager,
            config,
            socket: layout.sockets().vmm_sock(),
            guest,
            boot_mib: config.options.memory_mib.unwrap_or(DEFAULT_MEMORY_MIB),
            ceiling_mib: config.options.max_memory_mib?,
        })
    }

    fn added_mib(&self, target: u32) -> BoxliteResult<u32> {
        target
            .checked_sub(self.boot_mib)
            .filter(|added| target <= self.ceiling_mib && added.is_multiple_of(128))
            .ok_or_else(|| {
                BoxliteError::InvalidArgument(format!(
                    "memory target must be between {} and {} MiB in 128 MiB increments from boot RAM",
                    self.boot_mib, self.ceiling_mib
                ))
            })
    }

    async fn observe(&self, state: MemoryResizeState) -> BoxliteResult<BoxMemoryResources> {
        let ControlReply::Memory(vmm) = memory_control(&self.socket, None).await? else {
            return Err(BoxliteError::Engine("unexpected VMM memory status".into()));
        };
        let requested_mib = self
            .boot_mib
            .checked_add(vmm.requested_mib)
            .filter(|&total| total <= self.ceiling_mib)
            .ok_or_else(|| BoxliteError::Engine("invalid VMM memory target".into()))?;
        Ok(BoxMemoryResources {
            requested_mib,
            plugged_hotplug_mib: vmm.plugged_mib,
            mapped_hotplug_mib: vmm.mapped_mib,
            retained_empty_mib: vmm.retained_empty_mib,
            guest_managed_bytes: self
                .guest
                .guest()
                .await?
                .managed_memory_bytes(false)
                .await?,
            workload_limit_mib: self.ceiling_mib,
            completed_mib: state.completed_mib,
            pending_mib: state.pending_mib,
        })
    }

    fn save(&self, state: MemoryResizeState) -> BoxliteResult<()> {
        self.manager.save_memory_resize(&self.config.id, state)
    }

    fn complete(
        &self,
        state: &mut MemoryResizeState,
        target_mib: u32,
        observed: &mut BoxMemoryResources,
    ) -> BoxliteResult<bool> {
        if !converged(
            *observed,
            target_mib,
            self.added_mib(target_mib)?,
            state.baseline_bytes,
        ) {
            return Ok(false);
        }
        let completed = MemoryResizeState {
            completed_mib: target_mib,
            pending_mib: None,
            ..*state
        };
        self.save(completed).map_err(|error| {
            BoxliteError::Database(format!(
                "memory converged to {target_mib} MiB but completion could not be saved: {error}; retry the same target"
            ))
        })?;
        *state = completed;
        observed.completed_mib = target_mib;
        observed.pending_mib = None;
        Ok(true)
    }

    async fn apply(
        &self,
        mut state: MemoryResizeState,
        target_mib: u32,
    ) -> BoxliteResult<BoxMemoryResources> {
        let added = self.added_mib(target_mib)?;
        let mut observed = self.observe(state).await?;
        if let Some(pending) = state.pending_mib
            && pending != target_mib
            && !self.complete(&mut state, pending, &mut observed)?
        {
            return Err(BoxliteError::InvalidState(format!(
                "memory resize to {pending} MiB remains pending; retry that target or stop the Box"
            )));
        }
        state.pending_mib = Some(target_mib);
        self.save(state)?;
        // A status read is ordered after earlier commands on the shim and VMM queues.
        // Reissue only if the requested target is absent after that read.
        if observed.requested_mib != target_mib {
            let reply = memory_control(&self.socket, Some(added)).await?;
            if reply != ControlReply::MemoryTargetPublished {
                return Err(BoxliteError::Engine(
                    "unexpected VMM memory resize reply".into(),
                ));
            }
            observed = self.observe(state).await?;
        }
        while !self.complete(&mut state, target_mib, &mut observed)? {
            tokio::time::sleep(POLL_INTERVAL).await;
            observed = self.observe(state).await?;
        }
        Ok(observed)
    }
}

fn converged(
    observed: BoxMemoryResources,
    target_mib: u32,
    added_mib: u32,
    baseline_bytes: u64,
) -> bool {
    observed.requested_mib == target_mib
        && observed.plugged_hotplug_mib == added_mib
        && observed.retained_empty_mib == 0
        && observed.guest_managed_bytes.checked_sub(baseline_bytes)
            == Some(u64::from(added_mib) * MIB)
}

fn verified_shim(path: &Path) -> BoxliteResult<PidRecord> {
    PidFileReader::at(path)
        .verified_shim()
        .map(|record| record.identity())
        .ok_or_else(|| {
            BoxliteError::InvalidState("online memory resize requires a verified live shim".into())
        })
}

fn incomplete(target_mib: u32) -> BoxliteError {
    BoxliteError::Engine(format!(
        "memory resize to {target_mib} MiB is incomplete after 60 seconds; query resources or retry the target"
    ))
}

/// Initialize the baseline and restore the last complete target on a fresh boot.
pub(super) async fn restore(
    manager: &BoxManager,
    config: &BoxConfig,
    layout: &BoxFilesystemLayout,
    guest: &GuestSession,
) -> BoxliteResult<()> {
    let Some(resize) = MemoryResize::new(manager, config, layout, guest) else {
        return Ok(());
    };
    let window_mib = config.options.hotplug_mib()?.expect("opted-in Box");
    let shim = verified_shim(&layout.pid_file_path())?;
    let old = manager.memory_resize(&config.id)?;
    let completed_mib = old.map_or(resize.boot_mib, |state| state.completed_mib);
    tokio::time::timeout(RESIZE_TIMEOUT, async {
        super::memory_budget::check(&resize.socket, u64::from(window_mib) * MIB).await?;
        let baseline_bytes = guest.guest().await?.managed_memory_bytes(true).await?;
        let state = MemoryResizeState {
            shim,
            completed_mib,
            baseline_bytes,
            pending_mib: None,
        };
        // Check the shim and device even when there is no completed resize to restore.
        let observed = resize.observe(state).await?;
        if !converged(observed, resize.boot_mib, 0, baseline_bytes) {
            return Err(BoxliteError::Engine(
                "hotplug window is not empty on fresh boot".into(),
            ));
        }
        resize.save(state)?;
        if completed_mib != resize.boot_mib {
            resize.apply(state, completed_mib).await?;
        }
        Ok(())
    })
    .await
    .map_err(|_| incomplete(completed_mib))?
}

impl BoxImpl {
    pub(super) async fn resize_memory(
        &self,
        guest: &GuestSession,
        target: Option<u32>,
    ) -> BoxliteResult<Option<BoxMemoryResources>> {
        let Some(resize) =
            MemoryResize::new(&self.runtime.box_manager, &self.config, &self.layout, guest)
        else {
            return if target.is_some() {
                Err(BoxliteError::InvalidArgument(
                    "online memory resize requires max_memory_mib".into(),
                ))
            } else {
                Ok(None)
            };
        };
        if let Some(target) = target {
            resize.added_mib(target)?;
        }
        let shim = verified_shim(&self.layout.pid_file_path())?;
        let state = self
            .runtime
            .box_manager
            .memory_resize(&self.config.id)?
            .filter(|state| state.shim == shim)
            .ok_or_else(|| {
                BoxliteError::InvalidState(
                    "missing memory baseline for the live shim; restart the Box".into(),
                )
            })?;
        let result = match target {
            Some(target) => tokio::time::timeout(RESIZE_TIMEOUT, resize.apply(state, target))
                .await
                .map_err(|_| incomplete(target))?,
            None => tokio::time::timeout(RESIZE_TIMEOUT, resize.observe(state))
                .await
                .map_err(|_| BoxliteError::Engine("memory status query timed out".into()))?,
        };
        result.map(Some)
    }
}
