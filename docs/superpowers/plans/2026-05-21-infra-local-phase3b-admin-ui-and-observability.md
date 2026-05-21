# Phase 3b — Admin UIs + Dex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Extend 3a's 5-service stack to a 9-service stack by adding dex + jaeger + pgadmin + registry-ui; close Phase-2 debt #2 (`HealthCheck.exec` callable-with-config). otel-collector explicitly deferred.

**Architecture:** Four new `ServiceSpec`s in `services.py` (3 stock-image straightforward + dex with inline entrypoint+config). Widen `HealthCheck.exec` to accept callable, thread `config` through `wait_healthy`. Extend integration test to cover all 8 daemons + minio-init.

**Spec:** [`docs/superpowers/specs/2026-05-21-infra-local-phase3b-admin-ui-and-observability.md`](../specs/2026-05-21-infra-local-phase3b-admin-ui-and-observability.md)

---

## File structure

| File | Change | Task |
|---|---|---|
| `apps/infra-local/boxlite_local/config.py` | +7 fields + `dex_issuer` property + env-vars | 1 |
| `apps/infra-local/tests/unit/test_config.py` | +tests for 3b fields | 1 |
| `apps/infra-local/boxlite_local/types.py` | widen `HealthCheck.exec` type | 2 |
| `apps/infra-local/boxlite_local/orchestrator.py` | `_wait_healthy_exec` accepts callable; thread `config` through `wait_healthy` + call sites | 2 |
| `apps/infra-local/tests/unit/test_orchestrator.py` | +test for `_wait_healthy_exec` callable dispatch | 2 |
| `apps/infra-local/boxlite_local/services.py` | +4 SPECs (dex / jaeger / pgadmin / registry-ui); migrate SPEC_PG to callable healthcheck | 3 |
| `apps/infra-local/tests/integration/test_multi_service.py` | extend `_DAEMON_SERVICES` to 8, add per-service reachability assertions | 4 |

---

## Task 1: `InfraConfig` 3b fields + `dex_issuer` property (TDD)

- [ ] **Step 1.1: Append failing tests to `test_config.py`**

```python
def test_new_3b_defaults():
    cfg = InfraConfig()
    assert cfg.dex_host_port == 25556
    assert cfg.jaeger_host_port == 26686
    assert cfg.pgadmin_host_port == 25051
    assert cfg.pgadmin_email == "admin@boxlite.dev"
    assert cfg.pgadmin_password == "boxlite"
    assert cfg.registry_ui_host_port == 25052


def test_dex_issuer_derives_from_host_hub_and_port():
    cfg = InfraConfig()
    assert cfg.dex_issuer == "http://host.boxlite.internal:25556/dex"


def test_pgadmin_password_hidden_in_repr():
    cfg = InfraConfig(pgadmin_password="topsecret")
    assert "topsecret" not in repr(cfg)


def test_load_picks_up_3b_env_overrides(monkeypatch):
    monkeypatch.setenv("BOXLITE_DEX_HOST_PORT", "15556")
    monkeypatch.setenv("BOXLITE_JAEGER_HOST_PORT", "16686")
    monkeypatch.setenv("BOXLITE_PGADMIN_HOST_PORT", "15051")
    monkeypatch.setenv("BOXLITE_PGADMIN_EMAIL", "ops@example.com")
    monkeypatch.setenv("BOXLITE_PGADMIN_PASSWORD", "p2")
    monkeypatch.setenv("BOXLITE_REGISTRY_UI_HOST_PORT", "15052")

    cfg = InfraConfig.load()
    assert cfg.dex_host_port == 15556
    assert cfg.jaeger_host_port == 16686
    assert cfg.pgadmin_host_port == 15051
    assert cfg.pgadmin_email == "ops@example.com"
    assert cfg.pgadmin_password == "p2"
    assert cfg.registry_ui_host_port == 15052
```

- [ ] **Step 1.2: Verify failures**

