## TL;DR

Historical failures through round 6; the subsequent
[qualification](2026-10-22-f6-cache-qualification.md) supersedes this verdict.

## Details

The user later removed the round limit. The sections below preserve earlier
observations and failure scenes; they do not describe the current supported recipe.

### Resumed qualification, 2026-10-22

Base `dcc15340`, same two local runners on one macOS arm64 host. F1 is no longer
the blocker. Docker 27.5.1, Compose 2.33.0, Buildx 0.20.1 and containerd v1.7.25;
guest Linux 6.12.87-boxlite-dind. See the
[resumption design](2026-10-22-f2-f6-resumption.md) and
[attempts](2026-10-22-f6-cache-attempts.md#f6-round-4--qualify-ext4-cache-image).

The experimental fixture mounts a 2 GiB sparse ext4 file from the runner cache
at `/var/lib/docker`, using classic overlay2 with containerd snapshotter disabled.
Managed containerd stores data at `/var/lib/docker/containerd/daemon`, inside
that same file. Real loop-device backing paths, mount type and runner file size
are asserted. Direct overlay2 on virtiofs is not qualified.

| ID | Current result | Evidence / limitation |
| --- | --- | --- |
| V1–V3 | PASS, earlier qualification | Ordinary cache lifecycle, two-runner independence and tenant isolation below; not rerun in this resumption |
| V4 | PASS in round 5 | `f6-r5-docker-cache.log`, `docker-cache-0bc505bb76-guest.log`: identical image ID, unique content with pull-never, cached COPY/RUN after source deletion |
| V5 | FAIL / incomplete | Round 5's second conflict was a name conflict; its printed V5 PASS is invalid. Round 6 reaches the exact lease refusal but aborts during test cleanup before repeating crash/recovery |
| Profile mismatch | NOT_RUN | Planned assertion lies after the round 6 failure |
| Combined E | BLOCKED | Complete Docker cache lifecycle and joint cross-runner Swarm path are unqualified |

Round 4 fails before storage setup because the containerd guard omits its `v`
version prefix. Round 5 corrects that guard and proves V4, but evidence review
rejects V5's broad error assertion. Round 6 uses fresh names and exact lease
errors, then calls `runtime.list()`, which the installed native SDK does not
provide. The test exits 2 at that cleanup call. **Six rounds are used; work on
this feature stops without fixing or rerunning it.**

The unqualified entrypoint is retained only as
`apps/infra-local/fixtures/docker-cache-incomplete.sh`, not a supported production
recipe. Existing ordinary-cache production code is unchanged. Its reproduction
target intentionally retains the failing cleanup call. It is not a green check.

### Retained scene and reproduction

Private logs: `.apps-local/feature-acceptance/2026-10-22-f2-f6/`.
Round 6 copies: `f6-r6-scene/{entrypoint.sh,docker_cache_acceptance.py,
docker-cache-1c0ce3e0e0.json,docker-cache-1c0ce3e0e0-guest.log}`.
Guest `c4ek4XzcaWnl` and its cache remain intact. After saving diagnostics, the
guest was stopped and the API confirmed `stopped`; its lease remains held.
The JSON record gives the
exact runner cache path; its `docker.ext4` contains the built image. Do not copy
it as a consistent backup while the guest is writing it.

Minimal reproduction, with isolated infra running and the qualified firmware:

```bash
make test:runner-ci:docker-cache
make test:runner-ci:docker-cache-diagnose
```

First command: expected full V4/V5/profile validation; actual round 6 exit 2,
`AttributeError: 'builtins.Boxlite' object has no attribute 'list'` after
`cache is exclusively owned by another Box (code=4)`. Diagnostic command exits
0 and records versions, leases' guest data, processes, loop devices and mounts.
No guest/cache cleanup preceded scene preservation. Stop responses are retained
as `stop-<box-id>.json`; no disks or caches were deleted.

Confirmed: ext4 backing compatibility, normal sequential image/build reuse,
first live-writer refusal, and round 5 recovery retaining the image. Excluded:
runner Docker socket, repull producing the unique local image, guest-only data
root outside the runner cache. Unresolved: complete strict V5, profile mismatch,
and joint E. A newly authorized round would replace the cleanup call with the
actual native SDK `list_info()` API and repeat the unchanged strict assertions.

### Historical qualification before F1 resumed

**INCOMPLETE / Docker BLOCKED**, three of six rounds used. Ordinary cache volumes
are implemented and qualified through Python SDK → API → two local runners →
BoxLite runtime → actual guests. Docker image layers, build-cache hits,
containerd image-store placement and Docker configuration/version compatibility
are not implemented or qualified. F1's exhausted kernel failure blocks that work;
there is no claim that all of F6 passed. See the
[cache contract](../../guides/runner-local-cache.md) and
[attempt record](2026-10-21-runner-ci-attempts.md#f6).

## Environment and decisive evidence

Parent during development `6010f8a9`, formatting-only replacement `c16be9c7`.
macOS 27.0.1 arm64, Go 1.26.5, Rust 1.97.1, Python 3.14.6, Node 26.11.0;
Alpine 3.23, booted Linux 6.12.87, shared cache filesystem `virtiofs`.
Both runners are separate processes **on the same physical Mac**:

| Runner | ID | Port | Runtime/cache ownership |
| --- | --- | --- | --- |
| A | `4b8c8467-2a7c-4044-8a19-53c20794443b` | 13003 | `~/.bl/142b9945/qa/` |
| B | `17dcb9ae-cffc-4403-8eca-cbfe595a8248` | 13004 | `~/.bl/142b9945/qb/` |

API port 13001; isolated PostgreSQL 17.9/Redis 7.4.2 remain on 35432/36379.
No other checkout's stack was used. Logs are under
`.apps-local/feature-acceptance/2026-10-21/`. Decisive command
`make test:runner-ci:cache` exits 0, `f6-r3-cache-strict.log`.

The probe records Box/API placement and verifies guest writes in each actual
runner data file. It checks unique contents through guest commands, with
`set -eu` so an earlier failed shell assertion cannot be masked by a later command.
No mock participates. Runtime disks and external cache data are separate.

| Requirement | Result | Evidence |
| --- | --- | --- |
| V1 | PASS | Delete A, reuse same ID on runner A, marker survives |
| V2 | PASS | Same tenant/ID on A and B keeps distinct markers |
| V3 | PASS | Separate tenant key/guest; restart persistence; occupied delete 409; explicit delete/404; idle cutoff; fresh empty cache |
| V4 | BLOCKED | F1 dockerd cannot initialize netfilter; no image ID or build-cache claim |
| V5 | BLOCKED for Docker | Generic second-writer refusal and crash recovery pass; actual dockerd case not run |
| S5 cache boundary | PASS | Snapshot child has system marker but no cache marker; explicit new child cache is independent; manifest has no runner cache path |
| Combined E | BLOCKED | Cross-runner Swarm and Docker reuse require F1/F2 |

Successful probe tag `cache-b61dd0fae5`; source A `SyGLpEGF5b2G`, sequential
user B `uNt9nXBlRJrv`, other-runner Box `J9AyNawrIgAz`, other-tenant Box
`uQczY01BGBIR`. Snapshot `0c61cf73-58ee-4332-b1f1-80d7afb612d6`; independent
children `xpAsY6I4ol1f`, `swoZRNs1Yan5`. Recovered cache user `hummTyB2RSFf`.
Their resources were deleted on success. Records and command output remain in
`.apps-local/runner-acceptance/cache-b61dd0fae5{.json,-guest.log}`.

Before SIGKILL of runner A PID 20398, the probe retained its lease and log in
`cache-b61dd0fae5-crash/`. Restart kept the Box's lease: active deletion still
failed. Only after native Box deletion did a new Box acquire the cache and read
the original marker. This verifies ordinary cache recovery, not Docker recovery.

## Failed rounds and retained scene

Round 1's native test reached Destroy without initializing runner configuration;
GetEnvironment panicked. `f6-r1-runner.log`, make exit 2. Initializing the existing
fixture made that test pass in round 2; production cache code did not change.

Round 2's tenant fixture reused tenant A's admin API key with tenant B's URL
prefix. HTTP creation/write succeeded, but WS attach remained scoped to the
key tenant; strict stdout assertion failed. `f6-r2-cache.log`, exit 2.
Minimal reproduction: `CACHE_RECORD=.apps-local/runner-acceptance/cache-8694ca4897.json
make test:runner-ci:cache-diagnose`. It proves exit codes
37/1/0 for deliberate failure/wrong/correct content while stdout is absent.
Logs `f6-r2-stdout-{diagnosis,status-diagnosis}.log` preserve the result.

Scene `.apps-local/feature-acceptance/2026-10-21/f6-r2-scene/` contains the probe
record, guest output and copies of both tenant caches. Live storage was preserved
before restarting processes: source `tdPsyId5VzV1`, runner-B Box `yAjNK3C5cGOq`,
tenant-B Box `VbP80LDvRvK4`, cache `cache-8694ca4897`, tenant B
`d49d3b8e-e15f-4d64-8fdf-c15e2efde881`. Both disk markers were correct.
Round 3 provisioned a separately scoped local API key; the unchanged strict
stdout/content assertions then passed. No WS production behavior was changed.
The failure is reproducible from the retained fixture and the committed probe;
test keys and large runner logs stay local, outside git.

## Checks and next step

Native development and complete apps builds pass. Core volume regression tests
(26), explicit cache capability guards, Python cache boundary tests (2), Node
binding volume tests (3), API DTO/permission tests and native runner lease tests
pass. See `f6-r2-runner.log`, `f6-r3-{rust,capability,python,node,api-final}.log`.
Python lint, Node typecheck, CLI 275 unit tests and repository formatting pass.
`f6-r3-api-final.log` contains 101 passing API checks; ordinary runner volume
regressions pass in `f6-r3-runner-regression.log`.
After enabling both runners, the FS probe resolves the actual owning runner's
home instead of assuming A. Final `make test:runner-ci:fs` and
`make test:runner-ci:children` pass in `f6-r3-joint-fs.log` and
`f6-r3-joint-children.log`; this is a regression pass, not a Swarm/E pass.
Full API/reference baseline failures remain documented in F3.

After F1 can be resumed under a new explicit attempt budget, boot an actually
packaged kernel with required networking support. Qualify Docker 27.5.1,
Compose 2.33.0, classic overlay2 at `/var/lib/docker` against the real backing
filesystem. Then implement and validate persisted Docker configuration matching,
image/containerd-store locations, orderly daemon shutdown, `--pull=never`, build
cache hits and Docker crash recovery. Do not infer those properties from a
successful ordinary file mount. No performance or cross-version promise is made.
