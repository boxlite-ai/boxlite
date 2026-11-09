"""Exercise Swarm VIP, DNSRR and ingress on one or two physical BoxLite hosts."""

import asyncio
import json
import re
import secrets
import shlex
import time

from acceptance import BASE, NO_PROXY, Scene, arguments


def http_server(marker, port=80):
    return (
        "mkdir -p /www; printf %s "
        + shlex.quote(marker)
        + f" >/www/index.html; exec httpd -f -p {port} -h /www"
    )


async def kernel(scene, box):
    await scene.run(
        box,
        "ip link add proof-vx type vxlan id 4210 dev eth0 dstport 4789; ip -d link show proof-vx; ip link del proof-vx; ipvsadm -A -t 10.255.254.1:9999 -s rr; ipvsadm -A -u 10.255.254.1:9999 -s rr; ipvsadm -Ln; ipvsadm -Ln | grep 'TCP.*10.255.254.1:9999.*rr'; ipvsadm -Ln | grep 'UDP.*10.255.254.1:9999.*rr'; ipvsadm -D -t 10.255.254.1:9999; ipvsadm -D -u 10.255.254.1:9999; cat /proc/mounts; ip addr",
    )


async def vpn(scene, peer):
    """Establish and record a routed guest-to-guest TCP VPN underlay."""
    key = (
        "-----BEGIN OpenVPN Static key V1-----\n"
        + "\n".join(secrets.token_hex(16) for _ in range(16))
        + "\n-----END OpenVPN Static key V1-----\n"
    )
    for box in range(2):
        await scene.run(
            box,
            "umask 077; printf %s "
            + shlex.quote(key)
            + " >/tmp/swarm.key; mkdir -p /dev/net; test -e /dev/net/tun || mknod /dev/net/tun c 10 200",
            private=True,
        )
    common = " --dev tun0 --secret /tmp/swarm.key --cipher AES-256-CBC --auth SHA256 --tun-mtu 1400 --ping 2 --ping-restart 30 --daemon --log /tmp/vpn.log"
    await scene.run(
        0,
        "openvpn --proto tcp-server --local 0.0.0.0 --port 1194 --ifconfig 10.77.0.1 10.77.0.2"
        + common,
    )
    port = await scene.forward(0, 1194, listen="0.0.0.0")
    await scene.run(
        1,
        f"openvpn --proto tcp-client --remote {shlex.quote(peer)} {port} --ifconfig 10.77.0.2 10.77.0.1"
        + common,
    )
    await scene.ready(0, "ping -c 1 -W 2 10.77.0.2")
    await scene.ready(1, "ping -c 1 -W 2 10.77.0.1")
    for box in range(2):
        await scene.run(
            box, "ip -s addr show tun0; ip route; cat /tmp/vpn.log; openvpn --version"
        )
    scene.record["underlay"] = {
        "kind": "guest OpenVPN over BoxLite TCP tunnel",
        "peer": peer,
        "port": port,
        "mtu": 1400,
    }
    scene.save()


async def services_ready(scene, placements):
    """Wait for each service's single running task on its constrained node."""
    deadline = time.monotonic() + 120
    while True:
        complete = True
        for name, node in placements.items():
            code, ids, _ = await scene.run(
                0,
                f"docker service ps --no-trunc --filter desired-state=running -q {name}",
                check=False,
            )
            if code or not ids:
                complete = False
                continue
            code, raw, _ = await scene.run(
                0, "docker inspect " + " ".join(ids.split()), check=False
            )
            if code:
                complete = False
                continue
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
                "services did not reach their constrained running replicas"
            )
        await asyncio.sleep(0.5)