```bash
pytest apps/infra-local/tests/unit/test_config.py -v
```
Expected: 4 new tests fail with `AttributeError`.

- [ ] **Step 1.3: Extend `config.py`**

Find the existing `InfraConfig` dataclass and add the new fields + `dex_issuer` property + extend `.load()`. Concretely, replace the file's content with the version below (keeping everything from 3a, adding 3b additions):

```python
"""InfraConfig dataclass — central config for the orchestrator. Pure data + env loading."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _parse_int_env(name: str, default: str) -> int:
    raw = os.environ.get(name, default)
    try:
        return int(raw)
    except ValueError as e:
        raise ValueError(f"{name} must be an integer, got: {raw!r}") from e


def _detect_repo_root() -> Path:
    """Walk up from this file's directory until we find one containing apps/infra-local/."""
    here = Path(__file__).resolve().parent
    for parent in (here, *here.parents):
        if (parent / "apps" / "infra-local" / "pyproject.toml").exists():
            return parent
    raise RuntimeError(
        f"could not locate repo root (no apps/infra-local/pyproject.toml found above {here})"
    )


@dataclass
class InfraConfig:
    host_hub: str = "host.boxlite.internal"

    # postgres
    pg_host_port: int = 25432
    pg_user: str = "boxlite"
    pg_password: str = field(default="boxlite", repr=False)
    pg_db: str = "boxlite"

    # redis (3a)
    redis_host_port: int = 26379

    # minio (3a)
    minio_host_port: int = 29000
    minio_user: str = "minioadmin"
    minio_password: str = field(default="minioadmin", repr=False)

    # registry (3a)
    registry_host_port: int = 25000

    # dex (3b)
    dex_host_port: int = 25556

    # jaeger (3b)
    jaeger_host_port: int = 26686

    # pgadmin (3b)
    pgadmin_host_port: int = 25051
    pgadmin_email: str = "admin@boxlite.dev"
    pgadmin_password: str = field(default="boxlite", repr=False)

    # registry-ui (3b)
    registry_ui_host_port: int = 25052

    data_dir: Path = field(default_factory=lambda: Path.home() / ".boxlite-local" / "data")
    repo_root: Path = field(default_factory=_detect_repo_root)

    @classmethod
    def load(cls) -> "InfraConfig":
        return cls(
            host_hub=os.environ.get("BOXLITE_HOST_HUB", "host.boxlite.internal"),
            pg_host_port=_parse_int_env("BOXLITE_PG_HOST_PORT", "25432"),
            pg_user=os.environ.get("BOXLITE_PG_USER", "boxlite"),
            pg_password=os.environ.get("BOXLITE_PG_PASSWORD", "boxlite"),
            pg_db=os.environ.get("BOXLITE_PG_DB", "boxlite"),
            redis_host_port=_parse_int_env("BOXLITE_REDIS_HOST_PORT", "26379"),
            minio_host_port=_parse_int_env("BOXLITE_MINIO_HOST_PORT", "29000"),
            minio_user=os.environ.get("BOXLITE_MINIO_USER", "minioadmin"),
            minio_password=os.environ.get("BOXLITE_MINIO_PASSWORD", "minioadmin"),
            registry_host_port=_parse_int_env("BOXLITE_REGISTRY_HOST_PORT", "25000"),
            dex_host_port=_parse_int_env("BOXLITE_DEX_HOST_PORT", "25556"),
            jaeger_host_port=_parse_int_env("BOXLITE_JAEGER_HOST_PORT", "26686"),
            pgadmin_host_port=_parse_int_env("BOXLITE_PGADMIN_HOST_PORT", "25051"),
            pgadmin_email=os.environ.get("BOXLITE_PGADMIN_EMAIL", "admin@boxlite.dev"),
            pgadmin_password=os.environ.get("BOXLITE_PGADMIN_PASSWORD", "boxlite"),
            registry_ui_host_port=_parse_int_env("BOXLITE_REGISTRY_UI_HOST_PORT", "25052"),
            data_dir=Path(
                os.environ.get("BOXLITE_DATA_DIR")
                or str(Path.home() / ".boxlite-local" / "data")
            ),
        )

    @property
    def pg_url(self) -> str:
        return f"postgresql://{self.pg_user}@{self.host_hub}:{self.pg_host_port}/{self.pg_db}"

    @property
    def dex_issuer(self) -> str:
        return f"http://{self.host_hub}:{self.dex_host_port}/dex"
```

