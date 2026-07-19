//! Single child-reaper for the guest agent's own processes.
//!
//! Replaces per-process blocking `waitpid(pid)` — one OS thread parked per wait,
//! and correctness hostage to how a container init reparents — with one task
//! that drains `waitpid(-1, WNOHANG)` on every `SIGCHLD` and hands each pid's
//! exit status to its registered waiter. The container init and exec tenants are
//! cloned `CLONE_PARENT` (youki `as_sibling`) so they are our direct children;
//! the agent also sets `PR_SET_CHILD_SUBREAPER` as a net for any other orphaned
//! descendant. `tokio::signal(SIGCHLD)` is the signalfd/self-pipe, delivered
//! async-signal-safely by the runtime — no hand-rolled pipe.
//!
//! Scope: every process the guest waits on. The container init and exec tenants
//! are both cloned `CLONE_PARENT` (youki `as_sibling`) so they reparent to us,
//! and directly-spawned guest processes are our children already. libcontainer's
//! own intermediate reparents here too and is reaped with no waiter — see
//! `reaped`, which ages such strays out before a recycled pid could read them.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant};

use nix::errno::Errno;
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::{oneshot, Mutex};
use tracing::{debug, error, warn};

use crate::service::exec::exec_handle::ExitStatus;

/// Installed once in `async_main`, after the tokio runtime exists.
pub(crate) static REAPER: OnceLock<Arc<Reaper>> = OnceLock::new();

pub(crate) struct Reaper {
    inner: Mutex<Inner>,
}

/// Strays (reaped with no waiter) are dropped after this long. The genuine
/// reaped-before-`wait` race resolves in well under a second; this only needs to
/// be short enough that a recycled pid cannot collide with a stale entry.
const REAPED_TTL: Duration = Duration::from_secs(60);

/// Serializes our `waitpid(-1)` sweep against callers that wait for their *own*
/// child.
///
/// `std::process::Command::output()` / `Child::wait()` reap the child
/// themselves. Our sweep races them, and when it wins their wait fails with
/// `ECHILD` — measured at ~20% on a booted box before this lock existed. The
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

#[derive(Default)]
struct Inner {
    /// pid → the caller awaiting its exit.
    waiters: HashMap<Pid, oneshot::Sender<ExitStatus>>,
    /// Exits reaped before their waiter arrived. Two kinds live here: exits of
    /// pids someone has declared it will wait for (`expected`), and strays we
    /// reap with no owner at all — a libcontainer intermediate reparents here
    /// via `as_sibling` and nobody ever waits for it. Each carries a reap time
    /// so *strays* can age out before pid reuse hands a recycled pid a stale
    /// exit; expected exits are never aged out.
    reaped: HashMap<Pid, (ExitStatus, Instant)>,
    /// pids declared via `expect()` at spawn time, before the exit can happen.
    ///
    /// Without this the reaper cannot tell "nobody has asked *yet*" from "nobody
    /// will ever ask", so a detached exec's exit — no Wait RPC is sent until the
    /// caller chooses to — was aged out and its later Wait blocked forever.
    expected: HashSet<Pid>,
}

