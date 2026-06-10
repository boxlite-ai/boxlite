#!/usr/bin/env python3
"""Set up the e2e suite's data fixture against a running stack.

Idempotent. Safe to re-run after bootstrap.sh.

Configures:
  1. Required snapshots active (alpine:3.23, ubuntu:22.04)
  2. Admin org has non-zero per-sandbox quotas
  3. `[profiles.p1]` in ~/.boxlite/credentials.toml points at the local API
"""
from __future__ import annotations

import json
import os
import sys
import time
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
SNAPSHOTS_TO_REGISTER = ["alpine:3.23", "ubuntu:22.04", "ubuntu:24.04"]
SNAPSHOT_WAIT_SECONDS = 180
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


def _snapshot_state(name: str) -> tuple[str | None, str | None]:
    """Read snapshot state directly from Postgres — the API's snapshot GET
    routes are scoped behind a different controller surface, but the
    fixture lives next to the DB anyway, so use the canonical source."""
    import subprocess
    sql = f"SELECT state, \"errorReason\" FROM snapshot WHERE name = '{name}' LIMIT 1;"
    r = subprocess.run(
        ["psql", "-h", "localhost", "-U", "boxlite", "-d", "boxlite_dev",
         "-tAF", "|", "-c", sql],
        env={**os.environ, "PGPASSWORD": "boxlite"},
        capture_output=True, text=True,
    )
    line = r.stdout.strip()
    if not line:
        return None, None
    parts = line.split("|", 1)
    return parts[0], (parts[1] if len(parts) > 1 else None)


def register_snapshot(name: str):
    """POST /snapshots if missing; waits (polling DB) until state == active."""
    state, _ = _snapshot_state(name)
    if state is None:
        status, body = http("POST", "/snapshots", {
            "name": name, "imageName": name,
            "cpu": 1, "memory": 1, "disk": 2,
        })
        if status not in (200, 201):
            sys.exit(f"  POST /snapshots → {status} {body}")
        print(f"  created {name} — waiting for runner pull")
    elif state == "error":
        # Wipe + recreate so the runner retries (e.g. registry was down before).
        import subprocess
        subprocess.run(
            ["psql", "-h", "localhost", "-U", "boxlite", "-d", "boxlite_dev",
             "-c", f"DELETE FROM snapshot WHERE name = '{name}';"],
            env={**os.environ, "PGPASSWORD": "boxlite"}, check=True,
        )
        return register_snapshot(name)
    else:
        print(f"  {name}: state = {state} (existing)")

    deadline = time.time() + SNAPSHOT_WAIT_SECONDS
    while time.time() < deadline:
        st, err = _snapshot_state(name)
        if st == "active":
            print(f"  {name}: active ✓")
            return
        if st == "error":
            sys.exit(f"  {name}: {err}")
        time.sleep(3)
    sys.exit(f"  {name} did not reach active within {SNAPSHOT_WAIT_SECONDS}s")


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
WHERE personal = true;
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
    print("3. Registering snapshots...")
    for snap in SNAPSHOTS_TO_REGISTER:
        register_snapshot(snap)
    print()
    print("4. Writing ~/.boxlite/credentials.toml profile p1...")
    ensure_p1_profile(prefix)
    print()
    print("fixture_setup: done.")


if __name__ == "__main__":
    main()
