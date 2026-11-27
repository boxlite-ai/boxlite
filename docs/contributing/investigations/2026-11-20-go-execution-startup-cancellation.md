# Honor cancellation while Go starts an execution

**Status:** Implemented

## TL;DR

Return the context error when a caller cancels `StartExecution`, and clean up any execution handle the native call returns after cancellation.

## Problem

`Box.StartExecution` accepts a context but ignores it while `boxlite_box_exec` runs. With a REST runtime, a delayed response to `POST /boxes/{box}/exec` keeps a canceled caller blocked. `Box.Exec` and `Cmd.Run` both use this entry point.

## Scope

This slice covers command submission. The attach path in [#2048](https://github.com/boxlite-ai/boxlite/issues/2048) has a different ownership rule because it can observe an existing execution. It needs separate design and coverage.

## Related work and lessons

| Approach | Decision | Reason |
| --- | --- | --- |
| Propagate cancellation through the native API | Defer | Native cancellation would need a contract for a request that reaches a runner but loses its response. The current synchronous C API returns an execution handle only on success. |
| Hand off the native result or clean it up | Pick | The [Go `context` contract](https://pkg.go.dev/context#Context) supplies the caller's cancellation error. [Go `os/exec.CommandContext`](https://pkg.go.dev/os/exec#CommandContext) illustrates pairing cancellation with termination of owned work. BoxLite already has a kill operation and explicit native handle ownership. |
| Only check cancellation before calling C | Reject | This cannot release an already blocked caller. |

## How it works

Check the context before submission. For a cancellable context, a worker holds the box handle through the native call and passes the execution handle to the caller through an unbuffered channel. If cancellation wins, the worker requests termination of any late execution and releases its handle. The caller registers stream callbacks only after receiving ownership, so an abandoned startup cannot write into caller-owned output sinks.

For example, a server can receive a launch request and delay its response. The Go caller cancels and returns immediately. If the server later returns an execution ID, the worker uses it to terminate the execution and release the native handle. `Box.Close` continues to wait while C is using the box handle.

The Go deadline bounds the caller's wait. A synchronous native call can remain in progress, and a command that already ran can have side effects. Cleanup depends on obtaining a handle and reaching the backend with the termination request.

## Validation

| Claim | Planned check |
| --- | --- |
| A pre-canceled start sends no command | Call the Go SDK against a loopback REST endpoint and count launch requests. |
| Cancellation returns while native startup is blocked | Gate the REST response on a channel and cancel after the server records the launch. |
| A late execution is cleaned up | Release the response and verify the issued termination request targets the returned execution ID. |
| Native handle lifetime remains serial with `Close` | Exercise the existing handle race suite and the gated startup with `Close` in parallel. |

Run the new regression on the pinned upstream baseline and again with the full patch. Record the failure and pass separately.

## Submission preparation

The VM regression belongs in the Go integration package tree. The existing
integration target runs that tree with its VM build tags, race option and filter.
Hosted unit tests retain their current tags and resource requirements.

Each gated-response test releases its response before waiting for a failed
startup to finish. That final wait has a five-second diagnostic deadline, so a
native startup failure cannot leave the test blocked on its result channel.

Preparation preserves the existing startup implementation. Verification reruns
the original and patched production files with the same tests and runtime.
