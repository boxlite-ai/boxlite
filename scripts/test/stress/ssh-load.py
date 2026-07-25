#!/usr/bin/env python3
"""SSH-specific load scenario (design section 7, Phase 4: "Scale"):
100 concurrent connections, auth-rejection burst, repeated connect/disconnect
churn, and handshake/first-command latency.

Not k6: k6 (this directory's other scripts) speaks HTTP/WebSocket, not raw
SSH -- there is no standard k6 module for opening real SSH sessions through
`ProxyCommand`. This script drives the real OpenSSH client the same way
scripts/test/e2e/cases/test_real_ssh.py does (no `StrictHostKeyChecking=no`,
real known_hosts pinning), fanned out concurrently via a thread pool since
each `ssh` invocation is its own blocking subprocess.

Prereqs: a box with real SSH already enabled and reachable (SSH_ISSUANCE_ENABLED
and BOXLITE_GUEST_SSH_ENABLED both on for that environment), `ssh`/`ssh-keygen`/
`proxytunnel` on PATH, and a Hosted API access grant already issued for it.

Usage:
  BOXLITE_E2E_API_URL=https://api.example.com \
  BOXLITE_E2E_API_KEY=<token> \
    python3 scripts/test/stress/ssh-load.py <box-id> <grant-id>

Env knobs (all optional, defaults match design section 7's "100 concurrent"):
  BOXLITE_SSH_LOAD_CONCURRENT=100        concurrent legitimate connections
  BOXLITE_SSH_LOAD_AUTH_REJECT_BURST=50  rapid wrong-key attempts
  BOXLITE_SSH_LOAD_CHURN_CYCLES=200      sequential connect/disconnect/repeat
  BOXLITE_SSH_LOAD_CHURN_CONCURRENCY=10  churn cycles in flight at once
  BOXLITE_SSH_LOAD_P95_MS=2000           threshold: fail if P95 exceeds this
  BOXLITE_SSH_LOAD_P99_MS=4000           threshold: fail if P99 exceeds this
  BOXLITE_SSH_LOAD_MAX_FAILURE_RATE=0.01 threshold: fail if legit-connection
                                          failure rate exceeds this

Exit status: non-zero if any scenario breaches its threshold (mirrors the k6
scripts' thresholds{} convention) or an auth-rejection-burst attempt is
unexpectedly accepted.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def env_float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


CONCURRENT = env_int("BOXLITE_SSH_LOAD_CONCURRENT", 100)
AUTH_REJECT_BURST = env_int("BOXLITE_SSH_LOAD_AUTH_REJECT_BURST", 50)
CHURN_CYCLES = env_int("BOXLITE_SSH_LOAD_CHURN_CYCLES", 200)
CHURN_CONCURRENCY = env_int("BOXLITE_SSH_LOAD_CHURN_CONCURRENCY", 10)
P95_MS = env_float("BOXLITE_SSH_LOAD_P95_MS", 2000)
P99_MS = env_float("BOXLITE_SSH_LOAD_P99_MS", 4000)
MAX_FAILURE_RATE = env_float("BOXLITE_SSH_LOAD_MAX_FAILURE_RATE", 0.01)
SSH_TIMEOUT = env_int("BOXLITE_SSH_LOAD_TIMEOUT_SECONDS", 20)


def require_binaries() -> None:
    missing = [name for name in ("ssh", "ssh-keygen", "proxytunnel") if not shutil.which(name)]
    if missing:
        print(f"error: missing required binaries on PATH: {', '.join(missing)}", file=sys.stderr)
        sys.exit(2)


def api_request(method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
    api_url = os.environ.get("BOXLITE_E2E_API_URL")
    token = os.environ.get("BOXLITE_E2E_API_KEY") or os.environ.get("BOXLITE_E2E_OIDC_TOKEN")
    if not api_url or not token:
        print("error: set BOXLITE_E2E_API_URL and BOXLITE_E2E_API_KEY (or _OIDC_TOKEN)", file=sys.stderr)
        sys.exit(2)
    req = urllib.request.Request(
        f"{api_url.rstrip('/')}{path}",
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return exc.code, json.loads(raw) if raw else None


def generate_keypair(directory: Path, comment: str) -> tuple[Path, str]:
    key_path = directory / f"id_{comment}"
    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", comment, "-f", str(key_path)],
        check=True,
        capture_output=True,
    )
    key_path.chmod(0o600)
    return key_path, (directory / f"id_{comment}.pub").read_text().strip()


def create_credential(box_id: str, grant_id: str, public_key_line: str) -> dict:
    status, body = api_request(
        "POST",
        f"/box/{box_id}/ssh-access",
        {"grantId": grant_id, "publicKey": public_key_line, "expiresInSeconds": 3600},
    )
    if status != 201 or not body:
        print(f"error: create temporary SSH credential failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    return body


def revoke_credential(box_id: str, credential_id: str) -> None:
    api_request("DELETE", f"/box/{box_id}/ssh-access/{credential_id}")


def ssh_args(credential: dict, private_key_path: Path, known_hosts_path: Path, command: str) -> list[str]:
    return [
        "ssh",
        "-i", str(private_key_path),
        "-o", f"UserKnownHostsFile={known_hosts_path}",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "BatchMode=yes",
        "-o", f"ConnectTimeout={SSH_TIMEOUT}",
        "-o", f"ProxyCommand={credential['proxyCommand']}",
        f"root@{credential['endpoint']}",
        command,
    ]


def timed_ssh_attempt(args: list[str]) -> tuple[bool, float]:
    start = time.monotonic()
    try:
        result = subprocess.run(args, capture_output=True, timeout=SSH_TIMEOUT + 10, check=False)
        elapsed_ms = (time.monotonic() - start) * 1000
        return result.returncode == 0, elapsed_ms
    except subprocess.TimeoutExpired:
        return False, (time.monotonic() - start) * 1000


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(len(ordered) * pct))
    return ordered[index]


def run_concurrent_scenario(credential: dict, private_key_path: Path, known_hosts_path: Path) -> bool:
    print(f"=== Scenario: {CONCURRENT} concurrent connections ===")
    args = ssh_args(credential, private_key_path, known_hosts_path, "echo load-ok")
    with ThreadPoolExecutor(max_workers=CONCURRENT) as pool:
        futures = [pool.submit(timed_ssh_attempt, args) for _ in range(CONCURRENT)]
        results = [f.result() for f in as_completed(futures)]

    successes = [ms for ok, ms in results if ok]
    failures = len(results) - len(successes)
    failure_rate = failures / len(results) if results else 1.0
    p95 = percentile(successes, 0.95)
    p99 = percentile(successes, 0.99)

    print(f"  {len(successes)}/{len(results)} succeeded, failure rate {failure_rate:.3f}")
    print(f"  latency P50={percentile(successes, 0.5):.0f}ms P95={p95:.0f}ms P99={p99:.0f}ms")

    ok = failure_rate <= MAX_FAILURE_RATE and p95 <= P95_MS and p99 <= P99_MS
    if not ok:
        print(f"  THRESHOLD BREACH (max_failure_rate={MAX_FAILURE_RATE}, p95<{P95_MS}ms, p99<{P99_MS}ms)")
    return ok


def run_auth_reject_burst_scenario(credential: dict, wrong_key_path: Path, known_hosts_path: Path) -> bool:
    print(f"=== Scenario: {AUTH_REJECT_BURST}-attempt auth-rejection burst (wrong key) ===")
    args = ssh_args(credential, wrong_key_path, known_hosts_path, "echo should-not-run")
    with ThreadPoolExecutor(max_workers=min(AUTH_REJECT_BURST, 50)) as pool:
        futures = [pool.submit(timed_ssh_attempt, args) for _ in range(AUTH_REJECT_BURST)]
        results = [f.result() for f in as_completed(futures)]

    wrongly_accepted = sum(1 for ok, _ in results if ok)
    print(f"  {wrongly_accepted}/{len(results)} wrongly accepted (must be 0)")
    if wrongly_accepted > 0:
        print("  SECURITY FAILURE: a connection with the wrong key was accepted under load")
        return False
    return True


def run_churn_scenario(credential: dict, private_key_path: Path, known_hosts_path: Path) -> bool:
    print(f"=== Scenario: {CHURN_CYCLES} connect/disconnect cycles (concurrency={CHURN_CONCURRENCY}) ===")
    args = ssh_args(credential, private_key_path, known_hosts_path, "true")

    # Split into halves to compare early vs. late latency/failure trend --
    # a leak (fds, channels, connection-table entries) should show up as the
    # back half getting slower or failing more than the front half, even
    # though the workload itself is identical.
    with ThreadPoolExecutor(max_workers=CHURN_CONCURRENCY) as pool:
        futures = [pool.submit(timed_ssh_attempt, args) for _ in range(CHURN_CYCLES)]
        results = [f.result() for f in futures]

    half = len(results) // 2
    first_half, second_half = results[:half], results[half:]
    first_failures = sum(1 for ok, _ in first_half if not ok)
    second_failures = sum(1 for ok, _ in second_half if not ok)
    first_p95 = percentile([ms for ok, ms in first_half if ok], 0.95)
    second_p95 = percentile([ms for ok, ms in second_half if ok], 0.95)

    print(f"  first half:  {len(first_half) - first_failures}/{len(first_half)} ok, P95={first_p95:.0f}ms")
    print(f"  second half: {len(second_half) - second_failures}/{len(second_half)} ok, P95={second_p95:.0f}ms")

    # A generous 2x tolerance -- this is a leak smoke signal, not a strict
    # perf regression gate (those are the concurrent-scenario thresholds).
    degraded = second_failures > first_failures * 2 + 2 or second_p95 > first_p95 * 2 + 500
    if degraded:
        print("  POSSIBLE LEAK: back half of the churn run degraded significantly vs. the front half")
    return not degraded


def main() -> None:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <box-id> <grant-id>", file=sys.stderr)
        sys.exit(2)
    box_id, grant_id = sys.argv[1], sys.argv[2]

    require_binaries()

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        legit_key_path, legit_public_key = generate_keypair(tmp_path, "legit")
        wrong_key_path, _ = generate_keypair(tmp_path, "wrong")

        credential = create_credential(box_id, grant_id, legit_public_key)
        known_hosts_path = tmp_path / "known_hosts"
        known_hosts_path.write_text(credential["knownHostsEntry"].strip() + "\n")

        results = {}
        try:
            results["concurrent"] = run_concurrent_scenario(credential, legit_key_path, known_hosts_path)
            results["auth_reject_burst"] = run_auth_reject_burst_scenario(credential, wrong_key_path, known_hosts_path)
            results["churn"] = run_churn_scenario(credential, legit_key_path, known_hosts_path)
        finally:
            revoke_credential(box_id, credential["id"])

    print("=== Summary ===")
    for name, passed in results.items():
        print(f"  {name}: {'PASS' if passed else 'FAIL'}")

    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
