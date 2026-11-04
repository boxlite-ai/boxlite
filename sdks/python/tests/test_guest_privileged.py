"""Guest privilege is a separate option from the runner's sandbox policy."""

import importlib.util

import pytest

NATIVE_MODULE_ABSENT = importlib.util.find_spec("boxlite.boxlite") is None

if not NATIVE_MODULE_ABSENT:
    from boxlite import AdvancedBoxOptions, BoxOptions

pytestmark = pytest.mark.skipif(
    NATIVE_MODULE_ABSENT, reason="native extension module not built"
)


def test_guest_privileged_defaults_off():
    assert AdvancedBoxOptions().privileged is False


def test_guest_privileged_does_not_set_host_security_or_capability_overrides():
    options = BoxOptions(
        image="docker:27.5.1-dind",
        advanced=AdvancedBoxOptions(privileged=True),
    )
    assert options.advanced.privileged is True
    assert options.advanced.security is None
    assert options.advanced.capabilities is None
