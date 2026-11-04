"""Default-runtime initialization errors must cross the Python FFI boundary safely."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration


def test_schema_mismatch_is_catchable_and_retriable(tmp_path: Path) -> None:
    db_dir = tmp_path / "db"
    db_dir.mkdir()
    db_path = db_dir / "boxlite.db"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            CREATE TABLE schema_version (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?)",
            (2_147_483_647, "test"),
        )

    child = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import os
from pathlib import Path

import boxlite

try:
    boxlite.Boxlite.default()
except RuntimeError as error:
    message = str(error)
    assert "Schema version mismatch" in message
    assert "Upgrade this SDK to a compatible version" in message
    assert "use a new BOXLITE_HOME" in message
    assert "existing boxes, images, and caches will be unavailable" in message
    print("CAUGHT_SCHEMA_MISMATCH")
else:
    raise AssertionError("schema mismatch must raise RuntimeError")

home_dir = Path(os.environ["BOXLITE_HOME"])
(home_dir / "db" / "boxlite.db").unlink()
boxlite.Boxlite.default()
boxlite.Boxlite.default()
print("RETRY_SUCCEEDED")
""",
        ],
        env={**os.environ, "BOXLITE_HOME": str(tmp_path)},
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )

    assert child.returncode == 0, child.stderr
    assert "CAUGHT_SCHEMA_MISMATCH" in child.stdout
    assert "RETRY_SUCCEEDED" in child.stdout
    assert "panicked at" not in child.stderr
    assert "fatal runtime error" not in child.stderr
