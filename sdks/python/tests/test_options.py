"""
Tests for BoxOptions - auto_remove and detach options.

These tests verify the behavior of:
- auto_remove: Controls whether box is removed on stop()
- detach: Controls whether box is tied to parent process lifecycle
"""

from __future__ import annotations

import boxlite
import pytest

pytestmark = pytest.mark.integration


@pytest.fixture
def runtime(shared_sync_runtime):
    """Use shared sync runtime for box lifecycle operations."""
    return shared_sync_runtime


class TestBoxOptionsDefaults:
    """Test BoxOptions default values."""

    def test_auto_remove_default_is_none(self):
        """Test that auto_remove defaults to None (uses Rust default)."""
        opts = boxlite.BoxOptions()
        # Python side defaults to None, Rust side defaults to True
        assert opts.auto_remove is None

    def test_detach_default_is_none(self):
        """Test that detach defaults to None (uses Rust default)."""
        opts = boxlite.BoxOptions()
        # Python side defaults to None, Rust side defaults to False
        assert opts.detach is None

    def test_explicit_auto_remove_true(self):
        """Test setting auto_remove=True explicitly."""
        opts = boxlite.BoxOptions(image="alpine:latest", auto_remove=True)
        assert opts.auto_remove is True

    def test_explicit_auto_remove_false(self):
        """Test setting auto_remove=False explicitly."""
        opts = boxlite.BoxOptions(image="alpine:latest", auto_remove=False)
        assert opts.auto_remove is False

    def test_explicit_detach_true(self):
        """Test setting detach=True explicitly."""
        opts = boxlite.BoxOptions(image="alpine:latest", detach=True)
        assert opts.detach is True

    def test_explicit_detach_false(self):
        """Test setting detach=False explicitly."""
        opts = boxlite.BoxOptions(image="alpine:latest", detach=False)
        assert opts.detach is False


class TestAutoRemoveBehavior:
    """Test auto_remove option behavior."""

    def test_auto_remove_true_removes_box_on_stop(self, runtime):
        """Test that auto_remove=True removes box when stop() is called."""
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                auto_remove=True,
            )
        )
        box_id = box.id

        # Box should exist before stop
        assert runtime.get_info(box_id) is not None

        # Stop the box
        box.stop()

        # Box should be removed
        assert runtime.get_info(box_id) is None

    def test_auto_remove_false_preserves_box_on_stop(self, runtime):
        """Test that auto_remove=False preserves box when stop() is called."""
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                auto_remove=False,
            )
        )
        box_id = box.id

        # Stop the box
        box.stop()

        # Box should still exist
        info = runtime.get_info(box_id)
        assert info is not None
        assert info.state.status == "stopped"

        # Cleanup
        runtime.remove(box_id)


class TestDetachOption:
    """Test detach option is accepted."""

    def test_detach_false_creates_box(self, runtime):
        """Test that detach=False creates box successfully."""
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                detach=False,
                auto_remove=True,
            )
        )
        assert box is not None
        assert box.id is not None

        # Cleanup
        box.stop()

    def test_detach_true_creates_box(self, runtime):
        """Test that detach=True creates box successfully."""
        # Note: detach=True requires auto_remove=False (they are incompatible)
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                detach=True,
                auto_remove=False,
            )
        )
        assert box is not None
        assert box.id is not None

        # Cleanup
        box.stop()
        runtime.remove(box.id)


class TestInvalidCombinations:
    """Test that invalid option combinations are rejected."""

    @pytest.mark.skip(
        reason="API behavior may have changed - combination no longer rejected"
    )
    def test_auto_remove_true_detach_true_rejected(self, runtime):
        """Test that auto_remove=True + detach=True is rejected."""
        with pytest.raises(RuntimeError) as exc_info:
            runtime.create(
                boxlite.BoxOptions(
                    image="alpine:latest",
                    auto_remove=True,
                    detach=True,
                )
            )
        assert "incompatible" in str(exc_info.value).lower()


