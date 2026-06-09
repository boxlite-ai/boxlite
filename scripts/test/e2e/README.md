# End-to-end test suite

These tests exercise the **full production path**:

```
SDK (Python / Go / Node / C / CLI) → HTTP → NestJS API → HTTP → boxlite-runner → libkrun VM
```

Existing `make test:integration:*` tests use the local PyO3 / FFI path
(`Boxlite.default()`) and bypass both the API and the runner — so a bug that
only surfaces on the REST → API → runner chain (e.g. #563's exec-stdout drop,
#627's attach re-drain) will pass those tests and reach production. This suite
exists to catch those.

## Layout

Cases live next to the SDK they exercise, so each SDK's tests stay with that
SDK's source. The shared stack-level infra (bootstrap, fixtures, helpers)
stays under `scripts/test/e2e/`.

```
scripts/test/e2e/                # stack-level infra only
├── README.md
├── bootstrap.sh                 # Install / build services from working tree
├── fixture_setup.py             # Register snapshots / quota / profiles (idempotent)
├── teardown.sh                  # Revert bootstrap state (3 modes)
├── run.sh                       # bootstrap + fixture_setup + pytest
├── two_sided.sh                 # Validates test catches bug + PR fixes it
├── pytest.ini                   # testpaths = all per-SDK e2e dirs
└── lib/
    └── path_verification.py     # Helpers that prove SDK→API→Runner was the route

sdks/python/tests/e2e/           # Python SDK e2e (pytest)
├── conftest.py                  # rt / image / box fixtures (REST-only)
├── test_path_verification.py    # Meta-test: prove the path
├── test_p0_6_exec_stdout_race.py
├── test_lifecycle.py
└── ... (one file per behavior class)

sdks/c/tests/e2e/                # C SDK e2e (pytest driver + C subprocess)
├── e2e_basic.c                  # Subprocess target compiled & invoked by the driver
└── test_c_entry.py              # pytest driver

sdks/go/tests/e2e/               # Go SDK e2e (pytest driver + Go subprocess)
├── e2e_basic.go
└── test_go_entry.py

sdks/node/tests/e2e/             # Node SDK e2e (pytest driver + tsx subprocess)
├── e2e_basic.ts
└── test_node_entry.py

src/cli/tests/e2e/               # CLI binary e2e (pytest driver)
└── test_cli_entry.py
```

## What the suite verifies

Every Python SDK case uses the REST-mode runtime built by
`sdks/python/tests/e2e/conftest.py::rt`. There is no path to local FFI from
that fixture — tests would fail at import if they tried.

`sdks/python/tests/e2e/test_path_verification.py` is the meta-test: it spawns
one box, runs one exec, and asserts that the runner journal
(`journalctl -u boxlite-runner`) saw the corresponding job. If that meta-test
passes, every other Python case is using the same fixtures and the same path.

Cross-SDK entry tests (test_{c,go,node}_entry.py, test_cli_entry.py) drive
each SDK's binding layer via subprocess and check the runner journal
themselves — the Python autouse fixture can't see across subprocess
boundaries.

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

- Registers `alpine:3.23` and `ubuntu:22.04` snapshots via the API admin endpoint
- Waits for snapshots to reach `active` state (runner pulls + pushes to local registry)
- Sets reasonable per-sandbox quotas on the admin org
- Writes `[profiles.p1]` AND `[profiles.default]` in `~/.boxlite/credentials.toml`
  (CLI uses `default` without a flag; Python conftest uses `p1`)

## Running

```bash
# Everything (after bootstrap + fixture_setup):
scripts/test/e2e/run.sh

# Or via pytest directly (uses scripts/test/e2e/pytest.ini's testpaths):
cd scripts/test/e2e && python3 -m pytest -v

# Just one case:
pytest sdks/python/tests/e2e/test_p0_6_exec_stdout_race.py -v

# Two-sided (proves the suite detects the bug and the PR fixes it):
PR_REF=<branch>  scripts/test/e2e/two_sided.sh
```

## Adding a case

1. Pick the SDK the case primarily exercises and drop a `test_*.py` into that SDK's `tests/e2e/` dir (or `src/cli/tests/e2e/` for CLI)
2. Take fixtures from the nearest `conftest.py` — at minimum `rt` (already REST-bound) for Python SDK tests
3. Reference the issue / PR in the docstring so it survives the regression
4. Run `pytest <your test file> -v` locally first
