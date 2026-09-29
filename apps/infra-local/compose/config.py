"""InfraConfig dataclass — central config for the orchestrator. Pure data + env loading."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path


def find_repo_root_from(here: Path) -> Path:
    """Walk up from `here` to the first dir containing apps/infra-local/.

    `apps` must be a REAL directory: an older version of this tool created an
    `apps/apps -> .` symlink (webpack path quirk), which would otherwise make
    `apps/` itself satisfy the predicate and mis-root all generated state at
    `apps/.apps-local/`. The guard keeps the walk safe on checkouts where
    that symlink still exists.
    """
    for parent in (here, *here.parents):
        apps = parent / "apps"
        if not apps.is_symlink() and (apps / "infra-local" / "pyproject.toml").exists():
            return parent
    raise RuntimeError(
        f"could not locate repo root (no apps/infra-local/pyproject.toml found above {here})"
    )


def _detect_repo_root() -> Path:
    return find_repo_root_from(Path(__file__).resolve().parent)


def _default_state_root() -> Path:
    """Repo-scoped root for local-stack state: <repo>/.apps-local/.

    One gitignored dir holds data volumes, the L1 SDK home, native binaries,
    and L2 logs. The runner home stays under the machine short root. Keeping
    data outside cargo's target/ protects live Postgres volumes from `cargo clean`.
    """
    return _detect_repo_root() / ".apps-local"


def _machine_short_root() -> Path:
    """Overrideable parent for per-worktree runner homes."""
    return Path(os.environ.get("BOXLITE_LOCAL_STATE_ROOT") or (Path.home() / ".bl")).expanduser()


def worktree_home(repo_root: Path, leaf: str) -> Path:
    """Isolate runner homes under a shared root by worktree path hash."""
    tag = hashlib.sha1(str(repo_root).encode()).hexdigest()[:8]
    return _machine_short_root() / tag / leaf


@dataclass
class InfraConfig:
    host_hub: str = "host.boxlite.internal"

    # Credentials (env-overridable; each is genuinely consumed — postgres &
    # minio entrypoints, pgadmin login).
    pg_user: str = "boxlite"
    pg_password: str = field(default="boxlite", repr=False)
    pg_db: str = "boxlite"
    minio_user: str = "minioadmin"
    minio_password: str = field(default="minioadmin", repr=False)
    pgadmin_email: str = "admin@boxlite.dev"
    pgadmin_password: str = field(default="boxlite", repr=False)

    # ── Fixed host ports for the local stack (NOT env-overridable) ──────────
    # Each value is also the literal host port in the matching
    # ServiceSpec.ports in services.py — that literal is what the box actually
    # binds. These named fields exist only so generated configs (the Caddyfile,
    # the minio-init URL, dex_issuer) and the integration tests can reference
    # the same number by name. Changing one of these alone will NOT move the
    # bound port; update the services.py literal too. Ports with no such
    # consumer (postgres, redis, caddy-https, otel-grpc) are left as bare
    # literals in services.py and intentionally have no field here.
    minio_host_port: int = 29000
    registry_host_port: int = 25000
    dex_host_port: int = 25556
    jaeger_host_port: int = 26686
    pgadmin_host_port: int = 25051
    registry_ui_host_port: int = 25052
    maildev_ui_host_port: int = 25053
    caddy_http_port: int = 28080
    otel_http_port: int = 24318
    otel_health_port: int = 23133

    data_dir: Path = field(default_factory=lambda: _default_state_root() / "data")
    # L1 SDK home, separate from the runner's exclusive-lock home. The runtime
    # binds sockets through short /tmp symlinks, so a repo-local home is safe.
    boxlite_home: Path = field(default_factory=lambda: _default_state_root() / ".bl" / "h")
    repo_root: Path = field(default_factory=_detect_repo_root)

    @classmethod
    def load(cls) -> "InfraConfig":
        # Only identity/credential/path fields are env-overridable; host ports
        # are fixed (see the field comment above) and stay at their defaults.
        return cls(
            host_hub=os.environ.get("BOXLITE_HOST_HUB", "host.boxlite.internal"),
            pg_user=os.environ.get("BOXLITE_PG_USER", "boxlite"),
            pg_password=os.environ.get("BOXLITE_PG_PASSWORD", "boxlite"),
            pg_db=os.environ.get("BOXLITE_PG_DB", "boxlite"),
            minio_user=os.environ.get("BOXLITE_MINIO_USER", "minioadmin"),
            minio_password=os.environ.get("BOXLITE_MINIO_PASSWORD", "minioadmin"),
            pgadmin_email=os.environ.get("BOXLITE_PGADMIN_EMAIL", "admin@boxlite.dev"),
            pgadmin_password=os.environ.get("BOXLITE_PGADMIN_PASSWORD", "boxlite"),
            # .expanduser() so a documented value like
            # BOXLITE_DATA_DIR=~/my-data expands the leading ~ instead of
            # creating a literal "~" dir under the cwd.
            data_dir=Path(
                os.environ.get("BOXLITE_DATA_DIR")
                or str(_default_state_root() / "data")
            ).expanduser(),
            # BOXLITE_HOME is the SDK's own env var — respecting it here keeps
            # InfraConfig and a user-pinned SDK home in agreement.
            boxlite_home=Path(
                os.environ.get("BOXLITE_HOME")
                or str(_default_state_root() / ".bl" / "h")
            ).expanduser(),
        )

    @property
    def dex_issuer(self) -> str:
        # NOTE: the issuer is also what dex publishes in its
        # `.well-known/openid-configuration`, which the BROWSER fetches via
        # the dashboard's OIDC flow. The browser can't resolve
        # `host.boxlite.internal` (only resolvable inside boxes via gvproxy
        # DNS), so we publish a `localhost` URL. Trade-off: a FUTURE box->dex
        # flow won't reach `localhost` from inside a box — when that case
        # appears, this issuer should become a `*.boxlite.test` host backed
        # by dns-shim + mkcert (out of current autonomous scope).
        return f"http://localhost:{self.dex_host_port}/dex"
