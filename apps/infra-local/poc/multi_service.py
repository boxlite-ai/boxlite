#!/usr/bin/env python
"""
PoC Phase 1 — Multi-service + box-to-box communication via host-as-hub.

NOTE on Python interpreter:
    Use `python` (not `python3`) on macOS with miniforge/conda — see Phase 0
    docs for the gotcha.

Goal (gate question for dogfood orchestrator):
    Verify that **multiple BoxLite boxes can coexist** and that a box
    can reach another box's service via the "host-as-hub" network model:
        client-box → <Mac LAN IP>:host_port → gvproxy → pg-box / redis-box

    Originally we wanted to use `host.boxlite.internal` / `192.168.127.254`
    (the BoxLite HOST_IP constant), but those are configured-only — not
    actually wired through gvproxy. See SDK bug:
        docs/apps/sdk-feedback/01-host-boxlite-internal-unwired.md

    Workaround: detect the Mac's en0/en1 LAN IP at runtime (e.g.
    192.168.1.110) and use that as the host-hub address. This works
    because BoxLite port forwards bind to 0.0.0.0 on the Mac side, and
    macOS reroutes packets sent to its own external IP back to loopback.

    Caveat: fragile when Mac IP changes (Wi-Fi network switch, DHCP
    renewal, etc.). The proper fix is the upstream SDK bug.

Topology:
    Host (Mac LAN IP, e.g. 192.168.1.110, detected at runtime)
      ├─ Box: boxlite-local-pg-poc      postgres:16-alpine    :5432
      ├─ Box: boxlite-local-redis-poc   redis:7-alpine        :6379
      └─ Box: boxlite-local-client-poc  alpine:3.20           (no ports)
              │
              └─ from inside, probe and query both services
                 via <Mac LAN IP>:{5432,6379}

Pass criteria:
    [P1] All 3 boxes start (cold start ≤ 60s, reuse ≤ 5s)
    [P2] Client box: `nc -zv <Mac IP> 5432` → connected
    [P3] Client box: `nc -zv <Mac IP> 6379` → connected
    [P4] Client box: `psql -h <Mac IP> ...` real query → row returned
    [P5] Client box: `redis-cli -h <Mac IP> ...` PING → "PONG"
    [P6] detach=True survives Python exit
         (after this script returns, `boxlite-cli list` shows all 3 RUNNING)

Cleanup:
    python multi_service.py --cleanup
"""

from __future__ import annotations

import argparse
import asyncio
import socket
import subprocess
import sys
import time
from pathlib import Path

import boxlite

try:
    from boxlite import Boxlite, BoxOptions  # type: ignore[attr-defined]
except ImportError:
    from boxlite.boxlite import Boxlite, BoxOptions  # type: ignore[attr-defined]


# ─── Mac LAN IP detection ─────────────────────────────────────────────────
#
# Workaround for SDK bug 01-host-boxlite-internal-unwired
# (`host.boxlite.internal` and `192.168.127.254` are configured in gvproxy but
# not actually wired to NAT/DNS at runtime). We resolve the Mac's en* LAN IP
# at startup and use it as the "host hub" address that all boxes route through.
#
# This is fragile (Mac IP changes when joining new Wi-Fi networks), but it is
# the only working option until the SDK bug is fixed.
# See: docs/apps/sdk-feedback/01-host-boxlite-internal-unwired.md
#
def detect_mac_lan_ip() -> str:
    """Return the Mac's primary LAN IPv4 (en0 / en1 / en2).

    Raises if none found (typically: Wi-Fi off and no ethernet).
    """
    for iface in ["en0", "en1", "en2"]:
        try:
            r = subprocess.run(
                ["ipconfig", "getifaddr", iface],
                capture_output=True, text=True, timeout=2,
            )
            ip = r.stdout.strip()
            if ip and ip.count(".") == 3:
                return ip
        except (subprocess.SubprocessError, FileNotFoundError):
            continue
    raise RuntimeError(
        "Could not detect Mac LAN IP on en0/en1/en2. "
        "Is Wi-Fi off and no ethernet plugged in? "
        "This PoC relies on the Mac's external IP because "
        "`host.boxlite.internal` is not wired in BoxLite SDK yet "
        "(see docs/apps/sdk-feedback/01-host-boxlite-internal-unwired.md)."
    )


# ─── topology ─────────────────────────────────────────────────────────────

PG_NAME       = "boxlite-local-pg-poc"
PG_IMAGE      = "postgres:16-alpine"
PG_HOST_PORT  = 5432
PG_PASSWORD   = "boxlite"

