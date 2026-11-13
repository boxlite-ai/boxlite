# End-to-end test suite

These tests exercise the **full production path**:

```
Python SDK (boxlite.Boxlite.rest) → HTTP → NestJS API → HTTP → boxlite-runner → libkrun VM
```

Cloud runs accept an optional `tag` in the **E2E cloud** workflow, including
reusable calls. For example, `tag=v0.13.1` downloads that release's Python wheel,
Node SDK/native addon and CLI instead of compiling them. Leave `tag` blank to
build clients from the selected checkout, as before. Only stable `vX.Y.Z` tags
are accepted; unavailable artifacts fail the run without falling back to source.

```bash
gh workflow run e2e-cloud.yml -f stage=dev -f tag=v0.13.1
```

Tests still come from the selected checkout and target the selected deployed
stage. On dev, C/Go domain drivers link the released C library; Go SDK source
comes from the release tag. The Rust domain driver compiles against that tag's
Rust SDK, so dev still has some Rust compilation. All driver source programs
come from the test checkout, preserving current acceptance coverage. A release
that lacks APIs required by current tests fails those tests or driver builds.
Prod retains its Python-only smoke selection. This input changes client versions;
it does not deploy or change the cloud stack.

The Node release installer removes SDK development/workspace metadata before
adding the test tools, while retaining runtime dependencies. npm resolves peer
dependencies before applying `--omit=dev`; resolving the published SDK's build
metadata can otherwise abort installation with an `edgesOut` error.
To exercise the real npm resolver and TypeScript tools in a temporary checkout,
run `E2E_RELEASE_REAL_NPM=1 make test:unit:scripts` with the workflow's Node/npm
versions. This opt-in check downloads test tools from the npm registry.

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
[REST API testing](../../docs/contributing/development/rest-api-testing.md).

## What the suite verifies

### Managed checkpoints

`cases/test_checkpoints.py` exercises stopped-source export and upload, source deletion and
creating a Box from the checkpoint through the SDK and actual guests.
Guest reads verify immutable disk contents and inherited environment values.
Deleting the checkpoint must leave the created Box usable.

Stop requests are asynchronous: the case waits for the source to report `stopped`
before capture. Source deletion and teardown wait for absence by stable Box ID,
since deletion admission renames a Box before destruction finishes. Cleanup retries
only the state-change conflict, bounds each Box removal to 30 seconds, and reports
other errors while continuing the remaining cleanup.

Checkpoint creates leave lifecycle options unset instead of receiving the harness
defaults again. The source receives the suite's 300-second `auto_stop` and
600-second `auto_delete` policy before capture; the restored Box must inherit both,
which the case verifies through the API-backed SDK metadata.

Run against an API/runner built from this branch with checkpoint storage enabled:

```bash
make test:e2e E2E_ARGS=cases/test_checkpoints.py
```

Use the existing environment/profile authentication described below. The case
requires `capabilities.checkpoints_enabled=true`; absence fails before creating
a Box. It uses unique `e2e-` resource names, retains the suite's bounded Box
lifetimes, and reports cleanup failures. It is outside the production smoke
selection because it uses checkpoint storage and multiple guest lifecycles. Loopback, mock-storage and
native stub checks do not satisfy this real VM/storage acceptance case.

### Existing coverage

Product acceptance cases use the REST-mode runtime built by `conftest.py::rt`.
`test_network_harness.py` separately checks probe failures and framing without
creating a box; those checks are not counted as product E2E evidence.

The Node tunnel driver waits for every created box's removal before closing its runtime.
A failed removal fails the case after the other removals settle; the runtime closes even when cleanup fails.

`cases/test_path_verification.py` is the meta-test: it spawns one box, runs
one exec, and asserts that **both** `:3000` (API) and `:8080` (runner)
received the corresponding HTTP requests by tailing `/var/log/boxlite-api.log`
and `journalctl -u boxlite-runner`. If that meta-test passes, every other
case in this suite is using the same fixtures and the same path.

## Managed local E2E (preferred)

`make test:e2e:setup` starts the dependency services with Docker Compose and runs the current-source API/Runner/proxies as host processes; fixtures and a real guest smoke follow. State lives in `target/e2e/`; no sudo or system services are used.

Initialize submodules once (`git submodule update --init --recursive`, or `make setup`), then:

```bash
nix develop -c make test:e2e:doctor
nix develop -c make test:e2e:setup
make test:e2e FILTER=exec_working_dir
make test:e2e:down
```

