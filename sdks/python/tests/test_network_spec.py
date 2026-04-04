from __future__ import annotations

import pytest

import boxlite

# Skip entire module if NetworkSpec class is not available (native extension not built)
if not hasattr(boxlite, "NetworkSpec"):
    pytest.skip(
        "boxlite.NetworkSpec not available (rebuild SDK with: make dev:python)",
        allow_module_level=True,
    )


class TestNetworkSpec:
    def test_creation(self):
        spec = boxlite.NetworkSpec(
            mode="enabled",
            allow_net=["example.com", "*.openai.com"],
        )

        assert spec.mode == "enabled"
        assert spec.allow_net == ["example.com", "*.openai.com"]

    def test_box_options_accepts_network_spec(self):
        opts = boxlite.BoxOptions(
            image="alpine:latest",
            network=boxlite.NetworkSpec(mode="enabled", allow_net=["example.com"]),
        )

        assert opts.network.mode == "enabled"
        assert opts.network.allow_net == ["example.com"]

    def test_box_options_rejects_string_network(self):
        with pytest.raises(TypeError):
            boxlite.BoxOptions(image="alpine:latest", network="enabled")

    def test_box_options_rejects_top_level_allow_net(self):
        with pytest.raises(TypeError):
            boxlite.BoxOptions(image="alpine:latest", allow_net=["example.com"])
