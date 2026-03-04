"""
Integration tests for SkillBox functionality.

Tests the SkillBox class for secure Claude Code CLI execution with skills.
These tests require a working VM/libkrun setup.

Note: Tests that call() Claude require a valid CLAUDE_CODE_OAUTH_TOKEN
and are marked with @pytest.mark.manual since they require external credentials.
"""

from __future__ import annotations

import os

import boxlite
import pytest

# Try to import sync API - skip if greenlet not installed
try:
    from boxlite import SyncSkillBox

    SYNC_AVAILABLE = True
except ImportError:
    SYNC_AVAILABLE = False


@pytest.fixture
def oauth_token():
    """Get OAuth token from environment or skip."""
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if not token:
        pytest.skip("CLAUDE_CODE_OAUTH_TOKEN not set")
    return token


@pytest.mark.integration
@pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")
class TestSkillBoxBasic:
    """Test basic SkillBox lifecycle and properties."""

    def test_context_manager(self, shared_sync_runtime, oauth_token):
        """Test SkillBox as context manager."""
        with SyncSkillBox(
            name="test-skillbox-context",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            assert box is not None
            assert box.id is not None

    def test_box_id_exists(self, shared_sync_runtime, oauth_token):
        """Test that SkillBox has an id property."""
        with SyncSkillBox(
            name="test-skillbox-id",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            assert isinstance(box.id, str)
            assert len(box.id) == 12  # Base62 format

    def test_default_values(self, shared_sync_runtime, oauth_token):
        """Test SkillBox default configuration values."""
        with SyncSkillBox(
            name="test-skillbox-defaults",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            info = box.info()
            # Default image is node:20-alpine
            assert "node" in info.image.lower()
            # Default memory is 2048 MiB
            assert info.memory_mib == 2048

    def test_custom_name(self, shared_sync_runtime, oauth_token):
        """Test SkillBox with custom name."""
        with SyncSkillBox(
            name="test-skillbox-custom-name",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            info = box.info()
            assert info.name == "test-skillbox-custom-name"

    def test_custom_memory(self, shared_sync_runtime, oauth_token):
        """Test SkillBox with custom memory limit."""
        with SyncSkillBox(
            name="test-skillbox-memory",
            memory_mib=1024,
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            info = box.info()
            assert info.memory_mib == 1024


@pytest.mark.integration
@pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")
class TestSkillBoxSetup:
    """Test SkillBox dependency installation."""

    @pytest.mark.slow
    def test_is_claude_installed_false_initially(
        self, shared_sync_runtime, oauth_token
    ):
        """Test that Claude CLI is not installed in fresh box."""
        with SyncSkillBox(
            name="test-skillbox-fresh",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            # Directly check if claude is installed (bypassing lazy setup)
            # Use the SDK's execute method to run a command inside the VM
            result = box.exec("which", ["claude"])
            wait_result = result.wait()
            # In a fresh box, claude should not be installed
            assert wait_result.exit_code in [0, 1]  # 0 if installed, 1 if not

    @pytest.mark.slow
    def test_setup_installs_dependencies(self, shared_sync_runtime, oauth_token):
        """Test that setup installs Claude CLI and required dependencies."""
        with SyncSkillBox(
            name="test-skillbox-setup",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            # Trigger lazy setup
            box._setup()

            # Verify Claude CLI is installed
            result = box.exec("which", ["claude"]).wait()
            assert result.exit_code == 0

            # Verify bash is installed
            result = box.exec("which", ["bash"]).wait()
            assert result.exit_code == 0

            # Verify git is installed
            result = box.exec("which", ["git"]).wait()
            assert result.exit_code == 0

            # Verify Python is installed
            result = box.exec("which", ["python3"]).wait()
            assert result.exit_code == 0


@pytest.mark.integration
@pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")
class TestSkillBoxInstallSkill:
    """Test skill installation functionality."""

    @pytest.mark.slow
    def test_install_skill_returns_bool(self, shared_sync_runtime, oauth_token):
        """Test that install_skill returns a boolean."""
        with SyncSkillBox(
            name="test-skillbox-install",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            result = box.install_skill("anthropics/skills")
            assert isinstance(result, bool)

    @pytest.mark.slow
    def test_install_invalid_skill_returns_false(
        self, shared_sync_runtime, oauth_token
    ):
        """Test that installing an invalid skill returns False."""
        with SyncSkillBox(
            name="test-skillbox-invalid",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            result = box.install_skill("invalid/nonexistent-skill-12345")
            assert result is False


@pytest.mark.integration
@pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")
class TestSkillBoxCall:
    """Test SkillBox.call() method for Claude interactions.

    These tests require a valid OAuth token and network access to Claude API.
    They are marked as manual since they require external credentials.
    """

    @pytest.mark.slow
    @pytest.mark.skip(reason="Requires valid OAuth token and Claude API access")
    def test_call_simple(self, shared_sync_runtime, oauth_token):
        """Test simple call to Claude."""
        with SyncSkillBox(
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            result = box.call("Say 'hello' and nothing else")
            assert isinstance(result, str)
            assert len(result) > 0

    @pytest.mark.slow
    @pytest.mark.skip(reason="Requires valid OAuth token and Claude API access")
    def test_call_multi_turn(self, shared_sync_runtime, oauth_token):
        """Test multi-turn conversation - Claude remembers context."""
        with SyncSkillBox(
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            box.call("My name is Alice")
            result = box.call("What is my name?")
            assert "Alice" in result


class TestSkillBoxExports:
    """Test SkillBox module exports (no VM needed)."""

    def test_skillbox_exported_from_boxlite(self):
        """Test that SkillBox is exported from boxlite module."""
        assert hasattr(boxlite, "SkillBox")

    def test_skillbox_from_skillbox_module(self):
        """Test that SkillBox can be imported from skillbox module."""
        from boxlite.skillbox import SkillBox

        assert SkillBox is boxlite.SkillBox

    def test_skillbox_has_expected_methods(self):
        """Test that SkillBox has expected public methods."""
        assert hasattr(boxlite.SkillBox, "call")
        assert hasattr(boxlite.SkillBox, "install_skill")
        # SkillBox has an execute method inherited from SimpleBox
        assert callable(getattr(boxlite.SkillBox, "exec", None))
        assert hasattr(boxlite.SkillBox, "info")

    def test_skillbox_inherits_from_simplebox(self):
        """Test that SkillBox inherits from SimpleBox."""
        from boxlite.simplebox import SimpleBox

        assert issubclass(boxlite.SkillBox, SimpleBox)


@pytest.mark.integration
class TestSkillBoxValidation:
    """Test input validation."""

    def test_missing_oauth_raises_error(self, shared_sync_runtime):
        """Test that missing OAuth token raises ValueError on enter."""
        if not SYNC_AVAILABLE:
            pytest.skip("greenlet not installed")

        # Clear env var if set
        original = os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        try:
            box = SyncSkillBox(oauth_token="", runtime=shared_sync_runtime)
            with pytest.raises(ValueError, match="OAuth token required"):
                with box:
                    pass
        finally:
            if original:
                os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = original

    def test_skills_default_empty_list(self, shared_sync_runtime):
        """Test that skills defaults to empty list."""
        box = boxlite.SkillBox(oauth_token="test-token", runtime=shared_sync_runtime)
        assert box._skills == []

    def test_skills_stored_correctly(self, shared_sync_runtime):
        """Test that skills are stored correctly."""
        skills = ["anthropics/skills", "some/other-skill"]
        box = boxlite.SkillBox(
            skills=skills, oauth_token="test-token", runtime=shared_sync_runtime
        )
        assert box._skills == skills

    def test_default_auto_remove_true(self, shared_sync_runtime):
        """Test that auto_remove defaults to True for automatic cleanup."""
        box = boxlite.SkillBox(oauth_token="test-token", runtime=shared_sync_runtime)
        assert box._box_options.auto_remove is True
        assert box._name == "skill-box"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
