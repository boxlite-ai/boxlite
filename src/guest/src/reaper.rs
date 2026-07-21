//! Single child-reaper for the guest agent's own processes.
//!
//! Replaces per-process blocking `waitpid(pid)` — one OS thread parked per wait,
//! and correctness hostage to how a container init reparents — with one task
//! that drains `waitpid(-1, WNOHANG)` on every `SIGCHLD` and deposits each pid's
//! exit into an `ExitSlot`. The reaper answers no queries: callers claim a slot
//! at spawn and park on it, so there is one place a caller ever waits, and an
//! exit that lands early is simply already there. A claim may also register an
//! `ExitAction` (`on_exit`) — a follow-up the reaper fires exactly once, after
//! the delivery, outside its lock. The container init and exec
//! tenants are cloned `CLONE_PARENT` (youki `as_sibling`) so they are our
//! direct children;
//! the agent also sets `PR_SET_CHILD_SUBREAPER` as a net for any other orphaned
//! descendant. `tokio::signal(SIGCHLD)` is the signalfd/self-pipe, delivered
//! async-signal-safely by the runtime — no hand-rolled pipe.
//!
//! Scope: every process the guest waits on. The container init and exec tenants
//! are both cloned `CLONE_PARENT` (youki `as_sibling`) so they reparent to us,
//! and directly-spawned guest processes are our children already. libcontainer's
//! own intermediate reparents here too and is reaped with nobody waiting — see
//! `Slot::stray_since`, which ages such strays out.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant};

use nix::errno::Errno;
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::{watch, Mutex};
use tracing::{debug, error, warn};

use crate::service::exec::exec_handle::ExitStatus;

/// Installed once in `async_main`, after the tokio runtime exists.
pub(crate) static REAPER: OnceLock<Arc<Reaper>> = OnceLock::new();

pub(crate) struct Reaper {
    inner: Mutex<Inner>,
}

/// Unclaimed strays are dropped after this long. The genuine reaped-before-claim
/// race resolves in well under a second; the TTL only keeps strays from
/// accumulating. It is not what makes pid recycling safe — a fresh spawn landing
/// on a stale slot is caught by the spawn-timestamp check in `register`.
const REAPED_TTL: Duration = Duration::from_secs(60);

/// Serializes our `waitpid(-1)` sweep against callers that wait for their *own*
/// child.
///
/// `std::process::Command::output()` / `Child::wait()` reap the child
/// themselves. Our sweep races them, and when it wins their wait fails with
/// `ECHILD` — 10 of 20 calls on a booted box before this lock existed. The
/// read side is shared, so concurrent self-waiters never serialize with each
/// other, only against the sweep.
static REAP_LOCK: RwLock<()> = RwLock::new(());

/// Hold this across a call that waits for its own child (`Command::output()`,
/// `Child::wait()`) so the reaper cannot reap that child out from under it.
///
/// Keep the guard alive for the whole spawn-and-wait, not just the spawn.
pub(crate) fn reap_fence() -> RwLockReadGuard<'static, ()> {
    REAP_LOCK
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A follow-up the reaper runs when a pid's exit is delivered.
///
/// Fired exactly once, after the registry lock is released — never under it,
/// so an action may call back into the reaper. The reaper only *invokes* it;
/// anything long-running (draining sessions, powering off) must spawn its own
/// task inside the closure.
pub(crate) type ExitAction = Box<dyn FnOnce(ExitStatus) + Send>;

/// A pid's exit, readable by any number of callers any number of times.
///
/// The reaper deposits into it and never reads; holders park on `get`. Backed by
/// a watch channel, so it is *level-triggered*: an exit deposited before anyone
/// asks is still there for the first caller, and stays there for every later
/// one. That is the whole reason this type exists — a oneshot would hand the
/// status to exactly one caller and strand the rest.
#[derive(Clone)]
pub(crate) struct ExitSlot(watch::Receiver<Option<ExitStatus>>);

impl ExitSlot {
    /// The pid's exit status, awaiting it if it has not exited yet.
    pub(crate) async fn get(&self) -> ExitStatus {
        let mut rx = self.0.clone();
        if let Some(status) = *rx.borrow_and_update() {
            return status;
        }
        // Copy the status out while the borrow is alive; holding `wait_for`'s
        // `Ref` across the match would borrow `rx` past the end of this scope.
        match rx.wait_for(Option::is_some).await.map(|slot| *slot) {
            Ok(Some(status)) => status,
            Ok(None) => unreachable!("wait_for returns only once the slot is Some"),
            Err(_) => {
                // Unreachable: a slot is only ever removed after it has been
                // filled — pruned stray, claim replaced by `register`, or slot
                // detached by `deliver` — so the fast path above returned.
                error!("reaper: exit slot dropped while a caller was waiting on it");
                ExitStatus::Code(-1)
            }
        }
    }
}

