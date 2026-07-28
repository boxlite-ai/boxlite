# Reaper: one wait, one place

**Date:** 2026-07-19
**Status:** Implemented
**Supersedes:** the `Reaper::wait(pid)` pull API shipped in af7ee733

---

## Problem

The reaper exposes `wait(pid)` and callers park on it. That forces two wait
layers and two defects:

```
ExecutionState::wait_process()   state.rs:183  OnceCell dedupe   ← wait layer 2
  └─ Reaper::wait(pid)           reaper.rs:223 oneshot (@af7ee733)           ← wait layer 1
       └─ reaped.remove(&pid)    reaper.rs:226 consume-once
```

- **Consume-once.** `wait` removes the cached exit and `deliver` removes the
  waiter, so the exit is handed out exactly once. A second `Wait` RPC for the
  same execution cannot be answered.
- **Fabricated `-1`.** `waiters.insert(pid, tx)` (reaper.rs:231 @af7ee733) discards the
  returned `Option<Sender>`, dropping any sender already registered for that
  pid. A second `wait` on a pid someone is still waiting on ends the *first*
  wait with `ExitStatus::Code(-1)` — a status no process ever returned.

`wait_process`'s `OnceCell` exists only to keep callers away from those edges.
Delete the pull API and both defects go with it.

## Research

No peer reaper exposes a generic wait-by-pid API. All of them deposit the exit
into a structure the caller already owns.

Line numbers are meaningless without a revision, so every row names its ref.

| Project @ ref | Shape | Where |
|---|---|---|
| containerd v2.0.0 | broadcast bus keyed by *channel*, not pid; receivers filter. Per-pid wait lives **above** the reaper, in the shim's `exitSubscribers` + a closed `waitBlock` | `pkg/sys/reaper/reaper_unix.go` — `Reap` :64, `subscribers` :91, `Monitor.Wait` :114 |
| kata-agent 3.32.0 | reaper stores `exit_code` then **drops the sender**; `WaitProcess` parks on `exit_rx.changed()` | `src/agent/src/signal.rs:95-96` |
| kata-agent 3.32.0 | *second* mechanism for concurrent waiters: an `exit_watchers` mpsc, pushed per waiter and broadcast on exit. `WaitProcess` is consume-once (`processes.remove`), so a sequential re-read gets `NOT_FOUND` | `src/agent/src/rpc.rs` — push :616, broadcast :654, remove :659 |
| gVisor release-20260714.0 | not a reaper: exit is immutable object state, so a wait on a stopped container returns instantly and repeatedly | `runsc/boot/loader.go:274`, `pkg/sentry/kernel/thread_group.go:151` |
| conmon v2.2.1 | pid-keyed callback table, plus the only cache-and-replay for an exit that beats registration. The re-readable artifact is the exit **file**, not that cache | `src/ctr_exit.c` lookup :78, cache :81-88; `src/conmon.c` replay :432-446, destroy :444 |
| tini v0.19.0 / dumb-init v1.2.5 / catatonit v0.2.1 | reap & discard; one distinguished pid as a function argument | `tini.c:541`, `dumb-init.c:102`, `catatonit.c:371` |
| go-reap @4e27870 (no tags) | push pid only, status discarded outright | `reap_unix.go:30` |
| s6 v2.15.1.0 | one supervisor process per child, so global-wait and specific-wait never share a process | `s6-svscan.c:359` |
| tokio 1.52.3 | per-child self-wait: SIGCHLD is a broadcast *wakeup*, each `Child` then calls `waitpid` on its own pid. No table. Structurally unavailable to a subreaper — an inherited orphan has no `Child` | `src/process/unix/reap.rs:68,89`, `unix/mod.rs:85` |

Kata is the direct analogue (Rust agent, in-VM, gRPC `WaitProcess`) and its
signalling is the piece worth taking: **sticky and level-triggered**. Dropping
the sender means an exit that lands before anyone waits is not lost — a late
waiter observes the closed channel and reads the stored code. An edge-triggered
notify would drop it.

Where we diverge is what the signal *is*. Kata signals by **closing** — dropping
the sender says "it ended" but carries no value, so the status has to be read
back off `Process.exit_code`, and a consume-once `processes.remove` (rpc.rs:659)
means a sequential re-read gets `NOT_FOUND`. Concurrent waiters then need a
whole second mechanism, the `exit_watchers` mpsc. We signal by **filling** —
`send_replace(Some(status))` leaves the watch open holding the value — so one
primitive serves both repeat reads and concurrent waiters.

Also not copied: kata's reaper holds the sandbox mutex across an output-drain
await (signal.rs:71-92), which lets one stalled copy task block every RPC.

## Design

The reaper stops answering questions and starts depositing results.

```
Reaper::run            (reaper.rs:167)  SIGCHLD loop     — the one waitpid(-1)
  └─ drain             (:188)
       ├─ sweep_exits  (:199)            under REAP_LOCK write side
       └─ deliver      (:260)            detach an already-settled slot,
                                         then slot(pid) → settled_at = now
                                         → tx.send_replace(Some(status))

Reaper::register       (:243)            claim at spawn → ExitSlot
ExecutionState::wait_process  (state.rs:191)  — the one place a caller parks
  └─ ExitSlot::get     (:79)             sticky, re-readable, N callers
```

`ExitSlot` wraps `tokio::sync::watch::channel(None)`. `deliver` deposits with
`tx.send_replace(Some(status))`; `get` is `wait_for(|v| v.is_some())` behind a
`borrow_and_update` fast path for an already-settled slot. Because `watch` is
level-triggered, ordering stops mattering: an exit deposited before any caller
is still there when the first caller arrives, and every later caller reads the
same value. That is what removes both defects at once.

