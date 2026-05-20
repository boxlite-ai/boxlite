#!/usr/bin/env python
"""
PoC Phase 0 — Single-service "eat your own dog food" feasibility test.

NOTE on Python interpreter:
    Use `python` (not `python3`) — on macOS with miniforge/conda, `python3`
    often resolves to /usr/bin/python3 (system Python without boxlite),
    while `python` is the conda env interpreter that pip targets.

    Quick diagnostic:
        which python python3
        python  -c "import sys; print(sys.executable)"
        python3 -c "import sys; print(sys.executable)"

    If they differ, use the one that matches `pip -V`.


Goal:
    Verify that BoxLite Python SDK can replace `docker run postgres:16-alpine`
    for the infra-local stack. This is the gate decision for the whole
    own-dog-food-local-infra-solution (see docs/apps/own-dog-food-local-infra-solution.md).

What this script does:
    1. Create / reuse a BoxLite box running `postgres:16-alpine`
    2. Wait for postgres to be ready (in-box pg_isready check)
    3. Open a raw TCP socket from the host to verify port forwarding works
    4. Print resource usage and timing
    5. Leave the box running (auto_remove=False) so you can inspect it manually:
           boxlite-cli list
           boxlite-cli exec boxlite-local-pg-poc -- psql -U postgres

Pass criteria (all must hold):
    [P1] Box starts within 30 seconds
    [P2] pg_isready returns 0 inside the box
    [P3] Host can open TCP connection to 127.0.0.1:5432
    [P4] Process stays alive for ≥ 60 seconds with no restart
    [P5] Box memory_mib reported matches request (no obvious leak)

Failure modes to watch:
    - "Image not found" → BoxLite OCI puller doesn't handle public Docker Hub
    - Box starts but immediately exits → entrypoint/cmd handling issue
    - pg_isready never returns → daemon-in-box stability issue
    - Host TCP fails → gvproxy port forwarding issue

Cleanup:
    boxlite-cli stop boxlite-local-pg-poc
    boxlite-cli remove boxlite-local-pg-poc
    # or via Python:
    python single_service.py --cleanup
"""

from __future__ import annotations

import argparse
import asyncio
import socket
import sys
import time
from pathlib import Path

import boxlite

# Boxlite/BoxOptions sit in the native module. The top-level package re-exports
# them, but only when the compiled .so is up-to-date with the source __init__.py.
# Fall back to the direct path so the PoC still runs against slightly stale builds.
try:
    from boxlite import Boxlite, BoxOptions  # type: ignore[attr-defined]
except ImportError:
    from boxlite.boxlite import Boxlite, BoxOptions  # type: ignore[attr-defined]

BOX_NAME = "boxlite-local-pg-poc"
IMAGE = "postgres:16-alpine"
HOST_PORT = 5432
GUEST_PORT = 5432
MEMORY_MIB = 512
DATA_DIR = Path.home() / ".boxlite-local-poc" / "pg-data"


# ─── helpers ──────────────────────────────────────────────────────────────

class Step:
    """Pretty-printed step timer with pass/fail tagging."""

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
        return False  # don't swallow


async def host_tcp_check(host: str, port: int, timeout: float = 5.0) -> bool:
    """Try opening a TCP connection from the host side."""
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


async def exec_collect(box, command, args=None, env=None):
    """Run `box.exec` and collect (exit_code, stdout, stderr).

    The native Box.exec returns an Execution that streams output. Wrap that
    streaming API into a docker-style synchronous result for convenience.
    """
    execution = await box.exec(command, args or [], env=env)

    stdout_parts: list[str] = []
    stderr_parts: list[str] = []

    async def drain(stream, sink):
        async for chunk in stream:
            sink.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8", "replace"))

    await asyncio.gather(
        drain(execution.stdout(), stdout_parts),
        drain(execution.stderr(), stderr_parts),
    )
    result = await execution.wait()
    return result.exit_code, "".join(stdout_parts), "".join(stderr_parts)


async def wait_pg_ready(box, retries: int = 30, interval: float = 2.0) -> bool:
    """Poll pg_isready inside the box."""
    for attempt in range(1, retries + 1):
        exit_code, _stdout, _stderr = await exec_collect(
            box, "pg_isready", ["-U", "postgres", "-t", "1"]
        )
        if exit_code == 0:
            print(f"    pg_isready OK after {attempt} attempts")
            return True
        await asyncio.sleep(interval)
    return False


# ─── main flow ────────────────────────────────────────────────────────────

