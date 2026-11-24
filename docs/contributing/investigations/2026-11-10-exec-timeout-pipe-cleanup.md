# Timed execution and descendant-held pipes

**Status:** Implemented

A timed command cleans up its original process group and ends Guest output
when descendants retain stdout or stderr.

## Problem and scope

[Issue #2513](https://github.com/boxlite-ai/boxlite/issues/2513) describes a shell
whose deadline expires while a child retains an output pipe. Process exit and
pipe EOF are separate events. The Guest signals the leader, and Python waits for
EOF before asking for the exit result.

The change covers timed local Guest execution across SDKs and both Python
one-shot wrappers. Signals address the original process group. A descendant
that creates a new session can leave that group, but cannot extend Guest output
past its cutoff. A zero or omitted timeout keeps unlimited output collection.

## Related work and decisions

| Method | Evidence | Decision |
| --- | --- | --- |
| Signal the original group | [PR #1460](https://github.com/boxlite-ai/boxlite/pull/1460) identifies leader-exit cancellation | Retain the group deadline after the leader exits |
| Preserve kernel identity | [Linux pidfd signals](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html) support process groups since 6.9 | Pin the leader with a pidfd before user code runs, then signal its original group |
| Bound output drain | [Go os/exec WaitDelay](https://pkg.go.dev/os/exec#Cmd.WaitDelay) handles child-retained pipes | Close Guest readers after the termination grace; retain Python collection bounds as a transport fallback |

A stored numeric PGID can be reused. The pidfd group reference avoids selecting
a different group after the leader is reaped. Older custom kernels retain the
existing leader-only signal fallback.

## How it works

Timed pipe-mode Guest children get a separate process group. Container tenants
already create sessions. Their validation hook sends a pidfd over a private
socket before executing user code, so the global reaper can keep handling
unrelated exits during container startup.

The watcher sends SIGTERM at the deadline and escalates to SIGKILL after two
seconds. The same deadline closes unfinished Guest output readers at the end of
that grace, even when the leader has exited or signaling fails. Runtime scheduling
and transport delivery add latency beyond this configured cutoff.

Cutoff freezes the output ring before cancelling and joining its readers. Each
stream delivers its retained bytes before its existing end event; terminal byte
counts describe bytes received by Guest. The internal output summary records
truncation independently of the process exit code, without changing wire frames.
Bytes not yet received at cutoff are discarded.

A terminal watcher can stop early only when output has ended and its original
group is empty. Explicit execution release closes readers and wakes output
waiters; a group with surviving members retains its signal deadline.

Python drains stdout and stderr concurrently. Timed execution status is collected
in parallel. After timeout plus three seconds, outstanding collection is cancelled
and the result retains received output, a known exit code, and a diagnostic. The
window includes Guest cleanup and result delivery. This watchdog also covers a
stalled Guest or transport; normal stream completion comes from Guest.

## Validation

Run the same descendant-held-pipe and SIGTERM-ignoring VM tests on the upstream
base and the patch. Check process state after completion. Preserve unlimited
collection for timeout=None and timeout=0 in synchronous and asynchronous APIs.
Run execution and zygote lifecycle tests, Python units, and formatting checks.
Guest regressions keep real pipe writers alive after leader exit, including an
escaped session and a leader-only signal target. Verify buffered data, per-stream
end ordering, retained attach, exit code preservation, and reader closure before
and after timeout registration. Native VM stream collection bypasses the Python
watchdog to establish Guest-side completion.

### Test prerequisites

Python wrapper tests run asynchronous cases without the optional greenlet
dependency and skip only synchronous cases when it is absent.

Timed-group tests probe the running kernel with a signal-zero pidfd group call
on a temporary private group, which is then killed and reaped. EINVAL or ENOSYS
results skip those capability-dependent cases; other errors fail the probe.
Supported kernels run
the complete descendant-exit and watcher-lifetime assertions.
