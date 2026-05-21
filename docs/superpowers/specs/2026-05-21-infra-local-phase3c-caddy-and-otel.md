# `apps/infra-local/` Phase 3c — Caddy + otel-collector Design

> **Status:** approved (2026-05-21) — autonomous E2E execution
> **Parent design:** `docs/apps/own-dog-food-local-infra-solution.md` §10 Phase 3
> **Prior:** [Phase 3b spec](2026-05-21-infra-local-phase3b-admin-ui-and-observability.md) — 9-service stack runs

---

## 1. Background + scope

3b shipped 9 services. 3c finishes the parent-design "10-box" target by adding:

1. **Caddy reverse proxy** with self-signed TLS (Caddy's `internal` issuer), routing to all upstream services via path prefixes (`/pgadmin/`, `/jaeger/`, `/dex/`, `/minio/`, `/registry-ui/`, etc.)
2. **otel-collector** with **stock `otel/opentelemetry-collector:latest`** + a minimal OTLP-receiver + logging-exporter config (a placeholder for the boxlite-custom collector that lives in `apps/otel-collector/` — building that requires the full repo nx/go/node toolchain, deferred indefinitely as "infra-local" doesn't own that build pipeline)

**Pragmatic deferrals (not "infra-local complete", but blocked):**

- **dns-shim** for `*.boxlite.test → 127.0.0.1`: needs system-level DNS hijack (`/etc/resolver/` write, port 53 bind, or `launchd` setup) — all require root. Without it, users access services via `https://localhost:28443/<path>` not `https://pgadmin.boxlite.test`. Documented as a known limitation; user can `sudo` later.
- **Caddy on 80/443**: host port 80 is taken by Docker Desktop on this Mac, and 443 requires root. Caddy uses **28080/28443** instead. Documented.
- **mkcert CA install**: needs `mkcert -install` with sudo to write to system trust store. Using Caddy's `internal` issuer instead — self-signed; browser shows "untrusted" warning once but works.
- **Custom otel-collector binary**: requires building from `apps/otel-collector/Dockerfile` via docker. Out of "infra-local" scope.
- **Lima runner integration** (parent design Phase 4): different concern, separate infrastructure.

---

## 2. Scope

**In:**
- `SPEC_CADDY` + inline Caddyfile (path-based routing, `tls internal`)
- `SPEC_OTEL` + minimal otel config
- 5 new `InfraConfig` fields (caddy_http_port, caddy_https_port, otel_grpc_port, otel_http_port, otel_health_port)
- Integration test: extends to 11-box round-trip + asserts Caddy serves at least one upstream via HTTPS

**Out:**
- dns-shim (root)
- mkcert CA install (root)
- Custom otel-collector binary build
- Lima runner

**Decisions (locked):**

| Decision | Choice | Why |
|---|---|---|
| Caddy host ports | 28080 / 28443 | 80/443 unavailable without sudo (and 80 is taken by Docker) |
| Caddy TLS issuer | `internal` (Caddy self-signed) | mkcert install needs sudo |
| Caddy → upstream routing | Path-based (`/pgadmin/*` etc.) | No DNS hijack; can't do host-based without `*.boxlite.test` |
| Caddy EXPOSE port mapping | All 3 (80, 443, 2019) mapped explicitly | Same SDK auto-bind trap as pgadmin in 3b |
| otel-collector image | Stock `otel/opentelemetry-collector:latest` | Custom binary build out of scope |
| otel config | Inline minimal (OTLP receiver + `debug` exporter + `health_check` extension) | Just enough to validate the box runs |

---

## 3. Service specs

### `SPEC_OTEL`

```python
_OTEL_CONFIG = """\
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

exporters:
  debug:
    verbosity: basic

extensions:
  health_check:
    endpoint: 0.0.0.0:13133

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [otlp]
      exporters: [debug]
"""

_OTEL_ENTRYPOINT = """\
set -e
cat > /tmp/otel-config.yaml <<'__CFG__'
""" + _OTEL_CONFIG + """\
__CFG__
exec /otelcol --config /tmp/otel-config.yaml
"""

SPEC_OTEL = ServiceSpec(
    name="otel",
    image="otel/opentelemetry-collector:latest",
    cpus=1, memory_mib=256,
    # OTEL image EXPOSEs 4317 (gRPC), 4318 (HTTP), 13133 (health). All non-priv,
    # so the SDK auto-bind doesn't trigger the 3b bug, but we map them explicitly
    # to non-default host ports for cleanliness + consistency with parent §3.8.
    ports=[
        (24317, 4317),   # OTLP gRPC
        (24318, 4318),   # OTLP HTTP
        (23133, 13133),  # health_check
    ],
    entrypoint=["sh"],
    cmd=["-c", _OTEL_ENTRYPOINT],
    depends_on=[],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:23133/",
        retries=30,
    ),
)
```

### `SPEC_CADDY`

```python
def _caddyfile(cfg: "InfraConfig") -> str:
    """Inline Caddyfile body. Path-based routing because we don't have DNS hijack."""
    return f"""\
{{
    auto_https off
}}

:80 {{
    redir https://{{host}}{{uri}} permanent
}}

:443 {{
    tls internal

    # Each upstream is reverse-proxied under a path prefix. Caddy strips the
    # prefix before forwarding; upstream services see the bare path.
    handle_path /pgadmin/* {{
        reverse_proxy {cfg.host_hub}:{cfg.pgadmin_host_port}
    }}
    handle_path /jaeger/* {{
        reverse_proxy {cfg.host_hub}:{cfg.jaeger_host_port}
    }}
    handle_path /dex/* {{
        reverse_proxy {cfg.host_hub}:{cfg.dex_host_port}
    }}
    handle_path /minio-console/* {{
        reverse_proxy {cfg.host_hub}:29001
    }}
    handle_path /minio/* {{
        reverse_proxy {cfg.host_hub}:{cfg.minio_host_port}
    }}
    handle_path /registry-ui/* {{
        reverse_proxy {cfg.host_hub}:{cfg.registry_ui_host_port}
    }}
    handle_path /registry/* {{
        reverse_proxy {cfg.host_hub}:{cfg.registry_host_port}
    }}

    # Index page lists the routes.
    handle / {{
        respond `boxlite-local Caddy reverse proxy

routes:
  /pgadmin/        -> pgadmin
  /jaeger/         -> jaeger
  /dex/            -> dex (OIDC)
  /minio/          -> minio S3 API
  /minio-console/  -> minio console UI
  /registry-ui/    -> registry UI
  /registry/       -> docker registry v2
`
    }}
}}
"""


_CADDY_ENTRYPOINT_TEMPLATE = """\
set -e
cat > /etc/caddy/Caddyfile <<'__CFG__'
{caddyfile}
__CFG__
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
"""


def _caddy_cmd(cfg: "InfraConfig") -> list[str]:
    body = _CADDY_ENTRYPOINT_TEMPLATE.format(caddyfile=_caddyfile(cfg))
    return ["-c", body]


SPEC_CADDY = ServiceSpec(
    name="caddy",
    image="caddy:2-alpine",
    cpus=1, memory_mib=256,
    # caddy:2-alpine EXPOSEs 80, 443, 2019. Map ALL of them explicitly per
    # the SDK auto-bind workaround (see SPEC_PGADMIN comment). 80/443 → our
    # non-priv host ports because the privileged ones aren't bindable without
    # sudo; 2019 (admin API) → a high host port we don't expect users to touch.
    ports=[
        (28080, 80),    # HTTP (redirects to HTTPS)
        (28443, 443),   # HTTPS reverse proxy
        (12019, 2019),  # Caddy admin API
    ],
    entrypoint=["sh"],
    cmd=lambda cfg: ["-c", _CADDY_ENTRYPOINT_TEMPLATE.format(caddyfile=_caddyfile(cfg))],
    depends_on=["dex", "jaeger", "pgadmin", "minio", "registry", "registry-ui"],
    healthcheck=HealthCheck(
        # /config/ is Caddy's admin API; returns 200 once config is loaded
        http_url="http://127.0.0.1:12019/config/",
        retries=30,
    ),
)
```

> Note the `cmd=lambda cfg: ...` shape. ServiceSpec's `cmd` was a fixed `list[str]`; we extend it to also accept a `Callable[[InfraConfig], list[str]]` for this case. Tiny widening, parallel to `env` / `volumes` / `healthcheck.exec`.

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
    "otel":        SPEC_OTEL,
    "caddy":       SPEC_CADDY,
}
```

11 entries (10 daemons + 1 one-shot). topo: caddy is last layer.

---

## 4. `InfraConfig` extensions

```python
caddy_http_port: int = 28080
caddy_https_port: int = 28443
otel_grpc_port: int = 24317
otel_http_port: int = 24318
otel_health_port: int = 23133
```

Plus matching `BOXLITE_*` env-var overrides in `.load()`.

---

## 5. Types + orchestrator changes

Widen `ServiceSpec.cmd`:

```python
cmd: Optional[list[str] | Callable[["InfraConfig"], list[str]]] = None
```

`build_box_options` / `_build_box_options_with_volumes` resolves the callable:

```python
resolved_cmd = spec.cmd(config) if callable(spec.cmd) else spec.cmd
```

That's it for the orchestrator — Caddy and Otel use the existing http_url healthcheck path.

---

## 6. Tests

### Unit

- `test_config.py`: + 5 default checks + env override + Caddy ports + otel ports
- `test_orchestrator.py`: + 1 test that `build_box_options` resolves `cmd` callable

### Integration

`test_multi_service.py`: extend to 11-service round-trip + verify Caddy reverse proxies work via HTTPS (use `urllib.request` with an unverified SSL context since Caddy uses self-signed cert).

---

## 7. Acceptance

- `pytest apps/infra-local/tests/unit -q` → all green (count ~36)
- `BOXLITE_INTEGRATION=1 pytest apps/infra-local/tests/integration -v -s` → 1 passed
- `python -m boxlite_local up` → all 10 daemons + minio-init
- `curl -kfsS https://127.0.0.1:28443/jaeger/` → 200 (HTML containing "Jaeger")
- Same for `/pgadmin/`, `/minio/health/live`, `/registry/v2/`, etc.
