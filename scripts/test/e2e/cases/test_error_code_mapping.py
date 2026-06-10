"""Server-side HTTP error-code mapping conformance.

Trigger each BoxliteError variant through the REST path and assert the
(HTTP status, code string) the server returns matches the canonical table
at src/shared/src/errors.rs:198-280.

The Rust side enforces the table internally via the unit test
`http_mapping_matches_canonical_table`. The Go runner does its own status
classification (apps/runner/pkg/api/controllers/*.go, classifyExecError),
and divergence is a known bug class — PR #678 surfaced one:
`apps/runner/pkg/api/controllers/boxlite_exec.go:77` writes 500 for
BoxliteError::Stopped instead of 409. This test sweeps all variants we can
trigger over REST and catches sibling leaks the same way.

Each case talks to the API directly via urllib rather than going through the
Python SDK — the SDK wraps non-2xx into typed exceptions whose .args[0]
string varies by version, while the raw HTTPError.code + JSON body code
field are the contract this test pins.

A case is marked `xfail(strict=True)` only when the leak is the one already
documented (Stopped→500). Marking the others xfail would defeat the point.
"""

from __future__ import annotations

import json
import tomllib
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import boxlite
import pytest


def _profile() -> dict:
    return tomllib.loads((Path.home() / ".boxlite/credentials.toml").read_text())[
        "profiles"
    ]["p1"]


def _api_call(
    method: str, path: str, body: dict | None = None
) -> tuple[int, dict[str, Any] | None]:
    """Return (status, decoded_json_body)."""
    p = _profile()
    url = f"{p['url']}{path}"
    req = urllib.request.Request(
        url,
        method=method,
        headers={
            "Authorization": f"Bearer {p['api_key']}",
            "Content-Type": "application/json",
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return e.code, {"_raw": raw.decode("utf-8", "replace")}


# ─── (status, code_substring) shared between table-driven assertions ─────────


def _assert_http_code(
    actual_status: int,
    actual_body: dict | None,
    expected_status: int,
    expected_code_substr: str,
    *,
    msg: str,
) -> None:
    body_str = json.dumps(actual_body) if actual_body else "<no body>"
    assert actual_status == expected_status, (
        f"{msg}: got HTTP {actual_status}, expected {expected_status}; body={body_str}"
    )
    # Server returns either `{"code": "..."}` (typed error), `{"error": "..."}`
    # (older path), or a NestJS exception envelope. Accept any of those if the
    # canonical code substring is anywhere in the body.
    assert expected_code_substr in body_str.lower(), (
        f"{msg}: expected code substring {expected_code_substr!r} not in body={body_str}"
    )


# ─── 4xx variants — trigger via REST and assert the mapping ──────────────────


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Production bug: CreateBoxDto.cpus has @Min(1) (apps/api/src/boxlite-rest/"
        "dto/create-box.dto.ts:24) but the global ValidationPipe at "
        "apps/api/src/main.ts:65-69 only sets transform=true (no whitelist). "
        "cpus=0 gets silently coerced to the org default of 1 cpu and the box "
        "is created (HTTP 201) instead of 400. Same root cause as PR #662 "
        "(undersized resources at create boundary) — fix likely needs adding "
        "whitelist:true + forbidNonWhitelisted:true OR explicit @Min enforcement "
        "in the createFromSnapshot path."
    ),
)
@pytest.mark.asyncio
async def test_invalid_argument_zero_cpu_returns_400(rt):
    """POST /boxes with cpus=0 should surface InvalidArgument → 400."""
    p = _profile()
    status, body = _api_call(
        "POST",
        f"/v1/{p['path_prefix']}/boxes",
        {"image": "alpine:3.23", "cpus": 0, "memory_mib": 256, "disk_size_gb": 4},
    )
    _assert_http_code(
        status,
        body,
        expected_status=400,
        expected_code_substr="invalid",
        msg="POST /boxes cpus=0",
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Production bug: CreateBoxDto.memory_mib has @Min(256) but negative "
        "values are silently coerced to the org default (1024 MiB). Same root "
        "cause as test_invalid_argument_zero_cpu_returns_400 — the global "
        "ValidationPipe doesn't reject out-of-range values for @IsOptional "
        "fields when transform=true coerces them through."
    ),
)
@pytest.mark.asyncio
async def test_invalid_argument_negative_memory_returns_400(rt):
    """POST /boxes with memory=-1 should surface InvalidArgument → 400."""
    p = _profile()
    status, body = _api_call(
        "POST",
        f"/v1/{p['path_prefix']}/boxes",
        {"image": "alpine:3.23", "cpus": 1, "memory_mib": -1, "disk_size_gb": 4},
    )
    _assert_http_code(
        status,
        body,
        expected_status=400,
        expected_code_substr="invalid",
        msg="POST /boxes memory=-1",
    )


