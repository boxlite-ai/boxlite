# End-to-end test suite

These tests exercise the **full production path**:

```
Python SDK (boxlite.Boxlite.rest) → HTTP → NestJS API → HTTP → boxlite-runner → libkrun VM
```

Existing `make test:integration:*` tests use the local PyO3 / FFI path
(`Boxlite.default()`) and bypass both the API and the runner — so a bug that
only surfaces on the REST → API → runner chain (e.g. #563's exec-stdout drop,
#627's attach re-drain) will pass those tests and reach production. This suite
exists to catch those.

It sits under `apps/` because the stack it drives — `apps/api`, `apps/runner`,
`apps/proxy` — does. It is **not** an Nx project: there is no `project.json` or
Jest config for Nx to infer, and pytest invokes its polyglot SDK drivers. It is
also **not** what `npm run e2e:local` starts — that command brings up the local
Dex environment for the dashboard. Drive this suite through the
`make test:e2e*` targets.

The wider REST API test flow, from the contract inventory and this suite to the
CLI matrix and both authentication modes, is in
[`rest-api-e2e.md`](rest-api-e2e.md).

## What the suite verifies

Product acceptance cases use the REST-mode runtime built by `conftest.py::rt`.
`test_network_harness.py` separately checks probe failures and framing without
creating a box; those checks are not counted as product E2E evidence.

`cases/test_path_verification.py` creates a real box and checks the API version
header, guest stdout and the local API/Runner file logs. The Runner must record
a successful CREATE_BOX for that same box ID. File offsets isolate the current
operation; remote runs retain the header and guest checks when logs are unavailable.

## What the managed workflow changes

The managed workflow runs the existing REST E2E suite through `manage.py`.
The SDK → API → Runner → VM path, pytest discovery and `rt`/`box`/`drain`
fixtures already existed. This change standardizes preparation, source builds,
resource ownership and execution evidence around that suite.

| Concern | Previous local workflow | Managed local workflow |
| --- | --- | --- |
| Entry | `test:e2e:setup` ran bootstrap and fixture scripts; `test:e2e` assumed a prepared stack; `run.sh` could bootstrap separately | Make and `run.sh` share `manage.py`; `run` prepares or recovers before testing |
| Environment | Ubuntu installer used sudo, apt, host PostgreSQL/Redis, systemd units and `/etc` configuration | Five dependency containers; native API/Runner/proxies; repository state and isolated profiles; daily commands need no sudo |
| Source clients | `run.sh` could install published Python SDK; C/Go wrappers could use release/prebuilt artifacts | Build current-checkout SDKs and services; C/Go use the debug archive; compilation failures remain failures |
| Repeated runs | API systemd activity could skip bootstrap without checking current source identity | Check build inputs and artifact hashes; reuse healthy owned services; case-only edits skip native builds |
| Fixtures | Snapshot registration and quota SQL referenced retired API/schema | Configure only the authenticated test organization and prove current create/exec/remove behavior |
| Selection | `test:e2e` lacked FILTER forwarding; REST and direct pytest had separate selection paths | `FILTER` and exact nodeids through `E2E_ARGS` use the same runner |
| New cases | Pytest already discovered `cases/test_*.py` and supplied shared fixtures | Same mechanism, now documented with a verified example; no registry or generator added |
| Results | Pytest/CI logs and JUnit existed; preparation and attempts lacked a common evidence directory | Each operation records stage times and original exit; test runs reconcile phase events with JUnit, separating offline checks and incomplete evidence |
| Stop/recovery | Explicit system-service maintenance scripts | Verified owned processes/containers; state lock; `down` retains data and caches; `up` recovers failed services |

Use [the local commands](#running-against-local-stack) for this REST stack.
`make test:integration` remains the local runtime/FFI suite; `apps/`'s
`npm run e2e:local` remains the Dashboard/Dex environment. The existing
`e2e-local.yml` runs the former integration suite, while `e2e-cloud.yml` still
runs pytest against a deployed API. Those CI workflows have not been migrated
to the managed local lifecycle; shared case changes also affect their runs.

Most changes are E2E scripts/cases, Make targets, development tools and docs.
SDK public interfaces are unchanged. Rootless volume mounts additionally need
the companion Runner change that selects `systemd-run --user --scope` for
non-root processes; this branch does not change product code. Host KVM/FUSE
prerequisites still apply.

This workflow does not freeze every dependency or establish production-deployment
parity: the API runs from source through ts-node, and the standard environment
does not start Dashboard or external billing/telemetry services. Full test
failures and volume-write limitations remain visible. See the
[dependency reproducibility boundary](../../docs/contributing/investigations/2026-10-29-e2e-standardization.md#dependency-reproducibility-boundary)
and [measured acceptance](../../docs/contributing/investigations/2026-10-29-e2e-standardization.md#final-acceptance-evidence).


## Prereqs

Linux with readable/writable `/dev/kvm`, a Docker-compatible container CLI
(tested with rootless Podman), Python 3.11+, Node 22.12+, Corepack, Go, Rust and
native build tools. The repository's Nix shell supplies the toolchain:

```bash
nix develop -c make test:e2e:doctor
nix develop -c make test:e2e:setup
nix develop -c make test:e2e FILTER=exec_working_dir
```

The complete managed stack has been exercised on x86_64 NixOS with rootless
Podman. Ubuntu uses the same Linux entry, but has not yet had an end-to-end
acceptance run. `make setup` supplies build tools; Docker access, Corepack/Yarn,
the `psql` client and volume prerequisites must also be available. Ubuntu 24.04
may need the [documented user-namespace setup](../../docs/guides/troubleshooting.md#ubuntu-2404-timeout-waiting-for-guest-ready--box-only-starts-with-sudo).
The Nix shell supplies tool packages, while KVM/FUSE permissions and container
runtime access remain host requirements.

`setup` builds the current runtime and SDKs, starts isolated PostgreSQL, Redis,
Registry, Dex and MinIO containers plus native API/Runner/proxies, configures the
test organization, and proves a real guest exec. `make test:e2e` also prepares a
missing environment; unchanged healthy environments reuse their services and
build outputs. The first run records the actual dependency/build/pull costs.

Container startup overlaps source preparation. MinIO bucket creation waits for
the application's Node dependencies and MinIO readiness; the first guest create
allows up to 120 seconds for image download/rootfs construction. This is startup
preparation time, recorded separately from cached single-case execution.

| Command | Behavior |
| --- | --- |
| `make test:e2e:doctor` | Check tools, KVM/FUSE access, ports and volume prerequisites |
| `make test:e2e:setup` | Prepare source clients, services, fixtures and guest smoke |
| `make test:e2e:up` | Start or recover the environment without repeating the guest smoke |
| `make test:e2e [FILTER=expression]` | Run all cases or pytest's `-k` selection |
| `make test:e2e E2E_ARGS='cases/test_exec_user.py::test_exec_user_runs_as_requested_ids'` | Run one exact nodeid |
| `make test:e2e:status` | Inspect the owned environment |
| `make test:e2e:down` | Stop owned services; preserve data, keys and caches |
| `make test:e2e:report` | Aggregate recorded results and timings |
| `make test:e2e:check` | Run the harness checks without services, using `.venv-e2e` when synced and the devshell Python otherwise |

Run from the repository root, inside `nix develop` or another complete development
environment. `apps/e2e/run.sh` enters the same manager and accepts pytest arguments.
Only one operation runs against a state directory at a time; a busy environment
fails visibly rather than racing its catalog and organization state.

Default state is `target/e2e/`, including isolated CLI profiles, secrets, process
ownership, logs and `runs/<id>/` evidence. `BOXLITE_E2E_STATE_DIR` chooses another
state directory. The Runner has a short separate home under `/tmp/ble2e-*` to
avoid Unix socket path limits. Nothing rewrites the user's normal CLI profile or
installs system services. The old `bootstrap.sh`/`teardown.sh` remain explicit
Ubuntu system-service maintenance scripts; they are not an alternative entry
point for the managed commands and are not covered by their checks.

Default ports are API 3300, Runner 38080, Preview Proxy 34000, Registry Proxy
34100, PostgreSQL 35432, Redis 36379, Registry 35000, Dex 35556 and MinIO 39000.
Override with `BOXLITE_E2E_<SERVICE>_PORT`; service names are `API`, `RUNNER`,
`PROXY`, `REGISTRY_PROXY`, `POSTGRES`, `REDIS`, `REGISTRY`, `DEX`, `MINIO`.
An occupied port is an error; the manager never kills the listener.
Containers publish loopback ports; native servers retain their existing bind
behavior. Use a trusted development host.

Managed volumes need `mount-s3`, `/dev/fuse` and `user_allow_other` in
`/etc/fuse.conf`. NixOS hosts should set `programs.fuse.userAllowOther = true;`
once in their system configuration. Daily E2E commands never escalate privileges.
Missing volume prerequisites remain visible and must not be counted as coverage.

With the companion Runner scope change, the recorded rootless MinIO run reaches
the guest mount but still fails writes with permission/I/O errors. The startup
smoke proves guest exec and API/Runner logs; it does not assert volume
persistence. See the
[measured results and remaining failures](../../docs/contributing/investigations/2026-10-29-e2e-standardization.md#execution-observations)
before treating local startup as full-suite success.

`BOXLITE_E2E_IMAGE` overrides the locked curated image associated with
`apps/box-images/VERSION`. The manager exports the selected ref as both
`BOXLITE_E2E_IMAGE` and `BOXLITE_SYSTEM_BASE_IMAGE`, because API image admission
matches curated refs by exact string: a digest-pinned ref is otherwise treated
as an unregistered `ghcr.io` image and rejected with HTTP 400. Catalog references
retain their explicit tag/digest contracts through `BOXLITE_E2E_CATALOG_IMAGE`.

## Locked dependencies

The [portable dependency design](https://github.com/boxlite-ai/boxlite/issues/2207)
locks the managed E2E path without changing Ubuntu's apt packages, system Python,
native compiler installations or the public SDK compatibility ranges.

| Layer | Managed E2E contract |
| --- | --- |
| Python tools | `apps/e2e/pyproject.toml` and universal `uv.lock`; pinned uv, `sync --locked --inexact` into the dedicated `.venv-e2e`; Python 3.11+ stays host-provided |
| Apps | Checked-in `apps/yarn.lock`; Corepack selects the declared Yarn version and installs with `--immutable` |
| Node SDK | Checked-in `sdks/node/package-lock.json`; `npm ci` refuses manifest drift |
| Service and guest images | `dependencies.json` pins multiarchitecture indexes for PostgreSQL, Redis, Registry, Dex and the curated guest; each supports Linux amd64 and arm64 |
| MinIO | Same historical release, official per-architecture binary SHA-256 plus license checksum, built into the local scratch image by `Minio.Dockerfile`; no dependency on the retired image registry |
| Rust / Go | Managed builds use the existing Cargo lock with `--locked` and Go read-only module resolution. Native compiler versions remain recorded host inputs; nested vendor builds and sum files are not a hermetic toolchain |

The manager fingerprints manifests, locks, interpreter identity, build recipes,
build flags and tool versions. Dependency changes refresh installs and affected
clients/API readiness; unchanged runs reuse them. Python synchronization uses
`.venv-e2e`, so the SDK `.venv` and unrelated developer tools are untouched.
A Python older than 3.11 is rejected. Normal `make dev:*` dependency policies
remain available.

Use `make test:e2e:deps` to install the locked Python environment, or
`make test:e2e:deps E2E_PYTHON=/absolute/venv/bin/python` to validate a separate
environment. After deliberately changing Python requirements, run
`make test:e2e:lock` and review both manifest and lock. For Node changes, regenerate
the existing lock with its package manager before running E2E. Image updates must
verify both supported architectures; a changed guest VERSION requires updating
its locked version and digest together.

`make test:e2e:build:minio` builds only the checksum-verified historical MinIO
release for this host. Downloads are cached by their locked SHA-256 and
re-verified on reuse, so a Dockerfile change rebuilds the image without fetching
the binary again. Existing owned containers reconcile their image, port,
credentials and Dex configuration; a changed PostgreSQL password recreates its
named volume because initdb reads it only once. This does not establish guest
volume-write correctness or a maintained production storage recommendation.

## Running against a remote API (dev / staging)

No bootstrap or fixture_setup needed — just set environment variables:

```bash
# Required:
export BOXLITE_E2E_API_URL=https://dev.boxlite.ai/api
export BOXLITE_E2E_API_KEY=blk_live_...        # your API key for the remote env
export BOXLITE_E2E_AUTH=api-key

# Optional (auto-discovered from /v1/me if omitted):
export BOXLITE_E2E_PREFIX=<org-path-prefix>

# Image must exist on the remote runner. run.sh otherwise derives this from
# apps/box-images/VERSION, so a local run needs no override:
export BOXLITE_E2E_IMAGE=ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0

# Skip local-only checks (journalctl, runner log):
export BOXLITE_E2E_SKIP_PATH_VERIFY=1

# Or keep path verification on a runner started by hand (a local stack on
# macOS has no systemd journal): read its log file instead of journalctl.
export BOXLITE_E2E_RUNNER_LOG=/path/to/runner.log

# Image the catalog case boots, which must be on a host the API's allowlist
# admits. Defaults to a small public one on quay.io, so a run needs no override:
export BOXLITE_E2E_CATALOG_IMAGE=quay.io/libpod/alpine:latest

# Two tags of one repository with different digests, the repository spelled
# the same in both, which the tag case pulls and moves a tag between. Defaults
# to two alpine releases on Docker Hub, so a run needs no override. Moving a
# tag takes the write:images scope, which an API key made before that scope
# existed does not have:
export BOXLITE_E2E_TAG_IMAGE_OLD=docker.io/library/alpine:3.19
export BOXLITE_E2E_TAG_IMAGE_NEW=docker.io/library/alpine:3.20

# Only for a stack that predates the image catalog: skip that case instead of
# failing. Without it a 404 on /images is treated as the regression it is:
export BOXLITE_E2E_ALLOW_MISSING_CATALOG=1

# The private image case runs only with a real private image and its login,
# written with its host and a tag or digest. The prefix defaults to the
# image's namespace. It adds its own login and refuses to start while the
# organization already has one for that registry and prefix:
export BOXLITE_E2E_PRIVATE_IMAGE=ghcr.io/acme/private-app:1
export BOXLITE_E2E_PRIVATE_USERNAME=acme-bot
export BOXLITE_E2E_PRIVATE_PASSWORD=...        # a token with read access only
export BOXLITE_E2E_PRIVATE_PREFIX=acme/

# CLI tests need a profile pointing at the remote API:
export BOXLITE_E2E_PROFILE=p1
export BOXLITE_E2E_CLI=/path/to/boxlite   # CLI binary built with REST support
```

Private-image cleanup keeps its login record until deletion succeeds. If the
removal step fails, teardown retries that login; a transient failure must not
leave an untracked credential that prevents the next run.

Then run the profile into `~/.boxlite/credentials.toml` so the CLI
picks it up (one-time per machine):

```bash
mkdir -p ~/.boxlite
cat > ~/.boxlite/credentials.toml << 'EOF'
[profiles.p1]
url = "https://dev.boxlite.ai/api"
api_key = "blk_live_..."
auth_method = "api_key"
path_prefix = ""
EOF
```

The `path_prefix` is auto-discovered at runtime from `/v1/me` — leave
it empty or set `BOXLITE_E2E_PREFIX` explicitly if discovery fails.

Run:

```bash
pytest apps/e2e/cases/ -v --timeout=120
```

For CI, use the stage-specific secrets below. No local bootstrap, Postgres,
or runner services are needed — the remote stack provides everything.

## The cloud legs (CI)

`.github/workflows/e2e-cloud.yml` runs this suite against a deployed
stage. It is dispatch-only, plus one call from `deploy-infra.yml`:

| Stage | Target | Selection | Sweep |
| --- | --- | --- | --- |
| `dev` | `api.dev.boxlite.ai/api` | everything | yes |
| `prod` | `api.boxlite.ai/api` | `-m smoke` | no |

The workflow writes the selected stage's credentials to
`~/.boxlite/credentials.toml` with mode `0600`. Each key's organization is
discovered through `/v1/me`; API-key permissions come from `/api-keys/current`,
not the placeholder scopes in `/v1/me`.

| Stage | Repository secret | Profile | Role |
| --- | --- | --- | --- |
| dev | `BOXLITE_DEV_API_KEY` | `p1` | Existing main suite and sweep; foreign identity for p2 boxes |
| dev | `BOXLITE_DEV_P2_API_KEY` | `p2` | Owns identity-test boxes in a different organization from p1 |
| dev | `BOXLITE_DEV_P2_READONLY_API_KEY` | `p2_readonly` | Reads p2's private previews; cannot manage their network |
| prod | `BOXLITE_PROD_API_KEY` | `p1` | Smoke suite only |

Both dev owner keys need `write:boxes` and `delete:boxes`; the readonly key
may carry only `read:*` permissions or none. Configuration fails before box
creation if any required key is missing/invalid, if p1 and p2 share an
organization, or if p2_readonly belongs to a different organization from p2.
`deploy-infra.yml` explicitly forwards all three dev secrets to the reusable
workflow. Prod neither receives nor requires dev keys.

The dev identity step reuses the SDK builds and runs
`test_preview_private_identity_permissions` with p2 as primary, p2_readonly
as same-org reader, and p1 as foreign identity. It sets
`BOXLITE_E2E_REQUIRE_IDENTITIES=1`, so missing profiles fail instead of skip.
The p1 main suite deselects this case; the identity result is uploaded alongside
the main result as `pytest-identities.xml`. These cases exercise API-key scopes,
not different users, member removal, or OIDC roles.

Run the same identity pair locally with three profiles targeting one API:

```bash
unset BOXLITE_E2E_API_URL BOXLITE_E2E_API_KEY BOXLITE_E2E_PREFIX
BOXLITE_E2E_PROFILE=p2 BOXLITE_E2E_READONLY_PROFILE=p2_readonly \
BOXLITE_E2E_FOREIGN_PROFILE=p1 BOXLITE_E2E_REQUIRE_IDENTITIES=1 \
BOXLITE_E2E_SKIP_PATH_VERIFY=1 \
make test:rest:e2e AUTH=api-key FILTER=preview_private_identity_permissions
```

Use ordinary user-owned API keys: a system administrator can bypass resource
permission checks even when its key declares only read scopes. The actual
denied-write assertions must pass; credential metadata alone is not acceptance.

`smoke` marks the cases that are safe against a paying stage — one box at a
time, no quota probing, no deliberate error storms. Mark a new case
`@pytest.mark.smoke` only if it stays inside that budget.

### What a green run does not cover

Two limits worth knowing before reading a green dev run as proof:

- The volume cases skip unless the stage's key carries volume permission —
  `POST /v1/volumes` answers 403 without it, and dev's key did on 2026-09-22.
  That takes the read-only-mount refusal with it, so that contract is pinned
  but unexercised.
- Short-exec stdout is dropped intermittently on a stage running without
  #1569: the runner writes Close and drops TCP while the balancer is still
  relaying the `101`, so a command that finishes before the client attaches
  can return nothing with exit 0. `test_p0_6_exec_stdout_race.py` reports it.
  Cases that grade a *negative* on stdout — "the secret is not in this dump" —
  carry a sentinel so an empty stream fails instead of passing.

### Known-broken on a cloud stage

Tunnel HTTP exchanges read the complete Content-Length response. Only the
separate Python/Node TLS-shutdown cases carry the remote-only strict xfail
for #1950, and only a missing TLS close_notify **after a complete response**
qualifies. Setup, status, payload and WebSocket failures stay failures.
The independent half-close cases accept only the specific lost-response
failure after a healthy tunnel has been demonstrated. Their strict marks
must be removed when the underlying defect is fixed.

The preview, private-session, revocation and dynamic-policy matrix, including
infra-local and browser setup, is in [network-coverage.md](network-coverage.md).
A stage running an older server can fail this matrix; validate against the
current infra-local source and record the deployed revision separately.

`test_cli_run_foreground_streams_command_output` is marked the same conditional
way for a different reason. `boxlite run
<image> <cmd>` without `-d` is create → WS `/boxes/{id}/attach` → `POST
/start`, and on a cloud stage that upgrade comes back a bare 503 whose body
(`upstream connect error or disconnect/reset before headers`) is an envelope
the API never writes — so it is the load balancing in front of the API that
refuses, though which hop is not established. Every other CLI case detaches,
so nothing else touched that socket and the failure was invisible to a green
suite. A local stack has no load balancer in front of `boxlite-api` on `:3000`
(its `:3001` proxy serves box previews, not API ingress), so the mark applies
only when the stage host is remote; what a local stack does with the attached
form has not been tested. The create lands before the 503, so the case names
its box and removes it by name in `finally` — the id is never printed.

### Boxes must not outlive their run

`auto_remove=True` is a no-op over REST and the API defaults `auto_delete` to
disabled, so a box whose teardown never ran stays in the org for good. That is
what killed the last dev run before this was fixed — run 30787280531: 53
failures, every one `Organization quota exceeded: disk limit exceeded (max
512GB)`.

Two things keep that from recurring:

- `conftest.bound_box_lifetime` fills in `auto_stop` / `auto_delete` on every
  box created through the SDK, and `conftest.with_bounded_lifetime` names and
  bounds the cases that hand-build a REST body, so the stage reclaims a
  stranded box within minutes. They differ in one respect: the SDK door
  applies the pair or neither, because the SDK rejects `auto_delete` that does
  not exceed `auto_stop`; a hand-built body never meets that rule, and the API
  checks only the floors, so each window is filled on its own there.
- `apps/e2e/sweep.py` clears what earlier runs left behind — boxes named
  `e2e-<random>`, which both doors produce (`conftest.e2e_box_name`):

  ```bash
  python3 apps/e2e/sweep.py                     # report only
  python3 apps/e2e/sweep.py --apply             # delete what it reports
  python3 apps/e2e/sweep.py --idle-minutes 120  # narrower window
  python3 apps/e2e/sweep.py --any-name          # ignore the name prefix
  ```

  It only sees the organization its credential belongs to, only considers
  boxes idle for a day, and only ones carrying that prefix. The prefix is what
  makes it safe to run unattended: a report against dev on 2026-09-21 listed
  `pol599-repro` and four siblings — someone's investigation, idle for a day,
  indistinguishable from a stranded box by age alone.

  Some older polyglot drivers (`apps/e2e/sdks/`) and CLI cases still create
  boxes without the prefix or lifetime, so the CI sweep cannot reclaim them.
  The Node tunnel driver now supplies both and disables auto-resume for its
  stopped-box scenario. The ones the
  cloud legs run — Node and the CLI — remove their box in a `finally`, so
  there this only bites when a run is killed mid-driver; the Go and C drivers
  exit past their own cleanup, and both legs `--ignore` those cases.
  Clearing anything left behind means `--any-name`, by a human who has read
  the report first — which is why CI never passes it.

## Running against local stack

```bash
make test:e2e                              # complete available suite
make test:e2e FILTER=exec_user              # selected behavior
make test:e2e E2E_ARGS='-m smoke'           # existing safe smoke selection
make test:e2e:down
make test:e2e:up                            # reuse data and build outputs
make test:e2e:report
```

REST authentication uses the same entry:

```bash
make test:rest:e2e AUTH=api-key
BOXLITE_E2E_PROFILE=oidc make test:rest:e2e AUTH=oidc
```

API-key runs use the environment's isolated `p1` profile. Log in to local Dex
once through the same environment and save an isolated `oidc` profile:

```bash
nix develop -c python3 apps/e2e/manage.py exec -- \
  target/debug/boxlite --profile oidc auth login \
  --url http://127.0.0.1:3300/api --method device
```

Open the printed URL and use the development account from `apps/dex/config.yaml`
(`admin@boxlite.dev` / `password`). The command sets the isolated home and removes
ambient `BOXLITE_API_KEY`. Set the URL to your API port if overridden.
`BOXLITE_E2E_OIDC_TOKEN` can supply an existing token; otherwise the helper
refreshes the selected CLI profile. Both modes discover `path_prefix` through
`/v1/me`. C, Go and Node drivers currently support only API keys and explicitly
skip under OIDC.

Run the independent CLI matrix with the same isolated credentials and services:

```bash
BOXLITE_REST_SMOKE_IMAGE=ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0 \
  nix develop -c python3 apps/e2e/manage.py exec -- \
  make test:rest:cli AUTH=api-key SCOPE=full
BOXLITE_E2E_AUTH=oidc BOXLITE_E2E_PROFILE=oidc \
  BOXLITE_REST_SMOKE_IMAGE=ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0 \
  nix develop -c python3 apps/e2e/manage.py exec -- \
  make test:rest:cli AUTH=oidc SCOPE=full
```

Every operation records its original exit and phase times under
`target/e2e/runs/<id>/`. Test runs also write `pytest.log`, `junit.xml` and
`cases.jsonl` with collection and setup/call/teardown results. Reports separate
test failures, errors, skips, xfails, unexpected passes and incomplete evidence;
`make test:e2e:report` exits nonzero when any recorded run is incomplete, and
`make test:e2e:report REPORT_ARGS=--allow-incomplete` reports without failing.
Offline harness guards are separate from VM coverage. A failed initial attempt
stays recorded after a passing diagnostic rerun.

Ctrl-C records manager exit 130 and incomplete evidence; the next command can
reuse healthy services. An empty selector records pytest exit 5. Make reports its
own nonzero exit for either case, so read `run.json` for the underlying code.
If a service dies, `make test:e2e:status` identifies it and `make test:e2e:up`
recovers it before repeating guest/log readiness. Do not rebuild other targets
against the same Cargo output directory while measuring warm E2E performance.

The [dated investigation](../../docs/contributing/investigations/2026-10-29-e2e-standardization.md)
contains raw run IDs, startup/rerun measurements, original failures and source
comparisons. The standard workflow uses existing pytest fixtures and serial case
discovery; changing a case does not invalidate service or SDK builds.

For regression proof, use separate worktrees with the same candidate test and
compare the original assertion failure against the fix, preserving both results.

## Layout

```
apps/e2e/
├── README.md
├── manage.py                # Source preparation, owned environment and run facade
├── bootstrap.sh             # Explicit legacy Ubuntu system-service installer
├── fixture_setup.py         # Authenticated organization quotas + isolated profiles
├── run.sh                   # Thin direct entry to manage.py run
├── sweep.py                 # Reclaim boxes earlier runs stranded (cloud)
├── pytest.ini
├── lib/
│   ├── catalog_boxes.py     # Boxes against the catalog: pull budget, report window
│   ├── e2e_auth.py          # Auth context: API-key / OIDC, env vars / profile
│   ├── images.py            # Curated ref derived from apps/box-images/VERSION
│   ├── path_verification.py # Helpers that prove SDK→API→Runner was the route
│   └── reporting.py         # Flushed collection and phase result evidence
├── sdks/
│   ├── node/                # TypeScript drivers (fallback: scripts/test/image.js)
│   ├── go/                  # Go drivers + e2e_image.go fallback for direct runs
│   └── c/                   # C drivers + e2e_image.h fallback for direct runs
└── cases/
    ├── conftest.py                  # rt / image / box fixtures (REST-only)
    ├── test_path_verification.py    # Meta-test: prove SDK→API→Runner path
    ├── test_cloud_smoke.py          # /v1/me + /v1/config: the smoke core
    ├── test_lifecycle.py            # Box create / get_info / remove
    ├── test_box_lifecycle_policy.py # auto_stop / auto_delete reaping
    ├── test_box_metrics.py          # Per-box metrics through the runner
    ├── test_volumes.py              # Managed volumes: CRUD + data reuse
    ├── test_network_egress.py       # Outbound policy: block-all, allow_net
    ├── test_exec_*.py               # Exec stdout, attach, timeout
    ├── test_copy_roundtrip.py       # Copy in/out
    ├── test_cli_entry.py            # CLI smoke (run, exec, whoami)
    ├── test_cli_detach_recovery.py  # CLI detach + reattach
    ├── test_node_entry.py           # Node SDK smoke
    ├── test_node_coverage.py        # Node SDK exec, copy, errors
    ├── test_go_entry.py             # Go SDK smoke
    ├── test_go_coverage.py          # Go SDK exec options, copy, errors
    ├── test_images_catalog.py       # Image catalog via rt.images: booting records it, remove drops it, admission refuses bad hosts
    ├── test_images_private.py       # Private image through a login added with rt.images.registries
    ├── test_images_aliases.py       # Alias creation refuses overwrite; explicit replacement affects new boxes
    ├── test_c_entry.py              # C SDK smoke
    └── test_c_coverage.py           # C SDK exec, errors
```

## Adding a case

Add one `cases/test_<behavior>.py`; no registry, generator or CI change is needed.
Use `box` for a per-case guest, or `rt`/`image` when lifecycle itself is under test.
The runtime is REST-only. Existing fixtures own cleanup and default lifetimes;
raw HTTP creation must use `with_bounded_lifetime`.

```python
import asyncio
import pytest
from conftest import drain

@pytest.mark.asyncio
async def test_command_streams_and_exit(box):
    async def execute():
        execution = await box.exec(
            "sh", ["-c", "printf e2e-out; printf e2e-err >&2; exit 42"], None
        )
        out, err = await drain(execution)
        result = await execution.wait()
        return out, err, result.exit_code

    assert await asyncio.wait_for(execute(), timeout=30) == (
        "e2e-out", "e2e-err", 42
    )
```

Run `make test:e2e FILTER=command_streams_and_exit` or pass its exact nodeid in
`E2E_ARGS`. Bound the entire exec/drain/wait sequence: a deadline only around
`wait()` cannot stop a stream that hangs earlier. Assert real guest output and
exit status; negative stream assertions also need a positive sentinel. Register
cleanup immediately for additional boxes, volumes or credentials.

Cases default to serial execution because image aliases, catalog state and
organization quotas are shared. Add `@pytest.mark.smoke` only when the case is
safe against a paying stage: one box at a time and no quota/error storms.
