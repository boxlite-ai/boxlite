"""CLI entry-point e2e cases.

These exercise the same SDK→API→Runner→VM chain that the other cases
do, but the entry point is the `boxlite` CLI binary (subprocess), not
the Python SDK. The CLI shares the underlying Rust `boxlite::rest`
client with the Python SDK, but adds CLI-only surface (auth login,
argument parsing, output formatting, exit-code propagation) that
nothing else exercises.

Prereqs:
  - `/usr/local/bin/boxlite` is the boxlite CLI binary
  - `boxlite auth login --url <local-api> --api-key-stdin` was run by
    fixture_setup.py, so the CLI sees the same profile the Python SDK
    uses
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse

import pytest

from conftest import (
    E2E_AUTO_DELETE_SECONDS,
    E2E_AUTO_STOP_SECONDS,
    e2e_box_name,
)

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from e2e_auth import load_profile
from images import default_image

BOXLITE_BIN = os.environ.get("BOXLITE_E2E_CLI", shutil.which("boxlite"))
IMAGE = default_image()
BOX_ID_RE = re.compile(r"[A-Za-z0-9]{12}")


CLI_PROFILE = os.environ.get("BOXLITE_E2E_PROFILE", "p1")


@pytest.fixture(scope="module")
def cli():
    if not BOXLITE_BIN or not Path(BOXLITE_BIN).exists():
        pytest.skip(f"boxlite CLI not found at {BOXLITE_BIN!r}")
    return BOXLITE_BIN


def _cli_env() -> dict[str, str]:
    """Env dict that steers the CLI to the REST API via the e2e profile."""
    env = {**os.environ, "BOXLITE_PROFILE": CLI_PROFILE}
    return env


def run(cli, *args, timeout: int = 60, stdin: str | None = None,
        check: bool = True) -> subprocess.CompletedProcess:
    """Wrap subprocess.run with consistent settings + always capture."""
    return subprocess.run(
        [cli, *args],
        timeout=timeout,
        input=stdin,
        text=True,
        capture_output=True,
        check=check,
        env=_cli_env(),
    )


def test_cli_whoami_against_api(cli):
    """`boxlite auth whoami` must return identity + server info."""
    r = run(cli, "auth", "whoami")
    out = r.stdout.lower()
    assert "logged in" in out or "server" in out or "boxlite" in out, (
        f"whoami output doesn't look like an auth status: {r.stdout!r}"
    )


def test_cli_ls_returns_table(cli):
    """`boxlite ls` must succeed and return a table-like layout, even
    when there are zero boxes."""
    r = run(cli, "ls")
    assert "ID" in r.stdout and "IMAGE" in r.stdout, (
        f"`boxlite ls` output not table-shaped: {r.stdout!r}"
    )


def test_cli_run_exec_chain(cli):
    """End-to-end CLI flow: `boxlite run -d <image> -- sleep 300`
    (detach mode), then `boxlite exec <id> -- echo HELLO`, then
    `boxlite rm -f <id>`. Asserts the exec captured stdout and the
    cleanup removed the box."""
    # 1. detach run prints the box id on stdout
    r_run = run(cli, "run", "-d", IMAGE, "--", "sleep", "300", timeout=120)
    m = BOX_ID_RE.search(r_run.stdout)
    assert m, f"`boxlite run -d` did not print a uuid: {r_run.stdout!r}"
    box_id = m.group(0)

    try:
        # 2. exec a quick command and check stdout
        r_exec = run(cli, "exec", box_id, "--", "echo", "HELLO-FROM-CLI")
        assert "HELLO-FROM-CLI" in r_exec.stdout, (
            f"exec did not capture stdout: {r_exec.stdout!r}"
        )
        assert r_exec.returncode == 0

        # 3. list contains the box
        r_ls = run(cli, "ls")
        assert box_id in r_ls.stdout, (
            f"`boxlite ls` did not show the new box {box_id}: {r_ls.stdout}"
        )
    finally:
        run(cli, "rm", "-f", box_id, check=False)

    # 4. after rm, ls should NOT contain it
    r_ls2 = run(cli, "ls")
    assert box_id not in r_ls2.stdout, (
        f"`boxlite rm -f` did not remove the box from listing: {r_ls2.stdout}"
    )


# `run` without `-d` is a different code path, not a nicer spelling of the
# same one: it is create → WS `/boxes/{id}/attach` → `POST /start`
# (src/boxlite/src/rest/litebox.rs:209-235), so the box's main process is
# streamed over a socket the detached form never opens. On a cloud stage that
# upgrade is answered with a bare 503, every time:
#
#   network error: upstream returned HTTP 503 Service Unavailable ...
#   upstream connect error or disconnect/reset before headers
#
# The body is an envelope the API never produces, so the refusal comes from the
# load balancing in front of it — a global LB plus a regional internal one on
# GCP (apps/infra/mdeploy/stack/providers/gcp/api.ts:2), an ALB on AWS
# (apps/infra/docs/networking.md:40). Which of those hops drops the upgrade is
# not established; only that the API is not what answered.
#
# The create lands first, so a failed run still leaves a box behind — which is
# why this case names its box and removes it by name afterwards.
#
# Hence the condition: a local stack reaches boxlite-api on :3000 with no load
# balancer in front of it, so nothing there plays that role — its own proxy on
# :3001 (apps/e2e/bootstrap.sh:166-169) serves box previews, not API ingress.
# An unconditional strict xfail would turn a local pass into an XPASS failure
# and take `make test:e2e` red with it. What a local stack actually does with
# the attached form is untested, and this mark claims nothing about it.
FOREGROUND_RUN_ATTACH_503 = (
    "attached `boxlite run` cannot reach a cloud stage: the WS upgrade to "
    "/boxes/{id}/attach (src/boxlite/src/rest/litebox.rs:235) is refused with "
    "a bare 503 by the load balancing in front of the API, after the box has "
    "already been created"
)

_STAGE_HOST = urlparse(
    os.environ.get("BOXLITE_E2E_API_URL")
    or load_profile(CLI_PROFILE, required=False).get("url", "")
).hostname or "localhost"
STAGE_IS_REMOTE = _STAGE_HOST not in ("localhost", "127.0.0.1", "::1")


@pytest.mark.xfail(
    condition=STAGE_IS_REMOTE, strict=True, reason=FOREGROUND_RUN_ATTACH_503
)
def test_cli_run_foreground_streams_command_output(cli):
    """`boxlite run <image> <cmd>` must stream the command's stdout and
    exit 0. Every other CLI case detaches, so the attach this form adds
    is covered by nothing else."""
    name = e2e_box_name()
    marker = f"HELLO-FOREGROUND-{uuid.uuid4().hex[:8]}"
    try:
        r = run(
            cli, "run",
            "--name", name,
            "--auto-stop", str(E2E_AUTO_STOP_SECONDS),
            "--auto-delete", str(E2E_AUTO_DELETE_SECONDS),
            IMAGE, "echo", marker,
            timeout=180, check=False,
        )
        assert r.returncode == 0, (
            f"`boxlite run` (foreground) exited {r.returncode}: {r.stderr!r}"
        )
        assert marker in r.stdout, (
            f"foreground run did not stream the command's stdout: {r.stdout!r}"
        )
    finally:
        # The failure lands after the box exists but before the id is
        # printed, so the name is the only handle left on it.
        run(cli, "rm", "-f", name, check=False)


def test_cli_exec_exit_code_propagates(cli):
    """A non-zero exit inside the box must propagate back through the
    CLI's own exit code. This is the CLI behaviour layer, not just the
    SDK — argv parsing + exit-code mapping is CLI-specific."""
    r_run = run(cli, "run", "-d", IMAGE, "--", "sleep", "300", timeout=120)
    m = BOX_ID_RE.search(r_run.stdout)
    assert m
    box_id = m.group(0)

    try:
        r = run(cli, "exec", box_id, "--", "sh", "-c", "exit 7", check=False)
        assert r.returncode == 7, (
            f"CLI did not propagate the box exit code; got {r.returncode}, "
            f"stdout={r.stdout!r} stderr={r.stderr!r}"
        )
    finally:
        run(cli, "rm", "-f", box_id, check=False)
