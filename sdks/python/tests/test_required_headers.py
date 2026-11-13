"""Creating a secret requires an explicit header map."""

import importlib.util

import pytest

import boxlite

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("boxlite.boxlite") is None,
    reason="native extension not built",
)


def test_required_headers_constructor():
    with pytest.raises((TypeError, ValueError), match="headers"):
        boxlite.Secret(name="x", value="token", hosts=["api.test.com"])
