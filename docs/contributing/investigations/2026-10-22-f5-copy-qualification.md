# F5 cross-runner snapshot copy qualification

The renewed F5 work reuses the existing Box migration archive implementation.
`snapshot_copy` creates an independent snapshot on an explicitly selected runner;
ordinary `create_from_snapshot` then schedules to that owner. See the
[design](2026-10-22-snapshot-runner-copy-design.md) and
[public contract](../../guides/create-from-snapshot.md).

## Environment and evidence

macOS arm64, two runner processes on one Mac with separate runtime homes, ports
and disks; this does not establish operation across separate physical hosts.
Actual guest: Linux 6.12.87-boxlite-dind, aarch64; Alpine 3.23.6. The final copy
probe fixes `alpine:3.23.6`. The implementation base was `5d8cb0a2` with the F5
working patch; final publication is local only, folded into the F5 commit.

Logs: `.apps-local/feature-acceptance/2026-10-22-f5-copy/`.
Full guest output and resource identities:
`.apps-local/runner-acceptance/snapshot-copy-6d75489848.json` and its `-guest.log`.
Round 8's earlier full copy run is `snapshot-copy-c7b1ceb084`.
Round 7's additional explicit-cache run is `snapshot-copy-e299baf01a`.
Successful probes removed their Boxes, snapshots and (round 7) caches. Neither
copy probe left `snapshot-transfer-*` directories. Earlier failure scenes remain
untouched.

| Check | Status | Evidence / limit |
| --- | --- | --- |
| S1/S2, cross-runner disk point | PASS | `round9-security-e2e.log`: source additions, modification, deletion and mode 0640 survive copying; later source changes are absent |
| S3, independent identities/lifetimes | PASS | Four distinct guest boot IDs; B writes do not affect source/C; after deleting source and original snapshot, copied snapshot creates D |
| S4, runner restart | PASS | Both runners/API restarted; copied snapshot is queryable and creates D; D survives copy deletion |
| S4, unavailable owner/target and missing ID | PASS | Unschedulable destination rejected; missing/deleted IDs rejected; existing owner-placement refusal unit test retained |
| S4, incompatible format/permissions | PASS | `round7-native-errors.log`: actual unreadable manifest and version 999 rejected without a child; native qualification, not a substitute for runner copy |
| S4, corrupt transfer cleanup | PASS | Real runner importer rejects invalid archive (HTTP 500, bounded internal error); native Box/snapshot directories unchanged, temporary directories absent |
| S4, tenant/publication boundaries | PASS (unit) | `round7-final-api.log`: organization-scoped lookup, no runner access for foreign/memory input, typed destination errors, cleanup on catalog failure/duplicate name |
| S4, authenticated foreign tenant | PASS (real API) | Round 9 provisions a separately scoped local key, confirms an empty tenant, and gets NotFound for original-tenant snapshot lookup, child creation and copy; fixture credentials/organization removed |
| S5, cold boot / cache boundary | PASS | Distinct boot IDs; round-7 real cache run excludes source cache data and resolves independent child caches on the destination |
| SDK/type/capability regression | PASS | `node-contract.log`, `round7-runner-unit.log`; Python calls through actual SDK; OpenAPI parses in `openapi-inventory.log` |
| Original F5 lifecycle | PASS | `round7-children-regression.log`, record `children-0f01ec4ecd` |
| S6 memory | Unchanged | Production stays Unsupported; existing F3 MOCK_PASS does not mean RAM restore |
| Combined E | NOT_RUN in this F5 report | Copy removes the storage-placement obstacle; combined Swarm/cache qualification is separate |

## Continued attempt ledger

The original six rounds remain in the prior ledger. The user's renewed F5
instruction authorizes this extension; counters are not reset.

| Round | Observation → hypothesis → change | Validation/result |
| --- | --- | --- |
| 7 | No explicit cross-runner copy. Migration export/import can move a stopped snapshot child without running it. Added streamed copy, independent destination catalog ownership and SDK/capability contracts. | `round7-before-api.log` exits 2 on missing method (new-surface presence check, not a bug-regression proof). API, actual two-runner copy, old child lifecycle, native error and runner/Node checks exit 0. Initial lint exits 2 for import order and blocking HTTP in async probe. |
| 8 | Production copy works; harness quality and feature dependency need correction. Fix import order, await HTTP in a worker, make the standalone F5 probe independent of F6 cache support, fix Alpine patch version. Production behavior unchanged. | `make lint:snapshot-copy` exits 0; `make test:runner-ci:snapshot-copy` exits 0 (`round8-e2e.log`). No functional failure remains in the tested F5 surface. |
| 9 | Close the previously unqualified cross-tenant HTTP boundary using a separate authenticated organization, not mocked routing. Add only auth-fixture setup and real SDK negative assertions; production unchanged. | `make test:runner-ci:snapshot-copy` exits 0 (`round9-security-e2e.log`); full copy lifecycle repeated, all three foreign snapshot operations return NotFound. Lint passes after sorting the added import. |

## Reproduction and limits

Run commands individually from the repository root. Native builds must retain
the qualified kernel through `BOXLITE_LIBKRUNFW_SOURCE`:

```sh
BOXLITE_LIBKRUNFW_SOURCE="$PWD/.apps-local/runner-acceptance/firmware" make dev:runner-ci
make test:runner-ci:infra ACTION=restart
make test:runner-ci:snapshot-copy
make test:runner-ci:children
make test:runner-ci:children-local
make test:apps:api FILTER=SnapshotService
BOXLITE_LIBKRUNFW_SOURCE="$PWD/.apps-local/runner-acceptance/firmware" make test:apps:runner FILTER=Snapshot
BOXLITE_LIBKRUNFW_SOURCE="$PWD/.apps-local/runner-acceptance/firmware" make test:unit:node FILTER=snapshot
make test:rest:inventory
make fmt:snapshot-copy
make lint:snapshot-copy
```

Copy preserves filesystem crash consistency, not application consistency. It
does not migrate processes, RAM, external mounts or cache data. Four-minute API
deadline, 8 GiB compressed limit, same-region/class placement and compatible
architecture are explicit constraints. Process crash/lost completion may still
require reconciliation of unpublished native snapshots; no distributed atomicity
or automatic orphan collection is claimed. Existing migration format errors are
masked as a bounded internal wire error, with detailed runner-local diagnostics.
