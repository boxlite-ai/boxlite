"""Unit tests for the CopyOutPair and CopyOutOutcome bindings exposed by
the Python SDK. These cover binding construction / attribute access /
repr behavior without requiring a running box. End-to-end behavior of
LiteBox.copy_out_many goes through the Rust-side integration tests
(`cargo test -p boxlite copy_out_many_parse_tests`) plus the
`@pytest.mark.integration`-gated test below."""

from __future__ import annotations

import boxlite
import pytest

# Skip entire module if CopyOutPair class is not available (native extension not built)
if not hasattr(boxlite, "CopyOutPair"):
    pytest.skip(
        "boxlite.CopyOutPair not available (rebuild SDK with: make dev:python)",
        allow_module_level=True,
    )


class TestCopyOutPairConstruction:
    """The new CopyOutPair binding accepts two strings and exposes
    them via attribute access. Mirrors the existing CopyOptions
    construction shape."""

    def test_constructor_accepts_positional_args(self):
        pair = boxlite.CopyOutPair("/etc/a.txt", "/host/a.txt")
        assert pair.container_src == "/etc/a.txt"
        assert pair.host_dst == "/host/a.txt"

    def test_constructor_accepts_keyword_args(self):
        pair = boxlite.CopyOutPair(
            container_src="/etc/cfg.yaml",
            host_dst="/host/cfg.yaml",
        )
        assert pair.container_src == "/etc/cfg.yaml"
        assert pair.host_dst == "/host/cfg.yaml"

    def test_attributes_are_mutable(self):
        # PyO3 #[pyo3(get, set)] makes both fields writable from Python.
        pair = boxlite.CopyOutPair("/a", "/b")
        pair.container_src = "/changed"
        assert pair.container_src == "/changed"

    def test_repr_includes_both_paths(self):
        pair = boxlite.CopyOutPair("/etc/a.txt", "/host/a.txt")
        repr_str = repr(pair)
        assert "CopyOutPair" in repr_str
        assert "/etc/a.txt" in repr_str
        assert "/host/a.txt" in repr_str


class TestCopyOutOutcomeShape:
    """CopyOutOutcome is constructed by the Rust side and returned to
    Python; we cannot construct it directly. We verify the class is
    exposed and the type's repr / class name are stable for callers
    pattern-matching on type."""

    def test_class_is_exposed(self):
        assert hasattr(boxlite, "CopyOutOutcome")
        assert boxlite.CopyOutOutcome.__name__ == "CopyOutOutcome"


@pytest.mark.integration
class TestCopyOutManyEndToEnd:
    """End-to-end coverage that exercises the Rust trait default impl
    (since local backend doesn't override copy_out_many). Skipped
    automatically when the integration marker isn't enabled — the
    suite requires a running boxlite runtime."""

    @pytest.mark.skip(
        reason=(
            "Requires a running box fixture; no local-box pytest fixture "
            "exists in this repo yet. Wire when starting-box-from-test "
            "pattern is added. The trait default impl is exercised "
            "structurally by Rust unit tests "
            "(cargo test -p boxlite copy_out_many_parse_tests)."
        )
    )
    async def test_copy_out_many_returns_outcomes_in_input_order(self):
        pass  # pragma: no cover
