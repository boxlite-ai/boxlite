# Exec Timeout Orphan: Root Cause Analysis

**Date:** 2026-09-07
**Branch:** `main`
**Severity:** High — a documented hard deadline does not bound the workload; orphans retain guest CPU/memory, and REST callers hang indefinitely
**Reproduction rate:** 100% whenever the exec leader forks instead of exec'ing

---

## Conclusion

### Root Cause: the timeout watcher signals the captured leader PID, not its process group

`start_timeout_watcher` terminates an over-deadline exec through
`TimeoutTarget::signal_if_live`, which called
`ProcessInstance::signal(signal, /* process_group */ false)`. That argument
restricts the signal to the single PID captured at spawn.

When the workload is a shell that forks — `sh -c "sleep 300"` on a `dash`-family
`/bin/sh`, or anything written as `cmd &` — the captured leader is the *shell*
and the real work runs in its child. SIGTERM then reaps the shell only. The
child is reparented to init and runs on, unbounded.

The SIGKILL escalation cannot recover, and fails **silently**:

- `ProcessInstance::signal` opens with a start-time guard,
  `if !self.is_current() { return Ok(false); }`. Once the leader is reaped that
  guard is false forever, so the escalation never reaches `kill()`.
- The watcher logs only on the `Ok(true)` arm. `Ok(false)` was routed to
  `info!("exited within grace after SIGTERM")` — which reads as success. A
  failed escalation and a clean exit are indistinguishable in the guest log.

The orphan also inherits the exec's stdout/stderr **pipe write ends**. Those
pipes therefore never reach EOF, the runner's stream pump never observes
closure, the exit frame is never delivered, and `Execution::wait()` never
resolves. One defect, two symptoms.

### Deadlock Call Graph

```
BEFORE (defective)

guest: spawn_execution()                      container: PID 2 = `sh`, PGID 2
  ↓                                                      PID 3 = `sleep 300`
ProcessInstance::capture(leader_pid = 2)  ── captures PID 2 + its start_time
  ↓
start_timeout_watcher(target, 2s)
  ↓
sleep(2s)
  ↓
signal_if_live(SIGTERM)
  → ProcessInstance::signal(SIGTERM, process_group = false)   ← BUG: leader only
      → is_current() = true
      → kill(2, SIGTERM)                       ✔ shell dies
                                               ✘ PID 3 survives, reparented to init
  ↓
sleep(TIMEOUT_GRACE = 2s)
  ↓
signal_if_live(SIGKILL)
  → ProcessInstance::signal(SIGKILL, false)
      → is_current() = false                   ← leader already reaped
      → return Ok(false)                       ← no kill(), and no log
  ↓
watcher task ends

  PID 3 `sleep 300` alive past its deadline, PPID = 1,
  still holding fd 1 → pipe:[83], fd 2 → pipe:[84]
      ↓
  runner stream pump never sees EOF
      ↓
  exit frame never sent over WS
      ↓
  SDK Execution::wait() hangs forever


AFTER (fixed)

guest: spawn_execution()                      container: PID 2 = `sh`, PGID 2
  ↓                                                      PID 3 = `sleep 300`
ProcessInstance::capture(2)   ← start_time AND pgid read together, here
  → getpgid(2) == 2  ⇒  group = Some(Pid(2))
        ↑ the only point that runs before the reaper can win. Re-deriving
          the group later — at TimeoutTarget::new, or at signal time —
          reports "no group" for a leader already reaped, silently
          restoring leader-only delivery
  ↓
TimeoutTarget::new(process)   → group carried over, no /proc lookup
  ↓
start_timeout_watcher(target, 2s)
  ↓
sleep(2s)
  ↓
signal_job(SIGTERM)
  → signal_process_group(2, SIGTERM) ⇒ kill(-2, SIGTERM)   ✔ shell AND child
  ↓
sleep(TIMEOUT_GRACE = 2s)
  ↓
signal_job(SIGKILL)                        ← same captured group, no re-lookup
  → signal_process_group(2, SIGKILL) ⇒ kill(-2, SIGKILL)
      → survivors killed even though the leader is gone
      → ESRCH ⇒ Ok(false) when the group is already empty
```

### Why the escalation was silent