- [ ] **Step 1.4: Verify all unit tests pass**

```bash
pytest apps/infra-local/tests/unit -q
```
Expected: 30 passed (26 from 3a + 4 new).

- [ ] **Step 1.5: Commit**

```bash
git add apps/infra-local/boxlite_local/config.py apps/infra-local/tests/unit/test_config.py
git commit -m "feat(infra-local): extend InfraConfig with 3b fields (dex/jaeger/pgadmin/registry-ui)"
```

---

## Task 2: `HealthCheck.exec` callable + orchestrator dispatch (TDD)

- [ ] **Step 2.1: Append failing test to `test_orchestrator.py`**

```python
# tests/unit/test_orchestrator.py — append below existing tests

import asyncio

from boxlite_local.config import InfraConfig
from boxlite_local.orchestrator import _wait_healthy_exec
from boxlite_local.types import HealthCheck


class _FakeExecution:
    def __init__(self, exit_code):
        self._rc = exit_code

    def stdout(self):
        async def _it():
            if False:
                yield ""
        return _it()

    def stderr(self):
        async def _it():
            if False:
                yield ""
        return _it()

    async def wait(self):
        class _R: pass
        r = _R()
        r.exit_code = self._rc
        return r


class _FakeBox:
    def __init__(self, exit_code: int = 0):
        self.calls: list[tuple[str, list[str]]] = []
        self._rc = exit_code

    async def exec(self, command, args, env=None):
        self.calls.append((command, list(args)))
        return _FakeExecution(self._rc)


def test_wait_healthy_exec_accepts_literal_list():
    box = _FakeBox(exit_code=0)
    cfg = InfraConfig()
    hc = HealthCheck(exec=["echo", "hello"], retries=1, interval_s=0.0, timeout_s=1.0)
    asyncio.run(_wait_healthy_exec(box, hc, label="t", config=cfg))
    assert box.calls == [("echo", ["hello"])]


def test_wait_healthy_exec_accepts_callable_with_config():
    box = _FakeBox(exit_code=0)
    cfg = InfraConfig(pg_user="alice", pg_db="appdb")
    hc = HealthCheck(
        exec=lambda c: ["pg_isready", "-U", c.pg_user, "-d", c.pg_db],
        retries=1, interval_s=0.0, timeout_s=1.0,
    )
    asyncio.run(_wait_healthy_exec(box, hc, label="t", config=cfg))
    assert box.calls == [("pg_isready", ["-U", "alice", "-d", "appdb"])]
```

- [ ] **Step 2.2: Run, verify failure**

```bash
pytest apps/infra-local/tests/unit/test_orchestrator.py -v
```
Expected: 2 new tests fail (TypeError: `_wait_healthy_exec()` got unexpected keyword `config`, OR `HealthCheck` rejects callable).

- [ ] **Step 2.3: Update `types.py`**

Find the `HealthCheck` dataclass `exec` field:

```python
    exec: Optional[list[str]] = None
```

Change to:

```python
    exec: Optional[list[str] | Callable[["InfraConfig"], list[str]]] = None
```

Add `from typing import Callable, TYPE_CHECKING` and `if TYPE_CHECKING: from .config import InfraConfig` if not already present at module top (they are — both `ServiceSpec.env` and `.volumes` already use this).

- [ ] **Step 2.4: Update `orchestrator.py` `_wait_healthy_exec` + `wait_healthy`**

