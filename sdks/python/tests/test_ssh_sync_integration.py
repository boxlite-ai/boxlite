"""
SyncBox.ssh integration test (real VM, greenlet bridge).

Checks the synchronous wrapper against the same lifecycle the async tests
cover: observing never boots the box, configure enables SSH, disable is
repeatable, and credentials never reach repr output.
"""

from __future__ import annotations

import pytest

pytest.importorskip("greenlet")

import boxlite
from boxlite import SyncSshHandle
from boxlite.sync_api import SyncBox
from tests.test_ssh_integration import LEAKING_KEY, _assert_disabled, _config

pytestmark = pytest.mark.integration


@pytest.fixture
def sync_box(shared_sync_runtime):
    box = shared_sync_runtime.create(boxlite.BoxOptions(image="alpine:latest"))
    yield box
    box.stop()


def test_sync_ssh_matches_the_async_lifecycle(sync_box, tmp_path):
    assert isinstance(sync_box, SyncBox)
    assert isinstance(sync_box.ssh, SyncSshHandle)

    # Observing must not boot the box.
    _assert_disabled(sync_box.ssh.status())

    first = sync_box.ssh.configure(_config(tmp_path))
    assert first.enabled
    assert first.generation >= 1

    second = sync_box.ssh.configure(_config(tmp_path))
    assert second.generation > first.generation

    with pytest.raises(boxlite.InvalidArgumentError) as excinfo:
        sync_box.ssh.configure(
            boxlite.SshConfig(
                listen_address="0.0.0.0:2222", host_private_key=LEAKING_KEY
            )
        )
    assert "LEAKCHECK" not in str(excinfo.value)

    assert not sync_box.ssh.disable().enabled
    assert not sync_box.ssh.disable().enabled
    assert not sync_box.ssh.status().enabled
