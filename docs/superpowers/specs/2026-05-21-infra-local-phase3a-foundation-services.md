# `apps/infra-local/` Phase 3a — Foundation Services Design

> **Status:** approved (2026-05-21) — autonomous E2E execution authorized
> **Owner:** lile (michael.li@polygala.ai)
> **Parent design:** [`docs/apps/own-dog-food-local-infra-solution.md`](../../apps/own-dog-food-local-infra-solution.md) §10 Phase 3 (decomposed into 3a/3b/3c)
> **Prior:** [Phase 2 walking skeleton spec](2026-05-20-infra-local-phase2-walking-skeleton.md) — postgres-only stack already runs

---

## 1. Background

Phase 2 delivered a walking skeleton with one service (postgres) wired end-to-end. Phase 3a extends that skeleton to a **5-service foundation stack** by adding 4 new services (redis, minio, minio-init, registry) that all use stock OCI images. Phase 3a deliberately keeps services with custom Dockerfiles (`apps/dex/`, `apps/otel-collector/`) out of scope — those land in 3b together with the "build from `apps/` context" mechanism.

Phase 3a is the smallest increment that exercises the new framework mechanisms required by the rest of Phase 3:

- `HealthCheck.http_url` probe (used by minio + registry)
- `one_shot=True` service lifecycle (used by minio-init)
- Multi-service `up`/`down` with `depends_on` (minio-init depends on minio)
- Repo-root path resolution for config-file volume mounts

It also retires one Phase-2 debt: `start_service` currently catches a bare `Exception` on the reuse path, masking real SDK errors. With more services, this becomes a real debug hazard.

---

## 2. Scope

