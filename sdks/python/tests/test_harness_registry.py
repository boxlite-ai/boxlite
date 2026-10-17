"""The registries the integration harness resolves images against."""

from __future__ import annotations

import ipaddress

import pytest

pytestmark = pytest.mark.integration


def test_harness_registries_stay_on_this_machine(test_registries):
    """Every box built from a tag asks its registry for that tag again, so a
    host off this machine puts the internet into every box start."""
    for registry in test_registries:
        host = registry.host.rsplit(":", 1)[0]
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = False
        assert loopback, f"{registry.host} is not an address on this machine"
