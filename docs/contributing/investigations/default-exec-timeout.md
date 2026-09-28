# Default execution timeout in the runtime

Date: 2026-09-28

## Problem and scope

A command with no explicit timeout currently reaches the guest with
`timeout_ms = 0`, so the guest does not start its timeout watcher. A hung
command can remain alive indefinitely. The runtime should supply a 300-second
deadline when `BoxCommand.timeout` is `None`.

Explicit durations retain their existing meaning, including zero, which
disables the watcher. This change adds no public API, organization setting,
or termination-status field. It applies to commands submitted through the
updated embedded runtime, including a runner linked against that runtime.
Updating only a REST client does not change an older server's behavior.

## Related work and lessons

Source references are against commit `5f075161dbb1b9b174991ce822ef3879f116003d`.

- `src/boxlite/src/portal/interfaces/exec.rs:268`: `ExecProtocol` already owns
  conversion from the optional duration to the guest's millisecond field.
  Apply the fallback here, preserving the distinction between omission and zero
  until the command reaches its execution backend.
- `src/guest/src/service/exec/mod.rs:462` and
  `src/guest/src/service/exec/timeout.rs:1`: positive deadlines already start a
  watcher that sends SIGTERM, then SIGKILL after a two-second grace period.
  Reuse that mechanism without adding another timer or changing signal policy.
- `sdks/c/src/exec/command.rs:56`: the C binding leaves the timeout unset for
  zero. Go and the hosted runner inherit that representation. Omitted values
  and explicit zero therefore both select the new default on these paths;
  callers must supply a longer positive duration for long tasks. This
  compatibility trade-off was explicitly accepted for the runtime-only scope.
- Modal's [Sandbox SDK reference](https://modal.com/docs/sdk/js/latest/Sandbox)
  documents an unlimited default for individual execs. Its sandbox lifetime
  default is a different contract. The proposed 300 seconds is BoxLite's
  chosen fallback, not an assertion of equivalent per-command behavior.

## Approach and alternatives

Introduce a private 300-second duration constant beside `ExecProtocol`. Resolve
`command.timeout.unwrap_or(DEFAULT_EXEC_TIMEOUT)` before converting to
milliseconds. Keep `BoxCommand::new` at `None` and preserve REST omission,
allowing the execution server to own the default.

Setting the builder's default to `Some(300s)` would make clients send an
explicit value to remote servers and erase the distinction between an
omitted value and caller policy. Resolving defaults in every language binding
would duplicate policy. Neither approach is needed for this change.

The timeout starts when the guest registers the spawned execution; it does
not bound image pulls or box startup. At 300 seconds the existing watcher
begins termination, with its existing two-second escalation grace. Existing
signal delivery, process selection, and result semantics remain unchanged.

Update the Rust reference and affected SDK/runner timeout descriptions,
including C header comments, so they no longer promise unlimited defaults.

## Validation and delivery

Add unit tests calling the production guest-request builder: omission must
produce 300000 milliseconds, while 1.5 seconds, 600 seconds, and zero must
remain explicit overrides. Also test that REST request construction still
omits an unspecified timeout and preserves explicit zero.

Run the tests against the unchanged production code first and record the
300000-versus-0 assertion failure. Then apply the fallback and rerun them.
Use `make test:unit:rust FILTER=exec_request` and the existing VM timeout
regressions via `make test:integration:rust FILTER=test_timeout_`. Report
environment blockers rather than claiming unexecuted tests passed.

The estimated diff is under 200 lines including tests and documentation.
Delivery is local; no deployment or public artifact is part of this change.

## Verification results

`BOXLITE_DEPS_STUB=1 CARGO_NET_OFFLINE=true make test:unit:rust
FILTER=exec_request` reached the default-timeout assertion before the fix:
actual `0`, expected `300000`. At that point the working tree contained only
the two test additions. Explicit override and REST serialization tests passed.
After the fix, all selected tests passed in both core and REST-enabled builds.
Stub mode skips native dependency bundling; these tests exercise request
construction, not VM execution.

`make fmt:check:rust`, `make fmt:check:go`, and `git diff --check` passed.
`CARGO_NET_OFFLINE=true make test:integration:rust FILTER=test_timeout_`
stopped before executing tests: the sandbox denied a Go build-cache write,
and the libkrunfw download failed because the configured local proxy was
unreachable. Guest termination behavior has not been revalidated in a VM.
