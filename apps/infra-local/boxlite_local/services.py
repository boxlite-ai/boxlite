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
    # Inline cmd - SDK rejects file-mounts (host path must be a directory).
    # The script body is the same as apps/infra-local/configs/minio/init.sh
    # (kept on disk as documentation but not mounted into the box).
    cmd=["sh", "-c", _MINIO_INIT_SCRIPT],
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


SERVICES: dict[str, ServiceSpec] = {
    "postgres":   SPEC_PG,
    "redis":      SPEC_REDIS,
    "minio":      SPEC_MINIO,
    "minio-init": SPEC_MINIO_INIT,
    "registry":   SPEC_REGISTRY,
}
