"""Secrets over REST — the proxy substitutes, the guest never holds the value.

E2E port of the secret coverage that stops at the wire:
`src/boxlite/tests/secret_substitution.rs` asserts the JSON shape gvproxy
expects and that Debug/Display redact the value, and
`sdks/python/tests/test_secret_substitution.py` asserts the PyO3 binding.
Neither reaches a running box. `secrets` crosses the wire
(src/boxlite/src/rest/types.rs:169-172,210) and the control plane maps it
(apps/api/src/boxlite-rest/mappers/box-to-box.mapper.ts:65-70), so the
property the feature exists for is checkable on a stage and was checked
nowhere: "the placeholder is visible to the guest; the real value never enters
the VM" (src/boxlite/src/runtime/options.rs:439-440).

Both halves have to be observed through the platform, not through the test's
own inputs. Asserting that a placeholder the test itself put in `env` comes
back from `env` would pass with `secrets` dropped entirely; the substitution
is what only the proxy can do, so the box sends the placeholder to the
matching host and the echo says which of the two arrived.

The value is fabricated per run, never a real credential, so naming it in an
assertion leaks nothing.
"""
from __future__ import annotations

import asyncio
import uuid

import boxlite
import pytest

from conftest import drain

SECRET_NAME = "e2e_probe"
PLACEHOLDER = f"<BOXLITE_SECRET:{SECRET_NAME}>"
HOST = "httpbingo.org"
# Echoes the request headers as JSON — the only way to see what left the box.
ECHO_URL = f"https://{HOST}/headers"
ECHO_FILE = "/tmp/e2e-secret-echo.json"
# Proves a dump arrived, so that "the value is absent" is not satisfied by an
# empty stream — see test_the_guest_never_holds_the_secret_value.
SENTINEL = "E2E-ENV-DUMP-COMPLETE"
# Outside `hosts=[HOST]`, so a request to it is not MITM-terminated: it answers
# "can this box reach the internet at all" without involving the secret path.
CONTROL_HOST = "example.com"
CONTROL_URL = f"https://{CONTROL_HOST}/"


async def _run(box, script: str) -> tuple[str, str, int]:
    ex = await box.exec("sh", ["-c", script], None)
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=90)
    return out, err, rc.exit_code


@pytest.fixture
def secret_value() -> str:
    """A fabricated token — never a real credential, unique per run."""
    return f"e2e-not-a-real-key-{uuid.uuid4().hex}"


@pytest.fixture
async def box_with_secret(rt, image, secret_value):
    box = await rt.create(
        boxlite.BoxOptions(
            image=image,
            secrets=[
                boxlite.Secret(name=SECRET_NAME, value=secret_value, hosts=[HOST]),
            ],
        ),
    )
    yield box
    await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_the_guest_never_holds_the_secret_value(box_with_secret, secret_value):
    """Nothing inside the box can read the value the caller configured.

    The sentinel is what makes the absence mean anything. This stage drops a
    short exec's stdout intermittently until #1569 lands, and an empty string
    satisfies "the value is not in the output" for the wrong reason — so the
    dump has to prove it arrived before its contents can be read as evidence.
    """
    out, err, code = await _run(
        box_with_secret,
        "env; cat /proc/1/environ | tr '\\0' '\\n'; ls -a /run /etc 2>/dev/null; "
        f"echo {SENTINEL}",
    )
    assert code == 0, f"reading the guest environment failed ({code}): {err!r}"
    assert SENTINEL in out, (
        f"the environment dump never arrived, so its contents prove nothing: {out!r}"
    )
    assert secret_value not in out, (
        "the real secret value is readable inside the guest — it is supposed "
        "to stay in the proxy and never enter the VM"
    )


@pytest.mark.asyncio
async def test_the_proxy_substitutes_the_placeholder_upstream(
    box_with_secret, secret_value
):
    """What leaves the box carries the value the box never had.

    The placeholder is sent from inside the guest; the echo shows what the host
    received. A stage that drops `secrets` echoes the placeholder back, which
    is the failure this case exists to catch.

    The answer comes back as an exit code rather than as stdout, and the echo
    is graded by a grep inside the guest. Short-exec stdout is dropped
    intermittently on a stage running without #1569 — this case read an empty
    string from a `curl` that had exited 0 — and a lost byte stream would
    otherwise read as "the substitution did not happen".
    """
    # The control has to sit outside the mechanism under test, so it goes to a
    # host the secret does not bind. Configuring any secret makes gvproxy mint
    # an ephemeral MITM CA (src/boxlite/src/net/gvproxy/services.rs:347-358)
    # and the guest is handed that CA to trust, so TLS to the secret's own host
    # is terminated by the substitution path whether or not a placeholder rides
    # along — a broken CA fails a "plain" request to it too, and skipping on
    # that would hide the very failure this case exists to catch.
    _, control_err, control = await _run(
        box_with_secret, f"curl -fsS --max-time 20 {CONTROL_URL} -o /dev/null"
    )
    if control != 0:
        pytest.skip(
            f"box has no egress at all ({CONTROL_HOST}): {control_err.strip()[:200]!r}"
        )

    _, err, code = await _run(
        box_with_secret,
        f"curl -fsS --max-time 20 -H 'X-E2E-Probe: {PLACEHOLDER}' "
        f"{ECHO_URL} -o {ECHO_FILE}",
    )
    assert code == 0, (
        f"the box reached {CONTROL_HOST} but not {HOST}, which is the host its "
        f"secret binds and therefore the one the MITM path terminates "
        f"({code}): {err.strip()[:200]!r}"
    )

    _, _, placeholder_present = await _run(
        box_with_secret, f"grep -qF -- '{PLACEHOLDER}' {ECHO_FILE}"
    )
    assert placeholder_present != 0, (
        f"the placeholder reached {HOST} unsubstituted — the proxy did not "
        f"replace it"
    )

    _, _, value_present = await _run(
        box_with_secret, f"grep -qF -- '{secret_value}' {ECHO_FILE}"
    )
    assert value_present == 0, (
        f"the substituted value never arrived at {HOST} (grep exit "
        f"{value_present})"
    )
