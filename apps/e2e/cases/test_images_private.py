"""
Private images, end to end.

The whole claim, against a real stack: with no login a private image does not
pull; with one registered through `POST /registries`, a box boots from the
image reference exactly as it is written, reads it back that way, and the
login cannot be removed while that box stands. The password goes up once and
is never seen again.

It needs a real private image, because the registry proxy pulls only from the
registries a login is accepted for, by default ghcr.io, docker.io, quay.io and
gcr.io, and refuses a private address: the local registry box cannot stand in.
Without the first three variables below the file skips. A stack that keeps no
registry credentials answers step 2 with a 501, which fails: setting them is
asking for a stack that does.

The logins are driven over their HTTP API, since the runtime gains them only
with the SDK change; the catalog and the boxes go through the runtime, as the
catalog's own case does.

The tests run in file order and share the login and the box they build up,
because a private pull is tens of seconds and is paid for once.

The case removes only what it made. It refuses to start while the organization
already has a login for its registry and prefix, since that login may be in
use; it records every box its own creates started, including one a failed
create left behind; and it removes the image's catalog entry only when there
was none before it ran. An entry that was there already pins the tag to its
digest, and the box then reads back pinned.

Nothing here lets pytest print the password. A check on it is reduced to a
bool first, since pytest prints an assertion's operands, and a register that
cannot be sent is raised again without the request helper's frames, since
pytest prints their arguments and the request body holds the password.

Environment:
  BOXLITE_E2E_PRIVATE_IMAGE     A private image on a registry the stack takes
                                logins for, written with its host and a tag
                                or digest, e.g. ghcr.io/acme/private-app:1.
  BOXLITE_E2E_PRIVATE_USERNAME  Its registry username.
  BOXLITE_E2E_PRIVATE_PASSWORD  Its token or password.
  BOXLITE_E2E_PRIVATE_PREFIX    The prefix to register, default the image's
                                namespace, e.g. acme/.

POL-546.

Not covered here: that public and curated images still boot with the registry
proxy stopped. Their refs never name the proxy — the resolver's unit tests hold
that — and stopping a component is not something a case should do to a shared
stack.
"""

from __future__ import annotations

import os
import re

import pytest
import pytest_asyncio

import boxlite
from e2e_auth import request_json

PRIVATE_IMAGE = os.environ.get("BOXLITE_E2E_PRIVATE_IMAGE", "")
USERNAME = os.environ.get("BOXLITE_E2E_PRIVATE_USERNAME", "")
PASSWORD = os.environ.get("BOXLITE_E2E_PRIVATE_PASSWORD", "")

pytestmark = pytest.mark.skipif(
    not (PRIVATE_IMAGE and USERNAME and PASSWORD),
    reason="set BOXLITE_E2E_PRIVATE_IMAGE, _USERNAME and _PASSWORD to run the private image "
    "suite",
)

_HOST, _, _PATH = PRIVATE_IMAGE.partition("/")
_NAMESPACE = _PATH.split("/", 1)[0] + "/" if "/" in _PATH else ""
PREFIX = os.environ.get("BOXLITE_E2E_PRIVATE_PREFIX") or _NAMESPACE
# The image without its tag or digest, which is what a pinned ref starts with.
_NAME = re.sub(r"(@sha256:[0-9a-f]{64}|:[^/:@]+)$", "", PRIVATE_IMAGE)

# What the file builds up and later steps read: the login, the box step 4
# booted, every box a create started, and whether the catalog had the image.
state: dict = {"boxes": []}


class Registries:
    """The registry logins' HTTP API, answering with what the server sent."""

    def list(self) -> list[dict]:
        status, rows = request_json("GET", "/registries")
        assert status == 200, f"listing the logins answered {status}: {rows}"
        return rows

    def create(self) -> tuple[int, dict | None]:
        """
        Register this case's login; a refusal comes back rather than raises.

        A request that cannot be sent is raised again from here: pytest prints
        the arguments of every frame in a traceback, and the request helper's
        hold the password.
        """
        try:
            return request_json(
                "POST",
                "/registries",
                {
                    "registryHost": _HOST,
                    "repositoryPrefix": PREFIX,
                    "username": USERNAME,
                    "password": PASSWORD,
                },
            )
        except Exception as failure:
            refusal = AssertionError(f"registering the login failed: {type(failure).__name__}")
        raise refusal from None

    def delete(self, login_id: str) -> tuple[int, dict | None]:
        return request_json("DELETE", f"/registries/{login_id}")


def _is_this_image(ref: str | None) -> bool:
    pinned = re.escape(_NAME) + r"@sha256:[0-9a-f]{64}"
    return ref == PRIVATE_IMAGE or bool(ref and re.fullmatch(pinned, ref))


def _box_ids_of_this_image() -> set[str]:
    status, rows = request_json("GET", "/box")
    assert status == 200, f"listing boxes answered {status}"
    return {row["id"] for row in rows if _is_this_image(row.get("image"))}


async def _create_recorded(rt, **options):
    """
    Create a box of the image, recording what the create started even if it
    fails. A box of the same image someone else creates in that moment would
    be counted too: the case assumes nobody else boots its image meanwhile.
    """
    before = _box_ids_of_this_image()
    try:
        return await rt.create(boxlite.BoxOptions(image=PRIVATE_IMAGE, **options))
    finally:
        state["boxes"].extend(sorted(_box_ids_of_this_image() - before))