`make test:e2e:down` also terminates `bwrap`/`boxlite-shim` processes left in this checkout's runtime home by an interrupted run, removes their box directories, and fails if any process survives. The jailer starts every shim with `setsid()`, so signalling the runner's process group never reaches them.

The fixed host ports support one managed stack at a time on a host, including across users; coordinate shared hosts and run stacks sequentially. `status` takes the lifecycle lock without reserving an unused stack. Lifecycle commands share a user-wide lock and persist the owning checkout and state directory until a successful `down`. Another checkout or `E2E_STATE_DIR` fails before changing resources; stop the owner using its original checkout and state directory first. Compose projects and runtime homes include the user, checkout and state identity and cannot be overridden by inherited Compose settings. Switching state after teardown therefore does not reuse volumes encrypted with another state's keys. PID records are published atomically.

Runtime roots and the coordination directory are opened without following symlinks,
checked for the current user's ownership, and made private. Foreign-owned or
group/other-writable runtime parents are refused rather than repaired. Safe owned
0755 parents from older launchers are tightened to 0700. Inside that private root,
owned Runner-created box directories are tightened to 0700, including directories
from earlier runs with umask 002; foreign owners and symlinks remain rejected.
Host services inherit umask 077. Teardown also verifies
the `boxes` directory and its children before recursively removing anything.

Before replacing the Runner, startup reaps owned box process trees only when
their `shim.pid` cannot identify a live process. PID/start-time verification and
legacy PID handling follow runtime recovery; recoverable guests are preserved.
This does not replace the runtime's database reconciliation or VM adoption.

`E2E_PYTHON` accepts absolute paths, bare interpreter names found on `PATH`, or paths relative to the repository root. An existing interpreter must belong to a virtual environment; a bare system `python3` is not accepted. The same resolved interpreter is used for dependency sync, SDK installation, fixtures and pytest, including recursive Make invocations. A command-line `E2E_STATE_DIR` overrides an inherited `BOXLITE_E2E_STATE_DIR`; relative state paths are anchored at the repository root.

An existing virtual environment created with `--without-pip` is supported:
dependency setup bootstraps pip through that interpreter's bundled `ensurepip`
before installing the pinned uv version. To select another Python version, create
its virtual environment first and point `E2E_PYTHON` at its existing interpreter;
unsupported executable names are rejected before creating a new environment.

The source-run API reads the repository's `openapi/` through `BOXLITE_OPENAPI_DIR`; packaged deployments retain the bundled-assets default. This avoids requiring generated copies beneath `apps/api/src/assets` for local startup.

Host API, Runner and proxy listeners bind to loopback through `BOXLITE_LISTEN_HOST=127.0.0.1`. Other deployments retain their existing all-interface default when this variable is unset. Credentials and encryption keys are generated once in `target/e2e/credentials.json` (mode 0600); preserve this file with the stack's data. Initial `POSTGRES_PASSWORD` and `MINIO_PASSWORD` overrides are persisted and later environment changes do not rotate existing credentials. Generated Compose `.env` files contain no passwords.

`setup`, `up` and `test:e2e` reuse an unchanged healthy stack. The launcher hashes tracked and non-ignored untracked working-tree inputs, including submodule sources, and the launch environment/interpreter. Test directories and Markdown documentation are excluded; changing pytest cases, `FILTER` or `E2E_ARGS` therefore does not reinstall dependencies or restart services. Product or configuration changes conservatively rebuild components and restart all host services. Dependency manifests have a separate fingerprint, so source-only changes skip dependency installation when the Python environment and package directories still exist.

Reuse also requires the expected build artifacts, matching host PID/start-time records, responsive dependency and HTTP health checks, and a ready registered Runner. Missing records, artifacts or unhealthy services trigger preparation. Successful startup and fixture setup publish the reuse record; a failed preparation invalidates it. Delete `target/e2e/stack-inputs.json` to force preparation, or also delete `dependencies-inputs.json` to force dependency sync after manually altering installed packages. This cache assumes installed packages and generated artifacts have not been manually replaced; it does not fingerprint toolchain installations or external data.

The Runner build fingerprints `target/debug/libboxlite.a` and forces Go recompilation when its content changes, because Go's cache does not track external CGO archives. A failed build never advances that fingerprint.

