# Container Init Creation via the Zygote

**Date:** 2026-07-14
**Status:** Design — pending review, no code changed
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
`ZYGOTE.get().build_init(spec, fds)` via `spawn_blocking` (mirror the tenant
build call pattern in `command.rs`). Everything around it — bundle creation,
rootfs mounts, the immediate-exit `is_running` diagnostic, session
registration, the exit watcher — is unchanged.

## Invariants this preserves (verified, must stay documented in code)

1. **Wait routing is UNCHANGED — `WaitVia::Direct` stays.** The zygote sets no
   `PR_SET_CHILD_SUBREAPER`; libcontainer's intermediate exits inside
   `build()`, so init reparents to the VM's PID 1 (boxlite-guest main) whether
   the clone3 happened in the guest or in the zygote. Couple these facts in a
   comment at `new_init_session` (state.rs): *if the zygote ever becomes a
   subreaper, init's parent flips to the zygote and this route must flip to
   `WaitVia::Zygote` in the same change.*
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
- **`CLONE_PARENT` on the tenant clone**: same unification, but requires
  patching vendored libcontainer's clone flags and inherits clone-flag edge
  rules (`EINVAL` with `CLONE_NEWPID`, pid-ns-init callers). Strictly worse
  than deliberate orphaning; rejected.
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

## Open questions

1. Return init pid from the zygote (proposed) vs keep re-loading libcontainer
   state in the guest — proposed saves a state load and matches
   `BuildResult::Spawned{pid}`'s existing shape.
2. Is the grep-the-log mechanism assertion (Verification #2) acceptable test
   style here, or prefer exposing a counter via the metrics surface?