REDIS_NAME       = "boxlite-local-redis-poc"
REDIS_IMAGE      = "redis:7-alpine"
REDIS_HOST_PORT  = 6379

CLIENT_NAME   = "boxlite-local-client-poc"
CLIENT_IMAGE  = "alpine:3.20"          # minimal; apk-add psql + redis-cli + nc inside

# HOST_GW is set at runtime by detect_mac_lan_ip(). We do NOT use
# 192.168.127.254 / host.boxlite.internal because they're broken — see
# SDK bug 01-host-boxlite-internal-unwired.md.
HOST_GW: str = ""   # populated in run_poc()

DATA_ROOT = Path.home() / ".boxlite-local-poc"
PG_DATA   = DATA_ROOT / "pg-data"
REDIS_DATA = DATA_ROOT / "redis-data"


# ─── pretty step ──────────────────────────────────────────────────────────

class Step:
    def __init__(self, label: str):
        self.label = label
        self.start = 0.0

    def __enter__(self):
        self.start = time.monotonic()
        print(f"▶ {self.label} ...", flush=True)
        return self

    def __exit__(self, _exc_type, exc, _tb):
        elapsed = time.monotonic() - self.start
        if exc is None:
            print(f"  ✓ {self.label} ({elapsed:.1f}s)")
        else:
            print(f"  ✗ {self.label} FAILED after {elapsed:.1f}s: {exc!r}")
        return False


# ─── exec wrapper ─────────────────────────────────────────────────────────

async def exec_collect(box, command, args=None, env=None):
    """Run box.exec, drain streams, return (exit_code, stdout, stderr)."""
    execution = await box.exec(command, args or [], env=env)
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []

    async def drain(stream, sink):
        async for chunk in stream:
            sink.append(
                chunk if isinstance(chunk, str)
                else chunk.decode("utf-8", "replace")
            )

    await asyncio.gather(
        drain(execution.stdout(), stdout_parts),
        drain(execution.stderr(), stderr_parts),
    )
    result = await execution.wait()
    return result.exit_code, "".join(stdout_parts), "".join(stderr_parts)


# ─── service starters ────────────────────────────────────────────────────

async def start_service(runtime, *, name, image, ports, env, volumes, memory_mib=512, cmd=None):
    """Idempotent service-box starter with detach=True.

    `cmd` overrides the image CMD — useful for the client box which uses a
    base image (alpine) that has no long-running default process. Pass
    `cmd=["sleep", "infinity"]` to keep the box alive for `box.exec` calls.
    """
    opts = BoxOptions(
        image=image,
        cpus=1,
        memory_mib=memory_mib,
        auto_remove=False,
        detach=True,
        ports=ports,
        volumes=volumes,
        env=env,
        cmd=cmd,
    )
    box, created = await runtime.get_or_create(opts, name=name)
    print(f"    {name}: id={box.id}, created_new={created}")
    if created:
        await box.start()
    else:
        # box may already be running from a previous run; .start() is safe to
        # call (no-op if already up) per SDK contract.
        try:
            await box.start()
        except Exception as e:
            print(f"    (already running: {e!r})")
    return box


async def wait_pg_ready(box, retries: int = 30, interval: float = 2.0) -> bool:
    for attempt in range(1, retries + 1):
        exit_code, _stdout, _stderr = await exec_collect(
            box, "pg_isready", ["-U", "postgres", "-t", "1"]
        )
        if exit_code == 0:
            print(f"    pg_isready OK after {attempt} attempts")
            return True
        await asyncio.sleep(interval)
    return False


async def wait_redis_ready(box, retries: int = 30, interval: float = 2.0) -> bool:
    for attempt in range(1, retries + 1):
        exit_code, stdout, _ = await exec_collect(box, "redis-cli", ["PING"])
        if exit_code == 0 and "PONG" in stdout:
            print(f"    redis PING OK after {attempt} attempts")
            return True
        await asyncio.sleep(interval)
    return False


# ─── host TCP probe ──────────────────────────────────────────────────────

async def host_tcp_check(host: str, port: int, timeout: float = 5.0) -> bool:
    loop = asyncio.get_running_loop()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setblocking(False)
    try:
        await asyncio.wait_for(loop.sock_connect(sock, (host, port)), timeout)
        return True
    except (OSError, asyncio.TimeoutError):
        return False
    finally:
        sock.close()


# ─── client-box setup ────────────────────────────────────────────────────

