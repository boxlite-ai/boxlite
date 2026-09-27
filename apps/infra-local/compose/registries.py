"""Registry credentials for infra-local image pulls."""

from __future__ import annotations

import json
import os
import shutil
import subprocess


def dockerhub_creds() -> tuple[str | None, str | None]:
    """(username, token) for docker.io: explicit env first, then Docker
    Desktop's credStore (populated by `docker login`). (None, None) if neither."""
    u = os.environ.get("BOXLITE_DOCKERHUB_USER") or os.environ.get("DOCKERHUB_USERNAME")
    t = os.environ.get("BOXLITE_DOCKERHUB_TOKEN") or os.environ.get("DOCKERHUB_TOKEN")
    if u and t:
        return u, t
    return _credstore_get("https://index.docker.io/v1/")


def ghcr_creds() -> tuple[str | None, str | None]:
    """(username, token) for ghcr.io. The curated agent images are public, so
    these are optional; they are required only for a private image ref.
    Resolution order, each per-developer (no shared
    secret to distribute):
      1. explicit env (GHCR_USERNAME/GHCR_TOKEN or BOXLITE_GHCR_*)
      2. the GitHub CLI token (`gh auth token`) — its scope already covers
         read:packages for whoever is logged in
      3. Docker's credStore (populated by `docker login ghcr.io`)
    (None, None) if none resolve."""
    u = os.environ.get("GHCR_USERNAME") or os.environ.get("BOXLITE_GHCR_USER")
    t = os.environ.get("GHCR_TOKEN") or os.environ.get("BOXLITE_GHCR_TOKEN")
    if u and t:
        return u, t
    if shutil.which("gh"):
        try:
            token = subprocess.run(["gh", "auth", "token"], capture_output=True,
                                   text=True, timeout=5, check=True).stdout.strip()
            user = subprocess.run(["gh", "api", "user", "--jq", ".login"],
                                  capture_output=True, text=True, timeout=5,
                                  check=True).stdout.strip()
            if token and user:
                return user, token
        except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
            return _credstore_get("ghcr.io")
    return _credstore_get("ghcr.io")


def _credstore_get(registry: str) -> tuple[str | None, str | None]:
    """Read (username, secret) for `registry` from Docker Desktop's credStore."""
    try:
        out = subprocess.run(
            ["docker-credential-desktop", "get"],
            input=registry, capture_output=True, text=True, timeout=5,
        )
        d = json.loads(out.stdout or "{}")
        return d.get("Username") or None, d.get("Secret") or None
    except Exception:
        return None, None


def image_registries():
    """Registry credentials for the L1 BoxLite runtime."""
    from boxlite import ImageRegistry

    registries = []
    docker_user, docker_token = dockerhub_creds()
    if docker_user and docker_token:
        registries.append(ImageRegistry(
            "docker.io", username=docker_user, password=docker_token, search=True,
        ))
    ghcr_user, ghcr_token = ghcr_creds()
    if ghcr_user and ghcr_token:
        registries.append(ImageRegistry(
            "ghcr.io", username=ghcr_user, password=ghcr_token, search=False,
        ))
    return registries


def export_dockerhub_env() -> None:
    """Put docker.io creds into os.environ under every name the stack reads:
    the orchestrator (L1 SDK) and the Go runner (envconfig). No-op if absent."""
    u, t = dockerhub_creds()
    if u and t:
        os.environ.setdefault("BOXLITE_DOCKERHUB_USER", u)
        os.environ.setdefault("BOXLITE_DOCKERHUB_TOKEN", t)
        os.environ.setdefault("DOCKERHUB_USERNAME", u)
        os.environ.setdefault("DOCKERHUB_TOKEN", t)


def export_ghcr_env() -> None:
    """Thread ghcr.io creds into os.environ under the names the runner reads
    (GHCR_USERNAME/GHCR_TOKEN via envconfig) so it can pull a private image
    ref. No-op if none resolve."""
    u, t = ghcr_creds()
    if u and t:
        os.environ.setdefault("GHCR_USERNAME", u)
        os.environ.setdefault("GHCR_TOKEN", t)
        os.environ.setdefault("BOXLITE_GHCR_USER", u)
        os.environ.setdefault("BOXLITE_GHCR_TOKEN", t)
