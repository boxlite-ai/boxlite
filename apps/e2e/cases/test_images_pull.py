"""End-to-end regression test for `runtime.images.pull()` over REST.

Pre-fix behaviour (on `main`): `BoxliteRuntime::rest()` sets
`image_backend: None`, so calling `images.pull(...)` from the SDK
trips `BoxliteError::Unsupported("Image operations not supported
over REST API")`. The Python binding maps that to `BoxliteError`
with `code == "unsupported"`.

Post-fix behaviour: the SDK posts to `POST /v1/{prefix}/images/pull`
on the API; the API forwards to a runner's `POST /v1/images/pull`,
which calls `boxlite.Images.Pull(...)` and returns the wire-typed
`{reference, config_digest, layer_count}`. The SDK constructs an
`ImagePullResult` from those three fields.

This test pulls the fixture image (`alpine:3.23`) so it stays
hermetic — the e2e bootstrap already registers it on the runner, so
the runner-side pull resolves from cache without an outbound
network round-trip.
"""

from __future__ import annotations

import pytest

import boxlite

pytestmark = pytest.mark.asyncio


async def test_images_pull_returns_metadata(rt):
    """Two-sided proof that `images.pull` round-trips SDK → API →
    Runner → libboxlite. On the pre-fix code path this raises an
    `unsupported` BoxliteError; on the post-fix path we get back the
    cached image's config digest + layer count."""
    result = await rt.images.pull("alpine:3.23")

    # 1. Type: must be the pyo3-bound ImagePullResult, not anything else.
    assert isinstance(result, boxlite.ImagePullResult), (
        f"expected ImagePullResult, got {type(result).__name__}"
    )

    # 2. Reference echoes the requested ref. The runner is allowed to
    #    normalise (e.g., add a registry prefix), so accept either the
    #    exact ref or one ending in the requested ref.
    assert result.reference == "alpine:3.23" or result.reference.endswith(
        "/alpine:3.23"
    ), f"pull returned unexpected reference: {result.reference!r}"

    # 3. config_digest is the OCI image config blob digest — a real
    #    pull always populates this with sha256:<hex>. Empty would
    #    mean the wire shape dropped the field (the bug we'd catch if
    #    someone renames the JSON key on either side of the proxy).
    assert result.config_digest.startswith("sha256:"), (
        f"config_digest is not an OCI digest: {result.config_digest!r}"
    )

    # 4. Real images have >= 1 layer. 0 would indicate the runner
    #    response was deserialised but the field defaulted to 0,
    #    which is a wire-shape regression.
    assert result.layer_count > 0, (
        f"pull reports {result.layer_count} layers — wire shape regression?"
    )
