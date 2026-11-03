"""Network-disabled ARM64 guests must boot with the VMM filter active."""

import asyncio
import platform
from pathlib import Path

import pytest

import boxlite

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        platform.system() != "Linux" or platform.machine() != "aarch64",
        reason="requires Linux ARM64 with KVM",
    ),
]


def test_network_disabled_arm64_guest_keeps_seccomp(shared_runtime):
    async def run():
        async with boxlite.SimpleBox(
            image="python:3.12-slim",
            runtime=shared_runtime,
            cpus=1,
            memory_mib=512,
            network=boxlite.NetworkSpec(
                outbound=boxlite.OutboundNetworkSpec(mode="disabled")
            ),
        ) as box:
            result = await box.exec(
                "python", "-c", "open('/tmp/proof', 'w').write('391'); print(17 * 23)"
            )
            assert result.exit_code == 0, result.stderr
            assert result.stdout.strip() == "391"
            result = await box.exec("cat", "/tmp/proof")
            assert result.exit_code == 0 and result.stdout == "391"

            launcher = Path(f"/proc/{(await box.info()).state.pid}")
            processes = []
            threads = []
            for process in Path("/proc").glob("[0-9]*"):
                try:
                    executable = (process / "exe").resolve()
                    if executable.name != "boxlite-shim" or box.id not in str(
                        executable
                    ):
                        continue
                    processes.append(process)
                    for thread in (process / "task").iterdir():
                        status = dict(
                            line.split(":", 1)
                            for line in (thread / "status").read_text().splitlines()
                            if ":" in line
                        )
                        assert status["Seccomp"].strip() == "2"
                        assert status["NoNewPrivs"].strip() == "1"
                        threads.append(thread.name)
                except (FileNotFoundError, PermissionError):
                    continue  # Unrelated processes may be inaccessible; threads may exit.
            assert threads, "no filtered VMM threads found"
            print(f"{len(threads)} VMM threads retain seccomp and NoNewPrivs")
        assert not launcher.exists(), "launcher remained after cleanup"
        assert all(not process.exists() for process in processes), (
            "VMM remained after cleanup"
        )

    asyncio.run(run())
