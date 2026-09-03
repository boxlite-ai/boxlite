"""DiskIoLimits: the Python surface for per-box disk I/O rate limits."""

from __future__ import annotations

import pytest

import boxlite

# Skip entire module if DiskIoLimits is not available (native extension not built)
if not hasattr(boxlite, "DiskIoLimits"):
    pytest.skip(
        "boxlite.DiskIoLimits not available (rebuild SDK with: make dev:python)",
        allow_module_level=True,
    )


class TestDiskIoLimits:
    def test_defaults_are_unlimited(self):
        """Every dimension defaults to None, meaning unlimited."""
        limits = boxlite.DiskIoLimits()
        assert limits.read_bps is None
        assert limits.write_bps is None
        assert limits.read_iops is None
        assert limits.write_iops is None

    def test_keyword_construction_and_mutation(self):
        """Each dimension is independent: bandwidth and IOPS, read and write."""
        limits = boxlite.DiskIoLimits(read_bps=50 * 1024 * 1024, write_iops=1000)
        assert limits.read_bps == 50 * 1024 * 1024
        assert limits.write_bps is None
        assert limits.read_iops is None
        assert limits.write_iops == 1000

        limits.write_bps = 20 * 1024 * 1024
        assert limits.write_bps == 20 * 1024 * 1024

    def test_repr_lists_every_dimension(self):
        text = repr(boxlite.DiskIoLimits(read_iops=2000))
        assert text.startswith("DiskIoLimits(")
        for name in ("read_bps", "write_bps", "read_iops", "write_iops"):
            assert name in text


class TestBoxOptionsDiskIo:
    def test_box_options_default_has_no_disk_io(self):
        assert boxlite.BoxOptions().disk_io is None

    def test_box_options_carries_disk_io(self):
        """disk_io rides on BoxOptions next to disk_size_gb, by keyword or attribute."""
        opts = boxlite.BoxOptions(
            image="alpine:latest",
            disk_io=boxlite.DiskIoLimits(write_bps=4 * 1024 * 1024),
        )
        assert opts.disk_io.write_bps == 4 * 1024 * 1024
        assert opts.disk_io.read_bps is None

        opts.disk_io = boxlite.DiskIoLimits(read_iops=500)
        assert opts.disk_io.read_iops == 500
