"""Unit tests for Python image registry options."""

from __future__ import annotations

import pytest

import boxlite


def test_options_accepts_structured_image_registries():
    registries = [
        boxlite.ImageRegistry(host="ghcr.io", search=True),
        boxlite.ImageRegistry(
            host="registry.local:5000",
            transport="http",
            skip_verify=True,
            search=True,
            username="alice",
            password="secret",
        ),
        boxlite.ImageRegistry(
            host="registry.example.com",
            bearer_token="bearer-secret",
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
    assert options.image_registries[1].password == "secret"
    assert options.image_registries[2].bearer_token == "bearer-secret"

    assert "secret" not in repr(options)
    assert "bearer-secret" not in repr(options)


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
