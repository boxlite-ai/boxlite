"""Check boot coverage's guest-init setup through the real Make target."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


COVERAGE_MAKEFILE = Path(__file__).resolve().parents[2] / "make/coverage.mk"


class VmmBootCoverageTest(unittest.TestCase):
    def test_boot_coverage_builds_and_exports_guest_init(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            tools = root / "bin"
            tools.mkdir()
            cargo = tools / "cargo"
            cargo.write_text(
                "#!/bin/sh\n"
                'if [ "$1 $2" = "llvm-cov nextest" ]; then\n'
                '  test -n "$VMM_GUEST_MOUNT_INIT" || {\n'
                '    echo "missing VMM_GUEST_MOUNT_INIT" >&2; exit 1;\n'
                "  }\n"
                '  test -f "$VMM_GUEST_MOUNT_INIT" || exit 1\n'
                '  printf "%s\\n" "$VMM_GUEST_MOUNT_INIT" > "$BOOT_INIT_LOG"\n'
                "fi\n"
            )
            cargo.chmod(0o755)
            makefile = root / "Makefile"
            makefile.write_text(
                f"PROJECT_ROOT := {root}\n"
                "VMM_BALLOON_INIT :=\n"
                f"include {COVERAGE_MAKEFILE}\n"
                ".PHONY: _ensure-kvm _ensure-vmm-kernel vmm\\:guest-mount-init\n"
                "_ensure-kvm _ensure-vmm-kernel:\n\t@true\n"
                "vmm\\:guest-mount-init:\n"
                '\t@mkdir -p "$(PROJECT_ROOT)/target/vmm/guest-mount/'
                'x86_64-unknown-linux-musl/release"\n'
                '\t@touch "$(PROJECT_ROOT)/target/vmm/guest-mount/'
                'x86_64-unknown-linux-musl/release/boxlite-guest"\n'
            )
            log = root / "init.log"
            env = {
                **os.environ,
                "PATH": str(tools) + os.pathsep + os.environ["PATH"],
                "BOOT_INIT_LOG": str(log),
            }
            env.pop("VMM_GUEST_MOUNT_INIT", None)
            result = subprocess.run(
                ["make", "coverage:vmm:boot"],
                cwd=root, env=env, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(
                log.read_text().strip(),
                str(root / "target/vmm/guest-mount/"
                    "x86_64-unknown-linux-musl/release/boxlite-guest"),
            )