This invalidation follows [Go's documented external C-library cache limitation](https://pkg.go.dev/cmd/go#hdr-Build_and_test_caching). Compose isolation follows its [project-name boundary](https://docs.docker.com/compose/how-tos/project-name/); a separate user-wide owner reservation is still needed because project names do not isolate host ports.

Startup failure or interruption stops newly started host services and box processes, preserves pre-existing guest process identities, removes newly created dependency containers, and preserves existing dependency containers, volumes and logs. Build failures occur before stopping existing services. A restart intentionally replaces the old host processes; failed replacements are stopped rather than left half-running. Failed startup retains ownership so recovery or teardown uses the same checkout/state.

Each dependency-readiness subprocess shares its check's remaining deadline, so
a connected but unresponsive Redis or PostgreSQL cannot block startup forever.
`status` fails if any required API/Runner/proxy PID record is missing or stale,
including before startup and after teardown.

Explicit paths supplied through `E2E_ARGS` suppress default whole-suite selection,
just like paths passed directly to `run.sh`:

```bash
make test:e2e E2E_ARGS='cases/test_lifecycle.py -x'
```

Stacks created before checkout-specific Compose projects used the shared `boxlite-e2e` project and fixed encryption keys. Stop those stacks with the old launcher before upgrading. Their volumes are not adopted or deleted automatically; keep their original state and keys if data must be migrated. The new launcher creates a separate project and must not be used to clean up an old project's resources.

Compose uses the configured Docker connection; Podman users must explicitly set
`DOCKER_HOST=unix:///path/to/podman.sock`. Only one engine is needed: a `docker`
command supplied by Podman does not imply a Docker daemon at `/var/run/docker.sock`.
For rootless Podman, use `DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock`
with its API socket running. The launcher saves Docker connection environment
variables in `target/e2e/compose-engine.json` after the first successful Compose
command and reuses them for all lifecycle commands. Failed initial connections
leave no selection, so correcting `DOCKER_HOST` and retrying works. Keep the
selected Docker context unchanged until teardown;
a newly available Podman socket never changes the selected engine automatically.

The launcher script tests keep real `/proc` process checks Linux-only and mock process discovery in platform-independent lifecycle tests. Runtime process tests resolve `sleep` through `PATH`, preserving its executable name for multicall coreutils on NixOS; neither `/bin/sleep` nor a renamed sleep applet is required.

Nix is optional: install the same tools with the distro and run the same commands. Host prerequisites remain Docker with Compose v2, `/dev/kvm`, and (for volumes) `/dev/fuse`, `mount-s3` and `user_allow_other` in `/etc/fuse.conf`. The devshell includes `docker-compose`; Ubuntu can use `docker-compose-v2`. The bootstrap instructions below are the legacy Ubuntu system-service path and are no longer used by `make test:e2e:setup`.

## Prereqs

`BOXLITE_E2E_CATALOG_IMAGE` accepts tagged, digest-pinned, and untagged
references, including registry ports such as `registry.local:5000/acme/app`.
The catalog tests retain the port when deriving the repository name and the
deliberately unpullable test image.

Set up via the bootstrap script (one-time per machine):

```bash
apps/e2e/bootstrap.sh
```

This installs / starts:

- Postgres + Redis (apt)
- Node.js 22 + yarn (corepack)
- Docker registry on `:5000`
- Rust toolchain (rustup) + Go toolchain (release tarball)
- `boxlite-runner.service` on `:8080` — **built from the working tree**, not from a release pin. The runner CGOs into `libboxlite.a` so any change under `sdks/c/`, `src/boxlite/`, or `apps/runner/` shows up after the next `make test:e2e:setup`. Release-pinned binaries would test stale code instead of the PR.
- `boxlite-api.service` on `:3000` (ts-node, reads `/etc/boxlite-api.env`)

First run is slow (~5–10 min, mostly the Rust release build). Subsequent runs are incremental.

Tear down with `apps/e2e/teardown.sh` (basic), `--wipe-data`
(also drops the DB and `/var/lib/boxlite`), or `--full` (also drops
the persistent secrets file so the next bootstrap mints fresh keys).
Postgres + Redis + Node are kept around — they're cheap to leave and
likely shared with other things on the host.

Bootstrap stores the random `ADMIN_API_KEY`, `ENCRYPTION_KEY`, and
runner / proxy tokens in `/etc/boxlite-secrets.env`
(mode 600, owned by the bootstrap user). It's read back on every
re-run, so the API env file can be regenerated whenever a PR adds a
new variable without losing access to data encrypted under the old
keys. If you ever need to rotate, run `teardown.sh --full`.

Then run the fixture setup (idempotent — re-running is safe):

```bash
python3 apps/e2e/fixture_setup.py
```

This:

- Registers `alpine:3.23` snapshot via the API admin endpoint
- Waits for the snapshot to reach `active` state (runner pulls + pushes to local registry)
- Sets reasonable per-box quotas on the admin org
- Adds a `[profiles.p1]` entry in `~/.boxlite/credentials.toml` pointing at the local API

## Running against a remote API (dev / staging)

No bootstrap or fixture_setup needed — just set environment variables:

```bash
# Required:
export BOXLITE_E2E_API_URL=https://api.dev.boxlite.ai
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
url = "https://api.dev.boxlite.ai"
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

## Subdomain acceptance

`cases/test_subdomain.py` exercises Python async/sync, Node, Go, C, Rust and
the CLI through the deployed API and proxy. It checks full-hostname bind/list/
unbind, full-hostname rebind to a second guest port, rejected short names and
port-suffixed hostnames, retained quota, HTTPS guest responses, and independent tunnel access.
Python unbind success is the empty tuple `()` in both APIs; failures raise.
A separate case verifies that binding does not publish a port: the domain
needs a public tunnel and becomes unavailable after revocation or private prepare.

Set `BOXLITE_E2E_DOMAIN` in GitHub **Settings → Secrets and variables → Actions → Variables**
as a repository variable containing the dedicated full hostname for dev.
The workflow reads it for the **p1 main suite** (`BOXLITE_DEV_API_KEY`);
the p2 identity step does not bind it. There is no hostname default in code.
Missing configuration fails cloud dev setup; local runs without it skip these
cases. They are not marked `smoke` and do not run on prod.

For a local run, build the SDKs/CLI from the checkout, then the native drivers:

```bash
BOXLITE_DEPS_STUB=1 make build:e2e:drivers SETUP_DONE=1
export BOXLITE_E2E_DOMAIN="$(gh variable get BOXLITE_E2E_DOMAIN --repo boxlite-ai/boxlite)"
BOXLITE_E2E_PROFILE=p1 BOXLITE_E2E_SKIP_PATH_VERIFY=1 \
make test:rest:e2e AUTH=api-key FILTER=subdomain
```

The Python environment needs `greenlet` for the sync SDK. `BOXLITE_E2E_CLI`
selects a CLI binary; otherwise the tests use `boxlite` on PATH, then
`target/debug/boxlite`. C/Go/Rust drivers are built by the command above.
The Rust driver is the non-published `boxlite-e2e-rust` workspace package in
`sdks/rust/`; its executable is `target/debug/domain-rust` at the repository root.
`make test:e2e:drivers` checks the driver's argument handling without a cloud or VM;
malformed invocations print usage and exit with an error.
Configured cases fail if a required client is missing. Public HTTPS probes
honor standard proxy environment variables, verify certificates, and reject redirects.

All cases reuse this one hostname and run serially. A hostname-specific file
lock prevents overlapping local processes; CI retains its stage concurrency
group. Do not run the same hostname simultaneously from different machines or
with pytest-xdist. The API key determines the organization: a local environment
override can select a different organization even when the profile is named p1.
Check that organization's held domains before choosing a local override.

Request the short test name in Dashboard > Domains first, then configure its
full hostname. Setup refuses an unowned hostname or one already bound to a target. It never deletes a reservation or changes quota. Teardown
unbinds only the case's own Box and removes that Box, retaining the hostname and
its slot. A killed process can skip teardown: automatic Box deletion does not
clear its domain binding. Inspect `boxlite domain ls` under the same profile;
after confirming that the target is from the interrupted test, recover with
`boxlite domain unbind "$BOXLITE_E2E_DOMAIN"` before rerunning. A binding that
moves to another target during the test is left intact and reported as a failure.

## The cloud legs (CI)

`.github/workflows/e2e-cloud.yml` runs this suite against a deployed
stage. It is dispatch-only, plus one call from `deploy-infra.yml`:

| Stage | Target | Selection | Sweep |
| --- | --- | --- | --- |
| `dev` | `api.dev.boxlite.ai` | everything | yes |
| `prod` | `api.boxlite.ai` | `-m smoke` | no |

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
  stopped-box scenario. The older Node and CLI cases remove their box in a
  `finally`, so this bites when a run is killed mid-driver; the old Go and C
  drivers exit past their own cleanup, and both legs `--ignore` those cases.
  Subdomain clients in every language share the bounded Python service-box
  fixture, which also removes the Box if a client operation fails.
  Clearing anything left behind means `--any-name`, by a human who has read
  the report first — which is why CI never passes it.

## Running against local stack

```bash
# Everything (after bootstrap + fixture_setup):
apps/e2e/run.sh

# Or via pytest directly:
pytest apps/e2e/cases/

# Just one case:
pytest apps/e2e/cases/test_p0_6_exec_stdout_race.py -v

# Two-sided (proves the suite detects the bug and the PR fixes it):
PR_REF=<branch>  apps/e2e/two_sided.sh
```

The reusable REST auth matrix entry is:

```bash
make test:rest:e2e AUTH=api-key
make test:rest:e2e AUTH=oidc
```

`AUTH=api-key` reads `BOXLITE_E2E_API_KEY` or profile `api_key`.
`AUTH=oidc` reads `BOXLITE_E2E_OIDC_TOKEN` or profile `access_token`.
Both modes call `/v1/me` to refresh the route `path_prefix`; set
`BOXLITE_E2E_PREFIX` only when you need to override that discovery.

The C, Go, and Node SDK entry-point cases currently skip under `AUTH=oidc`
because those SDK smoke drivers still expose only API-key credential types.
The Python SDK REST path does run under both auth modes because its
`ApiKeyCredential` is the generic bearer-token slot on the wire.

## Layout

```
apps/e2e/
├── README.md
├── bootstrap.sh             # Install services (local stack only)
├── fixture_setup.py         # Register snapshots / quota / profile (local stack only)
├── run.sh                   # bootstrap + fixture_setup + pytest
├── sweep.py                 # Reclaim boxes earlier runs stranded (cloud)
├── two_sided.sh             # Validates that test catches bug + PR fixes it
├── pytest.ini
├── lib/
│   ├── catalog_boxes.py     # Boxes against the catalog: pull budget, report window
│   ├── e2e_auth.py          # Auth context: API-key / OIDC, env vars / profile
│   ├── images.py            # Curated ref derived from apps/box-images/VERSION
│   └── path_verification.py # Helpers that prove SDK→API→Runner was the route
├── sdks/
│   ├── node/                # TypeScript drivers (fallback: scripts/test/image.js)
│   ├── go/                  # Go drivers + e2e_image.go fallback for direct runs
│   ├── c/                   # C drivers + e2e_image.h fallback for direct runs
│   └── rust/                # Rust acceptance drivers (private Cargo package)
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

1. Drop a `test_*.py` into `cases/`
2. Take fixtures from `conftest.py` — at minimum `rt` (already REST-bound)
3. Reference the issue / PR in the docstring so it survives the regression
4. Run `pytest cases/test_yours.py -v` locally first

## Fractional CPU acceptance

`make test:e2e E2E_ARGS=cases/fractional_cpus_acceptance.py` exercises SDK → Cloud API → Runner → VM creation and restart with `0.125`, `0.5`, and `1.5` CPUs.
It reads the managed local Runner's SQLite metadata and the running process's cgroup to verify the actual `cpu.max`, as well as guest CPU topology and API query values.
The suite also calls the Runner v0 create/recover endpoints and verifies that rejected CPU values leave the running VM intact.
Run this file explicitly against the managed local stack; remote-stage suites do not collect it by default.
These tests require `BOXLITE_HOME_DIR` and the managed Runner URL/token; a missing or unreadable cgroup fails acceptance rather than silently skipping enforcement.
Use `make test:fractional-cpus:acceptance` for local Runtime quota/lifecycle tests and `BOXLITE_REST_PATH_PREFIX= make test:integration:cli FILTER=fractional_cpus` for the real serve HTTP path and server restart.
The membership policy remains best-effort in the product; the acceptance environment must successfully join the Box cgroup.

## Stage cloud acceptance

Run the existing `e2e-cloud` workflow with `stage=stage`. The API defaults to
`https://api.stage.boxlite.ai`; the optional `BOXLITE_STAGE_API_URL` variable or
`api_url` dispatch input overrides it, with the same precedence as dev. Provide independent
`BOXLITE_STAGE_API_KEY`, `BOXLITE_STAGE_P2_API_KEY`, and
`BOXLITE_STAGE_P2_READONLY_API_KEY` secrets. The p1 and p2 keys must belong to
different organizations; p2_readonly must share p2's organization and have only
read permissions. Missing stage settings never fall back to dev credentials.

The existing profile helper checks HTTPS, organization membership and key permissions
before writing the test profiles. Stage runs the main suite and identity lane, without dev's automatic sweep or
shared-subdomain fixture. Production still runs the single-profile smoke suite.
