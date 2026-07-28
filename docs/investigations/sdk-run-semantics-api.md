# SDK API for Run-Command Semantics

**Date:** 2026-07-14
**Status:** Design — pending review
**Depends on:** run-command-semantics-fix.md (core implemented: `options.cmd`
= init, `attach()`/`attach_exec()`, init exit codes, box-stops-on-exit)

---

## Problem

PR 1 gave the core docker semantics, and almost none of it is reachable from
the SDKs. The one exception it ships: Python's `attach(execution_id=None)`
already takes the no-arg form (docker-py's shape), so a Python caller *can*
reach the main command — but has no way to make one, because `BoxOptions`
exposes neither `cmd` nor `tty`, and Node's `JsBoxOptions` exposes neither
either. Today's Python surface (Node mirrors it via napi):

- Raw layer: `Boxlite.create(BoxOptions) -> Box{exec, attach(execution_id=None),
  copy_in/out, stop, …}` — `BoxOptions` does not expose `cmd`/`entrypoint`/`tty`;
  there is no wait and no exit code anywhere.
- Facade layer: `SimpleBox` (+ codebox/browserbox/…) — pure boot-and-exec.

So an SDK user cannot express the exact scenario that motivated PR 1
(`run this image with THIS command as its main process; observe its exit`).

## Personas (this is the design driver)

| | A: sandbox (today's users) | B: docker-style (unlocked by PR 1) |
|---|---|---|
| Flow | boot once, exec many | run one command to completion / as the workload |
| Peers | E2B, Daytona (no run-command at all) | docker-py `containers.run`, testcontainers |
| Exit codes | **data** (agent frameworks branch on them) | **the result** |
| Compat | must stay byte-identical (agent-base daemon boxes) | new surface |

## Design (Python shown; Node mirrors naming in camelCase)

### 1. Options: thin parity (raw layer)

`BoxOptions` gains `cmd: list[str] | None` and `entrypoint: list[str] | None`
(plus `user`/`working_dir` passthrough if not already mapped). Semantics
documented once, as the docker matrix: *cmd replaces the image CMD; the image
ENTRYPOINT is preserved; the result is the container's init and the box stops
when it exits.*

### 2. Box: two additions (raw layer)

```python
box.attach() -> Execution             # main-command session (no-arg default)
box.attach(execution_id)              # exec-session reattach — UNCHANGED callers
await box.wait() -> BoxResult         # blocks until the box stops
```

- **One SDK method, optional selector** (docker-py/dockerode shape; and
  containerd's wire uses the same idea — empty `exec_id` targets init).
  Existing positional `attach(id)` callers keep working; the no-arg call is
  the main-process attach. No deprecation cycle needed.
- **Rust core: two methods** (moby Go-client shape) — **done in PR 1** (the
  old names were never released): `attach_init()` → `attach()` (main),
  WS-reconnect `attach(execution_id)` → `attach_exec(execution_id)`. The wire
  underneath is kata's: the host sets `ContainerInitRequest.execution_id =
  container_id`, so `attach()` addresses init with the id the host itself
  declared.
  `attach(Option<&str>)` was considered and rejected: `attach(None)` is an
  opaque mode-selector at Rust call sites, and split methods give honest
  per-backend defaults (local: `attach` ✓ / `attach_exec` unsupported;
  REST: the reverse, until the cloud grows main-attach).
- "init" is runtime-internal vocabulary — it appears in no peer's public
  API; the naming rule everywhere is *unqualified `attach` on the box
  receiver, qualification on the exec variant, selector optionality in the
  layer's native idiom*.
- Wire layer unchanged: reserved id (`execution_id = container_id`,
  kata-style) — our `AttachRequest.execution_id` is required-non-empty and
  the duplicate-id guard already protects the convention.
- `wait()` follows docker-py's `Container.wait()` (which returns
  `{'StatusCode': N}`) but returns a **typed** `BoxResult(exit_code: int)` —
  no dict-of-unknowns. Implementation: Wait RPC when live, status/exit-code
  polling via inspect when reattaching after the VM self-stopped.

### 3. `Boxlite.run()`: the docker-py-shaped convenience (facade layer)

```python
result = await rt.run("alpine", ["sh", "-c", "make test"])
# RunResult(exit_code=2, stdout=b"...", stderr=b"...")

box = await rt.run("oven/bun:1.2.1",
                   ["bun", "-e", "Bun.serve(...)"],
                   detach=True, options=BoxOptions(ports=[(9101, 80)]))
# Box — the server IS init; the published port serves; box.wait() later
```

- `detach=False` (default): create → start → attach_init → stream to
  completion → auto-remove (docker-py `remove=True` behavior is our default
  here; `keep=True` opts out) → return `RunResult{exit_code, stdout, stderr}`.
- `detach=True`: return the `Box` immediately.
- **Deliberate deviation from docker-py:** non-zero exit does **not** raise
  (docker-py raises `ContainerError`). Persona A is the primary market —
  agent frameworks treat exit codes as data (every integration we ship
  branches on `result.exit_code`); exceptions-for-exit-codes forces
  try/except around ordinary control flow. docker-py parity is one
  `if result.exit_code != 0: raise` away for those who want it.
- stdout/stderr collected with a size cap (default 8 MiB, configurable;
  streams available via `detach=True` + `attach_init()` for unbounded
  output).

### 4. Explicit non-changes

- `SimpleBox` and every specialty box: byte-identical behavior (create
  without `cmd` → image default init → boot-and-exec unchanged).
- Existing `exec`/`attach(execution_id)`: unchanged.
- Go and C SDKs: deferred until the Python/Node shape survives review —
  their thin cores make mirroring mechanical once names are settled.

## Verification

- Python + Node integration tests mirroring the CLI S-tests: run-to-completion
  exit code; detached server reachable then `wait()` returns its code;
  `attach_init` streaming; SimpleBox suite untouched and green.
- Doc examples are executable (the bun scenario above is the acceptance test).

## Open questions

1. `RunResult` no-raise vs docker-py's `ContainerError` — recommended
   no-raise (persona A), confirm.
2. `rt.run(image, cmd)` naming vs `rt.create(...)` + `box.attach_init()`
   only (no convenience) — recommended: ship the convenience; it is the
   README's four-act story ("Run") in one call.
3. Default auto-remove on `detach=False` runs — recommended yes
   (docker-py `remove` + our `--rm` precedent), `keep=True` to opt out.
