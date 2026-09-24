"""Control-plane probes a deployed stage must answer — the `smoke` core.

`/v1/me` in one call exercises auth, Postgres and the Redis user cache, which
is why `.github/workflows/e2e-cloud.yml` calls it before pytest even starts.
Doing it here too is what puts it inside the suite's own report, and gives the
prod leg (`-m smoke`) something that costs nothing and still fails loudly when
the stage is not serving.

`/v1/config` is the stage's own statement of which surfaces it implements. The
cloud API serves boxes, exec, files, volumes, metrics and tunnels, and no
snapshots, clone, export or import — so the ported E2B cases deliberately stop
at that line (see test_volumes.py, test_box_metrics.py). A stage that flips one
of those flags on has surface this suite does not cover, and that is worth a
failure rather than a silent gap.
"""
from __future__ import annotations

import pytest

from e2e_auth import auth_context, request_json


# Capabilities the cloud API declares as absent
# (apps/api/src/boxlite-rest/boxlite-config.controller.ts:18-23). Each one
# corresponds to an E2B test area this suite does not port for that reason:
# snapshots/clone stand in for E2B's snapshot and fork tests.
UNIMPLEMENTED_CAPABILITIES = (
    "snapshots_enabled",
    "clone_enabled",
    "export_enabled",
    "import_enabled",
)


@pytest.mark.asyncio
@pytest.mark.smoke
async def test_me_identifies_the_calling_principal():
    ctx = auth_context()
    status, body = request_json("GET", "/v1/me")
    assert status == 200, f"/v1/me returned {status}: {body}"
    assert body is not None
    assert body.get("principal_type") in ("user", "service_account"), (
        f"unexpected principal_type: {body.get('principal_type')!r}"
    )
    assert body.get("path_prefix") == ctx.path_prefix, (
        f"path_prefix drifted between calls: {body.get('path_prefix')!r} != {ctx.path_prefix!r}"
    )
    assert "box:exec" in (body.get("scopes") or []), (
        f"credential cannot exec boxes; scopes={body.get('scopes')!r}"
    )


@pytest.mark.asyncio
@pytest.mark.smoke
async def test_config_reports_the_capabilities_this_suite_assumes():
    status, body = request_json("GET", "/v1/config")
    assert status == 200, f"/v1/config returned {status}: {body}"
    capabilities = (body or {}).get("capabilities")
    assert isinstance(capabilities, dict), f"no capabilities envelope: {body}"
    enabled = [name for name in UNIMPLEMENTED_CAPABILITIES if capabilities.get(name)]
    assert not enabled, (
        f"stage now implements {enabled} — this suite has no cases for those "
        "surfaces; port the matching E2B areas before trusting a green run"
    )