**Deleted:** `Reaper::wait`, the `waiters` map, the oneshot, and
`wait_process`'s `OnceCell` dedupe.

**Kept, and why.** `expected` is gone — a slot's existence *is* the claim — but
`REAPED_TTL` stays. The reaper still cannot distinguish "an exit whose owner has
not registered yet" from "an orphan nobody will ever claim", so unclaimed strays
(libcontainer intermediates reparented here by `as_sibling`) must age out or the
map grows without bound. Pruning cannot strand a caller: `register` clears the
stray mark before it hands out a receiver, so a slot still marked stray has no
holder. `ExitSlot::get`'s error arm is unreachable for a separate reason — every
slot that can be dropped — a pruned stray, a recycled claim `register` replaces,
or a settled slot `deliver` detaches — is already settled, so the fast path
returns before `wait_for`. A slot is only ever removed after it has been filled.

**The recycle guard is the subtle part, and it needs BOTH sites.** `Slot` carries two timestamps, and
using the wrong one is a live bug — it was caught in review on this branch:

- `stray_since` answers *may this age out?* `None` once claimed, and claimed
  slots are exempt from pruning outright.
- `settled_at` answers *is this status ours?* `register` drops any slot that
  settled **before** `spawned_at`.

They are not interchangeable. `ExecutionRegistry` never evicts, so a claimed
slot outlives its execution holding a status until the guest exits, and pruning
skips it. Guarding on `stray_since` therefore lets a recycled pid sail straight
through, and `get`'s `borrow_and_update` fast path hands the new owner the dead
process's exit immediately. Only `settled_at` separates the two.

Both sites need it, and missing either is a real bug — each was caught in review
on this branch, one round apart:

- `register` drops a slot that settled **before** `spawned_at`: that status
  belongs to the pid's previous owner.
- `deliver` detaches an already-settled slot before depositing. We are the only
  writer and the kernel reaps a pid once per incarnation, so a settled slot can
  only belong to an owner already recycled away. Overwriting it instead would
  hand that owner's still-live `Wait` the new process's code. Detaching leaves
  it reading its own status from the receiver it already holds.

No peer has this guard. containerd documents the same hazard and declines it
(its shim comment says attribution is simply wrong on a recycled pid, pending
pidfd). systemd solves it properly with `PidRef` — pid + pidfd + inode — but
its own NEWS (v258 file, `CHANGES WITH 245` entry) says PID 1's `waitid(P_ALL)`
shape, which is ours, is the one place pidfd does not yet fit.

## Constraint that shapes the code

`REAP_LOCK` is a `std::sync::RwLock` (reaper.rs:55) and `RwLockReadGuard` is
`!Send`, so the fence **cannot** be held across an `.await`. That rules out
"hold the fence from before the spawn until the pid is registered", which would
otherwise close the registration window outright. The window stays closed the
way it is closed today: `register` claims the pid the moment the spawn
returns it, carrying the instant read *before* the spawn so a recycled pid's
stale exit is told apart from our own.

## Rejected: a pid-keyed `wait`

A later draft collapsed `register`/`ExitSlot` into `claim(pid)` + `wait(pid)` —
the reaper as a pure store, read by pid, no receiver handed out. Rejected
because a read that re-resolves by pid picks up the wrong incarnation once the
kernel recycles it:

```text
claim(701); deliver(701, code 1)   A exits; its status is stored
wait(701) → 1                      A's late Wait reads its own exit
deliver(701, code 2)               pid recycled; B exits before claiming
wait(701) → 2                      A reads again → B's exit  ✗ must stay 1
```

`a_recycled_deliver_does_not_overwrite_the_previous_owner` pins exactly this;
it passes today because the receiver a claim holds stays attached to the
detached slot. That receiver is what pins one process incarnation — the
in-process analogue of a pidfd — so any pid-keyed API that fixes the trace
re-grows a per-claim handle and lands back on `ExitSlot`.

## Verification

1. `reaper.rs` unit tests, run in-box (Linux-only): existing coverage adapted,
   plus new tests for the two fixed defects — a second `wait_process` on a
   finished execution returns the same status rather than `NOT_FOUND`/hanging,
   and two concurrent waiters both get the real status rather than one getting
   `-1`.
2. Both recycle guards are proven two-side. Reverting `register` to guard on
   `stray_since` makes `claiming_discards_an_exit_reaped_before_the_spawn` fail
   while its stray sibling still passes. Removing `deliver`'s detach makes
   `a_recycled_deliver_does_not_overwrite_the_previous_owner` fail with
   `left: Some(2) right: Some(1)` — the first owner reading the recycled
   process's code. The other two reproducers cannot be run
   against af7ee733 — they call `register`/`ExitSlot`, which do not exist there —
   so they were re-expressed against the old API to demonstrate red.
3. `make clippy` (its Darwin pass covers the Linux-gated guest modules via
   `--target aarch64-unknown-linux-musl`), `make fmt:check:rust`.
4. Integration: zygote, exec, init_semantics suites.

## Out of scope

- Replacing the `reap_fence` with spawn wrappers. The fence is opt-in and every
  future self-waiting call site must remember it — kata shipped the same mutex
  (`WAIT_PID_LOCKER`, container.rs:126) and a later refactor moved the code it
  guarded into `kata-sys-util/src/hooks.rs`, which waits without it, so today it
  is acquired in exactly one place and protects nothing. A spawn wrapper makes
  forgetting impossible. Worth doing; not in this change.
- The idmap userns path, still untested.
