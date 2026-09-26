"""Cross-organisation resource isolation tests.

Verifies that one organisation's credentials cannot observe or manipulate
another organisation's resources.

## Setup

These tests need **two** distinct organisations.  The primary org comes from
the standard e2e credentials (``BOXLITE_E2E_PROFILE`` / ``p1``).  The second
org's credentials must be supplied via environment variables:

    BOXLITE_E2E_CROSS_ORG_API_KEY   – API key belonging to a different org
    BOXLITE_E2E_CROSS_ORG_PREFIX    – path_prefix for that org
                                      (discovered automatically when unset,
                                       provided the key has /v1/me access)

When ``BOXLITE_E2E_CROSS_ORG_API_KEY`` is absent the module is skipped, and
the skip is *announced* on stderr rather than silent.  Set
``BOXLITE_E2E_REQUIRE_CROSS_ORG=1`` (as ``.github/workflows/e2e-cloud.yml``
does) to turn that skip into a collection error instead, so a missing secret
fails the job rather than quietly reducing coverage to zero.

## Two distinct vectors

`OrganizationAccessGuard` derives the effective org from the ``:prefix`` route
param and compares it against the API key's own org
(`organization-access.guard.ts:54-64`).  That gives cross-org access two
separate failure modes, and both are asserted here:

* **Foreign namespace** — ``/v1/{prefix-A}/...`` with org-B's key.  The guard's
  mismatch branch returns false → **403**.  This is the vector the PR
  description names, and the only one that would catch a regression exposing
  org-A's resources inside org-A's own URL space.
* **Own namespace, foreign id** — ``/v1/{prefix-B}/boxes/{box-A-id}`` with
  org-B's key.  The guard passes, and the lookup is scoped by
  ``authContext.organizationId`` (`boxlite-box.controller.ts:145`), so the row
  is not found → **404**, not 403.  404 is required rather than 403 so the API
  does not leak the *existence* of another org's resources.

## What is tested

* org-B's key in org-A's namespace → 403 (list, get, delete, exec).
* org-B's key in its own namespace against org-A's box id → 404.
* A cross-org DELETE leaves org-A's box materially untouched — asserted on the
  box body, not on the status code (a soft delete never changes ``state``, so
  a status-code-only check would pass on exactly the input where the box was
  destroyed).
* org-B cannot open a network tunnel to org-A's box, while org-A can — the
  positive control makes a broken setup distinguishable from a real breach.
"""
from __future__ import annotations

import asyncio
import base64
import inspect
import json
import os
import shlex
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import boxlite
import pytest
import pytest_asyncio

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from e2e_auth import auth_context, discover_path_prefix, E2EAuthContext

from conftest import _TrackingRuntime, drain

# ---------------------------------------------------------------------------
# Gate the module on cross-org credentials — loudly
# ---------------------------------------------------------------------------

_CROSS_ORG_KEY = os.environ.get("BOXLITE_E2E_CROSS_ORG_API_KEY", "").strip()
_REQUIRED = os.environ.get("BOXLITE_E2E_REQUIRE_CROSS_ORG", "").lower() in (
    "1", "true", "yes", "on",
)

_SKIP_REASON = (
    "Cross-org isolation tests require BOXLITE_E2E_CROSS_ORG_API_KEY. "
    "Set it to a valid API key from a different organisation to run."
)

if not _CROSS_ORG_KEY:
    if _REQUIRED:
        # Collection error, not a skip: BOXLITE_E2E_REQUIRE_CROSS_ORG says the
        # caller expects these to run, so a missing key is a broken job, not
        # reduced coverage.
        raise RuntimeError(
            f"BOXLITE_E2E_REQUIRE_CROSS_ORG is set but {_SKIP_REASON}"
        )
    # An unannounced skip is how this module previously reported green while
    # executing nothing at all.
    print(f"\n[cross-org] SKIPPING {__name__}: {_SKIP_REASON}", file=sys.stderr)

pytestmark = pytest.mark.skipif(not _CROSS_ORG_KEY, reason=_SKIP_REASON)

_TUNNEL_PORT = 19527
_TUNNEL_MARKER = b"cross-org-isolation-e2e"
_SERVICE_FIXTURE = Path(__file__).parents[1] / "fixtures" / "service_in_box_server.py"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class TransportError(RuntimeError):
    """A request never produced an HTTP status (DNS, reset, timeout).

    Distinguished from an HTTP error response so a network fault can never be
    mistaken for "the server rejected us", which is what these tests assert.
    """


