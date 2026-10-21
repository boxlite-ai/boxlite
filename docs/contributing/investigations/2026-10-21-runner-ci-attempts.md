# Runner CI acceptance attempts

## Environment

Base `d3fb1fce00f0db67d435250cfa5f5550469b0c55`, branch `vibe_features`.
macOS 27.0.1, arm64; Rust 1.97.1, Go 1.26.5, Node 26.11.0.
Private logs: `.apps-local/feature-acceptance/2026-10-21/`.
F1's unfinished production changes were saved locally and removed after round 6.

## F1

1. Existing remote clients reject guest privilege. Hypothesis: forwarding the
   existing guest option, without changing host security, enables DinD remotely.
   Added capability negotiation, API persistence, C/Go/runner forwarding and
   isolated acceptance harness. `make test:unit:rust FILTER=privileged` exited 2:
   old wire-type tests accessed the now-optional capability policy directly
   (`E0609`). Log `f1-r1-rust.log`; no guest acceptance executed.
2. Updated old tests for optional capabilities. Same command exited 2 with
   `E0507` (test attempted to move out of a borrowed request). Log
   `f1-r2-rust.log`. This is a test adaptation failure, not Docker evidence.
3. Borrow policy with `as_ref()`: unit tests pass; infrastructure probe uses the
   wrong runner health path and times out.
4. Correct health probe: infrastructure passes; DinD fails at Python constructor.
5. Add missing Python binding: real guest starts; dockerd fails on missing nft.
6. Draft kernel build: builder was never started; build fails. Stop at the cap.

