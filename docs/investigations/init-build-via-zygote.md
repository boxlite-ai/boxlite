# Container Init Creation via the Zygote

**Date:** 2026-07-14
**Status:** Implemented 2026-07-21 (`ZygoteRequest::BuildInit`; deltas from the
design noted inline)
**Depends on:** run-command-semantics-fix.md (implemented; makes init the user's
command, raising the stakes of init-creation reliability)

---

## Problem

The guest promises "the zygote handles **all** clone3() calls in a
single-threaded context, avoiding musl's `__malloc_lock` deadlock"
(`src/guest/src/main.rs:103-105`), but container **init** creation violates it:
`Container::start` → `start::create_container_with_stdio`
(`src/guest/src/container/start.rs:204`) calls
`ContainerBuilder::…as_init(bundle).build()` **directly on the multi-threaded
tokio process**. `build()` performs libcontainer's clone3 dance
(main → intermediate → init) — the exact syscall-in-threaded-musl-process
pattern documented as Critical in `concurrent-exec-deadlock.md` (30-50% repro
under concurrent exec load). It hasn't bitten at boot only because box-start
runs under low thread contention; when it fires it is a permanent,
unreproducible box-start hang.

Precedent is unanimous — no runtime forks container processes from a threaded
daemon, and init is always the *first* thing routed through the safe-spawn
mechanism: runc (fresh `runc init` + pre-Go-runtime C constructor,
`nsenter/README`), kata agent (re-execs `current_exe()` with `init` arg —
exists specifically for container init), Chromium/Android (zygote forks *all*
renderers/apps), conmon/containerd-shim (fresh runc per op). BoxLite's
tenants-via-zygote + init-direct mix matches none of them.

## Design

Move only the **create/build** step into the zygote. The **start** step
(`start_container` — writes libcontainer's exec fifo, no clone) stays in the
guest main process.

### 1. Protocol: new request variant, same transport

```rust
// zygote.rs
enum ZygoteRequest {
    Build(BuildSpec),            // tenant (unchanged)
    BuildInit(InitBuildSpec),    // NEW
    Wait { pid: i32 },           // unchanged
}

struct InitBuildSpec {
    container_id: String,
    state_root: PathBuf,
    bundle_path: PathBuf,
}
```

- The three `InitStdioFds` (stdin read-end, stdout/stderr write-ends) travel
  via the existing SCM_RIGHTS channel (same `[RawFd; 3]` mechanism tenant
  builds use; same SAFETY contract — receiver owns them exclusively, must
  close on every error path).
- A separate variant (not a generalized `BuildSpec.kind`) because the inputs
  genuinely differ (bundle/state paths vs process spec) and the tenant path
  stays byte-identical — zero churn to the hot exec path.
- Response reuses `BuildResult::Spawned { pid } | Failed { error }`; the pid
  is init's pid from the built container state, so the caller can register
  the init exec-session without re-loading libcontainer state.

### 2. Zygote-side: `do_build_init`

Body = today's `create_container_with_stdio` verbatim (builder chain with
`.with_stdin/stdout/stderr(received fds).as_init(bundle).with_systemd(false)
.with_detach(true).build()`), executed in the zygote's single-threaded
context. libcontainer reaps its intermediate synchronously inside `build()`,
exactly as it does in the guest today — just in a fork-safe process.

### 3. Guest-side: `Container::start` calls the zygote client

`start.rs::create_container_with_stdio` becomes a thin client:
`ZYGOTE.get().build_init(spec, fds)`. Everything around it — bundle creation,
rootfs mounts, the immediate-exit `is_running` diagnostic, session
registration, the exit watcher — is unchanged.

> **As implemented:** no `spawn_blocking` — the callers are `Container::start`,
> a synchronous path that previously blocked right here for the in-place
> build; blocking on the IPC recv instead is the same latency in the same
> place. The design's spawn_blocking note assumed an async caller that does
> not exist. Also folded in: libcontainer's own `waitpid(intermediate)` inside
> `build()` used to run unfenced against the guest reaper's `waitpid(-1)`
> sweep (`start.rs` never took `reap_fence`); in the zygote there is no
> reaper, so that race is gone rather than fenced.

## Invariants this preserves (verified, must stay documented in code)

> **Superseded (2026-07-18):** the tenant reparenting unification landed first.
> `WaitVia` is gone — every session now waits via the guest-wide reaper
> (`crate::reaper`), and exec tenants are cloned `CLONE_PARENT` (`as_sibling`)
> so they reparent to guest main like init already did. Also corrected below:
> guest main is a regular process (empirically pid ~204), **not** the VM's PID 1
> — reparenting comes from `CLONE_PARENT`, not PID-1 adoption. When this
> init-build change lands there is no `WaitVia` to preserve.

