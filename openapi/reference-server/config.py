"""Configuration parsing helpers for the BoxLite reference server."""

from __future__ import annotations

import argparse
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from dotenv import load_dotenv

# Server env vars
ENV_SERVER_HOST = "BOXLITE_SERVER_HOST"
ENV_SERVER_PORT = "BOXLITE_SERVER_PORT"
ENV_SERVER_LOG_LEVEL = "BOXLITE_SERVER_LOG_LEVEL"
ENV_SERVER_JWT_SECRET = "BOXLITE_SERVER_JWT_SECRET"
ENV_SERVER_JWT_EXPIRY_SECONDS = "BOXLITE_SERVER_JWT_EXPIRY_SECONDS"
ENV_SERVER_CLIENT_ID = "BOXLITE_SERVER_CLIENT_ID"
ENV_SERVER_CLIENT_SECRET = "BOXLITE_SERVER_CLIENT_SECRET"

# Runtime env vars (reference-server local contract)
ENV_RUNTIME_HOME_DIR = "BOXLITE_RUNTIME_HOME_DIR"
ENV_RUNTIME_IMAGE_REGISTRIES = "BOXLITE_RUNTIME_IMAGE_REGISTRIES"

DEFAULT_SERVER_HOST = "0.0.0.0"
DEFAULT_SERVER_PORT = 8080
DEFAULT_SERVER_LOG_LEVEL = "info"
DEFAULT_SERVER_JWT_SECRET = "boxlite-reference-server-secret"
DEFAULT_SERVER_JWT_EXPIRY_SECONDS = 3600
DEFAULT_SERVER_CLIENT_ID = "test-client"
DEFAULT_SERVER_CLIENT_SECRET = "test-secret"
DEFAULT_RUNTIME_IMAGE_REGISTRIES = ["mirror.gcr.io", "docker.io"]
DEFAULT_ENV_FILE_PATH = Path(__file__).resolve().parent / ".env"

_ALLOWED_LOG_LEVELS = {
    "critical",
    "error",
    "warning",
    "warn",
    "info",
    "debug",
    "trace",
}


@dataclass(frozen=True)
class ServerConfig:
    host: str
    port: int
    log_level: str
    jwt_secret: str
    jwt_expiry_seconds: int
    client_id: str
    client_secret: str


@dataclass(frozen=True)
class RuntimeConfig:
    home_dir: str
    image_registries: list[str]


def default_runtime_home_dir() -> str:
    try:
        home_dir = Path.home()
    except RuntimeError:
        home_dir = Path(".").resolve()
    return str(home_dir / ".boxlite")


def parse_bootstrap_env_file(argv: Sequence[str] | None = None) -> str | None:
    """Parse only --env-file before loading environment defaults."""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--env-file", default=None)
    args, _ = parser.parse_known_args(argv)
    return args.env_file


def load_env_file(env_file: str | None) -> Path | None:
    """Load .env without overriding existing process env vars."""
    if env_file:
        path = Path(env_file).expanduser()
    else:
        path = DEFAULT_ENV_FILE_PATH

    if not path.exists():
        if env_file:
            raise ValueError(f"--env-file path does not exist: {path}")
        return None

    load_dotenv(path, override=False)
    return path


def parse_int_env(
    name: str,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        value = default
    else:
        text = raw_value.strip()
        if not text:
            raise ValueError(f"{name} cannot be empty")
        try:
            value = int(text)
        except ValueError as err:
            raise ValueError(f"{name} must be an integer, got: {raw_value!r}") from err

    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got: {value}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name} must be <= {maximum}, got: {value}")
    return value


def parse_csv_env(name: str, default: Sequence[str]) -> list[str]:
    raw_value = os.getenv(name)
    if raw_value is None:
        return list(default)

    values = [part.strip() for part in raw_value.split(",")]
    if not values or any(not item for item in values):
        raise ValueError(
            f"{name} must be a comma-separated list with non-empty values, got: {raw_value!r}"
        )
    return values