Replace `_wait_healthy_exec`:

```python
async def _wait_healthy_exec(box, hc: HealthCheck, *, label: str, config: InfraConfig) -> None:
    raw = hc.exec
    assert raw is not None
    cmd_list: list[str] = raw(config) if callable(raw) else raw
    cmd, *args = cmd_list
    start = time.monotonic()
    for attempt in range(1, hc.retries + 1):
        try:
            rc, _out, _err = await asyncio.wait_for(
                exec_collect(box, cmd, args), timeout=hc.timeout_s
            )
        except asyncio.TimeoutError:
            rc = -1
        if rc == 0:
            print(f"  {label}: healthy after {attempt} attempt(s), {time.monotonic() - start:.1f}s")
            return
        await asyncio.sleep(hc.interval_s)
    raise TimeoutError(
        f"{label}: healthcheck `{' '.join(cmd_list)}` failed after {hc.retries} attempts"
    )
```

Update `wait_healthy` to thread `config` through:

```python
async def wait_healthy(box, hc: HealthCheck, *, label: str, config: InfraConfig) -> None:
    if hc.start_period_s:
        await asyncio.sleep(hc.start_period_s)
    if hc.exec is not None:
        await _wait_healthy_exec(box, hc, label=label, config=config)
    elif hc.http_url is not None:
        await _wait_healthy_http(hc, label=label)
    elif hc.tcp_port is not None:
        raise NotImplementedError(f"{label}: HealthCheck.tcp_port not implemented in 3a")
    else:
        raise ValueError(f"{label}: HealthCheck has no probe configured")
```

Update the call site in `start_service`:

```python
    if spec.healthcheck:
        await wait_healthy(box, spec.healthcheck, label=spec.name, config=config)
```

- [ ] **Step 2.5: Verify**

```bash
pytest apps/infra-local/tests/unit -q
```
Expected: 32 passed (30 from Task 1 + 2 new).

- [ ] **Step 2.6: Commit**

```bash
git add apps/infra-local/boxlite_local/types.py apps/infra-local/boxlite_local/orchestrator.py apps/infra-local/tests/unit/test_orchestrator.py
git commit -m "feat(infra-local): HealthCheck.exec callable-with-config (Phase-2 debt #2)"
```

---

## Task 3: Add 4 new SPECs + migrate SPEC_PG to callable healthcheck

- [ ] **Step 3.1: Replace `services.py` entire content**