| Watcher arm | Meaning before the fix                              | Logged as                            |
|-------------|-----------------------------------------------------|--------------------------------------|
| `Ok(true)`  | SIGKILL delivered                                   | `warn!` "SIGKILL after grace expired" |
| `Ok(false)` | **either** everything exited **or** the guard refused | `info!` "exited within grace"        |
| `Err(_)`    | `kill()` itself failed                              | `warn!` "timeout SIGKILL failed"      |

The `Ok(false)` arm conflates a clean exit with a refused escalation. In every
reproduction the guest log showed `SIGTERM on timeout` at +2.004s and then
nothing at all — the failure left no trace.

### Why the existing tests never caught it

| Test | Workload | Forks? | Verdict |
|------|----------|--------|---------|
| `exec_options.rs::test_timeout_kills_long_command` | `BoxCommand::new("sleep").arg("60")` | **No** — no shell at all; the leader *is* `sleep` | passes; never exercises the orphan path |
| `exec_options.rs::test_timeout_kills_sigalrm_ignoring_process` | `sh -c "trap '' ALRM; sleep 15"` | Yes | passes — it traps only ALRM, so SIGTERM reaps the shell promptly and both assertions (`exit_code != 0`, `elapsed < 8s`) hold. It never checks whether the *child* died. |
| `timeout.rs::tests::timeout_target_signals_its_live_leader` | `/bin/sleep 30`, spawned directly | **No** | passes; asserts leader-only delivery, which is the very behaviour at fault |

Every existing test observes the **leader's** fate. None observes the child's.
That is the coverage gap, not an oversight in any single assertion.

The sharper point: the primitive was already there and already tested.
`process_instance.rs` ships
`process_group_signal_reaches_a_background_descendant` — a unit test that
covers exactly this orphan scenario at the `ProcessInstance` level — alongside
`process_group_signal_refuses_a_non_leader`. Both predate this investigation
and both pass. The group-signalling capability was built, guarded, and then
simply never wired into the timeout watcher, which kept passing `false`. No
test asserted *which* mode the watcher chose, so the gap sat between two
well-tested layers.

### Why the first reproducer attempt was a false negative

An initial local reproducer using `sh -c "sleep 300"` on the alpine test image
**passed**. Cause: busybox `ash` and `dash` both optimise a single trailing
command by `exec`ing into it rather than forking, so the leader *becomes*
`sleep` and SIGTERM lands on the right process. The debian-based
`boxlite-agent-base` image used by the REST suite forks in the same expression.

A reproducer must force the fork explicitly — `sh -c "sleep 300 & wait"` — and
assert the precondition that a child actually exists, otherwise a pass is
vacuous.

| Workload | Forks? | Reproduces |
|----------|--------|------------|
| `exec("sleep", ["300"])` | No | ✘ |
| `sh -c "sleep 300"` on alpine / busybox | No (exec-optimised) | ✘ |
| `sh -c "sleep 300"` on agent-base / dash | Yes | ✔ |
| `sh -c "sleep 300 & wait"` | Yes (forced by `&`) | ✔ any image |

### Scope: guest-wide, not REST-specific

The e2e symptom is a hang, which initially suggested a REST stream-pump problem
— and `test_exec_timeout.py`'s own module docstring already blames the REST
pump for a related `drain()` issue. That framing is wrong for this defect:

- The **deadline bypass** reproduces on the local FFI path with no cloud stack
  (`make test:integration:rust`), so it affects every caller.
- The **`wait()` hang** is a REST-path amplification: the local path resolves
  `wait()` from the reaper's leader-exit slot, while the runner gates its exit
  frame on stream closure, which the orphan holds open.

### Fix Options

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **A** | Signal the process group in the watcher | Bounds the whole job; one-line intent | Refuses when the leader leads no group — silently disables the timeout on the `spawn_with_pipes` path |
| **B** | A + resolve the pgid once while the leader lives, reuse it for the escalation | Escalation survives the leader's death | Slightly more state in the watcher |
| **C** | B + fall back to leader-only when no group is led | No regression on executors that leave the workload in an inherited group | Fallback keeps the old hole where it already existed |
| **D** | `setpgid(0,0)` in `spawn_with_pipes` so every exec leads a group | Closes the hole on the default `GuestExecutor` path too | Changes signal-delivery semantics for the non-container executor |

Applied: **C + D**.

Option A alone is a *regression*: `ProcessInstance::signal(_, true)` requires
`getpgid(pid) == pid` and returns `Ok(false)` otherwise. The container executor
satisfies this (measured below), but `GuestExecutor::spawn_with_pipes` performed
no `setpgid`, so its execs inherited the guest's group. Flipping the flag alone
would have turned the timeout into a no-op there — worse than the bug being
fixed.

