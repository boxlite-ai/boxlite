"""Real FS snapshot qualification; retain disks and logs on failure."""

import asyncio
import argparse
import hashlib
import json
from pathlib import Path
import uuid
import time

from .acceptance import ROOT, STATE, API, ADMIN_KEY, request, restart
from .config import worktree_home
from .orchestrator import exec_collect


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


async def local_probe():
    import boxlite

    home = worktree_home(ROOT, "qf")
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(home)))
    box = await runtime.create(
        boxlite.BoxOptions(
            image="alpine:3.23",
            auto_remove=False,
            detach=True,
            memory_mib=256,
            cmd=["tail", "-f", "/dev/null"],
        ),
        name="fs-probe-" + uuid.uuid4().hex[:10],
    )
    STATE.mkdir(parents=True, exist_ok=True)
    record = {"home": str(home), "id": box.id, "image": "alpine:3.23"}
    (STATE / "fs-local-box.json").write_text(json.dumps(record))
    log = STATE / "fs-local-guest.log"

    async def run(command):
        result = await asyncio.wait_for(exec_collect(box, "sh", ["-c", command]), 30)
        with log.open("a") as stream:
            stream.write(f"$ {command}\nexit={result[0]}\n{result[1]}\n{result[2]}\n")
        assert result[0] == 0, f"guest command failed; see {log}"
        return result[1]

    await asyncio.wait_for(box.start(), 180)
    await run("uname -a; cat /etc/alpine-release; mount; cat /proc/self/limits")
    await run(
        "printf before > /root/state; chmod 640 /root/state; printf modified > /etc/motd; rm /etc/issue; sync"
    )
    info = await asyncio.wait_for(box.snapshot.create(name="live"), 60)
    disk = Path(home) / "snapshots" / info.id / "disk.qcow2"
    before = digest(disk)
    await run(
        "printf after > /root/state; dd if=/dev/zero of=/root/new bs=4096 count=512; sync"
    )
    after = digest(disk)
    record.update(snapshot_id=info.id, before_sha256=before, after_sha256=after)
    (STATE / "fs-local-box.json").write_text(json.dumps(record, indent=2))
    print(json.dumps(record), flush=True)
    assert before == after, "IMMUTABILITY: running source changed the snapshot disk"
    await box.stop()
    box = await runtime.get(box.id)
    await box.snapshot.restore("live")
    await box.start()
    assert (
        await run(
            "cat /root/state; stat -c %a /root/state; test ! -e /etc/issue; test ! -e /root/new"
        )
    ).splitlines() == ["before640"]
    await runtime.remove(box.id, force=True)
    await runtime.snapshot_remove(info.id)
    print("LOCAL_PROBE_PASS (not runner acceptance)", flush=True)


