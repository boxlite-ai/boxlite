"""Isolated, real SDK/API/runner qualification. Failures retain their boxes/logs."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import replace
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess
import time
import urllib.request
import uuid

from .config import InfraConfig, worktree_home
from . import native, orchestrator
from .services import SPEC_PG, SPEC_REDIS

ROOT = InfraConfig.load().repo_root
STATE = ROOT / ".apps-local" / "runner-acceptance"
API_PORT = 13001
RUNNER_PORT = 13003
RUNNER_B_PORT = 13004
PROXY_PORT = 14000
ADMIN_KEY = "local-acceptance-admin-only"
RUNNER_KEY = "local-acceptance-runner-only"
RUNNER_B_KEY = "local-acceptance-runner-b-only"
API = f"http://127.0.0.1:{API_PORT}/api"
IMAGE = "docker:27.5.1-dind"


def request(path, body=None, method=None):
    req = urllib.request.Request(
        API + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={
            "Authorization": f"Bearer {ADMIN_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        data = response.read()
        return json.loads(data) if data else None


def start(name, argv, env, port, health, cwd=None):
    """Never kill an unrelated listener or adopt a process from another checkout."""
    pidfile = STATE / f"{name}.pid"
    if pidfile.exists():
        raise RuntimeError(
            f"{pidfile} exists; inspect retained process before restarting"
        )
    with socket.socket() as probe:
        # A stopped listener can leave TCP TIME_WAIT sockets. Match server bind
        # semantics while still refusing a port owned by a live listener.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", port))
    with (STATE / f"{name}.log").open("ab") as log:
        proc = subprocess.Popen(
            argv,
            cwd=cwd or ROOT / "apps",
            env={**os.environ, **env},
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    pidfile.write_text(str(proc.pid))
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(
                f"{name} exited {proc.returncode}; see {STATE / (name + '.log')}"
            )
        if orchestrator._http_probe(health):
            print(f"READY {name} pid={proc.pid} port={port}", flush=True)
            return
        time.sleep(0.5)
    raise TimeoutError(f"{name} readiness timed out; process/logs retained at {STATE}")


async def dependencies():
    cfg = replace(
        InfraConfig.load(),
        boxlite_home=worktree_home(ROOT, "qh"),
        data_dir=STATE / "data",
    )
    orchestrator.ensure_home_env(cfg)
    specs = {
        "postgres": replace(
            SPEC_PG, image="postgres:17.9-alpine", ports=[(35432, 5432)]
        ),
        "redis": replace(SPEC_REDIS, image="redis:7.4.2-alpine", ports=[(36379, 6379)]),
    }
    for spec in specs.values():
        for port, _ in spec.ports:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", port))
    await orchestrator.up(cfg, specs)


def up(services_only=False):
    STATE.mkdir(parents=True, exist_ok=True)
    # SDK's local runtime is used for infrastructure only. Acceptance uses REST.
    if not services_only:
        asyncio.run(dependencies())
    env = native._parse_dotenv(ROOT / "apps/infra-local/api.env")
    env.update(
        {
            "PORT": str(API_PORT),
            "APP_URL": API,
            "DB_PORT": "35432",
            "REDIS_PORT": "36379",
            "OIDC_ISSUER_BASE_URL": "https://accounts.google.com",
            "OTEL_ENABLED": "false",
            "SMTP_HOST": "",
            "S3_ENDPOINT": "",
            "ADMIN_API_KEY": ADMIN_KEY,
            "DEFAULT_RUNNER_NAME": "acceptance-a",
            "DEFAULT_RUNNER_API_KEY": RUNNER_KEY,
            "DEFAULT_RUNNER_API_URL": f"http://127.0.0.1:{RUNNER_PORT}",
            "DEFAULT_RUNNER_PROXY_URL": f"http://127.0.0.1:{RUNNER_PORT}",
            "PROXY_DOMAIN": f"localhost:{PROXY_PORT}",
            "PROXY_PROTOCOL": "http",
            "PROXY_API_KEY": "local-acceptance-proxy-only",
            "RUNNER_AVAILABILITY_SCORE_THRESHOLD": "5",
            "RUNNER_MEMORY_PENALTY_THRESHOLD": "99",
            "RUNNER_DISK_PENALTY_THRESHOLD": "99",
            "DEFAULT_REGION_ENFORCE_QUOTAS": "false",
        }
    )
    start(
        "api",
        [
            "corepack",
            "yarn",
            "ts-node",
            "--transpile-only",
            "--project",
            "api/tsconfig.app.json",
            "-r",
            "tsconfig-paths/register",
            "api/src/main.ts",
        ],
        env,
        API_PORT,
        API + "/health",
    )
    start(
        "runner-a",
        [str(ROOT / ".apps-local/bin/boxlite-runner")],
        {
            "BOXLITE_API_URL": API,
            "BOXLITE_RUNNER_TOKEN": RUNNER_KEY,
            "API_VERSION": "2",
            "API_PORT": str(RUNNER_PORT),
            "RUNNER_DOMAIN": "127.0.0.1",
            "BOXLITE_HOME_DIR": str(worktree_home(ROOT, "qa")),
            "AWS_REGION": "us-east-1",
            "OTEL_TRACING_ENABLED": "false",
        },
        RUNNER_PORT,
        f"http://127.0.0.1:{RUNNER_PORT}/",
    )
    start_proxy()
    verify()
    if (STATE / "two-runners.json").exists():
        two_runners()


def start_proxy():
    start(
        "proxy",
        [str(ROOT / ".apps-local/bin/boxlite-proxy")],
        {
            "PROXY_PORT": str(PROXY_PORT),
            "PROXY_PROTOCOL": "http",
            "PROXY_API_KEY": "local-acceptance-proxy-only",
            "BOXLITE_API_URL": API,
            "OIDC_CLIENT_ID": "boxlite",
            "OIDC_AUDIENCE": "boxlite",
            "OIDC_DOMAIN": "https://accounts.google.com",
            "SHUTDOWN_TIMEOUT_SEC": "10",
            "OTEL_TRACING_ENABLED": "false",
            "OTEL_LOGGING_ENABLED": "false",
        },
        PROXY_PORT,
        f"http://127.0.0.1:{PROXY_PORT}/health",
        # The Go proxy overloads .env from cwd, overriding supplied keys.
        # Keep this isolated process out of the ordinary local stack's cwd.
        cwd=STATE,
    )


def two_runners():
    runners = request("/admin/runners")
    a = next(r for r in runners if r["name"] == "acceptance-a")
    b = next((r for r in runners if r["name"] == "acceptance-b"), None)
    if b is None:
        b = request(
            "/admin/runners",
            {
                "regionId": a["region"],
                "name": "acceptance-b",
                "apiKey": RUNNER_B_KEY,
                "apiVersion": "2",
                "apiUrl": f"http://127.0.0.1:{RUNNER_B_PORT}",
                "proxyUrl": f"http://127.0.0.1:{RUNNER_B_PORT}",
                "cpu": 4,
                "memoryGiB": 8,
                "diskGiB": 30,
            },
        )
    record = {
        "physical_host": socket.gethostname(),
        "a": {
            "id": a["id"],
            "port": RUNNER_PORT,
            "home": str(worktree_home(ROOT, "qa")),
        },
        "b": {
            "id": b["id"],
            "port": RUNNER_B_PORT,
            "home": str(worktree_home(ROOT, "qb")),
        },
    }
    (STATE / "two-runners.json").write_text(json.dumps(record, indent=2))
    if not (STATE / "runner-b.pid").exists():
        start(
            "runner-b",
            [str(ROOT / ".apps-local/bin/boxlite-runner")],
            {
                "BOXLITE_API_URL": API,
                "BOXLITE_RUNNER_TOKEN": RUNNER_B_KEY,
                "API_VERSION": "2",
                "API_PORT": str(RUNNER_B_PORT),
                "RUNNER_DOMAIN": "127.0.0.1",
                "BOXLITE_HOME_DIR": record["b"]["home"],
                "AWS_REGION": "us-east-1",
                "OTEL_TRACING_ENABLED": "false",
            },
            RUNNER_B_PORT,
            f"http://127.0.0.1:{RUNNER_B_PORT}/",
        )
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        found = {r["id"]: r for r in request("/admin/runners")}
        if all(found[record[k]["id"]]["state"] == "ready" for k in ["a", "b"]):
            print(json.dumps(record), flush=True)
            return record
        time.sleep(0.5)
    raise TimeoutError("both local runners did not become ready; processes retained")


def restart():
    """Restart only the isolated processes whose pidfiles this harness owns."""
    for name, port in [
        ("api", API_PORT),
        ("runner-a", RUNNER_PORT),
        ("runner-b", RUNNER_B_PORT),
        ("proxy", PROXY_PORT),
    ]:
        pidfile = STATE / f"{name}.pid"
        if not pidfile.exists():
            continue  # a prior partial restart already stopped this service
        pid = int(pidfile.read_text())
        try:
            command = subprocess.check_output(
                ["ps", "-p", str(pid), "-o", "command="], text=True
            )
        except subprocess.CalledProcessError:
            # A deliberately crashed process may already have been reaped.
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                pidfile.unlink()
                continue
            raise
        expected = (
            "ts-node"
            if name == "api"
            else str(
                ROOT
                / ".apps-local/bin"
                / ("boxlite-proxy" if name == "proxy" else "boxlite-runner")
            )
        )
        if expected not in command or os.getpgid(pid) != pid:
            raise RuntimeError(f"refuse to signal unrecognized {name} pid={pid}")
        os.killpg(pid, signal.SIGTERM)
        deadline = time.monotonic() + 60
        while True:
            with socket.socket() as probe:
                closed = probe.connect_ex(("127.0.0.1", port)) != 0
            if closed:
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(f"{name} did not release port {port}")
            time.sleep(0.2)
        pidfile.unlink()
    up(services_only=True)


def verify():
    assert orchestrator._http_probe(API + "/health"), "API is not ready"
    assert orchestrator._http_probe(f"http://127.0.0.1:{RUNNER_PORT}/"), (
        "Runner is not ready"
    )
    assert orchestrator._http_probe(f"http://127.0.0.1:{PROXY_PORT}/health"), (
        "Port proxy is not ready"
    )
    print(
        json.dumps(
            {
                "api": API,
                "principal": request("/v1/me"),
                "capabilities": request("/v1/config"),
            }
        ),
        flush=True,
    )


def runner_home_for_box(box_id):
    owner = request(f"/box/{box_id}")["runnerId"]
    runner = next(r for r in request("/admin/runners") if r["id"] == owner)
    for name, port, suffix in [
        ("acceptance-a", RUNNER_PORT, "qa"),
        ("acceptance-b", RUNNER_B_PORT, "qb"),
    ]:
        if runner["name"] == name and runner["apiUrl"] == f"http://127.0.0.1:{port}":
            return worktree_home(ROOT, suffix)
    raise RuntimeError("Box was not placed on one of this harness's local runners")


async def dind():
    import boxlite

    STATE.mkdir(parents=True, exist_ok=True)
    principal = request("/v1/me")
    assert request("/v1/config")["capabilities"].get("privileged_enabled") is True
    runtime = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=API,
            credential=boxlite.ApiKeyCredential(ADMIN_KEY),
            path_prefix=principal["path_prefix"],
        )
    )
    marker = "dind-" + uuid.uuid4().hex
    box = await runtime.create(
        boxlite.BoxOptions(
            image=IMAGE,
            cpus=2,
            memory_mib=2048,
            disk_size_gb=10,
            advanced=boxlite.AdvancedBoxOptions(privileged=True),
            env=[("DOCKER_TLS_CERTDIR", "")],
            entrypoint=["sh", "-c"],
            cmd=[
                "dockerd-entrypoint.sh --storage-driver=overlay2 --data-root=/var/lib/docker >/tmp/dockerd.log 2>&1 & exec tail -f /dev/null"
            ],
            auto_stop=0,
            auto_delete=0,
        ),
        name=marker,
    )
    (STATE / "dind-box.json").write_text(
        json.dumps({"id": box.id, "marker": marker, "image": IMAGE})
    )

    async def run(command, check=True, timeout=180):
        if check:
            command = "set -eu; " + command
        result = await asyncio.wait_for(
            orchestrator.exec_collect(box, "sh", ["-c", command]), timeout=timeout
        )
        with (STATE / "dind-guest.log").open("a") as log:
            log.write(f"\n$ {command}\nexit={result[0]}\n{result[1]}\n{result[2]}\n")
        if check and result[0] != 0:
            raise AssertionError(
                f"guest command failed ({result[0]}): {command}; see dind-guest.log"
            )
        return result

    # Exceptions deliberately leave the source box and daemon for diagnosis.
    deadline = time.monotonic() + 120
    while True:
        rc, _, _ = await run("docker info", check=False, timeout=10)
        if rc == 0:
            break
        if time.monotonic() >= deadline:
            await run(
                "uname -a; cat /tmp/dockerd.log; cat /proc/mounts; cat /proc/cgroups; ip addr; ps",
                check=False,
            )
            raise TimeoutError("dockerd was not ready in 120s; box retained")
        await asyncio.sleep(1)
    await run(
        "uname -a; pidof dockerd; docker version; docker compose version; docker info --format '{{json .}}'"
    )
    await run(
        "set -eu; test -S /var/run/docker.sock; "
        'test -z "${DOCKER_HOST:-}"; '
        'test "$(basename "$(readlink /proc/$(pidof dockerd)/exe)")" = dockerd; '
        "if grep -q ' /var/run/docker.sock ' /proc/mounts; then exit 1; fi; "
        "uname -r; zcat /proc/config.gz; cat /proc/mounts; cat /proc/self/status; "
        "iptables -t nat -S; iptables -S; ip addr"
    )
    await run(
        "test \"$(docker version --format '{{.Server.Version}}')\" = 27.5.1; "
        "test \"$(docker info --format '{{.Driver}}')\" = overlay2; "
        "test \"$(docker info --format '{{.DockerRootDir}}')\" = /var/lib/docker"
    )
    await run("docker pull busybox:1.37.0; docker image inspect busybox:1.37.0")
    dockerfile = 'FROM busybox:1.37.0\nCOPY marker /srv/index.html\nRUN test -s /srv/index.html && chmod 0644 /srv/index.html\nCMD ["cat", "/srv/index.html"]\n'
    await run(
        "mkdir -p /tmp/dind-build; printf %s "
        + shlex.quote(marker)
        + " > /tmp/dind-build/marker; printf %s "
        + shlex.quote(dockerfile)
        + " > /tmp/dind-build/Dockerfile; docker build --progress=plain -t acceptance:local /tmp/dind-build"
    )
    _, output, _ = await run("docker run --rm --pull=never acceptance:local")
    assert output.strip() == marker, output
    print("D1 PASS", flush=True)
    compose = """services:
  backend:
    image: acceptance:local
    command: [httpd, -f, -p, "8080", -h, /srv]
  client:
    image: busybox:1.37.0
    command: [tail, -f, /dev/null]
