# `apps/infra-local/` Phase 3a — Foundation Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the walking-skeleton orchestrator from 1 service to 5 by adding redis + minio + minio-init + registry; implement `HealthCheck.http_url`, `one_shot=True`, repo-root resolution; close Phase-2 debt #1.

**Architecture:** Add `_wait_healthy_http` + `_http_probe` helpers in `orchestrator.py`; branch `start_service` on `spec.one_shot` (with `_wait_one_shot_exit` + `runtime.remove` lifecycle); narrow exception via `_is_already_running_error` predicate. Add 6 fields to `InfraConfig` (+ `_detect_repo_root` helper). 4 new SPECs + SERVICES dict expansion in `services.py`. Rename + extend integration test to 5-service round-trip.

**Tech Stack:** Python 3.10+ asyncio, stdlib `urllib.request`, BoxLite Python SDK, pytest.

**Spec:** [`docs/superpowers/specs/2026-05-21-infra-local-phase3a-foundation-services.md`](../specs/2026-05-21-infra-local-phase3a-foundation-services.md)

---

## File Structure

| File | Change | Task |
|---|---|---|
| `apps/infra-local/boxlite_local/config.py` | +6 fields, +`_detect_repo_root` helper, +env-var parsing | 1 |
| `apps/infra-local/tests/unit/test_config.py` | +tests for new fields, env override, `_detect_repo_root` | 1 |
| `apps/infra-local/boxlite_local/orchestrator.py` | dispatch in `wait_healthy`, +`_wait_healthy_http` + `_http_probe`, +`one_shot` branch + `_wait_one_shot_exit`, +`_is_already_running_error` predicate | 2 |
| `apps/infra-local/tests/unit/test_orchestrator.py` | new file — unit tests for `_http_probe` + `_is_already_running_error` | 2 |
| `apps/infra-local/boxlite_local/services.py` | +4 SPECs, +SERVICES expansion | 3 |
| `apps/infra-local/configs/minio/init.sh` | new file — bucket bootstrap | 3 |
| `apps/infra-local/tests/integration/test_skeleton.py` | renamed → `test_multi_service.py` | 4 |
| `apps/infra-local/tests/integration/test_multi_service.py` | extended to 5-service round-trip | 4 |

---

## Task 1: `InfraConfig` extensions + `_detect_repo_root` (TDD)

**Files:**
- Modify: `apps/infra-local/boxlite_local/config.py`
- Modify: `apps/infra-local/tests/unit/test_config.py`

- [ ] **Step 1.1: Extend `test_config.py` with failing tests**

Append to existing `test_config.py`:

```python
def test_new_3a_defaults():
    cfg = InfraConfig()
    assert cfg.redis_host_port == 26379
    assert cfg.minio_host_port == 29000
    assert cfg.minio_user == "minioadmin"
    assert cfg.minio_password == "minioadmin"
    assert cfg.registry_host_port == 25000


def test_minio_password_hidden_in_repr():
    cfg = InfraConfig(minio_password="hunter2")
    assert "hunter2" not in repr(cfg)


def test_load_picks_up_3a_env_overrides(monkeypatch):
    monkeypatch.setenv("BOXLITE_REDIS_HOST_PORT", "16379")
    monkeypatch.setenv("BOXLITE_MINIO_HOST_PORT", "19000")
    monkeypatch.setenv("BOXLITE_MINIO_USER", "u1")
    monkeypatch.setenv("BOXLITE_MINIO_PASSWORD", "p1")
    monkeypatch.setenv("BOXLITE_REGISTRY_HOST_PORT", "15000")

    cfg = InfraConfig.load()
    assert cfg.redis_host_port == 16379
    assert cfg.minio_host_port == 19000
    assert cfg.minio_user == "u1"
    assert cfg.minio_password == "p1"
    assert cfg.registry_host_port == 15000


def test_repo_root_points_at_repo_with_pyproject_in_apps_infra_local():
    cfg = InfraConfig()
    # repo_root must contain apps/infra-local/pyproject.toml
    assert (cfg.repo_root / "apps" / "infra-local" / "pyproject.toml").exists(), \
        f"_detect_repo_root returned wrong dir: {cfg.repo_root}"


def test_load_raises_clear_error_on_malformed_redis_port_env(monkeypatch):
    monkeypatch.setenv("BOXLITE_REDIS_HOST_PORT", "notanumber")
    import pytest as _pytest
    with _pytest.raises(ValueError, match="BOXLITE_REDIS_HOST_PORT must be an integer"):
        InfraConfig.load()
```

