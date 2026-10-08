"""
The image catalog, end to end.

This is the only place the whole claim is exercised: an arbitrary public
image boots a box with no prior registration, and the pull that made it work
is what records the image. Reading the catalog and deleting from it are
covered by unit and integration tests; what needs a real runner is how a row
gets *written*.

Driven through `rt.images`, the SDK's image handle: on a REST runtime it
reads and deletes through the box API's image routes, so this is also the
end-to-end check that the handle a local runtime answers from its cache
reaches the catalog in the cloud. Boxes are created with the same runtime.

The tests run in file order and share the catalog state they build up: a cold
pull is tens of seconds, so the suite pays for it once and walks the lifecycle
rather than re-booting per assertion. Each test names the step it is.

Environment:
  BOXLITE_E2E_CATALOG_IMAGE   Image to boot. Must be on a host the API's
                              allowlist admits. Defaults to a small public one
                              on quay.io, which the built-in allowlist accepts
                              — so this file works against a deployed stack
                              without a registry of our own.
  BOXLITE_E2E_ALLOW_MISSING_CATALOG=1
                              Skip instead of failing when the stack's box API
                              has no image routes. For running against an
                              environment this change has not reached; without
                              it a 404 is the regression it looks like.

POL-544.

Not covered here: that a recorded tag does not follow an upstream move, and
that deleting the image is what re-resolves it. Proving it means moving a tag
upstream, which needs a repository under our control.
"""

from __future__ import annotations

import asyncio
import os
import re

import pytest
import pytest_asyncio

import boxlite
from e2e_auth import auth_context, request_json

# Small, public, and on a host the built-in allowlist admits
# (`docker.io` / `quay.io` / `gcr.io` / `public.ecr.aws` — `ghcr.io` is held
# back until every runner pulls tenant references anonymously).
DEFAULT_CATALOG_IMAGE = "quay.io/libpod/alpine:latest"

CATALOG_IMAGE = os.environ.get("BOXLITE_E2E_CATALOG_IMAGE", DEFAULT_CATALOG_IMAGE)

# `name` in the catalog is the repository without the tag: one row holds every
# version ever pulled under it.
CATALOG_NAME = CATALOG_IMAGE.split("@")[0].rsplit(":", 1)[0]

# A repository that cannot resolve, on the same allowlisted host so admission
# passes and the *pull* is what fails. A distinct repository, so a row written
# for it would show up as a name that was not there before — sharing
# CATALOG_NAME would make the assertion pass for the wrong reason.
UNPULLABLE_IMAGE = f"{CATALOG_NAME.rsplit('/', 1)[0]}/boxlite-e2e-does-not-exist:v1"
UNPULLABLE_NAME = UNPULLABLE_IMAGE.rsplit(":", 1)[0]


@pytest_asyncio.fixture(scope="module")
async def images(rt):
    """The runtime's image handle, once the stack is known to serve it.

    A NotFoundError is failed, not skipped: the routes going missing is
    exactly the regression this file exists to catch, and a skip would report
    that as green. Running against a stack the change has not reached yet is a
    deliberate act, so it takes a deliberate opt-in.
    """
    try:
        await rt.images.list()
    except boxlite.NotFoundError:
        if os.environ.get("BOXLITE_E2E_ALLOW_MISSING_CATALOG") == "1":
            pytest.skip("BOXLITE_E2E_ALLOW_MISSING_CATALOG=1 and this stack has no image routes")
        pytest.fail(
            "rt.images.list() was answered 404. If this stack predates the catalog, say so "
            "with BOXLITE_E2E_ALLOW_MISSING_CATALOG=1; otherwise the routes have regressed."
        )
    return rt.images


async def _listed(images, name: str) -> list:
    """The references the catalog lists under `name`. Curated images are never listed."""
    return [info for info in await images.list() if info.repository == name]


@pytest_asyncio.fixture(scope="module", autouse=True)
async def clean_catalog(images):
    """Clear our test entries before and after, so a re-run starts where the first did."""

    async def drop() -> None:
        for name in (CATALOG_NAME, UNPULLABLE_NAME):
            try:
                await images.remove(name)
            except (boxlite.NotFoundError, boxlite.InvalidStateError):
                # Absent, or still held by a box — neither of which this
                # fixture can or should resolve.
                pass

    await drop()
    yield
    await drop()


# The admission gate caps how many cold pulls — creates the catalog cannot
# answer yet — an organization may start per window, and each stack sets its
# own budget. This file makes several, and any other suite on the same
# organization spends from the same budget. Waiting the window out is not a
# workaround for a flaky server: the refusal is the documented contract, it
# carries how long is left, and a suite that treated it as a failure would be
# reporting the gate working as a bug.
_WINDOW_REMAINING = re.compile(r"(\d+)s left in the current one")


