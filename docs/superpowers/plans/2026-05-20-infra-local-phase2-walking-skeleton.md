# `apps/infra-local/` Phase 2 — Walking-Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `python -m boxlite_local up`-able walking skeleton (postgres-only) under `apps/infra-local/`, complete with `doctor` preflight, integration test, and end-to-end manual smoke.

**Architecture:** New Python package `boxlite_local` under `apps/infra-local/`. Flat module layout, single-direction imports, plain async functions (no `Orchestrator` class). One service wired (`SPEC_PG`) via explicit `SERVICES` dict. `doctor` runs before every `up` and hard-fails on port conflicts. Integration test drives real BoxLite, not mocks.

**Tech Stack:** Python 3.10+ asyncio, BoxLite Python SDK (`boxlite>=0.8`), pytest, argparse, stdlib `lsof` shell-out.

**Source spec:** [`docs/superpowers/specs/2026-05-20-infra-local-phase2-walking-skeleton.md`](../specs/2026-05-20-infra-local-phase2-walking-skeleton.md)

---

## File Structure

Files this plan creates, with responsibilities:

| File | Responsibility | Created in Task |
|---|---|---|
| `apps/infra-local/pyproject.toml` | PEP 621 metadata, declares `boxlite>=0.8` dep, pytest config | 1 |
| `apps/infra-local/boxlite_local/__init__.py` | Package marker, `__version__` | 1 |
| `apps/infra-local/boxlite_local/types.py` | `Severity`, `HealthCheck`, `ServiceSpec`, `DoctorCheck`, `DoctorReport`, `DoctorError` | 2 |
| `apps/infra-local/boxlite_local/config.py` | `InfraConfig` dataclass + `.load()` env override + `.pg_url` property | 3 |
| `apps/infra-local/boxlite_local/services.py` | `SPEC_PG` + `SERVICES` registry | 4 |
| `apps/infra-local/boxlite_local/execwrap.py` | `exec_collect(box, cmd, args, env) -> (rc, out, err)` | 5 |
| `apps/infra-local/boxlite_local/doctor.py` | `doctor()`, `check_sdk_importable()`, `check_runtime_reachable()`, `check_port_free()`, lsof parsing | 6 |
| `apps/infra-local/boxlite_local/orchestrator.py` | `topo_sort()`, `build_box_options()`, `up()`, `down()`, `ps()`, `start_service()`, `stop_service()`, `wait_healthy()` | 7 |
| `apps/infra-local/boxlite_local/cli.py` | argparse subcommands → orchestrator/doctor dispatch | 8 |
| `apps/infra-local/boxlite_local/__main__.py` | `python -m boxlite_local` entry point | 8 |
| `apps/infra-local/tests/__init__.py` | empty | 1 |
| `apps/infra-local/tests/unit/__init__.py` | empty | 1 |
| `apps/infra-local/tests/integration/__init__.py` | empty | 1 |
| `apps/infra-local/tests/unit/test_config.py` | `InfraConfig` defaults + env override | 3 |
| `apps/infra-local/tests/unit/test_doctor_lsof.py` | lsof `-F` parsing for `check_port_free` | 6 |
| `apps/infra-local/tests/unit/test_topo.py` | `topo_sort` layering | 7 |
| `apps/infra-local/tests/integration/test_skeleton.py` | end-to-end `doctor → up → ps → down` against real BoxLite, gated on `BOXLITE_INTEGRATION=1` | 9 |

**Import direction (no cycles):** `cli → orchestrator → {doctor, execwrap, services, config, types}`. `doctor` and `execwrap` do not import each other.

---

## Task 1: Package skeleton + pyproject.toml + pytest wiring

**Files:**
- Create: `apps/infra-local/pyproject.toml`
- Create: `apps/infra-local/boxlite_local/__init__.py`
- Create: `apps/infra-local/tests/__init__.py`
- Create: `apps/infra-local/tests/unit/__init__.py`
- Create: `apps/infra-local/tests/integration/__init__.py`

- [ ] **Step 1.1: Write `pyproject.toml`**

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "boxlite_local"
version = "0.1.0"
description = "BoxLite-based infra-local orchestrator (dogfood)"
requires-python = ">=3.10"
dependencies = ["boxlite>=0.8"]

[project.optional-dependencies]
test = ["pytest>=7"]