- [ ] **Step 1.2: Run, verify failures**

```bash
pytest apps/infra-local/tests/unit/test_config.py -v
```
Expected: 5 new tests fail (`AttributeError` on `cfg.redis_host_port` etc.).

- [ ] **Step 1.3: Extend `config.py`**

Replace the full content of `apps/infra-local/boxlite_local/config.py` with:

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
    """Walk up from this file's directory until we find one containing apps/infra-local/.

    Used to compute absolute host paths for config-file volume mounts
    (e.g. apps/infra-local/configs/minio/init.sh).
    """
    here = Path(__file__).resolve().parent
    for parent in (here, *here.parents):
        if (parent / "apps" / "infra-local" / "pyproject.toml").exists():
            return parent
    raise RuntimeError(
        f"could not locate repo root (no apps/infra-local/pyproject.toml found above {here})"
    )


@dataclass
class InfraConfig:
    # host-hub address — inside-box reaches host via this name
    host_hub: str = "host.boxlite.internal"

    # postgres
    pg_host_port: int = 25432
    pg_user: str = "boxlite"
    pg_password: str = field(default="boxlite", repr=False)
    pg_db: str = "boxlite"

    # redis (3a)
    redis_host_port: int = 26379

    # minio (3a)
    minio_host_port: int = 29000           # API port; console is 29001 (pinned in SPEC)
    minio_user: str = "minioadmin"
    minio_password: str = field(default="minioadmin", repr=False)

    # registry (3a)
    registry_host_port: int = 25000

    # persistent data root (per-service subdirs are computed)
    data_dir: Path = field(default_factory=lambda: Path.home() / ".boxlite-local" / "data")

    # repo root — needed for absolute paths of config-file mounts
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
            data_dir=Path(
                os.environ.get("BOXLITE_DATA_DIR")
                or str(Path.home() / ".boxlite-local" / "data")
            ),
        )

    @property
    def pg_url(self) -> str:
        return f"postgresql://{self.pg_user}@{self.host_hub}:{self.pg_host_port}/{self.pg_db}"
```

- [ ] **Step 1.4: Run all unit tests**

```bash
pytest apps/infra-local/tests/unit -q
```
Expected: 21 passed (16 prior + 5 new in test_config.py).

- [ ] **Step 1.5: Commit**

```bash
git add apps/infra-local/boxlite_local/config.py apps/infra-local/tests/unit/test_config.py
git commit -m "feat(infra-local): extend InfraConfig with 3a fields + repo_root detection"
```

---

## Task 2: Orchestrator — http_url healthcheck + one_shot lifecycle + narrow exception (TDD where applicable)

**Files:**
- Modify: `apps/infra-local/boxlite_local/orchestrator.py`
- Create: `apps/infra-local/tests/unit/test_orchestrator.py`

- [ ] **Step 2.1: Write failing unit tests for `_http_probe` + `_is_already_running_error`**

Create `apps/infra-local/tests/unit/test_orchestrator.py`:

```python
"""Unit tests for orchestrator helpers that can be tested in isolation."""

from __future__ import annotations

import http.server
import socketserver
import threading

import pytest

from boxlite_local.orchestrator import _http_probe, _is_already_running_error


# ─── _http_probe ─────────────────────────────────────────────────────────

class _Handler200(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_):  # silence noise during tests
        pass


class _Handler500(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(500)
        self.end_headers()

    def log_message(self, *_):
        pass


def _serve(handler_cls) -> tuple[socketserver.TCPServer, threading.Thread]:
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler_cls)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, t


def test_http_probe_returns_true_on_2xx():
    srv, _ = _serve(_Handler200)
    try:
        port = srv.server_address[1]
        assert _http_probe(f"http://127.0.0.1:{port}/") is True
    finally:
        srv.shutdown()
        srv.server_close()