```python
"""Declarative registry of services the orchestrator manages.

Phase 3b: 3a stack + dex + jaeger + pgadmin + registry-ui (9 services).
otel-collector deferred (needs a build-from-repo pipeline).
"""

from __future__ import annotations

from .types import HealthCheck, ServiceSpec


SPEC_PG = ServiceSpec(
    name="postgres",
    image="postgres:16-alpine",
    cpus=1,
    memory_mib=512,
    ports=[(25432, 5432)],
    env=lambda cfg: {
        "POSTGRES_USER": cfg.pg_user,
        "POSTGRES_PASSWORD": cfg.pg_password,
        "POSTGRES_DB": cfg.pg_db,
        "POSTGRES_HOST_AUTH_METHOD": "trust",
        "PGDATA": "/var/lib/postgresql/data/pgdata",
    },
    volumes=lambda cfg: [
        (str(cfg.data_dir / "pg"), "/var/lib/postgresql/data"),
    ],
    depends_on=[],
    # Callable healthcheck — passes cfg-derived user/db (validates Phase-2 debt #2 fix).
    healthcheck=HealthCheck(
        exec=lambda cfg: ["pg_isready", "-U", cfg.pg_user, "-d", cfg.pg_db, "-t", "1"],
        interval_s=2.0,
        retries=30,
    ),
)


SPEC_REDIS = ServiceSpec(
    name="redis",
    image="redis:7-alpine",
    cpus=1,
    memory_mib=256,
    ports=[(26379, 6379)],
    volumes=lambda cfg: [(str(cfg.data_dir / "redis"), "/data")],
    depends_on=[],
    healthcheck=HealthCheck(
        exec=["redis-cli", "PING"],
        interval_s=2.0,
        retries=30,
    ),
)


SPEC_MINIO = ServiceSpec(
    name="minio",
    image="minio/minio:latest",
    cpus=1,
    memory_mib=512,
    ports=[(29000, 9000), (29001, 9001)],
    env=lambda cfg: {
        "MINIO_ROOT_USER": cfg.minio_user,
        "MINIO_ROOT_PASSWORD": cfg.minio_password,
    },
    cmd=["server", "/data", "--console-address", ":9001"],
    volumes=lambda cfg: [(str(cfg.data_dir / "minio"), "/data")],
    depends_on=[],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:29000/minio/health/live",
        interval_s=2.0,
        retries=30,
    ),
)


_MINIO_INIT_SCRIPT = """\
set -eu
for i in 1 2 3 4 5; do
  if mc alias set boxlite "$MINIO_URL" "$MINIO_USER" "$MINIO_PASSWORD" 2>/dev/null; then break; fi
  echo "init: minio not ready yet (attempt $i)"
  sleep 2
done
mc alias set boxlite "$MINIO_URL" "$MINIO_USER" "$MINIO_PASSWORD"
mc mb --ignore-existing boxlite/boxlite
echo "init: ok - boxlite bucket ready"
"""


SPEC_MINIO_INIT = ServiceSpec(
    name="minio-init",
    image="minio/mc:latest",
    cpus=1,
    memory_mib=128,
    ports=[],
    one_shot=True,
    depends_on=["minio"],
    entrypoint=["sh"],
    cmd=["-c", _MINIO_INIT_SCRIPT],
    env=lambda cfg: {
        "MINIO_URL": f"http://{cfg.host_hub}:{cfg.minio_host_port}",
        "MINIO_USER": cfg.minio_user,
        "MINIO_PASSWORD": cfg.minio_password,
    },
    volumes=lambda cfg: [],
    healthcheck=None,
)


SPEC_REGISTRY = ServiceSpec(
    name="registry",
    image="registry:2",
    cpus=1,
    memory_mib=256,
    ports=[(25000, 5000)],
    volumes=lambda cfg: [(str(cfg.data_dir / "registry"), "/var/lib/registry")],
    depends_on=[],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:25000/v2/",
        interval_s=2.0,
        retries=30,
    ),
)


# ─── 3b services ──────────────────────────────────────────────────────────

_DEX_CONFIG = """\
issuer: ${DEX_ISSUER}
storage:
  type: sqlite3
  config:
    file: /var/dex/dex.db
web:
  http: 0.0.0.0:5556
  allowedOrigins: ['*']
  allowedHeaders: ['x-requested-with']
staticClients:
  - id: boxlite
    redirectURIs:
      - '${REDIRECT_URI}'
      - 'http://localhost:3000'
      - 'http://localhost:5173'
    name: 'BoxLite'
    public: true
enablePasswordDB: true
staticPasswords:
  - email: 'admin@boxlite.dev'
    hash: '$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W'
    username: 'admin'
    userID: '1234'
"""

_DEX_ENTRYPOINT = """\
set -e
mkdir -p /var/dex /tmp
cat > /tmp/dex-config.yaml <<'__CFG__'
""" + _DEX_CONFIG + """\
__CFG__
sed -i "s|\\${DEX_ISSUER}|${DEX_ISSUER}|g" /tmp/dex-config.yaml
sed -i "s|\\${REDIRECT_URI}|${REDIRECT_URI}|g" /tmp/dex-config.yaml
exec /usr/local/bin/dex serve /tmp/dex-config.yaml
"""


SPEC_DEX = ServiceSpec(
    name="dex",
    image="dexidp/dex:v2.42.0",
    cpus=1,
    memory_mib=256,
    ports=[(25556, 5556)],
    env=lambda cfg: {
        "DEX_ISSUER": cfg.dex_issuer,
        "REDIRECT_URI": "http://localhost:3000",
    },
    depends_on=[],
    # dex image's default entrypoint is /usr/local/bin/dex; override to sh
    # so we can run the inline script that env-substitutes the config.
    entrypoint=["sh"],
    cmd=["-c", _DEX_ENTRYPOINT],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:25556/dex/.well-known/openid-configuration",
        interval_s=2.0,
        retries=30,
    ),
)


SPEC_JAEGER = ServiceSpec(
    name="jaeger",
    image="jaegertracing/all-in-one:1.67.0",
    cpus=1,
    memory_mib=512,
    ports=[(26686, 16686)],
    env=lambda cfg: {
        "COLLECTOR_OTLP_ENABLED": "true",
    },
    depends_on=[],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:26686/",
        interval_s=2.0,
        retries=30,
    ),
)


SPEC_PGADMIN = ServiceSpec(
    name="pgadmin",
    image="dpage/pgadmin4:9.2.0",
    cpus=1,
    memory_mib=512,
    ports=[(25051, 80)],
    env=lambda cfg: {
        "PGADMIN_DEFAULT_EMAIL": cfg.pgadmin_email,
        "PGADMIN_DEFAULT_PASSWORD": cfg.pgadmin_password,
        # Skip the password-setup wizard so probes don't redirect forever.
        "PGADMIN_CONFIG_SERVER_MODE": "False",
        "PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED": "False",
    },
    depends_on=["postgres"],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:25051/misc/ping",
        interval_s=2.0,
        retries=60,                        # pgadmin can take 30s+ to warm up
    ),
)


SPEC_REGISTRY_UI = ServiceSpec(
    name="registry-ui",
    image="joxit/docker-registry-ui:main",
    cpus=1,
    memory_mib=128,
    ports=[(25052, 80)],
    env=lambda cfg: {
        "REGISTRY_TITLE": "BoxLite local registry",
        "NGINX_PROXY_PASS_URL": f"http://{cfg.host_hub}:{cfg.registry_host_port}",
        "SINGLE_REGISTRY": "true",
    },
    depends_on=["registry"],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:25052/",
        interval_s=2.0,
        retries=30,
    ),
)


SERVICES: dict[str, ServiceSpec] = {
    "postgres":    SPEC_PG,
    "redis":       SPEC_REDIS,
    "minio":       SPEC_MINIO,
    "minio-init":  SPEC_MINIO_INIT,
    "registry":    SPEC_REGISTRY,
    "dex":         SPEC_DEX,
    "jaeger":      SPEC_JAEGER,
    "pgadmin":     SPEC_PGADMIN,
    "registry-ui": SPEC_REGISTRY_UI,
}
```

