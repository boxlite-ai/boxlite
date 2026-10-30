"""Exercise cloud resize through real SDKs, CLI, billing and process recovery."""

import asyncio
import json
import os
import re
import signal
import subprocess
import uuid
from itertools import pairwise
from urllib.error import HTTPError

from . import acceptance as stack
from . import native, orchestrator
from .provision import create_ready


def database(sql, params=()):
    env = native._parse_dotenv(stack.ROOT / "apps/infra-local/api.env")
    env["DB_PORT"] = "35432"
    # Parameters cross stdin, not a shell or SQL string interpolation boundary.
    script = """
const {Client} = require('pg');
const fs = require('fs');
const [sql, values] = JSON.parse(fs.readFileSync(0, 'utf8'));
const c = new Client({host:process.env.DB_HOST, port:process.env.DB_PORT,
  user:process.env.DB_USERNAME, password:process.env.DB_PASSWORD, database:process.env.DB_DATABASE});
(async () => { await c.connect(); try { console.log(JSON.stringify((await c.query(sql, values)).rows)); }
  finally { await c.end(); } })().catch(e => { console.error(e.message); process.exitCode=1; });
"""
    result = subprocess.run(
        ["node", "-e", script],
        input=json.dumps([sql, params]),
        text=True,
        capture_output=True,
        check=True,
        cwd=stack.ROOT / "apps",
        env={**os.environ, **env},
    )
    return json.loads(result.stdout)


async def command(argv, env):
    process = await asyncio.create_subprocess_exec(
        *map(str, argv),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=stack.ROOT,
        env={**os.environ, **env},
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 90)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    return process.returncode, stdout.decode(), stderr.decode()


def crash_services():
    # The runner's normal shutdown stops its VMs. Simulate process loss instead;
    # detached shims must survive, and only this harness's process groups are ours.
    for name in ["api", "runner-a", "proxy"]:
        pidfile = stack.STATE / f"{name}.pid"
        pid = int(pidfile.read_text())
        cmd = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "command="], text=True
        )
        expected = (
            "ts-node"
            if name == "api"
            else str(stack.ROOT / f".apps-local/bin/boxlite-{name}")
        )
        if name == "runner-a":
            expected = str(stack.ROOT / ".apps-local/bin/boxlite-runner")
        if expected not in cmd or os.getpgid(pid) != pid:
            raise RuntimeError(f"Refusing to signal unrecognized {name} process")
        if name == "api" and os.readlink(f"/proc/{pid}/cwd") != str(
            stack.ROOT / "apps"
        ):
            raise RuntimeError("Refusing to signal an API from another checkout")
        os.killpg(pid, signal.SIGKILL)
        pidfile.unlink()


