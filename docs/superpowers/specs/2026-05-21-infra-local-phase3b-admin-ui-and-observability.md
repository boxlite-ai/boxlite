# `apps/infra-local/` Phase 3b — Admin UIs + Dex Design

> **Status:** approved (2026-05-21) — autonomous E2E execution authorized
> **Owner:** lile (michael.li@polygala.ai)
> **Parent design:** [`docs/apps/own-dog-food-local-infra-solution.md`](../../apps/own-dog-food-local-infra-solution.md) §10 Phase 3 (decomposed)
> **Prior:** [Phase 3a foundation services spec](2026-05-21-infra-local-phase3a-foundation-services.md) — 5-service stack runs

---

## 1. Background + scope adjustment

3b was originally scoped as "admin UIs + observability" = `pgadmin + registry-ui + jaeger + dex + otel-collector` (5 new services). After researching the repo:

- **`apps/dex/`**: custom Dockerfile = stock `dexidp/dex:v2.42.0` + env-substituted config + entrypoint sed dance. We can deliver dex by using the **stock image** + inlining the entrypoint sed logic in `cmd=["sh","-c",...]` + inlining the config in a Python string. No build mechanism needed.
- **`apps/otel-collector/`**: heavy multi-stage build that compiles a custom Go binary via Nx (`boxlite-otel-collector`). The image only exists by running the full repo build chain (node + go + yarn + nx + multiple workspaces). The SDK has no `build` capability — only `pull` from a registry. To wire this up we'd need a "build + push to boxlite-local-registry + pull" pipeline, which is out of scope for 3b.
- **`jaeger`, `pgadmin`, `registry-ui`**: stock OCI images, straightforward (same pattern as 3a's redis/minio/registry).

**Adjusted 3b scope: 4 services (dex + jaeger + pgadmin + registry-ui).** otel-collector deferred to a follow-up phase ("3d"-ish) that introduces the build pipeline.

3b also closes Phase-2 debt #2 (HealthCheck.exec callable-with-config) opportunistically — none of 3a's services needed it, but pgadmin will need to substitute a real `pg_user`/`pg_db` when introspecting pg, and inlining hardcoded values won't survive `BOXLITE_PG_USER` overrides.

---

## 2. Scope

**In scope:**
- 4 new `ServiceSpec`s: `SPEC_DEX`, `SPEC_JAEGER`, `SPEC_PGADMIN`, `SPEC_REGISTRY_UI`
- New `InfraConfig` fields: `dex_host_port`, `dex_issuer`, `jaeger_host_port`, `pgadmin_host_port`, `pgadmin_email`, `pgadmin_password`, `registry_ui_host_port`
- Inline dex entrypoint shell + inline dex config in `services.py`
- `pgadmin` has `depends_on=["postgres"]` — first multi-layer topo we'll exercise beyond minio-init
- Phase-2 debt #2: widen `HealthCheck.exec` to accept `list[str] | Callable[[InfraConfig], list[str]]`; migrate `SPEC_PG` to the callable form
- Integration test extension: `test_multi_service.py` now asserts 8 daemon boxes + minio-init one-shot completes, all reachable

**Out of scope (explicitly deferred):**
- `otel-collector` — requires build-from-repo pipeline (push to boxlite-local-registry then pull). Schedule for a follow-up phase.
- Caddy reverse proxy + TLS + dns-shim (Phase 3c)
- `HealthCheck.tcp_port` implementation (still no caller in 3b)
- Box-name isolation in tests (still acceptable via `pytest.skip` guard)

**Decisions taken (locked, no user review per autonomy directive):**

| Decision | Choice | Why |
|---|---|---|
| dex image | Stock `dexidp/dex:v2.42.0` | Avoids build mechanism; same dex binary as `apps/dex/Dockerfile` |
| dex config + entrypoint | Inline as Python string in `services.py` | SDK can't mount files; building isn't worth it for one service |
| otel-collector | Deferred | Custom binary build > 3b complexity budget |
| `HealthCheck.exec` widening | Now `list[str] \| Callable[[InfraConfig], list[str]] \| None` | Phase-2 debt #2; pgadmin doesn't need exec-healthcheck but the SPEC_PG migration validates the new shape |
| pgadmin healthcheck | `http_url` on host port | Simpler than internal exec; pgadmin exposes a root index that 200s once initialized |
| jaeger healthcheck | `http_url` on host port (`/`) | Stock jaeger UI returns 200 on root |
| registry-ui healthcheck | `http_url` on host port (`/`) | Stock UI returns 200 on root |
| Host ports | dex=25556, jaeger=26686, pgadmin=25051, registry-ui=25052 | Matches parent design §3.8 |

---

## 3. Service specs

### `SPEC_DEX`

Stock `dexidp/dex:v2.42.0`. Custom entrypoint inlined to do env-substitution on the config we also inline. The image's default ENTRYPOINT is `/usr/local/bin/dex`, so we override.

```python
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
sed -i "s|\\${DEX_ISSUER}|${DEX_ISSUER:-http://localhost:5556/dex}|g" /tmp/dex-config.yaml
sed -i "s|\\${REDIRECT_URI}|${REDIRECT_URI:-http://localhost:3000}|g" /tmp/dex-config.yaml
exec /usr/local/bin/dex serve /tmp/dex-config.yaml
"""

SPEC_DEX = ServiceSpec(
    name="dex",
    image="dexidp/dex:v2.42.0",
    cpus=1, memory_mib=256,
    ports=[(25556, 5556)],
    env=lambda cfg: {
        "DEX_ISSUER": cfg.dex_issuer,
        "REDIRECT_URI": "http://localhost:3000",
    },
    depends_on=[],
    entrypoint=["sh"],
    cmd=["-c", _DEX_ENTRYPOINT],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:25556/dex/.well-known/openid-configuration",
        retries=30,
    ),
)
```

### `SPEC_JAEGER`

```python
SPEC_JAEGER = ServiceSpec(
    name="jaeger",
    image="jaegertracing/all-in-one:1.67.0",
    cpus=1, memory_mib=512,
    ports=[(26686, 16686)],   # UI; we don't expose OTLP ports until a real producer is wired
    env=lambda cfg: {
        # In-memory storage (default for all-in-one)
        "COLLECTOR_OTLP_ENABLED": "true",
    },
    depends_on=[],
    healthcheck=HealthCheck(http_url="http://127.0.0.1:26686/", retries=30),
)
```

### `SPEC_PGADMIN`

```python
SPEC_PGADMIN = ServiceSpec(
    name="pgadmin",
    image="dpage/pgadmin4:9.2.0",
    cpus=1, memory_mib=512,
    ports=[(25051, 80)],
    env=lambda cfg: {
        "PGADMIN_DEFAULT_EMAIL": cfg.pgadmin_email,
        "PGADMIN_DEFAULT_PASSWORD": cfg.pgadmin_password,
        # Disable initial setup wizard so probes don't hit redirects forever
        "PGADMIN_CONFIG_SERVER_MODE": "False",
        "PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED": "False",
    },
    depends_on=["postgres"],
    healthcheck=HealthCheck(http_url="http://127.0.0.1:25051/misc/ping", retries=60),
)
```

### `SPEC_REGISTRY_UI`

```python
SPEC_REGISTRY_UI = ServiceSpec(
    name="registry-ui",
    image="joxit/docker-registry-ui:main",
    cpus=1, memory_mib=128,
    ports=[(25052, 80)],
    env=lambda cfg: {
        # Points UI at the registry over the host hub
        "REGISTRY_TITLE": "BoxLite local registry",
        "NGINX_PROXY_PASS_URL": f"http://{cfg.host_hub}:{cfg.registry_host_port}",
        "SINGLE_REGISTRY": "true",
    },
    depends_on=["registry"],
    healthcheck=HealthCheck(http_url="http://127.0.0.1:25052/", retries=30),
)
```

### `SERVICES` registry

```python
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

9 services total. topo_sort layers: `[postgres, redis, minio, registry, dex, jaeger]` (parallel), `[minio-init, pgadmin, registry-ui]` (depends_on).

---

## 4. `InfraConfig` extensions

```python
@dataclass
class InfraConfig:
    # ... existing fields (host_hub, pg_*, redis, minio, registry, data_dir, repo_root) ...

    # dex (3b)
    dex_host_port: int = 25556

    @property
    def dex_issuer(self) -> str:
        return f"http://{self.host_hub}:{self.dex_host_port}/dex"

    # jaeger (3b)
    jaeger_host_port: int = 26686

    # pgadmin (3b)
    pgadmin_host_port: int = 25051
    pgadmin_email: str = "admin@boxlite.dev"
    pgadmin_password: str = field(default="boxlite", repr=False)

    # registry-ui (3b)
    registry_ui_host_port: int = 25052
```

`load()` reads matching `BOXLITE_*` env vars with `_parse_int_env` for the ports.

---

## 5. Phase-2 debt #2 — `HealthCheck.exec` callable-with-config

### types.py

```python
@dataclass
class HealthCheck:
    exec: Optional[list[str] | Callable[["InfraConfig"], list[str]]] = None
    # ... tcp_port, http_url, etc. unchanged ...
```

### orchestrator.py `_wait_healthy_exec`

```python
async def _wait_healthy_exec(box, hc: HealthCheck, *, label: str, config: InfraConfig) -> None:
    raw = hc.exec
    cmd_list: list[str] = raw(config) if callable(raw) else raw
    cmd, *args = cmd_list
    # ... rest unchanged ...
```

`wait_healthy` gains a `config` keyword to pass through.

### services.py SPEC_PG migration

```python
SPEC_PG = ServiceSpec(
    ...
    healthcheck=HealthCheck(
        exec=lambda cfg: ["pg_isready", "-U", cfg.pg_user, "-d", cfg.pg_db, "-t", "1"],
        ...
    ),
)
```

This is the only existing exec-healthcheck migration. Redis still uses the literal-list form (`["redis-cli", "PING"]`) because it doesn't need config injection. Both forms remain supported.

---

## 6. `_wait_one_shot_exit` adjustment

The new `_wait_one_shot_exit` from 3a polls `box.exec("true")` to detect init exit. With pgadmin added (long startup), it's worth confirming the timeout is sufficient. Spec stays at 60s — pgadmin is a daemon, not a one-shot, so this doesn't affect it.

No new mechanisms in 3b's orchestrator beyond plumbing `config` through `wait_healthy`/`_wait_healthy_exec`.

---

## 7. Tests

### Unit

- `test_config.py`: add tests for the 4 new fields + env overrides + `dex_issuer` property derivation.
- `test_orchestrator.py`: add a test for `_wait_healthy_exec`'s callable-vs-list dispatch using a fake box that records the resolved cmd.

### Integration

`test_multi_service.py` extended:
- `_DAEMON_SERVICES` grows to all 8 daemons (pg/redis/minio/registry/dex/jaeger/pgadmin/registry-ui)
- Per-service reachability:
  - dex: `urllib` GET `http://127.0.0.1:25556/dex/.well-known/openid-configuration` → 200 + body contains `"issuer"`
  - jaeger: `urllib` GET `http://127.0.0.1:26686/` → 200
  - pgadmin: `urllib` GET `http://127.0.0.1:25051/misc/ping` → 200
  - registry-ui: `urllib` GET `http://127.0.0.1:25052/` → 200

---

## 8. Acceptance criteria

**Automated:**
- `pytest apps/infra-local/tests/unit -q` → all green (count grows by ~5 tests over 3a's 26)
- `BOXLITE_INTEGRATION=1 pytest apps/infra-local/tests/integration -v -s` → 1 passed (9-service round-trip including minio-init)

**Manual smoke (I run):**
- `python -m boxlite_local doctor` → 12+ ✓ rows (sdk + runtime + all unique ports)
- `python -m boxlite_local up` → all 8 daemons healthy + minio-init runs + exits
- `python -m boxlite_local ps` → 8 rows running, no minio-init
- Reachability spot-checks: pg / redis / minio / registry / dex (well-known) / jaeger (UI) / pgadmin (/misc/ping) / registry-ui (/)
- `python -m boxlite_local down --wipe` → clean tear-down
- Re-up confirms idempotent minio-init and pgadmin layering (pgadmin starts after pg healthy)

---

## 9. Hand-off

After spec is committed, write the 3b plan, then execute via subagent-driven-development. No user gates per autonomy directive.
