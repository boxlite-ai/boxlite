"""Real SDK/API/two-runner cache qualification; failures retain disks and leases."""

import asyncio
import argparse
import json
import hashlib
import os
import shutil
import signal
import subprocess
import time
import urllib.error
import uuid
from pathlib import Path

from .acceptance import API, ADMIN_KEY, ROOT, STATE, request, restart, two_runners
from .config import InfraConfig, worktree_home
from .orchestrator import exec_collect


async def probe():
    import boxlite

    topology = two_runners()
    tenant = request("/v1/me")["path_prefix"]
    tag = "cache-" + uuid.uuid4().hex[:10]
    record = {"tag": tag, "topology": topology, "tenant": tenant, "boxes": []}
    log = STATE / f"{tag}-guest.log"
    record_path = STATE / f"{tag}.json"
    (STATE / "cache-latest.json").write_text(json.dumps({"record": str(record_path)}))

    def save():
        record_path.write_text(json.dumps(record, indent=2))

    save()

    def connect(org=tenant, key=ADMIN_KEY):
        return boxlite.Boxlite.rest(
            boxlite.BoxliteRestOptions(
                url=API, credential=boxlite.ApiKeyCredential(key), path_prefix=org
            )
        )

    runtime = connect()

    async def run(box, command):
        rc, out, err = await asyncio.wait_for(
            exec_collect(box, "sh", ["-c", "set -eu; " + command]), 60
        )
        with log.open("a") as f:
            f.write(f"{box.id} $ {command}\nexit={rc}\n{out}\n{err}\n")
        assert rc == 0, f"guest exit {rc}: {command}; see {log}"
        return out.strip()

    def path(node, org=tenant, cache=tag):
        return f"/v1/{org}/caches/{topology[node]['id']}/{cache}"

    def select(node):
        # Test-only scheduling controls. The cache API never supplies a placement
        # constraint; these select the two environments whose contents we compare.
        for key in ["a", "b"]:
            request(
                f"/admin/runners/{topology[key]['id']}/scheduling",
                {"unschedulable": key != node},
                method="PATCH",
            )

    def options(cache=tag):
        return boxlite.BoxOptions(
            image="alpine:3.23",
            cpus=1,
            memory_mib=256,
            disk_size_gb=1,
            auto_remove=False,
            detach=True,
            auto_stop=0,
            auto_delete=0,
            entrypoint=["sh", "-c"],
            cmd=["exec tail -f /dev/null"],
            volumes=[]
            if cache is None
            else [{"cache_volume": cache, "guest_path": "/cache"}],
        )

    async def create(suffix, node, rt=runtime, cache=tag, org=tenant):
        select(node)
        name = f"{tag}-{suffix}"
        record["creating"] = name
        save()
        box = await asyncio.wait_for(rt.create(options(cache), name=name), 180)
        info = request(f"/box/{box.id}") if org == tenant else {}
        lease = request(path(node, org, cache))
        # Cache lease is independent evidence of the selected runner's mount.
        record["boxes"].append(
            {
                "id": box.id,
                "name": name,
                "runner": topology[node]["id"],
                "api_runner": info.get("runnerId"),
            }
        )
        save()
        assert lease["box_id"] == box.id and lease["in_use"], lease
        if org == tenant:
            assert info.get("runnerId") == topology[node]["id"], info
        return box

    async def remove(box, node, rt=runtime, org=tenant, cache=tag):
        await rt.remove(box.id, force=True)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            info = request(path(node, org, cache))
            if not info["in_use"]:
                return
            await asyncio.sleep(0.3)
        raise TimeoutError(f"cache lease not released after {box.id} deletion")

    def expect_http(code, target, method="GET"):
        try:
            request(target, method=method)
        except urllib.error.HTTPError as error:
            data = error.read().decode()
            with log.open("a") as f:
                f.write(f"{method} {target}: {error.code} {data}\n")
            assert error.code == code, data
        else:
            raise AssertionError(f"{method} {target} unexpectedly succeeded")

    previous = {
        r["id"]: r["unschedulable"]
        for r in request("/admin/runners")
        if r["id"] in [topology["a"]["id"], topology["b"]["id"]]
    }
    try:
        a = await create("a", "a")
        await run(
            a,
            "uname -a; cat /proc/mounts; df -T /cache; printf runner-a > /cache/marker; sync",
        )
        disk_a = (
            Path(topology["a"]["home"])
            / "cache-volumes"
            / tenant
            / tag
            / "data"
            / "marker"
        )
        assert disk_a.read_text() == "runner-a", "guest write is not on runner A disk"
        assert request(path("a"))["in_use"]
        expect_http(409, path("a"), "DELETE")
        try:
            await create("conflict", "a")
        except boxlite.errors.BoxliteError as error:
            record["conflict"] = str(error)
            save()
            assert "cache is exclusively owned by another Box" in str(error), str(error)
            assert request(path("a"))["box_id"] == a.id
            # Failed API admission may retain an error Box, never a second VM.
            for info in await runtime.list_info():
                if info.name == f"{tag}-conflict":
                    await runtime.remove(info.id, force=True)
        else:
            raise AssertionError("two boxes acquired one exclusive cache")
        assert await run(a, "cat /cache/marker") == "runner-a"
        print(
            "V5 PARTIAL_PASS: ordinary cache conflict refused; Docker recovery not qualified",
            flush=True,
        )
        await remove(a, "a")
        b = await create("b", "a")
        assert await run(b, "cat /cache/marker") == "runner-a"
        print("V1 PASS", flush=True)

        c = await create("c", "b")
        await run(
            c,
            "test ! -e /cache/marker; printf runner-b > /cache/marker; sync; df -T /cache",
        )
        assert await run(b, "cat /cache/marker") == "runner-a"
        assert await run(c, "cat /cache/marker") == "runner-b"
        disk_b = (
            Path(topology["b"]["home"])
            / "cache-volumes"
            / tenant
            / tag
            / "data"
            / "marker"
        )
        assert disk_b.read_text() == "runner-b" and disk_a.read_text() == "runner-a"
        print(
            "V2 PASS: independent data on two runner processes on the same Mac",
            flush=True,
        )

        # Only authentication fixture provisioning uses the local infrastructure
        # runtime. All cache operations and guest behavior use SDK -> API -> runner.
        other = str(uuid.uuid4())
        record["other_tenant"] = other
        save()
        cfg = InfraConfig.load()
        infra = boxlite.Boxlite(
            boxlite.Options(home_dir=str(worktree_home(ROOT, "qh")))
        )
        pg = await infra.get("boxlite-local-postgres")

        async def sql(statement):
            result = await asyncio.wait_for(
                exec_collect(
                    pg,
                    "psql",
                    [
                        "-v",
                        "ON_ERROR_STOP=1",
                        "-U",
                        cfg.pg_user,
                        "-d",
                        cfg.pg_db,
                        "-c",
                        statement,
                    ],
                ),
                30,
            )
            assert result[0] == 0, result

        # Both identifiers are generated UUIDs, never user-supplied SQL fragments.
        assert str(uuid.UUID(tenant)) == tenant
        await sql(f"""INSERT INTO organization (id,name,"createdBy","defaultRegionId")
            SELECT '{other}','{tag}',"createdBy","defaultRegionId" FROM organization WHERE id='{tenant}';""")
        # WS attach scopes API keys to their tenant, unlike admin HTTP prefix
        # switching. Provision a separately scoped, local-only fixture key.
        other_key = "local-cache-tenant-" + uuid.uuid4().hex
        key_hash = hashlib.sha256(other_key.encode()).hexdigest()
        admin_hash = hashlib.sha256(ADMIN_KEY.encode()).hexdigest()
        credentials = STATE / f"{tag}-auth.json"
        credentials.write_text(json.dumps({"tenant": other, "key": other_key}))
        credentials.chmod(0o600)
        await sql(f"""INSERT INTO api_key ("organizationId","userId",name,"keyHash","keyPrefix","keySuffix",permissions,"createdAt")
            SELECT '{other}',"userId",'{tag}','{key_hash}','local','fixture',permissions,NOW()
            FROM api_key WHERE "keyHash"='{admin_hash}';""")
        other_runtime = connect(other, other_key)
        other_box = await create("tenant-b", "a", rt=other_runtime, org=other)
        await run(
            other_box, "test ! -e /cache/marker; printf tenant-b > /cache/marker; sync"
        )
        assert await run(b, "cat /cache/marker") == "runner-a"
        assert await run(other_box, "cat /cache/marker") == "tenant-b"
        await remove(other_box, "a", rt=other_runtime, org=other)
        request(path("a", other), method="DELETE")
        print(
            "V3 TENANT_PASS: same cache ID, same runner, distinct authenticated organization contexts",
            flush=True,
        )

        # Snapshot captures the system disk, never the external cache or its path.
        await run(b, "printf system-disk > /root/system-marker; sync")
        s = await b.snapshot.create(name="cache-boundary")
        record["snapshot"] = s.id
        save()
        select("a")
        d = await runtime.create_from_snapshot(s.id, name=tag + "-no-cache")
        record["boxes"].append({"id": d.id, "name": tag + "-no-cache"})
        save()
        await run(
            d,
            'test "$(cat /root/system-marker)" = system-disk; test ! -e /cache/marker',
        )
        e = await runtime.create_from_snapshot(
            s.id, name=tag + "-new-cache", options=options(tag + "-new")
        )
        record["boxes"].append({"id": e.id, "name": tag + "-new-cache"})
        save()
        await run(
            e,
            'test "$(cat /root/system-marker)" = system-disk; test ! -e /cache/marker; printf replacement > /cache/marker; sync',
        )
        assert await run(b, "cat /cache/marker") == "runner-a"
        # Check the actual native manifest for excluded host-path configuration.
        manifests = list(
            (Path(topology["a"]["home"]) / "snapshots").glob("*/manifest.json")
        )
        assert manifests
        for manifest in manifests:
            assert "cache-volumes" not in manifest.read_text(), manifest
        await runtime.remove(d.id, force=True)
        await remove(e, "a", cache=tag + "-new")
        await runtime.snapshot_remove(s.id)
        request(path("a", cache=tag + "-new"), method="DELETE")
        print("S5 PASS: cache excluded; child mounts explicitly replaced", flush=True)

        # Stop guests before an orderly process restart. Leases survive even for
        # stopped Boxes, so restarting the control plane cannot admit a writer.
        for box in [b, c]:
            await box.stop()
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if all(
                request(f"/v1/{tenant}/boxes/{box.id}")["status"] == "stopped"
                for box in [b, c]
            ):
                break
            await asyncio.sleep(0.3)
        else:
            raise TimeoutError("guests did not stop before runner restart")
        restart()
        runtime = connect()
        expect_http(409, path("a"), "DELETE")
        b = await runtime.get(b.id)
        c = await runtime.get(c.id)
        await b.start()
        await c.start()
        assert await run(b, "cat /cache/marker") == "runner-a"
        assert await run(c, "cat /cache/marker") == "runner-b"
        await remove(c, "b", rt=runtime)
        # Preserve the lease and runner log before deliberately killing this
        # harness-owned runner process. The VM is not signalled by this injection.
        scene = STATE / f"{tag}-crash"
        scene.mkdir()
        shutil.copy2(
            Path(topology["a"]["home"]) / "cache-volumes" / tenant / tag / "lease.json",
            scene / "lease.json",
        )
        shutil.copy2(STATE / "runner-a.log", scene / "runner-a.log")
        pid = int((STATE / "runner-a.pid").read_text())
        command = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "command="], text=True
        )
        assert (
            str(ROOT / ".apps-local/bin/boxlite-runner") in command
            and os.getpgid(pid) == pid
        )
        record["crash"] = {"runner_pid": pid, "box": b.id, "scene": str(scene)}
        save()
        os.kill(pid, signal.SIGKILL)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if (
                subprocess.run(
                    ["ps", "-p", str(pid)], stdout=subprocess.DEVNULL
                ).returncode
                != 0
            ):
                break
            await asyncio.sleep(0.2)
        else:
            raise TimeoutError("killed runner not reaped")
        restart()
        runtime = connect()
        assert request(path("a"))["in_use"], "crash discarded a live Box lease"
        expect_http(409, path("a"), "DELETE")
        b = await runtime.get(b.id)
        await remove(b, "a", rt=runtime)
        recovered = await create("recovered", "a", rt=runtime)
        assert await run(recovered, "cat /cache/marker") == "runner-a"
        await remove(recovered, "a", rt=runtime)
        print(
            "V5 RECOVERY_PASS: runner crash retains ownership until confirmed Box deletion; sequential ordinary reuse succeeds",
            flush=True,
        )
        expect_http(409, path("a") + "?idle_before=2000-01-01T00:00:00Z", "DELETE")
        for node in ["a", "b"]:
            request(path(node), method="DELETE")
            expect_http(404, path(node))
        fresh = await create("fresh", "a", rt=runtime)
        await run(fresh, "test ! -e /cache/marker")
        await remove(fresh, "a", rt=runtime)
        request(path("a"), method="DELETE")
        await sql(
            f"DELETE FROM api_key WHERE \"organizationId\"='{other}'; DELETE FROM organization WHERE id='{other}';"
        )
        credentials.unlink()
        print(
            "V3 PASS: restart, tenant separation, active refusal, age guard, deletion and reinitialization",
            flush=True,
        )
        record["ordinary_cache"] = "PASS"
        save()
        print(json.dumps(record), flush=True)
    finally:
        for runner, unschedulable in previous.items():
            request(
                f"/admin/runners/{runner}/scheduling",
                {"unschedulable": unschedulable},
                method="PATCH",
            )


