#!/usr/bin/env python3
"""Set up the e2e suite's data fixture against a running stack.

Idempotent. Safe to re-run after bootstrap.sh.

Configures:
  1. Admin org has non-zero per-box quotas
  2. `[profiles.p1]` in ~/.boxlite/credentials.toml points at the local API

Box images need no registration: create requests carry a curated image key
(base | python | node) that the API resolves via BOXLITE_SYSTEM_*_IMAGE env
(bootstrap.sh points them at public refs for the local stack).
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

API_URL = os.environ.get("BOXLITE_E2E_API_URL", "http://localhost:3000/api")


def _read_admin_key_from_secrets() -> str | None:
    """Bootstrap.sh writes the (random, persistent) admin API key to
    /etc/boxlite-secrets.env. Read it from there so fixture_setup
    automatically picks up whatever bootstrap minted, instead of the
    user pasting it from terminal output."""
    secrets = Path("/etc/boxlite-secrets.env")
    if not secrets.exists():
        return None
    try:
        for ln in secrets.read_text().splitlines():
            if ln.startswith("ADMIN_API_KEY="):
                return ln.split("=", 1)[1].strip()
    except PermissionError:
        return None
    return None


ADMIN_KEY = (
    os.environ.get("BOXLITE_E2E_ADMIN_KEY")
    or _read_admin_key_from_secrets()
    or "devkey"   # only used when bootstrap hasn't run yet
)
CRED_PATH = Path.home() / ".boxlite" / "credentials.toml"


def http(method: str, path: str, body=None):
    req = urllib.request.Request(
        API_URL + path,
        method=method,
        headers={
            "Authorization": f"Bearer {ADMIN_KEY}",
            "Content-Type": "application/json",
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "null")


def me() -> dict:
    status, body = http("GET", "/v1/me")
    if status != 200:
        sys.exit(f"GET /v1/me → {status} {body}")
    return body


def patch_admin_quota():
    """The admin user is created on first API boot with org quotas at 0
    (config defaults are 0 unless ADMIN_* env vars override). Bump them
    so the box CREATE path doesn't 403 in tests."""
    import subprocess
    sql = """
UPDATE organization SET
    max_cpu_per_box = 4,
    max_memory_per_box = 8,
    max_disk_per_box = 20
FROM organization_user
WHERE organization_user."organizationId" = organization.id
  AND organization_user."isDefaultForUser" = true;
"""
    r = subprocess.run(
        ["psql", "-h", "localhost", "-U", "boxlite", "-d", "boxlite_dev",
         "-tAc", sql],
        env={**os.environ, "PGPASSWORD": "boxlite"},
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"quota patch failed: {r.stderr}")
    print("  admin org quota: ok")


def ensure_p1_profile(prefix: str):
    """Write [profiles.p1] into ~/.boxlite/credentials.toml. Preserves
    other profiles."""
    CRED_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Read existing (if any). Don't depend on tomllib being able to
    # round-trip — write the whole thing fresh from a parsed view.
    profiles = {}
    if CRED_PATH.exists():
        import tomllib
        with CRED_PATH.open("rb") as f:
            existing = tomllib.load(f)
            profiles = existing.get("profiles", {})

    # Write BOTH p1 (Python SDK conftest default) and `default` (what
    # `boxlite auth whoami` and other CLI commands use without --profile).
    # If we only updated p1, CLI tests that hit the default profile
    # would still see whatever the previous bootstrap minted.
    entry = {
        "url": API_URL,
        "api_key": ADMIN_KEY,
        "auth_method": "api_key",
        "path_prefix": prefix,
    }
    profiles["p1"] = entry
    profiles["default"] = entry.copy()

    out = []
    for prof_name, prof in profiles.items():
        out.append(f"[profiles.{prof_name}]")
        for k, v in prof.items():
            if isinstance(v, str):
                out.append(f'{k} = "{v}"')
            elif isinstance(v, bool):
                out.append(f'{k} = {str(v).lower()}')
            else:
                out.append(f'{k} = {v}')
        out.append("")
    CRED_PATH.write_text("\n".join(out))
    print(f"  ~/.boxlite/credentials.toml: profile p1 → {API_URL} (prefix {prefix})")


def main():
    print(f"API_URL={API_URL}")
    print()
    print("1. Bumping admin org quota...")
    patch_admin_quota()
    print()
    print("2. Querying /v1/me for prefix...")
    info = me()
    prefix = info["path_prefix"]
    print(f"  prefix = {prefix}")
    print()
    print("3. Writing ~/.boxlite/credentials.toml profile p1...")
    ensure_p1_profile(prefix)
    print()
    print("fixture_setup: done.")


if __name__ == "__main__":
    main()
