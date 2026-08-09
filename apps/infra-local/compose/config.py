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
    """Repo-scoped root for ALL generated local-stack state: <repo>/.apps-local/.

    One gitignored dir holds the data volumes, the L1 SDK home, the runner
    home, the native binaries, and the L2 logs — discoverable footprint,
    per-checkout isolation, and deliberately NOT under cargo's target/ so a
    `cargo clean` can never delete a live Postgres volume.
    """
    return _detect_repo_root() / ".apps-local"


def _machine_short_root() -> Path:
    """Machine-global parent for socket-bearing BoxLite homes.

    A box's control sockets live at <home>/boxes/<id>/sockets/ready.sock, and
    macOS caps unix socket paths at 104 bytes (SUN_LEN). A repo-scoped home
    under a deep worktree path (…/boxlite-wt/<name>/.apps-local/boxlite) blows
    that budget, so EVERY worktree past a short prefix fails to boot a box.

    Anchoring the socket-bearing home here — short and constant (~/.bl) — keeps
    any worktree, however deep, comfortably under the cap. Override with
    BOXLITE_LOCAL_STATE_ROOT.
    """
    return Path(os.environ.get("BOXLITE_LOCAL_STATE_ROOT") or (Path.home() / ".bl")).expanduser()


def worktree_home(repo_root: Path, leaf: str) -> Path:
    """Per-worktree socket-bearing home under the machine-global short root.

    Keyed by a short hash of the worktree path so each checkout is isolated
    (every BoxliteRuntime takes an exclusive flock on its home). `leaf`
    separates the L1 SDK home ("h") from the runner home ("r") — distinct
    runtimes that must not share a home/flock.
    """
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
    caddy_http_port: int = 28080
    otel_http_port: int = 24318
    otel_health_port: int = 23133

    data_dir: Path = field(default_factory=lambda: _default_state_root() / "data")
    # SDK home for the L1 boxes (exported as BOXLITE_HOME before the runtime
    # singleton is built — see orchestrator.ensure_home_env). Anchored at the
    # machine-global short root (NOT under the deep worktree path) so box
    # sockets stay under the macOS SUN_LEN cap — see worktree_home(). Separate
    # from the runner's home (…/r): each BoxliteRuntime flocks its own home.
    boxlite_home: Path = field(default_factory=lambda: worktree_home(_detect_repo_root(), "h"))
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
                or str(worktree_home(_detect_repo_root(), "h"))
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
