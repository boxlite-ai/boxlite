# F4 filesystem snapshot verification

Implemented on parent `6fc9aec5`; four of six rounds used. See the
[attempt log](2026-10-21-runner-ci-attempts.md#f4) and
[contract](../../guides/filesystem-snapshots.md). F4 does not claim F5 child
creation or F6 cache-volume acceptance.

## Defect and before/after evidence

Before any F4 production edits, `make test:runner-ci:fs-local` failed (make exit 2)
because a synced source write changed the supposed immutable snapshot's SHA-256.
The VMM retained the renamed disk fd. Base `6fc9aec5`, Alpine 3.23, arm64,
booted Linux 6.12.87. Box `dwLHKNpnzCGj` and its disks remain locally under
`~/.bl/142b9945/qf/boxes/dwLHKNpnzCGj/`. Logs and guest diagnostics:
`.apps-local/feature-acceptance/2026-10-21/f4-r1-local-before.log` and
`f4-r1-scene/`. The full reproduction is the committed local acceptance probe.

With standalone flattened capture, the same probe passes and cold restore
preserves contents, permissions and deletion. `f4-r2-local-after.log`, exit 0.

## Real runner qualification

`make test:runner-ci:fs` exits 0; decisive log `f4-r4-runner-fs-errors.log` in the
same log directory. It exercises actual native Python REST, API, Go runner, C ABI,
Rust runtime and guest. No mock participates. Public Box `1wgAtlattFKI`, runtime
Box `iCdCuEihzbim`, snapshot `sDuFGcNi`, immutable SHA-256
`d3ad00620b5f2290673ac3f71d27a981f92838b8cd68ff3aa101c657cdeacc9f`.
Successful test resources were deleted; guest command output and metadata remain
in `.apps-local/runner-acceptance/fs-runner-{guest.log,box.json}`. These files are
overwritten/appended by subsequent runs; preserve a copy when retaining a scene.

- S1 PASS: added file, modified original file, removed original file, permissions.
- S4 PASS for F4: real API/runner process restart, durable query and cold restore,
  duplicate/traversal/active-restore errors, deletion and referenced-disk refusal.
- Actual storage failure: read-only snapshot parent makes capture fail. No partial
  directory or metadata remains; guest writes and sync succeed immediately after.
- Source writes leave the immutable disk checksum unchanged. S2/S3 require F5
  children and are not claimed by this checksum assertion alone.
- S5 cold boot is exercised. External/cache mount exclusion through the runner is
  still NOT_RUN pending its volume interface; code copies only the container disk.

Mac arm64, same physical host; API 13001, runner 13003. Guest reports Linux
6.12.87; fixed workload image `alpine:3.23`. Docker is not involved. This test
restarts only this checkout's API/runner, retaining its PostgreSQL/Redis services.

## Regression checks

All commands below exited 0, with logs under the directory above:

| Command | Evidence |
| --- | --- |
| `make test:integration:snapshots` | `f4-r4-regression.log`: 41 real VM tests |
| `make test:unit:rust FILTER=snapshot` | `f4-r3-rust.log`: 25 unit tests |
| `make test:apps:api FILTER='memory\|REST box/proxy permission\|BoxliteProxyController'` | `f4-r3-api.log`: 64 relevant API checks |
| `make test:apps:runner FILTER=MemorySnapshot SETUP_DONE=1` | `f4-r4-runner.log` |
| `make test:unit:go FILTER=NativeSnapshot SETUP_DONE=1` | `f4-r4-go.log` |

Legacy VM test warmup also pulled `alpine:latest` and `python:alpine`; actual
snapshot workloads used `BOXLITE_TEST_IMAGE=alpine:3.23`. Warmup is not fixed-image
acceptance evidence. The separate runner probe uses only the fixed workload tag.
Full API/reference baseline failures remain documented in the F3 report.
