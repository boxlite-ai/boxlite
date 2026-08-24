"""Curated base image for the e2e suite."""

from __future__ import annotations

import os
from pathlib import Path

REGISTRY = "ghcr.io/boxlite-ai"
IMAGE_ENV_VAR = "BOXLITE_E2E_IMAGE"
VERSION_FILE = Path(__file__).resolve().parents[3] / "apps/box-images/VERSION"


def base_image_ref() -> str:
    """Build the base ref from apps/box-images/VERSION."""
    try:
        raw_version = VERSION_FILE.read_text().strip()
    except OSError as exc:
        raise RuntimeError(f"cannot read box image version from {VERSION_FILE}: {exc}") from exc
    if not raw_version:
        raise RuntimeError(f"{VERSION_FILE} is empty")
    version = raw_version if raw_version.startswith("v") else f"v{raw_version}"
    return f"{REGISTRY}/boxlite-agent-base:{version}"


def default_image() -> str:
    """Use $BOXLITE_E2E_IMAGE when set, else the VERSION-backed base ref."""
    return os.environ.get(IMAGE_ENV_VAR) or base_image_ref()


if __name__ == "__main__":
    print(default_image())