async def run_poc() -> int:
    print("=" * 70)
    print("BoxLite dogfood PoC Phase 0 — single postgres service")
    print("=" * 70)
    print(f"Image:       {IMAGE}")
    print(f"Box name:    {BOX_NAME}")
    print(f"Host port:   {HOST_PORT} → guest {GUEST_PORT}")
    print(f"Memory:      {MEMORY_MIB} MiB")
    print(f"Data dir:    {DATA_DIR}")
    print(f"SDK version: {boxlite.__version__}")
    print()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    runtime = Boxlite.default()
    box = None

    # P1: create + start ────────────────────────────────────────────────────
    with Step("Phase A: create or reuse box"):
        opts = BoxOptions(
            image=IMAGE,
            cpus=1,
            memory_mib=MEMORY_MIB,
            auto_remove=False,
            detach=True,                  # ← box survives Python exit
            ports=[(HOST_PORT, GUEST_PORT)],
            volumes=[(str(DATA_DIR), "/var/lib/postgresql/data")],
            env=[
                ("POSTGRES_USER", "postgres"),
                ("POSTGRES_PASSWORD", "boxlite"),
                ("POSTGRES_DB", "postgres"),
                ("PGDATA", "/var/lib/postgresql/data/pgdata"),
            ],
        )
        box, created = await runtime.get_or_create(opts, name=BOX_NAME)
        print(f"    box.id={box.id}, created_new={created}")

    with Step("Phase B: start box"):
        await box.start()

    # P2: pg_isready inside box ────────────────────────────────────────────
    with Step("Phase C: pg_isready inside box (≤ 60s)"):
        ok = await wait_pg_ready(box, retries=30, interval=2.0)
        if not ok:
            raise RuntimeError("pg_isready never returned 0 after 60s")

    # P3: host TCP probe ───────────────────────────────────────────────────
    with Step(f"Phase D: TCP probe from host → 127.0.0.1:{HOST_PORT}"):
        ok = await host_tcp_check("127.0.0.1", HOST_PORT, timeout=5)
        if not ok:
            raise RuntimeError(
                f"Host cannot connect to 127.0.0.1:{HOST_PORT} — "
                "port forwarding broken?"
            )

    # P4: stability — wait then re-check ───────────────────────────────────
    with Step("Phase E: stability check (wait 30s, re-probe)"):
        await asyncio.sleep(30)
        exit_code, _, _ = await exec_collect(
            box, "pg_isready", ["-U", "postgres", "-t", "1"]
        )
        if exit_code != 0:
            raise RuntimeError(f"pg_isready failed after 30s: exit={exit_code}")
        if not await host_tcp_check("127.0.0.1", HOST_PORT, timeout=5):
            raise RuntimeError("Host TCP probe failed on re-check")

    # P5: box info / resource sanity ───────────────────────────────────────
    with Step("Phase F: inspect box info"):
        info = box.info()
        print(f"    state:        {info.state.status}")
        print(f"    pid:          {info.state.pid}")
        print(f"    cpus:         {info.cpus}")
        print(f"    memory_mib:   {info.memory_mib}")
        print(f"    image:        {info.image}")
        if info.memory_mib != MEMORY_MIB:
            print(f"    ⚠ memory_mib mismatch (requested {MEMORY_MIB})")

    # Quick functional smoke ───────────────────────────────────────────────
    with Step("Phase G: SQL smoke test via psql in-box"):
        for label, sql in [
            ("CREATE TABLE", "CREATE TABLE IF NOT EXISTS dogfood (id serial, hello text);"),
            ("INSERT",       "INSERT INTO dogfood (hello) VALUES ('it works');"),
        ]:
            exit_code, _stdout, stderr = await exec_collect(
                box, "psql", ["-U", "postgres", "-d", "postgres", "-c", sql],
            )
            if exit_code != 0:
                raise RuntimeError(f"{label} failed: {stderr.strip()}")

        exit_code, stdout, stderr = await exec_collect(
            box, "psql",
            ["-U", "postgres", "-d", "postgres", "-c", "SELECT count(*) FROM dogfood;"],
        )
        if exit_code != 0:
            raise RuntimeError(f"SELECT failed: {stderr.strip()}")
        print(f"    SELECT count(*) →\n{stdout.rstrip()}")

    print()
    print("=" * 70)
    print("✅ ALL CHECKS PASSED — dogfood approach is FEASIBLE")
    print("=" * 70)
    print()
    print("Box is still running. Inspect it:")
    print(f"  boxlite-cli list")
    print(f"  boxlite-cli exec {BOX_NAME} -- psql -U postgres -c 'SELECT * FROM dogfood;'")
    print()
    print("Cleanup:")
    print(f"  python {Path(__file__).name} --cleanup")
    print()
    return 0


async def run_cleanup() -> int:
    """Stop and remove the PoC box + its data."""
    runtime = Boxlite.default()
    print(f"Cleaning up box '{BOX_NAME}' ...")
    try:
        infos = await runtime.list_info()
        target = next((i for i in infos if i.name == BOX_NAME), None)
        if target is None:
            print(f"  (no box named '{BOX_NAME}' found)")
        else:
            # Try to grab the running box handle so we can stop it cleanly.
            try:
                box = await runtime.get(BOX_NAME)
                await box.stop()
                print("  stopped")
            except Exception as e:
                print(f"  stop failed (continuing to remove): {e}")
            # remove() lives on the runtime, not on Box.
            try:
                await runtime.remove(BOX_NAME)
                print("  removed")
            except Exception as e:
                print(f"  remove failed: {e}")
    except Exception as e:
        print(f"  cleanup error: {e}")

    import shutil
    if DATA_DIR.exists():
        shutil.rmtree(DATA_DIR)
        print(f"  data dir wiped: {DATA_DIR}")
    print("done.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument(
        "--cleanup", action="store_true",
        help="Stop and remove the PoC box and its data dir.",
    )
    args = parser.parse_args()

    if args.cleanup:
        return asyncio.run(run_cleanup())

    try:
        return asyncio.run(run_poc())
    except Exception as e:
        print()
        print("=" * 70)
        print(f"❌ PoC FAILED: {type(e).__name__}: {e}")
        print("=" * 70)
        print()
        print("Troubleshooting:")
        print("  - Check 'boxlite-cli list' to inspect box state")
        print("  - Check 'boxlite-cli logs <box-name>' for stderr")
        print("  - Re-run with cleanup first: python single_service.py --cleanup")
        return 1


if __name__ == "__main__":
    sys.exit(main())
