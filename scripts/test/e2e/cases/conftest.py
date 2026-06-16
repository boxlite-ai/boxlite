"""Pytest fixtures for the e2e suite.

Every fixture here forces the **REST** path. There is no `Boxlite.default()`
fixture in this file by design — local-FFI tests belong under
`sdks/python/tests/`, not `scripts/test/e2e/`.

The autouse fixture `verify_runner_saw_all_boxes` proves per-test that
every box the test created actually reached the runner via the API. If a
test accidentally swaps to local-FFI or talks to the wrong endpoint,
that fixture fails the test with a path-bypass error.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

import pytest
import pytest_asyncio

import boxlite

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from path_verification import runner_journal_seek, runner_hits_for_box

DEFAULT_PROFILE = os.environ.get("BOXLITE_E2E_PROFILE", "p1")
CRED_PATH = Path.home() / ".boxlite" / "credentials.toml"


def _discover_supported_image() -> str:
    """Resolve the box image at session start.

    Precedence:
      1. `BOXLITE_E2E_IMAGE` env — explicit override (CI sets this, local
         devs can pin a known-good ref). Returned as-is, no validation.
      2. Probe — POST /boxes with an obviously-out-of-allowlist image
         against the active credential profile's API, parse the 400
         body's `"Supported images: a, b, c"` list, return the first.
         The first entry is the server's default (curated-images.constant
         `assertSupportedImage(undefined)` returns `supported[0]`),
         which is the safest pick across reboots / image-allowlist
         rotations.
      3. Fallback `alpine:3.23` — if probe fails (network down, auth
         broken, body shape changed). Tests downstream will still 400
         loudly so the regression is visible.

    The discovered value is also written back to `os.environ
    ['BOXLITE_E2E_IMAGE']` so the C / Go / Node SDK entry drivers'
    subprocess env inherits it without each test re-implementing the
    probe.
    """
    explicit = os.environ.get("BOXLITE_E2E_IMAGE", "").strip()
    if explicit:
        return explicit
    if not CRED_PATH.exists():
        return "alpine:3.23"
    try:
        data = tomllib.loads(CRED_PATH.read_text())
        p = data.get("profiles", {}).get(DEFAULT_PROFILE)
        if not p:
            return "alpine:3.23"
        url = f"{p['url'].rstrip('/')}/v1/{p.get('path_prefix') or ''}/boxes".replace("//boxes", "/boxes")
        req = urllib.request.Request(
            url,
            method="POST",
            headers={
                "Authorization": f"Bearer {p['api_key']}",
                "Content-Type": "application/json",
            },
            # Send a deliberately-unsupported image so the API answers
            # with its full supportedImages list. cpus/memory are
            # required by the DTO but never reached — image validation
            # rejects first.
            data=json.dumps({
                "image": "__e2e_probe_not_in_allowlist__",
                "cpus": 1,
                "memory_mib": 256,
            }).encode(),
        )
        try:
            urllib.request.urlopen(req, timeout=10).read()
        except urllib.error.HTTPError as e:
            if e.code == 400:
                body = json.loads(e.read())
                # Message shape:
                #   "Unsupported image 'X'. Supported images: a, b, c"
                m = re.search(
                    r"Supported images:\s*(.+?)\s*$",
                    body.get("message", ""),
                )
                if m:
                    images = [s.strip() for s in m.group(1).split(",") if s.strip()]
                    if images:
                        return images[0]
    except Exception:
        # Best-effort probe: any failure here should fall back to a
        # conservative default image so e2e startup remains resilient.
        # Downstream tests will still fail loudly if the image is invalid.
        pass
    return "alpine:3.23"


DEFAULT_IMAGE = _discover_supported_image()
# Pin the discovered value into the env so the C / Go / Node entry
# drivers' subprocess inherit it without re-running the probe.
os.environ["BOXLITE_E2E_IMAGE"] = DEFAULT_IMAGE

# test_path_verification.py is a LOCAL-only meta-test: case 1 asserts the
# credentials.toml URL contains ":3000" (the local API port), and case 2
# reads the host's `boxlite-runner` systemd journal via journalctl. Both
# can't run on a remote profile pointing at the Tokyo ELB. Drop them
# from pytest collection on any non-default profile so the cloud gate
# reports them as "not collected" rather than producing a SKIP entry.
if DEFAULT_PROFILE != "default":
    collect_ignore = ["test_path_verification.py"]


def path_verify_skipped() -> bool:
    """Single truthy reading of BOXLITE_E2E_SKIP_PATH_VERIFY for the SDK
    entry smokes (CLI / C / Go / Node). They each spawn a subprocess
    that creates a box and then assert `runner_hits_for_box >= 1`,
    which can't be satisfied on a cloud run where journalctl lives on
    a remote EC2. When this returns True the entry tests skip the
    journal-hits assertion; the box-id + driver-output assertions
    still run."""
    return os.environ.get("BOXLITE_E2E_SKIP_PATH_VERIFY", "").lower() in (
        "1", "true", "yes", "on"
    )


def skip_or_fail_unless_sdk_build_required(reason: str) -> None:
    """SDK entry-point fixtures (test_c_entry, test_go_entry,
    test_node_entry, test_cli_entry, test_cli_detach_recovery) skip
    when their build artifact is missing — convenient for local dev
    where someone hasn't built every SDK. On the cloud gate the
    e2e-cloud-test workflow produces every artifact up front via
    build_c / build_node / build_cli prereq jobs, so set
    BOXLITE_E2E_REQUIRE_SDK_BUILDS=1 there — a regression in the
    build step then surfaces as a test failure, not a silent skip."""
    require = os.environ.get("BOXLITE_E2E_REQUIRE_SDK_BUILDS", "")
    if require.lower() in ("1", "true", "yes", "on"):
        pytest.fail(
            f"BOXLITE_E2E_REQUIRE_SDK_BUILDS=1 forbids skipping this case "
            f"but the prerequisite is missing: {reason}"
        )
    pytest.skip(reason)


# test_path_verification.py is a LOCAL-only meta-test: case 1 asserts the
# credentials.toml URL contains ':3000' (the local API port), case 2 reads
# the host's `boxlite-runner` systemd journal via journalctl. Neither can
# run against a remote profile pointing at the Tokyo ELB. Drop from pytest
# collection on any non-default profile so the cloud gate reports them as
# 'not collected' rather than producing SKIP entries.
if DEFAULT_PROFILE != "default":
    collect_ignore = ["test_path_verification.py"]


def _profile(name: str) -> dict:
    if not CRED_PATH.exists():
        pytest.exit(
            f"{CRED_PATH} missing — run scripts/test/e2e/fixture_setup.py first",
            returncode=2,
        )
    data = tomllib.loads(CRED_PATH.read_text())
    p = data.get("profiles", {}).get(name)
    if not p:
        pytest.exit(
            f"profile '{name}' not in {CRED_PATH} — run fixture_setup.py",
            returncode=2,
        )
    return p


class _TrackingRuntime:
    """Wraps a REST Boxlite runtime so we can intercept .create() and
    record the box ids per test. Other methods pass through unchanged
    via __getattr__. Designed to be transparent — any failure inside the
    tracking layer must not mask the underlying runtime behaviour."""

    def __init__(self, inner):
        object.__setattr__(self, "_inner", inner)
        # Per-test bucket of (box_id, created_at_monotonic). Reset by
        # the autouse fixture before each test.
        object.__setattr__(self, "_created", [])

    async def create(self, *args, **kwargs):
        box = await self._inner.create(*args, **kwargs)
        try:
            self._created.append((box.id, time.monotonic()))
        except Exception:
            pass  # never mask the real return
        return box

    def __getattr__(self, name):
        return getattr(self._inner, name)


@pytest_asyncio.fixture(scope="session")
async def rt():
    """REST-mode Boxlite runtime against the local API, wrapped in a
    tracking shim so the autouse fixture can verify each box reached
    the runner."""
    p = _profile(DEFAULT_PROFILE)
    opts = boxlite.BoxliteRestOptions(
        url=p["url"],
        credential=boxlite.ApiKeyCredential(p["api_key"]),
        path_prefix=p.get("path_prefix") or "",
    )
    runtime = boxlite.Boxlite.rest(opts)
    tracking = _TrackingRuntime(runtime)
    yield tracking
    if hasattr(runtime, "close"):
        try:
            close = runtime.close()
            import inspect
            if inspect.isawaitable(close):
                await close
        except Exception:
            pass


@pytest_asyncio.fixture(autouse=True)
async def verify_runner_saw_all_boxes(rt):
    """Per-test path-bypass guard.

    Before each test runs, snapshot the runner journal timestamp and
    reset the tracking runtime's per-test bucket. After the test,
    every box id created via `rt.create` MUST appear in the runner
    journal — if not, the SDK silently bypassed the API → Runner
    chain (e.g. degraded to local FFI, or the runner-side journal
    write broke). Tests that don't create any boxes are unaffected.

    Set ``BOXLITE_E2E_SKIP_PATH_VERIFY=1`` to bypass this check entirely.
    Intended for cloud-CI runs where the runner journal lives on a
    remote EC2 instance and isn't reachable from ``journalctl`` on the
    pytest host. The FFI-bypass risk this guard defends against doesn't
    apply on a stock GitHub-hosted runner (no KVM, libkrun can't start
    a VM), so disabling it there loses no real safety net.
    """
    # Truthy values only. Plain `if os.environ.get(...)` treats "0"
    # and "false" as truthy because they're non-empty strings, which
    # is the opposite of what someone setting the var to "0" expects.
    if os.environ.get("BOXLITE_E2E_SKIP_PATH_VERIFY", "").lower() in ("1", "true", "yes", "on"):
        yield
        return

    since = runner_journal_seek()
    object.__setattr__(rt, "_created", [])

    yield

    # Give the runner a brief window to flush its log buffer. The
    # CREATE_BOX journal entry is written as the job completes —
    # if we check immediately we can race the journald write.
    created = list(rt._created)
    if not created:
        return

    deadline = time.time() + 5.0
    missing = []
    while True:
        missing = [bid for bid, _ in created
                   if runner_hits_for_box(since, bid) < 1]
        if not missing or time.time() > deadline:
            break
        await asyncio.sleep(0.3)

    assert not missing, (
        f"box(es) created in this test never reached the runner journal: "
        f"{missing}. Either the SDK degraded to local FFI, the API did not "
        f"forward to the runner, or journalctl access broke. See "
        f"scripts/test/e2e/README.md for the chain spec."
    )


@pytest.fixture(scope="session")
def image() -> str:
    return DEFAULT_IMAGE


@pytest_asyncio.fixture
async def box(rt, image):
    """Create a box per test, auto-removed on teardown."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    yield b
    try:
        await rt.remove(b.id, force=True)
    except Exception:
        pass


# ─── helpers shared across cases ────────────────────────────────────────────

async def collect_stream(stream) -> str:
    if stream is None:
        return ""
    chunks: list[str] = []
    async for ch in stream:
        chunks.append(ch.decode("utf-8", "replace") if isinstance(ch, bytes) else str(ch))
    return "".join(chunks)


async def drain(ex) -> tuple[str, str]:
    """Drain stdout + stderr concurrently — required for REST exec."""
    import asyncio
    out_t = asyncio.create_task(collect_stream(ex.stdout()))
    err_t = asyncio.create_task(collect_stream(ex.stderr()))
    return await asyncio.gather(out_t, err_t)


def stdout_line_count(s: str) -> int:
    return len([ln for ln in s.splitlines() if ln])
