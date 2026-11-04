# Checkpoint output handoff

## TL;DR

Checkpoint resume must explicitly retire the captured output forwarders and wait
for their leases to drop before returning. Transport reset alone does not prove
that guest-side response bodies have been destroyed.

## Scope and evidence

The managed catalog acceptance case must retain its process identity, 300 MiB
heap, resize, source deletion, checkpoint deletion and cold-start checks.
Ordinary concurrent Attach must still reject a second live reader.

Local sources inspected on 2026-11-03:

- `src/guest/src/service/exec/output.rs`: `ConsumerLease::drop` releases the
  exclusive atomic flag. `attach` waits at most one second; elapsed time cannot
  establish that a captured consumer is dead.
- `src/guest/src/service/exec/state.rs`: `attach_output` owns the stream inside
  `output_task`; abort followed by joining that task completes stream destruction.
  Existing `release_resources` uses this mechanism but also destroys process
  resources, so it cannot be reused wholesale.
- `src/guest/src/service/exec/mod.rs`: `attach_execution` handles live and retained
  executions and is shared by RPC and SSH consumers.
- `src/boxlite/src/litebox/checkpoint.rs`: explicit resume checks guest identity
  after resuming the owner; a failed reconnection stops the VM.
- `docs/guides/checkpoints.md`: observed restored Attach fails while the old
  response has not dropped; process and heap survive.

These are local implementation observations. The proposed handoff remains to be
verified with the real guest and KVM; no claim is made about network teardown time.

## Mechanism

Add a guest control RPC dedicated to checkpoint output handoff. Invoke it only
from explicit checkpoint resume, after checking the saved guest identity, and
wait for acknowledgement before resume succeeds. Unsupported guests fail closed
through the existing resume failure path.
Bound the RPC with the existing guest-control timeout and stop on timeout.
Handoff retires all pre-resume output consumers, including SSH consumers; it
does not promise continuity of captured network connections.

The guest serializes handoff against Attach registration. It enumerates live and
retained execution states, aborts their output forwarding tasks and joins them.
It preserves the output ring, pipe drainers, process, exit state and stdin.
New Attach still uses the existing exclusive lease. The control operation must
finish cleanup even if its RPC caller disconnects; cancellation cannot detach a
JoinHandle and acknowledge unfinished cleanup.

An owned task holds an exclusive server output gate throughout enumeration,
abort and join; Attach holds its shared side until registration finishes. Acquire
the execution state lock before spawning a forwarder, with no await between
spawn and registration, so cancelled Attach cannot orphan a live consumer.

Remove the timeout workaround and its checkpoint rationale. Normal consumer
closure remains asynchronous; tests should await closure rather than assume a
transport reset has already released the reader.

Alternatives rejected: a longer timeout does not invalidate a consumer; stealing
the atomic lease allows overlapping readers; resetting on every new connection
would break ordinary active readers; releasing all execution resources kills
state that checkpoints must preserve.

## Validation

Before production edits, reproduce the existing managed acceptance failure on
Linux x86_64/KVM. Add focused guest tests for a retained old receiver, a successful
post-handoff Attach, and rejection of another active reader. Run new regression
tests with production reverted, using only a test compatibility adapter if a new
RPC prevents compilation, then with the full fix restored.

Run guest unit tests, checkpoint lifecycle tests and managed, standalone and REST
acceptance cases using Makefile targets on the SSH KVM host. Record actual results
and update the user guide only to the extent established by those runs.

## Observed validation (2026-11-03)

- The unmodified managed KVM acceptance case reached restored execution and
  failed with `guest helper stdout closed` (333 seconds).
- With every production change absent, the new state regression failed at
  `handoff must complete lease release`; the RPC cancellation regression timed
  out waiting for the old consumer to close. Test-only old-contract adapters
  supplied an absent operation without changing the defect assertions.
- The amended lifecycle test failed on the old implementation because
  `Guest.DetachCheckpointOutput` was never called. Its existing provider fixture
  first needed the missing `network_device: false` field to compile.
- After removing all adapters and applying the complete fix,
  `make test:unit:guest` passed all 365 tests on Linux.
- `make test:unit:rust FILTER=litebox::checkpoint::tests` passed all 13 matching
  lifecycle tests in both the default and REST feature configurations.
- `make runtime:debug` completed. All three real KVM acceptance cases passed:
  managed catalog/source/resource deletion (347 seconds), process continuation
  across runtimes (141 seconds), and REST transfer across independent homes
  (262 seconds). Their existing process, heap, resize, cold-start and isolation
  assertions were unchanged.
- `make fmt:check:rust` and `git diff --check` passed locally.

The KVM host required a privileged test runner and a runtime copied to a
traversable temporary directory for bubblewrap. Host security policy and home
directory permissions were unchanged. Firmware was reused through the build
script's `BOXLITE_LIBKRUNFW_SOURCE` override; guest and runtime are rebuilt.
SHA-256 checks confirmed that every changed source file on the KVM host matched
the local delivery. Full workspace lint, other platforms and cloud qualification
were not part of these focused runs.

The subsequent [full test run](checkpoint-output-handoff-full-tests.md) records
the complete matrix, separate REST E2E, environment corrections and remaining failures.
