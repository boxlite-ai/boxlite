"""InfraConfig dataclass — central config for the orchestrator. Pure data + env loading."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path


def _platform_runtime_cache_dir() -> Path:
    """Directory the BoxLite SDK extracts its embedded runtime into.

    Mirrors the Rust `dirs::data_local_dir()` the SDK uses: macOS →
    ~/Library/Application Support, Linux → $XDG_DATA_HOME or ~/.local/share.
    """
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        xdg = os.environ.get("XDG_DATA_HOME")
        base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "boxlite" / "runtimes"


def pick_runtime_dir(runtimes_dir: Path, version: str | None) -> Path | None:
    """Pick a usable extracted runtime: a `v{version}[-{hash}]` dir that actually
    contains the `boxlite-guest` binary. Pure (no env/global reads) for testability.

    Skips dirs that carry a `.complete` stamp but are missing `boxlite-guest`
    (a partial or REST-only extraction the SDK's fast path would wrongly trust
    and then fail on at `box.start()`). Prefers the hashless release dir, then
    the most-recently-used.
    """
    if not runtimes_dir.is_dir():
        return None
    usable: list[Path] = []
    for d in runtimes_dir.iterdir():
        if not d.is_dir() or not d.name.startswith("v"):
            continue
        if version and not (d.name == f"v{version}" or d.name.startswith(f"v{version}-")):
            continue
        if not (d / "boxlite-guest").is_file():
            continue
        usable.append(d)
    if not usable:
        return None
    # Hashless release ("v1.2.3") before debug ("v1.2.3-hash"); then newest mtime.
    usable.sort(key=lambda d: ("-" in d.name, -d.stat().st_mtime))
    return usable[0]


def resolve_runtime_dir() -> Path | None:
    """A complete extracted runtime to pin via BOXLITE_RUNTIME_DIR, or None.

    Returns None (leave the SDK's own resolution untouched) when the user already
    set BOXLITE_RUNTIME_DIR. Otherwise locates a `boxlite-guest`-bearing cache dir
    matching the installed SDK version — working around a stale/partial embedded
    cache, or an SDK installed from another worktree without an embedded guest,
    which the SDK would otherwise fail on at box start.
    """
    if os.environ.get("BOXLITE_RUNTIME_DIR"):
        return None
    try:
        import boxlite

        version = getattr(boxlite, "__version__", None)
    except Exception:
        version = None
    return pick_runtime_dir(_platform_runtime_cache_dir(), version)


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
    # singleton is built — see orchestrator.ensure_home_env). Separate from the
    # runner's home (.apps-local/boxlite-runner): each BoxliteRuntime takes an
    # exclusive lock on its home dir.
    boxlite_home: Path = field(default_factory=lambda: _default_state_root() / "boxlite")
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
                or str(_default_state_root() / "boxlite")
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