[tool.setuptools.packages.find]
include = ["boxlite_local*"]
exclude = ["tests*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 1.2: Write `boxlite_local/__init__.py`**

```python
"""BoxLite-based infra-local orchestrator (Phase 2 walking skeleton)."""

__version__ = "0.1.0"
```

- [ ] **Step 1.3: Create empty test `__init__.py` files**

```bash
: > apps/infra-local/tests/__init__.py
: > apps/infra-local/tests/unit/__init__.py
: > apps/infra-local/tests/integration/__init__.py
```

- [ ] **Step 1.4: Install the package + dev deps**

Run from repo root:
```bash
pip install -e "apps/infra-local[test]"
```
Expected: install succeeds; `boxlite_local` and `pytest` both available.

- [ ] **Step 1.5: Verify pytest discovers the empty tree**

Run:
```bash
pytest apps/infra-local/tests -q
```
Expected: exit code 5 (`no tests ran`).

- [ ] **Step 1.6: Commit**

```bash
git add apps/infra-local/pyproject.toml apps/infra-local/boxlite_local/__init__.py apps/infra-local/tests/
git commit -m "feat(infra-local): scaffold boxlite_local package + pytest wiring"
```

---

## Task 2: `types.py` — data structures

No unit tests: these are pure dataclasses with no logic. They're exercised by every module that follows.

**Files:**
- Create: `apps/infra-local/boxlite_local/types.py`

- [ ] **Step 2.1: Write `types.py`**

```python
"""Shared data structures for the orchestrator. Pure data, no I/O."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .config import InfraConfig


class Severity(str, Enum):
    OK = "ok"
    FAIL = "fail"
    WARN = "warn"  # reserved for future use


@dataclass
class HealthCheck:
    """Box health probe. One of `exec`, `tcp_port`, `http_url` should be set."""
    exec: Optional[list[str]] = None
    tcp_port: Optional[int] = None
    http_url: Optional[str] = None
    interval_s: float = 2.0
    timeout_s: float = 5.0
    retries: int = 30
    start_period_s: float = 0.0


@dataclass
class ServiceSpec:
    """Declarative definition of one BoxLite-backed service."""
    name: str
    image: str
    cpus: int = 1
    memory_mib: int = 256
    ports: list[tuple[int, int]] = field(default_factory=list)
    env: Callable[["InfraConfig"], dict[str, str]] = field(default=lambda cfg: {})
    volumes: Callable[["InfraConfig"], list[tuple[str, str]]] = field(default=lambda cfg: [])
    cmd: Optional[list[str]] = None
    working_dir: Optional[str] = None
    depends_on: list[str] = field(default_factory=list)
    healthcheck: Optional[HealthCheck] = None
    one_shot: bool = False
    auto_remove: bool = False


@dataclass
class DoctorCheck:
    """One outcome of a doctor preflight probe."""
    name: str
    severity: Severity
    msg: str
    hint: Optional[str] = None


@dataclass
class DoctorReport:
    checks: list[DoctorCheck]

    def any_fail(self) -> bool:
        return any(c.severity == Severity.FAIL for c in self.checks)


class DoctorError(Exception):
    """Raised when doctor(strict=True) sees any FAIL-severity check."""

    def __init__(self, report: DoctorReport):
        self.report = report
        msg = "; ".join(c.msg for c in report.checks if c.severity == Severity.FAIL)
        super().__init__(f"doctor failed: {msg}")
```

- [ ] **Step 2.2: Smoke-import to catch syntax errors**

Run:
```bash
python -c "from boxlite_local.types import ServiceSpec, HealthCheck, DoctorCheck, DoctorReport, DoctorError, Severity; print('ok')"
```
Expected: prints `ok`.

- [ ] **Step 2.3: Commit**

```bash
git add apps/infra-local/boxlite_local/types.py
git commit -m "feat(infra-local): add types.py — ServiceSpec/HealthCheck/Doctor* dataclasses"
```

---

## Task 3: `config.py` — `InfraConfig` (TDD)

**Files:**
- Create: `apps/infra-local/tests/unit/test_config.py`
- Create: `apps/infra-local/boxlite_local/config.py`

- [ ] **Step 3.1: Write failing test `test_config.py`**

```python
"""Unit tests for InfraConfig defaults and env-var overrides."""

from pathlib import Path

from boxlite_local.config import InfraConfig


def test_defaults():
    cfg = InfraConfig()
    assert cfg.host_hub == "host.boxlite.internal"
    assert cfg.pg_host_port == 25432
    assert cfg.pg_user == "boxlite"
    assert cfg.pg_password == "boxlite"
    assert cfg.pg_db == "boxlite"
    assert cfg.data_dir == Path.home() / ".boxlite-local" / "data"


def test_pg_url_uses_host_hub_and_port():
    cfg = InfraConfig()
    assert cfg.pg_url == "postgresql://boxlite@host.boxlite.internal:25432/boxlite"


def test_load_picks_up_env_overrides(monkeypatch, tmp_path):
    monkeypatch.setenv("BOXLITE_HOST_HUB", "custom.host")
    monkeypatch.setenv("BOXLITE_PG_HOST_PORT", "55432")
    monkeypatch.setenv("BOXLITE_PG_USER", "alice")
    monkeypatch.setenv("BOXLITE_PG_PASSWORD", "s3cret")
    monkeypatch.setenv("BOXLITE_PG_DB", "appdb")
    monkeypatch.setenv("BOXLITE_DATA_DIR", str(tmp_path))

    cfg = InfraConfig.load()

    assert cfg.host_hub == "custom.host"
    assert cfg.pg_host_port == 55432
    assert cfg.pg_user == "alice"
    assert cfg.pg_password == "s3cret"
    assert cfg.pg_db == "appdb"
    assert cfg.data_dir == tmp_path


def test_load_falls_back_to_defaults_when_env_unset(monkeypatch):
    for var in (
        "BOXLITE_HOST_HUB", "BOXLITE_PG_HOST_PORT", "BOXLITE_PG_USER",
        "BOXLITE_PG_PASSWORD", "BOXLITE_PG_DB", "BOXLITE_DATA_DIR",
    ):
        monkeypatch.delenv(var, raising=False)

    cfg = InfraConfig.load()

    assert cfg.host_hub == "host.boxlite.internal"
    assert cfg.pg_host_port == 25432
```

- [ ] **Step 3.2: Verify test fails**

Run:
```bash
pytest apps/infra-local/tests/unit/test_config.py -v
```
Expected: ImportError or `ModuleNotFoundError: No module named 'boxlite_local.config'`.

- [ ] **Step 3.3: Implement `config.py`**

```python
"""InfraConfig dataclass — central config for the orchestrator. Pure data + env loading."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class InfraConfig:
    # host-hub address — inside-box reaches host via this name (Docker host.docker.internal equivalent)
    host_hub: str = "host.boxlite.internal"

    # postgres
    pg_host_port: int = 25432
    pg_user: str = "boxlite"
    pg_password: str = "boxlite"
    pg_db: str = "boxlite"

    # persistent data root (per-service subdirs are computed)
    data_dir: Path = field(default_factory=lambda: Path.home() / ".boxlite-local" / "data")

    @classmethod
    def load(cls) -> "InfraConfig":
        return cls(
            host_hub=os.environ.get("BOXLITE_HOST_HUB", "host.boxlite.internal"),
            pg_host_port=int(os.environ.get("BOXLITE_PG_HOST_PORT", "25432")),
            pg_user=os.environ.get("BOXLITE_PG_USER", "boxlite"),
            pg_password=os.environ.get("BOXLITE_PG_PASSWORD", "boxlite"),
            pg_db=os.environ.get("BOXLITE_PG_DB", "boxlite"),
            data_dir=Path(
                os.environ.get("BOXLITE_DATA_DIR")
                or str(Path.home() / ".boxlite-local" / "data")
            ),
        )

    @property
    def pg_url(self) -> str:
        return f"postgresql://{self.pg_user}@{self.host_hub}:{self.pg_host_port}/{self.pg_db}"
```

- [ ] **Step 3.4: Verify tests pass**

Run:
```bash
pytest apps/infra-local/tests/unit/test_config.py -v
```
Expected: 4 passed.

- [ ] **Step 3.5: Commit**

```bash
git add apps/infra-local/boxlite_local/config.py apps/infra-local/tests/unit/test_config.py
git commit -m "feat(infra-local): add InfraConfig with env-var override + tests"
```

---

## Task 4: `services.py` — `SPEC_PG` + `SERVICES` registry

No unit test: this is pure declarative data. Exercised by the integration test.

**Files:**
- Create: `apps/infra-local/boxlite_local/services.py`

- [ ] **Step 4.1: Write `services.py`**

```python
"""Declarative registry of services the orchestrator manages.

For the walking skeleton, this is just postgres. New services land here
as one new SPEC + one new SERVICES entry — no autodiscovery yet.
"""

from __future__ import annotations

from .types import HealthCheck, ServiceSpec


SPEC_PG = ServiceSpec(
    name="postgres",
    image="postgres:16-alpine",
    cpus=1,
    memory_mib=512,
    ports=[(25432, 5432)],                       # non-default host port — see spec §3.8
    env=lambda cfg: {
        "POSTGRES_USER": cfg.pg_user,
        "POSTGRES_PASSWORD": cfg.pg_password,    # required by image entrypoint
        "POSTGRES_DB": cfg.pg_db,
        "POSTGRES_HOST_AUTH_METHOD": "trust",    # local dev only
        "PGDATA": "/var/lib/postgresql/data/pgdata",
    },
    volumes=lambda cfg: [
        (str(cfg.data_dir / "pg"), "/var/lib/postgresql/data"),
    ],
    depends_on=[],
    healthcheck=HealthCheck(
        exec=["pg_isready", "-U", "boxlite", "-d", "boxlite", "-t", "1"],
        interval_s=2.0,
        retries=30,
    ),
)


SERVICES: dict[str, ServiceSpec] = {
    "postgres": SPEC_PG,
}
```

- [ ] **Step 4.2: Smoke-import + sanity-check the registry**

Run:
```bash
python -c "
from boxlite_local.services import SERVICES
from boxlite_local.config import InfraConfig
spec = SERVICES['postgres']
cfg = InfraConfig()
assert spec.ports == [(25432, 5432)]
assert spec.env(cfg)['POSTGRES_HOST_AUTH_METHOD'] == 'trust'
print('ok')
"
```
Expected: prints `ok`.

- [ ] **Step 4.3: Commit**

```bash
git add apps/infra-local/boxlite_local/services.py
git commit -m "feat(infra-local): add postgres SPEC + SERVICES registry"
```

---

## Task 5: `execwrap.py` — drain `box.exec` streams

No unit test: exercised by the integration test against real BoxLite.

**Files:**
- Create: `apps/infra-local/boxlite_local/execwrap.py`

- [ ] **Step 5.1: Write `execwrap.py`**

```python
"""Single home for the streaming box.exec → final (rc, out, err) collapse.

Per parent design §1.7.B: box.exec returns an Execution with stdout()/stderr()
async iterators and a wait() coroutine. Callers almost always want the final
exit_code + concatenated streams. This helper does exactly that.
"""

from __future__ import annotations

import asyncio
from typing import Optional


async def exec_collect(
    box,
    command: str,
    args: Optional[list[str]] = None,
    env: Optional[list[tuple[str, str]]] = None,
) -> tuple[int, str, str]:
    """Run `command args` inside `box`, drain streams, return (exit_code, stdout, stderr)."""
    execution = await box.exec(command, args or [], env=env)
    out_parts: list[str] = []
    err_parts: list[str] = []

    async def drain(stream, sink: list[str]) -> None:
        async for chunk in stream:
            sink.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8", "replace"))

    await asyncio.gather(
        drain(execution.stdout(), out_parts),
        drain(execution.stderr(), err_parts),
    )
    result = await execution.wait()
    return result.exit_code, "".join(out_parts), "".join(err_parts)
```

- [ ] **Step 5.2: Smoke-import**

Run:
```bash
python -c "from boxlite_local.execwrap import exec_collect; print('ok')"
```
Expected: prints `ok`.

- [ ] **Step 5.3: Commit**

```bash
git add apps/infra-local/boxlite_local/execwrap.py
git commit -m "feat(infra-local): add exec_collect helper for box.exec stream draining"
```

---

## Task 6: `doctor.py` — preflight checks (TDD on lsof parsing)

Only the lsof-parsing part is unit-testable in isolation. SDK-importable and runtime-reachable checks are integration-tested.

**Files:**
- Create: `apps/infra-local/tests/unit/test_doctor_lsof.py`
- Create: `apps/infra-local/boxlite_local/doctor.py`

- [ ] **Step 6.1: Write failing test `test_doctor_lsof.py`**

```python
"""Unit tests for lsof -F parsing in doctor.check_port_free."""

from boxlite_local.doctor import _parse_lsof_F, _LsofRow


def test_parse_empty_output_returns_no_rows():
    assert _parse_lsof_F("") == []


def test_parse_single_listener():
    out = "p723\ncpostgres\nLlilongen\nn127.0.0.1:5432\n"
    assert _parse_lsof_F(out) == [
        _LsofRow(pid=723, cmd="postgres", user="lilongen", name="127.0.0.1:5432"),
    ]


def test_parse_multiple_listeners():
    out = (
        "p723\ncpostgres\nLlilongen\nn127.0.0.1:5432\n"
        "p29538\ncboxlite-s\nLlilongen\nn*:5432\n"
    )
    rows = _parse_lsof_F(out)
    assert len(rows) == 2
    assert rows[0].cmd == "postgres"
    assert rows[0].pid == 723
    assert rows[1].cmd == "boxlite-s"
    assert rows[1].pid == 29538


def test_boxlite_listener_is_acceptable():
    """boxlite-s / boxlite-serve / boxlited prefix must NOT count as a conflict."""
    from boxlite_local.doctor import _is_boxlite_owner

    assert _is_boxlite_owner("boxlite-s") is True
    assert _is_boxlite_owner("boxlite-serve") is True
    assert _is_boxlite_owner("boxlited") is True
    assert _is_boxlite_owner("postgres") is False
    assert _is_boxlite_owner("redis-server") is False
    assert _is_boxlite_owner("") is False
```

- [ ] **Step 6.2: Verify test fails**

Run:
```bash
pytest apps/infra-local/tests/unit/test_doctor_lsof.py -v
```
Expected: ImportError on `boxlite_local.doctor`.

- [ ] **Step 6.3: Implement `doctor.py`**

```python
"""Preflight checks — run before any runtime mutation.

Checks (walking skeleton, postgres-only):
  1. BoxLite SDK importable
  2. BoxLite runtime reachable (list_info succeeds)
  3. For each (host_port, _) in services[*].ports: lsof shows no non-boxlite listener

Each check returns a DoctorCheck. doctor() aggregates them into a DoctorReport.
If strict=True and any check is Severity.FAIL, raises DoctorError.

macOS-only: relies on `lsof` and BSD-style flags. Cross-platform support is
out of scope for the walking skeleton.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass

from .config import InfraConfig
from .types import DoctorCheck, DoctorError, DoctorReport, ServiceSpec, Severity


@dataclass(frozen=True)
class _LsofRow:
    pid: int
    cmd: str
    user: str
    name: str


def _parse_lsof_F(output: str) -> list[_LsofRow]:
    """Parse `lsof -F pcLn` machine-readable output into rows.

    Format: one field per line, prefix byte indicates field type.
      p<pid>   c<command>   L<login>   n<name>
    Process records are introduced by `p`. Subsequent fields belong to
    that process until the next `p`.
    """
    rows: list[_LsofRow] = []
    pid: int | None = None
    cmd = user = name = ""
    for line in output.splitlines():
        if not line:
            continue
        prefix, _, value = line[0], line[0], line[1:]
        if prefix == "p":
            if pid is not None:
                rows.append(_LsofRow(pid=pid, cmd=cmd, user=user, name=name))
            pid = int(value)
            cmd = user = name = ""
        elif prefix == "c":
            cmd = value
        elif prefix == "L":
            user = value
        elif prefix == "n":
            name = value
    if pid is not None:
        rows.append(_LsofRow(pid=pid, cmd=cmd, user=user, name=name))
    return rows


def _is_boxlite_owner(cmd: str) -> bool:
    """True iff the lsof command name is one of ours (boxlite-serve, boxlited, boxlite-s truncation, ...)."""
    return cmd.startswith("boxlite")


def check_sdk_importable() -> DoctorCheck:
    try:
        try:
            from boxlite import Boxlite  # noqa: F401
        except ImportError:
            from boxlite.boxlite import Boxlite  # noqa: F401
        return DoctorCheck(
            name="sdk-importable",
            severity=Severity.OK,
            msg="BoxLite SDK importable",
        )
    except ImportError as e:
        return DoctorCheck(
            name="sdk-importable",
            severity=Severity.FAIL,
            msg=f"BoxLite Python SDK not importable: {e}",
            hint="Run `pip install -e sdks/python` from the boxlite repo, and confirm `which python` points at the right interpreter.",
        )


async def check_runtime_reachable() -> DoctorCheck:
    try:
        try:
            from boxlite import Boxlite
        except ImportError:
            from boxlite.boxlite import Boxlite
        runtime = Boxlite.default()
        await runtime.list_info()
        return DoctorCheck(
            name="runtime-reachable",
            severity=Severity.OK,
            msg="BoxLite runtime reachable",
        )
    except Exception as e:
        return DoctorCheck(
            name="runtime-reachable",
            severity=Severity.FAIL,
            msg=f"BoxLite runtime not responding: {type(e).__name__}: {e}",
            hint="Check `boxlite serve` / lockfile state.",
        )


def check_port_free(port: int) -> DoctorCheck:
    """Pass if no listener on `port`, OR the listener's command starts with `boxlite`."""
    name = f"port-{port}-free"
    if not shutil.which("lsof"):
        return DoctorCheck(
            name=name,
            severity=Severity.FAIL,
            msg="lsof not found; cannot verify port availability",
            hint="Install lsof (it's preinstalled on macOS — check your $PATH).",
        )
    proc = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-F", "pcLn"],
        capture_output=True,
        text=True,
        check=False,
    )
    # lsof exits 1 when nothing is listening. That's the happy path.
    if proc.returncode != 0 and not proc.stdout.strip():
        return DoctorCheck(
            name=name,
            severity=Severity.OK,
            msg=f"port {port} is free",
        )
    rows = _parse_lsof_F(proc.stdout)
    foreign = [r for r in rows if not _is_boxlite_owner(r.cmd)]
    if foreign:
        r = foreign[0]
        return DoctorCheck(
            name=name,
            severity=Severity.FAIL,
            msg=f"port {port} held by `{r.cmd}` (PID {r.pid}, user {r.user})",
            hint="Change the host port in InfraConfig or stop the local service.",
        )
    return DoctorCheck(
        name=name,
        severity=Severity.OK,
        msg=f"port {port} free (or held only by boxlite)",
    )


async def doctor(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    strict: bool = True,
) -> DoctorReport:
    """Run preflight checks. Raises DoctorError if strict and any FAIL."""
    checks: list[DoctorCheck] = []
    checks.append(check_sdk_importable())
    if checks[-1].severity != Severity.FAIL:
        checks.append(await check_runtime_reachable())
    for spec in services.values():
        for host_port, _ in spec.ports:
            checks.append(check_port_free(host_port))

    report = DoctorReport(checks=checks)
    if strict and report.any_fail():
        raise DoctorError(report)
    return report


def format_report(report: DoctorReport) -> str:
    """Pretty-print a DoctorReport for the CLI doctor subcommand."""
    marker = {Severity.OK: "✓", Severity.FAIL: "✗", Severity.WARN: "⚠"}
    lines: list[str] = []
    for c in report.checks:
        lines.append(f"  {marker[c.severity]} {c.name:<24} {c.msg}")
        if c.severity == Severity.FAIL and c.hint:
            lines.append(f"        → {c.hint}")
    return "\n".join(lines)
```

- [ ] **Step 6.4: Verify tests pass**

Run:
```bash
pytest apps/infra-local/tests/unit/test_doctor_lsof.py -v
```
Expected: 4 passed.

- [ ] **Step 6.5: Commit**

```bash
git add apps/infra-local/boxlite_local/doctor.py apps/infra-local/tests/unit/test_doctor_lsof.py
git commit -m "feat(infra-local): add doctor preflight (SDK + runtime + port checks)"
```

---

## Task 7: `orchestrator.py` — topo + up/down/ps (TDD on topo_sort)

`topo_sort` is the only piece with pure logic worth unit-testing; the rest is exercised by the integration test.

**Files:**
- Create: `apps/infra-local/tests/unit/test_topo.py`
- Create: `apps/infra-local/boxlite_local/orchestrator.py`

- [ ] **Step 7.1: Write failing test `test_topo.py`**

```python
"""Unit tests for orchestrator.topo_sort."""

import pytest

from boxlite_local.orchestrator import topo_sort
from boxlite_local.types import ServiceSpec


def _spec(name: str, depends_on: list[str] | None = None) -> ServiceSpec:
    return ServiceSpec(name=name, image="img:1", depends_on=depends_on or [])


def test_single_service_returns_one_layer():
    services = {"a": _spec("a")}
    assert topo_sort(services) == [["a"]]


def test_two_independent_services_share_a_layer():
    services = {"a": _spec("a"), "b": _spec("b")}
    layers = topo_sort(services)
    assert len(layers) == 1
    assert set(layers[0]) == {"a", "b"}


def test_linear_dependency_chain_layered():
    services = {
        "a": _spec("a"),
        "b": _spec("b", depends_on=["a"]),
        "c": _spec("c", depends_on=["b"]),
    }
    assert topo_sort(services) == [["a"], ["b"], ["c"]]


def test_diamond_dependency_layered():
    services = {
        "root": _spec("root"),
        "left": _spec("left", depends_on=["root"]),
        "right": _spec("right", depends_on=["root"]),
        "leaf": _spec("leaf", depends_on=["left", "right"]),
    }
    layers = topo_sort(services)
    assert layers[0] == ["root"]
    assert set(layers[1]) == {"left", "right"}
    assert layers[2] == ["leaf"]


def test_cycle_raises():
    services = {
        "a": _spec("a", depends_on=["b"]),
        "b": _spec("b", depends_on=["a"]),
    }
    with pytest.raises(Exception):
        topo_sort(services)
```

- [ ] **Step 7.2: Verify test fails**

Run:
```bash
pytest apps/infra-local/tests/unit/test_topo.py -v
```
Expected: ImportError on `boxlite_local.orchestrator`.

- [ ] **Step 7.3: Implement `orchestrator.py`**

```python
"""Top-level orchestration: topo_sort + up/down/ps + healthcheck loop.

Plain async functions, no classes. Single shared Boxlite.default() runtime
per call. Reuse path of get_or_create silently keeps existing config
(parent design doc §1.7.D); we warn on observable drift but do not auto-recreate.
"""

from __future__ import annotations

import asyncio
import shutil
import time
from graphlib import TopologicalSorter
from pathlib import Path

from .config import InfraConfig
from .doctor import doctor
from .execwrap import exec_collect
from .types import HealthCheck, ServiceSpec


def topo_sort(services: dict[str, ServiceSpec]) -> list[list[str]]:
    """Return service names grouped by topological layer.

    Each layer's members can be started in parallel; layer N must finish
    before layer N+1 begins.
    """
    ts: TopologicalSorter[str] = TopologicalSorter()
    for name, spec in services.items():
        ts.add(name, *spec.depends_on)
    ts.prepare()
    layers: list[list[str]] = []
    while ts.is_active():
        layer = sorted(ts.get_ready())
        if not layer:
            break
        layers.append(layer)
        for name in layer:
            ts.done(name)
    return layers


def _box_name(service_name: str) -> str:
    return f"boxlite-local-{service_name}"


def build_box_options(spec: ServiceSpec, config: InfraConfig):
    """Pure transform: ServiceSpec + InfraConfig → BoxOptions."""
    try:
        from boxlite import BoxOptions
    except ImportError:
        from boxlite.boxlite import BoxOptions  # type: ignore

    return BoxOptions(
        image=spec.image,
        cpus=spec.cpus,
        memory_mib=spec.memory_mib,
        auto_remove=spec.auto_remove,
        detach=True,
        ports=spec.ports,
        volumes=spec.volumes(config),
        env=list(spec.env(config).items()),
        cmd=spec.cmd,
    )


def _get_runtime():
    try:
        from boxlite import Boxlite
    except ImportError:
        from boxlite.boxlite import Boxlite  # type: ignore
    return Boxlite.default()


async def start_service(runtime, spec: ServiceSpec, config: InfraConfig) -> None:
    name = _box_name(spec.name)
    opts = build_box_options(spec, config)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    for host_path, _ in spec.volumes(config):
        # ensure mount source exists so the box doesn't fail to start
        Path(host_path).mkdir(parents=True, exist_ok=True)
    box, created = await runtime.get_or_create(opts, name=name)
    if created:
        await box.start()
    else:
        try:
            await box.start()
        except Exception as e:
            # already running is acceptable per SDK contract
            print(f"  {name}: (already running: {e!r})")
    if spec.healthcheck:
        await wait_healthy(box, spec.healthcheck, label=spec.name)


async def stop_service(runtime, service_name: str) -> bool:
    """Stop + remove the box for `service_name`. Idempotent. Returns True iff a box was found."""
    name = _box_name(service_name)
    try:
        box = await runtime.get(name)
    except Exception:
        return False
    try:
        await box.stop()
    except Exception as e:
        print(f"  {name}: stop failed ({e!r}); attempting remove anyway")
    try:
        await runtime.remove(name)
    except Exception as e:
        print(f"  {name}: remove failed ({e!r})")
    return True


async def wait_healthy(box, hc: HealthCheck, *, label: str) -> None:
    """Block until the healthcheck passes or retries exhaust.

    Walking skeleton supports only HealthCheck.exec; tcp/http variants are
    reserved for future services.
    """
    if hc.start_period_s:
        await asyncio.sleep(hc.start_period_s)
    if hc.exec is None:
        raise NotImplementedError(
            f"{label}: only HealthCheck.exec is implemented in the walking skeleton"
        )
    cmd, *args = hc.exec
    start = time.monotonic()
    for attempt in range(1, hc.retries + 1):
        rc, _out, _err = await exec_collect(box, cmd, args)
        if rc == 0:
            print(f"  {label}: healthy after {attempt} attempt(s), {time.monotonic() - start:.1f}s")
            return
        await asyncio.sleep(hc.interval_s)
    raise TimeoutError(
        f"{label}: healthcheck `{' '.join(hc.exec)}` failed after {hc.retries} attempts"
    )


async def up(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    only: list[str] | None = None,
    skip_doctor: bool = False,
) -> None:
    if not skip_doctor:
        await doctor(config, services, strict=True)
    else:
        print("=" * 60)
        print("WARNING: --skip-doctor was passed — preflight checks bypassed")
        print("=" * 60)
    runtime = _get_runtime()
    for layer in topo_sort(services):
        targets = [n for n in layer if only is None or n in only]
        if not targets:
            continue
        await asyncio.gather(*[start_service(runtime, services[n], config) for n in targets])


async def down(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    only: list[str] | None = None,
    wipe: bool = False,
) -> None:
    runtime = _get_runtime()
    for layer in reversed(topo_sort(services)):
        targets = [n for n in layer if only is None or n in only]
        if not targets:
            continue
        await asyncio.gather(*[stop_service(runtime, n) for n in targets])
    if wipe and config.data_dir.exists():
        shutil.rmtree(config.data_dir, ignore_errors=True)
        print(f"  data dir wiped: {config.data_dir}")


async def ps(config: InfraConfig) -> list[tuple[str, str, str]]:
    """Return list of (name, status, image) for boxlite-local-* boxes. Also prints."""
    runtime = _get_runtime()
    infos = await runtime.list_info()
    rows: list[tuple[str, str, str]] = []
    for info in infos:
        if info.name and info.name.startswith("boxlite-local-"):
            rows.append((info.name, info.state.status, info.image))
    if not rows:
        print("(no boxlite-local-* boxes)")
    else:
        for name, status, image in rows:
            print(f"  {name:<30} {status:<10} {image}")
    return rows
```

- [ ] **Step 7.4: Verify tests pass**

Run:
```bash
pytest apps/infra-local/tests/unit/test_topo.py -v
```
Expected: 5 passed.

- [ ] **Step 7.5: Commit**

```bash
git add apps/infra-local/boxlite_local/orchestrator.py apps/infra-local/tests/unit/test_topo.py
git commit -m "feat(infra-local): add orchestrator (topo_sort + up/down/ps + wait_healthy)"
```

---

## Task 8: `cli.py` + `__main__.py`

No unit test: argparse glue is shallow and exercised by manual smoke + integration test.

**Files:**
- Create: `apps/infra-local/boxlite_local/cli.py`
- Create: `apps/infra-local/boxlite_local/__main__.py`

- [ ] **Step 8.1: Write `cli.py`**

```python
"""argparse CLI dispatch for `python -m boxlite_local`.

Thin layer: parse args, call into orchestrator/doctor, map results to exit code.
Tests call the underlying async functions directly — they don't go through this.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from .config import InfraConfig
from .doctor import doctor, format_report
from .orchestrator import down, ps, up
from .services import SERVICES
from .types import DoctorError, Severity


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="boxlite_local",
        description="BoxLite-based infra-local orchestrator (Phase 2 walking skeleton).",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_doctor = sub.add_parser("doctor", help="Run preflight checks.")  # noqa: F841

    p_up = sub.add_parser("up", help="Bring services up.")
    p_up.add_argument("services", nargs="*", help="Subset of services (default: all)")
    p_up.add_argument("--skip-doctor", action="store_true", help="Bypass preflight checks")

    p_down = sub.add_parser("down", help="Stop + remove services.")
    p_down.add_argument("services", nargs="*", help="Subset of services (default: all)")
    p_down.add_argument("--wipe", action="store_true", help="Also remove the data dir")

    p_ps = sub.add_parser("ps", help="List boxlite-local-* boxes.")  # noqa: F841

    return parser


async def _cmd_doctor(config: InfraConfig) -> int:
    report = await doctor(config, SERVICES, strict=False)
    print(format_report(report))
    return 1 if report.any_fail() else 0


async def _cmd_up(config: InfraConfig, names: list[str], skip_doctor: bool) -> int:
    only = names or None
    try:
        await up(config, SERVICES, only=only, skip_doctor=skip_doctor)
    except DoctorError as e:
        print("doctor preflight failed:", file=sys.stderr)
        print(format_report(e.report), file=sys.stderr)
        return 1
    return 0


async def _cmd_down(config: InfraConfig, names: list[str], wipe: bool) -> int:
    only = names or None
    await down(config, SERVICES, only=only, wipe=wipe)
    return 0


async def _cmd_ps(config: InfraConfig) -> int:
    await ps(config)
    return 0


async def _async_main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    config = InfraConfig.load()
    if args.cmd == "doctor":
        return await _cmd_doctor(config)
    if args.cmd == "up":
        return await _cmd_up(config, args.services, args.skip_doctor)
    if args.cmd == "down":
        return await _cmd_down(config, args.services, args.wipe)
    if args.cmd == "ps":
        return await _cmd_ps(config)
    return 2  # unreachable — argparse already required cmd


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(_async_main(argv))
```

- [ ] **Step 8.2: Write `__main__.py`**

```python
"""Entry point for `python -m boxlite_local`."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 8.3: Verify CLI parses**

Run:
```bash
python -m boxlite_local --help
```
Expected: usage text listing the 4 subcommands.

Run:
```bash
python -m boxlite_local up --help
```
Expected: usage text with `services` positional and `--skip-doctor` flag.

- [ ] **Step 8.4: Commit**

```bash
git add apps/infra-local/boxlite_local/cli.py apps/infra-local/boxlite_local/__main__.py
git commit -m "feat(infra-local): add CLI dispatch + python -m boxlite_local entry"
```

---

## Task 9: Integration smoke test

**Files:**
- Create: `apps/infra-local/tests/integration/test_skeleton.py`

- [ ] **Step 9.1: Write `test_skeleton.py`**

```python
"""End-to-end smoke test against real BoxLite.

Gated on BOXLITE_INTEGRATION=1 because it pulls postgres:16-alpine and
boots a real microVM (~60s on a cold cache).
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

import pytest

from boxlite_local.config import InfraConfig
from boxlite_local.doctor import doctor
from boxlite_local.execwrap import exec_collect
from boxlite_local.orchestrator import _get_runtime, down, ps, up
from boxlite_local.services import SERVICES

pytestmark = pytest.mark.skipif(
    os.environ.get("BOXLITE_INTEGRATION") != "1",
    reason="set BOXLITE_INTEGRATION=1 to run",
)


@pytest.fixture
def tmp_config(monkeypatch):
    """Isolate test data dir per run so we don't clobber a developer's local state."""
    tmp = Path(tempfile.mkdtemp(prefix="boxlite-local-itest-"))
    monkeypatch.setenv("BOXLITE_DATA_DIR", str(tmp))
    cfg = InfraConfig.load()
    yield cfg
    shutil.rmtree(tmp, ignore_errors=True)


def test_walking_skeleton_round_trip(tmp_config: InfraConfig):
    asyncio.run(_round_trip(tmp_config))


async def _round_trip(cfg: InfraConfig) -> None:
    # 1. doctor passes on a clean machine
    report = await doctor(cfg, SERVICES, strict=False)
    assert not report.any_fail(), f"doctor failed before up: {report.checks!r}"

    try:
        # 2. up brings pg to RUNNING + healthy
        await up(cfg, SERVICES)

        # 3. ps shows boxlite-local-postgres RUNNING
        rows = await ps(cfg)
        names = {name for name, _status, _image in rows}
        assert "boxlite-local-postgres" in names
        status = next(s for n, s, _ in rows if n == "boxlite-local-postgres")
        assert status.lower() == "running", f"unexpected status: {status}"

        # 4. pg_isready inside the box confirms server is up
        runtime = _get_runtime()
        box = await runtime.get("boxlite-local-postgres")
        rc, out, err = await exec_collect(
            box, "pg_isready", ["-U", "boxlite", "-d", "boxlite", "-t", "1"]
        )
        assert rc == 0, f"pg_isready failed: rc={rc} out={out!r} err={err!r}"
    finally:
        # 5. down --wipe removes box and data
        await down(cfg, SERVICES, wipe=True)

    # 6. ps shows no boxlite-local-* boxes
    rows = await ps(cfg)
    names = {name for name, _, _ in rows}
    assert "boxlite-local-postgres" not in names
    assert not cfg.data_dir.exists()
```

- [ ] **Step 9.2: Run unit suite to confirm gating doesn't break it**

Run:
```bash
pytest apps/infra-local/tests/unit -v
```
Expected: all unit tests pass (9 total: 4 config + 4 doctor + 5 topo — re-count if you've added more).

- [ ] **Step 9.3: Run integration test (gated)**

Run:
```bash
BOXLITE_INTEGRATION=1 pytest apps/infra-local/tests/integration -v -s
```
Expected: one test passes. Cold run takes ~60s (image pull + microVM boot).

If it fails:
- Read the failure carefully. The orchestrator prints health-progress lines via `print()` — `-s` keeps them visible.
- `python -m boxlite_local doctor` from a shell to confirm preflight is green on your machine.
- `python -m boxlite_local ps` to inspect leftover state, then `python -m boxlite_local down --wipe` to clean.

- [ ] **Step 9.4: Commit**

```bash
git add apps/infra-local/tests/integration/test_skeleton.py
git commit -m "test(infra-local): add integration smoke (doctor → up → ps → down)"
```

---

## Task 10: Manual smoke per spec §10 + final fixes

If anything fails here, fix the underlying issue, re-run, and commit the fix as `fix(infra-local): ...`.

- [ ] **Step 10.1: doctor happy path**

Run:
```bash
python -m boxlite_local doctor
```
Expected: 3 ✓ rows (`sdk-importable`, `runtime-reachable`, `port-25432-free`). Exit 0.

- [ ] **Step 10.2: up brings pg up**

Run:
```bash
python -m boxlite_local up
```
Expected: prints `postgres: healthy after N attempt(s)` and returns to prompt.

- [ ] **Step 10.3: ps shows it running**

Run:
```bash
python -m boxlite_local ps
```
Expected: one row, `boxlite-local-postgres  running  postgres:16-alpine`.

- [ ] **Step 10.4: Detach proof from a fresh shell**

Open a new terminal (not a subshell). Run:
```bash
python -m boxlite_local ps
```
Expected: same row, still `running`.

- [ ] **Step 10.5: doctor regression with port held**

In a separate shell:
```bash
nc -l 25432 &
NC_PID=$!
```
Then:
```bash
python -m boxlite_local doctor
```
Expected: exit non-zero, includes `port 25432 held by \`nc\`` (or `nc`-prefixed variant).

Now confirm `up` refuses:
```bash
python -m boxlite_local up
```
Expected: exit non-zero, prints `doctor preflight failed:` followed by the same FAIL row. No box is touched.

Clean up:
```bash
kill $NC_PID
```

- [ ] **Step 10.6: down --wipe**

Run:
```bash
python -m boxlite_local down --wipe
ls ~/.boxlite-local/ 2>&1 || true
python -m boxlite_local ps
```
Expected: box gone; `~/.boxlite-local/data/` removed (`ls` shows no `data/` or no dir); `ps` shows nothing.

- [ ] **Step 10.7: --help readability**

Run:
```bash
python -m boxlite_local --help
python -m boxlite_local up --help
python -m boxlite_local doctor --help
python -m boxlite_local down --help
python -m boxlite_local ps --help
```
Expected: each prints a sensible usage block.

- [ ] **Step 10.8: Final check — every unit test still green**

Run from repo root:
```bash
pytest apps/infra-local/tests/unit -q
```
Expected: all green.

- [ ] **Step 10.9: If any fix commits were made during manual smoke, push them**

```bash
git log --oneline -5
```
Verify the Task 1-10 commit chain is intact and any `fix(infra-local): ...` commits are at the tip.
