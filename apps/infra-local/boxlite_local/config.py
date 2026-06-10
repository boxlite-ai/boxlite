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

    # caddy (3c)
    caddy_http_port: int = 28080
    caddy_https_port: int = 28443

    # otel-collector (3c)
    otel_grpc_port: int = 24317
    otel_http_port: int = 24318
    otel_health_port: int = 23133

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
            caddy_http_port=_parse_int_env("BOXLITE_CADDY_HTTP_PORT", "28080"),
            caddy_https_port=_parse_int_env("BOXLITE_CADDY_HTTPS_PORT", "28443"),
            otel_grpc_port=_parse_int_env("BOXLITE_OTEL_GRPC_PORT", "24317"),
            otel_http_port=_parse_int_env("BOXLITE_OTEL_HTTP_PORT", "24318"),
            otel_health_port=_parse_int_env("BOXLITE_OTEL_HEALTH_PORT", "23133"),
            # .expanduser() so a documented value like
            # BOXLITE_DATA_DIR=~/.boxlite-local/data expands the leading ~
            # instead of creating a literal "~" dir under the cwd.
            data_dir=Path(
                os.environ.get("BOXLITE_DATA_DIR")
                or str(Path.home() / ".boxlite-local" / "data")
            ).expanduser(),
        )

    @property
    def pg_url(self) -> str:
        return f"postgresql://{self.pg_user}@{self.host_hub}:{self.pg_host_port}/{self.pg_db}"

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
