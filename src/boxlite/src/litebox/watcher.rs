//! Observe a VM run and report exit/health events to the BoxImpl facade.
//!
//! Monitoring and guest probes do not hold lifecycle locks. The facade owns
//! admission, run identity checks, state persistence, and exit cleanup.

use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use boxlite_shared::errors::BoxliteError;

use super::box_impl::{BoxEvent, BoxImpl, BoxRun};
use crate::portal::interfaces::GuestInterface;
use crate::runtime::rt_impl::RuntimeImpl;
use crate::{BoxID, HealthCheckOptions, HealthState};

#[cfg(test)]
#[path = "watcher/tests/operation_lock.rs"]
mod operation_lock_tests;

/// The optional health-probing half of a [`BoxWatcher`].
///
/// Installed only by a *fresh boot* (start or restart) with a HEALTHCHECK: that
/// path has the live guest and arms the watcher itself, under the state lock, so
/// its probe cannot be raced away. An *adopted* box — recovered already Running —
/// is armed exit-only by the handout that first observed it and never carries a
/// probe (adopted boxes are exit-only by design). Owns the ping and its timing /
/// threshold config; state writes are reported through the BoxImpl operation gate.
pub(crate) struct HealthProbe {
    guest: GuestInterface,
    interval: Duration,
    check_timeout: Duration,
    retries: u32,
    start_period: Duration,
    started_at: Instant,
}

/// Outcome of a single probe.
enum Probe {
    /// Still inside `start_period` — not counted either way.
    Skipped,
    Healthy,
    Failed,
}

impl HealthProbe {
    pub(crate) fn new(guest: GuestInterface, config: HealthCheckOptions) -> Self {
        Self {
            guest,
            interval: config.interval,
            check_timeout: config.timeout,
            retries: config.retries,
            start_period: config.start_period,
            started_at: Instant::now(),
        }
    }

    /// Ping the guest once (after `start_period`). The shim is known alive — the
    /// watcher's `select!` would have taken the exit arm otherwise — so a failure
    /// here is a genuine health failure, not a dead box.
    async fn check(&mut self) -> Probe {
        if self.started_at.elapsed() < self.start_period {
            return Probe::Skipped;
        }
        match timeout(self.check_timeout, self.guest.ping()).await {
            Ok(Ok(_)) => Probe::Healthy,
            Ok(Err(_)) | Err(_) => Probe::Failed,
        }
    }
}

/// A single task that observes one box's process for its whole life.
pub(crate) struct BoxWatcher {
    shim_pid: u32,
    started_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Weak, and load-bearing. The task parks on the shim for the box's life, and
    /// `RuntimeImpl::Drop` runs `shutdown_sync` to kill shims. A strong `Arc`
    /// would deadlock the two — Drop cannot run until the task lets go, and the
    /// task does not let go until the shim dies, which is Drop's job — leaking
    /// VMs. Both arms upgrade it when they need to persist.
    runtime: Weak<RuntimeImpl>,
    shutdown: CancellationToken,
    box_id: BoxID,
    /// `None` ⇒ exit-only watcher. `Some` ⇒ also probe the guest's health.
    health: Option<HealthProbe>,
}

impl BoxWatcher {
    /// Build a watcher for `box`'s shim. `health` is `Some` only when the box has
    /// a HEALTHCHECK and a reachable guest (the caller supplies the probe).
    pub(crate) fn new(
        bx: &BoxImpl,
        shim_pid: u32,
        started_at: Option<chrono::DateTime<chrono::Utc>>,
        health: Option<HealthProbe>,
    ) -> Self {
        Self {
            shim_pid,
            started_at,
            runtime: Arc::downgrade(&bx.runtime),
            shutdown: bx.shutdown_token.child_token(),
            box_id: bx.config.id.clone(),
            health,
        }
    }

    /// Spawn the watcher onto the current tokio runtime. Must be called from a
    /// tokio context.
    pub(crate) fn spawn(self) -> JoinHandle<()> {
        tokio::spawn(self.run())
    }

    async fn run(mut self) {
        let shim = crate::util::ProcessMonitor::new(self.shim_pid);
        // Cloned so the nested probe select can watch shim-exit/cancellation with
        // locals while `on_health_tick` borrows `self` mutably.
        let shutdown = self.shutdown.clone();
        // Copied out so the sleep future borrows nothing of `self`. Cleared once
        // the box is unhealthy: stop *probing*, but keep watching for exit.
        let mut interval = self.health.as_ref().map(|h| h.interval);

        loop {
            tokio::select! {
                // stop() / runtime shutdown cancel the token *and* kill the shim
                // themselves; that path owns and persists the transition, so stand
                // down rather than race it to the same fields.
                _ = shutdown.cancelled() => return,
                _ = shim.wait_for_exit() => {
                    self.on_shim_exit().await;
                    return;
                }
                // Disabled (never fires) when there is no probe, degenerating to a
                // pure exit watcher.
                _ = tick(interval) => {
                    // Keep shim-exit and cancellation live *while* probing: a shim
                    // that dies mid-probe must still be recorded, not mistaken for a
                    // health failure and left Running forever.
                    tokio::select! {
                        _ = shutdown.cancelled() => return,
                        _ = shim.wait_for_exit() => {
                            self.on_shim_exit().await;
                            return;
                        }
                        flow = self.on_health_tick() => {
                            // Unhealthy: stop probing, keep observing the shim.
                            if flow.is_break() {
                                interval = None;
                            }
                        }
                    }
                }
            }
        }
    }

    /// Report process exit; BoxImpl owns state changes and configured cleanup.
    async fn on_shim_exit(&mut self) {
        if self.shutdown.is_cancelled() {
            return;
        }
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        if let Err(error) = runtime
            .observe_box(
                &self.box_id,
                self.observed_run(),
                BoxEvent::Exited {
                    health_checked: self.health.is_some(),
                },
            )
            .await
            && !matches!(error, BoxliteError::NotFound(_) | BoxliteError::Stopped(_))
        {
            tracing::warn!(box_id = %self.box_id, %error, "Failed to report box exit");
        }
    }

    async fn on_health_tick(&mut self) -> std::ops::ControlFlow<()> {
        use std::ops::ControlFlow::{Break, Continue};
        let Some(probe) = self.health.as_mut() else {
            return Continue(());
        };
        let outcome = probe.check().await;
        let healthy = match outcome {
            Probe::Skipped => return Continue(()),
            Probe::Healthy => true,
            Probe::Failed => false,
        };
        let retries = probe.retries;
        if self.shutdown.is_cancelled() {
            return Break(());
        }
        let Some(runtime) = self.runtime.upgrade() else {
            return Break(());
        };
        match runtime
            .observe_box(
                &self.box_id,
                self.observed_run(),
                BoxEvent::Health { healthy, retries },
            )
            .await
        {
            Ok(Some(status)) => {
                if status.state == HealthState::Unhealthy {
                    Break(())
                } else {
                    Continue(())
                }
            }
            Ok(None) => Break(()),
            Err(error) => {
                tracing::warn!(box_id = %self.box_id, %error, "Failed to report box health");
                Continue(())
            }
        }
    }

    fn observed_run(&self) -> BoxRun {
        BoxRun {
            pid: self.shim_pid,
            started_at: self.started_at,
        }
    }
}

/// The health arm's future: sleep one interval, or — with no probe — never fire.
async fn tick(interval: Option<Duration>) {
    match interval {
        Some(interval) => tokio::time::sleep(interval).await,
        None => std::future::pending().await,
    }
}
