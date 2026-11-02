# Exec spawn failures: typed failures instead of synthetic exit codes

**Date:** 2026-11-02
**Status:** Proposed; not adopted in #2220
**Related:** [#2164](https://github.com/boxlite-ai/boxlite/issues/2164), [#2220](https://github.com/boxlite-ai/boxlite/pull/2220)

## TL;DR

BoxLite can model a refused exec as a typed `SpawnFailure` (`kind`, `errno`,
`stage`) instead of a terminal execution with a synthetic `exit_code` of 126 or
127. The guest executor can report the real failing syscall with a child error
pipe; the container executor can only label youki's two verdicts. This removes
the workdir race and the "only two codes" ceiling, but breaks the `wait()`
contract from #2164 and needs wire, SDK and CLI changes. Keep the POSIX model
for #2220; adopt this only if SDK-native diagnostics become the priority.

## Problem

#2220 turns a command the image cannot run into a completed execution: the
guest publishes a terminal `ExecutionState` with `exit_code=126` (not
executable) or `127` (not found), and the caller gets an ordinary
`ExecResult`. That fixes the original HTTP 500 and matches Docker/Podman, but
it has three costs:

1. **A process that never ran gets a process exit code.** `box.exec("missing")`
   and `sh -c 'exit 127'` become indistinguishable at the result type.
2. **The classifier is narrow by construction.** The container executor
   suffix-matches youki's `validate` text; the guest executor maps
   `ErrorKind::NotFound`/`PermissionDenied` from `Command::spawn`. `ENOEXEC`, a
   bad shebang interpreter, `ENOTDIR`, and resource failures remain 5xx
   faults, so only two refusal causes are covered.
3. **The guest workdir check is a post-failure probe.** `Command::spawn`
   reports one `io::Error` for both the child `chdir` and `execve`; BoxLite
   probes the workdir after the failure to decide whether the error belongs to
   the configuration or the command. If the workdir's searchability changes
   between the child's `chdir` and the probe, the failure is attributed to the
   wrong side.

The question is whether BoxLite should instead return a structured spawn
failure and let `ExecExited { code }` remain the only carrier of a real exit
status.

## Research

Peer behaviour is not uniform. The split is between engine/CLI contracts and
sandbox SDK contracts.

| Project @ ref | Spawn refusal | POSIX code? | Notes |
|---|---|---|---|
| Firecracker `ab198c7` | N/A | No | The API (`/boot-source`, `/drives`, `/vsock`, `/actions`, ...) has no exec route; command execution belongs to the guest agent. |
| E2B `f9ed2af` | shell exit | Yes, indirectly | Every process runs as `/bin/sh -c <wrapper> -- <cmd> ...` (`packages/envd/internal/services/process/handler/handler.go`). Missing/non-executable commands are shell exits 127/126. Spawn failures such as a frozen cgroup or fd exhaustion map to Connect codes (`InvalidArgument`, `ResourceExhausted`, ...) in `handler/start_error.go`; they are not exit codes. |
| microsandbox `44c1e63` | `ExecFailed { kind, errno, errno_name, message, stage }` | No | `crates/protocol/lib/exec.rs` defines `ExecFailed` and `ExecFailureKind`; `crates/agentd/lib/session.rs` classifies `execve` errno. The PTY path writes it through a child error pipe; the pipe path classifies the `io::Error` from `Command::spawn`. `ExecExited { code }` is a separate event. The CLI raises `MicrosandboxError::ExecFailed` instead of exiting 126/127. |
| Docker CLI `master` | exit code | Yes | `docker run` maps start errors in `cli/command/container/run.go` `toStatusError`: not found/no such file -> 127, EACCES/EISDIR -> 126, everything else -> 125. `docker exec` documents 126/127 and otherwise returns the runtime exit code. |
| Podman 5.8 | exit code | Yes | `podman-run(1)` and `podman-exec(1)` document 125 (Podman error), 126 (cannot invoke), 127 (cannot find), otherwise the command's code. |

Two observations shape the design:

- **Exit codes are a CLI/engine contract, not a universal sandbox contract.**
  Docker and Podman need a small integer because a shell and a CLI consume it.
  microsandbox's SDK does not, so it keeps the richer failure object.
- **A typed model does not remove youki's text limitation.** BoxLite's container
  executor still receives only `ExecFailed(String)` from youki's init child;
  only the guest executor can capture a real errno and stage.

### microsandbox's mechanism

The parts worth borrowing are independent of its protocol:

```text
parent                          child
  pipe2(O_CLOEXEC)  ---------->  write end
  fork/spawn
                                 chdir / pty / limits / user setup
                                   on failure:
                                     write(stage, errno) to pipe
                                     _exit(127)
                                 execve
                                   success: CLOEXEC closes the pipe
                                   failure: std reports io::Error
  read(pipe)
    data  -> SpawnFailure { stage, errno }
    EOF   -> exec succeeded
```

`std::process::Command::spawn` already distinguishes the two failure locations
if the child does the `chdir` itself:

- `spawn() == Err(e)` with an empty error pipe means `execve` failed; the stage
  is `exec` and `e.raw_os_error()` is the errno.
- `spawn() == Ok(child)` with data in the error pipe means a pre-exec step
  failed; the stage and errno come from the pipe, and the child is reaped
  before returning.
- `spawn() == Ok(child)` with EOF means the program is running.

This is the same distinction #2220 tries to recover with a post-failure
`faccessat` probe, but it is recorded at the point of failure and has no TOCTOU
window.

## Design

### Contract

A command that never ran is not an `Execution`. It is a spawn failure:

```python
try:
    execution = await box.exec("missing")
except boxlite.SpawnError as failure:
    assert failure.kind == "not_found"
    assert failure.stage == "exec"
```

`ExecExited` / `Execution::wait()` remain the only way to observe a process exit
code. `SpawnError` carries:

```text
kind        coarse classification for callers and CLI hints
errno       raw OS error when a syscall produced it
errno_name  "ENOENT", "EACCES", ... for logs and grep
stage       "fork" | "chdir" | "pty" | "exec" | "validate" | "build"
message     human-readable detail
```

Kinds: `not_found`, `permission_denied`, `not_executable`, `bad_cwd`,
`bad_args`, `resource_limit`, `out_of_memory`, `user_setup_failed`,
`pty_setup_failed`, `other`.

### Wire

Add an optional structured body to the existing `ExecError`; `reason` and
`detail` stay for compatibility:

```proto
message ExecResponse {
  string execution_id = 1;
  uint32 pid = 2;
  uint64 started_at_ms = 3;
  optional ExecError error = 4; // if set, no process is running
}

message ExecError {
  string reason = 1;        // "spawn_failed"
  string detail = 2;
  optional SpawnFailure failure = 3;
}

message SpawnFailure {
  SpawnFailureKind kind = 1;
  optional int32 errno = 2;
  optional string errno_name = 3;
  optional string stage = 4;
}

enum SpawnFailureKind {
  SPAWN_FAILURE_UNSPECIFIED = 0;
  NOT_FOUND = 1;
  PERMISSION_DENIED = 2;
  NOT_EXECUTABLE = 3;
  BAD_CWD = 4;
  BAD_ARGS = 5;
  RESOURCE_LIMIT = 6;
  OUT_OF_MEMORY = 7;
  USER_SETUP_FAILED = 8;
  PTY_SETUP_FAILED = 9;
  OTHER = 10;
}
```

For a spawn failure the guest returns no `execution_id` (and no registry
entry); `start_execution` releases the reservation like any other early error.
No `pid=0` execution is published, so `attach`, `wait`, `kill` and retention
are not involved.

### Guest executor

Replace the post-failure `working_directory_is_searchable` probe with a child
error pipe in `spawn_with_pipes` and `spawn_with_pty`:

1. Create `pipe2(O_CLOEXEC)`.
2. Do not call `Command::current_dir`. In `pre_exec`, call `chdir` first. On
   failure write the fixed `{stage, errno}` record and `_exit(127)`. For the PTY
   path, write `stage=pty` if `setsid`/`TIOCSCTTY` fails.
3. After `spawn()`:
   - `Ok(child)` + pipe data: reap the child, return
     `SpawnFailure { stage=chdir|pty, errno, ... }`.
   - `Ok(child)` + EOF: the program is running.
   - `Err(error)` + EOF: `execve` failed; return
     `SpawnFailure { stage=exec, errno=error.raw_os_error(), ... }`.
   - `Err(error)` + pipe data: prefer the pipe record; `spawn` failed after a
     pre-exec step.
4. Classify the errno:

| errno | kind |
|---|---|
| `ENOENT` | `not_found` |
| `EACCES`, `EPERM` | `permission_denied` |
| `ENOEXEC`, `EISDIR`, `ETXTBSY` | `not_executable` |
| `ENOTDIR` (stage `chdir`) | `bad_cwd` |
| `E2BIG`, `ELOOP`, `ENAMETOOLONG`, `EFAULT` | `bad_args` |
| `EMFILE`, `ENFILE`, `EAGAIN` | `resource_limit` |
| `ENOMEM` | `out_of_memory` |
| other | `other` |

The child writes only a fixed-size record with `write(2)` and exits with
`_exit(127)`; no allocation, formatting, or locks in the fork-to-exec window.
`EPERM` stays `permission_denied` because a security module or seccomp can
reject `execve`; the stage and errno preserve that distinction.

This also removes the need for `SpawnFailure::Rejected(CommandRejection)` as a
separate outcome: every spawn failure is a failure, with a typed reason.

### Container executor

The container executor keeps youki as-is. `command_rejection` becomes:

```rust
SpawnFailure {
    kind: NotFound | PermissionDenied,
    errno: None,
    errno_name: None,
    stage: "validate",
    message: reported_by_init,
}
```

Youki's init child only sends text, so `errno` and `errno_name` are absent.
A non-verdict build error stays `BoxliteError::Internal` (a platform fault),
not a `SpawnFailure`. If youki later exposes a typed validation error, the
kind can be filled without changing the API.

Init (`build_init`) keeps its current contract: a refused main command is still
`InvalidArgument` for `run`, not a spawn result. Internal SSH workloads keep
their error path; a workload that cannot start is not a user command verdict.

### Host, SDK, CLI

- Add `BoxliteError::SpawnFailed(SpawnFailure)` to
  `src/shared/src/errors.rs`, using the generated
  `boxlite_shared::generated::SpawnFailure`; map `reason="spawn_failed"` in
  `map_exec_error` to it instead of `Internal`.
- HTTP: 422 with a new `spawn_failed` code and the structured body (or keep the
  `execution_failed` code if a new code would break the error table; either
  way the body carries `failure`).
- SDKs: add a `SpawnError` class exposing `kind`, `errno`, `errno_name`,
  `stage`, and `message`; update the Python/Node/Go/C error tables and the
  Python class test that asserts every variant has a class.
- CLI: `boxlite exec` prints `Error: ...` and exits 1, matching microsandbox.
  If Docker CLI parity is required, map `not_found` -> 127 and
  `permission_denied`/`not_executable` -> 126 at the CLI boundary only, and
  document that the SDK does not synthesize those codes.

### Delete

- `ExecutionState::rejected` and `OutputManager::completed_with_diagnostic`.
- `SpawnedExecution::Rejected` and the `pid=0` branch in `spawn_execution`.
- The production use of `ExitSlot::settled` introduced for synthetic exits.
- `classify_spawn_error`'s `NotFound`/`PermissionDenied` mapping and
  `working_directory_is_searchable`.
- `CommandRejection.exit_code`; the container path carries `SpawnFailure`
  instead.

### Validation

| Claim | Test |
|---|---|
| Missing command -> `not_found` with `stage=exec` | guest executor error-pipe test |
| Non-executable file -> `permission_denied` | guest executor error-pipe test |
| Missing/unenterable workdir -> `bad_cwd` with `stage=chdir`, no probe race | guest executor test with a mode-0000 dir; UID-independent test of the classifier |
| `ENOEXEC`/bad shebang -> `not_executable` or `other`, not 5xx | guest executor test |
| No synthetic execution | `start_execution` returns an error; registry stays empty; `wait` is not callable |
| Youki verdicts -> `not_found`/`permission_denied`, `stage=validate`, no errno | zygote classifier test feeding real `validate()` output |
| Unknown build failure -> `Internal` | zygote test |
| Wire round-trip and old-client compatibility | proto round-trip; optional field ignored by old clients |
| SDK class and CLI behaviour | Python/Node/Go/C error tests; CLI exit test |

### Migration

The pure typed model is a breaking change for #2164: callers that check
`exit_code == 127` must catch `SpawnError` and inspect `kind`. Two staged paths
avoid a flag day:

1. **Hybrid (recommended if 126/127 must remain):** keep the terminal
   execution and exit code, and add `SpawnFailure` to the response/result as
   metadata. Callers see both `exit_code` and `failure.kind`; a later major
   version can drop the synthetic codes.
2. **Pure typed model:** ship the `SpawnError` contract in a major SDK release,
   update the CLI and REST docs, and remove the synthetic execution path.

## Tradeoffs

**Pros**

- A refusal cannot be confused with a real exit code.
- `kind` covers `bad_cwd`, `ENOEXEC`, resource failures, and unknown causes;
  `errno`/`stage` survive for debugging.
- The guest executor records the failing syscall at the source; no workdir
  probe, no TOCTOU.
- The API is extensible: new kinds are additive, and an unknown errno still
  lands in `other` with its raw value.

**Cons**

- Breaking API: `exec()` now raises for a refusal; `wait()` has no 126/127.
- The container executor still only has youki's text, so `errno`/`stage` are
  partial there.
- More wire/OpenAPI/SDK surface than a terminal execution.
- The CLI must choose between microsandbox-style exit 1 and Docker-style
  126/127; either choice diverges from one peer.

## Decision

Not adopted in #2220. The PR keeps the Docker/POSIX model because #2164's
acceptance criterion is `ExecResult.exit_code == 127`, and the CLI already
propagates process exit codes.

Adopt the typed model, or the hybrid, only when BoxLite is willing to change
the SDK contract. The guest error pipe is worth taking independently: it
removes the workdir race and gives the guest executor an accurate `stage` even
if BoxLite keeps synthesizing 126/127 for compatibility.

## References

- Firecracker `ab198c7`: `src/firecracker/swagger/firecracker.yaml` (no exec
  path; VM configuration, actions, drives, vsock only).
- E2B `f9ed2af`: `packages/envd/internal/services/process/handler/handler.go`
  (`/bin/sh -c` wrapper), `handler/start_error.go` (Connect codes).
- microsandbox `44c1e63`: `crates/protocol/lib/exec.rs` (`ExecFailed`,
  `ExecFailureKind`, `ExecExited`), `crates/agentd/lib/session.rs`
  (`classify_spawn_errno`, PTY error pipe, reader/exit ordering),
  `crates/agentd/lib/process.rs` (`ProcessManager`, SIGCHLD, `waitpid`,
  `exit_code`), `crates/cli/lib/commands/exec.rs` (`ExecEvent::Failed`).
- Docker CLI `master`: `cli/command/container/run.go` `toStatusError`; Docker
  exec exit-status documentation.
- Podman 5.8: `podman-run(1)` and `podman-exec(1)` exit-status sections.
