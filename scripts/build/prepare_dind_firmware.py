"""Prepare DinD firmware for Linux x86_64 and Apple Silicon runtimes."""

import argparse
import asyncio
import hashlib
import os
import platform
import subprocess
import sys
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LINUX_KERNEL = "libkrunfw-kernel-dind-x86_64.bin"
LINUX_SHA256 = "3c6cfc8015a1ba05cebabecd37967d665f2a0f81424b69f8d43d6e87feaceb92"
BUILDER_IMAGE = "ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55"


def prepare_linux(output: Path):
    """Verify the published ELF, then package it with the vendored ABI generator."""
    output = output.resolve()
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
    print(f"Firmware source: {output}", flush=True)


async def prepare_macos(output: Path, home: Path | None, jobs: int, proxy: str | None):
    """Build the ARM kernel on a guest disk, then package its source on macOS."""
    import boxlite

    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    home = (home or output / "builder-home").resolve()
    env = []
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        value = proxy or os.environ.get(name)
        if value:
            env.append((name, value))
    for name in ("NO_PROXY", "no_proxy"):
        if value := os.environ.get(name):
            env.append((name, value))
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(home)))
    box = await runtime.create(
        boxlite.BoxOptions(
            image=BUILDER_IMAGE,
            cpus=2,
            memory_mib=3072,
            disk_size_gb=8,
            detach=True,
            auto_remove=False,
            env=env,
            volumes=[(str(ROOT), "/src", True), (str(output), "/out")],
            entrypoint=["sleep"],
            cmd=["infinity"],
        ),
        name="dind-kernel-builder-" + uuid.uuid4().hex[:8],
    )
    (output / "builder-id").write_text(box.id + "\n")
    log_path = output / f"builder-{box.id}.log"
    log_path.write_text(f"Builder {box.id}; home={home}\n")
    print(f"Builder {box.id}; home={home}; log={log_path}", flush=True)
    try:
        await asyncio.wait_for(box.start(), timeout=300)
        execution = await box.exec(
            "bash",
            ["/src/scripts/build/build-dind-kernel.sh", str(jobs)],
            timeout_secs=7200,
        )
        with log_path.open("a") as log:

            async def drain(stream):
                async for chunk in stream:
                    log.write(chunk)
                    log.flush()
                    print(chunk, end="", flush=True)

            async def finish():
                await asyncio.gather(
                    drain(execution.stdout()), drain(execution.stderr())
                )
                return await execution.wait()

            result = await asyncio.wait_for(finish(), timeout=7200)
        if result.exit_code:
            raise RuntimeError(
                f"Kernel build exited {result.exit_code}; see {log_path}"
            )
        (output / "Makefile").write_text(
            ".PHONY: all install\nall:\n"
            "\t$(CC) -fPIC -shared -DABI_VERSION=5 "
            "-o libkrunfw.5.dylib kernel.c\n"
            'install:\n\tmkdir -p "$(PREFIX)/lib"\n'
            '\tcp libkrunfw.5.dylib "$(PREFIX)/lib/"\n'
            '\tln -sf libkrunfw.5.dylib "$(PREFIX)/lib/libkrunfw.dylib"\n'
        )
    except BaseException as error:
        with log_path.open("a") as log:
            log.write(f"{type(error).__name__}: {error}\n")
        try:
            await asyncio.wait_for(box.stop(), timeout=60)
        except Exception as error:  # noqa: BLE001 - Keep the build failure and report cleanup.
            print(f"Builder {box.id} stop failed: {error}", file=sys.stderr)
        print(f"Builder {box.id} retained; home={home}; log={log_path}", flush=True)
        raise
    await runtime.remove(box.id, force=True)
    print(f"Firmware source: {output}", flush=True)


def positive_jobs(value):
    jobs = int(value)
    if jobs < 1:
        raise argparse.ArgumentTypeError("jobs must be a positive integer")
    return jobs


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out_dir", type=Path, help="libkrunfw source output directory")
    parser.add_argument(
        "--home", type=Path, help="builder runtime home; default: OUT_DIR/builder-home"
    )
    parser.add_argument(
        "--jobs",
        type=positive_jobs,
        default=2,
        help="kernel build parallelism (default: 2)",
    )
    parser.add_argument(
        "--download-proxy", help="optional guest package/source download proxy"
    )
    args = parser.parse_args()
    host = (platform.system(), platform.machine())
    if host == ("Linux", "x86_64"):
        prepare_linux(args.out_dir)
    elif host == ("Darwin", "arm64"):
        asyncio.run(
            prepare_macos(args.out_dir, args.home, args.jobs, args.download_proxy)
        )
    else:
        parser.error(
            "DinD firmware preparation supports Linux x86_64 and Apple Silicon macOS"
        )
