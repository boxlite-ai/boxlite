"""
Moving a tag, end to end.

The claim, against a real runner: a catalog tag points where the organization
last moved it. The next box created with the tag boots that version, a box
that already exists keeps the one it booted, neither the move nor that box
records a new version, and the image's history records every move. A curated
image has no tags to move.

The moved tag is one no registry has, so only the catalog can resolve it. A
box booted from it booted what the catalog said.

What a box booted is read back from the box: a catalog hit hands the runner
the image pinned to its digest, and `GET /box/{id}` answers that ref. Reading
the digest, rather than anything inside the guest, keeps the case free of any
knowledge about the images it is given.

The catalog is read and moved over HTTP, `/api/images`: the SDK's image handle
does not carry version ids or move tags yet. Boxes are created and removed
with the SDK runtime, as in the catalog case.

The tests run in file order and share the two versions they pull, because a
cold pull is tens of seconds and is paid for once.

Moving a tag takes the `write:images` scope. An API key made before that scope
existed does not have it, and step 2 then fails saying so.

Environment:
  BOXLITE_E2E_TAG_IMAGE_OLD   Two tags of one repository with different
  BOXLITE_E2E_TAG_IMAGE_NEW   digests, the repository spelled the same in
                              both, on a host the API's allowlist admits.
                              Default docker.io/library/alpine:3.19 and :3.20.

POL-547.
"""

from __future__ import annotations

import os
from urllib.parse import quote

import pytest
import pytest_asyncio

import boxlite
from catalog_boxes import create_box, hold_through_report_window, until_reported
from e2e_auth import request_json

OLD_IMAGE = os.environ.get("BOXLITE_E2E_TAG_IMAGE_OLD", "docker.io/library/alpine:3.19")
NEW_IMAGE = os.environ.get("BOXLITE_E2E_TAG_IMAGE_NEW", "docker.io/library/alpine:3.20")

# Any reference naming the repository reaches its catalog entry. What a
# digest-pinned ref starts with is the entry's own name, which step 1 reads.
NAME, OLD_TAG = OLD_IMAGE.rsplit(":", 1)
NEW_NAME, NEW_TAG = NEW_IMAGE.rsplit(":", 1)

# No registry has this tag, so a box can only boot from it through the catalog.
MOVED_TAG = "boxlite-e2e-rollout"
MOVED_IMAGE = f"{NAME}:{MOVED_TAG}"

# What the file builds up and later steps read: the catalog's name for the
# repository and the two versions step 1 pulled, and the box step 2 booted on
# the newer one.
state: dict = {}


def _image_path(name: str) -> str:
    return f"/images/{quote(name, safe='')}"


@pytest_asyncio.fixture(scope="module", autouse=True)
async def fresh_image(rt):
    """
    Start with no entry for the repository, so each pull records its own
    version and every tag in it is one this case made; remove it afterwards.

    A box still holding an entry that was there already fails the case rather
    than being worked around: its versions and tags would make every
    assertion below about someone else's catalog.
    """
    try:
        await rt.images.remove(NAME)
    except boxlite.NotFoundError:
        pass
    yield
    try:
        await rt.images.remove(NAME)
    except (boxlite.NotFoundError, boxlite.InvalidStateError):
        # Absent, or a removed box not yet destroyed: nothing to resolve here.
        pass


async def _detail() -> dict | None:
    status, body = request_json("GET", _image_path(NAME))
    if status == 404:
        return None
    assert status == 200, f"reading {NAME} answered {status}: {body}"
    return body


async def _version_tagged(tag: str) -> dict | None:
    detail = await _detail()
    if detail is None:
        return None
    return next((version for version in detail["versions"] if tag in version["tags"]), None)


def _tags_by_version(detail: dict) -> dict[str, set[str]]:
    return {version["id"]: set(version["tags"]) for version in detail["versions"]}


def _move(name: str, tag: str, version_id: str) -> tuple[int, dict | None]:
    return request_json("PUT", f"{_image_path(name)}/tags/{quote(tag, safe='')}", {"versionId": version_id})


def _moved(tag: str, version_id: str) -> dict:
    """The image after moving `tag` to `version_id`, failing on any refusal."""
    status, body = _move(NAME, tag, version_id)
    if status == 403:
        pytest.fail(f"this key cannot move tags; it needs the write:images scope: {body}")
    assert status == 200, f"moving {tag} answered {status}: {body}"
    return body


def _booted(box) -> str:
    """The image a box was handed, as the server recorded it."""
    status, body = request_json("GET", f"/box/{box.id}")
    assert status == 200, f"reading box {box.id} back answered {status}: {body}"
    return body["image"]


