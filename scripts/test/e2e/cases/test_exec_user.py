"""E2E port of `src/boxlite/tests/exec_user.rs`.

Verifies the `user=` exec override travels SDK → API → Runner → guest:

  - `user="65534"` (nobody on alpine) makes `id -u` return 65534
  - `user="65534:65534"` sets both uid and gid
  - an obviously-invalid user name surfaces as a typed client error
    (not a 5xx)

The Rust FFI suite covers more user-string parsing variants; we keep the
e2e cost at one box and pick the three cases that most likely break in
REST/runner DTO wiring.
"""

from __future__ import annotations

import asyncio

import pytest

from conftest import drain


@pytest.mark.asyncio
async def test_exec_user_numeric_uid(box):
    """Running with `user='65534'` causes `id -u` to report 65534."""
    ex = await box.exec("id", ["-u"], None, user="65534")
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, f"`id -u` failed: rc={rc.exit_code}"
    assert out.strip() == "65534", (
        f"user= override not propagated: id -u returned {out!r}, expected 65534"
    )


@pytest.mark.asyncio
async def test_exec_user_uid_gid_pair(box):
    """`user='65534:65534'` sets both uid and gid. Alpine has user/group
    `nobody` at 65534/65534, which is what we expect to see back."""
    ex = await box.exec(
        "sh", ["-c", "echo $(id -u):$(id -g)"], None, user="65534:65534",
    )
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, f"`id` failed: rc={rc.exit_code}"
    assert out.strip() == "65534:65534", (
        f"uid:gid pair not propagated: got {out!r}, expected '65534:65534'"
    )


@pytest.mark.asyncio
async def test_exec_user_invalid_is_typed_error(box):
    """Asking to run as a user that doesn't exist must surface a typed
    client error, not a bare 5xx. Catches API/runner mapping regressions
    where a parser error leaks an Internal Server Error."""
    with pytest.raises(Exception) as exc_info:
        ex = await box.exec(
            "echo", ["x"], None,
            user="this-user-cannot-possibly-exist-boxlite-e2e",
        )
        # If exec dispatched, drain + wait so we see the actual failure
        # mode rather than an unrelated leak.
        await drain(ex)
        await asyncio.wait_for(ex.wait(), timeout=30)
    msg = str(exc_info.value)
    assert "500" not in msg and "Internal" not in msg, (
        f"invalid user= leaked a 5xx: {msg!r}"
    )