1. **Wait routing.** ~~init reparents to guest main whether the clone3 happens
   in the guest or the zygote~~ — **falsified at implementation.** libcontainer
   clones init `CLONE_PARENT` off the intermediate
   (`container_intermediate_process.rs:196` @4b2f0e0), so init's parent is the
   process that calls `build()` — there is no reparenting step at all. Built in
   the zygote without more, init becomes the *zygote's* child, nobody reaps it,
   and the box exit code is lost (run_init_semantics went 1/9). The fix is
   `.as_sibling(true)` on the init build: the intermediate is then also cloned
   `CLONE_PARENT` (`container_main_process.rs:97-103`), parenting the whole
   chain to guest main — the identical pre-move topology, and the same contract
   tenant builds already use. The intermediate dies as a guest-main stray
   (the reaper's `stray_since` case) and libcontainer's `waitpid(intermediate)`
   tolerates the resulting ECHILD by design (`container_main_process.rs:288`).
2. **Mount visibility.** The zygote shares the guest's mount namespace (plain
   fork, no unshare), so bundle/rootfs mounts performed *after* zygote start
   (virtiofs, container rootfs) are visible to it. No path staging needed.
3. **Serialization is acceptable.** The zygote mutex serializes an init build
   (~tens of ms) against exec builds; at box start no execs exist yet, and
   multi-container-per-box does not exist. No measurable latency change
   expected — assert via existing perf-sensitive boot logs if questioned.

## Verification

This is a **race-hardening refactor with intentionally identical behavior** —
the honest verification is equivalence plus mechanism proof, not a new failing
test (the race it closes reproduces at ~boot-time probabilities we cannot
practically trigger on demand; stated per the reproduce-before-fix rule rather
than papered over):

1. Full existing suites green: the 56 CLI integration tests exercise init
   creation on every box start; guest unit tests; `make clippy`.
2. Mechanism proof: zygote logs the init build (`container_id`, returned pid);
   one integration assertion greps the guest console for the marker on a
   normal `run`, proving the path is actually taken (kills the "refactor
   silently bypassed" failure mode).
3. Fd-leak check on the error path: force one failing init build (bogus
   bundle) and assert the zygote's fd table doesn't grow (existing test
   pattern in zygote.rs's test module).

## Alternatives considered (recorded for the follow-up discussion)

- **Parentage unification via deliberate orphaning** (preferred future shape,
  PR #3 candidate): the zygote builds each tenant inside a disposable forked
  intermediate that reports `{pid | error}` over a pipe and exits; the tenant
  orphans and reparents to guest PID 1 — the same rule init already follows.
  Guest becomes the parent of everything; `WaitVia` collapses to `Direct` and
  the Wait IPC polling loop is deleted. Costs that make it its own PR: a
  zygote↔intermediate report protocol, and it forces the guest-PID-1 reaping
  strategy design (a naive `waitpid(-1)` stray-reaper steals statuses from
  targeted waits; needs a single wait-dispatcher or `waitid(WNOWAIT)`).
  `setsid` is optional session hygiene here, not the mechanism — reparenting
  comes from the intermediate's exit.
- **`CLONE_PARENT` on the tenant clone** (IMPLEMENTED 2026-07-18): youki exposes
  this as `TenantContainerBuilder::as_sibling(true)` — no libcontainer patch
  needed, and the feared `CLONE_NEWPID` edge rule does not apply (the flag
  governs the *intermediate* clone, which carries no new pid-ns). Empirically the
  tenant reparents to guest main (PPid == guest-main pid). This shipped for the
  tenant unification; deliberate orphaning was not needed.
- **Kata-style re-exec of the agent per container**: rejected — a second
  spawn mechanism beside the existing zygote.
- **Zygote push-reaping (conmon-style exit events)** — if wait latency ever
  matters before PR #3: zygote reaps on SIGCHLD and pushes `{pid, status}`
  events; removes polling without changing parentage.

## Out of scope (explicit)

- **Init-TTY** (console socket for init) — separate follow-up; note the
  zygote's tenant console-socket machinery makes it straightforward after
  this lands.
- **Kata-style re-exec** as an alternative mechanism — rejected: the zygote
  already exists and is the Chromium-precedented shape; two spawn mechanisms
  is strictly worse than one.
- Subreaper changes; multi-container boxes.

## Open questions — resolved at implementation

1. Return init pid from the zygote vs re-load libcontainer state — **both,
   half each**: the wire carries the pid (`BuildResult::Spawned{pid}`, read
   from the built container state zygote-side) and the client logs it, but
   `Container::init_pid()` still loads state on demand. Threading the returned
   pid through `Container` would touch lifecycle + service for an optimization
   nobody measured; deferred.
2. Grep-the-log accepted: `test_init_build_routes_through_zygote`
   (zygote_integration.rs) asserts the `[zygote] init build:` marker in the
   box's `logs/console.log` — the file `krun_set_console_output` writes; the
   guest console does *not* land in shim.stderr.