C alone is *incomplete*: the fallback keeps the old leader-only behaviour
exactly where the hole already was. `GuestExecutor` is the **default** executor
when `BOXLITE_EXECUTOR` is unset (`mod.rs:542`), so a forking workload on that
path would still outlive its deadline. D closes it, which is why both ship
together.

**When the group is resolved matters as much as signalling it.** Any lookup
that runs later than the spawn itself can be beaten by the reaper: a leader that
exits *before* its own deadline — `sh -c "cmd &"` returns as soon as it has
forked — leaves no `/proc` entry, so `getpgid` reports no group and the
survivors quietly fall back to leader-only delivery. `TimeoutTarget::new` is
already too late; it runs after `spawn_with_executor`, `reaper.register`, and
`registry.publish`, each an await the exit can win.

The pgid is therefore read inside `ProcessInstance::capture`, in the same breath
as the start time and before any of those awaits, and carried as a field from
there. Every later consumer reads that field instead of asking `/proc` again.

The leader-only arm survives as a guard, not a supported mode: all three spawn
paths now lead a group (container runtime, PTY via `setsid`, pipes via
`setpgid`), so it is reached only when the process never led one at all.

### The Fix

`src/guest/src/service/exec/process_instance.rs`

```rust
// capture() reads start_time and pgid together, before any await the reaper
// can win; own_process_group() then just returns the recorded field
pub(super) fn own_process_group(&self) -> Option<Pid>

// :92  signal a group by a pgid captured earlier — deliberately NO start-time
//      guard, because the leader is allowed to be gone by now
pub(super) fn signal_process_group(group: Pid, signal: Signal) -> Result<bool, Errno>
```

`src/guest/src/service/exec/timeout.rs`

```rust
// :40  TimeoutTarget::new()  — carries the pgid captured at spawn
// :59  TimeoutTarget::signal_job(signal) — captured group, else leader
// :85  signal_job(SIGTERM)
// :104 signal_job(SIGKILL)   same captured group, never re-resolved
```

`src/guest/src/service/exec/executor.rs`

```rust
// spawn_with_pipes — pre_exec setpgid(0,0), so the default GuestExecutor path
// leads a group like the PTY branch (setsid) and the container runtime already do
```

`src/guest/src/service/exec/state.rs`

```rust
// ExecutionState captures the pgid at spawn and uses it for process_group
// kills, so the SSH bridge's SIGHUP/SIGTERM→SIGKILL escalation still reaches
// survivors after the graceful stage has already reaped the leader
```

`src/guest/src/service/exec/mod.rs`

```rust
// spawn_execution warns when a captured execution turns out to lead no process
// group: every spawn path is meant to provide one, so landing there means kills
// reach the leader alone and a forking workload can outlive its deadline
```

`src/guest/src/service/exec/registry.rs`

```rust
// observe_terminal cancels at leader exit only when no live group remains.
// It previously cancelled the moment the leader's exit slot resolved, which
// for `sh -c "cmd &"` is immediately -- handing the survivor an unbounded
// lifetime no matter how the signalling below is written.
```

That last one decides whether any of the rest is reachable. Capturing the group
and addressing it correctly is inert if the watcher is aborted before it ever
fires, and for every reserved (non-SSH) exec the terminal observer did exactly
that.

### The same-shape sibling, fixed in the same pass

`ssh/bridge.rs::terminate_process_group` escalates SIGHUP/SIGTERM and then
SIGKILL through `kill_execution(..., process_group = true)`. That routed into
`ProcessInstance::signal(_, true)`, whose start-time guard returns `Ok(false)`
once the leader is reaped — so the graceful stage could kill the leader and the
forced stage would then silently refuse, leaving the same survivors behind.

`ExecutionState` now captures the pgid at construction and addresses it directly
for group kills, which fixes the SSH bridge and the explicit `KillRequest`
group path together. `signal_owned_process_if_current` is untouched: it passes
`process_group = false` deliberately, so registry shutdown keeps its existing
leader-only semantics.

### The captured pgid must not outlive its group

