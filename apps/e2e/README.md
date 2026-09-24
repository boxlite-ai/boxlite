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

Every test in `cases/` uses the REST-mode runtime built by `conftest.py::rt`.
There is no path to local FFI from this directory — tests would fail import if
they tried.

`cases/test_path_verification.py` is the meta-test: it spawns one box, runs
one exec, and asserts that **both** `:3000` (API) and `:8080` (runner)
received the corresponding HTTP requests by tailing `/var/log/boxlite-api.log`
and `journalctl -u boxlite-runner`. If that meta-test passes, every other
case in this suite is using the same fixtures and the same path.

## Prereqs

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

# CLI tests need a profile pointing at the remote API:
export BOXLITE_E2E_PROFILE=p1
export BOXLITE_E2E_CLI=/path/to/boxlite   # CLI binary built with REST support
```

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

For CI, store `BOXLITE_E2E_API_KEY` as a repository secret and pass it
as an environment variable. No local bootstrap, Postgres, or runner
services are needed — the remote stack provides everything.

## The cloud legs (CI)

`.github/workflows/e2e-cloud.yml` runs this suite against a deployed
stage. It is dispatch-only, plus one call from `deploy-infra.yml`:

| Stage | Target | Selection | Sweep |
| --- | --- | --- | --- |
| `dev` | `api.dev.boxlite.ai/api` | everything | yes |
| `prod` | `api.boxlite.ai/api` | `-m smoke` | no |

Each stage authenticates with its own repo secret — `BOXLITE_DEV_API_KEY` and
`BOXLITE_PROD_API_KEY` — so a run only ever holds the key for the stage it
targets.

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

Tunnel and preview cases are `xfail(strict=True)`, not skipped, because no SDK
caller can create a public box today. #1370 made an unspecified inbound mode
mean private, and `CreateBoxNetworkSpec::from_options`
(`src/boxlite/src/rest/types.rs:327-333`) drops the `inbound` field whenever
its allow-list is empty — which is exactly what `mode="enabled"` looks like.
Raw REST with the nested shape returns preview 200 against the same stage, so
the server is not at fault. Telling "unset" from "enabled" needs an option
change in the Rust core and every SDK, hence the marks rather than a local
workaround. Strict means CI fails the day the SDK is fixed, which is when the
marks should come off. What strict cannot do is tell that cause from a later
break inside `tunnelable_box` itself — both read as "expected failure" — so a
green run on those cases proves only that they still fail, not why.

`test_cli_run_foreground_streams_command_output` carries the same mark for a
different reason, and unlike the tunnel cases it is conditional. `boxlite run
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

  What that leaves uncovered, deliberately: the polyglot drivers
  (`apps/e2e/sdks/`) and the CLI cases create boxes with neither the prefix
  nor a lifetime, so no sweep that CI runs can reclaim one. The ones the
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
    ├── test_c_entry.py              # C SDK smoke
    └── test_c_coverage.py           # C SDK exec, errors
```

## Adding a case

1. Drop a `test_*.py` into `cases/`
2. Take fixtures from `conftest.py` — at minimum `rt` (already REST-bound)
3. Reference the issue / PR in the docstring so it survives the regression
4. Run `pytest cases/test_yours.py -v` locally first