async def network_evidence(scene, box, network, require_ipvs):
    """Require VXLAN devices and, for VIP services, nonzero IPVS traffic counters."""
    _, raw, _ = await scene.run(box, f"docker network inspect {network}")
    network_id = json.loads(raw)[0]["Id"]
    command = (
        f"nsenter --net=/var/run/docker/netns/1-{network_id[:10]} ip -d link show type vxlan; "
        "for ns in /var/run/docker/netns/lb_*; do echo NETNS=$ns; nsenter --net=$ns ipvsadm -Ln --stats; done"
    )
    deadline = time.monotonic() + 30
    while True:
        _, evidence, _ = await scene.run(
            box, "nsenter -t $(pidof dockerd) -m -- sh -c " + shlex.quote(command)
        )
        assert "vxlan id " in evidence and "dstport 4789" in evidence, evidence
        if not require_ipvs or re.search(r"FWM\s+\d+\s+[1-9]\d*", evidence):
            return
        if time.monotonic() >= deadline:
            raise AssertionError("VIP IPVS counters stayed zero")
        await asyncio.sleep(0.5)


async def overlay(scene, mode):
    """Verify placement, DNS, HTTP, and datapath evidence for an overlay mode."""
    network = "proof-" + mode
    await scene.run(
        0,
        f"docker network create -d overlay --attachable --opt com.docker.network.driver.mtu=1200 {network}",
    )
    names, placements, markers = [], {}, []
    for index, node in enumerate(scene.record["nodes"]):
        backend = (
            "backend"
            if len(scene.boxes) == 1 and mode == "vip"
            else f"backend-{mode}-{index}"
        )
        client = f"client-{mode}-{index}"
        marker = f"{scene.tag}-{mode}-backend-{index}"
        names.append((backend, client))
        markers.append(marker)
        constraint = "--constraint node.id==" + node["swarm_id"]
        endpoint = "" if mode == "vip" else "--endpoint-mode dnsrr"
        await scene.run(
            0,
            f"docker service create --detach --no-resolve-image --name {backend} {constraint} --network {network} {endpoint} {BASE} sh -c "
            + shlex.quote(http_server(marker)),
        )
        await scene.run(
            0,
            f"docker service create --detach --no-resolve-image --name {client} {constraint} --network {network} {BASE} tail -f /dev/null",
        )
        placements[backend] = placements[client] = node["swarm_id"]
    await services_ready(scene, placements)
    for source in range(len(scene.boxes)):
        _, client, _ = await scene.run(
            source,
            "docker ps -q --filter label=com.docker.swarm.service.name="
            + names[source][1],
        )
        assert client and "\n" not in client, client
        await scene.run(source, f"docker exec {client} sh -c " + shlex.quote(NO_PROXY))
        for target in range(len(scene.boxes)):
            if len(scene.boxes) > 1 and source == target:
                continue
            backend = names[target][0]
            _, raw, _ = await scene.run(0, f"docker service inspect {backend}")
            service = json.loads(raw)[0]
            assert service["Spec"]["EndpointSpec"]["Mode"] == mode, service
            assert not service["Spec"]["EndpointSpec"].get("Ports"), service
            _, dns, _ = await scene.run(
                source, f"docker exec {client} nslookup {backend}"
            )
            if mode == "vip":
                vip = service["Endpoint"]["VirtualIPs"][0]["Addr"].split("/")[0]
                assert re.search(rf"(?<![\d.]){re.escape(vip)}(?![\d.])", dns), (
                    vip,
                    dns,
                )
            else:
                _, addresses, _ = await scene.run(
                    target,
                    f"docker inspect --format '{{{{json .NetworkSettings.Networks}}}}' $(docker ps -q --filter label=com.docker.swarm.service.name={backend})",
                )
                task_ip = json.loads(addresses)[network]["IPAddress"]
                assert re.search(rf"(?<![\d.]){re.escape(task_ip)}(?![\d.])", dns), (
                    task_ip,
                    dns,
                )
            _, body, headers = await scene.ready(
                source, f"docker exec {client} wget -T 5 -SO- http://{backend}/"
            )
            assert body == markers[target] and re.search(
                r"HTTP/1\.[01] 200", headers
            ), (body, headers)
            scene.record.setdefault("directed_pairs", []).append(
                {
                    "mode": mode,
                    "source": source,
                    "target": target,
                    "service": backend,
                    "status": 200,
                    "marker": body,
                }
            )
            scene.save()
    for box in range(len(scene.boxes)):
        await network_evidence(scene, box, network, mode == "vip")
    await scene.run(
        0,
        "docker service ls; docker node ls; docker service ps --no-trunc "
        + " ".join(placements),
    )
    await scene.run(0, "docker service rm " + " ".join(placements))


