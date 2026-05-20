"""InfraConfig dataclass — central config for the orchestrator. Pure data + env loading."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class InfraConfig:
    # host-hub address — inside-box reaches host via this name (Docker host.docker.internal equivalent)
    host_hub: str = "host.boxlite.internal"

    # postgres
    pg_host_port: int = 25432
    pg_user: str = "boxlite"
    pg_password: str = "boxlite"
    pg_db: str = "boxlite"

    # persistent data root (per-service subdirs are computed)
    data_dir: Path = field(default_factory=lambda: Path.home() / ".boxlite-local" / "data")

    @classmethod
    def load(cls) -> "InfraConfig":
        return cls(
            host_hub=os.environ.get("BOXLITE_HOST_HUB", "host.boxlite.internal"),
            pg_host_port=int(os.environ.get("BOXLITE_PG_HOST_PORT", "25432")),
            pg_user=os.environ.get("BOXLITE_PG_USER", "boxlite"),
            pg_password=os.environ.get("BOXLITE_PG_PASSWORD", "boxlite"),
            pg_db=os.environ.get("BOXLITE_PG_DB", "boxlite"),
            data_dir=Path(
                os.environ.get("BOXLITE_DATA_DIR")
                or str(Path.home() / ".boxlite-local" / "data")
            ),
        )

    @property
    def pg_url(self) -> str:
        return f"postgresql://{self.pg_user}@{self.host_hub}:{self.pg_host_port}/{self.pg_db}"
