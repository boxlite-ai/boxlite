# Local runner CI feature delivery

**The agreed two-local-runner path is now qualified.** After the user reopened F1 without a round limit,
[D1/D2 passed](2026-10-22-f1-dind-qualification.md). The later unlimited
F2/F6 resumption passes [Swarm D3–D10 and both runner topologies](2026-10-22-f2-swarm-qualification.md)
and [cache V1–V5](2026-10-22-f6-cache-qualification.md). The renewed
[F5 copy capability](2026-10-22-f5-copy-qualification.md) reuses migration archives;
[combined E now passes](2026-10-22-combined-snapshot-swarm-cache.md) after correcting
the Docker cache DNS search profile. F3 remains the explicitly scoped MOCK_PASS,
and separate physical hosts are not qualified.

The tables below preserve the **original delivery before F1 resumed**, including
the original commit SHAs and blocking reasons. The six feature commits were
subsequently consolidated locally; use `git log` for their current SHAs.
At the original cutoff, F1 failed at six rounds, blocking F2 and Docker F6.
F3 is only the agreed interface/mock contract.
FS snapshots, cold independent children and ordinary local caches have actual
runner/guest evidence. Nothing was pushed and no PR or external issue was created.

## Original feature commits (historical)

| Feature | State | Local commit | Delivery |
| --- | --- | --- | --- |
| F1 DinD | FAIL / INCOMPLETE | `43ba6f6a` | Failure report; unverified production draft removed |
| F2 Swarm | BLOCKED | `9a49d5a5` | Dependency/kernel/network qualification report |
| F3 memory | MOCK_PASS | `6fc9aec5` | Type/contracts, explicit test mocks, production Unsupported |
| F4 FS snapshots | Implemented; real core path PASS | `065085ca` | Immutable writable-disk capture, metadata, query/delete/restore, recovery |
| F5 snapshot children | Implemented; real core path PASS | `c16be9c7` | Independent ownership, cold children, source deletion, owner placement |
| F6 caches | INCOMPLETE; ordinary cache PASS, Docker BLOCKED | this commit | Runner-local cache/leases plus explicit incomplete report |

F5's final format-only amend replaced `6010f8a9`; earlier receipts retain the
revision actually used at run time. All six commits stay on `vibe_features`.
The user's disabled `.codex/hooks.json` and untracked `target` symlink are preserved.

## Complete acceptance matrix at the original cutoff

Evidence paths below are relative to `.apps-local/feature-acceptance/2026-10-21/`.
`F1` means the [DinD failure record](2026-10-21-f1-dind-incomplete.md);
`F2` means the [Swarm block record](2026-10-22-f2-swarm-blocked.md).
Neither skipped nor mocked execution qualifies a real feature.

| ID | State | Evidence | Remaining issue |
| --- | --- | --- | --- |
| D1 | FAIL | F1, actual guest dockerd log | nft protocol absent; info/pull/build/run not passed |
| D2 | BLOCKED | F1 dependency | Compose requires working guest daemon |
| D3 | BLOCKED | F1/F2 | Swarm init unqualified |
| D4 | BLOCKED | F1/F2 | Overlay replicas/traffic unqualified |
| D5 | BLOCKED | F1/F2 | Default VIP, DNS and IPVS unqualified |
| D6 | BLOCKED | F1/F2 | Independent DNSRR unqualified |
| D7 | BLOCKED | F1/F2 | Ingress through BoxLite exposure unqualified |
| D8 | BLOCKED | F1/F2 | Host publish unqualified |
| D9 | BLOCKED | F1/F2 | Guest host networking unqualified |
| D10 | NOT_RUN | F1 actual kernel version retained | No functional IPVS/VXLAN proof |
| M1 same runner | BLOCKED | F1/F2 | No Ready/Active multi-Engine cluster |
| M2 same runner | BLOCKED | F1/F2 | No directed cross-node overlay pairs |
| M3 same runner | BLOCKED | F1/F2 | VIP and DNSRR not independently qualified |
| M4 same runner | BLOCKED | F1/F2 | Ingress via node without task not qualified |
| M5 same runner | BLOCKED | F1/F2 | Topology's Swarm suite not executed |
| M6 same runner | BLOCKED | F1/F2 | No task/overlay dataplane proof |
| M1 different runners | BLOCKED | F1/F2 | Two runner processes now exist; Docker does not work |
| M2 different runners | BLOCKED | F1/F2 | No directed cross-node overlay pairs |
| M3 different runners | BLOCKED | F1/F2 | VIP/DNSRR unqualified |
| M4 different runners | BLOCKED | F1/F2 | Cross-node ingress unqualified |
| M5 different runners | BLOCKED | F1/F2 | Swarm suite not executed; both runners share one Mac |
| M6 different runners | BLOCKED | F1/F2 | No cross-node Swarm evidence |
| S1 | PASS | `f5-r6-fs.log`, F4 report | Alpine 3.23 file create/change/delete/permissions captured |
| S2 | PASS | `f5-r6-children.log` | Actual B/C preserve S after A writes |
| S3 | PASS | `f5-r6-children.log` | B/C independent, A deleted, D created, S deleted safely |
| S4 | PASS | `f5-r6-fs.log`, `f5-r6-children.log` | Restart and normal errors verified; format/permission child errors tested natively in `f5-r5-native-errors.log` |
| S5 | PASS | `f5-r6-children.log`, `f6-r3-cache-strict.log` | Cold boot, external cache exclusion and explicit child mounts; separate S3/GCS backend not exercised |
| S6 | MOCK_PASS | `f5-r5-memory-regression.log`, F3 report | No RAM/CPU/device state implemented |
| V1 | PASS | `f6-r3-cache-strict.log` | Same-runner sequential ordinary-cache reuse |
| V2 | PASS | same | Two independent runner homes on one Mac |
| V3 | PASS | same, `cache-b61dd0fae5-crash/` in runner-acceptance | Restart, tenants, deletion/refusal/initialization |
| V4 | BLOCKED | F1 and F6 incomplete reports | Actual Docker image/build reuse and backing-FS compatibility unqualified |
| V5 | BLOCKED | `f6-r3-cache-strict.log` proves ordinary lease only | Actual dockerd concurrency/crash recovery unqualified |
| E | BLOCKED | F1/F2/F6 | Snapshot→children→caches passes; Swarm/Docker portion cannot run |

