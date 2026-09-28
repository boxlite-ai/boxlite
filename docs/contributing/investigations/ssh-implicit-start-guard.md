# SSH control and explicit main commands

Date: 2026-09-28. Baseline: `873f7b25`.

SSH control must use the same implicit-start guard as execution, metrics, and
file copying. A status query on a stopped job must not run that job again.

## Problem and contract

`configure()`, `status()`, and `disable()` acquire a guest session through
`BoxImpl::guest_session()`. That path currently starts the VM and container
without checking whether the caller explicitly selected its main command.
For example, querying SSH on a stopped box configured with `python job.py`
can run the job a second time.

| State and configuration | Required behavior |
| --- | --- |
| Configured or Stopped, explicit `cmd` or `entrypoint` | `InvalidState`, directing the caller to start explicitly |
| Configured or Stopped, image defaults | Preserve implicit startup |
| Running | Preserve SSH control |
| Other states | Follow the existing implicit-start guard |

Invalidated handles retain their existing cancellation behavior. A fresh handle
obtained through `runtime.get()` must still enforce the main-command guard.

## Related work and lessons

References below describe baseline `873f7b25`:

- `src/boxlite/src/litebox/box_impl.rs:385`,
  `ensure_usable_without_rerunning_main()`, already protects execution, metrics,
  and copying. It checks both lifecycle state and explicit command configuration.
  Reuse this policy so SSH stays consistent with those entry points.
- `src/boxlite/src/litebox/box_impl.rs:1077`, `guest_session()`, is shared by all
  three SSH operations. Applying the guard here avoids three separate checks.
- `src/boxlite/tests/guest_ssh.rs`, `runtime_ssh_control_and_recovered_handle`,
  exercises image-default implicit startup, running SSH control, and recovered
  handles. Retain it as compatibility coverage.
- `src/boxlite/tests/run_main_command.rs`,
  `a_stopped_box_without_a_main_command_still_restarts_on_exec`, documents why a
  blanket ban on implicit startup would break existing runtime use.

These in-repository comparisons share the exact lifecycle and configuration
contract; no external runtime comparison is needed for this policy reuse.

## Approach and alternatives

Call `self.ensure_usable_without_rerunning_main("control SSH on")?` before
`live_state()` in `guest_session()`. Public signatures and protocols stay the
same. Update the SSH guide, Rust reference, and API comments to describe when
implicit startup is permitted and how recovered stopped handles behave.

Checking each SSH operation independently duplicates the policy. Rejecting all
stopped boxes breaks image-default implicit startup. Changing `live_state()`
itself broadens the change beyond SSH and is unnecessary.

## Validation

Add a regression matrix for Configured/Stopped, explicit cmd/entrypoint-only,
and configure/status/disable. Each case uses valid SSH credentials. The main
command appends to a host-mounted record and emits a readiness event; bound the
output wait with a timeout. For Stopped cases, explicitly start and stop first,
drop old handles, and reacquire through `runtime.get()`.

Assert `InvalidState`, explicit-start guidance, unchanged state/PID, and an
unchanged execution record. Then explicitly start and confirm SSH succeeds.
Run the existing compatibility case alongside these tests.

First run `make test:integration:rust FILTER=runtime_ssh` with only the regression
test added to the baseline; require a failure at the defect assertion. Apply
the guard and behavior documentation, then repeat. Finally run
`make test:unit:rust FILTER=ssh`, `make fmt:check`, `make lint`, and `make test`.
Build or environment failures do not count as defect reproduction.

Delivery is local; any PR must link the hosted design and measure its entire
diff against its intended base.

## Verification results

- With production unchanged at `873f7b25`, all 12 new cases failed at the
  `InvalidState` assertion: each SSH operation returned `Ok(SshStatus)` instead.
  The existing compatibility case passed.
- With the guard applied, all 13 `runtime_ssh` integration cases passed.
  Both runs used `make test:integration:rust FILTER=runtime_ssh SETUP_DONE=1`
  after building the runtime, outside the sandbox for Hypervisor.framework access.
- `make test:unit:rust FILTER=ssh` passed, including the REST unsupported case.
- `make fmt:check FMT_COMPONENTS=rust` and `make lint FMT_COMPONENTS=rust` passed.
  Unscoped format and lint targets stopped because `yarn` is unavailable.
- The full `make test` check exposed blockers outside SSH: apps setup requires
  the missing `yarn`, the C SDK's `test_simple_create` asserts at
  `sdks/c/tests/test_simple_api.c:24`, and the local Python 3.9.6 environment
  cannot import or install the Python SDK (requires Python 3.10+). These are
  recorded for follow-up; this change does not modify those components.
  Rust unit suites and all 282 selected Rust integration cases passed (13
  integration cases were skipped by the existing test configuration). The
  aggregate exited with failures in apps, C, and Python only.
