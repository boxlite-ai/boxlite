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

`cases/test_path_verification.py` is the meta-test: it spawns one box, runs
one exec, and asserts that **both** `:3000` (API) and `:8080` (runner)
received the corresponding HTTP requests by tailing `/var/log/boxlite-api.log`
and `journalctl -u boxlite-runner`. If that meta-test passes, every other
case in this suite is using the same fixtures and the same path.

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

1. Drop a `test_*.py` into `cases/`
2. Take fixtures from `conftest.py` — at minimum `rt` (already REST-bound)
3. Reference the issue / PR in the docstring so it survives the regression
4. Run `pytest cases/test_yours.py -v` locally first
