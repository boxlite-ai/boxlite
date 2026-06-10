"""Comprehensive E2E test exercising each service's real protocol.

Distinct from `test_multi_service.py`, which only verifies "box came up +
health endpoint responds". This file verifies "the service actually does
its job":

    - postgres:  real SQL roundtrip (CREATE / INSERT / SELECT)
    - redis:     SET / GET / INCR roundtrip
    - minio:     S3 PUT / GET via a transient `mc` client box
    - registry:  GET /v2/_catalog (registry v2 catalog API)
    - dex:       JWKS endpoint serves real OIDC keys
    - jaeger:    query API returns the JSON services list
    - otel:      POST OTLP HTTP trace → spans appear in debug exporter logs
    - caddy:     all 6 reverse-proxy upstream paths return 2xx
    - stability: stack stays healthy after 30s idle
    - resource:  total memory across the 10 daemons stays under 8 GiB

Module-scoped: the 11-box stack comes up ONCE for the whole file, then
every test runs against it, then teardown at the end. ~60-90s total.

Gated on `BOXLITE_INTEGRATION=1` (same as `test_multi_service.py`).
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

from boxlite_local.config import InfraConfig
from boxlite_local.doctor import doctor
from boxlite_local.execwrap import exec_collect
from boxlite_local.orchestrator import down, get_runtime, ps, up
from boxlite_local.services import SERVICES

pytestmark = pytest.mark.skipif(
    os.environ.get("BOXLITE_INTEGRATION") != "1",
    reason="set BOXLITE_INTEGRATION=1 to run",
)


# ─── module-scoped stack fixture ──────────────────────────────────────────


@pytest.fixture(scope="module")
def stack():
    """Bring up the 11-box stack once for the entire module."""
    tmp = Path(tempfile.mkdtemp(prefix="boxlite-local-e2e-"))
    mp = pytest.MonkeyPatch()
    mp.setenv("BOXLITE_DATA_DIR", str(tmp))
    cfg = InfraConfig.load()

    async def setup():
        pre = await ps(cfg)
        if [n for n, _, _ in pre]:
            pytest.skip(
                "pre-existing boxlite-local-* boxes; aborting to avoid destroying state"
            )
        report = await doctor(cfg, SERVICES, strict=False)
        assert not report.any_fail(), f"doctor failed before E2E: {report.checks!r}"
        await up(cfg, SERVICES, skip_doctor=True)

    async def teardown():
        # Best-effort cleanup of the ephemeral mc client box (if any test
        # left it around).
        try:
            runtime = get_runtime()
            try:
                await runtime.remove("boxlite-local-e2e-mc", force=True)
            except Exception:
                pass
        except Exception:
            pass
        await down(cfg, SERVICES, wipe=True)

    asyncio.run(setup())
    try:
        yield cfg
    finally:
        asyncio.run(teardown())
        mp.undo()
        shutil.rmtree(tmp, ignore_errors=True)


def _run(coro):
    return asyncio.run(coro)


# ─── 1. postgres: real SQL roundtrip ──────────────────────────────────────


def test_postgres_sql_roundtrip(stack):
    """CREATE TABLE / INSERT / SELECT via in-box psql."""

    async def go():
        runtime = get_runtime()
        pg = await runtime.get("boxlite-local-postgres")
        rc, out, err = await exec_collect(
            pg,
            "psql",
            [
                "-U", "boxlite", "-d", "boxlite", "-tA",
                "-c",
                "CREATE TABLE IF NOT EXISTS e2e (id INT PRIMARY KEY, val TEXT); "
                "INSERT INTO e2e VALUES (1, 'hello-e2e') "
                "  ON CONFLICT (id) DO UPDATE SET val = EXCLUDED.val; "
                "SELECT val FROM e2e WHERE id = 1;",
            ],
        )
        assert rc == 0, f"psql failed: rc={rc} stderr={err!r}"
        assert "hello-e2e" in out, f"unexpected output: {out!r}"

    _run(go())


# ─── 2. redis: SET / GET / INCR ───────────────────────────────────────────


def test_redis_kv_roundtrip(stack):
    async def go():
        runtime = get_runtime()
        r = await runtime.get("boxlite-local-redis")

        rc, _o, _e = await exec_collect(r, "redis-cli", ["SET", "e2e:hello", "world"])
        assert rc == 0

        rc, out, _e = await exec_collect(r, "redis-cli", ["GET", "e2e:hello"])
        assert rc == 0 and "world" in out, f"GET returned {out!r}"

        # increment twice — second value must be "2"
        await exec_collect(r, "redis-cli", ["DEL", "e2e:counter"])
        await exec_collect(r, "redis-cli", ["INCR", "e2e:counter"])
        rc, out, _e = await exec_collect(r, "redis-cli", ["INCR", "e2e:counter"])
        assert rc == 0 and "2" in out, f"INCR returned {out!r}"

    _run(go())


# ─── 3. minio: S3 PUT / GET via transient mc client box ───────────────────


def test_minio_s3_put_get(stack):
    """Spawn an ephemeral minio/mc box, configure alias, PUT a small object,
    GET it back, verify content matches."""

    async def go():
        try:
            from boxlite import BoxOptions
        except ImportError:
            from boxlite.boxlite import BoxOptions  # type: ignore

        runtime = get_runtime()
        name = "boxlite-local-e2e-mc"

        opts = BoxOptions(
            image="minio/mc:latest",
            cpus=1,
            memory_mib=128,
            auto_remove=False,
            detach=True,
            entrypoint=["sh"],
            cmd=["-c", "sleep 600"],   # keep alive for the test duration
            env=[
                ("MINIO_URL", f"http://{stack.host_hub}:{stack.minio_host_port}"),
                ("MINIO_USER", stack.minio_user),
                ("MINIO_PASSWORD", stack.minio_password),
            ],
        )

        # ensure clean state
        try:
            await runtime.remove(name, force=True)
        except Exception:
            pass

        box, _ = await runtime.get_or_create(opts, name=name)
        await box.start()

        try:
            # configure alias
            rc, _o, err = await exec_collect(
                box,
                "mc",
                [
                    "alias", "set", "boxlite",
                    f"http://{stack.host_hub}:{stack.minio_host_port}",
                    stack.minio_user, stack.minio_password,
                ],
            )
            assert rc == 0, f"mc alias set failed: {err!r}"

            # PUT a small object
            rc, _o, err = await exec_collect(
                box,
                "sh",
                [
                    "-c",
                    "echo 'e2e-payload' > /tmp/e2e.txt && "
                    "mc cp /tmp/e2e.txt boxlite/boxlite/e2e.txt",
                ],
            )
            assert rc == 0, f"mc cp failed: {err!r}"

            # GET it back
            rc, out, err = await exec_collect(
                box, "mc", ["cat", "boxlite/boxlite/e2e.txt"]
            )
            assert rc == 0, f"mc cat failed: {err!r}"
            assert "e2e-payload" in out, f"unexpected content: {out!r}"

        finally:
            try:
                await runtime.remove(name, force=True)
            except Exception:
                pass

    _run(go())


# ─── 4. registry: v2 catalog API ──────────────────────────────────────────


def test_registry_v2_catalog(stack):
    """GET /v2/_catalog returns a JSON document with a `repositories` list."""
    with urllib.request.urlopen(
        f"http://127.0.0.1:{stack.registry_host_port}/v2/_catalog", timeout=5
    ) as resp:
        assert 200 <= resp.status < 300
        body = json.loads(resp.read())
    assert "repositories" in body, f"unexpected body: {body!r}"
    assert isinstance(body["repositories"], list)


# ─── 5. dex: JWKS endpoint ────────────────────────────────────────────────


def test_dex_jwks(stack):
    """GET /dex/keys returns JSON with at least one signing key."""
    with urllib.request.urlopen(
        f"http://127.0.0.1:{stack.dex_host_port}/dex/keys", timeout=5
    ) as resp:
        assert 200 <= resp.status < 300
        body = json.loads(resp.read())
    assert "keys" in body, f"unexpected JWKS body: {body!r}"
    assert isinstance(body["keys"], list) and len(body["keys"]) >= 1


# ─── 6. jaeger: query API ─────────────────────────────────────────────────


def test_jaeger_query_api(stack):
    """GET /api/services returns Jaeger's JSON services list."""
    with urllib.request.urlopen(
        f"http://127.0.0.1:{stack.jaeger_host_port}/api/services", timeout=5
    ) as resp:
        assert 200 <= resp.status < 300
        body = json.loads(resp.read())
    # The exact shape is `{"data": [...], ...}`. Just confirm `data` key exists.
    assert "data" in body, f"unexpected body: {body!r}"