def _pinned(version: dict) -> str:
    """The ref a catalog hit on `version` hands the runner."""
    return f"{state['name']}@{version['digest']}"


@pytest.mark.asyncio
async def test_each_tag_pulled_records_a_version(rt):
    """Step 1. Two tags of one repository, each pulled, are two versions of one image."""
    assert NEW_NAME == NAME, f"{OLD_IMAGE} and {NEW_IMAGE} must be tags of one repository"

    for image, tag in ((OLD_IMAGE, OLD_TAG), (NEW_IMAGE, NEW_TAG)):
        box = await create_box(rt, image)
        try:
            # Kept up until the report lands; removing it first would drop the report.
            recorded = await until_reported(lambda tag=tag: _version_tagged(tag))
            assert recorded is not None, f"{image} booted a box but never entered the catalog"
        finally:
            await rt.remove(box.id, force=True)

    old, new = await _version_tagged(OLD_TAG), await _version_tagged(NEW_TAG)
    assert old["id"] != new["id"], (
        f"{OLD_IMAGE} and {NEW_IMAGE} are one digest, so moving a tag between them "
        f"would show nothing; pick two that differ"
    )
    detail = await _detail()
    history = detail["history"]
    for tag, version in ((OLD_TAG, old), (NEW_TAG, new)):
        recorded_by_pull = any(
            event["tagName"] == tag
            and event["toVersionId"] == version["id"]
            and event["actorId"] is None
            for event in history
        )
        assert recorded_by_pull, f"the pull that recorded {tag!r} left no history: {history}"
    state.update(name=detail["name"], old=old, new=new)


@pytest.mark.asyncio
async def test_a_moved_tag_is_what_the_next_box_boots(rt):
    """Step 2. The tag, created on the newer version, boots it."""
    new = state["new"]

    detail = _moved(MOVED_TAG, new["id"])

    assert MOVED_TAG in _tags_by_version(detail)[new["id"]]
    moved = detail["history"][0]
    assert (moved["tagName"], moved["fromVersionId"], moved["toVersionId"]) == (
        MOVED_TAG,
        None,
        new["id"],
    ), f"the newest history entry is not this move: {moved}"
    assert moved["actorId"] is not None, "a move through the API was recorded as a pull"

    box = await create_box(rt, MOVED_IMAGE)
    # Kept up through the next steps: step 3 needs its report to land, and
    # step 4 asks whether a move reaches a box that already exists.
    state["box_on_new"] = box
    assert _booted(box) == _pinned(new)


@pytest.mark.asyncio
async def test_booting_the_moved_tag_records_nothing_new():
    """
    Step 3. The box above booted a version the catalog had, so its report
    adds no version and moves no tag: pulling is not how a tag changes.
    """
    old, new = state["old"], state["new"]
    expected = {old["id"]: {OLD_TAG}, new["id"]: {NEW_TAG, MOVED_TAG}}

    async def unchanged() -> None:
        assert _tags_by_version(await _detail()) == expected

    await hold_through_report_window(unchanged)


@pytest.mark.asyncio
async def test_moving_it_back_changes_only_the_next_box(rt):
    """
    Step 4. A roll-back points the next box at the older version, and the box
    already on the newer one keeps it.
    """
    old, new = state["old"], state["new"]
    box_on_new = state["box_on_new"]
    try:
        detail = _moved(MOVED_TAG, old["id"])

        back = detail["history"][0]
        assert (back["tagName"], back["fromVersionId"], back["toVersionId"]) == (
            MOVED_TAG,
            new["id"],
            old["id"],
        ), f"the newest history entry is not the roll-back: {back}"
        assert _booted(box_on_new) == _pinned(new), (
            "moving the tag rewrote a box that already existed"
        )

        box = await create_box(rt, MOVED_IMAGE)
        try:
            assert _booted(box) == _pinned(old)
        finally:
            await rt.remove(box.id, force=True)
    finally:
        await rt.remove(box_on_new.id, force=True)


def test_a_curated_image_has_no_tags_to_move():
    """
    Step 5. A curated image is the operator's, pinned by its reference, so
    moving a tag of it is refused.
    """
    status, rows = request_json("GET", "/images")
    assert status == 200, f"listing the catalog answered {status}: {rows}"
    curated = next((row for row in rows if row["curated"]), None)
    if curated is None:
        pytest.skip("this stack offers no curated image")

    status, body = _move(curated["name"], MOVED_TAG, state["old"]["id"])
    # The version is another image's, which is a 400 of its own; the reason
    # is what shows the refusal came from the image being curated.
    assert status == 400, f"moving a curated image's tag answered {status}: {body}"
    assert "no tags to move" in body["message"], body
