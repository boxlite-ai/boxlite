# `apps/infra-local/` Phase 2 — Walking-Skeleton Orchestrator Design

> **Status:** approved (2026-05-20) — ready for writing-plans
> **Owner:** lile (michael.li@polygala.ai)
> **Parent design:** [`docs/apps/own-dog-food-local-infra-solution.md`](../../apps/own-dog-food-local-infra-solution.md) §12.2
> **Inputs (PoC validation, 2026-05-20):**
> - `apps/infra-local/poc/single_service.py` — Phase 0, 7 phases ✅
> - `apps/infra-local/poc/multi_service.py` — Phase 1, 12 phases ✅ (after env conflicts resolved)
> - `apps/infra-local/poc/diagnose_network.py` — env-conflict diagnostic harness

---

## 1. Background

The dogfood architecture has been validated through Phase 0 + Phase 1 PoCs. The parent design doc lays out the full target shape (10-service orchestrator + `doctor` + Lima runner integration). This spec narrows that down to a **walking skeleton** — the smallest end-to-end implementation that exercises every architectural layer with one real service (postgres), so we can iterate on abstractions before scaling out to the other 9 services.

**Operating principle for tests:** drive real BoxLite, not mocks. Walking skeleton ships with one real integration test gated behind `BOXLITE_INTEGRATION=1`, plus pure unit tests for logic that has no I/O.

---

## 2. Scope

**In scope (this spec):**
- A new Python package `boxlite_local` under `apps/infra-local/`, runnable as `python -m boxlite_local`.
- Subcommands: `up`, `down`, `ps`, `doctor` (plus `--help`).
- **One service wired**: postgres, on host port 25432 → guest 5432.
- `doctor` preflight with 4 checks (see §6).
- Unit tests + one integration smoke test.

**Explicitly out of scope (later phases):**
- Other 9 services (redis, dex, minio, registry, caddy, otel, jaeger, pgadmin, registry-ui)
- `logs` subcommand (gated on `box.logs()` SDK surface)
- `--recreate` flag (for forcing config-changed boxes to rebuild)
- Caddy + TLS + mkcert wiring (Phase 3)
- Performance benchmarks
- Memory budget checks
- Makefile wrapper

**Decisions taken during brainstorming (locked):**

| Decision | Choice | Why |
|---|---|---|
| First deliverable shape | Walking skeleton (postgres only) | Forces every layer to be wired before scaling; small surface to debug |
| Test strategy | Integration tests on real BoxLite + unit tests for pure logic | "Mocks lie" trap (same class as PoC env-conflict misdiagnoses) |
| Package shape | Flat module layout + explicit `SERVICES` dict | Autodiscovery is YAGNI with one service; one new line per future service is acceptable |
| `doctor` strictness | Hard-fail (raises `DoctorError` before any runtime call); `--skip-doctor` escape hatch | Per parent design §3.8 |

---

## 3. Package layout

```
apps/infra-local/
├── pyproject.toml                # PEP 621 — name=boxlite_local, dep on boxlite SDK
├── boxlite_local/
│   ├── __init__.py
│   ├── __main__.py               # 3-liner: from .cli import main; sys.exit(asyncio.run(main()))
│   ├── cli.py                    # argparse subcommands → dispatch to orchestrator/doctor
│   ├── types.py                  # ServiceSpec, HealthCheck, DoctorCheck, exceptions
│   ├── config.py                 # InfraConfig dataclass + .load()
│   ├── doctor.py                 # doctor(), check_port(), check_docker_desktop()
│   ├── orchestrator.py           # up(), down(), ps(), topo_sort(), start_service(), wait_healthy()
│   ├── execwrap.py               # exec_collect(box, cmd, args, env) → (rc, out, err)
│   └── services.py               # SERVICES: dict[str, ServiceSpec] = {"postgres": SPEC_PG}
└── tests/
    ├── unit/
    │   ├── __init__.py
    │   ├── test_topo.py
    │   ├── test_doctor_lsof.py
    │   └── test_config.py
    └── integration/
        ├── __init__.py
        └── test_skeleton.py      # gated on BOXLITE_INTEGRATION=1
```

**Conventions:**
- Public API of the package is `boxlite_local.orchestrator.up/down/ps` (async functions). `cli.py` is thin.
- No `Orchestrator` class. Plain async functions taking `(config, services, ...)`. Easier to test and reason about with one service.
- `execwrap.exec_collect` is the single home for the streaming-`Execution` dance. The PoC scripts keep their own copies — they're validation harnesses, not library consumers.

---

## 4. Data flow

### `up(config, services, only=None, skip_doctor=False)`