def _request(
    method: str,
    url: str,
    token: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: int = 30,
) -> tuple[int, Any]:
    """Return (status_code, parsed_body_or_None).

    Raises `TransportError` when no HTTP response was received at all —
    `urllib.error.URLError` and socket timeouts are *not* HTTPError subclass
    territory and would otherwise escape as a raw traceback out of a fixture.
    """
    headers: dict[str, str] = {"Authorization": f"Bearer {token}"}
    data: bytes | None = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, (json.loads(raw) if raw else None)
        except json.JSONDecodeError:
            return exc.code, {"_raw": raw.decode("utf-8", "replace")}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise TransportError(f"{method} {url} produced no HTTP response: {exc!r}") from exc


def _prefixed(ctx: E2EAuthContext, prefix: str, path: str) -> str:
    """Absolute URL for *path* under an explicit *prefix* (may be empty)."""
    path = path.lstrip("/")
    return ctx.url_for(f"/v1/{prefix}/{path}" if prefix else f"/v1/{path}")


async def _close_runtime(runtime) -> None:
    if not hasattr(runtime, "close"):
        return
    try:
        close = runtime.close()
        if inspect.isawaitable(close):
            await close
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def org_a_ctx() -> E2EAuthContext:
    """Auth context for the primary (org-A) organisation."""
    return auth_context()


@pytest.fixture(scope="module")
def org_a_prefix(org_a_ctx: E2EAuthContext) -> str:
    """org-A's path prefix, or skip.

    Every foreign-namespace assertion below depends on a ``:prefix`` route
    param existing.  Without one the guard has no `organizationIdParam` to
    compare, falls through to the caller's own org, and answers 200 with
    org-B's own data — a pass that proves nothing.  Requiring the prefix makes
    the deployment shape these tests need explicit.
    """
    if not org_a_ctx.path_prefix:
        pytest.skip(
            "org-A has no path_prefix: cross-org namespace isolation is only "
            "observable on a prefix-routed (multi-tenant) deployment."
        )
    return org_a_ctx.path_prefix


@pytest.fixture(scope="module")
def org_b_token() -> str:
    return _CROSS_ORG_KEY


@pytest.fixture(scope="module")
def org_b_prefix(org_a_ctx: E2EAuthContext, org_b_token: str) -> str:
    explicit = os.environ.get("BOXLITE_E2E_CROSS_ORG_PREFIX", "").strip()
    if explicit:
        return explicit
    # The shared helper raises on a non-200 /v1/me and uses `or ""` rather than
    # a `.get(..., "")` default, so an expired key or an explicit
    # `"path_prefix": null` cannot degrade into a silently empty prefix.
    return discover_path_prefix(org_a_ctx.url, org_b_token)


@pytest_asyncio.fixture(scope="module")
async def org_b_rt(org_a_ctx: E2EAuthContext, org_b_token: str, org_b_prefix: str):
    """REST Boxlite runtime for org-B.

    Wrapped in conftest's `_TrackingRuntime` for consistency with the rest of
    the suite.  Note the autouse `verify_runner_saw_all_boxes` guard only
    inspects the session-scoped `rt`, so org-A's boxes here are path-verified
    (they go through `rt`) while this runtime's are not — it never creates one.
    """
    opts = boxlite.BoxliteRestOptions(
        url=org_a_ctx.url,
        credential=boxlite.ApiKeyCredential(org_b_token),
        path_prefix=org_b_prefix,
    )
    runtime = boxlite.Boxlite.rest(opts)
    yield _TrackingRuntime(runtime)
    await _close_runtime(runtime)