Dropping the start-time guard on the group path buys reach past a dead leader,
and costs the guard that made the identity unambiguous. The kernel keeps a PID
reserved only while some process still references it as a process group ID —
so a captured pgid names our group exactly as long as that group is non-empty.
Once the last member exits, the number is free to be re-allocated, and a holder
that still signals it can land SIGTERM/SIGKILL on an unrelated guest process
group.

A single liveness check immediately before signalling does not fix this: a
re-allocated group is just as "alive" as ours was. What does fix it is never
holding the pgid across an unobserved window — so the watcher polls
(`GROUP_LIVENESS_POLL`, 100 ms) instead of sleeping straight through its
deadline and its grace, and retires itself the moment the group is empty.
Exposure drops from the whole deadline to one interval.

Group emptiness is the right condition because it is the *only* one that
answers both questions at once: nothing of the job is left to signal, and the
captured pgid has stopped naming it. Two weaker signals were tried and are
wrong:

| Candidate | Why it fails |
|---|---|
| The leader's own exit | `sh -c "cmd &"` returns immediately; the children run on |
| Output EOF | proves the exec's *pipes* were released, not that the group ended — `sh -c "cmd >/dev/null 2>&1 &"` reaches EOF at leader exit with the child still running |

Every path that retires a deadline has to respect that condition, not just the
terminal observer. `ExecutionState::release_resources` — reached by
`prune_inner` after `RETAIN_GRACE` and by the SSH `release_ephemeral` once
output reaches EOF — aborted the watcher unconditionally, which strands
survivors of any exec whose deadline outlives those points. It now aborts only
when the group is already empty. `observe_terminal` likewise cancels at leader
exit only when no live group remains; otherwise the watcher keeps its own clock.

Retirement is bounded; *use* of a captured pgid is not, and this fix does not
pretend otherwise. `ExecutionState::signal_if_current` addresses the group with
no identity guard, because no cheap one exists — an empty group already reports
ESRCH without help, and a re-allocated pgid reads as alive, so a liveness probe
there is inert. The entry's `released` flag does not supply the guarantee
either: `release_resources` sets it whenever resources are reclaimed, not when
the group drains.

So the SSH termination ladder and the `process_group` kill RPC can, in
principle, signal an unrelated group — if the job's group emptied and the
kernel re-allocated that number before the call. Reaching orphans at all
requires addressing a group without proof of identity, and the residual risk
needs the guest to exhaust its PID space inside the call window. It is recorded
here rather than papered over with a check that does not check anything.

---

## Debug Process

### Step 1: Observe the e2e failures

**Tool:** `pytest` against the local REST stack

```bash
cd apps/e2e && python3 -m pytest cases/test_exec_timeout.py -v
```

**Observation:** Both cases fail at `asyncio.wait_for(ex.wait(), timeout=45)`
with `TimeoutError`, after ~45s, despite `timeout_secs=2.0`. Re-running
produced the identical pair — stable, not flaky.

**Conclusion:** Either the timeout never fires, or it fires and `wait()` fails
to observe it. The failure signal alone cannot distinguish these.

---

### Step 2: Determine whether the process is killed at all

**Tool:** direct SDK probe polling the box's own process table

Started `sh -c "sleep 300"` with `timeout_secs=2.0`, then repeatedly exec'd
`ps -eo pid,args | grep -c '[s]leep 300'` in the same box.

```
+ 2.1s  'sleep 300' count='1'
+ 4.2s  'sleep 300' count='1'
...
+16.1s  'sleep 300' count='1'
wait() still pending at +26.1s
```

**Observation:** The workload is alive 16s after a 2s deadline.

**Conclusion:** This is not a `wait()`/stream-pump bug. The deadline is not
being enforced. Re-scoped the investigation to the kill path.

---

### Step 3: Prove the timeout parameter reaches the runner

**Tool:** `tcpdump` on loopback, filtered to POST on the runner port

```bash
tcpdump -i lo -s 0 -A -l \
  "tcp port 8080 and tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x504f5354"
```

**Observation:**

```
{"command":"sh","args":["-c","sleep 300"],"timeout_seconds":2,"tty":false}
POST /v1/boxes/dLDhdvqwz4sU/exec   ×18
```

**Conclusion:** SDK → API → runner delivers `timeout_seconds` intact. The API
is an `@All(':boxId/exec')` raw passthrough and the global `ValidationPipe` runs
with `transform: true` only — no `whitelist`, so no field stripping. Every hop
above the runner is exonerated.

---

### Step 4: Prove the watcher fires inside the guest

**Tool:** per-box guest console log