def normalize_log_level(value: str) -> str:
    if value is None:
        raise ValueError("log level cannot be None")
    level = value.strip().lower()
    if not level:
        raise ValueError("log level cannot be empty")
    if level not in _ALLOWED_LOG_LEVELS:
        allowed = ", ".join(sorted(_ALLOWED_LOG_LEVELS))
        raise ValueError(f"log level must be one of: {allowed}; got: {value!r}")
    if level == "warn":
        return "warning"
    return level


def parse_log_level_env(name: str, default: str) -> str:
    raw_value = os.getenv(name)
    return normalize_log_level(raw_value if raw_value is not None else default)


def logging_level_from_name(level: str) -> int:
    if level == "trace":
        return logging.DEBUG
    return getattr(logging, level.upper())


def _parse_cli_port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as err:
        raise argparse.ArgumentTypeError(f"invalid port {value!r}: must be an integer") from err
    if port < 1 or port > 65535:
        raise argparse.ArgumentTypeError(
            f"invalid port {value!r}: must be between 1 and 65535"
        )
    return port


def _parse_cli_log_level(value: str) -> str:
    try:
        return normalize_log_level(value)
    except ValueError as err:
        raise argparse.ArgumentTypeError(str(err)) from err


def build_main_parser(defaults: ServerConfig) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="BoxLite REST API Reference Server")
    parser.add_argument(
        "--env-file",
        default=None,
        help=(
            "Path to .env file (loaded before parsing other args). "
            "If omitted, uses openapi/reference-server/.env when present."
        ),
    )
    parser.add_argument("--host", default=defaults.host, help="Bind address")
    parser.add_argument("--port", type=_parse_cli_port, default=defaults.port, help="Bind port")
    parser.add_argument(
        "--log-level",
        type=_parse_cli_log_level,
        default=defaults.log_level,
        help="Log level (critical,error,warning,info,debug,trace)",
    )
    return parser


def load_server_config_from_env() -> ServerConfig:
    host = os.getenv(ENV_SERVER_HOST, DEFAULT_SERVER_HOST).strip()
    if not host:
        raise ValueError(f"{ENV_SERVER_HOST} cannot be empty")

    jwt_secret = os.getenv(ENV_SERVER_JWT_SECRET, DEFAULT_SERVER_JWT_SECRET).strip()
    if not jwt_secret:
        raise ValueError(f"{ENV_SERVER_JWT_SECRET} cannot be empty")

    client_id = os.getenv(ENV_SERVER_CLIENT_ID, DEFAULT_SERVER_CLIENT_ID).strip()
    if not client_id:
        raise ValueError(f"{ENV_SERVER_CLIENT_ID} cannot be empty")

    client_secret = os.getenv(
        ENV_SERVER_CLIENT_SECRET, DEFAULT_SERVER_CLIENT_SECRET
    ).strip()
    if not client_secret:
        raise ValueError(f"{ENV_SERVER_CLIENT_SECRET} cannot be empty")

    return ServerConfig(
        host=host,
        port=parse_int_env(ENV_SERVER_PORT, DEFAULT_SERVER_PORT, minimum=1, maximum=65535),
        log_level=parse_log_level_env(ENV_SERVER_LOG_LEVEL, DEFAULT_SERVER_LOG_LEVEL),
        jwt_secret=jwt_secret,
        jwt_expiry_seconds=parse_int_env(
            ENV_SERVER_JWT_EXPIRY_SECONDS,
            DEFAULT_SERVER_JWT_EXPIRY_SECONDS,
            minimum=1,
        ),
        client_id=client_id,
        client_secret=client_secret,
    )


def load_runtime_config_from_env() -> RuntimeConfig:
    raw_home_dir = os.getenv(ENV_RUNTIME_HOME_DIR, default_runtime_home_dir()).strip()
    if not raw_home_dir:
        raise ValueError(f"{ENV_RUNTIME_HOME_DIR} cannot be empty")

    home_dir = Path(raw_home_dir).expanduser()
    if not home_dir.is_absolute():
        raise ValueError(
            f"{ENV_RUNTIME_HOME_DIR} must be an absolute path, got: {raw_home_dir!r}"
        )

    return RuntimeConfig(
        home_dir=str(home_dir),
        image_registries=parse_csv_env(
            ENV_RUNTIME_IMAGE_REGISTRIES, DEFAULT_RUNTIME_IMAGE_REGISTRIES
        ),
    )
