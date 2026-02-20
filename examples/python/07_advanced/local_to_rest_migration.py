#!/usr/bin/env python3
"""
Local-to-REST Migration Example

Demonstrates cross-backend portability:
- Create a box locally, write data, export to .boxlite archive
- Import the archive on a remote REST server
- Verify data is preserved across backends

This is the key use case for .boxlite archives: migrate boxes between
local development and remote production environments.

Prerequisites:
    make dev:python
"""

import asyncio
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import boxlite
from boxlite import Boxlite, BoxOptions, BoxliteRestOptions, Options


def find_free_port() -> int:
    """Find a random available TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def start_server(port: int) -> subprocess.Popen:
    """Start the reference server as a subprocess and wait until ready."""
    server_script = os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "openapi", "reference-server", "server.py"
    )
    server_script = os.path.abspath(server_script)

    proc = subprocess.Popen(
        [sys.executable, server_script, "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Poll until server is ready
    url = f"http://localhost:{port}/v1/config"
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return proc
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError(f"Reference server exited with code {proc.returncode}")
            time.sleep(0.3)

    proc.kill()
    raise RuntimeError("Reference server did not start within 15 seconds")


async def main():
    print("=" * 60)
    print("Local -> REST Migration")
    print("=" * 60)
    print("\nThis example exports a box from the local SDK and imports")
    print("it into a remote REST server, preserving all data.\n")

    # Start the reference server on a random port
    port = find_free_port()
    print(f"  Starting reference server on port {port}...")
    server_proc = start_server(port)
    print("  Server ready.\n")

    server_url = f"http://localhost:{port}"

    # Use a separate home directory for the local runtime to avoid
    # conflicting with the reference server (which also uses a local runtime).
    # Use /tmp for shorter paths — macOS has a SUN_LEN limit for Unix sockets.
    local_home = tempfile.mkdtemp(prefix="bl-", dir="/tmp")
    local_rt = Boxlite(Options(home_dir=local_home))
    rest_rt = Boxlite.rest(BoxliteRestOptions(
        url=server_url, client_id="test-client", client_secret="test-secret",
    ))

    source = None
    imported = None

    try:
        # --- Step 1: Create box locally and populate with data ---
        print("=== Step 1: Create Local Box ===")
        source = await local_rt.create(
            BoxOptions(image="alpine:latest", auto_remove=False),
            name="local-box",
        )
        print(f"  Created local box: {source.id}")

        # Write application data
        print("  Writing application data...")
        commands = [
            "mkdir -p /root/app",
            "echo 'DB_HOST=prod.example.com' > /root/app/config.env",
            "echo 'Hello from local box!' > /root/app/greeting.txt",
            "echo '42' > /root/app/state.dat",
        ]
        for cmd in commands:
            exec_handle = await source.exec("sh", ["-c", cmd])
            result = await exec_handle.wait()
            assert result.exit_code == 0, f"Command failed: {cmd}"

        print("  Data written")

        # --- Step 2: Export to portable archive ---
        print("\n=== Step 2: Export Archive ===")
        with tempfile.TemporaryDirectory() as export_dir:
            archive_path = await source.export(dest=export_dir)
            print(f"  Archive: {archive_path}")

            # Source still running after export
            print(f"  Source state: {source.info().state}")

            # --- Step 3: Import on REST server ---
            print("\n=== Step 3: Import on REST Server ===")
            imported = await rest_rt.import_box(archive_path, name="migrated-box")
            print(f"  Imported on REST: {imported.id}")

            imported_info = imported.info()
            print(f"  Name: {imported_info.name}")
            print(f"  State: {imported_info.state}")

        # --- Step 4: Verify data on remote (single exec to avoid connection issues) ---
        print("\n=== Step 4: Verify Data on Remote ===")
        verify_script = (
            "ls -la /root/app/ && echo '---' && "
            "cat /root/app/config.env && "
            "cat /root/app/greeting.txt && "
            "cat /root/app/state.dat"
        )
        exec_handle = await imported.exec("sh", ["-c", verify_script])
        stdout = exec_handle.stdout()
        output_lines = []
        async for line in stdout:
            stripped = line.strip()
            output_lines.append(stripped)
            print(f"  {stripped}")
        result = await exec_handle.wait()
        assert result.exit_code == 0, f"Verification failed with exit code {result.exit_code}"

        full_output = "\n".join(output_lines)
        assert "DB_HOST=prod.example.com" in full_output, "config.env not preserved"
        assert "Hello from local box!" in full_output, "greeting.txt not preserved"
        assert "42" in full_output, "state.dat not preserved"

        print("\n  All data preserved across local -> REST migration!")

    except Exception as e:
        print(f"\n  Error: {e}")
        raise

    finally:
        # Cleanup
        if imported is not None:
            try:
                await rest_rt.remove(imported.id, force=True)
            except Exception:
                pass
        if source is not None:
            try:
                await source.stop()
            except Exception:
                pass
            try:
                await local_rt.remove(source.id, force=True)
            except Exception:
                pass
        server_proc.terminate()
        server_proc.wait(timeout=5)

    print("\n" + "=" * 60)
    print("Migration complete!")
    print("\nKey Takeaways:")
    print("  - .boxlite archives are portable across backends")
    print("  - Export from local SDK, import on REST server (or vice versa)")
    print("  - All rootfs data is preserved in the archive")
    print("  - PauseGuard auto-quiesces the VM during export for consistency")


if __name__ == "__main__":
    asyncio.run(main())
