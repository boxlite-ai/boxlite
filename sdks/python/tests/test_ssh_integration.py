"""
SSH control integration tests (real VMs).

Mirrors the lifecycle the SSH guide promises: observing never boots the box,
every accepted configure restarts the listener (generation advances), an
invalid configuration leaves the running listener untouched, disable is
idempotent, and a box with an explicit main command must be started before
configure. Boxes use auto_remove=False because a handle that stopped its box
is spent; post-stop observations go through a fresh runtime.get() handle.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import pytest_asyncio

import boxlite
from boxlite.errors import BoxliteError, InvalidArgumentError, InvalidStateError

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]

LISTEN = "0.0.0.0:2222"
# Structurally invalid key carrying a marker; it must not come back in errors.
LEAKING_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nLEAKCHECK-not-a-key\n"


def _generate_key(path: Path) -> None:
    if path.exists():
        return
    subprocess.run(
        [
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            "py-ssh-test",
            "-f",
            str(path),
        ],
        check=True,
    )


def _config(tmp_path: Path) -> boxlite.SshConfig:
    host, user = tmp_path / "host", tmp_path / "user"
    _generate_key(host)
    _generate_key(user)
    return boxlite.SshConfig(
        listen_address=LISTEN,
        host_private_key=host.read_text(),
        accounts=[
            boxlite.SshAccount(
                login="alice",
                authorized_keys=[user.with_suffix(".pub").read_text()],
            )
        ],
    )


def _assert_disabled(status) -> None:
    assert not status.enabled
    assert status.generation == 0
    assert status.listen_address == ""
    assert status.host_public_key == ""
    assert status.host_key_fingerprint == ""


async def _assert_not_running(box) -> None:
    info = await box.info()
    assert not info.state.running
    assert info.state.pid is None


async def _dispose(runtime, box) -> None:
    for attempt in (box.stop, lambda: runtime.remove(box.id)):
        try:
            result = attempt()
            if result is not None and hasattr(result, "__await__"):
                await result
        except BoxliteError:
            pass


@pytest_asyncio.fixture
async def runtime(shared_runtime):
    return shared_runtime


async def test_ssh_journey(runtime, tmp_path):
    """Configure, reconfigure, reject invalid input, disable repeatedly."""
    box = await runtime.create(
        boxlite.BoxOptions(image="alpine:latest", auto_remove=False)
    )
    try:
        # Observing SSH must not boot the box.
        _assert_disabled(await box.ssh.status())
        await _assert_not_running(box)

        first = await box.ssh.configure(_config(tmp_path))
        assert first.enabled
        assert first.generation >= 1
        assert first.listen_address
        assert first.host_public_key
        assert first.host_key_fingerprint

        # Every accepted configure restarts SSH; the host key is stable.
        second = await box.ssh.configure(_config(tmp_path))
        assert second.generation > first.generation
        assert second.host_key_fingerprint == first.host_key_fingerprint

        # A rejected configuration leaves the running listener untouched and
        # does not echo the submitted key material.
        with pytest.raises(InvalidArgumentError) as excinfo:
            await box.ssh.configure(
                boxlite.SshConfig(listen_address=LISTEN, host_private_key=LEAKING_KEY)
            )
        assert "LEAKCHECK" not in str(excinfo.value)
        intact = await box.ssh.status()
        assert intact.enabled
        assert intact.generation == second.generation
        assert intact.host_key_fingerprint == second.host_key_fingerprint

        # Disable is idempotent.
        for _ in range(2):
            assert not (await box.ssh.disable()).enabled
        assert not (await box.ssh.status()).enabled
    finally:
        await _dispose(runtime, box)


async def test_stopped_box_stays_stopped_through_status_and_disable(runtime, tmp_path):
    """status()/disable() observe a stopped box without resuming it."""
    box = await runtime.create(
        boxlite.BoxOptions(image="alpine:latest", auto_remove=False)
    )
    box_id = box.id
    try:
        first = await box.ssh.configure(_config(tmp_path))
        assert first.enabled
        await box.stop()

        # The stopped handle is spent for control; observe through a fresh one.
        fresh = await runtime.get(box_id)
        _assert_disabled(await fresh.ssh.status())
        _assert_disabled(await fresh.ssh.disable())
        await _assert_not_running(fresh)
    finally:
        await _dispose(runtime, box)


async def test_explicit_cmd_requires_start_before_configure(runtime, tmp_path):
    """configure() refuses to start a box with an explicit main command."""
    box = await runtime.create(
        boxlite.BoxOptions(
            image="alpine:latest", cmd=["sleep", "infinity"], auto_remove=False
        )
    )
    box_id = box.id
    try:
        with pytest.raises(InvalidStateError):
            await box.ssh.configure(_config(tmp_path))
        # status() is still an observation, not a start.
        _assert_disabled(await box.ssh.status())

        await box.start()
        running = await box.ssh.configure(_config(tmp_path))
        assert running.enabled
        await box.stop()

        fresh = await runtime.get(box_id)
        with pytest.raises(InvalidStateError):
            await fresh.ssh.configure(_config(tmp_path))
        _assert_disabled(await fresh.ssh.status())
        await _assert_not_running(fresh)
    finally:
        await _dispose(runtime, box)