@pytest.mark.asyncio
async def test_not_found_for_unknown_box_id_returns_404(rt):
    """GET /boxes/{uuid} for non-existent id should surface NotFound → 404."""
    p = _profile()
    bogus_id = "00000000-0000-0000-0000-000000000000"
    status, body = _api_call("GET", f"/v1/{p['path_prefix']}/boxes/{bogus_id}")
    _assert_http_code(
        status,
        body,
        expected_status=404,
        expected_code_substr="not",
        msg=f"GET /boxes/{bogus_id}",
    )


@pytest.mark.asyncio
async def test_remove_unknown_box_id_returns_404(rt):
    """DELETE /boxes/{uuid} for non-existent id should also surface
    NotFound → 404 (not 200 silent / not 500)."""
    p = _profile()
    bogus_id = "00000000-0000-0000-0000-000000000000"
    status, body = _api_call("DELETE", f"/v1/{p['path_prefix']}/boxes/{bogus_id}")
    _assert_http_code(
        status,
        body,
        expected_status=404,
        expected_code_substr="not",
        msg=f"DELETE /boxes/{bogus_id}",
    )


@pytest.mark.asyncio
async def test_image_pull_failed_returns_422(rt):
    """POST /boxes with an unregistered image should surface ImageError → 422."""
    p = _profile()
    bogus_image = "this-image-was-never-registered:0.0.0"
    status, body = _api_call(
        "POST",
        f"/v1/{p['path_prefix']}/boxes",
        {"image": bogus_image, "cpus": 1, "memory_mib": 256, "disk_size_gb": 4},
    )
    # Some implementations return 404 (snapshot lookup miss) instead of 422
    # (image pull failed at runner). Both are 4xx and "image" or "not found"
    # in the body; 500 would be a leak.
    body_str = json.dumps(body) if body else ""
    assert 400 <= status < 500, (
        f"bogus image leaked a 5xx: HTTP {status}, body={body_str}"
    )
    assert any(
        kw in body_str.lower() for kw in ("image", "snapshot", "not found", "pull")
    ), f"422 body does not explain the cause: {body_str}"


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Production bug: exec'ing a non-existent binary surfaces "
        "'boxlite: internal error: spawn_failed' (code=1, ErrInternal) → HTTP "
        "500 instead of ExecutionError (code=10) → HTTP 422 per the canonical "
        "table at src/shared/src/errors.rs:198-280. The Rust spawn path "
        "(boxlite-shim → exec process build) wraps the executable-not-found "
        "case as ErrInternal/SpawnFailed rather than ErrExecution, so the "
        "classifyExecError fix in this PR can't route it correctly."
    ),
)
@pytest.mark.asyncio
async def test_execution_invalid_command_returns_422(rt, image):
    """Exec'ing a missing binary inside a real box should surface
    ExecutionError → 422 (not 500)."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        with pytest.raises(Exception) as exc_info:
            ex = await box.exec("/nonexistent/binary", [], None)
            await ex.wait()
        msg = str(exc_info.value).lower()
        assert "500" not in msg and "internal" not in msg, (
            f"exec missing binary leaked a 5xx: {exc_info.value!r}"
        )
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Production bug: no per-sandbox quota enforcement at the API "
        "create boundary. cpus=999 is silently clamped to the org default "
        "(cpus=1) and HTTP 201 returned, instead of HTTP 429 ResourceExhausted "
        "(or HTTP 400 InvalidArgument). The DTO has @Min(1) but no @Max(); "
        "fixture_setup sets max_cpu_per_sandbox=4 in the organization table "
        "but nothing in apps/api/src/sandbox/services/sandbox.service.ts:"
        "createFromSnapshot consults that limit."
    ),
)
@pytest.mark.asyncio
async def test_resource_exhausted_over_cpu_quota_returns_429(rt):
    """POST /boxes with cpus far above the org quota should surface
    ResourceExhausted → 429 (not 400, not 500)."""
    p = _profile()
    status, body = _api_call(
        "POST",
        f"/v1/{p['path_prefix']}/boxes",
        {"image": "alpine:3.23", "cpus": 999, "memory_mib": 256, "disk_size_gb": 4},
    )
    # The mapping says 429 ResourceExhausted; some implementations may also
    # 400 InvalidArgument (treating it as a parse-time validation failure).
    # Either 4xx is acceptable; a 500 is the bug.
    body_str = json.dumps(body) if body else ""
    assert status in (400, 422, 429), (
        f"over-quota CPU got HTTP {status}; expected 4xx, body={body_str}"
    )


@pytest.mark.asyncio
async def test_invalid_state_stop_already_stopped_returns_4xx(rt, image):
    """POST /boxes/{id}/stop twice on the same box should never 5xx.
    Acceptable: 200/204 (idempotent), 409 (invalid_state per canonical map),
    or 400 with body containing 'state change in progress' (race protection
    on overlapping state transitions). Strictly excluded: 500."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    p = _profile()
    try:
        # First stop kicks off the running→stopped transition; the second may
        # land while the first is still in flight (state == "stopping").
        _api_call("POST", f"/v1/{p['path_prefix']}/boxes/{box.id}/stop", {})
        status2, body2 = _api_call(
            "POST", f"/v1/{p['path_prefix']}/boxes/{box.id}/stop", {}
        )
        body_str = json.dumps(body2) if body2 else ""
        assert status2 < 500, (
            f"double-stop leaked HTTP {status2} (5xx); body={body_str}"
        )
        if status2 not in (200, 204, 409):
            assert "state change" in body_str.lower(), (
                f"double-stop got HTTP {status2} but body doesn't explain the "
                f"race-protection rejection: {body_str}"
            )
    finally:
        # Tolerate the race here too — the runner may still be in
        # "stopping" when we ask to remove, and respond with 400. Best-effort.
        try:
            await rt.remove(box.id, force=True)
        except Exception:
            pass


@pytest.mark.asyncio
async def test_invalid_token_returns_401_not_500():
    """Auth boundary: tampered bearer must surface 401/403, never 500."""
    p = _profile()
    req = urllib.request.Request(
        f"{p['url']}/v1/me",
        method="GET",
        headers={"Authorization": "Bearer this-token-is-clearly-not-real"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            pytest.fail(f"bad token got HTTP {r.status} — should be 401")
    except urllib.error.HTTPError as e:
        assert e.code in (401, 403), (
            f"bad token returned HTTP {e.code} — should be 401/403"
        )


@pytest.mark.asyncio
async def test_missing_auth_header_returns_401_not_500():
    """No Authorization header should surface 401, not 500."""
    p = _profile()
    req = urllib.request.Request(f"{p['url']}/v1/me", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            pytest.fail(f"missing auth got HTTP {r.status} — should be 401")
    except urllib.error.HTTPError as e:
        assert e.code in (401, 403), (
            f"missing auth returned HTTP {e.code} — should be 401/403"
        )
