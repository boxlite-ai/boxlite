# VMM virtio-net device study (2026-11-02)

## TL;DR

Keep Net within 400 added code lines by using the existing virtio interfaces and limiting the implementation to packet I/O.

## Scope

[Issue #2310](https://github.com/boxlite-ai/boxlite/issues/2310) tracks this device-only slice.
The shared MMIO transport, device contract, and queue facade remain unchanged.
Snapshots, VM assembly, boot configuration, and real-guest qualification are separate work.

The caller supplies gvproxy's listening Unix socket and the guest MAC.
RX and TX use queues 0 and 1 with at most 256 entries each.
Net offers MAC; the transport handles VERSION_1.

## Related work and lessons

- The existing `VirtQueues` facade provides `drain`, `Completion::Deferred`, and `complete`; reuse them instead of adding a single-chain API.
- The existing `EventRegistrar` accepts a source but no interest argument; a Net-local mio source owns fixed read/write interests.
- Mio 1.2 Unix polling uses edge-triggered readiness; fixed writable interest does not repeatedly wake an idle device.
- Virtio-queue 0.18 ignores NO_INTERRUPT without EVENT_IDX (`queue.rs`, `needs_notification`); leave this shared limitation visible instead of duplicating notification logic.

The protocol remains the modern 12-byte virtio-net header and gvproxy's QEMU stream framing: big-endian u32 length followed by Ethernet bytes.
The local bridge selects QEMU on Linux and VFKit datagrams on macOS; only the Linux protocol is supported here.
The 65,549-byte frame ceiling matches `src/deps/libgvproxy-sys/gvproxy-bridge/shaper.go`.

Sources: [Virtio network device specification](https://docs.oasis-open.org/virtio/virtio/v1.2/virtio-v1.2.html#x1-1880001),
[mio 1.2 polling contract](https://docs.rs/mio/1.2.0/mio/struct.Poll.html),
and [virtio-queue 0.18 implementation](https://docs.rs/virtio-queue/0.18.0/src/virtio_queue/queue.rs.html).
Dependency mechanisms were checked against the locally installed versioned sources and the committed facade.

## Mechanism and trade-offs

Drain both queues into bounded descriptor metadata: at most 256 outstanding chains per direction, including the active TX chain.
Validate descriptor flags, direction, and guest memory before accessing packet bytes.
Keep one packet per direction rather than copying every deferred TX packet.

`TxBuffer` holds one gathered chain's bytes, head index, and partial-write offset until the stream accepts the whole frame.
`RxBuffer` retains prefix/body progress and one completed packet while waiting for a guest buffer.
An undersized RX chain completes with zero length and no partial guest write.
Each completion raises the interrupt decision immediately, as the existing facade requires.

The socket wrapper registers both readable and writable interests without changing the registrar.
The registrar returns the source ID used for both readiness and cleanup.
The production worker isolates activation generations; Net also ignores events for a replaced source.

Each direction receives a bounded processing budget per event.
The worker's argument-free waker schedules no device callback, so Net re-registers the socket to recheck readiness after budget exhaustion.
Register the replacement before removing the old source; a registration error follows the normal reset/cleanup path.
RX delivers a completed packet within the same iteration as its final read, even when that read exhausts the budget.
Consequently, no buffered work awaits a readiness edge that might never arrive; remaining work needs socket I/O or a guest kick.
WouldBlock and missing guest buffers never re-register merely to retry.
The production `SharedRuntime` test verifies continuation without another peer write or guest kick.

Errors latch `NeedsReset` and release the socket registration; reset/drop use the same cleanup path.
Snapshots retain the trait's unsupported defaults.

| Alternative | Decision | Reason |
| --- | --- | --- |
| Add queue-pop and interest-update APIs | Exclude | Changes shared virtio infrastructure |
| Buffer every packet | Reject | Increases memory under backpressure |
| Blocking socket I/O | Reject | Holds the device lock while waiting |
| Remove input validation | Reject | Guest and backend inputs remain untrusted |

## Validation

Use `make test:unit:vmm`, `make clippy:vmm`, and `make fmt:check:rust`.
Tests cover split headers, fragmented streams, exact completion, backpressure, invalid memory/descriptors, reset/drop, and unchanged-MMIO negotiation.
Budget continuation and RX resumption must work without further peer traffic.
The boundary test completes the last budgeted RX read while TX is blocked, proving delivery precedes yielding.

Count added source and configuration lines after formatting, including untracked files; exclude tests, documentation, assets, and lockfiles.
Verify that shared virtio files have no diff against the intended base.
Real gvproxy, Linux guest execution, and whole-VM snapshots are not qualified by these tests.

### TX budget and connection-failure coverage

The TX budget test injects interrupted writes followed by a one-byte socket
write, leaving one chain incomplete after all 256 attempts. The test-only
`transmit_for_test()` method accepts a write callback to control this boundary.
Production calls the argument-free `transmit()`, which supplies
`UnixStream::write` to the private `transmit_with()` implementation. Both entry
points use that same sending loop; the test entry lives in the `#[cfg(test)]`
module, without conditional parameters or arguments in the production path.
The real poller resumes TX before the peer reads or the
guest kicks again; the test checks the complete frame and its single completion.
This avoids depending on host socket-buffer sizes or signal timing.

The connection-completion test converts a listening Unix socket into an owned
stream descriptor with no connected peer. It dispatches `BackendReady` and
checks the `complete gvproxy connect` error, failure latch, registration cleanup,
and cleared active state. This covers `peer_addr()` failure, not the separate
`take_error()` error path or real gvproxy connection establishment.

On macOS ARM64, removing TX rearming made
`make test:unit:vmm FILTER=tx_budget_rearms_readiness_with_an_incomplete_chain`
fail with `TX budget must rearm readiness`; restoring it passed.
Independently removing the connection-completion check made
`make test:unit:vmm FILTER=pending_connect_completion_failure_releases_active_state`
fail at the exact error assertion; restoring it passed.
These mutation checks establish regression coverage for existing behavior,
not a newly fixed production defect. The 25 net tests, full VMM unit target,
`make clippy:vmm`, and `make fmt:check:rust` passed; these additions have not
yet been run on Linux.

### Malformed-descriptor socket closure

The malformed RX descriptor test sends a frame before dispatching readiness.
`Active::process` rejects the descriptor in `collect(RX)` before reading that
frame; error cleanup closes the stream with unread input. Linux's
[`unix_release_sock`](https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/534293368afa1a953c283310b82e4dc58309d51e/net/unix/af_unix.c#636)
sets the peer's error to `ECONNRESET` when a stream closes with unread data.
Thus the test's EOF-only assertion rejects valid cleanup on Linux.

Accept EOF or `ConnectionReset` for this RX case, retaining EOF-only checks for
TX. After a reset error, require a subsequent read to return EOF so the test
still rejects queued output. Keep the existing reset, deregistration, and
unused-ring assertions. No production behavior or shared interfaces change.
Draining input before closing would change device behavior merely to satisfy
the test; accepting arbitrary read errors would hide failures.

On Linux x86_64, the original test failed with `ConnectionReset`; the corrected
test passed. `make test:unit:vmm` passed 253 tests with 26 hardware tests ignored;
`make clippy:vmm` and `make fmt:check:rust` passed. The corrected test and Rust
format check also passed on macOS. Linux ARM64 was not rerun.
