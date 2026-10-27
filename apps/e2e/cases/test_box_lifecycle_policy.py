"""Box lifecycle policy over REST — auto_stop / auto_delete.

Ported from E2B's cloud sandbox timeout tests
(`packages/python-sdk/tests/async/sandbox_async/test_timeout.py:10-15`), where
`set_timeout(5)` then `is_running() is False` proves the control plane really
reaps an idle sandbox. BoxLite spells the same idea as two windows measured
from last activity: `auto_stop` stops an idle box, `auto_delete` removes a
stopped one. Both checks are 10-second crons
(apps/api/src/box/managers/box.manager.ts:69,154).

Nothing else in this suite exercises them, and the suite depends on them: the
bound `conftest.bound_box_lifetime` and `conftest.with_bounded_lifetime` put on
every box a case creates is the only thing that reclaims one whose test process
died before teardown.
"""
from __future__ import annotations

import asyncio
import time

import boxlite
import pytest

from conftest import (
    E2E_AUTO_DELETE_SECONDS,
    E2E_AUTO_STOP_SECONDS,
    drain,
    with_bounded_lifetime,
)
from e2e_auth import auth_context, request_json


# The API's floor for a non-zero auto_stop (MIN_AUTO_STOP_SECONDS in
# apps/api/src/box/constants/box-lifecycle.constants.ts). Shorter windows are
# rejected because proxy traffic cannot keep them alive.
MIN_AUTO_STOP_SECONDS = 60

# Both windows are measured from the same last-activity timestamp, and the SDK
# refuses a pair that does not order (BoxLifecyclePolicy::validate,
# src/boxlite/src/runtime/types.rs:299), so the delete window has to sit past
# the stop window rather than on top of it.
AUTO_DELETE_SECONDS = 2 * MIN_AUTO_STOP_SECONDS


def _get_box(box_id: str) -> tuple[int, dict | None]:
    return request_json("GET", auth_context().v1(f"boxes/{box_id}"))


@pytest.mark.asyncio
async def test_suite_default_lifetime_reaches_every_box(rt, image):
    """A case that asks for no policy still gets one.

    `conftest.bound_box_lifetime` is the guard that stops a dead run stranding
    boxes, and it is invisible at the call site — this box is created with no
    lifecycle options at all. The assertion therefore comes from the control
    plane's own view of the box, so it fails if the wrapper stops applying the
    default, if the SDK stops sending it, or if the API stops storing it.
    """
    box = await rt.create(boxlite.BoxOptions(image=image))
    try:
        status, body = _get_box(box.id)
        assert status == 200, f"GET box returned {status}: {body}"
        assert body is not None
        assert body.get("auto_stop") == E2E_AUTO_STOP_SECONDS, (
            f"suite default auto_stop did not reach the box: {body}"
        )
        assert body.get("auto_delete") == E2E_AUTO_DELETE_SECONDS, (
            f"suite default auto_delete did not reach the box: {body}"
        )
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_lifecycle_policy_round_trips_through_rest(rt, image):
    """The windows the client asked for are the windows the box carries."""
    box = await rt.create(
        boxlite.BoxOptions(image=image, auto_stop=120, auto_delete=240),
    )
    try:
        status, body = _get_box(box.id)
        assert status == 200, f"GET box returned {status}: {body}"
        assert body is not None
        assert body.get("auto_stop") == 120, f"auto_stop not persisted: {body}"
        assert body.get("auto_delete") == 240, f"auto_delete not persisted: {body}"
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_auto_stop_below_minimum_is_rejected():
    """A window too short to be kept alive is a 400, not a silent clamp.

    Raw REST rather than the SDK: the assertion is the HTTP status and the
    message, which the SDK would rewrap into a version-dependent string.
    """
    from conftest import DEFAULT_IMAGE

    status, body = request_json(
        "POST",
        auth_context().v1("boxes"),
        with_bounded_lifetime(
            {"image": DEFAULT_IMAGE, "auto_stop": MIN_AUTO_STOP_SECONDS - 1}
        ),
    )
    assert status == 400, f"expected 400 for sub-minimum auto_stop, got {status}: {body}"
    message = str((body or {}).get("message", body))
    assert str(MIN_AUTO_STOP_SECONDS) in message, (
        f"400 body should name the {MIN_AUTO_STOP_SECONDS}s floor: {message!r}"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(300)
async def test_idle_box_auto_stops_then_auto_deletes(rt, image):
    """An idle box stops itself, and the stopped box then deletes itself.

    This is the guard the whole suite leans on, so it is tested against the
    real control plane rather than assumed. One exec first: auto-delete joins
    on the activity row (box.manager.ts:173) and never fires for a box that
    never had any activity.
    """
    box = await rt.create(
        boxlite.BoxOptions(
            image=image,
            auto_stop=MIN_AUTO_STOP_SECONDS,
            auto_delete=AUTO_DELETE_SECONDS,
        ),
    )
    removed = False
    try:
        ex = await box.exec("sh", ["-c", "echo idle-clock-starts-here"], None)
        out, _ = await drain(ex)
        await asyncio.wait_for(ex.wait(), timeout=30)
        assert "idle-clock-starts-here" in out, f"exec did not run: {out!r}"

        # Poll the control plane only — a GET on the box does not refresh
        # lastActivityAt (only the proxy paths do, boxlite-proxy.controller.ts:253),
        # so polling cannot keep the box alive and hide the very reaping under test.
        deadline = time.monotonic() + 240
        statuses: list[str] = []
        while time.monotonic() < deadline:
            status, body = _get_box(box.id)
            if status == 404:
                removed = True
                break
            assert status == 200, f"GET box returned {status}: {body}"
            state = str((body or {}).get("status"))
            if not statuses or statuses[-1] != state:
                statuses.append(state)
            await asyncio.sleep(5)

        assert removed, (
            "box was neither stopped nor deleted within 240s of its last "
            f"activity with auto_stop={MIN_AUTO_STOP_SECONDS}s, "
            f"auto_delete={AUTO_DELETE_SECONDS}s; states seen: {statuses}"
        )
        assert "stopped" in statuses, (
            f"box vanished without ever being observed stopped: {statuses}"
        )
    finally:
        if not removed:
            try:
                await rt.remove(box.id, force=True)
            except Exception:
                pass