async def published(scene):
    """Verify published-port routing and single-guest host networking."""
    marker = scene.tag + "-published-backend"
    backend_node = scene.record["nodes"][-1]["swarm_id"]
    for mode, port in [("ingress", 18080), ("host", 18081)]:
        name = "published-" + mode
        publish = f"published={port},target=80" + (
            ",mode=host" if mode == "host" else ""
        )
        await scene.run(
            0,
            f"docker service create --detach --no-resolve-image --name {name} --constraint node.id=={backend_node} --publish {publish} {BASE} sh -c "
            + shlex.quote(http_server(marker)),
        )
        await services_ready(scene, {name: backend_node})
        _, raw, _ = await scene.run(0, "docker service inspect " + name)
        assert json.loads(raw)[0]["Endpoint"]["Ports"][0]["PublishMode"] == mode
        if len(scene.boxes) > 1 and mode == "ingress":
            _, tasks, _ = await scene.run(
                0, f"docker ps -q --filter label=com.docker.swarm.service.name={name}"
            )
            assert not tasks, "ingress entry node must have no backend task"
        await scene.outside(
            0 if mode == "ingress" else len(scene.boxes) - 1, port, marker
        )
        await scene.run(0, "docker service ps --no-trunc " + name)
        if mode == "ingress":
            await scene.run(
                0,
                "nsenter -t $(pidof dockerd) -m -- nsenter --net=/var/run/docker/netns/ingress_sbox ipvsadm -Ln --stats",
            )
            scene.passed("D7" if len(scene.boxes) == 1 else "M4")
        elif len(scene.boxes) == 1:
            scene.passed("D8")
        await scene.run(0, "docker service rm " + name)
    if len(scene.boxes) == 1:
        await scene.run(
            0,
            f"docker run -d --name host-proof --network host {BASE} sh -c "
            + shlex.quote(http_server(marker, 18082)),
        )
        _, mode, _ = await scene.run(
            0, "docker inspect --format '{{.HostConfig.NetworkMode}}' host-proof"
        )
        assert mode == "host", mode
        await scene.run(
            0,
            'p=$(docker inspect --format \'{{.State.Pid}}\' host-proof); test "$(readlink /proc/$p/ns/net)" = "$(readlink /proc/self/ns/net)"; readlink /proc/$p/ns/net; readlink /proc/self/ns/net',
        )
        await scene.outside(0, 18082, marker)
        scene.passed("D9")
        await scene.run(0, "docker rm -f host-proof")


