"""The registries the integration harness resolves images against."""

from __future__ import annotations

import ipaddress
import os

import pytest

pytestmark = pytest.mark.integration

UPSTREAM = os.environ.get("BOXLITE_TEST_REGISTRIES") == "upstream"


def _on_this_machine(host: str) -> bool:
    try:
        return ipaddress.ip_address(host.rsplit(":", 1)[0]).is_loopback
    except ValueError:
        return False


@pytest.mark.skipif(UPSTREAM, reason="upstream mode lists the public mirrors")
def test_harness_registries_stay_on_this_machine(test_registries):
    """Every box built from a tag asks its registry for that tag again, so a
    host off this machine puts the internet into every box start."""
    for registry in test_registries:
        assert _on_this_machine(registry.host), (
            f"{registry.host} is not an address on this machine"
        )


@pytest.mark.skipif(not UPSTREAM, reason="only upstream mode lists the mirrors")
def test_upstream_mode_lists_the_public_mirrors(test_registries):
    """In upstream mode make runs the suite without the local registry, so the
    harness lists the public mirrors it used before."""
    hosts = [registry.host for registry in test_registries]
    assert hosts == [
        "docker.m.daocloud.io",
        "docker.xuanyuan.me",
        "docker.1ms.run",
        "docker.io",
    ]