async def run():
    import boxlite

    prefix = stack.request("/v1/me")["path_prefix"]
    runtime = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=stack.API,
            credential=boxlite.ApiKeyCredential(stack.ADMIN_KEY),
            path_prefix=prefix,
        )
    )
    box = await create_ready(
        runtime,
        boxlite.BoxOptions(
            image="alpine:3.21",
            cpus=1,
            memory_mib=1024,
            auto_stop=0,
            auto_delete=0,
            entrypoint=["sh", "-c"],
            cmd=["exec sleep infinity"],
        ),
        name="resize-" + uuid.uuid4().hex,
    )
    (stack.STATE / "resize-box.json").write_text(json.dumps({"id": box.id}))

    async def guest():
        code, stdout, stderr = await orchestrator.exec_collect(
            box,
            "sh",
            [
                "-c",
                (
                    "cat /proc/sys/kernel/random/boot_id; awk '{print $1, $22}' /proc/1/stat; "
                    "grep -c '^processor' /proc/cpuinfo; awk '/MemTotal/ {print $2}' /proc/meminfo"
                ),
            ],
        )
        assert code == 0, stderr
        return stdout.strip().splitlines()

    before = await guest()
    initial = await box.resize()
    assert initial.cpus == 1 and initial.memory_mib == 1024
    grown = await box.resize(cpus=2, memory_mib=1537)
    assert grown.cpus == 2 and grown.memory_mib == 2048
    env = {
        "BOXLITE_API_KEY": stack.ADMIN_KEY,
        "BOXLITE_REST_URL": stack.API,
        "BOXLITE_REST_PATH_PREFIX": prefix,
        "RESIZE_BOX_ID": box.id,
    }
    node = """
import {JsBoxlite, BoxliteRestOptions, ApiKeyCredential} from './sdks/node/dist/index.js';
const rt = JsBoxlite.rest(new BoxliteRestOptions({url:process.env.BOXLITE_REST_URL,
  pathPrefix:process.env.BOXLITE_REST_PATH_PREFIX, credential:new ApiKeyCredential(process.env.BOXLITE_API_KEY)}));
const box = await rt.get(process.env.RESIZE_BOX_ID);
console.log(JSON.stringify(await box.resize({cpus:3})));
"""
    code, stdout, stderr = await command(
        ["node", "--input-type=module", "-e", node], env
    )
    assert code == 0, stderr
    assert json.loads(stdout)["cpus"] == 3
    cli = [
        stack.ROOT / "target/debug/boxlite",
        "resize",
        box.id,
        "--cpus",
        "4",
        "--memory",
        "3072",
    ]
    # DDL cannot bind a parameter inside a CHECK expression. The generated Box
    # identifier is constrained before quoting, and the constraint affects it alone.
    assert re.fullmatch(r"[A-Za-z0-9_-]+", box.id)
    database(
        f"ALTER TABLE box_usage_periods ADD CONSTRAINT acceptance_resize_failure "
        f"CHECK (\"boxId\" <> '{box.id}' OR cpu < 4)"
    )
    try:
        code, stdout, stderr = await command(cli, env)
        assert code != 0 and "Configuration accepted" in stderr, (stdout, stderr)
        [pending] = database(
            "SELECT * FROM job WHERE \"resourceId\"=$1 AND type='RESIZE_BOX' "
            'AND "completedAt" IS NULL',
            [box.id],
        )
        assert pending["resizePhase"] == "BILLING_PENDING" and pending["attempt"] == 0
        [desired] = database("SELECT cpu, mem, pending FROM box WHERE id=$1", [box.id])
        assert desired == {"cpu": 4, "mem": 3, "pending": True}
        assert (await box.resize()).cpus == 3
        for path, body, status, message in [
            (f"/v1/boxes/{box.id}/stop", {}, 400, "state change in progress"),
            (f"/v1/boxes/{box.id}/resize", {"memory_mib": 4096}, 409, "different resize target"),
        ]:
            try:
                stack.request(path, body)
            except HTTPError as error:
                detail = error.read().decode()
                assert error.code == status and message in detail, detail
            else:
                raise AssertionError(f"conflicting operation was accepted: {path}")
        crash_services()
        await asyncio.to_thread(stack.up, services_only=True)
        assert (await guest())[:2] == before[:2], "crash recovery restarted the guest"
    finally:
        database(
            "ALTER TABLE box_usage_periods DROP CONSTRAINT IF EXISTS acceptance_resize_failure"
        )
    database(
        'UPDATE job SET "nextAttemptAt"=statement_timestamp() WHERE id=$1',
        [pending["id"]],
    )
    code, stdout, stderr = await command(cli, env)
    assert code == 0, stderr
    assert json.loads(stdout)["cpus"] == 4 and json.loads(stdout)["memory_mib"] == 3072
    after = await guest()
    assert before[:2] == after[:2], "resize changed guest boot or PID 1 identity"
    assert int(after[2]) == 4 and int(before[3]) < int(after[3]) <= 3072 * 1024
    [completed] = database(
        "SELECT status, attempt FROM job WHERE id=$1", [pending["id"]]
    )
    assert completed["status"] == "COMPLETED" and completed["attempt"] >= 1
    periods = database(
        'SELECT cpu, mem, "startAt", "endAt" FROM box_usage_periods WHERE "boxId"=$1 '
        'UNION ALL SELECT cpu, mem, "startAt", "endAt" FROM box_usage_periods_archive '
        'WHERE "boxId"=$1 ORDER BY "startAt"',
        [box.id],
    )
    shapes = [(p["cpu"], p["mem"]) for p in periods]
    # A delayed STARTED event can create another initial interval; each resize
    # target must be billed exactly once and boundaries must meet precisely.
    for shape in [(2, 2), (3, 2), (4, 3)]:
        assert shapes.count(shape) == 1, shapes
    assert all(a["endAt"] == b["startAt"] for a, b in pairwise(periods))
    assert periods[-1]["endAt"] is None
    evidence = {
        "box_id": box.id,
        "before": before,
        "after": after,
        "billing_shapes": shapes,
        "recovered_job": completed,
    }
    (stack.STATE / "resize-result.json").write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence), flush=True)
    await runtime.remove(box.id, force=True)
    print(
        "PASS: Python + Node + CLI resize, billing retry, API/Runner crash recovery",
        flush=True,
    )


if __name__ == "__main__":
    asyncio.run(run())
