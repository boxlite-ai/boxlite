"""E2E P0 (durable filesystem): on-box data survives a workload restart.

Requirement (Sandbox platform §5.3 / §12.1.8): after the box is stopped and
started again, files written to the rootfs — including a committed SQLite
database — must still be there. This is the durability guarantee the
assistant relies on for its authoritative Conversation/Memory/Task store.

`auto_remove=False` so that stopping the box does not delete it; the box is
removed explicitly in teardown.

Scope note: the writer process exits before `stop()`, so `db.close()`
checkpoints the WAL into the main database file — this asserts that a
*committed* row is durable across restart (the actual requirement), not that
an un-checkpointed `-wal` sidecar survives (which a workload restart can't
exercise, since the writing process is already gone).
"""

from __future__ import annotations

import asyncio

import pytest
from conftest import drain

import boxlite

SENTINEL = "persist-across-restart-a91f2c"
FILE_PATH = "/root/e2e_persist.txt"
DB_PATH = "/root/e2e_persist.db"

# Every boot gets a fresh kernel boot id. Printing it on both sides is the
# positive control for this test: without it, a `stop()`/`start()` pair that
# silently did nothing would leave the data in place and the test would pass
# while proving nothing about durability.
_BOOT_ID = (
    "try:\n"
    "    boot = open('/proc/sys/kernel/random/boot_id').read().strip()\n"
    "except Exception as e:\n"
    "    boot = 'ERR:%s' % e\n"
    "print('BOOT=%s' % boot)\n"
)

# Write a marker file and a committed SQLite row (WAL journal mode, as the
# assistant uses). On close the WAL is checkpointed into the main .db file.
_WRITE = (
    "import sqlite3\n"
    f"open({FILE_PATH!r}, 'w').write({SENTINEL!r})\n"
    f"db = sqlite3.connect({DB_PATH!r})\n"
    "db.execute('PRAGMA journal_mode=WAL')\n"
    "db.execute('CREATE TABLE IF NOT EXISTS t(v TEXT)')\n"
    f"db.execute('INSERT INTO t(v) VALUES(?)', ({SENTINEL!r},))\n"
    "db.commit()\n"
    "db.close()\n"
    "print('WROTE')\n"
) + _BOOT_ID

# Read both back and report in a single blob.
_READ = (
    "import sqlite3\n"
    "try:\n"
    f"    file_val = open({FILE_PATH!r}).read()\n"
    "except Exception as e:\n"
    "    file_val = 'FILE_ERR:%s' % e\n"
    f"db = sqlite3.connect({DB_PATH!r})\n"
    "rows = db.execute('SELECT v FROM t').fetchall()\n"
    "db.close()\n"
    "print('FILE=%s' % file_val)\n"
    "print('ROWS=%d' % len(rows))\n"
    "print('DBVAL=%s' % (rows[0][0] if rows else '<none>'))\n"
) + _BOOT_ID


def _boot_id(out: str) -> str:
    """Pull the BOOT= line out of a probe blob."""
    for line in out.splitlines():
        if line.startswith("BOOT="):
            return line[len("BOOT=") :]
    return "<missing>"


async def _run_py(box, script: str) -> tuple[int, str, str]:
    ex = await box.exec("python3", ["-c", script], None)
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    return rc.exit_code, out, err


@pytest.mark.asyncio
async def test_file_and_sqlite_survive_stop_start(rt, image):
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    try:
        # 1) Write file + committed SQLite row.
        rc, out, err = await _run_py(b, _WRITE)
        assert rc == 0 and "WROTE" in out, (
            f"write failed rc={rc} out={out!r} err={err!r}"
        )
        boot_before = _boot_id(out)
        assert boot_before not in ("<missing>", "") and not boot_before.startswith(
            "ERR:"
        ), f"could not read the guest boot id before restart → {out!r}"

        # 2) Restart the workload: stop then start the same box.
        await b.stop()
        await b.start()

        # 3) Both must still be there.
        rc, out, err = await _run_py(b, _READ)
        assert rc == 0, f"read failed rc={rc} out={out!r} err={err!r}"

        # The box must actually have rebooted — otherwise "the data is still
        # there" says nothing about durability.
        boot_after = _boot_id(out)
        assert boot_after != boot_before, (
            "box did not reboot across stop()/start() (boot id unchanged: "
            f"{boot_before!r}); the persistence assertions below would be vacuous"
        )

        assert f"FILE={SENTINEL}" in out, f"file did not survive restart → {out!r}"
        assert "ROWS=1" in out, f"SQLite row did not survive restart → {out!r}"
        assert f"DBVAL={SENTINEL}" in out, (
            f"SQLite value corrupted across restart → {out!r}"
        )
    finally:
        await rt.remove(b.id, force=True)