@pytest.fixture(scope="module")
def org_a_box(org_a_ctx: E2EAuthContext, image: str):
    """A running box in org-A, shared across this module's resource tests.

    Created via raw HTTP so this fixture is independent of SDK version.
    Returns a namespace with ``.id`` and the ``.name`` recorded at creation —
    the DELETE test compares against that baseline.

    `auto_delete` is set so that a create which times out *after* the API
    persisted the row (POST returns before `waitForStarted` completes) is
    reaped server-side rather than leaked: on that path we never learn the id
    and cannot clean it up ourselves.
    """
    import types

    box_id = None
    try:
        url = _prefixed(org_a_ctx, org_a_ctx.path_prefix, "boxes")
        status, body = _request(
            "POST", url, token=org_a_ctx.token,
            body={"image": image, "auto_delete": 600, "auto_stop": 300},
        )
        assert status == 201, f"Failed to create org-A box: {status} {body}"
        box_id = body["box_id"]
        yield types.SimpleNamespace(id=box_id, name=body.get("name"))
    finally:
        if box_id is not None:
            del_url = _prefixed(org_a_ctx, org_a_ctx.path_prefix, f"boxes/{box_id}")
            try:
                _request("DELETE", del_url, token=org_a_ctx.token)
            except TransportError:
                pass  # auto_delete reaps it


async def _start_marker_service(box) -> str:
    """Start the shared HTTP fixture in *box* and return its pid.

    Uses `python3` (present in `apps/box-images/base.Dockerfile`) rather than
    netcat (absent), and `>… 2>&1 &` rather than the bashism `&>` — the
    program is `/bin/sh`, which is dash on Debian.
    """
    encoded = base64.b64encode(_SERVICE_FIXTURE.read_bytes()).decode()
    code = f"import base64;exec(base64.b64decode({encoded!r}))"
    ex = await box.exec(
        "sh",
        [
            "-lc",
            f"python3 -u -c {shlex.quote(code)} {_TUNNEL_PORT} "
            f"{_TUNNEL_MARKER.decode()} >/tmp/cross-org-{_TUNNEL_PORT}.log 2>&1 & echo $!",
        ],
    )
    out, err = await asyncio.wait_for(drain(ex), timeout=30)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, f"failed to start marker service: {err}"
    return out.strip()


async def _fetch_marker_over_tunnel(box, port: int) -> bytes:
    tunnel = await box.network.tunnel(port)
    connection = await tunnel.connect()
    response = bytearray()
    try:
        await connection.write(
            b"GET /marker.txt HTTP/1.0\r\nHost: cross-org.test\r\n\r\n",
        )
        while len(response) < 64 * 1024:
            chunk = await asyncio.wait_for(connection.read(8192), timeout=5)
            if not chunk:
                break
            response.extend(chunk)
            if _TUNNEL_MARKER in response:
                break
        return bytes(response)
    finally:
        await connection.close()


async def _await_marker_over_tunnel(box, port: int, *, timeout: float = 30.0) -> bytes:
    """Poll `_fetch_marker_over_tunnel` until the marker shows up.

    `_start_marker_service` returns as soon as `sh` reports the background
    pid, which is before `python3` has bound *port*.  A single fetch can
    therefore connect to a closed port and read nothing, failing the positive
    control for a timing reason rather than a reachability one.

    The last response and the last error are both carried out so a genuine
    failure (tunnel refused, service crashed) stays diagnosable instead of
    surfacing as an empty read.
    """
    deadline = asyncio.get_running_loop().time() + timeout
    response = b""
    last_error: BaseException | None = None
    while True:
        try:
            response = await _fetch_marker_over_tunnel(box, port)
            last_error = None
            if _TUNNEL_MARKER in response:
                return response
        except (OSError, asyncio.TimeoutError, RuntimeError) as exc:
            last_error = exc
            response = b""
        if asyncio.get_running_loop().time() >= deadline:
            break
        await asyncio.sleep(0.5)
    if last_error is not None:
        raise AssertionError(
            f"marker service in box {box.id} never became reachable over its "
            f"own tunnel within {timeout}s; last error: {last_error!r}"
        ) from last_error
    return response


