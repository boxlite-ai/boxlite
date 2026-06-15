"""Declarative registry of services the orchestrator manages.

10 daemon boxes + 1 one-shot bootstrap:
  postgres, redis, minio (+ minio-init one-shot), registry, dex, jaeger,
  pgadmin, registry-ui, otel-collector, caddy.

otel-collector runs the upstream `otel/opentelemetry-collector` image and
forwards traces to the jaeger box; see `_otel_config()`. caddy is the
unified reverse proxy; see `_caddyfile()`.
"""

from __future__ import annotations

from .types import HealthCheck, ServiceSpec


SPEC_PG = ServiceSpec(
    name="postgres",
    # Pinned to PG 17 to match prod (RDS boxlite-dev runs 17.9).
    image="postgres:17-alpine",
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
    # Server-side resilience against the microVM↔host transport silently
    # wedging a connection mid-query. Without this, a wedged backend stays
    # `active` forever holding a connection, and the API's per-10s lifecycle
    # crons accumulate stuck backends until the pool is exhausted and the
    # dashboard hangs. These reap the orphaned server backend so it doesn't
    # leak. The client side is deliberately left unprotected to keep apps/
    # unmodified: a wedged API pool connection may hold its slot until
    # `make stack-restart COMPONENTS=api`. Root fix belongs in the transport.
    #   - statement_timeout: cap any single query at 30s.
    #   - tcp_keepalives_*: detect a dead peer (~60s) and close the backend.
    # "postgres" as first arg keeps docker-entrypoint.sh's init (initdb/seed).
    cmd=lambda cfg: [
        "postgres",
        "-c", "statement_timeout=30000",
        "-c", "idle_in_transaction_session_timeout=60000",
        "-c", "tcp_keepalives_idle=30",
        "-c", "tcp_keepalives_interval=10",
        "-c", "tcp_keepalives_count=3",
    ],
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
  # Normal (non-admin) test user. Password is 'password'.
  # OIDC sub on first login = CgQ1Njc4EgVsb2NhbA (base64 of
  # protobuf-encoded {userID:'5678', connectorID:'local'}).
  # API auto-creates the corresponding `user` row + Personal organization
  # + organization_user owner-of-own-org on first login via jwt.strategy.
  - email: 'test01@boxlite.dev'
    hash: '$2a$10$SihmD3KSn9pNA02TCkvTBe1EzYCog6bcf8ztMcI1m4rIGtJIV47ge'
    username: 'test01'
    userID: '5678'
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


# Jaeger's OTLP gRPC receiver, host-mapped so the otel-collector box can
# reach it via host-as-hub (host.boxlite.internal:<this>). Jaeger 1.67
# all-in-one with COLLECTOR_OTLP_ENABLED=true listens for OTLP on :4317
# (gRPC) / :4318 (HTTP) inside the box. Module-level constant because
# ServiceSpec.ports is a static list (can't reference cfg) and the otel
# config below needs the same value.
_JAEGER_OTLP_GRPC_PORT = 26687

SPEC_JAEGER = ServiceSpec(
    name="jaeger",
    image="jaegertracing/all-in-one:1.67.0",
    cpus=1,
    memory_mib=512,
    ports=[
        (26686, 16686),                    # Jaeger UI
        (_JAEGER_OTLP_GRPC_PORT, 4317),    # OTLP gRPC receiver (fed by the otel collector)
    ],
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
        # Force IPv4 bind (image default is [::]:80 dual-stack).
        "PGADMIN_LISTEN_ADDRESS": "0.0.0.0",
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
    memory_mib=256,            # 128 OOMs during nginx-alpine entrypoint init
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
        retries=90,                        # nginx-alpine entrypoint takes 60-90s
    ),
)


# ─── 3c services ──────────────────────────────────────────────────────────

def _otel_config(cfg) -> str:
    """otel-collector config. Receives OTLP and fans out:

    - traces  → debug (stdout) + the jaeger box, so the Jaeger UI at
                http://127.0.0.1:26686 actually shows traces. The jaeger
                hop goes through host-as-hub (a separate box) and targets
                jaeger's host-mapped OTLP gRPC port.
    - metrics → debug only (jaeger doesn't ingest metrics)
    - logs    → debug only (jaeger doesn't ingest logs)
    """
    return f"""\
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
  otlp/jaeger:
    endpoint: {cfg.host_hub}:{_JAEGER_OTLP_GRPC_PORT}
    tls:
      insecure: true

extensions:
  health_check:
    endpoint: 0.0.0.0:13133

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug, otlp/jaeger]
    metrics:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [otlp]
      exporters: [debug]
"""

