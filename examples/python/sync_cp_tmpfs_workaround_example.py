"""
Workaround (sync): copy files into tmpfs destinations inside a container.

Synchronous version of cp_tmpfs_workaround_example.py.
See that file for background on the tmpfs limitation.

Requirements:
  pip install boxlite[sync]
"""

import io
import os
import tarfile
import tempfile

from boxlite import SyncSimpleBox


def make_tar(files: dict[str, bytes]) -> bytes:
    """Create an in-memory tar archive from a dict of {path: content}."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def main():
    with SyncSimpleBox("alpine:latest", name="sync-tmpfs-cp-demo") as box:

        # --- The problem: copy_in to /tmp silently fails ---
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            f.write("you won't see me\n")
            host_file = f.name

        try:
            # SyncSimpleBox doesn't expose copy_in directly; use the
            # underlying SyncBox._sync helper to call PyBox.copy_in.
            box._box._sync(box._box._box.copy_in(host_file, "/tmp/ghost.txt"))
            result = box.exec("ls", "/tmp/ghost.txt")
            print(f"copy_in to /tmp:     exit={result.exit_code}  "
                  f"{'FOUND' if result.exit_code == 0 else 'NOT FOUND (expected)'}")
        finally:
            os.unlink(host_file)

        # --- The workaround: pipe tar through container process ---
        tar_data = make_tar({"hello.txt": b"visible!\n"})

        # Use low-level SyncBox to get stdin access
        execution = box._box.exec("tar", ["xf", "-", "-C", "/tmp"])
        stdin = execution.stdin()
        stdin.send_input(tar_data)
        stdin.close()
        result = execution.wait()
        print(f"tar via stdin:       exit={result.exit_code}")

        result = box.exec("cat", "/tmp/hello.txt")
        print(f"read /tmp/hello.txt: {result.stdout.strip()}")


if __name__ == "__main__":
    main()