async def diagnose():
    """Read a retained tenant cache through both guest status and stdout."""
    import boxlite

    record_file = os.environ.get("CACHE_RECORD")
    if record_file is None:
        record_file = json.loads((STATE / "cache-latest.json").read_text())["record"]
    record = json.loads(Path(record_file).read_text())
    rt = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=API,
            credential=boxlite.ApiKeyCredential(ADMIN_KEY),
            path_prefix=record["other_tenant"],
        )
    )
    item = next(b for b in record["boxes"] if b["name"].endswith("-tenant-b"))
    box = await rt.get(item["id"])
    for command in [
        "exit 37",
        'test "$(cat /cache/marker)" = wrong-value',
        'test "$(cat /cache/marker)" = tenant-b',
    ]:
        rc, out, err = await asyncio.wait_for(
            exec_collect(box, "sh", ["-c", command]), 30
        )
        print(
            json.dumps({"command": command, "rc": rc, "stdout": out, "stderr": err}),
            flush=True,
        )
    for i in range(20):
        rc, out, err = await asyncio.wait_for(
            exec_collect(
                box,
                "sh",
                ["-c", 'test "$(cat /cache/marker)" = tenant-b && cat /cache/marker'],
            ),
            30,
        )
        print(
            json.dumps({"iteration": i, "rc": rc, "stdout": out, "stderr": err}),
            flush=True,
        )
        assert rc == 0, "guest cache content mismatch"
        if out != "tenant-b":
            print(
                "OUTPUT_LOSS_REPRODUCED: guest content assertion succeeded but stdout is missing",
                flush=True,
            )
            return
    print("OUTPUT_LOSS_NOT_REPRODUCED_IN_20_READS", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diagnose", action="store_true")
    asyncio.run(diagnose() if parser.parse_args().diagnose else probe())
