"""
Integration tests for SyncSkillBox convenience wrapper.

Tests the synchronous SkillBox API using greenlet fiber switching.
These tests require a working VM/libkrun setup.
"""

from __future__ import annotations

import os

import pytest

# Try to import sync API - skip if greenlet not installed
try:
    from boxlite import SyncSkillBox

    SYNC_AVAILABLE = True
except ImportError:
    SYNC_AVAILABLE = False

# Skip all tests in this module if greenlet not installed
pytestmark = pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")


@pytest.fixture
def oauth_token():
    """Get OAuth token from environment or skip."""
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if not token:
        pytest.skip("CLAUDE_CODE_OAUTH_TOKEN not set")
    return token


@pytest.mark.integration
class TestSyncSkillBoxBasic:
    """Tests for SyncSkillBox basic functionality."""

    def test_context_manager(self, shared_sync_runtime, oauth_token):
        """SyncSkillBox works as context manager."""
        with SyncSkillBox(
            name="test-sync-skillbox-context",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            assert box is not None
            assert box.id is not None

    def test_box_id_exists(self, shared_sync_runtime, oauth_token):
        """Test that SyncSkillBox has an id property."""
        with SyncSkillBox(
            name="test-sync-skillbox-id",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            assert isinstance(box.id, str)
            assert len(box.id) == 26  # ULID format

    def test_default_values(self, shared_sync_runtime, oauth_token):
        """Test SyncSkillBox default configuration values."""
        with SyncSkillBox(
            name="test-sync-skillbox-defaults",
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
        """Test SyncSkillBox with custom name."""
        with SyncSkillBox(
            name="test-sync-skillbox-custom-name",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            info = box.info()
            assert info.name == "test-sync-skillbox-custom-name"

    def test_custom_memory(self, shared_sync_runtime, oauth_token):
        """Test SyncSkillBox with custom memory limit."""
        with SyncSkillBox(
            name="test-sync-skillbox-memory",
            auto_remove=True,
            memory_mib=1024,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            info = box.info()
            assert info.memory_mib == 1024


@pytest.mark.integration
class TestSyncSkillBoxSetup:
    """Test SyncSkillBox dependency installation."""

    @pytest.mark.slow
    def test_setup_installs_dependencies(self, shared_sync_runtime, oauth_token):
        """Test that setup installs Claude CLI and required dependencies."""
        with SyncSkillBox(
            name="test-sync-skillbox-setup",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            # Trigger lazy setup by accessing internal method
            box._setup()

            # Verify Claude CLI is installed (use parent's method via _run_cmd)
            result = box._run_cmd("which", "claude")
            assert result.exit_code == 0

            # Verify bash is installed
            result = box._run_cmd("which", "bash")
            assert result.exit_code == 0


@pytest.mark.integration
class TestSyncSkillBoxInstallSkill:
    """Test sync skill installation functionality."""

    @pytest.mark.slow
    def test_install_skill_returns_bool(self, shared_sync_runtime, oauth_token):
        """Test that install_skill returns a boolean."""
        with SyncSkillBox(
            name="test-sync-skillbox-install",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            # Install a known valid skill
            result = box.install_skill("anthropics/skills")
            assert isinstance(result, bool)

    @pytest.mark.slow
    def test_install_invalid_skill_returns_false(
        self, shared_sync_runtime, oauth_token
    ):
        """Test that installing an invalid skill returns False."""
        with SyncSkillBox(
            name="test-sync-skillbox-invalid",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_sync_runtime,
        ) as box:
            # Install a non-existent skill
            result = box.install_skill("invalid/nonexistent-skill-12345")
            assert result is False


@pytest.mark.integration
class TestSyncSkillBoxCall:
    """Test SyncSkillBox.call() method for Claude interactions.

    These tests require a valid OAuth token and network access to Claude API.
    They are marked as skip since they require external credentials.
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


class TestSyncSkillBoxExports:
    """Test SyncSkillBox module exports (no VM needed)."""

    @pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")
    def test_sync_skillbox_exported_from_boxlite(self):
        """Test that SyncSkillBox is exported from boxlite module."""
        import boxlite

        assert hasattr(boxlite, "SyncSkillBox")

    @pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")
    def test_sync_skillbox_from_sync_api_module(self):
        """Test that SyncSkillBox can be imported from sync_api module."""
        from boxlite.sync_api import SyncSkillBox as SyncSkillBoxFromModule
        import boxlite

        assert SyncSkillBoxFromModule is boxlite.SyncSkillBox

    @pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")
    def test_sync_skillbox_has_expected_methods(self):
        """Test that SyncSkillBox has expected public methods."""
        assert hasattr(SyncSkillBox, "call")
        assert hasattr(SyncSkillBox, "install_skill")
        assert hasattr(SyncSkillBox, "info")
        # exec is inherited from SyncSimpleBox
        from boxlite.sync_api import SyncSimpleBox

        assert hasattr(SyncSimpleBox, "exec")

    @pytest.mark.skipif(not SYNC_AVAILABLE, reason="greenlet not installed")
    def test_sync_skillbox_inherits_from_sync_simplebox(self):
        """Test that SyncSkillBox inherits from SyncSimpleBox."""
        from boxlite.sync_api import SyncSimpleBox

        assert issubclass(SyncSkillBox, SyncSimpleBox)


@pytest.mark.integration
class TestSyncSkillBoxValidation:
    """Test input validation."""

    def test_missing_oauth_raises_error(self, shared_sync_runtime):
        """Test that missing OAuth token raises ValueError on enter."""
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
        box = SyncSkillBox(oauth_token="test-token", runtime=shared_sync_runtime)
        assert box._skills == []

    def test_skills_stored_correctly(self, shared_sync_runtime):
        """Test that skills are stored correctly."""
        skills = ["anthropics/skills", "some/other-skill"]
        box = SyncSkillBox(
            skills=skills, oauth_token="test-token", runtime=shared_sync_runtime
        )
        assert box._skills == skills


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
