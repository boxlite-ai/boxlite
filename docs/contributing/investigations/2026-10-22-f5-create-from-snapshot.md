# F5 create-from-snapshot verification

This is the historical six-round report. The user's renewed F5 request later
authorized rounds 7–9, [migration-backed cross-runner copying and real tenant
denial checks](2026-10-22-f5-copy-qualification.md). The limits below describe
the original cutoff, not the current implementation.

Implemented on parent `065085ca`; six of six rounds used. The
[attempt log](2026-10-21-runner-ci-attempts.md#f5) records each hypothesis,
change, command and outcome. See the [contract](../../guides/create-from-snapshot.md)
for storage ownership, cold boot, placement and compatibility limits.

## Real runner evidence

`make test:runner-ci:children` exits 0 in round 6. Evidence lives under
`.apps-local/feature-acceptance/2026-10-21/`; decisive log
`f5-r6-children.log`. This runs the native Python REST client, authenticated API,
Go runner, C/Rust runtime and actual Alpine 3.23 guests on this Mac arm64.
API port 13001, runner port 13003, guest Linux 6.12.87.

- S2: B and C preserve S's file contents, permissions and deletion despite later
  writes to A. Their guest boot IDs differ from A and each other.
- S3: B's writes leave A/C unchanged; after deleting A, B/C work and D boots
  from S. Deleting S leaves independent children usable.
- S4: API and runner processes restart, S is still queryable, and D is created
  afterward. Missing IDs fail explicitly. Native version/permission failures
  create no child records (`f5-r5-native-errors.log`).
- S5: distinct cold guest boots are proven. External/cache mounts and explicit
  replacement mounts remain NOT_RUN at this feature boundary; no cache claim.

Public A/B/C/D IDs: `ImBHrWOpluua`, `jBj7T7WArwbi`, `CPjdpQWU4xFS`,
`dQvs2a3pIXC2`; S `663c1cef-85d2-4d84-852e-8121e062d373`.
The successful probe deleted its resources. The retained JSON and guest output
are `.apps-local/runner-acceptance/snapshot-children-runner.json` and
`snapshot-children-runner-guest.log`. Copy these before another run if retaining
this exact scene. Only one runner participates here; second-runner placement,
cross-tenant HTTP denial and external volume replacement are not qualified by
unit assertions about routing and authorization.

## Failure reproductions and recovery

Round 4's V2 adapter omitted snapshotId: B booted the image, not S. The source,
wrong child and native snapshot remain under `~/.bl/142b9945/qa/`; exact IDs and
guest output are retained in `f5-r4-scene/`. Before the V2 fix was accepted,
all F5 production changes were reverted, retaining only the failing adapter test.
`make test:apps:api FILTER='forwards the snapshot identity'` reached the missing
field assertion (exit 2, `f5-r5-v2-before.log`); restored production passed.
Full revert/restore materials are in `f5-repro-backup/`.

Round 5 passed child creation but F4's duplicate-name check caught an error
translation regression: AlreadyExists became InvalidState. Its scene is
`f5-r5-scene/`; the pre-fix patch is `f5-r5-before-error-fix.patch` with new
files in the backup. Before the round-6 fix, the added service test reached the
missing top-level error-code assertion (`f5-r6-errors-before.log`, exit 2).
Flattening the runner error at the Nest boundary preserves its code and status.
Both the API test and real `make test:runner-ci:fs` then pass. The latter also
rechecks permission-failure cleanup and guest recovery (`f5-r6-fs.log`, exit 0).
Failed disks were retained before restarting these checkout-owned services.

## Checks and remaining limits

| Command | Result / local log |
| --- | --- |
| `make test:runner-ci:children` | PASS, `f5-r6-children.log` |
| `make test:runner-ci:fs` | PASS, `f5-r6-fs.log` |
| `make test:runner-ci:children-local` | PASS, `f5-r5-native-errors.log` |
| `make test:integration:snapshots` | 41 PASS, `f5-r5-regression.log` |
| `make test:unit:rust FILTER=snapshot` | 25 PASS, `f5-r6-rust.log` |
| `make test:apps:runner FILTER='MemorySnapshot\|Create' SETUP_DONE=1` | PASS, `f5-r6-runner.log` |
| `make test:unit:cli` | 275 PASS, `f5-r6-cli.log` |

Relevant API checks, Node binding tests/typecheck and F3's four mock/refusal
checks pass. Build succeeds with `VERSION=0.10.7-local GOFLAGS=-tags=boxlite_dev
make build:apps`; native development artifacts use `make dev:runner-ci
SETUP_DONE=1`. Full API/reference baseline failures are recorded in F3, not
hidden by this targeted verification. No Docker or Swarm acceptance is implied.
At that cutoff no seventh F5 round was authorized. The later renewed request
continues this ledger rather than resetting the attempt count.