- [ ] **Step 3.2: Smoke-import the registry**

```bash
python -c "
from boxlite_local.services import SERVICES
from boxlite_local.config import InfraConfig
cfg = InfraConfig()
expected = {'postgres','redis','minio','minio-init','registry','dex','jaeger','pgadmin','registry-ui'}
assert set(SERVICES.keys()) == expected, set(SERVICES.keys())
assert SERVICES['pgadmin'].depends_on == ['postgres']
assert SERVICES['registry-ui'].depends_on == ['registry']
assert SERVICES['minio-init'].depends_on == ['minio']
assert callable(SERVICES['postgres'].healthcheck.exec), 'SPEC_PG healthcheck.exec must be callable'
assert SERVICES['dex'].entrypoint == ['sh']
assert 'sed' in SERVICES['dex'].cmd[1]
print('ok')
"
```
Expected: prints `ok`.

- [ ] **Step 3.3: Topo sort check**

```bash
python -c "
from boxlite_local.orchestrator import topo_sort
from boxlite_local.services import SERVICES
layers = topo_sort(SERVICES)
print(layers)
# Each service with depends_on must come after its dependency
for i, layer in enumerate(layers):
    for name in layer:
        for dep in SERVICES[name].depends_on:
            dep_layer = next(j for j, l in enumerate(layers) if dep in l)
            assert dep_layer < i, f'{name} depends on {dep} but {dep} is in layer {dep_layer} >= {i}'
print('topo ok')
"
```
Expected: prints layers list + `topo ok`.

