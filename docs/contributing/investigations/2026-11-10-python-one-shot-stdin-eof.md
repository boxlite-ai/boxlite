# Close stdin in one-shot Python exec

**Status:** Implemented

The one-shot Python wrappers own stdin and close it before collecting output.

## Problem and scope

[Issue #1978](https://github.com/boxlite-ai/boxlite/issues/1978) reproduces EOF
readers hanging across SDKs. Python SimpleBox.exec starts a command and waits for
its output without releasing its input writer. A command such as wc -c waits for
EOF, so both sides wait.

This change covers SimpleBox.exec and SyncSimpleBox.exec. Their streaming Box.exec
and SyncBox.exec counterparts expose the execution handle to the caller, who
continues to write input and close it explicitly.

## Related work and decisions

| Method | Evidence | Decision |
| --- | --- | --- |
| Close wrapper-owned stdin | [Go PR #2025](https://github.com/boxlite-ai/boxlite/pull/2025) applies it to one-shot commands | Reuse the existing Python native close operation in both wrappers |
| End a pipe by closing its writers | [Linux pipe semantics](https://man7.org/linux/man-pages/man7/pipe.7.html) define EOF | Close before waiting for stdout or process status |
| Add a core input flag | Issue #1978 tracks this as future work | Keep this patch at the Python wrapper boundary |

## How it works

A private helper takes and closes stdin after successful command launch.
The native binding raises RuntimeError when no stdin stream is available.
That documented absence permits output and status collection to proceed.
Errors from an acquired stream's close operation propagate.

The low-level Execution and input writer keep their current ownership.
For example, sending hello through the low-level writer and then closing it
must make wc -c return 5.

## Validation

Run synchronous and asynchronous wc -c in a real VM. Both must exit 0 and print
0. With the Python production change reverted, both must reach the Guest timeout
and fail the same exit-code assertion.

Keep a streaming write-and-close test. Use a dedicated synchronous runtime context
so its event loop is closed before the next asynchronous test. Run the complete
Python unit suite and the combined timeout/EOF regressions.
