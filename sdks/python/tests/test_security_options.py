"""
Unit tests for SecurityOptions — no VM required.

Tests the SecurityOptions class construction, preset class methods,
and field assignment through the PyO3 binding layer.
"""

from __future__ import annotations

import sys

import boxlite
import pytest

# SecurityOptions is a PyO3 native class — only available when the Rust
# extension is compiled.  CI unit-test jobs skip the build step, so skip
# gracefully rather than failing with AttributeError.
_NATIVE_AVAILABLE = hasattr(boxlite, "SecurityOptions")

pytestmark = pytest.mark.skipif(
    not _NATIVE_AVAILABLE, reason="native Rust extension not available"
)


class TestSecurityOptionsConstruction:
    """Test SecurityOptions can be constructed with various field combinations."""

    def test_default_construction(self):
        """Default SecurityOptions uses development-safe defaults from Rust."""
        opts = boxlite.SecurityOptions()
        # Python defaults: jailer_enabled=False, seccomp_enabled=False
        assert opts.jailer_enabled is False
        assert opts.seccomp_enabled is False

    def test_jailer_enabled_field(self):
        opts = boxlite.SecurityOptions(jailer_enabled=True)
        assert opts.jailer_enabled is True

    def test_seccomp_enabled_field(self):
        opts = boxlite.SecurityOptions(seccomp_enabled=True)
        assert opts.seccomp_enabled is True

    def test_uid_gid_fields(self):
        opts = boxlite.SecurityOptions(uid=1000, gid=2000)
        assert opts.uid == 1000
        assert opts.gid == 2000

    def test_max_open_files_field(self):
        opts = boxlite.SecurityOptions(max_open_files=256)
        assert opts.max_open_files == 256

    def test_max_processes_field(self):
        opts = boxlite.SecurityOptions(max_processes=10)
        assert opts.max_processes == 10

    def test_max_memory_field(self):
        opts = boxlite.SecurityOptions(max_memory=536870912)
        assert opts.max_memory == 536870912

    def test_max_cpu_time_field(self):
        opts = boxlite.SecurityOptions(max_cpu_time=60)
        assert opts.max_cpu_time == 60

    def test_sanitize_env_field(self):
        opts = boxlite.SecurityOptions(sanitize_env=True)
        assert opts.sanitize_env is True

    def test_env_allowlist_field(self):
        opts = boxlite.SecurityOptions(env_allowlist=["PATH", "HOME"])
        assert opts.env_allowlist == ["PATH", "HOME"]

    def test_env_allowlist_empty(self):
        opts = boxlite.SecurityOptions(sanitize_env=True, env_allowlist=[])
        assert opts.sanitize_env is True
        assert opts.env_allowlist == []

    def test_close_fds_field(self):
        opts = boxlite.SecurityOptions(close_fds=True)
        assert opts.close_fds is True

    def test_new_pid_ns_field(self):
        opts = boxlite.SecurityOptions(new_pid_ns=True)
        assert opts.new_pid_ns is True

    def test_new_net_ns_field(self):
        opts = boxlite.SecurityOptions(new_net_ns=True)
        assert opts.new_net_ns is True

    def test_chroot_enabled_field(self):
        opts = boxlite.SecurityOptions(chroot_enabled=True)
        assert opts.chroot_enabled is True

    def test_network_enabled_field(self):
        opts = boxlite.SecurityOptions(network_enabled=False)
        assert opts.network_enabled is False

    def test_all_fields_combined(self):
        """All fields can be set together without conflict."""
        opts = boxlite.SecurityOptions(
            jailer_enabled=True,
            seccomp_enabled=True,
            uid=65534,
            gid=65534,
            new_pid_ns=True,
            new_net_ns=False,
            chroot_enabled=True,
            close_fds=True,
            sanitize_env=True,
            env_allowlist=["PATH"],
            max_open_files=1024,
            max_processes=100,
            network_enabled=True,
        )
        assert opts.jailer_enabled is True
        assert opts.uid == 65534
        assert opts.gid == 65534
        assert opts.sanitize_env is True
        assert opts.env_allowlist == ["PATH"]
        assert opts.max_open_files == 1024
        assert opts.max_processes == 100


class TestSecurityOptionsPresets:
    """Test SecurityOptions class method presets."""

    def test_development_preset(self):
        """development() disables all isolation — safe for local dev."""
        opts = boxlite.SecurityOptions.development()
        assert opts.jailer_enabled is False
        assert opts.seccomp_enabled is False
        assert opts.sanitize_env is False
        assert opts.close_fds is False

    def test_standard_preset(self):
        """standard() enables jailer and env sanitization."""
        opts = boxlite.SecurityOptions.standard()
        assert opts.jailer_enabled is True
        assert opts.sanitize_env is True
        assert opts.close_fds is True

    def test_maximum_preset(self):
        """maximum() enables all isolation and sets resource limits."""
        opts = boxlite.SecurityOptions.maximum()
        assert opts.jailer_enabled is True
        assert opts.seccomp_enabled is True
        assert opts.sanitize_env is True
        assert opts.close_fds is True
        # maximum preset enforces resource limits
        assert opts.max_open_files == 1024
        assert opts.max_processes == 100

    def test_maximum_preset_resource_limits_are_positive(self):
        """maximum() resource limits must be positive values."""
        opts = boxlite.SecurityOptions.maximum()
        assert opts.max_open_files is not None and opts.max_open_files > 0
        assert opts.max_processes is not None and opts.max_processes > 0

    def test_presets_are_independent_instances(self):
        """Each preset() call returns a fresh instance — mutation does not leak."""
        a = boxlite.SecurityOptions.maximum()
        b = boxlite.SecurityOptions.maximum()
        a.max_open_files = 9999
        assert b.max_open_files == 1024

    def test_standard_preset_seccomp_is_platform_specific(self):
        """standard() enables seccomp on Linux only; disabled on other platforms.

        This mirrors Rust's `cfg!(target_os = "linux")` in SecurityOptions::standard().
        """
        opts = boxlite.SecurityOptions.standard()
        if sys.platform == "linux":
            assert opts.seccomp_enabled is True
        else:
            assert opts.seccomp_enabled is False


class TestSecurityOptionsInBoxOptions:
    """Test SecurityOptions can be embedded in BoxOptions via AdvancedBoxOptions (no VM needed).

    The Python API nests security under BoxOptions.advanced:
        BoxOptions(advanced=AdvancedBoxOptions(security=SecurityOptions(...)))
    """

    def test_advanced_box_options_accepts_security(self):
        """SecurityOptions can be passed through AdvancedBoxOptions."""
        security = boxlite.SecurityOptions(jailer_enabled=True)
        advanced = boxlite.AdvancedBoxOptions(security=security)
        opts = boxlite.BoxOptions(image="alpine:latest", advanced=advanced)
        assert opts.advanced is not None
        assert opts.advanced.security is not None
        assert opts.advanced.security.jailer_enabled is True

    def test_advanced_box_options_security_defaults_to_none(self):
        """BoxOptions with no advanced has advanced=None."""
        opts = boxlite.BoxOptions(image="alpine:latest")
        assert opts.advanced is None

    def test_advanced_box_options_accepts_maximum_preset(self):
        """maximum() preset can be embedded in BoxOptions.advanced."""
        advanced = boxlite.AdvancedBoxOptions(
            security=boxlite.SecurityOptions.maximum()
        )
        opts = boxlite.BoxOptions(image="alpine:latest", advanced=advanced)
        assert opts.advanced is not None
        assert opts.advanced.security is not None
        assert opts.advanced.security.jailer_enabled is True
        assert opts.advanced.security.max_open_files == 1024