- [ ] **Step 3.4: Commit**

```bash
git add apps/infra-local/boxlite_local/services.py
git commit -m "feat(infra-local): add dex + jaeger + pgadmin + registry-ui specs"
```

---

## Task 4: Extend integration test to 8 daemons + per-service reachability

- [ ] **Step 4.1: Replace `tests/integration/test_multi_service.py`**

```python
"""End-to-end smoke test against real BoxLite.

Gated on BOXLITE_INTEGRATION=1.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import urllib.request
from pathlib import Path

import pytest

from boxlite_local.config import InfraConfig
from boxlite_local.doctor import doctor
from boxlite_local.execwrap import exec_collect
from boxlite_local.orchestrator import down, get_runtime, ps, up
from boxlite_local.services import SERVICES

pytestmark = pytest.mark.skipif(
    os.environ.get("BOXLITE_INTEGRATION") != "1",
    reason="set BOXLITE_INTEGRATION=1 to run",
)


_DAEMON_SERVICES = [
    "boxlite-local-postgres",
    "boxlite-local-redis",
    "boxlite-local-minio",
    "boxlite-local-registry",
    "boxlite-local-dex",
    "boxlite-local-jaeger",
    "boxlite-local-pgadmin",
    "boxlite-local-registry-ui",
]
_ONE_SHOT_SERVICES = ["boxlite-local-minio-init"]


@pytest.fixture
def tmp_config(monkeypatch):
    tmp = Path(tempfile.mkdtemp(prefix="boxlite-local-itest-"))
    monkeypatch.setenv("BOXLITE_DATA_DIR", str(tmp))
    cfg = InfraConfig.load()
    yield cfg
    shutil.rmtree(tmp, ignore_errors=True)


def test_9_service_round_trip(tmp_config: InfraConfig):
    asyncio.run(_round_trip(tmp_config))


async def _round_trip(cfg: InfraConfig) -> None:
    pre = await ps(cfg)
    pre_names = [n for n, _, _ in pre]
    if pre_names:
        pytest.skip(
            f"refusing to run: pre-existing boxlite-local-* boxes would be destroyed "
            f"by cleanup ({pre_names}). Run `python -m boxlite_local down --wipe` first."
        )

    report = await doctor(cfg, SERVICES, strict=False)
    assert not report.any_fail(), f"doctor failed before up: {report.checks!r}"

    try:
        await up(cfg, SERVICES, skip_doctor=True)

        rows = await ps(cfg)
        names = {n for n, _, _ in rows}
        for daemon in _DAEMON_SERVICES:
            assert daemon in names, f"missing daemon: {daemon} (got {names})"
            status = next(s for n, s, _ in rows if n == daemon)
            assert status.lower() == "running", f"{daemon}: unexpected status {status}"
        for one_shot in _ONE_SHOT_SERVICES:
            assert one_shot not in names, \
                f"one-shot {one_shot} should be removed but still listed"

        assert cfg.data_dir.exists(), f"data_dir not created by up(): {cfg.data_dir}"

        # Reachability spot-checks from the host
        runtime = get_runtime()

        pg_box = await runtime.get("boxlite-local-postgres")
        rc, _o, _e = await exec_collect(
            pg_box, "pg_isready", ["-U", "boxlite", "-d", "boxlite", "-t", "1"]
        )
        assert rc == 0, "pg_isready failed inside pg box"

        redis_box = await runtime.get("boxlite-local-redis")
        rc, out, _e = await exec_collect(redis_box, "redis-cli", ["PING"])
        assert rc == 0 and "PONG" in out, f"redis PING failed: rc={rc} out={out!r}"

        for url, label in [
            (f"http://127.0.0.1:{cfg.minio_host_port}/minio/health/live", "minio"),
            (f"http://127.0.0.1:{cfg.registry_host_port}/v2/", "registry"),
            (f"http://127.0.0.1:{cfg.dex_host_port}/dex/.well-known/openid-configuration", "dex"),
            (f"http://127.0.0.1:{cfg.jaeger_host_port}/", "jaeger"),
            (f"http://127.0.0.1:{cfg.pgadmin_host_port}/misc/ping", "pgadmin"),
            (f"http://127.0.0.1:{cfg.registry_ui_host_port}/", "registry-ui"),
        ]:
            with urllib.request.urlopen(url, timeout=5) as resp:
                assert 200 <= resp.status < 300, f"{label} bad status: {resp.status} for {url}"

    finally:
        await down(cfg, SERVICES, wipe=True)

    rows = await ps(cfg)
    names = {n for n, _, _ in rows}
    for daemon in _DAEMON_SERVICES:
        assert daemon not in names
    assert not cfg.data_dir.exists()
```

