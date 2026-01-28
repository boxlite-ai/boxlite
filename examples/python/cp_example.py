"""
Demonstrate docker-like cp using the Python SDK.

Requirements:
  pip install boxlite
"""

import asyncio
from pathlib import Path

from boxlite import Boxlite, BoxOptions, CopyOptions


async def main():
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


if __name__ == "__main__":
    asyncio.run(main())