async def swarm(args):
    """Run the selected topology, save acceptance evidence, and release its workers."""
    scene = Scene(args, args.topology)
    success = False
    try:
        a = await scene.start(args.runner_a, "runner-a")
        await scene.create(a)
        if args.topology != "single":
            b = (
                a
                if args.topology == "same-runner"
                else await scene.start(args.runner_b, "runner-b")
            )
            if args.topology == "cross-runner":
                assert a.identity["runner"] != b.identity["runner"]
                assert a.identity["machine_id"] != b.identity["machine_id"], (
                    "cross-runner requires different physical hosts"
                )
            else:
                assert a is b, "same-runner must use one runtime worker"
            await scene.create(b)
        for box in range(len(scene.boxes)):
            await scene.prepare(box, swarm=True)
            await kernel(scene, box)
        if len(scene.boxes) > 1:
            await vpn(
                scene,
                "192.168.127.254"
                if args.topology == "same-runner"
                else args.peer_address,
            )
        addresses = (
            ["192.168.127.2"] if len(scene.boxes) == 1 else ["10.77.0.1", "10.77.0.2"]
        )
        init = f"docker swarm init --advertise-addr {addresses[0]} --data-path-addr {addresses[0]}"
        scene.note(f"{scene.boxes[0][1]} $ {init}")
        await scene.run(0, init, private=True)
        if len(scene.boxes) > 1:
            _, token, _ = await scene.run(
                0, "docker swarm join-token -q worker", private=True
            )
            scene.note(
                f"{scene.boxes[1][1]} $ docker swarm join --token <redacted> "
                f"--advertise-addr {addresses[1]} --data-path-addr {addresses[1]} {addresses[0]}:2377"
            )
            await scene.run(
                1,
                f"docker swarm join --token {shlex.quote(token)} --advertise-addr {addresses[1]} --data-path-addr {addresses[1]} {addresses[0]}:2377",
                private=True,
            )
        for box, address in enumerate(addresses):
            _, node, _ = await scene.run(
                box, "docker info --format '{{.Swarm.NodeID}}'"
            )
            scene.record["nodes"][box].update({"swarm_id": node, "address": address})
        scene.save()
        deadline = time.monotonic() + 60
        while True:
            _, raw, _ = await scene.run(0, "docker node inspect $(docker node ls -q)")
            nodes = json.loads(raw)
            if len(nodes) == len(scene.boxes) and all(
                node["Status"]["State"] == "ready"
                and node["Spec"]["Availability"] == "active"
                for node in nodes
            ):
                assert {node["Status"]["Addr"] for node in nodes} == set(addresses), (
                    nodes
                )
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Swarm nodes did not become Ready/Active")
            await asyncio.sleep(0.5)
        scene.passed("D3" if len(scene.boxes) == 1 else "M1", "D10")
        await scene.run(0, "printf 'y\\n' | docker network rm ingress")
        await scene.ready(0, "! docker network inspect ingress")
        await scene.run(
            0,
            "docker network create --driver overlay --ingress --subnet 10.254.0.0/24 --opt com.docker.network.driver.mtu=1200 ingress",
        )
        await overlay(scene, "vip")
        scene.passed("D4", "D5") if len(scene.boxes) == 1 else scene.passed(
            "M2 VIP", "M3 VIP"
        )
        await overlay(scene, "dnsrr")
        scene.passed("D6") if len(scene.boxes) == 1 else scene.passed(
            "M2 DNSRR", "M3 DNSRR"
        )
        await published(scene)
        for box in range(len(scene.boxes)):
            await scene.run(
                box,
                "docker network inspect ingress; ip -s addr; ss -lntup; iptables-save; cat /tmp/dockerd.log",
            )
        if len(scene.boxes) > 1:
            scene.passed("M5 " + args.topology, "M6")
        for box in reversed(range(len(scene.boxes))):
            await scene.run(box, "docker swarm leave --force")
        success = True
    except BaseException as error:
        scene.record["failure"] = repr(error)
        scene.save()
        raise
    finally:
        await scene.finish(success)


if __name__ == "__main__":
    parser = arguments(__doc__)
    parser.add_argument(
        "--topology", choices=["single", "same-runner", "cross-runner"], required=True
    )
    parser.add_argument(
        "--runner-b", help="second physical host SSH destination for cross-runner"
    )
    parser.add_argument(
        "--peer-address", help="runner A address reachable from the guest on runner B"
    )
    args = parser.parse_args()
    if args.topology == "cross-runner" and not (args.runner_b and args.peer_address):
        parser.error("cross-runner requires --runner-b and --peer-address")
    asyncio.run(swarm(args))