"""
    await run(
        "printf %s "
        + shlex.quote(compose)
        + " > /tmp/compose.yaml; docker compose -f /tmp/compose.yaml up -d"
    )
    deadline = time.monotonic() + 30
    while True:
        rc, output, headers = await run(
            "docker compose -f /tmp/compose.yaml exec -T client wget -SO- http://backend:8080/",
            check=False,
            timeout=10,
        )
        if (
            rc == 0
            and output.strip() == marker
            and re.search(r"HTTP/1\.[01] 200", headers)
        ):
            break
        if time.monotonic() >= deadline:
            raise AssertionError(
                "Compose inter-service HTTP did not return the unique marker"
            )
        await asyncio.sleep(0.5)
    print("D2 PASS", flush=True)
    owner_home = runner_home_for_box(box.id)
    await run(
        "docker compose -f /tmp/compose.yaml ps --format json; docker network inspect tmp_default; cat /tmp/dockerd.log"
    )
    print(f"Verified API box {box.id}, runner runtime home {owner_home}", flush=True)
    await run("docker compose -f /tmp/compose.yaml down")
    await run("kill -TERM $(pidof dockerd)")
    deadline = time.monotonic() + 30
    while (await run("pidof dockerd", check=False, timeout=10))[0] == 0:
        if time.monotonic() >= deadline:
            raise TimeoutError("dockerd did not stop; Box and logs retained")
        await asyncio.sleep(0.25)
    await runtime.remove(box.id, force=True)
    print("F1 PASS: Python SDK -> API -> runner -> guest", flush=True)


async def diagnose_dind():
    import boxlite

    record = json.loads((STATE / "dind-box.json").read_text())
    runtime = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=API,
            credential=boxlite.ApiKeyCredential(ADMIN_KEY),
            path_prefix=request("/v1/me")["path_prefix"],
        )
    )
    box = await runtime.get(record["id"])
    print(json.dumps(record), flush=True)
    command = "uname -a; cat /tmp/dockerd.log; cat /proc/mounts; cat /proc/cgroups; ip addr; ps; df -h; dmesg | tail -60"
    result = await asyncio.wait_for(
        orchestrator.exec_collect(box, "sh", ["-c", command]), timeout=30
    )
    print(f"exit={result[0]}\n{result[1]}\n{result[2]}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=[
            "build",
            "build-proxy",
            "up",
            "restart",
            "verify",
            "dind",
            "diagnose-dind",
            "two-runners",
        ],
    )
    action = parser.parse_args().action
    if action == "build":
        native._go_build(native._Paths(ROOT), "runner")
    elif action == "build-proxy":
        native._go_build(native._Paths(ROOT), "proxy")
    elif action == "up":
        up()
    elif action == "verify":
        verify()
    elif action == "diagnose-dind":
        asyncio.run(diagnose_dind())
    elif action == "restart":
        restart()
    elif action == "two-runners":
        two_runners()
    else:
        asyncio.run(dind())


if __name__ == "__main__":
    main()