impl Inner {
    /// Drop stray exits nobody claimed within `REAPED_TTL`.
    ///
    /// Expected pids are exempt: their owner may still ask, arbitrarily later.
    fn prune_stale(&mut self) {
        let expected = &self.expected;
        self.reaped.retain(|pid, (_, reaped_at)| {
            expected.contains(pid) || reaped_at.elapsed() < REAPED_TTL
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
            self.deliver(pid, status).await;
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

    /// Declare that this pid has an owner who will ask for its exit.
    ///
    /// Call the moment the pid is known — right after the spawn or build
    /// returns it — not when a Wait arrives. A detached exec sends no Wait
    /// until its caller chooses to, so until then its exit must be held rather
    /// than aged out as an ownerless stray.
    ///
    /// The set grows with the execution registry, which is likewise only
    /// cleared when the guest exits, so this adds no new unbounded growth.
    /// `spawned_at` must be read *before* the spawn, and is what separates the
    /// two things that can already sit in `reaped` under this pid:
    ///
    /// - reaped **before** we spawned → a previous owner of a recycled pid.
    ///   Expected pids are exempt from `prune_stale`, so this must be dropped or
    ///   it would outlive wraparound and be handed to us as our own exit.
    /// - reaped **after** we spawned → *our* child, which exited before its pid
    ///   finished travelling back from the zygote. Dropping this one strands the
    ///   Wait forever, so it must be kept.
    pub(crate) async fn expect_waiter(&self, pid: Pid, spawned_at: Instant) {
        let mut inner = self.inner.lock().await;
        if inner
            .reaped
            .get(&pid)
            .is_some_and(|(_, reaped_at)| *reaped_at < spawned_at)
        {
            inner.reaped.remove(&pid);
        }
        inner.expected.insert(pid);
    }

    async fn deliver(&self, pid: Pid, status: ExitStatus) {
        let mut inner = self.inner.lock().await;
        match inner.waiters.remove(&pid) {
            Some(tx) => {
                inner.expected.remove(&pid);
                let _ = tx.send(status);
            }
            None => {
                // No waiter yet: either a `wait` that races this reap, or a stray
                // we own but nobody waits for (a libcontainer intermediate
                // reparented here by `as_sibling`). Prune stale strays so a
                // recycled pid can't later read one, then cache with a timestamp.
                debug!(
                    pid = pid.as_raw(),
                    "reaper: exit with no waiter (race or stray)"
                );
                inner.prune_stale();
                inner.reaped.insert(pid, (status, Instant::now()));
            }
        }
    }

    /// Await `pid`'s exit. Call at most once per pid — callers dedupe through
    /// `ExecutionState`'s `exit` OnceCell; a second call for an already-reaped
    /// pid would register a waiter that never fires.
    pub(crate) async fn wait(&self, pid: Pid) -> ExitStatus {
        let rx = {
            let mut inner = self.inner.lock().await;
            if let Some((status, _)) = inner.reaped.remove(&pid) {
                inner.expected.remove(&pid);
                return status;
            }
            let (tx, rx) = oneshot::channel();
            inner.waiters.insert(pid, tx);
            rx
        };
        // The reaper task lives for the whole process; the sender is dropped only
        // by delivering a status. `-1` is a defensive fallback.
        rx.await.unwrap_or(ExitStatus::Code(-1))
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

    use super::{reap_fence, ExitStatus, Inner, Reaper, REAPED_TTL};

    fn bare() -> Arc<Reaper> {
        Arc::new(Reaper {
            inner: Mutex::new(Inner::default()),
        })
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

    /// Normal path: the waiter registers first, then the reaper delivers.
    #[tokio::test]
    async fn wait_then_deliver_wakes_the_waiter() {
        let r = bare();
        let r2 = Arc::clone(&r);
        let waiter = tokio::spawn(async move { r2.wait(pid(101)).await });

        // Spin until the waiter is registered so we exercise the deliver-to-waiter
        // branch (not the cache branch).
        loop {
            if r.inner.lock().await.waiters.contains_key(&pid(101)) {
                break;
            }
            tokio::task::yield_now().await;
        }
        r.deliver(pid(101), ExitStatus::Code(7)).await;

        let got = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("waiter must not hang")
            .unwrap();
        assert_eq!(code(got), Some(7));
    }

    /// The reaped-before-`wait` RACE: the reaper delivers before any waiter has
    /// registered. `deliver()` must cache the exit and `wait()` must return it.
    /// This is the exact race the `reaped` map exists to absorb.
    #[tokio::test]
    async fn deliver_before_wait_returns_cached_exit() {
        let r = bare();
        r.deliver(pid(102), ExitStatus::Code(3)).await; // no waiter yet → cached
        let got = tokio::time::timeout(Duration::from_secs(5), r.wait(pid(102)))
            .await
            .expect("cached exit must be returned immediately, not block");
        assert_eq!(code(got), Some(3));
    }

    /// Signal deaths survive the registry as `Signal`, not a code.
    #[tokio::test]
    async fn signaled_exit_is_delivered_as_signal() {
        let r = bare();
        r.deliver(pid(103), ExitStatus::Signal(Signal::SIGTERM))
            .await;
        let got = r.wait(pid(103)).await;
        assert_eq!(sig(got), Some(Signal::SIGTERM));
    }

    /// Each pid's exit reaches only that pid's waiter — no cross-delivery.
    #[tokio::test]
    async fn distinct_pids_do_not_cross() {
        let r = bare();
        r.deliver(pid(201), ExitStatus::Code(1)).await;
        r.deliver(pid(202), ExitStatus::Code(2)).await;
        assert_eq!(code(r.wait(pid(202)).await), Some(2));
        assert_eq!(code(r.wait(pid(201)).await), Some(1));
    }

    /// A cached exit is consumed exactly once (the documented at-most-once
    /// contract): after one `wait`, the entry is gone.
    #[tokio::test]
    async fn cached_exit_is_consumed_once() {
        let r = bare();
        r.deliver(pid(104), ExitStatus::Code(5)).await;
        assert_eq!(code(r.wait(pid(104)).await), Some(5));
        assert!(
            !r.inner.lock().await.reaped.contains_key(&pid(104)),
            "the cached exit must be removed once claimed"
        );
    }

    /// `prune_stale` drops entries past the TTL and keeps fresh ones — the guard
    /// that stops a recycled pid from reading a stale stray's exit.
    #[tokio::test]
    async fn prune_stale_drops_expired_keeps_fresh() {
        let r = bare();
        let mut inner = r.inner.lock().await;
        inner
            .reaped
            .insert(pid(301), (ExitStatus::Code(9), expired_at()));
        inner
            .reaped
            .insert(pid(302), (ExitStatus::Code(0), Instant::now()));
        inner.prune_stale();
        assert!(
            !inner.reaped.contains_key(&pid(301)),
            "expired stray must be pruned"
        );
        assert!(
            inner.reaped.contains_key(&pid(302)),
            "fresh entry must survive"
        );
    }

    /// A stray (reaped, never waited — e.g. libcontainer's intermediate) is cached
    /// then aged out by a later prune, so a recycled pid cannot read it.
    #[tokio::test]
    async fn stray_is_cached_then_aged_out() {
        let r = bare();
        r.deliver(pid(303), ExitStatus::Code(0)).await; // stray, no waiter
        assert!(r.inner.lock().await.reaped.contains_key(&pid(303)));

        // Backdate it past the TTL, then trigger a prune with an unrelated deliver.
        {
            let mut inner = r.inner.lock().await;
            let (status, _) = inner.reaped.remove(&pid(303)).unwrap();
            inner.reaped.insert(pid(303), (status, expired_at()));
        }
        r.deliver(pid(999), ExitStatus::Code(0)).await; // deliver-with-no-waiter → prune_stale

        assert!(
            !r.inner.lock().await.reaped.contains_key(&pid(303)),
            "aged-out stray must be gone so a recycled pid can't read it"
        );
    }

    /// An exit nobody has claimed *yet* must survive until it is claimed.
    ///
    /// A detached exec (`boxlite exec -d`, cli/commands/exec.rs) returns before
    /// any Wait RPC, so its tenant has no registered waiter when it exits. The
    /// exit lands in `reaped` unclaimed. Every later exec produces a stray
    /// (libcontainer's intermediate, now our child via `as_sibling`), and each
    /// stray's `deliver()` runs `prune_stale()` — which drops the detached
    /// exec's exit once it is older than `REAPED_TTL`. A Wait arriving after
    /// that registers a receiver nothing will ever fire, and `wait()` has no
    /// timeout, so the RPC hangs forever.
    ///
    /// The pre-reaper path did not have this hole: `wait_via_zygote` polled
    /// `waitpid(pid, WNOHANG)` against a zombie that persisted, so a late Wait
    /// always got its code.
    #[tokio::test]
    async fn an_unclaimed_exit_survives_a_later_prune() {
        let r = bare();

        // The exec path declares the pid as soon as the spawn returns it, long
        // before any Wait arrives.
        r.expect_waiter(pid(401), Instant::now()).await;

        // A detached exec's tenant exits with nobody waiting yet.
        r.deliver(pid(401), ExitStatus::Code(7)).await;

        // Age it past the TTL. There is no timer — pruning only happens inside
        // deliver(), so we backdate and then trigger one.
        {
            let mut inner = r.inner.lock().await;
            let (status, _) = inner.reaped.remove(&pid(401)).unwrap();
            inner.reaped.insert(pid(401), (status, expired_at()));
        }

        // A later stray (an intermediate nobody waits for) triggers prune_stale().
        r.deliver(pid(402), ExitStatus::Code(0)).await;

        // The detached exec's owner finally asks for its status. It must still
        // get 7 — not block forever on a receiver that never fires.
        let got = tokio::time::timeout(Duration::from_millis(500), r.wait(pid(401)))
            .await
            .expect("wait must not hang: the unclaimed exit was pruned away");
        assert_eq!(code(got), Some(7));
    }

    /// The claim can arrive AFTER the exit, and that exit is ours to keep.
    ///
    /// A tenant is built in the zygote and is already running when its pid comes
    /// back over IPC, so a short command can exit before we ever see the pid:
    /// `deliver` lands first, `expect_waiter` second. Discarding on claim — as an
    /// unconditional `reaped.remove` would — throws away the real exit and the
    /// Wait then blocks forever, which is the very hang this design exists to
    /// prevent.
    #[tokio::test]
    async fn claiming_keeps_an_exit_reaped_after_the_spawn() {
        let r = bare();
        let spawned_at = Instant::now();

        // The tenant exits while its pid is still travelling back to us.
        r.deliver(pid(601), ExitStatus::Code(3)).await;
        // Only now does the exec path learn the pid and claim it.
        r.expect_waiter(pid(601), spawned_at).await;

        let got = tokio::time::timeout(Duration::from_millis(500), r.wait(pid(601)))
            .await
            .expect("claim must not discard an exit reaped after the spawn");
        assert_eq!(code(got), Some(3));
    }

    /// A recycled pid must not hand its new owner the previous process's exit.
    ///
    /// Expected pids are exempt from `prune_stale`, so an exit nobody ever claims
    /// lives as long as the guest. Once the kernel wraps around, the only thing
    /// separating that corpse from our own exit is when it was reaped.
    #[tokio::test]
    async fn claiming_discards_an_exit_reaped_before_the_spawn() {
        let r = bare();

        // A previous owner of this pid exited; nobody ever asked for it.
        r.deliver(pid(602), ExitStatus::Code(9)).await;
        {
            let mut inner = r.inner.lock().await;
            let (status, _) = inner.reaped.remove(&pid(602)).unwrap();
            inner.reaped.insert(pid(602), (status, expired_at()));
        }

        // The pid is recycled and a new spawn claims it.
        r.expect_waiter(pid(602), Instant::now()).await;
        assert!(
            !r.inner.lock().await.reaped.contains_key(&pid(602)),
            "an exit predating our spawn belongs to the previous owner"
        );

        // The new owner waits for its own exit rather than being handed code 9.
        assert!(
            tokio::time::timeout(Duration::from_millis(200), r.wait(pid(602)))
                .await
                .is_err(),
            "wait must not return the previous process's exit"
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

        let mut waiters = Vec::new();
        for i in 0..n {
            let r2 = Arc::clone(&r);
            waiters.push((i, tokio::spawn(async move { r2.wait(pid(1000 + i)).await })));
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
