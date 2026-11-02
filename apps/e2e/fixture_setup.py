#!/usr/bin/env python3
"""Configure the authenticated E2E organization and isolated client profiles."""
from __future__ import annotations

import json
import os
import sys
import subprocess
import uuid
import urllib.request
import urllib.error
from pathlib import Path


API_URL = os.environ.get("BOXLITE_E2E_API_URL", "http://localhost:3000/api")


ADMIN_KEY = os.environ.get("BOXLITE_E2E_ADMIN_KEY", "")
CRED_PATH = Path(os.environ["BOXLITE_HOME"]) / "credentials.toml" if os.environ.get("BOXLITE_HOME") else None


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


def patch_admin_box_limits(prefix: str):
    """Patch only the UUID returned by the authenticated /v1/me request."""
    org_id = str(uuid.UUID(prefix))
    required = ("PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "PGPASSWORD")
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        sys.exit(f"quota patch requires: {', '.join(missing)}")
    sql = """
UPDATE organization SET
    max_cpu_per_box = 4,
    max_memory_per_box = 8,
    max_disk_per_box = 20
WHERE id = :'org_id'::uuid
RETURNING id;
"""
    result = subprocess.run(
        ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-v", f"org_id={org_id}", "-qAt"],
        input=sql, env=os.environ, capture_output=True, text=True,
    )
    if result.returncode != 0:
        sys.exit(f"quota patch failed: {result.stderr}")
    if result.stdout.split() != [org_id]:
        sys.exit(f"quota patch did not return exactly organization {org_id}: {result.stdout!r}")
    print(f"  organization {org_id} per-box limits: ok")


def ensure_p1_profile(prefix: str):
    """Update API-key profiles while preserving other existing profiles."""
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
        out.append(f"[profiles.{json.dumps(prof_name, ensure_ascii=False)}]")
        for k, v in prof.items():
            if isinstance(v, str):
                out.append(f'{json.dumps(k, ensure_ascii=False)} = {json.dumps(v, ensure_ascii=False)}')
            elif isinstance(v, bool):
                out.append(f'{json.dumps(k)} = {str(v).lower()}')
            else:
                out.append(f'{json.dumps(k)} = {v}')
        out.append("")
    fd = os.open(CRED_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as credentials:
        os.fchmod(credentials.fileno(), 0o600)
        credentials.write("\n".join(out))
    print(f"  {CRED_PATH}: API-key profiles p1/default → {API_URL} (prefix {prefix})")


def main():
    if not ADMIN_KEY:
        sys.exit("BOXLITE_E2E_ADMIN_KEY is required")
    if CRED_PATH is None:
        sys.exit("BOXLITE_HOME is required for isolated E2E profiles")
    print(f"API_URL={API_URL}")
    print("1. Querying /v1/me for organization...")
    info = me()
    try:
        prefix = str(uuid.UUID(info["path_prefix"]))
    except (KeyError, ValueError, TypeError, AttributeError):
        sys.exit("GET /v1/me returned no valid UUID path_prefix")
    print("2. Raising authenticated organization per-box limits...")
    patch_admin_box_limits(prefix)
    print("3. Writing isolated API-key profiles...")
    ensure_p1_profile(prefix)
    print()
    print("fixture_setup: done.")


if __name__ == "__main__":
    main()
