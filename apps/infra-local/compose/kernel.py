"""Prepare pinned DinD firmware for the local runtime."""

import asyncio
import hashlib
import platform
import subprocess
import sys
import urllib.request

from .acceptance import ROOT, STATE
from .config import worktree_home

IMAGE = "ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55"
LINUX_KERNEL = "libkrunfw-kernel-dind-x86_64.bin"
LINUX_SHA256 = "3c6cfc8015a1ba05cebabecd37967d665f2a0f81424b69f8d43d6e87feaceb92"


def prepare_linux():
    """Package the published ELF kernel using libkrunfw's own ABI generator."""
    output = STATE / "firmware"
    output.mkdir(parents=True, exist_ok=True)
    kernel = output / LINUX_KERNEL
    if not kernel.exists():
        url = (
            "https://github.com/boxlite-ai/libkrunfw/releases/download/v5.4.0/"
            + LINUX_KERNEL
        )
        partial = kernel.with_suffix(".part")
        with urllib.request.urlopen(url, timeout=120) as response:
            partial.write_bytes(response.read())
        if hashlib.sha256(partial.read_bytes()).hexdigest() != LINUX_SHA256:
            raise RuntimeError("DinD release kernel SHA256 mismatch")
        partial.replace(kernel)
    if hashlib.sha256(kernel.read_bytes()).hexdigest() != LINUX_SHA256:
        raise RuntimeError("Cached DinD release kernel SHA256 mismatch")
    generator = ROOT / "src/deps/libkrun-sys/vendor/libkrunfw/bin2cbundle.py"
    subprocess.run(
        [
            sys.executable,
            str(generator),
            "--os",
            "Linux",
            "-t",
            "vmlinux",
            str(kernel),
            str(output / "kernel.c"),
        ],
        check=True,
        timeout=180,
    )
    # No kernel build prerequisites: the downloaded ELF is the exact boot input.
    (output / "Makefile").write_text(
        ".PHONY: all install\nall:\n"
        "\t$(CC) -fPIC -shared -nostdlib -DABI_VERSION=5 "
        "-Wl,-soname,libkrunfw.so.5 -o libkrunfw.so.5 kernel.c\n"
        'install:\n\tmkdir -p "$(PREFIX)/lib64"\n'
        '\tcp libkrunfw.so.5 "$(PREFIX)/lib64/"\n'
    )
    (output / "SHA256SUMS").write_text(
        "".join(
            f"{hashlib.sha256((output / name).read_bytes()).hexdigest()}  {name}\n"
            for name in [LINUX_KERNEL, "kernel.c", "Makefile"]
        )
    )
    print(f"Firmware source: {output}", flush=True)


async def build():
    if platform.system() == "Linux" and platform.machine() == "x86_64":
        prepare_linux()
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