```
1. if not skip_doctor: await doctor(config, services, strict=True)
                                                # raises DoctorError on any FAIL
2. layers = topo_sort(services)                 # list[list[name]]; pure func
3. runtime = Boxlite.default()
4. for layer in layers:
       await asyncio.gather(*[
           start_service(runtime, services[name], config)
           for name in layer if only is None or name in only
       ])

start_service(runtime, spec, config):
    opts = build_box_options(spec, config)      # pure transform; cfg.host_hub injected into env
    box, created = await runtime.get_or_create(opts, name=f"boxlite-local-{spec.name}")
    if created or not running: await box.start()
    if spec.healthcheck:
        await wait_healthy(box, spec.healthcheck)
```

### `down(config, services, only=None, wipe=False)`

Reverse topological order. `stop_service` is idempotent — silently skips missing boxes. If `wipe`: `shutil.rmtree(config.data_dir, ignore_errors=True)` after all stops succeed.

### `ps(config)`

Read-only. `runtime.list_info()` → filter `name.startswith("boxlite-local-")` → print one row each (`name  status  image`).

### `doctor(config, services, strict=True)`

Pure I/O scan, returns `DoctorReport(checks=[DoctorCheck(severity, msg, hint)])`. If `strict` and any check is FAIL, raises `DoctorError(report)`. As a CLI subcommand, always non-strict; prints the full report and exits non-zero on any FAIL.

---

## 5. Module ownership

| Module | Owns | Has I/O? | Touches BoxLite SDK? |
|---|---|---|---|
| `types.py` | `ServiceSpec`, `HealthCheck`, `DoctorCheck`, `DoctorReport`, `DoctorError`, `Severity` enum | no | no |
| `config.py` | `InfraConfig` dataclass + `InfraConfig.load()` | reads env vars, expands `~/.boxlite-local/*` paths | no |
| `services.py` | `SERVICES: dict[str, ServiceSpec]` (just `"postgres"` for now) | no | no |
| `execwrap.py` | `exec_collect(box, cmd, args=None, env=None) -> (int, str, str)` | yes (drains box exec streams) | yes |
| `doctor.py` | `doctor()`, `check_sdk_importable()`, `check_runtime_reachable()`, `check_port_free()`, `check_docker_desktop()` | yes (`lsof`, `pgrep`, transient `Boxlite.default()`) | yes (runtime probe only) |
| `orchestrator.py` | `up`, `down`, `ps`, `topo_sort`, `start_service`, `stop_service`, `wait_healthy`, `build_box_options` | yes (runtime calls) | yes |
| `cli.py` | `main()`, argparse subcommands, exit-code mapping | yes (stdout/stderr) | no |
| `__main__.py` | 3 lines — imports `main`, runs it | yes | no |

Single import direction: `cli → orchestrator → {doctor, execwrap, services, config, types}`. `doctor` and `execwrap` don't know about each other.

---

## 6. `doctor` checks

| # | Check | Severity | What it does | Fail message template |
|---|---|---|---|---|
| 1 | **BoxLite SDK importable** | FAIL | `try: from boxlite import Boxlite` (with fallback `from boxlite.boxlite import ...` per SDK gotcha E) | "BoxLite Python SDK not importable. Run `pip install -e sdks/python` from the boxlite repo, and confirm `which python` points at the right interpreter." |
| 2 | **BoxLite runtime reachable** | FAIL | Construct `Boxlite.default()`, call `await runtime.list_info()` | "BoxLite runtime not responding. Check `boxlite serve` / lockfile state." |
| 3 | **Port conflict per service** | FAIL | For each `(host_port, _)` in `services[*].ports`: shell out to `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcLn`; parse the `-F` machine-readable output for `(pid, cmd, user)`; if any row's `cmd` does not start with `boxlite` (case-sensitive prefix; covers `boxlite-serve`, `boxlite-s` truncation, etc.), fail | "Port {port} held by `{cmd}` (PID {pid}, user {user}). Change the host port in `InfraConfig` or stop the local service." |

**Aggregation rules:**
- `up` calls `doctor(strict=True)` — any FAIL raises `DoctorError`, abort before any runtime mutation. (`Severity.WARN` is reserved for future use; no checks emit it in the walking skeleton.)
- `doctor` as a CLI subcommand prints the full report with ✓/✗ markers. Exit 0 iff no FAIL.
- `up --skip-doctor` bypasses all checks, prints a prominent banner that doctor was skipped.

**Port discovery is registry-driven.** Check #3 enumerates ports from the in-memory `SERVICES` registry, not a hardcoded list. Adding a service automatically extends the preflight.

---

## 7. Postgres service spec (the one wired service)

