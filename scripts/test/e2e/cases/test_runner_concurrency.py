"""Cross-process race / concurrency contracts on the runner.

Local-FFI tests can't exercise these — they run in a single Python process
against an in-process Boxlite. The runner is a separate Go daemon that
shares state (exec_manager.execs map, sandbox_sync.go reconcile loop,
attach session tracking) across all REST clients; bugs here only surface
when two REST clients hit it at the same instant.
"""

from __future__ import annotations

import asyncio
import json
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

import boxlite
import pytest

from conftest import drain


def _profile() -> dict:
    return tomllib.loads((Path.home() / ".boxlite/credentials.toml").read_text())[
        "profiles"
    ]["p1"]


# ─── 1. Two execs on same box, concurrently ────────────────────────────────


@pytest.mark.asyncio
async def test_two_concurrent_execs_on_same_box(rt, image):
    """Both execs must succeed; neither's stdout may bleed into the other.
    Failure mode: exec_manager.execs map insertion drops one ID under
    contention, or the runner serializes them silently (deadlock-grade
    bug). Either way, one task observes the wrong output."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:

        async def run_one(token: str) -> str:
            ex = await box.exec("sh", ["-c", f"echo {token}"], None)
            out, _ = await drain(ex)
            await ex.wait()
            return out

        a_task = asyncio.create_task(run_one("AAA-token-1"))
        b_task = asyncio.create_task(run_one("BBB-token-2"))
        out_a, out_b = await asyncio.gather(a_task, b_task)

        assert "AAA-token-1" in out_a, f"exec A lost stdout: {out_a!r}"
        assert "BBB-token-2" in out_b, f"exec B lost stdout: {out_b!r}"
        assert "BBB-token-2" not in out_a, (
            f"exec A received exec B's stdout — cross-talk: {out_a!r}"
        )
        assert "AAA-token-1" not in out_b, (
            f"exec B received exec A's stdout — cross-talk: {out_b!r}"
        )
    finally:
        await rt.remove(box.id, force=True)


# ─── 2. Many quick boxes in parallel ──────────────────────────────────────


@pytest.mark.asyncio
async def test_parallel_box_creates(rt, image):
    """Three boxes created in parallel must all reach Running with unique
    IDs. Failure mode: ID generation collision, or sandbox_sync reconcile
    races corrupting two parallel creates."""
    N = 3

    async def create_one():
        return await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))

    boxes = await asyncio.gather(*(create_one() for _ in range(N)))
    try:
        ids = [b.id for b in boxes]
        assert len(set(ids)) == N, f"duplicate box IDs: {ids}"
    finally:
        for b in boxes:
            try:
                await rt.remove(b.id, force=True)
            except Exception:
                pass


# ─── 3. Exec while box is being removed ────────────────────────────────────


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Production bug: POST /v1/{prefix}/boxes/{id}/exec on a removed box "
        "leaks HTTP 500 instead of 404. The API's box lookup ("
        "apps/api/src/boxlite-rest/boxlite-proxy.controller.ts) succeeds against "
        "the sandbox table (the row is soft-deleted not purged), then the "
        "request reaches the runner which tries to spawn against a freed "
        "Boxlite handle and errors with 'spawn_failed: build failed'. Fix: "
        "either reject at API by checking sandbox.state == DESTROYED, or "
        "ensure the runner translates spawn-after-destroy into ErrNotFound."
    ),
)
@pytest.mark.asyncio
async def test_exec_after_box_removed_is_typed_error(rt, image):
    """POST /boxes/{id}/exec after the box is gone must return 4xx
    (typically 404 NotFound or 409 InvalidState), not 5xx."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    box_id = box.id
    await rt.remove(box_id, force=True)

    p = _profile()
    req = urllib.request.Request(
        f"{p['url']}/v1/{p['path_prefix']}/boxes/{box_id}/exec",
        method="POST",
        headers={
            "Authorization": f"Bearer {p['api_key']}",
            "Content-Type": "application/json",
        },
        data=json.dumps({"command": "true", "args": []}).encode(),
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            pytest.fail(f"exec on removed box got HTTP {r.status} — should be 4xx")
    except urllib.error.HTTPError as e:
        assert 400 <= e.code < 500, (
            f"exec on removed box leaked HTTP {e.code} — should be 4xx"
        )


# ─── 4. Box DELETE while exec is running ────────────────────────────────────


@pytest.mark.asyncio
async def test_box_delete_during_running_exec(rt, image):
    """Start a long-running exec, then DELETE the box. The DELETE response
    must NOT be 5xx. Acceptable outcomes:
      * 204 — runner reaped the exec and removed the box
      * 400 'state change in progress' — API rejected the racy delete
        (caller should retry after wait); this is conservative behavior,
        not a bug.
    Failure modes this test catches:
      * 5xx leak
      * exec hangs forever after the box is gone — exec_manager didn't
        propagate the box delete
    """
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))

    ex = await box.exec("sh", ["-c", "sleep 30"], None)
    await asyncio.sleep(1.0)

    # Try the racy delete via raw HTTP so we can inspect the status.
    p = _profile()
    del_req = urllib.request.Request(
        f"{p['url']}/v1/{p['path_prefix']}/boxes/{box.id}?force=true",
        method="DELETE",
        headers={"Authorization": f"Bearer {p['api_key']}"},
    )
    try:
        with urllib.request.urlopen(del_req, timeout=15) as r:
            del_status = r.status
    except urllib.error.HTTPError as e:
        del_status = e.code
        del_body = e.read().decode("utf-8", "replace")
        assert "state change" in del_body.lower(), (
            f"racy DELETE returned HTTP {del_status} but body doesn't "
            f"explain it: {del_body!r}"
        )

    assert del_status < 500, f"DELETE during running exec leaked HTTP {del_status}"

    # Whatever happened above, the exec must not hang. We give it a generous
    # cap (15s for the racy case where the runner is still cleaning up).
    try:
        await asyncio.wait_for(ex.wait(), timeout=30.0)
    except asyncio.TimeoutError:
        pytest.fail(
            "exec did not resolve within 30s after racy DELETE — "
            "exec_manager state machine leak"
        )
    except Exception:
        pass

    # Best-effort cleanup so a 400 race doesn't leave the box hanging
    # around between test runs.
    try:
        await rt.remove(box.id, force=True)
    except Exception:
        pass