#[derive(Default)]
struct Inner {
    /// pid → where its exit is deposited. Created by whichever happens first:
    /// `register` when a spawn returns the pid, or `deliver` for an exit we were
    /// not expecting. Holding both cases in one map is what removes the separate
    /// "reaped early" cache the pull API needed.
    slots: HashMap<Pid, Slot>,
}

struct Slot {
    tx: watch::Sender<Option<ExitStatus>>,
    /// When this slot was created by an unexpected exit, i.e. a stray — a
    /// libcontainer intermediate reparents here via `as_sibling` and nobody
    /// waits for it. `None` once a spawn claims the pid; only strays age out.
    stray_since: Option<Instant>,
    /// When an exit was deposited here, whether or not anyone claimed the pid.
    ///
    /// Separate from `stray_since` because it must outlive the claim: a claimed
    /// slot never ages out, so once its execution finishes it sits here holding
    /// a status until the guest exits. Only this timestamp can tell that corpse
    /// apart from a fresh spawn's own exit after the kernel recycles the pid.
    settled_at: Option<Instant>,
    /// Parked by `on_exit`, taken by `deliver` while settling — so a settled
    /// slot never holds an unfired action, and the recycle guards that drop or
    /// detach settled slots can never discard one.
    action: Option<ExitAction>,
}

impl Inner {
    /// Get or create this pid's slot.
    fn slot(&mut self, pid: Pid, stray_since: Option<Instant>) -> &mut Slot {
        self.slots.entry(pid).or_insert_with(|| Slot {
            tx: watch::channel(None).0,
            stray_since,
            settled_at: None,
            action: None,
        })
    }

    /// Drop unclaimed strays past `REAPED_TTL`.
    ///
    /// Claimed slots (`stray_since: None`) are exempt outright — their owner may
    /// ask arbitrarily later, which is what a detached exec does. A slot still
    /// marked stray has no holder by construction: `register` clears the mark
    /// before it hands out a receiver, so pruning one cannot strand a caller.
    fn prune_stale(&mut self) {
        self.slots.retain(|_, slot| match slot.stray_since {
            None => true,
            Some(since) => since.elapsed() < REAPED_TTL,
        });
    }
}

impl Reaper {
    /// Become a child-subreaper and spawn the reap loop. Call once, inside the
    /// tokio runtime, before any container init is created.
    pub(crate) fn install() -> Arc<Reaper> {
        // Subreaper so any orphaned guest-side descendant still lands on us. The
        // container init and exec tenants don't rely on this — they are cloned
        // CLONE_PARENT (as_sibling) as our direct children — but a guest process
        // that double-forks would otherwise escape. Harmless to set always.
        if let Err(e) = nix::sys::prctl::set_child_subreaper(true) {
            warn!(error = %e, "reaper: PR_SET_CHILD_SUBREAPER failed; orphaned descendants will escape to the VM's init");
        }
        let reaper = Arc::new(Reaper {
            inner: Mutex::new(Inner::default()),
        });
        let bg = Arc::clone(&reaper);
        tokio::spawn(async move { bg.run().await });
        reaper
    }

    async fn run(self: Arc<Self>) {
        let mut sigchld = match signal(SignalKind::child()) {
            Ok(s) => s,
            Err(e) => {
                error!(error = %e, "reaper: cannot watch SIGCHLD; child exits will not be reaped");
                return;
            }
        };
        // A child may have exited before the handler was armed.
        self.drain().await;
        while sigchld.recv().await.is_some() {
            self.drain().await;
        }
    }

    /// Reap every child that has exited. `SIGCHLD` coalesces, so one delivery may
    /// stand for several exits.
    ///
    /// Exits are swept under `REAP_LOCK` first and delivered only after the guard
    /// is dropped: `deliver` awaits, and a std lock must never be held across an
    /// await.
    async fn drain(&self) {
        for (pid, status) in Self::sweep_exits() {
            if let Some(action) = self.deliver(pid, status).await {
                // Fired here, after deliver released the registry lock, so a
                // slow or re-entrant action cannot block other deliveries.
                action(status);
            }
        }
    }

