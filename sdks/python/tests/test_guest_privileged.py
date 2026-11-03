"""Guest privilege is a separate option from the runner's sandbox policy."""

import importlib.util

import pytest

import boxlite

if importlib.util.find_spec("boxlite.boxlite") is None:
    pytest.skip("native extension module not built", allow_module_level=True)
from boxlite.boxlite import AdvancedBoxOptions, BoxOptions  # noqa: F401 - validate native exports


def test_guest_privileged_defaults_off():
    assert boxlite.AdvancedBoxOptions().privileged is False


def test_guest_privileged_does_not_set_host_security_or_capability_overrides():
    options = boxlite.BoxOptions(
        image="docker:27.5.1-dind",
        advanced=boxlite.AdvancedBoxOptions(privileged=True),
    )
    assert options.advanced.privileged is True
    assert options.advanced.security is None
    assert options.advanced.capabilities is None
