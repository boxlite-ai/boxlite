# Runner CI features: local design

## F1 resumption (2026-10-22, before implementation)

The user reopened F1 without an attempt limit; keep the original D1/D2 assertions
and continue numbering after round 6. Other features' acceptance is unchanged.

- Restore guest-only `advanced.privileged` across Python, REST capability
  negotiation, authenticated API persistence, runner and C/Go. Preserve host
  security defaults. Reject unsupported capability combinations explicitly;
  exclude privileged requests from incompatible warm-pool reuse.
- Build Linux 6.12.87 using the vendored libkrunfw patches and built-in Docker
  networking/cgroup/overlay requirements. The previous builder omitted `start()`;
  `bin2cbundle.py` also imports pyelftools. Supply both prerequisites, bound build
  execution and preserve failed builders. Use a source checksum and verify each
  requested Kconfig symbol after dependency resolution.
- Package the resulting kernel.c into the libkrunfw dylib through the existing
  native build and SDK/runner distribution path. An explicit build-time source
  directory selects this firmware; editing unused vendor config is insufficient.
  Keep custom-kernel REST rejection: no user-controlled host kernel paths.
- Docker data stays on the guest writable ext4 disk (`overlay2`, Docker 27.5.1,
  `/var/lib/docker`); this feature adds no cache or snapshot semantics. Placement
  remains ordinary runner scheduling; qualify the actual assigned runner.