    /// Collect every exited child under the reap lock's write side, so we never
    /// steal a child from a caller holding `reap_fence()`.
    ///
    /// Blocks on the lock rather than `try_write`: skipping a sweep could strand
    /// an exit until the next `SIGCHLD`, which may never arrive.
    fn sweep_exits() -> Vec<(Pid, ExitStatus)> {
        let _fence = REAP_LOCK
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut exits = Vec::new();
        loop {
            match waitpid(Pid::from_raw(-1), Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::Exited(pid, code)) => exits.push((pid, ExitStatus::Code(code))),
                Ok(WaitStatus::Signaled(pid, sig, _)) => exits.push((pid, ExitStatus::Signal(sig))),
                // WNOHANG with a live-but-unexited child, or no children left.
                Ok(WaitStatus::StillAlive) | Err(Errno::ECHILD) => break,
                Err(Errno::EINTR) => continue,
                // Stopped / Continued / ptrace event — not an exit; keep sweeping.
                Ok(_) => continue,
                Err(e) => {
                    warn!(error = %e, "reaper: waitpid(-1) failed");
                    break;
                }
            }
        }
        exits
    }

    /// Claim this pid's exit slot. The only way to obtain one.
    ///
    /// Call the moment the pid is known — right after the spawn or build returns
    /// it — not when a Wait arrives. A detached exec sends no Wait until its
    /// caller chooses to; claiming at spawn is what keeps its exit from ageing
    /// out as an ownerless stray in the meantime.
    ///
    /// `spawned_at` must be read *before* the spawn. A slot already sitting
    /// under this pid may be a stray, or a finished execution's — the registry
    /// never drops entries, so a claimed slot outlives its execution. Either
    /// way `settled_at` separates the two things it might be:
    ///
    /// - settled **before** we spawned → the previous owner of a recycled pid.
    ///   Claimed slots never age out, so this must be dropped or wraparound
    ///   would hand us someone else's exit as our own.
    /// - settled **after** we spawned → *our* child, which exited before its pid
    ///   finished travelling back from the zygote. Dropping it would strand the
    ///   waiter forever, so it is kept and adopted.
    ///
    /// Slots grow with the execution registry, which is likewise only cleared
    /// when the guest exits, so this adds no new unbounded growth.
    pub(crate) async fn register(&self, pid: Pid, spawned_at: Instant) -> ExitSlot {
        let mut inner = self.inner.lock().await;
        if inner
            .slots
            .get(&pid)
            .is_some_and(|slot| slot.settled_at.is_some_and(|at| at < spawned_at))
        {
            inner.slots.remove(&pid);
        }
        let slot = inner.slot(pid, None);
        slot.stray_since = None;
        ExitSlot(slot.tx.subscribe())
    }

    /// Claim this pid's exit slot *and* register the follow-up the reaper runs
    /// when the exit is delivered. Same claim semantics as `register` — the
    /// returned slot serves any number of readers — plus one action, fired
    /// exactly once.
    ///
    /// If the exit already landed (a fast child reaped before its owner could
    /// register), the action runs right here with the stored status instead of
    /// waiting for a deliver that already happened.
    pub(crate) async fn on_exit(
        &self,
        pid: Pid,
        spawned_at: Instant,
        action: ExitAction,
    ) -> ExitSlot {
        let mut action = Some(action);
        let (slot_rx, fire_with) = {
            let mut inner = self.inner.lock().await;
            if inner
                .slots
                .get(&pid)
                .is_some_and(|slot| slot.settled_at.is_some_and(|at| at < spawned_at))
            {
                inner.slots.remove(&pid);
            }
            let slot = inner.slot(pid, None);
            slot.stray_since = None;
            let fire_with = *slot.tx.borrow();
            if fire_with.is_none() {
                slot.action = action.take();
            }
            (ExitSlot(slot.tx.subscribe()), fire_with)
        };
        if let (Some(status), Some(action)) = (fire_with, action) {
            // Outside the lock, like every action invocation.
            action(status);
        }
        slot_rx
    }

    /// Deposit a reaped exit. Never blocks on a reader, so an exit that lands
    /// before its owner registers is simply already there when the owner
    /// arrives. Returns the pid's registered action, if any, for the caller to
    /// fire once the lock is released.
    async fn deliver(&self, pid: Pid, status: ExitStatus) -> Option<ExitAction> {
        let mut inner = self.inner.lock().await;

        // We are the only writer, and the kernel reaps a pid once per
        // incarnation, so an already-settled slot under this pid can only
        // belong to an owner the kernel has since recycled away. Detach it
        // rather than overwrite: that owner keeps reading its own status from
        // the receiver it already holds, and this exit starts a clean slot.
        // Overwriting instead would hand a stale execution's `Wait` the new
        // process's code — the same recycle hazard `register` guards, one site
        // over.
        if inner
            .slots
            .get(&pid)
            .is_some_and(|slot| slot.settled_at.is_some())
        {
            inner.slots.remove(&pid);
        }

        let claimed = inner.slots.contains_key(&pid);
        if !claimed {
            // Nobody registered this pid: a stray we own but nobody waits for (a
            // libcontainer intermediate reparented here by `as_sibling`), or an
            // exit that beat its own spawn's `register`. Age old strays out here
            // so the map cannot grow without bound.
            debug!(
                pid = pid.as_raw(),
                "reaper: exit with no claim (race or stray)"
            );
            inner.prune_stale();
        }
        let now = Instant::now();
        let slot = inner.slot(pid, (!claimed).then_some(now));
        slot.settled_at = Some(now);
        slot.tx.send_replace(Some(status));
        slot.action.take()
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    //! Exercises the reaper's registry logic in isolation — the parts that carry
    //! the race handling — without the OS-level `waitpid(-1)`/SIGCHLD loop. We
    //! drive `deliver()` directly to stand in for what `drain()` would do.

    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use nix::sys::signal::Signal;
    use nix::unistd::Pid;
    use tokio::sync::Mutex;

    use tokio::sync::watch;

    use super::{reap_fence, ExitStatus, Inner, Reaper, Slot, REAPED_TTL};

    fn bare() -> Arc<Reaper> {
        Arc::new(Reaper {
            inner: Mutex::new(Inner::default()),
        })
    }

    /// A settled slot nobody holds, reaped at a chosen time.
    fn stray_slot(status: ExitStatus, since: Instant) -> Slot {
        Slot {
            tx: watch::channel(Some(status)).0,
            stray_since: Some(since),
            settled_at: Some(since),
            action: None,
        }
    }

    fn pid(n: i32) -> Pid {
        Pid::from_raw(n)
    }

    /// Extract an exit code, or `None` if the status was a signal.
    fn code(status: ExitStatus) -> Option<i32> {
        match status {
            ExitStatus::Code(c) => Some(c),
            ExitStatus::Signal(_) => None,
        }
    }

    fn sig(status: ExitStatus) -> Option<Signal> {
        match status {
            ExitStatus::Signal(s) => Some(s),
            ExitStatus::Code(_) => None,
        }
    }

    /// A stale timestamp just past the TTL, computed from real uptime.
    fn expired_at() -> Instant {
        Instant::now()
            .checked_sub(REAPED_TTL + Duration::from_secs(1))
            .expect("test host uptime should exceed REAPED_TTL")
    }

    /// An action registered before the exit fires exactly once, with the
    /// delivered status — and a later deliver on the recycled pid does not
    /// re-fire it.
    #[tokio::test]
    async fn an_action_fires_once_with_the_delivered_status() {
        let r = bare();
        let (tx, rx) = std::sync::mpsc::channel();
        let slot = r
            .on_exit(
                pid(801),
                Instant::now(),
                Box::new(move |status| {
                    tx.send(status).expect("test channel");
                }),
            )
            .await;

        if let Some(action) = r.deliver(pid(801), ExitStatus::Code(5)).await {
            action(ExitStatus::Code(5));
        }
        assert_eq!(
            code(rx.recv().expect("the action must fire")),
            Some(5),
            "the action must see the delivered status"
        );

        // Pid recycled: a second deliver settles a fresh slot with no action.
        if let Some(action) = r.deliver(pid(801), ExitStatus::Code(6)).await {
            action(ExitStatus::Code(6));
        }
        assert!(
            rx.try_recv().is_err(),
            "a recycled pid's exit must not re-fire the previous owner's action"
        );

        // The claim's readers still work like any register-claimed slot.
        assert_eq!(code(slot.get().await), Some(5));
    }

    /// The exit can beat the registration — a fast child is reaped before its
    /// owner calls `on_exit`. The action must fire immediately with the stored
    /// status, not wait for a deliver that already happened.
    #[tokio::test]
    async fn an_action_registered_after_the_exit_fires_immediately() {
        let r = bare();
        let spawned_at = Instant::now();
        r.deliver(pid(802), ExitStatus::Code(3)).await;

        let (tx, rx) = std::sync::mpsc::channel();
        let slot = r
            .on_exit(
                pid(802),
                spawned_at,
                Box::new(move |status| {
                    tx.send(status).expect("test channel");
                }),
            )
            .await;

        assert_eq!(
            code(
                rx.recv()
                    .expect("a settled slot must fire the action at registration")
            ),
            Some(3)
        );
        assert_eq!(
            code(slot.get().await),
            Some(3),
            "readers see the same status"
        );
    }

    /// Normal path: the owner claims a slot, then the reaper deposits into it.
    #[tokio::test]
    async fn register_then_deliver_wakes_the_waiter() {
        let r = bare();
        let slot = r.register(pid(101), Instant::now()).await;
        let waiter = tokio::spawn(async move { slot.get().await });

        r.deliver(pid(101), ExitStatus::Code(7)).await;

        let got = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("waiter must not hang")
            .unwrap();
        assert_eq!(code(got), Some(7));
    }

    /// The reaped-before-claim RACE: the exit lands before its owner registers.
    /// `deliver` creates the slot, so the later `register` adopts a slot that is
    /// already settled and `get` returns without blocking.
    #[tokio::test]
    async fn deliver_before_register_is_still_readable() {
        let r = bare();
        // Read before the spawn, exactly as the exec path does.
        let spawned_at = Instant::now();
        r.deliver(pid(102), ExitStatus::Code(3)).await; // no owner yet

        let slot = r.register(pid(102), spawned_at).await;
        let got = tokio::time::timeout(Duration::from_secs(5), slot.get())
            .await
            .expect("a settled slot must return immediately, not block");
        assert_eq!(code(got), Some(3));
    }

    /// Signal deaths survive the registry as `Signal`, not a code.
    #[tokio::test]
    async fn signaled_exit_is_delivered_as_signal() {
        let r = bare();
        let slot = r.register(pid(103), Instant::now()).await;
        r.deliver(pid(103), ExitStatus::Signal(Signal::SIGTERM))
            .await;
        assert_eq!(sig(slot.get().await), Some(Signal::SIGTERM));
    }

    /// Each pid's exit reaches only that pid's slot — no cross-delivery.
    #[tokio::test]
    async fn distinct_pids_do_not_cross() {
        let r = bare();
        let first = r.register(pid(201), Instant::now()).await;
        let second = r.register(pid(202), Instant::now()).await;

        r.deliver(pid(201), ExitStatus::Code(1)).await;
        r.deliver(pid(202), ExitStatus::Code(2)).await;

        assert_eq!(code(second.get().await), Some(2));
        assert_eq!(code(first.get().await), Some(1));
    }

    /// A settled slot answers every caller, not just the first.
    ///
    /// The pull API this replaced handed each exit out exactly once — `wait` did
    /// `reaped.remove(&pid)` — so a second Wait RPC for the same execution found
    /// nothing and registered a receiver that would never fire.
    #[tokio::test]
    async fn a_settled_slot_answers_every_caller() {
        let r = bare();
        let slot = r.register(pid(104), Instant::now()).await;
        r.deliver(pid(104), ExitStatus::Code(5)).await;

        for attempt in 0..3 {
            let got = tokio::time::timeout(Duration::from_millis(500), slot.get())
                .await
                .unwrap_or_else(|_| panic!("read {attempt} must not block"));
            assert_eq!(code(got), Some(5), "read {attempt}");
        }
    }

    /// Concurrent waiters on one pid must all get the real status.
    ///
    /// Under the oneshot registry a second `wait` for the same pid displaced the
    /// first caller's sender — `waiters.insert` dropped it — and that first
    /// caller woke with a fabricated `ExitStatus::Code(-1)` no process returned.
    #[tokio::test]
    async fn concurrent_waiters_all_get_the_real_status() {
        let r = bare();
        let slot = r.register(pid(105), Instant::now()).await;

        let waiters: Vec<_> = (0..4)
            .map(|_| {
                let slot = slot.clone();
                tokio::spawn(async move { slot.get().await })
            })
            .collect();

        r.deliver(pid(105), ExitStatus::Code(6)).await;

        for (n, waiter) in waiters.into_iter().enumerate() {
            let got = tokio::time::timeout(Duration::from_secs(5), waiter)
                .await
                .unwrap_or_else(|_| panic!("waiter {n} must not hang"))
                .unwrap();
            assert_eq!(
                code(got),
                Some(6),
                "waiter {n} must not get a fabricated -1"
            );
        }
    }

    /// `prune_stale` drops unheld strays past the TTL and keeps fresh ones.
    #[tokio::test]
    async fn prune_stale_drops_expired_keeps_fresh() {
        let r = bare();
        let mut inner = r.inner.lock().await;
        inner
            .slots
            .insert(pid(301), stray_slot(ExitStatus::Code(9), expired_at()));
        inner
            .slots
            .insert(pid(302), stray_slot(ExitStatus::Code(0), Instant::now()));
        inner.prune_stale();
        assert!(
            !inner.slots.contains_key(&pid(301)),
            "expired stray must be pruned"
        );
        assert!(
            inner.slots.contains_key(&pid(302)),
            "fresh entry must survive"
        );
    }

    /// Pruning a stray can never strand a caller: `register` clears the stray
    /// mark before it hands out a receiver, so a slot still marked stray has no
    /// holder. Claiming one makes it exempt from pruning thereafter.
    #[tokio::test]
    async fn claiming_a_stray_exempts_it_from_pruning() {
        let r = bare();
        r.deliver(pid(305), ExitStatus::Code(4)).await; // stray
        let slot = r.register(pid(305), Instant::now()).await; // ...now claimed

        r.inner.lock().await.prune_stale();

        assert!(
            r.inner.lock().await.slots.contains_key(&pid(305)),
            "a claimed slot is exempt from pruning whatever its age"
        );
        // The claim discarded the stray's status (it settled before the spawn),
        // so this slot is empty and waiting — not holding the old code 4.
        assert!(tokio::time::timeout(Duration::from_millis(200), slot.get())
            .await
            .is_err());
    }

    /// A stray (reaped, nobody registered — e.g. libcontainer's intermediate) is
    /// kept, then aged out by a later prune, so strays cannot accumulate.
    #[tokio::test]
    async fn stray_is_kept_then_aged_out() {
        let r = bare();
        r.deliver(pid(303), ExitStatus::Code(0)).await; // stray, unclaimed
        assert!(r.inner.lock().await.slots.contains_key(&pid(303)));

        // Backdate it past the TTL, then trigger a prune with an unrelated stray.
        {
            let mut inner = r.inner.lock().await;
            inner
                .slots
                .insert(pid(303), stray_slot(ExitStatus::Code(0), expired_at()));
        }
        r.deliver(pid(999), ExitStatus::Code(0)).await; // unclaimed → prune_stale

        assert!(
            !r.inner.lock().await.slots.contains_key(&pid(303)),
            "aged-out stray must be gone so a recycled pid can't read it"
        );
    }

    /// An exit nobody has read *yet* must survive until its owner reads it.
    ///
    /// A detached exec (`boxlite exec -d`, cli/commands/exec.rs) returns before
    /// any Wait RPC, so nothing reads its tenant's exit when it lands. Every
    /// later exec produces a stray whose `deliver` runs `prune_stale`. Claimed
    /// slots are exempt, so the detached exec's status is still there whenever
    /// its owner finally asks.
    #[tokio::test]
    async fn a_claimed_exit_survives_a_later_prune() {
        let r = bare();

        // The exec path claims the slot as soon as the spawn returns the pid,
        // long before any Wait arrives.
        let slot = r.register(pid(401), Instant::now()).await;

        // A detached exec's tenant exits with nobody reading yet.
        r.deliver(pid(401), ExitStatus::Code(7)).await;

        // A later stray (an intermediate nobody claims) triggers prune_stale().
        r.deliver(pid(402), ExitStatus::Code(0)).await;

        // The detached exec's owner finally asks. It must still get 7.
        let got = tokio::time::timeout(Duration::from_millis(500), slot.get())
            .await
            .expect("a claimed exit must not be pruned away");
        assert_eq!(code(got), Some(7));
    }

    /// The claim can arrive AFTER the exit, and that exit is ours to keep.
    ///
    /// A tenant is built in the zygote and is already running when its pid comes
    /// back over IPC, so a short command can exit before we ever see the pid:
    /// `deliver` lands first, `register` second. Discarding on claim would throw
    /// away the real exit and strand the waiter forever.
    #[tokio::test]
    async fn claiming_keeps_an_exit_reaped_after_the_spawn() {
        let r = bare();
        let spawned_at = Instant::now();

        // The tenant exits while its pid is still travelling back to us.
        r.deliver(pid(601), ExitStatus::Code(3)).await;
        // Only now does the exec path learn the pid and claim it.
        let slot = r.register(pid(601), spawned_at).await;

        let got = tokio::time::timeout(Duration::from_millis(500), slot.get())
            .await
            .expect("claim must not discard an exit reaped after the spawn");
        assert_eq!(code(got), Some(3));
    }

    /// A recycled pid must not hand its new owner the previous process's exit.
    ///
    /// The execution registry never drops entries, so a *claimed* slot outlives
    /// its execution — and `prune_stale` exempts claimed slots outright, so a
    /// finished exec's status sits here until the guest exits. When the kernel
    /// wraps around, the only thing separating that corpse from the new owner's
    /// own exit is when it settled. Guarding on "is this a stray?" instead of
    /// "when did this settle?" hands the new owner the old status immediately.
    #[tokio::test]
    async fn claiming_discards_an_exit_reaped_before_the_spawn() {
        let r = bare();

        // A previous exec claimed this pid, ran, and exited. Its slot remains.
        let previous = r.register(pid(602), Instant::now()).await;
        r.deliver(pid(602), ExitStatus::Code(9)).await;
        assert_eq!(
            code(previous.get().await),
            Some(9),
            "the previous owner's own read"
        );

        // The kernel recycles the pid and a new spawn claims it.
        let slot = r.register(pid(602), Instant::now()).await;

        // The new owner waits for its own exit rather than being handed code 9.
        assert!(
            tokio::time::timeout(Duration::from_millis(200), slot.get())
                .await
                .is_err(),
            "a slot settled before our spawn belongs to the previous owner"
        );
    }

    /// A second exit under one pid must not overwrite the first owner's status.
    ///
    /// The registry never evicts, so a finished execution keeps its slot *and*
    /// its receiver. If the kernel recycles that pid and the new tenant exits
    /// before its `register` lands, `deliver` finds a settled slot — and
    /// overwriting it would make the old execution's `Wait` return the new
    /// process's code, breaking the "every caller reads the same status"
    /// contract this design rests on.
    #[tokio::test]
    async fn a_recycled_deliver_does_not_overwrite_the_previous_owner() {
        let r = bare();

        // Exec A: claims the pid, runs, exits. Its slot and receiver persist.
        let first = r.register(pid(701), Instant::now()).await;
        r.deliver(pid(701), ExitStatus::Code(1)).await;
        assert_eq!(code(first.get().await), Some(1));

        // Pid recycled. B's spawn instant is read before B runs, as the exec
        // path does; B then exits before its own register lands.
        let b_spawned_at = Instant::now();
        r.deliver(pid(701), ExitStatus::Code(2)).await;

        assert_eq!(
            code(first.get().await),
            Some(1),
            "the first owner must still read its own exit, not the recycled one"
        );

        // ...and B, registering after, adopts its own exit rather than A's.
        let second = r.register(pid(701), b_spawned_at).await;
        assert_eq!(code(second.get().await), Some(2));
    }

    /// A stray settled before our spawn is likewise not ours.
    #[tokio::test]
    async fn claiming_discards_a_stray_reaped_before_the_spawn() {
        let r = bare();
        r.inner
            .lock()
            .await
            .slots
            .insert(pid(603), stray_slot(ExitStatus::Code(9), expired_at()));

        let slot = r.register(pid(603), Instant::now()).await;

        assert!(
            tokio::time::timeout(Duration::from_millis(200), slot.get())
                .await
                .is_err(),
            "a stray settled before our spawn belongs to the previous owner"
        );
    }

    /// Reproduces the ECHILD race and pins the fix, in three phases.
    ///
    /// The bug: `std::process::Command::output()` waits for its own child, our
    /// sweep does `waitpid(-1)`, and whoever wins takes the exit — leaving the
    /// loser's wait to fail with `ECHILD`. On a booted box this hit 10 of 20
    /// `output()` calls unfenced, and 0 of 20 fenced.
    ///
    /// Phase 1 reproduces the theft deterministically (no fence, forced order).
    /// Phase 2 is the two-way guard: with a sweeper hammering concurrently, a
    /// fenced spawn-and-wait must never lose its child — delete the write lock in
    /// `sweep_exits` (or the read guard in `reap_fence`) and this fails.
    /// Phase 3 checks the lock shape: shared for callers, exclusive vs the sweep.
    ///
    /// This is the only test that touches the process-global `REAP_LOCK`; keep it
    /// that way so parallel tests cannot perturb the assertions.
    #[test]
    fn reap_fence_prevents_the_sweep_from_stealing_a_waiters_child() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc;
        use std::thread;

        // ---- Phase 1: unfenced, the sweep steals the child and its owner's
        // wait fails with ECHILD. Order is forced, so this is deterministic.
        let mut victim = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .spawn()
            .expect("spawn victim");
        let victim_pid = victim.id() as i32;
        while !Reaper::sweep_exits()
            .iter()
            .any(|(pid, _)| pid.as_raw() == victim_pid)
        {
            thread::sleep(Duration::from_millis(10)); // wait for it to exit, then sweep
        }
        let stolen = victim.wait().expect_err("sweep already took this child");
        assert_eq!(
            stolen.raw_os_error(),
            Some(nix::libc::ECHILD),
            "an unfenced sweep leaves the owner's wait with ECHILD"
        );

        // ---- Phase 2: fenced, with a sweeper running flat out, every
        // spawn-and-wait must keep its own child.
        let stop = Arc::new(AtomicBool::new(false));
        let sweeper = {
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let _ = Reaper::sweep_exits();
                    thread::yield_now();
                }
            })
        };
        let mut lost = 0;
        for _ in 0..20 {
            let result = {
                let _fence = reap_fence();
                std::process::Command::new("/bin/sh")
                    .arg("-c")
                    .arg("exit 0")
                    .output()
            };
            if let Err(e) = result {
                if e.raw_os_error() == Some(nix::libc::ECHILD) {
                    lost += 1;
                }
            }
        }
        stop.store(true, Ordering::Relaxed);
        sweeper.join().expect("sweeper thread panicked");
        assert_eq!(
            lost, 0,
            "the fence must stop the sweep stealing our children"
        );

        // ---- Phase 3: fences are shared with each other, exclusive vs the sweep.
        let first = reap_fence();
        let second = reap_fence(); // must not block on `first`
        let (tx, rx) = mpsc::channel();
        let blocked = thread::spawn(move || {
            let _ = Reaper::sweep_exits();
            let _ = tx.send(());
        });
        assert!(
            rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "sweep must be fenced out while a caller holds the fence"
        );
        drop(first);
        assert!(
            rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "still fenced while the second caller holds it"
        );
        drop(second);
        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "sweep must proceed once every fence is released"
        );
        blocked.join().expect("sweeper thread panicked");
    }

    /// Concurrency / deadlock guard: many waiters and deliverers race on the
    /// registry from several threads, in opposite orders. Every waiter must
    /// resolve to its own pid's code and none may hang — catches a lock-ordering
    /// deadlock or a lost/mis-delivered exit under contention.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_waiters_and_deliverers_all_resolve() {
        let r = bare();
        let n: i32 = 200;

        // Read before any deliver, as the exec path does: an exit landing after
        // this instant is ours to adopt, not a recycled pid's leftover.
        let spawned_at = Instant::now();

        let mut waiters = Vec::new();
        for i in 0..n {
            let r2 = Arc::clone(&r);
            waiters.push((
                i,
                tokio::spawn(
                    async move { r2.register(pid(1000 + i), spawned_at).await.get().await },
                ),
            ));
        }
        // Deliver in the reverse order so delivers and waits interleave: some land
        // before their waiter (cache branch), some after (wake branch).
        let mut deliverers = Vec::new();
        for i in (0..n).rev() {
            let r2 = Arc::clone(&r);
            deliverers.push(tokio::spawn(async move {
                r2.deliver(pid(1000 + i), ExitStatus::Code(i)).await
            }));
        }
        for d in deliverers {
            d.await.unwrap();
        }
        for (i, w) in waiters {
            let got = tokio::time::timeout(Duration::from_secs(10), w)
                .await
                .unwrap_or_else(|_| panic!("waiter for pid {} hung", 1000 + i))
                .unwrap();
            assert_eq!(code(got), Some(i), "pid {} got the wrong exit", 1000 + i);
        }
    }
}
