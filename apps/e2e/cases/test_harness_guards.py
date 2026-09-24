"""Tests for the suite's own guards — no stage required.

These cover the two mechanisms that keep e2e runs from accumulating boxes in a
shared organization, both of which are otherwise invisible until they fail in
the way they are meant to prevent:

  * the lifetime this suite puts on every box it creates (`conftest`)
  * the rule that decides what `apps/e2e/sweep.py` deletes

Every case here is pure: no API, no box, no credential. They belong in this
directory anyway because they test this suite's code and must run wherever it
runs — a stage-only guard that nothing exercises is how the one-sided
lifecycle default (auto_stop=900 paired with auto_delete=600, which the SDK
rejects) got shipped in the first place.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

import boxlite
import pytest

from conftest import (
    E2E_AUTO_DELETE_SECONDS,
    E2E_AUTO_STOP_SECONDS,
    E2E_BOX_NAME_PREFIX,
    bound_box_lifetime,
    e2e_box_name,
    with_bounded_lifetime,
)

sys.path.insert(0, str(Path(__file__).parents[1]))
import sweep as sweep_mod  # noqa: E402


NOW = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def verify_runner_saw_all_boxes():
    """Override the conftest guard for this file.

    That fixture takes `rt`, which resolves credentials and exits the session
    when there is no profile — reasonable for cases that drive a stage, and
    wrong here: these create no box, so there is nothing for it to verify and
    no reason to demand a stage to run them.
    """
    yield


def _box(name: str, *, idle_minutes: float, box_id: str = "abcdefghijkl") -> dict:
    return {
        "box_id": box_id,
        "name": name,
        "status": "stopped",
        "last_activity_at": (NOW - timedelta(minutes=idle_minutes)).isoformat(),
    }


# ─── the lifetime every created box carries ─────────────────────────────────


def test_lifetime_defaults_are_applied_when_the_caller_sets_neither():
    options = boxlite.BoxOptions(image="img")
    bound_box_lifetime(options)
    assert options.auto_stop == E2E_AUTO_STOP_SECONDS
    assert options.auto_delete == E2E_AUTO_DELETE_SECONDS


@pytest.mark.parametrize("field", ["auto_stop", "auto_delete"])
def test_one_stated_window_leaves_the_other_alone(field):
    """Half a policy from the caller must not be completed with half of ours.

    `auto_delete` must be 0 or greater than `auto_stop`
    (src/boxlite/src/runtime/types.rs:299). Pairing a caller's auto_stop=900
    with our auto_delete=600 is rejected by the SDK, so the case would fail
    inside its own harness rather than on the behaviour under test.
    """
    options = boxlite.BoxOptions(image="img", **{field: 900})
    bound_box_lifetime(options)
    assert getattr(options, field) == 900
    other = "auto_delete" if field == "auto_stop" else "auto_stop"
    assert getattr(options, other) is None


def test_hand_built_body_keeps_the_window_it_states():
    """The stated value survives; the other side is still filled.

    The SDK's ordering rule does not reach a hand-built body, and the server
    accepts the pair, so completing it is what keeps the box bounded — this is
    the body of a case testing a *rejected* auto_stop, and a 4xx is not proof
    that no box was created.
    """
    body = with_bounded_lifetime({"image": "img", "auto_stop": 59})
    assert body["auto_stop"] == 59
    assert body["auto_delete"] == E2E_AUTO_DELETE_SECONDS


def test_hand_built_body_without_windows_gets_the_pair():
    body = with_bounded_lifetime({"image": "img"})
    assert body["auto_stop"] == E2E_AUTO_STOP_SECONDS
    assert body["auto_delete"] == E2E_AUTO_DELETE_SECONDS


def test_hand_built_body_is_named_for_the_sweep():
    """Both doors have to produce a sweepable name, not just the SDK one."""
    body = with_bounded_lifetime({"image": "img"})
    assert body["name"].startswith(sweep_mod.DEFAULT_NAME_PREFIX)


def test_hand_built_body_keeps_a_name_it_chose():
    body = with_bounded_lifetime({"image": "img", "name": "chosen"})
    assert body["name"] == "chosen"


# ─── what the sweep is allowed to delete ────────────────────────────────────


def test_sweep_selects_this_suite_s_stale_boxes():
    ours = _box(f"{E2E_BOX_NAME_PREFIX}deadbeef", idle_minutes=2000)
    stale, skipped = sweep_mod.select_stale([ours], NOW, 1440, E2E_BOX_NAME_PREFIX)
    assert [box for box, _ in stale] == [ours]
    assert skipped == 0


def test_sweep_leaves_a_stale_box_that_is_not_ours():
    """The case that made the prefix necessary.

    A report against dev listed `pol599-repro` and four siblings — someone's
    investigation, idle for a day, indistinguishable from a stranded box by
    age alone.
    """
    theirs = _box("pol599-repro", idle_minutes=2000)
    stale, skipped = sweep_mod.select_stale([theirs], NOW, 1440, E2E_BOX_NAME_PREFIX)
    assert stale == []
    assert skipped == 1


def test_any_name_sweeps_regardless_of_who_made_it():
    theirs = _box("pol599-repro", idle_minutes=2000)
    stale, skipped = sweep_mod.select_stale([theirs], NOW, 1440, None)
    assert [box for box, _ in stale] == [theirs]
    assert skipped == 0


def test_the_sweep_default_selects_the_names_this_suite_creates():
    """Close the loop between the two sides, which are separate literals.

    `conftest.E2E_BOX_NAME_PREFIX` names the boxes; `sweep.DEFAULT_NAME_PREFIX`
    is what CI deletes by, since the workflow passes no `--name-prefix`. They
    cannot be one constant — sweep.py runs before the `boxlite` wheel is
    installed and so must not import this package — so the agreement is
    asserted here instead of promised in a comment. Drift on either side makes
    CI's sweep match nothing and brings the quota exhaustion back.
    """
    name = e2e_box_name()
    assert name.startswith(sweep_mod.DEFAULT_NAME_PREFIX), (
        f"the suite names boxes {name!r}, which the sweep's default "
        f"{sweep_mod.DEFAULT_NAME_PREFIX!r} would not select"
    )
    stale, skipped = sweep_mod.select_stale(
        [_box(name, idle_minutes=2000)], NOW, 1440, sweep_mod.DEFAULT_NAME_PREFIX
    )
    assert len(stale) == 1 and skipped == 0


def test_a_box_inside_the_window_is_never_selected():
    fresh = _box(f"{E2E_BOX_NAME_PREFIX}deadbeef", idle_minutes=10)
    stale, skipped = sweep_mod.select_stale([fresh], NOW, 1440, E2E_BOX_NAME_PREFIX)
    assert stale == []
    assert skipped == 0


def test_a_box_with_no_timestamps_is_skipped():
    undated = {"box_id": "abcdefghijkl", "name": f"{E2E_BOX_NAME_PREFIX}x"}
    stale, skipped = sweep_mod.select_stale([undated], NOW, 1440, E2E_BOX_NAME_PREFIX)
    assert stale == []
    assert skipped == 0


# ─── a delete is not done until the box is gone ─────────────────────────────


class _StubContext:
    """Stands in for the auth context so no credential is needed."""

    def v1(self, path: str) -> str:
        return f"/v1/{path}"


class _FakeClock:
    """Advances ten seconds per reading, so the settle loop is bounded and
    deterministic instead of spinning against the wall clock."""

    def __init__(self) -> None:
        self.now = 0.0

    def monotonic(self) -> float:
        self.now += 10.0
        return self.now


@pytest.fixture
def offline_sweep(monkeypatch):
    """Point the sweep's IO and clock at stubs; yield a call recorder."""
    calls: list[str] = []
    clock = _FakeClock()
    monkeypatch.setattr(sweep_mod, "auth_context", _StubContext)
    monkeypatch.setattr(sweep_mod, "DELETE_SETTLE_SECONDS", 30)
    monkeypatch.setattr(sweep_mod.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(sweep_mod.time, "sleep", lambda _seconds: None)
    return calls


def test_waiting_ends_when_the_box_reports_not_found(monkeypatch, offline_sweep):
    replies = iter([(200, None), (404, None)])

    def request_json(method, path, *args, **kwargs):
        offline_sweep.append(path)
        return next(replies)

    monkeypatch.setattr(sweep_mod, "request_json", request_json)
    assert sweep_mod._wait_until_gone(["abcdefghijkl"]) == []
    assert offline_sweep == ["/v1/boxes/abcdefghijkl", "/v1/boxes/abcdefghijkl"]


def test_a_transport_error_is_not_read_as_gone(monkeypatch, offline_sweep):
    """A stage mid-deploy raises rather than answering.

    `request_json` lets urllib's URLError out instead of returning a status,
    and that is exactly the moment this loop exists for, so it has to keep
    polling rather than abort.
    """
    import urllib.error

    def request_json(method, path, *args, **kwargs):
        offline_sweep.append(path)
        raise urllib.error.URLError("connection reset")

    monkeypatch.setattr(sweep_mod, "request_json", request_json)
    assert sweep_mod._wait_until_gone(["abcdefghijkl"]) == ["abcdefghijkl"]
    assert offline_sweep, "the settle loop never asked the control plane"


def test_a_transient_error_is_not_read_as_gone(monkeypatch, offline_sweep):
    """A 5xx says nothing about the box; only a 404 does.

    Treating every non-200 as gone let one bad response produce the premature
    "quota is free" claim this polling exists to prevent.
    """

    def request_json(method, path, *args, **kwargs):
        offline_sweep.append(path)
        return (503, None)

    monkeypatch.setattr(sweep_mod, "request_json", request_json)
    assert sweep_mod._wait_until_gone(["abcdefghijkl"]) == ["abcdefghijkl"]
    assert offline_sweep, "the settle loop never asked the control plane"