```bash
RECENT=$(ls -t /var/lib/boxlite/boxes/*/logs/console.log | head -1)
grep -aE "spawn completed|SIGTERM on timeout|SIGKILL after grace" "$RECENT" \
  | sed 's/\x1b\[[0-9;]*m//g'
```

**Observation:**

```
10:27:53.299591  exec: spawn completed  program=sh
10:27:55.303593  SIGTERM on timeout; grace before SIGKILL  grace_ms=2000
```

`SIGTERM on timeout` lands at +2.004s — exactly on the deadline. No
`SIGKILL after grace expired` line ever appears, and no
`failed to capture process identity` warning either.

**Conclusion:** The watcher runs and stage 1 fires on time. Stage 2 does not
report anything at all — the escalation is being skipped, not failing loudly.

---

### Step 5: Inspect the process tree in the surviving box

**Tool:** SDK exec of `ps` against a box kept alive with `auto_remove=False`

**Observation:**

```
 PID PPID STAT COMMAND
   1    0 Ss   sleep infinity       ← container init
   3    1 S    sleep 300            ← PPID=1: reparented
   4    0 Ss   sh -c ps -eo pid,ppid,stat,args
```

The `sh` leader is gone; `sleep 300` has been adopted by init.

**Conclusion:** SIGTERM killed the shell. Its forked child was orphaned rather
than terminated — the leader-only signal is the defect.

---

### Step 6: Explain the `wait()` hang

**Tool:** `/proc/<pid>/fd` inside the box

**Observation:**

```
lr-x------ 0 -> pipe:[82]
l-wx------ 1 -> pipe:[83]
l-wx------ 2 -> pipe:[84]
```

**Conclusion:** The orphan still holds the exec's stdout/stderr write ends, so
those pipes never reach EOF. The runner's stream pump waits on a closure that
can never come, and the exit frame is never delivered. The hang is a downstream
consequence of the orphan, not an independent bug.

---

### Step 7: Locate the defective argument

**Tool:** source reading, `src/guest/src/service/exec/`

```
timeout.rs:35        process.signal(signal, false)      ← the only production call site
process_instance.rs:20   fn signal(&self, signal, process_group: bool)
process_instance.rs:21     if !self.is_current() { return Ok(false); }   ← blocks escalation
process_instance.rs:33     else { self.pid }                             ← leader only
```

Cross-checked every other `.signal(` call site: `state.rs:876` and
`process_instance.rs:149/201/207` pass `true`, but all of them are tests. The
explicit kill API exposes `process_group` as a caller-supplied field
(`mod.rs:272`, from `KillRequest`). `timeout.rs:35` was the sole production
path hard-coding `false`.

**Conclusion:** Single-site defect in the timeout path.

---

### Step 8: Check whether group signalling is even viable

**Tool:** SDK probe printing `pid,ppid,pgid,sid`

`ProcessInstance::signal(_, true)` refuses unless `getpgid(pid) == pid`, so this
had to be measured before changing the flag.

**Observation:**

```
 PID PPID PGID  SID COMMAND
   2    0    2    2  sh -c sleep 300 & wait     ← PGID == PID, and a session leader
   3    2    2    2  sleep 300                  ← same group
```

**Conclusion:** The container executor already places each exec in its own
process group and session, so group signalling will be accepted. But
`spawn_with_pipes` (the `GuestExecutor` path) had no `pre_exec` and performed
no `setpgid` — only the PTY branch called `setsid` (`executor.rs:240`). A bare
flag flip would have silently disabled the timeout there.

That path is the **default** executor, not a corner case (`mod.rs:542` selects
`GuestExecutor` when `BOXLITE_EXECUTOR` is unset), so a fallback alone would
have left the original hole intact wherever it already was. The fix therefore
does both: give `spawn_with_pipes` its own `setpgid`, and keep a leader-only
fallback as a guard for the case where the leader exits before the first
signal.

---

### Step 9: Two-sided verification

**Tool:** `make test:integration:rust`, per the repository's reproducer rule

The integration reproducers drive only the SDK, so they still compile against a
fully reverted guest — no compatibility adapter is needed and the revert can be
total rather than partial.

Step 1 — **every** production file reverted to HEAD, only the tests kept:

```
$ git restore --source=HEAD --staged --worktree -- \
    src/guest/src/service/exec/{timeout,process_instance,executor,state,registry,mod}.rs
$ git status --short src/guest src/boxlite/tests
MM src/boxlite/tests/exec_options.rs

$ grep -n "process.signal(signal, false)" src/guest/src/service/exec/timeout.rs
35:            Some(process) => process.signal(signal, false),
$ sed -n '544p' src/guest/src/service/exec/registry.rs
            state.cancel_timeout_task().await;
$ grep -c own_process_group src/guest/src/service/exec/process_instance.rs
0
```

Both reproducers fail, each for its own shape of the defect:

```
test_timeout_kills_forked_child_not_just_leader
  FAILED — exec timeout left 1 orphaned `sleep 300` process(es) alive 6s
           after a 2s deadline: the watcher signalled only the shell leader

test_timeout_survives_a_leader_that_exits_before_its_deadline
  FAILED — exec timeout left 1 orphaned `sleep 300` process(es) alive 6s
           after a 2s deadline whose leader had already exited
```

Step 2 — fix restored in full:

```
make test:integration:rust FILTER=test_timeout
  4 tests run: 4 passed, 277 skipped
```

**Conclusion:** Both reproducers fail for the original defect against a wholly
unmodified guest, and pass only with the fix present. The second one also pins
the `observe_terminal` change: without it the watcher is cancelled at leader
exit and the captured group is never signalled.

---

## Environment Details

| Component     | Detail                                                     |
|---------------|------------------------------------------------------------|
| Platform      | Ubuntu 24.04 on WSL2, x86_64, `/dev/kvm`                   |
| Guest binary  | `boxlite-guest`, static-pie, musl                          |
| Target triple | `x86_64-unknown-linux-musl`                                |
| Local test image | alpine (`common::alpine_opts()`), busybox `ash`         |
| REST test image  | `ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0`, dash    |
| Cloud stack   | `apps/e2e` — API `:3000`, runner `:8080`, registry `:5000` |
| Exec path     | `ContainerExecutor` (libcontainer), non-TTY, pipes          |
| Deadline      | `timeout_secs = 2.0`, `TIMEOUT_GRACE = 2s`                  |

## Timeout Signal Path

```
SDK BoxCommand::timeout(Duration)
  ↓ rest/types.rs:621        timeout_seconds = cmd.timeout.map(as_secs_f64)
API @All(':boxId/exec')      raw passthrough, body untouched
  ↓
runner boxlite_exec.go:73    startOpts.Timeout = TimeoutSeconds * time.Second
  ↓ exec_manager.go:378      ExecutionOptions{ Timeout: opts.Timeout }
Go SDK exec.go:241           BoxliteCommand{ timeout_secs: C.double(...) }
  ↓
C FFI command.rs:56          if timeout_secs != 0.0 → box_cmd.timeout_seconds()
  ↓
core portal exec.rs:282      timeout_ms = command.timeout.as_millis()
  ↓
guest exec/mod.rs:462        if req.timeout_ms > 0 → start_timeout_watcher(...)
  ↓
guest timeout.rs             ← DEFECT WAS HERE; every hop above is intact
```

## Test Results Summary

| Suite | Before fix | After fix |
|-------|-----------|-----------|
| `exec_options::test_timeout_kills_forked_child_not_just_leader` (new) | 1 failed | 1 passed (32.71s) |
| `make test:integration:rust FILTER=timeout` | — | 5 passed, 275 skipped |
| `make test:unit:guest` | — | 336 passed, 4 skipped |
| `apps/e2e cases/test_exec_timeout.py` | 2 failed (~45s each, `TimeoutError`) | 2 passed (9.18s total) |
| Standalone REST reproducer | orphan alive at +6.1s, `wait()` hanging | `NOT reproduced`, `wait()` returned |

Post-fix process tree in the reproducer, showing the mechanism inverted:

```
before:  3    1 S    sleep 300             ← alive, orphaned, holding the pipes
after:   3    1 Z    [sleep] <defunct>     ← killed by the group signal, awaiting reap
```

## Tests Added

