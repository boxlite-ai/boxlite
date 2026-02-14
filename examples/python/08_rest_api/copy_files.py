#!/usr/bin/env python3
"""
Upload files to a box via the REST API.

Demonstrates:
- box.copy_in() to upload files from host into the box rootfs
- Files must be copied BEFORE starting the box (rootfs layer)
- Verifying uploaded files via command execution

Note: When uploading a directory, its CONTENTS are placed at the
destination (not the directory itself). For example, uploading
a directory containing hello.txt to /opt results in /opt/hello.txt.

Prerequisites:
    make dev:python
    cd openapi/reference-server && uv run --active server.py --port 8080
"""

import asyncio
import os
import tempfile

from boxlite import Boxlite, BoxOptions, BoxliteRestOptions


SERVER_URL = "http://localhost:8080"


def connect() -> Boxlite:
    return Boxlite.rest(BoxliteRestOptions(
        url=SERVER_URL, client_id="test-client", client_secret="test-secret",
    ))


async def main():
    print("=" * 50)
    print("REST API: File Transfer")
    print("=" * 50)

    rt = connect()

    opts = BoxOptions(image="alpine:latest", auto_remove=False)
    box = await rt.create(opts, name="copy-demo")
    print(f"  Created box: {box.id}")

    with tempfile.TemporaryDirectory() as tmpdir:
        # --- Create local files ---
        print("\n=== Prepare Local Files ===")
        app_dir = os.path.join(tmpdir, "myapp")
        os.makedirs(app_dir)

        with open(os.path.join(app_dir, "hello.txt"), "w") as f:
            f.write("Hello from the host!\n")
        with open(os.path.join(app_dir, "config.json"), "w") as f:
            f.write('{"port": 8080, "debug": true}\n')

        print(f"  Created: {os.listdir(app_dir)}")

        # --- Upload directory contents (before starting) ---
        # Directory contents land at the destination path:
        #   myapp/ contains hello.txt, config.json
        #   copy_in(myapp, "/opt/app") -> /opt/app/hello.txt, /opt/app/config.json
        print("\n=== Upload Directory (copy_in) ===")
        await box.copy_in(app_dir, "/opt/app")
        print("  Uploaded myapp/ contents -> /opt/app/")

        # --- Upload a single file ---
        print("\n=== Upload Single File ===")
        motd = os.path.join(tmpdir, "motd.txt")
        with open(motd, "w") as f:
            f.write("Welcome to BoxLite!\n")

        await box.copy_in(motd, "/etc")
        print("  Uploaded motd.txt -> /etc/motd.txt")

        # --- Start and verify ---
        print("\n=== Start and Verify ===")
        await box.start()
        print("  Box started")

        # Verify directory upload
        run = await box.exec("cat", args=["/opt/app/hello.txt"])
        stdout = run.stdout()
        async for line in stdout:
            print(f"  /opt/app/hello.txt: {line}")
        await run.wait()

        run = await box.exec("cat", args=["/opt/app/config.json"])
        stdout = run.stdout()
        async for line in stdout:
            print(f"  /opt/app/config.json: {line}")
        await run.wait()

        # Verify single file upload
        run = await box.exec("cat", args=["/etc/motd.txt"])
        stdout = run.stdout()
        async for line in stdout:
            print(f"  /etc/motd.txt: {line}")
        await run.wait()

    # --- Cleanup ---
    await rt.remove(box.id, force=True)
    print(f"\n  Cleaned up box {box.id}")
    print("\n  Done")


if __name__ == "__main__":
    asyncio.run(main())
