"""Keep a native BoxLite runtime and its TCP forwarders alive over stdio."""

import argparse
import asyncio
import json
import os
import plistlib
import socket
import subprocess
import sys
import traceback
import urllib.request
import uuid
from pathlib import Path


async def collect(box, command, timeout):
    execution = await box.exec(
        "sh", ["-c", "set -eu; " + command], timeout_secs=timeout
    )

    async def drain(stream):
        return "".join([chunk async for chunk in stream])

    stdout, stderr = await asyncio.gather(
        drain(execution.stdout()), drain(execution.stderr())
    )
    result = await execution.wait()
    return {"code": result.exit_code, "stdout": stdout, "stderr": stderr}


class Worker:
    def __init__(self, home):
        import boxlite

        self.sdk = boxlite
        self.home = home.resolve()
        self.home.mkdir(parents=True, exist_ok=True)
        self.runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(self.home)))
        self.boxes = {}
        self.forwards = []
        host = os.uname()
        if host.sysname == "Darwin":
            devices = plistlib.loads(
                subprocess.check_output(
                    ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice", "-a"],
                    timeout=10,
                )
            )
            machine_id = devices[0]["IOPlatformUUID"]
            host_netns = None
        else:
            machine_id = Path("/etc/machine-id").read_text().strip()
            host_netns = os.readlink("/proc/self/ns/net")
        self.identity = {
            "runner": uuid.uuid4().hex,
            "hostname": socket.gethostname(),
            "machine_id": machine_id,
            "host_os": host.sysname,
            "host_arch": host.machine,
            "kernel": host.release,
            "pid": os.getpid(),
            "home": str(self.home),
            "host_netns": host_netns,
            "sdk_version": boxlite.__version__,
            "sdk_module": boxlite.__file__,
            "runtime_dir": os.environ.get("BOXLITE_RUNTIME_DIR"),
        }

    def save(self):
        (self.home / "acceptance-boxes.json").write_text(
            json.dumps({"worker": self.identity, "boxes": list(self.boxes)}, indent=2)
        )

    async def dispatch(self, request):
        operation = request["operation"]
        if operation == "identity":
            return self.identity
        if operation == "create":
            boxlite = self.sdk
            proxy = request.get("download_proxy")
            env = [("DOCKER_TLS_CERTDIR", "")]
            if proxy:
                env += [
                    (name, proxy)
                    for name in [
                        "HTTP_PROXY",
                        "HTTPS_PROXY",
                        "http_proxy",
                        "https_proxy",
                    ]
                ]
                env += [
                    ("NO_PROXY", "localhost,127.0.0.1"),
                    ("no_proxy", "localhost,127.0.0.1"),
                ]
            box = await self.runtime.create(
                boxlite.BoxOptions(
                    image=request["image"],
                    cpus=2,
                    memory_mib=2048,
                    disk_size_gb=10,
                    advanced=boxlite.AdvancedBoxOptions(privileged=True),
                    network=boxlite.NetworkSpec(
                        inbound=boxlite.InboundNetworkSpec(mode="enabled")
                    ),
                    env=env,
                    entrypoint=["sh", "-c"],
                    cmd=["exec tail -f /dev/null"],
                    auto_remove=False,
                    auto_stop=0,
                    auto_delete=0,
                    detach=True,
                ),
                name=request["name"],
            )
            self.boxes[box.id] = box
            self.save()
            await box.start()
            return {"box": box.id, "worker": self.identity}
        if operation == "exec":
            return await collect(
                self.boxes[request["box"]],
                request["command"],
                request.get("timeout", 120),
            )
        if operation == "forward":
            tunnel = await self.boxes[request["box"]].network.tunnel(
                ("127.0.0.1", request["port"])
            )
            handle = await tunnel.forward(
                self.sdk.SocketAddress.tcp(request.get("listen", "127.0.0.1"), 0)
            )
            self.forwards.append(handle)
            return {"host": handle.local_addr().host, "port": handle.local_addr().port}
        if operation == "http":
            # A host-side request through the SDK forwarder proves Box exposure.
            def fetch():
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(
                    f"http://127.0.0.1:{request['port']}/", timeout=5
                ) as response:
                    return {"status": response.status, "body": response.read().decode()}

            return await asyncio.to_thread(fetch)
        if operation == "remove":
            await self.runtime.remove(request["box"], force=True)
            del self.boxes[request["box"]]
            self.save()
            return None
        if operation == "close":
            for handle in self.forwards:
                await handle.close()
            self.forwards.clear()
            return None
        raise ValueError(f"unknown operation: {operation}")


async def serve(args, protocol):
    worker = Worker(args.home)
    log = worker.home / "commands.log"
    while line := await asyncio.to_thread(sys.stdin.readline):
        request = json.loads(line)
        private = request.get("private", False)
        with log.open("a") as stream:
            visible = {
                key: value for key, value in request.items() if key != "download_proxy"
            }
            stream.write(
                json.dumps(
                    {"id": request["id"], "private": True} if private else visible
                )
                + "\n"
            )
        try:
            result = await asyncio.wait_for(
                worker.dispatch(request), request.get("timeout", 120) + 15
            )
            response = {"id": request["id"], "result": result}
        except Exception as error:  # noqa: BLE001 - Return operation failures over the protocol.
            if not private:
                traceback.print_exc(file=sys.stderr)
            response = {
                "id": request["id"],
                "error": type(error).__name__ if private else repr(error),
            }
        with log.open("a") as stream:
            stream.write(
                json.dumps(
                    {"id": request["id"], "private": True} if private else response
                )
                + "\n"
            )
        protocol.write(json.dumps(response) + "\n")
        protocol.flush()
        if request["operation"] == "close":
            return


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, required=True)
    args = parser.parse_args()
    # Native libraries can write to fd 1; reserve its original pipe for JSON only.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    asyncio.run(serve(args, protocol))
