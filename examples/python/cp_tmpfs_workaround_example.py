"""
Workaround: copy files into tmpfs destinations (e.g. /tmp) inside a container.

copy_in() writes to the rootfs layer, so files destined for tmpfs mounts
are invisible to the running container. This is the same limitation as
`docker cp` (see https://github.com/moby/moby/issues/22020).

The fix is the same as Docker's recommendation: pipe a tar archive through
a command running inside the container's mount namespace, which sees tmpfs.

Requirements:
  pip install boxlite
"""

import asyncio
import io
import tarfile

from boxlite import SimpleBox


def make_tar(files: dict[str, bytes]) -> bytes:
    """Create an in-memory tar archive from a dict of {path: content}."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


async def main():
    async with SimpleBox("alpine:latest", name="tmpfs-cp-demo") as box:

        # --- The problem: copy_in to /tmp silently fails ---
        # Write a file on host, copy it into /tmp inside the container
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

        # Use low-level API to get stdin access (like: docker exec -i ... tar xf -)
        execution = await box._box.exec("tar", args=["xf", "-", "-C", "/tmp"])
        stdin = execution.stdin()
        await stdin.send_input(tar_data)
        await stdin.close()
        result = await execution.wait()
        print(f"tar via stdin:       exit={result.exit_code}")

        result = await box.exec("cat", "/tmp/hello.txt")
        print(f"read /tmp/hello.txt: {result.stdout.strip()}")


if __name__ == "__main__":
    asyncio.run(main())
