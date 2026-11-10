"""
Disk-expansion chain verification against a live GCP stage.

The chain under test and where each segment is verified
--------------------------------------------------------
The data disk expansion chain spans four layers, and no single test level can
see all of them:

1. API water-level decision + budget/cooldown gates      → apps/api specs (jest)
2. GCP disks.update call semantics                        → gcp-disk-client.spec.ts
3. Host device growth → sysfs → resize2fs (the runner)   → diskresize integration
   tests (apps/runner/internal/diskresize/, Linux-only: loop + image layers)
4. The whole chain on a real GCP stage                    → THIS FILE

This file covers segment 4 only, and deliberately: segments 1-3 already have
their own fast layers. What a live stage can answer that nothing else can: the
GCP platform promise (a disks.resize call makes the host NVMe device follow),
the resize actually reaching the runner's reported capacity, and the
coordinated behavior of all three services against real cloud state.

Test flow (the one test here, opt-in)
--------------------------------------
0. Prerequisite, done OUTSIDE this test by an operator or a runbook script:
   a real grow of the target runner's data disk via gcloud's `disks.resize`
   (the API service itself grows disks through `disks.update` with a sizeGb
   mask — two spellings of the same size change, used by different actors).
   The test does NOT call the GCP API itself — expansion is rate-limited
   (hyperdisk allows 2 resizes per disk per 4-hour window) and costs quota,
   so triggering it belongs to the operator, not to an automated test.
1. Read the runner over admin REST (GET /admin/runners/<id>) and assert the
   reported `disk` (the healthcheck-sourced diskGiB) reflects the new size.
2. The chain this single assertion closes: GCP grew the disk → the host NVMe
   device followed (GCP promise) → the diskresize ticker saw the growth
   (10s cadence) → resize2fs grew the filesystem → the next healthcheck
   reported the new diskGiB → the API stored it → admin REST exposes it.

Keys and gates
---------------
- Opt-in via environment, so ordinary stage runs never touch GCP quota:
  BOXLITE_E2E_EXPANDED_DISK_RUNNER_ID   the runner that received the resize
  BOXLITE_E2E_EXPANDED_DISK_TARGET_GIB  the size the disk was resized to
- Both unset → pytest.skip with the setup hint.
- Credentials: the admin runner endpoint requires an ADMIN-role API key
  (@RequiredApiRole([SystemRole.ADMIN]) + SystemActionGuard); a non-admin key
  fails loudly on the first GET with a 403.
- The target must be strictly larger than the pre-resize size: the assertion
  is `disk >= target`, so a target at or below the current size trivially
  passes without proving anything.
- Timeout: diskresize ticks every 10s (DefaultInterval), resize2fs of tens of
  GiB takes seconds-to-minutes, healthcheck cadence adds another minutes-scale
  lag — the poll budget is 10 minutes, generous but finite. Note the CI legs
  run pytest with --timeout=180; enabling this test under that command line
  requires raising that per-test timeout, or the test dies at 180s before its
  own budget applies.
- The poll loop does not tolerate transient network errors: request_json only
  converts HTTP errors into (status, body) — a URLError mid-poll fails the
  test outright. Accepted deliberately for a 600s read-only poll, since a
  stage flaky enough to drop one request in ten minutes deserves the noise.
- Observation point note: admin REST exposes diskGiB (`disk`) but has no
  dataDiskRef read path today; the dataDiskRef reporting contract is covered
  by apps/api specs instead. If a later change exposes dataDiskRef over REST,
  a dataDiskRef shape assertion belongs here.

Marker: e2e (default), not smoke — a smoke leg must stay safe against a
paying stage without operator setup, and this test needs one.
"""

from __future__ import annotations

import os
import time

import pytest

from e2e_auth import request_json

# Poll budget for the expansion to travel: diskresize ticker (10s) + resize2fs
# (seconds-to-minutes) + healthcheck cadence (minutes-scale) + API persistence.
EXPANSION_PROPAGATION_BUDGET_SECONDS = 600

# Poll cadence: every runner healthcheck overwrites diskGiB; a 15s cadence is
# well under both the ticker interval and the healthcheck period, so the test
# cannot miss the settled state.
POLL_INTERVAL_SECONDS = 15


def _expansion_target() -> tuple[str, int]:
    """Return the (runner_id, target_gib) gate pair, or skip with the hint."""
    runner_id = os.environ.get("BOXLITE_E2E_EXPANDED_DISK_RUNNER_ID")
    target = os.environ.get("BOXLITE_E2E_EXPANDED_DISK_TARGET_GIB")
    if not runner_id or not target:
        pytest.skip(
            "live disk-expansion verification is opt-in: run a real disks.resize "
            "against the runner's data disk first (rate-limited: 2 per disk per "
            "4h window), then set BOXLITE_E2E_EXPANDED_DISK_RUNNER_ID and "
            "BOXLITE_E2E_EXPANDED_DISK_TARGET_GIB"
        )
    return runner_id, int(target)


@pytest.mark.e2e
def test_data_disk_growth_reaches_the_healthcheck():
    """Close the chain: real resize → host device → fs → healthcheck → REST."""
    runner_id, target_gib = _expansion_target()

    deadline = time.monotonic() + EXPANSION_PROPAGATION_BUDGET_SECONDS
    last_seen: int | None = None
    while time.monotonic() < deadline:
        status, body = request_json("GET", f"/admin/runners/{runner_id}")
        assert status == 200, f"GET /admin/runners/{runner_id} returned {status}: {body}"
        disk = (body or {}).get("disk")
        assert isinstance(disk, int), f"admin runner payload lacks an integer disk field: {body}"
        last_seen = disk
        if disk >= target_gib:
            return
        time.sleep(POLL_INTERVAL_SECONDS)

    pytest.fail(
        f"diskGiB never reached {target_gib} within "
        f"{EXPANSION_PROPAGATION_BUDGET_SECONDS}s (last seen: {last_seen}). "
        "Check: did the host NVMe device follow the resize? did the diskresize "
        "ticker log 'Data disk filesystem resized'? did healthcheck report it?"
    )
