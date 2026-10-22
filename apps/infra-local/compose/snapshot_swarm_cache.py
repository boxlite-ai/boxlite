"""Box lifecycle for the combined E probe; networking assertions stay in Swarm."""

import asyncio
import shlex
import time
from pathlib import Path

from .acceptance import ROOT, request
from .docker_cache_acceptance import BASE, IMAGE


class SnapshotCacheScenario:
    def __init__(self, runtime, topology, tenant, tag, run, ready, record, save):
        self.runtime = runtime
        self.topology = topology
        self.tenant = tenant
        self.tag = tag
        self.run = run
        self.ready = ready
        self.save = save
        self.state = {"snapshots": {}, "boxes": [], "image_ids": {}, "boot_ids": []}
        record["combined"] = self.state

    def select(self, node=None):
        for key in ("a", "b"):
            request(
                f"/admin/runners/{self.topology[key]['id']}/scheduling",
                {"unschedulable": node is not None and key != node},
                method="PATCH",
            )

    def options(self, node=None):
        import boxlite

        return boxlite.BoxOptions(
            image=IMAGE,
            cpus=2,
            memory_mib=1536,
            disk_size_gb=5,
            advanced=boxlite.AdvancedBoxOptions(privileged=True),
            network=boxlite.NetworkSpec(
                inbound=boxlite.InboundNetworkSpec(mode="enabled")
            ),
            entrypoint=["sh", "-c"],
            cmd=["exec tail -f /dev/null"],
            auto_stop=0,
            auto_delete=0,
            volumes=[]
            if node is None
            else [{"cache_volume": self.tag + "-" + node, "guest_path": "/cache"}],
        )

    async def prepare(self):
        self.select("a")
        source = await asyncio.wait_for(
            self.runtime.create(self.options(), name=self.tag + "-source"), 180
        )
        self.state["source"] = source.id
        self.save()
        await self.run(
            source,
            "apk add --no-cache e2fsprogs util-linux; printf %s "
            + shlex.quote(self.tag)
            + " >/root/snapshot-point; chmod 640 /root/snapshot-point; printf changed >/etc/motd; rm /etc/issue; sync",
        )
        script = (ROOT / "apps/infra-local/fixtures/docker-cache.sh").read_text()
        await self.run(
            source,
            "printf %s "
            + shlex.quote(script)
            + " >/root/cache-entrypoint.sh; chmod 700 /root/cache-entrypoint.sh; sync",
        )
        snapshot = await source.snapshot.create(name="combined")
        self.state["snapshots"]["a"] = snapshot.id
        self.save()
        await self.run(source, "printf source-after >/root/snapshot-point; sync")
        await self.runtime.remove(source.id, force=True)
        self.select()
        copied = await asyncio.wait_for(
            self.runtime.snapshot_copy(snapshot.id, self.topology["b"]["id"]), 280
        )
        self.state["snapshots"]["b"] = copied.id
        self.save()

    async def create(self, index, node, reuse=False):
        if not self.state["snapshots"]:
            await self.prepare()
        self.select(node)
        name = f"{self.tag}-{'reuse' if reuse else 'node'}-{index}"
        box = await asyncio.wait_for(
            self.runtime.create_from_snapshot(
                self.state["snapshots"][node], name=name, options=self.options(node)
            ),
            180,
        )
        self.state["boxes"].append({"id": box.id, "node": node, "reuse": reuse})
        self.save()
        assert request(f"/box/{box.id}")["runnerId"] == self.topology[node]["id"]
        assert (
            await self.run(
                box,
                "cat /root/snapshot-point; stat -c %a /root/snapshot-point; cat /etc/motd; test ! -e /etc/issue",
            )
        )[1] == self.tag + "640\nchanged"
        boot = (await self.run(box, "cat /proc/sys/kernel/random/boot_id"))[1]
        assert boot not in self.state["boot_ids"]
        self.state["boot_ids"].append(boot)
        if not reuse:
            await self.run(box, "test ! -e /cache/docker.ext4")
        assert request(self.cache_path(node))["box_id"] == box.id
        self.save()
        return box

    def cache_path(self, node):
        return f"/v1/{self.tenant}/caches/{self.topology[node]['id']}/{self.tag}-{node}"

    async def start(self, box, node):
        await self.run(
            box,
            "nohup /root/cache-entrypoint.sh >/tmp/dockerd.log 2>&1 </dev/null & echo $! >/run/cache-entrypoint.pid",
        )
        await self.ready(box, "docker info")
        await self.run(
            box,
            "test \"$(docker info --format '{{.Driver}}')\" = overlay2; test \"$(docker info --format '{{.DockerRootDir}}')\" = /var/lib/docker; docker info --format '{{json .}}'; docker version; docker compose version; cat /var/run/docker/containerd/containerd.toml; findmnt -T /var/lib/docker; losetup -a",
        )
        assert (await self.run(box, "findmnt -n -o FSTYPE -T /var/lib/docker"))[
            1
        ] == "ext4"
        assert (
            await self.run(
                box, "losetup -n -O BACK-FILE $(cat /run/boxlite-docker-cache.loop)"
            )
        )[1] == "/cache/docker.ext4"
        disk = (
            Path(self.topology[node]["home"])
            / "cache-volumes"
            / self.tenant
            / (self.tag + "-" + node)
            / "data/docker.ext4"
        )
        assert disk.is_file() and disk.stat().st_size == 2147483648

    async def build(self, box, index):
        marker = self.tag + "-" + str(index)
        dockerfile = f'FROM {BASE}\nCOPY marker /marker\nRUN chmod 0644 /marker && test -s /marker\nCMD ["cat", "/marker"]\n'
        return await self.run(
            box,
            "mkdir -p /tmp/build; printf %s "
            + shlex.quote(marker)
            + " >/tmp/build/marker; printf %s "
            + shlex.quote(dockerfile)
            + " >/tmp/build/Dockerfile; docker build --pull=false --progress=plain -t combined-proof:local /tmp/build",
        )

    async def seed(self, box, index):
        await self.build(box, index)
        self.state["image_ids"][str(index)] = (
            await self.run(
                box, "docker image inspect --format '{{.Id}}' combined-proof:local"
            )
        )[1]
        self.save()

    async def retire(self, box, node):
        await self.run(box, "kill -TERM $(cat /run/cache-entrypoint.pid)")
        await self.ready(
            box,
            "test ! -e /run/boxlite-docker-cache.loop; ! pidof dockerd; ! pidof containerd",
            timeout=60,
        )
        await self.runtime.remove(box.id, force=True)
        deadline = time.monotonic() + 90
        while request(self.cache_path(node))["in_use"]:
            if time.monotonic() >= deadline:
                raise TimeoutError("combined cache lease did not release")
            await asyncio.sleep(0.3)

    async def finish(self):
        for index, node in enumerate(("a", "b")):
            box = await self.create(index, node, reuse=True)
            await self.run(box, "apk fix --no-cache iptables iptables-legacy")
            await self.start(box, node)
            image_id = (
                await self.run(
                    box, "docker image inspect --format '{{.Id}}' combined-proof:local"
                )
            )[1]
            assert image_id == self.state["image_ids"][str(index)]
            assert (
                await self.run(box, "docker run --rm --pull=never combined-proof:local")
            )[1] == self.tag + "-" + str(index)
            _, out, err = await self.build(box, index)
            assert (out + err).count("CACHED") >= 2, out + err
            assert (
                await self.run(
                    box, "docker image inspect --format '{{.Id}}' combined-proof:local"
                )
            )[1] == image_id
            assert (
                await self.run(box, "docker info --format '{{.Swarm.LocalNodeState}}'")
            )[1] == "inactive"
            await self.retire(box, node)
            request(self.cache_path(node), method="DELETE")
            self.state.setdefault("reuse", {})[node] = "PASS"
            self.save()
        for snapshot in self.state["snapshots"].values():
            await self.runtime.snapshot_remove(snapshot)
        self.state["status"] = "PASS"
        self.save()
