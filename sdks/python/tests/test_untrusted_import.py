"""Tests for the Python untrusted-archive import boundary."""

from __future__ import annotations

import io
import json
import tarfile

import pytest

import boxlite

# The unit matrix intentionally omits the Rust extension. The integration lane
# builds it and exercises this native import boundary.
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not hasattr(boxlite, "Boxlite"), reason="native Rust extension not available"
    ),
]


def _write_nested_virtualization_archive(path) -> None:
    manifest = {
        "version": 3,
        "box_name": None,
        "image": "alpine:latest",
        "box_options": {"nested_virtualization": True},
        "guest_disk_checksum": "",
        "container_disk_checksum": "",
        "exported_at": "2026-07-26T00:00:00Z",
    }

    with tarfile.open(path, "w") as archive:
        for name, payload in (
            ("manifest.json", json.dumps(manifest).encode()),
            ("disk.qcow2", b"not reached: policy runs before disk installation"),
        ):
            entry = tarfile.TarInfo(name)
            entry.size = len(payload)
            archive.addfile(entry, io.BytesIO(payload))


@pytest.mark.asyncio
async def test_untrusted_import_rejects_nested_virtualization(tmp_path) -> None:
    archive_path = tmp_path / "nested.boxlite"
    _write_nested_virtualization_archive(archive_path)
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(tmp_path / "home")))

    try:
        with pytest.raises(
            RuntimeError,
            match="unsupported: nested virtualization.*REST server",
        ):
            await runtime.import_box(str(archive_path), untrusted=True)
    finally:
        await runtime.shutdown(timeout=1)
