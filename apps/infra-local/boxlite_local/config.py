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
