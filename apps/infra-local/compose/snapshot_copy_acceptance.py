"""Real SDK/API/two-runner immutable snapshot transfer and cold creation."""

import asyncio
import hashlib
import json
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from .acceptance import (
    ADMIN_KEY,
    API,
    ROOT,
    RUNNER_B_KEY,
    STATE,
    request,
    restart,
    two_runners,
)
from .config import InfraConfig, worktree_home
from .orchestrator import exec_collect


async def probe():
    from boxlite.errors import BoxliteError, NotFoundError

    import boxlite

    topology = two_runners()
    tenant = request("/v1/me")["path_prefix"]
    tag = "snapshot-copy-" + uuid.uuid4().hex[:10]
    record = {"tag": tag, "topology": topology, "boxes": [], "results": {}}
    path = STATE / f"{tag}.json"
    log = STATE / f"{tag}-guest.log"
    (STATE / "snapshot-copy-latest.json").write_text(json.dumps({"record": str(path)}))

    def save():
        path.write_text(json.dumps(record, indent=2))

    def connect():
        return boxlite.Boxlite.rest(
            boxlite.BoxliteRestOptions(
                url=API,
                credential=boxlite.ApiKeyCredential(ADMIN_KEY),
                path_prefix=tenant,
            )
        )

    runtime = connect()

    def select(node=None):
        for key in ("a", "b"):
            request(
                f"/admin/runners/{topology[key]['id']}/scheduling",
                {"unschedulable": node is not None and key != node},
                method="PATCH",
            )

    def options():
        return boxlite.BoxOptions(
            image="alpine:3.23.6",
            cpus=1,
            memory_mib=256,
            disk_size_gb=1,
            entrypoint=["sh", "-c"],
            cmd=["exec tail -f /dev/null"],
            auto_stop=0,
            auto_delete=0,
        )

    async def run(box, command):
        rc, out, err = await asyncio.wait_for(
            exec_collect(box, "sh", ["-c", "set -eu; " + command]), 60
        )
        with log.open("a") as stream:
            stream.write(f"{box.id} $ {command}\nexit={rc}\n{out}\n{err}\n")
        assert rc == 0, f"guest failed; see {log}"
        return out.strip()

    async def child(snapshot, suffix, node):
        box = await asyncio.wait_for(
            runtime.create_from_snapshot(
                snapshot, name=tag + suffix, options=options()
            ),
            180,
        )
        record["boxes"].append(box.id)
        save()
        assert request(f"/box/{box.id}")["runnerId"] == topology[node]["id"]
        assert (
            await run(
                box,
                "cat /root/state; stat -c %a /root/state; cat /etc/motd; test ! -e /etc/issue",
            )
            == "snapshot640\nchanged"
        )
        boot = await run(box, "cat /proc/sys/kernel/random/boot_id")
        assert boot not in record["boot_ids"]
        record["boot_ids"].append(boot)
        save()
        return box

    async def deny_foreign(snapshot):
        # Only auth fixture provisioning uses local infra; every negative check
        # below goes through the production SDK/API authorization path.
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

        other = str(uuid.uuid4())
        assert str(uuid.UUID(tenant)) == tenant
        key = "local-snapshot-tenant-" + uuid.uuid4().hex
        key_hash = hashlib.sha256(key.encode()).hexdigest()
        admin_hash = hashlib.sha256(ADMIN_KEY.encode()).hexdigest()
        record["foreign_tenant"] = other
        save()
        credentials = STATE / f"{tag}-auth.json"
        credentials.write_text(json.dumps({"tenant": other, "key": key}))
        credentials.chmod(0o600)
        await sql(f"""INSERT INTO organization (id,name,"createdBy","defaultRegionId")
            SELECT '{other}','{tag}',"createdBy","defaultRegionId" FROM organization WHERE id='{tenant}';
            INSERT INTO api_key ("organizationId","userId",name,"keyHash","keyPrefix","keySuffix",permissions,"createdAt")
            SELECT '{other}',"userId",'{tag}','{key_hash}','local','fixture',permissions,NOW()
            FROM api_key WHERE "keyHash"='{admin_hash}';""")
        foreign = boxlite.Boxlite.rest(
            boxlite.BoxliteRestOptions(
                url=API, credential=boxlite.ApiKeyCredential(key), path_prefix=other
            )
        )
        assert await foreign.list_info() == [], (
            "fixture key did not resolve to an empty separate organization"
        )
        for operation in (
            lambda: foreign.snapshot_get(snapshot),
            lambda: foreign.create_from_snapshot(snapshot),
            lambda: foreign.snapshot_copy(snapshot, topology["b"]["id"]),
        ):
            try:
                await operation()
            except NotFoundError:
                pass
            else:
                raise AssertionError(
                    "foreign snapshot exposed to separately authenticated tenant"
                )
        record["results"]["authenticated_tenant_denial"] = "PASS"
        save()
        await sql(
            f"""DELETE FROM api_key WHERE "organizationId"='{other}'; DELETE FROM organization WHERE id='{other}';"""
        )
        credentials.unlink()

    try:
        select("a")
        a = await asyncio.wait_for(runtime.create(options(), name=tag + "-a"), 180)
        record["boxes"].append(a.id)
        record["platform"] = await run(a, "uname -a; cat /etc/alpine-release")
        record["boot_ids"] = [await run(a, "cat /proc/sys/kernel/random/boot_id")]
        await run(
            a,
            "printf snapshot >/root/state; chmod 640 /root/state; printf changed >/etc/motd; rm /etc/issue; sync",
        )
        s = await a.snapshot.create(name="fixed")
        record["original"] = s.id
        save()
        await deny_foreign(s.id)
        await run(a, "printf source-after >/root/state; sync")
        # Unavailable target must fail, with the original still readable.
        try:
            await runtime.snapshot_copy(s.id, topology["b"]["id"])
        except BoxliteError as error:
            record["unavailable_error"] = str(error)
        else:
            raise AssertionError("unschedulable destination accepted")
        select()
        copied = await asyncio.wait_for(
            runtime.snapshot_copy(s.id, topology["b"]["id"], name=tag), 280
        )
        record["copy"] = copied.id
        save()
        assert copied.id != s.id and not copied.is_mock
        b = await child(copied.id, "-b", "b")
        c = await child(copied.id, "-c", "b")
        await run(b, "printf child-b >/root/state; sync")
        assert await run(a, "cat /root/state") == "source-after"
        assert await run(c, "cat /root/state") == "snapshot"
        record["results"]["cross_runner_copy_isolation"] = "PASS"
        save()
        await runtime.remove(a.id, force=True)
        await runtime.snapshot_remove(s.id)
        assert await run(b, "cat /root/state") == "child-b"
        assert await run(c, "cat /root/state") == "snapshot"
        for box in (b, c):
            await box.stop()
        async with asyncio.timeout(90):
            while [(await box.info()).state.status for box in (b, c)] != [
                "stopped",
                "stopped",
            ]:
                await asyncio.sleep(0.3)
        await asyncio.to_thread(restart)
        await asyncio.to_thread(two_runners)
        runtime = connect()
        assert (await runtime.snapshot_get(copied.id)).id == copied.id
        d = await child(copied.id, "-d", "b")
        await runtime.snapshot_remove(copied.id)
        assert await run(d, "cat /root/state") == "snapshot"
        for missing in (s.id, copied.id, str(uuid.uuid4())):
            try:
                await runtime.create_from_snapshot(missing)
            except NotFoundError:
                pass
            else:
                raise AssertionError("missing snapshot accepted")
        record["results"]["restart_and_deletion"] = "PASS"
        # The actual migration importer must reject corrupt input without leaking
        # a temporary native Box or snapshot. Inspect only this runner's home.
        target = Path(topology["b"]["home"])
        before = {
            str(p) for root in ("boxes", "snapshots") for p in (target / root).iterdir()
        }
        req = urllib.request.Request(
            f"http://127.0.0.1:{topology['b']['port']}/v1/snapshot-imports/invalid",
            data=b"invalid archive",
            method="POST",
            headers={
                "Authorization": f"Bearer {RUNNER_B_KEY}",
                "X-Boxlite-Architecture": "arm64",
            },
        )
        try:
            response = await asyncio.to_thread(urllib.request.urlopen, req, timeout=60)
        except urllib.error.HTTPError as error:
            record["invalid_archive"] = {
                "status": error.code,
                "body": error.read().decode(),
            }
            assert error.code >= 400
        else:
            response.close()
            raise AssertionError("invalid archive accepted")
        after = {
            str(p) for root in ("boxes", "snapshots") for p in (target / root).iterdir()
        }
        assert before == after, "failed import leaked native resources"
        for node in ("a", "b"):
            assert not list(
                (Path(topology[node]["home"]) / "tmp").glob("snapshot-transfer-*")
            )
        record["results"]["failed_import_cleanup"] = "PASS"
        save()
        for box in (b, c, d):
            await runtime.remove(box.id, force=True)
        record["status"] = "PASS"
        save()
        print(f"SNAPSHOT_COPY_PASS {path}", flush=True)
    except BaseException as error:
        record["status"] = "FAIL"
        record["error"] = repr(error)
        save()
        print(f"FAILURE_SCENE {path} {log}", flush=True)
        raise
    finally:
        select()


if __name__ == "__main__":
    asyncio.run(probe())
