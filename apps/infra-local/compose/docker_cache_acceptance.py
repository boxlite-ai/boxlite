"""V4/V5: actual Docker storage and exclusive reuse through the runner API."""

import argparse
import asyncio
import json
import shlex
import subprocess
import time
import uuid
from pathlib import Path

from .acceptance import ADMIN_KEY, API, ROOT, STATE, request, two_runners
from .orchestrator import exec_collect

IMAGE = "docker:27.5.1-dind@sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce"
BASE = "busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"


async def probe():
    import boxlite

    topology = two_runners()
    tenant = request("/v1/me")["path_prefix"]
    runtime = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=API,
            credential=boxlite.ApiKeyCredential(ADMIN_KEY),
            path_prefix=tenant,
        )
    )
    tag = "docker-cache-" + uuid.uuid4().hex[:10]
    record = {
        "tag": tag,
        "revision": (
            await asyncio.to_thread(
                subprocess.check_output,
                ["git", "rev-parse", "HEAD"],
                cwd=ROOT,
                text=True,
            )
        ).strip(),
        "topology": topology,
        "boxes": [],
    }
    log = STATE / f"{tag}-guest.log"
    path = STATE / f"{tag}.json"
    cache_url = f"/v1/{tenant}/caches/{topology['a']['id']}/{tag}"
    (STATE / "docker-cache-latest.json").write_text(json.dumps({"record": str(path)}))

    def save():
        path.write_text(json.dumps(record, indent=2))

    async def run(box, command, check=True, timeout=180):
        rc, out, err = await asyncio.wait_for(
            exec_collect(box, "sh", ["-c", "set -eu; " + command]), timeout
        )
        with log.open("a") as stream:
            stream.write(f"\n{box.id} $ {command}\nexit={rc}\n{out}\n{err}\n")
        if check:
            assert rc == 0, f"guest exit {rc}; see {log}: {command}"
        return rc, out.strip(), err

    options = boxlite.BoxOptions(
        image=IMAGE,
        cpus=2,
        memory_mib=1536,
        disk_size_gb=4,
        advanced=boxlite.AdvancedBoxOptions(privileged=True),
        entrypoint=["sh", "-c"],
        cmd=["exec tail -f /dev/null"],
        volumes=[{"cache_volume": tag, "guest_path": "/cache"}],
        auto_stop=0,
        auto_delete=0,
    )

    async def create(suffix):
        box = await asyncio.wait_for(runtime.create(options, name=tag + suffix), 180)
        record["boxes"].append(box.id)
        save()
        assert request(f"/box/{box.id}")["runnerId"] == topology["a"]["id"]
        assert request(cache_url)["box_id"] == box.id
        await run(
            box,
            "apk add --no-cache e2fsprogs util-linux; apk info -v; uname -a; cat /proc/mounts",
        )
        script = (ROOT / "apps/infra-local/fixtures/docker-cache.sh").read_text()
        await run(
            box,
            "printf %s "
            + shlex.quote(script)
            + " >/root/cache-entrypoint.sh; chmod 700 /root/cache-entrypoint.sh",
        )
        await run(
            box,
            "nohup /root/cache-entrypoint.sh >/tmp/cache-dockerd.log 2>&1 </dev/null & echo $! >/run/cache-entrypoint.pid",
        )
        deadline = time.monotonic() + 90
        while (await run(box, "docker info", check=False, timeout=10))[0]:
            if time.monotonic() >= deadline:
                await run(
                    box,
                    "cat /tmp/cache-dockerd.log; losetup -a; cat /proc/mounts; dmesg | tail -60",
                    check=False,
                )
                raise TimeoutError(f"cached dockerd not ready; {box.id} retained")
            await asyncio.sleep(0.5)
        await run(
            box,
            "test \"$(docker info --format '{{.Driver}}')\" = overlay2; test \"$(docker info --format '{{.DockerRootDir}}')\" = /var/lib/docker; docker info --format '{{json .}}'; docker version; docker compose version; losetup -a; findmnt -T /var/lib/docker; cat /var/run/docker/containerd/containerd.toml",
        )
        _, mounts, _ = await run(box, "findmnt -n -o FSTYPE -T /var/lib/docker")
        assert mounts == "ext4", mounts
        _, backing, _ = await run(
            box, "losetup -n -O BACK-FILE $(cat /run/boxlite-docker-cache.loop)"
        )
        assert backing == "/cache/docker.ext4", backing
        host_image = (
            Path(topology["a"]["home"])
            / "cache-volumes"
            / tenant
            / tag
            / "data/docker.ext4"
        )
        assert host_image.is_file() and host_image.stat().st_size == 2147483648
        record["host_image"] = str(host_image)
        save()
        return box

    async def remove(box, orderly=True, verify_profile=False):
        if orderly:
            await run(box, "kill -TERM $(cat /run/cache-entrypoint.pid)")
            deadline = time.monotonic() + 45
            while (
                await run(box, "test ! -e /run/boxlite-docker-cache.loop", check=False)
            )[0]:
                if time.monotonic() >= deadline:
                    raise TimeoutError("daemon did not unmount cache; scene retained")
                await asyncio.sleep(0.25)
            await run(
                box, "! pidof dockerd; ! pidof containerd; cat /tmp/cache-dockerd.log"
            )
        if verify_profile:
            _, before, _ = await run(box, "sha256sum /cache/docker.ext4")
            await run(
                box,
                "cp /cache/docker-profile /tmp/saved-profile; printf 'incompatible=true\\n' >>/cache/docker-profile",
            )
            rc, out, err = await run(box, "/root/cache-entrypoint.sh", check=False)
            assert rc != 0 and "profile mismatch" in out + err
            assert (await run(box, "sha256sum /cache/docker.ext4"))[1] == before
            await run(box, "mv /tmp/saved-profile /cache/docker-profile")
            record["profile_mismatch"] = "PASS: refused without changing image bytes"
            save()
        await runtime.remove(box.id, force=True)
        deadline = time.monotonic() + 90
        while request(cache_url)["in_use"]:
            if time.monotonic() >= deadline:
                raise TimeoutError("cache lease remains after native deletion")
            await asyncio.sleep(0.3)

    async def conflict():
        name = tag + "-conflict-" + uuid.uuid4().hex[:6]
        owner = request(cache_url)["box_id"]
        try:
            second = await asyncio.wait_for(runtime.create(options, name=name), 120)
            record["boxes"].append(second.id)
            save()
            await run(second, "true")
        except Exception as error:  # noqa: BLE001 - Assert the exact native error below.
            assert "cache is exclusively owned by another Box" in str(error), str(error)
            assert request(cache_url)["box_id"] == owner
            record.setdefault("conflicts", []).append(str(error))
            save()
            # The API retains failed create rows for diagnosis; remove only this
            # test's rejected request after recording its exact admission error.
            for info in await runtime.list_info():
                if info.name == name:
                    await runtime.remove(info.id, force=True)
        else:
            raise AssertionError("second Box acquired Docker data cache")

    dockerfile = f'FROM {BASE}\nCOPY marker /marker\nRUN chmod 0644 /marker && test -s /marker\nCMD ["cat", "/marker"]\n'

    async def build(box):
        return await run(
            box,
            "mkdir -p /tmp/build; printf %s "
            + shlex.quote(tag)
            + " >/tmp/build/marker; printf %s "
            + shlex.quote(dockerfile)
            + " >/tmp/build/Dockerfile; docker build --pull=false --progress=plain -t cache-proof:local /tmp/build",
        )

    previous = {
        r["id"]: r["unschedulable"]
        for r in request("/admin/runners")
        if r["id"] in [topology[k]["id"] for k in ["a", "b"]]
    }
    try:
        for node in ["a", "b"]:
            request(
                f"/admin/runners/{topology[node]['id']}/scheduling",
                {"unschedulable": node != "a"},
                method="PATCH",
            )
        a = await create("-a")
        await run(a, "docker pull " + BASE)
        await build(a)
        _, image_id, _ = await run(
            a, "docker image inspect --format '{{.Id}}' cache-proof:local"
        )
        assert (await run(a, "docker run --rm --pull=never cache-proof:local"))[
            1
        ] == tag
        record["image_id"] = image_id
        save()
        await conflict()
        await remove(a)
        b = await create("-b")
        assert (
            await run(b, "docker image inspect --format '{{.Id}}' cache-proof:local")
        )[1] == image_id
        assert (await run(b, "docker run --rm --pull=never cache-proof:local"))[
            1
        ] == tag
        _, out, err = await build(b)
        assert (out + err).count("CACHED") >= 2, out + err
        assert (
            await run(b, "docker image inspect --format '{{.Id}}' cache-proof:local")
        )[1] == image_id
        print(
            "V4 PASS: identical image, pull=never content, cached COPY/RUN; ext4 image on runner cache",
            flush=True,
        )
        record["V4"] = "PASS"
        save()
        # Abrupt daemon exit while its Box still owns the image. A second Box
        # must remain refused until native Box removal confirms absence.
        await run(b, "sync; kill -KILL $(pidof dockerd)")
        await conflict()
        await remove(b, orderly=False)
        c = await create("-recovered")
        assert (
            await run(c, "docker image inspect --format '{{.Id}}' cache-proof:local")
        )[1] == image_id
        assert (await run(c, "docker run --rm --pull=never cache-proof:local"))[
            1
        ] == tag
        await remove(c, verify_profile=True)
        record["V5"] = "PASS"
        save()
        request(cache_url, method="DELETE")
        print(
            "V5 PASS: live and crashed daemon conflict refused; checked recovery retains image/content",
            flush=True,
        )
    except BaseException as error:
        record["failure"] = repr(error)
        save()
        print(f"FAILURE scene retained: {path}; {log}", flush=True)
        raise
    finally:
        for runner, disabled in previous.items():
            request(
                f"/admin/runners/{runner}/scheduling",
                {"unschedulable": disabled},
                method="PATCH",
            )


async def diagnose():
    import boxlite

    path = json.loads((STATE / "docker-cache-latest.json").read_text())["record"]
    record = json.loads(Path(path).read_text())
    tenant = request("/v1/me")["path_prefix"]
    runtime = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=API, credential=boxlite.ApiKeyCredential(ADMIN_KEY), path_prefix=tenant
        )
    )
    for box_id in record["boxes"]:
        box = await runtime.get(box_id)
        if box is None:
            continue
        rc, out, err = await asyncio.wait_for(
            exec_collect(
                box,
                "sh",
                [
                    "-c",
                    "docker --version; containerd --version; cat /tmp/cache-dockerd.log; ls -la /cache; cat /cache/docker-profile; ps; losetup -a; df -T /cache; cat /proc/mounts",
                ],
            ),
            30,
        )
        print(f"BOX {box_id} exit={rc}\n{out}\n{err}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--diagnose", action="store_true")
    asyncio.run(diagnose() if parser.parse_args().diagnose else probe())
