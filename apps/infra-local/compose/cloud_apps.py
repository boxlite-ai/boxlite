"""Prepare the runtime artifacts and local identity for the native App API."""

from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import subprocess
from tempfile import NamedTemporaryFile


def _credentials(state: Path) -> dict[str, str]:
    path = state / "cloud-app-credentials.json"
    if not path.exists():
        state.mkdir(parents=True, exist_ok=True)
        private_key = subprocess.check_output([
            "node", "-p",
            "require('node:crypto').generateKeyPairSync('rsa',{modulusLength:2048})"
            ".privateKey.export({type:'pkcs8',format:'pem'})",
        ], text=True).strip()
        with NamedTemporaryFile(mode="w", dir=state, delete=False) as temp:
            json.dump({
                "CLOUD_APP_SESSION_SECRET": secrets.token_urlsafe(32),
                "CLOUD_APP_IDENTITY_PRIVATE_KEY": private_key,
            }, temp)
        os.replace(temp.name, path)
    return json.loads(path.read_text())


def environment(state: Path, port: int, settings: dict[str, str]) -> dict[str, str]:
    hub = settings.get("BOXLITE_HOST_HUB", "host.boxlite.internal")
    defaults = {
        "CLOUD_APP_PROCESS_ROLE": "worker",
        "CLOUD_APP_PUBLIC_URL": f"http://localhost:{port}/api/internal/apps",
        "CLOUD_APP_SUPERVISOR_URL": f"http://{hub}:{port}/api/internal/apps",
        "CLOUD_APP_SOURCE_BUCKET": settings.get("S3_DEFAULT_BUCKET") or "boxlite",
        "CLOUD_APP_SOURCE_BACKEND": "s3",
    }
    if not all(settings.get(key) for key in ("CLOUD_APP_SESSION_SECRET", "CLOUD_APP_IDENTITY_PRIVATE_KEY")):
        defaults.update(_credentials(state))
    return {key: value for key, value in defaults.items() if not settings.get(key)}
