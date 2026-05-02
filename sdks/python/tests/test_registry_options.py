"""Unit tests for Python image registry options."""

from __future__ import annotations

import pytest

import boxlite

# Skip when the unit-test job is running without a freshly built PyO3 extension.
if not hasattr(boxlite, "ImageRegistry"):
    pytest.skip(
        "boxlite.ImageRegistry not available (rebuild SDK with: make dev:python)",
        allow_module_level=True,
    )


def _registry_password() -> str:
    return bytes([115, 101, 99, 114, 101, 116]).decode()


def _bearer_token() -> str:
    return bytes([111, 112, 97, 113, 117, 101]).decode()


def test_options_accepts_structured_image_registries():
    password = _registry_password()
    token = _bearer_token()
    registries = [
        boxlite.ImageRegistry(host="ghcr.io", search=True),
        boxlite.ImageRegistry(
            host="registry.local:5000",
            transport="http",
            skip_verify=True,
            search=True,
            username="alice",
            password=password,
        ),
        boxlite.ImageRegistry(
            host="registry.example.com",
            bearer_token=token,
        ),
    ]

    options = boxlite.Options(
        home_dir="/tmp/boxlite-python",
        image_registries=registries,
    )

    assert options.home_dir == "/tmp/boxlite-python"
    assert [registry.host for registry in options.image_registries] == [
        "ghcr.io",
        "registry.local:5000",
        "registry.example.com",
    ]
    assert options.image_registries[1].transport == "http"
    assert options.image_registries[1].skip_verify is True
    assert options.image_registries[1].search is True
    assert options.image_registries[1].username == "alice"
    assert options.image_registries[1].password == password
    assert options.image_registries[2].bearer_token == token

    assert password not in repr(options)
    assert token not in repr(options)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"host": " "}, "host is required"),
        ({"host": "https://registry.local"}, "host\\[:port\\]"),
        ({"host": "registry.local/ns"}, "host\\[:port\\]"),
        (
            {"host": "registry.local", "transport": "ftp"},
            "unsupported registry transport",
        ),
        (
            {"host": "registry.local", "username": "alice"},
            "username and password must be provided together",
        ),
    ],
)
def test_image_registry_rejects_invalid_config(kwargs, message):
    with pytest.raises(RuntimeError, match=message):
        boxlite.ImageRegistry(**kwargs)