- Preserve bridge networking, DNS, NAT and firewall rules. Docker's
  [firewall guidance](https://docs.docker.com/engine/network/packet-filtering-firewalls/#prevent-docker-from-manipulating-firewall-rules)
  explains why disabling iptables breaks bridge behavior. Its
  [overlay2 guidance](https://docs.docker.com/engine/storage/drivers/overlayfs-driver/#configure-docker-with-the-overlay2-storage-driver)
  requires checking the actual driver/backing filesystem. Use the pinned image's
  entrypoint as runtime evidence; the historical upstream `/27/dind/` URL is gone.
- Validate the builder lifecycle first, then rebuilt guest kernel identity and
  actual nft/iptables operations. D1 must prove guest dockerd, pull/build/run with
  a unique marker; D2 must prove Compose service-name HTTP with expected content.
  Capture image digests, versions, mounts, daemon logs and runner identity. Run
  affected unit/regression checks through standalone make targets. On failure,
  retain evidence before cleanup; no mocks or network bypasses qualify F1.

Sources rechecked: `src/deps/libkrun-sys/build.rs::build` (macOS always consumes
the prebuilt kernel source), vendored `libkrunfw/Makefile` (kernel 6.12.87,
ABI 5), `bin2cbundle.py` (ELF import), `rest/runtime.rs::sanitize_remote`
(privilege rejected), and `compose/acceptance.py::dind` (existing real harness).
The old `/health` probe is already corrected by the retained harness. Reuse it.

## TL;DR

Extend Python SDK → API → runner → runtime → guest for guest Docker, snapshots
and runner caches. Qualify actual behavior separately from the memory-snapshot
mock. All artifacts remain local. Each capability requires its own implementation,
behavioral acceptance and local commit.

## Scope and existing implementation

Base: `d3fb1fce`, branch `vibe_features`, inspected 2026-10-21. Preserve the
user's `.codex/hooks.json` modification and untracked `target` symlink.
Six feature commits; no remote publication, size exception, tracking issue or
commit-push-auditor. Failed features get incomplete/blocked reports instead of
unverified production changes. Each feature has at most six real attempt rounds.

| Feature | Existing | Required extension |
| --- | --- | --- |
| F1 DinD | Guest privileged capabilities and writable sys/cgroup mounts | Remote options/capability, persisted API configuration, Go/C runner forwarding; D1/D2 |
| F2 Swarm | Box network, TCP dialing and HTTP exposure | Guest node addresses, TCP/UDP transport, actual kernel IPVS/VXLAN; D3–D10, M1–M6 |
| F3 memory | SnapshotOptions, SnapshotBackend, per-box handles | Explicit memory type, create/query/create-box contract, test-only injection, production Unsupported |
| F4 FS | SnapshotManager, SQLite metadata, qcow2 forks, freeze/thaw | Runner/API ownership; immutable, consistent live disk capture; S1/S4/S5 |
| F5 create | Clone/import and CoW helpers | Snapshot-owned disks, independent children and source deletion, runner placement; S2–S5 |
| F6 cache | Managed S3/FUSE volumes, runner mount records | Distinct local cache type, tenant isolation, persistent exclusive leases; V1–V5 |

Source observations:

- `src/boxlite/src/rest/runtime.rs::sanitize_remote` refuses privileged.
  `apps/api/src/boxlite-rest/boxlite-config.controller.ts` declares snapshots,
  clone, export and import disabled. Local capability is not runner support.
- `src/boxlite/src/litebox/snapshot_mgr.rs` owns snapshots under source box
  directories and removes them with the box. F5 needs independent ownership.
- `src/boxlite/src/disk/mod.rs::fork_qcow2` renames a disk and creates a child
  at the old path. Open VMM file descriptors need explicit auditing: rename alone
  does not make the old inode immutable. Reproduce before modifying this behavior.
- `with_quiesce_async` freezes, SIGSTOPs, operates, SIGCONTs, then thaws. Review
  cancellation, freeze timeout and failed thaw; ordinary Result cleanup does not
  establish cancellation safety. Do not claim application consistency.
- `src/deps/libkrun-sys/build.rs` downloads v5.4.0 prebuilt kernel data on macOS.
  Changing vendored kernel configuration alone does not change the booted kernel.

## Research and decisions

The [reference matrix](https://gist.github.com/matzeeable/f6619d359144dade26363b5f2a418c42)
separates VIP, DNSRR, ingress and cold disk cloning. Keep independent assertions;
never replace a failing mode with another mode.

[Docker Swarm setup](https://docs.docker.com/engine/swarm/swarm-tutorial/#open-protocols-and-ports-between-the-hosts)
requires a reachable manager and 2377/TCP, 7946/TCP+UDP and 4789/UDP.
[Overlay requirements](https://docs.docker.com/engine/network/drivers/overlay/#requirements)
separate discovery from dataplane. HTTP proxying cannot provide those semantics.
Use actual node transport; retain guest Docker engines and overlay internal traffic.

[Docker overlay2 prerequisites](https://docs.docker.com/engine/storage/drivers/overlayfs-driver/#prerequisites)
and [kernel upper filesystem requirements](https://docs.kernel.org/filesystems/overlayfs.html#upper-and-lower)
require xattrs and valid directory entry types. A bind mount succeeding is not
proof of Docker store compatibility. Pin Docker 27.5.1, classic overlay2 and
`/var/lib/docker`; record image digest, Compose version and actual backing FS.

[qemu-img](https://www.qemu.org/docs/master/tools/qemu-img.html#description)
warns against offline modification of an active image. Prefer existing CoW helpers
only after proving disk ownership/quiescence. Avoid a new disk format or VMM rewrite.

## Contracts, lifecycle and scheduling

**F1/F2.** Privileged applies inside the guest; runner jailer policy remains in
force. No runner Docker socket. Capability advertisement must match remote wire
acceptance. Two local runners with independent homes/ports are the user-approved
different-runner topology; disclose that both run on the same physical Mac.

**F3.** Add explicit `filesystem` (default) and `memory` types. Create/query
responses identify type and status. Production memory creation and create-box
return Unsupported, without FS fallback. Mock injection exists only in explicit
test assembly; no production request can enable it or advertise real RAM support.

**F4/F5.** Snapshot identity belongs to organization + owning runner, independently
of source box. Persistent metadata stores type/version and disk references.
Public IDs never expose host absolute paths. Capture the container writable disk;
exclude runtime boot disk, RAM, processes, external volumes and caches.

Children cold boot with new IDs, network identities and writable layers. External
mounts are explicit create inputs. Schedule onto the snapshot owner or reject
inaccessibility. Retain referenced disks or reject deletion. Validate tenant,
name, type, version and permissions before disk changes; clean partial creates.
Freeze/flush and thaw/resume need bounded recovery, including errors/cancellation.
Claim crash consistency only after observing it; application consistency needs
application coordination and is not promised.

**F6.** Resolve `(organization, cache ID)` after placement below a private runner
cache root. Preserve existing durable volume semantics. Never pin scheduling,
synchronize caches or migrate them. Box deletion retains cache; runner restart
reconstructs occupancy from actual local VM state. Reject traversal, cross-tenant
access, active deletion and concurrent Docker writers. GC only explicitly idle,
unleased caches. Persist Docker version/driver/data-root configuration and reject
incompatible reuse. Stop dockerd normally before sequential reuse; handle crash
recovery without releasing a live daemon's lease. FS snapshots exclude cache data
and runner absolute paths; children attach caches explicitly.

## Validation and failure handling

Every test is an independent `make test...` command with revision, log and exit
code. Add reusable targets for real SDK/API/runner scenarios and S6 mock contract.
Use deadline-based readiness; retain guest, dockerd, Swarm, DNS/IPVS, placement,
network and disk evidence. Record image/kernel/Docker/Compose/driver versions.

Run D1–D10; M1–M6 separately for same-runner and different-runner; S1–S6; V1–V5;
then the combined lifecycle. Only S6 may report MOCK_PASS. Missing infrastructure
is BLOCKED/NOT_RUN. Existing unit tests cannot qualify any of these behaviors.

For each attempt: symptom → hypothesis → change → command → result. Preserve
failure logs/disks and unfinished patches before cleanup. After six failed rounds,
stop that feature and continue independent features. External blockers may stop
earlier; retries and log reads do not consume or reset feature attempt counts.
Bug tests must fail with all production changes reverted, then pass with fixes.

## Initial environment and subsequent qualification

macOS 27.0.1 (Darwin 27.0.0), arm64, 16 GiB RAM; Rust 1.97.1, Go 1.26.5,
Node 26.11.0. Initial free disk approximately 49 GiB. Base native build succeeded.
The existing target symlink pointed to a deleted directory; recreate its target
without altering the symlink. local-infra then failed pulling `minio/minio:latest`
with UNAUTHORIZED. All seven created L1 records are failed; no L2 API/runner started
from this checkout. Subsequent port inspection found an existing healthy API/runner
from `boxlite_wt3` occupying 3001/3003 and its Postgres occupying 25432. Preserve
those processes. The current stack needs isolated ports as well as separate homes;
do not test that other checkout and report it as this checkout's implementation.

The external-design binding hook was disabled by the user before implementation.
Private logs: `.apps-local/feature-acceptance/2026-10-21/` in the worktree.

Subsequent F1 qualification started isolated PostgreSQL/Redis guests and an
API/runner on 13001/13003, avoiding the MinIO dependency and occupied ports.
It exposed a missing Python privileged binding (the initial inventory had
overstated SDK coverage), then reached a real Docker guest after extending
the binding. The booted kernel lacked netfilter. The sixth round failed to
start its kernel-builder Box; F1 stopped and its production changes were
removed. See [the failure report](2026-10-21-f1-dind-incomplete.md).

## F4 implementation decision (2026-10-22, before edits)

First reproduce live-disk mutation with an actual guest and a checksum of the
snapshot disk before/after a synced source write. If reproduced, reuse
`Qcow2Helper::flatten` to produce an independent disk while quiesced, without
renaming the live inode. Preserve the existing per-Box snapshot store for F4;
independent ownership after source deletion belongs to F5. No external mount
data or mount paths go into snapshot metadata. Creation remains crash-consistent,
never application-consistent. Cancellation must not abandon thaw/resume.

Expose the same snapshot facade through C/Go and authenticated API owner routing.
Keep memory explicitly unsupported. Verify metadata persistence, deletion and
invalid requests through Python REST → API → runner → native runtime → guest.
Current PostgreSQL integration failures need environment diagnosis before that
chain can qualify. Local-only VM tests count as defect evidence, not S acceptance.