SPEC_OTEL = ServiceSpec(
    name="otel",
    image="otel/opentelemetry-collector:latest",
    cpus=1,
    memory_mib=256,
    # All EXPOSE'd ports are non-priv (4317, 4318, 13133, 8888), so the SDK
    # auto-bind doesn't hit the privileged-port bug — but we map explicitly
    # for cleanliness + parent design §3.8 consistency.
    ports=[
        (24317, 4317),    # OTLP gRPC
        (24318, 4318),    # OTLP HTTP
        (23133, 13133),   # health_check
    ],
    # The otelcol image is distroless — no shell. Pass config via env var
    # using `--config=env:OTEL_CONFIG` (supported since otel-collector v0.79.0).
    # Image entrypoint is `/otelcol`; cmd becomes its argv.
    env=lambda cfg: {"OTEL_CONFIG": _otel_config(cfg)},
    cmd=["--config=env:OTEL_CONFIG"],
    # jaeger must be up first — the traces pipeline exports to it.
    depends_on=["jaeger"],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:23133/",
        interval_s=2.0,
        retries=30,
    ),
)


def _caddyfile(cfg) -> str:
    """Inline Caddyfile body. Path-based routing on plain HTTP.

    TLS (`tls internal`) is intentionally NOT used because Caddy's internal
    issuer can't mint certs for raw IP addresses (`127.0.0.1`), and we don't
    have DNS hijack yet (no `*.boxlite.test`). Once dns-shim lands, switch
    `:80` block below to `*.boxlite.test:443 { tls internal ... }` and add
    redir back.
    """
    return f"""\
{{
\tauto_https off
\tadmin 0.0.0.0:2019
}}

:80 {{
\t# Box port-preview proxy: hostnames look like `<port>-<token>.localhost:28080`.
\t# The dashboard's terminal iframe loads URLs in this shape (returned by
\t# `/api/box/:boxIdOrName/ports/:port/signed-preview-url`). Forward any host that
\t# starts with `<digits>-` to the apps/proxy service on the host (port 4000),
\t# which resolves the token → box → runner and proxies through.
\t@signed_port_preview_host header_regexp Host ^[0-9]+-[a-z0-9]+\\.
\thandle @signed_port_preview_host {{
\t\treverse_proxy {cfg.host_hub}:4000 {{
\t\t\theader_up Host {{http.request.host}}
\t\t}}
\t}}
\thandle_path /pgadmin/* {{
\t\treverse_proxy {cfg.host_hub}:{cfg.pgadmin_host_port}
\t}}
\thandle_path /jaeger/* {{
\t\treverse_proxy {cfg.host_hub}:{cfg.jaeger_host_port}
\t}}
\thandle_path /dex/* {{
\t\treverse_proxy {cfg.host_hub}:{cfg.dex_host_port}
\t}}
\thandle_path /minio-console/* {{
\t\treverse_proxy {cfg.host_hub}:29001
\t}}
\thandle_path /minio/* {{
\t\treverse_proxy {cfg.host_hub}:{cfg.minio_host_port}
\t}}
\thandle_path /registry-ui/* {{
\t\treverse_proxy {cfg.host_hub}:{cfg.registry_ui_host_port}
\t}}
\thandle_path /registry/* {{
\t\treverse_proxy {cfg.host_hub}:{cfg.registry_host_port}
\t}}

\thandle / {{
\t\trespond `boxlite-local Caddy reverse proxy

routes:
  /pgadmin/        -> pgadmin
  /jaeger/         -> jaeger
  /dex/            -> dex (OIDC)
  /minio/          -> minio S3 API
  /minio-console/  -> minio console UI
  /registry-ui/    -> registry UI
  /registry/       -> docker registry v2
`
\t}}
}}
"""


_CADDY_ENTRYPOINT_TEMPLATE = """\
set -e
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<'__CFG__'
{caddyfile}
__CFG__
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
"""


SPEC_CADDY = ServiceSpec(
    name="caddy",
    image="caddy:2-alpine",
    cpus=1,
    memory_mib=256,
    ports=[
        (28080, 80),
        (28443, 443),    # reserved for future `tls internal` (see README §TLS)
        (12019, 2019),   # Caddy admin API — used by the healthcheck below
    ],
    entrypoint=["sh"],
    cmd=lambda cfg: ["-c", _CADDY_ENTRYPOINT_TEMPLATE.format(caddyfile=_caddyfile(cfg))],
    depends_on=["dex", "jaeger", "pgadmin", "minio", "registry", "registry-ui"],
    healthcheck=HealthCheck(
        # Caddy admin API on :2019/config/ returns 200 once config loaded.
        http_url="http://127.0.0.1:12019/config/",
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
    "otel":        SPEC_OTEL,
    "caddy":       SPEC_CADDY,
}
