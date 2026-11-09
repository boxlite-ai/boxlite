"""Real DinD and Compose acceptance using persistent native SDK workers."""

import argparse
import asyncio
import json
import re
import shlex
import sys
import time
import uuid
from pathlib import Path, PurePosixPath

IMAGE = "docker:27.5.1-dind@sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce"
BASE = "busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"
NO_PROXY = 'test -z "${http_proxy:-}${https_proxy:-}${HTTP_PROXY:-}${HTTPS_PROXY:-}"'


class RemoteWorker:
    def __init__(self, process, stderr, identity):
        self.process, self.stderr, self.identity = process, stderr, identity
        self.sequence = 0
        self.lock = asyncio.Lock()

    @classmethod
    async def start(cls, target, args, tag, name, output):
        root = PurePosixPath(args.root)
        if not root.is_absolute():
            raise ValueError("--root must be an absolute runner path")
        state_root = (
            PurePosixPath(args.state_root)
            if args.state_root
            else root / ".docker-acceptance"
        )
        local = target == "local"
        command = ["env"]
        if args.runtime_dir:
            command.append("BOXLITE_RUNTIME_DIR=" + args.runtime_dir)
        command += [
            args.python
            or (sys.executable if local else str(root / ".venv/bin/python")),
            "-u",
            str(root / "tests/docker/worker.py"),
            "--home",
            str(state_root / tag / name),
        ]
        if not local:
            ssh = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
            if args.known_hosts:
                ssh += ["-o", "UserKnownHostsFile=" + str(args.known_hosts.resolve())]
            command = [
                *ssh,
                target,
                shlex.join(["systemd-run", "--user", "--scope", "--quiet", *command]),
            ]
        stderr = (output / f"{name}-{'worker' if local else 'ssh'}.log").open("wb")
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
            limit=16 * 1024 * 1024,
        )
        worker = cls(process, stderr, {})
        try:
            worker.identity = await worker.call("identity")
        except BaseException:
            await worker.close()
            raise
        return worker

    async def call(self, operation, **values):
        async with self.lock:
            self.sequence += 1
            request = {"id": self.sequence, "operation": operation, **values}
            self.process.stdin.write((json.dumps(request) + "\n").encode())
            await self.process.stdin.drain()
            line = await asyncio.wait_for(
                self.process.stdout.readline(), values.get("timeout", 120) + 30
            )
            if not line:
                raise RuntimeError(f"worker exited; inspect {self.stderr.name}")
            response = json.loads(line)
            assert response["id"] == self.sequence, response
            if "error" in response:
                raise RuntimeError(response["error"])
            return response["result"]

    async def close(self):
        if self.process.returncode is None:
            try:
                await self.call("close", timeout=15)
            except (  # noqa: UP041 - asyncio.TimeoutError is distinct on Python 3.10.
                RuntimeError,
                BrokenPipeError,
                ConnectionError,
                asyncio.TimeoutError,
            ):
                pass
            finally:
                self.process.stdin.close()
                try:
                    await asyncio.wait_for(self.process.wait(), 20)
                except asyncio.TimeoutError:  # noqa: UP041 - Support Python 3.10.
                    self.process.terminate()
                    await self.process.wait()
        self.stderr.close()


