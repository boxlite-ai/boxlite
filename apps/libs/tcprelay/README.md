## TL;DR

TCP relays preserve replies after EOF and release half-closed connections after ten minutes without forwarded payload.

## Contract

`Relay(ctx, left, right)` owns both connections and joins its two copy workers.
A clean EOF invokes the destination's `CloseWrite`; the opposite direction
remains open. After the first EOF, each successful payload write renews a
ten-minute idle window. For example, a response chunk at minute nine allows
another ten minutes; a response can stream for hours while making progress.
TCP acknowledgements and keepalives do not renew this application timer.

Fully open connections have no new idle deadline. Cancellation, copy errors,
shutdown errors, and idle expiry close both peers. Idle expiry wraps
`context.DeadlineExceeded`. Connections must implement the `net.Conn` contract
that `Close` unblocks pending I/O. A connection without `CloseWrite` falls back
to full close because its API cannot express an independent EOF.

The writer wrapper intentionally disables direct socket-to-socket copy
optimizations so successful writes cannot bypass activity tracking. This adds
userspace copying; the policy is shared by common-go CONNECT and gvproxy.

## Validation and integration

`make test:apps:common-go` and `make test:unit:gvproxy` exercise the production
callers. `testing/synctest` checks the actual ten-minute default with in-memory
half-close connections; real TCP/UNIX and gVisor tests verify FIN propagation.

This module uses only the standard library. App main modules use sibling Go
replacements; gvproxy references it from its own module. Keep Docker dependency
and source copies in sync with these paths when moving the module.
