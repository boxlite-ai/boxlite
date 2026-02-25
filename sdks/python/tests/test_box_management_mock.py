"""
Unit tests for box management API surface (no VM required).

These tests verify that the box management types and methods are properly
exported and structured without requiring a working libkrun/VM setup.
Requires the native Rust extension to be compiled (maturin develop).
"""

import boxlite
import pytest

# Native extension types are only available when the Rust extension is compiled.
# In CI unit-test jobs the extension is not built, so skip gracefully.
_NATIVE_AVAILABLE = hasattr(boxlite, "Boxlite")

pytestmark = pytest.mark.skipif(
    not _NATIVE_AVAILABLE, reason="native Rust extension not available"
)


class TestExports:
    """Test that key types are importable from boxlite."""

    def test_boxlite_importable(self):
        from boxlite import Boxlite

        assert Boxlite is not None

    def test_box_importable(self):
        from boxlite import Box

        assert Box is not None

    def test_box_info_importable(self):
        from boxlite import BoxInfo

        assert BoxInfo is not None

    def test_box_state_info_importable(self):
        from boxlite import BoxStateInfo

        assert BoxStateInfo is not None

    def test_all_contains_key_types(self):
        """Key management types are listed in __all__."""
        assert hasattr(boxlite, "__all__")
        for name in ("Boxlite", "Box", "BoxInfo", "BoxStateInfo"):
            assert name in boxlite.__all__, f"{name} missing from __all__"


class TestBoxInfoStructure:
    """Test BoxInfo has expected attributes and repr."""

    @pytest.fixture()
    def box_info_cls(self):
        return boxlite.BoxInfo

    def test_has_id(self, box_info_cls):
        assert "id" in dir(box_info_cls)

    def test_has_name(self, box_info_cls):
        assert "name" in dir(box_info_cls)

    def test_has_state(self, box_info_cls):
        assert "state" in dir(box_info_cls)

    def test_has_created_at(self, box_info_cls):
        assert "created_at" in dir(box_info_cls)

    def test_has_image(self, box_info_cls):
        assert "image" in dir(box_info_cls)

    def test_has_cpus(self, box_info_cls):
        assert "cpus" in dir(box_info_cls)

    def test_has_memory_mib(self, box_info_cls):
        assert "memory_mib" in dir(box_info_cls)

    def test_has_repr(self, box_info_cls):
        assert hasattr(box_info_cls, "__repr__")


class TestBoxStateInfoStructure:
    """Test BoxStateInfo has expected attributes and repr."""

    @pytest.fixture()
    def state_info_cls(self):
        return boxlite.BoxStateInfo

    def test_has_status(self, state_info_cls):
        assert "status" in dir(state_info_cls)

    def test_has_running(self, state_info_cls):
        assert "running" in dir(state_info_cls)

    def test_has_pid(self, state_info_cls):
        assert "pid" in dir(state_info_cls)

    def test_has_repr(self, state_info_cls):
        assert hasattr(state_info_cls, "__repr__")


class TestBoxliteManagementMethods:
    """Test that Boxlite exposes box management methods."""

    @pytest.fixture()
    def cls(self):
        return boxlite.Boxlite

    @pytest.mark.parametrize(
        "method",
        ["list_info", "get_info", "get", "remove", "create", "get_or_create"],
    )
    def test_method_exists(self, cls, method):
        assert hasattr(cls, method), f"Boxlite missing method: {method}"


class TestSyncBoxliteManagementMethods:
    """Test that SyncBoxlite exposes the same management methods."""

    @pytest.fixture()
    def cls(self):
        sync = getattr(boxlite, "SyncBoxlite", None)
        if sync is None:
            pytest.skip("SyncBoxlite not available (greenlet not installed)")
        return sync

    @pytest.mark.parametrize(
        "method",
        ["list_info", "get_info", "get", "remove", "create", "get_or_create"],
    )
    def test_method_exists(self, cls, method):
        assert hasattr(cls, method), f"SyncBoxlite missing method: {method}"


class TestModuleMetadata:
    """Test module-level metadata (always available, even without native ext)."""

    # Override the module-level skip — version is always available.
    pytestmark = []

    def test_version_exists(self):
        assert hasattr(boxlite, "__version__")
        assert isinstance(boxlite.__version__, str)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
