#!/usr/bin/env python3
"""
Copy files into and out of a box (docker-like cp).

Demonstrates four approaches:
  1. copy_in / copy_out via the native API (works for persistent filesystem paths)
  2. Tar-pipe workaround for tmpfs destinations (e.g. /tmp) — async
  3. Tar-pipe workaround — sync variant (requires boxlite[sync])
  4. File-to-file copy — copy a single file to a specific file path (with rename)

Background on tmpfs:
  copy_in() writes to the rootfs layer, so files destined for tmpfs mounts are
  invisible to the running container.  This is the same limitation as `docker cp`
  (see https://github.com/moby/moby/issues/22020).  The workaround pipes a tar
  archive through a process running inside the container's mount namespace.

Requirements:
  pip install boxlite
"""

import asyncio
import io
import tarfile
from pathlib import Path

from boxlite import Boxlite, BoxOptions, CopyOptions, SimpleBox


# ---------------------------------------------------------------------------
# Helper: create an in-memory tar archive
# ---------------------------------------------------------------------------

def make_tar(files: dict[str, bytes]) -> bytes:
    """Create an in-memory tar archive from a dict of {path: content}."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Example 1: copy_in / copy_out  (native API)
# ---------------------------------------------------------------------------

async def example_copy_in_out():
    """Round-trip a file via the native copy_in / copy_out API."""
    print("=== Example 1: copy_in / copy_out (native API) ===\n")

    rt = Boxlite.default()

    opts = BoxOptions(image="alpine:latest")
    box = await rt.create(opts, name="py-copy-demo")
    await box.start()

    # Prepare a host directory to copy in
    host_dir = Path("/tmp/boxlite_py_copy")
    host_dir.mkdir(parents=True, exist_ok=True)
    (host_dir / "hello.txt").write_text("hello from host\n")

    print("Copying into /app ...")
    await box.copy_in(str(host_dir), "/app", copy_options=CopyOptions())

    print("Listing files inside box ...")
    exec_handle = await box.exec("ls", args=["-l", "/app"])
    result = await exec_handle.wait()
    print("exit code:", result.exit_code)

    # Copy back out
    out_dir = Path("/tmp/boxlite_py_copy_out")
    if out_dir.exists():
        import shutil
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Copying back to host ...")
    await box.copy_out("/app", str(out_dir), copy_options=CopyOptions())
    roundtrip_path = out_dir / "app" / host_dir.name / "hello.txt"
    print("Round-trip file content:", roundtrip_path.read_text())

    await box.stop()


# ---------------------------------------------------------------------------
# Example 2: tar-pipe workaround for tmpfs destinations
# ---------------------------------------------------------------------------

async def example_tmpfs_workaround():
    """Copy files into tmpfs paths (e.g. /tmp) via stdin tar pipe."""
    print("\n=== Example 2: tmpfs workaround (tar via stdin) ===\n")

    async with SimpleBox("alpine:latest", name="tmpfs-cp-demo") as box:

        # --- The problem: copy_in to /tmp silently fails ---
        import tempfile, os
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            f.write("you won't see me\n")
            host_file = f.name

        try:
            await box.copy_in(host_file, "/tmp/ghost.txt")
            result = await box.exec("ls", "/tmp/ghost.txt")
            print(f"copy_in to /tmp:     exit={result.exit_code}  "
                  f"{'FOUND' if result.exit_code == 0 else 'NOT FOUND (expected)'}")
        finally:
            os.unlink(host_file)

        # --- The workaround: pipe tar through container process ---
        tar_data = make_tar({"hello.txt": b"visible!\n"})

        # TODO: Replace with public stdin API once available.
        # Currently requires the low-level _box handle for stdin access.
        execution = await box._box.exec("tar", args=["xf", "-", "-C", "/tmp"])
        stdin = execution.stdin()
        await stdin.send_input(tar_data)
        await stdin.close()
        result = await execution.wait()
        print(f"tar via stdin:       exit={result.exit_code}")

        result = await box.exec("cat", "/tmp/hello.txt")
        print(f"read /tmp/hello.txt: {result.stdout.strip()}")



# ---------------------------------------------------------------------------
# Example 3: sync version of the tmpfs workaround  (requires boxlite[sync])
# ---------------------------------------------------------------------------

def example_tmpfs_workaround_sync():
    """Synchronous version of the tmpfs tar-pipe workaround."""
    print("\n=== Example 3: tmpfs workaround – sync API ===\n")

    from boxlite import SyncSimpleBox

    with SyncSimpleBox("alpine:latest", name="sync-tmpfs-cp-demo") as box:
        tar_data = make_tar({"hello_sync.txt": b"visible from sync!\n"})

        # TODO: Replace with public stdin API once available.
        # Currently requires the low-level _box handle for stdin access.
        execution = box._box.exec("tar", ["xf", "-", "-C", "/tmp"])
        stdin = execution.stdin()
        stdin.send_input(tar_data)
        stdin.close()
        result = execution.wait()
        print(f"tar via stdin:       exit={result.exit_code}")

        result = box.exec("cat", "/tmp/hello_sync.txt")
        print(f"read /tmp/hello_sync.txt: {result.stdout.strip()}")


# ---------------------------------------------------------------------------
# Example 4: file-to-file copy (single file to a specific path)
# ---------------------------------------------------------------------------

async def example_file_to_file_copy():
    """Copy a single file to a specific file path, including rename.

    Docker-cp semantics:
      - copy_in("foo.py", "/app/bar.py")   → /app/bar.py  (file, renamed)
      - copy_in("foo.py", "/app/")          → /app/foo.py  (into directory)
      - copy_in("foo.py", "/app/existing/") → /app/existing/foo.py  (into dir)
    """
    print("\n=== Example 4: file-to-file copy (single file to path) ===\n")

    async with SimpleBox("alpine:latest", name="file-copy-demo") as box:
        # Prepare a host file
        host_dir = Path("/tmp/boxlite_file_copy")
        host_dir.mkdir(parents=True, exist_ok=True)
        (host_dir / "original.py").write_text('print("hello from original.py")\n')

        # --- 4a: Copy file to a specific file path (not a directory) ---
        # This creates /workspace/script.py as a FILE, not a directory.
        print("4a: Copy to specific file path ...")
        await box.copy_in(
            str(host_dir / "original.py"),
            "/workspace/script.py",
        )
        result = await box.exec("ls", "-la", "/workspace/script.py")
        print(f"  /workspace/script.py: {result.stdout.strip()}")
        result = await box.exec("test", "-f", "/workspace/script.py")
        print(f"  is regular file: {'yes' if result.exit_code == 0 else 'no'}")
        result = await box.exec("cat", "/workspace/script.py")
        print(f"  content: {result.stdout.strip()}")

        # --- 4b: Copy file with rename ---
        # Source is original.py, destination is renamed.py
        print("\n4b: Copy with rename ...")
        await box.copy_in(
            str(host_dir / "original.py"),
            "/workspace/renamed.py",
        )
        result = await box.exec("cat", "/workspace/renamed.py")
        print(f"  /workspace/renamed.py: {result.stdout.strip()}")

        # --- 4c: Copy file into a directory (trailing slash) ---
        # Trailing slash means "extract into this directory"
        print("\n4c: Copy into directory (trailing slash) ...")
        await box.exec("mkdir", "-p", "/workspace/scripts")
        await box.copy_in(
            str(host_dir / "original.py"),
            "/workspace/scripts/",
        )
        result = await box.exec("ls", "/workspace/scripts/")
        print(f"  /workspace/scripts/ contains: {result.stdout.strip()}")

        # --- 4d: Copy file into existing directory (no trailing slash) ---
        # When dest is an existing directory, file is placed inside it
        print("\n4d: Copy into existing directory (no trailing slash) ...")
        await box.exec("mkdir", "-p", "/workspace/libs")
        await box.copy_in(
            str(host_dir / "original.py"),
            "/workspace/libs",
        )
        result = await box.exec("ls", "/workspace/libs/")
        print(f"  /workspace/libs/ contains: {result.stdout.strip()}")

        # Summary
        print("\n  Summary of /workspace:")
        result = await box.exec("find", "/workspace", "-type", "f")
        for line in result.stdout.strip().split("\n"):
            print(f"    {line}")


async def main():
    await example_copy_in_out()
    await example_tmpfs_workaround()
    await example_file_to_file_copy()


if __name__ == "__main__":
    asyncio.run(main())

    # Sync variant (requires greenlet: pip install boxlite[sync])
    try:
        example_tmpfs_workaround_sync()
    except ImportError:
        print("\nSkipping sync example – install boxlite[sync] for greenlet support")

    print("\nKey Takeaways:")
    print("  - copy_in/copy_out work for persistent filesystem paths")
    print("  - For tmpfs destinations, pipe a tar archive via stdin")
    print("  - Sync API uses the same tar-pipe pattern (requires boxlite[sync])")
    print("  - File-to-file: copy_in('f.py', '/app/script.py') creates a file (not dir)")
    print("  - Trailing slash: copy_in('f.py', '/app/') copies into the directory")
    print("  - Existing dir: copy_in('f.py', '/app/existing_dir') copies into it")