async def _create_box(rt, image: str, *, attempts: int = 3):
    """Create a box, waiting out the cold-pull budget if the gate asks us to."""
    for attempt in range(attempts):
        try:
            return await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
        except Exception as failure:
            remaining = _WINDOW_REMAINING.search(str(failure))
            if remaining is None or attempt == attempts - 1:
                raise
            await asyncio.sleep(int(remaining.group(1)) + 1)
    raise AssertionError("unreachable")


# The runner delivers what an image resolved to on its next state push, which
# its box sync makes every 10 seconds, and it drops a report still owed for a
# box that is destroyed first. So the catalog changes only while the box is
# still up, some seconds after it started — and an unchanged catalog proves
# nothing until that window has passed. Two and a half sync periods.
_REPORT_WINDOW_SECONDS = 25


async def _await_listed(images, name: str) -> bool:
    """Whether `name` is listed, polled until the runner's report has had time to land."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _REPORT_WINDOW_SECONDS
    while True:
        if await _listed(images, name):
            return True
        if loop.time() >= deadline:
            return False
        await asyncio.sleep(1)


async def _hold_through_report_window(check) -> None:
    """Assert `check` for as long as a report could still land, failing on the first change."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _REPORT_WINDOW_SECONDS
    while loop.time() < deadline:
        await check()
        await asyncio.sleep(1)
    await check()


@pytest.mark.asyncio
async def test_an_arbitrary_public_image_boots_a_box(rt, images):
    """Step 1. No registration call and no catalog entry beforehand — just a reference."""
    assert not await _listed(images, CATALOG_NAME), (
        f"{CATALOG_NAME} was in the catalog before the first box booted"
    )

    box = await _create_box(rt, CATALOG_IMAGE)
    try:
        assert box.id
        # Kept up until the report lands; removing it first would drop the report.
        assert await _await_listed(images, CATALOG_NAME), (
            f"{CATALOG_NAME} never entered the catalog while a box booted from it was up"
        )
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_using_it_is_what_records_it(rt, images):
    """
    Step 2. The entry appears because a box booted, not because anything
    registered it — which is the whole shape of this release.
    """
    listed = await _listed(images, CATALOG_NAME)
    assert listed, f"{CATALOG_NAME} never entered the catalog after a box booted from it"

    detail = await images.get(CATALOG_NAME)
    assert detail.versions, "the image is recorded but carries no version"
    version = detail.versions[0]
    # The digest and the size come from the runner, the only thing that knows
    # them. Missing either would mean the report never arrived.
    assert version.digest.startswith("sha256:")
    assert version.size_bytes is not None and version.size_bytes > 0
    assert version.source_ref == CATALOG_IMAGE
    # The list names each reference by the build it points to.
    assert {info.id for info in listed} == {version.digest}

    usage = await images.usage()
    assert usage.count >= 1
    assert usage.known_bytes >= version.size_bytes