**In scope:**
- 4 new `ServiceSpec`s: `SPEC_REDIS`, `SPEC_MINIO`, `SPEC_MINIO_INIT`, `SPEC_REGISTRY`
- New `InfraConfig` fields: `redis_host_port`, `minio_host_port`, `minio_user`, `minio_password`, `registry_host_port`, `repo_root`
- `HealthCheck.http_url` probe implementation (host-side `urllib` GET)
- `one_shot=True` lifecycle: run command → wait for exit → `runtime.remove`
- Narrow `start_service` exception handling (Phase 2 debt #1)
- `apps/infra-local/configs/minio/init.sh` for bucket bootstrap
- Integration test rename + extension: `test_skeleton.py` → `test_multi_service.py`, asserts 5-service round-trip

**Out of scope (deferred to 3b/3c):**
- `HealthCheck.tcp_port` implementation (no caller in 3a)
- `HealthCheck.exec` callable-with-config refactor (Phase 2 debt #2 — no caller in 3a; current hardcoded args still match pg defaults)
- Services that need Dockerfile build (`dex`, `otel-collector`)
- Reverse proxy / TLS / dns-shim (Caddy in 3c)
- Box-name isolation in tests (defer)

**Decisions taken (locked, no user review per autonomy directive):**

| Decision | Choice | Why |
|---|---|---|
| `http_url` probe location | Host-side (`urllib.request`) | Reuses the PoC's `host_tcp_check` pattern; no in-box tooling assumption |
| `one_shot` semantics | `start_service` waits for exit, then `runtime.remove(name)` | Mirrors `docker compose` one-shot containers; cleanly disposable |
| `tcp_port` | Deferred | No 3a service needs it (redis exec / minio http / registry http); type field exists but unimplemented — wait_healthy raises `NotImplementedError` if encountered |
| Integration test layout | Single multi-service test in `test_multi_service.py` | Matches Phase 2 single-test pattern; per-service tests are YAGNI here |
| Phase-2 debt #1 (narrow except) | Fixed in 3a | Becomes a real debug burden as service count grows |
| Phase-2 debt #2 (HealthCheck callable) | Deferred | No 3a service exercises it |
| Phase-2 debt #3 (box-name isolation) | Deferred | `pytest.skip` guard already prevents destruction; revisit when itest is run more frequently |
| Repo-root detection | `InfraConfig.repo_root` field, default = walk up from `__file__` until `pyproject.toml` parent of `apps/infra-local/` is found | Needed for minio-init config mount; one-line property |

---

## 3. Service specs

### `SPEC_REDIS`

```python
SPEC_REDIS = ServiceSpec(
    name="redis",
    image="redis:7-alpine",
    cpus=1, memory_mib=256,
    ports=[(26379, 6379)],                       # non-default host port
    volumes=lambda cfg: [(str(cfg.data_dir / "redis"), "/data")],
    depends_on=[],
    healthcheck=HealthCheck(exec=["redis-cli", "PING"], retries=30),
)
```

### `SPEC_MINIO`

```python
SPEC_MINIO = ServiceSpec(
    name="minio",
    image="minio/minio:latest",
    cpus=1, memory_mib=512,
    ports=[(29000, 9000), (29001, 9001)],        # API + console
    env=lambda cfg: {
        "MINIO_ROOT_USER": cfg.minio_user,
        "MINIO_ROOT_PASSWORD": cfg.minio_password,
    },
    cmd=["server", "/data", "--console-address", ":9001"],
    volumes=lambda cfg: [(str(cfg.data_dir / "minio"), "/data")],
    depends_on=[],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:29000/minio/health/live",
        retries=30,
    ),
)
```

### `SPEC_MINIO_INIT`

```python
SPEC_MINIO_INIT = ServiceSpec(
    name="minio-init",
    image="minio/mc:latest",
    cpus=1, memory_mib=128,
    one_shot=True,
    depends_on=["minio"],
    cmd=["/bin/sh", "/init.sh"],
    env=lambda cfg: {
        "MINIO_URL": f"http://{cfg.host_hub}:{cfg.minio_host_port}",
        "MINIO_USER": cfg.minio_user,
        "MINIO_PASSWORD": cfg.minio_password,
    },
    volumes=lambda cfg: [(
        str(cfg.repo_root / "apps/infra-local/configs/minio/init.sh"),
        "/init.sh",
    )],
    healthcheck=None,
)
```

### `SPEC_REGISTRY`

```python
SPEC_REGISTRY = ServiceSpec(
    name="registry",
    image="registry:2",
    cpus=1, memory_mib=256,
    ports=[(25000, 5000)],
    volumes=lambda cfg: [(str(cfg.data_dir / "registry"), "/var/lib/registry")],
    depends_on=[],
    healthcheck=HealthCheck(http_url="http://127.0.0.1:25000/v2/", retries=30),
)
```

### `SERVICES` registry

```python
SERVICES: dict[str, ServiceSpec] = {
    "postgres":   SPEC_PG,
    "redis":      SPEC_REDIS,
    "minio":      SPEC_MINIO,
    "minio-init": SPEC_MINIO_INIT,
    "registry":   SPEC_REGISTRY,
}
```

---

## 4. `InfraConfig` extensions

```python
@dataclass
class InfraConfig:
    # ... existing fields (host_hub, pg_*, data_dir) ...

    redis_host_port: int = 26379

    minio_host_port: int = 29000   # API; console pinned to 29001 in SPEC, no separate field
    minio_user: str = "minioadmin"
    minio_password: str = field(default="minioadmin", repr=False)

    registry_host_port: int = 25000

    repo_root: Path = field(default_factory=_detect_repo_root)
```

`_detect_repo_root()` walks up from `config.py`'s `__file__` until it finds a directory containing `apps/infra-local/`. Raises `RuntimeError` if it falls off the filesystem root (defensive — shouldn't happen in normal install).

`load()` reads `BOXLITE_REDIS_HOST_PORT` / `BOXLITE_MINIO_HOST_PORT` / `BOXLITE_MINIO_USER` / `BOXLITE_MINIO_PASSWORD` / `BOXLITE_REGISTRY_HOST_PORT` env vars with the same `_parse_int_env` pattern. `repo_root` is not overridable via env (it's a runtime detection).

---

## 5. Orchestrator changes

### 5.1 `wait_healthy` dispatches on probe type

```python
async def wait_healthy(box, hc: HealthCheck, *, label: str) -> None:
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
```

Existing `wait_healthy.exec` path moves into `_wait_healthy_exec` unchanged. New helper:

```python
async def _wait_healthy_http(hc: HealthCheck, *, label: str) -> None:
    import urllib.request, urllib.error
    start = time.monotonic()
    last_err: Exception | None = None
    for attempt in range(1, hc.retries + 1):
        try:
            ok = await asyncio.wait_for(
                asyncio.to_thread(_http_probe, hc.http_url), timeout=hc.timeout_s
            )
            if ok:
                print(f"  {label}: healthy after {attempt} attempt(s), {time.monotonic() - start:.1f}s")
                return
        except asyncio.TimeoutError as e:
            last_err = e
        except Exception as e:
            last_err = e
        await asyncio.sleep(hc.interval_s)
    raise TimeoutError(
        f"{label}: HTTP healthcheck `{hc.http_url}` failed after {hc.retries} attempts (last err: {last_err!r})"
    )


def _http_probe(url: str) -> bool:
    """Synchronous HTTP probe — return True iff status 2xx. Run in to_thread for async caller."""
    try:
        with urllib.request.urlopen(url, timeout=2.0) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False
```

### 5.2 `one_shot=True` lifecycle

`start_service` branches on `spec.one_shot`:

```python
async def start_service(runtime, spec: ServiceSpec, config: InfraConfig) -> None:
    name = _box_name(spec.name)
    volumes = spec.volumes(config)
    opts = _build_box_options_with_volumes(spec, config, volumes)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    for host_path, _ in volumes:
        p = Path(host_path)
        if not p.suffix:
            p.mkdir(parents=True, exist_ok=True)

    box, created = await runtime.get_or_create(opts, name=name)

    if spec.one_shot:
        # one-shot: must always be fresh (re-runs the bootstrap each `up`)
        if not created:
            print(f"  {name}: removing stale one-shot box before re-running")
            try:
                await box.stop()
            except Exception:
                pass
            await runtime.remove(name)
            box, _ = await runtime.get_or_create(opts, name=name)
        await box.start()
        # Wait for the box to exit. wait_for_exit() vs polling list_info():
        # SDK doesn't expose a direct wait, so poll info.state.status.
        await _wait_one_shot_exit(runtime, name, label=spec.name)
        await runtime.remove(name)
        print(f"  {name}: one-shot completed and removed")
        return

    # daemon path (unchanged):
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
```

New helpers:

```python
async def _wait_one_shot_exit(runtime, name: str, *, label: str, timeout_s: float = 60.0) -> None:
    """Poll list_info() until the named box is no longer in 'running' state."""
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


_ALREADY_RUNNING_PATTERNS = ("already running", "already started", "already exists")

def _is_already_running_error(exc: Exception) -> bool:
    """Heuristic: detect SDK's 'box already running' signal so we can ignore it.
    SDK doesn't expose a typed exception for this; match on message substring.
    """
    msg = str(exc).lower()
    return any(p in msg for p in _ALREADY_RUNNING_PATTERNS)
```

### 5.3 Narrow `start_service` exception (debt #1)

Captured in §5.2 above: bare `except Exception` is replaced by `if not _is_already_running_error(e): raise`. Any non-"already-running" SDK error now propagates instead of being silently logged.

---

## 6. `apps/infra-local/configs/minio/init.sh`

Minimal bucket-create + verify:

```sh
#!/bin/sh
set -eu

# Wait briefly for minio to be reachable (Phase 3a relies on depends_on
# healthcheck, so this is a defense in depth)
for i in 1 2 3 4 5; do
    if mc alias set boxlite "$MINIO_URL" "$MINIO_USER" "$MINIO_PASSWORD" 2>/dev/null; then
        break
    fi
    echo "init: minio not ready yet (attempt $i)"
    sleep 2
done

mc alias set boxlite "$MINIO_URL" "$MINIO_USER" "$MINIO_PASSWORD"

# Create a default bucket idempotently — `mc mb` fails if it exists, so ignore.
mc mb --ignore-existing boxlite/boxlite

echo "init: ok — boxlite bucket ready"
```

---

## 7. Test changes

### 7.1 `test_skeleton.py` → `test_multi_service.py`

Renamed and extended. The single test now asserts:

1. `doctor(strict=False)` is clean.
2. `up()` brings all 5 services healthy.
3. `ps()` shows `boxlite-local-postgres`, `boxlite-local-redis`, `boxlite-local-minio`, `boxlite-local-registry` all `running`.
4. `boxlite-local-minio-init` is NOT in `ps` (one-shot already removed).
5. Each service is reachable from the host:
   - postgres: `pg_isready -U boxlite -d boxlite -t 1` inside pg box returns 0
   - redis: `redis-cli -h 127.0.0.1 -p 26379 PING` returns `PONG`
   - minio: `urllib` GET `http://127.0.0.1:29000/minio/health/live` returns 200
   - registry: `urllib` GET `http://127.0.0.1:25000/v2/` returns 200
6. `down(wipe=True)` removes everything; data_dir gone.

The pre-existence guard from Phase 2 stays (`pytest.skip` if any `boxlite-local-*` box exists).

### 7.2 No new unit tests required

`_http_probe` could be unit-tested with a local HTTP server fixture, but the integration test covers it adequately. `_is_already_running_error` is a small predicate; could be unit-tested but YAGNI for 3a.

---

## 8. Acceptance criteria

**Automated:**
- `pytest apps/infra-local/tests/unit -q` → still 16 passed (no regression in existing unit tests)
- `BOXLITE_INTEGRATION=1 pytest apps/infra-local/tests/integration -v -s` → 1 passed (5-service round-trip)

**Manual smoke (I run):**
1. `python -m boxlite_local doctor` — 7 ✓ rows (sdk + runtime + 5 port checks, one per service-port). Exit 0.
2. `python -m boxlite_local up` — all 4 daemon services reach healthy; minio-init runs and exits; returns to prompt.
3. `python -m boxlite_local ps` — 4 rows (postgres, redis, minio, registry); minio-init absent.
4. Reachability spot-checks from host:
   - `redis-cli -h 127.0.0.1 -p 26379 PING` → `PONG`
   - `curl -fs http://127.0.0.1:29000/minio/health/live` → 200
   - `curl -fs http://127.0.0.1:25000/v2/` → 200
   - `psql postgresql://boxlite@127.0.0.1:25432/boxlite -c "SELECT 1"` → `1`
5. `python -m boxlite_local down --wipe` — all 4 boxes gone, `~/.boxlite-local/data/` removed.
6. `python -m boxlite_local up` (re-run) — minio-init runs again (one-shot semantic: not "already done").

---

## 9. Hand-off

After spec is committed, write the implementation plan, then execute via subagent-driven-development. No user gates per autonomy directive.