def test_http_probe_returns_false_on_5xx():
    srv, _ = _serve(_Handler500)
    try:
        port = srv.server_address[1]
        # urllib raises HTTPError on 5xx — _http_probe swallows and returns False
        assert _http_probe(f"http://127.0.0.1:{port}/") is False
    finally:
        srv.shutdown()
        srv.server_close()


def test_http_probe_returns_false_when_unreachable():
    # Port 1 is reserved (tcpmux) and almost always closed — connection refused.
    assert _http_probe("http://127.0.0.1:1/") is False


# ─── _is_already_running_error ──────────────────────────────────────────

def test_already_running_predicate_matches_known_patterns():
    assert _is_already_running_error(Exception("box is already running")) is True
    assert _is_already_running_error(Exception("Box already started")) is True
    assert _is_already_running_error(Exception("ERROR: already exists")) is True


def test_already_running_predicate_rejects_unrelated_errors():
    assert _is_already_running_error(Exception("image pull failed")) is False
    assert _is_already_running_error(Exception("out of memory")) is False
    assert _is_already_running_error(Exception("")) is False
    assert _is_already_running_error(RuntimeError("network timeout")) is False
```

- [ ] **Step 2.2: Run, verify failures**

```bash
pytest apps/infra-local/tests/unit/test_orchestrator.py -v
```
Expected: 6 tests fail with `ImportError` on `_http_probe` / `_is_already_running_error`.

- [ ] **Step 2.3: Replace `orchestrator.py`**

Replace `apps/infra-local/boxlite_local/orchestrator.py` with:

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
import urllib.error
import urllib.request
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
    return _build_box_options_with_volumes(spec, config, spec.volumes(config))


def _build_box_options_with_volumes(spec: ServiceSpec, config: InfraConfig, volumes):
    """Same as build_box_options but accepts pre-computed volumes to avoid double-evaluation."""
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
        volumes=volumes,
        env=list(spec.env(config).items()),
        cmd=spec.cmd,
        working_dir=spec.working_dir,
    )


def get_runtime():
    try:
        from boxlite import Boxlite
    except ImportError:
        from boxlite.boxlite import Boxlite  # type: ignore
    return Boxlite.default()


# ─── exception-narrowing predicate (Phase-2 debt #1) ──────────────────────

_ALREADY_RUNNING_PATTERNS = ("already running", "already started", "already exists")


def _is_already_running_error(exc: Exception) -> bool:
    """Heuristic: SDK doesn't expose a typed exception for 'box is already running'.

    Match on message substring so we can tolerate this specific case while
    letting all other SDK errors propagate.
    """
    msg = str(exc).lower()
    if not msg:
        return False
    return any(p in msg for p in _ALREADY_RUNNING_PATTERNS)


# ─── HTTP healthcheck ─────────────────────────────────────────────────────

def _http_probe(url: str) -> bool:
    """Sync HTTP probe — return True iff status 2xx. Runs in to_thread for async caller."""
    try:
        with urllib.request.urlopen(url, timeout=2.0) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        return False
    except Exception:
        return False


# ─── start / stop / wait ──────────────────────────────────────────────────

async def start_service(runtime, spec: ServiceSpec, config: InfraConfig) -> None:
    name = _box_name(spec.name)
    volumes = spec.volumes(config)
    opts = _build_box_options_with_volumes(spec, config, volumes)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    for host_path, _ in volumes:
        p = Path(host_path)
        # Heuristic: only auto-create directory mounts. Paths with a suffix
        # (e.g. init.sh) are likely files — caller is responsible for them.
        if not p.suffix:
            p.mkdir(parents=True, exist_ok=True)

    box, created = await runtime.get_or_create(opts, name=name)

    if spec.one_shot:
        # One-shot services re-run every `up` (idempotent bootstrap).
        # If an old box exists, drop it first so cmd actually re-executes.
        if not created:
            print(f"  {name}: removing stale one-shot box before re-running")
            try:
                await box.stop()
            except Exception:
                pass
            await runtime.remove(name)
            box, _ = await runtime.get_or_create(opts, name=name)
        await box.start()
        await _wait_one_shot_exit(runtime, name, label=spec.name)
        try:
            await runtime.remove(name)
        except Exception as e:
            print(f"  {name}: one-shot remove failed ({e!r})")
        print(f"  {name}: one-shot completed and removed")
        return

    if created:
        await box.start()
    else:
        try:
            await box.start()
        except Exception as e:
            if not _is_already_running_error(e):
                raise
            print(f"  {name}: (already running: {e!r})")
    if spec.healthcheck:
        await wait_healthy(box, spec.healthcheck, label=spec.name)


async def stop_service(runtime, service_name: str) -> bool:
    """Stop + remove the box for service_name. Idempotent. Returns True iff a box was found."""
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
    """Dispatch to the probe type set on the healthcheck."""
    if hc.start_period_s:
        await asyncio.sleep(hc.start_period_s)
    if hc.exec is not None:
        await _wait_healthy_exec(box, hc, label=label)
    elif hc.http_url is not None:
        await _wait_healthy_http(hc, label=label)
    elif hc.tcp_port is not None:
        raise NotImplementedError(f"{label}: HealthCheck.tcp_port not implemented in 3a")
    else:
        raise ValueError(f"{label}: HealthCheck has no probe configured")


async def _wait_healthy_exec(box, hc: HealthCheck, *, label: str) -> None:
    assert hc.exec is not None
    cmd, *args = hc.exec
    start = time.monotonic()
    for attempt in range(1, hc.retries + 1):
        try:
            rc, _out, _err = await asyncio.wait_for(
                exec_collect(box, cmd, args), timeout=hc.timeout_s
            )
        except asyncio.TimeoutError:
            rc = -1  # treat as failed probe; continue retry loop
        if rc == 0:
            print(f"  {label}: healthy after {attempt} attempt(s), {time.monotonic() - start:.1f}s")
            return
        await asyncio.sleep(hc.interval_s)
    raise TimeoutError(
        f"{label}: healthcheck `{' '.join(hc.exec)}` failed after {hc.retries} attempts"
    )


async def _wait_healthy_http(hc: HealthCheck, *, label: str) -> None:
    assert hc.http_url is not None
    start = time.monotonic()
    last_err: Exception | None = None
    for attempt in range(1, hc.retries + 1):
        try:
            ok = await asyncio.wait_for(
                asyncio.to_thread(_http_probe, hc.http_url), timeout=hc.timeout_s
            )
        except asyncio.TimeoutError as e:
            ok = False
            last_err = e
        except Exception as e:
            ok = False
            last_err = e
        if ok:
            print(f"  {label}: healthy after {attempt} attempt(s), {time.monotonic() - start:.1f}s")
            return
        await asyncio.sleep(hc.interval_s)
    raise TimeoutError(
        f"{label}: HTTP healthcheck `{hc.http_url}` failed after {hc.retries} attempts"
        + (f" (last err: {last_err!r})" if last_err else "")
    )


async def _wait_one_shot_exit(runtime, name: str, *, label: str, timeout_s: float = 120.0) -> None:
    """Poll list_info() until the named box is no longer running.

    Used for `spec.one_shot=True` services that exit on their own (e.g. minio-init).
    SDK doesn't expose a direct wait-for-exit, so poll every 1s.
    """
    start = time.monotonic()
    while time.monotonic() - start < timeout_s:
        infos = await runtime.list_info()
        info = next((i for i in infos if i.name == name), None)
        if info is None:
            # box already gone (e.g., auto_remove kicked in)
            return
        status = info.state.status.lower()
        if status != "running":
            print(f"  {label}: one-shot exited with state={status}")
            return
        await asyncio.sleep(1.0)
    raise TimeoutError(f"{label}: one-shot did not exit within {timeout_s}s")


# ─── top-level entry points ───────────────────────────────────────────────

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
    runtime = get_runtime()
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
    runtime = get_runtime()
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
    runtime = get_runtime()
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

- [ ] **Step 2.4: Run all unit tests**

```bash
pytest apps/infra-local/tests/unit -q
```
Expected: 27 passed (21 from Task 1 + 6 new in test_orchestrator.py).

- [ ] **Step 2.5: Commit**

```bash
git add apps/infra-local/boxlite_local/orchestrator.py apps/infra-local/tests/unit/test_orchestrator.py
git commit -m "feat(infra-local): http_url healthcheck + one_shot lifecycle + narrow exception (debt #1)"
```

---

## Task 3: New service specs + minio-init script

**Files:**
- Modify: `apps/infra-local/boxlite_local/services.py`
- Create: `apps/infra-local/configs/minio/init.sh`

- [ ] **Step 3.1: Create init.sh**

```bash
mkdir -p apps/infra-local/configs/minio
```

Create `apps/infra-local/configs/minio/init.sh` (exact content):

```sh
#!/bin/sh
set -eu