Additional unqualified boundaries: F5 owner-unavailable placement and cross-tenant
snapshot access have unit/contract checks, not a complete two-runner negative HTTP
suite. Full API/reference regressions retain baseline failures documented in F3.
No production memory support or performance improvement is claimed.

Final FS/children regressions after the two-runner cache changes also pass:
`f6-r3-joint-fs.log` and `f6-r3-joint-children.log`. The latter records fresh,
distinct boot IDs for A/B/C/D. These runs do not qualify the blocked Swarm/Docker
steps of the combined E path.

## Attempt budgets

| Feature | Used | Decisive hypothesis/result | Stop reason |
| --- | --- | --- | --- |
| F1 | 6/6 | Remote privilege path reached guest; actual nft missing; kernel builder round failed | Limit reached; draft retained then removed |
| F2 | 0/6 | Working Engines and kernel dataplane prerequisite absent | Upstream block |
| F3 | 3/6 | Explicit type/mock marker and Unsupported contract pass | Agreed interface/mock scope complete |
| F4 | 4/6 | Live renamed inode mutated S; flattened capture fixes it | Real capture/error recovery passes |
| F5 | 6/6 | V2 omitted snapshotId; then error wrapping hid code; both fixed and passed | No seventh round; core path verified |
| F6 | 3/6 | Persistent leases work; configuration and scoped-key fixtures corrected | Ordinary cache verified; Docker blocked upstream |

Full observations, edits, commands and results are in the
[attempt log](2026-10-21-runner-ci-attempts.md).

## Reproduction and retained material

Use one command per test, optionally redirecting its output. Builds:
`make dev:runner-ci SETUP_DONE=1` and
`VERSION=0.10.7-local GOFLAGS=-tags=boxlite_dev make build:apps`.
On this Mac, prepend `/opt/homebrew/bin` to PATH.

- Infrastructure: `make test:runner-ci:infra ACTION=verify`, `ACTION=restart`,
  or `ACTION=two-runners`. A fresh isolated stack uses `ACTION=up`.
- FS: `make test:runner-ci:fs`; native defect probe `make test:runner-ci:fs-local`.
- Children: `make test:runner-ci:children`; native format/permission errors
  `make test:runner-ci:children-local`.
- Cache: `make test:runner-ci:cache`; two local runners are required.
- Memory contract: `make test:unit:python FILTER=memory_snapshot` (MOCK_PASS only).
- VM regressions: `make test:integration:snapshots`.

Local state is `.apps-local/runner-acceptance/`: PID files, API/runner logs,
Box IDs, guest outputs and deliberate crash scenes. Logs may contain local
credentials and are not committed. Runtime homes `~/.bl/142b9945/qa` and `qb`
hold runner state; `qh` holds the isolated infrastructure guests.

F1's unfinished patch is `f1-r6-unfinished.patch`, with sources and scene in
`f1-r6-sources/` and `f1-r6-scene/`. F4's original immutability failure is in
`f4-r1-scene/`. F5's failed scenes are `f5-r4-scene/`, `f5-r5-scene/`, and its
full revert/restore evidence is `f5-repro-backup/`. F6's failed tenant fixture is
`f6-r2-scene/`; the ordinary verified draft is retained as
`f6-r3-verified-draft.patch` plus `f6-r3-new-files/`.
See the feature reports for exact retained native Box directories and hashes.
