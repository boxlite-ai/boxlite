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
- Docker registry on `:5000`
- `boxlite-api.service` on `:3000` (ts-node, reads `/etc/boxlite-api.env`)
- `boxlite-runner.service` on `:8080`
- AWS CLI v2 (creds come from your existing `aws login` or env)

Then run the fixture setup (idempotent — re-running is safe):

```bash
python3 scripts/test/e2e/fixture_setup.py
```

This:

- Registers `alpine:3.23` snapshot via the API admin endpoint
- Waits for the snapshot to reach `active` state (runner pulls + pushes to local registry)
- Sets reasonable per-sandbox quotas on the admin org
- Adds a `[profiles.p1]` entry in `~/.boxlite/credentials.toml` pointing at the local API

## Running

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

## Layout

```
scripts/test/e2e/
├── README.md
├── bootstrap.sh             # Install services
├── fixture_setup.py         # Register snapshots / quota / profile (idempotent)
├── run.sh                   # bootstrap + fixture_setup + pytest
├── two_sided.sh             # Validates that test catches bug + PR fixes it
├── pytest.ini
├── lib/
│   └── path_verification.py # Helpers that prove SDK→API→Runner was the route
└── cases/
    ├── conftest.py          # rt / image / box fixtures (REST-only)
    ├── test_path_verification.py    # Meta-test: prove the path
    └── test_p0_6_exec_stdout_race.py
```

## Adding a case

1. Drop a `test_*.py` into `cases/`
2. Take fixtures from `conftest.py` — at minimum `rt` (already REST-bound)
3. Reference the issue / PR in the docstring so it survives the regression
4. Run `pytest cases/test_yours.py -v` locally first
