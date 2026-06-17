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
scripts/test/e2e/bootstrap.sh
```

This installs / starts:

- Postgres + Redis (apt)
- Node.js 22 + yarn (corepack)
- Docker registry on `:5000`
- Rust toolchain (rustup) + Go toolchain (release tarball)
- `boxlite-runner.service` on `:8080` — **built from the working tree**, not from a release pin. The runner CGOs into `libboxlite.a` so any change under `sdks/c/`, `src/boxlite/`, or `apps/runner/` shows up after the next `make test:e2e:setup`. Release-pinned binaries would test stale code instead of the PR.
- `boxlite-api.service` on `:3000` (ts-node, reads `/etc/boxlite-api.env`)

First run is slow (~5–10 min, mostly the Rust release build). Subsequent runs are incremental.

Tear down with `scripts/test/e2e/teardown.sh` (basic), `--wipe-data`
(also drops the DB and `/var/lib/boxlite`), or `--full` (also drops
the persistent secrets file so the next bootstrap mints fresh keys).
Postgres + Redis + Node are kept around — they're cheap to leave and
likely shared with other things on the host.

Bootstrap stores the random `ADMIN_API_KEY`, `ENCRYPTION_KEY`, and
runner / proxy / SSH-gateway tokens in `/etc/boxlite-secrets.env`
(mode 600, owned by the bootstrap user). It's read back on every
re-run, so the API env file can be regenerated whenever a PR adds a
new variable without losing access to data encrypted under the old
keys. If you ever need to rotate, run `teardown.sh --full`.

Then run the fixture setup (idempotent — re-running is safe):

```bash
python3 scripts/test/e2e/fixture_setup.py
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

# Image must exist on the remote runner:
export BOXLITE_E2E_IMAGE=ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3

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
pytest scripts/test/e2e/cases/ -v --timeout=120
```

For CI, store `BOXLITE_E2E_API_KEY` as a repository secret and pass it
as an environment variable. No local bootstrap, Postgres, or runner
services are needed — the remote stack provides everything.

## Running against local stack

```bash
# Everything (after bootstrap + fixture_setup):
scripts/test/e2e/run.sh

# Or via pytest directly:
pytest scripts/test/e2e/cases/

# Just one case:
pytest scripts/test/e2e/cases/test_p0_6_exec_stdout_race.py -v

# Two-sided (proves the suite detects the bug and the PR fixes it):
PR_REF=<branch>  scripts/test/e2e/two_sided.sh
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
scripts/test/e2e/
├── README.md
├── bootstrap.sh             # Install services (local stack only)
├── fixture_setup.py         # Register snapshots / quota / profile (local stack only)
├── run.sh                   # bootstrap + fixture_setup + pytest
├── two_sided.sh             # Validates that test catches bug + PR fixes it
├── pytest.ini
├── lib/
│   ├── e2e_auth.py          # Auth context: API-key / OIDC, env vars / profile
│   └── path_verification.py # Helpers that prove SDK→API→Runner was the route
├── sdks/
│   ├── node/                # TypeScript drivers (e2e_basic.ts, e2e_exec.ts, e2e_copy.ts, e2e_errors.ts)
│   ├── go/                  # Go drivers (e2e_basic.go, e2e_exec_options.go, e2e_copy.go, e2e_errors.go)
│   └── c/                   # C drivers (e2e_basic.c, e2e_exec.c, e2e_errors.c)
└── cases/
    ├── conftest.py                  # rt / image / box fixtures (REST-only)
    ├── test_path_verification.py    # Meta-test: prove SDK→API→Runner path
    ├── test_lifecycle.py            # Box create / get_info / remove
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