async def setup_client_box(box):
    """Install psql + redis-cli + nc inside the alpine client box.

    One-time per box; subsequent invocations skip via `command -v` precheck.
    Takes ~15-25s on a cold alpine box (apk + index fetch + downloads).
    """
    exit_code, _stdout, _stderr = await exec_collect(
        box, "sh", [
            "-c",
            "command -v psql && command -v redis-cli && command -v nc",
        ],
    )
    if exit_code == 0:
        print("    client box already has psql + redis-cli + nc")
        return

    print("    apk add postgresql-client redis netcat-openbsd ...")
    exit_code, _stdout, stderr = await exec_collect(
        box, "apk",
        ["add", "--no-cache", "postgresql-client", "redis", "netcat-openbsd"],
    )
    if exit_code != 0:
        raise RuntimeError(
            f"apk add failed (exit={exit_code}): stderr={stderr.strip()!r}"
        )


# ─── main flow ───────────────────────────────────────────────────────────

async def run_poc() -> int:
    global HOST_GW
    HOST_GW = detect_mac_lan_ip()

    print("=" * 70)
    print("BoxLite dogfood PoC Phase 1 — multi-service + box-to-box")
    print("=" * 70)
    print(f"SDK version: {boxlite.__version__}")
    print(f"Topology:")
    print(f"  - {PG_NAME}     ({PG_IMAGE})     :{PG_HOST_PORT}")
    print(f"  - {REDIS_NAME}  ({REDIS_IMAGE}) :{REDIS_HOST_PORT}")
    print(f"  - {CLIENT_NAME} ({CLIENT_IMAGE}) no ports → probes via {HOST_GW}")
    print(f"Host hub IP: {HOST_GW}  (Mac LAN IP — workaround for SDK bug #01)")
    print(f"Data dir:    {DATA_ROOT}")
    print()

    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    PG_DATA.mkdir(parents=True, exist_ok=True)
    REDIS_DATA.mkdir(parents=True, exist_ok=True)

    runtime = Boxlite.default()

    # Phase A: bring up 3 boxes ─────────────────────────────────────────────
    # NOTE: We use POSTGRES_HOST_AUTH_METHOD=trust to disable password auth
    # entirely. Reason: in PoC runs, the password set via POSTGRES_PASSWORD env
    # didn't actually match what the server used for SCRAM-SHA-256 challenge
    # (cause not yet identified — possibly SDK Feedback #02 timing). For a
    # local dev PoC, trust auth is acceptable; production would use real auth.
    with Step("Phase A: start postgres box"):
        pg_box = await start_service(
            runtime,
            name=PG_NAME,
            image=PG_IMAGE,
            ports=[(PG_HOST_PORT, 5432)],
            env=[
                ("POSTGRES_USER", "postgres"),
                ("POSTGRES_PASSWORD", PG_PASSWORD),      # still needed by entrypoint
                ("POSTGRES_DB", "postgres"),
                ("POSTGRES_HOST_AUTH_METHOD", "trust"),  # ★ disable password auth
                ("PGDATA", "/var/lib/postgresql/data/pgdata"),
            ],
            volumes=[(str(PG_DATA), "/var/lib/postgresql/data")],
        )

    with Step("Phase B: start redis box"):
        redis_box = await start_service(
            runtime,
            name=REDIS_NAME,
            image=REDIS_IMAGE,
            ports=[(REDIS_HOST_PORT, 6379)],
            env=[],
            volumes=[(str(REDIS_DATA), "/data")],
            memory_mib=256,
        )

    with Step("Phase C: start client box (no ports, cmd=sleep infinity)"):
        client_box = await start_service(
            runtime,
            name=CLIENT_NAME,
            image=CLIENT_IMAGE,
            ports=[],
            env=[],
            volumes=[],
            memory_mib=256,
            cmd=["sleep", "infinity"],
        )

    # Phase D: wait for postgres + redis healthy ────────────────────────────
    with Step("Phase D: postgres healthcheck"):
        ok = await wait_pg_ready(pg_box)
        if not ok:
            raise RuntimeError("postgres never became ready")

    with Step("Phase E: redis healthcheck"):
        ok = await wait_redis_ready(redis_box)
        if not ok:
            raise RuntimeError("redis never became ready")

    # Phase F: host TCP probes (sanity, same as Phase 0) ───────────────────
    with Step(f"Phase F: host TCP probes (5432, 6379)"):
        if not await host_tcp_check("127.0.0.1", PG_HOST_PORT):
            raise RuntimeError(f"host cannot reach pg on {PG_HOST_PORT}")
        if not await host_tcp_check("127.0.0.1", REDIS_HOST_PORT):
            raise RuntimeError(f"host cannot reach redis on {REDIS_HOST_PORT}")

    # Phase G: prep client box (apk add redis + nc) ─────────────────────────
    with Step("Phase G: setup client box (apk add redis + nc)"):
        await setup_client_box(client_box)

    # Phase H: box → host → box TCP probes ──────────────────────────────────
    with Step(f"Phase H: client-box TCP probes to {HOST_GW} (host-as-hub)"):
        for port, label in [(PG_HOST_PORT, "postgres"), (REDIS_HOST_PORT, "redis")]:
            exit_code, stdout, stderr = await exec_collect(
                client_box, "nc", ["-zv", "-w", "3", HOST_GW, str(port)],
            )
            combined = (stdout + stderr).strip()
            print(f"    {label} ({HOST_GW}:{port}): exit={exit_code}, msg={combined!r}")
            if exit_code != 0:
                raise RuntimeError(
                    f"nc -z {HOST_GW}:{port} ({label}) failed: {combined}"
                )

    # Phase I: real protocol from client → pg (host-as-hub) ────────────────
    # Connection URI without password — server uses trust auth (see Phase A note).
    pg_uri = f"postgresql://postgres@{HOST_GW}:{PG_HOST_PORT}/postgres"
    with Step("Phase I: client-box psql → postgres via host-as-hub"):
        t0 = time.monotonic()
        exit_code, stdout, stderr = await exec_collect(
            client_box, "psql",
            [pg_uri, "-c", "SELECT 'dogfood works' AS msg, now() AS ts;"],
        )
        elapsed_ms = (time.monotonic() - t0) * 1000
        if exit_code != 0:
            raise RuntimeError(f"psql via host-as-hub failed: {stderr.strip()}")
        print(f"    round-trip via host-as-hub: {elapsed_ms:.0f}ms")
        print(f"    psql output:\n{stdout.rstrip()}")

    # Phase J: real protocol from client → redis (host-as-hub) ─────────────
    with Step("Phase J: client-box redis-cli → redis via host-as-hub"):
        t0 = time.monotonic()
        exit_code, stdout, stderr = await exec_collect(
            client_box, "redis-cli",
            ["-h", HOST_GW, "-p", str(REDIS_HOST_PORT), "PING"],
        )
        elapsed_ms = (time.monotonic() - t0) * 1000
        if exit_code != 0:
            raise RuntimeError(f"redis-cli via host-as-hub failed: {stderr.strip()}")
        if "PONG" not in stdout:
            raise RuntimeError(f"redis didn't return PONG: stdout={stdout!r}")
        print(f"    round-trip via host-as-hub: {elapsed_ms:.0f}ms")
        print(f"    redis-cli output: {stdout.strip()!r}")

    # Phase K: real write/read cross-service ───────────────────────────────
    with Step("Phase K: client-box writes via redis + reads via psql"):
        # Write a key in redis
        exit_code, _, stderr = await exec_collect(
            client_box, "redis-cli",
            [
                "-h", HOST_GW, "-p", str(REDIS_HOST_PORT),
                "SET", "dogfood:phase1", "ok",
            ],
        )
        if exit_code != 0:
            raise RuntimeError(f"redis SET failed: {stderr.strip()}")

        exit_code, stdout, stderr = await exec_collect(
            client_box, "redis-cli",
            ["-h", HOST_GW, "-p", str(REDIS_HOST_PORT), "GET", "dogfood:phase1"],
        )
        if exit_code != 0 or "ok" not in stdout:
            raise RuntimeError(f"redis GET failed: stdout={stdout!r}")
        print(f"    redis GET dogfood:phase1 → {stdout.strip()!r}")

        # Write a row in postgres (URI embeds the password)
        exit_code, stdout, stderr = await exec_collect(
            client_box, "psql",
            [
                pg_uri,
                "-c",
                "CREATE TABLE IF NOT EXISTS dogfood_phase1 (id serial, msg text);"
                "INSERT INTO dogfood_phase1 (msg) VALUES ('from client box');"
                "SELECT msg FROM dogfood_phase1;",
            ],
        )
        if exit_code != 0:
            raise RuntimeError(f"psql multi-stmt failed: {stderr.strip()}")
        print(f"    psql result snippet:\n{stdout.rstrip()}")

    # Phase L: detach verification (informational; full check needs Python exit) ─
    with Step("Phase L: assert all 3 boxes are in RUNNING state"):
        infos = await runtime.list_info()
        poc_boxes = {i.name: i for i in infos if i.name and i.name.endswith("-poc")}
        for name in (PG_NAME, REDIS_NAME, CLIENT_NAME):
            info = poc_boxes.get(name)
            if info is None:
                raise RuntimeError(f"box {name} missing from list_info")
            print(f"    {name}: state={info.state.status}, pid={info.state.pid}")
            if info.state.status.lower() != "running":
                raise RuntimeError(f"box {name} not running: {info.state.status}")

    print()
    print("=" * 70)
    print("✅ ALL CHECKS PASSED — multi-service + host-as-hub is FEASIBLE")
    print("=" * 70)
    print()
    print("Now manually verify detach=True survives Python exit:")
    print(f"  boxlite-cli list                                  # should show all 3 RUNNING")
    print(f"  boxlite-cli exec {CLIENT_NAME} -- redis-cli -h {HOST_GW} PING")
    print(f"  boxlite-cli exec {CLIENT_NAME} -- psql -h {HOST_GW} -U postgres -d postgres -c 'SELECT count(*) FROM dogfood_phase1;'")
    print()
    print(f"Or run the verifier subcommand (in fresh Python invocation):")
    print(f"  python {Path(__file__).name} --verify-detach")
    print()
    print("Cleanup:")
    print(f"  python {Path(__file__).name} --cleanup")
    print()
    return 0


