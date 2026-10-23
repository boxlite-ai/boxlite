"""Real D3–D10 / M1–M6, preserving guest/network evidence on failure."""

import argparse
import asyncio
import json
import re
import secrets
import shlex
import socket
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .acceptance import ADMIN_KEY, API, STATE, download_env, request, two_runners
from .orchestrator import exec_collect
from .provision import create_ready

IMAGE = "docker:27.5.1-dind@sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce"
BASE = "busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"


async def probe(topology_name, combined=False):
    import boxlite

    topology = two_runners()
    tenant = request("/v1/me")["path_prefix"]
    runtime = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=API, credential=boxlite.ApiKeyCredential(ADMIN_KEY), path_prefix=tenant
        )
    )
    tag = "swarm-" + topology_name + "-" + uuid.uuid4().hex[:8]
    if combined:
        assert topology_name == "different-runners", "combined E requires two runners"
        tag = "combined-" + tag
    record = {"tag": tag, "topology": topology, "nodes": [], "results": {}}
    path = STATE / f"{tag}.json"
    log = STATE / f"{tag}-guest.log"
    boxes, forwards = [], []
    (STATE / "swarm-latest.json").write_text(json.dumps({"record": str(path)}))

    def save():
        path.write_text(json.dumps(record, indent=2))

    def passed(*ids):
        for item in ids:
            record["results"][item] = "PASS"
            print(f"{topology_name} {item} PASS", flush=True)
        save()

    async def run(box, command, check=True, timeout=120, private=False):
        with log.open("a") as stream:
            stream.write(f"\n{box.id} $ {'[private setup]' if private else command}\n")
        rc, out, err = await asyncio.wait_for(
            exec_collect(box, "sh", ["-c", "set -eu; " + command]), timeout
        )
        with log.open("a") as stream:
            stream.write(f"exit={rc}\n")
            if not private:
                stream.write(out + "\n" + err + "\n")
        if check:
            assert rc == 0, (
                f"guest exit {rc}: {command if not private else '[private setup]'}; see {log}"
            )
        return rc, out.strip(), err

    async def ready(box, command, timeout=90):
        deadline = time.monotonic() + timeout
        while True:
            result = await run(box, command, check=False, timeout=15)
            if result[0] == 0:
                return result
            if time.monotonic() >= deadline:
                raise TimeoutError(f"guest readiness: {command}")
            await asyncio.sleep(0.5)

    scenario = None
    if combined:
        from .snapshot_swarm_cache import SnapshotCacheScenario

        scenario = SnapshotCacheScenario(
            runtime, topology, tenant, tag, run, ready, record, save
        )

    async def create(index, runner):
        for key in ["a", "b"]:
            request(
                f"/admin/runners/{topology[key]['id']}/scheduling",
                {"unschedulable": key != runner},
                method="PATCH",
            )
        box = await asyncio.wait_for(
            create_ready(
                runtime,
                boxlite.BoxOptions(
                    image=IMAGE,
                    cpus=2,
                    memory_mib=1536,
                    disk_size_gb=5,
                    advanced=boxlite.AdvancedBoxOptions(privileged=True),
                    env=download_env(),
                    network=boxlite.NetworkSpec(
                        inbound=boxlite.InboundNetworkSpec(mode="enabled")
                    ),
                    entrypoint=["sh", "-c"],
                    cmd=["exec tail -f /dev/null"],
                    auto_stop=0,
                    auto_delete=0,
                ),
                name=f"{tag}-{index}",
            )
            if scenario is None
            else scenario.create(index, runner),
            300 if scenario else 180,
        )
        boxes.append(box)
        owner = request(f"/box/{box.id}")["runnerId"]
        assert owner == topology[runner]["id"]
        record["nodes"].append({"box": box.id, "runner": owner})
        save()
        await run(
            box,
            "apk add --no-cache iproute2=6.11.0-r0 ipvsadm=1.31-r3 openvpn=2.6.20-r0; apk fix --no-cache iptables iptables-legacy; test -f /usr/lib/xtables/libxt_MARK.so; test -f /usr/lib/xtables/libxt_mark.so; apk info -v; uname -a; docker --version; docker compose version",
        )
        if scenario:
            await scenario.start(box, runner)
        else:
            await run(
                box,
                "nohup dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 --dns-search=. >/tmp/dockerd.log 2>&1 </dev/null &",
            )
        await ready(box, "docker info")
        await run(box, "docker pull " + BASE)
        if scenario:
            await scenario.seed(box, index)
        await run(
            box,
            "ip link add proof-vx type vxlan id 4210 dev eth0 dstport 4789; ip -d link show proof-vx; ip link del proof-vx; ipvsadm -A -t 10.255.254.1:9999 -s rr; ipvsadm -Ln; ipvsadm -D -t 10.255.254.1:9999; cat /proc/mounts; ip addr",
        )
        return box

    async def forward(box, port):
        tunnel = await asyncio.wait_for(box.network.tunnel(port), 20)
        with log.open("a") as stream:
            stream.write(f"SDK TUNNEL {box.id}:{port} URI={tunnel.uri()}\n")
        handle = await asyncio.wait_for(
            tunnel.forward(boxlite.SocketAddress.tcp("127.0.0.1", 0)), 20
        )
        forwards.append(handle)
        address = handle.local_addr()
        return address.port

    async def outside(box, port, marker):
        local_port = await forward(box, port)

        def fetch():
            with urllib.request.urlopen(
                f"http://127.0.0.1:{local_port}/", timeout=5
            ) as response:
                return response.status, response.read().decode()

        deadline = time.monotonic() + 60
        while True:
            try:
                status, body = await asyncio.to_thread(fetch)
                assert status == 200 and body.strip() == marker, (status, body)
                with log.open("a") as stream:
                    stream.write(
                        f"OUTSIDE SDK tunnel {box.id}:{port} -> HTTP {status} {body}\n"
                    )
                return
            except (OSError, AssertionError):
                if time.monotonic() >= deadline:
                    raise
                await asyncio.sleep(0.5)

    async def vpn(a, b):
        # Key stays in guest/local private scene; never include it in the log.
        key = (
            "-----BEGIN OpenVPN Static key V1-----\n"
            + "\n".join(secrets.token_hex(16) for _ in range(16))
            + "\n-----END OpenVPN Static key V1-----\n"
        )
        for box in [a, b]:
            await run(
                box,
                "umask 077; printf %s "
                + shlex.quote(key)
                + " >/tmp/swarm.key; mkdir -p /dev/net; test -e /dev/net/tun || mknod /dev/net/tun c 10 200",
                private=True,
            )
        common = " --dev tun0 --secret /tmp/swarm.key --cipher AES-256-CBC --auth SHA256 --tun-mtu 1400 --ping 2 --ping-restart 30 --daemon --log /tmp/vpn.log"
        await run(
            a,
            "openvpn --proto tcp-server --local 0.0.0.0 --port 1194 --ifconfig 10.77.0.1 10.77.0.2"
            + common,
        )
        port = await forward(a, 1194)
        await run(
            b,
            f"openvpn --proto tcp-client --remote 192.168.127.254 {port} --ifconfig 10.77.0.2 10.77.0.1"
            + common,
        )
        await ready(a, "ping -c 1 -W 2 10.77.0.2")
        await ready(b, "ping -c 1 -W 2 10.77.0.1")
        for box in [a, b]:
            await run(
                box,
                "ip -s addr show tun0; ip route; cat /tmp/vpn.log; openvpn --version",
            )
        record["vpn"] = {
            "kind": "guest OpenVPN IP over SDK TCP tunnel",
            "mtu": 1400,
            "forwarder_required": True,
        }
        save()

    async def services_ready(manager, names, expected_nodes):
        deadline = time.monotonic() + 120
        while True:
            complete = True
            for name, node in zip(names, expected_nodes):
                _, ids, _ = await run(
                    manager,
                    f"docker service ps --no-trunc --filter desired-state=running -q {name}",
                )
                if not ids:
                    complete = False
                    continue
                _, raw, _ = await run(
                    manager, "docker inspect " + " ".join(ids.split())
                )
                tasks = json.loads(raw)
                complete = (
                    complete
                    and len(tasks) == 1
                    and tasks[0]["Status"]["State"] == "running"
                    and tasks[0]["NodeID"] == node
                )
            if complete:
                return
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    "services did not reach constrained running replicas"
                )
            await asyncio.sleep(0.5)

    async def overlay(manager, mode):
        network = "proof-" + mode
        await run(
            manager,
            f"docker network create -d overlay --attachable --opt com.docker.network.driver.mtu=1200 {network}",
        )
        names, placements = [], []
        for index, node in enumerate(record["nodes"]):
            constraint = "--constraint node.id==" + node["swarm_id"]
            marker = f"{tag}-{mode}-backend-{index}"
            cmd = (
                "mkdir -p /www; printf %s "
                + shlex.quote(marker)
                + " >/www/index.html; exec httpd -f -p 80 -h /www"
            )
            backend, client = f"backend-{mode}-{index}", f"client-{mode}-{index}"
            endpoint = "" if mode == "vip" else "--endpoint-mode dnsrr"
            await run(
                manager,
                f"docker service create --detach --no-resolve-image --name {backend} {constraint} --network {network} {endpoint} {BASE} sh -c "
                + shlex.quote(cmd),
            )
            await run(
                manager,
                f"docker service create --detach --no-resolve-image --name {client} {constraint} --network {network} {BASE} tail -f /dev/null",
            )
            names.extend([backend, client])
            placements.extend([node["swarm_id"], node["swarm_id"]])
        await services_ready(manager, names, placements)
        for source, box in enumerate(boxes):
            _, client_id, _ = await run(
                box,
                f"docker ps -q --filter label=com.docker.swarm.service.name=client-{mode}-{source}",
            )
            assert client_id and "\n" not in client_id
            await run(
                box,
                f"docker exec {client_id} sh -c "
                + shlex.quote(
                    'test -z "${http_proxy:-}${https_proxy:-}${HTTP_PROXY:-}${HTTPS_PROXY:-}"'
                ),
            )
            for target in range(len(boxes)):
                if len(boxes) > 1 and target == source:
                    continue
                backend = f"backend-{mode}-{target}"
                _, raw, _ = await run(manager, f"docker service inspect {backend}")
                service = json.loads(raw)[0]
                assert service["Spec"]["EndpointSpec"]["Mode"] == mode
                _, dns, _ = await run(
                    box, f"docker exec {client_id} nslookup {backend}"
                )
                if mode == "vip":
                    vip = service["Endpoint"]["VirtualIPs"][0]["Addr"].split("/")[0]
                    assert vip in dns, (vip, dns)
                else:
                    _, addresses, _ = await run(
                        boxes[target],
                        f"docker inspect --format '{{{{json .NetworkSettings.Networks}}}}' $(docker ps -q --filter label=com.docker.swarm.service.name={backend})",
                    )
                    task_ip = json.loads(addresses)[network]["IPAddress"]
                    assert task_ip in dns, (task_ip, dns)
                marker = f"{tag}-{mode}-backend-{target}"
                _, body, headers = await ready(
                    box, f"docker exec {client_id} wget -T 5 -SO- http://{backend}/"
                )
                assert body == marker and re.search(r"HTTP/1\.[01] 200", headers), (
                    body,
                    headers,
                )
                record.setdefault("directed_pairs", []).append(
                    {"mode": mode, "from": source, "to": target, "marker": body}
                )
                save()
        for box in boxes:
            _, raw, _ = await run(box, f"docker network inspect {network}")
            network_id = json.loads(raw)[0]["Id"]
            # A removed ingress leaves a stale namespace placeholder. Inspect
            # the live network by ID, rather than treating every old file as live.
            command = f"set -eu; nsenter --net=/var/run/docker/netns/1-{network_id[:10]} ip -d link show type vxlan; for ns in /var/run/docker/netns/lb_*; do echo NETNS=$ns; nsenter --net=$ns ipvsadm -Ln --stats; done"
            deadline = time.monotonic() + 30
            while True:
                _, evidence, _ = await run(
                    box,
                    "nsenter -t $(pidof dockerd) -m -- sh -c " + shlex.quote(command),
                )
                assert "vxlan id " in evidence and "dstport 4789" in evidence, evidence
                if mode != "vip" or re.search(r"FWM\s+\d+\s+[1-9]\d*", evidence):
                    break
                if time.monotonic() >= deadline:
                    raise AssertionError("VIP IPVS counters stayed zero: " + evidence)
                await asyncio.sleep(0.5)
        await run(
            manager,
            "docker service ls; docker node ls; docker service rm " + " ".join(names),
        )
        return network

    previous = {
        r["id"]: r["unschedulable"]
        for r in request("/admin/runners")
        if r["id"] in [topology[k]["id"] for k in ["a", "b"]]
    }
    try:
        a = await create(0, "a")
        if topology_name != "single":
            b = await create(1, "a" if topology_name == "same-runner" else "b")
            await vpn(a, b)
        addresses = ["192.168.127.2"] if len(boxes) == 1 else ["10.77.0.1", "10.77.0.2"]
        await run(
            a,
            f"docker swarm init --advertise-addr {addresses[0]} --data-path-addr {addresses[0]}",
        )
        if len(boxes) > 1:
            _, token, _ = await run(
                a, "docker swarm join-token -q worker", private=True
            )
            await run(
                b,
                f"docker swarm join --token {shlex.quote(token)} --advertise-addr {addresses[1]} --data-path-addr {addresses[1]} {addresses[0]}:2377",
                private=True,
            )
        for index, box in enumerate(boxes):
            _, node, _ = await run(box, "docker info --format '{{.Swarm.NodeID}}'")
            record["nodes"][index].update(
                {"swarm_id": node, "address": addresses[index]}
            )
        save()
        deadline = time.monotonic() + 60
        while True:
            _, raw, _ = await run(a, "docker node inspect $(docker node ls -q)")
            nodes = json.loads(raw)
            if len(nodes) == len(boxes) and all(
                n["Status"]["State"] == "ready"
                and n["Spec"]["Availability"] == "active"
                for n in nodes
            ):
                break
            if time.monotonic() > deadline:
                raise TimeoutError("Swarm nodes not Ready/Active")
            await asyncio.sleep(0.5)
        # VXLAN adds headers inside the VPN. Configure ingress before any service.
        passed("D3" if len(boxes) == 1 else "M1", "D10")
        await run(
            a,
            "printf 'y\\n' | docker network rm ingress",
        )
        await ready(a, "! docker network inspect ingress")
        await run(
            a,
            "docker network create --driver overlay --ingress --subnet 10.254.0.0/24 --opt com.docker.network.driver.mtu=1200 ingress",
        )
        await overlay(a, "vip")
        passed("D4", "D5") if len(boxes) == 1 else passed("M2 VIP", "M3 VIP")
        await overlay(a, "dnsrr")
        passed("D6") if len(boxes) == 1 else passed("M2 DNSRR", "M3 DNSRR")
        marker = tag + "-published-backend"
        backend_node = record["nodes"][-1]["swarm_id"]
        command = (
            "mkdir -p /www; printf %s "
            + shlex.quote(marker)
            + " >/www/index.html; exec httpd -f -p 80 -h /www"
        )
        for mode, port in [("ingress", 18080), ("host", 18081)]:
            name = "published-" + mode
            publish = f"published={port},target=80" + (
                ",mode=host" if mode == "host" else ""
            )
            await run(
                a,
                f"docker service create --detach --no-resolve-image --name {name} --constraint node.id=={backend_node} --publish {publish} {BASE} sh -c "
                + shlex.quote(command),
            )
            await services_ready(a, [name], [backend_node])
            _, raw, _ = await run(a, "docker service inspect " + name)
            assert json.loads(raw)[0]["Endpoint"]["Ports"][0]["PublishMode"] == mode
            await outside(a if mode == "ingress" else boxes[-1], port, marker)
            await run(a, "docker service ps --no-trunc " + name)
            await run(a, "docker service rm " + name)
            if mode == "ingress":
                passed("D7" if len(boxes) == 1 else "M4")
            elif len(boxes) == 1:
                passed("D8")
        if len(boxes) == 1:
            host_command = command.replace("-p 80 ", "-p 18082 ")
            await run(
                a,
                f"docker run -d --name host-proof --network host {BASE} sh -c "
                + shlex.quote(host_command),
            )
            _, mode, _ = await run(
                a, "docker inspect --format '{{.HostConfig.NetworkMode}}' host-proof"
            )
            assert mode == "host"
            await run(
                a,
                "p=$(docker inspect --format '{{.State.Pid}}' host-proof); "
                'test "$(readlink /proc/$p/ns/net)" = "$(readlink /proc/self/ns/net)"; '
                "readlink /proc/$p/ns/net; readlink /proc/self/ns/net",
            )
            await outside(a, 18082, marker)
            await run(a, "docker rm -f host-proof")
            passed("D9")
        for box in boxes:
            await run(
                box,
                "docker node ls || true; docker network inspect ingress; ip -s addr; "
                "ss -lntup; iptables-save; cat /tmp/dockerd.log",
            )
        if len(boxes) > 1:
            passed("M6")
        for handle in forwards:
            await handle.close()
        forwards.clear()
        for index in reversed(range(len(boxes))):
            box = boxes[index]
            await run(box, "docker swarm leave --force")
            if scenario:
                await scenario.retire(box, "a" if index == 0 else "b")
            else:
                await runtime.remove(box.id, force=True)
        if scenario:
            await scenario.finish()
            passed("E")
        record["complete"] = True
        save()
        print(f"Evidence {path}; {log}", flush=True)
    except BaseException as error:
        record["failure"] = repr(error)
        save()
        for box in boxes:
            try:
                await run(
                    box,
                    "cat /tmp/dockerd.log; cat /tmp/vpn.log 2>/dev/null || true; ip addr; ip route; docker info; docker service ls; docker service ps --no-trunc $(docker service ls -q); docker network ls; dmesg | tail -80",
                    check=False,
                )
            except Exception as diagnostic:  # noqa: BLE001 - Preserve the original failure.
                with log.open("a") as stream:
                    stream.write(f"diagnostic error: {diagnostic!r}\n")
        print(f"FAILURE: guests retained; {path}; {log}", flush=True)
        raise
    finally:
        for handle in forwards:
            await handle.close()
        for runner, disabled in previous.items():
            request(
                f"/admin/runners/{runner}/scheduling",
                {"unschedulable": disabled},
                method="PATCH",
            )


