#!/usr/bin/env python3
"""Exercise the boot-artifact build entry point without starting Docker."""

import hashlib
import os
from pathlib import Path
import shlex
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "scripts/build/build-vmm-boot.sh"
BUILD_TIMEOUT_SECONDS = 1800
ARTIFACTS = (
    "vmlinux", "bzImage", "test-initramfs.cpio", "kernel.config", "build-info.txt",
)


class BuildEntrypointTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="boxlite boot contracts ")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.arguments = self.path / "arguments"
        docker = self.path / "docker"
        docker.write_text(
            '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_ARGUMENTS"\n'
            'exit "${DOCKER_STATUS:-0}"\n'
        )
        docker.chmod(0o755)
        self.environment = {
            **os.environ,
            "PATH": f"{self.path}{os.pathsep}{os.environ['PATH']}",
            "DOCKER_ARGUMENTS": str(self.arguments),
        }

    def invoke(self, *arguments):
        return subprocess.run(
            ["bash", str(BUILD), *arguments],
            cwd=self.path,
            env=self.environment,
            text=True,
            capture_output=True,
            timeout=10,
        )

    def test_default_build_uses_repository_paths_from_another_directory(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.arguments.read_text().splitlines(),
            [
                "buildx", "build", "--target", "artifacts", "--output",
                f"type=local,dest={ROOT}/target/vmm/boot/x86_64",
                str(ROOT / "src/vmm/boot"),
            ],
        )

    def test_rebuild_preserves_literal_output_path(self):
        output = self.path / "artifacts $(touch unexpected)"
        result = self.invoke("--output", str(output), "--rebuild")
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = self.arguments.read_text().splitlines()
        self.assertIn(f"type=local,dest={output}", arguments)
        self.assertEqual(arguments[4:6], ["--no-cache-filter", "build"])
        self.assertFalse((self.path / "unexpected").exists())

    def test_invalid_arguments_never_start_docker(self):
        for arguments in [
            ("--output",), ("--output", ""), ("--unknown",),
            ("--output", "a,b"), ("--output", 'a"b'), ("--output", "a\nb"),
            ("--output", "a\rb"),
        ]:
            with self.subTest(arguments=arguments):
                result = self.invoke(*arguments)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(self.arguments.exists())

    def test_docker_failure_does_not_report_success(self):
        self.environment["DOCKER_STATUS"] = "42"
        result = self.invoke()
        self.assertEqual(result.returncode, 42)
        self.assertNotIn("Boot artifacts:", result.stdout)

    def test_build_timeout_terminates_the_process_group(self):
        child = self.path / "build-child.py"
        child.write_text(
            "import os, socket\n"
            "client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
            "client.connect(os.environ['BOXLITE_BUILD_GROUP_TEST_SOCKET'])\n"
            "client.recv(1)\n"
            "client.sendall(b'alive')\n"
        )
        builder = self.path / "build.sh"
        builder.write_text(f"#!/bin/sh\npython3 {shlex.quote(str(child))} &\nwait\n")
        builder.chmod(0o755)
        checks = (qualify_artifacts, check_reproducibility)

        for check in checks:
            with self.subTest(check=check.__name__):
                socket_path = Path(tempfile.gettempdir()) / (
                    f"blt-{os.getpid()}-{check.__name__}.sock"
                )
                socket_path.unlink(missing_ok=True)
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                    listener.bind(str(socket_path))
                    listener.listen(1)
                    listener.settimeout(0.5)
                    actual_run = subprocess.run

                    def bounded_build(command, *args, **kwargs):
                        if command[:2] == ["bash", str(builder)]:
                            kwargs["timeout"] = 0.05
                        return actual_run(command, *args, **kwargs)

                    with (
                        patch.dict(
                            os.environ,
                            {"BOXLITE_BUILD_GROUP_TEST_SOCKET": str(socket_path)},
                        ),
                        patch(__name__ + ".BUILD", builder),
                        patch(__name__ + ".shutil.which", return_value="/bin/true"),
                        patch.object(
                            sys.modules[__name__],
                            "BUILD_TIMEOUT_SECONDS",
                            0.05,
                            create=True,
                        ),
                        patch(__name__ + ".subprocess.run", side_effect=bounded_build),
                    ):
                        with self.assertRaises(subprocess.TimeoutExpired):
                            check()

                    try:
                        client, _ = listener.accept()
                    except TimeoutError:
                        continue
                    with client:
                        client.settimeout(0.5)
                        try:
                            client.sendall(b"x")
                            response = client.recv(5)
                        except (BrokenPipeError, ConnectionResetError):
                            response = b""
                        self.assertNotEqual(
                            response,
                            b"alive",
                            "build child survived its timed-out parent",
                        )
                socket_path.unlink(missing_ok=True)