| Test | Level | Guards |
|------|-------|--------|
| `exec_options.rs::test_timeout_kills_forked_child_not_just_leader` | integration (VM) | a forked child is dead 6s after a 2s deadline; asserts the fork precondition first so a pass cannot be vacuous |
| `timeout.rs::tests::timeout_target_signals_the_whole_group_of_a_forking_leader` | guest unit | group SIGKILL reaches a background descendant; leader is a real `setpgid` group leader |
| `timeout.rs::tests::timeout_target_signals_its_live_leader` | guest unit (updated) | now asserts `process_group().is_none()` first, pinning the leader-only fallback explicitly |
| `executor.rs::tests::spawn_with_pipes_makes_the_child_a_process_group_leader` | guest unit | the default `GuestExecutor` path leaves each exec leading its own group, so a later `pre_exec` removal cannot silently reopen the hole |
| `timeout.rs::tests::timeout_target_still_reaches_a_group_whose_leader_already_exited` | guest unit | a leader that exits before its deadline still loses its group; pins pgid capture to construction, not signal time |
| `exec_options.rs::test_timeout_survives_a_leader_that_exits_before_its_deadline` | integration (VM) | the end-to-end leader-exits-early shape; the only test that fails if `observe_terminal` retires the deadline at leader exit |
| `state.rs::tests::group_kill_reaches_members_that_outlived_the_leader` | guest unit | the externally reachable `KillRequest(process_group = true)` path delivers after the leader is reaped, pinning the dropped start-time guard |
| `process_instance.rs::tests::captured_process_group_outlives_the_leaders_proc_entry` | guest unit | the recorded pgid survives the leader's `/proc` entry, so no later consumer can be beaten by the reaper |
| `registry.rs::tests::terminal_observer_keeps_the_deadline_while_the_group_lives` | guest unit | neither the leader's exit nor output EOF retires a deadline whose group is still live |
| `timeout.rs::tests::timeout_watcher_retires_itself_when_the_group_empties` | guest unit | the watcher stops on its own once the group is empty, so a captured pgid is never held across a window where it could be re-allocated |
| `state.rs::tests::release_keeps_the_deadline_while_the_group_lives` | guest unit | prune and the SSH release path do not retire a deadline whose group still has members |
| `process_instance.rs::tests::capture_of_a_dead_pid_reports_failure` | guest unit | a vanished process captures nothing, so a failed read is never reported as "leads no group" |

## Diagnostic Techniques Reference

| Technique | Source | What it reveals |
|-----------|--------|-----------------|
| `tcpdump -A` with a POST-matching `tcp[]` filter | libpcap | Whether a field survives every proxy hop, without instrumenting code |
| `ps -eo pid,ppid,stat,args` inside the box | busybox/procps | Reparenting to init (`PPID=1`) — the orphan signature |
| `ps -eo pid,ppid,pgid,sid` | procps | Whether a process leads its own group; decides if group signalling is viable |
| `ls -l /proc/<pid>/fd` | procfs | Which pipes a survivor still holds open, explaining a stalled EOF |
| `/var/lib/boxlite/boxes/*/logs/console.log` | BoxLite | Guest-side `tracing` output; shows which watcher stage ran |
| `strings <wheel>.so \| grep <field>` | binutils | Whether an installed prebuilt SDK still speaks a given wire field |
| `cargo nextest list -p <crate>` | nextest | Confirm a new test is actually collected, not silently filtered |

## Files Read During Investigation

```
src/guest/src/service/exec/timeout.rs                (MODIFIED — fix + tests)
src/guest/src/service/exec/process_instance.rs       (MODIFIED — group helpers)
src/guest/src/service/exec/mod.rs                    (MODIFIED — no-group warning; watcher construction)
src/guest/src/service/exec/state.rs                  (other signal call sites)
src/guest/src/service/exec/executor.rs               (spawn_with_pipes / spawn_with_pty)
src/boxlite/src/litebox/exec.rs                      (BoxCommand::timeout)
src/boxlite/src/portal/interfaces/exec.rs            (timeout → timeout_ms)
src/boxlite/src/rest/types.rs                        (timeout_seconds serialisation)
src/boxlite/tests/exec_options.rs                    (MODIFIED — reproducer)
sdks/c/src/exec/command.rs                           (C FFI timeout_secs)
sdks/go/exec.go                                      (Go SDK → C command struct)
apps/runner/pkg/api/controllers/boxlite_exec.go      (TimeoutSeconds DTO)
apps/runner/pkg/boxlite/exec_manager.go              (StartOptions → ExecutionOptions)
apps/api/src/boxlite-rest/boxlite-proxy.controller.ts (raw exec passthrough)
apps/api/src/main.ts                                 (global ValidationPipe options)
apps/e2e/cases/test_exec_timeout.py                  (failing e2e cases)
```