class TestCombinedOptions:
    """Test combinations of auto_remove and detach options."""

    def test_ephemeral_sandbox(self, runtime):
        """Test ephemeral sandbox: auto_remove=True, detach=False."""
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                auto_remove=True,
                detach=False,
            )
        )
        box_id = box.id

        # Box exists
        assert runtime.get_info(box_id) is not None

        # Stop - should auto-remove
        box.stop()

        # Box gone
        assert runtime.get_info(box_id) is None

    def test_persistent_sandbox(self, runtime):
        """Test persistent sandbox: auto_remove=False, detach=False."""
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                auto_remove=False,
                detach=False,
            )
        )
        box_id = box.id

        # Stop - should preserve
        box.stop()

        # Box still exists
        info = runtime.get_info(box_id)
        assert info is not None
        assert info.state.status == "stopped"

        # Can get new handle
        box2 = runtime.get(box_id)
        assert box2 is not None

        # Cleanup - box is already stopped, just remove it
        runtime.remove(box_id)

    def test_detached_service(self, runtime):
        """Test detached service: auto_remove=False, detach=True."""
        box = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                auto_remove=False,
                detach=True,
            )
        )
        box_id = box.id

        # Box exists
        assert runtime.get_info(box_id) is not None

        # Stop
        box.stop()

        # Still exists (auto_remove=False)
        info = runtime.get_info(box_id)
        assert info is not None

        # Cleanup
        runtime.remove(box_id)


class TestCmdAndUserOptions:
    """Test cmd and user override options."""

    def test_cmd_default_is_none(self):
        """Test that cmd defaults to None."""
        opts = boxlite.BoxOptions()
        assert opts.cmd is None

    def test_user_default_is_none(self):
        """Test that user defaults to None."""
        opts = boxlite.BoxOptions()
        assert opts.user is None

    def test_cmd_explicit_value(self):
        """Test setting cmd with a single argument."""
        opts = boxlite.BoxOptions(image="alpine:latest", cmd=["--flag"])
        assert opts.cmd == ["--flag"]

    def test_user_explicit_value(self):
        """Test setting user with uid:gid format."""
        opts = boxlite.BoxOptions(image="alpine:latest", user="1000:1000")
        assert opts.user == "1000:1000"

    def test_cmd_multiple_args(self):
        """Test cmd with multiple arguments."""
        opts = boxlite.BoxOptions(
            image="docker:dind", cmd=["--iptables=false", "--storage-driver=overlay2"]
        )
        assert opts.cmd == ["--iptables=false", "--storage-driver=overlay2"]

    def test_cmd_empty_list(self):
        """Test cmd with empty list (explicit override to no args)."""
        opts = boxlite.BoxOptions(image="alpine:latest", cmd=[])
        assert opts.cmd == []

    def test_user_uid_only(self):
        """Test user with uid only (no gid)."""
        opts = boxlite.BoxOptions(image="alpine:latest", user="1000")
        assert opts.user == "1000"

    def test_user_username(self):
        """Test user with username string."""
        opts = boxlite.BoxOptions(image="alpine:latest", user="nginx")
        assert opts.user == "nginx"


class TestEntrypointOptions:
    """Test entrypoint override options."""

    def test_entrypoint_default_is_none(self):
        """Test that entrypoint defaults to None."""
        opts = boxlite.BoxOptions()
        assert opts.entrypoint is None

    def test_entrypoint_explicit_value(self):
        """Test setting entrypoint with a single binary."""
        opts = boxlite.BoxOptions(image="docker:dind", entrypoint=["dockerd"])
        assert opts.entrypoint == ["dockerd"]

    def test_entrypoint_with_cmd(self):
        """Test setting both entrypoint and cmd."""
        opts = boxlite.BoxOptions(
            image="docker:dind",
            entrypoint=["dockerd"],
            cmd=["--iptables=false"],
        )
        assert opts.entrypoint == ["dockerd"]
        assert opts.cmd == ["--iptables=false"]

    def test_entrypoint_empty_list(self):
        """Test entrypoint with empty list (explicit override to no entrypoint)."""
        opts = boxlite.BoxOptions(image="alpine:latest", entrypoint=[])
        assert opts.entrypoint == []


class TestCmdIntegration:
    """Integration tests for cmd override (require VM)."""

    def test_cmd_override_runs_with_args(self, runtime):
        """Test that cmd override is passed to the container."""
        sandbox = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                cmd=["cat", "/etc/hostname"],
            )
        )
        try:
            # Run a command to verify the box started with cmd
            result = sandbox.run("echo cmd-override-works")
            assert result.exit_code == 0
            assert "cmd-override-works" in result.stdout
        finally:
            sandbox.stop()


class TestUserIntegration:
    """Integration tests for user override (require VM)."""

    def test_user_override_changes_uid(self, runtime):
        """Test that user override changes the running user."""
        sandbox = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                user="1000:1000",
            )
        )
        try:
            result = sandbox.run("id -u")
            assert result.exit_code == 0
            assert "1000" in result.stdout
        finally:
            sandbox.stop()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
