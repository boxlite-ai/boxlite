"""
Integration tests for runtime image operations in the sync Python SDK.
"""

from __future__ import annotations

import pytest

import boxlite

pytestmark = pytest.mark.integration


def test_sync_images_pull_returns_metadata(shared_sync_runtime):
    result = shared_sync_runtime.images.pull("alpine:latest")

    assert isinstance(result, boxlite.ImagePullResult)
    assert result.reference == "alpine:latest"
    assert result.config_digest.startswith("sha256:")
    assert result.layer_count > 0


def test_sync_images_list_returns_cached_image(shared_sync_runtime):
    shared_sync_runtime.images.pull("alpine:latest")

    images = shared_sync_runtime.images.list()

    assert images
    assert all(isinstance(info, boxlite.ImageInfo) for info in images)

    alpine = next(
        (
            info
            for info in images
            if "alpine" in info.repository and info.tag == "latest"
        ),
        None,
    )
    assert alpine is not None
    assert alpine.id.startswith("sha256:")
    assert isinstance(alpine.cached_at, str)