@pytest.fixture(scope="module")
def registries() -> Registries:
    return Registries()


@pytest_asyncio.fixture(scope="module", autouse=True)
async def only_what_this_case_made(rt, registries: Registries):
    """Refuse to start over someone's login; afterwards remove what this case made."""
    for row in registries.list():
        if row["registryHost"] == _HOST and row["repositoryPrefix"] == PREFIX:
            pytest.fail(
                f"this organization already has a login for {_HOST}/{PREFIX}; this case adds "
                f"its own and will not remove one it did not add"
            )
    try:
        await rt.images.get(_NAME)
        state["catalog_existed"] = True
    except boxlite.NotFoundError:
        state["catalog_existed"] = False

    yield

    # Every step of the cleanup is tried: one that is left undone, a login
    # most of all, is what makes the next run refuse to start.
    leftovers = []
    for box_id in state["boxes"]:
        try:
            # One started with auto_remove may have gone by itself.
            if await rt.get_info(box_id) is not None:
                await rt.remove(box_id, force=True)
        except Exception as failure:
            leftovers.append(f"box {box_id}: {failure}")
    if "login" in state:
        status, body = registries.delete(state["login"]["id"])
        if status not in (204, 404):
            leftovers.append(f"login {state['login']['id']}: {status} {body}")
    if not state["catalog_existed"]:
        try:
            await rt.images.remove(_NAME)
        except boxlite.NotFoundError:
            pass
        except Exception as failure:
            leftovers.append(f"catalog entry for {_NAME}: {failure}")
    if leftovers:
        pytest.fail("left behind: " + "; ".join(leftovers))


@pytest.mark.asyncio
async def test_without_a_login_the_private_image_does_not_boot(rt):
    """
    Step 1. Refused at admission, or at the pull: either way, no box. Everything
    after this means something only if the image is private.
    """
    try:
        await _create_recorded(rt, auto_remove=True)
    except Exception as failure:
        message = str(failure)
        if "No available runners" in message:
            pytest.skip("no runner is attached to this stack, so no pull was attempted")
        # A stack that is down refuses too, and says nothing about a missing
        # login, so an unfamiliar message fails rather than passes.
        refused_for_the_login = (
            "not allowed" in message
            or "registered credential" in message
            or "failed to pull" in message.lower()
        )
        assert refused_for_the_login, (
            f"{PRIVATE_IMAGE} was refused for a reason that is not the missing login: {message}"
        )
        return
    pytest.fail(
        f"{PRIVATE_IMAGE} booted with no login registered, so it is not private "
        f"and this suite proves nothing"
    )


def test_a_login_is_stored_and_its_password_is_never_returned(registries):
    """Step 2. Neither the answer nor the list carries the password."""
    status, login = registries.create()
    if status == 201:
        # Kept before any check, so the cleanup removes it whatever they find.
        state["login"] = login
    shows_password = PASSWORD in repr(login)
    assert not shows_password, "the answer carries the password"
    assert status == 201, f"registering the login answered {status}: {login}"

    assert login["registryHost"] == _HOST
    assert login["repositoryPrefix"] == PREFIX
    listed = next(row for row in registries.list() if row["id"] == login["id"])
    for where, row in (("the created login", login), ("the list", listed)):
        has_password_field = "password" in row
        assert not has_password_field, f"{where} has a password field"
        shows_password = PASSWORD in repr(row)
        assert not shows_password, f"{where} carries the password"


def test_a_second_login_for_the_same_prefix_is_refused(registries):
    """Step 3. One login per registry and prefix, so the proxy never chooses between two."""
    status, body = registries.create()
    shows_password = PASSWORD in repr(body)
    assert not shows_password, "the refusal carries the password"
    assert status == 409, f"a second login for {_HOST}/{PREFIX} answered {status}: {body}"


@pytest.mark.asyncio
async def test_the_private_image_boots_by_the_reference_as_written(rt):
    """
    Step 4. The runtime sends the reference the user wrote; the server routes
    it, and reads it back the same way, or pinned when the catalog already had
    the image.
    """
    box = await _create_recorded(rt)
    state["box"] = box

    status, body = request_json("GET", f"/box/{box.id}")
    assert status == 200, f"reading the box back answered {status}"
    # The upstream ref, not the registry proxy's: a caller that creates
    # another box from what it read must be handed something admission takes.
    image = body["image"]
    assert image == PRIVATE_IMAGE or (state["catalog_existed"] and _is_this_image(image)), (
        f"read back {image!r} for {PRIVATE_IMAGE!r}"
    )


def test_a_login_in_use_cannot_be_removed(registries):
    """Step 5. The box standing on it is named."""
    status, body = registries.delete(state["login"]["id"])

    assert status == 409, f"removing a login in use answered {status}: {body}"
    assert state["box"].id in (body or {}).get("message", ""), body


@pytest.mark.asyncio
async def test_once_the_box_is_gone_the_login_can_be(rt, registries):
    """Step 6. And a second delete is a not-found, not a missing image."""
    box_id = state.pop("box").id
    await rt.remove(box_id, force=True)
    state["boxes"].remove(box_id)

    login_id = state.pop("login")["id"]
    status, body = registries.delete(login_id)
    assert status == 204, f"removing the login answered {status}: {body}"
    status, body = registries.delete(login_id)
    assert status == 404, f"removing it again answered {status}: {body}"
    assert "image" not in (body or {}).get("message", "").lower(), body