class Scene:
    def __init__(self, args, topology):
        self.args = args
        self.tag = f"docker-{topology}-{uuid.uuid4().hex[:10]}"
        self.output = args.output.resolve() / self.tag
        self.output.mkdir(parents=True)
        self.log = self.output / "guest.log"
        self.workers = []
        self.boxes = []
        self.record = {
            "tag": self.tag,
            "topology": topology,
            "nodes": [],
            "results": {},
            "logs": str(self.output),
        }
        self.save()

    def save(self):
        (self.output / "result.json").write_text(json.dumps(self.record, indent=2))

    def note(self, message):
        with self.log.open("a") as stream:
            stream.write(message + "\n")

    def passed(self, *items):
        for item in items:
            self.record["results"][item] = {"status": "PASS", "log": str(self.log)}
            print(f"{self.record['topology']} {item} PASS", flush=True)
        self.save()

    async def start(self, target, name):
        worker = await RemoteWorker.start(
            target, self.args, self.tag, name, self.output
        )
        self.workers.append(worker)
        self.note("WORKER " + json.dumps(worker.identity))
        return worker

    async def create(self, worker):
        node = await worker.call(
            "create",
            name=f"{self.tag}-{len(self.boxes)}",
            image=IMAGE,
            download_proxy=self.args.download_proxy,
            timeout=600,
        )
        self.boxes.append((worker, node["box"]))
        self.record["nodes"].append(node)
        self.save()
        return len(self.boxes) - 1

    async def run(self, index, command, check=True, timeout=120, private=False):
        worker, box = self.boxes[index]
        self.note(f"\n{box} $ {'[private setup]' if private else command}")
        result = await worker.call(
            "exec", box=box, command=command, timeout=timeout, private=private
        )
        self.note(f"exit={result['code']}")
        if not private:
            self.note(result["stdout"] + "\n" + result["stderr"])
        if check:
            assert result["code"] == 0, f"guest exit {result['code']}; see {self.log}"
        return result["code"], result["stdout"].strip(), result["stderr"]

    async def ready(self, index, command, timeout=90):
        deadline = time.monotonic() + timeout
        while True:
            result = await self.run(index, command, check=False, timeout=15)
            if result[0] == 0:
                return result
            if time.monotonic() >= deadline:
                raise TimeoutError(f"guest readiness: {command}; see {self.log}")
            await asyncio.sleep(0.5)

    async def prepare(self, index, swarm=False):
        worker, _ = self.boxes[index]
        if worker.identity["host_os"] == "Darwin":
            _, output, _ = await self.run(
                index, "uname -r; uname -m; zcat /proc/config.gz"
            )
            release, architecture, *config = output.splitlines()
            assert "6.12.87-boxlite-dind" in release, release
            assert architecture == "aarch64", architecture
            fragment = (
                Path(__file__).resolve().parents[2] / "scripts/build/dind-kernel.config"
            )
            required = {
                "CONFIG_" + line.strip() + "=y"
                for line in fragment.read_text().splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            }
            missing = required - set(config)
            assert not missing, (
                f"Running kernel lacks built-in options: {sorted(missing)}"
            )
        if swarm:
            await self.run(
                index,
                "apk add --no-cache iproute2 ipvsadm openvpn; apk fix --no-cache iptables iptables-legacy; test -f /usr/lib/xtables/libxt_MARK.so; test -f /usr/lib/xtables/libxt_mark.so; apk info -v",
                timeout=180,
            )
        await self.run(
            index,
            "nohup dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 --dns-search=. >/tmp/dockerd.log 2>&1 </dev/null &",
        )
        await self.ready(index, "docker info", timeout=120)
        await self.run(
            index,
            'uname -a; docker version; docker compose version; docker info --format \'{{json .}}\'; test -S /var/run/docker.sock; test -z "${DOCKER_HOST:-}"; test "$(docker version --format \'{{.Server.Version}}\')" = 27.5.1; test "$(docker info --format \'{{.Driver}}\')" = overlay2; test "$(docker info --format \'{{.DockerRootDir}}\')" = /var/lib/docker; test "$(basename "$(readlink /proc/$(pidof dockerd)/exe)")" = dockerd; ! grep -q \' /var/run/docker.sock \' /proc/mounts',
        )
        await self.run(
            index, "docker pull " + BASE + "; docker image inspect " + BASE, timeout=180
        )

    async def forward(self, index, port, listen="127.0.0.1"):
        worker, box = self.boxes[index]
        address = await worker.call("forward", box=box, port=port, listen=listen)
        self.note(f"SDK FORWARD {box}:127.0.0.1:{port} -> {json.dumps(address)}")
        return address["port"]

    async def outside(self, index, port, marker):
        worker, _ = self.boxes[index]
        local_port = await self.forward(index, port)
        deadline = time.monotonic() + 60
        while True:
            try:
                result = await worker.call("http", port=local_port, timeout=10)
                self.note("HOST HTTP " + json.dumps(result))
                assert result["status"] == 200 and result["body"].strip() == marker, (
                    result
                )
                return
            except (RuntimeError, AssertionError):
                if time.monotonic() >= deadline:
                    raise
                await asyncio.sleep(0.5)

    async def finish(self, success):
        if not success:
            for index in range(len(self.boxes)):
                try:
                    await self.run(
                        index,
                        "cat /tmp/dockerd.log; cat /tmp/vpn.log 2>/dev/null || true; ip addr; ip route; docker info; docker ps; docker network ls; docker service ls; docker service ps --no-trunc $(docker service ls -q); dmesg | tail -80",
                        check=False,
                        timeout=30,
                    )
                except Exception as error:  # noqa: BLE001 - Preserve the acceptance failure.
                    self.note(f"diagnostic error: {error!r}")
        try:
            if success:
                for worker, box in reversed(self.boxes):
                    await worker.call("remove", box=box, timeout=120)
                self.record["complete"] = True
                self.save()
        finally:
            await asyncio.gather(*(worker.close() for worker in reversed(self.workers)))
            print(f"Evidence: {self.output}", flush=True)


