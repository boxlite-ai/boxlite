"""Shared auth helpers for REST E2E tests.

The suite can run against the same REST path with either API-key or OIDC
bearer tokens. Python SDK bindings still expose the generic bearer slot as
`ApiKeyCredential`; the API only sees `Authorization: Bearer <token>`.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import json
import os
from pathlib import Path
import shutil
import subprocess
import tomllib
from typing import Any
import urllib.error
import urllib.request


DEFAULT_PROFILE = os.environ.get("BOXLITE_E2E_PROFILE", "p1")


def credentials_path() -> Path:
    if os.environ.get("BOXLITE_HOME"):
        return Path(os.environ["BOXLITE_HOME"]) / "credentials.toml"
    return Path.home() / ".boxlite" / "credentials.toml"


def load_profile(name: str | None = None, *, required: bool = True) -> dict[str, Any]:
    profile_name = name or DEFAULT_PROFILE
    path = credentials_path()
    if not path.exists():
        if required:
            raise RuntimeError(
                f"{path} missing; run scripts/test/e2e/fixture_setup.py first"
            )
        return {}
    data = tomllib.loads(path.read_text())
    profile = data.get("profiles", {}).get(profile_name)
    if not profile:
        if required:
            raise RuntimeError(f"profile {profile_name!r} not in {path}; run fixture_setup.py")
        return {}
    return profile


@dataclass(frozen=True)
class E2EAuthContext:
    auth: str
    profile_name: str
    url: str
    token: str
    path_prefix: str

    def auth_headers(self, *, content_type: bool = False) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self.token}"}
        if content_type:
            headers["Content-Type"] = "application/json"
        return headers

    def url_for(self, path: str) -> str:
        if path.startswith("http://") or path.startswith("https://"):
            return path
        return f"{self.url.rstrip('/')}/{path.lstrip('/')}"

    def v1(self, path: str) -> str:
        path = path.lstrip("/")
        if self.path_prefix:
            return f"/v1/{self.path_prefix}/{path}"
        return f"/v1/{path}"

    def api_key_sdk_env(self) -> dict[str, str]:
        if self.auth != "api-key":
            raise RuntimeError("cross-language SDK E2E only supports AUTH=api-key today")
        return {
            "BOXLITE_E2E_URL": self.url,
            "BOXLITE_E2E_API_KEY": self.token,
            "BOXLITE_E2E_PREFIX": self.path_prefix,
        }


@lru_cache(maxsize=1)
def auth_context() -> E2EAuthContext:
    profile_name = os.environ.get("BOXLITE_E2E_PROFILE", DEFAULT_PROFILE)
    profile = load_profile(profile_name, required=False)
    auth = os.environ.get("BOXLITE_E2E_AUTH", profile.get("auth_method", "api_key"))
    auth = auth.replace("_", "-").lower()
    if auth not in ("api-key", "oidc"):
        raise RuntimeError(f"BOXLITE_E2E_AUTH must be api-key or oidc, got {auth!r}")

    url = os.environ.get("BOXLITE_E2E_API_URL") or profile.get("url")
    if not url:
        raise RuntimeError(f"profile {profile_name!r} has no url")

    env_token = None
    if auth == "api-key":
        env_token = os.environ.get("BOXLITE_E2E_API_KEY")
        token = env_token or profile.get("api_key")
        missing = "BOXLITE_E2E_API_KEY or profile.api_key"
    else:
        env_token = os.environ.get("BOXLITE_E2E_OIDC_TOKEN")
        if not env_token:
            profile = refresh_stored_oidc_profile(profile_name, profile)
        token = env_token or profile.get("access_token")
        missing = "BOXLITE_E2E_OIDC_TOKEN or profile.access_token"
    if not token:
        raise RuntimeError(f"AUTH={auth} requires {missing}")

    explicit_prefix = os.environ.get("BOXLITE_E2E_PREFIX")
    if explicit_prefix is not None:
        path_prefix = explicit_prefix
    elif os.environ.get("BOXLITE_E2E_DISCOVER_PREFIX", "1") != "0":
        path_prefix = discover_path_prefix(url, token)
    else:
        path_prefix = profile.get("path_prefix") or ""

    return E2EAuthContext(
        auth=auth,
        profile_name=profile_name,
        url=url,
        token=token,
        path_prefix=path_prefix,
    )


def refresh_stored_oidc_profile(profile_name: str, profile: dict[str, Any]) -> dict[str, Any]:
    if not profile:
        return profile
    cli = os.environ.get("BOXLITE_E2E_CLI") or shutil.which("boxlite")
    if not cli:
        raise RuntimeError(
            "AUTH=oidc with a stored profile requires the boxlite CLI so the "
            "access token can be refreshed; set BOXLITE_E2E_OIDC_TOKEN to run "
            "without the CLI"
        )

    result = subprocess.run(
        [cli, "--profile", profile_name, "auth", "whoami"],
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "failed to refresh stored OIDC profile with `boxlite auth whoami`: "
            f"{result.stderr or result.stdout}"
        )
    return load_profile(profile_name)


def discover_path_prefix(url: str, token: str) -> str:
    req = urllib.request.Request(
        f"{url.rstrip('/')}/v1/me",
        method="GET",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            body = json.loads(response.read() or "null")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"GET /v1/me failed with HTTP {exc.code}: {raw}") from exc
    return (body or {}).get("path_prefix") or ""


def request_json(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: int = 30,
    authorized: bool = True,
) -> tuple[int, dict[str, Any] | None]:
    ctx = auth_context()
    headers = ctx.auth_headers(content_type=body is not None) if authorized else {}
    req = urllib.request.Request(
        ctx.url_for(path),
        method=method,
        headers=headers,
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return exc.code, {"_raw": raw.decode("utf-8", "replace")}