# ─── 5. Many sequential exec calls — exec_manager bookkeeping ───────────────


@pytest.mark.asyncio
async def test_many_sequential_execs_on_one_box(rt, image):
    """A box that's had N execs run in series must still be exec-able for
    N+1. Failure mode: exec_manager.execs map grows without bound or some
    counter wraps (cf. PR #563's drain barrier bug — surfaces on the 2nd+
    exec for short commands).

    This is a lighter regression than test_p0_6_exec_stdout_race but is
    fast (no rounds) and surfaces map-corruption / file-descriptor-leak
    failure modes that the short-stdout race doesn't catch.
    """
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        for i in range(8):
            ex = await box.exec("sh", ["-c", f"echo round-{i}"], None)
            out, _ = await drain(ex)
            result = await ex.wait()
            assert result.exit_code == 0, (
                f"round {i}: non-zero exit {result.exit_code}, out={out!r}"
            )
            assert f"round-{i}" in out, f"round {i}: stdout lost: {out!r}"
    finally:
        await rt.remove(box.id, force=True)


# ─── 6. Idempotent stop on a stopped box ────────────────────────────────────


@pytest.mark.asyncio
async def test_double_stop_is_idempotent_or_typed_409(rt, image):
    """STOP /boxes/{id}/stop twice must either be idempotent (200) or
    return 409 InvalidState. NEVER 500. (cf. PR body's known
    Stopped→500 mapping bug for the related exec-on-stopped path.)"""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    try:
        p = _profile()

        def _stop():
            req = urllib.request.Request(
                f"{p['url']}/v1/{p['path_prefix']}/boxes/{box.id}/stop",
                method="POST",
                headers={
                    "Authorization": f"Bearer {p['api_key']}",
                    "Content-Type": "application/json",
                },
                data=b"{}",
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status
            except urllib.error.HTTPError as e:
                return e.code

        s1 = _stop()
        s2 = _stop()
        assert s1 < 500, f"first stop leaked HTTP {s1}"
        assert s2 < 500, f"second stop leaked HTTP {s2}"
        # 200/204 (idempotent), 409 (invalid_state per canonical map), or
        # 400 with "state change in progress" body (racy second stop while
        # the first is still mid-transition) are all acceptable; 5xx is not.
    finally:
        # Cleanup may also race the in-flight state transition the test
        # just triggered. Tolerate the same 400 condition we just asserted
        # isn't a 5xx.
        try:
            await rt.remove(box.id, force=True)
        except Exception:
            pass