async def runner_probe():
    import boxlite
    from boxlite.errors import (
        AlreadyExistsError,
        InternalError,
        InvalidArgumentError,
        InvalidStateError,
    )

    principal = request("/v1/me")
    assert request("/v1/config")["capabilities"]["snapshots_enabled"] is True

    def connect():
        return boxlite.Boxlite.rest(
            boxlite.BoxliteRestOptions(
                url=API,
                credential=boxlite.ApiKeyCredential(ADMIN_KEY),
                path_prefix=principal["path_prefix"],
            )
        )

    runtime = connect()
    marker = "fs-" + uuid.uuid4().hex[:12]
    box = await asyncio.wait_for(
        runtime.create(
            boxlite.BoxOptions(
                image="alpine:3.23",
                cpus=1,
                memory_mib=256,
                disk_size_gb=1,
                entrypoint=["sh", "-c"],
                cmd=["exec tail -f /dev/null"],
                auto_stop=0,
                auto_delete=0,
            ),
            name=marker,
        ),
        180,
    )
    record = {
        "id": box.id,
        "image": "alpine:3.23",
        "snapshot_name": marker,
        "runner_home": str(worktree_home(ROOT, "qa")),
    }
    (STATE / "fs-runner-box.json").write_text(json.dumps(record, indent=2))
    log = STATE / "fs-runner-guest.log"

    async def run(command):
        result = await asyncio.wait_for(exec_collect(box, "sh", ["-c", command]), 60)
        with log.open("a") as stream:
            stream.write(f"$ {command}\nexit={result[0]}\n{result[1]}\n{result[2]}\n")
        assert result[0] == 0, f"guest command failed; see {log}"
        return result[1]

    await run("uname -a; cat /etc/alpine-release; mount")
    await run(
        "printf before > /root/state; chmod 640 /root/state; printf modified > /etc/motd; rm /etc/issue; sync"
    )
    existing_disks = set(worktree_home(ROOT, "qa").glob("snapshots/*/disk.qcow2"))
    info = await asyncio.wait_for(box.snapshot.create(name=marker), 90)
    assert info.snapshot_type == "filesystem" and not info.is_mock
    assert info.box_id == box.id
    assert (await box.snapshot.get(marker)).id == info.id
    assert info.id in [s.id for s in await box.snapshot.list()]
    disks = list(
        set(worktree_home(ROOT, "qa").glob("snapshots/*/disk.qcow2")) - existing_disks
    )
    assert len(disks) == 1, "snapshot absent from this checkout's actual runner home"
    before = digest(disks[0])
    record.update(snapshot_id=info.id, disk=str(disks[0]), snapshot_sha256=before)
    (STATE / "fs-runner-box.json").write_text(json.dumps(record, indent=2))
    print(json.dumps(record), flush=True)
    await run("printf after > /root/state; printf new > /root/after; sync")
    assert digest(disks[0]) == before, "source write mutated snapshot"
    for name, error in [
        (marker, AlreadyExistsError),
        ("../escape", InvalidArgumentError),
    ]:
        try:
            await box.snapshot.create(name=name)
        except error:
            pass
        else:
            raise AssertionError(f"invalid snapshot request succeeded: {name}")
    try:
        await box.snapshot.restore(marker)
    except InvalidStateError:
        pass
    else:
        raise AssertionError("running source accepted disk replacement")
    assert await run("printf still-running") == "still-running"
    # Force a real host storage failure inside the freeze/copy/thaw bracket.
    # Always repair permissions before another operation, even if assertions fail.
    snapshot_root = disks[0].parent.parent
    before_failure = set(snapshot_root.iterdir())
    snapshot_root.chmod(0o500)
    try:
        try:
            await asyncio.wait_for(box.snapshot.create(name=marker + "-failure"), 60)
        except InternalError:
            pass
        else:
            raise AssertionError(
                "read-only snapshot root unexpectedly accepted creation"
            )
    finally:
        snapshot_root.chmod(0o700)
    assert await box.snapshot.get(marker + "-failure") is None
    assert set(snapshot_root.iterdir()) == before_failure
    assert (
        await run("printf thawed > /root/thaw-check; sync; cat /root/thaw-check")
        == "thawed"
    )
    print(
        "ERROR_RECOVERY PASS: actual disk failure leaves guest writable and no snapshot",
        flush=True,
    )
    print("S1 PASS: real SDK/API/runner capture; source remains usable", flush=True)
    await box.stop()
    deadline = time.monotonic() + 90
    while (await box.info()).state.status != "stopped":
        if time.monotonic() >= deadline:
            raise TimeoutError("source did not stop")
        await asyncio.sleep(0.2)
    await asyncio.to_thread(restart)
    runtime = connect()
    box = await runtime.get(record["id"])
    assert (await box.snapshot.get(marker)).id == info.id
    await box.snapshot.restore(marker)
    await box.start()
    assert (
        await run(
            "cat /root/state; stat -c %a /root/state; cat /etc/motd; test ! -e /etc/issue; test ! -e /root/after"
        )
        == "before640\nmodified"
    )
    await box.snapshot.create(name=marker + "-delete")
    await box.snapshot.remove(marker + "-delete")
    assert await box.snapshot.get(marker + "-delete") is None
    try:
        await box.snapshot.remove(marker)
    except InvalidStateError:
        pass
    else:
        raise AssertionError("referenced snapshot was deleted")
    print("S4 PASS: service restart, metadata, restore, delete and errors", flush=True)
    await runtime.remove(box.id, force=True)
    async with asyncio.timeout(90):
        while True:
            try:
                await runtime.snapshot_remove(info.id)
                break
            except InvalidStateError:
                await asyncio.sleep(0.2)
    print(
        "RUNNER_FS_PASS; F5 child creation and cache-volume boundary are separate",
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner", action="store_true")
    asyncio.run(runner_probe() if parser.parse_args().runner else local_probe())
