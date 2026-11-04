# Native VMM virtio-vsock

## TL;DR

Implement a Unix-backed stream vsock device using the existing virtio interfaces.
Device-owned deferred requests provide bounded backpressure. VM attachment and
shared-runtime integration remain separate work; the poller added here is test-only.

## Scope

Implement explicit Unix socket mappings, three virtqueues, stream flow control,
reset and stopped-device snapshot hooks under `virtio/vsock`. Preserve the VM,
configuration, MMIO, interrupt, queue and shared-worker implementations at base
`fa313ab89`. No new production worker, guest kernel configuration, boot fixture,
runtime engine integration, address allocator or whole-VM snapshot orchestration.

## Related work and lessons

- [VIRTIO 1.2 §5.10](https://docs.oasis-open.org/virtio/virtio/v1.2/virtio-v1.2.html#x1-34600010)
  defines device 19, little-endian packet headers, RX/TX/event queues, stream
  credits, shutdown and transport reset. Use those wire contracts with no
  device-specific feature bits.
- [Firecracker's bridge](https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md)
  demonstrates userspace AF_UNIX/AF_VSOCK forwarding. Keep explicit port mappings
  and direct host bytes; do not adopt its CONNECT/OK host handshake or derive
  host paths from guest ports.
- [Firecracker's connection buffer](https://github.com/firecracker-microvm/firecracker/blob/main/src/vmm/src/devices/virtio/vsock/csm/mod.rs)
  is 64 KiB. Use that as a per-connection buffering policy, not a protocol MTU.
  Host reads in this implementation are limited to 4 KiB per turn.
- `src/vmm/src/virtio/queue.rs` at `fa313ab89` already supports
  `Completion::Deferred` and `complete`: outstanding heads are tracked and
  duplicate deferrals rejected. Reuse it without extending the common queue API.
- virtio-queue 0.18.0 chains and readers borrow guest memory. Parse bounded TX
  packets during intake; retain copied RX/event descriptor metadata instead of
  borrowed chains, self-referential state or guest descriptor-table pointers.
- The upstream registrar assigns readiness ids; its generation closes on stop.
  `WorkerControl::prepare` supplies activation resources. The test harness
  implements these interfaces without changing their production definitions.

## How it works

1. `Vsock` owns its CID and explicit listener/connect mappings. Callers own Unix
   paths. Host CID is 2; BoxLite's guest CID 3 and ports 2695/2696 remain caller
   conventions, without adding VM configuration.
2. Activation validates three ready queue slots and registers nonblocking socket
   sources. Failed registration drops the successful prefix. Guest connection
   requests reach only configured paths; host accepts produce guest REQUEST packets.
3. Drain captures TX packets and RX/event buffer metadata with Deferred, before
   completing any requests from that queue. Withholding completion prevents a
   conforming guest from recycling descriptors indefinitely during intake.
4. Outstanding requests are bounded by queue capacity, at most 256 TX packets
   with 64 KiB payloads each. Backend limits are 128 connections, 64 KiB pending
   guest data per connection and 256 outgoing packets.
5. TX packets reach the backend only when response capacity exists. RX copies
   checked packet bytes across captured writable buffers. Each head completes
   once; completion's notification decision determines whether to raise an interrupt.
6. Unix writes advance forwarded-byte counters only when successful. Host reads
   reserve peer credit before queuing data. Credit updates, source readiness and
   RX kicks resume stalled work; half-close preserves the other direction.
7. A final RX flush that frees capacity requests one continuation, including when
   backend I/O was skipped while output was full. Empty flushes add no wake.
   Reset drops deferred work, connections and registrations; listener mappings survive.

Deferred completion preserves guest ownership without adding Retry or bypassing
queue validation. Completing copied TX immediately could allow guest resubmission
to extend drain indefinitely. RX requires only buffer metadata, not copies of
empty guest buffers. Per-connection buffers and deferred TX storage have separate
bounds; 64 KiB is not a device-wide memory limit.

## Snapshot contract

Quiesce preserves streams, deferred requests and pending bytes for resume. Saving
requires quiescence and records versioned CID, negotiation state and queue state.
Inactive devices round-trip; active save/restore propagates the unchanged queue
snapshot stub's unsupported error. Future queue snapshots must account for
outstanding deferred requests.

Restore validates identity, version, lengths, flags and queue metadata before
publishing state. A restored active device would create a fresh backend and
send TRANSPORT_RESET on the event queue before ordinary traffic. Host descriptors
and stream bytes are not serialized. Tests exercise reset-event delivery with
prepared queues; they do not prove an active snapshot round-trip.

## Test boundary and remaining integration

`tests/vsock/worker.rs` drives real socket readiness and the unchanged MMIO
transport in tests. Each preparation creates a fresh registrar; stop/cancel
close its sources. Tests cover negotiation, interrupts, reset and reactivation.
The test module is the only caller of this added poller.

The test poller schedules a queue callback for continuation. The upstream shared
runtime's waker currently only wakes its poller. Production shared-runtime
attachment and continuation scheduling remain unqualified, as does real-guest
AF_VSOCK interoperability. `Vm::new` does not attach this device.

## Validation

- `make test:unit:vmm` → 196 VMM and 11 hypervisor tests passed on macOS arm64;
  18 hardware-dependent hypervisor tests were ignored.
- `make clippy:vmm` and `make fmt:check:rust` → passed.
- Guest-memory tests cover deferred completion, ordered backpressure recovery,
  captured scatter buffers, malformed descriptors, credit stalls and reset cleanup.
- Unix socket tests cover both connection directions, partial writes, half-close,
  activation rollback, pause/resume and transport-driven callbacks.
- `git diff --check` → passed. VM, MMIO, interrupt, queue, shared-worker and error
  implementations have no changes relative to `fa313ab89`.
