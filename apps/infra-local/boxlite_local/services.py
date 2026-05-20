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
