"""Managed-volume persistence and filesystem semantics over the REST SDK."""

from __future__ import annotations

import asyncio

import boxlite
import pytest

from conftest import drain


async def run(box, script: str) -> str:
    execution = await box.exec("python3", ["-c", script])
    stdout, stderr = await drain(execution)
    result = await asyncio.wait_for(execution.wait(), timeout=60)
    assert result.exit_code == 0, f"guest script failed: {stderr}"
    return stdout


@pytest.mark.asyncio
async def test_managed_volume_survives_stop_start(rt, image):
    volume = await rt.volumes.create()
    box = None
    try:
        box = await rt.create(
            boxlite.BoxOptions(
                image=image,
                auto_remove=False,
                volumes=[(volume.id, "/data")],
            ),
        )
        output = await run(
            box,
            r"""
import fcntl, json, os, sqlite3, subprocess, sys, zipfile
root = "/data/chat-claw/assistant-e2e"
dbdir = os.path.join(root, "db")
os.makedirs(dbdir, exist_ok=True)
db = os.path.join(dbdir, "assistant.db")
con = sqlite3.connect(db)
assert con.execute("pragma journal_mode=wal").fetchone()[0] == "wal"
con.execute("create table if not exists marker(value text)")
con.execute("insert into marker values ('persisted')")
con.commit()
con.close()
with open(db, "rb") as handle:
    os.fsync(handle.fileno())
tmp = os.path.join(root, "atomic.tmp")
final = os.path.join(root, "atomic.txt")
with open(tmp, "wb") as handle:
    handle.write(b"atomic")
    handle.flush()
    os.fsync(handle.fileno())
os.replace(tmp, final)
with open(os.path.join(root, "snapshot.enc"), "wb") as handle:
    handle.write(b"encrypted-snapshot-e2e")
with zipfile.ZipFile(os.path.join(root, "snapshot.zip"), "w") as archive:
    archive.write(final, "atomic.txt")
lock_path = os.path.join(root, "writer.lock")
with open(lock_path, "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    child = subprocess.run(
        [sys.executable, "-c",
         "import fcntl,sys; f=open(sys.argv[1],'w'); "
         "\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); raise SystemExit(1)"
         "\nexcept BlockingIOError: raise SystemExit(0)", lock_path]
    )
    assert child.returncode == 0
stats = os.statvfs(root)
print(json.dumps({"capacity": stats.f_blocks * stats.f_frsize}))
""",
        )
        assert '"capacity":' in output

        await box.stop()
        await box.start()

        output = await run(
            box,
            r"""
import os, sqlite3, zipfile
root = "/data/chat-claw/assistant-e2e"
db = os.path.join(root, "db", "assistant.db")
assert sqlite3.connect(db).execute("select value from marker").fetchone()[0] == "persisted"
assert open(os.path.join(root, "atomic.txt"), "rb").read() == b"atomic"
assert open(os.path.join(root, "snapshot.enc"), "rb").read() == b"encrypted-snapshot-e2e"
with zipfile.ZipFile(os.path.join(root, "snapshot.zip")) as archive:
    assert archive.read("atomic.txt") == b"atomic"
print("persistent-volume-ok")
""",
        )
        assert "persistent-volume-ok" in output
    finally:
        if box is not None:
            try:
                await rt.remove(box.id, force=True)
            except Exception:
                pass
        await rt.volumes.remove(volume.id, force=True)