# ─── detach verifier (called from a fresh Python invocation) ─────────────

async def run_verify_detach() -> int:
    """
    Re-list the boxes in a fresh Python process to prove they survived.
    If `detach=True` works, all 3 boxes should still be RUNNING here.
    """
    print("Verifying boxes survived Python exit (detach=True) ...")
    runtime = Boxlite.default()
    infos = await runtime.list_info()
    poc = {i.name: i for i in infos if i.name and i.name.endswith("-poc")}

    ok = True
    for name in (PG_NAME, REDIS_NAME, CLIENT_NAME):
        info = poc.get(name)
        if info is None:
            print(f"  ✗ {name}: MISSING")
            ok = False
            continue
        status = info.state.status
        marker = "✓" if status.lower() == "running" else "✗"
        print(f"  {marker} {name}: state={status}, pid={info.state.pid}")
        if status.lower() != "running":
            ok = False

    print()
    if ok:
        print("✅ detach=True WORKS — all 3 boxes survived Python exit")
        return 0
    else:
        print("❌ detach=True FAILED for at least one box")
        return 1


# ─── cleanup ─────────────────────────────────────────────────────────────

async def run_cleanup() -> int:
    runtime = Boxlite.default()
    print("Cleaning up all Phase 1 boxes ...")
    for name in (CLIENT_NAME, REDIS_NAME, PG_NAME):  # reverse order
        try:
            box = await runtime.get(name)
            try:
                await box.stop()
                print(f"  {name}: stopped")
            except Exception as e:
                print(f"  {name}: stop failed (may already be stopped): {e!r}")
            try:
                await runtime.remove(name)
                print(f"  {name}: removed")
            except Exception as e:
                print(f"  {name}: remove failed: {e!r}")
        except Exception as e:
            print(f"  {name}: not found ({e!r})")

    import shutil
    if DATA_ROOT.exists():
        shutil.rmtree(DATA_ROOT)
        print(f"  data dir wiped: {DATA_ROOT}")
    print("done.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument(
        "--cleanup", action="store_true",
        help="Stop and remove all Phase 1 boxes + data dir.",
    )
    parser.add_argument(
        "--verify-detach", action="store_true",
        help="In a fresh Python invocation, verify boxes are still RUNNING.",
    )
    args = parser.parse_args()

    if args.cleanup:
        return asyncio.run(run_cleanup())
    if args.verify_detach:
        return asyncio.run(run_verify_detach())

    try:
        return asyncio.run(run_poc())
    except Exception as e:
        print()
        print("=" * 70)
        print(f"❌ PoC FAILED: {type(e).__name__}: {e}")
        print("=" * 70)
        print()
        print("Troubleshooting:")
        print("  - Check state: boxlite-cli list")
        print("  - Per-box logs: boxlite-cli logs <name>")
        print(f"  - Clean slate: python {Path(__file__).name} --cleanup")
        return 1


if __name__ == "__main__":
    sys.exit(main())