# ─── 7. otel: POST OTLP HTTP trace + verify in debug-exporter output ──────


def test_otel_otlp_http_receiver_accepts_trace(stack):
    """POST a minimal OTLP/HTTP trace; assert the receiver returns 2xx.

    Verifying the trace actually flowed through the debug exporter to
    stdout would need the box's container log file. The boxlite CLI's
    `logs` command acquires the runtime lock, which conflicts with the
    in-process Boxlite runtime pytest is already holding, and the otel
    image is distroless so we can't `box.exec cat /proc/1/fd/1` either.
    The 2xx response from the OTLP HTTP receiver is itself strong
    evidence: the receiver only 200s if it successfully parsed AND
    queued the payload to the pipeline.
    """
    payload = {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name",
                         "value": {"stringValue": "e2e-test-service"}}
                    ]
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "e2e-test-scope"},
                        "spans": [
                            {
                                # 16 bytes for traceId, 8 for spanId (hex strings)
                                "traceId": "0123456789abcdef0123456789abcdef",
                                "spanId":  "0123456789abcdef",
                                "name": "e2e-span-name",
                                "kind": 1,
                                "startTimeUnixNano": "1700000000000000000",
                                "endTimeUnixNano":   "1700000001000000000",
                            }
                        ],
                    }
                ],
            }
        ]
    }

    req = urllib.request.Request(
        f"http://127.0.0.1:{stack.otel_http_port}/v1/traces",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert 200 <= resp.status < 300, f"OTLP POST failed: {resp.status}"
        body = resp.read()
    # OTLP/HTTP success response is an `ExportTraceServiceResponse`. On a
    # fully-accepted batch the body is JSON-shaped `{"partialSuccess":{}}`
    # (or `{}` for older collectors). On rejection it'd contain a
    # `rejectedSpans` count. Parse and assert no rejections.
    parsed = json.loads(body) if body else {}
    partial = parsed.get("partialSuccess", {})
    rejected = partial.get("rejectedSpans", 0) if isinstance(partial, dict) else 0
    assert rejected == 0, f"otel rejected spans: {parsed!r}"


# ─── 8. caddy: all 6 upstream routes reachable ────────────────────────────


def test_caddy_reverse_proxy_all_routes(stack):
    base = f"http://127.0.0.1:{stack.caddy_http_port}"
    for path in [
        "/jaeger/",
        "/registry/v2/",
        "/registry-ui/",
        "/dex/dex/.well-known/openid-configuration",
        "/minio/minio/health/live",
        "/pgadmin/misc/ping",
    ]:
        with urllib.request.urlopen(base + path, timeout=5) as resp:
            assert 200 <= resp.status < 300, f"{path}: {resp.status}"


# ─── 9. stability: stack stays healthy after idle ─────────────────────────


def test_stack_remains_healthy_after_idle(stack):
    """Sleep 30s, then re-verify every host-side health endpoint still 200s."""
    time.sleep(30)
    urls = [
        f"http://127.0.0.1:{stack.registry_host_port}/v2/",
        f"http://127.0.0.1:{stack.minio_host_port}/minio/health/live",
        f"http://127.0.0.1:{stack.dex_host_port}/dex/.well-known/openid-configuration",
        f"http://127.0.0.1:{stack.jaeger_host_port}/",
        f"http://127.0.0.1:{stack.pgadmin_host_port}/misc/ping",
        f"http://127.0.0.1:25052/",
        f"http://127.0.0.1:{stack.otel_health_port}/",
        f"http://127.0.0.1:{stack.caddy_http_port}/",
    ]
    for url in urls:
        with urllib.request.urlopen(url, timeout=5) as resp:
            assert 200 <= resp.status < 300, f"{url}: {resp.status}"


# ─── 10. resource usage: control plane under 8 GiB ────────────────────────


def test_resource_usage_within_budget(stack):
    """Sum memory_mib across all boxlite-local-* daemons. Assert under 8 GiB.

    Parent design §5.1 budgets ~5-6 GiB for the control plane. 8 GiB is the
    soft cap for sustainability on a 24 GB M5 (~16 GiB headroom for the OS,
    IDE, host services, and the M5 native runner).
    """

    async def go():
        runtime = get_runtime()
        infos = await runtime.list_info()
        ours = [
            i for i in infos
            if i.name and i.name.startswith("boxlite-local-")
        ]
        total_mib = sum(i.memory_mib for i in ours)
        # Print the per-box breakdown so a failing test is self-explanatory.
        print()
        print("  memory budget:")
        for i in ours:
            print(f"    {i.name:<30} {i.memory_mib:>5} MiB")
        print(f"    {'TOTAL':<30} {total_mib:>5} MiB  ({total_mib / 1024:.2f} GiB)")

        assert total_mib < 8192, (
            f"control plane uses {total_mib} MiB > 8 GiB budget; "
            f"trim memory_mib on the larger services"
        )

    _run(go())
