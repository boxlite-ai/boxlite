"""Package the pinned Linux x86_64 DinD kernel as a libkrunfw source directory."""

import argparse
import hashlib
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LINUX_KERNEL = "libkrunfw-kernel-dind-x86_64.bin"
LINUX_SHA256 = "3c6cfc8015a1ba05cebabecd37967d665f2a0f81424b69f8d43d6e87feaceb92"


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
    (output / "SHA256SUMS").write_text(
        "".join(
            f"{hashlib.sha256((output / name).read_bytes()).hexdigest()}  {name}\n"
            for name in [LINUX_KERNEL, "kernel.c", "Makefile"]
        )
    )
    print(f"Firmware source: {output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out_dir", type=Path, help="libkrunfw source output directory")
    prepare_linux(parser.parse_args().out_dir)