# ---------------------------------------------------------------------------
# Tests — foreign namespace (403)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method,path_tmpl,body",
    [
        ("GET", "boxes", None),
        ("GET", "boxes/{box_id}", None),
        ("DELETE", "boxes/{box_id}", None),
        ("POST", "boxes/{box_id}/exec", {"command": "/bin/sh", "args": ["-c", "id"]}),
    ],
    ids=["list", "get", "delete", "exec"],
)
async def test_org_b_key_rejected_in_org_a_namespace(
    org_a_ctx: E2EAuthContext,
    org_a_prefix: str,
    org_b_token: str,
    org_a_box,
    method: str,
    path_tmpl: str,
    body: dict[str, Any] | None,
):
    """org-B's key must be rejected in org-A's URL namespace.

    This is the vector that matters: a regression exposing org-A's resources
    inside org-A's own prefix would be invisible to a probe sent to org-B's
    prefix.  `OrganizationAccessGuard` returns false on the org mismatch, so
    Nest answers 403 (401 is accepted too — the distinction is the auth layer's
    to make, and either way access was denied).

    The exec body is a valid `ExecRequest` (`required: [command]`,
    `openapi/box.openapi.yaml:2140`) so that a rejection here is an
    authorization decision and not a 422 from body validation.
    """
    url = _prefixed(org_a_ctx, org_a_prefix, path_tmpl.format(box_id=org_a_box.id))
    status, payload = _request(method, url, token=org_b_token, body=body)
    assert status in (401, 403), (
        f"Expected 401/403 for {method} {path_tmpl} in org-A's namespace with "
        f"org-B's key, got {status} {payload!r}. A valid key from another org "
        "must be rejected in a foreign namespace."
    )


# ---------------------------------------------------------------------------
# Tests — own namespace, foreign id (404, no existence leak)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method,path_tmpl,body",
    [
        ("GET", "boxes/{box_id}", None),
        ("POST", "boxes/{box_id}/exec", {"command": "/bin/sh", "args": ["-c", "id"]}),
    ],
    ids=["get", "exec"],
)
async def test_org_a_box_is_not_found_in_org_b_namespace(
    org_a_ctx: E2EAuthContext,
    org_b_token: str,
    org_b_prefix: str,
    org_a_box,
    method: str,
    path_tmpl: str,
    body: dict[str, Any] | None,
):
    """org-A's box id must read as *non-existent* inside org-B's namespace.

    404 rather than 403: the lookup is org-scoped, so org-B must not be able to
    tell org-A's box id apart from a string that was never a box.
    """
    url = _prefixed(org_a_ctx, org_b_prefix, path_tmpl.format(box_id=org_a_box.id))
    status, payload = _request(method, url, token=org_b_token, body=body)
    assert status == 404, (
        f"Expected 404 for {method} {path_tmpl} on org-A's box "
        f"{org_a_box.id} from org-B's namespace, got {status} {payload!r}. "
        "Existence must be indistinguishable: 404, not 403/401/200."
    )


@pytest.mark.asyncio
async def test_cross_org_delete_leaves_org_a_box_intact(
    org_a_ctx: E2EAuthContext,
    org_a_prefix: str,
    org_b_token: str,
    org_b_prefix: str,
    org_a_box,
):
    """A cross-org DELETE must not touch org-A's box.

    Deliberately asserted on the box *body*, not on the DELETE status code.
    `boxService.destroy` applies `Box.getSoftDeleteUpdate`
    (`box.entity.ts:203-209`) = `{pending, desiredState: DESTROYED, name:
    'DESTROYED_…'}` and never writes `state`; the read path filters on
    `state: Not(DESTROYED)` (`box.service.ts:654`), so a destroyed box still
    answers 200 with `status: started`.  A status-code-only check would report
    "isolation holds" on exactly the input where the box was destroyed.

    Both DELETE vectors are attempted before the box is inspected, so the
    inspection runs regardless of how either one is answered.
    """
    box_id = org_a_box.id
    outcomes = {}
    for label, prefix in (("own-namespace", org_b_prefix), ("org-a-namespace", org_a_prefix)):
        url = _prefixed(org_a_ctx, prefix, f"boxes/{box_id}")
        outcomes[label] = _request("DELETE", url, token=org_b_token)[0]

    get_url = _prefixed(org_a_ctx, org_a_ctx.path_prefix, f"boxes/{box_id}")
    get_status, box = _request("GET", get_url, token=org_a_ctx.token)

    assert get_status == 200, (
        f"org-A's box {box_id} is gone after cross-org DELETE attempts "
        f"{outcomes}: HTTP {get_status}"
    )
    assert not str(box.get("name") or "").startswith("DESTROYED_"), (
        f"org-A's box {box_id} was soft-deleted by a cross-org DELETE "
        f"{outcomes}: name is now {box.get('name')!r}. The row survives the "
        "read filter, so only the name/pending fields expose the breach."
    )
    if org_a_box.name is not None:
        assert box.get("name") == org_a_box.name, (
            f"org-A's box name changed after cross-org DELETE attempts "
            f"{outcomes}: {org_a_box.name!r} → {box.get('name')!r}"
        )
    assert outcomes["own-namespace"] == 404, (
        f"DELETE from org-B's own namespace should 404, got "
        f"{outcomes['own-namespace']}"
    )
    assert outcomes["org-a-namespace"] in (401, 403), (
        f"DELETE in org-A's namespace with org-B's key should 401/403, got "
        f"{outcomes['org-a-namespace']}"
    )