- [ ] **Step 4.2: Confirm unit tests still pass**

```bash
pytest apps/infra-local/tests/unit -q
```
Expected: 32 passed.

- [ ] **Step 4.3: Confirm integration test still skips without env var**

```bash
pytest apps/infra-local/tests/integration -v
```
Expected: 1 skipped.

- [ ] **Step 4.4: Commit**

```bash
git add apps/infra-local/tests/integration/test_multi_service.py
git commit -m "test(infra-local): extend integration to 9-service round-trip"
```

---

## Task 5: Manual smoke + run integration + fix anything broken

- [ ] **Step 5.1: clean state + doctor**

```bash
python -m boxlite_local down --wipe 2>&1 | tail -3 || true
python -m boxlite_local doctor
```
Expected: all ✓ (sdk + runtime + 8 unique port checks: 25432, 26379, 29000, 29001, 25000, 25556, 26686, 25051, 25052).

- [ ] **Step 5.2: up brings all 8 daemons + minio-init**

```bash
time python -m boxlite_local up
```
Expected: every daemon reports `healthy after N attempt(s)`; minio-init reports `one-shot completed and removed`.

- [ ] **Step 5.3: ps**

```bash
python -m boxlite_local ps
```
Expected: 8 daemons running, no minio-init.

- [ ] **Step 5.4: Per-service reachability**

```bash
psql "postgresql://boxlite@127.0.0.1:25432/boxlite" -c "SELECT 1"
boxlite exec boxlite-local-redis -- redis-cli PING
curl -fsS -o /dev/null -w "minio: %{http_code}\n" http://127.0.0.1:29000/minio/health/live
curl -fsS -o /dev/null -w "registry: %{http_code}\n" http://127.0.0.1:25000/v2/
curl -fsS -o /dev/null -w "dex: %{http_code}\n" http://127.0.0.1:25556/dex/.well-known/openid-configuration
curl -fsS -o /dev/null -w "jaeger: %{http_code}\n" http://127.0.0.1:26686/
curl -fsS -o /dev/null -w "pgadmin: %{http_code}\n" http://127.0.0.1:25051/misc/ping
curl -fsS -o /dev/null -w "registry-ui: %{http_code}\n" http://127.0.0.1:25052/
```
Expected: all `200`s plus `PONG` and `1` row.

- [ ] **Step 5.5: integration test**

```bash
python -m boxlite_local down --wipe 2>&1 | tail -3
BOXLITE_INTEGRATION=1 pytest apps/infra-local/tests/integration -v -s
```
Expected: 1 passed.

- [ ] **Step 5.6: final unit suite**

```bash
pytest apps/infra-local/tests/unit -q
```
Expected: 32 passed.