def arguments(description):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--runner-a",
        required=True,
        help="SSH destination or 'local' for the first native SDK worker",
    )
    parser.add_argument(
        "--root", required=True, help="absolute source root on each runner"
    )
    parser.add_argument(
        "--python",
        help="worker Python with the built SDK; default: current Python for local, ROOT/.venv/bin/python for SSH",
    )
    parser.add_argument(
        "--state-root",
        help="runner runtime state directory; default: ROOT/.docker-acceptance",
    )
    parser.add_argument(
        "--runtime-dir", help="runner BOXLITE_RUNTIME_DIR for the built runtime"
    )
    parser.add_argument(
        "--output", type=Path, required=True, help="local private evidence directory"
    )
    parser.add_argument(
        "--known-hosts",
        type=Path,
        help="SSH known-hosts file; default: OpenSSH configuration",
    )
    parser.add_argument(
        "--download-proxy",
        help="optional proxy reachable from guests, for downloads only",
    )
    return parser


async def dind(args):
    scene = Scene(args, "dind")
    success = False
    try:
        worker = await scene.start(args.runner_a, "runner-a")
        box = await scene.create(worker)
        await scene.prepare(box)
        marker = scene.tag + "-built-image"
        dockerfile = f'FROM {BASE}\nCOPY marker /srv/index.html\nRUN test -s /srv/index.html && chmod 0644 /srv/index.html\nCMD ["cat", "/srv/index.html"]\n'
        await scene.run(
            box,
            "mkdir -p /tmp/dind-build; printf %s "
            + shlex.quote(marker)
            + " >/tmp/dind-build/marker; printf %s "
            + shlex.quote(dockerfile)
            + " >/tmp/dind-build/Dockerfile; docker build --progress=plain -t acceptance:local /tmp/dind-build",
            timeout=180,
        )
        _, body, _ = await scene.run(
            box, "docker run --rm --pull=never acceptance:local"
        )
        assert body == marker, body
        scene.passed("D1")
        compose = f"""services:
  backend:
    image: acceptance:local
    command: [httpd, -f, -p, "8080", -h, /srv]
  client:
    image: {BASE}
    command: [tail, -f, /dev/null]
"""
        await scene.run(
            box,
            "printf %s "
            + shlex.quote(compose)
            + " >/tmp/compose.yaml; docker compose -p proof -f /tmp/compose.yaml up -d",
        )
        await scene.run(
            box,
            "docker compose -p proof -f /tmp/compose.yaml exec -T client sh -c "
            + shlex.quote(NO_PROXY),
        )
        _, body, headers = await scene.ready(
            box,
            "docker compose -p proof -f /tmp/compose.yaml exec -T client wget -T 5 -SO- http://backend:8080/",
        )
        assert body == marker and re.search(r"HTTP/1\.[01] 200", headers), (
            body,
            headers,
        )
        await scene.run(
            box,
            "docker compose -p proof -f /tmp/compose.yaml ps --format json; docker network inspect proof_default; iptables-save; cat /tmp/dockerd.log",
        )
        scene.passed("D2")
        await scene.run(box, "docker compose -p proof -f /tmp/compose.yaml down")
        success = True
    except BaseException as error:
        scene.record["failure"] = repr(error)
        scene.save()
        raise
    finally:
        await scene.finish(success)


if __name__ == "__main__":
    asyncio.run(dind(arguments(__doc__).parse_args()))