```python
# services.py
from boxlite_local.types import HealthCheck, ServiceSpec

SPEC_PG = ServiceSpec(
    name="postgres",
    image="postgres:16-alpine",
    cpus=1,
    memory_mib=512,
    ports=[(25432, 5432)],                      # non-default host port — §3.8 of parent doc
    env=lambda cfg: {
        "POSTGRES_USER": cfg.pg_user,           # default "boxlite"
        "POSTGRES_PASSWORD": cfg.pg_password,   # still required by image entrypoint
        "POSTGRES_DB": cfg.pg_db,               # default "boxlite"
        "POSTGRES_HOST_AUTH_METHOD": "trust",   # local dev only
        "PGDATA": "/var/lib/postgresql/data/pgdata",
    },
    volumes=lambda cfg: [
        (str(cfg.data_dir / "pg"), "/var/lib/postgresql/data"),
    ],
    depends_on=[],
    healthcheck=HealthCheck(
        exec=["pg_isready", "-U", "boxlite", "-d", "boxlite", "-t", "1"],
        interval_s=2,
        retries=30,
    ),
)

SERVICES = {"postgres": SPEC_PG}
```

---

## 8. `InfraConfig` shape

```python
# config.py
from dataclasses import dataclass, field
from pathlib import Path
import os

@dataclass
class InfraConfig:
    # host-hub address — box-side reaches host via this name (Docker host.docker.internal equivalent)
    host_hub: str = "host.boxlite.internal"

    # postgres
    pg_host_port: int = 25432
    pg_user: str = "boxlite"
    pg_password: str = "boxlite"
    pg_db: str = "boxlite"

    # persistent data root
    data_dir: Path = field(default_factory=lambda: Path.home() / ".boxlite-local" / "data")

    @classmethod
    def load(cls) -> "InfraConfig":
        return cls(
            host_hub=os.environ.get("BOXLITE_HOST_HUB", "host.boxlite.internal"),
            pg_host_port=int(os.environ.get("BOXLITE_PG_HOST_PORT", "25432")),
            pg_user=os.environ.get("BOXLITE_PG_USER", "boxlite"),
            pg_password=os.environ.get("BOXLITE_PG_PASSWORD", "boxlite"),
            pg_db=os.environ.get("BOXLITE_PG_DB", "boxlite"),
            data_dir=Path(os.environ.get("BOXLITE_DATA_DIR", str(Path.home() / ".boxlite-local" / "data"))),
        )

    @property
    def pg_url(self) -> str:
        return f"postgresql://{self.pg_user}@{self.host_hub}:{self.pg_host_port}/{self.pg_db}"
```

---

## 9. Risks and known constraints

**`get_or_create` reuse path ignores new `BoxOptions`** (parent doc §1.7.D). For the walking skeleton: if an existing box's config differs from the requested spec, `up` proceeds with the existing box and prints a warning. No silent recreation, no silent drift. A `--recreate` flag is deferred.

**`lsof` is macOS-specific in our context.** Walking skeleton targets Mac M5. Cross-platform (Linux runner) is not in scope. Document this assumption in `doctor.py` doctring.

**`pg_isready` healthcheck depends on the image having the binary** — postgres:16-alpine does. Verified in PoC Phase 0/1.

**No `--recreate` means**: if a developer edits a service spec (e.g., bumps `memory_mib`), they need to manually `down --wipe` first. Acceptable for skeleton; revisit when adding redis/dex etc.

---

## 10. Acceptance criteria

**Automated:**
- `pytest apps/infra-local/tests/unit -q` → all green
- `BOXLITE_INTEGRATION=1 pytest apps/infra-local/tests/integration -q` → one smoke test passes:
  - happy path: `doctor(strict=True)` returns clean → `up()` → assert `runtime.list_info()` shows `boxlite-local-postgres` RUNNING → assert `pg_isready -U boxlite` inside the box exits 0 → `down(wipe=True)` → assert box gone and `data_dir` removed.

**Manual smoke (user runs):**

1. `python -m boxlite_local doctor` — happy path: 3 ✓ rows. Exit 0.
2. `python -m boxlite_local up` — pg box reaches `pg_isready` OK, returns to prompt with box left running.
3. `python -m boxlite_local ps` — shows `boxlite-local-postgres  running  postgres:16-alpine`.
4. **Detach proof**: in a *fresh* shell, `python -m boxlite_local ps` — still RUNNING.
5. **Doctor regression**: `nc -l 25432 &` then `python -m boxlite_local doctor` — exit non-zero, reports port 25432 held by `nc`; `python -m boxlite_local up` refuses to start. `kill %1` after.
6. `python -m boxlite_local down --wipe` — pg box gone, `~/.boxlite-local/data/` removed.
7. `python -m boxlite_local --help` and `python -m boxlite_local up --help` — readable.

---

## 11. Hand-off

After spec approval, this goes to the `writing-plans` skill to produce a step-by-step implementation plan. Implementation must follow project CLAUDE.md (TDD for behavior changes; integration tests reference real project symbols; no mocks for the BoxLite SDK surface).
