//! One watcher per box, owning all lifecycle observation.
//!
//! [`BoxWatcher`] always follows the box's shim to its exit — recording
//! `Stopped` and the exit code — and, when a HEALTHCHECK is configured and the
//! guest is reachable, also probes the guest on an interval. It is the single
//! successor to the former split exit-watcher + health-check tasks: a plain box
//! gets an exit-only watcher (`health == None`), a health-checked box gets both
//! from one `select!` loop.
//!
//! Folding the two together also deletes the whole "did the shim die?" branch
//! the health check used to carry: a health tick can only fire while the shim is
//! alive, or `wait_for_exit` would have won the `select!`. So a failed probe is
//! unambiguously a *health* failure — never a dead box — and the exit arm is the
//! single writer of `status` / `exit_code` / `pid`.

use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use boxlite_shared::errors::BoxliteError;

use super::box_impl::BoxImpl;
use super::state::{BoxState, HealthStatus};
use crate::portal::interfaces::GuestInterface;
use crate::runtime::rt_impl::RuntimeImpl;
use crate::{BoxID, HealthCheckOptions, HealthState};

/// The optional health-probing half of a [`BoxWatcher`].
///
/// Installed only by a *fresh boot* (start or restart) with a HEALTHCHECK: that
/// path has the live guest and arms the watcher itself, under the state lock, so
/// its probe cannot be raced away. An *adopted* box — recovered already Running —
/// is armed exit-only by the handout that first observed it and never carries a
/// probe (adopted boxes are exit-only by design). Owns the ping and its timing /
/// threshold config; the state writes live in [`BoxWatcher`].
pub(crate) struct HealthProbe {
    guest: GuestInterface,
    interval: Duration,
    check_timeout: Duration,
    retries: u32,
    start_period: Duration,
    started_at: Instant,
    /// Cache of the last persisted health status, to skip redundant DB writes.
    last: HealthStatus,
}

/// Outcome of a single probe.
enum Probe {
    /// Still inside `start_period` — not counted either way.
    Skipped,
    Healthy,
    Failed,
}

