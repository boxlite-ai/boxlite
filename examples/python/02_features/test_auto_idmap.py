#!/usr/bin/env python3
"""
Test auto-idmap with non-root container user.

Verifies that when a container runs as a non-root user (e.g., uid=1000),
host-mounted volumes owned by a different UID (e.g., macOS uid=501) are
automatically remapped so the container user can read and write.
"""

import asyncio
import os
import tempfile

import boxlite


async def main():
    print("Auto-Idmap Test: Non-Root Container User")
    print("=" * 55)

    with tempfile.TemporaryDirectory() as tmp_dir:
        # Create test files on host
        test_file = os.path.join(tmp_dir, "host_file.txt")
        with open(test_file, "w") as f:
            f.write("hello from host\n")

        # Get host file ownership
        st = os.stat(test_file)
        host_uid = st.st_uid
        host_gid = st.st_gid
        print(f"\nHost file: {test_file}")
        print(f"Host owner: uid={host_uid} gid={host_gid}")

        # Use alpine and create a non-root user inside
        print("\n--- Test: Container with non-root user (uid=1000) ---")

        async with boxlite.SimpleBox(
            image="alpine:latest",
            volumes=[(tmp_dir, "/workspace")],
        ) as box:
            # Create a non-root user (uid=1000)
            result = await box.exec("adduser", "-D", "-u", "1000", "appuser")
            print(f"Created user: exit={result.exit_code}")

            # Check file ownership from root
            print("\n[Before] File ownership (root perspective):")
            result = await box.exec(
                "stat", "-c", "  %n uid=%u gid=%g",
                "/workspace/host_file.txt"
            )
            print(result.stdout.strip())

            # Run as the non-root user
            print("\n[Test] Running as appuser (uid=1000):")
            result = await box.exec("id", user="1000")
            print(f"  {result.stdout.strip()}")

            # Can appuser read the file?
            result = await box.exec(
                "cat", "/workspace/host_file.txt",
                user="1000"
            )
            read_ok = result.exit_code == 0
            print(f"  Read:  exit={result.exit_code} "
                  f"{'OK' if read_ok else 'FAIL'}")

            # Can appuser write a new file?
            result = await box.exec(
                "sh", "-c",
                "echo 'written by appuser' > /workspace/from_appuser.txt",
                user="1000"
            )
            write_ok = result.exit_code == 0
            print(f"  Write: exit={result.exit_code} "
                  f"{'OK' if write_ok else 'FAIL'}")
            if not write_ok:
                print(f"  stderr: {result.stderr.strip()}")

            # Can appuser create a directory?
            result = await box.exec(
                "mkdir", "/workspace/appuser_dir",
                user="1000"
            )
            mkdir_ok = result.exit_code == 0
            print(f"  Mkdir: exit={result.exit_code} "
                  f"{'OK' if mkdir_ok else 'FAIL'}")
            if not mkdir_ok:
                print(f"  stderr: {result.stderr.strip()}")

            # Check host-side ownership of guest-created file
            appuser_file = os.path.join(tmp_dir, "from_appuser.txt")
            if os.path.exists(appuser_file):
                file_st = os.stat(appuser_file)
                print(f"\n[Host] from_appuser.txt: "
                      f"uid={file_st.st_uid} gid={file_st.st_gid}")
                with open(appuser_file) as f:
                    print(f"  content: {f.read().strip()}")
            else:
                print("\n[Host] from_appuser.txt: NOT FOUND")

            # Show ownership from appuser perspective
            print("\n[Inside] Ownership from appuser perspective:")
            result = await box.exec(
                "stat", "-c", "  %n uid=%u gid=%g",
                "/workspace/host_file.txt",
                user="1000"
            )
            print(result.stdout.strip())

    print(f"\n{'=' * 55}")
    print("Result:")
    if write_ok:
        print("  AUTO-IDMAP WORKING: non-root user can write to volume")
    else:
        print("  AUTO-IDMAP NOT ACTIVE: non-root user cannot write")
        print(f"  (host uid={host_uid}, container uid=1000)")


if __name__ == "__main__":
    asyncio.run(main())
