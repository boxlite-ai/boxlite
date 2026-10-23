"""Prepare pinned DinD firmware for the local runtime."""

import asyncio
import platform
import subprocess
import sys

from .acceptance import ROOT, STATE
from .config import worktree_home

IMAGE = "ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55"


async def build():
    if platform.system() == "Linux" and platform.machine() == "x86_64":
        await asyncio.to_thread(
            subprocess.run,
            [
                sys.executable,
                str(ROOT / "scripts/build/prepare_dind_firmware.py"),
                str(STATE / "firmware"),
            ],
            check=True,
            timeout=360,
        )
        return

    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError(
            "DinD firmware preparation supports Linux x86_64 and Apple Silicon macOS"
        )
    import boxlite

    output = STATE / "firmware"
    output.mkdir(parents=True, exist_ok=True)
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(worktree_home(ROOT, "qk"))))
    box = await runtime.get("dind-kernel-builder")
    if box is None:
        box = await runtime.create(
            boxlite.BoxOptions(
                image=IMAGE,
                cpus=4,
                memory_mib=3072,
                disk_size_gb=8,
                detach=True,
                auto_remove=False,
                volumes=[(str(ROOT), "/src", True), (str(output), "/out")],
                entrypoint=["sleep"],
                cmd=["infinity"],
            ),
            name="dind-kernel-builder",
        )
    (STATE / "kernel-builder-id").write_text(box.id)
    info = await box.info()
    if info.state != "running":
        await asyncio.wait_for(box.start(), timeout=300)
    print(f"Builder {box.id} running; failures retain its disk", flush=True)
    execution = await box.exec("bash", ["/src/scripts/build/build-dind-kernel.sh"])

    async def drain(stream):
        async for chunk in stream:
            print(chunk, end="", flush=True)

    async def finish():
        await asyncio.gather(drain(execution.stdout()), drain(execution.stderr()))
        return await execution.wait()

    result = await asyncio.wait_for(finish(), timeout=7200)
    if result.exit_code:
        raise RuntimeError(
            f"Kernel build failed {result.exit_code}; builder {box.id} retained"
        )
    await runtime.remove(box.id, force=True)
    print(f"Firmware source: {output}", flush=True)


if __name__ == "__main__":
    asyncio.run(build())