async def diagnose(transport=False):
    import boxlite

    record = json.loads(
        Path(
            json.loads((STATE / "swarm-latest.json").read_text())["record"]
        ).read_text()
    )
    runtime = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=API,
            credential=boxlite.ApiKeyCredential(ADMIN_KEY),
            path_prefix=request("/v1/me")["path_prefix"],
        )
    )
    for node in record["nodes"]:
        box = await runtime.get(node["box"])
        if transport:
            command = "wget -T 5 -SO- http://127.0.0.1:18080/; wget -T 5 -SO- http://192.168.127.2:18080/; ss -lntup; iptables-save; nsenter -t $(pidof dockerd) -m -- nsenter --net=/var/run/docker/netns/ingress_sbox ipvsadm -Ln --stats"
            rc, out, err = await asyncio.wait_for(
                exec_collect(box, "sh", ["-c", command]), 30
            )
            print(
                f"BOX {box.id} transport diagnosis exit={rc}\n{out}\n{err}", flush=True
            )
            tunnel = await asyncio.wait_for(box.network.tunnel(18080), 20)
            print(f"TUNNEL URI {tunnel.uri()}", flush=True)
            host = urllib.parse.urlparse(tunnel.uri()).hostname
            try:
                print(f"DNS {host}: {socket.getaddrinfo(host, None)}", flush=True)
                await asyncio.wait_for(tunnel.connect(), 20)
                print("CONNECT accepted", flush=True)
            except Exception as error:  # noqa: BLE001 - Diagnostic records transport errors.
                print(f"CONNECT/DNS error: {error!r}", flush=True)
            continue
        command = 'cat /usr/local/bin/dockerd-entrypoint.sh; command -v iptables; iptables --version; ls /usr/lib/xtables/*MARK*; iptables -t mangle -A INPUT -d 10.255.254.2 -j MARK --set-mark 256; /usr/local/bin/.iptables-legacy/iptables -t mangle -A INPUT -d 10.255.254.2 -j MARK --set-mark 256; cat /etc/resolv.conf; docker service inspect backend-vip-0; docker ps; c=$(docker ps -q --filter label=com.docker.swarm.service.name=client-vip-0); test -n "$c" || exit 0; docker exec $c cat /etc/resolv.conf; docker exec $c nslookup backend-vip-0; docker exec $c nslookup backend-vip-0. 127.0.0.11; docker exec $c wget -T 5 -SO- http://backend-vip-0/; for ns in /var/run/docker/netns/*; do echo NETNS=$ns; nsenter --net=$ns ipvsadm -Ln --stats; done'
        command += "; d=$(pidof dockerd); readlink /proc/$d/ns/mnt /proc/self/ns/mnt; nsenter -t $d -m -- sh -c 'for ns in /var/run/docker/netns/*; do echo DAEMON_NETNS=$ns; nsenter --net=$ns ip -d link show type vxlan; nsenter --net=$ns ipvsadm -Ln --stats; done'"
        rc, out, err = await asyncio.wait_for(
            exec_collect(box, "sh", ["-c", command]), 60
        )
        print(f"BOX {box.id} exit={rc}\n{out}\n{err}", flush=True)


