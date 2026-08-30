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
        """NetworkSpec accepts the nested outbound shape."""
        spec = boxlite.NetworkSpec(
            outbound=boxlite.OutboundNetworkSpec(
                mode="enabled",
                allow_net=["example.com", "*.openai.com"],
            )
        )

        assert spec.outbound.mode == "enabled"
        assert spec.outbound.allow_net == ["example.com", "*.openai.com"]

    def test_legacy_creation(self):
        """NetworkSpec keeps accepting the legacy mode and allow_net keywords."""
        spec = boxlite.NetworkSpec(
            mode="enabled",
            allow_net=["example.com", "*.openai.com"],
        )

        assert spec.outbound.mode == "enabled"
        assert spec.outbound.allow_net == ["example.com", "*.openai.com"]

    def test_legacy_positional_creation(self):
        """The pre-split signature was NetworkSpec(mode, allow_net); callers
        that passed those positionally must keep working."""
        spec = boxlite.NetworkSpec("enabled", ["example.com"])

        assert spec.outbound.mode == "enabled"
        assert spec.outbound.allow_net == ["example.com"]
        assert spec.inbound is None

    def test_legacy_positional_mode_only(self):
        spec = boxlite.NetworkSpec("disabled")

        assert spec.outbound.mode == "disabled"
        assert spec.outbound.allow_net == []

    def test_nested_specs_still_accepted_positionally(self):
        """The nested objects stay usable in the same two slots — the legacy
        shim keys off the argument type, not the position."""
        spec = boxlite.NetworkSpec(
            boxlite.OutboundNetworkSpec(mode="enabled"),
            boxlite.InboundNetworkSpec(mode="disabled"),
        )

        assert spec.outbound.mode == "enabled"
        assert spec.inbound.mode == "disabled"

    def test_legacy_mode_and_allow_net_readable_off_spec(self):
        """Pre-split readers used spec.mode / spec.allow_net."""
        spec = boxlite.NetworkSpec(
            outbound=boxlite.OutboundNetworkSpec(mode="disabled", allow_net=[])
        )

        assert spec.mode == "disabled"
        assert spec.allow_net == []

    def test_legacy_mode_defaults_to_enabled_without_outbound(self):
        """An unset spec meant "enabled, unrestricted" before the split."""
        spec = boxlite.NetworkSpec(inbound=boxlite.InboundNetworkSpec(mode="disabled"))

        assert spec.mode == "enabled"
        assert spec.allow_net == []

    def test_rejects_mode_given_both_positionally_and_by_keyword(self):
        with pytest.raises(ValueError):
            boxlite.NetworkSpec("enabled", mode="disabled")

    def test_rejects_mixed_legacy_and_nested_outbound(self):
        """NetworkSpec rejects callers that mix nested and legacy outbound fields."""
        with pytest.raises(ValueError):
            boxlite.NetworkSpec(
                outbound=boxlite.OutboundNetworkSpec(mode="enabled"),
                mode="disabled",
            )

    def test_box_options_accepts_network_spec(self):
        """BoxOptions accepts a NetworkSpec instance."""
        opts = boxlite.BoxOptions(
            image="alpine:latest",
            network=boxlite.NetworkSpec(
                outbound=boxlite.OutboundNetworkSpec(
                    mode="enabled",
                    allow_net=["example.com"],
                )
            ),
        )

        assert opts.network.outbound.mode == "enabled"
        assert opts.network.outbound.allow_net == ["example.com"]

    def test_box_options_rejects_string_network(self):
        """BoxOptions rejects string network values."""
        with pytest.raises(TypeError):
            boxlite.BoxOptions(image="alpine:latest", network="enabled")

    def test_box_options_rejects_top_level_allow_net(self):
        """BoxOptions rejects top-level allow_net."""
        with pytest.raises(TypeError):
            boxlite.BoxOptions(image="alpine:latest", allow_net=["example.com"])