See [F1's complete failure record](2026-10-21-f1-dind-incomplete.md) for commands,
exit codes, hypotheses, versions, retained patch and guest evidence.

### F1 resumed (2026-10-22; user removed the attempt limit)

7. Restore the explicit builder lifecycle and install pyelftools. Builder
   `ZFIacy695Ca6` starts, downloads and verifies Linux 6.12.87, applies all vendor
   patches, then stops at `Kconfig refused NFT_COUNTER`: that old symbol no
   longer exists. `make kernel:dind` exits 2. Upstream 6.12 netfilter/Makefile
   includes nft_counter.o directly in NF_TABLES; remove the obsolete separate
   symbol and include NFT_CHAIN_NAT. No kernel artifact yet. Log:
   `.apps-local/feature-acceptance/2026-10-22-f1-resumed/r7-kernel-build.log`.
8. Counter support is built in, but the proposed NFT_CHAIN_NAT replacement is
   also obsolete: `make kernel:dind` exits 2 at the symbol assertion. Check
   upstream Kconfig and Makefile together: NFT_NAT includes nft_chain_nat.o.
   Remove both obsolete symbols; retain NF_TABLES/NFT_NAT and check all requested
   symbols in one pass. Log `2026-10-22-f1-resumed/r8-kernel-build.log`.
9. All requested Kconfig assertions pass and real kernel compilation proceeds.
   `make kernel:dind` exits 2 because the vendored IKHEADERS configuration also
   needs cpio. Install cpio and resume the retained build tree. Log
   `2026-10-22-f1-resumed/r9-kernel-build.log`; kernel/Makefile:159 reports the
   missing executable. No kernel feature was disabled to bypass this failure.
10. Install cpio; kernel compilation and firmware packaging pass. Build SDK and
    runner with `BOXLITE_LIBKRUNFW_SOURCE`, restart the isolated API and both
    runners, then `make test:runner-ci:dind` exits 0: actual guest kernel
    `6.12.87-boxlite-dind`, Docker 27.5.1 overlay2/ext4, pull/build/run and Compose
    HTTP 200 with the unique marker. Source defaults still preserve host sandbox.
    See [resumed qualification](2026-10-22-f1-dind-qualification.md) for regression
    commands, before/after evidence and artifacts. F1 completes after ten total
    rounds, four after reopening; other features are not requalified by this run.

## Remaining features

F2: zero rounds, BLOCKED by F1; see [Swarm report](2026-10-22-f2-swarm-blocked.md).
F6: zero implementation/verification rounds. No acceptance claim yet.

## F3

1. Missing memory type and create-from contract: add explicit type, mock marker,
   SDK/wire contracts and production Unsupported handlers. Core snapshot tests
   pass (25); `make dev:python SETUP_DONE=1` exits 2 on an unclosed method, and
   `make test:apps:api FILTER=memory` exits 2 on nonexistent READ_BOXES enum.
   Logs: `f3-r1-rust.log`, `f3-r1-python-build.log`, `f3-r1-api.log`.
2. Hypothesis: binding syntax and permission naming prevent reaching contract
   checks. Close the Python method and use the existing authenticated read
   policy (there is no separate read-boxes permission); update Node contracts.
   SDK mock/local-refusal 4 tests, API memory 6, runner, CLI 275 and Node binding
   5 pass. Python lint fails import sorting. Full API exits 2: new routes were
   missing from the permission audit; other failures require baseline comparison.
   Logs `f3-r2-*.log`.
3. Fix import order and enumerate the new routes in the permission audit. Add
   missing-snapshot restore assertion and verify reference-server SDK adaptation
   with all production changes reverted first. Reproduction reaches the old
   positional SDK call (TypeError) and missing `guest_disk_bytes` (AttributeError).
   With changes restored, the reference snapshot checks pass; SDK 4, API contract
   63, Python lint and Node typecheck pass. S6 = MOCK_PASS, 3/6 rounds used.
   Full API and reference regressions retain unrelated failures; see
   [F3 verification](2026-10-22-f3-memory-contract.md).

## F4

1. Hypothesis: the live VMM still writes its open fd after snapshot renames the
   disk. Add actual Alpine 3.23 guest regression before production edits.
   `make test:runner-ci:fs-local` exits 2 at the immutability assertion: snapshot
   SHA-256 changes after a synced source write. Log `f4-r1-local-before.log`;
   metadata/guest diagnostics in `f4-r1-scene/`; disks remain in
   `~/.bl/142b9945/qf/boxes/dwLHKNpnzCGj/`. Runtime base `6fc9aec5`.
2. Replace live rename with an independent flattened disk; keep capture task
   alive through client cancellation, always attempt thaw after freeze timeout.
   Add C/Go facade and API/runner routes. Native build and actual local regression
   pass (`f4-r2-python-build.log`, `f4-r2-local-after.log`). Rust formatting fails
   because serde was incorrectly inherited from workspace dependencies that do
   not declare it (`f4-r2-fmt-rust.log`, exit 2); runner build not reached.
3. Use the existing crates' serde version declarations directly; correct allocated
   disk-size accounting and reject memory on every C facade operation. Verify
   C/Go build and core/API regressions pass. The isolated service restart stops
   listeners but the bind probe rejects TCP TIME_WAIT sockets (no listeners in
   lsof). `make test:runner-ci:infra ACTION=restart` exits 2; `f4-r3-restart.log`.
4. Make the bind probe use SO_REUSEADDR, preserving refusal of live listeners;
   allow restart to resume after already-stopped services. Real SDK/API/runner
   capture, immutability, runner restart, restore, metadata and deletion pass.
   Force a real permission failure during capture: guest writes succeed afterward,
   no snapshot metadata or partial directory remains. Preserve public Box IDs in
   runner responses. `make test:runner-ci:fs` exits 0 twice, including the failure
   injection (`f4-r4-runner-fs-errors.log`). `make test:integration:snapshots`
   exits 0 (41 actual VM tests); native Go snapshot facade tests also pass.

## F5

1. Source-owned storage prevents deletion survival. Add independent snapshot
   storage, versioned boot manifests, runtime lookup/delete/create-from contracts
   and Python/C facades. `make dev:python SETUP_DONE=1` exits 2: three new methods
   were placed outside `impl BoxliteRuntime` by an incorrect patch anchor.
   `f5-r1-python-build.log`; no VM acceptance reached.
2. Place the methods inside an impl; extend authenticated API catalog and runner
   owner placement. Python build passes; `make dev:runner-ci SETUP_DONE=1`
   exits 2 because cgo returns uint32 rather than the named C enum type.
   `f5-r2-build.log`.
3. Match the actual cgo return type and handle native NotFound during idempotent
   child creation. Build passes. `make test:runner-ci:children-local` passes real
   S2/S3 behavior locally (not runner acceptance). Targeted API tests fail on an
   obsolete proxy fixture (`res.status is not a function`), because snapshot
   ownership now crosses the catalog service. Logs `f5-r3-{build,local,api}.log`.
4. Adapt the routing test to the catalog boundary and include new runtime-level
   routes in the permission audit. Relevant API tests pass; API webpack build
   passes (whole apps build fails its existing runner version environment gate).
   Real runner child boots original image: V2 job payload omitted snapshotId.
   `f5-r4-children.log`, exit 2. Source/child disks and snapshot remain on runner;
   identifiers and guest evidence saved in `f5-r4-scene/` before service cleanup.
5. Forward snapshotId in the actual V2 job path. With ALL F5 production changes
   reverted, new adapter test reaches the missing-field assertion and fails:
   `make test:apps:api FILTER='forwards the snapshot identity'`, exit 2,
   `f5-r5-v2-before.log`. Production restored from `f5-repro-backup/`; no test-only
   compatibility adapter needed. Real runner S2/S3, restart and snapshot deletion
   pass (`f5-r5-children.log`). Native version/permission failures leave no children
   (`f5-r5-native-errors.log`). F4 regression finds duplicate-name errors have
   lost their code in Nest's filter: AlreadyExists becomes InvalidState.
   `f5-r5-fs-regression.log`, exit 2; scene retained in `f5-r5-scene/`.
6. Hypothesis: nesting the runner error in HttpException hides its code from the
   existing flat Nest error filter. Before this round's production fix, a service
   regression fails at the missing top-level code/message (`f5-r6-errors-before.log`,
   exit 2); the complete preceding implementation is retained as
   `f5-r5-before-error-fix.patch` plus the new-file backup. Flatten message/code
   at the API boundary, leaving status unchanged. API regression, Rust unit,
   runner, native build and apps build pass. Real `make test:runner-ci:fs` and
   `make test:runner-ci:children` exit 0 (`f5-r6-fs.log`,
   `f5-r6-children.log`): typed errors survive, failed capture recovers the guest,
   children have distinct boot IDs and independent disks, and source/snapshot
   deletion and process restart preserve the documented lifecycle. Six rounds
   used; no further implementation round is available for F5.