async def preserve_stop():
    """Release VM resources after diagnosis; retain disks, snapshots and cache leases."""
    import shutil

    import boxlite

    path = Path(json.loads((STATE / "swarm-latest.json").read_text())["record"])
    record = json.loads(path.read_text())
    scene = STATE / (record["tag"] + "-preserved")
    scene.mkdir(exist_ok=True)
    shutil.copy2(path, scene / path.name)
    shutil.copy2(path.with_name(record["tag"] + "-guest.log"), scene / "guest.log")
    runtime = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=API,
            credential=boxlite.ApiKeyCredential(ADMIN_KEY),
            path_prefix=request("/v1/me")["path_prefix"],
        )
    )
    for node in record["nodes"]:
        box = await runtime.get(node["box"])
        await box.stop()
        async with asyncio.timeout(90):
            while (await box.info()).state.status != "stopped":
                await asyncio.sleep(0.3)
    record["preserved_stopped"] = True
    path.write_text(json.dumps(record, indent=2))
    print(
        f"STOPPED; disks/snapshots/caches retained under recorded runtime homes; {scene}",
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--topology",
        choices=["single", "same-runner", "different-runners"],
        default="single",
    )
    parser.add_argument("--diagnose", action="store_true")
    parser.add_argument("--diagnose-transport", action="store_true")
    parser.add_argument("--combined", action="store_true")
    parser.add_argument("--preserve-stop", action="store_true")
    args = parser.parse_args()
    asyncio.run(
        preserve_stop()
        if args.preserve_stop
        else diagnose(args.diagnose_transport)
        if args.diagnose or args.diagnose_transport
        else probe(args.topology, args.combined)
    )