impl HealthProbe {
    pub(crate) fn new(
        guest: GuestInterface,
        config: HealthCheckOptions,
        last: HealthStatus,
    ) -> Self {
        Self {
            guest,
            interval: config.interval,
            check_timeout: config.timeout,
            retries: config.retries,
            start_period: config.start_period,
            started_at: Instant::now(),
            last,
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
    state: Arc<RwLock<BoxState>>,
    /// Weak, and load-bearing. The task parks on the shim for the box's life, and
    /// `RuntimeImpl::Drop` runs `shutdown_sync` to kill shims. A strong `Arc`
    /// would deadlock the two — Drop cannot run until the task lets go, and the
    /// task does not let go until the shim dies, which is Drop's job — leaking
    /// VMs. Both arms upgrade it when they need to persist.
    runtime: Weak<RuntimeImpl>,
    shutdown: CancellationToken,
    box_id: BoxID,
    box_name: Option<String>,
    exit_file: std::path::PathBuf,
    removes_on_exit: bool,
    /// `None` ⇒ exit-only watcher. `Some` ⇒ also probe the guest's health.
    health: Option<HealthProbe>,
}

impl BoxWatcher {
    /// Build a watcher for `box`'s shim. `health` is `Some` only when the box has
    /// a HEALTHCHECK and a reachable guest (the caller supplies the probe).
    pub(crate) fn new(bx: &BoxImpl, shim_pid: u32, health: Option<HealthProbe>) -> Self {
        Self {
            shim_pid,
            state: Arc::clone(&bx.state),
            runtime: Arc::downgrade(&bx.runtime),
            shutdown: bx.shutdown_token.child_token(),
            box_id: bx.config.id.clone(),
            box_name: bx.config.name.clone(),
            exit_file: bx
                .layout
                .container_exit_file(bx.config.container.id.as_str()),
            removes_on_exit: bx.config.options.removes_on_stop(),
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
                    self.on_shim_exit();
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
                            self.on_shim_exit();
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

    /// The shim exited on its own: record `Stopped` + the exit code, and (for a
    /// health-checked box) flip the last health snapshot to Unhealthy — the whole
    /// job the old exit watcher did, now the single writer of the transition.
    fn on_shim_exit(&mut self) {
        // The runtime is gone, so it has already torn everything down (its Drop
        // runs shutdown_sync) and there is nobody left to report to.
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };

        let stopped = {
            let mut state = self.state.write();

            if state.status.is_active() {
                crate::runtime::rt_impl::record_main_command_exit(&mut state, &self.exit_file);
            } else if state.exit_code.is_none()
                && let Some(record) = boxlite_shared::layout::ExitRecord::read(&self.exit_file)
            {
                // Someone already marked the box Stopped without recording a code
                // — a force stop that raced init's own exit, say — but the guest
                // did write one. Don't fight for the status; just fill in the code
                // they could not know. Delivering that code is the whole point of
                // this watcher, and `recover_boxes` will not backfill it (its
                // branch only fires on a *Running* box).
                state.exit_code = Some(record.exit_code);
            } else {
                // Fully resolved by someone else (a concurrent stop, recovery).
                return;
            }

            // A health-checked box that died is Unhealthy — its last snapshot, not
            // a probe result (we never probe a dead box now).
            if self.health.is_some() {
                state.health_status.state = HealthState::Unhealthy;
            }

            state.clone()
        };

        tracing::info!(
            box_id = %self.box_id,
            exit_code = ?stopped.exit_code,
            "Main command exited; box stopped"
        );

        // NotFound is expected for a remove-on-stop box: the exit raced the
        // cleanup that deleted it, and the box being gone is the desired state.
        match runtime.box_manager.save_box(&self.box_id, &stopped) {
            Ok(()) | Err(BoxliteError::NotFound(_)) => {}
            Err(e) => tracing::warn!(
                box_id = %self.box_id,
                error = %e,
                "Failed to persist the box's exit"
            ),
        }

        // The same tail `stop()` runs, because this is the box's *other* death.
        // Without it a long-lived runtime keeps handing out the spent handle from
        // its cache, and a remove-on-stop box — the default — that ran to
        // completion is never cleaned up, because nobody called stop() to do it.
        runtime.invalidate_box_impl(&self.box_id, self.box_name.as_deref());
        if self.removes_on_exit
            && let Err(e) = runtime.remove_box(&self.box_id, false)
        {
            tracing::warn!(
                box_id = %self.box_id,
                error = %e,
                "Failed to auto-remove the box after its main command exited"
            );
        }
    }

    /// A probe interval elapsed (shim still alive): ping and account for health.
    /// Returns `Break` once the box has gone Unhealthy — stop probing.
    async fn on_health_tick(&mut self) -> std::ops::ControlFlow<()> {
        use std::ops::ControlFlow::{Break, Continue};

        // `check()` borrows the probe across its await; take the outcome and the
        // config we need by value, then work on the box state with no live borrow.
        let outcome = match self.health.as_mut() {
            Some(probe) => probe.check().await,
            None => return Continue(()),
        };
        let (retries, last) = match &self.health {
            Some(probe) => (probe.retries, probe.last),
            None => return Continue(()),
        };

        match outcome {
            Probe::Skipped => Continue(()),
            Probe::Healthy => {
                if last.state != HealthState::Healthy || last.failures != 0 {
                    let snapshot = {
                        let mut state = self.state.write();
                        state.mark_health_check_success();
                        state.clone()
                    };
                    self.persist(&snapshot);
                    if let Some(probe) = self.health.as_mut() {
                        probe.last = snapshot.health_status;
                    }
                }
                Continue(())
            }
            Probe::Failed => {
                tracing::warn!(box_id = %self.box_id, "Health check probe failed");
                let new_failures = last.failures + 1;
                let new_state = if new_failures >= retries {
                    HealthState::Unhealthy
                } else {
                    last.state
                };
                if last.state == new_state && last.failures == new_failures {
                    return Continue(());
                }
                let (snapshot, became_unhealthy) = {
                    let mut state = self.state.write();
                    let became_unhealthy = state.mark_health_check_failure(retries);
                    (state.clone(), became_unhealthy)
                };
                self.persist(&snapshot);
                if let Some(probe) = self.health.as_mut() {
                    probe.last = snapshot.health_status;
                }
                if became_unhealthy {
                    Break(())
                } else {
                    Continue(())
                }
            }
        }
    }

    /// Persist a state snapshot, upgrading the weak runtime. A gone runtime means
    /// teardown is already under way — nothing to save.
    fn persist(&self, snapshot: &BoxState) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        if let Err(e) = runtime.box_manager.save_box(&self.box_id, snapshot) {
            tracing::error!(
                box_id = %self.box_id,
                error = %e,
                "Failed to persist health status to database"
            );
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
