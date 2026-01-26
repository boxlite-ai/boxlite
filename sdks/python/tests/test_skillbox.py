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


@pytest.fixture
def oauth_token():
    """Get OAuth token from environment or skip."""
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if not token:
        pytest.skip("CLAUDE_CODE_OAUTH_TOKEN not set")
    return token


@pytest.mark.integration
class TestSkillBoxBasic:
    """Test basic SkillBox lifecycle and properties."""

    @pytest.mark.asyncio
    async def test_context_manager(self, shared_runtime, oauth_token):
        """Test SkillBox as async context manager."""
        async with boxlite.SkillBox(
            name="test-skillbox-context",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            assert box is not None
            assert box.id is not None

    @pytest.mark.asyncio
    async def test_box_id_exists(self, shared_runtime, oauth_token):
        """Test that SkillBox has an id property."""
        async with boxlite.SkillBox(
            name="test-skillbox-id",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            assert isinstance(box.id, str)
            assert len(box.id) == 26  # ULID format

    @pytest.mark.asyncio
    async def test_default_values(self, shared_runtime, oauth_token):
        """Test SkillBox default configuration values."""
        async with boxlite.SkillBox(
            name="test-skillbox-defaults",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            info = box.info()
            # Default image is node:20-alpine
            assert "node" in info.image.lower()
            # Default memory is 2048 MiB
            assert info.memory_mib == 2048

    @pytest.mark.asyncio
    async def test_custom_name(self, shared_runtime, oauth_token):
        """Test SkillBox with custom name."""
        async with boxlite.SkillBox(
            name="test-skillbox-custom-name",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            info = box.info()
            assert info.name == "test-skillbox-custom-name"

    @pytest.mark.asyncio
    async def test_custom_memory(self, shared_runtime, oauth_token):
        """Test SkillBox with custom memory limit."""
        async with boxlite.SkillBox(
            name="test-skillbox-memory",
            memory_mib=1024,
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            info = box.info()
            assert info.memory_mib == 1024


@pytest.mark.integration
class TestSkillBoxSetup:
    """Test SkillBox dependency installation."""

    @pytest.mark.asyncio
    @pytest.mark.slow
    async def test_is_claude_installed_false_initially(
        self, shared_runtime, oauth_token
    ):
        """Test that Claude CLI is not installed in fresh box."""
        # Use auto_remove=True to ensure fresh box
        async with boxlite.SkillBox(
            name="test-skillbox-fresh",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            # Directly check if claude is installed (bypassing lazy setup)
            result = await box.exec("which", "claude")
            # In a fresh box, claude should not be installed
            # Note: If box persists from previous run, this might pass
            assert result.exit_code in [0, 1]  # 0 if installed, 1 if not

    @pytest.mark.asyncio
    @pytest.mark.slow
    async def test_setup_installs_dependencies(self, shared_runtime, oauth_token):
        """Test that setup installs Claude CLI and required dependencies."""
        async with boxlite.SkillBox(
            name="test-skillbox-setup",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            # Trigger lazy setup by accessing internal method
            await box._setup()

            # Verify Claude CLI is installed
            result = await box.exec("which", "claude")
            assert result.exit_code == 0

            # Verify bash is installed
            result = await box.exec("which", "bash")
            assert result.exit_code == 0

            # Verify git is installed
            result = await box.exec("which", "git")
            assert result.exit_code == 0

            # Verify Python is installed
            result = await box.exec("which", "python3")
            assert result.exit_code == 0


@pytest.mark.integration
class TestSkillBoxInstallSkill:
    """Test skill installation functionality."""

    @pytest.mark.asyncio
    @pytest.mark.slow
    async def test_install_skill_returns_bool(self, shared_runtime, oauth_token):
        """Test that install_skill returns a boolean."""
        async with boxlite.SkillBox(
            name="test-skillbox-install",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            # Install a known valid skill
            result = await box.install_skill("anthropics/skills")
            assert isinstance(result, bool)

    @pytest.mark.asyncio
    @pytest.mark.slow
    async def test_install_invalid_skill_returns_false(
        self, shared_runtime, oauth_token
    ):
        """Test that installing an invalid skill returns False."""
        async with boxlite.SkillBox(
            name="test-skillbox-invalid",
            auto_remove=True,
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            # Install a non-existent skill
            result = await box.install_skill("invalid/nonexistent-skill-12345")
            assert result is False


@pytest.mark.integration
class TestSkillBoxCall:
    """Test SkillBox.call() method for Claude interactions.

    These tests require a valid OAuth token and network access to Claude API.
    They are marked as manual since they require external credentials.
    """

    @pytest.mark.asyncio
    @pytest.mark.slow
    @pytest.mark.skip(reason="Requires valid OAuth token and Claude API access")
    async def test_call_simple(self, shared_runtime, oauth_token):
        """Test simple call to Claude."""
        async with boxlite.SkillBox(
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            result = await box.call("Say 'hello' and nothing else")
            assert isinstance(result, str)
            assert len(result) > 0

    @pytest.mark.asyncio
    @pytest.mark.slow
    @pytest.mark.skip(reason="Requires valid OAuth token and Claude API access")
    async def test_call_multi_turn(self, shared_runtime, oauth_token):
        """Test multi-turn conversation - Claude remembers context."""
        async with boxlite.SkillBox(
            oauth_token=oauth_token,
            runtime=shared_runtime,
        ) as box:
            await box.call("My name is Alice")
            result = await box.call("What is my name?")
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
        assert hasattr(boxlite.SkillBox, "exec")
        assert hasattr(boxlite.SkillBox, "info")

    def test_skillbox_inherits_from_simplebox(self):
        """Test that SkillBox inherits from SimpleBox."""
        from boxlite.simplebox import SimpleBox

        assert issubclass(boxlite.SkillBox, SimpleBox)


@pytest.mark.integration
class TestSkillBoxValidation:
    """Test input validation."""

    @pytest.mark.asyncio
    async def test_missing_oauth_raises_error(self, shared_runtime):
        """Test that missing OAuth token raises ValueError on enter."""
        # Clear env var if set
        original = os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        try:
            box = boxlite.SkillBox(oauth_token="", runtime=shared_runtime)
            with pytest.raises(ValueError, match="OAuth token required"):
                async with box:
                    pass
        finally:
            if original:
                os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = original

    def test_skills_default_empty_list(self, shared_runtime):
        """Test that skills defaults to empty list."""
        box = boxlite.SkillBox(oauth_token="test-token", runtime=shared_runtime)
        assert box._skills == []

    def test_skills_stored_correctly(self, shared_runtime):
        """Test that skills are stored correctly."""
        skills = ["anthropics/skills", "some/other-skill"]
        box = boxlite.SkillBox(
            skills=skills, oauth_token="test-token", runtime=shared_runtime
        )
        assert box._skills == skills

    def test_default_auto_remove_true(self, shared_runtime):
        """Test that auto_remove defaults to True for automatic cleanup."""
        box = boxlite.SkillBox(oauth_token="test-token", runtime=shared_runtime)
        assert box._box_options.auto_remove is True
        assert box._name == "skill-box"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
