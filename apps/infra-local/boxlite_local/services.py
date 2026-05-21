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
    # The pgadmin4 image EXPOSEs 80 AND 443. The SDK auto-binds every
    # EXPOSE'd guest port to the same host port unless we map it explicitly;
    # auto-binding 443 on the host fails (privileged) and the whole port
    # forwarding setup silently breaks. Explicitly mapping 443 → an unused
    # high port short-circuits the auto-bind and restores the 80 → host forward.
    ports=[(25051, 80), (25053, 443)],     # 25053 is a placeholder for the 443 EXPOSE
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