def verify_checksums(output):
    checksums = {}
    for line in (output / "SHA256SUMS").read_text().splitlines():
        expected, name = line.split("  ", 1)
        checksums[name] = expected
    if set(checksums) != set(ARTIFACTS):
        raise RuntimeError(f"unexpected artifact manifest: {output / 'SHA256SUMS'}")
    for name, expected in checksums.items():
        actual = hashlib.sha256((output / name).read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(f"checksum mismatch: {output / name}")


def signal_process_group(process_id, signal_number):
    try:
        os.killpg(process_id, signal_number)
    except ProcessLookupError:
        # The process group can exit between the timeout and the cleanup signal.
        return False
    return True


def run_build(output, *, rebuild=False):
    command = ["bash", str(BUILD)]
    if rebuild:
        command.append("--rebuild")
    command.extend(("--output", str(output)))
    process = subprocess.Popen(command, start_new_session=True)
    try:
        process.wait(timeout=BUILD_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        if signal_process_group(process.pid, signal.SIGTERM):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        signal_process_group(process.pid, signal.SIGKILL)
        process.wait()
        raise
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, command)


def qualify_artifacts():
    qemu = shutil.which("qemu-system-x86_64")
    if not qemu:
        raise RuntimeError("qemu-system-x86_64 is required for artifact qualification")
    with tempfile.TemporaryDirectory(prefix="boxlite boot qualification ") as directory:
        output = Path(directory) / "artifacts"
        run_build(output)
        verify_checksums(output)
        result = subprocess.run(
            [
                qemu, "-machine", "pc,accel=tcg,acpi=off", "-cpu", "max",
                "-m", "512", "-smp", "1", "-nodefaults",
                "-display", "none", "-serial", "stdio", "-monitor", "none",
                "-no-reboot", "-kernel", str(output / "bzImage"),
                "-initrd", str(output / "test-initramfs.cpio"),
                "-append", "console=ttyS0 rdinit=/init reboot=k panic=-1",
            ],
            capture_output=True,
            text=True,
            timeout=90,
        )
        if result.returncode != 0 or "BOXLITE_M1_OK" not in result.stdout.splitlines():
            raise RuntimeError(f"guest boot failed:\n{result.stdout}\n{result.stderr}")
        if "reboot: Restarting system" not in result.stdout:
            raise RuntimeError(f"guest did not request reboot:\n{result.stdout}")
        print("PASS: QEMU guest with 1 vCPU reached init and rebooted", flush=True)


def check_reproducibility():
    with tempfile.TemporaryDirectory(prefix="boxlite boot reproducibility ") as directory:
        builds = [Path(directory) / name for name in ("first", "second")]
        for output in builds:
            run_build(output, rebuild=True)
            verify_checksums(output)
        for name in (*ARTIFACTS, "SHA256SUMS"):
            if (builds[0] / name).read_bytes() != (builds[1] / name).read_bytes():
                raise RuntimeError(f"independent builds differ: {name}")
        print("PASS: two uncached kernel/initramfs builds are byte-identical", flush=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["--artifacts"]:
        qualify_artifacts()
    elif sys.argv[1:] == ["--reproducible"]:
        check_reproducibility()
    else:
        unittest.main()
