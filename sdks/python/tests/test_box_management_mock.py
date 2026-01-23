"""
Unit tests for box management API surface (no VM required).

These tests verify that the box management API is properly exported
and available without requiring a working libkrun/VM setup.

NOTE: This file tests for a planned module-level API (list_boxes, list_running, etc.)
that was never implemented. The current API uses Boxlite.list_info() etc.
"""

import boxlite
import pytest

pytestmark = pytest.mark.skip(reason="Tests for unimplemented module-level API")


class TestBoxManagementAPI:
    """Test box management API surface without actual VMs."""

    def test_list_boxes_function_exists(self):
        """Test that list_boxes function is available."""
        assert hasattr(boxlite, "list_boxes")
        assert callable(boxlite.list_boxes)

    def test_list_running_function_exists(self):
        """Test that list_running function is available."""
        assert hasattr(boxlite, "list_running")
        assert callable(boxlite.list_running)

    def test_get_box_info_function_exists(self):
        """Test that get_box_info function is available."""
        assert hasattr(boxlite, "get_box_info")
        assert callable(boxlite.get_box_info)

    def test_remove_box_function_exists(self):
        """Test that remove_box function is available."""
        assert hasattr(boxlite, "remove_box")
        assert callable(boxlite.remove_box)

    def test_convenience_aliases_exist(self):
        """Test that convenience aliases are available."""
        assert hasattr(boxlite, "list")
        assert hasattr(boxlite, "ls")
        assert callable(boxlite.list)
        assert callable(boxlite.ls)

    def test_box_info_class_exists(self):
        """Test that BoxInfo class is exposed."""
        assert hasattr(boxlite, "BoxInfo")

    def test_list_boxes_callable(self):
        """Test that list_boxes is callable and returns a list."""
        result = boxlite.list_boxes()
        assert isinstance(result, list)
        # Might be empty if no boxes are running

    def test_get_box_info_callable(self):
        """Test that get_box_info is callable."""
        # Test with non-existent ID (should return None)
        result = boxlite.get_box_info("nonexistent-test-id-123")
        assert result is None


class TestBoxInfoStructure:
    """Test BoxInfo object structure."""

    def test_box_info_expected_attributes(self):
        """Test that BoxInfo has all expected attributes."""
        # We can't create a real BoxInfo without Rust, but we can verify
        # the module exports it
        from boxlite import BoxInfo

        # BoxInfo should be a class/type
        assert BoxInfo is not None

        # We can't instantiate it directly (it's created by Rust),
        # but we can verify it exists in the module
        assert hasattr(boxlite, "BoxInfo")


class TestModuleStructure:
    """Test overall module structure and exports."""

    def test_all_management_functions_exported(self):
        """Test that all management functions are in __all__."""
        # Get what's actually exported
        if hasattr(boxlite, "__all__"):
            exported = boxlite.__all__

            # Check for key exports
            assert "Box" in exported or hasattr(boxlite, "Box")
            assert "BoxInfo" in exported or hasattr(boxlite, "BoxInfo")
            assert "list_boxes" in exported or hasattr(boxlite, "list_boxes")
            assert "list_running" in exported or hasattr(boxlite, "list_running")

    def test_version_exists(self):
        """Test that module has a version."""
        assert hasattr(boxlite, "__version__")
        assert isinstance(boxlite.__version__, str)


class TestErrorHandling:
    """Test error handling in management operations."""

    def test_remove_box_nonexistent_raises_error(self):
        """Test that remove_box raises error for non-existent box."""
        # This should raise an error
        with pytest.raises(RuntimeError):
            boxlite.remove_box("definitely-nonexistent-box-id-12345")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
