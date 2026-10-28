"""REST E2E coverage for guest SSH through the hosted API and runner.

The Python SDK configures SSH (`POST /v1/{prefix}/boxes/{id}/ssh`), the CLI's
`boxlite ssh forward` opens the box's public tunnel to the guest listener, and
the OpenSSH client logs in through the CLI's local port.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from pathlib import Path

import boxlite
import pytest

BOXLITE_BIN = os.environ.get("BOXLITE_E2E_CLI", shutil.which("boxlite"))
CLI_PROFILE = os.environ.get("BOXLITE_E2E_PROFILE", "p1")
STEP_TIMEOUT = 60


@pytest.fixture(scope="module")
def cli() -> str:
    if not BOXLITE_BIN or not Path(BOXLITE_BIN).exists():
        pytest.skip(f"boxlite CLI not found at {BOXLITE_BIN!r}")
    for tool in ("ssh", "ssh-keygen"):
        if not shutil.which(tool):
            pytest.skip(f"{tool} not found")
    return BOXLITE_BIN


@pytest.fixture
def keys(tmp_path: Path) -> Path:
    """Disposable keys: `host` for the guest, `alice` listed, `mallory` not."""
    for name in ("host", "alice", "mallory"):
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", str(tmp_path / name)],
            check=True,
            timeout=STEP_TIMEOUT,
        )
    return tmp_path


@pytest.fixture
async def processes():
    """Starts subprocesses and kills and reaps every one at teardown."""
    started: list[asyncio.subprocess.Process] = []

    async def spawn(*args: str, **kwargs) -> asyncio.subprocess.Process:
        process = await asyncio.create_subprocess_exec(
            *args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs
        )
        started.append(process)
        return process

    yield spawn
    for process in started:
        if process.returncode is None:
            process.kill()
        await asyncio.wait_for(process.communicate(), STEP_TIMEOUT)


def _config(keys: Path) -> boxlite.SshConfig:
    return boxlite.SshConfig(
        listen_address="0.0.0.0:2222",
        host_private_key=(keys / "host").read_text(),
        accounts=[boxlite.SshAccount(login="alice", authorized_keys=[(keys / "alice.pub").read_text()])],
    )


def _ssh_args(keys: Path, port: int, identity: str, command: str) -> list[str]:
    return [
        "ssh", "-F", "none", "-p", str(port), "-i", str(keys / identity),
        "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={keys / 'known_hosts'}",
        "-l", "alice", "127.0.0.1", command,
    ]


async def _run_ssh(spawn, keys: Path, port: int, identity: str, command: str) -> tuple[int, str]:
    process = await spawn(*_ssh_args(keys, port, identity, command))
    out, _ = await asyncio.wait_for(process.communicate(), STEP_TIMEOUT)
    return process.returncode, out.decode()


async def _open_session(spawn, keys: Path, port: int) -> asyncio.subprocess.Process:
    session = await spawn(*_ssh_args(keys, port, "alice", "echo ready; sleep 300"))
    assert await asyncio.wait_for(session.stdout.readline(), STEP_TIMEOUT) == b"ready\n"
    return session


async def test_ssh_through_cli_forwarding(rt, image, cli, keys, processes):
    box = await rt.create(
        boxlite.BoxOptions(
            image=image,
            network=boxlite.NetworkSpec(inbound=boxlite.InboundNetworkSpec(mode="enabled")),
        )
    )
    try:
        await box.start()
        status = await box.ssh.configure(_config(keys))
        assert status.enabled and status.generation == 1
        assert status.host_key_fingerprint.startswith("SHA256:")

        forward = await processes(cli, "ssh", "forward", box.id, env={**os.environ, "BOXLITE_PROFILE": CLI_PROFILE})
        bound = (await asyncio.wait_for(forward.stdout.readline(), STEP_TIMEOUT)).decode().strip()
        assert bound.startswith("tcp://127.0.0.1:"), bound
        port = int(bound.rsplit(":", 1)[1])
        (keys / "known_hosts").write_text(f"[127.0.0.1]:{port} {status.host_public_key}\n")

        code, out = await _run_ssh(processes, keys, port, "alice", "echo ssh-over-cloud")
        assert (code, out.strip()) == (0, "ssh-over-cloud")
        code, _ = await _run_ssh(processes, keys, port, "mallory", "true")
        assert code != 0

        session = await _open_session(processes, keys, port)
        status = await box.ssh.configure(_config(keys))
        assert status.generation == 2
        await asyncio.wait_for(session.wait(), 30)

        session = await _open_session(processes, keys, port)
        status = await box.ssh.disable()
        assert not status.enabled and status.generation == 2
        await asyncio.wait_for(session.wait(), 30)
    finally:
        await rt.remove(box.id, force=True)


async def test_ssh_status_on_a_stopped_box_reports_disabled(rt, image):
    box = await rt.create(boxlite.BoxOptions(image=image))
    try:
        await box.start()
        await box.stop()

        # Cloud stop acknowledges the request before the runner reports stopped.
        async def wait_until_stopped():
            while (await rt.get_info(box.id)).state.status != "stopped":
                await asyncio.sleep(0.1)

        await asyncio.wait_for(wait_until_stopped(), STEP_TIMEOUT)
        status = await box.ssh.status()
        assert (status.enabled, status.generation, status.listen_address) == (False, 0, "")
        assert (status.host_public_key, status.host_key_fingerprint) == ("", "")
        disabled = await box.ssh.disable()
        assert disabled.generation == 0
        assert (await rt.get_info(box.id)).state.status == "stopped"
    finally:
        await rt.remove(box.id, force=True)
