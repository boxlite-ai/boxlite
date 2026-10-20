"""
Creating and explicitly replacing a catalog alias, end to end.

Two upstream registry tags record two versions and aliases when first pulled.
An organization can create an additional catalog alias for either version.
Creation rejects every existing name, including the same digest, and leaves
bindings and history unchanged. Deleting the alias and creating it again is
the explicit replacement flow. Existing boxes retain their pinned digest;
new boxes use the alias's current binding. Curated images reject alias writes.

Image operations use rt.images; the curated selector is read from /api/images.
Tests run in file order and share two pulled versions to avoid repeated cold
pulls. Alias writes require the write:images scope.

Environment:
  BOXLITE_E2E_ALIAS_IMAGE_OLD  Two upstream tags of the same repository with
  BOXLITE_E2E_ALIAS_IMAGE_NEW  different digests, on an allowed registry host.
                             Defaults: docker.io/library/alpine:3.19 and :3.20.

POL-547.
"""

from __future__ import annotations

import os

import pytest
import pytest_asyncio
from catalog_boxes import create_box, hold_through_report_window, until_reported
from e2e_auth import request_json

import boxlite

OLD_IMAGE = os.environ.get(
    "BOXLITE_E2E_ALIAS_IMAGE_OLD", "docker.io/library/alpine:3.19"
)
NEW_IMAGE = os.environ.get(
    "BOXLITE_E2E_ALIAS_IMAGE_NEW", "docker.io/library/alpine:3.20"
)

# Any reference naming the repository reaches its catalog entry. What a
# digest-pinned ref starts with is the entry's own name, which step 1 reads.
NAME, OLD_TAG = OLD_IMAGE.rsplit(":", 1)
NEW_NAME, NEW_TAG = NEW_IMAGE.rsplit(":", 1)

# No registry has this alias, so a box can only boot from it through the catalog.
ALIAS = "boxlite-e2e-rollout"
ALIAS_IMAGE = f"{NAME}:{ALIAS}"

# What the file builds up and later steps read: the catalog's name for the
# repository and the two versions step 1 pulled, and the box step 2 booted on
# the newer one.
state: dict = {}


@pytest_asyncio.fixture(scope="module", autouse=True)
async def fresh_image(rt):
    """
    Start with no entry for the repository, so each pull records its own
    version and every alias in it is one this case made; remove it afterwards.

    A box still holding an entry that was there already fails the case rather
    than being worked around: its versions and aliases would make every
    assertion below about someone else's catalog.
    """
    try:
        await rt.images.remove(NAME)
    except boxlite.NotFoundError:
        # An absent entry already satisfies the empty-catalog precondition.
        pass
    yield
    try:
        await rt.images.remove(NAME)
    except (boxlite.NotFoundError, boxlite.InvalidStateError):
        # Absent, or a removed box not yet destroyed: nothing to resolve here.
        pass


async def _detail(rt) -> boxlite.ImageDetail | None:
    try:
        return await rt.images.get(NAME)
    except boxlite.NotFoundError:
        return None


async def _version_tagged(rt, tag: str) -> boxlite.ImageVersion | None:
    detail = await _detail(rt)
    if detail is None:
        return None
    return next(
        (version for version in detail.versions if tag in version.aliases), None
    )


def _aliases_by_version(detail: boxlite.ImageDetail) -> dict[str, set[str]]:
    return {version.digest: set(version.aliases) for version in detail.versions}


async def _create_alias(rt, alias: str, digest: str) -> boxlite.ImageDetail:
    """The image after registering `alias` for the version with `digest`."""
    try:
        return await rt.images.create_alias(NAME, alias, digest)
    except boxlite.ConfigError as refused:
        pytest.fail(
            f"this key cannot create aliases; it needs the write:images scope: {refused}"
        )


def _booted(box) -> str:
    """The image a box was handed, as the server recorded it."""
    status, body = request_json("GET", f"/box/{box.id}")
    assert status == 200, f"reading box {box.id} back answered {status}: {body}"
    return body["image"]


def _pinned(version: boxlite.ImageVersion) -> str:
    """The ref a catalog hit on `version` hands the runner."""
    return f"{state['name']}@{version.digest}"