# Wait briefly for minio to be reachable (defense in depth — orchestrator
# already gates this via depends_on healthcheck).
for i in 1 2 3 4 5; do
    if mc alias set boxlite "$MINIO_URL" "$MINIO_USER" "$MINIO_PASSWORD" 2>/dev/null; then
        break
    fi
    echo "init: minio not ready yet (attempt $i)"
    sleep 2
done

mc alias set boxlite "$MINIO_URL" "$MINIO_USER" "$MINIO_PASSWORD"

# Create the default bucket idempotently — --ignore-existing makes mc mb a no-op
# if the bucket already exists.
mc mb --ignore-existing boxlite/boxlite

echo "init: ok — boxlite bucket ready"
```

Make it executable:

```bash
chmod +x apps/infra-local/configs/minio/init.sh
```

- [ ] **Step 3.2: Replace `services.py`**

Replace `apps/infra-local/boxlite_local/services.py` with:

```python
"""Declarative registry of services the orchestrator manages.

Phase 3a: pg (from Phase 2) + redis + minio + minio-init + registry.
New services land here as one new SPEC + one new SERVICES entry —
no autodiscovery yet.
"""

from __future__ import annotations

from .types import HealthCheck, ServiceSpec


SPEC_PG = ServiceSpec(
    name="postgres",
    image="postgres:16-alpine",
    cpus=1,
    memory_mib=512,
    ports=[(25432, 5432)],                       # non-default host port — see parent design §3.8
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


SPEC_MINIO_INIT = ServiceSpec(
    name="minio-init",
    image="minio/mc:latest",
    cpus=1,
    memory_mib=128,
    ports=[],
    one_shot=True,
    depends_on=["minio"],
    cmd=["/bin/sh", "/init.sh"],
    env=lambda cfg: {
        "MINIO_URL": f"http://{cfg.host_hub}:{cfg.minio_host_port}",
        "MINIO_USER": cfg.minio_user,
        "MINIO_PASSWORD": cfg.minio_password,
    },
    volumes=lambda cfg: [
        (str(cfg.repo_root / "apps/infra-local/configs/minio/init.sh"), "/init.sh"),
    ],
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


SERVICES: dict[str, ServiceSpec] = {
    "postgres":   SPEC_PG,
    "redis":      SPEC_REDIS,
    "minio":      SPEC_MINIO,
    "minio-init": SPEC_MINIO_INIT,
    "registry":   SPEC_REGISTRY,
}
```

- [ ] **Step 3.3: Smoke-import the registry**

```bash
python -c "
from boxlite_local.services import SERVICES
from boxlite_local.config import InfraConfig
cfg = InfraConfig()
assert set(SERVICES.keys()) == {'postgres', 'redis', 'minio', 'minio-init', 'registry'}
assert SERVICES['minio-init'].one_shot is True
assert SERVICES['minio-init'].depends_on == ['minio']
# spot-check env lambdas
assert SERVICES['minio'].env(cfg)['MINIO_ROOT_USER'] == 'minioadmin'
assert SERVICES['minio-init'].env(cfg)['MINIO_URL'].endswith(':29000')
assert SERVICES['registry'].healthcheck.http_url == 'http://127.0.0.1:25000/v2/'
print('ok')
"
```
Expected: prints `ok`.

- [ ] **Step 3.4: Confirm topo + doctor still work**

```bash
python -c "
import asyncio
from boxlite_local.orchestrator import topo_sort
from boxlite_local.services import SERVICES
layers = topo_sort(SERVICES)
# minio must come before minio-init
assert any('minio' in layer and 'minio-init' not in layer for layer in layers)
assert any('minio-init' in layer for layer in layers)
print(layers)
"
```
Expected: prints e.g. `[['minio', 'postgres', 'redis', 'registry'], ['minio-init']]`.

- [ ] **Step 3.5: Commit**

```bash
git add apps/infra-local/boxlite_local/services.py apps/infra-local/configs/minio/init.sh
git commit -m "feat(infra-local): add redis + minio + minio-init + registry specs"
```

---

## Task 4: Rename + extend integration test

**Files:**
- Rename: `apps/infra-local/tests/integration/test_skeleton.py` → `test_multi_service.py`
- Modify: `apps/infra-local/tests/integration/test_multi_service.py`

- [ ] **Step 4.1: Rename**

```bash
git mv apps/infra-local/tests/integration/test_skeleton.py apps/infra-local/tests/integration/test_multi_service.py
```

- [ ] **Step 4.2: Replace contents**

Replace `apps/infra-local/tests/integration/test_multi_service.py` with:

```python
"""End-to-end smoke test against real BoxLite.

Gated on BOXLITE_INTEGRATION=1 because it pulls 4 OCI images and boots
real microVMs (~90s on cold cache).
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


_DAEMON_SERVICES = ["boxlite-local-postgres", "boxlite-local-redis",
                    "boxlite-local-minio", "boxlite-local-registry"]
_ONE_SHOT_SERVICES = ["boxlite-local-minio-init"]


@pytest.fixture
def tmp_config(monkeypatch):
    """Isolate test data dir per run; do not clobber developer state."""
    tmp = Path(tempfile.mkdtemp(prefix="boxlite-local-itest-"))
    monkeypatch.setenv("BOXLITE_DATA_DIR", str(tmp))
    cfg = InfraConfig.load()
    yield cfg
    shutil.rmtree(tmp, ignore_errors=True)


def test_5_service_round_trip(tmp_config: InfraConfig):
    asyncio.run(_round_trip(tmp_config))


async def _round_trip(cfg: InfraConfig) -> None:
    # 0. Guard: refuse to run if any boxlite-local-* box already exists.
    pre = await ps(cfg)
    pre_names = [n for n, _, _ in pre]
    if pre_names:
        pytest.skip(
            f"refusing to run: pre-existing boxlite-local-* boxes would be destroyed "
            f"by cleanup ({pre_names}). Run `python -m boxlite_local down --wipe` first."
        )

    # 1. doctor clean on this machine
    report = await doctor(cfg, SERVICES, strict=False)
    assert not report.any_fail(), f"doctor failed before up: {report.checks!r}"

    try:
        # 2. up brings 4 daemons healthy + runs minio-init one-shot
        await up(cfg, SERVICES, skip_doctor=True)

        # 3. ps shows the 4 daemons RUNNING and minio-init absent
        rows = await ps(cfg)
        names = {n for n, _, _ in rows}
        for daemon in _DAEMON_SERVICES:
            assert daemon in names, f"missing daemon: {daemon} (got {names})"
            status = next(s for n, s, _ in rows if n == daemon)
            assert status.lower() == "running", f"{daemon}: unexpected status {status}"
        for one_shot in _ONE_SHOT_SERVICES:
            assert one_shot not in names, \
                f"one-shot service {one_shot} should have been removed but is still listed"

        # 4. data_dir was created by up()
        assert cfg.data_dir.exists(), f"data_dir not created by up(): {cfg.data_dir}"

        # 5. Reachability spot-checks from the host
        runtime = get_runtime()

        # 5a. pg_isready inside pg box
        pg_box = await runtime.get("boxlite-local-postgres")
        rc, _o, _e = await exec_collect(
            pg_box, "pg_isready", ["-U", "boxlite", "-d", "boxlite", "-t", "1"]
        )
        assert rc == 0, "pg_isready failed inside pg box"

        # 5b. redis-cli PING inside redis box
        redis_box = await runtime.get("boxlite-local-redis")
        rc, out, _e = await exec_collect(redis_box, "redis-cli", ["PING"])
        assert rc == 0 and "PONG" in out, f"redis PING failed: rc={rc} out={out!r}"

        # 5c. minio health endpoint reachable from host
        with urllib.request.urlopen(
            f"http://127.0.0.1:{cfg.minio_host_port}/minio/health/live", timeout=3
        ) as resp:
            assert 200 <= resp.status < 300, f"minio health bad status: {resp.status}"

        # 5d. registry v2 endpoint reachable from host
        with urllib.request.urlopen(
            f"http://127.0.0.1:{cfg.registry_host_port}/v2/", timeout=3
        ) as resp:
            assert 200 <= resp.status < 300, f"registry v2 bad status: {resp.status}"

    finally:
        # 6. down --wipe removes everything
        await down(cfg, SERVICES, wipe=True)

    # 7. ps clean + data_dir gone
    rows = await ps(cfg)
    names = {n for n, _, _ in rows}
    for daemon in _DAEMON_SERVICES:
        assert daemon not in names
    assert not cfg.data_dir.exists()
```

- [ ] **Step 4.3: Confirm unit tests still pass**

```bash
pytest apps/infra-local/tests/unit -q
```
Expected: 27 passed.

- [ ] **Step 4.4: Confirm integration test still skips without env var**

```bash
pytest apps/infra-local/tests/integration -v
```
Expected: 1 skipped.

- [ ] **Step 4.5: Commit**

```bash
git add apps/infra-local/tests/integration/
git commit -m "test(infra-local): rename + extend integration to 5-service round-trip"
```

---

## Task 5: Manual smoke + fix anything broken

Per spec §8 acceptance.

- [ ] **Step 5.1: doctor happy path**

```bash
python -m boxlite_local doctor
```
Expected: 6 ✓ rows (sdk + runtime + 5 unique port checks — 25432, 26379, 29000, 29001, 25000). Wait — minio has 2 ports, so 6 port-free checks total, 8 rows. Confirm and proceed.

If failures (e.g. ports held), follow the doctor hint.

- [ ] **Step 5.2: up brings 5-stack up**

```bash
python -m boxlite_local up
```
Expected: prints health-progress lines for each daemon, then `minio-init: one-shot completed and removed`. Returns to prompt.

- [ ] **Step 5.3: ps shows 4 daemons, no minio-init**

```bash
python -m boxlite_local ps
```
Expected: 4 rows (postgres, redis, minio, registry), all `running`. No `minio-init` row.

- [ ] **Step 5.4: Reachability spot checks**

```bash
redis-cli -h 127.0.0.1 -p 26379 PING
curl -fsS http://127.0.0.1:29000/minio/health/live
curl -fsS http://127.0.0.1:25000/v2/
psql "postgresql://boxlite@127.0.0.1:25432/boxlite" -c "SELECT 1"
```
Expected: `PONG`, 200 response (empty for health/live and `{}` for v2), `1`.

- [ ] **Step 5.5: Integration test**

Manually clear any leftover `boxlite-local-*` boxes first if needed (the guard will skip otherwise), then:

```bash
BOXLITE_INTEGRATION=1 pytest apps/infra-local/tests/integration -v -s
```
Expected: 1 passed.

- [ ] **Step 5.6: down --wipe**

```bash
python -m boxlite_local down --wipe
python -m boxlite_local ps
ls ~/.boxlite-local/ 2>&1
```
Expected: no boxes; `~/.boxlite-local/data/` removed.

- [ ] **Step 5.7: Re-run up to confirm minio-init re-runs**

```bash
python -m boxlite_local up | grep minio-init
python -m boxlite_local down --wipe
```
Expected: line `minio-init: one-shot completed and removed`. Confirms idempotent re-run semantics.

- [ ] **Step 5.8: Final unit suite**

```bash
pytest apps/infra-local/tests/unit -q
```
Expected: 27 passed.

- [ ] **Step 5.9: If any fix commits were made during manual smoke**

```bash
git log --oneline d1b13315..HEAD
```
Confirm the Task 1-4 commits + any `fix(infra-local): ...` commits.
