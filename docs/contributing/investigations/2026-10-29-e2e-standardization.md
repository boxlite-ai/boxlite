## TL;DR

One Make entry prepares, runs and recovers the source-built REST stack. Final unchanged preparation takes 4.915 s externally; a selected guest case takes 5.877 s. Full suites completed with recorded failures; cold startup and archive invalidation were exercised.

Design: [Standardize local environment and recorded test runs](https://github.com/boxlite-ai/boxlite/issues/2204).

## Context and contract

The existing REST suite exercises SDK → NestJS API → Go Runner → real VM. `make test:integration` instead exercises local runtime bindings; `npm run e2e:local` starts a separate Dashboard/Dex environment. These are distinct coverage surfaces.

The requested deliverables are an exercised local environment, full available test results, detailed timings and troubleshooting, source-backed competitor research, and a standard interface for starting and extending E2E. This record separates original diagnosis, measurements and unmet behavior.

The measured environment uses x86_64 NixOS, readable/writable KVM and FUSE, and rootless Podman behind the Docker-compatible CLI. Default API port 3300 avoids the usual development port 3000. FUSE `user_allow_other` is a one-time host prerequisite; daily commands do not use sudo. Private-image cases require real image coordinates and a read-only credential.

The [runbook comparison](../../../apps/e2e/README.md#what-the-managed-workflow-changes)
defines the original-versus-managed workflow boundary. This implementation
reuses the existing REST cases and fixtures; one-file pytest discovery was
already supported. Local runtime integration, Dashboard/Dex and deployed-stage
CI retain their separate roles. The workflow change includes one production
Runner adjustment for non-root systemd mount scopes; it is not exclusively test
code. SDK public interfaces are unchanged.

### Dependency reproducibility boundary

The following table records the installation boundary measured before the
[portable dependency lock follow-up](https://github.com/boxlite-ai/boxlite/issues/2207).
The [current runbook](../../../apps/e2e/README.md#locked-dependencies) describes
the managed E2E lock contract; compiler and host-library variability remain.

| Dependency layer | Current constraint | Remaining variability |
| --- | --- | --- |
| Nix tool packages | `flake.lock` fixes the nixpkgs revision used by the development shell | Host kernel, KVM/FUSE access and container runtime remain host prerequisites |
| Rust compiler and crates | `Cargo.lock` records crate resolution; `rust-toolchain.toml` selects `stable` | Compiler version floats; Make uses ordinary Cargo builds without `--locked` |
| Go modules | Checked-in `go.mod`/`go.sum` and workspace files select modules and checksums | Build commands do not enforce read-only module metadata; toolchain behavior also depends on the development environment |
| Node packages | Checked-in `apps/yarn.lock` and `sdks/node/package-lock.json`; apps specifies Yarn 4.13.0 | Make runs `yarn install` / `npm install`, without `--immutable` / `npm ci` enforcement |
| Python test/build tools | Version ranges in `pyproject.toml`; pip/uv installation through Make | No Python lockfile; uv and maturin installation also resolve versions. The existing environment used pytest 9.1.1; isolated setup resolved 9.2.0 |
| Dependency images | New state resolves configured tags, then stores the actual digest locally | Tags include `17-alpine`, `7-alpine` and `latest`; separate machines/states may resolve different digests |
| Guest image | Curated version comes from `apps/box-images/VERSION`, with an explicit override available | A version tag is not a repository-pinned digest |

These original measurements did not freeze cross-machine dependencies. The
follow-up adds immutable package installs and repository-owned image identities;
it does not pin distro packages or promise byte-identical native builds.

### Lock implementation observations (2026-10-29)

The managed E2E path now installs through checked-in locks. Exercised layers:

| Layer | Exercised command and observed result |
| --- | --- |
| Python tools | `uv sync --project apps/e2e --locked --inexact --no-install-project` against the repository `.venv`; a warm check resolves 15 packages and reports no changes in about 1 ms. Pinned uv 0.13.4 installs 13 locked packages |
| Apps | Corepack Yarn 4.13.0 `install --immutable` completed; peer-range warnings are reported by the existing manifests and change nothing |
| Node SDK | `npm ci` plus `napi build --locked`; Cargo finished in 51.26 s and `tsc` in about 6 s |
| Rust / Go | `BOXLITE_CARGO_LOCKED=1` and `GOFLAGS=-mod=readonly` during managed builds |
| MinIO | Locked release binary (amd64 110,989,496 bytes, SHA-256 `7c5bd851…`) verified against the GitHub asset digest, built into a scratch image, and started with a real version query |

Ubuntu 24.04 with its apt Python 3.12.3 bootstrapped pinned uv 0.13.4 and
installed all 13 locked packages (`pytest 9.1.1`, `pytest-asyncio 1.4.0`), so the
universal lock covers the 3.12 `typing-extensions` branch. That run exercised
the dependency layer only; a full Ubuntu E2E acceptance still needs KVM and the
complete service stack.

Failures found and fixed while exercising this path:

| Failure | Evidence | Correction |
| --- | --- | --- |
| Scratch MinIO image started but `--version` failed with `getent` missing | `minio: <ERROR> Unable to get mcConfigDir. exec: "getent": executable file not found` | Set `HOME=/data` in `Minio.Dockerfile`; the tool needs a writable home, not distro tooling |
| A `Minio.Dockerfile` edit invalidated the 105 MB download cache because the Dockerfile fed image identity | Repeat run re-downloaded the binary and hit a 30 s read timeout | Content-addressed download cache keyed by the locked SHA-256, hardlink/copy into the build context; per-read timeout raised to 120 s |
| One GitHub asset download completed but hashed differently (`bf4fcad7…` vs `7c5bd851…`) | The SHA guard rejected it and removed the partial file; a later download matched | Keep the strict SHA gate, add a declared Content-Length check and three bounded attempts |
| `docker inspect <name>` matched a same-named data volume when the container was absent (Podman), producing `Container ownership conflict` on a clean slate | Volume JSON has no `Config`; cleanup keeps named volumes by design | `docker container inspect` scopes the query to containers |
| `uv sync --check` cannot detect a removed editable SDK or `greenlet` in a warm `.venv` | Check reports locked packages only | Probe `import boxlite, greenlet` before trusting the cached dependency identity |

An orphaned `apt-get` from a killed `docker exec` held the sandbox dpkg lock;
this is a host investigation detail, not a product behavior.

Final acceptance after the fixes above, on the measured NixOS host with warm
caches:

| Check | Command | Observed |
| --- | --- | --- |
| Managed smoke, first run after fixes | `nix develop -c make test:e2e E2E_ARGS=cases/test_path_verification.py` | 2 passed; MinIO image built from the locked binary, fixtures ran, exit 0, 33.99 s external |
| Managed smoke, unchanged rerun | Same command | 2 passed; every dependency/build group and fixtures cached, exit 0, **5.63 s external** |
| Offline harness suite | `nix develop -c make test:e2e:check` | 30 passed in 0.77 s (7 library checks, 23 reporting/lifecycle checks including the new dependency-cache boundary test) |
| Ubuntu 24.04 dependency layer | Pinned uv 0.13.4 + locked sync on apt Python 3.12.3 | 13 locked packages installed; `pytest 9.1.1`, `pytest-asyncio 1.4.0`, `typing-extensions 4.16.0` |

The smoke proves SDK → API → Runner → guest execution through the locked stack.
It does not re-establish the full-suite verdict, which remains recorded above
from the earlier harness revision.

The curated-image admission rule matches refs by exact string, so the locked
digest ref must also be exported as `BOXLITE_SYSTEM_BASE_IMAGE`; otherwise a
create is refused with HTTP 400 for an unregistered `ghcr.io` credential. That
export is part of the managed environment contract.

### Full suite on the locked stack (2026-10-29)

`nix develop -c make test:e2e` on the locked dependency stack collected 234
cases and finished in **791.87 s** of pytest time (795.19 s manager) with
**204 passed, 18 failed, 7 skipped, 5 xfailed**. The 204 is 188 real E2E passes
plus 16 offline harness guards; the report keeps those scopes separate. Every
dependency, build and fixture stage was a cache hit; preparation before pytest
was **~2.5 s**.

| Failure group | Cases | Cause evidence |
| --- | --- | --- |
| Docker Hub unreachable during the run | 7 (`test_images_aliases` ×5, `test_create_with_unknown_image_returns_typed_error`, `test_image_pull_failed_returns_422`) | Runner logged `failed to pull manifest: error sending request for url (https://index.docker.io/…)` and `failed to pull a registry token: … (https://auth.docker.io/…)`. The same seven cases passed on rerun once connectivity returned |
| Known product behavior, unchanged from earlier runs | 10 (preview 404, foreground WS handshake, exec timeout ×2, exec-on-stopped-box, stop/start `State change in progress` ×2, rapid create-remove leak, tunnel-rejects-stopped-box, secret-bound host 502) | Same assertions and messages as the previously recorded verdicts |
| Managed-volume write | 1 (`test_volume_contents_outlive_the_box_that_wrote_them`) | `Operation not permitted` writing `/mnt/e2e-volume`; the previously recorded rootless mount limitation |

A follow-up run of the seven network-dependent cases passed all seven
(`20261029T160255.460196Z-496434`, 7 passed in 59.53 s). One of them initially
failed on a stranded box (`ix0avfE2EB2U`, state `stopped`, `alpine:3.19`) left
by the interrupted pull: the catalog refuses to remove an image a box can still
boot from, so five alias cases errored until that box was removed. The suite
bounds every box's lifetime, but a case that dies before creating its cleanup
entry can still strand one until `auto_delete` fires. This is test-hygiene
cascade, not a product defect, and the sweep remains the recovery path.

Host connectivity to Docker Hub was independently intermittent during this
window: five consecutive token requests returned `200, 200, 000, 200, 000`, and
a manifest fetch timed out after 25 s. Failures of this shape are environment
evidence, not a verdict on the change.

Case authoring on this stack was re-exercised with the README pattern: a
one-file `cases/test_authoring_probe.py` was discovered automatically (235
collected, 234 deselected) and its real guest assertion — stdout `e2e-out`,
stderr `e2e-err`, exit 42 — passed in 0.55 s with a cached stack. The temporary
file was then removed; no registry or CI change was needed.



## Original diagnosis and historical baseline

The following findings describe the pre-standardization checkout. The current Make/run.sh facade and fixtures have since changed; these line references preserve the reasons for the changes, not a description of today's entrypoints.

- Original `make/test.mk:618-640`: REST selection supported FILTER, but `test:e2e` did not. Setup called the host bootstrap and fixture separately.
- `apps/e2e/run.sh:23-39`: systemd API activity decides whether to bootstrap; an import failure can install the published SDK. Neither proves the running source matches the checkout.
- `apps/e2e/bootstrap.sh:35-67,255-359`: apt, global tools, system services, native compilation and restarts are repeated. This is an Ubuntu machine installer, not an incremental NixOS environment command.
- `apps/e2e/fixture_setup.py:136-154`: quota SQL uses retired `organization.personal`; the current base migration defines default membership through `organization_user.isDefaultForUser`. It also queries a retired snapshot table and POSTs `/snapshots`.
- `apps/API.md:38-42` and `apps/api/src/app.service.ts:46-60`: hosted snapshots are absent; startup seeds region/admin/runner, not snapshots. The fixture must use the current image/create path.
- `apps/e2e/cases/conftest.py:188-310` already supplies the REST runtime, bounded lifetimes, box cleanup and concurrent stream draining. `lib/path_verification.py:69-101` already supports Runner file logs without journalctl.
- C cases hardcode release libraries; Go cases build without `boxlite_dev` and can skip compile failures. `sdks/go/bridge_cgo_dev.go:5-16` links the current debug archive; changing LD_LIBRARY_PATH cannot change a statically linked library.
- `scripts/test/rest/report.py:99-103` lists auth commands without reading pytest results. A command list is not execution evidence.
- Catalog/private cases share module state, repository names and aliases. Default xdist is unsuitable before independent organization/resource isolation.

Historical run [39988601378](https://github.com/boxlite-ai/boxlite/actions/runs/39988601378), SHA `fc65419699906b41aa5e960a9e8495ade19a5395`: CLI build 281 s, Node SDK 121 s, Python SDK 127 s, tests 697.72 s; 178 passed, 12 failed, 12 errors, 8 skipped, 9 xfailed. This is historical evidence, not proof about the current tree. Run [40716476072](https://github.com/boxlite-ai/boxlite/actions/runs/40716476072) spent 316 s waiting for an offline runner and never entered integration tests. Run [40698311960](https://github.com/boxlite-ai/boxlite/actions/runs/40698311960) was green with its test jobs skipped.

## Related implementations and decisions

| Source | Observed mechanism | Local decision |
| --- | --- | --- |
| [E2B runtime preparation](https://github.com/e2b-dev/runtime/blob/6e66c58fc82569f00c529d22708830bfd73373e9/.github/actions/integration-tests/action.yml#L97-L145) | Starts database preparation before builds; template/network operations must precede orchestrator startup | Overlap independent dependency startup and compilation; preserve true dependencies |
| [E2B cache identity](https://github.com/e2b-dev/runtime/blob/6e66c58fc82569f00c529d22708830bfd73373e9/.github/actions/build-sandbox-template/action.yml#L259-L276) | Cache inputs include source, image identity, build settings and CPU | Use small source/input and artifact fingerprints; never cache a live E2E verdict |
| [Firecracker fixtures](https://github.com/firecracker-microvm/firecracker/blob/74c85188c28a84a55ee74a8ba18e4ee851b072b2/tests/conftest.py#L620-L698), [rootfs](https://github.com/firecracker-microvm/firecracker/blob/74c85188c28a84a55ee74a8ba18e4ee851b072b2/tests/framework/microvm.py#L1321-L1353) | Layered VM preparation; read-only inputs reused, writable roots copied | Keep shared immutable images and per-case boxes; require real guest exec after service readiness |
| [Daytona cleanup](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/daytona-e2e/helpers_test.go#L108-L182) | Successful creation immediately registers `t.Cleanup`; helpers add run identity and bounded state polling | Reuse pytest fixture ownership and per-run names. The [public code stopped maintenance](https://github.com/daytonaio/daytona/blob/ec4c21b2d597091ac09ecc278f3bcc172575a987/README.md#L1-L7); it does not establish current private behavior or test-result caching |
| [Kata diagnostic reruns](https://github.com/kata-containers/kata-containers/blob/78d75b084729f28eeb1c4bf700de0fb17b49a353/tests/integration/kubernetes/k8s_bats_runner.sh#L94-L144) | A debug rerun does not erase the first failure | Preserve original verdict and separate diagnostic attempts; do not introduce Kubernetes/Bats |
| [xdist fixture contract](https://github.com/pytest-dev/pytest-xdist/blob/131c214540984c3fddaaec82f43fbf1e9254d926/docs/how-to.rst#L148-L194) | Session fixtures execute per worker | Keep serial suite execution; load grouping does not isolate shared aliases/quotas |
| [Testcontainers runtime support](https://github.com/testcontainers/testcontainers-python/blob/6146aa1170f415fcc825ed9bddc4eacbeb937a12/docs/system_requirements/docker.md#L3-L27) | Podman requires a Docker API socket; alternative runtimes are not actively tested in its main workflow and may need configuration | Keep the existing direct container CLI and native service ownership; accept implementing explicit cleanup/readiness instead of adding socket and Ryuk ownership |
| [Compose readiness](https://github.com/docker/compose/blob/343bb382d2192b88d84af49971bb5cb99bee268c/pkg/compose/dependency_wait.go#L279-L309) | Without healthcheck, waiting can reduce to container running | Use actual PG/Redis/HTTP probes and a guest roundtrip |
| [Playwright web server](https://github.com/microsoft/playwright/blob/e12bcaf56c7aa56442793804bbbdb4ccbc03f7d1/docs/src/test-webserver-js.md#L30-L44) | Server readiness can accept authentication responses | Use browser automation only for actual local Dex login; it cannot establish VM readiness |

[Go's cache contract](https://github.com/golang/go/blob/go1.25.4/src/cmd/go/alldocs.go#L2284-L2302) explicitly excludes external C-library changes: changed archives need forced recompilation. [Pytest JUnit](https://github.com/pytest-dev/pytest/blob/a7b2446ee41a7298d3a0bc22c52f3b8bacae1566/src/_pytest/junitxml.py#L271-L284) represents xfail using a skipped element with a distinct type; reports must preserve that distinction.

All thirteen pinned source links above were reopened on 2026-10-29, including both E2B and both Firecracker snippets, Daytona's maintenance notice, and the Go/pytest references. The snippets support the stated mechanisms. The earlier claim about Daytona test-result caching was unsupported by the cited cleanup helper and has been removed.

These comparisons answer four local design questions: E2B informs build scheduling/cache identity; Firecracker and Daytona inform fixture/resource ownership; Kata and pytest inform evidence semantics; Compose, Playwright and Testcontainers expose readiness/runtime limits. Adopting another framework would still leave native builds, FFI archive invalidation and real guest proof to implement. The trade-off is a small project-owned lifecycle manager. Serial execution remains necessary until shared organization/catalog state is isolated; xdist fixture locking alone does not provide that isolation.

## Implementation contract

`apps/e2e/manage.py` is the sole lifecycle/command facade. Existing Make and run.sh entrypoints call it. It owns doctor/setup/up/run/down/status/report and `exec -- argv`, with ordinary subprocess argv, explicit deadlines, original exit codes, one lifecycle lock and one state directory. No orchestration DSL or case registry.

Dependencies run through the Docker-compatible CLI: PostgreSQL 17, Redis 7, Registry 2, Dex and MinIO. API, Runner and both proxies run native source builds. Defaults avoid occupied ports: API 3300, Runner 38080, Preview Proxy 34000, Registry Proxy 34100, PG 35432, Redis 36379, Registry 35000, Dex 35556, MinIO 39000. Containers publish loopback; native servers retain their current bind behavior.

State belongs to `target/e2e`, with a short separate Runner home and isolated CLI profiles. Container labels and verified PID/start identities prevent touching unrelated resources. Down stops owned services and preserves data. Startup failure preserves evidence and unwinds only newly started resources.

The real rootless volume run exposed a required Runner adjustment: `wrapMountCmd` chose a system scope whenever `/run/systemd/system` existed, then failed with `Failed to start transient scope unit: Access denied`. [systemd-run](https://github.com/systemd/systemd/blob/main/man/systemd-run.xml) documents that scopes inherit the caller's environment and that `--user` selects the user manager. An actual `systemd-run --user --scope -- true` succeeded here. Non-root Runner processes should use user scopes; root Runner processes retain system scopes. This preserves independent FUSE lifetime without daily sudo. Mountpoint's [endpoint documentation](https://github.com/awslabs/mountpoint-s3/blob/main/doc/CONFIGURATION.md#endpoints-and-aws-privatelink) supports `AWS_ENDPOINT_URL`; the managed environment supplies its MinIO endpoint. A real volume write/recreate/read remains the acceptance check.

Source builds reuse Make and the debug runtime once, then current Python/Node/C/Go SDKs and CLI. Input fingerprints exclude generated output and test-case edits; archive identity invalidates Runner/Go linkage. Healthy unchanged runs do no installs, native builds, restarts or repeated warmup.

Fixtures remove retired schema/snapshot work, scope quota changes to the authenticated organization and write isolated credentials. Existing cases/fixtures stay in place. Native wrappers use current libraries and unique temp directories; compilation errors fail visibly. New cases are one test file using `box`/`rt`/`drain`, real output assertions, bounded waits and immediate cleanup ownership.

Each run records stage wall times, collection, setup/call/teardown duration, command/versions/image digests, original exit and completeness, JUnit and logs. The existing REST report aggregates actual evidence. Skip, xfail, error, XPASS, deselected and incomplete remain distinct. No unconditional retries or weakened assertions.

## Verification contract

The checks below define the acceptance surface. Results and limitations are recorded under Execution observations and Final acceptance evidence.

- Actual authenticated API → Runner → guest create/exec/remove, API header and both file logs, plus real MinIO-backed volume persistence.
- Full available API-key E2E; OIDC Python/CLI with real local Dex login; local VM integration separately. Private-image credential gaps and current product xfails remain visible.
- Cold/first preparation once; unchanged narrow run and stopped-service warm startup three times each. Targets: unchanged preparation median ≤10 s; warm service startup through guest exec median ≤60 s. Raw samples and cache state accompany comparisons.
- One-file case-authoring exercise; intentional wrong assertion fails, corrected real guest stdout/stderr/exit=42 passes without service rebuild.
- Port conflicts, busy lock, missing reports, failing selector, service recovery and SIGINT preserve ownership, original exit and next-run recoverability.
- Existing meaningful script/helper checks plus regression tests for exercised harness boundaries. Every fix retains its original failure evidence; tests do not replace real VM smoke proof.

## Execution observations

### Completed full REST runs

Run directories below are under `target/e2e/runs/`. Every full run collected 234 cases, recorded `sessionfinish` with exit 1, and has matching JUnit case counts. `complete=true` means evidence collection finished; it does not mean the suite passed. Early runs record source SHA `7f062228a9f44727ac4fa5425583015fe512f8bf`, which identifies HEAD without encoding the dirty working tree. The final manager also snapshots source/build fingerprints, artifact hashes, resolved dependency images and tool versions into each run.

| Authentication / run ID | Operation wall (s) | Test stage (s) | Pytest session (s) | Passed | Failed | Errors | Skipped | Xfailed | Exit / evidence |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| API key, first full run: `20261028T184754.186064Z-1821063` | 871.464 | 683.952 | 683.70 | 193 | 16 | 12 | 8 | 5 | 1 / complete |
| OIDC: `20261028T194306.955380Z-2351242` | 533.449 | 533.446 | 533.19 | 165 | 13 | 0 | 52 | 4 | 1 / complete |
| API key after harness corrections: `20261029T035217.199510Z-1911308` | 643.214 | 640.670 | 640.40 | 210 | 12 | 0 | 7 | 5 | 1 / complete |

Wall comes from `run.json` start/end timestamps; test stages come from `timings.jsonl`; pytest times and outcomes come from `pytest.log`, `cases.jsonl` and `junit.xml`. The API-key operation included 187.511 s of preparation before tests. OIDC reused the prepared environment and recorded only its test stage, so these operation totals are not an authentication-performance comparison. No XPASS or deselected cases were reported in either full run.

| Case phase totals (s) | Setup | Call | Teardown | Interpretation |
| --- | ---: | ---: | ---: | --- |
| API key | 44.373 | 637.739 | 0.620 | Sum of recorded case-phase durations; excludes collection/reporting overhead |
| OIDC | 31.607 | 500.524 | 0.672 | Same measurement; skipped cases contribute setup but may have no call |
| API key after harness corrections | 41.209 | 597.982 | 0.799 | Same collection; `accept-final-full-costs.json` records the raw phase totals and ten slowest calls |

JUnit's `skipped` attribute includes xfails: API key has 13 elements (8 `pytest.skip`, 5 `pytest.xfail`); OIDC has 56 (52 and 4). Reporting must keep those categories separate. A setup error is not a call failure, and a run that never reaches collection is incomplete rather than zero tests passed.

The full-session pass totals include **16 offline harness guards** in each run. The regenerated summaries separate them: the corrected API-key run has **194 E2E passes + 16 offline passes**, and OIDC has **149 E2E passes + 16 offline passes**. These are different scopes; 210 and 165 must not be presented as VM-only pass counts.

| Failure surface | Observed evidence | Current interpretation / next check |
| --- | --- | --- |
| CLI argument boundary, first API-key run | Twelve setup errors plus detached/entry call failures; `run IMAGE -- sleep …` attempted executable `--` | Preserve this first-run failure after harness argument fixes; obtain the final full-run verdict separately |
| CLI foreground / preview / stopped boxes | WebSocket `Handshake not finished`; enabled preview returned 404 instead of 200; stopped-box call did not raise; stop/start/tunnel paths reported `State change in progress`; rapid create/remove left a box | Product/API behavior failed current assertions; no skip, xfail or retry was added to erase it |
| Exec deadlines | Both auth modes hit `TimeoutError` at about 45.4 s in each timeout case | Investigate timeout propagation; increasing waits is not an optimization or a demonstrated fix |
| OIDC product/API permissions | Two alias checks received HTTP 403 `Forbidden resource` from `/api/box/<id>`; curated-catalog listing received the same response from `/api/images` | These three permission responses are failures. The response alone does not establish the responsible authorization rule, scope or configuration |
| Secret substitution | REST curl reached the comparison host but the secret-bound host returned HTTP 502; local Node assertion also failed | Retain observed network/substitution failures; the logs do not establish one shared root cause |
| Volume API and mount | First run called a `VolumeHandle` and raised `TypeError`; both full runs' persistence case failed mounting the S3 backend with exit 1 | Treat the handle correction and host activation separately from unproven managed-volume persistence |

API-key skips were six private-image cases missing real image/credentials, one existing CLI `--name` skip, and one guest-gcc skip. OIDC skips were 45 C/Go/Node cases explicitly limited to API-key credentials, the same six private-image cases and guest-gcc case. Existing xfails cover three error-mapping cases and TCP half-close (both SDKs for API key; Python for OIDC). These are recorded suite annotations, not newly verified root-cause claims or equivalent coverage across auth modes.

The corrected API-key run removed all twelve setup errors and the callable-volume-handle failure. It exposed a repeatability defect: `test_cli_run_with_name` used the fixed `cli-e2e-named-box`, which already existed after an earlier run. The case now chooses a UUID-suffixed name, retaining the same create/list assertions. Focused rerun evidence is separate; earlier full results remain unchanged. The seven remaining skips are six private-image prerequisites and guest gcc availability.

The original volume blocker was Runner log `mounting volume` followed by `Failed to start transient scope unit: Access denied`. Selecting the systemd user manager removed that mount-start blocker. Run `20261029T041124.302778Z-2121195` reached the guest mount, then default UID/GID `1000:1000` failed to create a file with `Operation not permitted`; the mounted directory reported `1000:100 777`. An explicit `0:0` diagnostic also failed, with `I/O error` and `Stale file handle`. The diagnostic ended with exit 1 in 113.25 s externally (96.113 s runtime rebuild, including shared Cargo lock waits). No writer/recreate/reader success is claimed. The remaining failure is recorded without expanding this workflow change into a virtiofs or Mountpoint repair.

### Setup and warm measurements

The first setup, `20261028T184302.593726Z-1755308`, completed with exit 0 in **254.024 s**, using existing host download/build caches. This is a first standard-command preparation measurement, not a cold-machine benchmark. Fixture quotas read back as 4/8/20; the superseded quota SQL had returned `column personal does not exist`, and the superseded snapshots route returned 404.

| Stage | First setup (s) | Later setup `20261028T195510.103301Z-2470528` (s) | Cache / timing detail |
| --- | ---: | ---: | --- |
| Doctor | 0.428 | 0.270 | Prerequisite inspection |
| Dependency readiness | 2.017 | 0.441 | Recorded before runtime compilation; these runs do not demonstrate E2B-style overlap |
| Runtime preparation | 56.609 | 63.990 | Rebuilt in both |
| Python SDK | 38.699 | <0.001 | Cached in later setup |
| Node SDK | 36.586 | <0.001 | Cached in later setup |
| C/Go SDK | 21.013 | 20.563 | Rebuilt in both |
| CLI | 25.476 | 21.820 | Rebuilt in both |
| Runner | 27.184 | <0.001 | Cached in later setup |
| Proxies | 2.918 | <0.001 | Cached in later setup |
| Native services / Runner readiness | 13.357 | 17.819 | Readiness precedes guest smoke |
| Fixtures, including smoke | 28.075 | 1.331 | Parent interval; do not add smoke again |
| Guest smoke only | 27.960 | 1.216 | Pytest itself: 27.73 s and 0.96 s; two cases passed in each |
| Operation wall | **254.024** | **127.563** | Includes unlabelled preparation/fingerprinting overhead |
| External command wall | Not separately retained here | **129.13** | Includes outer command/shell overhead |

`fixtures` encloses `smoke` in these records. Adding every row double-counts that interval. Stage cache-hit timers measure entry to the cached branch; source/artifact fingerprint work between stages is still part of operation wall. One subsequent early cached-image smoke reported 4.79 s; it is a separate sample, not the first setup's 27.73 s pytest session.

The three recorded narrow samples ran the real `test_exec_working_dir` case, each with 1 passed and 234 deselected. External elapsed time is from `target/e2e/timing-warm.txt`; logs are `timing-warm-{1,2,3}.log`, with corresponding run IDs below.

| Sample / run ID | External wall (s) | Manager wall (s) | CLI build (s) | Services (s) | Test stage (s) | Cache state |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 / `20261029T033245.225695Z-1704341` | 68.146 | 66.149 | 42.021 | 19.104 | 0.866 | CLI rebuilt; other native/runtime/SDK stages cached; fixtures and smoke reran |
| 2 / `20261029T033353.230310Z-1718643` | 5.224 | 3.370 | <0.001 | 0.245 | 0.867 | All builds and fixtures cached; healthy services reused |
| 3 / `20261029T033358.473719Z-1720314` | 5.283 | 3.413 | <0.001 | 0.253 | 0.916 | All builds and fixtures cached; healthy services reused |

External median is **5.283 s** across all three; the 68.146 s outlier remains included. Its log shows Cargo compiling CLI, aws-lc and TLS dependencies (Cargo: 41.76 s). Only two samples demonstrate fully cached healthy preparation; the controlled series below supplies the final speed acceptance.

Three public `make test:e2e:down` → `make test:e2e:up` cycles then passed the real guest and both-log smoke. Their startup external walls were **14.143 / 14.097 / 14.051 s**, median **14.097 s**; down walls were 12.635 / 13.039 / 14.490 s. Startup run IDs are `20261029T040333.921322Z-2026550`, `20261029T040401.232172Z-2033285`, and `20261029T040430.055278Z-2039681`. Raw commands and samples are in `target/e2e/accept-lifecycle.json` and `accept-stopped-*.log`. These are stopped services with retained data/build/image caches, not clean-machine installs.

The next nominally unchanged series measured 34.040 / 4.476 / 16.915 s, median 16.915 s. Concurrent integration compilation and a Runner source edit contaminated it: sample 1 rebuilt CLI for 28.337 s, sample 3 rebuilt Runner for 9.353 s. It remains recorded. Sharing one Cargo target directory with other build commands causes real invalidation and lock waits; benchmark with those writers stopped.

The final controlled series used public `nix develop -c make` commands with no concurrent build against this checkout. All seven build groups and fixtures were cached; native services were reused.

| Scenario | External samples (s) | External median (s) | Preparation before pytest (s) | Evidence |
| --- | --- | ---: | --- | --- |
| Unchanged `test:e2e:up` | 4.736 / 4.665 / 4.800 | **4.736** | Manager whole-operation samples 2.858 / 2.764 / 2.840 | `accept-final-warm.json`; runs `065452.370092Z-473208`, `065457.129732Z-474448`, `065501.852421Z-475617` on 2026-10-29 |
| `test:e2e FILTER=exec_working_dir` | 5.424 / 5.334 / 5.438 | **5.424** | 2.671 / 2.649 / 2.690; median **2.671** | `accept-final-narrow.json`; runs `070456.731859Z-549215`, `070502.086945Z-550605`, `070507.484475Z-552027` |

Each narrow run passed its real guest case; its test subprocess stage took about 0.916 s. `accept-final-timings.json` records full run IDs, cache flags and manager/external intervals. The preparation target of ≤10 s and stopped-service startup target of ≤60 s are satisfied for this measured host/cache state. Recovery after all services were stopped also passed both chain cases: `20261029T062759.169428Z-279689`, 19.80 s external, 0.90 s pytest.

After separating bucket initialization into `storage`, unchanged `up` measured
9.361 / 8.179 / 7.215 s externally (median **8.179 s**); manager operation times
were 5.996 / 5.231 / 4.095 s. A separate isolated build competed for host CPU/I/O
without sharing this checkout's outputs. All seven local build groups remained
cached. Selected guest reruns took 5.128 / 5.163 / 5.198 s externally (median
**5.163 s**), with 2.648 / 2.655 / 2.694 s before pytest (median **2.655 s**).
Storage checks took 0.165–0.320 s. `accept-final-ordered-detail.json` preserves
these run IDs and intervals; earlier uncontended samples describe their earlier
harness revision.

With the final harness revision and isolated builds stopped, three unchanged
`up` operations measured **4.907 / 4.921 / 4.915 s**, median **4.915 s**. Three
selected guest runs measured **5.757 / 5.895 / 5.877 s**, median **5.877 s**;
their preparation-before-pytest median was **2.854 s**. Every build group and
fixture was cached and all commands passed. `accept-final-stable.json` records
the commands, manager intervals and full run IDs (`074807.423475Z-1100942`
through `074833.835088Z-1107507` on 2026-10-29). These are the final unchanged
acceptance samples; earlier measurements and their distinct conditions remain
above.

### Isolated cold preparation and C archive invalidation

Two temporary checkouts copied the current tracked and untracked source plus
submodule source, with empty Cargo output, Python environment, Node modules,
Runner image cache and dependency volumes. Source copy took 4.205 s and 1.615 s.
Nix, package downloads, Cargo registry, Go caches and container images were
retained; this is not a fresh operating-system measurement. Separate ports,
state and short Runner homes kept these runs away from the normal environment.

| Attempt | External wall (s) | Outcome and retained evidence |
| --- | ---: | --- |
| First empty-output setup | 508.68 | Failed: dependency worker loaded `@aws-sdk/client-s3` before Node installation. Runtime 233.943 s, Python 45.836 s, Node 75.164 s, C/Go 32.949 s, CLI 35.619 s, Runner 30.576 s; `empty-build-node-race` |
| Recovery with bucket ordering fixed | 73.36 | Failed: cold image/rootfs preparation exceeded smoke's old 30 s HTTP ceiling; `cold-image-http-timeout` |
| Second empty-output setup | 134.57 | Failed: libseccomp release download returned TLS EOF; dependencies passed. Original version/checksum retained; `libseccomp-tls-failure` |
| Same second checkout, resumed | 408.26 | Passed storage, services and both guest/log smoke cases (28.26 s pytest); `corrected-setup-success`. Runtime 138.684 s, Python 40.163 s, Node 69.289 s, C/Go 30.199 s, CLI 50.636 s, Runner 29.999 s, services 13.623 s |

The second checkout's actual setup cost was **542.83 s across both invocations**,
plus its 1.615 s source copy. Calling 408.26 s a complete cold build would omit
the failed download's partial compilation. `accept-isolated-results.json`
contains original run IDs, all stage intervals and preserved evidence under
`target/e2e/isolated/<label>/`.

The bucket defect is fixed by performing only container/protocol readiness in
the concurrent dependency worker, then creating the bucket in `storage` after
`prepare()` and dependency completion. No second SDK or bucket-init image is
introduced. The cold HTTP failure occurred after all four image layers were
downloaded, while rootfs was still being assembled. Smoke now permits 120 s for
that create request within its existing 180 s case limit, retaining the same
guest/header/API-log/Runner-success assertions and all original failures.

In the first isolated checkout, temporarily changing the C ABI version to
`0.10.8-e2e-cache-proof` changed the archive SHA, rebuilt C/Go, and invoked Runner
with `E2E_GO_REBUILD=-a`. C and a separately linked Go probe both returned that
version; real Go create/exec/remove passed (`20261029T073842.138267Z-988681`,
104.09 s external including startup). Restoring the original source returned
both ABI probes to `0.10.8`, forced Runner relinking again, and passed the same
Go guest case (`20261029T074226.889273Z-1043930`, 69.54 s external).
`accept-final-abi.json` and the changed/restored logs preserve the hashes and
observations. No shared Go cache was cleared and the normal source was not
modified for this probe.

Both isolated environments were stopped through their public `down` entry
(13.82 / 13.84 s, exit 0). Evidence was copied to the main state before removing
the temporary checkouts and probes. The final normal-checkout smoke also passed
both guest/log cases (`20261029T074259.439103Z-1055993`, 7.29 s external,
0.90 s selected pytest).



### Local runtime integration and host pitfalls

The earlier full `make test:integration` attempt is a separate coverage surface from REST. Its output ends in Make failure; no overall wall measurement was retained.

| Surface | Observed result | Limit |
| --- | --- | --- |
| Rust VM integration | 293 passed, 13 ignored across 36 test executables | Ignored cases remain unexercised |
| CLI integration | One `network_tunnel` failure: `NotFound` at `src/cli/tests/network_tunnel.rs:155` | Other CLI executables reported results; this is not a green CLI suite |
| Python integration | Three collection errors loading greenlet: `libstdc++.so.6` unavailable; 246 deselected | Collection failed before those selected tests ran |
| Node integration | 95 passed, 1 failed, 17 skipped; 82.43 s Vitest duration | Secret-boundary case returned exit 1 instead of 0 |
| C integration | Two CTest targets passed; 38.97 s CTest real time | This measured CTest selection, not all SDKs |

The flake shell exports `${pkgs.stdenv.cc.cc.lib}/lib` through `LD_LIBRARY_PATH`. Greenlet import succeeded after that prerequisite fix. The full Python integration rerun collected 449 items, selected 193 and finished with **169 passed, 1 failed, 23 skipped, 256 deselected in 196.22 s** (228.47 s external wall). Only the secret-upstream assertion failed; collection and sync SSH passed. The CLI `network_tunnel` portability fix replaces the missing `/bin/kill` with the shell builtin: its focused Make rerun passed in 0.06 s (105.02 s external due shared builds and all CLI executables being compiled). The separate Go archive VM integration passed in 60.53 s (69.42 s external).

| Pitfall | Recorded handling / current state |
| --- | --- |
| Rootless runtime | `docker` is Podman; dependency commands must use its available CLI behavior |
| MinIO client image | `minio/mc` fetches failed at both checked registries; bucket setup uses the application's existing S3 client |
| Nix preparation | A mistaken Corepack attribute was corrected; offline evaluation attempted unavailable source builds; ordinary `nix develop` fetched the required closure in 14.38 s. These are preparation costs |
| FUSE activation | Active `user_allow_other` and `mount_max = 1000` are present. User scopes make the MinIO mount reachable, but real writes still fail as detailed above; activation is not persistence proof |
| Log readiness / authoring prerequisite | Run `20261029T034655.566927Z-1834551` ended incomplete with exit 1 in 82.410 s before the selected authoring case. Guest execution reached the smoke assertion, but the API log had no matching box ID. The managed environment now enables request logs and waits up to 5 s for the same-box log assertion; recovered smoke and authoring evidence follows below |

That incomplete authoring attempt reused runtime and all SDKs but rebuilt CLI (47.356 s) and Runner (29.045 s); services took 2.648 s. Build outputs changed during concurrent integration activity. Preserve the startup/log failure independently from the unexecuted authoring case; it is not a wrong-assertion demonstration or corrected-case pass.

Request logging is now `LOG_REQUESTS_ENABLED=true` in `manage.py`; the existing API-log assertion polls asynchronously before asserting (`cases/test_path_verification.py:110-117`). [Pino's transport documentation](https://github.com/pinojs/pino/blob/main/docs/transports.md#v7-transports), reopened on 2026-10-29, describes asynchronous worker-thread transports. The bounded wait observes log delivery without repeating the product operation or weakening the box-ID assertion.

| Recovered authoring run | Observed result | Timing / cache limit |
| --- | --- | --- |
| `20261029T034952.640433Z-1879094` | Startup smoke: 2 passed in 0.84 s; real one-file stdout/stderr/exit=42 case: 1 passed in 0.55 s; exit 0, complete | Manager 89.219 s; external command 91.23 s. C/Go stage 33.770 s, Runner 28.731 s and services 22.573 s; recovery with rebuilds |
| `20261029T035148.642255Z-1905975` | Same public `make test:e2e E2E_ARGS=cases/test_authoring_acceptance.py`: 1 passed in 0.48 s; exit 0, complete | Manager 3.032 s; external command 4.66 s. Seven build groups and fixtures cached, services 0.235 s; no service restart |

The case asserted guest stdout `e2e-out`, stderr `e2e-err` and exit 42. The intentional wrong expectation is preserved in `20261028T195452.494112Z-2467711/pytest.log`: actual `('e2e-out', 'e2e-err', 42)` differed from `('wrong-expected-output', 'e2e-err', 42)`; 1 failed in 0.52 s, complete evidence and exit 1. The unchanged corrected run recorded setup 0.42 s, call 0.03 s and teardown 0.01 s. The temporary case was removed; `apps/e2e/README.md` retains the runnable pattern. One-file authoring is verified without registry changes or a service rebuild.

Final authentication smoke used the stored local Dex OIDC profile through the public Make entry. `20261029T040938.756751Z-2096881` passed five cases (Python chain, CLI identity, CLI create/exec/remove and UUID-named create) in 1.96 s; manager 4.775 s, external 6.36 s. The API-key named-case rerun `20261029T041048.509793Z-2108424` also passed (0.67 s pytest, 5.32 s external) while the prior fixed-name resource remained in the persistent environment. `target/e2e/oidc-login.log` records successful real Dex device login; no access token is reproduced here.

### Optimization priorities

| Priority | Evidence / worthwhile change | Trade-off / acceptance |
| --- | --- | --- |
| 1: Avoid avoidable rebuilds/restarts | Fully cached narrow runs finish externally in 5.224–5.283 s; the anomalous CLI rebuild alone costs 42.021 s, and later CLI/Runner rebuilds dominate an 82.410 s incomplete run | Keep source, build environment and artifact identity correct, including cgo archive changes. Explain cache misses; never reuse stale artifacts to hit a target |
| 2: Preserve deterministic readiness evidence | An earlier guest roundtrip reached a failed API-log assertion; enabling request logs and bounded transport polling subsequently passed the two-case startup smoke | Retain the same-box assertion and original failed attempt. Do not equate HTTP/container readiness with guest readiness |
| 3: Target measured suite costs | Idle auto-stop/delete alone took 220.028 s (API key) / 216.019 s (OIDC); two failed timeout calls add about 90.8 s | Keep lifecycle/deadline coverage real. Fix evidenced behavior and offer selectors for iteration; shortening contractual waits or hiding failures would change coverage |
| 4: Overlap only independent preparation | Dependencies can start during compilation; an empty checkout exposed bucket initialization using the Node S3 SDK before Node installation finished | Container readiness remains concurrent. Bucket creation now has its own `storage` stage after dependency readiness and source preparation. No default xdist while organization/catalog state is shared |

| Phase | Evidence / remaining opportunity | Decision and required proof |
| --- | --- | --- |
| Host and tools | First shell closure fetch took 14.38 s; missing greenlet C++ runtime stopped collection | Keep `nix develop` toolchain and C++ runtime exports. Separate shell provisioning from repeated E2E measurements |
| Cold package installation | Empty-checkout Python/apps setup happened before runtime compilation; broad apps workspace installation pulls unrelated frontend dependencies | Reuse existing Make install contract now. A smaller server-only dependency workspace would need its own lock/install verification; do not silently prune dependencies |
| Native compilation | Empty output required runtime 233.943 s, Node 75.164 s, Python 45.836 s; rebuild identity errors previously added 42–47 s to a narrow run | Reuse current artifacts only when source and artifact fingerprints match. One build owner per Cargo output; no duplicate SDK/runtime preparation |
| FFI linkage | Go caches do not detect external static archives; Runner and Go drivers use the debug C archive | Archive changes require forced Go recompilation; verify ABI version and actual guest execution, rather than checking a build flag alone |
| Image/network | First isolated guest downloaded four layers then built rootfs; the old 30 s HTTP timeout fired during that work. A later isolated build saw libseccomp TLS EOF | Keep original network failures. Smoke create now allows 120 s inside the existing 180 s case ceiling; no product timeout or assertion changes. Record image pull/rootfs costs separately; pin existing dependency digests |
| Service readiness | Cached live service checks take about 0.25 s; three stopped-service starts reached guest proof in a 14.097 s median | Reuse healthy owned processes; recover only the dead service. Preserve explicit PG/Redis/HTTP/Runner checks and same-box guest/log proof |
| Fixture readiness | Retired schema and snapshots were startup blockers; repeated unchanged fixtures add work but no new coverage | Current authenticated organization, existing API, isolated credentials and readiness fingerprint. Case-only edits reuse fixture state |
| Test selection | Final full API-key test stage 640.670 s versus roughly one second for the selected test subprocess | Use `FILTER` or exact nodeid for iteration, and retain the full suite for broad validation. No second test registry or generated case definition |
| Contractual waits | Corrected full suite: idle lifecycle 221.058 s; two timeout failures total 90.902 s; four catalog absence windows each about 25–28 s | Lifecycle alone is 34.5% of the test stage. Keep real observation windows; prioritize evidenced deadline/lifecycle product defects separately. Parallel workers first need isolated aliases and organization state |
| Reporting/diagnostics | Initial CLI summary claimed unexecuted commands; missing XML/JSONL can conceal an interrupted run | Report observed outcomes and actual stop points; keep per-attempt original logs, phase events and JUnit. Generate summaries without rerunning tests |
| Cleanup | Three down operations took 12.635 / 13.039 / 14.490 s; failed cleanup attempts must not prevent remaining owned cleanup | Keep bounded graceful stop and retained caches. A faster shutdown requires service exit evidence; do not replace it with broad process kills or data deletion |
| CI queue/host | A historical runner-registration wait consumed 316 s without tests; a green label gate had all test jobs skipped | Treat runner availability and executed jobs as separate signals. Persistent build/image caches help after a real runner comes online; no local timing proves cloud startup improvement |


### Final acceptance evidence

`make test:e2e:check` passed seven library checks and 29 reporting/lifecycle tests after the final bucket-ordering change (0.76 s pytest, 3.54 s external). The final normal-checkout guest/log smoke passed separately after the cold-create timeout change. Offline checks establish harness behavior; real guest runs establish the product path.

| Acceptance | Exercised result | Evidence / limit |
| --- | --- | --- |
| API-key full suite | 210 passed including 16 offline; 12 failed, 7 skipped, 5 xfailed; no setup errors | `20261029T035217.199510Z-1911308`; 643.214 s manager. UUID name fix subsequently passed in a focused run; the full verdict is preserved |
| OIDC full suite / local Dex login | 165 passed including 16 offline; 13 failed, 52 skipped, 4 xfailed | `20261028T194306.955380Z-2351242`; 533.449 s manager. Real device login and later five-case authentication smoke passed; this does not replace the full verdict |
| Managed-volume persistence | **Failed:** mount reachable, guest writes fail for default user and explicit root | `20261029T041124.302778Z-2121195`; no remove/recreate/read claim |
| Local VM integration | Rust/C/Go paths executed; Python rerun 169 passed / 1 failed / 23 skipped; Node 95 passed / 1 failed / 17 skipped | Initial full integration and targeted environment/portability reruns are above; aggregate is not green |
| Warm unchanged preparation | **Passed:** final unchanged series has 2.854 s median before selected pytest; selected command median 5.877 s, unchanged `up` median 4.915 s | `accept-final-stable.json`; three samples each, every build group and fixture cached |
| Stopped-service warm startup | **Passed:** three stop/up cycles through guest and both-log proof; 14.097 s external startup median | `accept-lifecycle.json`; retained data/build/image caches |
| One-file case addition | **Passed:** wrong expectation failed, corrected stdout/stderr/exit=42 passed, cached public command 4.66 s | Wrong case `20261028T195452.494112Z-2467711`; corrected `20261029T035148.642255Z-1905975`; temporary case removed |
| Busy lock | **Passed:** second public operation failed with exit 2 while owner later finished | `20261029T035106.380467Z-1899079`; offline independent-lock test also passed |
| Port ownership | **Passed:** conflicting API-port override failed before preparation; listener and process records survived | `20261029T070551.719702Z-558624`; `accept-final-port-conflict.json` |
| Empty selector | **Passed:** manager exit 5, Make exit 2; 234 deselected, zero coverage | `20261029T065948.398025Z-511839`; report says complete evidence, not passing tests |
| Ctrl-C and next run | **Passed:** manager 130 / incomplete, Make terminated by SIGINT; existing services unchanged; next chain run 2 passed | `20261029T065936.881739Z-509748` and `20261029T065953.542575Z-513148`; `accept-final-interrupt.json` |
| Single-service recovery | **Passed:** terminated the verified owned Runner; `up` restarted only Runner and passed guest/log smoke in 7.288 s externally | `20261029T070956.255947Z-588636`; `accept-final-service-recovery.json`; API/proxy PID identities unchanged |
| Missing/damaged reports | **Passed:** copies of an actual two-case run remain complete unchanged; missing/broken XML, truncated JSONL and missing sessionfinish each become incomplete | `accept-final-report-damage.json`; originals preserved |
| Report regeneration | **Passed:** per-run summaries preserve full failures and incomplete interruption; offline passes separated | `make test:e2e:report` → `target/rest-test-report/rest-report.md` |
| Isolated cold source preparation | **Passed after recorded failures:** empty output rebuilt runtime/SDKs/services and proved real guest/log readiness | 542.83 s across download-failed and resumed corrected invocations; source copy 1.615 s; `accept-isolated-results.json` |
| Static archive invalidation | **Passed:** changed and restored C/Go ABI versions, archive SHA changes, forced Runner rebuild, real Go guest roundtrip in both states | `accept-final-abi.json`; isolated source restored and both environments stopped |

One attempted Ctrl-C probe watched line-buffered console output and missed its readiness deadline. That command ran normally and retained the original 45.49 s timeout failure (`20261029T065615.664576Z-484987`); it is not interrupt evidence. The successful probe waited for the flushed setup event in `cases.jsonl` before signalling the public process group.

### Independent CLI matrix

Both authentication modes ran through `manage.py exec -- make test:rest:cli AUTH=<mode> SCOPE=full`, using the isolated profile and curated image. Initial attempts failed on an obsolete `/tmp` transfer destination (12.089 s API key, 5.759 s OIDC). The current file-transfer contract and CLI examples use `/workspace`; the matrix now uses it and both directions pass.

Corrected attempts took 11.287 s / 5.741 s externally, then failed at `restart box` with `State change in progress`. Runs: `20261029T072126.039724Z-720676` and `20261029T072134.806608Z-726368`. Auth, list aliases, create/start, real exec stdout, inspect/stats and roundtrip file copy completed. Post-restart exec and one-shot run were not reached. The matrix summary now lists completed commands and its actual stop point; it no longer labels the remaining plan as covered. The original failed logs remain inside their manager run directories. Shell syntax and ShellCheck passed after the script change.

The regenerated static inventory found 48 spec operations: 39 active, 28 with text-based candidates, 11 missing candidates and nine unsupported/stale. Candidate matching is not execution coverage; volume cases, for example, ran despite the text scanner reporting no candidate for their operation names.

Normal environment `status` finally reported API, Runner and both proxies healthy
and all five dependency containers running (`20261029T075158.309799Z-1136435`).
The isolated test containers, their four named data volumes per checkout,
temporary source/build directories and short Runner homes were removed after
verified ownership and stopped state; `accept-isolated-cleanup.json` records
the exact resources. Normal environment data and caches remain available for
the next standard command.

The one-file authoring exercise measured command/setup/call/teardown costs;
manual editing time was not separately instrumented. Report totals must not
invent that human interval. All recorded files under `target/` are local build
artifacts; the dated investigation and runbooks preserve the findings in the
repository.

### Final repository checks

The changed-component `nix develop -c make test` finished with exit 2 in
**1,222.56 s** externally. CLI integration passed. Python unit tests passed
(256 Python and 33 binding tests); Python integration finished with 169 passed,
one failed, 23 skipped and 256 deselected in 207.98 s. The failure remains
`test_secret_substitution_reaches_upstream`, where wget returned exit 1.

The apps infrastructure selection reported 710 passed, 23 failed and one
skipped. Failures included fixture shells missing `cat`/`rm`, hardcoded
`/usr/bin/make` missing on this host, and cache-environment assertions. The apps
aggregate stopped at that prerequisite; its subsequent Nx matrix did not run.
These failures do not establish a passing repository-wide test result.

`make lint`, Rust/Python formatting, changed Runner Go formatting, Bash syntax
and ShellCheck passed. Whole apps formatting reported 199 generated API-client
files outside this change; they were left unchanged. The final offline E2E
check passed seven library and 29 reporting/lifecycle checks with unchanged
source hashes before and after execution.

A final guest/log run, `20261029T100729.868230Z-2126631`, passed both chain
checks in 1.16 s of pytest time. Its command took **316.09 s** externally
(308.564 s manager wall): runtime 158.607 s, C/Go SDK 72.051 s and Runner
61.334 s. Shared artifacts had changed and compilation waited for Cargo locks
while repository verification ran. This is a rebuild-contention sample;
compare the earlier unchanged samples separately. The recorded report was
regenerated after this run.



Private-image cases remain unavailable without real private-image coordinates and read-only credentials. No credentials or OIDC profile tokens are included here. A fresh operating system, Ubuntu end-to-end acceptance, other host platforms and concurrent case isolation have not been demonstrated. The [runbook prerequisites](../../../apps/e2e/README.md#prereqs) distinguish the measured environment from those unverified paths.


## 2026-10-30 audit follow-up

The branch was rebased onto `main` after the local-registry test-image change.
The Node cases keep `npx` as the unmanaged fallback because `e2e-cloud.yml`
installs only the SDK; the managed run still passes its own `tsx` through
`BOXLITE_E2E_TSX`, and a missing managed target fails instead of skipping.

Four implementation defects found in review are fixed:

- `build-runtime.sh` now checks the exit status of `cargo build` and
  `cargo metadata`; a failed `--locked` build can no longer fall back to a
  stale `out/runtime`.
- Build reuse hashes more than sources: makefiles, build flags, the
  build-relevant environment and tool versions are part of the identity.
- Dependency containers carry a credential fingerprint. A changed password or
  Dex configuration recreates the container, and the PostgreSQL volume is
  removed because initdb reads `POSTGRES_PASSWORD` only once.
- The E2E Python environment is isolated in `.venv-e2e`; `test:e2e:check`
  uses that environment when synced and the devshell Python otherwise, and
  `test:e2e:report` exits nonzero on incomplete evidence. A new
  `e2e-harness.yml` runs the checks on harness changes; it needs no KVM,
  containers or network.

The Runner `systemd-run --user` change moved to its own branch. The unsafe
`two_sided.sh` helper and its make target were removed in favor of the
separate-worktree method above. `setup` and `up` now differ: `up` starts or
recovers without repeating the guest smoke.

After the changes, `make test:e2e:check` passes 14 library checks and 37
lifecycle/reporting checks locally, and `make test:e2e:deps` syncs the pinned
environment into `.venv-e2e`. Still unverified or unchanged: only the harness
checks run in CI, the full managed stack has only been accepted on x86_64
NixOS, the recorded full-suite failures remain, and rootless volume writes
still fail after the mount starts (the companion Runner change).