# ---------------------------------------------------------------------------
# Tests — network reachability
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cross_org_cannot_tunnel_into_org_a_box(
    rt,
    org_a_ctx: E2EAuthContext,
    org_a_prefix: str,
    org_b_rt,
    org_b_token: str,
    org_b_prefix: str,
    image: str,
):
    """org-B must not be able to reach a service inside org-A's box.

    The reachable surface between an org and a box is the control-plane
    tunnel (`POST /{prefix}/boxes/{box_id}/network/tunnel`), not in-guest
    networking: every box gets `GUEST_IP` 192.168.127.2 in its own netstack
    (`src/boxlite/src/net/constants.rs`) and a constant `boxlite` hostname
    (`src/guest/src/container/start.rs:71`), so there are no per-box addresses
    for one box to dial and nothing for a same-host probe to prove.

    Shape is control-then-denial, so a broken setup cannot masquerade as
    isolation:

    1. **Positive control** — org-A opens a tunnel to its own box and reads the
       marker.  If this fails the test fails; it never silently degrades into
       an assertion that empty output contains no secret.
    2. **Denial** — org-B cannot get a handle on that box id, and both raw
       tunnel vectors are refused.

    org-A's box goes through the session `rt`, so the autouse
    `verify_runner_saw_all_boxes` guard proves it actually reached the runner.
    """
    box_a = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        await _start_marker_service(box_a)

        # 1. Positive control: the service is up and reachable by its owner.
        #    Polled: the fixture binds the port after `_start_marker_service`
        #    has already returned the pid.
        response = await _await_marker_over_tunnel(box_a, _TUNNEL_PORT)
        assert _TUNNEL_MARKER in response, (
            "positive control failed: org-A could not reach its own service in "
            f"box {box_a.id} over its own tunnel, so the denial below would "
            f"prove nothing. Response: {response[:512]!r}"
        )

        # 2a. org-B's runtime cannot even resolve the box: `get` is org-scoped,
        #     so it must not hand back a usable handle.  The REST runtime
        #     signals this by raising rather than returning None, so both
        #     shapes are accepted — what matters is that no handle comes back.
        try:
            resolved = await org_b_rt.get(box_a.id)
        except Exception as exc:  # noqa: BLE001 — SDK raises a bare RuntimeError
            assert "not found" in str(exc).lower(), (
                f"org-B's `get` on org-A's box {box_a.id} failed for an "
                f"unexpected reason, so this proves nothing about scoping: {exc!r}"
            )
        else:
            assert resolved is None, (
                f"org-B's runtime resolved org-A's box {box_a.id} to a handle"
            )

        # 2b. Raw tunnel endpoint, both vectors.
        #     `port` is a query parameter, not a body field
        #     (`boxlite-proxy.controller.ts:208` — `@Query('port', ParseIntPipe)`,
        #     matching `openapi/box.openapi.yaml:952`).  Sending it in the body
        #     makes `ParseIntPipe` reject the request with 400 *before*
        #     `findOneByIdOrName` runs, so the ownership check would never be
        #     exercised at all.
        tunnel_path = f"boxes/{box_a.id}/network/tunnel?port={_TUNNEL_PORT}"

        own_ns = _request(
            "POST",
            _prefixed(org_a_ctx, org_b_prefix, tunnel_path),
            token=org_b_token,
        )[0]
        assert own_ns == 404, (
            f"tunnel to org-A's box from org-B's namespace should 404, got {own_ns}"
        )

        foreign_ns = _request(
            "POST",
            _prefixed(org_a_ctx, org_a_prefix, tunnel_path),
            token=org_b_token,
        )[0]
        assert foreign_ns in (401, 403), (
            f"tunnel in org-A's namespace with org-B's key should 401/403, got "
            f"{foreign_ns}"
        )
    finally:
        try:
            await rt.remove(box_a.id, force=True)
        except Exception:
            pass
