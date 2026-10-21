"""Actual cold children, independent storage and source-deletion survival."""

import argparse
import asyncio
import json
import uuid

from .acceptance import API, ADMIN_KEY, ROOT, STATE, request, restart
from .config import worktree_home
from .orchestrator import exec_collect


async def probe(remote):
    import boxlite
    from boxlite.errors import BoxliteError, NotFoundError, UnsupportedError

    def connect():
        if not remote:
            return boxlite.Boxlite(
                boxlite.Options(home_dir=str(worktree_home(ROOT, "q5")))
            )
        return boxlite.Boxlite.rest(
            boxlite.BoxliteRestOptions(
                url=API,
                credential=boxlite.ApiKeyCredential(ADMIN_KEY),
                path_prefix=request("/v1/me")["path_prefix"],
            )
        )

    runtime = connect()
    tag = "children-" + uuid.uuid4().hex[:10]
    record = {"remote": remote, "name": tag, "boxes": []}
    STATE.mkdir(parents=True, exist_ok=True)
    stem = "snapshot-children-" + ("runner" if remote else "local")
    log = STATE / (stem + "-guest.log")

    def save():
        (STATE / (stem + ".json")).write_text(json.dumps(record, indent=2))

    async def run(box, command):
        result = await asyncio.wait_for(exec_collect(box, "sh", ["-c", command]), 60)
        with log.open("a") as stream:
            stream.write(
                f"{box.id} $ {command}\nexit={result[0]}\n{result[1]}\n{result[2]}\n"
            )
        assert result[0] == 0, str(result)
        return result[1]

    a = await asyncio.wait_for(
        runtime.create(
            boxlite.BoxOptions(
                image="alpine:3.23",
                memory_mib=256,
                cpus=1,
                disk_size_gb=1,
                auto_remove=False,
                detach=True,
                auto_stop=0,
                auto_delete=0,
                entrypoint=["sh", "-c"],
                cmd=["exec tail -f /dev/null"],
            ),
            name=tag + "-a",
        ),
        180,
    )
    record["boxes"].append(a.id)
    save()
    if not remote:
        await a.start()
    await run(a, "uname -a; cat /etc/alpine-release; ip addr; ip route")
    boot_ids = {await run(a, "cat /proc/sys/kernel/random/boot_id")}
    await run(
        a,
        "printf snapshot > /root/state; chmod 640 /root/state; printf changed > /etc/motd; rm /etc/issue; sync",
    )
    s = await asyncio.wait_for(a.snapshot.create(name="fixed"), 90)
    record["snapshot"] = s.id
    save()
    assert (await runtime.snapshot_get(s.id)).id == s.id
    if not remote:
        manifest_path = worktree_home(ROOT, "q5") / "snapshots" / s.id / "manifest.json"
        original = manifest_path.read_text()
        incompatible = json.loads(original)
        incompatible["version"] = 999
        before = {box.id for box in await runtime.list_info()}
        try:
            manifest_path.write_text(json.dumps(incompatible))
            try:
                await runtime.create_from_snapshot(s.id, name=tag + "-invalid-version")
            except UnsupportedError:
                pass
            else:
                raise AssertionError("incompatible format accepted")
        finally:
            manifest_path.write_text(original)
        mode = manifest_path.stat().st_mode & 0o777
        try:
            manifest_path.chmod(0)
            try:
                await runtime.create_from_snapshot(s.id, name=tag + "-denied")
            except BoxliteError as error:
                assert "Permission denied" in str(error)
            else:
                raise AssertionError("unreadable manifest accepted")
        finally:
            manifest_path.chmod(mode)
        assert {box.id for box in await runtime.list_info()} == before
        print(
            "NATIVE_ERRORS_PASS: incompatible version and permission denied leave no children",
            flush=True,
        )
    await run(a, "printf source-after > /root/state; sync")

    async def child(suffix):
        box = await asyncio.wait_for(
            runtime.create_from_snapshot(s.id, name=tag + suffix), 180
        )
        record["boxes"].append(box.id)
        save()
        if not remote:
            await box.start()
        boot_id = await run(box, "cat /proc/sys/kernel/random/boot_id")
        assert boot_id not in boot_ids, (
            "child did not receive a new guest boot identity"
        )
        boot_ids.add(boot_id)
        record["boot_ids"] = sorted(boot_ids)
        save()
        assert (
            await run(
                box,
                "cat /root/state; stat -c %a /root/state; cat /etc/motd; test ! -e /etc/issue",
            )
            == "snapshot640\nchanged"
        )
        return box

    b = await child("-b")
    c = await child("-c")
    assert len({a.id, b.id, c.id}) == 3
    await run(b, "printf child-b > /root/state; sync")
    assert await run(a, "cat /root/state") == "source-after"
    assert await run(c, "cat /root/state") == "snapshot"
    print("S2 PASS: two cold children preserve immutable snapshot state", flush=True)
    await runtime.remove(a.id, force=True)
    assert await run(b, "cat /root/state") == "child-b"
    assert await run(c, "cat /root/state") == "snapshot"
    if remote:
        await b.stop()
        await c.stop()
        # The API stop request is asynchronous. Wait for actual terminal state.
        async with asyncio.timeout(90):
            while [(await box.info()).state.status for box in (b, c)] != [
                "stopped",
                "stopped",
            ]:
                await asyncio.sleep(0.2)
        await asyncio.to_thread(restart)
        runtime = connect()
    assert (await runtime.snapshot_get(s.id)).id == s.id
    d = await child("-d")
    print(
        "S3 PASS: source removed; children and new post-removal child usable",
        flush=True,
    )
    # Removing S cannot break fully materialized children.
    await runtime.snapshot_remove(s.id)
    for method in (runtime.snapshot_get, runtime.create_from_snapshot):
        try:
            await method(s.id)
        except NotFoundError:
            pass
        else:
            raise AssertionError("missing snapshot unexpectedly succeeded")
    assert await run(d, "cat /root/state") == "snapshot"
    for box in (b, c, d):
        await runtime.remove(box.id, force=True)
    print(json.dumps(record), flush=True)
    print(
        "CHILDREN_PASS" if remote else "LOCAL_CHILDREN_PASS (not runner qualification)",
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", action="store_true")
    asyncio.run(probe(not parser.parse_args().local))
