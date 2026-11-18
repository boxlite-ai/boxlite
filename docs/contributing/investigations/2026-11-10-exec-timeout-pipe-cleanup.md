# Timed execution and descendant-held pipes

**Status:** Implemented

A timed command must release its original process group and return the Python
result when descendants retain stdout or stderr.

## Problem and scope

[Issue #2513](https://github.com/boxlite-ai/boxlite/issues/2513) describes a shell
whose deadline expires while a child retains an output pipe. Process exit and
pipe EOF are separate events. The Guest signals the leader, and Python waits for
EOF before asking for the exit result.

The change covers timed local Guest execution and both Python one-shot wrappers.
Signals address the original process group. A descendant that creates a new
session can leave that group. The Python completion bound still limits result
collection. A zero or omitted timeout keeps the existing unlimited-wait behavior.

## Related work and decisions

| Method | Evidence | Decision |
| --- | --- | --- |
| Signal the original group | [PR #1460](https://github.com/boxlite-ai/boxlite/pull/1460) identifies leader-exit cancellation | Retain the group deadline after the leader exits |
| Preserve kernel identity | [Linux pidfd signals](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html) support process groups since 6.9 | Pin the leader with a pidfd before user code runs, then signal its original group |
| Bound output drain | [Go os/exec WaitDelay](https://pkg.go.dev/os/exec#Cmd.WaitDelay) handles child-retained pipes | Bound Python output and status collection while keeping bytes already received |

A stored numeric PGID can be reused. The pidfd group reference avoids selecting
a different group after the leader is reaped. Older custom kernels retain the
existing leader-only signal fallback.

## How it works

Timed pipe-mode Guest children get a separate process group. Container tenants
already create sessions. Their validation hook sends a pidfd over a private
socket before executing user code, so the global reaper can keep handling
unrelated exits during container startup.

The watcher sends SIGTERM at the deadline and escalates to SIGKILL after two
seconds. When the leader has exited, it continues watching the group and releases
the reference once the group is empty.

Python drains stdout and stderr concurrently. Timed execution status is collected
in parallel. After timeout plus three seconds, outstanding collection is cancelled
and the result retains received output, a known exit code, and a diagnostic. The
window includes Guest cleanup and result delivery.

## Validation

Run the same descendant-held-pipe and SIGTERM-ignoring VM tests on the upstream
base and the patch. Check process state after completion. Preserve unlimited
collection for timeout=None and timeout=0 in synchronous and asynchronous APIs.
Run execution and zygote lifecycle tests, Python units, and formatting checks.

### Test prerequisites

Python wrapper tests run asynchronous cases without the optional greenlet
dependency and skip only synchronous cases when it is absent.

Timed-group tests probe the running kernel with a signal-zero pidfd group call
on a temporary private group, which is then killed and reaped. EINVAL or ENOSYS
results skip those capability-dependent cases; other errors fail the probe.
Supported kernels run
the complete descendant-exit and watcher-lifetime assertions.