@pytest.mark.asyncio
async def test_a_second_box_adds_no_second_version(rt, images):
    """
    Step 3. Booting the same reference again resolves through the catalog, so
    it records nothing new.

    What this cannot observe from outside is the reference the runner was
    handed. That it is digest-pinned is held by the resolver's own exit
    assertion (`assertPinnedOnCatalogHit`) and its unit tests; reading the job
    payload needs database access this suite does not have against a deployed
    stack.
    """
    before = await images.get(CATALOG_NAME)

    box = await _create_box(rt, CATALOG_IMAGE)
    try:

        async def unchanged() -> None:
            after = await images.get(CATALOG_NAME)
            assert len(after.versions) == len(before.versions), (
                "a second box on the same reference recorded another version; it "
                "resolved through the registry instead of through the catalog"
            )
            assert after.tags == before.tags

        await _hold_through_report_window(unchanged)
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_a_box_still_holding_it_blocks_removal(rt, images):
    """
    Step 4. A box that has not been destroyed can still boot from the image, so
    the entry cannot go. The refusal names the box, which is the only way the
    caller can act on it.
    """
    box = await _create_box(rt, CATALOG_IMAGE)
    try:
        with pytest.raises(boxlite.InvalidStateError) as refusal:
            await images.remove(CATALOG_NAME)
        assert box.id in str(refusal.value)
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_removal_frees_the_name_and_the_quota(rt, images):
    """Step 5. With nothing holding it, the entry goes and the count falls."""
    before = (await images.usage()).count

    await images.remove(CATALOG_NAME)

    assert not await _listed(images, CATALOG_NAME)
    assert (await images.usage()).count == before - 1

    # Gone for the caller: the row is still there with `deletedAt` set, and
    # every read skips it.
    with pytest.raises(boxlite.NotFoundError):
        await images.remove(CATALOG_NAME)

    # The name is free again, and using the reference brings it back as a new
    # entry — which is what makes deletion the escape hatch for a pinned tag.
    box = await _create_box(rt, CATALOG_IMAGE)
    try:
        assert await _await_listed(images, CATALOG_NAME)
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_a_pull_that_fails_records_nothing(rt, images):
    """
    Step 6. The catalog is written when a box reaches STARTED, so an image that
    never pulls must leave no trace — otherwise a typo would spend one of the
    organization's slots forever.
    """
    assert not await _listed(images, UNPULLABLE_NAME)

    box = None
    try:
        box = await _create_box(rt, UNPULLABLE_IMAGE)
        # The premise is that this reference cannot resolve. If it booted, the
        # pull succeeded and this test is no longer testing what it says.
        pytest.fail(
            f"{UNPULLABLE_IMAGE} booted a box, so it is pullable and this test "
            f"can no longer show what a failed pull does"
        )
    except Exception as failure:
        message = str(failure)
        # A stack with nothing to schedule onto never reaches the pull, so the
        # assertion below would hold for a reason that has nothing to do with
        # the catalog. Say so rather than report a pass.
        if "No available runners" in message:
            pytest.skip("no runner is attached to this stack, so no pull was attempted")
        # The gate's own refusal reads "Too many image pulls started recently",
        # so the word "pull" cannot tell it apart from a registry failure.
        # Match the window it reports instead — a structural marker the prose
        # around it can change without breaking.
        if _WINDOW_REMAINING.search(message):
            pytest.fail(
                f"the cold-pull budget ran out before the registry was reached, so an "
                f"empty catalog proves nothing here: {message}"
            )
        # Admission refusing the reference is a different test. This one needs
        # the gate to let it through and the *registry* to be what fails.
        assert "not allowed" not in message, (
            f"admission refused {UNPULLABLE_IMAGE} instead of letting the pull fail: {message}"
        )
        # What is left must show the pull was actually attempted. Auth, a
        # dropped connection or a scheduling error all stop short of the
        # registry, and the assertion below would then hold for a reason this
        # test never established. Failing loudly on an unfamiliar message is
        # the safe direction: a false red gets read, a false green does not.
        assert UNPULLABLE_NAME in message or "failed to pull" in message.lower(), (
            f"create failed before the pull was attempted, so an empty catalog "
            f"proves nothing here: {message}"
        )
    finally:
        if box is not None:
            await rt.remove(box.id, force=True)

    async def never_recorded() -> None:
        assert not await _listed(images, UNPULLABLE_NAME), (
            f"{UNPULLABLE_NAME} entered the catalog even though it never pulled"
        )

    await _hold_through_report_window(never_recorded)


@pytest.mark.asyncio
async def test_curated_boxes_never_touch_the_catalog(rt, images, image):
    """
    Step 7. The path every existing caller takes is unchanged: a curated image
    is the operator's, so it neither enters an organization's catalog nor
    spends any of its limit.
    """

    async def snapshot() -> tuple:
        usage = await images.usage()
        names = {info.repository for info in await images.list()}
        return names, (usage.count, usage.limit, usage.known_bytes)

    before = await snapshot()

    box = await _create_box(rt, image)
    try:

        async def untouched() -> None:
            assert await snapshot() == before

        await _hold_through_report_window(untouched)
    finally:
        await rt.remove(box.id, force=True)


class TestAdmission:
    """
    Step 8. What the gate refuses, it refuses synchronously and with a reason.
    A 500 here would mean the runner was handed something it should never have
    seen; a 2xx would mean the gate is not there at all.
    """

    def test_refuses_a_host_outside_the_allowlist(self, images):
        status, body = request_json(
            "POST", auth_context().v1("boxes"), {"image": "example.invalid/acme/app:v1"}
        )
        assert status == 400, f"expected a refusal, got {status}: {body}"
        assert "example.invalid" in str(body)

    def test_refuses_the_metadata_address(self, images):
        status, body = request_json(
            "POST", auth_context().v1("boxes"), {"image": "169.254.169.254/acme/app:v1"}
        )
        assert status == 400, f"expected a refusal, got {status}: {body}"
        # Without this the test passes on any 400 the create path happens to
        # raise, which would not show the gate saw the address at all.
        assert "169.254.169.254" in str(body), f"the refusal never named the address: {body}"