@pytest.mark.asyncio
async def test_each_tag_pulled_records_a_version(rt):
    """Step 1. Two tags of one repository, each pulled, are two versions of one image."""
    assert NEW_NAME == NAME, (
        f"{OLD_IMAGE} and {NEW_IMAGE} must be tags of one repository"
    )

    for image, tag in ((OLD_IMAGE, OLD_TAG), (NEW_IMAGE, NEW_TAG)):
        box = await create_box(rt, image)
        try:
            # Kept up until the report lands; removing it first would drop the report.
            recorded = await until_reported(lambda tag=tag: _version_tagged(rt, tag))
            assert recorded is not None, (
                f"{image} booted a box but never entered the catalog"
            )
        finally:
            await rt.remove(box.id, force=True)

    old, new = await _version_tagged(rt, OLD_TAG), await _version_tagged(rt, NEW_TAG)
    assert old.digest != new.digest, (
        f"{OLD_IMAGE} and {NEW_IMAGE} are one digest, so selecting either version with an alias "
        f"would show nothing; pick two that differ"
    )
    detail = await _detail(rt)
    for tag, version in ((OLD_TAG, old), (NEW_TAG, new)):
        recorded_by_pull = any(
            event.alias == tag
            and event.to_digest == version.digest
            and event.actor is None
            for event in detail.history
        )
        assert recorded_by_pull, (
            f"the pull that recorded {tag!r} left no history: {detail.history}"
        )
    state.update(name=detail.name, old=old, new=new)


@pytest.mark.asyncio
async def test_a_created_alias_is_what_the_next_box_boots(rt):
    """Step 2. An alias created on the newer version boots it."""
    new = state["new"]

    detail = await _create_alias(rt, ALIAS, new.digest)

    assert ALIAS in _aliases_by_version(detail)[new.digest]
    created = detail.history[0]
    assert (created.alias, created.from_digest, created.to_digest) == (
        ALIAS,
        None,
        new.digest,
    ), f"the newest history entry is not this creation: {created}"
    assert created.actor is not None, (
        "a creation through the SDK was recorded as a pull"
    )

    box = await create_box(rt, ALIAS_IMAGE)
    # Kept up through the next steps: step 3 needs its report to land, and
    # step 4 asks whether replacement reaches a box that already exists.
    state["box_on_new"] = box
    assert _booted(box) == _pinned(new)


@pytest.mark.asyncio
async def test_booting_the_alias_records_nothing_new(rt):
    """
    Step 3. The box above booted a version the catalog had, so its report
    adds no version and does not replace any catalog alias.
    """
    old, new = state["old"], state["new"]
    expected = {old.digest: {OLD_TAG}, new.digest: {NEW_TAG, ALIAS}}

    async def unchanged() -> None:
        assert _aliases_by_version(await _detail(rt)) == expected

    await hold_through_report_window(unchanged)


@pytest.mark.asyncio
async def test_replacement_requires_explicit_deletion(rt):
    """An alias cannot be overwritten, even by an identical binding."""
    old, new = state["old"], state["new"]
    box_on_new = state["box_on_new"]
    try:
        before = await _detail(rt)
        for digest in (new.digest, old.digest):
            with pytest.raises(boxlite.AlreadyExistsError):
                await rt.images.create_alias(NAME, ALIAS, digest)
        after = await _detail(rt)
        assert _aliases_by_version(after) == _aliases_by_version(before)
        assert len(after.history) == len(before.history)

        await rt.images.delete_alias(NAME, ALIAS)
        detail = await _create_alias(rt, ALIAS, old.digest)
        assert detail.history[0].alias == ALIAS
        assert detail.history[0].from_digest is None
        assert detail.history[0].to_digest == old.digest
        assert _booted(box_on_new) == _pinned(new)

        box = await create_box(rt, ALIAS_IMAGE)
        try:
            assert _booted(box) == _pinned(old)
        finally:
            await rt.remove(box.id, force=True)
    finally:
        await rt.remove(box_on_new.id, force=True)


@pytest.mark.asyncio
async def test_a_curated_image_refuses_alias_creation(rt):
    """
    Step 5. A curated image is the operator's, pinned by its reference, so
    creating an alias for it is refused.
    """
    status, rows = request_json("GET", "/images")
    assert status == 200, f"listing the catalog answered {status}: {rows}"
    curated = next((row for row in rows if row["curated"]), None)
    if curated is None:
        pytest.skip("this stack offers no curated image")

    # The digest is another image's, which is a refusal of its own; the reason
    # is what shows the refusal came from the image being curated.
    with pytest.raises(boxlite.InvalidArgumentError, match="provided by the operator"):
        await rt.images.create_alias(curated["name"], ALIAS, state["old"].digest)
